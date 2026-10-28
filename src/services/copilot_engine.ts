import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();

import {
  ToolSecurityContext,
  toolCalcularStockMinimoECobertura,
  toolFiltrarValidadeEMargem,
  toolSugerirPacksPromocionais,
  toolIdentificarProdutosSemVenda,
  toolConsolidarGenericosDci,
  toolPlanearComprasSazonais,
  toolSugerirVendasCruzadasReceita,
  toolConsultarProdutosPorNomeOuCategoria,
} from './mcp_pharma_tools.js';

// ============================================================================
// MOTOR CONVERSACIONAL COPILOT C/ MEMÓRIA E TOOL-CALLING MULTI-TENANT
// ----------------------------------------------------------------------------
// Suporta conversas encadeadas por sessão com Claude 3.5 / 4.5 / 5.5
// Garante que todas as ferramentas operam estritamente dentro da farmácia autenticada.
// ============================================================================

// Memória de sessão em RAM: sessionId -> Array de mensagens
const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: any }>>();

// Limpa sessões com mais de 3 horas para libertar memória
const sessionTimestamps = new Map<string, number>();

function pruneOldSessions() {
  const now = Date.now();
  const maxAge = 3 * 60 * 60 * 1000;
  for (const [id, ts] of sessionTimestamps.entries()) {
    if (now - ts > maxAge) {
      sessionHistory.delete(id);
      sessionTimestamps.delete(id);
    }
  }
}

export function clearCopilotSession(sessionId: string) {
  sessionHistory.delete(sessionId);
  sessionTimestamps.delete(sessionId);
}

