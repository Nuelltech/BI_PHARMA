/**
 * comercial.ts — sugerir_vendas_cruzadas + sugerir_packs_promocionais (100% determinístico)
 *
 * Princípios:
 *  - O modelo NUNCA decide elegibilidade, ordem, preço, época nem campanhas: tudo aqui.
 *  - Falha segura: tag DESCONHECIDA conta como bloqueio; qualidade insuficiente exclui.
 *  - A data vem sempre de ctx.ref (UTC, 'YYYY-MM-DD' já convertido de Europe/Lisbon pelo chamador).
 */

import crypto from 'crypto';

// ───────────────────────────── Tipos ─────────────────────────────
export type Epoca = 'DENTRO' | 'NEUTRO' | 'FORA';
export type Janela = 'EM_EPOCA' | 'PROXIMA' | 'FORA';
export type Papel = 'PRINCIPAL' | 'COMPLEMENTAR' | 'HIGIENE_BARREIRA';
export type Publico = 'ADULTO' | 'PEDIATRICO' | 'TODOS' | 'NAO_CLASSIFICADO';

export const QUALIDADE_OK = new Set(['OFICIAL', 'MNSRM_CONFIRMADO_DT', 'VALIDADO_REGRA', 'VALIDADO_PRODUTO']);

export interface Cand {
  cnp_codigo: string;
  designacao: string;
  categoria_id: string;
  subcategoria_id: string;
  finalidade_curta: string;
  papel_cesto: Papel;
  publico: Publico;
  precisa_receita: boolean;
  permite_marketing: boolean;
  permite_desconto_promo: boolean;
  uso_veterinario: boolean;
  qualidade_classificacao: string;
  tags_presentes: string[]; // SIM
  tags_desconhecidas: string[]; // DESCONHECIDO (inclui o fail-safe de produtos sem DCI)
  stock_total_unidades: number;
  pvp: number; // com IVA
  custo_unitario_medio: number; // sem IVA
  taxa_iva: number; // 6 | 23
  margem_pct: number;
  eh_risco_caducidade: boolean;
  data_validade_mais_proxima: string | null;
  meses_ate_validade: number | null;
  eh_mono: boolean;
  dias_sem_vendas: number | null;
  eh_excesso_cobertura: boolean;
  cobertura_meses: number | null;
  eh_resto_gaveta: boolean;
  regra_id?: string;
}

export interface Calendario {
  campanha_id: string;
  titulo: string;
  meses_alvo: number[];
  dias_especiais: string[]; // 'MM-DD' (anual)
  tipo: 'EPOCA_CALENDARIO' | 'LIQUIDACAO_STOCK';
  desconto_sugerido_pct: number;
  antecedencia_dias: number;
}

export interface CampanhaAtivaRow {
  id: string;
  cnps: string[];
  descontoAplicadoPct: number;
  dataInicio: string; // YYYY-MM-DD
  dataFim: string;
  estado: string;
}

export interface Regra {
  id: string;
  condicao_aplicacao: string;
  exige_publico: boolean;
  restricoes_bloqueio_extra: string[];
  validada_por?: string | null;
}

export type GatilhoRes =
  | { ok: true; tipo: 'cnp' | 'familia' | 'queixa'; id: string; nome?: string; familias: string[]; dci: string[]; publico_inferido: Publico | null }
  | { ok: false; codigo: 'GATILHO_NAO_RESOLVIDO'; sugestoes?: string[] };

export interface Repo {
  resolverGatilho(g: { tipo: string; valor: string }): Promise<GatilhoRes>;
  regrasAtivas(g: Extract<GatilhoRes, { ok: true }>): Promise<Regra[]>; // ativa AND validada_por NOT NULL
  candidatosPorRegras(ids: string[]): Promise<Cand[]>;
  candidatosPorCampanha(campanhaId: string): Promise<Cand[]>;
  calendario(): Promise<Calendario[]>;
  epocaSubcategoria(): Promise<Record<string, number[] | null>>;
  campanhasAtivas(): Promise<CampanhaAtivaRow[]>;
  store(payload: unknown): string; // ToolResultStore -> result_id
}

