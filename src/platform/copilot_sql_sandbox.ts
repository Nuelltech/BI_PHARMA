import { parse } from 'libpg-query';
import type { PrismaClient } from '@prisma/client';
import type { Permission } from '../services/auth_permissions';

// ============================================================================
// SANDBOX SQL DO COPILOT — imposto pela BD, não por convenção (Revisão Fase 1)
//  1. Papéis de BD: copilot_ro_sem_custo / copilot_ro_com_custo (SET LOCAL ROLE na transação)
//  2. Esquema próprio `copilot` + search_path fixo (copilot, pg_catalog)
//  3. Parser real (libpg-query): 1 única instrução SELECT, sem funções fora da lista
//     (bloqueia set_config, pg_sleep, current_setting, etc.), sem funções no FROM,
//     só vistas do esquema copilot (ou CTEs do próprio statement)
//  4. Transação READ ONLY + statement_timeout + LIMIT imposto por wrapper
// ============================================================================

export type CopilotRole = 'copilot_ro_sem_custo' | 'copilot_ro_com_custo';

const ALLOWED_VIEWS_BY_ROLE: Record<CopilotRole, Set<string>> = {
  copilot_ro_sem_custo: new Set(['produtos', 'v_metricas', 'v_catalogo', 'v_grupos_dci']),
  copilot_ro_com_custo: new Set([
    'produtos',
    'produtos_com_custo',
    'v_metricas',
    'v_vendas_mes',
    'v_grupos_dci',
    'v_catalogo',
    'v_snapshots',
    'v_kpis',
  ]),
};

export const ALLOWED_VIEW_COLUMNS: Record<string, string[]> = {
  v_metricas: [
    'cnp_codigo', 'designacao', 'dci', 'tipo_venda', 'segmento', 'categoria', 'subcategoria',
    'laboratorio_titular', 'eh_resto_gaveta', 'stock_atual', 'vmm', 'meses_cobertura', 'pvp',
    'is_mono', 'is_excesso', 'is_risco_caducidade', 'data_validade_min', 'unidades_risco_caducidade', 'ultima_venda'
  ],
  produtos_com_custo: [
    'cnp_codigo', 'designacao', 'dci', 'tipo_venda', 'segmento', 'categoria', 'subcategoria',
    'laboratorio_titular', 'eh_resto_gaveta', 'stock_atual', 'vmm', 'meses_cobertura', 'pvp',
    'custo_unitario', 'valor_stock_custo', 'margem_pct', 'is_mono', 'is_excesso',
    'is_risco_caducidade', 'data_validade_min', 'unidades_risco_caducidade', 'valor_risco_caducidade', 'ultima_venda'
  ],
  v_vendas_mes: ['cnp_codigo', 'designacao', 'laboratorio_titular', 'dci', 'mes', 'quantidade', 'valor_total'],
  v_grupos_dci: [
    'grupo_equivalencia_dci', 'num_laboratorios_abertos', 'stock_total_unidades',
    'stock_total_valor_custo', 'vmm_total_grupo', 'custo_minimo', 'custo_maximo', 'poupanca_potencial_anual'
  ],
  v_catalogo: ['cnp_codigo', 'designacao', 'dci', 'dosagem', 'forma_farmaceutica', 'tipo_venda', 'categoria', 'subcategoria'],
  v_snapshots: ['cnp_codigo', 'designacao', 'data_snapshot', 'quantidade', 'custo_unitario', 'valor_total'],
};

/** Funções permitidas (agregação, texto, datas e matemática puras). Nada de set_config/pg_*. */
export const ALLOWED_SQL_FUNCTIONS_V1 = new Set<string>([
  'count', 'sum', 'avg', 'min', 'max',
  'round', 'ceil', 'ceiling', 'floor', 'abs', 'greatest', 'least', 'nullif', 'coalesce',
  'lower', 'upper', 'length', 'trim', 'ltrim', 'rtrim', 'substr', 'substring', 'concat',
  'date_trunc', 'extract', 'date_part', 'age',
]);
const ALLOWED_FUNCTIONS = ALLOWED_SQL_FUNCTIONS_V1;

const ALLOWED_CASTS = new Set<string>([
  'text', 'varchar', 'bpchar', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8',
  'date', 'timestamp', 'timestamptz', 'bool',
]);

const FORBIDDEN_NODE_TYPES = new Set<string>([
  'RangeFunction', 'SQLValueFunction', 'ParamRef', 'IntoClause', 'LockingClause',
  'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt', 'CopyStmt', 'VariableSetStmt',
  'VariableShowStmt', 'CallStmt', 'DoStmt', 'SelectIntoStmt', 'XmlExpr', 'RangeTableFunc',
  'CurrentOfExpr', 'MultiAssignRef',
]);

export function copilotRoleForPermissions(permissoes: Set<Permission>): CopilotRole {
  return permissoes.has('ver_custos') && permissoes.has('ver_margens')
    ? 'copilot_ro_com_custo'
    : 'copilot_ro_sem_custo';
}

export interface SqlValidationResult {
  ok: boolean;
  error?: string;
  role: CopilotRole;
  normalizedSql?: string;
}

function lastName(names: any[] | undefined): string {
  const last = (names || [])[Math.max(0, (names || []).length - 1)];
  return String(last?.String?.sval || '').toLowerCase();
}

