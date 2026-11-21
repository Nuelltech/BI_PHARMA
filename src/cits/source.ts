/**
 * Leitura do ficheiro CITS: Access (.mdb/.accdb via mdbtools) ou pasta de CSV
 * (útil para testes e para ficheiros já exportados).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { TABELAS, type TabelaCits } from './config.js';

export type Linha = Record<string, string | null>;
export type DadosCits = Map<string, Linha[]>;

export interface Validacao {
  erros: string[];
  avisos: string[];
}

const normalizar = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

function procurarTabela(def: TabelaCits, disponiveis: string[]): string | undefined {
  const candidatos = [def.nome, ...(def.aliases ?? [])].map(normalizar);
  return disponiveis.find((t) => candidatos.includes(normalizar(t)));
}

export function sha256Ficheiro(caminho: string): string {
  return createHash('sha256').update(readFileSync(caminho)).digest('hex');
}

/** Converte as tabelas necessárias do Access para CSV numa pasta temporária. */
export function exportarAccess(caminho: string): string {
  const destino = mkdtempSync(join(tmpdir(), 'cits-'));
  const tabelas = execFileSync('mdb-tables', ['-1', caminho], { encoding: 'utf8' })
    .split('\n').map((t) => t.trim()).filter(Boolean);
  for (const def of TABELAS) {
    const real = procurarTabela(def, tabelas);
    if (!real) continue;
    const csv = execFileSync('mdb-export', ['-D', '%Y-%m-%d', '-T', '%Y-%m-%d %H:%M:%S', caminho, real], {
      encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
    });
    writeFileSync(join(destino, `${def.nome}.csv`), csv);
  }
  return destino;
}

/** Lê uma pasta de CSV (um ficheiro por tabela) e valida a estrutura. */
export function lerPastaCsv(pasta: string): { dados: DadosCits; validacao: Validacao } {
  const ficheiros = readdirSync(pasta).filter((f) => extname(f).toLowerCase() === '.csv');
  const nomes = ficheiros.map((f) => basename(f, extname(f)));
  const dados: DadosCits = new Map();
  const validacao: Validacao = { erros: [], avisos: [] };

  for (const def of TABELAS) {
    const real = procurarTabela(def, nomes);
    if (!real) {
      (def.opcional ? validacao.avisos : validacao.erros).push(`Tabela em falta: ${def.nome}`);
      continue;
    }
    const conteudo = readFileSync(join(pasta, `${real}.csv`), 'utf8');
    const linhas = parse(conteudo, {
      columns: (cab: string[]) => cab.map(normalizar),
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      cast: (v) => (v === '' ? null : v),
    }) as Linha[];

    const colunas = linhas.length ? Object.keys(linhas[0]) : [];
    const emFalta = def.obrigatorias.filter((c) => linhas.length && !colunas.includes(c));
    if (emFalta.length) validacao.erros.push(`${def.nome}: colunas em falta ${emFalta.join(', ')}`);
    if (!linhas.length && !def.opcional) validacao.erros.push(`${def.nome}: tabela vazia`);
    dados.set(def.nome, linhas);
  }

  const conhecidas = new Set(TABELAS.flatMap((t) => [t.nome, ...(t.aliases ?? [])].map(normalizar)));
  const extra = nomes.filter((n) => !conhecidas.has(normalizar(n)));
  if (extra.length) validacao.avisos.push(`Tabelas não usadas: ${extra.join(', ')}`);
  return { dados, validacao };
}

/** Aceita um ficheiro Access ou uma pasta de CSV. */
export function lerCits(caminho: string): { dados: DadosCits; validacao: Validacao } {
  const pasta = statSync(caminho).isDirectory() ? caminho : exportarAccess(caminho);
  return lerPastaCsv(pasta);
}
