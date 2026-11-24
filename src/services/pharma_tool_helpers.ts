import { PrismaClient } from '@prisma/client';
import { matchesLabFilter, checkMonthCompletenessD6 } from './copilot_semantic_layer.js';
import { isTherapeuticChronic } from './copilot_chronic_therapies.js';

export { matchesLabFilter, checkMonthCompletenessD6, isTherapeuticChronic };

// ============================================================================
// 1. VOCABULÁRIO FECHADO DE AÇÕES COMERCIAIS (Factos vs Opiniões — v2)
// ============================================================================
export type AcaoComercial =
  | 'REPOR'
  | 'MANTER'
  | 'STOCK_MINIMO'
  | 'TRABALHAR_ENCOMENDA'
  | 'DEVOLVER_EXCESSO'
  | 'DEVOLVER_TUDO'
  | 'TRANSFERIR'
  | 'ESCOAMENTO_BALCAO'
  | 'DESCONTINUAR'
  | 'REVER_DADOS';

export type SituacaoStock =
  | 'RUTURA'
  | 'ABAIXO_MINIMO'
  | 'EQUILIBRADO'
  | 'EXCESSO'
  | 'MONO'
  | 'BAIXA_ROTACAO_SEM_STOCK'
  | 'SEM_STOCK_SEM_VENDAS'
  | 'DADOS_INCOMPLETOS';

export interface ClassificacaoProdutoResult {
  situacao: SituacaoStock;
  acoes_permitidas: AcaoComercial[];
  acao_sugerida: AcaoComercial;
  eh_cronico: boolean;
}

/**
 * Correção 1 (PDF Secção 6):
 * Regra unificada mono / rutura / reposição.
 * - Produtos com 0 vendas (vmm === 0) ou baixa rotação não-crónica (vmm < 1 && !ehCronico)
 *   NUNCA recebem 'REPOR' nem 'RUTURA' — recebem 'TRABALHAR_ENCOMENDA'.
 */
export function classificarProdutoUnificado(params: {
  stock: number;
  vmm: number;
  vendas12m: number;
  diasCobertura: number;
  mesesCobertura: number;
  tipoVenda?: string | null;
  designacao?: string | null;
  dci?: string | null;
  custoUnitario?: number | null;
  pvp?: number | null;
  ehMono?: boolean;
}): ClassificacaoProdutoResult {
  const stock = Number(params.stock || 0);
  const vmm = Number(params.vmm || 0);
  const vendas12m = Number(params.vendas12m || 0);
  const diasCobertura = Number(params.diasCobertura || 0);
  const mesesCobertura = Number(params.mesesCobertura || 0);
  const tipo = String(params.tipoVenda || '').toUpperCase();
  const ehCronico = isTherapeuticChronic(params.dci || null, params.designacao || null);
  const dadosFalta = !(Number(params.pvp || 0) > 0) || !(Number(params.custoUnitario || 0) > 0);

  const addRever = (acoes: AcaoComercial[]): AcaoComercial[] =>
    dadosFalta && !acoes.includes('REVER_DADOS') ? [...acoes, 'REVER_DADOS'] : acoes;

  // 1. Sem stock e sem vendas nos últimos 12M
  if (stock <= 0 && vendas12m <= 0 && vmm <= 0) {
    return {
      situacao: 'SEM_STOCK_SEM_VENDAS',
      acoes_permitidas: addRever(['TRABALHAR_ENCOMENDA', 'DESCONTINUAR']),
      acao_sugerida: 'TRABALHAR_ENCOMENDA',
      eh_cronico: ehCronico,
    };
  }

  // 2. Sem stock com baixa rotação não-crónica (VMM < 1 e não é crónica)
  if (stock <= 0 && vmm < 1 && !ehCronico) {
    return {
      situacao: 'BAIXA_ROTACAO_SEM_STOCK',
      acoes_permitidas: addRever(['TRABALHAR_ENCOMENDA', 'STOCK_MINIMO']),
      acao_sugerida: 'TRABALHAR_ENCOMENDA',
      eh_cronico: ehCronico,
    };
  }

  // 3. Rutura real (stock = 0 e procura relevante ou terapêutica crónica)
  if (stock <= 0 && (vmm >= 1 || (vmm > 0 && ehCronico))) {
    return {
      situacao: 'RUTURA',
      acoes_permitidas: addRever(['REPOR', 'TRANSFERIR']),
      acao_sugerida: 'REPOR',
      eh_cronico: ehCronico,
    };
  }

  // 4. Mono (tem stock mas 0 vendas / marcado como mono)
  if (stock > 0 && (params.ehMono || (vmm <= 0 && vendas12m <= 0))) {
    const isMsrm = tipo.includes('MSRM');
    return {
      situacao: 'MONO',
      acoes_permitidas: addRever(['DEVOLVER_TUDO', 'ESCOAMENTO_BALCAO', 'TRANSFERIR', 'DESCONTINUAR']),
      acao_sugerida: isMsrm ? 'DEVOLVER_TUDO' : 'ESCOAMENTO_BALCAO',
      eh_cronico: ehCronico,
    };
  }

  // 5. Excesso de stock (>= 4 meses de cobertura e >= 3 un)
  if (mesesCobertura >= 4 && stock >= 3) {
    const isMsrm = tipo.includes('MSRM');
    return {
      situacao: 'EXCESSO',
      acoes_permitidas: addRever(['DEVOLVER_EXCESSO', 'ESCOAMENTO_BALCAO', 'TRANSFERIR', 'MANTER']),
      acao_sugerida: isMsrm ? 'DEVOLVER_EXCESSO' : 'ESCOAMENTO_BALCAO',
      eh_cronico: ehCronico,
    };
  }

  // 6. Abaixo do mínimo (< 14 dias de cobertura com procura relevante)
  if (diasCobertura < 14 && (vmm >= 1 || (vmm > 0 && ehCronico))) {
    return {
      situacao: 'ABAIXO_MINIMO',
      acoes_permitidas: addRever(['REPOR', 'STOCK_MINIMO']),
      acao_sugerida: 'REPOR',
      eh_cronico: ehCronico,
    };
  }

  // 7. Equilibrado
  return {
    situacao: 'EQUILIBRADO',
    acoes_permitidas: addRever(['MANTER']),
    acao_sugerida: 'MANTER',
    eh_cronico: ehCronico,
  };
}

