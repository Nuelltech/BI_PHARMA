import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('[Lockdown Supabase] A revogar todos os privilégios de anon e authenticated em public...');

    // 1. Obter todas as tabelas em public
    const tables: any[] = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );

    for (const t of tables) {
      const q = `"public"."${t.tablename.replace(/"/g, '""')}"`;
      // Habilita RLS em todas
      if (t.tablename !== 'faturas_nuelltech') {
        await prisma.$executeRawUnsafe(`ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`);
      }
      // Revoga todos os acessos de anon e authenticated
      await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE ${q} FROM anon, authenticated`);
    }

    // 2. Revogar em todas as sequências e funções
    await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated`);
    await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated`);

    // 3. Alterar privilégios por omissão para tabelas futuras
    await prisma.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated`);
    await prisma.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated`);
    await prisma.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated`);

    console.log(`[Lockdown Supabase] Sucesso! Privilégios revogados em ${tables.length} tabelas, sequências e rotinas.`);

    // 4. Verificação final
    const remaining: any[] = await prisma.$queryRawUnsafe(
      `SELECT grantee, count(DISTINCT table_name)::int AS tabelas
       FROM information_schema.role_table_grants
       WHERE table_schema='public' AND grantee IN ('anon','authenticated')
       GROUP BY grantee`
    );
    console.log('Verificação final de grants restantes:', JSON.stringify(remaining));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Erro no lockdown:', e);
  process.exit(1);
});
