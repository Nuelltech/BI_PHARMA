/**
 * Auditoria linha-a-linha: Ficheiros Originais (Farmácia Baptista = Farmácia A) vs Base de Dados.
 * - CSV de Vendas  -> ProdutoMestre (PVP, Margem) + Venda (13 meses)
 * - PDF Inventário -> Inventario (Stock, Custo, Lote) + totais globais do PDF
 * - PDF Validades  -> Inventario.data_validade
 *
 * Uso: npx tsx src/audit_source_files.ts [--db=local|supabase]
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import iconv from 'iconv-lite';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { parseInventarioPdfFile, parseValidadesPdfFile } from './services/ingestion';

dotenv.config();

const DIR = path.resolve(process.cwd(), 'baptista');
const CSV_FILE = path.join(DIR, 'vendas baptista25-26.csv');
const INV_FILE = path.join(DIR, '21000lista_20261019104350.pdf');
const VAL_FILE = path.join(DIR, '21001lista_20261019190456_Validades.pdf');

const LOCAL_URL = 'postgresql://postgres:password@localhost:5433/bi_pharma?schema=public';
const useSupabase = process.argv.includes('--db=supabase');

const num = (s: string | undefined | null): number | null => {
  if (s === undefined || s === null) return null;
  const t = s.replace(/€/g, '').trim();
  if (!t) return null;
  const n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
};
const eq2 = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(a - b) < 0.005;

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(1000);
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('timeout', () => (s.destroy(), resolve(false)));
    s.on('error', () => (s.destroy(), resolve(false)));
    s.connect(port, '127.0.0.1');
  });
}

interface CsvRow {
  codigo: string;
  designacao: string;
  stockTot: number;
  stock: number;
  pvp: number | null;
  valorVendas: number | null;
  custo: number | null;
  margem: number | null;
  meses: { iso: string; qtd: number }[];
  totalUni: number;
}

function parseCsvIndependent(): CsvRow[] {
  const text = iconv.decode(fs.readFileSync(CSV_FILE), 'win1252');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(';').map((h) => h.trim().toUpperCase());
  const MONTHS: Record<string, number> = {
    JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  };
  const monthCols: { idx: number; iso: string }[] = [];
  let year = 2025;
  let prev: number | null = null;
  header.forEach((h, idx) => {
    const m = MONTHS[h];
    if (m !== undefined) {
      if (prev !== null && m < prev) year++;
      prev = m;
      monthCols.push({ idx, iso: `${year}-${String(m).padStart(2, '0')}` });
    }
  });
  const tIdx = header.findIndex((h) => h.startsWith('T UNI'));

  const out: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(';');
    const codigo = (c[0] || '').trim();
    if (!/^\d{6,7}$/.test(codigo)) continue;
    out.push({
      codigo: codigo.padStart(7, '0'),
      designacao: (c[1] || '').trim(),
      stockTot: num(c[2]) ?? 0,
      stock: num(c[4]) ?? 0,
      pvp: num(c[5]),
      valorVendas: num(c[6]),
      custo: num(c[7]),
      margem: num(c[8]),
      meses: monthCols.map((mc) => ({ iso: mc.iso, qtd: parseInt((c[mc.idx] || '0').trim(), 10) || 0 })),
      totalUni: tIdx >= 0 ? parseInt((c[tIdx] || '0').trim(), 10) || 0 : 0,
    });
  }
  return out;
}

async function main() {
  let embedded: any = null;
  if (!useSupabase && !(await isPortOpen(5433))) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    embedded = new EmbeddedPostgres({
      databaseDir: path.resolve(process.cwd(), '.pgdata_utf8'),
      user: 'postgres',
      password: 'password',
      port: 5433,
      persistent: true,
    });
    await embedded.start();
  }
  const prisma = new PrismaClient({
    datasources: { db: { url: useSupabase ? process.env.SUPABASE_DATABASE_URL! : LOCAL_URL } },
  });

  const report: string[] = [];
  const log = (s = '') => {
    console.log(s);
    report.push(s);
  };

  try {
    const farm = await prisma.farmacia.findFirst({ where: { nif: '505016419' } });
    if (!farm) throw new Error('Farmácia Baptista (NIF 505016419) não encontrada.');
    log(`# Auditoria Ficheiros Originais vs BD (${useSupabase ? 'SUPABASE' : 'LOCAL'}) — ${farm.nome} (Baptista)`);

    // ---------------------------------------------------------------- CSV
    const csvRows = parseCsvIndependent();
    const prods = await prisma.produtoMestre.findMany();
    const prodMap = new Map(prods.map((p) => [p.cnp_codigo, p]));
    const vendas = await prisma.venda.findMany({ where: { farmaciaId: farm.id } });
    const vendasMap = new Map<string, Map<string, number>>();
    for (const v of vendas) {
      const k = v.data_venda.toISOString().slice(0, 7);
      const m = vendasMap.get(v.cnp_codigo) ?? new Map<string, number>();
      m.set(k, (m.get(k) ?? 0) + v.quantidade);
      vendasMap.set(v.cnp_codigo, m);
    }
    const invs = await prisma.inventario.findMany({ where: { farmaciaId: farm.id } });
    const invByCode = new Map<string, typeof invs>();
    for (const i of invs) {
      const a = invByCode.get(i.cnp_codigo) ?? [];
      a.push(i);
      invByCode.set(i.cnp_codigo, a);
    }

    const issues = {
      semProduto: [] as string[],
      pvpDiff: [] as string[],
      pvpNull: [] as string[],
      margemDiff: [] as string[],
      vendasDiff: [] as string[],
      totalUniDiff: [] as string[],
      stockCsvVsPdf: [] as string[],
      dupCsv: [] as string[],
    };
    const seen = new Set<string>();
    let csvTotalUni = 0;
    for (const r of csvRows) {
      if (seen.has(r.codigo)) issues.dupCsv.push(r.codigo);
      seen.add(r.codigo);
      csvTotalUni += r.meses.reduce((s, m) => s + m.qtd, 0);
      const p = prodMap.get(r.codigo);
      if (!p) {
        issues.semProduto.push(`${r.codigo} ${r.designacao}`);
        continue;
      }
      const dbPvp = p.pvp !== null ? Number(p.pvp) : null;
      if (r.pvp !== null && r.pvp > 0) {
        if (dbPvp === null) issues.pvpNull.push(`${r.codigo} ${r.designacao} | CSV PVP ${r.pvp}`);
        else if (!eq2(dbPvp, r.pvp)) issues.pvpDiff.push(`${r.codigo} ${r.designacao} | CSV ${r.pvp} vs BD ${dbPvp}`);
      }
      const dbMg = p.margem_padrao !== null ? Number(p.margem_padrao) : null;
      if (r.margem !== null && dbMg !== null && !eq2(dbMg, r.margem)) {
        issues.margemDiff.push(`${r.codigo} ${r.designacao} | CSV ${r.margem}% vs BD ${dbMg}%`);
      } else if (r.margem !== null && dbMg === null) {
        issues.margemDiff.push(`${r.codigo} ${r.designacao} | CSV ${r.margem}% vs BD (vazio)`);
      }
      const vm = vendasMap.get(r.codigo) ?? new Map();
      const diffs = r.meses.filter((m) => (vm.get(m.iso) ?? 0) !== m.qtd);
      if (diffs.length) {
        issues.vendasDiff.push(
          `${r.codigo} ${r.designacao} | ` + diffs.map((d) => `${d.iso}: CSV ${d.qtd} vs BD ${vm.get(d.iso) ?? 0}`).join(', ')
        );
      }
      const sumMeses = r.meses.reduce((s, m) => s + m.qtd, 0);
      if (sumMeses !== r.totalUni) issues.totalUniDiff.push(`${r.codigo} soma meses ${sumMeses} vs T Uni ${r.totalUni}`);
      const stockPdf = (invByCode.get(r.codigo) ?? []).reduce((s, i) => s + i.quantidade, 0);
      if (stockPdf !== r.stockTot) {
        issues.stockCsvVsPdf.push(`${r.codigo} ${r.designacao} | CSV STOCK TOT ${r.stockTot} vs Inventário PDF/BD ${stockPdf}`);
      }
    }
    // Vendas na BD que não existem no CSV
    const csvCodes = new Set(csvRows.map((r) => r.codigo));
    const vendasOrfas = [...vendasMap.keys()].filter((k) => !csvCodes.has(k));
    const dbTotalUni = vendas.reduce((s, v) => s + v.quantidade, 0);

    log('\n## 1. CSV de Vendas');
    log(`- Linhas de artigo no CSV: ${csvRows.length} (duplicados: ${issues.dupCsv.length})`);
    log(`- Unidades vendidas (13 meses) CSV: ${csvTotalUni} | BD: ${dbTotalUni} ${csvTotalUni === dbTotalUni ? '✅' : '❌'}`);
    log(`- Artigos CSV sem ProdutoMestre: ${issues.semProduto.length}`);
    log(`- PVP vazio na BD (mas existe no CSV): ${issues.pvpNull.length}`);
    log(`- PVP diferente CSV vs BD: ${issues.pvpDiff.length}`);
    log(`- Margem diferente/vazia CSV vs BD: ${issues.margemDiff.length}`);
    log(`- Artigos com vendas mensais diferentes: ${issues.vendasDiff.length}`);
    log(`- Vendas na BD de códigos inexistentes no CSV: ${vendasOrfas.length}`);
    log(`- [Info] CSV soma meses ≠ T Uni (no próprio ficheiro): ${issues.totalUniDiff.length}`);
    log(`- [Cruzamento] STOCK TOT do CSV ≠ stock do Inventário PDF: ${issues.stockCsvVsPdf.length}`);

    // ---------------------------------------------------------------- PDF Inventário
    const invPdf = await parseInventarioPdfFile(INV_FILE);
    const pdfText = (await (await import('pdf-parse')).default(fs.readFileSync(INV_FILE))).text;
    const gm = pdfText.match(/Totais Globais :[\s\S]*?Total\s+(\d+)([\d.]+,\d{2})€(\d+)/);
    const invIssues = { qtd: [] as string[], custo: [] as string[], faltaBd: [] as string[], extraBd: [] as string[] };
    const pdfKeys = new Set<string>();
    let pdfUnits = 0;
    let pdfValor = 0;
    for (const r of invPdf.rows) {
      const code = r.codigo.padStart(7, '0');
      const key = `${code}|${r.lote}`;
      pdfKeys.add(key);
      const q = parseInt(r.stock, 10);
      pdfUnits += q;
      pdfValor += num(r.valor_s_iva) ?? 0;
      const dbRow = invs.find((i) => i.cnp_codigo === code && i.lote === r.lote);
      if (!dbRow) {
        invIssues.faltaBd.push(`${code} ${r.designacao} (${r.lote})`);
        continue;
      }
      if (dbRow.quantidade !== q) invIssues.qtd.push(`${code} ${r.designacao} | PDF ${q} vs BD ${dbRow.quantidade}`);
      if (!eq2(Number(dbRow.custo_unitario), num(r.custo_unit)))
        invIssues.custo.push(`${code} ${r.designacao} | PDF ${r.custo_unit} vs BD ${dbRow.custo_unitario}`);
    }
    for (const i of invs) if (!pdfKeys.has(`${i.cnp_codigo}|${i.lote}`)) invIssues.extraBd.push(`${i.cnp_codigo} (${i.lote}) qtd ${i.quantidade}`);

    log('\n## 2. PDF de Inventário');
    if (gm) log(`- Totais Globais impressos no PDF: ${gm[1]} un | ${gm[2]}€ | ${gm[3]} linhas`);
    log(`- Linhas extraídas: ${invPdf.rows.length} | Unidades: ${pdfUnits} | Valor: ${pdfValor.toFixed(2)}€`);
    log(`- Linhas na BD: ${invs.length} | Unidades: ${invs.reduce((s, i) => s + i.quantidade, 0)} | Valor: ${invs.reduce((s, i) => s + i.quantidade * Number(i.custo_unitario), 0).toFixed(2)}€`);
    log(`- Stock diferente: ${invIssues.qtd.length} | Custo diferente: ${invIssues.custo.length} | No PDF e não na BD: ${invIssues.faltaBd.length} | Na BD e não no PDF: ${invIssues.extraBd.length}`);

    // ---------------------------------------------------------------- PDF Validades
    const valPdf = await parseValidadesPdfFile(VAL_FILE);
    const minVal = new Map<string, { mmYYYY: string; date: Date; des: string }>();
    for (const r of valPdf.rows) {
      const [mm, yyyy] = r.validade.split('-').map((x) => parseInt(x, 10));
      const d = new Date(Date.UTC(yyyy, mm, 0)); // último dia do mês
      const code = r.codigo.padStart(7, '0');
      const cur = minVal.get(code);
      if (!cur || d < cur.date) minVal.set(code, { mmYYYY: r.validade, date: d, des: r.designacao });
    }
    const valIssues = { diff: [] as string[], semInv: [] as string[], invSemVal: 0 };
    for (const [code, v] of minVal) {
      const rows = invByCode.get(code);
      if (!rows || rows.length === 0) {
        valIssues.semInv.push(`${code} ${v.des} (${v.mmYYYY})`);
        continue;
      }
      const dbDates = rows.map((r) => r.data_validade).filter(Boolean) as Date[];
      const dbMin = dbDates.length ? new Date(Math.min(...dbDates.map((d) => d.getTime()))) : null;
      const dbMM = dbMin ? `${String(dbMin.getUTCMonth() + 1).padStart(2, '0')}-${dbMin.getUTCFullYear()}` : 'vazio';
      if (dbMM !== v.mmYYYY) valIssues.diff.push(`${code} ${v.des} | PDF ${v.mmYYYY} vs BD ${dbMM}`);
    }
    const valCodes = new Set(minVal.keys());
    const invComValidadeSemFonte = invs.filter((i) => i.data_validade && !valCodes.has(i.cnp_codigo));

    log('\n## 3. PDF de Validades');
    log(`- Linhas extraídas: ${valPdf.rows.length} | Códigos distintos: ${minVal.size}`);
    log(`- Validade diferente PDF vs BD: ${valIssues.diff.length}`);
    log(`- Códigos com validade mas sem stock no inventário: ${valIssues.semInv.length}`);
    log(`- Inventário com validade na BD sem origem no PDF de validades: ${invComValidadeSemFonte.length}`);

    // ---------------------------------------------------------------- Detalhe
    const dump = (title: string, arr: string[], max = 40) => {
      if (!arr.length) return;
      log(`\n### ${title} (${arr.length})`);
      arr.slice(0, max).forEach((x) => log(`- ${x}`));
      if (arr.length > max) log(`- ... (+${arr.length - max})`);
    };
    dump('CSV sem ProdutoMestre', issues.semProduto);
    dump('PVP vazio na BD', issues.pvpNull);
    dump('PVP diferente', issues.pvpDiff);
    dump('Margem diferente', issues.margemDiff);
    dump('Vendas mensais diferentes', issues.vendasDiff);
    dump('Vendas órfãs na BD', vendasOrfas);
    dump('Inventário: stock diferente', invIssues.qtd);
    dump('Inventário: custo diferente', invIssues.custo);
    dump('Inventário: falta na BD', invIssues.faltaBd);
    dump('Inventário: extra na BD', invIssues.extraBd);
    dump('Validades diferentes', valIssues.diff);
    dump('Validades sem stock', valIssues.semInv, 15);
    dump('Cruzamento STOCK CSV vs PDF', issues.stockCsvVsPdf, 25);

    const outDir = path.resolve(process.cwd(), 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `auditoria_baptista_${useSupabase ? 'supabase' : 'local'}.md`), report.join('\n'), 'utf-8');
  } finally {
    await prisma.$disconnect();
    if (embedded) await embedded.stop().catch(() => {});
  }
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
