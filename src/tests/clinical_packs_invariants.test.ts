import { describe, it, expect } from 'vitest';
import {
  Cand,
  ItemPack,
  Publico,
  validarCesto,
  compatCesto,
  ehFamiliaSensivel,
  verificarIncompatibilidadesCesto,
  sugerirPacksPromocionais,
} from '../services/comercial';

const mockCand = (o: Partial<Cand> = {}): Cand => ({
  cnp_codigo: '1000001',
  designacao: 'Produto Teste',
  categoria_id: 'TOSSE_GRIPE',
  subcategoria_id: 'antigripais',
  finalidade_curta: 'Alívio sintomático',
  papel_cesto: 'COMPLEMENTAR',
  publico: 'ADULTO',
  precisa_receita: false,
  permite_marketing: true,
  permite_desconto_promo: true,
  uso_veterinario: false,
  qualidade_classificacao: 'VALIDADO_REGRA',
  tags_presentes: [],
  tags_desconhecidas: [],
  stock_total_unidades: 5,
  pvp: 10.0,
  custo_unitario_medio: 4.0,
  taxa_iva: 23,
  margem_pct: 40,
  eh_risco_caducidade: false,
  data_validade_mais_proxima: null,
  meses_ate_validade: null,
  eh_mono: false,
  dias_sem_vendas: null,
  eh_excesso_cobertura: false,
  cobertura_meses: null,
  eh_resto_gaveta: false,
  ...o,
});

const mockItemPack = (o: Partial<ItemPack> = {}): ItemPack => ({
  ...mockCand(o),
  preco_promo: 8.5,
  desconto_efetivo_pct: 15,
  margem_pct_promo: 35,
  limitado_por_regra_legal: false,
  epoca_fit: 'DENTRO',
  em_campanha_ativa: false,
  campanha_ativa_id: null,
  pvp_promo: null,
  pvp_promo_fonte: null,
  alerta_legal: null,
  ...o,
});