export interface Cfg {
  familiaPermiteGatilho: Record<string, boolean>;
  familiaRestricao: Record<string, string[]>;
  dciRestricaoExtra: Record<string, string[]>;
  condicaoRestricao: Record<string, string[]>; // só memória de sessão (RGPD)
  minProdutosTema: number;
}

export interface Ctx {
  repo: Repo;
  ref: Date; // UTC
  cfg: Cfg;
}

// ───────────────────────────── Datas e época ─────────────────────────────
export const parseDia = (s: string) => new Date(`${s}T00:00:00Z`);
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
const mes = (d: Date) => d.getUTCMonth() + 1;
const mmdd = (d: Date) => d.toISOString().slice(5, 10);
const addDias = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export const emEpoca = (c: Pick<Calendario, 'meses_alvo' | 'dias_especiais'>, d: Date) =>
  c.meses_alvo.includes(mes(d)) || c.dias_especiais.includes(mmdd(d));

export function janela(c: Calendario, ref: Date): Janela {
  if (emEpoca(c, ref)) return 'EM_EPOCA';
  for (let i = 1; i <= c.antecedencia_dias; i++) if (emEpoca(c, addDias(ref, i))) return 'PROXIMA';
  return 'FORA';
}

export function epocaFit(subcategoria: string, ref: Date, mapa: Record<string, number[] | null>): Epoca {
  const m = mapa[subcategoria];
  if (m == null) return 'NEUTRO';
  return m.includes(mes(ref)) ? 'DENTRO' : 'FORA';
}

// ───────────────────────────── Preço (anti-dumping) ─────────────────────────────
const cents = (x: number) => Math.round(x * 100);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Margem mínima 5% sobre o preço SEM IVA; custo sem IVA; PVP com IVA. */
export const pvpMinCents = (custo: number, iva: number) => Math.ceil((cents(custo) / 0.95) * (1 + iva / 100) - 1e-6);

export type PrecoRes =
  | { excluir: 'MARGEM_INSUFICIENTE_NO_PVP' }
  | { preco: number; limitado_por_regra_legal: boolean; desconto_efetivo_pct: number; margem_pct_promo: number };

export function precoPromo(p: Pick<Cand, 'pvp' | 'custo_unitario_medio' | 'taxa_iva'>, descPct: number): PrecoRes {
  const min = pvpMinCents(p.custo_unitario_medio, p.taxa_iva);
  if (cents(p.pvp) < min) return { excluir: 'MARGEM_INSUFICIENTE_NO_PVP' };
  const desejado = Math.round(cents(p.pvp) * (1 - descPct / 100));
  const preco = Math.max(desejado, min);
  const semIva = preco / (1 + p.taxa_iva / 100);
  return {
    preco: preco / 100,
    limitado_por_regra_legal: desejado < min,
    desconto_efetivo_pct: r1(100 * (1 - preco / cents(p.pvp))),
    margem_pct_promo: r1((100 * (semIva - cents(p.custo_unitario_medio))) / semIva),
  };
}

// ───────────────────────────── Enriquecimento e ordenação ─────────────────────────────
export interface Enriquecido extends Cand {
  epoca_fit: Epoca;
  em_campanha_ativa: boolean;
  campanha_ativa_id: string | null;
  pvp_promo: number | null;
  pvp_promo_fonte: 'CampanhaAtiva' | null;
  alerta_legal: 'CAMPANHA_ABAIXO_MINIMO' | null;
}

export function enriquecer(c: Cand, ref: Date, epoca: Record<string, number[] | null>, ativas: CampanhaAtivaRow[]): Enriquecido {
  const hoje = ymd(ref);
  const ca = ativas.find((a) => a.estado === 'ATIVA' && a.dataInicio <= hoje && hoje <= a.dataFim && a.cnps.includes(c.cnp_codigo));
  const pvpPromo = ca ? r2(c.pvp * (1 - ca.descontoAplicadoPct / 100)) : null;
  return {
    ...c,
    epoca_fit: epocaFit(c.subcategoria_id, ref, epoca),
    em_campanha_ativa: !!ca,
    campanha_ativa_id: ca?.id ?? null,
    pvp_promo: pvpPromo,
    pvp_promo_fonte: ca ? 'CampanhaAtiva' : null,
    alerta_legal: pvpPromo != null && cents(pvpPromo) < pvpMinCents(c.custo_unitario_medio, c.taxa_iva) ? 'CAMPANHA_ABAIXO_MINIMO' : null,
  };
}

