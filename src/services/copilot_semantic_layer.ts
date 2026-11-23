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
import { isTherapeuticChronic } from './copilot_chronic_therapies';
import { canVerFaturacao } from '../platform/permissoes';

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

function normalizeLabToken(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

const CANONICAL_LAB_GROUPS: Record<string, string[]> = {
  bial: ['bial'],
  teva: ['teva', 'ratiopharm'],
  ratiopharm: ['teva', 'ratiopharm'],
  mylan: ['mylan', 'viatris'],
  viatris: ['mylan', 'viatris'],
};

/**
 * Função única e canónica de resolução de laboratório para todas as ferramentas do Copilot.
 * Usa correspondência exata / fronteira de palavra em `laboratorio_titular` (ou grupo normalizado).
 * NUNCA usa substring simples: "Labialfarma" NÃO é Bial.
 */
export function matchesLabFilter(labTitular: string | null | undefined, _designacao: string, filtroLab: string): boolean {
  const f = normalizeLabToken(filtroLab);
  if (!f) return true;
  const lab = normalizeLabToken(labTitular);
  if (!lab) return false;

  const aliases = CANONICAL_LAB_GROUPS[f] || [f];
  for (const alias of aliases) {
    const esc = escapeRx(alias);
    const rx = new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, 'i');
    if (rx.test(lab)) return true;
  }
  return false;
}

export interface MonthCompletenessD6 {
  mes: string;
  mesRotuloPt: string;
  incompleto: boolean;
  vendasMesEur: number;
  nProdutosMes: number;
  media3mEur: number;
  media3mProdutos: number;
  racioVendasPct: number | null;
  racioProdutosPct: number | null;
  mesesBase: string[];
  aviso?: string;
}

const PT_MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

export function formatYmPt(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  const idx = Number(m[2]) - 1;
  return `${PT_MONTH_NAMES[idx] || m[2]} de ${m[1]}`;
}

function shiftYm(ym: string, deltaMonths: number): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + deltaMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Regra D6 — Verificação de integridade/completude mensal:
 * Compara o volume (€) e o n.º de produtos distintos vendidos num mês com a média dos 3 meses anteriores.
 * Se vendas ou n.º de produtos estiver abaixo de 70 % da média dos 3 meses anteriores, sinaliza o mês como incompleto.
 */
