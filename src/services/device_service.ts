/**
 * Serviço de Gestão e Emparelhamento de Dispositivos de Balcão (Fase 3 / Spec v2.1)
 *
 * Garante que:
 *  1. Nenhum PIN pode ser aceite a partir de um dispositivo não emparelhado ou anónimo.
 *  2. O emparelhamento exige um código de uso único gerado por um administrador/diretor técnico.
 *  3. Cada dispositivo possui um token opaco único guardado em BD por hash SHA-256.
 *  4. A revogação de um dispositivo encerra imediatamente todas as sessões nele abertas.
 *  5. A autenticação por PIN gera sessões com metodo: 'PIN' e teto estrito de permissões.
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import {
  hashOpaqueToken,
  checkDbRateLimit,
  recordDbRateLimitHit,
  resetDbRateLimit,
  hashPinWithPepper,
  verifyPinHash,
} from './security_phase0';
import { computeEffectivePermissions, type Permission } from './auth_permissions';
import { logSecurityAudit } from './audit_service';

export interface DispositivoInfo {
  id: string;
  nome: string;
  farmaciaId: string;
  emparelhadoPor: string;
  emparelhadoEm: Date;
  ultimoUsoEm: Date | null;
  revogadoEm: Date | null;
}

/**
 * 1. Gera código temporário de emparelhamento (6 carateres, 10 minutos)
 * Requer utilizador com permissão para gerir equipa/dispositivos (Proprietário ou Superadmin)
 */
export async function generatePairingCode(
  prisma: PrismaClient,
  farmaciaId: string,
  criadoPor: string
): Promise<{ ok: boolean; codigo?: string; expiraEm?: Date; error?: string }> {
  try {
    // Código legível em maiúsculas e dígitos (sem 0, O, 1, I para evitar confusão)
    const charset = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += charset[bytes[i] % charset.length];
    }
    const formattedCode = `${code.slice(0, 3)}-${code.slice(3)}`;
    const codigoHash = hashOpaqueToken(formattedCode);
    const expiraEm = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos (Alinhado com a Especificação v2.1)

    await prisma.codigoEmparelhamento.create({
      data: {
        farmaciaId,
        codigoHash,
        criadoPor,
        expiraEm,
      },
    });

    await logSecurityAudit(prisma, {
      evento: 'DEVICE_PAIRED',
      utilizadorId: criadoPor,
      farmaciaId,
      detalhes: { stage: 'pairing_code_generated', expiraEm },
    });

    return { ok: true, codigo: formattedCode, expiraEm };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao gerar código de emparelhamento.' };
  }
}

/**
 * 2. Emparelhar um novo terminal de balcão utilizando o código temporário
 */
