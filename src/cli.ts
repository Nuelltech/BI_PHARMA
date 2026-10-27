import fs from 'fs';
import path from 'path';
import { ensureDatabaseReady } from './db';
import {
  ingestInventarioPdf,
  ingestValidadesPdf,
  ingestVendasCsv,
  parseInventarioPdfFile,
} from './services/ingestion';
import {
  transformStagingInventario,
  transformStagingValidades,
  transformStagingVendas,
} from './services/transformation';
import { analyzePharmacyInventory } from './services/analysis';

function getArgValue(flag: string, defaultVal?: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (arg) return arg.split('=')[1];
  return defaultVal;
}

async function main() {
  const command = process.argv[2] || 'pipeline';
  const pdfInventarioPath = path.resolve(
    process.cwd(),
    getArgValue('--pdf-inv', '21000lista_20261019104350.pdf')!
  );
  const pdfValidadesPath = path.resolve(
    process.cwd(),
    getArgValue('--pdf-val', '21001lista_20261019190456_Validades.pdf')!
  );
  const csvVendasPath = path.resolve(
    process.cwd(),
    getArgValue('--csv-vendas', 'vendas baptista25-26.csv')!
  );

  const diasMonos = parseInt(getArgValue('--dias-monos', '90')!, 10);
  const limiteCobertura = parseFloat(getArgValue('--cobertura', '4')!);
  const mesesVmmArg = getArgValue('--meses-vmm');
  const mesesHistoricoVMM = mesesVmmArg ? parseInt(mesesVmmArg, 10) : undefined;

  const { prisma, cleanup } = await ensureDatabaseReady();

  try {
    // 1. Garantir o Tenant (Farmácia) a partir dos metadados do PDF ou argumentos
    const headerMeta = await parseInventarioPdfFile(pdfInventarioPath);
    const nif = getArgValue('--nif', headerMeta.farmaciaNif || '505016419')!;
    const nome = getArgValue('--nome', headerMeta.farmaciaNome || 'FARMACIA BAPTISTA')!;

    const farmacia = await prisma.farmacia.upsert({
      where: { nif },
      update: { nome },
      create: { nome, nif },
    });

    console.log(`\n=============================================================`);
    console.log(`🏥 TENANT ATIVO: ${farmacia.nome} | NIF: ${farmacia.nif}`);
    console.log(`   ID: ${farmacia.id}`);
    console.log(`=============================================================\n`);

    if (command === 'etl' || command === 'pipeline') {
      console.log('📥 [FASE 1: INGESTÃO - RAW TO STAGING]');

      const invIngest = await ingestInventarioPdf(prisma, farmacia.id, pdfInventarioPath);
      console.log(
        `  ✔ PDF Inventário ingerido: ${invIngest.totalExtraidos} linhas (Batch: ${invIngest.batchId.slice(0, 8)})`
      );

      const valIngest = await ingestValidadesPdf(prisma, farmacia.id, pdfValidadesPath);
      console.log(
        `  ✔ PDF Validades ingerido:  ${valIngest.totalExtraidos} linhas (Batch: ${valIngest.batchId.slice(0, 8)})`
      );

      const venIngest = await ingestVendasCsv(prisma, farmacia.id, csvVendasPath);
      console.log(
        `  ✔ CSV Vendas ingerido:     ${venIngest.totalArtigosCatalogo} artigos no catálogo -> ${venIngest.totalRegistosMensais} movimentos mensais com vendas > 0 (Batch: ${venIngest.batchId.slice(0, 8)})`
      );

      console.log('\n⚙️  [FASE 2: TRANSFORMAÇÃO E LIMPEZA - STAGING TO FINAL]');

      const invTrans = await transformStagingInventario(prisma, farmacia.id, invIngest.batchId);
      console.log(
        `  ✔ Inventário transformado: ${invTrans.processadosComSucesso}/${invTrans.totalLidos} sucesso | ${invTrans.errosValidacao} erros`
      );

      const valTrans = await transformStagingValidades(prisma, farmacia.id, valIngest.batchId);
      console.log(
        `  ✔ Validades transformadas: ${valTrans.processadosComSucesso}/${valTrans.totalLidos} validadas | ${valTrans.inventariosAtualizados} produtos em stock atualizados com data_validade | ${valTrans.errosValidacao} erros`
      );

      const venTrans = await transformStagingVendas(prisma, farmacia.id, venIngest.batchId);
      console.log(
        `  ✔ Vendas transformadas:    ${venTrans.processadosComSucesso}/${venTrans.totalLidos} sucesso | ${venTrans.errosValidacao} erros`
      );
    }

    if (command === 'analyze' || command === 'pipeline') {
      console.log('\n🧠 [FASE 3: MOTOR DE INTELIGÊNCIA - ANALYSIS ENGINE]');
      const report = await analyzePharmacyInventory(prisma, farmacia.id, {
        periodoMonosDias: diasMonos,
        limiteCoberturaMeses: limiteCobertura,
        mesesHistoricoVMM,
      });

      const outDir = path.resolve(process.cwd(), 'output');
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      const outPath = path.join(outDir, 'analise_farmacia_baptista.json');
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

      const r = report.resumo_executivo;
      console.log(`\n📊 RESUMO EXECUTIVO (${report.farmacia.nome}):`);
      console.log(`  • Data de Referência:                  ${report.parametros.data_referencia}`);
      console.log(`  • Total de Artigos em Stock (SKUs):    ${r.total_artigos_inventario}`);
      console.log(`  • Total de Unidades na Prateleira:     ${r.total_unidades_stock}`);
      console.log(`  • Valor Total do Stock (Preço Custo):  ${r.valor_total_stock_custo.toFixed(2)} €`);
      console.log(`  -------------------------------------------------------------`);
      console.log(
        `  • Excesso de Cobertura (> ${report.parametros.limite_cobertura_meses} meses):    ${r.total_artigos_excesso_cobertura} artigos`
      );
      console.log(
        `  • Monos (0 vendas últimos ${report.parametros.periodo_monos_dias} dias):    ${r.total_artigos_monos} artigos`
      );
      console.log(
        `  • Capital Imobilizado em Monos:        ${r.valor_total_monos.toFixed(2)} € (${r.percentagem_capital_em_monos}% do stock)`
      );
      console.log(`  -------------------------------------------------------------`);
      console.log(
        `  • Artigos em Stock c/ Prazo Validade:  ${r.total_artigos_com_validade_registada} artigos`
      );
      console.log(
        `  • Risco Elevado de Caducidade:         ${r.total_artigos_risco_caducidade} artigos (${r.unidades_totais_risco_caducidade} embalagens em risco)`
      );
      console.log(
        `  • Capital em Risco de Caducidade:      ${r.valor_total_risco_caducidade.toFixed(2)} €`
      );

      console.log(`\n🚨 TOP 5 MONOS (MAIOR CAPITAL IMOBILIZADO SEM VENDAS NOS ÚLTIMOS ${diasMonos} DIAS):`);
      for (const m of report.monos.slice(0, 5)) {
        console.log(
          `  - [${m.cnp_codigo}] ${m.designacao.slice(0, 42).padEnd(42)} | Stock: ${String(m.stock_atual).padStart(3)} | Custo: ${m.custo_unitario.toFixed(2)}€ | Imobilizado: ${m.capital_imobilizado.toFixed(2)}€`
        );
      }

      console.log(`\n⏳ TOP 10 PRODUTOS EM RISCO ELEVADO DE CADUCIDADE (POR VALOR EM RISCO):`);
      for (const c of report.risco_elevado_caducidade.slice(0, 10)) {
        const cobStr = c.cobertura_meses !== null ? `${c.cobertura_meses}m` : '∞ (VMM=0)';
        console.log(
          `  - [${c.cnp_codigo}] ${c.designacao.slice(0, 35).padEnd(35)} | Val: ${c.data_validade} (${c.meses_ate_caducidade}m) | Cob: ${cobStr.padEnd(9)} | Em Risco: ${c.unidades_em_risco}/${c.stock_atual} un (${c.valor_em_risco.toFixed(2)}€)`
        );
      }

      console.log(`\n💾 Relatório JSON completo guardado em: ${outPath}\n`);
    }
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('❌ Erro na execução do pipeline:', err);
  process.exit(1);
});
