/**
 * situacoes_packs.ts — Motor de Packs por SITUAÇÃO DO UTENTE (v2, 100% determinístico)
 *
 * Inverte a lógica do modo PACK atual:
 *   ANTES:  campanha → saco de candidatos → 1.º PRINCIPAL + "qualquer coisa de subcategoria diferente"
 *   AGORA:  campanha → situações do utente → papéis (lugares) → subcategorias permitidas por papel
 *           → só então escolhe produtos (escoamento > época > margem), com stock reservado entre packs.
 *
 * Regras mantidas do motor atual (reutilizadas de comercial.ts, não duplicadas):
 *   filtrar(), enriquecer(), comparar() (ORDEM_ESCOAMENTO), precoPromo() (anti-dumping DL 166/2013),
 *   compatCesto(), validarCesto(), computePackCompositionHash().
 *
 * Regra de ouro: cada papel aceita no máximo 1 produto. Isto impede, por construção,
 * packs com 3 desodorizantes ou com tosse seca + expectorante.
 */

import {
  Cand,
  Enriquecido,
  ItemPack,
  Publico,
  CampanhaAtivaRow,
  filtrar,
  enriquecer,
  comparar,
  precoPromo,
  compatCesto,
  validarCesto,
  computePackCompositionHash,
  situacao,
} from './comercial';

// ───────────────────────────── Tipos ─────────────────────────────

export type PapelPack = 'PRINCIPAL' | 'APOIO' | 'CUIDADO_DIARIO';

export interface LugarPack {
  papel: PapelPack;
  obrigatorio: boolean;
  /** Subcategorias aceites (texto exato de ProdutoMestre.subcategoria; comparação normalizada). */
  subcategorias: string[];
  /** Opcional: a designação TEM de conter um destes termos (para separar ex.: champô vs loção). */
  termosObrigatorios?: string[];
  /** Opcional: exclui se a designação contiver um destes termos. */
  termosExcluir?: string[];
  /** O que aparece no card em "Para o utente" — linguagem comum, não nome de categoria. */
  textoUtente: string;
}

export interface Situacao {
  id: string;
  /** Campanhas (ANNUAL_CAMPAIGNS.id) em que esta situação pode ser proposta. */
  campanhas: string[];
  /** Nome do pack, como o utente o diria. */
  titulo: string;
  /** Queixa / necessidade, em linguagem comum. */
  queixa: string;
  publico: Publico;
  lugares: LugarPack[];
  /** Pergunta de abertura ao balcão. */
  perguntaBalcao: string;
  margemMinimaPackPct: number;
  /** Preferir produtos da mesma marca (rotinas de dermocosmética). */
  preferirMesmaMarca?: boolean;
}

export interface OpcoesMotor {
  descontoPct: number;
  /** Nº de packs físicos a montar por proposta (é o que fica reservado). */
  packsAReservar: number;
  /** Mínimo de packs montáveis para a proposta valer a pena. */
  minPacksMontaveis: number;
  /** Quantos candidatos por lugar entram na pesquisa combinatória (4 → máx. 64 combinações). */
  topPorLugar: number;
  /** Modo ideias: artigos já em campanha de época podem entrar (ficam assinalados), em vez de serem excluídos. */
  incluirEmCampanha: boolean;
}

export const OPCOES_DEFAULT: OpcoesMotor = { descontoPct: 15, packsAReservar: 3, minPacksMontaveis: 3, topPorLugar: 4, incluirEmCampanha: false };

export interface ItemProposto extends ItemPack {
  papel_pack: PapelPack;
  texto_utente: string;
  stock_disponivel: number; // stock - reservado por packs anteriores desta execução
}

export interface PropostaPack {
  id: string; // pack_<situacao>
  situacao_id: string;
  titulo: string;
  queixa: string;
  pergunta_balcao: string;
  publico: Publico;
  itens: ItemProposto[];
  totais: { pvp_cesto: number; preco_promo_cesto: number; poupanca: number; margem_pct_cesto: number };
  packs_montaveis: number;
  packs_reservados: number;
  n_itens_urgentes: number; // risco de caducidade / mono / excesso
  hash_composicao: string;
  estado: 'PENDENTE_VALIDACAO_DT';
}

export interface RecusaSituacao {
  situacao_id: string;
  motivo: 'LUGAR_OBRIGATORIO_VAZIO' | 'SEM_COMBINACAO_VALIDA' | 'MARGEM_ABAIXO_MINIMO' | 'STOCK_INSUFICIENTE';
  detalhe?: string;
}

// ───────────────────────────── Utilitários ─────────────────────────────

