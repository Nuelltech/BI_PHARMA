import crypto from 'crypto';
import type http from 'http';
import type { PrismaClient } from '@prisma/client';

// ============================================================================
// FASE 0 — SEGURANÇA IMEDIATA (Especificação Unificada v2.1)
// ============================================================================

const DEV_FALLBACK_PEPPER = 'dev_only_local_pin_pepper_do_not_use_in_production_2026';

export const CURRENT_PEPPER_VERSION = 'v1';

/**
 * Obtém a chave dedicada de cifra AES-256-GCM para segredos TOTP (Spec v2.1).
 * Não partilha nem reutiliza o PIN pepper.
 */
export function getTotpEncKey(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const key = (process.env.TOTP_ENC_KEY_V1 || process.env.TOTP_ENC_KEY || '').trim();

  if (key.length >= 32) {
    return key;
  }

  if (isProd) {
    throw new Error(
      '[SEGURANÇA CRÍTICA] TOTP_ENC_KEY_V1 ou TOTP_ENC_KEY não configurado ou demasiado curto (>= 32 chars) em produção.'
    );
  }

  return 'dev_totp_encryption_key_32bytes_min_length_ok!';
}

/**
 * Obtém o pepper versionado das variáveis de ambiente.
 * Em produção, a ausência de PIN_PEPPER_V1 (ou PIN_PEPPER) é erro fatal.
 */
export function getPinPepper(version: string = CURRENT_PEPPER_VERSION): string {
  const isProd = process.env.NODE_ENV === 'production';
  const envKey = `PIN_PEPPER_${version.toUpperCase()}`;
  const pepper = (process.env[envKey] || (version === 'v1' ? process.env.PIN_PEPPER : '') || '').trim();

  if (pepper.length >= 16) {
    return pepper;
  }

  if (isProd) {
    throw new Error(
      `[SEGURANÇA CRÍTICA] ${envKey} não configurado ou demasiado curto (>= 16 chars) em produção.`
    );
  }

  return DEV_FALLBACK_PEPPER;
}

/**
 * Verificação obrigatória no arranque (Spec v2.1 Secção 6 & 11).
 * Em produção, recusa arrancar se:
 *  - Não estiver configurado para cookies __Host- com Secure (HTTPS)
 *  - Não existir PIN_PEPPER_V1 (ou PIN_PEPPER) seguro
 *  - Não existir TOTP_ENC_KEY_V1 seguro
 */
export function assertProductionSecurityConfig(
  isProd: boolean = process.env.NODE_ENV === 'production',
  opts?: { allowInsecureHttpInProd?: boolean }
): void {
  if (!isProd) return;

  if (opts?.allowInsecureHttpInProd) {
    throw new Error(
      '[SEGURANÇA CRÍTICA] Produção exige HTTPS obrigatório com cookies __Host-. Servidor impedido de arrancar.'
    );
  }

  // Valida que o pepper e a chave TOTP existem e têm entropia mínima em produção
  getPinPepper(CURRENT_PEPPER_VERSION);
  getTotpEncKey();
}

// ============================================================================
// 1. PINS DE BALCÃO: RECUSA DE TRIVIAIS + HMAC-SHA256 COM PEPPER VERSIONADO
// ============================================================================

const TRIVIAL_PIN_BLACKLIST = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '3210', '2345', '5432', '3456', '6543', '4567', '7654',
  '5678', '8765', '6789', '9876',
  '1212', '2121', '1122', '2211', '1010', '2020', '2024', '2025', '2026', '2027',
  '0007', '0101', '2512', '1004', '5566', '6655', '7788', '8899', '1357', '2468',
  '000000', '111111', '123456', '654321', '123123', '112233', '010203', '987654',
]);

/**
 * Recusa PINs triviais: fora de 4-6 dígitos, repetidos (0000),
 * sequências crescentes/decrescentes (1234, 4321, 9876), pares repetidos (5566, 1212)
 * e anos óbvios (1950-2035).
 */
