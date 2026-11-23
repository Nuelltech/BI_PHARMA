import { PrismaClient } from '@prisma/client';
import { getPharmacyCatalog, CatalogItem, getSmartCrossSelling } from './product_catalog.js';
import { getDiscontinuedCnps } from './discontinued_products.js';

// ============================================================================
// FERRAMENTAS ANALÍTICAS FARMACÊUTICAS MULTI-TENANT (MCP & COPILOT)
// ----------------------------------------------------------------------------
// Todas as funções exigem OBRIGATORIAMENTE um farmaciaId validado.
// Nenhuma consulta é executada sem a restrição rigorosa ao tenant autenticado.
// ============================================================================

export interface ToolSecurityContext {
  farmaciaId: string;
  farmaciaNome: string;
  nif: string;
  perfil?: string;
  permissions?: Set<string> | string[];
  verFaturacao?: boolean;
}

/**
 * 1. Calcular Stock Mínimo e Cobertura (ex: para 1 semana ou X dias)
 */
export async function toolCalcularStockMinimoECobertura(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { dias_cobertura_desejados?: number; apenas_abaixo_minimo?: boolean; limite?: number; termo_pesquisa?: string }
) {
  const dias = args.dias_cobertura_desejados || 7; // Default 1 semana
  const apenasAbaixo = args.apenas_abaixo_minimo ?? false;
  const limite = Math.min(args.limite || 20, 25); // Limite rígido para manter payload < 5KB
  const termo = (args.termo_pesquisa || '').trim().toLowerCase();

  // 1. Otimização Fase 4: Leitura direta do Mart pré-agregado com latência < 5ms
  const martCount = await prisma.martProdutoMetricas.count({ where: { farmaciaId: ctx.farmaciaId } });
  if (martCount > 0) {
    const whereClause: any = {
      farmaciaId: ctx.farmaciaId,
    };
    if (termo) {
      whereClause.OR = [
        { cnp_codigo: { contains: termo } },
        { designacao: { contains: termo, mode: 'insensitive' } },
      ];
    }
    if (apenasAbaixo) {
      whereClause.eh_risco_rutura = true;
    }

    const martItems = await prisma.martProdutoMetricas.findMany({
      where: whereClause,
      take: limite,
      orderBy: { stock_total_valor_custo: 'desc' },
    });

    const itensMarts = martItems.map((m) => {
      const vmm = Number(m.vmm);
      const vendaDiaria = vmm / 30.0;
      const stockMinimo = vmm > 0 ? Math.max(1, Math.ceil(vendaDiaria * dias * 1.2)) : 0;
      const stockAtual = m.stock_total_unidades;
      const diasCobertura = Number(m.cobertura_meses) * 30;

      return {
        cnp: m.cnp_codigo,
        designacao: m.designacao,
        segmento: m.tipo_venda || 'OUTRO',
        stockAtual,
        vendasAnoUnidades: m.total_unidades_vendidas,
        vmm,
        stockMinimoNecessarioParaDias: stockMinimo,
        deficitUnidades: stockMinimo > stockAtual ? stockMinimo - stockAtual : 0,
        diasCoberturaAtual: Math.round(diasCobertura),
        situacao: stockAtual === 0 ? 'RUPTURA_TOTAL' : stockAtual < stockMinimo ? 'ABAIXO_DO_MINIMO' : 'NORMAL_OU_EXCESSO',
        custoUnitario: Number(m.custo_unitario_medio),
        valorTotalStock: Number(m.stock_total_valor_custo),
      };
    });

    const criticos = itensMarts.filter((i) => i.situacao !== 'NORMAL_OU_EXCESSO');
    return {
      diasCoberturaSolicitados: dias,
      totalArtigosAnalisados: itensMarts.length,
      artigosAbaixoMinimoCount: criticos.length,
      capitalNecessarioParaMinimosEur: Number(
        criticos.reduce((s, i) => s + i.deficitUnidades * i.custoUnitario, 0).toFixed(2)
      ),
      itens: itensMarts,
      fonteDados: 'MART_PRODUTO_METRICAS_PRE_COMPUTADO',
    };
  }

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);

  // Calcula para cada artigo com vendas ou stock
  let itens = catalog
    .filter((item) => {
      // Se não houver termo de pesquisa específico, exclui consumíveis de loja e bebidas
      if (!termo) {
        const cleanDes = stripAccents(item.designacao).toLowerCase();
        if (
          ((cleanDes.includes('saco plast') || cleanDes.includes('saco papel') || cleanDes.includes('sacola')) &&
            !cleanDes.includes('gelo') &&
            !cleanDes.includes('quente') &&
            !cleanDes.includes('colost') &&
            !cleanDes.includes('coletor')) ||
          cleanDes.includes('healsi') ||
          cleanDes.includes('agua nascente') ||
          cleanDes.includes('mascara cirurgica') ||
          cleanDes.includes('mascara cir')
        ) {
          return false;
        }
      }
      return true;
    })
    .map((item) => {
      const vmm = (item.vendasQtd || 0) / 12.0;
      const vendaDiaria = vmm / 30.0;
      // Stock mínimo para X dias + 20% de margem de segurança (mínimo 1 unidade se tiver vendas)
      const stockMinimoNecessario = vmm > 0 ? Math.max(1, Math.ceil(vendaDiaria * dias * 1.2)) : 0;
      const stockAtual = item.stock || 0;
      const deficit = stockMinimoNecessario - stockAtual;
      const diasCoberturaAtual = vendaDiaria > 0 ? Math.round(stockAtual / vendaDiaria) : (stockAtual > 0 ? 999 : 0);

      return {
        cnp: item.cnp,
        designacao: item.designacao,
        segmento: item.tipoVenda,
        stockAtual,
        vendasAnoUnidades: item.vendasQtd,
        vmm: Number(vmm.toFixed(1)),
        stockMinimoSugerido: stockMinimoNecessario,
        deficitUnidades: deficit > 0 ? deficit : 0,
        excessoUnidades: deficit < 0 ? Math.abs(deficit) : 0,
        diasCoberturaAtual,
        situacao:
          stockAtual < stockMinimoNecessario
            ? '🚨 ABAIXO_MINIMO (Risco de Rutura)'
            : stockAtual > stockMinimoNecessario * 3 && stockAtual >= 3
            ? '⚠️ EXCESSO (Capital Empatado)'
            : '✅ EQUILIBRADO',
        custoUnitarioEur: item.custo,
        pvpEur: Number(item.pvp.toFixed(2)),
      };
    })
    .filter((i) => i.stockAtual > 0 || i.vmm > 0);

  if (termo) {
    const cleanT = stripAccents(termo);
    itens = itens.filter((i) => stripAccents(i.designacao).includes(cleanT) || i.cnp.includes(cleanT));
  }

  const filtrados = apenasAbaixo ? itens.filter((i) => i.deficitUnidades > 0) : itens;

  // Ordena por maior défice (urgência de encomenda) ou maior excesso
  filtrados.sort((a, b) => b.deficitUnidades - a.deficitUnidades);

  const artigosAbaixoMinimo = itens.filter((i) => i.deficitUnidades > 0);
  const artigosExcesso = itens.filter((i) => i.excessoUnidades > 0 && i.stockAtual >= 3);

  return {
    farmacia: 'Farmácia Comunitária',
    periodoCalculadoDias: dias,
    resumoGeral: {
      totalArtigosAnalisados: itens.length,
      artigosAbaixoDoMinimo: artigosAbaixoMinimo.length,
      unidadesEmFaltaParaEncomedar: artigosAbaixoMinimo.reduce((s, i) => s + i.deficitUnidades, 0),
      artigosComExcesso: artigosExcesso.length,
    },
    produtos: filtrados.slice(0, limite),
  };
}

function parseReferenceMonth(input?: string): { date: Date; label: string } | null {
  if (!input) return null;
  const s = input.toLowerCase().trim();
  const yearMatch = s.match(/20\d\d/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : 2026;

  const monthNames = [
    { key: 'jan', num: 1, label: 'Janeiro' },
    { key: 'fev', num: 2, label: 'Fevereiro' },
    { key: 'mar', num: 3, label: 'Março' },
    { key: 'abr', num: 4, label: 'Abril' },
    { key: 'mai', num: 5, label: 'Maio' },
    { key: 'jun', num: 6, label: 'Junho' },
    { key: 'jul', num: 7, label: 'Julho' },
    { key: 'ago', num: 8, label: 'Agosto' },
    { key: 'set', num: 9, label: 'Setembro' },
    { key: 'out', num: 10, label: 'Outubro' },
    { key: 'nov', num: 11, label: 'Novembro' },
    { key: 'dez', num: 12, label: 'Dezembro' },
  ];

  for (const m of monthNames) {
    if (s.includes(m.key) || s.includes(`-${String(m.num).padStart(2, '0')}`)) {
      const d = new Date(Date.UTC(year, m.num, 0, 23, 59, 59));
      return { date: d, label: `${m.label} ${year}` };
    }
  }
  return null;
}

/**
 * 4. Identificar Produtos Sem Vendas (ex: 6 meses) com Estratégia de Escoamento
 */
export async function toolIdentificarProdutosSemVenda(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    meses_sem_venda?: number;
    apenas_com_stock?: boolean;
    limite?: number;
    apenas_restos_gaveta?: boolean;
    mes_referencia?: string;
  }
) {
  const meses = args.meses_sem_venda || 3;
  const apenasComStock = args.apenas_com_stock ?? true;
  const apenasRestosGaveta = args.apenas_restos_gaveta ?? false;
  const limite = Math.min(args.limite || 20, 25); // Limite rígido para manter payload < 5KB

  const parsedRef = parseReferenceMonth(args.mes_referencia);

  // Se o utilizador pediu um mês histórico específico no passado (ex: Setembro 2026, Agosto 2026):
  if (parsedRef && parsedRef.date < new Date('2026-10-25T00:00:00Z')) {
    const dataReferencia = parsedRef.date;
    const dias = meses * 30;
    const dataCorte = new Date(dataReferencia.getTime() - dias * 24 * 60 * 60 * 1000);

    const activeSales = await prisma.venda.groupBy({
      by: ['cnp_codigo'],
      where: {
        farmaciaId: ctx.farmaciaId,
        data_venda: { gte: dataCorte, lte: dataReferencia },
        quantidade: { gt: 0 },
      },
    });
    const activeSet = new Set(activeSales.map((s) => s.cnp_codigo));

    const inventarios = await prisma.inventario.findMany({
      where: {
        farmaciaId: ctx.farmaciaId,
        ...(apenasComStock ? { quantidade: { gt: 0 } } : {}),
      },
      include: { produto: true },
    });

    // Vendas posteriores (para saber se o produto foi reativado/vendido depois)
    const salesAfter = await prisma.venda.groupBy({
      by: ['cnp_codigo'],
      where: {
        farmaciaId: ctx.farmaciaId,
        data_venda: { gt: dataReferencia },
        quantidade: { gt: 0 },
      },
      _sum: { quantidade: true, valor_total: true },
    });
    const afterMap = new Map(salesAfter.map((s) => [s.cnp_codigo, { qtd: Number(s._sum.quantidade || 0), val: Number(s._sum.valor_total || 0) }]));

    let monos = inventarios.filter((i) => !activeSet.has(i.cnp_codigo));
    if (apenasRestosGaveta) {
      monos = monos.filter((i) => i.quantidade <= 2);
    }

    const totalArtigosIdentificados = monos.length;
    const totalUnidadesParadas = monos.reduce((s, i) => s + i.quantidade, 0);
    const capitalTotalImobilizadoEur = Number(monos.reduce((s, i) => s + i.quantidade * Number(i.custo_unitario || 0), 0).toFixed(2));

    monos.sort((a, b) => (b.quantidade * Number(b.custo_unitario || 0)) - (a.quantidade * Number(a.custo_unitario || 0)));

    let reativadosCount = 0;
    let liquidezRecuperadaPosteriormenteTotalEur = 0;

    const itens = monos.slice(0, limite).map((m) => {
      const custo = Number(m.custo_unitario || 0);
      const post = afterMap.get(m.cnp_codigo);
      const reativado = !!post && post.qtd > 0;
      if (reativado) {
        reativadosCount++;
        liquidezRecuperadaPosteriormenteTotalEur += post.qtd * custo;
      }
      return {
        cnp: m.cnp_codigo,
        designacao: m.produto?.designacao || m.cnp_codigo,
        segmento: m.produto?.tipo_venda || 'OUTRO',
        stockNaData: m.quantidade,
        custoUnitarioEur: custo,
        capitalImobilizadoEur: Number((m.quantidade * custo).toFixed(2)),
        mesesSemVendaEstimados: meses,
        reativadoNoMesSeguinte: reativado,
        unidadesVendidasPosteriormente: post ? post.qtd : 0,
        liquidezRecuperadaPosteriormenteEur: post ? Number((post.qtd * custo).toFixed(2)) : 0,
        estrategiaSugerida: m.quantidade <= 2 ? 'DEVOLUCAO_FORNECEDOR_OU_TRANSFERENCIA' : 'PACK_PROMOCIONAL_OU_CAMPANHA',
      };
    });

    return {
      periodoReferencia: parsedRef.label,
      dataReferencia: dataReferencia.toISOString().slice(0, 10),
      janelaInatividadeDias: dias,
      criterioMesesSemVenda: meses,
      totalArtigosIdentificados,
      totalUnidadesParadas,
      capitalTotalImobilizadoEur,
      artigosReativadosPosteriormente: reativadosCount,
      liquidezRecuperadaPosteriormenteTotalEur: Number(liquidezRecuperadaPosteriormenteTotalEur.toFixed(2)),
      itens,
      fonteDados: 'AUDITORIA_HISTORICA_RETROSPETIVA_VENDAS_STOCK',
    };
  }

  // 1. Otimização Fase 4: Leitura direta do Mart analítico pré-agregado (< 5ms)
  const martCount = await prisma.martProdutoMetricas.count({ where: { farmaciaId: ctx.farmaciaId } });
  if (martCount > 0) {
    const whereClause: any = {
      farmaciaId: ctx.farmaciaId,
      eh_mono: true,
    };
    if (apenasComStock) {
      whereClause.stock_total_unidades = { gt: 0 };
    }
    if (apenasRestosGaveta) {
      whereClause.stock_total_unidades = { in: [1, 2] };
    }

    const monosMarts = await prisma.martProdutoMetricas.findMany({
      where: whereClause,
      take: limite,
      orderBy: { stock_total_valor_custo: 'desc' },
    });

    const itens = monosMarts.map((m) => ({
      cnp: m.cnp_codigo,
      designacao: m.designacao,
      segmento: m.tipo_venda || 'OUTRO',
      stockAtual: m.stock_total_unidades,
      custoUnitarioEur: Number(m.custo_unitario_medio),
      capitalImobilizadoEur: Number(m.stock_total_valor_custo),
      dataUltimaVenda: m.data_ultima_venda ? m.data_ultima_venda.toISOString().slice(0, 10) : 'Sem vendas registadas',
      mesesSemVendaEstimados: m.dias_sem_vendas ? Math.round(m.dias_sem_vendas / 30) : 12,
      estrategiaSugerida: m.stock_total_unidades <= 2 ? 'DEVOLUCAO_FORNECEDOR_OU_TRANSFERENCIA' : 'PACK_PROMOCIONAL_OU_CAMPANHA',
    }));

    const capitalTotal = Number(itens.reduce((s, i) => s + i.capitalImobilizadoEur, 0).toFixed(2));
    return {
      criterioMesesSemVenda: meses,
      totalArtigosIdentificados: itens.length,
      capitalTotalImobilizadoEur: capitalTotal,
      itens,
      fonteDados: 'MART_PRODUTO_METRICAS_PRE_COMPUTADO',
    };
  }

  // Em Tempo Real: ancorado na data atual
  const dataReferencia = new Date();
  const dataCorte = new Date(dataReferencia.getTime() - meses * 30 * 24 * 60 * 60 * 1000);

  // Produtos que têm stock nesta farmácia
  const inventarios = await prisma.inventario.findMany({
    where: {
      farmaciaId: ctx.farmaciaId,
      ...(apenasComStock ? { quantidade: { gt: 0 } } : {}),
    },
    include: {
      produto: true,
    },
  });

  // Agrupa inventário por CNP
  const stockMap = new Map<string, { produto: any; qtd: number; custo: number }>();
  for (const inv of inventarios) {
    const existing = stockMap.get(inv.cnp_codigo) || {
      produto: inv.produto,
      qtd: 0,
      custo: Number(inv.custo_unitario || 0),
    };
    existing.qtd += inv.quantidade;
    stockMap.set(inv.cnp_codigo, existing);
  }

  // Busca vendas para identificar data da última venda e deduplicação MENSAL vs DIARIO
  const vendas = await prisma.venda.findMany({
    where: { farmaciaId: ctx.farmaciaId },
    orderBy: { data_venda: 'asc' },
  });

  let dataUltimaVenda: Date | null = null;
  const monthlyKeySet = new Set<string>();
  for (const v of vendas) {
    if (!dataUltimaVenda || v.data_venda > dataUltimaVenda) {
      dataUltimaVenda = v.data_venda;
    }
    if ((v as any).granularidade === 'MENSAL') {
      const k = `${v.cnp_codigo}_${v.data_venda.getUTCFullYear()}-${String(v.data_venda.getUTCMonth() + 1).padStart(2, '0')}`;
      monthlyKeySet.add(k);
    }
  }

  const cnpsComVendas = new Set<string>();
  for (const v of vendas) {
    const k = `${v.cnp_codigo}_${v.data_venda.getUTCFullYear()}-${String(v.data_venda.getUTCMonth() + 1).padStart(2, '0')}`;
    if ((v as any).granularidade === 'DIARIO' && monthlyKeySet.has(k)) continue;
    if (v.data_venda >= dataCorte && v.data_venda <= dataReferencia && v.quantidade > 0) {
      cnpsComVendas.add(v.cnp_codigo);
    }
  }

  const produtosParados = [];

  for (const [cnp, data] of stockMap.entries()) {
    if (cnpsComVendas.has(cnp)) continue; // Teve vendas nos últimos X meses

    const prod = data.produto;
    const isMsrm = prod.tipo_venda === 'MSRM' || prod.tipo_venda === 'MSRM_GENERICO';
    const isGenerico = prod.tipo_venda === 'GENERICO_MG' || prod.tipo_venda === 'MSRM_GENERICO';
    const ehRestoGaveta = data.qtd <= 2;

    let estrategiaSugerida = '';
    if (ehRestoGaveta) {
      estrategiaSugerida = '🧺 RESTO DE GAVETA (≤2 un): Colocar no cesto de balcão ou dispensar prioritariamente na receita médica para eliminar o código e libertar espaço de gaveta.';
    } else if (isGenerico) {
      estrategiaSugerida = '🧬 MONO PROFUNDO (GENÉRICO): Priorizar a dispensa deste laboratório na gaveta de genéricos ao balcão e colocar Ponto de Encomenda = 0 no sistema de gestão para outros laboratórios.';
    } else if (isMsrm) {
      estrategiaSugerida = '🏷️ MONO PROFUNDO (MSRM): Colocar etiqueta de destaque na gaveta física para dispensar na próxima receita médica ou avaliar devolução comercial ao armazenista.';
    } else {
      estrategiaSugerida = '📦 MONO PROFUNDO (VENDA LIVRE): Criar pack promocional ou destaque de balcão com desconto de 15-20% para destravar o capital empatado.';
    }

    produtosParados.push({
      cnp,
      designacao: prod.designacao,
      laboratorio: prod.laboratorio_titular || 'Não especificado',
      stockAtual: data.qtd,
      custoUnitarioEur: Number(data.custo.toFixed(2)),
      capitalImobilizadoEur: Number((data.qtd * data.custo).toFixed(2)),
      tipoVenda: prod.tipo_venda || 'OUTRO',
      ehRestoGaveta,
      tipoClassificacao: ehRestoGaveta ? 'Resto de Gaveta (≤ 2 un)' : 'Mono com Profundidade (≥ 3 un)',
      mesesSemVenda: meses,
      estrategiaDispensa: estrategiaSugerida,
    });
  }

  produtosParados.sort((a, b) => b.capitalImobilizadoEur - a.capitalImobilizadoEur);

  const todosRestos = produtosParados.filter((p) => p.ehRestoGaveta);
  const todosProfundos = produtosParados.filter((p) => !p.ehRestoGaveta);

  const listaFiltrada = apenasRestosGaveta ? todosRestos : produtosParados;

  return {
    farmacia: 'Farmácia Comunitária',
    modoTempoReal: true,
    dataReferencia: dataReferencia.toISOString().slice(0, 10),
    dataUltimaVendaRegistada: dataUltimaVenda ? dataUltimaVenda.toISOString().slice(0, 10) : null,
    mesesSemVendas: meses,
    filtroAplicado: apenasRestosGaveta ? 'Restos de Gaveta (Stock ≤ 2 unidades)' : 'Todos os Monos Parados',
    totalArtigosSemVenda: listaFiltrada.length,
    capitalTotalImobilizadoEur: Number(
      listaFiltrada.reduce((s, p) => s + p.capitalImobilizadoEur, 0).toFixed(2)
    ),
    subdivisaoMonos: {
      restosGaveta: {
        descricao: 'Artigos órfãos com stock ≤ 2 unidades a limpar',
        skus: todosRestos.length,
        capitalImobilizadoEur: Number(
          todosRestos.reduce((s, p) => s + p.capitalImobilizadoEur, 0).toFixed(2)
        ),
      },
      monosProfundidade: {
        descricao: 'Artigos parados com stock ≥ 3 unidades para packs/devolução',
        skus: todosProfundos.length,
        capitalImobilizadoEur: Number(
          todosProfundos.reduce((s, p) => s + p.capitalImobilizadoEur, 0).toFixed(2)
        ),
      },
      totalGeralMonos: {
        skus: produtosParados.length,
        capitalImobilizadoEur: Number(
          produtosParados.reduce((s, p) => s + p.capitalImobilizadoEur, 0).toFixed(2)
        ),
      },
    },
    produtos: listaFiltrada.slice(0, Math.min(limite, 10)).map((p) => ({
      cnp: p.cnp,
      designacao: p.designacao,
      stockAtual: p.stockAtual,
      capitalImobilizadoEur: p.capitalImobilizadoEur,
      tipoVenda: p.tipoVenda,
      classificacao: p.tipoClassificacao,
      estrategia: p.ehRestoGaveta ? 'RESTO_GAVETA' : 'MONO_PROFUNDO',
    })),
  };
}

