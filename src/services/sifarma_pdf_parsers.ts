import pdfParse from 'pdf-parse';

export type SifarmaPdfKind = 'SIFARMA_INVENTARIO_NORMAL' | 'SIFARMA_SEM_CONSUMO';

export interface SifarmaInventarioRow {
  prateleira: string | null;
  aim: string | null;
  codigo: string; // CNP 7 dígitos
  designacao: string;
  lote: string;
  stock: number;
  pvp: number;
  custoUnitario: number;
  stockMin: number | null;
  stockMax: number | null;
}

export interface ParsedSifarmaInventarioPdf {
  kind: 'SIFARMA_INVENTARIO_NORMAL';
  farmaciaNome: string | null;
  farmaciaNif: string | null;
  dataImpressao: string | null; // YYYY-MM-DD
  totalArtigosPdf: number | null;
  totalUnidadesPdf: number | null;
  rows: SifarmaInventarioRow[];
}

export interface SifarmaSemConsumoRow {
  familia: string | null;
  subfamilia: string | null;
  prateleira: string | null;
  aim: string | null;
  codigo: string; // CNP 7 dígitos
  designacao: string;
  stock: number;
  dataUltimaVenda: string | null; // YYYY-MM-DD
  dataUltimaCompra: string | null; // YYYY-MM-DD
  pvp: number;
  valorSemIva: number;
  valorComIva: number;
  taxaIvaEstimada: number | null; // 6 | 13 | 23
}

export interface ParsedSifarmaSemConsumoPdf {
  kind: 'SIFARMA_SEM_CONSUMO';
  farmaciaNome: string | null;
  farmaciaNif: string | null;
  semConsumoDesde: string | null; // YYYY-MM-DD
  dataImpressao: string | null; // YYYY-MM-DD
  totalValSemIvaPdf: number | null;
  totalValComIvaPdf: number | null;
  rows: SifarmaSemConsumoRow[];
}

function renderPageWithTabs(pageData: any): Promise<string> {
  return pageData
    .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((tc: any) => {
      const rows: Array<{ y: number; items: Array<{ x: number; str: string }> }> = [];
      for (const item of tc.items || []) {
        const str = String(item.str || '');
        if (!str.trim()) continue;
        const x = Number(item.transform?.[4] ?? 0);
        const y = Number(item.transform?.[5] ?? 0);
        let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
        if (!row) {
          row = { y, items: [] };
          rows.push(row);
        }
        row.items.push({ x, str });
      }
      rows.sort((a, b) => b.y - a.y);
      return rows
        .map((r) => {
          r.items.sort((a, b) => a.x - b.x);
          return r.items.map((i) => i.str.trim()).join('\t');
        })
        .join('\n');
    });
}

function parsePtEuro(raw: string | undefined): number {
  if (!raw) return NaN;
  const cleaned = raw.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function parsePtDateToIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function normalizeCnp7(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 6) return digits.padStart(7, '0');
  return digits.slice(0, 7);
}

function inferIvaPct(valSemIva: number, valComIva: number): number | null {
  if (!(valSemIva > 0 && valComIva >= valSemIva)) return null;
  const pct = ((valComIva / valSemIva) - 1) * 100;
  if (Math.abs(pct - 6) <= 1.5) return 6;
  if (Math.abs(pct - 13) <= 1.5) return 13;
  if (Math.abs(pct - 23) <= 2.0) return 23;
  if (pct < 1) return 0;
  return Math.round(pct);
}

function extractCommonHeader(lines: string[]) {
  let farmaciaNome: string | null = null;
  let farmaciaNif: string | null = null;
  let dataImpressao: string | null = null;

  for (let i = 0; i < Math.min(25, lines.length); i++) {
    const line = lines[i];
    if (!farmaciaNome && /^FARM[AÁ]CIA\b/i.test(line)) {
      farmaciaNome = line.split('\t')[0].replace(/\s+/g, ' ').trim();
    }
    const nifM = line.match(/NIF:\s*\t?\s*(\d{9})/i);
    if (nifM) farmaciaNif = nifM[1];
  }

  // Data de impressão no rodapé (ex: Impressão: 16-07-2026 20:36:59)
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const dtM = lines[i].match(/(\d{2}-\d{2}-\d{4})\s+\d{2}:\d{2}/);
    if (dtM) {
      dataImpressao = parsePtDateToIso(dtM[1]);
      break;
    }
  }

  return { farmaciaNome, farmaciaNif, dataImpressao };
}

