import { PrismaClient } from '@prisma/client';
import {
  analyzePharmacyInventory,
  PharmacyAnalysisReport,
  AnalysisOptions,
  ProdutoMonoItem,
  ProdutoCoberturaItem,
  ProdutoRiscoCaducidadeItem,
  ProdutoRiscoRuturaItem,
  GrupoConsolidacaoGenericoItem,
} from './analysis';
import { TipoVenda, SegmentoProduto } from './classifier';
import { loadEnrichedCatalogMap, buildDeterministicDashboardGuidance } from './comercial_repo';

const CHUNK_SIZE = 500;

async function chunkedCreateMany<T>(
  items: T[],
  insertFn: (chunk: T[]) => Promise<any>
): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    await insertFn(chunk);
  }
}

/**
 * Computa as métricas analíticas e persiste-as nas tabelas de Marts pré-agregadas.
 * Chamado após cada importação de dados pelo worker em segundo plano.
 */
export async function computeAndPersistMarts(
  prisma: PrismaClient,
  farmaciaId: string,
  options: AnalysisOptions = {}
): Promise<PharmacyAnalysisReport> {
  // 1. Executa o motor oficial de análise
  const report = await analyzePharmacyInventory(prisma, farmaciaId, options);
  const r = report.resumo_executivo;
  const p = report.parametros;

  // 2. Persistir Resumo Executivo em MartTenantKpis
  await prisma.martTenantKpis.upsert({
    where: { farmaciaId },
    create: {
      farmaciaId,
      total_artigos_inventario: r.total_artigos_inventario,
      total_unidades_stock: r.total_unidades_stock,
      valor_total_stock_custo: r.valor_total_stock_custo,
      artigos_venda_livre_psbe: r.artigos_venda_livre_psbe,
      valor_stock_venda_livre_psbe: r.valor_stock_venda_livre_psbe,
      artigos_mnsrm: r.artigos_mnsrm,
      artigos_msrm_receita: r.artigos_msrm_receita,
      artigos_genericos_mg: r.artigos_genericos_mg,
      valor_stock_genericos_mg: r.valor_stock_genericos_mg,
      artigos_medicamentos_marca: r.artigos_medicamentos_marca,
      valor_stock_medicamentos_marca: r.valor_stock_medicamentos_marca,
      grupos_dci_com_multiplos_labs: r.grupos_dci_com_multiplos_labs,
      total_artigos_excesso_cobertura: r.total_artigos_excesso_cobertura,
      total_artigos_monos: r.total_artigos_monos,
      valor_total_monos: r.valor_total_monos,
      total_artigos_restos_gaveta: r.total_artigos_restos_gaveta,
      valor_total_restos_gaveta: r.valor_total_restos_gaveta,
      total_artigos_monos_profundidade: r.total_artigos_monos_profundidade,
      valor_total_monos_profundidade: r.valor_total_monos_profundidade,
      data_ultima_venda: r.data_ultima_venda,
      percentagem_capital_em_monos: r.percentagem_capital_em_monos,
      total_artigos_com_validade_registada: r.total_artigos_com_validade_registada,
      total_artigos_risco_caducidade: r.total_artigos_risco_caducidade,
      unidades_totais_risco_caducidade: r.unidades_totais_risco_caducidade,
      valor_total_risco_caducidade: r.valor_total_risco_caducidade,
      data_referencia: new Date(p.data_referencia),
      atualizadoEm: new Date(),
    },
    update: {
      total_artigos_inventario: r.total_artigos_inventario,
      total_unidades_stock: r.total_unidades_stock,
      valor_total_stock_custo: r.valor_total_stock_custo,
      artigos_venda_livre_psbe: r.artigos_venda_livre_psbe,
      valor_stock_venda_livre_psbe: r.valor_stock_venda_livre_psbe,
      artigos_mnsrm: r.artigos_mnsrm,
      artigos_msrm_receita: r.artigos_msrm_receita,
      artigos_genericos_mg: r.artigos_genericos_mg,
      valor_stock_genericos_mg: r.valor_stock_genericos_mg,
      artigos_medicamentos_marca: r.artigos_medicamentos_marca,
      valor_stock_medicamentos_marca: r.valor_stock_medicamentos_marca,
      grupos_dci_com_multiplos_labs: r.grupos_dci_com_multiplos_labs,
      total_artigos_excesso_cobertura: r.total_artigos_excesso_cobertura,
      total_artigos_monos: r.total_artigos_monos,
      valor_total_monos: r.valor_total_monos,
      total_artigos_restos_gaveta: r.total_artigos_restos_gaveta,
      valor_total_restos_gaveta: r.valor_total_restos_gaveta,
      total_artigos_monos_profundidade: r.total_artigos_monos_profundidade,
      valor_total_monos_profundidade: r.valor_total_monos_profundidade,
      data_ultima_venda: r.data_ultima_venda,
      percentagem_capital_em_monos: r.percentagem_capital_em_monos,
      total_artigos_com_validade_registada: r.total_artigos_com_validade_registada,
      total_artigos_risco_caducidade: r.total_artigos_risco_caducidade,
      unidades_totais_risco_caducidade: r.unidades_totais_risco_caducidade,
      valor_total_risco_caducidade: r.valor_total_risco_caducidade,
      data_referencia: new Date(p.data_referencia),
      atualizadoEm: new Date(),
    },
  });

  // 3. Preparar conjuntos de identificação rápida
  const monosSet = new Map<string, ProdutoMonoItem>();
  report.monos.forEach((m) => monosSet.set(m.cnp_codigo, m));

  const excessoSet = new Map<string, ProdutoCoberturaItem>();
  report.alertas_excesso_cobertura.forEach((e) => excessoSet.set(e.cnp_codigo, e));

  const caducidadeSet = new Map<string, ProdutoRiscoCaducidadeItem>();
  report.risco_elevado_caducidade.forEach((c) => caducidadeSet.set(c.cnp_codigo, c));

  const ruturaSet = new Map<string, ProdutoRiscoRuturaItem>();
  report.artigos_risco_rutura.forEach((rr) => ruturaSet.set(rr.cnp_codigo, rr));

  // 4. Carregar histórico de vendas e inventários para construir os Marts de Produtos e Meses
  const [inventarios, vendas] = await Promise.all([
    prisma.inventario.findMany({
      where: { farmaciaId },
      include: { produto: true },
    }),
    prisma.venda.findMany({
      where: { farmaciaId },
      select: {
        cnp_codigo: true,
        data_venda: true,
        quantidade: true,
        valor_total: true,
        granularidade: true,
      },
    }),
  ]);

  const dataRef = new Date(p.data_referencia || '2026-10-31T23:59:59.999Z');
  // Janela histórica dos últimos 13 meses (mês homólogo anterior até ao mês de referência)
  const dataInicioJanela = new Date(Date.UTC(dataRef.getUTCFullYear() - 1, dataRef.getUTCMonth(), 1));
  const data3MesesAtras = new Date(dataRef.getTime() - 90 * 24 * 60 * 60 * 1000);

  const vendasTotaisPorCnp = new Map<string, number>();
  const ultimaVendaPorCnp = new Map<string, Date>();
  const vendasUltimos3MesesPorCnp = new Map<string, number>();
  const mesMap = new Map<string, { cnp: string; mes: string; qtd: number; valor: number }>();

  for (const v of vendas) {
    const d = v.data_venda;
    if (d > dataRef) continue;

    // Acompanhar a data da última venda histórica real (apenas quantidade > 0)
    if (v.quantidade > 0) {
      const curLatest = ultimaVendaPorCnp.get(v.cnp_codigo);
      if (!curLatest || d > curLatest) {
        ultimaVendaPorCnp.set(v.cnp_codigo, d);
      }
    }

    if (d >= data3MesesAtras && v.quantidade > 0) {
      vendasUltimos3MesesPorCnp.set(
        v.cnp_codigo,
        (vendasUltimos3MesesPorCnp.get(v.cnp_codigo) || 0) + v.quantidade
      );
    }

    // Ignora movimentos históricos antigos fora do ciclo de 12-13 meses (ex: dados legados de 2022)
    if (d < dataInicioJanela) continue;

    if (v.granularidade !== 'DIARIO') {
      vendasTotaisPorCnp.set(v.cnp_codigo, (vendasTotaisPorCnp.get(v.cnp_codigo) || 0) + v.quantidade);
    }
    const ym = `${v.data_venda.getUTCFullYear()}-${String(v.data_venda.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `${v.cnp_codigo}_${ym}`;
    const cur = mesMap.get(key) || { cnp: v.cnp_codigo, mes: ym, qtd: 0, valor: 0 };
    cur.qtd += v.quantidade;
    cur.valor += Number(v.valor_total);
    mesMap.set(key, cur);
  }

  const productRows: any[] = [];
  const now = new Date();

  // Deduplicação por CNP (agrega stock de múltiplos lotes)
  const cnpAgg = new Map<string, {
    produto: any;
    stockTotal: number;
    valorCustoTotal: number;
    validadeMin: Date | null;
  }>();

  for (const inv of inventarios) {
    // 3.4: Mesma regra do painel (analysis.ts): apenas artigos com stock positivo entram no mart de stock ativo
    if (inv.quantidade <= 0) continue;
    const existing = cnpAgg.get(inv.cnp_codigo) || {
      produto: inv.produto,
      stockTotal: 0,
      valorCustoTotal: 0,
      validadeMin: null,
    };
    existing.stockTotal += inv.quantidade;
    existing.valorCustoTotal += inv.quantidade * Number(inv.custo_unitario);
    if (inv.data_validade) {
      if (!existing.validadeMin || inv.data_validade < existing.validadeMin) {
        existing.validadeMin = inv.data_validade;
      }
    }
    cnpAgg.set(inv.cnp_codigo, existing);
  }

  for (const [cnp, item] of cnpAgg.entries()) {
    const p = item.produto;
    const mono = monosSet.get(cnp);
    const exc = excessoSet.get(cnp);
    const cad = caducidadeSet.get(cnp);
    const rut = ruturaSet.get(cnp);

    const custoMedio = item.stockTotal > 0 ? item.valorCustoTotal / item.stockTotal : 0;

    const vendasTot = vendasTotaisPorCnp.get(cnp) || 0;
    const vmmFallback = Math.round((vendasTot / 12) * 100) / 100;
    const vmmFinal = exc?.vmm !== undefined ? Number(exc.vmm) : (cad?.vmm !== undefined ? Number(cad.vmm) : vmmFallback);
    const cobFallback = vmmFinal > 0 ? Math.round((item.stockTotal / vmmFinal) * 100) / 100 : (item.stockTotal > 0 ? 999 : 0);
    const cobFinal = exc?.cobertura_meses !== undefined ? Number(exc.cobertura_meses) : (cad?.cobertura_meses !== undefined ? Number(cad.cobertura_meses) : cobFallback);
    const rutFinal = Boolean(rut) || (item.stockTotal === 0 && vendasTot >= 6) || (vmmFinal >= 1.0 && cobFinal < 0.7);

    // P0.3: Cálculo de dias_sem_vendas real a partir da última venda e regra estrita de mono
    const lastSaleDate = ultimaVendaPorCnp.get(cnp) || (mono?.ultima_venda ? new Date(mono.ultima_venda) : null);
    let diasSemVendasReal: number | null = null;
    if (lastSaleDate) {
      diasSemVendasReal = Math.max(0, Math.floor((dataRef.getTime() - lastSaleDate.getTime()) / (1000 * 60 * 60 * 24)));
    } else if (item.stockTotal > 0) {
      diasSemVendasReal = 999;
    }

    // C1: Regra canónica única de mono igual ao painel (stock > 0 e 0 vendas nos últimos N dias)
    const ehMonoReal = Boolean(mono);

    productRows.push({
      farmaciaId,
      cnp_codigo: cnp,
      aim: p.aim || null,
      designacao: p.designacao,
      tipo_venda: p.tipo_venda || null,
      segmento: p.macro_area || null,
      categoria: p.categoria || null,
      subcategoria: p.subcategoria || null,
      eh_generico: Boolean(p.dci || mono?.eh_generico || exc?.eh_generico),
      grupo_equivalencia_dci: p.dci || null,
      molecula_dci: p.dci || null,
      laboratorio_titular: p.laboratorio_titular || null,
      stock_total_unidades: item.stockTotal,
      stock_total_valor_custo: Math.round(item.valorCustoTotal * 100) / 100,
      custo_unitario_medio: Math.round(custoMedio * 10000) / 10000,
      pvp: p.pvp !== null ? Number(p.pvp) : null,
      margem_padrao: p.margem_padrao !== null ? Number(p.margem_padrao) : null,
      taxa_iva: p.taxa_iva || null,
      total_unidades_vendidas: vendasTot,
      vmm: vmmFinal,
      cobertura_meses: cobFinal,
      data_ultima_venda: lastSaleDate,
      dias_sem_vendas: diasSemVendasReal,
      eh_mono: ehMonoReal,
      eh_excesso_cobertura: Boolean(exc),
      unidades_excesso: exc ? Math.max(0, exc.stock_atual - Math.ceil(exc.vmm * 4)) : 0,
      capital_excesso: exc ? Math.max(0, (exc.stock_atual - Math.ceil(exc.vmm * 4)) * exc.custo_unitario) : 0,
      data_validade_mais_proxima: item.validadeMin,
      meses_ate_validade: cad?.meses_ate_caducidade || null,
      unidades_em_risco_caducidade: cad?.unidades_em_risco || 0,
      valor_em_risco_caducidade: cad?.valor_em_risco || 0,
      eh_risco_caducidade: Boolean(cad),
      eh_risco_rutura: rutFinal,
      sugestao_cross_sell: exc?.sugestao_balcao || mono?.acao_sugerida || null,
      atualizadoEm: now,
    });
  }

  // Limpar e re-inserir MartProdutoMetricas em lote
  await prisma.martProdutoMetricas.deleteMany({ where: { farmaciaId } });
  await chunkedCreateMany(productRows, (chunk) =>
    prisma.martProdutoMetricas.createMany({ data: chunk, skipDuplicates: true })
  );

  // 5. Persistir Grupos DCI
  const dciRows = report.consolidacao_genericos_dci.map((g) => ({
    farmaciaId,
    grupo_equivalencia_dci: g.grupo_equivalencia_dci,
    num_laboratorios_abertos: g.num_laboratorios_abertos,
    stock_total_unidades: g.stock_total_unidades,
    stock_total_valor_custo: g.valor_total_stock || 0,
    vmm_total_grupo: g.vmm_total_grupo,
    custo_minimo: g.custo_minimo,
    custo_maximo: g.custo_maximo,
    poupanca_potencial_anual: Math.round((g.custo_maximo - g.custo_minimo) * g.vmm_total_grupo * 12 * 100) / 100,
    labsJson: g.todos_laboratorios as any,
    atualizadoEm: now,
  }));

  await prisma.martDciGrupo.deleteMany({ where: { farmaciaId } });
  await chunkedCreateMany(dciRows, (chunk) =>
    prisma.martDciGrupo.createMany({ data: chunk, skipDuplicates: true })
  );

  // 6. Persistir Histórico de Vendas Mensais por Produto (MartProdutoMes)
  const mesRows = Array.from(mesMap.values()).map((m) => ({
    farmaciaId,
    cnp_codigo: m.cnp,
    mes: m.mes,
    quantidade: m.qtd,
    valor_total: Math.round(m.valor * 100) / 100,
  }));

  await prisma.martProdutoMes.deleteMany({ where: { farmaciaId } });
  await chunkedCreateMany(mesRows, (chunk) =>
    prisma.martProdutoMes.createMany({ data: chunk, skipDuplicates: true })
  );

  return report;
}

/**
 * Lê o relatório completo do Dashboard a partir dos Marts pré-agregados em < 10ms.
 */
export async function getDashboardFromMarts(
  prisma: PrismaClient,
  farmaciaId: string,
  diasMonos = 90,
  limiteCobertura = 4
): Promise<PharmacyAnalysisReport | null> {
  const kpiRow = await prisma.martTenantKpis.findUnique({
    where: { farmaciaId },
  });

  if (!kpiRow) return null;

  const farmacia = await prisma.farmacia.findUnique({
    where: { id: farmaciaId },
    select: { id: true, nome: true, nif: true },
  });

  if (!farmacia) return null;

  // Carregar listas diretamente através dos índices otimizados
  const [monosRows, excessoRows, caducidadeRows, dciRows] = await Promise.all([
    prisma.martProdutoMetricas.findMany({
      where: {
        farmaciaId,
        eh_mono: true,
      },
      orderBy: { stock_total_valor_custo: 'desc' },
    }),
    prisma.martProdutoMetricas.findMany({
      where: {
        farmaciaId,
        eh_excesso_cobertura: true,
      },
      orderBy: { capital_excesso: 'desc' },
    }),
    prisma.martProdutoMetricas.findMany({
      where: { farmaciaId, eh_risco_caducidade: true },
      orderBy: { valor_em_risco_caducidade: 'desc' },
    }),
    prisma.martDciGrupo.findMany({
      where: { farmaciaId },
      orderBy: { poupanca_potencial_anual: 'desc' },
    }),
  ]);

  const enrichedMap = await loadEnrichedCatalogMap(prisma, farmaciaId);

  const report: PharmacyAnalysisReport = {
    farmacia,
    parametros: {
      data_referencia: kpiRow.data_referencia.toISOString().slice(0, 10),
      data_ultima_venda: kpiRow.data_ultima_venda,
      periodo_monos_dias: diasMonos,
      data_corte_monos: new Date(kpiRow.data_referencia.getTime() - diasMonos * 86400000).toISOString().slice(0, 10),
      limite_cobertura_meses: limiteCobertura,
      meses_historico_vmm: 12,
    },
    resumo_executivo: {
      total_artigos_inventario: kpiRow.total_artigos_inventario,
      total_unidades_stock: kpiRow.total_unidades_stock,
      valor_total_stock_custo: Number(kpiRow.valor_total_stock_custo),
      artigos_venda_livre_psbe: kpiRow.artigos_venda_livre_psbe,
      valor_stock_venda_livre_psbe: Number(kpiRow.valor_stock_venda_livre_psbe),
      artigos_mnsrm: kpiRow.artigos_mnsrm,
      artigos_msrm_receita: kpiRow.artigos_msrm_receita,
      artigos_genericos_mg: kpiRow.artigos_genericos_mg,
      valor_stock_genericos_mg: Number(kpiRow.valor_stock_genericos_mg),
      artigos_medicamentos_marca: kpiRow.artigos_medicamentos_marca,
      valor_stock_medicamentos_marca: Number(kpiRow.valor_stock_medicamentos_marca),
      grupos_dci_com_multiplos_labs: kpiRow.grupos_dci_com_multiplos_labs,
      total_artigos_excesso_cobertura: excessoRows.length,
      total_artigos_monos: monosRows.length,
      valor_total_monos: monosRows.reduce((s, m) => s + Number(m.stock_total_valor_custo), 0),
      total_artigos_restos_gaveta: kpiRow.total_artigos_restos_gaveta,
      valor_total_restos_gaveta: Number(kpiRow.valor_total_restos_gaveta),
      total_artigos_monos_profundidade: kpiRow.total_artigos_monos_profundidade,
      valor_total_monos_profundidade: Number(kpiRow.valor_total_monos_profundidade),
      data_ultima_venda: kpiRow.data_ultima_venda,
      percentagem_capital_em_monos: Number(kpiRow.percentagem_capital_em_monos),
      total_artigos_com_validade_registada: kpiRow.total_artigos_com_validade_registada,
      total_artigos_risco_caducidade: kpiRow.total_artigos_risco_caducidade,
      unidades_totais_risco_caducidade: kpiRow.unidades_totais_risco_caducidade,
      valor_total_risco_caducidade: Number(kpiRow.valor_total_risco_caducidade),
    },
    monos: monosRows.map((m) => {
      const cand = enrichedMap.get(m.cnp_codigo);
      const g = cand
        ? buildDeterministicDashboardGuidance(cand, {
            contexto: 'MONO',
            ehGenerico: m.eh_generico,
            grupoDci: m.grupo_equivalencia_dci,
          })
        : null;
      return {
        cnp_codigo: m.cnp_codigo,
        designacao: m.designacao,
        tipo_venda: (g?.tipoVendaSeguro || (m.tipo_venda as TipoVenda) || 'VENDA_LIVRE') as TipoVenda,
        segmento: (g
          ? g.ehGenericoSeguro
            ? 'GENERICO_MG'
            : g.tipoVendaSeguro === 'MSRM'
              ? 'MARCA'
              : 'MNSRM_OTC'
          : (m.segmento as SegmentoProduto) || 'MNSRM_OTC') as SegmentoProduto,
        eh_generico: g ? g.ehGenericoSeguro : m.eh_generico,
        grupo_equivalencia_dci: m.grupo_equivalencia_dci,
        macro_area: g?.macroArea || 'MNSRM_OTC',
        categoria: g?.categoriaLabel || m.categoria || 'Geral',
        subcategoria: g?.subcategoriaLabel || m.subcategoria,
        sazonalidade: g?.sazonalidade || 'TODO_O_ANO',
        prateleira: null,
        lote: 'LOTE ÚNICO',
        stock_atual: m.stock_total_unidades,
        custo_unitario: Number(m.custo_unitario_medio),
        pvp: m.pvp !== null ? Number(m.pvp) : null,
        margem_percentagem: m.margem_padrao !== null ? Number(m.margem_padrao) : null,
        capital_imobilizado: Number(m.stock_total_valor_custo),
        ultima_venda: m.data_ultima_venda ? m.data_ultima_venda.toISOString().slice(0, 10) : null,
        unidades_vendidas_ano: m.total_unidades_vendidas,
        data_validade: m.data_validade_mais_proxima ? m.data_validade_mais_proxima.toISOString().slice(0, 10) : null,
        acao_sugerida: g?.acaoRecomendada || m.sugestao_cross_sell || 'Consultar Diretor Técnico',
      };
    }),
    alertas_excesso_cobertura: excessoRows.map((e) => {
      const cand = enrichedMap.get(e.cnp_codigo);
      const g = cand
        ? buildDeterministicDashboardGuidance(cand, {
            contexto: 'EXCESSO',
            ehGenerico: e.eh_generico,
            grupoDci: e.grupo_equivalencia_dci,
          })
        : null;
      return {
        cnp_codigo: e.cnp_codigo,
        designacao: e.designacao,
        tipo_venda: (g?.tipoVendaSeguro || (e.tipo_venda as TipoVenda) || 'VENDA_LIVRE') as TipoVenda,
        segmento: (g
          ? g.ehGenericoSeguro
            ? 'GENERICO_MG'
            : g.tipoVendaSeguro === 'MSRM'
              ? 'MARCA'
              : 'MNSRM_OTC'
          : (e.segmento as SegmentoProduto) || 'MNSRM_OTC') as SegmentoProduto,
        eh_generico: g ? g.ehGenericoSeguro : e.eh_generico,
        grupo_equivalencia_dci: e.grupo_equivalencia_dci,
        macro_area: g?.macroArea || 'MNSRM_OTC',
        categoria: g?.categoriaLabel || e.categoria || 'Geral',
        subcategoria: g?.subcategoriaLabel || e.subcategoria,
        sazonalidade: g?.sazonalidade || 'TODO_O_ANO',
        sugestao_balcao: g?.acaoRecomendada || e.sugestao_cross_sell || 'Travar Encomendas',
        prateleira: null,
        lote: 'LOTE ÚNICO',
        stock_atual: e.stock_total_unidades,
        custo_unitario: Number(e.custo_unitario_medio),
        pvp: e.pvp !== null ? Number(e.pvp) : null,
        margem_percentagem: e.margem_padrao !== null ? Number(e.margem_padrao) : null,
        unidades_vendidas_periodo: e.total_unidades_vendidas,
        vmm: Number(e.vmm),
        cobertura_meses: Number(e.cobertura_meses),
        excesso_cobertura: true,
      };
    }),
    risco_elevado_caducidade: caducidadeRows.map((c) => {
      const cand = enrichedMap.get(c.cnp_codigo);
      const g = cand
        ? buildDeterministicDashboardGuidance(cand, {
            contexto: 'CADUCIDADE',
            ehGenerico: c.eh_generico,
            grupoDci: c.grupo_equivalencia_dci,
          })
        : null;
      return {
        cnp_codigo: c.cnp_codigo,
        designacao: c.designacao,
        tipo_venda: (g?.tipoVendaSeguro || (c.tipo_venda as TipoVenda) || 'VENDA_LIVRE') as TipoVenda,
        segmento: (g
          ? g.ehGenericoSeguro
            ? 'GENERICO_MG'
            : g.tipoVendaSeguro === 'MSRM'
              ? 'MARCA'
              : 'MNSRM_OTC'
          : (c.segmento as SegmentoProduto) || 'MNSRM_OTC') as SegmentoProduto,
        eh_generico: g ? g.ehGenericoSeguro : c.eh_generico,
        grupo_equivalencia_dci: c.grupo_equivalencia_dci,
        macro_area: g?.macroArea || 'MNSRM_OTC',
        categoria: g?.categoriaLabel || c.categoria || 'Geral',
        subcategoria: g?.subcategoriaLabel || c.subcategoria,
        sazonalidade: g?.sazonalidade || 'TODO_O_ANO',
        prateleira: null,
        lote: 'LOTE ÚNICO',
        stock_atual: c.stock_total_unidades,
        custo_unitario: Number(c.custo_unitario_medio),
        pvp: c.pvp !== null ? Number(c.pvp) : null,
        margem_percentagem: c.margem_padrao !== null ? Number(c.margem_padrao) : null,
        data_validade: c.data_validade_mais_proxima ? c.data_validade_mais_proxima.toISOString().slice(0, 10) : '—',
        meses_ate_caducidade: c.meses_ate_validade || 0,
        vmm: Number(c.vmm),
        cobertura_meses: Number(c.cobertura_meses),
        classificacao: 'Risco Elevado de Caducidade',
        unidades_em_risco: c.unidades_em_risco_caducidade,
        valor_em_risco: Number(c.valor_em_risco_caducidade),
        acao_recomendada:
          g?.acaoRecomendada ||
          (c.tipo_venda === 'MSRM'
            ? '🔒 [MSRM — Proibido desconto] Travar stock mínimo e solicitar devolução/nota de crédito ao armazenista.'
            : 'ℹ️ Priorizar escoamento ao balcão antes da caducidade.'),
      };
    }),
    artigos_risco_rutura: [],
    consolidacao_genericos_dci: dciRows.map((g) => {
      const labs = Array.isArray(g.labsJson) ? g.labsJson : [];
      return {
        grupo_equivalencia_dci: g.grupo_equivalencia_dci,
        molecula_dci: g.grupo_equivalencia_dci,
        num_laboratorios_abertos: g.num_laboratorios_abertos,
        stock_total_unidades: g.stock_total_unidades,
        valor_total_stock: Number(g.stock_total_valor_custo),
        vmm_total_grupo: Number(g.vmm_total_grupo),
        cobertura_conjunta_meses: null,
        custo_minimo: Number(g.custo_minimo),
        laboratorio_mais_barato: ((labs as any)[0] && (labs as any)[0].designacao) || '—',
        custo_maximo: Number(g.custo_maximo),
        laboratorio_mais_caro: ((labs as any)[labs.length - 1] && (labs as any)[labs.length - 1].designacao) || '—',
        diferenca_custo_pct: Number(g.custo_minimo) > 0 ? Math.round(((Number(g.custo_maximo) - Number(g.custo_minimo)) / Number(g.custo_minimo)) * 100) : 0,
        restos_gaveta_escobar_primeiro: (labs as any).filter((l: any) => l.stock_atual <= 2),
        todos_laboratorios: labs as any,
      };
    }),
  };

  return report;
}

/**
 * Obtém o detalhe de um produto individual a partir dos Marts para o modal em < 3ms.
 */
export async function getProductDetailsFromMarts(
  prisma: PrismaClient,
  farmaciaId: string,
  cnp: string
) {
  let [metricas, vendasMes, inventarios] = await Promise.all([
    prisma.martProdutoMetricas.findUnique({
      where: { farmaciaId_cnp_codigo: { farmaciaId, cnp_codigo: cnp } },
    }),
    prisma.martProdutoMes.findMany({
      where: { farmaciaId, cnp_codigo: cnp },
      orderBy: { mes: 'asc' },
    }),
    prisma.inventario.findMany({
      where: { farmaciaId, cnp_codigo: cnp },
      select: { lote: true, prateleira: true, quantidade: true, custo_unitario: true, data_validade: true },
    }),
  ]);

  if (!metricas) return null;

  // Fallback resiliente: se os Marts mensais deste produto ainda não estiverem agregados, busca em Venda
  if (vendasMes.length === 0) {
    const rawVendas = await prisma.venda.findMany({
      where: { farmaciaId, cnp_codigo: cnp },
      orderBy: { data_venda: 'asc' },
    });
    if (rawVendas.length > 0) {
      const monthMap = new Map<string, { quantidade: number; valor_total: number }>();
      for (const v of rawVendas) {
        const ym = `${v.data_venda.getUTCFullYear()}-${String(v.data_venda.getUTCMonth() + 1).padStart(2, '0')}`;
        const cur = monthMap.get(ym) || { quantidade: 0, valor_total: 0 };
        cur.quantidade += v.quantidade;
        cur.valor_total += Number(v.valor_total);
        monthMap.set(ym, cur);
      }
      vendasMes = Array.from(monthMap.entries()).map(([mes, d]) => ({
        id: '',
        farmaciaId,
        cnp_codigo: cnp,
        mes,
        quantidade: d.quantidade,
        valor_total: d.valor_total as any,
      }));
    }
  }

  // 4. Se for genérico ou tiver grupo DCI, procurar o grupo de equivalência correspondente
  let dciGroupData: any = null;
  if (metricas.eh_generico || metricas.grupo_equivalencia_dci) {
    const dciGrupos = await prisma.martDciGrupo.findMany({
      where: { farmaciaId },
    });
    const found = dciGrupos.find((g: any) => {
      const labs = Array.isArray(g.labsJson) ? g.labsJson : [];
      return (
        labs.some((l: any) => l.cnp_codigo === cnp) ||
        (metricas.grupo_equivalencia_dci &&
          g.grupo_equivalencia_dci.toLowerCase().includes(metricas.grupo_equivalencia_dci.toLowerCase()))
      );
    });

    if (found) {
      dciGroupData = {
        grupo_equivalencia_dci: found.grupo_equivalencia_dci,
        molecula_dci: found.grupo_equivalencia_dci,
        num_laboratorios_abertos: found.num_laboratorios_abertos,
        stock_total_unidades: found.stock_total_unidades,
        valor_total_stock: Number(found.stock_total_valor_custo),
        vmm_total_grupo: Number(found.vmm_total_grupo),
        custo_minimo: Number(found.custo_minimo),
        custo_maximo: Number(found.custo_maximo),
        todos_laboratorios: found.labsJson,
      };
    }
  }

  return {
    cnp_codigo: metricas.cnp_codigo,
    aim: metricas.aim,
    designacao: metricas.designacao,
    tipo_venda: metricas.tipo_venda,
    segmento: metricas.segmento,
    eh_generico: metricas.eh_generico,
    molecula_dci: metricas.molecula_dci,
    grupo_equivalencia_dci: metricas.grupo_equivalencia_dci,
    categoria: metricas.categoria,
    sugestao_cross_sell: metricas.sugestao_cross_sell,
    taxa_iva: metricas.taxa_iva,
    pvp: metricas.pvp !== null ? Number(metricas.pvp) : null,
    margem_padrao: metricas.margem_padrao !== null ? Number(metricas.margem_padrao) : null,
    dci_group: dciGroupData,
    inventario: inventarios.map((i) => ({
      lote: i.lote,
      prateleira: i.prateleira,
      quantidade: i.quantidade,
      custo_unitario: Number(i.custo_unitario),
      data_validade: i.data_validade ? i.data_validade.toISOString().slice(0, 10) : null,
    })),
    vendas: vendasMes.map((v) => ({
      mes: v.mes,
      quantidade: v.quantidade,
      valor_total: Number(v.valor_total),
    })),
  };
}
