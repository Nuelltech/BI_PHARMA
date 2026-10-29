import { PrismaClient } from '@prisma/client';
import { getPharmacyCatalog, searchCatalog, CatalogItem, normalizeText, termMatches } from './product_catalog';

export interface CampaignAxis {
  nome: string;
  termos: string[];
  quota: number;
}

export interface SeasonAnatomy {
  perfilEpoca: string;
  doresUtente: string[];
  familiasChave: string[];
  estrategiaEscoamento: string;
}

export interface CampaignDefinition {
  id: string;
  titulo: string;
  epoca: string;
  icone: string;
  descricao: string;
  tipoCampanha?: 'EPOCA_CALENDARIO' | 'LIQUIDACAO_STOCK';
  mesesAlvo: number[]; // 1 a 12
  diasEspeciais?: string[];
  termosCategoria: string[];
  eixos?: CampaignAxis[];
  excluir?: string[];
  margemMinimaPct?: number;
  mecanicaSugerida: string;
  descontoSugeridoPct: number;
  contextoEpoca?: SeasonAnatomy;
}

export const ANNUAL_CAMPAIGNS: CampaignDefinition[] = [
  // ==========================================================================
  // JANEIRO
  // ==========================================================================
  {
    id: 'detox_energia_ano_novo',
    titulo: 'Detox Hepático & Recuperação Pós-Festas',
    epoca: 'Janeiro e Fevereiro',
    icone: '🌱',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Cuidado digestivo e hepático pós-festas, alívio de azia/indigestão, controlo de peso e reequilíbrio intestinal.',
    mesesAlvo: [1, 2],
    termosCategoria: ['alcachofra', 'cardo', 'detox', 'drenante', 'digest', 'figado', 'gaviscon', 'nexium control', 'rennie', 'kompensan', 'transilax'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Desconto progressivo de 15% na 2ª unidade',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Resoluções de Ano Novo, recuperação de excessos alimentares de Dezembro e início de planos de controlo de peso.',
      doresUtente: ['Sensação de inchaço e retenção de líquidos', 'Digestão lenta e desconforto hepático', 'Obstipação e fadiga pós-festas'],
      familiasChave: ['Drenantes, Alcachofra & Cardo Mariano', 'Reguladores de Trânsito Intestinal', 'Antiácidos & Digestivos'],
      estrategiaEscoamento: 'Criar protocolo Detox de 30 dias combinando Drenante/Hepático + Regulador Intestinal.',
    },
  },
  {
    id: 'pele_seca_frio',
    titulo: 'Barreira Cutânea, Lábios & Mãos Contra o Frio',
    epoca: 'Dezembro a Março',
    icone: '❄️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Sticks labiais reparadores, bálsamos de nariz/lábios, cremes de mãos e loções emolientes para pele seca e gretada pelo frio.',
    mesesAlvo: [12, 1, 2, 3],
    termosCategoria: ['stick labial', 'reparador labios', 'letibalm', 'labello', 'creme maos', 'dermaprotect', 'ureia', 'cicalfate'],
    eixos: [
      {
        nome: '💋 Lábios, Nariz & Zonas Sensíveis',
        termos: ['stick labial', 'reparador labios', 'letibalm', 'labello', 'batom', 'cicalfate'],
        quota: 6,
      },
      {
        nome: '👐 Cremes de Mãos, Ureia & Hidratação Corpo',
        termos: ['creme maos', 'dermaprotect', 'ureia', 'cerave hidratacao', 'cerave sa', 'locao corpo'],
        quota: 6,
      },
    ],
    excluir: ['solar', 'spf', 'fp50', 'sun', 'uvmune', 'anthelios', 'vaginal', 'oftalm'],
    margemMinimaPct: 25,
    mecanicaSugerida: 'Na compra de Creme Hidratante, Stick Labial a 50%',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Baixas temperaturas e vento causam cieiro, lábios gretados, dermatite das mãos e xerose cutânea.',
      doresUtente: ['Lábios e nariz gretados por constipações/frio', 'Mãos secas e gretadas', 'Pele atópica ou descamativa'],
      familiasChave: ['Sticks Labiais & Reparadores Nasais', 'Cremes de Mãos Concentrados', 'Emolientes Corporais & Cremes Reparadores'],
      estrategiaEscoamento: 'Colocar expositor de sticks labiais e cremes de mãos junto ao terminal Multibanco para compra por impulso.',
    },
  },
  {
    id: 'saude_mental_fadiga_inverno',
    titulo: 'Vitalidade, Energia & Equilíbrio Emocional de Inverno',
    epoca: 'Janeiro e Fevereiro',
    icone: '🧠',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Suporte para o cansaço mental pós-festas (Blue Monday), fadiga de inverno e distúrbios do sono através de magnésio, triptofano e complexos B.',
    mesesAlvo: [1, 2],
    termosCategoria: ['magnesio', '5-htp', 'triptofano', 'valeriana', 'passiflora', 'stress', 'cansaco', 'viterra', 'centrum', 'absorvit', 'sono', 'melatonina'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Compre Magnésio/Vitaminas e leve Melatonina com 20% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Dias curtos, pouca luz solar, regresso ao trabalho e quebra de ânimo pós-festas ("Blue Monday").',
      doresUtente: ['Fadiga matinal e quebra de energia', 'Stress e ansiedade com recomeço profissional', 'Insónia e despertares noturnos'],
      familiasChave: ['Magnésio & Vitaminas B', 'Suplementos de Triptofano & 5-HTP', 'Melatonina & Plantas Relaxantes'],
      estrategiaEscoamento: 'Sugerir magnésio e melatonina aos utentes que queixam de fadiga ao levantar ou dores musculares.',
    },
  },

  // ==========================================================================
  // FEVEREIRO
  // ==========================================================================
  {
    id: 'cancro_apoio_oncologico',
    titulo: 'Apoio ao Utente Oncológico & Cuidado de Peles Frágeis',
    epoca: 'Fevereiro (Efeméride Clínica)',
    icone: '🎗️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Cuidados dermocosméticos reparadores para xerose cutânea, radiodermite e fragilidade decorrente de tratamentos médicos.',
    mesesAlvo: [2],
    diasEspeciais: ['4 de Fevereiro - Dia Mundial do Cancro'],
    termosCategoria: ['cicalfate', 'cicaplast', 'bioderma atoderm', 'pele atopica', 'creme emoliente', 'oleo banho', 'xerose', 'boca seca', 'xerostomia'],
    excluir: ['solar', 'spf', 'perfum', 'parfum', 'alcool'],
    margemMinimaPct: 22,
    mecanicaSugerida: 'Preço de Apoio Solidário: 15% de desconto direto em cremes reparadores sem perfume',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Sensibilização mundial para o cancro e suporte aos utentes em quimioterapia ou radioterapia.',
      doresUtente: ['Secura cutânea extrema e descamação', 'Sensibilidade intensa e ardor na pele', 'Mucosa oral ressequida'],
      familiasChave: ['Cremes Cicatrizantes & Reparadores de Barreira', 'Óleos de Banho Syndet sem Sabão', 'Sprays para Boca Seca'],
      estrategiaEscoamento: 'Aconselhamento humanizado no balcão a familiares ou utentes com medicação hospitalar/oncológica.',
    },
  },
  {
    id: 'namorados_saude_sexual',
    titulo: 'Dia dos Namorados: Bem-Estar a Dois & Saúde Sexual',
    epoca: 'Fevereiro (Época Comercial)',
    icone: '❤️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Preservativos, lubrificantes de conforto, óleos de massagem e fragrâncias para o Dia de São Valentim.',
    mesesAlvo: [2],
    diasEspeciais: ['14 de Fevereiro - Dia de São Valentim'],
    termosCategoria: ['preservativo', 'durex', 'control', 'lubrificante', 'massage', 'eau toilette', 'perfum', 'estimulante'],
    excluir: ['vaginal infeccao', 'fungo', 'micose'],
    margemMinimaPct: 25,
    mecanicaSugerida: 'Pack São Valentim: Compre Preservativos e leve Lubrificante com 30%',
    descontoSugeridoPct: 20,
    contextoEpoca: {
      perfilEpoca: 'Comemoração do amor e bem-estar íntimo; grande procura de presentes e cuidados para a vida de casal.',
      doresUtente: ['Procura de momentos de cumplicidade', 'Conforto nas relações íntimas', 'Presentes discretos e acessíveis'],
      familiasChave: ['Preservativos Especiais (Sensação/XL/Textura)', 'Géis Lubrificantes & Massagem', 'Perfumaria de Bolso'],
      estrategiaEscoamento: 'Expositor temático e discreto no balcão com packs de preservativo + gel lubrificante.',
    },
  },
  {
    id: 'carnaval_festas_primeiros_socorros',
    titulo: 'Carnaval & Festas: Primeiros Socorros, Pés & Alívio das Noites',
    epoca: 'Fevereiro (Festas Populares)',
    icone: '🎭',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Pensos para bolhas nos pés pelo calçado de festa, alívio gástrico, anti-ressaca e hidratação.',
    mesesAlvo: [2],
    termosCategoria: ['compeed', 'calos', 'bolhas', 'antiacido', 'gaviscon', 'ressaca', 'guronsan', 'magnesio', 'pensos', 'toalhetes'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Kit Festa & Conforto: Leve 2 itens de pés/alívio e poupe 15%',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Desfiles de Carnaval, danças e noites prolongadas com impacto físico e digestivo.',
      doresUtente: ['Bolhas dolorosas e calos nos pés', 'Azia, má digestão e cansaço de festa', 'Pequenos cortes ou feridas'],
      familiasChave: ['Pensos Hidrocolóides para Bolhas (Compeed)', 'Antiácidos & Efervescentes de Energia', 'Pensos Rápidos'],
      estrategiaEscoamento: 'Posicionar Compeed e Guronsan na zona de impulso de pagamento.',
    },
  },

  // ==========================================================================
  // MARÇO
  // ==========================================================================
  {
    id: 'dia_mulher_dermocosmetica',
    titulo: 'Dia Internacional da Mulher & Dermocosmética Premium',
    epoca: 'Março (Efeméride & Beleza)',
    icone: '🌸',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Séruns anti-idade, ácido hialurónico, contorno de olhos e rituais de dermocosmética em homenagem à mulher.',
    mesesAlvo: [3],
    diasEspeciais: ['8 de Março - Dia Internacional da Mulher'],
    termosCategoria: ['serum', 'anti-idade', 'retinol', 'acido hialuronico', 'creme dia', 'creme noite', 'contorno olhos', 'coffret', 'colagenio'],
    excluir: ['solar', 'spf', 'antimosquitos'],
    margemMinimaPct: 25,
    mecanicaSugerida: 'Especial Mulher: 20% de desconto em Cuidados de Rosto & Séruns Selecionados',
    descontoSugeridoPct: 20,
    contextoEpoca: {
      perfilEpoca: 'Homenagem e celebração feminina; compras para si própria ou prendas entre amigas e familiares.',
      doresUtente: ['Luminosidade do rosto e prevenção de rugas', 'Cansaço no contorno dos olhos', 'Rotina de autocuidado'],
      familiasChave: ['Séruns de Vitamina C & Ácido Hialurónico', 'Cremes Antienvelhecimento', 'Contorno de Olhos'],
      estrategiaEscoamento: 'Oferecer amostras no balcão e promover marcas com margem comercial superior a 40%.',
    },
  },
  {
    id: 'dia_do_pai_cuidados',
    titulo: 'Dia do Pai: Cuidados Masculinos, Barbear & Vitalidade',
    epoca: 'Março (Época Comercial)',
    icone: '👔',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Presentes masculinos, kits de barbear, pós-barba calmante, desodorizantes e perfumes para celebrar os pais.',
    mesesAlvo: [3],
    diasEspeciais: ['19 de Março - Dia do Pai'],
    termosCategoria: ['eau toilette', 'barbear', 'after shave', 'homem', 'men', 'espuma barbear', 'saw palmetto', 'prostata', 'complexo vitaminico'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Presente Dia do Pai: Compre Perfume/After-Shave com 15% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Procura de presentes úteis e de qualidade pelos filhos e parceiros para o Dia do Pai.',
      doresUtente: ['Dificuldade em escolher presentes masculinos úteis', 'Irritação da pele pelo barbear', 'Manutenção da energia no dia a dia'],
      familiasChave: ['Perfumaria Masculina & Eau de Toilette', 'Bálsamos Pós-Barbear & Higiene Homem', 'Multivitamínicos Masculinos'],
      estrategiaEscoamento: 'Criar mesa de presentes "Para o Melhor Pai" com embalagens de oferta prontas no balcão.',
    },
  },
  {
    id: 'saude_oral_higiene',
    titulo: 'Mês da Saúde Oral: Gengivas Saudáveis & Branqueamento',
    epoca: 'Março (Saúde & Prevenção)',
    icone: '🦷',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Prevenção de cáries, colutórios sem álcool, pastas branqueadoras, escovas elétricas e fio dentário.',
    mesesAlvo: [3],
    diasEspeciais: ['20 de Março - Dia Mundial da Saúde Oral'],
    termosCategoria: ['dentifrico', 'pasta dentes', 'escova dentes', 'colutorio', 'elixir', 'fio dentario', 'gengiv', 'branquead', 'sensibilidade'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Leve 2 Artigos de Saúde Oral e receba 25% na 2ª unidade',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Consciencialização para a higiene oral, sensibilidade dentária e saúde periodontal.',
      doresUtente: ['Sangramento gengival e sensibilidade ao frio/quente', 'Prevenção de cáries na família', 'Procura de sorriso mais branco'],
      familiasChave: ['Pastas Dentífricas Especializadas (Gengivas/Sensibilidade)', 'Elixires Bucais Antissépticos', 'Escovas & Fio Dentário'],
      estrategiaEscoamento: 'Recomendar elixir gengival e escova suave a quem compra medicação anti-inflamatória oral.',
    },
  },
  {
    id: 'primavera_alergias',
    titulo: 'Especial Primavera: Alergias, Olhos & Respiração',
    epoca: 'Março a Maio',
    icone: '🌸',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Soro fisiológico, sprays nasais de água do mar, gotas oculares lubrificantes e cuidados anti-alérgicos de venda livre.',
    mesesAlvo: [3, 4, 5],
    termosCategoria: ['soro', 'agua do mar', 'nasimer', 'nasal', 'ocular', 'gotas', 'colirio', 'alerg', 'cetirizina', 'loratadina'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Leve Kit Spray Nasal + Gotas Oculares com 15% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Polinização primaveril com forte incidência de rinite alérgica, conjuntivite, prurido ocular e congestão nasal.',
      doresUtente: ['Espirros, comichão nasal e rinite', 'Olhos vermelhos, secos ou lacrimejantes', 'Necessidade de higiene nasal diária'],
      familiasChave: ['Água do Mar Hiper/Isotónica & Soro', 'Colírios Hidratantes & Gotas Oculares', 'Anti-histamínicos MNSRM'],
      estrategiaEscoamento: 'Em cada dispensa de anti-histamínico oral (receita ou MNSRM), associar lavagem nasal com água do mar ou lágrima artificial.',
    },
  },

  // ==========================================================================
  // ABRIL
  // ==========================================================================
  {
    id: 'dia_mundial_saude_rastreios',
    titulo: 'Dia Mundial da Saúde: Prevenção & Rastreios Cardiovasculares',
    epoca: 'Abril (Efeméride Clínica)',
    icone: '🩺',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Tensiómetros clínicos, medidores de glicemia, tiras de teste e suplementação de ómega-3 para a saúde do coração.',
    mesesAlvo: [4],
    diasEspeciais: ['7 de Abril - Dia Mundial da Saúde'],
    termosCategoria: ['tensiometro', 'medidor tensao', 'tiras glicemia', 'agulhas', 'omega 3', 'colesterol', 'coenzima q10', 'suplemento coracao'],
    margemMinimaPct: 22,
    mecanicaSugerida: 'Na compra de um Tensiómetro Omron, oferta de medição e guia de controlo de tensão',
    descontoSugeridoPct: 10,
    contextoEpoca: {
      perfilEpoca: 'Incentivo mundial aos check-ups de saúde, medição da pressão arterial e despiste precoce de doenças metabólicas.',
      doresUtente: ['Controlo da tensão arterial em casa', 'Monitorização da glicemia capilar', 'Suporte à circulação e colesterol'],
      familiasChave: ['Tensiómetros de Braço Digitais', 'Aparelhos & Tiras de Glicemia', 'Ómega-3 & Cardioprotetores'],
      estrategiaEscoamento: 'Oferecer rastreio gratuito de tensão no balcão para dinamizar a venda de aparelhos domiciliários.',
    },
  },
  {
    id: 'pascoa_digestao',
    titulo: 'Páscoa em Família: Conforto Gástrico & Digestão',
    epoca: 'Abril (Festas Familiares)',
    icone: '🕊️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Alívio rápido de azia, enfartamento, gases e obstipação decorrentes das refeições tradicionais e doces da Páscoa.',
    mesesAlvo: [4],
    termosCategoria: ['gaviscon', 'rennie', 'kompensan', 'nexium control', 'aero-om', 'transilax', 'dulcolax', 'enzimas digestivas', 'carvao vegetal'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Kit Bem-Estar Gástrico: Leve Antiácido + Digestivo com 15% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Feriados pascais, amêndoas, folares e refeições abundantes que causam refluxo e quebra no trânsito intestinal.',
      doresUtente: ['Azia imediata após refeições doces ou gordurosas', 'Enfartamento e digestão lenta', 'Flatulência e obstipação'],
      familiasChave: ['Alginatos & Antiácidos Rápidos', 'Digestivos & Reguladores Enzimáticos', 'Laxantes Suaves de Venda Livre'],
      estrategiaEscoamento: 'Destacar Gaviscon, Rennie e Transilax junto aos balcões de atendimento na semana da Páscoa.',
    },
  },

  // ==========================================================================
  // MAIO
  // ==========================================================================
  {
    id: 'dia_da_mae_beleza',
    titulo: 'Dia da Mãe: Coffrets Especiais, Séruns & Luxo Dermocosmético',
    epoca: 'Maio (Época Comercial de Topo)',
    icone: '💐',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'A maior época de cosmética de primavera: kits presente, cuidados antienvelhecimento, perfumes e cuidados corporais para as mães.',
    mesesAlvo: [5],
    diasEspeciais: ['1º Domingo de Maio - Dia da Mãe'],
    termosCategoria: ['coffret', 'serum', 'caudalie', 'filorga', 'sesderma', 'lierac', 'avene', 'la roche', 'creme anti-idade', 'contorno olhos', 'perfume'],
    excluir: ['solar', 'spf', 'antimosquitos'],
    margemMinimaPct: 26,
    mecanicaSugerida: 'Especial Dia da Mãe: 20% de desconto em Coffrets & Séruns Premium',
    descontoSugeridoPct: 20,
    contextoEpoca: {
      perfilEpoca: 'Pico comercial das farmácias no primeiro domingo de maio; forte procura de ofertas requintadas com embrulho especial.',
      doresUtente: ['Prendas bonitas e com utilidade real para as mães', 'Garantia de tolerância dermatológica', 'Variedade de valores (15€ a 50€)'],
      familiasChave: ['Coffrets de Tratamento Anti-Idade', 'Séruns Concentrados & Ampolas', 'Águas Perfumadas & Fragrâncias'],
      estrategiaEscoamento: 'Embrulhar kits previamente e posicioná-los na montra principal e ilha de entrada da farmácia.',
    },
  },
  {
    id: 'preparacao_verao_silhueta',
    titulo: 'Preparação de Verão: Drenantes, Celulite & Firmeza Corporal',
    epoca: 'Maio e Junho',
    icone: '👙',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Cuidado remodelador, drenantes para retenção de líquidos, cremes anticelulite e suplementos de controlo de peso.',
    mesesAlvo: [5, 6],
    termosCategoria: ['drenante', 'celulite', 'refirmante', 'estrias', 'somatoline', 'depuralina', 'drenafirm', 'ventre liso', 'queima gorduras'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 26,
    mecanicaSugerida: 'Programa Silhueta: Compre Drenante Oral e leve Creme Firmeza com 25% de desconto',
    descontoSugeridoPct: 20,
    contextoEpoca: {
      perfilEpoca: 'Mudança de vestuário para peças mais leves; início da preparação para o verão e praia.',
      doresUtente: ['Retenção de líquidos nas pernas e abdómen', 'Aspeto "casca de laranja" da celulite', 'Procura de resultados visíveis em 4 semanas'],
      familiasChave: ['Drenantes Líquidos para Diluir em Água', 'Géis & Cremes Anticelulíticos de Ação Rápida', 'Suplementos de Saciedade'],
      estrategiaEscoamento: 'Montar protocolo duplo (cuidado de dentro para fora: drenante bebível + creme refirmante tópico).',
    },
  },
  {
    id: 'cessacao_tabagica',
    titulo: 'Dia Mundial Sem Tabaco: Liberdade & Cessação Tabágica',
    epoca: 'Maio e Junho',
    icone: '🚭',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Substitutos de nicotina (pastilhas, adesivos, sprays bucais) e apoio ao utente na decisão de deixar de fumar.',
    mesesAlvo: [5, 6],
    diasEspeciais: ['31 de Maio - Dia Mundial Sem Tabaco'],
    termosCategoria: ['nicotina', 'nicorette', 'niquitin', 'pastilhas nicotina', 'adesivos nicotina', 'spray bucal nicotina'],
    margemMinimaPct: 22,
    mecanicaSugerida: 'Aconselhamento Clínico Personalizado + 10% de desconto no 1º mês de cessação',
    descontoSugeridoPct: 10,
    contextoEpoca: {
      perfilEpoca: 'Mobilização internacional da OMS para a cessação tabágica e promoção da saúde pulmonar.',
      doresUtente: ['Ânsia de fumar e sintomas de abstinência', 'Preocupação com aumento de peso', 'Necessidade de um plano estruturado'],
      familiasChave: ['Terapia de Substituição de Nicotina (TSN)', 'Sprays Orais de Ação Imediata', 'Adesivos Transdérmicos de 24h'],
      estrategiaEscoamento: 'Abordar utentes com tosse crónica matinal ou que procuram xaropes com oferta de plano antitabágico.',
    },
  },

  // ==========================================================================
  // JUNHO
  // ==========================================================================
  {
    id: 'dia_crianca_puericultura',
    titulo: 'Dia da Criança & Puericultura: Bem-Estar e Saúde Infantil',
    epoca: 'Junho (Efeméride Infantil)',
    icone: '🧸',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Biberons, chupetas, cremes de muda de fralda, fotoproteção pediátrica e suplementos de crescimento e apetite.',
    mesesAlvo: [6],
    diasEspeciais: ['1 de Junho - Dia Mundial da Criança'],
    termosCategoria: ['chupeta', 'biberon', 'fralda', 'toalhete', 'creme muda fralda', 'pasta dentes infantil', 'vitamina infantil', 'xarope crianca', 'soro monodoses'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Especial Criança: Leve 2 artigos de puericultura e o 2º tem 30% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Comemoração do Dia da Criança; pais e avós procuram mimos úteis e cuidados dermatológicos para os pequenos.',
      doresUtente: ['Eritema da fralda e pele atópica infantil', 'Higiene e desenvolvimento dos primeiros dentes', 'Fotoproteção segura para pele frágil'],
      familiasChave: ['Puericultura Ligeira (Chupetas & Acessórios)', 'Cremes Reparadores de Fralda (Zinco)', 'Protetores Pediátricos Minerais'],
      estrategiaEscoamento: 'Colocar expositor colorido na zona de atendimento com oferta de balões ou pequenos brindes infantis.',
    },
  },
  {
    id: 'santos_populares_cidade',
    titulo: 'Santos Populares & Festas de Rua: Pés, Ressaca & Primeiros Socorros',
    epoca: 'Junho (Festas Tradicionais)',
    icone: '🎉',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Pensos hidrocolóides para bolhas provocadas pelas marchas e calçado de verão, digestivos e alívio de fadiga.',
    mesesAlvo: [6],
    termosCategoria: ['compeed', 'calos', 'bolhas', 'guronsan', 'antiacido', 'gaviscon', 'pensos rapidos', 'desinfetante', 'magnesio'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Kit Noites de Santos: Pensos Bolhas + Digestivo com 15% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Festas de Santo António, São João e São Pedro; arraiais, marchas populares e longas caminhadas na rua.',
      doresUtente: ['Bolhas dolorosas causadas por sapatos ou sandálias', 'Enfartamento com sardinhas e comida de rua', 'Exaustão pós-festa'],
      familiasChave: ['Pensos de Bolhas para Calcanhares e Dedos', 'Efervescentes Revitalizantes & Antiácidos', 'Desinfetantes e Pensos'],
      estrategiaEscoamento: 'Colocar os pensos Compeed e protetores gástricos em destaque na zona dos pagamentos.',
    },
  },
  {
    id: 'verao_solar',
    titulo: 'Verão Seguro: Fotoproteção SPF50+, Férias & Ar Livre',
    epoca: 'Maio a Agosto',
    icone: '☀️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Protetores solares SPF 50+, pós-solar calmante, repelentes de insetos, kits de viagem e hidratação de verão.',
    mesesAlvo: [5, 6, 7, 8],
    termosCategoria: ['solar', 'spf', 'fp50', 'sun', 'anthelios', 'uvmune', 'pos-solar', 'repelente', 'antimosquitos', 'citronela', 'kit viagem'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Na compra de Protetor Rosto, Leve 2º Cuidado de Verão com -25%',
    descontoSugeridoPct: 20,
    contextoEpoca: {
      perfilEpoca: 'Época balnear, férias em família e atividades ao ar livre; urgência máxima em escoar todo o stock solar antes de Setembro.',
      doresUtente: ['Proteção UV de rosto e corpo', 'Picadas de insetos/mosquitos', 'Farmácia de viagem e queimaduras solares'],
      familiasChave: ['Fotoproteção SPF30/50+', 'Repelentes & Pós-Picada', 'Kits de Viagem & Hidratação Pós-Solar'],
      estrategiaEscoamento: 'Escoar prioritariamente todos os solares para evitar que fiquem empatados como Monos no Outono/Inverno.',
    },
  },

  // ==========================================================================
  // JULHO
  // ==========================================================================
  {
    id: 'farmacia_viagem_ferias',
    titulo: 'Farmácia de Viagem: O Essencial para Férias Sem Sobressaltos',
    epoca: 'Julho e Agosto',
    icone: '✈️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Diarreia do viajante, enjoos de transporte, repelentes tropicais, pós-picada, compressas e desinfetantes de bolso.',
    mesesAlvo: [7, 8],
    termosCategoria: ['diarreia', 'ultralevure', 'floratil', 'sais hidratacao', 'repelente', 'pulseira mosquitos', 'kit viagem', 'enjoo', 'vomistop', 'pensos'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Kit Férias Tranquilas: Na compra de 3 artigos de viagem receba bolsa de transporte grátis',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Saída para férias fora de casa; necessidade de prevenir imprevistos de saúde em viagens nacionais ou estrangeiras.',
      doresUtente: ['Enjoos de carro, barco ou avião', 'Desconforto intestinal e desidratação', 'Picadas de mosquitos em zonas húmidas'],
      familiasChave: ['Probióticos & Sais de Reidratação Oral', 'Repelentes de Insetos de Alta Eficácia', 'Antieméticos & Pensos Rápidos'],
      estrategiaEscoamento: 'Entregar checklist impressa ao utente com os 6 itens essenciais de qualquer mala de viagem.',
    },
  },
  {
    id: 'pernas_cansadas_circulacao',
    titulo: 'Onda de Calor: Pernas Cansadas & Circulação Venosa',
    epoca: 'Junho a Agosto',
    icone: '🦵',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Suporte venotrópico oral, géis de efeito frio para alívio imediato e meias de descanso para pernas pesadas pelo calor.',
    mesesAlvo: [6, 7, 8],
    termosCategoria: ['venotropico', 'castanha da india', 'pernas cansadas', 'gel frio', 'gel pernas', 'meias descanso', 'circulacao'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Duo Leveza: Compre Venotrópico Oral e leve Gel Efeito Frio com 30% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Temperaturas elevadas provocam vasodilatação, pernas inchadas, sensação de peso e tornozelos doridos.',
      doresUtente: ['Inchaço ao final do dia em quem trabalha em pé', 'Sensação de peso e formigueiro nas pernas', 'Desconforto venoso'],
      familiasChave: ['Flavonóides & Venotrópicos Orais', 'Géis Efeito Gelo de Aplicação Tópica', 'Meias de Compressão Elástica Suave'],
      estrategiaEscoamento: 'Sugerir o gel refrescante a todas as pessoas que aviam medicamentos venotrópicos ou anticoagulantes.',
    },
  },
  {
    id: 'cistite_infeccoes_verao',
    titulo: 'Verão & Conforto Íntimo: Prevenção de Cistites e Desconforto',
    epoca: 'Junho a Agosto',
    icone: '🌊',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Suplementação de arando vermelho, D-manose, probióticos íntimos e higiene suave contra infeções urinárias de praia/piscina.',
    mesesAlvo: [6, 7, 8],
    termosCategoria: ['arando', 'd-manose', 'cistite', 'infeccao urinaria', 'probiotico intimo', 'gel intimo', 'saforelle'],
    margemMinimaPct: 25,
    mecanicaSugerida: 'Prevenção Íntima: Compre Arando/D-Manose e receba Gel de Higiene Íntima a metade do preço',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Fatos de banho molhados e praias aumentam drasticamente a proliferação bacteriana e episódios de cistite aguda.',
      doresUtente: ['Ardor e dor aguda ao urinar', 'Vontade frequente e desconforto pélvico', 'Recidivas sucessivas nas férias'],
      familiasChave: ['Extrato de Arando Vermelho & D-Manose Concentrada', 'Probióticos com Estirpes Lácteas Específicas', 'Géis de Higiene sem Sabão'],
      estrategiaEscoamento: 'Protocolar recomendação de arando a mulheres jovens e adultas que compram antibióticos urinários (ex: Fosfomicina).',
    },
  },

  // ==========================================================================
  // AGOSTO
  // ==========================================================================
  {
    id: 'solar_pos_praia_queimaduras',
    titulo: 'Pico de Verão: Queimaduras Solares, Hidratação & Pós-Praia',
    epoca: 'Julho e Agosto',
    icone: '🏖️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Biafine, bálsamos pós-solar reparadores, pantenol, água termal e fotoprotetores de emergência.',
    mesesAlvo: [7, 8],
    termosCategoria: ['biafine', 'cicalfate', 'pantenol', 'pos-solar', 'aloe vera', 'hidratante corpo', 'queimadura', 'solar spf50'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Alívio Imediato: Compre Creme Queimaduras e leve Água Termal com 20% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Dias mais quentes do ano com índice UV extremo (9-11); utentes procuram soluções rápidas para eritema solar.',
      doresUtente: ['Pele a arder por excesso de sol', 'Descamação precoce e vermelhidão', 'Desidratação cutânea pós-praia'],
      familiasChave: ['Cremes para Queimaduras Cutâneas (Biafine/Pantenol)', 'Sprays de Água Termal Calmante', 'Loções Pós-Solares de Grande Formato'],
      estrategiaEscoamento: 'Colocar o expositor de alívio solar junto ao balcão de atendimento rápido de verão.',
    },
  },
  {
    id: 'micoses_praia_piscina',
    titulo: 'Piscina & Praia: Prevenção de Micoses e Pé de Atleta',
    epoca: 'Julho a Setembro',
    icone: '👣',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Antifúngicos tópicos de venda livre, pós secantes cutâneos e sprays de higiene para os pés.',
    mesesAlvo: [7, 8, 9],
    termosCategoria: ['micose', 'pe atleta', 'antifungico', 'po cutaneo', 'canesten', 'daktarin', 'spray pes', 'desodorizante pes'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Cuidado Completo dos Pés: Compre Creme Antifúngico e leve Pó Secante com 20% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Andar descalço em balneários, relvados e piscinas públicas facilita o contágio por fungos e micoses interdigitais.',
      doresUtente: ['Comichão intensa entre os dedos dos pés', 'Maceração cutânea e mau odor pelo suor', 'Unhas amareladas ou espessadas'],
      familiasChave: ['Antifúngicos MNSRM em Creme/Spray', 'Pós Secantes Adsorventes', 'Sprays Protetores de Calçado'],
      estrategiaEscoamento: 'Recomendar o uso concomitante de pó desodorizante em cada compra de creme antifúngico para evitar recontágio.',
    },
  },

  // ==========================================================================
  // SETEMBRO
  // ==========================================================================
  {
    id: 'regresso_aulas_piolhos',
    titulo: 'Regresso às Aulas: Prevenção de Piolhos, Memória & Concentração',
    epoca: 'Setembro',
    icone: '🎒',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Tratamentos e repelentes de piolhos/lêndeas, pentes de dentes finos e suplementos infantis para arranque do ano letivo.',
    mesesAlvo: [9],
    termosCategoria: ['piolhos', 'lendias', 'paranix', 'champo piolhos', 'pente metal', 'memoria', 'concentracao', 'omega 3 crianca', 'suplemento escolar'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 25,
    mecanicaSugerida: 'Kit Regresso Tranquilo: Tratamento de Piolhos + Spray Repelente Preventivo com 20% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Início do ano letivo escolar em setembro; picos maciços de contágio de pediculose e preocupação dos pais com a rotina.',
      doresUtente: ['Prurido no couro cabeludo das crianças', 'Medo de infestações recorrentes na escola', 'Falta de foco e adaptação às aulas'],
      familiasChave: ['Loções e Champôs de Ação Mecânica Anti-Piolhos', 'Sprays Repelentes de Uso Diário', 'Ómega-3 & Multivitamínicos Escolares'],
      estrategiaEscoamento: 'Criar "Kit Regresso Seguro às Aulas" com tratamento + pente fino de metal + repelente.',
    },
  },
  {
    id: 'outono_queda_capilar_regresso',
    titulo: 'Outono: Queda de Cabelo Sazonal & Fortalecimento',
    epoca: 'Setembro a Novembro',
    icone: '🍂',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Suplementos orais antiqueda, ampolas fortalecedoras, champôs antiqueda e cuidados para unhas fragilizadas pós-verão.',
    mesesAlvo: [9, 10, 11],
    termosCategoria: ['champo', 'capilar', 'queda', 'absorvit', 'viterra', 'centrum', 'magnesio', 'energia', 'memoria', 'priorin', 'cystiphane', 'ecophane', 'biotina'],
    excluir: ['solar', 'spf', 'sun'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Tratamento de 3 Meses: Na compra de 2 embalagens de suplemento capilar, o Champô é oferta ou tem 50%',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Eflúvio telógeno outonal acentuado pelos danos solares do verão; queixas generalizadas de cabelo fino e queda na escovagem.',
      doresUtente: ['Cabelos a cair no banho e na almofada', 'Perda de densidade e volume capilar', 'Unhas fracas e quebradiças'],
      familiasChave: ['Suplementos de Cistina, Biotina & Zinco', 'Ampolas Fortalecedoras do Folículo', 'Champôs Técnicos Estimulantes'],
      estrategiaEscoamento: 'Promover planos de 90 dias (tempo biológico de renovação capilar) garantindo maior ticket médio.',
    },
  },
  {
    id: 'dia_mundial_coracao',
    titulo: 'Dia Mundial do Coração & Saúde Vascular',
    epoca: 'Setembro e Outubro',
    icone: '❤️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Controlo do colesterol, suplementos de levedura de arroz vermelho, ómega-3 e vigilância da pressão arterial.',
    mesesAlvo: [9, 10],
    diasEspeciais: ['29 de Setembro - Dia Mundial do Coração'],
    termosCategoria: ['tensiometro', 'omega 3', 'colesterol', 'levedura arroz vermelho', 'arterial', 'alho', 'coenzima q10'],
    margemMinimaPct: 22,
    mecanicaSugerida: 'Coração Saudável: 15% de desconto em Tensiómetros Digitais e Cardioprotetores Orais',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Sensibilização da Federação Mundial do Coração para os fatores de risco cardiovascular e estilo de vida.',
      doresUtente: ['Dificuldade em gerir o colesterol ligeiramente elevado', 'Vigilância da pressão arterial', 'Cansaço cardiovascular'],
      familiasChave: ['Monacolina K / Levedura de Arroz Vermelho', 'Concentrados de Ómega-3 EPA/DHA', 'Monitores de Pressão Arterial'],
      estrategiaEscoamento: 'Identificar utentes com receitas de anti-hipertensores e aconselhar suporte com Coenzima Q10 e Ómega-3.',
    },
  },

  // ==========================================================================
  // OUTUBRO
  // ==========================================================================
  {
    id: 'outubro_rosa_mama',
    titulo: 'Outubro Rosa: Prevenção, Hidratação & Autocuidado da Mulher',
    epoca: 'Outubro (Efeméride Clínica & Solidária)',
    icone: '🎀',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Mês de sensibilização para a saúde mamária; destaque para emolientes corporais, nutrição cutânea e bem-estar feminino.',
    mesesAlvo: [10],
    termosCategoria: ['hidratante corpo', 'cicalfate', 'cicaplast', 'oleo banho', 'suplemento mulher', 'colagenio', 'higiene intima'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Outubro Rosa: 15% de desconto direto em toda a gama de hidratação corporal e reparação',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Mês Rosa de solidariedade e prevenção do cancro da mama; grande impacto mediático e mobilização feminina.',
      doresUtente: ['Cuidado e vigilância da saúde feminina', 'Secura cutânea em mulheres na pré/pós-menopausa', 'Necessidade de rotina de carinho e autocuidado'],
      familiasChave: ['Emolientes Corporais Intensivos', 'Higiene Íntima Fisiológica', 'Suplementos de Colagénio e Antioxidantes'],
      estrategiaEscoamento: 'Decorar a montra com laço rosa e doar ou destacar marcas que apoiam a causa oncológica.',
    },
  },
  {
    id: 'vacinacao_gripe_imunidade',
    titulo: 'Arranque da Vacinação da Gripe & Escudo Imunitário Preventivo',
    epoca: 'Outubro e Novembro',
    icone: '🛡️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Vitamina C, Própolis, Zinco, Equinácea e Geleia Real para preparar o sistema imunitário antes do inverno severo.',
    mesesAlvo: [10, 11],
    termosCategoria: ['vitamina c', 'zinco', 'equinacea', 'propolis', 'geleia real', 'absorvit', 'viterra imunidade', 'aspirador nasal'],
    excluir: ['solar', 'spf'],
    margemMinimaPct: 25,
    mecanicaSugerida: 'Escudo Imunitário: Compre 2 embalagens de suplemento imunitário e receba 20% no total',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Início da campanha nacional de vacinação contra a gripe e primeiras descidas significativas de temperatura.',
      doresUtente: ['Medo de apanhar gripe ou constipações fortes', 'Proteção de seniores e crianças que andam na escola', 'Falta de defesas'],
      familiasChave: ['Combinações de Vitamina C + Zinco + D3', 'Extratos Titulados de Própolis e Equinácea', 'Complexos Imunitários Específicos'],
      estrategiaEscoamento: 'Associar sistematicamente um suplemento imunitário a cada utente que vem à farmácia vacinar-se contra a gripe.',
    },
  },
  {
    id: 'halloween_infantil',
    titulo: 'Halloween: Saúde Oral Infantil & Doces com Moderação',
    epoca: 'Outubro (Comercial / Crianças)',
    icone: '🎃',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Pastas de dentes com flúor adaptadas a crianças, escovas temáticas, guloseimas e pastilhas sem açúcar.',
    mesesAlvo: [10],
    diasEspeciais: ['31 de Outubro - Halloween'],
    termosCategoria: ['dentifrico infantil', 'escova dentes infantil', 'pastilhas sem acucar', 'pensos desenhos'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Doce ou Travessura Saudável: Leve Pasta + Escova Infantil com 20% de desconto',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Festas temáticas de Halloween; consumo excecional de guloseimas pelas crianças.',
      doresUtente: ['Preocupação com cáries após o consumo de doces', 'Incentivo lúdico à escovagem dos dentes'],
      familiasChave: ['Dentífricos Pediátricos com Sabores Frutados', 'Escovas Temáticas Suaves', 'Doces Saudáveis de Farmácia'],
      estrategiaEscoamento: 'Criar canto "Halloween Saudável" no balcão.',
    },
  },

  // ==========================================================================
  // NOVEMBRO
  // ==========================================================================
  {
    id: 'dia_diabetes',
    titulo: 'Mês da Saúde do Diabético & Cuidado Podológico',
    epoca: 'Novembro (Efeméride Clínica)',
    icone: '🩺',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Cuidados especializados com o pé diabético (cremes de ureia 30% e proteção de calosidades), hidratação cutânea intensiva e opções sem açúcar.',
    mesesAlvo: [10, 11],
    diasEspeciais: ['14 de Novembro - Dia Mundial da Diabetes'],
    termosCategoria: ['cr pes', 'creme pes', 'ureia', 'compeed calos', 'epitact', 'dermaprotect', 'cerave sa', 'sem acucar'],
    eixos: [
      {
        nome: '🦶 Pé Diabético, Ureia & Calosidades',
        termos: ['cr pes', 'creme pes', 'ureia', 'compeed calos', 'epitact'],
        quota: 6,
      },
      {
        nome: '🧴 Hidratação Cutânea & Opções Sem Açúcar',
        termos: ['dermaprotect', 'cerave sa', 'locao corpo', 'sem acucar'],
        quota: 5,
      },
    ],
    excluir: ['oculos', 'pedra', 'aluminio', 'alumwn', 'solar', 'spf', 'sun', 'vaginal', 'champo'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Desconto direto de 15% em cuidados podológicos e hidratação da pele diabética',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Efeméride clínica de sensibilização para o controlo glicémico e prevenção de úlceras e fissuras no pé diabético.',
      doresUtente: ['Secura extrema nos pés e calcanhares', 'Calosidades e atrito no calçado', 'Hidratação diária da pele frágil do diabético'],
      familiasChave: ['Cremes de Pés & Ureia', 'Pensos Protetores & Podologia', 'Loções Hidratantes de Grande Formato'],
      estrategiaEscoamento: 'Abordar todos os utentes que aviam receitas de Metformina, Insulinas ou Antidiabéticos Orais com recomendação podológica.',
    },
  },
  {
    id: 'novembro_azul_homem',
    titulo: 'Novembro Azul: Saúde Masculina & Prevenção Prostática',
    epoca: 'Novembro (Saúde do Homem)',
    icone: '💙',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Sensibilização para a saúde prostática, vitalidade masculina e rastreios de rotina nos homens a partir dos 45 anos.',
    mesesAlvo: [11],
    termosCategoria: ['prostata', 'saw palmetto', 'suplemento homem', 'multivitaminico masculino', 'tensiometro'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Homem Cuidadoso: 15% de desconto em Suplementos Prostáticos e Vitalidade',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Movimento Movember / Novembro Azul para prevenção do cancro da próstata e quebra do tabu da saúde masculina.',
      doresUtente: ['Dificuldade ou micção frequente noturna', 'Sensação de perda de energia', 'Prevenção de complicações prostáticas'],
      familiasChave: ['Extratos Padronizados de Saw Palmetto / Serenoa Repens', 'Fitoesteróis & Zinco', 'Multivitamínicos para Homens 50+'],
      estrategiaEscoamento: 'Disponibilizar folhetos informativos discretos e expor suplementos de próstata na secção sénior.',
    },
  },
  {
    id: 'black_friday_oportunidade',
    titulo: 'Black Friday: Saldos de Conveniência & Escoamento de Monos',
    epoca: 'Novembro (Última Semana)',
    icone: '🏷️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Descontos agressivos em produtos de dermocosmética premium, escovas elétricas e artigos com validade até 6 meses antes das compras de Natal.',
    mesesAlvo: [11],
    termosCategoria: ['dermocosmetica', 'escova eletrica', 'serum', 'anti-idade', 'coffret', 'kit oferta', 'creme rosto'],
    margemMinimaPct: 22,
    mecanicaSugerida: 'Black Friday na Farmácia: Até 30% de desconto em marcas de dermocosmética selecionadas',
    descontoSugeridoPct: 25,
    contextoEpoca: {
      perfilEpoca: 'Maior semana de compras e procura de descontos do ano; os utentes antecipam compras natalícias.',
      doresUtente: ['Procura de oportunidades reais de poupança', 'Compra antecipada de presentes de Natal sem filas'],
      familiasChave: ['Marcas de Dermocosmética com Margem Elevada', 'Escovas de Dentes Elétricas & Recargas', 'Coffrets de Beleza'],
      estrategiaEscoamento: 'Aproveitar a data para escoar monos parados e produtos com prazo de validade inferior a 6 meses.',
    },
  },

  // ==========================================================================
  // DEZEMBRO
  // ==========================================================================
  {
    id: 'inverno_natal_coffrets',
    titulo: 'Especial Natal, Ofertas & Época Festiva',
    epoca: 'Dezembro / Festas',
    icone: '🎄',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Presentes de Natal (perfumaria, Eau de Toilette e kits de oferta), cuidados de rosto/mãos e essenciais para os excessos das festas.',
    mesesAlvo: [11, 12],
    termosCategoria: ['coffret', 'perfum', 'eau toilette', 'kit manicure', 'kit viagem', 'gaviscon', 'nexium', 'rennie', 'kompensan', 'aero-om', 'transilax', 'creme maos', 'serum hidrat'],
    eixos: [
      {
        nome: '🎁 Presentes, Perfumaria & Kits Oferta',
        termos: ['eau de toilette', 'eau toilette', 'eau parfum', 'perfum', 'parfum', 'coffret', 'kit manicure', 'kit viagem'],
        quota: 9,
      },
      {
        nome: '🍽️ Ceias, Digestão & Alívio Gástrico',
        termos: ['gaviscon', 'nexium control', 'rennie', 'kompensan', 'aero-om', 'transilax', 'dulcolax', 'antiacido', 'digest'],
        quota: 6,
      },
      {
        nome: '✨ Dermocosmética, Rosto & Mãos',
        termos: ['creme maos', 'serum hidrat', 'creme hidrat', 'antifadiga', 'cicalfate'],
        quota: 4,
      },
    ],
    excluir: ['solar', 'spf', 'fp50', 'sun', 'uvmune', 'anthelios', 'citronela', 'antimosquitos', 'wipes', 'perolas', 'test', 'pulseira', 'vaginal'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Leve 2, o 2º artigo tem 30% de desconto (Presentes & Bem-Estar Festivo)',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Época de compras de presentes familiares, convívios e refeições pesadas de Natal e Passagem de Ano.',
      doresUtente: ['Procura de presentes úteis e acessíveis (10€-35€)', 'Azia, refluxo, enfartamento e trânsito intestinal lento', 'Pele das mãos e rosto ressequida pelo frio'],
      familiasChave: ['Perfumaria & Eau de Toilette', 'Coffrets & Kits Presente', 'Antiácidos, Alginatos & Digestivos (MNSRM/VL)', 'Cremes de Mãos & Séruns de Rosto'],
      estrategiaEscoamento: 'Usar Perfumes/Kits com stock ≥ 3 un nas Redes Sociais e Montra; colocar Restos de Gaveta (1-2 un) em cesto de presentes no balcão.',
    },
  },
  {
    id: 'ceias_festas_digestao',
    titulo: 'Ceias de Natal e Passagem de Ano: Digestão & Bem-Estar Gástrico',
    epoca: 'Dezembro e Janeiro',
    icone: '🍽️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Protetores de estômago, antiácidos rápidos, enzimas digestivas e suporte hepático para os excessos das ceias.',
    mesesAlvo: [12, 1],
    termosCategoria: ['gaviscon', 'rennie', 'kompensan', 'nexium', 'aero-om', 'transilax', 'guronsan', 'digest'],
    margemMinimaPct: 24,
    mecanicaSugerida: 'Kit Festas Tranquilas: Compre 2 produtos digestivos e poupe 15%',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Refeições volumosas, fritos natalícios, doces e álcool causam picos de azia, refluxo gastroesofágico e enfartamento.',
      doresUtente: ['Queimadura no peito e regurgitação ácida', 'Digestão pesada e insónia pós-ceia', 'Ressaca e cansaço no dia seguinte'],
      familiasChave: ['Antiácidos & Alginatos Barreira', 'Inibidores de Bomba de Protões OTC', 'Digestivos & Estimulantes Hepáticos'],
      estrategiaEscoamento: 'Expositor temático de balcão ao lado da caixa registadora.',
    },
  },
  {
    id: 'imunidade_inverno',
    titulo: 'Reforço Imunitário, Gripes & Defesas de Inverno',
    epoca: 'Novembro a Fevereiro',
    icone: '🛡️',
    tipoCampanha: 'EPOCA_CALENDARIO',
    descricao: 'Suplementos de imunidade (Vitamina C, Geleia Real), pastilhas de garganta e descongestão nasal para o tempo frio.',
    mesesAlvo: [11, 12, 1, 2],
    termosCategoria: [
      'vitamina c', 'zinco', 'imun', 'propolis', 'geleia real', 'equinacea',
      'strepsils', 'strepfen', 'nasitrim', 'nasimer', 'vibrocil', 'antigrip',
      'gripp', 'griponal', 'ilvico', 'tosse', 'bisolvon', 'mucosolvan', 'fluimucil'
    ],
    eixos: [
      {
        nome: '🛡️ Imunidade, Vitaminas & Energia',
        termos: ['imun', 'vitamina c', 'geleia real', 'propolis', 'equinacea', 'absorvit'],
        quota: 6,
      },
      {
        nome: '🧣 Gripe, Garganta, Tosse & Vias Respiratórias',
        termos: [
          'antigrip', 'gripp', 'griponal', 'ilvico', 'tosse', 'strepsils', 'strepfen',
          'nasitrim', 'nasimer', 'vibrocil', 'snup', 'neo-sinefrina', 'fluimucil', 'bisolvon', 'mucosolvan', 'vicks'
        ],
        quota: 9,
      },
    ],
    excluir: ['solar', 'spf', 'sun', 'antimosquitos', 'citronela'],
    margemMinimaPct: 25,
    mecanicaSugerida: 'Compre 2 embalagens e poupe 20% no total',
    descontoSugeridoPct: 10,
    contextoEpoca: {
      perfilEpoca: 'Pico sazonal de infeções respiratórias, constipações, dor de garganta e fadiga de inverno.',
      doresUtente: ['Dor de garganta e rouquidão', 'Congestão nasal e tosse', 'Prevenção de gripes em crianças, ativos e seniores'],
      familiasChave: ['Vitamina C, Zinco, Própolis & Geleia Real', 'Pastilhas Bucais & Anti-inflamatórios de Garganta', 'Descongestionantes & Água do Mar'],
      estrategiaEscoamento: 'Associar sistematicamente um suplemento de imunidade ou água do mar a cada receita de Antibiótico ou compra de Antigripal.',
    },
  },
];

