import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  validateNewPin,
  hashPinWithPepper,
  verifyPinHash,
  generateTemporaryPin,
  hashOpaqueToken,
  checkDbRateLimit,
  recordDbRateLimitHit,
  resetDbRateLimit,
} from './security_phase0';

export type UserRole = 'AUXILIAR' | 'DIRETOR' | 'GESTOR' | 'SUPORTE';

export interface PharmacyTeamMember {
  id: string;
  farmaciaId: string;
  nome: string;
  email: string;
  role: UserRole;
  hasPin: boolean;
  pinTemporario: boolean;
  pinAlteradoEm?: Date;
  pinBloqueadoAte?: Date;
  ativo: boolean;
  criadoEm: Date;
  ultimoAcessoEm?: Date;
}

export interface ActiveUserSession {
  sessionId: string;
  farmaciaId: string;
  userId?: string;
  userName: string;
  userEmail?: string;
  role: UserRole;
  ip: string;
  device: string;
  loginAt: Date;
  lastSeenAt: Date;
}

export interface PasswordResetToken {
  email: string;
  farmaciaId?: string;
  expiresAt: number;
}

export interface PinVerificationResult {
  valid: boolean;
  error?: string;
  lockedUntil?: Date;
  requiresPinChange?: boolean;
  member?: PharmacyTeamMember;
}

// ============================================================================
// GESTÃO DE EQUIPA (PERSISTIDO EM POSTGRESQL — SEM PINS EM TEXTO CLARO)
// ============================================================================

