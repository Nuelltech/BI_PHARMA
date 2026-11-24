import { PrismaClient } from '@prisma/client';
import { getCurrentWeekKey } from './weekly_tasks';

export interface ActiveCampaignProductItem {
  cnp_codigo: string;
  designacao: string;
  laboratorio_titular?: string;
  stock_atual: number;
  custo_unitario: number;
  pvp_atual: number;
  pvp_campanha: number;
  desconto_pct: number;
  margem_pct: number;
}

export interface ActivateCampaignInput {
  farmaciaId: string;
  campanhaId: string;
  titulo: string;
  icone?: string;
  descontoPct?: number;
  produtos: ActiveCampaignProductItem[];
  diasDuracao?: number;
  dataFimIso?: string;
  criadoPor?: string;
  tarefasPersonalizadas?: Array<{
    categoria?: string;
    designacao: string;
    valorImpacto?: number;
  }>;
}

export interface UpdateActiveCampaignInput {
  farmaciaId: string;
  activeId: string;
  titulo?: string;
  dataFimIso?: string;
  descontoPct?: number;
  produtos?: ActiveCampaignProductItem[];
  atualizarTarefas?: boolean;
}

/**
 * Ativa uma campanha para uma farmácia, grava o estado e cria automaticamente
 * as tarefas operacionais práticas na Folha de Ações da Semana (e Mobile).
 */
export async function activateCampaign(
  prisma: PrismaClient,
  input: ActivateCampaignInput
) {
  const {
    farmaciaId,
    campanhaId,
    titulo,
    icone = '🎯',
    descontoPct = 15,
    produtos,
    diasDuracao = 15,
    dataFimIso,
    criadoPor = 'Diretor',
    tarefasPersonalizadas,
  } = input;

  const dataInicio = new Date();
  const dataFim = dataFimIso && !Number.isNaN(Date.parse(dataFimIso))
    ? new Date(dataFimIso)
    : new Date(dataInicio.getTime() + diasDuracao * 24 * 60 * 60 * 1000);

  // 1. Marca qualquer campanha ativa anterior com o mesmo ID como CONCLUIDA
  await prisma.campanhaAtiva.updateMany({
    where: {
      farmaciaId,
      campanhaId,
      estado: 'ATIVA'
    },
    data: {
      estado: 'CONCLUIDA'
    }
  });

  // 2. Cria o novo registo de Campanha Ativa
  const novaCampanha = await prisma.campanhaAtiva.create({
    data: {
      farmaciaId,
      campanhaId,
      titulo,
      icone,
      dataInicio,
      dataFim,
      estado: 'ATIVA',
      descontoAplicadoPct: descontoPct,
      produtosJson: produtos as any,
      criadoPor
    }
  });

  // 3. Gera automaticamente as Tarefas Operacionais da Campanha na Folha da Semana
  const weekKey = getCurrentWeekKey();
  const totalProdutos = produtos.length;
  const totalUnidades = produtos.reduce((s, p) => s + (p.stock_atual || 0), 0);
  const valorTotalCusto = produtos.reduce((s, p) => s + (p.stock_atual || 0) * (p.custo_unitario || 0), 0);

  const top3Nomes = produtos
    .slice(0, 3)
    .map((p) => p.designacao.split(',')[0].slice(0, 30))
    .join(' + ');

  const defaultTarefas = [
    {
      taskId: `CAMPANHA_${campanhaId}_MERCH`,
      categoria: 'BALCAO_CAMPANHA',
      designacao: `[${icone} Campanha] Montar Cesto/Ilha de Balcão: ${titulo} (-${descontoPct}% desconto)`,
      valorImpacto: valorTotalCusto,
    },
    {
      taskId: `CAMPANHA_${campanhaId}_SCRIPT`,
      categoria: 'BALCAO_CAMPANHA',
      designacao: `[${icone} Campanha] Atendimento Ativo: Recomendar ${top3Nomes || titulo} ao balcão com preço promocional`,
      valorImpacto: undefined,
    },
    {
      taskId: `CAMPANHA_${campanhaId}_SIFARMA`,
      categoria: 'ENCOMENDAS_CAMPANHA',
      designacao: `[${icone} Campanha] Travar Compras: Rever Ponto de Encomenda = 0 no Sistema de Gestão nos ${totalProdutos} artigos desta campanha (${totalUnidades} un em stock) até escoar`,
      valorImpacto: undefined,
    }
  ];

  const tarefasOperacionais =
    Array.isArray(tarefasPersonalizadas) && tarefasPersonalizadas.length > 0
      ? tarefasPersonalizadas
          .filter((t) => String(t.designacao || '').trim().length > 0)
          .map((t, idx) => ({
            taskId: `CAMPANHA_${campanhaId}_CUSTOM_${idx + 1}`,
            categoria: t.categoria || 'BALCAO_CAMPANHA',
            designacao: String(t.designacao).trim(),
            valorImpacto: t.valorImpacto !== undefined ? Number(t.valorImpacto) : idx === 0 ? valorTotalCusto : undefined,
          }))
      : defaultTarefas;

  for (const t of tarefasOperacionais) {
    try {
      await prisma.tarefaEquipa.upsert({
        where: {
          farmaciaId_week_key_task_id: {
            farmaciaId,
            week_key: weekKey,
            task_id: t.taskId
          }
        },
        create: {
          farmaciaId,
          week_key: weekKey,
          task_id: t.taskId,
          categoria: t.categoria,
          designacao: t.designacao,
          campanha_id: campanhaId,
          concluido: false,
          concluido_por: null,
          valor_impacto: t.valorImpacto ? Number(t.valorImpacto.toFixed(2)) : null
        },
        update: {
          designacao: t.designacao,
          campanha_id: campanhaId,
          valor_impacto: t.valorImpacto ? Number(t.valorImpacto.toFixed(2)) : null
        }
      });
    } catch (err) {
      console.warn(`Aviso ao criar tarefa de campanha ${t.taskId}:`, err);
    }
  }

  return {
    success: true,
    campanhaAtiva: novaCampanha,
    tarefasCriadas: tarefasOperacionais.length,
    mensagem: `Campanha "${titulo}" ativada com sucesso por ${diasDuracao} dias! ${tarefasOperacionais.length} tarefas criadas para a equipa.`
  };
}

