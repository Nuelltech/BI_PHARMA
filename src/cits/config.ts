/**
 * Estrutura esperada do ficheiro CITS (Manual da Cedência v16, 16-01-2026).
 * Só as tabelas usadas pelo Bi-Pharma. Se o Infarmed mudar a estrutura,
 * o importador pára quando falta uma coluna obrigatória e avisa quando aparece uma nova.
 */

export interface TabelaCits {
  /** Nome canónico usado no código e em "CitsRaw". */
  nome: string;
  /** Nomes alternativos aceites no ficheiro (acentos, abreviaturas). */
  aliases?: string[];
  /** Colunas sem as quais a carga é rejeitada. */
  obrigatorias: string[];
  /** Tabela pode faltar sem rejeitar a carga. */
  opcional?: boolean;
}

export const TABELAS: TabelaCits[] = [
  // Núcleo
  { nome: 'PRODUTO', obrigatorias: ['PROD_ID', 'NOME', 'DOSAGEM', 'FORMA_FARM_ID', 'DCIPT_ID', 'TIPO_PRODUTO_ID',
      'TITULAR_AIM_ID', 'ESTADO_AIM_ID', 'IND_GENERICO'] },
  { nome: 'EMBALAGEM', obrigatorias: ['EMB_ID', 'PROD_ID', 'NR_REGISTO', 'GRUPO_HOM_COD'] },
  { nome: 'PRECO', obrigatorias: ['EMB_ID', 'TIPO_PRECO_ID', 'PRECO', 'DATA_INICIO', 'DATA_FIM'] },
  { nome: 'COMERCIALIZACAO', obrigatorias: ['EMB_ID', 'ESTADO_COMERC_ID', 'DATA_INICIO', 'DATA_FIM'] },
  { nome: 'COMPARTICIPACAO', aliases: ['COMPARTICIPAÇÃO'], obrigatorias: ['EMB_ID', 'TIPO_REGIME_ID', 'NIVEL_COMPART_ID', 'DATA_INICIO', 'DATA_FIM'] },
  { nome: 'ESCOAMENTO', obrigatorias: ['EMB_ID', 'DATA_INICIO', 'DATA_FIM'], opcional: true },
  { nome: 'COND_ARMAZENAMENTO', obrigatorias: ['EMB_ID', 'TEMPERATURA_ARMAZ_ID'], opcional: true },
  { nome: 'MENSAGEM_ALERTA', obrigatorias: ['EMB_ID', 'ALERTA_ID', 'MENSAGEM'], opcional: true },
  { nome: 'ALERTA', obrigatorias: ['ALERTA_ID', 'DATA_INICIO', 'DATA_FIM'], opcional: true },

  // Ligações
  { nome: 'LNK_PROD_CLASS_DISP', obrigatorias: ['PROD_ID', 'CLASS_DISP_PROD_ID'] },
  { nome: 'LNK_PROD_GRUPO_PROD', obrigatorias: ['PROD_ID', 'GRUPO_PRODUTO_ID'] },
  { nome: 'LNK_PROD_SUBGRUPO_PROD', aliases: ['LNK_PROD_SUBGRP_PROD'], obrigatorias: ['PROD_ID', 'SUBGRUPO_PRODUTO_ID'], opcional: true },
  { nome: 'LNK_PROD_ATC', obrigatorias: ['PROD_ID', 'ATC_COD'] },
  { nome: 'LNK_PROD_CFT', obrigatorias: ['PROD_ID', 'CFT_COD'] },
  { nome: 'LNK_PROD_VIA_ADMIN', obrigatorias: ['PROD_ID', 'VIA_ADMIN_ID'] },
  { nome: 'LNK_PROD_SUBST', obrigatorias: ['PROD_ID', 'SUBST_ID'], opcional: true },

  // Referência
  { nome: 'REF_DCIPT', obrigatorias: ['DCIPT_ID', 'DESCR'] },
  { nome: 'REF_FORMA_FARM', obrigatorias: ['FORMA_FARM_ID', 'DESCR'] },
  { nome: 'REF_AGRUP_FORMA_FARM', obrigatorias: ['AGRUP_FORMA_FARM_ID', 'DESCR'], opcional: true },
  { nome: 'REF_TITULAR_AIM', obrigatorias: ['TITULAR_AIM_ID', 'DESCR'] },
  { nome: 'REF_ESTADO_AIM', obrigatorias: ['ESTADO_AIM_ID', 'DESCR'] },
  { nome: 'REF_GRUPO_HOM', obrigatorias: ['GRUPO_HOM_COD', 'DESCR'] },
  { nome: 'REF_ATC', obrigatorias: ['ATC_COD', 'DESCR'] },
  { nome: 'REF_CFT', obrigatorias: ['CFT_COD', 'DESCR'] },
  { nome: 'REF_VIA_ADMIN', obrigatorias: ['VIA_ADMIN_ID', 'DESCR'] },
  { nome: 'REF_SUBSTANCIA', obrigatorias: ['SUBST_ID', 'DESCR'], opcional: true },
  { nome: 'REF_UNIDADE', obrigatorias: ['DESCR'], opcional: true },
  { nome: 'REF_ESTADO_COMERC', obrigatorias: ['EST_COMERC_ID', 'DESCR'] },
  { nome: 'REF_TIPO_REGIME', obrigatorias: ['TIPO_REGIME_ID', 'DESCR'] },
  { nome: 'REF_NIVEL_COMPART', obrigatorias: ['NIVEL_COMPART_ID', 'DESCR'] },
  { nome: 'REF_TEMPERATURA_ARMAZ', obrigatorias: ['TEMPERATURA_ARMAZ_ID', 'DESCR'], opcional: true },
];

