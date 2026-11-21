import { PrismaClient } from '@prisma/client';
import {
  ToolSecurityContext,
  toolAnalisarEvolucaoMensalFinanceira,
  toolCompararPerformancePeriodos,
  toolConsultarVendasDiarias,
  toolAuditarEscoamentoEDestraveStock,
  toolCalcularPerdasFinanceirasECustoOportunidade,
  toolPlanearComprasSazonais,
  toolAvaliarAcordoAnualComprasEscalonadas,
} from './mcp_pharma_tools.js';
import { getStockEvolutionAnalytics } from './stock_evolution';
import { saveToolResult, ToolResultEnvelope } from './copilot_result_store';
import { executeCopilotSqlSandbox } from '../platform/copilot_sql_sandbox';
import type { Permission } from './auth_permissions';

// ============================================================================
// CAMADA SEMÂNTICA & FERRAMENTAS PRIMÁRIAS NEUTRAS (ENVELOPE TABULAR)
// ----------------------------------------------------------------------------
// Regras de ouro:
// - Todas as ferramentas de dados devolvem o envelope neutro:
//   { ok, result_id, ferramenta, meta, colunas, linhas, totais }
// - Sem frases imperativas, sem emojis, sem juízos pré-fabricados.
// - Word-boundary estrito para pesquisas de laboratório (ex: "Bial" != "Labial").
// ============================================================================

const FORBIDDEN_SQL_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXECUTE|CALL|COPY|VACUUM|ANALYZE|LOCK|LISTEN|NOTIFY|UNLISTEN|REINDEX|CLUSTER|SECURITY|OWNER|SET\s+ROLE|SET\s+SESSION|pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink)\b/i;

const FORBIDDEN_TABLES =
  /\b(Utilizador|SessaoUtilizador|SessaoAdmin|TokenRecuperacao|McpConnector|McpAuditLog|Organizacao|Farmacia|CopilotUsageLog|StagingInventario|StagingVendas|StagingValidades|faturas_processadas|resumos_lote|faturas_nuelltech|pg_catalog|information_schema)\b/i;

const PEDIATRIC_REGEX = /\b(baby|bebe|bebé|pediatr|infantil|crianca|criança|lactente|recem|recém|nancare)\b/i;

function serializeValue(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') return Number(val);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'object') {
    if (typeof val.toNumber === 'function') return val.toNumber();
    if (Array.isArray(val)) return val.map(serializeValue);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) out[k] = serializeValue(v);
    return out;
  }
  return val;
}

function escapeRx(s: string): string {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAccents(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function matchesLabFilter(labTitular: string | null | undefined, designacao: string, filtroLab: string): boolean {
  const f = (filtroLab || '').trim();
  if (!f) return true;
  const esc = escapeRx(f);
  const wordRx = new RegExp(`\\b${esc}\\b`, 'i');
  const prefixRx = new RegExp(`^${esc}`, 'i');
  const lab = (labTitular || '').trim();
  if (lab) return wordRx.test(lab);
  return wordRx.test(designacao) || prefixRx.test(designacao);
}

export function computeSafeMarginPct(
  custoUnit: number,
  pvp: number | null,
  margemPadrao: number | null
): number | null {
  if (custoUnit > 0 && pvp !== null && pvp > 0) {
    return Number((((pvp - custoUnit) / pvp) * 100).toFixed(1));
  }
  if (margemPadrao !== null && margemPadrao > 0 && margemPadrao < 99.9) {
    return Number(Number(margemPadrao).toFixed(1));
  }
  return null;
}

// ============================================================================
// 1. DESCREVER DADOS (DICIONÁRIO SEMÂNTICO)
// ============================================================================
export async function toolDescreverDados(_prisma: PrismaClient, ctx: ToolSecurityContext) {
  return {
    ok: true,
    ferramenta: 'descrever_dados',
    meta: { farmacia: ctx.farmaciaNome },
    definicoesNegocioCanonicas: {
      mono: 'stock_total_unidades > 0 e sem vendas há >= 90 dias (eh_mono = true).',
      resto_de_gaveta: 'stock_total_unidades BETWEEN 1 AND 2 (eh_resto_gaveta = true). Não exclusivo com mono.',
      excesso_cobertura: 'cobertura_meses > 4 e stock_total_unidades > 0 (eh_excesso_cobertura = true).',
      msrm_regra_legal:
        'tipo_venda = \'MSRM\': preço fixado pelo Estado, proibido incluir em packs, descontos ou venda cruzada.',
      margem_mensal: 'Calculada por estimativa com base no custo_unitario_medio atual (margem_metodo: estimada_custo_medio_atual).',
    },
    vistasDisponiveisParaSql: {
      v_metricas: [
        'cnp_codigo',
        'designacao',
        'laboratorio_titular',
        'molecula_dci',
        'grupo_equivalencia_dci',
        'tipo_venda',
        'segmento',
        'eh_generico',
        'categoria',
        'subcategoria',
        'stock_total_unidades',
        'stock_total_valor_custo',
        'custo_unitario_medio',
        'pvp',
        'margem_padrao',
        'total_unidades_vendidas',
        'vmm',
        'cobertura_meses',
        'data_ultima_venda',
        'dias_sem_vendas',
        'eh_mono',
        'eh_resto_gaveta',
        'eh_excesso_cobertura',
        'unidades_excesso',
        'capital_excesso',
        'data_validade_mais_proxima',
        'meses_ate_validade',
        'eh_risco_caducidade',
        'unidades_em_risco_caducidade',
        'valor_em_risco_caducidade',
        'eh_risco_rutura',
      ],
      v_vendas_mes: ['cnp_codigo', 'mes', 'quantidade', 'valor_total'],
      v_grupos_dci: [
        'grupo_equivalencia_dci',
        'num_laboratorios_abertos',
        'stock_total_unidades',
        'stock_total_valor_custo',
        'vmm_total_grupo',
        'custo_minimo',
        'custo_maximo',
        'poupanca_potencial_anual',
        'labsJson',
      ],
      v_catalogo: [
        'cnp_codigo',
        'designacao',
        'dci',
        'dosagem',
        'forma_farmaceutica',
        'embalagem',
        'laboratorio_titular',
        'tipo_venda',
        'macro_area',
        'categoria',
        'subcategoria',
        'sazonalidade',
        'indicacoes_clinicas',
        'papel_recomendacao',
        'contraindicacoes_aviso',
        'fonte_enriquecimento',
        'publico_alvo',
        'pvp',
        'margem_padrao',
      ],
      v_snapshots: ['cnp_codigo', 'data_snapshot', 'quantidade', 'custo_unitario', 'valor_total'],
      v_kpis: [
        'total_artigos_inventario',
        'total_unidades_stock',
        'valor_total_stock_custo',
        'total_artigos_monos',
        'valor_total_monos',
        'total_artigos_restos_gaveta',
        'valor_total_restos_gaveta',
        'total_artigos_risco_caducidade',
        'valor_total_risco_caducidade',
        'data_ultima_venda',
      ],
    },
  };
}

// ============================================================================
// 2. CONSULTAR SQL (READ-ONLY SOBRE VISTAS MULTI-TENANT)
// ============================================================================
export function validateAndRewriteReadOnlySql(
  rawSql: string,
  farmaciaId: string,
  maxRows = 100
): {
  ok: boolean;
  error?: string;
  finalSql?: string;
} {
  if (!rawSql || typeof rawSql !== 'string') {
    return { ok: false, error: 'Query SQL vazia.' };
  }

  const cleaned = rawSql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .replace(/;+\s*$/, '');

  if (!cleaned) {
    return { ok: false, error: 'Query SQL vazia após remoção de comentários.' };
  }

  if (cleaned.includes(';')) {
    return { ok: false, error: 'Apenas uma instrução SELECT é permitida por chamada.' };
  }

  if (!/^(SELECT|WITH)\b/i.test(cleaned)) {
    return { ok: false, error: 'Apenas consultas iniciadas por SELECT ou WITH são permitidas.' };
  }

  const badKw = cleaned.match(FORBIDDEN_SQL_KEYWORDS);
  if (badKw) {
    return { ok: false, error: `Comando SQL não permitido: "${badKw[0]}".` };
  }

  const badTbl = cleaned.match(FORBIDDEN_TABLES);
  if (badTbl) {
    return {
      ok: false,
      error: `Tabela "${badTbl[0]}" não acessível. Use: v_metricas, v_vendas_mes, v_grupos_dci, v_catalogo, v_snapshots, v_kpis.`,
    };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(farmaciaId)) {
    return { ok: false, error: 'Identificador de farmácia inválido.' };
  }

  const rewritten = cleaned
    .replace(/"?MartProdutoMetricas"?/gi, 'v_metricas')
    .replace(/"?MartProdutoMes"?/gi, 'v_vendas_mes')
    .replace(/"?MartDciGrupo"?/gi, 'v_grupos_dci')
    .replace(/"?MartTenantKpis"?/gi, 'v_kpis')
    .replace(/"?InventarioSnapshot"?/gi, 'v_snapshots')
    .replace(/"?Inventario"?/gi, 'v_inventario')
    .replace(/"?PrecoFarmacia"?/gi, 'v_precos')
    .replace(/"?Venda"?/gi, 'v_vendas')
    .replace(/"?ProdutoMestre"?/gi, 'v_catalogo');

  const safeLimit = Math.min(Math.max(Number(maxRows) || 100, 1), 500);

  const ctes = `
    WITH
      v_metricas AS (
        SELECT *, ("stock_total_unidades" BETWEEN 1 AND 2) AS eh_resto_gaveta
        FROM "MartProdutoMetricas"
        WHERE "farmaciaId" = '${farmaciaId}'
      ),
      v_vendas_mes AS (SELECT * FROM "MartProdutoMes" WHERE "farmaciaId" = '${farmaciaId}'),
      v_grupos_dci AS (SELECT * FROM "MartDciGrupo" WHERE "farmaciaId" = '${farmaciaId}'),
      v_kpis AS (SELECT * FROM "MartTenantKpis" WHERE "farmaciaId" = '${farmaciaId}'),
      v_snapshots AS (SELECT * FROM "InventarioSnapshot" WHERE "farmaciaId" = '${farmaciaId}'),
      v_inventario AS (SELECT * FROM "Inventario" WHERE "farmaciaId" = '${farmaciaId}'),
      v_precos AS (SELECT * FROM "PrecoFarmacia" WHERE "farmaciaId" = '${farmaciaId}'),
      v_vendas AS (SELECT * FROM "Venda" WHERE "farmaciaId" = '${farmaciaId}'),
      v_catalogo AS (
        SELECT *,
          CASE
            WHEN designacao ~* '\\y(baby|bebe|bebé|pediatr|infantil|crianca|criança|lactente|recem|recém|nancare)\\y'
            THEN 'PEDIATRICO'
            ELSE 'ADULTO_GERAL'
          END AS publico_alvo
        FROM "ProdutoMestre"
      ),
      __user_query AS (${rewritten})
    SELECT * FROM __user_query LIMIT ${safeLimit}
  `.trim();

  return { ok: true, finalSql: ctes };
}

export async function toolConsultarSql(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { sql: string; limite?: number },
  sessionId = 'default',
  turno = 1
) {
  const perms: Set<Permission> = (ctx as any).permissoes instanceof Set
    ? (ctx as any).permissoes
    : new Set<Permission>(Array.isArray((ctx as any).permissoes) ? (ctx as any).permissoes : ['ver_stock_validades']);

  const sandboxRes = await executeCopilotSqlSandbox(prisma, ctx.farmaciaId, perms, args.sql);
  if (!sandboxRes.ok || !sandboxRes.rows) {
    return {
      ok: false,
      sucesso: false,
      erro: { codigo: 'SQL_INVALIDO', mensagem: sandboxRes.error || 'SQL inválido.' },
    };
  }

  try {
    const rowsObj = serializeValue(sandboxRes.rows) as Record<string, any>[];
    const colunas = rowsObj.length > 0 ? Object.keys(rowsObj[0]) : [];
    const linhas = rowsObj.map((r) => colunas.map((c) => r[c] ?? null));

    const env = saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_sql',
      input: args,
      meta: { n_linhas_total: linhas.length, role: sandboxRes.role },
      colunas,
      linhas,
      limiteModelo: args.limite || 100,
    });

    return {
      ...env,
      sucesso: true,
      totalLinhasDevolvidas: linhas.length,
      linhasObjetos: rowsObj.slice(0, 100),
    };
  } catch (err: any) {
    return {
      ok: false,
      sucesso: false,
      erro: { codigo: 'ERRO_EXECUCAO_SQL', mensagem: err.message },
    };
  }
}