/**
 * Consulta todas as campanhas ativas de uma farmácia.
 */
export async function getActiveCampaigns(prisma: PrismaClient, farmaciaId: string) {
  const campanhas = await prisma.campanhaAtiva.findMany({
    where: {
      farmaciaId,
      estado: 'ATIVA'
    },
    orderBy: { criadoEm: 'desc' }
  });

  return campanhas.map((c) => ({
    id: c.id,
    campanhaId: c.campanhaId,
    titulo: c.titulo,
    icone: c.icone,
    dataInicio: c.dataInicio.toISOString().slice(0, 10),
    dataFim: c.dataFim ? c.dataFim.toISOString().slice(0, 10) : null,
    descontoAplicadoPct: c.descontoAplicadoPct,
    produtos: (c.produtosJson as any[]) || [],
    totalProdutos: Array.isArray(c.produtosJson) ? c.produtosJson.length : 0,
    criadoPor: c.criadoPor,
    criadoEm: c.criadoEm.toISOString()
  }));
}

/**
 * Conclui ou cancela uma campanha ativa.
 */
export async function deactivateCampaign(
  prisma: PrismaClient,
  farmaciaId: string,
  campanhaIdOrActiveId: string,
  novoEstado: 'CONCLUIDA' | 'CANCELADA' = 'CONCLUIDA'
) {
  const res = await prisma.campanhaAtiva.updateMany({
    where: {
      farmaciaId,
      OR: [
        { id: campanhaIdOrActiveId },
        { campanhaId: campanhaIdOrActiveId, estado: 'ATIVA' }
      ]
    },
    data: {
      estado: novoEstado
    }
  });

  return {
    success: res.count > 0,
    afetados: res.count,
    mensagem: res.count > 0 ? `Campanha marcada como ${novoEstado}.` : 'Nenhuma campanha ativa encontrada.'
  };
}

/**
 * Atualiza uma campanha já ativa (título, data de fim, desconto, produtos/preços individuais e tarefas).
 */
