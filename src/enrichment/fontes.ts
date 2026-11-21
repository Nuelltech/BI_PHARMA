// Classificação das fontes por nível de confiança.
// v1.1: o nível depende SÓ do domínio. O tipo declarado pelo modelo é guardado
// para informação, mas nunca sobe o nível de um domínio desconhecido
// (no piloto, um folheto polaco foi declarado "folheto_pt_espelho").
import type { TipoFonte } from './types';

const FABRICANTES = [
  'bayer.com', 'bayer.pt', 'boiron.pt', 'boiron.com', 'pierre-fabre.com', 'eau-thermale-avene.pt',
  'laroche-posay.pt', 'laroche-posay.com', 'bial.com', 'tecnimede.pt', 'angelini.pt', 'teva.pt',
  'novartis.pt', 'pfizer.pt', 'sanofi.pt', 'gsk.com', 'haleon.com', 'kenvue.com', 'astrazeneca.pt',
  'boehringer-ingelheim.com', 'lundbeck.com', 'viatris.com', 'sandoz.pt', 'generis.pt', 'aflofarm.pl',
  'solventum.com', '3m.com',
];
const ESPELHOS_PT = ['medikamio.com', 'indice.eu'];
// Reguladores de outros países: fonte oficial, mas o texto pode diferir do aprovado em Portugal.
const REGULADORES_ESTRANGEIROS = [
  'cima.aemps.es', 'aemps.gob.es', 'ansm.sante.fr', 'base-donnees-publique.medicaments.gouv.fr',
  'rejestry.ezdrowie.gov.pl', 'halmed.hr', 'fagg-afmps.be', 'anm.ro', 'medicines.org.uk', 'mhra.gov.uk',
  'ogyei.gov.hu', 'sukl.cz',
];

export function dominioDe(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

const pertence = (d: string, lista: string[]) => lista.some((f) => d === f || d.endsWith('.' + f));

/** Nível 1 = oficial PT/UE ou fabricante; 2 = folheto PT espelhado; 3 = farmácia PT ou regulador estrangeiro; 4 = outro. */
export function classificarFonte(url: string, _tipoDeclarado?: TipoFonte): { tipo: TipoFonte; nivel: 1 | 2 | 3 | 4 } {
  const d = dominioDe(url);
  if (d.endsWith('ema.europa.eu')) return { tipo: 'ema', nivel: 1 };
  if (d === 'infarmed.pt' || d.endsWith('.infarmed.pt')) return { tipo: 'infarmed_publico', nivel: 1 };
  if (pertence(d, FABRICANTES)) return { tipo: 'fabricante', nivel: 1 };
  if (pertence(d, ESPELHOS_PT)) return { tipo: 'folheto_pt_espelho', nivel: 2 };
  if (pertence(d, REGULADORES_ESTRANGEIROS)) return { tipo: 'regulador_estrangeiro', nivel: 3 };
  if (d.endsWith('.pt')) return { tipo: 'farmacia_pt', nivel: 3 };
  return { tipo: 'outro', nivel: 4 };
}
