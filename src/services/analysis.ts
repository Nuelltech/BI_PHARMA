import { PrismaClient } from '@prisma/client';
import { classifyProduct, TipoVenda, SegmentoProduto } from './classifier';
import { computeSafeAntiDumpingDiscount, matchProductToSeasonalCampaign } from './campaigns';

export interface AnalysisOptions {
  periodoMonosDias?: number;
  limiteCoberturaMeses?: number;
  mesesHistoricoVMM?: number;
  dataReferencia?: Date;
}

export interface ProdutoCoberturaItem {
  cnp_codigo: string;
  designacao: string;
  tipo_venda: TipoVenda;
  segmento: SegmentoProduto;
  eh_generico: boolean;
  grupo_equivalencia_dci: string | null;
  categoria: string;
  sugestao_balcao: string;
  prateleira: string | null;
  lote: string;
  stock_atual: number;
  custo_unitario: number;
  pvp: number | null;
  margem_percentagem: number | null;
  unidades_vendidas_periodo: number;
  vmm: number;
  cobertura_meses: number | null;
  excesso_cobertura: boolean;
}

export interface ProdutoMonoItem {
  cnp_codigo: string;
  designacao: string;
  tipo_venda: TipoVenda;
  segmento: SegmentoProduto;
  eh_generico: boolean;
  grupo_equivalencia_dci: string | null;
  categoria: string;
  prateleira: string | null;
  lote: string;
  stock_atual: number;
  custo_unitario: number;
  pvp: number | null;
  margem_percentagem: number | null;
  capital_imobilizado: number;
  ultima_venda: string | null;
  unidades_vendidas_ano: number;
  data_validade: string | null;
  acao_sugerida: string;
}

export interface ProdutoRiscoCaducidadeItem {
  cnp_codigo: string;
  designacao: string;
  tipo_venda: TipoVenda;
  segmento: SegmentoProduto;
  eh_generico: boolean;
  grupo_equivalencia_dci: string | null;
  categoria: string;
  prateleira: string | null;
  lote: string;
  stock_atual: number;
  custo_unitario: number;
  pvp: number | null;
  margem_percentagem: number | null;
  data_validade: string;
  meses_ate_caducidade: number;
  vmm: number;
  cobertura_meses: number | null;
  classificacao: 'Risco Elevado de Caducidade' | 'Escoamento Normal';
  unidades_em_risco: number;
  valor_em_risco: number;
  acao_recomendada: string;
}

export interface GrupoConsolidacaoGenericoItem {
  grupo_equivalencia_dci: string;
  molecula_dci: string;
  num_laboratorios_abertos: number;
  stock_total_unidades: number;
  valor_total_stock: number;
  vmm_total_grupo: number;
  cobertura_conjunta_meses: number | null;
  custo_minimo: number;
  laboratorio_mais_barato: string;
  custo_maximo: number;
  laboratorio_mais_caro: string;
  diferenca_custo_pct: number;
  restos_gaveta_escobar_primeiro: Array<{
    cnp_codigo: string;
    designacao: string;
    stock_atual: number;
    custo_unitario: number;
    data_validade: string | null;
  }>;
  todos_laboratorios: Array<{
    cnp_codigo: string;
    designacao: string;
    stock_atual: number;
    custo_unitario: number;
    vmm: number;
    data_validade: string | null;
  }>;
}

