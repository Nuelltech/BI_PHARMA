import fs from 'fs';
import crypto from 'crypto';
import csv from 'csv-parser';
import iconv from 'iconv-lite';
import pdf from 'pdf-parse';
import { PrismaClient } from '@prisma/client';

export interface ParsedInventarioRow {
  prat: string | null;
  aim: string | null;
  codigo: string;
  designacao: string;
  lote: string;
  stock: string;
  custo_unit: string;
  valor_s_iva: string;
  taxa_iva: string;
}

export interface ParsedInventarioPdf {
  farmaciaNome: string | null;
  farmaciaNif: string | null;
  dataImpressao: Date | null;
  rows: ParsedInventarioRow[];
}

export interface ParsedValidadeRow {
  ord: string;
  codigo: string;
  designacao: string;
  lote: string;
  stock: string;
  pratel: string | null;
  validade: string;
  correccao: string | null;
}

export interface ParsedValidadesPdf {
  farmaciaNome: string | null;
  farmaciaNif: string | null;
  dataImpressao: Date | null;
  rows: ParsedValidadeRow[];
}

export interface ParsedVendaStagingRow {
  codigo_produto: string;
  descricao: string;
  quantidade: string;
  valor_venda: string;
  custo_unitario: string | null;
  pvp: string | null;
  margem: string | null;
  data_movimento: string; // ISO YYYY-MM-DD
}

interface PdfTextItem {
  str: string;
  x: number;
  y: number;
}

function parsePrintDate(str: string): Date | null {
  const m = str.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  return new Date(
    Date.UTC(
      parseInt(yyyy, 10),
      parseInt(mm, 10) - 1,
      parseInt(dd, 10),
      parseInt(hh, 10),
      parseInt(min, 10),
      parseInt(ss, 10)
    )
  );
}

/**
 * Extrai de forma estruturada (posicional por coordenadas X/Y) todas as linhas do PDF de Inventário.
 */
export async function parseInventarioPdfFile(filePath: string): Promise<ParsedInventarioPdf> {
  const dataBuffer = fs.readFileSync(filePath);
  const pagesItems: PdfTextItem[][] = [];

  await pdf(dataBuffer, {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent();
      const items: PdfTextItem[] = tc.items
        .map((i: any) => ({
          str: String(i.str ?? '').trim(),
          x: Math.round(i.transform[4]),
          y: Math.round(i.transform[5]),
        }))
        .filter((i: PdfTextItem) => i.str.length > 0);
      pagesItems.push(items);
      return '';
    },
  });

  let farmaciaNome: string | null = null;
  let farmaciaNif: string | null = null;
  let dataImpressao: Date | null = null;
  let currentTaxaIva = '0';
  const rows: ParsedInventarioRow[] = [];

  for (const items of pagesItems) {
    let currentRow: Partial<ParsedInventarioRow> & { designacaoParts?: string[] } | null = null;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];

      // Metadados do cabeçalho
      if (!farmaciaNif && item.str === 'NIF:' && items[idx + 1]) {
        farmaciaNif = items[idx + 1].str.trim();
      }
      if (!farmaciaNome && item.str === 'Localização :' && items[idx + 1]) {
        farmaciaNome = items[idx + 1].str.trim();
      }
      if (!dataImpressao && item.str.includes('Impressão') && items[idx + 1]) {
        const dt = parsePrintDate(`${item.str} ${items[idx + 1].str}`);
        if (dt) dataImpressao = dt;
      } else if (!dataImpressao && /^\d{2}-\d{2}-\d{4}/.test(item.str)) {
        const dt = parsePrintDate(item.str);
        if (dt) dataImpressao = dt;
      }

      // Mudança de secção de Taxa de IVA (%):
      if (item.str.startsWith('Taxa de IVA (%):')) {
        const nextItem = items[idx + 1];
        if (nextItem && /^\d+$/.test(nextItem.str)) {
          currentTaxaIva = nextItem.str;
        }
        continue;
      }

      // Ignorar cabeçalhos da farmácia (y > 730) e rodapés (y < 45)
      if (item.y > 730 || item.y < 45) continue;
      if (
        item.str.startsWith('Totais ') ||
        item.str === 'Total' ||
        item.str === 'Prat.' ||
        item.str === 'AIM' ||
        item.str === 'Código' ||
        item.str === 'Designação' ||
        item.str === 'Lote' ||
        item.str === 'Stock' ||
        item.str === 'Custo Unit.' ||
        item.str === 'Valor S/ IVA' ||
        item.str.startsWith('Localização') ||
        item.str.startsWith('Inventário') ||
        item.str === 'FARMACIA BAPTISTA'
      ) {
        currentRow = null;
        continue;
      }

      // No PDF de Inventário, cada registo de artigo começa pelo Código (7 dígitos em x ~ 80)
      if (item.x >= 74 && item.x <= 105 && /^\d{7}$/.test(item.str)) {
        currentRow = {
          prat: null,
          aim: null,
          codigo: item.str,
          designacaoParts: [],
          lote: 'LOTE ÚNICO',
          taxa_iva: currentTaxaIva,
        };
        continue;
      }

      if (!currentRow) continue;

      if (item.x >= 106 && item.x < 365) {
        currentRow.designacaoParts!.push(item.str);
      } else if (item.x < 50) {
        currentRow.prat = currentRow.prat ? `${currentRow.prat} ${item.str}` : item.str;
      } else if (item.x >= 50 && item.x < 74) {
        currentRow.aim = item.str;
      } else if (item.x >= 365 && item.x < 425) {
        currentRow.lote = item.str;
      } else if (item.x >= 425 && item.x < 460 && /^-?\d+$/.test(item.str.replace(/\s+/g, ''))) {
        currentRow.stock = item.str.replace(/\s+/g, '');
      } else if (item.x >= 460 && item.x < 515 && item.str.includes('€')) {
        currentRow.custo_unit = item.str;
      } else if (item.x >= 515 && item.str.includes('€')) {
        currentRow.valor_s_iva = item.str;
        // Fim do registo em curso
        if (currentRow.codigo && currentRow.stock !== undefined && currentRow.custo_unit) {
          rows.push({
            prat: currentRow.prat ?? null,
            aim: currentRow.aim ?? null,
            codigo: currentRow.codigo,
            designacao: (currentRow.designacaoParts || []).join(' ').replace(/\s+/g, ' ').trim(),
            lote: currentRow.lote || 'LOTE ÚNICO',
            stock: currentRow.stock,
            custo_unit: currentRow.custo_unit,
            valor_s_iva: currentRow.valor_s_iva,
            taxa_iva: currentRow.taxa_iva || currentTaxaIva,
          });
        }
        currentRow = null;
      }
    }
  }

  return {
    farmaciaNome,
    farmaciaNif,
    dataImpressao,
    rows,
  };
}

