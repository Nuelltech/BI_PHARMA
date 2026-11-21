import { AsyncLocalStorage } from 'async_hooks';

export type UserRole = 'ADMIN' | 'DIRETOR' | 'GESTOR' | 'AUXILIAR' | 'SUPORTE' | 'NONE';

export interface TenantContext {
  authenticated: boolean;
  role: UserRole;
  userId?: string;
  userEmail?: string;
  userName?: string;
  farmaciaId: string | null;
  organizacaoId?: string | null;
  allowedFarmaciaIds: string[];
  sessionId?: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Obtém o contexto de tenant da execução assíncrona atual.
 */
export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Exige um contexto de tenant autenticado e bloqueado a uma farmácia específica.
 * Impede estritamente IDOR/BOLA e vazamento de dados entre tenants.
 */
export function requireTenantContext(): TenantContext {
  const ctx = getTenantContext();
  if (!ctx || !ctx.authenticated || !ctx.farmaciaId) {
    const err: any = new Error('Acesso não autorizado. Sessão inválida ou farmácia não selecionada.');
    err.statusCode = 401;
    throw err;
  }
  return ctx;
}

/**
 * Executa uma função dentro do escopo isolado do tenant context fornecido.
 */
export function runWithTenantContext<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run(context, fn);
}