// ============================================================================
// 2. CÁLCULO DE IVA, PVP FALLBACK E MARGEM LÍQUIDA EM € (Correções 2, 3 e 4)
// ============================================================================
export interface MargemIvaResult {
  pvp_eur: number | null;
  pvp_origem: 'FARMACIA' | 'PRODUTO_MESTRE' | 'INEXISTENTE';
  taxa_iva_pct: number;
  pvp_sem_iva_eur: number | null;
  custo_unitario_eur: number | null;
  margem_unitaria_eur: number | null;
  margem_pct: number | null;
}

export function inferTaxaIvaPct(taxaIva?: number | null, tipoVenda?: string | null): number {
  const n = Number(taxaIva);
  if (Number.isFinite(n) && n > 0 && n <= 30) return Math.round(n);
  if (Number.isFinite(n) && n > 0 && n < 1) return Math.round(n * 100);
  const t = String(tipoVenda || '').toUpperCase();
  if (t.includes('MSRM') || t.includes('MNSRM')) return 6;
  return 23;
}

export function calcularMargemComIva(params: {
  pvpFarmacia?: number | null;
  pvpMestre?: number | null;
  custoUnitario?: number | null;
  taxaIva?: number | null;
  tipoVenda?: string | null;
}): MargemIvaResult {
  const pvpF = Number(params.pvpFarmacia || 0);
  const pvpM = Number(params.pvpMestre || 0);
  const custo = Number(params.custoUnitario || 0);
  const taxa_iva_pct = inferTaxaIvaPct(params.taxaIva, params.tipoVenda);

  let pvp_eur: number | null = null;
  let pvp_origem: 'FARMACIA' | 'PRODUTO_MESTRE' | 'INEXISTENTE' = 'INEXISTENTE';
  if (pvpF > 0) {
    pvp_eur = Number(pvpF.toFixed(2));
    pvp_origem = 'FARMACIA';
  } else if (pvpM > 0) {
    pvp_eur = Number(pvpM.toFixed(2));
    pvp_origem = 'PRODUTO_MESTRE';
  }

  const pvp_sem_iva_eur =
    pvp_eur !== null ? Number((pvp_eur / (1 + taxa_iva_pct / 100)).toFixed(2)) : null;

  const custo_unitario_eur = custo > 0 ? Number(custo.toFixed(2)) : null;

  let margem_unitaria_eur: number | null = null;
  let margem_pct: number | null = null;
  if (pvp_sem_iva_eur !== null && pvp_sem_iva_eur > 0 && custo_unitario_eur !== null && custo_unitario_eur > 0) {
    margem_unitaria_eur = Number((pvp_sem_iva_eur - custo_unitario_eur).toFixed(2));
    margem_pct = Number((((pvp_sem_iva_eur - custo_unitario_eur) / pvp_sem_iva_eur) * 100).toFixed(1));
  }

  return {
    pvp_eur,
    pvp_origem,
    taxa_iva_pct,
    pvp_sem_iva_eur,
    custo_unitario_eur,
    margem_unitaria_eur,
    margem_pct,
  };
}

