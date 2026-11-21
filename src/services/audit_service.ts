import type { PrismaClient } from '@prisma/client';

export type SecurityAuditEvent =
  | 'LOGIN_OK'
  | 'LOGIN_FAIL'
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'NEW_DEVICE_LOGIN'
  | 'DEVICE_VERIFIED'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED'
  | 'PIN_RESET'
  | 'PIN_LOCKED'
  | 'SWITCH_FARMACIA'
  | 'ACESSO_NEGADO'
  | 'ROLE_CHANGED'
  | 'USER_INVITED'
  | 'INVITE_ACCEPTED'
  | 'SESSION_REVOKED'
  | 'DEVICE_PAIRED'
  | 'DEVICE_REVOKED'
  | 'REGRA_CLINICA_ASSINADA'
  | 'PACK_CLINICO_APROVADO_DT'
  | 'PACK_CLINICO_REJEITADO_DT'
  | 'SUPORTE_ACESSO'
  | 'FARMACIA_CRIADA'
  | 'SUPERADMIN_CRIADO'
  | 'TOTP_ATIVADO'
  | 'TOTP_FALHOU'
  | 'RECOVERY_CODE_USADO'
  | 'PASSKEY_REGISTADA'
  | 'PASSKEY_LOGIN'
  | 'IMPORT_COMPLETED'
  | 'IMPORT_REJECTED';

const FORBIDDEN_DETAIL_KEYS = new Set([
  'password',
  'passwordHash',
  'pin',
  'pinHash',
  'token',
  'rawToken',
  'totpSecret',
  'condicoes_cliente',
  'condicoesCliente',
  'pergunta',
  'prompt',
]);

function sanitizeAuditDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (FORBIDDEN_DETAIL_KEYS.has(k)) continue;
    clean[k] = v;
  }
  return clean;
}

/**
 * Insere evento na tabela auditoria_seguranca (append-only).
 * Nunca grava passwords, PINs, tokens, condicoes_cliente nem texto das perguntas ao Copilot.
 */
export async function logSecurityAudit(
  prisma: PrismaClient,
  entry: {
    evento: SecurityAuditEvent;
    utilizadorId?: string | null;
    membroId?: string | null;
    farmaciaId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    detalhes?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await prisma.auditoriaSeguranca.create({
      data: {
        evento: entry.evento,
        utilizadorId: entry.utilizadorId || null,
        membroId: entry.membroId || null,
        farmaciaId: entry.farmaciaId || null,
        ip: entry.ip || null,
        userAgent: entry.userAgent ? String(entry.userAgent).slice(0, 250) : null,
        detalhes: sanitizeAuditDetails(entry.detalhes) as any,
      },
    });
  } catch (err) {
    // Regista em stderr estruturado para nunca perder o sinal mesmo se a BD falhar
    console.error(
      JSON.stringify({
        evento: 'AUDIT_WRITE_FAILED',
        originalEvent: entry.evento,
        error: (err as Error).message,
      })
    );
  }
}