export interface SafeDiscountSimulation {
  podeDesconto: boolean;
  descontoPct: number;
  pvpPromo: number;
  margemFinalPct: number;
  margemFinalEur: number;
}

/**
 * Calcula o desconto comercial seguro para um artigo individual garantindo:
 * 1) PVP Promocional >= Custo * 1.08 (margem de segurança acima do limiar Anti-Dumping de 1.05)
 * 2) Margem final saudável (>= 18%)
 */
export function computeSafeAntiDumpingDiscount(
  custo: number,
  pvp: number | null | undefined,
  desiredDiscountPct = 15
): SafeDiscountSimulation {
  const pvpVal = pvp && pvp > 0 ? pvp : custo > 0 ? custo * 1.45 : 0;
  if (pvpVal <= 0 || custo <= 0 || pvpVal <= custo * 1.15) {
    const mAtual = pvpVal > 0 ? ((pvpVal - custo) / pvpVal) * 100 : 0;
    return {
      podeDesconto: false,
      descontoPct: 0,
      pvpPromo: Number(pvpVal.toFixed(2)),
      margemFinalPct: Number(Math.max(0, mAtual).toFixed(1)),
      margemFinalEur: Number(Math.max(0, pvpVal - custo).toFixed(2)),
    };
  }

  const candidateDiscounts = [desiredDiscountPct, 20, 15, 10, 5].filter(
    (d, idx, arr) => d > 0 && d <= desiredDiscountPct && arr.indexOf(d) === idx
  );
  candidateDiscounts.sort((a, b) => b - a);

  for (const desc of candidateDiscounts) {
    const pvpPromo = Number((pvpVal * (1 - desc / 100)).toFixed(2));
    const margemEur = pvpPromo - custo;
    const margemPct = (margemEur / pvpPromo) * 100;
    if (pvpPromo >= custo * 1.08 && margemPct >= 18) {
      return {
        podeDesconto: true,
        descontoPct: desc,
        pvpPromo,
        margemFinalPct: Number(margemPct.toFixed(1)),
        margemFinalEur: Number(margemEur.toFixed(2)),
      };
    }
  }

  const mAtual = ((pvpVal - custo) / pvpVal) * 100;
  return {
    podeDesconto: false,
    descontoPct: 0,
    pvpPromo: Number(pvpVal.toFixed(2)),
    margemFinalPct: Number(Math.max(0, mAtual).toFixed(1)),
    margemFinalEur: Number(Math.max(0, pvpVal - custo).toFixed(2)),
  };
}

