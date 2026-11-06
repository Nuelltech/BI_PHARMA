import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();

import {
  ToolSecurityContext,
  toolCalcularStockMinimoECobertura,
  toolFiltrarValidadeEMargem,
  toolSugerirPacksPromocionais,
  toolIdentificarProdutosSemVenda,
  toolConsultarProgressoTarefasEquipa,
  toolCriarTarefaEquipa,
  toolConsultarCampanhasAtivasEHistorico,
  toolAtivarCampanhaFarmacia,
  toolConsolidarGenericosDci,
  toolPlanearComprasSazonais,
  toolSugerirVendasCruzadasReceita,
  toolConsultarProdutosPorNomeOuCategoria,
  toolCompararSimilaresERentabilidade,
  toolAvaliarAcordoAnualComprasEscalonadas,
  toolCalcularNiveisSazonaisDinamicos,
  toolGerarPropostaEncomendaReposicao,
  toolAnalisarCurvaAbcFaturacaoEMargem,
  toolAuditarAnomaliasMargemEPrecos,
  toolConsultarVendasDiarias,
  toolAnalisarEvolucaoMensalFinanceira,
  toolCompararPerformancePeriodos,
  toolCalcularPerdasFinanceirasECustoOportunidade,
} from './mcp_pharma_tools.js';

// ============================================================================
// MOTOR CONVERSACIONAL COPILOT C/ MEMÓRIA E TOOL-CALLING MULTI-TENANT
// ----------------------------------------------------------------------------
// Suporta conversas encadeadas por sessão com Claude 3.5 / 4.5 / 5.5
// Garante que todas as ferramentas operam estritamente dentro da farmácia autenticada.
// ============================================================================

// Memória de sessão em RAM: sessionId -> Array de mensagens
const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: any }>>();

// Limpa sessões com mais de 3 horas para libertar memória
const sessionTimestamps = new Map<string, number>();

function pruneOldSessions() {
  const now = Date.now();
  const maxAge = 3 * 60 * 60 * 1000;
  for (const [id, ts] of sessionTimestamps.entries()) {
    if (now - ts > maxAge) {
      sessionHistory.delete(id);
      sessionTimestamps.delete(id);
    }
  }
}

export function clearCopilotSession(sessionId: string) {
  sessionHistory.delete(sessionId);
  sessionTimestamps.delete(sessionId);
}