// ============================================================================
// 3. FICHA PRODUTO (TODOS OS FACTOS DE UM CNP OU TERMO)
// ============================================================================
export async function toolFichaProduto(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { cnp?: string; termo?: string },
  sessionId = 'default',
  turno = 1
) {
  const cnp = (args.cnp || '').trim();
  const termo = (args.termo || '').trim();
  if (!cnp && !termo) {
    return {
      ok: false,
      encontrado: false,
      erro: { codigo: 'PARAMETRO_EM_FALTA', mensagem: 'Indique cnp ou termo.' },
    };
  }

  const metricas = await prisma.martProdutoMetricas.findMany({
    where: {
      farmaciaId: ctx.farmaciaId,
      ...(cnp
        ? { cnp_codigo: cnp }
        : {
            OR: [
              { designacao: { contains: termo, mode: 'insensitive' } },
              { molecula_dci: { contains: termo, mode: 'insensitive' } },
              { laboratorio_titular: { contains: termo, mode: 'insensitive' } },
            ],
          }),
    },
    orderBy: { total_unidades_vendidas: 'desc' },
    take: 20,
  });

  if (metricas.length === 0) {
    return {
      ok: true,
      encontrado: false,
      meta: { n_linhas_total: 0, filtros_aplicados: args },
      colunas: [],
      linhas: [],
      produtos: [],
    };
  }

  const cnps = metricas.map((m) => m.cnp_codigo);
  const [catalogo, vendasMes] = await Promise.all([
    prisma.produtoMestre.findMany({ where: { cnp_codigo: { in: cnps } } }),
    prisma.martProdutoMes.findMany({
      where: { farmaciaId: ctx.farmaciaId, cnp_codigo: { in: cnps } },
      orderBy: { mes: 'asc' },
    }),
  ]);

  const catMap = new Map(catalogo.map((c) => [c.cnp_codigo, c]));
  const dciSet = new Set<string>();
  for (const m of metricas) {
    const c = catMap.get(m.cnp_codigo);
    const d = (c?.dci || m.molecula_dci || '').trim();
    if (d) dciSet.add(d);
  }

  const similaresDci =
    dciSet.size > 0
      ? await prisma.martProdutoMetricas.findMany({
          where: {
            farmaciaId: ctx.farmaciaId,
            molecula_dci: { in: [...dciSet], mode: 'insensitive' },
          },
          orderBy: { total_unidades_vendidas: 'desc' },
          take: 25,
        })
      : [];

  const produtos = metricas.map((m) => {
    const cat = catMap.get(m.cnp_codigo);
    const custo = Number(m.custo_unitario_medio || 0);
    const pvp = m.pvp !== null ? Number(m.pvp) : null;
    const margemReal = computeSafeMarginPct(
      custo,
      pvp,
      m.margem_padrao !== null ? Number(m.margem_padrao) : null
    );

    const hist = vendasMes
      .filter((v) => v.cnp_codigo === m.cnp_codigo)
      .map((v) => ({ mes: v.mes, unidades: v.quantidade, valor_eur: Number(v.valor_total) }));

    const dciOficial = cat?.dci || m.molecula_dci || null;
    const concorrentes = dciOficial
      ? similaresDci
          .filter(
            (s) =>
              s.cnp_codigo !== m.cnp_codigo &&
              (s.molecula_dci || '').toLowerCase() === dciOficial.toLowerCase()
          )
          .slice(0, 6)
          .map((s) => ({
            cnp_codigo: s.cnp_codigo,
            designacao: s.designacao,
            laboratorio_titular: s.laboratorio_titular || null,
            stock_total_unidades: s.stock_total_unidades,
            vendas_12m_un: s.total_unidades_vendidas,
            custo_unitario_medio: Number(s.custo_unitario_medio),
            pvp: s.pvp !== null ? Number(s.pvp) : null,
          }))
      : [];

    return {
      cnp: m.cnp_codigo,
      cnp_codigo: m.cnp_codigo,
      designacao: m.designacao,
      laboratorioTitular: cat?.laboratorio_titular || m.laboratorio_titular || 'Sem dados',
      laboratorio_titular: cat?.laboratorio_titular || m.laboratorio_titular || null,
      dci: dciOficial || 'Sem dados',
      dosagem: cat?.dosagem || null,
      forma_farmaceutica: cat?.forma_farmaceutica || null,
      tipo_venda: cat?.tipo_venda || m.tipo_venda || null,
      categoria: cat?.categoria || m.categoria || null,
      subcategoria: cat?.subcategoria || m.subcategoria || null,
      papel_recomendacao: cat?.papel_recomendacao || null,
      indicacoes_clinicas: cat?.indicacoes_clinicas || null,
      publico_alvo: PEDIATRIC_REGEX.test(m.designacao) ? 'PEDIATRICO' : 'ADULTO_GERAL',
      stock_total_unidades: m.stock_total_unidades,
      custo_unitario_medio: custo > 0 ? Number(custo.toFixed(2)) : null,
      pvp: pvp,
      margem_pct: margemReal,
      vendas_12m_un: m.total_unidades_vendidas,
      vmm: Number(m.vmm),
      cobertura_meses: Number(m.cobertura_meses),
      eh_mono: m.eh_mono,
      eh_resto_gaveta: m.stock_total_unidades >= 1 && m.stock_total_unidades <= 2,
      eh_excesso_cobertura: m.eh_excesso_cobertura,
      data_validade_mais_proxima: m.data_validade_mais_proxima
        ? m.data_validade_mais_proxima.toISOString().slice(0, 10)
        : null,
      historico_mensal: hist,
      similares_mesma_dci: concorrentes,
    };
  });

  const colunas = [
    'cnp_codigo',
    'designacao',
    'laboratorio_titular',
    'dci',
    'tipo_venda',
    'stock_total_unidades',
    'custo_unitario_medio',
    'pvp',
    'margem_pct',
    'vendas_12m_un',
    'vmm',
    'cobertura_meses',
    'eh_mono',
    'eh_resto_gaveta',
  ];
  const linhas = produtos.map((p) => [
    p.cnp_codigo,
    p.designacao,
    p.laboratorio_titular,
    p.dci === 'Sem dados' ? null : p.dci,
    p.tipo_venda,
    p.stock_total_unidades,
    p.custo_unitario_medio,
    p.pvp,
    p.margem_pct,
    p.vendas_12m_un,
    p.vmm,
    p.cobertura_meses,
    p.eh_mono,
    p.eh_resto_gaveta,
  ]);

  const env = saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'ficha_produto',
    input: args,
    meta: { filtros_aplicados: args, n_linhas_total: linhas.length },
    colunas,
    linhas,
  });

  return {
    ...env,
    encontrado: true,
    produtos,
  };
}