export async function pairDeviceWithCode(
  prisma: PrismaClient,
  input: {
    codigo: string;
    nomeDispositivo: string;
    ip?: string;
    userAgent?: string;
  }
): Promise<{
  ok: boolean;
  error?: string;
  deviceToken?: string;
  dispositivo?: DispositivoInfo;
}> {
  const cleanCode = String(input.codigo || '').trim().toUpperCase();
  const nome = String(input.nomeDispositivo || '').trim();

  if (!cleanCode) {
    return { ok: false, error: 'Código de emparelhamento obrigatório.' };
  }
  if (!nome || nome.length < 2) {
    return { ok: false, error: 'Nome do dispositivo obrigatório (ex.: "Balcão 1", "Tablet Atendimento").' };
  }

  // 1. Limite global de tentativas com alerta de auditoria (20 falhas/hora globalmente)
  const rlGlobalKey = 'pair_global_hour';
  const rlGlobal = await checkDbRateLimit(prisma, rlGlobalKey, 20, 60 * 60 * 1000, true);
  if (!rlGlobal.allowed) {
    await logSecurityAudit(prisma, {
      evento: 'LOGIN_FAIL',
      ip: input.ip || null,
      userAgent: input.userAgent || null,
      detalhes: { stage: 'pair_device', alert: 'ALERT_DEVICE_PAIRING_GLOBAL_RATE_LIMIT' },
    });
    return { ok: false, error: 'Demasiadas tentativas de emparelhamento. Aguarde 1 hora.' };
  }

  // 2. Rate limit anti brute-force de códigos de emparelhamento (5 tentativas por IP a cada 15 min)
  if (input.ip) {
    const rlKey = `pair_ip:${input.ip}`;
    const rl = await checkDbRateLimit(prisma, rlKey, 5, 15 * 60 * 1000, true);
    if (!rl.allowed) {
      return { ok: false, error: 'Demasiadas tentativas de emparelhamento deste endereço. Aguarde 15 minutos.' };
    }
    await recordDbRateLimitHit(prisma, rlKey, 15 * 60 * 1000);
  }

  const codigoHash = hashOpaqueToken(cleanCode);
  const now = new Date();

  const codeRecord = await prisma.codigoEmparelhamento.findUnique({
    where: { codigoHash },
  });

  if (!codeRecord || codeRecord.usadoEm || codeRecord.expiraEm < now) {
    // Registar falha no rate-limit global
    await recordDbRateLimitHit(prisma, rlGlobalKey, 60 * 60 * 1000, { maxBeforeBlock: 20 });
    return { ok: false, error: 'Código de emparelhamento inválido ou expirado.' };
  }

  const rawDeviceToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashOpaqueToken(rawDeviceToken);

  try {
    const dispositivo = await prisma.$transaction(async (tx) => {
      // Consumir código
      await tx.codigoEmparelhamento.update({
        where: { id: codeRecord.id },
        data: { usadoEm: now },
      });

      // Criar registo de dispositivo de balcão
      const dev = await tx.dispositivoBalcao.create({
        data: {
          farmaciaId: codeRecord.farmaciaId,
          nome,
          tokenHash,
          emparelhadoPor: codeRecord.criadoPor,
          emparelhadoEm: now,
          ultimoUsoEm: now,
        },
      });

      await tx.auditoriaSeguranca.create({
        data: {
          evento: 'DEVICE_PAIRED',
          utilizadorId: codeRecord.criadoPor,
          farmaciaId: codeRecord.farmaciaId,
          ip: input.ip || null,
          userAgent: input.userAgent || null,
          detalhes: { dispositivoId: dev.id, nome: dev.nome },
        },
      });

      return dev;
    });

    return {
      ok: true,
      deviceToken: rawDeviceToken,
      dispositivo: {
        id: dispositivo.id,
        nome: dispositivo.nome,
        farmaciaId: dispositivo.farmaciaId,
        emparelhadoPor: dispositivo.emparelhadoPor,
        emparelhadoEm: dispositivo.emparelhadoEm,
        ultimoUsoEm: dispositivo.ultimoUsoEm,
        revogadoEm: dispositivo.revogadoEm,
      },
    };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao emparelhar dispositivo.' };
  }
}

/**
 * 3. Valida o token de um dispositivo de balcão
 */
export async function validateDeviceToken(
  prisma: PrismaClient,
  farmaciaId: string,
  rawDeviceToken?: string | null
): Promise<{ valid: boolean; dispositivo?: DispositivoInfo; error?: string }> {
  if (!rawDeviceToken || rawDeviceToken.length < 32) {
    return { valid: false, error: 'Dispositivo de balcão não emparelhado ou token ausente.' };
  }

  const tokenHash = hashOpaqueToken(rawDeviceToken);
  const dev = await prisma.dispositivoBalcao.findUnique({
    where: { tokenHash },
  });

  if (!dev || dev.farmaciaId !== farmaciaId) {
    return { valid: false, error: 'Dispositivo não reconhecido para esta farmácia.' };
  }

  if (dev.revogadoEm) {
    return { valid: false, error: 'Este dispositivo de balcão foi desemparelhado ou revogado pelo administrador.' };
  }

  // Revogação automática de dispositivos sem uso durante 90 dias
  const NOVENTA_DIAS_MS = 90 * 24 * 60 * 60 * 1000;
  const lastActive = dev.ultimoUsoEm || dev.emparelhadoEm;
  if (lastActive && Date.now() - lastActive.getTime() > NOVENTA_DIAS_MS) {
    const now = new Date();
    await prisma.dispositivoBalcao.update({
      where: { id: dev.id },
      data: { revogadoEm: now },
    });
    await logSecurityAudit(prisma, {
      evento: 'DEVICE_REVOKED',
      farmaciaId,
      detalhes: {
        dispositivoId: dev.id,
        nome: dev.nome,
        motivo: 'Revogação automática por inatividade superior a 90 dias',
      },
    });
    return {
      valid: false,
      error: 'Dispositivo revogado por inatividade superior a 90 dias. Emparelhe novamente.',
    };
  }

  // Atualiza em background a última utilização do terminal
  prisma.dispositivoBalcao
    .update({
      where: { id: dev.id },
      data: { ultimoUsoEm: new Date() },
    })
    .catch(() => {});

  return {
    valid: true,
    dispositivo: {
      id: dev.id,
      nome: dev.nome,
      farmaciaId: dev.farmaciaId,
      emparelhadoPor: dev.emparelhadoPor,
      emparelhadoEm: dev.emparelhadoEm,
      ultimoUsoEm: dev.ultimoUsoEm,
      revogadoEm: dev.revogadoEm,
    },
  };
}

