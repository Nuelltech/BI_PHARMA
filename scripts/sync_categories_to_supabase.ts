import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 A iniciar sincronização da nova estrutura de categorias para o Supabase...');

  const taxPath = path.join(__dirname, '../src/data/category_taxonomy_map.json');
  if (!fs.existsSync(taxPath)) {
    throw new Error('category_taxonomy_map.json não encontrado!');
  }

  const taxonomy = JSON.parse(fs.readFileSync(taxPath, 'utf-8'));
  console.log(`📦 Carregados ${Object.keys(taxonomy).length} registos de taxonomia.`);

  const produtos = await prisma.produtoMestre.findMany({
    select: {
      cnp_codigo: true,
      tipo_venda: true,
      designacao: true,
      macro_area: true,
      categoria: true,
      subcategoria: true,
      sazonalidade: true,
    },
  });

  console.log(`🔍 Total de produtos em ProdutoMestre na BD: ${produtos.length}`);

  let updatedCount = 0;
  const batchSize = 100;

  for (let i = 0; i < produtos.length; i += batchSize) {
    const batch = produtos.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(async (p) => {
        const tax = taxonomy[p.cnp_codigo];
        
        let macroArea = tax?.macro_area;
        let cat = tax?.categoria;
        let subcat = tax?.subcategoria;
        let saz = tax?.sazonalidade || 'TODO_O_ANO';
        let ghCod = tax?.gh_codigo || null;
        let switchCnp = tax?.gh_switch_cnp || null;
        let switchNome = tax?.gh_switch_nome || null;
        let switchGanho = tax?.gh_switch_margem_ganho ?? null;

        // Se não tiver taxonomia direta no JSON, definir com base no tipo_venda existente
        if (!macroArea) {
          if (p.tipo_venda === 'MSRM') {
            macroArea = 'MSRM';
            cat = cat || 'Medicamentos de Prescrição Médica';
            subcat = subcat || 'Terapêutica Crónica / Geral';
          } else if (p.tipo_venda === 'MNSRM') {
            macroArea = 'MNSRM_OTC';
            cat = cat || 'Venda Livre / OTC';
            subcat = subcat || 'Medicamentos Não Sujeitos a Receita Médica';
          } else {
            macroArea = 'DERMOCOSMETICA';
            cat = cat || 'Outros Cuidados de Saúde';
            subcat = subcat || 'Geral';
          }
        }

        await prisma.produtoMestre.update({
          where: { cnp_codigo: p.cnp_codigo },
          data: {
            macro_area: macroArea,
            categoria: cat,
            subcategoria: subcat,
            sazonalidade: saz,
            gh_codigo: ghCod,
            gh_switch_cnp: switchCnp,
            gh_switch_nome: switchNome,
            gh_switch_margem_ganho: switchGanho,
          },
        });
        updatedCount++;
      })
    );

    if ((i + batchSize) % 2000 === 0 || i + batchSize >= produtos.length) {
      console.log(`⏳ Progresso: ${Math.min(i + batchSize, produtos.length)} / ${produtos.length} produtos atualizados...`);
    }
  }

  console.log(`✅ Sincronização concluída com sucesso! ${updatedCount} produtos atualizados no Supabase.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ Erro na sincronização:', err);
  prisma.$disconnect();
  process.exit(1);
});
