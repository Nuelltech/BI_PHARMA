import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
dotenv.config();

import { ensureDatabaseReady } from './db.js';
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
} from './services/mcp_pharma_tools.js';

// ============================================================================
// SERVIDOR MCP (MODEL CONTEXT PROTOCOL) — BI PHARMA
// ----------------------------------------------------------------------------
// Isolamento Rigoroso Multi-Tenant:
// Requer obrigatoriamente a variável PHARMACY_ACCESS_CODE configurada.
// O servidor recusa-se a responder se o código for inválido ou ausente.
// ============================================================================

async function main() {
  const code = (process.env.PHARMACY_ACCESS_CODE || '').trim().toUpperCase();

  if (!code) {
    console.error('❌ [MCP SECURITY ERROR]: PHARMACY_ACCESS_CODE não fornecido nas variáveis de ambiente.');
    console.error('   O servidor MCP recusa-se a iniciar sem autenticação da farmácia.');
    process.exit(1);
  }

  const { prisma } = await ensureDatabaseReady();

  // Validação na base de dados
  const farmacia = await prisma.farmacia.findUnique({
    where: { codigo_acesso: code },
  });

  if (!farmacia) {
    console.error(`❌ [MCP SECURITY ERROR]: Código de acesso "${code}" inválido ou não autorizado.`);
    process.exit(1);
  }

  const secContext: ToolSecurityContext = {
    farmaciaId: farmacia.id,
    farmaciaNome: farmacia.nome,
    nif: farmacia.nif,
  };

  console.error(`🔐 [MCP SERVER ATIVO]: Sessão trancada à ${farmacia.nome} (NIF: ${farmacia.nif})`);

  const server = new Server(
    {
      name: 'bi-pharma-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Lista de Ferramentas Expostas
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'calcular_stock_minimo_e_cobertura',
          description:
            'Calcula o stock mínimo necessário e os dias de cobertura para um período pretendido (ex: 7 dias / 1 semana). Identifica produtos abaixo do mínimo (risco de rutura) e produtos em excesso.',
          inputSchema: {
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
              limite: { type: 'number', description: 'Número máximo de registos (default 25)' },
            },
          },
        },
        {
          name: 'filtrar_produtos_por_validade_e_margem',
          description:
            'Filtra produtos com data de validade até um determinado ano (ex: 2027) e simula o PVP promocional mínimo garantindo que a margem comercial não fica abaixo do limiar (ex: 10%), respeitando o anti-dumping.',
          inputSchema: {
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
          inputSchema: {
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
            'Lista produtos que têm stock parado na farmácia sem qualquer venda nos últimos N meses (ex: 6 meses), sugerindo a estratégia de escoamento correta (troca de laboratório no Sifarma, dispensa prioritária na gaveta ou pack de balcão).',
          inputSchema: {
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
              limite: { type: 'number', description: 'Número máximo de registos (default 30)' },
            },
          },
        },
        {
          name: 'analisar_consolidacao_genericos_dci',
          description:
            'Analisa a dispersão de laboratórios para a mesma substância ativa e dosagem (DCI). Compara com o número máximo de laboratórios pretendido e indica quais as marcas residuais no fundo da gaveta que devem ser esgotadas antes de encomendar novo stock.',
          inputSchema: {
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
          inputSchema: {
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
          inputSchema: {
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
          name: 'consultar_produtos_por_nome_ou_categoria',
          description:
            'Pesquisa e detalha produtos da farmácia por nome comercial, marca, substância DCI, código CNP ou categoria (ex: "ben-u-gripe", "cegripe", "antigripais", "brufen", "preservativos", "vitamina c"). Devolve stock atual, vendas nos últimos 12 meses, VMM, dias e meses de cobertura, margem comercial e um diagnóstico direto sobre se se deve ou não encomendar.',
          inputSchema: {
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
      ],
    };
  });

  // Execução das Ferramentas com Restrição Rigorosa ao Contexto da Farmácia
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;
      switch (name) {
        case 'consultar_produtos_por_nome_ou_categoria':
          result = await toolConsultarProdutosPorNomeOuCategoria(prisma, secContext, (args as any) || {});
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal MCP Error:', err);
  process.exit(1);
});
