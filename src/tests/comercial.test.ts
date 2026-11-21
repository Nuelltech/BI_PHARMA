import { describe, it, expect } from 'vitest';
import {
  Cand, Calendario, CampanhaAtivaRow, Regra, GatilhoRes, Repo, Cfg, Ctx,
  janela, epocaFit, parseDia, pvpMinCents, precoPromo,
  sugerirVendasCruzadas, sugerirPacksPromocionais, COLUNAS_CRUZADAS,
} from '../services/comercial';

// ───────── fixtures ─────────
const p = (o: Partial<Cand> = {}): Cand => ({
  cnp_codigo: '1000001', designacao: 'Produto', categoria_id: 'LABIAL', subcategoria_id: 'x', finalidade_curta: 'finalidade',
  papel_cesto: 'COMPLEMENTAR', publico: 'TODOS', precisa_receita: false, permite_marketing: true, permite_desconto_promo: true,
  uso_veterinario: false, qualidade_classificacao: 'VALIDADO_REGRA', tags_presentes: [], tags_desconhecidas: [],
  stock_total_unidades: 5, pvp: 10, custo_unitario_medio: 4, taxa_iva: 23, margem_pct: 30,
  eh_risco_caducidade: false, data_validade_mais_proxima: null, meses_ate_validade: null,
  eh_mono: false, dias_sem_vendas: null, eh_excesso_cobertura: false, cobertura_meses: null, eh_resto_gaveta: false, ...o,
});

const CAL: Calendario[] = [
  { campanha_id: 'imunidade', titulo: 'Imunidade / Gripe', meses_alvo: [11, 12, 1, 2], dias_especiais: [], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 15, antecedencia_dias: 30 },
  { campanha_id: 'diabetes', titulo: 'Dia Mundial da Diabetes', meses_alvo: [11], dias_especiais: ['11-14'], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 10, antecedencia_dias: 15 },
  { campanha_id: 'novembro_azul', titulo: 'Novembro Azul', meses_alvo: [11], dias_especiais: [], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 10, antecedencia_dias: 15 },
  { campanha_id: 'black_friday', titulo: 'Black Friday', meses_alvo: [11], dias_especiais: [], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 20, antecedencia_dias: 15 },
  { campanha_id: 'natal', titulo: 'Natal / Coffrets', meses_alvo: [11, 12], dias_especiais: [], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 15, antecedencia_dias: 45 },
  { campanha_id: 'frio', titulo: 'Barreira Cutânea / Frio', meses_alvo: [12, 1, 2, 3], dias_especiais: [], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 15, antecedencia_dias: 30 },
  { campanha_id: 'solares', titulo: 'Verão / Solares', meses_alvo: [5, 6, 7, 8], dias_especiais: [], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 15, antecedencia_dias: 30 },
  { campanha_id: 'micoses', titulo: 'Micoses Praia / Piscina', meses_alvo: [7, 8, 9], dias_especiais: [], tipo: 'EPOCA_CALENDARIO', desconto_sugerido_pct: 10, antecedencia_dias: 30 },
];

const EPOCA: Record<string, number[] | null> = {
  protector_labial_sem_factor_proteccao: [10, 11, 12, 1, 2, 3],
  protector_labial_com_factor_proteccao: [4, 5, 6, 7, 8, 9],
  protector_solar_adulto: [4, 5, 6, 7, 8, 9],
};

const CFG: Cfg = {
  familiaPermiteGatilho: { ANTIDIABETICO: true, ANTIBIOTICO_SISTEMICO: true, PSICOFARMACO: false, OUTROS_RX: false },
  familiaRestricao: { ANTIDIABETICO: ['contem_acucar'] },
  dciRestricaoExtra: { finerenona: ['aine', 'contem_acucar'] },
  condicaoRestricao: { ANTICOAGULADO: ['aine', 'interage_anticoagulante'], DIABETICO: ['contem_acucar'] },
  minProdutosTema: 3,
};

