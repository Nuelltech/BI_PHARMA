import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  detectSifarmaPdfKind,
  parseSifarmaInventarioNormalLines,
  parseSifarmaSemConsumoLines,
} from '../services/sifarma_pdf_parsers';

const AREOSA_DIR = path.resolve(process.cwd(), 'Areosa_Viana');
const INV_PDF = path.join(AREOSA_DIR, 'inventario_15_07_2026.pdf');
const SEM_CONSUMO_PDF = path.join(AREOSA_DIR, 'Sem_consumo.pdf');

describe('Sifarma PDF Parsers (Inventário Normal & Produtos sem Consumo)', () => {
  it('extrai e valida inventario_15_07_2026.pdf com precisão exata de artigos, stock, PVP e custo', async () => {
    if (!fs.existsSync(INV_PDF)) return;
    const buf = fs.readFileSync(INV_PDF);
    const { kind, lines } = await detectSifarmaPdfKind(buf);
    expect(kind).toBe('SIFARMA_INVENTARIO_NORMAL');

    const parsed = parseSifarmaInventarioNormalLines(lines);
    expect(parsed.farmaciaNif).toBe('516375415');
    expect(parsed.dataImpressao).toBe('2026-07-16');
    expect(parsed.rows.length).toBeGreaterThan(5000);

    const totalUn = parsed.rows.reduce((s, r) => s + r.stock, 0);
    expect(parsed.rows.length).toBe(5336);
    expect(totalUn).toBe(33332);

    // Verifica linha 1 real: Accu-Chek SmartGuide Sensor SNS -> stock 5, PVP 48.40, custo 44.99
    const accu = parsed.rows.find((r) => r.codigo === '7129213');
    expect(accu).toBeDefined();
    expect(accu?.stock).toBe(5);
    expect(accu?.pvp).toBe(48.4);
    expect(accu?.custoUnitario).toBe(44.99);
    expect(accu?.prateleira).toBe('ABO');

    // Verifica linha sem prateleira: PaperMints 7487488 -> stock 62, PVP 2.95, custo 1.67
    const pm = parsed.rows.find((r) => r.codigo === '7487488');
    expect(pm).toBeDefined();
    expect(pm?.stock).toBe(62);
    expect(pm?.pvp).toBe(2.95);
    expect(pm?.custoUnitario).toBe(1.67);
  }, 30_000);

  it('extrai e valida Sem_consumo.pdf com datas de última venda/compra, família e taxa de IVA', async () => {
    if (!fs.existsSync(SEM_CONSUMO_PDF)) return;
    const buf = fs.readFileSync(SEM_CONSUMO_PDF);
    const { kind, lines } = await detectSifarmaPdfKind(buf);
    expect(kind).toBe('SIFARMA_SEM_CONSUMO');

    const parsed = parseSifarmaSemConsumoLines(lines);
    expect(parsed.farmaciaNif).toBe('516375415');
    expect(parsed.semConsumoDesde).toBe('2025-07-01');
    expect(parsed.rows.length).toBe(1969);

    const sumSemIva = Number(parsed.rows.reduce((s, r) => s + r.valorSemIva, 0).toFixed(2));
    const sumComIva = Number(parsed.rows.reduce((s, r) => s + r.valorComIva, 0).toFixed(2));
    expect(sumSemIva).toBe(47033.88);
    expect(sumComIva).toBe(55938.05);

    // Locetar 5773858: stock 8, Ult. Venda 2021-06-22, Ult. Compra 2026-05-20, PVP 32.65, IVA 6%
    const loc = parsed.rows.find((r) => r.codigo === '5773858');
    expect(loc).toBeDefined();
    expect(loc?.stock).toBe(8);
    expect(loc?.dataUltimaVenda).toBe('2021-06-22');
    expect(loc?.dataUltimaCompra).toBe('2026-05-20');
    expect(loc?.pvp).toBe(32.65);
    expect(loc?.taxaIvaEstimada).toBe(6);
    expect(loc?.familia).toBe('Alopatia');
  }, 30_000);
});
