import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  Cand,
  Calendario,
  CampanhaAtivaRow,
  Cfg,
  GatilhoRes,
  Papel,
  Publico,
  Regra,
  Repo,
  epocaFit,
  precoPromo,
  QUALIDADE_OK,
} from './comercial';
import {
  DCI_RESTRICAO_EXTRA,
  FAMILIA_CATALOGO,
  norm,
  resolverPrecisaReceita,
  resolverProdutoClinico,
} from './product_classification_engine';
import { saveToolResult } from './copilot_result_store';

// ───────────────────────────── Dicionários Locais (Cached) ─────────────────────────────
let _hmrCache: Record<string, any> | null = null;
let _dictCache: Record<string, any> | null = null;
let _infarmedCache: Record<string, any> | null = null;

function getLocalDictionaries() {
  if (!_hmrCache) {
    const dataDir = path.join(process.cwd(), 'src', 'data');
    _hmrCache = JSON.parse(fs.readFileSync(path.join(dataDir, 'firstpharma_hmr_products.json'), 'utf8'));
    _dictCache = JSON.parse(fs.readFileSync(path.join(dataDir, 'firstpharma_dictionary.json'), 'utf8'));
    _infarmedCache = JSON.parse(fs.readFileSync(path.join(dataDir, 'infarmed_mnsrm_official.json'), 'utf8'));
  }
  return { hmr: _hmrCache!, dict: _dictCache!, infarmed: _infarmedCache! };
}

function slugify(s?: string | null): string {
  const n = norm(s);
  if (!n) return 'sem_subcategoria';
  return n.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'sem_subcategoria';
}

// ───────────────────────────── Configuração Clínica Global ─────────────────────────────
export const FAMILIA_RESTRICAO: Record<string, string[]> = {
  ANTICOAGULANTE_ANTIAGREGANTE: ['aine', 'interage_anticoagulante'],
  ANTIHIPERTENSOR: ['aine', 'vasoconstritor', 'contem_regaliz'],
  DIURETICO: ['aine', 'vasoconstritor', 'contem_regaliz'],
  CARDIACO_VASCULAR: ['aine', 'vasoconstritor'],
  ANTIDIABETICO: ['contem_acucar'],
  RESPIRATORIO_ASMA_DPOC: ['aine'],
};

export const CONDICAO_RESTRICAO: Record<string, string[]> = {
  DIABETICO: ['contem_acucar'],
  HIPERTENSO: ['aine', 'vasoconstritor', 'contem_regaliz'],
  ANTICOAGULADO: ['aine', 'interage_anticoagulante'],
  GRAVIDA: ['nao_validado_gravidez'],
};

export function buildComercialCfg(): Cfg {
  const familiaPermiteGatilho: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(FAMILIA_CATALOGO)) {
    familiaPermiteGatilho[k] = v.permite_gatilho;
  }
  return {
    familiaPermiteGatilho,
    familiaRestricao: FAMILIA_RESTRICAO,
    dciRestricaoExtra: DCI_RESTRICAO_EXTRA,
    condicaoRestricao: CONDICAO_RESTRICAO,
    minProdutosTema: 3,
  };
}

// ───────────────────────────── 29 Subcategorias com Época ─────────────────────────────
export const SUBCATEGORIA_EPOCA_MAP: Record<string, number[] | null> = {
  protector_solar_adulto: [4, 5, 6, 7, 8, 9],
  inflamacao_garganta: [10, 11, 12, 1, 2, 3],
  auxiliares_de_terapeutica_circulatoria: [5, 6, 7, 8, 9],
  antiqueda_de_cabelo: [9, 10, 11],
  preparacoes_imunologicas_e_anti_oxidantes: [10, 11, 12, 1, 2, 3],
  tratamento_e_cuidado_de_pernas_pesadas: [5, 6, 7, 8, 9],
  descongestionante_nasal: [10, 11, 12, 1, 2, 3],
  expectorantes: [10, 11, 12, 1, 2, 3],
  repelente_de_insectos: [4, 5, 6, 7, 8, 9],
  perda_de_peso: [4, 5, 6, 7],
  protector_labial_sem_factor_proteccao: [10, 11, 12, 1, 2, 3],
  anti_alergicos_respiratorios: [3, 4, 5, 6],
  antitussicos: [10, 11, 12, 1, 2, 3],
  antiparasitario_capilar: [8, 9, 10],
  alivio_da_tosse_seca_e_produtiva: [10, 11, 12, 1, 2, 3],
  protector_labial_com_factor_proteccao: [4, 5, 6, 7, 8, 9],
  antigripais: [10, 11, 12, 1, 2, 3],
  drenantes: [4, 5, 6, 7],
  antialergicos_pele: [3, 4, 5, 6],
  solares_infantil: [4, 5, 6, 7, 8, 9],
  alivio_de_dores_lesoes_pelo_frio: [10, 11, 12, 1, 2, 3],
  repelentes: [4, 5, 6, 7, 8, 9],
  after_sun: [4, 5, 6, 7, 8, 9],
  imunoestimulante_para_a_constipacao: [10, 11, 12, 1, 2, 3],
  antialergico_ocular: [3, 4, 5, 6],
  descongestionante_bronquios: [10, 11, 12, 1, 2, 3],
  ajudas_pelo_frio: [10, 11, 12, 1, 2, 3],
  cuidado_capilar_solar: [4, 5, 6, 7, 8, 9],
  protector_labial_infantil: [10, 11, 12, 1, 2, 3],
};

// ───────────────────────────── Sinónimos de Queixas ─────────────────────────────
export const SINONIMO_QUEIXA: Record<string, string> = {
  'labios gretados': 'LABIOS_SECOS',
  'labios secos': 'LABIOS_SECOS',
  'labios rachados': 'LABIOS_SECOS',
  'cieiro': 'LABIOS_SECOS',
  'boca gretada': 'LABIOS_SECOS',
  'tosse seca': 'TOSSE_SECA',
  'tosse irritativa': 'TOSSE_SECA',
  'tosse nervosa': 'TOSSE_SECA',
  'tosse com catarro': 'TOSSE_CATARRO',
  'tosse com expetoracao': 'TOSSE_CATARRO',
  'tosse produtiva': 'TOSSE_CATARRO',
  'catarro': 'TOSSE_CATARRO',
  'nariz entupido': 'NARIZ_ENTUPIDO',
  'nariz tapado': 'NARIZ_ENTUPIDO',
  'congestao nasal': 'NARIZ_ENTUPIDO',
  'constipacao': 'NARIZ_ENTUPIDO',
  'dor de garganta': 'DOR_GARGANTA',
  'garganta irritada': 'DOR_GARGANTA',
  'garganta inflamada': 'DOR_GARGANTA',
  'rouquidao': 'DOR_GARGANTA',
  'azia': 'AZIA',
  'pirose': 'AZIA',
  'refluxo': 'AZIA',
  'ma digestao': 'AZIA',
  'indigestao': 'AZIA',
  'diarreia': 'DIARREIA',
  'barriga solta': 'DIARREIA',
  'desarranjo': 'DIARREIA',
  'prisao de ventre': 'OBSTIPACAO',
  'obstipacao': 'OBSTIPACAO',
  'intestino preso': 'OBSTIPACAO',
  'olho seco': 'OLHO_SECO',
  'olhos secos': 'OLHO_SECO',
  'olhos irritados': 'OLHO_SECO',
  'olhos cansados': 'OLHO_SECO',
  'pele seca': 'PELE_SECA',
  'pele ressequida': 'PELE_SECA',
  'pele a descamar': 'PELE_SECA',
  'pele rachada': 'PELE_SECA',
  'protetor solar': 'SOL',
  'queimadura solar': 'SOL',
  'after sun': 'SOL',
  'pele queimada do sol': 'SOL',
  'pernas pesadas': 'PERNAS_PESADAS',
  'pernas cansadas': 'PERNAS_PESADAS',
  'inchaco nas pernas': 'PERNAS_PESADAS',
  'queda de cabelo': 'QUEDA_CABELO',
  'cabelo a cair': 'QUEDA_CABELO',
  'cabelo fraco': 'QUEDA_CABELO',
  'cansaco': 'CANSACO',
  'fadiga': 'CANSACO',
  'falta de energia': 'CANSACO',
  'fraqueza': 'CANSACO',
  'dor muscular': 'DOR_MUSCULAR',
  'dores musculares': 'DOR_MUSCULAR',
  'contratura': 'DOR_MUSCULAR',
  'caibras': 'DOR_MUSCULAR',
  'pe de atleta': 'MICOSE_PES',
  'micose no pe': 'MICOSE_PES',
};

