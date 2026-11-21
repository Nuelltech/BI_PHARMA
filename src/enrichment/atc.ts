// Normalização de códigos ATC.
// Folhetos antigos trazem códigos que a OMS já reclassificou. Ex. do piloto:
// Dalzior (dapagliflozina) veio com A10BX09; o código atual é A10BK01.
//
// TODO: substituir este mapa pela tabela ATC oficial completa (WHO Collaborating
// Centre, atualização anual) carregada numa tabela da BD.

const RECLASSIFICADOS: Record<string, string> = {
  // Inibidores SGLT2 passaram de A10BX para o grupo próprio A10BK (2022)
  A10BX09: 'A10BK01', // dapagliflozina
  A10BX11: 'A10BK02', // canagliflozina
  A10BX12: 'A10BK03', // empagliflozina
};

const FORMATO = /^[A-Z]\d{2}[A-Z]{1,2}(\d{2})?$/;

export function normalizarAtc(atc: string | null | undefined): { atc: string | null; nota: string | null } {
  if (!atc) return { atc: null, nota: null };
  const limpo = atc.toUpperCase().replace(/\s+/g, '');
  if (!FORMATO.test(limpo)) return { atc: null, nota: `ATC com formato inválido descartado: ${atc}` };
  const novo = RECLASSIFICADOS[limpo];
  if (novo) return { atc: novo, nota: `ATC atualizado de ${limpo} para ${novo}` };
  return { atc: limpo, nota: null };
}
