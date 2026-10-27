import { PrismaClient } from '@prisma/client';
import { classifyProduct } from './classifier';
import type { CopilotResponse } from './copilot';

// ============================================================================
// CATÁLOGO DE PRODUTOS POR FARMÁCIA (CACHE EM MEMÓRIA) + MOTOR DE PESQUISA
// ----------------------------------------------------------------------------
// - Normaliza designações (sem acentos, maiúsculas, pontuação) para pesquisa
//   robusta independentemente de como o artigo foi escrito no Sifarma.
// - Pesquisa por GRUPOS de termos: todos os grupos têm de coincidir (AND) e,
//   dentro de cada grupo, basta um sinónimo (OR).
// - Filtros estruturados: só com stock, segmento, categoria, exclusões.
// ============================================================================

export interface CatalogItem {
  cnp: string;
  designacao: string;
  norm: string; // designação normalizada
  categoria: string;
  normCategoria: string;
  tipoVenda: string; // VENDA_LIVRE | MNSRM | MSRM
  ehGenerico: boolean;
  stock: number;
  custo: number;
  pvp: number;
  margem: number;
  vendasQtd: number;
  faturacao: number;
  validade: string | null;
}

export interface CatalogSearchParams {
  grupos_termos?: string[][];
  excluir?: string[];
  apenas_com_stock?: boolean;
  apenas_sem_stock?: boolean;
  segmento?: 'VENDA_LIVRE' | 'MNSRM' | 'MSRM' | 'GENERICO' | 'SEM_RECEITA' | 'TODOS';
  categoria?: string;
  ordenar_por?: 'vendas' | 'lucro' | 'margem' | 'stock' | 'faturacao' | 'nome';
  limite?: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const catalogCache = new Map<string, { at: number; items: CatalogItem[] }>();

export function normalizeText(str: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%+]+/g, ' ')
    .trim();
}

/** Invalida a cache (ex: após nova importação de dados) */
export function invalidateCatalog(farmaciaId?: string) {
  if (farmaciaId) catalogCache.delete(farmaciaId);
  else catalogCache.clear();
}

/**
 * Carrega todos os produtos com stock ou vendas na farmácia, com métricas agregadas.
 */
