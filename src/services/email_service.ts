/**
 * Serviço de Emails Transacionais (Fase 2 / Spec v2.1)
 *
 * Envio de emails transacionais através do Resend:
 *  - Remetente oficial: info@bipharma.nuelltech.com
 *  - Convite de novos membros (accept-invite)
 *  - Recuperação segura de password (reset-password)
 *  - Alerta de novo dispositivo / IP detetado
 *  - Fallback defensivo para log em desenvolvimento/testes se RESEND_API_KEY não estiver configurada
 */

import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY || '';
const resend = resendApiKey ? new Resend(resendApiKey) : null;

export const DEFAULT_EMAIL_FROM = process.env.EMAIL_FROM || 'BI Pharma <info@bipharma.nuelltech.com>';

function getBaseAppUrl(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const raw =
    process.env.APP_URL ||
    process.env.ALLOWED_ORIGIN ||
    (isProd ? 'https://bipharma.nuelltech.com' : 'http://localhost:3000');
  // ALLOWED_ORIGIN pode conter vários domínios separados por vírgula; usar sempre o 1.º domínio canónico
  const primary = raw.split(',')[0].trim();
  return primary.replace(/\/$/, '');
}

export interface SendEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  previewUrl?: string;
}

/**
 * 1. Email de Convite para a Farmácia (Membro de Equipa / Gestor)
 */
export async function sendInviteEmail(input: {
  to: string;
  nome: string;
  farmaciaNome: string;
  perfil: string;
  token: string;
}): Promise<SendEmailResult> {
  const appUrl = getBaseAppUrl();
  const inviteLink = `${appUrl}/accept-invite?token=${encodeURIComponent(input.token)}`;

  const subject = `Convite para aceder à ${input.farmaciaNome} no BI Pharma`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div style="margin-bottom: 24px;">
      <h2 style="color: #0284c7; margin: 0 0 6px 0; font-size: 20px; font-weight: 800;">BI PHARMA</h2>
      <p style="color: #64748b; margin: 0; font-size: 13px;">Plataforma de Inteligência Farmacêutica</p>
    </div>

    <p style="font-size: 15px; line-height: 1.6;">Olá <strong>${escapeHtml(input.nome)}</strong>,</p>
    <p style="font-size: 15px; line-height: 1.6;">
      Foi convidado(a) para colaborar na <strong>${escapeHtml(input.farmaciaNome)}</strong> na plataforma <strong>BI Pharma</strong>.
    </p>

    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px 18px; margin: 20px 0;">
      <span style="font-size: 13px; color: #166534; font-weight: 600;">Perfil atribuído:</span>
      <span style="font-size: 13px; color: #15803d; font-weight: 700; margin-left: 6px;">${escapeHtml(input.perfil)}</span>
    </div>

    <p style="font-size: 14px; line-height: 1.5; color: #475569;">
      Para definir a sua password e aceder ao sistema, clique no botão seguro abaixo. Este convite é pessoal e expira em 48 horas.
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin: 28px auto;">
      <tr>
        <td align="center" bgcolor="#0284c7" style="border-radius: 8px; background-color: #0284c7;">
          <a href="${inviteLink}" target="_blank" style="display: inline-block; padding: 13px 28px; font-family: Arial, sans-serif; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; border-radius: 8px;">
            <span style="color: #ffffff;">Aceitar Convite e Definir Password</span>
          </a>
        </td>
      </tr>
    </table>

    <p style="font-size: 12px; color: #94a3b8; line-height: 1.5; word-break: break-all;">
      Se o botão não funcionar, copie este endereço para o seu navegador:<br/>
      <a href="${inviteLink}" style="color: #0284c7;">${inviteLink}</a>
    </p>

    <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 28px 0 16px 0;" />
    <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
      BI Pharma · Nuelltech · Mensagem enviada a partir de info@bipharma.nuelltech.com
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendRawEmail({ to: input.to, subject, html, text: `Convite BI Pharma: ${inviteLink}` });
}

/**
 * 2. Email de Redefinição de Password (Esqueceu-se da Password)
 */
