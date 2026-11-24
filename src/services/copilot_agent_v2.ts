import { PrismaClient } from '@prisma/client';
import {
  ToolSecurityContext,
  toolConsultarProdutosPorNomeOuCategoria,
  toolConsultarVendasPeriodo,
  toolAnalisarDesempenhoLaboratorio,
  toolCalcularStockMinimoECobertura,
  toolIdentificarProdutosSemVenda,
  toolAnalisarEvolucaoMensalFinanceira,
  toolCompararPerformancePeriodos,
  toolAuditarEscoamentoEDestraveStock,
  toolConsolidarGenericosDci,
  toolGerarPropostaEncomendaReposicao,
  toolAnalisarCurvaAbcFaturacaoEMargem,
  toolConsultarCampanhasAtivasEHistorico,
  toolConsultarProgressoTarefasEquipa,
  toolConsultarVendasDiarias,
} from './mcp_pharma_tools.js';
import {
  renderMarkdownTableFromStoredResult,
  TabelaSpec,
} from './pharma_tool_helpers.js';
import { calculateClaudeCostEur } from './copilot_engine.js';
import { CopilotAuditTracer } from './copilot_audit.js';

// ============================================================================
// BI-PHARMA COPILOT v2 — MODO AGENTE (Opção A, Piloto Superuser)
// - Camada única de ferramentas (mcp_pharma_tools.ts)
// - Chamadas em paralelo (Promise.all)
// - Sem max_tokens=280, sem stop_sequences, sem corte T1-T8
// - Tabelas determinísticas por referência (resultado_id)
// - Validação factual com 1 retry de auto-correção (incl. regra Rhinodouche 4c)
// - Progresso em tempo real (SSE callback)
// ============================================================================

export interface AgentV2ProgressEvent {
  type: 'status' | 'tools' | 'validating' | 'done' | 'error';
  message: string;
  tools?: string[];
  step?: number;
}

export interface AgentV2Result {
  text: string;
  toolsUsed: string[];
  sessionId: string;
  interacaoId: string;
  tabelasRenderizadas: Array<{ resultado_id: string; titulo?: string; markdown: string; rowCount: number }>;
  avisoValidacao?: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    custoEstimadoEur: number;
    duracaoMs: number;
    modelo: string;
  };
}

interface AgentSessionMessage {
  role: 'user' | 'assistant';
  content: any;
}

const agentV2Sessions = new Map<string, AgentSessionMessage[]>();

export function clearAgentV2Session(scopedSessionId: string) {
  agentV2Sessions.delete(scopedSessionId);
}

const AGENT_V2_SYSTEM_PROMPT = `És o Copilot v2 do BI-Pharma, agente analítico de gestão de farmácia comunitária em Portugal (PT-PT).
Tens acesso direto às ferramentas oficiais da farmácia (a mesma camada de dados do MCP).

REGRAS FUNDAMENTAIS DE RIGOR:
1. FACTOS PRIMEIRO: Nunca inventes números, CNPs, stocks, vendas ou margens. Chama sempre as ferramentas necessárias antes de responder.
2. REGRA DE INEXISTÊNCIA (CRÍTICA): Nunca afirmes que um produto, marca, laboratório ou vendas "não existe", "não há registos" ou "não está catalogado" sem, neste mesmo turno, teres chamado uma ferramenta que cobre esse âmbito (ex.: consultar_produtos ou consultar_vendas_periodo) e essa ferramenta ter devolvido 0 registos. Se encontraste o artigo no catálogo ou em vendas históricas mas com stock = 0, diz isso claramente ("0 un em stock atual, mas registou X un vendidas no histórico").
3. CHAMADAS EM PARALELO E EFICIÊNCIA: Quando precisares de cruzar fontes, chama as ferramentas em paralelo na mesma ronda, mas evita disparar dezenas de chamadas redundantes (ex.: para analisar um laboratório e comparar alternativas na mesma DCI, \`analisar_desempenho_laboratorio\` + \`consultar_vendas_periodo\` já trazem quotas DCI, monos, excessos e vendas; não faças 6–8 chamadas separadas a \`consultar_produtos\` por cada molécula).
4. VOCABULÁRIO DE AÇÕES E LINGUAGEM HUMANA: Respeita os campos \`situacao\`, \`acoes_permitidas\` e \`acao_sugerida\` devolvidos pelas ferramentas. NUNCA recomendes "encomendar urgente" ou "rutura total" para artigos com 0 vendas ou marcados como \`TRABALHAR_ENCOMENDA\`. NUNCA chames "rutura" a artigos sem stock e sem rotação — diz "sem stock atual (0 un)". TRADUZ SEMPRE todos os códigos internos para português natural na resposta ao utilizador (ex.: "trabalhar por encomenda", "sem stock e sem vendas nos últimos 12 meses", "baixa rotação sem stock", "descontinuar", "rever dados") — NUNCA mostres códigos em MAIÚSCULAS_COM_UNDERSCORE nem nomes técnicos de colunas em camelCase. Usa sempre os totais já calculados em \`resumoEncontrado\` / \`resumo\` sem fazer somas de cabeça.
5. IVA E MARGEM: As ferramentas já devolvem \`margemUnitariaEur\` e \`margemPct\` com o IVA deduzido. Apresenta as margens em português limpo (ex.: "6,10 € (30%), sem IVA") sem mencionar nomes internos de origem do PVP (\`PRODUTO_MESTRE\`, \`FARMACIA\`).
6. DADOS PARCIAIS (D6): Indica sempre até que data existem dados (\`dados_ate\`). Se \`mes_parcial: true\` ou existir \`aviso_dados_incompletos\`, inclui esse aviso de forma clara na resposta.
7. TABELAS POR REFERÊNCIA: Sempre que quiseres apresentar uma tabela com 4 ou mais produtos/linhas, chama a ferramenta \`tabela\` passando o \`resultado_id\` devolvido pela consulta anterior (com colunas, ordenação e limite). O sistema gera a tabela exata a partir dos dados reais sem risco de erro de cópia. Na tua resposta final, refere a tabela gerada ou inclui o markdown devolvido sem alterar nenhum número.
8. LIMITE CLÍNICO: Não dês aconselhamento clínico, diagnóstico ou posológico a utentes — essa competência é exclusiva do Diretor Técnico.
9. ESTILO: Responde em português de Portugal, de forma clara, estruturada, objetiva e acionável para a gestão da farmácia.`;

