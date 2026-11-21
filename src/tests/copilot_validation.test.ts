import { describe, it, expect } from 'vitest';
import {
  validateCopilotAnswer,
  extractCnps,
  classifyQuestionIntent,
  postProcessCopilotText,
  stripUnsolicitedPurchaseSections,
} from '../services/copilot_validation';

describe('Validação determinística V1-V14 e Router de Intenção', () => {
  it('extrai CNP de 7 dígitos', () => {
    expect([...extractCnps('Ilvico 8665604 ↗ e 3767589')].sort()).toEqual(['3767589', '8665604']);
  });

  it('V4: rejeita CNP citado que não veio das ferramentas', () => {
    const r = validateCopilotAnswer('Recomendo o 8665604', ['{"cnp":"7377390"}'], ['consultar_produtos']);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('8665604');
  });

  it('V4: aceita CNP presente nos resultados', () => {
    const r = validateCopilotAnswer('Produto 7377390', ['{"cnp":"7377390"}'], ['consultar_produtos']);
    expect(r.ok).toBe(true);
  });

  it('V5: rejeita deduções com "presumível" e posologias médicas', () => {
    const r1 = validateCopilotAnswer('Deltius | DCI: Vitamina D (presumível)', ['{"cnp":"5768619"}'], ['consultar_produtos']);
    expect(r1.ok).toBe(false);
    expect(r1.problems[0]).toContain('[V5]');

    const r2 = validateCopilotAnswer('Tomar 1 comp/dia ao pequeno-almoço.', ['{"cnp":"7374827"}'], ['consultar_produtos']);
    expect(r2.ok).toBe(false);
    expect(r2.problems[0]).toContain('[V5]');
  });

  it('V1: bloqueia secções "PRODUTOS PARA ENCOMENDAR" / "PROIBIDOS DE ENCOMENDAR" quando a pergunta é só de vendas', () => {
    const intent = classifyQuestionIntent('preciso de saber como estão as vendas dos produtos do laboratorio Bial.');
    expect(intent.decisionAllowed).toBe(false);

    const textoComEncomendas = `
Resumo de Vendas Bial: 443 un.

### ✅ PRODUTOS PARA ENCOMENDAR (4 produtos)
| CNP | Designação |
| 5764410 | Edistride |

### 🚫 PRODUTOS PROIBIDOS DE ENCOMENDAR
| 5764337 | Ebymect |
    `.trim();

    const v = validateCopilotAnswer(textoComEncomendas, ['["5764410","5764337"]'], ['consultar_vendas'], intent);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes('[V1]'))).toBe(true);

    // Verifica que stripUnsolicitedPurchaseSections limpa as secções ofensivas
    const limpo = stripUnsolicitedPurchaseSections(textoComEncomendas);
    expect(limpo).toContain('Resumo de Vendas Bial');
    expect(limpo).not.toContain('PRODUTOS PARA ENCOMENDAR');
    expect(limpo).not.toContain('PRODUTOS PROIBIDOS DE ENCOMENDAR');
  });

  it('V8, V12 e V14: pós-processamento remove botões não autorizados, vistas internas e acrescenta nota de margem estimada', () => {
    const intent = classifyQuestionIntent('como estão as vendas da Bial?');
    const out = postProcessCopilotText(
      'Consultei v_metricas (r_0001). Margem de 23,6%. [BOTAO_EXPORTAR_ENCOMENDA_CSV]',
      ['consultar_vendas'],
      ['{"margem_metodo":"estimada_custo_medio_atual"}'],
      intent
    );
    expect(out).not.toContain('[BOTAO_EXPORTAR_ENCOMENDA_CSV]');
    expect(out).not.toContain('v_metricas');
    expect(out).not.toContain('r_0001');
    expect(out).toContain('_Margem estimada com o custo médio atual._');
  });
});