// ============================================================================
// 3. DATA REAL DOS DADOS (dados_ate) E AVISO MÊS PARCIAL D6 (Correção 5)
// ============================================================================
export interface DataFreshnessMeta {
  dados_ate: string | null;
  ultimo_mes: string | null;
  mes_parcial: boolean;
  aviso_dados_incompletos: string | null;
}

const freshnessCache = new Map<string, { ts: number; data: DataFreshnessMeta }>();
const FRESHNESS_TTL_MS = 60_000;

export async function getPharmacyDataFreshness(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<DataFreshnessMeta> {
  const cached = freshnessCache.get(farmaciaId);
  if (cached && Date.now() - cached.ts < FRESHNESS_TTL_MS) {
    return cached.data;
  }

  const [maxVenda, maxInv] = await Promise.all([
    prisma.venda.aggregate({
      where: { farmaciaId },
      _max: { data_venda: true },
    }),
    prisma.inventario.aggregate({
      where: { farmaciaId },
      _max: { data_extracao: true },
    }),
  ]);

  const vendaDate = maxVenda._max.data_venda || null;
  const invDate = maxInv._max.data_extracao || null;
  const latestDate =
    vendaDate && invDate ? (vendaDate >= invDate ? vendaDate : invDate) : vendaDate || invDate;

  const dados_ate = vendaDate
    ? vendaDate.toISOString().slice(0, 10)
    : latestDate
    ? latestDate.toISOString().slice(0, 10)
    : null;
  const ultimo_mes = dados_ate ? dados_ate.slice(0, 7) : null;

  let mes_parcial = false;
  let aviso_dados_incompletos: string | null = null;

  if (ultimo_mes) {
    try {
      const d6 = await checkMonthCompletenessD6(prisma, farmaciaId, ultimo_mes);
      if (d6.incompleto) {
        mes_parcial = true;
        aviso_dados_incompletos =
          d6.aviso || `O mês ${ultimo_mes} apresenta dados parciais (vendas registadas até ${dados_ate}).`;
      }
    } catch {
      // fallback simples pelo dia do mês
      if (vendaDate && vendaDate.getUTCDate() < 25) {
        mes_parcial = true;
        aviso_dados_incompletos = `O mês ${ultimo_mes} encontra-se parcial (última venda registada em ${dados_ate}).`;
      }
    }
  }

  const data: DataFreshnessMeta = {
    dados_ate,
    ultimo_mes,
    mes_parcial,
    aviso_dados_incompletos,
  };
  freshnessCache.set(farmaciaId, { ts: Date.now(), data });
  return data;
}

// ============================================================================
// 4. PESQUISA APROXIMADA / FONÉTICA DE NOMES (Correção Rhinodouche b)
// ============================================================================
export function normalizeSearchText(str: string): string {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function compactSearchText(str: string): string {
  return normalizeSearchText(str).replace(/\s+/g, '');
}

/**
 * Normalização fonética leve para português / nomes farmacêuticos:
 * Rino-duche == Rhinodouche == Rhinodouch
 */
export function phoneticPt(str: string): string {
  return compactSearchText(str)
    .replace(/ph/g, 'f')
    .replace(/rh/g, 'r')
    .replace(/th/g, 't')
    .replace(/ch/g, 'x')
    .replace(/sh/g, 'x')
    .replace(/ou/g, 'u')
    .replace(/y/g, 'i')
    .replace(/k/g, 'c')
    .replace(/w/g, 'v')
    .replace(/qu/g, 'c')
    .replace(/h/g, '')
    .replace(/(.)\1+/g, '$1');
}

export function levenshteinDistance(a: string, b: string, maxDist = 2): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb];
}

/**
 * Devolve pontuação de correspondência aproximada entre `query` e `target` (0 = sem match).
 */