const COPILOT_TOOLS = [
  {
    name: 'analisar_evolucao_mensal_financeira',
    description:
      'Analisa a evolução financeira temporal mês a mês da farmácia (13 meses de dados reais). Devolve para cada mês: faturação bruta total (€), custo de mercadorias (CMVMC), margem bruta em euros (€) e margem bruta percentual (%), total de embalagens vendidas, top 3 categorias e top produtos que mais geraram margem. Identifica o MELHOR MÊS em margem e faturação, o PIOR MÊS, a média mensal e a justificação analítica (fatores-chave: volume vs mix de produtos). Use SEMPRE esta ferramenta para responder a: "qual foi o mês que nos deu mais dinheiro/margem/lucro", "evolução das vendas por mês", "melhores meses da farmácia", etc.',
    input_schema: {
      type: 'object',
      properties: {
        ano: {
          type: 'string',
          description: 'Filtrar por ano específico (ex: "2026", "2025"). Se omitido, analisa todo o histórico disponível (13 meses).',
        },
        categoria_ou_macro: {
          type: 'string',
          description: 'Filtro opcional por macro área (ex: "MSRM", "MNSRM_OTC", "DERMOCOSMETICA", "NUTRICAO_SUPLEMENTOS").',
        },
        ordenar_por: {
          type: 'string',
          enum: ['CRONOLOGICO', 'MARGEM_EUR', 'FATURACAO_EUR', 'MARGEM_PCT'],
          description: 'Critério de ordenação dos meses (padrão: "CRONOLOGICO"). Escolha "MARGEM_EUR" para ver logo o ranking de meses mais rentáveis.',
        },
        top_produtos_qtd: {
          type: 'number',
          description: 'Quantidade de produtos em destaque por mês (padrão: 3).',
        },
      },
    },
  },
  {
    name: 'comparar_performance_periodos',
    description:
      'Compara a performance financeira detalhada entre dois meses específicos da farmácia (ex: "2026-07" vs "2026-06", ou "2026-08" vs "2026-07"). Devolve variação de faturação (€ e %), variação de margem bruta (€ e %), variação de unidades e pontos percentuais de margem, explicando as causas da subida ou descida.',
    input_schema: {
      type: 'object',
      properties: {
        periodo_a: {
          type: 'string',
          description: 'Mês principal a comparar no formato YYYY-MM (ex: "2026-07").',
        },
        periodo_b: {
          type: 'string',
          description: 'Mês base de comparação no formato YYYY-MM (ex: "2026-06").',
        },
      },
      required: ['periodo_a', 'periodo_b'],
    },
  },
  {
    name: 'calcular_perdas_financeiras_e_custo_oportunidade',
    description:
      'Calcula o impacto financeiro (€) de perdas operacionais e de tesouraria na farmácia: 1) Custo de oportunidade de vendas perdidas por rutura de stock nos produtos Classe A nos últimos 30 dias; 2) Capital imobilizado em monos (sem vendas há 12 meses); 3) Stock em risco de caducidade.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_auditoria: {
          type: 'string',
          enum: ['TODAS', 'RUTURAS_CLASSE_A', 'MONOS_CAPITAL_PARADO', 'VALIDADES_RISCO'],
          description: 'Tipo de auditoria financeira a realizar (padrão: "TODAS").',
        },
      },
    },
  },
  {
    name: 'consultar_vendas_diarias',
    description:
      'Consulta os registos de vendas granulares de um DIA ESPECÍFICO (ex: "2026-03-03") ou pesquisa por produto num dia. AVISO: Não use esta ferramenta para comparar meses inteiros ou analisar a evolução anual — para meses e margem temporal, use "analisar_evolucao_mensal_financeira".',
    input_schema: {
      type: 'object',
      properties: {
        data: {
          type: 'string',
          description: 'Data a pesquisar no formato YYYY-MM-DD (ex: "2026-03-03") ou termo livre de data (ex: "3 de março de 2026"). Se omitido, lista todas as datas diárias disponíveis com totais.',
        },
        cnp_ou_nome: {
          type: 'string',
          description: 'Filtro opcional por nome ou código CNP do produto.',
        },
        limite: {
          type: 'number',
          description: 'Número máximo de artigos a devolver (default 25).',
        },
      },
    },
  },
  {
    name: 'consultar_produtos_por_nome_ou_categoria',
    description:
      'Pesquisa e detalha produtos da farmácia por nome comercial, marca, substância DCI, código CNP ou categoria (ex: "ben-u-gripe", "cegripe", "strepsils", "brufen", "preservativos"). Devolve stock atual, vendas nos últimos 12 meses, VMM, HISTÓRICO REAL DE VENDAS MÊS A MÊS (historicoVendasMensais), vendas reais por estação (vendasPorEstacao), mês de pico, dias e meses de cobertura, margem comercial e parecer financeiro rigoroso sobre se se deve ou não encomendar.',
    input_schema: {
      type: 'object',
      properties: {
        termo_pesquisa: {
          type: 'string',
          description:
            'Nome do produto, marca, categoria ou código CNP a pesquisar (ex: "ben-u-gripe", "cegripe", "antigripais", "preservativos", "brufen")',
        },
        apenas_com_stock: {
          type: 'boolean',
          description: 'Filtrar apenas produtos que têm stock físico > 0 na farmácia',
        },
        limite: { type: 'number', description: 'Número máximo de registos a devolver (default 20)' },
      },
      required: ['termo_pesquisa'],
    },
  },
  {
    name: 'calcular_stock_minimo_e_cobertura',
    description:
      'Calcula o stock mínimo necessário e os dias de cobertura para um período pretendido (ex: 7 dias / 1 semana). Identifica produtos abaixo do mínimo (risco de rutura) e produtos em excesso.',
    input_schema: {
      type: 'object',
      properties: {
        dias_cobertura_desejados: {
          type: 'number',
          description: 'Número de dias de cobertura pretendidos (default 7 para 1 semana)',
        },
        apenas_abaixo_minimo: {
          type: 'boolean',
          description: 'Filtrar apenas artigos com stock abaixo do mínimo sugerido',
        },
        termo_pesquisa: {
          type: 'string',
          description: 'Filtro opcional por nome ou código do produto',
        },
        limite: { type: 'number', description: 'Número máximo de registos (default 25)' },
      },
    },
  },
  {
    name: 'filtrar_produtos_por_validade_e_margem',
    description:
      'Filtra produtos com data de validade até um determinado ano (ex: 2027) e simula o PVP promocional mínimo garantindo que a margem comercial não fica abaixo do limiar (ex: 10%), respeitando o anti-dumping.',
    input_schema: {
      type: 'object',
      properties: {
        ano_limite_validade: {
          type: 'number',
          description: 'Ano limite de validade a pesquisar (ex: 2027)',
        },
        margem_minima_pct: {
          type: 'number',
          description: 'Margem de lucro mínima tolerada em % (ex: 10.0)',
        },
        apenas_venda_livre: {
          type: 'boolean',
          description: 'Filtrar apenas produtos de venda livre / balcão (default true)',
        },
        limite: { type: 'number', description: 'Número máximo de registos (default 30)' },
      },
    },
  },
  {
    name: 'sugerir_packs_promocionais',
    description:
      'Cria e sugere packs promocionais de 2 a 3 produtos onde a margem global do pack e dos artigos cumpre o mínimo definido (ex: 5%), indicando PVP normal, PVP promocional e poupança do cliente.',
    input_schema: {
      type: 'object',
      properties: {
        tamanho_pack: {
          type: 'number',
          description: 'Número de artigos por pack (2 ou 3)',
        },
        margem_minima_pack_pct: {
          type: 'number',
          description: 'Margem mínima garantida do pack em % (ex: 5.0)',
        },
        ano_limite_validade: {
          type: 'number',
          description: 'Ano limite de validade para escoar nos packs (default 2027)',
        },
        limite: { type: 'number', description: 'Número de packs a sugerir' },
      },
    },
  },
  {
    name: 'identificar_produtos_sem_vendas_e_escoamento',
    description:
      'Lista produtos com stock parado na farmácia sem qualquer venda nos últimos N meses (Monos). Permite filtrar estritamente por Restos de Gaveta (stock <= 2 unidades órfãs) quando o utilizador perguntar por restos de gaveta.',
    input_schema: {
      type: 'object',
      properties: {
        meses_sem_venda: {
          type: 'number',
          description: 'Número de meses sem vendas a considerar (default 6)',
        },
        apenas_com_stock: {
          type: 'boolean',
          description: 'Considerar apenas produtos com unidades físicas em armazém (default true)',
        },
        apenas_restos_gaveta: {
          type: 'boolean',
          description:
            'OBRIGATÓRIO true se o utilizador perguntar por "restos de gaveta" ou "produtos com 1 ou 2 unidades": filtra estritamente produtos com stock <= 2 unidades.',
        },
        limite: { type: 'number', description: 'Número máximo de registos (default 30)' },
      },
    },
  },
  {
    name: 'analisar_consolidacao_genericos_dci',
    description:
      'Analisa a dispersão de laboratórios para a mesma substância ativa e dosagem (DCI). Compara com o número máximo de laboratórios pretendido e indica quais as marcas residuais no fundo da gaveta que devem ser esgotadas antes de encomendar novo stock.',
    input_schema: {
      type: 'object',
      properties: {
        molecula_dci: {
          type: 'string',
          description: 'Filtrar por molécula específica (opcional, ex: Atorvastatina, Paracetamol, etc.)',
        },
        max_labs_desejados: {
          type: 'number',
          description: 'Número máximo de laboratórios que a farmácia pretende manter abertos (default 2)',
        },
        limite: { type: 'number', description: 'Máximo de grupos DCI a devolver' },
      },
    },
  },
  {
    name: 'planear_compras_sazonais_laboratorio',
    description:
      'Gera o plano anual de compras diretas a laboratórios baseado no histórico de vendas e sazonalidade da farmácia, indicando as datas recomendadas de encomenda e as datas ideais de entrega física.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_venda: {
          type: 'string',
          description: 'Segmento a analisar (default VENDA_LIVRE)',
        },
        ano_referencia: {
          type: 'number',
          description: 'Ano de referência para planeamento',
        },
      },
    },
  },
  {
    name: 'sugerir_vendas_cruzadas_receita',
    description:
      'Para as moléculas sujeitas a receita médica (MSRM) mais vendidas na farmácia, sugere produtos complementares de venda livre e aconselhamento de balcão para prevenir efeitos adversos e melhorar o cuidado ao utente.',
    input_schema: {
      type: 'object',
      properties: {
        top_n_moleculas: {
          type: 'number',
          description: 'Número de moléculas mais vendidas a analisar (default 5)',
        },
      },
    },
  },
  {
    name: 'comparar_similares_e_rentabilidade',
    description:
      'Compara medicamentos similares, genéricos ou de mesma indicação terapêutica (ex: Atorvastatina, Pantoprazol, Ibuprofeno). Revela quem vende mais vs quem liberta mais lucro em Euros (€/unidade) e margem %, identificando oportunidades de troca favorável de marca na gaveta.',
    input_schema: {
      type: 'object',
      properties: {
        termo_pesquisa: {
          type: 'string',
          description: 'Molécula DCI, nome do medicamento ou classe (ex: "atorvastatina", "pantoprazol", "ibuprofeno", "strepsils")',
        },
        apenas_com_stock: {
          type: 'boolean',
          description: 'Filtrar apenas artigos que têm stock físico na farmácia',
        },
        limite: { type: 'number', description: 'Número máximo de registos (default 15)' },
      },
      required: ['termo_pesquisa'],
    },
  },
  {
    name: 'avaliar_acordo_anual_compras_escalonadas',
    description:
      'Avalia o histórico real de vendas de uma marca ou gama nos últimos 12 meses (mês a mês) para negociar acordos diretos com laboratórios. Sugere o volume anual máximo seguro (com margem de prudência) e divide a encomenda em 3 a 4 tranches escalonadas ajustadas aos meses em que o produto realmente sai.',
    input_schema: {
      type: 'object',
      properties: {
        marca_ou_laboratorio: {
          type: 'string',
          description: 'Nome da marca, laboratório ou gama a avaliar (ex: "Strepsils", "Cêgripe", "Generis", "La Roche Posay")',
        },
        margem_seguranca_pct: {
          type: 'number',
          description: 'Percentagem de segurança para não inflacionar compras (default 15%)',
        },
        numero_tranches: {
          type: 'number',
          description: 'Número de tranches de entrega (3 ou 4, default 3)',
        },
      },
      required: ['marca_ou_laboratorio'],
    },
  },
  {
    name: 'calcular_niveis_sazonais_dinamicos',
    description:
      'Calcula stocks mínimos, pontos de encomenda e stocks máximos viáveis adaptados à FASE ATUAL da estação (Entrada de Época, Pico, Fim de Estação ou Fora de Época). Evita ruturas no arranque e evita que sobrem embalagens no fim da época.',
    input_schema: {
      type: 'object',
      properties: {
        termo_pesquisa: {
          type: 'string',
          description: 'Categoria ou gama a analisar (ex: "antigripais", "strepsils", "cegripe", "solar", "alergias")',
        },
      },
      required: ['termo_pesquisa'],
    },
  },
  {
    name: 'gerar_proposta_encomenda_reposicao',
    description:
      'Gera a proposta de carrinho semanal ou quinzenal de compras para os produtos em risco de rutura, calculando as quantidades necessárias e o investimento financeiro total em Euros (€).',
    input_schema: {
      type: 'object',
      properties: {
        dias_cobertura_desejados: {
          type: 'number',
          description: 'Número de dias a cobrir (7 para reposição semanal, 14 para quinzenal)',
        },
        apenas_venda_regular: {
          type: 'boolean',
          description: 'Excluir artigos esporádicos com menos de 6 vendas no ano (default true)',
        },
        limite: { type: 'number', description: 'Número máximo de produtos na lista (default 30)' },
      },
    },
  },
  {
    name: 'analisar_curva_abc_faturacao_e_margem',
    description:
      'Aplica o Princípio de Pareto para identificar os produtos Classe A (os ~20% que geram 80% do negócio da farmácia). Audita se algum destes produtos vitais está com stock em risco de rutura.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_curva: {
          type: 'string',
          enum: ['FATURACAO', 'MARGEM'],
          description: 'Classificar por Faturação ou por Lucro Bruto (Margem)',
        },
        top_n: { type: 'number', description: 'Número de produtos a devolver no ranking (default 25)' },
      },
    },
  },
  {
    name: 'auditar_anomalias_margem_e_precos',
    description:
      'Audita o catálogo à procura de anomalias graves: produtos com margem negativa (PVP < Custo - venda com prejuízo!), margem excessivamente baixa (< 5%) ou erros cadastrais de preço.',
    input_schema: {
      type: 'object',
      properties: {
        margem_minima_alerta_pct: {
          type: 'number',
          description: 'Limiar mínimo de margem aceitável (default 5.0%)',
        },
        limite: { type: 'number', description: 'Máximo de anomalias a listar (default 30)' },
      },
    },
  },
  {
    name: 'consultar_progresso_tarefas_equipa',
    description:
      'Consulta o estado de progresso da Folha de Ações da Semana da equipa (quantas tarefas já foram concluídas, pendentes por área, colaboradores que mais concluíram tarefas e tarefas urgentes de caducidade ou stock parado).',
    input_schema: {
      type: 'object',
      properties: {
        semana: { type: 'string', description: 'Chave da semana no formato YYYY-Www (opcional, default semana atual)' },
        apenas_pendentes: { type: 'boolean', description: 'Se true, devolve apenas as tarefas ainda não concluídas (default false)' },
        limite: { type: 'number', description: 'Número máximo de tarefas a listar (default 20)' },
      },
    },
  },
  {
    name: 'criar_tarefa_equipa',
    description:
      'Cria uma nova tarefa operacional diretamente na Folha da Semana da Equipa e na interface mobile (ex: auditar prateleira, verificar lote, negociar com armazenista).',
    input_schema: {
      type: 'object',
      required: ['descricao'],
      properties: {
        descricao: { type: 'string', description: 'Descrição clara e acionável da tarefa para a equipa' },
        categoria: { type: 'string', description: 'Categoria da tarefa (ex: BALCAO, GAVETA, COMPRAS, DIRECAO_TECNICA)' },
        cnp_codigo: { type: 'string', description: 'CNP do produto associado, se aplicável' },
        valor_impacto: { type: 'number', description: 'Valor financeiro em risco ou de impacto em euros (€)' },
      },
    },
  },
  {
    name: 'consultar_campanhas_ativas_e_historico',
    description:
      'Consulta que campanhas promocionais de época ou liquidação estão ATIVAS na farmácia neste momento, com as datas de início/fim, produtos selecionados com preços promocionais com margem e sugestões do mês.',
    input_schema: {
      type: 'object',
      properties: {
        incluir_historico: { type: 'boolean', description: 'Se true, inclui campanhas já concluídas anteriormente (default false)' },
      },
    },
  },
  {
    name: 'ativar_campanha_farmacia',
    description:
      'Cria e ativa formalmente uma campanha promocional na farmácia (seja uma campanha do calendário sazonal, seja uma campanha personalizada à medida para qualquer evento, validades curtas, monos ou produtos específicos). Grava a campanha como ativa e gera automaticamente as tarefas operacionais (montra/cesto, script verbal e bloqueio no Sifarma) na Folha da Semana da Equipa.',
    input_schema: {
      type: 'object',
      properties: {
        campanha_id: { type: 'string', description: 'ID da campanha (ex: inverno_barreira_cutanea, liquidacao_destrava_monos, ou "custom" para uma campanha criada à medida)' },
        titulo: { type: 'string', description: 'Título personalizado da campanha (ex: "Oportunidades de Inverno", "Especial Black Friday", "Promoção Antigrippine")' },
        tema_ou_evento: { type: 'string', description: 'Tema, evento ou palavras-chave para o algoritmo selecionar produtos (ex: "halloween", "black_friday", "aniversario_farmacia", "tosse", "vitamina c")' },
        produtos_cnps: { type: 'array', items: { type: 'string' }, description: 'Lista de CNPs de produtos específicos a incluir na campanha (opcional)' },
        foco_stock: { type: 'string', enum: ['TODOS_ELEGIVEIS', 'PRIORIDADE_VALIDADES_MONOS', 'SO_VALIDADES_E_MONOS'], description: 'Critério de seleção de stock' },
        desconto_pct: { type: 'number', description: 'Percentagem de desconto promocional a aplicar (default 15)' },
        dias_duracao: { type: 'number', description: 'Duração da campanha em dias (default 15)' },
      },
    },
  },
];

