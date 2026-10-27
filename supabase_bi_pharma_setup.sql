-- ============================================================================
-- BI PHARMA — SCRIPT NÃO-DESTRUTIVO PARA PROJETO SUPABASE PARTILHADO
-- Seguro para correr no mesmo projeto onde já existem:
--   • public.faturas_processadas
--   • public.resumos_lote
--   • public.faturas_nuelltech
-- Usa exclusivamente CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public."Farmacia" (
  "id" TEXT NOT NULL,
  "nome" TEXT NOT NULL,
  "nif" TEXT NOT NULL,
  "codigo_acesso" TEXT,
  "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Farmacia_pkey" PRIMARY KEY ("id")
);

ALTER TABLE public."Farmacia" ADD COLUMN IF NOT EXISTS "codigo_acesso" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Farmacia_nif_key" ON public."Farmacia"("nif");
CREATE UNIQUE INDEX IF NOT EXISTS "Farmacia_codigo_acesso_key" ON public."Farmacia"("codigo_acesso");

CREATE TABLE IF NOT EXISTS public."ProdutoMestre" (
  "cnp_codigo" TEXT NOT NULL,
  "aim" TEXT,
  "designacao" TEXT NOT NULL,
  "tipo_venda" TEXT,
  "categoria" TEXT,
  "pvp" DECIMAL(10,2),
  "margem_padrao" DECIMAL(10,2),
  "taxa_iva" INTEGER,
  CONSTRAINT "ProdutoMestre_pkey" PRIMARY KEY ("cnp_codigo")
);

CREATE TABLE IF NOT EXISTS public."StagingInventario" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "farmaciaId" TEXT NOT NULL,
  "prat" TEXT,
  "aim" TEXT,
  "codigo" TEXT,
  "designacao" TEXT,
  "lote" TEXT,
  "stock" TEXT,
  "custo_unit" TEXT,
  "valor_s_iva" TEXT,
  "taxa_iva" TEXT,
  "data_extracao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processado" BOOLEAN NOT NULL DEFAULT false,
  "erro_validacao" TEXT,
  CONSTRAINT "StagingInventario_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StagingInventario_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES public."Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "StagingInventario_batch_id_idx" ON public."StagingInventario"("batch_id");
CREATE INDEX IF NOT EXISTS "StagingInventario_processado_idx" ON public."StagingInventario"("processado");

CREATE TABLE IF NOT EXISTS public."StagingValidades" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "farmaciaId" TEXT NOT NULL,
  "ord" TEXT,
  "codigo" TEXT,
  "designacao" TEXT,
  "lote" TEXT,
  "stock" TEXT,
  "pratel" TEXT,
  "validade" TEXT,
  "correccao" TEXT,
  "data_extracao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processado" BOOLEAN NOT NULL DEFAULT false,
  "erro_validacao" TEXT,
  CONSTRAINT "StagingValidades_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StagingValidades_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES public."Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "StagingValidades_batch_id_idx" ON public."StagingValidades"("batch_id");
CREATE INDEX IF NOT EXISTS "StagingValidades_processado_idx" ON public."StagingValidades"("processado");

CREATE TABLE IF NOT EXISTS public."StagingVendas" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "farmaciaId" TEXT NOT NULL,
  "codigo_produto" TEXT,
  "descricao" TEXT,
  "quantidade" TEXT,
  "valor_venda" TEXT,
  "custo_unitario" TEXT,
  "pvp" TEXT,
  "margem" TEXT,
  "data_movimento" TEXT,
  "data_extracao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processado" BOOLEAN NOT NULL DEFAULT false,
  "erro_validacao" TEXT,
  CONSTRAINT "StagingVendas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StagingVendas_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES public."Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "StagingVendas_batch_id_idx" ON public."StagingVendas"("batch_id");
CREATE INDEX IF NOT EXISTS "StagingVendas_processado_idx" ON public."StagingVendas"("processado");

CREATE TABLE IF NOT EXISTS public."Inventario" (
  "id" TEXT NOT NULL,
  "farmaciaId" TEXT NOT NULL,
  "cnp_codigo" TEXT NOT NULL,
  "lote" TEXT NOT NULL DEFAULT 'LOTE ÚNICO',
  "prateleira" TEXT,
  "quantidade" INTEGER NOT NULL,
  "custo_unitario" DECIMAL(10,2) NOT NULL,
  "data_validade" TIMESTAMP(3),
  "data_extracao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Inventario_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Inventario_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES public."Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Inventario_cnp_codigo_fkey" FOREIGN KEY ("cnp_codigo") REFERENCES public."ProdutoMestre"("cnp_codigo") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Inventario_farmaciaId_cnp_codigo_lote_key" ON public."Inventario"("farmaciaId", "cnp_codigo", "lote");
CREATE INDEX IF NOT EXISTS "Inventario_farmaciaId_idx" ON public."Inventario"("farmaciaId");
CREATE INDEX IF NOT EXISTS "Inventario_cnp_codigo_idx" ON public."Inventario"("cnp_codigo");

CREATE TABLE IF NOT EXISTS public."Venda" (
  "id" TEXT NOT NULL,
  "farmaciaId" TEXT NOT NULL,
  "cnp_codigo" TEXT NOT NULL,
  "quantidade" INTEGER NOT NULL,
  "valor_total" DECIMAL(10,2) NOT NULL,
  "data_venda" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Venda_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Venda_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES public."Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Venda_cnp_codigo_fkey" FOREIGN KEY ("cnp_codigo") REFERENCES public."ProdutoMestre"("cnp_codigo") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Venda_farmaciaId_cnp_codigo_data_venda_key" ON public."Venda"("farmaciaId", "cnp_codigo", "data_venda");
CREATE INDEX IF NOT EXISTS "Venda_farmaciaId_idx" ON public."Venda"("farmaciaId");
CREATE INDEX IF NOT EXISTS "Venda_cnp_codigo_idx" ON public."Venda"("cnp_codigo");
CREATE INDEX IF NOT EXISTS "Venda_data_venda_idx" ON public."Venda"("data_venda");
