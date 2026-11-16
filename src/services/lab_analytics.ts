import { PrismaClient } from '@prisma/client';

export interface LabSummaryItem {
  laboratorio: string;
  totalArtigos: number;
  faturacaoAcumulada: number;
  unidadesVendidas: number;
  margemMediaPct: number;
  valorStockAtual: number;
  unidadesStockAtual: number;
}

export interface AimHistoricalItem {
  aim: string;
  cnp_codigo: string;
  designacao: string;
  laboratorio?: string | null;
  categoria?: string | null;
  stock_atual: number;
  custo_unitario: number;
  pvp?: number | null;
  margem_estimada_pct?: number | null;
  vendasTotaisQtd: number;
  vendasTotaisEur: number;
  historicoMensal: Array<{
    mes: string;
    quantidade: number;
    valor: number;
  }>;
}

/**
 * Análise Comparativa de Laboratórios da Farmácia / Grupo
 */
export async function getLaboratoriesAnalytics(
  prisma: PrismaClient,
  farmaciaId?: string
): Promise<LabSummaryItem[]> {
  const whereFarmacia = farmaciaId ? { farmaciaId } : {};

  // Obter vendas agregadas por produto
  const vendasPorProduto = await prisma.venda.groupBy({
    by: ['cnp_codigo'],
    where: whereFarmacia,
    _sum: { quantidade: true, valor_total: true },
  });

  const vendasMap = new Map<string, { qtd: number; valor: number }>();
  for (const v of vendasPorProduto) {
    vendasMap.set(v.cnp_codigo, {
      qtd: v._sum.quantidade || 0,
      valor: Number(v._sum.valor_total || 0),
    });
  }

  // Obter inventário agregado por produto
  const inventarios = await prisma.inventario.findMany({
    where: whereFarmacia,
    select: {
      cnp_codigo: true,
      quantidade: true,
      custo_unitario: true,
    },
  });

  const stockMap = new Map<string, { qtd: number; valor: number }>();
  for (const inv of inventarios) {
    const cur = stockMap.get(inv.cnp_codigo) || { qtd: 0, valor: 0 };
    cur.qtd += inv.quantidade || 0;
    cur.valor += Number(inv.quantidade || 0) * Number(inv.custo_unitario || 0);
    stockMap.set(inv.cnp_codigo, cur);
  }

  // Obter produtos e laboratórios titulares
  const produtos = await prisma.produtoMestre.findMany({
    select: {
      cnp_codigo: true,
      laboratorio_titular: true,
      margem_padrao: true,
    },
  });

  const labsMap = new Map<string, {
    artigos: number;
    faturacao: number;
    unidades: number;
    margens: number[];
    stockQtd: number;
    stockValor: number;
  }>();

  for (const p of produtos) {
    const labNome = (p.laboratorio_titular || 'Outros / Sem Titular').trim();
    if (!labsMap.has(labNome)) {
      labsMap.set(labNome, {
        artigos: 0,
        faturacao: 0,
        unidades: 0,
        margens: [],
        stockQtd: 0,
        stockValor: 0,
      });
    }

    const labData = labsMap.get(labNome)!;
    labData.artigos++;

    const v = vendasMap.get(p.cnp_codigo);
    if (v) {
      labData.unidades += v.qtd;
      labData.faturacao += v.valor;
    }

    const s = stockMap.get(p.cnp_codigo);
    if (s) {
      labData.stockQtd += s.qtd;
      labData.stockValor += s.valor;
    }

    if (p.margem_padrao !== null && p.margem_padrao !== undefined) {
      labData.margens.push(Number(p.margem_padrao));
    }
  }

  const result: LabSummaryItem[] = [];
  for (const [lab, d] of labsMap.entries()) {
    if (d.unidades === 0 && d.stockQtd === 0) continue; // Ignora laboratórios sem qualquer movimento

    const mgMedia = d.margens.length > 0
      ? d.margens.reduce((a, b) => a + b, 0) / d.margens.length
      : 28.5;

    result.push({
      laboratorio: lab,
      totalArtigos: d.artigos,
      faturacaoAcumulada: Number(d.faturacao.toFixed(2)),
      unidadesVendidas: d.unidades,
      margemMediaPct: Number(mgMedia.toFixed(1)),
      valorStockAtual: Number(d.stockValor.toFixed(2)),
      unidadesStockAtual: d.stockQtd,
    });
  }

  // Ordenar por maior faturação acumulada
  return result.sort((a, b) => b.faturacaoAcumulada - a.faturacaoAcumulada);
}

