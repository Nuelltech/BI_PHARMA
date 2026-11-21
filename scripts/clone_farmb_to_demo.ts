import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== FINALIZAR CLONAGEM: KPIS & CÓDIGO DA FARMÁCIA DEMO ===\n');

  const farmB = await prisma.farmacia.findFirst({
    where: { OR: [{ slug: 'farmacia-b' }, { nif: '518149412' }, { nome: { contains: 'Farmácia B' } }] }
  });

  const demo = await prisma.farmacia.findFirst({
    where: { OR: [{ slug: 'farmacia-demo-teste' }, { nif: '999999990' }, { nome: { contains: 'Demo' } }, { planoSaas: 'DEMO' }] }
  });

  if (!farmB || !demo) throw new Error('Farmácias não encontradas.');

  // Clonar MartTenantKpis
  const kpisB = await prisma.martTenantKpis.findUnique({ where: { farmaciaId: farmB.id } });
  if (kpisB) {
    const { farmaciaId: _fid, ...restKpis } = kpisB;
    await prisma.martTenantKpis.upsert({
      where: { farmaciaId: demo.id },
      create: {
        farmaciaId: demo.id,
        ...restKpis,
        atualizadoEm: new Date(),
      },
      update: {
        ...restKpis,
        atualizadoEm: new Date(),
      }
    });
    console.log('✅ MartTenantKpis clonado com sucesso para a Farmácia Demo.');
  }

  // Garantir código exclusivo da Farmácia Demo
  await prisma.farmacia.update({
    where: { id: demo.id },
    data: { codigo_acesso: 'FARM-C-590964' }
  });
  console.log('✅ Código de Acesso Exclusivo verificado: FARM-C-590964');

  // Clonar TarefaEquipa se existir na Farmácia B
  const tarefasB = await prisma.tarefaEquipa.findMany({ where: { farmaciaId: farmB.id } });
  for (const t of tarefasB) {
    await prisma.tarefaEquipa.upsert({
      where: {
        farmaciaId_week_key_task_id: {
          farmaciaId: demo.id,
          week_key: t.week_key,
          task_id: t.task_id,
        }
      },
      create: {
        farmaciaId: demo.id,
        week_key: t.week_key,
        task_id: t.task_id,
        categoria: t.categoria,
        titulo: t.titulo,
        descricao: t.descricao,
        concluido: t.concluido,
        concluido_por: t.concluido_por,
        concluido_em: t.concluido_em,
        valor_impacto: t.valor_impacto,
        dados_json: t.dados_json as any,
      },
      update: {
        categoria: t.categoria,
        titulo: t.titulo,
        descricao: t.descricao,
        dados_json: t.dados_json as any,
      }
    });
  }
  console.log(`✅ Tarefas clonadas: ${tarefasB.length}`);

  // Verificar contagens finais da Farmácia Demo
  console.log('\n--- VERIFICAÇÃO FINAL DA FARMÁCIA DEMO ---');
  console.log('Inventário          :', await prisma.inventario.count({ where: { farmaciaId: demo.id } }));
  console.log('Vendas              :', await prisma.venda.count({ where: { farmaciaId: demo.id } }));
  console.log('Preços & Margens    :', await prisma.precoFarmacia.count({ where: { farmaciaId: demo.id } }));
  console.log('Snapshots de Stock  :', await prisma.inventarioSnapshot.count({ where: { farmaciaId: demo.id } }));
  console.log('Marts Métricas      :', await prisma.martProdutoMetricas.count({ where: { farmaciaId: demo.id } }));
  console.log('Marts Mensais       :', await prisma.martProdutoMes.count({ where: { farmaciaId: demo.id } }));
  console.log('Grupos DCI          :', await prisma.martDciGrupo.count({ where: { farmaciaId: demo.id } }));
  console.log('KPIs do Tenant      :', await prisma.martTenantKpis.count({ where: { farmaciaId: demo.id } }));
  console.log('Tarefas de Equipa   :', await prisma.tarefaEquipa.count({ where: { farmaciaId: demo.id } }));
}

main().catch(console.error).finally(() => prisma.$disconnect());
