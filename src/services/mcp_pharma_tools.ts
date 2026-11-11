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
  const limite = args.limite || 25;
  const termo = (args.termo_pesquisa || '').trim().toLowerCase();

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

/**
 * 2. Filtrar Produtos por Validade e Margem (com simulação de PVP sem quebrar margem mínima)
 */
export async function toolFiltrarValidadeEMargem(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { ano_limite_validade?: number; margem_minima_pct?: number; apenas_venda_livre?: boolean; limite?: number }
) {
  const anoLimite = args.ano_limite_validade || 2027;
  const margemMinima = args.margem_minima_pct != null ? args.margem_minima_pct : 10.0;
  const apenasVendaLivre = args.apenas_venda_livre ?? true;
  const limite = args.limite || 30;

  // Busca lotes com validade da farmácia autenticada
  const inventarios = await prisma.inventario.findMany({
    where: {
      farmaciaId: ctx.farmaciaId,
      quantidade: { gt: 0 },
      data_validade: {
        not: null,
        lte: new Date(`${anoLimite}-12-31T23:59:59.999Z`),
      },
    },
    include: {
      produto: true,
    },
    orderBy: {
      data_validade: 'asc',
    },
  });

  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);
  const catalogMap = new Map(catalog.map((c) => [c.cnp, c]));

  const resultados = [];

  for (const inv of inventarios) {
    const prod = inv.produto;
    const catItem = catalogMap.get(inv.cnp_codigo);

    const isLivre = prod.tipo_venda === 'VENDA_LIVRE' || prod.tipo_venda === 'MNSRM' || prod.tipo_venda === 'PSBE';
    if (apenasVendaLivre && !isLivre) continue;

    const custo = Number(inv.custo_unitario || catItem?.custo || 1.0);
    const taxaIva = prod.taxa_iva || 0.23;
    const custoComIva = custo * (1 + taxaIva);
    const pvpAtual = catItem?.pvp || custoComIva * 1.5;

    // Margem Atual: (PVP - CustoComIva) / PVP
    const margemAtualPct = pvpAtual > 0 ? ((pvpAtual - custoComIva) / pvpAtual) * 100 : 0;

    // PVP Mínimo com a margem desejada: PVP_min = CustoComIva / (1 - MargemMinima/100)
    const divisor = 1 - margemMinima / 100;
    const pvpMinimoPromo = divisor > 0 ? custoComIva / divisor : custoComIva;

    // Desconto máximo possível sem descer da margem mínima
    const descontoMaximoPct = pvpAtual > pvpMinimoPromo ? ((pvpAtual - pvpMinimoPromo) / pvpAtual) * 100 : 0;

    resultados.push({
      cnp: inv.cnp_codigo,
      designacao: prod.designacao,
      lote: inv.lote,
      validade: inv.data_validade ? inv.data_validade.toISOString().slice(0, 10) : 'N/D',
      anoValidade: inv.data_validade ? inv.data_validade.getFullYear() : null,
      stockAtual: inv.quantidade,
      tipoVenda: prod.tipo_venda || 'VENDA_LIVRE',
      custoSemIvaEur: Number(custo.toFixed(2)),
      custoComIvaEur: Number(custoComIva.toFixed(2)),
      pvpAtualEur: Number(pvpAtual.toFixed(2)),
      margemAtualPct: Number(margemAtualPct.toFixed(1)),
      pvpMinimoSugeridoEur: Number(pvpMinimoPromo.toFixed(2)),
      descontoMaximoPermitidoPct: Number(descontoMaximoPct.toFixed(1)),
      margemGarantidaPct: margemMinima,
      cumpreAntiDumping: pvpMinimoPromo >= custoComIva,
    });
  }

  // Ordena pela validade mais próxima
  resultados.sort((a, b) => a.validade.localeCompare(b.validade));

  return {
    farmacia: 'Farmácia Comunitária',
    criterios: {
      anoLimite,
      margemMinimaPct: margemMinima,
      apenasVendaLivre,
    },
    totalLotesIdentificados: resultados.length,
    capitalTotalEmRiscoCustoEur: Number(
      resultados.reduce((s, i) => s + i.stockAtual * i.custoSemIvaEur, 0).toFixed(2)
    ),
    produtos: resultados.slice(0, limite),
  };
}