// ============================================================================
// 4. CONSULTAR VENDAS (PRIMITIVA NEUTRA TABULAR)
// ============================================================================
export interface FiltrosComuns {
  laboratorio?: string;
  dci?: string;
  cnp?: string[];
  texto?: string;
  categoria?: string;
  tipo_venda?: 'MSRM' | 'MNSRM' | 'VENDA_LIVRE';
  segmento?: string;
  eh_generico?: boolean;
  flags?: Array<
    | 'eh_mono'
    | 'eh_excesso_cobertura'
    | 'eh_risco_caducidade'
    | 'eh_risco_rutura'
    | 'eh_resto_gaveta'
    | 'anomalia_custo_gt_pvp'
    | 'margem_negativa'
  >;
  stock_min?: number;
  stock_max?: number;
}

export async function toolConsultarVendas(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    filtros?: FiltrosComuns;
    periodo?: { de?: string; ate?: string };
    granularidade?: 'total' | 'mes' | 'dia';
    agrupar_por?: 'nenhum' | 'produto' | 'laboratorio' | 'dci' | 'categoria' | 'segmento';
    metricas?: string[];
    comparar_com?: { de: string; ate: string };
    ordenar?: { campo: string; dir?: 'asc' | 'desc' };
    limite?: number;
    data_dia?: string;
  },
  sessionId = 'default',
  turno = 1
): Promise<ToolResultEnvelope> {
  const filtros = args.filtros || {};
  const granularidade = args.granularidade || 'total';
  const agruparPor = args.agrupar_por || 'produto';
  const limite = Math.min(Math.max(args.limite || 50, 1), 200);

  // Caso 1: Vendas diárias
  if (granularidade === 'dia') {
    const resDia: any = await toolConsultarVendasDiarias(prisma, ctx, {
      data: args.data_dia || args.periodo?.de,
      cnp_ou_nome: filtros.texto || filtros.laboratorio,
      limite,
    });
    const top = resDia.topProdutosNoPeriodo || [];
    const colunas = ['cnp_codigo', 'designacao', 'unidades', 'valor_eur'];
    const linhas = top.map((p: any) => [p.cnp, p.designacao, p.unidades, p.faturacaoEur]);
    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_vendas',
      input: args,
      meta: {
        granularidade: 'dia',
        periodo: { de: resDia.dataInicioAnalisada, ate: resDia.dataFimAnalisada },
        unidades: { quantidade: 'un', valor: 'EUR' },
        n_linhas_total: linhas.length,
      },
      colunas,
      linhas,
      totais: resDia.resumoGeral || {},
      limiteModelo: limite,
    });
  }

  // Caso 2: Evolução mensal agregada da farmácia (sem filtro de produto/lab e agrupado por mês)
  if (
    granularidade === 'mes' &&
    agruparPor === 'nenhum' &&
    !filtros.laboratorio &&
    !filtros.dci &&
    !filtros.texto &&
    (!filtros.cnp || filtros.cnp.length === 0)
  ) {
    const resMes: any = await toolAnalisarEvolucaoMensalFinanceira(prisma, ctx, {
      categoria_ou_macro: filtros.categoria || filtros.tipo_venda,
      ordenar_por: 'CRONOLOGICO',
    });
    const serie = resMes.serieMensalCompleta || [];
    const colunas = ['mes', 'unidades', 'valor_eur', 'custo_mercadoria_eur', 'margem_eur', 'margem_pct_est'];
    const linhas = serie.map((m: any) => [
      m.mes,
      m.unidadesVendidas,
      m.faturacaoBrutaEur,
      m.custoMercadoriaVendidaEur,
      m.margemBrutaEur,
      m.margemBrutaPct,
    ]);
    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_vendas',
      input: args,
      meta: {
        granularidade: 'mes',
        unidades: { quantidade: 'un', valor: 'EUR' },
        margem_metodo: 'estimada_custo_medio_atual',
        filtros_aplicados: filtros,
        n_linhas_total: linhas.length,
      },
      colunas,
      linhas,
      totais: resMes.resumoAnual || {},
      limiteModelo: limite,
    });
  }

  // Caso 3: Consulta geral de vendas por produto / laboratório / DCI / categoria (com 3 últimos meses e comparar_com opcional)
  const [rawMarts, allCatalog, allMeses] = await Promise.all([
    prisma.martProdutoMetricas.findMany({
      where: { farmaciaId: ctx.farmaciaId },
    }),
    prisma.produtoMestre.findMany({
      select: {
        cnp_codigo: true,
        dci: true,
        laboratorio_titular: true,
        categoria: true,
        subcategoria: true,
        tipo_venda: true,
      },
    }),
    prisma.martProdutoMes.findMany({
      where: { farmaciaId: ctx.farmaciaId },
      select: { cnp_codigo: true, mes: true, quantidade: true, valor_total: true },
    }),
  ]);

  const catMap = new Map(allCatalog.map((c) => [c.cnp_codigo, c]));

  // Filtrar produtos pelas condições pedidas
  const filteredMarts = rawMarts.filter((m) => {
    const cat = catMap.get(m.cnp_codigo);
    const lab = cat?.laboratorio_titular || m.laboratorio_titular || null;
    const dci = cat?.dci || m.molecula_dci || null;
    const categoria = cat?.categoria || m.categoria || '';
    const tipoVenda = cat?.tipo_venda || m.tipo_venda || '';
    const stock = m.stock_total_unidades;
    const ehRestoGaveta = stock >= 1 && stock <= 2;

    if (filtros.laboratorio && !matchesLabFilter(lab, m.designacao, filtros.laboratorio)) return false;
    if (filtros.dci && !stripAccents(dci || '').includes(stripAccents(filtros.dci))) return false;
    if (filtros.cnp && filtros.cnp.length > 0 && !filtros.cnp.includes(m.cnp_codigo)) return false;
    if (filtros.categoria && !stripAccents(categoria).includes(stripAccents(filtros.categoria))) return false;
    if (filtros.tipo_venda && tipoVenda !== filtros.tipo_venda) return false;
    if (filtros.segmento && m.segmento !== filtros.segmento) return false;
    if (filtros.eh_generico !== undefined && m.eh_generico !== filtros.eh_generico) return false;
    if (filtros.stock_min !== undefined && stock < filtros.stock_min) return false;
    if (filtros.stock_max !== undefined && stock > filtros.stock_max) return false;

    if (filtros.texto) {
      const q = stripAccents(filtros.texto);
      const hay = stripAccents(`${m.cnp_codigo} ${m.designacao} ${dci || ''} ${lab || ''} ${categoria}`);
      if (q.length <= 5) {
        if (!new RegExp(`\\b${escapeRx(q)}`, 'i').test(hay)) return false;
      } else if (!hay.includes(q)) {
        return false;
      }
    }

    if (Array.isArray(filtros.flags) && filtros.flags.length > 0) {
      for (const fl of filtros.flags) {
        if (fl === 'eh_mono' && !m.eh_mono) return false;
        if (fl === 'eh_excesso_cobertura' && !m.eh_excesso_cobertura) return false;
        if (fl === 'eh_risco_caducidade' && !m.eh_risco_caducidade) return false;
        if (fl === 'eh_risco_rutura' && !m.eh_risco_rutura) return false;
        if (fl === 'eh_resto_gaveta' && !ehRestoGaveta) return false;
      }
    }

    return true;
  });

  // Indexar vendas mensais para os CNPs filtrados
  const cnpSet = new Set(filteredMarts.map((m) => m.cnp_codigo));
  const mesesGlobalSet = new Set<string>();
  const salesByCnpMonth = new Map<string, Map<string, { un: number; eur: number }>>();

  for (const vm of allMeses) {
    mesesGlobalSet.add(vm.mes);
    if (!cnpSet.has(vm.cnp_codigo)) continue;
    let mapCnp = salesByCnpMonth.get(vm.cnp_codigo);
    if (!mapCnp) {
      mapCnp = new Map();
      salesByCnpMonth.set(vm.cnp_codigo, mapCnp);
    }
    const cur = mapCnp.get(vm.mes) || { un: 0, eur: 0 };
    cur.un += vm.quantidade;
    cur.eur += Number(vm.valor_total || 0);
    mapCnp.set(vm.mes, cur);
  }

  const todosMesesOrd = [...mesesGlobalSet].sort();
  const ultimos12 = todosMesesOrd.slice(-12);
  const periodoDe = args.periodo?.de || ultimos12[0] || '2025-11';
  const periodoAte = args.periodo?.ate || ultimos12[ultimos12.length - 1] || '2026-10';
  const ultimos3Meses = todosMesesOrd.filter((m) => m <= periodoAte).slice(-3);
  const [m1, m2, m3] =
    ultimos3Meses.length === 3 ? ultimos3Meses : ['2026-08', '2026-09', '2026-10'];

  const colM1 = `vnd_${m1.replace('-', '_')}`;
  const colM2 = `vnd_${m2.replace('-', '_')}`;
  const colM3 = `vnd_${m3.replace('-', '_')}`;

  let totalVendasUn = 0;
  let totalVendasEur = 0;
  let nComVendas = 0;
  let nSemVendas = 0;
  let dciNulaCount = 0;

  const prodRows = filteredMarts.map((m) => {
    const cat = catMap.get(m.cnp_codigo);
    const dci = cat?.dci || m.molecula_dci || null;
    if (!dci) dciNulaCount++;
    const lab = cat?.laboratorio_titular || m.laboratorio_titular || null;

    const mapMes = salesByCnpMonth.get(m.cnp_codigo) || new Map<string, { un: number; eur: number }>();
    let vndUnPeriodo = 0;
    let vndEurPeriodo = 0;
    let compUn = 0;
    let compEur = 0;

    for (const [mesKey, val] of mapMes.entries()) {
      if (mesKey >= periodoDe && mesKey <= periodoAte) {
        vndUnPeriodo += val.un;
        vndEurPeriodo += val.eur;
      }
      if (args.comparar_com && mesKey >= args.comparar_com.de && mesKey <= args.comparar_com.ate) {
        compUn += val.un;
        compEur += val.eur;
      }
    }

    // Quando o utilizador não filtrou um sub-período específico, usa total_unidades_vendidas canónico de 12M
    if (!args.periodo) {
      vndUnPeriodo = m.total_unidades_vendidas;
    }

    totalVendasUn += vndUnPeriodo;
    totalVendasEur += vndEurPeriodo;
    if (vndUnPeriodo > 0) nComVendas++;
    else nSemVendas++;

    const q1 = mapMes.get(m1)?.un || 0;
    const q2 = mapMes.get(m2)?.un || 0;
    const q3 = mapMes.get(m3)?.un || 0;

    const custo = Number(m.custo_unitario_medio || 0);
    const pvp = m.pvp !== null ? Number(m.pvp) : null;
    const margemEst = computeSafeMarginPct(
      custo,
      pvp,
      m.margem_padrao !== null ? Number(m.margem_padrao) : null
    );

    return {
      cnp_codigo: m.cnp_codigo,
      designacao: m.designacao,
      laboratorio_titular: lab,
      dci,
      categoria: cat?.categoria || m.categoria || null,
      segmento: m.segmento || null,
      vendas_12m_un: vndUnPeriodo,
      vendas_12m_eur: Number(vndEurPeriodo.toFixed(2)),
      vmm: Number(m.vmm),
      [colM1]: q1,
      [colM2]: q2,
      [colM3]: q3,
      margem_pct_est: margemEst,
      stock_total_unidades: m.stock_total_unidades,
      eh_mono: m.eh_mono,
      eh_resto_gaveta: m.stock_total_unidades >= 1 && m.stock_total_unidades <= 2,
      ...(args.comparar_com
        ? {
            unidades_a: vndUnPeriodo,
            unidades_b: compUn,
            unidades_delta: vndUnPeriodo - compUn,
            valor_eur_a: Number(vndEurPeriodo.toFixed(2)),
            valor_eur_b: Number(compEur.toFixed(2)),
            valor_eur_delta: Number((vndEurPeriodo - compEur).toFixed(2)),
          }
        : {}),
    };
  });

  // Ordenação determinística em código
  const sortField = args.ordenar?.campo || 'vendas_12m_un';
  const sortDir = (args.ordenar?.dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  prodRows.sort((a: any, b: any) => {
    const va = a[sortField] ?? a.vendas_12m_un ?? 0;
    const vb = b[sortField] ?? b.vendas_12m_un ?? 0;
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return (va - vb) * sortDir;
      return (b.vendas_12m_eur - a.vendas_12m_eur);
    }
    return String(va).localeCompare(String(vb), 'pt') * sortDir;
  });

  const colunas = [
    'cnp_codigo',
    'designacao',
    'laboratorio_titular',
    'dci',
    'vendas_12m_un',
    'vendas_12m_eur',
    'vmm',
    colM1,
    colM2,
    colM3,
    'margem_pct_est',
    'stock_total_unidades',
    'eh_mono',
    ...(args.comparar_com
      ? ['unidades_a', 'unidades_b', 'unidades_delta', 'valor_eur_a', 'valor_eur_b', 'valor_eur_delta']
      : []),
  ];

  const linhas = prodRows.map((r: any) => colunas.map((c) => (r[c] !== undefined ? r[c] : null)));

  const avisos: string[] = [];
  if (filteredMarts.length > 0 && dciNulaCount > 0) {
    const pct = Math.round((dciNulaCount / filteredMarts.length) * 100);
    if (pct > 0) avisos.push(`dci nula em ${pct}% das linhas`);
  }

  return saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'consultar_vendas',
    input: args,
    meta: {
      periodo: { de: periodoDe, ate: periodoAte },
      ultimos_3_meses: [m1, m2, m3],
      filtros_aplicados: filtros,
      agrupado_por: agruparPor,
      unidades: { quantidade: 'un', valor: 'EUR' },
      margem_metodo: 'estimada_custo_medio_atual',
      n_linhas_total: linhas.length,
      avisos_dados: avisos,
    },
    colunas,
    linhas,
    totais: {
      vendas_12m_un: totalVendasUn,
      vendas_12m_eur: Number(totalVendasEur.toFixed(2)),
      n_produtos_com_vendas: nComVendas,
      n_produtos_sem_vendas: nSemVendas,
    },
    limiteModelo: limite,
  });
}