const AGENT_V2_TOOLS = [
  {
    name: 'consultar_produtos',
    description:
      'Pesquisa produtos por nome (com tolerância a acentos, hífens e pequenas gralhas, ex: Rino-duche = Rhinodouche), marca, DCI, categoria ou lista de CNPs. Cobre catálogo completo + vendas históricas (todos os anos) + stock atual. Devolve origem_encontrada, stock, vendas históricas e 12M, IVA, margem líquida sem IVA, acoes_permitidas e resultado_id.',
    input_schema: {
      type: 'object',
      properties: {
        termo_pesquisa: { type: 'string', description: 'Nome, marca, DCI, categoria ou CNP' },
        cnps: { type: 'array', items: { type: 'string' }, description: 'Lista de CNPs em lote' },
        apenas_com_stock: { type: 'boolean', description: 'Se true, devolve só artigos com stock > 0 (default false)' },
        limite: { type: 'number', description: 'Máximo por página (default 30, máx 200)' },
        pagina: { type: 'number', description: 'Página (default 1)' },
      },
    },
  },
  {
    name: 'consultar_vendas_periodo',
    description:
      'Consulta rápida de vendas agregadas por período (YYYY, YYYY-MM, YYYY-MM..YYYY-MM, ultimos_3m, ultimos_12m) a partir do Mart mensal. Aceita filtros por laboratório (matching canónico exato), categoria, termo_pesquisa ou lista de CNPs. Devolve unidades, faturação, margem líquida sem IVA, aviso D6 e resultado_id.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', description: 'Ex: "2026", "2026-01", "2025-11..2026-02", "ultimos_3m", "ultimos_12m"' },
        laboratorio: { type: 'string', description: 'Nome do laboratório (ex: Bial, Generis, Teva)' },
        categoria: { type: 'string', description: 'Categoria ou subcategoria' },
        termo_pesquisa: { type: 'string', description: 'Termo de pesquisa no produto/DCI/CNP' },
        cnps: { type: 'array', items: { type: 'string' }, description: 'Lista de CNPs' },
        limite: { type: 'number', description: 'Registos por página (default 30, máx 200)' },
        pagina: { type: 'number', description: 'Página (default 1)' },
      },
    },
  },
  {
    name: 'analisar_desempenho_laboratorio',
    description:
      'Análise completa de um laboratório (matching canónico rigoroso): vendas no período ou 12M, stock, capital empatado em monos e excessos, artigos para repor, quotas DCI internas, IVA, margem líquida e resultado_id.',
    input_schema: {
      type: 'object',
      properties: {
        nome_laboratorio: { type: 'string', description: 'Nome do laboratório (ex: Bial, Generis, Pierre Fabre)' },
        periodo: { type: 'string', description: 'Opcional: "2026", "2026-01", etc.' },
        limite_detalhes: { type: 'number', description: 'Máximo por página (default 30, máx 200)' },
        pagina: { type: 'number', description: 'Página (default 1)' },
      },
      required: ['nome_laboratorio'],
    },
  },
  {
    name: 'calcular_stock_minimo_cobertura',
    description:
      'Calcula stock mínimo, cobertura em dias/meses, ruturas reais e excessos para os dias de cobertura desejados. Aceita termo_pesquisa, cnps, pagina e limite.',
    input_schema: {
      type: 'object',
      properties: {
        dias_cobertura_desejados: { type: 'number', description: 'Dias de cobertura alvo (default 7)' },
        apenas_abaixo_minimo: { type: 'boolean', description: 'Filtrar apenas ruturas / abaixo do mínimo' },
        termo_pesquisa: { type: 'string', description: 'Filtro opcional por nome ou CNP' },
        cnps: { type: 'array', items: { type: 'string' }, description: 'Lista de CNPs' },
        limite: { type: 'number', description: 'Registos por página (default 30, máx 200)' },
        pagina: { type: 'number', description: 'Página (default 1)' },
      },
    },
  },
  {
    name: 'identificar_monos_sem_venda',
    description:
      'Identifica produtos com stock físico parado sem vendas nos últimos X meses (monos) e capital imobilizado.',
    input_schema: {
      type: 'object',
      properties: {
        meses_sem_venda: { type: 'number', description: 'Meses sem vendas (default 6)' },
        tipo_venda: { type: 'string', description: 'MSRM, MNSRM ou VENDA_LIVRE' },
        laboratorio: { type: 'string', description: 'Filtro opcional por laboratório' },
        limite: { type: 'number', description: 'Máximo de artigos (default 30)' },
      },
    },
  },
  {
    name: 'analisar_evolucao_mensal',
    description: 'Evolução mensal de faturação, unidades vendidas e margem da farmácia mês a mês.',
    input_schema: {
      type: 'object',
      properties: {
        meses: { type: 'number', description: 'Número de meses a analisar (default 12)' },
      },
    },
  },
  {
    name: 'comparar_periodos',
    description: 'Compara a performance entre dois períodos (ex: 2026-01 vs 2025-12 ou 2026-01 vs 2025-01).',
    input_schema: {
      type: 'object',
      properties: {
        periodo_atual: { type: 'string', description: 'Ex: "2026-01" ou "2026"' },
        periodo_anterior: { type: 'string', description: 'Ex: "2025-12" ou "2025"' },
      },
      required: ['periodo_atual', 'periodo_anterior'],
    },
  },
  {
    name: 'auditar_escoamento_validades',
    description: 'Lista produtos com validade próxima ou risco de quebra/escoamento prioritário.',
    input_schema: {
      type: 'object',
      properties: {
        dias_validade_max: { type: 'number', description: 'Horizonte máximo em dias (default 180)' },
        limite: { type: 'number', description: 'Máximo de registos (default 30)' },
      },
    },
  },
  {
    name: 'consolidar_genericos_dci',
    description: 'Analisa pulverização de laboratórios genéricos na mesma molécula DCI e oportunidades de consolidação.',
    input_schema: {
      type: 'object',
      properties: {
        min_laboratorios: { type: 'number', description: 'Mínimo de laboratórios por molécula (default 3)' },
        limite: { type: 'number', description: 'Máximo de moléculas (default 20)' },
      },
    },
  },
  {
    name: 'gerar_proposta_encomenda',
    description: 'Gera proposta quantificada de encomenda de reposição para artigos em rutura ou stock crítico.',
    input_schema: {
      type: 'object',
      properties: {
        dias_cobertura: { type: 'number', description: 'Dias de cobertura alvo (default 21)' },
        laboratorio: { type: 'string', description: 'Filtro opcional por laboratório' },
        limite: { type: 'number', description: 'Máximo de linhas (default 30)' },
      },
    },
  },
  {
    name: 'analisar_curva_abc',
    description: 'Classificação ABC de produtos por faturação ou margem (classe A = top 80%).',
    input_schema: {
      type: 'object',
      properties: {
        criterio: { type: 'string', enum: ['faturacao', 'margem', 'unidades'], description: 'Critério de ordenação' },
        limite: { type: 'number', description: 'Máximo de artigos (default 30)' },
      },
    },
  },
  {
    name: 'consultar_vendas_diarias',
    description: 'Consulta vendas de dias específicos importados com granularidade diária.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        cnp_ou_nome: { type: 'string', description: 'Filtro opcional por CNP ou nome' },
        limite: { type: 'number', description: 'Máximo de linhas (default 30)' },
      },
    },
  },
  {
    name: 'consultar_campanhas',
    description: 'Consulta campanhas ativas e histórico de campanhas da farmácia.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_tarefas_equipa',
    description: 'Consulta o progresso das tarefas semanais e missões da equipa da farmácia.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'tabela',
    description:
      'Gera uma tabela Markdown determinística diretamente a partir de um resultado_id devolvido por uma ferramenta anterior, sem copiar números à mão. Usa esta ferramenta para qualquer tabela com 4+ linhas.',
    input_schema: {
      type: 'object',
      properties: {
        resultado_id: { type: 'string', description: 'O resultado_id devolvido pela ferramenta de consulta' },
        titulo: { type: 'string', description: 'Título da tabela' },
        colunas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de nomes exatos de campos a incluir como colunas',
        },
        filtro: {
          type: 'object',
          properties: {
            campo: { type: 'string' },
            valor: { type: 'string' },
          },
          description: 'Filtro opcional por campo/valor',
        },
        ordenar: {
          type: 'object',
          properties: {
            campo: { type: 'string' },
            direcao: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
        limite: { type: 'number', description: 'Máximo de linhas na tabela (default 30, máx 100)' },
      },
      required: ['resultado_id'],
    },
  },
];

