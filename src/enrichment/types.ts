export type Via = 'MEDICAMENTO' | 'VENDA_LIVRE';

export interface ProdutoAlvo {
  cnp_codigo: string;
  designacao: string;
  tipo_venda: string | null;
  laboratorio_titular: string | null;
  dci: string | null;
  categoria: string | null;
  subcategoria: string | null;
  via: Via;
}

export type TipoFonte =
  | 'ema'
  | 'infarmed_publico'
  | 'fabricante'
  | 'folheto_pt_espelho'
  | 'farmacia_pt'
  | 'retalho_estrangeiro'
  | 'regulador_estrangeiro'
  | 'outro';

export interface ItemEvidencia {
  termo: string;
  evidencia: string; // frase copiada literalmente da página
  url: string;
}

/** O que o modelo devolve na ferramenta registar_perfil. */
export interface PerfilModelo {
  encontrado: boolean;
  motivo_nao_encontrado?: string | null;
  produto_confirmado?: { nome_na_fonte: string; cnp_na_fonte?: string | null } | null;
  tipo_produto?: string | null;
  composicao?: { substancia: string; dosagem?: string | null }[];
  dci?: string | null;
  atc?: string | null;
  forma?: string | null;
  via_administracao?: string | null;
  finalidade_curta?: string | null;
  finalidade_evidencia?: string | null;
  patologias?: ItemEvidencia[];
  sintomas?: ItemEvidencia[];
  publico?: {
    sexo?: 'F' | 'M' | 'ambos' | null;
    sexo_evidencia?: string | null;
    idade_min_meses?: number | null;
    idade_evidencia?: string | null;
  } | null;
  tipo_venda_fonte?: string | null;
  fontes?: { url: string; titulo?: string | null; tipo: TipoFonte; data_documento?: string | null }[];
}

/** Texto efetivamente obtido nesta execução (páginas lidas + excertos citados). */
export interface Corpus {
  texto: string;          // tudo concatenado
  urlsLidas: Set<string>; // URLs com conteúdo devolvido por web_fetch
  urlsVistas: Set<string>;// URLs que apareceram em resultados de pesquisa
}

export interface ResultadoValidacao {
  estado: 'ativo_provisorio' | 'revisao' | 'nao_encontrado';
  confianca: 'alta' | 'media' | 'baixa';
  correspondencia: 'cnp' | 'nome' | 'nenhum';
  patologias: ItemEvidencia[];
  sintomas: ItemEvidencia[];
  publico: PerfilModelo['publico'];
  finalidade: string | null;
  atc: string | null;
  rejeitados: { campo: string; valor: unknown; motivo: string }[];
  termosNovos: string[];
  motivos: string[];
}
