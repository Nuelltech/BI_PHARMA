import { describe, it, expect, beforeEach } from 'vitest';
import { buildFastifyApp } from '../app_fastify';
import {
  acceptInviteToken,
  requestPasswordReset,
  consumePasswordReset,
  createTeamMemberInvite,
  switchDefaultFarmacia,
} from '../services/auth_service';
import { hashOpaqueToken, hashPinWithPepper } from '../services/security_phase0';
import { hashPasswordScrypt } from '../services/auth_crypto';

function createPhase2MockPrisma() {
  const db = {
    farmacias: [] as any[],
    utilizadores: [] as any[],
    membros: [] as any[],
    sessoes: [] as any[],
    tokens: [] as any[],
    auditoria: [] as any[],
    limites: new Map<string, any>(),
    membrosEquipa: [] as any[],
  };

  const prisma: any = {
    _db: db,
    $extends: () => prisma,
    $transaction: async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      const out = [];
      for (const op of arg) out.push(await op);
      return out;
    },
    farmacia: {
      findUnique: async ({ where }: any) => db.farmacias.find((f) => f.id === where.id) || null,
      findFirst: async ({ where }: any) => db.farmacias.find((f) => (!where.id || f.id === where.id)) || null,
      create: async ({ data }: any) => {
        const item = { id: `farm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.farmacias.push(item);
        return item;
      },
    },
    utilizador: {
      findUnique: async ({ where }: any) => {
        if (where.id) return db.utilizadores.find((u) => u.id === where.id) || null;
        if (where.email) return db.utilizadores.find((u) => u.email === where.email) || null;
        return null;
      },
      findFirst: async ({ where }: any) => db.utilizadores.find((u) => u.email === where.email) || null,
      create: async ({ data }: any) => {
        const item = { id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.utilizadores.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.utilizadores.find((u) => u.id === where.id);
        if (!item) throw new Error('Utilizador não encontrado');
        Object.assign(item, data);
        return item;
      },
    },
    membroFarmacia: {
      findUnique: async ({ where }: any) => {
        const m = db.membros.find((x) => x.id === where.id);
        if (!m) return null;
        const farm = db.farmacias.find((f) => f.id === m.farmaciaId);
        return { ...m, farmacia: farm || { id: m.farmaciaId, nome: 'Farmácia', slug: 'farm', estado: 'ATIVO' } };
      },
      findFirst: async ({ where }: any) => {
        const m = db.membros.find((x) => {
          if (where.id && x.id !== where.id) return false;
          if (where.utilizadorId && x.utilizadorId !== where.utilizadorId) return false;
          if (where.farmaciaId && x.farmaciaId !== where.farmaciaId) return false;
          if (where.estado && x.estado !== where.estado) return false;
          return true;
        });
        if (!m) return null;
        const farm = db.farmacias.find((f) => f.id === m.farmaciaId);
        return { ...m, farmacia: farm || { id: m.farmaciaId, nome: 'Farmácia', slug: 'farm', estado: 'ATIVO' } };
      },
      findMany: async ({ where }: any) => {
        return db.membros.filter((m) => {
          if (where.utilizadorId && m.utilizadorId !== where.utilizadorId) return false;
          if (where.farmaciaId && m.farmaciaId !== where.farmaciaId) return false;
          if (where.estado && m.estado !== where.estado) return false;
          return true;
        }).map((m) => {
          const farm = db.farmacias.find((f) => f.id === m.farmaciaId);
          return { ...m, farmacia: farm || { id: m.farmaciaId, nome: 'Farmácia', slug: 'farm', estado: 'ATIVO' } };
        });
      },
      create: async ({ data }: any) => {
        const item = { id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.membros.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.membros.find((m) => m.id === where.id);
        if (!item) throw new Error('Membro não encontrado');
        Object.assign(item, data);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const m of db.membros) {
          if (where.utilizadorId && m.utilizadorId !== where.utilizadorId) continue;
          if (where.farmaciaId && m.farmaciaId !== where.farmaciaId) continue;
          Object.assign(m, data);
          count++;
        }
        return { count };
      },
    },
    tokenSeguranca: {
      findUnique: async ({ where }: any) => db.tokens.find((t) => t.tokenHash === where.tokenHash) || null,
      create: async ({ data }: any) => {
        const item = { id: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, criadoEm: new Date(), ...data };
        db.tokens.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.tokens.find((t) => t.id === where.id || t.tokenHash === where.tokenHash);
        if (!item) throw new Error('Token não encontrado');
        Object.assign(item, data);
        return item;
      },
    },
    sessao: {
      findUnique: async ({ where, include }: any) => {
        const s = db.sessoes.find((x) => x.tokenHash === where.tokenHash || x.id === where.id);
        if (!s) return null;
        if (include?.utilizador) {
          const u = db.utilizadores.find((x) => x.id === s.utilizadorId);
          return { ...s, utilizador: u || null };
        }
        return s;
      },
      create: async ({ data }: any) => {
        const item = { id: `ses_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, criadoEm: new Date(), ...data };
        db.sessoes.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.sessoes.find((s) => s.id === where.id || s.tokenHash === where.tokenHash);
        if (!item) throw new Error('Sessao não encontrada');
        Object.assign(item, data);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const s of db.sessoes) {
          if (where.utilizadorId && s.utilizadorId !== where.utilizadorId) continue;
          if (where.revogadaEm === null && s.revogadaEm !== null) continue;
          Object.assign(s, data);
          count++;
        }
        return { count };
      },
    },
    auditoriaSeguranca: {
      create: async ({ data }: any) => {
        db.auditoria.push(data);
        return data;
      },
    },
    limiteTaxa: {
      findUnique: async ({ where }: any) => db.limites.get(where.chave) || null,
      upsert: async ({ where, update, create }: any) => {
        const existing = db.limites.get(where.chave);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const created = { id: `rl_${Date.now()}`, chave: where.chave, contador: 1, janelaInicio: new Date(), ...create };
        db.limites.set(where.chave, created);
        return created;
      },
      update: async ({ where, data }: any) => {
        const existing = db.limites.get(where.chave);
        if (existing) {
          Object.assign(existing, data);
          return existing;
        }
        return null;
      },
      deleteMany: async () => ({ count: 0 }),
    },
    membroEquipa: {
      create: async ({ data }: any) => {
        db.membrosEquipa.push(data);
        return data;
      },
    },
    martTenantKpis: {
      findFirst: async () => ({
        total_artigos_inventario: 100,
        total_unidades_stock: 500,
        valor_total_stock_custo: 1250.5,
      }),
    },
  };

  return prisma;
}

