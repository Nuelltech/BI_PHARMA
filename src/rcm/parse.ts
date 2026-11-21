/**
 * Leitura de documentos de medicamento (RCM, FI, MMR) a partir do texto extraído do PDF.
 * Puro: sem ficheiros nem base de dados, para poder ser testado.
 *
 * Os RCM aprovados em Portugal seguem o modelo QRD (EMA/Infarmed): secções numeradas fixas.
 * A divisão procura cada título por ordem, a seguir ao anterior, o que evita confundir
 * listas numeradas dentro do texto com títulos de secção.
 */
import { createHash } from 'node:crypto';

export type TipoDocumento = 'RCM' | 'FI' | 'MMR' | 'DESCONHECIDO';

export interface Seccao {
  numero: string;
  titulo: string;
  texto: string;
  texto_hash: string;
}

export interface DocumentoLido {
  tipo: TipoDocumento;
  seccoes: Seccao[];
  seccoes_em_falta: string[];
  cnps: string[];               // números de registo (7 dígitos) da secção 8
  nome: string | null;          // secção 1
  composicao: string | null;    // secção 2 (resumo)
  data_revisao: string | null;  // secção 10, AAAA-MM-DD quando reconhecível
  data_aprovacao: string | null; // carimbo "APROVADO EM dd-mm-aaaa INFARMED" mais recente
  modelo_por_preencher: boolean; // ex.: "Registo n.º xxxxxxx", "<{DD/MM/AAAA}>"
  caracteres: number;
}

/** Secções do RCM (modelo QRD). `chave` = início do título sem acentos, em minúsculas. */
export const SECCOES_RCM: { numero: string; chave: string; titulo: string; semNumero?: boolean }[] = [
  // `chave`: expressão sobre o texto sem acentos e em minúsculas. Aceita a grafia anterior ao
  // Acordo Ortográfico ("contra-indicações", "interacções") e variantes reais de títulos.
  { numero: '1', chave: 'nome do medicamento', titulo: 'Nome do medicamento' },
  { numero: '2', chave: 'composicao qualitativa e quantitativa', titulo: 'Composição qualitativa e quantitativa' },
  { numero: '3', chave: 'forma farmaceutica', titulo: 'Forma farmacêutica' },
  { numero: '4', chave: 'informacoes clinicas', titulo: 'Informações clínicas' },
  { numero: '4.1', chave: 'indicacoes terapeuticas', titulo: 'Indicações terapêuticas' },
  { numero: '4.2', chave: 'posologia', titulo: 'Posologia e modo de administração' },
  { numero: '4.3', chave: 'contra-?indicac?coes', titulo: 'Contraindicações', semNumero: true },
  { numero: '4.4', chave: 'advertencias', titulo: 'Advertências e precauções especiais de utilização' },
  { numero: '4.5', chave: 'interac?coes', titulo: 'Interações medicamentosas e outras formas de interação' },
  { numero: '4.6', chave: '(fertilidade,? )?gravidez', titulo: 'Fertilidade, gravidez e aleitamento' },
  { numero: '4.7', chave: 'efeitos sobre a capacidade', titulo: 'Efeitos sobre a capacidade de conduzir e utilizar máquinas' },
  { numero: '4.8', chave: 'efeitos indesejaveis', titulo: 'Efeitos indesejáveis' },
  { numero: '4.9', chave: 'sobredosagem', titulo: 'Sobredosagem' },
  { numero: '5', chave: 'propriedades farmacologicas', titulo: 'Propriedades farmacológicas' },
  { numero: '5.1', chave: 'propriedades farmacodinamicas', titulo: 'Propriedades farmacodinâmicas' },
  { numero: '5.2', chave: 'propriedades farmacocineticas', titulo: 'Propriedades farmacocinéticas' },
  { numero: '5.3', chave: 'dados de seguranca pre', titulo: 'Dados de segurança pré-clínica' },
  { numero: '6', chave: 'informacoes farmaceuticas', titulo: 'Informações farmacêuticas' },
  { numero: '6.1', chave: 'lista d[eo]s? excipientes', titulo: 'Lista dos excipientes' },
  { numero: '6.2', chave: 'incompatibilidades', titulo: 'Incompatibilidades' },
  { numero: '6.3', chave: 'prazo de validade', titulo: 'Prazo de validade' },
  { numero: '6.4', chave: 'precau?c?coes especiais de conservacao', titulo: 'Precauções especiais de conservação' },
  { numero: '6.5', chave: 'natureza e conteudo', titulo: 'Natureza e conteúdo do recipiente' },
  { numero: '6.6', chave: 'precau?c?coes especiais (de|para) (a )?eliminacao', titulo: 'Precauções especiais de eliminação e manuseamento' },
  { numero: '7', chave: 'titular da autorizacao de introducao', titulo: 'Titular da autorização de introdução no mercado' },
  { numero: '8', chave: 'numero', titulo: 'Número(s) da autorização de introdução no mercado' },
  { numero: '9', chave: 'data da primeira autorizacao', titulo: 'Data da primeira autorização/renovação' },
  { numero: '10', chave: 'data da revisao do texto', titulo: 'Data da revisão do texto', semNumero: true },
];

