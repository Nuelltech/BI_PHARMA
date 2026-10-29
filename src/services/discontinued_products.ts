import fs from 'fs';
import path from 'path';

interface DiscontinuedEntry {
  cnp: string;
  designacao?: string;
  dataDescontinuado: string;
  motivo?: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'discontinued_products.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify({}, null, 2), 'utf-8');
  }
}

function loadAll(): Record<string, DiscontinuedEntry[]> {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf-8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, DiscontinuedEntry[]>) {
  ensureDataFile();
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function getDiscontinuedCnps(farmaciaId: string): Set<string> {
  const all = loadAll();
  const list = all[farmaciaId] || [];
  return new Set(list.map((it) => it.cnp));
}

export function getDiscontinuedList(farmaciaId: string): DiscontinuedEntry[] {
  const all = loadAll();
  return all[farmaciaId] || [];
}

export function addDiscontinuedCnp(
  farmaciaId: string,
  cnp: string,
  designacao?: string,
  motivo = 'Descontinuado / Deixar de trabalhar (Ponto de Encomenda = 0)'
): boolean {
  const all = loadAll();
  const list = all[farmaciaId] || [];
  if (list.some((it) => it.cnp === cnp)) return false;
  list.push({
    cnp,
    designacao,
    dataDescontinuado: new Date().toISOString().split('T')[0],
    motivo,
  });
  all[farmaciaId] = list;
  saveAll(all);
  return true;
}

export function removeDiscontinuedCnp(farmaciaId: string, cnp: string): boolean {
  const all = loadAll();
  const list = all[farmaciaId] || [];
  const filtered = list.filter((it) => it.cnp !== cnp);
  if (filtered.length === list.length) return false;
  all[farmaciaId] = filtered;
  saveAll(all);
  return true;
}
