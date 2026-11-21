import type { ProdutoAlvo } from './types';
import { PATOLOGIAS, SINTOMAS } from './vocabulario';

export const SYSTEM_PROMPT = `És um assistente de catalogação para farmácias comunitárias em Portugal.
A tua tarefa: identificar UM produto concreto (pelo CNP e pela designação) e recolher, de fontes públicas, a sua composição, finalidade e público-alvo.

REGRAS DE PESQUISA (obrigatórias)
1. A primeira pesquisa usa o CNP e a designação tal como te são dados. Não acrescentes substâncias, modelos, marcas ou palavras que não estejam na designação. Nunca pesquises uma suposição.
2. Prefere páginas web HTML: farmácias online portuguesas que mostrem o CNP (ex.: farmaciasportuguesas.pt, farmaciasreisbarata.pt, farmaciagondomar.pt) · páginas de informação farmacêutica (ex.: indice.eu) · páginas públicas do Infarmed (www.infarmed.pt) · site do fabricante · páginas HTML da EMA.
3. Não uses extranet.infarmed.pt.
4. Depois de pesquisar, ABRE (web_fetch) a página web que vais usar como fonte. REGRA CRÍTICA: NUNCA abras ficheiros PDF (como 'product-information_*.pdf' da EMA ou folhetos PDF com dezenas de páginas), pois excedem o limite de tokens da API (200k) e provocam erro. Abre exclusivamente páginas web HTML. Só podes citar texto de páginas que abriste.
5. Confirma que a página fala deste produto: CNP igual, ou mesmo nome comercial + mesma dosagem/forma. Se não conseguires confirmar, devolve encontrado=false.

REGRAS DE EXTRAÇÃO
6. Cada patologia, sintoma, sexo e idade tem de ter "evidencia": uma frase COPIADA LITERALMENTE da página (até 200 caracteres), e o "url" de onde saiu. Sem frase literal, não incluas o item.
7. Usa os termos do vocabulário abaixo. Se nenhum servir, cria um termo curto em snake_case (será revisto).
8. Não infiras. Se a fonte não diz a idade mínima, deixa null. Não traduzas indicações para conceitos que a fonte não menciona.
9. Para medicamentos, indica a DCI e o ATC só se aparecerem na fonte (copia o código ATC tal como está escrito).
11. Não classifiques o produto em categorias: isso é feito por nós.
10. No fim chama SEMPRE a ferramenta registar_perfil, uma única vez.

VOCABULÁRIO — patologias: ${PATOLOGIAS.join(', ')}
VOCABULÁRIO — sintomas: ${SINTOMAS.join(', ')}`;

export function mensagemProduto(p: ProdutoAlvo): string {
  return [
    `CNP: ${p.cnp_codigo}`,
    `Designação: ${p.designacao}`,
    p.laboratorio_titular ? `Laboratório (pode estar desatualizado): ${p.laboratorio_titular}` : null,
    p.tipo_venda ? `Tipo de venda no nosso catálogo: ${p.tipo_venda}` : null,
    `Tipo de produto esperado: ${p.via === 'MEDICAMENTO' ? 'medicamento' : 'produto de venda livre (suplemento, dermocosmética, dispositivo, higiene...)'}`,
  ].filter(Boolean).join('\n');
}

const itemEvidencia = {
  type: 'object',
  properties: {
    termo: { type: 'string' },
    evidencia: { type: 'string', description: 'Frase copiada literalmente da página.' },
    url: { type: 'string' },
  },
  required: ['termo', 'evidencia', 'url'],
};

export const REGISTAR_PERFIL_TOOL = {
  name: 'registar_perfil',
  description: 'Regista o perfil do produto. Chamar uma única vez, no fim.',
  input_schema: {
    type: 'object',
    properties: {
      encontrado: { type: 'boolean' },
      motivo_nao_encontrado: { type: ['string', 'null'] },
      produto_confirmado: {
        type: ['object', 'null'],
        properties: {
          nome_na_fonte: { type: 'string' },
          cnp_na_fonte: { type: ['string', 'null'] },
        },
      },
      tipo_produto: {
        type: ['string', 'null'],
        enum: ['medicamento', 'medicamento_homeopatico', 'medicamento_plantas', 'suplemento', 'dermocosmetica',
          'dispositivo_medico', 'higiene', 'alimentacao_infantil', 'outro', null],
      },
      composicao: {
        type: 'array',
        items: { type: 'object', properties: { substancia: { type: 'string' }, dosagem: { type: ['string', 'null'] } }, required: ['substancia'] },
      },
      dci: { type: ['string', 'null'] },
      atc: { type: ['string', 'null'] },
      forma: { type: ['string', 'null'] },
      via_administracao: { type: ['string', 'null'] },
      finalidade_curta: { type: ['string', 'null'], description: 'Até 8 palavras, ex.: "laxante de contacto", "probiótico flora vaginal".' },
      finalidade_evidencia: { type: ['string', 'null'] },
      patologias: { type: 'array', items: itemEvidencia },
      sintomas: { type: 'array', items: itemEvidencia },
      publico: {
        type: ['object', 'null'],
        properties: {
          sexo: { type: ['string', 'null'], enum: ['F', 'M', 'ambos', null] },
          sexo_evidencia: { type: ['string', 'null'] },
          idade_min_meses: { type: ['integer', 'null'] },
          idade_evidencia: { type: ['string', 'null'] },
        },
      },
      tipo_venda_fonte: { type: ['string', 'null'], enum: ['MSRM', 'MNSRM', 'MNSRM_EF', 'nao_medicamento', 'desconhecido', null] },
      fontes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            titulo: { type: ['string', 'null'] },
            tipo: { type: 'string', enum: ['ema', 'infarmed_publico', 'fabricante', 'folheto_pt_espelho', 'farmacia_pt', 'regulador_estrangeiro', 'retalho_estrangeiro', 'outro'] },
            data_documento: { type: ['string', 'null'] },
          },
          required: ['url', 'tipo'],
        },
      },
    },
    required: ['encontrado'],
  },
} as const;