/**
 * Extrai de forma estruturada (posicional por coordenadas X/Y) todas as linhas do PDF de Validades.
 */
export async function parseValidadesPdfFile(filePath: string): Promise<ParsedValidadesPdf> {
  const dataBuffer = fs.readFileSync(filePath);
  const pagesItems: PdfTextItem[][] = [];

  await pdf(dataBuffer, {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent();
      const items: PdfTextItem[] = tc.items
        .map((i: any) => ({
          str: String(i.str ?? '').trim(),
          x: Math.round(i.transform[4]),
          y: Math.round(i.transform[5]),
        }))
        .filter((i: PdfTextItem) => i.str.length > 0);
      pagesItems.push(items);
      return '';
    },
  });

  let farmaciaNome: string | null = null;
  let farmaciaNif: string | null = null;
  let dataImpressao: Date | null = null;
  const rows: ParsedValidadeRow[] = [];

  for (const items of pagesItems) {
    let currentRow: Partial<ParsedValidadeRow> & { designacaoParts?: string[] } = {
      designacaoParts: [],
    };

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];

      if (!farmaciaNif && item.str === 'NIF:' && items[idx + 1]) {
        farmaciaNif = items[idx + 1].str.trim();
      }
      if (!farmaciaNome && item.str === 'FARMACIA BAPTISTA') {
        farmaciaNome = item.str;
      }
      if (!dataImpressao && item.str.includes('19-10-2026')) {
        const dt = parsePrintDate(item.str);
        if (dt) dataImpressao = dt;
      }

      // Ignorar cabeçalhos e rodapés da página
      if (item.y > 730 || item.y < 45) continue;
      if (
        item.str === 'Ord.' ||
        item.str === 'Código' ||
        item.str === 'Designação' ||
        item.str === 'Lote' ||
        item.str === 'Stock' ||
        item.str === 'Pratel.' ||
        item.str === 'Validade' ||
        item.str === 'Correcção' ||
        item.str.startsWith('Lista de Controlo') ||
        item.str.startsWith('Expiram entre')
      ) {
        continue;
      }

      // No PDF de Validades, a ordem de emissão dos objetos por linha é:
      // Designação (x ~ 102) -> Stock (x ~ 410) -> Lote (x ~ 347) -> Pratel (x ~ 441) -> Validade (x ~ 479) -> Código (x ~ 61) -> Correcção (x ~ 519) -> Ord. (x < 58)
      if (item.x >= 95 && item.x < 340) {
        if (!currentRow.designacaoParts) currentRow.designacaoParts = [];
        currentRow.designacaoParts.push(item.str);
      } else if (item.x >= 340 && item.x < 400) {
        currentRow.lote = item.str;
      } else if (item.x >= 400 && item.x < 438) {
        currentRow.stock = item.str.replace(/\s+/g, '');
      } else if (item.x >= 438 && item.x < 470) {
        currentRow.pratel = item.str;
      } else if (item.x >= 470 && item.x < 512 && /^\d{2}-\d{4}$/.test(item.str)) {
        currentRow.validade = item.str;
      } else if (item.x >= 58 && item.x < 95 && /^\d{7}$/.test(item.str)) {
        currentRow.codigo = item.str;
      } else if (item.x >= 512) {
        currentRow.correccao = item.str;
      } else if (item.x < 58 && /^\d+$/.test(item.str)) {
        currentRow.ord = item.str;
        if (currentRow.codigo && currentRow.validade) {
          rows.push({
            ord: currentRow.ord,
            codigo: currentRow.codigo,
            designacao: (currentRow.designacaoParts || []).join(' ').replace(/\s+/g, ' ').trim(),
            lote: currentRow.lote || 'LOTE ÚNICO',
            stock: currentRow.stock ?? '0',
            pratel: currentRow.pratel ?? null,
            validade: currentRow.validade,
            correccao: currentRow.correccao ?? null,
          });
        }
        currentRow = { designacaoParts: [] };
      }
    }
  }

  return {
    farmaciaNome,
    farmaciaNif,
    dataImpressao,
    rows,
  };
}

const PT_MONTH_MAP: Record<string, number> = {
  JAN: 1,
  FEV: 2,
  MAR: 3,
  ABR: 4,
  MAI: 5,
  JUN: 6,
  JUL: 7,
  AGO: 8,
  SET: 9,
  OUT: 10,
  NOV: 11,
  DEZ: 12,
};

/**
 * Lê o CSV de vendas do Sifarma (Windows-1252, separado por ';') e desdobra a matriz mensal em registos de StagingVendas.
 */
