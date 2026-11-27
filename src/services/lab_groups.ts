// Normalização de entidades jurídicas de laboratórios farmacêuticos para Grupo / Marca Principal

interface LabGroupRule {
  group: string;
  patterns: RegExp[];
}

const KNOWN_LAB_GROUPS: LabGroupRule[] = [
  { group: 'Bial', patterns: [/\bbial\b/i, /\bbialfar\b/i] },
  { group: 'Teva', patterns: [/\bteva\b/i, /\bratiopharm\b/i] },
  { group: 'Viatris', patterns: [/\bviatris\b/i, /\bmylan\b/i, /\bmeda\b/i] },
  { group: 'Sanofi', patterns: [/\bsanofi\b/i, /\bopella\b/i] },
  { group: 'Sandoz', patterns: [/\bsandoz\b/i] },
  { group: 'Novartis', patterns: [/\bnovartis\b/i] },
  { group: 'Bluepharma', patterns: [/\bbluepharma\b/i] },
  { group: 'Generis', patterns: [/\bgeneris\b/i, /\baurobindo\b/i] },
  { group: 'Ciclum / Stada', patterns: [/\bciclum\b/i, /\bstada\b/i] },
  { group: 'Krka', patterns: [/\bkrka\b/i] },
  { group: 'Tecnimede', patterns: [/\btecnimede\b/i, /\bpentafarma\b/i, /\batlantic\s+pharma\b/i] },
  { group: 'Labesfal', patterns: [/\blabesfal\b/i, /\bfresenius\b/i] },
  { group: 'Alter', patterns: [/\balter\b/i] },
  { group: 'Azevedos', patterns: [/\bazevedos\b/i, /\bsofal\b/i] },
  { group: 'Bayer', patterns: [/\bbayer\b/i] },
  { group: 'GSK', patterns: [/\bglaxosmithkline\b/i, /\bgsk\b/i] },
  { group: 'Haleon', patterns: [/\bhaleon\b/i] },
  { group: 'Pfizer', patterns: [/\bpfizer\b/i] },
  { group: 'MSD', patterns: [/\bmerck\s+sharp\b/i, /\bmsd\b/i] },
  { group: 'Merck', patterns: [/\bmerck\b/i] },
  { group: 'AstraZeneca', patterns: [/\bastrazeneca\b/i] },
  { group: 'Boehringer Ingelheim', patterns: [/\bboehringer\b/i] },
  { group: 'Servier', patterns: [/\bservier\b/i] },
  { group: 'Menarini', patterns: [/\bmenarini\b/i] },
  { group: 'Jaba Recordati', patterns: [/\bjaba\b/i, /\brecordati\b/i] },
  { group: 'Pierre Fabre', patterns: [/\bpierre\s+fabre\b/i, /\bavene\b/i, /\bducray\b/i, /\ba-?derma\b/i, /\bklorane\b/i] },
  { group: 'ISDIN', patterns: [/\bisdin\b/i] },
  { group: 'NAOS / Bioderma', patterns: [/\bbioderma\b/i, /\bnaos\b/i] },
  { group: "L'Oréal", patterns: [/\bl['’]?or[eé]al\b/i, /\bla\s+roche\b/i, /\bvichy\b/i, /\bcerave\b/i] },
  { group: 'Alcon', patterns: [/\balcon\b/i] },
  { group: 'Abbott', patterns: [/\babbott\b/i] },
  { group: 'Takeda', patterns: [/\btakeda\b/i] },
  { group: 'Zentiva', patterns: [/\bzentiva\b/i] },
  { group: 'Accord', patterns: [/\baccord\b/i] },
  { group: 'Normon', patterns: [/\bnormon\b/i] },
  { group: 'Cinfa', patterns: [/\bcinfa\b/i] },
  { group: 'Medinfar', patterns: [/\bmedinfar\b/i] },
  { group: 'Basi', patterns: [/\bbasi\b/i] },
  { group: 'Angelini', patterns: [/\bangelini\b/i] },
  { group: 'Zambon', patterns: [/\bzambon\b/i] },
  { group: 'Baldacci', patterns: [/\bbaldacci\b/i] },
  { group: 'Faes Farma', patterns: [/\bfaes\b/i] },
  { group: 'Uriach', patterns: [/\buriach\b/i] },
  { group: 'Edol', patterns: [/\bedol\b/i] },
  { group: 'Davi', patterns: [/\bdavi\b/i] },
  { group: 'Farmalabor', patterns: [/\bfarmalabor\b/i] },
  { group: 'Ipsen', patterns: [/\bipsen\b/i] },
  { group: 'Chiesi', patterns: [/\bchiesi\b/i] },
  { group: 'Almirall', patterns: [/\balmirall\b/i] },
  { group: 'Ferring', patterns: [/\bferring\b/i] },
  { group: 'Janssen', patterns: [/\bjanssen\b/i, /\bjohnson\s*&\s*johnson\b/i] },
  { group: 'Roche', patterns: [/\broche\b/i] },
  { group: 'Lilly', patterns: [/\blilly\b/i] },
  { group: 'Novo Nordisk', patterns: [/\bnovo\s+nordisk\b/i] },
  { group: 'Laboratórios Vitória', patterns: [/\blaborat[oó]rios\s+vit[oó]ria\b/i] },
];

export function normalizeLabGroup(rawLab?: string | null): string {
  const clean = String(rawLab || '').trim();
  if (!clean || clean.toLowerCase() === 'sem laboratório') {
    return 'Sem Laboratório';
  }

  for (const rule of KNOWN_LAB_GROUPS) {
    if (rule.patterns.some((rx) => rx.test(clean))) {
      return rule.group;
    }
  }

  // Fallback genérico: remove sufixos jurídicos comuns para agrupar variantes da mesma empresa
  let stripped = clean
    .replace(/\s*[-–—]\s*(produtos?\s+farmac[eê]uticos?|especialidades?\s+farmac[eê]uticas?|ind[uú]stria\s+farmac[eê]utica|com[eé]rcio\s+e\s+ind[uú]stria|farmac[eê]utica|portugal|ib[eé]rica|consumer\s+health).*$/i, '')
    .replace(/,?\s*\b(s\.?\s*a\.?|lda\.?|unipessoal|sociedade\s+unipessoal|b\.?\s*v\.?|gmbh|s\.?\s*l\.?|s\.?\s*r\.?\s*l\.?|inc\.?|ltd\.?|plc|n\.?\s*v\.?|a\/s|portugal|ib[eé]rica)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[,.\-–—]+$/g, '')
    .trim();

  if (!stripped) return clean;
  return stripped;
}