const QUEIXA_IDS = new Set(Object.values(SINONIMO_QUEIXA));

// ───────────────────────────── Regras de Afinidade (28 Regras + Complementares) ─────────────────────────────
interface RegraDef extends Regra {
  gatilho_tipo: 'FAMILIA' | 'QUEIXA';
  gatilho_id: string;
  dci_filtro?: string[];
  forma_filtro?: string;
  validada_por?: string | null;
  complementares: { categoria_id: string; subcategoria_regex?: RegExp; papel_cesto: Papel }[];
}

const REGRAS_AFINIDADE_DEF: RegraDef[] = [
  // R01..R12 (MSRM Famílias)
  {
    id: 'R01', gatilho_tipo: 'FAMILIA', gatilho_id: 'ANTIBIOTICO_SISTEMICO', forma_filtro: 'ORAL',
    condicao_aplicacao: 'Durante a toma de antibiótico oral (toma desfasada); hidratação se diarreia',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'FLORA_PROBIOTICOS', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'DIGESTIVO', subcategoria_regex: /hidratacao_oral|reidratacao|antidiarreico/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'R02', gatilho_tipo: 'FAMILIA', gatilho_id: 'ANTIDIABETICO', dci_filtro: ['metformina'],
    condicao_aplicacao: 'Início de terapêutica com metformina / desconforto digestivo',
    exige_publico: false, restricoes_bloqueio_extra: ['contem_acucar'],
    complementares: [
      { categoria_id: 'FLORA_PROBIOTICOS', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'PES', subcategoria_regex: /pe_diabetico|pes|calos|ureia|hidrat/, papel_cesto: 'PRINCIPAL' },
    ],
  },
  {
    id: 'R03', gatilho_tipo: 'FAMILIA', gatilho_id: 'ANTIDIABETICO',
    condicao_aplicacao: 'Uso continuado de antidiabéticos: cuidado podológico e suplementação sem açúcar',
    exige_publico: false, restricoes_bloqueio_extra: ['contem_acucar'],
    complementares: [
      { categoria_id: 'PES', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /complexo_b|vitamina_b|multivitamin|magnesio/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'R04', gatilho_tipo: 'FAMILIA', gatilho_id: 'ESTATINA_HIPOLIPEMIANTE',
    condicao_aplicacao: 'Uso continuado de estatinas: suporte muscular/coenzima Q10',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /coenzima|q10|magnesio|colesterol|anti_oxid/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'R05', gatilho_tipo: 'FAMILIA', gatilho_id: 'ANTIULCEROSO_ANTIACIDO', dci_filtro: ['omeprazol', 'esomeprazol', 'pantoprazol', 'lansoprazol', 'rabeprazol'],
    condicao_aplicacao: 'Uso prolongado de IBP: reposição de magnésio / vitamina B12',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /magnesio|complexo_b|vitamina_b/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'R06', gatilho_tipo: 'FAMILIA', gatilho_id: 'RESPIRATORIO_ASMA_DPOC',
    dci_filtro: ['budesonida', 'fluticasona', 'beclometasona', 'mometasona', 'ciclesonida'], forma_filtro: 'INALACAO',
    condicao_aplicacao: 'Higiene oral após utilização de corticoide inalado',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'HIGIENE_ORAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'R07', gatilho_tipo: 'FAMILIA', gatilho_id: 'ANTIHISTAMINICO',
    condicao_aplicacao: 'Rinite alérgica sazonal: lavagem nasal e hidratação ocular',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'NASAL', subcategoria_regex: /agua_do_mar|lavagem|higiene_nasal/, papel_cesto: 'HIGIENE_BARREIRA' },
      { categoria_id: 'OLHOS', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'R08', gatilho_tipo: 'FAMILIA', gatilho_id: 'OSTEOARTICULAR_OSSEO', dci_filtro: ['alendronato', 'risedronato', 'ibandronato'],
    condicao_aplicacao: 'Uso continuado de bifosfonatos (verificar se cálcio/vitamina D já estão prescritos)',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /calcio|vitamina_d|mineral/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'R09', gatilho_tipo: 'FAMILIA', gatilho_id: 'DERMATOLOGICO_RX',
    condicao_aplicacao: 'Manutenção da barreira cutânea com emoliente e higiene suave sem sabão',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'HIGIENE_CORPORAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'R10', gatilho_tipo: 'FAMILIA', gatilho_id: 'GINECOLOGICO_ANTIINFECCIOSO',
    condicao_aplicacao: 'Higiene íntima suave complementar',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'HIGIENE_INTIMA', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'R11', gatilho_tipo: 'FAMILIA', gatilho_id: 'ANTIANEMICO',
    condicao_aplicacao: 'Suporte com vitamina C e conforto intestinal em terapêutica com ferro',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'DIGESTIVO', subcategoria_regex: /laxante|fibra/, papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /vitamina_c|imunolog/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'R12', gatilho_tipo: 'FAMILIA', gatilho_id: 'CORTICOIDE_SISTEMICO',
    condicao_aplicacao: 'Uso prolongado de corticoide sistémico: suporte ósseo/cálcio e vitamina D',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /calcio|vitamina_d|mineral/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  // Regra R13 para CARDIACO_VASCULAR (ex.: Finerenona) — suporte podológico / monitorização sem açúcar nem AINE
  {
    id: 'R13', gatilho_tipo: 'FAMILIA', gatilho_id: 'CARDIACO_VASCULAR',
    condicao_aplicacao: 'Cuidado cardiovascular e monitorização domiciliária / hidratação cutânea segura',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'DISPOSITIVOS_DIAGNOSTICO', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'HIGIENE_BARREIRA' },
      { categoria_id: 'PES', papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  // Q01..Q16 (Queixas de balcão)
  {
    id: 'Q01', gatilho_tipo: 'QUEIXA', gatilho_id: 'LABIOS_SECOS',
    condicao_aplicacao: 'Reparação e proteção labial (cieiro / exposição solar)',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'LABIAL', papel_cesto: 'PRINCIPAL' },
    ],
  },
  {
    id: 'Q02', gatilho_tipo: 'QUEIXA', gatilho_id: 'TOSSE_SECA',
    condicao_aplicacao: 'Alívio da tosse seca e higiene nasal complementar',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'TOSSE_GRIPE', subcategoria_regex: /antituss|tosse|garganta/, papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'NASAL', subcategoria_regex: /agua_do_mar/, papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'Q03', gatilho_tipo: 'QUEIXA', gatilho_id: 'TOSSE_CATARRO',
    condicao_aplicacao: 'Fluidificação de secreções e lavagem nasal',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'TOSSE_GRIPE', subcategoria_regex: /expector|expetor|tosse/, papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'NASAL', subcategoria_regex: /agua_do_mar/, papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'Q04', gatilho_tipo: 'QUEIXA', gatilho_id: 'NARIZ_ENTUPIDO',
    condicao_aplicacao: 'Lavagem e descongestão nasal',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'NASAL', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /imunolog/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'Q05', gatilho_tipo: 'QUEIXA', gatilho_id: 'DOR_GARGANTA',
    condicao_aplicacao: 'Alívio local da irritação e dor de garganta',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'TOSSE_GRIPE', subcategoria_regex: /garganta/, papel_cesto: 'PRINCIPAL' },
    ],
  },
  {
    id: 'Q06', gatilho_tipo: 'QUEIXA', gatilho_id: 'AZIA',
    condicao_aplicacao: 'Alívio sintomático de azia e refluxo',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'DIGESTIVO', subcategoria_regex: /antiacido|azia|digest/, papel_cesto: 'PRINCIPAL' },
    ],
  },
  {
    id: 'Q07', gatilho_tipo: 'QUEIXA', gatilho_id: 'DIARREIA',
    condicao_aplicacao: 'Reequilíbrio da flora intestinal e reidratação oral',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'FLORA_PROBIOTICOS', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'DIGESTIVO', subcategoria_regex: /hidratacao_oral|antidiarreico/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'Q08', gatilho_tipo: 'QUEIXA', gatilho_id: 'OBSTIPACAO',
    condicao_aplicacao: 'Regulação do trânsito intestinal e flora',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'DIGESTIVO', subcategoria_regex: /laxante|fibra/, papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'FLORA_PROBIOTICOS', papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'Q09', gatilho_tipo: 'QUEIXA', gatilho_id: 'OLHO_SECO',
    condicao_aplicacao: 'Lubrificação e higiene ocular',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'OLHOS', papel_cesto: 'PRINCIPAL' },
    ],
  },
  {
    id: 'Q10', gatilho_tipo: 'QUEIXA', gatilho_id: 'PELE_SECA',
    condicao_aplicacao: 'Emoliência e limpeza suave da pele seca',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'HIGIENE_CORPORAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'Q11', gatilho_tipo: 'QUEIXA', gatilho_id: 'SOL',
    condicao_aplicacao: 'Fotoproteção e cuidado pós-solar',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'SOLARES', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'LABIAL', subcategoria_regex: /com_factor_proteccao/, papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    id: 'Q12', gatilho_tipo: 'QUEIXA', gatilho_id: 'PERNAS_PESADAS',
    condicao_aplicacao: 'Alívio de pernas cansadas e suporte venoso',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'CIRCULACAO', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'ORTOPEDIA', papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'Q13', gatilho_tipo: 'QUEIXA', gatilho_id: 'QUEDA_CABELO',
    condicao_aplicacao: 'Cuidado antiqueda tópico e suplementação capilar',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'CAPILAR', subcategoria_regex: /antiqueda|queda/, papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /biotina|zinco|cabelo|unhas/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'Q14', gatilho_tipo: 'QUEIXA', gatilho_id: 'CANSACO',
    condicao_aplicacao: 'Suplementação para fadiga e energia (respeitando restrição de cafeína)',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /magnesio|multivitamin|tonico|energia|vitamin/, papel_cesto: 'PRINCIPAL' },
    ],
  },
  {
    id: 'Q15', gatilho_tipo: 'QUEIXA', gatilho_id: 'DOR_MUSCULAR',
    condicao_aplicacao: 'Alívio muscular local e suporte com magnésio (sem AINE se anticoagulado/hipertenso)',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'ARTICULAR_MUSCULAR', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /magnesio/, papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    id: 'Q16', gatilho_tipo: 'QUEIXA', gatilho_id: 'MICOSE_PES',
    condicao_aplicacao: 'Cuidado antifúngico e higiene dos pés',
    exige_publico: false, restricoes_bloqueio_extra: [],
    complementares: [
      { categoria_id: 'PES', papel_cesto: 'PRINCIPAL' },
    ],
  },
];

