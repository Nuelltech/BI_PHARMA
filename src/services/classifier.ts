import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

let firstPharmaDict: Record<string, { m: number; c: string; p: number; gh: string }> = {};
try {
  const dictPath = path.join(__dirname, '../data/firstpharma_dictionary.json');
  if (fs.existsSync(dictPath)) {
    firstPharmaDict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
  }
} catch (e) {
  console.warn('[Classifier] Dicionário FirstPharma não carregado:', e);
}

let infarmedMnsrmMap: Record<string, { nome: string; dci: string; forma: string; dosagem: string; embalagem: string; titular: string }> = {};
try {
  const infPath = path.join(__dirname, '../data/infarmed_mnsrm_official.json');
  if (fs.existsSync(infPath)) {
    infarmedMnsrmMap = JSON.parse(fs.readFileSync(infPath, 'utf-8'));
  }
} catch (e) {
  console.warn('[Classifier] Dicionário Infarmed MNSRM não carregado:', e);
}

export interface TaxonomyEntry {
  macro_area: string;
  categoria: string;
  subcategoria: string;
  sazonalidade: string;
  gh_codigo: string | null;
  gh_switch_cnp: string | null;
  gh_switch_nome: string | null;
  gh_switch_margem_ganho: number | null;
}

let taxonomyDict: Record<string, TaxonomyEntry> = {};
try {
  const taxPath = path.join(__dirname, '../data/category_taxonomy_map.json');
  if (fs.existsSync(taxPath)) {
    taxonomyDict = JSON.parse(fs.readFileSync(taxPath, 'utf-8'));
  }
} catch (e) {
  console.warn('[Classifier] Dicionário de taxonomia não carregado:', e);
}

export type TipoVenda = 'VENDA_LIVRE' | 'MNSRM' | 'MSRM';
export type SegmentoProduto = 'GENERICO_MG' | 'MEDICAMENTO_MARCA' | 'VENDA_LIVRE_PSBE';

export interface ProductClassification {
  tipo_venda: TipoVenda;
  segmento: SegmentoProduto;
  eh_generico: boolean;
  molecula_dci: string | null;
  grupo_equivalencia_dci: string | null;
  macro_area?: string;
  categoria: string;
  subcategoria?: string;
  sazonalidade?: string;
  gh_codigo?: string | null;
  gh_switch_cnp?: string | null;
  gh_switch_nome?: string | null;
  gh_switch_margem_ganho?: number | null;
  subcategoria_cross_sell: string;
}

function enrichWithTaxonomy(res: ProductClassification, code: string): ProductClassification {
  const tax = taxonomyDict[code];
  if (tax) {
    return {
      ...res,
      macro_area: tax.macro_area || res.macro_area,
      categoria: tax.categoria || res.categoria,
      subcategoria: tax.subcategoria || res.subcategoria,
      sazonalidade: tax.sazonalidade || res.sazonalidade,
      gh_codigo: tax.gh_codigo ?? res.gh_codigo,
      gh_switch_cnp: tax.gh_switch_cnp ?? res.gh_switch_cnp,
      gh_switch_nome: tax.gh_switch_nome ?? res.gh_switch_nome,
      gh_switch_margem_ganho: tax.gh_switch_margem_ganho ?? res.gh_switch_margem_ganho,
    };
  }
  return res;
}

