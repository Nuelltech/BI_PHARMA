import { PrismaClient, Prisma } from '@prisma/client';
import {
  parseWinpharVendasPdfFile,
  parseWinpharValidadesPdfFile,
  ParsedWinpharVendasPdf,
  ParsedWinpharValidadesPdf,
} from './ingestion';
import { classifyProduct } from './classifier';

export interface InspectionQuestionOption {
  value: string;
  label: string;
  isRecommended?: boolean;
}

export interface InspectionQuestion {
  id: string; // 'nif_action' | 'conflict_action' | 'stock_action' | 'validades_action'
  title: string;
  description: string;
  options: InspectionQuestionOption[];
  defaultValue: string;
}

export interface FileInspectionResult {
  fileName: string;
  fileType: 'VENDAS_MENSAL' | 'VENDAS_DIARIO' | 'VALIDADES' | 'DESCONHECIDO';
  periodo: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  anoReferencia: number;
  nifDetectado: string | null;
  farmaciaNomeDetectada: string | null;
  totalArtigos: number;
  registosExistentesNaBd?: number;
  questions: InspectionQuestion[];
  status: 'READY' | 'WARNING' | 'ERROR';
  errorMessage?: string;
}

export interface UserDecisionsPayload {
  [fileName: string]: {
    nifAction?: 'link_to_current' | 'create_new';
    conflictAction?: 'overwrite' | 'ignore';
    stockAction?: 'snapshot_only' | 'update_active' | 'none';
    validadesAction?: 'incremental_fefo';
  };
}

export interface ImportExecutionStats {
  filesProcessed: number;
  totalVendasCriadas: number;
  totalSnapshotsStockCriados: number;
  totalInventarioAtivoAtualizado: number;
  totalValidadesCruzadas: number;
  totalProdutosNovos: number;
  detalhesPorFicheiro: Array<{
    fileName: string;
    sucesso: boolean;
    tipo: string;
    vendas?: number;
    stockSnapshots?: number;
    validades?: number;
    mensagem?: string;
  }>;
}

/**
 * Normaliza CNP numérico com 7 dígitos
 */
function normalizeCnp(raw: string | null | undefined): string {
  if (!raw) return '0000000';
  const c = raw.replace(/\s+/g, '').trim();
  return /^\d{6}$/.test(c) ? c.padStart(7, '0') : c.slice(0, 7);
}

/**
 * Analisa e inspeciona um conjunto de ficheiros em memória, verificando conflitos e preparando
 * as perguntas necessárias para o utilizador decidir o que fazer.
 */
