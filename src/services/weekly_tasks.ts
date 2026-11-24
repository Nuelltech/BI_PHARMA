import { PrismaClient, Prisma } from '@prisma/client';
import { verifyMemberPin } from './rbac_settings';

export interface WeeklyTaskItem {
  id?: string;
  farmaciaId: string;
  week_key: string;
  task_id: string;
  categoria: string; // 'VALIDADE' | 'RESTO_GAVETA' | 'TRAVAR_SIFARMA' | 'OUTRO'
  cnp_codigo?: string | null;
  designacao?: string | null;
  concluido: boolean;
  concluido_por?: string | null;
  concluido_em?: Date;
  valor_impacto?: number | null;
}

export function getCurrentWeekKey(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Day of week (0 is Sunday, 1 is Monday, ...)
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export async function getPharmacyWeeklyTasks(
  prisma: PrismaClient,
  farmaciaId: string,
  weekKey?: string
) {
  const key = weekKey || getCurrentWeekKey();
  const tasks = await (prisma as any).tarefaEquipa.findMany({
    where: {
      farmaciaId,
      week_key: key,
    },
    orderBy: { concluido_em: 'desc' },
  });

  const map: Record<
    string,
    {
      concluido: boolean;
      concluido_por?: string | null;
      concluido_em?: string;
      valor_impacto?: number;
      categoria?: string;
    }
  > = {};

  let totalConcluidas = 0;
  let valorPoupancaSalvo = 0;

  for (const t of tasks) {
    map[t.task_id] = {
      concluido: t.concluido,
      concluido_por: t.concluido_por,
      concluido_em: t.concluido_em ? t.concluido_em.toISOString() : undefined,
      valor_impacto: t.valor_impacto !== null ? Number(t.valor_impacto) : undefined,
      categoria: t.categoria,
    };
    if (t.concluido) {
      totalConcluidas++;
      if (t.valor_impacto) {
        valorPoupancaSalvo += Number(t.valor_impacto);
      }
    }
  }

  const CUSTOM_CATS = new Set([
    'BALCAO_CAMPANHA',
    'ENCOMENDAS_CAMPANHA',
    'DIRECAO_TECNICA',
    'CAMPANHA',
    'MANUAL',
  ]);

  const customTasks = tasks
    .filter(
      (t: any) =>
        String(t.task_id || '').startsWith('MANUAL_') ||
        String(t.task_id || '').startsWith('CAMPANHA_') ||
        String(t.task_id || '').startsWith('COPILOT_') ||
        CUSTOM_CATS.has(String(t.categoria || '').toUpperCase())
    )
    .map((t: any) => ({
      id: t.id,
      task_id: t.task_id,
      week_key: t.week_key,
      categoria: t.categoria,
      cnp_codigo: t.cnp_codigo || null,
      designacao: t.designacao || 'Tarefa operacional',
      campanha_id: t.campanha_id || null,
      concluido: Boolean(t.concluido),
      concluido_por: t.concluido_por || null,
      concluido_em: t.concluido_em ? t.concluido_em.toISOString() : null,
      valor_impacto: t.valor_impacto !== null && t.valor_impacto !== undefined ? Number(t.valor_impacto) : null,
    }));

  return {
    weekKey: key,
    tasksMap: map,
    totalConcluidas,
    valorPoupancaSalvo,
    recentTasks: tasks.filter((t: any) => t.concluido).slice(0, 10),
    customTasks,
  };
}

export async function createManualWeeklyTask(
  prisma: PrismaClient,
  params: {
    farmaciaId: string;
    designacao: string;
    categoria?: string;
    cnp_codigo?: string;
    valor_impacto?: number | null;
    campanha_id?: string | null;
  }
) {
  const key = getCurrentWeekKey();
  const taskId = `MANUAL_${Date.now()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const cat = (params.categoria || 'DIRECAO_TECNICA').toUpperCase();
  const valDecimal =
    params.valor_impacto !== undefined && params.valor_impacto !== null && !Number.isNaN(Number(params.valor_impacto))
      ? new Prisma.Decimal(Number(params.valor_impacto))
      : null;

  return (prisma as any).tarefaEquipa.create({
    data: {
      farmaciaId: params.farmaciaId,
      week_key: key,
      task_id: taskId,
      categoria: cat,
      designacao: params.designacao.trim(),
      cnp_codigo: params.cnp_codigo ? String(params.cnp_codigo).trim() : null,
      campanha_id: params.campanha_id || null,
      concluido: false,
      concluido_por: null,
      valor_impacto: valDecimal,
    },
  });
}

export async function updateManualWeeklyTask(
  prisma: PrismaClient,
  params: {
    farmaciaId: string;
    taskId: string;
    designacao?: string;
    categoria?: string;
    valor_impacto?: number | null;
    weekKey?: string;
  }
) {
  const key = params.weekKey || getCurrentWeekKey();
  const data: any = {};
  if (params.designacao !== undefined) data.designacao = params.designacao.trim();
  if (params.categoria !== undefined) data.categoria = params.categoria.toUpperCase();
  if (params.valor_impacto !== undefined) {
    data.valor_impacto =
      params.valor_impacto !== null && !Number.isNaN(Number(params.valor_impacto))
        ? new Prisma.Decimal(Number(params.valor_impacto))
        : null;
  }
  return (prisma as any).tarefaEquipa.updateMany({
    where: {
      farmaciaId: params.farmaciaId,
      week_key: key,
      task_id: params.taskId,
    },
    data,
  });
}

export async function deleteManualWeeklyTask(
  prisma: PrismaClient,
  params: {
    farmaciaId: string;
    taskId: string;
    weekKey?: string;
  }
) {
  const key = params.weekKey || getCurrentWeekKey();
  return (prisma as any).tarefaEquipa.deleteMany({
    where: {
      farmaciaId: params.farmaciaId,
      week_key: key,
      task_id: params.taskId,
    },
  });
}

export async function toggleWeeklyTaskInDb(
  prisma: PrismaClient,
  params: {
    farmaciaId: string;
    taskId: string;
    concluido: boolean;
    concluido_por?: string;
    categoria?: string;
    cnp_codigo?: string;
    designacao?: string;
    valor_impacto?: number;
    weekKey?: string;
  }
) {
  const key = params.weekKey || getCurrentWeekKey();
  const cat = params.categoria || 'GERAL';
  const valDecimal =
    params.valor_impacto !== undefined && params.valor_impacto !== null
      ? new Prisma.Decimal(params.valor_impacto)
      : null;

  const res = await (prisma as any).tarefaEquipa.upsert({
    where: {
      farmaciaId_week_key_task_id: {
        farmaciaId: params.farmaciaId,
        week_key: key,
        task_id: params.taskId,
      },
    },
    update: {
      concluido: params.concluido,
      concluido_por: params.concluido ? params.concluido_por || 'Equipa' : null,
      concluido_em: new Date(),
      categoria: cat,
      cnp_codigo: params.cnp_codigo || null,
      designacao: params.designacao || null,
      valor_impacto: valDecimal,
    },
    create: {
      farmaciaId: params.farmaciaId,
      week_key: key,
      task_id: params.taskId,
      categoria: cat,
      cnp_codigo: params.cnp_codigo || null,
      designacao: params.designacao || null,
      concluido: params.concluido,
      concluido_por: params.concluido ? params.concluido_por || 'Equipa' : null,
      concluido_em: new Date(),
      valor_impacto: valDecimal,
    },
  });

  return res;
}

export async function resetWeeklyTasksInDb(
  prisma: PrismaClient,
  farmaciaId: string,
  weekKey?: string
) {
  const key = weekKey || getCurrentWeekKey();
  await (prisma as any).tarefaEquipa.deleteMany({
    where: {
      farmaciaId,
      week_key: key,
    },
  });
  return { ok: true, message: 'Todas as tarefas da semana foram reinicializadas.' };
}

/**
 * Validação segura do PIN da equipa de balcão (Fase 0):
 * - Usa exclusivamente pinHash (HMAC-SHA256 com pepper + salt por vínculo) em MembroEquipa
 * - Nunca aceita PINs em texto claro, STAFF_MOBILE_PIN nem dígitos de codigo_acesso
 * - Aplica bloqueio progressivo após 5 tentativas falhadas em 15 minutos
 */
export async function verifyMobileStaffPin(
  prisma: PrismaClient,
  farmaciaIdOrCode: string,
  pin: string,
  memberId?: string
) {
  const cleanPin = (pin || '').trim();
  if (!cleanPin) {
    return { valid: false, error: 'PIN não introduzido.' };
  }

  const targetFarm = (farmaciaIdOrCode || '').trim();
  if (!targetFarm) {
    return { valid: false, error: 'Farmácia não identificada.' };
  }

  const farm = await prisma.farmacia.findFirst({
    where: {
      OR: [
        { id: targetFarm },
        { codigo_acesso: { equals: targetFarm, mode: 'insensitive' } },
      ],
    },
  });

  if (!farm) {
    return { valid: false, error: 'Farmácia não encontrada.' };
  }

  const result = await verifyMemberPin(prisma, farm.id, cleanPin, memberId);
  if (!result.valid) {
    return {
      valid: false,
      error: result.error || 'PIN incorreto.',
      lockedUntil: result.lockedUntil,
    };
  }

  return {
    valid: true,
    requiresPinChange: Boolean(result.requiresPinChange),
    farmacia: {
      id: farm.id,
      nome: farm.nome,
      codigo_acesso: farm.codigo_acesso,
    },
    member: result.member
      ? {
          id: result.member.id,
          nome: result.member.nome,
          role: result.member.role,
          pinTemporario: result.member.pinTemporario,
        }
      : undefined,
  };
}

export interface WeeklyTaskAuditItem {
  id: string;
  task_id: string;
  categoria: string;
  cnp_codigo: string | null;
  designacao: string | null;
  concluido_por: string;
  concluido_em: string;
  valor_impacto: number;
}

export interface WeeklyTasksAuditReport {
  farmaciaId: string;
  totalConcluidas: number;
  valorProtegidoTotal: number;
  operadoresResumo: Array<{ operador: string; total: number; valorTotal: number }>;
  tarefas: WeeklyTaskAuditItem[];
}

export async function getWeeklyTasksAudit(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<WeeklyTasksAuditReport> {
  const tasks = await (prisma as any).tarefaEquipa.findMany({
    where: {
      farmaciaId,
      concluido: true,
    },
    orderBy: { concluido_em: 'desc' },
  });

  let totalConcluidas = 0;
  let valorProtegidoTotal = 0;
  const operadoresMap = new Map<string, { total: number; valorTotal: number }>();

  const list: WeeklyTaskAuditItem[] = [];

  for (const t of tasks) {
    totalConcluidas++;
    const val = t.valor_impacto !== null && t.valor_impacto !== undefined ? Number(t.valor_impacto) : 0;
    valorProtegidoTotal += val;

    const op = String(t.concluido_por || 'Equipa de Balcão').trim();
    const currOp = operadoresMap.get(op) || { total: 0, valorTotal: 0 };
    currOp.total += 1;
    currOp.valorTotal += val;
    operadoresMap.set(op, currOp);

    list.push({
      id: t.id,
      task_id: t.task_id,
      categoria: t.categoria || 'GERAL',
      cnp_codigo: t.cnp_codigo || null,
      designacao: t.designacao || null,
      concluido_por: op,
      concluido_em: t.concluido_em ? t.concluido_em.toISOString() : new Date().toISOString(),
      valor_impacto: Math.round(val * 100) / 100,
    });
  }

  const operadoresResumo = Array.from(operadoresMap.entries())
    .map(([operador, stats]) => ({
      operador,
      total: stats.total,
      valorTotal: Math.round(stats.valorTotal * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    farmaciaId,
    totalConcluidas,
    valorProtegidoTotal: Math.round(valorProtegidoTotal * 100) / 100,
    operadoresResumo,
    tarefas: list,
  };
}
