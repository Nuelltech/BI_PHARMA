import { describe, it, expect } from 'vitest';
import {
  resolveJanelaMonos,
  detectAmbiguousBareQuery,
  toolConsultaComercial,
} from '../services/copilot_consulta_comercial';
import { matchesLabFilter, checkMonthCompletenessD6 } from '../services/copilot_semantic_layer';
import { normalizePortugueseMonthNames } from '../services/copilot_validation';
import { buildExecutiveReportFromStructuredData } from '../services/copilot_reporting';

describe('Fase 2 — Regra C2: Conversão determinística de janelas de monos e proteção de atraso', () => {
  const HOJE = '2026-11-23';
  const DADOS_ATE = '2026-10-31'; // atraso = 23 dias

  it('converte "3 meses" exatamente para 90 dias (igual ao painel)', () => {
    const j = resolveJanelaMonos({ janela_mono_qtd: 3, janela_mono_unidade: 'meses' }, HOJE, DADOS_ATE);
    expect(j.dias).toBe(90);
    expect(j.bloqueado).toBe(false);
    expect(j.atrasoDadosDias).toBe(23);
  });

  it('converte "meio ano" exatamente para 180 dias (igual ao painel)', () => {
    const j = resolveJanelaMonos({ janela_mono_unidade: 'meio_ano' }, HOJE, DADOS_ATE);
    expect(j.dias).toBe(180);
    expect(j.bloqueado).toBe(false);
  });

  it('converte "desde setembro" (2026-09-01) em 83 dias até 2026-11-23', () => {
    const j = resolveJanelaMonos({ janela_mono_desde: '2026-09-01' }, HOJE, DADOS_ATE);
    expect(j.dias).toBe(83);
    expect(j.desdePt).toBe('01-09-2026');
    expect(j.bloqueado).toBe(false);
  });

  it('bloqueia "última semana" (7 dias <= 23 dias de atraso) sem inventar números e propõe alternativas', () => {
    const j = resolveJanelaMonos({ janela_mono_qtd: 1, janela_mono_unidade: 'semanas' }, HOJE, DADOS_ATE);
    expect(j.dias).toBe(7);
    expect(j.bloqueado).toBe(true);
    expect(j.aviso_markdown).toContain('31-10-2026');
    expect(j.aviso_markdown).toContain('90 dias');
    expect(j.aviso_markdown).toContain('180 dias');
  });

  it('usa 90 dias como padrão quando nada é especificado', () => {
    const j = resolveJanelaMonos({}, HOJE, DADOS_ATE);
    expect(j.dias).toBe(90);
    expect(j.bloqueado).toBe(false);
  });
});

describe('Fase 2 — Deteção de pergunta ambígua curta (ex.: "Bial")', () => {
  it('identifica "Bial" sozinho como ambíguo e devolve 3 opções', () => {
    const r = detectAmbiguousBareQuery('Bial');
    expect(r.isAmbiguous).toBe(true);
    expect(r.termo).toBe('Bial');
    expect(r.reply).toContain('1.');
    expect(r.reply).toContain('2.');
    expect(r.reply).toContain('3.');
  });

  it('não marca perguntas com intenção clara como ambíguas', () => {
    expect(detectAmbiguousBareQuery('vendas da Bial nos últimos 3 meses').isAmbiguous).toBe(false);
    expect(detectAmbiguousBareQuery('monos').isAmbiguous).toBe(false);
    expect(detectAmbiguousBareQuery('olá').isAmbiguous).toBe(false);
  });
});

