import {
  validateCopilotAnswer,
  extractCnps,
  classifyQuestionIntent,
  QuestionIntentInfo,
  postProcessCopilotText,
  stripUnsolicitedPurchaseSections,
} from './copilot_validation';
import {
  validateCopilotInputGuardrails,
  sanitizeCopilotOutput,
  COPILOT_SECURITY_GUARDRAILS_PROMPT,
} from './copilot_guardrails';
import {
  saveToolResult,
  toolRefinarResultado,
  getSessionLedgerText,
  getLatestTurnShoppingList,
  clearSessionResults,
  getStoredResultsForSession,
} from './copilot_result_store';
import {
  toolDescreverDados,
  toolConsultarSql,
  toolFichaProduto,
  toolConsultarVendas,
  toolConsultarProdutos,
  toolConsultarGruposDci,
  toolConsultarPatrimonioStock,
  toolConsultarTarefasECampanhas,
  toolConsultarDesempenhoCampanhas,
  toolPlanearComprasLaboratorio,
} from './copilot_semantic_layer';
import {
  sugerirVendasCruzadas,
  sugerirPacksPromocionais,
  parseDia,
  ymd,
} from './comercial';
import {
  createPrismaComercialRepo,
  buildComercialCfg,
} from './comercial_repo';

import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();

import {
  ToolSecurityContext,
  toolCriarTarefaEquipa,
  toolAtivarCampanhaFarmacia,
  toolGerarPropostaEncomendaReposicao,
} from './mcp_pharma_tools.js';

// ============================================================================
// MOTOR CONVERSACIONAL COPILOT C/ ARQUITETURA EM 3 CLASSES (DADOS, DECISÃO, AÇÃO)
// ----------------------------------------------------------------------------
// - Ferramentas neutras tabulares ({ ok, result_id, meta, colunas, linhas, totais })
// - ToolResultStore c/ refinar_resultado e canal lateral para shoppingList
// - Gating por intenção + Validador determinístico V1-V14
// ============================================================================

const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: any }>>();
const sessionTimestamps = new Map<string, number>();
const sessionKnownCnps = new Map<string, Set<string>>();
const sessionTurnCounter = new Map<string, number>();

function pruneOldSessions() {
  const now = Date.now();
  const maxAge = 3 * 60 * 60 * 1000;
  for (const [id, ts] of sessionTimestamps.entries()) {
    if (now - ts > maxAge) {
      sessionHistory.delete(id);
      sessionTimestamps.delete(id);
      sessionKnownCnps.delete(id);
      sessionTurnCounter.delete(id);
    }
  }
}

export function clearCopilotSession(sessionId: string) {
  sessionHistory.delete(sessionId);
  sessionTimestamps.delete(sessionId);
  sessionKnownCnps.delete(sessionId);
  sessionTurnCounter.delete(sessionId);
}

export function getCopilotSessionHistory(sessionId: string): Array<{ role: 'user' | 'assistant'; content: any }> {
  return sessionHistory.get(sessionId) || [];
}

