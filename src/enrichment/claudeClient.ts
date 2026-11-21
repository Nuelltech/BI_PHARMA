// Chamada à API do Claude com pesquisa web + leitura de páginas (ferramentas de servidor)
// e saída estruturada pela ferramenta registar_perfil.
//
// Sem dependências: usa fetch nativo (Node 18+).
// IMPORTANTE: confirmar na documentação atual os nomes/versões das ferramentas
// web_search e web_fetch e o cabeçalho beta (ver config.ts).

import { config } from './config';
import { REGISTAR_PERFIL_TOOL, SYSTEM_PROMPT, mensagemProduto } from './prompt';
import type { Corpus, PerfilModelo, ProdutoAlvo } from './types';
import pdf from 'pdf-parse';

type Bloco = Record<string, any>;

export interface RespostaEnriquecimento {
  perfil: PerfilModelo | null;
  corpus: Corpus;
  uso: { input_tokens: number; output_tokens: number; web_search_requests: number; web_fetch_requests: number; chamadas: number };
}

async function chamarApi(messages: Bloco[]): Promise<Bloco> {
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    tools: [
      { type: config.webSearchToolType, name: 'web_search', max_uses: config.maxSearches, blocked_domains: config.blockedDomains },
      {
        type: config.webFetchToolType,
        name: 'web_fetch',
        max_uses: config.maxFetches,
        blocked_domains: config.blockedDomains,
        max_content_tokens: config.maxContentTokens,
      },
      REGISTAR_PERFIL_TOOL,
    ],
    messages,
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': config.webFetchBeta,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`API ${res.status}: ${txt.slice(0, 500)}`);
    (err as any).status = res.status;
    throw err;
  }
  return (await res.json()) as Bloco;
}

/** Recolhe recursivamente todo o texto devolvido pelas ferramentas de servidor + citações. */
export async function extrairCorpus(blocos: Bloco[], corpus: Corpus): Promise<void> {
  const partes: string[] = [];
  const pdfBuffers: Buffer[] = [];

  const visitar = (v: any, dentroDeFetch: boolean, urlAtual?: string) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => visitar(x, dentroDeFetch, urlAtual)); return; }
    if (typeof v !== 'object') return;

    const url = typeof v.url === 'string' ? v.url : urlAtual;
    if (typeof v.url === 'string') {
      (dentroDeFetch ? corpus.urlsLidas : corpus.urlsVistas).add(v.url);
    }
    // Documentos de texto devolvidos por web_fetch
    if (v.type === 'text' && typeof v.data === 'string' && dentroDeFetch) partes.push(v.data);
    if (v.media_type === 'text/plain' && typeof v.data === 'string') partes.push(v.data);
    // Documentos PDF devolvidos por web_fetch em base64
    if (v.media_type === 'application/pdf' && typeof v.data === 'string' && dentroDeFetch) {
      try { pdfBuffers.push(Buffer.from(v.data, 'base64')); } catch {}
    }
    // Texto citado (cited_text) — vem literalmente da fonte
    if (typeof v.cited_text === 'string') partes.push(v.cited_text);
    // Títulos e excertos simples
    if (typeof v.title === 'string') partes.push(v.title);
    if (typeof v.text === 'string' && dentroDeFetch) partes.push(v.text);

    for (const [k, val] of Object.entries(v)) {
      if (k === 'encrypted_content' || k === 'encrypted_index') continue; // conteúdo cifrado da pesquisa
      if (val && typeof val === 'object') visitar(val, dentroDeFetch, url);
    }
  };

  for (const b of blocos) {
    if (b.type === 'web_fetch_tool_result') visitar(b.content, true);
    else if (b.type === 'web_search_tool_result') visitar(b.content, false);
    else if (b.type === 'text' && Array.isArray(b.citations)) visitar(b.citations, false);
  }

  for (const buf of pdfBuffers) {
    try {
      const parsed = await pdf(buf);
      if (parsed?.text) partes.push(parsed.text);
    } catch {}
  }

  if (partes.length) corpus.texto += '\n' + partes.join('\n');
}

export async function enriquecerProduto(p: ProdutoAlvo): Promise<RespostaEnriquecimento> {
  const corpus: Corpus = { texto: '', urlsLidas: new Set(), urlsVistas: new Set() };
  const uso = { input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0, chamadas: 0 };
  const messages: Bloco[] = [{ role: 'user', content: mensagemProduto(p) }];

  for (let volta = 0; volta < 6; volta++) {
    const r = await chamarApi(messages);
    uso.chamadas++;
    uso.input_tokens += r.usage?.input_tokens ?? 0;
    uso.output_tokens += r.usage?.output_tokens ?? 0;
    uso.web_search_requests += r.usage?.server_tool_use?.web_search_requests ?? 0;
    uso.web_fetch_requests += r.usage?.server_tool_use?.web_fetch_requests ?? 0;

    const conteudo: Bloco[] = r.content ?? [];
    await extrairCorpus(conteudo, corpus);

    const chamada = conteudo.find((b) => b.type === 'tool_use' && b.name === 'registar_perfil');
    if (chamada) return { perfil: chamada.input as PerfilModelo, corpus, uso };

    if (r.stop_reason === 'pause_turn') {
      // Turno longo com ferramentas de servidor: continuar o mesmo turno.
      messages.push({ role: 'assistant', content: conteudo });
      continue;
    }
    // Terminou sem registar: pedir explicitamente o registo (uma vez).
    messages.push({ role: 'assistant', content: conteudo });
    messages.push({ role: 'user', content: 'Chama agora a ferramenta registar_perfil com o que encontraste (ou encontrado=false).' });
  }
  return { perfil: null, corpus, uso };
}
