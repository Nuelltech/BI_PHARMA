/**
 * Worker de documentos de medicamento: lê uma pasta de PDF (nomes indiferentes, ex. "documento (12).pdf"),
 * identifica tipo e medicamento pelo conteúdo, dá nome normalizado, arruma em pastas e produz relatório.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { chaveNome, lerDocumento, SECCOES_ESSENCIAIS, semAcentos, type DocumentoLido } from './parse.js';

export type Estado = 'IDENTIFICADO' | 'POR_REVER' | 'DUPLICADO' | 'ERRO';

/** Produto de referência para ligar CNP -> produto (ProdutoCits ou, antes do CITS, ProdutoMestre). */
export interface ProdutoRef {
  cnp: string;
  nome: string | null;
  dci: string | null;
  prod_id: number | null;
}
export type Referencia = Map<string, ProdutoRef>;

export interface ResultadoDocumento {
  ficheiro_original: string;
  ficheiro_final: string | null;
  sha256: string;
  paginas: number;
  estado: Estado;
  motivo: string | null;
  doc: DocumentoLido | null;
  cnps_ligados: string[];
  prod_ids: number[];
  dcis: string[];
}

export interface OpcoesWorker {
  entrada: string;
  saida: string;
  referencia?: Referencia;
  /** sha256 já existentes na base de dados (para detetar duplicados entre execuções) */
  jaConhecidos?: Set<string>;
  /** RCM já identificados em execuções anteriores: chaveNome(nome) -> CNP (para ligar folhetos) */
  rcmPorNome?: Map<string, string[]>;
  /**
   * true (CITS): CNP que não existe na referência = problema, vai para revisão.
   * false (ProdutoMestre): CNP fora do catálogo da farmácia é normal; o documento fica identificado.
   */
  exigirReferencia?: boolean;
  mover?: boolean;   // por omissão copia e deixa os originais
  dryRun?: boolean;  // não copia nem move; só relatório
}