// ============================================================================
// CONJUNTO CONSOLIDADO DE 15 FERRAMENTAS (DADOS, DECISÃO, AÇÃO)
// ============================================================================
const COPILOT_TOOLS = [
  // --- CLASSE 1: DADOS (NEUTRAS — CONSULTA) ---
  {
    name: 'consultar_vendas',
    description:
      'Consulta vendas (unidades, valor EUR, VMM, últimos 3 meses, margem estimada e comparação entre períodos) por produto, laboratório, DCI ou mês. Usar para qualquer pergunta sobre vendas, faturação, evolução mensal ou tendências. NÃO devolve planos de encomenda.',
    input_schema: {
      type: 'object',
      properties: {
        filtros: {
          type: 'object',
          properties: {
            laboratorio: { type: 'string', description: 'Nome do laboratório (ex: "Bial", "Generis", "Teva").' },
            dci: { type: 'string', description: 'Princípio ativo / molécula DCI.' },
            cnp: { type: 'array', items: { type: 'string' }, description: 'Lista de códigos CNP de 7 dígitos.' },
            texto: { type: 'string', description: 'Pesquisa por nome comercial ou termo.' },
            categoria: { type: 'string', description: 'Categoria ou família.' },
            tipo_venda: { type: 'string', enum: ['MSRM', 'MNSRM', 'VENDA_LIVRE'] },
            eh_generico: { type: 'boolean' },
            flags: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['eh_mono', 'eh_excesso_cobertura', 'eh_risco_caducidade', 'eh_risco_rutura', 'eh_resto_gaveta'],
              },
            },
            stock_min: { type: 'number' },
            stock_max: { type: 'number' },
          },
        },
        periodo: {
          type: 'object',
          properties: {
            de: { type: 'string', description: 'YYYY-MM inicial (ex: "2025-11").' },
            ate: { type: 'string', description: 'YYYY-MM final (ex: "2026-10").' },
          },
        },
        granularidade: { type: 'string', enum: ['total', 'mes', 'dia'], description: 'Padrão: "total". Use "mes" para série mensal global da farmácia, "dia" para vendas diárias.' },
        agrupar_por: { type: 'string', enum: ['nenhum', 'produto', 'laboratorio', 'dci', 'categoria', 'segmento'] },
        comparar_com: {
          type: 'object',
          properties: {
            de: { type: 'string' },
            ate: { type: 'string' },
          },
          description: 'Período B opcional (YYYY-MM) para calcular deltas de subida/descida.',
        },
        ordenar: {
          type: 'object',
          properties: {
            campo: { type: 'string', description: 'Ex: "vendas_12m_un", "vendas_12m_eur", "unidades_delta".' },
            dir: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
        limite: { type: 'number', description: 'Padrão: 50.' },
      },
    },
  },
  {
    name: 'consultar_produtos',
    description:
      'Consulta stock atual, cobertura, validades, preços, margens e flags (eh_mono, eh_resto_gaveta, eh_excesso_cobertura, eh_risco_caducidade, anomalia_custo_gt_pvp). Usar para inventário, monos parados, excessos ou caducidades. NÃO usar para decisões de compra.',
    input_schema: {
      type: 'object',
      properties: {
        filtros: {
          type: 'object',
          properties: {
            laboratorio: { type: 'string' },
            dci: { type: 'string' },
            cnp: { type: 'array', items: { type: 'string' } },
            texto: { type: 'string' },
            categoria: { type: 'string' },
            tipo_venda: { type: 'string', enum: ['MSRM', 'MNSRM', 'VENDA_LIVRE'] },
            eh_generico: { type: 'boolean' },
            flags: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'eh_mono',
                  'eh_excesso_cobertura',
                  'eh_risco_caducidade',
                  'eh_risco_rutura',
                  'eh_resto_gaveta',
                  'anomalia_custo_gt_pvp',
                  'margem_negativa',
                ],
              },
            },
            stock_min: { type: 'number' },
            stock_max: { type: 'number' },
            validade_ate: { type: 'string', description: 'Data limite YYYY-MM-DD.' },
            meses_ate_validade_max: { type: 'number' },
          },
        },
        colunas: { type: 'array', items: { type: 'string' } },
        ordenar: {
          type: 'object',
          properties: {
            campo: { type: 'string', description: 'Ex: "stock_total_valor_custo", "cobertura_meses", "valor_em_risco_caducidade".' },
            dir: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
        limite: { type: 'number' },
      },
    },
  },
  {
    name: 'consultar_grupos_dci',
    description:
      'Consulta grupos de equivalência DCI (genéricos/similares da mesma molécula, dosagem e embalagem), achatando por marca com stock, custo, PVP, margem e quota de VMM na farmácia. Usar para comparar marcas similares ou consolidação de genéricos.',
    input_schema: {
      type: 'object',
      properties: {
        dci_ou_grupo: { type: 'string', description: 'Molécula DCI ou grupo (ex: "Atorvastatina", "Diazepam").' },
        cnp: { type: 'string', description: 'CNP de 7 dígitos para encontrar o seu grupo DCI.' },
        laboratorio: { type: 'string', description: 'Filtrar grupos onde este laboratório está presente (ex: "Bial").' },
        modo_detalhe: { type: 'boolean', description: 'True para devolver uma linha por marca concorrente.' },
        limite: { type: 'number' },
      },
    },
  },
  {
    name: 'consultar_patrimonio_stock',
    description:
      'Consulta a evolução patrimonial de fechos de stock (vista="evolucao"), liquidez recuperada de monos vendidos num mês (vista="liquidez_recuperada"), capital imobilizado em monos (vista="capital_imobilizado") ou validades (vista="validades").',
    input_schema: {
      type: 'object',
      properties: {
        vista: {
          type: 'string',
          enum: ['evolucao', 'capital_imobilizado', 'liquidez_recuperada', 'validades'],
          description: 'Vista patrimonial pretendida.',
        },
        mes_venda: {
          type: 'string',
          description: 'Para vista="liquidez_recuperada": mês da venda YYYY-MM (ex: "2026-10").',
        },
        meses_parado_minimo: {
          type: 'number',
          description: 'Padrão canónico: 3 meses (90 dias).',
        },
        limite: { type: 'number' },
      },
      required: ['vista'],
    },
  },
  {
    name: 'ficha_produto',
    description:
      'Devolve todos os factos catalogados de um CNP ou termo (laboratório titular, DCI, tipo_venda, stock, custo, PVP, margem, histórico mensal e similares da mesma DCI).',
    input_schema: {
      type: 'object',
      properties: {
        cnp: { type: 'string' },
        termo: { type: 'string' },
      },
    },
  },
  {
    name: 'refinar_resultado',
    description:
      'Filtra, reordena ou seleciona colunas de um resultado anterior da sessão (result_id) em memória, sem repetir consulta à BD. Usar em follow-ups ("dessa lista, mostra só os que têm stock > 2").',
    input_schema: {
      type: 'object',
      properties: {
        result_id: { type: 'string', description: 'ID do resultado anterior (ex: "r_0001").' },
        filtro: {
          type: 'array',
          items: { type: 'array', items: {} },
          description: 'Lista de triplos [coluna, operador, valor], ex: [["stock_total_unidades", ">", 2]].',
        },
        colunas: { type: 'array', items: { type: 'string' } },
        ordenar: {
          type: 'object',
          properties: {
            campo: { type: 'string' },
            dir: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
        limite: { type: 'number' },
      },
    },
  },
  {
    name: 'consultar_sql',
    description:
      'Executa SELECT read-only em PostgreSQL sobre as vistas isoladas (v_metricas, v_vendas_mes, v_grupos_dci, v_catalogo, v_snapshots, v_kpis). Usar como fallback para agregações ou cruzamentos não cobertos por consultar_vendas/consultar_produtos.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        limite: { type: 'number' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'descrever_dados',
    description:
      'Devolve o catálogo de vistas SQL (v_metricas, v_vendas_mes, v_grupos_dci, v_catalogo, v_snapshots, v_kpis), colunas e definições canónicas.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_tarefas_e_campanhas',
    description:
      'Consulta o estado das tarefas semanais da equipa e campanhas promocionais ativas na farmácia.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['ambos', 'tarefas', 'campanhas'] },
        week_key: { type: 'string' },
      },
    },
  },
  {
    name: 'consultar_desempenho_campanhas',
    description:
      'Audita as vendas e o desempenho de uma campanha promocional (ativa ou concluída) durante o período em que decorreu. Devolve a faturação e unidades específicas dos artigos da campanha, a faturação global da farmácia no mesmo período, a quota da campanha (%), a taxa de escoamento de stock por artigo e a recuperação de capital de monos/validades curtas. Se ainda não existirem talões no período nominal, devolve a baseline de vendas recente pré-campanha.',
    input_schema: {
      type: 'object',
      properties: {
        campanha_id: {
          type: 'string',
          description: 'ID ou título da campanha a analisar. Se omitido, analisa a campanha ativa corrente.',
        },
        incluir_concluidas: {
          type: 'boolean',
          description: 'Se true, permite pesquisar e auditar campanhas concluídas ou canceladas no histórico.',
        },
        data_inicio: {
          type: 'string',
          description: 'YYYY-MM-DD opcional para sobrepor o início da análise.',
        },
        data_fim: {
          type: 'string',
          description: 'YYYY-MM-DD opcional para sobrepor o fim da análise.',
        },
      },
    },
  },

  // --- CLASSE 2: DECISÃO (APENAS QUANDO O UTILIZADOR PEDE DECISÃO/SUGESTÃO) ---
  {
    name: 'gerar_proposta_encomenda_reposicao',
    description:
      'Gera proposta calculada de encomenda de reposição. Usar APENAS quando o utilizador pedir uma proposta de encomenda/reposição/carrinho de compras. NÃO usar para perguntas sobre vendas ou stock.',
    input_schema: {
      type: 'object',
      properties: {
        orcamento_maximo_eur: { type: 'number' },
        horizonte_dias: { type: 'number', description: 'Padrão: 7 dias.' },
        incluir_sazonais_pico: { type: 'boolean' },
      },
    },
  },
  {
    name: 'planear_compras_laboratorio',
    description:
      'Calcula quantidades de reposição (qtd_calculada) e códigos de exclusão (EXCLUIDO_MONO, EXCLUIDO_EXCESSO) para um laboratório ou acordo anual. Usar APENAS se o utilizador pedir decisões de compra/encomenda de um laboratório. NÃO usar para perguntas sobre vendas.',
    input_schema: {
      type: 'object',
      properties: {
        laboratorio: { type: 'string' },
        modo: { type: 'string', enum: ['reposicao', 'sazonal', 'acordo'] },
        cobertura_alvo_dias: { type: 'number' },
        limite: { type: 'number' },
      },
      required: ['laboratorio'],
    },
  },
  {
    name: 'sugerir_packs_promocionais',
    description:
      'Motor determinístico de campanhas sazonais e packs promocionais (apenas Venda Livre/parafarmácia elegível, margem mínima >= 5% sobre preço sem IVA, sem MSRM nem veterinários). Use modo="TEMAS" quando o utilizador perguntar que campanhas lançar agora/este mês; use modo="PACK" com tema ou campanha_id para montar um cesto específico. Se devolver TEMA_FORA_DE_EPOCA, informe que está fora de época e pergunte se pretende liquidação explícita.',
    input_schema: {
      type: 'object',
      properties: {
        modo: { type: 'string', enum: ['TEMAS', 'PACK'], description: 'TEMAS para listar campanhas da época; PACK para construir um cesto.' },
        campanha_id: { type: 'string', description: 'ID da campanha do calendário (ex: "imunidade_inverno", "dia_diabetes", "verao_solar", "pele_seca_frio", "natal_coffrets").' },
        tema: { type: 'string', description: 'Tema pedido pelo utilizador (ex: "inverno", "solares", "diabetes", "natal").' },
        desconto_pct: { type: 'number', description: 'Desconto pretendido em % (ex: 15). Será automaticamente limitado à regra anti-dumping.' },
        publico: { type: 'string', enum: ['ADULTO', 'PEDIATRICO', 'TODOS'], description: 'Use "ADULTO" por omissão quando o utilizador pedir um pack geral sem mencionar crianças/bebés; use "PEDIATRICO" se pedir para crianças/bebés.' },
        n_produtos_max: { type: 'number', description: 'Máximo de produtos no pack (default 4).' },
        incluir_em_campanha: { type: 'boolean', description: 'Default false (evita empilhar descontos com campanhas ativas).' },
        incluir_preco_fixo: { type: 'boolean', description: 'Default false.' },
        liquidacao: { type: 'boolean', description: 'true apenas se o utilizador pedir explicitamente liquidação de stock/validades fora de época.' },
        data_referencia: { type: 'string', description: 'YYYY-MM-DD opcional para planeamento futuro.' },
      },
      required: ['modo'],
    },
  },
  {
    name: 'sugerir_vendas_cruzadas',
    description:
      'Motor determinístico de venda cruzada e aconselhamento de balcão (apenas Venda Livre/MNSRM elegível, com bloqueios de segurança por família/DCI/condição do cliente e ordem de escoamento: caducidade > mono > excesso > campanha ativa > época > margem). Use para associar produtos a medicamentos dispensados (ex: Clavamox, Metformina, Finerenona, Varfarina) ou a queixas de balcão (ex: lábios gretados, dor muscular, tosse). Se devolver GATILHO_NAO_RESOLVIDO, faça 1 pergunta curta ao utilizador com as sugestões devolvidas.',
    input_schema: {
      type: 'object',
      properties: {
        gatilho: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['cnp', 'familia', 'queixa', 'texto'] },
            valor: { type: 'string', description: 'CNP de 7 dígitos, nome do medicamento/DCI (ex: "Clavamox", "Metformina", "Finerenona"), ou queixa (ex: "lábios gretados", "dor muscular", "dor no ombro").' },
          },
          required: ['tipo', 'valor'],
        },
        publico: { type: 'string', enum: ['ADULTO', 'PEDIATRICO', 'TODOS'] },
        condicoes_cliente: {
          type: 'array',
          items: { type: 'string', enum: ['DIABETICO', 'HIPERTENSO', 'ANTICOAGULADO', 'GRAVIDA'] },
          description: 'Condições clínicas mencionadas no balcão (ex: se o cliente toma Varfarina -> incluir "ANTICOAGULADO"; se diabético -> "DIABETICO").',
        },
        limite: { type: 'number', description: 'Default 5.' },
      },
      required: ['gatilho'],
    },
  },

  // --- CLASSE 3: AÇÃO / ESCRITA (CONFIRMAÇÃO EM 2 PASSOS) ---
  {
    name: 'criar_tarefa_equipa',
    description:
      'Cria uma tarefa operacional na Folha da Semana. Usar confirmado=false primeiro para pré-visualização; só usar confirmado=true após um "sim" explícito do utilizador.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', enum: ['VALIDADE', 'BALCAO', 'TRAVAR', 'REPOR', 'CAMPANHA'] },
        designacao: { type: 'string' },
        cnp_codigo: { type: 'string' },
        valor_impacto_eur: { type: 'number' },
        confirmado: { type: 'boolean', description: 'false para pré-visualizar; true apenas após confirmação do utilizador.' },
      },
      required: ['categoria', 'designacao'],
    },
  },
  {
    name: 'ativar_campanha_farmacia',
    description:
      'Ativa uma campanha promocional (apenas VENDA_LIVRE/MNSRM, anti-dumping margem >= 5%). Usar confirmado=false primeiro para pré-visualização; só usar confirmado=true após confirmação explícita do utilizador.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        tema_ou_categoria: { type: 'string' },
        desconto_pct: { type: 'number' },
        cnps_especificos: { type: 'array', items: { type: 'string' } },
        confirmado: { type: 'boolean', description: 'false para pré-visualizar; true apenas após confirmação do utilizador.' },
      },
      required: ['titulo', 'tema_ou_categoria'],
    },
  },
];

