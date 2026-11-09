import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import {
  getBaseIssuerUrl,
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
  registerOAuthClient,
  createOAuthAuthorizationCode,
  exchangeOAuthToken,
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

    expect(client.clientId).toMatch(/^mcp_client_/);
    expect(client.clientName).toBe('Claude Web Vitest');
    expect(client.redirectUris).toContain('https://claude.ai/api/mcp/auth_callback');
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
});
