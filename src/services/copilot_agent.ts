import { PrismaClient } from '@prisma/client';
import type { CopilotResponse } from './copilot';
import {
  CatalogItem,
  CatalogSearchParams,
  buildProductTableResponse,
  exploreVocabulary,
  getPharmacyCatalog,
  searchCatalog,
} from './product_catalog';

// ============================================================================
// COPILOT AGÊNTICO (CLAUDE + TOOL USE EM VÁRIOS PASSOS)
// ----------------------------------------------------------------------------
// A IA não inventa dados: interpreta a pergunta, explora como os produtos estão
// escritos no catálogo, pesquisa com filtros estruturados, revê os resultados
// (removendo falsos positivos) e entrega a seleção final de CNPs. Todos os
// números apresentados são calculados a partir do PostgreSQL.
// ============================================================================

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_STEPS = 5;
const MAX_ROWS_TO_LLM = 80;
const CALL_TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = `És o Copilot analítico de uma farmácia portuguesa. Respondes às perguntas do farmacêutico usando EXCLUSIVAMENTE as ferramentas disponíveis (dados reais da base de dados). Nunca inventes produtos, quantidades ou valores.

REGRAS:
1. Perguntas sobre produtos, gamas ou categorias (ex: "que perfumes temos", "eau de toilette em stock", "preservativos mais vendidos", "cremes de mãos com mais margem") → usa explorar_vocabulario e/ou pesquisar_produtos e termina SEMPRE com entregar_resposta.
2. As designações do catálogo vêm do Sifarma: abreviadas, muitas vezes em MAIÚSCULAS, misturam português/francês/inglês e omitem conectores (ex: "EAU TOILETTE" em vez de "Eau de Toilette", "Eau Parf", "PERFUME SPRAY", "Comp", "Cr", "Xpe", "Saq", "Cx"). Se não tiveres a certeza de como o conceito está escrito, chama primeiro explorar_vocabulario com várias variantes e marcas.
3. Em pesquisar_produtos usa grupos_termos: cada grupo é uma lista de variantes/sinónimos (basta uma coincidir) e TODOS os grupos têm de coincidir. Os termos coincidem com o início das palavras (ex: "perfum" apanha "PERFUME"; "toilet" apanha "TOILETTE"). Pensa em sinónimos, abreviaturas e marcas (ex: perfumes → ["perfum","parfum","eau toilette","eau parfum","edt","edp","colonia"]).
4. "temos", "em stock", "disponível", "o que há" → apenas_com_stock=true. "esgotado", "em falta", "rutura" → apenas_sem_stock=true. "mais vendidos" → ordenar_por="vendas"; "mais margem" → "margem"; "mais lucro/dinheiro" → "lucro".
5. Antes de entregar, REVÊ a lista: exclui falsos positivos que não correspondem à intenção do utilizador (ex: água termal "Avène Eau Thermal" não é perfume; "pérolas perfumadas" e repelentes "Perfume Protect" não são perfumes; "Nexium Control" não é um preservativo). Se a pesquisa ficou demasiado larga ou vazia, refaz com outros termos.
6. Para análises de gestão (eliminar laboratórios parados, ajustar stocks, aumento/crescimento de vendas nos últimos meses [analise_aumento_vendas], queda/quebra de vendas [analise_queda_vendas], substituição de produtos, campanhas sazonais, venda cruzada, melhor margem por DCI, trade-off volume/margem, comparar produtos, perfis clínicos, stock parado para cardíacos) usa diretamente a ferramenta analítica correspondente. Atenção: distingue sempre AUMENTO/SUBIDA de vendas (analise_aumento_vendas) de QUEDA/QUEBRA de vendas (analise_queda_vendas).
7. Em entregar_resposta, resposta_curta tem 1 a 3 frases em português de Portugal e responde diretamente à pergunta. Não escrevas totais numéricos — o sistema calcula-os e mostra-os.`;

