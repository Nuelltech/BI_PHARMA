/**
 * BI PHARMA — Lista Canónica de DCIs de Terapêutica Crónica
 * 
 * Regra P1.5 / P2.10 / Diretriz Clínica:
 * Medicamentos Sujeitos a Receita Médica (MSRM) destinados a terapêutica crónica
 * NUNCA podem ter a recomendação "não manter" ou "descontinuar da farmácia",
 * sob pena de quebrar a continuidade do tratamento aos doentes da comunidade.
 * No máximo, a recomendação deve ser "Trabalhar sob encomenda / Stock mínimo de segurança".
 */

export const CHRONIC_THERAPEUTIC_MOLECULES: readonly string[] = [
  // Anti-hipertensores e Cardiovasculares
  'enalapril',
  'ramipril',
  'lisinopril',
  'perindopril',
  'captopril',
  'losartan',
  'valsartan',
  'candesartan',
  'irbesartan',
  'olmesartan',
  'telmisartan',
  'amlodipina',
  'lercanidipina',
  'nifedipina',
  'felodipina',
  'diltiazem',
  'verapamil',
  'nebivolol',
  'bisoprolol',
  'carvedilol',
  'atenolol',
  'metoprolol',
  'hidroclorotiazida',
  'indapamida',
  'furosemida',
  'espironolactona',
  'eplerenona',

  // Hipolipemiantes / Estatinas
  'atorvastatina',
  'sinvastatina',
  'rosuvastatina',
  'pravastatina',
  'pitavastatina',
  'ezetimiba',
  'fenofibrato',

  // Antidiabéticos
  'metformina',
  'vildagliptina',
  'sitagliptina',
  'linagliptina',
  'saxagliptina',
  'dapagliflozina',
  'empagliflozina',
  'canagliflozina',
  'gliclazida',
  'glimepirida',
  'insulina',

  // Anticoagulantes e Antiagregantes
  'dabigatrano',
  'rivaroxabano',
  'apixabano',
  'edoxabano',
  'varfarina',
  'acenocumarol',
  'clopidogrel',
  'ticagrelor',
  'acido acetilsalicilico',

  // Sistema Nervoso Central / Antidepressivos / Antipsicóticos / Antiepiléticos
  'escitalopram',
  'citalopram',
  'sertralina',
  'fluoxetina',
  'paroxetina',
  'venlafaxina',
  'duloxetina',
  'mirtazapina',
  'trazodona',
  'pregabalina',
  'gabapentina',
  'lamotrigina',
  'levetiracetam',
  'carbamazepina',
  'oxcarbazepina',
  'valproato',
  'acido valproico',
  'topiramato',
  'olanzapina',
  'quetiapina',
  'risperidona',
  'aripiprazol',
  'haloperidol',
  'lítio',
  'litio',

  // Demência e Doença de Parkinson
  'donepezilo',
  'memantina',
  'rivastigmina',
  'levodopa',
  'carbidopa',
  'benserazida',
  'pramipexol',
  'ropinirol',

  // Tiroide e Outros Crónicos
  'levotiroxina',
  'tiamazol',
  'alendronato',
  'risedronato',
  'ibandronato',
  'metotrexato',
  'alfa-bloqueantes',
  'tansulosina',
  'silodosina',
  'dutasterida',
  'finasterida',
];

export function isTherapeuticChronic(dci?: string | null, designacao?: string | null): boolean {
  const normDci = (dci || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normDes = (designacao || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hay = `${normDci} ${normDes}`;

  return CHRONIC_THERAPEUTIC_MOLECULES.some((mol) => hay.includes(mol));
}
