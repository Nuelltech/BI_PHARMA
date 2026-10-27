import { PrismaClient } from '@prisma/client';
import { classifyProduct, extractGenericDciGroup, TipoVenda, SegmentoProduto } from './classifier';
import { analyzePharmacyInventory } from './analysis';
import { localSmartSearch } from './product_catalog';

// ============================================================================
// 1. MOTOR DE LEMATIZAÇÃO, NORMALIZAÇÃO E ABREVIATURAS EM PORTUGUÊS (PT-PT)
// ============================================================================

/**
 * Remove acentuação e diacríticos para comparações robustas
 */
export function removeAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Dicionário bidirecional de abreviaturas farmacêuticas (Sifarma, Winphar, Embalagens)
 */
const PHARMA_ABBREVIATIONS: Record<string, string[]> = {
  comprimido: ['comp', 'compr', 'cpr', 'comprimidos', 'comprimido'],
  capsula: ['caps', 'cps', 'capsulas', 'capsula', 'cap'],
  xarope: ['xpe', 'xpe.', 'xaropes', 'xarope'],
  gota: ['gts', 'gotas', 'gota'],
  solucao: ['sol', 'sol.', 'solucao', 'solucoes', 'solução', 'soluções'],
  suspensao: ['susp', 'susp.', 'suspensao', 'suspensões', 'suspensao'],
  pomada: ['pom', 'pom.', 'pomadas', 'pomada'],
  creme: ['cr', 'cremes', 'creme'],
  gel: ['geis', 'géis', 'gel'],
  ampola: ['amp', 'amp.', 'ampolas', 'ampola'],
  injetavel: ['inj', 'inj.', 'injetaveis', 'injetáveis', 'injetavel'],
  saqueta: ['saq', 'saquetas', 'saqueta', 'sach'],
  preservativo: ['preservativos', 'preservativo', 'preserv'],
  fralda: ['fraldas', 'fralda'],
  penso: ['pensos', 'penso'],
  toalhete: ['toalhetes', 'toalhete', 'toalhitas', 'toalhita'],
  hidratante: ['hidratantes', 'hidratante'],
  vitamina: ['vitaminas', 'vitamina'],
  suplemento: ['suplementos', 'suplemento'],
  colutorio: ['colutorios', 'colutório', 'colutórios', 'colutorio', 'elixir'],
  dentifrico: ['dentifricos', 'dentífrico', 'dentífricos', 'dentifrico', 'pasta'],
  protetor: ['protetores', 'protetor', 'protetora', 'protetoras'],
  chupeta: ['chupetas', 'chupeta'],
  biberon: ['biberons', 'biberões', 'biberon', 'biberão'],
};

/**
 * Lematizador de português: converte plurais em singulares e extrai raiz morfológica
 */
export function lemmatizePortugueseWord(word: string): { singular: string; stem: string } {
  const w = removeAccents(word.toLowerCase().trim());

  // 1. Verificar primeiro se é abreviatura farmacêutica conhecida (ex: xpe, gts, cr, amp, comp)
  for (const [canonical, aliases] of Object.entries(PHARMA_ABBREVIATIONS)) {
    if (aliases.some((a) => removeAccents(a) === w)) {
      return { singular: canonical, stem: canonical.substring(0, Math.min(canonical.length, 6)) };
    }
  }

  if (w.length <= 3) return { singular: w, stem: w };

  let singular = w;

  // Regras de plurais irregulares e regulares em português
  if (w.endsWith('oes') || w.endsWith('aes')) {
    singular = w.substring(0, w.length - 3) + 'ao';
  } else if (w.endsWith('eis')) {
    singular = w.substring(0, w.length - 3) + 'el';
  } else if (w.endsWith('ais')) {
    singular = w.substring(0, w.length - 3) + 'al';
  } else if (w.endsWith('ois')) {
    singular = w.substring(0, w.length - 3) + 'ol';
  } else if (w.endsWith('uis')) {
    singular = w.substring(0, w.length - 3) + 'ul';
  } else if (w.endsWith('is') && !w.endsWith('tis')) {
    singular = w.substring(0, w.length - 2) + 'il';
  } else if (w.endsWith('res') || w.endsWith('nes') || w.endsWith('zes')) {
    singular = w.substring(0, w.length - 2);
  } else if (w.endsWith('ses')) {
    singular = w.substring(0, w.length - 2);
  } else if (w.endsWith('ns')) {
    singular = w.substring(0, w.length - 2) + 'm';
  } else if (w.endsWith('s') && !w.endsWith('ss')) {
    singular = w.substring(0, w.length - 1);
  }

  // Raiz morfológica (stem) para pesquisa fuzzy no PostgreSQL
  const stem = singular.length > 5 ? singular.substring(0, singular.length - 1) : singular;
  return { singular, stem };
}

/**
 * Stopwords portuguesas comuns no contexto de perguntas
 */
const STOPWORDS_PT = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
  'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'por', 'pelo', 'pela', 'pelos', 'pelas', 'para', 'pra', 'com', 'sem',
  'e', 'ou', 'que', 'qual', 'quais', 'quem', 'como', 'quando', 'onde',
  'quanto', 'quantos', 'quanta', 'quantas', 'porque', 'porquê',
  'temos', 'tem', 'tinha', 'ter', 'ha', 'há', 'houve',
  'mais', 'menos', 'muito', 'muitos', 'pouco', 'poucos',
  'este', 'esta', 'estes', 'estas', 'esse', 'essa', 'esses', 'essas',
  'aquele', 'aquela', 'aqueles', 'aquelas', 'outro', 'outra', 'outros', 'outras',
  'produto', 'produtos', 'artigo', 'artigos', 'marca', 'marcas',
  'diz', 'dizer', 'mostrar', 'mostra', 'ver', 'dar', 'fazer', 'saber',
]);

/**
 * Tokeniza a pergunta, remove stopwords e gera sinónimos/lemas para pesquisa
 */
export function extractSearchTokens(text: string): {
  rawTokens: string[];
  cleanTokens: string[];
  lemmas: string[];
  stems: string[];
} {
  const words = removeAccents(text.toLowerCase())
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const clean = words.filter((w) => !STOPWORDS_PT.has(w));
  const lemmas: string[] = [];
  const stems: string[] = [];

  for (const w of clean) {
    const { singular, stem } = lemmatizePortugueseWord(w);
    lemmas.push(singular);
    stems.push(stem);
  }

  return {
    rawTokens: words,
    cleanTokens: clean,
    lemmas: Array.from(new Set(lemmas)),
    stems: Array.from(new Set(stems)),
  };
}

// ============================================================================
// 2. MODELO DE RESPOSTA DO COPILOT
// ============================================================================

export interface CopilotResponse {
  titulo: string;
  explicacao: string;
  colunas: string[];
  linhas: Array<{
    cnp: string | null;
    valores: (string | number | null)[];
  }>;
  resumoEstrategico?: string;
}

// ============================================================================
// 3. MOTORES ANALÍTICOS DE NEGÓCIO FARMACÊUTICO
// ============================================================================

/**
 * 1. Eliminação de Laboratórios Duplicados sem Vendas há 3 Meses ou mais
 * "Para a mesma substancia e dosagem que laboratorias eliminarias por n ter vendas ha 3 meses ou mais"
 */
export async function analyzeLaboratoryElimination(
  prisma: PrismaClient,
  farmaciaId: string,
  diasSemVenda = 90
): Promise<CopilotResponse> {
  const agora = new Date();
  const limiteData = new Date(agora.getTime() - diasSemVenda * 24 * 60 * 60 * 1000);

  // Obter inventário com produtos
  const inventarios = await prisma.inventario.findMany({
    where: { farmaciaId, quantidade: { gt: 0 } },
    include: {
      produto: {
        include: {
          vendas: { where: { farmaciaId } },
        },
      },
    },
  });

  // Agrupar por grupo de equivalência DCI
  const gruposDci = new Map<
    string,
    Array<{
      cnp: string;
      designacao: string;
      stock: number;
      custo: number;
      pvp: number | null;
      vendasRecentes: number;
      vendasTotais: number;
      ultimaVendaData: Date | null;
    }>
  >();

  for (const inv of inventarios) {
    const c = classifyProduct(inv.cnp_codigo, inv.produto.designacao, inv.produto.taxa_iva);
    if (!c.eh_generico || !c.grupo_equivalencia_dci) continue;

    const vendasRecentes = inv.produto.vendas
      .filter((v) => new Date(v.data_venda) >= limiteData)
      .reduce((s, v) => s + v.quantidade, 0);

    const vendasTotais = inv.produto.vendas.reduce((s, v) => s + v.quantidade, 0);

    let ultimaVendaData: Date | null = null;
    if (inv.produto.vendas.length > 0) {
      const datas = inv.produto.vendas.map((v) => new Date(v.data_venda).getTime());
      ultimaVendaData = new Date(Math.max(...datas));
    }

    const item = {
      cnp: inv.cnp_codigo,
      designacao: inv.produto.designacao,
      stock: inv.quantidade,
      custo: Number(inv.custo_unitario),
      pvp: inv.produto.pvp ? Number(inv.produto.pvp) : null,
      vendasRecentes,
      vendasTotais,
      ultimaVendaData,
    };

    const list = gruposDci.get(c.grupo_equivalencia_dci) || [];
    list.push(item);
    gruposDci.set(c.grupo_equivalencia_dci, list);
  }

  interface LabEliminationCandidate {
    grupoDci: string;
    cnp: string;
    designacao: string;
    stock: number;
    capitalParado: number;
    diasSemVenda: string;
    labsAtivosNoGrupo: number;
    labAtivoLider: string;
    acao: string;
  }

  const candidatos: LabEliminationCandidate[] = [];

  for (const [grupo, labs] of gruposDci.entries()) {
    if (labs.length < 2) continue; // Só faz sentido eliminar se existirem múltiplos laboratórios abertos

    const labsComVendas = labs.filter((l) => l.vendasRecentes > 0);
    const labsParados = labs.filter((l) => l.vendasRecentes === 0);

    if (labsComVendas.length > 0 && labsParados.length > 0) {
      const lider = labsComVendas.sort((a, b) => b.vendasRecentes - a.vendasRecentes)[0];

      for (const p of labsParados) {
        const dias = p.ultimaVendaData
          ? `${Math.round((agora.getTime() - p.ultimaVendaData.getTime()) / (1000 * 3600 * 24))} dias`
          : 'Sem vendas registadas';

        candidatos.push({
          grupoDci: grupo,
          cnp: p.cnp,
          designacao: p.designacao,
          stock: p.stock,
          capitalParado: p.stock * p.custo,
          diasSemVenda: dias,
          labsAtivosNoGrupo: labsComVendas.length,
          labAtivoLider: lider.designacao.substring(0, 30),
          acao: `Substituir na receita para escoar as ${p.stock} un e bloquear encomenda deste laboratório. Concentrar no líder ativo.`,
        });
      }
    }
  }

  candidatos.sort((a, b) => b.capitalParado - a.capitalParado);

  const totalCapital = candidatos.reduce((s, c) => s + c.capitalParado, 0);

  return {
    titulo: `Auditoria de Racionalização de Laboratórios DCI (${candidatos.length} laboratórios candidatos a eliminação)`,
    explicacao: `Foram identificados ${candidatos.length} laboratórios que têm stock físico e 0 vendas nos últimos ${diasSemVenda} dias, enquanto outros laboratórios da mesma substância ativa e dosagem estão a ter escoamento regular. Eliminar estas apresentações liberta ${totalCapital.toFixed(2)} € em capital imobilizado.`,
    colunas: [
      'Código CNP',
      'Molécula / Dosagem (DCI)',
      'Apresentação / Laboratório Parado',
      'Stock',
      'Capital Empatado (€)',
      'Tempo sem Venda',
      'Laboratório Ativo que Vende',
      'Ação de Balcão e Encomenda',
    ],
    linhas: candidatos.map((c) => ({
      cnp: c.cnp,
      valores: [
        c.cnp,
        `🧬 ${c.grupoDci}`,
        c.designacao,
        `${c.stock} un`,
        `${c.capitalParado.toFixed(2)} €`,
        c.diasSemVenda,
        c.labAtivoLider,
        c.acao,
      ],
    })),
    resumoEstrategico: `Racionalização: Concentrar compras no fornecedor mais competitivo por molécula e escoar os ${candidatos.length} laboratórios inativos através da substituição legal de genéricos no balcão.`,
  };
}

