import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Sandbox SQL do Copilot imposto pela BD (idempotente):
 *  - esquema próprio `copilot` com as vistas (filtradas por current_setting('app.farmacia_id'))
 *  - dois papéis NOLOGIN: copilot_ro_sem_custo (só copilot.produtos) e copilot_ro_com_custo (+ copilot.produtos_com_custo)
 *  - search_path fixo por papel; sem qualquer acesso às tabelas base
 *  - remove as vistas antigas do esquema public
 */
const STATEMENTS: string[] = [
  `DROP VIEW IF EXISTS public.v_copilot_produtos_sem_custo`,
  `DROP VIEW IF EXISTS public.v_copilot_produtos_com_custo`,
  `DROP VIEW IF EXISTS copilot.v_metricas CASCADE`,
  `DROP VIEW IF EXISTS copilot.produtos CASCADE`,
  `DROP VIEW IF EXISTS copilot.produtos_com_custo CASCADE`,
  `CREATE SCHEMA IF NOT EXISTS copilot`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'copilot_ro_sem_custo') THEN CREATE ROLE copilot_ro_sem_custo NOLOGIN NOINHERIT; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'copilot_ro_com_custo') THEN CREATE ROLE copilot_ro_com_custo NOLOGIN NOINHERIT; END IF;
   END $$`,
  `GRANT copilot_ro_sem_custo TO postgres`,
  `GRANT copilot_ro_com_custo TO postgres`,
  `CREATE OR REPLACE VIEW copilot.produtos AS
   SELECT
     m."cnp_codigo", m."designacao", m."tipo_venda", m."segmento", m."categoria", m."subcategoria",
     m."molecula_dci" AS "dci",
     m."laboratorio_titular",
     (m."stock_total_unidades" BETWEEN 1 AND 2) AS "eh_resto_gaveta",
     m."stock_total_unidades" AS "stock_atual", m."vmm", m."cobertura_meses" AS "meses_cobertura", m."pvp",
     m."eh_mono" AS "is_mono", m."eh_excesso_cobertura" AS "is_excesso", m."eh_risco_caducidade" AS "is_risco_caducidade",
     m."data_validade_mais_proxima" AS "data_validade_min", m."unidades_em_risco_caducidade" AS "unidades_risco_caducidade",
     m."data_ultima_venda" AS "ultima_venda"
   FROM public."MartProdutoMetricas" m
   WHERE m."farmaciaId" = current_setting('app.farmacia_id', true)`,
  `CREATE OR REPLACE VIEW copilot.produtos_com_custo AS
   SELECT
     m."cnp_codigo", m."designacao", m."tipo_venda", m."segmento", m."categoria", m."subcategoria",
     m."molecula_dci" AS "dci",
     m."laboratorio_titular",
     (m."stock_total_unidades" BETWEEN 1 AND 2) AS "eh_resto_gaveta",
     m."stock_total_unidades" AS "stock_atual", m."vmm", m."cobertura_meses" AS "meses_cobertura", m."pvp",
     m."custo_unitario_medio" AS "custo_unitario", m."stock_total_valor_custo" AS "valor_stock_custo", m."margem_padrao" AS "margem_pct",
     m."eh_mono" AS "is_mono", m."eh_excesso_cobertura" AS "is_excesso", m."eh_risco_caducidade" AS "is_risco_caducidade",
     m."data_validade_mais_proxima" AS "data_validade_min", m."unidades_em_risco_caducidade" AS "unidades_risco_caducidade",
     m."valor_em_risco_caducidade" AS "valor_risco_caducidade", m."data_ultima_venda" AS "ultima_venda"
   FROM public."MartProdutoMetricas" m
   WHERE m."farmaciaId" = current_setting('app.farmacia_id', true)`,
  `CREATE OR REPLACE VIEW copilot.v_metricas AS SELECT * FROM copilot.produtos`,
  `REVOKE ALL ON SCHEMA copilot FROM PUBLIC`,
  `REVOKE ALL ON ALL TABLES IN SCHEMA copilot FROM PUBLIC, anon, authenticated`,
  `GRANT USAGE ON SCHEMA copilot TO copilot_ro_sem_custo, copilot_ro_com_custo`,
  `GRANT SELECT ON copilot.produtos TO copilot_ro_sem_custo, copilot_ro_com_custo`,
  `GRANT SELECT ON copilot.v_metricas TO copilot_ro_sem_custo, copilot_ro_com_custo`,
  `GRANT SELECT ON copilot.produtos_com_custo TO copilot_ro_com_custo`,
  `ALTER ROLE copilot_ro_sem_custo SET search_path = copilot, pg_catalog`,
  `ALTER ROLE copilot_ro_com_custo SET search_path = copilot, pg_catalog`,
];

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const s of STATEMENTS) {
      await prisma.$executeRawUnsafe(s);
    }
    console.log(`[Fase 1] Sandbox Copilot aplicado: esquema copilot + 2 papéis + ${STATEMENTS.length} instruções.`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
