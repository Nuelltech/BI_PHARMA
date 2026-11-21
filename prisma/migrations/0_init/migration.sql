-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Farmacia" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "nif" TEXT NOT NULL,
    "codigo_acesso" TEXT,
    "mcpPermitido" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Farmacia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProdutoMestre" (
    "cnp_codigo" TEXT NOT NULL,
    "aim" TEXT,
    "designacao" TEXT NOT NULL,
    "tipo_venda" TEXT,
    "macro_area" TEXT,
    "categoria" TEXT,
    "subcategoria" TEXT,
    "sazonalidade" TEXT,
    "gh_codigo" TEXT,
    "gh_switch_cnp" TEXT,
    "gh_switch_nome" TEXT,
    "gh_switch_margem_ganho" DECIMAL(10,2),
    "pvp" DECIMAL(10,2),
    "margem_padrao" DECIMAL(10,2),
    "taxa_iva" INTEGER,
    "dci" TEXT,
    "dosagem" TEXT,
    "forma_farmaceutica" TEXT,
    "embalagem" TEXT,
    "laboratorio_titular" TEXT,
    "indicacoes_clinicas" TEXT,
    "papel_recomendacao" TEXT,
    "contraindicacoes_aviso" TEXT,
    "fonte_enriquecimento" TEXT,

    CONSTRAINT "ProdutoMestre_pkey" PRIMARY KEY ("cnp_codigo")
);

