import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import {
  hashOpaqueToken,
  checkDbRateLimit,
  recordDbRateLimitHit,
  resetDbRateLimit,
  isTrivialPin,
  hashPinWithPepper,
} from './security_phase0';
import {
  hashPasswordScrypt,
  verifyPasswordScrypt,
  verifyDummyPasswordScrypt,
  decryptTotpSecret,
  verifyTotpCode,
  verifyTotpCodeWithStep,
  verifyAndConsumeRecoveryCode,
} from './auth_crypto';
import { validatePasswordPolicy, validatePasswordPolicyAsync } from '../data/common_passwords';
import {
  computeEffectivePermissions,
  type MetodoSessao,
  type Permission,
} from './auth_permissions';
import { logSecurityAudit } from './audit_service';
import {
  sendInviteEmail,
  sendPasswordResetEmail,
  sendPasswordChangedAlertEmail,
  sendProfileChangedEmail,
} from './email_service';
import { checkTrustedDevice, createDeviceChallenge } from './device_challenge_service';

export interface AuthorizedPharmacy {
  farmaciaId: string;
  membroId: string;
  nome: string;
  slug: string | null;
  perfil: string;
  permissoesExtra: string[];
  farmaciaPadrao: boolean;
  estadoFarmacia: string;
}

export interface RequestAuthContext {
  sessionId: string;
  utilizadorId: string | null;
  membroId: string | null;
  email: string | null;
  nome: string;
  isSuperadmin: boolean;
  isSupportSession?: boolean;
  metodo: MetodoSessao;
  farmaciaId: string | null;
  farmaciaIds: string[];
  scope: 'single' | 'grupo' | 'superadmin';
  permissoes: Set<Permission>;
  farmacias: AuthorizedPharmacy[];
}

// ============================================================================
// CACHE DE SESSÕES EM MEMÓRIA (TTL 45s — INVALIDAÇÃO IMEDIATA EM LOGOUT/REVOGAÇÃO)
// ============================================================================

interface CachedSessionEntry {
  expiresAtMs: number;
  session: {
    id: string;
    tokenHash: string;
    utilizadorId: string | null;
    membroId: string | null;
    farmaciaAtivaId: string | null;
    metodo: MetodoSessao;
    expiraEm: Date;
    revogadaEm: Date | null;
  };
  user: {
    id: string;
    email: string | null;
    nome: string;
    ativo: boolean;
    isSuperadmin: boolean;
  } | null;
  farmacias: AuthorizedPharmacy[];
}

const SESSION_CACHE_TTL_MS = 45_000;
const sessionCache = new Map<string, CachedSessionEntry>();

export function invalidateSessionCacheByHash(tokenHash: string): void {
  sessionCache.delete(tokenHash);
}

export function invalidateSessionCacheByUser(utilizadorId: string): void {
  for (const [k, v] of sessionCache.entries()) {
    if (v.session.utilizadorId === utilizadorId) {
      sessionCache.delete(k);
    }
  }
}

export function clearAllSessionCache(): void {
  sessionCache.clear();
}

// ============================================================================
// LOGIN WEB (EMAIL + PASSWORD + TOTP OBRIGATÓRIO PARA SUPERADMIN)
// ============================================================================

const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const LOGIN_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hora (contra ataque distribuído)
const SESSION_WEB_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas (sem dispositivo confiado)

export interface LoginResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  requiresTotp?: boolean;
  requiresMfaSetup?: boolean;
  requireDeviceChallenge?: boolean;
  challengeToken?: string;
  rawToken?: string;
  user?: {
    id: string;
    email: string | null;
    nome: string;
    isSuperadmin: boolean;
  };
  farmacias?: AuthorizedPharmacy[];
  activeFarmaciaId?: string | null;
  permissoes?: Permission[];
  newDeviceDetected?: boolean;
}