const COPILOT_TOOLS = [
  {
    name: 'consultar_produtos_por_nome_ou_categoria',
    description:
      'Pesquisa e detalha produtos da farmácia por nome comercial, marca, substância DCI, código CNP ou categoria (ex: "ben-u-gripe", "cegripe", "antigripais", "brufen", "preservativos", "vitamina c"). Devolve stock atual, vendas nos últimos 12 meses, VMM, dias e meses de cobertura, margem comercial e um diagnóstico direto sobre se se deve ou não encomendar.',
    input_schema: {
      type: 'object',
      properties: {
        termo_pesquisa: {
          type: 'string',
          description:
            'Nome do produto, marca, categoria ou código CNP a pesquisar (ex: "ben-u-gripe", "cegripe", "antigripais", "preservativos", "brufen")',
        },
        apenas_com_stock: {
          type: 'boolean',
          description: 'Filtrar apenas produtos que têm stock físico > 0 na farmácia',
        },
        limite: { type: 'number', description: 'Número máximo de registos a devolver (default 20)' },
      },
      required: ['termo_pesquisa'],
    },
  },
  {
    name: 'calcular_stock_minimo_e_cobertura',
    description:
      'Calcula o stock mínimo necessário e os dias de cobertura para um período pretendido (ex: 7 dias / 1 semana). Identifica produtos abaixo do mínimo (risco de rutura) e produtos em excesso.',
    input_schema: {
      type: 'object',
      properties: {
        dias_cobertura_desejados: {
          type: 'number',
          description: 'Número de dias de cobertura pretendidos (default 7 para 1 semana)',
        },
        apenas_abaixo_minimo: {
          type: 'boolean',
          description: 'Filtrar apenas artigos com stock abaixo do mínimo sugerido',
        },
        termo_pesquisa: {
          type: 'string',
          description: 'Filtro opcional por nome ou código do produto',
        },
        limite: { type: 'number', description: 'Número máximo de registos (default 25)' },
      },
    },
  },
  {
    name: 'filtrar_produtos_por_validade_e_margem',
    description:
      'Filtra produtos com data de validade até um determinado ano (ex: 2027) e simula o PVP promocional mínimo garantindo que a margem comercial não fica abaixo do limiar (ex: 10%), respeitando o anti-dumping.',
    input_schema: {
      type: 'object',
      properties: {
        ano_limite_validade: {
          type: 'number',
          description: 'Ano limite de validade a pesquisar (ex: 2027)',
        },
        margem_minima_pct: {
          type: 'number',
          description: 'Margem de lucro mínima tolerada em % (ex: 10.0)',
        },
        apenas_venda_livre: {
          type: 'boolean',
          description: 'Filtrar apenas produtos de venda livre / balcão (default true)',
        },
        limite: { type: 'number', description: 'Número máximo de registos (default 30)' },
      },
    },
  },
  {
    name: 'sugerir_packs_promocionais',
    description:
      'Cria e sugere packs promocionais de 2 a 3 produtos onde a margem global do pack e dos artigos cumpre o mínimo definido (ex: 5%), indicando PVP normal, PVP promocional e poupança do cliente.',
    input_schema: {
      type: 'object',
      properties: {
        tamanho_pack: {
          type: 'number',
          description: 'Número de artigos por pack (2 ou 3)',
        },
        margem_minima_pack_pct: {
          type: 'number',
          description: 'Margem mínima garantida do pack em % (ex: 5.0)',
        },
        ano_limite_validade: {
          type: 'number',
          description: 'Ano limite de validade para escoar nos packs (default 2027)',
        },
        limite: { type: 'number', description: 'Número de packs a sugerir' },
      },
    },
  },
  {
    name: 'identificar_produtos_sem_vendas_e_escoamento',
    description:
      'Lista produtos que têm stock parado na farmácia sem qualquer venda nos últimos N meses (ex: 6 meses), sugerindo a estratégia de escoamento correta (troca de laboratório no Sifarma, dispensa prioritária na gaveta ou pack de balcão).',
    input_schema: {
      type: 'object',
      properties: {
        meses_sem_venda: {
          type: 'number',
          description: 'Número de meses sem vendas a considerar (default 6)',
        },
        apenas_com_stock: {
          type: 'boolean',
          description: 'Considerar apenas produtos com unidades físicas em armazém (default true)',
        },
        limite: { type: 'number', description: 'Número máximo de registos (default 30)' },
      },
    },
  },
  {
    name: 'analisar_consolidacao_genericos_dci',
    description:
      'Analisa a dispersão de laboratórios para a mesma substância ativa e dosagem (DCI). Compara com o número máximo de laboratórios pretendido e indica quais as marcas residuais no fundo da gaveta que devem ser esgotadas antes de encomendar novo stock.',
    input_schema: {
      type: 'object',
      properties: {
        molecula_dci: {
          type: 'string',
          description: 'Filtrar por molécula específica (opcional, ex: Atorvastatina, Paracetamol, etc.)',
        },
        max_labs_desejados: {
          type: 'number',
          description: 'Número máximo de laboratórios que a farmácia pretende manter abertos (default 2)',
        },
        limite: { type: 'number', description: 'Máximo de grupos DCI a devolver' },
      },
    },
  },
  {
    name: 'planear_compras_sazonais_laboratorio',
    description:
      'Gera o plano anual de compras diretas a laboratórios baseado no histórico de vendas e sazonalidade da farmácia, indicando as datas recomendadas de encomenda e as datas ideais de entrega física.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_venda: {
          type: 'string',
          description: 'Segmento a analisar (default VENDA_LIVRE)',
        },
        ano_referencia: {
          type: 'number',
          description: 'Ano de referência para planeamento',
        },
      },
    },
  },
  {
    name: 'sugerir_vendas_cruzadas_receita',
    description:
      'Para as moléculas sujeitas a receita médica (MSRM) mais vendidas na farmácia, sugere produtos complementares de venda livre e aconselhamento de balcão para prevenir efeitos adversos e melhorar o cuidado ao utente.',
    input_schema: {
      type: 'object',
      properties: {
        top_n_moleculas: {
          type: 'number',
          description: 'Número de moléculas mais vendidas a analisar (default 5)',
        },
      },
    },
  },
];