/** REF_TIPO_PRODUTO */
export const TIPO_PRODUTO: Record<string, string> = {
  '1': 'MUH', '2': 'DM', '3': 'COSMETICO', '4': 'ALIM_ESPECIAL', '5': 'NUTRICAO',
};

/** REF_TIPO_PRECO (só os ativos que usamos) */
export const TIPO_PRECO = { PVP: '1', PRECO_REF: '101', PVP_MAX: '401', PVP_NOTIFICADO: '602' } as const;

/** REF_ESTADO_COMERC 5 = Temporariamente indisponível */
export const ESTADO_COMERC_TEMP_INDISPONIVEL = '5';

/** REF_GRUPO_PRODUTO */
export const GRUPO = { GENERICO: 1, BIOSSIMILAR: 12, AIMUP: 13, BIOLOGICO: 14 } as const;

/** REF_SUBGRUPO_PRODUTO: fórmulas com faixa etária infantil */
export const SUBGRUPOS_PEDIATRICOS = new Set([99, 100, 101, 102, 103]);

/**
 * REF_CLASS_DISPENSA_PROD -> regime_dispensa, por ordem de restrição (maior primeiro).
 * Um produto com várias classificações fica com a mais restritiva.
 */
export const CLASS_DISPENSA: { ids: number[]; regime: string; precisaReceita: boolean; tipoVenda: string }[] = [
  { ids: [5, 10, 11, 12], regime: 'COM_RECEITA_RESTRITA', precisaReceita: true, tipoVenda: 'MSRM' },
  { ids: [4], regime: 'COM_RECEITA_ESPECIAL', precisaReceita: true, tipoVenda: 'MSRM' },
  { ids: [6], regime: 'COM_RECEITA', precisaReceita: true, tipoVenda: 'MSRM' },
  // MSRM-EF: pode ser dispensado sem receita por protocolo, mas conta como receita (regra conservadora)
  { ids: [7], regime: 'RECEITA_OU_PROTOCOLO', precisaReceita: true, tipoVenda: 'MSRM' },
  { ids: [8], regime: 'SEM_RECEITA_SO_FARMACIA', precisaReceita: false, tipoVenda: 'MNSRM' },
  { ids: [1], regime: 'SEM_RECEITA_LIVRE', precisaReceita: false, tipoVenda: 'MNSRM' },
];

/** Inferência de público pediátrico pela designação (fonte INFERIDO_DESIGNACAO). */
export const REGEX_PEDIATRICO =
  /(?<![\p{L}])(pedi[aá]tric[oa]s?|infantil|infantis|beb[eé]s?|crian[çc]as?|lactentes?|kids|junior)(?![\p{L}])/iu;

/** Campos de ProdutoCits seguidos no histórico. */
export const CAMPOS_HISTORICO = [
  'regime_dispensa', 'precisa_receita', 'eh_generico', 'dci', 'gh_codigo',
  'pvp_oficial', 'pvp_max', 'preco_referencia', 'comparticipacoes',
  'estado_comercializacao', 'data_prevista_reposicao', 'estado_aim', 'fim_escoamento',
] as const;

/** Rejeita a carga se o nº de embalagens cair mais do que isto face à carga anterior. */
export const QUEDA_MAXIMA_EMBALAGENS = 0.2;
