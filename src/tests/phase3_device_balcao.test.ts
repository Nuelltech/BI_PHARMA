import { describe, it, expect, beforeEach } from 'vitest';
import { buildFastifyApp } from '../app_fastify';
import {
  generatePairingCode,
  pairDeviceWithCode,
  validateDeviceToken,
  listPharmacyDevices,
  revokePharmacyDevice,
  authenticateBalcaoPin,
  listAvailableOperators,
} from '../services/device_service';
import { PIN_ALLOWED_PERMISSIONS } from '../services/auth_permissions';
import { hashOpaqueToken, hashPinWithPepper } from '../services/security_phase0';

function createPhase3MockPrisma() {
  const db = {
    farmacias: [] as any[],
    utilizadores: [] as any[],
    membros: [] as any[],
    sessoes: [] as any[],
    tokens: [] as any[],
    dispositivos: [] as any[],
    codigos: [] as any[],
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
      create: async ({ data }: any) => {
        const item = { id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.utilizadores.push(item);
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
    },
    codigoEmparelhamento: {
      findUnique: async ({ where }: any) => db.codigos.find((c) => c.codigoHash === where.codigoHash) || null,
      create: async ({ data }: any) => {
        const item = { id: `cod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.codigos.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.codigos.find((c) => c.id === where.id || c.codigoHash === where.codigoHash);
        if (!item) throw new Error('Código não encontrado');
        Object.assign(item, data);
        return item;
      },
    },
    dispositivoBalcao: {
      findUnique: async ({ where }: any) => db.dispositivos.find((d) => d.tokenHash === where.tokenHash || d.id === where.id) || null,
      findFirst: async ({ where }: any) => {
        return db.dispositivos.find((d) => {
          if (where.id && d.id !== where.id) return false;
          if (where.farmaciaId && d.farmaciaId !== where.farmaciaId) return false;
          if (where.tokenHash && d.tokenHash !== where.tokenHash) return false;
          return true;
        }) || null;
      },
      findMany: async ({ where }: any) => {
        return db.dispositivos.filter((d) => {
          if (where.farmaciaId && d.farmaciaId !== where.farmaciaId) return false;
          return true;
        });
      },
      create: async ({ data }: any) => {
        const item = { id: `dev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        db.dispositivos.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const item = db.dispositivos.find((d) => d.id === where.id || d.tokenHash === where.tokenHash);
        if (!item) throw new Error('Dispositivo não encontrado');
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
        const item = { id: `ses_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, criadoEm: new Date(), revogadaEm: null, ...data };
        db.sessoes.push(item);
        return item;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const s of db.sessoes) {
          if (where.dispositivoId && s.dispositivoId !== where.dispositivoId) continue;
          if (where.utilizadorId && s.utilizadorId !== where.utilizadorId) continue;
          if (where.revogadaEm === null && s.revogadaEm) continue;
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
      delete: async ({ where }: any) => {
        db.limites.delete(where.chave);
        return null;
      },
      deleteMany: async () => ({ count: 0 }),
    },
    membroEquipa: {
      findFirst: async () => null,
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

describe('Fase 3 — Balcão, Emparelhamento de Dispositivos e Autenticação por PIN', () => {
  let prisma: any;
  let fastify: any;

  beforeEach(() => {
    prisma = createPhase3MockPrisma();
    const built = buildFastifyApp({
      prisma,
      isProd: false,
      allowedOrigin: 'http://localhost:3000',
    });
    fastify = built.app;
  });

  it('1. Gera código temporário de 15 minutos e emparelha novo terminal de balcão', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Baptista', nif: '505016419', slug: 'baptista', estado: 'ATIVO' },
    });

    // 1. Gera código de emparelhamento
    const genRes = await generatePairingCode(prisma, farm.id, 'user-admin-1');
    expect(genRes.ok).toBe(true);
    expect(genRes.codigo).toMatch(/^[2-9A-Z]{3}-[2-9A-Z]{3}$/);
    expect(genRes.expiraEm!.getTime()).toBeGreaterThan(Date.now());

    // 2. Terminal introduz o código para emparelhar
    const pairRes = await pairDeviceWithCode(prisma, {
      codigo: genRes.codigo!,
      nomeDispositivo: 'Tablet Balcão 1',
      ip: '192.168.1.50',
    });

    expect(pairRes.ok).toBe(true);
    expect(pairRes.deviceToken).toBeDefined();
    expect(pairRes.dispositivo!.nome).toBe('Tablet Balcão 1');
    expect(pairRes.dispositivo!.farmaciaId).toBe(farm.id);

    // 3. Código é de uso único (anti-replay)
    const replayRes = await pairDeviceWithCode(prisma, {
      codigo: genRes.codigo!,
      nomeDispositivo: 'Outro Tablet',
    });
    expect(replayRes.ok).toBe(false);
    expect(replayRes.error).toContain('inválido ou expirado');
  });

  it('2. PIN sem dispositivo emparelhado ou com token falso é BLOQUEADO (401)', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Avenida', nif: '505016420', slug: 'avenida', estado: 'ATIVO' },
    });
    const memberId = 'mem-op-1';
    const membro = await prisma.membroFarmacia.create({
      data: {
        id: memberId,
        farmaciaId: farm.id,
        nome: 'Operador Balcão',
        perfil: 'OPERADOR_BALCAO',
        pinHash: hashPinWithPepper('482917', memberId),
        estado: 'ATIVO',
      },
    });

    // 1. Tentativa sem token de dispositivo
    const resNoToken = await fastify.inject({
      method: 'POST',
      url: '/api/auth/pin',
      payload: {
        farmaciaId: farm.id,
        memberId: membro.id,
        pin: '482917',
      },
    });
    expect(resNoToken.statusCode).toBe(401);
    expect(resNoToken.json().error).toContain('não emparelhado ou token ausente');

    // 2. Tentativa com token de dispositivo falso/inventado
    const resFakeToken = await fastify.inject({
      method: 'POST',
      url: '/api/auth/pin',
      headers: {
        'x-device-token': 'token_completamente_falso_que_nao_existe_na_bd_1234',
      },
      payload: {
        farmaciaId: farm.id,
        memberId: membro.id,
        pin: '482917',
      },
    });
    expect(resFakeToken.statusCode).toBe(401);
    expect(resFakeToken.json().error).toContain('não reconhecido');
  });

  it('3. PIN em terminal emparelhado cria sessão com metodo: "PIN" e dispositivoId', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Central', nif: '505016421', slug: 'central', estado: 'ATIVO' },
    });
    const memberId = 'mem-ana-1';
    const membro = await prisma.membroFarmacia.create({
      data: {
        id: memberId,
        farmaciaId: farm.id,
        nome: 'Dra. Ana Balcão',
        perfil: 'OPERADOR_BALCAO',
        pinHash: hashPinWithPepper('591823', memberId),
        estado: 'ATIVO',
      },
    });

    // Emparelhar tablet
    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const pair = await pairDeviceWithCode(prisma, {
      codigo: gen.codigo!,
      nomeDispositivo: 'POS Caixa 1',
    });

    // Autenticar com o token do tablet emparelhado
    const authRes = await fastify.inject({
      method: 'POST',
      url: '/api/auth/pin',
      headers: {
        'x-device-token': pair.deviceToken,
      },
      payload: {
        farmaciaId: farm.id,
        memberId: membro.id,
        pin: '591823',
      },
    });

    expect(authRes.statusCode).toBe(200);
    const body = authRes.json();
    expect(body.ok).toBe(true);
    expect(body.member.nome).toBe('Dra. Ana Balcão');
    expect(body.dispositivo.nome).toBe('POS Caixa 1');
    expect(authRes.headers['set-cookie']).toContain('sid=');

    // Verifica que a sessão na BD tem metodo: 'PIN' e dispositivoId
    const sessoes = prisma._db.sessoes;
    expect(sessoes.length).toBe(1);
    expect(sessoes[0].metodo).toBe('PIN');
    expect(sessoes[0].dispositivoId).toBe(pair.dispositivo!.id);
  });

  it('4. Teto Estrito de PIN: Sessão PIN NUNCA tem acesso a custos ou gestão administrativa', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Teto', nif: '505016422', slug: 'teto', estado: 'ATIVO' },
    });
    const memberId = 'mem-dt-1';
    const membro = await prisma.membroFarmacia.create({
      data: {
        id: memberId,
        farmaciaId: farm.id,
        nome: 'Dr. Diretor no Balcão',
        perfil: 'DIRETOR_TECNICO',
        pinHash: hashPinWithPepper('827364', memberId),
        estado: 'ATIVO',
      },
    });

    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const pair = await pairDeviceWithCode(prisma, { codigo: gen.codigo!, nomeDispositivo: 'Terminal 1' });

    // Autentica via PIN
    const authRes = await fastify.inject({
      method: 'POST',
      url: '/api/auth/pin',
      headers: { 'x-device-token': pair.deviceToken },
      payload: { farmaciaId: farm.id, memberId: membro.id, pin: '827364' },
    });
    expect(authRes.statusCode).toBe(200);
    const perms = authRes.json().permissoes as string[];

    // O teto de PIN corta custos, faturação e gestão de equipa
    expect(perms).not.toContain('ver_custos');
    expect(perms).not.toContain('ver_faturacao');
    expect(perms).not.toContain('gerir_equipa_dispositivos');
    expect(perms).not.toContain('gerir_farmacia');
    expect(perms).not.toContain('exportar_dados');

    // Mantém permissões operacionais de balcão
    expect(perms).toContain('ver_stock_validades');
    expect(perms).toContain('executar_tarefas');
  });

  it('5. Revogação de Dispositivo: bloqueia novas autenticações e encerra sessões ativas imediatamente', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Revogada', nif: '505016423', slug: 'revogada', estado: 'ATIVO' },
    });
    const memberId = 'mem-rev-1';
    const membro = await prisma.membroFarmacia.create({
      data: {
        id: memberId,
        farmaciaId: farm.id,
        nome: 'Operador',
        perfil: 'OPERADOR_BALCAO',
        pinHash: hashPinWithPepper('192837', memberId),
        estado: 'ATIVO',
      },
    });

    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const pair = await pairDeviceWithCode(prisma, { codigo: gen.codigo!, nomeDispositivo: 'Tablet Perdido' });

    // Inicia sessão no tablet
    const auth1 = await authenticateBalcaoPin(prisma, {
      farmaciaId: farm.id,
      memberId: membro.id,
      pin: '192837',
      rawDeviceToken: pair.deviceToken,
    });
    expect(auth1.ok).toBe(true);
    expect(prisma._db.sessoes[0].revogadaEm).toBeNull();

    // Administrador revoga o tablet perdido
    const revokeRes = await revokePharmacyDevice(prisma, farm.id, pair.dispositivo!.id, 'admin-dt');
    expect(revokeRes.ok).toBe(true);

    // 1. A sessão ativa criada nesse dispositivo foi revogada na BD
    expect(prisma._db.sessoes[0].revogadaEm).not.toBeNull();

    // 2. Qualquer nova tentativa de PIN no tablet revogado é recusada
    const auth2 = await authenticateBalcaoPin(prisma, {
      farmaciaId: farm.id,
      memberId: membro.id,
      pin: '192837',
      rawDeviceToken: pair.deviceToken,
    });
    expect(auth2.ok).toBe(false);
    expect(auth2.statusCode).toBe(401);
    expect(auth2.error).toContain('revogado');
  });

  it('6. Rate Limit de PIN: 5 falhas bloqueiam temporariamente por 15 minutos', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia BruteForce', nif: '505016424', slug: 'brute', estado: 'ATIVO' },
    });
    const membro = await prisma.membroFarmacia.create({
      data: {
        farmaciaId: farm.id,
        nome: 'Operador Alvo',
        perfil: 'OPERADOR_BALCAO',
        pinHash: hashPinWithPepper('654321', 'mem-bf'),
        estado: 'ATIVO',
      },
    });

    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const pair = await pairDeviceWithCode(prisma, { codigo: gen.codigo!, nomeDispositivo: 'Tablet BF' });

    // 5 tentativas com PIN errado
    for (let i = 0; i < 5; i++) {
      const failRes = await authenticateBalcaoPin(prisma, {
        farmaciaId: farm.id,
        memberId: membro.id,
        pin: '000000',
        rawDeviceToken: pair.deviceToken,
      });
      expect(failRes.ok).toBe(false);
      expect(failRes.statusCode).toBe(401);
    }

    // A 6ª tentativa é bloqueada por rate limit (429)
    const blockRes = await authenticateBalcaoPin(prisma, {
      farmaciaId: farm.id,
      memberId: membro.id,
      pin: '654321', // Mesmo com o PIN certo agora, está bloqueado temporariamente!
      rawDeviceToken: pair.deviceToken,
    });
    expect(blockRes.ok).toBe(false);
    expect(blockRes.statusCode).toBe(429);
    expect(blockRes.error).toContain('bloqueado temporariamente');
  });

  it('7. Allowlist Estrita de Permissões: Sessão de PIN bloqueia qualquer permissão fora da lista permitida', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Allowlist', nif: '505016425', slug: 'allowlist', estado: 'ATIVO' },
    });
    // Diretor Técnico possui validar_clinica, ver_faturacao e usar_copilot
    const memberId = 'mem-dt-allow';
    const dt = await prisma.membroFarmacia.create({
      data: {
        id: memberId,
        farmaciaId: farm.id,
        nome: 'Dra. Diretora Técnica',
        perfil: 'DIRETOR_TECNICO',
        pinHash: hashPinWithPepper('998877', memberId),
        estado: 'ATIVO',
      },
    });

    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const pair = await pairDeviceWithCode(prisma, { codigo: gen.codigo!, nomeDispositivo: 'Balcão DT' });

    const authRes = await authenticateBalcaoPin(prisma, {
      farmaciaId: farm.id,
      memberId: dt.id,
      pin: '998877',
      rawDeviceToken: pair.deviceToken,
    });

    expect(authRes.ok).toBe(true);
    const perms = authRes.permissoes!;

    // 1. Todas as permissões concedidas devem pertencer estritamente a PIN_ALLOWED_PERMISSIONS
    for (const p of perms) {
      expect(PIN_ALLOWED_PERMISSIONS.has(p as any)).toBe(true);
    }

    // 2. Permissões clínicas e financeiras do DT DEVEM ser barradas na sessão por PIN
    expect(perms).not.toContain('validar_clinica'); // Exige password
    expect(perms).not.toContain('ver_faturacao');  // Exige password
    expect(perms).not.toContain('ver_custos');
    expect(perms).not.toContain('ver_margens');
    expect(perms).not.toContain('gerir_equipa_dispositivos');
    expect(perms).not.toContain('ver_auditoria');

    // 3. Permissões permitidas de balcão estão presentes
    expect(perms).toContain('ver_stock_validades');
    expect(perms).toContain('usar_copilot');
    expect(perms).toContain('executar_tarefas');
  });

  it('8. Validade de Código de Emparelhamento: exatamente 10 minutos', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia CodeTime', nif: '505016426', slug: 'codetime', estado: 'ATIVO' },
    });
    const before = Date.now();
    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const after = Date.now();

    expect(gen.ok).toBe(true);
    expect(gen.expiraEm).toBeDefined();

    const diffMs = gen.expiraEm!.getTime() - before;
    // Deve ser ~10 minutos (600.000 ms) com tolerância de 2 segundos
    expect(diffMs).toBeGreaterThanOrEqual(600000 - 2000);
    expect(diffMs).toBeLessThanOrEqual(600000 + (after - before) + 2000);
  });

  it('9. Dispositivo esquecido/inativo por mais de 90 dias é revogado automaticamente', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia OldDevice', nif: '505016427', slug: 'olddev', estado: 'ATIVO' },
    });
    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const pair = await pairDeviceWithCode(prisma, { codigo: gen.codigo!, nomeDispositivo: 'Tablet Antigo' });

    // Simular que o dispositivo não é usado há 91 dias
    const devRecord = prisma._db.dispositivos.find((d: any) => d.id === pair.dispositivo!.id);
    const noventaUmDiasAtras = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    devRecord.ultimoUsoEm = noventaUmDiasAtras;
    devRecord.emparelhadoEm = noventaUmDiasAtras;

    const val = await validateDeviceToken(prisma, farm.id, pair.deviceToken);
    expect(val.valid).toBe(false);
    expect(val.error).toContain('inatividade superior a 90 dias');
    expect(devRecord.revogadoEm).not.toBeNull();
  });

  it('10. Endpoint /api/balcao/operadores exige dispositivo emparelhado e lista operadores ativos', async () => {
    const farm = await prisma.farmacia.create({
      data: { nome: 'Farmácia Operadores', nif: '505016428', slug: 'operadores', estado: 'ATIVO' },
    });
    await prisma.membroFarmacia.create({
      data: {
        farmaciaId: farm.id,
        nome: 'Operador Balcão 1',
        perfil: 'OPERADOR_BALCAO',
        pinHash: 'dummy',
        estado: 'ATIVO',
      },
    });

    const { app } = buildFastifyApp({ prisma, isProd: false });

    // 1. Sem dispositivo emparelhado -> 401
    const unauthRes = await app.inject({
      method: 'GET',
      url: `/api/balcao/operadores?farmaciaId=${farm.id}`,
    });
    expect(unauthRes.statusCode).toBe(401);

    // 2. Com dispositivo emparelhado -> 200 e lista operadores
    const gen = await generatePairingCode(prisma, farm.id, 'admin');
    const pair = await pairDeviceWithCode(prisma, { codigo: gen.codigo!, nomeDispositivo: 'Tablet Kiosk' });

    const okRes = await app.inject({
      method: 'GET',
      url: `/api/balcao/operadores?farmaciaId=${farm.id}`,
      headers: { cookie: `dev=${pair.deviceToken}` },
    });
    expect(okRes.statusCode).toBe(200);
    const data = JSON.parse(okRes.body);
    expect(data.ok).toBe(true);
    expect(data.operadores.length).toBe(1);
    expect(data.operadores[0].nome).toBe('Operador Balcão 1');
  });

  it('11. Rota /balcao devolve página HTML do terminal', async () => {
    const { app } = buildFastifyApp({ prisma, isProd: false });
    const res = await app.inject({
      method: 'GET',
      url: '/balcao',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Terminal de Atendimento');
  });
});
