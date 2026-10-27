import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  const samples = await prisma.produtoMestre.findMany({
    where: {
      sazonalidade: { not: 'TODO_O_ANO' }
    },
    take: 5,
    select: {
      cnp_codigo: true,
      designacao: true,
      tipo_venda: true,
      macro_area: true,
      categoria: true,
      subcategoria: true,
      sazonalidade: true,
      gh_codigo: true,
      gh_switch_cnp: true,
      gh_switch_nome: true,
      gh_switch_margem_ganho: true
    }
  });
  console.log('Sample Seasonal products:', JSON.stringify(samples, null, 2));

  const macroCounts = await prisma.produtoMestre.groupBy({
    by: ['macro_area'],
    _count: true
  });
  console.log('Macro Area counts in DB:', macroCounts);

  const sazCounts = await prisma.produtoMestre.groupBy({
    by: ['sazonalidade'],
    _count: true
  });
  console.log('Sazonalidade counts in DB:', sazCounts);

  const switchesCount = await prisma.produtoMestre.count({
    where: { gh_switch_cnp: { not: null } }
  });
  console.log('Products with Switch alternative in DB:', switchesCount);

  await prisma.$disconnect();
}

check();