const MNSRM_BRAND_PATTERNS: RegExp[] = [
  // Dor, Febre e Constipação/Gripe (excluindo ben-u-ron 1000mg Comp e Aspirina GR 100mg que são MSRM)
  /\b(panadol|dafalgan\s*(?!1000.*32)|trifene\s*200|ibudol|ib-u-ron|nurofen|spidifen\s*400|melhoral|saridon|aspirina\s*(?!gr\s*100)|aspegic\s*(?!1000)|migraspirina|alka-seltzer)\b/i,
  /\bben-u-ron\b(?!.*1000\s*mg.*comp)/i,
  /\b(c[eê]gripe|ilvico|griponal|ben-u-gripe|antigrippine|vigrippe|grippostad|sinutab)\b/i,
  // Garganta, Tosse e Nariz
  /\b(vicks|vaporub|babyrub|oscillococcinum|stodal|grintuss|anginovag|bucomax|pastilhas\s*dr\s*andreub?)\b/i,
  /\b(strepsils|strepfen|meboca[ií]na|tantum\s*verde|orovox|septolete|drill|euphon)\b/i,
  /\b(vibrocil|nasorhinathiol|nasitrim|snup|neo-sinefrina|rhinospray|rhinomer|irigaston|sterimar|sinomarin)\b/i,
  /\b(bisolvon|broncoliber|bronxol|fluimucil|fluprox|levotuss|tussilib|sekitocil|pulmiben|bromexina)\b/i,
  // Digestivo, Azia, Obstipação e Diarreia
  /\b(gaviscon|kompensan|rennie|eno\b|nexium\s*control|ulcermin|maalox)\b/i,
  /\b(dulcolax|microlax|bebegel|laevolac|duphalac|normalax|pursennide|agiolax|suposit[oó]rios\s*de\s*glicerina|cleenema|citrafleet|eziclen|phospho-soda)\b/i,
  /\b(imodium|imocalm|ul-250|aero-om|pankreoflat|buscopan|dioralyte)\b/i,
  // Dor Muscular Tópica, Pele, Feridas, Antifúngicos e Venotrópicos
  /\b(voltaren\s*(emulgel|emulgelex|24h|25\b)|dimobil|dolorilgel|remilax|reumon|thrombocid|hirudoid|b[aá]lsamo\s*analg[eé]sico|benergina|transact\s*lat)\b/i,
  /\b(canesten|gino-canesten|pevaryl|micolysin|dermofix|lamisil|mycoster|trosyd|niogermos|nailex|candiset)\b/i,
  /\b(emla\b|zovirax\s*(50\s*mg\/g|duo|creme|labial)|aciclosina|fenistil|biafine|lauroderme|halibut|mitosyl|betadine|bepanthene|polisulfad[eê]|bacitracina|benzac|calicida|verrufilm|verrucare)\b/i,
  /\b(faktu|scheriproct|procto-glyvenol|ultraproct)\b/i,
  /\b(folcare|minox\b|tedol|tarmed|zotinar|ketoconazol.*champ[oô]|cetoconazol.*champ[oô]|nizoral.*champ[oô])\b/i,
  // Tónicos, Vitaminas Medicamentosas, Olhos, Ouvidos, Alergia, Desparasitantes e Veterinária
  /\b(guronsan|becozyme|sargenor|arcalion|magnesiocard|magnesona|magnoral|cacit|calcimed|calci(um|tab)|densical|demilos|ide[oó]s)\b/i,
  /\b(zyrtec\s*(?:(?:10\s*mg.*(?:7|20)\b)|(?:1\s*mg\/ml.*150\s*ml)|(?!\d+.*60))|claritine|lergonix|allergodil|hidrocil|visidic|vidisic|recugel|edolfene|otoceril|oto-synalar|otti?oduo|cinet|vomidrine|nausefe)\b/i,
  /\b(zentel|anthelmin|frontline|frontpro|adtab|amflee|dehinel|piludog|advocate|apoquel|onsior|nexgard|scalibor)\b/i,
  /\b(nicorette|niquitin|postinor|levofemina)\b/i,
  /\b(daflon|venex|venosmil|vasoflon|thrombovarix|cyclo\s*3)\b/i,
  /\b(traumeel|engystol|vertigoheel|spascupreel|sedistress)\b/i,
];

export const GENERIC_LAB_NAMES_STR =
  '\\b(Generis\\s*Phar|Generis|Farmoz|Ratiopharm|ratiopharm|toLife|Tolife|ToLife|Teva|Mepha|Aurovitas|Aurobindo|Ciclum|Zentiva|Krka|KRKA|Sandoz|Bluepharma|Mylan|Pentafarma|Tecnigen|Ocram|Tecnilor|Alter|Stada|Jaba|Jabasulide|Basi|Labesfal|Azevedos|Lumec|Clamed|Psidep|Pazolam|Cotiasar|Fisiofen|Romace|Romazide|TAD|Aristo|Germed|Medinfar|UCB|GP|gp|Zera|Nodepe|Conforpam|Rinocalm|Folicalm|Allerzin|Gabamox|Coronat|Fixime|Atorvan|Atoribe|Blixie|Rocoz|Refta|Amperlem|Exxelir|Liboran|Orotrex|Vit[oó]ria|Pharmakern|Atral)\\b';

