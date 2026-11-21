import { describe, it, expect } from 'vitest';
import {
  getPharmacyTeam,
  addPharmacyTeamMember,
  updatePharmacyTeamMember,
  deletePharmacyTeamMember,
  getPermissionsForRole,
  recordUserSession,
  getActivePharmacySessions,
  revokeUserSession,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
} from '../services/rbac_settings';
import {
  runWithTenantContext,
  getTenantContext,
  requireTenantContext,
} from '../platform/tenant_context';

describe('Fase 4: Controlo de Acessos (RBAC), Settings e Sessões Ativas', () => {
  const farmId = 'farm_teste_rbac_123';

  // Mock em memória do PrismaClient para os testes unitários
  const db = {
    membros: [] as any[],
    sessoes: [] as any[],
    tokens: [] as any[],
  };

  const mockPrisma: any = {
    membroEquipa: {
      findMany: async ({ where }: any) => {
        return db.membros.filter((m) => m.farmaciaId === where.farmaciaId);
      },
      findFirst: async ({ where }: any) => {
        return db.membros.find((m) => m.id === where.id && m.farmaciaId === where.farmaciaId) || null;
      },
      createMany: async ({ data }: any) => {
        data.forEach((d: any) => {
          db.membros.push({
            id: 'mem_' + Math.random().toString(36).slice(2),
            ...d,
            ativo: true,
            criadoEm: new Date(),
          });
        });
        return { count: data.length };
      },
      create: async ({ data }: any) => {
        const item = {
          id: data.id || 'mem_' + Math.random().toString(36).slice(2),
          ...data,
          ativo: true,
          criadoEm: new Date(),
        };
        db.membros.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = db.membros.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error('Not found');
        db.membros[idx] = { ...db.membros[idx], ...data };
        return db.membros[idx];
      },
      deleteMany: async ({ where }: any) => {
        const before = db.membros.length;
        db.membros = db.membros.filter((m) => !(m.id === where.id && m.farmaciaId === where.farmaciaId));
        return { count: before - db.membros.length };
      },
    },
    sessaoUtilizador: {
      create: async ({ data }: any) => {
        const item = { id: 'sid_' + Math.random().toString(36).slice(2), ...data };
        db.sessoes.push(item);
        return item;
      },
      deleteMany: async ({ where }: any) => {
        if (where?.OR) {
          const before = db.sessoes.length;
          db.sessoes = db.sessoes.filter((s) => {
            const matchId = where.OR.some((c: any) => (c.id && s.id === c.id) || (c.token && s.token === c.token));
            const matchFarm = !where.farmaciaId || s.farmaciaId === where.farmaciaId;
            return !(matchId && matchFarm);
          });
          return { count: before - db.sessoes.length };
        }
        return { count: 0 };
      },
      findMany: async ({ where }: any) => {
        return db.sessoes.filter((s) => s.farmaciaId === where.farmaciaId);
      },
    },
    tokenRecuperacao: {
      create: async ({ data }: any) => {
        const item = { ...data, usadoEm: null, criadoEm: new Date() };
        db.tokens.push(item);
        return item;
      },
      findUnique: async ({ where }: any) => {
        return db.tokens.find((t) => t.token === where.token) || null;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const t of db.tokens) {
          if (t.token === where.token && t.usadoEm === null) {
            Object.assign(t, data);
            count++;
          }
        }
        return { count };
      },
    },
  };

  it('1. Deve inicializar e listar a equipa da farmácia sem PINs por omissão', async () => {
    const team = await getPharmacyTeam(mockPrisma, farmId);
    expect(team.length).toBeGreaterThanOrEqual(3);
    expect(team.some((m) => m.role === 'DIRETOR')).toBe(true);
    expect(team.some((m) => m.role === 'GESTOR')).toBe(true);
    expect(team.some((m) => m.role === 'AUXILIAR')).toBe(true);
    expect(team.every((m) => m.hasPin === false)).toBe(true);
  });

  it('2. Deve permitir convidar novo colaborador com perfil e PIN não trivial (sem devolver PIN em claro)', async () => {
    const { member: novo } = await addPharmacyTeamMember(mockPrisma, farmId, {
      nome: 'Dra. Sofia Ferreira',
      email: 'sofia@farmacia.pt',
      role: 'DIRETOR',
      pin: '4829',
    });

    expect(novo.id).toBeDefined();
    expect(novo.nome).toBe('Dra. Sofia Ferreira');
    expect(novo.email).toBe('sofia@farmacia.pt');
    expect(novo.role).toBe('DIRETOR');
    expect(novo.hasPin).toBe(true);
    expect((novo as any).pin).toBeUndefined();
    expect(novo.ativo).toBe(true);

    const team = await getPharmacyTeam(mockPrisma, farmId);
    expect(team.some((m) => m.id === novo.id)).toBe(true);
  });

  it('3. Deve atualizar e remover colaboradores da equipa', async () => {
    const { member: novo } = await addPharmacyTeamMember(mockPrisma, farmId, {
      nome: 'Pedro Operador',
      email: 'pedro@farmacia.pt',
      role: 'AUXILIAR',
      pin: '3917',
    });

    const atualizado = await updatePharmacyTeamMember(mockPrisma, farmId, novo.id, {
      role: 'GESTOR',
      pin: '8462',
    });

    expect(atualizado?.member.role).toBe('GESTOR');
    expect(atualizado?.member.hasPin).toBe(true);

    const removido = await deletePharmacyTeamMember(mockPrisma, farmId, novo.id);
    expect(removido).toBe(true);

    const team = await getPharmacyTeam(mockPrisma, farmId);
    expect(team.some((m) => m.id === novo.id)).toBe(false);
  });

  it('4. Matriz de Permissões RBAC deve restringir finanças e equipa ao Auxiliar', () => {
    const pAuxiliar = getPermissionsForRole('AUXILIAR');
    expect(pAuxiliar.canViewFinances).toBe(false);
    expect(pAuxiliar.canViewMargins).toBe(false);
    expect(pAuxiliar.canManageTeam).toBe(false);
    expect(pAuxiliar.canTickTasks).toBe(true);

    const pDiretor = getPermissionsForRole('DIRETOR');
    expect(pDiretor.canViewFinances).toBe(true);
    expect(pDiretor.canViewMargins).toBe(true);
    expect(pDiretor.canManageTeam).toBe(false);
    expect(pDiretor.canApproveCampaigns).toBe(true);

    const pGestor = getPermissionsForRole('GESTOR');
    expect(pGestor.canViewFinances).toBe(true);
    expect(pGestor.canManageTeam).toBe(true);
    expect(pGestor.canManageMcpConnectors).toBe(true);

    const pSuporte = getPermissionsForRole('SUPORTE');
    expect(pSuporte.canViewFinances).toBe(false);
    expect(pSuporte.canViewMargins).toBe(false);
    expect(pSuporte.canManageTeam).toBe(true);
    expect(pSuporte.canManageMcpConnectors).toBe(true);
    expect(pSuporte.canTickTasks).toBe(false);
  });

  it('5. Gestão de Sessões Ativas: deve registar, listar e permitir revogação remota', async () => {
    const s1 = await recordUserSession(mockPrisma, {
      farmaciaId: farmId,
      userName: 'Dr. Manuel',
      role: 'DIRETOR',
      ip: '192.168.1.50',
      device: 'Safari iPhone',
    });

    const sessions = await getActivePharmacySessions(mockPrisma, farmId);
    expect(sessions.some((s) => s.sessionId === s1.sessionId)).toBe(true);

    // Revogação
    const revogada = await revokeUserSession(mockPrisma, s1.sessionId);
    expect(revogada).toBe(true);

    const sessionsApos = await getActivePharmacySessions(mockPrisma, farmId);
    expect(sessionsApos.some((s) => s.sessionId === s1.sessionId)).toBe(false);
  });

  it('6. Fluxo de Recuperação de Palavra-Passe: token temporário e consumo de uso único', async () => {
    const token = await createPasswordResetToken(mockPrisma, 'recuperar@farmacia.pt', farmId);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const record = await verifyPasswordResetToken(mockPrisma, token);
    expect(record).not.toBeNull();
    expect(record?.email).toBe('recuperar@farmacia.pt');

    // Consumir
    const consumido = await consumePasswordResetToken(mockPrisma, token);
    expect(consumido).toBe(true);

    // Segunda tentativa deve falhar
    const recordConsumido = await verifyPasswordResetToken(mockPrisma, token);
    expect(recordConsumido).toBeNull();
  });

  it('7. Isolamento Assíncrono de Contexto Multi-Tenant (AsyncLocalStorage TenantContext)', async () => {
    // Fora de um runWithTenantContext, requireTenantContext deve lançar 401
    expect(() => requireTenantContext()).toThrow('Acesso não autorizado');

    // Execuções concorrentes de duas farmácias diferentes devem manter isolamento estrito
    const [resA, resB] = await Promise.all([
      runWithTenantContext(
        {
          authenticated: true,
          role: 'DIRETOR',
          farmaciaId: 'farm-alpha',
          allowedFarmaciaIds: ['farm-alpha'],
        },
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          const ctx = requireTenantContext();
          return `${ctx.farmaciaId}:${ctx.role}`;
        }
      ),
      runWithTenantContext(
        {
          authenticated: true,
          role: 'AUXILIAR',
          farmaciaId: 'farm-beta',
          allowedFarmaciaIds: ['farm-beta'],
        },
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          const ctx = requireTenantContext();
          return `${ctx.farmaciaId}:${ctx.role}`;
        }
      ),
    ]);

    expect(resA).toBe('farm-alpha:DIRETOR');
    expect(resB).toBe('farm-beta:AUXILIAR');
    expect(getTenantContext()).toBeUndefined();
  });
});