export async function parseVendasCsvFile(
  filePath: string,
  anoInicial = 2025
): Promise<{
  totalArtigosCatalogo: number;
  stagingRows: ParsedVendaStagingRow[];
}> {
  return new Promise((resolve, reject) => {
    const stagingRows: ParsedVendaStagingRow[] = [];
    let totalArtigosCatalogo = 0;
    let monthColumns: Array<{ headerKey: string; isoDate: string }> = [];

    const stream = fs
      .createReadStream(filePath)
      .pipe(iconv.decodeStream('win1252'))
      .pipe(
        csv({
          separator: ';',
          quote: '\0',
          mapHeaders: ({ header, index }) => `${index}_${header.trim().toUpperCase()}`,
        })
      );

    stream.on('headers', (headers: string[]) => {
      // Identifica dinamicamente as colunas mensais (OUT, NOV, DEZ, JAN, FEV, ..., OUT)
      let currentYear = anoInicial;
      let prevMonthNum: number | null = null;

      for (const h of headers) {
        const cleanName = h.replace(/^\d+_/, '').trim();
        const mNum = PT_MONTH_MAP[cleanName];
        if (mNum !== undefined) {
          if (prevMonthNum !== null && mNum < prevMonthNum) {
            currentYear++;
          }
          prevMonthNum = mNum;
          const isoDate = `${currentYear}-${String(mNum).padStart(2, '0')}-01T00:00:00.000Z`;
          monthColumns.push({ headerKey: h, isoDate });
        }
      }
    });

    stream.on('data', (row: Record<string, string>) => {
      const keys = Object.keys(row);
      const codigoRaw = row[keys[0]]?.trim();
      const descricaoRaw = row[keys[1]]?.trim();
      const pvpRaw = row[keys[5]]?.trim() || null;
      const custoRaw = row[keys[7]]?.trim() || null;
      const margemRaw = row[keys[8]]?.trim() || null;

      if (!codigoRaw || !/^\d{6,7}$/.test(codigoRaw)) {
        return;
      }

      totalArtigosCatalogo++;

      // Calcula preço unitário numérico para estimar o valor_venda mensal = qtd * PVP
      const pvpNum = pvpRaw ? parseFloat(pvpRaw.replace('.', '').replace(',', '.')) : 0;

      let teveVendas = false;
      for (const mc of monthColumns) {
        const qtdStr = (row[mc.headerKey] ?? '0').trim();
        const qtdNum = parseInt(qtdStr, 10);

        // Inclui também meses NEGATIVOS (devoluções/regularizações) para que o total líquido
        // por mês seja exatamente igual ao ficheiro original do Sifarma.
        if (!Number.isNaN(qtdNum) && qtdNum !== 0) {
          teveVendas = true;
          const valorMes = (qtdNum * (Number.isNaN(pvpNum) ? 0 : pvpNum)).toFixed(2).replace('.', ',');
          stagingRows.push({
            codigo_produto: codigoRaw,
            descricao: descricaoRaw || 'Sem Designação',
            quantidade: qtdStr,
            valor_venda: valorMes,
            custo_unitario: custoRaw,
            pvp: pvpRaw,
            margem: margemRaw,
            data_movimento: mc.isoDate,
          });
        }
      }

      // Artigo sem qualquer movimento nos 13 meses: guardar 1 linha com quantidade 0
      // apenas para registar o artigo no catálogo ProdutoMestre e o PVP/Margem desta farmácia (não gera venda).
      if (!teveVendas && monthColumns.length > 0) {
        stagingRows.push({
          codigo_produto: codigoRaw,
          descricao: descricaoRaw || 'Sem Designação',
          quantidade: '0',
          valor_venda: '0,00',
          custo_unitario: custoRaw,
          pvp: pvpRaw,
          margem: margemRaw,
          data_movimento: monthColumns[monthColumns.length - 1].isoDate,
        });
      }

      // Mesmo que o produto não tenha vendido nenhuma unidade nos 13 meses, se tiver PVP/Margem podemos opcionalmente
      // guardar 1 registo com quantidade 0 apenas se não houver vendas, ou focamo-nos nas vendas efetivas (> 0)
      if (!teveVendas && monthColumns.length === 0) {
        // Fallback para CSV transacional simples (colunas diretas)
        stagingRows.push({
          codigo_produto: codigoRaw,
          descricao: descricaoRaw || 'Sem Designação',
          quantidade: row[keys[2]] || '0',
          valor_venda: row[keys[3]] || '0',
          custo_unitario: null,
          pvp: null,
          margem: null,
          data_movimento: row[keys[4]] || new Date().toISOString(),
        });
      }
    });

    stream.on('end', () => {
      resolve({ totalArtigosCatalogo, stagingRows });
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Ingestão do PDF de Inventário para a tabela StagingInventario.
 */
export async function ingestInventarioPdf(
  prisma: PrismaClient,
  farmaciaId: string,
  filePath: string,
  batchId = crypto.randomUUID()
): Promise<{ batchId: string; totalExtraidos: number; dataExtracao: Date }> {
  const parsed = await parseInventarioPdfFile(filePath);
  const dataExtracao = parsed.dataImpressao ?? new Date();

  const CHUNK_SIZE = 500;
  for (let i = 0; i < parsed.rows.length; i += CHUNK_SIZE) {
    const chunk = parsed.rows.slice(i, i + CHUNK_SIZE);
    await prisma.stagingInventario.createMany({
      data: chunk.map((r) => ({
        batch_id: batchId,
        farmaciaId,
        prat: r.prat,
        aim: r.aim,
        codigo: r.codigo,
        designacao: r.designacao,
        lote: r.lote,
        stock: r.stock,
        custo_unit: r.custo_unit,
        valor_s_iva: r.valor_s_iva,
        taxa_iva: r.taxa_iva,
        data_extracao: dataExtracao,
        processado: false,
      })),
    });
  }

  return {
    batchId,
    totalExtraidos: parsed.rows.length,
    dataExtracao,
  };
}

/**
 * Ingestão do PDF de Validades para a tabela StagingValidades.
 */
export async function ingestValidadesPdf(
  prisma: PrismaClient,
  farmaciaId: string,
  filePath: string,
  batchId = crypto.randomUUID()
): Promise<{ batchId: string; totalExtraidos: number; dataExtracao: Date }> {
  const parsed = await parseValidadesPdfFile(filePath);
  const dataExtracao = parsed.dataImpressao ?? new Date();

  const CHUNK_SIZE = 500;
  for (let i = 0; i < parsed.rows.length; i += CHUNK_SIZE) {
    const chunk = parsed.rows.slice(i, i + CHUNK_SIZE);
    await prisma.stagingValidades.createMany({
      data: chunk.map((r) => ({
        batch_id: batchId,
        farmaciaId,
        ord: r.ord,
        codigo: r.codigo,
        designacao: r.designacao,
        lote: r.lote,
        stock: r.stock,
        pratel: r.pratel,
        validade: r.validade,
        correccao: r.correccao,
        data_extracao: dataExtracao,
        processado: false,
      })),
    });
  }

  return {
    batchId,
    totalExtraidos: parsed.rows.length,
    dataExtracao,
  };
}

/**
 * Ingestão do CSV de Vendas para a tabela StagingVendas.
 */
export async function ingestVendasCsv(
  prisma: PrismaClient,
  farmaciaId: string,
  filePath: string,
  batchId = crypto.randomUUID(),
  anoInicial = 2025
): Promise<{ batchId: string; totalArtigosCatalogo: number; totalRegistosMensais: number }> {
  const { totalArtigosCatalogo, stagingRows } = await parseVendasCsvFile(filePath, anoInicial);

  const CHUNK_SIZE = 1000;
  for (let i = 0; i < stagingRows.length; i += CHUNK_SIZE) {
    const chunk = stagingRows.slice(i, i + CHUNK_SIZE);
    await prisma.stagingVendas.createMany({
      data: chunk.map((r) => ({
        batch_id: batchId,
        farmaciaId,
        codigo_produto: r.codigo_produto,
        descricao: r.descricao,
        quantidade: r.quantidade,
        valor_venda: r.valor_venda,
        custo_unitario: r.custo_unitario,
        pvp: r.pvp,
        margem: r.margem,
        data_movimento: r.data_movimento,
        processado: false,
      })),
    });
  }

  return {
    batchId,
    totalArtigosCatalogo,
    totalRegistosMensais: stagingRows.length,
  };
}

export interface ParsedWinpharVendasItem {
  codigo: string;
  designacao: string;
  pvp: string;
  pvpSemIva?: string;
  pc: string;
  stock: string;
  totalVendido: number;
  vendasMensais: Record<string, number>;
}

export interface ParsedWinpharVendasPdf {
  farmaciaNome: string | null;
  farmaciaNif: string | null;
  periodo: string | null;
  anoVendas: number;
  isDaily: boolean;
  dataInicio: string | null; // ISO YYYY-MM-DD
  dataFim: string | null;    // ISO YYYY-MM-DD
  granularidade: 'MENSAL' | 'DIARIO';
  rows: ParsedWinpharVendasItem[];
}

export interface ParsedWinpharValidadesItem {
  codigo: string;
  designacao: string;
  stock: string;
  validade: string;
}

export interface ParsedWinpharValidadesPdf {
  farmaciaNome: string | null;
  farmaciaNif: string | null;
  rows: ParsedWinpharValidadesItem[];
}

const PT_MONTHS_MAP_GLOBAL: Record<string, number> = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  'março': 3, marco: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
};

export function parseWinpharPeriodString(periodoStr: string | null | undefined): {
  isDaily: boolean;
  granularidade: 'MENSAL' | 'DIARIO';
  dataInicio: string | null;
  dataFim: string | null;
  anoVendas: number;
} {
  if (!periodoStr) {
    return {
      isDaily: false,
      granularidade: 'MENSAL',
      dataInicio: null,
      dataFim: null,
      anoVendas: 2026,
    };
  }

  const periodRegex = /de\s+(\d{1,2})\s+de\s+([a-zA-Zçã]+)\s+de\s+(\d{4})\s+a\s+(\d{1,2})\s+de\s+([a-zA-Zçã]+)\s+de\s+(\d{4})/i;
  const m = periodoStr.match(periodRegex);
  if (!m) {
    const matchYear = periodoStr.match(/(\d{4})/);
    const yr = matchYear ? parseInt(matchYear[1], 10) : 2026;
    return {
      isDaily: false,
      granularidade: 'MENSAL',
      dataInicio: `${yr}-01-01T00:00:00.000Z`,
      dataFim: `${yr}-12-31T23:59:59.000Z`,
      anoVendas: yr,
    };
  }

  const [, d1, m1, y1, d2, m2, y2] = m;
  const month1 = PT_MONTHS_MAP_GLOBAL[m1.toLowerCase().trim()] || 1;
  const month2 = PT_MONTHS_MAP_GLOBAL[m2.toLowerCase().trim()] || 12;
  const year1 = parseInt(y1, 10);
  const year2 = parseInt(y2, 10);
  const day1 = parseInt(d1, 10);
  const day2 = parseInt(d2, 10);

  const isDaily = day1 === day2 && month1 === month2 && year1 === year2;
  const startIso = `${year1}-${String(month1).padStart(2, '0')}-${String(day1).padStart(2, '0')}T00:00:00.000Z`;
  const endIso = `${year2}-${String(month2).padStart(2, '0')}-${String(day2).padStart(2, '0')}T23:59:59.000Z`;

  return {
    isDaily,
    granularidade: isDaily ? 'DIARIO' : 'MENSAL',
    dataInicio: startIso,
    dataFim: endIso,
    anoVendas: year2,
  };
}

export async function parseWinpharVendasPdfFile(filePathOrBuffer: string | Buffer): Promise<ParsedWinpharVendasPdf> {
  const dataBuffer = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : fs.readFileSync(filePathOrBuffer);
  let farmaciaNome: any = null;
  let farmaciaNif: any = null;
  let periodo: string | null = null;
  let anoVendas = 2026;
  const rows: ParsedWinpharVendasItem[] = [];

  const PT_MONTHS: Record<string, number> = {
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  };

  interface MonthColBound {
    isoKey: string;
    minX: number;
    maxX: number;
    label: string;
  }

  let dynamicConfig: {
    hasPvpSemIva: boolean;
    pvpMin: number;
    pvpMax: number;
    pvpSemIvaMin: number;
    pvpSemIvaMax: number;
    pcMin: number;
    pcMax: number;
    totalMin: number;
    totalMax: number;
    existMin: number;
    existMax: number;
    months: MonthColBound[];
  } | null = null;

  await pdf(dataBuffer, {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent();
      const items: PdfTextItem[] = tc.items
        .map((i: any) => ({
          str: String(i.str ?? '').trim(),
          x: Math.round(i.transform[4]),
          y: Math.round(i.transform[5]),
        }))
        .filter((i: PdfTextItem) => i.str.length > 0);

      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        if (!farmaciaNome && it.str.startsWith('Farmácia:')) {
          farmaciaNome = it.str.replace('Farmácia:', '').trim() || (items[idx + 1]?.str ?? null);
        }
        if (!farmaciaNif && it.str === 'Contribuinte:' && items[idx + 1]) {
          farmaciaNif = items[idx + 1].str.trim();
        } else if (!farmaciaNif && /^\d{9}$/.test(it.str) && it.x > 700) {
          farmaciaNif = it.str;
        }
        if (!periodo && it.str.includes('Período:')) {
          periodo = it.str;
          const matchYear = it.str.match(/(\d{4})/);
          if (matchYear) anoVendas = parseInt(matchYear[1], 10);
        }
      }

      if (!dynamicConfig) {
        const headerItems = items.filter((i) => i.y >= 448 && i.y <= 465).sort((a, b) => a.x - b.x);
        const hasPvpSemIva = headerItems.some(
          (i) => i.str.toUpperCase().includes('PVP') && i.str.toUpperCase().includes('IVA')
        );

        const totalHeader = headerItems.find((i) => i.str.toLowerCase() === 'total');
        const totalX = totalHeader ? totalHeader.x : 710;

        let curYear = anoVendas;
        let prevM: number | null = null;
        const detectedMonths: Array<{ isoKey: string; x: number; label: string }> = [];

        const periodInfo = parseWinpharPeriodString(periodo);

        if (periodInfo.isDaily && periodInfo.dataInicio) {
          // Relatório de Venda Diária (apenas 1 dia): a coluna é o mês mas a data exata é o dia
          for (const it of headerItems) {
            const mNum = PT_MONTHS[it.str.toLowerCase()];
            if (mNum) {
              detectedMonths.push({
                isoKey: periodInfo.dataInicio,
                x: it.x,
                label: `Dia ${periodInfo.dataInicio.slice(0, 10)}`,
              });
              break;
            }
          }
          if (detectedMonths.length === 0) {
            detectedMonths.push({
              isoKey: periodInfo.dataInicio,
              x: 326,
              label: `Dia ${periodInfo.dataInicio.slice(0, 10)}`,
            });
          }
        } else {
          for (const it of headerItems) {
            const mNum = PT_MONTHS[it.str.toLowerCase()];
            if (mNum) {
              if (prevM !== null && mNum < prevM) {
                curYear++;
              }
              prevM = mNum;
              const mmStr = String(mNum).padStart(2, '0');
              detectedMonths.push({
                isoKey: `${curYear}-${mmStr}-01T00:00:00.000Z`,
                x: it.x,
                label: `${it.str}/${curYear}`,
              });
            }
          }
        }

        const months: MonthColBound[] = [];
        for (let i = 0; i < detectedMonths.length; i++) {
          const cur = detectedMonths[i];
          const prevBound = i > 0 ? months[i - 1].maxX : cur.x - 7;
          const nextHeaderX = i < detectedMonths.length - 1 ? detectedMonths[i + 1].x : totalX;
          const maxX = i < detectedMonths.length - 1 ? nextHeaderX - 4 : totalX - 12;

          months.push({
            isoKey: cur.isoKey,
            minX: prevBound,
            maxX,
            label: cur.label,
          });
        }

        if (hasPvpSemIva) {
          dynamicConfig = {
            hasPvpSemIva: true,
            pvpMin: 210,
            pvpMax: 245,
            pvpSemIvaMin: 245,
            pvpSemIvaMax: 280,
            pcMin: 280,
            pcMax: 320,
            totalMin: 698,
            totalMax: 765,
            existMin: 765,
            existMax: 820,
            months,
          };
        } else {
          dynamicConfig = {
            hasPvpSemIva: false,
            pvpMin: 245,
            pvpMax: 280,
            pvpSemIvaMin: 0,
            pvpSemIvaMax: 0,
            pcMin: 280,
            pcMax: 325,
            totalMin: 698,
            totalMax: 765,
            existMin: 765,
            existMax: 820,
            months,
          };
        }
      }

      const rowsByY = new Map<number, PdfTextItem[]>();
      for (const it of items) {
        let matchedY: number | null = null;
        for (const y of rowsByY.keys()) {
          if (Math.abs(y - it.y) <= 3) {
            matchedY = y;
            break;
          }
        }
        if (matchedY === null) {
          matchedY = it.y;
          rowsByY.set(matchedY, []);
        }
        rowsByY.get(matchedY)!.push(it);
      }

      for (const rowItems of rowsByY.values()) {
        const codeItem = rowItems.find((it) => it.x < 70 && /^\d{6,7}$/.test(it.str));
        if (!codeItem) continue;

        const pvpItem = rowItems.find((it) => it.x >= dynamicConfig!.pvpMin && it.x < dynamicConfig!.pvpMax);
        const pvpSemIvaItem = dynamicConfig!.hasPvpSemIva
          ? rowItems.find((it) => it.x >= dynamicConfig!.pvpSemIvaMin && it.x < dynamicConfig!.pvpSemIvaMax)
          : undefined;
        const pcItem = rowItems.find((it) => it.x >= dynamicConfig!.pcMin && it.x < dynamicConfig!.pcMax);
        const totalItem = rowItems.find((it) => it.x >= dynamicConfig!.totalMin && it.x < dynamicConfig!.totalMax);
        const existItem = rowItems.find((it) => it.x >= dynamicConfig!.existMin && it.x <= dynamicConfig!.existMax);
        const desc = rowItems
          .filter((it) => it.x >= 70 && it.x < dynamicConfig!.pvpMin)
          .map((it) => it.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (!pvpItem || !pcItem || !existItem) continue;

        const vendasMensais: Record<string, number> = {};
        for (const m of dynamicConfig!.months) {
          const mItem = rowItems.find((it) => it.x >= m.minX && it.x < m.maxX);
          if (mItem) {
            const q = parseInt(mItem.str, 10);
            if (!Number.isNaN(q) && q > 0) {
              vendasMensais[m.isoKey] = q;
            }
          }
        }

        const totalVendido = totalItem ? parseInt(totalItem.str, 10) || 0 : 0;
        const periodInfo = parseWinpharPeriodString(periodo);

        if (periodInfo.isDaily && periodInfo.dataInicio && Object.keys(vendasMensais).length === 0 && totalVendido > 0) {
          vendasMensais[periodInfo.dataInicio] = totalVendido;
        }

        rows.push({
          codigo: codeItem.str.padStart(7, '0'),
          designacao: desc || 'Sem Designação',
          pvp: pvpItem.str,
          pvpSemIva: pvpSemIvaItem ? pvpSemIvaItem.str : undefined,
          pc: pcItem.str,
          stock: existItem.str,
          totalVendido,
          vendasMensais,
        });
      }

      return '';
    },
  });

  const periodParsed = parseWinpharPeriodString(periodo);

  const cleanNome = typeof farmaciaNome === 'string' ? `Farmácia ${farmaciaNome.replace(/^Farmácia\s*/i, '')}` : 'Farmácia Demonstrativa';
  return {
    farmaciaNome: cleanNome,
    farmaciaNif: (farmaciaNif as string) || '999999990',
    periodo,
    anoVendas: periodParsed.anoVendas || anoVendas,
    isDaily: periodParsed.isDaily,
    dataInicio: periodParsed.dataInicio,
    dataFim: periodParsed.dataFim,
    granularidade: periodParsed.granularidade,
    rows,
  };
}

/**
 * Parser universal de ficheiros CSV de vendas (Sifarma / Winphar / formatos matriciais mensais),
 * suportando:
 *  - Codificação UTF-8 ou Windows-1252 / Latin-1 automática;
 *  - Separador `;`, `,` ou `\t`;
 *  - CSV limpo (ex.: `vendas baptista25-26.csv`) e CSV com espaços da designação partidos em `;` (ex.: `vendas_Out_ate_11Nov_2026.csv`);
 *  - Qualquer matriz de 1 a 18 meses (ex.: `OUT;NOV` ou `OUT;NOV;DEZ;JAN;...;OUT`), inferindo o ano de cada coluna a partir do nome do ficheiro.
 */
export function parseWinpharVendasCsvFile(filePathOrBuffer: string | Buffer, fileName = 'vendas.csv'): ParsedWinpharVendasPdf {
  const dataBuffer = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : fs.readFileSync(filePathOrBuffer);

  // 1. Deteção de codificação UTF-8 vs Latin-1 (Windows-1252)
  let rawText = dataBuffer.toString('utf8');
  if (rawText.includes('\uFFFD')) {
    rawText = dataBuffer.toString('latin1');
  }
  rawText = rawText.replace(/^\uFEFF/, '');

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error(`O ficheiro CSV "${fileName}" não contém linhas de dados suficientes.`);
  }

  // 2. Deteção automática de delimitador
  const headerLine = lines[0];
  const semiCount = (headerLine.match(/;/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const delim = semiCount >= commaCount && semiCount >= tabCount ? ';' : commaCount >= tabCount ? ',' : '\t';

  const headerTokens = headerLine
    .split(delim)
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const normHeader = (s: string) =>
    s
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9%]/g, '');

  const MONTH_TOK_MAP: Record<string, number> = {
    JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
    JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
    JANEIRO: 1, FEVEREIRO: 2, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6,
    JULHO: 7, AGOSTO: 8, SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12,
  };

  // Identificar as colunas de meses no cabeçalho (depois de PVP/CUSTO/MG ou após coluna 2)
  const monthCols: Array<{ label: string; monthNum: number; headerIdx: number }> = [];
  for (let i = 2; i < headerTokens.length; i++) {
    const nt = normHeader(headerTokens[i]);
    if (MONTH_TOK_MAP[nt]) {
      monthCols.push({ label: nt.slice(0, 3), monthNum: MONTH_TOK_MAP[nt], headerIdx: i });
    }
  }

  if (monthCols.length === 0) {
    throw new Error(
      `Não foram detetadas colunas mensais (JAN..DEZ) no cabeçalho do CSV "${fileName}". Cabeçalho lido: ${headerTokens.slice(0, 12).join(' | ')}`
    );
  }

  // Verificar se existe coluna de total de unidades (T / T Uni / TOTAL) após o último mês
  const lastMonthHeaderIdx = monthCols[monthCols.length - 1].headerIdx;
  const trailingHeaders = headerTokens.slice(lastMonthHeaderIdx + 1).map(normHeader);
  const hasTotalCol = trailingHeaders.some((t) => t === 'T' || t === 'UNI' || t === 'TUNI' || t === 'TOTAL' || t === 'TOT');

  // Inferir ano final a partir do nome do ficheiro (ex.: "2026", "25-26", "ate_11Nov_2026")
  let endYear = new Date().getUTCFullYear();
  const fullYearMatches = fileName.match(/(20\d{2})/g);
  if (fullYearMatches && fullYearMatches.length > 0) {
    endYear = parseInt(fullYearMatches[fullYearMatches.length - 1], 10);
  } else {
    const shortRange = fileName.match(/(\d{2})[-_](\d{2})/);
    if (shortRange) {
      endYear = 2000 + parseInt(shortRange[2], 10);
    }
  }

  // Atribuir (ano, mês) a cada coluna mensal andando de trás para a frente
  const resolvedMonths: Array<{ year: number; month: number; isoDate: string }> = new Array(monthCols.length);
  let curYear = endYear;
  let nextMonthNum = 99;
  for (let i = monthCols.length - 1; i >= 0; i--) {
    const mNum = monthCols[i].monthNum;
    if (i < monthCols.length - 1 && mNum >= nextMonthNum) {
      curYear -= 1;
    }
    resolvedMonths[i] = {
      year: curYear,
      month: mNum,
      isoDate: `${curYear}-${String(mNum).padStart(2, '0')}-01T00:00:00.000Z`,
    };
    nextMonthNum = mNum;
  }

  // Verificar se o nome do ficheiro indica um dia de corte explícito (ex.: "ate_11Nov_2026")
  const firstM = resolvedMonths[0];
  const lastM = resolvedMonths[resolvedMonths.length - 1];
  const dataInicio = `${firstM.year}-${String(firstM.month).padStart(2, '0')}-01T00:00:00.000Z`;
  let endDay = new Date(Date.UTC(lastM.year, lastM.month, 0)).getUTCDate();
  const cutDayMatch = fileName.match(/ate[_ -]?(\d{1,2})[_ -]?([a-zA-Zçã]{3,})/i);
  if (cutDayMatch) {
    const d = parseInt(cutDayMatch[1], 10);
    if (d >= 1 && d <= 31) endDay = d;
  }
  const dataFim = `${lastM.year}-${String(lastM.month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T23:59:59.000Z`;
  const periodo = `${firstM.year}-${String(firstM.month).padStart(2, '0')} a ${lastM.year}-${String(lastM.month).padStart(2, '0')}${cutDayMatch ? ` (até ${String(endDay).padStart(2, '0')}/${String(lastM.month).padStart(2, '0')}/${lastM.year})` : ''}`;

  // Cauda fixa à direita em cada linha (funciona tanto para CSV limpo como para CSV com designação partida em ';'):
  // [STOCK_TOT, LOCALIZACAO, STOCK, PVP, VALOR_VENDAS, P.CUSTO, MG_%, ...M meses, (T_UNI opcional)]
  const tailLen = 7 + resolvedMonths.length + (hasTotalCol ? 1 : 0);

  const rows: ParsedWinpharVendasItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim).map((c) => c.trim());
    while (cells.length > 0 && cells[cells.length - 1] === '') {
      cells.pop();
    }
    if (cells.length < tailLen + 2) continue;

    const rawCode = cells[0].replace(/\D/g, '');
    if (!/^\d{6,7}$/.test(rawCode)) continue;
    const codigo = rawCode.padStart(7, '0');

    const fixedStart = cells.length - tailLen;
    const designacao = cells
      .slice(1, fixedStart)
      .filter((s) => s.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const stock = cells[fixedStart] || '0';
    const pvp = cells[fixedStart + 3] || '0,00';
    const pc = cells[fixedStart + 5] || '0,00';

    const vendasMensais: Record<string, number> = {};
    let totalVendido = 0;
    const monthsStart = fixedStart + 7;
    for (let mIdx = 0; mIdx < resolvedMonths.length; mIdx++) {
      const rawQty = (cells[monthsStart + mIdx] || '0').replace(/\./g, '').replace(',', '.');
      const qty = Math.round(parseFloat(rawQty));
      const safeQty = Number.isFinite(qty) ? qty : 0;
      const iso = resolvedMonths[mIdx].isoDate;
      // Se o mesmo mês surgir repetido (raro), acumula sem perder; caso normal: atribuição direta
      vendasMensais[iso] = (vendasMensais[iso] || 0) + safeQty;
      totalVendido += safeQty;
    }

    rows.push({
      codigo,
      designacao: designacao || `Produto ${codigo}`,
      pvp,
      pc,
      stock,
      totalVendido,
      vendasMensais,
    });
  }

  if (rows.length === 0) {
    throw new Error(`Nenhuma linha de produto válida (CNP 7 dígitos) encontrada no CSV "${fileName}".`);
  }

  return {
    farmaciaNome: null,
    farmaciaNif: null,
    periodo,
    anoVendas: lastM.year,
    isDaily: false,
    dataInicio,
    dataFim,
    granularidade: 'MENSAL',
    rows,
  };
}

export async function parseWinpharValidadesPdfFile(filePathOrBuffer: string | Buffer): Promise<ParsedWinpharValidadesPdf> {
  const dataBuffer = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : fs.readFileSync(filePathOrBuffer);
  let farmaciaNome: any = null;
  let farmaciaNif: any = null;
  const rows: ParsedWinpharValidadesItem[] = [];

  await pdf(dataBuffer, {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent();
      const items: PdfTextItem[] = tc.items
        .map((i: any) => ({
          str: String(i.str ?? '').trim(),
          x: Math.round(i.transform[4]),
          y: Math.round(i.transform[5]),
        }))
        .filter((i: PdfTextItem) => i.str.length > 0);

      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        if (!farmaciaNome && it.str.startsWith('Farmácia:')) {
          farmaciaNome = it.str.replace('Farmácia:', '').trim() || (items[idx + 1]?.str ?? null);
        }
        if (!farmaciaNif && it.str === 'Contribuinte:' && items[idx + 1]) {
          farmaciaNif = items[idx + 1].str.trim();
        } else if (!farmaciaNif && /^\d{9}$/.test(it.str) && it.x > 500) {
          farmaciaNif = it.str;
        }
      }

      const rowsByY = new Map<number, PdfTextItem[]>();
      for (const it of items) {
        let matchedY: number | null = null;
        for (const y of rowsByY.keys()) {
          if (Math.abs(y - it.y) <= 3) {
            matchedY = y;
            break;
          }
        }
        if (matchedY === null) {
          matchedY = it.y;
          rowsByY.set(matchedY, []);
        }
        rowsByY.get(matchedY)!.push(it);
      }

      for (const rowItems of rowsByY.values()) {
        const codeItem = rowItems.find((it) => it.x >= 50 && it.x < 90 && /^\d{6,7}$/.test(it.str));
        const valItem = rowItems.find((it) => /^\d{2}-\d{4}$/.test(it.str));
        if (!codeItem || !valItem) continue;

        const existItem = rowItems.find((it) => it.x >= 415 && it.x < 445);
        const desc = rowItems
          .filter((it) => it.x >= 90 && it.x < 315)
          .map((it) => it.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        rows.push({
          codigo: codeItem.str.padStart(7, '0'),
          designacao: desc || 'Sem Designação',
          stock: existItem ? existItem.str : '0',
          validade: valItem.str,
        });
      }

      return '';
    },
  });

  const cleanNomeVal = typeof farmaciaNome === 'string' ? `Farmácia ${farmaciaNome.replace(/^Farmácia\s*/i, '')}` : 'Farmácia Demonstrativa';
  return {
    farmaciaNome: cleanNomeVal,
    farmaciaNif: (farmaciaNif as string) || '999999990',
    rows,
  };
}

