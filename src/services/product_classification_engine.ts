import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// 1. Utility: normalize text (lowercase, remove accents, trim, collapse spaces)
// ---------------------------------------------------------------------------
export function norm(str?: string | null): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 2. Family Catalog & Priority
// ---------------------------------------------------------------------------
export interface FamiliaCatalogEntry {
  familia_id: string;
  nome: string;
  permite_gatilho: boolean;
}

export const FAMILIA_CATALOGO: Record<string, FamiliaCatalogEntry> = {
  ANTIBIOTICO_SISTEMICO: { familia_id: 'ANTIBIOTICO_SISTEMICO', nome: 'Antibióticos sistémicos', permite_gatilho: true },
  ANTIVIRAL_ANTIFUNGICO_SIST: { familia_id: 'ANTIVIRAL_ANTIFUNGICO_SIST', nome: 'Antivirais e antifúngicos sistémicos', permite_gatilho: false },
  ANTIDIABETICO: { familia_id: 'ANTIDIABETICO', nome: 'Antidiabéticos', permite_gatilho: true },
  ESTATINA_HIPOLIPEMIANTE: { familia_id: 'ESTATINA_HIPOLIPEMIANTE', nome: 'Estatinas e hipolipemiantes', permite_gatilho: true },
  ANTIHIPERTENSOR: { familia_id: 'ANTIHIPERTENSOR', nome: 'Anti-hipertensores', permite_gatilho: true },
  DIURETICO: { familia_id: 'DIURETICO', nome: 'Diuréticos', permite_gatilho: true },
  CARDIACO_VASCULAR: { familia_id: 'CARDIACO_VASCULAR', nome: 'Cardíacos e vasculares', permite_gatilho: true },
  ANTICOAGULANTE_ANTIAGREGANTE: { familia_id: 'ANTICOAGULANTE_ANTIAGREGANTE', nome: 'Anticoagulantes e antiagregantes', permite_gatilho: true },
  ANTIANEMICO: { familia_id: 'ANTIANEMICO', nome: 'Antianémicos', permite_gatilho: true },
  ANTIULCEROSO_ANTIACIDO: { familia_id: 'ANTIULCEROSO_ANTIACIDO', nome: 'Antiulcerosos e antiácidos', permite_gatilho: true },
  GASTROINTESTINAL_OUTROS: { familia_id: 'GASTROINTESTINAL_OUTROS', nome: 'Gastrointestinais (outros)', permite_gatilho: true },
  VITAMINAS_MINERAIS_RX: { familia_id: 'VITAMINAS_MINERAIS_RX', nome: 'Vitaminas e minerais (Rx)', permite_gatilho: true },
  AINE_ANTIINFLAMATORIO: { familia_id: 'AINE_ANTIINFLAMATORIO', nome: 'Anti-inflamatórios não esteroides', permite_gatilho: true },
  RELAXANTE_MUSCULAR: { familia_id: 'RELAXANTE_MUSCULAR', nome: 'Relaxantes musculares', permite_gatilho: true },
  OSTEOARTICULAR_OSSEO: { familia_id: 'OSTEOARTICULAR_OSSEO', nome: 'Osteoarticulares e ósseos', permite_gatilho: true },
  ANALGESICO_NAO_OPIOIDE: { familia_id: 'ANALGESICO_NAO_OPIOIDE', nome: 'Analgésicos não opioides', permite_gatilho: true },
  OPIOIDE: { familia_id: 'OPIOIDE', nome: 'Opioides', permite_gatilho: false },
  ENXAQUECA: { familia_id: 'ENXAQUECA', nome: 'Enxaqueca', permite_gatilho: true },
  CORTICOIDE_SISTEMICO: { familia_id: 'CORTICOIDE_SISTEMICO', nome: 'Corticoides sistémicos', permite_gatilho: true },
  TIROIDE: { familia_id: 'TIROIDE', nome: 'Tiroide', permite_gatilho: true },
  HORMONAL_OUTROS: { familia_id: 'HORMONAL_OUTROS', nome: 'Hormonais (outros)', permite_gatilho: true },
  CONTRACETIVO_GINECOLOGICO: { familia_id: 'CONTRACETIVO_GINECOLOGICO', nome: 'Contracetivos e ginecológicos', permite_gatilho: false },
  GINECOLOGICO_ANTIINFECCIOSO: { familia_id: 'GINECOLOGICO_ANTIINFECCIOSO', nome: 'Ginecológicos anti-infecciosos', permite_gatilho: true },
  UROLOGICO: { familia_id: 'UROLOGICO', nome: 'Urológicos', permite_gatilho: false },
  RESPIRATORIO_ASMA_DPOC: { familia_id: 'RESPIRATORIO_ASMA_DPOC', nome: 'Asma e DPOC', permite_gatilho: true },
  ANTIHISTAMINICO: { familia_id: 'ANTIHISTAMINICO', nome: 'Anti-histamínicos', permite_gatilho: true },
  NASAL_RX: { familia_id: 'NASAL_RX', nome: 'Nasais (Rx)', permite_gatilho: true },
  TOSSE_GARGANTA_RX: { familia_id: 'TOSSE_GARGANTA_RX', nome: 'Tosse e garganta (Rx)', permite_gatilho: true },
  PSICOFARMACO: { familia_id: 'PSICOFARMACO', nome: 'Psicofármacos', permite_gatilho: false },
  NEURO_ANTIPSICOTICO: { familia_id: 'NEURO_ANTIPSICOTICO', nome: 'Neurologia e antipsicóticos', permite_gatilho: false },
  OFTALMOLOGICO: { familia_id: 'OFTALMOLOGICO', nome: 'Oftalmológicos', permite_gatilho: true },
  OTOLOGICO: { familia_id: 'OTOLOGICO', nome: 'Otológicos', permite_gatilho: true },
  DERMATOLOGICO_RX: { familia_id: 'DERMATOLOGICO_RX', nome: 'Dermatológicos (Rx)', permite_gatilho: true },
  ANTIPARASITARIO: { familia_id: 'ANTIPARASITARIO', nome: 'Antiparasitários', permite_gatilho: true },
  ONCOLOGIA_IMUNOMODULADOR: { familia_id: 'ONCOLOGIA_IMUNOMODULADOR', nome: 'Oncologia e imunomoduladores', permite_gatilho: false },
  VACINA_IMUNOSSORO: { familia_id: 'VACINA_IMUNOSSORO', nome: 'Vacinas e imunossoros', permite_gatilho: false },
  OUTROS_RX: { familia_id: 'OUTROS_RX', nome: 'Outros (Rx)', permite_gatilho: false },
};

const FAMILIA_PRIORITY: string[] = [
  'ONCOLOGIA_IMUNOMODULADOR',
  'VACINA_IMUNOSSORO',
  'PSICOFARMACO',
  'NEURO_ANTIPSICOTICO',
  'OPIOIDE',
  'ANTICOAGULANTE_ANTIAGREGANTE',
  'ANTIDIABETICO',
  'ANTIHIPERTENSOR',
  'ESTATINA_HIPOLIPEMIANTE',
  'CARDIACO_VASCULAR',
  'DIURETICO',
  'ANTIBIOTICO_SISTEMICO',
  'ANTIVIRAL_ANTIFUNGICO_SIST',
  'RESPIRATORIO_ASMA_DPOC',
  'CONTRACETIVO_GINECOLOGICO',
  'GINECOLOGICO_ANTIINFECCIOSO',
  'UROLOGICO',
  'CORTICOIDE_SISTEMICO',
  'TIROIDE',
  'HORMONAL_OUTROS',
  'AINE_ANTIINFLAMATORIO',
  'OSTEOARTICULAR_OSSEO',
  'RELAXANTE_MUSCULAR',
  'ENXAQUECA',
  'ANTIULCEROSO_ANTIACIDO',
  'GASTROINTESTINAL_OUTROS',
  'ANTIANEMICO',
  'VITAMINAS_MINERAIS_RX',
  'ANTIHISTAMINICO',
  'NASAL_RX',
  'TOSSE_GARGANTA_RX',
  'OFTALMOLOGICO',
  'OTOLOGICO',
  'DERMATOLOGICO_RX',
  'ANTIPARASITARIO',
  'ANALGESICO_NAO_OPIOIDE',
  'OUTROS_RX',
];

