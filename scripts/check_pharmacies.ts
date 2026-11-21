import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const farmacias = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
  console.log('--- FARMÁCIAS REGISTADAS ---');
  for (const f of farmacias) {
    const invCount = await prisma.inventario.count({ where: { farmaciaId: f.id } });
    const venCount = await prisma.venda.count({ where: { farmaciaId: f.id } });
    const snapCount = await prisma.inventarioSnapshot.count({ where: { farmaciaId: f.id } });
    const precoCount = await prisma.precoFarmacia.count({ where: { farmaciaId: f.id } });
    const taskCount = await prisma.tarefaEquipa.count({ where: { farmaciaId: f.id } });
    const martCount = await prisma.martProdutoMetricas.count({ where: { farmaciaId: f.id } });

    console.log(`[${f.id}] ${f.nome} (NIF: ${f.nif}, Código: ${f.codigoAcesso}) -> Inventário: ${invCount}, Vendas: ${venCount}, Preços: ${precoCount}, Snapshots: ${snapCount}, Tarefas: ${taskCount}, Marts: ${martCount}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