/**
 * Consulta e Análise Histórica Filtrada por Códigos AIM Específicos
 * Suporta múltiplos códigos AIM passados como string separada por vírgulas ou array (ex: "320, 2121, 6581")
 */
export async function getHistoricalAimAnalytics(
  prisma: PrismaClient,
  aimQuery: string | string[],
  farmaciaId?: string
): Promise<{
  aimsPesquisados: string[];
  totalProdutos: number;
  faturacaoTotalAimEur: number;
  unidadesTotaisAim: number;
  produtos: AimHistoricalItem[];
}> {
  let aimsList: string[] = [];
  if (Array.isArray(aimQuery)) {
    aimsList = aimQuery.map(a => String(a).trim()).filter(Boolean);
  } else {
    aimsList = String(aimQuery || '')
      .split(/[,\s;]+/)
      .map(a => a.trim())
      .filter(Boolean);
  }

  if (aimsList.length === 0) {
    return {
      aimsPesquisados: [],
      totalProdutos: 0,
      faturacaoTotalAimEur: 0,
      unidadesTotaisAim: 0,
      produtos: [],
    };
  }

  // Procurar produtos que correspondam aos AIMs
  const produtos = await prisma.produtoMestre.findMany({
    where: {
      aim: { in: aimsList },
    },
  });

  const cnpList = produtos.map(p => p.cnp_codigo);
  const whereFarmacia = farmaciaId ? { farmaciaId } : {};

  // Buscar vendas detalhadas desses produtos
  const vendas = await prisma.venda.findMany({
    where: {
      ...whereFarmacia,
      cnp_codigo: { in: cnpList },
    },
    orderBy: { data_venda: 'asc' },
  });

  // Buscar stock desses produtos
  const stocks = await prisma.inventario.findMany({
    where: {
      ...whereFarmacia,
      cnp_codigo: { in: cnpList },
    },
  });

  const stockMap = new Map<string, { qtd: number; custo: number }>();
  for (const s of stocks) {
    const cur = stockMap.get(s.cnp_codigo) || { qtd: 0, custo: Number(s.custo_unitario || 0) };
    cur.qtd += s.quantidade || 0;
    stockMap.set(s.cnp_codigo, cur);
  }

  let faturacaoTotal = 0;
  let unidadesTotais = 0;

  const produtosResult: AimHistoricalItem[] = produtos.map(prod => {
    const prodVendas = vendas.filter(v => v.cnp_codigo === prod.cnp_codigo);
    let totalQtd = 0;
    let totalValor = 0;

    // Agrupar histórico por mês (YYYY-MM)
    const mesesMap = new Map<string, { qtd: number; valor: number }>();
    for (const v of prodVendas) {
      const mesStr = v.data_venda.toISOString().slice(0, 7);
      const cur = mesesMap.get(mesStr) || { qtd: 0, valor: 0 };
      cur.qtd += v.quantidade || 0;
      cur.valor += Number(v.valor_total || 0);
      mesesMap.set(mesStr, cur);

      totalQtd += v.quantidade || 0;
      totalValor += Number(v.valor_total || 0);
    }

    faturacaoTotal += totalValor;
    unidadesTotais += totalQtd;

    const histList = Array.from(mesesMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mes, val]) => ({
        mes,
        quantidade: val.qtd,
        valor: Number(val.valor.toFixed(2)),
      }));

    const st = stockMap.get(prod.cnp_codigo) || { qtd: 0, custo: 0 };

    return {
      aim: prod.aim || '',
      cnp_codigo: prod.cnp_codigo,
      designacao: prod.designacao,
      laboratorio: prod.laboratorio_titular,
      categoria: prod.categoria,
      stock_atual: st.qtd,
      custo_unitario: st.custo,
      pvp: prod.pvp ? Number(prod.pvp) : null,
      margem_estimada_pct: prod.margem_padrao ? Number(prod.margem_padrao) : 28.5,
      vendasTotaisQtd: totalQtd,
      vendasTotaisEur: Number(totalValor.toFixed(2)),
      historicoMensal: histList,
    };
  });

  return {
    aimsPesquisados: aimsList,
    totalProdutos: produtosResult.length,
    faturacaoTotalAimEur: Number(faturacaoTotal.toFixed(2)),
    unidadesTotaisAim: unidadesTotais,
    produtos: produtosResult.sort((a, b) => b.vendasTotaisEur - a.vendasTotaisEur),
  };
}