export interface PharmacyAnalysisReport {
  farmacia: {
    id: string;
    nome: string;
    nif: string;
  };
  parametros: {
    data_referencia: string;
    periodo_monos_dias: number;
    data_corte_monos: string;
    limite_cobertura_meses: number;
    meses_historico_vmm: number;
  };
  resumo_executivo: {
    total_artigos_inventario: number;
    total_unidades_stock: number;
    valor_total_stock_custo: number;
    artigos_venda_livre_psbe: number;
    valor_stock_venda_livre_psbe: number;
    artigos_mnsrm: number;
    artigos_msrm_receita: number;
    artigos_genericos_mg: number;
    valor_stock_genericos_mg: number;
    artigos_medicamentos_marca: number;
    valor_stock_medicamentos_marca: number;
    grupos_dci_com_multiplos_labs: number;
    total_artigos_excesso_cobertura: number;
    total_artigos_monos: number;
    valor_total_monos: number;
    percentagem_capital_em_monos: number;
    total_artigos_com_validade_registada: number;
    total_artigos_risco_caducidade: number;
    unidades_totais_risco_caducidade: number;
    valor_total_risco_caducidade: number;
  };
  alertas_excesso_cobertura: ProdutoCoberturaItem[];
  monos: ProdutoMonoItem[];
  risco_elevado_caducidade: ProdutoRiscoCaducidadeItem[];
  consolidacao_genericos_dci: GrupoConsolidacaoGenericoItem[];
}

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function getSpecificCrossSellPairing(
  designacao: string,
  categoria: string,
  topLocomotivaPorCategoria: Map<string, { nomeCurto: string; vmm: number }>
): string {
  const d = designacao.toLowerCase();

  const fmtLoc = (catKey: string, fallback: string) => {
    const loc = topLocomotivaPorCategoria.get(catKey);
    return loc && loc.vmm > 0 ? `${fallback} (ex: ${loc.nomeCurto} · ${loc.vmm}/mês)` : fallback;
  };

  if (/\b(probiot|biogaia|ul-250|enterogermina|atylfor|atyflor|symbiosys)\b/.test(d) || categoria.includes('Probióticos')) {
    return `Associar à dispensa de ${fmtLoc('Antibióticos e Anti-infecciosos', 'Antibióticos Orais')}`;
  }
  if (/\b(gaviscon|kompensan|rennie|nexium|ulcermin|maalox|antiacido)\b/.test(d)) {
    return `Associar à dispensa de ${fmtLoc('Dor, Febre e Alívio Muscular', 'Anti-inflamatórios Orais')} ou protocolo Azia/Festas`;
  }
  if (/\b(voltaren|fisiocrem|biofreeze|reumon|dimobil|dolorilgel|transact)\b/.test(d)) {
    return `Cross-Sell Tópico na dispensa de ${fmtLoc('Dor, Febre e Alívio Muscular', 'Analgésicos/AINEs Orais')}`;
  }
  if (/\b(antigrip\w*|gripp\w*|griponal|c[eê]gripe|ilvico|vigrippe|tosse|tuss\w*|fluimucil|bisolvon|mucosolvan|mucavex|broncoliber|grintuss|stodal)\b/.test(d)) {
    return `Priorizar no aconselhamento de Gripe/Tosse (alternativa a ${fmtLoc('Gripe, Tosse e Vias Respiratórias', 'Antigripais líderes')}) + Cross-Sell c/ Vitamina C, Água do Mar ou Pastilhas de Garganta`;
  }
  if (/\b(agua\s*do\s*mar|nasimer|rhinomer|soro|strepsils|strepfen|mebocaina|stick\s*labial|letibalm|nasitrim|vibrocil|snup)\b/.test(d) || categoria.includes('Gripe')) {
    return `Associar à procura de ${fmtLoc('Gripe, Tosse e Vias Respiratórias', 'Antigripais e Xaropes')}`;
  }
  if (/\b(creme\s*pes|cr\s*pes|ureia|compeed|epitact|lanceta|tira|gluco)\b/.test(d)) {
    return `Recomendar a utentes crónicos em ${fmtLoc('Cardiovascular, Diabetes e Circulação', 'Antidiabéticos / Cardiovasculares')}`;
  }
  if (/\b(magnesio|magn[eé]sio|melatonina|valdispert|aquilea|neurobion|sargenor|absorvit|centrum|viterra)\b/.test(d) || categoria.includes('Suplementos')) {
    return `Associar a queixas de cansaço/sono ou receitas de ${fmtLoc('Sistema Nervoso e Saúde Mental', 'Ansiolíticos/Polimedicação')}`;
  }
  if (/\b(elgydium|parodontax|sensodyne|corega|kukident|escova|colutorio|dentifrico|fio\s*dent)\b/.test(d) || categoria.includes('Oral')) {
    return 'Cross-Sell de Saúde Oral (associar Escova/Colutório na compra de pasta dentífrica ou fixador)';
  }
  if (/\b(chicco|ch\.|dodot|aptamil|biber|chupeta|halibut|lauroderme|mitosyl)\b/.test(d) || categoria.includes('Bebé')) {
    return 'Cross-Sell Puericultura (sugerir na compra de leites, fraldas ou receitas pediátricas)';
  }
  if (/\b(solar|spf|fp50|sun\b|anthelios|uvmune|pos-solar)\b/.test(d)) {
    return 'Reservar p/ Campanha Fotoproteção Verão ou liquidar em Cesto de Oportunidade Solar';
  }
  if (/\b(perfum|parfum|eau\s*de\s*toilette|eau\s*toilette|coffret|kit\s*manicure)\b/.test(d)) {
    return 'Destaque em Ilha de Presentes / Balcão (compra por impulso e ofertas)';
  }
  if (/\b(creme\s*maos|hidrat|cicalfate|barral|cerave|avene|vichy|roche|ducray|klorane|champ[oô])\b/.test(d) || categoria.includes('Dermocosmética')) {
    return 'Aconselhamento Dermocosmético ao balcão (rotina pele/cabelo) + exposição linear à altura dos olhos';
  }
  if (/\b(penso|compressa|ligadura|betadine|bepanthene|hansaplast|salvelox|urgo)\b/.test(d)) {
    return 'Kit Primeiros Socorros (sugerir na dispensa de antisséticos, suturas ou analgésicos)';
  }

  return `Recomendação ativa de balcão (${categoria}) junto à caixa`;
}