// ───────────────────────────── Calendário Civil + Eixos Estruturados ─────────────────────────────
const FORMAS_TOPICAS_EXCLUIDAS_ORAL = /\b(cr|creme|pomada|bisnaga|gel dermico|gel cutaneo|locao|unguento|pasta cutanea|stick|solucao cutanea)\b/i;

interface CampanhaEixoDef {
  categoria_id: string;
  subcategoria_regex?: RegExp;
  papel_cesto: Papel;
  formas_excluidas?: RegExp;
}

const CALENDARIO_EIXOS: (Calendario & { eixos: CampanhaEixoDef[] })[] = [
  {
    campanha_id: 'imunidade_inverno',
    titulo: 'Imunidade, Gripe & Defesas de Inverno',
    meses_alvo: [11, 12, 1, 2],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 30,
    eixos: [
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', subcategoria_regex: /imunolog|imunoestim|vitamina_c/, papel_cesto: 'PRINCIPAL', formas_excluidas: FORMAS_TOPICAS_EXCLUIDAS_ORAL },
      { categoria_id: 'TOSSE_GRIPE', papel_cesto: 'COMPLEMENTAR', formas_excluidas: FORMAS_TOPICAS_EXCLUIDAS_ORAL },
      { categoria_id: 'NASAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'dia_diabetes',
    titulo: 'Mês da Diabetes & Cuidado Podológico',
    meses_alvo: [11],
    dias_especiais: ['11-14'],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 15,
    eixos: [
      { categoria_id: 'PES', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'DISPOSITIVOS_DIAGNOSTICO', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'novembro_azul',
    titulo: 'Novembro Azul — Saúde Masculina',
    meses_alvo: [11],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 15,
    eixos: [
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'HIGIENE_CORPORAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'black_friday',
    titulo: 'Black Friday — Dermocosmética & Oportunidades',
    meses_alvo: [11],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 20,
    antecedencia_dias: 15,
    eixos: [
      { categoria_id: 'DERMOCOSMETICA_ROSTO', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'HIGIENE_ORAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'natal_coffrets',
    titulo: 'Natal, Coffrets & Bem-Estar Festivo',
    meses_alvo: [11, 12],
    dias_especiais: ['12-25'],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 45,
    eixos: [
      { categoria_id: 'DERMOCOSMETICA_ROSTO', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'DIGESTIVO', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'pele_seca_frio',
    titulo: 'Barreira Cutânea, Lábios & Mãos Contra o Frio',
    meses_alvo: [12, 1, 2, 3],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 30,
    eixos: [
      { categoria_id: 'LABIAL', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'HIGIENE_CORPORAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'primavera_alergias',
    titulo: 'Primavera — Alergias, Olhos & Respiração',
    meses_alvo: [3, 4, 5],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 30,
    eixos: [
      { categoria_id: 'NASAL', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'OLHOS', papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    campanha_id: 'verao_solar',
    titulo: 'Verão Seguro — Fotoproteção & Solares',
    meses_alvo: [5, 6, 7, 8],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 20,
    antecedencia_dias: 30,
    eixos: [
      { categoria_id: 'SOLARES', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'DERMOCOSMETICA_CORPO', subcategoria_regex: /after_sun|hidrat/, papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'LABIAL', subcategoria_regex: /com_factor_proteccao/, papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'micoses_praia_piscina',
    titulo: 'Micoses de Praia, Piscina & Cuidado dos Pés',
    meses_alvo: [7, 8, 9],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 30,
    eixos: [
      { categoria_id: 'PES', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'HIGIENE_CORPORAL', papel_cesto: 'HIGIENE_BARREIRA' },
    ],
  },
  {
    campanha_id: 'outono_queda_capilar',
    titulo: 'Outono — Queda Capilar & Fortalecimento',
    meses_alvo: [9, 10, 11],
    dias_especiais: [],
    tipo: 'EPOCA_CALENDARIO',
    desconto_sugerido_pct: 15,
    antecedencia_dias: 30,
    eixos: [
      { categoria_id: 'CAPILAR', subcategoria_regex: /antiqueda|queda/, papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', papel_cesto: 'COMPLEMENTAR' },
    ],
  },
  {
    campanha_id: 'liquidacao_validades_monos',
    titulo: 'Liquidação Tática — Validades & Monos',
    meses_alvo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    dias_especiais: [],
    tipo: 'LIQUIDACAO_STOCK',
    desconto_sugerido_pct: 20,
    antecedencia_dias: 0,
    eixos: [
      { categoria_id: 'DERMOCOSMETICA_ROSTO', papel_cesto: 'PRINCIPAL' },
      { categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'VITAMINAS_SUPLEMENTOS', papel_cesto: 'COMPLEMENTAR' },
      { categoria_id: 'HIGIENE_CORPORAL', papel_cesto: 'HIGIENE_BARREIRA' },
      { categoria_id: 'SOLARES', papel_cesto: 'PRINCIPAL' },
    ],
  },
];

// ───────────────────────────── Mapeamento hmr3 -> Categoria ─────────────────────────────
const REGRA_CATEGORIA: { regex: RegExp; categoria_id: string; papel_cesto: Papel; publico_default: Publico; iva: number }[] = [
  { regex: /labial|batom|cieiro/, categoria_id: 'LABIAL', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 23 },
  { regex: /agua do mar|lavagem nasal|higiene nasal|preparacoes nasais|descongestionante nasal/, categoria_id: 'NASAL', papel_cesto: 'HIGIENE_BARREIRA', publico_default: 'TODOS', iva: 6 },
  { regex: /dentifrico|escova|elixir|dentadura|protese(s)?|oral care|interdental|fio dentario|estomatol|boca|aftas|higiene oral/, categoria_id: 'HIGIENE_ORAL', papel_cesto: 'HIGIENE_BARREIRA', publico_default: 'ADULTO', iva: 23 },
  { regex: /intima|ginecol|flora vaginal|vaginal/, categoria_id: 'HIGIENE_INTIMA', papel_cesto: 'HIGIENE_BARREIRA', publico_default: 'ADULTO', iva: 23 },
  { regex: /oculos|olho|ocular|lagrimas|lentes|oftalm/, categoria_id: 'OLHOS', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 6 },
  { regex: /solar|protec.{0,3}solar|after sun|autobronz/, categoria_id: 'SOLARES', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 23 },
  { regex: /emolientes|protectores|hidratante corpo|pele seca|corpo|corporal|maos|celulite|estrias/, categoria_id: 'DERMOCOSMETICA_CORPO', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 23 },
  { regex: /anti-?envelhecimento|anti-?rugas|rosto|facial|acne|rosacea|manchas|desmaquilh|limpeza de pele/, categoria_id: 'DERMOCOSMETICA_ROSTO', papel_cesto: 'PRINCIPAL', publico_default: 'ADULTO', iva: 23 },
  { regex: /capilar|cabelo|champo|queda|caspa|piolhos/, categoria_id: 'CAPILAR', papel_cesto: 'PRINCIPAL', publico_default: 'ADULTO', iva: 23 },
  { regex: /pernas|circulat|varizes|hemorroid|venotrop/, categoria_id: 'CIRCULACAO', papel_cesto: 'PRINCIPAL', publico_default: 'ADULTO', iva: 23 },
  { regex: /probiot|flora|fermentos/, categoria_id: 'FLORA_PROBIOTICOS', papel_cesto: 'COMPLEMENTAR', publico_default: 'TODOS', iva: 23 },
  { regex: /vitamin|complexo b|magnes|ferro|zinco|imunolog|anti-?oxid|mineral|calcio|suplement|tonico|energia|vitalidade|omega|colagen|memoria|cerebro|sono|calmante|stress/, categoria_id: 'VITAMINAS_SUPLEMENTOS', papel_cesto: 'COMPLEMENTAR', publico_default: 'ADULTO', iva: 23 },
  { regex: /perda de peso|emagrec|saciedade|drenant/, categoria_id: 'EMAGRECIMENTO', papel_cesto: 'PRINCIPAL', publico_default: 'ADULTO', iva: 23 },
  { regex: /tosse|garganta|constipac|gripe|expetor|expector|antituss|antigrip/, categoria_id: 'TOSSE_GRIPE', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 6 },
  { regex: /\bdor\b|analges|febre|antipiret|anti-?inflam/, categoria_id: 'DOR_FEBRE', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 6 },
  { regex: /azia|antiacid|digest|obstip|laxant|diarreia|hidratacao oral|flatulencia|hepat/, categoria_id: 'DIGESTIVO', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 6 },
  { regex: /olho|ocular|lagrimas|lentes|oftalm/, categoria_id: 'OLHOS', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 6 },
  { regex: /ouvido|cerume|otic|auricular/, categoria_id: 'OUVIDOS', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 23 },
  { regex: /pe diabetico|\bpes\b|calos|joanete|micose|antifung/, categoria_id: 'PES', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 23 },
  { regex: /muscul|articul|torcadura|contusao|reumat/, categoria_id: 'ARTICULAR_MUSCULAR', papel_cesto: 'PRINCIPAL', publico_default: 'ADULTO', iva: 6 },
  { regex: /biberao|chupeta|puericultura|papa|bebe|fralda/, categoria_id: 'PUERICULTURA', papel_cesto: 'PRINCIPAL', publico_default: 'PEDIATRICO', iva: 23 },
  { regex: /gravidez|pos-?parto|amament|mamilo/, categoria_id: 'MATERNIDADE', papel_cesto: 'PRINCIPAL', publico_default: 'ADULTO', iva: 23 },
  { regex: /protecao sexual|preservativ/, categoria_id: 'SEXUALIDADE', papel_cesto: 'PRINCIPAL', publico_default: 'ADULTO', iva: 23 },
  { regex: /antisepticos|desinfect|penso|compressa|ligadura|primeiros socorros|cicatriz|ferida/, categoria_id: 'PRIMEIROS_SOCORROS', papel_cesto: 'HIGIENE_BARREIRA', publico_default: 'TODOS', iva: 23 },
  { regex: /termometro|tensiometro|glicemia|tira|lanceta|diagnostico|medicao/, categoria_id: 'DISPOSITIVOS_DIAGNOSTICO', papel_cesto: 'PRINCIPAL', publico_default: 'TODOS', iva: 6 },
  { regex: /meias|cinta|joelheira|ortopedi|tornozeleira/, categoria_id: 'ORTOPEDIA', papel_cesto: 'COMPLEMENTAR', publico_default: 'TODOS', iva: 6 },
  { regex: /gel de banho|sabonete|syndet|higiene corporal|desodorizante/, categoria_id: 'HIGIENE_CORPORAL', papel_cesto: 'HIGIENE_BARREIRA', publico_default: 'TODOS', iva: 23 },
  { regex: /saco|servico|taxa|portes|cartao|vale|consulta/, categoria_id: 'INTERNO_NAO_COMERCIAL', papel_cesto: 'COMPLEMENTAR', publico_default: 'TODOS', iva: 23 },
];

function inferTaxonomia(hmr3?: string | null, designacao?: string | null) {
  const nHmr = norm(hmr3);
  const nDes = norm(designacao);
  const txt = nHmr || nDes;

  let matched = REGRA_CATEGORIA.find((r) => r.regex.test(txt));
  if (!matched && nHmr && nDes) {
    matched = REGRA_CATEGORIA.find((r) => r.regex.test(nDes));
  }

  const categoria_id = matched?.categoria_id ?? 'SEM_CATEGORIA';
  const papel_cesto: Papel = matched?.papel_cesto ?? 'COMPLEMENTAR';
  const iva = matched?.iva ?? 23;

  // Público por regex sobre hmr3 + designacao
  const combined = `${nHmr} ${nDes}`;
  const isPed = /\b(bebe|baby|infantil|ped|pediatrico|pediatrica|pediatric|kids?|crianca|criancas|junior|jr|lactente|lactentes)\b|\d+\s*(meses|anos)/i.test(combined);
  const isAd = /\b(adulto|adultos|mulher|homem|senhora|senior|50\+|man|woman)\b/i.test(combined);
  let publico: Publico = matched?.publico_default ?? 'TODOS';
  if (isPed) publico = 'PEDIATRICO';
  else if (isAd) publico = 'ADULTO';

  return { categoria_id, papel_cesto, publico, iva };
}

// ───────────────────────────── Marcas Raiz Conhecidas para Gatilho Rx ─────────────────────────────
const MARCA_TO_DCI_GATILHO: Record<string, { dci: string; via_default?: string }> = {
  clavamox: { dci: 'amoxicilina + acido clavulanico', via_default: 'Oral' },
  augmentin: { dci: 'amoxicilina + acido clavulanico', via_default: 'Oral' },
  actidox: { dci: 'doxiciclina', via_default: 'Oral' },
  zithromax: { dci: 'azitromicina', via_default: 'Oral' },
  monuril: { dci: 'fosfomicina', via_default: 'Oral' },
  stagid: { dci: 'metformina', via_default: 'Oral' },
  glucophage: { dci: 'metformina', via_default: 'Oral' },
  synjardy: { dci: 'empagliflozina + metformina', via_default: 'Oral' },
  ozempic: { dci: 'semaglutido', via_default: 'IM' },
  kerendia: { dci: 'finerenona', via_default: 'Oral' },
  finerenona: { dci: 'finerenona', via_default: 'Oral' },
  varfarina: { dci: 'varfarina', via_default: 'Oral' },
  xarelto: { dci: 'rivaroxabano', via_default: 'Oral' },
  eliquis: { dci: 'apixabano', via_default: 'Oral' },
  aspirina: { dci: 'acido acetilsalicilico', via_default: 'Oral' },
  tromalyt: { dci: 'acido acetilsalicilico', via_default: 'Oral' },
  triveram: { dci: 'atorvastatina + perindopril + amlodipina', via_default: 'Oral' },
  rozetin: { dci: 'rosuvastatina + ezetimiba', via_default: 'Oral' },
  ferrogradumet: { dci: 'sulfato ferroso', via_default: 'Oral' },
  'ferro-gradumet': { dci: 'sulfato ferroso', via_default: 'Oral' },
  lepicortinolo: { dci: 'prednisolona', via_default: 'Oral' },
  relvar: { dci: 'fluticasona + vilanterol', via_default: 'Inalatória' },
  pulmicort: { dci: 'budesonida', via_default: 'Inalatória' },
  symbicort: { dci: 'budesonida + formoterol', via_default: 'Inalatória' },
};

// ───────────────────────────── Cache de Catálogo Enriquecido por Tenant ─────────────────────────────
interface EnrichedTenantCache {
  ts: number;
  items: Cand[];
  byCnp: Map<string, Cand>;
}
const tenantCatalogCache = new Map<string, EnrichedTenantCache>();
const CACHE_TTL_MS = 60_000;

async function loadTenantCatalog(prisma: PrismaClient, farmaciaId: string): Promise<EnrichedTenantCache> {
  const existing = tenantCatalogCache.get(farmaciaId);
  if (existing && Date.now() - existing.ts < CACHE_TTL_MS) {
    return existing;
  }

  const { hmr, dict, infarmed } = getLocalDictionaries();

  const [rows, mestres] = await Promise.all([
    prisma.martProdutoMetricas.findMany({ where: { farmaciaId } }),
    prisma.produtoMestre.findMany({
      select: {
        cnp_codigo: true,
        designacao: true,
        dci: true,
        dosagem: true,
        forma_farmaceutica: true,
        tipo_venda: true,
        subcategoria: true,
      },
    }),
  ]);

  const mestreByCnp = new Map(mestres.map((m) => [m.cnp_codigo, m]));

  const items: Cand[] = [];
  const byCnp = new Map<string, Cand>();

  for (const r of rows) {
    const m = mestreByCnp.get(r.cnp_codigo);
    if (!m) continue;
    const cnp = m.cnp_codigo;
    const p = hmr[cnp];
    const d = dict[cnp];
    const inf = infarmed[cnp];

    const dciRaw = m.dci || (p && p.dci) || (inf && inf.dci) || null;
    const isDescriptiveDeviceDci = /sensor de monitorizacao|fixativo de protese/.test(norm(dciRaw));
    const hasRealDci = Boolean(dciRaw && !isDescriptiveDeviceDci);
    const formaBd = m.forma_farmaceutica || (inf && inf.forma) || null;
    const formaFp = (p && p.forma) || null;
    const viaFp = (p && p.via) || null;
    const hmr3 = (p && p.hmr3) || (d && d.c) || null;

    // 1. Conservative precisa_receita
    const rxRes = resolverPrecisaReceita({
      in_infarmed_mnsrm: Boolean(inf),
      fp_m: d ? d.m : null,
      sifarma_tipo_venda: m.tipo_venda,
      has_dci: hasRealDci,
      has_atc_gh: Boolean(p && p.atc_gh),
      has_med_forma: Boolean(formaBd || formaFp),
      has_hmr3: Boolean(hmr3 && hmr3 !== 'MSRM'),
    });

    // 2. Suspect 1b check: m=0, Sifarma != MSRM, outside Infarmed MNSRM, dose/strict med form, hmr3 not parafarmácia -> CONFLITO_RX
    const DOSE_MED_REGEX = /\b\d+([.,]\d+)?\s?(mg|µg|mcg|u\.?i\.?)(\/m?l|\/g|\/dose|\/24\s*h)?\b/i;
    const FORMA_MED_ESTRITA_REGEX = /^(comp|comp revest|comp revest pelic|comprimido|caps|caps lm|capsula|colirio|supositorio|ovulo|sol injetavel|po inal)/i;
    const HMR3_PARAFARMACIA_REGEX = /cosmet|rosto|corpo|capilar|champo|solar|higiene|dent|escova|bebe|puericultura|chupeta|biberon|fralda|ortoped|meias|cinta|joelheira|penso|compressa|ligadura|termometro|tensiometro|glicemia|tira|preservativ|sexual|suplement|vitamin|mineral|magnes|probiot|flora|emagrec|drenant|celulite|perfum|batom|labial|maos|pes|calos|ouvido|cerume|oculos|cadeira|incontinencia|algalia|saco/i;

    let precisa_receita = rxRes.precisa_receita;
    let qualidade_classificacao: string = rxRes.estado_rx;
    let permite_marketing = rxRes.permite_marketing;

    if (!inf && !precisa_receita && (!d || d.m === 0)) {
      const hasDose = DOSE_MED_REGEX.test(m.designacao);
      const hasStrictForma = FORMA_MED_ESTRITA_REGEX.test(norm(formaBd || formaFp || ''));
      const hmr3IsPara = hmr3 ? HMR3_PARAFARMACIA_REGEX.test(norm(hmr3)) : false;
      if ((hasDose || hasStrictForma) && !hmr3IsPara) {
        precisa_receita = true;
        qualidade_classificacao = 'CONFLITO_RX';
        permite_marketing = false;
      }
    }

    // 3. Taxonomy & Clinical Resolver
    const tax = inferTaxonomia(hmr3, m.designacao);
    const clin = resolverProdutoClinico({
      precisa_receita,
      dci_raw: hasRealDci ? dciRaw : null,
      via_fp: viaFp,
      forma_bd: formaBd,
      forma_fp: formaFp,
      dosagem: m.dosagem || (p && p.dosagem) || null,
      designacao: m.designacao,
      hmr3,
      categoria_id: precisa_receita ? null : tax.categoria_id,
    });

    if (clin.uso_veterinario || tax.categoria_id === 'INTERNO_NAO_COMERCIAL') {
      permite_marketing = false;
    }

    const stock = Number(r.stock_total_unidades || 0);
    const custo = Number(r.custo_unitario_medio || 0);
    const pvp = Number(r.pvp || 0);
    const margem_pct = pvp > 0 && custo > 0 ? Number((((pvp - custo) / pvp) * 100).toFixed(1)) : Number(r.margem_padrao || 0);

    const valDateStr = r.data_validade_mais_proxima ? r.data_validade_mais_proxima.toISOString().slice(0, 10) : null;
    const mesesAteVal = valDateStr
      ? Number(Math.max(0, (Date.parse(valDateStr) - Date.now()) / (30.4375 * 86_400_000)).toFixed(1))
      : null;

    const SUB_VAGAS = new Set(['geral', 'terapeutica cronica / geral', 'msrm', 'mnsrm']);
    const subBd = m.subcategoria && !SUB_VAGAS.has(norm(m.subcategoria)) ? m.subcategoria : null;
    const sub = subBd || hmr3;

    const cand: Cand = {
      cnp_codigo: cnp,
      designacao: m.designacao,
      categoria_id: tax.categoria_id,
      subcategoria_id: slugify(sub),
      finalidade_curta: sub && sub !== 'MSRM' ? sub : tax.categoria_id.replace(/_/g, ' ').toLowerCase(),
      papel_cesto: tax.papel_cesto,
      publico: tax.publico,
      precisa_receita,
      permite_marketing,
      permite_desconto_promo: !precisa_receita && !inf && permite_marketing, // MNSRM (inf) default false for promo discounts, parafarmácia true
      uso_veterinario: clin.uso_veterinario,
      qualidade_classificacao,
      tags_presentes: clin.tags_presentes,
      tags_desconhecidas: clin.tags_desconhecidas,
      stock_total_unidades: stock,
      pvp,
      custo_unitario_medio: custo,
      taxa_iva: inf ? 6 : tax.iva,
      margem_pct,
      eh_risco_caducidade: Boolean(r.eh_risco_caducidade),
      data_validade_mais_proxima: valDateStr,
      meses_ate_validade: mesesAteVal,
      eh_mono: Boolean(r.eh_mono),
      dias_sem_vendas: r.dias_sem_vendas ?? null,
      eh_excesso_cobertura: Boolean(r.eh_excesso_cobertura),
      cobertura_meses: r.cobertura_meses != null ? Number(r.cobertura_meses) : null,
      eh_resto_gaveta: stock >= 1 && stock <= 2 && Number(r.total_unidades_vendidas || 0) <= 2,
    };

    items.push(cand);
    byCnp.set(cnp, cand);
  }

  const cacheObj = { ts: Date.now(), items, byCnp };
  tenantCatalogCache.set(farmaciaId, cacheObj);
  return cacheObj;
}

// ───────────────────────────── Helpers Partilhados p/ Dashboard & Marketing ─────────────────────────────
export const CATEGORIA_LABELS: Record<string, string> = {
  LABIAL: 'Cuidado Labial',
  NASAL: 'Higiene & Cuidado Nasal',
  HIGIENE_ORAL: 'Higiene Oral',
  HIGIENE_INTIMA: 'Higiene Íntima',
  SOLARES: 'Fotoproteção & Solares',
  DERMOCOSMETICA_CORPO: 'Dermocosmética Corpo',
  DERMOCOSMETICA_ROSTO: 'Dermocosmética Rosto',
  CAPILAR: 'Cuidado Capilar',
  CIRCULACAO: 'Circulação & Pernas',
  FLORA_PROBIOTICOS: 'Flora & Probióticos',
  VITAMINAS_SUPLEMENTOS: 'Vitaminas & Suplementos',
  EMAGRECIMENTO: 'Controlo de Peso',
  TOSSE_GRIPE: 'Tosse, Garganta & Gripe',
  DOR_FEBRE: 'Alívio da Dor & Febre',
  DIGESTIVO: 'Saúde Digestiva',
  OLHOS: 'Óptica & Cuidado Ocular',
  OUVIDOS: 'Higiene Auricular',
  PES: 'Podologia & Pés',
  ARTICULAR_MUSCULAR: 'Articular & Muscular',
  PUERICULTURA: 'Puericultura & Bebé',
  MATERNIDADE: 'Maternidade',
  SEXUALIDADE: 'Saúde Sexual',
  PRIMEIROS_SOCORROS: 'Primeiros Socorros',
  DISPOSITIVOS_DIAGNOSTICO: 'Dispositivos & Diagnóstico',
  ORTOPEDIA: 'Ortopedia',
  HIGIENE_CORPORAL: 'Higiene Corporal',
  INTERNO_NAO_COMERCIAL: 'Interno / Não Comercial',
  SEM_CATEGORIA: 'Sem Categoria Validada',
};

export async function loadEnrichedCatalogMap(prisma: PrismaClient, farmaciaId: string): Promise<Map<string, Cand>> {
  const cache = await loadTenantCatalog(prisma, farmaciaId);
  return cache.byCnp;
}

function deriveMacroArea(cand: Cand): 'MSRM' | 'MNSRM_OTC' | 'DERMOCOSMETICA' | 'NUTRICAO_SUPLEMENTOS' | 'DISPOSITIVOS_SAUDE' {
  if (cand.precisa_receita) return 'MSRM';
  const cat = cand.categoria_id;
  if (['DERMOCOSMETICA_ROSTO', 'DERMOCOSMETICA_CORPO', 'SOLARES', 'CAPILAR', 'LABIAL', 'HIGIENE_CORPORAL', 'HIGIENE_INTIMA', 'HIGIENE_ORAL'].includes(cat)) {
    return 'DERMOCOSMETICA';
  }
  if (['VITAMINAS_SUPLEMENTOS', 'FLORA_PROBIOTICOS', 'EMAGRECIMENTO', 'PUERICULTURA', 'MATERNIDADE'].includes(cat)) {
    return 'NUTRICAO_SUPLEMENTOS';
  }
  if (['DISPOSITIVOS_DIAGNOSTICO', 'ORTOPEDIA', 'PRIMEIROS_SOCORROS', 'SEXUALIDADE', 'OLHOS', 'OUVIDOS', 'PES'].includes(cat)) {
    return 'DISPOSITIVOS_SAUDE';
  }
  return 'MNSRM_OTC';
}

function deriveSazonalidade(subcategoriaId: string): 'INVERNO' | 'VERAO' | 'PRIMAVERA' | 'OUTONO' | 'TODO_O_ANO' {
  const meses = SUBCATEGORIA_EPOCA_MAP[subcategoriaId];
  if (!meses || meses.length === 0) return 'TODO_O_ANO';
  if (meses.includes(12) || meses.includes(1)) return 'INVERNO';
  if (meses.includes(7) || meses.includes(8)) return 'VERAO';
  if (meses.includes(4) || meses.includes(5)) return 'PRIMAVERA';
  if (meses.includes(10) || meses.includes(9)) return 'OUTONO';
  return 'TODO_O_ANO';
}

export function buildDeterministicDashboardGuidance(
  cand: Cand,
  opts: {
    contexto: 'CADUCIDADE' | 'MONO' | 'EXCESSO';
    ehGenerico: boolean;
    grupoDci?: string | null;
    refDate?: Date;
  }
): {
  tipoVendaSeguro: 'MSRM' | 'MNSRM' | 'VENDA_LIVRE';
  ehGenericoSeguro: boolean;
  macroArea: 'MSRM' | 'MNSRM_OTC' | 'DERMOCOSMETICA' | 'NUTRICAO_SUPLEMENTOS' | 'DISPOSITIVOS_SAUDE';
  sazonalidade: 'INVERNO' | 'VERAO' | 'PRIMAVERA' | 'OUTONO' | 'TODO_O_ANO';
  categoriaLabel: string;
  subcategoriaLabel: string;
  epocaLabel: 'DENTRO' | 'NEUTRO' | 'FORA';
  acaoRecomendada: string;
} {
  const ref = opts.refDate ?? new Date();
  const ep = epocaFit(cand.subcategoria_id, ref, SUBCATEGORIA_EPOCA_MAP);
  const macroArea = deriveMacroArea(cand);
  const sazonalidade = cand.precisa_receita ? 'TODO_O_ANO' : deriveSazonalidade(cand.subcategoria_id);
  const tipoVendaSeguro: 'MSRM' | 'MNSRM' | 'VENDA_LIVRE' = cand.precisa_receita
    ? 'MSRM'
    : !cand.permite_desconto_promo && cand.qualidade_classificacao === 'OFICIAL'
      ? 'MNSRM'
      : 'VENDA_LIVRE';
  // Só MSRM pode ser exibido como Genérico (MG)
  const ehGenericoSeguro = cand.precisa_receita && opts.ehGenerico;
  const categoriaLabel = cand.precisa_receita
    ? 'Medicamentos Sujeitos a Receita (MSRM)'
    : CATEGORIA_LABELS[cand.categoria_id] || 'Sem Categoria Validada';
  const subcategoriaLabel = cand.precisa_receita
    ? (cand.qualidade_classificacao === 'CONFLITO_RX' ? 'Em revisão DT (CONFLITO_RX)' : 'Regime de Receita Médica')
    : cand.finalidade_curta;

  const base = { tipoVendaSeguro, ehGenericoSeguro, macroArea, sazonalidade, categoriaLabel, subcategoriaLabel, epocaLabel: ep };

  // 1. Uso Veterinário (excluído do Copilot / campanhas humanas)
  if (cand.uso_veterinario) {
    return {
      ...base,
      ehGenericoSeguro: false,
      macroArea: 'DISPOSITIVOS_SAUDE',
      sazonalidade: 'TODO_O_ANO',
      categoriaLabel: 'Uso Veterinário',
      subcategoriaLabel: 'Excluído de campanhas humanas',
      epocaLabel: 'NEUTRO',
      acaoRecomendada: '🐾 [Uso Veterinário] Excluído de campanhas humanas; gerir escoamento na secção veterinária.',
    };
  }

  // 2. CONFLITO_RX (pendente validação do DT)
  if (cand.qualidade_classificacao === 'CONFLITO_RX') {
    return {
      ...base,
      tipoVendaSeguro: 'MSRM',
      ehGenericoSeguro: false,
      macroArea: 'MSRM',
      sazonalidade: 'TODO_O_ANO',
      categoriaLabel: 'Em Revisão DT (CONFLITO_RX)',
      subcategoriaLabel: 'Bloqueado para marketing até confirmação',
      epocaLabel: 'NEUTRO',
      acaoRecomendada: '⚠️ [CONFLITO_RX — Bloqueado] Pendente confirmação do regime de dispensa pelo Diretor Técnico. Proibido incluir em campanhas ou descontos.',
    };
  }

  // 3. MSRM (Genérico vs Marca) — NUNCA sugerir desconto!
  if (cand.precisa_receita) {
    if (ehGenericoSeguro) {
      const dciTxt = opts.grupoDci ? ` (${opts.grupoDci})` : '';
      const acao =
        opts.contexto === 'CADUCIDADE'
          ? `🧬 [MSRM Genérico — Proibido desconto] Priorizar dispensa por Substituição DCI${dciTxt} antes da caducidade ou devolver ao armazenista.`
          : `🧬 [Substituição DCI · Stock ${cand.stock_total_unidades} un.] Priorizar dispensa na receita por princípio ativo${dciTxt} ou devolver excedente (proibido desconto).`;
      return { ...base, epocaLabel: 'NEUTRO', acaoRecomendada: acao };
    }
    const acao =
      opts.contexto === 'CADUCIDADE'
        ? '🔒 [MSRM Marca — Proibido desconto] Travar stock mínimo a zero e solicitar devolução/nota de crédito ao armazenista antes da caducidade.'
        : `🔒 [MSRM Marca — Preço Regulado] Proibido desconto (Infarmed). Ajustar stock mínimo a zero ou devolver excedente (${cand.stock_total_unidades} un.) ao armazenista.`;
    return { ...base, epocaLabel: 'NEUTRO', acaoRecomendada: acao };
  }

  // 4. Não-MSRM sem qualidade validada (REGRA_NAO_VALIDADA / DESCONHECIDO)
  if (!cand.permite_marketing || !QUALIDADE_OK.has(cand.qualidade_classificacao)) {
    return {
      ...base,
      ehGenericoSeguro: false,
      acaoRecomendada: `ℹ️ [Classificação Pendente (${cand.qualidade_classificacao})] Listar para escoamento de balcão sem campanha promocional até validação pelo DT.`,
    };
  }

  // 5. MNSRM (sem desconto promocional por defeito)
  if (!cand.permite_desconto_promo) {
    const acao =
      opts.contexto === 'CADUCIDADE'
        ? `🔵 [MNSRM — Validade Curta] Priorizar dispensa assistida ao balcão em ${categoriaLabel} (sem campanha promocional de desconto).`
        : `🔵 [MNSRM — Aconselhamento Balcão] Priorizar recomendação assistida em ${categoriaLabel} (${cand.stock_total_unidades} un. em stock; sem desconto promocional).`;
    return { ...base, ehGenericoSeguro: false, acaoRecomendada: acao };
  }

  // 6. Venda Livre / Parafarmácia elegível -> calcular PVP Promo anti-dumping determinístico
  const descAlvo = opts.contexto === 'CADUCIDADE' ? 20 : 15;
  const promo = precoPromo(cand, descAlvo);
  const canal = cand.stock_total_unidades <= 2 ? 'Exclusivo Cesto Balcão (≤2 un.)' : 'Balcão / Campanha Loja';
  const epTag = ep === 'FORA' ? ' · 🗓️ Fora de época (apenas liquidação)' : ep === 'DENTRO' ? ' · ✨ Em época' : '';

  if ('excluir' in promo) {
    const acao = `🟡 [${categoriaLabel} · ${canal}${epTag}] Sem margem legal para desconto (anti-dumping ≥ 5% s/ IVA) — escoar a PVP normal (${cand.pvp.toFixed(2)}€).`;
    return { ...base, ehGenericoSeguro: false, acaoRecomendada: acao };
  }

  const limNote = promo.limitado_por_regra_legal ? ' [limitado anti-dumping]' : '';
  const prefix = opts.contexto === 'CADUCIDADE' ? '🔥 [Escoar Validade]' : opts.contexto === 'MONO' ? '🕸️ [Destrava Mono]' : '📦 [Escoar Excesso]';
  const acao = `${prefix} ${categoriaLabel} · ${canal}${epTag} — PVP Promo seguro: ${promo.preco.toFixed(2)}€ (-${promo.desconto_efetivo_pct}%${limNote} · Margem ${promo.margem_pct_promo}% s/ IVA).`;
  return { ...base, ehGenericoSeguro: false, acaoRecomendada: acao };
}

// ───────────────────────────── Fuzzy Queixa Helper ─────────────────────────────
function suggestClosestQueixas(queryNorm: string): string[] {
  const qTokens = new Set(queryNorm.split(' ').filter((t) => t.length >= 3));
  const scored: { termo: string; score: number }[] = [];
  for (const termo of Object.keys(SINONIMO_QUEIXA)) {
    const tTokens = termo.split(' ').filter((t) => t.length >= 3);
    let hits = 0;
    for (const t of tTokens) if (qTokens.has(t)) hits++;
    const score = hits / Math.max(1, qTokens.size + tTokens.length - hits);
    scored.push({ termo, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const seenQ = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    const qid = SINONIMO_QUEIXA[s.termo];
    if (!seenQ.has(qid)) {
      seenQ.add(qid);
      out.push(s.termo);
    }
    if (out.length >= 3) break;
  }
  return out;
}

// ───────────────────────────── Factory do Repo Prisma Real ─────────────────────────────
export function createPrismaComercialRepo(
  prisma: PrismaClient,
  farmaciaId: string,
  sessionId: string,
  turno = 1,
  toolInput: any = {}
): Repo {
  const { hmr, dict, infarmed } = getLocalDictionaries();

  return {
    async resolverGatilho(g: { tipo: string; valor: string }): Promise<GatilhoRes> {
      const val = String(g.valor || '').trim();
      const nVal = norm(val);
      if (!nVal) {
        return { ok: false, codigo: 'GATILHO_NAO_RESOLVIDO', sugestoes: ['lábios secos', 'dor muscular', 'tosse seca'] };
      }

      // 1. Direct Queixa ID or Synonym match
      const upperVal = val.toUpperCase().replace(/\s+/g, '_');
      if (QUEIXA_IDS.has(upperVal)) {
        return { ok: true, tipo: 'queixa', id: upperVal, nome: val, familias: [], dci: [], publico_inferido: null };
      }
      if (SINONIMO_QUEIXA[nVal]) {
        return { ok: true, tipo: 'queixa', id: SINONIMO_QUEIXA[nVal], nome: val, familias: [], dci: [], publico_inferido: null };
      }

      // Check if query contains an exact synonym phrase (e.g. "cliente tem dor muscular")
      for (const [syn, qid] of Object.entries(SINONIMO_QUEIXA)) {
        const rx = new RegExp(`\\b${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (rx.test(nVal)) {
          return { ok: true, tipo: 'queixa', id: qid, nome: syn, familias: [], dci: [], publico_inferido: null };
        }
      }

      // 2. Direct Family ID match
      if (FAMILIA_CATALOGO[upperVal]) {
        return { ok: true, tipo: 'familia', id: upperVal, nome: FAMILIA_CATALOGO[upperVal].nome, familias: [upperVal], dci: [], publico_inferido: null };
      }

      // 3. Brand or DCI lookup (if tipo is 'cnp', 'texto', 'familia', etc.)
      if (/^\d{7}$/.test(val)) {
        const prod = await prisma.produtoMestre.findUnique({
          where: { cnp_codigo: val },
          select: { cnp_codigo: true, designacao: true, dci: true, dosagem: true, forma_farmaceutica: true, tipo_venda: true },
        });
        const p = hmr[val];
        const inf = infarmed[val];
        if (prod || p) {
          const desig = prod?.designacao || p?.nome_completo || val;
          const dciRaw = prod?.dci || p?.dci || inf?.dci || null;
          const res = resolverProdutoClinico({
            precisa_receita: true,
            dci_raw: dciRaw,
            via_fp: p?.via || null,
            forma_bd: prod?.forma_farmaceutica || null,
            forma_fp: p?.forma || null,
            dosagem: prod?.dosagem || p?.dosagem || null,
            designacao: desig,
          });
          return {
            ok: true,
            tipo: 'cnp',
            id: val,
            nome: desig,
            familias: res.familias,
            dci: res.componentes_normalizados,
            publico_inferido: null,
          };
        }
      }

      // 4. Known Brand -> DCI trigger (Clavamox, Metformina, Finerenona, Varfarina, etc.)
      for (const [brand, info] of Object.entries(MARCA_TO_DCI_GATILHO)) {
        if (nVal === brand || nVal.includes(brand)) {
          const res = resolverProdutoClinico({
            precisa_receita: true,
            dci_raw: info.dci,
            via_fp: info.via_default || 'Oral',
            designacao: val,
          });
          return {
            ok: true,
            tipo: 'familia',
            id: res.familia_principal || 'OUTROS_RX',
            nome: val,
            familias: res.familias,
            dci: res.componentes_normalizados,
            publico_inferido: null,
          };
        }
      }

      // 5. Try resolving directly as a DCI string (e.g. "Metformina", "Atorvastatina", "Amoxicilina", "Varfarina", "Finerenona")
      const directClin = resolverProdutoClinico({
        precisa_receita: true,
        dci_raw: val,
        via_fp: 'Oral',
        designacao: val,
      });
      if (directClin.familia_principal && directClin.familia_principal !== 'OUTROS_RX') {
        return {
          ok: true,
          tipo: 'familia',
          id: directClin.familia_principal,
          nome: val,
          familias: directClin.familias,
          dci: directClin.componentes_normalizados,
          publico_inferido: null,
        };
      }

      // 6. Search in ProdutoMestre by designation (only if not clearly an unresolved complaint like "dor no ombro")
      if (g.tipo !== 'queixa' && !/\bdor\b|\btosse\b|\bfebre\b|\bcomichao\b|\bmancha\b/.test(nVal)) {
        const prodMatch = await prisma.produtoMestre.findFirst({
          where: { designacao: { contains: val, mode: 'insensitive' } },
          select: { cnp_codigo: true, designacao: true, dci: true, dosagem: true, forma_farmaceutica: true },
        });
        if (prodMatch) {
          const p = hmr[prodMatch.cnp_codigo];
          const res = resolverProdutoClinico({
            precisa_receita: true,
            dci_raw: prodMatch.dci || p?.dci || null,
            via_fp: p?.via || null,
            forma_bd: prodMatch.forma_farmaceutica || null,
            forma_fp: p?.forma || null,
            dosagem: prodMatch.dosagem || p?.dosagem || null,
            designacao: prodMatch.designacao,
          });
          return {
            ok: true,
            tipo: 'cnp',
            id: prodMatch.cnp_codigo,
            nome: prodMatch.designacao,
            familias: res.familias,
            dci: res.componentes_normalizados,
            publico_inferido: null,
          };
        }
      }

      // Fail closed: GATILHO_NAO_RESOLVIDO with closest suggestions
      return {
        ok: false,
        codigo: 'GATILHO_NAO_RESOLVIDO',
        sugestoes: suggestClosestQueixas(nVal),
      };
    },

    async regrasAtivas(g: Extract<GatilhoRes, { ok: true }>): Promise<Regra[]> {
      const matched: RegraDef[] = [];
      for (const r of REGRAS_AFINIDADE_DEF) {
        // Ignora regras que não estejam explicitamente validadas (se validada_por for null)
        if (r.validada_por === null) continue;

        if (g.tipo === 'queixa' && r.gatilho_tipo === 'QUEIXA' && r.gatilho_id === g.id) {
          matched.push(r);
        } else if (g.tipo !== 'queixa' && r.gatilho_tipo === 'FAMILIA' && g.familias.includes(r.gatilho_id)) {
          if (r.dci_filtro && r.dci_filtro.length > 0) {
            const hasDci = g.dci.some((d) => r.dci_filtro!.includes(d));
            if (!hasDci) continue;
          }
          matched.push(r);
        }
      }
      return matched.map((r) => ({
        id: r.id,
        condicao_aplicacao: r.condicao_aplicacao,
        exige_publico: r.exige_publico,
        restricoes_bloqueio_extra: r.restricoes_bloqueio_extra,
        validada_por: r.validada_por || 'DIRECAO_TECNICA',
      }));
    },

    async candidatosPorRegras(ids: string[]): Promise<Cand[]> {
      const { items } = await loadTenantCatalog(prisma, farmaciaId);
      const out: Cand[] = [];
      for (const id of ids) {
        const regra = REGRAS_AFINIDADE_DEF.find((r) => r.id === id);
        if (!regra) continue;
        for (const comp of regra.complementares) {
          for (const item of items) {
            if (item.precisa_receita || !item.permite_marketing || item.uso_veterinario) continue;
            if (item.categoria_id !== comp.categoria_id) continue;
            if (comp.subcategoria_regex && !comp.subcategoria_regex.test(item.subcategoria_id)) continue;
            out.push({
              ...item,
              papel_cesto: comp.papel_cesto,
              regra_id: id,
            });
          }
        }
      }
      return out;
    },

    async candidatosPorCampanha(campanhaId: string): Promise<Cand[]> {
      const camp = CALENDARIO_EIXOS.find((c) => c.campanha_id === campanhaId);
      if (!camp) return [];
      const { items } = await loadTenantCatalog(prisma, farmaciaId);
      const out: Cand[] = [];
      const seen = new Set<string>();
      for (const eixo of camp.eixos) {
        for (const item of items) {
          if (seen.has(item.cnp_codigo)) continue;
          if (item.precisa_receita || !item.permite_marketing || item.uso_veterinario) continue;
          if (item.categoria_id !== eixo.categoria_id) continue;
          if (eixo.subcategoria_regex && !eixo.subcategoria_regex.test(item.subcategoria_id)) continue;
          if (eixo.formas_excluidas && eixo.formas_excluidas.test(norm(item.designacao))) continue;
          seen.add(item.cnp_codigo);
          out.push({
            ...item,
            papel_cesto: eixo.papel_cesto,
          });
        }
      }
      return out;
    },

    async candidatosPorSubcategorias(slugs: string[]): Promise<Cand[]> {
      const alvo = new Set(slugs);
      const { items } = await loadTenantCatalog(prisma, farmaciaId);
      return items.filter(
        (i) => alvo.has(i.subcategoria_id) && !i.precisa_receita && i.permite_marketing && !i.uso_veterinario
      );
    },

    async calendario(): Promise<Calendario[]> {
      return CALENDARIO_EIXOS.map(({ eixos, ...cal }) => cal);
    },

    async epocaSubcategoria(): Promise<Record<string, number[] | null>> {
      return SUBCATEGORIA_EPOCA_MAP;
    },

    async campanhasAtivas(): Promise<CampanhaAtivaRow[]> {
      const rows = await prisma.campanhaAtiva.findMany({
        where: { farmaciaId, estado: 'ATIVA' },
      });
      return rows.map((r) => {
        const prods = Array.isArray(r.produtosJson) ? (r.produtosJson as any[]) : [];
        return {
          id: r.id,
          cnps: prods.map((p) => String(p.cnp_codigo || p.cnp || '')).filter(Boolean),
          descontoAplicadoPct: Number(r.descontoAplicadoPct || 0),
          dataInicio: r.dataInicio.toISOString().slice(0, 10),
          dataFim: r.dataFim ? r.dataFim.toISOString().slice(0, 10) : '2099-12-31',
          estado: r.estado,
        };
      });
    },

    store(payload: unknown): string {
      const pObj = payload as any;
      const env = saveToolResult({
        farmaciaId,
        sessionId,
        turno,
        ferramenta: pObj?.ferramenta || (pObj?.kind === 'pack' ? 'pack_proposto' : 'comercial'),
        input: toolInput,
        meta: pObj?.meta || (pObj?.kind === 'pack' ? { pack: pObj } : {}),
        colunas: Array.isArray(pObj?.colunas) ? pObj.colunas : [],
        linhas: Array.isArray(pObj?.linhas) ? pObj.linhas : [],
        totais: pObj?.totais,
      });
      return env.result_id || 'r_0000';
    },
  };
}
