import { describe, it, expect, beforeEach } from 'vitest';
import { buildFastifyApp } from '../app_fastify';
import {
  hashPasswordScrypt,
  verifyPasswordScrypt,
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  verifyTotpCodeWithStep,
  encryptTotpSecret,
  decryptTotpSecret,
  generateRecoveryCodes,
  verifyAndConsumeRecoveryCode,
} from '../services/auth_crypto';
import { validatePasswordPolicy } from '../data/common_passwords';
import {
  computeEffectivePermissions,
  filterPvpMinForPermissions,
} from '../services/auth_permissions';
import { validateCopilotSql } from '../platform/copilot_sql_sandbox';
import { clearAllSessionCache } from '../services/auth_service';

function createPhase1MockPrisma() {
  const db = {
    farmacias: [] as any[],
    utilizadores: [] as any[],
    membros: [] as any[],
    sessoes: [] as any[],
    tokens: [] as any[],
    auditoria: [] as any[],
    limites: new Map<string, any>(),
    kpis: [] as any[],
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
      create: async ({ data }: any) => {
        if (db.farmacias.some((f) => f.nif === data.nif || (data.slug && f.slug === data.slug))) {
          const err: any = new Error('Unique constraint');
          err.code = 'P2002';
          throw err;
        }
        const item = { id: data.id || 'farm_' + (db.farmacias.length + 1), criadoEm: new Date(), ...data };
        db.farmacias.push(item);
        return item;
      },
    },
    utilizador: {
      findUnique: async ({ where }: any) =>
        db.utilizadores.find((u) => (where.email ? u.email === where.email : u.id === where.id)) || null,
      create: async ({ data }: any) => {
        const item = { id: data.id || 'usr_' + (db.utilizadores.length + 1), criadoEm: new Date(), ...data };
        db.utilizadores.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const u = db.utilizadores.find((x) => x.id === where.id);
        if (!u) throw new Error('Not found');
        Object.assign(u, data);
        return u;
      },
    },
    membroFarmacia: {
      findMany: async ({ where, include }: any) => {
        return db.membros
          .filter((m) => {
            if (where.utilizadorId && m.utilizadorId !== where.utilizadorId) return false;
            if (where.estado && m.estado !== where.estado) return false;
            return true;
          })
          .map((m) => ({
            ...m,
            ...(include?.farmacia ? { farmacia: db.farmacias.find((f) => f.id === m.farmaciaId) } : {}),
          }));
      },
      findFirst: async ({ where }: any) =>
        db.membros.find(
          (m) =>
            m.utilizadorId === where.utilizadorId &&
            m.farmaciaId === where.farmaciaId &&
            (!where.estado || m.estado === where.estado)
        ) || null,
      create: async ({ data }: any) => {
        const item = { id: data.id || 'mem_' + (db.membros.length + 1), criadoEm: new Date(), ...data };
        db.membros.push(item);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const m of db.membros) {
          if (m.utilizadorId === where.utilizadorId) {
            Object.assign(m, data);
            count++;
          }
        }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const m = db.membros.find((x) => x.id === where.id);
        if (m) Object.assign(m, data);
        return m;
      },
    },
    sessao: {
      create: async ({ data }: any) => {
        const item = { id: 'sess_' + (db.sessoes.length + 1), revogadaEm: null, ...data };
        db.sessoes.push(item);
        return item;
      },
      findUnique: async ({ where, include }: any) => {
        const s = db.sessoes.find((x) => x.tokenHash === where.tokenHash);
        if (!s) return null;
        return {
          ...s,
          ...(include?.utilizador ? { utilizador: db.utilizadores.find((u) => u.id === s.utilizadorId) || null } : {}),
        };
      },
      findFirst: async ({ where }: any) =>
        db.sessoes.find((s) => s.utilizadorId === where.utilizadorId && s.ip === where.ip && s.userAgent === where.userAgent) || null,
      update: async ({ where, data }: any) => {
        const s = db.sessoes.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const s of db.sessoes) {
          const matchUser = !where.utilizadorId || s.utilizadorId === where.utilizadorId;
          const matchNotId = !where.id?.not || s.id !== where.id.not;
          const matchNotRevoked = where.revogadaEm !== null || s.revogadaEm === null;
          if (matchUser && matchNotId && matchNotRevoked) {
            Object.assign(s, data);
            count++;
          }
        }
        return { count };
      },
    },
    dispositivoConfiado: {
      updateMany: async () => ({ count: 0 }),
    },
    tokenSeguranca: {
      create: async ({ data }: any) => {
        const item = { id: 'tok_' + (db.tokens.length + 1), usadoEm: null, ...data };
        db.tokens.push(item);
        return item;
      },
    },
    auditoriaSeguranca: {
      create: async ({ data }: any) => {
        const item = { id: 'aud_' + (db.auditoria.length + 1), ts: new Date(), ...data };
        db.auditoria.push(item);
        return item;
      },
    },
    limiteTaxa: {
      findUnique: async ({ where }: any) => db.limites.get(where.chave) || null,
      upsert: async ({ where, create, update }: any) => {
        const val = db.limites.has(where.chave) ? { ...db.limites.get(where.chave), ...update } : { ...create };
        db.limites.set(where.chave, val);
        return val;
      },
      update: async ({ where, data }: any) => {
        const val = { ...db.limites.get(where.chave), ...data };
        db.limites.set(where.chave, val);
        return val;
      },
      delete: async ({ where }: any) => {
        db.limites.delete(where.chave);
        return { chave: where.chave };
      },
    },
    martTenantKpis: {
      findFirst: async () =>
        db.kpis[0] || {
          total_artigos_inventario: 120,
          total_unidades_stock: 450,
          valor_total_stock_custo: 9500,
        },
    },
  };

  return prisma;
}

