import { classifyProduct } from './classifier.js';

// ============================================================================
// BI-PHARMA — MÓDULO ÚNICO DE MÉTRICAS (Catálogo 2)
// Fonte única de verdade para: Painel (analysis.ts), Marts (marts_service.ts),
// Copilot v2 e Ferramentas MCP.
// ============================================================================

export type TaxaIvaOrigem = 'OFICIAL' | 'INFERIDA';
export type PvpOrigem = 'FARMACIA' | 'PRODUTO_MESTRE' | 'INEXISTENTE';

export interface TaxaIvaInfo {
  taxa_iva_pct: number;
  taxa_iva_origem: TaxaIvaOrigem;
}

export interface MargemSemIvaInfo {
  pvp_eur: number | null;
  pvp_origem: PvpOrigem;
  taxa_iva_pct: number;
  taxa_iva_origem: TaxaIvaOrigem;
  pvp_sem_iva_eur: number | null;
  custo_unitario_eur: number | null;
  margem_unitaria_eur: number | null;
  margem_pct: number | null;
}

export interface EstadosProdutoInput {
  stockTotal: number;
  vmm: number;
  vendasUltimos90d: number;
  ultimaVendaEfetiva: Date | null;
  dataReferencia: Date;
  janelaMonoDias?: number;
  validadeMaisProxima?: Date | null;
  custoUnitario?: number | null;
}

export interface EstadosProdutoResult {
  cobertura_meses: number | null;
  cobertura_dias: number | null;
  dias_sem_vendas: number | null;
  eh_mono: boolean;
  eh_resto_gaveta: boolean;
  eh_excesso_cobertura: boolean;
  unidades_excesso: number;
  capital_excesso_eur: number | null;
  eh_rutura: boolean;
  eh_risco_rutura: boolean;
  eh_validade_curta: boolean;
  eh_risco_caducidade: boolean;
  unidades_risco_caducidade: number;
  capital_risco_caducidade_eur: number | null;
  capital_imobilizado_eur: number | null;
}

/**
 * #27: Determina a taxa de IVA e sinaliza explicitamente se é OFICIAL (da BD) ou INFERIDA.
 */
export function calcularTaxaIva(
  taxaIvaDb?: number | null,
  tipoVenda?: string | null
): TaxaIvaInfo {
  const n = Number(taxaIvaDb);
  if (Number.isFinite(n) && n > 0 && n <= 30) {
    return { taxa_iva_pct: Math.round(n), taxa_iva_origem: 'OFICIAL' };
  }
  if (Number.isFinite(n) && n > 0 && n < 1) {
    return { taxa_iva_pct: Math.round(n * 100), taxa_iva_origem: 'OFICIAL' };
  }
  const t = String(tipoVenda || '').toUpperCase();
  const inferida = t.includes('MSRM') || t.includes('MNSRM') ? 6 : 23;
  return { taxa_iva_pct: inferida, taxa_iva_origem: 'INFERIDA' };
}

/**
 * Catálogo 2: Margem unitária (€ sem IVA) e Margem % sobre PVP sem IVA.
 * Nunca estima custo nem PVP. Quando falta custo ou PVP, devolve null.
 */
export function calcularMargemSemIva(params: {
  pvpFarmacia?: number | null;
  pvpMestre?: number | null;
  custoUnitario?: number | null;
  taxaIvaDb?: number | null;
  tipoVenda?: string | null;
}): MargemSemIvaInfo {
  const pvpF = Number(params.pvpFarmacia || 0);
  const pvpM = Number(params.pvpMestre || 0);
  const custo = Number(params.custoUnitario || 0);
  const iva = calcularTaxaIva(params.taxaIvaDb, params.tipoVenda);

  let pvp_eur: number | null = null;
  let pvp_origem: PvpOrigem = 'INEXISTENTE';
  if (pvpF > 0) {
    pvp_eur = Number(pvpF.toFixed(2));
    pvp_origem = 'FARMACIA';
  } else if (pvpM > 0) {
    pvp_eur = Number(pvpM.toFixed(2));
    pvp_origem = 'PRODUTO_MESTRE';
  }

  const pvp_sem_iva_eur =
    pvp_eur !== null ? Number((pvp_eur / (1 + iva.taxa_iva_pct / 100)).toFixed(2)) : null;

  const custo_unitario_eur = custo > 0 ? Number(custo.toFixed(4)) : null;

  let margem_unitaria_eur: number | null = null;
  let margem_pct: number | null = null;
  if (
    pvp_sem_iva_eur !== null &&
    pvp_sem_iva_eur > 0 &&
    custo_unitario_eur !== null &&
    custo_unitario_eur > 0
  ) {
    margem_unitaria_eur = Number((pvp_sem_iva_eur - custo_unitario_eur).toFixed(2));
    margem_pct = Number((((pvp_sem_iva_eur - custo_unitario_eur) / pvp_sem_iva_eur) * 100).toFixed(1));
  }

  return {
    pvp_eur,
    pvp_origem,
    taxa_iva_pct: iva.taxa_iva_pct,
    taxa_iva_origem: iva.taxa_iva_origem,
    pvp_sem_iva_eur,
    custo_unitario_eur,
    margem_unitaria_eur,
    margem_pct,
  };
}

/**
 * Catálogo 2: VMM único = unidades dos últimos 12 meses ÷ min(12, mesesComDados).
 */
export function calcularVmm(unidades12m: number, mesesComDados = 12): number {
  const divisor = Math.min(12, Math.max(1, Math.round(mesesComDados || 12)));
  return Number((Math.max(0, unidades12m) / divisor).toFixed(2));
}

