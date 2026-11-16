import { describe, it, expect } from 'vitest';
import { getScopedToolsForMode, getSystemPromptForMode, CopilotMode } from '../services/copilot_engine';

describe('Fase 3: Copilot Assertivo nos 4 Modos Especializados', () => {
  it('deve filtrar ferramentas específicas por modo operacional', () => {
    const stockTools = getScopedToolsForMode('STOCKS');
    const financeTools = getScopedToolsForMode('FINANCE');
    const clinicalTools = getScopedToolsForMode('CLINICAL');
    const marketingTools = getScopedToolsForMode('MARKETING');
    const allTools = getScopedToolsForMode('GENERAL');

    // Cada modo deve ter um subconjunto focado (redução drástica de context window)
    expect(stockTools.length).toBeGreaterThan(0);
    expect(stockTools.length).toBeLessThan(allTools.length);

    expect(financeTools.length).toBeGreaterThan(0);
    expect(financeTools.length).toBeLessThan(allTools.length);

    expect(clinicalTools.length).toBeGreaterThan(0);
    expect(clinicalTools.length).toBeLessThan(allTools.length);

    expect(marketingTools.length).toBeGreaterThan(0);
    expect(marketingTools.length).toBeLessThan(allTools.length);

    // Ferramentas específicas nos modos certos
    expect(stockTools.some(t => t.name === 'calcular_stock_minimo_e_cobertura')).toBe(true);
    expect(financeTools.some(t => t.name === 'analisar_curva_abc_faturacao_e_margem')).toBe(true);
    expect(clinicalTools.some(t => t.name === 'analisar_consolidacao_genericos_dci')).toBe(true);
    expect(marketingTools.some(t => t.name === 'sugerir_packs_promocionais')).toBe(true);
  });

  it('deve fornecer System Prompts cirúrgicos e assertivos para cada modo', () => {
    const modes: CopilotMode[] = ['STOCKS', 'FINANCE', 'MARKETING', 'CLINICAL'];
    for (const m of modes) {
      const prompt = getSystemPromptForMode(m);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).toContain('DIRETRIZES');
    }

    // Validações específicas por persona
    expect(getSystemPromptForMode('CLINICAL')).toContain('CLARIFICAÇÃO ATIVA');
    expect(getSystemPromptForMode('FINANCE')).toContain('Tabela Comparativa');
    expect(getSystemPromptForMode('MARKETING')).toContain('Mini-Campanha');
    expect(getSystemPromptForMode('STOCKS')).toContain('PROIBIDO texto corrido');
  });
});
