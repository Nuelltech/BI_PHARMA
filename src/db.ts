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

  const prisma = new PrismaClient({
    datasources: {
      db: { url: dbUrl },
    },
  });

  await prisma.$connect();
  await ensureNonDestructiveSchema(prisma);

  const cleanup = async () => {
    await prisma.$disconnect();
    if (embeddedPgInstance) {
      await embeddedPgInstance.stop();
      embeddedPgInstance = null;
    }
  };

  return { prisma, cleanup };
}