class FakeRepo implements Repo {
  stored: unknown[] = [];
  constructor(private o: Partial<{ gatilho: GatilhoRes; regras: Regra[]; cand: Cand[]; porCampanha: Record<string, Cand[]>; cal: Calendario[]; epoca: Record<string, number[] | null>; ativas: CampanhaAtivaRow[] }> = {}) {}
  async resolverGatilho() { return this.o.gatilho ?? ({ ok: false, codigo: 'GATILHO_NAO_RESOLVIDO', sugestoes: ['lábios secos'] } as GatilhoRes); }
  async regrasAtivas() { return this.o.regras ?? []; }
  async candidatosPorRegras() { return this.o.cand ?? []; }
  async candidatosPorCampanha(id: string) { return this.o.porCampanha?.[id] ?? []; }
  async calendario() { return this.o.cal ?? CAL; }
  async epocaSubcategoria() { return this.o.epoca ?? EPOCA; }
  async campanhasAtivas() { return this.o.ativas ?? []; }
  store(payload: unknown) { this.stored.push(payload); return `r_${String(this.stored.length).padStart(4, '0')}`; }
}

const ctx = (repo: Repo, dia = '2026-11-19'): Ctx => ({ repo, ref: parseDia(dia), cfg: CFG });
const col = (r: any, nome: string, cols = COLUNAS_CRUZADAS) => r.linhas.map((l: unknown[]) => l[cols.indexOf(nome)]);
const gOk = (familias: string[], extra: Partial<Extract<GatilhoRes, { ok: true }>> = {}): GatilhoRes =>
  ({ ok: true, tipo: 'familia', id: familias[0] ?? 'X', familias, dci: [], publico_inferido: null, ...extra });
const R = (id: string, o: Partial<Regra> = {}): Regra => ({ id, condicao_aplicacao: 'cond', exige_publico: false, restricoes_bloqueio_extra: [], ...o });
const many = (n: number, o: Partial<Cand> = {}) => Array.from({ length: n }, (_, i) => p({ cnp_codigo: `${2000000 + i}`, subcategoria_id: `s${i}`, ...o }));

// ───────── época, janela, preço ─────────
describe('janela() — 2026-11-19', () => {
  const ref = parseDia('2026-11-19');
  const j = (id: string) => janela(CAL.find((c) => c.campanha_id === id)!, ref);
  it('em época', () => ['imunidade', 'diabetes', 'novembro_azul', 'black_friday', 'natal'].forEach((id) => expect(j(id)).toBe('EM_EPOCA')));
  it('próxima: Frio começa a 1 dez (12 dias, antecedência 30)', () => expect(j('frio')).toBe('PROXIMA'));
  it('fora: Solares e Micoses', () => { expect(j('solares')).toBe('FORA'); expect(j('micoses')).toBe('FORA'); });
  it('dia especial anual conta como em época', () => expect(janela({ ...CAL[1], meses_alvo: [] }, parseDia('2027-11-14'))).toBe('EM_EPOCA'));
  it('atravessa o ano (Dez a Mar)', () => expect(janela(CAL[5], parseDia('2027-02-10'))).toBe('EM_EPOCA'));
});

describe('epocaFit()', () => {
  it('Q01: sem FPS dentro em janeiro, com FPS fora', () => {
    expect(epocaFit('protector_labial_sem_factor_proteccao', parseDia('2027-01-15'), EPOCA)).toBe('DENTRO');
    expect(epocaFit('protector_labial_com_factor_proteccao', parseDia('2027-01-15'), EPOCA)).toBe('FORA');
    expect(epocaFit('inexistente', parseDia('2027-01-15'), EPOCA)).toBe('NEUTRO');
  });
});

describe('precoPromo()', () => {
  const x = { custo_unitario_medio: 10, taxa_iva: 23, pvp: 15.9 };
  it('pvp mínimo = ceil(custo/0.95*1.23)', () => expect(pvpMinCents(10, 23)).toBe(1295));
  it('desconto dentro do limite', () => expect(precoPromo(x, 15)).toMatchObject({ limitado_por_regra_legal: false }));
  it('limita ao mínimo legal', () => {
    const r: any = precoPromo(x, 30);
    expect(r.limitado_por_regra_legal).toBe(true);
    expect(r.preco).toBeCloseTo(12.95, 2);
    expect(r.margem_pct_promo).toBeGreaterThanOrEqual(5);
  });
  it('exclui se nem o PVP cumpre', () => expect(precoPromo({ ...x, pvp: 12.5 }, 0)).toEqual({ excluir: 'MARGEM_INSUFICIENTE_NO_PVP' }));
});

