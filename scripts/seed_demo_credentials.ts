import { PrismaClient } from '@prisma/client';
import {
  hashPasswordScrypt,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../src/services/auth_crypto';
import { hashPinWithPepper } from '../src/services/security_phase0';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('--- A CRIAR CREDENCIAIS DE DEMONSTRAÇÃO E TESTE NO BI PHARMA ---');

  // 1. Obter ou criar a Farmácia Demo
  let farmacia = await prisma.farmacia.findFirst({
    where: { slug: 'farmacia-demo-teste' },
  });

  if (!farmacia) {
    farmacia = await prisma.farmacia.create({
      data: {
        nome: 'Farmácia Central Demo',
        nif: '505016499',
        slug: 'farmacia-demo-teste',
        estado: 'ATIVO',
      },
    });
  }

  // Obter outras farmácias para visão de grupo
  const otherFarms = await prisma.farmacia.findMany({
    where: { id: { not: farmacia.id }, estado: 'ATIVO' },
  });

  // 2. Utilizador 1: OPERADOR DE BALCÃO (Acesso Direto Sem MFA Obrigatório)
  const opEmail = 'operador@bipharma.pt';
  const opPasswordHash = await hashPasswordScrypt('Operador2026!');
  const opUser = await prisma.utilizador.upsert({
    where: { email: opEmail },
    create: {
      email: opEmail,
      nome: 'Maria Silva (Operadora de Balcão)',
      passwordHash: opPasswordHash,
      ativo: true,
      isSuperadmin: false,
    },
    update: {
      passwordHash: opPasswordHash,
      ativo: true,
    },
  });

  const pinRaw = '1829';
  const opMember = await prisma.membroFarmacia.upsert({
    where: {
      utilizadorId_farmaciaId: {
        utilizadorId: opUser.id,
        farmaciaId: farmacia.id,
      },
    },
    create: {
      utilizadorId: opUser.id,
      farmaciaId: farmacia.id,
      nome: opUser.nome,
      perfil: 'OPERADOR_BALCAO',
      farmaciaPadrao: true,
      estado: 'ATIVO',
      pinHash: hashPinWithPepper(pinRaw, opUser.id),
      pinAlteradoEm: new Date(),
    },
    update: {
      perfil: 'OPERADOR_BALCAO',
      estado: 'ATIVO',
      farmaciaPadrao: true,
      pinHash: hashPinWithPepper(pinRaw, opUser.id),
    },
  });

  // 3. Utilizador 2: PROPRIETÁRIO (Com MFA configurado e Códigos de Recuperação Prontos)
  const propEmail = 'proprietario@bipharma.pt';
  const propPasswordHash = await hashPasswordScrypt('Proprietario2026!');
  const knownBase32Secret = 'JBSWY3DPEHPK3PXP'; // Segredo TOTP demo
  const encTotp = encryptTotpSecret(knownBase32Secret);

  // Criar códigos de recuperação conhecidos para o teste
  const demoRecoveryPlain = ['11111111', '22222222', '33333333', '44444444', '55555555'];
  const demoRecoveryHashes = demoRecoveryPlain.map(hashRecoveryCode);

  const propUser = await prisma.utilizador.upsert({
    where: { email: propEmail },
    create: {
      email: propEmail,
      nome: 'Dr. António Rocha (Proprietário)',
      passwordHash: propPasswordHash,
      ativo: true,
      isSuperadmin: false,
      totpAtivo: true,
      totpSecretEnc: encTotp,
      totpRecoveryHashes: demoRecoveryHashes,
    },
    update: {
      passwordHash: propPasswordHash,
      ativo: true,
      totpAtivo: true,
      totpSecretEnc: encTotp,
      totpRecoveryHashes: demoRecoveryHashes,
    },
  });

  // Vínculo como PROPRIETÁRIO na Farmácia Demo
  await prisma.membroFarmacia.upsert({
    where: {
      utilizadorId_farmaciaId: {
        utilizadorId: propUser.id,
        farmaciaId: farmacia.id,
      },
    },
    create: {
      utilizadorId: propUser.id,
      farmaciaId: farmacia.id,
      nome: propUser.nome,
      perfil: 'PROPRIETARIO',
      farmaciaPadrao: true,
      estado: 'ATIVO',
      pinHash: hashPinWithPepper('4920', propUser.id),
    },
    update: {
      perfil: 'PROPRIETARIO',
      estado: 'ATIVO',
      farmaciaPadrao: true,
    },
  });

  // Dar vínculo com 'ver_grupo' e 'ver_custos' nas outras farmácias para testar visão de grupo
  for (const f of otherFarms) {
    await prisma.membroFarmacia.upsert({
      where: {
        utilizadorId_farmaciaId: {
          utilizadorId: propUser.id,
          farmaciaId: f.id,
        },
      },
      create: {
        utilizadorId: propUser.id,
        farmaciaId: f.id,
        nome: propUser.nome,
        perfil: 'PROPRIETARIO',
        estado: 'ATIVO',
      },
      update: {
        perfil: 'PROPRIETARIO',
        estado: 'ATIVO',
      },
    });
  }

  // 4. Atualizar SUPERADMIN (admin@nuelltech.com)
  const superEmail = 'admin@nuelltech.com';
  const superPasswordHash = await hashPasswordScrypt('SuperAdmin2026!');
  await prisma.utilizador.upsert({
    where: { email: superEmail },
    create: {
      email: superEmail,
      nome: 'Administrador Nuelltech',
      passwordHash: superPasswordHash,
      isSuperadmin: true,
      ativo: true,
      totpAtivo: true,
      totpSecretEnc: encTotp,
      totpRecoveryHashes: demoRecoveryHashes,
    },
    update: {
      passwordHash: superPasswordHash,
      isSuperadmin: true,
      ativo: true,
      totpAtivo: true,
      totpSecretEnc: encTotp,
      totpRecoveryHashes: demoRecoveryHashes,
    },
  });

  const superUserObj = await prisma.utilizador.findUnique({ where: { email: superEmail } });
  if (superUserObj) {
    const allFarms = await prisma.farmacia.findMany();
    for (const f of allFarms) {
      await prisma.membroFarmacia.upsert({
        where: {
          utilizadorId_farmaciaId: {
            utilizadorId: superUserObj.id,
            farmaciaId: f.id,
          },
        },
        create: {
          utilizadorId: superUserObj.id,
          farmaciaId: f.id,
          nome: superUserObj.nome,
          perfil: 'PROPRIETARIO',
          farmaciaPadrao: f.slug === 'farmacia-demo-teste' || f.nome.includes('Farmácia A'),
          estado: 'ATIVO',
        },
        update: {
          perfil: 'PROPRIETARIO',
          estado: 'ATIVO',
        },
      });
    }
  }

  console.log('\n============================================================');
  console.log('✅ CREDENCIAIS DE DEMONSTRAÇÃO PRONTAS A USAR:');
  console.log('============================================================');
  console.log('\n1. OPERADOR DE BALCÃO (Acesso Direto sem MFA):');
  console.log('   - URL:      http://localhost:3000/login');
  console.log('   - Email:    operador@bipharma.pt');
  console.log('   - Password: Operador2026!');
  console.log('   - PIN para Terminal Balcão (/balcao): 1829');
  console.log('\n2. PROPRIETÁRIO (Acesso Total + Gestão + Visão de Grupo):');
  console.log('   - URL:      http://localhost:3000/login');
  console.log('   - Email:    proprietario@bipharma.pt');
  console.log('   - Password: Proprietario2026!');
  console.log('   - Código de Recuperação (se pedir 2FA/TOTP): 11111111');
  console.log('   - Ou chave manual TOTP no Google Auth: JBSWY3DPEHPK3PXP');
  console.log('\n3. SUPERADMINISTRADOR (Consola de Administração):');
  console.log('   - URL:      http://localhost:3000/login');
  console.log('   - Email:    admin@nuelltech.com');
  console.log('   - Password: SuperAdmin2026!');
  console.log('   - Código de Recuperação TOTP: 11111111');
  console.log('============================================================\n');
}

main()
  .catch((e) => {
    console.error('Erro ao semear credenciais:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
