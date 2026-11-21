import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { buildFastifyApp } from '../app_fastify';
import { LEGACY_ROUTES, registerLegacyRoutes } from '../legacy_adapter';
import { clearAllSessionCache } from '../services/auth_service';
import { sanitizePayloadForPermissions } from '../services/auth_permissions';

function createIsolationSweepMockPrisma() {
  const farmacias = [
    { id: 'farm_A', nome: 'Farmácia Baptista', slug: 'farmacia-baptista', estado: 'ATIVO' },
    { id: 'farm_B', nome: 'Farmácia Avenida', slug: 'farmacia-avenida', estado: 'ATIVO' },
  ];

  const utilizadores = [
    { id: 'usr_A', email: 'owner_a@baptista.pt', nome: 'Proprietário A', isSuperadmin: false, ativo: true },
    { id: 'usr_B', email: 'operador_b@avenida.pt', nome: 'Operador B', isSuperadmin: false, ativo: true },
  ];

  const membros = [
    {
      id: 'mem_A',
      utilizadorId: 'usr_A',
      farmaciaId: 'farm_A',
      perfil: 'PROPRIETARIO',
      permissoesExtra: [],
      farmaciaPadrao: true,
      estado: 'ATIVO',
    },
    {
      id: 'mem_B',
      utilizadorId: 'usr_B',
      farmaciaId: 'farm_B',
      perfil: 'OPERADOR_BALCAO',
      permissoesExtra: [],
      farmaciaPadrao: true,
      estado: 'ATIVO',
    },
  ];

  const sessoes: any[] = [];
  const auditoria: any[] = [];
  const limites = new Map<string, any>();

  const prisma: any = {
    $extends: () => prisma,
    farmacia: {
      findUnique: async ({ where }: any) => farmacias.find((f) => f.id === where.id) || null,
      findFirst: async ({ where }: any) => farmacias.find((f) => !where?.id || f.id === where.id) || null,
      findMany: async () => farmacias,
    },
    utilizador: {
      findUnique: async ({ where }: any) => utilizadores.find((u) => u.id === where.id || u.email === where.email) || null,
    },
    membroFarmacia: {
      findMany: async ({ where }: any) => {
        return membros
          .filter((m) => m.utilizadorId === where.utilizadorId && (!where.estado || m.estado === where.estado))
          .map((m) => ({
            ...m,
            farmacia: farmacias.find((f) => f.id === m.farmaciaId),
          }));
      },
      findFirst: async ({ where }: any) =>
        membros.find((m) => m.utilizadorId === where.utilizadorId && m.farmaciaId === where.farmaciaId) || null,
    },
    sessao: {
      findUnique: async ({ where, include }: any) => {
        const s = sessoes.find((x) => x.tokenHash === where.tokenHash);
        if (!s) return null;
        return {
          ...s,
          ...(include?.utilizador ? { utilizador: utilizadores.find((u) => u.id === s.utilizadorId) || null } : {}),
        };
      },
      update: async ({ where, data }: any) => {
        const s = sessoes.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s;
      },
    },
    limiteTaxa: {
      findUnique: async ({ where }: any) => limites.get(where.chave) || null,
      upsert: async ({ where, create, update }: any) => {
        const val = limites.has(where.chave) ? { ...limites.get(where.chave), ...update } : { ...create };
        limites.set(where.chave, val);
        return val;
      },
      update: async ({ where, data }: any) => {
        const val = { ...limites.get(where.chave), ...data };
        limites.set(where.chave, val);
        return val;
      },
    },
    auditoriaSeguranca: {
      create: async ({ data }: any) => {
        const row = { id: 'aud_' + (auditoria.length + 1), ts: new Date(), ...data };
        auditoria.push(row);
        return row;
      },
    },
    martTenantKpis: {
      findFirst: async () => ({
        total_artigos_inventario: 120,
        total_unidades_stock: 540,
        valor_total_stock_custo: 12500.5,
      }),
    },
  };

  return { prisma, farmacias, utilizadores, membros, sessoes, auditoria };
}

