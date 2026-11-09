import { describe, it, expect } from 'vitest';
import { checkToolPermission } from '../services/mcp_governance.js';

describe('Governança e Permissões de Agentes MCP', () => {
  it('Perfil COMPLETO deve ter acesso a todas as ferramentas financeiras e operacionais', () => {
    const resFin = checkToolPermission('COMPLETO', 'analisar_evolucao_mensal_financeira');
    expect(resFin.allowed).toBe(true);

    const resStock = checkToolPermission('COMPLETO', 'consultar_produtos_por_nome_ou_categoria');
    expect(resStock.allowed).toBe(true);
  });

  it('Perfil BALCAO_CLINICO deve bloquear ferramentas financeiras de margem mas permitir pesquisa clínica', () => {
    const resFin = checkToolPermission('BALCAO_CLINICO', 'analisar_evolucao_mensal_financeira');
    expect(resFin.allowed).toBe(false);
    expect(resFin.reason).toContain('dados financeiros confidenciais');

    const resCurva = checkToolPermission('BALCAO_CLINICO', 'analisar_curva_abc_faturacao_e_margem');
    expect(resCurva.allowed).toBe(false);

    const resStock = checkToolPermission('BALCAO_CLINICO', 'consultar_produtos_por_nome_ou_categoria');
    expect(resStock.allowed).toBe(true);

    const resVal = checkToolPermission('BALCAO_CLINICO', 'filtrar_produtos_por_validade_e_margem');
    expect(resVal.allowed).toBe(true);
  });

  it('Perfil GESTAO_COMPRAS deve permitir encomendas e compras sazonais mas restringir anomalias críticas', () => {
    const resEnc = checkToolPermission('GESTAO_COMPRAS', 'gerar_proposta_encomenda_reposicao');
    expect(resEnc.allowed).toBe(true);

    const resAnomalia = checkToolPermission('GESTAO_COMPRAS', 'auditar_anomalias_margem_e_precos');
    expect(resAnomalia.allowed).toBe(false);
  });
});
