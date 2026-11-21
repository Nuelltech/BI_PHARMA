// ============================================================================
// MATRIZ DE PERMISSÕES v2.1 (BI Pharma — Especificação Unificada)
// O código verifica PERMISSÕES, nunca perfis diretamente.
// ============================================================================

export type PerfilFarmacia =
  | 'PROPRIETARIO'
  | 'DIRETOR_TECNICO'
  | 'COMPRADOR'
  | 'OPERADOR_BALCAO';

export type MetodoSessao = 'PASSWORD' | 'PIN' | 'PASSKEY';

export type Permission =
  | 'ver_stock_validades'
  | 'ver_faturacao'
  | 'ver_custos'
  | 'ver_margens'
  | 'ver_financas'
  | 'gerir_compras'
  | 'gerir_campanhas_tarefas'
  | 'executar_tarefas'
  | 'validar_clinica'
  | 'usar_copilot'
  | 'exportar_dados'
  | 'ver_grupo'
  | 'gerir_equipa_dispositivos'
  | 'ver_auditoria'
  | 'importar_dados';

const PERFIL_BASE_PERMISSIONS: Record<PerfilFarmacia, Permission[]> = {
  PROPRIETARIO: [
    'ver_stock_validades',
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'ver_financas',
    'gerir_compras',
    'gerir_campanhas_tarefas',
    'executar_tarefas',
    'usar_copilot',
    'exportar_dados',
    'ver_grupo',
    'gerir_equipa_dispositivos',
    'ver_auditoria',
    'importar_dados',
  ],
  DIRETOR_TECNICO: [
    'ver_stock_validades',
    'ver_faturacao',
    'gerir_campanhas_tarefas',
    'executar_tarefas',
    'validar_clinica',
    'usar_copilot',
    'importar_dados',
  ],
  COMPRADOR: [
    'ver_stock_validades',
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'gerir_compras',
    'gerir_campanhas_tarefas',
    'executar_tarefas',
    'usar_copilot',
    'exportar_dados',
    'ver_grupo',
  ],
  OPERADOR_BALCAO: [
    'ver_stock_validades',
    'executar_tarefas',
    'usar_copilot',
  ],
};

/**
 * Teto absoluto de sessão iniciada por PIN (Secção 6 & v2.1):
 * Implementado através de LISTA DE PERMITIDOS (Allowlist estrita):
 * A sessão por PIN só pode:
 *  - ver_stock_validades
 *  - usar_copilot (com campos restritos/filtrados)
 *  - executar_tarefas
 *  - gerir_campanhas_tarefas
 * Qualquer outra permissão (nova ou existente) é terminantemente bloqueada para sessões PIN.
 * Ações críticas como validar clínica, gerir equipa ou ver finanças/custos exigem PASSWORD.
 */
export const PIN_ALLOWED_PERMISSIONS = new Set<Permission>([
  'ver_stock_validades',
  'usar_copilot',
  'executar_tarefas',
  'gerir_campanhas_tarefas',
]);

export function computeEffectivePermissions(
  perfil: string,
  permissoesExtra: string[] = [],
  metodo: MetodoSessao = 'PASSWORD'
): Set<Permission> {
  const base = PERFIL_BASE_PERMISSIONS[perfil as PerfilFarmacia] || PERFIL_BASE_PERMISSIONS.OPERADOR_BALCAO;
  const result = new Set<Permission>(base);

  for (const extra of permissoesExtra || []) {
    result.add(extra as Permission);
  }

  if (metodo === 'PIN') {
    // Aplicação estrita da Allowlist para sessões de PIN
    for (const p of Array.from(result)) {
      if (!PIN_ALLOWED_PERMISSIONS.has(p)) {
        result.delete(p);
      }
    }
  }

  return result;
}

export function hasPermission(permissoes: Set<Permission> | Permission[], required: Permission): boolean {
  if (permissoes instanceof Set) return permissoes.has(required);
  return permissoes.includes(required);
}

/**
 * Regra v2.1: pvp_min revela o custo de compra (custo / 0,95 * (1 + IVA)).
 * Sem ver_custos, devolve APENAS abaixo_do_minimo: true/false e alerta, NUNCA o valor numérico.
 * Aplica-se no Copilot, na precificação e nos alertas comerciais.
 */
export function filterPvpMinForPermissions(
  pvpAtual: number | null | undefined,
  pvpMin: number | null | undefined,
  permissoes: Set<Permission>
): { pvp_min?: number; abaixo_do_minimo: boolean; alerta?: 'CAMPANHA_ABAIXO_MINIMO' } {
  const abaixo =
    typeof pvpAtual === 'number' &&
    typeof pvpMin === 'number' &&
    pvpMin > 0 &&
    pvpAtual < pvpMin;

  if (permissoes.has('ver_custos')) {
    return {
      pvp_min: typeof pvpMin === 'number' ? pvpMin : undefined,
      abaixo_do_minimo: abaixo,
      ...(abaixo ? { alerta: 'CAMPANHA_ABAIXO_MINIMO' as const } : {}),
    };
  }

  return {
    abaixo_do_minimo: abaixo,
    ...(abaixo ? { alerta: 'CAMPANHA_ABAIXO_MINIMO' as const } : {}),
  };
}

/**
 * Filtro recursivo de segurança: remove campos de custo, margem e pvp_min
 * de qualquer payload (API, alertas, Copilot) quando o operador não tem ver_custos / ver_margens.
 */
export function sanitizePayloadForPermissions<T>(data: T, permissoes: Set<Permission>): T {
  if (!data || typeof data !== 'object') return data;
  const canSeeCosts = permissoes.has('ver_custos');
  const canSeeMargins = permissoes.has('ver_margens');
  const canSeeSales = permissoes.has('ver_faturacao');

  if (canSeeCosts && canSeeMargins && canSeeSales) {
    return data;
  }

  function clean(val: any): any {
    if (val === null || val === undefined) return val;
    if (Array.isArray(val)) return val.map(clean);
    if (typeof val === 'object' && !(val instanceof Date)) {
      const out: any = {};
      for (const [k, v] of Object.entries(val)) {
        const lowerKey = k.toLowerCase();

        // 1. Ocultar custos e pvp_min
        if (!canSeeCosts) {
          if (
            lowerKey.includes('custo') ||
            lowerKey.includes('pvp_min') ||
            lowerKey.includes('pvpmin') ||
            lowerKey === 'valor_risco_caducidade' ||
            lowerKey === 'capital_excesso'
          ) {
            continue;
          }
        }

        // 2. Ocultar margens
        if (!canSeeMargins) {
          if (lowerKey.includes('margem')) {
            continue;
          }
        }

        // 3. Ocultar faturação global em euros para balcão
        if (!canSeeSales) {
          if (
            lowerKey === 'vendas_mes_eur' ||
            lowerKey === 'faturacao_total' ||
            lowerKey === 'faturacao_total_eur'
          ) {
            continue;
          }
        }

        out[k] = clean(v);
      }
      return out;
    }
    return val;
  }

  return clean(data);
}
