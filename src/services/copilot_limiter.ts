import { PrismaClient } from '@prisma/client';

export interface ConcurrencyConfig {
  maxConcurrentPerTenant: number;
  maxConcurrentGlobal: number;
  defaultMonthlyBudgetEur: number;
}

const DEFAULT_CONFIG: ConcurrencyConfig = {
  maxConcurrentPerTenant: 3,
  maxConcurrentGlobal: 15,
  defaultMonthlyBudgetEur: 50.0, // 50€/mês por defeito por farmácia
};

// Controlo de concorrência ativa em memória por processo (thread-safe no Node event loop)
const activeTenantCalls = new Map<string, number>();
let activeGlobalCalls = 0;

/**
 * Tenta adquirir um slot de concorrência para executar uma consulta de IA.
 * Rejeita com mensagem amigável caso o tenant ou o sistema global estejam no limite.
 */
export function acquireCopilotSlot(
  farmaciaId: string,
  config: Partial<ConcurrencyConfig> = {}
): { allowed: boolean; reason?: string; retryAfterSeconds?: number } {
  const maxPerTenant = config.maxConcurrentPerTenant ?? DEFAULT_CONFIG.maxConcurrentPerTenant;
  const maxGlobal = config.maxConcurrentGlobal ?? DEFAULT_CONFIG.maxConcurrentGlobal;

  if (activeGlobalCalls >= maxGlobal) {
    return {
      allowed: false,
      reason: 'O sistema de IA está temporariamente sob carga elevada. Por favor tente dentro de momentos.',
      retryAfterSeconds: 3,
    };
  }

  const currentTenantCalls = activeTenantCalls.get(farmaciaId) || 0;
  if (currentTenantCalls >= maxPerTenant) {
    return {
      allowed: false,
      reason: `Atingiu o limite de consultas simultâneas (${maxPerTenant}) para esta farmácia. Aguarde que a consulta anterior termine.`,
      retryAfterSeconds: 2,
    };
  }

  activeTenantCalls.set(farmaciaId, currentTenantCalls + 1);
  activeGlobalCalls++;

  return { allowed: true };
}

/**
 * Liberta o slot de concorrência após a conclusão (ou erro) da consulta de IA.
 */
export function releaseCopilotSlot(farmaciaId: string): void {
  const current = activeTenantCalls.get(farmaciaId) || 0;
  if (current <= 1) {
    activeTenantCalls.delete(farmaciaId);
  } else {
    activeTenantCalls.set(farmaciaId, current - 1);
  }

  if (activeGlobalCalls > 0) {
    activeGlobalCalls--;
  }
}

/**
 * Retorna o número de chamadas ativas atualmente.
 */
export function getActiveCallsCount(farmaciaId?: string): { tenant: number; global: number } {
  return {
    tenant: farmaciaId ? (activeTenantCalls.get(farmaciaId) || 0) : 0,
    global: activeGlobalCalls,
  };
}

/**
 * Redefine os contadores em memória (útil para testes unitários).
 */
export function resetConcurrencyCounters(): void {
  activeTenantCalls.clear;
  activeTenantCalls.clear();
  activeGlobalCalls = 0;
}

/**
 * Verifica se a farmácia ultrapassou a sua quota mensal de consumo de IA.
 * Consulta os registos do mês civil corrente em CopilotUsageLog.
 */
export async function checkTenantMonthlyQuota(
  prisma: PrismaClient,
  farmaciaId: string,
  customBudgetEur?: number
): Promise<{ allowed: boolean; currentSpentEur: number; quotaEur: number; reason?: string }> {
  const quotaEur = customBudgetEur ?? DEFAULT_CONFIG.defaultMonthlyBudgetEur;

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  try {
    const logs = await prisma.copilotUsageLog.aggregate({
      where: {
        farmaciaId,
        criadoEm: { gte: startOfMonth },
      },
      _sum: {
        custo_estimado_eur: true,
      },
    });

    const currentSpentEur = Number(logs._sum.custo_estimado_eur || 0);

    if (currentSpentEur >= quotaEur) {
      return {
        allowed: false,
        currentSpentEur: Math.round(currentSpentEur * 100) / 100,
        quotaEur,
        reason: `Quota mensal de IA excedida (${currentSpentEur.toFixed(2)}€ utilizados de ${quotaEur.toFixed(2)}€ atribuídos). Contacte o suporte para expandir o limite.`,
      };
    }

    return {
      allowed: true,
      currentSpentEur: Math.round(currentSpentEur * 100) / 100,
      quotaEur,
    };
  } catch (err: any) {
    console.warn('[Copilot Limiter] Falha ao verificar quota mensal:', err.message);
    // Em caso de falha de consulta de telemetria, permite a consulta (Fail Open para não bloquear utilizador)
    return {
      allowed: true,
      currentSpentEur: 0,
      quotaEur,
    };
  }
}