// ============================================================================
// 5. CONSULTAR PRODUTOS / STOCK / VALIDADES / MONOS (PRIMITIVA NEUTRA TABULAR)
// ============================================================================
export async function toolConsultarProdutos(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    filtros?: FiltrosComuns & {
      validade_ate?: string;
      meses_ate_validade_max?: number;
    };
    colunas?: string[];
    ordenar?: { campo: string; dir?: 'asc' | 'desc' };
    limite?: number;
  },
  sessionId = 'default',
  turno = 1
): Promise<ToolResultEnvelope> {
  const filtros = args.filtros || {};
  const limite = Math.min(Math.max(args.limite || 50, 1), 200);

  const [rawMarts, allCatalog] = await Promise.all([
    prisma.martProdutoMetricas.findMany({
      where: { farmaciaId: ctx.farmaciaId },
    }),
    prisma.produtoMestre.findMany({
      select: {
        cnp_codigo: true,
        dci: true,
        laboratorio_titular: true,
        categoria: true,
        subcategoria: true,
        tipo_venda: true,
        sazonalidade: true,
        papel_recomendacao: true,
        indicacoes_clinicas: true,
      },
    }),
  ]);

  const catMap = new Map(allCatalog.map((c) => [c.cnp_codigo, c]));

  const items = rawMarts
    .map((m) => {
      const cat = catMap.get(m.cnp_codigo);
      const lab = cat?.laboratorio_titular || m.laboratorio_titular || null;
      const dci = cat?.dci || m.molecula_dci || null;
      const custo = Number(m.custo_unitario_medio || 0);
      const pvp = m.pvp !== null ? Number(m.pvp) : null;
      const margemPct = computeSafeMarginPct(
        custo,
        pvp,
        m.margem_padrao !== null ? Number(m.margem_padrao) : null
      );
      const stock = m.stock_total_unidades;
      const ehRestoGaveta = stock >= 1 && stock <= 2;
      const anomaliaCustoGtPvp = custo > 0 && pvp !== null && pvp > 0 && custo > pvp;
      const margemNegativa = margemPct !== null && margemPct < 0;
      const dataVal = m.data_validade_mais_proxima
        ? m.data_validade_mais_proxima.toISOString().slice(0, 10)
        : null;

      return {
        cnp_codigo: m.cnp_codigo,
        designacao: m.designacao,
        laboratorio_titular: lab,
        dci,
        grupo_equivalencia_dci: m.grupo_equivalencia_dci || null,
        tipo_venda: cat?.tipo_venda || m.tipo_venda || null,
        segmento: m.segmento || null,
        eh_generico: m.eh_generico,
        categoria: cat?.categoria || m.categoria || null,
        subcategoria: cat?.subcategoria || m.subcategoria || null,
        papel_recomendacao: cat?.papel_recomendacao || null,
        publico_alvo: PEDIATRIC_REGEX.test(m.designacao) ? 'PEDIATRICO' : 'ADULTO_GERAL',
        stock_total_unidades: stock,
        stock_total_valor_custo: Number(Number(m.stock_total_valor_custo || 0).toFixed(2)),
        custo_unitario_medio: custo > 0 ? Number(custo.toFixed(2)) : null,
        pvp,
        margem_pct: margemPct,
        total_unidades_vendidas: m.total_unidades_vendidas,
        vmm: Number(m.vmm),
        cobertura_meses: Number(m.cobertura_meses),
        dias_sem_vendas: m.dias_sem_vendas,
        eh_mono: m.eh_mono,
        eh_resto_gaveta: ehRestoGaveta,
        eh_excesso_cobertura: m.eh_excesso_cobertura,
        unidades_excesso: m.unidades_excesso,
        capital_excesso: Number(Number(m.capital_excesso || 0).toFixed(2)),
        data_validade_mais_proxima: dataVal,
        meses_ate_validade: m.meses_ate_validade,
        eh_risco_caducidade: m.eh_risco_caducidade,
        unidades_em_risco_caducidade: m.unidades_em_risco_caducidade,
        valor_em_risco_caducidade: Number(Number(m.valor_em_risco_caducidade || 0).toFixed(2)),
        eh_risco_rutura: m.eh_risco_rutura,
        anomalia_custo_gt_pvp: anomaliaCustoGtPvp,
        margem_negativa: margemNegativa,
      };
    })
    .filter((it) => {
      if (filtros.laboratorio && !matchesLabFilter(it.laboratorio_titular, it.designacao, filtros.laboratorio)) {
        return false;
      }
      if (filtros.dci && !stripAccents(it.dci || '').includes(stripAccents(filtros.dci))) return false;
      if (filtros.cnp && filtros.cnp.length > 0 && !filtros.cnp.includes(it.cnp_codigo)) return false;
      if (filtros.categoria && !stripAccents(it.categoria || '').includes(stripAccents(filtros.categoria))) {
        return false;
      }
      if (filtros.tipo_venda && it.tipo_venda !== filtros.tipo_venda) return false;
      if (filtros.segmento && it.segmento !== filtros.segmento) return false;
      if (filtros.eh_generico !== undefined && it.eh_generico !== filtros.eh_generico) return false;
      if (filtros.stock_min !== undefined && it.stock_total_unidades < filtros.stock_min) return false;
      if (filtros.stock_max !== undefined && it.stock_total_unidades > filtros.stock_max) return false;
      if (filtros.validade_ate && (!it.data_validade_mais_proxima || it.data_validade_mais_proxima > filtros.validade_ate)) {
        return false;
      }
      if (
        filtros.meses_ate_validade_max !== undefined &&
        (it.meses_ate_validade === null || it.meses_ate_validade > filtros.meses_ate_validade_max)
      ) {
        return false;
      }

      if (filtros.texto) {
        const q = stripAccents(filtros.texto);
        const hay = stripAccents(
          `${it.cnp_codigo} ${it.designacao} ${it.dci || ''} ${it.laboratorio_titular || ''} ${it.categoria || ''}`
        );
        if (q.length <= 5) {
          if (!new RegExp(`\\b${escapeRx(q)}`, 'i').test(hay)) return false;
        } else if (!hay.includes(q)) {
          return false;
        }
      }

      if (Array.isArray(filtros.flags) && filtros.flags.length > 0) {
        for (const fl of filtros.flags) {
          if (!(it as any)[fl]) return false;
        }
      }

      return true;
    });

  const sortField = args.ordenar?.campo || 'stock_total_valor_custo';
  const sortDir = (args.ordenar?.dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  items.sort((a: any, b: any) => {
    const va = a[sortField] ?? 0;
    const vb = b[sortField] ?? 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sortDir;
    return String(va).localeCompare(String(vb), 'pt') * sortDir;
  });

  const defaultCols = [
    'cnp_codigo',
    'designacao',
    'laboratorio_titular',
    'dci',
    'tipo_venda',
    'stock_total_unidades',
    'stock_total_valor_custo',
    'custo_unitario_medio',
    'pvp',
    'margem_pct',
    'total_unidades_vendidas',
    'vmm',
    'cobertura_meses',
    'eh_mono',
    'eh_resto_gaveta',
    'eh_excesso_cobertura',
    'data_validade_mais_proxima',
  ];

  const colunas =
    Array.isArray(args.colunas) && args.colunas.length > 0
      ? args.colunas.filter((c) => c in (items[0] || {}) || defaultCols.includes(c))
      : defaultCols;

  const linhas = items.map((it: any) => colunas.map((c) => (it[c] !== undefined ? it[c] : null)));

  const totalStockUn = items.reduce((s, i) => s + i.stock_total_unidades, 0);
  const totalStockEur = items.reduce((s, i) => s + i.stock_total_valor_custo, 0);

  return saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'consultar_produtos',
    input: args,
    meta: {
      filtros_aplicados: filtros,
      unidades: { quantidade: 'un', valor: 'EUR' },
      n_linhas_total: linhas.length,
    },
    colunas,
    linhas,
    totais: {
      n_produtos: items.length,
      stock_total_unidades: totalStockUn,
      stock_total_valor_custo: Number(totalStockEur.toFixed(2)),
    },
    limiteModelo: limite,
  });
}

