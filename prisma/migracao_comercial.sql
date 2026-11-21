-- migracao_comercial.sql — tabelas novas para sugerir_vendas_cruzadas / sugerir_packs_promocionais (PostgreSQL)
-- Catálogos globais (partilhados entre tenants). Política por farmácia (permite_desconto_promo) fica em configuração do tenant.

CREATE TABLE IF NOT EXISTS regra_afinidade (
  id TEXT PRIMARY KEY,                       -- R01.., Q01..
  gatilho_tipo TEXT NOT NULL CHECK (gatilho_tipo IN ('FAMILIA','QUEIXA')),
  gatilho_id TEXT NOT NULL,
  dci_filtro TEXT[],                         -- NULL = qualquer DCI da família
  forma_filtro TEXT,                         -- ex.: 'ORAL', 'INALACAO'
  condicao_aplicacao TEXT NOT NULL,
  exige_publico BOOLEAN NOT NULL DEFAULT FALSE,
  restricoes_bloqueio_extra TEXT[] NOT NULL DEFAULT '{}',
  fonte_clinica TEXT,
  ativa BOOLEAN NOT NULL DEFAULT FALSE,      -- só 1 depois de assinada
  validada_por TEXT, validada_em TIMESTAMPTZ,
  versao INT NOT NULL DEFAULT 1,
  CHECK (NOT ativa OR (validada_por IS NOT NULL AND validada_em IS NOT NULL))   -- assinatura obrigatória
);

CREATE TABLE IF NOT EXISTS regra_complementar (
  regra_id TEXT REFERENCES regra_afinidade(id) ON DELETE CASCADE,
  categoria_id TEXT NOT NULL,
  subcategoria_like TEXT,                    -- ILIKE sobre subcategoria_id (slug do hmr3)
  papel_cesto TEXT NOT NULL CHECK (papel_cesto IN ('PRINCIPAL','COMPLEMENTAR','HIGIENE_BARREIRA')),
  PRIMARY KEY (regra_id, categoria_id, COALESCE(subcategoria_like, ''))
);

CREATE TABLE IF NOT EXISTS campanha_calendario (
  campanha_id TEXT PRIMARY KEY,
  titulo TEXT NOT NULL,
  meses_alvo INT[] NOT NULL,
  dias_especiais TEXT[] NOT NULL DEFAULT '{}',   -- 'MM-DD' (anual)
  tipo TEXT NOT NULL CHECK (tipo IN ('EPOCA_CALENDARIO','LIQUIDACAO_STOCK')),
  desconto_sugerido_pct NUMERIC(4,1) NOT NULL,
  antecedencia_dias INT NOT NULL DEFAULT 30,
  ativa BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS campanha_eixo (
  campanha_id TEXT REFERENCES campanha_calendario(campanha_id) ON DELETE CASCADE,
  categoria_id TEXT NOT NULL,
  subcategoria_like TEXT,
  papel_cesto TEXT NOT NULL CHECK (papel_cesto IN ('PRINCIPAL','COMPLEMENTAR','HIGIENE_BARREIRA')),
  PRIMARY KEY (campanha_id, categoria_id, COALESCE(subcategoria_like, ''))
);

-- NULL = todo o ano (365 subcategorias NEUTRO); semear a partir das 29 com época definida
CREATE TABLE IF NOT EXISTS subcategoria_epoca (
  subcategoria_id TEXT PRIMARY KEY,
  meses INT[]                                  -- ex.: {10,11,12,1,2,3}
);

CREATE TABLE IF NOT EXISTS sinonimo_queixa (termo TEXT PRIMARY KEY, queixa_id TEXT NOT NULL);  -- termo normalizado (minúsculas, sem acentos)

-- ── v_catalogo_enriquecido (esboço; adaptar à camada semântica, sempre filtrada por farmaciaId) ──
-- Campos que as ferramentas esperam: cnp_codigo, categoria_id, subcategoria_id, finalidade_curta, papel_cesto, publico,
--   precisa_receita, permite_marketing, permite_desconto_promo, uso_veterinario, qualidade_classificacao,
--   tags_presentes TEXT[], tags_desconhecidas TEXT[], taxa_iva, custo_unitario_medio.
-- permite_marketing = NOT precisa_receita AND NOT uso_veterinario AND qualidade_classificacao IN
--   ('OFICIAL','MNSRM_CONFIRMADO_DT','VALIDADO_REGRA','VALIDADO_PRODUTO')
-- Fail-safe: não-MSRM sem DCI em categorias orais/farmacológicas
--   (DOR_FEBRE, TOSSE_GRIPE, NASAL, ARTICULAR_MUSCULAR, DIGESTIVO, OLHOS, CIRCULACAO) =>
--   tags_desconhecidas ⊇ {aine, vasoconstritor, contem_cafeina_estimulante}.
