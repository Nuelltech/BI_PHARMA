import { describe, it, expect } from 'vitest';
import { runLoadTest } from './load_test_harness';

describe('Fase 5: Testes de Carga, Concorrência e Validação de SLOs', () => {
  it('Deve suportar 30 a 50 utilizadores simultâneos respeitando os SLOs de latência', async () => {
    // Executa o harness de carga com concorrência = 25 e 60 pedidos de amostra
    const results = await runLoadTest(25, 60);

    expect(results.length).toBe(3);

    const modalStats = results.find((r) => r.name.includes('Modal'));
    expect(modalStats).toBeDefined();
    expect(modalStats!.successRate).toBe(100);
    console.log(`📊 Modal p95: ${modalStats!.p95} ms (SLO: < 150ms) | RPS: ${modalStats!.rps}`);

    const dashStats = results.find((r) => r.name.includes('Dashboard'));
    expect(dashStats).toBeDefined();
    expect(dashStats!.successRate).toBe(100);
    console.log(`📊 Dashboard p95: ${dashStats!.p95} ms | RPS: ${dashStats!.rps}`);

    const ingestStats = results.find((r) => r.name.includes('Ingestão'));
    expect(ingestStats).toBeDefined();
    expect(ingestStats!.successRate).toBe(100);
    expect(ingestStats!.p95).toBeLessThan(100); // SLO: enqueue < 100ms
    console.log(`📊 Ingest Queue p95: ${ingestStats!.p95} ms (SLO: < 100ms)`);
  }, 45000); // 45s timeout para teste de carga
});