const AGENT_TOOLS = [
  {
    name: 'explorar_vocabulario',
    description:
      'Mostra como um conceito está realmente escrito no catálogo da farmácia: para cada termo devolve nº de artigos, nº com stock, categorias e exemplos de designações reais. Usa para descobrir abreviaturas, idiomas e marcas antes de pesquisar.',
    input_schema: {
      type: 'object',
      properties: {
        termos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Variantes a testar (ex: ["eau de toilette","eau toilette","edt","toilette"])',
        },
      },
      required: ['termos'],
    },
  },
  {
    name: 'pesquisar_produtos',
    description:
      'Pesquisa artigos no catálogo da farmácia com filtros estruturados. Devolve CNP, designação, stock, vendas 12 meses, margem e segmento.',
    input_schema: {
      type: 'object',
      properties: {
        grupos_termos: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description:
            'Lista de grupos. Dentro de cada grupo basta UMA variante coincidir (OR); TODOS os grupos têm de coincidir (AND). Ex: [["eau toilette","edt","eau de toilette"]] ou [["creme","cr"],["maos","mao"]]',
        },
        excluir: { type: 'array', items: { type: 'string' }, description: 'Termos que excluem o artigo (ex: ["thermal","termal"])' },
        apenas_com_stock: { type: 'boolean', description: 'Só artigos com stock > 0' },
        apenas_sem_stock: { type: 'boolean', description: 'Só artigos esgotados (stock = 0)' },
        segmento: {
          type: 'string',
          enum: ['TODOS', 'SEM_RECEITA', 'VENDA_LIVRE', 'MNSRM', 'MSRM', 'GENERICO'],
          description: 'Filtro de estatuto/segmento',
        },
        categoria: { type: 'string', description: 'Texto a procurar na categoria interna (opcional)' },
        ordenar_por: { type: 'string', enum: ['vendas', 'lucro', 'margem', 'stock', 'faturacao', 'nome'] },
        limite: { type: 'number', description: 'Máximo de resultados (opcional)' },
      },
      required: ['grupos_termos'],
    },
  },
  {
    name: 'entregar_resposta',
    description:
      'Entrega a resposta final ao utilizador com a seleção de produtos relevantes. Usa usar_ultima_pesquisa=true para aceitar todos os resultados da última pesquisa (opcionalmente removendo falsos positivos em cnps_excluir) ou indica a lista explícita em cnps.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título curto da resposta (ex: "Eau de Toilette em stock")' },
        resposta_curta: { type: 'string', description: '1 a 3 frases que respondem diretamente à pergunta, sem totais numéricos' },
        usar_ultima_pesquisa: { type: 'boolean' },
        cnps_excluir: { type: 'array', items: { type: 'string' }, description: 'CNPs da última pesquisa a remover (falsos positivos)' },
        cnps: { type: 'array', items: { type: 'string' }, description: 'Lista explícita de CNPs a apresentar' },
        ordenar_por: { type: 'string', enum: ['vendas', 'lucro', 'margem', 'stock', 'faturacao', 'nome'] },
      },
      required: ['titulo', 'resposta_curta'],
    },
  },
];

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface AgentOptions {
  analyticTools: AnthropicTool[];
  executeAnalyticTool: (toolName: string, input: Record<string, any>) => Promise<CopilotResponse | null>;
}