/**
 * 5. Consolidar Laboratórios de Genéricos por Molécula (DCI) e Limites Infarmed
 */
export async function toolConsolidarGenericosDci(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { molecula_dci?: string; max_labs_desejados?: number; limite?: number }
) {
  const maxLabs = args.max_labs_desejados || 2;
  const limite = Math.min(args.limite || 5, 8); // Limite rígido para manter payload < 5KB

  // 1. Otimização Fase 4: Leitura direta da tabela MartDciGrupo pré-agregada (< 5ms)
  const dciCount = await prisma.martDciGrupo.count({ where: { farmaciaId: ctx.farmaciaId } });
  if (dciCount > 0) {
    const whereClause: any = { farmaciaId: ctx.farmaciaId };
    if (args.molecula_dci) {
      whereClause.grupo_equivalencia_dci = { contains: args.molecula_dci.trim(), mode: 'insensitive' };
    }

    const dciRows = await prisma.martDciGrupo.findMany({
      where: whereClause,
      take: limite,
      orderBy: { poupanca_potencial_anual: 'desc' },
    });

    const grupos = dciRows.map((g) => ({
      moleculaDci: g.grupo_equivalencia_dci,
      laboratoriosAtuaisCount: g.num_laboratorios_abertos,
      maxLaboratoriosPermitidos: maxLabs,
      stockTotalUnidades: g.stock_total_unidades,
      capitalTotalStockEur: Number(g.stock_total_valor_custo),
      vmmTotalGrupo: Number(g.vmm_total_grupo),
      custoMinimoEur: Number(g.custo_minimo),
      custoMaximoEur: Number(g.custo_maximo),
      poupancaPotencialAnualEur: Number(g.poupanca_potencial_anual),
      laboratorios: Array.isArray(g.labsJson)
        ? (g.labsJson as any[]).slice(0, 4).map((lab: any) => ({
            nome: lab.laboratorio || lab.nome || 'Lab',
            stock: lab.stockTotal || lab.stock || 0,
            custo: Number((lab.custoMedio || lab.custo || 0).toFixed(2)),
          }))
        : [],
    }));

    return {
      farmaciaId: ctx.farmaciaId,
      totalGruposAnalisados: grupos.length,
      gruposComDispersaoElevada: grupos.filter((g) => g.laboratoriosAtuaisCount > maxLabs).length,
      poupancaTotalGrupoAnualEur: Number(
        grupos.reduce((s, g) => s + g.poupancaPotencialAnualEur, 0).toFixed(2)
      ),
      grupos,
      fonteDados: 'MART_DCI_GRUPO_PRE_COMPUTADO',
    };
  }

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const genericos = catalog.filter(
    (c) => (c.ehGenerico || c.moleculaDci) && c.moleculaDci && c.moleculaDci.trim() !== ''
  );

  // Agrupa por DCI
  const dciMap = new Map<string, CatalogItem[]>();
  for (const g of genericos) {
    const key = (g.moleculaDci || '').trim().toUpperCase();
    if (!key) continue;
    const list = dciMap.get(key) || [];
    list.push(g);
    dciMap.set(key, list);
  }

  const grupos = [];

  for (const [molecula, prods] of dciMap.entries()) {
    if (args.molecula_dci && !molecula.includes(args.molecula_dci.trim().toUpperCase())) {
      continue;
    }

    const stockTotal = prods.reduce((s, p) => s + p.stock, 0);
    const capitalTotal = prods.reduce((s, p) => s + p.stock * p.custo, 0);

    grupos.push({
      moleculaDci: molecula,
      totalArtigosDci: prods.length,
      maxLaboratoriosPermitidos: maxLabs,
      stockTotalUnidades: stockTotal,
      capitalTotalStockEur: Number(capitalTotal.toFixed(2)),
      artigos: prods.map((p) => ({
        cnp: p.cnp,
        designacao: p.designacao,
        stock: p.stock,
        custo: p.custo,
        pvp: p.pvp,
        vendasAno: p.vendasQtd,
      })),
    });
  }

  grupos.sort((a, b) => b.totalArtigosDci - a.totalArtigosDci);

  return {
    farmacia: 'Farmácia Comunitária',
    totalMoleculasAnalisadas: grupos.length,
    grupos: grupos.slice(0, limite),
  };
}

/**
 * 6. Planear Compras Sazonais a Laboratórios (Plano Anual e Datas de Entrega)
 */
export async function toolPlanearComprasSazonais(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { tipo_venda?: string; ano_referencia?: number }
) {
  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);

  // Mapeamento de épocas sazonais portuguesas e calendários de negociação com laboratórios
  const epocas = [
    {
      epoca: 'Primavera (Alergias & Rinite)',
      mesesPico: 'Março a Maio',
      dataEncomendaSugerida: '15 de Fevereiro',
      dataEntregaIdeal: '1 a 5 de Março',
      termos: ['alerg', 'anti-histaminico', 'cetirizina', 'loratadina', 'spray nasal', 'agua mar', 'colirio'],
      justificacao: 'Garantir condições comerciais diretas e descontos de escala antes do pico polínico de Março.',
    },
    {
      epoca: 'Verão (Fotoproteção SPF50+ & Repelentes)',
      mesesPico: 'Maio a Agosto',
      dataEncomendaSugerida: '15 a 30 de Março (Pré-Campanhas de Laboratório)',
      dataEntregaIdeal: '20 de Abril a 2 de Maio',
      termos: ['solar', 'spf', 'protetor', 'pos-solar', 'repelente', 'citronela', 'picada'],
      justificacao: 'As marcas de dermocosmética dão as maiores margens nas encomendas antecipadas de Março/Abril.',
    },
    {
      epoca: 'Regresso às Aulas & Queda de Cabelo (Outono)',
      mesesPico: 'Setembro a Outubro',
      dataEncomendaSugerida: '15 a 25 de Julho',
      dataEntregaIdeal: '25 a 31 de Agosto',
      termos: ['piolhos', 'queda cabelo', 'antiqueda', 'cistina', 'biotina', 'memoria', 'cerebr'],
      justificacao: 'Ter o expositor montado na 1ª semana de Setembro quando os pais preparam o ano letivo.',
    },
    {
      epoca: 'Inverno (Gripe, Imunidade, Tosse & Garganta)',
      mesesPico: 'Novembro a Fevereiro',
      dataEncomendaSugerida: '15 a 30 de Setembro',
      dataEntregaIdeal: '15 a 20 de Outubro (Início da Vacinação da Gripe)',
      termos: ['gripe', 'tosse', 'garganta', 'pastilhas', 'vitamina c', 'zinco', 'propolis', 'equinacea', 'descongest'],
      justificacao: 'Aproveitar a afluência de utentes à vacinação da gripe para venda por impulso.',
    },
  ];

  const plano = epocas.map((ep) => {
    // Procura artigos em stock ou com vendas correspondentes
    const prods = catalog.filter((c) => {
      const nomeLower = c.designacao.toLowerCase();
      return ep.termos.some((t) => nomeLower.includes(t));
    });

    const vendasTotais = prods.reduce((s, p) => s + (p.vendasQtd || 0), 0);
    const stockAtual = prods.reduce((s, p) => s + p.stock, 0);
    const previsaoNecessidade = Math.round(vendasTotais * 0.4); // ~40% do volume anual concentrado na época
    const quantidadeSugeridaEncomenda = Math.max(0, previsaoNecessidade - stockAtual);

    return {
      epoca: ep.epoca,
      mesesPico: ep.mesesPico,
      periodoPlaneamentoSugerido: ep.dataEncomendaSugerida,
      periodoEntregaSugerido: ep.dataEntregaIdeal,
      justificacaoComercial: ep.justificacao,
      historicoVendasAnoUnidades: vendasTotais,
      stockAtualFarmacia: stockAtual,
      quantidadeSugeridaComprarDireto: quantidadeSugeridaEncomenda,
      artigosExemplo: prods.slice(0, 5).map((p) => ({ cnp: p.cnp, designacao: p.designacao, stock: p.stock, vendas12m: p.vendasQtd })),
    };
  });

  return {
    farmacia: 'Farmácia Comunitária',
    planoAnualCompras: plano,
    avisoLogistica: 'Os prazos de entrega e condições comerciais dependem do acordo específico da farmácia com o seu armazenista ou laboratório. O BI Pharma não possui dados de lead times contratuais de fornecedores.',
  };
}

/**
 * 7. Sugerir Vendas Cruzadas para Moléculas de Receita Mais Vendidas
 */
export async function toolSugerirVendasCruzadasReceita(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { top_n_moleculas?: number; medicamento?: string }
) {
  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const alvo = stripAccents(args.medicamento || '');

  const msrmProds = catalog
    .filter((c) => {
      if (alvo) return stripAccents(c.designacao + ' ' + (c.moleculaDci || '') + ' ' + (c.dci || '')).includes(alvo);
      return c.tipoVenda === 'MSRM' || c.ehGenerico;
    })
    .sort((a, b) => (b.vendasQtd || 0) - (a.vendasQtd || 0))
    .slice(0, args.top_n_moleculas || 5);

  return {
    farmacia: 'Farmácia Comunitária',
    avisoImportante:
      'O sistema BI Pharma não dispõe de base científica ou farmacológica validada para efetuar aconselhamento clínico, posológico ou recomendações terapêuticas de venda cruzada. Qualquer associação clínica requer avaliação do Diretor Técnico da farmácia.',
    medicamentosConsultados: msrmProds.map((m) => ({
      cnp: m.cnp,
      designacao: m.designacao,
      dci: m.dci || m.moleculaDci || null,
      stockAtual: m.stock,
      vendasAnoUnidades: m.vendasQtd,
    })),
    notaOperacional:
      'Se o Diretor Técnico indicar a categoria ou família de produtos de Venda Livre/MNSRM que pretende consultar (ex: vitaminas, probióticos, dermocosmética), utilize consultar_produtos_por_nome_ou_categoria ou identificar_produtos_sem_vendas_e_escoamento para verificar o stock e os monos dessa categoria.',
  };
}

function stripAccents(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * 8. Consultar Produtos Específicos por Nome, Categoria ou Termo Livre
 * Permite responder a perguntas diretas sobre qualquer artigo (ex: "ben-u-gripe", "cegripe", "brufen")
 * ou família (ex: "antigripais", "preservativos", "vitamina c"), devolvendo stock, vendas, VMM,
 * cobertura atual e parecer direto sobre encomendar ou não.
 */
export async function toolConsultarProdutosPorNomeOuCategoria(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    termo_pesquisa?: string;
    categoria?: string;
    apenas_com_stock?: boolean;
    limite?: number;
  }
) {
  const query = (args.termo_pesquisa || args.categoria || '').trim();
  const limite = args.limite || 20;

  if (!query) {
    return { error: 'Termo de pesquisa ou categoria não fornecido.' };
  }

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const cleanQuery = stripAccents(query);

  const tokens = cleanQuery
    .split(/\s+(?:e|ou|and|com|sem|de|do|da|dos|das|para|por)\s+|[,;/]+|\s+/)
    .map((s) => s.trim().replace(/[^a-z0-9-]/g, ''))
    .filter((s) => s.length >= 3 && !['que', 'mais', 'sobre', 'temos', 'podes', 'dar', 'quais', 'sao'].includes(s));

  const matchesWordOrPrefix = (haystack: string, needle: string): boolean => {
    if (!haystack || !needle) return false;
    // Para termos curtos (<= 5 letras, ex: "bial", "teva", "krka"), exige início de palavra (\b) para que "bial" nunca case com "labial"
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (needle.length <= 5) {
      return new RegExp(`\\b${esc}`, 'i').test(haystack);
    }
    return haystack.includes(needle);
  };

  const scored = catalog
    .map((it) => {
      const des = stripAccents(it.designacao);
      const cat = stripAccents(it.categoria || '');
      const subcat = stripAccents(it.subcategoria || '');
      const dci = stripAccents(it.dci || it.moleculaDci || it.grupoDci || '');
      const lab = stripAccents(it.laboratorioTitular || '');
      const cnp = it.cnp;

      let score = 0;
      if (cnp === cleanQuery) score += 200;
      if (lab && matchesWordOrPrefix(lab, cleanQuery)) score += 120;
      if (matchesWordOrPrefix(des, cleanQuery)) score += 100;

      for (const t of tokens) {
        if (lab && matchesWordOrPrefix(lab, t)) score += 80;
        else if (matchesWordOrPrefix(des, t)) score += 60;
        else if (matchesWordOrPrefix(dci, t)) score += 40;
        else if (matchesWordOrPrefix(subcat, t)) score += 20;
        else if (matchesWordOrPrefix(cat, t)) score += 10;
      }

      // Expansão de sinónimos frequentes em farmácia
      if (
        (cleanQuery.includes('antigrip') || cleanQuery.includes('gripe')) &&
        (des.includes('gripe') || subcat.includes('gripe') || cat.includes('gripe'))
      ) {
        score += 30;
      }

      return { item: it, score };
    })
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || b.item.vendasQtd - a.item.vendasQtd);

  const matched = (args.apenas_com_stock ? scored.filter((s) => s.item.stock > 0) : scored).slice(0, limite);
  const matchedCnps = matched.map((s) => s.item.cnp);

  // Consulta o histórico real de vendas mês a mês para os artigos encontrados
  const vendasRaw = matchedCnps.length > 0 ? await prisma.venda.findMany({
    where: {
      farmaciaId: ctx.farmaciaId,
      cnp_codigo: { in: matchedCnps },
    },
    select: {
      cnp_codigo: true,
      data_venda: true,
      quantidade: true,
      valor_total: true,
    },
    orderBy: { data_venda: 'asc' },
  }) : [];

  const monthlyByCnp = new Map<string, Map<string, { qtd: number; valor: number }>>();
  for (const v of vendasRaw) {
    let cMap = monthlyByCnp.get(v.cnp_codigo);
    if (!cMap) {
      cMap = new Map();
      monthlyByCnp.set(v.cnp_codigo, cMap);
    }
    const mesKey = v.data_venda.toISOString().slice(0, 7);
    const cur = cMap.get(mesKey) || { qtd: 0, valor: 0 };
    cur.qtd += v.quantidade;
    cur.valor += Number(v.valor_total || 0);
    cMap.set(mesKey, cur);
  }

  return {
    farmacia: 'Farmácia Comunitária',
    termoPesquisado: query,
    totalArtigosEncontrados: scored.length,
    artigos: matched.map((s) => {
      const it = s.item;
      const vmm = (it.vendasQtd || 0) / 12.0;
      const vendaDiaria = vmm / 30.0;
      const diasCobertura = vendaDiaria > 0 ? Math.round(it.stock / vendaDiaria) : (it.stock > 0 ? 999 : 0);
      const mesesCobertura = vmm > 0 ? Number((it.stock / vmm).toFixed(1)) : (it.stock > 0 ? 99 : 0);

      const cMap = monthlyByCnp.get(it.cnp) || new Map();
      const historicoVendasMensais: Array<{ mes: string; quantidade: number; valorTotalEur: number }> = [];
      let invernoQtd = 0; // Nov, Dez, Jan, Fev (pico invernal)
      let primaveraQtd = 0; // Mar, Abr, Mai
      let veraoQtd = 0; // Jun, Jul, Ago
      let outonoQtd = 0; // Set, Out

      let maxQtd = -1;
      let mesPico = 'Sem vendas registadas';

      for (const [m, stat] of cMap.entries()) {
        historicoVendasMensais.push({
          mes: m,
          quantidade: stat.qtd,
          valorTotalEur: Number(stat.valor.toFixed(2)),
        });
        if (stat.qtd > maxQtd) {
          maxQtd = stat.qtd;
          mesPico = `${m} (${stat.qtd} un)`;
        }
        const monthNum = parseInt(m.split('-')[1], 10);
        if ([11, 12, 1, 2].includes(monthNum)) {
          invernoQtd += stat.qtd;
        } else if ([3, 4, 5].includes(monthNum)) {
          primaveraQtd += stat.qtd;
        } else if ([6, 7, 8].includes(monthNum)) {
          veraoQtd += stat.qtd;
        } else if ([9, 10].includes(monthNum)) {
          outonoQtd += stat.qtd;
        }
      }

      let recomendacaoEncomenda = '';
      if (it.stock === 0 && it.vendasQtd > 0) {
        recomendacaoEncomenda = '🚨 RUTURA TOTAL (0 un em armazém) - Encomenda urgente necessária.';
      } else if (mesesCobertura >= 3) {
        recomendacaoEncomenda = `⛔ NÃO ENCOMENDAR - STOCK SUFICIENTE (${it.stock} un cobrem ${mesesCobertura} meses / ${diasCobertura} dias). Não imobilizar capital!`;
      } else if (diasCobertura < 14) {
        const sugerido = Math.max(1, Math.ceil(vendaDiaria * 21)); // 3 semanas de cobertura
        recomendacaoEncomenda = `⚠️ ENCOMENDAR REFORÇO (${it.stock} un cobrem apenas ${diasCobertura} dias). Sugerida encomenda de ~${sugerido} unidades.`;
      } else {
        recomendacaoEncomenda = `✅ STOCK ADEQUADO (${it.stock} un cobrem ${diasCobertura} dias / ${mesesCobertura} meses). Não é necessário encomendar já.`;
      }

      return {
        cnp: it.cnp,
        designacao: it.designacao,
        laboratorioTitular: it.laboratorioTitular || 'Sem dados',
        dci: it.dci || it.moleculaDci || 'Sem dados',
        segmento: it.tipoVenda,
        categoria: it.categoria,
        stockAtual: it.stock,
        vendasAno12M: it.vendasQtd,
        vendaMediaMensal: Number(vmm.toFixed(1)),
        diasCoberturaAtual: diasCobertura > 365 ? '> 365 dias' : `${diasCobertura} dias`,
        mesesCoberturaAtual: mesesCobertura > 24 ? '> 24 meses' : `${mesesCobertura} meses`,
        historicoVendasMensais,
        vendasPorEstacao: {
          inverno_Nov_Fev: invernoQtd,
          primavera_Mar_Mai: primaveraQtd,
          verao_Jun_Ago: veraoQtd,
          outono_Set_Out: outonoQtd,
        },
        mesPico,
        custoUnitarioEur: it.custo > 0 ? Number(it.custo.toFixed(2)) : null,
        pvpEur: Number(it.pvp.toFixed(2)),
        margemComercialPct: it.custo > 0 && it.margem < 99.9 ? Number(it.margem.toFixed(1)) : null,
        validade: it.validade || 'S/ Registo',
        recomendacaoEncomenda,
      };
    }),
  };
}