const SYSTEM_PROMPT = `És o Consultor Farmacêutico & Copilot Analítico da Farmácia.
A tua missão é apoiar o Diretor Técnico e o Gestor da Farmácia a tomar decisões financeiras, operacionais e clínicas inteligentes com base EXCLUSIVAMENTE nos dados reais da farmácia.

DIRETRIZES DE COMUNICAÇÃO:
1. Sê claro, rigoroso e profissional. Responde em Português de Portugal com terminologia farmacêutica correta (Sifarma, DCI, MSRM, MNSRM, PVP, Margem, Cobertura, etc.).
2. FLEXIBILIDADE DE FORMATO:
   - Se o utilizador pedir TAREFAS ou PLANO DE AÇÃO: formata em caixas de seleção interativas (\`- [ ] Tarefa\`), divididas por área (Balcão, Gaveta, Compras).
   - Se pedir DADOS NUMÉRICOS OU LISTAGENS: cria tabelas Markdown limpas e organizadas.
   - Se pedir ESTRATÉGIA ou PARECER: escreve um parecer executivo estruturado com introdução, passos práticos e justificação financeira.
3. CONVERSAÇÃO ENCADEADA (MEMÓRIA):
   - Lembra-te do que foi falado anteriormente na sessão. Se o utilizador disser "E desses produtos, cria um plano..." ou "Desses, filtra os que têm...", refere-te aos produtos identificados na resposta anterior.
4. RIGOR DOS DADOS (TOOL USE):
   - Usa SEMPRE as ferramentas disponíveis para obter os números reais. Nunca inventes quantidades de stock, nem vendas, nem margens fictícias.
   - Explica o porquê dos cálculos (ex: "Stock mínimo calculado com base na Venda Média Mensal de 30 dias com margem de segurança de 20%").

4.1. REGRA DE OURO — HONESTIDADE INTELECTUAL & PROIBIÇÃO DE PIVOT/DESVIAR O ASSUNTO (NUNCA INVENTAR):
   - O Copilot é uma ferramenta de rigor analítico para a Direção Técnica e Financeira da Farmácia.
   - PROIBIÇÃO ABSOLUTA DE DESVIAR/PIVOTAR: Quando o utilizador fizer uma pergunta específica (por exemplo, "qual foi o mês que nos deu mais dinheiro em margem e porquê?", "qual o valor faturado no dia X?", "comparar julho com agosto", "qual o lucro do trimestre"):
     a) Responde ESTRITAMENTE à pergunta feita utilizando as ferramentas financeiras analíticas ('analisar_evolucao_mensal_financeira', 'comparar_performance_periodos', 'calcular_perdas_financeiras_e_custo_oportunidade', etc.).
     b) Se os dados solicitados não existirem no sistema (ex: dia sem vendas diárias ou parâmetro não registado), ASSUME COM TOTAL CLAREZA E SUCINTAMENTE A LIMITAÇÃO.
     c) É ESTRITAMENTE PROIBIDO "desconversar", mudar de assunto ou debitar relatórios não solicitados (por exemplo, começar a despejar a Curva ABC de 12 meses, falar de Mounjaro/Neparvis, ou listar ruturas de stock) para disfarçar que não tens a resposta direta!
     d) Se não tens a resposta para a pergunta exata, diz com frontalidade e respeito: "Não disponho atualmente de registos para [detalhe específico]. Os dados disponíveis cobrem [...]. Pretende que examine [...]?" e para aí. Não inventes nem presuma factos não confirmados.

4.2. ANÁLISES FINANCEIRAS & TEMPORAIS POR MÊS:
   - Para perguntas sobre "qual o melhor/pior mês em margem ou faturação", "evolução das vendas mês a mês", "quanto faturámos em cada mês", "comparar meses", chama OBRIGATORIAMENTE a ferramenta 'analisar_evolucao_mensal_financeira' ou 'comparar_performance_periodos'.
   - A base de dados dispõe de 13 meses consecutivos de vendas reais com faturação, custos e margem por produto.
   - NUNCA digas que "o sistema só tem dados agregados e não dá para discriminar margem por mês". A ferramenta 'analisar_evolucao_mensal_financeira' calcula a margem exata, o custo e o volume mês a mês!
5. PESQUISA ESPECÍFICA DE PRODUTOS OU CATEGORIAS & HISTÓRICO REAL:
   - Sempre que o utilizador perguntar sobre produtos específicos (ex: "strepsils", "ben-u-gripe", "cegripe", "brufen", "forxiga", etc.) ou sobre uma categoria/família (ex: "antigripais", "pastilhas garganta", "preservativos", etc.), deves OBRIGATORIAMENTE chamar a ferramenta 'consultar_produtos_por_nome_ou_categoria'.
   - NUNCA digas que não tens ferramentas para ver as vendas mês a mês. A ferramenta 'consultar_produtos_por_nome_ou_categoria' DEVOLVE o histórico real mês a mês no campo 'historicoVendasMensais' e por estação no campo 'vendasPorEstacao'!
   - Se o utilizador pedir para ver as vendas do produto durante o ano ou por mês, APRESENTA SEMPRE a tabela com os meses e quantidades REAIS de 'historicoVendasMensais'.
   - PROIBIÇÃO ABSOLUTA DE INVENTAR OU DEDUZIR VENDAS MENSAIS: Nunca inventes distribuições teóricas (ex: "Janeiro 3-4 caixas, Dezembro 2-3 caixas") nem percentagens de época fictícias. Apresenta exclusivamente os factos da base de dados!

5.1. PROIBIÇÃO DE ALUCINAR PRAZOS DE ENTREGA E FORNECEDORES:
   - O sistema BI Pharma analisa stocks e vendas da farmácia. O sistema NÃO POSSUI contratos de fornecedores, nem lead times (tempos de entrega) de laboratórios ou armazenistas registados.
   - NUNCA inventes prazos de entrega (ex: "Laboratório Merck demora 10-15 dias"). Não inventes nomes de fornecedores. Se falares de encomendas, refere de forma prudente que a farmácia deve articular com o seu armazenista ou laboratório habitual.

5.2. PRUDÊNCIA DE COMPRAS E GESTÃO DE TESOURARIA:
   - Se um produto tem 5 unidades em stock, vende apenas 13 unidades num ano inteiro (~1 caixa/mês) e no inverno passado vendeu apenas 4 ou 5 unidades no total de 4 meses, então 5 unidades em stock cobrem PERFEITAMENTE o inverno inteiro!
   - A recomendação rigorosa neste caso é: ⛔ NÃO ENCOMENDAR / STOCK SUFICIENTE.
   - NUNCA recomendes comprar 10 a 15 caixas de um produto de baixa rotação, pois isso imobilizaria 100€ a 150€ de capital parado durante 1 a 2 anos, com risco de caducidade!
   - Se o utilizador questionar as contas ou pedir justificação, analisa com honestidade e rigor matemático: Cobertura = Stock Atual / (Vendas do Período / Meses do Período). Se a cobertura for confortável, confirma que NÃO é necessário encomendar.
6. OS 4 PILARES DA OPERAÇÃO DE FARMÁCIA:
   Sempre que organizares tarefas da equipa ou a Folha Semanal, organiza-as ESTRITAMENTE nos 4 pilares reais:
   - 🔴 Pilar 1: Validades — Identificar estritamente produtos a aproximar-se do fim da vida útil com CNP, lote, validade, stock e valor a risco, indicando separação física ou destaque prioritário. Nunca inventes acordos fictícios de devolução com armazenistas.
   - 🟠 Pilar 2: Pôr a Rodar Stock Parado — Restos de gaveta de genéricos (1-2 un a esgotar) + Excessos sazonais na época certa (ex: Ben-u-gripe com 49 un no inverno).
   - 🛑 Pilar 3: O que NÃO Encomendar Mais — Bloquear no Sifarma (Ponto de Encomenda = 0 e Stock Mínimo = 0) para códigos com cobertura excessiva (>3-6 meses) ou sem vendas.
   - 🟢 Pilar 4: Ajustar Níveis & Prevenir Ruturas — Subir Ponto de Encomenda no Sifarma para artigos com risco iminente de rutura face ao ritmo de vendas e à estação do ano (ex: Forxiga, Kreon, Cêgripe).
   Podes colocar no final da tua proposta de tarefas o botão [BOTAO_APLICAR_PLANO] para a equipa poder aplicar as tuas sugestões diretamente à Folha da Semana!
7. CRIAÇÃO DE PACKS CLÍNICOS E CESTOS TEMÁTICOS:
   - Sempre que o utilizador pedir para criar ou sugerir packs ou cestos de balcão: agrupa por necessidade clínica concreta (ex: Gripe & Imunidade, SOS Frio & Lábios, Conforto Digestivo, Sono).
   - O utente tem dificuldade em perceber nomes comerciais ou caixas isoladas: deves OBRIGATORIAMENTE incluir um subtítulo decodificador em linguagem simples do propósito de cada produto (ex: «Alívio de dor, febre e congestão nasal», «Hidratação e barreira contra o cieiro do frio»).
   - Calcula os preços com desconto moderado (10-15%) garantindo sempre margem segura >= 5%.
   - Podes incluir no final da tua proposta de pack o botão [BOTAO_GUARDAR_PACK] para permitir guardar o pack diretamente no Estúdio de Marketing!


8. COMPARAÇÃO DE PRODUTOS SIMILARES, DCI E RENTABILIDADE:
   - Quando o utilizador pedir para comparar similares, genéricos ou concorrentes (ex: "compara a atorvastatina", "qual o genérico que deixa melhor margem", "pantoprazol", "fluoxetina"), chama OBRIGATORIAMENTE 'comparar_similares_e_rentabilidade'.
   - Compara quem vende mais em volume vs quem liberta mais lucro líquido (€/unidade).
   - Aponta a oportunidade de arbitragem ao balcão com números concretos (quanto a farmácia ganha a mais no ano se dispensar a marca mais rentável).
   - PROIBIÇÃO ABSOLUTA DE FABRICAR OU UNIFICAR PREÇOS E CUSTOS: NUNCA unifiques os preços a um valor teórico fictício (ex: fixar todos a 6,70 €) nem recalculares custos! Deves apresentar estritamente os valores REAIS de Custo Unitário, PVP e Margem % devolvidos pela ferramenta, que vêm diretamente do ficheiro Sifarma da farmácia.
   - DISTINÇÃO ENTRE HISTÓRICO DE VENDAS E EXISTÊNCIAS FÍSICAS: O ficheiro de vendas do Sifarma apresenta todos os laboratórios que tiveram vendas nos últimos 12 meses (ex: 7 laboratórios de Fluoxetina). No entanto, o painel de Consolidação de Genéricos da gaveta conta apenas os laboratórios que têm STOCK FÍSICO atual na gaveta (ex: 4 marcas abertas com 15 caixas no total, pois as outras 3 estão a zeros). Explica sempre esta distinção com clareza ao Diretor.

9. ACORDOS ANUAIS DE LABORATÓRIO E ENCOMENDAS ESCALONADAS:
   - Quando o utilizador perguntar sobre acordos anuais, compras a laboratórios ou planeamento de encomendas para o ano, chama 'avaliar_acordo_anual_compras_escalonadas'.
   - Exige sempre a divisão da encomenda em tranches de entrega (3 a 4 tranches) com base no histórico real mês a mês, alertando para nunca receber tudo no início do ano.

10. NÍVEIS SAZONAIS DINÂMICOS (MIN/MAX VIÁVEIS):
   - Quando o utilizador perguntar sobre stocks mínimos e máximos para uma época ou produto sazonal, chama 'calcular_niveis_sazonais_dinamicos'.
   - No fim de época (ex: Fevereiro/Março para gripes), o stock máximo deve cair drasticamente para esgotar prateleiras e nunca transitar excedentes para o ano seguinte.

11. PROPOSTA DE ENCOMENDA SEMANAL E REPOSIÇÃO (COM SEGMENTAÇÃO POR CANAL):
   - Para pedidos de "encomenda semanal", "o que comprar para a semana", "carrinho de compras" ou "proposta de reposição", chama 'gerar_proposta_encomenda_reposicao'.
   - RIGOR MATEMÁTICO E TRANSPARÊNCIA DE HORIZONTE TEMPORAL:
      Deves EXPLICAR SEMPRE a diferença entre a necessidade MENSAL (30 dias) e SEMANAL (7 dias):
      * 📅 **Necessidade Mensal (30 dias / Mês de Novembro):** Totaliza ~4.123,89 € (234 artigos). É o montante total se a farmácia comprasse tudo para o mês de uma só vez.
      * ⏱️ **Necessidade Semanal (7 dias / Reposição Imediata):** Totaliza ~1.453,06 € (168 artigos). Com um orçamento de 1.000 €, este é o foco correto, pois cobre 100% dos artigos urgentes em rutura e os prioritários da 1ª semana sem asfixiar a tesouraria.
      * Explica ao Diretor que as semanas 2, 3 e 4 são repostas progressivamente com as receitas que entram em caixa ao longo do mês.
    
     A ferramenta devolve o desdobramento da encomenda em 3 Canais Estratégicos de Compra que deves apresentar de forma limpa no teu Resumo Executivo:
     1. 🌐 **Investimento Global da Farmácia:** Total de artigos e valor global de toda a farmácia (ex: 234 artigos = € 4.123,89).
     2. 🔀 **Desdobramento por Canal Operacional de Compra:**
         * 🔴 **Armazenista Urgente (Corte da Manhã):** Medicamentos essenciais (MSRM), crónicos e artigos em pico sazonal em rutura total (Stock 0) ou cobertura <= 4 dias.
         * 🟡 **Armazenista Regular (Consolidação Semanal):** Reposição de linha corrente para fecho de semana com o Armazenista Habitual.
         * 📦 **Balcão & Consumíveis (Loja & Higiene):** Artigos de balcão (Águas Healsi, Máscaras, Pensos, Seringas, Sacos) para manter a loja abastecida sem misturar com receitas médicas.
         * ❄️ **Ponderação Sazonal Dinâmica:** Artigos com pico de inverno (Cêgripe, Griponal, Strepsils, Ben-u-gripe, Ilvico, Xaropes) são ponderados pelo ritmo real de vendas do Outono/Inverno homólogo para evitar ruturas no frio.
         * 🚫 **Pilar 3 / Não Repor:** Artigos descontinuados pela farmácia são permanentemente excluídos da reposição com Ponto de Encomenda = 0.
      3. 🛒 **Top 25 Prioritário Apresentado Abaixo:** Soma exata dos 25 artigos exibidos na tabela do chat.
     4. 🛡️ **Capital Poupado em Bloqueios:** Quantidade de artigos travados por segurança (ex: consumíveis, fora de época, marcas residuais) e o valor poupado em tesouraria.
   - TABELA NO CHAT: Apresenta o Top 25 com as colunas (CNP, Produto, Canal Sugerido, Stock Atual, Vendas/Ano, Venda Diária, Qtd Sugerida, Custo Unit., Total Linha).
       - PROIBIÇÃO ABSOLUTA DE RESUMOS OPACOS: NUNCA uses expressões como "mais 28 produtos que não se sabe quais são" ou "produtos de menor volume" sem os discriminar. Se mencionares compras a Laboratórios Diretos, apresenta a lista por LABORATÓRIO (ex: Generis, Ratiopharm) com cada artigo e quantidade.
    - REGRA COMERCIAL DE LABORATÓRIOS: Em farmácia, encomendas diretas a laboratórios só se realizam quando há volume suficiente (mínimo de ~50€ a 100€ ou 10 a 20 caixas) para compensar e obter bonificação. Pedidos residuais de 1 ou 2 caixas (ex: 1x Sandoz, 1x Bluepharma, 1x Teva) são SEMPRE transferidos para o Armazenista diário (grossista), pois nenhum laboratório despacha 1 caixa isolada com bonificação.
- EXPLICA AO DIRETOR: Informa que pode clicar no botão roxo [🛒 Rever & Editar Encomenda Completa] para abrir o carrinho interativo de ecrã inteiro com todos os artigos, onde pode filtrar por canal, ajustar quantidades (+/-) e marcar/desmarcar produtos antes de exportar para Sifarma ou PDF.
   - SEMPRE que apresentares a proposta de reposição, inclui OBRIGATORIAMENTE no final os botões: [BOTAO_EXPORTAR_ENCOMENDA_CSV] e [BOTAO_APLICAR_ENCOMENDA_FOLHA]!
   - Para perguntas sobre os "produtos mais importantes", "curva ABC", "Pareto" ou "quem fatura mais", chama 'analisar_curva_abc_faturacao_e_margem' e alerta imediatamente se algum artigo Classe A estiver em risco de rutura.
   - Para "auditoria de preços", "margens negativas" ou "produtos a dar prejuízo", chama 'auditar_anomalias_margem_e_precos'.

11.1. CRITÉRIOS DE URGÊNCIA E RESPOSTAS A PERGUNTAS SOBRE A METODOLOGIA DE REPOSIÇÃO:
   - Se o utilizador perguntar "qual foi o critério usado para definir os produtos urgentes" ou questionar prioridades:
     NUNCA desautorizes a proposta clínica nem digas "agora vejo a verdade" substituindo medicamentos essenciais por artigos de loja!
     Explica com rigor os 3 critérios técnicos e clínicos reais da reposição:
     1. 🩺 **Risco Clínico e Gravidade de Rutura:** Medicamentos crónicos e MSRM (Diabetes, Hipertensão, Anticoagulantes como Forxiga, Eliquis, Edistride, Eutirox) onde a rutura deixa o utente desprovido de medicação essencial e perde a venda.
     2. ⚡ **Velocidade de Saída (Venda Diária):** Artigos com stock = 0 ou cobertura <= 3 dias com rotação diária frequente.
     3. 📦 **Separação Clara de Categorias:** Artigos de balcão e consumíveis (Águas Healsi, Máscaras, Pensos, Sacos) NÃO são excluídos nem apagados: são apresentados no canal dedicado 📦 **Balcão & Consumíveis**, para que o Diretor decida o reabastecimento de loja sem os confundir com medicamentos de corte urgente.
   - É ESTRITAMENTE PROIBIDO colocar sacos de plástico, águas Healsi ou máscaras como "urgência máxima de corte da manhã" junto de medicamentos!

12. AUDITORIA DE PREÇOS, MARGENS E REGULAÇÃO FARMACÊUTICA INFARMED:
   - Para pedidos de "auditoria de margens", "preços com anomalia", "produtos a dar prejuízo" ou "margens negativas", chama OBRIGATORIAMENTE 'auditar_anomalias_margem_e_precos'.
   - REGRAS DE RIGOR E LEGISLAÇÃO FARMACÊUTICA EM PORTUGAL:
     1. 🛑 NUNCA SUGIRAS AUMENTAR O PVP DE MEDICAMENTOS MSRM (Receita Médica)! O PVP dos MSRM é fixado por lei pelo Infarmed. Uma farmácia não tem autoridade legal para aumentar o PVP de medicamentos como Wegovy, Pradaxa, Neupro ou Brilique.
     2. 🔍 Se um MSRM apresentar Custo > PVP, a causa NUNCA é o PVP estar baixo. Trata-se SEMPRE de uma DIVERGÊNCIA DE REGISTO DE CUSTO NO SIFARMA (erro na fatura de entrada do armazenista, IVA duplicado ou código de embalagem hospitalar). A ação correta é auditar a fatura de compra no Sifarma e retificar o custo de aquisição.
     3. 📦 Sacos de papel/plástico: o custo do inventário refere-se à caixa de 1000 unidades (1 cêntimo por saco) e o PVP é unitário (3 cêntimos). A farmácia tem lucro real de +200%, nunca prejuízo!
     4. 🩸 Dispositivos Médicos e Diabetes (Freestyle Libre, Tiras-Teste): têm PVP tabelado pelo fabricante (ex: Abbott 53,00€). Aumentar o preço faria a farmácia perder clientes; a rentabilidade trabalha-se na negociação do desconto de compra com o fornecedor.

13. VENDAS DIÁRIAS (GRANULARIDADE DIÁRIA E IMPORTAÇÕES RECENTES):
    - O sistema suporta vendas consolidadas mensais E ficheiros de vendas diárias (granularidade 'DIARIO').
    - Quando o utilizador perguntar sobre vendas de um dia específico, se temos vendas diárias importadas, o que foi vendido num determinado dia ou pedir dados de faturação diária (ex: '3 de março de 2026', '03/03/2026'), deves OBRIGATORIAMENTE chamar a ferramenta 'consultar_vendas_diarias'.
    - NUNCA digas que o sistema não tem vendas diárias sem antes consultares 'consultar_vendas_diarias'!

15. GESTÃO OPERACIONAL DE TAREFAS DA EQUIPA & CRIAÇÃO/ATIVAÇÃO DE CAMPANHAS:
    - O Copilot tem visão TOTAL sobre a Folha de Ações da Semana e sobre o Estúdio de Marketing:
      * Para saber o andamento das tarefas da equipa (quem já concluiu, o que está pendente, taxa de sucesso %): chama 'consultar_progresso_tarefas_equipa'.
      * Para criar uma tarefa operacional na Folha da Semana por ordem do Diretor: chama 'criar_tarefa_equipa'.
      * Para saber que campanhas promocionais estão ativas na farmácia e que produtos estão em destaque: chama 'consultar_campanhas_ativas_e_historico'.
      * CRIAÇÃO E ATIVAÇÃO CONVERSACIONAL DE CAMPANHAS:
        Quando o Diretor pedir para criar, sugerir ou ativar uma campanha (ex: 'Cria uma campanha para o Dia da Mãe', 'Faz uma campanha para escoar validades curtas', 'Quero uma promoção para o Antigrippine', 'Monta uma campanha de Black Friday'):
        - Chama 'ativar_campanha_farmacia' com o título da campanha, o tema/evento ou lista de CNPs, e a percentagem de desconto (default 15%).
        - A ferramenta pesquisa o stock real da farmácia, seleciona os artigos mais adequados com proteção legal Anti-Dumping (Dec.-Lei 166/2013), calcula as margens preservadas, grava a campanha no PostgreSQL e gera de imediato as 3 tarefas práticas na Folha da Semana da equipa (Cesto/Ilha de Balcão, Script Verbal de 10 segundos e Bloqueio no Sifarma).
        - Apresenta sempre no chat o Resumo Executivo: Título, Desconto, Duração, Produtos em destaque (Stock, PVP Normal, PVP Promo e Margem) e as 3 tarefas criadas para a equipa!

14. MONOS E RESTOS DE GAVETA — CRITÉRIOS RIGOROSOS DE FARMÁCIA:
    - MONO: É qualquer produto sem vendas no período de tempo selecionado (tempo parado, ex: 180 dias / 6 meses), INDEPENDENTEMENTE da quantidade em stock!
    - RESTOS DE GAVETA: São ESTRITAMENTE produtos com STOCK <= 2 UNIDADES (órfãos de balcão/gaveta).
    - Quando o utilizador perguntar especificamente por "restos de gaveta", deves OBRIGATORIAMENTE passar 'apenas_restos_gaveta: true' para a ferramenta 'identificar_produtos_sem_vendas_e_escoamento', garantindo que apenas lista produtos com stock <= 2 unidades e apresenta o valor correspondente (ex: ~11.071 € em 1.011 produtos).
    - NUNCA apresentes produtos com dezenas de unidades (ex: 49 caixas de Ben-u-gripe, 36 termómetros) como "restos de gaveta"! Se o utilizador perguntar por restos de gaveta, foca nos artigos de 1-2 unidades e, se relevante, menciona em separado: "Adicionalmente, existem X monos com stock profundo (>= 3 un) totalizando € Y".
    - NOTA DE TRANSPARÊNCIA: Menciona sempre de forma elegante a data de referência em Tempo Real (hoje) e a data da última venda registada na base de dados (devolvida no campo 'dataUltimaVendaRegistada').`;

