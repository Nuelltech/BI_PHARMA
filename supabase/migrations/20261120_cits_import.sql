-- =============================================================================
-- CITS (Infarmed) -> Bi-Pharma
-- Migração para REVER antes de aplicar. Não altera o "ProdutoMestre".
--
--   "CitsCarga"            registo de cada importação do ficheiro Access
--   "CitsRaw"              espelho das tabelas CITS usadas (1 linha = 1 registo, em JSONB)
--   "ProdutoCits"          resultado por CNP (1:1 com ProdutoMestre.cnp_codigo)
--   "ProdutoCitsHistorico" alterações campo a campo entre cargas
--   v_produto_catalogo     vista que junta ProdutoMestre + ProdutoCits com regras de prioridade
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Registo de cargas
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CitsCarga" (
  id                 BIGSERIAL PRIMARY KEY,
  ficheiro           TEXT        NOT NULL,          -- nome do .mdb/.accdb
  ficheiro_sha256    TEXT        NOT NULL,
  iniciada_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminada_em       TIMESTAMPTZ,
  estado             TEXT        NOT NULL DEFAULT 'EM_CURSO'
                     CHECK (estado IN ('EM_CURSO','CONCLUIDA','FALHADA','REJEITADA')),
  linhas_por_tabela  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  avisos             JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- colunas extra, etc.
  erro               TEXT,
  produtos_inseridos INTEGER     NOT NULL DEFAULT 0,
  produtos_alterados INTEGER     NOT NULL DEFAULT 0,
  produtos_removidos INTEGER     NOT NULL DEFAULT 0
);

-- Evita carregar duas vezes o mesmo ficheiro com sucesso
CREATE UNIQUE INDEX IF NOT EXISTS "CitsCarga_sha_concluida_uq"
  ON "CitsCarga"(ficheiro_sha256) WHERE estado = 'CONCLUIDA';

-- ---------------------------------------------------------------------------
-- 2. Espelho bruto (staging). Substituído por inteiro em cada carga.
--    JSONB porque a estrutura é do Infarmed e pode ganhar colunas:
--    o importador valida as colunas esperadas e avisa das novas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CitsRaw" (
  tabela    TEXT   NOT NULL,      -- ex.: 'PRODUTO', 'EMBALAGEM'
  linha     INTEGER NOT NULL,     -- posição no ficheiro (chave técnica)
  dados     JSONB  NOT NULL,
  carga_id  BIGINT NOT NULL REFERENCES "CitsCarga"(id),
  PRIMARY KEY (tabela, linha)
);
CREATE INDEX IF NOT EXISTS "CitsRaw_emb_idx"  ON "CitsRaw" ((dados->>'EMB_ID'))  WHERE dados ? 'EMB_ID';
CREATE INDEX IF NOT EXISTS "CitsRaw_prod_idx" ON "CitsRaw" ((dados->>'PROD_ID')) WHERE dados ? 'PROD_ID';