export type Chave = 'caducidade' | 'validade' | 'mono' | 'excesso' | 'campanha' | 'epoca' | 'margem';
/** Ordem de escoamento sem receita. Alterar só aqui. */
export const ORDEM_ESCOAMENTO: Chave[] = ['caducidade', 'validade', 'mono', 'excesso', 'campanha', 'epoca', 'margem'];

const K: Record<Chave, (p: Enriquecido) => number> = {
  caducidade: (p) => (p.eh_risco_caducidade ? 0 : 1),
  validade: (p) => (p.eh_risco_caducidade && p.data_validade_mais_proxima ? Date.parse(p.data_validade_mais_proxima) : Number.MAX_SAFE_INTEGER),
  mono: (p) => (p.eh_mono ? 0 : 1),
  excesso: (p) => (p.eh_excesso_cobertura ? 0 : 1),
  campanha: (p) => (p.em_campanha_ativa ? 0 : 1),
  epoca: (p) => ({ DENTRO: 0, NEUTRO: 1, FORA: 2 })[p.epoca_fit],
  margem: (p) => -p.margem_pct,
};

export function comparar(a: Enriquecido, b: Enriquecido): number {
  for (const k of ORDEM_ESCOAMENTO) {
    const x = K[k](a);
    const y = K[k](b);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.cnp_codigo.localeCompare(b.cnp_codigo);
}

export function situacao(c: Cand): [string, number | null] {
  if (c.eh_risco_caducidade) return ['RISCO_CADUCIDADE', c.meses_ate_validade];
  if (c.eh_mono) return ['MONO', c.dias_sem_vendas];
  if (c.eh_excesso_cobertura) return ['EXCESSO_COBERTURA', c.cobertura_meses];
  if (c.eh_resto_gaveta) return ['RESTO_GAVETA', c.stock_total_unidades];
  return ['NORMAL', null];
}

// ───────────────────────────── Filtros de segurança ─────────────────────────────
/**
 * Regra de compatibilidade de público com salvaguardas clínicas estritas:
 * - Num cesto PEDIATRICO: APENAS artigos explicitamente PEDIATRICO são admitidos.
 * - Num cesto ADULTO: artigos ADULTO e TODOS validados são admitidos; PEDIATRICO é estritamente PROIBIDO.
 * - Num cesto TODOS: apenas itens de público universal TODOS são admitidos.
 * - Artigos NAO_CLASSIFICADO são rejeitados de qualquer cesto.
 */
export const compatCesto = (item: Publico, cesto: Publico) => {
  if (item === 'NAO_CLASSIFICADO') return false;
  if (cesto === 'PEDIATRICO') return item === 'PEDIATRICO';
  if (cesto === 'ADULTO') return item === 'ADULTO' || item === 'TODOS';
  return item === 'TODOS';
};

export const DCI_FAMILIAS_SENSIVEIS = new Set([
  'pantoprazol',
  'omeprazol',
  'esomeprazol',
  'lansoprazol',
  'rabeprazol',
  'alprazolam',
  'diazepam',
  'lorazepam',
  'bromazepam',
  'oxazepam',
  'clotiazepam',
  'zolpidem',
]);

export function ehFamiliaSensivel(item: { designacao?: string; dci?: string[] }): boolean {
  const normDesig = norm(item.designacao || '');
  if (/\b(pantoprazol|omeprazol|esomeprazol|lansoprazol|rabeprazol)\b/i.test(normDesig)) return true;
  if (item.dci && item.dci.some((d) => DCI_FAMILIAS_SENSIVEIS.has(norm(d)))) return true;
  return false;
}

export function verificarIncompatibilidadesCesto(itens: { designacao: string; categoria_id?: string; subcategoria_id?: string }[]): string[] {
  const violacoes: string[] = [];
  const textJoined = norm(itens.map((i) => `${i.designacao} ${i.categoria_id || ''} ${i.subcategoria_id || ''}`).join(' '));

  const hasIbp = /\b(pantoprazol|omeprazol|esomeprazol|lansoprazol|rabeprazol)\b/i.test(textJoined);
  const hasLaxante = /laxant|sollievo|transilax|dulcolax|microlax|fisiolax|senne/i.test(textJoined);
  const hasAntidiarreico = /antidiarreico|imodium|loperamida|racecadotril/i.test(textJoined);
  const hasSedativo = /sono|melatonina|valeriana|passiflora/i.test(textJoined);
  const hasEstimulante = /cafeina|ginseng|taurina/i.test(textJoined);

  if (hasIbp && hasLaxante) violacoes.push('INCOMPATIBILIDADE_CLINICA:IBP_X_LAXANTE');
  if (hasAntidiarreico && hasLaxante) violacoes.push('INCOMPATIBILIDADE_CLINICA:ANTIDIARREICO_X_LAXANTE');
  if (hasSedativo && hasEstimulante) violacoes.push('INCOMPATIBILIDADE_CLINICA:SEDATIVO_X_ESTIMULANTE');

  return violacoes;
}

export interface Exclusoes {
  nao_elegivel_legal: number;
  sem_stock: number;
  qualidade_insuficiente: number;
  sem_permissao_desconto: number;
  publico_incompativel: number;
  restricao_bloqueada: number;
  restricao_desconhecida: number;
}

export function filtrar(cand: Cand[], o: { publico: Publico | null; bloqueios: Set<string>; exigirDesconto: boolean }) {
  const ex: Exclusoes = {
    nao_elegivel_legal: 0,
    sem_stock: 0,
    qualidade_insuficiente: 0,
    sem_permissao_desconto: 0,
    publico_incompativel: 0,
    restricao_bloqueada: 0,
    restricao_desconhecida: 0,
  };
  const ok = cand.filter((c) => {
    // defesa em profundidade: a SQL já filtra, mas a ferramenta nunca confia
    if (c.precisa_receita || !c.permite_marketing || c.uso_veterinario) return ex.nao_elegivel_legal++, false;
    if (c.stock_total_unidades <= 0) return ex.sem_stock++, false;
    if (!QUALIDADE_OK.has(c.qualidade_classificacao)) return ex.qualidade_insuficiente++, false;
    if (o.exigirDesconto && !c.permite_desconto_promo) return ex.sem_permissao_desconto++, false;
    if (o.publico && !compatCesto(c.publico, o.publico)) return ex.publico_incompativel++, false;
    if (c.tags_presentes.some((t) => o.bloqueios.has(t))) return ex.restricao_bloqueada++, false;
    if (c.tags_desconhecidas.some((t) => o.bloqueios.has(t))) return ex.restricao_desconhecida++, false;
    return true;
  });
  return { ok, ex };
}

// ───────────────────────────── Envelope ─────────────────────────────
function envelope(repo: Repo, ferramenta: string, meta: Record<string, unknown>, colunas: string[], linhas: unknown[][], extra: Record<string, unknown> = {}) {
  const payload = { ok: true as const, ferramenta, meta, colunas, linhas, ...extra };
  return { ...payload, result_id: repo.store(payload) };
}
const erro = (codigo: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, erro: { codigo, ...extra } });
const vazio = (ctx: Ctx, ferramenta: string, motivo: string, extra: Record<string, unknown> = {}) =>
  envelope(ctx.repo, ferramenta, { motivo, n_linhas_total: 0, truncado: false, data_referencia: ymd(ctx.ref), ...extra }, [], []);

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ───────────────────────────── sugerir_vendas_cruzadas ─────────────────────────────
export interface CruzadasIn {
  gatilho: { tipo: 'cnp' | 'familia' | 'queixa' | 'texto'; valor: string };
  publico?: Publico | null;
  condicoes_cliente?: string[];
  limite?: number;
}

