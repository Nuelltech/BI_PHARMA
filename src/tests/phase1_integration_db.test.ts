import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { executeCopilotSqlSandbox } from '../platform/copilot_sql_sandbox';
import { computeEffectivePermissions } from '../services/auth_permissions';

/**
 * Testes de integração contra PostgreSQL REAL (papéis, vistas e esquema copilot).
 * Só correm com INTEGRATION_DB=1 (ex.: `INTEGRATION_DB=1 npx vitest run src/tests/phase1_integration_db.test.ts`).
 * ATENÇÃO: só fazem leituras e tentativas de ataque bloqueadas; não escrevem dados de negócio.
 */
const RUN = process.env.INTEGRATION_DB === '1';

describe.skipIf(!RUN)('Fase 1 — Integração real: papéis de BD + vistas + isolamento entre farmácias', () => {
  let prisma: PrismaClient;
  let farmA = '';
  let farmB = '';
  const balcao = computeEffectivePermissions('OPERADOR_BALCAO', [], 'PASSWORD');
  const prop = computeEffectivePermissions('PROPRIETARIO', [], 'PASSWORD');

  beforeAll(async () => {
    prisma = new PrismaClient();
    const groups = await prisma.martProdutoMetricas.groupBy({ by: ['farmaciaId'], _count: { _all: true } });
    const withData = groups.filter((g) => g._count._all > 0).map((g) => g.farmaciaId);
    expect(withData.length).toBeGreaterThanOrEqual(2);
    [farmA, farmB] = withData;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. Cada farmácia só vê as suas linhas (contagem do sandbox == contagem por farmaciaId)', async () => {
    for (const farm of [farmA, farmB]) {
      const expected = await prisma.martProdutoMetricas.count({ where: { farmaciaId: farm } });
      const res = await executeCopilotSqlSandbox(prisma, farm, balcao, 'SELECT count(*) AS n FROM produtos');
      expect(res.ok).toBe(true);
      expect(Number((res.rows as any)[0].n)).toBe(expected);
    }
  });

  it('2. Ataque set_config / pg_sleep / multi-statement é recusado pelo parser', async () => {
    const attacks = [
      `SELECT set_config('app.farmacia_id', '${farmB}', true)`,
      `SELECT count(*) FROM produtos WHERE set_config('app.farmacia_id', '${farmB}', true) = 'x'`,
      'SELECT pg_sleep(10)',
      'SELECT 1; SELECT 2',
    ];
    for (const sql of attacks) {
      const res = await executeCopilotSqlSandbox(prisma, farmA, prop, sql);
      expect(res.ok).toBe(false);
    }
  });

  it('3. Papel sem custos: a BD nega tabelas base e a vista de custos (mesmo sem parser)', async () => {
    const attempt = async (sql: string) => {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$executeRaw`SELECT set_config('app.farmacia_id', ${farmA}, true)`;
          await tx.$executeRawUnsafe('SET LOCAL ROLE copilot_ro_sem_custo');
          await tx.$queryRawUnsafe(sql);
        });
        return 'allowed';
      } catch (e: any) {
        return String(e?.message || e);
      }
    };

    expect(await attempt('SELECT 1 FROM public."MartProdutoMetricas" LIMIT 1')).toMatch(/permission denied|permiss/i);
    expect(await attempt('SELECT 1 FROM public.sessoes LIMIT 1')).toMatch(/permission denied|permiss/i);
    expect(await attempt('SELECT 1 FROM copilot.produtos_com_custo LIMIT 1')).toMatch(/permission denied|permiss/i);
    expect(await attempt('SELECT custo_unitario FROM copilot.produtos LIMIT 1')).toMatch(/does not exist|custo_unitario/i);
    expect(await attempt('SELECT 1 FROM copilot.produtos LIMIT 1')).toBe('allowed');
  });

  it('4. Proprietário (papel com custos) consegue ler custo_unitario', async () => {
    const res = await executeCopilotSqlSandbox(prisma, farmA, prop, 'SELECT cnp_codigo, custo_unitario FROM produtos_com_custo LIMIT 3');
    expect(res.ok).toBe(true);
    expect(res.role).toBe('copilot_ro_com_custo');
    expect((res.rows || []).length).toBeGreaterThan(0);
  });

  it('5. Data API: anon/authenticated sem acesso e RLS ativo nas tabelas de segurança', async () => {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT c.relname, c.relrowsecurity AS rls,
              has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
              has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN ('sessoes','tokens_seguranca','auditoria_seguranca','membros_farmacia','limites_taxa','Utilizador','SessaoAdmin','TokenRecuperacao')`
    );
    expect(rows.length).toBe(8);
    for (const r of rows) {
      expect(r.rls).toBe(true);
      expect(r.anon_select).toBe(false);
      expect(r.auth_select).toBe(false);
    }
  });
});