const norm = (s: string | null | undefined) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const cents = (x: number) => Math.round(x * 100);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Marca ≈ 1.ª palavra da designação (sem '*'). Substituir por laboratorio_titular quando chegar ao Cand. */
const marca = (c: Pick<Cand, 'designacao'>) => norm(c.designacao.replace(/^\*/, '')).split(' ')[0] || '';

const ehUrgente = (c: Cand) => c.eh_risco_caducidade || c.eh_mono || c.eh_excesso_cobertura;

/** Mesmo slug que comercial_repo.slugify(): 'Pele Seca & Atópica' → 'pele_seca_atopica'. */
export const slug = (s: string | null | undefined) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Compara por slug com Cand.subcategoria_id (= slugify da subcategoria) e, por segurança,
 * com Cand.finalidade_curta (texto). Requer o patch em comercial_repo.ts que passa a ler
 * ProdutoMestre.subcategoria em vez do hmr3 do ficheiro FirstPharma (ver README).
 */
export function encaixa(c: Cand, lugar: LugarPack): boolean {
  const alvo = new Set(lugar.subcategorias.map(slug));
  if (!alvo.has(c.subcategoria_id) && !alvo.has(slug(c.finalidade_curta))) return false;
  const d = norm(c.designacao);
  if (lugar.termosObrigatorios?.length && !lugar.termosObrigatorios.some((t) => d.includes(norm(t)))) return false;
  if (lugar.termosExcluir?.some((t) => d.includes(norm(t)))) return false;
  return true;
}

// ───────────────────────────── Reserva de stock ─────────────────────────────

/** Reserva de unidades entre propostas da MESMA execução (resolve o Farline em 3 packs). */
export class ReservaStock {
  private reservado = new Map<string, number>();
  constructor(inicial?: Record<string, number>) {
    if (inicial) for (const [k, v] of Object.entries(inicial)) this.reservado.set(k, v);
  }
  disponivel(c: Pick<Cand, 'cnp_codigo' | 'stock_total_unidades'>) {
    return Math.max(0, Math.floor(c.stock_total_unidades) - (this.reservado.get(c.cnp_codigo) || 0));
  }
  reservar(cnps: string[], unidades: number) {
    for (const cnp of cnps) this.reservado.set(cnp, (this.reservado.get(cnp) || 0) + unidades);
  }
  snapshot() {
    return Object.fromEntries(this.reservado);
  }
}

// ───────────────────────────── Montagem de 1 pack ─────────────────────────────

function precificar(x: Enriquecido, descPct: number): ItemPack | null {
  const r = precoPromo(x, x.permite_desconto_promo ? descPct : 0);
  if ('excluir' in r) return null;
  return { ...x, preco_promo: r.preco, desconto_efetivo_pct: r.desconto_efetivo_pct, margem_pct_promo: r.margem_pct_promo, limitado_por_regra_legal: r.limitado_por_regra_legal };
}

function totais(itens: ItemPack[]) {
  const receitaSemIva = itens.reduce((s, i) => s + cents(i.preco_promo) / (1 + i.taxa_iva / 100), 0);
  const custo = itens.reduce((s, i) => s + cents(i.custo_unitario_medio), 0);
  const pvp = r2(itens.reduce((s, i) => s + i.pvp, 0));
  const promo = r2(itens.reduce((s, i) => s + i.preco_promo, 0));
  return { pvp_cesto: pvp, preco_promo_cesto: promo, poupanca: r2(pvp - promo), margem_pct_cesto: r1((100 * (receitaSemIva - custo)) / receitaSemIva) };
}

/** Produto cartesiano pequeno (lugares × topPorLugar), com "vazio" permitido nos lugares opcionais. */
function* combinacoes<T>(listas: (T | null)[][], i = 0, acc: (T | null)[] = []): Generator<(T | null)[]> {
  if (i === listas.length) {
    yield acc;
    return;
  }
  for (const x of listas[i]) yield* combinacoes(listas, i + 1, [...acc, x]);
}

