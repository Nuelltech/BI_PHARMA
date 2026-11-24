import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PrismaClient } from '@prisma/client';
import {
  ToolSecurityContext,
  toolCalcularStockMinimoECobertura,
  toolIdentificarProdutosSemVenda,
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
  toolAnalisarEvolucaoMensalFinanceira,
  toolCompararPerformancePeriodos,
  toolAuditarEscoamentoEDestraveStock,
  toolCalcularPerdasFinanceirasECustoOportunidade,
  toolConsultarVendasDiarias,
  toolConsultarVendasPeriodo,
  toolAnalisarDesempenhoLaboratorio,
  toolFiltrarProdutosPorValidadeEMargem,
  toolCompararAlternativasDci,
  toolConsultarCampanhasAtivasEHistorico,
} from './mcp_pharma_tools.js';
import { sugerirPacksPromocionais } from './comercial.js';
import { createPrismaComercialRepo, buildComercialCfg } from './comercial_repo.js';
import { checkToolPermission } from './mcp_governance.js';

export interface McpServerOptions {
  perfilPermissao?: string;
  connectorId?: string;
  ip?: string;
  userAgent?: string;
  onAudit?: (data: {
    ferramenta: string;
    parametros: any;
    sucesso: boolean;
    duracaoMs: number;
    error?: string;
  }) => Promise<void>;
}