export async function updateActiveCampaign(
  prisma: PrismaClient,
  input: UpdateActiveCampaignInput
) {
  const existing = await prisma.campanhaAtiva.findFirst({
    where: {
      farmaciaId: input.farmaciaId,
      OR: [{ id: input.activeId }, { campanhaId: input.activeId, estado: 'ATIVA' }],
    },
  });

  if (!existing) {
    return { success: false, mensagem: 'Campanha ativa não encontrada.' };
  }

  // Bloqueio legal MSRM caso produtos tenham sido editados
  const produtosFinais = Array.isArray(input.produtos) && input.produtos.length > 0
    ? input.produtos
    : ((existing.produtosJson as any[]) || []);

  if (Array.isArray(input.produtos) && input.produtos.length > 0) {
    const cnps = input.produtos.map((p) => p.cnp_codigo).filter(Boolean);
    if (cnps.length > 0) {
      const msrmFound = await prisma.produtoMestre.findMany({
        where: { cnp_codigo: { in: cnps }, tipo_venda: 'MSRM' },
        select: { cnp_codigo: true, designacao: true },
      });
      if (msrmFound.length > 0) {
        return {
          success: false,
          mensagem: `Proibido incluir MSRM em campanhas: ${msrmFound.map((m) => m.cnp_codigo).join(', ')}.`,
        };
      }
    }
  }

  const tituloFinal = input.titulo && input.titulo.trim() ? input.titulo.trim() : existing.titulo;
  const descontoFinal = input.descontoPct !== undefined ? Number(input.descontoPct) : existing.descontoAplicadoPct;
  const dataFimFinal =
    input.dataFimIso && !Number.isNaN(Date.parse(input.dataFimIso))
      ? new Date(input.dataFimIso)
      : existing.dataFim;

  const updated = await prisma.campanhaAtiva.update({
    where: { id: existing.id },
    data: {
      titulo: tituloFinal,
      descontoAplicadoPct: descontoFinal,
      dataFim: dataFimFinal,
      produtosJson: produtosFinais as any,
    },
  });

  if (input.atualizarTarefas !== false) {
    const weekKey = getCurrentWeekKey();
    const totalProdutos = produtosFinais.length;
    const totalUnidades = produtosFinais.reduce((s, p) => s + (Number(p.stock_atual) || 0), 0);
    const valorTotalCusto = produtosFinais.reduce(
      (s, p) => s + (Number(p.stock_atual) || 0) * (Number(p.custo_unitario) || 0),
      0
    );
    const top3Nomes = produtosFinais
      .slice(0, 3)
      .map((p) => String(p.designacao || '').split(',')[0].slice(0, 30))
      .join(' + ');
    const icone = existing.icone || '🎯';

    const syncList = [
      {
        taskId: `CAMPANHA_${existing.campanhaId}_MERCH`,
        designacao: `[${icone} Campanha] Montar Cesto/Ilha de Balcão: ${tituloFinal} (-${descontoFinal}% desconto)`,
        valorImpacto: valorTotalCusto,
      },
      {
        taskId: `CAMPANHA_${existing.campanhaId}_SCRIPT`,
        designacao: `[${icone} Campanha] Atendimento Ativo: Recomendar ${top3Nomes || tituloFinal} ao balcão com preço promocional`,
        valorImpacto: undefined,
      },
      {
        taskId: `CAMPANHA_${existing.campanhaId}_SIFARMA`,
        designacao: `[${icone} Campanha] Travar Compras: Rever Ponto de Encomenda = 0 no Sistema de Gestão nos ${totalProdutos} artigos desta campanha (${totalUnidades} un em stock) até escoar`,
        valorImpacto: undefined,
      },
    ];

    for (const s of syncList) {
      await prisma.tarefaEquipa.updateMany({
        where: {
          farmaciaId: input.farmaciaId,
          week_key: weekKey,
          task_id: s.taskId,
        },
        data: {
          designacao: s.designacao,
          ...(s.valorImpacto !== undefined ? { valor_impacto: Number(s.valorImpacto.toFixed(2)) } : {}),
        },
      });
    }
  }

  return {
    success: true,
    campanhaAtiva: updated,
    mensagem: `Campanha "${tituloFinal}" atualizada com sucesso (${produtosFinais.length} SKUs).`,
  };
}
