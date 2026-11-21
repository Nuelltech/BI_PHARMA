-- ============================================================================
-- SCRIPT DE REVERSÃO / ROLLBACK DE RLS (ROW-LEVEL SECURITY) — FASE 4 (Spec v2.1)
-- Executar no SQL Editor do Supabase se for necessário desativar RLS de emergência
-- ============================================================================

DO $$
DECLARE
    tbl RECORD;
BEGIN
    FOR tbl IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
          AND tablename NOT LIKE 'pg_%' 
          AND tablename NOT LIKE 'sql_%'
    LOOP
        -- 1. Remover FORCE ROW LEVEL SECURITY
        EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY;', tbl.tablename);

        -- 2. Desativar RLS
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY;', tbl.tablename);

        -- 3. Remover política temporária service_role_all se existir
        EXECUTE format('DROP POLICY IF EXISTS service_role_all ON public.%I;', tbl.tablename);

        RAISE NOTICE 'RLS desativado com sucesso em public.%', tbl.tablename;
    END LOOP;
END $$;