export async function sendPasswordResetEmail(input: {
  to: string;
  nome: string;
  token: string;
}): Promise<SendEmailResult> {
  const appUrl = getBaseAppUrl();
  const resetLink = `${appUrl}/reset-password?token=${encodeURIComponent(input.token)}`;

  const subject = 'Redefinição de Password — BI Pharma';
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div style="margin-bottom: 24px;">
      <h2 style="color: #0284c7; margin: 0 0 6px 0; font-size: 20px; font-weight: 800;">BI PHARMA</h2>
      <p style="color: #64748b; margin: 0; font-size: 13px;">Segurança de Acesso</p>
    </div>

    <p style="font-size: 15px; line-height: 1.6;">Olá <strong>${escapeHtml(input.nome)}</strong>,</p>
    <p style="font-size: 15px; line-height: 1.6;">
      Recebemos um pedido para redefinir a password da sua conta no <strong>BI Pharma</strong>.
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin: 28px auto;">
      <tr>
        <td align="center" bgcolor="#0284c7" style="border-radius: 8px; background-color: #0284c7;">
          <a href="${resetLink}" target="_blank" style="display: inline-block; padding: 13px 28px; font-family: Arial, sans-serif; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; border-radius: 8px;">
            <span style="color: #ffffff;">Redefinir a Minha Password</span>
          </a>
        </td>
      </tr>
    </table>
    <p style="font-size: 12px; color: #64748b; word-break: break-all; margin: 0 0 18px 0;">
      Se o botão não abrir, copie e cole este endereço no browser:<br />
      <a href="${resetLink}" style="color: #0284c7;">${resetLink}</a>
    </p>

    <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
      Este link expira dentro de <strong>15 minutos</strong> e apenas pode ser utilizado uma única vez.
      Se não solicitou esta redefinição, ignore este email e a sua conta permanecerá segura.
    </p>

    <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 28px 0 16px 0;" />
    <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
      BI Pharma · Nuelltech · Mensagem enviada a partir de info@bipharma.nuelltech.com
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendRawEmail({ to: input.to, subject, html, text: `Redefinir password BI Pharma: ${resetLink}` });
}

/**
 * 3. Alerta de Deteção de Novo Dispositivo / IP
 */
