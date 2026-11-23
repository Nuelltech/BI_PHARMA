/**
 * BI PHARMA — Módulo Unificado de Permissões RBAC (P4.16)
 * 
 * Regra: O código verifica PERMISSÕES, nunca nomes de cargos soltos.
 * A permissão 'ver_faturacao' está estritamente restrita aos perfis de gestão:
 * DIRETOR, GESTOR, PROPRIETARIO, SUPERADMIN e COMPRADOR.
 * Perfis operacionais (AUXILIAR, OPERADOR_BALCAO) NÃO têm acesso a valores faturados em €.
 */

export type RolePlataforma =
  | 'SUPERADMIN'
  | 'PROPRIETARIO'
  | 'GESTOR'
  | 'DIRETOR'
  | 'DIRETOR_TECNICO'
  | 'COMPRADOR'
  | 'OPERADOR_BALCAO'
  | 'AUXILIAR';

export type PermissaoPlataforma =
  | 'ver_faturacao'
  | 'ver_custos'
  | 'ver_margens'
  | 'ver_stock_validades'
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

const ROLES_COM_ACESSO_FATURACAO = new Set<string>([
  'SUPERADMIN',
  'PROPRIETARIO',
  'GESTOR',
  'DIRETOR',
  'DIRETOR_TECNICO',
  'COMPLETO', // Conector MCP com perfil completo
]);

const ROLE_PERMISSOES_MAP: Record<string, PermissaoPlataforma[]> = {
  SUPERADMIN: [
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'ver_stock_validades',
    'ver_financas',
    'gerir_compras',
    'gerir_campanhas_tarefas',
    'executar_tarefas',
    'validar_clinica',
    'usar_copilot',
    'exportar_dados',
    'ver_grupo',
    'gerir_equipa_dispositivos',
    'ver_auditoria',
    'importar_dados',
  ],
  PROPRIETARIO: [
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'ver_stock_validades',
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
  GESTOR: [
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'ver_stock_validades',
    'ver_financas',
    'gerir_compras',
    'gerir_campanhas_tarefas',
    'executar_tarefas',
    'usar_copilot',
    'exportar_dados',
    'gerir_equipa_dispositivos',
    'ver_auditoria',
  ],
  DIRETOR: [
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'ver_stock_validades',
    'gerir_campanhas_tarefas',
    'executar_tarefas',
    'validar_clinica',
    'usar_copilot',
    'importar_dados',
  ],
  DIRETOR_TECNICO: [
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'ver_stock_validades',
    'gerir_campanhas_tarefas',
    'executar_tarefas',
    'validar_clinica',
    'usar_copilot',
    'importar_dados',
  ],
  COMPRADOR: [
    'ver_faturacao',
    'ver_custos',
    'ver_margens',
    'ver_stock_validades',
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
  AUXILIAR: [
    'ver_stock_validades',
    'executar_tarefas',
    'usar_copilot',
  ],
};

/**
 * Verifica se um utilizador ou perfil tem permissão explícita para ver faturação (€)
 */
export function canVerFaturacao(perfilOrRole?: string | null, customPermissions?: string[] | Set<string>): boolean {
  if (customPermissions) {
    if (customPermissions instanceof Set && customPermissions.has('ver_faturacao')) return true;
    if (Array.isArray(customPermissions) && customPermissions.includes('ver_faturacao')) return true;
  }
  if (!perfilOrRole) return false; // C4: fail-closed para API ou conectores sem perfil definido
  const normalized = perfilOrRole.toUpperCase().trim();
  return ROLES_COM_ACESSO_FATURACAO.has(normalized);
}

/**
 * Obtém o conjunto completo de permissões ativas para uma dada role/perfil
 */
export function getPermissoesForRole(perfilOrRole?: string | null): Set<PermissaoPlataforma> {
  if (!perfilOrRole) {
    return new Set(ROLE_PERMISSOES_MAP.OPERADOR_BALCAO);
  }
  const normalized = perfilOrRole.toUpperCase().trim();
  const perms = ROLE_PERMISSOES_MAP[normalized] || ROLE_PERMISSOES_MAP.OPERADOR_BALCAO;
  return new Set(perms);
}
