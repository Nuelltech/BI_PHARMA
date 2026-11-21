/**
 * Transformação pura: tabelas CITS -> uma linha de ProdutoCits por CNP.
 * Sem base de dados, para poder ser testada com dados sintéticos.
 */
import { createHash } from 'node:crypto';
import {
  CLASS_DISPENSA, ESTADO_COMERC_TEMP_INDISPONIVEL, GRUPO, REGEX_PEDIATRICO,
  SUBGRUPOS_PEDIATRICOS, TIPO_PRECO, TIPO_PRODUTO,
} from './config.js';
import type { DadosCits, Linha } from './source.js';

export interface ProdutoCitsLinha {
  cnp_codigo: string;
  emb_id: number;
  prod_id: number;
  nome: string | null;
  descricao_embalagem: string | null;
  marca: string | null;
  tipo_produto: string | null;
  nr_processo: string | null;
  titular_aim: string | null;
  dci: string | null;
  substancias: { nome: string | null; quantidade: string | null }[];
  dosagem: string | null;
  dosagem_completa: string | null;
  forma_farmaceutica: string | null;
  forma_farmaceutica_agrupada: string | null;
  vias_administracao: string[];
  atc_codigos: string[];
  atc_descricoes: string[];
  cft_codigos: string[];
  cft_descricoes: string[];
  gh_codigo: string | null;
  gh_descricao: string | null;
  cnpem: string | null;
  classificacoes_dispensa: number[];
  regime_dispensa: string;
  precisa_receita: boolean;
  tipo_venda_derivado: string;
  eh_generico: boolean;
  eh_marca: boolean;
  eh_biossimilar: boolean;
  eh_biologico: boolean;
  publico: string;
  publico_fonte: string | null;
  grupos_produto: number[];
  pvp_oficial: number | null;
  pvp_max: number | null;
  preco_referencia: number | null;
  pvp_notificado: number | null;
  comparticipacoes: { regime: string | null; nivel: string | null; percentagem: number | null; desde: string | null }[];
  estado_comercializacao: string | null;
  data_prevista_reposicao: string | null;
  estado_aim: string | null;
  fim_escoamento: string | null;
  pem_amb: boolean | null;
  margem_terapeutica_estreita: boolean | null;
  monitorizacao_adicional: boolean | null;
  substituicao_farmacia: boolean | null;
  conservacao: string | null;
  alertas: { mensagem: string | null; link: string | null; faixa_etaria: [number | null, number | null] | null }[];
  cits_data_alteracao: string | null;
  hash_conteudo: string;
}

export interface ResultadoTransformacao {
  produtos: ProdutoCitsLinha[];
  avisos: string[];
}

// ---------- utilitários ----------
const sn = (v: string | null | undefined): boolean | null =>
  v == null ? null : v.trim().toUpperCase() === 'S' ? true : v.trim().toUpperCase() === 'N' ? false : null;

const data = (v: string | null | undefined): string | null => (v ? v.slice(0, 10) : null);

const num = (v: string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Normaliza o CNP para 7 dígitos. */
export const normalizarCnp = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const d = String(v).replace(/\D/g, '');
  return d ? d.padStart(7, '0') : null;
};

/** Registo em vigor numa data (DATA_INICIO <= dia <= DATA_FIM, fim vazio = aberto). */
const emVigor = (r: Linha, dia: string) => {
  const ini = data(r.DATA_INICIO);
  const fim = data(r.DATA_FIM);
  return (!ini || ini <= dia) && (!fim || fim >= dia);
};

function indexar(linhas: Linha[] | undefined, chave: string): Map<string, Linha> {
  const m = new Map<string, Linha>();
  for (const r of linhas ?? []) if (r[chave] != null) m.set(String(r[chave]), r);
  return m;
}

function agrupar(linhas: Linha[] | undefined, chave: string): Map<string, Linha[]> {
  const m = new Map<string, Linha[]>();
  for (const r of linhas ?? []) {
    const k = r[chave];
    if (k == null) continue;
    const lista = m.get(String(k));
    if (lista) lista.push(r); else m.set(String(k), [r]);
  }
  return m;
}

const descr = (ref: Map<string, Linha>, id: string | null | undefined) =>
  id == null ? null : ref.get(String(id))?.DESCR ?? null;

const unicos = <T>(xs: T[]) => [...new Set(xs)];