async function callClaude(apiKey: string, messages: any[], tools: AnthropicTool[], toolChoice: any) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0,
        system: SYSTEM_PROMPT,
        tools,
        tool_choice: toolChoice,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${(await res.text()).substring(0, 300)}`);
    }
    return (await res.json()) as any;
  } finally {
    clearTimeout(timeout);
  }
}

function describeParams(p: CatalogSearchParams): string {
  const parts: string[] = [];
  if (p.grupos_termos?.length) parts.push(p.grupos_termos.map((g) => `(${g.join(' | ')})`).join(' E '));
  if (p.excluir?.length) parts.push(`excluir: ${p.excluir.join(', ')}`);
  if (p.apenas_com_stock) parts.push('só com stock');
  if (p.apenas_sem_stock) parts.push('só esgotados');
  if (p.segmento && p.segmento !== 'TODOS') parts.push(`segmento ${p.segmento}`);
  if (p.categoria) parts.push(`categoria "${p.categoria}"`);
  return parts.join('; ');
}

function formatRowsForLlm(rows: CatalogItem[]): string {
  const shown = rows.slice(0, MAX_ROWS_TO_LLM);
  const lines = shown.map(
    (r) =>
      `${r.cnp} | ${r.designacao.substring(0, 70)} | stock ${r.stock} | vend12m ${r.vendasQtd} | margem ${r.margem.toFixed(0)}% | ${r.ehGenerico ? 'GENERICO' : r.tipoVenda}`
  );
  const header = `${rows.length} artigos encontrados${rows.length > MAX_ROWS_TO_LLM ? ` (a mostrar os primeiros ${MAX_ROWS_TO_LLM}; considera refinar)` : ''}:`;
  return [header, ...lines].join('\n');
}

/**
 * Executa o ciclo agêntico. Devolve null se a IA falhar (o chamador usa o motor local).
 */
export async function runCopilotAgent(
  prisma: PrismaClient,
  farmaciaId: string,
  question: string,
  apiKey: string,
  opts: AgentOptions
): Promise<CopilotResponse | null> {
  const catalog = await getPharmacyCatalog(prisma, farmaciaId);
  const byCnp = new Map(catalog.map((c) => [c.cnp, c]));
  const analyticNames = new Set(opts.analyticTools.map((t) => t.name));
  const tools = [...AGENT_TOOLS, ...opts.analyticTools];

  const messages: any[] = [{ role: 'user', content: question }];
  const trace: string[] = [];
  let tokens = 0;
  let lastRows: CatalogItem[] = [];
  let lastParams: CatalogSearchParams | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const isLast = step === MAX_STEPS - 1;
    const toolChoice = isLast && lastParams ? { type: 'tool', name: 'entregar_resposta' } : { type: 'any' };

    const data = await callClaude(apiKey, messages, tools, toolChoice);
    tokens += (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    const toolUses = (data.content || []).filter((c: any) => c.type === 'tool_use');
    if (toolUses.length === 0) break;
    messages.push({ role: 'assistant', content: data.content });

    const toolResults: any[] = [];

    for (const tu of toolUses) {
      const input = tu.input || {};

      // 1. Ferramentas analíticas de gestão → resposta direta
      if (analyticNames.has(tu.name)) {
        trace.push(`${tu.name}`);
        const resp = await opts.executeAnalyticTool(tu.name, input);
        if (resp) return attachAgentBadge(resp, trace, tokens);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Sem resultados para esta análise.' });
        continue;
      }

      // 2. Exploração de vocabulário
      if (tu.name === 'explorar_vocabulario') {
        const termos: string[] = (input.termos || []).slice(0, 8);
        trace.push(`explorar_vocabulario(${termos.join(', ')})`);
        const voc = exploreVocabulary(catalog, termos);
        const txt = voc
          .map(
            (v) =>
              `"${v.termo}": ${v.total} artigos (${v.com_stock} com stock). Categorias: ${v.categorias.join('; ') || '-'}\n  Exemplos: ${v.exemplos.join(' || ') || '(nenhum)'}`
          )
          .join('\n');
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: txt });
        continue;
      }

      // 3. Pesquisa estruturada
      if (tu.name === 'pesquisar_produtos') {
        const params: CatalogSearchParams = {
          grupos_termos: input.grupos_termos,
          excluir: input.excluir,
          apenas_com_stock: !!input.apenas_com_stock,
          apenas_sem_stock: !!input.apenas_sem_stock,
          segmento: input.segmento,
          categoria: input.categoria,
          ordenar_por: input.ordenar_por,
          limite: input.limite,
        };
        lastParams = params;
        lastRows = searchCatalog(catalog, params);
        trace.push(`pesquisar_produtos(${describeParams(params)}) → ${lastRows.length}`);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: formatRowsForLlm(lastRows) });
        continue;
      }

      // 4. Resposta final
      if (tu.name === 'entregar_resposta') {
        let rows: CatalogItem[] = [];
        if (Array.isArray(input.cnps) && input.cnps.length > 0) {
          rows = input.cnps.map((c: string) => byCnp.get(String(c).trim())).filter(Boolean) as CatalogItem[];
        } else {
          const excl = new Set((input.cnps_excluir || []).map((c: string) => String(c).trim()));
          rows = lastRows.filter((r) => !excl.has(r.cnp));
        }

        const ord = input.ordenar_por || lastParams?.ordenar_por || (lastParams?.apenas_com_stock ? 'stock' : 'vendas');
        rows = searchCatalog(rows, { ordenar_por: ord });
        const removidos = lastRows.length - rows.length;
        trace.push(`entregar_resposta(${rows.length} selecionados${removidos > 0 ? `, ${removidos} falsos positivos removidos` : ''})`);

        const totalStock = rows.reduce((s, r) => s + r.stock, 0);
        const resp = buildProductTableResponse(rows, {
          titulo: `${input.titulo || 'Resultado'} — ${rows.length} referências · ${totalStock} un em stock`,
          explicacao: `${input.resposta_curta || ''}${lastParams ? `\n\nCritério aplicado: ${describeParams(lastParams)}.` : ''}`,
        });
        return attachAgentBadge(resp, trace, tokens);
      }

      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Ferramenta desconhecida.', is_error: true });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Se a IA não entregou explicitamente, apresentar a última pesquisa
  if (lastParams) {
    trace.push('entrega automática da última pesquisa');
    const resp = buildProductTableResponse(lastRows, {
      titulo: `Resultado da pesquisa — ${lastRows.length} referências`,
      explicacao: `Critério aplicado: ${describeParams(lastParams)}.`,
    });
    return attachAgentBadge(resp, trace, tokens);
  }
  return null;
}

function attachAgentBadge(resp: CopilotResponse, trace: string[], tokens: number): CopilotResponse {
  const badge = `🤖 <b>Interpretado por IA (Claude):</b> ${trace.length} passo(s) — ${trace.join(' → ')} (${tokens} tokens). Os valores vêm diretamente da base de dados PostgreSQL.`;
  resp.resumoEstrategico = resp.resumoEstrategico ? `${resp.resumoEstrategico}\n\n${badge}` : badge;
  return resp;
}
