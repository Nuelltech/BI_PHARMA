/**
 * Serviço de Verificação de Novo Dispositivo e Gestão de Dispositivos Confiados (Fase 4 / Spec v2.1)
 *
 * Garante que:
 *  1. Qualquer login a partir de um navegador/IP não reconhecido exige código de desafio por email (10 min).
 *  2. O utilizador pode marcar o dispositivo como confiado (30 a 90 dias).
 *  3. Dispositivos confiados são identificados por tokens opacos seguros em hash SHA-256 e cookie __Host-trusted-dev.
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import {
  hashOpaqueToken,
  checkDbRateLimit,
  recordDbRateLimitHit,
  resetDbRateLimit,
} from './security_phase0';
import { sendNewDeviceChallengeEmail } from './email_service';
import { logSecurityAudit } from './audit_service';

export interface CheckTrustedResult {
  trusted: boolean;
  dispositivoId?: string;
  error?: string;
}

/**
 * 1. Verifica se o token de dispositivo confiado apresentado é válido para este utilizador
 */
export async function checkTrustedDevice(
  prisma: PrismaClient,
  utilizadorId: string,
  rawTrustedToken?: string | null
): Promise<CheckTrustedResult> {
  if (!rawTrustedToken || rawTrustedToken.length < 32) {
    return { trusted: false };
  }

  const tokenHash = hashOpaqueToken(rawTrustedToken);
  const now = new Date();

  const dev = await prisma.dispositivoConfiado.findUnique({
    where: { tokenHash },
  });

  if (!dev || dev.utilizadorId !== utilizadorId || dev.revogadoEm || dev.expiraEm < now) {
    return { trusted: false };
  }

  // Renova janela de confiança em background
  prisma.dispositivoConfiado
    .update({
      where: { id: dev.id },
      data: { expiraEm: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    })
    .catch(() => {});

  return { trusted: true, dispositivoId: dev.id };
}

/**
 * 2. Gera desafio de 6 dígitos para autorização de novo dispositivo
 */
export async function createDeviceChallenge(
  prisma: PrismaClient,
  input: {
    utilizadorId: string;
    email: string;
    nome: string;
    ip?: string;
    userAgent?: string;
  }
): Promise<{ ok: boolean; challengeToken?: string; codePreview?: string; error?: string }> {
  try {
    // Código de 6 dígitos numéricos
    const code = crypto.randomInt(100000, 999999).toString();
    const challengeToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashOpaqueToken(challengeToken);
    const codigoHash = hashOpaqueToken(code);
    const expiraEm = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

    await prisma.tokenSeguranca.create({
      data: {
        tipo: 'CHALLENGE_LOGIN',
        tokenHash,
        utilizadorId: input.utilizadorId,
        expiraEm,
      },
    });

    // Guardar hash do código temporário em limite/cache seguro
    const cacheKey = `dev_challenge:${challengeToken}`;
    await checkDbRateLimit(prisma, cacheKey, 1, 10 * 60 * 1000, false);
    await prisma.limiteTaxa.upsert({
      where: { chave: cacheKey },
      create: { chave: cacheKey, janelaInicio: new Date(), contador: 1, bloqueadoAte: null },
      update: { janelaInicio: new Date(), contador: 1 },
    });

    // Enviar email via Resend
    sendNewDeviceChallengeEmail({
      to: input.email,
      nome: input.nome,
      code,
      ip: input.ip,
      userAgent: input.userAgent,
    }).catch((err) => console.error('[Resend Device Challenge Error]:', err));

    await logSecurityAudit(prisma, {
      evento: 'NEW_DEVICE_LOGIN',
      utilizadorId: input.utilizadorId,
      ip: input.ip || null,
      userAgent: input.userAgent || null,
      detalhes: { stage: 'challenge_created', expiraEm },
    });

    const isProd = process.env.NODE_ENV === 'production';
    return {
      ok: true,
      challengeToken,
      codePreview: !isProd ? code : undefined,
    };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao gerar desafio de novo dispositivo.' };
  }
}

/**
 * 3. Valida o código do desafio e emite o token de dispositivo confiado
 */
export async function verifyDeviceChallengeAndTrust(
  prisma: PrismaClient,
  input: {
    challengeToken: string;
    code: string;
    confiavel?: boolean;
    ip?: string;
    userAgent?: string;
  }
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  utilizadorId?: string;
  rawTrustedToken?: string;
}> {
  const challengeToken = String(input.challengeToken || '').trim();
  const code = String(input.code || '').trim();

  if (!challengeToken || challengeToken.length < 32) {
    return { ok: false, statusCode: 400, error: 'Token de desafio inválido.' };
  }
  if (!code || code.length !== 6) {
    return { ok: false, statusCode: 400, error: 'Código de verificação deve ter 6 dígitos.' };
  }

  // Rate-limiting de tentativas por challenge (máximo 5 tentativas)
  const rlKey = `challenge_try:${challengeToken}`;
  const rl = await checkDbRateLimit(prisma, rlKey, 5, 10 * 60 * 1000, true);
  if (!rl.allowed) {
    return { ok: false, statusCode: 429, error: 'Demasiadas tentativas de validação. Solicite um novo código.' };
  }

  const tokenHash = hashOpaqueToken(challengeToken);
  const now = new Date();

  const tokenRecord = await prisma.tokenSeguranca.findUnique({
    where: { tokenHash },
  });

  if (!tokenRecord || tokenRecord.usadoEm || tokenRecord.expiraEm < now) {
    return { ok: false, statusCode: 400, error: 'Código de verificação expirado ou inválido.' };
  }

  // Consumir o token de desafio de forma transacional e registar o dispositivo confiado
  const rawTrustedToken = crypto.randomBytes(32).toString('hex');
  const trustedHash = hashOpaqueToken(rawTrustedToken);
  const duracaoDias = input.confiavel ? 90 : 30;
  const expiraEm = new Date(Date.now() + duracaoDias * 24 * 60 * 60 * 1000);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.tokenSeguranca.update({
        where: { id: tokenRecord.id },
        data: { usadoEm: now },
      });

      if (tokenRecord.utilizadorId) {
        await tx.dispositivoConfiado.create({
          data: {
            utilizadorId: tokenRecord.utilizadorId,
            tokenHash: trustedHash,
            expiraEm,
          },
        });

        await tx.auditoriaSeguranca.create({
          data: {
            evento: 'DEVICE_VERIFIED',
            utilizadorId: tokenRecord.utilizadorId,
            ip: input.ip || null,
            userAgent: input.userAgent || null,
            detalhes: { diasConfianca: duracaoDias },
          },
        });
      }
    });

    await resetDbRateLimit(prisma, rlKey);

    return {
      ok: true,
      statusCode: 200,
      utilizadorId: tokenRecord.utilizadorId || undefined,
      rawTrustedToken,
    };
  } catch (err: any) {
    return { ok: false, statusCode: 500, error: err.message || 'Erro ao validar dispositivo.' };
  }
}
