import { PrismaClient } from '@prisma/client';

const CLINICAL_MAPPINGS: Array<{
  match: [RegExp, string[]];
  dci: string;
  categoria: string;
  subcategoria: string;
  indicacoes_clinicas: string;
  contraindicacoes_aviso?: string;
}> = [
  {
    match: [/neparvis/i, ['5682802', '5682760', '5682778', '5682828']],
    dci: 'Sacubitril + Valsartan',
    categoria: 'Aparelho Cardiovascular',
    subcategoria: 'Insuficiência Cardíaca Crónica (Inibidor da Neprilisina / ARA II)',
    indicacoes_clinicas: 'Tratamento da insuficiência cardíaca crónica sintomática com fração de ejeção reduzida (ICFEr). Reduz mortalidade e hospitalização.',
    contraindicacoes_aviso: 'contraindicado com IECAs (risco angioedema); monitorizar potássio e função renal.'
  },
  {
    match: [/gardasil/i, ['5658828', '5658810']],
    dci: 'Vacina contra Papilomavírus Humano (Tipos 6, 11, 16, 18, 31, 33, 45, 52, 58)',
    categoria: 'Vacinas & Imunologia',
    subcategoria: 'Vacina HPV 9-Valente',
    indicacoes_clinicas: 'Imunização ativa contra infeções por HPV e lesões pré-cancerosas e cancros (colo do útero, vulva, vagina, ânus) e verrugas genitais.',
    contraindicacoes_aviso: 'hipersensibilidade prévia à vacina; adiar em doença febril aguda grave.'
  },
  {
    match: [/prevenar/i, ['5832019', '5517172']],
    dci: 'Vacina Pneumocócica Polissacárica Conjugada (20-valente)',
    categoria: 'Vacinas & Imunologia',
    subcategoria: 'Vacina Pneumocócica Conjugada',
    indicacoes_clinicas: 'Prevenção de doença invasiva e pneumonia causadas por Streptococcus pneumoniae em adultos e crianças.',
    contraindicacoes_aviso: 'hipersensibilidade às substâncias ativas ou à toxina diftérica.'
  },
  {
    match: [/arexvy/i, ['5859053']],
    dci: 'Vacina Vírus Sincicial Respiratório recombinante adjuvada',
    categoria: 'Vacinas & Imunologia',
    subcategoria: 'Vacina VSR (Vírus Sincicial Respiratório)',
    indicacoes_clinicas: 'Imunização ativa para prevenção da doença do trato respiratório inferior causada pelo VSR em adultos com 60+ anos.',
    contraindicacoes_aviso: 'adiar vacinação em infeção febril aguda moderada a grave.'
  },
  {
    match: [/eliquis/i, ['5487434', '5389853', '5487426']],
    dci: 'Apixabano',
    categoria: 'Aparelho Cardiovascular',
    subcategoria: 'Anticoagulantes Orais Diretos (DOACs / Inibidor Fator Xa)',
    indicacoes_clinicas: 'Prevenção de AVC e embolismo sistémico na Fibrilhação Auricular não-valvular; tratamento e prevenção de TVP e TEP.',
    contraindicacoes_aviso: 'hemorragia ativa clinicamente significativa; hepatopatia associada a coagulopatia.'
  },
  {
    match: [/xarelto/i, ['5424403', '5424395', '5424387']],
    dci: 'Rivaroxabano',
    categoria: 'Aparelho Cardiovascular',
    subcategoria: 'Anticoagulantes Orais Diretos (DOACs / Inibidor Fator Xa)',
    indicacoes_clinicas: 'Prevenção de AVC em FA; tratamento e prevenção de trombose venosa profunda (TVP) e embolia pulmonar (TEP).',
    contraindicacoes_aviso: 'hemorragia ativa; lesão com risco hemorrágico elevado.'
  },
  {
    match: [/lixiana/i, ['5658000', '5657994', '5657986']],
    dci: 'Edoxabano',
    categoria: 'Aparelho Cardiovascular',
    subcategoria: 'Anticoagulantes Orais Diretos (DOACs / Inibidor Fator Xa)',
    indicacoes_clinicas: 'Prevenção de AVC e embolismo sistémico na FA; tratamento e prevenção de TVP e embolia pulmonar.',
    contraindicacoes_aviso: 'hemorragia ativa clinicamente significativa; insuficiência hepática grave.'
  },
  {
    match: [/forxiga/i, ['5487228', '5487236', '5764410']],
    dci: 'Dapagliflozina',
    categoria: 'Diabetes, Metabolismo & Cardiorrenal',
    subcategoria: 'Inibidores SGLT2 (Cardiorrenal / Antidiabético)',
    indicacoes_clinicas: 'Tratamento de Diabetes Mellitus Tipo 2, Insuficiência Cardíaca crónica sintomática (ICFEr e ICFEp) e Doença Renal Crónica.',
    contraindicacoes_aviso: 'monitorizar cetoacidose e infeções urogenitais; desidratação.'
  },
  {
    match: [/jardiance/i, ['5607403', '5607429', '5607411']],
    dci: 'Empagliflozina',
    categoria: 'Diabetes, Metabolismo & Cardiorrenal',
    subcategoria: 'Inibidores SGLT2 (Cardiorrenal / Antidiabético)',
    indicacoes_clinicas: 'Tratamento de Diabetes Tipo 2, Insuficiência Cardíaca crónica (independentemente da FE) e Doença Renal Crónica.',
    contraindicacoes_aviso: 'risco de cetoacidose diabética; risco de depleção de volume.'
  },
  {
    match: [/glyxambi/i, ['5712278', '5712286']],
    dci: 'Empagliflozina + Linagliptina',
    categoria: 'Diabetes & Metabolismo',
    subcategoria: 'Inibidor SGLT2 + Inibidor DPP-4',
    indicacoes_clinicas: 'Controlo glicémico no adulto com Diabetes Tipo 2 quando a metformina e/ou componentes isolados são insuficientes.',
    contraindicacoes_aviso: 'não indicado para diabetes tipo 1; monitorizar pancreatite e cetoacidose.'
  },
  {
    match: [/xigduo/i, ['5589767', '5589759']],
    dci: 'Dapagliflozina + Metformina',
    categoria: 'Diabetes & Metabolismo',
    subcategoria: 'Inibidor SGLT2 + Biguanida',
    indicacoes_clinicas: 'Tratamento adjuvante da Diabetes Tipo 2 em doentes inadequadamente controlados com metformina em monoterapia.',
    contraindicacoes_aviso: 'acidose láctica (metformina); insuficiência renal grave (TFGe < 30 mL/min).'
  },
  {
    match: [/ozempic/i, ['5755640', '5898754', '5755632']],
    dci: 'Semaglutido',
    categoria: 'Diabetes & Metabolismo',
    subcategoria: 'Agonistas dos Recetores GLP-1',
    indicacoes_clinicas: 'Tratamento da Diabetes Tipo 2 insuficientemente controlada; redução de risco de eventos cardiovasculares adversos major.',
    contraindicacoes_aviso: 'histórico de carcinoma medular da tiroide; monitorizar pancreatite e retinopatia diabética.'
  },
  {
    match: [/mounjaro/i, ['5879952', '5879978', '5880034']],
    dci: 'Tirzepatido',
    categoria: 'Diabetes & Metabolismo',
    subcategoria: 'Agonista Duplo dos Recetores GIP e GLP-1',
    indicacoes_clinicas: 'Tratamento de adultos com Diabetes Tipo 2 e controlo de peso/obesidade com comorbilidades associadas.',
    contraindicacoes_aviso: 'monitorizar efeitos gastrointestinais, pancreatite; histórico familiar de CMT.'
  },
  {
    match: [/trulicity/i, ['5635503', '5635495', '5635511']],
    dci: 'Dulaglutido',
    categoria: 'Diabetes & Metabolismo',
    subcategoria: 'Agonistas dos Recetores GLP-1',
    indicacoes_clinicas: 'Tratamento da Diabetes Tipo 2 em adultos para melhorar o controlo glicémico e proteção cardiovascular.',
    contraindicacoes_aviso: 'pancreatite aguda; não usar em diabetes tipo 1.'
  },
  {
    match: [/tresiba/i, ['5552237', '5552229']],
    dci: 'Insulina Degludec',
    categoria: 'Diabetes & Metabolismo',
    subcategoria: 'Insulinas Basais de Longa Duração',
    indicacoes_clinicas: 'Tratamento de Diabetes Mellitus em adultos, adolescentes e crianças a partir de 1 ano de idade.',
    contraindicacoes_aviso: 'hipoglicemia; rotatividade de locais de injeção para evitar lipodistrofia.'
  },
  {
    match: [/trajenta/i, ['5404041']],
    dci: 'Linagliptina',
    categoria: 'Diabetes & Metabolismo',
    subcategoria: 'Inibidores da DPP-4 (Gliptinas)',
    indicacoes_clinicas: 'Melhoria do controlo glicémico em adultos com Diabetes Tipo 2. Seguro sem ajuste de dose na insuficiência renal.',
    contraindicacoes_aviso: 'hipersensibilidade; monitorizar sintomas de pancreatite.'
  },
  {
    match: [/kerendia/i, ['5832456', '5832464']],
    dci: 'Finerenona',
    categoria: 'Cardiovascular & Renal',
    subcategoria: 'Antagonista Não-Esteróide dos Recetores Mineralocorticóides (ns-MRA)',
    indicacoes_clinicas: 'Tratamento de Doença Renal Crónica (com albuminúria) associada a Diabetes Tipo 2 em adultos. Proteção cardiorrenal.',
    contraindicacoes_aviso: 'contraindicado com inibidores potentes do CYP3A4; monitorizar potássio sérico (hipercaliemia).'
  },
  {
    match: [/rosumibe/i, ['5814223', '5814215', '5814231']],
    dci: 'Rosuvastatina + Ezetimiba',
    categoria: 'Aparelho Cardiovascular',
    subcategoria: 'Hipolipemiantes / Estatina + Inibidor Absorção Colesterol',
    indicacoes_clinicas: 'Tratamento da hipercolesterolemia primária e redução de risco cardiovascular em doentes de alto risco.',
    contraindicacoes_aviso: 'doença hepática ativa; gravidez e amamentação; monitorizar mialgias/CPK.'
  },
  {
    match: [/duac/i, ['5663240', '5275573']],
    dci: 'Clindamicina + Peróxido de Benzoílo',
    categoria: 'Dermatologia & Tópicos',
    subcategoria: 'Anti-Acne Tópico (Antibiótico + Queratolítico)',
    indicacoes_clinicas: 'Tratamento tópico do acne vulgar ligeiro a moderado, especialmente com lesões inflamatórias.',
    contraindicacoes_aviso: 'evitar contacto com olhos, boca e mucosas; pode branquear cabelos e tecidos.'
  },
  {
    match: [/bridic/i, ['3958386', '3958378']],
    dci: 'Trimebutina',
    categoria: 'Aparelho Digestivo',
    subcategoria: 'Antiespasmódicos Musculotrópicos / Motilidade Gastrointestinal',
    indicacoes_clinicas: 'Tratamento sintomático da dor e perturbações do trânsito intestinal no Síndrome do Intestino Irritável e espasmos GI.',
    contraindicacoes_aviso: 'hipersensibilidade conhecida à substância ativa.'
  },
  {
    match: [/femsete/i, ['5153986', '5153978']],
    dci: 'Estradiol hemi-hidratado',
    categoria: 'Ginecologia & Saúde da Mulher',
    subcategoria: 'Terapêutica Hormonal de Substituição (THS Transdérmica)',
    indicacoes_clinicas: 'Alívio dos sintomas de deficiência estrogénica em mulheres na pós-menopausa (afrontamentos, suores noturnos).',
    contraindicacoes_aviso: 'histórico de cancro da mama ou tumores estrogénio-dependentes; tromboembolismo venoso ativo.'
  },
  {
    match: [/belara/i, ['5503586', '5503578']],
    dci: 'Clormadinona + Etinilestradiol',
    categoria: 'Ginecologia & Saúde da Mulher',
    subcategoria: 'Contracetivos Orais Combinados Anti-Androgénicos',
    indicacoes_clinicas: 'Contraceção hormonal oral em mulheres e tratamento do acne moderado em mulheres a necessitar de contraceção.',
    contraindicacoes_aviso: 'risco de tromboembolismo venoso/arterial; tabagismo com mais de 35 anos.'
  },
  {
    match: [/ritalin/i, ['3761988', '3761970', '2311496']],
    dci: 'Metilfenidato',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Psicoestimulantes / Terapêutica da PHDA',
    indicacoes_clinicas: 'Parte de programa de tratamento abrangente para a Perturbação de Hiperatividade e Défice de Atenção (PHDA).',
    contraindicacoes_aviso: 'medicamento sujeito a receita médica especial (estupefaciente/psicotrópico); monitorizar PA e FC.'
  },
  {
    match: [/symbicort/i, ['3514080', '3514072', '5655766']],
    dci: 'Budesonida + Formoterol',
    categoria: 'Aparelho Respiratório',
    subcategoria: 'Corticosteroide Inalado + Broncodilatador LABA',
    indicacoes_clinicas: 'Tratamento regular da Asma quando a associação é adequada; tratamento sintomático da DPOC grave com exacerbações repetidas.',
    contraindicacoes_aviso: 'enxaguar a boca após inalação para prevenir candidíase oral; não parar abruptamente.'
  },
  {
    match: [/trelegy/i, ['5737143', '5737150']],
    dci: 'Fluticasona + Umeclidínio + Vilanterol',
    categoria: 'Aparelho Respiratório',
    subcategoria: 'Terapêutica Tripla Inalada (ICS + LAMA + LABA)',
    indicacoes_clinicas: 'Tratamento de manutenção em adultos com DPOC moderada a grave e Asma inadequadamente controlada com ICS/LABA.',
    contraindicacoes_aviso: 'enxaguar a boca após inalação; não indicado para alívio de broncospasmo agudo.'
  },
  {
    match: [/azzalure/i, ['5185657']],
    dci: 'Toxina Botulínica Tipo A (complexo Clostridium botulinum)',
    categoria: 'Dermatologia & Medicina Estética',
    subcategoria: 'Relaxantes Musculares de Ação Periférica',
    indicacoes_clinicas: 'Melhoria temporária do aspeto de linhas glabelares moderadas a graves (rugas de expressão) no adulto.',
    contraindicacoes_aviso: 'perturbações neuromusculares (miastenia gravis); infeção no local da injeção.'
  },
  {
    match: [/broncho-vaxom/i, ['5366505', '8529263']],
    dci: 'Lisados bacterianos liofilizados',
    categoria: 'Aparelho Respiratório & Imunologia',
    subcategoria: 'Imunoterapia / Estimulante do Sistema Imunitário',
    indicacoes_clinicas: 'Prevenção de infeções recorrentes das vias respiratórias e exacerbações infeciosas na bronquite crónica.',
    contraindicacoes_aviso: 'doenças autoimunes; reações alérgicas gastrointestinais.'
  },
  {
    match: [/corega/i, ['6005942', '6005934', '6005959']],
    dci: 'Fixativo de Prótese Dentária (Sem Zinco)',
    categoria: 'Higiene & Saúde Oral',
    subcategoria: 'Adesivos e Cuidados com Próteses Dentárias',
    indicacoes_clinicas: 'Fixação firme e duradoura de próteses dentárias, bloqueando a entrada de partículas de comida sob a prótese.',
    contraindicacoes_aviso: 'não usar se hipersensibilidade aos componentes.'
  },
  {
    match: [/freestyle libre/i, ['7131433', '7091413']],
    dci: 'Sensor de Monitorização Contínua de Glicose Intersticial',
    categoria: 'Dispositivos Médicos & Diabetes',
    subcategoria: 'Dispositivos de Diagnóstico In Vitro / Sensores de Glicose',
    indicacoes_clinicas: 'Medição contínua dos níveis de glicose no líquido intersticial em pessoas com Diabetes Mellitus (a partir dos 4 anos).',
    contraindicacoes_aviso: 'remover antes de exames de ressonância magnética (RMN), TAC ou diatermia.'
  },
  {
    match: [/\bbialzepam\b/i, ['9093849', '4535399', '9286831', '4535597', '9093856', '9093864']],
    dci: 'Diazepam',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Ansiolíticos, Sedativos e Hipnóticos (Benzodiazepinas)',
    indicacoes_clinicas: 'Tratamento sintomático da ansiedade, espasticidade muscular e privação alcoólica.'
  },
  {
    match: [/\bbialminal\b/i, ['9901231']],
    dci: 'Fenobarbital',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Antiepiléticos e Anticonvulsivantes (Barbitúricos)',
    indicacoes_clinicas: 'Tratamento da epilepsia (crises generalizadas tónico-clónicas e parciais).'
  },
  {
    match: [/\bsedoxil\b/i, ['5459037', '5459011']],
    dci: 'Mexazolam',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Ansiolíticos, Sedativos e Hipnóticos (Benzodiazepinas)',
    indicacoes_clinicas: 'Ansiedade e perturbações psicossomáticas associadas.'
  },
  {
    match: [/\bmigretil\b/i, ['5374749']],
    dci: 'Ergotamina + Cafeína + Paracetamol + Beladona',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Antienxaquecosos',
    indicacoes_clinicas: 'Tratamento agudo das crises de enxaqueca e cefaleias vasculares.'
  },
  {
    match: [/\bedistride\b/i, ['5764410']],
    dci: 'Dapagliflozina',
    categoria: 'Endocrinologia & Diabetes',
    subcategoria: 'Antidiabéticos Orais (Inibidores SGLT2)',
    indicacoes_clinicas: 'Diabetes mellitus tipo 2, insuficiência cardíaca crónica e doença renal crónica.'
  },
  {
    match: [/\bebymect\b/i, ['5764337']],
    dci: 'Dapagliflozina + Metformina',
    categoria: 'Endocrinologia & Diabetes',
    subcategoria: 'Antidiabéticos Orais em Associação',
    indicacoes_clinicas: 'Tratamento da diabetes mellitus tipo 2 no adulto.'
  },
  {
    match: [/\brinialer\b/i, ['3843687']],
    dci: 'Rupatadina',
    categoria: 'Alergias & Aparelho Respiratório',
    subcategoria: 'Anti-histamínicos H1 Não Sedativos',
    indicacoes_clinicas: 'Tratamento sintomático da rinite alérgica e urticária.'
  },
  {
    match: [/\bclavamox\b/i, ['9766105']],
    dci: 'Amoxicilina + Ácido Clavulânico',
    categoria: 'Anti-infeciosos',
    subcategoria: 'Antibacterianos (Penicilinas com Inibidor das Beta-lactamases)',
    indicacoes_clinicas: 'Tratamento de infeções bacterianas (vias respiratórias, urinárias, pele e tecidos moles).'
  },
  {
    match: [/\bfolicil\b/i, ['5790597']],
    dci: 'Ácido Fólico',
    categoria: 'Sangue & Hematologia',
    subcategoria: 'Antianémicos (Vitamina B9)',
    indicacoes_clinicas: 'Prevenção e tratamento de estados de carência de ácido fólico e defeitos do tubo neural na gravidez.'
  },
  {
    match: [/\belvanse\b/i, ['5674718', '5674676']],
    dci: 'Lisdexanfetamina',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Psicoestimulantes (PHDA)',
    indicacoes_clinicas: 'Perturbação de Hiperatividade e Défice de Atenção (PHDA).'
  },
  {
    match: [/\bbronxol\b/i, ['5161690']],
    dci: 'Ambroxol',
    categoria: 'Gripes & Vias Respiratórias',
    subcategoria: 'Expectorantes e Mucolíticos',
    indicacoes_clinicas: 'Adjuvante mucolítico do tratamento antibacteriano das infeções respiratórias em presença de hipersecreção brônquica.'
  },
  {
    match: [/\brantudil\b/i, ['9661637', '9510735']],
    dci: 'Acemetacina',
    categoria: 'Aparelho Locomotor',
    subcategoria: 'Anti-inflamatórios Não Esteroides (AINE)',
    indicacoes_clinicas: 'Processos inflamatórios e dolorosos reumatismais e pós-traumáticos.'
  },
  {
    match: [/\breumon\b/i, ['5799523']],
    dci: 'Etofenamato',
    categoria: 'Aparelho Locomotor',
    subcategoria: 'Anti-inflamatórios Não Esteroides Tópicos',
    indicacoes_clinicas: 'Dores musculares, articulares, contusões e afeções reumatismais.'
  },
  {
    match: [/\bdeltius\b/i, ['5768619']],
    dci: 'Colecalciferol (Vitamina D3)',
    categoria: 'Endocrinologia & Vitaminas',
    subcategoria: 'Vitamina D',
    indicacoes_clinicas: 'Prevenção e tratamento da deficiência de vitamina D.'
  },
  {
    match: [/\bdiplexil\b/i, ['9376004']],
    dci: 'Valproato Semissódico',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Antiepiléticos e Estabilizadores de Humor',
    indicacoes_clinicas: 'Tratamento de episódios maníacos na perturbação bipolar e epilepsia.'
  },
  {
    match: [/\bzarelix\b/i, ['5058318']],
    dci: 'Venlafaxina',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Antidepressivos (IRSN)',
    indicacoes_clinicas: 'Tratamento de episódios depressivos major e perturbações de ansiedade.'
  },
  {
    match: [/\bbridic\b/i, ['3958386']],
    dci: 'Trimebutina',
    categoria: 'Gastroenterologia & Digestivo',
    subcategoria: 'Antiespasmódicos e Reguladores da Motilidade',
    indicacoes_clinicas: 'Tratamento sintomático da síndrome do intestino irritável e perturbações funcionais digestivas.'
  },
  {
    match: [/\bbelara\b/i, ['5503586']],
    dci: 'Clormadinona + Etinilestradiol',
    categoria: 'Ginecologia & Saúde da Mulher',
    subcategoria: 'Contraceptivos Hormonais Orais',
    indicacoes_clinicas: 'Contraceção hormonal oral.'
  },
  {
    match: [/\blyrica\b/i, ['5134184']],
    dci: 'Pregabalina',
    categoria: 'Sistema Nervoso Central',
    subcategoria: 'Antiepiléticos / Dor Neuropática',
    indicacoes_clinicas: 'Dor neuropática periférica e central, epilepsia e perturbação de ansiedade generalizada.'
  },
  {
    match: [/\bolmetec\b/i, ['4729281']],
    dci: 'Olmesartan medoxomilo',
    categoria: 'Aparelho Cardiovascular',
    subcategoria: 'Anti-hipertensores (ARA II)',
    indicacoes_clinicas: 'Tratamento da hipertensão arterial essencial.'
  }
];