// ============================================================================
// 6. CONSULTAR GRUPOS DCI & SIMILARES (ACHATADO EM LINHAS TABULARES)
// ============================================================================
export async function toolConsultarGruposDci(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    dci_ou_grupo?: string;
    cnp?: string;
    laboratorio?: string;
    modo_detalhe?: boolean;
    limite?: number;
  },
  sessionId = 'default',
  turno = 1
): Promise<ToolResultEnvelope> {
  const limite = Math.min(Math.max(args.limite || 50, 1), 200);
  const [grupos, totalProds, comDci] = await Promise.all([
    prisma.martDciGrupo.findMany({
      where: { farmaciaId: ctx.farmaciaId },
      orderBy: { poupanca_potencial_anual: 'desc' },
    }),
    prisma.martProdutoMetricas.count({ where: { farmaciaId: ctx.farmaciaId } }),
    prisma.martProdutoMetricas.count({
      where: { farmaciaId: ctx.farmaciaId, molecula_dci: { not: null } },
    }),
  ]);

  const coberturaDciPct = totalProds > 0 ? Math.round((comDci / totalProds) * 100) : 0;

  let targetGrupoTerm = stripAccents(args.dci_ou_grupo || '');
  if (args.cnp && !targetGrupoTerm) {
    const prod = await prisma.martProdutoMetricas.findFirst({
      where: { farmaciaId: ctx.farmaciaId, cnp_codigo: args.cnp },
    });
    if (prod?.grupo_equivalencia_dci) targetGrupoTerm = stripAccents(prod.grupo_equivalencia_dci);
    else if (prod?.molecula_dci) targetGrupoTerm = stripAccents(prod.molecula_dci);
  }

  const filteredGrupos = grupos.filter((g) => {
    if (targetGrupoTerm && !stripAccents(g.grupo_equivalencia_dci).includes(targetGrupoTerm)) {
      return false;
    }
    if (args.laboratorio) {
      const labs = (g.labsJson as any[]) || [];
      const hasLab = labs.some((l) => matchesLabFilter(l.laboratorio_titular, l.designacao || '', args.laboratorio!));
      if (!hasLab) return false;
    }
    return true;
  });

  // Se pediu filtro específico (dci_ou_grupo, cnp ou laboratorio) ou modo_detalhe !== false, achata labsJson em linhas por marca
  const flattenBrands = Boolean(args.dci_ou_grupo || args.cnp || args.laboratorio || args.modo_detalhe);

  if (flattenBrands) {
    const colunas = [
      'grupo_equivalencia_dci',
      'cnp_codigo',
      'designacao',
      'laboratorio_titular',
      'stock_atual',
      'custo_unitario',
      'pvp',
      'margem_pct',
      'vmm',
      'quota_vmm_grupo_pct',
      'custo_minimo_grupo',
      'custo_maximo_grupo',
    ];
    const linhas: any[][] = [];

    for (const g of filteredGrupos) {
      const labs = (g.labsJson as any[]) || [];
      const vmmGrupo = Number(g.vmm_total_grupo || 0);
      for (const l of labs) {
        const vmmLab = Number(l.vmm || 0);
        const quotaPct = vmmGrupo > 0 ? Number(((vmmLab / vmmGrupo) * 100).toFixed(1)) : 0;
        const custo = Number(l.custo_unitario || 0);
        const pvp = l.pvp !== null && l.pvp !== undefined ? Number(l.pvp) : null;
        const mg = computeSafeMarginPct(custo, pvp, l.margem_percentagem ?? null);

        linhas.push([
          g.grupo_equivalencia_dci,
          l.cnp_codigo,
          l.designacao,
          l.laboratorio_titular || null,
          Number(l.stock_atual || 0),
          custo > 0 ? Number(custo.toFixed(2)) : null,
          pvp,
          mg,
          vmmLab,
          quotaPct,
          Number(g.custo_minimo),
          Number(g.custo_maximo),
        ]);
      }
    }

    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_grupos_dci',
      input: args,
      meta: {
        modo: 'detalhe_marcas_por_molecula',
        filtros_aplicados: args,
        cobertura_dci_catalogo_pct: coberturaDciPct,
        avisos_dados: [`similares DCI catalogados para ${coberturaDciPct}% dos produtos da farmácia`],
        n_linhas_total: linhas.length,
      },
      colunas,
      linhas,
      limiteModelo: limite,
    });
  }

  // Modo resumo por grupo DCI
  const colunas = [
    'grupo_equivalencia_dci',
    'num_laboratorios_abertos',
    'stock_total_unidades',
    'stock_total_valor_custo',
    'vmm_total_grupo',
    'custo_minimo',
    'custo_maximo',
    'poupanca_potencial_anual',
  ];
  const linhas = filteredGrupos.map((g) => [
    g.grupo_equivalencia_dci,
    g.num_laboratorios_abertos,
    g.stock_total_unidades,
    Number(g.stock_total_valor_custo),
    Number(g.vmm_total_grupo),
    Number(g.custo_minimo),
    Number(g.custo_maximo),
    Number(g.poupanca_potencial_anual),
  ]);

  return saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'consultar_grupos_dci',
    input: args,
    meta: {
      modo: 'resumo_grupos_dci',
      cobertura_dci_catalogo_pct: coberturaDciPct,
      avisos_dados: [`similares DCI catalogados para ${coberturaDciPct}% dos produtos da farmácia`],
      n_linhas_total: linhas.length,
    },
    colunas,
    linhas,
    limiteModelo: limite,
  });
}