-- ---------------------------------------------------------------------------
-- 3. Resultado por CNP
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ProdutoCits" (
  cnp_codigo                  TEXT PRIMARY KEY,           -- EMBALAGEM.NR_REGISTO (7 dígitos)
  emb_id                      BIGINT NOT NULL,
  prod_id                     BIGINT NOT NULL,
  ativo_no_cits               BOOLEAN NOT NULL DEFAULT true, -- false = deixou de vir no ficheiro

  -- Identificação
  nome                        TEXT,          -- PRODUTO.NOME
  descricao_embalagem         TEXT,          -- EMBALAGEM.DESCR
  marca                       TEXT,          -- PRODUTO.MARCA (texto, não é indicador)
  tipo_produto                TEXT CHECK (tipo_produto IN ('MUH','DM','COSMETICO','ALIM_ESPECIAL','NUTRICAO','OUTRO')),
  nr_processo                 TEXT,          -- PRODUTO.NR_PROCESSO
  titular_aim                 TEXT,

  -- Substância e forma
  dci                         TEXT,          -- REF_DCIPT.DESCR
  substancias                 JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{nome, quantidade, unidade}]
  dosagem                     TEXT,          -- PRODUTO.DOSAGEM (simplificada)
  dosagem_completa            TEXT,          -- PRODUTO.DOSAGEM_CEDENCIA
  forma_farmaceutica          TEXT,
  forma_farmaceutica_agrupada TEXT,
  vias_administracao          TEXT[] NOT NULL DEFAULT '{}',
  atc_codigos                 TEXT[] NOT NULL DEFAULT '{}',
  atc_descricoes              TEXT[] NOT NULL DEFAULT '{}',
  cft_codigos                 TEXT[] NOT NULL DEFAULT '{}',
  cft_descricoes              TEXT[] NOT NULL DEFAULT '{}',
  gh_codigo                   TEXT,          -- EMBALAGEM.GRUPO_HOM_COD
  gh_descricao                TEXT,
  cnpem                       TEXT,

  -- Classificações derivadas
  classificacoes_dispensa     INTEGER[] NOT NULL DEFAULT '{}',  -- IDs brutos de REF_CLASS_DISPENSA_PROD
  regime_dispensa             TEXT NOT NULL CHECK (regime_dispensa IN (
                                'SEM_RECEITA_LIVRE','SEM_RECEITA_SO_FARMACIA','RECEITA_OU_PROTOCOLO',
                                'COM_RECEITA','COM_RECEITA_ESPECIAL','COM_RECEITA_RESTRITA',
                                'NAO_MEDICAMENTO','DESCONHECIDO')),
  precisa_receita             BOOLEAN NOT NULL,
  tipo_venda_derivado         TEXT NOT NULL CHECK (tipo_venda_derivado IN ('MSRM','MNSRM','VENDA_LIVRE')),
  eh_generico                 BOOLEAN NOT NULL DEFAULT false,
  eh_marca                    BOOLEAN NOT NULL DEFAULT false,
  eh_biossimilar              BOOLEAN NOT NULL DEFAULT false,
  eh_biologico                BOOLEAN NOT NULL DEFAULT false,
  publico                     TEXT NOT NULL DEFAULT 'DESCONHECIDO'
                              CHECK (publico IN ('ADULTO','PEDIATRICO','TODOS','DESCONHECIDO')),
  publico_fonte               TEXT,          -- CITS_AIMUP | CITS_SUBGRUPO | INFERIDO_DESIGNACAO
  grupos_produto              INTEGER[] NOT NULL DEFAULT '{}',

  -- Preços em vigor (€)
  pvp_oficial                 NUMERIC(15,2), -- REF_TIPO_PRECO 1 "Preço", ATIVO = 1
  pvp_max                     NUMERIC(15,2), -- 401 "PVP Max"
  preco_referencia            NUMERIC(15,2), -- 101 "Preço Ref"
  pvp_notificado              NUMERIC(15,2), -- 602 "PVP Notificado"

  -- Comparticipação e mercado
  comparticipacoes            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{regime, nivel, percentagem, desde}]
  estado_comercializacao      TEXT,
  data_prevista_reposicao     DATE,
  estado_aim                  TEXT,
  fim_escoamento              DATE,
  pem_amb                     BOOLEAN,

  -- Indicadores de segurança / operação
  margem_terapeutica_estreita BOOLEAN,       -- PRODUTO.IND_MARGEM_TERAP
  monitorizacao_adicional     BOOLEAN,       -- PRODUTO.IND_MONIT_ADICIONAL_FV
  substituicao_farmacia       BOOLEAN,       -- EMBALAGEM.SUBSTITUICAO_FARMACIA
  conservacao                 TEXT,          -- REF_TEMPERATURA_ARMAZ.DESCR
  alertas                     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Controlo
  cits_data_alteracao         DATE,          -- PRODUTO.DATA_ALTERACAO
  hash_conteudo               TEXT NOT NULL, -- deteta alterações sem comparar campo a campo
  carga_id                    BIGINT NOT NULL REFERENCES "CitsCarga"(id),
  atualizado_em               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ProdutoCits_gh_idx"   ON "ProdutoCits"(gh_codigo);
CREATE INDEX IF NOT EXISTS "ProdutoCits_dci_idx"  ON "ProdutoCits"(dci);
CREATE INDEX IF NOT EXISTS "ProdutoCits_prod_idx" ON "ProdutoCits"(prod_id);

