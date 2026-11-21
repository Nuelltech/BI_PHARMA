/**
 * Script de Ativação Geral de RLS (Row-Level Security) em Todas as Tabelas Públicas (Fase 4 / Spec v2.1)
 *
 * Garante que:
 *  1. Todas as tabelas no esquema public têm ROW LEVEL SECURITY ativado (ENABLE + FORCE).
 *  2. O Supabase Data API (PostgREST) não consegue aceder a nenhuma tabela via papéis 'anon' e 'authenticated'.
 *  3. Apenas a aplicação backend (papel de conexão postgres / service_role) pode ler e escrever.
 */

import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL ou DIRECT_URL não configurada no .env.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(' Ligado ao Supabase PostgreSQL para ativar RLS Geral da Fase 4...');

  try {
    // 1. Obter todas as tabelas normais no esquema public
    const tablesRes = await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
        AND tablename NOT LIKE 'pg_%' 
        AND tablename NOT LIKE 'sql_%'
      ORDER BY tablename ASC;
    `);

    const tables = tablesRes.rows.map((r) => r.tablename);
    console.log(`Encontradas ${tables.length} tabelas no esquema public para bloqueio RLS:`);

    for (const table of tables) {
      // Ativa RLS e força RLS mesmo para os donos de tabelas
      await client.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;`);
      await client.query(`ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY;`);

      // Garante que papéis anónimos da Data API não têm permissões
      await client.query(`REVOKE ALL ON TABLE public."${table}" FROM anon, authenticated;`);

      console.log(`  🔒 [RLS ENABLE + FORCE] public."${table}" configurada.`);
    }

    // 2. Permitir acesso total ao service_role e postgres (usados pelo pooler do backend)
    for (const table of tables) {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies 
            WHERE schemaname = 'public' AND tablename = '${table}' AND policyname = 'service_role_all'
          ) THEN
            CREATE POLICY service_role_all ON public."${table}" 
            FOR ALL 
            TO service_role 
            USING (true) 
            WITH CHECK (true);
          END IF;
        END $$;
      `);
    }

    console.log('✅ RLS Geral ativado com sucesso em 100% das tabelas do esquema public!');
  } catch (err: any) {
    console.error('❌ Erro ao aplicar RLS:', err.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
