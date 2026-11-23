import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  toolRelatorioLaboratorio,
  computeSafeMarginPct,
  classifyProductAction,
  matchesLabFilter,
} from '../services/copilot_semantic_layer';
import { isTherapeuticChronic } from '../services/copilot_chronic_therapies';
import { validateCopilotAnswer } from '../services/copilot_validation';
import { calculateClaudeCostEur } from '../services/copilot_engine';
import { canVerFaturacao, getPermissoesForRole } from '../platform/permissoes';
import type { ToolSecurityContext } from '../services/mcp_pharma_tools';

const FARMACIA_A_ID = '3ac42c32-87a8-4afe-98cc-4ca61ac64aca';

describe('Bi-Pharma Copilot v2 — Bateria de Testes do Roadmap (P0 a P5)', () => {
  let prisma: PrismaClient;
  let adminCtx: ToolSecurityContext;
  let auxiliarCtx: ToolSecurityContext;

  beforeAll(() => {
    prisma = new PrismaClient();
    adminCtx = {
      farmaciaId: FARMACIA_A_ID,
      farmaciaNome: 'Farmácia A (Teste)',
      nif: '505016419',
      perfil: 'PROPRIETARIO',
      verFaturacao: true,
    };
    auxiliarCtx = {
      farmaciaId: FARMACIA_A_ID,
      farmaciaNome: 'Farmácia A (Teste)',
      nif: '505016419',
      perfil: 'OPERADOR_BALCAO',
      verFaturacao: false,
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // --------------------------------------------------------------------------
  // P0.1 & P1.4: Vendas por Laboratório com LEFT JOIN e Relatório Laboratório
  // --------------------------------------------------------------------------
  it('P0.1 & P1.4: Teva 2026 bate exatamente com os números verificados na BD', async () => {
    const report: any = await toolRelatorioLaboratorio(prisma, adminCtx, {
      laboratorio: 'Teva',
      ano: '2026',
    });

    expect(report.ok).toBe(true);
    expect(report.ferramenta).toBe('relatorio_laboratorio');

    // Totais verificados contra a especificação
    expect(report.totais.produtos_vendidos).toBe(149);
    expect(report.totais.unidades_vendidas).toBe(2456);
    expect(report.totais.faturacao_eur).toBeCloseTo(22443.79, 1);

    // Monos verificados (Regra C1 unificada com o painel: stock > 0 e 0 vendas positivas nos últimos 90 dias)
    expect(report.monos.total_contagem).toBe(29);
    expect(report.monos.total_valor_custo).toBeCloseTo(197.23, 1);

    // Excessos verificados
    expect(report.excessos.total_contagem).toBe(24);
    expect(report.excessos.total_valor_custo).toBeCloseTo(187.40, 1);

    // Validades em risco (< 6 meses) verificadas (3 produtos: Fluticasona, Aelardis, Irbesartan)
    expect(report.validades.total_contagem).toBe(3);
    const nomesValidades = report.validades.produtos.map((p: any) => p.designacao);
    expect(nomesValidades.some((n: string) => n.includes('Fluticasona'))).toBe(true);
    expect(nomesValidades.some((n: string) => n.includes('Aelardis'))).toBe(true);
    expect(nomesValidades.some((n: string) => n.includes('Irbesartan'))).toBe(true);

    // Imobilizado consolidado sem duplicados (~278.47 €)
    expect(report.imobilizado_total.total_valor_custo).toBeCloseTo(278.47, 1);

    // Produtos em rutura com histórico de vendas
    expect(report.em_rutura.total_contagem).toBe(39);
    expect(report.sem_vendas.total_contagem).toBe(3);
  });

  // --------------------------------------------------------------------------
  // P0.2: Margem % Padronizada sem IVA
  // --------------------------------------------------------------------------
  it('P0.2: Margem % usa margem_padrao sem IVA em vez da fórmula ingénua com IVA', () => {
    // Caso Atorvastatina Teva: pvp com iva 5.51, custo 1.88.
    // Fórmula antiga com IVA: (5.51 - 1.88)/5.51 = 65.9% (ERRADA)
    // Fórmula canónica com margem_padrao: 63.8% (CORRETA)
    const mgAtorvastatina = computeSafeMarginPct(1.88, 5.51, 63.83, 6);
    expect(mgAtorvastatina).toBe(63.8);

    // Caso Simedur: pvp 12.00, custo 9.56.
    // Fórmula antiga com IVA: (12 - 9.56)/12 = 20.3% (ERRADA)
    // Margem padrão real: 15.5% (CORRETA)
    const mgSimedur = computeSafeMarginPct(9.56, 12.0, 15.5, 6);
    expect(mgSimedur).toBe(15.5);

    // Se margem_padrao for nula, calcular estritamente retirando IVA de 6%
    const pvpComIva = 10.60;
    const custo = 5.00;
    // pvpSemIva = 10.60 / 1.06 = 10.00 -> margem = (10 - 5)/10 = 50.0%
    const mgCalculada = computeSafeMarginPct(custo, pvpComIva, null, 6);
    expect(mgCalculada).toBe(50.0);
  });

  // --------------------------------------------------------------------------
  // P0.3: Regra de Mono Estrita
  // --------------------------------------------------------------------------
  it('P0.3: Nenhum produto com vendas recentes nos últimos 3 meses é classificado como mono', async () => {
    const report: any = await toolRelatorioLaboratorio(prisma, adminCtx, {
      laboratorio: 'Teva',
      ano: '2026',
    });

    for (const p of report.monos.produtos) {
      expect(p.stock).toBeGreaterThan(0);
      expect(p.eh_mono).toBe(true);
      // Dias sem vendas tem de ser real e superior a 90 dias
      if (p.dias_sem_vendas !== null) {
        expect(p.dias_sem_vendas).toBeGreaterThanOrEqual(90);
      }
    }
  });

  // --------------------------------------------------------------------------
  // P1.5: Classificação "Manter / Rever / Reduzir" Calculada em Código
  // --------------------------------------------------------------------------
  it('P1.5: Classificação determinística protege MSRMs e Terapêutica Crónica', () => {
    // 1. Em rutura com vendas -> Repor stock
    const actRutura = classifyProductAction({
      tipoVenda: 'MSRM',
      dci: 'atorvastatina',
      designacao: 'Atorvastatina Teva 20 mg',
      stock: 0,
      vendasUn: 255,
      vmm: 25.3,
      margemPct: 63.8,
      ehMono: false,
      ehExcesso: false,
      ehRiscoCaducidade: false,
    });
    expect(actRutura.classificacao).toBe('REPOR');

    // 2. VMM >= 2.0 -> Manter
    const actLocomotiva = classifyProductAction({
      tipoVenda: 'MSRM',
      dci: 'esomeprazol',
      designacao: 'Esomeprazol Ratiopharm 20 mg',
      stock: 15,
      vendasUn: 128,
      vmm: 12.75,
      margemPct: 71.7,
      ehMono: false,
      ehExcesso: false,
      ehRiscoCaducidade: false,
    });
    expect(actLocomotiva.classificacao).toBe('MANTER');

    // 3. MSRM crónico com rotação lenta (VMM < 1.0) -> NUNCA descontinuar / não manter
    const actCronicoLento = classifyProductAction({
      tipoVenda: 'MSRM',
      dci: 'donepezilo',
      designacao: 'Donepezilo Teva 10 mg',
      stock: 1,
      vendasUn: 8,
      vmm: 0.8,
      margemPct: 50.3,
      ehMono: false,
      ehExcesso: false,
      ehRiscoCaducidade: false,
    });
    expect(actCronicoLento.classificacao).toBe('STOCK_MINIMO');
    expect(actCronicoLento.classificacao).not.toBe('DESCONTINUAR');

    // 4. MSRM crónico sem vendas (mono) -> Trabalhar sob encomenda
    const actCronicoMono = classifyProductAction({
      tipoVenda: 'MSRM',
      dci: 'venlafaxina',
      designacao: 'Venlafaxina Mepha 75 mg',
      stock: 1,
      vendasUn: 0,
      vmm: 0,
      margemPct: 60.0,
      ehMono: true,
      ehExcesso: false,
      ehRiscoCaducidade: false,
    });
    expect(actCronicoMono.classificacao).toBe('TRABALHAR_ENCOMENDA');
    expect(actCronicoMono.classificacao).not.toBe('DESCONTINUAR');

    // 5. MNSRM com margem baixa (< 30%) e vendas fracas -> Descontinuar
    const actMnsrmBaixo = classifyProductAction({
      tipoVenda: 'MNSRM',
      dci: null,
      designacao: 'Pastilhas de Garganta Genéricas',
      stock: 3,
      vendasUn: 2,
      vmm: 0.2,
      margemPct: 22.0,
      ehMono: false,
      ehExcesso: false,
      ehRiscoCaducidade: false,
    });
    expect(actMnsrmBaixo.classificacao).toBe('DESCONTINUAR');
  });

  // --------------------------------------------------------------------------
  // P2: Validação Estrita Pré-Entrega (Guardrails)
  // --------------------------------------------------------------------------
  it('P2: Validador bloqueia campanhas para MSRM e descontinuação de crónicos', () => {
    // Violação Legal: Campanha para MSRM
    const resMsrm = validateCopilotAnswer(
      'Recomendo criar uma campanha ou pack promocional com desconto para o MSRM Atorvastatina Teva.',
      ['{"ok":true}'],
      ['consultar_vendas']
    );
    expect(resMsrm.ok).toBe(false);
    expect(resMsrm.problems.some((p) => p.includes('[V15]'))).toBe(true);

    // Violação Clínica: Sugerir "não manter" medicamento crónico
    const resCronico = validateCopilotAnswer(
      'O produto Olanzapina Teva tem baixa rotação, por isso sugiro não manter na farmácia.',
      ['{"ok":true}'],
      ['consultar_vendas']
    );
    expect(resCronico.ok).toBe(false);
    expect(resCronico.problems.some((p) => p.includes('[V16]'))).toBe(true);

    // Violação Numérica: Valor alucinado que não existe nos resultados
    const resNumero = validateCopilotAnswer(
      'O valor total imobilizado do laboratório Teva é de 420,00 €.',
      ['{"totais":{"faturacao_eur":22443.79},"imobilizado_total":{"total_valor_custo":281.06}}'],
      ['relatorio_laboratorio']
    );
    expect(resNumero.ok).toBe(false);
    expect(resNumero.problems.some((p) => p.includes('[V17]'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // P3: Custos & Preços Reais Haiku 4.5
  // --------------------------------------------------------------------------
  it('P3: Preços reais Haiku 4.5 ($1/$5, cache $1.25/$0.10) e conversão EUR', () => {
    // 1M input tokens + 1M output tokens em Haiku 4.5 = $1 + $5 = $6 USD * 0.92 = 5.52 EUR
    const costEur = calculateClaudeCostEur(
      'claude-haiku-4-5-20251001',
      1_000_000,
      1_000_000,
      0,
      0
    );
    expect(costEur).toBe(5.52);

    // Cache hit: 1M cache read tokens = $0.10 USD * 0.92 = 0.092 EUR
    const cacheReadEur = calculateClaudeCostEur(
      'claude-haiku-4-5-20251001',
      0,
      0,
      0,
      1_000_000
    );
    expect(cacheReadEur).toBe(0.092);
  });

  // --------------------------------------------------------------------------
  // P4: Governança RBAC e Ocultação de Faturação
  // --------------------------------------------------------------------------
  it('P4: Perfis operacionais não podem ver faturação (€) e relatório oculta valores', async () => {
    // Permissões por Role (C4: não existe COMPRADOR; sem perfil = false)
    expect(canVerFaturacao('PROPRIETARIO')).toBe(true);
    expect(canVerFaturacao('GESTOR')).toBe(true);
    expect(canVerFaturacao('DIRETOR')).toBe(true);
    expect(canVerFaturacao('DIRETOR_TECNICO')).toBe(true);
    expect(canVerFaturacao('COMPLETO')).toBe(true);

    expect(canVerFaturacao('COMPRADOR')).toBe(false);
    expect(canVerFaturacao('OPERADOR_BALCAO')).toBe(false);
    expect(canVerFaturacao('AUXILIAR')).toBe(false);
    expect(canVerFaturacao(null)).toBe(false);

    // Relatório executado com perfil de AUXILIAR / OPERADOR_BALCAO
    const reportAux: any = await toolRelatorioLaboratorio(prisma, auxiliarCtx, {
      laboratorio: 'Teva',
      ano: '2026',
    });

    expect(reportAux.ok).toBe(true);
    expect(reportAux.meta.faturacao_oculta).toBe(true);
    expect(reportAux.totais.faturacao_eur).toBeNull();
    // Unidades vendidas e contagens continuam visíveis
    expect(reportAux.totais.unidades_vendidas).toBe(2456);
    expect(reportAux.top[0].vendas_eur).toBeNull();
    expect(reportAux.top[0].vendas_un).toBeGreaterThan(0);
  });
});
