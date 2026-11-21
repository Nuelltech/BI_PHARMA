import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const me: any[] = await prisma.$queryRawUnsafe(
      `SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super, (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS createrole`
    );
    console.log('ROLE ATUAL:', JSON.stringify(me));

    const roles: any[] = await prisma.$queryRawUnsafe(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','copilot_ro_sem_custo','copilot_ro_com_custo')`
    );
    console.log('ROLES EXISTENTES:', JSON.stringify(roles.map((r) => r.rolname)));

    const tables: any[] = await prisma.$queryRawUnsafe(
      `SELECT c.relname AS tabela, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname`
    );
    console.log(`TABELAS public: ${tables.length}, com RLS: ${tables.filter((t) => t.rls).length}`);
    console.log('SEM RLS:', tables.filter((t) => !t.rls).map((t) => t.tabela).join(', '));

    const grants: any[] = await prisma.$queryRawUnsafe(
      `SELECT grantee, table_name, string_agg(privilege_type, ', ') AS privs FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated') GROUP BY grantee, table_name ORDER BY table_name`
    );
    console.log('GRANTS anon/authenticated detalhados:', JSON.stringify(grants, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
