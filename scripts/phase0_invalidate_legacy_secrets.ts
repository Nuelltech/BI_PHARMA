import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    // 1. Invalida todos os PINs em texto claro (sem os converter em hash)
    const pinsCleared = await prisma.membroEquipa.updateMany({
      where: { pin: { not: null } },
      data: { pin: null },
    });

    // 2. Remove tokens de recuperação em texto claro (prefixo legado rst_)
    const tokensCleared = await prisma.tokenRecuperacao.deleteMany({
      where: { token: { startsWith: 'rst_' } },
    });

    console.log(
      `[Fase 0] Limpeza concluída: ${pinsCleared.count} PIN(s) em texto claro invalidado(s), ${tokensCleared.count} token(s) de recuperação em claro removido(s).`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[Fase 0] Erro na limpeza de segredos legados:', err);
  process.exit(1);
});