async function executeUnifiedTool(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  name: string,
  input: any,
  tabelasCollector: Array<{ resultado_id: string; titulo?: string; markdown: string; rowCount: number }>
): Promise<any> {
  switch (name) {
    case 'consultar_produtos':
      return toolConsultarProdutosPorNomeOuCategoria(prisma, ctx, input || {});
    case 'consultar_vendas_periodo':
      return toolConsultarVendasPeriodo(prisma, ctx, input || {});
    case 'analisar_desempenho_laboratorio':
      return toolAnalisarDesempenhoLaboratorio(prisma, ctx, input || {});
    case 'calcular_stock_minimo_cobertura':
      return toolCalcularStockMinimoECobertura(prisma, ctx, input || {});
    case 'identificar_monos_sem_venda':
      return toolIdentificarProdutosSemVenda(prisma, ctx, input || {});
    case 'analisar_evolucao_mensal':
      return toolAnalisarEvolucaoMensalFinanceira(prisma, ctx, input || {});
    case 'comparar_periodos':
      return toolCompararPerformancePeriodos(prisma, ctx, input || {});
    case 'auditar_escoamento_validades':
      return toolAuditarEscoamentoEDestraveStock(prisma, ctx, input || {});
    case 'consolidar_genericos_dci':
      return toolConsolidarGenericosDci(prisma, ctx, input || {});
    case 'gerar_proposta_encomenda':
      return toolGerarPropostaEncomendaReposicao(prisma, ctx, input || {});
    case 'analisar_curva_abc':
      return toolAnalisarCurvaAbcFaturacaoEMargem(prisma, ctx, input || {});
    case 'consultar_vendas_diarias':
      return toolConsultarVendasDiarias(prisma, ctx, input || {});
    case 'consultar_campanhas':
      return toolConsultarCampanhasAtivasEHistorico(prisma, ctx, input || {});
    case 'consultar_tarefas_equipa':
      return toolConsultarProgressoTarefasEquipa(prisma, ctx, input || {});
    case 'tabela': {
      const spec = (input || {}) as TabelaSpec;
      const rendered = renderMarkdownTableFromStoredResult(ctx.farmaciaId, spec);
      if (rendered.ok && rendered.markdown) {
        tabelasCollector.push({
          resultado_id: spec.resultado_id,
          titulo: spec.titulo,
          markdown: rendered.markdown,
          rowCount: rendered.rowCount,
        });
      }
      return rendered;
    }
    default:
      return { error: `Ferramenta desconhecida: ${name}` };
  }
}