/**
 * 4. Listar dispositivos de uma farmácia
 */
export async function listPharmacyDevices(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<DispositivoInfo[]> {
  const list = await prisma.dispositivoBalcao.findMany({
    where: { farmaciaId },
    orderBy: { emparelhadoEm: 'desc' },
  });

  return list.map((d) => ({
    id: d.id,
    nome: d.nome,
    farmaciaId: d.farmaciaId,
    emparelhadoPor: d.emparelhadoPor,
    emparelhadoEm: d.emparelhadoEm,
    ultimoUsoEm: d.ultimoUsoEm,
    revogadoEm: d.revogadoEm,
  }));
}

/**
 * 5. Revogar / Desemparelhar dispositivo de balcão
 * Encerra imediatamente todas as sessões criadas por esse dispositivo
 */
export async function revokePharmacyDevice(
  prisma: PrismaClient,
  farmaciaId: string,
  dispositivoId: string,
  revogadoPor: string
): Promise<{ ok: boolean; error?: string }> {
  const dev = await prisma.dispositivoBalcao.findFirst({
    where: { id: dispositivoId, farmaciaId },
  });

  if (!dev) {
    return { ok: false, error: 'Dispositivo não encontrado.' };
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.dispositivoBalcao.update({
      where: { id: dev.id },
      data: { revogadoEm: now },
    }),
    // Encerra imediatamente todas as sessões ativas criadas através deste dispositivo
    prisma.sessao.updateMany({
      where: { dispositivoId: dev.id, revogadaEm: null },
      data: { revogadaEm: now },
    }),
    prisma.auditoriaSeguranca.create({
      data: {
        evento: 'DEVICE_REVOKED',
        utilizadorId: revogadoPor,
        farmaciaId,
        detalhes: { dispositivoId: dev.id, nome: dev.nome },
      },
    }),
  ]);

  return { ok: true };
}

/**
 * 6. Autenticação de Balcão por PIN Ligada ao Dispositivo (Fase 3 / Spec v2.1)
 *
 * Bloqueia se o dispositivo não for válido/emparelhado!
 * Valida o PIN com salt e pepper.
 * Emite sessão com metodo: 'PIN' e teto restrito de permissões.
 */