/**
 * 8. Comparar Produtos Similares, Equivalentes e DCI: Volume vs Rentabilidade Real
 */
export async function toolCompararSimilaresERentabilidade(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    termo_pesquisa: string;
    apenas_com_stock?: boolean;
    limite?: number;
  }
) {
  const query = (args.termo_pesquisa || '').trim();
  const limite = args.limite || 15;

  if (!query) {
    return { error: 'Por favor indique o nome do medicamento, molécula DCI ou categoria a comparar.' };
  }

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const cleanQ = stripAccents(query);
  const tokens = cleanQ.split(/\s+/).filter((t) => t.length > 0);

  // Filtra similares pelo nome, DCI ou grupo equivalente usando token matching flexível (ex: "atorvastatina 20" casa com "20mg")
  const matches = catalog.filter((it) => {
    const des = stripAccents(it.designacao);
    const dci = stripAccents(it.moleculaDci || it.grupoDci || '');
    const cat = stripAccents(it.categoria || '');
    const combined = `${des} ${dci} ${cat}`;

    return tokens.every((tok) => {
      if (/^\d+$/.test(tok)) {
        const regex = new RegExp(`\\b${tok}(mg|g|ml|ui|%)?`, 'i');
        return regex.test(combined);
      }
      return combined.includes(tok);
    });
  });

  if (matches.length === 0) {
    return {
      farmacia: 'Farmácia Comunitária',
      termoPesquisado: query,
      totalEncontrados: 0,
      mensagem: `Nenhum produto semelhante encontrado para "${query}".`,
      comparativo: [],
    };
  }

  const filtered = args.apenas_com_stock ? matches.filter((m) => m.stock > 0) : matches;

  // Calcula rentabilidade individual
  const items = filtered.map((it) => {
    const lucroUnit = Number((it.pvp - it.custo).toFixed(2));
    const massaMargem12M = Number((lucroUnit * it.vendasQtd).toFixed(2));
    return {
      cnp: it.cnp,
      designacao: it.designacao,
      segmento: it.tipoVenda,
      ehGenerico: it.ehGenerico,
      moleculaDci: it.moleculaDci || 'N/A',
      stock: it.stock,
      vendas12M: it.vendasQtd,
      vmm: Number(((it.vendasQtd || 0) / 12).toFixed(1)),
      faturacao12M: Number(it.faturacao.toFixed(2)),
      custoUnitarioEur: Number(it.custo.toFixed(2)),
      pvpEur: Number(it.pvp.toFixed(2)),
      lucroUnitarioEur: lucroUnit,
      margemComercialPct: Number(it.margem.toFixed(1)),
      massaMargemTotal12MEur: massaMargem12M,
    };
  });

  // Ordena por volume de vendas decrescente para comparação direta
  items.sort((a, b) => b.vendas12M - a.vendas12M || b.massaMargemTotal12MEur - a.massaMargemTotal12MEur);
  const displayed = items.slice(0, limite);

  // Encontra os líderes
  const maisVendido = [...items].sort((a, b) => b.vendas12M - a.vendas12M)[0];
  const maisRentavelUnit = [...items].sort((a, b) => b.lucroUnitarioEur - a.lucroUnitarioEur)[0];
  const maiorMassa = [...items].sort((a, b) => b.massaMargemTotal12MEur - a.massaMargemTotal12MEur)[0];

  let oportunidadeArbitragem = '';
  if (maisVendido && maisRentavelUnit && maisVendido.cnp !== maisRentavelUnit.cnp && maisRentavelUnit.lucroUnitarioEur > maisVendido.lucroUnitarioEur) {
    const ganhoExtraPorUn = Number((maisRentavelUnit.lucroUnitarioEur - maisVendido.lucroUnitarioEur).toFixed(2));
    const ganhoAnualEstimado = Number((ganhoExtraPorUn * maisVendido.vendas12M).toFixed(2));
    oportunidadeArbitragem = `💡 OPORTUNIDADE DE GANHO NO BALCÃO: A marca mais vendida (${maisVendido.designacao.slice(0, 30)}) deixa ${maisVendido.lucroUnitarioEur.toFixed(2)}€ de lucro/caixa. No entanto, a marca ${maisRentavelUnit.designacao.slice(0, 30)} liberta ${maisRentavelUnit.lucroUnitarioEur.toFixed(2)}€ de lucro/caixa (+${ganhoExtraPorUn.toFixed(2)}€/unidade). Se a equipa redirecionar a dispensa para a marca mais rentável, a farmácia gera mais +${ganhoAnualEstimado.toFixed(2)}€ de margem direta sem alterar o PVP ao utente!`;
  } else {
    oportunidadeArbitragem = 'A marca líder de vendas já é a que oferece melhor rentabilidade ou os produtos têm margens equivalentes.';
  }

  return {
    farmacia: 'Farmácia Comunitária',
    termoPesquisado: query,
    totalSimilaresAnalisados: items.length,
    destaques: {
      liderVolumeVendas: maisVendido ? `${maisVendido.designacao} (${maisVendido.vendas12M} un vendidas)` : 'N/A',
      liderLucroUnitario: maisRentavelUnit ? `${maisRentavelUnit.designacao} (${maisRentavelUnit.lucroUnitarioEur.toFixed(2)}€ lucro/un, margem ${maisRentavelUnit.margemComercialPct}%)` : 'N/A',
      liderMassaMargemTotal: maiorMassa ? `${maiorMassa.designacao} (${maiorMassa.massaMargemTotal12MEur.toFixed(2)}€ libertados no ano)` : 'N/A',
    },
    oportunidadeArbitragem,
    comparativo: displayed,
  };
}

/**
 * 9. Avaliar Acordo Anual de Compras Escalonadas com Laboratório
 */
export async function toolAvaliarAcordoAnualComprasEscalonadas(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    marca_ou_laboratorio: string;
    margem_seguranca_pct?: number;
    numero_tranches?: number;
  }
) {
  const query = (args.marca_ou_laboratorio || '').trim();
  const margemSeguranca = args.margem_seguranca_pct !== undefined ? args.margem_seguranca_pct : 15;
  const numTranches = args.numero_tranches || 3;

  if (!query) {
    return { error: 'Por favor indique a marca, laboratório ou gama a avaliar (ex: "Strepsils", "Cêgripe", "Generis", "Teva").' };
  }

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const cleanQ = stripAccents(query);

  const matched = catalog.filter((c) => {
    const des = stripAccents(c.designacao);
    const cat = stripAccents(c.categoria || '');
    return des.includes(cleanQ) || cat.includes(cleanQ);
  });

  if (matched.length === 0) {
    return {
      farmacia: 'Farmácia Comunitária',
      marcaAvaliada: query,
      totalArtigos: 0,
      mensagem: `Nenhum produto encontrado para a marca ou gama "${query}".`,
    };
  }

  const cnps = matched.map((m) => m.cnp);
  const vendasRaw = await prisma.venda.findMany({
    where: { farmaciaId: ctx.farmaciaId, cnp_codigo: { in: cnps } },
    select: { cnp_codigo: true, data_venda: true, quantidade: true, valor_total: true },
    orderBy: { data_venda: 'asc' },
  });

  // Mês a mês factual
  const vendasPorMes = new Map<string, { qtd: number; valor: number }>();
  let totalUnidadesVendidas = 0;
  let totalFaturadoEur = 0;

  for (const v of vendasRaw) {
    const m = v.data_venda.toISOString().slice(0, 7);
    const cur = vendasPorMes.get(m) || { qtd: 0, valor: 0 };
    cur.qtd += v.quantidade;
    cur.valor += Number(v.valor_total || 0);
    vendasPorMes.set(m, cur);
    totalUnidadesVendidas += v.quantidade;
    totalFaturadoEur += Number(v.valor_total || 0);
  }

  const stockAtualGama = matched.reduce((s, p) => s + p.stock, 0);
  const valorStockAtualCusto = matched.reduce((s, p) => s + p.stock * p.custo, 0);
  const custoMedioPonderado = totalUnidadesVendidas > 0 ? (totalFaturadoEur * 0.6) / totalUnidadesVendidas : 5.0;

  // Volume Anual Seguro com Margem de Segurança (não comprar mais do que a capacidade real de escoamento)
  const fatorSeguranca = (100 - margemSeguranca) / 100.0;
  const volumeAnualSugerido = Math.max(1, Math.round(totalUnidadesVendidas * fatorSeguranca));
  const necessidadeLiquidaNova = Math.max(0, volumeAnualSugerido - stockAtualGama);

  // Divisão em Tranches Escalonadas
  const tranches: Array<{
    tranche: number;
    designacao: string;
    percentagemAcordo: string;
    quantidadeSugeridaUnidades: number;
    custoEstimadoEur: number;
    recomendacaoEntrega: string;
  }> = [];

  if (numTranches === 3) {
    tranches.push({
      tranche: 1,
      designacao: 'Tranche Inicial (Entrada de Época / Montagem de Expositor)',
      percentagemAcordo: '35%',
      quantidadeSugeridaUnidades: Math.round(necessidadeLiquidaNova * 0.35),
      custoEstimadoEur: Number((Math.round(necessidadeLiquidaNova * 0.35) * custoMedioPonderado).toFixed(2)),
      recomendacaoEntrega: 'Entrega na abertura da época para abastecer linear.',
    });
    tranches.push({
      tranche: 2,
      designacao: 'Tranche de Pico (Reforço a Meio da Estação)',
      percentagemAcordo: '45%',
      quantidadeSugeridaUnidades: Math.round(necessidadeLiquidaNova * 0.45),
      custoEstimadoEur: Number((Math.round(necessidadeLiquidaNova * 0.45) * custoMedioPonderado).toFixed(2)),
      recomendacaoEntrega: 'Entrega no início do mês de maior procura histórica.',
    });
    tranches.push({
      tranche: 3,
      designacao: 'Tranche de Fecho / Ajuste Final (Condicionada ao Escoamento Real)',
      percentagemAcordo: '20%',
      quantidadeSugeridaUnidades: Math.round(necessidadeLiquidaNova * 0.20),
      custoEstimadoEur: Number((Math.round(necessidadeLiquidaNova * 0.20) * custoMedioPonderado).toFixed(2)),
      recomendacaoEntrega: 'Acionar apenas se o stock cair abaixo de 15 dias de cobertura. Evita transitar excessos!',
    });
  } else {
    // 4 Tranches Trimestrais
    for (let t = 1; t <= 4; t++) {
      const qtdT = Math.round(necessidadeLiquidaNova * 0.25);
      tranches.push({
        tranche: t,
        designacao: `Tranche ${t} (Trimestral)`,
        percentagemAcordo: '25%',
        quantidadeSugeridaUnidades: qtdT,
        custoEstimadoEur: Number((qtdT * custoMedioPonderado).toFixed(2)),
        recomendacaoEntrega: `Entrega no início do ${t}º trimestre para não imobilizar tesouraria antecipadamente.`,
      });
    }
  }

  const historicoMensalOrdenado = Array.from(vendasPorMes.entries()).map(([mes, v]) => ({
    mes,
    unidadesVendidas: v.qtd,
    faturacaoEur: Number(v.valor.toFixed(2)),
  }));

  return {
    farmacia: 'Farmácia Comunitária',
    marcaAvaliada: query,
    totalCodigosNaGama: matched.length,
    auditoriaHistorica: {
      totalVendido12Meses: totalUnidadesVendidas,
      faturacaoTotal12MesesEur: Number(totalFaturadoEur.toFixed(2)),
      stockAtualEmArmazem: stockAtualGama,
      valorStockAtualCustoEur: Number(valorStockAtualCusto.toFixed(2)),
      historicoMensalReal: historicoMensalOrdenado,
    },
    parecerNegociacaoAcordo: {
      volumeHistoricoReal: `${totalUnidadesVendidas} unidades/ano`,
      margemSegurancaAplicada: `${margemSeguranca}% (para prevenir risco de overstocking)`,
      volumeAnualMaximoSeguro: `${volumeAnualSugerido} unidades`,
      stockJaExistenteEmCasa: `${stockAtualGama} unidades`,
      volumeTotalAContratar: `${necessidadeLiquidaNova} unidades`,
      alertaGestao: 'NUNCA aceite entrega de 100% da encomenda no primeiro trimestre. Exija contratualmente entregas parceladas em tranches.',
    },
    propostaTranchesEscalonadas: tranches,
  };
}

/**
 * 10. Calcular Níveis Sazonais Dinâmicos (Min/Max Viáveis por Fase de Estação)
 */
export async function toolCalcularNiveisSazonaisDinamicos(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    termo_pesquisa: string;
    mes_ou_estacao_referencia?: string;
  }
) {
  const query = (args.termo_pesquisa || '').trim();
  if (!query) {
    return { error: 'Por favor indique o produto ou categoria a calcular níveis sazonais (ex: "cegripe", "strepsils", "antigripais", "solar", "alergias").' };
  }

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const cleanQ = stripAccents(query);

  const matched = catalog.filter((c) => {
    const des = stripAccents(c.designacao);
    const cat = stripAccents(c.categoria || '');
    return des.includes(cleanQ) || cat.includes(cleanQ);
  }).slice(0, 20);

  if (matched.length === 0) {
    return {
      farmacia: 'Farmácia Comunitária',
      termoPesquisado: query,
      totalArtigos: 0,
      mensagem: `Nenhum produto encontrado para "${query}".`,
    };
  }

  // Detecta o mês atual do sistema (Outubro)
  const currentMonth = new Date().getMonth() + 1; // 10 = Outubro

  const resultados = matched.map((it) => {
    const vmm = it.vendasQtd / 12.0;
    const vDiaria = vmm / 30.0;
    const saz = (it.sazonalidade || '').toUpperCase();

    // Determina a fase da estação para a categoria
    let fase = 'ESTÁVEL / REGULAR';
    let minDias = 14;
    let maxDias = 30;
    let recomendacaoFase = '';

    const isGripe = it.categoria?.toLowerCase().includes('gripe') || it.designacao.toLowerCase().includes('gripe') || it.designacao.toLowerCase().includes('strepsils') || it.designacao.toLowerCase().includes('tosse');
    const isAlergia = it.categoria?.toLowerCase().includes('alerg') || it.designacao.toLowerCase().includes('cetirizina') || it.designacao.toLowerCase().includes('loratadina');
    const isSolar = it.categoria?.toLowerCase().includes('solar') || it.designacao.toLowerCase().includes('solar') || it.designacao.toLowerCase().includes('spf');

    if (isGripe) {
      if (currentMonth >= 9 && currentMonth <= 11) {
        fase = '1. ENTRADA DE ÉPOCA (Subida de Procura)';
        minDias = 25;
        maxDias = 50;
        recomendacaoFase = 'Aumentar Ponto de Encomenda para abastecer o expositor antes do frio intenso.';
      } else if (currentMonth === 12 || currentMonth === 1) {
        fase = '2. PICO DE ÉPOCA (Consumo Máximo)';
        minDias = 14;
        maxDias = 28;
        recomendacaoFase = 'Reposição frequente semanal. Não acumular lotes para lá de 30 dias.';
      } else if (currentMonth === 2 || currentMonth === 3) {
        fase = '3. FIM DE ESTAÇÃO (Desaceleração)';
        minDias = 7;
        maxDias = 12;
        recomendacaoFase = 'REDUZIR Ponto de Encomenda para forçar o esgotamento natural da gaveta e evitar sobras para o próximo ano.';
      } else {
        fase = '4. FORA DE ÉPOCA (Época Baixa)';
        minDias = 2;
        maxDias = 5;
        recomendacaoFase = 'Ponto de Encomenda = 0 no sistema de gestão. Apenas stock residual de balcão.';
      }
    } else if (isAlergia) {
      if (currentMonth >= 2 && currentMonth <= 4) {
        fase = '1. ENTRADA DE ÉPOCA (Primavera)';
        minDias = 21;
        maxDias = 45;
        recomendacaoFase = 'Reforçar stock de anti-histamínicos e colírios.';
      } else {
        fase = 'ROTATIVIDADE REGULAR';
        minDias = 14;
        maxDias = 30;
        recomendacaoFase = 'Manter níveis padrão de reposição.';
      }
    } else if (isSolar) {
      if (currentMonth >= 4 && currentMonth <= 6) {
        fase = '1. ENTRADA DE ÉPOCA (Verão)';
        minDias = 30;
        maxDias = 60;
        recomendacaoFase = 'Expositor montado com novidades e SPF 50+.';
      } else if (currentMonth >= 9) {
        fase = '3. FIM DE ÉPOCA (Outono/Inverno)';
        minDias = 0;
        maxDias = 2;
        recomendacaoFase = 'Ponto de Encomenda = 0. Não encomendar solares no inverno!';
      }
    }

    const stockMinSugerido = Math.max(1, Math.ceil(vDiaria * minDias));
    const stockMaxSugerido = Math.max(stockMinSugerido + 1, Math.ceil(vDiaria * maxDias));
    const pontoEncomenda = Math.ceil((stockMinSugerido + stockMaxSugerido) / 2);

    let statusStock = 'ADEQUADO';
    if (it.stock < stockMinSugerido) statusStock = '🚨 ABAIXO DO MÍNIMO DA FASE';
    else if (it.stock > stockMaxSugerido) statusStock = '⚠️ ACIMA DO MÁXIMO DA FASE (EXCESSO)';

    return {
      cnp: it.cnp,
      designacao: it.designacao,
      stockAtual: it.stock,
      faseSazonalAtual: fase,
      statusStock,
      stockMinimoSugerido: stockMinSugerido,
      pontoEncomendaSifarma: pontoEncomenda,
      stockMaximoViavel: stockMaxSugerido,
      coberturaAtualDias: vDiaria > 0 ? Math.round(it.stock / vDiaria) : 999,
      recomendacaoAcao: recomendacaoFase,
    };
  });

  return {
    farmacia: 'Farmácia Comunitária',
    categoriaAnalisada: query,
    mesAtualReferencia: 'Outubro (Início Outono / Preparação Inverno)',
    totalArtigosAnalisados: resultados.length,
    artigos: resultados,
  };
}

/**
 * 11. Gerar Proposta de Encomenda de Reposição Semanal / Quinzenal
 * com FILTROS INTELIGENTES DE EXCLUSÃO (Consolidação DCI, Fora de Época, Margem Negativa e Cobertura Equivalente)
 */