export async function getPharmacyTeam(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<PharmacyTeamMember[]> {
  const rows = await prisma.membroEquipa.findMany({
    where: { farmaciaId },
    orderBy: { criadoEm: 'asc' },
  });

  if (rows.length === 0) {
    // Inicializar estrutura base da equipa SEM qualquer PIN por omissão (Fase 0)
    const defaults = [
      {
        farmaciaId,
        nome: 'Diretor Técnico',
        email: `direcao@${farmaciaId.slice(0, 6)}.pt`,
        role: 'DIRETOR',
        pin: null,
        pinHash: null,
      },
      {
        farmaciaId,
        nome: 'Gestor de Turno',
        email: `gestao@${farmaciaId.slice(0, 6)}.pt`,
        role: 'GESTOR',
        pin: null,
        pinHash: null,
      },
      {
        farmaciaId,
        nome: 'Colaborador Balcão',
        email: `balcao@${farmaciaId.slice(0, 6)}.pt`,
        role: 'AUXILIAR',
        pin: null,
        pinHash: null,
      },
    ];

    await prisma.membroEquipa.createMany({
      data: defaults,
      skipDuplicates: true,
    });

    const refreshed = await prisma.membroEquipa.findMany({
      where: { farmaciaId },
      orderBy: { criadoEm: 'asc' },
    });
    return refreshed.map(mapMember);
  }

  return rows.map(mapMember);
}

function mapMember(r: any): PharmacyTeamMember {
  return {
    id: r.id,
    farmaciaId: r.farmaciaId,
    nome: r.nome,
    email: r.email,
    role: (r.role as UserRole) || 'AUXILIAR',
    hasPin: Boolean(r.pinHash),
    pinTemporario: Boolean(r.pinTemporario),
    pinAlteradoEm: r.pinAlteradoEm || undefined,
    pinBloqueadoAte: r.pinBloqueadoAte || undefined,
    ativo: r.ativo,
    criadoEm: r.criadoEm,
    ultimoAcessoEm: r.ultimoAcessoEm || undefined,
  };
}

export async function addPharmacyTeamMember(
  prisma: PrismaClient,
  farmaciaId: string,
  params: { nome: string; email: string; role: UserRole; pin?: string; generatePin?: boolean }
): Promise<{ member: PharmacyTeamMember; temporaryPin?: string }> {
  const cleanEmail = params.email.trim().toLowerCase();
  const cleanNome = params.nome.trim();

  // Se o colaborador já existiu nesta farmácia (ex.: foi removido anteriormente), reativa-o em vez de falhar Unique constraint
  const existing = await prisma.membroEquipa.findUnique({
    where: { farmaciaId_email: { farmaciaId, email: cleanEmail } },
  });
  const memberId = existing ? existing.id : crypto.randomUUID();

  let pinHash: string | null = existing?.pinHash ?? null;
  let pinTemporario = false;
  let temporaryPin: string | undefined;

  if (params.pin && params.pin.trim().length > 0) {
    const check = validateNewPin(params.pin);
    if (!check.valid) {
      throw new Error(check.error || 'PIN inválido.');
    }
    pinHash = hashPinWithPepper(params.pin.trim(), memberId);
    pinTemporario = false;
  } else if (params.generatePin) {
    temporaryPin = generateTemporaryPin();
    pinHash = hashPinWithPepper(temporaryPin, memberId);
    pinTemporario = true;
  }

  const saved = existing
    ? await prisma.membroEquipa.update({
        where: { id: memberId },
        data: {
          nome: cleanNome,
          role: params.role || existing.role || 'AUXILIAR',
          pin: null,
          pinHash,
          pinAlteradoEm: pinHash ? new Date() : existing.pinAlteradoEm,
          pinFalhas: 0,
          pinBloqueadoAte: null,
          pinTemporario,
          ativo: true,
        },
      })
    : await prisma.membroEquipa.create({
        data: {
          id: memberId,
          farmaciaId,
          nome: cleanNome,
          email: cleanEmail,
          role: params.role || 'AUXILIAR',
          pin: null,
          pinHash,
          pinAlteradoEm: pinHash ? new Date() : null,
          pinFalhas: 0,
          pinBloqueadoAte: null,
          pinTemporario,
          ativo: true,
        },
      });

  return { member: mapMember(saved), temporaryPin };
}

export async function updatePharmacyTeamMember(
  prisma: PrismaClient,
  farmaciaId: string,
  userId: string,
  updates: {
    nome?: string;
    email?: string;
    role?: UserRole;
    pin?: string;
    resetPin?: boolean;
    ativo?: boolean;
  }
): Promise<{ member: PharmacyTeamMember; temporaryPin?: string } | null> {
  const existing = await prisma.membroEquipa.findFirst({
    where: { id: userId, farmaciaId },
  });
  if (!existing) return null;

  const data: any = {};
  let temporaryPin: string | undefined;

  if (updates.nome !== undefined) data.nome = updates.nome.trim();
  if (updates.email !== undefined) data.email = updates.email.trim().toLowerCase();
  if (updates.role !== undefined) data.role = updates.role;
  if (updates.ativo !== undefined) data.ativo = updates.ativo;

  if (updates.resetPin) {
    temporaryPin = generateTemporaryPin();
    data.pin = null;
    data.pinHash = hashPinWithPepper(temporaryPin, existing.id);
    data.pinAlteradoEm = new Date();
    data.pinFalhas = 0;
    data.pinBloqueadoAte = null;
    data.pinTemporario = true;
  } else if (updates.pin !== undefined && updates.pin.trim().length > 0) {
    const check = validateNewPin(updates.pin);
    if (!check.valid) {
      throw new Error(check.error || 'PIN inválido.');
    }
    data.pin = null;
    data.pinHash = hashPinWithPepper(updates.pin.trim(), existing.id);
    data.pinAlteradoEm = new Date();
    data.pinFalhas = 0;
    data.pinBloqueadoAte = null;
    data.pinTemporario = false;
  }

  const updated = await prisma.membroEquipa.update({
    where: { id: existing.id },
    data,
  });

  return { member: mapMember(updated), temporaryPin };
}

export async function deletePharmacyTeamMember(
  prisma: PrismaClient,
  farmaciaId: string,
  userId: string
): Promise<boolean> {
  const res = await prisma.membroEquipa.deleteMany({
    where: { id: userId, farmaciaId },
  });
  return res.count > 0;
}

// ============================================================================
// VERIFICAÇÃO SEGURA DE PIN DE BALCÃO (HMAC + PEPPER + BLOQUEIO 5 FALHAS / 15M)
// ============================================================================

const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const PIN_BASE_BLOCK_MS = 5 * 60 * 1000; // 5 minutos (duplica a cada bloqueio adicional)

export async function verifyMemberPin(
  prisma: PrismaClient,
  farmaciaId: string,
  rawPin: string,
  memberId?: string
): Promise<PinVerificationResult> {
  const cleanPin = String(rawPin || '').trim();
  if (!/^\d{4,6}$/.test(cleanPin)) {
    return { valid: false, error: 'PIN inválido.' };
  }

  const scopeKey = memberId
    ? `pin:member:${farmaciaId}:${memberId}`
    : `pin:farm:${farmaciaId}`;

  const rlCheck = await checkDbRateLimit(prisma, scopeKey, PIN_MAX_ATTEMPTS, PIN_WINDOW_MS);
  if (!rlCheck.allowed) {
    const mins = Math.max(1, Math.ceil(rlCheck.retryAfterSec / 60));
    return {
      valid: false,
      error: `Demasiadas tentativas de PIN incorreto. Tente novamente dentro de ${mins} minuto(s).`,
      lockedUntil: new Date(Date.now() + rlCheck.retryAfterSec * 1000),
    };
  }

  const candidates = await prisma.membroEquipa.findMany({
    where: {
      farmaciaId,
      ativo: true,
      pinHash: { not: null },
      ...(memberId ? { id: memberId } : {}),
    },
  });

  if (candidates.length === 0) {
    return {
      valid: false,
      error: 'Nenhum PIN configurado nesta farmácia. Peça ao gestor para definir o PIN em Definições.',
    };
  }

  const now = new Date();

  // Verificar se o membro específico está bloqueado
  if (memberId && candidates[0]?.pinBloqueadoAte && candidates[0].pinBloqueadoAte > now) {
    const mins = Math.max(1, Math.ceil((candidates[0].pinBloqueadoAte.getTime() - now.getTime()) / 60000));
    return {
      valid: false,
      error: `PIN temporariamente bloqueado. Aguarde ${mins} minuto(s) ou peça reposição ao gestor.`,
      lockedUntil: candidates[0].pinBloqueadoAte,
    };
  }

  let matched: any = null;
  for (const m of candidates) {
    if (m.pinBloqueadoAte && m.pinBloqueadoAte > now) continue;
    if (verifyPinHash(cleanPin, m.id, m.pinHash)) {
      matched = m;
      break;
    }
  }

  if (matched) {
    await resetDbRateLimit(prisma, scopeKey);
    const updated = await prisma.membroEquipa.update({
      where: { id: matched.id },
      data: {
        pinFalhas: 0,
        pinBloqueadoAte: null,
        ultimoAcessoEm: now,
      },
    });
    return {
      valid: true,
      requiresPinChange: Boolean(updated.pinTemporario),
      member: mapMember(updated),
    };
  }

  // Falha: registar tentativa em Postgres e incrementar contador do membro se especificado
  const hit = await recordDbRateLimitHit(prisma, scopeKey, PIN_WINDOW_MS, {
    maxBeforeBlock: PIN_MAX_ATTEMPTS,
    baseBlockMs: PIN_BASE_BLOCK_MS,
  });

  if (memberId && candidates[0]) {
    const m = candidates[0];
    const nextFails = (m.pinFalhas || 0) + 1;
    let blockedUntil: Date | null = null;
    if (nextFails >= PIN_MAX_ATTEMPTS) {
      const mult = Math.min(8, Math.pow(2, nextFails - PIN_MAX_ATTEMPTS));
      blockedUntil = new Date(now.getTime() + PIN_BASE_BLOCK_MS * mult);
      console.warn(
        JSON.stringify({
          evento: 'PIN_BLOQUEADO',
          ts: now.toISOString(),
          farmaciaId,
          memberId: m.id,
          tentativas: nextFails,
          bloqueadoAte: blockedUntil.toISOString(),
        })
      );
    }
    await prisma.membroEquipa.update({
      where: { id: m.id },
      data: {
        pinFalhas: nextFails,
        pinBloqueadoAte: blockedUntil,
      },
    });
  } else if (hit.blockedUntil) {
    console.warn(
      JSON.stringify({
        evento: 'PIN_BLOQUEADO',
        ts: now.toISOString(),
        farmaciaId,
        scope: scopeKey,
        tentativas: hit.count,
        bloqueadoAte: hit.blockedUntil.toISOString(),
      })
    );
  }

  if (hit.blockedUntil) {
    const mins = Math.max(1, Math.ceil((hit.blockedUntil.getTime() - now.getTime()) / 60000));
    return {
      valid: false,
      error: `Demasiadas tentativas falhadas. Acesso por PIN bloqueado durante ${mins} minuto(s).`,
      lockedUntil: hit.blockedUntil,
    };
  }

  return { valid: false, error: 'PIN incorreto.' };
}

/**
 * Troca obrigatória do PIN temporário (ou voluntária pelo operador).
 * Valida o PIN atual, recusa PINs triviais e impede reaproveitar o PIN anterior/temporário.
 */
export async function changeMemberPin(
  prisma: PrismaClient,
  farmaciaId: string,
  memberId: string,
  currentPin: string,
  newPin: string
): Promise<{ ok: boolean; error?: string; member?: PharmacyTeamMember }> {
  const member = await prisma.membroEquipa.findFirst({
    where: { id: memberId, farmaciaId, ativo: true },
  });
  if (!member || !member.pinHash) {
    return { ok: false, error: 'Colaborador não encontrado ou sem PIN configurado.' };
  }

  if (!verifyPinHash(currentPin, member.id, member.pinHash)) {
    return { ok: false, error: 'PIN atual incorreto.' };
  }

  const check = validateNewPin(newPin);
  if (!check.valid) {
    return { ok: false, error: check.error || 'Novo PIN inválido.' };
  }

  // Impedir reaproveitamento do PIN temporário/atual
  if (verifyPinHash(newPin, member.id, member.pinHash)) {
    return { ok: false, error: 'O novo PIN tem de ser diferente do PIN temporário/anterior.' };
  }

  const updated = await prisma.membroEquipa.update({
    where: { id: member.id },
    data: {
      pin: null,
      pinHash: hashPinWithPepper(newPin.trim(), member.id),
      pinAlteradoEm: new Date(),
      pinFalhas: 0,
      pinBloqueadoAte: null,
      pinTemporario: false,
    },
  });

  return { ok: true, member: mapMember(updated) };
}

// ============================================================================
// GESTÃO DE SESSÕES ATIVAS (PERSISTIDAS EM POSTGRESQL)
// ============================================================================

export async function recordUserSession(
  prisma: PrismaClient,
  session: {
    sessionId?: string;
    farmaciaId: string;
    userName: string;
    userEmail?: string;
    role: UserRole;
    ip: string;
    device: string;
  }
): Promise<ActiveUserSession> {
  const token = session.sessionId || 'sess_' + crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiraEm = new Date(now.getTime() + 8 * 60 * 60 * 1000); // 8 horas

  const s = await prisma.sessaoUtilizador.create({
    data: {
      token: hashOpaqueToken(token),
      farmaciaId: session.farmaciaId,
      userName: session.userName,
      userEmail: session.userEmail || null,
      role: session.role,
      ip: session.ip || '127.0.0.1',
      device: session.device || 'Desconhecido',
      criadoEm: now,
      ultimoAcessoEm: now,
      expiraEm,
    },
  });

  return {
    sessionId: s.id,
    farmaciaId: s.farmaciaId,
    userName: s.userName,
    userEmail: s.userEmail || undefined,
    role: (s.role as UserRole) || 'AUXILIAR',
    ip: s.ip || '127.0.0.1',
    device: s.device || 'Desconhecido',
    loginAt: s.criadoEm,
    lastSeenAt: s.ultimoAcessoEm,
  };
}

export async function touchUserSession(prisma: PrismaClient, token: string): Promise<void> {
  const hashed = hashOpaqueToken(token);
  await prisma.sessaoUtilizador
    .update({
      where: { token: hashed },
      data: { ultimoAcessoEm: new Date() },
    })
    .catch(() => {});
}

export async function getActivePharmacySessions(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<ActiveUserSession[]> {
  const now = new Date();
  await prisma.sessaoUtilizador
    .deleteMany({
      where: { expiraEm: { lt: now } },
    })
    .catch(() => {});

  const rows = await prisma.sessaoUtilizador.findMany({
    where: { farmaciaId, expiraEm: { gte: now } },
    orderBy: { ultimoAcessoEm: 'desc' },
  });

  return rows.map((s) => ({
    sessionId: s.id,
    farmaciaId: s.farmaciaId,
    userName: s.userName,
    userEmail: s.userEmail || undefined,
    role: (s.role as UserRole) || 'AUXILIAR',
    ip: s.ip || '127.0.0.1',
    device: s.device || 'Desconhecido',
    loginAt: s.criadoEm,
    lastSeenAt: s.ultimoAcessoEm,
  }));
}

export async function revokeUserSession(
  prisma: PrismaClient,
  sessionIdOrToken: string,
  farmaciaId?: string
): Promise<boolean> {
  try {
    const hashed = hashOpaqueToken(sessionIdOrToken);
    const res = await prisma.sessaoUtilizador.deleteMany({
      where: {
        OR: [{ id: sessionIdOrToken }, { token: hashed }, { token: sessionIdOrToken }],
        ...(farmaciaId ? { farmaciaId } : {}),
      },
    });
    return res.count > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// FLUXO DE RECUPERAÇÃO DE PALAVRA-PASSE (APENAS HASH SHA-256 EM POSTGRESQL)
// ============================================================================

export async function createPasswordResetToken(
  prisma: PrismaClient,
  email: string,
  farmaciaId?: string
): Promise<string> {
  const cleanEmail = email.trim().toLowerCase();
  // 256 bits aleatórios; devolvido apenas ao chamador (envio de email), nunca guardado em claro
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashOpaqueToken(rawToken);
  const expiraEm = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

  await prisma.tokenRecuperacao.create({
    data: {
      token: tokenHash,
      email: cleanEmail,
      farmaciaId: farmaciaId || null,
      expiraEm,
    },
  });

  return rawToken;
}

export async function verifyPasswordResetToken(
  prisma: PrismaClient,
  rawToken: string
): Promise<PasswordResetToken | null> {
  if (!rawToken || rawToken.trim().length < 16) return null;
  const tokenHash = hashOpaqueToken(rawToken.trim());
  const record = await prisma.tokenRecuperacao.findUnique({
    where: { token: tokenHash },
  });

  if (!record) return null;
  if (record.usadoEm !== null || record.expiraEm.getTime() < Date.now()) {
    return null;
  }

  return {
    email: record.email,
    farmaciaId: record.farmaciaId || undefined,
    expiresAt: record.expiraEm.getTime(),
  };
}

export async function consumePasswordResetToken(
  prisma: PrismaClient,
  rawToken: string
): Promise<boolean> {
  try {
    const tokenHash = hashOpaqueToken(rawToken.trim());
    const res = await prisma.tokenRecuperacao.updateMany({
      where: { token: tokenHash, usadoEm: null },
      data: { usadoEm: new Date() },
    });
    return res.count > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// MATRIZ DE PERMISSÕES RBAC
// ============================================================================

export interface RolePermissions {
  canViewFinances: boolean;
  canViewMargins: boolean;
  canManageTeam: boolean;
  canApproveCampaigns: boolean;
  canManageMcpConnectors: boolean;
  canTickTasks: boolean;
}

export function getPermissionsForRole(role: UserRole): RolePermissions {
  switch (role) {
    case 'AUXILIAR':
      return {
        canViewFinances: false,
        canViewMargins: false,
        canManageTeam: false,
        canApproveCampaigns: false,
        canManageMcpConnectors: false,
        canTickTasks: true,
      };
    case 'DIRETOR':
      return {
        canViewFinances: true,
        canViewMargins: true,
        canManageTeam: false,
        canApproveCampaigns: true,
        canManageMcpConnectors: false,
        canTickTasks: true,
      };
    case 'GESTOR':
      return {
        canViewFinances: true,
        canViewMargins: true,
        canManageTeam: true,
        canApproveCampaigns: true,
        canManageMcpConnectors: true,
        canTickTasks: true,
      };
    case 'SUPORTE':
      return {
        canViewFinances: false,
        canViewMargins: false,
        canManageTeam: true,
        canApproveCampaigns: false,
        canManageMcpConnectors: true,
        canTickTasks: false,
      };
  }
}
