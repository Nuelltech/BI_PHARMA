import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const farmB = '8c34599d-9597-45a3-b122-8ffed62a5375';
  const demo = '594bdf27-151b-49f7-be71-18660b745d84';
  
  console.log('--- FARMÁCIA B STATS ---');
  console.log('Inventario:', await prisma.inventario.count({ where: { farmaciaId: farmB } }));
  console.log('Venda:', await prisma.venda.count({ where: { farmaciaId: farmB } }));
  console.log('PrecoFarmacia:', await prisma.precoFarmacia.count({ where: { farmaciaId: farmB } }));
  console.log('InventarioSnapshot:', await prisma.inventarioSnapshot.count({ where: { farmaciaId: farmB } }));
  console.log('MartProdutoMetricas:', await prisma.martProdutoMetricas.count({ where: { farmaciaId: farmB } }));
  console.log('MartProdutoMes:', await prisma.martProdutoMes.count({ where: { farmaciaId: farmB } }));
  console.log('MartDciGrupo:', await prisma.martDciGrupo.count({ where: { farmaciaId: farmB } }));
  console.log('MartTenantKpis:', await prisma.martTenantKpis.count({ where: { farmaciaId: farmB } }));
  console.log('TarefaEquipa:', await prisma.tarefaEquipa.count({ where: { farmaciaId: farmB } }));
  console.log('CampanhaAtiva:', await prisma.campanhaAtiva.count({ where: { farmaciaId: farmB } }));

  console.log('\n--- FARMÁCIA DEMO STATS ---');
  console.log('Inventario:', await prisma.inventario.count({ where: { farmaciaId: demo } }));
  console.log('Venda:', await prisma.venda.count({ where: { farmaciaId: demo } }));
  console.log('PrecoFarmacia:', await prisma.precoFarmacia.count({ where: { farmaciaId: demo } }));
  console.log('InventarioSnapshot:', await prisma.inventarioSnapshot.count({ where: { farmaciaId: demo } }));
  console.log('MartProdutoMetricas:', await prisma.martProdutoMetricas.count({ where: { farmaciaId: demo } }));
  console.log('MartProdutoMes:', await prisma.martProdutoMes.count({ where: { farmaciaId: demo } }));
  console.log('MartDciGrupo:', await prisma.martDciGrupo.count({ where: { farmaciaId: demo } }));
  console.log('MartTenantKpis:', await prisma.martTenantKpis.count({ where: { farmaciaId: demo } }));
  console.log('TarefaEquipa:', await prisma.tarefaEquipa.count({ where: { farmaciaId: demo } }));
  console.log('CampanhaAtiva:', await prisma.campanhaAtiva.count({ where: { farmaciaId: demo } }));
}

main().catch(console.error).finally(() => prisma.$disconnect());