export async function toolGerarPropostaEncomendaReposicao(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    dias_cobertura_desejados?: number;
    apenas_venda_regular?: boolean;
    limite?: number;
    excluir_cnps?: string[];
    mes_referencia?: number;
  }
) {
  const dias = args.dias_cobertura_desejados || 7;
  const limite = args.limite || 30;
  const manualExcludedCnps = new Set(args.excluir_cnps || []);
  const persistedDiscontinued = getDiscontinuedCnps(ctx.farmaciaId);

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const currentMonth = args.mes_referencia || (new Date().getMonth() + 1); // Ex: 11 = Novembro
  const isWinterWindow = currentMonth >= 10 || currentMonth <= 3; // Outubro a Março

  // Carrega histórico de vendas sazonais do período homólogo
  let seasonalSales: Array<{ cnp_codigo: string; quantidade: number }> = [];
  try {
    seasonalSales = await prisma.venda.findMany({
      where: {
        farmaciaId: ctx.farmaciaId,
        data_venda: isWinterWindow
          ? {
              gte: new Date('2025-10-01T00:00:00.000Z'),
              lt: new Date('2026-03-01T00:00:00.000Z'),
            }
          : {
              gte: new Date('2026-04-01T00:00:00.000Z'),
              lt: new Date('2026-10-01T00:00:00.000Z'),
            },
      },
      select: { cnp_codigo: true, quantidade: true },
    });
  } catch (err) {
    console.warn('[Reposição] Aviso ao carregar vendas sazonais:', err);
  }

  const seasonalMap = new Map<string, number>();
  for (const v of seasonalSales) {
    seasonalMap.set(v.cnp_codigo, (seasonalMap.get(v.cnp_codigo) || 0) + v.quantidade);
  }
  const mesesNoPeriodo = isWinterWindow ? 5 : 6;

  // 1. Mapeamento de Moléculas DCI para Consolidação e Cobertura Global
  const dciGroups = new Map<string, any[]>();
  for (const it of catalog) {
    if (it.ehGenerico && (it.grupoDci || it.moleculaDci)) {
      const key = (it.grupoDci || it.moleculaDci)!.toLowerCase();
      const list = dciGroups.get(key) || [];
      list.push(it);
      dciGroups.set(key, list);
    }
  }

  const blockedResidualCnps = new Set<string>();
  const dciCoverageMap = new Map<string, { totalStock: number; totalVendas: number; coberturaDias: number }>();

  for (const [key, items] of dciGroups.entries()) {
    const totalStock = items.reduce((s, it) => s + it.stock, 0);
    const totalVendas = items.reduce((s, it) => s + it.vendasQtd, 0);
    const vDiariaTotal = (totalVendas / 12.0) / 30.0;
    const cob = vDiariaTotal > 0 ? Math.round(totalStock / vDiariaTotal) : 999;
    dciCoverageMap.set(key, { totalStock, totalVendas, coberturaDias: cob });

    // Se existirem mais de 2 marcas de genéricos para a mesma molécula, bloqueia as secundárias/residuais
    if (items.length > 2) {
      const sorted = [...items].sort((a, b) => b.vendasQtd - a.vendasQtd || b.stock - a.stock);
      const leaderSales = sorted[0].vendasQtd;
      for (let i = 2; i < sorted.length; i++) {
        if (sorted[i].vendasQtd < leaderSales * 0.25 || sorted[i].vendasQtd <= 5) {
          blockedResidualCnps.add(sorted[i].cnp);
        }
      }
    }
  }

  // 2. Filtra serviços fictícios e artigos sem vendas
  const elegiveis = catalog.filter((it) => {
    if (it.cnp.startsWith('0000') || it.designacao.toLowerCase().includes('taxa nocturna') || it.designacao.toLowerCase().includes('check tensao')) {
      return false;
    }
    return it.vendasQtd >= (args.apenas_venda_regular !== false ? 6 : 1);
  });

  const propostasAprovadas: Array<{
    cnp: string;
    designacao: string;
    stockAtual: number;
    vendas12M: number;
    vendaDiaria: number;
    ehPicoSazonal: boolean;
    necessidadeDias: number;
    quantidadeAEncomendar: number;
    custoUnitarioEur: number;
    pvpEur: number;
    custoTotalLinhaEur: number;
    canalSugerido: 'URGENTE_ARMAZENISTA' | 'REGULAR_ARMAZENISTA' | 'CONSUMIVEIS_LOJA';
    canalRotulo: string;
  }> = [];

  const artigosExcluidos: Array<{
    cnp: string;
    designacao: string;
    stockAtual: number;
    vendas12M: number;
    motivoBloqueio: string;
    poupancaEvitadaEur: number;
  }> = [];

  let investimentoTotal = 0;
  let unidadesTotais = 0;
  let capitalPoupadoBloqueios = 0;

  for (const it of elegiveis) {
    const cleanDes = stripAccents(it.designacao).toLowerCase();

    // FILTRO A: Produtos Descontinuados / Deixar de Trabalhar (Pilar 3)
    if (persistedDiscontinued.has(it.cnp) || manualExcludedCnps.has(it.cnp)) {
      artigosExcluidos.push({
        cnp: it.cnp,
        designacao: it.designacao,
        stockAtual: it.stock,
        vendas12M: it.vendasQtd,
        motivoBloqueio: 'Produto Descontinuado / Não Repor (Decisão de Gestão - Ponto de Encomenda = 0)',
        poupancaEvitadaEur: Number((Math.max(1, Math.ceil(((it.vendasQtd / 12) / 30) * dias)) * it.custo).toFixed(2)),
      });
      capitalPoupadoBloqueios += Math.max(1, Math.ceil(((it.vendasQtd / 12) / 30) * dias)) * it.custo;
      continue;
    }

    // FILTRO B: Margem Negativa (PVP < Custo - venda dá prejuízo direto)
    if (it.pvp < it.custo || it.margem < 0) {
      artigosExcluidos.push({
        cnp: it.cnp,
        designacao: it.designacao,
        stockAtual: it.stock,
        vendas12M: it.vendasQtd,
        motivoBloqueio: 'Margem Negativa (PVP < Custo - venda dá prejuízo até retificação no sistema de gestão)',
        poupancaEvitadaEur: Number((it.custo).toFixed(2)),
      });
      capitalPoupadoBloqueios += it.custo;
      continue;
    }

    // CÁLCULO DE VELOCIDADE DINÂMICA SAZONAL
    const vDiariaAnual = (it.vendasQtd / 12.0) / 30.0;
    const vendasSaz = seasonalMap.get(it.cnp) || 0;
    const vDiariaSaz = vendasSaz > 0 ? (vendasSaz / mesesNoPeriodo) / 30.0 : 0;
    const isSolar = it.categoria?.toLowerCase().includes('solar') || cleanDes.includes('solar') || cleanDes.includes('spf') || cleanDes.includes('repelente');

    // FILTRO C: Fora de Época (Solares / Repelentes no Outono/Inverno)
    if (isWinterWindow && isSolar && vendasSaz === 0) {
      artigosExcluidos.push({
        cnp: it.cnp,
        designacao: it.designacao,
        stockAtual: it.stock,
        vendas12M: it.vendasQtd,
        motivoBloqueio: 'Fora de Época (Artigo de Verão - Proibido repor no Outono/Inverno)',
        poupancaEvitadaEur: Number((Math.max(1, Math.ceil(vDiariaAnual * dias)) * it.custo).toFixed(2)),
      });
      capitalPoupadoBloqueios += Math.max(1, Math.ceil(vDiariaAnual * dias)) * it.custo;
      continue;
    }

    // FILTRO D: Trava de Marca Residual DCI (Fecho de Gaveta)
    if (blockedResidualCnps.has(it.cnp)) {
      artigosExcluidos.push({
        cnp: it.cnp,
        designacao: it.designacao,
        stockAtual: it.stock,
        vendas12M: it.vendasQtd,
        motivoBloqueio: 'Consolidação DCI (Marca residual travada para fechar gaveta e concentrar nas marcas líderes)',
        poupancaEvitadaEur: Number((Math.max(1, Math.ceil(vDiariaAnual * dias)) * it.custo).toFixed(2)),
      });
      capitalPoupadoBloqueios += Math.max(1, Math.ceil(vDiariaAnual * dias)) * it.custo;
      continue;
    }

    // FILTRO E: Molécula DCI já tem Cobertura Segura em armazém noutras marcas
    if (it.ehGenerico && (it.grupoDci || it.moleculaDci)) {
      const dciInfo = dciCoverageMap.get((it.grupoDci || it.moleculaDci)!.toLowerCase());
      if (dciInfo && dciInfo.coberturaDias >= 30) {
        artigosExcluidos.push({
          cnp: it.cnp,
          designacao: it.designacao,
          stockAtual: it.stock,
          vendas12M: it.vendasQtd,
          motivoBloqueio: `Molécula DCI com Cobertura Segura (${dciInfo.coberturaDias} dias noutras marcas em stock)`,
          poupancaEvitadaEur: Number((Math.max(1, Math.ceil(vDiariaAnual * dias)) * it.custo).toFixed(2)),
        });
        capitalPoupadoBloqueios += Math.max(1, Math.ceil(vDiariaAnual * dias)) * it.custo;
        continue;
      }
    }

    // Ponderação Sazonal: se estiver em época alta (Outono/Inverno), reforça com a venda real do período
    const ehPicoSazonal = isWinterWindow && vDiariaSaz > vDiariaAnual * 1.15;
    const vDiaria = ehPicoSazonal ? vDiariaSaz : vDiariaAnual;

    const necPeriodo = Math.max(1, Math.ceil(vDiaria * dias));
    if (it.stock >= necPeriodo) continue;

    const falta = necPeriodo - it.stock;
    const custoPotencial = falta * it.custo;

    // Classificação de Consumíveis de Loja, Águas, Máscaras e Balcão
    const isConsumivel =
      ((cleanDes.includes('saco plast') || cleanDes.includes('saco papel') || cleanDes.includes('sacola')) &&
        !cleanDes.includes('gelo') &&
        !cleanDes.includes('quente') &&
        !cleanDes.includes('colost') &&
        !cleanDes.includes('coletor')) ||
      cleanDes.includes('healsi') ||
      cleanDes.includes('agua nascente') ||
      cleanDes.includes('mascara cirurgica') ||
      cleanDes.includes('mascara cir') ||
      cleanDes.includes('seringa') ||
      cleanDes.includes('agulha') ||
      cleanDes.includes('compressa') ||
      cleanDes.includes('ligadura');

    // Determina o Canal Operacional de Compra (Grossista / Armazenista)
    const diasCob = vDiaria > 0 ? it.stock / vDiaria : 0;
    const isUrgente =
      (it.stock === 0 && it.vendasQtd >= 20) ||
      (diasCob <= 4 && it.vendasQtd >= 35) ||
      (ehPicoSazonal && it.stock <= 2) ||
      (custoPotencial >= 90 && it.stock <= 2);

    let canalSugerido: 'URGENTE_ARMAZENISTA' | 'REGULAR_ARMAZENISTA' | 'CONSUMIVEIS_LOJA' = 'REGULAR_ARMAZENISTA';
    let canalRotulo = '🟡 Armazenista Regular';

    if (isConsumivel) {
      canalSugerido = 'CONSUMIVEIS_LOJA';
      canalRotulo = '📦 Balcão & Consumíveis';
    } else if (isUrgente) {
      canalSugerido = 'URGENTE_ARMAZENISTA';
      canalRotulo = '🔴 Armazenista Urgente';
    }

    // APROVADO PARA ENCOMENDA
    investimentoTotal += custoPotencial;
    unidadesTotais += falta;
    propostasAprovadas.push({
      cnp: it.cnp,
      designacao: it.designacao,
      stockAtual: it.stock,
      vendas12M: it.vendasQtd,
      vendaDiaria: Number(vDiaria.toFixed(2)),
      ehPicoSazonal,
      necessidadeDias: necPeriodo,
      quantidadeAEncomendar: falta,
      custoUnitarioEur: Number(it.custo.toFixed(2)),
      pvpEur: Number(it.pvp.toFixed(2)),
      custoTotalLinhaEur: Number(custoPotencial.toFixed(2)),
      canalSugerido,
      canalRotulo,
    });
  }

  // Ordena por criticidade (maior venda diária e custo)
  propostasAprovadas.sort((a, b) => b.vendaDiaria - a.vendaDiaria || b.custoTotalLinhaEur - a.custoTotalLinhaEur);
  const displayLimit = Math.min(limite || 25, 25);
  const displayed = propostasAprovadas.slice(0, displayLimit);
  const investimentoTopApresentado = displayed.reduce((s, it) => s + it.custoTotalLinhaEur, 0);
  const unidadesTopApresentado = displayed.reduce((s, it) => s + it.quantidadeAEncomendar, 0);

  const urgentes = propostasAprovadas.filter((p) => p.canalSugerido === 'URGENTE_ARMAZENISTA');
  const regulares = propostasAprovadas.filter((p) => p.canalSugerido === 'REGULAR_ARMAZENISTA');
  const consumiveis = propostasAprovadas.filter((p) => p.canalSugerido === 'CONSUMIVEIS_LOJA');

  return {
    farmacia: 'Farmácia Comunitária',
    periodoCoberturaDesejado: `${dias} dias (${dias === 7 ? 'Semanal' : dias === 14 ? 'Quinzenal' : `${dias} dias`})`,
    mesReferencia: currentMonth === 11 ? 'Novembro (Outono / Preparação de Inverno)' : `Mês ${currentMonth}`,
    resumoExecutivo: {
      totalArtigosNecessitadosGlobalFarmacia: propostasAprovadas.length,
      totalUnidadesGlobalNecessarias: unidadesTotais,
      investimentoGlobalNecessarioFarmaciaEur: Number(investimentoTotal.toFixed(2)),

      totalArtigosNoCarrinhoApresentado: displayed.length,
      totalUnidadesCarrinhoApresentado: unidadesTopApresentado,
      investimentoCarrinhoApresentadoEur: Number(investimentoTopApresentado.toFixed(2)),

      desdobramentoCanais: {
        armazenistaUrgente: {
          rotulo: '🔴 Armazenista Urgente (Corte da Manhã)',
          artigos: urgentes.length,
          unidades: urgentes.reduce((s, it) => s + it.quantidadeAEncomendar, 0),
          investimentoEur: Number(urgentes.reduce((s, it) => s + it.custoTotalLinhaEur, 0).toFixed(2)),
        },
        armazenistaRegular: {
          rotulo: '🟡 Armazenista Regular (Consolidação Semanal)',
          artigos: regulares.length,
          unidades: regulares.reduce((s, it) => s + it.quantidadeAEncomendar, 0),
          investimentoEur: Number(regulares.reduce((s, it) => s + it.custoTotalLinhaEur, 0).toFixed(2)),
        },
        balcaoEConsumiveis: {
          rotulo: '📦 Balcão & Consumíveis (Águas, Máscaras, Pensos, Sacos)',
          artigos: consumiveis.length,
          unidades: consumiveis.reduce((s, it) => s + it.quantidadeAEncomendar, 0),
          investimentoEur: Number(consumiveis.reduce((s, it) => s + it.custoTotalLinhaEur, 0).toFixed(2)),
        },
      },

      artigosReforcadosPeloPicoSazonal: propostasAprovadas.filter((p) => p.ehPicoSazonal).length,
      totalArtigosBloqueadosPelaGestao: artigosExcluidos.length,
      capitalPoupadoEmBloqueiosEur: Number(capitalPoupadoBloqueios.toFixed(2)),
      parecerDiretor: `Identificámos ${propostasAprovadas.length} artigos com necessidade global de reposição na farmácia (€ ${investimentoTotal.toFixed(2)}), com ${propostasAprovadas.filter((p) => p.ehPicoSazonal).length} artigos reforçados pelo ritmo real de vendas de Outono/Inverno. Todo o aprovisionamento está consolidado no Armazenista Habitual (Urgente vs Regular) com secção dedicada para Balcão & Consumíveis (${consumiveis.length} artigos). Foram bloqueados ${artigosExcluidos.length} artigos obsoletos ou travados, poupando ${capitalPoupadoBloqueios.toFixed(2)}€!`,
    },
    carrinhoSugerido: displayed,
    listaCompletaParaExportar: propostasAprovadas,
    artigosExcluidosDaEncomenda: artigosExcluidos.slice(0, 20),
  };
}

/**
 * 12. Analisar Curva ABC de Faturação e Margem (Princípio de Pareto)
 */
export async function toolAnalisarCurvaAbcFaturacaoEMargem(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    tipo_curva?: 'FATURACAO' | 'MARGEM';
    top_n?: number;
  }
) {
  const tipo = args.tipo_curva === 'MARGEM' ? 'MARGEM' : 'FATURACAO';
  const topN = args.top_n || 25;

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);

  // Remove serviços nulos
  const validos = catalog.filter((it) => !it.cnp.startsWith('0000') && it.vendasQtd > 0);

  if (tipo === 'FATURACAO') {
    validos.sort((a, b) => b.faturacao - a.faturacao);
  } else {
    validos.sort((a, b) => (b.pvp - b.custo) * b.vendasQtd - (a.pvp - a.custo) * a.vendasQtd);
  }

  const totalMetrica = validos.reduce(
    (s, it) => s + (tipo === 'FATURACAO' ? it.faturacao : (it.pvp - it.custo) * it.vendasQtd),
    0
  );

  let acumulado = 0;
  let countA = 0;
  let countB = 0;
  let countC = 0;

  const itensClassificados = validos.map((it, idx) => {
    const valorItem = tipo === 'FATURACAO' ? it.faturacao : (it.pvp - it.custo) * it.vendasQtd;
    acumulado += valorItem;
    const pctAcum = totalMetrica > 0 ? (acumulado / totalMetrica) * 100 : 0;

    let classe = 'C';
    if (pctAcum <= 80) {
      classe = 'A';
      countA++;
    } else if (pctAcum <= 95) {
      classe = 'B';
      countB++;
    } else {
      classe = 'C';
      countC++;
    }

    const vDiaria = (it.vendasQtd / 12.0) / 30.0;
    const diasCob = vDiaria > 0 ? Math.round(it.stock / vDiaria) : 999;
    const riscoRutura = classe === 'A' && (it.stock <= 2 || diasCob < 7);

    return {
      ranking: idx + 1,
      cnp: it.cnp,
      designacao: it.designacao,
      classeAbc: classe,
      faturacao12MEur: Number(it.faturacao.toFixed(2)),
      massaMargem12MEur: Number(((it.pvp - it.custo) * it.vendasQtd).toFixed(2)),
      pctAcumulada: Number(pctAcum.toFixed(1)),
      stockAtual: it.stock,
      diasCobertura: diasCob,
      alertaCritico: riscoRutura ? '🚨 RISCO DE RUTURA EM ARTIGO CLASSE A (Impacto Direto na Faturação!)' : '✅ Stock sob controlo',
    };
  });

  const artigosClasseAEmRisco = itensClassificados.filter((i) => i.alertaCritico.includes('RISCO DE RUTURA'));

  return {
    farmacia: 'Farmácia Comunitária',
    tipoAnalise: tipo === 'FATURACAO' ? 'Curva ABC de Faturação (Receita)' : 'Curva ABC de Lucro Bruto (Margem)',
    universoArtigosAnalisados: validos.length,
    distribuicaoPareto: {
      classeA_80pct: `${countA} artigos (${((countA / validos.length) * 100).toFixed(1)}% do catálogo geram 80% do negócio)`,
      classeB_15pct: `${countB} artigos (${((countB / validos.length) * 100).toFixed(1)}% do catálogo)`,
      classeC_5pct: `${countC} artigos (${((countC / validos.length) * 100).toFixed(1)}% do catálogo - cauda longa)`,
    },
    alertaSeguranca: artigosClasseAEmRisco.length > 0
      ? `🚨 ATENÇÃO: ${artigosClasseAEmRisco.length} artigos da Classe A têm stock inferior a 7 dias! Risco direto de perda de receita.`
      : '✅ Todos os artigos da Classe A mantêm níveis de stock adequados.',
    artigosClasseAEmRisco: artigosClasseAEmRisco.slice(0, 10),
    topProdutos: itensClassificados.slice(0, topN),
  };
}

/**
 * 13. Auditar Anomalias de Margem e Preços (Margens Negativas e Abaixo do Mínimo)
 */
