import { PrismaClient } from '@prisma/client';

export interface StockRebalanceItem {
  cnp_codigo: string;
  aim?: string | null;
  designacao: string;
  categoria?: string | null;
  custo_unitario: number;
  origem: {
    farmaciaId: string;
    farmaciaNome: string;
    stock_atual: number;
    dias_cobertura: number;
    data_validade?: string | null;
  };
  destino: {
    farmaciaId: string;
    farmaciaNome: string;
    stock_atual: number;
    dias_cobertura: number;
    vmm: number;
  };
  quantidade_sugerida: number;
  valor_poupanca_eur: number;
  motivo: 'RUTURA_IMINENTE' | 'VALIDADE_PROXIMA' | 'EXCESSO_EQUILIBRADO';
}

export interface GroupSummaryReport {
  grupoNome: string;
  totalFarmacias: number;
  farmacias: Array<{
    id: string;
    nome: string;
    nif: string;
    totalArtigos: number;
    valorStock: number;
    faturacaoAcumulada: number;
  }>;
  totaisGrupo: {
    valorStockTotal: number;
    faturacaoTotal: number;
    artigosUnicos: number;
    potencialPoupancaRebalanceamento: number;
  };
}

/**
 * Algoritmo de Balanceamento Cruzado de Stock (Multi-Loja)
 * Cruza o inventário e vendas entre todas as lojas do grupo para detetar onde
 * há excesso de stock numa loja e carência/ruptura noutra para o mesmo CNP.
 */
export async function calculateCrossStoreRebalance(
  prisma: PrismaClient
): Promise<{
  sugestoes: StockRebalanceItem[];
  totalOportunidades: number;
  totalPoupancaEstimadaEur: number;
}> {
  const farmacias = await prisma.farmacia.findMany({
    select: { id: true, nome: true },
    orderBy: { criadoEm: 'asc' },
  });

  if (farmacias.length < 2) {
    return {
      sugestoes: [],
      totalOportunidades: 0,
      totalPoupancaEstimadaEur: 0,
    };
  }

  // 1. Obter inventário de todas as farmácias
  const todosInventarios = await prisma.inventario.findMany({
    include: {
      produto: true,
      farmacia: { select: { id: true, nome: true } },
    },
  });

  // 2. Obter vendas dos últimos meses para cálculo de VMM por farmácia e CNP
  const vendasAgregadas = await prisma.venda.groupBy({
    by: ['farmaciaId', 'cnp_codigo'],
    _sum: { quantidade: true, valor_total: true },
    _count: { id: true },
  });

  const vmmMap = new Map<string, number>(); // chave: farmaciaId:cnp
  for (const v of vendasAgregadas) {
    const qtd = v._sum.quantidade || 0;
    // VMM aproximada com base no volume semestral
    const vmm = Math.max(1, Math.round(qtd / 6));
    vmmMap.set(`${v.farmaciaId}:${v.cnp_codigo}`, vmm);
  }

  // 3. Agrupar existências por CNP
  const stocksPorCnp = new Map<string, any[]>();
  for (const inv of todosInventarios) {
    if (!stocksPorCnp.has(inv.cnp_codigo)) {
      stocksPorCnp.set(inv.cnp_codigo, []);
    }
    stocksPorCnp.get(inv.cnp_codigo)!.push(inv);
  }

  const sugestoes: StockRebalanceItem[] = [];
  let totalPoupanca = 0;

  // 4. Analisar assimetrias entre lojas
  for (const [cnp, itens] of stocksPorCnp.entries()) {
    if (itens.length < 2) continue; // Precisa de existir em pelo menos duas lojas

    // Para cada par de lojas com o mesmo CNP
    for (let i = 0; i < itens.length; i++) {
      for (let j = 0; j < itens.length; j++) {
        if (i === j) continue;

        const lojaOrigem = itens[i];
        const lojaDestino = itens[j];

        const stockOrigem = lojaOrigem.quantidade || 0;
        const stockDestino = lojaDestino.quantidade || 0;

        const vmmOrigem = vmmMap.get(`${lojaOrigem.farmaciaId}:${cnp}`) || 1;
        const vmmDestino = vmmMap.get(`${lojaDestino.farmaciaId}:${cnp}`) || 1;

        const diasCobOrigem = Math.round((stockOrigem / vmmOrigem) * 30);
        const diasCobDestino = Math.round((stockDestino / vmmDestino) * 30);

        // Condição de Desequilíbrio:
        // Origem tem excesso (stock >= 5 e cobertura > 45 dias)
        // Destino tem carência/ruptura (stock <= 2 ou cobertura < 10 dias)
        if (stockOrigem >= 4 && diasCobOrigem >= 45 && (stockDestino <= 2 || diasCobDestino <= 12)) {
          const excessoOrigem = Math.max(1, Math.floor(stockOrigem - vmmOrigem * 1.5));
          const necessidadeDestino = Math.max(1, Math.ceil(vmmDestino * 1.5 - stockDestino));
          const qtdSugerida = Math.min(excessoOrigem, necessidadeDestino);

          if (qtdSugerida > 0) {
            const custoUnit = Number(lojaOrigem.custo_unitario || 0);
            const poupanca = Number((qtdSugerida * custoUnit).toFixed(2));

            // Evitar duplicados no sentido oposto
            const jaExiste = sugestoes.some(
              s => s.cnp_codigo === cnp && s.origem.farmaciaId === lojaOrigem.farmaciaId && s.destino.farmaciaId === lojaDestino.farmaciaId
            );

            if (!jaExiste) {
              sugestoes.push({
                cnp_codigo: cnp,
                aim: lojaOrigem.produto.aim,
                designacao: lojaOrigem.produto.designacao,
                categoria: lojaOrigem.produto.categoria,
                custo_unitario: custoUnit,
                origem: {
                  farmaciaId: lojaOrigem.farmaciaId,
                  farmaciaNome: lojaOrigem.farmacia.nome,
                  stock_atual: stockOrigem,
                  dias_cobertura: diasCobOrigem,
                  data_validade: lojaOrigem.data_validade ? lojaOrigem.data_validade.toISOString().slice(0, 7) : null,
                },
                destino: {
                  farmaciaId: lojaDestino.farmaciaId,
                  farmaciaNome: lojaDestino.farmacia.nome,
                  stock_atual: stockDestino,
                  dias_cobertura: diasCobDestino,
                  vmm: vmmDestino,
                },
                quantidade_sugerida: qtdSugerida,
                valor_poupanca_eur: poupanca,
                motivo: diasCobDestino <= 7 ? 'RUTURA_IMINENTE' : 'EXCESSO_EQUILIBRADO',
              });

              totalPoupanca += poupanca;
            }
          }
        }
      }
    }
  }

  // Ordenar por maior valor de poupança gerada
  sugestoes.sort((a, b) => b.valor_poupanca_eur - a.valor_poupanca_eur);

  return {
    sugestoes: sugestoes.slice(0, 50),
    totalOportunidades: sugestoes.length,
    totalPoupancaEstimadaEur: Number(totalPoupanca.toFixed(2)),
  };
}