export async function extractTabLinesFromPdf(buffer: Buffer): Promise<string[]> {
  const data = await pdfParse(buffer, { pagerender: renderPageWithTabs } as any);
  return String(data.text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function detectSifarmaPdfKindFromLines(lines: string[]): SifarmaPdfKind | null {
  const head = lines.slice(0, 40).join('\n');
  if (/Lista\s+Normal\s+de\s+Produtos\s+sem\s+Consumo/i.test(head) || /Produtos\s+sem\s+consumo\s+desde/i.test(head)) {
    return 'SIFARMA_SEM_CONSUMO';
  }
  if (/Invent[aá]rio\s+Normal/i.test(head) && (/Cst\s+Un\.\s+S\/\s*IVA/i.test(head) || /Pre[cç]o\s+Venda/i.test(head))) {
    return 'SIFARMA_INVENTARIO_NORMAL';
  }
  return null;
}

export async function detectSifarmaPdfKind(buffer: Buffer): Promise<{ kind: SifarmaPdfKind | null; lines: string[] }> {
  const lines = await extractTabLinesFromPdf(buffer);
  return { kind: detectSifarmaPdfKindFromLines(lines), lines };
}

export function parseSifarmaInventarioNormalLines(lines: string[]): ParsedSifarmaInventarioPdf {
  const { farmaciaNome, farmaciaNif, dataImpressao } = extractCommonHeader(lines);
  const rows: SifarmaInventarioRow[] = [];
  let totalArtigosPdf: number | null = null;
  let totalUnidadesPdf: number | null = null;

  for (const line of lines) {
    // Deteta totais globais no rodapé
    if (/^Totais\s+Globais:/i.test(line)) {
      const nums = line.match(/\d+/g);
      if (nums && nums.length >= 2) {
        totalArtigosPdf = parseInt(nums[0], 10);
        totalUnidadesPdf = parseInt(nums[1], 10);
      }
      continue;
    }
    if (/Total\s+Acumulado:/i.test(line)) {
      const nums = line.match(/\d+/g);
      if (nums && nums.length >= 2 && totalArtigosPdf === null) {
        totalArtigosPdf = parseInt(nums[0], 10);
        totalUnidadesPdf = parseInt(nums[1], 10);
      }
      continue;
    }

    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);
    if (cols.length < 6) continue;

    // Âncora: encontrar os 2 valores em € consecutivos (Preço Venda + Cst Un. S/ IVA)
    let euroIdx = -1;
    for (let i = 3; i < cols.length - 1; i++) {
      if (cols[i].endsWith('€') && cols[i + 1].endsWith('€')) {
        euroIdx = i;
        break;
      }
    }
    if (euroIdx < 3) continue;

    const pvp = parsePtEuro(cols[euroIdx]);
    const custoUnitario = parsePtEuro(cols[euroIdx + 1]);
    const stock = parseInt(cols[euroIdx - 1].replace(/\D/g, ''), 10);
    if (!Number.isFinite(stock) || !Number.isFinite(custoUnitario)) continue;

    const loteRaw = cols[euroIdx - 2] || 'LOTE ÚNICO';
    const lote = /LOTE/i.test(loteRaw) ? loteRaw : 'LOTE ÚNICO';
    const designacaoEndIdx = /LOTE/i.test(loteRaw) ? euroIdx - 2 : euroIdx - 1;

    // Encontrar o índice do CNP (7 dígitos) nos primeiros 3 campos
    let cnpIdx = -1;
    for (let i = 0; i < Math.min(3, designacaoEndIdx); i++) {
      if (/^\d{7}$/.test(cols[i])) {
        cnpIdx = i;
        break;
      }
    }
    if (cnpIdx === -1) continue;

    const codigo = normalizeCnp7(cols[cnpIdx]);
    const designacao = cols.slice(cnpIdx + 1, designacaoEndIdx).join(' ').trim();
    if (!designacao) continue;

    let prateleira: string | null = null;
    let aim: string | null = null;
    if (cnpIdx === 2) {
      prateleira = cols[0];
      aim = cols[1];
    } else if (cnpIdx === 1) {
      if (/^\d+$/.test(cols[0])) aim = cols[0];
      else prateleira = cols[0];
    }

    const stockMin = cols[euroIdx + 2] && /^\d+$/.test(cols[euroIdx + 2]) ? parseInt(cols[euroIdx + 2], 10) : null;
    const stockMax = cols[euroIdx + 3] && /^\d+$/.test(cols[euroIdx + 3]) ? parseInt(cols[euroIdx + 3], 10) : null;

    rows.push({
      prateleira,
      aim,
      codigo,
      designacao,
      lote,
      stock,
      pvp: Number.isFinite(pvp) ? pvp : 0,
      custoUnitario,
      stockMin,
      stockMax,
    });
  }

  return {
    kind: 'SIFARMA_INVENTARIO_NORMAL',
    farmaciaNome,
    farmaciaNif,
    dataImpressao,
    totalArtigosPdf,
    totalUnidadesPdf,
    rows,
  };
}

export async function parseSifarmaInventarioNormalPdf(buffer: Buffer): Promise<ParsedSifarmaInventarioPdf> {
  const lines = await extractTabLinesFromPdf(buffer);
  return parseSifarmaInventarioNormalLines(lines);
}

export function parseSifarmaSemConsumoLines(lines: string[]): ParsedSifarmaSemConsumoPdf {
  const { farmaciaNome, farmaciaNif, dataImpressao } = extractCommonHeader(lines);
  let semConsumoDesde: string | null = null;
  let totalValSemIvaPdf: number | null = null;
  let totalValComIvaPdf: number | null = null;
  let currentFamilia: string | null = null;
  let currentSubfamilia: string | null = null;

  const rows: SifarmaSemConsumoRow[] = [];

  for (const line of lines) {
    const desdeM = line.match(/Produtos\s+sem\s+consumo\s+desde\s+(\d{2}-\d{2}-\d{4})/i);
    if (desdeM) {
      semConsumoDesde = parsePtDateToIso(desdeM[1]);
      continue;
    }

    if (/^Fam[ií]lia:/i.test(line)) {
      const parts = line.split('\t').map((c) => c.trim()).filter(Boolean);
      currentFamilia = parts[1] || line.replace(/^Fam[ií]lia:\s*/i, '').trim() || null;
      continue;
    }
    if (/^Sub-Fam[ií]lia:/i.test(line)) {
      const parts = line.split('\t').map((c) => c.trim()).filter(Boolean);
      currentSubfamilia = parts[1] || line.replace(/^Sub-Fam[ií]lia:\s*/i, '').trim() || null;
      continue;
    }

    if (/^Total\s+Localiza/i.test(line) || /^Total\s+em\s+P\.V\.P\./i.test(line)) {
      const euros = line.match(/\d[\d.]*,\d{2}€/g);
      if (euros && euros.length >= 2) {
        const v1 = parsePtEuro(euros[0]);
        const v2 = parsePtEuro(euros[1]);
        if (Number.isFinite(v1) && Number.isFinite(v2)) {
          totalValSemIvaPdf = Math.min(v1, v2);
          totalValComIvaPdf = Math.max(v1, v2);
        }
      }
      continue;
    }

    // Ignora cabeçalhos e rodapés repetidos por página
    if (
      /^(FARM[AÁ]CIA|AVENIDA|Telefone:|Dir\.\s*T[eé]c|Localiza[cç][aã]o:|AIM\t|Total\s+Sub-Fam|Total\s+Fam|Impress[aã]o:|Página|\d{4}-\d{3}\t)/i.test(
        line
      )
    ) {
      continue;
    }

    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);

    // Continuação de designação partida em 2 linhas (ex: "revest pelic", "Unidade(s) Comp mast")
    if (cols.length === 1 && rows.length > 0 && !cols[0].endsWith('€') && !/^\d{2}-\d{2}-\d{4}$/.test(cols[0])) {
      rows[rows.length - 1].designacao = `${rows[rows.length - 1].designacao} ${cols[0]}`.trim();
      continue;
    }

    if (cols.length < 6) continue;

    // Âncora: últimos 3 campos são PVP€, Val. S/IVA€, Val. C/IVA€
    const n = cols.length;
    if (!cols[n - 1].endsWith('€') || !cols[n - 2].endsWith('€') || !cols[n - 3].endsWith('€')) {
      continue;
    }

    const valorComIva = parsePtEuro(cols[n - 1]);
    const valorSemIva = parsePtEuro(cols[n - 2]);
    const pvp = parsePtEuro(cols[n - 3]);
    if (!Number.isFinite(pvp) || !Number.isFinite(valorSemIva) || !Number.isFinite(valorComIva)) continue;

    // Antes de PVP€ existem 1 ou 2 datas (Ult. Venda e/ou Ult. Compra) e imediatamente antes o Stock
    let cursor = n - 4;
    const dates: string[] = [];
    while (cursor >= 0 && /^\d{2}-\d{2}-\d{4}$/.test(cols[cursor])) {
      dates.unshift(cols[cursor]);
      cursor--;
    }

    if (cursor < 2 || !/^\d+$/.test(cols[cursor])) continue;
    const stock = parseInt(cols[cursor], 10);
    const designacaoEndIdx = cursor;

    // Encontrar o CNP (7 dígitos) nos primeiros 3 campos
    let cnpIdx = -1;
    for (let i = 0; i < Math.min(3, designacaoEndIdx); i++) {
      if (/^\d{7}$/.test(cols[i])) {
        cnpIdx = i;
        break;
      }
    }
    if (cnpIdx === -1) continue;

    const codigo = normalizeCnp7(cols[cnpIdx]);
    const designacao = cols.slice(cnpIdx + 1, designacaoEndIdx).join(' ').trim();
    if (!designacao) continue;

    let aim: string | null = null;
    let prateleira: string | null = null;
    if (cnpIdx === 2) {
      aim = cols[0];
      prateleira = cols[1];
    } else if (cnpIdx === 1) {
      if (/^\d+$/.test(cols[0])) aim = cols[0];
      else prateleira = cols[0];
    }

    let dataUltimaVenda: string | null = null;
    let dataUltimaCompra: string | null = null;
    if (dates.length >= 2) {
      dataUltimaVenda = parsePtDateToIso(dates[0]);
      dataUltimaCompra = parsePtDateToIso(dates[1]);
    } else if (dates.length === 1) {
      const iso = parsePtDateToIso(dates[0]);
      // Se a data única for posterior à data "sem consumo desde", é garantidamente Ult. Compra
      if (iso && semConsumoDesde && iso > semConsumoDesde) {
        dataUltimaCompra = iso;
      } else {
        dataUltimaCompra = iso;
      }
    }

    rows.push({
      familia: currentFamilia,
      subfamilia: currentSubfamilia,
      prateleira,
      aim,
      codigo,
      designacao,
      stock,
      dataUltimaVenda,
      dataUltimaCompra,
      pvp,
      valorSemIva,
      valorComIva,
      taxaIvaEstimada: inferIvaPct(valorSemIva, valorComIva),
    });
  }

  return {
    kind: 'SIFARMA_SEM_CONSUMO',
    farmaciaNome,
    farmaciaNif,
    semConsumoDesde,
    dataImpressao,
    totalValSemIvaPdf,
    totalValComIvaPdf,
    rows,
  };
}

export async function parseSifarmaSemConsumoPdf(buffer: Buffer): Promise<ParsedSifarmaSemConsumoPdf> {
  const lines = await extractTabLinesFromPdf(buffer);
  return parseSifarmaSemConsumoLines(lines);
}