export async function toolAuditarAnomaliasMargemEPrecos(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    margem_minima_alerta_pct?: number;
    limite?: number;
  }
) {
  const margemMinima = args.margem_minima_alerta_pct !== undefined ? args.margem_minima_alerta_pct : 5.0;
  const limite = args.limite || 30;

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);

  // Identifica anomalias em artigos com stock ou com vendas
  const anomalias = catalog.filter((it) => {
    if (it.cnp.startsWith('0000')) return false;
    if (it.stock === 0 && it.vendasQtd === 0) return false;

    // Filtra sacos, material de embalagem e máscaras de apoio da auditoria de margens
    const desClean = stripAccents(it.designacao);
    if ((desClean.includes('saco') || desClean.includes('sacola')) && !desClean.includes('gelo') && !desClean.includes('quente')) {
      return false;
    }
    if (desClean.includes('mascara cirurgica') || desClean.includes('mascara cir.')) {
      return false;
    }

    const margemNegativa = it.pvp < it.custo || it.margem < 0;
    const margemCritica = it.margem >= 0 && it.margem < margemMinima;
    return margemNegativa || margemCritica;
  });

  const formatadas = anomalias.map((it) => {
    const isNegativa = it.pvp < it.custo || it.margem < 0;
    const prejuizoUnit = isNegativa ? Number((it.custo - it.pvp).toFixed(2)) : 0;
    const impactoAnualPrejuizo = Number((prejuizoUnit * it.vendasQtd).toFixed(2));
    const isMsrm = it.tipoVenda === 'MSRM';
    const cleanDes = stripAccents(it.designacao);
    const isFixedPvpDevice = cleanDes.includes('freestyle') || cleanDes.includes('libre');

    // Sugere PVP com 20% de margem padrão apenas para artigos de venda livre
    const pvpSugerido = Number((it.custo / 0.8).toFixed(2));

    let tipoAnomalia = '';
    let correcaoSugeridaSifarma = '';

    if (isNegativa) {
      if (isMsrm) {
        tipoAnomalia = '🚨 DIVERGÊNCIA DE CUSTO (MSRM Preço Regulado Infarmed)';
        correcaoSugeridaSifarma = `Medicamento de receita médica (MSRM) com PVP oficial de ${it.pvp.toFixed(2)}€ tabelado pelo Infarmed. O PVP NÃO PODE ser alterado por lei! Auditar com urgência a fatura de compra do armazenista no sistema de gestão: o custo registado de ${it.custo.toFixed(2)}€ contém provável erro de lançamento (IVA duplicado ou código de embalagem hospitalar).`;
      } else {
        tipoAnomalia = '🚨 VENDA COM PREJUÍZO (PVP < Custo)';
        correcaoSugeridaSifarma = `Produto de venda livre. Atualizar PVP para ~${pvpSugerido}€ no sistema de gestão para cobrir o custo de ${it.custo.toFixed(2)}€ e restabelecer margem viável de 20%.`;
      }
    } else {
      if (isFixedPvpDevice) {
        tipoAnomalia = 'ℹ️ MARGEM FIXADA POR FABRICANTE (PVP Tabelado)';
        correcaoSugeridaSifarma = 'PVP máximo tabelado pela Abbott em 53,00€ com IVA. NÃO aumentar o PVP para não perder utentes para a concorrência. Aumentar a margem negociando descontos comerciais de escala ou campanhas de transferência direta.';
      } else if (isMsrm) {
        tipoAnomalia = '⚠️ MARGEM REDUZIDA EM MEDICAMENTO REGULADO';
        correcaoSugeridaSifarma = `PVP oficial Infarmed (${it.pvp.toFixed(2)}€). As margens de MSRM são reguladas por portaria. Recomenda-se incentivar a dispensa de genéricos equivalentes com maior margem unitária no balcão.`;
      } else {
        tipoAnomalia = '⚠️ MARGEM ANORMALMENTE BAIXA (< 5%)';
        correcaoSugeridaSifarma = `Produto de venda livre. Rever preço de venda no sistema de gestão para ~${pvpSugerido}€ de modo a assegurar margem saudável.`;
      }
    }

    return {
      cnp: it.cnp,
      designacao: it.designacao,
      segmento: it.tipoVenda,
      stockAtual: it.stock,
      vendas12M: it.vendasQtd,
      custoUnitarioEur: Number(it.custo.toFixed(2)),
      pvpAtualEur: Number(it.pvp.toFixed(2)),
      margemAtualPct: Number(it.margem.toFixed(1)),
      tipoAnomalia,
      prejuizoPorUnidadeEur: isNegativa ? prejuizoUnit : 0,
      prejuizoAnualEstimadoEur: impactoAnualPrejuizo,
      correcaoSugeridaSifarma,
    };
  });

  // Ordena prioritariamente as margens negativas com maior volume de vendas
  formatadas.sort((a, b) => b.prejuizoAnualEstimadoEur - a.prejuizoAnualEstimadoEur || a.margemAtualPct - b.margemAtualPct);

  const totalNegativas = formatadas.filter((f) => f.tipoAnomalia.includes('PREJUÍZO')).length;

  return {
    farmacia: 'Farmácia Comunitária',
    totalAnomaliasDetetadas: formatadas.length,
    resumo: {
      artigosComPrejuizoMargemNegativa: totalNegativas,
      artigosComMargemCriticaAbaixoDe5pct: formatadas.length - totalNegativas,
      impactoAlerta: totalNegativas > 0
        ? `🚨 Encontrados ${totalNegativas} artigos onde a farmácia está a perder dinheiro diretamente em cada venda (Custo > PVP)!`
        : 'Não foram encontradas margens negativas.',
    },
    anomaliasPrioritarias: formatadas.slice(0, limite),
  };
}


/**
 * 15. Consultar Vendas Diárias Desagregadas (Granularidade 'DIARIO')
 * Permite ao Copilot auditar dias específicos, consultar faturação diária, produtos mais vendidos
 * e verificar quais os ficheiros diários importados no sistema.
 */