// ───────── sugerir_vendas_cruzadas ─────────
describe('sugerirVendasCruzadas', () => {
  it('antidiabético: exclui açúcar presente E desconhecido (falha segura)', async () => {
    const repo = new FakeRepo({
      gatilho: gOk(['ANTIDIABETICO']), regras: [R('R02')],
      cand: [p({ cnp_codigo: '1', regra_id: 'R02' }), p({ cnp_codigo: '2', regra_id: 'R02', tags_desconhecidas: ['contem_acucar'] }), p({ cnp_codigo: '3', regra_id: 'R02', tags_presentes: ['contem_acucar'] })],
    });
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'ANTIDIABETICO' } }, ctx(repo));
    expect(col(r, 'cnp_codigo')).toEqual(['1']);
    expect(r.meta.excluidos_resumo).toMatchObject({ restricao_bloqueada: 1, restricao_desconhecida: 1 });
  });

  it('Ib-u-ron sem DCI (aine DESCONHECIDO) nunca aparece para ANTICOAGULADO', async () => {
    const ibu = p({ cnp_codigo: '5450838', tags_desconhecidas: ['aine', 'vasoconstritor', 'contem_cafeina_estimulante'], regra_id: 'Q15' });
    const repo = new FakeRepo({ gatilho: gOk([], { tipo: 'queixa', id: 'DOR_MUSCULAR' }), regras: [R('Q15')], cand: [ibu, p({ cnp_codigo: '9', regra_id: 'Q15' })] });
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'queixa', valor: 'dor muscular' }, condicoes_cliente: ['ANTICOAGULADO'] }, ctx(repo));
    expect(col(r, 'cnp_codigo')).toEqual(['9']);
    const sem: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'queixa', valor: 'dor muscular' } }, ctx(repo));
    expect(col(sem, 'cnp_codigo')).toContain('5450838'); // sem condição, não bloqueia
  });

  it('dciRestricaoExtra (Finerenona) bloqueia AINE e açúcar', async () => {
    const repo = new FakeRepo({ gatilho: gOk(['ANTIBIOTICO_SISTEMICO'], { dci: ['finerenona'] }), regras: [R('R01')], cand: [p({ cnp_codigo: '1', tags_presentes: ['aine'], regra_id: 'R01' }), p({ cnp_codigo: '2', regra_id: 'R01' })] });
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'cnp', valor: '1' } }, ctx(repo));
    expect(col(r, 'cnp_codigo')).toEqual(['2']);
  });

  it('defesa em profundidade: MSRM, veterinário, marketing bloqueado e qualidade fraca nunca saem', async () => {
    const repo = new FakeRepo({
      gatilho: gOk(['ANTIDIABETICO']), regras: [R('R02')],
      cand: [
        p({ cnp_codigo: '1', precisa_receita: true }), p({ cnp_codigo: '2', uso_veterinario: true }),
        p({ cnp_codigo: '3', permite_marketing: false, qualidade_classificacao: 'CONFLITO_RX' }),
        p({ cnp_codigo: '4', qualidade_classificacao: 'REGRA_NAO_VALIDADA' }), p({ cnp_codigo: '5', stock_total_unidades: 0 }),
        p({ cnp_codigo: '6', qualidade_classificacao: 'MNSRM_CONFIRMADO_DT' }),
      ],
    });
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'x' } }, ctx(repo));
    expect(col(r, 'cnp_codigo')).toEqual(['6']);
    expect(r.meta.excluidos_resumo).toMatchObject({ nao_elegivel_legal: 3, qualidade_insuficiente: 1, sem_stock: 1 });
  });

  it('SEM_REGRA_VALIDADA devolve ok com 0 linhas e motivo', async () => {
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'x' } }, ctx(new FakeRepo({ gatilho: gOk(['ANTIDIABETICO']), regras: [] })));
    expect(r.ok).toBe(true); expect(r.meta.motivo).toBe('SEM_REGRA_VALIDADA'); expect(r.linhas).toEqual([]);
  });

  it('GATILHO_NAO_RESOLVIDO com sugestões (nunca adivinha)', async () => {
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'texto', valor: 'dor no ombro' } }, ctx(new FakeRepo()));
    expect(r.ok).toBe(false); expect(r.erro.codigo).toBe('GATILHO_NAO_RESOLVIDO'); expect(r.erro.sugestoes.length).toBeGreaterThan(0);
  });

  it('GATILHO_NAO_PERMITIDO (psicofármaco) e FAMILIA_NAO_CATALOGADA (OUTROS_RX)', async () => {
    const a: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'cnp', valor: '1' } }, ctx(new FakeRepo({ gatilho: gOk(['PSICOFARMACO'], { tipo: 'cnp' }) })));
    expect(a.erro.codigo).toBe('GATILHO_NAO_PERMITIDO');
    const b: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'cnp', valor: '1' } }, ctx(new FakeRepo({ gatilho: gOk(['OUTROS_RX'], { tipo: 'cnp' }) })));
    expect(b.erro.codigo).toBe('FAMILIA_NAO_CATALOGADA');
  });

  it('PUBLICO_NECESSARIO quando a regra exige e não há inferência; com público já responde', async () => {
    const repo = new FakeRepo({ gatilho: gOk(['ANTIBIOTICO_SISTEMICO']), regras: [R('R01', { exige_publico: true })], cand: [p({ cnp_codigo: '1', publico: 'ADULTO', regra_id: 'R01' }), p({ cnp_codigo: '2', publico: 'PEDIATRICO', regra_id: 'R01' })] });
    const a: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'x' } }, ctx(repo));
    expect(a.meta.publico_necessario).toBe(true); expect(a.linhas).toEqual([]);
    const b: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'x' }, publico: 'ADULTO' }, ctx(repo));
    expect(col(b, 'cnp_codigo')).toEqual(['1']);
  });

  it('ordem: caducidade > mono > excesso > campanha > época > margem', async () => {
    const hoje = '2026-11-19';
    const repo = new FakeRepo({
      gatilho: gOk(['ANTIDIABETICO']), regras: [R('R')],
      cand: [
        p({ cnp_codigo: 'margem', margem_pct: 80, regra_id: 'R' }),
        p({ cnp_codigo: 'excesso', eh_excesso_cobertura: true, margem_pct: 10, regra_id: 'R' }),
        p({ cnp_codigo: 'mono', eh_mono: true, margem_pct: 10, regra_id: 'R' }),
        p({ cnp_codigo: 'cad_tarde', eh_risco_caducidade: true, data_validade_mais_proxima: '2027-02-01', regra_id: 'R' }),
        p({ cnp_codigo: 'cad_cedo', eh_risco_caducidade: true, data_validade_mais_proxima: '2026-12-01', regra_id: 'R' }),
        p({ cnp_codigo: 'campanha', margem_pct: 20, regra_id: 'R' }),
      ],
      ativas: [{ id: 'ca_1', cnps: ['campanha'], descontoAplicadoPct: 10, dataInicio: '2026-11-01', dataFim: '2026-11-30', estado: 'ATIVA' }],
    });
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'x' }, limite: 10 }, ctx(repo, hoje));
    expect(col(r, 'cnp_codigo')).toEqual(['cad_cedo', 'cad_tarde', 'mono', 'excesso', 'campanha', 'margem']);
  });

  it('Q01 janeiro: stick sem FPS (época) antes do com FPS mesmo com menos margem', async () => {
    const cand = [
      p({ cnp_codigo: 'com', subcategoria_id: 'protector_labial_com_factor_proteccao', margem_pct: 60, regra_id: 'Q01' }),
      p({ cnp_codigo: 'sem', subcategoria_id: 'protector_labial_sem_factor_proteccao', margem_pct: 40, regra_id: 'Q01' }),
    ];
    const mk = (dia: string, c = cand) => sugerirVendasCruzadas({ gatilho: { tipo: 'queixa', valor: 'labios secos' } }, ctx(new FakeRepo({ gatilho: gOk([], { tipo: 'queixa' }), regras: [R('Q01')], cand: c }), dia));
    expect(col(await mk('2027-01-15'), 'cnp_codigo')).toEqual(['sem', 'com']);
    expect(col(await mk('2026-07-10'), 'cnp_codigo')).toEqual(['com', 'sem']);
    // época NÃO elimina: o mono de FPS em janeiro continua à frente
    const mono = [cand[0] && { ...cand[0], eh_mono: true }, cand[1]] as Cand[];
    const r: any = await mk('2027-01-15', mono);
    expect(col(r, 'cnp_codigo')).toEqual(['com', 'sem']);
    expect(col(r, 'epoca_fit')).toEqual(['FORA', 'DENTRO']);
  });

  it('campanha ativa: pvp_promo e alerta_legal se abaixo do mínimo; fora de datas não conta', async () => {
    const cand = [p({ cnp_codigo: 'a', pvp: 10, custo_unitario_medio: 4, regra_id: 'R' }), p({ cnp_codigo: 'b', pvp: 15.9, custo_unitario_medio: 10, regra_id: 'R' }), p({ cnp_codigo: 'c', regra_id: 'R' })];
    const ativas: CampanhaAtivaRow[] = [
      { id: 'ca_a', cnps: ['a'], descontoAplicadoPct: 15, dataInicio: '2026-11-01', dataFim: '2026-11-30', estado: 'ATIVA' },
      { id: 'ca_b', cnps: ['b'], descontoAplicadoPct: 30, dataInicio: '2026-11-01', dataFim: '2026-11-30', estado: 'ATIVA' },
      { id: 'ca_c', cnps: ['c'], descontoAplicadoPct: 15, dataInicio: '2026-12-01', dataFim: '2026-12-31', estado: 'ATIVA' },
    ];
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'x' }, limite: 10 }, ctx(new FakeRepo({ gatilho: gOk(['ANTIDIABETICO']), regras: [R('R')], cand, ativas })));
    const por = Object.fromEntries(r.linhas.map((l: unknown[]) => [l[1], l]));
    const i = (n: string) => COLUNAS_CRUZADAS.indexOf(n);
    expect(por.a[i('pvp_promo')]).toBe(8.5); expect(por.a[i('alerta_legal')]).toBeNull();
    expect(por.b[i('alerta_legal')]).toBe('CAMPANHA_ABAIXO_MINIMO');
    expect(por.c[i('em_campanha_ativa')]).toBe(false);
    expect(r.meta.campanhas_ativas_consideradas).toBe(2);
  });

  it('um CNP vindo de duas regras aparece uma vez (regra de maior prioridade)', async () => {
    const r: any = await sugerirVendasCruzadas({ gatilho: { tipo: 'familia', valor: 'x' } }, ctx(new FakeRepo({
      gatilho: gOk(['ANTIDIABETICO']), regras: [R('R02'), R('R03')], cand: [p({ cnp_codigo: '1', regra_id: 'R03' }), p({ cnp_codigo: '1', regra_id: 'R02' })] })));
    expect(r.linhas.length).toBe(1); expect(col(r, 'regra_id')).toEqual(['R02']);
  });
});

