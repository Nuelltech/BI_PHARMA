import { PrismaClient, Prisma } from '@prisma/client';
import { classifyProduct } from './classifier';

export interface TransformationResult {
  totalLidos: number;
  processadosComSucesso: number;
  errosValidacao: number;
  detalhesErros: Array<{ id: string; codigo: string | null; erro: string }>;
}

/**
 * Limpa strings monetárias portuguesas (ex: "1.328,90€", "2,42 €", "0,00€")
 * e converte para número decimal válido.
 */
export function parsePortugueseDecimal(raw: string | null | undefined, fieldName: string): Prisma.Decimal {
  if (raw === null || raw === undefined || raw.trim() === '') {
    throw new Error(`Falha na conversão decimal: campo "${fieldName}" vazio`);
  }

  let cleaned = raw
    .replace(/€/g, '')
    .replace(/\s+/g, '')
    .trim();

  if (cleaned.includes('.') && cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Falha na conversão decimal em "${fieldName}": valor inválido "${raw}"`);
  }

  return new Prisma.Decimal(cleaned);
}

/**
 * Converte string de stock/quantidade (incluindo formatos como "- 1") para Int.
 */
export function parsePortugueseInt(raw: string | null | undefined, fieldName: string): number {
  if (raw === null || raw === undefined || raw.trim() === '') {
    throw new Error(`Falha na conversão inteira: campo "${fieldName}" vazio`);
  }

  const cleaned = raw.replace(/\s+/g, '').trim();
  if (!/^-?\d+$/.test(cleaned)) {
    throw new Error(`Falha na conversão inteira em "${fieldName}": valor inválido "${raw}"`);
  }

  const val = parseInt(cleaned, 10);
  if (Number.isNaN(val)) {
    throw new Error(`Falha na conversão inteira em "${fieldName}": "${raw}"`);
  }
  return val;
}

/**
 * Normaliza e valida o código CNP (7 dígitos numéricos).
 */
export function normalizeCnpCodigo(raw: string | null | undefined): string {
  if (!raw) {
    throw new Error('Código de produto ausente');
  }
  const cleaned = raw.replace(/\s+/g, '').trim();
  const padded = /^\d{6}$/.test(cleaned) ? cleaned.padStart(7, '0') : cleaned;

  if (!/^\d{7}$/.test(padded)) {
    throw new Error(`Código inválido "${raw}": deve conter 7 dígitos numéricos`);
  }
  return padded;
}

/**
 * Converte string "MM-YYYY" (ex: "12-2026") para o último dia do mês às 23:59:59Z.
 */
export function parseValidadeMMYYYY(raw: string | null | undefined): Date {
  if (!raw || raw.trim() === '') {
    throw new Error('Data de validade vazia');
  }
  const match = raw.trim().match(/^(\d{2})-(\d{4})$/);
  if (!match) {
    throw new Error(`Formato de validade inválido "${raw}": esperado MM-YYYY`);
  }
  const month = parseInt(match[1], 10);
  const year = parseInt(match[2], 10);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) {
    throw new Error(`Mês ou ano fora do intervalo válido na validade "${raw}"`);
  }
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 0));
}

/**
 * Transforma os registos pendentes de StagingInventario para ProdutoMestre e Inventario.
 */
export async function transformStagingInventario(
  prisma: PrismaClient,
  farmaciaId: string,
  batchId?: string
): Promise<TransformationResult> {
  const whereClause: Prisma.StagingInventarioWhereInput = {
    farmaciaId,
    processado: false,
    ...(batchId ? { batch_id: batchId } : {}),
  };

  const pendentes = await prisma.stagingInventario.findMany({
    where: whereClause,
    orderBy: { data_extracao: 'asc' },
  });

  const result: TransformationResult = {
    totalLidos: pendentes.length,
    processadosComSucesso: 0,
    errosValidacao: 0,
    detalhesErros: [],
  };

  if (pendentes.length === 0) return result;

  interface ValidInvRow {
    stagingId: string;
    cnp_codigo: string;
    aim: string | null;
    designacao: string;
    taxaIva: number | null;
    lote: string;
    prateleira: string | null;
    quantidade: number;
    custo_unitario: Prisma.Decimal;
    data_extracao: Date;
  }

  const validRows: ValidInvRow[] = [];

  for (const row of pendentes) {
    try {
      const cnp_codigo = normalizeCnpCodigo(row.codigo);
      const quantidade = parsePortugueseInt(row.stock, 'Stock');
      const custo_unitario = parsePortugueseDecimal(row.custo_unit, 'Custo Unit.');
      if (row.valor_s_iva) {
        parsePortugueseDecimal(row.valor_s_iva, 'Valor S/ IVA');
      }

      const designacao = (row.designacao || '').trim();
      if (!designacao) {
        throw new Error('Designação do produto vazia');
      }

      const taxaIvaParsed = row.taxa_iva ? parseInt(row.taxa_iva.trim(), 10) : null;
      const taxaIva = taxaIvaParsed !== null && !Number.isNaN(taxaIvaParsed) ? taxaIvaParsed : null;
      const lote = (row.lote || 'LOTE ÚNICO').trim() || 'LOTE ÚNICO';
      const prateleira = row.prat ? row.prat.trim() : null;
      const aim = row.aim ? row.aim.trim() : null;

      validRows.push({
        stagingId: row.id,
        cnp_codigo,
        aim,
        designacao,
        taxaIva,
        lote,
        prateleira,
        quantidade,
        custo_unitario,
        data_extracao: row.data_extracao,
      });
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.stagingInventario.update({
        where: { id: row.id },
        data: {
          processado: false,
          erro_validacao: msg,
        },
      });
      result.errosValidacao++;
      result.detalhesErros.push({ id: row.id, codigo: row.codigo, erro: msg });
    }
  }

  if (validRows.length === 0) return result;

  // 1. Garantir ProdutoMestre para todos os códigos válidos (com classificação automática se não caracterizado)
  const uniqueProducts = new Map<
    string,
    {
      cnp_codigo: string;
      aim: string | null;
      designacao: string;
      taxa_iva: number | null;
      tipo_venda: string;
      categoria: string;
    }
  >();
  for (const r of validRows) {
    const classification = classifyProduct(r.cnp_codigo, r.designacao, r.taxaIva);
    uniqueProducts.set(r.cnp_codigo, {
      cnp_codigo: r.cnp_codigo,
      aim: r.aim,
      designacao: r.designacao,
      taxa_iva: r.taxaIva,
      tipo_venda: classification.tipo_venda,
      categoria: classification.categoria,
    });
  }

  await prisma.produtoMestre.createMany({
    data: Array.from(uniqueProducts.values()),
    skipDuplicates: true,
  });

  // Para produtos já existentes que ainda não tinham tipo_venda, categoria ou taxa_iva preenchidos, aplica a regra
  const existingUncharacterized = await prisma.produtoMestre.findMany({
    where: {
      cnp_codigo: { in: Array.from(uniqueProducts.keys()) },
      OR: [{ tipo_venda: null }, { categoria: null }, { taxa_iva: null }],
    },
  });

  for (let i = 0; i < existingUncharacterized.length; i += 250) {
    const chunk = existingUncharacterized.slice(i, i + 250);
    await prisma.$transaction(
      chunk.map((existing) => {
        const incoming = uniqueProducts.get(existing.cnp_codigo)!;
        const recalc = classifyProduct(
          existing.cnp_codigo,
          existing.designacao || incoming.designacao,
          incoming.taxa_iva ?? existing.taxa_iva
        );
        return prisma.produtoMestre.update({
          where: { cnp_codigo: existing.cnp_codigo },
          data: {
            tipo_venda: existing.tipo_venda || recalc.tipo_venda,
            categoria: existing.categoria || recalc.categoria,
            taxa_iva: existing.taxa_iva ?? incoming.taxa_iva,
            aim: existing.aim ?? incoming.aim,
          },
        });
      })
    );
  }

  // 2. Upsert em lotes na tabela Inventario
  const CHUNK_SIZE = 250;
  for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
    const chunk = validRows.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(
      chunk.map((r) =>
        prisma.inventario.upsert({
          where: {
            farmaciaId_cnp_codigo_lote: {
              farmaciaId,
              cnp_codigo: r.cnp_codigo,
              lote: r.lote,
            },
          },
          update: {
            prateleira: r.prateleira,
            quantidade: r.quantidade,
            custo_unitario: r.custo_unitario,
            data_extracao: r.data_extracao,
          },
          create: {
            farmaciaId,
            cnp_codigo: r.cnp_codigo,
            lote: r.lote,
            prateleira: r.prateleira,
            quantidade: r.quantidade,
            custo_unitario: r.custo_unitario,
            data_extracao: r.data_extracao,
          },
        })
      )
    );

    await prisma.stagingInventario.updateMany({
      where: { id: { in: chunk.map((c) => c.stagingId) } },
      data: { processado: true, erro_validacao: null },
    });

    result.processadosComSucesso += chunk.length;
  }

  return result;
}

/**
 * Transforma os registos pendentes de StagingValidades e atualiza data_validade na tabela Inventario.
 */
export async function transformStagingValidades(
  prisma: PrismaClient,
  farmaciaId: string,
  batchId?: string
): Promise<TransformationResult & { inventariosAtualizados: number }> {
  const whereClause: Prisma.StagingValidadesWhereInput = {
    farmaciaId,
    processado: false,
    ...(batchId ? { batch_id: batchId } : {}),
  };

  const pendentes = await prisma.stagingValidades.findMany({
    where: whereClause,
    orderBy: { data_extracao: 'asc' },
  });

  const result = {
    totalLidos: pendentes.length,
    processadosComSucesso: 0,
    errosValidacao: 0,
    inventariosAtualizados: 0,
    detalhesErros: [] as Array<{ id: string; codigo: string | null; erro: string }>,
  };

  if (pendentes.length === 0) return result;

  // Carrega inventário atual da farmácia em memória por cnp_codigo
  const inventarios = await prisma.inventario.findMany({
    where: { farmaciaId },
  });
  const invByCodigo = new Map<string, typeof inventarios>();
  for (const inv of inventarios) {
    const list = invByCodigo.get(inv.cnp_codigo) ?? [];
    list.push(inv);
    invByCodigo.set(inv.cnp_codigo, list);
  }

  const validStagingIds: string[] = [];
  const invUpdates = new Map<string, { id: string; data_validade: Date; prateleira?: string }>();

  for (const row of pendentes) {
    try {
      const cnp_codigo = normalizeCnpCodigo(row.codigo);
      const data_validade = parseValidadeMMYYYY(row.validade);
      if (row.stock !== null && row.stock !== undefined && row.stock.trim() !== '') {
        parsePortugueseInt(row.stock, 'Stock');
      }

      const matchingInvs = invByCodigo.get(cnp_codigo) ?? [];
      for (const inv of matchingInvs) {
        const existingUpdate = invUpdates.get(inv.id);
        const currentBestDate = existingUpdate?.data_validade ?? inv.data_validade;
        // Regra FEFO: guarda a data de validade mais próxima
        const novaValidade = currentBestDate && currentBestDate < data_validade ? currentBestDate : data_validade;

        invUpdates.set(inv.id, {
          id: inv.id,
          data_validade: novaValidade,
          ...(row.pratel && row.pratel.trim() && !inv.prateleira ? { prateleira: row.pratel.trim() } : {}),
        });
      }

      validStagingIds.push(row.id);
      result.processadosComSucesso++;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.stagingValidades.update({
        where: { id: row.id },
        data: {
          processado: false,
          erro_validacao: msg,
        },
      });
      result.errosValidacao++;
      result.detalhesErros.push({ id: row.id, codigo: row.codigo, erro: msg });
    }
  }

  const updatesList = Array.from(invUpdates.values());
  const CHUNK_SIZE = 250;
  for (let i = 0; i < updatesList.length; i += CHUNK_SIZE) {
    const chunk = updatesList.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(
      chunk.map((u) =>
        prisma.inventario.update({
          where: { id: u.id },
          data: {
            data_validade: u.data_validade,
            ...(u.prateleira ? { prateleira: u.prateleira } : {}),
          },
        })
      )
    );
    result.inventariosAtualizados += chunk.length;
  }

  for (let i = 0; i < validStagingIds.length; i += 500) {
    const chunkIds = validStagingIds.slice(i, i + 500);
    await prisma.stagingValidades.updateMany({
      where: { id: { in: chunkIds } },
      data: { processado: true, erro_validacao: null },
    });
  }

  return result;
}

/**
 * Transforma os registos pendentes de StagingVendas para ProdutoMestre e Venda.
 */
export async function transformStagingVendas(
  prisma: PrismaClient,
  farmaciaId: string,
  batchId?: string
): Promise<TransformationResult> {
  const whereClause: Prisma.StagingVendasWhereInput = {
    farmaciaId,
    processado: false,
    ...(batchId ? { batch_id: batchId } : {}),
  };

  const pendentes = await prisma.stagingVendas.findMany({
    where: whereClause,
  });

  const result: TransformationResult = {
    totalLidos: pendentes.length,
    processadosComSucesso: 0,
    errosValidacao: 0,
    detalhesErros: [],
  };

  if (pendentes.length === 0) return result;

  interface ValidVendaRow {
    stagingId: string;
    cnp_codigo: string;
    designacao: string;
    quantidade: number;
    valor_total: Prisma.Decimal;
    pvp?: Prisma.Decimal;
    margem?: Prisma.Decimal;
    data_venda: Date;
  }

  const validRows: ValidVendaRow[] = [];

  for (const row of pendentes) {
    try {
      const cnp_codigo = normalizeCnpCodigo(row.codigo_produto);
      const quantidade = parsePortugueseInt(row.quantidade, 'Quantidade');
      const valor_total = parsePortugueseDecimal(row.valor_venda, 'Valor Venda');

      if (!row.data_movimento) {
        throw new Error('Data de movimento ausente');
      }
      const data_venda = new Date(row.data_movimento);
      if (Number.isNaN(data_venda.getTime())) {
        throw new Error(`Data de movimento inválida: "${row.data_movimento}"`);
      }

      const designacao = (row.descricao || 'Produto Sem Designação').trim();
      const pvp = row.pvp ? parsePortugueseDecimal(row.pvp, 'PVP') : undefined;
      const margem = row.margem ? parsePortugueseDecimal(row.margem, 'MG (%)') : undefined;

      validRows.push({
        stagingId: row.id,
        cnp_codigo,
        designacao,
        quantidade,
        valor_total,
        pvp,
        margem,
        data_venda,
      });
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.stagingVendas.update({
        where: { id: row.id },
        data: {
          processado: false,
          erro_validacao: msg,
        },
      });
      result.errosValidacao++;
      result.detalhesErros.push({ id: row.id, codigo: row.codigo_produto, erro: msg });
    }
  }

  if (validRows.length === 0) return result;

  // 1. Garantir ProdutoMestre e enriquecer PVP / Margem + Classificação Automática
  const uniqueProducts = new Map<
    string,
    {
      cnp_codigo: string;
      designacao: string;
      pvp?: Prisma.Decimal;
      margem_padrao?: Prisma.Decimal;
      tipo_venda: string;
      categoria: string;
    }
  >();
  for (const r of validRows) {
    const classification = classifyProduct(r.cnp_codigo, r.designacao, null);
    uniqueProducts.set(r.cnp_codigo, {
      cnp_codigo: r.cnp_codigo,
      designacao: r.designacao,
      ...(r.pvp ? { pvp: r.pvp } : {}),
      ...(r.margem ? { margem_padrao: r.margem } : {}),
      tipo_venda: classification.tipo_venda,
      categoria: classification.categoria,
    });
  }

  await prisma.produtoMestre.createMany({
    data: Array.from(uniqueProducts.values()),
    skipDuplicates: true,
  });

  // Atualiza PVP e margem (e preenche tipo_venda/categoria caso estivessem vazios) nos produtos existentes
  const existingMap = new Map(
    (
      await prisma.produtoMestre.findMany({
        where: { cnp_codigo: { in: Array.from(uniqueProducts.keys()) } },
        select: { cnp_codigo: true, tipo_venda: true, categoria: true, taxa_iva: true, designacao: true },
      })
    ).map((p) => [p.cnp_codigo, p])
  );

  const productsToUpdate = Array.from(uniqueProducts.values()).filter((p) => {
    const ex = existingMap.get(p.cnp_codigo);
    return p.pvp || p.margem_padrao || !ex?.tipo_venda || !ex?.categoria;
  });

  for (let i = 0; i < productsToUpdate.length; i += 250) {
    const chunk = productsToUpdate.slice(i, i + 250);
    await prisma.$transaction(
      chunk.map((p) => {
        const ex = existingMap.get(p.cnp_codigo);
        const recalc = classifyProduct(p.cnp_codigo, ex?.designacao || p.designacao, ex?.taxa_iva);
        return prisma.produtoMestre.update({
          where: { cnp_codigo: p.cnp_codigo },
          data: {
            ...(p.pvp ? { pvp: p.pvp } : {}),
            ...(p.margem_padrao ? { margem_padrao: p.margem_padrao } : {}),
            ...(!ex?.tipo_venda ? { tipo_venda: recalc.tipo_venda } : {}),
            ...(!ex?.categoria ? { categoria: recalc.categoria } : {}),
          },
        });
      })
    );
  }

  // 2. Inserir/atualizar vendas (em lotes de 500)
  const CHUNK_SIZE = 500;
  for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
    const chunk = validRows.slice(i, i + CHUNK_SIZE);
    const salesToUpsert = chunk.filter((r) => r.quantidade > 0);

    if (salesToUpsert.length > 0) {
      await prisma.$transaction(
        salesToUpsert.map((r) =>
          prisma.venda.upsert({
            where: {
              farmaciaId_cnp_codigo_data_venda: {
                farmaciaId,
                cnp_codigo: r.cnp_codigo,
                data_venda: r.data_venda,
              },
            },
            update: {
              quantidade: r.quantidade,
              valor_total: r.valor_total,
            },
            create: {
              farmaciaId,
              cnp_codigo: r.cnp_codigo,
              quantidade: r.quantidade,
              valor_total: r.valor_total,
              data_venda: r.data_venda,
            },
          })
        )
      );
    }

    await prisma.stagingVendas.updateMany({
      where: { id: { in: chunk.map((c) => c.stagingId) } },
      data: { processado: true, erro_validacao: null },
    });

    result.processadosComSucesso += chunk.length;
  }

  return result;
}