/**
 * Catálogo 2: Cobertura em meses = stock ÷ VMM.
 * Se VMM = 0, devolve null (NUNCA 99 ou 999).
 */
export function calcularCoberturaMeses(stockTotal: number, vmm: number): number | null {
  if (vmm <= 0) return null;
  return Number((Math.max(0, stockTotal) / vmm).toFixed(2));
}

/**
 * Catálogo 2 (P1 #9): Com vendas mensais gravadas no dia 1 do mês,
 * a data efetiva da última venda conta como o último dia desse mês.
 */
export function dataEfetivaUltimaVenda(dataVenda: Date, granularidade?: string | null): Date {
  if (String(granularidade || 'MENSAL').toUpperCase() === 'DIARIO') {
    return dataVenda;
  }
  // Último dia do mês em UTC (dia 0 do mês seguinte)
  return new Date(Date.UTC(dataVenda.getUTCFullYear(), dataVenda.getUTCMonth() + 1, 0, 23, 59, 59));
}

/**
 * Catálogo 2 (P2 #15): Classificação oficial de genérico (nunca "tem DCI").
 */
export function ehGenericoOficial(
  cnp: string,
  designacao: string,
  taxaIva?: number | null
): boolean {
  const c = classifyProduct(cnp, designacao, taxaIva ?? null);
  return Boolean(c.eh_generico);
}

/**
 * Catálogo 2: Calcula todos os estados operacionais de um CNP de forma única e consistente.
 */
export function calcularEstadosProduto(input: EstadosProdutoInput): EstadosProdutoResult {
  const stock = Math.max(0, Number(input.stockTotal || 0));
  const vmm = Math.max(0, Number(input.vmm || 0));
  const vendas90d = Math.max(0, Number(input.vendasUltimos90d || 0));
  const janelaMono = Math.max(30, Number(input.janelaMonoDias || 90));
  const custo =
    input.custoUnitario !== null && input.custoUnitario !== undefined && Number(input.custoUnitario) > 0
      ? Number(input.custoUnitario)
      : null;

  const cobertura_meses = calcularCoberturaMeses(stock, vmm);
  const cobertura_dias = cobertura_meses !== null ? Math.round(cobertura_meses * 30) : null;

  let dias_sem_vendas: number | null = null;
  if (input.ultimaVendaEfetiva) {
    dias_sem_vendas = Math.max(
      0,
      Math.floor((input.dataReferencia.getTime() - input.ultimaVendaEfetiva.getTime()) / (1000 * 60 * 60 * 24))
    );
  }

  // Mono: stock > 0 e nenhuma venda nos últimos N dias
  const eh_mono =
    stock > 0 && (input.ultimaVendaEfetiva === null || (dias_sem_vendas !== null && dias_sem_vendas > janelaMono));

  // Resto de gaveta: mono com stock de 1 ou 2 unidades
  const eh_resto_gaveta = eh_mono && stock >= 1 && stock <= 2;

  // Excesso de cobertura: cobertura > 4 meses com VMM > 0 (P2 #16: mono sem vendas NÃO é excesso!)
  const eh_excesso_cobertura = vmm > 0 && cobertura_meses !== null && cobertura_meses > 4;
  const unidades_excesso = eh_excesso_cobertura ? Math.max(0, stock - Math.ceil(vmm * 4)) : 0;
  const capital_excesso_eur =
    custo !== null ? Number((unidades_excesso * custo).toFixed(2)) : null;

  // Rutura: stock = 0 e vendas nos últimos 90 dias
  const eh_rutura = stock === 0 && vendas90d > 0;

  // Risco de rutura: stock > 0, VMM >= 1 e cobertura < 7 dias
  const eh_risco_rutura = stock > 0 && vmm >= 1 && cobertura_dias !== null && cobertura_dias < 7;

  // Validade curta (<= 6 meses) e risco de caducidade
  let eh_validade_curta = false;
  let eh_risco_caducidade = false;
  let unidades_risco_caducidade = 0;

  if (stock > 0 && input.validadeMaisProxima) {
    const diasAteVal = (input.validadeMaisProxima.getTime() - input.dataReferencia.getTime()) / (1000 * 60 * 60 * 24);
    const mesesAteVal = diasAteVal / 30;
    eh_validade_curta = mesesAteVal <= 6;
    if (mesesAteVal <= 0) {
      eh_risco_caducidade = true;
      unidades_risco_caducidade = stock;
    } else if (vmm === 0) {
      eh_risco_caducidade = eh_validade_curta;
      unidades_risco_caducidade = eh_validade_curta ? stock : 0;
    } else if (cobertura_meses !== null && mesesAteVal < cobertura_meses) {
      eh_risco_caducidade = true;
      unidades_risco_caducidade = Math.max(0, Math.ceil(stock - vmm * mesesAteVal));
    }
  }

  const capital_risco_caducidade_eur =
    custo !== null ? Number((unidades_risco_caducidade * custo).toFixed(2)) : null;
  const capital_imobilizado_eur =
    custo !== null ? Number((stock * custo).toFixed(2)) : null;

  return {
    cobertura_meses,
    cobertura_dias,
    dias_sem_vendas,
    eh_mono,
    eh_resto_gaveta,
    eh_excesso_cobertura,
    unidades_excesso,
    capital_excesso_eur,
    eh_rutura,
    eh_risco_rutura,
    eh_validade_curta,
    eh_risco_caducidade,
    unidades_risco_caducidade,
    capital_risco_caducidade_eur,
    capital_imobilizado_eur,
  };
}
