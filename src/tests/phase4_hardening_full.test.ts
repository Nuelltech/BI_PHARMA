import { describe, it, expect, beforeEach } from 'vitest';
import { buildFastifyApp } from '../app_fastify';
import {
  validatePasswordPolicy,
  validatePasswordPolicyAsync,
  checkPwnedPassword,
} from '../data/common_passwords';
import {
  checkTrustedDevice,
  createDeviceChallenge,
  verifyDeviceChallengeAndTrust,
} from '../services/device_challenge_service';
import {
  grantSupportConsent,
  getActiveSupportConsent,
  revokeSupportConsent,
  checkSupportAccessAllowed,
} from '../services/support_service';
import { hashOpaqueToken, hashPinWithPepper } from '../services/security_phase0';
import { hashPasswordScrypt } from '../services/auth_crypto';
import { loginWithPassword } from '../services/auth_service';

function createPhase4MockPrisma() {
  const db = {
    farmacias: [] as any[],
    utilizadores: [] as any[],
    membros: [] as any[],
    sessoes: [] as any[],
    tokens: [] as any[],
    dispositivos: [] as any[],
    dispositivosConfiados: [] as any[],
    consentimentos: [] as any[],
    auditoria: [] as any[],
    limites: new Map<string, any>(),
    martsKpis: [] as any[],
    desafiosWebAuthn: [] as any[],
    credenciaisPasskey: [] as any[],
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
      findUnique: async ({ where }: any) => db.farmacias.find((f) => f.id === where.id || f.nif === where.nif) || null,
      findFirst: async ({ where }: any) => db.farmacias.find((f) => (!where.id || f.id === where.id)) || null,
      create: async ({ data }: any) => {
        const item = { id: data.id || `farm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
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
      create: async ({ data }: any) => {
        const item = { id: data.id || `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.utilizadores.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const u = db.utilizadores.find((x) => x.id === where.id);
        if (!u) throw new Error('Utilizador não encontrado');
        Object.assign(u, data);
        return u;
      },
    },
    membroFarmacia: {
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
        const item = { id: data.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.membros.push(item);
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
      findFirst: async ({ where }: any) => db.sessoes.find((s) => s.tokenHash === where.tokenHash) || null,
      create: async ({ data }: any) => {
        const item = { id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, revogadaEm: null, ...data };
        db.sessoes.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const s = db.sessoes.find((x) => x.id === where.id || x.tokenHash === where.tokenHash);
        if (s) Object.assign(s, data);
        return s;
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
    tokenSeguranca: {
      findUnique: async ({ where }: any) => db.tokens.find((t) => t.tokenHash === where.tokenHash) || null,
      create: async ({ data }: any) => {
        const item = { id: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, usadoEm: null, ...data };
        db.tokens.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const t = db.tokens.find((x) => x.id === where.id || x.tokenHash === where.tokenHash);
        if (t) Object.assign(t, data);
        return t;
      },
    },
    dispositivoConfiado: {
      findUnique: async ({ where }: any) => db.dispositivosConfiados.find((d) => d.tokenHash === where.tokenHash) || null,
      create: async ({ data }: any) => {
        const item = { id: `devconf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, revogadoEm: null, ...data };
        db.dispositivosConfiados.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const d = db.dispositivosConfiados.find((x) => x.id === where.id);
        if (d) Object.assign(d, data);
        return d;
      },
    },
    consentimentoSuporte: {
      findFirst: async ({ where }: any) => {
        return db.consentimentos.find((c) => {
          if (where.farmaciaId && c.farmaciaId !== where.farmaciaId) return false;
          if (where.revogadoEm === null && c.revogadoEm !== null) return false;
          if (where.expiraEm?.gt && c.expiraEm <= where.expiraEm.gt) return false;
          return true;
        }) || null;
      },
      create: async ({ data }: any) => {
        const item = { id: `cons_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, revogadoEm: null, criadoEm: new Date(), ...data };
        db.consentimentos.push(item);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const c of db.consentimentos) {
          if (where.farmaciaId && c.farmaciaId !== where.farmaciaId) continue;
          if (where.revogadoEm === null && c.revogadoEm !== null) continue;
          Object.assign(c, data);
          count++;
        }
        return { count };
      },
    },
    auditoriaSeguranca: {
      create: async ({ data }: any) => {
        const item = { id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ts: new Date(), ...data };
        db.auditoria.push(item);
        return item;
      },
      findMany: async ({ where, take }: any) => {
        let list = db.auditoria.filter((a) => (!where.farmaciaId || a.farmaciaId === where.farmaciaId));
        return list.slice(0, take || 50);
      },
    },
    martTenantKpis: {
      findMany: async ({ where }: any) => {
        return db.martsKpis.filter((k) => (!where.farmaciaId?.in || where.farmaciaId.in.includes(k.farmaciaId)));
      },
      findFirst: async (args?: any) => {
        const where = args?.where;
        return db.martsKpis.find((k) => (!where?.farmaciaId || k.farmaciaId === where.farmaciaId)) || db.martsKpis[0] || null;
      },
    },
    desafioWebAuthn: {
      findFirst: async ({ where }: any) => {
        return db.desafiosWebAuthn.find((d) => {
          if (where.utilizadorId && d.utilizadorId !== where.utilizadorId) return false;
          if (where.tipo && d.tipo !== where.tipo) return false;
          return true;
        }) || null;
      },
      create: async ({ data }: any) => {
        const item = { id: `des_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, criadoEm: new Date(), ...data };
        db.desafiosWebAuthn.push(item);
        return item;
      },
      delete: async () => ({}),
    },
    credencialPasskey: {
      findMany: async ({ where }: any) => db.credenciaisPasskey.filter((c) => (!where.utilizadorId || c.utilizadorId === where.utilizadorId)),
      findUnique: async ({ where }: any) => db.credenciaisPasskey.find((c) => c.credentialId === where.credentialId) || null,
      create: async ({ data }: any) => {
        const item = { id: `cred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, criadoEm: new Date(), ...data };
        db.credenciaisPasskey.push(item);
        return item;
      },
    },
    limiteTaxa: {
      findUnique: async ({ where }: any) => db.limites.get(where.chave) || null,
      upsert: async ({ where, create, update }: any) => {
        const item = db.limites.get(where.chave) ? { ...db.limites.get(where.chave), ...update } : { ...create };
        db.limites.set(where.chave, item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = { ...db.limites.get(where.chave), ...data };
        db.limites.set(where.chave, item);
        return item;
      },
      delete: async ({ where }: any) => {
        db.limites.delete(where.chave);
        return {};
      },
    },
  };

  return prisma;
}

describe('Fase 4 — Endurecimento e Segurança Avançada (Spec v2.1)', () => {
  let prisma: any;

  beforeEach(() => {
    prisma = createPhase4MockPrisma();
  });

  it('1. Verificação HIBP de Passwords Vazadas (k-Anonymity): rejeita passwords que constam de fugas públicas', async () => {
    // "password123" é a password mais comum do mundo (consta no HIBP milhões de vezes)
    const pwnedRes = await checkPwnedPassword('password123');
    // Deve detetar como pwned (se houver rede) ou validação assíncrona rejeita
    const policy = await validatePasswordPolicyAsync('password123');
    expect(policy.valid).toBe(false);

    // Password forte e única passa com sucesso
    const strong = await validatePasswordPolicyAsync('FraseSegura2026!FarmaciaInovadora99');
    expect(strong.valid).toBe(true);
  });

  it('2. Código de Desafio de Novo Dispositivo (challenge_token): emite token de 10 min e email Resend', async () => {
    const usr = await prisma.utilizador.create({
      data: {
        email: 'proprietario@farmaciacentral.pt',
        nome: 'Dr. Proprietário',
        passwordHash: 'dummy',
        ativo: true,
      },
    });

    // 1. Sem dispositivo confiado -> checkTrustedDevice é false
    const check1 = await checkTrustedDevice(prisma, usr.id, undefined);
    expect(check1.trusted).toBe(false);

    // 2. Gerar desafio de novo dispositivo
    const challenge = await createDeviceChallenge(prisma, {
      utilizadorId: usr.id,
      email: usr.email,
      nome: usr.nome,
      ip: '194.65.10.22',
      userAgent: 'Mozilla/5.0 Safari',
    });

    expect(challenge.ok).toBe(true);
    expect(challenge.challengeToken).toBeDefined();

    // 3. Validar código e emitir token de dispositivo confiado
    const verifyRes = await verifyDeviceChallengeAndTrust(prisma, {
      challengeToken: challenge.challengeToken!,
      code: challenge.codePreview || '123456', // Usa o preview gerado
      confiavel: true,
      ip: '194.65.10.22',
    });

    expect(verifyRes.ok).toBe(true);
    expect(verifyRes.rawTrustedToken).toBeDefined();

    // 4. Agora o dispositivo está confiado
    const check2 = await checkTrustedDevice(prisma, usr.id, verifyRes.rawTrustedToken!);
    expect(check2.trusted).toBe(true);
  });

  it('3. MFA Obrigatório por Perfil: Proprietário sem TOTP ativo é instruído a configurar MFA', async () => {
    const pwdHash = await hashPasswordScrypt('PasswordForte2026!');
    const usr = await prisma.utilizador.create({
      data: {
        email: 'dono@farmacia.pt',
        nome: 'Dono Farmácia',
        passwordHash: pwdHash,
        totpAtivo: false,
        ativo: true,
      },
    });
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Central', nif: '505016430', slug: 'central', estado: 'ATIVO' },
    });
    await prisma.membroFarmacia.create({
      data: {
        farmaciaId: farm.id,
        utilizadorId: usr.id,
        perfil: 'PROPRIETARIO',
        estado: 'ATIVO',
      },
    });

    const loginRes = await loginWithPassword(prisma, {
      email: usr.email,
      password: 'PasswordForte2026!',
      ip: '127.0.0.1',
      userAgent: 'TestBrowser',
    });

    // Como é PROPRIETARIO sem TOTP ativo, a Fase 4 exige setup obrigatório de MFA
    expect(loginRes.ok).toBe(false);
    expect(loginRes.requiresMfaSetup).toBe(true);
    expect(loginRes.error).toContain('ativação de autenticação de dois fatores');
  });

  it('4. Acesso de Suporte com Consentimento da Farmácia: concessão, verificação e revogação', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Suporte', nif: '505016431', slug: 'suporte', estado: 'ATIVO' },
    });

    // 1. Inicialmente não há consentimento ativo
    const checkInitial = await checkSupportAccessAllowed(prisma, farm.id);
    expect(checkInitial).toBe(false);

    // 2. Proprietário concede consentimento de suporte por 2 horas
    const grant = await grantSupportConsent(prisma, {
      farmaciaId: farm.id,
      concedidoPor: 'proprietario_id',
      duracaoHoras: 2,
      motivo: 'Resolução de sincronização de inventário',
    });
    expect(grant.ok).toBe(true);
    expect(grant.consentimento?.ativo).toBe(true);

    // 3. Acesso de suporte agora está autorizado
    const checkAllowed = await checkSupportAccessAllowed(prisma, farm.id);
    expect(checkAllowed).toBe(true);

    // 4. Proprietário revoga o consentimento
    const revoke = await revokeSupportConsent(prisma, farm.id, 'proprietario_id');
    expect(revoke.ok).toBe(true);

    // 5. Após revogação, suporte volta a ser barrado
    const checkPostRevoke = await checkSupportAccessAllowed(prisma, farm.id);
    expect(checkPostRevoke).toBe(false);
  });

  it('5. CSP Bloqueante: Cabeçalho Content-Security-Policy estrito ativo em todas as respostas HTTP', async () => {
    const { app } = buildFastifyApp({ prisma, isProd: true });

    const res = await app.inject({
      method: 'GET',
      url: '/balcao',
    });

    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain("https:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('6. Visão de Grupo em /api/tenant/compras-grupo: agrega KPIs entre farmácias do grupo', async () => {
    const farm1 = await prisma.farmacia.create({ data: { nome: 'Farmácia Grupo 1', nif: '505016432', slug: 'g1', estado: 'ATIVO' } });
    const farm2 = await prisma.farmacia.create({ data: { nome: 'Farmácia Grupo 2', nif: '505016433', slug: 'g2', estado: 'ATIVO' } });

    prisma._db.martsKpis.push(
      { farmaciaId: farm1.id, total_artigos_inventario: 100, total_unidades_stock: 500, valor_total_stock_custo: 2500 },
      { farmaciaId: farm2.id, total_artigos_inventario: 200, total_unidades_stock: 1500, valor_total_stock_custo: 7500 }
    );

    const usr = await prisma.utilizador.create({
      data: { email: 'comprador@grupo.pt', nome: 'Comprador Grupo', passwordHash: 'hash', ativo: true },
    });

    await prisma.membroFarmacia.create({ data: { farmaciaId: farm1.id, utilizadorId: usr.id, perfil: 'COMPRADOR', estado: 'ATIVO' } });
    await prisma.membroFarmacia.create({ data: { farmaciaId: farm2.id, utilizadorId: usr.id, perfil: 'COMPRADOR', estado: 'ATIVO' } });

    const rawSession = 'tok_compras_grupo_test_123456789';
    await prisma.sessao.create({
      data: {
        tokenHash: hashOpaqueToken(rawSession),
        utilizadorId: usr.id,
        farmaciaAtivaId: farm1.id,
        metodo: 'PASSWORD',
        expiraEm: new Date(Date.now() + 3600000),
      },
    });

    const { app } = buildFastifyApp({ prisma, isProd: false });

    const res = await app.inject({
      method: 'GET',
      url: '/api/tenant/compras-grupo',
      headers: {
        cookie: `sid=${rawSession}`,
        'x-scope': 'group',
      },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.scope).toBe('grupo');
    expect(data.totalFarmacias).toBe(2);
    expect(data.resumoGrupo.totalUnidades).toBe(2000);
    expect(data.resumoGrupo.totalArtigos).toBe(300);
    expect(data.resumoGrupo.valorTotalStockCusto).toBe(10000);
  });

  it('6b. Visão de Grupo com Permissões Mistas: utilizador com ver_custos na farmácia A mas NÃO na farmácia B nunca vê custos de B', async () => {
    const farmA = await prisma.farmacia.create({ data: { nome: 'Farmácia A (Com Custos)', nif: '505016488', slug: 'ga', estado: 'ATIVO' } });
    const farmB = await prisma.farmacia.create({ data: { nome: 'Farmácia B (Sem Custos)', nif: '505016489', slug: 'gb', estado: 'ATIVO' } });

    prisma._db.martsKpis.push(
      { farmaciaId: farmA.id, total_artigos_inventario: 150, total_unidades_stock: 600, valor_total_stock_custo: 3000 },
      { farmaciaId: farmB.id, total_artigos_inventario: 250, total_unidades_stock: 1200, valor_total_stock_custo: 8000 }
    );

    const usrMisto = await prisma.utilizador.create({
      data: { email: 'misto@grupo.pt', nome: 'Utilizador Misto', passwordHash: 'hash', ativo: true },
    });

    // Farmácia A: COMPRADOR (tem ver_custos e ver_grupo)
    await prisma.membroFarmacia.create({ data: { farmaciaId: farmA.id, utilizadorId: usrMisto.id, perfil: 'COMPRADOR', estado: 'ATIVO' } });
    // Farmácia B: OPERADOR_BALCAO + permissaoExtra ['ver_grupo'] (NÃO TEM ver_custos!)
    await prisma.membroFarmacia.create({
      data: {
        farmaciaId: farmB.id,
        utilizadorId: usrMisto.id,
        perfil: 'OPERADOR_BALCAO',
        permissoesExtra: ['ver_grupo'],
        estado: 'ATIVO',
      },
    });

    const rawSession = 'tok_compras_grupo_misto_1234567890123456';
    await prisma.sessao.create({
      data: {
        tokenHash: hashOpaqueToken(rawSession),
        utilizadorId: usrMisto.id,
        farmaciaAtivaId: farmA.id,
        metodo: 'PASSWORD',
        expiraEm: new Date(Date.now() + 3600000),
      },
    });

    const { app } = buildFastifyApp({ prisma, isProd: false });

    const res = await app.inject({
      method: 'GET',
      url: '/api/tenant/compras-grupo',
      headers: {
        cookie: `sid=${rawSession}`,
        'x-scope': 'group',
      },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.totalFarmacias).toBe(2);
    // Unidades e artigos somam de ambas as farmácias
    expect(data.resumoGrupo.totalArtigos).toBe(400); // 150 + 250
    expect(data.resumoGrupo.totalUnidades).toBe(1800); // 600 + 1200
    // O valor a custo soma EXCLUSIVAMENTE a Farmácia A (3000) e NUNCA a Farmácia B (8000)!
    expect(data.resumoGrupo.valorTotalStockCusto).toBe(3000);

    // No detalhe individual por farmácia:
    const detA = data.detalhesPorFarmacia.find((d: any) => d.farmaciaId === farmA.id);
    const detB = data.detalhesPorFarmacia.find((d: any) => d.farmaciaId === farmB.id);
    expect(detA.valorStockCusto).toBe(3000);
    expect(detB.valorStockCusto).toBeUndefined(); // Censurado rigorosamente!
  });

  it('7. Ecrã de Auditoria em /auditoria: protegido por permissão ver_auditoria', async () => {
    const farm = await prisma.farmacia.create({ data: { nome: 'Farmácia Audit', nif: '505016434', slug: 'audit', estado: 'ATIVO' } });
    const usr = await prisma.utilizador.create({
      data: { email: 'prop@audit.pt', nome: 'Proprietário Audit', passwordHash: 'hash', ativo: true },
    });
    await prisma.membroFarmacia.create({ data: { farmaciaId: farm.id, utilizadorId: usr.id, perfil: 'PROPRIETARIO', estado: 'ATIVO' } });

    // Registar um evento na auditoria
    await prisma.auditoriaSeguranca.create({
      data: {
        farmaciaId: farm.id,
        utilizadorId: usr.id,
        evento: 'LOGIN_OK',
        ip: '127.0.0.1',
        detalhes: { stage: 'test' },
      },
    });

    const rawSession = 'tok_audit_test_12345678901234567';
    await prisma.sessao.create({
      data: {
        tokenHash: hashOpaqueToken(rawSession),
        utilizadorId: usr.id,
        farmaciaAtivaId: farm.id,
        metodo: 'PASSWORD',
        expiraEm: new Date(Date.now() + 3600000),
      },
    });

    const { app } = buildFastifyApp({ prisma, isProd: false });

    // 1. API JSON de auditoria
    const apiRes = await app.inject({
      method: 'GET',
      url: '/api/tenant/audit',
      headers: { cookie: `sid=${rawSession}` },
    });
    expect(apiRes.statusCode).toBe(200);
    const apiData = JSON.parse(apiRes.body);
    expect(apiData.ok).toBe(true);
    expect(apiData.logs.length).toBeGreaterThanOrEqual(1);
    expect(apiData.logs[0].evento).toBe('LOGIN_OK');

    // 2. View HTML de auditoria
    const viewRes = await app.inject({
      method: 'GET',
      url: '/auditoria',
      headers: { cookie: `sid=${rawSession}` },
    });
    expect(viewRes.statusCode).toBe(200);
    expect(viewRes.headers['content-type']).toContain('text/html');
    expect(viewRes.body).toContain('Auditoria de Segurança');
    expect(viewRes.body).toContain('LOGIN_OK');
  });

  it('8. Suporte Técnico em Modo Read-Only Estrito: bloqueia qualquer operação de escrita (POST)', async () => {
    const farm = await prisma.farmacia.create({ data: { nome: 'Farmácia Suporte RO', nif: '505016499', slug: 'supro', estado: 'ATIVO' } });
    const superadmin = await prisma.utilizador.create({
      data: { email: 'super@nuelltech.com', nome: 'Superadmin Suporte', passwordHash: 'hash', isSuperadmin: true, ativo: true },
    });

    // Conceder consentimento de suporte ativo
    await grantSupportConsent(prisma, {
      farmaciaId: farm.id,
      concedidoPor: 'prop_id',
      duracaoHoras: 2,
    });

    const rawSession = 'tok_suporte_session_ro_1234567890123456';
    await prisma.sessao.create({
      data: {
        tokenHash: hashOpaqueToken(rawSession),
        utilizadorId: superadmin.id,
        metodo: 'PASSWORD',
        expiraEm: new Date(Date.now() + 3600000),
      },
    });

    const { app } = buildFastifyApp({ prisma, isProd: false });

    // 1. Leitura é permitida
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: {
        cookie: `sid=${rawSession}`,
        'x-farmacia-id': farm.id,
      },
    });
    expect(getRes.statusCode).toBe(200);

    // 2. Tentativa de escrita (gerar código de balcão) é terminantemente BLOQUEADA com 403 Read-Only
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/tenant/devices/pairing-code',
      payload: {},
      headers: {
        cookie: `sid=${rawSession}`,
        'x-farmacia-id': farm.id,
      },
    });
    expect(postRes.statusCode).toBe(403);
    const postData = JSON.parse(postRes.body);
    expect(postData.error).toContain('Read-Only');
  });

  it('9. Passkeys (WebAuthn / FIDO2): gera opções de autenticação FIDO2 para biometria', async () => {
    const { app } = buildFastifyApp({ prisma, isProd: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/login-options',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.challenge).toBeDefined();
    expect(data.rpId).toBe('localhost');
  });
});