describe('Fase 2 — toolConsultaComercial com fixtures congeladas', () => {
  const mockPrisma: any = {
    martProdutoMes: {
      findFirst: async () => ({ mes: '2026-10' }),
      findMany: async (q?: any) => {
        const allRows = [
          { cnp_codigo: '1111111', mes: '2026-07', quantidade: 11, valor_total: 110 },
          { cnp_codigo: '2222222', mes: '2026-07', quantidade: 14, valor_total: 140 },
          { cnp_codigo: '1111111', mes: '2026-08', quantidade: 10, valor_total: 100 },
          { cnp_codigo: '2222222', mes: '2026-08', quantidade: 14, valor_total: 140 },
          { cnp_codigo: '1111111', mes: '2026-09', quantidade: 12, valor_total: 120 },
          { cnp_codigo: '2222222', mes: '2026-09', quantidade: 15, valor_total: 150 },
          { cnp_codigo: '1111111', mes: '2026-10', quantidade: 20, valor_total: 200 },
          { cnp_codigo: '2222222', mes: '2026-10', quantidade: 10, valor_total: 100 },
          { cnp_codigo: '4444444', mes: '2026-10', quantidade: 5, valor_total: 50 }, // Labialfarma (NÃO é Bial!)
          { cnp_codigo: '5555555', mes: '2026-09', quantidade: 2, valor_total: 40 }, // Bial sem stock (só em ProdutoMestre)
        ];
        const allowedMeses: string[] | undefined = q?.where?.mes?.in;
        return allowedMeses ? allRows.filter((r) => allowedMeses.includes(r.mes)) : allRows;
      },
    },
    produtoMestre: {
      findMany: async () => [
        { cnp_codigo: '1111111', designacao: 'Bial Produto A 20 mg', laboratorio_titular: 'Bial - Portela & Cª', dci: 'Molecula A', categoria: 'Cardiovascular', tipo_venda: 'MSRM' },
        { cnp_codigo: '2222222', designacao: 'Mylan Produto B 50 mg', laboratorio_titular: 'Mylan', dci: 'Molecula B', categoria: 'SNC', tipo_venda: 'MSRM' },
        { cnp_codigo: '3333333', designacao: 'Mylan Excesso C 10 mg', laboratorio_titular: 'Viatris', dci: 'Molecula C', categoria: 'SNC', tipo_venda: 'MSRM' },
        { cnp_codigo: '4444444', designacao: 'Labialfarma Creme 30 g', laboratorio_titular: 'Labialfarma', dci: null, categoria: 'Dermocosmética', tipo_venda: 'VENDA_LIVRE' },
        { cnp_codigo: '5555555', designacao: 'Bial Sem Stock 10 mg', laboratorio_titular: 'Bial - Consumer Health', dci: 'Molecula D', categoria: 'Cardiovascular', tipo_venda: 'MSRM' },
      ],
    },
    martProdutoMetricas: {
      findMany: async () => [
        {
          cnp_codigo: '1111111',
          designacao: 'Bial Produto A 20 mg',
          laboratorio_titular: 'Bial',
          molecula_dci: 'Molecula A',
          categoria: 'Cardiovascular',
          tipo_venda: 'MSRM',
          stock_total_unidades: 10,
          vmm: 14,
          margem_padrao: 40,
          total_unidades_vendidas: 42,
          custo_unitario_medio: 5,
          pvp: 10,
          eh_mono: false,
          eh_excesso_cobertura: false,
          eh_risco_caducidade: false,
          meses_ate_validade: 18,
        },
        {
          cnp_codigo: '2222222',
          designacao: 'Mylan Produto B 50 mg',
          laboratorio_titular: 'Mylan',
          molecula_dci: 'Molecula B',
          categoria: 'SNC',
          tipo_venda: 'MSRM',
          stock_total_unidades: 0,
          vmm: 6,
          margem_padrao: 55,
          total_unidades_vendidas: 72,
          custo_unitario_medio: 4,
          pvp: 10,
          eh_mono: false,
          eh_excesso_cobertura: false,
          eh_risco_caducidade: false,
          meses_ate_validade: null,
        },
        {
          cnp_codigo: '3333333',
          designacao: 'Mylan Excesso C 10 mg',
          laboratorio_titular: 'Mylan',
          molecula_dci: 'Molecula C',
          categoria: 'SNC',
          tipo_venda: 'MSRM',
          stock_total_unidades: 20,
          vmm: 1,
          margem_padrao: 50,
          total_unidades_vendidas: 12,
          custo_unitario_medio: 3,
          pvp: 6,
          eh_mono: false,
          eh_excesso_cobertura: true,
          eh_risco_caducidade: false,
          meses_ate_validade: 12,
        },
      ],
    },
  };

  const ctxGestor: any = { farmaciaId: 'farm-test', farmaciaNome: 'Farmácia Teste', perfil: 'GESTOR', verFaturacao: true };
  const ctxBalcao: any = { farmaciaId: 'farm-test', farmaciaNome: 'Farmácia Teste', perfil: 'BALCAO', verFaturacao: false };

  it('devolve aviso de atraso de dados para monos da última semana', async () => {
    const res: any = await toolConsultaComercial(
      mockPrisma,
      ctxGestor,
      { foco: 'monos', janela_mono_qtd: 1, janela_mono_unidade: 'semanas' },
      'sess-test',
      1,
      '2026-11-23'
    );
    expect(res.ok).toBe(true);
    expect(res.bloqueado_atraso_dados).toBe(true);
    expect(res.aviso_markdown).toContain('31-10-2026');
  });

  it('compara outubro vs setembro e ordena o que subiu corretamente (meses completos)', async () => {
    const res: any = await toolConsultaComercial(
      mockPrisma,
      ctxGestor,
      { foco: 'comparacao_periodos', mes_atual: '2026-10', mes_anterior: '2026-09', direcao_variacao: 'subiu' },
      'sess-test',
      1,
      '2026-11-23'
    );
    expect(res.ok).toBe(true);
    expect(res.bloqueado_dados_incompletos_d6).toBeUndefined();
    expect(res.totais.total_atual_eur).toBe(350);
    expect(res.totais.total_anterior_eur).toBe(310);
    expect(res.totais.delta_eur).toBe(40);
    expect(res.relatorio_markdown).toContain('Bial Produto A');
    expect(res.result_ref).toBeTruthy();
  });

  it('calcula vendas da Bial nos últimos 3 meses (inclui sem stock e exclui Labialfarma)', async () => {
    const res: any = await toolConsultaComercial(
      mockPrisma,
      ctxGestor,
      { foco: 'vendas', laboratorio: 'Bial', ultimos_n_meses: 3 },
      'sess-test',
      1,
      '2026-11-23'
    );
    expect(res.ok).toBe(true);
    expect(res.totais.produtos_vendidos).toBe(2); // 1111111 + 5555555 (sem stock), SEM 4444444 (Labialfarma)
    expect(res.totais.faturacao_eur).toBe(460); // 420 + 40
    expect(res.totais.unidades_vendidas).toBe(44); // 42 + 2
    expect(res.relatorio_markdown).toContain('Bial Sem Stock');
    expect(res.relatorio_markdown).not.toContain('Labialfarma');
    expect(res.relatorio_markdown).toContain('2026-08 a 2026-10');
  });

  it('recomenda encomenda da Mylan apenas para REPOR/baixa cobertura e exclui excessos', async () => {
    const res: any = await toolConsultaComercial(
      mockPrisma,
      ctxGestor,
      { foco: 'recomendacao_encomenda', laboratorio: 'Mylan' },
      'sess-test',
      1,
      '2026-11-23'
    );
    expect(res.ok).toBe(true);
    expect(res.totais.n_a_encomendar).toBe(1);
    expect(res.totais.total_qtd_sugerida).toBe(9); // ceil(6 * 1.5 - 0) = 9
    expect(res.relatorio_markdown).toContain('Mylan Produto B');
    expect(res.relatorio_markdown).not.toContain('Mylan Excesso C');
  });

  it('oculta valores em EUR quando perfil não tem ver_faturacao (BALCAO)', async () => {
    const res: any = await toolConsultaComercial(
      mockPrisma,
      ctxBalcao,
      { foco: 'vendas', laboratorio: 'Bial', ultimos_n_meses: 3 },
      'sess-test',
      1,
      '2026-11-23'
    );
    expect(res.meta.faturacao_oculta).toBe(true);
    expect(res.totais.faturacao_eur).toBeNull();
    expect(res.relatorio_markdown).not.toContain('€');
  });
});

