import path from 'path';
import { ensureDatabaseReady } from './db';
import { ingestWinpharData } from './services/ingestion';
import {
  transformStagingInventario,
  transformStagingVendas,
  transformStagingValidades,
} from './services/transformation';
import { classifyAllExistingProducts } from './services/classifier';

async function runPipelineAvenida() {
  console.log('=====================================================');
  console.log('   PIPELINE MULTI-TENANT: FARMÁCIA AVENIDA (WINPHAR)');
  console.log('=====================================================\n');

  const { prisma, cleanup } = await ensureDatabaseReady();

  try {
    const vendasPdf = path.resolve(__dirname, '../Avenida/venda 10_25-10_26.pdf');
    const validadesPdf = path.resolve(__dirname, '../Avenida/Listagem validades 2027-compressed (1).pdf');

    console.log('[1/4] A registar Tenant: Farmácia Avenida (NIF: 518149412)...');
    const farmacia = await prisma.farmacia.upsert({
      where: { nif: '518149412' },
      update: { nome: 'Farmácia Avenida' },
      create: { nome: 'Farmácia Avenida', nif: '518149412' },
    });
    console.log(` -> Farmácia ID: ${farmacia.id} | Nome: ${farmacia.nome} | NIF: ${farmacia.nif}\n`);

    // Limpa dados anteriores da Farmácia Avenida para re-carga limpa
    await prisma.stagingInventario.deleteMany({ where: { farmaciaId: farmacia.id } });
    await prisma.stagingVendas.deleteMany({ where: { farmaciaId: farmacia.id } });
    await prisma.stagingValidades.deleteMany({ where: { farmaciaId: farmacia.id } });
    await prisma.inventario.deleteMany({ where: { farmaciaId: farmacia.id } });
    await prisma.venda.deleteMany({ where: { farmaciaId: farmacia.id } });

    // Remove referências de produtos órfãos que possam ter sido criados indevidamente
    await prisma.$executeRawUnsafe(`
      DELETE FROM "ProdutoMestre" 
      WHERE cnp_codigo NOT IN (
        SELECT DISTINCT cnp_codigo FROM "Inventario" 
        UNION 
        SELECT DISTINCT cnp_codigo FROM "Venda"
      )
    `);

    console.log('[2/4] A executar Ingestão Simphar / Winphar para Staging...');
    const ingestStats = await ingestWinpharData(prisma, farmacia.id, vendasPdf, validadesPdf);
    console.log(` -> Produtos extraídos de Vendas: ${ingestStats.totalVendasPdf}`);
    console.log(` -> Artigos extraídos de Validades: ${ingestStats.totalValidadesPdf}`);
    console.log(` -> Registos StagingInventario criados: ${ingestStats.stagingInventarioCount}`);
    console.log(` -> Registos StagingVendas criados: ${ingestStats.stagingVendasCount}`);
    console.log(` -> Registos StagingValidades criados: ${ingestStats.stagingValidadesCount}\n`);

    console.log('[3/4] A executar Transformação e Carga Final (Multi-Tenant)...');
    console.log('  -> A transformar Inventário...');
    const resInv = await transformStagingInventario(prisma, farmacia.id);
    console.log(`     Sucesso: ${resInv.processadosComSucesso} | Erros: ${resInv.errosValidacao}`);

    console.log('  -> A transformar Vendas 2025...');
    const resVendas = await transformStagingVendas(prisma, farmacia.id);
    console.log(`     Sucesso: ${resVendas.processadosComSucesso} | Erros: ${resVendas.errosValidacao}`);

    console.log('  -> A associar Prazos de Validade aos lotes...');
    const resVal = await transformStagingValidades(prisma, farmacia.id);
    console.log(
      `     Sucesso: ${resVal.processadosComSucesso} | Inventários com Validade Atualizada: ${resVal.inventariosAtualizados}`
    );

    console.log('\n[4/4] A atualizar Classificação Científica e Estatuto dos Produtos...');
    const statsClass = await classifyAllExistingProducts(prisma);
    console.log(
      ` -> Total Catálogo: ${statsClass.total} | Venda Livre: ${statsClass.vendaLivre} | Genéricos MG: ${statsClass.genericosMg} | Marca: ${statsClass.marca}\n`
    );

    // Totais reais no inventário da Farmácia Avenida
    const invAvenida = await prisma.inventario.findMany({
      where: { farmaciaId: farmacia.id },
    });
    const totalSkus = invAvenida.length;
    const totalUnidades = invAvenida.reduce((s, i) => s + i.quantidade, 0);
    const totalValorCusto = invAvenida.reduce((s, i) => s + i.quantidade * Number(i.custo_unitario), 0);
    const totalValidadesRegistadas = invAvenida.filter((i) => i.data_validade !== null).length;

    console.log('=====================================================');
    console.log('      FARMÁCIA AVENIDA CARREGADA COM SUCESSO!        ');
    console.log('=====================================================');
    console.log(`  SKUs em Inventário:       ${totalSkus}`);
    console.log(`  Total Unidades em Stock:  ${totalUnidades}`);
    console.log(`  Capital em Stock (Custo): ${totalValorCusto.toFixed(2)} €`);
    console.log(`  Artigos com Validade:     ${totalValidadesRegistadas}`);
    console.log('=====================================================\n');
  } catch (err) {
    console.error('❌ Erro durante o pipeline da Farmácia Avenida:', err);
    throw err;
  } finally {
    await cleanup();
  }
}

runPipelineAvenida().catch(() => process.exit(1));