describe('Fase 1 — Varredura Completa de Isolamento por Rota (100% das Rotas)', () => {
  let mock: ReturnType<typeof createIsolationSweepMockPrisma>;
  let rawTokenB: string;

  beforeEach(() => {
    clearAllSessionCache();
    mock = createIsolationSweepMockPrisma();

    // Cria sessão válida para Utilizador B (membro exclusivo da Farmácia B)
    rawTokenB = crypto.randomBytes(32).toString('hex');
    const tokenHashB = crypto.createHash('sha256').update(rawTokenB).digest('hex');

    mock.sessoes.push({
      id: 'sess_user_B',
      tokenHash: tokenHashB,
      utilizadorId: 'usr_B',
      farmaciaAtivaId: 'farm_B',
      metodo: 'PASSWORD',
      criadaEm: new Date(),
      expiraEm: new Date(Date.now() + 12 * 3600 * 1000),
      revogadaEm: null,
    });
  });

  it('1. Varredura sistemática: Utilizador B nunca acede a recursos da Farmácia A em NENHUMA rota protegida', async () => {
    let legacyHit = false;
    const legacyHandler = async (_req: any, res: any) => {
      legacyHit = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ leakedFarmaciaAData: true }));
    };

    const { app, routeRegistry } = buildFastifyApp({
      prisma: mock.prisma,
      extraRegister: (fastifyApp, declareRoute) => {
        registerLegacyRoutes(fastifyApp, declareRoute, legacyHandler);
      },
    });

    // Filtra todas as rotas que exigem contexto de tenant (PERMISSION ou rotas autenticadas de tenant)
    const protectedRoutes = LEGACY_ROUTES.filter((r) => r.rule.access === 'PERMISSION');
    expect(protectedRoutes.length).toBeGreaterThan(20);

    for (const r of protectedRoutes) {
      legacyHit = false;
      const targetUrl = r.url.replace(':cnp', '5050164');

      const response = await app.inject({
        method: r.method,
        url: targetUrl,
        headers: {
          cookie: `sid=${rawTokenB}`,
          'x-farmacia-id': 'farm_A', // Tentativa maliciosa de IDOR / BOLA para ler Farmácia A
        },
        payload: r.method === 'POST' ? { cnp: '5050164' } : undefined,
      });

      // Deve ser categoricamente rejeitado pelo Fastify preHandler
      expect(response.statusCode, `Rota ${r.method} ${r.url} falhou o isolamento de tenant`).toBe(403);
      expect(response.json().error).toMatch(/Não tem (acesso|permissão)|Operação reservada/i);
      expect(legacyHit, `O handler legado foi executado para ${r.url}! Fuga de isolamento!`).toBe(false);
    }

    // Valida que auditoria registou os eventos ACESSO_NEGADO
    const negados = mock.auditoria.filter((a) => a.evento === 'ACESSO_NEGADO');
    expect(negados.length).toBeGreaterThanOrEqual(protectedRoutes.length);

    await app.close();
  });

  it('2. Respostas com reply.hijack() (SSE, Copilot, MCP) enviam obrigatoriamente os cabeçalhos de segurança defensivos', async () => {
    const sseHandler = async (_req: any, res: any) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write('event: ping\ndata: {}\n\n');
      res.end();
    };

    const { app } = buildFastifyApp({
      prisma: mock.prisma,
      extraRegister: (fastifyApp, declareRoute) => {
        declareRoute({ method: 'GET', url: '/api/weekly-tasks/stream-test', rule: { access: 'PUBLIC' } });
        fastifyApp.get('/api/weekly-tasks/stream-test', async (req, reply) => {
          reply.hijack();
          await sseHandler(req.raw, reply.raw);
        });
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/weekly-tasks/stream-test',
    });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toContain('no-cache');

    await app.close();
  });

  it('3. Filtro de segurança pvp_min e custos: Operador sem ver_custos nunca recebe pvp_min nem valores de custo', async () => {
    const { app } = buildFastifyApp({
      prisma: mock.prisma,
    });

    // Pedido feito por Operador B (sem ver_custos) à sua própria farmácia (farm_B)
    const res = await app.inject({
      method: 'GET',
      url: '/api/tenant/dashboard-summary',
      headers: {
        cookie: `sid=${rawTokenB}`,
        'x-farmacia-id': 'farm_B',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalArtigos).toBe(120);
    expect(body.totalUnidades).toBe(540);

    // O campo valorStockCusto NUNCA deve ser incluído na resposta de operadores de balcão
    expect(body.valorStockCusto).toBeUndefined();

    // Teste no filtro de precificação e campanhas:
    const payloadComercial = {
      campanha: 'Inverno 2026',
      artigos: [
        {
          cnp: '1234567',
          designacao: 'Benuron 500mg',
          pvp: 4.5,
          pvp_min: 3.85,
          custo_unitario: 3.2,
          margem_pct: 18.5,
          alerta: 'CAMPANHA_ABAIXO_MINIMO',
        },
      ],
    };

    // Operador sem ver_custos / ver_margens
    const permsBalcao = new Set<any>(['ver_stock_validades', 'usar_copilot']);
    const sanitized = sanitizePayloadForPermissions(payloadComercial, permsBalcao);

    const art = sanitized.artigos[0] as any;
    expect(art.pvp).toBe(4.5);
    expect(art.alerta).toBe('CAMPANHA_ABAIXO_MINIMO'); // Alerta mantido
    expect(art.pvp_min).toBeUndefined(); // Valor numérico de pvp_min suprimido
    expect(art.custo_unitario).toBeUndefined(); // Custo suprimido
    expect(art.margem_pct).toBeUndefined(); // Margem suprimida

    await app.close();
  });
});