/**
 * Recolhe todos os valores numéricos presentes nos resultados das ferramentas do turno (#25).
 */
function collectToolNumbers(obj: any, out: Set<number>, depth = 0): void {
  if (depth > 8 || obj === null || obj === undefined) return;
  if (typeof obj === 'number' && Number.isFinite(obj)) {
    out.add(Math.round(obj * 100) / 100);
    out.add(Math.round(obj * 10) / 10);
    out.add(Math.round(obj));
    return;
  }
  if (typeof obj === 'string') {
    const matches = obj.match(/-?\d+(?:[.,]\d+)?/g);
    if (matches) {
      for (const m of matches) {
        const n = Number(m.replace(',', '.'));
        if (Number.isFinite(n)) {
          out.add(Math.round(n * 100) / 100);
          out.add(Math.round(n * 10) / 10);
          out.add(Math.round(n));
        }
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectToolNumbers(item, out, depth + 1);
    return;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) collectToolNumbers(v, out, depth + 1);
  }
}

function parsePtNumber(raw: string): number {
  const s = raw.trim().replace(/\s+/g, '');
  if (s.includes(',') && s.includes('.')) {
    // ex: 1.234,56 -> 1234.56
    return Number(s.replace(/\./g, '').replace(',', '.'));
  }
  if (s.includes(',')) {
    return Number(s.replace(',', '.'));
  }
  // ex: 1.234 (milhar PT se 3 dígitos após ponto)
  if (/^\d{1,3}\.\d{3}$/.test(s)) {
    return Number(s.replace(/\./g, ''));
  }
  return Number(s);
}

function hasApproxNumber(pool: number[], target: number, tol: number): boolean {
  for (const n of pool) {
    if (Math.abs(n - target) <= tol) return true;
  }
  return false;
}

/**
 * Validação factual pós-resposta (Decisão 2 + Decisão 4c Rhinodouche + Adenda #25):
 * Devolve lista de problemas detetados; se não estiver vazia, o loop pede ao modelo para corrigir 1 vez.
 */
export function validateAgentV2Response(
  finalText: string,
  executedTools: Array<{ name: string; input: any; result: any }>
): string[] {
  const issues: string[] = [];
  const lower = finalText.toLowerCase();

  // Regra 4c (Rhinodouche): Detetar afirmações GLOBAIS de inexistência ("não há registos para X", "nem em stock nem em histórico", "não está catalogado")
  // Evita falso positivo quando a resposta lista vários artigos e diz "sem vendas registadas" apenas para 1 artigo ou "não têm aviso de dados incompletos".
  const hasStructuredFindings = finalText.includes('| --- |') || /\b\d{7}\b/.test(finalText);
  const claimsGlobalNonExistence =
    /(n[aã]o\s+(?:h[aá]|existem?|temos|foram\s+encontrad[oa]s?)\s+(?:registos?|vendas?|dados?|produtos?|artigos?)\s+(?:para|de|dest[ea]|no\s+cat[aá]logo|na\s+base))|(nem\s+em\s+stock,?\s*nem\s+em\s+(?:hist[oó]rico|vendas))|(n[aã]o\s+est[aá]\s+catalogad[oa])|(0\s+registos?\s+na\s+base\s+de\s+dados)/i.test(
      lower
    );

  if (claimsGlobalNonExistence && !hasStructuredFindings) {
    const scopeTools = executedTools.filter((t) =>
      ['consultar_produtos', 'consultar_vendas_periodo', 'analisar_desempenho_laboratorio', 'consultar_vendas_diarias'].includes(t.name)
    );
    if (scopeTools.length === 0) {
      issues.push(
        'VIOLAÇÃO DA REGRA 4c: Afirmaste que não existem registos/vendas sem teres chamado nenhuma ferramenta de consulta (consultar_produtos ou consultar_vendas_periodo) neste turno. Chama a ferramenta adequada agora antes de responder.'
      );
    } else {
      const anyFound = scopeTools.some((t) => {
        const r = t.result || {};
        const count =
          Number(r.totalArtigosEncontrados || 0) +
          Number(r.resumo?.totalReferenciasComVenda || 0) +
          Number(r.resumoExecutivo?.totalReferenciasNoCatalogo || 0) +
          (Array.isArray(r.artigos) ? r.artigos.length : 0);
        return count > 0;
      });
      if (anyFound) {
        issues.push(
          'CONTRADIÇÃO FACTUAL (REGRA 4c): As ferramentas chamadas neste turno devolveram registos reais (> 0), mas a tua resposta afirma que não existem registos. Revê os resultados devolvidos (incluindo vendas históricas com stock = 0) e corrige a resposta.'
        );
      }
    }
  }

  // Regra 1: Impedir recomendação de "rutura total / encomenda urgente" quando todos os artigos consultados têm TRABALHAR_ENCOMENDA
  const recommendsUrgentOrder = /(rutura\s+total|encomenda\s+urgente|encomendar\s+refor[cç]o)/i.test(lower);
  if (recommendsUrgentOrder) {
    const prodTools = executedTools.filter((t) => t.name === 'consultar_produtos' || t.name === 'calcular_stock_minimo_cobertura');
    const allItems = prodTools.flatMap((t) => (Array.isArray(t.result?.artigos) ? t.result.artigos : Array.isArray(t.result?.itens) ? t.result.itens : []));
    if (allItems.length > 0 && allItems.every((i: any) => i.acao_sugerida === 'TRABALHAR_ENCOMENDA' || i.situacao === 'SEM_STOCK_SEM_VENDAS')) {
      issues.push(
        'VIOLAÇÃO DA REGRA DE AÇÕES: Os artigos devolvidos estão classificados como TRABALHAR_ENCOMENDA (0 vendas ou baixa rotação não-crónica). Não recomendes "rutura total" nem "encomenda urgente"; indica que são artigos para trabalhar sob encomenda.'
      );
    }
  }

  // Regra #25 (Validação factual numérica): conferir valores €, % e unidades mencionados no texto contra os dados das ferramentas do turno
  if (executedTools.length > 0) {
    const numSet = new Set<number>();
    for (const t of executedTools) {
      collectToolNumbers(t.result, numSet);
    }
    const pool = Array.from(numSet);
    const unverifiedValues: string[] = [];

    // 1. Valores em € (ex: "349,80 €", "€ 96,30", "1.250,00€")
    const eurMatches = finalText.matchAll(/(?:€\s*(\d[\d.\s]*(?:,\d{1,2})?))|(?:(\d[\d.\s]*(?:,\d{1,2})?)\s*€)/g);
    for (const m of eurMatches) {
      const rawNum = (m[1] || m[2] || '').trim();
      const val = parsePtNumber(rawNum);
      if (!Number.isFinite(val) || val === 0) continue;
      if (!hasApproxNumber(pool, val, 0.15)) {
        unverifiedValues.push(`${rawNum} €`);
      }
    }

    // 2. Percentagens (ex: "45,2%", "23%")
    const pctMatches = finalText.matchAll(/(\d+(?:[.,]\d{1,2})?)\s*%/g);
    for (const m of pctMatches) {
      const rawNum = (m[1] || '').trim();
      const val = parsePtNumber(rawNum);
      if (!Number.isFinite(val) || val === 0 || val === 100 || val === 6 || val === 23) continue;
      if (!hasApproxNumber(pool, val, 0.25)) {
        unverifiedValues.push(`${rawNum}%`);
      }
    }

    // 3. Quantidades explícitas (ex: "7 un", "11 unidades")
    const unitMatches = finalText.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:un\b|unidades?\b)/gi);
    for (const m of unitMatches) {
      const rawNum = (m[1] || '').trim();
      const val = parsePtNumber(rawNum);
      if (!Number.isFinite(val) || val <= 2) continue; // ignora 0, 1, 2
      if (!hasApproxNumber(pool, val, 0.05)) {
        unverifiedValues.push(`${rawNum} un`);
      }
    }

    if (unverifiedValues.length > 0) {
      const uniqueUnv = Array.from(new Set(unverifiedValues)).slice(0, 8);
      issues.push(
        `VALIDAÇÃO NUMÉRICA (#25): Os seguintes valores citados no texto não constam nos resultados devolvidos pelas ferramentas deste turno: ${uniqueUnv.join(', ')}. Usa exclusivamente os números e totais pré-calculados devolvidos pelas ferramentas, sem somar ou inventar valores.`
      );
    }
  }

  return issues;
}