export async function getPharmacyCatalog(prisma: PrismaClient, farmaciaId: string): Promise<CatalogItem[]> {
  const cached = catalogCache.get(farmaciaId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  const [inventarios, vendas] = await Promise.all([
    prisma.inventario.findMany({
      where: { farmaciaId },
      select: { cnp_codigo: true, quantidade: true, custo_unitario: true, data_validade: true },
    }),
    prisma.venda.groupBy({
      by: ['cnp_codigo'],
      where: { farmaciaId },
      _sum: { quantidade: true, valor_total: true },
    }),
  ]);

  const invMap = new Map<string, { stock: number; custo: number; validade: Date | null }>();
  for (const i of inventarios) {
    const cur = invMap.get(i.cnp_codigo) || { stock: 0, custo: 0, validade: null as Date | null };
    cur.stock += i.quantidade;
    if (!cur.custo) cur.custo = Number(i.custo_unitario);
    if (i.data_validade && (!cur.validade || i.data_validade < cur.validade)) cur.validade = i.data_validade;
    invMap.set(i.cnp_codigo, cur);
  }

  const vendMap = new Map<string, { qtd: number; fat: number }>();
  for (const v of vendas) {
    vendMap.set(v.cnp_codigo, { qtd: v._sum.quantidade || 0, fat: Number(v._sum.valor_total || 0) });
  }

  const cnps = Array.from(new Set([...invMap.keys(), ...vendMap.keys()]));
  const produtos = await prisma.produtoMestre.findMany({
    where: { cnp_codigo: { in: cnps } },
    select: { cnp_codigo: true, designacao: true, pvp: true, margem_padrao: true, taxa_iva: true },
  });

  const items: CatalogItem[] = produtos.map((p) => {
    const inv = invMap.get(p.cnp_codigo);
    const vend = vendMap.get(p.cnp_codigo);
    const c = classifyProduct(p.cnp_codigo, p.designacao, p.taxa_iva);
    const custo = inv?.custo || 0;
    const vendasQtd = vend?.qtd || 0;
    const faturacao = vend?.fat || 0;
    const pvp = p.pvp ? Number(p.pvp) : vendasQtd > 0 ? faturacao / vendasQtd : custo * 1.4;
    const margem = p.margem_padrao
      ? Number(p.margem_padrao)
      : pvp > custo && pvp > 0
        ? ((pvp - custo) / pvp) * 100
        : 0;

    return {
      cnp: p.cnp_codigo,
      designacao: p.designacao,
      norm: normalizeText(p.designacao),
      categoria: c.categoria || '',
      normCategoria: normalizeText(c.categoria || ''),
      tipoVenda: c.tipo_venda,
      ehGenerico: !!c.eh_generico,
      stock: inv?.stock || 0,
      custo,
      pvp,
      margem,
      vendasQtd,
      faturacao,
      validade: inv?.validade ? inv.validade.toISOString().substring(0, 10) : null,
    };
  });

  catalogCache.set(farmaciaId, { at: Date.now(), items });
  return items;
}

// ----------------------------------------------------------------------------
// Correspondência de termos
// ----------------------------------------------------------------------------

const PHRASE_FILLERS = new Set(['de', 'da', 'do', 'des', 'du', 'la', 'le', 'e', '&']);

function collapseDoubles(str: string): string {
  return str.replace(/([a-z])\1+/g, '$1');
}

/**
 * Um termo coincide se TODAS as suas palavras (exceto conectores) surgirem como
 * início de palavra na designação (com tolerância a consoantes duplas, ex: toillete ↔ toilette).
 */
export function termMatches(normText: string, term: string): boolean {
  const words = normalizeText(term)
    .split(' ')
    .filter((w) => w && !PHRASE_FILLERS.has(w));
  if (words.length === 0) return false;
  const padded = ' ' + normText + ' ';
  const paddedCollapsed = ' ' + collapseDoubles(normText) + ' ';
  return words.every((w) => {
    if (padded.includes(' ' + w)) return true;
    const wc = collapseDoubles(w);
    if (wc.length >= 4 && paddedCollapsed.includes(' ' + wc)) return true;
    // Se terminar em vogal (ex: toilete vs toilet), testar sem última vogal
    if (wc.length >= 6 && /[aeiou]$/.test(wc) && paddedCollapsed.includes(' ' + wc.slice(0, -1))) return true;
    return false;
  });
}

export function searchCatalog(items: CatalogItem[], params: CatalogSearchParams): CatalogItem[] {
  const grupos = (params.grupos_termos || []).filter((g) => Array.isArray(g) && g.length > 0);
  const excluir = (params.excluir || []).filter(Boolean);
  const categoriaNorm = params.categoria ? normalizeText(params.categoria) : '';

  let result = items.filter((it) => {
    if (params.apenas_com_stock && it.stock <= 0) return false;
    if (params.apenas_sem_stock && it.stock > 0) return false;

    switch (params.segmento) {
      case 'VENDA_LIVRE':
        if (it.tipoVenda !== 'VENDA_LIVRE') return false;
        break;
      case 'MNSRM':
        if (it.tipoVenda !== 'MNSRM') return false;
        break;
      case 'MSRM':
        if (it.tipoVenda !== 'MSRM') return false;
        break;
      case 'SEM_RECEITA':
        if (it.tipoVenda === 'MSRM') return false;
        break;
      case 'GENERICO':
        if (!it.ehGenerico) return false;
        break;
    }

    if (categoriaNorm && !it.normCategoria.includes(categoriaNorm)) return false;
    if (excluir.some((t) => termMatches(it.norm, t))) return false;
    if (grupos.length > 0 && !grupos.every((g) => g.some((t) => termMatches(it.norm, t)))) return false;
    return true;
  });

  const ord = params.ordenar_por || (params.apenas_com_stock ? 'stock' : 'vendas');
  result = result.sort((a, b) => {
    switch (ord) {
      case 'stock':
        return b.stock - a.stock || b.vendasQtd - a.vendasQtd;
      case 'margem':
        return b.margem - a.margem;
      case 'lucro':
        return (b.pvp - b.custo) * b.vendasQtd - (a.pvp - a.custo) * a.vendasQtd;
      case 'faturacao':
        return b.faturacao - a.faturacao;
      case 'nome':
        return a.designacao.localeCompare(b.designacao);
      default:
        return b.vendasQtd - a.vendasQtd || b.stock - a.stock;
    }
  });

  if (params.limite && params.limite > 0) result = result.slice(0, params.limite);
  return result;
}

/**
 * Exploração de vocabulário: como é que um conceito está escrito no catálogo real?
 */
export function exploreVocabulary(items: CatalogItem[], termos: string[]) {
  return termos.map((termo) => {
    const matches = items.filter((it) => termMatches(it.norm, termo));
    const comStock = matches.filter((m) => m.stock > 0);
    const amostra = [...comStock, ...matches.filter((m) => m.stock <= 0)]
      .slice(0, 12)
      .map((m) => `${m.designacao} [stock ${m.stock}]`);
    const categorias = new Map<string, number>();
    for (const m of matches) categorias.set(m.categoria, (categorias.get(m.categoria) || 0) + 1);
    return {
      termo,
      total: matches.length,
      com_stock: comStock.length,
      categorias: Array.from(categorias.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([c, n]) => `${c} (${n})`),
      exemplos: amostra,
    };
  });
}

// ----------------------------------------------------------------------------
// Construção da resposta tabular
// ----------------------------------------------------------------------------

export function buildProductTableResponse(
  rows: CatalogItem[],
  opts: { titulo: string; explicacao: string; resumo?: string }
): CopilotResponse {
  const totalStock = rows.reduce((s, r) => s + r.stock, 0);
  const totalVend = rows.reduce((s, r) => s + r.vendasQtd, 0);
  const valorStock = rows.reduce((s, r) => s + r.stock * r.custo, 0);

  return {
    titulo: opts.titulo,
    explicacao: opts.explicacao,
    colunas: [
      'Código CNP',
      'Segmento',
      'Designação do Produto',
      'Stock Atual',
      'Unid. Vendidas (12m)',
      'Faturação (€)',
      'Preço Custo',
      'PVP (€)',
      'Margem (%)',
      'Validade',
      'Diagnóstico de Stock',
    ],
    linhas: rows.map((r) => {
      const vmm = r.vendasQtd / 12;
      const cobertura = vmm > 0 ? r.stock / vmm : r.stock > 0 ? 999 : 0;
      let diagnostico = '✅ Rotação Regular';
      if (r.stock === 0 && r.vendasQtd > 0) diagnostico = '⭕ Esgotado (Tem Procura)';
      else if (r.stock === 0) diagnostico = '⚪ Sem Stock / Sem Venda';
      else if (r.vendasQtd === 0) diagnostico = '🛑 Mono (0 vendas)';
      else if (cobertura > 4) diagnostico = `⚠️ Excesso (${cobertura.toFixed(1)}m cob.)`;

      return {
        cnp: r.cnp,
        valores: [
          r.cnp,
          r.ehGenerico ? '🧬 GENÉRICO MG' : r.tipoVenda,
          r.designacao,
          `${r.stock} un`,
          `${r.vendasQtd} un`,
          `${r.faturacao.toFixed(2)} €`,
          `${r.custo.toFixed(2)} €`,
          `${r.pvp.toFixed(2)} €`,
          `${r.margem.toFixed(1)}%`,
          r.validade || '-',
          diagnostico,
        ],
      };
    }),
    resumoEstrategico:
      (opts.resumo ? opts.resumo + '\n\n' : '') +
      `Totais: ${rows.length} referências | ${totalStock} unidades em stock (${valorStock.toFixed(2)} € a custo) | ${totalVend} unidades vendidas em 12 meses.`,
  };
}

// ============================================================================
// MOTOR LOCAL (SEM IA): conceitos/sinónimos + intenção de stock + AND
// ============================================================================

/** Conceitos com várias formas de escrita no catálogo */
const CONCEPTS: Array<{ detect: RegExp; alternativas: string[]; excluir?: string[] }> = [
  {
    detect: /\b(eau\s*(?:de\s*)?toil+et+e?|edt)\b/,
    alternativas: ['eau de toilette', 'eau toilette', 'edt'],
    excluir: ['thermal', 'termal', 'primalba', 'desmaq'],
  },
  {
    detect: /\b(eau\s*(?:de\s*)?parfums?|edp)\b/,
    alternativas: ['eau de parfum', 'eau parfum', 'edp'],
    excluir: ['thermal', 'termal'],
  },
  {
    detect: /\b(perfumes?|parfums?|fragrancias?|colonias?)\b/,
    alternativas: ['perfum', 'parfum', 'eau de toilette', 'eau toilette', 'eau parfum', 'edt', 'edp', 'colonia', 'agua de colonia'],
    excluir: ['thermal', 'termal', 'perolas', 'citronela', 'antimosquitos', 'pulseira', 'wipes', 'primalba'],
  },
  { detect: /\b(preservativos?)\b/, alternativas: ['preserv', 'durex'] },
  { detect: /\b(protetor(es)? solar(es)?|protector(es)? solar(es)?|solares?)\b/, alternativas: ['solar', 'spf', 'sun'] },
  { detect: /\b(fraldas?)\b/, alternativas: ['fralda'] },
  { detect: /\b(champos?|shampoo)\b/, alternativas: ['champo', 'shampoo', 'champ'] },
  { detect: /\b(pastas? de dentes?|dentifricos?)\b/, alternativas: ['pasta dent', 'dentifric', 'past dent'] },
  { detect: /\b(escovas? de dentes?)\b/, alternativas: ['escova dent', 'esc dent', 'escova'] },
  { detect: /\b(leites? (infantis?|de bebe)|leite em po)\b/, alternativas: ['leite', 'aptamil'] },
];

const LOCAL_STOPWORDS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'por', 'para', 'pra', 'com', 'sem', 'e', 'ou', 'que', 'qual', 'quais', 'quem', 'como', 'quando', 'onde',
  'quanto', 'quantos', 'quanta', 'quantas', 'temos', 'tem', 'tenho', 'ha', 'existe', 'existem',
  'mais', 'menos', 'muito', 'muitos', 'este', 'esta', 'estes', 'estas', 'esse', 'essa',
  'produto', 'produtos', 'artigo', 'artigos', 'referencia', 'referencias',
  'stock', 'stocks', 'existencia', 'existencias', 'inventario', 'armazem', 'loja', 'farmacia',
  'vendido', 'vendidos', 'vendemos', 'vende', 'vendem', 'saida', 'saidas',
  'mostra', 'mostrar', 'lista', 'listar', 'diz', 'dizer', 'ver', 'quero', 'saber', 'agora', 'atualmente', 'momento',
  'margem', 'lucro', 'dinheiro', 'faturacao', 'rentaveis', 'rentavel', 'top', 'melhores', 'maiores',
]);

