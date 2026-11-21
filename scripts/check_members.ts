import { PrismaClient } from '@prisma/client';
import { hashPinWithPepper } from '../src/services/security_phase0';

const prisma = new PrismaClient();

async function run() {
  const demo = await prisma.farmacia.findFirst({ where: { codigo_acesso: 'FARM-C-590964' } });
  if (demo) {
    console.log('Demo farmacia ID:', demo.id);
    const existing = await prisma.membroEquipa.findFirst({ where: { farmaciaId: demo.id } });
    if (!existing) {
      const memberId = 'mem-demo-1';
      const pinHash = hashPinWithPepper('1234', memberId);
      await prisma.membroEquipa.create({
        data: {
          id: memberId,
          farmaciaId: demo.id,
          nome: 'Equipa Balcão',
          email: 'balcao@farmaciademo.pt',
          role: 'AUXILIAR',
          ativo: true,
          pinHash,
        }
      });
      console.log('Created Equipa Balcão with PIN 1234 for Demo Farmacia!');
    } else {
      console.log('Existing demo member:', existing.nome, 'pinHash:', !!existing.pinHash);
      const pinHash = hashPinWithPepper('1234', existing.id);
      await prisma.membroEquipa.update({
        where: { id: existing.id },
        data: { pinHash }
      });
      console.log('Updated existing demo member with PIN 1234!');
    }
  }
}

run().finally(() => prisma.$disconnect());