// ───────── sugerir_packs_promocionais ─────────
const principal = (o: Partial<Cand> = {}) => p({ papel_cesto: 'PRINCIPAL', subcategoria_id: 'principal', ...o });

describe('sugerirPacksPromocionais — TEMAS', () => {
  it('2026-11-19: temas em época + Frio próximo; Solares/Micoses fora e contados', async () => {
    const porCampanha: Record<string, Cand[]> = {};
    for (const c of CAL) porCampanha[c.campanha_id] = many(4, { subcategoria_id: 'neutra' }).map((x, i) => ({ ...x, subcategoria_id: `n${i}` }));
    porCampanha.diabetes = many(2); // poucos produtos -> eliminado
    const r: any = await sugerirPacksPromocionais({ modo: 'TEMAS' }, ctx(new FakeRepo({ porCampanha })));
    const ids = r.linhas.map((l: unknown[]) => l[0]);
    expect(ids).toEqual(expect.arrayContaining(['imunidade', 'novembro_azul', 'black_friday', 'natal', 'frio']));
    expect(ids).not.toContain('solares'); expect(ids).not.toContain('micoses'); expect(ids).not.toContain('diabetes');
    expect(r.meta.temas_fora_de_epoca).toBe(2);
    expect(r.meta.excluidos_resumo.sem_produtos_suficientes).toBe(1);
    expect(r.linhas.find((l: unknown[]) => l[0] === 'frio')[2]).toBe('PROXIMA');
    expect(r.linhas[r.linhas.length - 1][2]).toBe('PROXIMA'); // em época primeiro
  });
});

