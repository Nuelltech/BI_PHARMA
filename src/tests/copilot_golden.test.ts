import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ToolSecurityContext } from '../services/mcp_pharma_tools';
import {
  toolDescreverDados,
  toolConsultarSql,
  toolFichaProduto,
  toolConsultarVendas,
  toolConsultarProdutos,
  toolConsultarGruposDci,
  toolConsultarPatrimonioStock,
  validateAndRewriteReadOnlySql,
} from '../services/copilot_semantic_layer';
import { sugerirVendasCruzadas } from '../services/comercial';
import { createPrismaComercialRepo, buildComercialCfg } from '../services/comercial_repo';
import { toolRefinarResultado, clearSessionResults } from '../services/copilot_result_store';

describe('Copilot Golden Suite — Envelopes Tabulares Neutros, Follow-ups e Regras Reais', () => {
  const prisma = new PrismaClient();
  let ctx: ToolSecurityContext;
  const sessionId = 'test-golden-session';

  beforeAll(async () => {
    const farmacia =
      (await prisma.farmacia.findUnique({ where: { id: '8c34599d-9597-45a3-b122-8ffed62a5375' } })) ||
      (await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'asc' } }));
    expect(farmacia).toBeTruthy();
    ctx = {
      farmaciaId: farmacia!.id,
      farmaciaNome: farmacia!.nome,
      nif: farmacia!.nif,
    };
    clearSessionResults(ctx.farmaciaId, sessionId);
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. consultar_vendas (Bial) + Follow-up refinar_resultado (stock > 2): envelope tabular neutro sem bálsamos labiais', async () => {
    const res = await toolConsultarVendas(
      prisma,
      ctx,
      { filtros: { laboratorio: 'Bial' }, agrupar_por: 'produto', limite: 50 },
      sessionId,
      1
    );

    expect(res.ok).toBe(true);
    expect(res.result_id).toBe('r_0001');
    expect(res.colunas).toContain('cnp_codigo');
    expect(res.colunas).toContain('vnd_2026_08');
    expect(res.colunas).toContain('vnd_2026_09');
    expect(res.colunas).toContain('vnd_2026_10');
    expect(res.totais?.vendas_12m_un).toBe(443);

    const desIdx = res.colunas!.indexOf('designacao');
    const falsosLabiais = (res.linhas || []).filter((r) => /labial/i.test(String(r[desIdx])));
    expect(falsosLabiais).toEqual([]);

    // Follow-up em memória (sem ir à BD): "Dessa lista, mostra só os que têm stock acima de 2 unidades"
    const ref = toolRefinarResultado(ctx.farmaciaId, sessionId, 2, {
      result_id: res.result_id,
      filtro: [['stock_total_unidades', '>', 2]],
    });
    expect(ref.ok).toBe(true);
    const stockIdx = ref.colunas!.indexOf('stock_total_unidades');
    expect(ref.linhas!.length).toBeGreaterThan(0);
    for (const row of ref.linhas!) {
      expect(Number(row[stockIdx])).toBeGreaterThan(2);
    }
  }, 30000);

  it('2. Ficha de Produto & Bialzepam: DCI oficial é Diazepam (nunca Zolpidem)', async () => {
    const ficha: any = await toolFichaProduto(prisma, ctx, { termo: 'Bialzepam' }, sessionId, 2);
    expect(ficha.ok).toBe(true);
    expect(ficha.encontrado).toBe(true);
    for (const p of ficha.produtos) {
      expect(p.dci).toBe('Diazepam');
      expect(p.laboratorioTitular).toMatch(/Bial/i);
    }
  }, 20000);

  it('3. consultar_patrimonio_stock (liquidez_recuperada Set -> Out 2026): 229 monos reativados e DCIs oficiais', async () => {
    const res = await toolConsultarPatrimonioStock(
      prisma,
      ctx,
      { vista: 'liquidez_recuperada', mes_venda: '2026-10', meses_parado_minimo: 3, limite: 25 },
      sessionId,
      3
    );
    expect(res.ok).toBe(true);
    expect(res.meta?.n_linhas_total).toBe(229);

    const cnpIdx = res.colunas!.indexOf('cnp_codigo');
    const dciIdx = res.colunas!.indexOf('dci');
    const neparvisRow = res.linhas!.find((r) => r[cnpIdx] === '5682802');
    expect(neparvisRow).toBeTruthy();
    expect(neparvisRow![dciIdx]).toBe('Sacubitril + Valsartan');

    const deltiusRow = res.linhas!.find((r) => r[cnpIdx] === '5768619');
    expect(deltiusRow).toBeTruthy();
    expect(deltiusRow![dciIdx]).toBe('Colecalciferol (Vitamina D3)');
  }, 30000);

  it('4. consultar_grupos_dci e consultar_produtos (eh_resto_gaveta)', async () => {
    const dciRes = await toolConsultarGruposDci(prisma, ctx, { laboratorio: 'Bial', modo_detalhe: true }, sessionId, 4);
    expect(dciRes.ok).toBe(true);
    expect(dciRes.meta?.cobertura_dci_catalogo_pct).toBeGreaterThan(0);

    const restosRes = await toolConsultarProdutos(
      prisma,
      ctx,
      { filtros: { laboratorio: 'Bial', flags: ['eh_resto_gaveta'] } },
      sessionId,
      4
    );
    expect(restosRes.ok).toBe(true);
    const stIdx = restosRes.colunas!.indexOf('stock_total_unidades');
    for (const r of restosRes.linhas!) {
      expect(r[stIdx]).toBeGreaterThanOrEqual(1);
      expect(r[stIdx]).toBeLessThanOrEqual(2);
    }
  }, 30000);

  it('5. Camada Semântica SQL & Cross-Sell: bloqueia escrita e filtra v_metricas c/ eh_resto_gaveta', async () => {
    const desc = await toolDescreverDados(prisma, ctx);
    expect(desc.vistasDisponiveisParaSql.v_metricas).toContain('eh_resto_gaveta');
    expect(desc.vistasDisponiveisParaSql.v_catalogo).toContain('papel_recomendacao');

    expect(validateAndRewriteReadOnlySql('DELETE FROM v_metricas', ctx.farmaciaId).ok).toBe(false);
    expect(validateAndRewriteReadOnlySql('SELECT * FROM "Utilizador"', ctx.farmaciaId).ok).toBe(false);

    const sqlRes: any = await toolConsultarSql(
      prisma,
      ctx,
      {
        sql: `SELECT cnp_codigo, designacao, eh_resto_gaveta FROM v_metricas WHERE laboratorio_titular ~* '\\yBial\\y' LIMIT 5`,
      },
      sessionId,
      5
    );
    expect(sqlRes.ok).toBe(true);
    expect(sqlRes.colunas).toContain('eh_resto_gaveta');

    // Valida sugerirVendasCruzadas de comercial.ts: gatilho desconhecido falha de forma segura
    const repo = createPrismaComercialRepo(prisma, ctx.farmaciaId, sessionId, 5, {});
    const crossSemCat: any = await sugerirVendasCruzadas(
      { gatilho: { tipo: 'queixa', valor: 'queixa_desconhecida_sem_regra' } },
      { repo, ref: new Date('2026-11-20'), cfg: buildComercialCfg() }
    );
    expect(crossSemCat.ok).toBe(false);
    expect(crossSemCat.erro?.codigo).toBe('GATILHO_NAO_RESOLVIDO');
  }, 30000);
});