export async function inspectFilesForInteractiveImport(
  files: Array<{ name: string; buffer: Buffer }>,
  farmaciaAtiva: { id: string; nome: string; nif: string },
  prisma: PrismaClient
): Promise<FileInspectionResult[]> {
  const results: FileInspectionResult[] = [];

  for (const f of files) {
    try {
      const isValidades = f.name.toLowerCase().includes('val') || f.name.toLowerCase().includes('validade');

      if (isValidades) {
        // Tenta parse como Validades
        const parsedVal = await parseWinpharValidadesPdfFile(f.buffer);
        const questions: InspectionQuestion[] = [];

        // Validades: Pergunta de segurança (incremental vs sobrescrita)
        questions.push({
          id: 'validades_action',
          title: 'Integração de Prazos de Validade',
          description: `O ficheiro contém ${parsedVal.rows.length} artigos com prazo de validade.`,
          defaultValue: 'incremental_fefo',
          options: [
            {
              value: 'incremental_fefo',
              label: 'Atualização Incremental FEFO (Recomendado: atualiza apenas os artigos visados e preserva todas as validades existentes)',
              isRecommended: true,
            },
          ],
        });

        results.push({
          fileName: f.name,
          fileType: 'VALIDADES',
          periodo: 'Prazos de Validade',
          dataInicio: null,
          dataFim: null,
          anoReferencia: 2026,
          nifDetectado: parsedVal.farmaciaNif,
          farmaciaNomeDetectada: parsedVal.farmaciaNome,
          totalArtigos: parsedVal.rows.length,
          questions,
          status: 'READY',
        });
        continue;
      }

      // Tenta parse como Vendas
      const parsedVen = await parseWinpharVendasPdfFile(f.buffer);
      const questions: InspectionQuestion[] = [];

      // 1. Verificação de NIF / Mudança de Sociedade (ex: Galeno III vs Avenida)
      const docNif = parsedVen.farmaciaNif;
      if (docNif && docNif !== farmaciaAtiva.nif) {
        questions.push({
          id: 'nif_action',
          title: 'NIF Divergente Detetado',
          description: `O documento indica Contribuinte ${docNif} (${parsedVen.farmaciaNome || 'Galeno III, Lda'}), mas a farmácia ativa selecionada é ${farmaciaAtiva.nome} (NIF: ${farmaciaAtiva.nif}).`,
          defaultValue: 'link_to_current',
          options: [
            {
              value: 'link_to_current',
              label: `Associar ao histórico da ${farmaciaAtiva.nome} (Recomendado: transição de sociedade / mesma morada)`,
              isRecommended: true,
            },
            {
              value: 'create_new',
              label: `Criar uma nova farmácia independente para o NIF ${docNif}`,
              isRecommended: false,
            },
          ],
        });
      }

      // 2. Verificação de Conflitos de Período Existente na BD
      let registosExistentes = 0;
      if (parsedVen.dataInicio && parsedVen.dataFim) {
        registosExistentes = await prisma.venda.count({
          where: {
            farmaciaId: farmaciaAtiva.id,
            granularidade: parsedVen.granularidade,
            data_venda: {
              gte: new Date(parsedVen.dataInicio),
              lte: new Date(parsedVen.dataFim),
            },
          },
        });
      }

      if (registosExistentes > 0) {
        questions.push({
          id: 'conflict_action',
          title: 'Período já Existente na Base de Dados',
          description: `Já existem ${registosExistentes} registos de venda na base de dados para o período ${parsedVen.periodo || 'deste ficheiro'}.`,
          defaultValue: 'overwrite',
          options: [
            {
              value: 'overwrite',
              label: 'Substituir / Atualizar os registos existentes com os deste ficheiro',
              isRecommended: true,
            },
            {
              value: 'ignore',
              label: 'Ignorar ficheiro e manter os dados que já estão na base de dados',
              isRecommended: false,
            },
          ],
        });
      }

      // 3. Verificação de Posição de Stock (Passado vs Atual)
      const isPastYear = parsedVen.anoVendas < 2026;
      if (isPastYear) {
        questions.push({
          id: 'stock_action',
          title: 'Política de Stock de Ano Anterior',
          description: `Este ficheiro refere-se a ${parsedVen.anoVendas}. As existências nele registadas são do passado.`,
          defaultValue: 'snapshot_only',
          options: [
            {
              value: 'snapshot_only',
              label: `Guardar no Histórico de Stock (Snapshot de ${parsedVen.anoVendas}) sem alterar o stock ativo atual (Recomendado)`,
              isRecommended: true,
            },
            {
              value: 'update_active',
              label: `Substituir o stock ativo atual da farmácia pelas existências de ${parsedVen.anoVendas}`,
              isRecommended: false,
            },
            {
              value: 'none',
              label: 'Não registar histórico de stock deste ficheiro',
              isRecommended: false,
            },
          ],
        });
      } else {
        questions.push({
          id: 'stock_action',
          title: 'Atualização de Stock Corrente',
          description: `Este documento é de ${parsedVen.anoVendas} (ano corrente).`,
          defaultValue: 'update_active',
          options: [
            {
              value: 'update_active',
              label: 'Atualizar existências ativas da farmácia e gerar snapshot histórico (Recomendado)',
              isRecommended: true,
            },
            {
              value: 'snapshot_only',
              label: 'Guardar apenas como snapshot histórico sem alterar a prateleira ativa',
              isRecommended: false,
            },
          ],
        });
      }

      results.push({
        fileName: f.name,
        fileType: parsedVen.isDaily ? 'VENDAS_DIARIO' : 'VENDAS_MENSAL',
        periodo: parsedVen.periodo,
        dataInicio: parsedVen.dataInicio,
        dataFim: parsedVen.dataFim,
        anoReferencia: parsedVen.anoVendas,
        nifDetectado: docNif,
        farmaciaNomeDetectada: parsedVen.farmaciaNome,
        totalArtigos: parsedVen.rows.length,
        registosExistentesNaBd: registosExistentes,
        questions,
        status: questions.length > 0 ? 'WARNING' : 'READY',
      });
    } catch (err: any) {
      results.push({
        fileName: f.name,
        fileType: 'DESCONHECIDO',
        periodo: null,
        dataInicio: null,
        dataFim: null,
        anoReferencia: 2026,
        nifDetectado: null,
        farmaciaNomeDetectada: null,
        totalArtigos: 0,
        questions: [],
        status: 'ERROR',
        errorMessage: err.message || String(err),
      });
    }
  }

  return results;
}

