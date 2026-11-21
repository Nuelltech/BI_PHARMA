// ============================================================================
// ARMAZÉM DE RESULTADOS DE FERRAMENTAS NA SESSÃO (ToolResultStore)
// ----------------------------------------------------------------------------
// 1. Guarda resultados tabulares completos (até 2000 linhas) por farmaciaId + sessionId.
// 2. Devolve ao modelo apenas o envelope compacto (primeiras N linhas, default 50).
// 3. Mantém o canal lateral (shoppingList) para a UI sem poluir o contexto do LLM.
// 4. Suporta a ferramenta refinar_resultado (filtrar, ordenar, escolher colunas em RAM).
// ============================================================================

export interface ToolResultEnvelope {
  ok: boolean;
  result_id?: string;
  ferramenta?: string;
  meta?: Record<string, any>;
  colunas?: string[];
  linhas?: any[][];
  totais?: Record<string, any>;
  erro?: {
    codigo: string;
    mensagem: string;
    valores_validos?: string[];
    colunas_disponiveis?: string[];
    reexecutar_com?: any;
  };
}

export interface StoredToolResult {
  result_id: string;
  farmaciaId: string;
  sessionId: string;
  turno: number;
  ferramenta: string;
  input: any;
  meta: Record<string, any>;
  colunas: string[];
  linhas: any[][]; // todas as linhas (até 2000)
  totais?: Record<string, any>;
  shoppingList?: any[];
  criado_em: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutos
const storeBySession = new Map<string, StoredToolResult[]>();
const counterBySession = new Map<string, number>();

function makeKey(farmaciaId: string, sessionId: string): string {
  return `${farmaciaId}::${sessionId}`;
}

export function pruneResultStore() {
  const now = Date.now();
  for (const [key, list] of storeBySession.entries()) {
    const valid = list.filter((item) => now - item.criado_em < TTL_MS);
    if (valid.length === 0) {
      storeBySession.delete(key);
      counterBySession.delete(key);
    } else if (valid.length !== list.length) {
      storeBySession.set(key, valid);
    }
  }
}

export function clearSessionResults(farmaciaId: string, sessionId: string) {
  const key = makeKey(farmaciaId, sessionId);
  storeBySession.delete(key);
  counterBySession.delete(key);
}

export function saveToolResult(params: {
  farmaciaId: string;
  sessionId: string;
  turno: number;
  ferramenta: string;
  input: any;
  meta: Record<string, any>;
  colunas: string[];
  linhas: any[][];
  totais?: Record<string, any>;
  limiteModelo?: number;
  shoppingList?: any[];
}): ToolResultEnvelope {
  pruneResultStore();
  const key = makeKey(params.farmaciaId, params.sessionId);
  const nextNum = (counterBySession.get(key) || 0) + 1;
  counterBySession.set(key, nextNum);
  const result_id = `r_${String(nextNum).padStart(4, '0')}`;

  const fullRows = params.linhas.slice(0, 2000);
  const maxForModel = Math.min(Math.max(params.limiteModelo || 50, 1), 200);
  const modelRows = fullRows.slice(0, maxForModel);

  const metaFinal = {
    ...params.meta,
    n_linhas_total: params.meta.n_linhas_total ?? fullRows.length,
    n_linhas_devolvidas: modelRows.length,
    truncado: fullRows.length > modelRows.length,
  };

  const entry: StoredToolResult = {
    result_id,
    farmaciaId: params.farmaciaId,
    sessionId: params.sessionId,
    turno: params.turno,
    ferramenta: params.ferramenta,
    input: params.input,
    meta: metaFinal,
    colunas: params.colunas,
    linhas: fullRows,
    totais: params.totais,
    shoppingList: params.shoppingList,
    criado_em: Date.now(),
  };

  const list = storeBySession.get(key) || [];
  list.push(entry);
  // Mantém até os últimos 15 resultados por sessão
  if (list.length > 15) list.splice(0, list.length - 15);
  storeBySession.set(key, list);

  return {
    ok: true,
    result_id,
    ferramenta: params.ferramenta,
    meta: metaFinal,
    colunas: params.colunas,
    linhas: modelRows,
    ...(params.totais ? { totais: params.totais } : {}),
  };
}

export function getStoredResultsForSession(farmaciaId: string, sessionId: string): StoredToolResult[] {
  pruneResultStore();
  const key = makeKey(farmaciaId, sessionId);
  return (storeBySession.get(key) || []).filter((r) => r.farmaciaId === farmaciaId);
}

export function getSessionLedgerText(farmaciaId: string, sessionId: string): string {
  const list = getStoredResultsForSession(farmaciaId, sessionId);
  if (list.length === 0) return '';

  const recent = list.slice(-5);
  const lines = recent.map((r) => {
    const filtrosStr = r.meta?.filtros_aplicados ? JSON.stringify(r.meta.filtros_aplicados) : '{}';
    return `[${r.result_id} | ${r.ferramenta} | filtros: ${filtrosStr} | ${r.linhas.length} linhas | colunas: ${r.colunas.join(', ')}]`;
  });

  return `<contexto_followup>\nResultados anteriores disponíveis nesta sessão para refinar_resultado:\n${lines.join('\n')}\n</contexto_followup>`;
}

export function getLatestTurnShoppingList(farmaciaId: string, sessionId: string, turno: number): any[] | null {
  const list = getStoredResultsForSession(farmaciaId, sessionId);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].turno === turno && Array.isArray(list[i].shoppingList) && list[i].shoppingList!.length > 0) {
      return list[i].shoppingList!;
    }
  }
  return null;
}

