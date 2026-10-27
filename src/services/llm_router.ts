import { PrismaClient } from '@prisma/client';
import {
  CopilotResponse,
  analyzeLaboratoryElimination,
  analyzeStockAdjustment,
  analyzeClinicalCrossSelling,
  analyzeConditionRecommendations,
  analyzeSafeDeadStockForSeniorCardiac,
  analyzeSeasonalCampaign,
  analyzeSalesDropoff,
  analyzeSalesGrowth,
  analyzeProductSubstitution,
  compareProductsDirectly,
  analyzeBestMarginByDci,
  analyzeMarginVolumeTradeoff,
  analyzeFlexiblePharmaSearch,
  processFreeformQuestion,
} from './copilot';
import { runCopilotAgent } from './copilot_agent';

/**
 * Ferramentas (Tools) expostas à LLM para Function Calling
 */
const PHARMA_TOOLS = [
  {
    name: 'eliminar_laboratorios_inativos',
    description: 'Racionalizar e eliminar laboratórios duplicados de genéricos que têm stock mas zero vendas há X dias (default 90 dias ou 3 meses) para a mesma substância ativa e dosagem DCI.',
    input_schema: {
      type: 'object',
      properties: {
        dias_sem_venda: { type: 'number', description: 'Número de dias sem vendas (default 90)' },
      },
    },
  },
  {
    name: 'ajustar_stocks',
    description: 'Auditar e otimizar parâmetros de stock: excessos de cobertura (>4 meses), monos sem vendas e riscos de rutura.',
    input_schema: {
      type: 'object',
      properties: {
        limite_cobertura: { type: 'number', description: 'Limite de cobertura em meses (default 4)' },
        periodo_monos: { type: 'number', description: 'Dias para considerar mono (default 90)' },
      },
    },
  },
  {
    name: 'venda_cruzada_artigo',
    description: 'Sugerir produtos de venda livre ou co-prescrições para venda cruzada (cross-selling) a partir de um artigo de referência (ex: Vitativ Transilax, Laxante, Ibuprofeno, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        produto_referencia: { type: 'string', description: 'Nome ou CNP do produto de referência' },
      },
      required: ['produto_referencia'],
    },
  },
  {
    name: 'recomendacao_perfil_clinico',
    description: 'Aconselhar produtos de venda livre em stock para um perfil clínico específico (ex: diabéticos, hipertensos).',
    input_schema: {
      type: 'object',
      properties: {
        perfil: { type: 'string', description: 'Perfil clínico ou patologia (ex: diabeticos, hipertensos)' },
      },
      required: ['perfil'],
    },
  },
  {
    name: 'stock_parado_seguro_cardiaco',
    description: 'Filtrar artigos de stock parado (monos) que sejam estritamente seguros e benéficos para idosos com problemas cardíacos (excluindo descongestionantes orais com pseudoefedrina e AINEs que sobem a tensão arterial).',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'campanha_sazonal',
    description: 'Criar proposta de campanha comercial/promocional para uma categoria de produtos e época específica (ex: cosmética em Dezembro/Natal, suplementos de inverno, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Categoria de produtos (ex: cosmetica, cremes, suplementos)' },
        epoca: { type: 'string', description: 'Época ou mês da campanha (ex: Dezembro, Natal, Inverno)' },
      },
    },
  },
  {
    name: 'analise_aumento_vendas',
    description:
      'Detetar e analisar os produtos que tiveram um AUMENTO, subida, crescimento, aceleração ou disparo de vendas nos últimos N meses (ex: últimos 2 meses, último mês, último trimestre), calculando a variação percentual face ao ritmo anterior e o risco de rutura ao novo ritmo de procura.',
    input_schema: {
      type: 'object',
      properties: {
        meses_recentes: {
          type: 'number',
          description: 'Número de meses recentes a analisar (ex: 1, 2, 3, 6). Por defeito: 2',
        },
        termo: {
          type: 'string',
          description: 'Filtro opcional de produto, categoria ou princípio ativo (ex: antigripal, creme, paracetamol)',
        },
        segmento: {
          type: 'string',
          enum: ['TODOS', 'SEM_RECEITA', 'VENDA_LIVRE', 'MNSRM', 'MSRM', 'GENERICO'],
          description: 'Filtro opcional de estatuto/segmento',
        },
      },
    },
  },
  {
    name: 'analise_queda_vendas',
    description:
      'Detetar e diagnosticar produtos com QUEDA, quebra acentuada ou perda de vendas recente (>55%), distinguindo rutura de stock físico de canibalização por genéricos ou perda de prescrição.',
    input_schema: {
      type: 'object',
      properties: {
        meses_recentes: {
          type: 'number',
          description: 'Número opcional de meses recentes a comparar (ex: 2, 3, 6)',
        },
        termo: {
          type: 'string',
          description: 'Filtro opcional de produto, categoria ou princípio ativo',
        },
        segmento: {
          type: 'string',
          enum: ['TODOS', 'SEM_RECEITA', 'VENDA_LIVRE', 'MNSRM', 'MSRM', 'GENERICO'],
          description: 'Filtro opcional de estatuto/segmento',
        },
      },
    },
  },
  {
    name: 'substituicao_produtos',
    description: 'Detetar se algum produto veio substituir outro ao longo do tempo (handover temporal de vendas no mesmo grupo DCI).',
    input_schema: {
      type: 'object',
      properties: {
        produto: { type: 'string', description: 'Nome opcional do produto antigo ou novo a auditar' },
      },
    },
  },
  {
    name: 'tradeoff_volume_margem',
    description: 'Analisar o dilema comercial entre manter ou desistir de um produto com alta margem e poucas vendas versus outro com baixa margem e muitas vendas, calculando a Massa de Margem Bruta Total em Euros.',
    input_schema: {
      type: 'object',
      properties: {
        termos_produtos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nomes dos produtos a comparar no trade-off',
        },
      },
    },
  },
  {
    name: 'melhor_margem_dci',
    description: 'Identificar qual o laboratório ou apresentação de uma substância ativa/DCI que dá mais margem percentual e lucro bruto por embalagem à farmácia.',
    input_schema: {
      type: 'object',
      properties: {
        dci: { type: 'string', description: 'Nome do princípio ativo DCI (ex: Paracetamol, Ibuprofeno, Omeprazol)' },
      },
    },
  },
  {
    name: 'comparar_produtos',
    description: 'Comparar diretamente 2 a 4 produtos lado a lado em vendas, margem, custo, PVP e stock.',
    input_schema: {
      type: 'object',
      properties: {
        produtos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de nomes ou códigos CNP dos produtos a comparar',
        },
      },
      required: ['produtos'],
    },
  },
  {
    name: 'pesquisa_produtos',
    description: 'Pesquisar produtos na farmácia por nome, classe terapêutica, apresentação ou forma farmacêutica (ex: preservativos mais vendidos, xaropes, cremes hidratantes).',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Termo central de pesquisa (ex: preservativo, creme, xarope, fralda)' },
        ordenar_por: {
          type: 'string',
          enum: ['vendas', 'lucro', 'margem', 'stock'],
          description: 'Critério de ordenação dos resultados',
        },
      },
      required: ['termo'],
    },
  },
];