// ============================================================================
// MODOS E GATING DE FERRAMENTAS POR INTENÇÃO
// ============================================================================
export type CopilotMode = 'STOCKS' | 'FINANCE' | 'MARKETING' | 'CLINICAL' | 'GENERAL';

const DATA_TOOL_NAMES = new Set([
  'consultar_vendas',
  'consultar_produtos',
  'consultar_grupos_dci',
  'consultar_patrimonio_stock',
  'ficha_produto',
  'refinar_resultado',
  'consultar_sql',
  'descrever_dados',
  'consultar_tarefas_e_campanhas',
  'consultar_desempenho_campanhas',
]);

const DECISION_TOOL_NAMES = new Set([
  'gerar_proposta_encomenda_reposicao',
  'planear_compras_laboratorio',
  'sugerir_packs_promocionais',
  'sugerir_vendas_cruzadas',
]);

const WRITE_TOOL_NAMES = new Set(['criar_tarefa_equipa', 'ativar_campanha_farmacia']);

export function getScopedToolsForMode(mode: CopilotMode, intentInfo?: QuestionIntentInfo): any[] {
  let list: any[];

  // Se houver intentInfo e NÃO for pedido de decisão/ação, filtra estritamente para as ferramentas de DADOS (6-9 tools)
  if (intentInfo && !intentInfo.decisionAllowed) {
    list = COPILOT_TOOLS.filter((t) => DATA_TOOL_NAMES.has(t.name));
  } else if (mode === 'STOCKS') {
    const allowed = new Set([
      ...DATA_TOOL_NAMES,
      'gerar_proposta_encomenda_reposicao',
      'planear_compras_laboratorio',
      'criar_tarefa_equipa',
    ]);
    list = COPILOT_TOOLS.filter((t) => allowed.has(t.name));
  } else if (mode === 'FINANCE') {
    const allowed = new Set([
      ...DATA_TOOL_NAMES,
      'planear_compras_laboratorio',
      'criar_tarefa_equipa',
    ]);
    list = COPILOT_TOOLS.filter((t) => allowed.has(t.name));
  } else if (mode === 'MARKETING') {
    const allowed = new Set([
      ...DATA_TOOL_NAMES,
      'sugerir_packs_promocionais',
      'ativar_campanha_farmacia',
      'criar_tarefa_equipa',
    ]);
    list = COPILOT_TOOLS.filter((t) => allowed.has(t.name));
  } else if (mode === 'CLINICAL') {
    const allowed = new Set([
      ...DATA_TOOL_NAMES,
      'sugerir_vendas_cruzadas',
      'criar_tarefa_equipa',
    ]);
    list = COPILOT_TOOLS.filter((t) => allowed.has(t.name));
  } else {
    list = COPILOT_TOOLS;
  }

  return list.map((t, idx) => {
    if (idx === list.length - 1) {
      return { ...t, cache_control: { type: 'ephemeral' } };
    }
    return t;
  });
}