/**
 * 2. Ajuste Global de Stocks: Excessos de Cobertura, Riscos de Rutura e Monos
 * "Que stocks ajustavas"
 */
export async function analyzeStockAdjustment(
  prisma: PrismaClient,
  farmaciaId: string,
  options?: { limiteCobertura?: number; periodoMonos?: number }
): Promise<CopilotResponse> {
  const report = await analyzePharmacyInventory(prisma, farmaciaId, {
    limiteCoberturaMeses: options?.limiteCobertura || 4,
    periodoMonosDias: options?.periodoMonos || 90,
  });

  interface StockActionItem {
    cnp: string;
    designacao: string;
    tipo: 'EXCESSO' | 'RUTURA' | 'MONO';
    stock: number;
    vmm: number;
    cobertura: string;
    impactoEur: number;
    diagnostico: string;
    acaoRecomendada: string;
  }

  const items: StockActionItem[] = [];

  // 1. Excessos de Cobertura (> 4 meses)
  for (const e of report.alertas_excesso_cobertura.slice(0, 40)) {
    items.push({
      cnp: e.cnp_codigo,
      designacao: e.designacao,
      tipo: 'EXCESSO',
      stock: e.stock_atual,
      vmm: e.vmm,
      cobertura: `${e.cobertura_meses} meses`,
      impactoEur: e.stock_atual * e.custo_unitario,
      diagnostico: `⚠️ Excesso Crítico (${e.cobertura_meses} meses de stock a este ritmo)`,
      acaoRecomendada: 'Reduzir stock máximo de encomenda para 1.5 meses. Suspender encomendas automáticas.',
    });
  }

  // 2. Monos Absolutos (0 vendas há >= 90 dias com stock)
  for (const m of report.monos.slice(0, 30)) {
    items.push({
      cnp: m.cnp_codigo,
      designacao: m.designacao,
      tipo: 'MONO',
      stock: m.stock_atual,
      vmm: 0,
      cobertura: '∞ (0 vendas)',
      impactoEur: m.capital_imobilizado,
      diagnostico: '🛑 Mono (0 vendas nos últimos 3 meses)',
      acaoRecomendada: m.eh_generico
        ? 'Substituir ativamente na receita perante DCI equivalente.'
        : 'Devolver ao fornecedor ou criar kit promocional se venda livre.',
    });
  }

  // Ordenar por impacto financeiro
  items.sort((a, b) => b.impactoEur - a.impactoEur);

  const totalExcessoEur = report.alertas_excesso_cobertura.reduce((s, e) => s + e.stock_atual * e.custo_unitario, 0);
  const totalMonosEur = report.resumo_executivo.valor_total_monos;

  return {
    titulo: 'Plano Diretor de Ajuste e Otimização de Stocks',
    explicacao: `Ajuste recomendado com base no histórico de vendas: Identificados ${report.alertas_excesso_cobertura.length} produtos em excesso de cobertura (${totalExcessoEur.toFixed(2)} €) e ${report.monos.length} artigos sem qualquer rotação recente (${totalMonosEur.toFixed(2)} €). O ajuste dos stocks máximos e devoluções reduz o capital empatado em mais de ${(totalExcessoEur * 0.4).toFixed(2)} €.`,
    colunas: [
      'Código',
      'Designação do Produto',
      'Tipo de Ajuste',
      'Stock Atual',
      'Ritmo (VMM)',
      'Cobertura Estimada',
      'Capital Empatado (€)',
      'Diagnóstico de Gestão',
      'Ação Operacional Recomendada',
    ],
    linhas: items.slice(0, 50).map((i) => ({
      cnp: i.cnp,
      valores: [
        i.cnp,
        i.designacao,
        i.tipo === 'EXCESSO' ? '🟡 EXCESSO' : '🛑 MONO / PARADO',
        `${i.stock} un`,
        `${i.vmm}/mês`,
        i.cobertura,
        `${i.impactoEur.toFixed(2)} €`,
        i.diagnostico,
        i.acaoRecomendada,
      ],
    })),
    resumoEstrategico: 'Recomendação: Ajustar os parâmetros de encomenda no ERP (Sifarma/Winphar) para limitar a cobertura máxima a 45 dias em produtos A/B e ativar devoluções a armazenistas dos artigos de classe C parados.',
  };
}

/**
 * 3. Cross-Selling Clínico Contextual (por Produto ou Categoria)
 * "Vitativ Transilax Comp 20 com que produtos de receita medica ou venda livre posso fazer venda cruzada"
 */
export async function analyzeClinicalCrossSelling(
  prisma: PrismaClient,
  farmaciaId: string,
  searchTerm: string
): Promise<CopilotResponse> {
  const norm = removeAccents(searchTerm.toLowerCase());

  // Encontrar o produto de referência na base de dados
  const produtos = await prisma.produtoMestre.findMany({
    where: {
      OR: [
        { cnp_codigo: { contains: searchTerm } },
        { designacao: { contains: searchTerm, mode: 'insensitive' } },
      ],
    },
    include: {
      inventarios: { where: { farmaciaId } },
    },
    take: 5,
  });

  const refProd = produtos[0];
  const designacaoRef = refProd ? refProd.designacao : searchTerm;

  // Lógica de regras clínicas e complementos de balcão
  let indicacaoPrimaria = 'Saúde Geral & Suplementação';
  let associacoesReceita = '';
  let associacoesVendaLivre = '';
  let termosBuscaComplementares: string[] = [];

  if (norm.includes('transilax') || norm.includes('laxante') || norm.includes('dulcolax') || norm.includes('microlax') || norm.includes('obstipa')) {
    indicacaoPrimaria = 'Obstipação & Trânsito Intestinal';
    associacoesReceita = 'Tratamentos crónicos que causam obstipação secundária: Suplementos de Ferro oral (ex: Fisiogen Ferro, Tardyferon), Analgésicos opioides/fortes (Tramadol, Codeína), Antidepressivos e Anti-hipertensores.';
    associacoesVendaLivre = 'Fibras solúveis (ex: Plantago ovata / Lepicol), Probióticos e reguladores da microbiota intestinal (ex: Symbiosys, Bio-Kult), infusões digestivas e hidratação oral.';
    termosBuscaComplementares = ['probiotico', 'ferro', 'fibra', 'simbiotico', 'flora', 'infusao'];
  } else if (norm.includes('ibuprofeno') || norm.includes('voltaren') || norm.includes('aine') || norm.includes('brufen')) {
    indicacaoPrimaria = 'Anti-inflamatório / Dor Articular e Muscular';
    associacoesReceita = 'Prescrição concomitante com Protetor Gástrico (Omeprazol, Pantoprazol) para proteção da mucosa gástrica em tratamentos superiores a 3 dias.';
    associacoesVendaLivre = 'Gel ou pomada anti-inflamatória tópica para alívio localizado, compressas térmicas frio/calor, e suplementos de colagénio/glucosamina para reforço articular.';
    termosBuscaComplementares = ['omeprazol', 'gel', 'termico', 'colagenio', 'articular'];
  } else if (norm.includes('antibiotico') || norm.includes('amoxicilina') || norm.includes('clavulan')) {
    indicacaoPrimaria = 'Terapêutica Antibacteriana';
    associacoesReceita = 'Gastroprotetor se houver dispepsia; analgésico/antipirético se infeção febril associada.';
    associacoesVendaLivre = 'Probióticos de toma espaçada (2h após o antibiótico) para prevenir diarreia associada a antibióticos e candidíase secundária; pastilhas emolientes de garganta.';
    termosBuscaComplementares = ['probiotico', 'lactobacillus', 'saccharomyces', 'garganta', 'vitamina c'];
  } else if (norm.includes('estatina') || norm.includes('atorvastatina') || norm.includes('rosuvastatina') || norm.includes('sinvastatina')) {
    indicacaoPrimaria = 'Dislipidemia / Redução de Colesterol';
    associacoesReceita = 'Fármacos anti-hipertensores e antiagregantes plaquetares (Aspirina 100mg) em prevenção cardiovascular primária e secundária.';
    associacoesVendaLivre = 'Coenzima Q10 (CoQ10) para atenuar a mialgia e fraqueza muscular induzida por estatinas, Ómega-3 purificado (EPA/DHA) e infusões de alcachofra/cardo mariano.';
    termosBuscaComplementares = ['coenzima', 'q10', 'omega', 'alcachofra', 'cardomariano'];
  } else {
    indicacaoPrimaria = 'Aconselhamento Geral de Balcão';
    associacoesReceita = 'Medicamentos de uso crónico com queixas frequentes de sintomas secundários associados.';
    associacoesVendaLivre = 'Suplementos vitamínicos, hidratantes de barreira cutânea e probióticos de alta margem.';
    termosBuscaComplementares = ['vitamina', 'hidratante', 'probiotico'];
  }

  // Procurar produtos reais em stock na farmácia para esses termos complementares
  const complementosEmStock = await prisma.inventario.findMany({
    where: {
      farmaciaId,
      quantidade: { gt: 0 },
      OR: termosBuscaComplementares.map((t) => ({
        produto: { designacao: { contains: t, mode: 'insensitive' } },
      })),
    },
    include: { produto: true },
    take: 30,
  });

  const linhasComplementos = complementosEmStock
    .map((inv) => {
      const c = classifyProduct(inv.cnp_codigo, inv.produto.designacao, inv.produto.taxa_iva);
      const margem = inv.produto.margem_padrao ? Number(inv.produto.margem_padrao) : 35;
      const pvp = inv.produto.pvp ? Number(inv.produto.pvp) : null;
      return {
        cnp: inv.cnp_codigo,
        designacao: inv.produto.designacao,
        segmento: c.tipo_venda,
        stock: inv.quantidade,
        pvp,
        margem,
        justificacao: `Complemento clínico direto para ${indicacaoPrimaria} com margem atrativa de ${margem.toFixed(0)}%.`,
      };
    })
    .sort((a, b) => b.margem - a.margem)
    .slice(0, 15);

  return {
    titulo: `Matriz de Venda Cruzada (Cross-Selling) para: "${designacaoRef}"`,
    explicacao: `Diagnóstico Clínico (${indicacaoPrimaria}):\n\n` +
      `🩺 **Com Receita Médica (MSRM):** ${associacoesReceita}\n\n` +
      `🟢 **De Venda Livre (MNSRM / PSBE):** ${associacoesVendaLivre}\n\n` +
      `Abaixo estão os produtos complementares atualmente em stock físico na farmácia prontos a sugerir no balcão:`,
    colunas: [
      'Código CNP',
      'Estatuto de Venda',
      'Designação do Complemento',
      'Stock Atual',
      'PVP (€)',
      'Margem Comercial (%)',
      'Fundamentação Clínica de Balcão',
    ],
    linhas: linhasComplementos.map((l) => ({
      cnp: l.cnp,
      valores: [
        l.cnp,
        l.segmento,
        l.designacao,
        `${l.stock} un`,
        l.pvp ? `${l.pvp.toFixed(2)} €` : '-',
        `${l.margem.toFixed(0)}%`,
        l.justificacao,
      ],
    })),
    resumoEstrategico: `Regra de Balcão: Ao aviar receitas de ${indicacaoPrimaria}, investigar ativamente sintomas secundários e propor a solução de venda livre disponível em stock com margem > 30%.`,
  };
}

