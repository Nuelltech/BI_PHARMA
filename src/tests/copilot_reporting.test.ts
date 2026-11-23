import { describe, it, expect } from 'vitest';
import { parseMarkdownToExecutiveReport } from '../services/copilot_reporting';

describe('Copilot Executive Reporting Engine', () => {
  it('1. Converte markdown exploratório em Relatório Executivo formal', () => {
    const rawMarkdown = `
### Análise de Validades Críticas do 1º Trimestre
Identificámos vários produtos com prazo limite até Março de 2027 que exigem decisão imediata da farmácia.
O valor em risco é significativo e impacta a tesouraria.

| CNP | Designação | Validade | Quantidade | Custo Total | Ação Recomendada |
| --- | --- | --- | --- | --- | --- |
| 5653019 | Spiolto Respimat 60 doses | 2027-02-28 | 3 un | 120,50 € | Devolver ao Armazenista |
| 5744370 | Orovox Mel e Limão | 2027-03-31 | 15 un | 35,20 € | Destaque no Balcão |

### Ações Recomendadas:
1. Contactar o armazenista para recolha antes de 15 dias da expiração.
2. Criar campanha de balcão para os produtos de venda livre.
3. Auditar a prateleira física número 4.
    `;

    const report = parseMarkdownToExecutiveReport(rawMarkdown, {
      farmaciaNome: 'Farmácia Central',
      responsavel: 'Dra. Maria (DT)',
    });

    expect(report.titulo).toBe('Análise de Validades Críticas do 1º Trimestre');
    expect(report.farmaciaNome).toBe('Farmácia Central');
    expect(report.responsavel).toBe('Dra. Maria (DT)');
    expect(report.diagnostico).toContain('Identificámos vários produtos com prazo limite');
    expect(report.kpis.length).toBeGreaterThan(0);
    expect(report.tabela).toBeDefined();
    expect(report.tabela?.colunas).toEqual(['CNP', 'Designação', 'Validade', 'Quantidade', 'Custo Total', 'Ação Recomendada']);
    expect(report.tabela?.linhas.length).toBe(2);
    expect(report.tabela?.totalRegistos).toBe(2);
    expect(report.recomendacoes.length).toBe(3);
    expect(report.recomendacoes[0]).toContain('Contactar o armazenista');
  });

  it('2. Gere tabelas de grande volume com aviso de limite no PDF e totalRegistos para Excel', () => {
    let rawTable = `
### Inventário com Risco Elevado
| CNP | Designação | Quantidade |
| --- | --- | --- |
`;
    for (let i = 1; i <= 60; i++) {
      rawTable += `| 50000${i} | Produto Teste ${i} | ${i} un |\n`;
    }

    const report = parseMarkdownToExecutiveReport(rawTable, {
      farmaciaNome: 'Farmácia Demo',
    });

    expect(report.tabela).toBeDefined();
    expect(report.tabela?.totalRegistos).toBe(60);
    // No PDF limita aos primeiros 25 para evitar documentos intermináveis
    expect(report.tabela?.linhas.length).toBe(25);
    expect(report.tabela?.avisoLimite).toContain('A apresentar os 25 produtos mais críticos');
    expect(report.tabela?.avisoLimite).toContain('60 registos');
  });

  it('3. Resiste a texto vazio ou informal devolvendo relatório limpo', () => {
    const report = parseMarkdownToExecutiveReport('', {
      farmaciaNome: 'Farmácia B',
    });

    expect(report.titulo).toBe('Relatório Executivo da Farmácia');
    expect(report.farmaciaNome).toBe('Farmácia B');
    expect(report.recomendacoes.length).toBeGreaterThan(0);
  });
});