const SYSTEM_PROMPT = `És o Consultor Farmacêutico & Copilot Analítico da Farmácia.
A tua missão é apoiar o Diretor Técnico e o Gestor da Farmácia a tomar decisões financeiras, operacionais e clínicas inteligentes com base EXCLUSIVAMENTE nos dados reais da farmácia.

DIRETRIZES DE COMUNICAÇÃO:
1. Sê claro, rigoroso e profissional. Responde em Português de Portugal com terminologia farmacêutica correta (Sifarma, DCI, MSRM, MNSRM, PVP, Margem, Cobertura, etc.).
2. FLEXIBILIDADE DE FORMATO:
   - Se o utilizador pedir TAREFAS ou PLANO DE AÇÃO: formata em caixas de seleção interativas (\`- [ ] Tarefa\`), divididas por área (Balcão, Gaveta, Compras).
   - Se pedir DADOS NUMÉRICOS OU LISTAGENS: cria tabelas Markdown limpas e organizadas.
   - Se pedir ESTRATÉGIA ou PARECER: escreve um parecer executivo estruturado com introdução, passos práticos e justificação financeira.
3. CONVERSAÇÃO ENCADEADA (MEMÓRIA):
   - Lembra-te do que foi falado anteriormente na sessão. Se o utilizador disser "E desses produtos, cria um plano..." ou "Desses, filtra os que têm...", refere-te aos produtos identificados na resposta anterior.
4. RIGOR DOS DADOS (TOOL USE):
   - Usa SEMPRE as ferramentas disponíveis para obter os números reais. Nunca inventes quantidades de stock, nem vendas, nem margens fictícias.
   - Explica o porquê dos cálculos (ex: "Stock mínimo calculado com base na Venda Média Mensal de 30 dias com margem de segurança de 20%").
5. PESQUISA ESPECÍFICA DE PRODUTOS OU CATEGORIAS:
   - Sempre que o utilizador perguntar sobre produtos específicos (ex: "ben-u-gripe", "cegripe", "brufen", "forxiga", etc.) ou sobre uma categoria/família (ex: "antigripais", "preservativos", etc.), deves OBRIGATORIAMENTE chamar a ferramenta 'consultar_produtos_por_nome_ou_categoria'.
   - NUNCA digas que não tens ferramentas para pesquisar por nome ou categoria.
   - NUNCA peças ao utilizador dados manuais (stock, vendas, custo, validade) nem o mandes consultar o Sifarma quando podes obter esses dados automaticamente da base de dados com as tuas ferramentas.
   - Ao responder, apresenta a comparação de stock vs vendas e cobertura de cada artigo, dizendo explicitamente se vale a pena encomendar ou se há excesso de stock (ex: se tem 49 caixas para 1 venda/mês, são 49 meses de stock = NÃO encomendar!).`;