export async function authenticateBalcaoPin(
  prisma: PrismaClient,
  input: {
    farmaciaId: string;
    pin: string;
    memberId?: string;
    rawDeviceToken?: string | null;
    ip?: string;
    userAgent?: string;
  }
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  rawSessionToken?: string;
  member?: { id: string; nome: string; perfil: string };
  dispositivo?: { id: string; nome: string };
  permissoes?: string[];
}> {
  const farmaciaId = String(input.farmaciaId || '').trim();
  const cleanPin = String(input.pin || '').trim();

  if (!farmaciaId) {
    return { ok: false, statusCode: 400, error: 'Identificador de farmácia obrigatório.' };
  }
  if (!cleanPin) {
    return { ok: false, statusCode: 400, error: 'PIN obrigatório.' };
  }

  // 1. OBRIGATÓRIO: Validar dispositivo de balcão emparelhado
  const devCheck = await validateDeviceToken(prisma, farmaciaId, input.rawDeviceToken);
  if (!devCheck.valid || !devCheck.dispositivo) {
    return {
      ok: false,
      statusCode: 401,
      error: devCheck.error || 'Acesso recusado: o terminal não está emparelhado com esta farmácia.',
    };
  }

  // 2. Rate-limiting por membro ou por IP com bloqueio progressivo (15 min -> 1 h -> 24 h)
  const rlTarget = input.memberId ? `pin:${farmaciaId}:${input.memberId}` : `pin:${farmaciaId}:ip:${input.ip || 'unk'}`;
  const tierKey = `pin_tier:${farmaciaId}:${input.memberId || input.ip || 'unk'}`;
  const tierData = await checkDbRateLimit(prisma, tierKey, 100, 24 * 60 * 60 * 1000, false);
  const tierCount = tierData.count || 0;
  let currentBlockDurationMs = 15 * 60 * 1000;
  let currentBlockLabel = '15 minutos';
  if (tierCount === 1) {
    currentBlockDurationMs = 60 * 60 * 1000;
    currentBlockLabel = '1 hora';
  } else if (tierCount >= 2) {
    currentBlockDurationMs = 24 * 60 * 60 * 1000;
    currentBlockLabel = '24 horas';
  }

  const rl = await checkDbRateLimit(prisma, rlTarget, 5, currentBlockDurationMs, true);
  if (!rl.allowed) {
    return {
      ok: false,
      statusCode: 429,
      error: `PIN bloqueado temporariamente por demasiadas tentativas incorretas. Aguarde ${currentBlockLabel}.`,
    };
  }

  // 3. Procurar membro na farmácia
  let membro: any = null;
  if (input.memberId) {
    membro = await prisma.membroFarmacia.findFirst({
      where: { id: input.memberId, farmaciaId, estado: 'ATIVO' },
      include: { utilizador: true },
    });
  } else {
    // Se o tablet só enviou o PIN (ecrã partilhado de balcão): encontra membro com o pin correspondente
    const candidatos = await prisma.membroFarmacia.findMany({
      where: { farmaciaId, estado: 'ATIVO' },
      include: { utilizador: true },
    });
    for (const c of candidatos) {
      if (c.pinHash && verifyPinHash(cleanPin, c.id, c.pinHash)) {
        membro = c;
        break;
      }
    }
  }

  // Fallback para MembroEquipa legado caso ainda não tenha sido migrado para MembroFarmacia
  if (!membro && input.memberId) {
    const legado = await prisma.membroEquipa.findFirst({
      where: { id: input.memberId, farmaciaId, ativo: true },
    });
    if (legado && legado.pinHash && verifyPinHash(cleanPin, legado.id, legado.pinHash)) {
      membro = {
        id: legado.id,
        nome: legado.nome,
        perfil: legado.role || 'OPERADOR_BALCAO',
        permissoesExtra: [],
        utilizadorId: null,
        utilizador: null,
      };
    }
  }

  // Se não encontrou ou PIN incorreto
  const isPinValid = membro && membro.pinHash ? verifyPinHash(cleanPin, membro.id, membro.pinHash) : false;

  if (!membro || !isPinValid) {
    const hit = await recordDbRateLimitHit(prisma, rlTarget, currentBlockDurationMs, {
      maxBeforeBlock: 5,
      baseBlockMs: currentBlockDurationMs,
    });

    if (hit.blockedUntil) {
      // Escalar contador de bloqueio repetido
      await recordDbRateLimitHit(prisma, tierKey, 24 * 60 * 60 * 1000);
      await logSecurityAudit(prisma, {
        evento: 'PIN_LOCKED',
        farmaciaId,
        membroId: membro?.id || input.memberId || null,
        ip: input.ip || null,
        userAgent: input.userAgent || null,
        detalhes: {
          dispositivoId: devCheck.dispositivo.id,
          duracao: currentBlockLabel,
          escalado: tierCount > 0,
          alertaProprietario: tierCount > 0,
        },
      });
    }

    await logSecurityAudit(prisma, {
      evento: 'LOGIN_FAIL',
      farmaciaId,
      membroId: membro?.id || input.memberId || null,
      ip: input.ip || null,
      userAgent: input.userAgent || null,
      detalhes: { dispositivoId: devCheck.dispositivo.id, dispositivoNome: devCheck.dispositivo.nome },
    });
    return { ok: false, statusCode: 401, error: 'PIN incorreto.' };
  }

  // Reset do rate limit após sucesso
  await resetDbRateLimit(prisma, rlTarget);
  await resetDbRateLimit(prisma, tierKey);

  // 4. Calcular permissões com TETO RESTRITO DE PIN (metodo: 'PIN' - Allowlist estrita)
  const perfil = membro.perfil || 'OPERADOR_BALCAO';
  const permissoesEfetivas = computeEffectivePermissions(perfil, membro.permissoesExtra || [], 'PIN');

  // 5. Criar Sessão Segura com metodo: 'PIN' e dispositivoId associado
  const rawSessionToken = crypto.randomBytes(32).toString('hex');
  const sessionTokenHash = hashOpaqueToken(rawSessionToken);
  // Sessão de balcão tem duração máxima de 8 horas (alinhado com spec v2.1)
  const sessionExpires = new Date(Date.now() + 8 * 3600 * 1000);

  await prisma.sessao.create({
    data: {
      tokenHash: sessionTokenHash,
      utilizadorId: membro.utilizadorId || null,
      membroId: membro.id,
      farmaciaAtivaId: farmaciaId,
      metodo: 'PIN',
      dispositivoId: devCheck.dispositivo.id,
      expiraEm: sessionExpires,
    },
  });

  await logSecurityAudit(prisma, {
    evento: 'LOGIN_OK',
    utilizadorId: membro.utilizadorId || null,
    membroId: membro.id,
    farmaciaId,
    ip: input.ip || null,
    userAgent: input.userAgent || null,
    detalhes: {
      metodo: 'PIN',
      dispositivoId: devCheck.dispositivo.id,
      dispositivoNome: devCheck.dispositivo.nome,
    },
  });

  return {
    ok: true,
    statusCode: 200,
    rawSessionToken,
    member: {
      id: membro.id,
      nome: membro.nome,
      perfil,
    },
    dispositivo: {
      id: devCheck.dispositivo.id,
      nome: devCheck.dispositivo.nome,
    },
    permissoes: Array.from(permissoesEfetivas),
  };
}

