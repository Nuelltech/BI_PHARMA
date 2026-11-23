/**
 * BI PHARMA — Fase 2: Ferramenta Unificada `consulta_comercial`
 *
 * Parâmetros planos e simples (sem objetos aninhados).
 * Regras obrigatórias:
 *  - C2 (monos com janela livre): o modelo extrai quantidade+unidade ou data "desde";
 *    o código converte para dias (semana=7, mês=30, 3 meses=90, meio ano=180, 1 ano=365, desde X=dias até hoje).
 *  - Paridade exata com o painel: usa `analyzePharmacyInventory` para `foco = 'monos'`.
 *  - Proteção contra atraso de dados: se janela <= atraso (hoje vs última venda), não calcula e propõe alternativas.
 *  - Transparência: declara sempre a janela usada e a data da última venda registada.
 *  - Mesmo padrão da Fase 1: tabelas 100% geradas em código + `resumo_modelo` compacto com `destaques` + `result_ref`.
 */

import { PrismaClient } from '@prisma/client';
import { analyzePharmacyInventory } from './analysis';
import { ToolSecurityContext } from './mcp_pharma_tools';
import { canVerFaturacao } from '../platform/permissoes';
import { saveToolResult } from './copilot_result_store';
import { classifyProductAction, matchesLabFilter, checkMonthCompletenessD6 } from './copilot_semantic_layer';
import { isTherapeuticChronic } from './copilot_chronic_therapies';

export type ConsultaComercialFoco =
  | 'monos'
  | 'vendas'
  | 'comparacao_periodos'
  | 'recomendacao_encomenda'
  | 'stock_validades';

export interface ConsultaComercialArgs {
  foco: ConsultaComercialFoco;
  laboratorio?: string;
  dci?: string;
  categoria?: string;
  ultimos_n_meses?: number;
  periodo_inicio?: string; // YYYY-MM
  periodo_fim?: string; // YYYY-MM
  mes_atual?: string; // YYYY-MM
  mes_anterior?: string; // YYYY-MM
  direcao_variacao?: 'subiu' | 'desceu' | 'ambos';
  janela_mono_qtd?: number;
  janela_mono_unidade?: 'dias' | 'semanas' | 'meses' | 'anos' | 'meio_ano';
  janela_mono_desde?: string; // YYYY-MM-DD ou YYYY-MM
  janela_mono_dias?: number;
  limite?: number;
}

