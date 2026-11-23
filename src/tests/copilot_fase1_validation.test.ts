import { describe, it, expect } from 'vitest';
import {
  validateRelatorioData,
  validateAndSanitizeLeitura,
  CatalogTermEntry,
} from '../services/copilot_validation';
import { classifyProductAction } from '../services/copilot_semantic_layer';
import { buildExecutiveReportFromStructuredData } from '../services/copilot_reporting';

// Dados congelados (fixtures) — sem dependência da BD de produção
const FIXTURE_CATALOG: CatalogTermEntry[] = [
  { termNorm: 'acido valproico', original: 'Ácido Valpróico', isMsrm: true, isChronic: true },
  { termNorm: 'aelardis', original: 'Aelardis', isMsrm: true, isChronic: false },
  { termNorm: 'duoresp', original: 'DuoResp', isMsrm: true, isChronic: true },
  { termNorm: 'dabigatrano', original: 'Dabigatrano', isMsrm: true, isChronic: true },
  { termNorm: 'atorvastatina', original: 'Atorvastatina', isMsrm: true, isChronic: true },
];

const FIXTURE_RELATORIO = {
  meta: {
    laboratorio: 'Teva',
    ano: 2026,
    periodo_rotulo: '2026 (jan–out)',
    data_referencia: '2026-10-31',
    faturacao_oculta: false,
  },
  totais: {
    produtos_ambito_total: 4,
    produtos_vendidos: 4,
    faturacao_eur: 8163.0,
    unidades_vendidas: 300,
    produtos_em_stock: 4,
    unidades_em_stock: 30,
    valor_stock_custo: 200.0,
    top10_faturacao_eur: 8163.0,
  },
  classes_resumo: [
    { classe: 'MANTER', n_produtos: 2, vendas_un: 260, vendas_eur: 7000.0, stock_custo_eur: 150.0 },
    { classe: 'STOCK_MINIMO', n_produtos: 1, vendas_un: 30, vendas_eur: 1000.0, stock_custo_eur: 30.0 },
    { classe: 'DEVOLVER_EXCESSO', n_produtos: 1, vendas_un: 10, vendas_eur: 163.0, stock_custo_eur: 20.0 },
  ],
  todos_produtos_indice: [
    { cnp: '5889233', designacao: 'Atorvastatina Teva 20 mg', dci: 'Atorvastatina', tipo_venda: 'MSRM', eh_terapeutica_cronica: true, classificacao: 'MANTER' },
    { cnp: '5856513', designacao: 'Aelardis 20 mg', dci: 'Bilastina', tipo_venda: 'MSRM', eh_terapeutica_cronica: false, classificacao: 'DEVOLVER_EXCESSO' },
    { cnp: '5604145', designacao: 'DuoResp Spiromax 160', dci: 'Budesonida + Formoterol', tipo_venda: 'MSRM', eh_terapeutica_cronica: true, classificacao: 'STOCK_MINIMO' },
    { cnp: '5795701', designacao: 'Dabigatrano Teva 110 mg', dci: 'Dabigatrano', tipo_venda: 'MSRM', eh_terapeutica_cronica: true, classificacao: 'MANTER' },
  ],
  imobilizado_total: { total_produtos_unicos: 1, total_valor_custo: 20.0, produtos: [{ cnp: '5856513' }] },
  rever_dados: { total_contagem: 0, produtos: [] },
  lacunas: ['Dados de vendas registados até 31-10-2026 (período 2026 jan-out).'],
  leitura_executiva: 'A Atorvastatina Teva lidera o laboratório com vendas consistentes em 2026.',
};

