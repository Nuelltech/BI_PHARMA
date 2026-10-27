import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🏛️ A sincronizar listagem oficial do INFARMED (MNSRM)...');

  const infarmedPath = path.join(__dirname, '../src/data/infarmed_mnsrm_official.json');
  if (!fs.existsSync(infarmedPath)) {
    throw new Error('infarmed_mnsrm_official.json não encontrado!');
  }
  const infarmedMap = JSON.parse(fs.readFileSync(infarmedPath, 'utf-8'));
  const infarmedCnps = new Set(Object.keys(infarmedMap));
  console.log(`📦 Carregados ${infarmedCnps.size} registos oficiais de MNSRM do Infarmed.`);

  // 1. Atualizar firstpharma_dictionary.json
  const fpPath = path.join(__dirname, '../src/data/firstpharma_dictionary.json');
  if (fs.existsSync(fpPath)) {
    const fpDict = JSON.parse(fs.readFileSync(fpPath, 'utf-8'));
    let fpAdded = 0;
    let fpUpdated = 0;
    for (const [cnp, data] of Object.entries<any>(infarmedMap)) {
      if (fpDict[cnp]) {
        if (fpDict[cnp].m !== 0) {
          fpDict[cnp].m = 0;
          fpUpdated++;
        }
      } else {
        fpDict[cnp] = {
          m: 0,
          c: 'MNSRM',
          p: 1,
          gh: 'Sem Grupo Homogéneo',
        };
        fpAdded++;
      }
    }
    fs.writeFileSync(fpPath, JSON.stringify(fpDict));
    console.log(`✅ firstpharma_dictionary.json: +${fpAdded} CNPs novos, ${fpUpdated} corrigidos para m=0.`);
  }

  // 2. Atualizar category_taxonomy_map.json
  const taxPath = path.join(__dirname, '../src/data/category_taxonomy_map.json');
  if (fs.existsSync(taxPath)) {
    const taxMap = JSON.parse(fs.readFileSync(taxPath, 'utf-8'));
    let taxUpdated = 0;
    for (const [cnp, data] of Object.entries<any>(infarmedMap)) {
      if (!taxMap[cnp]) {
        taxMap[cnp] = {
          macro_area: 'MNSRM_OTC',
          categoria: 'Venda Livre / OTC',
          subcategoria: data.dci || 'MNSRM',
          sazonalidade: 'TODO_O_ANO',
          gh_codigo: null,
          gh_switch_cnp: null,
          gh_switch_nome: null,
          gh_switch_margem_ganho: null,
        };
        taxUpdated++;
      } else {
        if (taxMap[cnp].macro_area === 'MSRM') {
          taxMap[cnp].macro_area = 'MNSRM_OTC';
          taxUpdated++;
        }
      }
    }
    fs.writeFileSync(taxPath, JSON.stringify(taxMap));
    console.log(`✅ category_taxonomy_map.json: ${taxUpdated} registos atualizados para MNSRM_OTC.`);
  }

  // 3. Atualizar ProdutoMestre no Supabase
  const produtos = await prisma.produtoMestre.findMany({
    select: {
      cnp_codigo: true,
      designacao: true,
      tipo_venda: true,
      macro_area: true,
      categoria: true,
      subcategoria: true,
      sazonalidade: true,
      aim: true,
    },
  });

  console.log(`🔍 Total de produtos em ProdutoMestre: ${produtos.length}`);

  let matchCount = 0;
  let correctedFromMsrm = 0;
  const updates: Array<{
    cnp_codigo: string;
    tipo_venda: string;
    macro_area: string;
    aim: string | null;
  }> = [];

  for (const p of produtos) {
    if (infarmedCnps.has(p.cnp_codigo)) {
      matchCount++;
      const inf = infarmedMap[p.cnp_codigo];
      const wasMsrm = p.tipo_venda === 'MSRM';
      if (wasMsrm) correctedFromMsrm++;

      if (p.tipo_venda !== 'MNSRM' || p.macro_area !== 'MNSRM_OTC') {
        updates.push({
          cnp_codigo: p.cnp_codigo,
          tipo_venda: 'MNSRM',
          macro_area: 'MNSRM_OTC',
          aim: p.aim || inf.titular || null,
        });
      }
    }
  }

  console.log(`🎯 Produtos que constam na lista oficial Infarmed MNSRM: ${matchCount}`);
  console.log(`⚠️ Produtos que estavam erradamente classificados como MSRM: ${correctedFromMsrm}`);
  console.log(`📝 Total de atualizações a gravar na base de dados: ${updates.length}`);

  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    await prisma.produtoMestre.update({
      where: { cnp_codigo: u.cnp_codigo },
      data: {
        tipo_venda: u.tipo_venda,
        macro_area: u.macro_area,
        aim: u.aim,
      },
    });
    if ((i + 1) % 20 === 0 || i === updates.length - 1) {
      console.log(`⏳ Atualizados ${i + 1} de ${updates.length}...`);
    }
  }

  console.log('✅ Base de dados Supabase totalmente alinhada com a listagem oficial do INFARMED!');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  prisma.$disconnect();
  process.exit(1);
});