export async function checkMonthCompletenessD6(
  prisma: PrismaClient,
  farmaciaId: string,
  targetYm: string
): Promise<MonthCompletenessD6> {
  const prev1 = shiftYm(targetYm, -1);
  const prev2 = shiftYm(targetYm, -2);
  const prev3 = shiftYm(targetYm, -3);
  const meses = [prev3, prev2, prev1, targetYm];

  const rows = await prisma.martProdutoMes.findMany({
    where: {
      farmaciaId,
      mes: { in: meses },
    },
    select: {
      mes: true,
      cnp_codigo: true,
      valor_total: true,
      quantidade: true,
    },
  });

  const stats = new Map<string, { eur: number; cnps: Set<string> }>();
  for (const m of meses) stats.set(m, { eur: 0, cnps: new Set() });

  for (const r of rows) {
    const ym = String(r.mes).slice(0, 7);
    const st = stats.get(ym);
    if (!st) continue;
    st.eur += Number(r.valor_total || 0);
    if (Number(r.quantidade || 0) > 0) st.cnps.add(r.cnp_codigo);
  }

  const targetSt = stats.get(targetYm) || { eur: 0, cnps: new Set() };
  const baseMeses = [prev3, prev2, prev1].filter((m) => (stats.get(m)?.cnps.size || 0) > 0);

  if (baseMeses.length < 2) {
    return {
      mes: targetYm,
      mesRotuloPt: formatYmPt(targetYm),
      incompleto: false,
      vendasMesEur: Math.round(targetSt.eur * 100) / 100,
      nProdutosMes: targetSt.cnps.size,
      media3mEur: 0,
      media3mProdutos: 0,
      racioVendasPct: null,
      racioProdutosPct: null,
      mesesBase: baseMeses,
    };
  }

  const media3mEur =
    Math.round((baseMeses.reduce((s, m) => s + (stats.get(m)?.eur || 0), 0) / baseMeses.length) * 100) / 100;
  const media3mProdutos = Math.round(
    baseMeses.reduce((s, m) => s + (stats.get(m)?.cnps.size || 0), 0) / baseMeses.length
  );

  const vendasMesEur = Math.round(targetSt.eur * 100) / 100;
  const nProdutosMes = targetSt.cnps.size;
  const racioVendasPct = media3mEur > 0 ? Math.round((vendasMesEur / media3mEur) * 1000) / 10 : null;
  const racioProdutosPct = media3mProdutos > 0 ? Math.round((nProdutosMes / media3mProdutos) * 1000) / 10 : null;

  const incompleto =
    (racioVendasPct !== null && racioVendasPct < 70) ||
    (racioProdutosPct !== null && racioProdutosPct < 70);

  const fmtE = (v: number) => `${v.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const mesRotuloPt = formatYmPt(targetYm);
  const aviso = incompleto
    ? `Os dados de ${mesRotuloPt} parecem incompletos: ${fmtE(vendasMesEur)} e ${nProdutosMes.toLocaleString('pt-PT')} produtos vendidos, contra uma média de ${fmtE(media3mEur)} e ${media3mProdutos.toLocaleString('pt-PT')} produtos nos ${baseMeses.length} meses anteriores (${baseMeses[0]} a ${baseMeses[baseMeses.length - 1]}).`
    : undefined;

  return {
    mes: targetYm,
    mesRotuloPt,
    incompleto,
    vendasMesEur,
    nProdutosMes,
    media3mEur,
    media3mProdutos,
    racioVendasPct,
    racioProdutosPct,
    mesesBase: baseMeses,
    aviso,
  };
}

export function computeSafeMarginPct(
  custoUnit: number,
  pvp: number | null,
  margemPadrao: number | null,
  taxaIva?: number | null
): number | null {
  // P0.2: Priorizar sempre margem_padrao oficial (já calculada como PVP sem IVA vs Custo sem IVA)
  if (margemPadrao !== null && !isNaN(Number(margemPadrao)) && Number(margemPadrao) > 0 && Number(margemPadrao) < 99.9) {
    return Number(Number(margemPadrao).toFixed(1));
  }
  // Se margem_padrao não existir, calcular estritamente retirando o IVA ao PVP
  if (custoUnit > 0 && pvp !== null && pvp > 0) {
    const ivaRate = (taxaIva !== null && taxaIva !== undefined && taxaIva >= 0) ? taxaIva : 6;
    const pvpSemIva = pvp / (1 + ivaRate / 100);
    if (pvpSemIva > 0) {
      return Number((((pvpSemIva - custoUnit) / pvpSemIva) * 100).toFixed(1));
    }
  }
  return null;
}

export type AcaoRecomendada =
  | 'REPOR'
  | 'MANTER'
  | 'STOCK_MINIMO'
  | 'TRABALHAR_ENCOMENDA'
  | 'DEVOLVER_EXCESSO'
  | 'DEVOLVER_TUDO'
  | 'TRANSFERIR'
  | 'ESCOAMENTO_BALCAO'
  | 'DESCONTINUAR'
  | 'REVER_DADOS';

export interface ClassificacaoProduto {
  classificacao: AcaoRecomendada;
  motivo: string;
  motivo_codigo: string;
  unidades_excesso?: number;
}

export function classifyProductAction(item: {
  tipoVenda: string | null;
  dci: string | null;
  designacao: string;
  stock: number;
  vendasUn: number;
  vmm: number;
  margemPct: number | null;
  ehMono: boolean;
  ehExcesso: boolean;
  ehRiscoCaducidade: boolean;
  mesesAteValidade?: number | null;
  custoUnit?: number | null;
  pvp?: number | null;
  dadoSuspeito?: boolean;
  janelaMonoDias?: number; // Preparado para Fase 2
}): ClassificacaoProduto {
  const isMsrm =
    (item.tipoVenda || '').toUpperCase().includes('MSRM') ||
    (item.tipoVenda || '').toUpperCase().includes('RECEITA');
  const isChronic = isTherapeuticChronic(item.dci, item.designacao);

  // 0. D4: Valores anómalos / dados suspeitos -> REVER_DADOS (fora das recomendações comerciais)
  const custoAnomalo =
    item.custoUnit !== null &&
    item.custoUnit !== undefined &&
    item.custoUnit > 0 &&
    item.custoUnit <= 0.20 &&
    item.pvp !== null &&
    item.pvp !== undefined &&
    item.pvp >= 2.0;
  const margemAnomala = item.margemPct !== null && item.margemPct > 90;
  const stockNegativo = item.stock < 0;

  if (item.dadoSuspeito || custoAnomalo || margemAnomala || stockNegativo) {
    const razoes: string[] = [];
    if (stockNegativo) razoes.push(`stock negativo (${item.stock} un)`);
    if (custoAnomalo) razoes.push(`custo unitário anómalo (${Number(item.custoUnit).toFixed(2)} € vs PVP ${Number(item.pvp).toFixed(2)} €)`);
    if (margemAnomala) razoes.push(`margem > 90% (${item.margemPct}%)`);
    return {
      classificacao: 'REVER_DADOS',
      motivo_codigo: 'dado_suspeito',
      motivo: `Dado suspeito no ERP (${razoes.join('; ') || 'anomalia de registo'}). Auditar ficha no Sifarma antes de tomar decisão comercial.`,
    };
  }

  // 1. Em rutura com histórico de vendas comprovado (4.4: REPOR se VMM >= 1 ou crónico; caso contrário TRABALHAR_ENCOMENDA)
  if (item.vendasUn > 0 && item.stock === 0) {
    if (item.vmm >= 1.0 || isChronic) {
      return {
        classificacao: 'REPOR',
        motivo_codigo: isChronic ? 'cronico' : 'rutura_com_procura',
        motivo: isChronic
          ? 'Terapêutica crónica em rutura de stock. Repor imediatamente para assegurar continuidade clínica.'
          : 'Produto com procura ativa (VMM >= 1.0) em rutura de stock. Repor unidades de acordo com o VMM.',
      };
    }
    return {
      classificacao: 'TRABALHAR_ENCOMENDA',
      motivo_codigo: 'rutura_com_procura',
      motivo: 'Produto em rutura com procura pontual (VMM < 1.0, não crónico). Trabalhar sob encomenda diária.',
    };
  }

  // 2. Validades em risco iminente (< 6 meses) com devolução proporcional (DEVOLVER_EXCESSO)
  if (item.ehRiscoCaducidade && item.stock > 0) {
    const meses = item.mesesAteValidade && item.mesesAteValidade > 0 ? item.mesesAteValidade : 4;
    const unidadesVendaEsperada = Math.ceil(item.vmm * meses);
    const unidadesDevolver = Math.max(0, item.stock - unidadesVendaEsperada);

    if (unidadesDevolver > 0 && unidadesVendaEsperada > 0) {
      return {
        classificacao: 'DEVOLVER_EXCESSO',
        motivo_codigo: `validade_${meses}_meses`,
        unidades_excesso: unidadesDevolver,
        motivo: `Validade próxima (${meses} meses). Devolver apenas ${unidadesDevolver} un em excesso ao fornecedor; manter ${unidadesVendaEsperada} un para venda normal até à caducidade.`,
      };
    }
    if (unidadesDevolver === 0 && item.vmm > 0) {
      return {
        classificacao: 'MANTER',
        motivo_codigo: `validade_${meses}_meses`,
        motivo: `Validade próxima (${meses} meses), mas rotação ativa (VMM ${item.vmm.toFixed(2)}) escoará todo o stock atual (${item.stock} un) antes da caducidade.`,
      };
    }
    // Crónico nunca recebe DEVOLVER_TUDO
    if (isChronic) {
      if (item.stock > 1) {
        return {
          classificacao: 'DEVOLVER_EXCESSO',
          motivo_codigo: 'cronico',
          unidades_excesso: item.stock - 1,
          motivo: `Terapêutica crónica com validade próxima (${meses} meses). Devolver ${item.stock - 1} un em excesso e manter 1 un de segurança.`,
        };
      }
      return {
        classificacao: 'STOCK_MINIMO',
        motivo_codigo: 'cronico',
        motivo: `Terapêutica crónica com 1 un em stock e validade próxima (${meses} meses). Monitorizar dispensa ao doente habitual.`,
      };
    }
    // MSRM nunca recebe ESCOAMENTO_BALCAO
    if (isMsrm) {
      return {
        classificacao: 'DEVOLVER_TUDO',
        motivo_codigo: `validade_${meses}_meses`,
        motivo: `MSRM com validade próxima (${meses} meses) sem procura suficiente. Devolução total ao fornecedor ou transferência entre farmácias.`,
      };
    }
    return {
      classificacao: 'ESCOAMENTO_BALCAO',
      motivo_codigo: `validade_${meses}_meses`,
      motivo: `MNSRM/Venda Livre com validade próxima (${meses} meses). Colocar em destaque imediato de balcão para escoamento ou devolver ao armazém.`,
    };
  }

  // 3. Locomotivas de vendas (alta rotação VMM >= 2.0)
  if (item.vmm >= 2.0 && item.vendasUn > 0) {
    return {
      classificacao: 'MANTER',
      motivo_codigo: 'alta_rotacao',
      motivo: 'Locomotiva de faturação (VMM >= 2.0). Manter stock permanente e níveis de segurança ajustados.',
    };
  }

  // 4. Sem vendas ou Mono com excesso de stock
  if (item.stock > 0 && (item.vendasUn === 0 || (item.ehMono && item.ehExcesso))) {
    // Crónico nunca recebe DEVOLVER_TUDO
    if (isChronic) {
      return {
        classificacao: 'TRABALHAR_ENCOMENDA',
        motivo_codigo: 'cronico',
        motivo: 'Terapêutica crónica sem rotação recente. Manter no máximo 1 un de segurança ou trabalhar sob encomenda para doente crónico habitual.',
      };
    }
    if (item.ehMono && item.ehExcesso && item.vendasUn > 0 && item.stock > 1) {
      const alvo = Math.max(1, Math.ceil(item.vmm * 4));
      const excUn = Math.max(1, item.stock - alvo);
      return {
        classificacao: 'DEVOLVER_EXCESSO',
        motivo_codigo: 'excesso_cobertura',
        unidades_excesso: excUn,
        motivo: `Stock em excesso sem vendas recentes. Devolver ${excUn} un excedentes ao fornecedor e manter ${Math.max(1, item.stock - excUn)} un.`,
      };
    }
    if (isMsrm) {
      return {
        classificacao: 'DEVOLVER_TUDO',
        motivo_codigo: item.vendasUn === 0 ? 'sem_vendas' : 'mono_90_dias',
        motivo: 'MSRM sem vendas no período. Devolver ao fornecedor ou transferir para outra farmácia do grupo.',
      };
    }
    return {
      classificacao: 'DEVOLVER_TUDO',
      motivo_codigo: item.vendasUn === 0 ? 'sem_vendas' : 'mono_90_dias',
      motivo: 'Stock imobilizado sem vendas no período. Devolver ao fornecedor ou transferir.',
    };
  }

  // 5. Vendas baixas / esporádicas (VMM < 1.0)
  if (item.vmm < 1.0 && item.vendasUn > 0) {
    if (isChronic) {
      return {
        classificacao: 'STOCK_MINIMO',
        motivo_codigo: 'cronico',
        motivo: 'Terapêutica crónica com procura pontual. Manter stock mínimo de 1 unidade para assegurar continuidade ao doente crónico.',
      };
    }
    if (isMsrm) {
      if (item.margemPct !== null && item.margemPct < 30) {
        return {
          classificacao: 'TRABALHAR_ENCOMENDA',
          motivo_codigo: 'margem_baixa',
          motivo: 'MSRM com rotação baixa (VMM < 1.0) e margem reduzida (< 30%). Trabalhar sob encomenda diária.',
        };
      }
      return {
        classificacao: 'STOCK_MINIMO',
        motivo_codigo: 'alta_rotacao',
        motivo: 'MSRM com rotação lenta. Manter stock estritamente mínimo (1 un).',
      };
    }
    // MNSRM / Venda Livre (MSRM nunca recebe DESCONTINUAR)
    if (item.margemPct !== null && item.margemPct < 30) {
      return {
        classificacao: 'DESCONTINUAR',
        motivo_codigo: 'margem_baixa',
        motivo: 'MNSRM com margem < 30% e baixa procura. Descontinuar e substituir por alternativa de maior rotação/margem.',
      };
    }
    return {
      classificacao: 'STOCK_MINIMO',
      motivo_codigo: 'alta_rotacao',
      motivo: 'Manter stock mínimo de segurança.',
    };
  }

  // 6. Rotação moderada padrão (1.0 <= VMM < 2.0)
  return {
    classificacao: 'MANTER',
    motivo_codigo: 'alta_rotacao',
    motivo: 'Procura regular e stock ajustado. Manter reposição normal.',
  };
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
  // P0.1: Parte das vendas e junta o stock depois (LEFT JOIN), garantindo produtos em rutura
  const [rawMarts, allCatalog, allMeses] = await Promise.all([
    prisma.martProdutoMetricas.findMany({
      where: { farmaciaId: ctx.farmaciaId },
    }),
    prisma.produtoMestre.findMany({
      select: {
        cnp_codigo: true,
        designacao: true,
        pvp: true,
        margem_padrao: true,
        taxa_iva: true,
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

  const martMap = new Map(rawMarts.map((m) => [m.cnp_codigo, m]));
  const catMap = new Map(allCatalog.map((c) => [c.cnp_codigo, c]));

  // Indexar vendas mensais para todos os CNPs da farmácia
  const mesesGlobalSet = new Set<string>();
  const salesByCnpMonth = new Map<string, Map<string, { un: number; eur: number }>>();
  const cnpWithSales = new Set<string>();

  for (const vm of allMeses) {
    mesesGlobalSet.add(vm.mes);
    if (vm.quantidade > 0 || Number(vm.valor_total || 0) > 0) {
      cnpWithSales.add(vm.cnp_codigo);
    }
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

  const allowFaturacao = ctx.verFaturacao ?? canVerFaturacao(ctx.perfil, ctx.permissions);

  // Filtrar produtos partindo do catálogo completo com vendas ou stock (LEFT JOIN)
  const candidateProducts = allCatalog.filter((c) => {
    const hasSales = cnpWithSales.has(c.cnp_codigo);
    const hasMart = martMap.has(c.cnp_codigo);
    if (!hasSales && !hasMart) return false;

    const m = martMap.get(c.cnp_codigo);
    const lab = c.laboratorio_titular || m?.laboratorio_titular || null;
    const dci = c.dci || m?.molecula_dci || null;
    const categoria = c.categoria || m?.categoria || '';
    const tipoVenda = c.tipo_venda || m?.tipo_venda || '';
    const stock = m ? m.stock_total_unidades : 0;
    const ehRestoGaveta = stock >= 1 && stock <= 2;

    if (filtros.laboratorio && !matchesLabFilter(lab, c.designacao, filtros.laboratorio)) return false;
    if (filtros.dci && !stripAccents(dci || '').includes(stripAccents(filtros.dci))) return false;
    if (filtros.cnp && filtros.cnp.length > 0 && !filtros.cnp.includes(c.cnp_codigo)) return false;
    if (filtros.categoria && !stripAccents(categoria).includes(stripAccents(filtros.categoria))) return false;
    if (filtros.tipo_venda && tipoVenda !== filtros.tipo_venda) return false;
    if (filtros.segmento && m && m.segmento !== filtros.segmento) return false;
    if (filtros.eh_generico !== undefined && (m ? m.eh_generico : false) !== filtros.eh_generico) return false;
    if (filtros.stock_min !== undefined && stock < filtros.stock_min) return false;
    if (filtros.stock_max !== undefined && stock > filtros.stock_max) return false;

    if (filtros.texto) {
      const q = stripAccents(filtros.texto);
      const hay = stripAccents(`${c.cnp_codigo} ${c.designacao} ${dci || ''} ${lab || ''} ${categoria}`);
      if (q.length <= 5) {
        if (!new RegExp(`\\b${escapeRx(q)}`, 'i').test(hay)) return false;
      } else if (!hay.includes(q)) {
        return false;
      }
    }

    if (Array.isArray(filtros.flags) && filtros.flags.length > 0) {
      for (const fl of filtros.flags) {
        if (fl === 'eh_mono' && (!m || !m.eh_mono)) return false;
        if (fl === 'eh_excesso_cobertura' && (!m || !m.eh_excesso_cobertura)) return false;
        if (fl === 'eh_risco_caducidade' && (!m || !m.eh_risco_caducidade)) return false;
        if (fl === 'eh_risco_rutura') {
          const isRutura = m ? m.eh_risco_rutura : (stock === 0 && hasSales);
          if (!isRutura) return false;
        }
        if (fl === 'eh_resto_gaveta' && !ehRestoGaveta) return false;
      }
    }

    return true;
  });

  let totalVendasUn = 0;
  let totalVendasEur = 0;
  let nComVendas = 0;
  let nSemVendas = 0;
  let dciNulaCount = 0;

  const prodRows = candidateProducts.map((cat) => {
    const m = martMap.get(cat.cnp_codigo);
    const dci = cat.dci || m?.molecula_dci || null;
    if (!dci) dciNulaCount++;
    const lab = cat.laboratorio_titular || m?.laboratorio_titular || null;

    const mapMes = salesByCnpMonth.get(cat.cnp_codigo) || new Map<string, { un: number; eur: number }>();
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

    // Se o utilizador não filtrou um sub-período específico e m existe com histórico canónico
    if (!args.periodo && m && m.total_unidades_vendidas > 0) {
      vndUnPeriodo = m.total_unidades_vendidas;
    }

    totalVendasUn += vndUnPeriodo;
    totalVendasEur += vndEurPeriodo;
    if (vndUnPeriodo > 0) nComVendas++;
    else nSemVendas++;

    const q1 = mapMes.get(m1)?.un || 0;
    const q2 = mapMes.get(m2)?.un || 0;
    const q3 = mapMes.get(m3)?.un || 0;

    const stockTotal = m ? m.stock_total_unidades : 0;
    const custo = m ? Number(m.custo_unitario_medio || 0) : 0;
    const pvp = cat.pvp !== null ? Number(cat.pvp) : (m?.pvp != null ? Number(m.pvp) : null);
    const margemPadrao =
      cat.margem_padrao !== null
        ? Number(cat.margem_padrao)
        : m?.margem_padrao !== null && m?.margem_padrao !== undefined
        ? Number(m.margem_padrao)
        : null;
    const margemEst = computeSafeMarginPct(custo, pvp, margemPadrao, cat.taxa_iva);

    const vmmVal = m ? Number(m.vmm) : Math.round((vndUnPeriodo / 10) * 100) / 100;

    return {
      cnp_codigo: cat.cnp_codigo,
      designacao: cat.designacao,
      laboratorio_titular: lab,
      dci,
      categoria: cat.categoria || m?.categoria || null,
      segmento: m?.segmento || null,
      vendas_12m_un: vndUnPeriodo,
      vendas_12m_eur: allowFaturacao ? Number(vndEurPeriodo.toFixed(2)) : null,
      vmm: vmmVal,
      [colM1]: q1,
      [colM2]: q2,
      [colM3]: q3,
      margem_pct_est: margemEst,
      stock_total_unidades: stockTotal,
      eh_mono: m ? Boolean(m.eh_mono) : false,
      eh_resto_gaveta: stockTotal >= 1 && stockTotal <= 2,
      ...(args.comparar_com
        ? {
            unidades_a: vndUnPeriodo,
            unidades_b: compUn,
            unidades_delta: vndUnPeriodo - compUn,
            valor_eur_a: allowFaturacao ? Number(vndEurPeriodo.toFixed(2)) : null,
            valor_eur_b: allowFaturacao ? Number(compEur.toFixed(2)) : null,
            valor_eur_delta: allowFaturacao ? Number((vndEurPeriodo - compEur).toFixed(2)) : null,
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
  if (candidateProducts.length > 0 && dciNulaCount > 0) {
    const pct = Math.round((dciNulaCount / candidateProducts.length) * 100);
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
      faturacao_oculta: !allowFaturacao,
      n_linhas_total: linhas.length,
      avisos_dados: avisos,
    },
    colunas,
    linhas,
    totais: {
      vendas_12m_un: totalVendasUn,
      vendas_12m_eur: allowFaturacao ? Number(totalVendasEur.toFixed(2)) : null,
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

// ============================================================================
// 15. RELATÓRIO EXECUTIVO POR LABORATÓRIO (P1.4 & P1.5)
// ============================================================================
export interface RelatorioLaboratorioArgs {
  laboratorio: string;
  ano?: string;
  limiteTop?: number;
}

export async function toolRelatorioLaboratorio(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: RelatorioLaboratorioArgs
) {
  const labQuery = (args.laboratorio || '').trim();
  const ano = args.ano || '2026';
  const limiteTop = Math.min(Math.max(args.limiteTop || 10, 5), 50);
  const allowFaturacao = ctx.verFaturacao ?? canVerFaturacao(ctx.perfil, ctx.permissions);

  const [rawMarts, allCatalog, allMeses] = await Promise.all([
    prisma.martProdutoMetricas.findMany({ where: { farmaciaId: ctx.farmaciaId } }),
    prisma.produtoMestre.findMany({
      select: {
        cnp_codigo: true,
        designacao: true,
        pvp: true,
        margem_padrao: true,
        taxa_iva: true,
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

  const martMap = new Map(rawMarts.map((m) => [m.cnp_codigo, m]));

  // Indexar vendas do ano indicado (ex: '2026')
  const salesAno = new Map<string, { un: number; eur: number }>();
  for (const vm of allMeses) {
    if (!vm.mes.startsWith(ano)) continue;
    const cur = salesAno.get(vm.cnp_codigo) || { un: 0, eur: 0 };
    cur.un += vm.quantidade;
    cur.eur += Number(vm.valor_total || 0);
    salesAno.set(vm.cnp_codigo, cur);
  }

  // Filtrar produtos pertencentes ao laboratório
  const labProducts = allCatalog.filter((c) =>
    matchesLabFilter(c.laboratorio_titular, c.designacao, labQuery)
  );

  // Considerar todos os produtos que venderam no ano OU têm registo de métricas/stock na farmácia
  const activeLabProds = labProducts.filter(
    (c) => salesAno.has(c.cnp_codigo) || martMap.has(c.cnp_codigo)
  );

  let nVendidos = 0;
  let totalEur = 0;
  let totalUn = 0;
  let nStock = 0;
  let valorStockCusto = 0;
  let unStockTotal = 0;

  const prods: any[] = [];

  for (const c of activeLabProds) {
    const s = salesAno.get(c.cnp_codigo) || { un: 0, eur: 0 };
    const m = martMap.get(c.cnp_codigo);

    const stock = m ? m.stock_total_unidades : 0;
    const custoUnit = m ? Number(m.custo_unitario_medio || 0) : 0;
    const custoStockTotal = m ? Number(m.stock_total_valor_custo || 0) : 0;
    const vmm = m ? Number(m.vmm || 0) : Math.round((s.un / 10) * 100) / 100;
    const cobertura = m ? Number(m.cobertura_meses || 0) : 0;
    const margem = computeSafeMarginPct(
      custoUnit,
      c.pvp ? Number(c.pvp) : (m?.pvp ? Number(m.pvp) : null),
      c.margem_padrao ? Number(c.margem_padrao) : (m?.margem_padrao ? Number(m.margem_padrao) : null),
      c.taxa_iva
    );

    const isMono = m ? Boolean(m.eh_mono) : false;
    const isExcesso = m ? Boolean(m.eh_excesso_cobertura || cobertura > 4) : false;
    const isCaducidade = m ? Boolean(m.eh_risco_caducidade) : false;
    const dciVal = c.dci || (m ? m.molecula_dci : null);
    const isChronic = isTherapeuticChronic(dciVal, c.designacao);
    const mesesAteValidade = m?.meses_ate_validade ? Number(m.meses_ate_validade) : null;

    const pvpNum = c.pvp ? Number(c.pvp) : (m?.pvp ? Number(m.pvp) : null);

    const action = classifyProductAction({
      tipoVenda: c.tipo_venda || (m ? m.tipo_venda : null),
      dci: dciVal,
      designacao: c.designacao,
      stock,
      vendasUn: s.un,
      vmm,
      margemPct: margem,
      ehMono: isMono,
      ehExcesso: isExcesso,
      ehRiscoCaducidade: isCaducidade,
      mesesAteValidade,
      custoUnit,
      pvp: pvpNum,
    });

    const alertaDados = action.classificacao === 'REVER_DADOS' ? action.motivo : null;

    if (s.un > 0 || s.eur > 0) {
      nVendidos++;
      totalEur += s.eur;
      totalUn += s.un;
    }

    if (stock > 0) {
      nStock++;
      valorStockCusto += custoStockTotal;
      unStockTotal += stock;
    }

    prods.push({
      cnp: c.cnp_codigo,
      designacao: c.designacao,
      dci: dciVal,
      tipo_venda: c.tipo_venda || (m ? m.tipo_venda : null),
      vendas_eur: allowFaturacao ? Math.round(s.eur * 100) / 100 : null,
      vendas_un: s.un,
      vmm,
      stock,
      custo_unitario: Math.round(custoUnit * 100) / 100,
      valor_custo_stock: Math.round(custoStockTotal * 100) / 100,
      cobertura_meses: cobertura,
      margem_pct: margem,
      eh_mono: isMono,
      eh_excesso: isExcesso,
      eh_risco_caducidade: isCaducidade,
      eh_terapeutica_cronica: isChronic,
      validade: m?.data_validade_mais_proxima ? m.data_validade_mais_proxima.toISOString().slice(0, 10) : null,
      dias_sem_vendas: m ? m.dias_sem_vendas : null,
      classificacao: action.classificacao,
      motivo_codigo: action.motivo_codigo,
      motivo_classificacao: action.motivo,
      unidades_excesso: action.unidades_excesso ?? null,
      alerta_dados: alertaDados,
    });
  }

  // Ordenar produtos por vendas (decrescente)
  prods.sort((a, b) => {
    if (allowFaturacao && b.vendas_eur !== null && a.vendas_eur !== null) {
      return b.vendas_eur - a.vendas_eur;
    }
    return b.vendas_un - a.vendas_un;
  });

  // Top N produtos
  const topList = prods.slice(0, limiteTop);
  let cumEur = 0;
  for (const p of topList) {
    if (allowFaturacao && p.vendas_eur !== null) {
      cumEur += p.vendas_eur;
      p.pct_faturacao_acumulada = Number(((cumEur / Math.max(1, totalEur)) * 100).toFixed(1));
    }
  }

  // Cobertura 100% por classe de ação (D1: soma das contagens = total âmbito; soma dos € = total vendas)
  const classesMap = new Map<string, { classe: string; n_produtos: number; vendas_un: number; vendas_eur: number | null; stock_custo_eur: number }>();
  for (const p of prods) {
    const cur = classesMap.get(p.classificacao) || {
      classe: p.classificacao,
      n_produtos: 0,
      vendas_un: 0,
      vendas_eur: allowFaturacao ? 0 : null,
      stock_custo_eur: 0,
    };
    cur.n_produtos += 1;
    cur.vendas_un += p.vendas_un;
    if (allowFaturacao && cur.vendas_eur !== null && p.vendas_eur !== null) {
      cur.vendas_eur = Math.round((cur.vendas_eur + p.vendas_eur) * 100) / 100;
    }
    cur.stock_custo_eur = Math.round((cur.stock_custo_eur + p.valor_custo_stock) * 100) / 100;
    classesMap.set(p.classificacao, cur);
  }
  const classesResumo = Array.from(classesMap.values()).sort((a, b) => b.n_produtos - a.n_produtos);

  // Lacunas explícitas (Secção 2.3 + Regra D6)
  const lacunas: string[] = [];
  const d6UltimoMes = await checkMonthCompletenessD6(prisma, ctx.farmaciaId, `${ano}-10`);
  if (d6UltimoMes.incompleto && d6UltimoMes.aviso) {
    lacunas.push(`[D6 — Integridade de dados] ${d6UltimoMes.aviso} Os totais do período e os monos podem estar afetados.`);
  }
  const semDciCount = prods.filter((p) => !p.dci).length;
  if (semDciCount > 0) {
    lacunas.push(`${semDciCount} produtos do laboratório não têm DCI catalogada no ProdutoMestre.`);
  }
  const reverDadosProds = prods.filter((p) => p.classificacao === 'REVER_DADOS');
  if (reverDadosProds.length > 0) {
    lacunas.push(
      `${reverDadosProds.length} produto(s) marcados como REVER_DADOS por valores anómalos no ERP (${reverDadosProds
        .slice(0, 3)
        .map((p) => `${p.designacao.slice(0, 30)} [CNP ${p.cnp}]`)
        .join(', ')}).`
    );
  }
  lacunas.push(`Dados de vendas registados até 31-10-${ano} (período ${ano} jan-out).`);

  // Blocos analíticos pré-calculados
  const vendasBaixas = prods.filter((p) => p.vendas_un > 0 && p.vmm < 1.0);
  const semVendas = prods.filter((p) => p.stock > 0 && p.vendas_un === 0);
  const emRutura = prods.filter((p) => p.vendas_un > 0 && p.stock === 0);
  const monos = prods.filter((p) => p.stock > 0 && p.eh_mono);
  const excessos = prods.filter((p) => p.stock > 0 && p.eh_excesso);
  const validadesRisco = prods.filter((p) => p.stock > 0 && p.eh_risco_caducidade);

  // Imobilizado Total (União sem duplicações de monos, excessos e sem_vendas)
  const imobilizadoSet = new Set<string>();
  let valorImobilizadoTotal = 0;
  const produtosImobilizados: any[] = [];

  for (const p of [...monos, ...excessos, ...semVendas]) {
    if (!imobilizadoSet.has(p.cnp)) {
      imobilizadoSet.add(p.cnp);
      valorImobilizadoTotal += p.valor_custo_stock;
      produtosImobilizados.push(p);
    }
  }

  const periodoRotulo = `${ano} (jan–out)`;

  const result = {
    farmaciaId: ctx.farmaciaId,
    ferramenta: 'relatorio_laboratorio',
    meta: {
      tipo: 'relatorio_laboratorio',
      laboratorio: labQuery,
      ano,
      periodo_rotulo: periodoRotulo,
      data_referencia: '2026-10-31',
      faturacao_oculta: !allowFaturacao,
      regras_aplicadas: {
        msrm_sem_campanhas: true,
        terapeutica_cronica_protegida: true,
        left_join_vendas_stock: true,
      },
    },
    totais: {
      produtos_ambito_total: prods.length,
      produtos_vendidos: nVendidos,
      faturacao_eur: allowFaturacao ? Math.round(totalEur * 100) / 100 : null,
      unidades_vendidas: totalUn,
      produtos_em_stock: nStock,
      unidades_em_stock: unStockTotal,
      valor_stock_custo: Math.round(valorStockCusto * 100) / 100,
      produtos_ativos_total: activeLabProds.length,
      top5_faturacao_eur: allowFaturacao
        ? Math.round(prods.slice(0, 5).reduce((acc, p) => acc + (p.vendas_eur || 0), 0) * 100) / 100
        : null,
      top5_pct_faturacao: allowFaturacao
        ? Number(((prods.slice(0, 5).reduce((acc, p) => acc + (p.vendas_eur || 0), 0) / Math.max(1, totalEur)) * 100).toFixed(1))
        : null,
      top10_faturacao_eur: allowFaturacao
        ? Math.round(topList.reduce((acc, p) => acc + (p.vendas_eur || 0), 0) * 100) / 100
        : null,
      top10_pct_faturacao: allowFaturacao
        ? Number(((topList.reduce((acc, p) => acc + (p.vendas_eur || 0), 0) / Math.max(1, totalEur)) * 100).toFixed(1))
        : null,
    },
    classes_resumo: classesResumo,
    acoes_imediatas_por_classe: (() => {
      const order = ['REPOR', 'DEVOLVER_EXCESSO', 'DEVOLVER_TUDO', 'REVER_DADOS', 'TRABALHAR_ENCOMENDA'];
      const out: any[] = [];
      for (const cls of order) {
        const items = prods.filter((p) => p.classificacao === cls);
        if (items.length === 0) continue;
        const unDevolver =
          cls === 'DEVOLVER_EXCESSO'
            ? items.reduce((acc, p) => acc + Number(p.unidades_excesso || 0), 0)
            : cls === 'DEVOLVER_TUDO'
              ? items.reduce((acc, p) => acc + Number(p.stock || 0), 0)
              : null;
        const valDevolver =
          cls === 'DEVOLVER_EXCESSO'
            ? Math.round(items.reduce((acc, p) => acc + Number(p.unidades_excesso || 0) * Number(p.custo_unitario || 0), 0) * 100) / 100
            : cls === 'DEVOLVER_TUDO'
              ? Math.round(items.reduce((acc, p) => acc + Number(p.valor_custo_stock || 0), 0) * 100) / 100
              : null;
        out.push({
          classe: cls,
          n_produtos: items.length,
          unidades_a_devolver: unDevolver,
          valor_a_devolver_eur: valDevolver,
          // Listas de DEVOLVER_EXCESSO / DEVOLVER_TUDO completas quando <= 10 produtos (inclui Irbesartan!)
          principais: items.slice(0, items.length <= 10 ? items.length : 5).map((p) => ({
            cnp: p.cnp,
            designacao: p.designacao.slice(0, 48),
            stock: p.stock,
            vmm: p.vmm,
            unidades_excesso: p.unidades_excesso,
            valor_devolver_eur:
              cls === 'DEVOLVER_EXCESSO'
                ? Math.round(Number(p.unidades_excesso || 0) * Number(p.custo_unitario || 0) * 100) / 100
                : cls === 'DEVOLVER_TUDO'
                  ? p.valor_custo_stock
                  : null,
          })),
        });
      }
      return out;
    })(),
    lacunas,
    top: topList,
    vendas_baixas: {
      total_contagem: vendasBaixas.length,
      produtos: vendasBaixas.slice(0, 15),
    },
    sem_vendas: {
      total_contagem: semVendas.length,
      total_valor_custo: Math.round(semVendas.reduce((acc, p) => acc + p.valor_custo_stock, 0) * 100) / 100,
      produtos: semVendas,
    },
    em_rutura: {
      total_contagem: emRutura.length,
      produtos: emRutura.slice(0, 15),
    },
    monos: {
      total_contagem: monos.length,
      total_valor_custo: Math.round(monos.reduce((acc, p) => acc + p.valor_custo_stock, 0) * 100) / 100,
      produtos: monos.slice(0, 15),
    },
    excessos: {
      total_contagem: excessos.length,
      total_valor_custo: Math.round(excessos.reduce((acc, p) => acc + p.valor_custo_stock, 0) * 100) / 100,
      produtos: excessos.slice(0, 15),
    },
    validades: {
      total_contagem: validadesRisco.length,
      total_valor_custo: Math.round(validadesRisco.reduce((acc, p) => acc + p.valor_custo_stock, 0) * 100) / 100,
      produtos: validadesRisco,
    },
    rever_dados: {
      total_contagem: reverDadosProds.length,
      produtos: reverDadosProds,
    },
    imobilizado_total: {
      total_produtos_unicos: imobilizadoSet.size,
      total_valor_custo: Math.round(valorImobilizadoTotal * 100) / 100,
      produtos: produtosImobilizados.slice(0, 20),
    },
    todos_produtos_indice: prods.map((p) => ({
      cnp: p.cnp,
      designacao: p.designacao,
      dci: p.dci,
      tipo_venda: p.tipo_venda,
      eh_terapeutica_cronica: p.eh_terapeutica_cronica,
      classificacao: p.classificacao,
      unidades_excesso: p.unidades_excesso,
    })),
    relatorio_markdown: '',
    resumo_modelo: {} as any,
  };

  result.relatorio_markdown = formatRelatorioLaboratorioMarkdown(result);

  // Secção 4.1: Resumo compacto (<= 2.5k tokens) enviado ao modelo — o modelo NUNCA recebe as tabelas completas
  const compactItem = (p: any) => ({
    cnp: p.cnp,
    nome: p.designacao.slice(0, 48),
    tipo: p.tipo_venda,
    cronico: p.eh_terapeutica_cronica,
    ...(allowFaturacao ? { eur: p.vendas_eur } : {}),
    un: p.vendas_un,
    vmm: p.vmm,
    stock: p.stock,
    custo_stock: p.valor_custo_stock,
    acao: p.classificacao,
    ...(p.unidades_excesso ? { devolver_un: p.unidades_excesso } : {}),
  });

  // Destaques pré-calculados pelo código para a Leitura (o modelo escolhe 2-3 e explica sem somar nem contar)
  const top1Prod = topList[0] || null;
  const ruturaTop = emRutura[0] || null;
  const maiorImob = [...produtosImobilizados].sort((a, b) => (b.valor_custo_stock || 0) - (a.valor_custo_stock || 0))[0] || null;
  const valMaisProxima = [...validadesRisco].sort((a, b) => String(a.validade || '9999').localeCompare(String(b.validade || '9999')))[0] || null;

  result.resumo_modelo = {
    meta: {
      laboratorio: labQuery,
      periodo: periodoRotulo,
      dados_ate: '2026-10-31',
      faturacao_oculta: !allowFaturacao,
    },
    totais: result.totais,
    destaques: {
      top1_produto: top1Prod
        ? {
            nome: top1Prod.designacao.slice(0, 48),
            cnp: top1Prod.cnp,
            ...(allowFaturacao ? { vendas_eur: top1Prod.vendas_eur, quota_pct: top1Prod.pct_faturacao_acumulada } : {}),
            vendas_un: top1Prod.vendas_un,
          }
        : null,
      quota_top5_pct: result.totais.top5_pct_faturacao,
      produto_rutura_mais_vendido: ruturaTop
        ? {
            nome: ruturaTop.designacao.slice(0, 48),
            cnp: ruturaTop.cnp,
            ...(allowFaturacao ? { vendas_eur: ruturaTop.vendas_eur } : {}),
            vendas_un: ruturaTop.vendas_un,
            vmm: ruturaTop.vmm,
            acao: ruturaTop.classificacao,
          }
        : null,
      produto_maior_imobilizado: maiorImob
        ? {
            nome: maiorImob.designacao.slice(0, 48),
            cnp: maiorImob.cnp,
            valor_custo_stock: maiorImob.valor_custo_stock,
            stock: maiorImob.stock,
            acao: maiorImob.classificacao,
          }
        : null,
      produto_validade_mais_proxima: valMaisProxima
        ? {
            nome: valMaisProxima.designacao.slice(0, 48),
            cnp: valMaisProxima.cnp,
            validade: valMaisProxima.validade,
            stock: valMaisProxima.stock,
            devolver_un: valMaisProxima.unidades_excesso,
            acao: valMaisProxima.classificacao,
          }
        : null,
    },
    lacunas,
    instrucao:
      'Escreve 2 a 3 frases corridas em texto simples. Escolhe 2 ou 3 itens do bloco "destaques" e explica o que fazer primeiro e porquê. Não somes, não contes, não calcules, não repitas contagens de classes nem de blocos; usa apenas os valores exatos de "totais" e "destaques". Não escrevas títulos nem tabelas.',
  };

  return {
    ok: true,
    ...result,
  };
}

export function formatRelatorioLaboratorioMarkdown(res: any): string {
  const t = res.totais;
  const ano = res.meta?.ano || 2026;
  const lab = res.meta?.laboratorio || 'Laboratório';
  const ref = res.meta?.data_referencia || '2026-10-31';
  const periodoRotulo = res.meta?.periodo_rotulo || `${ano} (jan–out)`;
  const showEur = !res.meta?.faturacao_oculta && t.faturacao_eur !== null;
  const fmtEur = (v: number | null) =>
    v !== null && v !== undefined ? `${v.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €` : '—';

  let md = `## Relatório do Laboratório ${lab} — ${periodoRotulo}\n`;
  md += `**Período analisado:** ${periodoRotulo} | **Vendas registadas até:** ${ref}\n\n`;

  md += `### Visão Geral\n`;
  md += `Âmbito analisado: **${t.produtos_ambito_total} produtos ativos** (${t.produtos_vendidos} com vendas no período e ${t.produtos_em_stock} com stock atual).\n\n`;
  if (showEur) {
    md += `- **Faturação total:** ${fmtEur(t.faturacao_eur)}\n`;
  }
  md += `- **Unidades vendidas:** ${t.unidades_vendidas.toLocaleString('pt-PT')} un\n`;
  md += `- **Stock atual:** ${t.produtos_em_stock} referências | ${t.unidades_em_stock} unidades | ${fmtEur(t.valor_stock_custo)} a preço de custo\n`;
  md += `- **Imobilizado consolidado (união sem duplicados):** ${res.imobilizado_total?.total_produtos_unicos ?? 0} referências | ${fmtEur(res.imobilizado_total?.total_valor_custo ?? 0)}\n\n`;

  // Distribuição 100% por Classe de Ação (D1)
  if (Array.isArray(res.classes_resumo) && res.classes_resumo.length > 0) {
    md += `### Distribuição por Ação Recomendada (100% do âmbito: ${t.produtos_ambito_total} produtos)\n\n`;
    if (showEur) {
      md += `| Ação | N.º Produtos | Unidades Vendidas | Vendas (€) | Stock Custo (€) |\n`;
      md += `| :--- | :---: | :---: | :---: | :---: |\n`;
      for (const c of res.classes_resumo) {
        md += `| **${c.classe}** | ${c.n_produtos} | ${c.vendas_un.toLocaleString('pt-PT')} | ${fmtEur(c.vendas_eur)} | ${fmtEur(c.stock_custo_eur)} |\n`;
      }
      md += `| **TOTAL** | **${t.produtos_ambito_total}** | **${t.unidades_vendidas.toLocaleString('pt-PT')}** | **${fmtEur(t.faturacao_eur)}** | **${fmtEur(t.valor_stock_custo)}** |\n\n`;
    } else {
      md += `| Ação | N.º Produtos | Unidades Vendidas |\n`;
      md += `| :--- | :---: | :---: |\n`;
      for (const c of res.classes_resumo) {
        md += `| **${c.classe}** | ${c.n_produtos} | ${c.vendas_un.toLocaleString('pt-PT')} |\n`;
      }
      md += `| **TOTAL** | **${t.produtos_ambito_total}** | **${t.unidades_vendidas.toLocaleString('pt-PT')}** |\n\n`;
    }
  }

  // Ações Imediatas 100% geradas pelo código a partir das classes (contagens, unidades, valor a devolver e produtos principais)
  if (Array.isArray(res.acoes_imediatas_por_classe) && res.acoes_imediatas_por_classe.length > 0) {
    md += `### Ações Imediatas (por classe de decisão)\n\n`;
    for (const ac of res.acoes_imediatas_por_classe) {
      let cab = `- **${ac.classe} (${ac.n_produtos} ${ac.n_produtos === 1 ? 'produto' : 'produtos'})**`;
      if (ac.unidades_a_devolver !== null && ac.unidades_a_devolver !== undefined) {
        cab += ` — ${ac.unidades_a_devolver} un a devolver` + (showEur ? ` (${fmtEur(ac.valor_a_devolver_eur)} a preço de custo)` : '');
      }
      const exList = (ac.principais || [])
        .map((p: any) => {
          const extra =
            ac.classe === 'DEVOLVER_EXCESSO' && p.unidades_excesso
              ? ` [devolver ${p.unidades_excesso} un]`
              : ac.classe === 'DEVOLVER_TUDO'
                ? ` [${p.stock} un]`
                : ` [VMM ${Number(p.vmm || 0).toFixed(2)}]`;
          return `${p.designacao} (CNP ${p.cnp}${extra})`;
        })
        .join('; ');
      md += `${cab}: ${exList}.\n`;
    }
    md += `\n`;
  }

  // 1. Top N (título = número exato de linhas mostradas)
  const topShown = Array.isArray(res.top) ? res.top.length : 0;
  md += `### Top ${topShown} Produtos Mais Vendidos\n\n`;
  if (showEur) {
    md += `| CNP | Designação | DCI | Vendas (€) | Un | VMM | Stock | Cob. | Margem % | Ação |\n`;
    md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;
    for (const p of res.top) {
      const cob = p.cobertura_meses !== null ? `${p.cobertura_meses.toFixed(2)} m` : '—';
      const mrg = p.margem_pct !== null ? `${p.margem_pct.toFixed(1)}%` : '—';
      md += `| ${p.cnp} | ${p.designacao.slice(0, 48)} | ${p.dci || '—'} | ${fmtEur(p.vendas_eur)} | ${p.vendas_un} | ${p.vmm.toFixed(2)} | ${p.stock} | ${cob} | ${mrg} | **${p.classificacao}** |\n`;
    }
  } else {
    md += `| CNP | Designação | DCI | Un | VMM | Stock | Cob. | Ação |\n`;
    md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |\n`;
    for (const p of res.top) {
      const cob = p.cobertura_meses !== null ? `${p.cobertura_meses.toFixed(2)} m` : '—';
      md += `| ${p.cnp} | ${p.designacao.slice(0, 48)} | ${p.dci || '—'} | ${p.vendas_un} | ${p.vmm.toFixed(2)} | ${p.stock} | ${cob} | **${p.classificacao}** |\n`;
    }
  }
  md += `\n`;

  // 2. Vendas Baixas
  if (res.vendas_baixas && res.vendas_baixas.produtos.length > 0) {
    const baixasSlice = res.vendas_baixas.produtos.slice(0, 10);
    md += `### Produtos com Vendas Baixas (VMM < 1.0 — ${baixasSlice.length} de ${res.vendas_baixas.total_contagem} produtos)\n\n`;
    if (showEur) {
      md += `| CNP | Designação | DCI | Vendas (€) | VMM | Stock | Margem % | Ação | Motivo |\n`;
      md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |\n`;
      for (const p of baixasSlice) {
        const mrg = p.margem_pct !== null ? `${p.margem_pct.toFixed(1)}%` : '—';
        md += `| ${p.cnp} | ${p.designacao.slice(0, 42)} | ${p.dci || '—'} | ${fmtEur(p.vendas_eur)} | ${p.vmm.toFixed(2)} | ${p.stock} | ${mrg} | **${p.classificacao}** | ${p.motivo_classificacao} |\n`;
      }
    } else {
      md += `| CNP | Designação | DCI | VMM | Stock | Ação | Motivo |\n`;
      md += `| :--- | :--- | :--- | :---: | :---: | :--- | :--- |\n`;
      for (const p of baixasSlice) {
        md += `| ${p.cnp} | ${p.designacao.slice(0, 42)} | ${p.dci || '—'} | ${p.vmm.toFixed(2)} | ${p.stock} | **${p.classificacao}** | ${p.motivo_classificacao} |\n`;
      }
    }
    md += `\n`;
  }

  // 3. Sem Vendas
  if (res.sem_vendas && res.sem_vendas.produtos.length > 0) {
    md += `### Produtos Sem Vendas com Stock Imobilizado (${res.sem_vendas.produtos.length} produtos — ${fmtEur(res.sem_vendas.total_valor_custo)})\n\n`;
    md += `| CNP | Designação | DCI | Stock | Custo Total | Dias s/ Venda | Ação | Motivo |\n`;
    md += `| :--- | :--- | :--- | :---: | :---: | :---: | :--- | :--- |\n`;
    for (const p of res.sem_vendas.produtos) {
      const dsv = p.dias_sem_vendas !== null ? `${p.dias_sem_vendas} d` : '—';
      md += `| ${p.cnp} | ${p.designacao.slice(0, 42)} | ${p.dci || '—'} | ${p.stock} | ${fmtEur(p.valor_custo_stock)} | ${dsv} | **${p.classificacao}** | ${p.motivo_classificacao} |\n`;
    }
    md += `\n`;
  }

  // 4. Em Rutura
  if (res.em_rutura && res.em_rutura.produtos.length > 0) {
    const rutSlice = res.em_rutura.produtos.slice(0, 10);
    md += `### Produtos em Rutura com Procura Registada (Stock = 0 — ${rutSlice.length} de ${res.em_rutura.total_contagem} produtos)\n\n`;
    if (showEur) {
      md += `| CNP | Designação | DCI | Vendas (€) | Un | VMM | Ação | Motivo |\n`;
      md += `| :--- | :--- | :--- | :---: | :---: | :---: | :--- | :--- |\n`;
      for (const p of rutSlice) {
        md += `| ${p.cnp} | ${p.designacao.slice(0, 42)} | ${p.dci || '—'} | ${fmtEur(p.vendas_eur)} | ${p.vendas_un} | ${p.vmm.toFixed(2)} | **${p.classificacao}** | ${p.motivo_classificacao} |\n`;
      }
    } else {
      md += `| CNP | Designação | DCI | Un | VMM | Ação | Motivo |\n`;
      md += `| :--- | :--- | :--- | :---: | :---: | :--- | :--- |\n`;
      for (const p of rutSlice) {
        md += `| ${p.cnp} | ${p.designacao.slice(0, 42)} | ${p.dci || '—'} | ${p.vendas_un} | ${p.vmm.toFixed(2)} | **${p.classificacao}** | ${p.motivo_classificacao} |\n`;
      }
    }
    md += `\n`;
  }

  // 5. Monos (janela 90 dias, regra unificada com o painel)
  if (res.monos && res.monos.produtos.length > 0) {
    md += `### Monos (sem vendas nos últimos 90 dias; vendas registadas até ${ref} — ${res.monos.produtos.length} de ${res.monos.total_contagem} produtos, ${fmtEur(res.monos.total_valor_custo)})\n\n`;
    md += `| CNP | Designação | DCI | Stock | Custo Total | VMM | Dias s/ Venda | Ação | Motivo |\n`;
    md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |\n`;
    for (const p of res.monos.produtos) {
      const dsv = p.dias_sem_vendas !== null ? `${p.dias_sem_vendas} d` : '—';
      md += `| ${p.cnp} | ${p.designacao.slice(0, 38)} | ${p.dci || '—'} | ${p.stock} | ${fmtEur(p.valor_custo_stock)} | ${p.vmm.toFixed(2)} | ${dsv} | **${p.classificacao}** | ${p.motivo_classificacao} |\n`;
    }
    md += `\n`;
  }

  // 6. Validades Próximas
  if (res.validades && res.validades.produtos.length > 0) {
    md += `### Validades em Risco Próximo (< 6 meses)\n`;
    md += `Identificados **${res.validades.total_contagem} produtos** com caducidade próxima:\n\n`;
    md += `| CNP | Designação | Validade | Stock | VMM | Ação | Detalhe |\n`;
    md += `| :--- | :--- | :---: | :---: | :---: | :--- | :--- |\n`;
    for (const p of res.validades.produtos) {
      md += `| ${p.cnp} | ${p.designacao.slice(0, 42)} | ${p.validade || '—'} | ${p.stock} | ${p.vmm.toFixed(2)} | **${p.classificacao}** | ${p.motivo_classificacao} |\n`;
    }
    md += `\n`;
  }

  // 7. Rever Dados (valores anómalos)
  if (res.rever_dados && res.rever_dados.produtos.length > 0) {
    md += `### Produtos Marcados como REVER_DADOS (Auditoria Sifarma)\n\n`;
    md += `| CNP | Designação | Stock | Custo Unit. | Ação | Anomalia Detetada |\n`;
    md += `| :--- | :--- | :---: | :---: | :--- | :--- |\n`;
    for (const p of res.rever_dados.produtos) {
      md += `| ${p.cnp} | ${p.designacao.slice(0, 42)} | ${p.stock} | ${fmtEur(p.custo_unitario)} | **REVER_DADOS** | ${p.motivo_classificacao} |\n`;
    }
    md += `\n`;
  }

  // 8. Lacunas explícitas
  if (Array.isArray(res.lacunas) && res.lacunas.length > 0) {
    md += `### Notas e Lacunas de Dados\n`;
    for (const lac of res.lacunas) {
      md += `- ${lac}\n`;
    }
    md += `\n`;
  }

  return md;
}