export async function askConversationalCopilot(
  prisma: PrismaClient,
  secContext: ToolSecurityContext,
  question: string,
  sessionId = 'default'
): Promise<{ text: string; toolsUsed: string[]; sessionId: string }> {
  pruneOldSessions();
  sessionTimestamps.set(sessionId, Date.now());

  let history = sessionHistory.get(sessionId);
  if (!history) {
    history = [];
    sessionHistory.set(sessionId, history);
  }

  // Adiciona a nova mensagem do utilizador
  history.push({ role: 'user', content: question });

  // Mantém apenas as últimas 12 mensagens para contexto equilibrado
  if (history.length > 12) {
    history = history.slice(-12);
    sessionHistory.set(sessionId, history);
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const toolsUsed: string[] = [];

  // Se não houver chave Anthropic válida, devolve resposta formatada local de fallback
  if (!apiKey) {
    return {
      text: `⚠️ **Modo Offline:** Configure a chave \`ANTHROPIC_API_KEY\` para ativar o raciocínio conversacional livre com Claude.`,
      toolsUsed: [],
      sessionId,
    };
  }

  // Modelos suportados na conta (preferindo haiku 4.5 ou sonnet 4.5)
  const model = 'claude-haiku-4-5-20251001';

  try {
    let currentMessages = [...history];
    let maxSteps = 4;

    while (maxSteps > 0) {
      maxSteps--;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: `${SYSTEM_PROMPT}\n\nFarmácia Ativa: ${secContext.farmaciaNome} (NIF: ${secContext.nif})`,
          tools: COPILOT_TOOLS,
          tool_choice: { type: 'auto' },
          messages: currentMessages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Copilot Engine] Erro na API Claude:', response.status, errText);
        throw new Error(`Erro na API Claude (${response.status})`);
      }

      const data = (await response.json()) as any;
      const content = data.content || [];

      // Verifica se a LLM pediu para executar ferramentas
      const toolUseCalls = content.filter((c: any) => c.type === 'tool_use');

      if (toolUseCalls.length === 0) {
        // Resposta final de texto
        const textBlocks = content.filter((c: any) => c.type === 'text');
        const finalText = textBlocks.map((b: any) => b.text).join('\n\n');

        // Guarda a resposta final no histórico
        history.push({ role: 'assistant', content: finalText });
        sessionHistory.set(sessionId, history);

        return {
          text: finalText,
          toolsUsed,
          sessionId,
        };
      }

      // Adiciona a resposta do assistente (com os tool_use) às mensagens da iteração
      currentMessages.push({ role: 'assistant', content });

      // Executa cada ferramenta com o contexto DE SEGURANÇA da farmácia
      const toolResults = [];

      for (const call of toolUseCalls) {
        toolsUsed.push(call.name);
        const args = call.input || {};
        let resultData: any;

        try {
          switch (call.name) {
            case 'calcular_stock_minimo_e_cobertura':
              resultData = await toolCalcularStockMinimoECobertura(prisma, secContext, args);
              break;

            case 'filtrar_produtos_por_validade_e_margem':
              resultData = await toolFiltrarValidadeEMargem(prisma, secContext, args);
              break;

            case 'sugerir_packs_promocionais':
              resultData = await toolSugerirPacksPromocionais(prisma, secContext, args);
              break;

            case 'identificar_produtos_sem_vendas_e_escoamento':
              resultData = await toolIdentificarProdutosSemVenda(prisma, secContext, args);
              break;

            case 'analisar_consolidacao_genericos_dci':
              resultData = await toolConsolidarGenericosDci(prisma, secContext, args);
              break;

            case 'planear_compras_sazonais_laboratorio':
              resultData = await toolPlanearComprasSazonais(prisma, secContext, args);
              break;

            case 'sugerir_vendas_cruzadas_receita':
              resultData = await toolSugerirVendasCruzadasReceita(prisma, secContext, args);
              break;

            case 'consultar_produtos_por_nome_ou_categoria':
              resultData = await toolConsultarProdutosPorNomeOuCategoria(prisma, secContext, args);
              break;

            default:
              resultData = { error: `Ferramenta desconhecida: ${call.name}` };
          }
        } catch (e: any) {
          resultData = { error: `Erro na execução da ferramenta: ${e.message}` };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(resultData),
        });
      }

      // Devolve os resultados das ferramentas ao Claude
      currentMessages.push({
        role: 'user',
        content: toolResults,
      });
    }

    // Se esgotou os passos sem resposta final de texto
    return {
      text: 'Foram analisados os dados da farmácia, mas a resposta excedeu o limite de passos. Por favor tente especificar mais a sua pergunta.',
      toolsUsed,
      sessionId,
    };
  } catch (err: any) {
    console.error('[Copilot Engine Error]:', err.message);
    return {
      text: `❌ Ocorreu um erro ao comunicar com a inteligência analítica: ${err.message}`,
      toolsUsed,
      sessionId,
    };
  }
}