export async function toolConsultarVendasDiarias(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  params: {
    data?: string;
    cnp_ou_nome?: string;
    limite?: number;
  }
) {
  const limite = Math.min(params.limite || 25, 100);

  // 1. Descobre todas as datas com registos diários para a farmácia
  const datasDisponiveisRaw = await prisma.venda.groupBy({
    by: ['data_venda'],
    where: {
      farmaciaId: ctx.farmaciaId,
      granularidade: 'DIARIO',
    },
    _count: { id: true },
    _sum: { quantidade: true, valor_total: true },
    orderBy: { data_venda: 'desc' },
  });

  const datasDisponiveis = datasDisponiveisRaw.map((d) => ({
    data: d.data_venda.toISOString().slice(0, 10),
    totalLinhas: d._count.id,
    totalUnidades: d._sum.quantidade || 0,
    totalFaturadoEur: Number(Number(d._sum.valor_total || 0).toFixed(2)),
  }));

  if (datasDisponiveis.length === 0) {
    return {
      farmacia: 'Farmácia Comunitária',
      mensagem: 'Não existem registos de vendas diárias importados para esta farmácia. O sistema dispõe de dados mensais contínuos dos últimos 13 meses na tabela de vendas. Para análises de evolução temporal, comparação entre meses, faturação mensal ou melhor/pior mês em margem de lucro, execute obrigatoriamente a ferramenta "analisar_evolucao_mensal_financeira".',
      datasDisponiveis: [],
    };
  }

  // 2. Tenta resolver a data pretendida
  let dataFiltro = null;
  if (params.data) {
    const rawData = params.data.trim();
    const isoMatch = rawData.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
      const y = isoMatch[1];
      const m = isoMatch[2].padStart(2, '0');
      const d = isoMatch[3].padStart(2, '0');
      dataFiltro = `${y}-${m}-${d}`;
    } else {
      const ptMatch = rawData.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
      if (ptMatch) {
        const d = ptMatch[1].padStart(2, '0');
        const m = ptMatch[2].padStart(2, '0');
        const y = ptMatch[3];
        dataFiltro = `${y}-${m}-${d}`;
      } else {
        const meses: Record<string, string> = {
          janeiro: '01', fevereiro: '02', marco: '03', março: '03', abril: '04',
          maio: '05', junho: '06', julho: '07', agosto: '08', setembro: '09',
          outubro: '10', novembro: '11', dezembro: '12'
        };
        const textMatch = rawData.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/(\d{1,2})\s*(?:de\s*)?([a-z]+)\s*(?:de\s*)?(\d{4})/);
        if (textMatch && meses[textMatch[2]]) {
          const d = textMatch[1].padStart(2, '0');
          const m = meses[textMatch[2]];
          const y = textMatch[3];
          dataFiltro = `${y}-${m}-${d}`;
        }
      }
    }
  }

  if (!dataFiltro && datasDisponiveis.length === 1) {
    dataFiltro = datasDisponiveis[0].data;
  }

  if (!dataFiltro) {
    return {
      farmacia: 'Farmácia Comunitária',
      mensagem: `Existem ${datasDisponiveis.length} dia(s) com vendas diárias importadas no sistema. Por favor indique uma das datas para ver o detalhe das vendas.`,
      datasDisponiveis,
    };
  }

  const startOfDay = new Date(`${dataFiltro}T00:00:00.000Z`);
  const endOfDay = new Date(`${dataFiltro}T23:59:59.999Z`);

  const whereClause: any = {
    farmaciaId: ctx.farmaciaId,
    granularidade: 'DIARIO',
    data_venda: {
      gte: startOfDay,
      lte: endOfDay,
    },
  };

  if (params.cnp_ou_nome) {
    const q = params.cnp_ou_nome.trim().toLowerCase();
    whereClause.OR = [
      { cnp_codigo: { contains: q } },
      { produto: { designacao: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const vendas = await prisma.venda.findMany({
    where: whereClause,
    include: { produto: true },
    orderBy: [{ quantidade: 'desc' }, { valor_total: 'desc' }],
  });

  const totalUnidades = vendas.reduce((acc, v) => acc + v.quantidade, 0);
  const totalFaturado = vendas.reduce((acc, v) => acc + Number(v.valor_total || 0), 0);

  return {
    farmacia: 'Farmácia Comunitária',
    dataConsultada: dataFiltro,
    totalArtigosDistintosVendidos: vendas.length,
    totalUnidadesVendidas: totalUnidades,
    faturacaoTotalDiaEur: Number(totalFaturado.toFixed(2)),
    artigosVendidosNoDia: vendas.slice(0, limite).map((v) => ({
      cnp: v.cnp_codigo,
      designacao: v.produto ? v.produto.designacao : 'Sem designação',
      quantidade: v.quantidade,
      valorTotalEur: Number(Number(v.valor_total || 0).toFixed(2)),
      tipoVenda: v.produto ? v.produto.tipo_venda : 'MSRM',
      categoria: v.produto ? v.produto.categoria : 'Geral',
      pvpUnitarioEur: (v.produto && v.produto.pvp) ? Number(v.produto.pvp) : null,
    })),
    datasDisponiveisNoSistema: datasDisponiveis.map((d) => d.data),
  };
}

// ============================================================================
// 15B. ANÁLISE TEMPORAL MÊS-A-MÊS, MARGENS E PERFORMANCE FINANCEIRA
// ============================================================================
export async function toolAnalisarEvolucaoMensalFinanceira(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    ano?: string;
    categoria_ou_macro?: string;
    ordenar_por?: 'MARGEM_EUR' | 'FATURACAO_EUR' | 'MARGEM_PCT' | 'CRONOLOGICO';
    top_produtos_qtd?: number;
  }
) {
  const topQtd = Math.min(Math.max(args.top_produtos_qtd || 3, 1), 10);

  // 1. Catálogo e Preços da Farmácia autenticada
  const precos = await prisma.precoFarmacia.findMany({
    where: { farmaciaId: ctx.farmaciaId },
    select: { cnp_codigo: true, pvp: true, custo_ref: true, margem: true },
  });
  const precoMap = new Map<string, { pvp: number; custo: number; margem: number }>();
  precos.forEach((p) => {
    precoMap.set(p.cnp_codigo, {
      pvp: Number(p.pvp || 0),
      custo: Number(p.custo_ref || 0),
      margem: Number(p.margem || 0),
    });
  });

  const produtos = await prisma.produtoMestre.findMany({
    select: { cnp_codigo: true, designacao: true, categoria: true, macro_area: true, pvp: true, margem_padrao: true },
  });
  const prodMap = new Map<string, any>();
  produtos.forEach((p) => {
    prodMap.set(p.cnp_codigo, p);
  });

  // 2. Vendas da farmácia
  const vendasRaw = await prisma.venda.findMany({
    where: { farmaciaId: ctx.farmaciaId },
    select: { cnp_codigo: true, quantidade: true, valor_total: true, data_venda: true },
    orderBy: { data_venda: 'asc' },
  });

  if (vendasRaw.length === 0) {
    return {
      farmacia: ctx.farmaciaNome,
      mensagem: 'Não existem registos de vendas importados para esta farmácia.',
      meses: [],
    };
  }

  // 3. Agrupamento por Mês
  const filterMacro = (args.categoria_ou_macro || '').trim().toUpperCase();
  const filterAno = (args.ano || '').trim();

  const monthlyStats = new Map<
    string,
    {
      mes: string;
      faturacaoTotalEur: number;
      custoTotalEur: number;
      margemBrutaTotalEur: number;
      unidadesTotal: number;
      skusSet: Set<string>;
      categoriasMap: Map<string, number>;
      produtosMap: Map<string, { cnp: string; designacao: string; margemEur: number; faturacaoEur: number; unidades: number }>;
    }
  >();

  for (const v of vendasRaw) {
    const mesKey = v.data_venda.toISOString().slice(0, 7); // "YYYY-MM"
    if (filterAno && !mesKey.startsWith(filterAno)) continue;

    const masterInfo = prodMap.get(v.cnp_codigo);
    const cat = masterInfo?.macro_area || 'OUTROS';
    if (filterMacro && !cat.toUpperCase().includes(filterMacro)) continue;

    if (!monthlyStats.has(mesKey)) {
      monthlyStats.set(mesKey, {
        mes: mesKey,
        faturacaoTotalEur: 0,
        custoTotalEur: 0,
        margemBrutaTotalEur: 0,
        unidadesTotal: 0,
        skusSet: new Set<string>(),
        categoriasMap: new Map<string, number>(),
        produtosMap: new Map(),
      });
    }

    const st = monthlyStats.get(mesKey)!;
    const qtd = Number(v.quantidade || 0);
    const fat = Number(v.valor_total || 0);

    st.faturacaoTotalEur += fat;
    st.unidadesTotal += qtd;
    st.skusSet.add(v.cnp_codigo);

    const pInfo = precoMap.get(v.cnp_codigo);
    let custoUnit = 0;
    if (pInfo && pInfo.custo > 0) {
      custoUnit = pInfo.custo;
    } else if (masterInfo && masterInfo.pvp && masterInfo.margem_padrao) {
      const margemPct = Number(masterInfo.margem_padrao);
      custoUnit = Number(masterInfo.pvp) * (1 - margemPct / 100);
    } else {
      custoUnit = (fat / (qtd || 1)) * 0.7;
    }

    const custoTotalItem = custoUnit * qtd;
    const margemTotalItem = fat - custoTotalItem;

    st.custoTotalEur += custoTotalItem;
    st.margemBrutaTotalEur += margemTotalItem;

    st.categoriasMap.set(cat, (st.categoriasMap.get(cat) || 0) + margemTotalItem);

    const pName = masterInfo?.designacao || v.cnp_codigo;
    if (!st.produtosMap.has(v.cnp_codigo)) {
      st.produtosMap.set(v.cnp_codigo, {
        cnp: v.cnp_codigo,
        designacao: pName,
        margemEur: 0,
        faturacaoEur: 0,
        unidades: 0,
      });
    }
    const pStat = st.produtosMap.get(v.cnp_codigo)!;
    pStat.margemEur += margemTotalItem;
    pStat.faturacaoEur += fat;
    pStat.unidades += qtd;
  }

  const mesesFormatados: any[] = [];
  for (const [mes, st] of monthlyStats.entries()) {
    const margemPct = st.faturacaoTotalEur > 0 ? (st.margemBrutaTotalEur / st.faturacaoTotalEur) * 100 : 0;

    const topCategorias = [...st.categoriasMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([macroArea, mVal]) => ({
        macroArea,
        margemBrutaEur: Math.round(mVal * 100) / 100,
        pesoNaMargemPct: st.margemBrutaTotalEur > 0 ? Math.round((mVal / st.margemBrutaTotalEur) * 1000) / 10 : 0,
      }));

    const topProdutos = [...st.produtosMap.values()]
      .sort((a, b) => b.margemEur - a.margemEur)
      .slice(0, topQtd)
      .map((p) => ({
        cnp: p.cnp,
        designacao: p.designacao,
        margemBrutaEur: Math.round(p.margemEur * 100) / 100,
        faturacaoEur: Math.round(p.faturacaoEur * 100) / 100,
        unidades: p.unidades,
      }));

    mesesFormatados.push({
      mes,
      faturacaoTotalEur: Math.round(st.faturacaoTotalEur * 100) / 100,
      custoTotalEur: Math.round(st.custoTotalEur * 100) / 100,
      margemBrutaTotalEur: Math.round(st.margemBrutaTotalEur * 100) / 100,
      margemBrutaPct: Math.round(margemPct * 10) / 10,
      unidadesTotal: st.unidadesTotal,
      skusDistintos: st.skusSet.size,
      topCategorias,
      topProdutos,
      produtosMap: st.produtosMap,
    });
  }

  // Ordenação
  const ordenarPor = args.ordenar_por || 'CRONOLOGICO';
  if (ordenarPor === 'MARGEM_EUR') {
    mesesFormatados.sort((a, b) => b.margemBrutaTotalEur - a.margemBrutaTotalEur);
  } else if (ordenarPor === 'FATURACAO_EUR') {
    mesesFormatados.sort((a, b) => b.faturacaoTotalEur - a.faturacaoTotalEur);
  } else if (ordenarPor === 'MARGEM_PCT') {
    mesesFormatados.sort((a, b) => b.margemBrutaPct - a.margemBrutaPct);
  } else {
    mesesFormatados.sort((a, b) => a.mes.localeCompare(b.mes));
  }

  // Ranking geral
  const byMargem = [...mesesFormatados].sort((a, b) => b.margemBrutaTotalEur - a.margemBrutaTotalEur);
  const byFat = [...mesesFormatados].sort((a, b) => b.faturacaoTotalEur - a.faturacaoTotalEur);

  const melhorMesMargem = byMargem[0];
  const piorMesMargem = byMargem[byMargem.length - 1];
  const melhorMesFaturacao = byFat[0];

  const totalFat = mesesFormatados.reduce((s, m) => s + m.faturacaoTotalEur, 0);
  const totalMargem = mesesFormatados.reduce((s, m) => s + m.margemBrutaTotalEur, 0);
  const totalUnid = mesesFormatados.reduce((s, m) => s + m.unidadesTotal, 0);

  const mediaMensalMargemEur = mesesFormatados.length > 0 ? Math.round((totalMargem / mesesFormatados.length) * 100) / 100 : 0;
  const mediaMensalFaturacaoEur = mesesFormatados.length > 0 ? Math.round((totalFat / mesesFormatados.length) * 100) / 100 : 0;

  return {
    farmacia: ctx.farmaciaNome,
    totalMesesAnalisados: mesesFormatados.length,
    destaquesGerais: {
      melhorMesMargem: {
        mes: melhorMesMargem?.mes,
        margemBrutaEur: melhorMesMargem?.margemBrutaTotalEur,
        faturacaoEur: melhorMesMargem?.faturacaoTotalEur,
        margemPct: melhorMesMargem?.margemBrutaPct,
        unidades: melhorMesMargem?.unidadesTotal,
        fatoresChave: [
          `Pico de volume de vendas com ${melhorMesMargem?.unidadesTotal} embalagens dispensadas.`,
          `Forte contributo da categoria ${melhorMesMargem?.topCategorias[0]?.macroArea} com €${melhorMesMargem?.topCategorias[0]?.margemBrutaEur} (${melhorMesMargem?.topCategorias[0]?.pesoNaMargemPct}% do lucro bruto total).`,
          `Medicamento/artigo mais lucrativo do mês: ${melhorMesMargem?.topProdutos[0]?.designacao} (€${melhorMesMargem?.topProdutos[0]?.margemBrutaEur} de margem).`,
        ],
      },
      melhorMesFaturacao: {
        mes: melhorMesFaturacao?.mes,
        faturacaoEur: melhorMesFaturacao?.faturacaoTotalEur,
        margemBrutaEur: melhorMesFaturacao?.margemBrutaTotalEur,
      },
      piorMesMargem: {
        mes: piorMesMargem?.mes,
        margemBrutaEur: piorMesMargem?.margemBrutaTotalEur,
        faturacaoEur: piorMesMargem?.faturacaoTotalEur,
        nota: piorMesMargem?.mes === '2026-10' ? 'Mês incompleto / extração parcial de dados' : 'Mês de menor volume',
      },
      mediaMensalFaturacaoEur,
      mediaMensalMargemEur,
      totaisPeriodo: {
        faturacaoTotalEur: Math.round(totalFat * 100) / 100,
        margemBrutaTotalEur: Math.round(totalMargem * 100) / 100,
        margemMediaPct: totalFat > 0 ? Math.round((totalMargem / totalFat) * 1000) / 10 : 0,
        unidadesTotal: totalUnid,
      },
    },
    evolucaoMensal: mesesFormatados,
  };
}

// Helper para normalizar inputs de períodos (ex: "outubro de 2026", "2026-10", "setembro")
export function normalizePeriodInput(input?: string): string {
  if (!input) return '';
  const s = input.trim().toLowerCase();

  // YYYY-MM ou YYYY/MM ou YYYY.MM
  const isoMatch = s.match(/(\d{4})[-/. ](\d{1,2})/);
  if (isoMatch) {
    const year = isoMatch[1];
    const month = isoMatch[2].padStart(2, '0');
    return `${year}-${month}`;
  }

  // MM-YYYY ou MM/YYYY
  const reverseMatch = s.match(/(\d{1,2})[-/. ](\d{4})/);
  if (reverseMatch) {
    const month = reverseMatch[1].padStart(2, '0');
    const year = reverseMatch[2];
    return `${year}-${month}`;
  }

  const monthNames: Record<string, string> = {
    janeiro: '01', jan: '01',
    fevereiro: '02', fev: '02',
    marco: '03', 'março': '03', mar: '03',
    abril: '04', abr: '04',
    maio: '05', mai: '05',
    junho: '06', jun: '06',
    julho: '07', jul: '07',
    agosto: '08', ago: '08',
    setembro: '09', set: '09',
    outubro: '10', out: '10',
    novembro: '11', nov: '11',
    dezembro: '12', dez: '12',
  };

  let foundMonth = '';
  for (const [name, num] of Object.entries(monthNames)) {
    if (s.includes(name)) {
      foundMonth = num;
      break;
    }
  }

  const yearMatch = s.match(/\b(20\d\d)\b/);
  const year = yearMatch ? yearMatch[1] : '2026';

  if (foundMonth) {
    return `${year}-${foundMonth}`;
  }

  return input.trim();
}

// ============================================================================
// 15C. COMPARAR PERFORMANCE FINANCEIRA ENTRE DOIS PERÍODOS
// ============================================================================
export async function toolCompararPerformancePeriodos(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    periodo_a: string; // ex: "2026-07" ou "outubro 2026"
    periodo_b: string; // ex: "2026-06" ou "setembro 2026"
  }
) {
  const pA = normalizePeriodInput(args.periodo_a);
  const pB = normalizePeriodInput(args.periodo_b);

  // Executa evolução mensal completa
  const dadosGerais = await toolAnalisarEvolucaoMensalFinanceira(prisma, ctx, { ordenar_por: 'CRONOLOGICO' });
  const mesesList = dadosGerais.evolucaoMensal || [];
  const stA = mesesList.find((m: any) => m.mes === pA);
  const stB = mesesList.find((m: any) => m.mes === pB);

  if (!stA || !stB) {
    return {
      error: `Um ou ambos os períodos não foram encontrados nos registos da farmácia (${args.periodo_a} -> ${pA}: ${stA ? 'Encontrado' : 'Não encontrado'}, ${args.periodo_b} -> ${pB}: ${stB ? 'Encontrado' : 'Não encontrado'}). Meses disponíveis: ${mesesList.map((m: any) => m.mes).join(', ')}`,
    };
  }

  const deltaFatEur = Math.round((stA.faturacaoTotalEur - stB.faturacaoTotalEur) * 100) / 100;
  const deltaFatPct = stB.faturacaoTotalEur > 0 ? Math.round((deltaFatEur / stB.faturacaoTotalEur) * 1000) / 10 : 0;

  const deltaMargemEur = Math.round((stA.margemBrutaTotalEur - stB.margemBrutaTotalEur) * 100) / 100;
  const deltaMargemPct = stB.margemBrutaTotalEur > 0 ? Math.round((deltaMargemEur / stB.margemBrutaTotalEur) * 1000) / 10 : 0;

  const deltaUnid = stA.unidadesTotal - stB.unidadesTotal;
  const deltaUnidPct = stB.unidadesTotal > 0 ? Math.round((deltaUnid / stB.unidadesTotal) * 1000) / 10 : 0;

  const deltaMargemPontosPct = Math.round((stA.margemBrutaPct - stB.margemBrutaPct) * 10) / 10;

  // Comparação detalhada produto a produto
  const mapA = (stA as any).produtosMap as Map<string, { cnp: string; designacao: string; margemEur: number; faturacaoEur: number; unidades: number }> | undefined;
  const mapB = (stB as any).produtosMap as Map<string, { cnp: string; designacao: string; margemEur: number; faturacaoEur: number; unidades: number }> | undefined;

  const allCnps = new Set<string>();
  if (mapA) for (const k of mapA.keys()) allCnps.add(k);
  if (mapB) for (const k of mapB.keys()) allCnps.add(k);

  const diffProdutos: any[] = [];
  for (const cnp of allCnps) {
    const itemA = mapA?.get(cnp);
    const itemB = mapB?.get(cnp);
    const designacao = itemA?.designacao || itemB?.designacao || cnp;
    const unidA = itemA?.unidades || 0;
    const unidB = itemB?.unidades || 0;
    const fatA = itemA?.faturacaoEur || 0;
    const fatB = itemB?.faturacaoEur || 0;
    const margemA = itemA?.margemEur || 0;
    const margemB = itemB?.margemEur || 0;

    const deltaUnidProd = unidA - unidB;
    const deltaFatProd = Math.round((fatA - fatB) * 100) / 100;
    const deltaMargemProd = Math.round((margemA - margemB) * 100) / 100;

    diffProdutos.push({
      cnp,
      designacao,
      unidadesPeriodoA: unidA,
      unidadesPeriodoB: unidB,
      variacaoUnidades: deltaUnidProd,
      faturacaoPeriodoAEur: Math.round(fatA * 100) / 100,
      faturacaoPeriodoBEur: Math.round(fatB * 100) / 100,
      variacaoFaturacaoEur: deltaFatProd,
      variacaoMargemEur: deltaMargemProd,
    });
  }

  // Top produtos que mais aumentaram vendas em Faturação (€)
  const produtosComMaiorAumentoVendas = [...diffProdutos]
    .filter((p) => p.variacaoFaturacaoEur > 0 || p.variacaoUnidades > 0)
    .sort((a, b) => b.variacaoFaturacaoEur - a.variacaoFaturacaoEur)
    .slice(0, 10);

  // Top produtos que mais aumentaram vendas em Volume (Unidades)
  const produtosComMaiorAumentoVolume = [...diffProdutos]
    .filter((p) => p.variacaoUnidades > 0)
    .sort((a, b) => b.variacaoUnidades - a.variacaoUnidades)
    .slice(0, 10);

  // Top produtos com maior queda de vendas em Faturação (€)
  const produtosComMaiorQuedaVendas = [...diffProdutos]
    .filter((p) => p.variacaoFaturacaoEur < 0 || p.variacaoUnidades < 0)
    .sort((a, b) => a.variacaoFaturacaoEur - b.variacaoFaturacaoEur)
    .slice(0, 10);

  return {
    farmacia: ctx.farmaciaNome,
    periodoA: stA.mes,
    periodoB: stB.mes,
    comparativo: {
      faturacao: {
        periodoA: stA.faturacaoTotalEur,
        periodoB: stB.faturacaoTotalEur,
        variacaoEur: deltaFatEur,
        variacaoPct: deltaFatPct,
      },
      margemBruta: {
        periodoAEur: stA.margemBrutaTotalEur,
        periodoBEur: stB.margemBrutaTotalEur,
        variacaoEur: deltaMargemEur,
        variacaoPct: deltaMargemPct,
        margemPctA: stA.margemBrutaPct,
        margemPctB: stB.margemBrutaPct,
        variacaoPontosMargem: deltaMargemPontosPct,
      },
      unidades: {
        periodoA: stA.unidadesTotal,
        periodoB: stB.unidadesTotal,
        variacaoUnid: deltaUnid,
        variacaoPct: deltaUnidPct,
      },
    },
    topCategoriasPeriodoA: stA.topCategorias,
    topCategoriasPeriodoB: stB.topCategorias,
    produtosComMaiorAumentoVendas,
    produtosComMaiorAumentoVolume,
    produtosComMaiorQuedaVendas,
    diagnosticoExplicativo: `No comparativo de ${stA.mes} face a ${stB.mes}, a faturação variou €${deltaFatEur > 0 ? '+' : ''}${deltaFatEur} (${deltaFatPct > 0 ? '+' : ''}${deltaFatPct}%), a margem bruta variou €${deltaMargemEur > 0 ? '+' : ''}${deltaMargemEur} (${deltaMargemPct > 0 ? '+' : ''}${deltaMargemPct}%), com uma variação de volume de ${deltaUnid > 0 ? '+' : ''}${deltaUnid} embalagens.`,
  };
}

// ============================================================================
// 15C-2. AUDITORIA DE ESCOAMENTO, REATIVAÇÃO DE MONOS E DESTRAVE DE CAPITAL
// ============================================================================
export async function toolAuditarEscoamentoEDestraveStock(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    mes_venda: string; // ex: "2026-10" ou "outubro 2026"
    meses_parado_minimo?: number; // ex: 2, 3, 6 (default: 3)
    parado_desde?: string; // ex: "2026-08", "agosto"
    apenas_eliminados_a_zero?: boolean;
    excluir_sazonais?: boolean;
    limite_produtos?: number;
  }
) {
  const mesVenda = normalizePeriodInput(args.mes_venda);
  if (!mesVenda || !/^\d{4}-\d{2}$/.test(mesVenda)) {
    return {
      error: `Mês de venda inválido: "${args.mes_venda}". Forneça no formato YYYY-MM (ex: "2026-10" ou "outubro 2026").`,
    };
  }

  const [vYearStr, vMonthStr] = mesVenda.split('-');
  const vYear = parseInt(vYearStr, 10);
  const vMonth = parseInt(vMonthStr, 10);

  // Calcula os meses de inatividade que definem o "mono"
  let mesesInativos: string[] = [];

  if (args.parado_desde) {
    const pDesde = normalizePeriodInput(args.parado_desde);
    if (pDesde && /^\d{4}-\d{2}$/.test(pDesde) && pDesde < mesVenda) {
      const [sy, sm] = pDesde.split('-').map(Number);
      let curY = sy;
      let curM = sm;
      while (curY < vYear || (curY === vYear && curM < vMonth)) {
        mesesInativos.push(`${curY}-${String(curM).padStart(2, '0')}`);
        curM += 1;
        if (curM > 12) {
          curM = 1;
          curY += 1;
        }
      }
    }
  }

  // Critério canónico de Mono em farmácia (>= 3 meses / 90 dias de paragem)
  // Se o utilizador não especificar meses_parado_minimo explicitamente, assegura pelo menos 3 meses
  const minMeses = args.meses_parado_minimo !== undefined ? Math.max(args.meses_parado_minimo, 1) : 3;
  if (mesesInativos.length < minMeses) {
    let curY = vYear;
    let curM = vMonth;
    mesesInativos = [];
    for (let i = 0; i < minMeses; i++) {
      curM -= 1;
      if (curM === 0) {
        curM = 12;
        curY -= 1;
      }
      mesesInativos.push(`${curY}-${String(curM).padStart(2, '0')}`);
    }
  }

  // 1. Carrega todas as vendas da farmácia
  const vendasRaw = await prisma.venda.findMany({
    where: { farmaciaId: ctx.farmaciaId },
    select: { cnp_codigo: true, quantidade: true, valor_total: true, data_venda: true },
  });

  if (vendasRaw.length === 0) {
    return {
      farmacia: ctx.farmaciaNome,
      mensagem: 'Não existem registos de vendas para analisar nesta farmácia.',
    };
  }

  // 2. Mapeamento de produtos e preços de referência
  const prods = await prisma.produtoMestre.findMany({
    select: {
      cnp_codigo: true,
      designacao: true,
      dci: true,
      categoria: true,
      subcategoria: true,
      macro_area: true,
      tipo_venda: true,
      indicacoes_clinicas: true,
      pvp: true,
      margem_padrao: true,
    },
  });
  const prodMap = new Map(prods.map((p) => [p.cnp_codigo, p]));

  const precos = await prisma.precoFarmacia.findMany({
    where: { farmaciaId: ctx.farmaciaId },
    select: { cnp_codigo: true, pvp: true, custo_ref: true },
  });
  const precoMap = new Map(precos.map((p) => [p.cnp_codigo, { pvp: Number(p.pvp || 0), custo: Number(p.custo_ref || 0) }]));

  // 3. Stock físico atual na farmácia
  const inventarios = await prisma.inventario.findMany({
    where: { farmaciaId: ctx.farmaciaId },
    select: { cnp_codigo: true, quantidade: true, custo_unitario: true },
  });
  const stockMap = new Map<string, { qtd: number; custo: number }>();
  for (const inv of inventarios) {
    const cur = stockMap.get(inv.cnp_codigo) || { qtd: 0, custo: Number(inv.custo_unitario || 0) };
    cur.qtd += inv.quantidade;
    stockMap.set(inv.cnp_codigo, cur);
  }

  // 4. Agrupa vendas por CNP e Mês
  const salesMap = new Map<string, Map<string, { qtd: number; valor: number }>>();
  for (const v of vendasRaw) {
    const mesKey = v.data_venda.toISOString().slice(0, 7);
    if (!salesMap.has(v.cnp_codigo)) salesMap.set(v.cnp_codigo, new Map());
    const m = salesMap.get(v.cnp_codigo)!;
    const cur = m.get(mesKey) || { qtd: 0, valor: 0 };
    cur.qtd += Number(v.quantidade || 0);
    cur.valor += Number(v.valor_total || 0);
    m.set(mesKey, cur);
  }

  // 5. Filtrar produtos reativados
  const limite = Math.min(Math.max(args.limite_produtos || 20, 1), 100);
  const reativados: any[] = [];

  for (const [cnp, months] of salesMap.entries()) {
    const vendaAlvo = months.get(mesVenda);
    if (!vendaAlvo || vendaAlvo.qtd <= 0) continue;

    // Verificar se esteve rigorosamente sem vendas em TODOS os meses de inatividade
    let teveVendaInativo = false;
    for (const mInativo of mesesInativos) {
      const v = months.get(mInativo);
      if (v && v.qtd > 0) {
        teveVendaInativo = true;
        break;
      }
    }
    if (teveVendaInativo) continue;

    const pInfo = prodMap.get(cnp);
    const prInfo = precoMap.get(cnp);
    const invInfo = stockMap.get(cnp);

    let custoUnit = 0;
    if (prInfo && prInfo.custo > 0) custoUnit = prInfo.custo;
    else if (invInfo && invInfo.custo > 0) custoUnit = invInfo.custo;
    else if (pInfo && pInfo.pvp && pInfo.margem_padrao) {
      custoUnit = Number(pInfo.pvp) * (1 - Number(pInfo.margem_padrao) / 100);
    } else {
      custoUnit = (vendaAlvo.valor / (vendaAlvo.qtd || 1)) * 0.7;
    }

    const designacao = pInfo?.designacao || cnp;
    const isSazonal = /gripe|griponal|ilvico|pastilha|tosse|broncho-vaxom|solar|spf|repelente/i.test(designacao);
    if (args.excluir_sazonais && isSazonal) continue;

    const stockAtual = invInfo?.qtd || 0;
    const eliminadoTotalmente = stockAtual === 0;
    if (args.apenas_eliminados_a_zero && !eliminadoTotalmente) continue;

    const capitalRecuperadoEur = Math.round(vendaAlvo.qtd * custoUnit * 100) / 100;
    const faturacaoEur = Math.round(vendaAlvo.valor * 100) / 100;
    const margemEur = Math.round((faturacaoEur - capitalRecuperadoEur) * 100) / 100;

    const macroArea = pInfo?.macro_area || (pInfo?.tipo_venda === 'MSRM' ? 'MSRM' : 'OUTRO');
    const ehMsrmOuVacina = macroArea === 'MSRM' || /vacina|injetavel|insulina/i.test(designacao);

    // Classificação operacional factual
    let tipoClassificacao = '';
    let recomendacaoOperacional = '';
    if (eliminadoTotalmente) {
      if (ehMsrmOuVacina) {
        tipoClassificacao = 'Stock 0 un (MSRM)';
        recomendacaoOperacional = 'Verificar se existe prescrição ativa habitual antes de repor.';
      } else {
        tipoClassificacao = 'Stock 0 un (Liquidado)';
        recomendacaoOperacional = 'Stock totalmente escoado.';
      }
    } else {
      tipoClassificacao = `Resta stock (${stockAtual} un)`;
      recomendacaoOperacional = ehMsrmOuVacina
        ? `Restam ${stockAtual} un; priorizar dispensa desta embalagem perante receita médica.`
        : `Restam ${stockAtual} un em stock.`;
    }

    reativados.push({
      cnp,
      designacao,
      dci: pInfo?.dci || null,
      macroArea,
      categoria: pInfo?.categoria || 'Medicamentos',
      subcategoria: pInfo?.subcategoria || null,
      indicacoesClinicas: pInfo?.indicacoes_clinicas || null,
      mesesInativo: mesesInativos.length,
      periodoParado: `${mesesInativos[mesesInativos.length - 1]} a ${mesesInativos[0]}`,
      unidadesVendidas: vendaAlvo.qtd,
      custoUnitarioEur: Math.round(custoUnit * 100) / 100,
      capitalRecuperadoEur,
      faturacaoEur,
      margemEur,
      stockAtual,
      eliminadoTotalmente,
      ehSazonal: isSazonal,
      tipoClassificacao,
      recomendacaoOperacional,
    });
  }

  // Ordenar por capital recuperado decrescente
  reativados.sort((a, b) => b.capitalRecuperadoEur - a.capitalRecuperadoEur);

  const totalUnidades = reativados.reduce((s, i) => s + i.unidadesVendidas, 0);
  const totalCapitalRecuperado = reativados.reduce((s, i) => s + i.capitalRecuperadoEur, 0);
  const totalFaturacao = reativados.reduce((s, i) => s + i.faturacaoEur, 0);
  const totalEliminados = reativados.filter((i) => i.eliminadoTotalmente).length;

  const descInat = mesesInativos.length === 1
    ? `mês anterior (${mesesInativos[0]})`
    : `${mesesInativos.length} meses (${mesesInativos[mesesInativos.length - 1]} a ${mesesInativos[0]})`;

  return {
    farmacia: ctx.farmaciaNome,
    mesVenda,
    criterioInatividade: {
      mesesAvaliados: mesesInativos,
      descricao: `Sem vendas durante ${descInat}`,
    },
    resumoExecutivo: {
      totalArtigosReativados: reativados.length,
      totalUnidadesVendidas: totalUnidades,
      totalCapitalRecuperadoEur: Math.round(totalCapitalRecuperado * 100) / 100,
      totalFaturacaoGeradaEur: Math.round(totalFaturacao * 100) / 100,
      totalMargemGeradaEur: Math.round((totalFaturacao - totalCapitalRecuperado) * 100) / 100,
      artigosTotalmenteEliminadosCount: totalEliminados,
      artigosComStockResidualCount: reativados.length - totalEliminados,
    },
    topArtigosDescongelados: reativados.slice(0, limite),
    artigosEliminadosTotalmente: reativados.filter((i) => i.eliminadoTotalmente).slice(0, limite),
    diagnosticoExplicativo: `Em ${mesVenda}, foram vendidos ${totalUnidades} unidades de ${reativados.length} artigos que estavam inativos há ${descInat}, libertando €${totalCapitalRecuperado.toFixed(2)} de capital de custo imobilizado (€${totalFaturacao.toFixed(2)} em faturação). Desses, ${totalEliminados} produtos foram totalmente esgotados na gaveta (stock final = 0 un).`,
  };
}

