import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import {
  assertProductionSecurityConfig,
  applySecurityHeaders,
  buildSecureCookieHeader,
  readCookieValue,
  isRequestHttps,
  stripQueryString,
  hashOpaqueToken,
} from './services/security_phase0';
import {
  loginWithPassword,
  resolveSessionAndTenant,
  logoutSession,
  logoutAllSessions,
  switchDefaultFarmacia,
  changeUserPassword,
  createPharmacyWithOwnerInvite,
  acceptInviteToken,
  requestPasswordReset,
  consumePasswordReset,
  type RequestAuthContext,
} from './services/auth_service';
import { sendInviteEmail } from './services/email_service';
import { hasPermission, computeEffectivePermissions, sanitizePayloadForPermissions, type Permission } from './services/auth_permissions';
import { createTenantPrisma } from './platform/tenant_prisma';
import { executeCopilotSqlSandbox } from './platform/copilot_sql_sandbox';
import { logSecurityAudit } from './services/audit_service';
import {
  generatePairingCode,
  pairDeviceWithCode,
  listPharmacyDevices,
  revokePharmacyDevice,
  authenticateBalcaoPin,
  listAvailableOperators,
} from './services/device_service';
import { getLoginHtml } from './views/login_view';
import { getAcceptInviteHtml, getForgotPasswordHtml, getResetPasswordHtml } from './views/auth_views';
import { getBalcaoHtml } from './views/balcao_view';
import { getAuditViewHtml } from './views/audit_view';
import {
  checkTrustedDevice,
  createDeviceChallenge,
  verifyDeviceChallengeAndTrust,
} from './services/device_challenge_service';
import {
  grantSupportConsent,
  getActiveSupportConsent,
  revokeSupportConsent,
} from './services/support_service';
import {
  getPasskeyRegistrationOptions,
  verifyAndSavePasskeyRegistration,
  getPasskeyLoginOptions,
  verifyPasskeyLogin,
} from './services/webauthn_service';

// ============================================================================
// TABELA DECLARATIVA DE ROTAS — NEGADA POR OMISSÃO (Spec v2.1 Secção 8)
// Qualquer rota registada no Fastify sem entrada aqui faz o servidor falhar no arranque!
// ============================================================================

export type RouteAccessRule =
  | { access: 'PUBLIC' }
  | { access: 'AUTHENTICATED' }
  | { access: 'SUPERADMIN' }
  | { access: 'PERMISSION'; permissao: Permission; allowGroup?: boolean };

export interface DeclaredRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  rule: RouteAccessRule;
}

declare module 'fastify' {
  interface FastifyRequest {
    authCtx?: RequestAuthContext;
    tenantPrisma?: ReturnType<typeof createTenantPrisma>;
  }
}

export interface FastifyAppOptions {
  prisma: PrismaClient;
  isProd?: boolean;
  allowedOrigin?: string;
  /** Permite injetar rotas extra nos testes (ex.: para provar que rota sem declaração faz falhar o arranque) */
  extraRegister?: (app: FastifyInstance, declareRoute: (r: DeclaredRoute) => void) => void;
}

