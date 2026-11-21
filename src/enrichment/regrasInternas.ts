// Artigos que não vale a pena (nem é possível) pesquisar na web:
// códigos internos da farmácia e artigos genéricos (óculos, batons, ...).
// Ex. reais do piloto: 1111111 "VITRY OCULOS LEITURA", 0090201 "LIPS BATOM".

import { normalizarTermo } from './vocabulario';

const REGRAS_PALAVRA_CHAVE: { padrao: RegExp; categoria: string; subcategoria: string }[] = [
  { padrao: /\boculos\b.*\bsol\b|\bsol\b.*\boculos\b/, categoria: 'Ótica', subcategoria: 'Óculos de sol' },
  { padrao: /\boculos\b.*\bleitura\b|\bleitura\b.*\boculos\b|\boculos\b/, categoria: 'Ótica', subcategoria: 'Óculos de leitura' },
  { padrao: /\bbatom\b|\blips\b|\bbaton\b/, categoria: 'Maquilhagem', subcategoria: 'Lábios' },
  { padrao: /\bpoudre|\bpo compacto\b|\bbronzeador\b/, categoria: 'Maquilhagem', subcategoria: 'Rosto' },
  { padrao: /\bverniz\b|\bunhas\b/, categoria: 'Maquilhagem', subcategoria: 'Unhas' },
  { padrao: /\bsaco\b|\bembalagem\b|\bportes\b|\bservico\b/, categoria: 'Artigos internos', subcategoria: 'Serviços e embalagens' },
];

/** Códigos que não parecem CNP real: dígitos repetidos (1111111, 2222229) ou começados por "00". */
export function pareceCodigoInterno(cnp: string): boolean {
  if (!/^\d{7}$/.test(cnp)) return true;
  if (/^(\d)\1{5}/.test(cnp)) return true;
  if (cnp.startsWith('00')) return true;
  return false;
}

export function classificarPorRegra(cnp: string, designacao: string):
  { categoria: string; subcategoria: string; motivo: string } | null {
  const d = normalizarTermo(designacao).replace(/_/g, ' ');
  for (const r of REGRAS_PALAVRA_CHAVE) {
    if (r.padrao.test(d)) {
      return { categoria: r.categoria, subcategoria: r.subcategoria, motivo: `palavra-chave: ${r.padrao.source}` };
    }
  }
  if (pareceCodigoInterno(cnp)) {
    return { categoria: 'Artigos internos', subcategoria: 'Por classificar', motivo: 'código interno sem palavra-chave' };
  }
  return null;
}