export function createPharmaMcpServer(
  prisma: PrismaClient,
  secContext: ToolSecurityContext,
  options?: McpServerOptions
): Server {
  const server = new Server(
    {
      name: `bi-pharma-${secContext.farmaciaNome.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const perfil = options?.perfilPermissao || 'COMPLETO';
  // P0 #4: Aplicar ver_faturacao de acordo com o perfil do conector MCP
  const effectiveSecContext: ToolSecurityContext = {
    ...secContext,
    perfil,
    verFaturacao: perfil !== 'BALCAO_CLINICO',
  };

  // Sanitizador de envelope (P0 #4): remove campos de faturação/receita quando verFaturacao === false
  const FATURACAO_KEY_RX = /(faturacao|faturação|valorTotal|receita|lucroTotal|margemBrutaTotal|margemTotalEstimada)/i;
  const stripFaturacaoFields = (obj: any): any => {
    if (effectiveSecContext.verFaturacao !== false) return obj;
    if (Array.isArray(obj)) return obj.map(stripFaturacaoFields);
    if (obj && typeof obj === 'object') {
      const clean: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (FATURACAO_KEY_RX.test(k)) {
          clean[k] = null;
        } else {
          clean[k] = stripFaturacaoFields(v);
        }
      }
      return clean;
    }
    return obj;
  };

  // Lista única e autoritativa de ferramentas anunciadas pelo servidor MCP (estritamente só leitura)
  let advertisedToolNames: Set<string> | null = null;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = [
        {
          name: 'analisar_evolucao_mensal_financeira',
          description:
            'Calcula a evolução histórica rigorosa de vendas mês a mês (faturação bruta, margem bruta em Euros e margem percentual) dos últimos 12 meses. Identifica o melhor e pior mês da farmácia.',
          inputSchema: {
            type: 'object',
            properties: {
              ano_filtro: { type: 'number', description: 'Ano específico (ex: 2026)' },
              top_produtos_destaque: { type: 'number', description: 'Número de produtos top a detalhar (default 5)' },
            },
          },
        },
        {
          name: 'comparar_performance_periodos',
          description:
            'Compara a performance financeira entre dois trimestres ou semestres (faturação, margem em Euros e volume de unidades vendidas).',
          inputSchema: {
            type: 'object',
            properties: {
              periodo_a: { type: 'string', description: 'Primeiro período (ex: "2025-Q1", "2025-H1")' },
              periodo_b: { type: 'string', description: 'Segundo período a comparar (ex: "2026-Q1", "2026-H1")' },
            },
            required: ['periodo_a', 'periodo_b'],
          },
        },
        {
          name: 'auditar_escoamento_e_destrave_stock',
          description:
            'Audita o escoamento, reativação de monos e destrave de capital num determinado mês (ex: produtos parados há 3 meses ou desde agosto que venderam).',
          inputSchema: {
            type: 'object',
            properties: {
              mes_venda: { type: 'string', description: 'Mês de venda no formato YYYY-MM (ex: "2026-10")' },
              meses_parado_minimo: { type: 'number', description: 'Meses de inatividade anterior exigidos (padrão 3)' },
              parado_desde: { type: 'string', description: 'Mês inicial de inatividade (ex: "2026-08")' },
              apenas_eliminados_a_zero: { type: 'boolean', description: 'Se true, filtra apenas artigos com stock final = 0' },
              excluir_sazonais: { type: 'boolean', description: 'Se true, exclui artigos sazonais' },
            },
            required: ['mes_venda'],
          },
        },
        {
          name: 'calcular_perdas_financeiras_e_custo_oportunidade',
          description:
            'Calcula em Euros o custo de oportunidade e perdas financeiras da farmácia em ruturas da Classe A, monos com capital parado e artigos em risco de caducidade.',
          inputSchema: {
            type: 'object',
            properties: {
              tipo_auditoria: {
                type: 'string',
                enum: ['TODAS', 'RUTURAS_CLASSE_A', 'MONOS_CAPITAL_PARADO', 'VALIDADES_RISCO'],
                description: 'Foco da auditoria financeira',
              },
            },
          },
        },
        {
          name: 'consultar_produtos_por_nome_ou_categoria',
          description:
            'Pesquisa e detalha produtos da farmácia por nome comercial (com tolerância a acentos, hífens e pequenas gralhas), marca, substância DCI, código CNP (ou lista de CNPs) ou categoria. Cobre catálogo completo + vendas históricas + stock atual, devolve margem líquida com IVA deduzido, origem_encontrada, acoes_permitidas e resultado_id.',
          inputSchema: {
            type: 'object',
            properties: {
              termo_pesquisa: { type: 'string', description: 'Nome do produto, marca, categoria ou CNP' },
              cnps: { type: 'array', items: { type: 'string' }, description: 'Lista de códigos CNP para consulta em lote' },
              apenas_com_stock: { type: 'boolean', description: 'Filtrar apenas produtos com stock físico > 0' },
              limite: { type: 'number', description: 'Número máximo de registos por página (default 30, máx 200)' },
              pagina: { type: 'number', description: 'Número da página (default 1)' },
            },
          },
        },
        {
          name: 'consultar_vendas_periodo',
          description:
            'Consulta rápida de vendas agregadas por período (ex: "2026", "2026-01", "2025-11..2026-02", "ultimos_3m", "ultimos_12m"), com filtro opcional por laboratório (matching canónico), categoria, termo de pesquisa ou lista de CNPs. Devolve unidades, faturação, margem líquida sem IVA, aviso de dados parciais (D6) e resultado_id.',
          inputSchema: {
            type: 'object',
            properties: {
              periodo: { type: 'string', description: 'Período: YYYY, YYYY-MM, YYYY-MM..YYYY-MM, ultimos_3m ou ultimos_12m' },
              laboratorio: { type: 'string', description: 'Nome do laboratório (matching canónico exato)' },
              categoria: { type: 'string', description: 'Categoria ou subcategoria' },
              termo_pesquisa: { type: 'string', description: 'Termo de pesquisa no nome/DCI/CNP' },
              cnps: { type: 'array', items: { type: 'string' }, description: 'Lista de códigos CNP em lote' },
              limite: { type: 'number', description: 'Número máximo de registos por página (default 30, máx 200)' },
              pagina: { type: 'number', description: 'Página (default 1)' },
            },
          },
        },
        {
          name: 'comparar_alternativas',
          description:
            'Compara alternativas na mesma molécula DCI numa única chamada rápida. Aceita lista de DCIs ou CNPs e laboratório de referência, devolvendo vendas 12M, stock, último custo conhecido (incl. PrecoFarmacia quando stock=0) e margem sem IVA.',
          inputSchema: {
            type: 'object',
            properties: {
              dcis: { type: 'array', items: { type: 'string' }, description: 'Lista de moléculas DCI (até 15)' },
              cnps: { type: 'array', items: { type: 'string' }, description: 'Lista de CNPs' },
              laboratorio_referencia: { type: 'string', description: 'Laboratório em análise (opcional)' },
              limite_por_dci: { type: 'number', description: 'Máximo por DCI (default 5)' },
            },
          },
        },
        {
          name: 'analisar_desempenho_laboratorio',
          description:
            'Análise completa de desempenho de um laboratório (matching canónico rigoroso), com filtro opcional por período (ex: "2026"), stock, vendas, margem líquida sem IVA, monos, excessos, ruturas reais e quotas DCI.',
          inputSchema: {
            type: 'object',
            properties: {
              nome_laboratorio: { type: 'string', description: 'Nome do laboratório (ex: Bial, Generis, Teva, Pierre Fabre)' },
              periodo: { type: 'string', description: 'Período opcional (ex: "2026", "2026-01")' },
              limite_detalhes: { type: 'number', description: 'Número máximo de registos por página (default 30, máx 200)' },
              pagina: { type: 'number', description: 'Página (default 1)' },
            },
            required: ['nome_laboratorio'],
          },
        },
        {
          name: 'calcular_stock_minimo_e_cobertura',
          description:
            'Calcula o stock mínimo necessário e os dias de cobertura para um período pretendido (ex: 7 ou 14 dias). Identifica produtos abaixo do mínimo (risco de rutura) e produtos em excesso.',
          inputSchema: {
            type: 'object',
            properties: {
              dias_cobertura_desejados: { type: 'number', description: 'Dias de cobertura pretendidos (default 7)' },
              apenas_abaixo_minimo: { type: 'boolean', description: 'Filtrar apenas artigos com stock abaixo do mínimo' },
              limite: { type: 'number', description: 'Número máximo de registos (default 25)' },
            },
          },
        },
        {
          name: 'gerar_proposta_encomenda_reposicao',
          description:
            'Gera a proposta de carrinho semanal ou quinzenal de compras para os produtos em risco de rutura com custo financeiro total em Euros.',
          inputSchema: {
            type: 'object',
            properties: {
              dias_cobertura_desejados: { type: 'number', description: 'Dias a cobrir (7 para semanal, 14 para quinzenal)' },
              apenas_venda_regular: { type: 'boolean', description: 'Apenas venda regular (default true)' },
              limite: { type: 'number', description: 'Máximo de artigos' },
            },
          },
        },
        {
          name: 'analisar_curva_abc_faturacao_e_margem',
          description:
            'Aplica o Princípio de Pareto para identificar os produtos Classe A (80% da receita/lucro) e audita o seu risco de rutura.',
          inputSchema: {
            type: 'object',
            properties: {
              tipo_curva: { type: 'string', enum: ['FATURACAO', 'MARGEM'], description: 'Classificar por Faturação ou Margem' },
              top_n: { type: 'number', description: 'Número de produtos no ranking' },
            },
          },
        },
        {
          name: 'filtrar_produtos_por_validade_e_margem',
          description:
            'Filtra produtos com data de validade próxima e simula o PVP promocional mínimo garantindo que a margem não fica abaixo do limiar (anti-dumping).',
          inputSchema: {
            type: 'object',
            properties: {
              ano_limite_validade: { type: 'number', description: 'Ano limite de validade a pesquisar (ex: 2027)' },
              margem_minima_pct: { type: 'number', description: 'Margem mínima tolerada em % (ex: 10.0)' },
              apenas_venda_livre: { type: 'boolean', description: 'Filtrar apenas produtos de venda livre' },
              limite: { type: 'number', description: 'Número máximo de registos (default 30)' },
            },
          },
        },
        {
          name: 'sugerir_packs_promocionais',
          description:
            'Cria e sugere packs promocionais de 2 a 3 produtos onde a margem global cumpre o mínimo definido.',
          inputSchema: {
            type: 'object',
            properties: {
              tamanho_pack: { type: 'number', description: 'Número de artigos por pack (2 ou 3)' },
              margem_minima_pack_pct: { type: 'number', description: 'Margem mínima garantida em %' },
              ano_limite_validade: { type: 'number', description: 'Ano limite de validade para escoar' },
              limite: { type: 'number', description: 'Número de packs a sugerir' },
            },
          },
        },
        {
          name: 'identificar_produtos_sem_vendas_e_escoamento',
          description:
            'Lista produtos com stock parado na farmácia sem qualquer venda nos últimos N meses (Monos), com distinção estrita de Restos de Gaveta (stock <= 2 un).',
          inputSchema: {
            type: 'object',
            properties: {
              meses_sem_venda: { type: 'number', description: 'Número de meses sem vendas (default 6)' },
              apenas_com_stock: { type: 'boolean', description: 'Apenas produtos com unidades em stock' },
              apenas_restos_gaveta: { type: 'boolean', description: 'Filtrar estritamente por restos de gaveta (stock <= 2)' },
              limite: { type: 'number', description: 'Número máximo de registos' },
            },
          },
        },
        {
          name: 'analisar_consolidacao_genericos_dci',
          description:
            'Analisa a dispersão de laboratórios para a mesma substância ativa (DCI) e indica marcas residuais a esgotar antes de nova encomenda.',
          inputSchema: {
            type: 'object',
            properties: {
              molecula_dci: { type: 'string', description: 'Filtrar por molécula específica (ex: Atorvastatina)' },
              max_labs_desejados: { type: 'number', description: 'Número máximo de laboratórios pretendidos (default 2)' },
              limite: { type: 'number', description: 'Máximo de grupos DCI' },
            },
          },
        },
        {
          name: 'planear_compras_sazonais_laboratorio',
          description:
            'Gera o plano anual de compras diretas a laboratórios baseado no histórico sazonal da farmácia.',
          inputSchema: {
            type: 'object',
            properties: {
              tipo_venda: { type: 'string', description: 'Segmento a analisar (default VENDA_LIVRE)' },
              ano_referencia: { type: 'number', description: 'Ano de referência' },
            },
          },
        },
        {
          name: 'sugerir_vendas_cruzadas_receita',
          description:
            'Sugere produtos complementares de venda livre e aconselhamento de balcão para as moléculas de receita mais vendidas.',
          inputSchema: {
            type: 'object',
            properties: {
              top_n_moleculas: { type: 'number', description: 'Número de moléculas a analisar (default 5)' },
            },
          },
        },
        {
          name: 'comparar_similares_e_rentabilidade',
          description:
            'Compara medicamentos similares ou genéricos da mesma indicação, revelando vendas vs margem em €.',
          inputSchema: {
            type: 'object',
            properties: {
              termo_pesquisa: { type: 'string', description: 'Molécula DCI ou nome (ex: "atorvastatina")' },
              apenas_com_stock: { type: 'boolean', description: 'Filtrar apenas com stock' },
              limite: { type: 'number', description: 'Máximo de registos' },
            },
            required: ['termo_pesquisa'],
          },
        },
        {
          name: 'avaliar_acordo_anual_compras_escalonadas',
          description:
            'Avalia o histórico real de vendas de uma marca para propor acordos anuais em tranches escalonadas seguras.',
          inputSchema: {
            type: 'object',
            properties: {
              marca_ou_laboratorio: { type: 'string', description: 'Marca ou gama a avaliar' },
              margem_seguranca_pct: { type: 'number', description: 'Margem de segurança percentual (default 15)' },
              numero_tranches: { type: 'number', description: 'Número de tranches (default 3)' },
            },
            required: ['marca_ou_laboratorio'],
          },
        },
        {
          name: 'calcular_niveis_sazonais_dinamicos',
          description:
            'Calcula stocks mínimos e pontos de encomenda adaptados à fase da estação (Entrada, Pico ou Esgotamento).',
          inputSchema: {
            type: 'object',
            properties: {
              termo_pesquisa: { type: 'string', description: 'Categoria ou produto (ex: "antigripais")' },
            },
            required: ['termo_pesquisa'],
          },
        },
        {
          name: 'auditar_anomalias_margem_e_precos',
          description:
            'Audita o catálogo à procura de margens negativas (venda com prejuízo) ou margem excessivamente baixa (< 5%).',
          inputSchema: {
            type: 'object',
            properties: {
              margem_minima_alerta_pct: { type: 'number', description: 'Margem mínima de alerta (default 5.0)' },
              limite: { type: 'number', description: 'Máximo de anomalias a listar' },
            },
          },
        },
      ];

    const tools = allTools
      .filter((t) => checkToolPermission(perfil, t.name).allowed)
      .map((t) => ({
        ...t,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }));

    advertisedToolNames = new Set(tools.map((t) => t.name));
    return { tools };
  });

  // Conjunto explícito de ferramentas de leitura suportadas pelo servidor MCP (P0 #3: nenhuma ferramenta fora da lista é aceite)
  const MCP_READONLY_ALLOWLIST = new Set([
    'consultar_produtos_por_nome_ou_categoria',
    'consultar_vendas_periodo',
    'comparar_alternativas',
    'analisar_desempenho_laboratorio',
    'calcular_stock_minimo_e_cobertura',
    'identificar_produtos_sem_vendas_e_escoamento',
    'analisar_consolidacao_genericos_dci',
    'planear_compras_sazonais_laboratorio',
    'sugerir_vendas_cruzadas_receita',
    'comparar_similares_e_rentabilidade',
    'avaliar_acordo_anual_compras_escalonadas',
    'calcular_niveis_sazonais_dinamicos',
    'gerar_proposta_encomenda_reposicao',
    'analisar_curva_abc_faturacao_e_margem',
    'auditar_anomalias_margem_e_precos',
    'analisar_evolucao_mensal_financeira',
    'comparar_performance_periodos',
    'auditar_escoamento_e_destrave_stock',
    'calcular_perdas_financeiras_e_custo_oportunidade',
    'filtrar_produtos_por_validade_e_margem',
    'sugerir_packs_promocionais',
    'consultar_campanhas_ativas_e_historico',
  ]);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const t0 = Date.now();

    // P0 #3: Rejeitar estritamente qualquer ferramenta fora da lista anunciada (inclui bloqueio total de ferramentas de escrita)
    if (!MCP_READONLY_ALLOWLIST.has(name) || (advertisedToolNames && !advertisedToolNames.has(name))) {
      const reason = `A ferramenta "${name}" não está disponível neste servidor MCP (apenas ferramentas de leitura listadas são permitidas).`;
      if (options?.onAudit) {
        options.onAudit({
          ferramenta: name,
          parametros: args,
          sucesso: false,
          duracaoMs: Date.now() - t0,
          error: reason,
        }).catch(() => {});
      }
      return {
        isError: true,
        content: [{ type: 'text', text: reason }],
      };
    }

    // 1. Verificação de Permissão do Perfil de Segurança
    const permCheck = checkToolPermission(perfil, name);
    if (!permCheck.allowed) {
      if (options?.onAudit) {
        options.onAudit({
          ferramenta: name,
          parametros: args,
          sucesso: false,
          duracaoMs: Date.now() - t0,
          error: permCheck.reason,
        }).catch(() => {});
      }
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `⛔ [ACESSO RECUSADO POR GOVERNANÇA]: ${permCheck.reason}`,
          },
        ],
      };
    }

    try {
      let result: any;
      switch (name) {
        case 'analisar_evolucao_mensal_financeira':
          result = await toolAnalisarEvolucaoMensalFinanceira(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'comparar_performance_periodos':
          result = await toolCompararPerformancePeriodos(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'auditar_escoamento_e_destrave_stock':
          result = await toolAuditarEscoamentoEDestraveStock(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'calcular_perdas_financeiras_e_custo_oportunidade':
          result = await toolCalcularPerdasFinanceirasECustoOportunidade(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'consultar_vendas_diarias':
          result = await toolConsultarVendasDiarias(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'consultar_produtos_por_nome_ou_categoria':
          result = await toolConsultarProdutosPorNomeOuCategoria(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'consultar_vendas_periodo':
          result = await toolConsultarVendasPeriodo(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'comparar_alternativas':
          result = await toolCompararAlternativasDci(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'analisar_desempenho_laboratorio':
          result = await toolAnalisarDesempenhoLaboratorio(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'comparar_similares_e_rentabilidade':
          result = await toolCompararSimilaresERentabilidade(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'avaliar_acordo_anual_compras_escalonadas':
          result = await toolAvaliarAcordoAnualComprasEscalonadas(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'calcular_niveis_sazonais_dinamicos':
          result = await toolCalcularNiveisSazonaisDinamicos(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'gerar_proposta_encomenda_reposicao':
          result = await toolGerarPropostaEncomendaReposicao(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'analisar_curva_abc_faturacao_e_margem':
          result = await toolAnalisarCurvaAbcFaturacaoEMargem(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'auditar_anomalias_margem_e_precos':
          result = await toolAuditarAnomaliasMargemEPrecos(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'calcular_stock_minimo_e_cobertura':
          result = await toolCalcularStockMinimoECobertura(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'filtrar_produtos_por_validade_e_margem':
          result = await toolFiltrarProdutosPorValidadeEMargem(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'sugerir_packs_promocionais': {
          const repo = createPrismaComercialRepo(prisma, secContext.farmaciaId, 'mcp', 1, args);
          const modo = (args as any)?.modo === 'TEMAS' || (!(args as any)?.campanha_id && !(args as any)?.tema) ? 'TEMAS' : 'PACK';
          result = await sugerirPacksPromocionais(
            {
              modo,
              campanha_id: (args as any)?.campanha_id,
              tema: (args as any)?.tema,
              desconto_pct: (args as any)?.desconto_pct ?? (args as any)?.desconto_percentagem,
              publico: (args as any)?.publico ?? null,
              n_produtos_max: (args as any)?.n_produtos_max,
              incluir_em_campanha: (args as any)?.incluir_em_campanha,
              incluir_preco_fixo: (args as any)?.incluir_preco_fixo,
              liquidacao: (args as any)?.liquidacao,
              data_referencia: (args as any)?.data_referencia,
            },
            { repo, ref: new Date(), cfg: buildComercialCfg() }
          );
          break;
        }
        case 'identificar_produtos_sem_vendas_e_escoamento':
          result = await toolIdentificarProdutosSemVenda(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'analisar_consolidacao_genericos_dci':
          result = await toolConsolidarGenericosDci(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'planear_compras_sazonais_laboratorio':
          result = await toolPlanearComprasSazonais(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'sugerir_vendas_cruzadas_receita':
          result = await toolSugerirVendasCruzadasReceita(prisma, effectiveSecContext, (args as any) || {});
          break;
        case 'consultar_campanhas_ativas_e_historico':
          result = await toolConsultarCampanhasAtivasEHistorico(prisma, effectiveSecContext, (args as any) || {});
          break;
        default:
          throw new Error(`Ferramenta desconhecida ou não permitida no MCP: "${name}"`);
      }

      const sanitizedResult = stripFaturacaoFields(result);

      if (options?.onAudit) {
        options.onAudit({
          ferramenta: name,
          parametros: args,
          sucesso: true,
          duracaoMs: Date.now() - t0,
        }).catch(() => {});
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizedResult, null, 2),
          },
        ],
      };
    } catch (error: any) {
      if (options?.onAudit) {
        options.onAudit({
          ferramenta: name,
          parametros: args,
          sucesso: false,
          duracaoMs: Date.now() - t0,
          error: error.message,
        }).catch(() => {});
      }

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Erro ao executar ferramenta ${name}: ${error.message}`,
          },
        ],
      };
    }
  });

  return server;
}