function buildSmartItemRecommendation(params: {
  contexto: 'COBERTURA' | 'MONO' | 'CADUCIDADE';
  designacao: string;
  tipoVenda: TipoVenda;
  ehGenerico: boolean;
  grupoDci: string | null;
  moleculaDci: string | null;
  categoria: string;
  stock: number;
  custoUnit: number;
  pvp: number | null;
  margem: number | null;
  vmm: number;
  mesesAteCaducidade: number | null;
  dciStats?: { numLabs: number; vmmTotal: number; labPrincipal: string };
  topLocomotivaPorCategoria: Map<string, { nomeCurto: string; vmm: number }>;
  mesRef: number;
}): string {
  const {
    contexto,
    designacao,
    tipoVenda,
    ehGenerico,
    grupoDci,
    moleculaDci,
    categoria,
    stock,
    custoUnit,
    pvp,
    margem,
    vmm,
    mesesAteCaducidade,
    dciStats,
    topLocomotivaPorCategoria,
    mesRef,
  } = params;

  // 1. Medicamentos Sujeitos a Receita Médica (MSRM)
  if (tipoVenda === 'MSRM') {
    if (ehGenerico) {
      const restoTag = stock <= 2 ? `Resto Gaveta (${stock} un.)` : `Stock (${stock} un.)`;
      if (dciStats && dciStats.numLabs > 1 && dciStats.vmmTotal > 0) {
        return `🔄 [Substituição DCI · ${restoTag}] Molécula vende ${dciStats.vmmTotal}/mês na farmácia (${dciStats.numLabs} labs abertos). Dispensar antes do lab principal na próxima receita.`;
      }
      if (dciStats && dciStats.vmmTotal === 0) {
        return `📦 [Genérico s/ Saída na Molécula] 0 vendas de ${grupoDci || moleculaDci || 'DCI'} na farmácia. Solicitar recolha/devolução ao armazenista.`;
      }
      return `🔄 [Substituição DCI · ${restoTag}] Priorizar dispensa na receita por princípio ativo (${grupoDci || moleculaDci || 'DCI'}) ou devolver excedente.`;
    }

    // MSRM de Marca
    if (mesesAteCaducidade !== null && mesesAteCaducidade <= 5) {
      return `↩️ [MSRM Marca · Validade ${mesesAteCaducidade}m] VMM insuficiente (${vmm}/mês). Pedir recolha/nota de crédito ao armazenista e zerar stock mínimo.`;
    }
    return `↩️ [MSRM Marca — Preço Regulado] Proibido desconto (Infarmed). Devolver excesso (${stock} un. = ${(stock * custoUnit).toFixed(2)}€) ao armazenista ou ajustar stock mínimo.`;
  }

  // 2. Produtos de Venda Livre (PSBE) e MNSRM
  const pvpEfetivo = pvp && pvp > 0 ? pvp : custoUnit * 1.45;
  const margemEfetiva =
    margem !== null && margem > 0
      ? margem
      : pvpEfetivo > custoUnit
        ? ((pvpEfetivo - custoUnit) / pvpEfetivo) * 100
        : 0;

  const desiredDesc = contexto === 'CADUCIDADE' && mesesAteCaducidade !== null && mesesAteCaducidade <= 4 ? 20 : 15;
  const simDesc = computeSafeAntiDumpingDiscount(custoUnit, pvpEfetivo, desiredDesc);
  const campMatch = matchProductToSeasonalCampaign(designacao, tipoVenda, margemEfetiva, mesRef);
  const crossPairing = getSpecificCrossSellPairing(designacao, categoria, topLocomotivaPorCategoria);

  // Caso 2A: Margem regulada ou demasiado baixa para desconto (< 20%)
  if (!simDesc.podeDesconto || margemEfetiva < 20) {
    return `🛡️ [S/ Margem p/ Desconto (${margemEfetiva.toFixed(0)}%)] Travão Anti-Dumping ativo. Escoar s/ desconto via ${crossPairing}.`;
  }

  // Caso 2B: Risco Crítico de Caducidade
  if (contexto === 'CADUCIDADE' && mesesAteCaducidade !== null) {
    const canalTag = stock <= 2 ? 'Cesto de Balcão (1-2 un)' : 'Plano Salva-Validades';
    if (campMatch && campMatch.ehEpocaAtual) {
      return `🔥 [Validade ${mesesAteCaducidade}m + ${campMatch.campanha.icone} ${campMatch.campanha.epoca}] Prioridade máxima no ${canalTag} c/ -${simDesc.descontoPct}% → PVP Promo: ${simDesc.pvpPromo.toFixed(2)}€ (Margem ${simDesc.margemFinalPct}% ✅).`;
    }
    return `🔥 [Salva-Validades ${mesesAteCaducidade}m · ${canalTag}] Aplicar -${simDesc.descontoPct}% imediato → PVP Promo: ${simDesc.pvpPromo.toFixed(2)}€ (Margem ${simDesc.margemFinalPct}% ✅) + ${crossPairing}.`;
  }

  // Caso 2C: Resto de Gaveta (1 ou 2 unidades órfãs com baixa rotação)
  if (stock <= 2 && vmm <= 0.3) {
    if (campMatch && campMatch.ehEpocaAtual) {
      return `🧺 [Resto Gaveta ${stock} un. · ${campMatch.campanha.icone} ${campMatch.campanha.epoca}] Só Balcão (não anunciar em Redes). Cesto Oportunidade c/ -${simDesc.descontoPct}% → PVP Promo: ${simDesc.pvpPromo.toFixed(2)}€ (Margem ${simDesc.margemFinalPct}% ✅).`;
    }
    return `🧺 [Resto de Gaveta — ${stock} un.] Só Loja/Balcão (não anunciar em Redes). Cesto Últimas Unidades c/ -${simDesc.descontoPct}% → PVP: ${simDesc.pvpPromo.toFixed(2)}€ (Margem ${simDesc.margemFinalPct}% ✅) ou ${crossPairing}.`;
  }

  // Caso 2D: Encaixa numa Campanha de Época Ativa/Próxima e tem stock >= 3 un
  if (campMatch && campMatch.ehEpocaAtual) {
    return `🎯 [${campMatch.campanha.icone} ${campMatch.campanha.titulo}] Incluir em "${campMatch.eixoNome}" (Redes/Ecrãs/Balcão, ${stock} un.) c/ -${simDesc.descontoPct}% → PVP Promo: ${simDesc.pvpPromo.toFixed(2)}€ (Margem ${simDesc.margemFinalPct}% ✅).`;
  }

  // Caso 2E: Encaixa numa Campanha de Outra Época do Ano (ex: Solares no Inverno)
  if (campMatch && !campMatch.ehEpocaAtual) {
    return `📅 [Fora de Época · ${campMatch.campanha.icone} ${campMatch.campanha.epoca}] Liquidar já em Cesto de Oportunidade c/ -${simDesc.descontoPct}% (${simDesc.pvpPromo.toFixed(2)}€ · Margem ${simDesc.margemFinalPct}% ✅) ou reservar p/ campanha sazonal.`;
  }

  // Caso 2F: Escoamento por Cross-Selling + Campanha Destrava Capital
  return `🤝 [Cross-Selling + Destrava Stock] ${crossPairing} · Permite campanha -${simDesc.descontoPct}% → PVP Promo: ${simDesc.pvpPromo.toFixed(2)}€ (Margem ${simDesc.margemFinalPct}% ✅).`;
}

