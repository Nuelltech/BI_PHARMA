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

describe('Fase 4: Controlo de Acessos (RBAC), Settings e Sessões Ativas', () => {
  const farmId = 'farm_teste_rbac_123';

  it('1. Deve inicializar e listar a equipa da farmácia com perfis predefinidos', () => {
    const team = getPharmacyTeam(farmId);
    expect(team.length).toBeGreaterThanOrEqual(3);
    expect(team.some(m => m.role === 'DIRETOR')).toBe(true);
    expect(team.some(m => m.role === 'GESTOR')).toBe(true);
    expect(team.some(m => m.role === 'AUXILIAR')).toBe(true);
  });

  it('2. Deve permitir convidar novo colaborador com perfil e PIN', () => {
    const novo = addPharmacyTeamMember(farmId, {
      nome: 'Dra. Sofia Ferreira',
      email: 'sofia@farmacia.pt',
      role: 'DIRETOR',
      pin: '7788',
    });

    expect(novo.id).toBeDefined();
    expect(novo.nome).toBe('Dra. Sofia Ferreira');
    expect(novo.email).toBe('sofia@farmacia.pt');
    expect(novo.role).toBe('DIRETOR');
    expect(novo.pin).toBe('7788');
    expect(novo.ativo).toBe(true);

    const team = getPharmacyTeam(farmId);
    expect(team.some(m => m.id === novo.id)).toBe(true);
  });

  it('3. Deve atualizar e remover colaboradores da equipa', () => {
    const novo = addPharmacyTeamMember(farmId, {
      nome: 'Pedro Operador',
      email: 'pedro@farmacia.pt',
      role: 'AUXILIAR',
      pin: '1122',
    });

    const atualizado = updatePharmacyTeamMember(farmId, novo.id, {
      role: 'GESTOR',
      pin: '9900',
    });

    expect(atualizado?.role).toBe('GESTOR');
    expect(atualizado?.pin).toBe('9900');

    const removido = deletePharmacyTeamMember(farmId, novo.id);
    expect(removido).toBe(true);

    const team = getPharmacyTeam(farmId);
    expect(team.some(m => m.id === novo.id)).toBe(false);
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
  });

  it('5. Gestão de Sessões Ativas: deve registar, listar e permitir revogação remota', () => {
    const s1 = recordUserSession({
      farmaciaId: farmId,
      userName: 'Dr. Manuel',
      role: 'DIRETOR',
      ip: '192.168.1.50',
      device: 'Safari iPhone',
    });

    const sessions = getActivePharmacySessions(farmId);
    expect(sessions.some(s => s.sessionId === s1.sessionId)).toBe(true);

    // Revogação
    const revogada = revokeUserSession(s1.sessionId);
    expect(revogada).toBe(true);

    const sessionsApos = getActivePharmacySessions(farmId);
    expect(sessionsApos.some(s => s.sessionId === s1.sessionId)).toBe(false);
  });

  it('6. Fluxo de Recuperação de Palavra-Passe: token temporário e consumo de uso único', () => {
    const token = createPasswordResetToken('recuperar@farmacia.pt', farmId);
    expect(token.startsWith('rst_')).toBe(true);

    const record = verifyPasswordResetToken(token);
    expect(record).not.toBeNull();
    expect(record?.email).toBe('recuperar@farmacia.pt');

    // Consumir
    const consumido = consumePasswordResetToken(token);
    expect(consumido).toBe(true);

    // Segunda tentativa deve falhar
    const recordConsumido = verifyPasswordResetToken(token);
    expect(recordConsumido).toBeNull();
  });
});
