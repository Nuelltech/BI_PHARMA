import { PrismaClient, Prisma } from '@prisma/client';

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

  return {
    weekKey: key,
    tasksMap: map,
    totalConcluidas,
    valorPoupancaSalvo,
    recentTasks: tasks.filter((t: any) => t.concluido).slice(0, 10),
  };
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
 * Validação do PIN da farmácia para ambiente mobile
 */
export async function verifyMobileStaffPin(
  prisma: PrismaClient,
  farmaciaIdOrCode: string,
  pin: string
) {
  const cleanPin = (pin || '').trim();
  if (!cleanPin) {
    return { valid: false, error: 'PIN não introduzido.' };
  }

  // 1. Procurar a farmácia por ID ou por Código de Acesso
  const farm = await prisma.farmacia.findFirst({
    where: {
      OR: [
        { id: farmaciaIdOrCode },
        { codigo_acesso: { equals: farmaciaIdOrCode, mode: 'insensitive' } },
      ],
    },
  });

  if (!farm) {
    // Se não forneceu farmácia específica, tentar a primeira
    const firstFarm = await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'asc' } });
    if (!firstFarm) {
      return { valid: false, error: 'Nenhuma farmácia configurada no sistema.' };
    }
    return checkPinMatch(firstFarm, cleanPin);
  }

  return checkPinMatch(farm, cleanPin);
}

function checkPinMatch(farm: any, cleanPin: string) {
  const farmCode = (farm.codigo_acesso || '').toUpperCase();
  // Extrair números do código da farmácia (ex: FARM-A-7842 -> 7842)
  const codeNumbers = farmCode.replace(/[^0-9]/g, '');
  const last4 = codeNumbers.slice(-4);

  // Regras de validação do PIN mínimo de segurança:
  // 1. PIN padrão rápido: 1234
  // 2. Os últimos 4 dígitos do código da farmácia (ex: 7842 ou 9315)
  // 3. O próprio código de acesso completo (ex: FARM-A-7842)
  // 4. PIN mestre de segurança
  const isMatch =
    cleanPin === '1234' ||
    cleanPin === last4 ||
    cleanPin.toUpperCase() === farmCode ||
    cleanPin === (process.env.STAFF_MOBILE_PIN || '1234');

  if (isMatch) {
    return {
      valid: true,
      farmacia: {
        id: farm.id,
        nome: farm.nome,
        codigo_acesso: farm.codigo_acesso,
      },
    };
  }

  return {
    valid: false,
    error: 'PIN incorreto. (PIN padrão: 1234 ou os 4 dígitos do código da farmácia).',
  };
}
