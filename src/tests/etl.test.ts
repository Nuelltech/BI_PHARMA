import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  parseInventarioPdfFile,
  parseValidadesPdfFile,
  parseVendasCsvFile,
} from '../services/ingestion';
import {
  parsePortugueseDecimal,
  parsePortugueseInt,
  normalizeCnpCodigo,
  parseValidadeMMYYYY,
} from '../services/transformation';
import { classifyProduct } from '../services/classifier';

describe('Motor de ETL e Inteligência Farmacêutica - Testes de Extração e Limpeza', () => {
  it('deve classificar corretamente produtos em VENDA_LIVRE, MNSRM e MSRM', () => {
    expect(classifyProduct('7353607', 'Absorvit Energia Comp X 30', 23).tipo_venda).toBe('VENDA_LIVRE');
    expect(classifyProduct('6506279', 'Fitonasal Spray Nasal Concent 30Ml', 6).tipo_venda).toBe('VENDA_LIVRE');
    expect(classifyProduct('1017350', 'Lovren V1', 23).tipo_venda).toBe('VENDA_LIVRE');
    expect(classifyProduct('3854585', 'ben-u-ron , 500 mg Blister 20 Unidade(s) Comp', 6).tipo_venda).toBe('MNSRM');
    expect(classifyProduct('5035654', 'Voltaren Emulgel , 10 mg/g Bisnaga 100 g Gel', 6).tipo_venda).toBe('MNSRM');
    expect(classifyProduct('5755640', 'Ozempic, 1 mg/0,74mL-3mL x 1 sol inj caneta pré-cheia', 6).tipo_venda).toBe('MSRM');
    expect(classifyProduct('5069463', 'Atorvastatina Farmoz MG, 20 mg Blister 28 Unidade(s) Comp', 6).tipo_venda).toBe('MSRM');
  });
  it('deve limpar e converter valores monetários e inteiros portugueses corretamente', () => {
    expect(Number(parsePortugueseDecimal('1.328,90€', 'Valor'))).toBe(1328.9);
    expect(Number(parsePortugueseDecimal('2,42 €', 'Custo'))).toBe(2.42);
    expect(Number(parsePortugueseDecimal('0,00€', 'Zero'))).toBe(0);
    expect(parsePortugueseInt('- 1', 'Stock')).toBe(-1);
    expect(parsePortugueseInt(' 252 ', 'Stock')).toBe(252);
  });

  it('deve normalizar códigos CNP de 6 ou 7 dígitos e rejeitar inválidos', () => {
    expect(normalizeCnpCodigo('5111505')).toBe('5111505');
    expect(normalizeCnpCodigo(' 111505 ')).toBe('0111505');
    expect(() => normalizeCnpCodigo('ABC1234')).toThrow();
  });

  it('deve converter validades MM-YYYY para o último segundo do último dia do mês em UTC', () => {
    const dez2026 = parseValidadeMMYYYY('12-2026');
    expect(dez2026.toISOString()).toBe('2026-12-31T23:59:59.000Z');

    const fev2027 = parseValidadeMMYYYY('02-2027');
    expect(fev2027.toISOString()).toBe('2027-02-28T23:59:59.000Z');
  });

  it('deve extrair 100% dos 3.426 artigos, 13.155 unidades e 65.422,60€ do PDF de Inventário', async () => {
    const defaultPath = path.resolve(process.cwd(), 'baptista', '21000lista_20261019104350.pdf');
    const pdfPath = fs.existsSync(defaultPath) ? defaultPath : path.resolve(process.cwd(), '21000lista_20261019104350.pdf');
    const parsed = await parseInventarioPdfFile(pdfPath);

    expect(parsed.farmaciaNif).toBe('505016419');
    expect(parsed.rows.length).toBe(3426);

    const totalUnidades = parsed.rows.reduce((acc, r) => acc + parsePortugueseInt(r.stock, 'Stock'), 0);
    expect(totalUnidades).toBe(13155);

    const totalValor = parsed.rows.reduce(
      (acc, r) => acc + Number(parsePortugueseDecimal(r.valor_s_iva, 'Valor')),
      0
    );
    expect(totalValor.toFixed(2)).toBe('65422.60');
  }, 30000);

  it('deve extrair todas as 707 linhas do PDF de Controlo de Prazos de Validades', async () => {
    const defaultPath = path.resolve(process.cwd(), 'baptista', '21001lista_20261019190456_Validades.pdf');
    const pdfPath = fs.existsSync(defaultPath) ? defaultPath : path.resolve(process.cwd(), '21001lista_20261019190456_Validades.pdf');
    const parsed = await parseValidadesPdfFile(pdfPath);

    expect(parsed.rows.length).toBe(707);
    expect(parsed.rows[0].ord).toBe('1');
    expect(parsed.rows[0].codigo).toBe('6399733');
    expect(parsed.rows[0].validade).toBe('12-2026');
    expect(parsed.rows[706].ord).toBe('707');
    expect(parsed.rows[706].codigo).toBe('2441681');
  }, 20000);

  it('deve ler os 10.731 artigos do CSV de Vendas do Sifarma e desdobrar os meses com vendas', async () => {
    const defaultPath = path.resolve(process.cwd(), 'baptista', 'vendas baptista25-26.csv');
    const csvPath = fs.existsSync(defaultPath) ? defaultPath : path.resolve(process.cwd(), 'vendas baptista25-26.csv');
    const parsed = await parseVendasCsvFile(csvPath, 2025);

    expect(parsed.totalArtigosCatalogo).toBe(10731);
    expect(parsed.stagingRows.length).toBeGreaterThan(15000);
  }, 30000);
});
