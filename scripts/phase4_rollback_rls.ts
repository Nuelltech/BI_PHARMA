import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('--- REVERSÃO / ROLLBACK DE RLS EM TODAS AS TABELAS PUBLIC ---');

  const tables: Array<{ tablename: string }> = await prisma.$queryRaw`
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public' 
      AND tablename NOT LIKE 'pg_%' 
      AND tablename NOT LIKE 'sql_%';
  `;

  for (const t of tables) {
    const tbl = t.tablename;
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."${tbl}" NO FORCE ROW LEVEL SECURITY;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE public."${tbl}" DISABLE ROW LEVEL SECURITY;`);
      await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS service_role_all ON public."${tbl}";`);
      console.log(`[ROLLBACK OK] RLS desativado em: public."${tbl}"`);
    } catch (err: any) {
      console.error(`[ROLLBACK ERRO] public."${tbl}":`, err.message);
    }
  }

  console.log('--- ROLLBACK DE RLS CONCLUÍDO COM SUCESSO ---');
}

main()
  .catch((e) => {
    console.error('Falha no rollback de RLS:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