export async function loginWithPassword(
  prisma: PrismaClient,
  input: {
    email: string;
    password: string;
    totpCode?: string;
    trustedDeviceToken?: string | null;
    requireDeviceVerification?: boolean;
    allowWithoutMfa?: boolean;
    ip: string;
    userAgent: string;
  }
): Promise<LoginResult> {
  const cleanEmail = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const ip = input.ip || '127.0.0.1';
  const userAgent = String(input.userAgent || 'Desconhecido').slice(0, 250);

  if (!cleanEmail || !password) {
    return { ok: false, statusCode: 400, error: 'Email ou password incorretos.' };
  }

  // 1. Rate limiting duplo (Spec v2.1): email+IP (5 falhas/15m) E email global (10 falhas/hora)
  const keyIpEmail = `login:ip_email:${cleanEmail}:${ip}`;
  const keyEmailGlobal = `login:email:${cleanEmail}`;

  const [rlIp, rlEmail] = await Promise.all([
    checkDbRateLimit(prisma, keyIpEmail, 5, LOGIN_IP_WINDOW_MS, true),
    checkDbRateLimit(prisma, keyEmailGlobal, 10, LOGIN_EMAIL_WINDOW_MS, true),
  ]);

  if (!rlIp.allowed || !rlEmail.allowed) {
    const waitMin = Math.max(1, Math.ceil(Math.max(rlIp.retryAfterSec, rlEmail.retryAfterSec) / 60));
    return {
      ok: false,
      statusCode: 429,
      error: `Demasiadas tentativas falhadas. Aguarde ${waitMin} minuto(s) antes de tentar novamente.`,
    };
  }

  // 2. Procurar utilizador
  const user = await prisma.utilizador.findUnique({
    where: { email: cleanEmail },
  });

  if (!user || !user.ativo || !user.passwordHash) {
    // Timing equalization (nunca revelar se a conta existe)
    await verifyDummyPasswordScrypt(password);
    await Promise.all([
      recordDbRateLimitHit(prisma, keyIpEmail, LOGIN_IP_WINDOW_MS, { maxBeforeBlock: 5, baseBlockMs: 2 * 60 * 1000 }),
      recordDbRateLimitHit(prisma, keyEmailGlobal, LOGIN_EMAIL_WINDOW_MS, { maxBeforeBlock: 10, baseBlockMs: 5 * 60 * 1000 }),
    ]);
    await logSecurityAudit(prisma, {
      evento: 'LOGIN_FAIL',
      ip,
      userAgent,
      detalhes: { reason: 'invalid_credentials' },
    });
    return { ok: false, statusCode: 401, error: 'Email ou password incorretos.' };
  }

  // 3. Verificar password com scrypt assíncrono + timingSafeEqual
  const pwdOk = await verifyPasswordScrypt(password, user.passwordHash);
  if (!pwdOk) {
    await Promise.all([
      recordDbRateLimitHit(prisma, keyIpEmail, LOGIN_IP_WINDOW_MS, { maxBeforeBlock: 5, baseBlockMs: 2 * 60 * 1000 }),
      recordDbRateLimitHit(prisma, keyEmailGlobal, LOGIN_EMAIL_WINDOW_MS, { maxBeforeBlock: 10, baseBlockMs: 5 * 60 * 1000 }),
    ]);
    await logSecurityAudit(prisma, {
      evento: 'LOGIN_FAIL',
      utilizadorId: user.id,
      ip,
      userAgent,
      detalhes: { reason: 'wrong_password' },
    });
    return { ok: false, statusCode: 401, error: 'Email ou password incorretos.' };
  }

  // 3.5. Dispositivo Confiado (30 dias) & MFA Unificado (Fase 4 - Endurecimento)
  const trustedCheck = await checkTrustedDevice(prisma, user.id, input.trustedDeviceToken);
  const isDeviceTrusted = trustedCheck.trusted;

  // 4. MFA por Perfil:
  // Superadmin, Proprietário, Comprador e Diretor Técnico têm MFA obrigatório (TOTP ou Passkey)
  // 4. Carregar vínculos ativos uma ÚNICA vez (com farmacia incluída) + verificar MFA
  const mfaRoles = new Set(['PROPRIETARIO', 'COMPRADOR', 'DIRETOR_TECNICO']);
  const vinculos = await prisma.membroFarmacia.findMany({
    where: { utilizadorId: user.id, estado: 'ATIVO' },
    include: { farmacia: true },
    orderBy: { criadoEm: 'asc' },
  });
  const mustEnforceMfa =
    !input.allowWithoutMfa && (user.isSuperadmin || vinculos.some((m) => mfaRoles.has(m.perfil)));

  if (mustEnforceMfa || user.totpAtivo) {
    const secret = decryptTotpSecret(user.totpSecretEnc);

    // Se perfil exige MFA mas ainda não configurou TOTP:
    if (!user.totpAtivo || !secret) {
      if (user.isSuperadmin) {
        await logSecurityAudit(prisma, {
          evento: 'TOTP_FALHOU',
          utilizadorId: user.id,
          ip,
          userAgent,
          detalhes: { reason: 'superadmin_totp_not_configured' },
        });
        return {
          ok: false,
          statusCode: 403,
          error: 'A conta de superadmin exige TOTP configurado antes de iniciar sessão.',
        };
      } else {
        // Assistente guiado de ativação de MFA
        return {
          ok: false,
          statusCode: 200,
          requiresMfaSetup: true,
          error: 'O seu perfil de utilizador exige a ativação de autenticação de dois fatores (MFA). Siga o assistente de configuração.',
        };
      }
    }

    // Regra v2.1: Dispositivo confiado (30 dias) dispensa digitação de TOTP
    // Mas em dispositivo novo (ou superadmin), o TOTP atua diretamente como desafio de novo dispositivo
    if (!isDeviceTrusted || user.isSuperadmin) {
      if (!input.totpCode) {
        return {
          ok: false,
          statusCode: 401,
          requiresTotp: true,
          error: isDeviceTrusted
            ? 'Código de verificação (TOTP) de 6 dígitos ou código de recuperação obrigatório.'
            : 'Novo dispositivo detetado. Introduza o código de 6 dígitos da sua app autenticadora.',
        };
      }

      const keyTotpAttempts = `totp:email:${cleanEmail}`;
      const rlTotp = await checkDbRateLimit(prisma, keyTotpAttempts, 5, 15 * 60 * 1000, true);
      if (!rlTotp.allowed) {
        return {
          ok: false,
          statusCode: 429,
          error: 'Demasiadas tentativas de TOTP falhadas. Aguarde 15 minutos.',
        };
      }

      // Tentar primeiro como TOTP (com anti-replay contra totpUltimoPasso)
      let totpSuccess = false;
      if (secret) {
        const totpCheck = verifyTotpCodeWithStep(secret, input.totpCode, user.totpUltimoPasso);
        if (totpCheck.valid && totpCheck.matchedStep != null) {
          totpSuccess = true;
          await prisma.utilizador.update({
            where: { id: user.id },
            data: { totpUltimoPasso: totpCheck.matchedStep },
          });
        }
      }

      // Se falhar TOTP, tentar código de recuperação de uso único
      if (!totpSuccess && user.totpRecoveryHashes && user.totpRecoveryHashes.length > 0) {
        const recCheck = verifyAndConsumeRecoveryCode(input.totpCode, user.totpRecoveryHashes);
        if (recCheck.valid) {
          totpSuccess = true;
          await prisma.utilizador.update({
            where: { id: user.id },
            data: { totpRecoveryHashes: recCheck.remainingHashes },
          });
          await logSecurityAudit(prisma, {
            evento: 'RECOVERY_CODE_USADO',
            utilizadorId: user.id,
            ip,
            userAgent,
            detalhes: { remainingCount: recCheck.remainingHashes.length },
          });
        }
      }

      if (!totpSuccess) {
        await Promise.all([
          recordDbRateLimitHit(prisma, keyIpEmail, LOGIN_IP_WINDOW_MS, { maxBeforeBlock: 5, baseBlockMs: 2 * 60 * 1000 }),
          recordDbRateLimitHit(prisma, keyTotpAttempts, 15 * 60 * 1000, { maxBeforeBlock: 5, baseBlockMs: 5 * 60 * 1000 }),
        ]);
        await logSecurityAudit(prisma, {
          evento: 'TOTP_FALHOU',
          utilizadorId: user.id,
          ip,
          userAgent,
        });
        return {
          ok: false,
          statusCode: 401,
          requiresTotp: true,
          error: 'Código de verificação (TOTP) ou código de recuperação inválido ou já utilizado.',
        };
      }

      await resetDbRateLimit(prisma, keyTotpAttempts);
    }
  }

  // 5. Mapear vínculos ativos já carregados acima (evita 2.ª query duplicada)
  const farmacias: AuthorizedPharmacy[] = vinculos
    .filter((v) => v.farmacia && v.farmacia.estado === 'ATIVO')
    .map((v) => ({
      farmaciaId: v.farmaciaId,
      membroId: v.id,
      nome: v.farmacia.nome,
      slug: v.farmacia.slug,
      perfil: v.perfil,
      permissoesExtra: v.permissoesExtra || [],
      farmaciaPadrao: v.farmaciaPadrao,
      estadoFarmacia: v.farmacia.estado,
    }));

  if (!user.isSuperadmin && farmacias.length === 0) {
    return {
      ok: false,
      statusCode: 403,
      error: 'A sua conta não tem acesso ativo a nenhuma farmácia. Fale com o proprietário.',
    };
  }

  // 6. Criar nova sessão opaca de 256 bits (só hash SHA-256 na BD)
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashOpaqueToken(rawToken);
  const defaultFarm = farmacias.find((f) => f.farmaciaPadrao) || (farmacias.length === 1 ? farmacias[0] : null);
  const now = new Date();
  const expiraEm = new Date(now.getTime() + SESSION_WEB_TTL_MS);

  await prisma.sessao.create({
    data: {
      tokenHash,
      utilizadorId: user.id,
      membroId: defaultFarm?.membroId || null,
      farmaciaAtivaId: defaultFarm?.farmaciaId || null,
      metodo: 'PASSWORD',
      ip,
      userAgent,
      criadaEm: now,
      ultimoUsoEm: now,
      expiraEm,
    },
  });

  // Limpeza de rate-limits, deteção de dispositivo novo e auditoria em background (não bloqueia a resposta do login)
  const newDeviceDetected = false;
  void (async () => {
    try {
      const prevSession = await prisma.sessao.findFirst({
        where: { utilizadorId: user.id, ip, userAgent, tokenHash: { not: tokenHash } },
        select: { id: true },
      });
      const isNewDev = !prevSession;
      await Promise.all([
        resetDbRateLimit(prisma, keyIpEmail),
        resetDbRateLimit(prisma, keyEmailGlobal),
        logSecurityAudit(prisma, {
          evento: 'LOGIN_OK',
          utilizadorId: user.id,
          membroId: defaultFarm?.membroId || null,
          farmaciaId: defaultFarm?.farmaciaId || null,
          ip,
          userAgent,
          detalhes: { metodo: 'PASSWORD', newDeviceDetected: isNewDev },
        }),
      ]);
      if (isNewDev) {
        await logSecurityAudit(prisma, {
          evento: 'NEW_DEVICE_LOGIN',
          utilizadorId: user.id,
          farmaciaId: defaultFarm?.farmaciaId || null,
          ip,
          userAgent,
        });
      }
    } catch {
      // telemetria não-bloqueante
    }
  })();

  const perms = defaultFarm
    ? Array.from(computeEffectivePermissions(defaultFarm.perfil, defaultFarm.permissoesExtra, 'PASSWORD'))
    : [];

  return {
    ok: true,
    statusCode: 200,
    rawToken,
    user: {
      id: user.id,
      email: user.email,
      nome: user.nome,
      isSuperadmin: user.isSuperadmin,
    },
    farmacias,
    activeFarmaciaId: defaultFarm?.farmaciaId || null,
    permissoes: perms,
    newDeviceDetected,
  };
}

