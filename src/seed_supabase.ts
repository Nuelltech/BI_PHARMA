import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { ensureDatabaseReady, ensureNonDestructiveSchema } from './db';

dotenv.config();

async function resolveWorkingSupabaseUrl(rawUrl: string): Promise<string> {
  const matchDirect = rawUrl.match(/^postgresql:\/\/postgres:(.+)@db\.([a-z0-9]+)\.supabase\.co:5432\/postgres/i);
  const candidates: string[] = [];

  if (matchDirect) {
    const rawPass = matchDirect[1];
    const ref = matchDirect[2];
    const encodedPass = encodeURIComponent(decodeURIComponent(rawPass));
    candidates.push(
      `postgresql://postgres.${ref}:${encodedPass}@aws-1-eu-west-1.pooler.supabase.com:5432/postgres`,
      `postgresql://postgres.${ref}:${encodedPass}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`
    );
  }
  candidates.push(rawUrl);

  for (const url of candidates) {
    const masked = url.replace(/:([^:@]+)@/, ':***@');
    console.log(`🔌 A testar ligação: ${masked}`);
    const testPrisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await testPrisma.$queryRawUnsafe('SELECT 1');
      await testPrisma.$disconnect();
      console.log(`✅ Ligação estabelecida com sucesso via: ${masked}`);
      return url;
    } catch (err: any) {
      console.log(`   ⚠️ Falhou (${(err.message || '').split('\n').pop()})`);
      await testPrisma.$disconnect().catch(() => {});
    }
  }

  throw new Error('Não foi possível autenticar no Supabase.');
}

async function batchInsert<T>(items: T[], batchSize: number, fn: (chunk: T[]) => Promise<any>, label: string) {
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    await fn(chunk);
    console.log(`   📦 [${label}] ${Math.min(i + batchSize, items.length)} / ${items.length} sincronizados...`);
  }
}

async function seedSupabase() {
  const rawTargetUrl = process.env.SUPABASE_DATABASE_URL;
  if (!rawTargetUrl) {
    console.error('❌ Defina SUPABASE_DATABASE_URL no ficheiro .env.');
    process.exit(1);
  }

  console.log('🌐 1. A ligar ao projeto Supabase (Modo Seguro / Non-Destructive)...');
  const targetUrl = await resolveWorkingSupabaseUrl(rawTargetUrl);
  const supaPrisma = new PrismaClient({
    datasources: {
      db: { url: targetUrl },
    },
  });

  console.log('💻 2. A abrir base de dados local para clonar os dados anonimizados...');
  const { prisma: localPrisma, cleanup: localCleanup } = await ensureDatabaseReady();

  try {
    // 1. Garantir as 7 tabelas no Supabase sem tocar nas tabelas de faturas
    await ensureNonDestructiveSchema(supaPrisma);
    console.log('✅ Tabelas BI Pharma criadas/verificadas no Supabase (tabelas de faturas 100% intactas).');

    // 2. Ler dados locais
    const localFarms = await localPrisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
    const localProds = await localPrisma.produtoMestre.findMany();
    const localInvs = await localPrisma.inventario.findMany();
    const localVendas = await localPrisma.venda.findMany();

    console.log(
      `📊 Dados locais prontos a enviar: ${localFarms.length} Farmácias | ${localProds.length} Produtos Mestre | ${localInvs.length} Lotes Inventário | ${localVendas.length} Registos Vendas Mensais.`
    );

    // 3. Sincronizar Farmácias (Anonimizadas: Farmácia A, Farmácia B)
    await supaPrisma.venda.deleteMany({});
    await supaPrisma.inventario.deleteMany({});
    await supaPrisma.farmacia.deleteMany({});

    for (let idx = 0; idx < localFarms.length; idx++) {
      const f = localFarms[idx];
      const letter = String.fromCharCode(65 + idx);
      const nomeAnonimo =
        f.nome.toLowerCase().includes('baptista') || f.nome.toLowerCase().includes('avenida')
          ? `Farmácia ${letter}`
          : f.nome;
      const codigoAcesso = f.codigo_acesso || `FARMACIA-${letter}`;

      await supaPrisma.farmacia.upsert({
        where: { id: f.id },
        update: { nome: nomeAnonimo, nif: f.nif, codigo_acesso: codigoAcesso },
        create: {
          id: f.id,
          nome: nomeAnonimo,
          nif: f.nif,
          codigo_acesso: codigoAcesso,
          criadoEm: f.criadoEm,
        },
      });
      console.log(`   🏥 Farmácia sincronizada: ${nomeAnonimo} (Código: ${codigoAcesso})`);
    }

    // 4. Sincronizar Catálogo ProdutoMestre em lotes
    console.log('🧬 A enviar Catálogo Mestre (6.997 produtos classificados)...');
    await batchInsert(
      localProds,
      1000,
      (chunk) =>
        supaPrisma.produtoMestre.createMany({
          data: chunk.map((p) => ({
            cnp_codigo: p.cnp_codigo,
            aim: p.aim,
            designacao: p.designacao,
            categoria: p.categoria,
            tipo_venda: p.tipo_venda,
            taxa_iva: p.taxa_iva,
            pvp: p.pvp,
            margem_padrao: p.margem_padrao,
            criadoEm: p.criadoEm,
            atualizadoEm: p.atualizadoEm,
          })),
          skipDuplicates: true,
        }),
      'ProdutoMestre'
    );

    // 5. Sincronizar Inventário (limpa e recria por farmácia para garantir fidelidade 100%)
    console.log('📦 A enviar Inventário e Validades das Farmácias...');
    await supaPrisma.inventario.deleteMany({});
    await batchInsert(
      localInvs,
      1000,
      (chunk) =>
        supaPrisma.inventario.createMany({
          data: chunk.map((inv) => ({
            id: inv.id,
            farmaciaId: inv.farmaciaId,
            cnp_codigo: inv.cnp_codigo,
            lote: inv.lote,
            prateleira: inv.prateleira,
            quantidade: inv.quantidade,
            custo_unitario: inv.custo_unitario,
            data_validade: inv.data_validade,
            data_extracao: inv.data_extracao,
            atualizadoEm: inv.atualizadoEm,
          })),
          skipDuplicates: true,
        }),
      'Inventario'
    );

    // 6. Sincronizar Histórico de Vendas Mensais
    console.log('📈 A enviar Histórico de Vendas Mensais...');
    await supaPrisma.venda.deleteMany({});
    await batchInsert(
      localVendas,
      2000,
      (chunk) =>
        supaPrisma.venda.createMany({
          data: chunk.map((v) => ({
            id: v.id,
            farmaciaId: v.farmaciaId,
            cnp_codigo: v.cnp_codigo,
            quantidade: v.quantidade,
            valor_total: v.valor_total,
            data_venda: v.data_venda,
          })),
          skipDuplicates: true,
        }),
      'Venda'
    );

    console.log('\n🎉 Sincronização completa com o seu projeto Supabase (faturas_piloto) concluída!');
    console.log('   👑 Código Master (Admin): MASTER-BI');
    console.log('   🏥 Farmácia A (Isolada):  FARMACIA-A  -> /?acesso=FARMACIA-A');
    console.log('   🏥 Farmácia B (Isolada):  FARMACIA-B  -> /?acesso=FARMACIA-B');
  } finally {
    await supaPrisma.$disconnect();
    await localCleanup();
  }
}

seedSupabase().catch((err) => {
  console.error('❌ Erro ao sincronizar com Supabase:', err);
  process.exit(1);
});