// ============================================================================
// 7. CONSULTAR PATRIMÓNIO & SAÚDE DE STOCK (EVOLUÇÃO, LIQUIDEZ, MONOS)
// ============================================================================
export async function toolConsultarPatrimonioStock(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    vista: 'evolucao' | 'capital_imobilizado' | 'liquidez_recuperada' | 'validades';
    mes_venda?: string;
    meses_parado_minimo?: number;
    limite?: number;
  },
  sessionId = 'default',
  turno = 1
): Promise<ToolResultEnvelope> {
  const vista = args.vista || 'evolucao';
  const limite = Math.min(Math.max(args.limite || 50, 1), 200);
  const evo: any = await getStockEvolutionAnalytics(prisma, ctx.farmaciaId);
  const isMarcoZero = Boolean(evo.is_marco_zero);
  const pontosEvo = evo.pontos_mensais || evo.pontos || [];
  const nSnapshots = pontosEvo.length;

  if (vista === 'evolucao') {
    const colunas = [
      'mes_ano',
      'mes_label',
      'stock_total_eur',
      'stock_imobilizado_monos_eur',
      'taxa_imobilizado_pct',
      'vendas_mes_eur',
      'liquidez_recuperada_monos_eur',
      'dias_rotacao',
      'is_marco_zero',
    ];
    const linhas = pontosEvo.map((p: any) => [
      p.mes_key,
      p.mes_label,
      Number(p.stock_total_eur),
      Number(p.stock_imobilizado_eur),
      Number(p.taxa_imobilizado_pct),
      Number(p.vendas_mes_eur),
      isMarcoZero ? 0 : Number(p.liquidez_recuperada_monos_eur || 0),
      p.dias_rotacao,
      Boolean(p.is_marco_zero),
    ]);

    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_patrimonio_stock',
      input: args,
      meta: {
        vista: 'evolucao',
        n_snapshots: nSnapshots,
        is_marco_zero: isMarcoZero,
        ...(isMarcoZero ? { motivo: 'apenas_um_inventario_importado' } : {}),
        n_linhas_total: linhas.length,
      },
      colunas,
      linhas,
      limiteModelo: limite,
    });
  }

  if (vista === 'liquidez_recuperada') {
    const mesVenda = args.mes_venda || '2026-10';
    const minMeses = args.meses_parado_minimo ?? 3;
    const resLiq: any = await toolAuditarEscoamentoEDestraveStock(prisma, ctx, {
      mes_venda: mesVenda,
      meses_parado_minimo: minMeses,
      limite_produtos: 200,
    });

    const items = resLiq.topArtigosDescongelados || [];
    const colunas = [
      'cnp_codigo',
      'designacao',
      'dci',
      'macro_area',
      'meses_inativo',
      'periodo_parado',
      'unidades_vendidas',
      'capital_recuperado_eur',
      'faturacao_eur',
      'margem_eur',
      'stock_atual',
    ];
    const linhas = items.map((i: any) => [
      i.cnp,
      i.designacao,
      i.dci || null,
      i.macroArea,
      i.mesesInativo,
      i.periodoParado,
      i.unidadesVendidas,
      i.capitalRecuperadoEur,
      i.faturacaoEur,
      i.margemEur,
      i.stockAtual,
    ]);

    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_patrimonio_stock',
      input: args,
      meta: {
        vista: 'liquidez_recuperada',
        mes_venda: resLiq.mesVenda,
        criterio_inatividade: resLiq.criterioInatividade,
        n_snapshots: nSnapshots,
        is_marco_zero: isMarcoZero,
        n_linhas_total: resLiq.resumoExecutivo?.totalArtigosReativados || linhas.length,
      },
      colunas,
      linhas,
      totais: resLiq.resumoExecutivo || {},
      limiteModelo: limite,
    });
  }

  if (vista === 'validades') {
    return toolConsultarProdutos(
      prisma,
      ctx,
      {
        filtros: { flags: ['eh_risco_caducidade'] },
        ordenar: { campo: 'valor_em_risco_caducidade', dir: 'desc' },
        limite,
      },
      sessionId,
      turno
    );
  }

  // vista === 'capital_imobilizado'
  const perdas: any = await toolCalcularPerdasFinanceirasECustoOportunidade(prisma, ctx, {
    tipo_auditoria: 'TODAS',
  });
  return toolConsultarProdutos(
    prisma,
    ctx,
    {
      filtros: { flags: ['eh_mono'] },
      ordenar: { campo: 'stock_total_valor_custo', dir: 'desc' },
      limite,
    },
    sessionId,
    turno
  ).then((env) => ({
    ...env,
    totais: {
      ...env.totais,
      resumo_patrimonial: perdas.resumoExecutivoPerdas || {},
    },
  }));
}

// ============================================================================
// 8. CONSULTAR TAREFAS E CAMPANHAS (PRIMITIVA NEUTRA)
// ============================================================================
export async function toolConsultarTarefasECampanhas(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: { tipo?: 'ambos' | 'tarefas' | 'campanhas'; week_key?: string },
  sessionId = 'default',
  turno = 1
): Promise<ToolResultEnvelope> {
  const [tarefas, campanhas] = await Promise.all([
    prisma.tarefaEquipa.findMany({
      where: { farmaciaId: ctx.farmaciaId, ...(args.week_key ? { week_key: args.week_key } : {}) },
      orderBy: { concluido_em: 'desc' },
      take: 100,
    }),
    prisma.campanhaAtiva.findMany({
      where: { farmaciaId: ctx.farmaciaId },
      orderBy: { criadoEm: 'desc' },
      take: 25,
    }),
  ]);

  if (args.tipo === 'campanhas') {
    const colunas = ['campanha_id', 'titulo', 'estado', 'desconto_pct', 'data_inicio', 'n_produtos'];
    const linhas = campanhas.map((c) => [
      c.campanhaId,
      c.titulo,
      c.estado,
      c.descontoAplicadoPct,
      c.dataInicio.toISOString().slice(0, 10),
      Array.isArray(c.produtosJson) ? (c.produtosJson as any[]).length : 0,
    ]);
    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_tarefas_e_campanhas',
      input: args,
      meta: { tipo: 'campanhas', n_linhas_total: linhas.length },
      colunas,
      linhas,
    });
  }

  const colunas = ['task_id', 'week_key', 'categoria', 'cnp_codigo', 'designacao', 'concluido', 'valor_impacto_eur'];
  const linhas = tarefas.map((t) => [
    t.task_id,
    t.week_key,
    t.categoria,
    t.cnp_codigo || null,
    t.designacao || null,
    t.concluido,
    t.valor_impacto !== null ? Number(t.valor_impacto) : null,
  ]);

  return saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'consultar_tarefas_e_campanhas',
    input: args,
    meta: {
      tipo: args.tipo || 'ambos',
      n_campanhas_ativas: campanhas.filter((c) => c.estado === 'ATIVA').length,
      n_linhas_total: linhas.length,
    },
    colunas,
    linhas,
    totais: {
      total_tarefas_registadas: tarefas.length,
      tarefas_concluidas: tarefas.filter((t) => t.concluido).length,
      campanhas_ativas: campanhas.filter((c) => c.estado === 'ATIVA').map((c) => ({
        campanha_id: c.campanhaId,
        titulo: c.titulo,
        desconto_pct: c.descontoAplicadoPct,
      })),
    },
  });
}