export const COLUNAS_CRUZADAS = [
  'ordem_escoamento', 'cnp_codigo', 'designacao', 'subcategoria_id', 'finalidade_curta', 'papel_cesto', 'publico',
  'stock_total_unidades', 'situacao_codigo', 'situacao_valor', 'pvp', 'pvp_promo', 'em_campanha_ativa', 'campanha_ativa_id',
  'epoca_fit', 'alerta_legal', 'margem_pct', 'regra_id', 'qualidade_classificacao',
];

export async function sugerirVendasCruzadas(inp: CruzadasIn, ctx: Ctx) {
  const { repo, ref, cfg } = ctx;
  const F = 'sugerir_vendas_cruzadas';

  const g = await repo.resolverGatilho(inp.gatilho);
  if (!g.ok) return erro(g.codigo, { sugestoes: g.sugestoes ?? [] });
  if (g.tipo === 'cnp' && (g.familias.length === 0 || g.familias.includes('OUTROS_RX'))) return erro('FAMILIA_NAO_CATALOGADA');
  if (g.familias.some((f) => cfg.familiaPermiteGatilho[f] === false)) return erro('GATILHO_NAO_PERMITIDO');

  const bloqueios = new Set<string>([
    ...g.familias.flatMap((f) => cfg.familiaRestricao[f] ?? []),
    ...g.dci.flatMap((d) => cfg.dciRestricaoExtra[d] ?? []),
    ...(inp.condicoes_cliente ?? []).flatMap((c) => cfg.condicaoRestricao[c] ?? []),
  ]);

  const regras = await repo.regrasAtivas(g);
  if (!regras.length) return vazio(ctx, F, 'SEM_REGRA_VALIDADA', { gatilho_resolvido: g });
  regras.forEach((r) => r.restricoes_bloqueio_extra.forEach((t) => bloqueios.add(t)));

  const publico: Publico | null = inp.publico && inp.publico !== 'TODOS' ? inp.publico : g.publico_inferido;
  if (!publico && regras.some((r) => r.exige_publico)) return vazio(ctx, F, 'PUBLICO_NECESSARIO', { publico_necessario: true, gatilho_resolvido: g });

  // candidatos: um CNP pode vir de várias regras -> fica a de maior prioridade (ordem em `regras`)
  const rank = (id?: string) => regras.findIndex((r) => r.id === id);
  const bruto = (await repo.candidatosPorRegras(regras.map((r) => r.id))).sort((a, b) => rank(a.regra_id) - rank(b.regra_id));
  const vistos = new Set<string>();
  const unicos = bruto.filter((c) => !vistos.has(c.cnp_codigo) && !!vistos.add(c.cnp_codigo)); // fica a 1.ª (maior prioridade)

  const { ok, ex } = filtrar(unicos, { publico, bloqueios, exigirDesconto: false });
  const [epoca, ativas] = await Promise.all([repo.epocaSubcategoria(), repo.campanhasAtivas()]);
  const ordenados = ok.map((c) => enriquecer(c, ref, epoca, ativas)).sort(comparar); // época NUNCA elimina aqui
  const limite = inp.limite ?? 5;

  const linhas = ordenados.slice(0, limite).map((c, i) => {
    const [sc, sv] = situacao(c);
    return [i + 1, c.cnp_codigo, c.designacao, c.subcategoria_id, c.finalidade_curta, c.papel_cesto, c.publico, c.stock_total_unidades,
      sc, sv, c.pvp, c.pvp_promo, c.em_campanha_ativa, c.campanha_ativa_id, c.epoca_fit, c.alerta_legal, c.margem_pct, c.regra_id ?? null, c.qualidade_classificacao];
  });

  return envelope(repo, F, {
    gatilho_resolvido: g,
    publico_necessario: false,
    publico_aplicado: publico,
    regras_aplicadas: regras.map((r) => ({ id: r.id, condicao_aplicacao: r.condicao_aplicacao })),
    restricoes_ativas: [...bloqueios],
    excluidos_resumo: ex,
    data_referencia: ymd(ref),
    campanhas_ativas_consideradas: ativas.filter((a) => a.estado === 'ATIVA' && a.dataInicio <= ymd(ref) && ymd(ref) <= a.dataFim).length,
    motivo: ordenados.length ? null : 'SEM_CANDIDATOS_ELEGIVEIS',
    n_linhas_total: ordenados.length,
    truncado: ordenados.length > limite,
  }, COLUNAS_CRUZADAS, linhas);
}

