import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createMcpConnector, McpPermissionProfile } from './mcp_governance';

export interface RegisteredOAuthClient {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  createdAt: number;
}

export interface StoredAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  state?: string;
  farmaciaId: string;
  farmaciaNome: string;
  perfilPermissao: McpPermissionProfile;
  connectorId?: string;
  token?: string;
  expiresAt: number;
}

// Armazenamento em memória com limpeza periódica
const oauthClients = new Map<string, RegisteredOAuthClient>();
const authCodes = new Map<string, StoredAuthCode>();

// Expiração de códigos em 10 minutos
const CODE_TTL_MS = 10 * 60 * 1000;

function cleanupExpired() {
  const now = Date.now();
  for (const [code, entry] of authCodes.entries()) {
    if (entry.expiresAt < now) {
      authCodes.delete(code);
    }
  }
}
setInterval(cleanupExpired, 60 * 1000).unref();

export function getBaseIssuerUrl(req: { headers: { host?: string; 'x-forwarded-proto'?: string } }): string {
  const host = req.headers.host || 'bi-pharma.onrender.com';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * RFC 9728: OAuth 2.0 Protected Resource Metadata
 */
export function getProtectedResourceMetadata(baseUrl: string) {
  return {
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header', 'query'],
  };
}

/**
 * RFC 8414: OAuth 2.0 Authorization Server Metadata
 */
export function getAuthorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    jwks_uri: `${baseUrl}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp:tools'],
    service_documentation: `${baseUrl}/docs/mcp`,
  };
}

/**
 * RFC 7591: Dynamic Client Registration
 */
export function registerOAuthClient(
  baseUrl: string,
  body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }
): RegisteredOAuthClient & { client_id_issued_at: number } {
  const clientId = `mcp_client_${crypto.randomBytes(8).toString('hex')}`;
  const clientSecret = `sec_${crypto.randomBytes(16).toString('hex')}`;
  const redirectUris = Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0
    ? body.redirect_uris
    : ['https://claude.ai/api/mcp/auth_callback'];

  const client: RegisteredOAuthClient = {
    clientId,
    clientSecret,
    clientName: body.client_name || 'Claude Web MCP Client',
    redirectUris,
    grantTypes: body.grant_types || ['authorization_code'],
    responseTypes: body.response_types || ['code'],
    createdAt: Date.now(),
  };

  oauthClients.set(clientId, client);

  return {
    ...client,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}

export function getOAuthClient(clientId: string): RegisteredOAuthClient | undefined {
  return oauthClients.get(clientId);
}

/**
 * Cria código de autorização para o fluxo PKCE
 */
export function createOAuthAuthorizationCode(data: {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  state?: string;
  farmaciaId: string;
  farmaciaNome: string;
  perfilPermissao: McpPermissionProfile;
  connectorId?: string;
  token?: string;
}): string {
  const code = `code_${crypto.randomBytes(16).toString('hex')}`;
  const entry: StoredAuthCode = {
    code,
    clientId: data.clientId,
    redirectUri: data.redirectUri,
    codeChallenge: data.codeChallenge,
    codeChallengeMethod: data.codeChallengeMethod || 'S256',
    state: data.state,
    farmaciaId: data.farmaciaId,
    farmaciaNome: data.farmaciaNome,
    perfilPermissao: data.perfilPermissao,
    connectorId: data.connectorId,
    token: data.token,
    expiresAt: Date.now() + CODE_TTL_MS,
  };
  authCodes.set(code, entry);
  return code;
}

/**
 * Troca código de autorização por access_token validando PKCE (RFC 7636)
 */
export async function exchangeOAuthToken(
  prisma: PrismaClient,
  params: {
    code: string;
    codeVerifier?: string;
    clientId?: string;
    redirectUri?: string;
  }
): Promise<{ accessToken: string; tokenType: string; expiresIn: number; scope: string }> {
  const stored = authCodes.get(params.code);
  if (!stored) {
    throw new Error('Código de autorização inválido ou expirado.');
  }

  // Uma vez utilizado, apagar o código (One-Time Use)
  authCodes.delete(params.code);

  if (stored.expiresAt < Date.now()) {
    throw new Error('Código de autorização expirado.');
  }

  // Validação PKCE se codeChallenge foi fornecido
  if (stored.codeChallenge) {
    if (!params.codeVerifier) {
      throw new Error('O parâmetro code_verifier é obrigatório para PKCE.');
    }
    const method = (stored.codeChallengeMethod || 'S256').toUpperCase();
    if (method === 'S256') {
      const calculated = crypto.createHash('sha256').update(params.codeVerifier).digest('base64url');
      if (calculated !== stored.codeChallenge) {
        throw new Error('Validação PKCE falhou: code_verifier não coincide com o code_challenge.');
      }
    } else if (method === 'PLAIN') {
      if (params.codeVerifier !== stored.codeChallenge) {
        throw new Error('Validação PKCE plain falhou.');
      }
    }
  }

  // Obter ou criar conector persistente na Farmácia correspondente
  let token = stored.token;
  if (!token) {
    // Verificar se já existe um conector OAuth do Claude ativo
    const existing = await prisma.mcpConnector.findFirst({
      where: {
        farmaciaId: stored.farmaciaId,
        agenteTipo: 'CLAUDE_WEB',
        ativo: true,
      },
      orderBy: { criadoEm: 'desc' },
    });

    if (existing) {
      token = existing.token;
      await prisma.mcpConnector.update({
        where: { id: existing.id },
        data: { ultimoAcessoEm: new Date() },
      });
    } else {
      const created = await createMcpConnector(prisma, stored.farmaciaId, {
        nome: `Claude Web (OAuth ${new Date().toLocaleDateString('pt-PT')})`,
        agenteTipo: 'CLAUDE_WEB',
        perfilPermissao: stored.perfilPermissao,
        criadoPor: 'Claude OAuth 2.1 Handshake',
      });
      token = created.token;
    }
  }

  return {
    accessToken: token,
    tokenType: 'Bearer',
    expiresIn: 365 * 24 * 3600, // 1 ano de validade para o conector
    scope: 'mcp:tools',
  };
}

/**
 * Renderiza página de consentimento e vinculação amigável do Claude Web
 */
export function renderOAuthConsentPage(data: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  farmacias: Array<{ id: string; nome: string; nif: string; codigo_acesso: string | null }>;
  selectedFarmaciaId?: string;
}): string {
  const defaultFarm = data.farmacias.find((f) => f.id === data.selectedFarmaciaId) || data.farmacias[0];

  return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vincular Claude ao BI-PHARMA</title>
  <style>
    :root {
      --primary: #059669;
      --primary-dark: #047857;
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body {
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .auth-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 1rem;
      max-width: 480px;
      width: 100%;
      padding: 2.25rem;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    .brand-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }
    .brand-logo {
      width: 42px;
      height: 42px;
      background: linear-gradient(135deg, #10b981, #047857);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #fff;
      font-size: 1.25rem;
    }
    .brand-title {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.025em;
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-top: 0.25rem;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    p.desc {
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.5;
      margin-bottom: 1.5rem;
    }
    .box {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1rem;
      margin-bottom: 1.5rem;
    }
    .form-group {
      margin-bottom: 1rem;
    }
    .form-group:last-child {
      margin-bottom: 0;
    }
    label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 0.35rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    select, input {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      color: #fff;
      padding: 0.65rem 0.85rem;
      border-radius: 0.5rem;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    select:focus, input:focus {
      border-color: #10b981;
    }
    .permissions-list {
      list-style: none;
      margin: 1rem 0;
      font-size: 0.85rem;
      color: #cbd5e1;
    }
    .permissions-list li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .permissions-list li svg {
      color: #34d399;
      flex-shrink: 0;
    }
    .btn-submit {
      width: 100%;
      background: #10b981;
      color: #fff;
      font-weight: 600;
      font-size: 1rem;
      padding: 0.85rem;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: background 0.2s, transform 0.1s;
    }
    .btn-submit:hover {
      background: #059669;
    }
    .btn-submit:active {
      transform: scale(0.99);
    }
    .btn-cancel {
      display: block;
      width: 100%;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-top: 1rem;
      text-decoration: none;
    }
    .btn-cancel:hover {
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="brand-header">
      <div class="brand-logo">BI</div>
      <div>
        <div class="brand-title">BI-PHARMA Intelligent</div>
        <span class="badge">OAuth 2.1 Conector MCP</span>
      </div>
    </div>

    <h1>Autorizar Ligação do Claude AI</h1>
    <p class="desc">A sua conta no <strong>Claude (Anthropic)</strong> está a solicitar acesso seguro em tempo real aos dados analíticos da farmácia.</p>

    <form method="POST" action="${data.baseUrl}/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(data.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(data.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(data.state || '')}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(data.codeChallenge || '')}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(data.codeChallengeMethod || 'S256')}">

      <div class="box">
        <div class="form-group">
          <label>Farmácia a Conectar</label>
          <select name="farmacia_id">
            ${data.farmacias
              .map(
                (f) =>
                  `<option value="${f.id}" ${f.id === defaultFarm?.id ? 'selected' : ''}>${escapeHtml(f.nome)} (${escapeHtml(f.codigo_acesso || f.nif)})</option>`
              )
              .join('')}
          </select>
        </div>

        <div class="form-group" style="margin-top: 0.75rem;">
          <label>Nível de Acesso (Perfil MCP)</label>
          <select name="perfil_permissao">
            <option value="COMPLETO" selected>Direção Técnica / Completo (20 Ferramentas)</option>
            <option value="GESTAO_COMPRAS">Gestão de Compras & Stocks (Sem Anomalias Margem)</option>
            <option value="BALCAO_CLINICO">Balcão Clínico (Sem Dados Financeiros Restritos)</option>
          </select>
        </div>
      </div>

      <ul class="permissions-list">
        <li>
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
          Consulta inteligente de stock, ruturas e validades críticas
        </li>
        <li>
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
          Análise de curvas ABC, sazonalidade e campanhas
        </li>
        <li>
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
          Auditoria completa de todas as chamadas em Livro de Auditoria
        </li>
      </ul>

      <button type="submit" class="btn-submit">
        <span>Vincular e Autorizar Claude</span>
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
      </button>

      <a href="${escapeHtml(data.redirectUri)}?error=access_denied&state=${escapeHtml(data.state || '')}" class="btn-cancel">Cancelar e Voltar</a>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
