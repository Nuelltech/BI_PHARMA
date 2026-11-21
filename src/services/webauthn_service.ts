import type { PrismaClient } from '@prisma/client';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import crypto from 'node:crypto';
import { logSecurityAudit } from './audit_service';

export function getWebAuthnRpConfig(originUrl?: string): { rpName: string; rpID: string; origin: string } {
  const rpName = 'BI Pharma SaaS';
  const envRpId = process.env.WEBAUTHN_RP_ID;
  const envOrigin = process.env.BASE_URL;

  let rpID = 'localhost';
  let origin = 'http://localhost:3000';

  if (originUrl) {
    try {
      const parsed = new URL(originUrl);
      rpID = parsed.hostname;
      origin = `${parsed.protocol}//${parsed.host}`;
    } catch {
      // fallback
    }
  } else if (envOrigin) {
    try {
      const parsed = new URL(envOrigin);
      rpID = envRpId || parsed.hostname;
      origin = `${parsed.protocol}//${parsed.host}`;
    } catch {
      // fallback
    }
  }

  if (envRpId) {
    rpID = envRpId;
  }

  return { rpName, rpID, origin };
}

/**
 * Gera opções de registo WebAuthn (Passkey) para um utilizador autenticado
 */
export async function getPasskeyRegistrationOptions(
  prisma: PrismaClient,
  opts: {
    utilizadorId: string;
    email: string;
    nome: string;
    requestOrigin?: string;
  }
) {
  const { rpName, rpID } = getWebAuthnRpConfig(opts.requestOrigin);

  // Buscar passkeys existentes do utilizador para excluir re-registo
  const existingCredentials = await prisma.credencialPasskey.findMany({
    where: { utilizadorId: opts.utilizadorId, revogadoEm: null },
    select: { credentialId: true, transports: true },
  });

  const excludeCredentials = existingCredentials.map((c) => ({
    id: c.credentialId,
    transports: c.transports as any,
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new Uint8Array(Buffer.from(opts.utilizadorId, 'utf-8')),
    userName: opts.email,
    userDisplayName: opts.nome,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    timeout: 60000,
  });

  // Guardar desafio no Postgres com validade de 5 minutos
  await prisma.desafioWebAuthn.create({
    data: {
      utilizadorId: opts.utilizadorId,
      email: opts.email,
      challenge: options.challenge,
      tipo: 'REGISTO',
      expiraEm: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  return options;
}

/**
 * Verifica e grava uma nova Passkey registada pelo utilizador
 */
export async function verifyAndSavePasskeyRegistration(
  prisma: PrismaClient,
  opts: {
    utilizadorId: string;
    response: any;
    nomeAmigavel?: string;
    requestOrigin?: string;
    ip?: string;
    userAgent?: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const { rpID, origin } = getWebAuthnRpConfig(opts.requestOrigin);

  // Localizar o desafio mais recente não expirado
  const now = new Date();
  const desafio = await prisma.desafioWebAuthn.findFirst({
    where: {
      utilizadorId: opts.utilizadorId,
      tipo: 'REGISTO',
      expiraEm: { gt: now },
    },
    orderBy: { criadoEm: 'desc' },
  });

  if (!desafio) {
    return { ok: false, error: 'O desafio WebAuthn expirou ou não foi encontrado. Tente novamente.' };
  }

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: opts.response,
      expectedChallenge: desafio.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err: any) {
    return { ok: false, error: `Falha na validação da Passkey: ${err.message}` };
  }

  const { verified, registrationInfo } = verification;
  if (!verified || !registrationInfo) {
    return { ok: false, error: 'Não foi possível verificar a assinatura da Passkey.' };
  }

  // Guardar credencial no Postgres
  await prisma.credencialPasskey.create({
    data: {
      utilizadorId: opts.utilizadorId,
      credentialId: registrationInfo.credential.id,
      publicKey: Buffer.from(registrationInfo.credential.publicKey),
      counter: BigInt(registrationInfo.credential.counter),
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
      transports: (opts.response?.response?.transports as string[]) || [],
      nomeAmigavel: opts.nomeAmigavel || 'Passkey (Biometria / Chave de Segurança)',
    },
  });

  // Limpar desafio consumido
  await prisma.desafioWebAuthn.delete({ where: { id: desafio.id } }).catch(() => {});

  await logSecurityAudit(prisma, {
    evento: 'PASSKEY_REGISTADA',
    utilizadorId: opts.utilizadorId,
    ip: opts.ip,
    userAgent: opts.userAgent,
    detalhes: {
      credentialId: registrationInfo.credential.id.slice(0, 8) + '...',
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
    },
  });

  return { ok: true };
}

/**
 * Gera opções de autenticação com Passkey (Login)
 */
export async function getPasskeyLoginOptions(
  prisma: PrismaClient,
  opts: {
    email?: string;
    requestOrigin?: string;
  }
) {
  const { rpID } = getWebAuthnRpConfig(opts.requestOrigin);

  let allowCredentials: { id: string; transports?: any[] }[] | undefined = undefined;
  let user: { id: string } | null = null;

  if (opts.email) {
    user = await prisma.utilizador.findUnique({
      where: { email: opts.email.trim().toLowerCase() },
      select: { id: true },
    });
    if (user) {
      const userCredentials = await prisma.credencialPasskey.findMany({
        where: { utilizadorId: user.id, revogadoEm: null },
        select: { credentialId: true, transports: true },
      });
      if (userCredentials.length > 0) {
        allowCredentials = userCredentials.map((c) => ({
          id: c.credentialId,
          transports: c.transports as any,
        }));
      }
    }
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'preferred',
    timeout: 60000,
  });

  // Guardar desafio no Postgres com validade de 5 minutos
  await prisma.desafioWebAuthn.create({
    data: {
      utilizadorId: user?.id || null,
      email: opts.email?.trim().toLowerCase() || null,
      challenge: options.challenge,
      tipo: 'LOGIN',
      expiraEm: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  return options;
}

/**
 * Verifica resposta de autenticação WebAuthn e localiza o utilizador proprietário da Passkey
 */
export async function verifyPasskeyLogin(
  prisma: PrismaClient,
  opts: {
    response: any;
    requestOrigin?: string;
    ip?: string;
    userAgent?: string;
  }
): Promise<{ ok: boolean; utilizadorId?: string; error?: string }> {
  const { rpID, origin } = getWebAuthnRpConfig(opts.requestOrigin);
  const credentialId = opts.response?.id;

  if (!credentialId) {
    return { ok: false, error: 'Identificador de credencial não fornecido.' };
  }

  // Localizar a credencial na base de dados
  const credential = await prisma.credencialPasskey.findUnique({
    where: { credentialId },
    include: { utilizador: true },
  });

  if (!credential || credential.revogadoEm || !credential.utilizador || !credential.utilizador.ativo) {
    return { ok: false, error: 'Passkey não reconhecida ou inativa.' };
  }

  // Localizar o desafio não expirado mais recente
  const now = new Date();
  const desafio = await prisma.desafioWebAuthn.findFirst({
    where: {
      tipo: 'LOGIN',
      expiraEm: { gt: now },
      OR: [
        { utilizadorId: credential.utilizadorId },
        { email: credential.utilizador.email },
        { utilizadorId: null },
      ],
    },
    orderBy: { criadoEm: 'desc' },
  });

  if (!desafio) {
    return { ok: false, error: 'Desafio WebAuthn expirou ou não foi emitido.' };
  }

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: opts.response,
      expectedChallenge: desafio.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: Number(credential.counter),
        transports: credential.transports as any,
      },
      requireUserVerification: false,
    });
  } catch (err: any) {
    return { ok: false, error: `Falha na verificação da assinatura biométrica: ${err.message}` };
  }

  if (!verification.verified) {
    return { ok: false, error: 'Assinatura biométrica rejeitada.' };
  }

  // Atualizar contador anti-clonagem e timestamp de último uso
  await prisma.credencialPasskey.update({
    where: { id: credential.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      ultimoUsoEm: now,
    },
  });

  // Limpar desafio consumido
  await prisma.desafioWebAuthn.delete({ where: { id: desafio.id } }).catch(() => {});

  await logSecurityAudit(prisma, {
    evento: 'PASSKEY_LOGIN',
    utilizadorId: credential.utilizadorId,
    ip: opts.ip,
    userAgent: opts.userAgent,
    detalhes: { metodo: 'PASSKEY', credentialId: credential.credentialId.slice(0, 8) + '...' },
  });

  return { ok: true, utilizadorId: credential.utilizadorId };
}
