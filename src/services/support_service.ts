/**
 * Serviço de Consentimento de Suporte Técnico (Fase 4 / Spec v2.1)
 *
 * Garante que:
 *  1. Nenhum operador ou equipa de suporte Nuelltech acede aos dados da farmácia sem consentimento explícito.
 *  2. O consentimento é concedido pelo Proprietário com limite temporal estrito (ex: 2 a 8 horas).
 *  3. O consentimento pode ser revogado a qualquer momento pelo Proprietário.
 *  4. Todos os acessos e concessões ficam imutavelmente registados na auditoria.
 */

import type { PrismaClient } from '@prisma/client';
import { logSecurityAudit } from './audit_service';

export interface ConsentimentoInfo {
  id: string;
  farmaciaId: string;
  utilizadorSuporteId: string;
  concedidoPor: string;
  criadoEm: Date;
  expiraEm: Date;
  revogadoEm: Date | null;
  ativo: boolean;
}

/**
 * 1. Concede consentimento temporário de suporte técnico
 */
export async function grantSupportConsent(
  prisma: PrismaClient,
  input: {
    farmaciaId: string;
    concedidoPor: string;
    utilizadorSuporteId?: string;
    duracaoHoras?: number;
    motivo?: string;
  }
): Promise<{ ok: boolean; consentimento?: ConsentimentoInfo; error?: string }> {
  const farmaciaId = String(input.farmaciaId || '').trim();
  const concedidoPor = String(input.concedidoPor || '').trim();
  const duracao = Math.min(24, Math.max(1, input.duracaoHoras || 2)); // 1 a 24 horas (predefinição: 2 horas)
  const suporteId = input.utilizadorSuporteId || 'suporte_nuelltech_geral';

  if (!farmaciaId) {
    return { ok: false, error: 'Identificador de farmácia obrigatório.' };
  }

  const now = new Date();
  const expiraEm = new Date(now.getTime() + duracao * 3600 * 1000);

  try {
    // Revoga consentimentos anteriores pendentes desta farmácia
    await prisma.consentimentoSuporte.updateMany({
      where: { farmaciaId, revogadoEm: null, expiraEm: { gt: now } },
      data: { revogadoEm: now },
    });

    const c = await prisma.consentimentoSuporte.create({
      data: {
        farmaciaId,
        utilizadorSuporteId: suporteId,
        concedidoPor,
        expiraEm,
      },
    });

    await logSecurityAudit(prisma, {
      evento: 'SUPORTE_ACESSO',
      farmaciaId,
      utilizadorId: concedidoPor,
      detalhes: {
        action: 'consent_granted',
        consentimentoId: c.id,
        duracaoHoras: duracao,
        expiraEm,
        motivo: input.motivo || 'Diagnóstico e suporte operacional autorizado',
      },
    });

    return {
      ok: true,
      consentimento: {
        id: c.id,
        farmaciaId: c.farmaciaId,
        utilizadorSuporteId: c.utilizadorSuporteId,
        concedidoPor: c.concedidoPor,
        criadoEm: c.criadoEm,
        expiraEm: c.expiraEm,
        revogadoEm: c.revogadoEm,
        ativo: true,
      },
    };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao conceder consentimento de suporte.' };
  }
}

/**
 * 2. Obtém o estado do consentimento de suporte ativo
 */
export async function getActiveSupportConsent(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<{ ativo: boolean; consentimento?: ConsentimentoInfo }> {
  const now = new Date();
  const c = await prisma.consentimentoSuporte.findFirst({
    where: {
      farmaciaId,
      revogadoEm: null,
      expiraEm: { gt: now },
    },
    orderBy: { criadoEm: 'desc' },
  });

  if (!c) {
    return { ativo: false };
  }

  return {
    ativo: true,
    consentimento: {
      id: c.id,
      farmaciaId: c.farmaciaId,
      utilizadorSuporteId: c.utilizadorSuporteId,
      concedidoPor: c.concedidoPor,
      criadoEm: c.criadoEm,
      expiraEm: c.expiraEm,
      revogadoEm: c.revogadoEm,
      ativo: true,
    },
  };
}

/**
 * 3. Revoga imediatamente o consentimento de suporte
 */
export async function revokeSupportConsent(
  prisma: PrismaClient,
  farmaciaId: string,
  revogadoPor: string
): Promise<{ ok: boolean; error?: string }> {
  const now = new Date();
  try {
    const updated = await prisma.consentimentoSuporte.updateMany({
      where: {
        farmaciaId,
        revogadoEm: null,
      },
      data: {
        revogadoEm: now,
      },
    });

    await logSecurityAudit(prisma, {
      evento: 'SUPORTE_ACESSO',
      farmaciaId,
      utilizadorId: revogadoPor,
      detalhes: {
        action: 'consent_revoked',
        registosRevogados: updated.count,
      },
    });

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao revogar consentimento de suporte.' };
  }
}

/**
 * 4. Verifica se uma sessão de suporte está autorizada a consultar a farmácia
 */
export async function checkSupportAccessAllowed(
  prisma: PrismaClient,
  farmaciaId: string,
  utilizadorSuporteId?: string
): Promise<boolean> {
  const now = new Date();
  const consent = await prisma.consentimentoSuporte.findFirst({
    where: {
      farmaciaId,
      revogadoEm: null,
      expiraEm: { gt: now },
      ...(utilizadorSuporteId ? {
        OR: [
          { utilizadorSuporteId },
          { utilizadorSuporteId: 'suporte_nuelltech_geral' },
        ],
      } : {}),
    },
  });

  return Boolean(consent);
}
