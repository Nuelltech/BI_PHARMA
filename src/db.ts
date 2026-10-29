import net from 'net';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

let embeddedPgInstance: any = null;

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Executa de forma 100% não-destrutiva (CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS)
 * a criação das tabelas do BI Pharma, garantindo que tabelas de outros sistemas no mesmo projeto
 * Supabase (ex: faturas_processadas, resumos_lote, faturas_nuelltech) nunca são tocadas.
 */
export async function ensureNonDestructiveSchema(prisma: PrismaClient): Promise<void> {
  const sqlPath = path.resolve(process.cwd(), 'supabase_bi_pharma_setup.sql');
  if (!fs.existsSync(sqlPath)) return;

  const rawSql = fs.readFileSync(sqlPath, 'utf-8');
  const statements = rawSql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt);
    } catch (e: any) {
      // Ignorar caso índice ou constraint já exista
      if (!String(e.message || '').includes('already exists')) {
        console.warn('[DB Schema] Aviso ao verificar statement:', e.message);
      }
    }
  }
}

/**
 * Garante que existe uma instância PostgreSQL a correr:
 * - Se DATABASE_URL apontar para Supabase / Cloud (host remoto), liga diretamente e aplica schema não-destrutivo.
 * - Se for localhost e não houver Postgres ativo, inicia o PostgreSQL local embebido.
 */
