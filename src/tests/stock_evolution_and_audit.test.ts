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
    expect(report.resumoAtual.liquidez_recuperada_comprovada_eur).toBeGreaterThanOrEqual(0);
    expect(report.resumoAtual.stock_ativo_eur).toBeGreaterThan(0);
    expect(report.resumoAtual.dias_medios_rotacao).toBeGreaterThan(0);

    // Deve conter evolução mensal com pontos históricos
    expect(Array.isArray(report.evolucaoMensal)).toBe(true);
    expect(report.evolucaoMensal.length).toBeGreaterThan(0);

    const firstPoint = report.evolucaoMensal[0];
    expect(firstPoint).toHaveProperty('mes_ano');
    expect(firstPoint).toHaveProperty('mes_label');
    expect(firstPoint).toHaveProperty('stock_total_eur');
    expect(firstPoint).toHaveProperty('stock_imobilizado_eur');
    expect(firstPoint).toHaveProperty('liquidez_recuperada_monos_eur');

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

  it('3. Arquitetura Marco Zero (Cenário A: 1 Snapshot) vs. Evolução MoM (Cenário B: >=2 Snapshots Reais)', async () => {
    // Mock Cenário A: Marco Zero (sem snapshots anteriores)
    const mockPrismaMarcoZero: any = {
      farmacia: {
        findUnique: async () => ({ id: 'farm-mz', nome: 'Farmácia Marco Zero' }),
      },
      inventario: {
        findMany: async () => [
          { cnp_codigo: '1111111', quantidade: 10, custo_unitario: 10.0, data_validade: null },
          { cnp_codigo: '2222222', quantidade: 5, custo_unitario: 20.0, data_validade: null },
        ],
      },
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('InventarioSnapshot')) {
          return []; // 0 snapshots -> Marco Zero
        }
        if (sql.includes('365 days')) {
          return [{ total_ano: 365000 }];
        }
        return [{ val_tot: 15000, qtd_tot: 1200 }];
      },
    };

    const mzReport = await getStockEvolutionAnalytics(mockPrismaMarcoZero, 'farm-mz');
    expect(mzReport.is_marco_zero).toBe(true);
    expect(mzReport.total_posicoes_stock).toBe(1);
    expect(mzReport.resumoAtual.stock_total_eur).toBe(200); // 10*10 + 5*20
    expect(mzReport.resumoAtual.stock_total_unidades).toBe(15);
    expect(mzReport.resumoAtual.liquidez_recuperada_comprovada_eur).toBe(0);
    expect(mzReport.comparativoMoM.has_comparison).toBe(false);
    expect(mzReport.evolucaoMensal.length).toBe(1);
    expect(mzReport.evolucaoMensal[0].origem_dados).toBe('INVENTARIO_FISICO');
    expect(mzReport.evolucaoMensal[0].is_marco_zero).toBe(true);

    // Mock Cenário B: 2 Snapshots Reais (Outubro -> Novembro com redução de stock e recuperação de liquidez)
    const mockPrismaMultiSnapshot: any = {
      farmacia: {
        findUnique: async () => ({ id: 'farm-mom', nome: 'Farmácia Evolução MoM' }),
      },
      inventario: {
        findMany: async () => [
          { cnp_codigo: '1111111', quantidade: 8, custo_unitario: 10.0, data_validade: null },
        ],
      },
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('InventarioSnapshot')) {
          return [
            { mes: new Date('2026-10-01T00:00:00Z'), val_tot: 50000, qtd_tot: 5000 },
            { mes: new Date('2026-11-01T00:00:00Z'), val_tot: 45000, qtd_tot: 4500 },
          ];
        }
        if (sql.includes('ANY(')) {
          // Vendas de monos entre snapshots: 1000€ PVP -> 650€ custo recuperado (65%)
          return [{ val_tot: 1000, qtd_tot: 80 }];
        }
        if (sql.includes('365 days')) {
          return [{ total_ano: 500000 }];
        }
        return [{ val_tot: 42000, qtd_tot: 3100 }];
      },
    };

    const momReport = await getStockEvolutionAnalytics(mockPrismaMultiSnapshot, 'farm-mom');
    expect(momReport.is_marco_zero).toBe(false);
    expect(momReport.total_posicoes_stock).toBe(2);
    expect(momReport.comparativoMoM.has_comparison).toBe(true);
    expect(momReport.comparativoMoM.variacao_stock_eur).toBe(-5000);
    expect(momReport.comparativoMoM.variacao_stock_pct).toBe(-10);
    expect(momReport.comparativoMoM.tendencia_monos).toBe('REDUCAO');
    expect(momReport.resumoAtual.liquidez_recuperada_comprovada_eur).toBe(650);
    expect(momReport.evolucaoMensal[0].origem_dados).toBe('SNAPSHOT_REAL');
    expect(momReport.evolucaoMensal[0].is_marco_zero).toBe(true);
    expect(momReport.evolucaoMensal[1].is_marco_zero).toBe(false);
    expect(momReport.evolucaoMensal[1].liquidez_recuperada_monos_eur).toBe(650);
  });

  it('4. Deve auditar desempenho de campanhas com vendas específicas vs globais e cálculo de quota', async () => {
    const { toolConsultarDesempenhoCampanhas } = await import('../services/copilot_semantic_layer');

    const mockPrisma: any = {
      campanhaAtiva: {
        findMany: async () => [
          {
            id: 'camp-123',
            campanhaId: 'pack_inverno',
            titulo: 'Campanha Teste Inverno',
            icone: '❄️',
            estado: 'ATIVA',
            dataInicio: new Date('2026-10-01T00:00:00Z'),
            dataFim: new Date('2026-10-31T23:59:59Z'),
            descontoAplicadoPct: 15,
            produtosJson: [
              { cnp: '1234567', designacao: 'Xarope Tosse', stock_atual: 20, custo_unitario: 5.0 },
              { cnp: '7654321', designacao: 'Vitamina C', stock_atual: 30, custo_unitario: 3.0 },
            ],
          },
        ],
      },
      venda: {
        aggregate: async (args: any) => {
          return {
            _max: { data_venda: new Date('2026-10-31T00:00:00Z') },
            _sum: { quantidade: 1000, valor_total: 20000 },
          };
        },
        groupBy: async (args: any) => {
          return [
            { cnp_codigo: '1234567', _sum: { quantidade: 10, valor_total: 100 } },
            { cnp_codigo: '7654321', _sum: { quantidade: 5, valor_total: 40 } },
          ];
        },
      },
      inventario: {
        findMany: async () => [
          { cnp_codigo: '1234567', quantidade: 10, custo_unitario: 5.0, produto: { designacao: 'Xarope Tosse' } },
          { cnp_codigo: '7654321', quantidade: 25, custo_unitario: 3.0, produto: { designacao: 'Vitamina C' } },
        ],
      },
    };

    const ctx = { farmaciaId: 'farm-test', userId: 'user-test', farmaciaNome: 'Farmácia Teste', nif: '500000000' };
    const res: any = await toolConsultarDesempenhoCampanhas(mockPrisma, ctx, {
      campanha_id: 'camp-123',
      data_inicio: '2026-10-01',
      data_fim: '2026-10-31',
    });

    expect(res.meta.campanha_id).toBe('camp-123');
    expect(res.totais.titulo).toBe('Campanha Teste Inverno');
    expect(res.totais.resumo_periodo.unidades_especificas_campanha).toBe(15);
    expect(res.totais.resumo_periodo.faturacao_especifica_campanha_eur).toBe(140);
    expect(res.totais.resumo_periodo.faturacao_global_farmacia_periodo_eur).toBe(20000);
    expect(res.totais.resumo_periodo.quota_faturacao_campanha_pct).toBe(0.7); // (140 / 20000) * 100 = 0.7%
    expect(res.linhas.length).toBe(2);

    // Linha 1: Xarope Tosse: stock 20, vendidas 10, fat 100, escoamento 50%
    const l1 = res.linhas[0];
    expect(l1[0]).toBe('1234567');
    expect(l1[2]).toBe(20); // stock inicial
    expect(l1[3]).toBe(10); // vendidas
    expect(l1[4]).toBe(100); // faturação
    expect(l1[6]).toBe(50); // 50% escoamento
    expect(l1[7]).toBe(50); // 10 un * 5€ custo desmobilizado = 50€
  });
});