// ---------- regras de classificação ----------
export function classificarDispensa(ids: number[], tipoProduto: string | null) {
  for (const regra of CLASS_DISPENSA) {
    if (ids.some((id) => regra.ids.includes(id))) {
      return { regime: regra.regime, precisaReceita: regra.precisaReceita, tipoVenda: regra.tipoVenda };
    }
  }
  if (tipoProduto && tipoProduto !== 'MUH') {
    return { regime: 'NAO_MEDICAMENTO', precisaReceita: false, tipoVenda: 'VENDA_LIVRE' };
  }
  // Medicamento sem classificação conhecida: regra conservadora
  return { regime: 'DESCONHECIDO', precisaReceita: true, tipoVenda: 'MSRM' };
}

export function classificarPublico(grupos: number[], subgrupos: number[], textos: (string | null)[]) {
  if (grupos.includes(GRUPO.AIMUP)) return { publico: 'PEDIATRICO', fonte: 'CITS_AIMUP' };
  if (subgrupos.some((s) => SUBGRUPOS_PEDIATRICOS.has(s))) return { publico: 'PEDIATRICO', fonte: 'CITS_SUBGRUPO' };
  if (textos.some((t) => t && REGEX_PEDIATRICO.test(t))) return { publico: 'PEDIATRICO', fonte: 'INFERIDO_DESIGNACAO' };
  return { publico: 'DESCONHECIDO', fonte: null };
}

function precoEmVigor(precos: Linha[], tipo: string, dia: string, exigirAtivo: boolean): number | null {
  const candidatos = precos
    .filter((p) => String(p.TIPO_PRECO_ID) === tipo && emVigor(p, dia))
    .filter((p) => !exigirAtivo || p.ATIVO == null || String(p.ATIVO) === '1')
    .sort((a, b) => (data(b.DATA_INICIO) ?? '').localeCompare(data(a.DATA_INICIO) ?? ''));
  return candidatos.length ? num(candidatos[0].PRECO) : null;
}

export function hashConteudo(p: Omit<ProdutoCitsLinha, 'hash_conteudo'>): string {
  return createHash('sha1').update(JSON.stringify(p)).digest('hex');
}

