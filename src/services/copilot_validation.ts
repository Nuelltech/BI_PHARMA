// ============================================================================
// ROUTER DE INTENÇÃO, GATING DE FERRAMENTAS E VALIDADOR DETERMINÍSTICO (V1-V20)
// ============================================================================

import { isTherapeuticChronic } from './copilot_chronic_therapies';

const CNP_REGEX = /\b\d{7}\b/g;

export type CopilotIntent =
  | 'VENDAS_FINANCEIRO'
  | 'STOCK_VALIDADES'
  | 'LAB_DCI'
  | 'PATRIMONIO_MONOS'
  | 'FICHA_PRODUTO'
  | 'COMPRAS'
  | 'PLANO_ACOES'
  | 'CAMPANHA_PACKS'
  | 'CROSSSELL_BALCAO'
  | 'FOLLOWUP'
  | 'CLINICO'
  | 'FORA_AMBITO';

export interface QuestionIntentInfo {
  intent: CopilotIntent;
  decisionAllowed: boolean;
  acaoEscritaPedida: boolean;
  confirmacaoUtilizador: boolean;
  subperguntasCount: number;
}

export function classifyQuestionIntent(question: string, hasPreviousResults = false): QuestionIntentInfo {
  const q = (question || '').trim();
  const qLower = q.toLowerCase();

  const confirmacaoUtilizador =
    /\b(sim|confirmo|confirmado|avan[çc]a|pode(s)? criar|pode(s)? ativar|pode(s)? gravar|ok cria|ok ativa|concordo)\b/i.test(
      qLower
    );

  const acaoEscritaPedida =
    /\b(cria(r)?\s+(uma\s+)?tarefa|criar\s+miss[aã]o|ativa(r)?\s+(uma\s+|a\s+)?campanha|guardar\s+tarefa)\b/i.test(
      qLower
    ) || confirmacaoUtilizador;

  const asksCompras =
    /\b(encomend(ar|a|as)|compr(ar|a|as)|repor|reposi[çc][ãa]o|proposta de encomenda|lista de (encomenda|compra)(s)?|sugest[ãa]o de encomenda|carrinho de compras|necessidade(s)? de encomenda|o que (devemos|devo) (encomendar|comprar|repor|n[aã]o voltar a encomendar)|deixar de encomendar|n[aã]o voltar a encomendar|acordo anual|planear compras)\b/i.test(
      qLower
    );

  const asksPacksCampanha =
    /\b(pack(s)?|campanha(s)?|promo[çc][ãa]o|cesto(s)? promociona(l|is)|black friday|dia da m[ãa]e)\b/i.test(qLower);

  const asksClinicoPuro =
    /\b(dor de dentes|posologia|quantos comprimidos deve tomar|qual a dose para|receitar|diagnosticar)\b/i.test(
      qLower
    );

  const asksCrossSell =
    !asksClinicoPuro &&
    /\b(venda(s)? cruzada(s)?|cross[- ]?sell(ing)?|o que (posso|sugeres|temos de venda livre|sugiro|devo sugerir)|associar|estou a (aviar|vender|dispensar)|o cliente tem|para adulto com|para crian[çc]a com|diarreia|barriga solta|desarranjo|obstipa[çc][ãa]o|pris[ãa]o de ventre|intestino preso|azia|pirose|refluxo|m[áa] digest[ãa]o|indigest[ãa]o|cansa[çc]o|fadiga|fraqueza|micose|p[ée] de atleta|queimadura solar|protetor solar|after sun|constipa[çc][ãa]o|garganta|rouquid[ãa]o|l[áa]bios|cieiro|tosse|catarro|nariz entupido|nariz tapado|congest[ãa]o nasal|dor muscular|dores musculares|contratura|c[ãa]ibras|dor no ombro|pernas pesadas|pernas cansadas|pele seca|pele ressequida|olho(s)? seco(s)?|olhos irritados|queda de cabelo)\b/i.test(
      qLower
    );

  const asksPlanoAcoes =
    /\b(plano de a[çc][ãa]o|plano semanal|folha da semana|tarefas para a equipa|4 pilares)\b/i.test(qLower);

  const isFollowUp =
    hasPreviousResults &&
    (/^(dessa lista|desses|destes|só os|apenas os|mostra só|filtra|ordena|exclui|em valor|em unidades|e os outros)/i.test(
      qLower
    ) ||
      (q.split(/\s+/).length <= 12 && /\b(dessa|desses|destes|só os|apenas os|ordena|filtra|exclui)\b/i.test(qLower)));

  let intent: CopilotIntent = 'VENDAS_FINANCEIRO';
  if (asksClinicoPuro) intent = 'CLINICO';
  else if (asksCompras) intent = 'COMPRAS';
  else if (asksPacksCampanha) intent = 'CAMPANHA_PACKS';
  else if (asksPlanoAcoes) intent = 'PLANO_ACOES';
  else if (asksCrossSell) intent = 'CROSSSELL_BALCAO';
  else if (isFollowUp) intent = 'FOLLOWUP';
  else if (/\b(mono(s)?|resto(s)? de gaveta|imobilizado|marco zero|destrave|escoamento|escoar)\b/i.test(qLower)) {
    intent = 'PATRIMONIO_MONOS';
  } else if (/\b(validade(s)?|caducidade(s)?|expira(r|m)?|lote(s)?|stock|cobertura|rutura(s)?)\b/i.test(qLower)) {
    intent = 'STOCK_VALIDADES';
  } else if (/\b(laborat[óo]rio|bial|generis|teva|viatris|cinfa|krka|sandoz|dci|gen[ée]rico(s)?|similar(es)?)\b/i.test(qLower)) {
    intent = 'LAB_DCI';
  } else if (/\b\d{7}\b/.test(qLower)) {
    intent = 'FICHA_PRODUTO';
  }

  const decisionAllowed =
    asksCompras || asksPacksCampanha || asksCrossSell || asksPlanoAcoes || acaoEscritaPedida;

  // Estimativa de número de subperguntas (vírgulas interrogativas, "e quais", "os que")
  const subParts = q.split(/\?|,\s*(?:quais|os que|e os que|e quais)|\s+e\s+quais\s+/i).filter((s) => s.trim().length > 5);
  const subperguntasCount = Math.max(1, subParts.length);

  return {
    intent,
    decisionAllowed,
    acaoEscritaPedida,
    confirmacaoUtilizador,
    subperguntasCount,
  };
}