function singularize(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('oes') || w.endsWith('aes')) return w.slice(0, -3) + 'ao';
  if (w.endsWith('eis')) return w.slice(0, -3) + 'el';
  if (w.endsWith('ais')) return w.slice(0, -3) + 'al';
  if (w.endsWith('res') || w.endsWith('zes') || w.endsWith('ses')) return w.slice(0, -2);
  if (w.endsWith('ns')) return w.slice(0, -2) + 'm';
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function interpretLocalQuestion(question: string): CatalogSearchParams & { termosLegiveis: string[] } {
  let q = ' ' + normalizeText(question) + ' ';
  const grupos: string[][] = [];
  const termosLegiveis: string[] = [];
  const excluir: string[] = [];

  for (const c of CONCEPTS) {
    const m = q.match(c.detect);
    if (m) {
      grupos.push(c.alternativas);
      termosLegiveis.push(m[0].trim());
      if (c.excluir) excluir.push(...c.excluir);
      q = q.replace(c.detect, ' ');
    }
  }

  const words = q.split(' ').filter((w) => w.length > 1 && !LOCAL_STOPWORDS.has(w) && !/^\d+$/.test(w));
  for (const w of words) {
    const s = singularize(w);
    const stem = s.length > 5 ? s.slice(0, -1) : s;
    grupos.push(Array.from(new Set([w, s, stem])));
    termosLegiveis.push(w);
  }

  const nq = normalizeText(question);
  const apenasComStock =
    /\b(em stock|temos|tenho|existencias?|disponive(l|is)|ha em loja|em armazem)\b/.test(nq) &&
    !/\b(sem stock|esgotad|rutura|ruptura)\b/.test(nq);
  const apenasSemStock = /\b(sem stock|esgotad|rutura|ruptura|em falta)\b/.test(nq);

  let ordenar: CatalogSearchParams['ordenar_por'] = apenasComStock ? 'stock' : 'vendas';
  if (/\bmargem|rentav/.test(nq)) ordenar = 'margem';
  else if (/\blucro|dinheiro|fatura/.test(nq)) ordenar = 'lucro';
  else if (/\bmais vendid|vendem mais|mais saida|top\b/.test(nq)) ordenar = 'vendas';

  let segmento: CatalogSearchParams['segmento'] = 'TODOS';
  if (/\bvenda livre|sem receita|otc\b/.test(nq)) segmento = 'SEM_RECEITA';
  else if (/\bgeneric/.test(nq)) segmento = 'GENERICO';
  else if (/\bmnsrm\b/.test(nq)) segmento = 'MNSRM';
  else if (/\bmsrm|com receita\b/.test(nq)) segmento = 'MSRM';

  const numMatch = nq.match(/\btop\s*(\d{1,3})\b|\b(\d{1,3})\s*(produtos|artigos|mais)\b/);
  const limite = numMatch ? parseInt(numMatch[1] || numMatch[2], 10) : 150;

  return {
    grupos_termos: grupos,
    excluir: Array.from(new Set(excluir)),
    apenas_com_stock: apenasComStock,
    apenas_sem_stock: apenasSemStock,
    ordenar_por: ordenar,
    segmento,
    limite,
    termosLegiveis,
  };
}