export function selectPrincipalFamily(familias: string[]): string {
  if (!familias.length) return 'OUTROS_RX';
  let best = familias[0];
  let bestIdx = FAMILIA_PRIORITY.indexOf(best);
  if (bestIdx === -1) bestIdx = 999;
  for (const f of familias) {
    const idx = FAMILIA_PRIORITY.indexOf(f);
    if (idx !== -1 && idx < bestIdx) {
      best = f;
      bestIdx = idx;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. DCI Override, Alias, Combo Override, Dual Via, Tags, Stems
// ---------------------------------------------------------------------------
const RAW_DCI_OVERRIDE: Record<string, string[]> = {
  ANTIBIOTICO_SISTEMICO: 'amoxicilina|ampicilina|flucloxacilina|fenoximetilpenicilina|cefuroxima|cefixima|cefalexina|cefadroxilo|cefaclor|cefpodoxima|azitromicina|claritromicina|eritromicina|roxitromicina|doxiciclina|minociclina|ciprofloxacina|levofloxacina|norfloxacina|moxifloxacina|ofloxacina|trimetoprim|sulfametoxazol|nitrofurantoina|fosfomicina|metronidazol|tinidazol|clindamicina|linezolid|rifaximina'.split('|'),
  ANTIVIRAL_ANTIFUNGICO_SIST: 'aciclovir|valaciclovir|famciclovir|oseltamivir|fluconazol|itraconazol|voriconazol|terbinafina|griseofulvina|nistatina|tenofovir|emtricitabina|efavirenz|dolutegravir|abacavir|lamivudina|raltegravir|darunavir|ritonavir|entecavir|sofosbuvir'.split('|'),
  ANTIDIABETICO: 'metformina|glibenclamida|gliclazida|glimepirida|glipizida|sitagliptina|vildagliptina|linagliptina|saxagliptina|alogliptina|empagliflozina|dapagliflozina|canagliflozina|ertugliflozina|pioglitazona|repaglinida|nateglinida|acarbose|liraglutido|semaglutido|dulaglutido|exenatido|tirzepatido|insulina degludec|insulina'.split('|'),
  ESTATINA_HIPOLIPEMIANTE: 'atorvastatina|sinvastatina|rosuvastatina|pravastatina|pitavastatina|fluvastatina|lovastatina|ezetimiba|fenofibrato|bezafibrato|gemfibrozil|genfibrozilo|ciprofibrato|colesevelam'.split('|'),
  ANTIHIPERTENSOR: 'enalapril|lisinopril|ramipril|perindopril|captopril|quinapril|fosinopril|trandolapril|benazepril|zofenopril|losartan|valsartan|irbesartan|candesartan|telmisartan|olmesartan|azilsartan|eprosartan|amlodipina|nifedipina|felodipina|lercanidipina|lacidipina|nitrendipina|manidipina|bisoprolol|metoprolol|atenolol|carvedilol|nebivolol|propranolol|labetalol|timolol|doxazosina|clonidina|metildopa|moxonidina|aliscireno|sacubitril|rilmenidina|diltiazem'.split('|'),
  DIURETICO: 'furosemida|torasemida|hidroclorotiazida|clortalidona|indapamida|espironolactona|eplerenona|amilorida|bumetanida'.split('|'),
  CARDIACO_VASCULAR: 'digoxina|amiodarona|dronedarona|flecainida|propafenona|sotalol|ivabradina|ranolazina|trimetazidina|nitroglicerina|isossorbida|mononitrato de isossorbida|molsidomina|pentoxifilina|cilostazol|finerenona'.split('|'),
  ANTICOAGULANTE_ANTIAGREGANTE: 'varfarina|acenocumarol|rivaroxabano|apixabano|dabigatrano|edoxabano|enoxaparina|heparina|nadroparina|bemiparina|clopidogrel|ticagrelor|prasugrel|dipiridamol|triflusal|ticlopidina'.split('|'),
  ANTIANEMICO: 'sulfato ferroso|fumarato ferroso|ferro|polimaltose|acido folico|cianocobalamina|hidroxocobalamina'.split('|'),
  ANTIULCEROSO_ANTIACIDO: 'omeprazol|esomeprazol|pantoprazol|lansoprazol|rabeprazol|dexlansoprazol|ranitidina|famotidina|cimetidina|sucralfato|misoprostol|almagato|alginato|hidroxido de aluminio|hidroxido de magnesio|magaldrato|carbonato de di-hidroxido de aluminio e sodio|alginato de sodio|bicarbonato de sodio|carbonato de calcio|carbonato de magnesio'.split('|'),
  GASTROINTESTINAL_OUTROS: 'metoclopramida|domperidona|ondansetrom|granisetrom|butilescopolamina|trimebutina|mebeverina|pinaverio|otilonio|loperamida|racecadotrilo|lactulose|lactitol|macrogol|bisacodilo|picossulfato|simeticone|mesalazina|sulfassalazina|acido ursodesoxicolico|pancreatina|glicerol|dimenidrinato|saccharomyces boulardii|senosido a|senosido b|ispagula|plantago ovata|cassia angustifolia|citrato de sodio|laurilsulfoacetato de sodio|fosfato dissodico|fosfato monossodico'.split('|'),
  VITAMINAS_MINERAIS_RX: 'colecalciferol|calcitriol|alfacalcidol|calcifediol|cloreto de potassio|acetato de calcio'.split('|'),
  AINE_ANTIINFLAMATORIO: 'ibuprofeno|dexibuprofeno|naproxeno|diclofenac|cetoprofeno|dexcetoprofeno|etoricoxib|celecoxib|nimesulida|meloxicam|piroxicam|aceclofenac|indometacina|etodolac|lornoxicam|tenoxicam|acido mefenamico|acido niflumico|flurbiprofeno|nabumetona|parecoxib|cetorolac|acemetacina|picetoprofeno|etofenamato|acido flufenamico'.split('|'),
  RELAXANTE_MUSCULAR: 'ciclobenzaprina|tizanidina|tiocolquicosido|baclofeno|metocarbamol|orfenadrina|eperisona'.split('|'),
  OSTEOARTICULAR_OSSEO: 'alendronato|risedronato|ibandronato|zoledronato|acido zoledronico|raloxifeno|denosumab|teriparatida|ranelato de estroncio|alopurinol|febuxostat|febuxostate|colquicina|glucosamina|diacereina|condroitina'.split('|'),
  ANALGESICO_NAO_OPIOIDE: 'paracetamol|metamizol|nefopam'.split('|'),
  OPIOIDE: 'tramadol|codeina|morfina|oxicodona|tapentadol|fentanilo|buprenorfina|hidromorfona|metadona|petidina'.split('|'),
  ENXAQUECA: 'sumatriptano|rizatriptano|zolmitriptano|naratriptano|eletriptano|almotriptano|frovatriptano|flunarizina'.split('|'),
  CORTICOIDE_SISTEMICO: 'prednisolona|prednisona|deflazacorte|metilprednisolona|dexametasona|hidrocortisona|betametasona|triancinolona'.split('|'),
  TIROIDE: 'levotiroxina|tiamazol|carbimazol|liotironina'.split('|'),
  HORMONAL_OUTROS: 'estradiol|estriol|estrogenios conjugados|progesterona|tibolona|desmopressina|cabergolina|bromocriptina|testosterona|somatropina'.split('|'),
  CONTRACETIVO_GINECOLOGICO: 'etinilestradiol|drospirenona|levonorgestrel|desogestrel|gestodeno|norgestimato|dienogest|nomegestrol|etonogestrel|ulipristal|ciproterona|norelgestromina|clormadinona|medroxiprogesterona'.split('|'),
  GINECOLOGICO_ANTIINFECCIOSO: 'clotrimazol|fenticonazol|miconazol|econazol|sertaconazol|tioconazol|promestrieno|dequalinio'.split('|'),
  UROLOGICO: 'tansulosina|alfuzosina|finasterida|dutasterida|silodosina|oxibutinina|solifenacina|tolterodina|trospio|cloreto de trospio|fesoterodina|mirabegom|sildenafil|tadalafil|vardenafil|avanafil|darifenacina'.split('|'),
  RESPIRATORIO_ASMA_DPOC: 'salbutamol|terbutalina|formoterol|salmeterol|indacaterol|olodaterol|vilanterol|tiotropio|glicopirronio|umeclidinio|ipratropio|budesonida|fluticasona|beclometasona|ciclesonida|mometasona|montelucaste|teofilina|roflumilast|cromoglicato de sodio'.split('|'),
  ANTIHISTAMINICO: 'cetirizina|levocetirizina|loratadina|desloratadina|fexofenadina|ebastina|bilastina|rupatadina|hidroxizina|clemastina|dexclorfeniramina|mizolastina|ciproeptadina|dimetindeno|clorofenamina|bromofeniramina|feniramina|difenidramina|doxilamina|clorofenoxamina'.split('|'),
  NASAL_RX: 'oximetazolina|xilometazolina|nafazolina|tetrizolina|fenilefrina|azelastina|tramazolina'.split('|'),
  TOSSE_GARGANTA_RX: 'acetilcisteina|carbocisteina|ambroxol|bromexina|butamirato|dextrometorfano|levodropropizina|cloperastina|guaifenesina|erdosteina|benzidamina|pseudoefedrina|efedrina|noscapina|dropropizina|oxolamina'.split('|'),
  PSICOFARMACO: 'alprazolam|lorazepam|diazepam|clonazepam|bromazepam|cloxazolam|midazolam|oxazepam|zolpidem|zopiclona|sertralina|fluoxetina|paroxetina|escitalopram|citalopram|fluvoxamina|venlafaxina|desvenlafaxina|duloxetina|mirtazapina|trazodona|bupropiom|amitriptilina|nortriptilina|clomipramina|agomelatina|vortioxetina|buspirona|litio|mexazolam|tianeptina'.split('|'),
  NEURO_ANTIPSICOTICO: 'quetiapina|olanzapina|risperidona|aripiprazol|brexpiprazol|haloperidol|clozapina|amissulprida|paliperidona|ziprasidona|carbamazepina|acido valproico|valproato|lamotrigina|levetiracetam|topiramato|oxcarbazepina|fenitoina|fenobarbital|gabapentina|pregabalina|lacosamida|zonisamida|levodopa|carbidopa|pramipexol|ropinirol|rasagilina|selegilina|entacapona|donepezilo|memantina|rivastigmina|galantamina|metilfenidato|atomoxetina|riluzol|piridostigmina|tiaprida|sulpirida|lisdexanfetamina|modafinil|naltrexona'.split('|'),
  OFTALMOLOGICO: 'latanoprost|bimatoprost|travoprost|tafluprost|brimonidina|dorzolamida|brinzolamida'.split('|'),
  DERMATOLOGICO_RX: 'clobetasol|desonida|tacrolimus|isotretinoina|adapaleno|tretinoina|peroxido de benzoilo|acido fusidico|mupirocina|calcipotriol|minoxidil|ciclopirox|ketoconazol|cetoconazol|tazaroteno|acido azelaico'.split('|'),
  ANTIPARASITARIO: 'albendazol|mebendazol|praziquantel|permetrina|benzoato de benzilo|pirantel|nitazoxanida|ivermectina|cloroquina|atovaquona|proguanil|mefloquina'.split('|'),
  ONCOLOGIA_IMUNOMODULADOR: 'tamoxifeno|anastrozol|letrozol|exemestano|capecitabina|imatinib|metotrexato|azatioprina|micofenolato|ciclosporina|leflunomida|hidroxicloroquina|bicalutamida|abiraterona|enzalutamida|tofacitinib|baricitinib|adalimumab|etanercept|infliximab|rituximab|trastuzumab'.split('|'),
  VACINA_IMUNOSSORO: ['vacina'],
  OUTROS_RX: 'beta-histina|lisados bacterianos liofilizados|vinpocetina|vareniclina|nicotina|orlistato|colagenase|toxina botulinica|toxina botulinica tipo a|polisulfato de pentosano'.split('|'),
};

export const DCI_FAMILIA_OVERRIDE = new Map<string, string>();
for (const [fam, list] of Object.entries(RAW_DCI_OVERRIDE)) {
  for (const item of list) {
    DCI_FAMILIA_OVERRIDE.set(norm(item), fam);
  }
}

export const DCI_ALIAS: Record<string, string> = {
  'cloromadinona': 'clormadinona',
  'gemfibrozil': 'gemfibrozil',
  'genfibrozilo': 'gemfibrozil',
  'clorofenamina': 'clorofenamina',
  'acido alendronico': 'alendronato',
  'acido ibandronico': 'ibandronato',
  'risedronato de sodio': 'risedronato',
  'acido zoledronico': 'zoledronato',
  'valproato semissodico': 'acido valproico',
  'levotiroxina sodica': 'levotiroxina',
  'metamizol magnesico': 'metamizol',
  'dabigatrano etexilato': 'dabigatrano',
  'olmesartan medoxomilo': 'olmesartan',
  'estradiol hemi-hidratado': 'estradiol',
  'furoato de fluticasona': 'fluticasona',
  'colecalciferol (vitamina d3)': 'colecalciferol',
  'perindo': 'perindopril',
  'indapa': 'indapamida',
  'amlodipi': 'amlodipina',
  'hidroclorotiazid': 'hidroclorotiazida',
  'febuxostate': 'febuxostat',
  'ketoconazol': 'cetoconazol',
};

export const DCI_IGNORAR = new Set<string>([
  'acido clavulanico',
  'clavulanato de potassio',
  'sulbactam',
  'tazobactam',
  'carbidopa',
  'benserazida',
  'cilastatina',
  'cafeina',
]);

export const COMBO_OVERRIDE = new Map<string, string>([
  ['azelastina+fluticasona', 'NASAL_RX'],
  ['ipratropio+xilometazolina', 'NASAL_RX'],
  ['dexpantenol+xilometazolina', 'NASAL_RX'],
  ['dimetindeno+fenilefrina', 'NASAL_RX'],
  ['dorzolamida+timolol', 'OFTALMOLOGICO'],
  ['latanoprost+timolol', 'OFTALMOLOGICO'],
  ['clindamicina+peroxido de benzoilo', 'DERMATOLOGICO_RX'],
  ['aciclovir+hidrocortisona', 'DERMATOLOGICO_RX'],
  ['hidrocortisona+miconazol', 'DERMATOLOGICO_RX'],
  ['bacitracina+neomicina', 'DERMATOLOGICO_RX'],
  ['bacitracina+polimixina b', 'DERMATOLOGICO_RX'],
  ['fluticasona+umeclidinio+vilanterol', 'RESPIRATORIO_ASMA_DPOC'],
  ['budesonida+formoterol', 'RESPIRATORIO_ASMA_DPOC'],
  ['sacubitril+valsartan', 'ANTIHIPERTENSOR'],
  ['dutasterida+tansulosina', 'UROLOGICO'],
  ['solifenacina+tansulosina', 'UROLOGICO'],
  ['carbidopa+levodopa', 'NEURO_ANTIPSICOTICO'],
  ['carbidopa+entacapona+levodopa', 'NEURO_ANTIPSICOTICO'],
]);

export const DCI_DUAL_VIA = new Set<string>(
  'aciclovir|terbinafina|cetoconazol|ketoconazol|clotrimazol|miconazol|econazol|nistatina|budesonida|fluticasona|mometasona|beclometasona|betametasona|hidrocortisona|azelastina|ipratropio|diclofenac|ibuprofeno|cetoprofeno|flurbiprofeno|metronidazol|clindamicina|ciprofloxacina|ofloxacina|timolol|brimonidina|lidocaina|benzidamina|minoxidil|peroxido de benzoilo|cloro-hexidina|iodopovidona'.split('|')
);

export const DCI_RESTRICAO_EXTRA: Record<string, string[]> = {
  finerenona: ['aine', 'contem_acucar'],
};

export const AINES_SET = new Set<string>(
  'ibuprofeno|dexibuprofeno|diclofenac|naproxeno|flurbiprofeno|cetoprofeno|dexcetoprofeno|etoricoxib|nimesulida|acemetacina|indometacina|celecoxib|aceclofenac|meloxicam|piroxicam|picetoprofeno|etofenamato|acido flufenamico|acido mefenamico|acido niflumico|etodolac|lornoxicam|tenoxicam|nabumetona|parecoxib|cetorolac|acido acetilsalicilico'.split('|')
);

export const VASOCONSTRITOR_SET = new Set<string>(
  'fenilefrina|xilometazolina|oximetazolina|nafazolina|tetrizolina|tramazolina|pseudoefedrina|efedrina|epinefrina|ergotamina'.split('|')
);

export const SODIO_DCI_SET = new Set<string>([
  'bicarbonato de sodio',
  'alginato de sodio',
]);

export const INTERAGE_ANTICOAGULANTE_DCI_SET = new Set<string>(
  'salicilato de metilo|salicilato de dietilamina|salicilato de colina|vinpocetina|heparinoide|polisulfato de pentosano|ginkgo biloba|ginkgo|hipericao|vitamina k|fitomenadiona'.split('|')
);

export interface StemRule {
  ordem: number;
  regex: RegExp;
  familia_id: string;
  apenasSistemica?: boolean;
  excecoes?: Record<string, string>;
}

const VIAS_NAO_SISTEMICAS = new Set<ViaClasse>(['OFTALMICA', 'OTICA', 'NASAL', 'VAGINAL', 'TOPICA']);

export const DCI_STEM_REGRAS: StemRule[] = [
  { ordem: 10, regex: /^cef/, familia_id: 'ANTIBIOTICO_SISTEMICO' },
  { ordem: 11, regex: /(cilina|floxacina|tromicina|ciclina)$/, familia_id: 'ANTIBIOTICO_SISTEMICO' },
  { ordem: 20, regex: /(statina)$/, familia_id: 'ESTATINA_HIPOLIPEMIANTE' },
  { ordem: 21, regex: /(sartan|pril|olol|dipina)$/, familia_id: 'ANTIHIPERTENSOR' },
  { ordem: 22, regex: /(tiazida)$/, familia_id: 'DIURETICO' },
  { ordem: 30, regex: /(gliptina|gliflozina|glutido)$|^insulina/, familia_id: 'ANTIDIABETICO' },
  { ordem: 31, regex: /(xabano|parina|gatrano|grel)$/, familia_id: 'ANTICOAGULANTE_ANTIAGREGANTE' },
  { ordem: 40, regex: /(?<!pi)prazol$/, familia_id: 'ANTIULCEROSO_ANTIACIDO', excecoes: { aripiprazol: 'NEURO_ANTIPSICOTICO', brexpiprazol: 'NEURO_ANTIPSICOTICO' } },
  { ordem: 41, regex: /(tidina)$/, familia_id: 'ANTIULCEROSO_ANTIACIDO' },
  { ordem: 50, regex: /(profeno|coxib|fenac|oxicam)$/, familia_id: 'AINE_ANTIINFLAMATORIO' },
  { ordem: 51, regex: /(triptano)$/, familia_id: 'ENXAQUECA' },
  { ordem: 52, regex: /(dronato)$/, familia_id: 'OSTEOARTICULAR_OSSEO' },
  { ordem: 60, regex: /(azepam|azolam)$/, familia_id: 'PSICOFARMACO' },
  { ordem: 61, regex: /(oxetina|citalopram)$/, familia_id: 'PSICOFARMACO', excecoes: { atomoxetina: 'NEURO_ANTIPSICOTICO' } },
  { ordem: 70, regex: /(vir)$/, familia_id: 'ANTIVIRAL_ANTIFUNGICO_SIST' },
  { ordem: 71, regex: /(conazol)$/, familia_id: 'ANTIVIRAL_ANTIFUNGICO_SIST', apenasSistemica: true },
  { ordem: 72, regex: /(mab|nib)$/, familia_id: 'ONCOLOGIA_IMUNOMODULADOR' },
  { ordem: 80, regex: /(terol|tropio|lucaste)$/, familia_id: 'RESPIRATORIO_ASMA_DPOC' },
  { ordem: 81, regex: /(tadina)$/, familia_id: 'ANTIHISTAMINICO' },
  { ordem: 82, regex: /(setrom)$/, familia_id: 'GASTROINTESTINAL_OUTROS' },
  { ordem: 90, regex: /^vacina\b/, familia_id: 'VACINA_IMUNOSSORO' },
];

export function matchStem(comp: string, via?: ViaClasse): string | null {
  const isNonSystemic = Boolean(via && VIAS_NAO_SISTEMICAS.has(via));
  for (const r of DCI_STEM_REGRAS) {
    if (r.apenasSistemica && isNonSystemic) continue;
    if (r.excecoes && r.excecoes[comp]) return r.excecoes[comp];
    if (r.regex.test(comp)) return r.familia_id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Component-based DCI Normalizer
// ---------------------------------------------------------------------------
const SALT_PATTERNS: RegExp[] = [
  /^cloridrato de\s+/,
  /^bromidrato de\s+/,
  /^sulfato de\s+/,
  /^fumarato de\s+/,
  /^maleato de\s+/,
  /^succinato de\s+/,
  /^mesilato de\s+/,
  /^besilato de\s+/,
  /^tartarato de\s+/,
  /^oxalato de\s+/,
  /^citrato de\s+(?!sodio$)/,
  /^valerato de\s+/,
  /^propionato de\s+/,
  /^dipropionato de\s+/,
  /^acetato de\s+(?!calcio$)/,
  /^furoato de\s+/,
  /^pivalato de\s+/,
  /^enantato de\s+/,
  /^decanoato de\s+/,
  /^palmitato de\s+/,
  /\s+(sodico|sodica|potassico|potassica|magnesico|magnesica|calcico|calcica|medoxomilo|etexilato|hemi-hidratado|hemihidratado|monohidratado|mono-hidratado|dihidratado|di-hidratado|trihidratado|tri-hidratado|anidro|cloridrato|bromidrato|besilato|maleato|succinato|mesilato|fumarato|tartarato|oxalato|tosilato|valerato|propionato|dipropionato|acetonido|furoato|cilexetil|pivoxil|proxetil|axetil|tert-butilamina|arginina|erbumina|trometamol|lisina)$/g,
];

// All known canonical DCI keys for prefix matching (>= 5 chars)
const ALL_KNOWN_DCIS: string[] = Array.from(
  new Set([
    ...DCI_FAMILIA_OVERRIDE.keys(),
    ...Object.values(DCI_ALIAS),
    ...DCI_IGNORAR,
    ...DCI_DUAL_VIA,
    ...AINES_SET,
    ...VASOCONSTRITOR_SET,
    'acido acetilsalicilico',
  ])
);

export function normalizarComponenteDci(rawComp: string): string {
  let c = norm(rawComp);
  if (!c) return '';

  // 1. Direct alias match before salt stripping
  if (DCI_ALIAS[c]) return DCI_ALIAS[c];

  // 2. Remove parenthetical notes like "(vitamina d3)" unless in alias
  c = c.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (DCI_ALIAS[c]) return DCI_ALIAS[c];

  // 3. If already known canonical DCI, return immediately
  if (DCI_FAMILIA_OVERRIDE.has(c) || DCI_IGNORAR.has(c) || c === 'acido acetilsalicilico') {
    return c;
  }

  // 4. Strip salts and hydrates iteratively
  let prev = '';
  while (c !== prev) {
    prev = c;
    for (const pat of SALT_PATTERNS) {
      c = c.replace(pat, '').trim();
    }
  }

  if (DCI_ALIAS[c]) return DCI_ALIAS[c];
  if (DCI_FAMILIA_OVERRIDE.has(c) || DCI_IGNORAR.has(c) || c === 'acido acetilsalicilico') {
    return c;
  }

  // 5. Prefix matching for truncated components (>= 5 chars) if unambiguous
  if (c.length >= 5) {
    if (c.startsWith('vacina ')) return 'vacina';
    const matches = ALL_KNOWN_DCIS.filter(k => k.startsWith(c));
    // Check if all matches map to the exact same canonical DCI or there is a single match
    if (matches.length === 1) {
      return matches[0];
    }
  }

  return c;
}

export function normalizarESepararDci(rawDci?: string | null): string[] {
  if (!rawDci) return [];
  const n = norm(rawDci);
  if (!n) return [];

  // Check if entire string is in alias (e.g. "carbonato de di-hidroxido de aluminio e sodio")
  if (DCI_ALIAS[n] || DCI_FAMILIA_OVERRIDE.has(n)) {
    return [DCI_ALIAS[n] ?? n];
  }

  // Split by "+", "/", or " + "
  // Note: only split by " e " when it is not part of a known salt like "aluminio e sodio"
  const rawParts = n.split(/\s*\+\s*|\s*\/\s*/);
  const comps: string[] = [];
  for (const part of rawParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (DCI_FAMILIA_OVERRIDE.has(trimmed) || DCI_ALIAS[trimmed]) {
      comps.push(normalizarComponenteDci(trimmed));
    } else if (/\s+e\s+/.test(trimmed) && !trimmed.includes('aluminio e sodio')) {
      for (const sub of trimmed.split(/\s+e\s+/)) {
        const normSub = normalizarComponenteDci(sub);
        if (normSub) comps.push(normSub);
      }
    } else {
      const normPart = normalizarComponenteDci(trimmed);
      if (normPart) comps.push(normPart);
    }
  }

  return Array.from(new Set(comps));
}

// Extract DCI from generic designation when dci is missing
export function extrairDciDeDesignacaoGenerico(designacao: string): string | null {
  const n = norm(designacao);
  if (!n) return null;
  // Check if starts with "DCI1 + DCI2" or a single known DCI
  // Sort known DCIs by length descending so longest match wins
  const sortedKnown = [...ALL_KNOWN_DCIS].sort((a, b) => b.length - a.length);
  for (const k of sortedKnown) {
    if (n.startsWith(k + ' ') || n.startsWith(k + '+')) {
      // Check if there is a "+ <second dci>" right after
      const rest = n.slice(k.length).trim();
      if (rest.startsWith('+')) {
        const afterPlus = rest.slice(1).trim();
        for (const k2 of sortedKnown) {
          if (afterPlus.startsWith(k2 + ' ') || afterPlus.startsWith(k2 + ',')) {
            return `${k} + ${k2}`;
          }
        }
      }
      return k;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Via Resolution (p.via -> forma -> designacao)
// ---------------------------------------------------------------------------
export type ViaClasse =
  | 'ORAL_INDET'
  | 'ORAL_SOLIDO'
  | 'ORAL_LIQUIDO_OU_MASTIGAVEL'
  | 'SUBLINGUAL'
  | 'BUCAL'
  | 'TRANSDERMICA'
  | 'INALACAO'
  | 'INJETAVEL'
  | 'OFTALMICA'
  | 'OTICA'
  | 'NASAL'
  | 'VAGINAL'
  | 'RETAL'
  | 'TOPICA'
  | 'AMBIGUA'
  | 'DESCONHECIDA';

export type FonteVia = 'ESTRUTURADA' | 'FORMA' | 'DESIGNACAO' | 'DESCONHECIDA';

export interface ViaFpEntry {
  via_classe: ViaClasse;
  sistemica: boolean | null;
  rota_familia: string | null;
}

export const VIA_FP_MAP: Record<string, ViaFpEntry> = {
  'oral': { via_classe: 'ORAL_INDET', sistemica: true, rota_familia: null },
  'sublingual': { via_classe: 'SUBLINGUAL', sistemica: true, rota_familia: null },
  'transdermica': { via_classe: 'TRANSDERMICA', sistemica: true, rota_familia: null },
  'inalatoria': { via_classe: 'INALACAO', sistemica: true, rota_familia: null },
  'im': { via_classe: 'INJETAVEL', sistemica: true, rota_familia: null },
  'iv': { via_classe: 'INJETAVEL', sistemica: true, rota_familia: null },
  'iv / im': { via_classe: 'INJETAVEL', sistemica: true, rota_familia: null },
  'iv / im / sc': { via_classe: 'INJETAVEL', sistemica: true, rota_familia: null },
  'oftalmica': { via_classe: 'OFTALMICA', sistemica: false, rota_familia: 'OFTALMOLOGICO' },
  'nasal': { via_classe: 'NASAL', sistemica: false, rota_familia: 'NASAL_RX' },
  'cutanea': { via_classe: 'TOPICA', sistemica: false, rota_familia: 'DERMATOLOGICO_RX' },
  'oral/vaginal': { via_classe: 'AMBIGUA', sistemica: null, rota_familia: null },
};

export interface ViaFormaRule {
  ordem: number;
  regex: RegExp;
  via_classe: ViaClasse;
  rota_familia: string | null;
  acucar_relevante: boolean;
  sodio_relevante: boolean;
}

export const VIA_FORMA_REGRAS: ViaFormaRule[] = [
  { ordem: 1, regex: /colirio|oftalm/, via_classe: 'OFTALMICA', rota_familia: 'OFTALMOLOGICO', acucar_relevante: false, sodio_relevante: false },
  { ordem: 2, regex: /auricular/, via_classe: 'OTICA', rota_familia: 'OTOLOGICO', acucar_relevante: false, sodio_relevante: false },
  { ordem: 3, regex: /nasal/, via_classe: 'NASAL', rota_familia: 'NASAL_RX', acucar_relevante: false, sodio_relevante: false },
  { ordem: 4, regex: /vaginal|^ovulo/, via_classe: 'VAGINAL', rota_familia: 'GINECOLOGICO_ANTIINFECCIOSO', acucar_relevante: false, sodio_relevante: false },
  { ordem: 5, regex: /retal|supositorio/, via_classe: 'RETAL', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 6, regex: /bucal|gargarej|lavagem da boca|dental|dentifrica|gel oral/, via_classe: 'BUCAL', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 7, regex: /inalacao/, via_classe: 'INALACAO', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 8, regex: /transdermic|emplastro|adesivo/, via_classe: 'TRANSDERMICA', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 9, regex: /cutane|champo|pomada|^creme|^gel$|verniz|penso/, via_classe: 'TOPICA', rota_familia: 'DERMATOLOGICO_RX', acucar_relevante: false, sodio_relevante: false },
  { ordem: 9.5, regex: /granulado.*efervescente/, via_classe: 'ORAL_LIQUIDO_OU_MASTIGAVEL', rota_familia: null, acucar_relevante: true, sodio_relevante: true },
  { ordem: 10, regex: /xarope|pastilha|chupar|goma|mastigar|suspensao oral|solucao oral|sol oral|gotas orais|granulado|po para solucao oral|po para suspensao oral|concentrado para solucao oral|emulsao oral/, via_classe: 'ORAL_LIQUIDO_OU_MASTIGAVEL', rota_familia: null, acucar_relevante: true, sodio_relevante: false },
  { ordem: 11, regex: /efervescente/, via_classe: 'ORAL_SOLIDO', rota_familia: null, acucar_relevante: false, sodio_relevante: true },
  { ordem: 12, regex: /^comp|^caps|comprimido|capsula|orodispersivel|sublingual|globulos/, via_classe: 'ORAL_SOLIDO', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 12.5, regex: /injetavel|perfusao|seringa|caneta/, via_classe: 'INJETAVEL', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 13, regex: /^sol$|^susp$|^gotas$|^spray$|^liofilizado/, via_classe: 'AMBIGUA', rota_familia: null, acucar_relevante: true, sodio_relevante: false },
];

export const DESIGNACAO_VIA_REGRAS: { ordem: number; regex: RegExp; via_classe: ViaClasse; rota_familia: string | null; acucar_relevante: boolean; sodio_relevante: boolean }[] = [
  { ordem: 1, regex: /cr vag|disp vag|comp vag|\bovulo|\bovulos|esp vag|sol vag/, via_classe: 'VAGINAL', rota_familia: 'GINECOLOGICO_ANTIINFECCIOSO', acucar_relevante: false, sodio_relevante: false },
  { ordem: 2, regex: /\bsup\b|supos|pda ret|cr ret|gel ret|sol ret/, via_classe: 'RETAL', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 3, regex: /colirio|\bcol\b|gotas oft|sol oft|pda oft|gel oft/, via_classe: 'OFTALMICA', rota_familia: 'OFTALMOLOGICO', acucar_relevante: false, sodio_relevante: false },
  { ordem: 4, regex: /gotas aur|sol aur|susp aur/, via_classe: 'OTICA', rota_familia: 'OTOLOGICO', acucar_relevante: false, sodio_relevante: false },
  { ordem: 5, regex: /po nasal|sol nasal|spray nasal|gotas nasais|susp nasal/, via_classe: 'NASAL', rota_familia: 'NASAL_RX', acucar_relevante: false, sodio_relevante: false },
  { ordem: 6, regex: /po inal|sol inal|susp.*inal|inalad|nebuliz|neb\b/, via_classe: 'INALACAO', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 7, regex: /adesivo transder|\bemp\b|emplastro|\badesivo\b/, via_classe: 'TRANSDERMICA', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 8, regex: /esp cut|sol cut|susp cut|pasta cut|verniz|\bpda\b|pomada|champo|\bloc\b|locao/, via_classe: 'TOPICA', rota_familia: 'DERMATOLOGICO_RX', acucar_relevante: false, sodio_relevante: false },
  { ordem: 9, regex: /sol injet|sol inj\b|\binj\b|seringa|caneta|\bpen\b|\bimpl\b/, via_classe: 'INJETAVEL', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 10, regex: /amp beb|amp bebiv/, via_classe: 'ORAL_LIQUIDO_OU_MASTIGAVEL', rota_familia: null, acucar_relevante: true, sodio_relevante: false },
  { ordem: 11, regex: /granul eferv|po eferv/, via_classe: 'ORAL_LIQUIDO_OU_MASTIGAVEL', rota_familia: null, acucar_relevante: true, sodio_relevante: true },
  { ordem: 11.5, regex: /comp eferv|comprimido.*eferv/, via_classe: 'ORAL_SOLIDO', rota_familia: null, acucar_relevante: false, sodio_relevante: true },
  { ordem: 12, regex: /\bxar\b|xarope|susp oral|sol oral|gotas orais|\bpast\b|pastilha|\bgoma|mastig|po p\/ sol oral|po sol oral|gran lib mod/, via_classe: 'ORAL_LIQUIDO_OU_MASTIGAVEL', rota_familia: null, acucar_relevante: true, sodio_relevante: false },
  { ordem: 13, regex: /\bcr\b|\bcreme\b/, via_classe: 'TOPICA', rota_familia: 'DERMATOLOGICO_RX', acucar_relevante: false, sodio_relevante: false },
  { ordem: 14, regex: /\bcomp\b|comp rev|\bcp\b|\bcaps\b|\bcaps?\b|\bcps\b|orodisp|sublingual/, via_classe: 'ORAL_SOLIDO', rota_familia: null, acucar_relevante: false, sodio_relevante: false },
  { ordem: 15, regex: /\bsol\b|\bsusp\b|\bgel\b|\bgotas\b|\bspray\b/, via_classe: 'AMBIGUA', rota_familia: null, acucar_relevante: true, sodio_relevante: false },
];

export const ROTA_FAMILIA_BY_VIA: Partial<Record<ViaClasse, string>> = {
  OFTALMICA: 'OFTALMOLOGICO',
  OTICA: 'OTOLOGICO',
  NASAL: 'NASAL_RX',
  VAGINAL: 'GINECOLOGICO_ANTIINFECCIOSO',
  TOPICA: 'DERMATOLOGICO_RX',
};

function viasCompativeis(v1: ViaClasse, v2: ViaClasse): boolean {
  if (v1 === v2) return true;
  if (v1 === 'AMBIGUA' || v2 === 'AMBIGUA') return true;
  const orais = new Set<ViaClasse>(['ORAL_INDET', 'ORAL_SOLIDO', 'ORAL_LIQUIDO_OU_MASTIGAVEL', 'SUBLINGUAL', 'BUCAL']);
  if (orais.has(v1) && orais.has(v2)) return true;
  return false;
}

export interface ViaResolution {
  via: ViaClasse;
  fonte: FonteVia;
  conflito: boolean;
  detalhe_conflito?: string;
  rota_familia: string | null;
  acucar_relevante: boolean;
  sodio_relevante: boolean;
}

export function resolverVia(p: {
  via_fp?: string | null;
  forma_bd?: string | null;
  forma_fp?: string | null;
  designacao: string;
}): ViaResolution {
  const nViaFp = norm(p.via_fp);
  const v1Entry = nViaFp ? VIA_FP_MAP[nViaFp] : undefined;
  const v1 = v1Entry?.via_classe;

  const formaRaw = p.forma_bd || p.forma_fp || '';
  const nForma = norm(formaRaw);
  let v2Rule: ViaFormaRule | undefined;
  if (nForma) {
    v2Rule = VIA_FORMA_REGRAS.find(r => r.regex.test(nForma));
  }
  const v2 = v2Rule?.via_classe;

  const nDesig = norm(p.designacao);
  const v3Rule = nDesig ? DESIGNACAO_VIA_REGRAS.find(r => r.regex.test(nDesig)) : undefined;
  const v3 = v3Rule?.via_classe;

  let via: ViaClasse = v1 ?? v2 ?? v3 ?? 'DESCONHECIDA';
  const fonte: FonteVia = v1 ? 'ESTRUTURADA' : v2 ? 'FORMA' : v3 ? 'DESIGNACAO' : 'DESCONHECIDA';

  // Refine ORAL_INDET or AMBIGUA with form or designation when available
  if (v1 === 'ORAL_INDET') {
    if (v2 && v2.startsWith('ORAL_')) via = v2;
    else if (v3 && v3.startsWith('ORAL_')) via = v3;
  }
  const v3OverrodeAmbigua = !v1 && v2 === 'AMBIGUA' && Boolean(v3 && v3 !== 'AMBIGUA');
  if (v3OverrodeAmbigua && v3) {
    via = v3;
  }

  const isExpectedInhalerCaps = v1 === 'INALACAO' && /po inal/.test(nDesig);
  const conflito = Boolean(v1 && v2 && !viasCompativeis(v1, v2) && !isExpectedInhalerCaps);
  const detalhe_conflito = conflito ? `via_fp=${p.via_fp}(${v1}) vs forma=${formaRaw}(${v2})` : undefined;

  const rota_familia = ROTA_FAMILIA_BY_VIA[via] ?? null;
  const acucar_relevante = v3OverrodeAmbigua
    ? Boolean(v3Rule?.acucar_relevante)
    : (v2Rule?.acucar_relevante ??
      v3Rule?.acucar_relevante ??
      (via === 'ORAL_LIQUIDO_OU_MASTIGAVEL' || via === 'AMBIGUA' || via === 'ORAL_INDET'));
  const sodio_relevante =
    Boolean(v2Rule?.sodio_relevante || v3Rule?.sodio_relevante || /eferv/.test(nForma) || /eferv/.test(nDesig));

  return {
    via,
    fonte,
    conflito,
    detalhe_conflito,
    rota_familia,
    acucar_relevante,
    sodio_relevante,
  };
}

// ---------------------------------------------------------------------------
// 6. Category & Oral Possibility (for Parafarmácia / Non-Rx)
// ---------------------------------------------------------------------------
export type OralPossivel = 'SIM' | 'NAO' | 'MISTO';

export const CATEGORIA_ORAL_POSSIVEL: Record<string, OralPossivel> = {
  LABIAL: 'NAO',
  SOLARES: 'NAO',
  HIGIENE_ORAL: 'NAO',
  HIGIENE_INTIMA: 'NAO',
  HIGIENE_CORPORAL: 'NAO',
  DERMOCOSMETICA_CORPO: 'NAO',
  DERMOCOSMETICA_ROSTO: 'NAO',
  CAPILAR: 'NAO',
  NASAL: 'NAO',
  OLHOS: 'NAO',
  OUVIDOS: 'NAO',
  PES: 'NAO',
  SEXUALIDADE: 'NAO',
  MATERNIDADE: 'MISTO',
  PRIMEIROS_SOCORROS: 'NAO',
  DISPOSITIVOS_DIAGNOSTICO: 'NAO',
  ORTOPEDIA: 'NAO',
  ARTICULAR_MUSCULAR: 'MISTO',
  CIRCULACAO: 'MISTO',
  PUERICULTURA: 'MISTO',
  VITAMINAS_SUPLEMENTOS: 'SIM',
  FLORA_PROBIOTICOS: 'SIM',
  TOSSE_GRIPE: 'SIM',
  DIGESTIVO: 'SIM',
  DOR_FEBRE: 'SIM',
  EMAGRECIMENTO: 'SIM',
  INTERNO_NAO_COMERCIAL: 'NAO',
};

// ---------------------------------------------------------------------------
// 7. Conservative precisa_receita Resolution (Section 1 of Review Spec)
// ---------------------------------------------------------------------------
export type EstadoQualidadeRx =
  | 'OFICIAL'
  | 'OFICIAL_EXTERNO'
  | 'VALIDADO_REGRA'
  | 'REGRA_NAO_VALIDADA'
  | 'CONFLITO_RX'
  | 'DESCONHECIDO';

export interface PrecisaReceitaResolution {
  precisa_receita: boolean;
  estado_rx: EstadoQualidadeRx;
  conflito_rx: boolean;
  motivo_conflito?: string;
  permite_marketing: boolean;
}

export function resolverPrecisaReceita(p: {
  in_infarmed_mnsrm: boolean;
  fp_m?: number | null; // 1 = MSRM, 0 = Non-MSRM, undefined/null = not in firstpharma_dictionary
  sifarma_tipo_venda?: string | null; // 'MSRM' | 'MNSRM' | 'VENDA_LIVRE' | null
  has_dci: boolean;
  has_atc_gh: boolean;
  has_med_forma: boolean;
  has_hmr3: boolean;
}): PrecisaReceitaResolution {
  // 1. Official Infarmed MNSRM list always wins -> false (OFICIAL)
  if (p.in_infarmed_mnsrm) {
    return {
      precisa_receita: false,
      estado_rx: 'OFICIAL',
      conflito_rx: false,
      permite_marketing: true,
    };
  }

  // 2. firstpharma_dictionary.m === 1 -> true (OFICIAL_EXTERNO)
  if (p.fp_m === 1) {
    return {
      precisa_receita: true,
      estado_rx: 'OFICIAL_EXTERNO',
      conflito_rx: false,
      permite_marketing: false,
    };
  }

  const sifarmaIsMsrm = p.sifarma_tipo_venda === 'MSRM';
  const pareceMedicamento = p.has_dci || p.has_atc_gh;

  // 3. firstpharma_dictionary.m === 0 (outside Infarmed MNSRM list)
  if (p.fp_m === 0) {
    // Discordance between sources: Sifarma says MSRM, or it has DCI/atc_gh (looks like medication not in Infarmed MNSRM)
    if (sifarmaIsMsrm || pareceMedicamento) {
      return {
        precisa_receita: true,
        estado_rx: 'CONFLITO_RX',
        conflito_rx: true,
        motivo_conflito: sifarmaIsMsrm
          ? 'firstpharma.m=0 mas Sifarma tipo_venda=MSRM (fora da lista Infarmed MNSRM)'
          : 'firstpharma.m=0 mas tem DCI/atc_gh fora da lista Infarmed MNSRM',
        permite_marketing: false,
      };
    }
    // Parafarmácia / non-medication with m === 0 and Sifarma != MSRM
    return {
      precisa_receita: false,
      estado_rx: p.has_hmr3 ? 'VALIDADO_REGRA' : 'REGRA_NAO_VALIDADA',
      conflito_rx: false,
      permite_marketing: p.has_hmr3, // Only validated hmr3 rules allow marketing/cross-sell by default
    };
  }

  // 4. Not in firstpharma_dictionary and not in Infarmed MNSRM
  if (sifarmaIsMsrm || pareceMedicamento || p.has_med_forma) {
    return {
      precisa_receita: true,
      estado_rx: sifarmaIsMsrm ? 'OFICIAL_EXTERNO' : 'CONFLITO_RX',
      conflito_rx: !sifarmaIsMsrm,
      motivo_conflito: !sifarmaIsMsrm ? 'Sem match no dicionário mas com sinais de medicamento (DCI/forma)' : undefined,
      permite_marketing: false,
    };
  }

  // 5. No match and no signs of medication -> precisa_receita = false, but estado = DESCONHECIDO (permite_marketing = false)
  return {
    precisa_receita: false,
    estado_rx: 'DESCONHECIDO',
    conflito_rx: false,
    permite_marketing: false,
  };
}

// ---------------------------------------------------------------------------
// 8. Full Resolver for Family, Via & Tags
// ---------------------------------------------------------------------------
function aasPorDose(dosagem?: string | null, designacao?: string | null): string {
  const txt = `${dosagem || ''} ${designacao || ''}`;
  const m = txt.match(/(\d+(?:[.,]\d+)?)\s*mg\b/i);
  if (m) {
    const val = parseFloat(m[1].replace(',', '.'));
    if (val <= 150) return 'ANTICOAGULANTE_ANTIAGREGANTE';
  }
  return 'ANALGESICO_NAO_OPIOIDE';
}

export const CATEGORIAS_RISCO_SEM_DCI = new Set<string>([
  'DOR_FEBRE',
  'TOSSE_GRIPE',
  'NASAL',
  'ARTICULAR_MUSCULAR',
  'DIGESTIVO',
  'OLHOS',
  'CIRCULACAO',
]);

export function detectarUsoVeterinario(designacao: string, hmr3?: string | null): boolean {
  const nHmr = norm(hmr3);
  if (nHmr === 'endoparasiticidas' || nHmr === 'antiparasitarios internos e externos' || nHmr === 'insecticidas e ectoparasiticidas') {
    return true;
  }
  const nDes = norm(designacao);
  if (/\bvet\b|\bgatos?\b|\bcaes\b|\bcao\b/.test(nDes)) return true;
  return false;
}

export interface FamilyResolutionResult {
  componentes_normalizados: string[];
  via_res: ViaResolution;
  estado_via: 'OK' | 'AMBIGUA_VIA';
  uso_veterinario: boolean;
  familia_principal: string | null;
  familias: string[];
  tags: string[]; // union of tags_presentes + tags_desconhecidas (legacy alias)
  tags_presentes: string[];
  tags_desconhecidas: string[];
  contem_acucar: 'SIM' | 'NAO' | 'DESCONHECIDO';
  metodo_familia: 'COMBO_OVERRIDE' | 'ROTA_NAO_SISTEMICA' | 'OVERRIDE' | 'STEM' | 'GEN_DESIGNACAO' | 'OUTROS_RX' | 'NAO_APLICAVEL';
  qualidade_familia: 'VALIDADO_REGRA' | 'REGRA_NAO_VALIDADA';
  conflito_override_vs_stem: { dci: string; override: string; stem: string }[];
}

export function resolverProdutoClinico(p: {
  precisa_receita: boolean;
  dci_raw?: string | null;
  via_fp?: string | null;
  forma_bd?: string | null;
  forma_fp?: string | null;
  dosagem?: string | null;
  designacao: string;
  hmr3?: string | null;
  categoria_id?: string | null;
}): FamilyResolutionResult {
  const uso_veterinario = detectarUsoVeterinario(p.designacao, p.hmr3);

  // Step 1: Normalize DCI components (fallback to generic designation extraction if MSRM and no DCI)
  let comps = normalizarESepararDci(p.dci_raw);
  let extractedFromGen = false;
  if (comps.length === 0 && p.precisa_receita) {
    const ext = extrairDciDeDesignacaoGenerico(p.designacao);
    if (ext) {
      comps = normalizarESepararDci(ext);
      extractedFromGen = true;
    }
  }

  // Step 2: Resolve Via
  const via_res = resolverVia({
    via_fp: p.via_fp,
    forma_bd: p.forma_bd,
    forma_fp: p.forma_fp,
    designacao: p.designacao,
  });

  // Check if via is relevant
  const oralPoss = p.categoria_id ? (CATEGORIA_ORAL_POSSIVEL[p.categoria_id] ?? 'MISTO') : 'MISTO';
  const hasDualOrAine = comps.some(c => DCI_DUAL_VIA.has(c) || AINES_SET.has(c));
  const viaRelevante = p.precisa_receita ? hasDualOrAine : (hasDualOrAine || oralPoss !== 'NAO');
  const isViaAmbigua = via_res.via === 'AMBIGUA' || via_res.via === 'DESCONHECIDA';
  const estado_via: 'OK' | 'AMBIGUA_VIA' = viaRelevante && isViaAmbigua ? 'AMBIGUA_VIA' : 'OK';

  // Step 3: Derive safety tags (split into tags_presentes [SIM] and tags_desconhecidas [DESCONHECIDO])
  const tagsPresentes = new Set<string>();
  const tagsDesconhecidas = new Set<string>();

  for (const c of comps) {
    if (AINES_SET.has(c)) {
      if (via_res.via === 'TOPICA') tagsPresentes.add('aine_topico');
      else tagsPresentes.add('aine'); // Conservative: unknown/ambiguous or systemic gets 'aine'
    }
    if (VASOCONSTRITOR_SET.has(c)) {
      tagsPresentes.add('vasoconstritor');
    }
    if (c === 'cafeina') {
      tagsPresentes.add('contem_cafeina_estimulante');
    }
    if (SODIO_DCI_SET.has(c)) {
      tagsPresentes.add('sodio_relevante');
    }
    if (INTERAGE_ANTICOAGULANTE_DCI_SET.has(c)) {
      tagsPresentes.add('interage_anticoagulante');
    }
    if (DCI_RESTRICAO_EXTRA[c]) {
      for (const extraTag of DCI_RESTRICAO_EXTRA[c]) {
        tagsPresentes.add(extraTag);
      }
    }
  }
  if (via_res.sodio_relevante) {
    tagsPresentes.add('sodio_relevante');
  }

  // Rule 1d fail-safe: Non-MSRM without DCI in therapeutic categories gets conservative unknown tags
  if (!p.precisa_receita && comps.length === 0 && p.categoria_id && CATEGORIAS_RISCO_SEM_DCI.has(p.categoria_id)) {
    tagsDesconhecidas.add('aine');
    tagsDesconhecidas.add('vasoconstritor');
    tagsDesconhecidas.add('contem_cafeina_estimulante');
  }

  // Determine contem_acucar
  const nDesig = norm(p.designacao);
  const isSugarFreeText = /sem acucar|sugar free|sem sacarose|para diabeticos|\bdiabet/.test(nDesig);
  let contem_acucar: 'SIM' | 'NAO' | 'DESCONHECIDO' = 'NAO';

  if (!p.precisa_receita && p.categoria_id && CATEGORIA_ORAL_POSSIVEL[p.categoria_id] === 'NAO') {
    contem_acucar = 'NAO';
  } else if (via_res.via === 'ORAL_SOLIDO' || via_res.via === 'TOPICA' || via_res.via === 'OFTALMICA' || via_res.via === 'OTICA' || via_res.via === 'NASAL' || via_res.via === 'VAGINAL' || via_res.via === 'RETAL' || via_res.via === 'TRANSDERMICA' || via_res.via === 'INALACAO' || via_res.via === 'INJETAVEL') {
    contem_acucar = 'NAO';
  } else if (via_res.via === 'ORAL_LIQUIDO_OU_MASTIGAVEL') {
    contem_acucar = isSugarFreeText ? 'NAO' : 'DESCONHECIDO';
  } else {
    // AMBIGUA, DESCONHECIDA, ORAL_INDET
    contem_acucar = isSugarFreeText ? 'NAO' : 'DESCONHECIDO';
  }

  if ((contem_acucar as string) === 'SIM') {
    tagsPresentes.add('contem_acucar');
  } else if (contem_acucar === 'DESCONHECIDO') {
    tagsDesconhecidas.add('contem_acucar');
  }

  const tagsPresentesArr = Array.from(tagsPresentes);
  const tagsDesconhecidasArr = Array.from(tagsDesconhecidas).filter(t => !tagsPresentes.has(t));
  const tagsUnionArr = Array.from(new Set([...tagsPresentesArr, ...tagsDesconhecidasArr]));

  // If NOT precisa_receita, we do NOT calculate familia_id
  if (!p.precisa_receita) {
    return {
      componentes_normalizados: comps,
      via_res,
      estado_via,
      uso_veterinario,
      familia_principal: null,
      familias: [],
      tags: tagsUnionArr,
      tags_presentes: tagsPresentesArr,
      tags_desconhecidas: tagsDesconhecidasArr,
      contem_acucar,
      metodo_familia: 'NAO_APLICAVEL',
      qualidade_familia: estado_via === 'AMBIGUA_VIA' ? 'REGRA_NAO_VALIDADA' : 'VALIDADO_REGRA',
      conflito_override_vs_stem: [],
    };
  }

  // Step 4: Resolve family for precisa_receita = true
  const activeComps = comps.filter(c => !DCI_IGNORAR.has(c));
  const conflito_override_vs_stem: { dci: string; override: string; stem: string }[] = [];

  // Check override vs stem conflicts for reporting
  for (const c of activeComps) {
    const ov = DCI_FAMILIA_OVERRIDE.get(c);
    const st = matchStem(c, via_res.via);
    if (ov && st && ov !== st) {
      conflito_override_vs_stem.push({ dci: c, override: ov, stem: st });
    }
  }

  const baseMeta = {
    componentes_normalizados: comps,
    via_res,
    uso_veterinario,
    tags: tagsUnionArr,
    tags_presentes: tagsPresentesArr,
    tags_desconhecidas: tagsDesconhecidasArr,
    contem_acucar,
    conflito_override_vs_stem,
  };

  // Layer 3: combo_override (exact sorted active components or all components)
  const comboKeyActive = [...activeComps].sort().join('+');
  const comboKeyAll = [...comps].sort().join('+');
  const comboFam = COMBO_OVERRIDE.get(comboKeyActive) ?? COMBO_OVERRIDE.get(comboKeyAll);
  if (comboFam) {
    return {
      ...baseMeta,
      estado_via,
      familia_principal: comboFam,
      familias: [comboFam],
      metodo_familia: 'COMBO_OVERRIDE',
      qualidade_familia: 'VALIDADO_REGRA',
    };
  }

  // Layer 5 check: if via is AMBIGUA/DESCONHECIDA and any component is in DCI_DUAL_VIA -> AMBIGUA_VIA
  if (isViaAmbigua && activeComps.some(c => DCI_DUAL_VIA.has(c))) {
    const fams = new Set<string>();
    for (const c of activeComps) {
      const f = c === 'acido acetilsalicilico' ? aasPorDose(p.dosagem, p.designacao) : (DCI_FAMILIA_OVERRIDE.get(c) ?? matchStem(c, via_res.via));
      if (f) fams.add(f);
    }
    const famList = Array.from(fams);
    return {
      ...baseMeta,
      estado_via: 'AMBIGUA_VIA',
      familia_principal: selectPrincipalFamily(famList),
      familias: famList.length ? famList : ['OUTROS_RX'],
      metodo_familia: 'OVERRIDE',
      qualidade_familia: 'REGRA_NAO_VALIDADA',
    };
  }

  // Layer 4: Non-systemic route (OFTALMICA | OTICA | NASAL | VAGINAL | TOPICA) -> route family (except topical AINE and vaginal hormones/contraceptives)
  const isAllAine = activeComps.length > 0 && activeComps.every(c => AINES_SET.has(c));
  const isVaginalHormoneOrContraceptive =
    via_res.via === 'VAGINAL' &&
    activeComps.length > 0 &&
    activeComps.every(c => {
      const ov = DCI_FAMILIA_OVERRIDE.get(c);
      return ov === 'HORMONAL_OUTROS' || ov === 'CONTRACETIVO_GINECOLOGICO';
    });

  if (via_res.rota_familia && !isVaginalHormoneOrContraceptive) {
    if (via_res.via === 'TOPICA' && isAllAine) {
      return {
        ...baseMeta,
        estado_via,
        familia_principal: 'AINE_ANTIINFLAMATORIO',
        familias: ['AINE_ANTIINFLAMATORIO'],
        metodo_familia: 'ROTA_NAO_SISTEMICA',
        qualidade_familia: 'VALIDADO_REGRA',
      };
    }
    return {
      ...baseMeta,
      estado_via,
      familia_principal: via_res.rota_familia,
      familias: [via_res.rota_familia],
      metodo_familia: 'ROTA_NAO_SISTEMICA',
      qualidade_familia: 'VALIDADO_REGRA',
    };
  }

  // Layer 6 & 7: Component override & stems
  const fams = new Set<string>();
  let usedStemOnly = false;
  let usedOverride = false;

  for (const c of activeComps) {
    if (c === 'acido acetilsalicilico') {
      fams.add(aasPorDose(p.dosagem, p.designacao));
      usedOverride = true;
      continue;
    }
    const ov = DCI_FAMILIA_OVERRIDE.get(c);
    if (ov) {
      fams.add(ov);
      usedOverride = true;
      continue;
    }
    const st = matchStem(c, via_res.via);
    if (st) {
      fams.add(st);
      usedStemOnly = true;
    }
  }

  const famList = Array.from(fams);
  if (famList.length === 0) {
    return {
      ...baseMeta,
      estado_via,
      familia_principal: 'OUTROS_RX',
      familias: ['OUTROS_RX'],
      metodo_familia: 'OUTROS_RX',
      qualidade_familia: 'REGRA_NAO_VALIDADA',
    };
  }

  return {
    ...baseMeta,
    estado_via,
    familia_principal: selectPrincipalFamily(famList),
    familias: famList,
    metodo_familia: extractedFromGen ? 'GEN_DESIGNACAO' : usedStemOnly && !usedOverride ? 'STEM' : 'OVERRIDE',
    qualidade_familia: extractedFromGen || usedStemOnly ? 'REGRA_NAO_VALIDADA' : 'VALIDADO_REGRA',
  };
}