describe('Fase 1 — Validação 1 (D1–D5), Validação 2 (T1–T7), Vocabulário Fechado e PDF Unificado', () => {
  it('T2: Remove frase com produto fora dos dados (Ácido Valpróico)', () => {
    const texto =
      'A Atorvastatina Teva lidera o laboratório com 8.163,00 € no total. Recomenda-se manter stock mínimo de Ácido Valpróico.';
    const res = validateAndSanitizeLeitura(texto, {
      relatorio: FIXTURE_RELATORIO,
      turnToolResultsJson: [JSON.stringify(FIXTURE_RELATORIO)],
      catalogTerms: FIXTURE_CATALOG,
    });
    expect(res.ok).toBe(false);
    expect(res.failedRules).toContain('T2');
    expect(res.removedSentences.length).toBe(1);
    expect(res.sanitizedText).not.toContain('Ácido Valpróico');
    expect(res.sanitizedText).toContain('Atorvastatina Teva');
  });

  it('T4: Bloqueia "Aelardis em campanha" mesmo sem a palavra literal MSRM', () => {
    const texto =
      'A Atorvastatina Teva mantém procura sólida. Sugerimos incluir o Aelardis em campanha de inverno para acelerar rotação.';
    const res = validateAndSanitizeLeitura(texto, {
      relatorio: FIXTURE_RELATORIO,
      turnToolResultsJson: [JSON.stringify(FIXTURE_RELATORIO)],
      catalogTerms: FIXTURE_CATALOG,
    });
    expect(res.ok).toBe(false);
    expect(res.failedRules).toContain('T4');
    expect(res.sanitizedText).not.toContain('Aelardis em campanha');
  });

  it('T4: Bloqueia "reinterpretação do preço do DuoResp" (MSRM)', () => {
    const texto =
      'A Atorvastatina Teva lidera as vendas. Recomenda-se a reinterpretação do preço do DuoResp para melhorar margem.';
    const res = validateAndSanitizeLeitura(texto, {
      relatorio: FIXTURE_RELATORIO,
      turnToolResultsJson: [JSON.stringify(FIXTURE_RELATORIO)],
      catalogTerms: FIXTURE_CATALOG,
    });
    expect(res.ok).toBe(false);
    expect(res.failedRules).toContain('T4');
    expect(res.sanitizedText).not.toContain('DuoResp');
  });

  it('T5: Bloqueia "devolver todo o Dabigatrano" (terapêutica crónica)', () => {
    const texto =
      'A Atorvastatina Teva apresenta elevada rotação. Deve devolver todo o Dabigatrano ao fornecedor imediatamente.';
    const res = validateAndSanitizeLeitura(texto, {
      relatorio: FIXTURE_RELATORIO,
      turnToolResultsJson: [JSON.stringify(FIXTURE_RELATORIO)],
      catalogTerms: FIXTURE_CATALOG,
    });
    expect(res.ok).toBe(false);
    expect(res.failedRules).toContain('T5');
    expect(res.sanitizedText).not.toContain('devolver todo o Dabigatrano');
  });

  it('T1: Bloqueia "Top 10 = 7.957,10 €" mesmo quando "7957" existe no CNP 5795701', () => {
    const texto =
      'O Top 10 = 7.957,10 € representa o núcleo de vendas. A Atorvastatina Teva lidera o laboratório.';
    const res = validateAndSanitizeLeitura(texto, {
      relatorio: FIXTURE_RELATORIO,
      turnToolResultsJson: [JSON.stringify(FIXTURE_RELATORIO)],
      catalogTerms: FIXTURE_CATALOG,
    });
    expect(res.ok).toBe(false);
    expect(res.failedRules).toContain('T1');
    expect(res.sanitizedText).not.toContain('7.957,10 €');
  });

  it('Validação 1 (D1–D5): aprova relatório íntegro e bloqueia soma de classes errada ou fuga de €', () => {
    expect(validateRelatorioData(FIXTURE_RELATORIO, true).ok).toBe(true);

    // D1 falha se classes não somarem 100%
    const brokenD1 = {
      ...FIXTURE_RELATORIO,
      classes_resumo: FIXTURE_RELATORIO.classes_resumo.slice(0, 2),
    };
    const resD1 = validateRelatorioData(brokenD1, true);
    expect(resD1.ok).toBe(false);
    expect(resD1.failedRules).toContain('D1');

    // D5 falha se houver € sem permissão verFaturacao
    const resD5 = validateRelatorioData(FIXTURE_RELATORIO, false);
    expect(resD5.ok).toBe(false);
    expect(resD5.failedRules).toContain('D5');
  });

  it('Vocabulário Fechado (4.4): REVER_DADOS, DEVOLVER_EXCESSO proporcional e rutura VMM < 1 -> TRABALHAR_ENCOMENDA', () => {
    // Olfenex 0,12 € vs PVP 17,80 € -> REVER_DADOS
    const olfenex = classifyProductAction({
      tipoVenda: 'MNSRM',
      dci: 'Diclofenac',
      designacao: 'Olfenex Artic 20 mg/g',
      stock: 1,
      vendasUn: 2,
      vmm: 0.18,
      margemPct: 99.29,
      ehMono: true,
      ehExcesso: false,
      ehRiscoCaducidade: false,
      custoUnit: 0.12,
      pvp: 17.8,
    });
    expect(olfenex.classificacao).toBe('REVER_DADOS');

    // Fluticasona: 10 un, VMM 1.64, 4 meses -> DEVOLVER_EXCESSO (3 un)
    const fluticasona = classifyProductAction({
      tipoVenda: 'MSRM',
      dci: 'Fluticasona',
      designacao: 'Fluticasona Teva',
      stock: 10,
      vendasUn: 18,
      vmm: 1.64,
      margemPct: 48.5,
      ehMono: false,
      ehExcesso: true,
      ehRiscoCaducidade: true,
      mesesAteValidade: 4,
    });
    expect(fluticasona.classificacao).toBe('DEVOLVER_EXCESSO');
    expect(fluticasona.unidades_excesso).toBe(3);

    // Rutura com VMM 0.3 não crónico -> TRABALHAR_ENCOMENDA
    const ruturaBaixa = classifyProductAction({
      tipoVenda: 'MSRM',
      dci: 'Meloxicam',
      designacao: 'Meloxicam Teva 7.5 mg',
      stock: 0,
      vendasUn: 3,
      vmm: 0.3,
      margemPct: 50,
      ehMono: false,
      ehExcesso: false,
      ehRiscoCaducidade: false,
    });
    expect(ruturaBaixa.classificacao).toBe('TRABALHAR_ENCOMENDA');
  });

  it('PDF Unificado (4.5): gera relatório com mesmos totais do chat, rodapé de validação e respeita verFaturacao', () => {
    const pdfComEur = buildExecutiveReportFromStructuredData(FIXTURE_RELATORIO, {
      farmaciaNome: 'Farmácia A',
      responsavel: 'Dr. Nuno',
      verFaturacao: true,
    });
    expect(pdfComEur.notaFarmaceutica).toContain('Proposta para validação da Direção Técnica');
    expect(pdfComEur.responsavel).toBe('Dr. Nuno');
    expect(pdfComEur.tabela?.linhas.some((r) => r[0].includes('TOTAL'))).toBe(true);
    expect(pdfComEur.kpis.some((k) => k.valor.includes('8.163,00 €') || k.valor.includes('8163,00 €'))).toBe(true);

    const pdfSemEur = buildExecutiveReportFromStructuredData(FIXTURE_RELATORIO, {
      farmaciaNome: 'Farmácia A',
      responsavel: 'Auxiliar',
      verFaturacao: false,
    });
    expect(pdfSemEur.kpis.every((k) => !k.valor.includes('€'))).toBe(true);
    expect(pdfSemEur.tabela?.colunas.every((c) => !c.includes('€'))).toBe(true);
  });
});
