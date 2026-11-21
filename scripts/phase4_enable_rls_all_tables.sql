-- ============================================================================
-- SCRIPT DE ATIVAÇÃO GERAL DE RLS (ROW-LEVEL SECURITY) — FASE 4 (Spec v2.1)
-- Executar no SQL Editor do Supabase para trancar o esquema public a 100%
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
        -- 1. Ativar e Forçar RLS
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl.tablename);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', tbl.tablename);

        -- 2. Revogar todo e qualquer acesso dos papéis públicos da Data API Supabase
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated;', tbl.tablename);

        -- 3. Criar política explícita para o papel service_role do backend
        EXECUTE format('
            DO $policy$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies 
                    WHERE schemaname = ''public'' AND tablename = %L AND policyname = ''service_role_all''
                ) THEN
                    CREATE POLICY service_role_all ON public.%I 
                    FOR ALL 
                    TO service_role 
                    USING (true) 
                    WITH CHECK (true);
                END IF;
            END $policy$;
        ', tbl.tablename, tbl.tablename);

        RAISE NOTICE 'RLS ativado e trancado em public.%', tbl.tablename;
    END LOOP;
END $$;
