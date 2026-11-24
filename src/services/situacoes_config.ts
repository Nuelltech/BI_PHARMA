/**
 * situacoes_config.ts — Catálogo de situações do utente (v1 para revisão da DT)
 *
 * Subcategorias escritas como em ProdutoMestre.subcategoria (export A2), validadas contra o stock
 * da Farmácia A (Q5, 24/11/2026). Comparação por slug: acentos, maiúsculas e '&' não contam.
 * Os textos "textoUtente" são para o card e para a etiqueta — linguagem comum, sem jargão.
 *
 * Fora daqui, de propósito:
 *  - "liquidacao_validades_monos" não é uma situação: o escoamento já é a 1.ª prioridade da
 *    ordenação (ORDEM_ESCOAMENTO). Produtos a escoar entram nos packs onde fazem sentido.
 *    O que sobrar vai para uma lista de descontos individuais, não para um pack.
 *  - Tiras/lancetas de glicemia: margem baixa e são material de controlo, não de impulso.
 */

import { Situacao } from './situacoes_packs';

export const SITUACOES: Situacao[] = [
  // ═════════════════ FRIO / PELE ═════════════════
  {
    id: 'maos_labios_gretados',
    campanhas: ['pele_seca_frio', 'natal_coffrets'],
    titulo: 'Kit Mãos e Lábios contra o Frio',
    queixa: 'Mãos secas ou gretadas e lábios com cieiro por causa do frio e do vento',
    perguntaBalcao: 'Tem sentido as mãos ou os lábios a gretar com este frio?',
    publico: 'ADULTO',
    margemMinimaPackPct: 25,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Hidratante para as mãos'], textoUtente: 'Repara e protege as mãos secas e gretadas' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Protector labial sem factor protecção', 'Protector labial com factor protecção'], textoUtente: 'Alivia e repara os lábios gretados' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Emolientes e Protectores', 'Hidratante corporal'], textoUtente: 'Hidrata o corpo depois do banho' },
    ],
  },
  {
    id: 'pele_atopica_inverno',
    campanhas: ['pele_seca_frio'],
    titulo: 'Kit Pele Muito Seca / Atópica',
    queixa: 'Pele muito seca, que repuxa, descama ou dá comichão no inverno',
    perguntaBalcao: 'A pele anda a repuxar ou com comichão depois do banho?',
    publico: 'ADULTO',
    margemMinimaPackPct: 25,
    preferirMesmaMarca: true,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Pele Seca & Atópica', 'Emolientes e Protectores'], textoUtente: 'Creme que repara a barreira da pele muito seca' },
      { papel: 'APOIO', obrigatorio: false, subcategorias: ['Antipruriginosos'], textoUtente: 'Acalma a comichão' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: true, subcategorias: ['Higiene corporal banho'], termosExcluir: ['perfum', 'esfolia'], textoUtente: 'Gel de banho suave que não seca a pele' },
    ],
  },

  // ═════════════════ GRIPE / CONSTIPAÇÃO ═════════════════
  {
    id: 'nariz_garganta_constipacao',
    campanhas: ['imunidade_inverno'],
    titulo: 'Kit Constipação: Nariz e Garganta',
    queixa: 'Nariz entupido e garganta irritada de constipação',
    perguntaBalcao: 'É mais nariz entupido, garganta, ou as duas coisas?',
    publico: 'ADULTO',
    margemMinimaPackPct: 25,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Preparações nasais de água do mar', 'Descongestionantes Nasais'], textoUtente: 'Limpa e desentope o nariz' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Inflamação e Dor de Garganta'], textoUtente: 'Alivia a dor e irritação da garganta' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Imunoestimulante para a Constipação', 'Preparações imunológicas e anti-oxidantes', 'Vitamina C'], textoUtente: 'Ajuda as defesas durante a recuperação' },
    ],
  },
  {
    id: 'tosse',
    campanhas: ['imunidade_inverno'],
    titulo: 'Kit Tosse',
    queixa: 'Tosse que não deixa descansar, com garganta irritada',
    // Só UM produto de tosse: o lugar PRINCIPAL aceita 1 item → nunca junta tosse seca + expectorante
    perguntaBalcao: 'A tosse é seca ou tem expetoração? (o farmacêutico escolhe o xarope certo)',
    publico: 'ADULTO',
    margemMinimaPackPct: 25,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Tosse Seca', 'Tosse Produtiva / Expectorantes', 'Antitússicos'], textoUtente: 'Para a tosse (xarope, spray ou rebuçados)' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Inflamação e Dor de Garganta'], textoUtente: 'Acalma a garganta irritada pela tosse' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Imunoestimulante para a Constipação', 'Preparações imunológicas e anti-oxidantes', 'Vitamina C'], textoUtente: 'Ajuda as defesas' },
    ],
  },

  // ═════════════════ DIABETES / PÉS ═════════════════
  {
    id: 'cuidado_pes',
    campanhas: ['dia_diabetes'],
    titulo: 'Kit Cuidado dos Pés',
    queixa: 'Pés secos, calcanhares gretados ou calos — essencial para quem tem diabetes',
    perguntaBalcao: 'Costuma ter os calcanhares secos ou gretados?',
    publico: 'ADULTO',
    margemMinimaPackPct: 25,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Hidratante dos pés'], textoUtente: 'Creme que hidrata e evita gretas nos pés' },
      { papel: 'APOIO', obrigatorio: false, subcategorias: ['Tratamento e proteção calos', 'Utensílio de beleza para pés'], textoUtente: 'Trata e protege calos e zonas duras' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Desodorizante e antitranspirante dos pés e sapatos'], textoUtente: 'Higiene e frescura diária dos pés' },
    ],
  },

  // ═════════════════ NOVEMBRO AZUL ═════════════════
  {
    id: 'homem_50',
    campanhas: ['novembro_azul'],
    titulo: 'Kit Homem 50+',
    queixa: 'Saúde urinária e prevenção a partir dos 50 anos',
    perguntaBalcao: 'Já fez este ano o check-up da próstata?',
    publico: 'ADULTO',
    margemMinimaPackPct: 25,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Sistema Urinário'], termosExcluir: ['mulher', 'cranberry', 'arando'], textoUtente: 'Apoio ao conforto urinário e à próstata' },
      { papel: 'APOIO', obrigatorio: false, subcategorias: ['Multivitaminas', 'Multivitamínicos', 'Redutores do colesterol e triglicéridos'], textoUtente: 'Vitaminas / coração em dia' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Anti transpirante e desodorizante homem', 'Para o barbear homem', 'Após o barbear homem', 'Hidratante e tonificante homem'], textoUtente: 'Cuidado diário masculino' },
    ],
  },

  // ═════════════════ OUTONO / CABELO ═════════════════
  {
    id: 'queda_cabelo',
    campanhas: ['outono_queda_capilar'],
    titulo: 'Kit Queda de Cabelo de Outono',
    queixa: 'Cabelo a cair mais do que o normal nesta altura do ano',
    perguntaBalcao: 'Tem notado mais cabelo na almofada ou na escova?',
    publico: 'ADULTO',
    margemMinimaPackPct: 25,
    preferirMesmaMarca: true,
    lugares: [
      // Na Farmácia A só há 2 suplementos capilares em stock → o tratamento tópico passa a principal
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Cuidado Capilar & Antiqueda'], termosObrigatorios: ['locao', 'ampola', 'serum', 'spray', 'antiqueda', 'anti-queda', 'queda'], termosExcluir: ['piolh', 'lanceta', 'lendea', 'champo', 'shampoo'], textoUtente: 'Tratamento antiqueda aplicado no couro cabeludo' },
      { papel: 'APOIO', obrigatorio: false, subcategorias: ['Fortalecedor de cabelo e unhas', 'Fortalecedor de unhas'], textoUtente: 'Suplemento que fortalece cabelo e unhas por dentro' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Cuidado Capilar & Antiqueda', 'Higiene capilar (champôs)'], termosObrigatorios: ['champo', 'shampoo', ' ch '], termosExcluir: ['piolh', 'lanceta', 'lendea'], textoUtente: 'Champô para lavar sem enfraquecer o cabelo' },
    ],
  },

  // ═════════════════ BLACK FRIDAY ═════════════════
  {
    id: 'rotina_rosto',
    campanhas: ['black_friday'],
    titulo: 'Rotina de Rosto em 3 Passos',
    queixa: 'Quer começar (ou completar) uma rotina simples para o rosto',
    perguntaBalcao: 'Que creme usa hoje no rosto? Limpa a pele antes?',
    publico: 'ADULTO',
    margemMinimaPackPct: 30,
    preferirMesmaMarca: true,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Anti envelhecimento e anti rugas mulher', 'Hidratante facial pele sensível mulher', 'Hidratante facial pele normal mulher', 'Hidratante facial pele seca mulher', 'Hidratante facial pele mista e normal mulher', 'Anti vermelhidão facial mulher'], textoUtente: 'Passo 2 — Creme de rosto' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Higiene facial mulher', 'Água termal facial mulher'], textoUtente: 'Passo 1 — Limpar o rosto' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Protector facial mulher'], textoUtente: 'Passo 3 — Proteger do sol (também no inverno)' },
    ],
  },
  {
    id: 'sorriso',
    campanhas: ['black_friday', 'natal_coffrets'],
    titulo: 'Kit Sorriso',
    queixa: 'Renovar a higiene oral de casa',
    perguntaBalcao: 'Há quanto tempo trocou a escova de dentes?',
    publico: 'ADULTO',
    margemMinimaPackPct: 30,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Escova dentária para adultos'], textoUtente: 'Escova nova (trocar a cada 3 meses)' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Dentífrico para adultos'], textoUtente: 'Pasta de dentes' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Elixir para adultos', 'Acessórios de higiene oral'], textoUtente: 'Elixir ou fio dentário para completar' },
    ],
  },

  // ═════════════════ NATAL ═════════════════
  {
    id: 'presente_ela',
    campanhas: ['natal_coffrets'],
    titulo: 'Presente de Natal — Mimo para Ela',
    queixa: 'Procura um presente útil e de cuidado pessoal',
    perguntaBalcao: 'É para oferecer? Prefere algo de corpo ou de rosto?',
    publico: 'ADULTO',
    margemMinimaPackPct: 30,
    preferirMesmaMarca: true,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Hidratante corporal', 'Perfume mulher'], textoUtente: 'Cuidado de corpo / fragrância' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Hidratante para as mãos'], textoUtente: 'Creme de mãos para a mala' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Protector labial sem factor protecção'], textoUtente: 'Pequeno extra de cuidado' },
    ],
  },
  {
    id: 'presente_ele',
    campanhas: ['natal_coffrets'],
    titulo: 'Presente de Natal — Cuidado para Ele',
    queixa: 'Procura um presente útil e de cuidado pessoal masculino',
    perguntaBalcao: 'É para oferecer a um homem? Faz a barba?',
    publico: 'ADULTO',
    margemMinimaPackPct: 30,
    preferirMesmaMarca: true,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Para o barbear homem', 'Perfume homem', 'Anti envelhecimento anti rugas homem'], textoUtente: 'Barbear / fragrância' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Após o barbear homem', 'Hidratante e tonificante homem'], textoUtente: 'Hidrata e acalma a pele depois da barba' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Anti transpirante e desodorizante homem'], textoUtente: 'Desodorizante' },
    ],
  },
  {
    id: 'presente_bebe',
    campanhas: ['natal_coffrets'],
    titulo: 'Presente de Natal — Bebé',
    queixa: 'Presente prático para um bebé ou para os pais',
    perguntaBalcao: 'É para um recém-nascido ou um bebé mais crescido?',
    publico: 'PEDIATRICO',
    margemMinimaPackPct: 25,
    preferirMesmaMarca: true,
    lugares: [
      { papel: 'PRINCIPAL', obrigatorio: true, subcategorias: ['Coffret bebé', 'Hidratante corporal bebé'], textoUtente: 'Hidratação da pele do bebé' },
      { papel: 'APOIO', obrigatorio: true, subcategorias: ['Higiene do bebé no banho'], textoUtente: 'Banho suave do bebé' },
      { papel: 'CUIDADO_DIARIO', obrigatorio: false, subcategorias: ['Dermatite da fralda', 'Toalhete de limpeza bebé'], textoUtente: 'Proteção da zona da fralda' },
    ],
  },
];