/**
 * 3. Sugerir Packs Promocionais (2 a 3 produtos onde a margem de cada e do pack não fique abaixo de X%)
 */
export async function toolSugerirPacksPromocionais(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { margem_minima_pack_pct?: number; tamanho_pack?: number; ano_limite_validade?: number; limite?: number }
) {
  const margemMinima = args.margem_minima_pack_pct != null ? args.margem_minima_pack_pct : 5.0;
  const tamanhoPack = args.tamanho_pack === 3 ? 3 : 2;
  const anoLimite = args.ano_limite_validade || 2027;
  const limite = args.limite || 10;

  // Busca produtos candidatos com validade curta ou stock parado
  const validadeResult = await toolFiltrarValidadeEMargem(prisma, ctx, {
    ano_limite_validade: anoLimite,
    margem_minima_pct: margemMinima,
    apenas_venda_livre: true,
    limite: 100,
  });

  const candidatos = validadeResult.produtos;
  if (candidatos.length < tamanhoPack) {
    return {
      farmacia: 'Farmácia Comunitária',
      mensagem: `Não existem produtos de venda livre suficientes com validade até ${anoLimite} para formar packs de ${tamanhoPack}.`,
      packs: [],
    };
  }

  const packs = [];

  // Forma combinações inteligentes de 2 ou 3 produtos com sinergia
  for (let i = 0; i < candidatos.length - (tamanhoPack - 1); i += tamanhoPack) {
    const itens = candidatos.slice(i, i + tamanhoPack);
    const somaCustoComIva = itens.reduce((s, it) => s + it.custoComIvaEur, 0);
    const somaPvpNormal = itens.reduce((s, it) => s + it.pvpAtualEur, 0);

    // Margem mínima do pack: PVP_pack >= somaCustoComIva / (1 - margemMinima / 100)
    const divisor = 1 - margemMinima / 100;
    const pvpPackMinimo = divisor > 0 ? somaCustoComIva / divisor : somaCustoComIva;

    // Desconto sugerido equilibrado (ex: 15% a 20%, garantindo que não baixa do mínimo)
    const pvpPromoSugerido = Math.max(pvpPackMinimo, somaPvpNormal * 0.82);
    const margemRealPackPct = pvpPromoSugerido > 0 ? ((pvpPromoSugerido - somaCustoComIva) / pvpPromoSugerido) * 100 : 0;
    const descontoPackPct = somaPvpNormal > 0 ? ((somaPvpNormal - pvpPromoSugerido) / somaPvpNormal) * 100 : 0;

    packs.push({
      packId: `PACK-${i / tamanhoPack + 1}`,
      tituloSugerido: `Pack Oportunidade: ${itens.map((it) => it.designacao.split(' ')[0]).join(' + ')}`,
      artigos: itens.map((it) => ({
        cnp: it.cnp,
        designacao: it.designacao,
        validade: it.validade,
        stockDisponivel: it.stockAtual,
        pvpIndividualNormalEur: it.pvpAtualEur,
        custoComIvaEur: it.custoComIvaEur,
      })),
      somaPvpNormalEur: Number(somaPvpNormal.toFixed(2)),
      somaCustoComIvaEur: Number(somaCustoComIva.toFixed(2)),
      pvpPackSugeridoEur: Number(pvpPromoSugerido.toFixed(2)),
      poupancaClienteEur: Number((somaPvpNormal - pvpPromoSugerido).toFixed(2)),
      descontoGlobalPct: Number(descontoPackPct.toFixed(1)),
      margemFinalPackPct: Number(margemRealPackPct.toFixed(1)),
      cumpreMargemMinima: margemRealPackPct >= margemMinima,
      cumpreAntiDumping: pvpPromoSugerido >= somaCustoComIva,
    });

    if (packs.length >= limite) break;
  }

  return {
    farmacia: 'Farmácia Comunitária',
    totalPacksGerados: packs.length,
    margemMinimaGarantidaPct: margemMinima,
    packs,
  };
}