// ============================================================================
// 8.1. CONSULTAR DESEMPENHO E VENDAS DE CAMPANHAS (ESPECÍFICO VS GLOBAL)
// ============================================================================
export interface ConsultarDesempenhoCampanhasArgs {
  campanha_id?: string;
  incluir_concluidas?: boolean;
  data_inicio?: string;
  data_fim?: string;
}

export async function toolConsultarDesempenhoCampanhas(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: ConsultarDesempenhoCampanhasArgs = {},
  sessionId = 'default',
  turno = 1
): Promise<ToolResultEnvelope> {
  // 1. Procurar campanhas disponíveis para a farmácia
  const todasCampanhas = await prisma.campanhaAtiva.findMany({
    where: { farmaciaId: ctx.farmaciaId },
    orderBy: { criadoEm: 'desc' },
    take: 30,
  });

  let campanha: any = null;
  if (args.campanha_id) {
    const term = args.campanha_id.toLowerCase().trim();
    campanha = todasCampanhas.find(
      (c) =>
        c.id.toLowerCase() === term ||
        c.campanhaId.toLowerCase() === term ||
        c.titulo.toLowerCase().includes(term)
    );
  }

  if (!campanha) {
    // Tenta encontrar a campanha ativa mais recente
    campanha = todasCampanhas.find((c) => c.estado === 'ATIVA');
  }

  if (!campanha && args.incluir_concluidas) {
    // Tenta a campanha mais recente terminada
    campanha = todasCampanhas[0] || null;
  }

  if (!campanha) {
    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consultar_desempenho_campanhas',
      input: args,
      meta: {
        encontrada: false,
        total_campanhas_existentes: todasCampanhas.length,
        n_linhas_total: 0,
      },
      colunas: ['cnp_codigo', 'designacao', 'stock_inicial', 'unidades_vendidas', 'faturacao_eur'],
      linhas: [],
      totais: {
        mensagem:
          todasCampanhas.length === 0
            ? 'Não existem campanhas configuradas nesta farmácia.'
            : 'Nenhuma campanha ativa encontrada. Passe incluir_concluidas=true para consultar campanhas terminadas.',
        campanhas_existentes: todasCampanhas.map((c) => ({
          id: c.id,
          campanhaId: c.campanhaId,
          titulo: c.titulo,
          estado: c.estado,
        })),
      },
    });
  }

  // 2. Extrair produtos da campanha
  const rawProds: any[] = Array.isArray(campanha.produtosJson) ? (campanha.produtosJson as any[]) : [];
  const produtosMap = new Map<string, any>();
  for (const p of rawProds) {
    const cnp = p.cnp_codigo || p.cnp;
    if (cnp) {
      produtosMap.set(String(cnp), p);
    }
  }
  const cnps = Array.from(produtosMap.keys());

  // 3. Definir intervalo temporal
  const dataInicio = args.data_inicio ? new Date(args.data_inicio) : new Date(campanha.dataInicio);
  const dataFim = args.data_fim
    ? new Date(args.data_fim)
    : campanha.estado === 'ATIVA'
    ? new Date()
    : campanha.dataFim
    ? new Date(campanha.dataFim)
    : new Date();

  // 4. Data máxima de venda registada no Sifarma
  const maxVendaAgg = await prisma.venda.aggregate({
    where: { farmaciaId: ctx.farmaciaId },
    _max: { data_venda: true },
  });
  const maxDataVenda = maxVendaAgg._max.data_venda;

  // 5. Consultar vendas no período nominal e stock de inventário
  const [vendasEspecificas, vendasGlobais, inventariosAtuais] = await Promise.all([
    cnps.length > 0
      ? prisma.venda.groupBy({
          by: ['cnp_codigo'],
          where: {
            farmaciaId: ctx.farmaciaId,
            cnp_codigo: { in: cnps },
            data_venda: { gte: dataInicio, lte: dataFim },
            quantidade: { gt: 0 },
          },
          _sum: { quantidade: true, valor_total: true },
        })
      : [],
    prisma.venda.aggregate({
      where: {
        farmaciaId: ctx.farmaciaId,
        data_venda: { gte: dataInicio, lte: dataFim },
        quantidade: { gt: 0 },
      },
      _sum: { quantidade: true, valor_total: true },
    }),
    cnps.length > 0
      ? prisma.inventario.findMany({
          where: {
            farmaciaId: ctx.farmaciaId,
            cnp_codigo: { in: cnps },
          },
          include: { produto: true },
        })
      : [],
  ]);

  const invMap = new Map(inventariosAtuais.map((inv) => [inv.cnp_codigo, inv]));
  const salesMap = new Map(
    vendasEspecificas.map((s) => [
      s.cnp_codigo,
      {
        qtd: Number(s._sum.quantidade || 0),
        val: Number((s._sum.valor_total || 0).toFixed(2)),
      },
    ])
  );

  // 6. Consultar baseline do mês mais recente com vendas no sistema (contexto e rigor)
  let baselineMes: any = null;
  if (maxDataVenda) {
    const startOfMaxMonth = new Date(maxDataVenda.getFullYear(), maxDataVenda.getMonth(), 1);
    const endOfMaxMonth = new Date(maxDataVenda.getFullYear(), maxDataVenda.getMonth() + 1, 0, 23, 59, 59);

    const [vendasBaseEspec, vendasBaseGlob] = await Promise.all([
      cnps.length > 0
        ? prisma.venda.groupBy({
            by: ['cnp_codigo'],
            where: {
              farmaciaId: ctx.farmaciaId,
              cnp_codigo: { in: cnps },
              data_venda: { gte: startOfMaxMonth, lte: endOfMaxMonth },
              quantidade: { gt: 0 },
            },
            _sum: { quantidade: true, valor_total: true },
          })
        : [],
      prisma.venda.aggregate({
        where: {
          farmaciaId: ctx.farmaciaId,
          data_venda: { gte: startOfMaxMonth, lte: endOfMaxMonth },
          quantidade: { gt: 0 },
        },
        _sum: { quantidade: true, valor_total: true },
      }),
    ]);

    const baseEspecQtd = vendasBaseEspec.reduce((acc, v) => acc + Number(v._sum.quantidade || 0), 0);
    const baseEspecVal = Number(vendasBaseEspec.reduce((acc, v) => acc + Number(v._sum.valor_total || 0), 0).toFixed(2));
    const baseGlobVal = Number((vendasBaseGlob._sum.valor_total || 0).toFixed(2));
    const baseQuotaPct = baseGlobVal > 0 ? Number(((baseEspecVal / baseGlobVal) * 100).toFixed(2)) : 0;

    baselineMes = {
      mes_referencia: `${startOfMaxMonth.getFullYear()}-${String(startOfMaxMonth.getMonth() + 1).padStart(2, '0')}`,
      unidades_artigos_campanha: baseEspecQtd,
      faturacao_artigos_campanha_eur: baseEspecVal,
      faturacao_global_farmacia_eur: baseGlobVal,
      quota_faturacao_pct: baseQuotaPct,
    };
  }

  // 7. Construir tabela detalhada
  const colunas = [
    'cnp_codigo',
    'designacao',
    'stock_inicial_campanha',
    'unidades_vendidas_periodo',
    'faturacao_periodo_eur',
    'stock_atual_inventario',
    'escoamento_pct',
    'capital_desmobilizado_eur',
    'classificacao',
  ];

  let totalUnidadesVendidasPeriodo = 0;
  let totalFaturacaoPeriodoEur = 0;
  let totalCapitalDesmobilizadoEur = 0;

  const linhas = cnps.map((cnp) => {
    const rawProd = produtosMap.get(cnp) || {};
    const inv = invMap.get(cnp);
    const sale = salesMap.get(cnp) || { qtd: 0, val: 0 };

    const stockInicial = Number(rawProd.stock_atual ?? inv?.quantidade ?? 0);
    const stockAtual = inv ? inv.quantidade : stockInicial - sale.qtd;
    const custoUnit = Number(rawProd.custo_unitario ?? inv?.custo_unitario ?? 0);

    const escoamentoPct = stockInicial > 0 ? Number(((sale.qtd / stockInicial) * 100).toFixed(1)) : 0;
    const capitalDesmobilizado = Number((sale.qtd * custoUnit).toFixed(2));

    totalUnidadesVendidasPeriodo += sale.qtd;
    totalFaturacaoPeriodoEur += sale.val;
    totalCapitalDesmobilizadoEur += capitalDesmobilizado;

    let classificacao = 'ROTACAO_REGULAR';
    if ((inv as any)?.eh_risco_caducidade || rawProd.eh_risco_caducidade) {
      classificacao = 'RISCO_CADUCIDADE';
    } else if ((inv as any)?.eh_mono || rawProd.eh_mono) {
      classificacao = 'MONO_PARADO';
    }

    return [
      cnp,
      rawProd.designacao || inv?.produto?.designacao || 'Sem designação',
      stockInicial,
      sale.qtd,
      sale.val,
      stockAtual,
      escoamentoPct,
      capitalDesmobilizado,
      classificacao,
    ];
  });

  const faturacaoGlobalPeriodoEur = Number((vendasGlobais._sum.valor_total || 0).toFixed(2));
  const unidadesGlobaisPeriodo = Number(vendasGlobais._sum.quantidade || 0);
  const quotaCampanhaPct =
    faturacaoGlobalPeriodoEur > 0
      ? Number(((totalFaturacaoPeriodoEur / faturacaoGlobalPeriodoEur) * 100).toFixed(2))
      : 0;

  const temVendasNoPeriodo =
    Boolean(maxDataVenda && maxDataVenda >= dataInicio) &&
    (totalUnidadesVendidasPeriodo > 0 || unidadesGlobaisPeriodo > 0);

  const totais = {
    campanha_id: campanha.id,
    campanha_slug: campanha.campanhaId,
    titulo: campanha.titulo,
    icone: campanha.icone,
    estado: campanha.estado,
    desconto_aplicado_pct: campanha.descontoAplicadoPct,
    periodo_analisado: {
      data_inicio: dataInicio.toISOString().slice(0, 10),
      data_fim: dataFim.toISOString().slice(0, 10),
      dias_periodo: Math.max(1, Math.round((dataFim.getTime() - dataInicio.getTime()) / (1000 * 60 * 60 * 24))),
    },
    integridade_dados: {
      tem_vendas_no_periodo_nominal: temVendasNoPeriodo,
      data_maxima_vendas_sifarma: maxDataVenda ? maxDataVenda.toISOString().slice(0, 10) : null,
      observacao: !temVendasNoPeriodo
        ? `A campanha iniciou a ${dataInicio.toISOString().slice(0, 10)}, mas o fecho de vendas mais recente registado no sistema data de ${maxDataVenda ? maxDataVenda.toISOString().slice(0, 10) : 'N/D'}. Logo, ainda não existem talões registados após a ativação. O BI Pharma nunca inventa números.`
        : 'Auditoria de vendas calculada estritamente com base nos talões de venda registados.',
    },
    resumo_periodo: {
      total_produtos_campanha: cnps.length,
      unidades_especificas_campanha: totalUnidadesVendidasPeriodo,
      faturacao_especifica_campanha_eur: Number(totalFaturacaoPeriodoEur.toFixed(2)),
      unidades_globais_farmacia_periodo: unidadesGlobaisPeriodo,
      faturacao_global_farmacia_periodo_eur: faturacaoGlobalPeriodoEur,
      quota_faturacao_campanha_pct: quotaCampanhaPct,
      capital_desmobilizado_monos_e_stock_eur: Number(totalCapitalDesmobilizadoEur.toFixed(2)),
    },
    baseline_pre_campanha: baselineMes,
  };

  return saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'consultar_desempenho_campanhas',
    input: args,
    meta: {
      campanha_id: campanha.id,
      titulo: campanha.titulo,
      estado: campanha.estado,
      n_linhas_total: linhas.length,
      outras_campanhas_disponiveis: todasCampanhas
        .filter((c) => c.id !== campanha.id)
        .slice(0, 5)
        .map((c) => ({ id: c.id, titulo: c.titulo, estado: c.estado })),
    },
    colunas,
    linhas,
    totais,
  });
}

