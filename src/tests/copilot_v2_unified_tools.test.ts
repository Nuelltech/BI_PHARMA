import { describe, it, expect } from 'vitest';
import fs from 'fs';
import vm from 'vm';
import { PrismaClient } from '@prisma/client';
import {
  toolConsultarProdutosPorNomeOuCategoria,
  toolConsultarVendasPeriodo,
  toolAnalisarDesempenhoLaboratorio,
  toolFiltrarProdutosPorValidadeEMargem,
  toolIdentificarProdutosSemVenda,
  ToolSecurityContext,
} from '../services/mcp_pharma_tools';
import {
  classificarProdutoUnificado,
  calcularMargemComIva,
  fuzzyNameMatchScore,
  renderMarkdownTableFromStoredResult,
} from '../services/pharma_tool_helpers';
import { calculateClaudeCostEur } from '../services/copilot_engine';
import { validateAgentV2Response } from '../services/copilot_agent_v2';
import {
  calcularEstadosProduto,
  calcularTaxaIva,
  dataEfetivaUltimaVenda,
} from '../services/metricas';

const prisma = new PrismaClient();
const FARMACIA_A_ID = '3ac42c32-87a8-4afe-98cc-4ca61ac64aca';
const FARMACIA_C_ID = '594bdf27-151b-49f7-be71-18660b745d84';