export async function sendNewDeviceAlertEmail(input: {
  to: string;
  nome: string;
  ip: string;
  userAgent: string;
}): Promise<SendEmailResult> {
  const subject = 'Novo início de sessão detetado na sua conta — BI Pharma';
  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; background-color: #f8fafc; padding: 20px; color: #0f172a;">
  <div style="max-width: 520px; margin: 0 auto; background: #fff; padding: 24px; border-radius: 10px; border: 1px solid #e2e8f0;">
    <h3 style="color: #0284c7; margin-top: 0;">BI PHARMA — Alerta de Segurança</h3>
    <p>Olá <strong>${escapeHtml(input.nome)}</strong>,</p>
    <p>Foi detetado um início de sessão com a sua conta a partir de um novo dispositivo ou endereço IP:</p>
    <ul style="font-size: 14px; line-height: 1.8; color: #334155;">
      <li><strong>IP:</strong> ${escapeHtml(input.ip)}</li>
      <li><strong>Navegador/Dispositivo:</strong> ${escapeHtml(input.userAgent)}</li>
      <li><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-PT')}</li>
    </ul>
    <p style="font-size: 13px; color: #64748b;">Se foi você, não é necessária qualquer ação. Se não reconhece esta atividade, altere de imediato a sua password.</p>
  </div>
</body>
</html>
  `.trim();

  return sendRawEmail({ to: input.to, subject, html, text: `Alerta: novo login em ${input.ip}` });
}

/**
 * 4. Email de Confirmação de Palavra-passe Alterada
 */
export async function sendPasswordChangedAlertEmail(input: {
  to: string;
  nome: string;
  ip?: string;
}): Promise<SendEmailResult> {
  const subject = 'A sua palavra-passe foi alterada — BI Pharma';
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div style="margin-bottom: 24px;">
      <h2 style="color: #0284c7; margin: 0 0 6px 0; font-size: 20px; font-weight: 800;">BI PHARMA</h2>
      <p style="color: #64748b; margin: 0; font-size: 13px;">Alerta de Segurança</p>
    </div>

    <p style="font-size: 15px; line-height: 1.6;">Olá <strong>${escapeHtml(input.nome)}</strong>,</p>
    <p style="font-size: 15px; line-height: 1.6;">
      Informamos que a palavra-passe da sua conta no <strong>BI Pharma</strong> foi alterada com sucesso.
    </p>

    <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 13px; color: #334155;">
      <div><strong>Data / Hora:</strong> ${new Date().toLocaleString('pt-PT')}</div>
      ${input.ip ? `<div><strong>Endereço IP:</strong> <code>${escapeHtml(input.ip)}</code></div>` : ''}
    </div>

    <p style="font-size: 13px; color: #dc2626; line-height: 1.5; font-weight: 600;">
      Se não efetuou esta alteração, a sua conta pode estar comprometida. Contacte de imediato o administrador da sua farmácia.
    </p>

    <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 28px 0 16px 0;" />
    <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
      BI Pharma · Nuelltech · Mensagem enviada a partir de info@bipharma.nuelltech.com
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendRawEmail({
    to: input.to,
    subject,
    html,
    text: `A sua palavra-passe no BI Pharma foi alterada em ${new Date().toLocaleString('pt-PT')}.`,
  });
}

/**
 * 5. Email de Notificação de Alteração de Perfil / Permissões
 */
export async function sendProfileChangedEmail(input: {
  to: string;
  nome: string;
  farmaciaNome: string;
  novoPerfil: string;
}): Promise<SendEmailResult> {
  const subject = `Atualização de Perfil de Acesso — ${input.farmaciaNome}`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div style="margin-bottom: 24px;">
      <h2 style="color: #0284c7; margin: 0 0 6px 0; font-size: 20px; font-weight: 800;">BI PHARMA</h2>
      <p style="color: #64748b; margin: 0; font-size: 13px;">Gestão de Acessos</p>
    </div>

    <p style="font-size: 15px; line-height: 1.6;">Olá <strong>${escapeHtml(input.nome)}</strong>,</p>
    <p style="font-size: 15px; line-height: 1.6;">
      O seu perfil de acesso na <strong>${escapeHtml(input.farmaciaNome)}</strong> foi atualizado para: <strong>${escapeHtml(input.novoPerfil)}</strong>.
    </p>

    <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 28px 0 16px 0;" />
    <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
      BI Pharma · Nuelltech · Mensagem enviada a partir de info@bipharma.nuelltech.com
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendRawEmail({
    to: input.to,
    subject,
    html,
    text: `O seu perfil na ${input.farmaciaNome} foi atualizado para ${input.novoPerfil}.`,
  });
}

/**
 * 6. Email com Código de Desafio para Novo Dispositivo (Fase 4 - Endurecimento)
 */
export async function sendNewDeviceChallengeEmail(input: {
  to: string;
  nome: string;
  code: string;
  ip?: string;
  userAgent?: string;
}): Promise<SendEmailResult> {
  const subject = `Código de verificação para novo dispositivo: ${input.code} — BI Pharma`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <div style="margin-bottom: 24px;">
      <h2 style="color: #0284c7; margin: 0 0 6px 0; font-size: 20px; font-weight: 800;">BI PHARMA</h2>
      <p style="color: #64748b; margin: 0; font-size: 13px;">Verificação de Segurança de Dispositivo</p>
    </div>

    <p style="font-size: 15px; line-height: 1.6;">Olá <strong>${escapeHtml(input.nome)}</strong>,</p>
    <p style="font-size: 15px; line-height: 1.6;">
      Foi detetada uma tentativa de início de sessão a partir de um novo navegador ou dispositivo. Para autorizar este acesso, introduza o código de verificação abaixo:
    </p>

    <div style="text-align: center; margin: 28px 0;">
      <div style="display: inline-block; background: #0f172a; color: #38bdf8; font-size: 32px; font-weight: 800; letter-spacing: 6px; padding: 16px 32px; border-radius: 10px; font-family: monospace;">
        ${escapeHtml(input.code)}
      </div>
      <p style="font-size: 12px; color: #64748b; margin-top: 8px;">Este código expira em 10 minutos e é de uso único.</p>
    </div>

    <div style="background-color: #f1f5f9; border-radius: 8px; padding: 14px 18px; margin: 20px 0; font-size: 13px; color: #334155;">
      <div><strong>Data / Hora:</strong> ${new Date().toLocaleString('pt-PT')}</div>
      ${input.ip ? `<div><strong>Endereço IP:</strong> <code>${escapeHtml(input.ip)}</code></div>` : ''}
      ${input.userAgent ? `<div><strong>Navegador / Sistema:</strong> ${escapeHtml(input.userAgent)}</div>` : ''}
    </div>

    <p style="font-size: 13px; color: #dc2626; line-height: 1.5; font-weight: 600;">
      Se não tentou iniciar sessão, ignore este email e altere de imediato a sua palavra-passe.
    </p>

    <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 28px 0 16px 0;" />
    <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
      BI Pharma · Nuelltech · Mensagem enviada a partir de info@bipharma.nuelltech.com
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendRawEmail({
    to: input.to,
    subject,
    html,
    text: `Código de verificação de novo dispositivo no BI Pharma: ${input.code} (expira em 10 minutos). IP: ${input.ip || 'N/D'}`,
  });
}

// ============================================================================
// AUXILIARES INTERNOS DE ENVIO
// ============================================================================

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendRawEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendEmailResult> {
  const from = DEFAULT_EMAIL_FROM;

  // Sem chave Resend (ex.: desenvolvimento local ou CI), simula o envio sem falhar
  if (!resend) {
    console.log(`[EMAIL DEV MOCK] De: ${from} | Para: ${opts.to} | Assunto: ${opts.subject}`);
    return { ok: true, messageId: `mock_${Date.now()}` };
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });

    if (error) {
      console.error('[EMAIL RESEND ERROR]', error);
      return { ok: false, error: error.message };
    }

    return { ok: true, messageId: data?.id };
  } catch (err: any) {
    console.error('[EMAIL SEND EXCEPTION]', err);
    return { ok: false, error: err.message || 'Erro inesperado no envio de email.' };
  }
}