function qualifier(names: any[] | undefined): string {
  if (!names || names.length < 2) return '';
  return String(names[0]?.String?.sval || '').toLowerCase();
}

function collectCteNames(node: any, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectCteNames(n, out);
    return;
  }
  if (node.CommonTableExpr?.ctename) out.add(String(node.CommonTableExpr.ctename).toLowerCase());
  for (const v of Object.values(node)) collectCteNames(v, out);
}

function walk(node: any, role: CopilotRole, cteNames: Set<string>): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const e = walk(n, role, cteNames);
      if (e) return e;
    }
    return null;
  }

  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_NODE_TYPES.has(key)) {
      return `Construção SQL não permitida (${key}).`;
    }

    if (key === 'FuncCall') {
      const fn = lastName((value as any).funcname);
      const q = qualifier((value as any).funcname);
      if (q && q !== 'pg_catalog') return 'Funções com esquema explícito não são permitidas.';
      if (!ALLOWED_FUNCTIONS.has(fn)) return `Função não permitida: ${fn}.`;
    }

    if (key === 'RangeVar') {
      const rv: any = value;
      const name = String(rv.relname || '').toLowerCase();
      const schema = String(rv.schemaname || '').toLowerCase();
      if (rv.catalogname) return 'Referência a outra base de dados não permitida.';
      const isCte = !schema && cteNames.has(name);
      if (!isCte) {
        if (schema && schema !== 'copilot') return 'Apenas vistas do esquema copilot são permitidas.';
        if (!ALLOWED_VIEWS_BY_ROLE[role].has(name)) {
          const validas = Array.from(ALLOWED_VIEWS_BY_ROLE[role]).join(', ');
          return `Sem permissão para consultar "${name}". Vistas permitidas para o seu papel: ${validas}.`;
        }
      }
    }

    if (key === 'TypeCast') {
      const tn = lastName((value as any).typeName?.names);
      if (!ALLOWED_CASTS.has(tn)) return `Conversão de tipo não permitida: ${tn}.`;
    }

    const err = walk(value, role, cteNames);
    if (err) return err;
  }
  return null;
}

export async function validateCopilotSql(rawSql: string, permissoes: Set<Permission>): Promise<SqlValidationResult> {
  const role = copilotRoleForPermissions(permissoes);
  const sql = String(rawSql || '').trim().replace(/;+\s*$/, '');
  if (!sql) return { ok: false, role, error: 'Consulta SQL vazia.' };
  if (sql.length > 4000) return { ok: false, role, error: 'Consulta SQL demasiado longa.' };

  let ast: any;
  try {
    ast = await parse(sql);
  } catch {
    return { ok: false, role, error: 'SQL inválido.' };
  }

  const stmts = ast?.stmts || [];
  if (stmts.length !== 1) return { ok: false, role, error: 'Apenas uma única instrução SELECT é permitida.' };
  const top = stmts[0]?.stmt;
  if (!top?.SelectStmt) return { ok: false, role, error: 'Apenas consultas SELECT são permitidas.' };

  const cteNames = new Set<string>();
  collectCteNames(top, cteNames);

  const err = walk(top, role, cteNames);
  if (err) return { ok: false, role, error: err };

  // LIMIT imposto por wrapper (não depende de regex nem de o modelo o escrever)
  const normalizedSql = `SELECT * FROM (${sql}) AS copilot_q LIMIT 200`;
  return { ok: true, role, normalizedSql };
}

export interface CopilotSqlSandboxResult {
  ok: boolean;
  error?: string;
  role?: CopilotRole;
  rows?: Record<string, unknown>[];
}

/**
 * Executa o SELECT validado numa transação READ ONLY, com o papel de BD correspondente às permissões.
 */
export async function executeCopilotSqlSandbox(
  prisma: PrismaClient,
  farmaciaId: string,
  permissoes: Set<Permission>,
  rawSql: string
): Promise<CopilotSqlSandboxResult> {
  if (!farmaciaId) return { ok: false, error: 'Farmácia não selecionada.' };

  const check = await validateCopilotSql(rawSql, permissoes);
  if (!check.ok || !check.normalizedSql) return { ok: false, role: check.role, error: check.error };

  try {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5000'");
      // set_config corre ANTES da troca de papel; o SQL do modelo nunca pode chamá-lo (parser)
      await tx.$executeRaw`SELECT set_config('app.farmacia_id', ${farmaciaId}, true)`;
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${check.role}`);
      await tx.$executeRawUnsafe('SET LOCAL search_path = copilot, pg_catalog');
      return tx.$queryRawUnsafe(check.normalizedSql!) as Promise<Record<string, unknown>[]>;
    });
    return { ok: true, role: check.role, rows: Array.isArray(rows) ? rows : [] };
  } catch (err: any) {
    const msg = String(err?.message || 'falha de execução');
    let help = '';
    if (/column.*does not exist/i.test(msg)) {
      help = ' Dica de colunas válidas por vista: ' +
        Object.entries(ALLOWED_VIEW_COLUMNS)
          .map(([v, cols]) => `${v} (${cols.slice(0, 6).join(', ')}...)`)
          .join(' | ');
    }
    return { ok: false, role: check.role, error: `Erro na consulta SQL isolada: ${msg}.${help}` };
  }
}