-- ---------------------------------------------------------------------------
-- 4. Histórico de alterações (campos seguidos: preços, receita, comercialização, ...)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ProdutoCitsHistorico" (
  id             BIGSERIAL PRIMARY KEY,
  cnp_codigo     TEXT   NOT NULL,
  campo          TEXT   NOT NULL,
  valor_anterior JSONB,
  valor_novo     JSONB,
  carga_id       BIGINT NOT NULL REFERENCES "CitsCarga"(id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ProdutoCitsHistorico_cnp_idx" ON "ProdutoCitsHistorico"(cnp_codigo, criado_em DESC);

-- ---------------------------------------------------------------------------
-- 5. Vista de catálogo: ProdutoMestre + CITS, com prioridade de fontes
--    Regras (doc "Mapeamento CITS -> Bi-Pharma"):
--      - receita: o mais restritivo ganha; discordância = CONFLITO_RX
--      - descritivos (DCI, forma, dosagem, titular, GH): CITS prevalece
--      - PVP da farmácia nunca é substituído
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_produto_catalogo WITH (security_invoker = true) AS
SELECT
  pm.cnp_codigo,
  pm.designacao,
  CASE
    WHEN pc.cnp_codigo IS NULL           THEN 'SEM_CORRESPONDENCIA'
    WHEN NOT pc.ativo_no_cits            THEN 'REMOVIDO_DO_CITS'
    ELSE 'ENCONTRADO'
  END                                                         AS cits_match,

  -- Receita
  pm.tipo_venda                                               AS tipo_venda_farmacia,
  pc.tipo_venda_derivado                                      AS tipo_venda_cits,
  pc.regime_dispensa,
  (pm.tipo_venda = 'MSRM' OR COALESCE(pc.precisa_receita, false)) AS precisa_receita,
  -- conflito = uma fonte diz "com receita" e a outra não
  (pc.cnp_codigo IS NOT NULL AND (pm.tipo_venda = 'MSRM') <> pc.precisa_receita)
                                                              AS conflito_rx,

  -- Descritivos: CITS primeiro
  COALESCE(pc.dci, NULLIF(trim(pm.dci), ''))                  AS dci,
  CASE WHEN pc.dci IS NOT NULL THEN 'CITS'
       WHEN NULLIF(trim(pm.dci), '') IS NOT NULL THEN COALESCE(pm.fonte_enriquecimento, 'PRODUTO_MESTRE')
  END                                                         AS dci_fonte,
  COALESCE(pc.forma_farmaceutica, NULLIF(trim(pm.forma_farmaceutica), '')) AS forma_farmaceutica,
  COALESCE(pc.dosagem, NULLIF(trim(pm.dosagem), ''))          AS dosagem,
  COALESCE(pc.titular_aim, NULLIF(trim(pm.laboratorio_titular), '')) AS laboratorio_titular,
  COALESCE(pc.gh_codigo, NULLIF(trim(pm.gh_codigo), ''))      AS gh_codigo,
  pc.gh_descricao,
  pc.atc_codigos, pc.atc_descricoes, pc.cft_codigos, pc.cft_descricoes,
  pc.vias_administracao, pc.cnpem, pc.tipo_produto,

  -- Classificações
  pc.eh_generico, pc.eh_marca, pc.eh_biossimilar, pc.eh_biologico,
  pc.publico, pc.publico_fonte,

  -- Preços: o da farmácia mantém-se
  pm.pvp                                                      AS pvp_farmacia,
  pc.pvp_oficial, pc.pvp_max, pc.preco_referencia,
  pc.comparticipacoes,

  -- Mercado / segurança
  pc.estado_comercializacao, pc.data_prevista_reposicao, pc.estado_aim, pc.fim_escoamento,
  pc.margem_terapeutica_estreita, pc.monitorizacao_adicional, pc.substituicao_farmacia,
  pc.conservacao, pc.alertas,

  -- Campos só do Bi-Pharma
  pm.categoria, pm.subcategoria, pm.macro_area, pm.sazonalidade,
  pm.margem_padrao, pm.taxa_iva, pm.indicacoes_clinicas,
  pc.atualizado_em                                            AS cits_atualizado_em
FROM "ProdutoMestre" pm
LEFT JOIN "ProdutoCits" pc ON pc.cnp_codigo = pm.cnp_codigo;

-- ---------------------------------------------------------------------------
-- 6. RLS: tabelas de referência, serviço com controlo total e leitura autenticada.
-- ---------------------------------------------------------------------------
ALTER TABLE "CitsCarga"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CitsRaw"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProdutoCits"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProdutoCitsHistorico" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CitsCarga', 'CitsRaw', 'ProdutoCits', 'ProdutoCitsHistorico']
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