// ============================================================================
// SYSTEM PROMPT COMPLETO EM XML (CONTRATO DE RESPOSTA + 7 EXEMPLOS)
// ============================================================================
const MODE_FOCUS: Record<CopilotMode, string> = {
  GENERAL: 'Análise transversal de vendas, stocks, monos, rentabilidade e operação.',
  STOCKS: 'Stocks, validades/caducidades, monos (>= 90 dias sem vendas) e coberturas.',
  FINANCE: 'Faturação, margens (€ e %), evolução mensal, laboratórios e capital imobilizado.',
  MARKETING: 'Escoamento comercial de produtos de Venda Livre/Dermocosmética, packs e campanhas.',
  CLINICAL: 'Consulta rápida de stock, monos e validades ao balcão (sem aconselhamento clínico).',
};

export function getSystemPromptForMode(
  mode: CopilotMode,
  ctxInfo?: { dataHoje?: string; dadosAte?: string; ultimoMesCompleto?: string; isMarcoZero?: boolean }
): string {
  const focoModo = MODE_FOCUS[mode] || MODE_FOCUS.GENERAL;
  const dataHoje = ctxInfo?.dataHoje || new Date().toISOString().slice(0, 10);
  const dadosAte = ctxInfo?.dadosAte || '2026-10-31';
  const ultimoMes = ctxInfo?.ultimoMesCompleto || '2026-10';
  const invStatus = ctxInfo?.isMarcoZero
    ? 'apenas Marco Zero (sem histórico de liquidez)'
    : 'histórico disponível';

  return `<papel>
És o Copilot do BI Pharma, assistente de dados de uma farmácia comunitária em Portugal.
Respondes com factos obtidos da base de dados da farmácia através das ferramentas, e só executas
ações na aplicação quando o utilizador as pede. Falas português de Portugal. Os utilizadores são
proprietário/gestor, diretor técnico e equipa de balcão: adapta o detalhe à pergunta, não ao perfil.
</papel>

<contexto_sessao>
Hoje: ${dataHoje} | Dados importados até: ${dadosAte} | Último mês completo: ${ultimoMes}
Inventário: ${invStatus}
Foco sugerido pelo modo selecionado: ${focoModo} (apenas indicação; a pergunta manda)
</contexto_sessao>

<contrato_de_resposta>
1. Responde exatamente ao que foi perguntado. Nem mais, nem menos.
2. Não incluas encomendas, proibições, alertas, estratégias de negociação ou planos de ação
   a menos que o utilizador os peça. Perguntas sobre vendas, stock, margens ou validades
   são perguntas de consulta, não pedidos de decisão.
3. Os resultados das ferramentas são dados brutos, não um guião. Nunca reproduzas a sua estrutura,
   nomes de chaves ou secções. Escolhe tu as colunas e secções, pela pergunta.
4. Pergunta simples: 1 a 2 frases de resumo com os totais + 1 tabela. Sem introduções nem conclusões.
   Pergunta composta: uma secção por sub-pergunta, na ordem em que foram feitas.
5. Follow-up ou correção ("só os que têm stock", "em valor e não em unidades", "exclui genéricos"):
   usa o resultado anterior (refinar_resultado) ou repete a consulta com o filtro alterado, e devolve
   APENAS a tabela corrigida com uma linha de enquadramento. Não repitas introduções nem totais já dados.
6. Se houver algo relevante que não foi pedido, no máximo UMA linha final: "Posso também ver X."
7. Todos os números vêm das ferramentas. Campo nulo = "Sem dados". Nunca estimes, arredondes
   para além do que a ferramenta devolve, nem uses "presumível", "provavelmente" ou equivalentes.
8. Se a consulta devolver 0 linhas: "ℹ️ Dados Não Encontrados" + o que foi pesquisado. Sem números.
9. Se existirem avisos em meta.avisos_dados (ex.: DCI em falta, mês parcial, margem estimada),
   refere-os numa nota curta de uma linha, apenas se afetarem o que mostras.
10. Antes de responder, confirma: (a) o que foi pedido, (b) cada secção da resposta responde a algo
    pedido, (c) cada número está nos resultados.
</contrato_de_resposta>

<formato>
- Valores em formato PT: 8.423,24 € | 1.234 un | 31,2 %. Datas de mês: ago/2026.
- Tabelas Markdown concisas: mostra no máximo as 10 linhas principais (e indica o total, ex.: "Top 10 de 42 referências"), salvo se o utilizador pedir explicitamente a lista completa. Em follow-ups (refinar_resultado), devolve apenas a tabela filtrada (máx. 10 linhas) com 1 linha de enquadramento (conciso, <= 150 palavras).
- Só inclui as colunas relevantes para a pergunta. CNP sempre completo (7 dígitos),
  pois a interface transforma-o em link.
- Não menciones nomes de ferramentas, vistas, colunas técnicas, SQL nem identificadores internos.
- Sem emojis decorativos. Só "ℹ️ Dados Não Encontrados" e os marcadores da secção <acoes_ui>.
</formato>

<regras_dominio>
Definições canónicas:
- Mono: stock > 0 e sem vendas há >= 90 dias, qualquer que seja a quantidade.
- Resto de gaveta: stock entre 1 e 2 unidades. Um produto pode ser as duas coisas.
- Excesso de cobertura: cobertura > 4 meses. Usa as flags e valores devolvidos; não recalcules.

Medicamentos sujeitos a receita médica (MSRM):
- Podem ser o GATILHO de uma venda cruzada (ex.: na dispensa de Metformina, Clavamox, Varfarina, podes sugerir produtos complementares de venda livre/MNSRM adequados).
- NUNCA podem ser recomendados como produto sugerido em venda cruzada, nem incluídos em packs, descontos ou campanhas promocionais.
- Nunca sugiras aumentar o PVP (preço fixado pelo Estado). Se custo > PVP num MSRM, indica
  "possível erro de registo de custo no sistema de gestão".
- MSRM que fica com stock 0 é uma possível rutura (avaliar prescrição ativa), nunca "limpeza".

Clínica:
- Não aconselhas clinicamente: não prescreves, não indicas posologias, não fazes diagnósticos médicos nem deduzes interações complexas não catalogadas. Para queixas de balcão ou associações a medicamentos dispensados, usa sempre sugerir_vendas_cruzadas. Sem base catalogada, diz em 1 frase que essa decisão clínica cabe ao Diretor Técnico, e oferece consultar stock, monos ou validades da categoria que indicarem.

Venda cruzada e packs (permitido e desejado):
- Apenas VENDA_LIVRE, MNSRM, dermocosmética e suplementos, com base nos atributos catalogados
  (categoria, subcategoria, papel_recomendacao, público).
- Prioridade de escoamento: monos -> validades curtas -> excessos -> maior margem %.
- Campanhas: preço nunca abaixo do custo + IVA e margem mínima 5 %. Se a ferramenta rejeitar,
  explica o motivo e não contornes.

Património:
- "Liquidez recuperada de monos" = apenas saída de stock com venda comprovada no mês seguinte.
  Com apenas o inventário Marco Zero, o valor é 0,00 € e não inventas metas nem projeções.

Campanhas e Desempenho Promocional:
- Auditoria de campanhas ativas ou concluídas: usa sempre consultar_desempenho_campanhas.
- Distingue claramente:
  1) Faturação específica da campanha (apenas os produtos integrados na campanha durante o período).
  2) Faturação global da farmácia no mesmo período temporal.
  3) Quota de mercado da campanha (% da faturação da farmácia gerada pelos artigos da campanha no período).
  4) Escoamento de stock (% do stock inicial vendido) e capital desmobilizado de monos/validades curtas.
- Rigor Contabilístico e Datas: se a campanha iniciou numa data posterior ao último fecho de vendas importado na base de dados (Sifarma), explica de forma límpida que ainda não existem talões registados após a ativação e que o sistema nunca inventa vendas fictícias; apresenta como referência útil a rotação recente desses produtos (baseline pré-campanha) devolvida pela ferramenta.

Margens: a margem mensal é estimada com o custo médio atual; indica-o quando mostrares margem por mês.
</regras_dominio>

<uso_de_ferramentas>
- Usa a ferramenta mais simples que responde. Para consulta usa as ferramentas consultar_*.
  As ferramentas de decisão (propostas de encomenda, planeamento de compras, packs, vendas cruzadas)
  só se o utilizador pediu uma decisão ou sugestão.
- Ações de escrita (criar tarefa, ativar campanha): primeiro pré-visualização (confirmado=false),
  mostra o que vai ser feito e pede confirmação. Só gravas (confirmado=true) após um "sim" explícito.
- Para follow-ups sobre uma lista já mostrada, usa refinar_resultado com o result_id.
- Se uma ferramenta devolver ok=false, lê o erro, corrige a chamada uma vez, e se persistir
  diz de forma simples o que não foi possível obter.
</uso_de_ferramentas>

<acoes_ui>
Só escreves um marcador se a ação correspondente existir neste turno:
- [BOTAO_EXPORTAR_ENCOMENDA_CSV] e [BOTAO_APLICAR_ENCOMENDA_FOLHA]: após gerar_proposta_encomenda_reposicao
  com lista_exportavel_disponivel=true.
- [BOTAO_APLICAR_PLANO]: quando entregas um plano semanal em checkboxes (- [ ] ...) pedido pelo utilizador,
  organizado nos 4 pilares: Validades, Escoar Stock Parado, Bloquear no Sistema (Ponto Encomenda=0),
  Subir Ponto Encomenda / Evitar Ruturas.
- [BOTAO_GUARDAR_PACK]: após sugerir_packs_promocionais com packs válidos.
</acoes_ui>

<exemplos>
<exemplo id="1" tipo="simples">
Pergunta: "Preciso de saber como estão as vendas dos produtos do laboratório Bial."
Ferramenta: consultar_vendas(filtros.laboratorio="Bial", agrupar_por="produto")
Resposta:
"Nos últimos 12 meses a Bial vendeu **443 un | 8.423,24 €**: 29 produtos com vendas e 8 sem vendas.

| CNP | Designação | DCI | Vendas 12M (un) | Vendas 12M (€) | VMM | Ago | Set | Out | Margem % | Stock |
|---|---|---|---|---|---|---|---|---|---|---|
| 5374749 | Migretil x 20 comp | Ergotamina + Cafeína + Paracetamol + Beladona | 64 | 396,80 € | 5,33 | 3 | 10 | 8 | 23,6% | 5 |
| ... |

_Margem estimada com o custo médio atual._"
Não inclui: encomendas, proibições, negociação, recomendações.
</exemplo>

<exemplo id="2" tipo="composta">
Pergunta: "Nos últimos 3 meses, que produtos da Bial subiram, quais desceram e quais têm similares melhores?"
Ferramentas: consultar_vendas(filtros.laboratorio="Bial") + consultar_grupos_dci(laboratorio="Bial")
Resposta: três secções, exatamente estas: "Produtos com subida de vendas", "Produtos com descida ou sem vendas", "Produtos com similares de melhor rotação ou margem".
Cada uma com a sua tabela; se a DCI estiver em falta, a 3.ª secção refere em 1 linha a cobertura de DCI.
</exemplo>

<exemplo id="3" tipo="follow-up">
Pergunta anterior: tabela de produtos Bial. Agora: "Dessa lista, mostra só os que têm stock acima de 2 unidades."
Ferramenta: refinar_resultado(result_id da tabela anterior, filtro=[["stock_total_unidades", ">", 2]])
Resposta: "Dos 37 produtos, 12 têm stock acima de 2 un:" + tabela filtrada. Nada mais.
</exemplo>

<exemplo id="4" tipo="decisão pedida">
Pergunta: "Que produtos da Bial devo encomendar esta semana?"
Ferramenta: planear_compras_laboratorio(laboratorio="Bial")
Resposta: resumo da proposta (n.º de linhas a repor), tabela com cnp, designação, stock, cobertura, quantidade
calculada e o motivo traduzido do código da regra; se existirem produtos excluídos (mono/excesso), lista-os
numa secção curta porque a decisão de compra o exige.
</exemplo>

<exemplo id="5" tipo="balcão / queixa">
Pergunta: "O que posso associar ao ibuprofeno para uma dor de dentes?"
Ferramenta: sugerir_vendas_cruzadas(gatilho={tipo:"queixa", valor:"dor de dentes"})
Resposta: Para queixas e associações de balcão, usa sempre sugerir_vendas_cruzadas. Apresenta as opções de venda livre compatíveis (ex.: antisséticos orais, elixires, gel anestésico tópico), sem duplicação de AINEs.
Recusa apenas se forem pedidas posologias clínicas, diagnósticos médicos ou doses personalizadas, remetendo aí para o Diretor Técnico.
</exemplo>

<exemplo id="6" tipo="regra legal">
Pergunta: "Faz um pack para escoar o Edistride com um creme."
Resposta: "Não posso incluir medicamentos sujeitos a receita médica em packs ou descontos. Posso montar
o pack com produtos de venda livre ou MNSRM, por ordem de escoamento (monos, validades curtas, excessos)."
</exemplo>

<exemplo id="7" tipo="sem dados">
Ferramenta devolve n_linhas_total=0.
Resposta: "ℹ️ Dados Não Encontrados: não há registos para o filtro indicado." Sem números.
</exemplo>
</exemplos>

${COPILOT_SECURITY_GUARDRAILS_PROMPT}`;
}