// ============================================================================
// RESOLUÇÃO DE SESSÃO E TENANT POR PEDIDO (requireTenantAuth)
// ============================================================================

export async function resolveSessionAndTenant(
  prisma: PrismaClient,
  input: {
    rawToken: string;
    requestedFarmaciaId?: string | null;
    requestedScope?: string | null;
    allowGroup?: boolean;
    ip?: string;
    userAgent?: string;
  }
): Promise<{ ok: true; ctx: RequestAuthContext } | { ok: false; statusCode: number; error: string }> {
  if (!input.rawToken || input.rawToken.length < 32) {
    return { ok: false, statusCode: 401, error: 'Sessão inválida ou expirada.' };
  }

  const tokenHash = hashOpaqueToken(input.rawToken);
  const nowMs = Date.now();
  let entry = sessionCache.get(tokenHash);

  if (!entry || entry.expiresAtMs < nowMs) {
    const s = await prisma.sessao.findUnique({
      where: { tokenHash },
      include: { utilizador: true },
    });

    if (!s || s.revogadaEm || s.expiraEm.getTime() < nowMs) {
      sessionCache.delete(tokenHash);
      return { ok: false, statusCode: 401, error: 'Sessão inválida ou expirada.' };
    }

    if (s.utilizador && !s.utilizador.ativo) {
      sessionCache.delete(tokenHash);
      return { ok: false, statusCode: 401, error: 'Conta desativada.' };
    }

    let farmacias: AuthorizedPharmacy[] = [];
    if (s.utilizadorId) {
      const vinculos = await prisma.membroFarmacia.findMany({
        where: { utilizadorId: s.utilizadorId, estado: 'ATIVO' },
        include: { farmacia: true },
      });
      farmacias = vinculos
        .filter((v) => v.farmacia && v.farmacia.estado === 'ATIVO')
        .map((v) => ({
          farmaciaId: v.farmaciaId,
          membroId: v.id,
          nome: v.farmacia.nome,
          slug: v.farmacia.slug,
          perfil: v.perfil,
          permissoesExtra: v.permissoesExtra || [],
          farmaciaPadrao: v.farmaciaPadrao,
          estadoFarmacia: v.farmacia.estado,
        }));
    }

    entry = {
      expiresAtMs: nowMs + SESSION_CACHE_TTL_MS,
      session: {
        id: s.id,
        tokenHash: s.tokenHash,
        utilizadorId: s.utilizadorId,
        membroId: s.membroId,
        farmaciaAtivaId: s.farmaciaAtivaId,
        metodo: (s.metodo as MetodoSessao) || 'PASSWORD',
        expiraEm: s.expiraEm,
        revogadaEm: s.revogadaEm,
      },
      user: s.utilizador
        ? {
            id: s.utilizador.id,
            email: s.utilizador.email,
            nome: s.utilizador.nome,
            ativo: s.utilizador.ativo,
            isSuperadmin: s.utilizador.isSuperadmin,
          }
        : null,
      farmacias,
    };

    sessionCache.set(tokenHash, entry);

    // Atualiza ultimoUsoEm em segundo plano sem bloquear o pedido
    prisma.sessao
      .update({ where: { id: s.id }, data: { ultimoUsoEm: new Date() } })
      .catch(() => {});
  }

  const { session, user, farmacias } = entry;

  // Modo Grupo (X-Scope: grupo ou group) — só se rota permitir allowGroup e utilizador tiver ver_grupo
  if (input.requestedScope === 'grupo' || input.requestedScope === 'group') {
    if (!input.allowGroup) {
      return { ok: false, statusCode: 403, error: 'Este recurso não suporta visão de grupo.' };
    }
    const groupAuthorized = farmacias.filter((f) =>
      computeEffectivePermissions(f.perfil, f.permissoesExtra, session.metodo).has('ver_grupo')
    );
    if (groupAuthorized.length === 0) {
      await logSecurityAudit(prisma, {
        evento: 'ACESSO_NEGADO',
        utilizadorId: user?.id,
        ip: input.ip,
        userAgent: input.userAgent,
        detalhes: { reason: 'missing_ver_grupo' },
      });
      return { ok: false, statusCode: 403, error: 'Não tem permissão para visão de grupo.' };
    }

    // Interseção das permissões comuns entre as farmácias do grupo
    const perms = computeEffectivePermissions(groupAuthorized[0].perfil, groupAuthorized[0].permissoesExtra, session.metodo);
    return {
      ok: true,
      ctx: {
        sessionId: session.id,
        utilizadorId: user?.id || null,
        membroId: groupAuthorized[0].membroId,
        email: user?.email || null,
        nome: user?.nome || 'Utilizador',
        isSuperadmin: Boolean(user?.isSuperadmin),
        metodo: session.metodo,
        farmaciaId: null,
        farmaciaIds: groupAuthorized.map((f) => f.farmaciaId),
        scope: 'grupo',
        permissoes: perms,
        farmacias,
      },
    };
  }

  // Modo Superadmin sem farmácia selecionada (apenas para rotas SUPERADMIN; não lê dados de farmácias sem consentimento!)
  if (user?.isSuperadmin && !input.requestedFarmaciaId && farmacias.length === 0) {
    return {
      ok: true,
      ctx: {
        sessionId: session.id,
        utilizadorId: user.id,
        membroId: null,
        email: user.email,
        nome: user.nome,
        isSuperadmin: true,
        metodo: session.metodo,
        farmaciaId: null,
        farmaciaIds: [],
        scope: 'superadmin',
        permissoes: new Set<Permission>(),
        farmacias: [],
      },
    };
  }

  // Resolver farmácia ativa: X-Farmacia-ID (verificado!) ou farmacia_padrao
  const targetFarmId =
    (input.requestedFarmaciaId || '').trim() ||
    farmacias.find((f) => f.farmaciaPadrao)?.farmaciaId ||
    (farmacias.length === 1 ? farmacias[0].farmaciaId : null);

  if (!targetFarmId) {
    // Autenticado mas precisa de selecionar farmácia (ex.: /api/auth/me ou /select-farmacia)
    return {
      ok: true,
      ctx: {
        sessionId: session.id,
        utilizadorId: user?.id || null,
        membroId: null,
        email: user?.email || null,
        nome: user?.nome || 'Utilizador',
        isSuperadmin: Boolean(user?.isSuperadmin),
        metodo: session.metodo,
        farmaciaId: null,
        farmaciaIds: [],
        scope: 'single',
        permissoes: new Set<Permission>(),
        farmacias,
      },
    };
  }

  const matchedLink = farmacias.find((f) => f.farmaciaId === targetFarmId);
  if (!matchedLink) {
    if (user?.isSuperadmin) {
      // Verificar se a farmácia concedeu consentimento ativo de suporte técnico
      const now = new Date();
      const supportConsent = prisma.consentimentoSuporte
        ? await prisma.consentimentoSuporte.findFirst({
            where: {
              farmaciaId: targetFarmId,
              revogadoEm: null,
              expiraEm: { gt: now },
            },
          })
        : null;

      if (supportConsent) {
        // Acesso de suporte concedido em modo READ-ONLY estrito
        return {
          ok: true,
          ctx: {
            sessionId: session.id,
            utilizadorId: user.id,
            membroId: null,
            email: user.email,
            nome: `${user.nome} (Suporte Técnico)`,
            isSuperadmin: true,
            isSupportSession: true,
            metodo: session.metodo,
            farmaciaId: targetFarmId,
            farmaciaIds: [targetFarmId],
            scope: 'single',
            permissoes: new Set<Permission>(['ver_stock_validades', 'ver_custos', 'usar_copilot', 'ver_auditoria']),
            farmacias,
          },
        };
      }
    }

    await logSecurityAudit(prisma, {
      evento: 'ACESSO_NEGADO',
      utilizadorId: user?.id,
      farmaciaId: targetFarmId,
      ip: input.ip,
      userAgent: input.userAgent,
      detalhes: { reason: user?.isSuperadmin ? 'support_consent_required' : 'tenant_not_authorized' },
    });
    return {
      ok: false,
      statusCode: 403,
      error: user?.isSuperadmin
        ? 'Acesso de suporte requer consentimento explícito ativo da farmácia.'
        : 'Não tem acesso a esta farmácia. Fale com o proprietário.',
    };
  }

  const permissoes = computeEffectivePermissions(matchedLink.perfil, matchedLink.permissoesExtra, session.metodo);

  return {
    ok: true,
    ctx: {
      sessionId: session.id,
      utilizadorId: user?.id || null,
      membroId: matchedLink.membroId,
      email: user?.email || null,
      nome: user?.nome || 'Utilizador',
      isSuperadmin: Boolean(user?.isSuperadmin),
      metodo: session.metodo,
      farmaciaId: matchedLink.farmaciaId,
      farmaciaIds: [matchedLink.farmaciaId],
      scope: 'single',
      permissoes,
      farmacias,
    },
  };
}