function summarizeToolResultForAudit(res: any): {
  resultado_id: string | null;
  num_linhas: number;
  totais: Record<string, any> | null;
} {
  if (!res || typeof res !== 'object') {
    return { resultado_id: null, num_linhas: 0, totais: null };
  }
  const listKey = ['artigos', 'produtos', 'itens', 'monos', 'linhas', 'propostaEncomenda', 'artigosVendidosNoDia'].find((k) =>
    Array.isArray(res[k])
  );
  const num_linhas = listKey ? res[listKey].length : 0;
  const totais: Record<string, any> = {};
  if (res.resumo) totais.resumo = res.resumo;
  if (res.resumoEncontrado) totais.resumoEncontrado = res.resumoEncontrado;
  if (res.resumoExecutivo) totais.resumoExecutivo = res.resumoExecutivo;
  if (res.resumoGeral) totais.resumoGeral = res.resumoGeral;
  if (res.dados_ate !== undefined) totais.dados_ate = res.dados_ate;
  if (res.mes_parcial !== undefined) totais.mes_parcial = res.mes_parcial;
  if (res.totalArtigosEncontrados !== undefined) totais.totalArtigosEncontrados = res.totalArtigosEncontrados;

  return {
    resultado_id: typeof res.resultado_id === 'string' ? res.resultado_id : null,
    num_linhas,
    totais: Object.keys(totais).length > 0 ? totais : null,
  };
}

