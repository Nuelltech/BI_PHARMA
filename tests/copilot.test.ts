import { ensureDatabaseReady } from '../src/db';
import { processFreeformQuestion, lemmatizePortugueseWord, extractSearchTokens } from '../src/services/copilot';

async function runTests() {
  console.log('🧪 Iniciando Testes do Assistente Consultivo de Farmácia (Copilot)...');

  // 1. Testes Unitários de Lematização em Português
  console.log('\n--- 1. Testes de Lematização & Plurais (pt-PT) ---');
  const testWords = [
    { word: 'preservativos', expected: 'preservativo' },
    { word: 'fraldas', expected: 'fralda' },
    { word: 'cremes', expected: 'creme' },
    { word: 'géis', expected: 'gel' },
    { word: 'loções', expected: 'locao' },
    { word: 'comprimidos', expected: 'comprimido' },
    { word: 'comp', expected: 'comprimido' },
    { word: 'xaropes', expected: 'xarope' },
    { word: 'xpe', expected: 'xarope' },
  ];

  for (const t of testWords) {
    const res = lemmatizePortugueseWord(t.word);
    console.log(`Lematização: "${t.word}" -> singular="${res.singular}", stem="${res.stem}"`);
    if (res.singular !== t.expected) {
      console.warn(`⚠️ Aviso: esperado "${t.expected}", obteve "${res.singular}"`);
    }
  }

  // 2. Testes de Extração de Tokens
  console.log('\n--- 2. Testes de Extração de Tokens & Stopwords ---');
  const qTest = 'quais os preservativos que temos vendido mais';
  const tokens = extractSearchTokens(qTest);
  console.log(`Pergunta: "${qTest}"`);
  console.log('Tokens limpos:', tokens.cleanTokens);
  console.log('Lemas extraídos:', tokens.lemmas);
  console.log('Stems:', tokens.stems);

  // 3. Testes de Integração com a Base de Dados PostgreSQL
  console.log('\n--- 3. Testes com PostgreSQL (Perguntas Livres) ---');
  const { prisma, cleanup } = await ensureDatabaseReady();

  try {
    const farmacia = await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'desc' } });
    if (!farmacia) {
      throw new Error('Nenhuma farmácia encontrada no PostgreSQL!');
    }
    console.log(`Farmácia de teste: ${farmacia.nome} (${farmacia.id})`);

    const testQuestions = [
      'Para a mesma substancia e dosagem que laboratorias eliminarias por n ter vendas ha 3 meses ou mais',
      'Que stocks ajustavas',
      'Vitativ Transilax Comp 20 com que produtos de receita medica ou venda livre posso fazer venda cruzada',
      'Que produtos de venda livre posso sugerir para os diabeticos',
      'Do stock parado que tenho o que faz sentido recomendar a idosos com problemas cardiacos',
      'Cria uma campanha de venda para os produtos cosmeticos agora para Dezembro e diz quais o que temos para incluir',
      'quais os produtos que tiverem um aumento de vendas nos ultimos 2 meses?',
      'quais os produtos que tiverem uma queda acentuada de vendas',
      'Tivemos algum produto que veio substituir este outro?',
      'preciso compara em vendas estes 3 ou 4 produtos',
      'Qual o produto com este principio ativo que tem mais margem?',
      'Tendo em conta que temos este produto que tem mais margem mas n tem tantas vendas e o outro que tem menos margem mas mais vendas o que fazemos',
      'quais os preservativos que temos vendido mais',
    ];

    for (let i = 0; i < testQuestions.length; i++) {
      const q = testQuestions[i];
      console.log(`\n▶️ [Cenário ${i + 1}] "${q}"`);
      const res = await processFreeformQuestion(prisma, farmacia.id, q);
      if (!res) {
        console.error(`❌ Falha: nenhuma resposta gerada para "${q}"`);
      } else {
        console.log(`  ✅ Título: ${res.titulo}`);
        console.log(`  📊 Colunas: ${res.colunas.length} | Linhas devolvidas: ${res.linhas.length}`);
        if (res.resumoEstrategico) {
          console.log(`  💡 Resumo Estratégico: ${res.resumoEstrategico.substring(0, 100)}...`);
        }
        if (res.linhas.length > 0) {
          console.log(`  Exemplo de linha 1:`, res.linhas[0].valores.slice(0, 4));
        }
      }
    }

    console.log('\n🎉 Todos os testes de integração foram executados com sucesso!');
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error('❌ Erro durante os testes:', err);
  process.exit(1);
});