// ============================================================================
// CÁLCULO DE CUSTOS FINOPS & TELEMETRIA DE TOKENS (CLAUDE / ANTHROPIC)
// ============================================================================
export interface CopilotUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  custoEstimadoEur: number;
  duracaoMs: number;
}

export interface CopilotChatResponse {
  text: string;
  toolsUsed: string[];
  sessionId: string;
  shoppingList?: any[];
  usage?: CopilotUsageStats;
}

export function calculateClaudeCostEur(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0
): number {
  const USD_TO_EUR = 0.92;

  let inputPerMillion = 0.8;
  let outputPerMillion = 4.0;
  let cacheWritePerMillion = 1.0;
  let cacheReadPerMillion = 0.08;

  const m = (model || '').toLowerCase();
  if (m.includes('sonnet')) {
    inputPerMillion = 3.0;
    outputPerMillion = 15.0;
    cacheWritePerMillion = 3.75;
    cacheReadPerMillion = 0.3;
  } else if (m.includes('opus')) {
    inputPerMillion = 15.0;
    outputPerMillion = 75.0;
    cacheWritePerMillion = 18.75;
    cacheReadPerMillion = 1.5;
  }

  const costUsd =
    (inputTokens / 1_000_000) * inputPerMillion +
    (outputTokens / 1_000_000) * outputPerMillion +
    (cacheCreationTokens / 1_000_000) * cacheWritePerMillion +
    (cacheReadTokens / 1_000_000) * cacheReadPerMillion;

  return Number((costUsd * USD_TO_EUR).toFixed(5));
}

