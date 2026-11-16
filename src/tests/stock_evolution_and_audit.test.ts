import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { getStockEvolutionAnalytics } from '../services/stock_evolution';
import { getWeeklyTasksAudit } from '../services/weekly_tasks';

const prisma = new PrismaClient();

describe('Evolução de Stock, Imobilizado, Valores Poupados e Auditoria de Tarefas', () => {
  it('1. Deve calcular o relatório de evolução de stock com totais, monos e poupanças', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    if (!farmacia) return;

    const report = await getStockEvolutionAnalytics(prisma, farmacia.id);

    expect(report).toBeDefined();
    expect(report.farmaciaId).toBe(farmacia.id);
    expect(report.resumoAtual.stock_total_eur).toBeGreaterThan(0);
    expect(report.resumoAtual.stock_total_unidades).toBeGreaterThan(0);
    expect(report.resumoAtual.stock_imobilizado_eur).toBeGreaterThanOrEqual(0);
    expect(report.resumoAtual.taxa_imobilizado_pct).toBeGreaterThanOrEqual(0);
    expect(report.resumoAtual.valores_poupados_acumulados_eur).toBeGreaterThanOrEqual(0);

    // Deve conter evolução mensal com pontos históricos
    expect(Array.isArray(report.evolucaoMensal)).toBe(true);
    expect(report.evolucaoMensal.length).toBeGreaterThan(0);

    const firstPoint = report.evolucaoMensal[0];
    expect(firstPoint).toHaveProperty('mes_ano');
    expect(firstPoint).toHaveProperty('mes_label');
    expect(firstPoint).toHaveProperty('stock_total_eur');
    expect(firstPoint).toHaveProperty('stock_imobilizado_eur');
    expect(firstPoint).toHaveProperty('valores_poupados_eur');

    // Comparativo MoM
    expect(report.comparativoMoM).toBeDefined();
    expect(typeof report.comparativoMoM.variacao_stock_pct).toBe('number');
  });

  it('2. Deve obter o relatório de auditoria de tarefas com operadores, quando e o que foi feito', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    if (!farmacia) return;

    const audit = await getWeeklyTasksAudit(prisma, farmacia.id);

    expect(audit).toBeDefined();
    expect(audit.farmaciaId).toBe(farmacia.id);
    expect(typeof audit.totalConcluidas).toBe('number');
    expect(typeof audit.valorProtegidoTotal).toBe('number');
    expect(Array.isArray(audit.operadoresResumo)).toBe(true);
    expect(Array.isArray(audit.tarefas)).toBe(true);

    if (audit.tarefas.length > 0) {
      const task = audit.tarefas[0];
      expect(task).toHaveProperty('id');
      expect(task).toHaveProperty('task_id');
      expect(task).toHaveProperty('categoria');
      expect(task).toHaveProperty('concluido_por');
      expect(task).toHaveProperty('concluido_em');
      expect(task).toHaveProperty('valor_impacto');
    }
  });
});