// ============================================================================
// LOGOUT, LOGOUT-ALL, SWITCH-FARMACIA E CHANGE-PASSWORD
// ============================================================================

export async function logoutSession(
  prisma: PrismaClient,
  rawToken: string,
  meta: { ip?: string; userAgent?: string }
): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashOpaqueToken(rawToken);
  invalidateSessionCacheByHash(tokenHash);

  const s = await prisma.sessao.findUnique({ where: { tokenHash } });
  if (s && !s.revogadaEm) {
    await prisma.sessao.update({
      where: { id: s.id },
      data: { revogadaEm: new Date() },
    });
    await logSecurityAudit(prisma, {
      evento: 'LOGOUT',
      utilizadorId: s.utilizadorId,
      membroId: s.membroId,
      farmaciaId: s.farmaciaAtivaId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}

export async function logoutAllSessions(
  prisma: PrismaClient,
  utilizadorId: string,
  meta: { ip?: string; userAgent?: string }
): Promise<void> {
  invalidateSessionCacheByUser(utilizadorId);
  const now = new Date();
  await Promise.all([
    prisma.sessao.updateMany({
      where: { utilizadorId, revogadaEm: null },
      data: { revogadaEm: now },
    }),
    prisma.dispositivoConfiado.updateMany({
      where: { utilizadorId, revogadoEm: null },
      data: { revogadoEm: now },
    }),
    logSecurityAudit(prisma, {
      evento: 'LOGOUT_ALL',
      utilizadorId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    }),
  ]);
}

export async function switchDefaultFarmacia(
  prisma: PrismaClient,
  utilizadorId: string,
  farmaciaId: string,
  meta: { ip?: string; userAgent?: string }
): Promise<{ ok: boolean; error?: string }> {
  const link = await prisma.membroFarmacia.findFirst({
    where: { utilizadorId, farmaciaId, estado: 'ATIVO' },
  });
  if (!link) {
    await logSecurityAudit(prisma, {
      evento: 'ACESSO_NEGADO',
      utilizadorId,
      farmaciaId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detalhes: { reason: 'switch_farmacia_denied' },
    });
    return { ok: false, error: 'Não tem acesso a esta farmácia. Fale com o proprietário.' };
  }

  await prisma.$transaction([
    prisma.membroFarmacia.updateMany({
      where: { utilizadorId },
      data: { farmaciaPadrao: false },
    }),
    prisma.membroFarmacia.update({
      where: { id: link.id },
      data: { farmaciaPadrao: true },
    }),
  ]);

  invalidateSessionCacheByUser(utilizadorId);
  await logSecurityAudit(prisma, {
    evento: 'SWITCH_FARMACIA',
    utilizadorId,
    membroId: link.id,
    farmaciaId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { ok: true };
}

export async function changeUserPassword(
  prisma: PrismaClient,
  utilizadorId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
  meta: { ip?: string; userAgent?: string }
): Promise<{ ok: boolean; error?: string }> {
  const user = await prisma.utilizador.findUnique({ where: { id: utilizadorId } });
  if (!user || !user.passwordHash) {
    return { ok: false, error: 'Conta inválida.' };
  }

  const ok = await verifyPasswordScrypt(currentPassword, user.passwordHash);
  if (!ok) {
    return { ok: false, error: 'A palavra-passe atual está incorreta.' };
  }

  const policy = await validatePasswordPolicyAsync(newPassword, { email: user.email, nome: user.nome });
  if (!policy.valid) {
    return { ok: false, error: policy.error };
  }

  const newHash = await hashPasswordScrypt(newPassword);
  const now = new Date();

  await prisma.$transaction([
    prisma.utilizador.update({
      where: { id: utilizadorId },
      data: { passwordHash: newHash, passwordAlteradaEm: now },
    }),
    // Revoga todas as OUTRAS sessões do utilizador
    prisma.sessao.updateMany({
      where: { utilizadorId, id: { not: currentSessionId }, revogadaEm: null },
      data: { revogadaEm: now },
    }),
    // Revoga também dispositivos confiados para segurança total após alteração de credenciais
    prisma.dispositivoConfiado.updateMany({
      where: { utilizadorId, revogadoEm: null },
      data: { revogadoEm: now },
    }),
  ]);

  invalidateSessionCacheByUser(utilizadorId);
  await logSecurityAudit(prisma, {
    evento: 'PASSWORD_CHANGED',
    utilizadorId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { ok: true };
}

// ============================================================================
// ONBOARDING DE NOVA FARMÁCIA (POST /api/admin/farmacias — TRANSACIONAL)
// O superadmin cria a farmácia + convite de PROPRIETARIO + auditoria numa só transação.
// Nunca lê dados da farmácia sem consentimentos_suporte.
// ============================================================================

export async function createPharmacyWithOwnerInvite(
  prisma: PrismaClient,
  superadmin: { utilizadorId: string; ip?: string; userAgent?: string },
  input: {
    nome: string;
    nif: string;
    slug: string;
    morada?: string;
    planoSaas?: string;
    ownerNome: string;
    ownerEmail: string;
  }
): Promise<{
  ok: boolean;
  error?: string;
  farmacia?: { id: string; nome: string; nif: string; slug: string };
  inviteToken?: string;
}> {
  const nome = String(input.nome || '').trim();
  const nif = String(input.nif || '').replace(/\D+/g, '');
  const slug = String(input.slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const ownerNome = String(input.ownerNome || '').trim();
  const ownerEmail = String(input.ownerEmail || '').trim().toLowerCase();

  if (!nome || nif.length !== 9) {
    return { ok: false, error: 'Nome da farmácia e NIF válido (9 dígitos) são obrigatórios.' };
  }
  if (!slug || slug.length < 3) {
    return { ok: false, error: 'Slug inválido (mínimo 3 caracteres alfanuméricos).' };
  }
  if (!ownerNome || !ownerEmail.includes('@')) {
    return { ok: false, error: 'Nome e email válidos do proprietário são obrigatórios.' };
  }

  const rawInviteToken = crypto.randomBytes(32).toString('hex');
  const inviteTokenHash = hashOpaqueToken(rawInviteToken);
  const inviteExpires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 horas

  try {
    const created = await prisma.$transaction(async (tx) => {
      const farm = await tx.farmacia.create({
        data: {
          nome,
          nif,
          slug,
          morada: input.morada?.trim() || null,
          estado: 'ATIVO',
          planoSaas: input.planoSaas || 'PILOTO',
        },
      });

      let owner = await tx.utilizador.findUnique({ where: { email: ownerEmail } });
      if (!owner) {
        owner = await tx.utilizador.create({
          data: {
            email: ownerEmail,
            nome: ownerNome,
            ativo: true,
            isSuperadmin: false,
          },
        });
      }

      const membro = await tx.membroFarmacia.create({
        data: {
          utilizadorId: owner.id,
          farmaciaId: farm.id,
          nome: ownerNome,
          perfil: 'PROPRIETARIO',
          farmaciaPadrao: true,
          estado: 'PENDENTE',
        },
      });

      await tx.tokenSeguranca.create({
        data: {
          tipo: 'CONVITE',
          tokenHash: inviteTokenHash,
          utilizadorId: owner.id,
          membroId: membro.id,
          farmaciaId: farm.id,
          expiraEm: inviteExpires,
        },
      });

      await tx.auditoriaSeguranca.create({
        data: {
          evento: 'FARMACIA_CRIADA',
          utilizadorId: superadmin.utilizadorId,
          farmaciaId: farm.id,
          ip: superadmin.ip || null,
          userAgent: superadmin.userAgent || null,
          detalhes: { slug: farm.slug, ownerEmail, planoSaas: farm.planoSaas },
        },
      });

      return farm;
    });

    return {
      ok: true,
      farmacia: {
        id: created.id,
        nome: created.nome,
        nif: created.nif,
        slug: created.slug || slug,
      },
      inviteToken: rawInviteToken,
    };
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return { ok: false, error: 'Já existe uma farmácia com esse NIF ou slug.' };
    }
    return { ok: false, error: err?.message || 'Erro ao criar farmácia.' };
  }
}

/**
 * Convidar membro para uma equipa de farmácia existente
 * Gera token seguro, cria/associa utilizador + membro (PENDENTE), e envia email via Resend
 */
export async function createTeamMemberInvite(
  prisma: PrismaClient,
  inviter: { utilizadorId?: string; farmaciaId: string; ip?: string; userAgent?: string },
  input: {
    nome: string;
    email: string;
    perfil?: string;
  }
): Promise<{
  ok: boolean;
  error?: string;
  inviteToken?: string;
  membro?: any;
}> {
  const cleanEmail = String(input.email || '').trim().toLowerCase();
  const cleanNome = String(input.nome || '').trim();
  const perfil = input.perfil || 'OPERADOR_BALCAO';

  if (!cleanNome || !cleanEmail.includes('@')) {
    return { ok: false, error: 'Nome e email válidos são obrigatórios.' };
  }

  // Rate limiting anti-abuso: máx 10 convites/hora por farmácia e 3 convites/hora por destinatário
  const farmInviteRlKey = `invite_farm:${inviter.farmaciaId}`;
  const farmRl = await checkDbRateLimit(prisma, farmInviteRlKey, 10, 60 * 60 * 1000, true);
  if (!farmRl.allowed) {
    return { ok: false, error: 'Limite de convites por hora para esta farmácia atingido (máx. 10/hora).' };
  }

  const rcptInviteRlKey = `invite_rcpt:${cleanEmail}`;
  const rcptRl = await checkDbRateLimit(prisma, rcptInviteRlKey, 3, 60 * 60 * 1000, true);
  if (!rcptRl.allowed) {
    return { ok: false, error: 'Demasiados convites enviados para este email. Aguarde uma hora.' };
  }

  await recordDbRateLimitHit(prisma, farmInviteRlKey, 60 * 60 * 1000);
  await recordDbRateLimitHit(prisma, rcptInviteRlKey, 60 * 60 * 1000);

  const rawInviteToken = crypto.randomBytes(32).toString('hex');
  const inviteTokenHash = hashOpaqueToken(rawInviteToken);
  const inviteExpires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 horas

  try {
    const res = await prisma.$transaction(async (tx) => {
      let user = await tx.utilizador.findUnique({ where: { email: cleanEmail } });
      if (!user) {
        user = await tx.utilizador.create({
          data: {
            email: cleanEmail,
            nome: cleanNome,
            ativo: true,
            isSuperadmin: false,
          },
        });
      }

      let membro = await tx.membroFarmacia.findFirst({
        where: { utilizadorId: user.id, farmaciaId: inviter.farmaciaId },
      });

      if (membro) {
        if (membro.estado === 'ATIVO') {
          throw new Error('Este utilizador já é membro ativo desta farmácia.');
        }
        membro = await tx.membroFarmacia.update({
          where: { id: membro.id },
          data: {
            nome: cleanNome,
            perfil,
            estado: 'PENDENTE',
          },
        });
      } else {
        membro = await tx.membroFarmacia.create({
          data: {
            utilizadorId: user.id,
            farmaciaId: inviter.farmaciaId,
            nome: cleanNome,
            perfil,
            farmaciaPadrao: false,
            estado: 'PENDENTE',
          },
        });
      }

      await tx.tokenSeguranca.create({
        data: {
          tipo: 'CONVITE',
          tokenHash: inviteTokenHash,
          utilizadorId: user.id,
          membroId: membro.id,
          farmaciaId: inviter.farmaciaId,
          expiraEm: inviteExpires,
        },
      });

      if (inviter.utilizadorId) {
        await tx.auditoriaSeguranca.create({
          data: {
            evento: 'USER_INVITED',
            utilizadorId: inviter.utilizadorId,
            farmaciaId: inviter.farmaciaId,
            ip: inviter.ip || null,
            userAgent: inviter.userAgent || null,
            detalhes: { email: cleanEmail, perfil, membroId: membro.id },
          },
        });
      }

      return { membro, rawInviteToken };
    });

    const farmacia = await prisma.farmacia.findUnique({ where: { id: inviter.farmaciaId } });
    await sendInviteEmail({
      to: cleanEmail,
      nome: cleanNome,
      farmaciaNome: farmacia?.nome || 'Farmácia',
      perfil,
      token: rawInviteToken,
    });

    return {
      ok: true,
      membro: res.membro,
      inviteToken: rawInviteToken,
    };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Falha ao convidar membro da equipa.' };
  }
}

// ============================================================================
// 1. ACEITAR CONVITE DE MEMBRO (POST /api/auth/accept-invite)
// ============================================================================

export async function acceptInviteToken(
  prisma: PrismaClient,
  input: {
    token: string;
    password?: string;
    nome?: string;
    pin?: string;
    sessionUserId?: string;
    ip?: string;
    userAgent?: string;
  }
): Promise<{
  ok: boolean;
  error?: string;
  requiresLogin?: boolean;
  rawSessionToken?: string;
  user?: { id: string; email: string | null; nome: string };
  farmacia?: { id: string; nome: string; perfil: string };
}> {
  const token = String(input.token || '').trim();
  const password = String(input.password || '');
  const ip = input.ip || '127.0.0.1';
  const userAgent = String(input.userAgent || '').slice(0, 250);

  if (!token || token.length < 32) {
    return { ok: false, error: 'Token de convite inválido ou malformado.' };
  }

  const tokenHash = hashOpaqueToken(token);
  const now = new Date();

  const secToken = await prisma.tokenSeguranca.findUnique({
    where: { tokenHash },
  });

  if (!secToken || secToken.tipo !== 'CONVITE' || secToken.usadoEm || secToken.expiraEm < now) {
    return { ok: false, error: 'O convite expirou ou já foi utilizado.' };
  }

  const user = secToken.utilizadorId
    ? await prisma.utilizador.findUnique({ where: { id: secToken.utilizadorId } })
    : null;
  const membro = secToken.membroId
    ? await prisma.membroFarmacia.findUnique({
        where: { id: secToken.membroId },
        include: { farmacia: true },
      })
    : null;

  if (!user || !membro || !membro.farmacia) {
    return { ok: false, error: 'Dados de convite inconsistentes.' };
  }

  // Proteção contra sobrescrita de contas existentes:
  // Se a conta já tiver password, o convite não pode sobrescrevê-la sem autorização!
  const isExistingAccount = Boolean(user.passwordHash);

  if (isExistingAccount) {
    const isAuthenticatedSameUser = Boolean(input.sessionUserId && input.sessionUserId === user.id);
    let isPasswordConfirmed = false;
    if (password && !isAuthenticatedSameUser) {
      isPasswordConfirmed = await verifyPasswordScrypt(password, user.passwordHash!);
    }

    if (!isAuthenticatedSameUser && !isPasswordConfirmed) {
      return {
        ok: false,
        requiresLogin: true,
        error: 'Esta conta já se encontra registada. Inicie sessão com as suas credenciais para associar a nova farmácia.',
      };
    }
  } else {
    // Nova conta: obriga à definição de uma palavra-passe que cumpra a política
    const pwdCheck = await validatePasswordPolicyAsync(password, { email: user.email, nome: input.nome || user.nome });
    if (!pwdCheck.valid) {
      return { ok: false, error: pwdCheck.error };
    }
  }

  let pinHashToSet: string | null = null;
  if (input.pin) {
    const rawPin = String(input.pin).trim();
    if (isTrivialPin(rawPin)) {
      return { ok: false, error: 'O PIN indicado é trivial (sequencial, repetido ou óbvio). Escolha outro PIN.' };
    }
    pinHashToSet = hashPinWithPepper(rawPin, membro.id);
  }

  // Executa ativação transacional
  const txOps: any[] = [];

  if (!isExistingAccount) {
    const passwordHash = await hashPasswordScrypt(password);
    txOps.push(
      prisma.utilizador.update({
        where: { id: user.id },
        data: {
          passwordHash,
          nome: input.nome?.trim() || user.nome,
          ativo: true,
        },
      })
    );
  } else if (input.nome && input.nome.trim() && input.nome.trim() !== user.nome) {
    txOps.push(
      prisma.utilizador.update({
        where: { id: user.id },
        data: { nome: input.nome.trim() },
      })
    );
  }

  txOps.push(
    prisma.membroFarmacia.update({
      where: { id: membro.id },
      data: {
        estado: 'ATIVO',
        ...(pinHashToSet ? { pinHash: pinHashToSet } : {}),
      },
    }),
    prisma.tokenSeguranca.update({
      where: { id: secToken.id },
      data: { usadoEm: now },
    })
  );

  await prisma.$transaction(txOps);

  await logSecurityAudit(prisma, {
    evento: 'INVITE_ACCEPTED',
    utilizadorId: user.id,
    membroId: membro.id,
    farmaciaId: membro.farmaciaId,
    ip,
    userAgent,
    detalhes: { perfil: membro.perfil },
  });

  // Emite sessão imediata para o utilizador entrar autenticado
  const rawSessionToken = crypto.randomBytes(32).toString('hex');
  const sessionTokenHash = hashOpaqueToken(rawSessionToken);
  const sessionExpires = new Date(Date.now() + 12 * 3600 * 1000); // 12h

  await prisma.sessao.create({
    data: {
      tokenHash: sessionTokenHash,
      utilizadorId: user.id,
      membroId: membro.id,
      farmaciaAtivaId: membro.farmaciaId,
      metodo: 'PASSWORD',
      ip,
      userAgent,
      criadaEm: now,
      ultimoUsoEm: now,
      expiraEm: sessionExpires,
    },
  });

  return {
    ok: true,
    rawSessionToken,
    user: { id: user.id, email: user.email, nome: input.nome?.trim() || user.nome },
    farmacia: { id: membro.farmacia.id, nome: membro.farmacia.nome, perfil: membro.perfil },
  };
}

// ============================================================================
// 2. RECUPERAÇÃO DE PASSWORD (POST /api/auth/forgot-password)
// ============================================================================

export async function requestPasswordReset(
  prisma: PrismaClient,
  rawEmail: string,
  meta: { ip?: string; userAgent?: string }
): Promise<{ ok: boolean; message: string }> {
  const cleanEmail = String(rawEmail || '').trim().toLowerCase();
  const genericSuccess = 'Se o endereço de email estiver registado, receberá as instruções de recuperação dentro de momentos.';

  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { ok: true, message: genericSuccess };
  }

  // Rate limiting anti-abuso: 5 pedidos por email em 15 minutos + 10 pedidos por IP
  if (meta.ip) {
    const rlIpKey = `forgot_pwd_ip:${meta.ip}`;
    const rlIp = await checkDbRateLimit(prisma, rlIpKey, 10, 15 * 60 * 1000, true);
    if (!rlIp.allowed) {
      return { ok: false, message: 'Demasiados pedidos de recuperação a partir deste IP. Aguarde 15 minutos.' };
    }
    await recordDbRateLimitHit(prisma, rlIpKey, 15 * 60 * 1000);
  }

  const rlKey = `forgot_pwd:${cleanEmail}`;
  const rl = await checkDbRateLimit(prisma, rlKey, 5, 15 * 60 * 1000, true);
  if (!rl.allowed) {
    return { ok: false, message: 'Demasiados pedidos de recuperação. Aguarde 15 minutos.' };
  }

  const user = await prisma.utilizador.findUnique({
    where: { email: cleanEmail },
  });

  if (!user || !user.ativo) {
    // Timing attack mitigation
    await verifyDummyPasswordScrypt('dummy-delay');
    await recordDbRateLimitHit(prisma, rlKey, 15 * 60 * 1000);
    return { ok: true, message: genericSuccess };
  }

  await recordDbRateLimitHit(prisma, rlKey, 15 * 60 * 1000);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashOpaqueToken(rawToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos (Spec v2.1)

  await prisma.tokenSeguranca.create({
    data: {
      tipo: 'RECUPERACAO',
      tokenHash,
      utilizadorId: user.id,
      expiraEm: expiresAt,
    },
  });

  // Envio de email com Resend
  await sendPasswordResetEmail({
    to: user.email!,
    nome: user.nome,
    token: rawToken,
  });

  await logSecurityAudit(prisma, {
    evento: 'PASSWORD_RESET',
    utilizadorId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detalhes: { stage: 'token_dispatched' },
  });

  return { ok: true, message: genericSuccess };
}

// ============================================================================
// 3. CONSUMO DO TOKEN DE RECUPERAÇÃO (POST /api/auth/reset-password)
// ============================================================================

export async function consumePasswordReset(
  prisma: PrismaClient,
  input: {
    token: string;
    newPassword?: string;
    newPin?: string;
    ip?: string;
    userAgent?: string;
  }
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const token = String(input.token || '').trim();
  const newPassword = String(input.newPassword || '');
  const newPin = String(input.newPin || '').trim();
  const ip = input.ip || '127.0.0.1';
  const userAgent = String(input.userAgent || '').slice(0, 250);

  if (!token || token.length < 32) {
    return { ok: false, error: 'Link de recuperação inválido ou expirado.' };
  }

  const wantsPassword = newPassword.length > 0;
  const wantsPin = newPin.length > 0;

  if (!wantsPassword && !wantsPin) {
    return { ok: false, error: 'Indique uma nova palavra-passe, um novo PIN Mobile, ou ambos.' };
  }

  if (wantsPin) {
    if (!/^[0-9]{4,6}$/.test(newPin)) {
      return { ok: false, error: 'O PIN Mobile deve conter entre 4 e 6 dígitos numéricos.' };
    }
    if (isTrivialPin(newPin)) {
      return {
        ok: false,
        error: 'PIN rejeitado por segurança: evite sequências (1234) ou dígitos repetidos (6666).',
      };
    }
  }

  const tokenHash = hashOpaqueToken(token);
  const now = new Date();

  const secToken = await prisma.tokenSeguranca.findUnique({
    where: { tokenHash },
  });

  if (!secToken || secToken.tipo !== 'RECUPERACAO' || secToken.usadoEm || secToken.expiraEm < now) {
    return { ok: false, error: 'O link de recuperação expirou ou já foi utilizado.' };
  }

  const user = secToken.utilizadorId
    ? await prisma.utilizador.findUnique({ where: { id: secToken.utilizadorId } })
    : null;
  if (!user || !user.ativo) {
    return { ok: false, error: 'Conta associada inválida ou inativa.' };
  }

  let passwordHash: string | null = null;
  if (wantsPassword) {
    const policy = await validatePasswordPolicyAsync(newPassword, { email: user.email, nome: user.nome });
    if (!policy.valid) {
      return { ok: false, error: policy.error };
    }
    passwordHash = await hashPasswordScrypt(newPassword);
  }

  const txOps: any[] = [
    prisma.tokenSeguranca.update({
      where: { id: secToken.id },
      data: { usadoEm: now },
    }),
  ];

  if (wantsPassword && passwordHash) {
    txOps.push(
      prisma.utilizador.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordAlteradaEm: now,
        },
      }),
      // Revoga sessões anteriores para segurança imediata
      prisma.sessao.updateMany({
        where: { utilizadorId: user.id, revogadaEm: null },
        data: { revogadaEm: now },
      }),
      prisma.dispositivoConfiado.updateMany({
        where: { utilizadorId: user.id, revogadoEm: null },
        data: { revogadoEm: now },
      })
    );
  }

  if (wantsPin) {
    const memberships = await prisma.membroFarmacia.findMany({
      where: { utilizadorId: user.id },
      select: { id: true },
    });
    for (const mf of memberships) {
      txOps.push(
        prisma.membroFarmacia.update({
          where: { id: mf.id },
          data: {
            pinHash: hashPinWithPepper(newPin, mf.id),
            pinAlteradoEm: now,
          },
        })
      );
    }

    if (user.email) {
      const legacyMembers = await prisma.membroEquipa.findMany({
        where: {
          email: { equals: user.email, mode: 'insensitive' },
        },
        select: { id: true },
      });
      for (const me of legacyMembers) {
        txOps.push(
          prisma.membroEquipa.update({
            where: { id: me.id },
            data: {
              pinHash: hashPinWithPepper(newPin, me.id),
              pin: '••••',
            },
          })
        );
      }
    }
  }

  await prisma.$transaction(txOps);

  if (wantsPassword) {
    invalidateSessionCacheByUser(user.id);
  }

  await logSecurityAudit(prisma, {
    evento: 'PASSWORD_RESET',
    utilizadorId: user.id,
    ip,
    userAgent,
    detalhes: {
      stage: 'credentials_reset_success',
      changedPassword: wantsPassword,
      changedPin: wantsPin,
    },
  });

  const msg =
    wantsPassword && wantsPin
      ? 'Palavra-passe e PIN Mobile atualizados com sucesso!'
      : wantsPin
      ? 'PIN Mobile atualizado com sucesso! Já pode usar o novo PIN no acesso Mobile.'
      : 'Palavra-passe redefinida com sucesso! Pode agora iniciar sessão.';

  return { ok: true, message: msg };
}