export async function ingestWinpharData(
  prisma: PrismaClient,
  farmaciaId: string,
  vendasPdfPath: string,
  validadesPdfPath: string,
  batchId = crypto.randomUUID()
): Promise<{
  batchId: string;
  totalVendasPdf: number;
  totalValidadesPdf: number;
  stagingInventarioCount: number;
  stagingVendasCount: number;
  stagingValidadesCount: number;
}> {
  const [parsedVendas, parsedValidades] = await Promise.all([
    parseWinpharVendasPdfFile(vendasPdfPath),
    parseWinpharValidadesPdfFile(validadesPdfPath),
  ]);

  const dataExtracao = new Date();

  // 1. Preparar StagingInventario a partir das vendas (todos os produtos com stock ou presentes no catálogo)
  const stagingInvMap = new Map<string, {
    batch_id: string;
    farmaciaId: string;
    codigo: string;
    designacao: string;
    lote: string;
    stock: string;
    custo_unit: string;
    valor_s_iva: string;
    taxa_iva: string;
    data_extracao: Date;
    processado: boolean;
  }>();

  for (const r of parsedVendas.rows) {
    const pcNum = parseFloat(r.pc.replace('.', '').replace(',', '.'));
    const stockNum = parseInt(r.stock, 10);
    const totalCusto = !Number.isNaN(pcNum) && !Number.isNaN(stockNum) ? (pcNum * stockNum).toFixed(2).replace('.', ',') : '0,00';

    const pvpNum = parseFloat(r.pvp.replace('.', '').replace(',', '.'));
    const pvpSemIvaDirect = r.pvpSemIva ? parseFloat(r.pvpSemIva.replace('.', '').replace(',', '.')) : NaN;
    const taxaIva =
      !Number.isNaN(pvpSemIvaDirect) && !Number.isNaN(pvpNum) && pvpSemIvaDirect > 0
        ? String(Math.round(((pvpNum - pvpSemIvaDirect) / pvpSemIvaDirect) * 100))
        : /^[2345]/.test(r.codigo)
        ? '6'
        : '23';

    stagingInvMap.set(r.codigo, {
      batch_id: batchId,
      farmaciaId,
      codigo: r.codigo,
      designacao: r.designacao,
      lote: 'LOTE ÚNICO',
      stock: r.stock,
      custo_unit: r.pc,
      valor_s_iva: totalCusto,
      taxa_iva: taxaIva,
      data_extracao: dataExtracao,
      processado: false,
    });
  }

  const stagingInvList = Array.from(stagingInvMap.values());
  const CHUNK_SIZE = 500;
  for (let i = 0; i < stagingInvList.length; i += CHUNK_SIZE) {
    const chunk = stagingInvList.slice(i, i + CHUNK_SIZE);
    await prisma.stagingInventario.createMany({ data: chunk });
  }

  // 2. Preparar StagingVendas (inclui produtos com e sem vendas para enriquecer o catálogo com PVP e Margem exatos)
  const stagingVendasList: Array<{
    batch_id: string;
    farmaciaId: string;
    codigo_produto: string;
    descricao: string;
    quantidade: string;
    valor_venda: string;
    custo_unitario: string;
    pvp: string;
    margem: string;
    data_movimento: string;
    processado: boolean;
  }> = [];

  for (const r of parsedVendas.rows) {
    const pvpNum = parseFloat(r.pvp.replace('.', '').replace(',', '.'));
    const pcNum = parseFloat(r.pc.replace('.', '').replace(',', '.'));
    const pvpSemIvaDirect = r.pvpSemIva ? parseFloat(r.pvpSemIva.replace('.', '').replace(',', '.')) : NaN;

    const ivaRate = /^[2345]/.test(r.codigo) ? 0.06 : 0.23;
    const pvpSemIva =
      !Number.isNaN(pvpSemIvaDirect) && pvpSemIvaDirect > 0
        ? pvpSemIvaDirect
        : !Number.isNaN(pvpNum)
        ? pvpNum / (1 + ivaRate)
        : 0;

    let rawMargin =
      pvpSemIva > 0 && !Number.isNaN(pcNum) ? ((pvpSemIva - pcNum) / pvpSemIva) * 100 : 0;
    if (rawMargin < -999.99) rawMargin = -999.99;
    if (rawMargin > 999.99) rawMargin = 999.99;
    const margemPct = rawMargin.toFixed(2).replace('.', ',');

    const monthsEntries = Object.entries(r.vendasMensais);
    if (monthsEntries.length > 0) {
      for (const [isoDate, qtd] of monthsEntries) {
        const valorVenda = (qtd * (!Number.isNaN(pvpNum) ? pvpNum : 0)).toFixed(2).replace('.', ',');
        stagingVendasList.push({
          batch_id: batchId,
          farmaciaId,
          codigo_produto: r.codigo,
          descricao: r.designacao,
          quantidade: String(qtd),
          valor_venda: valorVenda,
          custo_unitario: r.pc,
          pvp: r.pvp,
          margem: margemPct,
          data_movimento: isoDate,
          processado: false,
        });
      }
    } else {
      // Artigo presente no ficheiro mas sem vendas no período: incluir linha com qtd 0 para atualizar o PVP e Margem no catálogo
      stagingVendasList.push({
        batch_id: batchId,
        farmaciaId,
        codigo_produto: r.codigo,
        descricao: r.designacao,
        quantidade: '0',
        valor_venda: '0,00',
        custo_unitario: r.pc,
        pvp: r.pvp,
        margem: margemPct,
        data_movimento: dataExtracao.toISOString(),
        processado: false,
      });
    }
  }

  for (let i = 0; i < stagingVendasList.length; i += 1000) {
    const chunk = stagingVendasList.slice(i, i + 1000);
    await prisma.stagingVendas.createMany({ data: chunk });
  }

  // 3. Preparar StagingValidades
  const stagingValidadesList = parsedValidades.rows.map((v) => ({
    batch_id: batchId,
    farmaciaId,
    ord: null,
    codigo: v.codigo,
    designacao: v.designacao,
    lote: 'LOTE ÚNICO',
    stock: v.stock,
    pratel: null,
    validade: v.validade,
    correccao: null,
    data_extracao: dataExtracao,
    processado: false,
  }));

  for (let i = 0; i < stagingValidadesList.length; i += CHUNK_SIZE) {
    const chunk = stagingValidadesList.slice(i, i + CHUNK_SIZE);
    await prisma.stagingValidades.createMany({ data: chunk });
  }

  return {
    batchId,
    totalVendasPdf: parsedVendas.rows.length,
    totalValidadesPdf: parsedValidades.rows.length,
    stagingInventarioCount: stagingInvList.length,
    stagingVendasCount: stagingVendasList.length,
    stagingValidadesCount: stagingValidadesList.length,
  };
}
