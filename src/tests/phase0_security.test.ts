import { describe, it, expect } from 'vitest';
import {
  isTrivialPin,
  validateNewPin,
  hashPinWithPepper,
  verifyPinHash,
  generateTemporaryPin,
  hashOpaqueToken,
  buildSecureCookieHeader,
  readCookieValue,
  applySecurityHeaders,
  assertProductionSecurityConfig,
  checkDbRateLimit,
  recordDbRateLimitHit,
  resetDbRateLimit,
  stripQueryString,
} from '../services/security_phase0';
import {
  getPharmacyTeam,
  addPharmacyTeamMember,
  updatePharmacyTeamMember,
  verifyMemberPin,
  changeMemberPin,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
} from '../services/rbac_settings';

function createInMemoryPrisma() {
  const db = {
    membros: [] as any[],
    tokens: [] as any[],
    limites: new Map<string, any>(),
  };

  const prisma: any = {
    _db: db,
    membroEquipa: {
      findMany: async ({ where }: any) =>
        db.membros.filter((m) => {
          if (where.farmaciaId && m.farmaciaId !== where.farmaciaId) return false;
          if (where.ativo !== undefined && m.ativo !== where.ativo) return false;
          if (where.pinHash?.not === null && !m.pinHash) return false;
          if (where.id && m.id !== where.id) return false;
          return true;
        }),
      findFirst: async ({ where }: any) =>
        db.membros.find((m) => m.id === where.id && m.farmaciaId === where.farmaciaId) || null,
      createMany: async ({ data }: any) => {
        for (const d of data) {
          db.membros.push({ id: 'm_' + Math.random().toString(36).slice(2), ativo: true, pinFalhas: 0, criadoEm: new Date(), ...d });
        }
        return { count: data.length };
      },
      create: async ({ data }: any) => {
        const item = { criadoEm: new Date(), ...data };
        db.membros.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = db.membros.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error('Not found');
        db.membros[idx] = { ...db.membros[idx], ...data };
        return db.membros[idx];
      },
    },
    tokenRecuperacao: {
      create: async ({ data }: any) => {
        const item = { usadoEm: null, criadoEm: new Date(), ...data };
        db.tokens.push(item);
        return item;
      },
      findUnique: async ({ where }: any) => db.tokens.find((t) => t.token === where.token) || null,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const t of db.tokens) {
          if (t.token === where.token && t.usadoEm === null) {
            Object.assign(t, data);
            count++;
          }
        }
        return { count };
      },
    },
    limiteTaxa: {
      findUnique: async ({ where }: any) => db.limites.get(where.chave) || null,
      upsert: async ({ where, create, update }: any) => {
        const val = db.limites.has(where.chave) ? { ...db.limites.get(where.chave), ...update } : { ...create };
        db.limites.set(where.chave, val);
        return val;
      },
      update: async ({ where, data }: any) => {
        const val = { ...db.limites.get(where.chave), ...data };
        db.limites.set(where.chave, val);
        return val;
      },
      delete: async ({ where }: any) => {
        db.limites.delete(where.chave);
        return { chave: where.chave };
      },
    },
  };

  return prisma;
}

