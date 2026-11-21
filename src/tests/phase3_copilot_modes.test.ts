import { describe, it, expect } from 'vitest';
import { getScopedToolsForMode, getSystemPromptForMode, CopilotMode } from '../services/copilot_engine';
import { classifyQuestionIntent } from '../services/copilot_validation';

describe('Fase 3: Copilot Assertivo nos Modos e Gating por Intenção', () => {
  it('deve filtrar ferramentas por modo e bloquear ferramentas de decisão em perguntas de consulta', () => {
    const stockTools = getScopedToolsForMode('STOCKS');
    const financeTools = getScopedToolsForMode('FINANCE');
    const clinicalTools = getScopedToolsForMode('CLINICAL');
    const marketingTools = getScopedToolsForMode('MARKETING');
    const allTools = getScopedToolsForMode('GENERAL');

    expect(stockTools.length).toBeGreaterThan(0);
    expect(stockTools.length).toBeLessThan(allTools.length);
    expect(financeTools.length).toBeLessThan(allTools.length);
    expect(clinicalTools.length).toBeLessThan(allTools.length);
    expect(marketingTools.length).toBeLessThan(allTools.length);

    // Gating por intenção: pergunta sobre vendas expõe APENAS as 9 ferramentas neutras de dados
    const intentVendas = classifyQuestionIntent('preciso de saber como estão as vendas dos produtos do laboratorio Bial.');
    const toolsVendas = getScopedToolsForMode('GENERAL', intentVendas);
    expect(toolsVendas.some((t) => t.name === 'consultar_vendas')).toBe(true);
    expect(toolsVendas.some((t) => t.name === 'gerar_proposta_encomenda_reposicao')).toBe(false);
    expect(toolsVendas.some((t) => t.name === 'planear_compras_laboratorio')).toBe(false);

    // Quando pede encomenda, desbloqueia ferramentas de decisão
    const intentCompras = classifyQuestionIntent('Que produtos da Bial devo encomendar esta semana?');
    const toolsCompras = getScopedToolsForMode('GENERAL', intentCompras);
    expect(toolsCompras.some((t) => t.name === 'planear_compras_laboratorio')).toBe(true);
    expect(toolsCompras.some((t) => t.name === 'gerar_proposta_encomenda_reposicao')).toBe(true);
  });

  it('deve fornecer System Prompt com contrato em XML, regras de domínio e exemplos', () => {
    const modes: CopilotMode[] = ['STOCKS', 'FINANCE', 'MARKETING', 'CLINICAL', 'GENERAL'];
    for (const m of modes) {
      const prompt = getSystemPromptForMode(m);
      expect(prompt).toContain('<contrato_de_resposta>');
      expect(prompt).toContain('<regras_dominio>');
      expect(prompt).toContain('<exemplos>');
    }
  });
});
