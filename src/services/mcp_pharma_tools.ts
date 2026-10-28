import { PrismaClient } from '@prisma/client';
import { getPharmacyCatalog, CatalogItem } from './product_catalog.js';

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
      dataRecomendadaEncomendaLaboratorio: ep.dataEncomendaSugerida,
      dataIdealEntregaFarmacia: ep.dataEntregaIdeal,
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

      let recomendacaoEncomenda = '';
      if (it.stock === 0 && it.vendasQtd > 0) {
        recomendacaoEncomenda = '🚨 RUTURA TOTAL (0 un em armazém) - Encomenda urgente necessária.';
      } else if (mesesCobertura >= 3) {
        recomendacaoEncomenda = `⛔ NÃO ENCOMENDAR - EXCESSO DE STOCK (${it.stock} un cobrem ${mesesCobertura} meses / ${diasCobertura} dias). Risco de acumulação e caducidade!`;
      } else if (diasCobertura < 14) {
        const sugerido = Math.max(2, Math.ceil(vendaDiaria * 21)); // 3 semanas de cobertura
        recomendacaoEncomenda = `⚠️ ENCOMENDAR REFORÇO (${it.stock} un cobrem apenas ${diasCobertura} dias). Sugerida encomenda de ~${sugerido} unidades para o pico sazonal.`;
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
        custoUnitarioEur: Number(it.custo.toFixed(2)),
        pvpEur: Number(it.pvp.toFixed(2)),
        margemComercialPct: Number(it.margem.toFixed(1)),
        validade: it.validade || 'S/ Registo',
        recomendacaoEncomenda,
      };
    }),
  };
}
