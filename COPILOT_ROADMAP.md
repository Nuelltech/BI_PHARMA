# Copilot BI Pharma — Roadmap de continuidade

Objetivo: assistente com raciocínio, iteração sobre dados e validação. Perfis: direção técnica, proprietário, balcão. Pode criar tarefas e exportar relatórios (com confirmação do utilizador).

## Ordem de implementação (marcar [x] ao concluir)
- [x] 1. Motor: `claude-haiku` -> Sonnet com extended thinking; `maxSteps` 4 -> 12 (`src/services/copilot_engine.ts`).
- [x] 2. Validação em código (`src/services/copilot_validation.ts`): CNP tem de existir nos resultados das tools; proibição de "presumível"/deduções; se falhar, reenviar ao modelo com o erro.
- [x] 3. `toolSugerirVendasCruzadasReceita` (`mcp_pharma_tools.ts`): declara ausência de base científica validada e remete a avaliação clínica para o Diretor Técnico da farmácia.
- [x] 4. Conjunto de teste (`src/tests/copilot_golden.test.ts`): Bial vs Labial, Bialzepam (Diazepam), monos set->out, venda cruzada metformina, camada semântica SQL.
- [x] 5. Camada semântica (`src/services/copilot_semantic_layer.ts`): vistas CTE com `farmaciaId` forçado + transação `READ ONLY` + timeout 5s; tool `consultar_sql` (limite de linhas, bloqueio de escrita/tabelas privadas).
- [x] 6. Tools genéricas: `descrever_dados`, `consultar_sql`, `ficha_produto` integradas em todos os modos do Copilot; correção de word-boundary (`\bbial\b` nunca casa com `labial`) e evolução dos últimos 3 meses em `analisar_desempenho_laboratorio`.
- [x] 7. Protocolo de raciocínio unificado (sem moldes forçados; *thinking* comanda a estrutura conforme os níveis da pergunta).
- [x] 8. Enriquecimento de `ProdutoMestre` e `MartProdutoMetricas` (`src/services/clinical_enrichment.ts` — 158 registos atualizados incluindo Bialzepam/Diazepam, Deltius, Diplexil, etc.).