/**
 * Verifica se um artigo (Venda Livre ou MNSRM) encaixa numa campanha sazonal do calendário.
 * Prioriza campanhas do mês atual/próximo, mas também identifica campanhas de outras épocas do ano.
 */
export function matchProductToSeasonalCampaign(
  designacao: string,
  tipoVenda: string,
  margemPct: number | null | undefined,
  mesReferencia?: number
): { campanha: CampaignDefinition; eixoNome: string; ehEpocaAtual: boolean } | null {
  if (tipoVenda === 'MSRM') return null;
  const margem = margemPct ?? 30;
  const norm = normalizeText(designacao);
  const mes = mesReferencia || new Date().getMonth() + 1;
  const proximoMes = mes === 12 ? 1 : mes + 1;

  // Ordenar campanhas: primeiro as que pertencem ao mês atual/próximo
  const sortedCampaigns = [...ANNUAL_CAMPAIGNS].sort((a, b) => {
    const aActive = a.mesesAlvo.includes(mes) || a.mesesAlvo.includes(proximoMes) ? 1 : 0;
    const bActive = b.mesesAlvo.includes(mes) || b.mesesAlvo.includes(proximoMes) ? 1 : 0;
    return bActive - aActive;
  });

  for (const camp of sortedCampaigns) {
    if (margem < (camp.margemMinimaPct ?? 22)) continue;
    if (camp.excluir && camp.excluir.some((ex) => termMatches(norm, ex))) continue;

    const ehEpocaAtual = camp.mesesAlvo.includes(mes) || camp.mesesAlvo.includes(proximoMes);

    if (camp.eixos && camp.eixos.length > 0) {
      for (const eixo of camp.eixos) {
        if (eixo.termos.some((t) => termMatches(norm, t))) {
          return { campanha: camp, eixoNome: eixo.nome, ehEpocaAtual };
        }
      }
    }

    if (camp.termosCategoria.some((t) => termMatches(norm, t))) {
      return { campanha: camp, eixoNome: camp.titulo, ehEpocaAtual };
    }
  }

  return null;
}