export async function askConversationalCopilot(
  prisma: PrismaClient,
  secContext: ToolSecurityContext,
  question: string,
  sessionId = 'default',
  mode: CopilotMode = 'GENERAL',
  dataReferencia?: string
): Promise<
  CopilotChatResponse & {
    mode: CopilotMode;
    suggestions?: string[];
    ferramentas?: Array<{ nome: string; input: any; resultado: any }>;
  }
> {
  // 1. Guardrails de Segurança (0ms / Zero Tokens)
  const guardrailCheck = validateCopilotInputGuardrails(question, secContext.farmaciaNome);
  if (guardrailCheck.blocked) {
    return {
      text:
        guardrailCheck.publicResponse ||
        '🛡️ [Bloqueio de Segurança]: Pedido não autorizado pelas políticas da plataforma.',
      toolsUsed: [],
      ferramentas: [],
      sessionId,
      mode,
    };
  }

  pruneOldSessions();
  sessionTimestamps.set(sessionId, Date.now());
  const turnoAtual = (sessionTurnCounter.get(sessionId) || 0) + 1;
  sessionTurnCounter.set(sessionId, turnoAtual);

  const storedPrev = getStoredResultsForSession(secContext.farmaciaId, sessionId);
  const intentInfo = classifyQuestionIntent(question, storedPrev.length > 0);

  // Resposta determinística imediata para perguntas clínicas sem base catalogada (0ms / Zero alucinação)
  if (intentInfo.intent === 'CLINICO') {
    const clinicalReply =
      'Não disponho de base científica validada no sistema para efetuar recomendação clínica, posológica ou associação terapêutica a medicamentos; essa avaliação cabe ao Diretor Técnico da farmácia.\n\nPosso consultar o stock, monos, validades ou margens de qualquer categoria de Venda Livre ou MNSRM que indiques.';
    return {
      text: clinicalReply,
      toolsUsed: [],
      ferramentas: [],
      sessionId,
      mode,
    };
  }

  let history = sessionHistory.get(sessionId);
  if (!history) {
    history = [];
    sessionHistory.set(sessionId, history);
  }

  history.push({ role: 'user', content: question });
  if (history.length > 12) {
    history = history.slice(-12);
    sessionHistory.set(sessionId, history);
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const toolsUsed: string[] = [];
  const ferramentasExecutadas: Array<{ nome: string; input: any; resultado: any }> = [];
  const todayLisbon = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date());
  const refDate = parseDia(dataReferencia && /^\d{4}-\d{2}-\d{2}$/.test(dataReferencia) ? dataReferencia : todayLisbon);

  if (!apiKey) {
    return {
      text: `⚠️ **Modo Offline:** Configure a chave \`ANTHROPIC_API_KEY\` para ativar o Copilot.`,
      toolsUsed: [],
      sessionId,
      mode,
    };
  }

  const model = (process.env.COPILOT_MODEL || 'claude-sonnet-4-5').trim();
  const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
  const THINKING_BUDGET = Number(process.env.COPILOT_THINKING_BUDGET || 4000);
  let activeModel = model;
  let useThinking = THINKING_BUDGET >= 1024 && !activeModel.includes('haiku');
  const toolResultsJson: string[] = [[...(sessionKnownCnps.get(sessionId) || [])].join(' ')];
  let validationRetries = 0;

  const startTime = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  const ledgerText = getSessionLedgerText(secContext.farmaciaId, sessionId);
  const scopedTools = getScopedToolsForMode(mode, intentInfo);

  try {
    let currentMessages = [...history];
    let maxSteps = 12;

    while (maxSteps > 0) {
      maxSteps--;

      const systemBlocks: any[] = [
        {
          type: 'text',
          text: getSystemPromptForMode(mode),
          cache_control: { type: 'ephemeral' },
        },
      ];
      if (ledgerText) {
        systemBlocks.push({
          type: 'text',
          text: ledgerText,
        });
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: activeModel,
          max_tokens: useThinking ? THINKING_BUDGET + 4096 : 4096,
          ...(useThinking ? { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET } } : {}),
          system: systemBlocks,
          tools: scopedTools,
          tool_choice: { type: 'auto' },
          messages: currentMessages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Copilot Engine] Erro na API Claude:', response.status, errText);
        if ((response.status === 404 || response.status === 400) && activeModel !== FALLBACK_MODEL) {
          console.warn(`[Copilot Engine] A recuar de ${activeModel} para ${FALLBACK_MODEL}`);
          activeModel = FALLBACK_MODEL;
          useThinking = false;
          maxSteps++;
          continue;
        }
        throw new Error(`Erro na API Claude (${response.status})`);
      }

      const data = (await response.json()) as any;
      const usage = data.usage || {};
      totalInputTokens += usage.input_tokens || 0;
      totalOutputTokens += usage.output_tokens || 0;
      totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
      totalCacheReadTokens += usage.cache_read_input_tokens || 0;

      const content = data.content || [];
      const toolUseCalls = content.filter((c: any) => c.type === 'tool_use');

      if (toolUseCalls.length === 0) {
        const textBlocks = content.filter((c: any) => c.type === 'text');
        let finalText = sanitizeCopilotOutput(textBlocks.map((b: any) => b.text).join('\n\n'));

        // VALIDAÇÃO EM CÓDIGO (V1-V14)
        const validation = validateCopilotAnswer(finalText, toolResultsJson, toolsUsed, intentInfo);
        if (!validation.ok && validationRetries < 1 && maxSteps > 0) {
          validationRetries++;
          console.warn('[Copilot Validation] Resposta rejeitada (tentativa 1):', validation.problems);
          currentMessages.push({ role: 'assistant', content });
          currentMessages.push({
            role: 'user',
            content:
              '[VALIDAÇÃO AUTOMÁTICA - a tua resposta violou o contrato] ' +
              validation.problems.join(' ') +
              ' Reescreve a resposta final cumprindo estritamente o que foi perguntado, sem mencionar esta validação.',
          });
          continue;
        }

        // Se na 2ª tentativa ainda houver secção não solicitada (V1), remove-a automaticamente
        if (!intentInfo.decisionAllowed) {
          finalText = stripUnsolicitedPurchaseSections(finalText);
        }

        // Pós-processamento determinístico (V8 marcadores UI, V12 fuga técnica, V14 nota de margem estimada)
        finalText = postProcessCopilotText(finalText, toolsUsed, toolResultsJson, intentInfo);

        history.push({ role: 'assistant', content: finalText });
        sessionHistory.set(sessionId, history);

        const duracaoMs = Date.now() - startTime;
        const custoEstimadoEur = calculateClaudeCostEur(
          activeModel,
          totalInputTokens,
          totalOutputTokens,
          totalCacheCreationTokens,
          totalCacheReadTokens
        );

        const capturedShoppingList = getLatestTurnShoppingList(secContext.farmaciaId, sessionId, turnoAtual);

        prisma.copilotUsageLog
          .create({
            data: {
              farmaciaId: secContext.farmaciaId,
              sessionId,
              modelo: activeModel,
              pergunta: question.slice(0, 1000),
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
              cache_creation_input_tokens: totalCacheCreationTokens,
              cache_read_input_tokens: totalCacheReadTokens,
              custo_estimado_eur: custoEstimadoEur,
              ferramentas_executadas: toolsUsed,
              duracao_ms: duracaoMs,
            },
          })
          .catch((err: any) => console.error('[Copilot FinOps] Erro ao gravar log:', err.message));

        return {
          text: finalText,
          toolsUsed,
          ferramentas: ferramentasExecutadas,
          sessionId,
          mode,
          shoppingList: capturedShoppingList || undefined,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheCreationTokens: totalCacheCreationTokens,
            cacheReadTokens: totalCacheReadTokens,
            custoEstimadoEur,
            duracaoMs,
          },
        };
      }

      // Preserva todos os blocos devolvidos pela API (incluindo thinking + tool_use) no mesmo turno
      currentMessages.push({ role: 'assistant', content });

      const toolResults = [];

      for (const call of toolUseCalls) {
        toolsUsed.push(call.name);
        const args = call.input || {};
        let resultData: any;

        try {
          // 1. Validação estrita de argumentos contra o esquema declarado
          const toolDef = COPILOT_TOOLS.find((t) => t.name === call.name);
          const declaredProps = (toolDef?.input_schema as any)?.properties;
          if (declaredProps && typeof args === 'object' && args !== null) {
            const permitidos = new Set(Object.keys(declaredProps));
            const desconhecidos = Object.keys(args).filter((k) => !permitidos.has(k));
            if (desconhecidos.length > 0) {
              resultData = {
                ok: false,
                erro: {
                  codigo: 'ARGUMENTO_DESCONHECIDO',
                  mensagem: `Argumento(s) desconhecido(s) na ferramenta "${call.name}": ${desconhecidos.join(', ')}. Argumentos aceites: ${Array.from(permitidos).join(', ')}.`,
                },
              };
            }
          }

          // 2. Gating de segurança: bloquear ferramentas de decisão se o intent não o permitir
          if (!resultData && DECISION_TOOL_NAMES.has(call.name) && !intentInfo.decisionAllowed) {
            resultData = {
              ok: false,
              erro: {
                codigo: 'FERRAMENTA_NAO_PERMITIDA',
                mensagem: `A ferramenta de decisão "${call.name}" não é permitida para perguntas de consulta. Use consultar_vendas, consultar_produtos ou consultar_grupos_dci.`,
              },
            };
          } else if (!resultData && WRITE_TOOL_NAMES.has(call.name) && (!args.confirmado || !intentInfo.confirmacaoUtilizador)) {
            // Regra V11: Escrita em 2 passos
            resultData = {
              ok: true,
              pre_visualizacao: true,
              gravado_na_bd: false,
              mensagem:
                'Pré-visualização gerada. Apresente os detalhes ao utilizador e peça confirmação explícita ("Confirma a criação?") antes de chamar novamente com confirmado=true.',
              dados_propostos: args,
            };
          } else if (!resultData) {
            switch (call.name) {
              case 'consultar_vendas':
                resultData = await toolConsultarVendas(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'consultar_produtos':
                resultData = await toolConsultarProdutos(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'consultar_grupos_dci':
                resultData = await toolConsultarGruposDci(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'consultar_patrimonio_stock':
                resultData = await toolConsultarPatrimonioStock(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'ficha_produto':
                resultData = await toolFichaProduto(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'refinar_resultado':
                resultData = toolRefinarResultado(secContext.farmaciaId, sessionId, turnoAtual, args);
                break;

              case 'consultar_sql':
                resultData = await toolConsultarSql(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'descrever_dados':
                resultData = await toolDescreverDados(prisma, secContext);
                break;

              case 'consultar_tarefas_e_campanhas':
                resultData = await toolConsultarTarefasECampanhas(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'consultar_desempenho_campanhas':
                resultData = await toolConsultarDesempenhoCampanhas(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'planear_compras_laboratorio':
                resultData = await toolPlanearComprasLaboratorio(prisma, secContext, args, sessionId, turnoAtual);
                break;

              case 'sugerir_vendas_cruzadas': {
                const repo = createPrismaComercialRepo(prisma, secContext.farmaciaId, sessionId, turnoAtual, args);
                const gatilhoInput = args.gatilho || {
                  tipo: 'texto',
                  valor: String(args.categoria_ou_necessidade || ''),
                };
                resultData = await sugerirVendasCruzadas(
                  {
                    gatilho: gatilhoInput,
                    publico: args.publico ?? (args.publico_alvo === 'PEDIATRICO' ? 'PEDIATRICO' : args.publico_alvo === 'ADULTO_GERAL' ? 'ADULTO' : null),
                    condicoes_cliente: Array.isArray(args.condicoes_cliente) ? args.condicoes_cliente : undefined,
                    limite: args.limite,
                  },
                  { repo, ref: refDate, cfg: buildComercialCfg() }
                );
                break;
              }

              case 'gerar_proposta_encomenda_reposicao': {
                const rawProp: any = await toolGerarPropostaEncomendaReposicao(prisma, secContext, args);
                const fullList =
                  rawProp?.listaCompletaParaExportar || rawProp?.carrinhoSugerido || [];
                const topItems = (rawProp?.topPrioritariosTabela || fullList).slice(0, 25);
                const colunas = [
                  'cnp_codigo',
                  'designacao',
                  'canal_sugerido',
                  'stock_atual',
                  'vendas_ano',
                  'qtd_calculada',
                  'custo_unitario',
                  'total_linha_eur',
                  'regra_aplicada',
                ];
                const linhas = topItems.map((i: any) => {
                  const cnp = i.cnp || i.cnp_codigo;
                  const des = i.designacao;
                  const canal = i.canalRotulo || i.canalSugerido || i.canalCompra || 'ARMAZENISTA';
                  const stock = i.stockAtual ?? i.stock ?? 0;
                  const vendas = i.vendas12M ?? i.vendasAno12M ?? i.vendasQtd ?? 0;
                  const qtd = i.quantidadeAEncomendar ?? i.qtdSugeridaEncomenda ?? i.falta;
                  const custo = i.custoUnitarioEur ?? i.custo ?? 0;
                  const total = i.custoTotalLinhaEur ?? i.investimentoLinhaEur ?? Number((qtd * custo).toFixed(2));

                  if (!cnp || !des || qtd === undefined) {
                    throw new Error(
                      `[gerar_proposta_encomenda_reposicao] Campo essencial em falta na proposta: cnp=${cnp}, designacao=${des}, qtd=${qtd}`
                    );
                  }

                  return [
                    cnp,
                    des,
                    canal,
                    stock,
                    vendas,
                    qtd,
                    custo,
                    total,
                    stock === 0 ? 'REPOR_RUTURA' : 'REPOR_ATE_COBERTURA_ALVO',
                  ];
                });
                resultData = saveToolResult({
                  farmaciaId: secContext.farmaciaId,
                  sessionId,
                  turno: turnoAtual,
                  ferramenta: 'gerar_proposta_encomenda_reposicao',
                  input: args,
                  meta: {
                    parametros_usados: {
                      horizonte_dias: args.horizonte_dias || 7,
                      orcamento_maximo_eur: args.orcamento_maximo_eur || null,
                    },
                    lista_exportavel_disponivel: fullList.length > 0,
                    n_linhas_total: fullList.length,
                  },
                  colunas,
                  linhas,
                  totais: rawProp?.resumoExecutivo || {},
                  shoppingList: fullList,
                  limiteModelo: 25,
                });
                break;
              }

              case 'sugerir_packs_promocionais': {
                const repo = createPrismaComercialRepo(prisma, secContext.farmaciaId, sessionId, turnoAtual, args);
                const modo = args.modo === 'TEMAS' || (!args.campanha_id && !args.tema) ? 'TEMAS' : 'PACK';
                resultData = await sugerirPacksPromocionais(
                  {
                    modo,
                    campanha_id: args.campanha_id,
                    tema: args.tema,
                    desconto_pct: args.desconto_pct ?? args.desconto_percentagem,
                    publico: args.publico ?? null,
                    n_produtos_max: args.n_produtos_max,
                    incluir_em_campanha: args.incluir_em_campanha,
                    incluir_preco_fixo: args.incluir_preco_fixo,
                    liquidacao: args.liquidacao,
                    data_referencia: args.data_referencia,
                  },
                  { repo, ref: refDate, cfg: buildComercialCfg() }
                );
                break;
              }

              case 'criar_tarefa_equipa':
                resultData = await toolCriarTarefaEquipa(prisma, secContext, args);
                break;

              case 'ativar_campanha_farmacia':
                resultData = await toolAtivarCampanhaFarmacia(prisma, secContext, args);
                break;

              default:
                resultData = {
                  ok: false,
                  erro: { codigo: 'FERRAMENTA_DESCONHECIDA', mensagem: `Ferramenta desconhecida: ${call.name}` },
                };
            }
          }
        } catch (e: any) {
          resultData = {
            ok: false,
            erro: { codigo: 'ERRO_EXECUCAO', mensagem: e.message },
          };
        }

        ferramentasExecutadas.push({ nome: call.name, input: args, resultado: resultData });
        const jsonStr = JSON.stringify(resultData);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: jsonStr,
        });
        toolResultsJson.push(jsonStr);
        const sk = sessionKnownCnps.get(sessionId) || new Set<string>();
        extractCnps(jsonStr).forEach((x) => sk.add(x));
        sessionKnownCnps.set(sessionId, sk);
      }

      currentMessages.push({
        role: 'user',
        content: toolResults,
      });
    }

    const duracaoMs = Date.now() - startTime;
    const custoEstimadoEur = calculateClaudeCostEur(
      activeModel,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens
    );

    return {
      text: 'Foram analisados os dados da farmácia, mas a resposta excedeu o limite de passos. Por favor tente especificar mais a sua pergunta.',
      toolsUsed,
      sessionId,
      mode,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        cacheReadTokens: totalCacheReadTokens,
        custoEstimadoEur,
        duracaoMs,
      },
    };
  } catch (err: any) {
    console.error('[Copilot Engine Error]:', err.message);
    return {
      text: `❌ Ocorreu um erro ao comunicar com a inteligência analítica: ${err.message}`,
      toolsUsed,
      sessionId,
      mode,
    };
  }
}