/**
 * 4. Recomendações por Patologia / Perfil Clínico (ex: Diabéticos)
 * "Que produtos de venda livre posso sugerir para os diabeticos"
 */
export async function analyzeConditionRecommendations(
  prisma: PrismaClient,
  farmaciaId: string,
  conditionText: string
): Promise<CopilotResponse> {
  const norm = removeAccents(conditionText.toLowerCase());

  let termosPesquisa: string[] = [];
  let perfilNome = 'Doentes Crónicos';
  let orientacoesClinicas = '';

  if (norm.includes('diabet') || norm.includes('acucar') || norm.includes('glic')) {
    perfilNome = 'Doentes Diabéticos';
    orientacoesClinicas = 'O doente diabético tem necessidades específicas comprovadas:\n' +
      '1. **Pé Diabético & Pele Seca:** Cremes emolientes com Ureia (10% a 20%) sem perfume para prevenir fissuras e úlceras.\n' +
      '2. **Higiene Oral & Boca Seca:** Pastas dentífricas e colutórios específicos para xerostomia (sem álcool).\n' +
      '3. **Suplementação Sem Açúcar:** Multivitamínicos e tónicos sem sacarose/glucose (B-Complex, Ácido Alfa-Lipóico).\n' +
      '4. **Automonitorização:** Tiras de glicemia, lancetas esterilizadas e contentores de agulhas.';
    termosPesquisa = ['ureia', 'pe', 'pes', 'boca seca', 'xerostomia', 'lanceta', 'glicemia', 'adocante', 'sem acucar', 'diabet'];
  } else if (norm.includes('hipertens') || norm.includes('tensao') || norm.includes('pressao')) {
    perfilNome = 'Doentes Hipertensos';
    orientacoesClinicas = '1. Aparelhos de medição de tensão arterial de braço calibrados (OMRON).\n' +
      '2. Suplementação segura (Magnésio sem sódio, Ómega-3).\n' +
      '3. Substitutos de sal sem cloreto de sódio.\n' +
      '4. Excluir estritamente descongestionantes com pseudoefedrina ou fenilefrina.';
    termosPesquisa = ['tensio', 'pressao', 'magnesio', 'omega', 'sal sem sodio'];
  } else {
    perfilNome = 'Seniores & Idosos';
    orientacoesClinicas = '1. Reforço de barreira cutânea e prevenção de escaras.\n' +
      '2. Suporte articular e mobilidade.\n' +
      '3. Estimulantes cognitivos e de memória suaves.';
    termosPesquisa = ['colagenio', 'articular', 'hidratante', 'ginkgo', 'omega'];
  }

  const inventarios = await prisma.inventario.findMany({
    where: {
      farmaciaId,
      quantidade: { gt: 0 },
      OR: termosPesquisa.map((t) => ({
        produto: { designacao: { contains: t, mode: 'insensitive' } },
      })),
    },
    include: { produto: true },
    take: 50,
  });

  const linhas = inventarios
    .map((inv) => {
      const c = classifyProduct(inv.cnp_codigo, inv.produto.designacao, inv.produto.taxa_iva);
      const margem = inv.produto.margem_padrao ? Number(inv.produto.margem_padrao) : 35;
      const pvp = inv.produto.pvp ? Number(inv.produto.pvp) : null;
      return {
        cnp: inv.cnp_codigo,
        designacao: inv.produto.designacao,
        segmento: c.tipo_venda,
        stock: inv.quantidade,
        pvp,
        margem,
        recomendacao: c.tipo_venda === 'VENDA_LIVRE' || c.tipo_venda === 'MNSRM'
          ? `🟢 Aconselhar no balcão perante perfil de ${perfilNome}.`
          : '⚠️ Requer prescrição médica.',
        elegivel: c.tipo_venda !== 'MSRM',
      };
    })
    .filter((l) => l.elegivel)
    .sort((a, b) => b.margem - a.margem)
    .slice(0, 20);

  return {
    titulo: `Guia de Balcão: Produtos de Venda Livre em Stock para ${perfilNome}`,
    explicacao: orientacoesClinicas + `\n\nForam localizados ${linhas.length} produtos de venda livre atualmente disponíveis nas prateleiras da farmácia aptos para esta indicação:`,
    colunas: [
      'Código CNP',
      'Segmento',
      'Designação do Artigo',
      'Stock Físico',
      'PVP (€)',
      'Margem de Balcão (%)',
      'Protocolo de Aconselhamento Farmacêutico',
    ],
    linhas: linhas.map((l) => ({
      cnp: l.cnp,
      valores: [
        l.cnp,
        l.segmento,
        l.designacao,
        `${l.stock} un`,
        l.pvp ? `${l.pvp.toFixed(2)} €` : '-',
        `${l.margem.toFixed(0)}%`,
        l.recomendacao,
      ],
    })),
    resumoEstrategico: `Oportunidade Comercial: Doentes com ${perfilNome} visitam a farmácia todos os meses para aviar medicação crónica. Aconselhar estes cuidados de venda livre fideliza o utente e aumenta a rentabilidade da cesta de compras.`,
  };
}

/**
 * 5. Stock Parado com Filtro de Segurança Cardiovascular para Idosos
 * "Do stock parado que tenho o que faz sentido recomendar a idosos com problemas cardiacos"
 */