export function isTrivialPin(rawPin: string): boolean {
  const pin = String(rawPin || '').trim();
  if (!/^\d{4,6}$/.test(pin)) return true;

  if (TRIVIAL_PIN_BLACKLIST.has(pin)) return true;

  // Todos os dígitos iguais (ex: 77777, 888888)
  if (/^(\d)\1+$/.test(pin)) return true;

  // Apenas 2 dígitos alternados ou em pares repetidos (ex: 3434, 4455, 121212)
  if (pin.length === 4 && (pin[0] === pin[2] && pin[1] === pin[3])) return true;
  if (pin.length === 4 && (pin[0] === pin[1] && pin[2] === pin[3])) return true;
  if (pin.length === 6 && pin.slice(0, 3) === pin.slice(3, 6)) return true;
  if (pin.length === 6 && pin[0] === pin[1] && pin[2] === pin[3] && pin[4] === pin[5]) return true;

  // Sequência estritamente crescente ou decrescente passo 1 (ex: 23456, 76543)
  let isAsc = true;
  let isDesc = true;
  for (let i = 1; i < pin.length; i++) {
    const diff = Number(pin[i]) - Number(pin[i - 1]);
    if (diff !== 1) isAsc = false;
    if (diff !== -1) isDesc = false;
  }
  if (isAsc || isDesc) return true;

  // Anos óbvios (1950 a 2035)
  if (pin.length === 4) {
    const n = Number(pin);
    if (n >= 1950 && n <= 2035) return true;
  }

  return false;
}

export function validateNewPin(rawPin: string): { valid: boolean; error?: string } {
  const pin = String(rawPin || '').trim();
  if (!/^\d{4,6}$/.test(pin)) {
    return { valid: false, error: 'O PIN deve ter entre 4 e 6 dígitos numéricos.' };
  }
  if (isTrivialPin(pin)) {
    return {
      valid: false,
      error: 'PIN demasiado previsível (evite repetições, sequências como 1234/9876 ou anos).',
    };
  }
  return { valid: true };
}

/**
 * Gera um hash HMAC-SHA256 do PIN com pepper versionado (env) + salt por vínculo.
 * Formato: `<versao>:<saltHex>:<hmacHex>`
 */
export function hashPinWithPepper(rawPin: string, memberId: string): string {
  const pin = String(rawPin || '').trim();
  const salt = crypto.randomBytes(16).toString('hex');
  const pepper = getPinPepper(CURRENT_PEPPER_VERSION);
  const digest = crypto
    .createHmac('sha256', pepper)
    .update(`${CURRENT_PEPPER_VERSION}:${memberId}:${salt}:${pin}`)
    .digest('hex');

  return `${CURRENT_PEPPER_VERSION}:${salt}:${digest}`;
}

/**
 * Verifica um PIN contra o hash guardado usando timingSafeEqual.
 */