// ============================================================================
// 15D. CÁLCULO DE PERDAS FINANCEIRAS E CUSTO DE OPORTUNIDADE (RUTURAS & MONOS)
// ============================================================================
export async function toolCalcularPerdasFinanceirasECustoOportunidade(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    tipo_auditoria?: 'TODAS' | 'RUTURAS_CLASSE_A' | 'MONOS_CAPITAL_PARADO' | 'VALIDADES_RISCO';
  }
) {
  const tipo = args.tipo_auditoria || 'TODAS';
  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);

  // 1. Ruturas em Artigos Classe A ou com VMM > 0 (Custo de oportunidade estimado a 30 dias)
  const itensComVenda = catalog.filter((it) => it.vendasQtd > 0);
  const totalFat = itensComVenda.reduce((s, it) => s + it.faturacao, 0);

  // Ordena por faturação para achar Classe A (80% acumulado)
  const sortedByFat = [...itensComVenda].sort((a, b) => b.faturacao - a.faturacao);
  let acum = 0;
  const classeACnps = new Set<string>();
  for (const it of sortedByFat) {
    acum += it.faturacao;
    classeACnps.add(it.cnp);
    if (totalFat > 0 && (acum / totalFat) >= 0.8) break;
  }

  const ruturasClasseA = catalog.filter((it) => it.stock === 0 && classeACnps.has(it.cnp));
  const perdasRutura30dias = ruturasClasseA.map((it) => {
    const vmm = it.vendasQtd / 12.0;
    const margemUnit = Math.max(it.pvp - it.custo, 0);
    const perdaFaturacao30d = Math.round(vmm * it.pvp * 100) / 100;
    const perdaMargem30d = Math.round(vmm * margemUnit * 100) / 100;
    return {
      cnp: it.cnp,
      designacao: it.designacao,
      tipoVenda: it.tipoVenda,
      vendasAnuaisQtd: it.vendasQtd,
      vmm: Math.round(vmm * 10) / 10,
      pvp: it.pvp,
      margemUnitEur: Math.round(margemUnit * 100) / 100,
      perdaFaturacaoEstimada30dEur: perdaFaturacao30d,
      perdaMargemEstimada30dEur: perdaMargem30d,
    };
  }).sort((a, b) => b.perdaMargemEstimada30dEur - a.perdaMargemEstimada30dEur);

  const totalPerdaMargemRuturas = perdasRutura30dias.reduce((s, it) => s + it.perdaMargemEstimada30dEur, 0);
  const totalPerdaFaturacaoRuturas = perdasRutura30dias.reduce((s, it) => s + it.perdaFaturacaoEstimada30dEur, 0);

  // 2. Monos & Capital Imobilizado (Stock > 0 e 0 vendas nos 12 meses)
  const monos = catalog.filter((it) => it.stock > 0 && (it.vendasQtd === 0 || it.faturacao === 0));
  const totalCapitalParadoMonos = monos.reduce((s, it) => s + (it.stock * it.custo), 0);
  const topMonos = [...monos].sort((a, b) => (b.stock * b.custo) - (a.stock * a.custo)).slice(0, 15).map((it) => ({
    cnp: it.cnp,
    designacao: it.designacao,
    stock: it.stock,
    custoUnit: it.custo,
    capitalImobilizadoEur: Math.round((it.stock * it.custo) * 100) / 100,
  }));

  return {
    farmacia: ctx.farmaciaNome,
    tipoAuditoria: tipo,
    resumoFinanceiro: {
      ruturasClasseA: {
        totalArtigosEsgotados: ruturasClasseA.length,
        perdaFaturacaoEstimadaMensalEur: Math.round(totalPerdaFaturacaoRuturas * 100) / 100,
        perdaMargemEstimadaMensalEur: Math.round(totalPerdaMargemRuturas * 100) / 100,
      },
      monosCapitalImobilizado: {
        totalArtigosSemRotacao: monos.length,
        capitalTotalParadoEur: Math.round(totalCapitalParadoMonos * 100) / 100,
      },
    },
    topRuturasCriticas: perdasRutura30dias.slice(0, 10),
    topCapitalParado: topMonos,
  };
}


// ============================================================================
// 16. CONSULTAR PROGRESSO DAS TAREFAS DA EQUIPA (FOLHA DA SEMANA & MOBILE)
// ============================================================================
export async function toolConsultarProgressoTarefasEquipa(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { semana?: string; apenas_pendentes?: boolean; limite?: number }
) {
  const { getCurrentWeekKey } = await import('./weekly_tasks');
  const weekKey = args.semana || getCurrentWeekKey();
  const apenasPendentes = args.apenas_pendentes ?? false;
  const limite = args.limite || 20;

  const tarefas = await prisma.tarefaEquipa.findMany({
    where: {
      farmaciaId: ctx.farmaciaId,
      week_key: weekKey,
      ...(apenasPendentes ? { concluido: false } : {}),
    },
    orderBy: [{ concluido: 'asc' }, { valor_impacto: 'desc' }],
  });

  const total = tarefas.length;
  const concluidas = tarefas.filter((t) => t.concluido).length;
  const pendentes = total - concluidas;
  const taxaConclusaoPct = total > 0 ? Number(((concluidas / total) * 100).toFixed(1)) : 0;

  const valorTotalImpacto = tarefas.reduce((s, t) => s + (t.valor_impacto ? Number(t.valor_impacto) : 0), 0);
  const valorConcluido = tarefas
    .filter((t) => t.concluido)
    .reduce((s, t) => s + (t.valor_impacto ? Number(t.valor_impacto) : 0), 0);

  // Agrupamento por Categoria
  const porCategoria: Record<string, { total: number; concluidas: number; valorTotal: number }> = {};
  for (const t of tarefas) {
    const cat = t.categoria || 'OUTRO';
    if (!porCategoria[cat]) porCategoria[cat] = { total: 0, concluidas: 0, valorTotal: 0 };
    porCategoria[cat].total++;
    if (t.concluido) porCategoria[cat].concluidas++;
    if (t.valor_impacto) porCategoria[cat].valorTotal += Number(t.valor_impacto);
  }

  // Colaboradores que mais marcaram tarefas
  const colaboradoresMap: Record<string, number> = {};
  for (const t of tarefas) {
    if (t.concluido && t.concluido_por) {
      colaboradoresMap[t.concluido_por] = (colaboradoresMap[t.concluido_por] || 0) + 1;
    }
  }

  return {
    farmacia: 'Farmácia Comunitária',
    semana: weekKey,
    resumo: {
      totalTarefas: total,
      tarefasConcluidas: concluidas,
      tarefasPendentes: pendentes,
      taxaConclusaoPct,
      valorTotalImpactoEur: Number(valorTotalImpacto.toFixed(2)),
      valorJaProtegidoEur: Number(valorConcluido.toFixed(2)),
    },
    desdobramentoPorArea: porCategoria,
    rankingColaboradores: colaboradoresMap,
    tarefasApresentadas: tarefas.slice(0, limite).map((t) => ({
      taskId: t.task_id,
      categoria: t.categoria,
      designacao: t.designacao || 'Sem descrição',
      cnp: t.cnp_codigo,
      concluido: t.concluido,
      concluidoPor: t.concluido_por,
      concluidoEm: t.concluido_em ? t.concluido_em.toISOString().slice(0, 16).replace('T', ' ') : null,
      valorImpactoEur: t.valor_impacto ? Number(t.valor_impacto) : null,
      campanhaId: t.campanha_id,
    })),
  };
}

