/**
 * Script de Bootstrap do Superadmin (Spec v2.1 Secção 17 & Revisão Fase 1)
 *
 * Cria a conta de Superadmin inicial de forma segura e idempotente:
 * - Senha com validação estrita (entropia + blacklist local) e scrypt assíncrono.
 * - Segredo TOTP RFC 6238 gerado na hora e cifrado em AES-256-GCM.
 * - Código QR renderizado diretamente no terminal (qrcode-terminal).
 * - 10 códigos de recuperação de uso único gerados (guardados apenas por hash SHA-256).
 * - Idempotente: se já existir um superadmin ativo, recusa correr a menos que --force-secondary seja passado.
 * - Registo imutável em auditoria_seguranca.
 *
 * Uso:
 *   npx tsx scripts/bootstrap_superadmin.ts
 *   ou com variáveis de ambiente:
 *   SUPERADMIN_EMAIL=admin@nuelltech.com SUPERADMIN_PASSWORD="MinhaPasswordForte123!" npx tsx scripts/bootstrap_superadmin.ts
 */

import readline from 'readline';
import { PrismaClient } from '@prisma/client';
import qrcode from 'qrcode-terminal';
import {
  hashPasswordScrypt,
  generateTotpSecret,
  encryptTotpSecret,
  buildTotpOtpAuthUrl,
  generateRecoveryCodes,
} from '../src/services/auth_crypto';
import { validatePasswordPolicy } from '../src/data/common_passwords';
import { logSecurityAudit } from '../src/services/audit_service';

const prisma = new PrismaClient();

function askQuestion(query: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  console.log('='.repeat(70));
  console.log('🔐 BI PHARMA — BOOTSTRAP DE SUPERADMIN (Fase 1 / Spec v2.1)');
  console.log('='.repeat(70));

  const existingSuperadmins = await prisma.utilizador.findMany({
    where: { isSuperadmin: true, ativo: true },
    select: { id: true, email: true, nome: true, criadoEm: true },
  });

  const forceSecondary = process.argv.includes('--force-secondary');

  if (existingSuperadmins.length > 0 && !forceSecondary) {
    console.log(`\n⚠️  Já existe(m) ${existingSuperadmins.length} superadmin(s) ativo(s) no sistema:`);
    for (const sa of existingSuperadmins) {
      console.log(`   - ${sa.nome} (${sa.email}) criado em ${sa.criadoEm.toISOString()}`);
    }
    console.log('\nOperação cancelada por segurança. Para adicionar um segundo superadmin, utilize o argumento:');
    console.log('   npx tsx scripts/bootstrap_superadmin.ts --force-secondary\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  // Obter credenciais via ENV ou prompt interativo
  let email = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) {
    email = (await askQuestion('Email do Superadmin: ')).toLowerCase();
  }

  if (!email || !email.includes('@')) {
    console.error('❌ Email inválido.');
    process.exit(1);
  }

  let nome = (process.env.SUPERADMIN_NOME || '').trim();
  if (!nome) {
    nome = await askQuestion('Nome do Superadmin (ex: Administrador BI Pharma): ');
  }
  if (!nome) nome = 'Super Administrador';

  let password = process.env.SUPERADMIN_PASSWORD || '';
  if (!password) {
    password = await askQuestion('Password mestre (mínimo 12 caracteres com maiúsculas, minúsculas e números): ');
  }

  const pwdCheck = validatePasswordPolicy(password);
  if (!pwdCheck.valid) {
    console.error(`\n❌ Password rejeitada pela política de segurança:\n   - ${pwdCheck.error}`);
    process.exit(1);
  }

  console.log('\n[1/4] A calcular hash scrypt assíncrono (N=32768, r=8, p=1)...');
  const passwordHash = await hashPasswordScrypt(password);

  console.log('[2/4] A gerar segredo TOTP RFC 6238 e a cifrar com AES-256-GCM...');
  const totpSecret = generateTotpSecret();
  const totpSecretEnc = encryptTotpSecret(totpSecret);
  const otpAuthUrl = buildTotpOtpAuthUrl(email, totpSecret, 'BI Pharma Superadmin');

  console.log('[3/4] A gerar 10 códigos de recuperação de uso único...');
  const { plaintextCodes, hashedCodes } = generateRecoveryCodes(10);

  console.log('[4/4] A persistir superadmin na base de dados de forma transacional...');
  const superadmin = await prisma.$transaction(async (tx) => {
    const existing = await tx.utilizador.findUnique({ where: { email } });
    if (existing) {
      return await tx.utilizador.update({
        where: { id: existing.id },
        data: {
          nome,
          passwordHash,
          isSuperadmin: true,
          totpSecretEnc,
          totpAtivo: true,
          totpRecoveryHashes: hashedCodes,
          totpUltimoPasso: null,
          ativo: true,
        },
      });
    }

    return await tx.utilizador.create({
      data: {
        email,
        nome,
        passwordHash,
        isSuperadmin: true,
        totpSecretEnc,
        totpAtivo: true,
        totpRecoveryHashes: hashedCodes,
        totpUltimoPasso: null,
        ativo: true,
      },
    });
  });

  await logSecurityAudit(prisma, {
    evento: 'SUPERADMIN_CRIADO',
    utilizadorId: superadmin.id,
    ip: '127.0.0.1 (cli)',
    userAgent: 'bootstrap_superadmin_cli',
    detalhes: {
      email,
      nome,
      recoveryCodesGenerated: plaintextCodes.length,
    },
  });

  console.log('\n' + '='.repeat(70));
  console.log('✅ SUPERADMIN CRIADO COM SUCESSO!');
  console.log('='.repeat(70));
  console.log(`ID:    ${superadmin.id}`);
  console.log(`Email: ${superadmin.email}`);
  console.log(`Nome:  ${superadmin.nome}`);

  console.log('\n📱 DIGITALIZE O CÓDIGO QR NO GOOGLE AUTHENTICATOR / 1PASSWORD / BITWARDEN:\n');
  qrcode.generate(otpAuthUrl, { small: true });

  console.log('\nSe não conseguir ler o QR, introduza a chave manual na app:');
  console.log(`Segredo TOTP (Base32): ${totpSecret}`);
  console.log(`URI otpauth:           ${otpAuthUrl}`);

  console.log('\n' + '!'.repeat(70));
  console.log('⚠️  CÓDIGOS DE RECUPERAÇÃO DE USO ÚNICO (GUARDE OFFLINE EM LOCAL SEGURO!):');
  console.log('   Cada código só pode ser usado UMA vez se perder o acesso ao telemóvel.');
  console.log('   A base de dados guarda apenas o hash SHA-256 e NUNCA os códigos em texto.');
  console.log('!'.repeat(70) + '\n');

  for (let i = 0; i < plaintextCodes.length; i++) {
    console.log(`   [${String(i + 1).padStart(2, '0')}] ${plaintextCodes[i]}`);
  }
  console.log('\n' + '='.repeat(70));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\n❌ Erro durante o bootstrap do superadmin:', err);
  await prisma.$disconnect();
  process.exit(1);
});
