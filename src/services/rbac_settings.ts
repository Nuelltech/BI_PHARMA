import crypto from 'crypto';

export type UserRole = 'AUXILIAR' | 'DIRETOR' | 'GESTOR' | 'SUPORTE';

export interface PharmacyTeamMember {
  id: string;
  farmaciaId: string;
  nome: string;
  email: string;
  role: UserRole;
  pin: string;
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
  token: string;
  email: string;
  farmaciaId?: string;
  expiresAt: number;
}

// Armazenamento em memória (persiste durante o ciclo de vida do servidor)
const teamMembersStore = new Map<string, PharmacyTeamMember[]>();
const activeSessionsStore = new Map<string, ActiveUserSession>();
const passwordResetTokens = new Map<string, PasswordResetToken>();

// Membros pré-configurados por omissão para testes
function initDefaultTeam(farmaciaId: string): PharmacyTeamMember[] {
  return [
    {
      id: 'usr_dir_' + farmaciaId.slice(0, 6),
      farmaciaId,
      nome: 'Diretor Técnico',
      email: 'direcao@farmacia.pt',
      role: 'DIRETOR',
      pin: '9876',
      ativo: true,
      criadoEm: new Date(),
    },
    {
      id: 'usr_gest_' + farmaciaId.slice(0, 6),
      farmaciaId,
      nome: 'Gestor de Operações',
      email: 'gestao@farmacia.pt',
      role: 'GESTOR',
      pin: '5566',
      ativo: true,
      criadoEm: new Date(),
    },
    {
      id: 'usr_aux_' + farmaciaId.slice(0, 6),
      farmaciaId,
      nome: 'Colaborador Balcão',
      email: 'balcao@farmacia.pt',
      role: 'AUXILIAR',
      pin: '1234',
      ativo: true,
      criadoEm: new Date(),
    },
  ];
}

export function getPharmacyTeam(farmaciaId: string): PharmacyTeamMember[] {
  if (!teamMembersStore.has(farmaciaId)) {
    teamMembersStore.set(farmaciaId, initDefaultTeam(farmaciaId));
  }
  return teamMembersStore.get(farmaciaId) || [];
}

export function addPharmacyTeamMember(
  farmaciaId: string,
  params: { nome: string; email: string; role: UserRole; pin?: string }
): PharmacyTeamMember {
  const team = getPharmacyTeam(farmaciaId);
  const newMember: PharmacyTeamMember = {
    id: 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    farmaciaId,
    nome: params.nome.trim(),
    email: params.email.trim().toLowerCase(),
    role: params.role || 'AUXILIAR',
    pin: params.pin ? params.pin.trim() : Math.floor(1000 + Math.random() * 9000).toString(),
    ativo: true,
    criadoEm: new Date(),
  };
  team.push(newMember);
  teamMembersStore.set(farmaciaId, team);
  return newMember;
}

export function updatePharmacyTeamMember(
  farmaciaId: string,
  userId: string,
  updates: Partial<Pick<PharmacyTeamMember, 'nome' | 'email' | 'role' | 'pin' | 'ativo'>>
): PharmacyTeamMember | null {
  const team = getPharmacyTeam(farmaciaId);
  const idx = team.findIndex(m => m.id === userId);
  if (idx === -1) return null;

  const current = team[idx];
  team[idx] = {
    ...current,
    ...updates,
    nome: updates.nome ? updates.nome.trim() : current.nome,
    email: updates.email ? updates.email.trim().toLowerCase() : current.email,
  };
  teamMembersStore.set(farmaciaId, team);
  return team[idx];
}

export function deletePharmacyTeamMember(farmaciaId: string, userId: string): boolean {
  const team = getPharmacyTeam(farmaciaId);
  const filtered = team.filter(m => m.id !== userId);
  if (filtered.length === team.length) return false;
  teamMembersStore.set(farmaciaId, filtered);
  return true;
}

// ============================================================================
// GESTÃO DE SESSÕES ATIVAS
// ============================================================================

export function recordUserSession(session: {
  sessionId?: string;
  farmaciaId: string;
  userName: string;
  userEmail?: string;
  role: UserRole;
  ip: string;
  device: string;
}): ActiveUserSession {
  const sid = session.sessionId || 'sess_' + crypto.randomBytes(16).toString('hex');
  const record: ActiveUserSession = {
    sessionId: sid,
    farmaciaId: session.farmaciaId,
    userName: session.userName,
    userEmail: session.userEmail,
    role: session.role,
    ip: session.ip || '127.0.0.1',
    device: session.device || 'Desconhecido',
    loginAt: new Date(),
    lastSeenAt: new Date(),
  };
  activeSessionsStore.set(sid, record);
  return record;
}

export function touchUserSession(sessionId: string): void {
  const s = activeSessionsStore.get(sessionId);
  if (s) {
    s.lastSeenAt = new Date();
  }
}

export function getActivePharmacySessions(farmaciaId: string): ActiveUserSession[] {
  const list: ActiveUserSession[] = [];
  const now = Date.now();
  const MAX_INACTIVE_MS = 8 * 60 * 60 * 1000; // 8 horas

  for (const [sid, s] of activeSessionsStore.entries()) {
    if (now - s.lastSeenAt.getTime() > MAX_INACTIVE_MS) {
      activeSessionsStore.delete(sid);
      continue;
    }
    if (s.farmaciaId === farmaciaId) {
      list.push(s);
    }
  }
  return list.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

export function revokeUserSession(sessionId: string): boolean {
  return activeSessionsStore.delete(sessionId);
}

// ============================================================================
// FLUXO DE RECUPERAÇÃO DE PALAVRA-PASSE POR EMAIL
// ============================================================================

export function createPasswordResetToken(email: string, farmaciaId?: string): string {
  const cleanEmail = email.trim().toLowerCase();
  const token = 'rst_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutos

  passwordResetTokens.set(token, {
    token,
    email: cleanEmail,
    farmaciaId,
    expiresAt,
  });

  return token;
}

export function verifyPasswordResetToken(token: string): PasswordResetToken | null {
  const record = passwordResetTokens.get(token);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    passwordResetTokens.delete(token);
    return null;
  }
  return record;
}

export function consumePasswordResetToken(token: string): boolean {
  return passwordResetTokens.delete(token);
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