export async function runCopilotAgentV2(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  question: string,
  scopedSessionId: string,
  options?: {
    model?: string;
    maxToolCalls?: number;
    timeoutMs?: number;
    onProgress?: (ev: AgentV2ProgressEvent) => void;
  }
): Promise<AgentV2Result> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY não configurada no servidor.');
  }

  const startMs = Date.now();
  const isBalcao = String(ctx.perfil || '').toUpperCase().includes('BALCAO');
  // #23: Modelo por defeito — claude-sonnet-5-5 para gestão, claude-haiku-5-5 para balcão
  let activeModel =
    options?.model ||
    (isBalcao
      ? process.env.COPILOT_V2_MODEL_BALCAO || 'claude-haiku-5-5'
      : process.env.COPILOT_V2_MODEL || 'claude-sonnet-5-5');
  const maxToolCalls = options?.maxToolCalls ?? (isBalcao ? 3 : 15);
  const timeoutMs = options?.timeoutMs ?? (isBalcao ? 15_000 : 90_000);
  const emit = options?.onProgress || (() => {});

  const tracer = new CopilotAuditTracer(
    ctx.farmaciaId,
    scopedSessionId,
    question,
    (ctx as any).utilizadorId || null
  );

  // Histórico da sessão (últimas 10 mensagens)
  const history = agentV2Sessions.get(scopedSessionId) || [];
  const messages: AgentSessionMessage[] = [
    ...history.slice(-10),
    { role: 'user', content: question },
  ];

  const executedTools: Array<{ name: string; input: any; result: any }> = [];
  const toolsUsedNames: string[] = [];
  const tabelasCollector: Array<{ resultado_id: string; titulo?: string; markdown: string; rowCount: number }> = [];

  let totalIn = 0;
  let totalOut = 0;
  let totalCacheW = 0;
  let totalCacheR = 0;
  let totalToolCalls = 0;
  let stepNum = 0;
  let validationRetries = 0;
  let finalText = '';
  let avisoValidacao: string | null = null;

  emit({ type: 'status', message: 'A analisar a pergunta e selecionar ferramentas...', step: 0 });

  while (stepNum < 10) {
    if (Date.now() - startMs > timeoutMs) {
      // Se o timeout disparou antes de gerar texto final, faz 1 última síntese sem tools para nunca entregar tabelas sem análise
      if (!finalText && messages.length > 1) {
        try {
          emit({ type: 'status', message: 'A finalizar síntese executiva com os dados recolhidos...', step: stepNum + 1 });
          const synthResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: activeModel,
              max_tokens: 2048,
              system: AGENT_V2_SYSTEM_PROMPT,
              messages: [
                ...messages,
                {
                  role: 'user',
                  content:
                    'Com base exclusivamente nos dados já recolhidos acima, apresenta agora a síntese final concisa e acionável para o utilizador (sem chamar mais ferramentas).',
                },
              ],
            }),
          });
          if (synthResp.ok) {
            const synthData: any = await synthResp.json();
            const synthBlocks: any[] = Array.isArray(synthData.content) ? synthData.content : [];
            finalText = synthBlocks.filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n').trim();
            const u = synthData.usage || {};
            totalIn += Number(u.input_tokens || 0);
            totalOut += Number(u.output_tokens || 0);
          }
        } catch (_) {}
      }
      break;
    }

    stepNum++;
    const llmStepStart = Date.now();
    const callAnthropic = async (modelId: string, includeTools = true) => {
      // Prompt Caching multi-turn: marcar a última mensagem de utilizador (tool_result) como cacheável para poupar ~90% nos turnos seguintes
      const cachedMessages = messages.map((msg, idx) => {
        if (idx === messages.length - 1 && msg.role === 'user') {
          if (Array.isArray(msg.content) && msg.content.length > 0) {
            const cloned = [...msg.content];
            const lastBlock = { ...cloned[cloned.length - 1], cache_control: { type: 'ephemeral' } };
            cloned[cloned.length - 1] = lastBlock;
            return { ...msg, content: cloned };
          }
        }
        return msg;
      });

      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 4096,
          system: [
            {
              type: 'text',
              text: AGENT_V2_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          ...(includeTools ? { tools: AGENT_V2_TOOLS } : {}),
          messages: cachedMessages,
        }),
      });
    };

    let response = await callAnthropic(activeModel);
    // Fallback seguro se o model ID 5-5 ainda não estiver ativo na conta Anthropic (evita HTTP 404 em produção)
    if (response.status === 404) {
      const fallbackModel = process.env.ANTHROPIC_MODEL || (isBalcao ? 'claude-haiku-4-5' : 'claude-sonnet-4-5');
      if (fallbackModel !== activeModel) {
        console.warn(`[Copilot v2] Model "${activeModel}" devolveu 404; fallback para "${fallbackModel}".`);
        activeModel = fallbackModel;
        response = await callAnthropic(activeModel);
      }
    }

    if (!response.ok) {
      const errTxt = await response.text().catch(() => '');
      tracer.addEtapa({
        etapa: 'leitura',
        nome: activeModel,
        inicio_ms: llmStepStart - startMs,
        duracao_ms: Date.now() - llmStepStart,
        estado: 'falha',
        detalhe: { httpStatus: response.status, erro: errTxt.slice(0, 300) },
      });
      throw new Error(`Anthropic API HTTP ${response.status}: ${errTxt.slice(0, 300)}`);
    }

    const data: any = await response.json();
    const usage = data.usage || {};
    const stepIn = Number(usage.input_tokens || 0);
    const stepOut = Number(usage.output_tokens || 0);
    const stepCacheW = Number(usage.cache_creation_input_tokens || 0);
    const stepCacheR = Number(usage.cache_read_input_tokens || 0);
    totalIn += stepIn;
    totalOut += stepOut;
    totalCacheW += stepCacheW;
    totalCacheR += stepCacheR;
    tracer.nChamadasApi++;

    const stepCost = calculateClaudeCostEur(activeModel, stepIn, stepOut, stepCacheW, stepCacheR);
    tracer.addEtapa({
      etapa: 'leitura',
      nome: `${activeModel} (ronda ${stepNum})`,
      inicio_ms: llmStepStart - startMs,
      duracao_ms: Date.now() - llmStepStart,
      estado: 'ok',
      tokens_in: stepIn,
      tokens_out: stepOut,
      tokens_cache_write: stepCacheW,
      tokens_cache_read: stepCacheR,
      custo_eur: stepCost,
      detalhe: { stop_reason: data.stop_reason || null },
    });

    const contentBlocks: any[] = Array.isArray(data.content) ? data.content : [];
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
    const textBlocks = contentBlocks.filter((b) => b.type === 'text').map((b) => String(b.text || ''));

    // Caso 1: O modelo pediu ferramentas -> executar em PARALELO (Promise.all) + registar cada uma em CopilotEtapa (#24)
    if (toolUseBlocks.length > 0 && totalToolCalls < maxToolCalls) {
      messages.push({ role: 'assistant', content: contentBlocks });

      const batch = toolUseBlocks.slice(0, Math.max(1, maxToolCalls - totalToolCalls));
      const batchNames = batch.map((b) => b.name);
      emit({
        type: 'tools',
        message: `A consultar dados (${batchNames.join(', ')})...`,
        tools: batchNames,
        step: stepNum,
      });

      const results = await Promise.all(
        batch.map(async (block) => {
          totalToolCalls++;
          if (!toolsUsedNames.includes(block.name)) toolsUsedNames.push(block.name);
          const toolStart = Date.now();
          try {
            const res = await executeUnifiedTool(prisma, ctx, block.name, block.input, tabelasCollector);
            const toolDur = Date.now() - toolStart;
            executedTools.push({ name: block.name, input: block.input, result: res });

            // #24: Registar na CopilotEtapa: nome, input, duração, resultado_id, n.º linhas e totais
            const auditSummary = summarizeToolResultForAudit(res);
            tracer.addEtapa({
              etapa: 'ferramenta',
              nome: block.name,
              inicio_ms: toolStart - startMs,
              duracao_ms: toolDur,
              estado: res?.error ? 'falha' : 'ok',
              detalhe: {
                input: block.input || {},
                resultado_id: auditSummary.resultado_id,
                num_linhas: auditSummary.num_linhas,
                totais: auditSummary.totais,
              },
            });

            // Compactar o JSON devolvido ao contexto do LLM (<= 12 KB) para evitar explosão de tokens (os dados completos ficam intactos no resultado_id para a ferramenta `tabela`)
            const compactForLlm = (rawObj: any): any => {
              if (!rawObj || typeof rawObj !== 'object') return rawObj;
              const copy: Record<string, any> = { ...rawObj };
              // Remover duplicado de analisar_desempenho_laboratorio quando `artigos` já está presente
              if (copy.artigos && copy.produtosMaisVendidosAltaRotacao) {
                delete copy.produtosMaisVendidosAltaRotacao;
              }
              if (Array.isArray(copy.artigos) && copy.artigos.length > 5) {
                copy.artigos = copy.artigos.slice(0, 20).map((a: any) => {
                  const { historicoVendasMensais, vendasPorMes, vendasPorEstacao, ...rest } = a || {};
                  return rest;
                });
              }
              return copy;
            };
            let serialized = JSON.stringify(compactForLlm(res));
            if (serialized.length > 12_000 && res && Array.isArray(res.artigos)) {
              const trimmed = {
                ...compactForLlm(res),
                artigos: compactForLlm(res).artigos.slice(0, 12),
                _nota_truncagem: `Mostrados 12 de ${res.artigos.length} artigos no contexto; usa a ferramenta tabela(resultado_id="${res.resultado_id}") para apresentar a tabela completa.`,
              };
              serialized = JSON.stringify(trimmed);
            }
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: serialized,
            };
          } catch (err: any) {
            const toolDur = Date.now() - toolStart;
            tracer.addEtapa({
              etapa: 'ferramenta',
              nome: block.name,
              inicio_ms: toolStart - startMs,
              duracao_ms: toolDur,
              estado: 'falha',
              detalhe: {
                input: block.input || {},
                erro: err?.message || 'Erro ao executar ferramenta',
              },
            });
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              is_error: true,
              content: JSON.stringify({ error: err?.message || 'Erro ao executar ferramenta' }),
            };
          }
        })
      );

      messages.push({ role: 'user', content: results });
      continue;
    }

    // Caso 2: Resposta textual final -> correr validação factual + numérica (#25) com 1 retry
    finalText = textBlocks.join('\n').trim();
    emit({ type: 'validating', message: 'A validar factos e números da resposta...', step: stepNum });

    const valStart = Date.now();
    const issues = validateAgentV2Response(finalText, executedTools);
    tracer.addEtapa({
      etapa: 'validacao_texto',
      nome: `validacao_ronda_${stepNum}`,
      inicio_ms: valStart - startMs,
      duracao_ms: Date.now() - valStart,
      estado: issues.length === 0 ? 'ok' : 'aviso',
      detalhe: {
        issues,
        ...(issues.length > 0 ? { texto_rejeitado: finalText.slice(0, 2000) } : {}),
      },
    });

    if (issues.length > 0 && validationRetries < 1) {
      validationRetries++;
      tracer.reescritas++;
      tracer.markRuleFailed('VALIDACAO_FACTUAL_V2');
      messages.push({ role: 'assistant', content: contentBlocks });
      messages.push({
        role: 'user',
        content: `[VALIDAÇÃO AUTOMÁTICA INTERNA — CORRIGIR ANTES DE ENTREGAR]\n${issues.join('\n')}\n\nIMPORTANTE: Escreve a resposta final completa e limpa diretamente para o utilizador. NUNCA menciones esta validação interna, NUNCA digas "a minha resposta anterior" e NUNCA uses placeholders como {tabela} (inclui diretamente a tabela markdown devolvida pela ferramenta).`,
      });
      emit({ type: 'status', message: 'A corrigir verificação factual e numérica com os dados da farmácia...', step: stepNum });
      continue;
    }

    if (issues.length > 0) {
      tracer.markRuleFailed('VALIDACAO_FACTUAL_V2_PERSISTENTE');
      avisoValidacao = issues.join(' | ');
      finalText = `> ⚠️ **Aviso de validação automática:** ${avisoValidacao}\n\n${finalText}`;
    }

    break;
  }

  // Se o modelo deixou placeholders como {tabela} ou não incluiu a tabela gerada pela ferramenta `tabela`, injetar o markdown exato
  if (tabelasCollector.length > 0) {
    const tablesMd = tabelasCollector.map((t) => t.markdown).join('\n\n');
    if (/\{tabela\}|\[\[TABELA[^\]]*\]\]/i.test(finalText)) {
      finalText = finalText.replace(/\{tabela\}|\[\[TABELA[^\]]*\]\]/gi, tablesMd).trim();
    } else if (!finalText.includes('| --- |')) {
      finalText = `${finalText}\n\n${tablesMd}`.trim();
    }
  }

  // Atualizar histórico da sessão (apenas texto user/assistant limpo para o próximo turno)
  agentV2Sessions.set(scopedSessionId, [
    ...history.slice(-8),
    { role: 'user', content: question },
    { role: 'assistant', content: finalText },
  ]);

  const duracaoMs = Date.now() - startMs;
  const custoEstimadoEur = calculateClaudeCostEur(
    activeModel,
    totalIn,
    totalOut,
    totalCacheW,
    totalCacheR
  );

  tracer.persistAsync(prisma, {
    utilizadorId: (ctx as any).utilizadorId || null,
    perfil: ctx.perfil || 'SUPERADMIN',
    sessionId: scopedSessionId,
    modo: 'AGENT_V2',
    pergunta: question,
    intencao: 'AGENT_V2',
    parametros: { tools: toolsUsedNames, totalToolCalls, validationRetries },
    texto_referencias: finalText,
    texto_final: finalText,
    estado: 'ok',
    pergunta_de_volta: false,
    modelo_final: activeModel,
    tokens_in: totalIn,
    tokens_out: totalOut,
    tokens_cache_write: totalCacheW,
    tokens_cache_read: totalCacheR,
    custo_eur: custoEstimadoEur,
    duracao_ms: duracaoMs,
  });

  emit({ type: 'done', message: 'Resposta concluída.', tools: toolsUsedNames, step: stepNum });

  return {
    text: finalText,
    toolsUsed: toolsUsedNames,
    sessionId: scopedSessionId,
    interacaoId: tracer.interacaoId,
    tabelasRenderizadas: tabelasCollector,
    avisoValidacao,
    usage: {
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheCreationTokens: totalCacheW,
      cacheReadTokens: totalCacheR,
      custoEstimadoEur,
      duracaoMs,
      modelo: activeModel,
    },
  };
}
