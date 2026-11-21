-- =============================================================================
-- Documentos de medicamento (RCM, FI, MMR) importados de PDF.
-- Migração para REVER antes de aplicar. Depende de 20261120_cits_import.sql só pela vista.
--
--   "DocumentoMedicamento"   um registo por PDF (identificado pelo SHA-256 do ficheiro)
--   "DocumentoSeccao"        texto de cada secção do RCM (4.1, 4.2, 4.3, ...)
--   "DocumentoCnp"           ligação documento <-> CNP (um RCM cobre várias apresentações)
--   v_rcm_textos_unicos      textos distintos por secção: é sobre isto que corre a extração com LLM
-- =============================================================================

CREATE TABLE IF NOT EXISTS "DocumentoMedicamento" (
  id                BIGSERIAL PRIMARY KEY,
  sha256            TEXT NOT NULL UNIQUE,
  tipo              TEXT NOT NULL CHECK (tipo IN ('RCM','FI','MMR','DESCONHECIDO')),
  estado            TEXT NOT NULL CHECK (estado IN ('IDENTIFICADO','POR_REVER','ERRO')),
  motivo            TEXT,
  ficheiro_original TEXT NOT NULL,
  ficheiro_final    TEXT,
  armazenamento     TEXT,          -- caminho no Supabase Storage, quando os PDF forem para lá
  paginas           INTEGER,
  nome_documento    TEXT,          -- secção 1
  composicao        TEXT,          -- início da secção 2
  data_revisao      DATE,          -- secção 10
  data_aprovacao    DATE,          -- carimbo "APROVADO EM dd-mm-aaaa INFARMED" mais recente
  nome_chave        TEXT,          -- nome normalizado: liga FI ao RCM do mesmo medicamento
  cnps_seccao8      TEXT[] NOT NULL DEFAULT '{}',
  seccoes_em_falta  TEXT[] NOT NULL DEFAULT '{}',
  revisto_por       TEXT,          -- revisão manual dos POR_REVER
  revisto_em        TIMESTAMPTZ,
  processado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DocumentoMedicamento_estado_idx" ON "DocumentoMedicamento"(estado, tipo);
CREATE INDEX IF NOT EXISTS "DocumentoMedicamento_nome_idx" ON "DocumentoMedicamento"(nome_chave) WHERE tipo = 'RCM';

CREATE TABLE IF NOT EXISTS "DocumentoCnp" (
  documento_id BIGINT NOT NULL REFERENCES "DocumentoMedicamento"(id) ON DELETE CASCADE,
  cnp_codigo   TEXT   NOT NULL,
  PRIMARY KEY (documento_id, cnp_codigo)
);
CREATE INDEX IF NOT EXISTS "DocumentoCnp_cnp_idx" ON "DocumentoCnp"(cnp_codigo);

CREATE TABLE IF NOT EXISTS "DocumentoSeccao" (
  documento_id BIGINT NOT NULL REFERENCES "DocumentoMedicamento"(id) ON DELETE CASCADE,
  numero       TEXT   NOT NULL,   -- '4.1', '4.2', ...
  titulo       TEXT   NOT NULL,
  texto        TEXT   NOT NULL,
  texto_hash   TEXT   NOT NULL,   -- sha256 do texto normalizado: genéricos com texto igual partilham o hash
  PRIMARY KEY (documento_id, numero)
);
CREATE INDEX IF NOT EXISTS "DocumentoSeccao_hash_idx" ON "DocumentoSeccao"(numero, texto_hash);

-- Textos distintos por secção, com quantos documentos e CNP os partilham.
-- A extração estruturada (indicações, idade mínima) corre uma vez por linha desta vista.
CREATE OR REPLACE VIEW v_rcm_textos_unicos WITH (security_invoker = true) AS
SELECT
  s.numero,
  s.texto_hash,
  min(s.texto)                                   AS texto,
  count(DISTINCT s.documento_id)                 AS documentos,
  array_agg(DISTINCT dc.cnp_codigo)              AS cnps,
  array_agg(DISTINCT pc.dci) FILTER (WHERE pc.dci IS NOT NULL) AS dcis
FROM "DocumentoSeccao" s
JOIN "DocumentoMedicamento" d ON d.id = s.documento_id AND d.tipo = 'RCM' AND d.estado = 'IDENTIFICADO'
LEFT JOIN "DocumentoCnp" dc ON dc.documento_id = s.documento_id
LEFT JOIN "ProdutoCits" pc ON pc.cnp_codigo = dc.cnp_codigo
GROUP BY s.numero, s.texto_hash;

ALTER TABLE "DocumentoMedicamento" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentoCnp"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentoSeccao"      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DocumentoMedicamento', 'DocumentoCnp', 'DocumentoSeccao']
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon;', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'service_role_all'
    ) THEN
      EXECUTE format('CREATE POLICY service_role_all ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);', t);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'authenticated_read'
    ) THEN
      EXECUTE format('CREATE POLICY authenticated_read ON public.%I FOR SELECT TO authenticated USING (true);', t);
    END IF;
  END LOOP;
END $$;
