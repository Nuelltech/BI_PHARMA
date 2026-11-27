import type { PrismaClient } from '@prisma/client';
import { getLatestImportForPharmacy } from './import_registry';
import { calcularTaxaIva } from './metricas';

export type SalesPeriodKey = '1m' | '3m' | '6m' | '12m' | '2026' | '2025' | 'custom';

export interface SalesExplorerItem {
  cnp_codigo: string;
  designacao: string;
  laboratorio_titular: string;
  molecula_dci: string | null;
  tipo_venda: string;
  categoria: string | null;
  eh_generico: boolean;
  eh_mono: boolean;
  unidades_periodo: number;
  unidades_anterior: number;
  variacao_un_pct: number | null;
  faturacao_periodo: number | null;
  faturacao_anterior: number | null;
  margem_estimada_eur: number | null;
  margem_pct: number | null;
  stock_atual: number;
  stock_valor_custo: number | null;
  custo_unitario_medio: number | null;
  pvp: number | null;
  vmm: number;
  cobertura_meses: number | null;
  data_ultima_venda: string | null;
  em_rutura: boolean;
}

export interface SalesExplorerResponse {
  ok: true;
  farmaciaId: string;
  period: SalesPeriodKey;
  mesInicio: string;
  mesFim: string;
  mesAnteriorInicio: string | null;
  mesAnteriorFim: string | null;
  mesParcial: boolean;
  dataCorte: string | null;
  mesesDisponiveis: string[];
  verFaturacao: boolean;
  items: SalesExplorerItem[];
  laboratorios: string[];
}

export interface ProductMonthlyPoint {
  mes: string; // YYYY-MM
  mes_label: string;
  unidades: number;
  faturacao: number | null;
  stock_fecho: number | null;
  stock_valor_custo: number | null;
  has_snapshot: boolean;
  is_parcial: boolean;
  variacao_mom_pct: number | null;
}

export interface ProductSalesHistoryResponse {
  ok: true;
  verFaturacao: boolean;
  produto: {
    cnp_codigo: string;
    designacao: string;
    laboratorio_titular: string;
    molecula_dci: string | null;
    tipo_venda: string;
    categoria: string | null;
    eh_generico: boolean;
    eh_mono: boolean;
    stock_atual: number;
    stock_valor_custo: number | null;
    custo_unitario_medio: number | null;
    pvp: number | null;
    vmm: number;
    cobertura_meses: number | null;
    data_ultima_venda: string | null;
  };
  resumo: {
    total_unidades_12m: number;
    total_faturacao_12m: number | null;
    melhor_mes: { mes_label: string; unidades: number } | null;
    meses_com_snapshot: number;
    tem_historico_stock: boolean;
  };
  series: ProductMonthlyPoint[];
}

const MESES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return ym;
  return `${MESES_PT[m - 1]} ${y}`;
}