// ---------- transformação ----------
export function transformar(dados: DadosCits, dia: string = new Date().toISOString().slice(0, 10)): ResultadoTransformacao {
  const avisos: string[] = [];
  const t = (n: string) => dados.get(n) ?? [];

  const produtos = indexar(t('PRODUTO'), 'PROD_ID');
  const refDci = indexar(t('REF_DCIPT'), 'DCIPT_ID');
  const refForma = indexar(t('REF_FORMA_FARM'), 'FORMA_FARM_ID');
  const refAgrupForma = indexar(t('REF_AGRUP_FORMA_FARM'), 'AGRUP_FORMA_FARM_ID');
  const refTitular = indexar(t('REF_TITULAR_AIM'), 'TITULAR_AIM_ID');
  const refEstadoAim = indexar(t('REF_ESTADO_AIM'), 'ESTADO_AIM_ID');
  const refGh = indexar(t('REF_GRUPO_HOM'), 'GRUPO_HOM_COD');
  const refAtc = indexar(t('REF_ATC'), 'ATC_COD');
  const refCft = indexar(t('REF_CFT'), 'CFT_COD');
  const refVia = indexar(t('REF_VIA_ADMIN'), 'VIA_ADMIN_ID');
  const refSubst = indexar(t('REF_SUBSTANCIA'), 'SUBST_ID');
  const refEstadoComerc = indexar(t('REF_ESTADO_COMERC'), 'EST_COMERC_ID');
  const refRegime = indexar(t('REF_TIPO_REGIME'), 'TIPO_REGIME_ID');
  const refNivel = indexar(t('REF_NIVEL_COMPART'), 'NIVEL_COMPART_ID');
  const refTemp = indexar(t('REF_TEMPERATURA_ARMAZ'), 'TEMPERATURA_ARMAZ_ID');
  const alertasPorId = indexar(t('ALERTA'), 'ALERTA_ID');

  const classPorProd = agrupar(t('LNK_PROD_CLASS_DISP'), 'PROD_ID');
  const gruposPorProd = agrupar(t('LNK_PROD_GRUPO_PROD'), 'PROD_ID');
  const subgruposPorProd = agrupar(t('LNK_PROD_SUBGRUPO_PROD'), 'PROD_ID');
  const atcPorProd = agrupar(t('LNK_PROD_ATC'), 'PROD_ID');
  const cftPorProd = agrupar(t('LNK_PROD_CFT'), 'PROD_ID');
  const viaPorProd = agrupar(t('LNK_PROD_VIA_ADMIN'), 'PROD_ID');
  const substPorProd = agrupar(t('LNK_PROD_SUBST'), 'PROD_ID');

  const precosPorEmb = agrupar(t('PRECO'), 'EMB_ID');
  const comercPorEmb = agrupar(t('COMERCIALIZACAO'), 'EMB_ID');
  const compPorEmb = agrupar(t('COMPARTICIPACAO'), 'EMB_ID');
  const escoamPorEmb = agrupar(t('ESCOAMENTO'), 'EMB_ID');
  const armazPorEmb = agrupar(t('COND_ARMAZENAMENTO'), 'EMB_ID');
  const msgPorEmb = agrupar(t('MENSAGEM_ALERTA'), 'EMB_ID');

  const resultado = new Map<string, ProdutoCitsLinha>();
  let semCnp = 0;
  let semProduto = 0;

  for (const emb of t('EMBALAGEM')) {
    const cnp = normalizarCnp(emb.NR_REGISTO);
    if (!cnp) { semCnp++; continue; }
    const prodId = String(emb.PROD_ID);
    const prod = produtos.get(prodId);
    if (!prod) { semProduto++; continue; }
    const embId = String(emb.EMB_ID);

    const tipoProduto = prod.TIPO_PRODUTO_ID != null ? TIPO_PRODUTO[String(prod.TIPO_PRODUTO_ID)] ?? 'OUTRO' : null;
    const classIds = unicos((classPorProd.get(prodId) ?? []).map((r) => Number(r.CLASS_DISP_PROD_ID))).filter(Number.isFinite);
    const grupos = unicos((gruposPorProd.get(prodId) ?? []).map((r) => Number(r.GRUPO_PRODUTO_ID))).filter(Number.isFinite);
    const subgrupos = unicos((subgruposPorProd.get(prodId) ?? []).map((r) => Number(r.SUBGRUPO_PRODUTO_ID))).filter(Number.isFinite);

    const disp = classificarDispensa(classIds, tipoProduto);
    const pub = classificarPublico(grupos, subgrupos, [prod.NOME, emb.DESCR, prod.DOSAGEM_CEDENCIA]);
    const ehGenerico = sn(prod.IND_GENERICO) === true || grupos.includes(GRUPO.GENERICO);

    const atc = unicos((atcPorProd.get(prodId) ?? []).map((r) => r.ATC_COD).filter((x): x is string => !!x)).sort();
    const cft = unicos((cftPorProd.get(prodId) ?? []).map((r) => r.CFT_COD).filter((x): x is string => !!x)).sort();
    const vias = unicos((viaPorProd.get(prodId) ?? []).map((r) => descr(refVia, r.VIA_ADMIN_ID)).filter((x): x is string => !!x)).sort();

    const precos = precosPorEmb.get(embId) ?? [];
    const comercAtual = (comercPorEmb.get(embId) ?? [])
      .filter((c) => emVigor(c, dia))
      .sort((a, b) => (data(b.DATA_INICIO) ?? '').localeCompare(data(a.DATA_INICIO) ?? ''))[0];
    const estadoComercId = comercAtual?.ESTADO_COMERC_ID != null ? String(comercAtual.ESTADO_COMERC_ID) : null;

    const comparticipacoes = (compPorEmb.get(embId) ?? [])
      .filter((c) => emVigor(c, dia))
      .map((c) => ({
        regime: descr(refRegime, c.TIPO_REGIME_ID),
        nivel: descr(refNivel, c.NIVEL_COMPART_ID),
        percentagem: num(refNivel.get(String(c.NIVEL_COMPART_ID))?.PERCENT_COMPART),
        desde: data(c.DATA_INICIO),
      }))
      .sort((a, b) => `${a.regime}${a.nivel}`.localeCompare(`${b.regime}${b.nivel}`));

    const escoamentos = (escoamPorEmb.get(embId) ?? []).filter((e) => emVigor(e, dia));
    const fimEscoamento = escoamentos.map((e) => data(e.DATA_FIM)).filter((x): x is string => !!x).sort().pop() ?? null;

    const armaz = (armazPorEmb.get(embId) ?? [])[0];
    const alertas = (msgPorEmb.get(embId) ?? [])
      .map((m) => ({ m, a: alertasPorId.get(String(m.ALERTA_ID)) }))
      .filter(({ a }) => !a || emVigor(a, dia))
      .map(({ m, a }) => ({
        mensagem: m.MENSAGEM,
        link: m.LINK ?? null,
        faixa_etaria: a && (a.FAIXA_ETARIA_INICIO != null || a.FAIXA_ETARIA_FIM != null)
          ? [num(a.FAIXA_ETARIA_INICIO), num(a.FAIXA_ETARIA_FIM)] as [number | null, number | null]
          : null,
      }));

    const linha: Omit<ProdutoCitsLinha, 'hash_conteudo'> = {
      cnp_codigo: cnp,
      emb_id: Number(emb.EMB_ID),
      prod_id: Number(prod.PROD_ID),
      nome: prod.NOME,
      descricao_embalagem: emb.DESCR ?? null,
      marca: prod.MARCA ?? null,
      tipo_produto: tipoProduto,
      nr_processo: prod.NR_PROCESSO ?? null,
      titular_aim: descr(refTitular, prod.TITULAR_AIM_ID),
      dci: descr(refDci, prod.DCIPT_ID),
      substancias: (substPorProd.get(prodId) ?? []).map((s) => ({
        nome: descr(refSubst, s.SUBST_ID), quantidade: s.QUANTIDADE ?? null,
      })),
      dosagem: prod.DOSAGEM,
      dosagem_completa: prod.DOSAGEM_CEDENCIA ?? null,
      forma_farmaceutica: descr(refForma, prod.FORMA_FARM_ID),
      forma_farmaceutica_agrupada: descr(refAgrupForma, prod.AGRUP_FORMA_FARM_ID),
      vias_administracao: vias,
      atc_codigos: atc,
      atc_descricoes: atc.map((c) => descr(refAtc, c) ?? ''),
      cft_codigos: cft,
      cft_descricoes: cft.map((c) => descr(refCft, c) ?? ''),
      gh_codigo: emb.GRUPO_HOM_COD ?? null,
      gh_descricao: descr(refGh, emb.GRUPO_HOM_COD),
      cnpem: emb.CNPEM ?? null,
      classificacoes_dispensa: classIds.sort((a, b) => a - b),
      regime_dispensa: disp.regime,
      precisa_receita: disp.precisaReceita,
      tipo_venda_derivado: disp.tipoVenda,
      eh_generico: ehGenerico,
      eh_marca: tipoProduto === 'MUH' && !ehGenerico,
      eh_biossimilar: grupos.includes(GRUPO.BIOSSIMILAR),
      eh_biologico: grupos.includes(GRUPO.BIOLOGICO),
      publico: pub.publico,
      publico_fonte: pub.fonte,
      grupos_produto: grupos.sort((a, b) => a - b),
      pvp_oficial: precoEmVigor(precos, TIPO_PRECO.PVP, dia, true),
      pvp_max: precoEmVigor(precos, TIPO_PRECO.PVP_MAX, dia, true),
      preco_referencia: precoEmVigor(precos, TIPO_PRECO.PRECO_REF, dia, false),
      pvp_notificado: precoEmVigor(precos, TIPO_PRECO.PVP_NOTIFICADO, dia, false),
      comparticipacoes,
      estado_comercializacao: descr(refEstadoComerc, estadoComercId),
      data_prevista_reposicao: estadoComercId === ESTADO_COMERC_TEMP_INDISPONIVEL ? data(emb.DATA_PREVISTA_REPOSICAO) : null,
      estado_aim: descr(refEstadoAim, prod.ESTADO_AIM_ID),
      fim_escoamento: fimEscoamento,
      pem_amb: sn(emb.PEM_AMB),
      margem_terapeutica_estreita: sn(prod.IND_MARGEM_TERAP),
      monitorizacao_adicional: sn(prod.IND_MONIT_ADICIONAL_FV),
      substituicao_farmacia: sn(emb.SUBSTITUICAO_FARMACIA),
      conservacao: armaz ? descr(refTemp, armaz.TEMPERATURA_ARMAZ_ID) : null,
      alertas,
      cits_data_alteracao: data(prod.DATA_ALTERACAO),
    };

    if (resultado.has(cnp)) avisos.push(`CNP duplicado no CITS: ${cnp} (mantido o primeiro)`);
    else resultado.set(cnp, { ...linha, hash_conteudo: hashConteudo(linha) });
  }

  if (semCnp) avisos.push(`${semCnp} embalagens sem NR_REGISTO ignoradas`);
  if (semProduto) avisos.push(`${semProduto} embalagens com PROD_ID inexistente ignoradas`);
  return { produtos: [...resultado.values()], avisos };
}