describe('Fase 1 (melhorias em paralelo) — PDF Validades Curtas + singular "1 produto"', () => {
  it('inclui secção dedicada validadesCurtas (com Irbesartan) e usa singular "1 produto"', () => {
    const fixture: any = {
      meta: { laboratorio: 'Teva', periodo_rotulo: '2026 (jan–out)', data_referencia: '2026-10-31', faturacao_oculta: false },
      totais: { produtos_ambito_total: 10, produtos_vendidos: 8, unidades_vendidas: 100, faturacao_eur: 1000, produtos_em_stock: 5, unidades_em_stock: 20, valor_stock_custo: 200 },
      imobilizado_total: { total_produtos_unicos: 3, total_valor_custo: 50 },
      classes_resumo: [{ classe: 'REVER_DADOS', n_produtos: 1, vendas_un: 0, vendas_eur: 0, stock_custo_eur: 1 }],
      acoes_imediatas_por_classe: [
        { classe: 'REVER_DADOS', n_produtos: 1, unidades_a_devolver: null, valor_a_devolver_eur: null, principais: [{ cnp: '5817325', designacao: 'Olfenex', vmm: 0.25 }] },
      ],
      validades: {
        total_contagem: 3,
        produtos: [
          { cnp: '5824503', designacao: 'Fluticasona Teva', validade: '2027-02-28', stock: 10, vmm: 1.64, classificacao: 'DEVOLVER_EXCESSO', unidades_excesso: 3, motivo_classificacao: 'Validade curta' },
          { cnp: '5824504', designacao: 'Aelardis', validade: '2027-03-31', stock: 8, vmm: 0.4, classificacao: 'DEVOLVER_EXCESSO', unidades_excesso: 7, motivo_classificacao: 'Validade curta' },
          { cnp: '5824505', designacao: 'Irbesartan Teva', validade: '2027-04-30', stock: 3, vmm: 0.5, classificacao: 'DEVOLVER_EXCESSO', unidades_excesso: 2, motivo_classificacao: 'Validade curta' },
        ],
      },
      top: [],
      lacunas: [],
    };

    const pdf = buildExecutiveReportFromStructuredData(fixture, {
      farmaciaNome: 'Farmácia A',
      responsavel: 'Direção Técnica',
      verFaturacao: true,
    });

    expect(pdf.acoesPorClasse?.[0]?.resumo).toBe('1 produto');
    expect(pdf.validadesCurtas).toBeDefined();
    expect(pdf.validadesCurtas?.totalRegistos).toBe(3);
    const irbesartanRow = pdf.validadesCurtas?.linhas.find((r) => r[1].includes('Irbesartan'));
    expect(irbesartanRow).toBeDefined();
    expect(irbesartanRow?.[4]).toBe('2 un'); // Devolver
    expect(irbesartanRow?.[5]).toBe('1 un'); // Manter
  });
});

