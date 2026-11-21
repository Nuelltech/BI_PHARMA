import { describe, it, expect } from 'vitest';
import { buildFastifyApp } from '../app_fastify';
import { LEGACY_ROUTES, registerLegacyRoutes } from '../legacy_adapter';
import { computeEffectivePermissions } from '../services/auth_permissions';

function createRoutesTestMockPrisma() {
  const sessoes: any[] = [];
  const utilizadores: any[] = [];
  const farmacias: any[] = [];
  const membros: any[] = [];
  const limites = new Map<string, any>();

  const prisma: any = {
    $extends: () => prisma,
    sessao: {
      findUnique: async ({ where, include }: any) => {
        const s = sessoes.find((x) => x.tokenHash === where.tokenHash);
        if (!s) return null;
        return {
          ...s,
          ...(include?.utilizador ? { utilizador: utilizadores.find((u) => u.id === s.utilizadorId) || null } : {}),
        };
      },
      update: async () => ({}),
    },
    utilizador: {
      findUnique: async ({ where }: any) => utilizadores.find((u) => u.id === where.id) || null,
    },
    membroFarmacia: {
      findMany: async ({ where }: any) =>
        membros.filter((m) => m.utilizadorId === where.utilizadorId && m.estado === 'ATIVO'),
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
      create: async () => ({}),
    },
  };

  return { prisma, sessoes, utilizadores, farmacias, membros };
}

describe('Fase 1 — Isolamento e Declaração Estrita de Rotas (Adaptador Legacy & Fastify)', () => {
  it('1. Todas as rotas legadas têm regra de acesso e permissões válidas declaradas', () => {
    expect(LEGACY_ROUTES.length).toBeGreaterThan(30);

    const seen = new Set<string>();
    for (const r of LEGACY_ROUTES) {
      const key = `${r.method} ${r.url}`;
      expect(seen.has(key), `Rota duplicada: ${key}`).toBe(false);
      seen.add(key);

      expect(['PUBLIC', 'AUTHENTICATED', 'PERMISSION', 'SUPERADMIN']).toContain(r.rule.access);
      if (r.rule.access === 'PERMISSION') {
        expect(r.rule.permissao).toBeDefined();
      }
    }
  });

  it('2. O arranque falha se existir uma rota legada montada sem declaração explícita', () => {
    const { prisma } = createRoutesTestMockPrisma();

    expect(() => {
      const { assertAllRoutesDeclared } = buildFastifyApp({
        prisma,
        extraRegister: (app) => {
          // Rota esquecida sem declareRoute
          app.get('/api/rota-secreta-esquecida', async () => ({ secret: true }));
        },
      });
      assertAllRoutesDeclared();
    }).toThrow(/Rotas sem declaração de permissão.*rota-secreta-esquecida/i);
  });

  it('3. Rotas legadas montadas através do adaptador passam na validação de arranque (100% declaradas)', () => {
    const { prisma } = createRoutesTestMockPrisma();
    let legacyCalled = false;

    const dummyLegacyHandler = async (_req: any, res: any) => {
      legacyCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ legacy: true }));
    };

    const { app, assertAllRoutesDeclared } = buildFastifyApp({
      prisma,
      extraRegister: (fastifyApp, declareRoute) => {
        registerLegacyRoutes(fastifyApp, declareRoute, dummyLegacyHandler);
      },
    });

    // Não deve lançar erro
    expect(() => assertAllRoutesDeclared()).not.toThrow();
  });

  it('4. Pedido sem autenticação a rota protegida legada (/api/analysis) é rejeitado pelo Fastify (401)', async () => {
    const { prisma } = createRoutesTestMockPrisma();
    let legacyCalled = false;

    const dummyLegacyHandler = async (_req: any, res: any) => {
      legacyCalled = true;
      res.writeHead(200);
      res.end('ok');
    };

    const { app } = buildFastifyApp({
      prisma,
      extraRegister: (fastifyApp, declareRoute) => {
        registerLegacyRoutes(fastifyApp, declareRoute, dummyLegacyHandler);
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/analysis',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Sessão (necessária|inválida|expirada)/i);
    expect(legacyCalled).toBe(false); // O handler legado NUNCA foi chamado

    await app.close();
  });

  it('5. Operador sem permissão a rota protegida legada (/api/admin/copilot-finops) é rejeitado com 403', async () => {
    const { prisma, sessoes, utilizadores, farmacias, membros } = createRoutesTestMockPrisma();
    let legacyCalled = false;

    const dummyLegacyHandler = async (_req: any, res: any) => {
      legacyCalled = true;
      res.writeHead(200);
      res.end('ok');
    };

    const { app } = buildFastifyApp({
      prisma,
      extraRegister: (fastifyApp, declareRoute) => {
        registerLegacyRoutes(fastifyApp, declareRoute, dummyLegacyHandler);
      },
    });

    // Cria utilizador comum (sem superadmin)
    const crypto = await import('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    utilizadores.push({ id: 'usr_common', email: 'balcao@farmacia.pt', isSuperadmin: false, ativo: true });
    sessoes.push({
      id: 'sess_1',
      tokenHash,
      utilizadorId: 'usr_common',
      expiraEm: new Date(Date.now() + 3600000),
      revogadaEm: null,
      metodo: 'PASSWORD',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/copilot-finops',
      headers: {
        cookie: `sid=${token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/superadministra/i);
    expect(legacyCalled).toBe(false);

    await app.close();
  });

  it('6. Rotas públicas legadas (como /sw.js e /manifest.json) passam sem autenticação', async () => {
    const { prisma } = createRoutesTestMockPrisma();
    let handlerHit = '';

    const dummyLegacyHandler = async (req: any, res: any) => {
      handlerHit = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const { app } = buildFastifyApp({
      prisma,
      extraRegister: (fastifyApp, declareRoute) => {
        registerLegacyRoutes(fastifyApp, declareRoute, dummyLegacyHandler);
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/manifest.json',
    });

    expect(res.statusCode).toBe(200);
    expect(handlerHit).toBe('/manifest.json');

    await app.close();
  });
});