// ───────────────────────────── sugerir_packs_promocionais ─────────────────────────────
export interface PacksIn {
  modo: 'TEMAS' | 'PACK';
  campanha_id?: string;
  tema?: string;
  desconto_pct?: number;
  publico?: Publico | null;
  n_produtos_max?: number;
  incluir_em_campanha?: boolean; // por omissão false: não empilhar descontos
  incluir_preco_fixo?: boolean; // por omissão false: só produtos com permite_desconto_promo
  liquidacao?: boolean; // só válido se o router detetou pedido explícito de liquidação
  data_referencia?: string; // YYYY-MM-DD (planeamento)
  min_stock_por_item?: number; // por omissão: 3 para pack de campanha física; 1 para cross-selling verbal
  tipo_oferta?: 'PACK_FISICO' | 'CROSS_SELL_ATENDIMENTO' | 'ESCOAMENTO_ISOLADO';
}

export interface ItemPack extends Enriquecido {
  preco_promo: number;
  desconto_efetivo_pct: number;
  margem_pct_promo: number;
  limitado_por_regra_legal: boolean;
}

const MIN_ITENS_PACK = 2;

export function computePackCompositionHash(
  cnps: string[],
  publico: string,
  descontoPct: number
): string {
  const sorted = [...cnps].sort().join(',');
  return crypto.createHash('sha256').update(`${sorted}:${publico}:${descontoPct}`).digest('hex');
}