/**
 * Pesquisa local sem IA: tenta primeiro com TODOS os termos (AND). Se não houver
 * resultados, alarga para QUALQUER termo (OR) e avisa o utilizador.
 */
export async function localSmartSearch(
  prisma: PrismaClient,
  farmaciaId: string,
  question: string,
  sortOverride?: CatalogSearchParams['ordenar_por']
): Promise<CopilotResponse> {
  const items = await getPharmacyCatalog(prisma, farmaciaId);
  const params = interpretLocalQuestion(question);
  if (sortOverride) params.ordenar_por = sortOverride;

  let rows = searchCatalog(items, params);
  let modo = 'todos os termos (correspondência exata por palavra)';

  if (rows.length === 0 && (params.grupos_termos || []).length > 1) {
    const unido = [(params.grupos_termos || []).flat()];
    rows = searchCatalog(items, { ...params, grupos_termos: unido });
    modo = '⚠️ pelo menos um dos termos (não houve artigos com todos os termos)';
  }

  const termos = params.termosLegiveis.join(' + ') || question;
  const filtros: string[] = [];
  if (params.apenas_com_stock) filtros.push('apenas artigos com stock > 0');
  if (params.apenas_sem_stock) filtros.push('apenas artigos sem stock');
  if (params.segmento && params.segmento !== 'TODOS') filtros.push(`segmento ${params.segmento}`);

  return buildProductTableResponse(rows, {
    titulo: `Pesquisa: "${termos}" — ${rows.length} referências${params.apenas_com_stock ? ' com stock' : ''}`,
    explicacao:
      `Motor local (sem IA). Critério: ${modo}` +
      (filtros.length ? `; filtros: ${filtros.join(', ')}` : '') +
      `. Ordenado por ${params.ordenar_por}. Clique num produto para ver o histórico.`,
  });
}
