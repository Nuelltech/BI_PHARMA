import { PrismaClient } from '@prisma/client';
import { getPharmacyCatalog, CatalogItem } from './product_catalog.js';
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
    farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
      farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
  args: { meses_sem_venda?: number; apenas_com_stock?: boolean; limite?: number }
) {
  const meses = args.meses_sem_venda || 6;
  const apenasComStock = args.apenas_com_stock ?? true;
  const limite = args.limite || 30;

  const dataCorte = new Date();
  dataCorte.setMonth(dataCorte.getMonth() - meses);

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

  // Verifica vendas nos últimos X meses para esta farmácia
  const vendasRecentes = await prisma.venda.findMany({
    where: {
      farmaciaId: ctx.farmaciaId,
      data_venda: { gte: dataCorte },
      quantidade: { gt: 0 },
    },
    select: { cnp_codigo: true },
  });

  const cnpsComVendas = new Set(vendasRecentes.map((v: { cnp_codigo: string }) => v.cnp_codigo));

  const produtosParados = [];

  for (const [cnp, data] of stockMap.entries()) {
    if (cnpsComVendas.has(cnp)) continue; // Teve vendas nos últimos X meses

    const prod = data.produto;
    const isMsrm = prod.tipo_venda === 'MSRM' || prod.tipo_venda === 'MSRM_GENERICO';
    const isGenerico = prod.tipo_venda === 'GENERICO_MG' || prod.tipo_venda === 'MSRM_GENERICO';

    let estrategiaSugerida = '';
    if (isGenerico) {
      estrategiaSugerida = '🧬 TROCA DE LABORATÓRIO: Priorizar a dispensa deste laboratório na gaveta de genéricos ao balcão e colocar Ponto de Encomenda = 0 no Sifarma para outros laboratórios.';
    } else if (isMsrm) {
      estrategiaSugerida = '🏷️ DISPENSA NA RECEITA: Colocar etiqueta vermelha na gaveta física para dispensar na próxima receita médica ou verificar devolução comercial ao armazenista.';
    } else {
      estrategiaSugerida = '🧺 CESTO DE OPORTUNIDADE / PACK: Criar pack promocional com artigo de alta rotação ou colocar no cesto do balcão com 20% de desconto.';
    }

    produtosParados.push({
      cnp,
      designacao: prod.designacao,
      laboratorio: prod.laboratorio_titular || 'Não especificado',
      stockAtual: data.qtd,
      custoUnitarioEur: Number(data.custo.toFixed(2)),
      capitalImobilizadoEur: Number((data.qtd * data.custo).toFixed(2)),
      tipoVenda: prod.tipo_venda || 'OUTRO',
      mesesSemVenda: meses,
      estrategiaDispensa: estrategiaSugerida,
    });
  }

  produtosParados.sort((a, b) => b.capitalImobilizadoEur - a.capitalImobilizadoEur);

  return {
    farmacia: ctx.farmaciaNome,
    mesesSemVendas: meses,
    totalArtigosSemVenda: produtosParados.length,
    capitalTotalImobilizadoEur: Number(
      produtosParados.reduce((s, p) => s + p.capitalImobilizadoEur, 0).toFixed(2)
    ),
    produtos: produtosParados.slice(0, limite),
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
    farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
      farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
      farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
      farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
    farmacia: ctx.farmaciaNome,
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
