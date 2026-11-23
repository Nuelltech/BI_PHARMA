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

  // V12: Remover nomes técnicos internos se vazarem no texto visível
  text = text
    .replace(/\b(v_metricas|v_vendas_mes|v_grupos_dci|v_catalogo|v_snapshots|v_kpis)\b/g, 'base de dados')
    .replace(/\b(r_\d{4})\b/g, '');

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
        const numInt = Math.round(num).toString();
        if (!allToolJson.includes(numFixed2) && !allToolJson.includes(numInt) && !allToolJson.includes(rawVal)) {
          problems.push(
            `[V17] O valor ${m} citado no texto não foi encontrado nos resultados pré-calculados das ferramentas. O modelo não deve calcular nem inventar valores.`
          );
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