-- CreateTable
CREATE TABLE "StagingInventario" (
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

    CONSTRAINT "StagingInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagingValidades" (
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

    CONSTRAINT "StagingValidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagingVendas" (
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

    CONSTRAINT "StagingVendas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventario" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "cnp_codigo" TEXT NOT NULL,
    "lote" TEXT NOT NULL DEFAULT 'LOTE ÚNICO',
    "prateleira" TEXT,
    "quantidade" INTEGER NOT NULL,
    "custo_unitario" DECIMAL(10,2) NOT NULL,
    "data_validade" TIMESTAMP(3),
    "data_extracao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venda" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "cnp_codigo" TEXT NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "valor_total" DECIMAL(10,2) NOT NULL,
    "data_venda" TIMESTAMP(3) NOT NULL,
    "granularidade" TEXT NOT NULL DEFAULT 'MENSAL',

    CONSTRAINT "Venda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventarioSnapshot" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "cnp_codigo" TEXT NOT NULL,
    "data_snapshot" TIMESTAMP(3) NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "custo_unitario" DECIMAL(10,2) NOT NULL,
    "valor_total" DECIMAL(10,2) NOT NULL,
    "data_extracao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventarioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrecoFarmacia" (
    "farmaciaId" TEXT NOT NULL,
    "cnp_codigo" TEXT NOT NULL,
    "pvp" DECIMAL(10,2),
    "margem" DECIMAL(10,2),
    "custo_ref" DECIMAL(10,2),
    "atualizadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrecoFarmacia_pkey" PRIMARY KEY ("farmaciaId","cnp_codigo")
);

-- CreateTable
CREATE TABLE "TarefaEquipa" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "week_key" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "cnp_codigo" TEXT,
    "designacao" TEXT,
    "concluido" BOOLEAN NOT NULL DEFAULT true,
    "concluido_por" TEXT,
    "concluido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valor_impacto" DECIMAL(10,2),
    "campanha_id" TEXT,

    CONSTRAINT "TarefaEquipa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampanhaAtiva" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "campanhaId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "icone" TEXT NOT NULL DEFAULT '🎯',
    "dataInicio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataFim" TIMESTAMP(3),
    "estado" TEXT NOT NULL DEFAULT 'ATIVA',
    "descontoAplicadoPct" INTEGER NOT NULL DEFAULT 15,
    "produtosJson" JSONB NOT NULL,
    "criadoPor" TEXT NOT NULL DEFAULT 'Diretor',
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampanhaAtiva_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotUsageLog" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "sessionId" TEXT,
    "modelo" TEXT NOT NULL,
    "pergunta" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_creation_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "custo_estimado_eur" DECIMAL(10,5) NOT NULL,
    "ferramentas_executadas" JSONB,
    "duracao_ms" INTEGER,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpConnector" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "agenteTipo" TEXT NOT NULL DEFAULT 'CLAUDE_WEB',
    "perfilPermissao" TEXT NOT NULL DEFAULT 'COMPLETO',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoPor" TEXT DEFAULT 'DIRETOR',
    "ultimoAcessoEm" TIMESTAMP(3),
    "ultimoIp" TEXT,
    "ultimoUserAgent" TEXT,
    "totalChamadas" INTEGER NOT NULL DEFAULT 0,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAuditLog" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "connectorId" TEXT,
    "ferramenta" TEXT NOT NULL,
    "parametros" TEXT,
    "sucesso" BOOLEAN NOT NULL DEFAULT true,
    "duracaoMs" INTEGER,
    "ip" TEXT,
    "userAgent" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faturas_processadas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "drive_file_id" TEXT NOT NULL,
    "nome_ficheiro_original" TEXT NOT NULL,
    "nome_ficheiro_novo" TEXT,
    "fornecedor" TEXT,
    "farmacia" TEXT,
    "tipo_documento" TEXT,
    "numero_documento" TEXT,
    "data_documento" DATE,
    "valor_total" DECIMAL,
    "confianca" TEXT NOT NULL,
    "motivo_baixa_confianca" TEXT,
    "status_processamento" TEXT NOT NULL,
    "numero_lote_associado" TEXT,
    "drive_file_url" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "data_vencimento" DATE,
    "nif_fornecedor" TEXT,

    CONSTRAINT "faturas_processadas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumos_lote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "drive_file_id" TEXT NOT NULL,
    "numero_lote" TEXT NOT NULL,
    "fornecedor" TEXT NOT NULL,
    "farmacia" TEXT,
    "data_lote" DATE,
    "valor_total_lote" DECIMAL,
    "lista_faturas_agregadas" JSONB,
    "soma_faturas_processadas" DECIMAL DEFAULT 0.00,
    "lote_conciliado" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resumos_lote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faturas_nuelltech" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "drive_file_id" TEXT NOT NULL,
    "nome_ficheiro_original" TEXT NOT NULL,
    "nome_ficheiro_novo" TEXT,
    "fornecedor" TEXT,
    "nif_emissor" TEXT,
    "pais_emissor" TEXT,
    "tipo_documento" TEXT,
    "numero_documento" TEXT,
    "data_documento" DATE,
    "data_vencimento" DATE,
    "moeda" TEXT DEFAULT 'EUR',
    "valor_total" DECIMAL,
    "valor_subtotal" DECIMAL,
    "valor_iva" DECIMAL,
    "regime_iva" TEXT,
    "categoria_despesa" TEXT,
    "descricao_resumida" TEXT,
    "confianca" TEXT NOT NULL,
    "motivo_baixa_confianca" TEXT,
    "status_processamento" TEXT NOT NULL DEFAULT 'PROCESSADO',
    "drive_file_url" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faturas_nuelltech_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Farmacia_nif_key" ON "Farmacia"("nif");

-- CreateIndex
CREATE UNIQUE INDEX "Farmacia_codigo_acesso_key" ON "Farmacia"("codigo_acesso");

-- CreateIndex
CREATE INDEX "StagingInventario_batch_id_idx" ON "StagingInventario"("batch_id");

-- CreateIndex
CREATE INDEX "StagingInventario_processado_idx" ON "StagingInventario"("processado");

-- CreateIndex
CREATE INDEX "StagingValidades_batch_id_idx" ON "StagingValidades"("batch_id");

-- CreateIndex
CREATE INDEX "StagingValidades_processado_idx" ON "StagingValidades"("processado");

-- CreateIndex
CREATE INDEX "StagingVendas_batch_id_idx" ON "StagingVendas"("batch_id");

-- CreateIndex
CREATE INDEX "StagingVendas_processado_idx" ON "StagingVendas"("processado");

-- CreateIndex
CREATE INDEX "Inventario_farmaciaId_idx" ON "Inventario"("farmaciaId");

-- CreateIndex
CREATE INDEX "Inventario_cnp_codigo_idx" ON "Inventario"("cnp_codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Inventario_farmaciaId_cnp_codigo_lote_key" ON "Inventario"("farmaciaId", "cnp_codigo", "lote");

-- CreateIndex
CREATE INDEX "Venda_farmaciaId_idx" ON "Venda"("farmaciaId");

-- CreateIndex
CREATE INDEX "Venda_cnp_codigo_idx" ON "Venda"("cnp_codigo");

-- CreateIndex
CREATE INDEX "Venda_data_venda_idx" ON "Venda"("data_venda");

-- CreateIndex
CREATE INDEX "Venda_farmaciaId_granularidade_data_venda_idx" ON "Venda"("farmaciaId", "granularidade", "data_venda");

-- CreateIndex
CREATE UNIQUE INDEX "Venda_farmaciaId_cnp_codigo_data_venda_granularidade_key" ON "Venda"("farmaciaId", "cnp_codigo", "data_venda", "granularidade");

-- CreateIndex
CREATE INDEX "InventarioSnapshot_farmaciaId_data_snapshot_idx" ON "InventarioSnapshot"("farmaciaId", "data_snapshot");

-- CreateIndex
CREATE INDEX "InventarioSnapshot_cnp_codigo_idx" ON "InventarioSnapshot"("cnp_codigo");

-- CreateIndex
CREATE UNIQUE INDEX "InventarioSnapshot_farmaciaId_cnp_codigo_data_snapshot_key" ON "InventarioSnapshot"("farmaciaId", "cnp_codigo", "data_snapshot");

-- CreateIndex
CREATE INDEX "PrecoFarmacia_farmaciaId_idx" ON "PrecoFarmacia"("farmaciaId");

-- CreateIndex
CREATE INDEX "TarefaEquipa_farmaciaId_week_key_idx" ON "TarefaEquipa"("farmaciaId", "week_key");

-- CreateIndex
CREATE INDEX "TarefaEquipa_concluido_idx" ON "TarefaEquipa"("concluido");

-- CreateIndex
CREATE INDEX "TarefaEquipa_campanha_id_idx" ON "TarefaEquipa"("campanha_id");

-- CreateIndex
CREATE UNIQUE INDEX "TarefaEquipa_farmaciaId_week_key_task_id_key" ON "TarefaEquipa"("farmaciaId", "week_key", "task_id");

-- CreateIndex
CREATE INDEX "CampanhaAtiva_farmaciaId_estado_idx" ON "CampanhaAtiva"("farmaciaId", "estado");

-- CreateIndex
CREATE INDEX "CopilotUsageLog_farmaciaId_criadoEm_idx" ON "CopilotUsageLog"("farmaciaId", "criadoEm");

-- CreateIndex
CREATE INDEX "CopilotUsageLog_criadoEm_idx" ON "CopilotUsageLog"("criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "McpConnector_token_key" ON "McpConnector"("token");

-- CreateIndex
CREATE INDEX "McpConnector_farmaciaId_idx" ON "McpConnector"("farmaciaId");

-- CreateIndex
CREATE INDEX "McpConnector_token_idx" ON "McpConnector"("token");

-- CreateIndex
CREATE INDEX "McpAuditLog_farmaciaId_criadoEm_idx" ON "McpAuditLog"("farmaciaId", "criadoEm");

-- CreateIndex
CREATE INDEX "McpAuditLog_connectorId_idx" ON "McpAuditLog"("connectorId");

-- CreateIndex
CREATE UNIQUE INDEX "faturas_processadas_drive_file_id_key" ON "faturas_processadas"("drive_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "faturas_nuelltech_drive_file_id_key" ON "faturas_nuelltech"("drive_file_id");

-- AddForeignKey
ALTER TABLE "StagingInventario" ADD CONSTRAINT "StagingInventario_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingValidades" ADD CONSTRAINT "StagingValidades_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagingVendas" ADD CONSTRAINT "StagingVendas_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventario" ADD CONSTRAINT "Inventario_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventario" ADD CONSTRAINT "Inventario_cnp_codigo_fkey" FOREIGN KEY ("cnp_codigo") REFERENCES "ProdutoMestre"("cnp_codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venda" ADD CONSTRAINT "Venda_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venda" ADD CONSTRAINT "Venda_cnp_codigo_fkey" FOREIGN KEY ("cnp_codigo") REFERENCES "ProdutoMestre"("cnp_codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventarioSnapshot" ADD CONSTRAINT "InventarioSnapshot_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventarioSnapshot" ADD CONSTRAINT "InventarioSnapshot_cnp_codigo_fkey" FOREIGN KEY ("cnp_codigo") REFERENCES "ProdutoMestre"("cnp_codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrecoFarmacia" ADD CONSTRAINT "PrecoFarmacia_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TarefaEquipa" ADD CONSTRAINT "TarefaEquipa_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampanhaAtiva" ADD CONSTRAINT "CampanhaAtiva_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotUsageLog" ADD CONSTRAINT "CopilotUsageLog_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpConnector" ADD CONSTRAINT "McpConnector_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAuditLog" ADD CONSTRAINT "McpAuditLog_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAuditLog" ADD CONSTRAINT "McpAuditLog_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "McpConnector"("id") ON DELETE SET NULL ON UPDATE CASCADE;