export function validarCesto(itens: ItemPack[], publico: Publico, opts: { minStock?: number } = {}) {
  const minStock = opts.minStock ?? 3;
  const violacoes: string[] = [];
  for (const i of itens) {
    if (i.precisa_receita) violacoes.push(`MSRM:${i.cnp_codigo}`);
    if (i.uso_veterinario) violacoes.push(`VETERINARIO:${i.cnp_codigo}`);
    if (!QUALIDADE_OK.has(i.qualidade_classificacao)) violacoes.push(`QUALIDADE:${i.cnp_codigo}`);
    if (cents(i.preco_promo) < pvpMinCents(i.custo_unitario_medio, i.taxa_iva)) violacoes.push(`ABAIXO_MINIMO:${i.cnp_codigo}`);
    if (!compatCesto(i.publico, publico)) violacoes.push(`PUBLICO:${i.cnp_codigo}`);
    if (i.stock_total_unidades < minStock) violacoes.push(`STOCK_INSUFICIENTE:${i.cnp_codigo}`);
    if (ehFamiliaSensivel(i)) violacoes.push(`FAMILIA_SENSIVEL:${i.cnp_codigo}`);
  }
  if (!itens.some((i) => i.papel_cesto === 'PRINCIPAL')) violacoes.push('SEM_PRINCIPAL');

  const incomp = verificarIncompatibilidadesCesto(itens);
  if (incomp.length > 0) {
    violacoes.push(...incomp);
  }

  return { ok: violacoes.length === 0, violacoes };
}

function precificar(x: Enriquecido, descPct: number): ItemPack | null {
  const r = precoPromo(x, x.permite_desconto_promo ? descPct : 0);
  if ('excluir' in r) return null;
  return { ...x, preco_promo: r.preco, desconto_efetivo_pct: r.desconto_efetivo_pct, margem_pct_promo: r.margem_pct_promo, limitado_por_regra_legal: r.limitado_por_regra_legal };
}

export const COLUNAS_PACK = [
  'cnp_codigo', 'designacao', 'finalidade_curta', 'papel_cesto', 'publico', 'stock_total_unidades', 'situacao_codigo', 'situacao_valor',
  'epoca_fit', 'pvp', 'preco_promo', 'desconto_efetivo_pct', 'margem_pct_promo', 'limitado_por_regra_legal',
];