export interface JanelaMonosResolvida {
  dias: number;
  origem: 'padrao' | 'desde' | 'unidade' | 'dias_diretos';
  rotulo: string;
  desdeIso?: string;
  desdePt?: string;
  dataHojeIso: string;
  dataHojePt: string;
  dataUltimosDadosIso: string;
  dataUltimosDadosPt: string;
  atrasoDadosDias: number;
  bloqueado: boolean;
  aviso_markdown?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatDatePt(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseIsoUtc(iso: string): Date {
  const m = iso.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return new Date(iso);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = m[3] ? Number(m[3]) : 1;
  return new Date(Date.UTC(y, mo, d));
}

function diffDaysUtc(earlierIso: string, laterIso: string): number {
  const d1 = parseIsoUtc(earlierIso);
  const d2 = parseIsoUtc(laterIso);
  return Math.round((d2.getTime() - d1.getTime()) / (24 * 60 * 60 * 1000));
}

function fmtEur(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${Number(v).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function normalizeStr(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Converte de forma determinística a janela de monos (Regra C2) e verifica atraso de dados.
 */
export function resolveJanelaMonos(
  params: {
    janela_mono_qtd?: number;
    janela_mono_unidade?: 'dias' | 'semanas' | 'meses' | 'anos' | 'meio_ano';
    janela_mono_desde?: string;
    janela_mono_dias?: number;
  },
  dataHojeIso: string,
  dataUltimosDadosIso: string
): JanelaMonosResolvida {
  const dataHojePt = formatDatePt(dataHojeIso);
  const dataUltimosDadosPt = formatDatePt(dataUltimosDadosIso);
  const atrasoDadosDias = Math.max(0, diffDaysUtc(dataUltimosDadosIso, dataHojeIso));

  let dias = 90;
  let origem: JanelaMonosResolvida['origem'] = 'padrao';
  let rotulo = 'últimos 90 dias';
  let desdeIso: string | undefined;
  let desdePt: string | undefined;

  if (params.janela_mono_desde && params.janela_mono_desde.trim()) {
    const raw = params.janela_mono_desde.trim();
    const m = raw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (m) {
      desdeIso = `${m[1]}-${m[2]}-${m[3] || '01'}`;
      desdePt = formatDatePt(desdeIso);
      dias = Math.max(1, diffDaysUtc(desdeIso, dataHojeIso));
      origem = 'desde';
      rotulo = `desde ${desdePt} (${dias} dias)`;
    }
  } else if (params.janela_mono_unidade) {
    const u = params.janela_mono_unidade;
    const qtd = Number(params.janela_mono_qtd) > 0 ? Number(params.janela_mono_qtd) : 1;
    origem = 'unidade';
    if (u === 'meio_ano') {
      dias = 180;
      rotulo = 'últimos 180 dias (meio ano)';
    } else if (u === 'dias') {
      dias = Math.round(qtd);
      rotulo = `últimos ${dias} dias`;
    } else if (u === 'semanas') {
      dias = Math.round(qtd * 7);
      rotulo = `últimos ${dias} dias (${qtd} ${qtd === 1 ? 'semana' : 'semanas'})`;
    } else if (u === 'meses') {
      if (qtd === 3) dias = 90;
      else if (qtd === 6) dias = 180;
      else if (qtd === 12) dias = 365;
      else dias = Math.round(qtd * 30);
      rotulo = `últimos ${dias} dias (${qtd} ${qtd === 1 ? 'mês' : 'meses'})`;
    } else if (u === 'anos') {
      dias = Math.round(qtd * 365);
      rotulo = `últimos ${dias} dias (${qtd} ${qtd === 1 ? 'ano' : 'anos'})`;
    }
  } else if (params.janela_mono_dias && Number(params.janela_mono_dias) > 0) {
    dias = Math.round(Number(params.janela_mono_dias));
    origem = 'dias_diretos';
    rotulo = `últimos ${dias} dias`;
  }

  const bloqueado = dias <= atrasoDadosDias;
  let aviso_markdown: string | undefined;
  if (bloqueado) {
    aviso_markdown = [
      `⚠️ **Janela indisponível por atraso de dados**`,
      ``,
      `Não é possível calcular monos para os **${rotulo}** porque as vendas mais recentes carregadas na base de dados são de **${dataUltimosDadosPt}** (atraso de **${atrasoDadosDias} dias** face a ${dataHojePt}). Qualquer cálculo nessa janela incluiria todos os produtos em stock sem refletir vendas reais.`,
      ``,
      `**Alternativas disponíveis com os dados atuais (até ${dataUltimosDadosPt}):**`,
      `- **Monos dos últimos 90 dias** (regra padrão do painel)`,
      `- **Monos dos últimos 180 dias** (meio ano sem vendas)`,
      `- **Produtos sem vendas desde setembro de 2026** (desde 01-09-2026)`,
    ].join('\n');
  }

  return {
    dias,
    origem,
    rotulo,
    desdeIso,
    desdePt,
    dataHojeIso,
    dataHojePt,
    dataUltimosDadosIso,
    dataUltimosDadosPt,
    atrasoDadosDias,
    bloqueado,
    aviso_markdown,
  };
}

function getMonthEndIso(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return '2026-10-31';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(lastDay).padStart(2, '0')}`;
}

function prevMonthYm(ym: string, offset = 1): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return '2026-09';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 - offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function expandMonthsRange(startYm: string, endYm: string): string[] {
  const out: string[] = [];
  let cur = startYm;
  for (let i = 0; i < 36; i++) {
    out.push(cur);
    if (cur >= endYm) break;
    const m = cur.match(/^(\d{4})-(\d{2})$/);
    if (!m) break;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    cur = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return out;
}

async function getLatestSalesMonth(prisma: PrismaClient, farmaciaId: string): Promise<string> {
  const latest = await prisma.martProdutoMes.findFirst({
    where: { farmaciaId },
    orderBy: { mes: 'desc' },
    select: { mes: true },
  });
  if (latest?.mes && /^\d{4}-\d{2}/.test(String(latest.mes))) {
    return String(latest.mes).slice(0, 7);
  }
  return '2026-10';
}

/**
 * Executa a ferramenta unificada `consulta_comercial`.
 */
export async function toolConsultaComercial(
  prisma: PrismaClient,
  ctx: ToolSecurityContext,
  args: ConsultaComercialArgs,
  sessionId = 'default',
  turno = 1,
  dataHojeIso?: string
) {
  const allowEur = canVerFaturacao(ctx.perfil);
  const limite = Math.min(Math.max(Number(args.limite) || 15, 3), 50);
  const ultimoMesYm = await getLatestSalesMonth(prisma, ctx.farmaciaId);
  const hojeIso =
    dataHojeIso && /^\d{4}-\d{2}-\d{2}$/.test(dataHojeIso)
      ? dataHojeIso
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date());
  // Nunca apresentar uma data futura como "vendas registadas até": limitar sempre à data de hoje
  const rawMonthEndIso = getMonthEndIso(ultimoMesYm);
  const dataUltimosDadosIso = rawMonthEndIso > hojeIso ? hojeIso : rawMonthEndIso;
  const dataUltimosDadosPt = formatDatePt(dataUltimosDadosIso);

  // ==========================================================================
  // FOCO 1: MONOS (com janela livre C2 e paridade 100% com o painel)
  // ==========================================================================
  if (args.foco === 'monos') {
    const janela = resolveJanelaMonos(args, hojeIso, dataUltimosDadosIso);

    if (janela.bloqueado) {
      return {
        ok: true,
        foco: 'monos',
        bloqueado_atraso_dados: true,
        meta: {
          foco: 'monos',
          janela_dias: janela.dias,
          janela_rotulo: janela.rotulo,
          data_hoje: janela.dataHojeIso,
          data_referencia: janela.dataUltimosDadosIso,
          atraso_dados_dias: janela.atrasoDadosDias,
          faturacao_oculta: !allowEur,
        },
        aviso_markdown: janela.aviso_markdown,
        relatorio_markdown: janela.aviso_markdown,
        resumo_modelo: {
          bloqueado: true,
          motivo: `Janela de ${janela.dias} dias é inferior ou igual ao atraso dos dados (${janela.atrasoDadosDias} dias; vendas até ${janela.dataUltimosDadosPt}).`,
        },
      };
    }

    // Paridade exata com o painel:
    //  - Para a janela padrão de 90 dias, usa MartProdutoMetricas pré-calculado (< 0,3s em vez de 37s) com fallback para analyzePharmacyInventory.
    //  - Para outras janelas (180d, desde X, etc.), chama analyzePharmacyInventory(periodoMonosDias = janela.dias).
    const d6UltimoMes = await checkMonthCompletenessD6(prisma, ctx.farmaciaId, ultimoMesYm);

    let monosList: Array<{
      cnp_codigo: string;
      designacao: string;
      tipo_venda: string;
      stock_atual: number;
      capital_imobilizado: number;
      ultima_venda: string | null;
      data_validade: string | null;
      laboratorio_titular?: string | null;
      grupo_equivalencia_dci?: string | null;
      categoria?: string | null;
    }> = [];

    if (janela.dias === 90) {
      const martsMonos = await prisma.martProdutoMetricas.findMany({
        where: { farmaciaId: ctx.farmaciaId, eh_mono: true, stock_total_unidades: { gt: 0 } },
      });
      if (martsMonos.length > 0) {
        monosList = martsMonos.map((m) => ({
          cnp_codigo: m.cnp_codigo,
          designacao: m.designacao,
          tipo_venda: m.tipo_venda || 'VENDA_LIVRE',
          stock_atual: Number(m.stock_total_unidades || 0),
          capital_imobilizado: round2(Number(m.stock_total_valor_custo || 0)),
          ultima_venda: m.data_ultima_venda ? new Date(m.data_ultima_venda).toISOString().slice(0, 10) : null,
          data_validade: m.data_validade_mais_proxima ? new Date(m.data_validade_mais_proxima).toISOString().slice(0, 10) : null,
          laboratorio_titular: m.laboratorio_titular,
          grupo_equivalencia_dci: m.molecula_dci,
          categoria: m.categoria,
        }));
      }
    }

    if (monosList.length === 0) {
      const analysis = await analyzePharmacyInventory(prisma, ctx.farmaciaId, {
        periodoMonosDias: janela.dias,
        dataReferencia: parseIsoUtc(hojeIso),
      });
      monosList = analysis.monos || [];
    }
    const filtrosTexto: string[] = [];
    if (args.laboratorio) {
      const cnpsMonos = monosList.map((m) => m.cnp_codigo);
      const catMonos = cnpsMonos.length > 0
        ? await prisma.produtoMestre.findMany({
            where: { cnp_codigo: { in: cnpsMonos } },
            select: { cnp_codigo: true, laboratorio_titular: true },
          })
        : [];
      const catLabMap = new Map(catMonos.map((c) => [c.cnp_codigo, c.laboratorio_titular]));
      monosList = monosList.filter((m) =>
        matchesLabFilter(catLabMap.get(m.cnp_codigo) || m.laboratorio_titular, m.designacao, args.laboratorio!)
      );
      filtrosTexto.push(`Laboratório: ${args.laboratorio}`);
    }
    if (args.dci) {
      const q = normalizeStr(args.dci);
      monosList = monosList.filter(
        (m) => normalizeStr(m.grupo_equivalencia_dci).includes(q) || normalizeStr(m.designacao).includes(q)
      );
      filtrosTexto.push(`DCI: ${args.dci}`);
    }
    if (args.categoria) {
      const q = normalizeStr(args.categoria);
      monosList = monosList.filter((m) => normalizeStr(m.categoria).includes(q));
      filtrosTexto.push(`Categoria: ${args.categoria}`);
    }

    monosList = [...monosList].sort((a, b) => (b.capital_imobilizado || 0) - (a.capital_imobilizado || 0));

    const totalMonos = monosList.length;
    const totalUnidades = monosList.reduce((acc, m) => acc + (m.stock_atual || 0), 0);
    const totalValor = round2(monosList.reduce((acc, m) => acc + (m.capital_imobilizado || 0), 0));
    const nMsrm = monosList.filter((m) => m.tipo_venda === 'MSRM').length;
    const nNaoMsrm = totalMonos - nMsrm;
    const topSlice = monosList.slice(0, limite);

    const dadosRefRotulo = d6UltimoMes.incompleto
      ? `${d6UltimoMes.mesRotuloPt} (parcial; referência ${dataUltimosDadosPt})`
      : dataUltimosDadosPt;
    const notaJanela = janela.desdePt
      ? `sem vendas desde ${janela.desdePt} (${janela.dias} dias); vendas registadas até ${dadosRefRotulo}`
      : `sem vendas nos últimos ${janela.dias} dias; vendas registadas até ${dadosRefRotulo}`;

    const tituloFiltro = filtrosTexto.length > 0 ? ` (${filtrosTexto.join(' · ')})` : '';
    let md = `## Monos — ${janela.rotulo}${tituloFiltro}\n`;
    md += `**Critério aplicado:** ${notaJanela}\n\n`;
    if (d6UltimoMes.incompleto && d6UltimoMes.aviso) {
      md += `> ⚠️ **Nota de integridade dos dados (D6):** ${d6UltimoMes.aviso} Produtos vendidos no final desse mês podem constar temporariamente como parados.\n\n`;
    }
    md += `### Resumo\n`;
    md += `- **Total de monos:** ${totalMonos.toLocaleString('pt-PT')} ${totalMonos === 1 ? 'produto' : 'produtos'} (${totalUnidades.toLocaleString('pt-PT')} un em stock)\n`;
    if (allowEur) {
      md += `- **Capital imobilizado (preço de custo):** ${fmtEur(totalValor)}\n`;
    }
    md += `- **Composição legal:** ${nMsrm.toLocaleString('pt-PT')} MSRM | ${nNaoMsrm.toLocaleString('pt-PT')} MNSRM / Venda Livre\n\n`;

    if (topSlice.length > 0) {
      md += `### Top ${topSlice.length} Monos por Capital Imobilizado\n\n`;
      if (allowEur) {
        md += `| CNP | Designação | Tipo | Stock | Capital Imobilizado | Última Venda | Validade |\n`;
        md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n`;
        for (const m of topSlice) {
          md += `| ${m.cnp_codigo} | ${m.designacao.slice(0, 46)} | ${m.tipo_venda} | ${m.stock_atual} | ${fmtEur(m.capital_imobilizado)} | ${m.ultima_venda || 'Sem registo'} | ${m.data_validade || '—'} |\n`;
        }
      } else {
        md += `| CNP | Designação | Tipo | Stock | Última Venda | Validade |\n`;
        md += `| :--- | :--- | :---: | :---: | :---: | :---: |\n`;
        for (const m of topSlice) {
          md += `| ${m.cnp_codigo} | ${m.designacao.slice(0, 46)} | ${m.tipo_venda} | ${m.stock_atual} | ${m.ultima_venda || 'Sem registo'} | ${m.data_validade || '—'} |\n`;
        }
      }
      md += `\n`;
    }

    const stored = saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consulta_comercial',
      input: args,
      meta: { foco: 'monos', janela_dias: janela.dias, data_referencia: dataUltimosDadosIso },
      colunas: ['cnp', 'designacao', 'tipo_venda', 'stock', 'capital_imobilizado', 'ultima_venda'],
      linhas: topSlice.map((m) => [
        m.cnp_codigo,
        m.designacao,
        m.tipo_venda,
        m.stock_atual,
        allowEur ? m.capital_imobilizado : null,
        m.ultima_venda || '',
      ]),
      totais: { total_monos: totalMonos, total_unidades: totalUnidades, valor_imobilizado_eur: allowEur ? totalValor : null },
      limiteModelo: limite,
    });

    const top1 = topSlice[0] || null;
    return {
      ok: true,
      foco: 'monos',
      result_ref: stored.result_id,
      meta: {
        foco: 'monos',
        janela_dias: janela.dias,
        janela_rotulo: janela.rotulo,
        nota_janela: notaJanela,
        data_referencia: dataUltimosDadosIso,
        faturacao_oculta: !allowEur,
      },
      totais: {
        total_monos: totalMonos,
        total_unidades: totalUnidades,
        valor_imobilizado_eur: allowEur ? totalValor : null,
        n_msrm: nMsrm,
        n_nao_msrm: nNaoMsrm,
      },
      todos_produtos_indice: topSlice.map((m) => ({
        cnp: m.cnp_codigo,
        designacao: m.designacao,
        tipo_venda: m.tipo_venda,
        eh_terapeutica_cronica: isTherapeuticChronic(m.grupo_equivalencia_dci || m.designacao),
        classificacao: m.tipo_venda === 'MSRM' ? 'DEVOLVER_TUDO' : 'ESCOAMENTO_BALCAO',
      })),
      relatorio_markdown: md,
      resumo_modelo: {
        meta: { foco: 'monos', criterio: notaJanela },
        totais: {
          total_monos: totalMonos,
          total_unidades: totalUnidades,
          ...(allowEur ? { valor_imobilizado_eur: totalValor } : {}),
          n_msrm: nMsrm,
          n_nao_msrm: nNaoMsrm,
        },
        destaques: {
          maior_imobilizado: top1
            ? {
                nome: top1.designacao.slice(0, 48),
                cnp: top1.cnp_codigo,
                tipo_venda: top1.tipo_venda,
                stock: top1.stock_atual,
                ...(allowEur ? { capital_imobilizado_eur: top1.capital_imobilizado } : {}),
              }
            : null,
        },
        instrucao:
          'Escreve 2 frases corridas em texto simples: refere o critério da janela usada, o total de monos e destaca o artigo de maior capital imobilizado. Nunca recomendes escoamento ou promoção em balcão para produtos MSRM. Não faças cálculos nem tabelas.',
      },
    };
  }

  // ==========================================================================
  // FOCO 2: COMPARAÇÃO DE PERÍODOS (ex.: outubro vs setembro, o que subiu)
  // ==========================================================================
  if (args.foco === 'comparacao_periodos') {
    const mesAtualYm = args.mes_atual && /^\d{4}-\d{2}$/.test(args.mes_atual) ? args.mes_atual : ultimoMesYm;
    const mesAnteriorYm =
      args.mes_anterior && /^\d{4}-\d{2}$/.test(args.mes_anterior) ? args.mes_anterior : prevMonthYm(mesAtualYm, 1);
    const direcao = args.direcao_variacao || 'subiu';

    // Regra D6: verificar se algum dos meses comparados tem volume anormal (< 70 % da média dos 3 meses anteriores)
    const [d6Atual, d6Ant] = await Promise.all([
      checkMonthCompletenessD6(prisma, ctx.farmaciaId, mesAtualYm),
      checkMonthCompletenessD6(prisma, ctx.farmaciaId, mesAnteriorYm),
    ]);
    const d6Falha = d6Atual.incompleto ? d6Atual : d6Ant.incompleto ? d6Ant : null;
    if (d6Falha && d6Falha.aviso) {
      const altMesAtual = d6Atual.incompleto ? prevMonthYm(mesAtualYm, 1) : mesAtualYm;
      const altMesAnt = prevMonthYm(altMesAtual, 1);
      const avisoMd = [
        `⚠️ **Dados potencialmente incompletos (Regra D6)**`,
        ``,
        `${d6Falha.aviso}`,
        ``,
        `Por este motivo, a comparação direta **${mesAtualYm} vs ${mesAnteriorYm}** não deve ser apresentada como uma variação real de vendas.`,
        ``,
        `Pretende comparar **${altMesAtual} vs ${altMesAnt}** (dois meses completos) ou escolher outro período?`,
      ].join('\n');

      return {
        ok: true,
        foco: 'comparacao_periodos',
        bloqueado_atraso_dados: true,
        bloqueado_dados_incompletos_d6: true,
        meta: {
          foco: 'comparacao_periodos',
          mes_atual: mesAtualYm,
          mes_anterior: mesAnteriorYm,
          data_referencia: dataUltimosDadosIso,
          d6: d6Falha,
          faturacao_oculta: !allowEur,
        },
        aviso_markdown: avisoMd,
        relatorio_markdown: avisoMd,
        resumo_modelo: {
          bloqueado: true,
          regra: 'D6',
          motivo: d6Falha.aviso,
        },
      };
    }

    const rows = await prisma.martProdutoMes.findMany({
      where: {
        farmaciaId: ctx.farmaciaId,
        mes: { in: [mesAtualYm, mesAnteriorYm] },
      },
    });

    const cnps = Array.from(new Set(rows.map((r) => r.cnp_codigo)));
    const [catalogo, metricas] = await Promise.all([
      cnps.length > 0
        ? prisma.produtoMestre.findMany({
            where: { cnp_codigo: { in: cnps } },
            select: {
              cnp_codigo: true,
              designacao: true,
              laboratorio_titular: true,
              dci: true,
              categoria: true,
              tipo_venda: true,
            },
          })
        : Promise.resolve([]),
      cnps.length > 0
        ? prisma.martProdutoMetricas.findMany({
            where: { farmaciaId: ctx.farmaciaId, cnp_codigo: { in: cnps } },
            select: {
              cnp_codigo: true,
              designacao: true,
              laboratorio_titular: true,
              molecula_dci: true,
              categoria: true,
              tipo_venda: true,
              stock_total_unidades: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const catMap = new Map(catalogo.map((c) => [c.cnp_codigo, c]));
    const metMap = new Map(metricas.map((m) => [m.cnp_codigo, m]));

    const agg = new Map<
      string,
      {
        cnp: string;
        designacao: string;
        laboratorio: string;
        dci: string;
        categoria: string;
        tipo_venda: string;
        stock: number;
        atual_un: number;
        atual_eur: number;
        ant_un: number;
        ant_eur: number;
      }
    >();

    for (const r of rows) {
      const catRec = catMap.get(r.cnp_codigo);
      const m = metMap.get(r.cnp_codigo);
      const des = catRec?.designacao || m?.designacao || r.cnp_codigo;
      const lab = catRec?.laboratorio_titular || m?.laboratorio_titular || '';
      const dci = catRec?.dci || m?.molecula_dci || '';
      const cat = catRec?.categoria || m?.categoria || '';

      if (args.laboratorio && !matchesLabFilter(lab, des, args.laboratorio)) continue;
      if (args.dci && !normalizeStr(dci).includes(normalizeStr(args.dci)) && !normalizeStr(des).includes(normalizeStr(args.dci)))
        continue;
      if (args.categoria && !normalizeStr(cat).includes(normalizeStr(args.categoria))) continue;

      const cur = agg.get(r.cnp_codigo) || {
        cnp: r.cnp_codigo,
        designacao: des,
        laboratorio: lab,
        dci,
        categoria: cat,
        tipo_venda: m?.tipo_venda || 'VENDA_LIVRE',
        stock: Number(m?.stock_total_unidades || 0),
        atual_un: 0,
        atual_eur: 0,
        ant_un: 0,
        ant_eur: 0,
      };
      const rowYm = String(r.mes).slice(0, 7);
      if (rowYm === mesAtualYm) {
        cur.atual_un += Number(r.quantidade || 0);
        cur.atual_eur += Number(r.valor_total || 0);
      } else if (rowYm === mesAnteriorYm) {
        cur.ant_un += Number(r.quantidade || 0);
        cur.ant_eur += Number(r.valor_total || 0);
      }
      agg.set(r.cnp_codigo, cur);
    }

    const items = Array.from(agg.values()).map((it) => {
      const delta_eur = round2(it.atual_eur - it.ant_eur);
      const delta_un = it.atual_un - it.ant_un;
      const variacao_pct = it.ant_eur > 0 ? round2(((it.atual_eur - it.ant_eur) / it.ant_eur) * 100) : null;
      return { ...it, atual_eur: round2(it.atual_eur), ant_eur: round2(it.ant_eur), delta_eur, delta_un, variacao_pct };
    });

    const totalAtualEur = round2(items.reduce((s, i) => s + i.atual_eur, 0));
    const totalAntEur = round2(items.reduce((s, i) => s + i.ant_eur, 0));
    const deltaTotalEur = round2(totalAtualEur - totalAntEur);
    const deltaTotalPct = totalAntEur > 0 ? round2(((totalAtualEur - totalAntEur) / totalAntEur) * 100) : null;
    const totalAtualUn = items.reduce((s, i) => s + i.atual_un, 0);
    const totalAntUn = items.reduce((s, i) => s + i.ant_un, 0);
    const deltaTotalUn = totalAtualUn - totalAntUn;

    const subidas = items.filter((i) => (allowEur ? i.delta_eur > 0 : i.delta_un > 0)).sort((a, b) => (allowEur ? b.delta_eur - a.delta_eur : b.delta_un - a.delta_un));
    const descidas = items.filter((i) => (allowEur ? i.delta_eur < 0 : i.delta_un < 0)).sort((a, b) => (allowEur ? a.delta_eur - b.delta_eur : a.delta_un - b.delta_un));

    const listaPrincipal = direcao === 'desceu' ? descidas.slice(0, limite) : subidas.slice(0, limite);
    const rotuloDir = direcao === 'desceu' ? 'Maiores Quedas' : 'Maiores Subidas';

    let md = `## Comparação de Vendas — ${mesAtualYm} vs ${mesAnteriorYm}\n`;
    md += `**Vendas registadas até:** ${dataUltimosDadosPt}\n\n`;
    md += `### Resumo Global\n`;
    if (allowEur) {
      const sinal = deltaTotalEur >= 0 ? '+' : '';
      const pctStr = deltaTotalPct !== null ? ` (${sinal}${deltaTotalPct.toFixed(1)}%)` : '';
      md += `- **Faturação ${mesAtualYm}:** ${fmtEur(totalAtualEur)} vs **${mesAnteriorYm}:** ${fmtEur(totalAntEur)} → **Variação:** ${sinal}${fmtEur(deltaTotalEur)}${pctStr}\n`;
    }
    const sinalUn = deltaTotalUn >= 0 ? '+' : '';
    md += `- **Unidades ${mesAtualYm}:** ${totalAtualUn.toLocaleString('pt-PT')} un vs **${mesAnteriorYm}:** ${totalAntUn.toLocaleString('pt-PT')} un → **Variação:** ${sinalUn}${deltaTotalUn.toLocaleString('pt-PT')} un\n`;
    md += `- **Produtos que subiram:** ${subidas.length} | **Produtos que desceram:** ${descidas.length}\n\n`;

    if (listaPrincipal.length > 0) {
      md += `### Top ${listaPrincipal.length} — ${rotuloDir}\n\n`;
      if (allowEur) {
        md += `| CNP | Designação | ${mesAnteriorYm} (€) | ${mesAtualYm} (€) | Variação (€) | Var. Un | Stock |\n`;
        md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n`;
        for (const p of listaPrincipal) {
          const sE = p.delta_eur >= 0 ? '+' : '';
          const sU = p.delta_un >= 0 ? '+' : '';
          md += `| ${p.cnp} | ${p.designacao.slice(0, 44)} | ${fmtEur(p.ant_eur)} | ${fmtEur(p.atual_eur)} | **${sE}${fmtEur(p.delta_eur)}** | ${sU}${p.delta_un} | ${p.stock} |\n`;
        }
      } else {
        md += `| CNP | Designação | ${mesAnteriorYm} (un) | ${mesAtualYm} (un) | Variação (un) | Stock |\n`;
        md += `| :--- | :--- | :---: | :---: | :---: | :---: |\n`;
        for (const p of listaPrincipal) {
          const sU = p.delta_un >= 0 ? '+' : '';
          md += `| ${p.cnp} | ${p.designacao.slice(0, 44)} | ${p.ant_un} | ${p.atual_un} | **${sU}${p.delta_un}** | ${p.stock} |\n`;
        }
      }
      md += `\n`;
    }

    const stored = saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consulta_comercial',
      input: args,
      meta: { foco: 'comparacao_periodos', mes_atual: mesAtualYm, mes_anterior: mesAnteriorYm },
      colunas: ['cnp', 'designacao', 'ant_eur', 'atual_eur', 'delta_eur', 'delta_un', 'stock'],
      linhas: listaPrincipal.map((p) => [
        p.cnp,
        p.designacao,
        allowEur ? p.ant_eur : null,
        allowEur ? p.atual_eur : null,
        allowEur ? p.delta_eur : null,
        p.delta_un,
        p.stock,
      ]),
      totais: { total_atual_eur: allowEur ? totalAtualEur : null, total_anterior_eur: allowEur ? totalAntEur : null, delta_eur: allowEur ? deltaTotalEur : null, delta_un: deltaTotalUn },
      limiteModelo: limite,
    });

    const topSubida = subidas[0] || null;
    return {
      ok: true,
      foco: 'comparacao_periodos',
      result_ref: stored.result_id,
      meta: {
        foco: 'comparacao_periodos',
        mes_atual: mesAtualYm,
        mes_anterior: mesAnteriorYm,
        direcao,
        data_referencia: dataUltimosDadosIso,
        faturacao_oculta: !allowEur,
      },
      totais: {
        total_atual_eur: allowEur ? totalAtualEur : null,
        total_anterior_eur: allowEur ? totalAntEur : null,
        delta_eur: allowEur ? deltaTotalEur : null,
        delta_pct: allowEur ? deltaTotalPct : null,
        total_atual_un: totalAtualUn,
        total_anterior_un: totalAntUn,
        delta_un: deltaTotalUn,
        n_subidas: subidas.length,
        n_descidas: descidas.length,
      },
      todos_produtos_indice: listaPrincipal.map((p) => ({
        cnp: p.cnp,
        designacao: p.designacao,
        tipo_venda: p.tipo_venda,
        eh_terapeutica_cronica: isTherapeuticChronic(p.dci || p.designacao),
        classificacao: 'MANTER',
      })),
      relatorio_markdown: md,
      resumo_modelo: {
        meta: { mes_atual: mesAtualYm, mes_anterior: mesAnteriorYm, dados_ate: dataUltimosDadosPt },
        totais: {
          ...(allowEur ? { total_atual_eur: totalAtualEur, total_anterior_eur: totalAntEur, delta_eur: deltaTotalEur, delta_pct: deltaTotalPct } : {}),
          total_atual_un: totalAtualUn,
          total_anterior_un: totalAntUn,
          delta_un: deltaTotalUn,
        },
        destaques: {
          maior_subida: topSubida
            ? {
                nome: topSubida.designacao.slice(0, 48),
                cnp: topSubida.cnp,
                ...(allowEur ? { delta_eur: topSubida.delta_eur, atual_eur: topSubida.atual_eur } : {}),
                delta_un: topSubida.delta_un,
              }
            : null,
        },
        instrucao:
          'Escreve 2 frases corridas em texto simples resumindo a variação global entre os dois meses e destacando o produto com maior variação. Não somes, não calcules, não escrevas tabelas.',
      },
    };
  }

  // ==========================================================================
  // FOCO 3: VENDAS POR PERÍODO (ex.: vendas da Bial nos últimos 3 meses)
  // ==========================================================================
  if (args.foco === 'vendas') {
    let mesesYm: string[];
    if (args.ultimos_n_meses && Number(args.ultimos_n_meses) > 0) {
      const n = Math.min(24, Math.max(1, Math.round(Number(args.ultimos_n_meses))));
      const inicio = prevMonthYm(ultimoMesYm, n - 1);
      mesesYm = expandMonthsRange(inicio, ultimoMesYm);
    } else if (args.periodo_inicio && args.periodo_fim) {
      mesesYm = expandMonthsRange(args.periodo_inicio, args.periodo_fim);
    } else {
      mesesYm = expandMonthsRange(`${ultimoMesYm.slice(0, 4)}-01`, ultimoMesYm);
    }

    const rows = await prisma.martProdutoMes.findMany({
      where: {
        farmaciaId: ctx.farmaciaId,
        mes: { in: mesesYm },
      },
    });

    const cnps = Array.from(new Set(rows.map((r) => r.cnp_codigo)));
    const [catalogo, metricas, d6UltimoMes] = await Promise.all([
      cnps.length > 0
        ? prisma.produtoMestre.findMany({
            where: { cnp_codigo: { in: cnps } },
            select: {
              cnp_codigo: true,
              designacao: true,
              laboratorio_titular: true,
              dci: true,
              categoria: true,
              tipo_venda: true,
            },
          })
        : Promise.resolve([]),
      cnps.length > 0
        ? prisma.martProdutoMetricas.findMany({
            where: { farmaciaId: ctx.farmaciaId, cnp_codigo: { in: cnps } },
            select: {
              cnp_codigo: true,
              designacao: true,
              laboratorio_titular: true,
              molecula_dci: true,
              categoria: true,
              tipo_venda: true,
              stock_total_unidades: true,
              vmm: true,
              margem_padrao: true,
            },
          })
        : Promise.resolve([]),
      mesesYm.includes(ultimoMesYm)
        ? checkMonthCompletenessD6(prisma, ctx.farmaciaId, ultimoMesYm)
        : Promise.resolve(null),
    ]);
    const catMap = new Map(catalogo.map((c) => [c.cnp_codigo, c]));
    const metMap = new Map(metricas.map((m) => [m.cnp_codigo, m]));

    const porProd = new Map<
      string,
      {
        cnp: string;
        designacao: string;
        dci: string;
        tipo_venda: string;
        vendas_un: number;
        vendas_eur: number;
        stock: number;
        vmm: number;
        margem_pct: number | null;
      }
    >();
    const porMes = new Map<string, { ym: string; un: number; eur: number }>();
    for (const ym of mesesYm) porMes.set(ym, { ym, un: 0, eur: 0 });

    for (const r of rows) {
      const catRec = catMap.get(r.cnp_codigo);
      const m = metMap.get(r.cnp_codigo);
      const des = catRec?.designacao || m?.designacao || r.cnp_codigo;
      const lab = catRec?.laboratorio_titular || m?.laboratorio_titular || '';
      const dci = catRec?.dci || m?.molecula_dci || '';
      const cat = catRec?.categoria || m?.categoria || '';

      if (args.laboratorio && !matchesLabFilter(lab, des, args.laboratorio)) continue;
      if (args.dci && !normalizeStr(dci).includes(normalizeStr(args.dci)) && !normalizeStr(des).includes(normalizeStr(args.dci)))
        continue;
      if (args.categoria && !normalizeStr(cat).includes(normalizeStr(args.categoria))) continue;

      const ym = String(r.mes).slice(0, 7);
      const pm = porMes.get(ym);
      if (pm) {
        pm.un += Number(r.quantidade || 0);
        pm.eur = round2(pm.eur + Number(r.valor_total || 0));
      }

      const cur = porProd.get(r.cnp_codigo) || {
        cnp: r.cnp_codigo,
        designacao: des,
        dci,
        tipo_venda: m?.tipo_venda || 'VENDA_LIVRE',
        vendas_un: 0,
        vendas_eur: 0,
        stock: Number(m?.stock_total_unidades || 0),
        vmm: round2(Number(m?.vmm || 0)),
        margem_pct: m?.margem_padrao !== null && m?.margem_padrao !== undefined ? round2(Number(m.margem_padrao)) : null,
      };
      cur.vendas_un += Number(r.quantidade || 0);
      cur.vendas_eur = round2(cur.vendas_eur + Number(r.valor_total || 0));
      porProd.set(r.cnp_codigo, cur);
    }

    const produtos = Array.from(porProd.values()).sort((a, b) => (allowEur ? b.vendas_eur - a.vendas_eur : b.vendas_un - a.vendas_un));
    const totalEur = round2(produtos.reduce((s, p) => s + p.vendas_eur, 0));
    const totalUn = produtos.reduce((s, p) => s + p.vendas_un, 0);
    const topSlice = produtos.slice(0, limite);
    const periodoRotulo = `${mesesYm[0]} a ${mesesYm[mesesYm.length - 1]} (${mesesYm.length} ${mesesYm.length === 1 ? 'mês' : 'meses'})`;
    const tituloFiltro = args.laboratorio || args.dci || args.categoria || 'Farmácia';

    let md = `## Vendas — ${tituloFiltro} (${periodoRotulo})\n`;
    md += `**Vendas registadas até:** ${dataUltimosDadosPt}\n\n`;
    if (d6UltimoMes?.incompleto && d6UltimoMes.aviso) {
      md += `> ⚠️ **Nota de integridade dos dados (D6):** ${d6UltimoMes.aviso}\n\n`;
    }
    md += `### Resumo do Período\n`;
    if (allowEur) md += `- **Faturação total:** ${fmtEur(totalEur)}\n`;
    md += `- **Unidades vendidas:** ${totalUn.toLocaleString('pt-PT')} un\n`;
    md += `- **Produtos com vendas:** ${produtos.length}\n\n`;

    md += `### Evolução Mensal\n\n`;
    if (allowEur) {
      md += `| Mês | Unidades | Faturação (€) |\n| :--- | :---: | :---: |\n`;
      for (const ym of mesesYm) {
        const pm = porMes.get(ym)!;
        md += `| ${pm.ym} | ${pm.un.toLocaleString('pt-PT')} | ${fmtEur(pm.eur)} |\n`;
      }
    } else {
      md += `| Mês | Unidades |\n| :--- | :---: |\n`;
      for (const ym of mesesYm) {
        const pm = porMes.get(ym)!;
        md += `| ${pm.ym} | ${pm.un.toLocaleString('pt-PT')} |\n`;
      }
    }
    md += `\n`;

    if (topSlice.length > 0) {
      md += `### Top ${topSlice.length} Produtos Mais Vendidos\n\n`;
      if (allowEur) {
        md += `| CNP | Designação | Vendas (€) | Un | Stock | VMM |\n| :--- | :--- | :---: | :---: | :---: | :---: |\n`;
        for (const p of topSlice) {
          md += `| ${p.cnp} | ${p.designacao.slice(0, 46)} | ${fmtEur(p.vendas_eur)} | ${p.vendas_un} | ${p.stock} | ${p.vmm.toFixed(2)} |\n`;
        }
      } else {
        md += `| CNP | Designação | Un | Stock | VMM |\n| :--- | :--- | :---: | :---: | :---: |\n`;
        for (const p of topSlice) {
          md += `| ${p.cnp} | ${p.designacao.slice(0, 46)} | ${p.vendas_un} | ${p.stock} | ${p.vmm.toFixed(2)} |\n`;
        }
      }
      md += `\n`;
    }

    const stored = saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consulta_comercial',
      input: args,
      meta: { foco: 'vendas', periodo: periodoRotulo, filtro: tituloFiltro },
      colunas: ['cnp', 'designacao', 'vendas_eur', 'vendas_un', 'stock', 'vmm'],
      linhas: topSlice.map((p) => [p.cnp, p.designacao, allowEur ? p.vendas_eur : null, p.vendas_un, p.stock, p.vmm]),
      totais: { faturacao_eur: allowEur ? totalEur : null, unidades_vendidas: totalUn, produtos_vendidos: produtos.length },
      limiteModelo: limite,
    });

    const top1 = topSlice[0] || null;
    return {
      ok: true,
      foco: 'vendas',
      result_ref: stored.result_id,
      meta: {
        foco: 'vendas',
        periodo_rotulo: periodoRotulo,
        filtro: tituloFiltro,
        data_referencia: dataUltimosDadosIso,
        faturacao_oculta: !allowEur,
      },
      totais: {
        faturacao_eur: allowEur ? totalEur : null,
        unidades_vendidas: totalUn,
        produtos_vendidos: produtos.length,
      },
      todos_produtos_indice: topSlice.map((p) => ({
        cnp: p.cnp,
        designacao: p.designacao,
        tipo_venda: p.tipo_venda,
        eh_terapeutica_cronica: isTherapeuticChronic(p.dci || p.designacao),
        classificacao: 'MANTER',
      })),
      relatorio_markdown: md,
      resumo_modelo: {
        meta: { filtro: tituloFiltro, periodo: periodoRotulo, dados_ate: dataUltimosDadosPt },
        totais: {
          ...(allowEur ? { faturacao_eur: totalEur } : {}),
          unidades_vendidas: totalUn,
          produtos_vendidos: produtos.length,
        },
        destaques: {
          top1_produto: top1
            ? {
                nome: top1.designacao.slice(0, 48),
                cnp: top1.cnp,
                ...(allowEur ? { vendas_eur: top1.vendas_eur } : {}),
                vendas_un: top1.vendas_un,
              }
            : null,
        },
        instrucao:
          'Escreve 2 frases corridas em texto simples resumindo os totais do período e o produto mais vendido. Não somes, não calcules, não escrevas tabelas.',
      },
    };
  }

  // ==========================================================================
  // FOCO 4: RECOMENDAÇÃO DE ENCOMENDA (ex.: o que vale a pena encomendar da Mylan)
  // ==========================================================================
  if (args.foco === 'recomendacao_encomenda') {
    const [allMetricas, allCatalog] = await Promise.all([
      prisma.martProdutoMetricas.findMany({ where: { farmaciaId: ctx.farmaciaId } }),
      prisma.produtoMestre.findMany({ select: { cnp_codigo: true, laboratorio_titular: true, dci: true, categoria: true } }),
    ]);
    const catMap = new Map(allCatalog.map((c) => [c.cnp_codigo, c]));

    const filtered = allMetricas.filter((m) => {
      const c = catMap.get(m.cnp_codigo);
      const lab = c?.laboratorio_titular || m.laboratorio_titular;
      const dci = c?.dci || m.molecula_dci;
      const cat = c?.categoria || m.categoria;
      if (args.laboratorio && !matchesLabFilter(lab, m.designacao, args.laboratorio)) return false;
      if (
        args.dci &&
        !normalizeStr(dci).includes(normalizeStr(args.dci)) &&
        !normalizeStr(m.designacao).includes(normalizeStr(args.dci))
      )
        return false;
      if (args.categoria && !normalizeStr(cat).includes(normalizeStr(args.categoria))) return false;
      return true;
    });

    const classificados = filtered.map((m) => {
      const stock = Number(m.stock_total_unidades || 0);
      const vmm = round2(Number(m.vmm || 0));
      const vendasUn = Number(m.total_unidades_vendidas || 0);
      const custoUnit = Number(m.custo_unitario_medio || 0);
      const pvp = m.pvp !== null && m.pvp !== undefined ? Number(m.pvp) : null;
      const cob = vmm > 0 ? round2(stock / vmm) : null;
      const mesesVal = m.meses_ate_validade !== null && m.meses_ate_validade !== undefined ? Number(m.meses_ate_validade) : null;
      const ehCronico = isTherapeuticChronic(m.molecula_dci || m.designacao);

      const dec = classifyProductAction({
        tipoVenda: m.tipo_venda || 'VENDA_LIVRE',
        dci: m.molecula_dci || null,
        designacao: m.designacao,
        stock,
        vendasUn,
        vmm,
        margemPct: m.margem_padrao !== null && m.margem_padrao !== undefined ? Number(m.margem_padrao) : null,
        ehMono: Boolean(m.eh_mono),
        ehExcesso: Boolean(m.eh_excesso_cobertura) || (cob !== null && cob > 4),
        ehRiscoCaducidade: Boolean(m.eh_risco_caducidade),
        mesesAteValidade: mesesVal,
        custoUnit,
        pvp,
      });

      const precisaEncomendar =
        dec.classificacao === 'REPOR' || (dec.classificacao === 'MANTER' && cob !== null && cob < 1.0 && vmm >= 1.0);
      const qtdSugerida = precisaEncomendar ? Math.max(1, Math.ceil(vmm * 1.5 - stock)) : 0;
      const investimentoEur = round2(qtdSugerida * custoUnit);

      return {
        cnp: m.cnp_codigo,
        designacao: m.designacao,
        dci: m.molecula_dci || '',
        tipo_venda: m.tipo_venda || 'VENDA_LIVRE',
        eh_terapeutica_cronica: ehCronico,
        stock,
        vmm,
        cobertura_meses: cob,
        custo_unitario: round2(custoUnit),
        classificacao: dec.classificacao,
        motivo: dec.motivo,
        precisaEncomendar,
        qtdSugerida,
        investimentoEur,
      };
    });

    const aEncomendar = classificados
      .filter((p) => p.precisaEncomendar)
      .sort((a, b) => (a.stock === 0 && b.stock > 0 ? -1 : b.stock === 0 && a.stock > 0 ? 1 : b.vmm - a.vmm));
    const naoEncomendarExcesso = classificados.filter(
      (p) => p.classificacao === 'DEVOLVER_EXCESSO' || p.classificacao === 'DEVOLVER_TUDO'
    );
    const trabalharEncomenda = classificados.filter((p) => p.classificacao === 'TRABALHAR_ENCOMENDA');

    const totalQtd = aEncomendar.reduce((s, p) => s + p.qtdSugerida, 0);
    const totalInvEur = round2(aEncomendar.reduce((s, p) => s + p.investimentoEur, 0));
    const topSlice = aEncomendar.slice(0, limite);
    const tituloFiltro = args.laboratorio || args.dci || args.categoria || 'Farmácia';

    let md = `## Recomendação de Encomenda — ${tituloFiltro}\n`;
    md += `**Base de cálculo:** VMM 12M com cobertura-alvo de 1,5 meses | **Vendas registadas até:** ${dataUltimosDadosPt}\n\n`;
    md += `### Resumo da Proposta\n`;
    md += `- **Produtos analisados:** ${classificados.length}\n`;
    md += `- **Produtos a encomendar (REPOR ou cobertura < 1 mês):** ${aEncomendar.length} ${aEncomendar.length === 1 ? 'produto' : 'produtos'} (${totalQtd} un sugeridas`;
    if (allowEur) md += ` · ${fmtEur(totalInvEur)} a preço de custo`;
    md += `)\n`;
    md += `- **Trabalhar só por encomenda (não manter stock fixo):** ${trabalharEncomenda.length} ${trabalharEncomenda.length === 1 ? 'produto' : 'produtos'}\n`;
    md += `- **Não encomendar (excesso / devolução):** ${naoEncomendarExcesso.length} ${naoEncomendarExcesso.length === 1 ? 'produto' : 'produtos'}\n\n`;

    if (topSlice.length > 0) {
      md += `### Top ${topSlice.length} Produtos Prioritários a Encomendar\n\n`;
      if (allowEur) {
        md += `| CNP | Designação | Stock | VMM | Cob. | Qtd Sug. | Custo Est. | Ação |\n`;
        md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |\n`;
        for (const p of topSlice) {
          const cobStr = p.cobertura_meses !== null ? `${p.cobertura_meses.toFixed(2)} m` : '0,00 m';
          md += `| ${p.cnp} | ${p.designacao.slice(0, 44)} | ${p.stock} | ${p.vmm.toFixed(2)} | ${cobStr} | **${p.qtdSugerida} un** | ${fmtEur(p.investimentoEur)} | **${p.classificacao}** |\n`;
        }
      } else {
        md += `| CNP | Designação | Stock | VMM | Cob. | Qtd Sug. | Ação |\n`;
        md += `| :--- | :--- | :---: | :---: | :---: | :---: | :--- |\n`;
        for (const p of topSlice) {
          const cobStr = p.cobertura_meses !== null ? `${p.cobertura_meses.toFixed(2)} m` : '0,00 m';
          md += `| ${p.cnp} | ${p.designacao.slice(0, 44)} | ${p.stock} | ${p.vmm.toFixed(2)} | ${cobStr} | **${p.qtdSugerida} un** | **${p.classificacao}** |\n`;
        }
      }
      md += `\n`;
    } else {
      md += `Não foram identificados produtos prioritários em rutura ou baixa cobertura para encomenda imediata neste âmbito.\n\n`;
    }

    const stored = saveToolResult({
      farmaciaId: ctx.farmaciaId,
      sessionId,
      turno,
      ferramenta: 'consulta_comercial',
      input: args,
      meta: { foco: 'recomendacao_encomenda', filtro: tituloFiltro },
      colunas: ['cnp', 'designacao', 'stock', 'vmm', 'qtd_sugerida', 'investimento_eur', 'classificacao'],
      linhas: topSlice.map((p) => [
        p.cnp,
        p.designacao,
        p.stock,
        p.vmm,
        p.qtdSugerida,
        allowEur ? p.investimentoEur : null,
        p.classificacao,
      ]),
      totais: { n_a_encomendar: aEncomendar.length, total_qtd: totalQtd, total_investimento_eur: allowEur ? totalInvEur : null },
      limiteModelo: limite,
    });

    const top1 = topSlice[0] || null;
    return {
      ok: true,
      foco: 'recomendacao_encomenda',
      result_ref: stored.result_id,
      meta: {
        foco: 'recomendacao_encomenda',
        filtro: tituloFiltro,
        data_referencia: dataUltimosDadosIso,
        faturacao_oculta: !allowEur,
      },
      totais: {
        produtos_analisados: classificados.length,
        n_a_encomendar: aEncomendar.length,
        total_qtd_sugerida: totalQtd,
        total_investimento_eur: allowEur ? totalInvEur : null,
        n_trabalhar_encomenda: trabalharEncomenda.length,
        n_nao_encomendar: naoEncomendarExcesso.length,
      },
      todos_produtos_indice: topSlice.map((p) => ({
        cnp: p.cnp,
        designacao: p.designacao,
        tipo_venda: p.tipo_venda,
        eh_terapeutica_cronica: p.eh_terapeutica_cronica,
        classificacao: p.classificacao,
      })),
      relatorio_markdown: md,
      resumo_modelo: {
        meta: { filtro: tituloFiltro, dados_ate: dataUltimosDadosPt },
        totais: {
          n_a_encomendar: aEncomendar.length,
          total_qtd_sugerida: totalQtd,
          ...(allowEur ? { total_investimento_eur: totalInvEur } : {}),
        },
        destaques: {
          prioridade_1: top1
            ? {
                nome: top1.designacao.slice(0, 48),
                cnp: top1.cnp,
                stock: top1.stock,
                vmm: top1.vmm,
                qtd_sugerida: top1.qtdSugerida,
                acao: top1.classificacao,
              }
            : null,
        },
        instrucao:
          'Escreve 2 frases corridas em texto simples: indica quantos produtos vale a pena encomendar e destaca a prioridade 1. Não somes, não calcules, não escrevas tabelas.',
      },
    };
  }

  // ==========================================================================
  // FOCO 5: STOCK E VALIDADES
  // ==========================================================================
  const [allMetricas, allCatalog] = await Promise.all([
    prisma.martProdutoMetricas.findMany({ where: { farmaciaId: ctx.farmaciaId, stock_total_unidades: { gt: 0 } } }),
    prisma.produtoMestre.findMany({ select: { cnp_codigo: true, laboratorio_titular: true, dci: true, categoria: true } }),
  ]);
  const catMapVal = new Map(allCatalog.map((c) => [c.cnp_codigo, c]));
  const filtered = allMetricas.filter((m) => {
    const c = catMapVal.get(m.cnp_codigo);
    const lab = c?.laboratorio_titular || m.laboratorio_titular;
    const dci = c?.dci || m.molecula_dci;
    const cat = c?.categoria || m.categoria;
    if (args.laboratorio && !matchesLabFilter(lab, m.designacao, args.laboratorio)) return false;
    if (args.dci && !normalizeStr(dci).includes(normalizeStr(args.dci)) && !normalizeStr(m.designacao).includes(normalizeStr(args.dci)))
      return false;
    if (args.categoria && !normalizeStr(cat).includes(normalizeStr(args.categoria))) return false;
    return true;
  });

  const valCurta = filtered
    .filter((m) => m.eh_risco_caducidade || (m.meses_ate_validade !== null && Number(m.meses_ate_validade) <= 6))
    .sort((a, b) => Number(a.meses_ate_validade ?? 99) - Number(b.meses_ate_validade ?? 99));

  const totalStockUn = filtered.reduce((s, m) => s + Number(m.stock_total_unidades || 0), 0);
  const totalStockEur = round2(filtered.reduce((s, m) => s + Number(m.stock_total_valor_custo || 0), 0));
  const topVal = valCurta.slice(0, limite);
  const tituloFiltro = args.laboratorio || args.dci || args.categoria || 'Farmácia';

  let md = `## Stock e Validades — ${tituloFiltro}\n`;
  md += `**Dados registados até:** ${dataUltimosDadosPt}\n\n`;
  md += `- **Referências em stock:** ${filtered.length} (${totalStockUn.toLocaleString('pt-PT')} un`;
  if (allowEur) md += ` · ${fmtEur(totalStockEur)} a custo`;
  md += `)\n`;
  md += `- **Validades curtas (≤ 6 meses):** ${valCurta.length} ${valCurta.length === 1 ? 'produto' : 'produtos'}\n\n`;

  if (topVal.length > 0) {
    md += `### Validades Mais Próximas (Top ${topVal.length})\n\n`;
    md += `| CNP | Designação | Validade | Stock | VMM | Valor Custo |\n| :--- | :--- | :---: | :---: | :---: | :---: |\n`;
    for (const p of topVal) {
      const valStr = p.data_validade_mais_proxima ? new Date(p.data_validade_mais_proxima).toISOString().slice(0, 10) : '—';
      md += `| ${p.cnp_codigo} | ${p.designacao.slice(0, 44)} | ${valStr} | ${p.stock_total_unidades} | ${Number(p.vmm || 0).toFixed(2)} | ${allowEur ? fmtEur(Number(p.stock_total_valor_custo || 0)) : '—'} |\n`;
    }
    md += `\n`;
  }

  const stored = saveToolResult({
    farmaciaId: ctx.farmaciaId,
    sessionId,
    turno,
    ferramenta: 'consulta_comercial',
    input: args,
    meta: { foco: 'stock_validades', filtro: tituloFiltro },
    colunas: ['cnp', 'designacao', 'stock', 'vmm', 'valor_custo'],
    linhas: topVal.map((p) => [p.cnp_codigo, p.designacao, p.stock_total_unidades, Number(p.vmm || 0), allowEur ? Number(p.stock_total_valor_custo || 0) : null]),
    totais: { total_referencias: filtered.length, total_unidades: totalStockUn, total_valor_eur: allowEur ? totalStockEur : null, n_validades_curtas: valCurta.length },
    limiteModelo: limite,
  });

  return {
    ok: true,
    foco: 'stock_validades',
    result_ref: stored.result_id,
    meta: { foco: 'stock_validades', filtro: tituloFiltro, data_referencia: dataUltimosDadosIso, faturacao_oculta: !allowEur },
    totais: {
      total_referencias: filtered.length,
      total_unidades: totalStockUn,
      total_valor_eur: allowEur ? totalStockEur : null,
      n_validades_curtas: valCurta.length,
    },
    todos_produtos_indice: topVal.map((p) => ({
      cnp: p.cnp_codigo,
      designacao: p.designacao,
      tipo_venda: p.tipo_venda || 'VENDA_LIVRE',
      eh_terapeutica_cronica: isTherapeuticChronic(p.molecula_dci || p.designacao),
      classificacao: 'DEVOLVER_EXCESSO',
    })),
    relatorio_markdown: md,
    resumo_modelo: {
      meta: { filtro: tituloFiltro, dados_ate: dataUltimosDadosPt },
      totais: {
        total_referencias: filtered.length,
        total_unidades: totalStockUn,
        ...(allowEur ? { total_valor_eur: totalStockEur } : {}),
        n_validades_curtas: valCurta.length,
      },
      destaques: {
        validade_mais_proxima: topVal[0]
          ? {
              nome: topVal[0].designacao.slice(0, 48),
              cnp: topVal[0].cnp_codigo,
              stock: topVal[0].stock_total_unidades,
            }
          : null,
      },
      instrucao:
        'Escreve 2 frases corridas em texto simples resumindo o stock e as validades curtas. Não somes, não calcules, não escrevas tabelas.',
    },
  };
}

/**
 * Detetor determinístico de perguntas ambíguas curtas (1–2 palavras sem verbo nem intenção clara, ex.: "Bial", "Teva", "Mylan").
 * Se ambígua, devolve pergunta de clarificação com no máximo 3 opções (pergunta_de_volta = true).
 */
export function detectAmbiguousBareQuery(question: string): {
  isAmbiguous: boolean;
  termo?: string;
  reply?: string;
} {
  const cleaned = (question || '').trim().replace(/[?!.,;:]+$/g, '').trim();
  if (!cleaned) return { isAmbiguous: false };

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 2) return { isAmbiguous: false };

  // Se for saudação simples ou pedido claro com palavra-chave de intenção, não é ambígua de entidade
  const norm = normalizeStr(cleaned);
  const greetings = new Set(['ola', 'bom dia', 'boa tarde', 'boa noite', 'obrigado', 'obrigada', 'ajuda', 'help', 'sim', 'nao', 'confirmo', 'ok']);
  if (greetings.has(norm)) return { isAmbiguous: false };

  const intentKeywords = /\b(monos?|vendas?|faturacao|stock|validades?|ruturas?|encomendar?|comprar?|relatorio|margem|comparar?|subiu|desceu|parados?|devolver)\b/i;
  if (intentKeywords.test(norm)) return { isAmbiguous: false };

  // 1-2 palavras que representam apenas um nome (ex.: "Bial", "Teva", "Mylan", "Ibuprofeno")
  const termo = cleaned;
  const reply = [
    `Sobre **${termo}**, o que pretende consultar?`,
    ``,
    `1. **Vendas** (últimos 3 meses ou ano de 2026)`,
    `2. **Monos e stock parado** (sem vendas há 90 ou 180 dias)`,
    `3. **Relatório completo ou recomendação de encomenda**`,
  ].join('\n');

  return { isAmbiguous: true, termo, reply };
}