export function buildFastifyApp(opts: FastifyAppOptions): {
  app: FastifyInstance;
  routeRegistry: Map<string, RouteAccessRule>;
  assertAllRoutesDeclared: () => void;
} {
  const isProd = opts.isProd ?? process.env.NODE_ENV === 'production';
  const allowedOrigin = (opts.allowedOrigin ?? process.env.ALLOWED_ORIGIN ?? (isProd ? 'https://bipharma.nuelltech.com' : 'http://localhost:3000')).trim();

  // Verificação obrigatória no arranque em produção (cookies __Host- + HTTPS + PIN_PEPPER)
  assertProductionSecurityConfig(isProd);

  const app = Fastify({
    trustProxy: true,
    logger: false,
    bodyLimit: 1 * 1024 * 1024,
  });

  const routeRegistry = new Map<string, RouteAccessRule>();
  const registeredRoutes: Array<{ method: string; url: string }> = [];

  function routeKey(method: string, url: string): string {
    return `${method.toUpperCase()} ${url}`;
  }

  function declareRoute(r: DeclaredRoute): void {
    routeRegistry.set(routeKey(r.method, r.url), r.rule);
  }

  // Regista automaticamente todas as rotas montadas no Fastify para validação no arranque
  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      registeredRoutes.push({ method: m.toUpperCase(), url: routeOptions.url });
    }
  });

  // Suporte a relatórios CSP enviados pelo browser (Chrome envia application/csp-report)
  app.addContentTypeParser(
    ['application/csp-report', 'application/reports+json'],
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const json = typeof body === 'string' && body.trim() ? JSON.parse(body) : {};
        done(null, json);
      } catch {
        done(null, {});
      }
    }
  );

  function assertAllRoutesDeclared(): void {
    const undeclared = registeredRoutes.filter((r) => !routeRegistry.has(routeKey(r.method, r.url)));
    if (undeclared.length > 0) {
      const list = undeclared.map((r) => `${r.method} ${r.url}`).join(', ');
      throw new Error(`[SEGURANÇA] Rotas sem declaração de permissão (negado por omissão): ${list}`);
    }
  }

  // --------------------------------------------------------------------------
  // HOOK GLOBAL 1: HEADERS DE SEGURANÇA & CSRF (Origin + Content-Type JSON)
  // --------------------------------------------------------------------------
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const urlPath = req.routeOptions?.url || req.url.split('?')[0];
    const isSse = urlPath.endsWith('/stream') || urlPath === '/mcp';
    const isResetPage = urlPath === '/reset-password' || req.url.includes('resetToken=');
    const isAuthenticatedRoute = urlPath.startsWith('/api/') && urlPath !== '/api/health';

    const cspNonce = crypto.randomBytes(16).toString('base64');
    (req.raw as any).cspNonce = cspNonce;

    applySecurityHeaders(reply.raw, {
      isProd,
      isHttps: isRequestHttps(req.raw, isProd),
      isAuthenticated: isAuthenticatedRoute,
      isSse,
      isResetPage,
      nonce: cspNonce,
    });

    // Verificação CSRF em métodos não seguros (exceto relatório CSP)
    if (
      (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH') &&
      urlPath !== '/api/security/csp-report'
    ) {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) {
        return reply.code(415).send({ ok: false, error: 'Content-Type deve ser application/json.' });
      }

      const origin = String(req.headers.origin || '').trim();
      if (origin) {
        const expected = allowedOrigin.replace(/\/$/, '');
        const isLocalDev = !isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
        if (origin !== expected && !isLocalDev) {
          return reply.code(403).send({ ok: false, error: 'Origem do pedido não autorizada (CSRF).' });
        }
      } else if (isProd) {
        // Em produção, POST/PUT/DELETE via browser têm de enviar Origin (ou Referer da mesma origem)
        const referer = String(req.headers.referer || '').trim();
        const expected = allowedOrigin.replace(/\/$/, '');
        if (!referer.startsWith(expected)) {
          return reply.code(403).send({ ok: false, error: 'Origem do pedido em falta (CSRF).' });
        }
      }
    }
  });

  // --------------------------------------------------------------------------
  // HOOK GLOBAL 2: requireTenantAuth (NEGADO POR OMISSÃO)
  // --------------------------------------------------------------------------
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const matchedUrl = req.routeOptions?.url;
    if (!matchedUrl) {
      return reply.code(404).send({ ok: false, error: 'Rota não encontrada.' });
    }

    const rule = routeRegistry.get(routeKey(req.method, matchedUrl));
    if (!rule) {
      return reply.code(403).send({ ok: false, error: 'Acesso negado por omissão.' });
    }

    if (rule.access === 'PUBLIC') {
      return;
    }

    const rawToken = readCookieValue(req.headers.cookie, ['sid']);
    const queryFarmId = (req.query as any)?.farmaciaId;
    const bodyFarmId = (req.body as any)?.farmaciaId;
    const requestedFarmaciaId = String(req.headers['x-farmacia-id'] || queryFarmId || bodyFarmId || '').trim() || null;
    const requestedScope = String(req.headers['x-scope'] || '').trim().toLowerCase() || null;
    const allowGroup = rule.access === 'PERMISSION' && Boolean(rule.allowGroup);

    const resolved = await resolveSessionAndTenant(opts.prisma, {
      rawToken,
      requestedFarmaciaId,
      requestedScope,
      allowGroup,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    if (!resolved.ok) {
      return reply.code(resolved.statusCode).send({ ok: false, error: resolved.error });
    }

    req.authCtx = resolved.ctx;
    (req.raw as any).authCtx = resolved.ctx;

    // Se a sessão for de suporte técnico (isSupportSession):
    // 1. Auditar imutavelmente todos os pedidos de suporte
    // 2. Bloquear operações de escrita por omissão (Read-Only estrito)
    if (resolved.ctx.isSupportSession) {
      await logSecurityAudit(opts.prisma, {
        evento: 'SUPORTE_ACESSO',
        farmaciaId: resolved.ctx.farmaciaId,
        utilizadorId: resolved.ctx.utilizadorId,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] || ''),
        detalhes: { route: matchedUrl, method: req.method },
      });

      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        if (matchedUrl !== '/api/auth/logout' && matchedUrl !== '/api/tenant/support/revoke') {
          return reply.code(403).send({
            ok: false,
            error: 'Sessão de suporte técnico em modo estritamente Só de Leitura (Read-Only). Operações de escrita proibidas.',
          });
        }
      }
    }

    if (rule.access === 'AUTHENTICATED') {
      return;
    }

    if (rule.access === 'SUPERADMIN') {
      if (!resolved.ctx.isSuperadmin) {
        await logSecurityAudit(opts.prisma, {
          evento: 'ACESSO_NEGADO',
          utilizadorId: resolved.ctx.utilizadorId,
          ip: req.ip,
          userAgent: String(req.headers['user-agent'] || ''),
          detalhes: { route: matchedUrl, reason: 'requires_superadmin' },
        });
        return reply.code(403).send({ ok: false, error: 'Acesso reservado a superadministração.' });
      }
      return;
    }

    // rule.access === 'PERMISSION'
    if (resolved.ctx.farmaciaIds.length === 0) {
      return reply.code(403).send({ ok: false, error: 'Selecione uma farmácia autorizada para continuar.' });
    }

    if (!hasPermission(resolved.ctx.permissoes, rule.permissao)) {
      await logSecurityAudit(opts.prisma, {
        evento: 'ACESSO_NEGADO',
        utilizadorId: resolved.ctx.utilizadorId,
        membroId: resolved.ctx.membroId,
        farmaciaId: resolved.ctx.farmaciaId,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] || ''),
        detalhes: { route: matchedUrl, requiredPermission: rule.permissao },
      });
      return reply.code(403).send({
        ok: false,
        error: 'Não tem permissão para esta operação. Fale com o proprietário.',
      });
    }

    // Injeta cliente Prisma com $extends filtrado obrigatoriamente ao tenant
    req.tenantPrisma = createTenantPrisma(opts.prisma, resolved.ctx);
  });

  // --------------------------------------------------------------------------
  // HOOK GLOBAL 3: sanitizePayloadForPermissions (FILTRO DE CUSTOS/PVP_MIN)
  // Garante que nenhuma rota Fastify vaze custos, margens ou pvp_min sem permissão
  // --------------------------------------------------------------------------
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: any) => {
    if (!req.authCtx || !payload) return payload;
    const contentType = String(reply.getHeader('content-type') || '');
    if (!contentType.includes('application/json')) return payload;

    try {
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const sanitized = sanitizePayloadForPermissions(parsed, req.authCtx.permissoes);
      return JSON.stringify(sanitized);
    } catch {
      return payload;
    }
  });

  // --------------------------------------------------------------------------
  // ROTAS PÚBLICAS & AUTH (FASE 1)
  // --------------------------------------------------------------------------

  declareRoute({ method: 'GET', url: '/api/health', rule: { access: 'PUBLIC' } });
  app.get('/api/health', async () => ({ ok: true, status: 'healthy', ts: new Date().toISOString() }));

  declareRoute({ method: 'GET', url: '/login', rule: { access: 'PUBLIC' } });
  app.get('/login', async (req, reply) => {
    const nonce = (req.raw as any).cspNonce;
    reply.type('text/html; charset=utf-8').send(getLoginHtml(nonce));
  });

  declareRoute({ method: 'GET', url: '/accept-invite', rule: { access: 'PUBLIC' } });
  app.get('/accept-invite', async (req, reply) => {
    const nonce = (req.raw as any).cspNonce;
    reply.type('text/html; charset=utf-8').send(getAcceptInviteHtml(nonce));
  });

  declareRoute({ method: 'POST', url: '/api/auth/accept-invite', rule: { access: 'PUBLIC' } });
  app.post('/api/auth/accept-invite', async (req, reply) => {
    const body = (req.body as any) || {};

    // Se já tiver sessão aberta, extrai o utilizador para aceitar o vínculo sem pedir nova password
    const rawToken = readCookieValue(req.headers.cookie, ['sid']);
    let sessionUserId: string | undefined;
    if (rawToken) {
      const authCheck = await resolveSessionAndTenant(opts.prisma, {
        rawToken,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] || ''),
      });
      if (authCheck.ok && authCheck.ctx?.utilizadorId) {
        sessionUserId = authCheck.ctx.utilizadorId;
      }
    }

    const res = await acceptInviteToken(opts.prisma, {
      token: body.token,
      password: body.password,
      nome: body.nome,
      pin: body.pin,
      sessionUserId,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    if (!res.ok) {
      return reply.code(400).send(res);
    }

    if (res.rawSessionToken) {
      reply.header(
        'Set-Cookie',
        buildSecureCookieHeader('sid', res.rawSessionToken, {
          isProd,
          isHttps: isRequestHttps(req.raw, isProd),
          maxAgeSec: 12 * 60 * 60,
        })
      );
    }

    return reply.code(200).send(res);
  });

  declareRoute({ method: 'GET', url: '/forgot-password', rule: { access: 'PUBLIC' } });
  app.get('/forgot-password', async (req, reply) => {
    const nonce = (req.raw as any).cspNonce;
    reply.type('text/html; charset=utf-8').send(getForgotPasswordHtml(nonce));
  });

  declareRoute({ method: 'POST', url: '/api/auth/forgot-password', rule: { access: 'PUBLIC' } });
  app.post('/api/auth/forgot-password', async (req, reply) => {
    const body = (req.body as any) || {};
    const res = await requestPasswordReset(opts.prisma, body.email, {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });
    return reply.code(res.ok ? 200 : 429).send(res);
  });

  declareRoute({ method: 'GET', url: '/reset-password', rule: { access: 'PUBLIC' } });
  app.get('/reset-password', async (req, reply) => {
    const nonce = (req.raw as any).cspNonce;
    reply.type('text/html; charset=utf-8').send(getResetPasswordHtml(nonce));
  });

  declareRoute({ method: 'POST', url: '/api/auth/reset-password', rule: { access: 'PUBLIC' } });
  app.post('/api/auth/reset-password', async (req, reply) => {
    const body = (req.body as any) || {};
    const res = await consumePasswordReset(opts.prisma, {
      token: body.token,
      newPassword: body.newPassword,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });
    if (!res.ok) {
      return reply.code(400).send(res);
    }
    return reply.code(200).send(res);
  });

  declareRoute({ method: 'POST', url: '/api/security/csp-report', rule: { access: 'PUBLIC' } });
  app.post('/api/security/csp-report', async (req, reply) => {
    const body = (req.body as any) || {};
    const report = body['csp-report'] || body;
    console.warn(
      JSON.stringify({
        evento: 'CSP_VIOLATION',
        ts: new Date().toISOString(),
        documentUri: stripQueryString(report['document-uri'] || report.documentURL),
        blockedUri: stripQueryString(report['blocked-uri'] || report.blockedURL),
        violatedDirective: String(report['violated-directive'] || report.effectiveDirective || ''),
      })
    );
    return reply.code(204).send();
  });

  declareRoute({ method: 'POST', url: '/api/auth/login', rule: { access: 'PUBLIC' } });
  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body as any) || {};
    const trustedDeviceToken = readCookieValue(req.headers.cookie, ['trusted_dev', 'trusted-dev']);
    const result = await loginWithPassword(opts.prisma, {
      email: body.email,
      password: body.password,
      totpCode: body.totpCode,
      trustedDeviceToken,
      requireDeviceVerification: Boolean(body.checkDevice),
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    if (!result.ok || !result.rawToken) {
      return reply.code(result.statusCode).send({
        ok: false,
        error: result.error,
        requiresTotp: result.requiresTotp || undefined,
        requiresMfaSetup: result.requiresMfaSetup || undefined,
        requireDeviceChallenge: result.requireDeviceChallenge || undefined,
        challengeToken: result.challengeToken || undefined,
      });
    }

    reply.header(
      'Set-Cookie',
      buildSecureCookieHeader('sid', result.rawToken, {
        isProd,
        isHttps: isRequestHttps(req.raw, isProd),
        maxAgeSec: 12 * 60 * 60,
      })
    );

    return reply.code(200).send({
      ok: true,
      user: result.user,
      farmacias: result.farmacias,
      activeFarmaciaId: result.activeFarmaciaId,
      permissoes: result.permissoes,
    });
  });

  declareRoute({ method: 'POST', url: '/api/auth/logout', rule: { access: 'AUTHENTICATED' } });
  app.post('/api/auth/logout', async (req, reply) => {
    const rawToken = readCookieValue(req.headers.cookie, ['sid']);
    await logoutSession(opts.prisma, rawToken, {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });
    reply.header(
      'Set-Cookie',
      buildSecureCookieHeader('sid', '', { isProd, isHttps: isRequestHttps(req.raw, isProd), clear: true })
    );
    return reply.code(200).send({ ok: true });
  });

  declareRoute({ method: 'POST', url: '/api/auth/logout-all', rule: { access: 'AUTHENTICATED' } });
  app.post('/api/auth/logout-all', async (req, reply) => {
    if (req.authCtx?.utilizadorId) {
      await logoutAllSessions(opts.prisma, req.authCtx.utilizadorId, {
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] || ''),
      });
    }
    reply.header(
      'Set-Cookie',
      buildSecureCookieHeader('sid', '', { isProd, isHttps: isRequestHttps(req.raw, isProd), clear: true })
    );
    return reply.code(200).send({ ok: true });
  });

  declareRoute({ method: 'GET', url: '/api/auth/me', rule: { access: 'AUTHENTICATED' } });
  app.get('/api/auth/me', async (req) => {
    const ctx = req.authCtx!;
    return {
      ok: true,
      user: {
        id: ctx.utilizadorId,
        email: ctx.email,
        nome: ctx.nome,
        isSuperadmin: ctx.isSuperadmin,
        metodo: ctx.metodo,
      },
      activeFarmaciaId: ctx.farmaciaId,
      scope: ctx.scope,
      permissoes: Array.from(ctx.permissoes),
      farmacias: ctx.farmacias,
    };
  });

  declareRoute({ method: 'POST', url: '/api/auth/switch-farmacia', rule: { access: 'AUTHENTICATED' } });
  app.post('/api/auth/switch-farmacia', async (req, reply) => {
    const ctx = req.authCtx!;
    const body = (req.body as any) || {};
    if (!ctx.utilizadorId || !body.farmaciaId) {
      return reply.code(400).send({ ok: false, error: 'Farmácia inválida.' });
    }
    const res = await switchDefaultFarmacia(opts.prisma, ctx.utilizadorId, String(body.farmaciaId), {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });
    if (!res.ok) return reply.code(403).send(res);
    return reply.code(200).send({ ok: true, farmaciaId: String(body.farmaciaId) });
  });

  declareRoute({ method: 'POST', url: '/api/auth/change-password', rule: { access: 'AUTHENTICATED' } });
  app.post('/api/auth/change-password', async (req, reply) => {
    const ctx = req.authCtx!;
    const body = (req.body as any) || {};
    if (!ctx.utilizadorId) {
      return reply.code(403).send({ ok: false, error: 'Operação não disponível para esta sessão.' });
    }
    const res = await changeUserPassword(
      opts.prisma,
      ctx.utilizadorId,
      ctx.sessionId,
      String(body.currentPassword || ''),
      String(body.newPassword || ''),
      { ip: req.ip, userAgent: String(req.headers['user-agent'] || '') }
    );
    if (!res.ok) return reply.code(400).send(res);
    return reply.code(200).send({ ok: true, message: 'Palavra-passe atualizada e restantes sessões encerradas.' });
  });

  // WebAuthn / Passkeys (Fase 4 - Endurecimento)
  declareRoute({ method: 'GET', url: '/api/auth/passkey/register-options', rule: { access: 'AUTHENTICATED' } });
  app.get('/api/auth/passkey/register-options', async (req, reply) => {
    const ctx = req.authCtx!;
    if (!ctx.utilizadorId || !ctx.email) {
      return reply.code(400).send({ ok: false, error: 'Utilizador sem email para registo de passkey.' });
    }
    const host = req.headers.host || 'localhost:3000';
    const proto = isRequestHttps(req.raw, isProd) ? 'https' : 'http';
    const requestOrigin = `${proto}://${host}`;
    const options = await getPasskeyRegistrationOptions(opts.prisma, {
      utilizadorId: ctx.utilizadorId,
      email: ctx.email,
      nome: ctx.nome,
      requestOrigin,
    });
    return reply.code(200).send(options);
  });

  declareRoute({ method: 'POST', url: '/api/auth/passkey/register-verify', rule: { access: 'AUTHENTICATED' } });
  app.post('/api/auth/passkey/register-verify', async (req, reply) => {
    const ctx = req.authCtx!;
    const body = (req.body as any) || {};
    const host = req.headers.host || 'localhost:3000';
    const proto = isRequestHttps(req.raw, isProd) ? 'https' : 'http';
    const requestOrigin = `${proto}://${host}`;
    const res = await verifyAndSavePasskeyRegistration(opts.prisma, {
      utilizadorId: ctx.utilizadorId!,
      response: body.response || body,
      nomeAmigavel: body.nomeAmigavel,
      requestOrigin,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });
    return reply.code(res.ok ? 200 : 400).send(res);
  });

  declareRoute({ method: 'POST', url: '/api/auth/passkey/login-options', rule: { access: 'PUBLIC' } });
  app.post('/api/auth/passkey/login-options', async (req, reply) => {
    const body = (req.body as any) || {};
    const host = req.headers.host || 'localhost:3000';
    const proto = isRequestHttps(req.raw, isProd) ? 'https' : 'http';
    const requestOrigin = `${proto}://${host}`;
    const options = await getPasskeyLoginOptions(opts.prisma, {
      email: body.email,
      requestOrigin,
    });
    return reply.code(200).send(options);
  });

  declareRoute({ method: 'POST', url: '/api/auth/passkey/login-verify', rule: { access: 'PUBLIC' } });
  app.post('/api/auth/passkey/login-verify', async (req, reply) => {
    const body = (req.body as any) || {};
    const host = req.headers.host || 'localhost:3000';
    const proto = isRequestHttps(req.raw, isProd) ? 'https' : 'http';
    const requestOrigin = `${proto}://${host}`;
    const res = await verifyPasskeyLogin(opts.prisma, {
      response: body.response || body,
      requestOrigin,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    if (!res.ok || !res.utilizadorId) {
      return reply.code(400).send({ ok: false, error: res.error });
    }

    const user = await opts.prisma.utilizador.findUnique({
      where: { id: res.utilizadorId },
      include: {
        vinculosFarmacia: {
          where: { estado: 'ATIVO' },
          include: { farmacia: true },
        },
      },
    });

    if (!user || !user.ativo) {
      return reply.code(403).send({ ok: false, error: 'Conta de utilizador inativa.' });
    }

    const activeFarm = user.vinculosFarmacia.find((v) => v.farmaciaPadrao) || user.vinculosFarmacia[0];
    const activeFarmaciaId = activeFarm ? activeFarm.farmaciaId : null;

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashOpaqueToken(rawToken);
    const now = new Date();
    const expiraEm = new Date(now.getTime() + 12 * 60 * 60 * 1000);

    await opts.prisma.sessao.create({
      data: {
        tokenHash,
        utilizadorId: user.id,
        membroId: activeFarm?.id || null,
        farmaciaAtivaId: activeFarmaciaId,
        metodo: 'PASSKEY',
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] || ''),
        criadaEm: now,
        ultimoUsoEm: now,
        expiraEm,
      },
    });

    reply.header(
      'Set-Cookie',
      buildSecureCookieHeader('sid', rawToken, {
        isProd,
        isHttps: isRequestHttps(req.raw, isProd),
        maxAgeSec: 12 * 60 * 60,
      })
    );

    return reply.code(200).send({
      ok: true,
      user: { id: user.id, email: user.email, nome: user.nome, isSuperadmin: user.isSuperadmin },
      activeFarmaciaId,
    });
  });

  // --------------------------------------------------------------------------
  // ONBOARDING DE FARMÁCIAS (SUPERADMIN — TRANSACIONAL)
  // --------------------------------------------------------------------------

  declareRoute({ method: 'POST', url: '/api/admin/farmacias', rule: { access: 'SUPERADMIN' } });
  app.post('/api/admin/farmacias', async (req, reply) => {
    const ctx = req.authCtx!;
    const body = (req.body as any) || {};
    const res = await createPharmacyWithOwnerInvite(
      opts.prisma,
      { utilizadorId: ctx.utilizadorId!, ip: req.ip, userAgent: String(req.headers['user-agent'] || '') },
      body
    );
    if (!res.ok) return reply.code(400).send(res);

    // Disparo imediato de email de convite através do Resend (info@bipharma.nuelltech.com)
    if (res.inviteToken && body.ownerEmail) {
      sendInviteEmail({
        to: body.ownerEmail,
        nome: body.ownerNome || 'Proprietário',
        farmaciaNome: res.farmacia?.nome || body.nome,
        perfil: 'PROPRIETARIO',
        token: res.inviteToken,
      }).catch((err) => console.error('[Resend Invite Error]:', err));
    }

    return reply.code(201).send({
      ok: true,
      farmacia: res.farmacia,
      inviteTokenPreview: !isProd ? res.inviteToken : undefined,
    });
  });

  // --------------------------------------------------------------------------
  // ROTAS DE TENANT ISOLADAS (COMPRAS GRUPO, DASHBOARD, COPILOT SQL SANDBOX)
  // --------------------------------------------------------------------------

  declareRoute({
    method: 'GET',
    url: '/api/tenant/dashboard-summary',
    rule: { access: 'PERMISSION', permissao: 'ver_stock_validades' },
  });
  app.get('/api/tenant/dashboard-summary', async (req) => {
    const ctx = req.authCtx!;
    const db = req.tenantPrisma!;
    const kpi = await db.martTenantKpis.findFirst();
    const canSeeCosts = ctx.permissoes.has('ver_custos');
    return {
      ok: true,
      farmaciaId: ctx.farmaciaId,
      totalArtigos: kpi?.total_artigos_inventario ?? 0,
      totalUnidades: kpi?.total_unidades_stock ?? 0,
      ...(canSeeCosts ? { valorStockCusto: Number(kpi?.valor_total_stock_custo ?? 0) } : {}),
    };
  });

  declareRoute({
    method: 'GET',
    url: '/api/tenant/compras-grupo',
    rule: { access: 'PERMISSION', permissao: 'ver_grupo', allowGroup: true },
  });
  app.get('/api/tenant/compras-grupo', async (req) => {
    const ctx = req.authCtx!;
    const farmaciaIds = ctx.farmaciaIds;

    // Calcular rigorosamente para que farmácias do grupo o utilizador tem 'ver_custos'
    // Regra v2.1: Nunca somar nem revelar custos de farmácias onde o operador não tem ver_custos!
    const allowedCostFarmaciaIds = new Set<string>();
    for (const f of ctx.farmacias || []) {
      const p = computeEffectivePermissions(f.perfil, f.permissoesExtra, ctx.metodo);
      if (p.has('ver_custos')) {
        allowedCostFarmaciaIds.add(f.farmaciaId);
      }
    }

    // Agregação multi-farmácia de inventário e compras de grupo
    const groupKpis = await opts.prisma.martTenantKpis.findMany({
      where: { farmaciaId: { in: farmaciaIds } },
    });

    const totalUnidadesGrupo = groupKpis.reduce((acc: number, k: any) => acc + (k.total_unidades_stock ?? 0), 0);
    const totalArtigosGrupo = groupKpis.reduce((acc: number, k: any) => acc + (k.total_artigos_inventario ?? 0), 0);

    // O valor total a custo soma ESTRITAMENTE apenas as farmácias onde o utilizador tem ver_custos
    const costEligibleKpis = groupKpis.filter((k: any) => allowedCostFarmaciaIds.has(k.farmaciaId));
    const valorStockCustoGrupo = costEligibleKpis.reduce((acc: number, k: any) => acc + Number(k.valor_total_stock_custo ?? 0), 0);
    const hasAnyCostPermission = allowedCostFarmaciaIds.size > 0;

    return {
      ok: true,
      scope: ctx.scope,
      farmaciaIds,
      totalFarmacias: farmaciaIds.length,
      resumoGrupo: {
        totalArtigos: totalArtigosGrupo,
        totalUnidades: totalUnidadesGrupo,
        ...(hasAnyCostPermission ? { valorTotalStockCusto: valorStockCustoGrupo } : {}),
      },
      detalhesPorFarmacia: groupKpis.map((k: any) => {
        const canSeeThisPharmacyCost = allowedCostFarmaciaIds.has(k.farmaciaId);
        return {
          farmaciaId: k.farmaciaId,
          totalArtigos: k.total_artigos_inventario,
          totalUnidades: k.total_unidades_stock,
          ...(canSeeThisPharmacyCost ? { valorStockCusto: Number(k.valor_total_stock_custo ?? 0) } : {}),
        };
      }),
    };
  });

  declareRoute({
    method: 'POST',
    url: '/api/tenant/copilot-sql',
    rule: { access: 'PERMISSION', permissao: 'usar_copilot' },
  });
  app.post('/api/tenant/copilot-sql', async (req, reply) => {
    const ctx = req.authCtx!;
    const body = (req.body as any) || {};
    if (!ctx.farmaciaId) {
      return reply.code(400).send({ ok: false, error: 'O Copilot opera sempre numa única farmácia.' });
    }
    const res = await executeCopilotSqlSandbox(opts.prisma, ctx.farmaciaId, ctx.permissoes, String(body.sql || ''));
    if (!res.ok) return reply.code(403).send(res);
    return reply.code(200).send(res);
  });

  // --------------------------------------------------------------------------
  // FASE 3: DISPOSITIVOS DE BALCÃO, EMPARELHAMENTO E AUTENTICAÇÃO POR PIN
  // --------------------------------------------------------------------------

  declareRoute({
    method: 'POST',
    url: '/api/tenant/devices/pairing-code',
    rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' },
  });
  app.post('/api/tenant/devices/pairing-code', async (req, reply) => {
    const ctx = req.authCtx!;
    if (ctx.isSupportSession) {
      return reply.code(403).send({ ok: false, error: 'O suporte técnico não pode gerar códigos de emparelhamento de balcão.' });
    }
    if (ctx.isSuperadmin && !ctx.membroId) {
      return reply.code(403).send({ ok: false, error: 'Apenas a equipa da farmácia (Proprietário) pode emparelhar novos postos de balcão.' });
    }
    if (!ctx.farmaciaId) {
      return reply.code(400).send({ ok: false, error: 'Farmácia ativa obrigatória.' });
    }
    const res = await generatePairingCode(opts.prisma, ctx.farmaciaId, ctx.utilizadorId || ctx.membroId || 'admin');
    return reply.code(res.ok ? 200 : 400).send(res);
  });

  declareRoute({ method: 'POST', url: '/api/devices/pair', rule: { access: 'PUBLIC' } });
  app.post('/api/devices/pair', async (req, reply) => {
    const body = (req.body as any) || {};
    const res = await pairDeviceWithCode(opts.prisma, {
      codigo: body.codigo,
      nomeDispositivo: body.nomeDispositivo,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });
    if (!res.ok) {
      return reply.code(400).send(res);
    }

    if (res.deviceToken) {
      // Cookie __Host-dev em produção (HttpOnly, Secure, SameSite=Lax, Path=/)
      reply.header(
        'Set-Cookie',
        buildSecureCookieHeader('dev', res.deviceToken, {
          isProd,
          isHttps: isRequestHttps(req.raw, isProd),
          maxAgeSec: 365 * 24 * 60 * 60,
        })
      );
    }

    // Em produção o token NÃO é devolvido no corpo da resposta para impedir roubo via XSS / localStorage
    return reply.code(200).send({
      ok: true,
      dispositivo: res.dispositivo,
      ...(!isProd ? { deviceToken: res.deviceToken } : {}),
    });
  });

  declareRoute({
    method: 'GET',
    url: '/api/tenant/devices',
    rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' },
  });
  app.get('/api/tenant/devices', async (req, reply) => {
    const ctx = req.authCtx!;
    if (!ctx.farmaciaId) {
      return reply.code(400).send({ ok: false, error: 'Farmácia ativa obrigatória.' });
    }
    const devices = await listPharmacyDevices(opts.prisma, ctx.farmaciaId);
    return reply.code(200).send({ ok: true, devices });
  });

  declareRoute({
    method: 'POST',
    url: '/api/tenant/devices/revoke',
    rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' },
  });
  app.post('/api/tenant/devices/revoke', async (req, reply) => {
    const ctx = req.authCtx!;
    const body = (req.body as any) || {};
    if (!ctx.farmaciaId || !body.dispositivoId) {
      return reply.code(400).send({ ok: false, error: 'Farmácia e dispositivoId obrigatórios.' });
    }
    const res = await revokePharmacyDevice(
      opts.prisma,
      ctx.farmaciaId,
      String(body.dispositivoId),
      ctx.utilizadorId || ctx.membroId || 'admin'
    );
    if (!res.ok) return reply.code(400).send(res);
    return reply.code(200).send({ ok: true, message: 'Dispositivo revogado com sucesso.' });
  });

  const handlePinAuthRoute = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const rawDeviceToken =
      readCookieValue(req.headers.cookie, ['dev', 'device_token']) ||
      String(req.headers['x-device-token'] || '').trim();

    const res = await authenticateBalcaoPin(opts.prisma, {
      farmaciaId: body.farmaciaId,
      pin: body.pin,
      memberId: body.memberId,
      rawDeviceToken,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    if (!res.ok || !res.rawSessionToken) {
      return reply.code(res.statusCode).send(res);
    }

    reply.header(
      'Set-Cookie',
      buildSecureCookieHeader('sid', res.rawSessionToken, {
        isProd,
        isHttps: isRequestHttps(req.raw, isProd),
        maxAgeSec: 8 * 60 * 60, // Sessão de balcão tem duração máxima de 8 horas
      })
    );

    return reply.code(200).send(res);
  };

  declareRoute({ method: 'POST', url: '/api/auth/pin', rule: { access: 'PUBLIC' } });
  app.post('/api/auth/pin', handlePinAuthRoute);

  declareRoute({ method: 'POST', url: '/api/mobile/auth-pin', rule: { access: 'PUBLIC' } });
  app.post('/api/mobile/auth-pin', handlePinAuthRoute);

  // Rota de listagem de operadores exclusivos para terminais emparelhados
  declareRoute({ method: 'GET', url: '/api/balcao/operadores', rule: { access: 'PUBLIC' } });
  app.get('/api/balcao/operadores', async (req, reply) => {
    const rawDeviceToken =
      readCookieValue(req.headers.cookie, ['dev', 'device_token']) ||
      String(req.headers['x-device-token'] || '').trim();
    const farmaciaId =
      String((req.query as any)?.farmaciaId || '').trim() ||
      String(req.headers['x-farmacia-id'] || '').trim();

    const res = await listAvailableOperators(opts.prisma, farmaciaId, rawDeviceToken);
    return reply.code(res.statusCode).send(res);
  });

  // Interface Web Kiosk do Balcão
  declareRoute({ method: 'GET', url: '/balcao', rule: { access: 'PUBLIC' } });
  app.get('/balcao', async (req, reply) => {
    const rawDeviceToken =
      readCookieValue(req.headers.cookie, ['dev', 'device_token']) ||
      String(req.headers['x-device-token'] || '').trim();
    const isPaired = Boolean(rawDeviceToken && rawDeviceToken.length >= 32);

    const nonce = (req.raw as any).cspNonce;
    reply.type('text/html; charset=utf-8');
    return reply.send(getBalcaoHtml({ isPaired }, nonce));
  });

  // --------------------------------------------------------------------------
  // FASE 4: SUPORTE COM CONSENTIMENTO, DISPOSITIVOS CONFIADOS & AUDITORIA
  // --------------------------------------------------------------------------

  declareRoute({
    method: 'POST',
    url: '/api/auth/device-challenge',
    rule: { access: 'PUBLIC' },
  });
  app.post('/api/auth/device-challenge', async (req, reply) => {
    const body = (req.body as any) || {};
    const res = await verifyDeviceChallengeAndTrust(opts.prisma, {
      challengeToken: body.challengeToken,
      code: body.code,
      confiavel: Boolean(body.confiavel),
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || ''),
    });

    if (!res.ok || !res.rawTrustedToken) {
      return reply.code(res.statusCode).send(res);
    }

    // Set cookie __Host-trusted-dev
    reply.header(
      'Set-Cookie',
      buildSecureCookieHeader('trusted_dev', res.rawTrustedToken, {
        isProd,
        isHttps: isRequestHttps(req.raw, isProd),
        maxAgeSec: (body.confiavel ? 90 : 30) * 24 * 60 * 60,
      })
    );

    return reply.code(200).send({
      ok: true,
      message: 'Dispositivo verificado e confiado com sucesso.',
      utilizadorId: res.utilizadorId,
    });
  });

  declareRoute({
    method: 'POST',
    url: '/api/tenant/support/consent',
    rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' },
  });
  app.post('/api/tenant/support/consent', async (req, reply) => {
    const ctx = req.authCtx!;
    const body = (req.body as any) || {};
    if (!ctx.farmaciaId) {
      return reply.code(400).send({ ok: false, error: 'Farmácia ativa obrigatória.' });
    }
    const res = await grantSupportConsent(opts.prisma, {
      farmaciaId: ctx.farmaciaId,
      concedidoPor: ctx.utilizadorId || ctx.membroId || 'admin',
      duracaoHoras: Number(body.duracaoHoras || 2),
      motivo: body.motivo,
    });
    return reply.code(res.ok ? 200 : 400).send(res);
  });

  declareRoute({
    method: 'GET',
    url: '/api/tenant/support/consent',
    rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' },
  });
  app.get('/api/tenant/support/consent', async (req, reply) => {
    const ctx = req.authCtx!;
    if (!ctx.farmaciaId) {
      return reply.code(400).send({ ok: false, error: 'Farmácia ativa obrigatória.' });
    }
    const res = await getActiveSupportConsent(opts.prisma, ctx.farmaciaId);
    return reply.code(200).send({ ok: true, ...res });
  });

  declareRoute({
    method: 'POST',
    url: '/api/tenant/support/revoke',
    rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' },
  });
  app.post('/api/tenant/support/revoke', async (req, reply) => {
    const ctx = req.authCtx!;
    if (!ctx.farmaciaId) {
      return reply.code(400).send({ ok: false, error: 'Farmácia ativa obrigatória.' });
    }
    const res = await revokeSupportConsent(
      opts.prisma,
      ctx.farmaciaId,
      ctx.utilizadorId || ctx.membroId || 'admin'
    );
    return reply.code(res.ok ? 200 : 400).send(res);
  });

  declareRoute({
    method: 'GET',
    url: '/api/tenant/audit',
    rule: { access: 'PERMISSION', permissao: 'ver_auditoria' },
  });
  app.get('/api/tenant/audit', async (req, reply) => {
    const ctx = req.authCtx!;
    const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit || 50)));
    const logs = await opts.prisma.auditoriaSeguranca.findMany({
      where: { farmaciaId: ctx.farmaciaId || undefined },
      orderBy: { ts: 'desc' },
      take: limit,
    });

    return reply.code(200).send({
      ok: true,
      logs: logs.map((l: any) => ({
        id: l.id,
        evento: l.evento,
        utilizadorNome: l.utilizadorId,
        membroNome: l.membroId,
        ip: l.ip,
        userAgent: l.userAgent,
        ts: l.ts,
        detalhes: l.detalhes,
      })),
    });
  });

  declareRoute({
    method: 'GET',
    url: '/auditoria',
    rule: { access: 'PERMISSION', permissao: 'ver_auditoria' },
  });
  app.get('/auditoria', async (req, reply) => {
    const ctx = req.authCtx!;
    const logs = await opts.prisma.auditoriaSeguranca.findMany({
      where: { farmaciaId: ctx.farmaciaId || undefined },
      orderBy: { ts: 'desc' },
      take: 50,
    });

    reply.type('text/html; charset=utf-8');
    return reply.send(
      getAuditViewHtml({
        farmaciaNome: 'Farmácia',
        logs: logs.map((l: any) => ({
          id: l.id,
          evento: l.evento,
          utilizadorNome: l.utilizadorId,
          membroNome: l.membroId,
          ip: l.ip,
          userAgent: l.userAgent,
          ts: l.ts,
          detalhes: l.detalhes,
        })),
      })
    );
  });

  if (opts.extraRegister) {
    opts.extraRegister(app, declareRoute);
  }

  return { app, routeRegistry, assertAllRoutesDeclared };
}