describe('Fase 2 — Fluxos de Autenticação, Convites, 15m Reset e Isolamento Multi-Tenant', () => {
  let prisma: any;
  let fastify: any;

  beforeEach(() => {
    prisma = createPhase2MockPrisma();
    const built = buildFastifyApp({
      prisma,
      isProd: false,
      allowedOrigin: 'http://localhost:3000',
    });
    fastify = built.app;
  });

  it('1. GET /accept-invite e /reset-password têm Referrer-Policy: no-referrer e retiram token do histórico', async () => {
    const resInvite = await fastify.inject({
      method: 'GET',
      url: '/accept-invite?token=dummy_token_12345',
    });
    expect(resInvite.statusCode).toBe(200);
    expect(resInvite.body).toContain('name="referrer" content="no-referrer"');
    expect(resInvite.body).toContain('history.replaceState');
    expect(resInvite.body).toContain('Mínimo 10 caracteres');

    const resReset = await fastify.inject({
      method: 'GET',
      url: '/reset-password?token=dummy_token_12345',
    });
    expect(resReset.statusCode).toBe(200);
    expect(resReset.body).toContain('name="referrer" content="no-referrer"');
    expect(resReset.body).toContain('history.replaceState');
    expect(resReset.body).toContain('Mínimo 10 caracteres');
  });

  it('2. POST /api/auth/accept-invite exige 10 caracteres e ativa conta nova sem regras complexas', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Central', nif: '500123456', slug: 'farmacia-central', estado: 'ATIVO' },
    });
    const user = await prisma.utilizador.create({
      data: { email: 'novo.membro@central.pt', nome: 'Membro Central', ativo: true },
    });
    const membro = await prisma.membroFarmacia.create({
      data: {
        utilizadorId: user.id,
        farmaciaId: farm.id,
        nome: 'Membro Central',
        perfil: 'FARMACEUTICO',
        estado: 'PENDENTE',
      },
    });

    const rawToken = 'raw_invite_token_secure_48hours_valid_token_32chars';
    const tokenHash = hashOpaqueToken(rawToken);

    await prisma.tokenSeguranca.create({
      data: {
        tipo: 'CONVITE',
        tokenHash,
        utilizadorId: user.id,
        membroId: membro.id,
        farmaciaId: farm.id,
        expiraEm: new Date(Date.now() + 48 * 3600 * 1000),
      },
    });

    // Menos de 10 caracteres é recusado
    const shortRes = await fastify.inject({
      method: 'POST',
      url: '/api/auth/accept-invite',
      payload: { token: rawToken, password: '9charspwd' },
    });
    expect(shortRes.statusCode).toBe(400);
    expect(shortRes.json().error).toContain('pelo menos 10 caracteres');

    // 10+ caracteres simples (sem obrigar maiúscula/símbolo/número) é aceite
    const validRes = await fastify.inject({
      method: 'POST',
      url: '/api/auth/accept-invite',
      payload: { token: rawToken, password: 'umafraseseguradez' },
    });
    expect(validRes.statusCode).toBe(200);
    expect(validRes.json().ok).toBe(true);
    expect(validRes.headers['set-cookie']).toContain('sid=');

    // Token consumido: replay recusado
    const replayRes = await fastify.inject({
      method: 'POST',
      url: '/api/auth/accept-invite',
      payload: { token: rawToken, password: 'outrafrasesegura' },
    });
    expect(replayRes.statusCode).toBe(400);
  });

  it('3. Conta existente convidada: NÃO permite sobrescrever a password sem autenticação prévia', async () => {
    const farmNova = await prisma.farmacia.create({
      data: { nome: 'Farmácia Secundária', nif: '500999999', slug: 'farm-sec', estado: 'ATIVO' },
    });
    // Utilizador já existente com password definida
    const existingPasswordHash = await hashPasswordScrypt('PasswordOriginal#2025!');
    const existingUser = await prisma.utilizador.create({
      data: {
        email: 'gestor.existente@farmacia.pt',
        nome: 'Dra. Sofia Antunes',
        ativo: true,
        passwordHash: existingPasswordHash,
      },
    });

    const membroPendente = await prisma.membroFarmacia.create({
      data: {
        utilizadorId: existingUser.id,
        farmaciaId: farmNova.id,
        nome: 'Dra. Sofia Antunes',
        perfil: 'GESTOR',
        estado: 'PENDENTE',
      },
    });

    const inviteToken = 'token_convite_conta_existente_32chars_long';
    await prisma.tokenSeguranca.create({
      data: {
        tipo: 'CONVITE',
        tokenHash: hashOpaqueToken(inviteToken),
        utilizadorId: existingUser.id,
        membroId: membroPendente.id,
        farmaciaId: farmNova.id,
        expiraEm: new Date(Date.now() + 48 * 3600 * 1000),
      },
    });

    // 1. Tentativa anónima de definir nova password deve ser recusada com requiresLogin
    const anonRes = await acceptInviteToken(prisma, {
      token: inviteToken,
      password: 'TentativaSobrescrever2026!',
    });
    expect(anonRes.ok).toBe(false);
    expect(anonRes.requiresLogin).toBe(true);

    // Confirma que a password na base de dados NÃO foi alterada
    const checkUser = await prisma.utilizador.findUnique({ where: { id: existingUser.id } });
    expect(checkUser.passwordHash).toBe(existingPasswordHash);

    // 2. Com sessão iniciada do utilizador (sessionUserId), aceita a associação sem alterar a password
    const authRes = await acceptInviteToken(prisma, {
      token: inviteToken,
      sessionUserId: existingUser.id,
    });
    expect(authRes.ok).toBe(true);

    const checkMembro = await prisma.membroFarmacia.findUnique({ where: { id: membroPendente.id } });
    expect(checkMembro.estado).toBe('ATIVO');
    expect(checkUser.passwordHash).toBe(existingPasswordHash); // Password intocada!
  });

  it('4. Autoridade de X-Farmacia-ID: mesma sessão em pedidos a farmácias diferentes tem isolamento estrito', async () => {
    const farmA = await prisma.farmacia.create({
      data: { nome: 'Farmácia Baptista', nif: '505016419', slug: 'baptista', estado: 'ATIVO' },
    });
    const farmB = await prisma.farmacia.create({
      data: { nome: 'Farmácia Avenida', nif: '505016420', slug: 'avenida', estado: 'ATIVO' },
    });
    const farmInacessivel = await prisma.farmacia.create({
      data: { nome: 'Farmácia Terceiros', nif: '505016499', slug: 'terceiros', estado: 'ATIVO' },
    });

    const user = await prisma.utilizador.create({
      data: { email: 'proprietario.grupo@pharma.pt', nome: 'Proprietário Grupo', ativo: true },
    });

    // Vínculos às farmácias A e B
    await prisma.membroFarmacia.create({
      data: { utilizadorId: user.id, farmaciaId: farmA.id, nome: 'Proprietário', perfil: 'PROPRIETARIO', estado: 'ATIVO', farmaciaPadrao: true },
    });
    await prisma.membroFarmacia.create({
      data: { utilizadorId: user.id, farmaciaId: farmB.id, nome: 'Proprietário', perfil: 'PROPRIETARIO', estado: 'ATIVO', farmaciaPadrao: false },
    });

    // Cria sessão ativa
    const rawSessionToken = 'session_token_multi_farm_auth_check_32chars';
    await prisma.sessao.create({
      data: {
        tokenHash: hashOpaqueToken(rawSessionToken),
        utilizadorId: user.id,
        metodo: 'PASSWORD',
        expiraEm: new Date(Date.now() + 12 * 3600 * 1000),
      },
    });

    // 1. Pedido 1: X-Farmacia-ID = Farmácia A
    const resA = await fastify.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: {
        cookie: `sid=${rawSessionToken}`,
        'x-farmacia-id': farmA.id,
      },
    });
    expect(resA.statusCode).toBe(200);
    expect(resA.json().farmaciaId).toBe(farmA.id);

    // 2. Pedido 2: Mesma sessão, X-Farmacia-ID = Farmácia B
    const resB = await fastify.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: {
        cookie: `sid=${rawSessionToken}`,
        'x-farmacia-id': farmB.id,
      },
    });
    expect(resB.statusCode).toBe(200);
    expect(resB.json().farmaciaId).toBe(farmB.id);

    // 3. Pedido 3: Mesma sessão, X-Farmacia-ID = Farmácia Inacessível -> 403 Forbidden
    const resInacessivel = await fastify.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: {
        cookie: `sid=${rawSessionToken}`,
        'x-farmacia-id': farmInacessivel.id,
      },
    });
    expect(resInacessivel.statusCode).toBe(403);
    expect(resInacessivel.json().error).toContain('Não tem acesso a esta farmácia');
  });

  it('5. Validade do reset de password alinhada em 15 minutos + rate-limiting por email e IP', async () => {
    const user = await prisma.utilizador.create({
      data: { email: 'farmaceutica@porto.pt', nome: 'Dra. Inês', ativo: true },
    });

    // Pedido inicial de reset
    const res = await requestPasswordReset(prisma, user.email, { ip: '194.65.20.10' });
    expect(res.ok).toBe(true);

    const tokens = prisma._db.tokens.filter((t: any) => t.tipo === 'RECUPERACAO');
    expect(tokens.length).toBe(1);

    // Verifica que expira em ~15 minutos (entre 14 e 16 minutos a partir de agora)
    const diffMin = (tokens[0].expiraEm.getTime() - Date.now()) / (60 * 1000);
    expect(diffMin).toBeGreaterThan(13);
    expect(diffMin).toBeLessThanOrEqual(15.1);

    // Limite de taxa por email (5 por 15 min): as primeiras passam, a 6ª é bloqueada
    for (let i = 0; i < 4; i++) {
      await requestPasswordReset(prisma, user.email, { ip: '194.65.20.10' });
    }
    const blockedRes = await requestPasswordReset(prisma, user.email, { ip: '194.65.20.10' });
    expect(blockedRes.ok).toBe(false);
    expect(blockedRes.message).toContain('Demasiados pedidos');
  });

  it('6. createTeamMemberInvite impõe teto de convites anti-spam por farmácia e destinatário', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia AntiSpam', nif: '501888777', slug: 'antispam', estado: 'ATIVO' },
    });

    // 3 convites permitidos para o mesmo destinatário
    for (let i = 0; i < 3; i++) {
      const inv = await createTeamMemberInvite(
        prisma,
        { farmaciaId: farm.id },
        { nome: 'Colaborador', email: 'alvo@farmacia.pt', perfil: 'OPERADOR_BALCAO' }
      );
      expect(inv.ok).toBe(true);
    }

    // O 4º convite para o mesmo destinatário no intervalo é bloqueado
    const blockedRcpt = await createTeamMemberInvite(
      prisma,
      { farmaciaId: farm.id },
      { nome: 'Colaborador', email: 'alvo@farmacia.pt', perfil: 'OPERADOR_BALCAO' }
    );
    expect(blockedRcpt.ok).toBe(false);
    expect(blockedRcpt.error).toContain('Demasiados convites enviados para este email');
  });
});