export function montarPackSituacao(
  sit: Situacao,
  candidatos: Cand[],
  ctx: { ref: Date; epoca: Record<string, number[] | null>; ativas: CampanhaAtivaRow[] },
  reserva: ReservaStock,
  opts: OpcoesMotor = OPCOES_DEFAULT
): PropostaPack | RecusaSituacao {
  const { ok } = filtrar(candidatos, { publico: sit.publico, bloqueios: new Set(), exigirDesconto: true });
  const base = ok
    .filter((c) => compatCesto(c.publico, sit.publico))
    .map((c) => enriquecer(c, ctx.ref, ctx.epoca, ctx.ativas))
    .filter((c) => c.epoca_fit !== 'FORA' || ehUrgente(c)) // fora de época só entra se for para escoar
    .filter((c) => opts.incluirEmCampanha || !c.em_campanha_ativa)
    .filter((c) => reserva.disponivel(c) >= opts.minPacksMontaveis)
    .sort(comparar);

  // 1) Candidatos por lugar (um produto nunca ocupa 2 lugares do mesmo pack — tratado na combinação)
  const porLugar: (ItemPack | null)[][] = [];
  for (const lugar of sit.lugares) {
    const cands = base
      .filter((c) => encaixa(c, lugar))
      .map((c) => precificar(c, opts.descontoPct))
      .filter((x): x is ItemPack => !!x)
      .slice(0, opts.topPorLugar);
    if (lugar.obrigatorio && cands.length === 0)
      return { situacao_id: sit.id, motivo: 'LUGAR_OBRIGATORIO_VAZIO', detalhe: `${lugar.papel}: ${lugar.subcategorias.join(' | ')}` };
    porLugar.push(lugar.obrigatorio ? cands : [...cands, null]);
  }

  // 2) Pesquisa determinística da melhor combinação
  type Melhor = { itens: ItemPack[]; lugares: LugarPack[]; chave: number[] };
  let melhor: Melhor | null = null;
  let viuMargemBaixa = false;
  let viuStockBaixo = false;

  for (const combo of combinacoes(porLugar)) {
    const pares = combo.map((it, i) => [it, sit.lugares[i]] as const).filter((p): p is readonly [ItemPack, LugarPack] => !!p[0]);
    if (pares.length < 2) continue;
    const itens = pares.map((p) => p[0]);
    if (new Set(itens.map((i) => i.cnp_codigo)).size !== itens.length) continue; // mesmo produto em 2 lugares

    // validarCesto exige 1 PRINCIPAL: o papel vem agora da situação, não do produto
    const paraValidar = pares.map(([it, l]) => ({ ...it, papel_cesto: l.papel === 'PRINCIPAL' ? 'PRINCIPAL' : 'COMPLEMENTAR' }) as ItemPack);
    if (!validarCesto(paraValidar, sit.publico, { minStock: opts.minPacksMontaveis }).ok) continue;

    const montaveis = Math.min(...itens.map((i) => reserva.disponivel(i)));
    if (montaveis < opts.minPacksMontaveis) {
      viuStockBaixo = true;
      continue;
    }
    const t = totais(itens);
    if (t.margem_pct_cesto < sit.margemMinimaPackPct) {
      viuMargemBaixa = true;
      continue;
    }

    const urg = itens.filter(ehUrgente).length;
    const marcas = new Set(itens.map(marca)).size;
    // Ordem de preferência (lexicográfica, menor = melhor):
    //   mais lugares preenchidos > mais itens a escoar > (mesma marca, se pedido) > maior margem > maior poupança
    const chave = [-itens.length, -urg, sit.preferirMesmaMarca ? marcas : 0, -t.margem_pct_cesto, -t.poupanca];
    const melhorQue = (a: number[], b: number[]) => {
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k];
      return false;
    };
    if (!melhor || melhorQue(chave, melhor.chave)) melhor = { itens, lugares: pares.map((p) => p[1]), chave };
  }

  if (!melhor)
    return { situacao_id: sit.id, motivo: viuMargemBaixa ? 'MARGEM_ABAIXO_MINIMO' : viuStockBaixo ? 'STOCK_INSUFICIENTE' : 'SEM_COMBINACAO_VALIDA' };

  // 3) Reservar stock e devolver proposta
  const montaveis = Math.min(...melhor.itens.map((i) => reserva.disponivel(i)));
  const aReservar = Math.min(montaveis, opts.packsAReservar);
  const itens: ItemProposto[] = melhor.itens.map((it, i) => ({
    ...it,
    papel_pack: melhor!.lugares[i].papel,
    texto_utente: melhor!.lugares[i].textoUtente,
    stock_disponivel: reserva.disponivel(it),
  }));
  reserva.reservar(itens.map((i) => i.cnp_codigo), aReservar);

  return {
    id: `pack_${sit.id}`,
    situacao_id: sit.id,
    titulo: sit.titulo,
    queixa: sit.queixa,
    pergunta_balcao: sit.perguntaBalcao,
    publico: sit.publico,
    itens,
    totais: totais(melhor.itens),
    packs_montaveis: montaveis,
    packs_reservados: aReservar,
    n_itens_urgentes: melhor.itens.filter(ehUrgente).length,
    // UM só formato de hash em todo o sistema (hoje há dois: 'ADULTO'+desc pedido vs 'Adultos e Famílias (Adulto)'+desc arredondado)
    hash_composicao: computePackCompositionHash(itens.map((i) => i.cnp_codigo), sit.publico, opts.descontoPct),
    estado: 'PENDENTE_VALIDACAO_DT',
  };
}

