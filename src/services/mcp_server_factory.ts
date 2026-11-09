import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PrismaClient } from '@prisma/client';
import {
  ToolSecurityContext,
  toolCalcularStockMinimoECobertura,
  toolFiltrarValidadeEMargem,
  toolSugerirPacksPromocionais,
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
  toolCalcularPerdasFinanceirasECustoOportunidade,
  toolConsultarVendasDiarias,
  toolConsultarCampanhasAtivasEHistorico,
  toolAtivarCampanhaFarmacia,
} from './mcp_pharma_tools.js';

export function createPharmaMcpServer(prisma: PrismaClient, secContext: ToolSecurityContext): Server {
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
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
            'Pesquisa e detalha produtos da farmácia por nome comercial, marca, substância DCI, código CNP ou categoria. Devolve stock atual, histórico real mês a mês, VMM, dias de cobertura e parecer de compras.',
          inputSchema: {
            type: 'object',
            properties: {
              termo_pesquisa: { type: 'string', description: 'Nome do produto, marca, categoria ou CNP' },
              apenas_com_stock: { type: 'boolean', description: 'Filtrar apenas produtos com stock físico > 0' },
              limite: { type: 'number', description: 'Número máximo de registos (default 20)' },
            },
            required: ['termo_pesquisa'],
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
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: any;
      switch (name) {
        case 'analisar_evolucao_mensal_financeira':
          result = await toolAnalisarEvolucaoMensalFinanceira(prisma, secContext, (args as any) || {});
          break;
        case 'comparar_performance_periodos':
          result = await toolCompararPerformancePeriodos(prisma, secContext, (args as any) || {});
          break;
        case 'calcular_perdas_financeiras_e_custo_oportunidade':
          result = await toolCalcularPerdasFinanceirasECustoOportunidade(prisma, secContext, (args as any) || {});
          break;
        case 'consultar_vendas_diarias':
          result = await toolConsultarVendasDiarias(prisma, secContext, (args as any) || {});
          break;
        case 'consultar_produtos_por_nome_ou_categoria':
          result = await toolConsultarProdutosPorNomeOuCategoria(prisma, secContext, (args as any) || {});
          break;
        case 'comparar_similares_e_rentabilidade':
          result = await toolCompararSimilaresERentabilidade(prisma, secContext, (args as any) || {});
          break;
        case 'avaliar_acordo_anual_compras_escalonadas':
          result = await toolAvaliarAcordoAnualComprasEscalonadas(prisma, secContext, (args as any) || {});
          break;
        case 'calcular_niveis_sazonais_dinamicos':
          result = await toolCalcularNiveisSazonaisDinamicos(prisma, secContext, (args as any) || {});
          break;
        case 'gerar_proposta_encomenda_reposicao':
          result = await toolGerarPropostaEncomendaReposicao(prisma, secContext, (args as any) || {});
          break;
        case 'analisar_curva_abc_faturacao_e_margem':
          result = await toolAnalisarCurvaAbcFaturacaoEMargem(prisma, secContext, (args as any) || {});
          break;
        case 'auditar_anomalias_margem_e_precos':
          result = await toolAuditarAnomaliasMargemEPrecos(prisma, secContext, (args as any) || {});
          break;
        case 'calcular_stock_minimo_e_cobertura':
          result = await toolCalcularStockMinimoECobertura(prisma, secContext, (args as any) || {});
          break;
        case 'filtrar_produtos_por_validade_e_margem':
          result = await toolFiltrarValidadeEMargem(prisma, secContext, (args as any) || {});
          break;
        case 'sugerir_packs_promocionais':
          result = await toolSugerirPacksPromocionais(prisma, secContext, (args as any) || {});
          break;
        case 'identificar_produtos_sem_vendas_e_escoamento':
          result = await toolIdentificarProdutosSemVenda(prisma, secContext, (args as any) || {});
          break;
        case 'analisar_consolidacao_genericos_dci':
          result = await toolConsolidarGenericosDci(prisma, secContext, (args as any) || {});
          break;
        case 'planear_compras_sazonais_laboratorio':
          result = await toolPlanearComprasSazonais(prisma, secContext, (args as any) || {});
          break;
        case 'sugerir_vendas_cruzadas_receita':
          result = await toolSugerirVendasCruzadasReceita(prisma, secContext, (args as any) || {});
          break;
        case 'consultar_campanhas_ativas_e_historico':
          result = await toolConsultarCampanhasAtivasEHistorico(prisma, secContext, (args as any) || {});
          break;
        case 'ativar_campanha_farmacia':
          result = await toolAtivarCampanhaFarmacia(prisma, secContext, (args as any) || {});
          break;
        default:
          throw new Error(`Ferramenta desconhecida: "${name}"`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
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
