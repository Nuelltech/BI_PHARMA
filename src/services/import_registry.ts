import { PrismaClient } from '@prisma/client';
import { invalidateCatalog } from './product_catalog.js';

// ============================================================================
// REGISTO DE IMPORTAÇÕES (Passo 4 — #22 e #26)
// Guarda o período real início–fim de cada ficheiro importado por farmácia,
// permitindo devolver `dados_ate` e `mes_parcial` reais (ex: 2026-11-11 na Farmácia A)
// e invalidar a cache do catálogo após cada importação.
// ============================================================================

export interface ImportRegistryEntry {
  id: string;
  farmacia_id: string;
  ficheiro: string;
  formato: string;
  tipo: string; // 'VENDAS' | 'INVENTARIO' | 'VALIDADES' | 'MISTO'
  periodo_inicio: string | null;
  periodo_fim: string; // YYYY-MM-DD (data real dos dados)
  mes_parcial: boolean;
  notas: string | null;
  criado_em: string;
}

let tableEnsured = false;

export async function ensureImportRegistryTable(prisma: PrismaClient): Promise<void> {
  if (tableEnsured) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "RegistoImportacao" (
      id TEXT PRIMARY KEY,
      farmacia_id TEXT NOT NULL,
      ficheiro TEXT NOT NULL,
      formato TEXT NOT NULL DEFAULT 'CSV',
      tipo TEXT NOT NULL DEFAULT 'VENDAS',
      periodo_inicio DATE NULL,
      periodo_fim DATE NOT NULL,
      mes_parcial BOOLEAN NOT NULL DEFAULT FALSE,
      notas TEXT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "idx_registo_importacao_farm_fim"
    ON "RegistoImportacao" (farmacia_id, tipo, periodo_fim DESC);
  `);
  tableEnsured = true;
}

export async function recordPharmacyImport(
  prisma: PrismaClient,
  params: {
    farmaciaId: string;
    ficheiro: string;
    formato?: string;
    tipo?: 'VENDAS' | 'INVENTARIO' | 'VALIDADES' | 'MISTO';
    periodoInicio?: string | null;
    periodoFim: string; // YYYY-MM-DD
    mesParcial?: boolean;
    notas?: string | null;
  }
): Promise<void> {
  await ensureImportRegistryTable(prisma);
  const id = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const fimDate = new Date(`${params.periodoFim.slice(0, 10)}T00:00:00Z`);
  // Se mesParcial não for explícito, inferir: se o dia do mês < último dia do mês - 2
  const lastDayOfMonth = new Date(Date.UTC(fimDate.getUTCFullYear(), fimDate.getUTCMonth() + 1, 0)).getUTCDate();
  const mesParcial =
    params.mesParcial !== undefined ? params.mesParcial : fimDate.getUTCDate() < lastDayOfMonth - 2;

  await prisma.$executeRawUnsafe(
    `INSERT INTO "RegistoImportacao" (id, farmacia_id, ficheiro, formato, tipo, periodo_inicio, periodo_fim, mes_parcial, notas)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)`,
    id,
    params.farmaciaId,
    params.ficheiro,
    params.formato || 'CSV',
    params.tipo || 'VENDAS',
    params.periodoInicio ? params.periodoInicio.slice(0, 10) : null,
    params.periodoFim.slice(0, 10),
    mesParcial,
    params.notas || null
  );

  // #22: Invalidar imediatamente a cache de 24h do catálogo após importação
  invalidateCatalog(params.farmaciaId);
}

export async function getLatestImportForPharmacy(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<{ dados_ate: string; ultimo_mes: string; mes_parcial: boolean; ficheiro: string } | null> {
  try {
    await ensureImportRegistryTable(prisma);
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT ficheiro, periodo_fim::text AS periodo_fim, mes_parcial
       FROM "RegistoImportacao"
       WHERE farmacia_id = $1 AND tipo IN ('VENDAS', 'MISTO')
       ORDER BY periodo_fim DESC, criado_em DESC
       LIMIT 1`,
      farmaciaId
    );
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    const dados_ate = String(r.periodo_fim).slice(0, 10);
    return {
      dados_ate,
      ultimo_mes: dados_ate.slice(0, 7),
      mes_parcial: Boolean(r.mes_parcial),
      ficheiro: String(r.ficheiro || ''),
    };
  } catch {
    return null;
  }
}