export function verifyPinHash(rawPin: string, memberId: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !rawPin) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3) return false;

  const [version, salt, expectedHex] = parts;
  if (!version || !salt || !expectedHex) return false;

  try {
    const pepper = getPinPepper(version);
    const actualHex = crypto
      .createHmac('sha256', pepper)
      .update(`${version}:${memberId}:${salt}:${String(rawPin).trim()}`)
      .digest('hex');

    const a = Buffer.from(actualHex, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Gera um PIN temporário de 6 dígitos garantidamente não trivial.
 */
export function generateTemporaryPin(): string {
  for (let i = 0; i < 50; i++) {
    const num = crypto.randomInt(100000, 1000000).toString();
    if (!isTrivialPin(num)) return num;
  }
  return '482917';
}

// ============================================================================
// 2. HASH SHA-256 PARA TOKENS OPACOS (RECUPERAÇÃO, SESSÕES, ETC.)
// ============================================================================

export function hashOpaqueToken(rawToken: string): string {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

// ============================================================================
// 3. RATE LIMITING PERSISTENTE EM POSTGRES (tabela limites_taxa)
// ============================================================================

export interface RateLimitCheckResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

export async function checkDbRateLimit(
  prisma: PrismaClient,
  chave: string,
  maxAttempts: number,
  windowMs: number,
  failClosed = true
): Promise<RateLimitCheckResult> {
  const now = new Date();
  try {
    const record = await prisma.limiteTaxa.findUnique({ where: { chave } });
    if (!record) {
      return { allowed: true, count: 0, retryAfterSec: 0 };
    }

    if (record.bloqueadoAte && record.bloqueadoAte.getTime() > now.getTime()) {
      const retryAfterSec = Math.ceil((record.bloqueadoAte.getTime() - now.getTime()) / 1000);
      return { allowed: false, count: record.contador, retryAfterSec };
    }

    const windowEnd = record.janelaInicio.getTime() + windowMs;
    if (now.getTime() > windowEnd) {
      return { allowed: true, count: 0, retryAfterSec: 0 };
    }

    if (record.contador >= maxAttempts) {
      const retryAfterSec = Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1000));
      return { allowed: false, count: record.contador, retryAfterSec };
    }

    return { allowed: true, count: record.contador, retryAfterSec: 0 };
  } catch (err) {
    console.error('[SEGURANÇA] Falha ao verificar limites_taxa na BD:', (err as Error).message);
    if (failClosed) {
      return { allowed: false, count: maxAttempts, retryAfterSec: 60 };
    }
    return { allowed: true, count: 0, retryAfterSec: 0 };
  }
}

export async function recordDbRateLimitHit(
  prisma: PrismaClient,
  chave: string,
  windowMs: number,
  options?: { maxBeforeBlock?: number; baseBlockMs?: number }
): Promise<{ count: number; blockedUntil: Date | null }> {
  const now = new Date();
  const windowCutoff = new Date(now.getTime() - windowMs);
  const maxBeforeBlock = options?.maxBeforeBlock || 0;
  const baseBlockMs = options?.baseBlockMs || 5 * 60 * 1000;

  try {
    // Caminho atómico em PostgreSQL: INSERT ... ON CONFLICT DO UPDATE (sem race condition entre pedidos paralelos)
    if (typeof (prisma as any).$queryRaw === 'function') {
      const rows = (await (prisma as any).$queryRaw`
        INSERT INTO limites_taxa (chave, janela_inicio, contador, bloqueado_ate, atualizado_em)
        VALUES (${chave}, ${now}, 1, NULL, ${now})
        ON CONFLICT (chave) DO UPDATE SET
          janela_inicio = CASE
            WHEN limites_taxa.janela_inicio < ${windowCutoff} THEN ${now}
            ELSE limites_taxa.janela_inicio
          END,
          contador = CASE
            WHEN limites_taxa.janela_inicio < ${windowCutoff} THEN 1
            ELSE limites_taxa.contador + 1
          END,
          atualizado_em = ${now}
        RETURNING contador, bloqueado_ate
      `) as Array<{ contador: number; bloqueado_ate: Date | null }>;

      const newCount = Number(rows?.[0]?.contador || 1);
      let blockedUntil: Date | null = rows?.[0]?.bloqueado_ate || null;

      if (maxBeforeBlock > 0 && newCount >= maxBeforeBlock) {
        const multiplier = Math.min(8, Math.pow(2, newCount - maxBeforeBlock));
        blockedUntil = new Date(now.getTime() + baseBlockMs * multiplier);
        await prisma.limiteTaxa.update({
          where: { chave },
          data: { bloqueadoAte: blockedUntil },
        });
      }

      return { count: newCount, blockedUntil };
    }

    // Fallback para mocks unitários em memória sem $queryRaw
    const existing = await prisma.limiteTaxa.findUnique({ where: { chave } });
    const expired = !existing || now.getTime() > existing.janelaInicio.getTime() + windowMs;
    const newCount = expired ? 1 : existing.contador + 1;
    let blockedUntil: Date | null = null;

    if (maxBeforeBlock > 0 && newCount >= maxBeforeBlock) {
      const multiplier = Math.min(8, Math.pow(2, newCount - maxBeforeBlock));
      blockedUntil = new Date(now.getTime() + baseBlockMs * multiplier);
    }

    if (expired) {
      await prisma.limiteTaxa.upsert({
        where: { chave },
        create: { chave, janelaInicio: now, contador: 1, bloqueadoAte: blockedUntil },
        update: { janelaInicio: now, contador: 1, bloqueadoAte: blockedUntil },
      });
    } else {
      await prisma.limiteTaxa.update({
        where: { chave },
        data: { contador: newCount, bloqueadoAte: blockedUntil ?? existing.bloqueadoAte },
      });
    }

    return { count: newCount, blockedUntil };
  } catch (err) {
    console.error('[SEGURANÇA] Falha ao registar hit em limites_taxa:', (err as Error).message);
    return { count: maxBeforeBlock || 1, blockedUntil: new Date(now.getTime() + 60_000) };
  }
}

export async function resetDbRateLimit(prisma: PrismaClient, chave: string): Promise<void> {
  await prisma.limiteTaxa.delete({ where: { chave } }).catch(() => {});
}

export async function cleanupExpiredRateLimits(
  prisma: PrismaClient,
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const res = await prisma.limiteTaxa.deleteMany({
      where: {
        janelaInicio: { lt: cutoff },
        OR: [{ bloqueadoAte: null }, { bloqueadoAte: { lt: new Date() } }],
      },
    });
    return res.count;
  } catch {
    return 0;
  }
}

