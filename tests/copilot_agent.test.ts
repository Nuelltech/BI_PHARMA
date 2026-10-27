import 'dotenv/config';
import { ensureDatabaseReady } from '../src/db';
import { processQuestionWithLlmOrLocal } from '../src/services/llm_router';
import { localSmartSearch } from '../src/services/product_catalog';

async function runTests() {
  console.log('🧪 Iniciando Testes do Copilot Agêntico & Pesquisa de Catálogo...');
  const { prisma, cleanup } = await ensureDatabaseReady();
  try {
    const farm = await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'desc' } });
    if (!farm) throw new Error('Nenhuma farmácia encontrada');

  console.log(`Farmácia ativa: ${farm.nome} (${farm.id})\n`);

  // 1. Teste Motor Local: "eau de toillete , o que temos em stock?"
  console.log('--- 1. Motor Local (Sem IA): "eau de toillete , o que temos em stock?" ---');
  const rLocal1 = await localSmartSearch(prisma, farm.id, 'eau de toillete , o que temos em stock?');
  console.log('Título:', rLocal1.titulo);
  rLocal1.linhas.forEach((l) => console.log(`  [${l.valores[0]}] ${l.valores[2]} | Stock: ${l.valores[3]}`));
  if (rLocal1.linhas.length !== 6) {
    throw new Error(`Esperado 6 Eau de Toilette com stock, obtido ${rLocal1.linhas.length}`);
  }
  if (rLocal1.linhas.some((l) => String(l.valores[3]).startsWith('0 '))) {
    throw new Error('Encontrado artigo com stock 0 quando pedido em stock!');
  }

  // 2. Teste Motor Local: "que perfumes temos em stock?"
  console.log('\n--- 2. Motor Local (Sem IA): "que perfumes temos em stock?" ---');
  const rLocal2 = await localSmartSearch(prisma, farm.id, 'que perfumes temos em stock?');
  console.log('Título:', rLocal2.titulo);
  rLocal2.linhas.forEach((l) => console.log(`  [${l.valores[0]}] ${l.valores[2]} | Stock: ${l.valores[3]}`));
  if (rLocal2.linhas.length !== 10) {
    throw new Error(`Esperado 10 perfumes/EDT em stock, obtido ${rLocal2.linhas.length}`);
  }

  // 3. Teste Agente IA Multi-Passo: "eau de toillete , o que temos em stock?"
  console.log('\n--- 3. Agente IA (Claude Multi-Passo): "eau de toillete , o que temos em stock?" ---');
  const rAgent1 = await processQuestionWithLlmOrLocal(prisma, farm.id, 'eau de toillete , o que temos em stock?');
  console.log('Título:', rAgent1?.titulo);
  console.log('Explicação:', rAgent1?.explicacao);
  console.log('Resumo:', rAgent1?.resumoEstrategico);
  rAgent1?.linhas.forEach((l) => console.log(`  [${l.valores[0]}] ${l.valores[2]} | Stock: ${l.valores[3]}`));

  // 4. Teste Agente IA Multi-Passo: "que perfumes temos em stock?"
  console.log('\n--- 4. Agente IA (Claude Multi-Passo): "que perfumes temos em stock?" ---');
  const rAgent2 = await processQuestionWithLlmOrLocal(prisma, farm.id, 'que perfumes temos em stock?');
  console.log('Título:', rAgent2?.titulo);
  console.log('Explicação:', rAgent2?.explicacao);
  console.log('Resumo:', rAgent2?.resumoEstrategico);
  rAgent2?.linhas.forEach((l) => console.log(`  [${l.valores[0]}] ${l.valores[2]} | Stock: ${l.valores[3]}`));

    console.log('\n🎉 Todos os testes do Copilot concluídos com sucesso!');
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error('❌ Erro nos testes:', err);
  process.exit(1);
});
