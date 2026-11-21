import 'dotenv/config';

// Configuração do enriquecimento. Tudo por variáveis de ambiente.
export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  // Usar o mesmo modelo que já funciona no copilot; pode ser trocado por env.
  model: process.env.ENRICH_MODEL ?? 'claude-sonnet-4-5',
  maxTokens: Number(process.env.ENRICH_MAX_TOKENS ?? 4096),
  maxSearches: Number(process.env.ENRICH_MAX_SEARCHES ?? 5),
  maxFetches: Number(process.env.ENRICH_MAX_FETCHES ?? 3),
  // Limite de conteúdo por página lida (web_fetch). As indicações (secção 4.1)
  // estão nas primeiras páginas do RCM: não é preciso o PDF inteiro da EMA.
  maxContentTokens: Number(process.env.ENRICH_MAX_CONTENT_TOKENS ?? 15000),
  // Pausa entre produtos (ms) — ritmo calmo, poucos pedidos em paralelo.
  delayMs: Number(process.env.ENRICH_DELAY_MS ?? 2000),
  maxAttempts: Number(process.env.ENRICH_MAX_ATTEMPTS ?? 3),
  // O Infomed proíbe acesso automático (robots.txt): fica excluído.
  blockedDomains: ['extranet.infarmed.pt'],
  promptVersion: 'enrich-v1.1',
  // Versões das ferramentas de servidor da API. CONFIRMAR na documentação
  // (docs.claude.com → Tool use → Web search / Web fetch) antes de correr.
  webSearchToolType: process.env.ENRICH_WEB_SEARCH_TOOL ?? 'web_search_20250305',
  webFetchToolType: process.env.ENRICH_WEB_FETCH_TOOL ?? 'web_fetch_20250910',
  webFetchBeta: process.env.ENRICH_WEB_FETCH_BETA ?? 'web-fetch-2025-09-10',
};

export function assertConfig() {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY em falta');
}
