import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Fecha a exposição da Data API do Supabase (PostgREST) nas tabelas da aplicação:
 *  - ativa RLS SEM políticas (negado por omissão para anon/authenticated)
 *  - revoga todos os privilégios de anon e authenticated
 * O Prisma liga-se como `postgres` (bypassrls), por isso não é afetado.
 * Só toca em tabelas SEM RLS (não altera tabelas que já tenham políticas) e ignora tabelas de outros projetos.
 */
const IGNORE_TABLES = new Set<string>(['faturas_nuelltech']); // não pertence ao Prisma do BI Pharma

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT c.relname AS tabela FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity ORDER BY c.relname`
    );
    const targets = rows.map((r) => r.tabela as string).filter((t) => !IGNORE_TABLES.has(t));

    for (const t of targets) {
      const q = `"public"."${t.replace(/"/g, '""')}"`;
      await prisma.$executeRawUnsafe(`ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`);
      await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE ${q} FROM anon, authenticated`);
    }
    console.log(`[Fase 1] RLS ativado + acessos anon/authenticated revogados em ${targets.length} tabelas.`);
    console.log('Ignoradas:', [...IGNORE_TABLES].join(', '));
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