export async function analyzePharmacyInventory(
  prisma: PrismaClient,
  farmaciaId: string,
  options: AnalysisOptions = {}
): Promise<PharmacyAnalysisReport> {
  const farmacia = await prisma.farmacia.findUnique({
    where: { id: farmaciaId },
  });

  if (!farmacia) {
    throw new Error(`Farmácia com ID "${farmaciaId}" não encontrada.`);
  }

  const inventarios = await prisma.inventario.findMany({
    where: { farmaciaId },
    include: { produto: true },
  });

  const vendas = await prisma.venda.findMany({
    where: { farmaciaId },
    orderBy: { data_venda: 'asc' },
  });

  let dataReferencia = options.dataReferencia;
  if (!dataReferencia) {
    const maxExtracao = inventarios.reduce<Date | null>(
      (max, item) => (!max || item.data_extracao > max ? item.data_extracao : max),
      null
    );
    dataReferencia = maxExtracao ?? new Date();
  }

  const periodoMonosDias = options.periodoMonosDias ?? 90;
  const limiteCoberturaMeses = options.limiteCoberturaMeses ?? 4;

  let mesesHistoricoVMM = options.mesesHistoricoVMM;
  if (!mesesHistoricoVMM) {
    if (vendas.length > 0) {
      const mesesDistintos = new Set(
        vendas.map((v) => `${v.data_venda.getUTCFullYear()}-${String(v.data_venda.getUTCMonth() + 1).padStart(2, '0')}`)
      );
      mesesHistoricoVMM = mesesDistintos.size > 12 ? 12 : Math.max(1, mesesDistintos.size);
    } else {
      mesesHistoricoVMM = 12;
    }
  }

  const dataCorteMonos = new Date(dataReferencia.getTime() - periodoMonosDias * 24 * 60 * 60 * 1000);

  const vendasPorProduto = new Map<
    string,
    {
      totalUnidades: number;
      unidadesRecentesMonos: number;
      ultimaDataVenda: Date | null;
    }
  >();

  for (const venda of vendas) {
    const atual = vendasPorProduto.get(venda.cnp_codigo) ?? {
      totalUnidades: 0,
      unidadesRecentesMonos: 0,
      ultimaDataVenda: null,
    };

    atual.totalUnidades += venda.quantidade;
    if (venda.data_venda >= dataCorteMonos && venda.data_venda <= dataReferencia) {
      atual.unidadesRecentesMonos += venda.quantidade;
    }
    if (venda.quantidade > 0 && (!atual.ultimaDataVenda || venda.data_venda > atual.ultimaDataVenda)) {
      atual.ultimaDataVenda = venda.data_venda;
    }

    vendasPorProduto.set(venda.cnp_codigo, atual);
  }

  const alertasExcessoCobertura: ProdutoCoberturaItem[] = [];
  const monos: ProdutoMonoItem[] = [];
  const riscoElevadoCaducidade: ProdutoRiscoCaducidadeItem[] = [];

  const dciGroupsMap = new Map<
    string,
    {
      molecula_dci: string;
      items: Array<{
        cnp_codigo: string;
        designacao: string;
        stock_atual: number;
        custo_unitario: number;
        vmm: number;
        data_validade: string | null;
      }>;
    }
  >();

  let totalUnidadesStock = 0;
  let valorTotalStockCusto = 0;
  let valorTotalMonos = 0;
  let totalArtigosComValidade = 0;
  let unidadesTotaisRiscoCaducidade = 0;
  let valorTotalRiscoCaducidade = 0;

  let artigosVendaLivre = 0;
  let valorStockVendaLivre = 0;
  let artigosMnsrm = 0;
  let artigosMsrm = 0;
  let artigosGenericosMg = 0;
  let valorStockGenericosMg = 0;
  let artigosMarca = 0;
  let valorStockMarca = 0;

  const MS_POR_MES = 30.4375 * 24 * 60 * 60 * 1000;
  const mesRef = dataReferencia.getUTCMonth() + 1;

  // Pré-passagem: Agrupar Genéricos DCI e identificar as Locomotivas Reais mais vendidas por Família Terapêutica
  const topLocomotivaPorCategoria = new Map<string, { nomeCurto: string; vmm: number }>();

  for (const item of inventarios) {
    if (item.quantidade <= 0) continue;
    const computedClass = classifyProduct(item.cnp_codigo, item.produto.designacao, item.produto.taxa_iva);
    const statsVenda = vendasPorProduto.get(item.cnp_codigo);
    const vmm = statsVenda ? round2(statsVenda.totalUnidades / mesesHistoricoVMM) : 0;
    const cat = item.produto.categoria || computedClass.categoria;

    if (vmm > 0) {
      const curTop = topLocomotivaPorCategoria.get(cat);
      if (!curTop || vmm > curTop.vmm) {
        const nomeCurto = item.produto.designacao.split(',')[0].slice(0, 26).trim();
        topLocomotivaPorCategoria.set(cat, { nomeCurto, vmm });
      }
    }

    if (computedClass.eh_generico && computedClass.grupo_equivalencia_dci && computedClass.molecula_dci) {
      const grp = dciGroupsMap.get(computedClass.grupo_equivalencia_dci) ?? {
        molecula_dci: computedClass.molecula_dci,
        items: [],
      };
      grp.items.push({
        cnp_codigo: item.cnp_codigo,
        designacao: item.produto.designacao,
        stock_atual: item.quantidade,
        custo_unitario: Number(item.custo_unitario),
        vmm,
        data_validade: item.data_validade ? item.data_validade.toISOString().slice(0, 10) : null,
      });
      dciGroupsMap.set(computedClass.grupo_equivalencia_dci, grp);
    }
  }

  for (const item of inventarios) {
    if (item.quantidade <= 0) continue;

    const computedClass = classifyProduct(
      item.cnp_codigo,
      item.produto.designacao,
      item.produto.taxa_iva
    );
    const tipoVenda = computedClass.tipo_venda;
    const segmento = computedClass.segmento;
    const ehGenerico = computedClass.eh_generico;
    const grupoDci = computedClass.grupo_equivalencia_dci;
    const categoria = item.produto.categoria || computedClass.categoria;

    const custoUnit = Number(item.custo_unitario);
    const pvp = item.produto.pvp !== null ? Number(item.produto.pvp) : null;
    const margem = item.produto.margem_padrao !== null ? Number(item.produto.margem_padrao) : null;
    const valorStockItem = round2(item.quantidade * custoUnit);

    if (tipoVenda === 'VENDA_LIVRE') {
      artigosVendaLivre++;
      valorStockVendaLivre += valorStockItem;
    } else if (tipoVenda === 'MNSRM') {
      artigosMnsrm++;
    } else {
      artigosMsrm++;
    }

    if (segmento === 'GENERICO_MG') {
      artigosGenericosMg++;
      valorStockGenericosMg += valorStockItem;
    } else if (segmento === 'MEDICAMENTO_MARCA') {
      artigosMarca++;
      valorStockMarca += valorStockItem;
    }

    totalUnidadesStock += item.quantidade;
    valorTotalStockCusto += valorStockItem;

    const statsVenda = vendasPorProduto.get(item.cnp_codigo) ?? {
      totalUnidades: 0,
      unidadesRecentesMonos: 0,
      ultimaDataVenda: null,
    };

    const vmm = round2(statsVenda.totalUnidades / mesesHistoricoVMM);
    const coberturaMeses = vmm > 0 ? round2(item.quantidade / vmm) : null;
    const mesesAteCaducidade = item.data_validade
      ? Math.max(0, round2((item.data_validade.getTime() - dataReferencia.getTime()) / MS_POR_MES))
      : null;

    let dciStats: { numLabs: number; vmmTotal: number; labPrincipal: string } | undefined;
    if (ehGenerico && grupoDci) {
      const grp = dciGroupsMap.get(grupoDci);
      if (grp) {
        const vmmTotal = round2(grp.items.reduce((s, i) => s + i.vmm, 0));
        const topLab = [...grp.items].sort((a, b) => b.vmm - a.vmm || b.stock_atual - a.stock_atual)[0];
        dciStats = {
          numLabs: grp.items.length,
          vmmTotal,
          labPrincipal: topLab ? topLab.designacao.slice(0, 28) : '',
        };
      }
    }

    // 1. Excesso de Cobertura
    const excessoCobertura = coberturaMeses === null ? true : coberturaMeses > limiteCoberturaMeses;

    if (excessoCobertura) {
      const sugestaoBalcao = buildSmartItemRecommendation({
        contexto: 'COBERTURA',
        designacao: item.produto.designacao,
        tipoVenda,
        ehGenerico,
        grupoDci,
        moleculaDci: computedClass.molecula_dci,
        categoria,
        stock: item.quantidade,
        custoUnit,
        pvp,
        margem,
        vmm,
        mesesAteCaducidade,
        dciStats,
        topLocomotivaPorCategoria,
        mesRef,
      });

      alertasExcessoCobertura.push({
        cnp_codigo: item.cnp_codigo,
        designacao: item.produto.designacao,
        tipo_venda: tipoVenda,
        segmento,
        eh_generico: ehGenerico,
        grupo_equivalencia_dci: grupoDci,
        categoria,
        sugestao_balcao: sugestaoBalcao,
        prateleira: item.prateleira,
        lote: item.lote,
        stock_atual: item.quantidade,
        custo_unitario: custoUnit,
        pvp,
        margem_percentagem: margem,
        unidades_vendidas_periodo: statsVenda.totalUnidades,
        vmm,
        cobertura_meses: coberturaMeses,
        excesso_cobertura: true,
      });
    }

    // 2. Monos
    if (statsVenda.unidadesRecentesMonos === 0) {
      valorTotalMonos += valorStockItem;
      const acaoMono = buildSmartItemRecommendation({
        contexto: 'MONO',
        designacao: item.produto.designacao,
        tipoVenda,
        ehGenerico,
        grupoDci,
        moleculaDci: computedClass.molecula_dci,
        categoria,
        stock: item.quantidade,
        custoUnit,
        pvp,
        margem,
        vmm,
        mesesAteCaducidade,
        dciStats,
        topLocomotivaPorCategoria,
        mesRef,
      });

      monos.push({
        cnp_codigo: item.cnp_codigo,
        designacao: item.produto.designacao,
        tipo_venda: tipoVenda,
        segmento,
        eh_generico: ehGenerico,
        grupo_equivalencia_dci: grupoDci,
        categoria,
        prateleira: item.prateleira,
        lote: item.lote,
        stock_atual: item.quantidade,
        custo_unitario: custoUnit,
        pvp,
        margem_percentagem: margem,
        capital_imobilizado: valorStockItem,
        ultima_venda: statsVenda.ultimaDataVenda
          ? statsVenda.ultimaDataVenda.toISOString().slice(0, 10)
          : null,
        unidades_vendidas_ano: statsVenda.totalUnidades,
        data_validade: item.data_validade ? item.data_validade.toISOString().slice(0, 10) : null,
        acao_sugerida: acaoMono,
      });
    }

    // 3. Risco de Caducidade
    if (item.data_validade && mesesAteCaducidade !== null) {
      totalArtigosComValidade++;

      const emRisco = coberturaMeses === null || mesesAteCaducidade < coberturaMeses;

      if (emRisco) {
        const unidadesEscoaveis = vmm * mesesAteCaducidade;
        const unidadesEmRisco = Math.max(
          1,
          Math.min(item.quantidade, Math.ceil(item.quantidade - unidadesEscoaveis))
        );
        const valorEmRisco = round2(unidadesEmRisco * custoUnit);

        unidadesTotaisRiscoCaducidade += unidadesEmRisco;
        valorTotalRiscoCaducidade += valorEmRisco;

        const acaoRecomendada = buildSmartItemRecommendation({
          contexto: 'CADUCIDADE',
          designacao: item.produto.designacao,
          tipoVenda,
          ehGenerico,
          grupoDci,
          moleculaDci: computedClass.molecula_dci,
          categoria,
          stock: item.quantidade,
          custoUnit,
          pvp,
          margem,
          vmm,
          mesesAteCaducidade,
          dciStats,
          topLocomotivaPorCategoria,
          mesRef,
        });

        riscoElevadoCaducidade.push({
          cnp_codigo: item.cnp_codigo,
          designacao: item.produto.designacao,
          tipo_venda: tipoVenda,
          segmento,
          eh_generico: ehGenerico,
          grupo_equivalencia_dci: grupoDci,
          categoria,
          prateleira: item.prateleira,
          lote: item.lote,
          stock_atual: item.quantidade,
          custo_unitario: custoUnit,
          pvp,
          margem_percentagem: margem,
          data_validade: item.data_validade.toISOString().slice(0, 10),
          meses_ate_caducidade: mesesAteCaducidade,
          vmm,
          cobertura_meses: coberturaMeses,
          classificacao: 'Risco Elevado de Caducidade',
          unidades_em_risco: unidadesEmRisco,
          valor_em_risco: valorEmRisco,
          acao_recomendada: acaoRecomendada,
        });
      }
    }
  }

  // 4. Construir Análise de Consolidação de Genéricos por Molécula DCI (grupos com >= 2 laboratórios abertos)
  const consolidacaoGenericosDci: GrupoConsolidacaoGenericoItem[] = [];
  for (const [grupoKey, grp] of dciGroupsMap.entries()) {
    if (grp.items.length < 2) continue;

    const sortedByCost = [...grp.items].sort((a, b) => a.custo_unitario - b.custo_unitario);
    const cheapest = sortedByCost[0];
    const mostExpensive = sortedByCost[sortedByCost.length - 1];

    const stockTotal = grp.items.reduce((s, i) => s + i.stock_atual, 0);
    const valorTotal = round2(grp.items.reduce((s, i) => s + i.stock_atual * i.custo_unitario, 0));
    const vmmTotal = round2(grp.items.reduce((s, i) => s + i.vmm, 0));
    const cobConjunta = vmmTotal > 0 ? round2(stockTotal / vmmTotal) : null;
    const diffPct =
      cheapest.custo_unitario > 0
        ? round2(((mostExpensive.custo_unitario - cheapest.custo_unitario) / cheapest.custo_unitario) * 100)
        : 0;

    // Restos de gaveta: laboratórios com <= 2 unidades (ordenados primeiro por validade mais curta, depois maior custo)
    const restosGaveta = grp.items
      .filter((i) => i.stock_atual <= 2)
      .sort((a, b) => b.custo_unitario - a.custo_unitario)
      .map((i) => ({
        cnp_codigo: i.cnp_codigo,
        designacao: i.designacao,
        stock_atual: i.stock_atual,
        custo_unitario: i.custo_unitario,
        data_validade: i.data_validade,
      }));

    consolidacaoGenericosDci.push({
      grupo_equivalencia_dci: grupoKey,
      molecula_dci: grp.molecula_dci,
      num_laboratorios_abertos: grp.items.length,
      stock_total_unidades: stockTotal,
      valor_total_stock: valorTotal,
      vmm_total_grupo: vmmTotal,
      cobertura_conjunta_meses: cobConjunta,
      custo_minimo: cheapest.custo_unitario,
      laboratorio_mais_barato: cheapest.designacao,
      custo_maximo: mostExpensive.custo_unitario,
      laboratorio_mais_caro: mostExpensive.designacao,
      diferenca_custo_pct: diffPct,
      restos_gaveta_escobar_primeiro: restosGaveta,
      todos_laboratorios: grp.items.sort((a, b) => b.stock_atual - a.stock_atual),
    });
  }

  consolidacaoGenericosDci.sort((a, b) => {
    if (b.num_laboratorios_abertos !== a.num_laboratorios_abertos) {
      return b.num_laboratorios_abertos - a.num_laboratorios_abertos;
    }
    return b.valor_total_stock - a.valor_total_stock;
  });

  alertasExcessoCobertura.sort((a, b) => b.stock_atual * b.custo_unitario - a.stock_atual * a.custo_unitario);
  monos.sort((a, b) => b.capital_imobilizado - a.capital_imobilizado);
  riscoElevadoCaducidade.sort((a, b) => {
    if (b.valor_em_risco !== a.valor_em_risco) return b.valor_em_risco - a.valor_em_risco;
    return a.meses_ate_caducidade - b.meses_ate_caducidade;
  });

  const maskNifForDisplay = (rawNif: string): string => {
    const clean = (rawNif || '').trim();
    if (/^\d{9}$/.test(clean)) {
      return `${clean.slice(0, 3)} *** *${clean.slice(7)}`;
    }
    return clean;
  };

  return {
    farmacia: {
      id: farmacia.id,
      nome: farmacia.nome,
      nif: maskNifForDisplay(farmacia.nif),
    },
    parametros: {
      data_referencia: dataReferencia.toISOString().slice(0, 10),
      periodo_monos_dias: periodoMonosDias,
      data_corte_monos: dataCorteMonos.toISOString().slice(0, 10),
      limite_cobertura_meses: limiteCoberturaMeses,
      meses_historico_vmm: mesesHistoricoVMM,
    },
    resumo_executivo: {
      total_artigos_inventario: inventarios.filter((i) => i.quantidade > 0).length,
      total_unidades_stock: totalUnidadesStock,
      valor_total_stock_custo: round2(valorTotalStockCusto),
      artigos_venda_livre_psbe: artigosVendaLivre,
      valor_stock_venda_livre_psbe: round2(valorStockVendaLivre),
      artigos_mnsrm: artigosMnsrm,
      artigos_msrm_receita: artigosMsrm,
      artigos_genericos_mg: artigosGenericosMg,
      valor_stock_genericos_mg: round2(valorStockGenericosMg),
      artigos_medicamentos_marca: artigosMarca,
      valor_stock_medicamentos_marca: round2(valorStockMarca),
      grupos_dci_com_multiplos_labs: consolidacaoGenericosDci.length,
      total_artigos_excesso_cobertura: alertasExcessoCobertura.length,
      total_artigos_monos: monos.length,
      valor_total_monos: round2(valorTotalMonos),
      percentagem_capital_em_monos:
        valorTotalStockCusto > 0 ? round2((valorTotalMonos / valorTotalStockCusto) * 100) : 0,
      total_artigos_com_validade_registada: totalArtigosComValidade,
      total_artigos_risco_caducidade: riscoElevadoCaducidade.length,
      unidades_totais_risco_caducidade: unidadesTotaisRiscoCaducidade,
      valor_total_risco_caducidade: round2(valorTotalRiscoCaducidade),
    },
    alertas_excesso_cobertura: alertasExcessoCobertura,
    monos,
    risco_elevado_caducidade: riscoElevadoCaducidade,
    consolidacao_genericos_dci: consolidacaoGenericosDci,
  };
}