/**
 * Consulta a LLM (Anthropic Claude) para mapear a pergunta livre para uma ferramenta analítica
 */
export async function routeQuestionWithLlm(
  question: string,
  apiKey: string
): Promise<{ toolName: string; input: Record<string, any>; tokensUsed: number } | null> {
  const model = 'claude-haiku-4-5-20251001';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000); // 7 segundos de timeout

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        temperature: 0.1,
        system:
          'És o router analítico do Assistente Consultivo de Farmácia. A tua ÚNICA tarefa é analisar a pergunta do farmacêutico e invocar a ferramenta correspondente com os parâmetros extraídos. NÃO inventes dados da farmácia.',
        tools: PHARMA_TOOLS,
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: question }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[LLM Router] Resposta não OK (${res.status}):`, await res.text());
      return null;
    }

    const data = (await res.json()) as any;
    const toolBlock = data.content?.find((c: any) => c.type === 'tool_use');

    if (!toolBlock) {
      console.warn('[LLM Router] Nenhum tool_use devolvido pelo modelo');
      return null;
    }

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    return {
      toolName: toolBlock.name,
      input: toolBlock.input || {},
      tokensUsed: inputTokens + outputTokens,
    };
  } catch (err: any) {
    console.warn('[LLM Router] Erro na chamada à API:', err.message);
    return null;
  }
}

/**
 * Executa a ferramenta mapeada pela LLM contra a base de dados PostgreSQL
 */
export async function executeLlmRoutedTool(
  prisma: PrismaClient,
  farmaciaId: string,
  toolName: string,
  input: Record<string, any>,
  options?: { diasMonos?: number; cobertura?: number }
): Promise<CopilotResponse | null> {
  switch (toolName) {
    case 'eliminar_laboratorios_inativos': {
      const dias = input.dias_sem_venda || options?.diasMonos || 90;
      return analyzeLaboratoryElimination(prisma, farmaciaId, dias);
    }

    case 'ajustar_stocks': {
      return analyzeStockAdjustment(prisma, farmaciaId, {
        limiteCobertura: input.limite_cobertura || options?.cobertura,
        periodoMonos: input.periodo_monos || options?.diasMonos,
      });
    }

    case 'venda_cruzada_artigo': {
      return analyzeClinicalCrossSelling(prisma, farmaciaId, input.produto_referencia || 'transilax');
    }

    case 'recomendacao_perfil_clinico': {
      return analyzeConditionRecommendations(prisma, farmaciaId, input.perfil || 'diabeticos');
    }

    case 'stock_parado_seguro_cardiaco': {
      return analyzeSafeDeadStockForSeniorCardiac(prisma, farmaciaId);
    }

    case 'campanha_sazonal': {
      return analyzeSeasonalCampaign(
        prisma,
        farmaciaId,
        input.categoria || 'cosmet',
        input.epoca || 'Dezembro / Natal'
      );
    }

    case 'analise_aumento_vendas': {
      return analyzeSalesGrowth(prisma, farmaciaId, {
        mesesRecentes: input.meses_recentes || 2,
        termoFiltro: input.termo,
        segmento: input.segmento,
      });
    }

    case 'analise_queda_vendas': {
      return analyzeSalesDropoff(prisma, farmaciaId, {
        mesesRecentes: input.meses_recentes,
        termoFiltro: input.termo,
        segmento: input.segmento,
      });
    }

    case 'substituicao_produtos': {
      return analyzeProductSubstitution(prisma, farmaciaId, input.produto);
    }

    case 'tradeoff_volume_margem': {
      return analyzeMarginVolumeTradeoff(prisma, farmaciaId, input.termos_produtos || []);
    }

    case 'melhor_margem_dci': {
      return analyzeBestMarginByDci(prisma, farmaciaId, input.dci || 'Paracetamol');
    }

    case 'comparar_produtos': {
      return compareProductsDirectly(prisma, farmaciaId, input.produtos || []);
    }

    case 'pesquisa_produtos': {
      return analyzeFlexiblePharmaSearch(prisma, farmaciaId, input.termo, {
        sortBy: input.ordenar_por || 'vendas',
      });
    }

    default:
      return null;
  }
}

/**
 * Ponto de entrada híbrido inteligente:
 * 1. Se ANTHROPIC_API_KEY existir, tenta mapear por LLM Function Calling (~150 tokens)
 * 2. Se a LLM falhar ou não estiver configurada, executa o motor semântico/lematizador local
 */
export async function processQuestionWithLlmOrLocal(
  prisma: PrismaClient,
  farmaciaId: string,
  question: string,
  options?: { diasMonos?: number; cobertura?: number }
): Promise<CopilotResponse | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (apiKey) {
    // 1. Modo agêntico: a IA explora o catálogo, pesquisa com filtros, revê e seleciona
    try {
      console.log(`[Copilot] A interpretar pergunta com agente IA (Claude Haiku, multi-passo)...`);
      const agentResp = await runCopilotAgent(prisma, farmaciaId, question, apiKey, {
        analyticTools: PHARMA_TOOLS.filter((t) => t.name !== 'pesquisa_produtos') as any,
        executeAnalyticTool: (toolName, input) => executeLlmRoutedTool(prisma, farmaciaId, toolName, input, options),
      });
      if (agentResp) return agentResp;
    } catch (err: any) {
      console.warn('[Copilot] Agente IA falhou, a tentar router simples:', err.message);
    }

    // 2. Router simples (1 chamada) como segunda linha
    const route = await routeQuestionWithLlm(question, apiKey);

    if (route) {
      console.log(`[Copilot] ✅ LLM mapeou para ferramenta: "${route.toolName}" com ${route.tokensUsed} tokens consumidos.`);
      if (route.toolName === 'pesquisa_produtos') {
        route.input.termo = question;
      }
      const response = await executeLlmRoutedTool(prisma, farmaciaId, route.toolName, route.input, options);

      if (response) {
        const badgeLlm = `🤖 <b>Interpretado por IA (Claude):</b> Intenção mapeada para <code>${route.toolName}</code> (${route.tokensUsed} tokens consumidos). Dados calculados em tempo real na base de dados PostgreSQL.`;
        response.resumoEstrategico = response.resumoEstrategico
          ? `${response.resumoEstrategico}\n\n${badgeLlm}`
          : badgeLlm;
        return response;
      }
    } else {
      console.log(`[Copilot] ⚡ Fallback para motor semântico local...`);
    }
  }

  // Fallback local garantido
  return processFreeformQuestion(prisma, farmaciaId, question, options);
}
