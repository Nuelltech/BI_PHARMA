import crypto from 'crypto';
import { getPinPepper, getTotpEncKey } from './security_phase0';

// ============================================================================
// 1. HASHING DE PASSWORDS COM SCRYPT ASSÍNCRONO (Spec v2.1 Secção 5)
// Nunca usa scryptSync (não bloqueia o event loop). Parâmetros guardados na string.
// ============================================================================

const SCRYPT_N = 32768; // 2^15 (mínimo exigido pela Spec v2.1)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MB

function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPasswordScrypt(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$N=${SCRYPT_N}$r=${SCRYPT_R}$p=${SCRYPT_P}$${salt}$${derived.toString('hex')}`;
}

export async function verifyPasswordScrypt(
  password: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!storedHash || !password) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1].replace('N=', ''));
  const r = Number(parts[2].replace('r=', ''));
  const p = Number(parts[3].replace('p=', ''));
  const salt = parts[4];
  const expectedHex = parts[5];

  if (!N || !r || !p || !salt || !expectedHex) return false;

  try {
    const derived = await scryptAsync(password, salt, expectedHex.length / 2, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Executa um hash fictício com os mesmos parâmetros para equalizar o tempo de resposta
 * quando o email não existe (evita enumeração de contas por timing attack).
 */
export async function verifyDummyPasswordScrypt(password: string): Promise<void> {
  await scryptAsync(password || 'dummy', '00112233445566778899aabbccddeeff', SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }).catch(() => {});
}

// ============================================================================
// 2. TOTP RFC 6238 (OBRIGATÓRIO PARA SUPERADMIN DESDE A FASE 1)
// Compatível com Google Authenticator, 1Password, Authy e Bitwarden.
// ============================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20)); // 160 bits RFC 4226/6238
}

export function buildTotpOtpAuthUrl(email: string, secretBase32: string, issuer = 'BI Pharma'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const iss = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}

export function generateTotpCode(secretBase32: string, timestampMs = Date.now(), stepSec = 30): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / stepSec);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(codeInt % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(
  secretBase32: string,
  rawCode: string,
  timestampMs = Date.now(),
  windowSteps = 1
): boolean {
  const res = verifyTotpCodeWithStep(secretBase32, rawCode, null, timestampMs, windowSteps);
  return res.valid;
}

/**
 * Validação com proteção contra repetição (anti-replay):
 * Rejeita o mesmo código no mesmo passo ou anterior ao último validado.
 */
export function verifyTotpCodeWithStep(
  secretBase32: string,
  rawCode: string,
  lastVerifiedStep?: bigint | number | null,
  timestampMs = Date.now(),
  windowSteps = 1
): { valid: boolean; matchedStep?: bigint } {
  const code = String(rawCode || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { valid: false };

  const currentStep = Math.floor(timestampMs / 1000 / 30);
  const minStep = lastVerifiedStep != null ? BigInt(lastVerifiedStep) : null;

  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const stepNumber = BigInt(currentStep + delta);
    // Anti-replay: se o passo já foi usado, não pode ser aceite de novo
    if (minStep != null && stepNumber <= minStep) {
      continue;
    }

    const candidate = generateTotpCode(secretBase32, (currentStep + delta) * 30_000);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) {
      return { valid: true, matchedStep: stepNumber };
    }
  }
  return { valid: false };
}

// ============================================================================
// 2.1 CÓDIGOS DE RECUPERAÇÃO DE USO ÚNICO (Spec v2.1 & Revisão Superadmin)
// 8-10 códigos de 10 caracteres alfanuméricos guardados apenas como hash SHA-256
// ============================================================================

export function normalizeRecoveryCode(rawCode: string): string {
  return String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(rawCode: string): string {
  const clean = normalizeRecoveryCode(rawCode);
  return crypto.createHash('sha256').update(`bi-pharma:recovery:${clean}`).digest('hex');
}

export function generateRecoveryCodes(count = 10): {
  plaintextCodes: string[];
  hashedCodes: string[];
} {
  const plaintextCodes: string[] = [];
  const hashedCodes: string[] = [];
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // base32 legível sem 0/O/1/I

  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(10);
    let codeStr = '';
    for (let b = 0; b < 10; b++) {
      codeStr += chars[bytes[b] % chars.length];
    }
    // Formato amigável: XXXXX-XXXXX
    const formatted = `${codeStr.slice(0, 5)}-${codeStr.slice(5)}`;
    plaintextCodes.push(formatted);
    hashedCodes.push(hashRecoveryCode(formatted));
  }

  return { plaintextCodes, hashedCodes };
}

export function verifyAndConsumeRecoveryCode(
  rawCode: string,
  storedHashes: string[]
): { valid: boolean; remainingHashes: string[]; matchedHash?: string } {
  if (!rawCode || !Array.isArray(storedHashes) || storedHashes.length === 0) {
    return { valid: false, remainingHashes: storedHashes || [] };
  }

  const candidateHash = hashRecoveryCode(rawCode);
  const candidateBuf = Buffer.from(candidateHash, 'hex');

  let matchIndex = -1;
  for (let i = 0; i < storedHashes.length; i++) {
    const storedBuf = Buffer.from(storedHashes[i], 'hex');
    if (storedBuf.length === candidateBuf.length && crypto.timingSafeEqual(storedBuf, candidateBuf)) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex === -1) {
    return { valid: false, remainingHashes: storedHashes };
  }

  const remaining = storedHashes.filter((_, idx) => idx !== matchIndex);
  return { valid: true, remainingHashes: remaining, matchedHash: storedHashes[matchIndex] };
}

// ============================================================================
// 3. CIFRA AES-256-GCM PARA GUARDAR SEGREDOS TOTP NA BD
// ============================================================================

function deriveTotpEncryptionKey(): Buffer {
  const rawKey = getTotpEncKey();
  return crypto.createHash('sha256').update(`bi-pharma:totp-key:${rawKey}`).digest();
}

export function encryptTotpSecret(plainSecret: string): string {
  const key = deriveTotpEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptTotpSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const key = deriveTotpEncryptionKey();
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const enc = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
