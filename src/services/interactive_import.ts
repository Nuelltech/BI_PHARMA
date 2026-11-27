import { PrismaClient, Prisma } from '@prisma/client';
import { logSecurityAudit } from './audit_service';
import {
  parseWinpharVendasPdfFile,
  parseWinpharValidadesPdfFile,
  parseWinpharVendasCsvFile,
  ParsedWinpharVendasPdf,
  ParsedWinpharValidadesPdf,
} from './ingestion';

function isPdfBuffer(buf: Buffer, fileName: string): boolean {
  const ext = fileName.toLowerCase();
  if (ext.endsWith('.csv') || ext.endsWith('.txt')) return false;
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') return true;
  return ext.endsWith('.pdf');
}

async function parseVendasAnyFormat(buf: Buffer, fileName: string): Promise<ParsedWinpharVendasPdf> {
  if (isPdfBuffer(buf, fileName)) {
    return parseWinpharVendasPdfFile(buf);
  }
  return parseWinpharVendasCsvFile(buf, fileName);
}
import { classifyProduct } from './classifier';
import {
  detectSifarmaPdfKind,
  parseSifarmaInventarioNormalLines,
  parseSifarmaInventarioIvaLines,
  parseSifarmaSemConsumoLines,
} from './sifarma_pdf_parsers';

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
  fileType:
    | 'VENDAS_MENSAL'
    | 'VENDAS_DIARIO'
    | 'VALIDADES'
    | 'INVENTARIO_SIFARMA'
    | 'INVENTARIO_IVA_SIFARMA'
    | 'SEM_CONSUMO_SIFARMA'
    | 'DESCONHECIDO';
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
  duracaoMs?: number;
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

function parsePtDecimal(raw: string | null | undefined): number {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (s.includes(',')) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(s);
}

const BULK_BATCH_SIZE = 1000;

async function bulkUpsertVendas(
  prisma: PrismaClient,
  rows: Array<{ farmaciaId: string; cnp_codigo: string; quantidade: number; valor_total: number; data_venda: Date; granularidade: string }>,
  onBatch?: (done: number, total: number) => void
) {
  // Deduplicar por chave única (farmaciaId, cnp_codigo, data_venda, granularidade)
  const dedup = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    dedup.set(`${r.farmaciaId}|${r.cnp_codigo}|${r.data_venda.toISOString()}|${r.granularidade}`, r);
  }
  const uniqueRows = Array.from(dedup.values());
  for (let i = 0; i < uniqueRows.length; i += BULK_BATCH_SIZE) {
    const chunk = uniqueRows.slice(i, i + BULK_BATCH_SIZE);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Venda" ("id", "farmaciaId", "cnp_codigo", "quantidade", "valor_total", "data_venda", "granularidade")
       SELECT gen_random_uuid()::text, u.fid, u.cnp, u.qtd, u.val, u.dt, u.gran
       FROM unnest($1::text[], $2::text[], $3::int[], $4::numeric[], $5::timestamptz[], $6::text[])
         AS u(fid, cnp, qtd, val, dt, gran)
       ON CONFLICT ("farmaciaId", "cnp_codigo", "data_venda", "granularidade")
       DO UPDATE SET "quantidade" = EXCLUDED."quantidade", "valor_total" = EXCLUDED."valor_total"`,
      chunk.map((r) => r.farmaciaId),
      chunk.map((r) => r.cnp_codigo),
      chunk.map((r) => r.quantidade),
      chunk.map((r) => Number(r.valor_total.toFixed(2))),
      chunk.map((r) => r.data_venda),
      chunk.map((r) => r.granularidade)
    );
    onBatch?.(Math.min(i + chunk.length, uniqueRows.length), uniqueRows.length);
  }
  return uniqueRows.length;
}

async function bulkUpsertSnapshots(
  prisma: PrismaClient,
  rows: Array<{ farmaciaId: string; cnp_codigo: string; data_snapshot: Date; quantidade: number; custo_unitario: number; valor_total: number }>,
  onBatch?: (done: number, total: number) => void
) {
  const dedup = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    dedup.set(`${r.farmaciaId}|${r.cnp_codigo}|${r.data_snapshot.toISOString()}`, r);
  }
  const uniqueRows = Array.from(dedup.values());
  for (let i = 0; i < uniqueRows.length; i += BULK_BATCH_SIZE) {
    const chunk = uniqueRows.slice(i, i + BULK_BATCH_SIZE);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "InventarioSnapshot" ("id", "farmaciaId", "cnp_codigo", "data_snapshot", "quantidade", "custo_unitario", "valor_total", "data_extracao")
       SELECT gen_random_uuid()::text, u.fid, u.cnp, u.dt, u.qtd, u.custo, u.val, NOW()
       FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::int[], $5::numeric[], $6::numeric[])
         AS u(fid, cnp, dt, qtd, custo, val)
       ON CONFLICT ("farmaciaId", "cnp_codigo", "data_snapshot")
       DO UPDATE SET "quantidade" = EXCLUDED."quantidade", "custo_unitario" = EXCLUDED."custo_unitario", "valor_total" = EXCLUDED."valor_total", "data_extracao" = NOW()`,
      chunk.map((r) => r.farmaciaId),
      chunk.map((r) => r.cnp_codigo),
      chunk.map((r) => r.data_snapshot),
      chunk.map((r) => r.quantidade),
      chunk.map((r) => Number(r.custo_unitario.toFixed(2))),
      chunk.map((r) => Number(r.valor_total.toFixed(2)))
    );
    onBatch?.(Math.min(i + chunk.length, uniqueRows.length), uniqueRows.length);
  }
  return uniqueRows.length;
}

