/**
 * Worker de documentos (RCM/FI/MMR) descarregados do Infomed.
 *
 *   npx tsx scripts/process-rcm.ts <pasta-entrada> [--saida <pasta>] [--referencia cits|mestre|nenhuma]
 *                                  [--mover] [--dry-run] [--sem-bd]
 *
 *   --saida       pasta onde ficam processados/, por_rever/, duplicados/ e o relatório (omissão: <entrada>/_saida)
 *   --referencia  onde confirmar os CNP da secção 8 (omissão: cits; "mestre" para testar antes do CITS)
 *   --mover       move os ficheiros em vez de copiar (por omissão os originais ficam intactos)
 *   --dry-run     não copia/move nem grava na BD; só relatório
 *   --sem-bd      corre sem DATABASE_URL (sem referência, sem gravar)
 */
import { join } from 'node:path';
import pg from 'pg';
import { carregarRcmPorNome, carregarReferencia, carregarShas, gravarDocumentos } from '../src/rcm/db.js';
import { escreverRelatorio, processarPasta, resumo, type Referencia } from '../src/rcm/worker.js';

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const entrada = a.find((x, i) => !x.startsWith('--') && !['--saida', '--referencia'].includes(a[i - 1]));
  return {
    entrada,
    saida: val('--saida'),
    referencia: (val('--referencia') ?? 'cits') as 'cits' | 'mestre' | 'nenhuma',
    mover: a.includes('--mover'),
    dryRun: a.includes('--dry-run'),
    semBd: a.includes('--sem-bd') || !process.env.DATABASE_URL,
  };
}

async function main() {
  const o = args();
  if (!o.entrada) { console.error('Uso: process-rcm.ts <pasta> [--saida p] [--referencia cits|mestre|nenhuma] [--mover] [--dry-run] [--sem-bd]'); process.exit(2); }
  const saida = o.saida ?? join(o.entrada, '_saida');

  const pool = o.semBd ? null : new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    let referencia: Referencia | undefined;
    let jaConhecidos: Set<string> | undefined;
    let rcmPorNome: Map<string, string[]> | undefined;
    if (pool) {
      if (o.referencia !== 'nenhuma') referencia = await carregarReferencia(pool, o.referencia);
      jaConhecidos = await carregarShas(pool);
      rcmPorNome = await carregarRcmPorNome(pool);
      console.log(`[rcm] referência ${o.referencia}: ${referencia?.size ?? 0} CNP; ${jaConhecidos.size} documentos já na BD`);
    } else {
      console.log('[rcm] sem base de dados: CNP da secção 8 não são confirmados');
    }

    const resultados = await processarPasta({ entrada: o.entrada, saida, referencia, jaConhecidos, rcmPorNome, exigirReferencia: o.referencia === 'cits', mover: o.mover, dryRun: o.dryRun });
    escreverRelatorio(saida, resultados);
    console.log('[rcm] resumo:', JSON.stringify(resumo(resultados), null, 2));
    console.log(`[rcm] relatório em ${join(saida, 'relatorio.csv')}`);

    if (pool && !o.dryRun) {
      const n = await gravarDocumentos(pool, resultados);
      console.log(`[rcm] ${n} documentos gravados na BD`);
    }
  } finally {
    await pool?.end();
  }
}

main().catch((e) => { console.error('[rcm] falhou:', e); process.exit(1); });