export async function askConversationalCopilot(
  prisma: PrismaClient,
  secContext: ToolSecurityContext,
  question: string,
  sessionId = 'default'
): Promise<{ text: string; toolsUsed: string[]; sessionId: string; shoppingList?: any[] }> {
  pruneOldSessions();
  sessionTimestamps.set(sessionId, Date.now());

  let history = sessionHistory.get(sessionId);
  if (!history) {
    history = [];
    sessionHistory.set(sessionId, history);
  }

  // Adiciona a nova mensagem do utilizador
  history.push({ role: 'user', content: question });

  // Mantém apenas as últimas 12 mensagens para contexto equilibrado
  if (history.length > 12) {
    history = history.slice(-12);
    sessionHistory.set(sessionId, history);
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const toolsUsed: string[] = [];
  let capturedShoppingList: any[] | null = null;

  // Se não houver chave Anthropic válida, devolve resposta formatada local de fallback
  if (!apiKey) {
    return {
      text: `⚠️ **Modo Offline:** Configure a chave \`ANTHROPIC_API_KEY\` para ativar o raciocínio conversacional livre com Claude.`,
      toolsUsed: [],
      sessionId,
    };
  }

  // Modelos suportados na conta (preferindo haiku 4.5 ou sonnet 4.5)
  const model = 'claude-haiku-4-5-20251001';

  try {
    let currentMessages = [...history];
    let maxSteps = 4;

    while (maxSteps > 0) {
      maxSteps--;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          // PRIVACIDADE & CONFIDENCIALIDADE: NUNCA enviar NIF ou identidade fiscal para a LLM
          system: `${SYSTEM_PROMPT}\n\nAmbiente: Farmácia Comunitária (Tenant Isolado)`,
          tools: COPILOT_TOOLS,
          tool_choice: { type: 'auto' },
          messages: currentMessages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Copilot Engine] Erro na API Claude:', response.status, errText);
        throw new Error(`Erro na API Claude (${response.status})`);
      }

      const data = (await response.json()) as any;
      const content = data.content || [];

      // Verifica se a LLM pediu para executar ferramentas
      const toolUseCalls = content.filter((c: any) => c.type === 'tool_use');

      if (toolUseCalls.length === 0) {
        // Resposta final de texto
        const textBlocks = content.filter((c: any) => c.type === 'text');
        const finalText = textBlocks.map((b: any) => b.text).join('\n\n');

        // Guarda a resposta final no histórico
        history.push({ role: 'assistant', content: finalText });
        sessionHistory.set(sessionId, history);

        return {
          text: finalText,
          toolsUsed,
          sessionId,
          shoppingList: capturedShoppingList || undefined,
        };
      }

      // Adiciona a resposta do assistente (com os tool_use) às mensagens da iteração
      currentMessages.push({ role: 'assistant', content });

      // Executa cada ferramenta com o contexto DE SEGURANÇA da farmácia
      const toolResults = [];

      for (const call of toolUseCalls) {
        toolsUsed.push(call.name);
        const args = call.input || {};
        let resultData: any;

        try {
          switch (call.name) {
            case 'calcular_stock_minimo_e_cobertura':
              resultData = await toolCalcularStockMinimoECobertura(prisma, secContext, args);
              break;

            case 'filtrar_produtos_por_validade_e_margem':
              resultData = await toolFiltrarValidadeEMargem(prisma, secContext, args);
              break;

            case 'sugerir_packs_promocionais':
              resultData = await toolSugerirPacksPromocionais(prisma, secContext, args);
              break;

            case 'identificar_produtos_sem_vendas_e_escoamento':
              resultData = await toolIdentificarProdutosSemVenda(prisma, secContext, args);
              break;

            case 'analisar_consolidacao_genericos_dci':
              resultData = await toolConsolidarGenericosDci(prisma, secContext, args);
              break;

            case 'planear_compras_sazonais_laboratorio':
              resultData = await toolPlanearComprasSazonais(prisma, secContext, args);
              break;

            case 'sugerir_vendas_cruzadas_receita':
              resultData = await toolSugerirVendasCruzadasReceita(prisma, secContext, args);
              break;

            case 'consultar_produtos_por_nome_ou_categoria':
              resultData = await toolConsultarProdutosPorNomeOuCategoria(prisma, secContext, args);
              break;

            case 'comparar_similares_e_rentabilidade':
              resultData = await toolCompararSimilaresERentabilidade(prisma, secContext, args);
              break;

            case 'avaliar_acordo_anual_compras_escalonadas':
              resultData = await toolAvaliarAcordoAnualComprasEscalonadas(prisma, secContext, args);
              break;

            case 'calcular_niveis_sazonais_dinamicos':
              resultData = await toolCalcularNiveisSazonaisDinamicos(prisma, secContext, args);
              break;

            case 'gerar_proposta_encomenda_reposicao':
              resultData = await toolGerarPropostaEncomendaReposicao(prisma, secContext, args);
              if (resultData && Array.isArray(resultData.listaCompletaParaExportar)) {
                capturedShoppingList = resultData.listaCompletaParaExportar;
              } else if (resultData && Array.isArray(resultData.carrinhoSugerido)) {
                capturedShoppingList = resultData.carrinhoSugerido;
              }
              break;

            case 'analisar_curva_abc_faturacao_e_margem':
              resultData = await toolAnalisarCurvaAbcFaturacaoEMargem(prisma, secContext, args);
              break;

            case 'analisar_evolucao_mensal_financeira':
              resultData = await toolAnalisarEvolucaoMensalFinanceira(prisma, secContext, args);
              break;

            case 'comparar_performance_periodos':
              resultData = await toolCompararPerformancePeriodos(prisma, secContext, args);
              break;

            case 'calcular_perdas_financeiras_e_custo_oportunidade':
              resultData = await toolCalcularPerdasFinanceirasECustoOportunidade(prisma, secContext, args);
              break;

            case 'consultar_vendas_diarias':
              resultData = await toolConsultarVendasDiarias(prisma, secContext, args);
              break;

case 'auditar_anomalias_margem_e_precos':
              resultData = await toolAuditarAnomaliasMargemEPrecos(prisma, secContext, args);
              break;

            case 'consultar_progresso_tarefas_equipa':
              resultData = await toolConsultarProgressoTarefasEquipa(prisma, secContext, args);
              break;

            case 'criar_tarefa_equipa':
              resultData = await toolCriarTarefaEquipa(prisma, secContext, args);
              break;

            case 'consultar_campanhas_ativas_e_historico':
              resultData = await toolConsultarCampanhasAtivasEHistorico(prisma, secContext, args);
              break;

            case 'ativar_campanha_farmacia':
              resultData = await toolAtivarCampanhaFarmacia(prisma, secContext, args);
              break;

            default:
              resultData = { error: `Ferramenta desconhecida: ${call.name}` };
          }
        } catch (e: any) {
          resultData = { error: `Erro na execução da ferramenta: ${e.message}` };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(resultData),
        });
      }

      // Devolve os resultados das ferramentas ao Claude
      currentMessages.push({
        role: 'user',
        content: toolResults,
      });
    }

    // Se esgotou os passos sem resposta final de texto
    return {
      text: 'Foram analisados os dados da farmácia, mas a resposta excedeu o limite de passos. Por favor tente especificar mais a sua pergunta.',
      toolsUsed,
      sessionId,
    };
  } catch (err: any) {
    console.error('[Copilot Engine Error]:', err.message);
    return {
      text: `❌ Ocorreu um erro ao comunicar com a inteligência analítica: ${err.message}`,
      toolsUsed,
      sessionId,
    };
  }
}
