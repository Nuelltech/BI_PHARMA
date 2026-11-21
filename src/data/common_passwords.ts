import crypto from 'crypto';

/**
 * Lista local de passwords comuns e previsíveis (PT / EN / Farmácia) — Fase 1 & 4 (Spec v2.1).
 */
export const COMMON_PASSWORDS = new Set<string>([
  '1234567890', '0123456789', '12345678901', '123456789012',
  'password123', 'password1234', 'password2024', 'password2025', 'password2026',
  'qwertyuiop', 'qwerty1234', 'qwerty12345', 'asdfghjkl', 'zxcvbnm123',
  'admin12345', 'administrator', 'administrador', 'superadmin', 'superadmin123',
  'farmacia123', 'farmacia1234', 'farmacia2024', 'farmacia2025', 'farmacia2026',
  'bipharma123', 'bipharma2025', 'bipharma2026', 'nuelltech123', 'nuelltech2026',
  'sifarma123', 'sifarma2025', 'sifarma2026', 'portugal123', 'portugal2025', 'portugal2026',
  'benfica123', 'sporting123', 'fcporto123', 'lisboa1234', 'porto12345',
  'letmein123', 'welcome123', 'welcome2025', 'welcome2026', 'changeme123',
  'iloveyou123', 'trustno123', 'monkey1234', 'dragon1234', 'football123',
  'baseball123', 'sunshine123', 'princess123', 'starwars123', 'passw0rd123',
  'p@ssw0rd123', 'p@ssword123', 'abc1234567', 'abcdef1234', '0000000000',
  '1111111111', '9999999999', 'aaaaaaaaaa', 'zzzzzzzzzz', '1q2w3e4r5t',
  '1qaz2wsx3edc', 'qazwsxedcrfv', 'senha12345', 'palavrapasse', 'palavra123',
  'segredo123', 'acesso1234', 'entrada123', 'balcao1234', 'diretor123',
  'gestor1234', 'compras123', 'saude12345', 'medicina123', 'farmaceutico',
]);

/**
 * Validação síncrona local (tamanho, regras heurísticas, lista comum e exclusão de dados pessoais)
 */
export function validatePasswordPolicy(
  rawPassword: string,
  userHints?: { email?: string | null; nome?: string | null }
): { valid: boolean; error?: string } {
  const pwd = String(rawPassword || '');
  if (pwd.length < 10) {
    return { valid: false, error: 'A palavra-passe deve ter pelo menos 10 caracteres.' };
  }
  if (pwd.length > 128) {
    return { valid: false, error: 'A palavra-passe não pode exceder 128 caracteres.' };
  }

  const normalized = pwd.toLowerCase().trim();
  if (COMMON_PASSWORDS.has(normalized)) {
    return { valid: false, error: 'Esta palavra-passe é demasiado comum. Escolha uma frase ou combinação única.' };
  }

  // Rejeitar todos os caracteres iguais
  if (/^(.)\1+$/.test(pwd)) {
    return { valid: false, error: 'A palavra-passe não pode repetir o mesmo caractere.' };
  }

  // Rejeitar se contém a parte local do email
  if (userHints?.email) {
    const localPart = userHints.email.split('@')[0]?.toLowerCase() || '';
    if (localPart.length >= 4 && normalized.includes(localPart)) {
      return { valid: false, error: 'A palavra-passe não deve conter o seu endereço de email.' };
    }
  }

  // Rejeitar se contém partes do nome do utilizador
  if (userHints?.nome) {
    const nameParts = userHints.nome.toLowerCase().split(/\s+/).filter((p) => p.length >= 4);
    for (const part of nameParts) {
      if (normalized.includes(part)) {
        return { valid: false, error: 'A palavra-passe não deve conter o seu nome.' };
      }
    }
  }

  return { valid: true };
}

/**
 * Verificação Have I Been Pwned (HIBP) com modelo de k-Anonymity (Fase 4 - Endurecimento)
 * Envia estritamente os primeiros 5 caracteres do hash SHA-1.
 * A password em texto claro nunca sai do servidor.
 */
export async function checkPwnedPassword(
  rawPassword: string,
  timeoutMs = 1500
): Promise<{ pwned: boolean; count: number; fallbackUsado?: boolean }> {
  try {
    const sha1 = crypto.createHash('sha1').update(rawPassword).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'BI-Pharma-Security/2.1',
        'Add-Padding': 'true', // Proteção oficial anti-timing/tamanho de resposta
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[HIBP] Resposta HTTP ${res.status} de Have I Been Pwned. Fallback ativo para lista local.`);
      return { pwned: false, count: 0, fallbackUsado: true };
    }

    const text = await res.text();
    const lines = text.split('\r\n');
    for (const line of lines) {
      const [hashSuffix, countStr] = line.split(':');
      if (hashSuffix && hashSuffix.trim().toUpperCase() === suffix) {
        const count = parseInt(countStr || '0', 10);
        // Entradas geradas pelo Add-Padding têm count 0 e são descartadas
        if (count > 0) {
          return { pwned: true, count };
        }
      }
    }

    return { pwned: false, count: 0 };
  } catch (err: any) {
    console.warn('[HIBP] Timeout ou falha de rede ao contactar Have I Been Pwned. Fallback ativo para lista local.');
    return { pwned: false, count: 0, fallbackUsado: true };
  }
}

/**
 * Validação assíncrona completa: política de 10 caracteres + sem complexidade obrigatória +
 * sem dados pessoais + rejeição de comuns + verificação HIBP de passwords vazadas.
 */
export async function validatePasswordPolicyAsync(
  rawPassword: string,
  userHints?: { email?: string | null; nome?: string | null }
): Promise<{ valid: boolean; error?: string }> {
  const syncCheck = validatePasswordPolicy(rawPassword, userHints);
  if (!syncCheck.valid) {
    return syncCheck;
  }

  const pwned = await checkPwnedPassword(rawPassword);
  if (pwned.pwned) {
    return {
      valid: false,
      error: `Esta palavra-passe consta de fugas de dados públicas conhecidas (${pwned.count.toLocaleString()} ocorrências no HIBP). Por segurança, escolha outra.`,
    };
  }

  return { valid: true };
}
