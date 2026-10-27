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

        if (!Number.isNaN(qtdNum) && qtdNum > 0) {
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

export async function parseWinpharVendasPdfFile(filePath: string): Promise<ParsedWinpharVendasPdf> {
  const dataBuffer = fs.readFileSync(filePath);
  let farmaciaNome: string | null = null;
  let farmaciaNif: string | null = null;
  let periodo: string | null = null;
  let anoVendas = 2025;
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

  return {
    farmaciaNome: farmaciaNome ? `Farmácia ${farmaciaNome.replace(/^Farmácia\s*/i, '')}` : 'Farmácia Avenida',
    farmaciaNif: farmaciaNif || '518149412',
    periodo,
    anoVendas,
    rows,
  };
}

export async function parseWinpharValidadesPdfFile(filePath: string): Promise<ParsedWinpharValidadesPdf> {
  const dataBuffer = fs.readFileSync(filePath);
  let farmaciaNome: string | null = null;
  let farmaciaNif: string | null = null;
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

  return {
    farmaciaNome: farmaciaNome ? `Farmácia ${farmaciaNome.replace(/^Farmácia\s*/i, '')}` : 'Farmácia Avenida',
    farmaciaNif: farmaciaNif || '518149412',
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