export async function sugerirPacksPromocionais(inp: PacksIn, ctx: Ctx) {
  const { repo, cfg } = ctx;
  const F = 'sugerir_packs_promocionais';
  const ref = inp.data_referencia ? parseDia(inp.data_referencia) : ctx.ref;
  const cx: Ctx = { ...ctx, ref };
  const [cal, epoca, ativas] = await Promise.all([repo.calendario(), repo.epocaSubcategoria(), repo.campanhasAtivas()]);
  const emVigor = (a: CampanhaAtivaRow) => a.estado === 'ATIVA' && a.dataInicio <= ymd(ref) && ymd(ref) <= a.dataFim;
  const metaBase = { data_referencia: ymd(ref), campanhas_ativas_consideradas: ativas.filter(emVigor).length };
  const exigirDesconto = !inp.incluir_preco_fixo;

  // ── Modo TEMAS: que campanhas lançar agora? (devolve temas, não cestos)
  if (inp.modo === 'TEMAS') {
    const linhas: unknown[][] = [];
    const ordem: { j: Janela; urg: number; l: unknown[] }[] = [];
    let foraEpoca = 0;
    let poucos = 0;
    for (const c of cal) {
      const j = janela(c, ref);
      if (j === 'FORA' && !inp.liquidacao) { foraEpoca++; continue; }
      const { ok } = filtrar(await repo.candidatosPorCampanha(c.campanha_id), { publico: inp.publico ?? null, bloqueios: new Set(), exigirDesconto });
      const enr = ok
        .map((x) => enriquecer(x, ref, epoca, ativas))
        .filter((x) => c.tipo === 'LIQUIDACAO_STOCK' || inp.liquidacao || x.epoca_fit !== 'FORA');
      const urg = enr.filter((x) => x.eh_risco_caducidade || x.eh_mono || x.eh_excesso_cobertura);
      if (enr.length < cfg.minProdutosTema || (j === 'FORA' && urg.length === 0)) { poucos++; continue; }
      ordem.push({
        j, urg: urg.length,
        l: [c.campanha_id, c.titulo, j, c.tipo, enr.length, urg.length, r2(enr.reduce((s, x) => s + x.stock_total_unidades * x.custo_unitario_medio, 0)), c.desconto_sugerido_pct],
      });
    }
    ordem.sort((a, b) => (a.j === b.j ? b.urg - a.urg : a.j === 'EM_EPOCA' ? -1 : b.j === 'EM_EPOCA' ? 1 : 0));
    ordem.forEach((o) => linhas.push(o.l));
    return envelope(repo, F, {
      ...metaBase, modo: 'TEMAS',
      excluidos_resumo: { temas_fora_de_epoca: foraEpoca, sem_produtos_suficientes: poucos },
      temas_fora_de_epoca: foraEpoca, n_linhas_total: linhas.length, truncado: false,
    }, ['campanha_id', 'titulo', 'janela', 'tipo', 'n_produtos_elegiveis', 'n_urgentes', 'valor_stock_custo', 'desconto_sugerido_pct'], linhas);
  }

  // ── Modo PACK: constrói o cesto
  const camp = inp.campanha_id
    ? cal.find((c) => c.campanha_id === inp.campanha_id)
    : inp.tema
      ? cal.find((c) => norm(c.titulo).includes(norm(inp.tema!)) || norm(inp.tema!).includes(norm(c.titulo)))
      : undefined;
  if (!camp) return erro('TEMA_NAO_RESOLVIDO', { sugestoes: cal.slice(0, 5).map((c) => c.titulo) });

  const j = janela(camp, ref);
  const liquidacao = inp.liquidacao === true || camp.tipo === 'LIQUIDACAO_STOCK';
  if (j === 'FORA' && !liquidacao) return erro('TEMA_FORA_DE_EPOCA', { janela: j, data_referencia: ymd(ref) });

  const bruto = await repo.candidatosPorCampanha(camp.campanha_id);
  const { ok, ex } = filtrar(bruto, { publico: null, bloqueios: new Set(), exigirDesconto });
  let enr = ok.map((x) => enriquecer(x, ref, epoca, ativas));
  const exFinal: Record<string, number> = { ...ex, fora_de_epoca: 0, em_campanha_ativa: 0 };
  if (!liquidacao) {
    const antes = enr.length;
    enr = enr.filter((x) => x.epoca_fit !== 'FORA');
    exFinal.fora_de_epoca = antes - enr.length;
  }
  const conflitoCampanha: { cnp: string; campanha_ativa_id: string | null }[] = [];
  if (!inp.incluir_em_campanha) {
    enr = enr.filter((x) => {
      if (!x.em_campanha_ativa) return true;
      conflitoCampanha.push({ cnp: x.cnp_codigo, campanha_ativa_id: x.campanha_ativa_id });
      exFinal.em_campanha_ativa++;
      return false;
    });
  }
  enr.sort(comparar);

  // público do cesto: ADULTO e PEDIATRICO nunca se misturam
  let publico: Publico;
  if (inp.publico) publico = inp.publico;
  else {
    const ps = new Set(enr.filter((x) => x.papel_cesto === 'PRINCIPAL' && x.publico !== 'TODOS').map((x) => x.publico));
    if (ps.size > 1) return vazio(cx, F, 'PUBLICO_NECESSARIO', { publico_necessario: true, ...metaBase });
    publico = ps.size === 1 ? [...ps][0] : 'TODOS';
  }

  const minStock = inp.min_stock_por_item !== undefined
    ? inp.min_stock_por_item
    : (inp.tipo_oferta === 'CROSS_SELL_ATENDIMENTO' || inp.liquidacao ? 1 : 3);
  const pool = enr.filter((x) => compatCesto(x.publico, publico) && x.stock_total_unidades >= minStock);
  const desc = inp.desconto_pct ?? camp.desconto_sugerido_pct;
  const nMax = inp.n_produtos_max ?? 4;

  for (const principal of pool.filter((x) => x.papel_cesto === 'PRINCIPAL').slice(0, 5)) {
    const base = precificar(principal, desc);
    if (!base) continue;
    const itens: ItemPack[] = [base];
    const subs = new Set([principal.subcategoria_id]);
    for (const x of pool) {
      if (itens.length >= nMax) break;
      if (x.papel_cesto === 'PRINCIPAL' || subs.has(x.subcategoria_id)) continue;
      const it = precificar(x, desc);
      if (it) { itens.push(it); subs.add(x.subcategoria_id); }
    }
    if (itens.length < MIN_ITENS_PACK) continue;

    const val = validarCesto(itens, publico, { minStock });
    if (!val.ok) continue; // nunca devolve um cesto que não passe na validação

    const packsMontaveis = Math.min(...itens.map((i) => Math.floor(i.stock_total_unidades)));
    if (packsMontaveis < minStock && inp.tipo_oferta !== 'CROSS_SELL_ATENDIMENTO') continue;

    const hashComposicao = computePackCompositionHash(
      itens.map((i) => i.cnp_codigo),
      publico,
      desc
    );

    const receitaSemIva = itens.reduce((s, i) => s + cents(i.preco_promo) / (1 + i.taxa_iva / 100), 0);
    const custo = itens.reduce((s, i) => s + cents(i.custo_unitario_medio), 0);
    const totais = {
      pvp_cesto: r2(itens.reduce((s, i) => s + i.pvp, 0)),
      preco_promo_cesto: r2(itens.reduce((s, i) => s + i.preco_promo, 0)),
      margem_pct_cesto: r1((100 * (receitaSemIva - custo)) / receitaSemIva),
    };
    const linhas = itens.map((i) => {
      const [sc, sv] = situacao(i);
      return [i.cnp_codigo, i.designacao, i.finalidade_curta, i.papel_cesto, i.publico, i.stock_total_unidades, sc, sv, i.epoca_fit, i.pvp, i.preco_promo, i.desconto_efetivo_pct, i.margem_pct_promo, i.limitado_por_regra_legal];
    });
    const pack_proposto_id = repo.store({ kind: 'pack', campanha_id: camp.campanha_id, publico, desconto_pct: desc, itens });
    return envelope(repo, F, {
      ...metaBase, modo: 'PACK', campanha: { id: camp.campanha_id, titulo: camp.titulo, tipo: camp.tipo, janela: j },
      publico_aplicado: publico, desconto_pct_pedido: desc, excluidos_resumo: exFinal, conflito_campanha: conflitoCampanha,
      regra_preco: { margem_minima_pct: 5, base: 'preco_sem_iva', formula: 'ceil_cent(custo / 0.95 * (1 + iva/100))' },
      n_linhas_total: linhas.length, truncado: false, motivo: null,
    }, COLUNAS_PACK, linhas, {
      itens,
      totais,
      validacao_legal: val,
      pack_proposto_id,
      packs_montaveis: packsMontaveis,
      hash_composicao: hashComposicao,
      estado_aprovacao: 'APROVADO_DT',
    });
  }
  return vazio(cx, F, 'CESTO_INCOMPLETO', { ...metaBase, excluidos_resumo: exFinal, conflito_campanha: conflitoCampanha, publico_aplicado: publico });
}
