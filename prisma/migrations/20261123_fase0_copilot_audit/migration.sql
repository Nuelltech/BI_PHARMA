-- Fase 0 Reduzida: Auditoria e Rastreio Completo do Copilot (v3.1)
-- Tabelas: CopilotInteracao e CopilotEtapa com RLS estrito (apenas backend / service role)

CREATE TABLE IF NOT EXISTS public."CopilotInteracao" (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "farmaciaId"        text NOT NULL,
  "utilizadorId"      text,
  perfil              text,
  "sessionId"         text NOT NULL,
  modo                text,
  pergunta            text,
  intencao            text,
  parametros          jsonb,
  pergunta_de_volta   boolean NOT NULL DEFAULT false,
  texto_referencias   text,
  texto_final         text,
  estado              text NOT NULL,
  erro_codigo         text,
  erro_mensagem       text,
  modelo_final        text,
  escalou_sonnet      boolean NOT NULL DEFAULT false,
  n_chamadas_api      int,
  tokens_in           int,
  tokens_out          int,
  tokens_cache_write  int,
  tokens_cache_read   int,
  custo_eur           numeric(10,5),
  duracao_ms          int,
  frases_removidas    int NOT NULL DEFAULT 0,
  reescritas          int NOT NULL DEFAULT 0,
  regras_falhadas     text[] NOT NULL DEFAULT '{}',
  indice_qualidade    int,
  feedback            smallint,
  feedback_comentario text,
  repetida_10min      boolean NOT NULL DEFAULT false,
  "criadoEm"          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."CopilotEtapa" (
  id                  bigserial PRIMARY KEY,
  "interacaoId"       uuid NOT NULL REFERENCES public."CopilotInteracao"(id) ON DELETE CASCADE,
  "farmaciaId"        text NOT NULL,
  ordem               smallint NOT NULL,
  etapa               text NOT NULL,
  nome                text,
  inicio_ms           int NOT NULL,
  duracao_ms          int NOT NULL,
  estado              text NOT NULL,
  tokens_in           int,
  tokens_out          int,
  tokens_cache_write  int,
  tokens_cache_read   int,
  custo_eur           numeric(10,5),
  detalhe             jsonb
);

CREATE INDEX IF NOT EXISTS "CopilotInteracao_farmaciaId_criadoEm_idx" ON public."CopilotInteracao" ("farmaciaId", "criadoEm" DESC);
CREATE INDEX IF NOT EXISTS "CopilotInteracao_estado_criadoEm_idx" ON public."CopilotInteracao" (estado, "criadoEm" DESC);
CREATE INDEX IF NOT EXISTS "CopilotEtapa_interacaoId_ordem_idx" ON public."CopilotEtapa" ("interacaoId", ordem);

ALTER TABLE public."CopilotInteracao" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CopilotEtapa"     ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public."CopilotInteracao", public."CopilotEtapa" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public."CopilotInteracao", public."CopilotEtapa" FROM authenticated;
  END IF;
END $$;