export function toolRefinarResultado(
  farmaciaId: string,
  sessionId: string,
  turno: number,
  args: {
    result_id?: string;
    filtro?: Array<[string, string, any]>;
    colunas?: string[];
    ordenar?: { campo: string; dir?: 'asc' | 'desc' };
    limite?: number;
  }
): ToolResultEnvelope {
  const list = getStoredResultsForSession(farmaciaId, sessionId);
  if (list.length === 0) {
    return {
      ok: false,
      erro: {
        codigo: 'RESULTADO_NAO_ENCONTRADO',
        mensagem: 'Não existem resultados anteriores guardados nesta sessão. Execute primeiro uma ferramenta consultar_*.',
      },
    };
  }

  const target = args.result_id
    ? list.find((r) => r.result_id === args.result_id && r.farmaciaId === farmaciaId)
    : list[list.length - 1];

  if (!target) {
    return {
      ok: false,
      erro: {
        codigo: 'RESULTADO_NAO_ENCONTRADO',
        mensagem: `Resultado "${args.result_id}" não encontrado nesta sessão.`,
        valores_validos: list.map((r) => r.result_id),
      },
    };
  }

  // Verificar se todas as colunas de filtro, ordenação e projeção existem
  const colIndex = new Map<string, number>();
  target.colunas.forEach((c, idx) => colIndex.set(c, idx));

  const checkCols: string[] = [];
  if (Array.isArray(args.filtro)) {
    for (const f of args.filtro) {
      if (Array.isArray(f) && f[0]) checkCols.push(String(f[0]));
    }
  }
  if (args.ordenar?.campo) checkCols.push(args.ordenar.campo);
  if (Array.isArray(args.colunas)) checkCols.push(...args.colunas);

  for (const col of checkCols) {
    if (!colIndex.has(col)) {
      return {
        ok: false,
        erro: {
          codigo: 'COLUNA_INDISPONIVEL',
          mensagem: `A coluna "${col}" não consta do resultado ${target.result_id}.`,
          colunas_disponiveis: target.colunas,
          reexecutar_com: { ferramenta: target.ferramenta, input_original: target.input },
        },
      };
    }
  }

  let rows = [...target.linhas];

  // Aplicar filtros
  if (Array.isArray(args.filtro) && args.filtro.length > 0) {
    rows = rows.filter((row) => {
      return args.filtro!.every(([col, op, val]) => {
        const idx = colIndex.get(col);
        if (idx === undefined) return true;
        const cell = row[idx];
        const opNorm = String(op || '=').trim().toLowerCase();

        if (opNorm === '=' || opNorm === '==' || opNorm === 'eq') {
          if (typeof cell === 'string' && typeof val === 'string') {
            return cell.toLowerCase() === val.toLowerCase();
          }
          return cell === val;
        }
        if (opNorm === '!=' || opNorm === '<>' || opNorm === 'neq') {
          if (typeof cell === 'string' && typeof val === 'string') {
            return cell.toLowerCase() !== val.toLowerCase();
          }
          return cell !== val;
        }
        if (opNorm === '>') return Number(cell ?? -Infinity) > Number(val);
        if (opNorm === '>=') return Number(cell ?? -Infinity) >= Number(val);
        if (opNorm === '<') return Number(cell ?? Infinity) < Number(val);
        if (opNorm === '<=') return Number(cell ?? Infinity) <= Number(val);
        if (opNorm === 'contains' || opNorm === 'like' || opNorm === 'includes') {
          return String(cell ?? '').toLowerCase().includes(String(val ?? '').toLowerCase());
        }
        if (opNorm === 'in' && Array.isArray(val)) {
          return val.map((v) => String(v).toLowerCase()).includes(String(cell ?? '').toLowerCase());
        }
        return true;
      });
    });
  }

  // Aplicar ordenação
  if (args.ordenar?.campo) {
    const idx = colIndex.get(args.ordenar.campo)!;
    const dir = (args.ordenar.dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const va = a[idx];
      const vb = b[idx];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'pt') * dir;
    });
  }

  // Selecionar colunas
  let finalCols = target.colunas;
  if (Array.isArray(args.colunas) && args.colunas.length > 0) {
    const indices = args.colunas.map((c) => colIndex.get(c)!);
    finalCols = args.colunas;
    rows = rows.map((r) => indices.map((i) => r[i]));
  }

  return saveToolResult({
    farmaciaId,
    sessionId,
    turno,
    ferramenta: 'refinar_resultado',
    input: args,
    meta: {
      ...target.meta,
      refinado_de: target.result_id,
      n_linhas_antes_filtro: target.linhas.length,
      n_linhas_total: rows.length,
      filtros_refinamento: args.filtro || [],
    },
    colunas: finalCols,
    linhas: rows,
    limiteModelo: args.limite || 50,
  });
}