// ============================================================================
// 17. CRIAR TAREFA OPERACIONAL NA FOLHA DA SEMANA
// ============================================================================
export async function toolCriarTarefaEquipa(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    descricao: string;
    categoria?: string;
    cnp_codigo?: string;
    valor_impacto?: number;
    campanha_id?: string;
  }
) {
  const { getCurrentWeekKey } = await import('./weekly_tasks');
  const weekKey = getCurrentWeekKey();
  const cat = args.categoria || 'DIRECAO_TECNICA';
  const taskId = `MANUAL_${Date.now()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  const tarefa = await prisma.tarefaEquipa.create({
    data: {
      farmaciaId: ctx.farmaciaId,
      week_key: weekKey,
      task_id: taskId,
      categoria: cat,
      designacao: args.descricao,
      cnp_codigo: args.cnp_codigo || null,
      campanha_id: args.campanha_id || null,
      concluido: false,
      concluido_por: null,
      valor_impacto: args.valor_impacto !== undefined ? Number(args.valor_impacto) : null,
    },
  });

  return {
    success: true,
    taskId: tarefa.task_id,
    semana: weekKey,
    descricao: tarefa.designacao,
    categoria: tarefa.categoria,
    mensagem: `✅ Tarefa criada com sucesso na Folha da Semana da Equipa: "${tarefa.designacao}"`,
  };
}

// ============================================================================
// 18. CONSULTAR CAMPANHAS ATIVAS E HISTÓRICO NO ESTÚDIO DE MARKETING
// ============================================================================
export async function toolConsultarCampanhasAtivasEHistorico(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args?: { incluir_historico?: boolean }
) {
  const { getActiveCampaigns } = await import('./active_campaigns');
  const { getSeasonalCampaignSuggestions } = await import('./campaigns');

  const ativas = await getActiveCampaigns(prisma, ctx.farmaciaId);

  let historico: any[] = [];
  if (args && args.incluir_historico) {
    historico = await prisma.campanhaAtiva.findMany({
      where: {
        farmaciaId: ctx.farmaciaId,
        estado: { in: ['CONCLUIDA', 'CANCELADA'] },
      },
      orderBy: { criadoEm: 'desc' },
      take: 10,
    });
  }

  // Sugestões do motor para o mês atual
  const sugestoes = await getSeasonalCampaignSuggestions(prisma, ctx.farmaciaId);

  return {
    farmacia: 'Farmácia Comunitária',
    totalCampanhasAtivas: ativas.length,
    campanhasAtivas: ativas.map((c) => ({
      id: c.id,
      campanhaId: c.campanhaId,
      titulo: c.titulo,
      icone: c.icone,
      dataInicio: c.dataInicio,
      dataFim: c.dataFim,
      descontoAplicadoPct: c.descontoAplicadoPct,
      totalProdutos: c.totalProdutos,
      topProdutosAprovados: c.produtos.slice(0, 5).map((p: any) => ({
        cnp: p.cnp_codigo,
        designacao: p.designacao,
        stock: p.stock_atual,
        pvpNormalEur: p.pvp_atual,
        pvpPromocionalEur: p.pvp_campanha,
        margemPct: p.margem_pct,
      })),
    })),
    sugestoesDisponiveisNoEstudio: sugestoes.slice(0, 5).map((s) => ({
      id: s.campanha.id,
      titulo: s.campanha.titulo,
      icone: s.campanha.icone,
      epoca: s.campanha.epoca,
      totalProdutosElegiveis: s.totalArtigosDisponiveis,
      unidadesStock: s.totalUnidadesStock,
      descontoSugeridoPct: s.campanha.descontoSugeridoPct,
    })),
    historicoConcluidas: historico.map((h) => ({
      id: h.id,
      titulo: h.titulo,
      estado: h.estado,
      dataInicio: h.dataInicio.toISOString().slice(0, 10),
      dataFim: h.dataFim ? h.dataFim.toISOString().slice(0, 10) : null,
    })),
  };
}

// ============================================================================
// 18.1. CONSULTAR DESEMPENHO E VENDAS DE CAMPANHAS (ESPECÍFICO VS GLOBAL)
// ============================================================================
export async function toolConsultarDesempenhoCampanhas(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args?: {
    campanha_id?: string;
    incluir_concluidas?: boolean;
    data_inicio?: string;
    data_fim?: string;
  }
) {
  const { toolConsultarDesempenhoCampanhas: runAudit } = await import('./copilot_semantic_layer');
  return runAudit(prisma, ctx, args || {});
}

// ============================================================================
// 19. ATIVAR CAMPANHA NA FARMÁCIA (GERANDO TAREFAS AUTOMÁTICAS P/ EQUIPA)
// ============================================================================
export async function toolAtivarCampanhaFarmacia(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    campanha_id?: string;
    titulo?: string;
    icone?: string;
    tema_ou_evento?: string;
    tema_ou_categoria?: string;
    produtos_cnps?: string[];
    cnps_especificos?: string[];
    foco_stock?: 'TODOS_ELEGIVEIS' | 'PRIORIDADE_VALIDADES_MONOS' | 'SO_VALIDADES_E_MONOS';
    desconto_pct?: number;
    dias_duracao?: number;
    criado_por?: string;
  }
) {
  const cnpsList = args.produtos_cnps || args.cnps_especificos || [];
  if (cnpsList.length > 0) {
    const msrmFound = await prisma.produtoMestre.findMany({
      where: { cnp_codigo: { in: cnpsList }, tipo_venda: 'MSRM' },
      select: { cnp_codigo: true, designacao: true },
    });
    if (msrmFound.length > 0) {
      return {
        ok: false,
        success: false,
        erro: {
          codigo: 'REGRA_LEGAL_VIOLADA',
          mensagem: `Proibido incluir medicamentos MSRM em campanhas ou descontos: ${msrmFound
            .map((m) => `${m.cnp_codigo} (${m.designacao})`)
            .join(', ')}.`,
        },
      };
    }
  }
  if (!args.tema_ou_evento && args.tema_ou_categoria) {
    args.tema_ou_evento = args.tema_ou_categoria;
  }
  if (!args.produtos_cnps && args.cnps_especificos) {
    args.produtos_cnps = args.cnps_especificos;
  }
  const { activateCampaign } = await import('./active_campaigns');
  const { getSeasonalCampaignSuggestions } = await import('./campaigns');

  const sugestoes = await getSeasonalCampaignSuggestions(prisma, ctx.farmaciaId);
  let tituloFinal = args.titulo || 'Campanha Personalizada da Farmácia';
  let iconeFinal = args.icone || '🎯';
  let campanhaIdFinal = args.campanha_id || `custom_${Date.now()}`;
  let produtosSugeridos: any[] = [];
  let descPct = args.desconto_pct || 15;

  if (args.campanha_id && args.campanha_id !== 'custom') {
    const encontrada = sugestoes.find((s) => s.campanha.id === args.campanha_id || s.campanha.id.includes(args.campanha_id!));
    if (encontrada) {
      tituloFinal = encontrada.campanha.titulo;
      iconeFinal = encontrada.campanha.icone;
      campanhaIdFinal = encontrada.campanha.id;
      descPct = args.desconto_pct || encontrada.campanha.descontoSugeridoPct || 15;
      produtosSugeridos = encontrada.produtosSugeridos;
    }
  }

  if (produtosSugeridos.length === 0) {
    const { buildCustomCampaign } = await import('./campaigns');
    const customResult = await buildCustomCampaign(prisma, ctx.farmaciaId, {
      modo: (args.produtos_cnps && args.produtos_cnps.length > 0) ? 'PRODUTOS' : 'EVENTO',
      eventoPreset: (args.tema_ou_evento as any) || 'custom',
      nomePersonalizado: args.titulo,
      termosPesquisa: args.tema_ou_evento,
      cnpsSelecionados: args.produtos_cnps,
      focoStock: args.foco_stock || 'PRIORIDADE_VALIDADES_MONOS',
      descontoDesejadoPct: descPct,
    });

    if (!customResult || !customResult.produtosSugeridos || customResult.produtosSugeridos.length === 0) {
      return {
        success: false,
        mensagem: `Não foi possível encontrar produtos elegíveis para montar a campanha "${args.titulo || args.tema_ou_evento || 'personalizada'}". Verifique o stock da farmácia ou os CNPs indicados.`,
      };
    }

    tituloFinal = customResult.campanha.titulo;
    iconeFinal = customResult.campanha.icone;
    campanhaIdFinal = customResult.campanha.id;
    descPct = args.desconto_pct || customResult.campanha.descontoSugeridoPct || 15;
    produtosSugeridos = customResult.produtosSugeridos;
  }

  const discount = descPct / 100;

  const produtosFormatados = produtosSugeridos.map((p) => {
    const pvpNormal = p.pvp || (p.custo_unitario * 1.5);
    const pvpCampanha = Number((pvpNormal * (1 - discount)).toFixed(2));
    const taxaIva = (p as any).taxa_iva || 0.23;
    const custoComIva = p.custo_unitario * (1 + taxaIva);
    const margemPct = Number((((pvpCampanha - custoComIva) / pvpCampanha) * 100).toFixed(1));

    return {
      cnp_codigo: p.cnp_codigo,
      designacao: p.designacao,
      laboratorio_titular: (p as any).laboratorio_titular,
      stock_atual: p.stock_atual,
      custo_unitario: p.custo_unitario,
      pvp_atual: pvpNormal,
      pvp_campanha: pvpCampanha,
      desconto_pct: descPct,
      margem_pct: margemPct,
    };
  });

  const res = await activateCampaign(prisma, {
    farmaciaId: ctx.farmaciaId,
    campanhaId: campanhaIdFinal,
    titulo: tituloFinal,
    icone: iconeFinal,
    descontoPct: descPct,
    produtos: produtosFormatados,
    diasDuracao: args.dias_duracao || 15,
    criadoPor: args.criado_por || 'Copilot (Direção Técnica)',
  });

  return {
    success: true,
    campanhaAtivada: {
      id: res.campanhaAtiva.id,
      campanhaId: res.campanhaAtiva.campanhaId,
      titulo: res.campanhaAtiva.titulo,
      icone: res.campanhaAtiva.icone,
      descontoPct: descPct,
      totalProdutos: produtosFormatados.length,
      dataFim: res.campanhaAtiva.dataFim ? res.campanhaAtiva.dataFim.toISOString().slice(0, 10) : null,
      produtosDestaque: produtosFormatados.slice(0, 5).map((p) => ({
        cnp: p.cnp_codigo,
        designacao: p.designacao,
        stock: p.stock_atual,
        pvpNormal: p.pvp_atual,
        pvpPromo: p.pvp_campanha,
        margemPct: p.margem_pct,
      })),
    },
    tarefasGeradasParaEquipa: res.tarefasCriadas,
    mensagem: `🎯 Campanha "${res.campanhaAtiva.titulo}" ATIVADA com sucesso na Farmácia! Foram geradas ${res.tarefasCriadas} tarefas operacionais na Folha da Semana e na interface mobile da equipa.`,
  };
}

/**
 * 23. Sugerir Venda Cruzada e Produtos Complementares Seguros (Base de Dados Rica)
 */
export async function toolSugerirVendaCruzadaEComplementares(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { cnp: string; limite?: number }
) {
  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const target = catalog.find((i) => i.cnp === args.cnp.trim());

  if (!target) {
    return {
      success: false,
      mensagem: `Artigo com CNP ${args.cnp} não encontrado no inventário da farmácia ${ctx.farmaciaNome}.`,
    };
  }

  const sugestoes = getSmartCrossSelling(target.cnp, catalog, args.limite || 5);

  return {
    success: true,
    produtoAlvo: {
      cnp: target.cnp,
      designacao: target.designacao,
      dci: target.dci,
      dosagem: target.dosagem,
      laboratorio: target.laboratorioTitular,
      categoria: target.categoria,
      papel: target.papelRecomendacao,
      stock: target.stock,
      pvp: target.pvp,
      margemPct: target.margem,
    },
    totalSugestoes: sugestoes.length,
    sugestoesComplementares: sugestoes.map((s) => ({
      cnp: s.produto.cnp,
      designacao: s.produto.designacao,
      dci: s.produto.dci,
      dosagem: s.produto.dosagem,
      laboratorio: s.produto.laboratorioTitular,
      categoria: s.produto.categoria,
      papel: s.papel,
      motivoClinico: s.motivoClinico,
      seguranca: s.seguranca,
      stockAtual: s.produto.stock,
      pvp: s.produto.pvp,
      margemPct: s.produto.margem,
    })),
  };
}

/**
 * 24. Analisar Desempenho e Auditoria de Compras de Laboratório Titular
 * Permite à direção ou responsável de compras auditar o portfólio completo de um laboratório:
 * - Faturação e rotação real dos últimos 12 meses;
 * - Valor total de stock imobilizado;
 * - Produtos recomendados para encomendar (em rutura ou com stock <30 dias);
 * - Produtos com encomenda estritamente proibida (Monos ou Excesso >4 meses de cobertura).
 */
export async function toolAnalisarDesempenhoLaboratorio(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { nome_laboratorio: string; limite_detalhes?: number }
) {
  const nomeLab = (args.nome_laboratorio || '').trim();
  if (!nomeLab) {
    return {
      success: false,
      mensagem: 'Por favor, indique o nome do laboratório a analisar (ex: Generis, Teva, Pierre Fabre, Viatris, etc.).',
    };
  }

  const limite = Math.min(args.limite_detalhes || 25, 50);

  // 1. Procurar em MartProdutoMetricas com filtro rigoroso de palavra inteira (evita que "Bial" case com "Labial")
  const rawMarts = await prisma.martProdutoMetricas.findMany({
    where: {
      farmaciaId: ctx.farmaciaId,
      OR: [
        { laboratorio_titular: { contains: nomeLab, mode: 'insensitive' } },
        { designacao: { contains: nomeLab, mode: 'insensitive' } },
      ],
    },
    orderBy: { total_unidades_vendidas: 'desc' },
  });

  const escapedLab = nomeLab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labWordRx = new RegExp(`\\b${escapedLab}\\b`, 'i');
  const labPrefixRx = new RegExp(`^${escapedLab}`, 'i');

  const marts = rawMarts.filter((m) => {
    const lab = (m.laboratorio_titular || '').trim();
    if (lab) {
      return labWordRx.test(lab);
    }
    return labWordRx.test(m.designacao) || labPrefixRx.test(m.designacao);
  });

  if (marts.length === 0) {
    return {
      success: false,
      laboratorioPesquisado: nomeLab,
      mensagem: `Nenhum produto encontrado na farmácia ${ctx.farmaciaNome} associado ao laboratório "${nomeLab}". Verifique a grafia ou consulte os produtos por categoria.`,
    };
  }

  // 1.1 Obter sazonalidade oficial de ProdutoMestre, consolidação DCI, faturação e vendas mensais (últimos 3 meses)
  const cnpList = marts.map((m) => m.cnp_codigo);
  const [produtosMestre, dciGrupos, fatAgregada, vendasMensaisLab] = await Promise.all([
    prisma.produtoMestre.findMany({
      where: { cnp_codigo: { in: cnpList } },
      select: { cnp_codigo: true, sazonalidade: true, dci: true, laboratorio_titular: true },
    }),
    prisma.martDciGrupo.findMany({
      where: { farmaciaId: ctx.farmaciaId },
      select: { grupo_equivalencia_dci: true, stock_total_unidades: true, vmm_total_grupo: true, custo_minimo: true, labsJson: true },
    }),
    prisma.martProdutoMes.aggregate({
      where: { farmaciaId: ctx.farmaciaId, cnp_codigo: { in: cnpList } },
      _sum: { valor_total: true },
    }),
    prisma.martProdutoMes.findMany({
      where: { farmaciaId: ctx.farmaciaId, cnp_codigo: { in: cnpList } },
      select: { cnp_codigo: true, mes: true, quantidade: true, valor_total: true },
      orderBy: { mes: 'asc' },
    }),
  ]);

  const totalFaturacao12mEur = Number(fatAgregada._sum.valor_total || 0);

  const pmMap = new Map(produtosMestre.map((p) => [p.cnp_codigo, p]));
  const dciMap = new Map(dciGrupos.map((d) => [d.grupo_equivalencia_dci.toLowerCase(), d]));

  const currentMonth = new Date().getMonth() + 1; // 1-12
  const isWinterWindow = currentMonth >= 10 || currentMonth <= 3; // Outubro a Março
  const isSummerWindow = currentMonth >= 5 && currentMonth <= 9;  // Maio a Setembro

  let totalStockUnidades = 0;
  let totalStockValor = 0;
  let totalVendidos12m = 0;
  let produtosComStock = 0;
  let capitalMonos = 0;
  let capitalExcesso = 0;

  const paraRepor: any[] = [];
  const travarMono: any[] = [];
  const travarExcesso: any[] = [];
  const travarSazonal: any[] = [];
  const confortavel: any[] = [];

  // Agrupar vendas mensais por CNP e identificar os últimos 3 meses disponíveis
  const mesesSet = new Set<string>();
  const vendasPorCnpMes = new Map<string, Map<string, number>>();
  for (const vm of vendasMensaisLab) {
    mesesSet.add(vm.mes);
    let m = vendasPorCnpMes.get(vm.cnp_codigo);
    if (!m) {
      m = new Map();
      vendasPorCnpMes.set(vm.cnp_codigo, m);
    }
    m.set(vm.mes, (m.get(vm.mes) || 0) + vm.quantidade);
  }
  const ultimos3Meses = [...mesesSet].sort().slice(-3);

  const produtosEmCrescimento3M: any[] = [];
  const produtosEmQuedaOuParados3M: any[] = [];

  for (const item of marts) {
    const stock = item.stock_total_unidades;
    const valor = Number(item.stock_total_valor_custo || 0);
    const custoUnit = Number(item.custo_unitario_medio || 0);
    const vmm = Number(item.vmm || 0);
    const vendas12m = item.total_unidades_vendidas || 0;
    const cobertura = Number(item.cobertura_meses || 0);
    const pvp = Number(item.pvp || 0);
    const rawMargem = Number(item.margem_padrao || 0);
    // Nunca devolver 100% quando não há custo unitário registado
    const margem: number | null =
      custoUnit > 0 && pvp > 0
        ? Number((((pvp - custoUnit) / pvp) * 100).toFixed(1))
        : rawMargem > 0 && rawMargem < 99.9
        ? rawMargem
        : null;

    const pm = pmMap.get(item.cnp_codigo);
    const sazonalidade = (pm?.sazonalidade || 'TODO_O_ANO').toUpperCase();
    const dciOficial = pm?.dci || item.molecula_dci || null;
    const labOficial = pm?.laboratorio_titular || item.laboratorio_titular || nomeLab;
    const dciKey = (item.grupo_equivalencia_dci || dciOficial || '').toLowerCase();
    const dciInfo = dciKey ? dciMap.get(dciKey) : null;

    // Evolução nos últimos 3 meses
    if (ultimos3Meses.length === 3) {
      const mMap = vendasPorCnpMes.get(item.cnp_codigo) || new Map<string, number>();
      const [m1, m2, m3] = ultimos3Meses;
      const q1 = mMap.get(m1) || 0;
      const q2 = mMap.get(m2) || 0;
      const q3 = mMap.get(m3) || 0;
      const total3m = q1 + q2 + q3;

      if (total3m > 0 || stock > 0 || vendas12m > 0) {
        const registo3m = {
          cnp: item.cnp_codigo,
          designacao: item.designacao,
          laboratorioTitular: labOficial,
          dci: dciOficial || 'Sem dados',
          vendasMeses: { [m1]: q1, [m2]: q2, [m3]: q3 },
          totalUltimos3Meses: total3m,
          vendas12m,
          stockAtual: stock,
          margemPct: margem,
        };
        if (q3 > q1 || (q3 > 0 && q3 >= q2 && q2 >= q1)) {
          produtosEmCrescimento3M.push({ ...registo3m, tendencia: q3 > q1 ? 'A_SUBIR' : 'ESTAVEL_ATIVO' });
        } else {
          produtosEmQuedaOuParados3M.push({
            ...registo3m,
            tendencia: total3m === 0 ? 'SEM_VENDAS_3M' : 'A_DESCER',
          });
        }
      }
    }

    totalStockUnidades += stock;
    totalStockValor += valor;
    totalVendidos12m += vendas12m;
    if (stock > 0) produtosComStock++;

    // A) Verificação de Sazonalidade Fora de Época (Reutilização da Inteligência de Épocas)
    const foraDeEpoca =
      (sazonalidade === 'VERAO' && isWinterWindow) ||
      (sazonalidade === 'INVERNO' && isSummerWindow);

    if (foraDeEpoca) {
      travarSazonal.push({
        cnp: item.cnp_codigo,
        designacao: item.designacao,
        laboratorioTitular: labOficial,
        dci: dciOficial || 'Sem dados',
        stockAtual: stock,
        capitalImobilizado: Math.round(valor * 100) / 100,
        sazonalidade,
        epocaAtual: isWinterWindow ? 'OUTONO / INVERNO' : 'PRIMAVERA / VERÃO',
        motivoBloqueio: `Artigo sazonal de ${sazonalidade} fora de época. Procura natural estagnada — NÃO voltar a encomendar agora para não gerar mono.`,
      });
      continue;
    }

    // B) Classificação Contábil e Matemática
    if (item.eh_mono && stock > 0) {
      capitalMonos += valor;
      travarMono.push({
        cnp: item.cnp_codigo,
        designacao: item.designacao,
        laboratorioTitular: labOficial,
        dci: dciOficial || 'Sem dados',
        stockAtual: stock,
        capitalImobilizado: Math.round(valor * 100) / 100,
        diasSemVendas: item.dias_sem_vendas || 90,
        motivoBloqueio: `Mono parado há ${item.dias_sem_vendas || '>90'} dias sem vendas. Capital empatado.`,
      });
    } else if (item.eh_excesso_cobertura || cobertura > 4) {
      capitalExcesso += valor;
      travarExcesso.push({
        cnp: item.cnp_codigo,
        designacao: item.designacao,
        laboratorioTitular: labOficial,
        dci: dciOficial || 'Sem dados',
        stockAtual: stock,
        capitalImobilizado: Math.round(valor * 100) / 100,
        coberturaMeses: Math.round(cobertura * 10) / 10,
        vmmMensal: vmm,
        motivoBloqueio: `Excesso de stock (${Math.round(cobertura * 10) / 10} meses de autonomia ao ritmo de ${vmm}/mês). Travar compras.`,
      });
    } else if ((vmm >= 0.5 || vendas12m >= 6) && (cobertura < 1.0 || stock === 0)) {
      const vmmEfetivo = vmm > 0 ? vmm : Math.round((vendas12m / 12) * 100) / 100;
      const coberturaDias = vmmEfetivo > 0 ? Math.round((stock / (vmmEfetivo / 30))) : 0;
      const ehPicoInverno = sazonalidade === 'INVERNO' && isWinterWindow;
      // No pico sazonal, cobertura sugerida é 45 dias; fora de pico 30 dias
      const diasAlvo = ehPicoInverno ? 45 : 30;
      const qtdSugerida = Math.max(1, Math.ceil(vmmEfetivo * (diasAlvo / 30)) - stock);

      // Verificação DCI: se outro lab já cobre a molécula
      let avisoDci: string | null = null;
      if (dciInfo && dciInfo.stock_total_unidades > stock) {
        const dciCobMeses = Number(dciInfo.vmm_total_grupo) > 0 ? dciInfo.stock_total_unidades / Number(dciInfo.vmm_total_grupo) : 0;
        if (dciCobMeses > 2) {
          avisoDci = `Atenção: A molécula ${item.grupo_equivalencia_dci} já tem ${dciInfo.stock_total_unidades} un em stock total (${Math.round(dciCobMeses * 10) / 10} meses) noutros laboratórios. Priorizar escoamento existente.`;
        }
      }

      paraRepor.push({
        cnp: item.cnp_codigo,
        designacao: item.designacao,
        laboratorioTitular: labOficial,
        dci: dciOficial || 'Sem dados',
        stockAtual: stock,
        vmmMensal: vmmEfetivo,
        diasCobertura: coberturaDias,
        sugestaoEncomenda: qtdSugerida,
        margemPct: margem,
        sazonalidade: sazonalidade !== 'TODO_O_ANO' ? sazonalidade : undefined,
        picoSazonalAtivo: ehPicoInverno,
        avisoConsolidacaoDci: avisoDci,
        motivo: stock === 0
          ? `RUTURA! Vende ${vmmEfetivo}/mês (${vendas12m} un no ano).${ehPicoInverno ? ' [PICO DE INVERNO ATIVO 🔥]' : ''}`
          : `Stock crítico (${coberturaDias} dias de autonomia).${ehPicoInverno ? ' [Reforço Sazonal]' : ''}`,
      });
    } else if (stock > 0) {
      confortavel.push({
        cnp: item.cnp_codigo,
        designacao: item.designacao,
        laboratorioTitular: labOficial,
        dci: dciOficial || 'Sem dados',
        stockAtual: stock,
        coberturaMeses: Math.round(cobertura * 10) / 10,
        vmmMensal: vmm,
      });
    }
  }

  // Ordenações analíticas
  paraRepor.sort((a, b) => b.vmmMensal - a.vmmMensal);
  travarExcesso.sort((a, b) => b.capitalImobilizado - a.capitalImobilizado);
  travarMono.sort((a, b) => b.capitalImobilizado - a.capitalImobilizado);
  produtosEmCrescimento3M.sort((a, b) => b.totalUltimos3Meses - a.totalUltimos3Meses);
  produtosEmQuedaOuParados3M.sort((a, b) => b.stockAtual - a.stockAtual || b.vendas12m - a.vendas12m);

  // Top produtos mais vendidos da marca no período homólogo
  const topMaisVendidos = marts
    .filter((m) => m.total_unidades_vendidas > 0)
    .sort((a, b) => b.total_unidades_vendidas - a.total_unidades_vendidas)
    .slice(0, 8)
    .map((m) => {
      const pm = pmMap.get(m.cnp_codigo);
      const vmm = Number(m.vmm || 0);
      const stock = m.stock_total_unidades;
      const cobDias = vmm > 0 ? Math.round(stock / (vmm / 30)) : 999;
      const custoUnit = Number(m.custo_unitario_medio || 0);
      const pvp = Number(m.pvp || 0);
      const rawMargem = Number(m.margem_padrao || 0);
      const margemSegura =
        custoUnit > 0 && pvp > 0
          ? Number((((pvp - custoUnit) / pvp) * 100).toFixed(1))
          : rawMargem > 0 && rawMargem < 99.9
          ? rawMargem
          : null;
      return {
        cnp: m.cnp_codigo,
        designacao: m.designacao,
        laboratorioTitular: pm?.laboratorio_titular || m.laboratorio_titular || nomeLab,
        dci: pm?.dci || m.molecula_dci || 'Sem dados',
        unidadesVendidas12M: m.total_unidades_vendidas,
        vmmMensal: vmm,
        stockAtual: stock,
        diasCobertura: cobDias,
        pvpEur: pvp,
        margemComercialPct: margemSegura,
        situacao: stock === 0 ? 'Rutura' : cobDias <= 25 ? 'Stock Baixo (Repor)' : 'Stock Seguro',
      };
    });

  // Análise de Quota de Mercado Interno (Market Share por Molécula DCI na Farmácia)
  const cnpSet = new Set(cnpList);
  const lideresQuota: any[] = [];
  const subPerformersQuota: any[] = [];

  for (const g of dciGrupos) {
    const labs = (g.labsJson as any[]) || [];
    const itemLab = labs.find((l) => cnpSet.has(l.cnp_codigo) || labWordRx.test(l.designacao || ''));
    if (!itemLab) continue;

    const vmmTotal = Number(g.vmm_total_grupo || 0);
    if (vmmTotal < 0.5) continue;

    const vmmLab = Number(itemLab.vmm || 0);
    const quotaPct = Math.round((vmmLab / vmmTotal) * 100);

    const sortedLabs = [...labs].sort((a, b) => Number(b.vmm || 0) - Number(a.vmm || 0));
    const labLider = sortedLabs[0];
    const liderQuotaPct = Math.round((Number(labLider.vmm || 0) / vmmTotal) * 100);

    if (quotaPct >= 50) {
      lideresQuota.push({
        moleculaDci: g.grupo_equivalencia_dci,
        produto: itemLab.designacao,
        vmmMarca: vmmLab,
        quotaMercadoInterno: `${quotaPct}%`,
        vmmTotalGrupo: vmmTotal,
        stockAtual: itemLab.stock_atual,
        custoUnitario: itemLab.custo_unitario,
        posicao: 'LÍDER DA MOLÉCULA NA FARMÁCIA',
        recomendacao: `A farmácia tem preferência clara por ${nomeLab} nesta molécula (${quotaPct}% das vendas da farmácia). Manter como marca prioritária de reposição.`,
      });
    } else if (quotaPct < 30 && labs.length >= 2) {
      subPerformersQuota.push({
        moleculaDci: g.grupo_equivalencia_dci,
        produto: itemLab.designacao,
        vmmMarca: vmmLab,
        quotaMercadoInterno: `${quotaPct}%`,
        vmmTotalGrupo: vmmTotal,
        stockAtual: itemLab.stock_atual,
        liderMercadoInterno: labLider.designacao,
        liderQuota: `${liderQuotaPct}%`,
        liderStock: labLider.stock_atual,
        posicao: 'SUB-PERFORMER / MARCA RESIDUAL NA FARMÁCIA',
        recomendacao: `Atenção: ${nomeLab} vende muito pouco desta molécula (${quotaPct}% de quota, VMM ${vmmLab}/mês) em comparação com o líder ${labLider.designacao.split(' ')[0]} (${liderQuotaPct}%, VMM ${labLider.vmm}/mês). Não sobrecarregar encomendas a ${nomeLab} aqui; dar prioridade à marca líder.`,
      });
    }
  }

  lideresQuota.sort((a, b) => b.vmmMarca - a.vmmMarca);
  subPerformersQuota.sort((a, b) => b.vmmTotalGrupo - a.vmmTotalGrupo);

  return {
    success: true,
    laboratorioPesquisado: nomeLab,
    farmacia: ctx.farmaciaNome,
    resumoExecutivo: {
      totalReferenciasNoCatalogo: marts.length,
      artigosComStockFisico: produtosComStock,
      stockTotalUnidades: totalStockUnidades,
      stockTotalValorCusto: Math.round(totalStockValor * 100) / 100,
      vendasTotais12mUnidades: totalVendidos12m,
      faturacaoTotal12mEur: Math.round(totalFaturacao12mEur * 100) / 100,
      capitalEmpatadoEmMonos: Math.round(capitalMonos * 100) / 100,
      totalReferenciasMonos: travarMono.length,
      capitalEmExcessoCobertura: Math.round(capitalExcesso * 100) / 100,
      totalReferenciasExcesso: travarExcesso.length,
      totalArtigosSazonaisForaDeEpoca: travarSazonal.length,
      totalArtigosParaReporUrgente: paraRepor.length,
      totalArtigosStockConfortavel: confortavel.length,
    },
    recomendacaoEstrategicaCompras: {
      diagnostico:
        travarMono.length > 0 || travarExcesso.length > 0 || travarSazonal.length > 0
          ? `Atenção na negociação com ${nomeLab}: Faturação de €${Math.round(totalFaturacao12mEur * 100) / 100} (${totalVendidos12m} un). Existem €${Math.round((capitalMonos + capitalExcesso) * 100) / 100} empatados em stock ineficiente (${travarMono.length} monos e ${travarExcesso.length} produtos em excesso)${travarSazonal.length > 0 ? ` e ${travarSazonal.length} produtos sazonais fora de época` : ''}. Exigir devolução/troca dos monos e focar estritamente nas necessidades comprovadas de reposição.`
          : `Portfólio equilibrado com ${nomeLab}. Faturação de €${Math.round(totalFaturacao12mEur * 100) / 100} (${totalVendidos12m} un).`,
    },
    produtosMaisVendidosAltaRotacao: topMaisVendidos,
    evolucaoUltimos3Meses: {
      mesesAvaliados: ultimos3Meses,
      produtosEmCrescimentoOuAtivos: produtosEmCrescimento3M.slice(0, limite),
      produtosEmQuedaOuParados: produtosEmQuedaOuParados3M.slice(0, limite),
    },
    performanceComparativaMoléculaDci: {
      produtosLideresQuotaMercadoInterno: lideresQuota.slice(0, 10),
      produtosSubPerformersBaixaQuotaVsConcorrentes: subPerformersQuota.slice(0, 10),
    },
    produtosParaEncomendar: paraRepor.slice(0, limite),
    produtosProibidosDeEncomendar: {
      sazonaisForaDeEpoca: travarSazonal.slice(0, limite),
      excessoDeCobertura: travarExcesso.slice(0, limite),
      monosParados: travarMono.slice(0, limite),
    },
    produtosStockConfortavelAmostra: confortavel.slice(0, 10),
  };
}