describe('Fase 2 — Correções de revisão (Filtro canónico, Regra D6, Idioma PT-PT)', () => {
  it('matchesLabFilter aceita grupo Bial e rejeita Labialfarma', () => {
    expect(matchesLabFilter('Bial', '', 'Bial')).toBe(true);
    expect(matchesLabFilter('Bial - Consumer Health', '', 'Bial')).toBe(true);
    expect(matchesLabFilter('Bial - Portela & Cª', '', 'Bial')).toBe(true);
    expect(matchesLabFilter('Labialfarma', '', 'Bial')).toBe(false);
    expect(matchesLabFilter('Ratiopharm', '', 'Teva')).toBe(true);
    expect(matchesLabFilter('Viatris', '', 'Mylan')).toBe(true);
  });

  it('Regra D6 deteta mês incompleto (< 70% da média 3M) e bloqueia comparação enganosa', async () => {
    const mockIncompletePrisma: any = {
      martProdutoMes: {
        findFirst: async () => ({ mes: '2026-10' }),
        findMany: async () => [
          { cnp_codigo: '1', mes: '2026-07', quantidade: 100, valor_total: 60000 },
          { cnp_codigo: '2', mes: '2026-07', quantidade: 50, valor_total: 0 },
          { cnp_codigo: '1', mes: '2026-08', quantidade: 100, valor_total: 58000 },
          { cnp_codigo: '2', mes: '2026-08', quantidade: 50, valor_total: 0 },
          { cnp_codigo: '1', mes: '2026-09', quantidade: 100, valor_total: 61000 },
          { cnp_codigo: '2', mes: '2026-09', quantidade: 50, valor_total: 0 },
          { cnp_codigo: '1', mes: '2026-10', quantidade: 50, valor_total: 30000 }, // 50% da média!
        ],
      },
    };
    const d6 = await checkMonthCompletenessD6(mockIncompletePrisma, 'farm-test', '2026-10');
    expect(d6.incompleto).toBe(true);
    expect(d6.aviso).toContain('outubro de 2026 parecem incompletos');

    const res: any = await toolConsultaComercial(
      mockIncompletePrisma,
      { farmaciaId: 'farm-test', farmaciaNome: 'Farmácia Teste', perfil: 'GESTOR', verFaturacao: true } as any,
      { foco: 'comparacao_periodos', mes_atual: '2026-10', mes_anterior: '2026-09', direcao_variacao: 'subiu' },
      'sess-d6',
      1,
      '2026-11-23'
    );
    expect(res.bloqueado_dados_incompletos_d6).toBe(true);
    expect(res.aviso_markdown).toContain('Regra D6');
    expect(res.aviso_markdown).toContain('2026-09 vs 2026-08');
  });

  it('normalizePortugueseMonthNames corrige nomes de meses noutras línguas (ex.: Octubre -> Outubro)', () => {
    const fixed = normalizePortugueseMonthNames('Octubre registou queda face a Septiembre e August (en enero).');
    expect(fixed).toBe('Outubro registou queda face a Setembro e Agosto (en janeiro).');
  });
});
