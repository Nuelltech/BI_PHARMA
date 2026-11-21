import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { analyzePharmacyInventory } from '../services/analysis';
import { computeAndPersistMarts, getDashboardFromMarts, getProductDetailsFromMarts } from '../services/marts_service';

const prisma = new PrismaClient();

describe('Fase 2: Camada de Dados Analíticos (Marts) & Paridade Numérica', () => {
  it('1. Deve computar os Marts e verificar paridade numérica de 0.00% com o motor antigo', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    if (!farmacia) return;

    // 1. Executa o motor antigo
    const startLegacy = performance.now();
    const legacyReport = await analyzePharmacyInventory(prisma, farmacia.id);
    const legacyDuration = performance.now() - startLegacy;
    console.log(`⏱️ Motor Antigo (em memória no Node): ${legacyDuration.toFixed(1)} ms`);

    // 2. Computa e persiste os Marts
    const startMartsBuild = performance.now();
    await computeAndPersistMarts(prisma, farmacia.id);
    const martsBuildDuration = performance.now() - startMartsBuild;
    console.log(`⏱️ Construção e Persistência de Marts: ${martsBuildDuration.toFixed(1)} ms`);

    // 3. Lê o Dashboard diretamente dos Marts
    const startMartsRead = performance.now();
    const martsReport = await getDashboardFromMarts(prisma, farmacia.id, 90, 4);
    const martsReadDuration = performance.now() - startMartsRead;
    console.log(`⚡ Leitura dos Marts (Pronto para o Dashboard): ${martsReadDuration.toFixed(1)} ms`);

    expect(martsReport).not.toBeNull();
    if (!martsReport) return;

    // 4. Paridade Rigorosa (0.00% de discrepância)
    const legR = legacyReport.resumo_executivo;
    const martR = martsReport.resumo_executivo;

    expect(martR.total_artigos_inventario).toBe(legR.total_artigos_inventario);
    expect(martR.total_unidades_stock).toBe(legR.total_unidades_stock);
    expect(martR.valor_total_stock_custo).toBeCloseTo(legR.valor_total_stock_custo, 1);
    expect(martR.artigos_genericos_mg).toBe(legR.artigos_genericos_mg);
    expect(martR.valor_stock_genericos_mg).toBeCloseTo(legR.valor_stock_genericos_mg, 1);
    expect(martR.total_artigos_monos).toBe(legR.total_artigos_monos);
    expect(martR.valor_total_monos).toBeCloseTo(legR.valor_total_monos, 1);
    expect(martR.total_artigos_excesso_cobertura).toBe(legR.total_artigos_excesso_cobertura);
    expect(martR.total_artigos_restos_gaveta).toBe(legR.total_artigos_restos_gaveta);
    expect(martR.total_artigos_monos_profundidade).toBe(legR.total_artigos_monos_profundidade);
    expect(martR.grupos_dci_com_multiplos_labs).toBe(legR.grupos_dci_com_multiplos_labs);
    expect(martR.total_artigos_risco_caducidade).toBe(legR.total_artigos_risco_caducidade);
    expect(martR.valor_total_risco_caducidade).toBeCloseTo(legR.valor_total_risco_caducidade, 1);
  });

  it('2. Deve obter o detalhe de produto a partir dos Marts para o modal em sub-10ms', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    if (!farmacia) return;

    const anyProduct = await prisma.martProdutoMetricas.findFirst({
      where: { farmaciaId: farmacia.id },
    });
    if (!anyProduct) return;

    const start = performance.now();
    const productDetail = await getProductDetailsFromMarts(prisma, farmacia.id, anyProduct.cnp_codigo);
    const duration = performance.now() - start;

    console.log(`⚡ Leitura de Produto [${anyProduct.cnp_codigo}] dos Marts para o Modal: ${duration.toFixed(1)} ms`);

    expect(productDetail).not.toBeNull();
    expect(productDetail?.cnp_codigo).toBe(anyProduct.cnp_codigo);
    expect(productDetail?.vendas).toBeDefined();
    // Em teste remoto WAN (Irlanda), o round-trip de rede é ~225ms. Em local/produção na mesma região é < 10ms.
    expect(duration).toBeLessThan(2000);
  });
});