/**
 * 7. Listar operadores disponíveis para seleção num terminal de balcão emparelhado.
 * Requer validação estrita do token do dispositivo emparelhado (__Host-dev).
 * Não expõe hashes, emails nem permissões, apenas id, nome e perfil para a interface do kiosk.
 */
export async function listAvailableOperators(
  prisma: PrismaClient,
  farmaciaId: string,
  rawDeviceToken?: string | null
): Promise<{
  ok: boolean;
  statusCode: number;
  operadores?: Array<{ id: string; nome: string; perfil: string }>;
  error?: string;
}> {
  if (!farmaciaId) {
    return { ok: false, statusCode: 400, error: 'Identificador de farmácia obrigatório.' };
  }

  // 1. OBRIGATÓRIO: Validar dispositivo de balcão emparelhado
  const devCheck = await validateDeviceToken(prisma, farmaciaId, rawDeviceToken);
  if (!devCheck.valid || !devCheck.dispositivo) {
    return {
      ok: false,
      statusCode: 401,
      error: devCheck.error || 'Acesso recusado: o terminal não está emparelhado com esta farmácia.',
    };
  }

  // 2. Procurar membros ativos da farmácia
  const membros = await prisma.membroFarmacia.findMany({
    where: { farmaciaId, estado: 'ATIVO' },
    select: { id: true, nome: true, perfil: true },
    orderBy: { nome: 'asc' },
  });

  if (membros.length > 0) {
    return {
      ok: true,
      statusCode: 200,
      operadores: membros.map((m) => ({ id: m.id, nome: m.nome, perfil: m.perfil })),
    };
  }

  // Fallback para MembroEquipa legado
  const legado = await prisma.membroEquipa.findMany({
    where: { farmaciaId, ativo: true },
    select: { id: true, nome: true, role: true },
    orderBy: { nome: 'asc' },
  });

  return {
    ok: true,
    statusCode: 200,
    operadores: legado.map((l) => ({ id: l.id, nome: l.nome, perfil: l.role || 'OPERADOR_BALCAO' })),
  };
}