export function extractCnps(text: string): Set<string> {
  const out = new Set<string>();
  const matches = (text || '').match(CNP_REGEX);
  if (matches) matches.forEach((m) => out.add(m));
  return out;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
  sanitizedText?: string;
}

// Regra V1: Deteta secções de encomenda / proibição / estratégia de negociação não solicitadas
const UNSOLICITED_PURCHASE_HEADING_RX =
  /^(\s*#{1,4}\s+.*|\s*\*\*[^*\n]{3,100}\*\*\s*|\s*[✅🚫⛔🎯⚠️]+\s*\*\*?[^*\n]{3,100})$/gm;

const PURCHASE_HEADING_KEYWORDS_RX =
  /\b(produtos?\s+para\s+encomendar|proibid[oa]s?\s+de\s+encomendar|recomenda[çc][ãa]o\s+estrat[ée]gica|exigir\s+ao|estrat[ée]gia\s+de\s+negocia[çc][ãa]o|alertas?\s+cr[íi]ticos?\s+de\s+tesouraria|decis[õo]es\s+de\s+compra)\b/i;

export function findUnsolicitedPurchaseHeadings(text: string): string[] {
  const found: string[] = [];
  const matches = (text || '').match(UNSOLICITED_PURCHASE_HEADING_RX) || [];
  for (const line of matches) {
    if (PURCHASE_HEADING_KEYWORDS_RX.test(line)) {
      found.push(line.trim());
    }
  }
  return found;
}

export function stripUnsolicitedPurchaseSections(text: string): string {
  const lines = (text || '').split('\n');
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const isHeading = /^(\s*#{1,4}\s+|\s*---\s*$|\s*\*\*[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ0-9📈📉✅🚫⛔🎯⚠️])/.test(line);
    if (isHeading && PURCHASE_HEADING_KEYWORDS_RX.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^(\s*#{1,4}\s+|\s*---\s*$)/.test(line) && !PURCHASE_HEADING_KEYWORDS_RX.test(line)) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function postProcessCopilotText(
  rawText: string,
  toolsUsedThisTurn: string[],
  toolResultsJson: string[],
  intentInfo?: QuestionIntentInfo
): string {
  let text = rawText || '';

  // V8: Remover marcadores de UI se a ferramenta correspondente não foi executada neste turno
  const ranEncomenda = toolsUsedThisTurn.includes('gerar_proposta_encomenda_reposicao');
  if (!ranEncomenda) {
    text = text
      .replace(/\[BOTAO_EXPORTAR_ENCOMENDA_CSV\]/g, '')
      .replace(/\[BOTAO_APLICAR_ENCOMENDA_FOLHA\]/g, '');
  }

  const ranPacks = toolsUsedThisTurn.includes('sugerir_packs_promocionais');
  if (!ranPacks) {
    text = text.replace(/\[BOTAO_GUARDAR_PACK\]/g, '');
  }

  const hasCheckboxes = /^-\s*\[\s*\]\s+/m.test(text);
  if (!hasCheckboxes || (intentInfo && !intentInfo.decisionAllowed)) {
    text = text.replace(/\[BOTAO_APLICAR_PLANO\]/g, '');
  }

  // V12: Remover nomes técnicos internos e linhas meta sobre inserção automática de tabelas
  text = text
    .replace(/\b(v_metricas|v_vendas_mes|v_grupos_dci|v_catalogo|v_snapshots|v_kpis)\b/g, 'base de dados')
    .replace(/\b(r_\d{4})\b/g, '')
    .replace(/^\s*\[As tabelas[^\]]*\]\s*$/gim, '')
    .replace(/^\s*##\s*Relat[óo]rio\s+Detalhado\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n');

  // V14: Qualificação de margem estimada quando mostra margem por mês
  const usedEstimatedMargin = toolResultsJson.some((j) => j.includes('"estimada_custo_medio_atual"'));
  const mentionsMargin = /\bmargem\b/i.test(text);
  const alreadyQualified = /\bestimad[ao]\b|\bcusto m[ée]dio\b/i.test(text);
  if (usedEstimatedMargin && mentionsMargin && !alreadyQualified) {
    text = `${text.trim()}\n\n_Margem estimada com o custo médio atual._`;
  }

  return text.trim();
}

export function validateCopilotAnswer(
  finalText: string,
  toolResultsJson: string[],
  toolsUsed: string[],
  intentInfo?: QuestionIntentInfo
): ValidationResult {
  const problems: string[] = [];

  // V4: Todo o CNP citado tem de existir nos dados devolvidos pelas ferramentas
  const knownCnps = new Set<string>();
  for (const r of toolResultsJson) extractCnps(r).forEach((c) => knownCnps.add(c));

  const cited = extractCnps(finalText);
  const unverified = [...cited].filter((c) => !knownCnps.has(c));
  if (unverified.length > 0) {
    problems.push(
      `[V4] Citaste os CNP ${unverified.join(', ')} que NÃO existem nos resultados das ferramentas. ` +
        `Remove-os ou consulta os dados para os confirmar. Não inventes produtos.`
    );
  }

  // V4b: Resposta com produtos concretos sem ter consultado dados
  if (toolsUsed.length === 0 && cited.size > 0) {
    problems.push('[V4] Citaste produtos sem consultar nenhuma ferramenta de dados. Consulta os dados antes de responder.');
  }

  // V12: Não expor a "cozinha" técnica ao utilizador
  if (/inconsist[eê]ncia nos dados devolvidos|a ferramenta (devolveu|retornou|apenas retornou)/i.test(finalText)) {
    problems.push(
      '[V12] Não expor falhas internas das ferramentas ao utilizador. Se os dados não chegam, faz uma nova consulta mais adequada ou diz apenas que não há informação fiável.'
    );
  }

  // V5: Proibição de deduzir ou usar "presumível" / posologias médicas
  if (/\b(presum[ií]vel|presumivelmente|provavelmente\s+(é|serve))\b/i.test(finalText)) {
    problems.push(
      '[V5] Proibido adivinhar, deduzir ou usar a palavra "presumível" / "provavelmente é" para dados não existentes na base de dados. Escreve "-" ou "Sem dados".'
    );
  }

  if (/\b\d+\s*(mg|ml|comp|comprimidos?|c[áa]psulas?)\s*(por|\/)\s*(dia|toma)\b/i.test(finalText)) {
    problems.push(
      '[V5] Proibido indicar posologias clínicas (ex: X comp/dia). Remove qualquer posologia ou instrução médica.'
    );
  }

  // V6: Proibição legal de sugerir aumentar PVP de MSRM
  if (/(aumentar|subir)\s+(o\s+)?pvp/i.test(finalText) && /\bMSRM\b/i.test(finalText)) {
    problems.push(
      '[V6] Proibido sugerir aumentar o PVP de medicamentos MSRM (preço fixado pelo Estado). Indica apenas possível erro de registo de custo no Sifarma.'
    );
  }

  // V1: Secções fora de âmbito (Encomendar / Proibidos de Encomendar / Recomendação Estratégica) quando o utilizador só pediu consulta
  if (intentInfo && !intentInfo.decisionAllowed) {
    const badHeadings = findUnsolicitedPurchaseHeadings(finalText);
    if (badHeadings.length > 0) {
      problems.push(
        `[V1] A pergunta foi apenas de consulta (não pediu encomendas nem decisões de compra), mas incluíste secções não pedidas: ${badHeadings.join(
          ' | '
        )}. Remove todas as secções de encomendas, proibições, alertas de tesouraria e recomendações estratégicas; responde apenas ao que foi perguntado.`
      );
    }
  }

  // V15: Proibição legal de sugerir campanhas, packs, descontos ou promoções para MSRM (P2.10)
  if (/\bMSRM\b/i.test(finalText) && /\b(campanha(s)?|pack(s)?|promo[çc][ãa]o|desconto(s)?|pague\s+\d+\s+leve\s+\d+)\b/i.test(finalText)) {
    problems.push(
      '[V15] Proibição legal estrita: Medicamentos Sujeitos a Receita Médica (MSRM) NÃO podem ser objeto de campanhas, descontos, packs ou promoções. As únicas ações permitidas são: devolver ao fornecedor, transferir entre farmácias, trabalhar sob encomenda ou repor stock.'
    );
  }

  // V16: Proteção de continuidade clínica para terapêutica crónica (P2.10)
  const lines = finalText.split('\n');
  for (const line of lines) {
    if (/\b(n[aã]o\s+manter|descontinuar|retirar\s+da\s+farm[áa]cia|eliminar\s+do\s+stock)\b/i.test(line)) {
      if (isTherapeuticChronic(null, line)) {
        problems.push(
          `[V16] Violação de continuidade clínica na linha "${line.trim().slice(0, 80)}...": Medicamentos de terapêutica crónica (anticoagulantes, antidiabéticos, antiepiléticos, antidepressivos, cardiovasculares) NUNCA podem ter recomendação de "não manter" ou descontinuar. No máximo, trabalhar sob encomenda ou stock mínimo de 1 unidade.`
        );
      }
    }
  }

  // V17: Verificação de números citados (P2.6)
  if (toolResultsJson.length > 0) {
    const allToolJson = toolResultsJson.join(' ');
    const moneyMatches = finalText.match(/\b\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s*€/g) || [];
    for (const m of moneyMatches) {
      const rawVal = m.replace('€', '').trim().replace(/\./g, '').replace(',', '.');
      const num = parseFloat(rawVal);
      if (!isNaN(num) && num > 5) {
        const numFixed2 = num.toFixed(2);
        const numFixed1 = num.toFixed(1);
        const numStr = String(num);
        const numInt = Math.round(num).toString();
        if (
          !allToolJson.includes(numFixed2) &&
          !allToolJson.includes(numFixed1) &&
          !allToolJson.includes(numStr) &&
          !allToolJson.includes(numInt) &&
          !allToolJson.includes(rawVal)
        ) {
          problems.push(
            `[V17] O valor ${m} citado no texto não foi encontrado nos resultados pré-calculados das ferramentas. O modelo não deve calcular nem inventar valores.`
          );
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

// ============================================================================
// FASE 1 — VALIDAÇÃO 1 (DADOS: D1–D5) E VALIDAÇÃO 2 (TEXTO FRASE A FRASE: T1–T7)
// ============================================================================

export interface DataValidationResult {
  ok: boolean;
  blockingErrors: string[];
  warnings: string[];
  failedRules: string[];
}

export function validateRelatorioData(relatorio: any, verFaturacao: boolean): DataValidationResult {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];
  const failedRules: string[] = [];

  if (!relatorio || !relatorio.totais) {
    return {
      ok: false,
      blockingErrors: ['[D1] Relatório sem bloco de totais.'],
      warnings: [],
      failedRules: ['D1'],
    };
  }

  // D1: Soma das classes = total de produtos do âmbito; soma dos € = total de vendas (tol 0,02 €)
  const classes = Array.isArray(relatorio.classes_resumo) ? relatorio.classes_resumo : [];
  const sumProds = classes.reduce((acc: number, c: any) => acc + Number(c.n_produtos || 0), 0);
  const expectedProds = Number(relatorio.totais.produtos_ambito_total ?? 0);
  if (classes.length === 0 || sumProds !== expectedProds) {
    blockingErrors.push(`[D1] Soma das classes (${sumProds}) difere do total de produtos do âmbito (${expectedProds}).`);
    failedRules.push('D1');
  }

  if (verFaturacao && relatorio.totais.faturacao_eur !== null) {
    const sumEur = classes.reduce((acc: number, c: any) => acc + Number(c.vendas_eur || 0), 0);
    const expectedEur = Number(relatorio.totais.faturacao_eur || 0);
    if (Math.abs(sumEur - expectedEur) > 0.05) {
      blockingErrors.push(
        `[D1] Soma dos € por classe (${sumEur.toFixed(2)} €) difere do total faturado (${expectedEur.toFixed(2)} €).`
      );
      if (!failedRules.includes('D1')) failedRules.push('D1');
    }
  }

  // D2: Imobilizado sem duplicados
  if (relatorio.imobilizado_total && Array.isArray(relatorio.imobilizado_total.produtos)) {
    const cnps = relatorio.imobilizado_total.produtos.map((p: any) => p.cnp);
    if (new Set(cnps).size !== cnps.length) {
      blockingErrors.push('[D2] Detetada contagem dupla de CNPs no bloco de imobilizado.');
      failedRules.push('D2');
    }
  }

  // D3: Rótulo de período coerente com o ano pedido
  const anoPedido = String(relatorio.meta?.ano || '');
  const rotulo = String(relatorio.meta?.periodo_rotulo || '');
  if (anoPedido && !rotulo.includes(anoPedido)) {
    blockingErrors.push(`[D3] Rótulo de período (${rotulo}) não corresponde ao ano pedido (${anoPedido}).`);
    failedRules.push('D3');
  }

  // D4: Valores anómalos marcados como REVER_DADOS (aviso não bloqueante)
  const reverCount = Number(relatorio.rever_dados?.total_contagem || 0);
  if (reverCount > 0) {
    warnings.push(`[D4] ${reverCount} produto(s) assinalado(s) como REVER_DADOS por anomalia de custo/margem/stock.`);
  }

  // D5: Permissões — sem verFaturacao não pode existir faturação em €
  if (!verFaturacao) {
    const hasEurLeak =
      relatorio.totais.faturacao_eur !== null ||
      (relatorio.resumo_modelo?.totais?.faturacao_eur !== null &&
        relatorio.resumo_modelo?.totais?.faturacao_eur !== undefined);
    if (hasEurLeak) {
      blockingErrors.push('[D5] Valores de faturação em € presentes sem permissão ver_faturacao.');
      failedRules.push('D5');
    }
  }

  return {
    ok: blockingErrors.length === 0,
    blockingErrors,
    warnings,
    failedRules,
  };
}

export interface CatalogTermEntry {
  termNorm: string;
  original: string;
  isMsrm: boolean;
  isChronic: boolean;
}

export interface SentenceValidationRemoval {
  sentence: string;
  rule: string;
  reason: string;
}

export interface LeituraValidationResult {
  ok: boolean;
  sanitizedText: string;
  removedSentences: SentenceValidationRemoval[];
  failedRules: string[];
  needsRewrite: boolean;
}

export function normalizeTextForMatch(str: string): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMMON_STOPWORDS = new Set([
  'teva', 'ratiopharm', 'bial', 'generis', 'sandoz', 'cinfa', 'krka', 'viatris', 'mylan', 'bluepharma',
  'farmacia', 'stock', 'vendas', 'venda', 'euros', 'unidades', 'meses', 'mes', 'ano', 'anos', 'dias',
  'produto', 'produtos', 'medicamento', 'medicamentos', 'comp', 'caps', 'blister', 'frasco', 'spray',
  'nasal', 'creme', 'gel', 'solucao', 'oral', 'susp', 'pulv', 'revest', 'pelic', 'dose', 'doses',
  'para', 'como', 'mais', 'menos', 'muito', 'pouco', 'com', 'sem', 'pelo', 'pela', 'este', 'esta',
  'estes', 'estas', 'isso', 'total', 'media', 'margem', 'custo', 'preco', 'valor', 'valores', 'dados',
  'rutura', 'mono', 'monos', 'excesso', 'validade', 'validades', 'acao', 'acoes', 'manter', 'repor',
  'devolver', 'encomenda', 'transferir', 'campanha', 'promocao', 'desconto', 'balcao', 'fornecedor',
  'cronico', 'cronicos', 'doente', 'doentes', 'receita', 'msrm', 'mnsrm', 'livre', 'relatorio',
  'periodo', 'outubro', 'setembro', 'janeiro', 'dezembro', 'referencia', 'referencias', 'lista',
  'top', 'baixo', 'baixa', 'baixas', 'alto', 'alta', 'altas', 'ativo', 'ativos', 'atual', 'atuais',
  'imobilizado', 'cobertura', 'rotacao', 'faturacao', 'laboratorio', 'laboratorios', 'catalogo',
  'clinico', 'clinica', 'gestao', 'direcao', 'tecnica', 'prioritario', 'prioritaria', 'imediato',
  'imediata', 'seguranca', 'reposicao', 'devolucao', 'auditoria', 'sifarma', 'revisao', 'revisoes',
  'capital', 'saude', 'doenca', 'receitas', 'controlo', 'controle', 'margens', 'custos', 'precos',
  'calcio', // tratado especificamente via composto ou catálogo
]);

/**
 * Extrai todos os valores numéricos reais de um objeto de dados (excluindo strings de CNP/IDs)
 * para validação numérica T1 rigorosa (nunca substring sobre JSON!).
 */
export function collectAllowedNumbers(obj: any, out = new Set<number>()): Set<number> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number' && Number.isFinite(obj)) {
    out.add(Math.round(obj * 100) / 100);
    out.add(Math.round(obj * 10) / 10);
    out.add(Math.round(obj));
    return out;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectAllowedNumbers(item, out);
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'cnp' || k === 'cnp_codigo' || k === 'farmaciaId' || k === 'id' || k === 'relatorio_markdown') continue;
      collectAllowedNumbers(v, out);
    }
  }
  return out;
}

function parsePtNumber(raw: string): number {
  const cleaned = raw.replace(/\s/g, '').replace(/\.(?=\d{3}(?:[,\s]|$))/g, '').replace(',', '.');
  return parseFloat(cleaned);
}

function isNumberAllowed(val: number, allowed: Set<number>): boolean {
  if (!Number.isFinite(val)) return true;
  if (allowed.has(val) || allowed.has(Math.round(val * 100) / 100) || allowed.has(Math.round(val * 10) / 10)) {
    return true;
  }
  for (const a of allowed) {
    const tol = Math.max(0.06, Math.abs(a) * 0.002); // tolerância para arredondamento de apresentação
    if (Math.abs(val - a) <= tol) return true;
  }
  return false;
}

const MSRM_MARKETING_OR_PRICE_NORM_RX =
  /\b(escoa\w*|liquida\w*|promov\w*|promoc\w*|descont\w*|campanh\w*|pack\w*|destaqu\w*|montr\w*|ofert\w*|pague\s+\d+\s+leve\s+\d+|leve\s+\d+\s+pague\s+\d+|(aument|sub|alter|renegoci|reinterpret|ajust)\w*\s+(o\s+|a\s+|de\s+|do\s+|da\s+)?(pvp|prec\w*))\b/i;

/**
 * Garante que uma Leitura nunca é entregue cortada a meio (stop_reason = max_tokens).
 * Corta na última frase completa (. ! ?); se não houver frase completa, devolve "".
 */
export function trimTruncatedText(text: string, stopReason?: string | null): string {
  const cleaned = (text || '').trim();
  if (!cleaned) return '';
  const endsWithPunct = /[.!?]["»”)]?$/.test(cleaned);
  if (stopReason !== 'max_tokens' && endsWithPunct) {
    return cleaned;
  }
  // Encontra o último fim de frase real (. ! ? seguido de espaço ou fim de string, ignorando pontos decimais/milhares como 22.443)
  let lastEnd = -1;
  const rx = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(cleaned)) !== null) {
    lastEnd = m.index;
  }
  if (lastEnd === -1) return '';
  return cleaned.slice(0, lastEnd + 1).trim();
}

/**
 * Impõe o formato de Leitura em prosa corrida (máx. 4 frases, sem títulos #, sem listas, sem secções).
 * Tudo o que vier a partir do primeiro título (após o parágrafo inicial), separador (---) ou lista é descartado.
 */
export function enforcePlainProseLeitura(rawText: string, stopReason?: string | null): string {
  const lines = (rawText || '').replace(/\r\n/g, '\n').split('\n');
  const proseLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Ignorar título isolado apenas se ainda não recolhemos nenhuma frase de prosa
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (proseLines.length === 0) continue;
      break; // Qualquer título depois da prosa inicia uma secção -> descartar tudo daqui para a frente
    }

    // Separador ou item de lista -> descartar tudo daqui para a frente
    if (/^(---+|\*\*\*+|[-*•]\s+|\d+[.)]\s+|\[As tabelas)/i.test(trimmed)) {
      if (proseLines.length === 0) continue;
      break;
    }

    proseLines.push(trimmed);
  }

  let joined = proseLines.join(' ').replace(/\s+/g, ' ').trim();
  joined = trimTruncatedText(joined, stopReason);
  if (!joined) return '';

  // Limitar estritamente a no máximo 4 frases corridas
  const sentences = joined.split(/(?<=[.!?])\s+(?=[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ0-9*])/).filter(Boolean);
  return sentences.slice(0, 4).join(' ').trim();
}

const CHRONIC_FORBIDDEN_RX =
  /\b(devolver\s+(todo|tudo|a\s+totalidade|todas?\s+as?\s+\d*\s*un)|descontinuar|descartar|eliminar|abater|destruir|n[ãa]o\s+manter|deixar\s+de\s+vender|n[ãa]o\s+repor|eliminar\s+do\s+stock|retirar\s+da\s+farm[áa]cia)\b/i;

const FORBIDDEN_ACTION_VERBS_RX =
  /\b(eliminar|descartar|destruir|abater|liquidar)\b/i;

const UNFOUNDED_ESTIMATE_RX =
  /\b(recuperar\s+\d[\d.,\s–-]*€\s+em\s+\d+\s*dias|redu[çc][ãa]o\s+de\s+\d+\s*[–-]\s*\d+\s*%|poupan[çc]a\s+estimada\s+de\s+\d|aumentar\s+vendas\s+em\s+\d+\s*%)\b/i;

export function validateAndSanitizeLeitura(
  rawText: string,
  options: {
    relatorio?: any;
    turnToolResultsJson: string[];
    catalogTerms?: CatalogTermEntry[];
  }
): LeituraValidationResult {
  const removedSentences: SentenceValidationRemoval[] = [];
  const failedRulesSet = new Set<string>();

  const turnCnps = new Set<string>();
  for (const j of options.turnToolResultsJson) {
    extractCnps(j).forEach((c) => turnCnps.add(c));
  }

  // Números permitidos extraídos rigorosamente do resumo_modelo / relatorio (nunca CNPs!)
  const allowedNumbers = new Set<number>([2024, 2025, 2026, 2027, 1, 2, 3, 4, 5, 6, 10, 12, 30, 60, 90, 180, 365, 100]);
  if (options.relatorio) {
    collectAllowedNumbers(options.relatorio.resumo_modelo || options.relatorio, allowedNumbers);
    collectAllowedNumbers(options.relatorio.totais, allowedNumbers);
    collectAllowedNumbers(options.relatorio.classes_resumo, allowedNumbers);
    collectAllowedNumbers(options.relatorio.top, allowedNumbers);
    collectAllowedNumbers(options.relatorio.validades, allowedNumbers);
    collectAllowedNumbers(options.relatorio.monos, allowedNumbers);
    collectAllowedNumbers(options.relatorio.em_rutura, allowedNumbers);
    collectAllowedNumbers(options.relatorio.sem_vendas, allowedNumbers);
    collectAllowedNumbers(options.relatorio.imobilizado_total, allowedNumbers);
  }

  // Índice de produtos presentes no relatório atual (para T2, T4, T5)
  const relProds: Array<{
    cnp: string;
    normName: string;
    normDci: string;
    firstWord: string;
    isMsrm: boolean;
    isChronic: boolean;
    classificacao: string;
  }> = [];

  const rawProdList =
    options.relatorio?.todos_produtos_indice ||
    [
      ...(options.relatorio?.top || []),
      ...(options.relatorio?.monos?.produtos || []),
      ...(options.relatorio?.validades?.produtos || []),
      ...(options.relatorio?.em_rutura?.produtos || []),
      ...(options.relatorio?.sem_vendas?.produtos || []),
      ...(options.relatorio?.vendas_baixas?.produtos || []),
    ];

  for (const p of rawProdList) {
    const normName = normalizeTextForMatch(p.designacao || p.nome || '');
    const normDci = normalizeTextForMatch(p.dci || '');
    const firstWord = normName.split(' ')[0] || '';
    const tipo = String(p.tipo_venda || p.tipo || '').toUpperCase();
    relProds.push({
      cnp: String(p.cnp || ''),
      normName,
      normDci,
      firstWord,
      isMsrm: tipo.includes('MSRM') || tipo.includes('RECEITA'),
      isChronic: Boolean(p.eh_terapeutica_cronica ?? isTherapeuticChronic(p.dci, p.designacao || p.nome)),
      classificacao: String(p.classificacao || p.acao || ''),
    });
  }

  // Divide em linhas e frases preservando parágrafos/bullets
  const lines = (rawText || '').split('\n');
  const keptLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      keptLines.push(line);
      continue;
    }

    // Divide a linha em frases (mantendo bullets como unidade ou dividindo por ". ")
    const sentences = trimmed.split(/(?<=[.!?])\s+(?=[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ0-9\-•*])/).filter(Boolean);
    const keptSentences: string[] = [];

    for (const sentence of sentences) {
      const sNorm = normalizeTextForMatch(sentence);
      let violation: { rule: string; reason: string } | null = null;

      // V4: CNPs apenas deste turno
      const citedCnps = extractCnps(sentence);
      for (const cnp of citedCnps) {
        if (!turnCnps.has(cnp)) {
          violation = { rule: 'V4', reason: `CNP ${cnp} não consta nos resultados deste turno.` };
          break;
        }
      }

      // T7: Estimativas sem base
      if (!violation && UNFOUNDED_ESTIMATE_RX.test(sentence)) {
        violation = { rule: 'T7', reason: 'Estimativa ou projeção numérica sem base nos dados.' };
      }

      // T1: Números em € e % verificados numericamente (incluindo T1 para grupos Top N / N produtos!)
      if (!violation && options.relatorio) {
        const moneyMatches = sentence.match(/\b\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s*€/g) || [];
        for (const m of moneyMatches) {
          const val = parsePtNumber(m.replace('€', ''));
          if (!isNumberAllowed(val, allowedNumbers)) {
            violation = { rule: 'T1', reason: `Valor monetário ${m.trim()} não existe nos dados do relatório.` };
            break;
          }
        }

        // T1 para grupos: "5 produtos ... 45,1%" ou "Top 5 ... 45,1%" tem de bater com top5_pct_faturacao
        if (!violation) {
          const pctMatches = sentence.match(/\b\d{1,3}(?:[,.]\d{1,2})?\s*%/g) || [];
          const groupNMatch = sentence.match(/\b(?:top\s*(\d+)|(\d+)\s+produtos?)\b/i);
          const groupN = groupNMatch ? parseInt(groupNMatch[1] || groupNMatch[2], 10) : null;

          for (const pm of pctMatches) {
            const pctVal = parsePtNumber(pm.replace('%', ''));
            if (groupN === 5 && options.relatorio?.totais?.top5_pct_faturacao != null) {
              const expectedTop5 = Number(options.relatorio.totais.top5_pct_faturacao);
              if (Math.abs(pctVal - expectedTop5) > 0.5) {
                violation = {
                  rule: 'T1',
                  reason: `Percentagem ${pm.trim()} atribuída a 5 produtos não corresponde ao Top 5 real (${expectedTop5}%).`,
                };
                break;
              }
            } else if (groupN === 10 && options.relatorio?.totais?.top10_pct_faturacao != null) {
              const expectedTop10 = Number(options.relatorio.totais.top10_pct_faturacao);
              if (Math.abs(pctVal - expectedTop10) > 0.5) {
                violation = {
                  rule: 'T1',
                  reason: `Percentagem ${pm.trim()} atribuída a 10 produtos não corresponde ao Top 10 real (${expectedTop10}%).`,
                };
                break;
              }
            } else if (!isNumberAllowed(pctVal, allowedNumbers)) {
              violation = {
                rule: 'T1',
                reason: `Percentagem ${pm.trim()} não corresponde a nenhum indicador do relatório.`,
              };
              break;
            }
          }
        }

        // T1 para grupos com dicionário de rótulos (bloco vs classe — impede "24 em rutura", "7 com excesso de cobertura", "5 sem qualquer venda")
        if (!violation) {
          const classesArr = Array.isArray(options.relatorio.classes_resumo) ? options.relatorio.classes_resumo : [];
          const clsCount = (cls: string) =>
            Number(classesArr.find((c: any) => c.classe === cls)?.n_produtos ?? -1);

          const labelRules: Array<{ rx: RegExp; expected: number[]; label: string }> = [
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:em\s+|com\s+)?ruturas?\b/i,
              expected: options.relatorio.em_rutura?.total_contagem != null ? [Number(options.relatorio.em_rutura.total_contagem)] : [],
              label: 'rutura',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?sem\s+(?:qualquer\s+)?vendas?\b/i,
              expected: options.relatorio.sem_vendas?.total_contagem != null ? [Number(options.relatorio.sem_vendas.total_contagem)] : [],
              label: 'sem vendas',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:em\s+|com\s+)?(?:excessos?\s+de\s+cobertura|excessos?|cobertura\s+excessiva)\b/i,
              expected: options.relatorio.excessos?.total_contagem != null ? [Number(options.relatorio.excessos.total_contagem)] : [],
              label: 'excesso de cobertura',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:monos?|parados?)\b/i,
              expected: options.relatorio.monos?.total_contagem != null ? [Number(options.relatorio.monos.total_contagem)] : [],
              label: 'monos',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:perto\s+de\s+|com\s+|em\s+risco\s+de\s+)?(?:validades?|caducidades?)\b/i,
              expected: options.relatorio.validades?.total_contagem != null ? [Number(options.relatorio.validades.total_contagem)] : [],
              label: 'validade/caducidade',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:a\s+|para\s+|em\s+)?manter\b/i,
              expected: clsCount('MANTER') >= 0 ? [clsCount('MANTER')] : [],
              label: 'MANTER',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:a\s+|para\s+|em\s+)?repor\b/i,
              expected: clsCount('REPOR') >= 0 ? [clsCount('REPOR')] : [],
              label: 'REPOR',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:para\s+trabalhar\s+(?:por|sob)\s+|sob\s+|por\s+)encomenda\b/i,
              expected: clsCount('TRABALHAR_ENCOMENDA') >= 0 ? [clsCount('TRABALHAR_ENCOMENDA')] : [],
              label: 'TRABALHAR_ENCOMENDA',
            },
            {
              rx: /\b(\d+)\s+(?:produtos?\s+|refer[êe]ncias?\s+)?(?:que\s+requerem\s+|em\s+|com\s+)?stock\s+m[ií]nimo\b/i,
              expected: clsCount('STOCK_MINIMO') >= 0 ? [clsCount('STOCK_MINIMO')] : [],
              label: 'STOCK_MINIMO',
            },
          ];

          for (const rule of labelRules) {
            if (rule.expected.length === 0) continue;
            const m = sentence.match(rule.rx);
            if (m && m[1]) {
              const citedN = parseInt(m[1], 10);
              if (!rule.expected.includes(citedN)) {
                violation = {
                  rule: 'T1',
                  reason: `Contagem incorreta para "${rule.label}": citado ${citedN}, esperado ${rule.expected.join(' ou ')}.`,
                };
                break;
              }
            }
          }
        }
      }

      // T3: Verbos proibidos (eliminar, descartar, destruir, abater, liquidar) -> frase removida sempre
      if (!violation && FORBIDDEN_ACTION_VERBS_RX.test(sentence)) {
        const isExplicitProhibition = /\b(proibid[oa]|n[ãa]o\s+se\s+deve|nunca\s+se\s+deve)\b/i.test(sentence);
        if (!isExplicitProhibition) {
          violation = {
            rule: 'T3',
            reason: 'Verbo de ação não permitido (eliminar/descartar/destruir/abater/liquidar).',
          };
        }
      }

      // T3 para grupos: ação aplicada a um bloco heterogéneo (ex.: "Repor ruturas (39)" quando só 24 têm REPOR)
      if (!violation && options.relatorio) {
        const classesArr = Array.isArray(options.relatorio.classes_resumo) ? options.relatorio.classes_resumo : [];
        const getClassCount = (cls: string) =>
          Number(classesArr.find((c: any) => c.classe === cls)?.n_produtos ?? 0);

        if (/\brepor\b/i.test(sentence) && /\bruturas?\b/i.test(sentence)) {
          const totalRuturas = Number(options.relatorio.em_rutura?.total_contagem ?? 0);
          const reporCount = getClassCount('REPOR');
          if (totalRuturas > 0 && reporCount < totalRuturas) {
            const citesTotalRuturas = new RegExp(`\\b${totalRuturas}\\b`).test(sentence);
            const citesReporCount = reporCount > 0 && new RegExp(`\\b${reporCount}\\b`).test(sentence);
            if (citesTotalRuturas || !citesReporCount) {
              violation = {
                rule: 'T3',
                reason: `Contradição de grupo: apenas ${reporCount} das ${totalRuturas} ruturas têm ação REPOR (as restantes são TRABALHAR_ENCOMENDA).`,
              };
            }
          }
        }

        if (!violation && /\bdevolver\b/i.test(sentence) && /\bmonos?\b/i.test(sentence)) {
          const totalMonos = Number(options.relatorio.monos?.total_contagem ?? 0);
          const devolverTotal = getClassCount('DEVOLVER_TUDO') + getClassCount('DEVOLVER_EXCESSO');
          if (totalMonos > 0 && devolverTotal < totalMonos) {
            const citesTotalMonos = new RegExp(`\\b${totalMonos}\\b`).test(sentence);
            if (citesTotalMonos) {
              violation = {
                rule: 'T3',
                reason: `Contradição de grupo: nem todos os ${totalMonos} monos têm ação de devolução.`,
              };
            }
          }
        }
      }

      // T2: Produtos/DCIs do catálogo ProdutoMestre que NÃO estão no relatório
      if (!violation && options.relatorio && options.catalogTerms && options.catalogTerms.length > 0) {
        for (const entry of options.catalogTerms) {
          if (entry.termNorm.length < 5 || COMMON_STOPWORDS.has(entry.termNorm)) continue;
          const rx = new RegExp(`\\b${entry.termNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          if (rx.test(sNorm)) {
            // Verifica se este termo existe em algum produto do relatório
            const inReport = relProds.some(
              (rp) =>
                rp.normName.includes(entry.termNorm) ||
                rp.normDci.includes(entry.termNorm) ||
                (rp.firstWord.length >= 5 && entry.termNorm.includes(rp.firstWord))
            );
            if (!inReport) {
              violation = {
                rule: 'T2',
                reason: `Produto/substância "${entry.original}" citado na frase não consta no relatório deste laboratório.`,
              };
              break;
            }
          }
        }
      }

      // T4: MSRM sem marketing nem escoamento nem alteração/reinterpretação de preço (comparação sem acentos por raiz)
      if (!violation && MSRM_MARKETING_OR_PRICE_NORM_RX.test(sNorm)) {
        const isExplicitProhibition = /\b(proibid[oa]|nao\s+podem?|nunca\s+podem?|vedad[oa])\b/i.test(sNorm);
        if (!isExplicitProhibition) {
          const citesLiteralMsrm = /\bmsrm\b/i.test(sNorm);
          const citesMsrmProduct =
            relProds.some(
              (rp) =>
                rp.isMsrm &&
                ((rp.cnp && sentence.includes(rp.cnp)) ||
                  (rp.firstWord.length >= 5 && !COMMON_STOPWORDS.has(rp.firstWord) && sNorm.includes(rp.firstWord)))
            ) ||
            (options.catalogTerms || []).some(
              (ct) =>
                ct.isMsrm &&
                ct.termNorm.length >= 5 &&
                !COMMON_STOPWORDS.has(ct.termNorm) &&
                sNorm.includes(ct.termNorm)
            );

          if (citesLiteralMsrm || citesMsrmProduct) {
            violation = {
              rule: 'T4',
              reason: 'Proibição legal: frase associa medicamento MSRM a escoamento, liquidação, campanha, promoção, desconto, pack, destaque ou alteração/reinterpretação de preço.',
            };
          }
        }
      }

      // T5: Terapêutica crónica nunca pode receber devolver tudo / descontinuar / não manter / não repor
      if (!violation && CHRONIC_FORBIDDEN_RX.test(sentence)) {
        const citesChronic =
          isTherapeuticChronic(null, sentence) ||
          relProds.some(
            (rp) =>
              rp.isChronic &&
              ((rp.cnp && sentence.includes(rp.cnp)) ||
                (rp.firstWord.length >= 5 && !COMMON_STOPWORDS.has(rp.firstWord) && sNorm.includes(rp.firstWord)))
          );
        if (citesChronic) {
          violation = {
            rule: 'T5',
            reason: 'Violação clínica: terapêutica crónica não pode receber recomendação de devolver tudo, descontinuar ou não manter.',
          };
        }
      }

      if (violation) {
        failedRulesSet.add(violation.rule);
        removedSentences.push({
          sentence,
          rule: violation.rule,
          reason: violation.reason,
        });
      } else {
        keptSentences.push(sentence);
      }
    }

    if (keptSentences.length > 0) {
      keptLines.push(keptSentences.join(' '));
    }
  }

  const sanitizedText = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const remainingSentenceCount = sanitizedText
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15).length;

  const failedRules = Array.from(failedRulesSet);
  const needsRewrite = removedSentences.length > 0 && remainingSentenceCount < 2;

  return {
    ok: removedSentences.length === 0,
    sanitizedText,
    removedSentences,
    failedRules,
    needsRewrite,
  };
}