/**
 * 4. Identificar Produtos Sem Vendas (ex: 6 meses) com Estratégia de Escoamento
 */
export async function toolIdentificarProdutosSemVenda(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { meses_sem_venda?: number; apenas_com_stock?: boolean; limite?: number; apenas_restos_gaveta?: boolean }
) {
  const meses = args.meses_sem_venda || 6;
  const apenasComStock = args.apenas_com_stock ?? true;
  const apenasRestosGaveta = args.apenas_restos_gaveta ?? false;
  const limite = args.limite || 30;

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
      estrategiaSugerida = '🧬 MONO PROFUNDO (GENÉRICO): Priorizar a dispensa deste laboratório na gaveta de genéricos ao balcão e colocar Ponto de Encomenda = 0 no Sifarma para outros laboratórios.';
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
    produtos: listaFiltrada.slice(0, limite),
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
  const limite = args.limite || 15;

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
  args: { top_n_moleculas?: number }
) {
  const topN = args.top_n_moleculas || 5;
  const catalog = await getPharmacyCatalog(prisma, ctx.farmaciaId);

  // Filtra medicamentos MSRM
  const msrmProds = catalog.filter((c) => c.tipoVenda === 'MSRM' || c.ehGenerico);
  msrmProds.sort((a, b) => (b.vendasQtd || 0) - (a.vendasQtd || 0));

  const topMsrm = msrmProds.slice(0, topN);

  // Regras clínicas de sinergia entre MSRM e OTC / Dermocosmética
  const sinergiasClinicas: Record<string, { necessidade: string; recomendacao: string; termosOtc: string[] }> = {
    estatina: {
      necessidade: 'Mialgias e redução de Coenzima Q10 endógena provocadas por estatinas.',
      recomendacao: 'Coenzima Q10 (Ubiquinol 100mg) para proteção muscular e cardiovascular.',
      termosOtc: ['coenzima', 'coq10', 'ubiquinona', 'cardio'],
    },
    atorvastatina: {
      necessidade: 'Dores musculares e fadiga celular provocadas por inibição da síntese de CoQ10.',
      recomendacao: 'Suplemento de Coenzima Q10 + Magnésio muscular.',
      termosOtc: ['coenzima', 'magnesio', 'q10'],
    },
    sinvastatina: {
      necessidade: 'Dores musculares e sensação de pernas pesadas.',
      recomendacao: 'Coenzima Q10 e antioxidante mitocondrial.',
      termosOtc: ['coenzima', 'q10'],
    },
    metformina: {
      necessidade: 'Diminuição da absorção intestinal de Vitamina B12 e desconforto gástrico.',
      recomendacao: 'Vitamina B12 sublingual + Protetor gástrico/enzimas digestivas.',
      termosOtc: ['vitamina b12', 'complexo b', 'probiotico'],
    },
    omeprazol: {
      necessidade: 'Diminuição da absorção de Cálcio, Magnésio e alteração da microbiota gástrica.',
      recomendacao: 'Citrato de Cálcio + Probiótico gastro-resistente.',
      termosOtc: ['calcio', 'magnesio', 'probiotico'],
    },
    pantoprazol: {
      necessidade: 'Redução da acidez prolongada pode diminuir flora intestinal protetora.',
      recomendacao: 'Probiótico com estirpes de Lactobacillus e Bifidobacterium.',
      termosOtc: ['probiotico', 'gastro'],
    },
    losartan: {
      necessidade: 'Controlo da retenção de líquidos e saúde vascular.',
      recomendacao: 'Monitorização da tensão arterial de pulso/braço + suplemento de Potássio controlado.',
      termosOtc: ['tensiómetro', 'tensiometro', 'omega 3'],
    },
    ibuprofeno: {
      necessidade: 'Gastro-lesão provocada por anti-inflamatórios não esteroides.',
      recomendacao: 'Protetor gástrico natural (ex: Alginato/Aloe vera) ou gel anti-inflamatório tópico.',
      termosOtc: ['alginato', 'gaviscon', 'gel dor', 'voltaflex'],
    },
  };

  const resultados = topMsrm.map((m) => {
    const nomeLower = m.designacao.toLowerCase();
    let matchSinergia = null;
    for (const [chave, info] of Object.entries(sinergiasClinicas)) {
      if (nomeLower.includes(chave) || (m.moleculaDci && m.moleculaDci.toLowerCase().includes(chave))) {
        matchSinergia = info;
        break;
      }
    }

    if (!matchSinergia) {
      matchSinergia = {
        necessidade: 'Adesão à terapêutica crónica e saúde digestiva.',
        recomendacao: 'Organizador semanal de medicação (Pilbox) e probiótico.',
        termosOtc: ['caixa comprimidos', 'pilbox', 'probiotico'],
      };
    }

    // Procura na farmácia produtos de venda livre que correspondam à sinergia
    const otcDisponiveis = catalog.filter((c) => {
      if (c.tipoVenda === 'MSRM') return false;
      const cNome = c.designacao.toLowerCase();
      return matchSinergia!.termosOtc.some((t) => cNome.includes(t)) && c.stock > 0;
    });

    return {
      medicamentoReceita: {
        cnp: m.cnp,
        designacao: m.designacao,
        vendasAnoUnidades: m.vendasQtd,
        stockAtual: m.stock,
      },
      enquadramentoClinico: matchSinergia.necessidade,
      aconselhamentoBalcao: matchSinergia.recomendacao,
      produtosSugeridosEmStock: otcDisponiveis.slice(0, 3).map((p) => ({
        cnp: p.cnp,
        designacao: p.designacao,
        stock: p.stock,
        pvpEur: Number(p.pvp.toFixed(2)),
        margemPct: Number(p.margem.toFixed(1)),
      })),
    };
  });

  return {
    farmacia: 'Farmácia Comunitária',
    vendasCruzadasSugeridas: resultados,
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

  const scored = catalog
    .map((it) => {
      const des = stripAccents(it.designacao);
      const cat = stripAccents(it.categoria || '');
      const subcat = stripAccents(it.subcategoria || '');
      const dci = stripAccents(it.moleculaDci || it.grupoDci || '');
      const cnp = it.cnp;

      let score = 0;
      if (des.includes(cleanQuery)) score += 100;
      if (cnp === cleanQuery) score += 150;

      for (const t of tokens) {
        if (des.includes(t)) score += 60;
        else if (dci.includes(t)) score += 40;
        else if (subcat.includes(t)) score += 20;
        else if (cat.includes(t)) score += 10;
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
        custoUnitarioEur: Number(it.custo.toFixed(2)),
        pvpEur: Number(it.pvp.toFixed(2)),
        margemComercialPct: Number(it.margem.toFixed(1)),
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

  // Filtra similares pelo nome, DCI ou grupo equivalente
  const matches = catalog.filter((it) => {
    const des = stripAccents(it.designacao);
    const dci = stripAccents(it.moleculaDci || it.grupoDci || '');
    const cat = stripAccents(it.categoria || '');
    return des.includes(cleanQ) || dci.includes(cleanQ) || (cleanQ.length >= 4 && cat.includes(cleanQ));
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
        recomendacaoFase = 'Ponto de Encomenda = 0 no Sifarma. Apenas stock residual de balcão.';
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
        motivoBloqueio: 'Margem Negativa (PVP < Custo - venda dá prejuízo até retificação no Sifarma)',
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
        tipoAnomalia = '🚨 DIVERGÊNCIA CUSTO SIFARMA (MSRM Preço Regulado Infarmed)';
        correcaoSugeridaSifarma = `Medicamento de receita médica (MSRM) com PVP oficial de ${it.pvp.toFixed(2)}€ tabelado pelo Infarmed. O PVP NÃO PODE ser alterado por lei! Auditar com urgência a fatura de compra do armazenista no Sifarma: o custo registado de ${it.custo.toFixed(2)}€ contém provável erro de lançamento (IVA duplicado ou código de embalagem hospitalar).`;
      } else {
        tipoAnomalia = '🚨 VENDA COM PREJUÍZO (PVP < Custo)';
        correcaoSugeridaSifarma = `Produto de venda livre. Atualizar PVP para ~${pvpSugerido}€ no Sifarma para cobrir o custo de ${it.custo.toFixed(2)}€ e restabelecer margem viável de 20%.`;
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
        correcaoSugeridaSifarma = `Produto de venda livre. Rever preço de venda no Sifarma para ~${pvpSugerido}€ de modo a assegurar margem saudável.`;
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

// ============================================================================
// 15C. COMPARAR PERFORMANCE FINANCEIRA ENTRE DOIS PERÍODOS
// ============================================================================
export async function toolCompararPerformancePeriodos(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    periodo_a: string; // ex: "2026-07"
    periodo_b: string; // ex: "2026-06"
  }
) {
  const pA = args.periodo_a.trim();
  const pB = args.periodo_b.trim();

  // Executa evolução mensal completa
  const dadosGerais = await toolAnalisarEvolucaoMensalFinanceira(prisma, ctx, { ordenar_por: 'CRONOLOGICO' });
  const mesesList = dadosGerais.evolucaoMensal || [];
  const stA = mesesList.find((m: any) => m.mes === pA);
  const stB = mesesList.find((m: any) => m.mes === pB);

  if (!stA || !stB) {
    return {
      error: `Um ou ambos os períodos não foram encontrados nos registos da farmácia (${pA}: ${stA ? 'Encontrado' : 'Não encontrado'}, ${pB}: ${stB ? 'Encontrado' : 'Não encontrado'}). Meses disponíveis: ${mesesList.map((m: any) => m.mes).join(', ')}`,
    };
  }

  const deltaFatEur = Math.round((stA.faturacaoTotalEur - stB.faturacaoTotalEur) * 100) / 100;
  const deltaFatPct = stB.faturacaoTotalEur > 0 ? Math.round((deltaFatEur / stB.faturacaoTotalEur) * 1000) / 10 : 0;

  const deltaMargemEur = Math.round((stA.margemBrutaTotalEur - stB.margemBrutaTotalEur) * 100) / 100;
  const deltaMargemPct = stB.margemBrutaTotalEur > 0 ? Math.round((deltaMargemEur / stB.margemBrutaTotalEur) * 1000) / 10 : 0;

  const deltaUnid = stA.unidadesTotal - stB.unidadesTotal;
  const deltaUnidPct = stB.unidadesTotal > 0 ? Math.round((deltaUnid / stB.unidadesTotal) * 1000) / 10 : 0;

  const deltaMargemPontosPct = Math.round((stA.margemBrutaPct - stB.margemBrutaPct) * 10) / 10;

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
    diagnosticoExplicativo: `No comparativo de ${stA.mes} face a ${stB.mes}, a margem bruta variou €${deltaMargemEur > 0 ? '+' : ''}${deltaMargemEur} (${deltaMargemPct > 0 ? '+' : ''}${deltaMargemPct}%), com uma variação de volume de ${deltaUnid > 0 ? '+' : ''}${deltaUnid} embalagens.`,
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
    produtos_cnps?: string[];
    foco_stock?: 'TODOS_ELEGIVEIS' | 'PRIORIDADE_VALIDADES_MONOS' | 'SO_VALIDADES_E_MONOS';
    desconto_pct?: number;
    dias_duracao?: number;
    criado_por?: string;
  }
) {
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