export async function ensureDatabaseReady(): Promise<{
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}> {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5433/bi_pharma?schema=public';
  const parsedUrl = new URL(dbUrl);
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 5432;
  const host = parsedUrl.hostname || 'localhost';
  const dbName = parsedUrl.pathname.replace(/^\//, '') || 'bi_pharma';

  const isLocal = host === 'localhost' || host === '127.0.0.1';

  if (isLocal) {
    const alreadyRunning = await isPortOpen(port, '127.0.0.1');
    if (!alreadyRunning) {
      console.log(`[DB] Nenhum PostgreSQL detetado em ${host}:${port}. A iniciar PostgreSQL local embebido (UTF-8)...`);
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      const pgDataDir = path.resolve(process.cwd(), '.pgdata_utf8');
      embeddedPgInstance = new EmbeddedPostgres({
        databaseDir: pgDataDir,
        user: decodeURIComponent(parsedUrl.username || 'postgres'),
        password: decodeURIComponent(parsedUrl.password || 'password'),
        port,
        persistent: true,
        initdbFlags: ['--encoding=UTF8', '--locale=C'],
        onLog: () => {},
        onError: () => {},
      });

      if (!fs.existsSync(path.join(pgDataDir, 'PG_VERSION'))) {
        await embeddedPgInstance.initialise();
      }
      await embeddedPgInstance.start();

      try {
        await embeddedPgInstance.createDatabase(dbName);
      } catch {
        // Base de dados já existe
      }
    }
  } else {
    console.log(`[DB] Ligação remota configurada para ${host}:${port} (Modo Cloud / Supabase)...`);
  }

  const isSupabasePooler = host.includes('pooler.supabase.com');
  const candidateUrls: string[] = [];

  if (isSupabasePooler) {
    // 1. Porta 6543 (Modo Transação PgBouncer/Supavisor): permite múltiplos clientes sem esgotar o limite da sessão
    const url6543 = dbUrl.replace(':5432/', ':6543/');
    const sep6543 = url6543.includes('?') ? '&' : '?';
    const clean6543 = url6543.includes('pgbouncer=')
      ? url6543
      : `${url6543}${sep6543}pgbouncer=true&connection_limit=3`;
    candidateUrls.push(clean6543);

    // 2. Porta 5432 (Modo Sessão com limite estrito de ligações)
    const sep5432 = dbUrl.includes('?') ? '&' : '?';
    const clean5432 = dbUrl.includes('connection_limit=')
      ? dbUrl
      : `${dbUrl}${sep5432}connection_limit=2`;
    candidateUrls.push(clean5432);
  } else {
    candidateUrls.push(dbUrl);
  }

  let basePrisma: PrismaClient | null = null;
  let lastErr: any = null;

  for (const urlCandidate of candidateUrls) {
    const masked = urlCandidate.replace(/:([^:@]+)@/, ':***@');
    try {
      const testPrisma = new PrismaClient({
        datasources: { db: { url: urlCandidate } },
      });
      await testPrisma.$connect();
      console.log(`[DB] ✅ Ligação estabelecida com sucesso: ${masked}`);
      basePrisma = testPrisma;
      break;
    } catch (err: any) {
      console.warn(`[DB] ⚠️ Falha ao ligar com ${masked} (${err.message?.split('\\n')[0]}). A tentar alternativa...`);
      lastErr = err;
    }
  }

  if (!basePrisma) {
    throw lastErr || new Error('Não foi possível estabelecer ligação à base de dados.');
  }

  await ensureNonDestructiveSchema(basePrisma);

  const prisma = attachTenantPriceOverlay(basePrisma);

  const cleanup = async () => {
    await basePrisma!.$disconnect();
    if (embeddedPgInstance) {
      await embeddedPgInstance.stop();
      embeddedPgInstance = null;
    }
  };

  return { prisma, cleanup };
}

/**
 * Sobrepõe automaticamente o PVP e a Margem específicos da farmácia ativa (tabela PrecoFarmacia)
 * em todas as leituras de Inventario (include.produto) e ProdutoMestre (include.inventarios),
 * garantindo isolamento total de preços entre Farmácia A, Farmácia B e futuras farmácias.
 */
export function attachTenantPriceOverlay(basePrisma: PrismaClient): PrismaClient {
  const tenantCache = new Map<string, { ts: number; map: Map<string, { pvp: any; margem: any }> }>();

  async function getTenantPriceMap(farmaciaId: string) {
    const now = Date.now();
    const cached = tenantCache.get(farmaciaId);
    if (cached && now - cached.ts < 30_000) {
      return cached.map;
    }
    const rows = await basePrisma.precoFarmacia.findMany({
      where: { farmaciaId },
      select: { cnp_codigo: true, pvp: true, margem: true },
    });
    const map = new Map<string, { pvp: any; margem: any }>();
    for (const r of rows) {
      map.set(r.cnp_codigo, { pvp: r.pvp, margem: r.margem });
    }
    tenantCache.set(farmaciaId, { ts: now, map });
    return map;
  }

  return basePrisma.$extends({
    query: {
      precoFarmacia: {
        async $allOperations({ operation, args, query }) {
          if (operation !== 'findMany' && operation !== 'findUnique' && operation !== 'findFirst') {
            tenantCache.clear();
          }
          return query(args);
        },
      },
      inventario: {
        async findMany({ args, query }) {
          const result: any = await query(args);
          const farmaciaId = typeof (args?.where as any)?.farmaciaId === 'string' ? (args!.where as any).farmaciaId : null;
          if (farmaciaId && Array.isArray(result) && result.length > 0 && result[0]?.produto) {
            const priceMap = await getTenantPriceMap(farmaciaId);
            if (priceMap.size > 0) {
              for (const row of result) {
                const tp = priceMap.get(row.cnp_codigo);
                if (tp && row.produto) {
                  if (tp.pvp !== null && tp.pvp !== undefined) row.produto.pvp = tp.pvp;
                  if (tp.margem !== null && tp.margem !== undefined) row.produto.margem_padrao = tp.margem;
                }
              }
            }
          }
          return result;
        },
      },
      produtoMestre: {
        async findUnique({ args, query }) {
          const result: any = await query(args);
          const farmaciaId =
            typeof (args?.include as any)?.inventarios?.where?.farmaciaId === 'string'
              ? (args!.include as any).inventarios.where.farmaciaId
              : null;
          if (result && farmaciaId) {
            const priceMap = await getTenantPriceMap(farmaciaId);
            const tp = priceMap.get(result.cnp_codigo);
            if (tp) {
              if (tp.pvp !== null && tp.pvp !== undefined) result.pvp = tp.pvp;
              if (tp.margem !== null && tp.margem !== undefined) result.margem_padrao = tp.margem;
            }
          }
          return result;
        },
        async findMany({ args, query }) {
          const result: any = await query(args);
          const farmaciaId =
            typeof (args?.include as any)?.inventarios?.where?.farmaciaId === 'string'
              ? (args!.include as any).inventarios.where.farmaciaId
              : null;
          if (Array.isArray(result) && result.length > 0 && farmaciaId) {
            const priceMap = await getTenantPriceMap(farmaciaId);
            if (priceMap.size > 0) {
              for (const p of result) {
                const tp = priceMap.get(p.cnp_codigo);
                if (tp) {
                  if (tp.pvp !== null && tp.pvp !== undefined) p.pvp = tp.pvp;
                  if (tp.margem !== null && tp.margem !== undefined) p.margem_padrao = tp.margem;
                }
              }
            }
          }
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}
