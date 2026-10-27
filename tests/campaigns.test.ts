import { ensureDatabaseReady } from '../src/db';
import {
  getSeasonalCampaignSuggestions,
  getMarketingAndCrossSellingIntelligence,
  calculateCampaignFinancials,
  generateOmnichannelMaterials,
  generateMonthlyEmailDigest,
  buildCustomCampaign,
  analyzeProductMarketingAndCrossSell360,
} from '../src/services/campaigns';
import { classifyAllExistingProducts } from '../src/services/classifier';
import { analyzePharmacyInventory } from '../src/services/analysis';

async function runTests() {
  console.log('🧪 Iniciando Testes do Motor de Campanhas, Escoamento 360º & Recomendações por SKU...');

  const { prisma, cleanup } = await ensureDatabaseReady();

  try {
    const farmacia = await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'desc' } });
    if (!farmacia) {
      throw new Error('Nenhuma farmácia encontrada no PostgreSQL!');
    }
    console.log(`Farmácia de teste: ${farmacia.nome} (${farmacia.id})`);

    // 0. Teste das Colunas de Recomendação por SKU (Monos, Excesso Cobertura e Risco Caducidade)
    console.log('\n--- 0. Teste de Preenchimento Inteligente da Coluna de Recomendação por Artigo ---');
    const report = await analyzePharmacyInventory(prisma, farmacia.id);
    console.log(`Monos: ${report.monos.length} | Excesso Cobertura: ${report.alertas_excesso_cobertura.length} | Risco Caducidade: ${report.risco_elevado_caducidade.length}`);

    const vagueLegacyText = 'Disponível para recomendação direta de balcão e exposição linear';
    const hasVagueMono = report.monos.some((m) => m.acao_sugerida.includes(vagueLegacyText));
    if (hasVagueMono) {
      throw new Error('Encontrado texto legado vago em acao_sugerida dos Monos!');
    }

    console.log('Exemplos de Recomendações Inteligentes em MONOS (Venda Livre & MSRM):');
    for (const m of report.monos.filter((x) => x.tipo_venda !== 'MSRM').slice(0, 5)) {
      console.log(`  • [${m.cnp_codigo}] ${m.designacao} (${m.stock_atual} un) -> ${m.acao_sugerida}`);
    }
    for (const m of report.monos.filter((x) => x.eh_generico).slice(0, 2)) {
      console.log(`  • [${m.cnp_codigo}] ${m.designacao} (${m.stock_atual} un) -> ${m.acao_sugerida}`);
    }
    console.log('Exemplos de Recomendações Inteligentes em RISCO DE CADUCIDADE:');
    for (const r of report.risco_elevado_caducidade.filter((x) => x.tipo_venda !== 'MSRM').slice(0, 3)) {
      console.log(`  • [${r.cnp_codigo}] ${r.designacao} (Val: ${r.data_validade}, ${r.stock_atual} un) -> ${r.acao_recomendada}`);
    }

    // 1. Teste de Sugestões de Campanhas de Época + Planos Táticos de Liquidação
    console.log('\n--- 1. Teste de Campanhas de Época + Planos Táticos de Liquidação ---');
    const sugestoes = await getSeasonalCampaignSuggestions(prisma, farmacia.id, 12); // Testar Dezembro
    console.log(`Total de Planos (Época + Liquidação) encontrados: ${sugestoes.length}`);

    for (const s of sugestoes) {
      console.log(
        `  👉 [${s.campanha.tipoCampanha}] ${s.campanha.icone} ${s.campanha.titulo} | No Lote: ${s.produtosSugeridos.length} SKUs (${s.totalArtigosDisponiveis} elegíveis) | ${s.totalUnidadesStock} un | Margem: ${s.margemMediaAtualPct.toFixed(1)}%`
      );
    }

    const primeira = sugestoes[0];
    console.log(`\n✅ Detalhe Campanha 1: ${primeira.campanha.icone} ${primeira.campanha.titulo} (${primeira.campanha.epoca})`);
    for (const p of primeira.produtosSugeridos.slice(0, 8)) {
      console.log(
        `  - [${p.eixo_campanha}] ${p.designacao} | Critério: ${p.criterio_marketing} | Canal: ${p.canais_recomendados} | Stock: ${p.stock_atual} un | PVP: ${p.pvp.toFixed(2)}€`
      );
      if (p.stock_atual <= 0) {
        throw new Error(`Produto sem stock incluído na campanha: ${p.designacao}`);
      }
      if (p.designacao.toUpperCase().includes('SUN SERUM') || p.designacao.toUpperCase().includes('SPF50')) {
        throw new Error(`Protetor solar incluído indevidamente na campanha de Natal: ${p.designacao}`);
      }
    }

    // 2. Teste de Radiografia de Marketing & Cross-Selling "Locomotiva -> Vagão"
    console.log('\n--- 2. Teste de Radiografia de Marketing & Protocolos de Cross-Selling ---');
    const intel = await getMarketingAndCrossSellingIntelligence(prisma, farmacia.id);
    console.log('Radiografia de Critérios de Marketing do Stock:', JSON.stringify(intel.overview.criterios));
    console.log(`Protocolos de Cross-Selling gerados: ${intel.crossSellingPlans.length}`);
    for (const cs of intel.crossSellingPlans) {
      console.log(
        `  🤝 ${cs.icone} ${cs.tituloProtocolo} | Locomotivas: ${cs.locomotivasReais.map((l) => `${l.designacao.slice(0, 20)} (${l.vmm}/mês)`).join(', ')} -> Escoar: ${cs.produtosAEscoar.map((p) => `${p.designacao.slice(0, 22)} [${p.criterioEscoamento}]`).join(', ')}`
      );
    }

    // 3. Teste de Simulação Financeira & Anti-Dumping
    console.log('\n--- 3. Teste de Cálculo Financeiro & Certificação Anti-Dumping ---');
    const sim15 = calculateCampaignFinancials(primeira.produtosSugeridos, 15);
    console.log(`Desconto aplicado: ${sim15.descontoAplicadoPct}% | Faturação Promo: ${sim15.faturacaoComDesconto.toFixed(2)} € | Margem final: ${sim15.margemFinalPct.toFixed(1)}% | ${sim15.seloAntiDumpingTexto}`);

    // 4. Teste de Geração Omnicanal e Boletim Email
    const canais = ['loja', 'redes', 'ecras', 'app'];
    const materiais = generateOmnichannelMaterials(primeira.campanha, primeira.produtosSugeridos, canais);
    const email = generateMonthlyEmailDigest(farmacia.nome, primeira.campanha, primeira.produtosSugeridos, sim15);
    console.log(`✅ Materiais Omnicanal e Email Digest (${email.html.length} chars) gerados com sucesso!`);

    // 5. Atualizar Classificação e Testar Simulador 360º para o Antigrippine Trieffect Tosse (5818711)
    console.log('\n--- 5. Teste de Simulador 360º por Produto (Antigrippine Trieffect Tosse) ---');
    await classifyAllExistingProducts(prisma);
    const analiseAntigrippine = await analyzeProductMarketingAndCrossSell360(prisma, farmacia.id, '5818711');
    if (!analiseAntigrippine) {
      throw new Error('Antigrippine (5818711) não encontrado pelo analyzeProductMarketingAndCrossSell360!');
    }
    console.log(`  🎯 Produto: [${analiseAntigrippine.produtoAlvo.cnp}] ${analiseAntigrippine.produtoAlvo.designacao}`);
    console.log(`  🏷️ Categoria: ${analiseAntigrippine.produtoAlvo.categoria} | Stock: ${analiseAntigrippine.produtoAlvo.stockAtual} un`);
    console.log(`  🏁 Meta Equipa: ${analiseAntigrippine.produtoAlvo.metaEquipaTexto}`);
    console.log(`  🚂 Locomotivas que puxam: ${analiseAntigrippine.gatilhosEntrada.locomotivasQuePuxam.map((l) => `${l.designacao.slice(0, 22)} (${l.vmm}/mês)`).join(', ')}`);
    console.log(`  🤝 Parceiros Cross-Sell: ${analiseAntigrippine.parceirosCrossSelling.map((p) => `${p.designacao.slice(0, 24)} [${p.criterioUrgencia}]`).join(', ')}`);
    console.log(`  💬 Script: ${analiseAntigrippine.scriptBalcaoPronto}`);

    // 6. Teste de Criador de Campanhas à Medida (Halloween, Black Friday, Festas da Cidade e Produto Foco)
    console.log('\n--- 6. Teste de Construtor de Campanhas à Medida ---');
    for (const preset of ['halloween', 'black_friday', 'festas_cidade'] as const) {
      const customRes = await buildCustomCampaign(prisma, farmacia.id, {
        modo: 'EVENTO',
        eventoPreset: preset,
      });
      console.log(
        `  ✨ Preset [${preset}] -> ${customRes.campanha.icone} ${customRes.campanha.titulo}: ${customRes.produtosSugeridos.length} SKUs (${customRes.totalUnidadesStock} un)`
      );
    }

    const focoAntigrippine = await buildCustomCampaign(prisma, farmacia.id, {
      modo: 'PRODUTOS',
      cnpsSelecionados: ['5818711'],
    });
    console.log(
      `  🎯 Campanha Foco Produto Único -> ${focoAntigrippine.campanha.titulo}: ${focoAntigrippine.produtosSugeridos[0]?.designacao} (${focoAntigrippine.totalUnidadesStock} un)`
    );

    console.log('\n🎉 Todos os testes do motor de Marketing e Escoamento 360º passaram com sucesso!');
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error('❌ Erro nos testes:', err);
  process.exit(1);
});