/**
 * Executa a importação dos ficheiros aplicando as decisões expressas pelo utilizador.
 */
export async function executeInteractiveImport(
  files: Array<{ name: string; buffer: Buffer }>,
  decisions: UserDecisionsPayload,
  farmaciaAtivaId: string,
  prisma: PrismaClient,
  onProgress?: (percent: number, step: string, detail: string) => void
): Promise<ImportExecutionStats> {
  const stats: ImportExecutionStats = {
    filesProcessed: 0,
    totalVendasCriadas: 0,
    totalSnapshotsStockCriados: 0,
    totalInventarioAtivoAtualizado: 0,
    totalValidadesCruzadas: 0,
    totalProdutosNovos: 0,
    detalhesPorFicheiro: [],
  };

  const farmacia = await prisma.farmacia.findUnique({ where: { id: farmaciaAtivaId } });
  if (!farmacia) {
    throw new Error(`Farmácia com ID "${farmaciaAtivaId}" não encontrada.`);
  }

  const numFiles = files.length;
  onProgress?.(5, 'A iniciar importação...', `${numFiles} ficheiro(s) selecionado(s)`);

  for (let fileIdx = 0; fileIdx < numFiles; fileIdx++) {
    const f = files[fileIdx];
    const basePct = Math.round((fileIdx / numFiles) * 90);
    const fileSlice = Math.round(90 / numFiles);

    onProgress?.(basePct + 2, `A analisar ficheiro ${f.name}...`, `Ficheiro ${fileIdx + 1} de ${numFiles}`);

    const fileDecisions = decisions[f.name] || {};
    const isValidades = f.name.toLowerCase().includes('val') || f.name.toLowerCase().includes('validade');

    try {
      if (isValidades) {
        // ----------------------------------------------------
        // CASO A: Ficheiro de Validades
        // ----------------------------------------------------
        const parsedVal = await parseWinpharValidadesPdfFile(f.buffer);
        let valUpdatedCount = 0;

        onProgress?.(
          basePct + Math.round(fileSlice * 0.3),
          `A cruzar prazos de validade com o inventário...`,
          `${parsedVal.rows.length} artigos a processar`
        );

        // Obter inventário atual da farmácia
        const inventarios = await prisma.inventario.findMany({
          where: { farmaciaId: farmacia.id },
        });
        const invMap = new Map<string, typeof inventarios>();
        for (const inv of inventarios) {
          const l = invMap.get(inv.cnp_codigo) ?? [];
          l.push(inv);
          invMap.set(inv.cnp_codigo, l);
        }

        for (let rIdx = 0; rIdx < parsedVal.rows.length; rIdx++) {
          const r = parsedVal.rows[rIdx];
          const cnp = normalizeCnp(r.codigo);
          const validadeMatch = r.validade.trim().match(/^(\d{2})-(\d{4})$/);
          if (!validadeMatch) continue;

          const month = parseInt(validadeMatch[1], 10);
          const year = parseInt(validadeMatch[2], 10);
          const novaDataValidade = new Date(Date.UTC(year, month, 0, 23, 59, 59, 0));

          const matches = invMap.get(cnp) || [];
          for (const inv of matches) {
            // Regra FEFO: se já tiver validade, escolhe a mais próxima (menor)
            const bestDate = inv.data_validade && inv.data_validade < novaDataValidade ? inv.data_validade : novaDataValidade;
            await prisma.inventario.update({
              where: { id: inv.id },
              data: { data_validade: bestDate },
            });
            valUpdatedCount++;
          }

          if (rIdx % 10 === 0 || rIdx === parsedVal.rows.length - 1) {
            onProgress?.(
              basePct + Math.round(fileSlice * (0.3 + (0.6 * (rIdx + 1)) / parsedVal.rows.length)),
              `A atualizar prazos de validade (FEFO)...`,
              `${rIdx + 1} de ${parsedVal.rows.length} artigos verificados`
            );
          }
        }

        stats.totalValidadesCruzadas += valUpdatedCount;
        stats.filesProcessed++;
        stats.detalhesPorFicheiro.push({
          fileName: f.name,
          sucesso: true,
          tipo: 'VALIDADES',
          validades: valUpdatedCount,
          mensagem: `${valUpdatedCount} inventários com data de validade atualizada com sucesso.`,
        });
        continue;
      }

      // ----------------------------------------------------
      // CASO B: Ficheiro de Vendas (Diário ou Mensal)
      // ----------------------------------------------------
      const parsedVen = await parseWinpharVendasPdfFile(f.buffer);

      onProgress?.(
        basePct + Math.round(fileSlice * 0.15),
        `A preparar catálogo de produtos...`,
        `${parsedVen.rows.length} produtos lidos no documento`
      );

      // Decisão 1: NIF / Farmácia
      let targetFarmaciaId = farmacia.id;
      if (fileDecisions.nifAction === 'create_new' && parsedVen.farmaciaNif && parsedVen.farmaciaNif !== farmacia.nif) {
        const newFarm = await prisma.farmacia.upsert({
          where: { nif: parsedVen.farmaciaNif },
          update: { nome: parsedVen.farmaciaNome || `Farmácia ${parsedVen.farmaciaNif}` },
          create: { nome: parsedVen.farmaciaNome || `Farmácia ${parsedVen.farmaciaNif}`, nif: parsedVen.farmaciaNif },
        });
        targetFarmaciaId = newFarm.id;
      }

      // Decisão 2: Conflito de Período Existente
      if (fileDecisions.conflictAction === 'ignore') {
        stats.filesProcessed++;
        stats.detalhesPorFicheiro.push({
          fileName: f.name,
          sucesso: true,
          tipo: parsedVen.granularidade,
          vendas: 0,
          mensagem: 'Ignorado conforme instrução do utilizador (dados já existentes mantidos).',
        });
        continue;
      }

      if (fileDecisions.conflictAction === 'overwrite' && parsedVen.dataInicio && parsedVen.dataFim) {
        onProgress?.(
          basePct + Math.round(fileSlice * 0.2),
          `A limpar dados existentes do período para reescrita limpa...`,
          `${parsedVen.periodo || ''}`
        );
        await prisma.venda.deleteMany({
          where: {
            farmaciaId: targetFarmaciaId,
            granularidade: parsedVen.granularidade,
            data_venda: {
              gte: new Date(parsedVen.dataInicio),
              lte: new Date(parsedVen.dataFim),
            },
          },
        });
      }

      // 1. Garantir Produtos Mestres na BD
      const uniqueProds = new Map<string, { cnp_codigo: string; designacao: string; tipo_venda: string; categoria: string }>();
      for (const r of parsedVen.rows) {
        const cnp = normalizeCnp(r.codigo);
        const classification = classifyProduct(cnp, r.designacao, null);
        uniqueProds.set(cnp, {
          cnp_codigo: cnp,
          designacao: r.designacao,
          tipo_venda: classification.tipo_venda,
          categoria: classification.categoria,
        });
      }

      const prodChunks = Array.from(uniqueProds.values());
      for (let i = 0; i < prodChunks.length; i += 500) {
        const chunk = prodChunks.slice(i, i + 500);
        const res = await prisma.produtoMestre.createMany({
          data: chunk,
          skipDuplicates: true,
        });
        stats.totalProdutosNovos += res.count;
      }

      // 2. Inserir Vendas
      const vendasToInsert: Array<{
        farmaciaId: string;
        cnp_codigo: string;
        quantidade: number;
        valor_total: Prisma.Decimal;
        data_venda: Date;
        granularidade: string;
      }> = [];

      for (const r of parsedVen.rows) {
        const cnp = normalizeCnp(r.codigo);
        const pvpNum = parseFloat(r.pvp.replace('.', '').replace(',', '.'));
        const unitPvp = !Number.isNaN(pvpNum) ? pvpNum : 0;

        for (const [isoDate, qtd] of Object.entries(r.vendasMensais)) {
          if (qtd === 0) continue;
          const valorTotal = new Prisma.Decimal((qtd * unitPvp).toFixed(2));
          vendasToInsert.push({
            farmaciaId: targetFarmaciaId,
            cnp_codigo: cnp,
            quantidade: qtd,
            valor_total: valorTotal,
            data_venda: new Date(isoDate),
            granularidade: parsedVen.granularidade,
          });
        }
      }

      for (let i = 0; i < vendasToInsert.length; i += 500) {
        const chunk = vendasToInsert.slice(i, i + 500);
        await prisma.$transaction(
          chunk.map((v) =>
            prisma.venda.upsert({
              where: {
                farmaciaId_cnp_codigo_data_venda_granularidade: {
                  farmaciaId: v.farmaciaId,
                  cnp_codigo: v.cnp_codigo,
                  data_venda: v.data_venda,
                  granularidade: v.granularidade,
                },
              },
              update: {
                quantidade: v.quantidade,
                valor_total: v.valor_total,
              },
              create: v,
            })
          )
        );
        stats.totalVendasCriadas += chunk.length;

        const salesProgress = (i + chunk.length) / Math.max(1, vendasToInsert.length);
        onProgress?.(
          basePct + Math.round(fileSlice * (0.25 + 0.45 * salesProgress)),
          `A gravar vendas na base de dados...`,
          `${i + chunk.length} de ${vendasToInsert.length} vendas gravadas`
        );
      }

      // 3. Gestão de Stock (Snapshot Histórico vs Atual)
      const stockAction = fileDecisions.stockAction || (parsedVen.anoVendas < 2026 ? 'snapshot_only' : 'update_active');
      let snapshotsCount = 0;
      let activeStockCount = 0;

      const snapshotDate = parsedVen.dataFim ? new Date(parsedVen.dataFim) : new Date(Date.UTC(parsedVen.anoVendas, 11, 31, 23, 59, 59));

      if (stockAction === 'snapshot_only' || stockAction === 'update_active') {
        const snapshotsData: Array<{
          farmaciaId: string;
          cnp_codigo: string;
          data_snapshot: Date;
          quantidade: number;
          custo_unitario: Prisma.Decimal;
          valor_total: Prisma.Decimal;
        }> = [];

        for (const r of parsedVen.rows) {
          const cnp = normalizeCnp(r.codigo);
          const stockNum = parseInt(r.stock, 10);
          const pcNum = parseFloat(r.pc.replace('.', '').replace(',', '.'));
          if (Number.isNaN(stockNum) || Number.isNaN(pcNum)) continue;

          const totalCusto = new Prisma.Decimal((stockNum * pcNum).toFixed(2));
          snapshotsData.push({
            farmaciaId: targetFarmaciaId,
            cnp_codigo: cnp,
            data_snapshot: snapshotDate,
            quantidade: stockNum,
            custo_unitario: new Prisma.Decimal(pcNum.toFixed(2)),
            valor_total: totalCusto,
          });
        }

        for (let i = 0; i < snapshotsData.length; i += 500) {
          const chunk = snapshotsData.slice(i, i + 500);
          await prisma.$transaction(
            chunk.map((s) =>
              prisma.inventarioSnapshot.upsert({
                where: {
                  farmaciaId_cnp_codigo_data_snapshot: {
                    farmaciaId: s.farmaciaId,
                    cnp_codigo: s.cnp_codigo,
                    data_snapshot: s.data_snapshot,
                  },
                },
                update: {
                  quantidade: s.quantidade,
                  custo_unitario: s.custo_unitario,
                  valor_total: s.valor_total,
                },
                create: s,
              })
            )
          );
          snapshotsCount += chunk.length;

          const snapProgress = (i + chunk.length) / Math.max(1, snapshotsData.length);
          onProgress?.(
            basePct + Math.round(fileSlice * (0.7 + 0.25 * snapProgress)),
            `A criar snapshots de stock histórico (${parsedVen.anoVendas})...`,
            `${i + chunk.length} de ${snapshotsData.length} posições de stock registadas`
          );
        }
        stats.totalSnapshotsStockCriados += snapshotsCount;
      }

      if (stockAction === 'update_active') {
        // Atualiza a tabela Inventario e PrecoFarmacia com os valores deste ficheiro
        const invRows: Array<{
          farmaciaId: string;
          cnp_codigo: string;
          lote: string;
          quantidade: number;
          custo_unitario: Prisma.Decimal;
        }> = [];

        const precosRows: Array<{
          farmaciaId: string;
          cnp_codigo: string;
          pvp: Prisma.Decimal;
          custo_ref: Prisma.Decimal;
          margem?: Prisma.Decimal;
        }> = [];

        for (const r of parsedVen.rows) {
          const cnp = normalizeCnp(r.codigo);
          const stockNum = parseInt(r.stock, 10);
          const pcNum = parseFloat(r.pc.replace('.', '').replace(',', '.'));
          const pvpNum = parseFloat(r.pvp.replace('.', '').replace(',', '.'));

          if (!Number.isNaN(stockNum) && !Number.isNaN(pcNum)) {
            invRows.push({
              farmaciaId: targetFarmaciaId,
              cnp_codigo: cnp,
              lote: 'LOTE ÚNICO',
              quantidade: stockNum,
              custo_unitario: new Prisma.Decimal(pcNum.toFixed(2)),
            });
          }

          if (!Number.isNaN(pvpNum) && !Number.isNaN(pcNum)) {
            precosRows.push({
              farmaciaId: targetFarmaciaId,
              cnp_codigo: cnp,
              pvp: new Prisma.Decimal(pvpNum.toFixed(2)),
              custo_ref: new Prisma.Decimal(pcNum.toFixed(2)),
            });
          }
        }

        for (let i = 0; i < invRows.length; i += 250) {
          const chunk = invRows.slice(i, i + 250);
          await prisma.$transaction(
            chunk.map((inv) =>
              prisma.inventario.upsert({
                where: {
                  farmaciaId_cnp_codigo_lote: {
                    farmaciaId: inv.farmaciaId,
                    cnp_codigo: inv.cnp_codigo,
                    lote: inv.lote,
                  },
                },
                update: {
                  quantidade: inv.quantidade,
                  custo_unitario: inv.custo_unitario,
                  data_extracao: new Date(),
                },
                create: {
                  ...inv,
                  data_extracao: new Date(),
                },
              })
            )
          );
          activeStockCount += chunk.length;
        }
        stats.totalInventarioAtivoAtualizado += activeStockCount;

        // Precos
        for (let i = 0; i < precosRows.length; i += 500) {
          const chunk = precosRows.slice(i, i + 500);
          await prisma.$transaction(
            chunk.map((p) =>
              prisma.precoFarmacia.upsert({
                where: {
                  farmaciaId_cnp_codigo: {
                    farmaciaId: p.farmaciaId,
                    cnp_codigo: p.cnp_codigo,
                  },
                },
                update: {
                  pvp: p.pvp,
                  custo_ref: p.custo_ref,
                  atualizadoEm: new Date(),
                },
                create: {
                  farmaciaId: p.farmaciaId,
                  cnp_codigo: p.cnp_codigo,
                  pvp: p.pvp,
                  custo_ref: p.custo_ref,
                  atualizadoEm: new Date(),
                },
              })
            )
          );
        }
      }

      stats.filesProcessed++;
      stats.detalhesPorFicheiro.push({
        fileName: f.name,
        sucesso: true,
        tipo: parsedVen.granularidade,
        vendas: vendasToInsert.length,
        stockSnapshots: snapshotsCount,
        mensagem: `${vendasToInsert.length} vendas integradas. ${snapshotsCount} posições em snapshot. ${activeStockCount > 0 ? `${activeStockCount} stocks ativos atualizados.` : 'Stock ativo preservado.'}`,
      });
    } catch (err: any) {
      stats.detalhesPorFicheiro.push({
        fileName: f.name,
        sucesso: false,
        tipo: 'ERRO',
        mensagem: err.message || String(err),
      });
    }
  }

  onProgress?.(100, '🎉 Importação Concluída com Sucesso!', 'Todos os dados foram processados.');
  return stats;
}