export function fuzzyNameMatchScore(query: string, target: string): number {
  const qNorm = normalizeSearchText(query);
  const tNorm = normalizeSearchText(target);
  if (!qNorm || !tNorm) return 0;

  // 1. Match direto normalizado
  if (tNorm === qNorm) return 160;
  if (qNorm.length <= 5) {
    const esc = qNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}`, 'i').test(tNorm)) return 130;
  } else if (tNorm.includes(qNorm)) {
    return 130;
  }

  // 2. Match compacto (ignora hífens e espaços: "rino-duche" vs "rinoduche")
  const qComp = compactSearchText(query);
  const tComp = compactSearchText(target);
  if (qComp.length >= 4 && tComp.includes(qComp)) return 120;

  // 3. Match fonético PT ("rino-duche" -> "rinoduxe", "rhinodouche" -> "rinoduxe")
  const qPhon = phoneticPt(query);
  const tPhon = phoneticPt(target);
  if (qPhon.length >= 4 && tPhon.includes(qPhon)) return 105;

  // 4. Distância de Levenshtein por token (ex: "rhinodouch" vs "rhinodouche", "nurofen" vs "nurofem")
  if (qComp.length >= 5) {
    const maxD = qComp.length >= 8 ? 2 : 1;
    const targetWords = tNorm.split(' ').filter((w) => w.length >= 4);
    for (const w of targetWords) {
      if (levenshteinDistance(qComp, w, maxD) <= maxD) return 90;
      const wPhon = phoneticPt(w);
      if (wPhon.length >= 4 && levenshteinDistance(qPhon, wPhon, maxD) <= maxD) return 85;
    }
  }

  return 0;
}

// ============================================================================
// 5. PAGINAÇÃO CONFIGURÁVEL (Correção 6)
// ============================================================================
export interface PaginatedSlice<T> {
  items: T[];
  paginacao: {
    pagina: number;
    limite: number;
    total: number;
    total_paginas: number;
    tem_mais: boolean;
  };
}

export function paginateItems<T>(
  allItems: T[],
  paginaRaw?: number,
  limiteRaw?: number,
  defaultLimit = 50,
  maxLimit = 200
): PaginatedSlice<T> {
  const limite = Math.max(1, Math.min(Number(limiteRaw) || defaultLimit, maxLimit));
  const pagina = Math.max(1, Math.floor(Number(paginaRaw) || 1));
  const total = allItems.length;
  const total_paginas = Math.max(1, Math.ceil(total / limite));
  const start = (pagina - 1) * limite;
  const items = allItems.slice(start, start + limite);

  return {
    items,
    paginacao: {
      pagina,
      limite,
      total,
      total_paginas,
      tem_mais: start + items.length < total,
    },
  };
}

// ============================================================================
// 6. REGISTO DE RESULTADOS POR REFERÊNCIA (resultado_id -> Tabela Determinística)
// ============================================================================
export interface StoredToolResultEntry {
  resultado_id: string;
  scopeKey: string;
  toolName: string;
  createdAt: number;
  payload: any;
  rows: Record<string, any>[];
}

const toolResultStore = new Map<string, StoredToolResultEntry>();
const RESULT_STORE_TTL_MS = 30 * 60 * 1000; // 30 min
const RESULT_STORE_MAX_ENTRIES = 400;
let resultCounter = 0;

function extractPrimaryRows(payload: any): Record<string, any>[] {
  if (!payload || typeof payload !== 'object') return [];
  const candidateKeys = [
    'artigos',
    'produtos',
    'itens',
    'monos',
    'linhas',
    'propostaEncomenda',
    'artigosVendidosNoDia',
    'evolucaoMensal',
    'topProdutos',
    'paraRepor',
    'travarMono',
    'travarExcesso',
    'campanhasAtivas',
    'tarefas',
  ];
  for (const k of candidateKeys) {
    if (Array.isArray(payload[k]) && payload[k].length > 0 && typeof payload[k][0] === 'object') {
      return payload[k];
    }
  }
  // Fallback: primeiro array de objetos encontrado
  for (const val of Object.values(payload)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      return val as Record<string, any>[];
    }
  }
  return [];
}

export function storeToolResult(
  scopeKey: string,
  toolName: string,
  payload: any
): string {
  // Limpeza básica de expirados
  const now = Date.now();
  if (toolResultStore.size > RESULT_STORE_MAX_ENTRIES) {
    for (const [k, v] of toolResultStore.entries()) {
      if (now - v.createdAt > RESULT_STORE_TTL_MS) {
        toolResultStore.delete(k);
      }
    }
    while (toolResultStore.size > RESULT_STORE_MAX_ENTRIES) {
      const oldestKey = toolResultStore.keys().next().value;
      if (oldestKey) toolResultStore.delete(oldestKey);
      else break;
    }
  }

  resultCounter = (resultCounter + 1) % 999999;
  const resultado_id = `res_${toolName.slice(0, 14).replace(/[^a-z0-9_]/gi, '')}_${Date.now().toString(36).slice(-4)}_${resultCounter}`;
  const rows = extractPrimaryRows(payload);

  toolResultStore.set(resultado_id, {
    resultado_id,
    scopeKey,
    toolName,
    createdAt: now,
    payload,
    rows,
  });

  return resultado_id;
}

export function getStoredToolResult(
  scopeKey: string,
  resultadoId: string
): StoredToolResultEntry | null {
  const entry = toolResultStore.get(resultadoId);
  if (!entry) return null;
  if (entry.scopeKey !== scopeKey) return null; // Isolamento multi-tenant rigoroso
  if (Date.now() - entry.createdAt > RESULT_STORE_TTL_MS) {
    toolResultStore.delete(resultadoId);
    return null;
  }
  return entry;
}

export interface TabelaSpec {
  resultado_id: string;
  titulo?: string;
  colunas?: string[];
  filtro?: { campo: string; valor: string };
  ordenar?: { campo: string; direcao?: 'asc' | 'desc' };
  limite?: number;
}

export function renderMarkdownTableFromStoredResult(
  scopeKey: string,
  spec: TabelaSpec
): { ok: boolean; markdown: string; rowCount: number; error?: string } {
  const entry = getStoredToolResult(scopeKey, spec.resultado_id);
  if (!entry) {
    return {
      ok: false,
      markdown: '',
      rowCount: 0,
      error: `resultado_id "${spec.resultado_id}" não encontrado ou expirado.`,
    };
  }

  let rows = [...entry.rows];
  if (rows.length === 0) {
    return {
      ok: true,
      markdown: spec.titulo ? `**${spec.titulo}**\n\n_Sem registos para apresentar._` : '_Sem registos para apresentar._',
      rowCount: 0,
    };
  }

  if (spec.filtro && spec.filtro.campo && spec.filtro.valor !== undefined) {
    const targetVal = normalizeSearchText(String(spec.filtro.valor));
    rows = rows.filter((r) => normalizeSearchText(String(r[spec.filtro!.campo] ?? '')).includes(targetVal));
  }

  if (spec.ordenar && spec.ordenar.campo) {
    const campo = spec.ordenar.campo;
    const dir = spec.ordenar.direcao === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const va = a[campo];
      const vb = b[campo];
      const na = Number(va);
      const nb = Number(vb);
      if (Number.isFinite(na) && Number.isFinite(nb)) return (na - nb) * dir;
      return String(va ?? '').localeCompare(String(vb ?? ''), 'pt') * dir;
    });
  }

  const maxRows = Math.max(1, Math.min(spec.limite || 50, 100));
  const sliced = rows.slice(0, maxRows);

  const availableKeys = Object.keys(sliced[0] || {});
  const cols =
    spec.colunas && spec.colunas.length > 0
      ? spec.colunas.filter((c) => availableKeys.includes(c))
      : availableKeys.slice(0, 8);
  const finalCols = cols.length > 0 ? cols : availableKeys.slice(0, 6);

  const fmtCell = (val: any): string => {
    if (val === null || val === undefined) return '—';
    if (Array.isArray(val)) return val.join(', ');
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val).replace(/\|/g, '/').replace(/\n/g, ' ');
  };

  const header = `| ${finalCols.join(' | ')} |`;
  const sep = `| ${finalCols.map(() => '---').join(' | ')} |`;
  const body = sliced.map((r) => `| ${finalCols.map((c) => fmtCell(r[c])).join(' | ')} |`).join('\n');
  const titleLine = spec.titulo ? `### ${spec.titulo}\n\n` : '';
  const footer = rows.length > sliced.length ? `\n\n_Mostrando ${sliced.length} de ${rows.length} registos._` : '';

  return {
    ok: true,
    markdown: `${titleLine}${header}\n${sep}\n${body}${footer}`,
    rowCount: sliced.length,
  };
}