// ============================================================================
// 9. PLANEAR COMPRAS LABORATÓRIO (FERRAMENTA DE DECISÃO — CÓDIGOS NEUTROS)
// ============================================================================
export async function toolPlanearComprasLaboratorio(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: {
    laboratorio: string;
    modo?: 'reposicao' | 'sazonal' | 'acordo';
    orcamento_eur?: number;
    cobertura_alvo_dias?: number;
    limite?: number;
  },
  sessionId = 'default',
  turno = 1
): Promise<ToolResultEnvelope> {
  const lab = (args.laboratorio || '').trim();
  const cobAlvoDias = args.cobertura_alvo_dias || 30;
  const limite = Math.min(Math.max(args.limite || 50, 1), 200);

  if (args.modo === 'acordo') {
    const resAcordo: any = await toolAvaliarAcordoAnualComprasEscalonadas(prisma, ctx, {
      marca_ou_laboratorio: lab,
    });
    const tranches = resAcordo.planoEntregasEscalonadas || [];
    const colunas = ['tranche', 'mes_entrega', 'unidades_sugeridas', 'investimento_custo_eur'];
    const linhas = tranches.map((t: any) => [
      t.tranche,
      t.mesEntregaSugerido,
      t.unidadesTotaisTranche,
      t.investimentoCustoEur,
    ]);
    return saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'planear_compras_laboratorio',
      input: args,
      meta: { modo: 'acordo', laboratorio: lab, n_linhas_total: linhas.length },
      colunas,
      linhas,
      totais: resAcordo.resumoAcordoAnual || {},
      limiteModelo: limite,
    });
  }

  const [rawMarts, allCatalog] = await Promise.all([
    prisma.martProdutoMetricas.findMany({ where: { farmaciaId: ctx.farmaciaId } }),
    prisma.produtoMestre.findMany({
      select: { cnp_codigo: true, dci: true, laboratorio_titular: true, sazonalidade: true },
    }),
  ]);
  const catMap = new Map(allCatalog.map((c) => [c.cnp_codigo, c]));

  const labItems = rawMarts.filter((m) => {
    const c = catMap.get(m.cnp_codigo);
    return matchesLabFilter(c?.laboratorio_titular || m.laboratorio_titular, m.designacao, lab);
  });

  const colunas = [
    'cnp_codigo',
    'designacao',
    'dci',
    'stock_total_unidades',
    'vmm',
    'cobertura_dias',
    'custo_unitario_medio',
    'margem_pct',
    'qtd_calculada',
    'regra_aplicada',
  ];

  const linhas: any[][] = [];
  for (const m of labItems) {
    const c = catMap.get(m.cnp_codigo);
    const stock = m.stock_total_unidades;
    const vmm = Number(m.vmm || 0);
    const cobDias = vmm > 0 ? Math.round(stock / (vmm / 30)) : stock > 0 ? 999 : 0;
    const custo = Number(m.custo_unitario_medio || 0);
    const pvp = m.pvp !== null ? Number(m.pvp) : null;
    const mg = computeSafeMarginPct(custo, pvp, m.margem_padrao !== null ? Number(m.margem_padrao) : null);

    let qtdCalculada = 0;
    let regraAplicada = 'STOCK_ADEQUADO';

    if (m.eh_mono && stock > 0) {
      qtdCalculada = 0;
      regraAplicada = 'EXCLUIDO_MONO';
    } else if (m.eh_excesso_cobertura || Number(m.cobertura_meses) > 4) {
      qtdCalculada = 0;
      regraAplicada = 'EXCLUIDO_EXCESSO';
    } else if (vmm >= 0.5 && cobDias < cobAlvoDias) {
      qtdCalculada = Math.max(1, Math.ceil(vmm * (cobAlvoDias / 30)) - stock);
      regraAplicada = 'REPOR_ATE_COBERTURA_ALVO';
    }

    linhas.push([
      m.cnp_codigo,
      m.designacao,
      c?.dci || m.molecula_dci || null,
      stock,
      vmm,
      cobDias,
      custo > 0 ? Number(custo.toFixed(2)) : null,
      mg,
      qtdCalculada,
      regraAplicada,
    ]);
  }

  // Ordenar: primeiro REPOR_ATE_COBERTURA_ALVO por vmm desc, depois excluídos
  linhas.sort((a, b) => {
    const rA = a[9] === 'REPOR_ATE_COBERTURA_ALVO' ? 0 : 1;
    const rB = b[9] === 'REPOR_ATE_COBERTURA_ALVO' ? 0 : 1;
    if (rA !== rB) return rA - rB;
    return (b[4] || 0) - (a[4] || 0);
  });

  return saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'planear_compras_laboratorio',
    input: args,
    meta: {
      laboratorio: lab,
      parametros_usados: { cobertura_alvo_dias: cobAlvoDias },
      lista_exportavel_disponivel: false,
      n_linhas_total: linhas.length,
    },
    colunas,
    linhas,
    totais: {
      n_repor: linhas.filter((l) => l[9] === 'REPOR_ATE_COBERTURA_ALVO').length,
      n_excluidos_mono: linhas.filter((l) => l[9] === 'EXCLUIDO_MONO').length,
      n_excluidos_excesso: linhas.filter((l) => l[9] === 'EXCLUIDO_EXCESSO').length,
    },
    limiteModelo: limite,
  });
}