describe('Copilot v2 & Camada Única de Ferramentas (Passo 1)', () => {
  it('1. Correção 1: produto com 0 vendas ou VMM < 1 não-crónico devolve TRABALHAR_ENCOMENDA (nunca REPOR)', () => {
    const semVendas = classificarProdutoUnificado({
      stock: 0,
      vmm: 0,
      vendas12m: 0,
      diasCobertura: 0,
      mesesCobertura: 0,
      tipoVenda: 'VENDA_LIVRE',
      designacao: 'Creme Teste',
      custoUnitario: 5,
      pvp: 12,
    });
    expect(semVendas.acao_sugerida).toBe('TRABALHAR_ENCOMENDA');
    expect(semVendas.situacao).toBe('SEM_STOCK_SEM_VENDAS');
    expect(semVendas.acoes_permitidas).not.toContain('REPOR');

    const baixaRot = classificarProdutoUnificado({
      stock: 0,
      vmm: 0.4,
      vendas12m: 5,
      diasCobertura: 0,
      mesesCobertura: 0,
      tipoVenda: 'VENDA_LIVRE',
      designacao: 'Spray Nasal Teste',
      custoUnitario: 4,
      pvp: 10,
    });
    expect(baixaRot.acao_sugerida).toBe('TRABALHAR_ENCOMENDA');
    expect(baixaRot.situacao).toBe('BAIXA_ROTACAO_SEM_STOCK');
  });

  it('2. Correções 2, 3 e 4: margem em € deduz IVA e faz fallback para ProdutoMestre.pvp', () => {
    const m = calcularMargemComIva({
      pvpFarmacia: null,
      pvpMestre: 12.3,
      custoUnitario: 6.0,
      taxaIva: 23,
      tipoVenda: 'VENDA_LIVRE',
    });
    expect(m.pvp_origem).toBe('PRODUTO_MESTRE');
    expect(m.taxa_iva_pct).toBe(23);
    expect(m.pvp_sem_iva_eur).toBe(10);
    expect(m.margem_unitaria_eur).toBe(4);
    expect(m.margem_pct).toBe(40);
  });

  it('3. Correção Rhinodouche (b): pesquisa aproximada e fonética (Rino-duche = Rhinodouche = Rhinodouch)', () => {
    expect(fuzzyNameMatchScore('Rino-duche', 'Rhinodouche Sal 26 Saquetas')).toBeGreaterThan(80);
    expect(fuzzyNameMatchScore('Rhinodouch', 'Rhinodouche Irrigador Nasal')).toBeGreaterThan(80);
    expect(fuzzyNameMatchScore('rhinodouche', 'RHINODOUCHE SAL 40 SAQ')).toBeGreaterThan(100);
  });

  it('4. Preços Haiku 5.5 e Sonnet 5.5 em calculateClaudeCostEur()', () => {
    // 1M input + 1M output + 1M cache read em Haiku 5.5 = ($0.10 + $0.50 + $0.01) * 0.92 = 0.5612
    const haikuCost = calculateClaudeCostEur('claude-haiku-5-5', 1_000_000, 1_000_000, 0, 1_000_000);
    expect(haikuCost).toBeCloseTo(0.5612, 3);
    // 1M input + 1M output + 1M cache read em Sonnet 5.5 = ($2.00 + $10.00 + $0.10) * 0.92 = 11.132
    const sonnetCost = calculateClaudeCostEur('claude-sonnet-5-5', 1_000_000, 1_000_000, 0, 1_000_000);
    expect(sonnetCost).toBeCloseTo(11.132, 3);
  });

  it('5. Rhinodouche na Farmácia C (Demo): encontra vendas históricas e catálogo mesmo com stock = 0', async () => {
    const ctxC: ToolSecurityContext = {
      farmaciaId: FARMACIA_C_ID,
      farmaciaNome: 'Farmácia C (Demo)',
      nif: '999999990',
      perfil: 'SUPERADMIN',
      verFaturacao: true,
    };

    const resExato: any = await toolConsultarProdutosPorNomeOuCategoria(prisma, ctxC, {
      termo_pesquisa: 'rhinodouche',
    });
    expect(resExato.totalArtigosEncontrados).toBeGreaterThan(0);
    expect(resExato.resultado_id).toBeTruthy();
    expect(resExato.dados_ate).toBeTruthy();
    const comVendas = (resExato.artigos || []).filter((a: any) => a.vendasHistoricoTotalUnidades > 0);
    expect(comVendas.length).toBeGreaterThan(0);
    expect(comVendas[0].origem_encontrada).toContain('vendas_historicas');
    expect(typeof comVendas[0].taxa_iva_pct).toBe('number');
    // Artigo 6391151 (última venda Dez/2022) tem de ter vendasAno12M === 0 e vendasHistoricoTotalUnidades === 11
    const art6391151 = (resExato.artigos || []).find((a: any) => a.cnp === '6391151');
    if (art6391151) {
      expect(art6391151.vendasAno12M).toBe(0);
      expect(art6391151.vendasHistoricoTotalUnidades).toBe(11);
      expect(art6391151.situacao).toBe('SEM_STOCK_SEM_VENDAS');
    }
    // Na Farmácia C (Demo): 6391169 (1 un em Mar/2026) + 6298752 (1 un em Abr/2026) = 2 un em 2026
    expect(resExato.resumoEncontrado.totalUnidadesVendidasAnoAtual).toBe(2);

    // Variante com hífen/fonética ("Rino-duche")
    const resFuzzy: any = await toolConsultarProdutosPorNomeOuCategoria(prisma, ctxC, {
      termo_pesquisa: 'Rino-duche',
    });
    expect(resFuzzy.totalArtigosEncontrados).toBeGreaterThan(0);
  }, 20000);

  it('6. Bial em 2026 na Farmácia A: consulta rápida via MartProdutoMes, sem falsos positivos Labialfarma e tabela por resultado_id', async () => {
    const ctxA: ToolSecurityContext = {
      farmaciaId: FARMACIA_A_ID,
      farmaciaNome: 'Farmácia A',
      nif: '505016419',
      perfil: 'SUPERADMIN',
      verFaturacao: true,
    };

    const t0 = Date.now();
    const resVendas: any = await toolConsultarVendasPeriodo(prisma, ctxA, {
      periodo: '2026',
      laboratorio: 'Bial',
      limite: 20,
    });
    const elapsedMs = Date.now() - t0;

    expect(elapsedMs).toBeLessThan(8000);
    expect(resVendas.resultado_id).toBeTruthy();
    expect(resVendas.dados_ate).toBeTruthy();
    expect(resVendas.resumo.totalReferenciasComVenda).toBeGreaterThan(0);

    // Nenhum falso positivo "Labialfarma"
    const falsosPositivos = (resVendas.artigos || []).filter((a: any) =>
      String(a.laboratorioTitular || '').toLowerCase().includes('labial')
    );
    expect(falsosPositivos.length).toBe(0);

    // Tabela determinística por referência (resultado_id)
    const tbl = renderMarkdownTableFromStoredResult(FARMACIA_A_ID, {
      resultado_id: resVendas.resultado_id,
      titulo: 'Top Bial 2026',
      colunas: ['cnp', 'designacao', 'unidadesVendidas', 'taxa_iva_pct', 'acao_sugerida'],
      limite: 10,
    });
    expect(tbl.ok).toBe(true);
    expect(tbl.rowCount).toBeGreaterThan(0);
    expect(tbl.markdown).toContain('| cnp | designacao |');

    // Isolamento multi-tenant: outra farmácia não pode ler o resultado_id da Farmácia A
    const tblCross = renderMarkdownTableFromStoredResult(FARMACIA_C_ID, {
      resultado_id: resVendas.resultado_id,
    });
    expect(tblCross.ok).toBe(false);

    // toolAnalisarDesempenhoLaboratorio também funciona com periodo="2026"
    const resLab: any = await toolAnalisarDesempenhoLaboratorio(prisma, ctxA, {
      nome_laboratorio: 'Bial',
      periodo: '2026',
    });
    expect(resLab.success).toBe(true);
    expect(resLab.resultado_id).toBeTruthy();
  }, 20000);

  it('7. P0 MCP: filtrar_produtos_por_validade_e_margem respeita filtros e MSRM nunca recebe ESCOAMENTO_BALCAO/PACK', async () => {
    const ctxA: ToolSecurityContext = {
      farmaciaId: FARMACIA_A_ID,
      farmaciaNome: 'Farmácia A',
      nif: '505016419',
      perfil: 'COMPLETO',
      verFaturacao: true,
    };
    const resVal: any = await toolFiltrarProdutosPorValidadeEMargem(prisma, ctxA, {
      meses_validade_max: 12,
      limite: 15,
    });
    expect(resVal.resultado_id).toBeTruthy();
    expect(resVal.dados_ate).toBeTruthy();
    expect(Array.isArray(resVal.artigos)).toBe(true);
    for (const a of resVal.artigos) {
      if (a.msrm) {
        expect(a.acoes_permitidas).not.toContain('ESCOAMENTO_BALCAO');
        expect(a.acao_sugerida).toBe('DEVOLVER_TUDO');
      }
    }

    const resMonos: any = await toolIdentificarProdutosSemVenda(prisma, ctxA, { limite: 20 });
    const monosList = resMonos.itens || [];
    for (const m of monosList) {
      if (String(m.segmento || '').toUpperCase().includes('MSRM')) {
        expect(m.acao_sugerida).not.toBe('ESCOAMENTO_BALCAO');
        expect(JSON.stringify(m)).not.toContain('PACK_PROMOCIONAL');
      }
    }
  }, 20000);

  it('8. Validação numérica (#25): deteta valores €, % e unidades inventados pelo modelo', () => {
    const fakeTools = [
      {
        name: 'consultar_produtos',
        input: { termo_pesquisa: 'rhinodouche' },
        result: {
          totalArtigosEncontrados: 5,
          resumoEncontrado: { totalUnidadesVendidasAnoAtual: 2, totalUnidadesVendidas12M: 2 },
          artigos: [
            { cnp: '6391169', vendasAno12M: 1, vendasHistoricoTotalEur: 125.0, margemComercialPct: 38.5 },
            { cnp: '6298752', vendasAno12M: 1, vendasHistoricoTotalEur: 21.8, margemComercialPct: 35.0 },
          ],
        },
      },
    ];
    // Resposta com números inventados ("7 un / 96,30 €") -> tem de falhar #25
    const badIssues = validateAgentV2Response(
      'Foram vendidas 7 unidades num total de 96,30 € nos últimos 12M com margem de 52,4%.',
      fakeTools
    );
    expect(badIssues.some((i) => i.includes('VALIDAÇÃO NUMÉRICA (#25)'))).toBe(true);
    expect(badIssues.join(' ')).toContain('96,30 €');
    expect(badIssues.join(' ')).toContain('7 un');

    // Resposta só com números reais dos dados -> 0 issues
    const goodIssues = validateAgentV2Response(
      'Foram vendidas 2 unidades nos últimos 12M; o histórico soma 125,00 € no 6391169 (margem 38,5%) e 21,80 € no 6298752.',
      fakeTools
    );
    expect(goodIssues.length).toBe(0);
  });

  it('9. Módulo único metricas.ts (Catálogo 2): cobertura null, última venda mensal = fim do mês, mono != excesso, IVA inferido (#27)', () => {
    const ivaInf = calcularTaxaIva(null, 'VENDA_LIVRE');
    expect(ivaInf).toEqual({ taxa_iva_pct: 23, taxa_iva_origem: 'INFERIDA' });
    const ivaOfic = calcularTaxaIva(6, 'MSRM');
    expect(ivaOfic).toEqual({ taxa_iva_pct: 6, taxa_iva_origem: 'OFICIAL' });

    const fimMes = dataEfetivaUltimaVenda(new Date('2026-10-01T00:00:00Z'), 'MENSAL');
    expect(fimMes.toISOString().slice(0, 10)).toBe('2026-10-31');

    // Mono sem vendas: cobertura_meses === null, eh_mono === true, eh_excesso_cobertura === false (P2 #16)
    const mono = calcularEstadosProduto({
      stockTotal: 5,
      vmm: 0,
      vendasUltimos90d: 0,
      ultimaVendaEfetiva: null,
      dataReferencia: new Date('2026-11-11T23:59:59Z'),
      custoUnitario: 10,
    });
    expect(mono.cobertura_meses).toBeNull();
    expect(mono.eh_mono).toBe(true);
    expect(mono.eh_excesso_cobertura).toBe(false);

    // Rutura com stock 0 e vendas nos últimos 90d (P0 #1)
    const rut = calcularEstadosProduto({
      stockTotal: 0,
      vmm: 3,
      vendasUltimos90d: 9,
      ultimaVendaEfetiva: new Date('2026-10-31T23:59:59Z'),
      dataReferencia: new Date('2026-11-11T23:59:59Z'),
    });
    expect(rut.eh_rutura).toBe(true);
    expect(rut.eh_mono).toBe(false);
  });

  it('10. Validação vm.Script de todos os blocos <script> inline em src/server.ts', () => {
    const src = fs.readFileSync('src/server.ts', 'utf8');
    const blocks = src.match(/<script>([\s\S]*?)<\/script>/g) || [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const code = block
        .replace(/^<script>|<\/script>$/g, '')
        .replace(/\\`/g, '`')
        .replace(/\\\$/g, '$');
      expect(() => new vm.Script(code)).not.toThrow();
    }
  });
});