async function bulkUpsertInventario(
  prisma: PrismaClient,
  rows: Array<{ farmaciaId: string; cnp_codigo: string; lote: string; quantidade: number; custo_unitario: number }>,
  onBatch?: (done: number, total: number) => void
) {
  const dedup = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    dedup.set(`${r.farmaciaId}|${r.cnp_codigo}|${r.lote}`, r);
  }
  const uniqueRows = Array.from(dedup.values());
  for (let i = 0; i < uniqueRows.length; i += BULK_BATCH_SIZE) {
    const chunk = uniqueRows.slice(i, i + BULK_BATCH_SIZE);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Inventario" ("id", "farmaciaId", "cnp_codigo", "lote", "quantidade", "custo_unitario", "data_extracao")
       SELECT gen_random_uuid()::text, u.fid, u.cnp, u.lote, u.qtd, u.custo, NOW()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::numeric[])
         AS u(fid, cnp, lote, qtd, custo)
       ON CONFLICT ("farmaciaId", "cnp_codigo", "lote")
       DO UPDATE SET "quantidade" = EXCLUDED."quantidade", "custo_unitario" = EXCLUDED."custo_unitario", "data_extracao" = NOW()`,
      chunk.map((r) => r.farmaciaId),
      chunk.map((r) => r.cnp_codigo),
      chunk.map((r) => r.lote),
      chunk.map((r) => r.quantidade),
      chunk.map((r) => Number(r.custo_unitario.toFixed(2)))
    );
    onBatch?.(Math.min(i + chunk.length, uniqueRows.length), uniqueRows.length);
  }
  return uniqueRows.length;
}

async function bulkUpsertPrecos(
  prisma: PrismaClient,
  rows: Array<{ farmaciaId: string; cnp_codigo: string; pvp: number; custo_ref: number }>,
  onBatch?: (done: number, total: number) => void
) {
  const dedup = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    dedup.set(`${r.farmaciaId}|${r.cnp_codigo}`, r);
  }
  const uniqueRows = Array.from(dedup.values());
  for (let i = 0; i < uniqueRows.length; i += BULK_BATCH_SIZE) {
    const chunk = uniqueRows.slice(i, i + BULK_BATCH_SIZE);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PrecoFarmacia" ("farmaciaId", "cnp_codigo", "pvp", "custo_ref", "atualizadoEm")
       SELECT u.fid, u.cnp, u.pvp, u.custo, NOW()
       FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[])
         AS u(fid, cnp, pvp, custo)
       ON CONFLICT ("farmaciaId", "cnp_codigo")
       DO UPDATE SET "pvp" = EXCLUDED."pvp", "custo_ref" = EXCLUDED."custo_ref", "atualizadoEm" = NOW()`,
      chunk.map((r) => r.farmaciaId),
      chunk.map((r) => r.cnp_codigo),
      chunk.map((r) => Number(r.pvp.toFixed(2))),
      chunk.map((r) => Number(r.custo_ref.toFixed(2)))
    );
    onBatch?.(Math.min(i + chunk.length, uniqueRows.length), uniqueRows.length);
  }
  return uniqueRows.length;
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

      // Deteção automática dos novos formatos PDF Sifarma (Inventário Normal e Produtos sem Consumo)
      if (isPdfBuffer(f.buffer, f.name)) {
        const { kind, lines } = await detectSifarmaPdfKind(f.buffer);
        if (kind === 'SIFARMA_INVENTARIO_NORMAL') {
          const parsedInv = parseSifarmaInventarioNormalLines(lines);
          const questions: InspectionQuestion[] = [];
          if (parsedInv.farmaciaNif && parsedInv.farmaciaNif !== farmaciaAtiva.nif) {
            questions.push({
              id: 'nif_action',
              title: 'NIF Divergente Detetado',
              description: `O documento indica NIF ${parsedInv.farmaciaNif} (${parsedInv.farmaciaNome || 'Farmácia'}), mas a farmácia ativa é ${farmaciaAtiva.nome} (NIF: ${farmaciaAtiva.nif}).`,
              defaultValue: 'link_to_current',
              options: [
                {
                  value: 'link_to_current',
                  label: `Associar à farmácia ativa (${farmaciaAtiva.nome})`,
                  isRecommended: true,
                },
              ],
            });
          }
          questions.push({
            id: 'stock_action',
            title: 'Importação de Inventário Normal Sifarma',
            description: `Foram lidos ${parsedInv.rows.length} artigos com PVP e Custo Unitário sem IVA (data: ${parsedInv.dataImpressao || 'atual'}).`,
            defaultValue: 'update_active',
            options: [
              {
                value: 'update_active',
                label: 'Atualizar existências ativas, PVP/CMP e guardar Snapshot histórico (Recomendado)',
                isRecommended: true,
              },
              {
                value: 'snapshot_only',
                label: 'Guardar apenas Snapshot histórico (sem alterar o stock ativo atual)',
                isRecommended: false,
              },
            ],
          });

          results.push({
            fileName: f.name,
            fileType: 'INVENTARIO_SIFARMA',
            periodo: `Inventário Normal (${parsedInv.dataImpressao || 'atual'})`,
            dataInicio: parsedInv.dataImpressao,
            dataFim: parsedInv.dataImpressao,
            anoReferencia: parsedInv.dataImpressao ? parseInt(parsedInv.dataImpressao.slice(0, 4), 10) : new Date().getUTCFullYear(),
            nifDetectado: parsedInv.farmaciaNif,
            farmaciaNomeDetectada: parsedInv.farmaciaNome,
            totalArtigos: parsedInv.rows.length,
            questions,
            status: parsedInv.rows.length > 0 ? 'READY' : 'ERROR',
            errorMessage: parsedInv.rows.length === 0 ? 'Nenhum artigo extraído do PDF de Inventário Normal.' : undefined,
          });
          continue;
        }

        if (kind === 'SIFARMA_INVENTARIO_IVA') {
          const parsedIva = parseSifarmaInventarioIvaLines(lines);
          const questions: InspectionQuestion[] = [];
          if (parsedIva.farmaciaNif && parsedIva.farmaciaNif !== farmaciaAtiva.nif) {
            questions.push({
              id: 'nif_action',
              title: 'NIF Divergente Detetado',
              description: `O documento indica NIF ${parsedIva.farmaciaNif} (${parsedIva.farmaciaNome || 'Farmácia'}), mas a farmácia ativa é ${farmaciaAtiva.nome} (NIF: ${farmaciaAtiva.nif}).`,
              defaultValue: 'link_to_current',
              options: [
                {
                  value: 'link_to_current',
                  label: `Associar à farmácia ativa (${farmaciaAtiva.nome})`,
                  isRecommended: true,
                },
              ],
            });
          }

          // Verifica se já existe um snapshot mais recente na BD para proteger o stock ativo
          const latestSnap = await prisma.inventarioSnapshot.findFirst({
            where: { farmaciaId: farmaciaAtiva.id },
            orderBy: { data_snapshot: 'desc' },
            select: { data_snapshot: true },
          });
          const pdfDate = parsedIva.dataImpressao ? new Date(`${parsedIva.dataImpressao}T23:59:59.000Z`) : null;
          const isOlderThanLatest = Boolean(latestSnap && pdfDate && latestSnap.data_snapshot > pdfDate);

          questions.push({
            id: 'stock_action',
            title: isOlderThanLatest
              ? 'Inventário por Taxas de IVA (Data Anterior ao Stock Atual)'
              : 'Inventário por Taxas de IVA (Sifarma)',
            description: isOlderThanLatest
              ? `Este inventário é de ${parsedIva.dataImpressao} (${parsedIva.rows.length} artigos), anterior ao último fecho na BD (${latestSnap!.data_snapshot.toISOString().slice(0, 10)}). Recomendamos guardar apenas como Snapshot Histórico + Taxas de IVA oficiais.`
              : `Foram lidos ${parsedIva.rows.length} artigos com Custo Unitário e Taxa de IVA oficial (data: ${parsedIva.dataImpressao || 'atual'}).`,
            defaultValue: isOlderThanLatest ? 'snapshot_only' : 'update_active',
            options: isOlderThanLatest
              ? [
                  {
                    value: 'snapshot_only',
                    label: 'Guardar Snapshot Histórico + Taxas de IVA oficiais (Recomendado: preserva o stock ativo mais recente)',
                    isRecommended: true,
                  },
                  {
                    value: 'update_active',
                    label: 'Substituir também o stock ativo atual por esta data anterior',
                    isRecommended: false,
                  },
                ]
              : [
                  {
                    value: 'update_active',
                    label: 'Atualizar existências ativas, Taxas de IVA oficiais e guardar Snapshot histórico (Recomendado)',
                    isRecommended: true,
                  },
                  {
                    value: 'snapshot_only',
                    label: 'Guardar apenas Snapshot Histórico + Taxas de IVA oficiais (sem alterar o stock ativo)',
                    isRecommended: false,
                  },
                ],
          });

          results.push({
            fileName: f.name,
            fileType: 'INVENTARIO_IVA_SIFARMA',
            periodo: `Inventário por Taxas de IVA (${parsedIva.dataImpressao || 'atual'})`,
            dataInicio: parsedIva.dataImpressao,
            dataFim: parsedIva.dataImpressao,
            anoReferencia: parsedIva.dataImpressao ? parseInt(parsedIva.dataImpressao.slice(0, 4), 10) : new Date().getUTCFullYear(),
            nifDetectado: parsedIva.farmaciaNif,
            farmaciaNomeDetectada: parsedIva.farmaciaNome,
            totalArtigos: parsedIva.rows.length,
            questions,
            status: parsedIva.rows.length > 0 ? 'READY' : 'ERROR',
            errorMessage: parsedIva.rows.length === 0 ? 'Nenhum artigo extraído do PDF de Inventário por Taxas de IVA.' : undefined,
          });
          continue;
        }

        if (kind === 'SIFARMA_SEM_CONSUMO') {
          const parsedSc = parseSifarmaSemConsumoLines(lines);
          const questions: InspectionQuestion[] = [];
          if (parsedSc.farmaciaNif && parsedSc.farmaciaNif !== farmaciaAtiva.nif) {
            questions.push({
              id: 'nif_action',
              title: 'NIF Divergente Detetado',
              description: `O documento indica NIF ${parsedSc.farmaciaNif} (${parsedSc.farmaciaNome || 'Farmácia'}), mas a farmácia ativa é ${farmaciaAtiva.nome} (NIF: ${farmaciaAtiva.nif}).`,
              defaultValue: 'link_to_current',
              options: [
                {
                  value: 'link_to_current',
                  label: `Associar à farmácia ativa (${farmaciaAtiva.nome})`,
                  isRecommended: true,
                },
              ],
            });
          }
          const comprasRecentes = parsedSc.rows.filter((r) => r.dataUltimaCompra && parsedSc.semConsumoDesde && r.dataUltimaCompra >= parsedSc.semConsumoDesde).length;
          questions.push({
            id: 'stock_action',
            title: 'Lista de Produtos sem Consumo (Enriquecimento Não-Destrutivo)',
            description: `Detetados ${parsedSc.rows.length} produtos sem vendas desde ${parsedSc.semConsumoDesde || 'há >12M'} (${comprasRecentes} comprados recentemente apesar de não rodarem!). Não apaga nem altera stock ou custos reais existentes.`,
            defaultValue: 'update_active',
            options: [
              {
                value: 'update_active',
                label: 'Enriquecimento Não-Destrutivo (Recomendado: grava Última Compra, Última Venda histórica, IVA e PVP em falta — preserva stock e custos reais)',
                isRecommended: true,
              },
            ],
          });

          results.push({
            fileName: f.name,
            fileType: 'SEM_CONSUMO_SIFARMA',
            periodo: `Sem Consumo desde ${parsedSc.semConsumoDesde || '12M'}`,
            dataInicio: parsedSc.semConsumoDesde,
            dataFim: parsedSc.dataImpressao,
            anoReferencia: parsedSc.dataImpressao ? parseInt(parsedSc.dataImpressao.slice(0, 4), 10) : new Date().getUTCFullYear(),
            nifDetectado: parsedSc.farmaciaNif,
            farmaciaNomeDetectada: parsedSc.farmaciaNome,
            totalArtigos: parsedSc.rows.length,
            questions,
            status: parsedSc.rows.length > 0 ? 'READY' : 'ERROR',
            errorMessage: parsedSc.rows.length === 0 ? 'Nenhum artigo extraído do PDF de Produtos sem Consumo.' : undefined,
          });
          continue;
        }
      }

      // Tenta parse como Vendas (PDF Winphar ou CSV multi-formato)
      const parsedVen = await parseVendasAnyFormat(f.buffer, f.name);
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
              label: 'Manter vendas existentes na base de dados (ignora apenas vendas; respeita a opção de stock abaixo)',
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
  const importStartTime = Date.now();
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

        // Calcular todas as atualizações FEFO em memória e executar em Bulk SQL (100x mais rápido)
        const updatesById = new Map<string, Date>();
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
            const prevBest = updatesById.get(inv.id) || inv.data_validade;
            const bestDate = prevBest && prevBest < novaDataValidade ? prevBest : novaDataValidade;
            updatesById.set(inv.id, bestDate);
          }
        }

        const updateEntries = Array.from(updatesById.entries());
        for (let i = 0; i < updateEntries.length; i += BULK_BATCH_SIZE) {
          const chunk = updateEntries.slice(i, i + BULK_BATCH_SIZE);
          await prisma.$executeRawUnsafe(
            `UPDATE "Inventario" AS i
             SET "data_validade" = u.dt
             FROM unnest($1::text[], $2::timestamptz[]) AS u(id, dt)
             WHERE i."id" = u.id`,
            chunk.map(([id]) => id),
            chunk.map(([, dt]) => dt)
          );
          valUpdatedCount += chunk.length;
          onProgress?.(
            basePct + Math.round(fileSlice * (0.3 + (0.6 * Math.min(i + chunk.length, updateEntries.length)) / Math.max(1, updateEntries.length))),
            `A atualizar prazos de validade em lote (FEFO)...`,
            `${Math.min(i + chunk.length, updateEntries.length)} de ${updateEntries.length} inventários atualizados`
          );
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
      // CASO A2: Novos Formatos PDF Sifarma (Inventário Normal / Produtos sem Consumo)
      // ----------------------------------------------------
      if (isPdfBuffer(f.buffer, f.name)) {
        const { kind, lines } = await detectSifarmaPdfKind(f.buffer);

        if (kind === 'SIFARMA_INVENTARIO_NORMAL') {
          const parsedInv = parseSifarmaInventarioNormalLines(lines);
          const targetFarmaciaId = farmacia.id;
          const stockPolicy = fileDecisions.stockAction || 'update_active';
          const snapDate = parsedInv.dataImpressao ? new Date(`${parsedInv.dataImpressao}T23:59:59.000Z`) : new Date();

          onProgress?.(
            basePct + Math.round(fileSlice * 0.2),
            `A preparar catálogo do Inventário Normal Sifarma...`,
            `${parsedInv.rows.length} artigos lidos`
          );

          // 1. Produtos novos em ProdutoMestre (skipDuplicates, já classificados em memória)
          const uniqueProds = new Map<string, { cnp_codigo: string; designacao: string; tipo_venda: string; macro_area: string | null; categoria: string; subcategoria: string | null; sazonalidade: string | null; aim?: string | null }>();
          for (const r of parsedInv.rows) {
            const cnp = normalizeCnp(r.codigo);
            const cls = classifyProduct(cnp, r.designacao, null);
            uniqueProds.set(cnp, {
              cnp_codigo: cnp,
              designacao: r.designacao,
              tipo_venda: cls.tipo_venda,
              macro_area: cls.macro_area || null,
              categoria: cls.categoria,
              subcategoria: cls.subcategoria || null,
              sazonalidade: cls.sazonalidade || null,
              aim: r.aim || null,
            });
          }
          const prodChunks = Array.from(uniqueProds.values());
          for (let i = 0; i < prodChunks.length; i += 500) {
            const resCreate = await prisma.produtoMestre.createMany({
              data: prodChunks.slice(i, i + 500),
              skipDuplicates: true,
            });
            stats.totalProdutosNovos += resCreate.count;
          }

          // 2. Snapshots históricos (Marco Zero / Fecho)
          const snapRows = parsedInv.rows.map((r) => {
            const cnp = normalizeCnp(r.codigo);
            return {
              farmaciaId: targetFarmaciaId,
              cnp_codigo: cnp,
              data_snapshot: snapDate,
              quantidade: r.stock,
              custo_unitario: r.custoUnitario,
              valor_total: Number((r.stock * r.custoUnitario).toFixed(2)),
            };
          });
          const snapshotsCount = await bulkUpsertSnapshots(prisma, snapRows);
          stats.totalSnapshotsStockCriados += snapshotsCount;

          let activeStockCount = 0;
          if (stockPolicy === 'update_active') {
            const invRows = parsedInv.rows.map((r) => ({
              farmaciaId: targetFarmaciaId,
              cnp_codigo: normalizeCnp(r.codigo),
              lote: r.lote || 'LOTE ÚNICO',
              quantidade: r.stock,
              custo_unitario: r.custoUnitario,
            }));
            activeStockCount = await bulkUpsertInventario(prisma, invRows);
            stats.totalInventarioAtivoAtualizado += activeStockCount;

            const precosRows = parsedInv.rows
              .filter((r) => r.pvp > 0 || r.custoUnitario > 0)
              .map((r) => ({
                farmaciaId: targetFarmaciaId,
                cnp_codigo: normalizeCnp(r.codigo),
                pvp: r.pvp,
                custo_ref: r.custoUnitario,
              }));
            if (precosRows.length > 0) {
              await bulkUpsertPrecos(prisma, precosRows);
            }
          }

          stats.filesProcessed++;
          stats.detalhesPorFicheiro.push({
            fileName: f.name,
            sucesso: true,
            tipo: 'INVENTARIO_SIFARMA',
            stockSnapshots: snapshotsCount,
            mensagem: `${parsedInv.rows.length} artigos de Inventário Normal Sifarma integrados (${snapshotsCount} snapshots${activeStockCount > 0 ? `, ${activeStockCount} stocks + preços PVP/CMP atualizados` : ''}).`,
          });
          continue;
        }

        if (kind === 'SIFARMA_INVENTARIO_IVA') {
          const parsedIva = parseSifarmaInventarioIvaLines(lines);
          const targetFarmaciaId = farmacia.id;
          const stockPolicy = fileDecisions.stockAction || 'snapshot_only';
          const snapDate = parsedIva.dataImpressao ? new Date(`${parsedIva.dataImpressao}T23:59:59.000Z`) : new Date();

          onProgress?.(
            basePct + Math.round(fileSlice * 0.2),
            `A integrar Inventário por Taxas de IVA (Sifarma)...`,
            `${parsedIva.rows.length} artigos lidos`
          );

          // 1. Produtos novos em ProdutoMestre com taxa_iva oficial
          const uniqueProds = new Map<string, { cnp_codigo: string; designacao: string; tipo_venda: string; macro_area: string | null; categoria: string; subcategoria: string | null; sazonalidade: string | null; taxa_iva: number; aim?: string | null }>();
          for (const r of parsedIva.rows) {
            const cnp = normalizeCnp(r.codigo);
            const cls = classifyProduct(cnp, r.designacao, r.taxaIva);
            uniqueProds.set(cnp, {
              cnp_codigo: cnp,
              designacao: r.designacao,
              tipo_venda: cls.tipo_venda,
              macro_area: cls.macro_area || null,
              categoria: cls.categoria,
              subcategoria: cls.subcategoria || null,
              sazonalidade: cls.sazonalidade || null,
              taxa_iva: r.taxaIva,
              aim: r.aim || null,
            });
          }
          const prodChunks = Array.from(uniqueProds.values());
          for (let i = 0; i < prodChunks.length; i += 500) {
            const resCreate = await prisma.produtoMestre.createMany({
              data: prodChunks.slice(i, i + 500),
              skipDuplicates: true,
            });
            stats.totalProdutosNovos += resCreate.count;
          }

          // 2. Atualizar taxa_iva oficial em ProdutoMestre (fonte oficial Sifarma por taxa de IVA)
          const ivaDedup = new Map<string, number>();
          parsedIva.rows.forEach((r) => ivaDedup.set(normalizeCnp(r.codigo), r.taxaIva));
          const ivaEntries = Array.from(ivaDedup.entries());
          for (let i = 0; i < ivaEntries.length; i += BULK_BATCH_SIZE) {
            const chunk = ivaEntries.slice(i, i + BULK_BATCH_SIZE);
            await prisma.$executeRawUnsafe(
              `UPDATE "ProdutoMestre" AS p
               SET "taxa_iva" = u.iva
               FROM unnest($1::text[], $2::int[]) AS u(cnp, iva)
               WHERE p."cnp_codigo" = u.cnp`,
              chunk.map(([cnp]) => cnp),
              chunk.map(([, iva]) => iva)
            );
          }

          // 3. Snapshots históricos
          const snapRows = parsedIva.rows.map((r) => ({
            farmaciaId: targetFarmaciaId,
            cnp_codigo: normalizeCnp(r.codigo),
            data_snapshot: snapDate,
            quantidade: r.stock,
            custo_unitario: r.custoUnitario,
            valor_total: Number(r.valorSemIva.toFixed(2)),
          }));
          const snapshotsCount = await bulkUpsertSnapshots(prisma, snapRows);
          stats.totalSnapshotsStockCriados += snapshotsCount;

          // 4. Stock ativo apenas se o utilizador escolheu update_active
          let activeStockCount = 0;
          if (stockPolicy === 'update_active') {
            const invRows = parsedIva.rows.map((r) => ({
              farmaciaId: targetFarmaciaId,
              cnp_codigo: normalizeCnp(r.codigo),
              lote: r.lote || 'LOTE ÚNICO',
              quantidade: r.stock,
              custo_unitario: r.custoUnitario,
            }));
            activeStockCount = await bulkUpsertInventario(prisma, invRows);
            stats.totalInventarioAtivoAtualizado += activeStockCount;
          }

          stats.filesProcessed++;
          stats.detalhesPorFicheiro.push({
            fileName: f.name,
            sucesso: true,
            tipo: 'INVENTARIO_IVA_SIFARMA',
            stockSnapshots: snapshotsCount,
            mensagem: `${parsedIva.rows.length} artigos integrados (${snapshotsCount} snapshots de ${parsedIva.dataImpressao || 'data do doc'}, ${ivaEntries.length} taxas de IVA oficiais atualizadas${activeStockCount > 0 ? `, ${activeStockCount} stocks ativos atualizados` : '; stock ativo preservado'}).`,
          });
          continue;
        }

        if (kind === 'SIFARMA_SEM_CONSUMO') {
          const parsedSc = parseSifarmaSemConsumoLines(lines);
          const targetFarmaciaId = farmacia.id;

          onProgress?.(
            basePct + Math.round(fileSlice * 0.25),
            `A integrar Lista de Produtos sem Consumo (Sifarma)...`,
            `${parsedSc.rows.length} produtos sem consumo detetados`
          );

          // 1. Criar produtos novos em ProdutoMestre com Família/Sub-Família, classificação completa e IVA real
          const uniqueProds = new Map<string, { cnp_codigo: string; designacao: string; tipo_venda: string; macro_area: string | null; categoria: string; subcategoria: string | null; sazonalidade: string | null; taxa_iva: number | null; aim: string | null }>();
          for (const r of parsedSc.rows) {
            const cnp = normalizeCnp(r.codigo);
            const cls = classifyProduct(cnp, r.designacao, r.taxaIvaEstimada);
            uniqueProds.set(cnp, {
              cnp_codigo: cnp,
              designacao: r.designacao,
              tipo_venda: cls.tipo_venda,
              macro_area: cls.macro_area || null,
              categoria: r.familia || cls.categoria,
              subcategoria: r.subfamilia || cls.subcategoria || null,
              sazonalidade: cls.sazonalidade || null,
              taxa_iva: r.taxaIvaEstimada,
              aim: r.aim || null,
            });
          }
          const prodChunks = Array.from(uniqueProds.values());
          for (let i = 0; i < prodChunks.length; i += 500) {
            const resCreate = await prisma.produtoMestre.createMany({
              data: prodChunks.slice(i, i + 500),
              skipDuplicates: true,
            });
            stats.totalProdutosNovos += resCreate.count;
          }

          // 2. Enriquecer IVA real em ProdutoMestre onde estava em falta (não destrutivo)
          const ivaUpdates = parsedSc.rows
            .filter((r) => r.taxaIvaEstimada !== null)
            .map((r) => ({ cnp: normalizeCnp(r.codigo), iva: r.taxaIvaEstimada as number }));
          const ivaDedup = new Map<string, number>();
          ivaUpdates.forEach((u) => ivaDedup.set(u.cnp, u.iva));
          const ivaEntries = Array.from(ivaDedup.entries());
          for (let i = 0; i < ivaEntries.length; i += BULK_BATCH_SIZE) {
            const chunk = ivaEntries.slice(i, i + BULK_BATCH_SIZE);
            await prisma.$executeRawUnsafe(
              `UPDATE "ProdutoMestre" AS p
               SET "taxa_iva" = COALESCE(p."taxa_iva", u.iva)
               FROM unnest($1::text[], $2::int[]) AS u(cnp, iva)
               WHERE p."cnp_codigo" = u.cnp AND p."taxa_iva" IS NULL`,
              chunk.map(([cnp]) => cnp),
              chunk.map(([, iva]) => iva)
            );
          }

          // 3. Enriquecer PVP em PrecoFarmacia (NÃO-DESTRUTIVO: nunca sobrescreve custo_ref nem PVP já preenchido)
          const pvpDedup = new Map<string, number>();
          for (const r of parsedSc.rows) {
            if (r.pvp > 0) pvpDedup.set(normalizeCnp(r.codigo), Number(r.pvp.toFixed(2)));
          }
          const pvpEntries = Array.from(pvpDedup.entries());
          for (let i = 0; i < pvpEntries.length; i += BULK_BATCH_SIZE) {
            const chunk = pvpEntries.slice(i, i + BULK_BATCH_SIZE);
            await prisma.$executeRawUnsafe(
              `INSERT INTO "PrecoFarmacia" ("farmaciaId", "cnp_codigo", "pvp", "atualizadoEm")
               SELECT $1, u.cnp, u.pvp, NOW()
               FROM unnest($2::text[], $3::numeric[]) AS u(cnp, pvp)
               ON CONFLICT ("farmaciaId", "cnp_codigo")
               DO UPDATE SET
                 "pvp" = CASE WHEN "PrecoFarmacia"."pvp" IS NULL OR "PrecoFarmacia"."pvp" = 0 THEN EXCLUDED."pvp" ELSE "PrecoFarmacia"."pvp" END,
                 "atualizadoEm" = NOW()`,
              targetFarmaciaId,
              chunk.map(([cnp]) => cnp),
              chunk.map(([, pvp]) => pvp)
            );
          }

          // 4. Inventario NÃO-DESTRUTIVO: insere apenas CNPs que ainda não existam em Inventario
          //    (NUNCA altera quantidade nem custo_unitario de artigos já existentes!)
          const invDedup = new Map<string, { qtd: number; prat: string | null }>();
          for (const r of parsedSc.rows) {
            if (r.stock > 0) {
              invDedup.set(normalizeCnp(r.codigo), { qtd: r.stock, prat: r.prateleira || null });
            }
          }
          const invEntries = Array.from(invDedup.entries());
          let insertedMissingInv = 0;
          for (let i = 0; i < invEntries.length; i += BULK_BATCH_SIZE) {
            const chunk = invEntries.slice(i, i + BULK_BATCH_SIZE);
            const affected = await prisma.$executeRawUnsafe(
              `INSERT INTO "Inventario" ("id", "farmaciaId", "cnp_codigo", "lote", "prateleira", "quantidade", "custo_unitario", "data_extracao")
               SELECT gen_random_uuid()::text, $1, u.cnp, 'LOTE ÚNICO', u.prat, u.qtd, 0, NOW()
               FROM unnest($2::text[], $3::text[], $4::int[]) AS u(cnp, prat, qtd)
               ON CONFLICT ("farmaciaId", "cnp_codigo", "lote") DO NOTHING`,
              targetFarmaciaId,
              chunk.map(([cnp]) => cnp),
              chunk.map(([, v]) => v.prat),
              chunk.map(([, v]) => v.qtd)
            );
            insertedMissingInv += Number(affected || 0);
          }
          const activeStockCount = insertedMissingInv;
          stats.totalInventarioAtivoAtualizado += activeStockCount;

          // 4B. Gravar data_ultima_compra (e prateleira onde faltar) no Inventario para deteção de compras em monos
          const compraUpdates = parsedSc.rows
            .filter((r) => r.dataUltimaCompra)
            .map((r) => ({
              cnp: normalizeCnp(r.codigo),
              dt: new Date(`${r.dataUltimaCompra}T12:00:00.000Z`),
              prat: r.prateleira || null,
            }));
          const compraDedup = new Map<string, { dt: Date; prat: string | null }>();
          for (const u of compraUpdates) {
            const prev = compraDedup.get(u.cnp);
            if (!prev || u.dt > prev.dt) compraDedup.set(u.cnp, { dt: u.dt, prat: u.prat });
          }
          const compraEntries = Array.from(compraDedup.entries());
          let comprasAtualizadas = 0;
          for (let i = 0; i < compraEntries.length; i += BULK_BATCH_SIZE) {
            const chunk = compraEntries.slice(i, i + BULK_BATCH_SIZE);
            const affected = await prisma.$executeRawUnsafe(
              `UPDATE "Inventario" AS i
               SET "data_ultima_compra" = u.dt,
                   "prateleira" = COALESCE(u.prat, i."prateleira")
               FROM unnest($1::text[], $2::timestamptz[], $3::text[]) AS u(cnp, dt, prat)
               WHERE i."farmaciaId" = $4 AND i."cnp_codigo" = u.cnp`,
              chunk.map(([cnp]) => cnp),
              chunk.map(([, v]) => v.dt),
              chunk.map(([, v]) => v.prat),
              targetFarmaciaId
            );
            comprasAtualizadas += Number(affected || 0);
          }

          // 5. Registar data da última venda real (apenas para CNPs sem histórico de vendas na BD)
          const rowsWithLastSale = parsedSc.rows.filter((r) => r.dataUltimaVenda);
          let lastSaleRefsInserted = 0;
          if (rowsWithLastSale.length > 0) {
            const cnpsCheck = Array.from(new Set(rowsWithLastSale.map((r) => normalizeCnp(r.codigo))));
            const existingSales = await prisma.venda.findMany({
              where: { farmaciaId: targetFarmaciaId, cnp_codigo: { in: cnpsCheck } },
              select: { cnp_codigo: true },
              distinct: ['cnp_codigo'],
            });
            const hasSalesSet = new Set(existingSales.map((s) => s.cnp_codigo));
            const refSales = rowsWithLastSale
              .filter((r) => !hasSalesSet.has(normalizeCnp(r.codigo)) && r.dataUltimaVenda)
              .map((r) => ({
                farmaciaId: targetFarmaciaId,
                cnp_codigo: normalizeCnp(r.codigo),
                quantidade: 1,
                valor_total: Number((r.pvp || 0).toFixed(2)),
                data_venda: new Date(`${r.dataUltimaVenda}T12:00:00.000Z`),
                granularidade: 'REFERENCIA_ULTIMA_VENDA',
              }));
            if (refSales.length > 0) {
              lastSaleRefsInserted = await bulkUpsertVendas(prisma, refSales);
            }
          }

          const comprasRecentes = parsedSc.rows.filter(
            (r) => r.dataUltimaCompra && parsedSc.semConsumoDesde && r.dataUltimaCompra >= parsedSc.semConsumoDesde
          ).length;

          stats.filesProcessed++;
          stats.detalhesPorFicheiro.push({
            fileName: f.name,
            sucesso: true,
            tipo: 'SEM_CONSUMO_SIFARMA',
            stockSnapshots: comprasAtualizadas,
            mensagem: `${parsedSc.rows.length} produtos sem consumo analisados (não-destrutivo: ${comprasAtualizadas} datas de última compra gravadas, ${lastSaleRefsInserted} datas históricas de última venda, ${comprasRecentes} comprados recentemente sem rotação; stock e custos reais preservados).`,
          });
          continue;
        }
      }

      // ----------------------------------------------------
      // CASO B: Ficheiro de Vendas (PDF Winphar ou CSV multi-formato)
      // ----------------------------------------------------
      const parsedVen = await parseVendasAnyFormat(f.buffer, f.name);

      onProgress?.(
        basePct + Math.round(fileSlice * 0.15),
        `A preparar catálogo de produtos...`,
        `${parsedVen.rows.length} produtos lidos no documento`
      );

      // Decisão 1: NIF / Farmácia (Validação de fronteira estrita de Tenant)
      const targetFarmaciaId = farmacia.id;
      if (parsedVen.farmaciaNif && parsedVen.farmaciaNif !== farmacia.nif) {
        // 1. Bloquear se o NIF pertencer a qualquer outra farmácia existente (sem vazar qual)
        const outroTenant = await prisma.farmacia.findUnique({
          where: { nif: parsedVen.farmaciaNif },
        });
        if (outroTenant && outroTenant.id !== farmacia.id) {
          throw new Error('O ficheiro contém um NIF que não corresponde à sua farmácia e não pode ser importado.');
        }

        // 2. "create_new" contornaria o provisionamento exclusivo do Superadmin
        if (fileDecisions.nifAction === 'create_new') {
          throw new Error('A criação de novas farmácias no sistema é reservada à superadministração.');
        }

        // 3. "link_to_current" exige confirmação explícita do proprietário e regista evento de auditoria
        if (fileDecisions.nifAction === 'link_to_current') {
          await logSecurityAudit(prisma, {
            evento: 'IMPORT_COMPLETED',
            farmaciaId: farmacia.id,
            detalhes: {
              stage: 'import_nif_divergence',
              nifFicheiro: parsedVen.farmaciaNif,
              nifFarmacia: farmacia.nif,
              action: 'link_to_current_confirmed',
            },
          });
        }
      }

      // Decisão 2: Conflito de Período Existente e Política de Stock
      const stockAction = fileDecisions.stockAction || (parsedVen.anoVendas < 2026 ? 'snapshot_only' : 'update_active');
      const skipSales = fileDecisions.conflictAction === 'ignore';

      if (skipSales && stockAction === 'none') {
        stats.filesProcessed++;
        stats.detalhesPorFicheiro.push({
          fileName: f.name,
          sucesso: true,
          tipo: parsedVen.granularidade,
          vendas: 0,
          mensagem: 'Ignorado conforme instrução do utilizador (vendas e stock mantidos).',
        });
        continue;
      }

      if (!skipSales && fileDecisions.conflictAction === 'overwrite' && parsedVen.dataInicio && parsedVen.dataFim) {
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

      // 2. Inserir Vendas em Bulk SQL (lotes de 1.000 linhas — ~100x mais rápido que upsert individual)
      const vendasToInsert: Array<{
        farmaciaId: string;
        cnp_codigo: string;
        quantidade: number;
        valor_total: number;
        data_venda: Date;
        granularidade: string;
      }> = [];

      let vendasGravadas = 0;
      if (!skipSales) {
        for (const r of parsedVen.rows) {
          const cnp = normalizeCnp(r.codigo);
          const pvpNum = parsePtDecimal(r.pvp);
          const unitPvp = !Number.isNaN(pvpNum) ? pvpNum : 0;

          for (const [isoDate, qtd] of Object.entries(r.vendasMensais)) {
            if (qtd === 0) continue;
            vendasToInsert.push({
              farmaciaId: targetFarmaciaId,
              cnp_codigo: cnp,
              quantidade: qtd,
              valor_total: Number((qtd * unitPvp).toFixed(2)),
              data_venda: new Date(isoDate),
              granularidade: parsedVen.granularidade,
            });
          }
        }

        vendasGravadas = await bulkUpsertVendas(prisma, vendasToInsert, (done, total) => {
          const salesProgress = done / Math.max(1, total);
          onProgress?.(
            basePct + Math.round(fileSlice * (0.25 + 0.30 * salesProgress)),
            `A gravar vendas em lote na base de dados...`,
            `${done} de ${total} vendas gravadas`
          );
        });
        stats.totalVendasCriadas += vendasGravadas;
      }

      // 3. Gestão de Stock (Snapshot Histórico vs Atual)
      let snapshotsCount = 0;
      let activeStockCount = 0;

      const snapshotDate = parsedVen.dataFim ? new Date(parsedVen.dataFim) : new Date(Date.UTC(parsedVen.anoVendas, 11, 31, 23, 59, 59));

      if (stockAction === 'snapshot_only' || stockAction === 'update_active') {
        const snapshotsData: Array<{
          farmaciaId: string;
          cnp_codigo: string;
          data_snapshot: Date;
          quantidade: number;
          custo_unitario: number;
          valor_total: number;
        }> = [];

        for (const r of parsedVen.rows) {
          const cnp = normalizeCnp(r.codigo);
          const stockNum = parseInt(r.stock, 10);
          const pcNum = parsePtDecimal(r.pc);
          if (Number.isNaN(stockNum) || Number.isNaN(pcNum)) continue;

          snapshotsData.push({
            farmaciaId: targetFarmaciaId,
            cnp_codigo: cnp,
            data_snapshot: snapshotDate,
            quantidade: stockNum,
            custo_unitario: Number(pcNum.toFixed(2)),
            valor_total: Number((stockNum * pcNum).toFixed(2)),
          });
        }

        snapshotsCount = await bulkUpsertSnapshots(prisma, snapshotsData, (done, total) => {
          const snapProgress = done / Math.max(1, total);
          onProgress?.(
            basePct + Math.round(fileSlice * (0.55 + 0.18 * snapProgress)),
            `A criar snapshots de stock histórico (${parsedVen.anoVendas})...`,
            `${done} de ${total} posições de stock registadas`
          );
        });
        stats.totalSnapshotsStockCriados += snapshotsCount;
      }

      if (stockAction === 'update_active') {
        // Atualiza Inventario e PrecoFarmacia em Bulk SQL
        const invRows: Array<{
          farmaciaId: string;
          cnp_codigo: string;
          lote: string;
          quantidade: number;
          custo_unitario: number;
        }> = [];

        const precosRows: Array<{
          farmaciaId: string;
          cnp_codigo: string;
          pvp: number;
          custo_ref: number;
        }> = [];

        for (const r of parsedVen.rows) {
          const cnp = normalizeCnp(r.codigo);
          const stockNum = parseInt(r.stock, 10);
          const pcNum = parsePtDecimal(r.pc);
          const pvpNum = parsePtDecimal(r.pvp);

          if (!Number.isNaN(stockNum) && !Number.isNaN(pcNum)) {
            invRows.push({
              farmaciaId: targetFarmaciaId,
              cnp_codigo: cnp,
              lote: 'LOTE ÚNICO',
              quantidade: stockNum,
              custo_unitario: Number(pcNum.toFixed(2)),
            });
          }

          if (!Number.isNaN(pvpNum) && !Number.isNaN(pcNum)) {
            precosRows.push({
              farmaciaId: targetFarmaciaId,
              cnp_codigo: cnp,
              pvp: Number(pvpNum.toFixed(2)),
              custo_ref: Number(pcNum.toFixed(2)),
            });
          }
        }

        activeStockCount = await bulkUpsertInventario(prisma, invRows, (done, total) => {
          const invProgress = done / Math.max(1, total);
          onProgress?.(
            basePct + Math.round(fileSlice * (0.73 + 0.14 * invProgress)),
            `A atualizar inventário ativo em lote...`,
            `${done} de ${total} artigos atualizados`
          );
        });
        stats.totalInventarioAtivoAtualizado += activeStockCount;

        await bulkUpsertPrecos(prisma, precosRows, (done, total) => {
          const pProgress = done / Math.max(1, total);
          onProgress?.(
            basePct + Math.round(fileSlice * (0.87 + 0.08 * pProgress)),
            `A atualizar preços e custos em lote...`,
            `${done} de ${total} preços atualizados`
          );
        });
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

  stats.duracaoMs = Date.now() - importStartTime;
  const totalErros = stats.detalhesPorFicheiro.filter((d) => !d.sucesso).length;
  if (totalErros > 0 && stats.filesProcessed === 0) {
    onProgress?.(100, '❌ Importação falhou', `${totalErros} ficheiro(s) com erro. Consulte os detalhes abaixo.`);
  } else if (totalErros > 0) {
    onProgress?.(100, '⚠️ Importação concluída com erros', `${stats.filesProcessed} integrado(s), ${totalErros} com erro.`);
  } else {
    onProgress?.(100, '🎉 Importação Concluída com Sucesso!', 'Todos os dados foram processados.');
  }
  return stats;
}