function shiftMonth(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m - 1) + deltaMonths, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function enumerateMonths(startYm: string, endYm: string): string[] {
  if (!startYm || !endYm || startYm > endYm) return [];
  const res: string[] = [];
  let cur = startYm;
  let guard = 0;
  while (cur <= endYm && guard < 120) {
    res.push(cur);
    cur = shiftMonth(cur, 1);
    guard++;
  }
  return res;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const salesExplorerCache = new Map<string, { data: SalesExplorerResponse; expiresAt: number }>();

export function invalidateSalesExplorerCache(farmaciaId?: string): void {
  if (!farmaciaId) {
    salesExplorerCache.clear();
    return;
  }
  for (const k of Array.from(salesExplorerCache.keys())) {
    if (k.startsWith(`${farmaciaId}:`)) {
      salesExplorerCache.delete(k);
    }
  }
}

export async function getSalesExplorerData(
  prisma: PrismaClient,
  farmaciaId: string,
  params: {
    period?: string;
    mesInicio?: string;
    mesFim?: string;
    verFaturacao: boolean;
    forceRefresh?: boolean;
  }
): Promise<SalesExplorerResponse> {
  const validPeriods: SalesPeriodKey[] = ['1m', '3m', '6m', '12m', '2026', '2025', 'custom'];
  const period: SalesPeriodKey = validPeriods.includes(params.period as SalesPeriodKey)
    ? (params.period as SalesPeriodKey)
    : '12m';

  const cleanStart = /^\d{4}-\d{2}$/.test(params.mesInicio || '') ? String(params.mesInicio) : '';
  const cleanEnd = /^\d{4}-\d{2}$/.test(params.mesFim || '') ? String(params.mesFim) : '';
  const cacheKey = `${farmaciaId}:${period}:${cleanStart}:${cleanEnd}:${params.verFaturacao ? '1' : '0'}`;

  if (!params.forceRefresh) {
    const cached = salesExplorerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  // 1. Descobrir meses disponíveis em MartProdutoMes + último registo de importação
  const [mesesRaw, latestImport] = await Promise.all([
    prisma.martProdutoMes.findMany({
      where: { farmaciaId },
      select: { mes: true },
      distinct: ['mes'],
      orderBy: { mes: 'desc' },
    }),
    getLatestImportForPharmacy(prisma, farmaciaId).catch(() => null),
  ]);

  const mesesDisponiveis = mesesRaw.map((r) => r.mes).filter(Boolean).sort();
  const latestMonth = mesesDisponiveis.length > 0
    ? mesesDisponiveis[mesesDisponiveis.length - 1]
    : `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;

  // 2. Resolver intervalo [mesInicio, mesFim] + período anterior de igual duração
  let mesFim = latestMonth;
  let mesInicio = shiftMonth(latestMonth, -11);

  if (period === '1m') {
    mesInicio = latestMonth;
    mesFim = latestMonth;
  } else if (period === '3m') {
    mesInicio = shiftMonth(latestMonth, -2);
    mesFim = latestMonth;
  } else if (period === '6m') {
    mesInicio = shiftMonth(latestMonth, -5);
    mesFim = latestMonth;
  } else if (period === '12m') {
    mesInicio = shiftMonth(latestMonth, -11);
    mesFim = latestMonth;
  } else if (period === '2026') {
    mesInicio = '2026-01';
    mesFim = '2026-12';
  } else if (period === '2025') {
    mesInicio = '2025-01';
    mesFim = '2025-12';
  } else if (period === 'custom' && cleanStart && cleanEnd) {
    mesInicio = cleanStart <= cleanEnd ? cleanStart : cleanEnd;
    mesFim = cleanStart <= cleanEnd ? cleanEnd : cleanStart;
  }

  const currentMonths = enumerateMonths(mesInicio, mesFim);
  const spanLen = Math.max(1, currentMonths.length);
  const mesAnteriorFim = shiftMonth(mesInicio, -1);
  const mesAnteriorInicio = shiftMonth(mesInicio, -spanLen);

  // 3. Buscar vendas agregadas no período atual, período anterior e catálogo de métricas em paralelo
  const [curSalesAgg, prevSalesAgg, martMetrics] = await Promise.all([
    prisma.martProdutoMes.groupBy({
      by: ['cnp_codigo'],
      where: {
        farmaciaId,
        mes: { gte: mesInicio, lte: mesFim },
      },
      _sum: { quantidade: true, valor_total: true },
    }),
    prisma.martProdutoMes.groupBy({
      by: ['cnp_codigo'],
      where: {
        farmaciaId,
        mes: { gte: mesAnteriorInicio, lte: mesAnteriorFim },
      },
      _sum: { quantidade: true, valor_total: true },
    }),
    prisma.martProdutoMetricas.findMany({
      where: { farmaciaId },
      select: {
        cnp_codigo: true,
        designacao: true,
        laboratorio_titular: true,
        molecula_dci: true,
        tipo_venda: true,
        categoria: true,
        eh_generico: true,
        eh_mono: true,
        stock_total_unidades: true,
        stock_total_valor_custo: true,
        custo_unitario_medio: true,
        pvp: true,
        taxa_iva: true,
        vmm: true,
        cobertura_meses: true,
        data_ultima_venda: true,
      },
    }),
  ]);

  const curMap = new Map<string, { un: number; eur: number }>();
  for (const r of curSalesAgg) {
    curMap.set(r.cnp_codigo, {
      un: Number(r._sum.quantidade || 0),
      eur: round2(Number(r._sum.valor_total || 0)),
    });
  }

  const prevMap = new Map<string, { un: number; eur: number }>();
  for (const r of prevSalesAgg) {
    prevMap.set(r.cnp_codigo, {
      un: Number(r._sum.quantidade || 0),
      eur: round2(Number(r._sum.valor_total || 0)),
    });
  }

  const metricsMap = new Map<string, typeof martMetrics[number]>();
  for (const m of martMetrics) {
    metricsMap.set(m.cnp_codigo, m);
  }

  // Inclui CNPs que tiveram vendas no período mas possam não estar em MartProdutoMetricas (histórico antigo)
  const missingCnps: string[] = [];
  for (const cnp of curMap.keys()) {
    if (!metricsMap.has(cnp)) missingCnps.push(cnp);
  }

  const extraProductsMap = new Map<string, { designacao: string; laboratorio_titular: string | null; tipo_venda: string | null; categoria: string | null; taxa_iva: number | null }>();
  if (missingCnps.length > 0) {
    const extraProds = await prisma.produtoMestre.findMany({
      where: { cnp_codigo: { in: missingCnps } },
      select: {
        cnp_codigo: true,
        designacao: true,
        laboratorio_titular: true,
        tipo_venda: true,
        categoria: true,
        taxa_iva: true,
      },
    });
    for (const p of extraProds) {
      extraProductsMap.set(p.cnp_codigo, p);
    }
  }

  const allCnps = new Set<string>([...metricsMap.keys(), ...curMap.keys()]);
  const labsSet = new Set<string>();
  const items: SalesExplorerItem[] = [];

  for (const cnp of allCnps) {
    const cur = curMap.get(cnp) || { un: 0, eur: 0 };
    const prev = prevMap.get(cnp) || { un: 0, eur: 0 };
    const m = metricsMap.get(cnp);
    const ep = extraProductsMap.get(cnp);

    const stockAtual = m ? Number(m.stock_total_unidades || 0) : 0;
    // Mostrar apenas produtos com vendas no período OU com stock atual > 0
    if (cur.un <= 0 && stockAtual <= 0) continue;

    const designacao = m?.designacao || ep?.designacao || `CNP ${cnp}`;
    const lab = (m?.laboratorio_titular || ep?.laboratorio_titular || 'Sem Laboratório').trim();
    const tipoVenda = (m?.tipo_venda || ep?.tipo_venda || 'OUTRO').toUpperCase();
    if (lab) labsSet.add(lab);

    const custoMedio = m ? Number(m.custo_unitario_medio || 0) : 0;
    const stockValor = m ? round2(Number(m.stock_total_valor_custo || 0)) : 0;
    const vmm = m ? round2(Number(m.vmm || 0)) : 0;
    const cobertura = vmm > 0 ? round2(stockAtual / vmm) : null;
    const pvp = m && m.pvp != null ? round2(Number(m.pvp)) : null;

    // Margem estimada sem IVA no período: faturação s/ IVA - (unidades * custo médio)
    let margemEur: number | null = null;
    let margemPct: number | null = null;
    if (params.verFaturacao && cur.un > 0 && cur.eur > 0 && custoMedio > 0) {
      const ivaInfo = calcularTaxaIva(m?.taxa_iva ?? ep?.taxa_iva ?? null, tipoVenda);
      const fatSemIva = cur.eur / (1 + ivaInfo.taxa_iva_pct / 100);
      const cmv = cur.un * custoMedio;
      margemEur = round2(fatSemIva - cmv);
      margemPct = fatSemIva > 0 ? round2((margemEur / fatSemIva) * 100) : null;
    }

    const variacaoUnPct =
      prev.un > 0
        ? round2(((cur.un - prev.un) / prev.un) * 100)
        : cur.un > 0
        ? 100
        : null;

    items.push({
      cnp_codigo: cnp,
      designacao,
      laboratorio_titular: lab,
      molecula_dci: m?.molecula_dci || null,
      tipo_venda: tipoVenda,
      categoria: m?.categoria || ep?.categoria || null,
      eh_generico: Boolean(m?.eh_generico ?? false),
      eh_mono: Boolean(m?.eh_mono ?? false),
      unidades_periodo: cur.un,
      unidades_anterior: prev.un,
      variacao_un_pct: variacaoUnPct,
      faturacao_periodo: params.verFaturacao ? cur.eur : null,
      faturacao_anterior: params.verFaturacao ? prev.eur : null,
      margem_estimada_eur: params.verFaturacao ? margemEur : null,
      margem_pct: params.verFaturacao ? margemPct : null,
      stock_atual: stockAtual,
      stock_valor_custo: params.verFaturacao ? stockValor : null,
      custo_unitario_medio: params.verFaturacao ? (custoMedio > 0 ? round2(custoMedio) : null) : null,
      pvp: params.verFaturacao ? pvp : null,
      vmm,
      cobertura_meses: cobertura,
      data_ultima_venda: m?.data_ultima_venda ? m.data_ultima_venda.toISOString().slice(0, 10) : null,
      em_rutura: stockAtual === 0 && cur.un > 0,
    });
  }

  // Ordenação default: mais unidades vendidas (desempate por faturação / stock)
  items.sort((a, b) => {
    if (b.unidades_periodo !== a.unidades_periodo) return b.unidades_periodo - a.unidades_periodo;
    if ((b.faturacao_periodo || 0) !== (a.faturacao_periodo || 0)) {
      return (b.faturacao_periodo || 0) - (a.faturacao_periodo || 0);
    }
    return b.stock_atual - a.stock_atual;
  });

  const dataCorte = latestImport?.dados_ate ? String(latestImport.dados_ate).slice(0, 10) : null;
  const mesParcial = Boolean(latestImport?.mes_parcial && mesFim >= latestMonth);

  const response: SalesExplorerResponse = {
    ok: true,
    farmaciaId,
    period,
    mesInicio,
    mesFim,
    mesAnteriorInicio,
    mesAnteriorFim,
    mesParcial,
    dataCorte,
    mesesDisponiveis,
    verFaturacao: params.verFaturacao,
    items,
    laboratorios: Array.from(labsSet).sort((a, b) => a.localeCompare(b, 'pt')),
  };

  salesExplorerCache.set(cacheKey, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });
  return response;
}

export async function getProductSalesHistory(
  prisma: PrismaClient,
  farmaciaId: string,
  cnpCodigo: string,
  verFaturacao: boolean
): Promise<ProductSalesHistoryResponse> {
  const cleanCnp = String(cnpCodigo || '').trim();
  if (!cleanCnp) {
    throw new Error('CNP do produto obrigatório.');
  }

  const [metric, prodMestre, salesRows, snapshotRows, latestImport] = await Promise.all([
    prisma.martProdutoMetricas.findFirst({
      where: { farmaciaId, cnp_codigo: cleanCnp },
    }),
    prisma.produtoMestre.findUnique({
      where: { cnp_codigo: cleanCnp },
      select: {
        cnp_codigo: true,
        designacao: true,
        laboratorio_titular: true,
        tipo_venda: true,
        categoria: true,
      },
    }),
    prisma.martProdutoMes.findMany({
      where: { farmaciaId, cnp_codigo: cleanCnp },
      orderBy: { mes: 'asc' },
    }),
    prisma.inventarioSnapshot.findMany({
      where: { farmaciaId, cnp_codigo: cleanCnp },
      orderBy: { data_snapshot: 'asc' },
      select: {
        data_snapshot: true,
        quantidade: true,
        valor_total: true,
      },
    }),
    getLatestImportForPharmacy(prisma, farmaciaId).catch(() => null),
  ]);

  // Agrupar snapshots por mês (último snapshot dentro de cada mês) — rigorosamente apenas meses com snapshot real!
  const snapByMonth = new Map<string, { qtd: number; val: number }>();
  for (const s of snapshotRows) {
    const dt = new Date(s.data_snapshot);
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    snapByMonth.set(ym, {
      qtd: Number(s.quantidade || 0),
      val: round2(Number(s.valor_total || 0)),
    });
  }

  const salesByMonth = new Map<string, { un: number; eur: number }>();
  for (const r of salesRows) {
    salesByMonth.set(r.mes, {
      un: Number(r.quantidade || 0),
      eur: round2(Number(r.valor_total || 0)),
    });
  }

  const allMonthsSet = new Set<string>([...salesByMonth.keys(), ...snapByMonth.keys()]);
  const sortedMonths = Array.from(allMonthsSet).sort();

  // Mostrar uma linha contínua dos últimos 24 meses até ao mês mais recente (ou todos os meses se <= 24)
  let timeline: string[] = [];
  if (sortedMonths.length > 0) {
    const lastYm = sortedMonths[sortedMonths.length - 1];
    const firstYm = sortedMonths[0];
    const minWindowStart = shiftMonth(lastYm, -23);
    const startYm = firstYm > minWindowStart ? firstYm : minWindowStart;
    timeline = enumerateMonths(startYm, lastYm);
  }

  const latestYm = timeline.length > 0 ? timeline[timeline.length - 1] : '';
  const isLatestParcial = Boolean(latestImport?.mes_parcial);

  const series: ProductMonthlyPoint[] = [];
  let prevUn: number | null = null;

  for (const ym of timeline) {
    const s = salesByMonth.get(ym) || { un: 0, eur: 0 };
    const snap = snapByMonth.get(ym) || null;
    const mom =
      prevUn !== null && prevUn > 0
        ? round2(((s.un - prevUn) / prevUn) * 100)
        : prevUn === 0 && s.un > 0
        ? 100
        : null;

    series.push({
      mes: ym,
      mes_label: formatMonthLabel(ym),
      unidades: s.un,
      faturacao: verFaturacao ? s.eur : null,
      stock_fecho: snap ? snap.qtd : null,
      stock_valor_custo: verFaturacao && snap ? snap.val : null,
      has_snapshot: Boolean(snap),
      is_parcial: isLatestParcial && ym === latestYm,
      variacao_mom_pct: mom,
    });
    prevUn = s.un;
  }

  // Resumo 12M
  const last12 = series.slice(-12);
  const totalUn12m = last12.reduce((acc, p) => acc + p.unidades, 0);
  const totalFat12m = verFaturacao
    ? round2(last12.reduce((acc, p) => acc + (p.faturacao || 0), 0))
    : null;
  let melhorMes: { mes_label: string; unidades: number } | null = null;
  for (const p of series) {
    if (p.unidades > 0 && (!melhorMes || p.unidades > melhorMes.unidades)) {
      melhorMes = { mes_label: p.mes_label, unidades: p.unidades };
    }
  }

  const stockAtual = metric ? Number(metric.stock_total_unidades || 0) : 0;
  const vmm = metric ? round2(Number(metric.vmm || 0)) : 0;
  const cobertura = vmm > 0 ? round2(stockAtual / vmm) : null;

  return {
    ok: true,
    verFaturacao,
    produto: {
      cnp_codigo: cleanCnp,
      designacao: metric?.designacao || prodMestre?.designacao || `CNP ${cleanCnp}`,
      laboratorio_titular: metric?.laboratorio_titular || prodMestre?.laboratorio_titular || 'Sem Laboratório',
      molecula_dci: metric?.molecula_dci || null,
      tipo_venda: (metric?.tipo_venda || prodMestre?.tipo_venda || 'OUTRO').toUpperCase(),
      categoria: metric?.categoria || prodMestre?.categoria || null,
      eh_generico: Boolean(metric?.eh_generico ?? false),
      eh_mono: Boolean(metric?.eh_mono ?? false),
      stock_atual: stockAtual,
      stock_valor_custo: verFaturacao && metric ? round2(Number(metric.stock_total_valor_custo || 0)) : null,
      custo_unitario_medio: verFaturacao && metric ? round2(Number(metric.custo_unitario_medio || 0)) : null,
      pvp: verFaturacao && metric && metric.pvp != null ? round2(Number(metric.pvp)) : null,
      vmm,
      cobertura_meses: cobertura,
      data_ultima_venda: metric?.data_ultima_venda ? metric.data_ultima_venda.toISOString().slice(0, 10) : null,
    },
    resumo: {
      total_unidades_12m: totalUn12m,
      total_faturacao_12m: totalFat12m,
      melhor_mes: melhorMes,
      meses_com_snapshot: snapByMonth.size,
      tem_historico_stock: snapByMonth.size > 0,
    },
    series,
  };
}