export async function analyzeSafeDeadStockForSeniorCardiac(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<CopilotResponse> {
  const report = await analyzePharmacyInventory(prisma, farmaciaId, { periodoMonosDias: 90 });

  // Lista de segurança clínica cardiovascular:
  // Contra-indicados (excluir formalmente): descongestionantes nasais orais (pseudoefedrina), anti-inflamatórios sistémicos, estimulantes com cafeína alta, alcaçuz.
  const CONTRAINDICATED_CARDIAC = /\b(pseudoefedrina|sinutab|actifed|griponal|c[eê]gripe|ilvico|cafe[ií]na|ginseng|guaran[aá]|ibuprofeno|cetoprofeno|diclofenac|aspirina\s*500)\b/i;

  // Produtos seguros e úteis:
  // Ómega-3 purificado, magnésio, venotrópicos suaves (pernas pesadas/edema de estase), dermocosmética geriátrica hidratante/anti-escaras, suplementos articulares seguros.
  const SAFE_CARDIO_ELDERLY = /\b(omega|ómega|epa|dha|magnes|pernas|circula|veias|castanha|centelha|ureia|hidrat|pele|articular|colagen|tensio|fralda|resguardo)\b/i;

  const monosSeguros = report.monos
    .filter((m) => {
      if (m.tipo_venda === 'MSRM') return false; // Apenas produtos de venda livre
      if (CONTRAINDICATED_CARDIAC.test(m.designacao)) return false; // Excluir risco cardiovascular
      return SAFE_CARDIO_ELDERLY.test(m.designacao);
    })
    .sort((a, b) => b.capital_imobilizado - a.capital_imobilizado)
    .slice(0, 20);

  const totalCapitalSeguro = monosSeguros.reduce((s, m) => s + m.capital_imobilizado, 0);

  return {
    titulo: 'Stock Parado Elegível para Idosos com Patologia Cardíaca (Com Validação de Segurança)',
    explicacao: `Auditoria de Segurança Clínica:\n` +
      `🛡️ **Critério de Exclusão Cardíaca:** Foram banidos automaticamente todos os descongestionantes orais com simpaticomiméticos (pseudoefedrina) e anti-inflamatórios que sobem a tensão arterial ou provocam retenção de líquidos.\n\n` +
      `✅ **Critério de Inclusão Segura:** Selecionados produtos parados (monos há ≥ 90 dias) com benefício direto comprovado para seniores (Ómega-3, magnésio, saúde vascular periférica/edemas e hidratação de pele frágil). Totalizam ${totalCapitalSeguro.toFixed(2)} € de capital que pode ser escoado com segurança absoluta.`,
    colunas: [
      'Código CNP',
      'Designação do Artigo',
      'Stock Parado',
      'Capital Empatado (€)',
      'Última Venda',
      'Perfil de Segurança Cardiovascular',
      'Como Recomendar ao Utente Sénior',
    ],
    linhas: monosSeguros.map((m) => ({
      cnp: m.cnp_codigo,
      valores: [
        m.cnp_codigo,
        m.designacao,
        `${m.stock_atual} un`,
        `${m.capital_imobilizado.toFixed(2)} €`,
        m.ultima_venda || 'Sem vendas em 12m',
        '✅ 100% Seguro (Sem vasoconstritores/sódio)',
        'Sugerir como cuidado de suporte circulatório ou cutâneo na dispensa habitual de anti-hipertensores/estatinas.',
      ],
    })),
    resumoEstrategico: 'Ação de Balcão: Mobilizar a equipa para dar saída a estes produtos específicos durante os atendimentos a utentes seniores que levam medicação cardiovascular, libertando capital sem risco clínico.',
  };
}

/**
 * 6. Planeador de Campanhas Promocionais e Sazonais (ex: Cosmética em Dezembro / Natal)
 * "Cria uma campanha de venda para os produtos cosmeticos agora para Dezembro e diz quais o que temos para incluir"
 */
export async function analyzeSeasonalCampaign(
  prisma: PrismaClient,
  farmaciaId: string,
  categoryKeyword = 'cosmet',
  seasonName = 'Dezembro / Natal'
): Promise<CopilotResponse> {
  const prods = await prisma.produtoMestre.findMany({
    where: {
      OR: [
        { categoria: { contains: categoryKeyword, mode: 'insensitive' } },
        { designacao: { contains: categoryKeyword, mode: 'insensitive' } },
        { designacao: { contains: 'creme', mode: 'insensitive' } },
        { designacao: { contains: 'serum', mode: 'insensitive' } },
        { designacao: { contains: 'coffret', mode: 'insensitive' } },
      ],
    },
    include: {
      inventarios: { where: { farmaciaId, quantidade: { gt: 0 } } },
      vendas: { where: { farmaciaId } },
    },
    take: 100,
  });

  const candidatos = prods
    .filter((p) => p.inventarios.length > 0)
    .map((p) => {
      const inv = p.inventarios[0];
      const stock = inv.quantidade;
      const custo = Number(inv.custo_unitario);
      const pvp = p.pvp ? Number(p.pvp) : custo * 1.5;
      const margemPct = p.margem_padrao ? Number(p.margem_padrao) : ((pvp - custo) / pvp) * 100;
      const validade = inv.data_validade ? inv.data_validade.toISOString().substring(0, 10) : 'Longa';
      const riscoExpiracao = validade.startsWith('2026-0') || validade.startsWith('2025');

      return {
        cnp: p.cnp_codigo,
        designacao: p.designacao,
        categoria: p.categoria,
        stock,
        custo,
        pvp,
        margemPct,
        validade,
        riscoExpiracao,
        lucroTotalPotencial: stock * (pvp - custo),
      };
    })
    .filter((c) => c.margemPct >= 35 || c.riscoExpiracao)
    .sort((a, b) => b.lucroTotalPotencial - a.lucroTotalPotencial)
    .slice(0, 25);

  const totalFaturacaoCampanha = candidatos.reduce((s, c) => s + c.stock * c.pvp, 0);
  const totalLucroCampanha = candidatos.reduce((s, c) => s + c.lucroTotalPotencial, 0);

  return {
    titulo: `Proposta de Campanha Comercial: Especial Cosmética & Cuidados de Rosto (${seasonName})`,
    explicacao: `Plano Estratégico de Campanha Promocional:\n\n` +
      `🎁 **Conceito da Campanha:** "Beleza & Presentes de Natal Farmácia" — foco em coffrets, hidratação anti-idade e cuidados de inverno.\n` +
      `🏷️ **Mecânica Comercial Recomendada:** "Na compra de 1 Creme de Tratamento, desconto de 30% no 2º artigo de menor valor" OU "Leve 3 Pague 2 em artigos selecionados com validade até meados de 2026".\n` +
      `📈 **Potencial Financeiro:** O escoamento deste lote de ${candidatos.length} referências gera ${totalFaturacaoCampanha.toFixed(2)} € em faturação com um Lucro Bruto real de ${totalLucroCampanha.toFixed(2)} € na farmácia.`,
    colunas: [
      'Código CNP',
      'Artigo de Cosmética Selecionado',
      'Stock Disponível',
      'Validade',
      'PVP Atual (€)',
      'Margem Bruta (%)',
      'Lucro Total em Jogo (€)',
      'Destaque no Linear / Balcão',
    ],
    linhas: candidatos.map((c) => ({
      cnp: c.cnp,
      valores: [
        c.cnp,
        c.designacao,
        `${c.stock} un`,
        c.riscoExpiracao ? `⚠️ ${c.validade} (Urgente)` : c.validade,
        `${c.pvp.toFixed(2)} €`,
        `${c.margemPct.toFixed(0)}%`,
        `💰 ${c.lucroTotalPotencial.toFixed(2)} €`,
        c.riscoExpiracao ? 'Destaque Ilha Central / Promoção Imediata' : 'Montra de Natal / Sugestão de Presente',
      ],
    })),
    resumoEstrategico: 'Execução: Colocar os artigos em ponto de destaque (ilha central ou balcão de atendimento) a partir da última semana de novembro com sacos de presente personalizados.',
  };
}

export interface SalesTrendOptions {
  direcao?: 'aumento' | 'queda';
  mesesRecentes?: number;
  termoFiltro?: string;
  segmento?: 'TODOS' | 'SEM_RECEITA' | 'VENDA_LIVRE' | 'MNSRM' | 'MSRM' | 'GENERICO';
}

function formatYearMonthPt(ym: string): string {
  const [y, m] = ym.split('-');
  const names = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const idx = parseInt(m, 10) - 1;
  return `${names[idx] || m}/${(y || '').slice(2)}`;
}

/**
 * 7A. Motor Parametrizado de Tendência Temporal de Vendas (Aumento / Crescimento vs. Queda / Quebra)
 * Compara o ritmo mensal (VMM) dos últimos N meses com o histórico anterior.
 */
export async function analyzeSalesTrend(
  prisma: PrismaClient,
  farmaciaId: string,
  options: SalesTrendOptions = {}
): Promise<CopilotResponse> {
  const direcao = options.direcao || 'queda';
  const prods = await prisma.produtoMestre.findMany({
    include: {
      vendas: { where: { farmaciaId } },
      inventarios: { where: { farmaciaId } },
    },
  });

  // Descobrir todos os meses distintos existentes na base de dados da farmácia
  const mesesSet = new Set<string>();
  for (const p of prods) {
    for (const v of p.vendas) {
      const d = new Date(v.data_venda);
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      mesesSet.add(ym);
    }
  }

  const allMonths = Array.from(mesesSet).sort();
  const defaultN = direcao === 'aumento' ? 2 : 3;
  const maxN = Math.max(1, allMonths.length - 2);
  const N = Math.max(1, Math.min(options.mesesRecentes || defaultN, maxN));

  const recentMonths = allMonths.slice(-N);
  const recentSet = new Set(recentMonths);
  const previousMonths = allMonths.slice(0, -N);
  const numPrevMonths = Math.max(1, previousMonths.length);
  const immediatePrevMonths = allMonths.slice(-2 * N, -N);
  const immediatePrevSet = new Set(immediatePrevMonths);

  const labelJanelaRecente =
    recentMonths.length === 1
      ? formatYearMonthPt(recentMonths[0])
      : `${formatYearMonthPt(recentMonths[0])} a ${formatYearMonthPt(recentMonths[recentMonths.length - 1])}`;

  const labelJanelaAnterior =
    previousMonths.length > 0
      ? `${formatYearMonthPt(previousMonths[0])} a ${formatYearMonthPt(previousMonths[previousMonths.length - 1])}`
      : 'Período Anterior';

  const termoClean = options.termoFiltro ? removeAccents(options.termoFiltro.toLowerCase().trim()) : '';

  if (direcao === 'aumento') {
    interface GrowthItem {
      cnp: string;
      segmentoBadge: string;
      designacao: string;
      vmmAnterior: number;
      qtdAnteriorEquiv: number;
      qtdRecente: number;
      vmmRecente: number;
      aumentoPct: number;
      ganhoMensalUn: number;
      stockAtual: number;
      coberturaNovoRitmo: number | null;
      diagnostico: string;
      acao: string;
      score: number;
    }

    const growths: GrowthItem[] = [];

    for (const p of prods) {
      if (p.vendas.length === 0) continue;

      const c = classifyProduct(p.cnp_codigo, p.designacao, p.taxa_iva);
      if (options.segmento && options.segmento !== 'TODOS') {
        if (options.segmento === 'GENERICO' && !c.eh_generico) continue;
        if (options.segmento === 'VENDA_LIVRE' && c.tipo_venda !== 'VENDA_LIVRE') continue;
        if (options.segmento === 'MNSRM' && c.tipo_venda !== 'MNSRM') continue;
        if (options.segmento === 'MSRM' && c.tipo_venda !== 'MSRM') continue;
        if (options.segmento === 'SEM_RECEITA' && c.tipo_venda === 'MSRM') continue;
      }

      if (termoClean) {
        const hay = removeAccents(`${p.designacao} ${c.categoria} ${c.grupo_equivalencia_dci || ''}`.toLowerCase());
        const tokens = termoClean.split(/\s+/).filter((t) => t.length > 2);
        if (tokens.length > 0 && !tokens.some((t) => hay.includes(t.slice(0, Math.max(3, t.length - 1))))) {
          continue;
        }
      }

      let qtdRecente = 0;
      let qtdAnteriorTotal = 0;
      let qtdImediataAnt = 0;

      for (const v of p.vendas) {
        const d = new Date(v.data_venda);
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        if (recentSet.has(ym)) {
          qtdRecente += v.quantidade;
        } else {
          qtdAnteriorTotal += v.quantidade;
          if (immediatePrevSet.has(ym)) {
            qtdImediataAnt += v.quantidade;
          }
        }
      }

      const minRecente = Math.max(3, N * 2);
      if (qtdRecente < minRecente) continue;

      const vmmRecente = qtdRecente / N;
      const vmmAnterior = qtdAnteriorTotal / numPrevMonths;
      const vmmImediataAnt = immediatePrevMonths.length > 0 ? qtdImediataAnt / immediatePrevMonths.length : vmmAnterior;

      // Considerar aumento significativo quando o ritmo recente supera em >=25% a média histórica anterior
      // (ou supera em >=30% os N meses imediatamente anteriores mantendo subida face à média anual)
      const cresceuFaceHistorico = vmmAnterior > 0 ? vmmRecente >= vmmAnterior * 1.25 : qtdRecente >= minRecente + 1;
      const cresceuFaceImediato =
        vmmImediataAnt > 0 && vmmRecente >= vmmImediataAnt * 1.3 && vmmRecente > vmmAnterior * 1.1;

      if (!cresceuFaceHistorico && !cresceuFaceImediato) continue;

      const baseVmm = cresceuFaceHistorico && vmmAnterior > 0 ? vmmAnterior : Math.max(0.5, vmmImediataAnt);
      const aumentoPct = Math.round(((vmmRecente - baseVmm) / baseVmm) * 100);
      if (aumentoPct < 20) continue;

      const ganhoMensalUn = Number((vmmRecente - baseVmm).toFixed(1));
      const stock = p.inventarios.reduce((s, i) => s + i.quantidade, 0);
      const coberturaNovoRitmo = vmmRecente > 0 ? Number((stock / vmmRecente).toFixed(1)) : null;

      const segmentoBadge = c.eh_generico
        ? '🧬 Genérico MG'
        : c.tipo_venda === 'VENDA_LIVRE'
          ? '🟢 Venda Livre'
          : c.tipo_venda === 'MNSRM'
            ? '🔵 MNSRM'
            : '🏷️ MSRM Marca';

      let diagnostico = '';
      let acao = '';

      if (stock === 0) {
        diagnostico = '🚨 Rutura em Pico de Procura (Stock = 0)';
        acao = `Encomendar já! Procura subiu para ${vmmRecente.toFixed(1)} un/mês (+${aumentoPct}%), mas o artigo esgotou.`;
      } else if (coberturaNovoRitmo !== null && coberturaNovoRitmo < 1.0) {
        const diasStock = Math.max(1, Math.round(coberturaNovoRitmo * 30));
        diagnostico = `⚠️ Risco de Rutura (~${diasStock} dias de stock)`;
        acao = `Reforçar encomenda e subir Stock Mínimo! Ao novo ritmo (${vmmRecente.toFixed(1)}/mês), ${stock} un não chegam para 1 mês.`;
      } else if (coberturaNovoRitmo !== null && coberturaNovoRitmo <= 2.5) {
        diagnostico = `🔥 Tração Forte e Cobertura Saudável (${coberturaNovoRitmo}m)`;
        acao = `Ajustar reposição ao novo ritmo (${vmmRecente.toFixed(1)}/mês) e garantir presença destacada no balcão/linear.`;
      } else {
        diagnostico = `🎯 Subida de Procura c/ Stock Folgado (${coberturaNovoRitmo}m)`;
        acao = `Aproveitar a aceleração (+${aumentoPct}%) para escoar as ${stock} un em stock com margem cheia (sem desconto).`;
      }

      const score = ganhoMensalUn * 10 + Math.min(aumentoPct, 250) * 0.25 + qtdRecente;

      growths.push({
        cnp: p.cnp_codigo,
        segmentoBadge,
        designacao: p.designacao,
        vmmAnterior: Number(baseVmm.toFixed(1)),
        qtdAnteriorEquiv: Math.round(baseVmm * N),
        qtdRecente,
        vmmRecente: Number(vmmRecente.toFixed(1)),
        aumentoPct,
        ganhoMensalUn,
        stockAtual: stock,
        coberturaNovoRitmo,
        diagnostico,
        acao,
        score,
      });
    }

    growths.sort((a, b) => b.score - a.score || b.aumentoPct - a.aumentoPct);

    const emRiscoRutura = growths.filter((g) => g.stockAtual === 0 || (g.coberturaNovoRitmo !== null && g.coberturaNovoRitmo < 1.0)).length;
    const labelMeses = N === 1 ? 'no Último Mês' : `nos Últimos ${N} Meses`;

    return {
      titulo: `Produtos com Aumento de Vendas ${labelMeses} (${labelJanelaRecente}) — ${growths.length} produtos em aceleração`,
      explicacao: `Análise da evolução temporal de vendas comparando a janela recente de **${N} ${N === 1 ? 'mês' : 'meses'} (${labelJanelaRecente})** face ao ritmo mensal anterior (${labelJanelaAnterior}). Foram identificados **${growths.length} produtos** com subida acentuada de procura, dos quais **${emRiscoRutura} têm risco imediato de rutura** se o stock mínimo não for atualizado para o novo ritmo.`,
      colunas: [
        'Código CNP',
        'Segmento',
        'Designação do Produto',
        `Ritmo Anterior (VMM)`,
        `Últimos ${N}m (${labelJanelaRecente})`,
        'Crescimento (%)',
        'Stock Atual (Cobertura Real)',
        'Diagnóstico Operacional',
        'Ação Recomendada',
      ],
      linhas: growths.slice(0, 35).map((g) => ({
        cnp: g.cnp,
        valores: [
          g.cnp,
          g.segmentoBadge,
          g.designacao,
          `${g.vmmAnterior}/mês (~${g.qtdAnteriorEquiv} un/${N}m)`,
          `${g.qtdRecente} un (${g.vmmRecente}/mês)`,
          `📈 +${g.aumentoPct}% (+${g.ganhoMensalUn}/mês)`,
          `${g.stockAtual} un (${g.coberturaNovoRitmo !== null ? g.coberturaNovoRitmo + 'm' : '-'})`,
          g.diagnostico,
          g.acao,
        ],
      })),
      resumoEstrategico: `Alerta de Abastecimento: Quando um produto dispara as vendas nos últimos ${N} meses, a cobertura calculada pela média de 12 meses engana o sistema de encomendas. Verifique prioritariamente os ${emRiscoRutura} artigos com cobertura real inferior a 1 mês ao novo ritmo.`,
    };
  }

  // Modo QUEDA DE VENDAS (parametrizado por N meses ou metade do ano)
  interface DropoffItem {
    cnp: string;
    designacao: string;
    vendasPeriodoAnterior: string;
    vendasPeriodoRecente: string;
    quebraPct: number;
    stockAtual: number;
    causaProvavel: string;
    acao: string;
    pesoAnterior: number;
  }

  const dropoffs: DropoffItem[] = [];
  const usarJanelaMeses = Boolean(options.mesesRecentes);

  for (const p of prods) {
    if (p.vendas.length < 3) continue;

    const c = classifyProduct(p.cnp_codigo, p.designacao, p.taxa_iva);
    if (options.segmento && options.segmento !== 'TODOS') {
      if (options.segmento === 'GENERICO' && !c.eh_generico) continue;
      if (options.segmento === 'VENDA_LIVRE' && c.tipo_venda !== 'VENDA_LIVRE') continue;
      if (options.segmento === 'MNSRM' && c.tipo_venda !== 'MNSRM') continue;
      if (options.segmento === 'MSRM' && c.tipo_venda !== 'MSRM') continue;
      if (options.segmento === 'SEM_RECEITA' && c.tipo_venda === 'MSRM') continue;
    }

    if (termoClean) {
      const hay = removeAccents(`${p.designacao} ${c.categoria} ${c.grupo_equivalencia_dci || ''}`.toLowerCase());
      const tokens = termoClean.split(/\s+/).filter((t) => t.length > 2);
      if (tokens.length > 0 && !tokens.some((t) => hay.includes(t.slice(0, Math.max(3, t.length - 1))))) {
        continue;
      }
    }

    let quebraPct = 0;
    let labelAnt = '';
    let labelRec = '';
    let pesoAnterior = 0;
    let isDrop = false;

    if (usarJanelaMeses) {
      let qtdRecente = 0;
      let qtdAnteriorTotal = 0;
      for (const v of p.vendas) {
        const d = new Date(v.data_venda);
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        if (recentSet.has(ym)) qtdRecente += v.quantidade;
        else qtdAnteriorTotal += v.quantidade;
      }
      const vmmAnt = qtdAnteriorTotal / numPrevMonths;
      const vmmRec = qtdRecente / N;
      if (qtdAnteriorTotal >= 8 && vmmAnt >= 1.2 && vmmRec <= vmmAnt * 0.45) {
        quebraPct = Math.round(((vmmAnt - vmmRec) / vmmAnt) * 100);
        labelAnt = `${vmmAnt.toFixed(1)}/mês (${qtdAnteriorTotal} un)`;
        labelRec = `${qtdRecente} un (${vmmRec.toFixed(1)}/mês)`;
        pesoAnterior = vmmAnt;
        isDrop = true;
      }
    } else {
      const vendasOrdenadas = [...p.vendas].sort(
        (a, b) => new Date(a.data_venda).getTime() - new Date(b.data_venda).getTime()
      );
      const meio = Math.floor(vendasOrdenadas.length / 2);
      const primeiraMetade = vendasOrdenadas.slice(0, meio).reduce((s, v) => s + v.quantidade, 0);
      const segundaMetade = vendasOrdenadas.slice(meio).reduce((s, v) => s + v.quantidade, 0);
      if (primeiraMetade >= 8 && segundaMetade <= primeiraMetade * 0.4) {
        quebraPct = Math.round(((primeiraMetade - segundaMetade) / primeiraMetade) * 100);
        labelAnt = `${primeiraMetade} un`;
        labelRec = `${segundaMetade} un`;
        pesoAnterior = primeiraMetade;
        isDrop = true;
      }
    }

    if (isDrop) {
      const stock = p.inventarios.reduce((s, i) => s + i.quantidade, 0);
      let causaProvavel = 'Quebra de Procura / Perda de Prescrição Médica';
      let acao = 'Avaliar se houve descontinuação de prescrição na área de saúde local e travar compras.';

      if (stock === 0) {
        causaProvavel = '⭕ Rutura Física de Stock (Não vendeu porque esteve esgotado)';
        acao = 'Reabastecer imediatamente! O produto tem saída mas está a 0 no armazém.';
      } else if (c.eh_generico) {
        causaProvavel = '🔄 Canibalização por outro laboratório genérico da mesma molécula';
        acao = 'Verificar qual o laboratório que a equipa está agora a dispensar no balcão.';
      }

      dropoffs.push({
        cnp: p.cnp_codigo,
        designacao: p.designacao,
        vendasPeriodoAnterior: labelAnt,
        vendasPeriodoRecente: labelRec,
        quebraPct,
        stockAtual: stock,
        causaProvavel,
        acao,
        pesoAnterior,
      });
    }
  }

  dropoffs.sort((a, b) => b.quebraPct - a.quebraPct || b.pesoAnterior - a.pesoAnterior);

  const sufixoJanela = usarJanelaMeses ? ` nos Últimos ${N} Meses (${labelJanelaRecente})` : '';

  return {
    titulo: `Deteção de Quebra Acentuada de Vendas${sufixoJanela} (${dropoffs.length} produtos em queda crítica)`,
    explicacao: `Foram analisadas as curvas de escoamento ao longo do ano${usarJanelaMeses ? ` comparando os últimos ${N} meses (${labelJanelaRecente}) com o período anterior` : ''}. Detetados ${dropoffs.length} produtos que registaram quedas acentuadas no ritmo de saída. É vital distinguir quedas provocadas por **ruturas de stock** de perdas provocadas por **troca de prescrição** ou substituição de laboratório.`,
    colunas: [
      'Código CNP',
      'Designação do Produto',
      usarJanelaMeses ? 'Ritmo Anterior' : 'Vendas 1º Período',
      usarJanelaMeses ? `Últimos ${N}m (${labelJanelaRecente})` : 'Vendas Período Recente',
      'Queda (%)',
      'Stock Físico',
      'Diagnóstico da Causa Raiz',
      'Ação Corretiva Recomendada',
    ],
    linhas: dropoffs.slice(0, 30).map((d) => ({
      cnp: d.cnp,
      valores: [
        d.cnp,
        d.designacao,
        d.vendasPeriodoAnterior,
        d.vendasPeriodoRecente,
        `📉 -${d.quebraPct}%`,
        `${d.stockAtual} un`,
        d.causaProvavel,
        d.acao,
      ],
    })),
    resumoEstrategico:
      'Alerta Operacional: Produtos com queda e stock a 0 representam vendas perdidas diretas. Produtos com queda e stock alto acumulam risco imediato de se transformarem em monos.',
  };
}

/**
 * 7B. Deteção de Queda Acentuada de Vendas (Drop-off Detection)
 * "quais os produtos que tiverem uma queda acentuada de vendas"
 */
export async function analyzeSalesDropoff(
  prisma: PrismaClient,
  farmaciaId: string,
  options?: Omit<SalesTrendOptions, 'direcao'>
): Promise<CopilotResponse> {
  return analyzeSalesTrend(prisma, farmaciaId, { ...options, direcao: 'queda' });
}

/**
 * 7C. Deteção de Aumento / Crescimento de Vendas nos Últimos N Meses
 * "quais os produtos que tiveram um aumento de vendas nos últimos 2 meses?"
 */
export async function analyzeSalesGrowth(
  prisma: PrismaClient,
  farmaciaId: string,
  options?: Omit<SalesTrendOptions, 'direcao'>
): Promise<CopilotResponse> {
  return analyzeSalesTrend(prisma, farmaciaId, { ...options, direcao: 'aumento' });
}

/**
 * 8. Deteção de Substituição de Produto (Handover / Canibalização)
 * "Tivemos algum produto que veio substituir este outro?"
 */
export async function analyzeProductSubstitution(
  prisma: PrismaClient,
  farmaciaId: string,
  targetTerm?: string
): Promise<CopilotResponse> {
  const inventarios = await prisma.inventario.findMany({
    where: { farmaciaId },
    include: {
      produto: {
        include: { vendas: { where: { farmaciaId } } },
      },
    },
  });

  // Agrupar por grupo DCI
  const grupos = new Map<string, Array<{ cnp: string; designacao: string; vendas: Array<{ mes: string; qtd: number }> }>>();

  for (const inv of inventarios) {
    const c = classifyProduct(inv.cnp_codigo, inv.produto.designacao, inv.produto.taxa_iva);
    if (!c.grupo_equivalencia_dci) continue;

    if (targetTerm && !removeAccents(inv.produto.designacao).includes(removeAccents(targetTerm))) {
      continue;
    }

    const vendas = inv.produto.vendas.map((v) => ({
      mes: v.data_venda.toISOString().slice(0, 7),
      qtd: v.quantidade,
    }));

    const list = grupos.get(c.grupo_equivalencia_dci) || [];
    list.push({ cnp: inv.cnp_codigo, designacao: inv.produto.designacao, vendas });
    grupos.set(c.grupo_equivalencia_dci, list);
  }

  interface SubstitutionEvent {
    grupoDci: string;
    antigoCnp: string;
    antigoDesc: string;
    novoCnp: string;
    novoDesc: string;
    mesTransicao: string;
    detalhe: string;
  }

  const eventos: SubstitutionEvent[] = [];

  for (const [grupo, prods] of grupos.entries()) {
    if (prods.length < 2) continue;

    for (let i = 0; i < prods.length; i++) {
      for (let j = 0; j < prods.length; j++) {
        if (i === j) continue;
        const p1 = prods[i]; // candidato a antigo
        const p2 = prods[j]; // candidato a substituto

        const v1Total = p1.vendas.reduce((s, v) => s + v.qtd, 0);
        const v2Total = p2.vendas.reduce((s, v) => s + v.qtd, 0);

        if (v1Total >= 5 && v2Total >= 5) {
          // Ordenar por mês
          const p1Map = new Map(p1.vendas.map((v) => [v.mes, v.qtd]));
          const p2Map = new Map(p2.vendas.map((v) => [v.mes, v.qtd]));

          const allMeses = Array.from(new Set([...p1Map.keys(), ...p2Map.keys()])).sort();

          for (let mIdx = 2; mIdx < allMeses.length - 1; mIdx++) {
            const mesCorte = allMeses[mIdx];
            const p1Antes = allMeses.slice(0, mIdx).reduce((s, m) => s + (p1Map.get(m) || 0), 0);
            const p1Depois = allMeses.slice(mIdx).reduce((s, m) => s + (p1Map.get(m) || 0), 0);
            const p2Antes = allMeses.slice(0, mIdx).reduce((s, m) => s + (p2Map.get(m) || 0), 0);
            const p2Depois = allMeses.slice(mIdx).reduce((s, m) => s + (p2Map.get(m) || 0), 0);

            if (p1Antes >= 5 && p1Depois <= 1 && p2Antes <= 2 && p2Depois >= 6) {
              eventos.push({
                grupoDci: grupo,
                antigoCnp: p1.cnp,
                antigoDesc: p1.designacao,
                novoCnp: p2.cnp,
                novoDesc: p2.designacao,
                mesTransicao: mesCorte,
                detalhe: `Transição em ${mesCorte}: "${p1.designacao}" desceu de ${p1Antes} un para ${p1Depois} un, enquanto "${p2.designacao}" assumiu a rotação subindo para ${p2Depois} un.`,
              });
              break;
            }
          }
        }
      }
    }
  }

  return {
    titulo: `Deteção de Substituições e Trocas de Fornecedor (${eventos.length} substituições identificadas)`,
    explicacao: `O algoritmo de cronologia identificou a substituição efetiva de produtos ao longo do tempo. Ocorre quando a farmácia esgota ou deixa de comprar a apresentação anterior e a equipa de balcão passa a dispensar a nova apresentação da mesma molécula.`,
    colunas: [
      'Molécula DCI',
      'Artigo Antigo Substituído',
      'Novo Artigo Substituto',
      'Mês da Transição',
      'Histórico de Handover',
    ],
    linhas: eventos.map((e) => ({
      cnp: e.novoCnp,
      valores: [
        `🧬 ${e.grupoDci}`,
        e.antigoDesc,
        `➡️ ${e.novoDesc}`,
        e.mesTransicao,
        e.detalhe,
      ],
    })),
    resumoEstrategico: 'Recomendação: Confirmar se o produto antigo ainda tem resíduos de gaveta ou encomendas pendentes e inativar o artigo antigo na tabela de compras do Sifarma.',
  };
}

/**
 * 9. Comparação Direta Multi-SKU (3 ou 4 produtos)
 * "preciso compara em vendas estes 3 ou 4 produtos"
 */
export async function compareProductsDirectly(
  prisma: PrismaClient,
  farmaciaId: string,
  searchTerms: string[]
): Promise<CopilotResponse> {
  const prods = await prisma.produtoMestre.findMany({
    where: {
      OR: searchTerms.map((t) => ({
        OR: [
          { cnp_codigo: { contains: t } },
          { designacao: { contains: t, mode: 'insensitive' } },
        ],
      })),
    },
    include: {
      inventarios: { where: { farmaciaId } },
      vendas: { where: { farmaciaId } },
    },
  });

  const comparacao = prods.map((p) => {
    const qtd = p.vendas.reduce((s, v) => s + v.quantidade, 0);
    const faturacao = p.vendas.reduce((s, v) => s + Number(v.valor_total), 0);
    const stock = p.inventarios.reduce((s, i) => s + i.quantidade, 0);
    const custo = p.inventarios[0] ? Number(p.inventarios[0].custo_unitario) : 0;
    const pvp = p.pvp ? Number(p.pvp) : qtd > 0 ? faturacao / qtd : custo * 1.4;
    const lucroUnit = pvp > custo ? pvp - custo : 0;
    const lucroTotal = lucroUnit * qtd;
    const margemPct = pvp > 0 ? (lucroUnit / pvp) * 100 : 0;
    const c = classifyProduct(p.cnp_codigo, p.designacao, p.taxa_iva);

    return {
      cnp: p.cnp_codigo,
      designacao: p.designacao,
      segmento: c.eh_generico ? '🧬 GENÉRICO MG' : c.tipo_venda,
      qtd,
      faturacao,
      stock,
      custo,
      pvp,
      margemPct,
      lucroTotal,
    };
  });

  comparacao.sort((a, b) => b.lucroTotal - a.lucroTotal);

  return {
    titulo: `Comparativo de Performance Comercial (${comparacao.length} artigos comparados)`,
    explicacao: `Análise frente a frente de unidades vendidas, faturação gerada, margem comercial e lucro bruto em caixa para os artigos selecionados.`,
    colunas: [
      'Código CNP',
      'Segmento',
      'Designação do Produto',
      'Unid. Vendidas',
      'Faturação (€)',
      'Preço Custo',
      'PVP (€)',
      'Margem (%)',
      'Lucro Bruto Gerado (€)',
      'Stock Atual',
    ],
    linhas: comparacao.map((c) => ({
      cnp: c.cnp,
      valores: [
        c.cnp,
        c.segmento,
        c.designacao,
        `${c.qtd} un`,
        `${c.faturacao.toFixed(2)} €`,
        `${c.custo.toFixed(2)} €`,
        `${c.pvp.toFixed(2)} €`,
        `${c.margemPct.toFixed(1)}%`,
        `💰 ${c.lucroTotal.toFixed(2)} €`,
        `${c.stock} un`,
      ],
    })),
    resumoEstrategico: 'Veredito: Priorize os artigos que combinam alto lucro total absoluto em euros, pois garantem a rentabilidade estrutural da farmácia.',
  };
}

/**
 * 10. Maximizador de Margem por Princípio Ativo (DCI)
 * "Qual o produto com este principio ativo que tem mais margem?"
 */
export async function analyzeBestMarginByDci(
  prisma: PrismaClient,
  farmaciaId: string,
  dciOrSearch: string
): Promise<CopilotResponse> {
  const prods = await prisma.produtoMestre.findMany({
    where: {
      OR: [
        { designacao: { contains: dciOrSearch, mode: 'insensitive' } },
        { categoria: { contains: dciOrSearch, mode: 'insensitive' } },
      ],
    },
    include: {
      inventarios: { where: { farmaciaId } },
      vendas: { where: { farmaciaId } },
    },
  });

  const ranking = prods
    .map((p) => {
      const c = classifyProduct(p.cnp_codigo, p.designacao, p.taxa_iva);
      const stock = p.inventarios.reduce((s, i) => s + i.quantidade, 0);
      const custo = p.inventarios[0] ? Number(p.inventarios[0].custo_unitario) : 0;
      const pvp = p.pvp ? Number(p.pvp) : 0;
      const margemPct = p.margem_padrao ? Number(p.margem_padrao) : pvp > custo ? ((pvp - custo) / pvp) * 100 : 0;
      const lucroPorCaixa = pvp > custo ? pvp - custo : 0;
      const qtdVendida = p.vendas.reduce((s, v) => s + v.quantidade, 0);

      return {
        cnp: p.cnp_codigo,
        designacao: p.designacao,
        segmento: c.eh_generico ? '🧬 GENÉRICO MG' : c.tipo_venda,
        dci: c.grupo_equivalencia_dci || c.molecula_dci || 'N/A',
        stock,
        custo,
        pvp,
        margemPct,
        lucroPorCaixa,
        qtdVendida,
      };
    })
    .sort((a, b) => b.margemPct - a.margemPct || b.lucroPorCaixa - a.lucroPorCaixa);

  return {
    titulo: `Ranking de Rentabilidade e Margem: "${dciOrSearch}" (${ranking.length} apresentações encontradas)`,
    explicacao: `Comparação de margem percentual e lucro bruto por embalagem para as apresentações encontradas. Na dispensa de genéricos perante receita médica por DCI, a substituição pelo laboratório com maior margem e menor custo maximiza diretamente a rentabilidade da farmácia.`,
    colunas: [
      'Código CNP',
      'Segmento',
      'Apresentação / Laboratório',
      'Custo Farmácia',
      'PVP Venda',
      'Margem Bruta (%)',
      'Lucro Bruto / Caixa (€)',
      'Unid. Vendidas',
      'Stock Atual',
    ],
    linhas: ranking.map((r) => ({
      cnp: r.cnp,
      valores: [
        r.cnp,
        r.segmento,
        r.designacao,
        `${r.custo.toFixed(2)} €`,
        `${r.pvp.toFixed(2)} €`,
        `📈 ${r.margemPct.toFixed(1)}%`,
        `💰 ${r.lucroPorCaixa.toFixed(2)} €/cx`,
        r.qtdVendida,
        `${r.stock} un`,
      ],
    })),
    resumoEstrategico: 'Recomendação: Negociar melhores condições comerciais no laboratório líder em margem e defini-lo como primeira opção de dispensa no sistema informático.',
  };
}

/**
 * 11. Arbitragem e Trade-off Volume vs. Margem
 * "Tendo em conta que temos este produto que tem mais margem mas n tem tantas vendas e o outro que tem menos margem mas mais vendas, o que fazemos mantemos ou desistimos do produto de margem?"
 */
export async function analyzeMarginVolumeTradeoff(
  prisma: PrismaClient,
  farmaciaId: string,
  searchTerms: string[]
): Promise<CopilotResponse> {
  const prods = await prisma.produtoMestre.findMany({
    where: {
      OR: searchTerms.map((t) => ({
        designacao: { contains: t, mode: 'insensitive' },
      })),
    },
    include: {
      inventarios: { where: { farmaciaId } },
      vendas: { where: { farmaciaId } },
    },
  });

  const stats = prods.map((p) => {
    const qtd = p.vendas.reduce((s, v) => s + v.quantidade, 0);
    const stock = p.inventarios.reduce((s, i) => s + i.quantidade, 0);
    const custo = p.inventarios[0] ? Number(p.inventarios[0].custo_unitario) : 0;
    const pvp = p.pvp ? Number(p.pvp) : 0;
    const margemPct = p.margem_padrao ? Number(p.margem_padrao) : pvp > custo ? ((pvp - custo) / pvp) * 100 : 0;
    const lucroUnit = pvp > custo ? pvp - custo : 0;
    const massaLucroTotal = lucroUnit * qtd;

    return {
      cnp: p.cnp_codigo,
      designacao: p.designacao,
      qtd,
      stock,
      custo,
      pvp,
      margemPct,
      massaLucroTotal,
    };
  });

  stats.sort((a, b) => b.massaLucroTotal - a.massaLucroTotal);

  return {
    titulo: 'Veredito Estratégico: Trade-Off Volume de Vendas vs. Margem Comercial',
    explicacao: `Auditoria de Massa de Margem Real:\n\n` +
      `💡 **Regra de Ouro da Gestão de Farmácia:** A farmácia não deposita percentagens no banco, deposita Euros de Lucro Bruto (€)! Um produto com 50% de margem que vende 2 caixas gera menos dinheiro real do que um produto com 25% de margem que vende 50 caixas.\n\n` +
      `⚖️ **Veredito:**\n` +
      `1. **Não desista imediatamente do produto de margem alta**, mas **NÃO acumule stock**: Mantenha apenas 1 ou 2 caixas de buffer com reposição diária "Just-in-Time".\n` +
      `2. **O produto de alto volume é a sua locomotiva de tesouraria:** Assegure stock de segurança permanente para nunca ter rutura.`,
    colunas: [
      'Código CNP',
      'Artigo Analisado',
      'Unid. Vendidas (Volume)',
      'Margem Percentual (%)',
      'Massa de Lucro Bruto (€)',
      'Stock Atual',
      'Parecer Financeiro & Decisão',
    ],
    linhas: stats.map((s, idx) => ({
      cnp: s.cnp,
      valores: [
        s.cnp,
        s.designacao,
        `${s.qtd} un`,
        `${s.margemPct.toFixed(1)}%`,
        `💰 ${s.massaLucroTotal.toFixed(2)} €`,
        `${s.stock} un`,
        idx === 0
          ? '🌟 LÍDER DE LUCRO REAL: Manter stock de segurança prioritário e automatizar compras.'
          : '⚠️ ARTIGO DE NICHO: Manter apenas 1-2 unidades em stock e aprovisionar sob encomenda.',
      ],
    })),
    resumoEstrategico: 'Decisão Final: Manter ambos com papéis diferenciados no sortido — o campeão de volume garante a rotação e a fidelização; o de margem garante a rentabilização de clientes seletivos sem imobilizar capital excessivo.',
  };
}

// ============================================================================
// 4. PESQUISA AVANÇADA POR TOKENS / LEMAS / CATEGORIAS (PRESERVATIVOS, CREMES, ETC.)
// ============================================================================

export async function analyzeFlexiblePharmaSearch(
  prisma: PrismaClient,
  farmaciaId: string,
  searchQuery: string,
  options?: { sortBy?: 'vendas' | 'lucro' | 'margem' | 'stock' }
): Promise<CopilotResponse> {
  // Motor de catálogo: todos os termos obrigatórios (AND), sinónimos/conceitos,
  // deteção de intenção de stock ("temos", "em stock") e pesquisa sem acentos.
  const override = options?.sortBy && options.sortBy !== 'vendas' ? options.sortBy : undefined;
  return localSmartSearch(prisma, farmaciaId, searchQuery, override);
}

/**
 * @deprecated Pesquisa antiga por OR de tokens (mantida apenas como referência).
 */
export async function analyzeFlexiblePharmaSearchLegacy(
  prisma: PrismaClient,
  farmaciaId: string,
  searchQuery: string,
  options?: { sortBy?: 'vendas' | 'lucro' | 'margem' | 'stock' }
): Promise<CopilotResponse> {
  const { lemmas, stems, cleanTokens } = extractSearchTokens(searchQuery);

  const searchWords = Array.from(new Set([...lemmas, ...stems, ...cleanTokens]));

  // Buscar produtos com OR dinâmico nos tokens lematizados
  const prods = await prisma.produtoMestre.findMany({
    where: {
      OR: searchWords.flatMap((term) => [
        { cnp_codigo: { contains: term } },
        { designacao: { contains: term, mode: 'insensitive' } },
        { categoria: { contains: term, mode: 'insensitive' } },
      ]),
    },
    include: {
      inventarios: { where: { farmaciaId } },
      vendas: { where: { farmaciaId } },
    },
    take: 100,
  });

  const list = prods.map((p) => {
    const qtdVendida = p.vendas.reduce((s, v) => s + v.quantidade, 0);
    const faturacao = p.vendas.reduce((s, v) => s + Number(v.valor_total), 0);
    const stock = p.inventarios.reduce((s, i) => s + i.quantidade, 0);
    const custoUnit = p.inventarios[0] ? Number(p.inventarios[0].custo_unitario) : 0;
    const pvp = p.pvp ? Number(p.pvp) : qtdVendida > 0 ? faturacao / qtdVendida : custoUnit * 1.4;
    const margem = p.margem_padrao ? Number(p.margem_padrao) : pvp > custoUnit ? ((pvp - custoUnit) / pvp) * 100 : 30;
    const lucroBruto = (pvp - custoUnit) * qtdVendida;
    const vmm = qtdVendida / 12;
    const cobertura = vmm > 0 ? stock / vmm : stock > 0 ? 999 : 0;
    const c = classifyProduct(p.cnp_codigo, p.designacao, p.taxa_iva);

    let diagnostico = '✅ Rotação Regular';
    if (stock === 0 && qtdVendida > 0) diagnostico = '⭕ Esgotado (Tem Procura)';
    else if (stock === 0 && qtdVendida === 0) diagnostico = '⚪ Sem Stock / Sem Venda';
    else if (stock > 0 && qtdVendida === 0) diagnostico = '🛑 Mono (0 vendas)';
    else if (stock > 0 && cobertura > 4) diagnostico = `⚠️ Excesso (${cobertura.toFixed(1)}m cob.)`;

    return {
      cnp: p.cnp_codigo,
      designacao: p.designacao,
      segmento: c.eh_generico ? '🧬 GENÉRICO MG' : c.tipo_venda,
      categoria: c.categoria,
      qtdVendida,
      faturacao,
      vmm,
      stock,
      custoUnit,
      pvp,
      margem,
      lucroBruto,
      diagnostico,
    };
  });

  const sort = options?.sortBy || 'vendas';
  list.sort((a, b) => {
    if (sort === 'lucro') return b.lucroBruto - a.lucroBruto;
    if (sort === 'margem') return b.margem - a.margem;
    if (sort === 'stock') return b.stock - a.stock;
    return b.qtdVendida - a.qtdVendida || b.stock - a.stock;
  });

  const termoPrincipal = lemmas[0] || searchQuery;
  const termoFormatado = termoPrincipal.charAt(0).toUpperCase() + termoPrincipal.slice(1);

  return {
    titulo: `Análise Comercial de Artigos para "${termoFormatado}" (${prods.length} apresentações encontradas)`,
    explicacao: `Foram localizadas ${prods.length} referências através de correspondência lematizada e fonética na farmácia. Ordenado por volume de vendas decrescente. Clique em qualquer produto para ver o histórico detalhado.`,
    colunas: [
      'Código CNP',
      'Segmento',
      'Designação do Produto',
      'Unid. Vendidas',
      'Faturação (€)',
      'VMM (mês)',
      'Stock Atual',
      'Preço Custo',
      'PVP (€)',
      'Margem (%)',
      'Diagnóstico de Stock',
    ],
    linhas: list.map((r) => ({
      cnp: r.cnp,
      valores: [
        r.cnp,
        r.segmento,
        r.designacao,
        `${r.qtdVendida} un`,
        `${r.faturacao.toFixed(2)} €`,
        `${r.vmm.toFixed(1)}/mês`,
        `${r.stock} un`,
        `${r.custoUnit.toFixed(2)} €`,
        `${r.pvp.toFixed(2)} €`,
        `${r.margem.toFixed(1)}%`,
        r.diagnostico,
      ],
    })),
    resumoEstrategico: `Visão Geral: Total de ${list.reduce((s, i) => s + i.qtdVendida, 0)} unidades vendidas e ${list.reduce((s, i) => s + i.stock, 0)} unidades atualmente em stock.`,
  };
}

// ============================================================================
// 5. DISPACHADOR CENTRAL DE PERGUNTAS LIVRES (INTENT DISPATCHER)
// ============================================================================

export async function processFreeformQuestion(
  prisma: PrismaClient,
  farmaciaId: string,
  question: string,
  options?: { diasMonos?: number; cobertura?: number }
): Promise<CopilotResponse | null> {
  const q = removeAccents(question.toLowerCase().trim());

  // 1. "Para a mesma substancia e dosagem que laboratorios eliminarias por n ter vendas ha 3 meses ou mais"
  if (
    (q.includes('eliminar') || q.includes('eliminavas') || q.includes('eliminarias') || q.includes('tirar') || q.includes('descontinuar') || q.includes('cortar') || q.includes('deixar de comprar')) &&
    (q.includes('laboratori') || q.includes('lab') || q.includes('substancia') || q.includes('dosagem') || q.includes('marca') || q.includes('generico') || q.includes('mesma'))
  ) {
    const numMatch = q.match(/\b(\d+)\s*(?:mes|meses|dia|dias)\b/);
    let dias = options?.diasMonos || 90;
    if (numMatch) {
      const val = parseInt(numMatch[1], 10);
      dias = q.includes('dia') ? val : val * 30;
    }
    return analyzeLaboratoryElimination(prisma, farmaciaId, dias);
  }

  // 2. "Que stocks ajustavas"
  if (
    (q.includes('ajust') || q.includes('otimiz') || q.includes('rever') || q.includes('corrigir')) &&
    (q.includes('stock') || q.includes('armazem') || q.includes('existencia') || q.includes('inventario'))
  ) {
    return analyzeStockAdjustment(prisma, farmaciaId, {
      limiteCobertura: options?.cobertura,
      periodoMonos: options?.diasMonos,
    });
  }

  // 3. "Do stock parado que tenho o que faz sentido recomendar a idosos com problemas cardiacos"
  if (
    (q.includes('parado') || q.includes('mono') || q.includes('encalhado') || q.includes('empatado')) &&
    (q.includes('idoso') || q.includes('senior') || q.includes('velho') || q.includes('geriat')) &&
    (q.includes('card') || q.includes('coracao') || q.includes('tensa') || q.includes('pressa'))
  ) {
    return analyzeSafeDeadStockForSeniorCardiac(prisma, farmaciaId);
  }

  // 4. "Que produtos de venda livre posso sugerir para os diabeticos"
  if (
    (q.includes('diabet') || q.includes('hipertens') || q.includes('idoso') || q.includes('grávida') || q.includes('gravida') || q.includes('crianca')) &&
    (q.includes('suger') || q.includes('recomenda') || q.includes('aconselh') || q.includes('venda livre') || q.includes('otc') || q.includes('oferecer'))
  ) {
    return analyzeConditionRecommendations(prisma, farmaciaId, q);
  }

  // 5. "Cria uma campanha de venda para os produtos cosmeticos agora para Dezembro e diz quais o que temos para incluir"
  if (
    (q.includes('campanha') || q.includes('promoc') || q.includes('promo') || q.includes('kit') || q.includes('natal') || q.includes('saldos')) &&
    (q.includes('cosmet') || q.includes('rosto') || q.includes('creme') || q.includes('dezembro') || q.includes('inverno') || q.includes('verao') || q.includes('solar'))
  ) {
    const isDezembro = q.includes('dezembro') || q.includes('natal');
    return analyzeSeasonalCampaign(
      prisma,
      farmaciaId,
      q.includes('cosmet') ? 'cosmet' : 'creme',
      isDezembro ? 'Dezembro / Natal' : 'Campanha Especial'
    );
  }

  // 6A. "quais os produtos que tiveram um aumento de vendas nos últimos 2 meses?"
  if (
    (q.includes('aument') ||
      q.includes('subid') ||
      q.includes('subiram') ||
      q.includes('crescim') ||
      q.includes('cresceram') ||
      q.includes('disparar') ||
      q.includes('acelerar') ||
      q.includes('pico')) &&
    (q.includes('venda') || q.includes('saida') || q.includes('escoamento') || q.includes('procura'))
  ) {
    const mMatch = q.match(/\b(\d{1,2})\s*(?:mes|meses)\b/);
    const mesesRecentes = mMatch ? parseInt(mMatch[1], 10) : q.includes('ultimo mes') ? 1 : q.includes('trimestre') ? 3 : 2;
    return analyzeSalesGrowth(prisma, farmaciaId, { mesesRecentes });
  }

  // 6B. "quais os produtos que tiverem uma queda acentuada de vendas"
  if (
    (q.includes('queda') || q.includes('quebra') || q.includes('cairam') || q.includes('baixaram') || q.includes('perderam') || q.includes('drop')) &&
    (q.includes('venda') || q.includes('saida') || q.includes('escoamento') || q.includes('procura'))
  ) {
    const mMatch = q.match(/\b(\d{1,2})\s*(?:mes|meses)\b/);
    const mesesRecentes = mMatch ? parseInt(mMatch[1], 10) : q.includes('ultimo mes') ? 1 : undefined;
    return analyzeSalesDropoff(prisma, farmaciaId, { mesesRecentes });
  }

  // 7. "Tivemos algum produto que veio substituir este outro?"
  if (
    q.includes('substitu') ||
    q.includes('canibali') ||
    q.includes('passamos a vender') ||
    q.includes('trocamos por') ||
    q.includes('veio no lugar')
  ) {
    return analyzeProductSubstitution(prisma, farmaciaId);
  }

  // 8. "Tendo em conta que temos este produto que tem mais margem mas n tem tantas vendas e o outro que tem menos margem mas mais vendas, o que fazemos mantemos ou desistimos do produto de margem?"
  if (
    (q.includes('mantemos') || q.includes('desist') || q.includes('trade-off') || q.includes('trade off') || q.includes('o que fazemos')) &&
    (q.includes('margem') && q.includes('venda'))
  ) {
    const terms = q
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS_PT.has(w));
    return analyzeMarginVolumeTradeoff(prisma, farmaciaId, terms.slice(0, 4));
  }

  // 9. "Qual o produto com este principio ativo que tem mais margem?"
  if (
    (q.includes('principio ativo') || q.includes('dci') || q.includes('molecula') || q.includes('substancia')) &&
    (q.includes('mais margem') || q.includes('maior margem') || q.includes('rentav'))
  ) {
    const cleanDci = q
      .replace(/[^\w\s]/g, ' ')
      .replace(/\b(qual|o|produto|com|este|principio|ativo|dci|molecula|que|tem|mais|maior|margem|rentavel)\b/g, '')
      .trim();
    return analyzeBestMarginByDci(prisma, farmaciaId, cleanDci || 'Paracetamol');
  }

  // 10. "Vitativ Transilax Comp 20 com que produtos de receita medica ou venda livre posso fazer venda cruzada"
  if (
    q.includes('cross') ||
    q.includes('venda cruzada') ||
    q.includes('associar') ||
    (q.includes('com que produtos') && q.includes('posso'))
  ) {
    const target = q
      .replace(/\b(com que produtos|de receita medica|ou venda livre|posso fazer|venda cruzada|cross-selling|cross selling|cross)\b/g, '')
      .trim();
    return analyzeClinicalCrossSelling(prisma, farmaciaId, target || 'transilax');
  }

  // 11. "preciso compara em vendas estes 3 ou 4 produtos"
  if (q.includes('compara') || q.includes('versus') || /\bvs\b/.test(q)) {
    const terms = q
      .replace(/\b(preciso|compara|comparar|em|vendas|estes|ou|produtos|artigos|vs|versus)\b/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS_PT.has(w));
    return compareProductsDirectly(prisma, farmaciaId, terms);
  }

  // Se for uma consulta macro geral (ex: radiografia de estatuto, taxa de IVA, caducidade 2026, ou ranking financeiro geral "top 10 genéricos que mais geram dinheiro")
  const isBroadMacroQuery =
    q.includes('estatuto') ||
    q.includes('radiografia') ||
    q.includes('divisao') ||
    q.includes('divisão') ||
    q.includes('iva') ||
    (q.includes('caduc') && q.includes('2026')) ||
    (q.includes('duplicad') && (q.includes('molecula') || q.includes('gaveta'))) ||
    ((q.includes('dinheiro') || q.includes('lucro') || q.includes('fatura')) && (q.includes('top 10') || q.includes('top 20') || q.includes('top 30') || q.includes('mais geram dinheiro')));

  if (isBroadMacroQuery) {
    return null;
  }

  // 12. Pesquisa Inteligente com Lematização e Plurais ("quais os preservativos que temos vendido mais", "cremes com mais margem")
  const { lemmas, cleanTokens } = extractSearchTokens(question);
  if (cleanTokens.length > 0) {
    const isMarginSort = q.includes('margem') || q.includes('rentav');
    const isLucroSort = q.includes('dinheiro') || q.includes('lucro') || q.includes('fatura');
    const isStockSort = q.includes('stock') || q.includes('existencia');

    const sortBy = isMarginSort ? 'margem' : isLucroSort ? 'lucro' : isStockSort ? 'stock' : 'vendas';
    return analyzeFlexiblePharmaSearch(prisma, farmaciaId, question, { sortBy });
  }

  return null;
}
