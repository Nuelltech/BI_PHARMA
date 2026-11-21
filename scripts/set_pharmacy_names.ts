import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Gestão de nomes reais das farmácias e criação da farmácia fictícia de testes.
 *
 * Uso:
 *   npx tsx scripts/set_pharmacy_names.ts list
 *   npx tsx scripts/set_pharmacy_names.ts rename <farmaciaId> "Nome Real da Farmácia" [slug]
 *   npx tsx scripts/set_pharmacy_names.ts demo        # cria/atualiza "Farmácia Demo (Teste)"
 */
async function main() {
  const prisma = new PrismaClient();
  const [cmd, a, b, c] = process.argv.slice(2);
  try {
    if (cmd === 'list' || !cmd) {
      const farms = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
      for (const f of farms) {
        console.log(`${f.id} | ${f.nome} | slug=${f.slug ?? '-'} | NIF=${f.nif} | estado=${f.estado}`);
      }
      return;
    }

    if (cmd === 'rename') {
      if (!a || !b) throw new Error('Uso: rename <farmaciaId> "Nome" [slug]');
      const slug = (c || b)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const upd = await prisma.farmacia.update({ where: { id: a }, data: { nome: b, slug } });
      console.log(`Farmácia atualizada: ${upd.nome} (slug=${upd.slug})`);
      return;
    }

    if (cmd === 'demo') {
      const demo = await prisma.farmacia.upsert({
        where: { nif: '999999990' },
        update: { nome: 'Farmácia Demo (Teste)', slug: 'farmacia-demo-teste', planoSaas: 'DEMO' },
        create: {
          nome: 'Farmácia Demo (Teste)',
          nif: '999999990',
          slug: 'farmacia-demo-teste',
          estado: 'ATIVO',
          planoSaas: 'DEMO',
        },
      });
      console.log(`Farmácia fictícia pronta: ${demo.nome} (${demo.id})`);
      return;
    }

    throw new Error(`Comando desconhecido: ${cmd}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
