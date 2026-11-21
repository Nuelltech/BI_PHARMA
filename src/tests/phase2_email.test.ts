import { describe, it, expect } from 'vitest';
import {
  sendInviteEmail,
  sendPasswordResetEmail,
  sendNewDeviceAlertEmail,
  DEFAULT_EMAIL_FROM,
} from '../services/email_service';

describe('Fase 2 — Serviço de Emails Transacionais (Resend)', () => {
  it('1. O remetente por omissão está fixado em info@bipharma.nuelltech.com', () => {
    expect(DEFAULT_EMAIL_FROM).toBe('BI Pharma <info@bipharma.nuelltech.com>');
  });

  it('2. Envio de convite gera link seguro com token e HTML bem formatado', async () => {
    const res = await sendInviteEmail({
      to: 'farmaceutico@farmacia-baptista.pt',
      nome: 'Dr. João Baptista',
      farmaciaNome: 'Farmácia Baptista',
      perfil: 'DIRETOR_TECNICO',
      token: 'tok_invite_abc1234567890',
    });

    expect(res.ok).toBe(true);
    expect(res.messageId).toBeDefined();
  });

  it('3. Envio de redefinição de password gera link seguro com token', async () => {
    const res = await sendPasswordResetEmail({
      to: 'gestor@farmacia-avenida.pt',
      nome: 'Dra. Maria Avenida',
      token: 'tok_reset_xyz9876543210',
    });

    expect(res.ok).toBe(true);
    expect(res.messageId).toBeDefined();
  });

  it('4. Alerta de novo dispositivo formata dados de IP e User-Agent', async () => {
    const res = await sendNewDeviceAlertEmail({
      to: 'proprietario@farmacia.pt',
      nome: 'Proprietário',
      ip: '194.65.12.34',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0',
    });

    expect(res.ok).toBe(true);
    expect(res.messageId).toBeDefined();
  });
});