export interface CampaignProductItem {
  cnp_codigo: string;
  designacao: string;
  categoria: string;
  eixo_campanha?: string;
  criterio_marketing?: string;
  canais_recomendados?: string;
  tipo_venda: string;
  stock_atual: number;
  custo_unitario: number;
  pvp: number;
  margem_percentagem: number;
  validade: string;
  risco_caducidade: boolean;
  score_prioridade: number;
  motivo_selecao: string;
}

export interface CampaignSuggestionResult {
  campanha: CampaignDefinition;
  produtosSugeridos: CampaignProductItem[];
  totalArtigosDisponiveis: number;
  totalUnidadesStock: number;
  faturacaoPotencialPvp: number;
  capitalImobilizadoCusto: number;
  margemMediaAtualPct: number;
  resumoCriterios?: {
    validadesCriticas: number;
    monosParados: number;
    restosGaveta: number;
    ancorasRotacao: number;
  };
}

function isItemExpiryRisk(item: CatalogItem): boolean {
  if (!item.validade || item.validade === 'Longa') return false;
  if (item.validade <= '2027-06-30') return true;
  const vmm = item.vendasQtd / 12;
  if (vmm === 0) return true;
  const refMs = new Date('2026-10-20T00:00:00Z').getTime();
  const valMs = new Date(item.validade + 'T00:00:00Z').getTime();
  const mesesAteVal = Math.max(0, (valMs - refMs) / (30.4375 * 24 * 60 * 60 * 1000));
  const cob = item.stock / vmm;
  return mesesAteVal < cob;
}

function toCampaignProductItem(item: CatalogItem, eixoNome?: string): CampaignProductItem {
  const validadeStr = item.validade || 'Longa';
  const riscoCad = isItemExpiryRisk(item);
  const ehMono = item.vendasQtd <= 2 && item.stock >= 3;
  const ehRestoGaveta = item.stock <= 2 && item.vendasQtd <= 2;

  let criterioMarketing = '⭐ Âncora da Época';
  let detalhe = `Margem ${item.margem.toFixed(0)}%`;
  let score = item.margem;

  if (riscoCad) {
    criterioMarketing = '🔥 Escoar Validade';
    detalhe = `Validade registada (${validadeStr}) — prioridade máxima de escoamento`;
    score += 55;
  } else if (ehRestoGaveta && item.vendasQtd <= 1) {
    criterioMarketing = '🧺 Resto de Gaveta (1-2 un)';
    detalhe = `Últimas ${item.stock} un. de baixa rotação — limpar referência ao balcão`;
    score += 18;
  } else if (ehMono) {
    criterioMarketing = '🕸️ Escoar Mono';
    detalhe = `Baixa rotação (${item.stock} un. empatadas) — libertar ${(item.stock * item.custo).toFixed(2)}€`;
    score += 35 + Math.min(item.stock, 10);
  } else if (ehRestoGaveta) {
    criterioMarketing = '🧺 Resto de Gaveta (1-2 un)';
    detalhe = `Stock residual (${item.stock} un.) — escoar em atendimento assistido`;
    score += 15;
  } else if (item.stock >= 4) {
    criterioMarketing = item.vendasQtd > 0 && item.stock / Math.max(0.5, item.vendasQtd / 12) > 4 ? '📦 Excesso de Stock' : '⭐ Âncora da Época';
    detalhe = `Profundidade de stock (${item.stock} un.) · Margem ${item.margem.toFixed(0)}%`;
    score += 25 + Math.min(item.stock, 10);
  } else if (item.margem >= 45) {
    detalhe = `Alta rentabilidade (${item.margem.toFixed(0)}%)`;
    score += 25;
  }

  const canaisRecomendados =
    item.stock <= 2
      ? '🏪 Exclusivo Balcão / Cesto Loja (≤ 2 un)'
      : '📡 Todos os Canais (Redes, Ecrãs, App, Balcão)';

  return {
    cnp_codigo: item.cnp,
    designacao: item.designacao,
    categoria: item.categoria,
    eixo_campanha: eixoNome || item.categoria,
    criterio_marketing: criterioMarketing,
    canais_recomendados: canaisRecomendados,
    tipo_venda: item.tipoVenda,
    stock_atual: item.stock,
    custo_unitario: item.custo,
    pvp: item.pvp,
    margem_percentagem: item.margem,
    validade: validadeStr,
    risco_caducidade: riscoCad,
    score_prioridade: score,
    motivo_selecao: `${criterioMarketing} · ${detalhe}`,
  };
}

function summarizeCriteria(items: CampaignProductItem[]) {
  let validadesCriticas = 0;
  let monosParados = 0;
  let restosGaveta = 0;
  let ancorasRotacao = 0;
  for (const p of items) {
    const c = p.criterio_marketing || '';
    if (c.includes('Validade')) validadesCriticas++;
    else if (c.includes('Mono')) monosParados++;
    else if (c.includes('Resto de Gaveta')) restosGaveta++;
    else ancorasRotacao++;
  }
  return { validadesCriticas, monosParados, restosGaveta, ancorasRotacao };
}

/**
 * Obtém as campanhas sugeridas para o mês atual/próximo + Planos Táticos de Liquidação de Stock
 * (Salva-Validades, Destrava Monos e Cesto de Oportunidade Restos de Gaveta).
 */
export async function getSeasonalCampaignSuggestions(

  prisma: PrismaClient,

  farmaciaId: string,

  mesReferencia?: number // 1 a 12 (default mês atual), ou -1 para todas

): Promise<CampaignSuggestionResult[]> {

  const mesAtual = new Date().getMonth() + 1;

  const mes = mesReferencia && mesReferencia > 0 && mesReferencia <= 12 ? mesReferencia : mesAtual;

  const proximoMes = mes === 12 ? 1 : mes + 1;



  const campanhasRelevantes = mesReferencia === -1

    ? ANNUAL_CAMPAIGNS

    : ANNUAL_CAMPAIGNS.filter(

        (c) => c.mesesAlvo.includes(mes) || (mesReferencia ? false : c.mesesAlvo.includes(proximoMes))

      );


  const catalog = await getPharmacyCatalog(prisma, farmaciaId);
  const resultados: CampaignSuggestionResult[] = [];

  // 1. Campanhas Sazonais e Efemérides do Calendário Civil
  for (const camp of campanhasRelevantes) {
    const minMargem = camp.margemMinimaPct ?? 22;
    const seenCnps = new Set<string>();
    const selecionados: CampaignProductItem[] = [];
    let totalElegiveisCount = 0;

    if (camp.eixos && camp.eixos.length > 0) {
      for (const eixo of camp.eixos) {
        const matches = searchCatalog(catalog, {
          grupos_termos: [eixo.termos],
          excluir: camp.excluir,
          apenas_com_stock: true,
          segmento: 'SEM_RECEITA',
        }).filter((it) => it.pvp > it.custo && it.margem >= minMargem && !seenCnps.has(it.cnp));

        totalElegiveisCount += matches.length;
        const convertidos = matches.map((m) => toCampaignProductItem(m, eixo.nome));
        convertidos.sort((a, b) => b.score_prioridade - a.score_prioridade);

        for (const item of convertidos.slice(0, eixo.quota)) {
          seenCnps.add(item.cnp_codigo);
          selecionados.push(item);
        }
      }
    } else {
      const matches = searchCatalog(catalog, {
        grupos_termos: [camp.termosCategoria],
        excluir: camp.excluir,
        apenas_com_stock: true,
        segmento: 'SEM_RECEITA',
      }).filter((it) => it.pvp > it.custo && it.margem >= minMargem);

      totalElegiveisCount = matches.length;
      const convertidos = matches.map((m) => toCampaignProductItem(m));
      convertidos.sort((a, b) => b.score_prioridade - a.score_prioridade);
      selecionados.push(...convertidos.slice(0, 15));
    }

    if (selecionados.length > 0) {
      const totalUnidades = selecionados.reduce((s, i) => s + i.stock_atual, 0);
      const faturacaoPvp = selecionados.reduce((s, i) => s + i.stock_atual * i.pvp, 0);
      const capitalCusto = selecionados.reduce((s, i) => s + i.stock_atual * i.custo_unitario, 0);
      const margemMedia = faturacaoPvp > 0 ? ((faturacaoPvp - capitalCusto) / faturacaoPvp) * 100 : 0;

      resultados.push({
        campanha: camp,
        produtosSugeridos: selecionados,
        totalArtigosDisponiveis: Math.max(totalElegiveisCount, selecionados.length),
        totalUnidadesStock: totalUnidades,
        faturacaoPotencialPvp: faturacaoPvp,
        capitalImobilizadoCusto: capitalCusto,
        margemMediaAtualPct: margemMedia,
        resumoCriterios: summarizeCriteria(selecionados),
      });
    }
  }

  // 2. Planos Táticos Permanentes de Escoamento Direto (Validades, Monos e Restos de Gaveta)
  const stockLivreElegivel = catalog.filter(
    (it) => it.stock > 0 && it.tipoVenda !== 'MSRM' && it.pvp > it.custo * 1.15 && it.margem >= 24
  );

  // 2A. Plano Salva-Validades (Artigos Sem Receita com validade crítica)
  const candidatosValidade = stockLivreElegivel
    .filter((it) => isItemExpiryRisk(it))
    .sort((a, b) => a.validade!.localeCompare(b.validade!) || b.stock * b.custo - a.stock * a.custo);

  if (candidatosValidade.length > 0) {
    const selVal = candidatosValidade.slice(0, 18).map((it) => {
      const p = toCampaignProductItem(it, '🔥 Prioridade Validade Curta');
      p.criterio_marketing = '🔥 Escoar Validade';
      p.motivo_selecao = `🔥 Validade ${it.validade} · Recuperar ${(it.stock * it.custo).toFixed(2)}€ de custo`;
      return p;
    });
    const campVal: CampaignDefinition = {
      id: 'liquidacao_salva_validades',
      titulo: 'Plano Salva-Validades (Escoamento Prioritário)',
      epoca: 'Ação Tática Imediata',
      icone: '🔥',
      tipoCampanha: 'LIQUIDACAO_STOCK',
      descricao:
        'Produtos de Venda Livre e MNSRM com validade registada que não escoarão ao ritmo normal. Ação imediata de desconto seguro Anti-Dumping e destaque de balcão antes que gerem quebra.',
      mesesAlvo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      termosCategoria: [],
      margemMinimaPct: 24,
      mecanicaSugerida: 'Desconto direto -20% (Oportunidade Salva-Validades) + Destaque no Balcão',
      descontoSugeridoPct: 20,
      contextoEpoca: {
        perfilEpoca: 'Plano tático contínuo de prevenção de quebras por caducidade em artigos de Venda Livre.',
        doresUtente: ['Procura de oportunidades e preços reduzidos em cuidados de saúde e higiene habituais'],
        familiasChave: ['Dermocosmética, Suplementos e Higiene em risco de caducidade'],
        estrategiaEscoamento: 'Aplicar etiqueta promocional visível (-15% a -20% acima do custo) e premiar o escoamento no atendimento de balcão.',
      },
    };
    const totalUnidades = selVal.reduce((s, i) => s + i.stock_atual, 0);
    const faturacaoPvp = selVal.reduce((s, i) => s + i.stock_atual * i.pvp, 0);
    const capitalCusto = selVal.reduce((s, i) => s + i.stock_atual * i.custo_unitario, 0);
    resultados.push({
      campanha: campVal,
      produtosSugeridos: selVal,
      totalArtigosDisponiveis: candidatosValidade.length,
      totalUnidadesStock: totalUnidades,
      faturacaoPotencialPvp: faturacaoPvp,
      capitalImobilizadoCusto: capitalCusto,
      margemMediaAtualPct: faturacaoPvp > 0 ? ((faturacaoPvp - capitalCusto) / faturacaoPvp) * 100 : 0,
      resumoCriterios: summarizeCriteria(selVal),
    });
  }

  // 2B. Plano Destrava Capital — Monos de Venda Livre (Stock >= 3 un e baixa/zero rotação)
  const candidatosMonos = stockLivreElegivel
    .filter((it) => it.vendasQtd <= 2 && it.stock >= 3 && it.margem >= 28)
    .sort((a, b) => b.stock * b.custo - a.stock * a.custo);

  if (candidatosMonos.length > 0) {
    const selMonos = candidatosMonos.slice(0, 18).map((it) => {
      const p = toCampaignProductItem(it, '🕸️ Destrava Capital (Mono)');
      p.criterio_marketing = '🕸️ Escoar Mono';
      p.motivo_selecao = `🕸️ Baixa rotação (${it.vendasQtd} vendas/ano) · ${it.stock} un. empatadas (${(it.stock * it.custo).toFixed(2)}€ a custo)`;
      return p;
    });
    const campMonos: CampaignDefinition = {
      id: 'liquidacao_destrava_monos',
      titulo: 'Campanha Destrava Capital (Monos c/ Profundidade de Stock)',
      epoca: 'Liquidação de Capital Parado',
      icone: '🕸️',
      tipoCampanha: 'LIQUIDACAO_STOCK',
      descricao:
        'Artigos de Venda Livre com 3 ou mais unidades paradas ou de rotação muito lenta, mas com margem comercial alta. Ideais para campanhas nas Redes Sociais, Ecrãs e Packs Leve 2 para transformar stock empatado em liquidez.',
      mesesAlvo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      termosCategoria: [],
      margemMinimaPct: 28,
      mecanicaSugerida: 'Campanha Flash -20% ou Leve 2 Pague 1 em referências selecionadas',
      descontoSugeridoPct: 20,
      contextoEpoca: {
        perfilEpoca: 'Transformação de capital imobilizado (Monos com várias unidades) em liquidez de tesouraria.',
        doresUtente: ['Sensibilidade ao preço em produtos de dermocosmética, bem-estar e higiene familiar'],
        familiasChave: ['Artigos de Venda Livre com ≥ 3 unidades paradas e margem ≥ 28%'],
        estrategiaEscoamento: 'Como têm profundidade de stock (≥ 3 un), podem ser divulgados nas Redes Sociais, App e Ecrãs Multimédia sem risco de rutura no 1º cliente.',
      },
    };
    const totalUnidades = selMonos.reduce((s, i) => s + i.stock_atual, 0);
    const faturacaoPvp = selMonos.reduce((s, i) => s + i.stock_atual * i.pvp, 0);
    const capitalCusto = selMonos.reduce((s, i) => s + i.stock_atual * i.custo_unitario, 0);
    resultados.push({
      campanha: campMonos,
      produtosSugeridos: selMonos,
      totalArtigosDisponiveis: candidatosMonos.length,
      totalUnidadesStock: totalUnidades,
      faturacaoPotencialPvp: faturacaoPvp,
      capitalImobilizadoCusto: capitalCusto,
      margemMediaAtualPct: faturacaoPvp > 0 ? ((faturacaoPvp - capitalCusto) / faturacaoPvp) * 100 : 0,
      resumoCriterios: summarizeCriteria(selMonos),
    });
  }

  // 2C. Plano Cesto de Oportunidade — Restos de Gaveta (1 a 2 unidades órfãs de Venda Livre)
  const candidatosRestos = stockLivreElegivel
    .filter((it) => it.stock <= 2 && it.vendasQtd <= 1 && it.margem >= 32 && it.pvp >= 5)
    .sort((a, b) => b.stock * b.custo - a.stock * a.custo);

  if (candidatosRestos.length > 0) {
    const selRestos = candidatosRestos.slice(0, 20).map((it) => {
      const p = toCampaignProductItem(it, '🧺 Últimas Unidades (1-2 un)');
      p.criterio_marketing = '🧺 Resto de Gaveta (1-2 un)';
      p.canais_recomendados = '🏪 Exclusivo Balcão / Cesto Loja (≤ 2 un)';
      p.motivo_selecao = `🧺 Resto de gaveta (${it.stock} un.) · Limpar referência no Cesto de Balcão`;
      return p;
    });
    const campRestos: CampaignDefinition = {
      id: 'liquidacao_cesto_oportunidade',
      titulo: 'Cesto de Oportunidade — Limpeza de Restos de Gaveta (1-2 un)',
      epoca: 'Exclusivo Loja Física & Balcão',
      icone: '🧺',
      tipoCampanha: 'LIQUIDACAO_STOCK',
      descricao:
        'Artigos de Venda Livre com apenas 1 ou 2 unidades órfãs sem rotação que ocupam espaço de gaveta/prateleira. Não devem ir para Redes Sociais (esgotam logo), mas saem rapidamente num Cesto de Últimas Unidades no balcão!',
      mesesAlvo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      termosCategoria: [],
      margemMinimaPct: 32,
      mecanicaSugerida: 'Expositor "Últimas Unidades -20%" junto à caixa de pagamento (Exclusivo Loja)',
      descontoSugeridoPct: 20,
      contextoEpoca: {
        perfilEpoca: 'Limpeza física de referências órfãs (1-2 unidades) para libertar espaço nas gavetas e lineares.',
        doresUtente: ['Compra por impulso no momento do pagamento ao balcão'],
        familiasChave: ['Cosmética, Higiene, Puericultura e Bem-Estar com 1-2 unidades restantes'],
        estrategiaEscoamento: 'Proibido anunciar no Instagram/SMS por falta de stock; concentrar num expositor físico "Últimas Unidades" ao lado do terminal Multibanco.',
      },
    };
    const totalUnidades = selRestos.reduce((s, i) => s + i.stock_atual, 0);
    const faturacaoPvp = selRestos.reduce((s, i) => s + i.stock_atual * i.pvp, 0);
    const capitalCusto = selRestos.reduce((s, i) => s + i.stock_atual * i.custo_unitario, 0);
    resultados.push({
      campanha: campRestos,
      produtosSugeridos: selRestos,
      totalArtigosDisponiveis: candidatosRestos.length,
      totalUnidadesStock: totalUnidades,
      faturacaoPotencialPvp: faturacaoPvp,
      capitalImobilizadoCusto: capitalCusto,
      margemMediaAtualPct: faturacaoPvp > 0 ? ((faturacaoPvp - capitalCusto) / faturacaoPvp) * 100 : 0,
      resumoCriterios: summarizeCriteria(selRestos),
    });
  }

  return resultados;
}

export interface CrossSellProtocol {
  id: string;
  tituloProtocolo: string;
  icone: string;
  gatilhoDispensa: string;
  locomotivasReais: Array<{
    cnp: string;
    designacao: string;
    tipoVenda: string;
    vendasPeriodo: number;
    vmm: number;
  }>;
  produtosAEscoar: Array<{
    cnp: string;
    designacao: string;
    tipoVenda: string;
    stock: number;
    pvp: number;
    custo: number;
    margemPct: number;
    criterioEscoamento: string;
    descontoSeguroPct: number;
    pvpPromo: number;
  }>;
  scriptBalcao10s: string;
  impactoFinanceiroPotencialEur: number;
}

