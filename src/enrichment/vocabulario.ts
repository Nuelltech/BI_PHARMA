// Vocabulário controlado inicial (v1) de patologias e sintomas de balcão.
// Termos fora desta lista NÃO são descartados: ficam em `termos_novos`
// para revisão e alargamento do vocabulário.

export const PATOLOGIAS = [
  // Respiratório / ORL
  'constipacao_comum', 'sindrome_gripal', 'gripe', 'rinite_alergica', 'sinusite', 'congestao_nasal',
  'faringite', 'laringite', 'otite_media', 'bronquite', 'asma', 'dpoc', 'tosse_seca', 'tosse_produtiva',
  // Dor / febre / musculoesquelético
  'dor_ligeira_moderada', 'febre', 'enxaqueca', 'osteoartrose', 'artrite_reumatoide', 'espondilite_anquilosante',
  'lesao_tecidos_moles', 'traumatismo', 'dor_pos_cirurgica', 'osteoporose',
  // Digestivo
  'obstipacao', 'diarreia_aguda', 'diarreia_associada_antibioticos', 'diarreia_rotavirus',
  'alteracao_flora_intestinal', 'azia_refluxo', 'ulcera_peptica', 'helicobacter_pylori', 'dispepsia',
  'nauseas_vomitos', 'hemorroidas', 'flatulencia',
  // Alergia / pele
  'urticaria', 'dermatite', 'eczema', 'acne', 'psoriase', 'micose_cutanea', 'pele_seca', 'queimadura_solar',
  'herpes_labial', 'picada_inseto', 'piolhos', 'envelhecimento_cutaneo', 'hiperpigmentacao', 'queda_cabelo',
  // Ginecológico / urológico
  'candidiase_vaginal', 'alteracao_flora_vaginal', 'secura_vaginal', 'cistite', 'hiperplasia_benigna_prostata',
  'retencao_urinaria', 'disfuncao_eretil', 'menopausa', 'contracecao',
  // Olhos
  'conjuntivite', 'olho_seco', 'irritacao_ocular',
  // Crónicas (MSRM)
  'diabetes_tipo_2', 'diabetes_tipo_1', 'hipertensao', 'dislipidemia', 'insuficiencia_cardiaca_cronica',
  'doenca_renal_cronica', 'fibrilhacao_auricular', 'prevencao_trombose', 'doenca_coronaria', 'hipotiroidismo',
  'depressao', 'ansiedade', 'insonia', 'epilepsia', 'demencia', 'parkinson',
  // Outros
  'carencia_vitaminica', 'carencia_ferro', 'cansaco_fadiga', 'stress', 'excesso_peso', 'tabagismo',
  'infecao_bacteriana', 'infecao_fungica', 'infecao_viral', 'dor_garganta', 'aftas', 'higiene_oral', 'cuidado_bebe',
] as const;

export const SINTOMAS = [
  'nariz_entupido', 'corrimento_nasal', 'espirros', 'comichao_nariz', 'tosse', 'tosse_seca', 'expetoracao',
  'dor_garganta', 'rouquidao', 'perda_voz', 'febre', 'arrepios', 'cefaleia', 'dor_muscular', 'dor_articular',
  'dor_dentaria', 'dor_menstrual', 'dor_ouvido', 'lombalgia', 'dor_inflamatoria',
  'diarreia', 'obstipacao', 'azia', 'enfartamento', 'gases', 'nauseas', 'vomitos', 'dor_abdominal',
  'comichao_pele', 'vermelhidao_pele', 'pele_seca', 'manchas_pele', 'rugas',
  'corrimento_vaginal', 'prurido_vaginal', 'ardor_urinar', 'secura_intima', 'sintomas_urinarios',
  'olhos_vermelhos', 'olhos_secos', 'comichao_olhos', 'lacrimejo',
  'insonia', 'ansiedade', 'cansaco', 'falta_concentracao', 'afrontamentos',
] as const;

const PAT_SET = new Set<string>(PATOLOGIAS);
const SIN_SET = new Set<string>(SINTOMAS);

export function normalizarTermo(t: string): string {
  return t
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export const ehPatologiaConhecida = (t: string) => PAT_SET.has(normalizarTermo(t));
export const ehSintomaConhecido = (t: string) => SIN_SET.has(normalizarTermo(t));
