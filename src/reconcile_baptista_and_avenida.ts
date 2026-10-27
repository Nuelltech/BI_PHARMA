import path from 'path';
import net from 'net';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { ensureNonDestructiveSchema } from './db';
import { ingestVendasCsv } from './services/ingestion';
import {
  transformStagingVendas,
  parsePortugueseDecimal,
  normalizeCnpCodigo,
} from './services/transformation';
import { classifyAllExistingProducts } from './services/classifier';

dotenv.config();

const LOCAL_URL = 'postgresql://postgres:password@localhost:5433/bi_pharma?schema=public';
const SUPABASE_URL = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || '';

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(1000);
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('timeout', () => (s.destroy(), resolve(false)));
    s.on('error', () => (s.destroy(), resolve(false)));
    s.connect(port, '127.0.0.1');
  });
}

async function batchInsert<T>(items: T[], batchSize: number, fn: (chunk: T[]) => Promise<any>, label: string) {
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    await fn(chunk);
    console.log(`   📦 [${label}] ${Math.min(i + batchSize, items.length)} / ${items.length}...`);
  }
}

async function reconcile() {
  let embedded: any = null;
  if (!(await isPortOpen(5433))) {
    console.log('💻 A iniciar PostgreSQL local embebido (localhost:5433)...');
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    embedded = new EmbeddedPostgres({
      databaseDir: path.resolve(process.cwd(), '.pgdata_utf8'),
      user: 'postgres',
      password: 'password',
      port: 5433,
      persistent: true,
    });
    await embedded.start();
  }

  const localPrisma = new PrismaClient({ datasources: { db: { url: LOCAL_URL } } });
  const supaPrisma = new PrismaClient({ datasources: { db: { url: SUPABASE_URL } } });

  try {
    await ensureNonDestructiveSchema(localPrisma);
    await ensureNonDestructiveSchema(supaPrisma);

    const farmA = await localPrisma.farmacia.findFirst({ where: { nif: '505016419' } });
    const farmB = await localPrisma.farmacia.findFirst({ where: { NOT: { nif: '505016419' } } });

    if (!farmA) throw new Error('Farmácia A (NIF 505016419) não encontrada na BD local.');

    // 1. Preservar os preços de Farmácia B (Avenida) na tabela PrecoFarmacia a partir do seu StagingVendas
    if (farmB) {
      console.log(`🏥 1. A extrair e isolar preços da ${farmB.nome} em PrecoFarmacia...`);
      const stgB = await localPrisma.stagingVendas.findMany({
        where: { farmaciaId: farmB.id },
      });
      const mapB = new Map<string, { pvp: Prisma.Decimal | null; margem: Prisma.Decimal | null; custo_ref: Prisma.Decimal | null }>();
      for (const r of stgB) {
        try {
          const cnp = normalizeCnpCodigo(r.codigo_produto);
          const pvp = r.pvp ? parsePortugueseDecimal(r.pvp, 'PVP') : null;
          const margem = r.margem ? parsePortugueseDecimal(r.margem, 'MG') : null;
          const custo_ref = r.custo_unitario ? parsePortugueseDecimal(r.custo_unitario, 'CUSTO') : null;
          if (pvp || margem || custo_ref) {
            mapB.set(cnp, { pvp, margem, custo_ref });
          }
        } catch {}
      }
      await localPrisma.precoFarmacia.deleteMany({ where: { farmaciaId: farmB.id } });
      const rowsB = Array.from(mapB.entries()).map(([cnp_codigo, v]) => ({
        farmaciaId: farmB.id,
        cnp_codigo,
        pvp: v.pvp,
        margem: v.margem,
        custo_ref: v.custo_ref,
      }));
      await batchInsert(
        rowsB,
        1000,
        (chunk) => localPrisma.precoFarmacia.createMany({ data: chunk, skipDuplicates: true }),
        'PrecoFarmacia (Farmácia B)'
      );
    }

    // 2. Re-ingerir vendas baptista25-26.csv para Farmácia A (com devoluções negativas + artigos s/ venda c/ PVP)
    console.log(`🏥 2. A re-ingerir "baptista/vendas baptista25-26.csv" para ${farmA.nome} (10.731 artigos)...`);
    await localPrisma.venda.deleteMany({ where: { farmaciaId: farmA.id } });
    await localPrisma.stagingVendas.deleteMany({ where: { farmaciaId: farmA.id } });
    await localPrisma.precoFarmacia.deleteMany({ where: { farmaciaId: farmA.id } });

    const csvPath = path.resolve(process.cwd(), 'baptista', 'vendas baptista25-26.csv');
    const venIngest = await ingestVendasCsv(localPrisma, farmA.id, csvPath);
    console.log(
      `   ✔ CSV lido: ${venIngest.totalArtigosCatalogo} artigos no catálogo -> ${venIngest.totalRegistosMensais} linhas em StagingVendas`
    );

    const venTrans = await transformStagingVendas(localPrisma, farmA.id, venIngest.batchId);
    console.log(`   ✔ StagingVendas transformado: ${venTrans.processadosComSucesso}/${venTrans.totalLidos} sucesso`);

    // 3. Alinhar ProdutoMestre (pvp e margem_padrao) com os valores oficiais de Farmácia A (Baptista)
    console.log('💎 3. A alinhar PVP e Margem em ProdutoMestre com os valores exatos do CSV da Farmácia A...');
    const precosA = await localPrisma.precoFarmacia.findMany({ where: { farmaciaId: farmA.id } });
    const prodsAtuais = new Map(
      (await localPrisma.produtoMestre.findMany({ select: { cnp_codigo: true, pvp: true, margem_padrao: true } })).map(
        (p) => [p.cnp_codigo, p]
      )
    );

    const toUpdateMaster = precosA.filter((pa) => {
      const cur = prodsAtuais.get(pa.cnp_codigo);
      if (!cur) return false;
      const curPvp = cur.pvp !== null ? Number(cur.pvp) : null;
      const newPvp = pa.pvp !== null ? Number(pa.pvp) : null;
      const curMg = cur.margem_padrao !== null ? Number(cur.margem_padrao) : null;
      const newMg = pa.margem !== null ? Number(pa.margem) : null;
      return curPvp !== newPvp || curMg !== newMg;
    });

    console.log(`   ⚙️ A atualizar ${toUpdateMaster.length} registos em ProdutoMestre que tinham PVP/Margem diferente ou vazio...`);
    for (let i = 0; i < toUpdateMaster.length; i += 300) {
      const chunk = toUpdateMaster.slice(i, i + 300);
      await localPrisma.$transaction(
        chunk.map((pa) =>
          localPrisma.produtoMestre.update({
            where: { cnp_codigo: pa.cnp_codigo },
            data: {
              pvp: pa.pvp,
              margem_padrao: pa.margem,
            },
          })
        )
      );
    }

    console.log('🧬 4. A classificar todos os produtos no catálogo...');
    const stats = await classifyAllExistingProducts(localPrisma);
    console.log(`   ✔ Total produtos classificados: ${stats.total}`);

    // 5. Sincronizar a Base de Dados Reconciliada com o Supabase
    console.log('\n🌐 5. A sincronizar todos os dados corrigidos para o Supabase...');
    const allProds = await localPrisma.produtoMestre.findMany();
    const allPrecos = await localPrisma.precoFarmacia.findMany();
    const allVendasA = await localPrisma.venda.findMany({ where: { farmaciaId: farmA.id } });
    const allStgVendasA = await localPrisma.stagingVendas.findMany({ where: { farmaciaId: farmA.id } });

    // Inserir novos ProdutoMestre no Supabase e atualizar PVP/Margem
    await batchInsert(
      allProds,
      1000,
      (chunk) =>
        supaPrisma.produtoMestre.createMany({
          data: chunk,
          skipDuplicates: true,
        }),
      'Supabase ProdutoMestre (Novos)'
    );

    console.log('   ⚙️ A atualizar PVP e Margem de TODOS os 10.731 artigos da Farmácia A em ProdutoMestre no Supabase...');
    for (let i = 0; i < precosA.length; i += 500) {
      const chunk = precosA.slice(i, i + 500);
      const valuesSql = chunk
        .map((pa) => {
          const pvpVal = pa.pvp !== null ? Number(pa.pvp).toFixed(2) : 'NULL';
          const mgVal = pa.margem !== null ? Number(pa.margem).toFixed(2) : 'NULL';
          return `('${pa.cnp_codigo}', ${pvpVal}::numeric, ${mgVal}::numeric)`;
        })
        .join(', ');
      await supaPrisma.$executeRawUnsafe(`
        UPDATE public."ProdutoMestre" AS pm
        SET "pvp" = v.pvp, "margem_padrao" = v.margem
        FROM (VALUES ${valuesSql}) AS v(cnp_codigo, pvp, margem)
        WHERE pm."cnp_codigo" = v.cnp_codigo
      `);
    }

    // Atualizar PrecoFarmacia no Supabase
    await supaPrisma.precoFarmacia.deleteMany({});
    await batchInsert(
      allPrecos,
      1500,
      (chunk) => supaPrisma.precoFarmacia.createMany({ data: chunk, skipDuplicates: true }),
      'Supabase PrecoFarmacia'
    );

    // Atualizar Venda de Farmácia A no Supabase
    await supaPrisma.venda.deleteMany({ where: { farmaciaId: farmA.id } });
    await batchInsert(
      allVendasA,
      2000,
      (chunk) => supaPrisma.venda.createMany({ data: chunk, skipDuplicates: true }),
      'Supabase Venda (Farmácia A)'
    );

    // Atualizar StagingVendas de Farmácia A no Supabase
    await supaPrisma.stagingVendas.deleteMany({ where: { farmaciaId: farmA.id } });
    await batchInsert(
      allStgVendasA,
      2000,
      (chunk) => supaPrisma.stagingVendas.createMany({ data: chunk, skipDuplicates: true }),
      'Supabase StagingVendas (Farmácia A)'
    );

    console.log('\n🎉 Reconciliação concluída com sucesso em Localhost e no Supabase!');
  } finally {
    await localPrisma.$disconnect();
    await supaPrisma.$disconnect();
    if (embedded) await embedded.stop().catch(() => {});
  }
}

reconcile().catch((e) => {
  console.error('❌ Erro na reconciliação:', e);
  process.exit(1);
});