/**
 * Extrai o Princípio Ativo (DCI) e a Chave de Equivalência (Molécula + Dosagem + Quantidade)
 * para medicamentos genéricos ("MG"). Compatível com formatos Sifarma e Simphar/Winphar.
 */
export function extractGenericDciGroup(designacao: string): {
  molecula_dci: string | null;
  grupo_equivalencia_dci: string | null;
} {
  if (!/\bMG\b/i.test(designacao)) {
    return { molecula_dci: null, grupo_equivalencia_dci: null };
  }

  // 1. Remove marcação de genérico "(MG)" ou "MG" quando não precedida de número (ex: 200 mg é preservado)
  const cleanDesc = designacao
    .replace(/\(\s*MG\s*\)/gi, ' ')
    .replace(/(?<!\d\s*)\bMG\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 2. Extrair Dosagem (ex: "150mg", "200 mg", "75mg+650mg", "875 mg + 125 mg", "20 mg")
  const doseRegex = /\b(\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|ml|ui|u\.i\.)(?:\s*(?:\/|\+)\s*\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|ml|ui|u\.i\.)?)*)\b/i;
  const doseMatch = cleanDesc.match(doseRegex);
  const doseNorm = doseMatch
    ? doseMatch[1].toLowerCase().replace(/,/g, '.').replace(/\s*\+\s*/g, '/').replace(/\s*\/\s*/g, '/').replace(/\s+/g, '')
    : 'dose-unica';

  // 3. Extrair Embalagem / Unidades
  let packCount = '1';
  const packMatch =
    cleanDesc.match(/(?:blister|frasco|recipiente.*?|fita.*?|tubo)\s+(\d+)\s*unidade/i) ||
    cleanDesc.match(/\bx\s*(\d+)\s*(?:comp|c[aá]ps|saq|amp|unid)/i) ||
    cleanDesc.match(/\b(\d+)\s*(?:unidade\(s\)|saqueta|ampola)/i) ||
    cleanDesc.match(/[-–]\s*(\d+)\b/) ||
    cleanDesc.match(/\b(\d+)\s*$/);

  if (packMatch) {
    packCount = packMatch[1];
  }

  // 4. Extrair Nome da Molécula (DCI)
  let moleculaPart = cleanDesc.split(',')[0];
  if (doseMatch && doseMatch.index !== undefined) {
    const beforeDose = cleanDesc.substring(0, doseMatch.index);
    if (beforeDose.trim().length >= 3) {
      moleculaPart = beforeDose;
    }
  }

  const labRegex = new RegExp(GENERIC_LAB_NAMES_STR, 'gi');

  let molecula = moleculaPart
    .replace(/\b(comp(?:rimidos)?|c[aá]ps(?:ulas)?|revest(?:idos)?|lib(?:erta[cç][aã]o)?|prol(?:ongada)?|retard|sol(?:u[cç][aã]o)?|injet[aá]vel|oral|xarope|susp(?:ens[aã]o)?|gotas|pomada|creme|gel|spray|col[ií]rio|saq(?:uetas)?)\b.*$/i, '')
    .replace(labRegex, '')
    .replace(/[()\-–+,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const moleculaNorm = molecula ? molecula.charAt(0).toUpperCase() + molecula.slice(1).toLowerCase() : 'Desconhecido';

  return {
    molecula_dci: moleculaNorm,
    grupo_equivalencia_dci: `${moleculaNorm} (${doseNorm} x ${packCount} un)`,
  };
}

/**
 * Classifica qualquer artigo farmacêutico quanto ao seu Estatuto Legal (`tipo_venda`),
 * Segmento (`GENERICO_MG` vs `MEDICAMENTO_MARCA` vs `VENDA_LIVRE_PSBE`), Molécula DCI e Família Terapêutica.
 */
export function classifyProduct(
  cnp_codigo: string,
  designacao: string,
  taxa_iva?: number | string | null
): ProductClassification {
  const code = (cnp_codigo || '').trim();
  const raw = classifyProductInternal(code, designacao, taxa_iva);
  return enrichWithTaxonomy(raw, code);
}

function classifyProductInternal(
  code: string,
  designacao: string,
  taxa_iva?: number | string | null
): ProductClassification {
  const desc = (designacao || '').trim();
  const iva = typeof taxa_iva === 'string' ? parseInt(taxa_iva, 10) : taxa_iva;

  const { categoria, subcategoria_cross_sell } = detectTherapeuticCategory(code, desc, iva);
  const ehGenerico = /\bMG\b/.test(desc) && !/^(6|7|10)/.test(code) && iva !== 23;
  const { molecula_dci, grupo_equivalencia_dci } = ehGenerico
    ? extractGenericDciGroup(desc)
    : { molecula_dci: null, grupo_equivalencia_dci: null };

  // Exceção a Códigos ANF (6xxxxxx, 7xxxxxx): Antibióticos humanos (como Terramicina Spray, Fucidine) são sempre MSRM
  if (/\b(terramicina|fucidine|[aá]cido\s*fus[ií]dico)\b/i.test(desc)) {
    return {
      tipo_venda: 'MSRM',
      segmento: 'MEDICAMENTO_MARCA',
      eh_generico: false,
      molecula_dci: null,
      grupo_equivalencia_dci: null,
      categoria,
      subcategoria_cross_sell,
    };
  }

  // Regra A: Códigos ANF (6xxxxxx, 7xxxxxx) e códigos internos (10xxxxx) são SEMPRE Venda Livre (PSBE / Dispositivos / Cosmética)
  if (/^(6|7|10)/.test(code)) {
    const fpEntry = firstPharmaDict[code];
    return {
      tipo_venda: 'VENDA_LIVRE',
      segmento: 'VENDA_LIVRE_PSBE',
      eh_generico: false,
      molecula_dci: null,
      grupo_equivalencia_dci: null,
      categoria: (fpEntry?.c && fpEntry.c !== 'MSRM') ? fpEntry.c : categoria,
      subcategoria_cross_sell,
    };
  }

  // Regra B: Taxa de IVA a 23% é SEMPRE Venda Livre
  if (iva === 23) {
    const fpEntry = firstPharmaDict[code];
    return {
      tipo_venda: 'VENDA_LIVRE',
      segmento: 'VENDA_LIVRE_PSBE',
      eh_generico: false,
      molecula_dci: null,
      grupo_equivalencia_dci: null,
      categoria: (fpEntry?.c && fpEntry.c !== 'MSRM') ? fpEntry.c : categoria,
      subcategoria_cross_sell,
    };
  }

  // Regra Oficial INFARMED: Listagem Oficial de Medicamentos Não Sujeitos a Receita Médica (MNSRM)
  const infarmedEntry = infarmedMnsrmMap[code];
  if (infarmedEntry) {
    const segmentoMed: SegmentoProduto = ehGenerico ? 'GENERICO_MG' : 'MEDICAMENTO_MARCA';
    const moleculaFinal = molecula_dci || infarmedEntry.dci || null;
    return {
      tipo_venda: 'MNSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci: moleculaFinal,
      grupo_equivalencia_dci,
      macro_area: 'MNSRM_OTC',
      categoria: categoria || 'Venda Livre / OTC',
      subcategoria: subcategoria_cross_sell,
      subcategoria_cross_sell,
    };
  }

  // Regra C: Dicionário Mestre Oficial FirstPharma (55.632 CNPs com HMR3 e Grupos Homogéneos)
  const fpEntry = firstPharmaDict[code];
  if (fpEntry) {
    const segmentoMed: SegmentoProduto = ehGenerico ? 'GENERICO_MG' : 'MEDICAMENTO_MARCA';
    const catFinal = (fpEntry.c && fpEntry.c !== 'MSRM') ? fpEntry.c : categoria;

    if (fpEntry.m === 1) {
      return {
        tipo_venda: 'MSRM',
        segmento: segmentoMed,
        eh_generico: ehGenerico,
        molecula_dci,
        grupo_equivalencia_dci,
        categoria: catFinal,
        subcategoria_cross_sell,
      };
    } else {
      // fpEntry.m === 0 (Não sujeito a receita médica)
      const isMnsrm = /^(2|3|4|5|8|9)/.test(code) && iva !== 23;
      return {
        tipo_venda: isMnsrm ? 'MNSRM' : 'VENDA_LIVRE',
        segmento: isMnsrm ? segmentoMed : 'VENDA_LIVRE_PSBE',
        eh_generico: isMnsrm ? ehGenerico : false,
        molecula_dci: isMnsrm ? molecula_dci : null,
        grupo_equivalencia_dci: isMnsrm ? grupo_equivalencia_dci : null,
        categoria: catFinal,
        subcategoria_cross_sell,
      };
    }
  }

  // Dispositivos médicos / Soluções de irrigação e lavagem nasal/ocular (Soro Fisiológico em frascos)
  if (/\b(soro\s*fisiol[oó]gico|cloreto\s*de\s*s[oó]dio\s*0[,.]9%\s*.*frasco)\b/i.test(desc)) {
    return {
      tipo_venda: 'VENDA_LIVRE',
      segmento: 'VENDA_LIVRE_PSBE',
      eh_generico: false,
      molecula_dci: null,
      grupo_equivalencia_dci: null,
      categoria: 'Dispositivos Médicos e Cuidados Hospitalares',
      subcategoria_cross_sell: 'Soluções de irrigação, lavagem nasal e ocular',
    };
  }

  const segmentoMed: SegmentoProduto = ehGenerico ? 'GENERICO_MG' : 'MEDICAMENTO_MARCA';

  // Regra C: Taxa de IVA 0% (Vacinas SNS / Valormed)
  if (iva === 0) {
    return {
      tipo_venda: 'MSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci,
      grupo_equivalencia_dci,
      categoria,
      subcategoria_cross_sell,
    };
  }

  // Regra D: Medicamentos Registados no Infarmed (Códigos 2..5, 8..9 com IVA 6%)
  if (/\b(sol\s*inj|susp\s*inj|caneta\s*pr[eé]-cheia|seringa\s*pr[eé]-cheia|perf\b|sistema\s*transd[eé]rmico|adesivo\s*transd)/i.test(desc)) {
    return {
      tipo_venda: 'MSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci,
      grupo_equivalencia_dci,
      categoria,
      subcategoria_cross_sell,
    };
  }

  // Exclusões expressas de MNSRM para MSRM segundo legislação Infarmed:
  // 1. Analgésicos Opióides / Estupefacientes associados a Paracetamol (Tramadol, Codeína)
  if (/\b(tramadol|code[ií]na|morfina|fentanil|buprenorfina|tapentadol)\b/i.test(desc)) {
    return {
      tipo_venda: 'MSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci,
      grupo_equivalencia_dci,
      categoria,
      subcategoria_cross_sell,
    };
  }

  // 2. Ibuprofeno 600mg (todas as formulações orais de 600mg são MSRM)
  if (/\bibuprofeno\b/i.test(desc) && /\b600\s*mg\b/i.test(desc)) {
    return {
      tipo_venda: 'MSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci,
      grupo_equivalencia_dci,
      categoria,
      subcategoria_cross_sell,
    };
  }

  // 3. Paracetamol 1000mg em comprimidos (sólido oral é MSRM no Infarmed)
  if (/\bparacetamol\b/i.test(desc) && /\b1000\s*mg\b/i.test(desc) && /\bcomp/i.test(desc)) {
    return {
      tipo_venda: 'MSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci,
      grupo_equivalencia_dci,
      categoria,
      subcategoria_cross_sell,
    };
  }

  // 4. Fluimucil 600mg x 20 comprimidos efervescentes (MSRM)
  if (/\bfluimucil\b/i.test(desc) && /\b600\s*mg\b/i.test(desc) && /\b20\b/.test(desc)) {
    return {
      tipo_venda: 'MSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci,
      grupo_equivalencia_dci,
      categoria,
      subcategoria_cross_sell,
    };
  }

  for (const pattern of MNSRM_BRAND_PATTERNS) {
    if (pattern.test(desc)) {
      return {
        tipo_venda: 'MNSRM',
        segmento: segmentoMed,
        eh_generico: ehGenerico,
        molecula_dci,
        grupo_equivalencia_dci,
        categoria,
        subcategoria_cross_sell,
      };
    }
  }

  const isSmallPackOrTopical =
    /\b([1-9]|1[0-9]|20)\s*(unidade\(s\)|comp|c[aá]ps|saqueta|sup)/i.test(desc) ||
    /\b(gel|creme|pomada|pda|xarope|xar|sol\s*cut|champ[oô]|verniz|col[ií]rio|susp\s*oral)\b/i.test(desc);

  if (
    isSmallPackOrTopical &&
    /\b(paracetamol|ibuprofeno|diclofenac|cetirizina|loratadina|desloratadina|levocetirizina|omeprazol\s*20|pantoprazol\s*20|lansoprazol|clotrimazol|terbinafina|lactulose|loperamida|ambroxol|acetilciste[ií]na|fluconazol\s*150|mebendazol|baclofeno|butilescopolamina|macrogol|diosmina)\b/i.test(
      desc
    )
  ) {
    return {
      tipo_venda: 'MNSRM',
      segmento: segmentoMed,
      eh_generico: ehGenerico,
      molecula_dci,
      grupo_equivalencia_dci,
      categoria,
      subcategoria_cross_sell,
    };
  }

  return {
    tipo_venda: 'MSRM',
    segmento: segmentoMed,
    eh_generico: ehGenerico,
    molecula_dci,
    grupo_equivalencia_dci,
    categoria,
    subcategoria_cross_sell,
  };
}

function detectTherapeuticCategory(
  code: string,
  desc: string,
  iva?: number | null
): { categoria: string; subcategoria_cross_sell: string } {
  const d = desc.toLowerCase();

  if (/\b(lactoflorene|biogaia|ul-250|symbiosys|atylfor|atyflor|forbiotics|duobiotic|gut4|probiot|prebiot|dialevur|enterogermina)\b/.test(d)) {
    return {
      categoria: 'Probióticos e Flora Intestinal',
      subcategoria_cross_sell: 'Associar à dispensa de Antibióticos ou Antidiarreicos',
    };
  }

  if (/\b(amoxicilina|clavul[aá]nico|clavamox|clamoxyl|augmentin|azitromicina|zithromax|claritromicina|klacid|ciprofloxacina|levofloxacina|cefuroxima|cefixima|cefradur|fosfomicina|monuril|furadantina|metronidazol|flagyl|fluconazol|itraconazol|valaciclovir|aciclovir.*comp)\b/.test(d)) {
    return {
      categoria: 'Antibióticos e Anti-infecciosos',
      subcategoria_cross_sell: 'Locomotiva -> Sugerir Probiótico ou Reforço Imunitário',
    };
  }

  if (/\b(gripe|antigrip\w*|gripp\w*|griponal|c[eê]gripe|ilvico|vigrippe|tosse|tuss\w*|mucavex|mucosolvan|carbociste[ií]na|acetilciste[ií]na|ambroxol|bromexina|dextrometorfano|strepsils|strepfen|meboca[ií]na|tantum|golamir|grintuss|stodal|fitonasal|rhinomer|rhinolaya|nasimer|nasitrim|snup|neo-sinefrina|vibrocil|nasomet|avamys|dymista|sinutab|bronxol|broncoliber|fluimucil|fluprox|bisolvon|bisol\w*|levotuss|toloxim|terapharma\s*tussis|good\s*tuss|thymosirop|thymotabs|thymospray|propolgemma|oroben|vicks|irigaston|otifaes|otowel|otoceril)\b/.test(d)) {
    return {
      categoria: 'Gripe, Tosse e Vias Respiratórias',
      subcategoria_cross_sell: 'Associar a Antigripais, Analgésicos, Sprays Nasais ou Vitamina C',
    };
  }

  if (/\b(sollievo|dulcolax|laevolac|lactulose|duphalac|microlax|bebegel|melilax|gaviscon|neobianacid|kompensan|rennie|coligas|lenodiar|omeprazol|pantoprazol|esomeprazol|lansoprazol|rabeprazol|nexium|ezomeprazol|depuralina|good\s*slim|good\s*diet|good\s*lax|kilofit|metarecod|lynfase|midro)\b/.test(d)) {
    return {
      categoria: 'Saúde Digestiva, Trânsito e Peso',
      subcategoria_cross_sell: 'Associar a Protetores Gástricos, Digestivos ou Controlo de Peso',
    };
  }

  if (/\b(ben-u-ron|paracetamol|dafalgan|panadol|brufen|ibuprofeno|ib-u-ron|nurofen|voltaren|diclofenac|dimobil|fisiocrem|biofreeze|dolorilgel|reumon|transact|naproxeno|etoricoxib|celecoxib|metamizol|nolotil|tramadol|palexia|relmus|tiocolquicosido)\b/.test(d)) {
    return {
      categoria: 'Dor, Febre e Alívio Muscular',
      subcategoria_cross_sell: 'Associar Gel/Penso Tópico a Analgésicos ou Anti-inflamatórios Orais',
    };
  }

  if (/\b(absorvit|centrum|vitaminicum|viterra|advancis|magnesio|magn[eé]sio|magnesium|guronsan|becozyme|sargenor|neurobion|ferro|folifer|legofer|maltofer|ferrum|neuralex|acutil|zzzz?quil|melatonina|valdispert|sedivitax|aquilea|arkocapsulas|ergylase|imunofytol)\b/.test(d)) {
    return {
      categoria: 'Suplementos, Energia, Sono e Memória',
      subcategoria_cross_sell: 'Sugerir em queixas de Cansaço, Insónia, Polimedicação ou Sazonalidade',
    };
  }

  if (/\b(avene|lrposay|la\s*roche|vichy|cerave|ducray|klorane|a-derma|rilastil|heliocare|isdin|iraltone|cistitone|bioscalin|tricovel|biocyte|lovren|magic\s*studio|divna|martinelia|iap\s*perfume|papillon|bow\s+|farline|corine|barral|nivea|neutrogena|carmex|letibalm|b\s*lift)\b/.test(d)) {
    return {
      categoria: 'Dermocosmética, Cabelo e Perfumaria',
      subcategoria_cross_sell: 'Cross-Selling de Rotina de Pele / Proteção Solar / Cuidado Capilar',
    };
  }

  if (/\b(elgydium|eludril|parodontax|sensodyne|corega|kukident|arthrodont|elmex|senti2|couto|pierrot|escova\s*de\s*dentes|fio\s*dent)\b/.test(d)) {
    return {
      categoria: 'Higiene e Saúde Oral',
      subcategoria_cross_sell: 'Associar Colutório/Escova a Pastas Dentífricas ou Fixadores',
    };
  }

  if (/\b(ch\.|chicco|aptamil|fortimel|dodot|picu\s*baby|biber|chupeta|muda\s*fralda|mitosyl|halibut|lauroderme)\b/.test(d)) {
    return {
      categoria: 'Bebé, Puericultura e Maternidade',
      subcategoria_cross_sell: 'Associar a compras de Puericultura, Leites e Higiene do Bebé',
    };
  }

  if (/\b(freestyle|accu-chek|contour|onetouch|wellion|gluco|lanceta|agulha|seringa|compressa|penso|salvelox|compeed|urgo|nexcare|hansaplast|mefix|masteraid|deramed|oppo|futuro|back\s*on\s*track|juzo|lycias|cinta|joelheira|tornozeleira|puls|bengala|canadiana|cadeira\s*rodas|termometro|tensiometro|omron|microlife|pic\s+|3\s*claveles|3c\s+|oculos|óculo|perspektiv|loring|preservat|durex|cumlaude|lactacyd|saforelle|intimo)\b/.test(d)) {
    return {
      categoria: 'Dispositivos Médicos, Ortopedia e Cuidados',
      subcategoria_cross_sell: 'Associar a Tratamentos Crónicos, Diabetes, Feridas ou Mobilidade',
    };
  }

  if (/\b(atorvastatina|rosuvastatina|sinvastatina|pitavastatina|ezetimiba|crestor|zarator|rozor|ozempic|rybelsus|trulicity|mounjaro|victoza|jardiance|forxiga|trajenta|januvia|janumet|synjardy|xigduo|eucreas|metformina|gliclazida|insulina|lantus|toujeo|tresiba|fiasp|novorapid|humalog|bisoprolol|nebivolol|carvedilol|concor|nebilet|ramipril|perindopril|lisinopril|enalapril|losartan|valsartan|candesartan|irbesartan|telmisartan|olmesartan|amlodipina|lercanidipina|nifedipina|indapamida|furosemida|lasix|aldactone|entresto|xarelto|eliquis|lixiana|pradaxa|rivaroxabano|apixabano|dabigatrano|clopidogrel|plavix|varfine|sintrom|daflon|venex)\b/.test(d)) {
    return {
      categoria: 'Cardiovascular, Diabetes e Circulação',
      subcategoria_cross_sell: 'Locomotiva Crónica -> Sugerir Tiras Glicemia, Ómega-3 ou Meias Compressão',
    };
  }

  if (/\b(alprazolam|xanax|lorazepam|lorenin|lorsedal|diazepam|valium|bromazepam|lexotan|bromalex|zolpidem|stilnox|zopiclona|victan|sedoxil|sertralina|zoloft|escitalopram|cipralex|fluoxetina|paroxetina|venlafaxina|efexor|duloxetina|cymbalta|mirtazapina|bupropiom|elontril|trazodona|triticum|brintellix|valdoxan|quetiapina|olanzapina|risperidona|aripiprazol|levetiracetam|keppra|pregabalina|gabapentina|neurontin|topiramato|lamotrigina|valpr[oó]ico|depakine|donepezilo|memantina|rivastigmina|rivotril|metilfenidato|concerta|ritalina|elvanse)\b/.test(d)) {
    return {
      categoria: 'Sistema Nervoso e Saúde Mental',
      subcategoria_cross_sell: 'Locomotiva Crónica -> Sugerir Magnésio, Vitaminas B ou Higiene do Sono',
    };
  }

  if (iva === 23 || /^(6|7|10)/.test(code)) {
    return {
      categoria: 'Saúde e Bem-Estar Geral (Venda Livre)',
      subcategoria_cross_sell: 'Disponível para recomendação direta de balcão e exposição linear',
    };
  }

  return {
    categoria: 'Especialidades Farmacêuticas / Outros',
    subcategoria_cross_sell: 'Verificar prescrição / protocolo farmacêutico',
  };
}

export async function classifyAllExistingProducts(prisma: PrismaClient): Promise<{
  total: number;
  vendaLivre: number;
  mnsrm: number;
  msrm: number;
  genericosMg: number;
  marca: number;
}> {
  const produtos = await prisma.produtoMestre.findMany();
  let vendaLivre = 0;
  let mnsrm = 0;
  let msrm = 0;
  let genericosMg = 0;
  let marca = 0;

  const updatesNeeded: Array<{
    cnp_codigo: string;
    tipo_venda: string;
    macro_area?: string;
    categoria: string;
    subcategoria?: string;
    sazonalidade?: string;
    gh_codigo?: string | null;
    gh_switch_cnp?: string | null;
    gh_switch_nome?: string | null;
    gh_switch_margem_ganho?: number | null;
  }> = [];

  for (const p of produtos) {
    const c = classifyProduct(p.cnp_codigo, p.designacao, p.taxa_iva);
    if (c.tipo_venda === 'VENDA_LIVRE') vendaLivre++;
    else if (c.tipo_venda === 'MNSRM') mnsrm++;
    else msrm++;

    if (c.segmento === 'GENERICO_MG') genericosMg++;
    else if (c.segmento === 'MEDICAMENTO_MARCA') marca++;

    if (
      p.tipo_venda !== c.tipo_venda ||
      p.categoria !== c.categoria ||
      p.macro_area !== c.macro_area ||
      p.subcategoria !== c.subcategoria ||
      p.sazonalidade !== c.sazonalidade
    ) {
      updatesNeeded.push({
        cnp_codigo: p.cnp_codigo,
        tipo_venda: c.tipo_venda,
        macro_area: c.macro_area,
        categoria: c.categoria,
        subcategoria: c.subcategoria,
        sazonalidade: c.sazonalidade,
        gh_codigo: c.gh_codigo,
        gh_switch_cnp: c.gh_switch_cnp,
        gh_switch_nome: c.gh_switch_nome,
        gh_switch_margem_ganho: c.gh_switch_margem_ganho,
      });
    }
  }

  const CHUNK_SIZE = 100;
  for (let i = 0; i < updatesNeeded.length; i += CHUNK_SIZE) {
    const chunk = updatesNeeded.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map((u) =>
        prisma.produtoMestre.update({
          where: { cnp_codigo: u.cnp_codigo },
          data: {
            tipo_venda: u.tipo_venda,
            macro_area: u.macro_area,
            categoria: u.categoria,
            subcategoria: u.subcategoria,
            sazonalidade: u.sazonalidade,
            gh_codigo: u.gh_codigo,
            gh_switch_cnp: u.gh_switch_cnp,
            gh_switch_nome: u.gh_switch_nome,
            gh_switch_margem_ganho: u.gh_switch_margem_ganho,
          },
        })
      )
    );
  }

  return {
    total: produtos.length,
    vendaLivre,
    mnsrm,
    msrm,
    genericosMg,
    marca,
  };
}