/**
 * Resumo Consolidado do Grupo de Farmácias
 */
export async function getGroupSummary(prisma: PrismaClient): Promise<GroupSummaryReport> {
  const farmacias = await prisma.farmacia.findMany({
    select: { id: true, nome: true, nif: true },
    orderBy: { criadoEm: 'asc' },
  });

  const farmaciasList = [];
  let valorStockTotal = 0;
  let faturacaoTotal = 0;

  for (const f of farmacias) {
    const invs = await prisma.inventario.findMany({
      where: { farmaciaId: f.id },
      select: { quantidade: true, custo_unitario: true },
    });

    let farmStock = 0;
    for (const i of invs) {
      farmStock += Number(i.quantidade || 0) * Number(i.custo_unitario || 0);
    }

    const vSum = await prisma.venda.aggregate({
      where: { farmaciaId: f.id },
      _sum: { valor_total: true },
    });

    const farmFat = Number(vSum._sum.valor_total || 0);
    valorStockTotal += farmStock;
    faturacaoTotal += farmFat;

    farmaciasList.push({
      id: f.id,
      nome: f.nome,
      nif: f.nif,
      totalArtigos: invs.length,
      valorStock: Number(farmStock.toFixed(2)),
      faturacaoAcumulada: Number(farmFat.toFixed(2)),
    });
  }

  const produtosUnicos = await prisma.produtoMestre.count();
  const rebalance = await calculateCrossStoreRebalance(prisma);

  return {
    grupoNome: 'Grupo Farmacêutico Bi-Pharma',
    totalFarmacias: farmacias.length,
    farmacias: farmaciasList,
    totaisGrupo: {
      valorStockTotal: Number(valorStockTotal.toFixed(2)),
      faturacaoTotal: Number(faturacaoTotal.toFixed(2)),
      artigosUnicos: produtosUnicos,
      potencialPoupancaRebalanceamento: rebalance.totalPoupancaEstimadaEur,
    },
  };
}