/** Secções sem as quais o RCM não serve para extração e vai para revisão. */
export const SECCOES_ESSENCIAIS = ['1', '4.1', '4.2', '8'];

export const semAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Junta hífens de translineação, normaliza espaços e quebras. */
export function limparTexto(t: string): string {
  return t
    .normalize('NFC')                       // índices iguais entre o texto e a versão sem acentos
    .replace(/­/g, '')                 // hífen suave
    .replace(/(\p{L})-\n(\p{L})/gu, '$1$2') // trans-\nlineação
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hashTexto(t: string): string {
  const norm = semAcentos(t).toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(norm).digest('hex');
}

export function detetarTipo(texto: string): TipoDocumento {
  const inicio = semAcentos(texto.slice(0, 3000)).toLowerCase().replace(/\s+/g, ' ');
  if (inicio.includes('resumo das caracteristicas do medicamento')) return 'RCM';
  if (inicio.includes('folheto informativo')) return 'FI';
  if (/minimiza(c|ç)ao (adicional )?d[eo]s? riscos?|materia(l|is) educaciona/.test(inicio)) return 'MMR';
  // RCM sem cabeçalho: começa diretamente em "1. NOME DO MEDICAMENTO"
  if (/(^|\n|\s)1\.?\s+nome do medicamento/.test(inicio)) return 'RCM';
  return 'DESCONHECIDO';
}

/**
 * Procura o título de uma secção a partir de `desde`. Aceita "4.1 Indicações", "4.1. INDICAÇÕES",
 * e título na linha seguinte ao número. Devolve [início do título, fim do título].
 */
function procurarTitulo(textoNorm: string, numero: string, chave: string, desde: number, semNumero = false): [number, number] | null {
  const num = numero.replace('.', '\\.');
  const chaveRe = chave.replace(/ /g, '\\s+');
  const sep = '(?:\\.\\s*|\\s+)';  // "4.1 X", "4.1. X", "4.X"
  // 1.º número no início de linha; 2.º (quando a extração junta linhas) após espaço,
  // mas não em remissões do tipo "ver secção 4.3 contraindicações".
  const padroes = [
    new RegExp(`(^|\\n)${num}${sep}${chaveRe}`, 'gi'),
    new RegExp(`(\\s)(?<!sec{1,2}ao\\s|sec{1,2}oes\\s|\\sver\\s|\\se\\s|\\sa\\s)${num}${sep}${chaveRe}`, 'gi'),
  ];
  // título sem número: só se ocupar a linha inteira ("Contraindicações", "DATA DA REVISÃO DO TEXTO")
  if (semNumero) padroes.push(new RegExp(`(^|\\n)${chaveRe}[ \\t]*(?=\\n|$)`, 'gi'));
  let m: RegExpExecArray | null = null;
  for (const re of padroes) {
    re.lastIndex = desde;
    m = re.exec(textoNorm);
    if (m) break;
  }
  if (!m) return null;
  const inicio = m.index + m[1].length;
  const fimLinha = textoNorm.indexOf('\n', m.index + m[0].length);
  return [inicio, fimLinha === -1 ? m.index + m[0].length : fimLinha];
}

export function dividirSeccoes(texto: string): { seccoes: Seccao[]; em_falta: string[] } {
  // Mesmo comprimento que o original: os índices servem para cortar o texto original
  const norm = semAcentos(texto).toLowerCase();
  const encontradas: { def: (typeof SECCOES_RCM)[number]; ini: number; fimTitulo: number }[] = [];
  let pos = 0;
  for (const def of SECCOES_RCM) {
    const r = procurarTitulo(norm, def.numero, def.chave, pos, def.semNumero);
    if (!r) continue;
    encontradas.push({ def, ini: r[0], fimTitulo: r[1] });
    pos = r[1];
  }
  const seccoes: Seccao[] = encontradas.map((s, i) => {
    const fim = i + 1 < encontradas.length ? encontradas[i + 1].ini : texto.length;
    const corpo = texto.slice(s.fimTitulo, fim).trim();
    return { numero: s.def.numero, titulo: s.def.titulo, texto: corpo, texto_hash: hashTexto(corpo) };
  });
  const achados = new Set(seccoes.map((s) => s.numero));
  return { seccoes, em_falta: SECCOES_RCM.map((s) => s.numero).filter((n) => !achados.has(n)) };
}

/** Números de registo de 7 dígitos (aceita "5782214" e "57 82 214" não; só contíguos). */
export function extrairCnps(texto: string): string[] {
  const nums = texto.match(/(?<!\d)\d{7}(?!\d)/g) ?? [];
  return [...new Set(nums)].sort();
}

const MESES: Record<string, string> = {
  janeiro: '01', fevereiro: '02', marco: '03', abril: '04', maio: '05', junho: '06',
  julho: '07', agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
};

export function extrairData(texto: string): string | null {
  const t = semAcentos(texto).toLowerCase();
  let m = t.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/(?:(\d{1,2})\s+de\s+)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+(?:de\s+)?(\d{4})/);
  if (m) return `${m[3]}-${MESES[m[2]]}-${(m[1] ?? '01').padStart(2, '0')}`;
  m = t.match(/(\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}-01`;
  return null;
}

/** Carimbo de aprovação que o Infarmed põe nas páginas; aparece a meio das secções. */
const RE_CARIMBO = /\n?APROVADO\s+EM\s*(?:(\d{2})-(\d{2})-(\d{4}))?\s*INFARMED/gi;

export function retirarCarimbos(texto: string): { texto: string; data: string | null } {
  const datas: string[] = [];
  const limpo = texto.replace(RE_CARIMBO, (_m, d, mth, a) => {
    if (a) datas.push(`${a}-${mth}-${d}`);
    return '';
  });
  return { texto: limpo.replace(/\n{3,}/g, '\n\n'), data: datas.sort().pop() ?? null };
}

const RE_MODELO = /x{5,}|<\{[^}]*\}>|\{nome da ag[eê]ncia/i;

const primeiraLinha = (t: string | undefined) =>
  t ? t.split('\n').map((l) => l.trim()).find((l) => l.length > 1) ?? null : null;

export function lerDocumento(textoBruto: string): DocumentoLido {
  const { texto, data: data_aprovacao } = retirarCarimbos(limparTexto(textoBruto));
  const tipo = detetarTipo(texto);
  const modelo_por_preencher = RE_MODELO.test(texto);
  if (tipo !== 'RCM') {
    // FI/MMR: documento inteiro; o nome do medicamento é a linha a seguir ao cabeçalho
    return {
      tipo, seccoes: [], seccoes_em_falta: [], cnps: [], nome: tipo === 'FI' ? nomeFolheto(texto) : null,
      composicao: null, data_revisao: null, data_aprovacao, modelo_por_preencher, caracteres: texto.length,
    };
  }
  const { seccoes, em_falta } = dividirSeccoes(texto);
  const s = (n: string) => seccoes.find((x) => x.numero === n)?.texto;
  return {
    tipo,
    seccoes,
    seccoes_em_falta: em_falta,
    cnps: extrairCnps(s('8') ?? ''),
    nome: primeiraLinha(s('1')),
    composicao: s('2') ? s('2')!.slice(0, 500) : null,
    data_revisao: s('10') ? extrairData(s('10')!) : null,
    data_aprovacao,
    modelo_por_preencher,
    caracteres: texto.length,
  };
}

/** "Folheto informativo: Informação para o utilizador" -> linha seguinte = nome do medicamento. */
export function nomeFolheto(texto: string): string | null {
  const linhas = texto.split('\n').map((l) => l.trim());
  const i = linhas.findIndex((l) => /folheto informativo/i.test(semAcentos(l)));
  if (i < 0) return null;
  return linhas.slice(i + 1).find((l) => l.length > 2 && !/informa[cç][aã]o para o (utilizador|doente)/i.test(l)) ?? null;
}

/** Chave para comparar nomes de medicamento entre RCM e FI ("Aciclosina 50 mg/g Creme"). */
export function chaveNome(nome: string | null): string | null {
  if (!nome) return null;
  return semAcentos(nome).toLowerCase().replace(/,/g, '.').replace(/[^a-z0-9.%/+ ]/g, ' ').replace(/\s+/g, ' ').trim();
}