// ───────────────────────────── Várias situações (com reserva partilhada) ─────────────────────────────

/**
 * Gera propostas para todas as situações das campanhas em época.
 * Ordem: situações com mais candidatos urgentes primeiro → o stock a escoar vai para onde faz sentido
 * antes de ser "apanhado" por um pack menos prioritário.
 */
export function gerarPacksPorSituacao(
  situacoes: Situacao[],
  campanhasEmEpoca: { campanha_id: string; desconto_sugerido_pct: number }[],
  candidatosPorCampanha: Record<string, Cand[]>,
  ctx: { ref: Date; epoca: Record<string, number[] | null>; ativas: CampanhaAtivaRow[] },
  opts: Partial<OpcoesMotor> = {},
  reserva = new ReservaStock()
) {
  const desc = new Map(campanhasEmEpoca.map((c) => [c.campanha_id, c.desconto_sugerido_pct]));
  const ativas = situacoes.filter((s) => s.campanhas.some((c) => desc.has(c)));

  const candsDe = (s: Situacao) => {
    const vistos = new Map<string, Cand>();
    for (const c of s.campanhas) for (const x of candidatosPorCampanha[c] || []) vistos.set(x.cnp_codigo, x);
    return [...vistos.values()];
  };
  const urgencia = (s: Situacao) => candsDe(s).filter((c) => ehUrgente(c) && s.lugares.some((l) => encaixa(c, l))).length;
  const ordenadas = [...ativas].sort((a, b) => urgencia(b) - urgencia(a) || a.id.localeCompare(b.id));

  const propostas: PropostaPack[] = [];
  const recusas: RecusaSituacao[] = [];
  for (const s of ordenadas) {
    const d = Math.max(...s.campanhas.filter((c) => desc.has(c)).map((c) => desc.get(c)!));
    const r = montarPackSituacao(s, candsDe(s), ctx, reserva, { ...OPCOES_DEFAULT, ...opts, descontoPct: opts.descontoPct ?? d });
    if ('motivo' in r) recusas.push(r);
    else propostas.push(r);
  }
  return { propostas, recusas, reserva: reserva.snapshot() };
}

/** Para debug/UI: porque é que cada item entrou. */
export function explicarItem(i: ItemProposto) {
  const [sc, sv] = situacao(i);
  return `${i.papel_pack} · ${i.texto_utente} · ${sc}${sv != null ? `(${sv})` : ''} · margem ${i.margem_pct_promo}%`;
}

// ───────────────────────────── Modo IDEIAS (montra de opções para a farmácia) ─────────────────────────────

export interface OpcaoArtigo {
  cnp_codigo: string;
  designacao: string;
  stock: number;
  pvp: number;
  preco_promo: number;
  margem_pct_promo: number;
  sinais: string[]; // 'A_ESCOAR' | 'EM_CAMPANHA_EPOCA' | 'FORA_DE_EPOCA' | 'NO_LIMITE_LEGAL'
}

export interface IdeiaPack {
  situacao_id: string;
  titulo: string;
  queixa: string;
  pergunta_balcao: string;
  janela: 'EM_EPOCA' | 'PROXIMA';
  /** PRONTO: há stock para todos os lugares obrigatórios · INCOMPLETO: falta pelo menos 1 obrigatório. */
  estado: 'PRONTO' | 'INCOMPLETO';
  lugares: { papel: PapelPack; obrigatorio: boolean; texto_utente: string; opcoes: OpcaoArtigo[]; em_falta: boolean }[];
  /** Combinação sugerida (a farmácia pode trocar qualquer artigo por outra opção do mesmo lugar). */
  sugestao: PropostaPack | null;
  motivo_sem_sugestao?: RecusaSituacao['motivo'];
}

/**
 * Para cada situação dos temas em época (ou a começar em breve), mostra:
 *  - que artigos a farmácia JÁ TEM em stock para cada lugar (até N opções, ordem de escoamento),
 *  - uma combinação sugerida pronta a validar,
 *  - o que falta, quando falta.
 * Nada é excluído por estar em campanha de época — fica só assinalado.
 */