describe('Fase 1 — Núcleo de Identidade, Fastify, TOTP, Permissões e Isolamento Multi-Tenant', () => {
  beforeEach(() => {
    clearAllSessionCache();
  });

  it('1. Arranque do Fastify falha se existir rota sem declaração de permissão (negado por omissão)', () => {
    const prisma = createPhase1MockPrisma();
    const { assertAllRoutesDeclared } = buildFastifyApp({
      prisma,
      isProd: false,
      extraRegister: (app) => {
        // Rota registada SEM chamar declareRoute -> deve falhar no arranque!
        app.get('/api/rota-esquecida', async () => ({ ok: true }));
      },
    });

    expect(() => assertAllRoutesDeclared()).toThrow(/Rotas sem declaração de permissão/);
  });

  it('2. Arranque do Fastify passa quando todas as rotas estão declaradas', () => {
    const prisma = createPhase1MockPrisma();
    const { assertAllRoutesDeclared } = buildFastifyApp({ prisma, isProd: false });
    expect(() => assertAllRoutesDeclared()).not.toThrow();
  });

  it('3. Password scrypt assíncrono + lista local de passwords comuns', async () => {
    expect(validatePasswordPolicy('curta').valid).toBe(false);
    expect(validatePasswordPolicy('farmacia2026').valid).toBe(false);
    expect(validatePasswordPolicy('password1234').valid).toBe(false);
    expect(validatePasswordPolicy('Montanha!Verde#9482').valid).toBe(true);

    const hash = await hashPasswordScrypt('Montanha!Verde#9482');
    expect(hash.startsWith('scrypt$N=32768$r=8$p=1$')).toBe(true);
    expect(await verifyPasswordScrypt('Montanha!Verde#9482', hash)).toBe(true);
    expect(await verifyPasswordScrypt('Errada!Verde#9482', hash)).toBe(false);
  });

  it('4. Matriz de permissões v2.1: balcão vê stock/validades mas nunca faturação €, custos, margens nem pvp_min', () => {
    const balcaoPerms = computeEffectivePermissions('OPERADOR_BALCAO', [], 'PASSWORD');
    expect(balcaoPerms.has('ver_stock_validades')).toBe(true);
    expect(balcaoPerms.has('ver_faturacao')).toBe(false);
    expect(balcaoPerms.has('ver_custos')).toBe(false);
    expect(balcaoPerms.has('ver_margens')).toBe(false);

    // Teto de PIN: mesmo um PROPRIETARIO autenticado por PIN perde custos/margens/faturação/equipa
    const propPinPerms = computeEffectivePermissions('PROPRIETARIO', ['validar_clinica'], 'PIN');
    expect(propPinPerms.has('ver_stock_validades')).toBe(true);
    expect(propPinPerms.has('ver_custos')).toBe(false);
    expect(propPinPerms.has('ver_margens')).toBe(false);
    expect(propPinPerms.has('ver_faturacao')).toBe(false);
    expect(propPinPerms.has('gerir_equipa_dispositivos')).toBe(false);
    expect(propPinPerms.has('validar_clinica')).toBe(false);

    // pvp_min escondido sem ver_custos (devolve apenas abaixo_do_minimo)
    const hidden = filterPvpMinForPermissions(8.5, 9.2, balcaoPerms);
    expect(hidden.pvp_min).toBeUndefined();
    expect(hidden.abaixo_do_minimo).toBe(true);
    expect(hidden.alerta).toBe('CAMPANHA_ABAIXO_MINIMO');

    const propWebPerms = computeEffectivePermissions('PROPRIETARIO', [], 'PASSWORD');
    const visible = filterPvpMinForPermissions(8.5, 9.2, propWebPerms);
    expect(visible.pvp_min).toBe(9.2);
    expect(visible.abaixo_do_minimo).toBe(true);
  });

  it('5. TOTP RFC 6238 (cifra AES-256-GCM) obrigatório para Superadmin + POST /api/admin/farmacias transacional', async () => {
    const prisma = createPhase1MockPrisma();
    const secret = generateTotpSecret();
    const enc = encryptTotpSecret(secret);
    expect(decryptTotpSecret(enc)).toBe(secret);

    const pwdHash = await hashPasswordScrypt('Super!Admin#Nuelltech2026');
    prisma._db.utilizadores.push({
      id: 'usr_super',
      email: 'nuno@nuelltech.com',
      nome: 'Nuno Superadmin',
      passwordHash: pwdHash,
      ativo: true,
      isSuperadmin: true,
      totpSecretEnc: enc,
      totpAtivo: true,
    });

    const { app, assertAllRoutesDeclared } = buildFastifyApp({ prisma, isProd: false });
    assertAllRoutesDeclared();

    // Tentativa de login de superadmin SEM TOTP -> 401 requiresTotp
    const resNoTotp = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nuno@nuelltech.com', password: 'Super!Admin#Nuelltech2026' },
    });
    expect(resNoTotp.statusCode).toBe(401);
    expect(resNoTotp.json().requiresTotp).toBe(true);

    // Login de superadmin COM TOTP válido -> 200 + cookie HttpOnly
    const validCode = generateTotpCode(secret);
    expect(verifyTotpCode(secret, validCode)).toBe(true);

    const resOk = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nuno@nuelltech.com', password: 'Super!Admin#Nuelltech2026', totpCode: validCode },
    });
    expect(resOk.statusCode).toBe(200);
    const setCookie = String(resOk.headers['set-cookie'] || '');
    expect(setCookie).toContain('HttpOnly');
    const cookieHeader = setCookie.split(';')[0];

    // Superadmin cria nova farmácia + convite + auditoria numa só transação
    const resCreate = await app.inject({
      method: 'POST',
      url: '/api/admin/farmacias',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      payload: {
        nome: 'Farmácia Central',
        nif: '501234567',
        slug: 'farmacia-central',
        ownerNome: 'Dr. António Silva',
        ownerEmail: 'antonio@farmaciacentral.pt',
      },
    });
    expect(resCreate.statusCode).toBe(201);
    expect(resCreate.json().farmacia.slug).toBe('farmacia-central');
    expect(prisma._db.tokens.length).toBe(1);
    expect(prisma._db.auditoria.some((a: any) => a.evento === 'FARMACIA_CRIADA')).toBe(true);

    // Superadmin NÃO consegue ler dados da farmácia criada (sem consentimento de suporte -> 403)
    const farmId = resCreate.json().farmacia.id;
    const resReadData = await app.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: { cookie: cookieHeader, 'x-farmacia-id': farmId },
    });
    expect(resReadData.statusCode).toBe(403);
    expect(prisma._db.auditoria.some((a: any) => a.evento === 'ACESSO_NEGADO')).toBe(true);

    await app.close();
  });

  it('6. Isolamento Multi-Tenant: Utilizador B não acede à Farmácia A (403 + ACESSO_NEGADO) e revogação é imediata', async () => {
    const prisma = createPhase1MockPrisma();
    prisma._db.farmacias.push(
      { id: 'farm_A', nome: 'Farmácia A', nif: '500000001', slug: 'farm-a', estado: 'ATIVO' },
      { id: 'farm_B', nome: 'Farmácia B', nif: '500000002', slug: 'farm-b', estado: 'ATIVO' }
    );
    const pwdHash = await hashPasswordScrypt('Operador!Seguro#2026');
    prisma._db.utilizadores.push({
      id: 'usr_B',
      email: 'op@farmb.pt',
      nome: 'Operador B',
      passwordHash: pwdHash,
      ativo: true,
      isSuperadmin: false,
    });
    prisma._db.membros.push({
      id: 'mem_B',
      utilizadorId: 'usr_B',
      farmaciaId: 'farm_B',
      nome: 'Operador B',
      perfil: 'OPERADOR_BALCAO',
      permissoesExtra: [],
      farmaciaPadrao: true,
      estado: 'ATIVO',
    });

    const { app } = buildFastifyApp({ prisma, isProd: false });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'op@farmb.pt', password: 'Operador!Seguro#2026' },
    });
    expect(loginRes.statusCode).toBe(200);
    const cookieB = String(loginRes.headers['set-cookie']).split(';')[0];

    // Acesso à própria Farmácia B -> 200 e SEM valorStockCusto (operador de balcão)
    const okB = await app.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: { cookie: cookieB, 'x-farmacia-id': 'farm_B' },
    });
    expect(okB.statusCode).toBe(200);
    expect(okB.json().farmaciaId).toBe('farm_B');
    expect(okB.json().valorStockCusto).toBeUndefined();

    // Tentativa de aceder à Farmácia A com X-Farmacia-ID forjado -> 403 + ACESSO_NEGADO
    const attackA = await app.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: { cookie: cookieB, 'x-farmacia-id': 'farm_A' },
    });
    expect(attackA.statusCode).toBe(403);
    expect(prisma._db.auditoria.some((a: any) => a.evento === 'ACESSO_NEGADO' && a.farmaciaId === 'farm_A')).toBe(true);

    // X-Scope: grupo sem permissão ver_grupo -> 403
    const attackGroup = await app.inject({
      method: 'GET',
      url: '/api/tenant/compras-grupo',
      headers: { cookie: cookieB, 'x-scope': 'grupo' },
    });
    expect(attackGroup.statusCode).toBe(403);

    // Logout revoga sessão e invalida cache de imediato -> pedido seguinte devolve 401
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      payload: {},
    });

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: { cookie: cookieB, 'x-farmacia-id': 'farm_B' },
    });
    expect(afterLogout.statusCode).toBe(401);

    await app.close();
  });

  it('7. Parser do sandbox SQL bloqueia set_config, pg_sleep, multi-statement, tabelas base e vista de custos sem permissão', async () => {
    const balcao = computeEffectivePermissions('OPERADOR_BALCAO', [], 'PASSWORD');
    const prop = computeEffectivePermissions('PROPRIETARIO', [], 'PASSWORD');

    const bad = async (sql: string, perms = prop) => (await validateCopilotSql(sql, perms)).ok;

    // Escrita, multi-statement e tabelas de sistema/base
    expect(await bad('DELETE FROM copilot.produtos')).toBe(false);
    expect(await bad('SELECT 1; DROP TABLE sessoes')).toBe(false);
    expect(await bad('SELECT * FROM utilizadores')).toBe(false);
    expect(await bad('SELECT * FROM public."MartProdutoMetricas"')).toBe(false);

    // Ataque à vista: mudar o filtro de tenant, dormir, ler settings, funções em FROM
    expect(await bad("SELECT set_config('app.farmacia_id', 'outra-farmacia', true)")).toBe(false);
    expect(await bad("SELECT cnp_codigo FROM produtos WHERE set_config('app.farmacia_id','x',true) = 'x'")).toBe(false);
    expect(await bad('SELECT pg_sleep(10)')).toBe(false);
    expect(await bad("SELECT current_setting('app.farmacia_id')")).toBe(false);
    expect(await bad('SELECT * FROM generate_series(1, 1000000)')).toBe(false);
    expect(await bad('SELECT current_user')).toBe(false);
    expect(await bad("SELECT 'x'::regclass")).toBe(false);

    // Balcão não pode referenciar a vista de custos (o papel de BD também a nega)
    expect(await bad('SELECT cnp_codigo FROM produtos_com_custo', balcao)).toBe(false);
    expect(await bad('SELECT cnp_codigo FROM copilot.produtos_com_custo', balcao)).toBe(false);

    // Casos válidos
    const okBalcao = await validateCopilotSql('SELECT cnp_codigo, designacao, stock_atual, vmm FROM produtos', balcao);
    expect(okBalcao.ok).toBe(true);
    expect(okBalcao.role).toBe('copilot_ro_sem_custo');
    expect(okBalcao.normalizedSql).toContain('LIMIT 200');

    const okProp = await validateCopilotSql(
      'WITH x AS (SELECT cnp_codigo, custo_unitario FROM produtos_com_custo) SELECT count(*), round(avg(custo_unitario), 2) FROM x',
      prop
    );
    expect(okProp.ok).toBe(true);
    expect(okProp.role).toBe('copilot_ro_com_custo');
  });

  it('8. Proteção anti-replay de TOTP e consumo de códigos de recuperação de uso único', async () => {
    const mockPrisma = createPhase1MockPrisma();
    const { app } = buildFastifyApp({ prisma: mockPrisma as any });

    const secret = generateTotpSecret();
    const { plaintextCodes, hashedCodes } = generateRecoveryCodes(5);
    const pwdHash = await hashPasswordScrypt('SuperAdminPassword123!');

    await mockPrisma.utilizador.create({
      data: {
        id: 'usr_super',
        email: 'super@nuelltech.com',
        nome: 'Super User',
        passwordHash: pwdHash,
        isSuperadmin: true,
        totpSecretEnc: encryptTotpSecret(secret),
        totpAtivo: true,
        totpRecoveryHashes: [...hashedCodes],
        totpUltimoPasso: null,
        ativo: true,
      },
    });

    const now = Date.now();
    const currentCode = generateTotpCode(secret, now);

    // 1º login com TOTP válido -> sucesso
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'super@nuelltech.com',
        password: 'SuperAdminPassword123!',
        totpCode: currentCode,
      },
    });
    expect(res1.statusCode).toBe(200);

    // 2º login com O MESMO código TOTP (replay attack dentro da mesma janela) -> rejeitado
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'super@nuelltech.com',
        password: 'SuperAdminPassword123!',
        totpCode: currentCode,
      },
    });
    expect(res2.statusCode).toBe(401);
    expect(res2.json().error).toMatch(/código de verificação .* inválido ou já utilizado/i);

    // 3º login usando um código de recuperação de uso único -> sucesso
    const recoveryCodeToUse = plaintextCodes[0];
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'super@nuelltech.com',
        password: 'SuperAdminPassword123!',
        totpCode: recoveryCodeToUse,
      },
    });
    expect(res3.statusCode).toBe(200);

    // 4º login com o MESMO código de recuperação -> rejeitado (já foi consumido)
    const res4 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'super@nuelltech.com',
        password: 'SuperAdminPassword123!',
        totpCode: recoveryCodeToUse,
      },
    });
    expect(res4.statusCode).toBe(401);

    await app.close();
  });
});
