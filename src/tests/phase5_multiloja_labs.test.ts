import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  calculateCrossStoreRebalance,
  getGroupSummary,
} from '../services/cross_store_rebalance';
import {
  getLaboratoriesAnalytics,
  getHistoricalAimAnalytics,
} from '../services/lab_analytics';

describe('Fase 5: Lógica Multi-Loja, Balanceamento de Stock e Laboratórios (AIMs)', () => {
  const prisma = new PrismaClient();

  it('1. Deve calcular o resumo consolidado do grupo de farmácias', async () => {
    const summary = await getGroupSummary(prisma);
    expect(summary.grupoNome).toContain('Grupo Farmacêutico');
    expect(summary.totalFarmacias).toBeGreaterThanOrEqual(1);
    expect(summary.totaisGrupo.artigosUnicos).toBeGreaterThan(0);
    expect(typeof summary.totaisGrupo.valorStockTotal).toBe('number');
  });

  it('2. Deve executar o algoritmo de balanceamento cruzado entre farmácias sem erros', async () => {
    const rebalance = await calculateCrossStoreRebalance(prisma);
    expect(Array.isArray(rebalance.sugestoes)).toBe(true);
    expect(typeof rebalance.totalOportunidades).toBe('number');
    expect(typeof rebalance.totalPoupancaEstimadaEur).toBe('number');

    if (rebalance.sugestoes.length > 0) {
      const primeiro = rebalance.sugestoes[0];
      expect(primeiro.cnp_codigo).toBeDefined();
      expect(primeiro.origem.farmaciaId).not.toBe(primeiro.destino.farmaciaId);
      expect(primeiro.quantidade_sugerida).toBeGreaterThan(0);
      expect(primeiro.valor_poupanca_eur).toBeGreaterThan(0);
    }
  });

  it('3. Deve listar e calcular a análise comparativa de laboratórios titulares', async () => {
    const labs = await getLaboratoriesAnalytics(prisma);
    expect(Array.isArray(labs)).toBe(true);
    if (labs.length > 0) {
      const primeiro = labs[0];
      expect(primeiro.laboratorio).toBeDefined();
      expect(typeof primeiro.faturacaoAcumulada).toBe('number');
      expect(typeof primeiro.margemMediaPct).toBe('number');
    }
  });

  it('4. Deve suportar pesquisa histórica de múltiplos códigos AIM', async () => {
    // Testar com string de múltiplos AIMs
    const query = '320, 2121, 6581';
    const aimRes = await getHistoricalAimAnalytics(prisma, query);
    expect(aimRes.aimsPesquisados).toEqual(['320', '2121', '6581']);
    expect(Array.isArray(aimRes.produtos)).toBe(true);
    expect(typeof aimRes.faturacaoTotalAimEur).toBe('number');

    // Testar com lista vazia (resiliência)
    const emptyRes = await getHistoricalAimAnalytics(prisma, '');
    expect(emptyRes.produtos.length).toBe(0);
    expect(emptyRes.totalProdutos).toBe(0);
  });
});