describe('Fase 0 — Correções Imediatas de Segurança (Spec v2.1)', () => {
  it('1. Recusa PINs triviais (repetidos, sequências, pares e anos) e aceita PINs válidos', () => {
    const triviais = ['0000', '1111', '1234', '4321', '5566', '9876', '1212', '1995', '2026', '000000', '123456', '654321', '123', 'abcd'];
    for (const p of triviais) {
      expect(isTrivialPin(p)).toBe(true);
      expect(validateNewPin(p).valid).toBe(false);
    }

    const validos = ['4829', '7391', '482917', '90472'];
    for (const p of validos) {
      expect(isTrivialPin(p)).toBe(false);
      expect(validateNewPin(p).valid).toBe(true);
    }
  });

  it('2. Hash HMAC-SHA256 com pepper versionado + salt único por vínculo', () => {
    const h1 = hashPinWithPepper('482917', 'membro-A');
    const h2 = hashPinWithPepper('482917', 'membro-A');

    expect(h1.startsWith('v1:')).toBe(true);
    expect(h1).not.toBe(h2); // salt aleatório diferente
    expect(h1).not.toContain('482917');
    expect(verifyPinHash('482917', 'membro-A', h1)).toBe(true);
    expect(verifyPinHash('482917', 'membro-B', h1)).toBe(false); // vinculado ao memberId
    expect(verifyPinHash('999999', 'membro-A', h1)).toBe(false);
  });

  it('3. Equipa inicializada sem PINs por omissão e reset pelo gestor gera PIN temporário não trivial', async () => {
    const prisma = createInMemoryPrisma();
    const team = await getPharmacyTeam(prisma, 'farm-1');
    expect(team.length).toBe(3);
    expect(team.every((m) => m.hasPin === false)).toBe(true);
    expect(prisma._db.membros.every((m: any) => m.pin === null && m.pinHash === null)).toBe(true);

    const reset = await updatePharmacyTeamMember(prisma, 'farm-1', team[0].id, { resetPin: true });
    expect(reset?.temporaryPin).toBeDefined();
    expect(isTrivialPin(reset!.temporaryPin!)).toBe(false);
    expect(reset?.member.hasPin).toBe(true);
    expect(reset?.member.pinTemporario).toBe(true);

    // Verifica autenticação com o PIN temporário gerado
    const ok = await verifyMemberPin(prisma, 'farm-1', reset!.temporaryPin!, team[0].id);
    expect(ok.valid).toBe(true);
  });

  it('4. Bloqueio após 5 tentativas falhadas de PIN em 15 minutos', async () => {
    const prisma = createInMemoryPrisma();
    const { member } = await addPharmacyTeamMember(prisma, 'farm-2', {
      nome: 'Ana Balcão',
      email: 'ana@farm.pt',
      role: 'AUXILIAR',
      pin: '739152',
    });

    for (let i = 0; i < 4; i++) {
      const r = await verifyMemberPin(prisma, 'farm-2', '846201', member.id);
      expect(r.valid).toBe(false);
      expect(r.lockedUntil).toBeUndefined();
    }

    // 5.ª falha ativa bloqueio
    const r5 = await verifyMemberPin(prisma, 'farm-2', '846201', member.id);
    expect(r5.valid).toBe(false);
    expect(r5.lockedUntil).toBeDefined();

    // Mesmo com o PIN correto, continua bloqueado durante a janela
    const rBlocked = await verifyMemberPin(prisma, 'farm-2', '739152', member.id);
    expect(rBlocked.valid).toBe(false);
    expect(rBlocked.error).toContain('Demasiadas tentativas');
  });

  it('5. Tokens de recuperação guardados apenas em hash SHA-256 na BD e de uso único', async () => {
    const prisma = createInMemoryPrisma();
    const rawToken = await createPasswordResetToken(prisma, 'dt@farm.pt', 'farm-1');

    // A BD nunca contém o token em claro
    expect(prisma._db.tokens.length).toBe(1);
    expect(prisma._db.tokens[0].token).not.toBe(rawToken);
    expect(prisma._db.tokens[0].token).toBe(hashOpaqueToken(rawToken));

    const verified = await verifyPasswordResetToken(prisma, rawToken);
    expect(verified?.email).toBe('dt@farm.pt');

    const consumed = await consumePasswordResetToken(prisma, rawToken);
    expect(consumed).toBe(true);

    // Segunda utilização falha
    const verifiedAgain = await verifyPasswordResetToken(prisma, rawToken);
    expect(verifiedAgain).toBeNull();
  });

  it('6. Cookies __Host-, HttpOnly, Secure, SameSite=Lax e verificação no arranque em produção', () => {
    const prodCookie = buildSecureCookieHeader('sid', 'tok123', { isProd: true, maxAgeSec: 3600 });
    expect(prodCookie).toContain('__Host-sid=tok123');
    expect(prodCookie).toContain('HttpOnly');
    expect(prodCookie).toContain('Secure');
    expect(prodCookie).toContain('SameSite=Lax');
    expect(prodCookie).toContain('Path=/');
    expect(prodCookie).not.toContain('Domain=');

    const devCookie = buildSecureCookieHeader('sid', 'tok123', { isProd: false, maxAgeSec: 3600 });
    expect(devCookie).toContain('sid=tok123');
    expect(devCookie).toContain('HttpOnly');
    expect(devCookie).not.toContain('__Host-');

    expect(readCookieValue('__Host-sid=abc123; other=1', ['sid'])).toBe('abc123');
    expect(readCookieValue('sid=dev456', ['sid'])).toBe('dev456');

    expect(() => assertProductionSecurityConfig(true, { allowInsecureHttpInProd: true })).toThrow();
  });

  it('7. Cabeçalhos de segurança obrigatórios e CSP Report-Only', () => {
    const headers: Record<string, string> = {};
    const fakeRes: any = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
    };

    applySecurityHeaders(fakeRes, { isProd: true, isHttps: true, isAuthenticated: true });
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(headers['Content-Security-Policy-Report-Only']).toContain("frame-ancestors 'none'");
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });

  it('8. Rate limiting persistente em Postgres (limites_taxa) bloqueia e limpa no reset', async () => {
    const prisma = createInMemoryPrisma();
    const key = 'login:test@farm.pt:1.2.3.4';

    for (let i = 0; i < 3; i++) {
      await recordDbRateLimitHit(prisma, key, 60_000, { maxBeforeBlock: 3, baseBlockMs: 60_000 });
    }

    const blocked = await checkDbRateLimit(prisma, key, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    await resetDbRateLimit(prisma, key);
    const afterReset = await checkDbRateLimit(prisma, key, 3, 60_000);
    expect(afterReset.allowed).toBe(true);
  });

  it('9. generateTemporaryPin gera sempre PINs de 6 dígitos não triviais', () => {
    for (let i = 0; i < 30; i++) {
      const p = generateTemporaryPin();
      expect(p).toMatch(/^\d{6}$/);
      expect(isTrivialPin(p)).toBe(false);
    }
  });

  it('10. PIN temporário obriga troca no primeiro uso e impede reaproveitamento', async () => {
    const prisma = createInMemoryPrisma();
    const team = await getPharmacyTeam(prisma, 'farm-temp');
    const reset = await updatePharmacyTeamMember(prisma, 'farm-temp', team[0].id, { resetPin: true });
    const tempPin = reset!.temporaryPin!;

    // Primeiro uso devolve requiresPinChange: true
    const loginRes = await verifyMemberPin(prisma, 'farm-temp', tempPin, team[0].id);
    expect(loginRes.valid).toBe(true);
    expect(loginRes.requiresPinChange).toBe(true);

    // Tentar reaproveitar o mesmo PIN temporário é recusado
    const reuseRes = await changeMemberPin(prisma, 'farm-temp', team[0].id, tempPin, tempPin);
    expect(reuseRes.ok).toBe(false);
    expect(reuseRes.error).toContain('diferente');

    // Trocar por um PIN novo válido limpa pinTemporario e invalida o temporário
    const changeOk = await changeMemberPin(prisma, 'farm-temp', team[0].id, tempPin, '839204');
    expect(changeOk.ok).toBe(true);
    expect(changeOk.member?.pinTemporario).toBe(false);

    const oldTempCheck = await verifyMemberPin(prisma, 'farm-temp', tempPin, team[0].id);
    expect(oldTempCheck.valid).toBe(false);

    const newPinCheck = await verifyMemberPin(prisma, 'farm-temp', '839204', team[0].id);
    expect(newPinCheck.valid).toBe(true);
    expect(newPinCheck.requiresPinChange).toBe(false);
  });

  it('11. Rate limit é fail-closed quando a BD falha em endpoints de login/PIN', async () => {
    const brokenPrisma: any = {
      limiteTaxa: {
        findUnique: async () => {
          throw new Error('DB connection lost');
        },
      },
    };
    const res = await checkDbRateLimit(brokenPrisma, 'pin:farm-1', 5, 60_000, true);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSec).toBeGreaterThan(0);
  });

  it('12. Relatório CSP corta query strings sensíveis e página de reset envia Referrer-Policy: no-referrer', () => {
    expect(stripQueryString('https://bipharma.nuelltech.com/reset-password?token=secret123#frag')).toBe(
      'https://bipharma.nuelltech.com/reset-password'
    );

    const headers: Record<string, string> = {};
    const fakeRes: any = { setHeader: (k: string, v: string) => { headers[k] = v; } };
    applySecurityHeaders(fakeRes, { isProd: true, isHttps: true, isResetPage: true });
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Content-Security-Policy-Report-Only']).toContain('report-uri /api/security/csp-report');
  });
});
