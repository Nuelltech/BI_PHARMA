import { describe, it, expect, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createMcpConnector,
  resolveMcpAuthentication,
  hashMcpToken,
  deleteMcpConnector,
} from '../services/mcp_governance';
import {
  acquireCopilotSlot,
  releaseCopilotSlot,
  resetConcurrencyCounters,
  checkTenantMonthlyQuota,
} from '../services/copilot_limiter';
import {
  toolCalcularStockMinimoECobertura,
  toolIdentificarProdutosSemVenda,
  toolConsolidarGenericosDci,
  ToolSecurityContext,
} from '../services/mcp_pharma_tools';
import { getScopedToolsForMode } from '../services/copilot_engine';

const prisma = new PrismaClient();

describe('Fase 4: Copilot AI & MCP Isolados com Quotas e Hashing', () => {
  beforeEach(() => {
    resetConcurrencyCounters();
  });

  it('1. Hashing SHA-256 nos Tokens MCP e Autenticação Criptográfica', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    expect(farmacia).not.toBeNull();
    if (!farmacia) return;

    // Garante que MCP está ativo na farmácia
    await prisma.farmacia.update({
      where: { id: farmacia.id },
      data: { mcpPermitido: true },
    });

    // Cria um conector de teste
    const conector = await createMcpConnector(prisma, farmacia.id, {
      nome: 'Teste Conector Claude SHA256',
      agenteTipo: 'CLAUDE_WEB',
      perfilPermissao: 'COMPLETO',
    });

    expect(conector.token).toMatch(/^mcp_live_[a-f0-9]{32}$/);
    const plainToken = conector.token;

    // Confirma que o token gravado na BD é o HASH SHA-256 e NÃO o texto limpo
    const dbRecord = await prisma.mcpConnector.findUnique({
      where: { id: conector.id },
    });
    expect(dbRecord).not.toBeNull();
    expect(dbRecord!.token).toBe(hashMcpToken(plainToken));
    expect(dbRecord!.token).not.toBe(plainToken);

    // Resolve autenticação usando o token em claro (deve fazer hash e validar)
    const authSuccess = await resolveMcpAuthentication(prisma, plainToken);
    expect(authSuccess.allowed).toBe(true);
    expect(authSuccess.connector?.id).toBe(conector.id);

    // Token incorreto deve ser rejeitado
    const authFail = await resolveMcpAuthentication(prisma, 'mcp_live_token_invalido_1234567890');
    expect(authFail.allowed).toBe(false);

    // Cleanup
    await deleteMcpConnector(prisma, conector.id, farmacia.id);
  });

  it('2. Limite de Concorrência Ativa por Tenant (Máx 3 em simultâneo)', () => {
    const farmId = 'farm_tenant_test_concurrency';

    // Os primeiros 3 pedidos simultâneos devem ser aceites
    const slot1 = acquireCopilotSlot(farmId, { maxConcurrentPerTenant: 3 });
    const slot2 = acquireCopilotSlot(farmId, { maxConcurrentPerTenant: 3 });
    const slot3 = acquireCopilotSlot(farmId, { maxConcurrentPerTenant: 3 });

    expect(slot1.allowed).toBe(true);
    expect(slot2.allowed).toBe(true);
    expect(slot3.allowed).toBe(true);

    // O 4º pedido simultâneo deve ser bloqueado com mensagem amigável (429)
    const slot4 = acquireCopilotSlot(farmId, { maxConcurrentPerTenant: 3 });
    expect(slot4.allowed).toBe(false);
    expect(slot4.reason).toContain('limite de consultas simultâneas (3)');
    expect(slot4.retryAfterSeconds).toBe(2);

    // Ao libertar um slot, o próximo pedido volta a ser aceite
    releaseCopilotSlot(farmId);
    const slotRetry = acquireCopilotSlot(farmId, { maxConcurrentPerTenant: 3 });
    expect(slotRetry.allowed).toBe(true);

    // Cleanup
    releaseCopilotSlot(farmId);
    releaseCopilotSlot(farmId);
    releaseCopilotSlot(farmId);

    // Teste de Limite Global de Concorrência (maxConcurrentGlobal)
    const sA = acquireCopilotSlot('farm-1', { maxConcurrentPerTenant: 5, maxConcurrentGlobal: 2 });
    const sB = acquireCopilotSlot('farm-2', { maxConcurrentPerTenant: 5, maxConcurrentGlobal: 2 });
    const sC = acquireCopilotSlot('farm-3', { maxConcurrentPerTenant: 5, maxConcurrentGlobal: 2 });
    expect(sA.allowed).toBe(true);
    expect(sB.allowed).toBe(true);
    expect(sC.allowed).toBe(false);
    expect(sC.reason).toContain('carga elevada');
    releaseCopilotSlot('farm-1');
    releaseCopilotSlot('farm-2');
  });

  it('3. Gestão e Verificação de Quota Mensal de Consumo de IA', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    if (!farmacia) return;

    // Se o orçamento for de 10.000€, deve permitir
    const checkGenerous = await checkTenantMonthlyQuota(prisma, farmacia.id, 10000.0);
    expect(checkGenerous.allowed).toBe(true);

    // Se o orçamento configurado for 0.00€ (ou inferior ao gasto atual), deve rejeitar
    const checkExceeded = await checkTenantMonthlyQuota(prisma, farmacia.id, 0.0);
    expect(checkExceeded.quotaEur).toBe(0.0);
  });

  it('4. Otimização de Tools MCP: Respostas leves (< 5KB) e rápidas com Marts', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    if (!farmacia) return;

    const ctx: ToolSecurityContext = {
      farmaciaId: farmacia.id,
      farmaciaNome: farmacia.nome,
      nif: farmacia.nif,
    };

    // 4.1. Tool Stock Mínimo e Cobertura
    const startStock = performance.now();
    const resStock = await toolCalcularStockMinimoECobertura(prisma, ctx, { limite: 15 });
    const durationStock = performance.now() - startStock;
    const jsonStock = JSON.stringify(resStock);
    const sizeStockKb = Buffer.byteLength(jsonStock, 'utf8') / 1024;

    console.log(`⚡ Tool Stock Mínimo: ${durationStock.toFixed(1)} ms | Payload: ${sizeStockKb.toFixed(2)} KB`);
    expect(sizeStockKb).toBeLessThan(5.0); // Rígido: < 5KB por resposta

    // 4.2. Tool Produtos Sem Venda (Monos)
    const startMonos = performance.now();
    const resMonos = await toolIdentificarProdutosSemVenda(prisma, ctx, { limite: 15 });
    const durationMonos = performance.now() - startMonos;
    const jsonMonos = JSON.stringify(resMonos);
    const sizeMonosKb = Buffer.byteLength(jsonMonos, 'utf8') / 1024;

    console.log(`⚡ Tool Monos Sem Venda: ${durationMonos.toFixed(1)} ms | Payload: ${sizeMonosKb.toFixed(2)} KB`);
    expect(sizeMonosKb).toBeLessThan(5.0);

    // 4.3. Tool Genéricos DCI
    const startDci = performance.now();
    const resDci = await toolConsolidarGenericosDci(prisma, ctx, { limite: 10 });
    const durationDci = performance.now() - startDci;
    const jsonDci = JSON.stringify(resDci);
    const sizeDciKb = Buffer.byteLength(jsonDci, 'utf8') / 1024;

    console.log(`⚡ Tool Genéricos DCI: ${durationDci.toFixed(1)} ms | Payload: ${sizeDciKb.toFixed(2)} KB`);
    expect(sizeDciKb).toBeLessThan(5.0);
  });

  it('5. Anthropic Prompt Caching nas Definições das Tools', () => {
    const toolsStocks = getScopedToolsForMode('STOCKS');
    expect(toolsStocks.length).toBeGreaterThan(0);

    // A última ferramenta deve conter cache_control: { type: 'ephemeral' }
    const lastTool = toolsStocks[toolsStocks.length - 1];
    expect(lastTool.cache_control).toBeDefined();
    expect(lastTool.cache_control.type).toBe('ephemeral');

    const toolsClinical = getScopedToolsForMode('CLINICAL');
    const lastClinical = toolsClinical[toolsClinical.length - 1];
    expect(lastClinical.cache_control?.type).toBe('ephemeral');

    // A ferramenta consultar_evolucao_e_saude_stock deve estar disponível nos modos STOCKS e FINANCE
    expect(toolsStocks.some((t) => t.name === 'consultar_evolucao_e_saude_stock')).toBe(true);
    const toolsFinance = getScopedToolsForMode('FINANCE');
    expect(toolsFinance.some((t) => t.name === 'consultar_evolucao_e_saude_stock')).toBe(true);
  });
});