describe('sugerirPacksPromocionais — PACK', () => {
  const base = (): Cand[] => [principal({ cnp_codigo: 'P', publico: 'ADULTO' }), p({ cnp_codigo: 'C1', subcategoria_id: 'c1', publico: 'TODOS' }), p({ cnp_codigo: 'C2', subcategoria_id: 'c2', publico: 'ADULTO', papel_cesto: 'HIGIENE_BARREIRA' })];

  it('nunca Solares em novembro (TEMA_FORA_DE_EPOCA); liquidação explícita permite', async () => {
    const solar = [principal({ cnp_codigo: 'S', subcategoria_id: 'protector_solar_adulto', eh_mono: true }), p({ cnp_codigo: 'S2', subcategoria_id: 'after', eh_mono: true })];
    const repo = new FakeRepo({ porCampanha: { solares: solar } });
    const a: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'solares' }, ctx(repo));
    expect(a.erro.codigo).toBe('TEMA_FORA_DE_EPOCA');
    const b: any = await sugerirPacksPromocionais({ modo: 'PACK', tema: 'solares', liquidacao: true }, ctx(repo));
    expect(b.ok).toBe(true); expect(col(b, 'cnp_codigo', b.colunas)).toContain('S');
  });

  it('pack válido: um principal, preço ≥ mínimo, validacao_legal ok, pack_proposto_id', async () => {
    const r: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade', desconto_pct: 15 }, ctx(new FakeRepo({ porCampanha: { imunidade: base() } })));
    expect(r.validacao_legal).toEqual({ ok: true, violacoes: [] });
    expect(r.pack_proposto_id).toMatch(/^r_/);
    expect(r.linhas.length).toBe(3);
    expect(col(r, 'papel_cesto', r.colunas).filter((x: string) => x === 'PRINCIPAL').length).toBe(1);
    for (const l of r.linhas) expect(Math.round(l[r.colunas.indexOf('preco_promo')] * 100)).toBeGreaterThanOrEqual(pvpMinCents(4, 23));
  });

  it('desconto pedido acima do permitido é limitado e sinalizado', async () => {
    const itens = [principal({ cnp_codigo: 'P', pvp: 15.9, custo_unitario_medio: 10 }), p({ cnp_codigo: 'C1', subcategoria_id: 'c1', pvp: 15.9, custo_unitario_medio: 10 })];
    const r: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade', desconto_pct: 30 }, ctx(new FakeRepo({ porCampanha: { imunidade: itens } })));
    const i = r.colunas.indexOf('limitado_por_regra_legal');
    expect(r.linhas.every((l: unknown[]) => l[i] === true)).toBe(true);
    expect(r.totais.margem_pct_cesto).toBeGreaterThanOrEqual(5);
  });

  it('produto sem permissão de desconto fica fora (salvo incluir_preco_fixo, aí sem desconto)', async () => {
    const itens = [...base(), p({ cnp_codigo: 'F', subcategoria_id: 'f', permite_desconto_promo: false })];
    const repo = new FakeRepo({ porCampanha: { imunidade: itens } });
    const a: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade', n_produtos_max: 5 }, ctx(repo));
    expect(col(a, 'cnp_codigo', a.colunas)).not.toContain('F');
    const b: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade', n_produtos_max: 5, incluir_preco_fixo: true }, ctx(repo));
    const l = b.linhas.find((x: unknown[]) => x[0] === 'F');
    expect(l[b.colunas.indexOf('desconto_efetivo_pct')]).toBe(0);
  });

  it('produto já em campanha ativa é excluído e listado em conflito_campanha', async () => {
    const ativas: CampanhaAtivaRow[] = [{ id: 'ca_9', cnps: ['C1'], descontoAplicadoPct: 20, dataInicio: '2026-11-01', dataFim: '2026-11-30', estado: 'ATIVA' }];
    const repo = new FakeRepo({ porCampanha: { imunidade: base() }, ativas });
    const a: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade' }, ctx(repo));
    expect(col(a, 'cnp_codigo', a.colunas)).not.toContain('C1');
    expect(a.meta.conflito_campanha).toEqual([{ cnp: 'C1', campanha_ativa_id: 'ca_9' }]);
    const b: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade', incluir_em_campanha: true }, ctx(repo));
    expect(col(b, 'cnp_codigo', b.colunas)).toContain('C1');
  });

  it('ADULTO e PEDIATRICO nunca se misturam; sem público e com os dois principais -> pergunta', async () => {
    const itens = [principal({ cnp_codigo: 'PA', publico: 'ADULTO' }), principal({ cnp_codigo: 'PP', publico: 'PEDIATRICO', subcategoria_id: 'pp' }),
      p({ cnp_codigo: 'CA', subcategoria_id: 'ca', publico: 'ADULTO' }), p({ cnp_codigo: 'CP', subcategoria_id: 'cp', publico: 'PEDIATRICO' }), p({ cnp_codigo: 'CT', subcategoria_id: 'ct', publico: 'TODOS' })];
    const repo = new FakeRepo({ porCampanha: { imunidade: itens } });
    const a: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade' }, ctx(repo));
    expect(a.meta.publico_necessario).toBe(true);
    const b: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade', publico: 'PEDIATRICO' }, ctx(repo));
    const ids = col(b, 'cnp_codigo', b.colunas);
    expect(ids).toContain('PP'); expect(ids).not.toContain('PA'); expect(ids).not.toContain('CA');
  });

  it('MSRM, veterinário e qualidade fraca nunca entram; sem principal -> CESTO_INCOMPLETO', async () => {
    const itens = [principal({ cnp_codigo: 'X', precisa_receita: true }), p({ cnp_codigo: 'V', uso_veterinario: true }), p({ cnp_codigo: 'Q', qualidade_classificacao: 'REGRA_NAO_VALIDADA' }), p({ cnp_codigo: 'OK', subcategoria_id: 'ok' })];
    const r: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade' }, ctx(new FakeRepo({ porCampanha: { imunidade: itens } })));
    expect(r.meta.motivo).toBe('CESTO_INCOMPLETO'); expect(r.linhas).toEqual([]);
  });

  it('produto cujo PVP já viola a margem mínima é excluído', async () => {
    const itens = [principal({ cnp_codigo: 'P' }), p({ cnp_codigo: 'ruim', subcategoria_id: 'ruim', pvp: 4.5, custo_unitario_medio: 4 }), p({ cnp_codigo: 'C1', subcategoria_id: 'c1' })];
    const r: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'imunidade' }, ctx(new FakeRepo({ porCampanha: { imunidade: itens } })));
    expect(col(r, 'cnp_codigo', r.colunas)).not.toContain('ruim');
  });

  it('data_referencia explícita (planeamento) muda a janela', async () => {
    const repo = new FakeRepo({ porCampanha: { solares: [principal({ cnp_codigo: 'S', subcategoria_id: 'protector_solar_adulto' }), p({ cnp_codigo: 'S2', subcategoria_id: 'after' })] } });
    const a: any = await sugerirPacksPromocionais({ modo: 'PACK', campanha_id: 'solares', data_referencia: '2027-04-20' }, ctx(repo)); // 11 dias antes de maio
    expect(a.ok).toBe(true); expect(a.meta.campanha.janela).toBe('PROXIMA'); expect(a.meta.data_referencia).toBe('2027-04-20');
  });

  it('tema desconhecido -> erro com sugestões', async () => {
    const r: any = await sugerirPacksPromocionais({ modo: 'PACK', tema: 'carnaval no espaço' }, ctx(new FakeRepo()));
    expect(r.erro.codigo).toBe('TEMA_NAO_RESOLVIDO');
  });
});
