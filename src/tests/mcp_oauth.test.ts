import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import {
  getBaseIssuerUrl,
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
  registerOAuthClient,
  createOAuthAuthorizationCode,
  exchangeOAuthToken,
  detectOAuthClientDisplay,
  extractConnectorTokenInput,
  renderOAuthConsentPage,
} from '../services/mcp_oauth';

describe('MCP OAuth 2.1 Handshake Service', () => {
  const mockBaseUrl = 'https://bi-pharma.onrender.com';

  it('deve gerar metadados de recurso protegido (RFC 9728)', () => {
    const meta = getProtectedResourceMetadata(mockBaseUrl);
    expect(meta.resource).toBe(mockBaseUrl);
    expect(meta.authorization_servers).toContain(mockBaseUrl);
    expect(meta.scopes_supported).toContain('mcp:tools');
  });

  it('deve gerar metadados de servidor de autorização (RFC 8414)', () => {
    const meta = getAuthorizationServerMetadata(mockBaseUrl);
    expect(meta.issuer).toBe(mockBaseUrl);
    expect(meta.authorization_endpoint).toBe(`${mockBaseUrl}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${mockBaseUrl}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${mockBaseUrl}/oauth/register`);
    expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(meta.grant_types_supported).toContain('authorization_code');
  });

  it('deve registar um novo cliente OAuth dinâmico (RFC 7591)', () => {
    const client = registerOAuthClient(mockBaseUrl, {
      client_name: 'Claude Web Vitest',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });

    expect(client.client_id).toMatch(/^mcp_client_/);
    expect(client.client_name).toBe('Claude Web Vitest');
    expect(client.redirect_uris).toContain('https://claude.ai/api/mcp/auth_callback');
    expect(client.token_endpoint_auth_method).toBe('none');
  });

  it('deve realizar o fluxo completo de autorização e troca de token com PKCE S256', async () => {
    // 1. Gerar verifier e challenge PKCE
    const codeVerifier = 'aVeryLongRandomSecretVerifierStringForPkceValidation123456';
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // 2. Criar código de autorização
    const authCode = createOAuthAuthorizationCode({
      clientId: 'mcp_client_test',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge,
      codeChallengeMethod: 'S256',
      state: 'state123',
      farmaciaId: 'farm-123',
      farmaciaNome: 'Farmácia de Teste',
      perfilPermissao: 'COMPLETO',
      token: 'mcp_live_token_teste_123',
    });

    expect(authCode).toMatch(/^code_/);

    // 3. Mock do Prisma Client
    const mockPrisma: any = {
      mcpConnector: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    // 4. Trocar código por access token com PKCE válido
    const result = await exchangeOAuthToken(mockPrisma, {
      code: authCode,
      codeVerifier,
      clientId: 'mcp_client_test',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    });

    expect(result.accessToken).toBe('mcp_live_token_teste_123');
    expect(result.tokenType).toBe('Bearer');
    expect(result.scope).toBe('mcp:tools');
  });

  it('deve rejeitar troca de token se o PKCE verifier for inválido', async () => {
    const codeVerifier = 'validVerifier12345678901234567890';
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const authCode = createOAuthAuthorizationCode({
      clientId: 'mcp_client_test',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge,
      codeChallengeMethod: 'S256',
      farmaciaId: 'farm-123',
      farmaciaNome: 'Farmácia de Teste',
      perfilPermissao: 'COMPLETO',
      token: 'mcp_live_test_token',
    });

    const mockPrisma: any = {};

    await expect(
      exchangeOAuthToken(mockPrisma, {
        code: authCode,
        codeVerifier: 'wrongVerifierStringThatDoesNotMatchHash',
      })
    ).rejects.toThrow('Validação PKCE falhou');
  });

  it('deve detetar dinamicamente ChatGPT, Claude e Gemini no consentimento OAuth', () => {
    expect(detectOAuthClientDisplay('https://chatgpt.com/connector/oauth/abc').shortName).toBe('ChatGPT');
    expect(detectOAuthClientDisplay('https://claude.ai/api/mcp/auth_callback').shortName).toBe('Claude');
    expect(detectOAuthClientDisplay('https://gemini.google.com/callback').shortName).toBe('Gemini');
  });

  it('deve extrair token tanto de chave direta como de URL completo colado pelo utilizador', () => {
    expect(extractConnectorTokenInput('0bc5b3bc4e629930')).toBe('0bc5b3bc4e629930');
    expect(extractConnectorTokenInput('https://bipharma.nuelltech.com/mcp?token=0bc5b3bc4e629930')).toBe('0bc5b3bc4e629930');
  });

  it('página de consentimento OAuth nunca expõe dropdown de farmácias nem perfis e adapta o nome do agente', () => {
    const html = renderOAuthConsentPage({
      baseUrl: mockBaseUrl,
      clientId: 'mcp_client_123',
      redirectUri: 'https://chatgpt.com/connector/oauth/xyz',
      state: 'st1',
    });
    expect(html).toContain('ChatGPT (OpenAI)');
    expect(html).toContain('Vincular e Autorizar ChatGPT');
    expect(html).not.toContain('Claude (Anthropic)');
    expect(html).not.toContain('name="farmacia_id"');
    expect(html).not.toContain('name="perfil_permissao"');
    expect(html).toContain('name="connector_token"');
  });
});