export interface MarketingStockOverview {
  totalSkusComStock: number;
  valorTotalStockEur: number;
  vendaLivreSkus: number;
  vendaLivreValorEur: number;
  criterios: {
    validadesCriticas: { skus: number; unidades: number; valorCustoEur: number; vendaLivreSkus: number };
    monosCapital: { skus: number; unidades: number; valorCustoEur: number; vendaLivreSkus: number };
    restosGaveta: { skus: number; unidades: number; valorCustoEur: number; vendaLivreSkus: number };
    excessoStock: { skus: number; unidades: number; valorCustoEur: number; vendaLivreSkus: number };
  };
}

/**
 * Gera os protocolos operacionais de Cross-Selling ("Locomotiva de Receita/Balcão -> Produto Parado a Escoar")
 * e a Radiografia de Marketing do Stock da farmácia.
 */
export async function getMarketingAndCrossSellingIntelligence(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<{
  overview: MarketingStockOverview;
  crossSellingPlans: CrossSellProtocol[];
}> {
  const catalog = await getPharmacyCatalog(prisma, farmaciaId);
  const comStock = catalog.filter((i) => i.stock > 0);

  const overview: MarketingStockOverview = {
    totalSkusComStock: comStock.length,
    valorTotalStockEur: Number(comStock.reduce((s, i) => s + i.stock * i.custo, 0).toFixed(2)),
    vendaLivreSkus: comStock.filter((i) => i.tipoVenda !== 'MSRM').length,
    vendaLivreValorEur: Number(
      comStock
        .filter((i) => i.tipoVenda !== 'MSRM')
        .reduce((s, i) => s + i.stock * i.custo, 0)
        .toFixed(2)
    ),
    criterios: {
      validadesCriticas: { skus: 0, unidades: 0, valorCustoEur: 0, vendaLivreSkus: 0 },
      monosCapital: { skus: 0, unidades: 0, valorCustoEur: 0, vendaLivreSkus: 0 },
      restosGaveta: { skus: 0, unidades: 0, valorCustoEur: 0, vendaLivreSkus: 0 },
      excessoStock: { skus: 0, unidades: 0, valorCustoEur: 0, vendaLivreSkus: 0 },
    },
  };

  for (const item of comStock) {
    const valCusto = item.stock * item.custo;
    const isVL = item.tipoVenda !== 'MSRM';
    const vmm = item.vendasQtd / 12;
    const cob = vmm > 0 ? item.stock / vmm : null;
    const riscoVal = isItemExpiryRisk(item);

    if (riscoVal) {
      overview.criterios.validadesCriticas.skus++;
      overview.criterios.validadesCriticas.unidades += item.stock;
      overview.criterios.validadesCriticas.valorCustoEur += valCusto;
      if (isVL) overview.criterios.validadesCriticas.vendaLivreSkus++;
    }
    if (item.vendasQtd <= 2 && item.stock >= 3) {
      overview.criterios.monosCapital.skus++;
      overview.criterios.monosCapital.unidades += item.stock;
      overview.criterios.monosCapital.valorCustoEur += valCusto;
      if (isVL) overview.criterios.monosCapital.vendaLivreSkus++;
    }
    if (item.stock <= 2 && item.vendasQtd <= 1) {
      overview.criterios.restosGaveta.skus++;
      overview.criterios.restosGaveta.unidades += item.stock;
      overview.criterios.restosGaveta.valorCustoEur += valCusto;
      if (isVL) overview.criterios.restosGaveta.vendaLivreSkus++;
    }
    if (cob !== null && cob > 4) {
      overview.criterios.excessoStock.skus++;
      overview.criterios.excessoStock.unidades += item.stock;
      overview.criterios.excessoStock.valorCustoEur += valCusto;
      if (isVL) overview.criterios.excessoStock.vendaLivreSkus++;
    }
  }

  overview.criterios.validadesCriticas.valorCustoEur = Number(overview.criterios.validadesCriticas.valorCustoEur.toFixed(2));
  overview.criterios.monosCapital.valorCustoEur = Number(overview.criterios.monosCapital.valorCustoEur.toFixed(2));
  overview.criterios.restosGaveta.valorCustoEur = Number(overview.criterios.restosGaveta.valorCustoEur.toFixed(2));
  overview.criterios.excessoStock.valorCustoEur = Number(overview.criterios.excessoStock.valorCustoEur.toFixed(2));

  // Definição dos 6 Eixos de Cross-Selling (Locomotivas -> Produtos em Stock a Escoar)
  const crossConfigs = [
    {
      id: 'cross_antibioticos_flora_imunidade',
      tituloProtocolo: 'Receita de Antibiótico → Escoar Probióticos & Imunidade',
      icone: '💊',
      gatilhoDispensa: 'Sempre que o utente avia Amoxicilina, Azitromicina, Ciprofloxacina ou Cefuroxima (MSRM)',
      termosLocomotiva: ['amoxicilina', 'azitromicina', 'ciprofloxacina', 'claritromicina', 'cefuroxima', 'fosfomicina'],
      termosEscoar: ['probiot', 'biogaia', 'ul-250', 'enterogermina', 'atylfor', 'atyflor', 'vitamina c', 'imun', 'geleia real', 'absorvit'],
      excluirEscoar: ['solar', 'spf'],
      pitchTemplate:
        '«Como vai iniciar este antibiótico, é fundamental proteger a flora intestinal e as defesas para evitar diarreia ou quebra imunitária. Temos hoje [PRODUTO] em condição especial de balcão. Posso juntar à sua receita?»',
    },
    {
      id: 'cross_dor_oral_protetor_gastrico_topico',
      tituloProtocolo: 'Analgésicos / Anti-inflamatórios → Escoar Alívio Gástrico & Géis Tópicos',
      icone: '🦴',
      gatilhoDispensa: 'Na dispensa de Ibuprofeno, Diclofenac, Naproxeno, Paracetamol ou Metamizol',
      termosLocomotiva: ['ibuprofeno', 'brufen', 'paracetamol', 'ben-u-ron', 'diclofenac', 'metamizol', 'naproxeno', 'etoricoxib'],
      termosEscoar: ['gaviscon', 'nexium control', 'kompensan', 'rennie', 'voltaren', 'fisiocrem', 'biofreeze', 'reumon', 'dimobil', 'transact'],
      excluirEscoar: ['solar', 'spf'],
      pitchTemplate:
        '«Para proteger o estômago da medicação anti-inflamatória e acelerar o alívio local sem sobrecarregar o organismo, recomendo associar [PRODUTO]. Quer aproveitar?»',
    },
    {
      id: 'cross_cardio_diabetes_podologia_suplementos',
      tituloProtocolo: 'Medicação Crónica (Diabetes & Colesterol) → Escoar Cuidado Podológico & Vitalidade',
      icone: '❤️',
      gatilhoDispensa: 'Na dispensa de Metformina, Insulinas, Estatinas (Atorvastatina/Rosuvastatina) ou Anti-hipertensores',
      termosLocomotiva: ['metformina', 'atorvastatina', 'rosuvastatina', 'sinvastatina', 'ramipril', 'perindopril', 'bisoprolol', 'losartan', 'valsartan'],
      termosEscoar: ['creme pes', 'cr pes', 'ureia', 'compeed', 'dermaprotect', 'magnesio', 'omega', 'coenzima', 'cerave'],
      excluirEscoar: ['oculos', 'pedra', 'aluminio', 'solar'],
      pitchTemplate:
        '«Em quem toma esta medicação de rotina, a hidratação profunda dos pés/pele e a reposição de magnésio ajudam a prevenir fissuras e cãibras musculares. Destacamos hoje [PRODUTO] com excelente relação qualidade-preço.»',
    },
    {
      id: 'cross_gripe_respiratorio_lavagem_garganta',
      tituloProtocolo: 'Antigripais & Xaropes → Escoar Sprays Nasais, Garganta & Lábios',
      icone: '🧣',
      gatilhoDispensa: 'Na procura de Antigripais (Cêgripe, Ilvico, Griponal), Descongestionantes ou Xaropes para a Tosse',
      termosLocomotiva: ['griponal', 'ilvico', 'cegripe', 'fluimucil', 'bisolvon', 'vibrocil', 'nasitrim', 'broncoliber'],
      termosEscoar: ['agua do mar', 'nasimer', 'soro', 'strepsils', 'strepfen', 'stick labial', 'letibalm', 'cicalfate', 'creme maos'],
      excluirEscoar: ['solar', 'spf'],
      pitchTemplate:
        '«Para acelerar a recuperação da constipação, a lavagem nasal e a reparação dos lábios/garganta fazem toda a diferença. Temos [PRODUTO] disponível de imediato no balcão!»',
    },
    {
      id: 'cross_ansiedade_sono_magnesio_relaxamento',
      tituloProtocolo: 'Ansiolíticos & Sono (Receita) → Escoar Magnésio, Complexos B & Sono Natural',
      icone: '🌙',
      gatilhoDispensa: 'Na dispensa de Alprazolam, Lorazepam, Diazepam, Zolpidem, Sertralina ou Escitalopram',
      termosLocomotiva: ['alprazolam', 'lorazepam', 'diazepam', 'zolpidem', 'sertralina', 'escitalopram', 'fluoxetina', 'trazodona'],
      termosEscoar: ['magnesio', 'melatonina', 'valdispert', 'aquilea', 'absorvit', 'neurobion', 'sargenor', 'vitamina b'],
      excluirEscoar: ['solar', 'spf'],
      pitchTemplate:
        '«Para apoiar o sistema nervoso durante o dia e reduzir o cansaço muscular associado ao stress, recomendamos complementar com [PRODUTO].»',
    },
  ];

  const crossSellingPlans: CrossSellProtocol[] = [];

  for (const cfg of crossConfigs) {
    // 1. Encontrar as locomotivas reais mais vendidas na farmácia
    const locomotivasMatches = catalog
      .filter((it) => it.vendasQtd > 0 && cfg.termosLocomotiva.some((t) => termMatches(it.norm, t)))
      .sort((a, b) => b.vendasQtd - a.vendasQtd)
      .slice(0, 4)
      .map((l) => ({
        cnp: l.cnp,
        designacao: l.designacao,
        tipoVenda: l.tipoVenda,
        vendasPeriodo: l.vendasQtd,
        vmm: Number((l.vendasQtd / 12).toFixed(1)),
      }));

    // 2. Encontrar produtos de Venda Livre / MNSRM em stock que precisam de escoamento (Validade, Mono, Resto de Gaveta ou Excesso)
    const candidatosEscoar = searchCatalog(catalog, {
      grupos_termos: [cfg.termosEscoar],
      excluir: cfg.excluirEscoar,
      apenas_com_stock: true,
      segmento: 'SEM_RECEITA',
    })
      .filter((it) => it.pvp > it.custo && it.margem >= 22)
      .map((it) => {
        const riscoVal = isItemExpiryRisk(it);
        const ehMono = it.vendasQtd <= 2 && it.stock >= 3;
        const ehResto = it.stock <= 2 && it.vendasQtd <= 1;
        let criterio = '📦 Excesso de Stock';
        let prio = it.margem + Math.min(it.stock * 3, 25);

        if (riscoVal) {
          criterio = `🔥 Validade (${it.validade})`;
          prio += 60;
        } else if (ehMono && it.stock >= 3) {
          criterio = `🕸️ Mono (${it.stock} un. paradas)`;
          prio += 40;
        } else if (ehResto) {
          criterio = `🧺 Resto de Gaveta (${it.stock} un.)`;
          prio += 30;
        }

        const sim = computeSafeAntiDumpingDiscount(it.custo, it.pvp, riscoVal || ehMono ? 15 : 10);
        return {
          cnp: it.cnp,
          designacao: it.designacao,
          tipoVenda: it.tipoVenda,
          stock: it.stock,
          pvp: it.pvp,
          custo: it.custo,
          margemPct: Number(it.margem.toFixed(1)),
          criterioEscoamento: criterio,
          descontoSeguroPct: sim.descontoPct,
          pvpPromo: sim.pvpPromo,
          prio,
        };
      })
      .sort((a, b) => b.prio - a.prio)
      .slice(0, 5);

    if (candidatosEscoar.length > 0) {
      const topEscoar = candidatosEscoar[0];
      const impactoEur = Number(
        candidatosEscoar.reduce((s, p) => s + p.stock * p.pvpPromo, 0).toFixed(2)
      );
      crossSellingPlans.push({
        id: cfg.id,
        tituloProtocolo: cfg.tituloProtocolo,
        icone: cfg.icone,
        gatilhoDispensa: cfg.gatilhoDispensa,
        locomotivasReais: locomotivasMatches,
        produtosAEscoar: candidatosEscoar,
        scriptBalcao10s: cfg.pitchTemplate.replace('[PRODUTO]', topEscoar.designacao),
        impactoFinanceiroPotencialEur: impactoEur,
      });
    }
  }

  return { overview, crossSellingPlans };
}

export interface FinancialSimulation {
  totalUnidades: number;
  faturacaoOriginalPvp: number;
  custoTotal: number;
  faturacaoComDesconto: number;
  lucroBrutoPrevisto: number;
  margemFinalPct: number;
  descontoAplicadoPct: number;
  cumpreAntiDumping: boolean;
  margemSegurancaAcimaCustoPct: number;
  seloAntiDumpingTexto: string;
}

/**
 * Simula o impacto financeiro da campanha e certifica conformidade Anti-Dumping (Lei 166/2013)
 */
export function calculateCampaignFinancials(
  produtos: CampaignProductItem[],
  descontoPct = 15
): FinancialSimulation {
  const totalUnidades = produtos.reduce((s, p) => s + p.stock_atual, 0);
  const faturacaoOriginalPvp = produtos.reduce((s, p) => s + p.stock_atual * p.pvp, 0);
  const custoTotal = produtos.reduce((s, p) => s + p.stock_atual * p.custo_unitario, 0);

  // Faturação após desconto
  const faturacaoComDesconto = faturacaoOriginalPvp * (1 - descontoPct / 100);
  const lucroBrutoPrevisto = faturacaoComDesconto - custoTotal;
  const margemFinalPct = faturacaoComDesconto > 0 ? (lucroBrutoPrevisto / faturacaoComDesconto) * 100 : 0;

  // Verificação de conformidade legal: Preço com desconto tem de ser > Preço de custo efetivo
  const cumpreAntiDumping = faturacaoComDesconto > custoTotal * 1.05; // Margem mínima de segurança de 5%
  const margemSeguranca = custoTotal > 0 ? ((faturacaoComDesconto - custoTotal) / custoTotal) * 100 : 0;

  return {
    totalUnidades,
    faturacaoOriginalPvp,
    custoTotal,
    faturacaoComDesconto,
    lucroBrutoPrevisto,
    margemFinalPct,
    descontoAplicadoPct: descontoPct,
    cumpreAntiDumping,
    margemSegurancaAcimaCustoPct: margemSeguranca,
    seloAntiDumpingTexto: cumpreAntiDumping
      ? `✅ Anti-Dumping Aprovado (Preço Promocional está +${margemSeguranca.toFixed(1)}% acima do custo de compra)`
      : `⚠️ Alerta de Margem: O desconto proposto aproxima-se do preço de custo. Reduza o desconto.`,
  };
}

export interface OmnichannelMaterials {
  lojaBalcao?: {
    pitchBalcao10s: string;
    posicionamentoRecomendado: string;
    dicaAtendimento: string;
  };
  redesSociais?: {
    tituloPost: string;
    textoLegenda: string;
    hashtags: string;
    formatoSugerido: string;
  };
  ecrasMultimedia?: {
    headline: string;
    bulletPoints: string[];
    chamadaAcao: string;
  };
  appSms?: {
    notificacaoPushTitulo: string;
    notificacaoPushCorpo: string;
    smsTexto160c: string;
  };
}

/**
 * Gera materiais específicos e prontos a copiar para os canais selecionados,
 * respeitando a profundidade de stock:
 * - Redes Sociais, Ecrãs TV e SMS destacam apenas produtos com stock >= 3 un (evitando anunciar restos de 1 un).
 * - Loja / Balcão destaca também os Restos de Gaveta (1-2 un) e Validades Curtas para a equipa escoar primeiro!
 */
export function generateOmnichannelMaterials(
  campanha: CampaignDefinition,
  produtos: CampaignProductItem[],
  canaisSelecionados: string[]
): OmnichannelMaterials {
  const materials: OmnichannelMaterials = {};

  // Separar produtos com stock profundo (>= 3 un) para canais digitais vs. restos de gaveta (1-2 un) para balcão
  const produtosDigitais = produtos.filter((p) => p.stock_atual >= 3);
  const baseDigital = produtosDigitais.length > 0 ? produtosDigitais : produtos;
  const restosGaveta = produtos.filter((p) => p.stock_atual <= 2);

  const nomesArtigosDigitais = baseDigital
    .slice(0, 3)
    .map((p) => p.designacao.substring(0, 35))
    .join(', ');
  const primeiroArtigo = produtos[0] ? produtos[0].designacao.substring(0, 40) : 'produtos selecionados';
  const notaRestosBalcao =
    restosGaveta.length > 0
      ? ` Prioridade interna de equipa: escoar primeiro as últimas unidades de ${restosGaveta
          .slice(0, 2)
          .map((r) => `${r.designacao.substring(0, 28)} (${r.stock_atual} un)`)
          .join(' e ')}.`
      : '';

  if (canaisSelecionados.includes('loja')) {
    materials.lojaBalcao = {
      pitchBalcao10s: `«Estamos esta semana com o ${campanha.titulo}! Ao levar os seus cuidados habituais, aproveite a campanha especial em ${primeiroArtigo}. Quer que inclua no seu saco?»`,
      posicionamentoRecomendado:
        'Ilha Central à entrada da farmácia (produtos com ≥ 3 un.) + Cesto de Oportunidade junto à caixa para limpar restos de 1-2 unidades.',
      dicaAtendimento: `Oferecer como cuidado complementar durante o aviamento de receitas de rotina para utentes com queixas associadas à época.${notaRestosBalcao}`,
    };
  }

  if (canaisSelecionados.includes('redes')) {
    materials.redesSociais = {
      tituloPost: `${campanha.icone} ${campanha.titulo} na Farmácia`,
      textoLegenda:
        `A pensar no seu bem-estar esta estação, preparámos uma campanha especial!\n\n` +
        `Durante este mês, aproveite as melhores condições em cuidados de saúde e bem-estar selecionados (com stock garantido), incluindo ${nomesArtigosDigitais}.\n\n` +
        `🎁 ${campanha.mecanicaSugerida}.\n\n` +
        `Visite-nos ou envie mensagem privada para reservar os seus artigos. A nossa equipa farmacêutica está pronta para o aconselhar!`,
      hashtags: '#Farmacia #Saude #BemEstar #CampanhaSaude #CuidadosFarmaceuticos #Aconselhamento',
      formatoSugerido:
        'Carrossel no Instagram destacando apenas os artigos com ≥ 3 un. em stock (os restos de 1-2 un. foram reservados automaticamente para venda assistida ao balcão).',
    };
  }

  if (canaisSelecionados.includes('ecras')) {
    materials.ecrasMultimedia = {
      headline: `${campanha.icone} ${campanha.titulo.toUpperCase()}`,
      bulletPoints: [
        `Cuidados essenciais para a época: ${campanha.epoca}`,
        `${campanha.mecanicaSugerida}`,
        `Em destaque: ${nomesArtigosDigitais}`,
      ],
      chamadaAcao: 'Fale hoje com o seu farmacêutico e aproveite a campanha de balcão!',
    };
  }

  if (canaisSelecionados.includes('app')) {
    materials.appSms = {
      notificacaoPushTitulo: `${campanha.icone} ${campanha.titulo}`,
      notificacaoPushCorpo: `Condições especiais este mês na sua Farmácia: ${campanha.mecanicaSugerida}. Venha visitar-nos ou reserve pela App!`,
      smsTexto160c: `Farmacia: Aproveite o ${campanha.titulo}! ${campanha.mecanicaSugerida} em artigos selecionados ate fim do mes. Esperamos por si!`,
    };
  }

  return materials;
}

/**
 * Gera o template executivo do Boletim Comercial Mensal por Email
 */
export function generateMonthlyEmailDigest(
  farmaciaNome: string,
  campanha: CampaignDefinition,
  produtos: CampaignProductItem[],
  simulacao: FinancialSimulation
): { subject: string; html: string; text: string } {
  const subject = `[BI Pharma] ${campanha.icone} Proposta de Campanha para ${campanha.epoca} — ${farmaciaNome}`;

  const listaHtml = produtos
    .slice(0, 6)
    .map(
      (p) =>
        `<tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">
            <b>[${p.cnp_codigo}]</b> ${p.designacao}<br/>
            <span style="font-size: 11px; color: #0284c7;">${p.criterio_marketing || p.eixo_campanha || ''} · ${p.canais_recomendados || ''}</span>
          </td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: center;">${p.stock_atual} un</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: right;">${p.pvp.toFixed(2)} €</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: right; color: #10b981; font-weight: 700;">${p.margem_percentagem.toFixed(0)}%</td>
        </tr>`
    )
    .join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b;">
      <div style="max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
        <div style="background: linear-gradient(135deg, #0284c7, #6366f1); padding: 24px; color: #ffffff;">
          <div style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; opacity: 0.9;">Boletim Comercial & Escoamento 360º</div>
          <h1 style="font-size: 22px; margin: 8px 0 4px; font-weight: 800;">${campanha.icone} ${campanha.titulo}</h1>
          <div style="font-size: 14px; opacity: 0.9;">Farmácia: ${farmaciaNome} | Época: ${campanha.epoca}</div>
        </div>
        <div style="padding: 24px;">
          <p style="font-size: 15px; line-height: 1.5; color: #334155;">
            Olá equipa da <b>${farmaciaNome}</b>,<br/><br/>
            Com base no calendário de saúde e nos critérios de escoamento de stock (Validades, Monos e Restos de Gaveta), preparámos o plano operacional para as próximas semanas:
          </p>
          <div style="background: #f1f5f9; border-left: 4px solid #0284c7; padding: 14px 18px; border-radius: 6px; margin: 18px 0;">
            <div style="font-weight: 700; color: #0f172a; font-size: 15px;">Mecânica Proposta: ${campanha.mecanicaSugerida}</div>
            <div style="font-size: 13px; color: #475569; margin-top: 4px;">${campanha.descricao}</div>
          </div>
          <div style="display: flex; gap: 12px; margin: 20px 0;">
            <div style="flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: center;">
              <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Stock Mobilizável</div>
              <div style="font-size: 18px; font-weight: 800; color: #0284c7; margin-top: 4px;">${simulacao.totalUnidades} un</div>
            </div>
            <div style="flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: center;">
              <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Faturação Estimada</div>
              <div style="font-size: 18px; font-weight: 800; color: #10b981; margin-top: 4px;">${simulacao.faturacaoComDesconto.toFixed(2)} €</div>
            </div>
            <div style="flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: center;">
              <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Margem Final (%)</div>
              <div style="font-size: 18px; font-weight: 800; color: #6366f1; margin-top: 4px;">${simulacao.margemFinalPct.toFixed(1)}%</div>
            </div>
          </div>
          <h3 style="font-size: 14px; color: #475569; text-transform: uppercase; margin: 20px 0 10px;">Artigos Prioritários & Canal de Escoamento:</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <thead>
              <tr style="background: #f1f5f9; color: #64748b; font-size: 11px; text-transform: uppercase;">
                <th style="padding: 8px 12px; text-align: left;">Artigo & Critério</th>
                <th style="padding: 8px 12px; text-align: center;">Stock</th>
                <th style="padding: 8px 12px; text-align: right;">PVP</th>
                <th style="padding: 8px 12px; text-align: right;">Margem</th>
              </tr>
            </thead>
            <tbody>
              ${listaHtml}
            </tbody>
          </table>
          <div style="text-align: center; margin-top: 28px;">
            <a href="http://localhost:3000/#campaigns" style="background: #0284c7; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; display: inline-block;">
              🚀 Abrir no BI Pharma & Gerar Materiais
            </a>
          </div>
        </div>
        <div style="background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; font-size: 12px; color: #94a3b8;">
          BI Pharma — Inteligência Comercial Farmacêutica | Validação Anti-Dumping Lei 166/2013
        </div>
      </div>
    </body>
    </html>
  `;

  const text =
    `[BI Pharma] ${campanha.titulo} (${farmaciaNome})\n\n` +
    `Proposta Comercial: ${campanha.mecanicaSugerida}\n` +
    `Stock: ${simulacao.totalUnidades} un | Faturação Est.: ${simulacao.faturacaoComDesconto.toFixed(2)} € | Margem: ${simulacao.margemFinalPct.toFixed(1)}%\n\n` +
    `Aceda ao BI Pharma para gerar os materiais de Loja, Redes Sociais e TV: http://localhost:3000/#campaigns`;

  return { subject, html, text };
}

// ============================================================================
// 5. CRIADOR DE CAMPANHAS À MEDIDA (EVENTOS LIVRES & PRODUTOS ESPECÍFICOS)
// ============================================================================

export interface CustomCampaignRequest {
  modo?: 'EVENTO' | 'PRODUTOS';
  eventoPreset?:
    | 'halloween'
    | 'black_friday'
    | 'festas_cidade'
    | 'aniversario_farmacia'
    | 'evento_desportivo'
    | 'dia_mae_pai'
    | 'custom';
  nomePersonalizado?: string;
  termosPesquisa?: string;
  cnpsSelecionados?: string[];
  focoStock?: 'TODOS_ELEGIVEIS' | 'PRIORIDADE_VALIDADES_MONOS' | 'SO_VALIDADES_E_MONOS';
  descontoDesejadoPct?: number;
}

const EVENT_PRESET_TEMPLATES: Record<
  string,
  {
    titulo: string;
    epoca: string;
    icone: string;
    descricao: string;
    termos: string[];
    excluir: string[];
    mecanicaSugerida: string;
    descontoSugeridoPct: number;
    contextoEpoca: SeasonAnatomy;
  }
> = {
  halloween: {
    titulo: 'Especial Halloween — Limpeza de Pele, Desmaquilhantes & Bem-Estar',
    epoca: 'Outubro / Halloween',
    icone: '🎃',
    descricao:
      'Remoção segura de pinturas/maquilhagem de Halloween, águas micelares, reparação da barreira cutânea, máscaras de rosto e vitaminas/gomas infantis.',
    termos: [
      'micelar',
      'desmaquilh',
      'limpeza',
      'creme rosto',
      'serum',
      'mascara',
      'hidrat',
      'cicalfate',
      'bepanthene',
      'stick labial',
      'batom',
      'lovren',
      'magic studio',
      'martinelia',
      'absorvit infantil',
    ],
    excluir: ['vaginal', 'oftalm', 'injet'],
    mecanicaSugerida: 'Doçura ou Beleza: -15% a -20% em Limpeza de Pele, Cosmética e Hidratação Pós-Festa',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Festas de Halloween escolares e noturnas com uso de pinturas faciais, maquilhagem intensa e doces.',
      doresUtente: [
        'Remoção de maquilhagem/pinturas sem irritar a pele das crianças e adultos',
        'Pele sensível ou reativa após caracterização',
        'Higiene oral após consumo de doces e proteção labial no frio noturno',
      ],
      familiasChave: ['Águas Micelares & Géis de Limpeza', 'Maquilhagem & Cosmética (Lovren/Martinelia)', 'Cremes Reparadores & Hidratantes', 'Higiene Oral Infantil'],
      estrategiaEscoamento: 'Montar cesto temático de Halloween no balcão com cosmética, águas micelares e cuidados infantis em excesso de stock.',
    },
  },
  black_friday: {
    titulo: 'Black Friday & Cyber Week Farmácia (Top Margem & Liquidação)',
    epoca: 'Novembro / Black Friday',
    icone: '🖤',
    descricao:
      'Seleção transversal dos produtos de Venda Livre com maior margem comercial (≥ 32%) e excesso de stock/validade, permitindo descontos fortes de -20% a -25% com lucro garantido.',
    termos: [],
    excluir: ['vaginal', 'oftalm', 'injet'],
    mecanicaSugerida: 'Black Week Farmácia: Descontos reais de -20% a -25% (100% Seguros Anti-Dumping) em Dermocosmética, Perfumes e Bem-Estar',
    descontoSugeridoPct: 20,
    contextoEpoca: {
      perfilEpoca: 'Maior pico comercial de descontos do ano; o utente procura oportunidades reais e antecipa presentes de Natal.',
      doresUtente: ['Procura de descontos agressivos em marcas premium de dermocosmética, perfumaria e suplementos'],
      familiasChave: ['Dermocosmética de Rosto & Corpo', 'Perfumaria & Coffrets', 'Suplementos & Bem-Estar com Margem ≥ 35%'],
      estrategiaEscoamento: 'Priorizar referências com ≥ 3 un. em stock e margem alta para transformar capital empatado em liquidez imediata.',
    },
  },
  festas_cidade: {
    titulo: 'Especial Festas da Cidade & Romarias — Kit Folia, Digestão & Pés',
    epoca: 'Evento Local / Festas da Cidade',
    icone: '🎉',
    descricao:
      'Preparação e recuperação para os dias de festa local: alívio de azia e excessos alimentares, energia/fadiga, pensos para bolhas nos pés e alívio de dores/constipações.',
    termos: [
      'gaviscon',
      'kompensan',
      'rennie',
      'nexium',
      'transilax',
      'alcachofra',
      'cardo',
      'guronsan',
      'sargenor',
      'absorvit',
      'compeed',
      'penso',
      'antigrip',
      'gripp',
      'griponal',
      'ilvico',
      'stick labial',
      'preservat',
      'control',
      'durex',
    ],
    excluir: ['vaginal', 'oftalm'],
    mecanicaSugerida: 'Kit Festas da Cidade: Alívio Digestivo, Energia, Pensos p/ Bolhas e Bem-Estar com -15%',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Grande afluência pedonal, convívios gastronómicos, noitadas ao ar livre e longas caminhadas nas festas locais.',
      doresUtente: [
        'Azia, enfartamento, refluxo e ressaca',
        'Bolhas e dor nos pés por caminhar ou estar horas em pé',
        'Cansaço físico, rouquidão e constipações por frio noturno',
      ],
      familiasChave: ['Antiácidos, Alginatos & Digestivos Hepáticos', 'Pensos p/ Bolhas (Compeed) & Cuidado dos Pés', 'Tónicos de Energia (Sargenor/Guronsan) & Antigripais MNSRM'],
      estrategiaEscoamento: 'Criar expositor "Kit Sobrevivência Festas da Cidade" junto à porta/balcão com artigos de impulso e validade curta.',
    },
  },
  aniversario_farmacia: {
    titulo: 'Semana de Aniversário da Farmácia — Especial Comunidade',
    epoca: 'Aniversário da Farmácia',
    icone: '🎂',
    descricao:
      'Campanha institucional de celebração com os utentes: seleção das melhores oportunidades em Dermocosmética, Higiene Oral, Puericultura e Suplementos.',
    termos: [],
    excluir: ['vaginal', 'oftalm'],
    mecanicaSugerida: 'Semana de Aniversário: -15% de desconto direto em seleção de Beleza, Saúde e Bem-Estar + Oferta de Amostra',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Momento de fidelização e proximidade com os clientes habituais da farmácia.',
      doresUtente: ['Renovação do armário de saúde e higiene da família com benefício especial'],
      familiasChave: ['Dermocosmética Familiar', 'Higiene Oral', 'Suplementos & Vitaminas', 'Perfumaria'],
      estrategiaEscoamento: 'Combinar produtos âncora reconhecidos pelos clientes com referências em excesso de cobertura.',
    },
  },
  evento_desportivo: {
    titulo: 'Especial Desporto, Caminhada & Recuperação Muscular',
    epoca: 'Evento Desportivo / Maratona Local',
    icone: '🏃',
    descricao:
      'Apoio ao desportista e caminhante: magnésio contra cãibras, géis e pensos musculares/articulares, cuidado de bolhas nos pés e fotoproteção.',
    termos: [
      'magnesio',
      'voltaren',
      'fisiocrem',
      'biofreeze',
      'reumon',
      'dimobil',
      'transact',
      'compeed',
      'creme pes',
      'cr pes',
      'joelheira',
      'tornozeleira',
      'puls',
      'ligadura',
      'sargenor',
      'solar',
    ],
    excluir: ['vaginal', 'oftalm'],
    mecanicaSugerida: 'Pack Desporto & Movimento: Magnésio + Gel Muscular ou Cuidado do Pé com -15%',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Provas desportivas locais, caminhadas solidárias, trails ou aumento da prática de exercício físico.',
      doresUtente: ['Cãibras e fadiga muscular', 'Dores articulares, entorses e contraturas', 'Calosidades, atrito e bolhas nos pés'],
      familiasChave: ['Magnésio & Energia', 'Géis Anti-inflamatórios e Crioterapia', 'Ortopedia Elástica & Pensos p/ Bolhas'],
      estrategiaEscoamento: 'Destacar junto ao balcão e comunicar nas redes sociais na semana que antecede a prova.',
    },
  },
  dia_mae_pai: {
    titulo: 'Especial Dia da Mãe / Pai & Mimos de Família',
    epoca: 'Efeméride Familiar',
    icone: '💝',
    descricao:
      'Sugestões de presente útil e elegante na farmácia: perfumaria, coffrets, cuidados anti-idade de rosto, cremes de mãos e suplementos de vitalidade.',
    termos: ['perfum', 'parfum', 'eau toilette', 'edt', 'coffret', 'serum', 'creme rosto', 'antirrugas', 'creme maos', 'centrum', 'absorvit'],
    excluir: ['vaginal', 'oftalm', 'infantil'],
    mecanicaSugerida: 'Presente com Saúde: -15% em Perfumaria, Coffrets e Dermocosmética + Saco Presente',
    descontoSugeridoPct: 15,
    contextoEpoca: {
      perfilEpoca: 'Datas familiares de oferta de presentes de cuidado pessoal, beleza e bem-estar.',
      doresUtente: ['Encontrar um presente de qualidade comprovada sem filas de centro comercial'],
      familiasChave: ['Perfumaria & Eau de Toilette', 'Séruns & Cremes Anti-Idade', 'Multivitamínicos Sénior/Adulto'],
      estrategiaEscoamento: 'Criar corner de presentes com etiquetas de preço por escalão (até 10€, 15€, 25€) usando o stock parado.',
    },
  },
};