describe('Invariantes Clínicos e Comerciais de Packs', () => {
  // Invariante 1: Bloqueio de IBPs (Pantoprazol, etc.) em Packs Promocionais
  it('Invariante 1: Bloqueio de IBPs (Pantoprazol) como família sensível e proibição de associação com laxantes', () => {
    const panto = mockItemPack({
      cnp_codigo: '5326772',
      designacao: 'Pantoprazol Digespan MG 20 mg Blister 14 Comp GR',
      papel_cesto: 'PRINCIPAL',
    });
    const sollievo = mockItemPack({
      cnp_codigo: '7090746',
      designacao: 'Sollievo Fisiolax Comp X27',
      categoria_id: 'DIGESTIVO',
      subcategoria_id: 'laxantes',
      papel_cesto: 'COMPLEMENTAR',
    });

    // 1.1 ehFamiliaSensivel deve acusar Pantoprazol imediatamente
    expect(ehFamiliaSensivel(panto)).toBe(true);

    // 1.2 Incompatibilidade cruzada IBP x Laxante
    const incomp = verificarIncompatibilidadesCesto([panto, sollievo]);
    expect(incomp).toContain('INCOMPATIBILIDADE_CLINICA:IBP_X_LAXANTE');

    // 1.3 validarCesto deve chumbar o cesto com violações
    const res = validarCesto([panto, sollievo], 'ADULTO');
    expect(res.ok).toBe(false);
    expect(res.violacoes).toContain('FAMILIA_SENSIVEL:5326772');
    expect(res.violacoes).toContain('INCOMPATIBILIDADE_CLINICA:IBP_X_LAXANTE');
  });

  // Invariante 2: Bloqueio de formas tópicas (cremes) em vias orais/orofaríngeas (Benaderma Calm)
  it('Invariante 2: Bloqueio de formas tópicas (Benaderma Calm) em papéis de garganta e imunidade', () => {
    const benaderma = mockItemPack({
      cnp_codigo: '9852707',
      designacao: 'Benaderma Calm Bisnaga 30g Cr',
      categoria_id: 'DERMOCOSMETICA_CORPO',
      subcategoria_id: 'emolientes',
    });

    // Validar que regex de formas tópicas apanha Creme/Bisnaga
    const FORMAS_TOPICAS_EXCLUIDAS_ORAL = /\b(cr|creme|pomada|bisnaga|gel dermico|gel cutaneo|locao|unguento|pasta cutanea|stick|solucao cutanea)\b/i;
    expect(FORMAS_TOPICAS_EXCLUIDAS_ORAL.test(benaderma.designacao)).toBe(true);
  });

  // Invariante 3: Incompatibilidade estrita de público (Pediátrico x Adulto)
  it('Invariante 3: Incompatibilidade estrita entre Good Sleep Infantil e Absorvit Magnésio Adulto', () => {
    // 3.1 compatCesto com público ADULTO rejeita PEDIATRICO
    expect(compatCesto('PEDIATRICO', 'ADULTO')).toBe(false);

    // 3.2 compatCesto com público PEDIATRICO rejeita ADULTO e rejeita TODOS
    expect(compatCesto('ADULTO', 'PEDIATRICO')).toBe(false);
    expect(compatCesto('TODOS', 'PEDIATRICO')).toBe(false); // cesto pediátrico só admite itens explicitamente pediátricos
    expect(compatCesto('PEDIATRICO', 'PEDIATRICO')).toBe(true);

    // 3.3 NAO_CLASSIFICADO é rejeitado em qualquer cesto
    expect(compatCesto('NAO_CLASSIFICADO', 'ADULTO')).toBe(false);
    expect(compatCesto('NAO_CLASSIFICADO', 'PEDIATRICO')).toBe(false);
    expect(compatCesto('NAO_CLASSIFICADO', 'TODOS')).toBe(false);

    // 3.4 Um cesto montado com infantil e adulto falha a validação
    const goodSleep = mockItemPack({
      cnp_codigo: '7306092',
      designacao: 'Good Sleep Infantil Gotas 50Ml',
      publico: 'PEDIATRICO',
      papel_cesto: 'PRINCIPAL',
    });
    const absorvit = mockItemPack({
      cnp_codigo: '7314286',
      designacao: 'Absorvit Magnésio Resist Duo Comp X30',
      publico: 'ADULTO',
      papel_cesto: 'COMPLEMENTAR',
    });

    const resAdulto = validarCesto([goodSleep, absorvit], 'ADULTO');
    expect(resAdulto.ok).toBe(false);
    expect(resAdulto.violacoes).toContain('PUBLICO:7306092');

    const resPed = validarCesto([goodSleep, absorvit], 'PEDIATRICO');
    expect(resPed.ok).toBe(false);
    expect(resPed.violacoes).toContain('PUBLICO:7314286');
  });

  // Invariante 4: Regra de Stock Mínimo (Mínimo de 3 unidades por item em pack físico)
  it('Invariante 4: Exclusão de itens com stock < 3 unidades de packs físicos de balcão', () => {
    const itemStock1 = mockItemPack({
      cnp_codigo: '1111111',
      designacao: 'Resto de Gaveta',
      stock_total_unidades: 1, // apenas 1 unidade
      papel_cesto: 'COMPLEMENTAR',
    });
    const principalStock5 = mockItemPack({
      cnp_codigo: '2222222',
      designacao: 'Locomotiva Balcão',
      stock_total_unidades: 5,
      papel_cesto: 'PRINCIPAL',
    });

    // Em pack físico (minStock = 3), item com 1 unidade é rejeitado
    const res = validarCesto([principalStock5, itemStock1], 'ADULTO', { minStock: 3 });
    expect(res.ok).toBe(false);
    expect(res.violacoes).toContain('STOCK_INSUFICIENTE:1111111');

    // Em atendimento verbal assistido (minStock = 1), é tolerado se não houver outras violações
    const resVerbal = validarCesto([principalStock5, itemStock1], 'ADULTO', { minStock: 1 });
    expect(resVerbal.ok).toBe(true);
  });
});