export async function enrichProductCatalogWithClinicalData(prisma: PrismaClient) {
  let updatedCount = 0;
  const allProds = await prisma.produtoMestre.findMany({
    select: { cnp_codigo: true, designacao: true }
  });

  for (const mapping of CLINICAL_MAPPINGS) {
    const [regex, cnps] = Array.isArray(mapping.match) ? mapping.match : [mapping.match, []];
    const matchedCnps: string[] = [];

    for (const p of allProds) {
      let matches = false;
      if (Array.isArray(cnps) && (cnps as string[]).includes(p.cnp_codigo)) matches = true;
      if (regex instanceof RegExp && regex.test(p.designacao)) matches = true;
      if (matches) matchedCnps.push(p.cnp_codigo);
    }

    if (matchedCnps.length > 0) {
      await prisma.produtoMestre.updateMany({
        where: { cnp_codigo: { in: matchedCnps } },
        data: {
          dci: mapping.dci,
          categoria: mapping.categoria,
          subcategoria: mapping.subcategoria,
          indicacoes_clinicas: mapping.indicacoes_clinicas,
          ...(mapping.contraindicacoes_aviso ? { contraindicacoes_aviso: mapping.contraindicacoes_aviso } : {}),
          fonte_enriquecimento: 'INFARMED_CFT_CLINICO_OFICIAL'
        }
      });
      await prisma.martProdutoMetricas.updateMany({
        where: { cnp_codigo: { in: matchedCnps } },
        data: {
          molecula_dci: mapping.dci,
          categoria: mapping.categoria,
          subcategoria: mapping.subcategoria
        }
      });
      updatedCount += matchedCnps.length;
    }
  }
  return updatedCount;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  enrichProductCatalogWithClinicalData(prisma)
    .then(n => console.log(`Enriquecidos ${n} registos clínicos no ProdutoMestre!`))
    .finally(() => prisma.$disconnect());
}