export function gerarIdeiasPacks(
  situacoes: Situacao[],
  temas: { campanha_id: string; desconto_sugerido_pct: number; janela: 'EM_EPOCA' | 'PROXIMA' }[],
  candidatosPorCampanha: Record<string, Cand[]>,
  ctx: { ref: Date; epoca: Record<string, number[] | null>; ativas: CampanhaAtivaRow[] },
  opts: Partial<OpcoesMotor> & { opcoesPorLugar?: number; stockMinimoOpcao?: number } = {}
): IdeiaPack[] {
  const porTema = new Map(temas.map((t) => [t.campanha_id, t]));
  const nOp = opts.opcoesPorLugar ?? 3;
  const stockMin = opts.stockMinimoOpcao ?? 1;
  // Nas ideias NÃO se reserva stock entre situações: a farmácia ainda vai escolher.
  // A reserva acontece quando a DT aprova (usar ReservaStock com as unidades dos packs aprovados).
  const ideias: IdeiaPack[] = [];

  for (const s of situacoes) {
    const meus = s.campanhas.map((c) => porTema.get(c)).filter((t): t is NonNullable<typeof t> => !!t);
    if (meus.length === 0) continue;
    const janela = meus.some((t) => t.janela === 'EM_EPOCA') ? 'EM_EPOCA' : 'PROXIMA';
    const desc = Math.max(...meus.map((t) => t.desconto_sugerido_pct));

    const vistos = new Map<string, Cand>();
    for (const c of s.campanhas) for (const x of candidatosPorCampanha[c] || []) vistos.set(x.cnp_codigo, x);
    const { ok } = filtrar([...vistos.values()], { publico: s.publico, bloqueios: new Set(), exigirDesconto: true });
    const base = ok
      .filter((c) => compatCesto(c.publico, s.publico) && c.stock_total_unidades >= stockMin)
      .map((c) => enriquecer(c, ctx.ref, ctx.epoca, ctx.ativas))
      .sort(comparar);

    const lugares = s.lugares.map((l) => {
      const opcoes: OpcaoArtigo[] = [];
      for (const c of base) {
        if (opcoes.length >= nOp) break;
        if (!encaixa(c, l)) continue;
        const it = precificar(c, desc);
        if (!it) continue;
        const sinais: string[] = [];
        if (ehUrgente(c)) sinais.push('A_ESCOAR');
        if (c.em_campanha_ativa) sinais.push('EM_CAMPANHA_EPOCA');
        if (c.epoca_fit === 'FORA') sinais.push('FORA_DE_EPOCA');
        if (it.limitado_por_regra_legal) sinais.push('NO_LIMITE_LEGAL');
        opcoes.push({ cnp_codigo: c.cnp_codigo, designacao: c.designacao, stock: Math.floor(c.stock_total_unidades), pvp: c.pvp, preco_promo: it.preco_promo, margem_pct_promo: it.margem_pct_promo, sinais });
      }
      return { papel: l.papel, obrigatorio: l.obrigatorio, texto_utente: l.textoUtente, opcoes, em_falta: opcoes.length === 0 };
    });

    const estado = lugares.some((l) => l.obrigatorio && l.em_falta) ? 'INCOMPLETO' : 'PRONTO';
    const r = estado === 'PRONTO'
      ? montarPackSituacao(s, [...vistos.values()], ctx, new ReservaStock(), { ...OPCOES_DEFAULT, ...opts, descontoPct: desc, incluirEmCampanha: true })
      : null;

    ideias.push({
      situacao_id: s.id,
      titulo: s.titulo,
      queixa: s.queixa,
      pergunta_balcao: s.perguntaBalcao,
      janela,
      estado,
      lugares,
      sugestao: r && !('motivo' in r) ? r : null,
      motivo_sem_sugestao: r && 'motivo' in r ? r.motivo : estado === 'INCOMPLETO' ? 'LUGAR_OBRIGATORIO_VAZIO' : undefined,
    });
  }
  // Primeiro o que está em época e pronto; depois o que está a chegar; incompletos no fim
  const ordem = (i: IdeiaPack) => (i.janela === 'EM_EPOCA' ? 0 : 2) + (i.estado === 'PRONTO' ? 0 : 1);
  return ideias.sort((a, b) => ordem(a) - ordem(b) || a.titulo.localeCompare(b.titulo));
}

/** Slugs de subcategoria de que as situações de uma campanha precisam (para repo.candidatosPorSubcategorias). */
export function slugsPorCampanha(situacoes: Situacao[], campanhaId: string): string[] {
  return [...new Set(situacoes.filter((s) => s.campanhas.includes(campanhaId)).flatMap((s) => s.lugares.flatMap((l) => l.subcategorias.map(slug))))];
}