export async function buildCustomCampaign(
  prisma: PrismaClient,
  farmaciaId: string,
  req: CustomCampaignRequest
): Promise<CampaignSuggestionResult> {
  const catalog = await getPharmacyCatalog(prisma, farmaciaId);
  const presetKey = req.eventoPreset && EVENT_PRESET_TEMPLATES[req.eventoPreset] ? req.eventoPreset : null;
  const preset = presetKey ? EVENT_PRESET_TEMPLATES[presetKey] : null;

  const cnpsEscolhidos = new Set((req.cnpsSelecionados || []).map((c) => c.trim()).filter(Boolean));
  const selecionados: CampaignProductItem[] = [];
  const seenCnps = new Set<string>();

  // 1. Incluir sempre primeiro os produtos explicitamente escolhidos pelo utilizador (mesmo 1 produto único como o Antigrippine!)
  for (const cnp of cnpsEscolhidos) {
    const item = catalog.find((i) => i.cnp === cnp);
    if (item) {
      const converted = toCampaignProductItem(item, '🎯 Produto Foco Selecionado');
      converted.criterio_marketing = isItemExpiryRisk(item)
        ? '🔥 Produto Alvo (Validade Crítica)'
        : item.vendasQtd <= 2
          ? '🕸️ Produto Alvo (Mono)'
          : '⭐ Produto Alvo Escolhido';
      const vmm = item.vendasQtd / 12;
      converted.motivo_selecao = `🎯 Escolhido pela Farmácia · Stock: ${item.stock} un (VMM: ${vmm.toFixed(1)}/mês)${
        item.validade ? ` · Validade: ${item.validade}` : ''
      }`;
      converted.score_prioridade += 200;
      selecionados.push(converted);
      seenCnps.add(item.cnp);
    }
  }

  // 2. Pesquisar produtos adicionais se for campanha de Evento/Tema ou se o utilizador pediu termos de pesquisa
  const rawTerms = (req.termosPesquisa || '')
    .split(/[,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);

  const searchTerms = rawTerms.length > 0 ? rawTerms : preset ? preset.termos : [];
  const shouldFillFromCatalog = req.modo !== 'PRODUTOS' || selecionados.length === 0 || rawTerms.length > 0;

  if (shouldFillFromCatalog) {
    let pool = catalog.filter(
      (it) => it.stock > 0 && it.tipoVenda !== 'MSRM' && it.pvp > it.custo && it.margem >= 20 && !seenCnps.has(it.cnp)
    );

    if (preset?.excluir?.length) {
      pool = pool.filter((it) => !preset.excluir.some((ex) => termMatches(it.norm, ex)));
    }

    if (searchTerms.length > 0) {
      const matched = pool.filter((it) =>
        searchTerms.some((t) => termMatches(it.norm, t) || it.categoria.toLowerCase().includes(t) || it.cnp.includes(t))
      );
      if (matched.length > 0) {
        pool = matched;
      }
    } else if (presetKey === 'black_friday' || presetKey === 'aniversario_farmacia') {
      pool = pool.filter((it) => it.margem >= 30 && it.stock >= 2);
    }

    if (req.focoStock === 'SO_VALIDADES_E_MONOS') {
      const strict = pool.filter((it) => isItemExpiryRisk(it) || it.vendasQtd <= 2 || it.stock / Math.max(0.5, it.vendasQtd / 12) > 4);
      if (strict.length > 0) pool = strict;
    }

    const convertidos = pool.map((m) =>
      toCampaignProductItem(m, preset ? `${preset.icone} ${preset.epoca}` : req.nomePersonalizado || '✨ Seleção Personalizada')
    );
    convertidos.sort((a, b) => b.score_prioridade - a.score_prioridade);

    for (const item of convertidos.slice(0, 18)) {
      if (!seenCnps.has(item.cnp_codigo)) {
        seenCnps.add(item.cnp_codigo);
        selecionados.push(item);
      }
    }
  }

  // Se o utilizador escolheu 1 produto específico (ex: Antigrippine) e quer complementar com parceiros de Cross-Selling na campanha:
  const mainProd = selecionados[0];
  const isSingleProductFocus = cnpsEscolhidos.size > 0 && req.modo === 'PRODUTOS';

  const tituloFinal =
    req.nomePersonalizado?.trim() ||
    (isSingleProductFocus && selecionados.length === 1
      ? `Campanha Foco de Escoamento: ${mainProd.designacao.slice(0, 42)}`
      : isSingleProductFocus
        ? `Campanha Foco (${selecionados.length} Produtos Selecionados pela Farmácia)`
        : preset?.titulo || `Campanha Personalizada: ${req.termosPesquisa || 'Seleção da Farmácia'}`);

  const iconeFinal = preset?.icone || (isSingleProductFocus ? '🎯' : '✨');
  const epocaFinal = preset?.epoca || (isSingleProductFocus ? 'Ação Foco de Balcão & Loja' : 'Evento Personalizado');
  const descPct = req.descontoDesejadoPct ?? preset?.descontoSugeridoPct ?? 15;

  const campDef: CampaignDefinition = {
    id: `custom_${Date.now()}`,
    titulo: tituloFinal,
    epoca: epocaFinal,
    icone: iconeFinal,
    tipoCampanha: isSingleProductFocus ? 'LIQUIDACAO_STOCK' : 'EPOCA_CALENDARIO',
    descricao:
      preset?.descricao ||
      (isSingleProductFocus
        ? `Plano operacional desenhado especificamente para escoar ${selecionados.map((s) => s.designacao.slice(0, 30)).join(', ')}, combinando incentivo seguro Anti-Dumping, meta semanal de balcão e venda cruzada.`
        : `Campanha personalizada criada à medida pela farmácia com prioridade aos produtos em risco de validade, monos e excesso de cobertura.`),
    mesesAlvo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    termosCategoria: searchTerms,
    margemMinimaPct: 20,
    mecanicaSugerida:
      preset?.mecanicaSugerida ||
      (isSingleProductFocus
        ? `Destaque Prioritário de Balcão c/ -${descPct}% (PVP Promo Seguro) + Recomendação Ativa em Cross-Selling`
        : `Campanha Especial ${tituloFinal} com -${descPct}% em artigos selecionados`),
    descontoSugeridoPct: descPct,
    contextoEpoca: preset?.contextoEpoca || {
      perfilEpoca: isSingleProductFocus
        ? `Foco intensivo da equipa de balcão para escoar stock acumulado/validade de ${mainProd?.designacao || 'artigos selecionados'}.`
        : `Campanha temática criada à medida para o evento "${tituloFinal}".`,
      doresUtente: ['Procura de aconselhamento farmacêutico dirigido e oportunidade de poupança imediata no balcão'],
      familiasChave: Array.from(new Set(selecionados.map((s) => s.categoria))).slice(0, 4),
      estrategiaEscoamento:
        'Alinhar toda a equipa de atendimento com meta semanal de unidades a dispensar, expor no balcão principal e associar às locomotivas de receita/venda livre.',
    },
  };

  const totalUnidades = selecionados.reduce((s, i) => s + i.stock_atual, 0);
  const faturacaoPvp = selecionados.reduce((s, i) => s + i.stock_atual * i.pvp, 0);
  const capitalCusto = selecionados.reduce((s, i) => s + i.stock_atual * i.custo_unitario, 0);

  return {
    campanha: campDef,
    produtosSugeridos: selecionados,
    totalArtigosDisponiveis: selecionados.length,
    totalUnidadesStock: totalUnidades,
    faturacaoPotencialPvp: faturacaoPvp,
    capitalImobilizadoCusto: capitalCusto,
    margemMediaAtualPct: faturacaoPvp > 0 ? ((faturacaoPvp - capitalCusto) / faturacaoPvp) * 100 : 0,
    resumoCriterios: summarizeCriteria(selecionados),
  };
}

// ============================================================================
// 6. SIMULADOR 360º DE ESCOAMENTO & CROSS-SELLING PARA UM PRODUTO ESPECÍFICO
// ============================================================================

export interface ProductMarketing360Result {
  produtoAlvo: {
    cnp: string;
    designacao: string;
    categoria: string;
    tipoVenda: string;
    ehGenerico: boolean;
    grupoDci: string | null;
    stockAtual: number;
    vendasAno: number;
    vmmAtual: number;
    coberturaMeses: number | null;
    validade: string | null;
    mesesAteValidade: number | null;
    unidadesEmRiscoValidade: number;
    valorEmRiscoEur: number;
    custoUnitario: number;
    pvpAtual: number;
    margemAtualPct: number;
    elegivelDesconto: boolean;
    descontoSeguroPct: number;
    pvpPromoRecomendado: number;
    margemPosDescontoPct: number;
    notaRegulatoriaInfarmed: string;
    metaEquipaTexto: string;
    canaisRecomendados: string;
  };
  gatilhosEntrada: {
    explicacaoGatilho: string;
    procuraMensalCategoriaUn: number;
    locomotivasQuePuxam: Array<{
      cnp: string;
      designacao: string;
      tipoVenda: string;
      vmm: number;
      vendasAno: number;
      relacaoClinica: string;
    }>;
    alternativasMesmaCategoria: Array<{
      cnp: string;
      designacao: string;
      tipoVenda: string;
      vmm: number;
      stock: number;
      comoRedirecionar: string;
    }>;
  };
  parceirosCrossSelling: Array<{
    cnp: string;
    designacao: string;
    categoria: string;
    tipoVenda: string;
    stock: number;
    pvp: number;
    margemPct: number;
    criterioUrgencia: string;
    pvpPromoSugerido: number;
    sinergiaClinica: string;
  }>;
  scriptBalcaoPronto: string;
}

export async function searchProductsForMarketingPicker(
  prisma: PrismaClient,
  farmaciaId: string,
  query: string
): Promise<
  Array<{
    cnp: string;
    designacao: string;
    categoria: string;
    tipoVenda: string;
    stock: number;
    pvp: number;
    custo: number;
    margemPct: number;
    validade: string | null;
    vmm: number;
    riscoValidade: boolean;
  }>
> {
  const catalog = await getPharmacyCatalog(prisma, farmaciaId);
  const q = query.trim().toLowerCase();
  const comStock = catalog.filter((i) => i.stock > 0);

  const filtered = !q
    ? comStock
        .filter((i) => i.tipoVenda !== 'MSRM')
        .sort((a, b) => (isItemExpiryRisk(b) ? 1 : 0) - (isItemExpiryRisk(a) ? 1 : 0) || b.stock * b.custo - a.stock * a.custo)
    : comStock
        .filter(
          (i) =>
            i.cnp.includes(q) ||
            i.designacao.toLowerCase().includes(q) ||
            i.norm.includes(q) ||
            i.categoria.toLowerCase().includes(q)
        )
        .sort((a, b) => b.stock * b.custo - a.stock * a.custo);

  return filtered.slice(0, 25).map((i) => ({
    cnp: i.cnp,
    designacao: i.designacao,
    categoria: i.categoria,
    tipoVenda: i.ehGenerico ? 'GENERICO_MG' : i.tipoVenda,
    stock: i.stock,
    pvp: i.pvp,
    custo: i.custo,
    margemPct: Number(i.margem.toFixed(1)),
    validade: i.validade,
    vmm: Number((i.vendasQtd / 12).toFixed(1)),
    riscoValidade: isItemExpiryRisk(i),
  }));
}

export async function analyzeProductMarketingAndCrossSell360(
  prisma: PrismaClient,
  farmaciaId: string,
  cnpOrQuery: string
): Promise<ProductMarketing360Result | null> {
  const catalog = await getPharmacyCatalog(prisma, farmaciaId);
  const q = cnpOrQuery.trim().toLowerCase();

  let target = catalog.find((i) => i.cnp === cnpOrQuery.trim());
  if (!target) {
    target = catalog
      .filter((i) => i.designacao.toLowerCase().includes(q) || i.norm.includes(q) || i.cnp.includes(q))
      .sort((a, b) => b.stock - a.stock)[0];
  }
  if (!target) return null;

  const vmm = Number((target.vendasQtd / 12).toFixed(2));
  const cobertura = vmm > 0 ? Number((target.stock / vmm).toFixed(1)) : null;

  let mesesAteVal: number | null = null;
  let unidadesEmRisco = 0;
  if (target.validade) {
    const refMs = new Date('2026-10-20').getTime();
    const valMs = new Date(target.validade).getTime();
    mesesAteVal = Number(Math.max(0.5, (valMs - refMs) / (1000 * 60 * 60 * 24 * 30.44)).toFixed(1));
    const escoamentoPrevisto = Math.floor(vmm * mesesAteVal);
    unidadesEmRisco = Math.max(0, target.stock - escoamentoPrevisto);
  }
  const valorEmRiscoEur = Number((unidadesEmRisco * target.custo).toFixed(2));

  const simDesc =
    target.tipoVenda !== 'MSRM'
      ? computeSafeAntiDumpingDiscount(target.custo, target.pvp, unidadesEmRisco > 0 ? 15 : 10)
      : { podeDesconto: false, descontoPct: 0, pvpPromo: target.pvp, margemFinalPct: target.margem };

  let notaRegulatoria = '';
  if (target.tipoVenda === 'VENDA_LIVRE') {
    notaRegulatoria =
      '🟢 Produto de Saúde e Bem-Estar (Venda Livre): Elegível para promoção em todos os canais (Balcão, Montra, Ecrãs, Redes Sociais, App/SMS) e descontos diretos respeitando o travão Anti-Dumping.';
  } else if (target.tipoVenda === 'MNSRM') {
    notaRegulatoria = `🔵 Medicamento Não Sujeito a Receita (MNSRM): Permite desconto de preço em loja/balcão (PVP Promo seguro: ${simDesc.pvpPromo.toFixed(2)}€ c/ -${simDesc.descontoPct}%) e recomendação farmacêutica ativa no balcão. Nas Redes Sociais, comunicar a temática de saúde (${target.categoria}) sem publicidade promocional direta ao medicamento.`;
  } else if (target.ehGenerico) {
    notaRegulatoria = `🧬 Medicamento Genérico Sujeito a Receita (MSRM): Preço regulado (proibido desconto comercial). Escoar prioritariamente por Substituição DCI nas receitas médicas de ${target.grupoDci || target.moleculaDci || 'princípio ativo equivalente'}.`;
  } else {
    notaRegulatoria =
      '🔴 Medicamento de Marca Sujeito a Receita (MSRM): Vedado a campanhas promocionais ou descontos. Gerir por ajuste de stock mínimo a zero e pedido de recolha/nota de crédito ao armazenista antes da caducidade.';
  }

  // Calcular Meta Operacional Semanal/Mensal da Equipa
  const horizonteMeses = mesesAteVal !== null ? Math.max(1, Math.min(mesesAteVal - 0.5, 6)) : 3;
  const metaMensalUn = Math.ceil(target.stock / horizonteMeses);
  const metaSemanalUn = Math.max(1, Math.ceil(metaMensalUn / 4.3));
  const metaEquipaTexto =
    mesesAteVal !== null && unidadesEmRisco > 0
      ? `🔥 Meta Salva-Validades: Atualmente vende ${vmm} un/mês (ficariam ${unidadesEmRisco} un por vender até ${target.validade} = ${valorEmRiscoEur.toFixed(2)}€ em risco). Para escoar todo o stock a tempo, a equipa precisa de dispensar ${metaMensalUn} un/mês (~${metaSemanalUn} emb./semana).`
      : `🎯 Meta de Escoamento em ${horizonteMeses.toFixed(0)} meses: Dispensar ${metaMensalUn} un/mês (~${metaSemanalUn} emb./semana) no balcão para libertar ${(target.stock * target.custo).toFixed(2)}€ a preço de custo.`;

  const canaisRecomendados =
    target.tipoVenda === 'MSRM'
      ? '🏥 Exclusivo Receita Médica / Gestão de Armazenista'
      : target.stock <= 2
        ? '🏪 Exclusivo Cesto de Balcão / Caixa (≤ 2 un — não divulgar em Redes)'
        : target.tipoVenda === 'MNSRM'
          ? '🏪 Balcão, Linear Visível & Ecrãs Internos (Aconselhamento Farmacêutico)'
          : '📡 Todos os Canais (Balcão, Ilha Central, Redes Sociais, Ecrãs & App)';

  // Determinar Mapa Clínico de Locomotivas (Quem puxa este produto) e Parceiros (O que associar a este produto)
  const d = target.designacao.toLowerCase();
  const cat = target.categoria;

  let termosLocomotivasPuxam: string[] = [];
  let relacaoLocomotiva = '';
  let termosParceirosAssociar: Array<{ termos: string[]; sinergia: string }> = [];

  if (
    /\b(antigrip\w*|gripp\w*|griponal|c[eê]gripe|ilvico|tosse|tuss\w*|fluimucil|bisolvon|mucosolvan|mucavex|broncoliber|vibrocil|nasitrim|nasimer|strepsils|strepfen)\b/.test(d) ||
    cat.includes('Gripe')
  ) {
    termosLocomotivasPuxam = ['paracetamol', 'ben-u-ron', 'brufen', 'ibuprofeno', 'amoxicilina', 'azitromicina', 'claritromicina', 'termometro', 'soro', 'nasimer'];
    relacaoLocomotiva = 'Doente com febre, dor de garganta, infeção respiratória ou sintomas gripais';
    termosParceirosAssociar = [
      { termos: ['vitamina c', 'imun', 'geleia real', 'propolis', 'equinacea', 'absorvit'], sinergia: '🛡️ Reforço Imunitário (acelerar recuperação e prevenir recaídas)' },
      { termos: ['agua do mar', 'nasimer', 'soro', 'vibrocil', 'nasitrim'], sinergia: '💧 Lavagem & Descongestão Nasal (limpar vias aéreas superiores)' },
      { termos: ['strepsils', 'strepfen', 'mebocaina', 'grintuss'], sinergia: '🧣 Alívio Local da Garganta e Tosse Irritativa' },
      { termos: ['stick labial', 'letibalm', 'cicalfate', 'batom'], sinergia: '💋 Reparação de Nariz e Lábios Gretados pela Constipação' },
    ];
  } else if (/\b(gaviscon|kompensan|rennie|nexium|ulcermin|transilax|dulcolax|lactulose|alcachofra|digest)\b/.test(d) || cat.includes('Digestiva')) {
    termosLocomotivasPuxam = ['ibuprofeno', 'brufen', 'diclofenac', 'naproxeno', 'omeprazol', 'pantoprazol', 'esomeprazol', 'amoxicilina', 'ferro'];
    relacaoLocomotiva = 'Utente a tomar AINEs/medicação agressiva para o estômago ou com queixas digestivas/obstipação';
    termosParceirosAssociar = [
      { termos: ['probiot', 'biogaia', 'ul-250', 'enterogermina', 'atyflor', 'floracomplex'], sinergia: '🦠 Equilíbrio da Flora Intestinal e Conforto Digestivo' },
      { termos: ['alcachofra', 'cardo', 'drenante', 'coligas'], sinergia: '🌿 Apoio Hepático e Redução de Gases/Enfartamento' },
      { termos: ['magnesio', 'sargenor', 'absorvit'], sinergia: '⚡ Recuperação de Energia e Bem-Estar Geral' },
    ];
  } else if (/\b(voltaren|fisiocrem|biofreeze|reumon|dimobil|dolorilgel|transact|paracetamol|ibuprofeno)\b/.test(d) || cat.includes('Dor')) {
    termosLocomotivasPuxam = ['paracetamol', 'ben-u-ron', 'ibuprofeno', 'brufen', 'diclofenac', 'metamizol', 'nolotil', 'tiocolquicosido', 'relmus'];
    relacaoLocomotiva = 'Utente com dor osteoarticular, contraturas, lombalgia ou receita de analgésico oral';
    termosParceirosAssociar = [
      { termos: ['magnesio', 'colagenio', 'neurobion'], sinergia: '💪 Relaxamento Muscular, Nervos Periféricos e Articulações' },
      { termos: ['gaviscon', 'nexium control', 'kompensan'], sinergia: '🛡️ Proteção Gástrica durante toma de Anti-inflamatórios' },
      { termos: ['joelheira', 'puls', 'tornozeleira', 'ligadura', 'penso'], sinergia: '🩹 Suporte Ortopédico e Alívio Local' },
    ];
  } else if (/\b(cerave|avene|vichy|roche|ducray|klorane|barral|farline|creme|serum|locao|hidrat|ureia|perfum|eau\s*toilette)\b/.test(d) || cat.includes('Dermocosmética')) {
    termosLocomotivasPuxam = ['metformina', 'atorvastatina', 'isotretinoina', 'hidrocortisona', 'betametasona', 'clotrimazol', 'fluconazol'];
    relacaoLocomotiva = 'Utente em tratamento dermatológico, crónico (diabetes) ou rotina de higiene diária';
    termosParceirosAssociar = [
      { termos: ['stick labial', 'letibalm', 'creme maos', 'cicalfate'], sinergia: '👐 Hidratação Complementar de Zonas Expostas (Mãos e Lábios)' },
      { termos: ['micelar', 'limpeza', 'gel banho', 'champo'], sinergia: '🧼 Limpeza Suave antes da Hidratação/Tratamento' },
      { termos: ['solar', 'spf', 'anthelios'], sinergia: '☀️ Proteção contra Fotoenvelhecimento e Manchas' },
    ];
  } else {
    termosLocomotivasPuxam = ['paracetamol', 'ben-u-ron', 'omeprazol', 'atorvastatina', 'metformina', 'amoxicilina'];
    relacaoLocomotiva = 'Atendimentos de rotina e receitas médicas com elevada afluência diária';
    termosParceirosAssociar = [
      { termos: ['absorvit', 'centrum', 'vitamina c', 'magnesio'], sinergia: '⚡ Suplementação de Vitalidade e Imunidade' },
      { termos: ['creme maos', 'stick labial', 'dermaprotect'], sinergia: '🧴 Cuidado Diário de Conforto no Balcão' },
    ];
  }

  // 1. Locomotivas reais na farmácia que puxam este produto
  const locomotivasQuePuxam = catalog
    .filter((it) => it.cnp !== target!.cnp && it.vendasQtd > 0 && termosLocomotivasPuxam.some((t) => termMatches(it.norm, t)))
    .sort((a, b) => b.vendasQtd - a.vendasQtd)
    .slice(0, 5)
    .map((l) => ({
      cnp: l.cnp,
      designacao: l.designacao,
      tipoVenda: l.tipoVenda,
      vmm: Number((l.vendasQtd / 12).toFixed(1)),
      vendasAno: l.vendasQtd,
      relacaoClinica: relacaoLocomotiva,
    }));

  // 2. Alternativas na mesma categoria (para redirecionar procura no balcão!)
  const mesmaCat = catalog.filter((it) => it.cnp !== target!.cnp && it.categoria === target!.categoria && it.vendasQtd > 0);
  const procuraMensalCategoriaUn = Number(
    (mesmaCat.reduce((s, i) => s + i.vendasQtd, target.vendasQtd) / 12).toFixed(1)
  );

  const alternativasMesmaCategoria = mesmaCat
    .sort((a, b) => b.vendasQtd - a.vendasQtd)
    .slice(0, 5)
    .map((alt) => ({
      cnp: alt.cnp,
      designacao: alt.designacao,
      tipoVenda: alt.ehGenerico ? 'GENERICO_MG' : alt.tipoVenda,
      vmm: Number((alt.vendasQtd / 12).toFixed(1)),
      stock: alt.stock,
      comoRedirecionar:
        target!.tipoVenda !== 'MSRM'
          ? `Quando o utente pedir aconselhamento em "${target!.categoria}" (onde ${alt.designacao.slice(0, 26)} vende ${(alt.vendasQtd / 12).toFixed(1)}/mês), apresentar prioritariamente ${target!.designacao.slice(0, 28)}!`
          : `Se a receita for por DCI, substituir pelo stock de ${target!.designacao.slice(0, 28)}.`,
    }));

  // 3. Parceiros de Cross-Selling em stock (priorizando Validades, Monos e Excesso!)
  const parceirosCrossSelling: ProductMarketing360Result['parceirosCrossSelling'] = [];
  const seenParceiros = new Set<string>([target.cnp]);

  for (const grupo of termosParceirosAssociar) {
    const matches = searchCatalog(catalog, {
      grupos_termos: [grupo.termos],
      apenas_com_stock: true,
      segmento: 'SEM_RECEITA',
    })
      .filter((it) => !seenParceiros.has(it.cnp) && it.pvp > it.custo && it.margem >= 20)
      .map((it) => {
        const risco = isItemExpiryRisk(it);
        const mono = it.vendasQtd <= 2 && it.stock >= 2;
        const prio = (risco ? 80 : mono ? 45 : 15) + it.margem + Math.min(it.stock * 2, 20);
        const criterioUrgencia = risco
          ? `🔥 Validade Crítica (${it.validade})`
          : mono
            ? `🕸️ Mono a Escoar (${it.stock} un)`
            : it.stock <= 2
              ? `🧺 Resto de Gaveta (${it.stock} un)`
              : `📦 Stock Folgado (${it.stock} un)`;
        const simP = computeSafeAntiDumpingDiscount(it.custo, it.pvp, 15);
        return {
          cnp: it.cnp,
          designacao: it.designacao,
          categoria: it.categoria,
          tipoVenda: it.tipoVenda,
          stock: it.stock,
          pvp: it.pvp,
          margemPct: Number(it.margem.toFixed(1)),
          criterioUrgencia,
          pvpPromoSugerido: simP.pvpPromo,
          sinergiaClinica: grupo.sinergia,
          prio,
        };
      })
      .sort((a, b) => b.prio - a.prio);

    for (const m of matches.slice(0, 2)) {
      seenParceiros.add(m.cnp);
      parceirosCrossSelling.push(m);
    }
  }

  const topParceiro = parceirosCrossSelling[0];
  const scriptBalcaoPronto =
    target.tipoVenda === 'MSRM'
      ? `«Na sua receita médica, vamos dispensar esta apresentação em stock para garantir o seu tratamento imediato.»`
      : `«Para um alívio rápido e completo, recomendo o ${target.designacao.slice(0, 35)}${
          simDesc.podeDesconto ? ` (hoje com condição especial de ${simDesc.pvpPromo.toFixed(2)}€)` : ''
        }.${
          topParceiro
            ? ` Para potenciar a recuperação e proteger o organismo, aconselho associar também ${topParceiro.designacao.slice(0, 32)} (${topParceiro.sinergiaClinica.replace(/^[^\s]+\s/, '')}). Posso juntar os dois?`
            : ' Quer que inclua já no seu atendimento?'
        }»`;

  return {
    produtoAlvo: {
      cnp: target.cnp,
      designacao: target.designacao,
      categoria: target.categoria,
      tipoVenda: target.ehGenerico ? 'GENERICO_MG' : target.tipoVenda,
      ehGenerico: target.ehGenerico,
      grupoDci: target.grupoDci || null,
      stockAtual: target.stock,
      vendasAno: target.vendasQtd,
      vmmAtual: vmm,
      coberturaMeses: cobertura,
      validade: target.validade,
      mesesAteValidade: mesesAteVal,
      unidadesEmRiscoValidade: unidadesEmRisco,
      valorEmRiscoEur,
      custoUnitario: target.custo,
      pvpAtual: target.pvp,
      margemAtualPct: Number(target.margem.toFixed(1)),
      elegivelDesconto: simDesc.podeDesconto,
      descontoSeguroPct: simDesc.descontoPct,
      pvpPromoRecomendado: simDesc.pvpPromo,
      margemPosDescontoPct: simDesc.margemFinalPct,
      notaRegulatoriaInfarmed: notaRegulatoria,
      metaEquipaTexto,
      canaisRecomendados,
    },
    gatilhosEntrada: {
      explicacaoGatilho: `A categoria "${target.categoria}" gera uma procura total de ${procuraMensalCategoriaUn} un/mês nesta farmácia. Utilize as locomotivas abaixo e os pedidos da mesma categoria para direcionar o utente para ${target.designacao.slice(0, 35)}.`,
      procuraMensalCategoriaUn,
      locomotivasQuePuxam,
      alternativasMesmaCategoria,
    },
    parceirosCrossSelling,
    scriptBalcaoPronto,
  };
}


// ============================================================================
// PACKS CLÍNICOS & CESTOS TEMÁTICOS (POR SINTOMA / PROPÓSITO DO UTENTE)
// ============================================================================

export interface ClinicalThemePackItem {
  cnp: string;
  designacao: string;
  propositoUtente: string; // Linguagem simples: o que o produto faz na prática
  stockAtual: number;
  custoUnitario: number;
  pvpUnitario: number;
  margemPct: number;
  tipoVenda: string;
}

export interface ClinicalThemePack {
  id: string;
  titulo: string;
  sintomaOuQueixa: string;
  publicoAlvo: string;
  icone: string;
  produtos: ClinicalThemePackItem[];
  pvpTotalOriginal: number;
  custoTotal: number;
  descontoPct: number;
  pvpPackComDesconto: number;
  poupancaUtente: number;
  margemPackPct: number;
  orientacaoBalcao: string;
  disposicaoFisica: string;
}

export async function generateClinicalThemePacks(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<ClinicalThemePack[]> {
  const catalog = await getPharmacyCatalog(prisma, farmaciaId);

  const archetypes = [
    {
      id: 'pack_gripe_imunidade',
      titulo: 'Pack Gripe, Tosse & Imunidade Total',
      icone: '🧣',
      sintomaOuQueixa: 'Febre, dores musculares no corpo, tosse e congestão nasal no inverno',
      publicoAlvo: 'Adultos e famílias com sintomas gripais que procuram alívio rápido e reforço das defesas',
      orientacaoBalcao: 'Ao aviar receitas de antibióticos ou analgésicos, perguntar pelos outros sintomas e sugerir a proteção conjunta da garganta e imunidade.',
      disposicaoFisica: 'Cesto temático no balcão principal com o título «SOS Inverno: Alívio Sintomático + Imunidade».',
      roles: [
        {
          nomePapel: 'Antigripal / Antipirético',
          termos: ['ben-u-gripe', 'cegripe', 'antigrippine', 'aspirina c', 'paracetamol gripe', 'trioval', 'ilvico'],
          proposito: 'Alívio rápido da febre, cefaleias e sensação de corpo dorido',
          priorizarExcesso: true,
        },
        {
          nomePapel: 'Garganta & Imunidade Celular',
          termos: ['strepsils', 'propolis', 'mebocaina', 'cegripe c', 'vitamina c', 'pastilhas garganta', 'zinco'],
          proposito: 'Desinfeção da orofaringe, proteção da mucosa e reforço das defesas celulares',
          priorizarExcesso: false,
        },
      ],
    },
    {
      id: 'pack_barreira_cutanea_frio',
      titulo: 'Pack SOS Barreira Cutânea, Lábios & Frio',
      icone: '❄️',
      sintomaOuQueixa: 'Lábios gretados, cieiro, fissuras dolorosas nas mãos e pele ressequida pelo frio',
      publicoAlvo: 'Utentes expostos ao vento/frio, trabalhadores exteriores ou com pele atópica e mãos secas',
      orientacaoBalcao: 'Apresentar como complemento de conveniência no fecho de qualquer atendimento a utentes com mãos expostas ou cieiro.',
      disposicaoFisica: 'Cesto de oportunidades junto ao terminal Multibanco para compra imediata por impulso.',
      roles: [
        {
          nomePapel: 'Stick / Reparador Labial',
          termos: ['letibalm', 'labello', 'cicalfate labios', 'balsamo labial', 'stick labial', 'batom cieiro'],
          proposito: 'Cicatrização rápida de cieiro e criação de barreira protetora labial contra o vento',
          priorizarExcesso: false,
        },
        {
          nomePapel: 'Creme Reparador de Mãos & Emoliente',
          termos: ['creme maos', 'dermaprotect', 'ureia', 'neutrogena maos', 'atoderm maos', 'cicalfate'],
          proposito: 'Nutrição profunda e regeneração da pele gretada e áspera das mãos',
          priorizarExcesso: true,
        },
      ],
    },
    {
      id: 'pack_digestao_refluxo',
      titulo: 'Pack Conforto Digestivo & Azia Pós-Refeições',
      icone: '🍵',
      sintomaOuQueixa: 'Azia, ardor de estômago, refluxo ácido e sensação de enfartamento abdominal',
      publicoAlvo: 'Utentes com queixas dispépticas, refeições pesadas ou excessos de fim-de-semana',
      orientacaoBalcao: 'Perguntar se o desconforto é azia imediata ou enfartamento pesado, oferecendo a solução combinada de alívio.',
      disposicaoFisica: 'Expor na prateleira de venda livre na secção de bem-estar gástrico com sinalética de dupla ação.',
      roles: [
        {
          nomePapel: 'Antiácido / Protetor da Mucosa',
          termos: ['gaviscon', 'rennie', 'kompensan', 'pantoprazol', 'omeprazol'],
          proposito: 'Ação imediata contra o ardor estomacal e neutralização do refluxo ácido',
          priorizarExcesso: false,
        },
        {
          nomePapel: 'Regulador Hepático & Digestivo',
          termos: ['digest', 'cha digestivo', 'alcachofra', 'sollievo', 'cardo mariano', 'hepato'],
          proposito: 'Estimulação da digestão leve e alívio do inchaço e peso abdominal',
          priorizarExcesso: true,
        },
      ],
    },
    {
      id: 'pack_sono_relaxamento',
      titulo: 'Pack Noite Tranquila & Sono Reparador',
      icone: '🌙',
      sintomaOuQueixa: 'Dificuldade em adormecer, despertares noturnos frequentes e cansaço ao acordar',
      publicoAlvo: 'Utentes com insónia inicial, stress de trabalho ou ritmos de sono alterados',
      orientacaoBalcao: 'Explicar que a melatonina atua a induzir o sono e o magnésio/valeriana impedem o despertar a meio da noite.',
      disposicaoFisica: 'Cesto temático na secção de suplementos e fitoterapia com foco em bem-estar noturno.',
      roles: [
        {
          nomePapel: 'Indutor de Sono (Melatonina)',
          termos: ['aquilea sono', 'melatonina', 'sono', 'dormir'],
          proposito: 'Redução do tempo necessário para adormecer de forma suave e fisiológica',
          priorizarExcesso: false,
        },
        {
          nomePapel: 'Relaxante Muscular & Nervoso',
          termos: ['valeriana', 'passiflora', 'magnesio', 'stress', 'ansiedade'],
          proposito: 'Relaxamento das tensões musculares e diminuição dos despertares a meio da noite',
          priorizarExcesso: true,
        },
      ],
    },
    {
      id: 'pack_muscular_articular',
      titulo: 'Pack Alívio Muscular & Articular (Dupla Ação)',
      icone: '🦵',
      sintomaOuQueixa: 'Rigidez matinal, dores articulares agravadas pelo frio e humidade e contraturas musculares',
      publicoAlvo: 'Utentes com queixas osteoarticulares crónicas, idosos ou pessoas com tensão muscular',
      orientacaoBalcao: 'Recomendar a aplicação local do gel para alívio imediato combinada com o suporte articular contínuo.',
      disposicaoFisica: 'Dispor na secção de ortopedia e mobilidade com destaque para o pack de alívio duplo.',
      roles: [
        {
          nomePapel: 'Gel / Creme Tópico de Ação Rápida',
          termos: ['voltaren', 'biofreeze', 'arnica', 'gel dor', 'traumeel', 'flexagil'],
          proposito: 'Efeito térmico e anti-inflamatório localizado para alívio rápido da dor',
          priorizarExcesso: false,
        },
        {
          nomePapel: 'Suporte Articular / Magnésio',
          termos: ['cartilagem', 'colagenio', 'magnesio', 'articulacoes', 'glucosamina'],
          proposito: 'Nutrição das cartilagens e relaxamento contínuo das fibras musculares',
          priorizarExcesso: true,
        },
      ],
    },
  ];

  const packs: ClinicalThemePack[] = [];

  for (const arc of archetypes) {
    const selectedItems: ClinicalThemePackItem[] = [];
    const usedCnps = new Set<string>();

    for (const role of arc.roles) {
      const matches = catalog.filter((item) => {
        if (usedCnps.has(item.cnp)) return false;
        const itemNorm = item.norm || normalizeText(item.designacao);
        return role.termos.some((t) => {
          const normT = normalizeText(t);
          return itemNorm.includes(normT) || item.designacao.toLowerCase().includes(t.toLowerCase());
        });
      });

      if (matches.length === 0) continue;

      matches.sort((a, b) => {
        const aHasStock = (a.stock || 0) > 0 ? 1 : 0;
        const bHasStock = (b.stock || 0) > 0 ? 1 : 0;
        if (aHasStock !== bHasStock) return bHasStock - aHasStock;

        if (role.priorizarExcesso) {
          return (b.stock || 0) - (a.stock || 0);
        }
        return (b.margem || 0) - (a.margem || 0);
      });

      const chosen = matches[0];
      usedCnps.add(chosen.cnp);

      selectedItems.push({
        cnp: chosen.cnp,
        designacao: chosen.designacao,
        propositoUtente: role.proposito,
        stockAtual: chosen.stock,
        custoUnitario: chosen.custo,
        pvpUnitario: chosen.pvp,
        margemPct: Number(chosen.margem.toFixed(1)),
        tipoVenda: chosen.tipoVenda,
      });
    }

    if (selectedItems.length >= 2) {
      const pvpTotalOriginal = Number(
        selectedItems.reduce((acc, it) => acc + (it.pvpUnitario || 0), 0).toFixed(2)
      );
      const custoTotal = Number(
        selectedItems.reduce((acc, it) => acc + (it.custoUnitario || 0), 0).toFixed(2)
      );

      let descontoPct = 12;
      let pvpPackComDesconto = Number((pvpTotalOriginal * (1 - descontoPct / 100)).toFixed(2));
      let margemPackPct =
        pvpPackComDesconto > 0
          ? Number((((pvpPackComDesconto - custoTotal) / pvpPackComDesconto) * 100).toFixed(1))
          : 0;

      if (margemPackPct < 5 && custoTotal > 0) {
        const pvpMinimoSeguro = Number((custoTotal / 0.95).toFixed(2));
        if (pvpMinimoSeguro < pvpTotalOriginal) {
          pvpPackComDesconto = pvpMinimoSeguro;
          descontoPct = Math.max(
            0,
            Math.round(((pvpTotalOriginal - pvpPackComDesconto) / pvpTotalOriginal) * 100)
          );
          margemPackPct = 5.0;
        } else {
          pvpPackComDesconto = pvpTotalOriginal;
          descontoPct = 0;
          margemPackPct =
            pvpTotalOriginal > 0
              ? Number((((pvpTotalOriginal - custoTotal) / pvpTotalOriginal) * 100).toFixed(1))
              : 0;
        }
      }

      const poupancaUtente = Number(Math.max(0, pvpTotalOriginal - pvpPackComDesconto).toFixed(2));

      packs.push({
        id: arc.id,
        titulo: arc.titulo,
        sintomaOuQueixa: arc.sintomaOuQueixa,
        publicoAlvo: arc.publicoAlvo,
        icone: arc.icone,
        produtos: selectedItems,
        pvpTotalOriginal,
        custoTotal,
        descontoPct,
        pvpPackComDesconto,
        poupancaUtente,
        margemPackPct,
        orientacaoBalcao: arc.orientacaoBalcao,
        disposicaoFisica: arc.disposicaoFisica,
      });
    }
  }

  return packs;
}