const norm = (s: string | null | undefined) => semAcentos(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** O nome do documento confere com algum produto ligado? Compara a primeira palavra significativa. */
export function nomeConfere(nomeDoc: string | null, produtos: ProdutoRef[]): boolean {
  if (!nomeDoc || !produtos.length) return true; // sem dados para comparar: não bloqueia
  const doc = norm(nomeDoc);
  return produtos.some((p) => {
    const palavras = [p.nome, p.dci].map(norm).filter(Boolean).map((n) => n.split(' ')[0]).filter((w) => w.length >= 3);
    return palavras.some((w) => doc.includes(w));
  });
}

export async function extrairTextoPdf(buf: Uint8Array): Promise<{ texto: string; paginas: number }> {
  const pdf = await getDocumentProxy(buf);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { texto: (text as string[]).join('\n'), paginas: totalPages };
}

/** Sugestões de CNP para revisão manual: produtos da referência com as mesmas 2 primeiras palavras do nome. */
export function sugerirCnps(nome: string | null, ref?: Referencia, max = 5): string[] {
  const duas = (n: string | null) => norm(n).split(' ').slice(0, 2).join(' ');
  const alvo = duas(nome);
  if (!ref || alvo.split(' ').length < 2 || alvo.length < 6) return [];
  return [...ref.values()].filter((p) => duas(p.nome) === alvo).map((p) => p.cnp).sort().slice(0, max);
}

export function classificar(doc: DocumentoLido, ref?: Referencia, rcmPorNome?: Map<string, string[]>, exigirReferencia = true) {
  const vazio = { cnps_ligados: [] as string[], prod_ids: [] as number[], dcis: [] as string[] };
  const rever = (motivo: string) => {
    const sug = sugerirCnps(doc.nome, ref);
    return { estado: 'POR_REVER' as Estado, motivo: sug.length ? `${motivo} — sugestão: ${sug.join(', ')}` : motivo, ...vazio };
  };
  if (doc.caracteres < 300) return rever('PDF sem texto (digitalizado?) — precisa de OCR');
  if (doc.tipo === 'DESCONHECIDO') return rever('tipo de documento não reconhecido');
  if (doc.tipo === 'MMR') return rever('MMR: ligação automática ainda não implementada');

  let cnps: string[];
  let aviso: string | null = null;
  if (doc.tipo === 'FI') {
    // Folheto não tem nº de registo: herda os CNP do RCM com o mesmo nome
    const k = chaveNome(doc.nome);
    const doRcm = k ? rcmPorNome?.get(k) : undefined;
    if (!doRcm?.length) return rever(`FI sem RCM correspondente pelo nome ("${doc.nome ?? '?'}")`);
    cnps = doRcm;
    aviso = 'FI ligado pelo nome ao RCM';
  } else {
    const faltam = SECCOES_ESSENCIAIS.filter((n) => doc.seccoes_em_falta.includes(n));
    if (faltam.length) return rever(`secções essenciais não encontradas: ${faltam.join(', ')}`);
    if (!doc.cnps.length) {
      return rever(doc.modelo_por_preencher
        ? 'RCM com campos por preencher no próprio documento (ex.: "xxxxxxx"): sem nº de registo'
        : 'secção 8 sem números de registo no próprio documento');
    }
    cnps = doc.cnps;
  }

  if (!ref) return { estado: 'IDENTIFICADO' as Estado, motivo: aviso ?? 'sem referência: CNP não confirmados', cnps_ligados: cnps, prod_ids: [], dcis: [] };

  const produtos = cnps.map((c) => ref.get(c)).filter((p): p is ProdutoRef => !!p);
  if (!produtos.length) {
    if (!exigirReferencia) {
      return { estado: 'IDENTIFICADO' as Estado, motivo: `CNP fora do catálogo da farmácia (${cnps.join(', ')})`, cnps_ligados: cnps, prod_ids: [], dcis: [] };
    }
    return rever(`nenhum CNP existe na referência (${cnps.join(', ')})`);
  }
  if (doc.tipo === 'RCM' && !nomeConfere(doc.nome, produtos)) {
    return rever(`nome "${doc.nome}" não confere com ${produtos[0].nome}`);
  }
  const semCorresp = cnps.length - produtos.length;
  return {
    estado: 'IDENTIFICADO' as Estado,
    motivo: [aviso, semCorresp ? `${semCorresp} CNP sem correspondência na referência` : null].filter(Boolean).join('; ') || null,
    cnps_ligados: produtos.map((p) => p.cnp).sort(),
    prod_ids: [...new Set(produtos.map((p) => p.prod_id).filter((x): x is number => x != null))],
    dcis: [...new Set(produtos.map((p) => p.dci).filter((x): x is string => !!x))],
  };
}

function destinoLivre(pasta: string, base: string, sufixo: string): string {
  let caminho = join(pasta, `${base}.pdf`);
  if (!existsSync(caminho)) return caminho;
  caminho = join(pasta, `${base}_${sufixo}.pdf`);
  return caminho;
}

export async function processarPasta(op: OpcoesWorker): Promise<ResultadoDocumento[]> {
  const pastas = { ok: join(op.saida, 'processados'), rever: join(op.saida, 'por_rever'), dup: join(op.saida, 'duplicados') };
  if (!op.dryRun) Object.values(pastas).forEach((p) => mkdirSync(p, { recursive: true }));

  const ficheiros = readdirSync(op.entrada).filter((f) => extname(f).toLowerCase() === '.pdf').sort();
  const vistos = new Set(op.jaConhecidos ?? []);
  const resultados: ResultadoDocumento[] = [];

  // 1.ª passagem: ler e interpretar
  for (const f of ficheiros) {
    const buf = readFileSync(join(op.entrada, f));
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const base: ResultadoDocumento = {
      ficheiro_original: f, ficheiro_final: null, sha256, paginas: 0, estado: 'ERRO', motivo: null,
      doc: null, cnps_ligados: [], prod_ids: [], dcis: [],
    };
    if (vistos.has(sha256)) { resultados.push({ ...base, estado: 'DUPLICADO', motivo: 'ficheiro idêntico já processado' }); continue; }
    vistos.add(sha256);
    try {
      const { texto, paginas } = await extrairTextoPdf(new Uint8Array(buf));
      resultados.push({ ...base, paginas, doc: lerDocumento(texto) });
    } catch (e) {
      resultados.push({ ...base, estado: 'ERRO', motivo: (e as Error).message.slice(0, 200) });
    }
  }

  // 2.ª passagem: classificar RCM, depois FI/MMR (que se ligam aos RCM pelo nome)
  const rcmPorNome = new Map(op.rcmPorNome ?? []);
  const ordem = (r: ResultadoDocumento) => (r.doc?.tipo === 'RCM' ? 0 : 1);
  for (const r of [...resultados].sort((a, b) => ordem(a) - ordem(b))) {
    if (!r.doc) continue;
    Object.assign(r, classificar(r.doc, op.referencia, rcmPorNome, op.exigirReferencia ?? true));
    if (r.doc.tipo === 'RCM' && r.estado === 'IDENTIFICADO') {
      const k = chaveNome(r.doc.nome);
      if (k) rcmPorNome.set(k, [...new Set([...(rcmPorNome.get(k) ?? []), ...r.cnps_ligados])].sort());
    }
  }

  // 3.ª passagem: nomes finais e arrumação
  for (const r of resultados) {
    const origem = join(op.entrada, r.ficheiro_original);
    let destino: string;
    if (r.estado === 'DUPLICADO') destino = destinoLivre(pastas.dup, basename(r.ficheiro_original, '.pdf'), r.sha256.slice(0, 8));
    else if (r.estado === 'IDENTIFICADO' && r.doc) {
      destino = destinoLivre(pastas.ok, `${r.cnps_ligados[0]}_${r.doc.tipo}`, r.doc.data_revisao ?? r.doc.data_aprovacao ?? r.sha256.slice(0, 8));
    } else destino = destinoLivre(pastas.rever, `${basename(r.ficheiro_original, '.pdf')}__${r.sha256.slice(0, 8)}`, 'x');
    r.ficheiro_final = basename(destino);
    if (!op.dryRun) arrumar(origem, destino, op.mover);
  }
  return resultados;
}

function arrumar(origem: string, destino: string, mover?: boolean) {
  if (mover) renameSync(origem, destino); else copyFileSync(origem, destino);
}

// ---------- relatório ----------
const csvCampo = (v: unknown) => {
  const s = v == null ? '' : Array.isArray(v) ? v.join(' ') : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function escreverRelatorio(pasta: string, resultados: ResultadoDocumento[]) {
  mkdirSync(pasta, { recursive: true });
  const cab = ['ficheiro_original', 'ficheiro_final', 'estado', 'motivo', 'tipo', 'paginas', 'nome', 'cnps_seccao8',
    'cnps_ligados', 'dcis', 'data_revisao', 'data_aprovacao', 'seccoes_encontradas', 'seccoes_em_falta', 'chars_4_1'];
  const linhas = resultados.map((r) => [
    r.ficheiro_original, r.ficheiro_final, r.estado, r.motivo, r.doc?.tipo, r.paginas, r.doc?.nome, r.doc?.cnps,
    r.cnps_ligados, r.dcis, r.doc?.data_revisao, r.doc?.data_aprovacao, r.doc?.seccoes.length, r.doc?.seccoes_em_falta,
    r.doc?.seccoes.find((s) => s.numero === '4.1')?.texto.length,
  ].map(csvCampo).join(','));
  writeFileSync(join(pasta, 'relatorio.csv'), '﻿' + [cab.join(','), ...linhas].join('\n'));
  writeFileSync(join(pasta, 'relatorio.json'), JSON.stringify(resultados.map((r) => ({
    ...r, doc: r.doc && { ...r.doc, seccoes: r.doc.seccoes.map((s) => ({ ...s, texto: s.texto.slice(0, 300) })) },
  })), null, 2));
}

export function resumo(resultados: ResultadoDocumento[]) {
  const por = <K extends string>(f: (r: ResultadoDocumento) => K) =>
    resultados.reduce<Record<string, number>>((a, r) => { const k = f(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const rcm = resultados.filter((r) => r.doc?.tipo === 'RCM');
  const h41 = new Set(rcm.map((r) => r.doc!.seccoes.find((s) => s.numero === '4.1')?.texto_hash).filter(Boolean));
  return {
    ficheiros: resultados.length,
    por_estado: por((r) => r.estado),
    por_tipo: por((r) => r.doc?.tipo ?? '-'),
    rcm_com_4_1: rcm.filter((r) => r.doc!.seccoes.some((s) => s.numero === '4.1')).length,
    textos_4_1_unicos: h41.size,
    motivos_revisao: por((r) => (r.estado === 'POR_REVER' ? (r.motivo ?? '').replace(/\(.*\)|".*"/g, '').trim() : 'ok')),
  };
}