// ============================================================================
// 4. COOKIES SEGUROS (__Host-, HttpOnly, Secure, SameSite=Lax) & HEADERS
// ============================================================================

export function getCookieName(baseName: string, isProd: boolean): string {
  return isProd ? `__Host-${baseName}` : baseName;
}

export function isRequestHttps(req: http.IncomingMessage, isProd: boolean): boolean {
  if (isProd) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function buildSecureCookieHeader(
  baseName: string,
  value: string,
  opts: { isProd: boolean; isHttps?: boolean; maxAgeSec?: number; clear?: boolean }
): string {
  const cookieName = getCookieName(baseName, opts.isProd);
  const secureFlag = opts.isProd || opts.isHttps ? '; Secure' : '';
  const maxAge = opts.clear
    ? '; Max-Age=0'
    : typeof opts.maxAgeSec === 'number'
      ? `; Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`
      : '';
  const encodedVal = opts.clear ? '' : encodeURIComponent(value);

  // Sem atributo Domain (obrigatório para __Host-), sempre Path=/, HttpOnly, SameSite=Lax
  return `${cookieName}=${encodedVal}; Path=/; HttpOnly; SameSite=Lax${secureFlag}${maxAge}`;
}

export function readCookieValue(cookieHeader: string | undefined, baseNames: string[]): string {
  if (!cookieHeader) return '';
  const parts = cookieHeader.split(';');
  const candidates = new Set<string>();
  for (const name of baseNames) {
    candidates.add(`__Host-${name}`.toLowerCase());
    candidates.add(name.toLowerCase());
  }

  for (const rawPart of parts) {
    const eqIdx = rawPart.indexOf('=');
    if (eqIdx === -1) continue;
    const k = rawPart.slice(0, eqIdx).trim().toLowerCase();
    if (candidates.has(k)) {
      const v = rawPart.slice(eqIdx + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return '';
}

export function buildCspReportOnlyPolicy(nonce?: string, isProd?: boolean): string {
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}'` : (isProd ? "'self'" : "'self' 'unsafe-inline'");
  return `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; report-uri /api/security/csp-report`;
}

export function buildCspBlockingPolicy(nonce?: string, isProd?: boolean): string {
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}'` : (isProd ? "'self'" : "'self' 'unsafe-inline'");
  return `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; report-uri /api/security/csp-report`;
}

export const CSP_REPORT_ONLY_POLICY = buildCspReportOnlyPolicy();
export const CSP_BLOCKING_POLICY = buildCspBlockingPolicy();

/**
 * Remove query string e fragmento de URLs (ex.: para relatórios CSP nunca guardarem ?token=...).
 */
export function stripQueryString(rawUrl: unknown): string {
  const str = String(rawUrl || '').trim();
  if (!str) return '';
  const qIdx = str.indexOf('?');
  const hIdx = str.indexOf('#');
  const cut =
    qIdx !== -1 && hIdx !== -1
      ? Math.min(qIdx, hIdx)
      : qIdx !== -1
        ? qIdx
        : hIdx;
  return cut !== -1 ? str.slice(0, cut) : str;
}

export function applySecurityHeaders(
  res: http.ServerResponse,
  opts: {
    isProd: boolean;
    isHttps?: boolean;
    isAuthenticated?: boolean;
    isSse?: boolean;
    isResetPage?: boolean;
    nonce?: string;
  }
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', opts.isResetPage ? 'no-referrer' : 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP Bloqueante com nonces estritos e img-src restrito a 'self' data: (sem https: arbitrário)
  const blockingPolicy = buildCspBlockingPolicy(opts.nonce, opts.isProd);
  const reportOnlyPolicy = buildCspReportOnlyPolicy(opts.nonce, opts.isProd);
  res.setHeader('Content-Security-Policy', blockingPolicy);
  res.setHeader('Content-Security-Policy-Report-Only', reportOnlyPolicy);

  if (opts.isProd || opts.isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  if (opts.isSse) {
    res.setHeader('Cache-Control', 'no-cache, no-transform');
  } else if (opts.isAuthenticated) {
    res.setHeader('Cache-Control', 'no-store');
  }
}
