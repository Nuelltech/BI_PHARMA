/**
 * Importação do ficheiro CITS (Infarmed) para o Bi-Pharma.
 *
 *   npx tsx scripts/import-cits.ts <ficheiro.mdb|.accdb|pasta-csv> [--dry-run] [--force] [--data AAAA-MM-DD]
 *
 *   --dry-run  lê, valida e transforma; mostra o resumo sem tocar na base de dados
 *   --force    ignora a proteção de ficheiro repetido e de queda de linhas
 *   --data     data de referência para preços/estados "em vigor" (por omissão: hoje)
 *
 * Requer DATABASE_URL (ligação direta ao Postgres do Supabase) e, para ficheiros Access, mdbtools.
 */
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import pg from 'pg';
import { lerCits, sha256Ficheiro } from '../src/cits/source.js';
import { transformar } from '../src/cits/transform.js';
import { cargaJaConcluida, fecharCarga, gravar, registarCarga, verificarQueda } from '../src/cits/load.js';

function args() {
  const a = process.argv.slice(2);
  const caminho = a.find((x) => !x.startsWith('--'));
  const iData = a.indexOf('--data');
  return {
    caminho,
    dryRun: a.includes('--dry-run'),
    force: a.includes('--force'),
    dia: iData >= 0 ? a[iData + 1] : new Date().toISOString().slice(0, 10),
  };
}

function resumo(produtos: ReturnType<typeof transformar>['produtos']) {
  const contar = (f: (p: (typeof produtos)[number]) => string) =>
    produtos.reduce<Record<string, number>>((acc, p) => { const k = f(p); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  return {
    total: produtos.length,
    por_tipo_produto: contar((p) => p.tipo_produto ?? 'null'),
    por_regime_dispensa: contar((p) => p.regime_dispensa),
    genericos: produtos.filter((p) => p.eh_generico).length,
    marcas: produtos.filter((p) => p.eh_marca).length,
    pediatricos: contar((p) => (p.publico === 'PEDIATRICO' ? p.publico_fonte ?? '?' : 'nao')),
    temporariamente_indisponiveis: produtos.filter((p) => p.data_prevista_reposicao).length,
  };
}

async function main() {
  const { caminho, dryRun, force, dia } = args();
  if (!caminho) { console.error('Uso: import-cits.ts <ficheiro|pasta> [--dry-run] [--force] [--data AAAA-MM-DD]'); process.exit(2); }

  const ehPasta = statSync(caminho).isDirectory();
  const sha = ehPasta ? `pasta:${basename(caminho)}:${Date.now()}` : sha256Ficheiro(caminho);

  console.log(`[cits] a ler ${caminho}`);
  const { dados, validacao } = lerCits(caminho);
  validacao.avisos.forEach((a) => console.warn(`[cits] aviso: ${a}`));

  if (validacao.erros.length) {
    validacao.erros.forEach((e) => console.error(`[cits] erro: ${e}`));
    if (!dryRun && process.env.DATABASE_URL) {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const id = await registarCarga(pool, basename(caminho), sha);
      await fecharCarga(pool, id, 'REJEITADA', validacao.erros.join('; '), validacao.avisos);
      await pool.end();
    }
    process.exit(1);
  }

  const { produtos, avisos } = transformar(dados, dia);
  avisos.forEach((a) => console.warn(`[cits] aviso: ${a}`));
  console.log('[cits] resumo:', JSON.stringify(resumo(produtos), null, 2));

  if (dryRun) { console.log('[cits] --dry-run: base de dados não alterada'); return; }
  if (!process.env.DATABASE_URL) { console.error('[cits] falta DATABASE_URL'); process.exit(2); }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (!force && !ehPasta && await cargaJaConcluida(pool, sha)) {
      console.log('[cits] este ficheiro já foi importado; nada a fazer (use --force para repetir)');
      return;
    }
    const cargaId = await registarCarga(pool, basename(caminho), sha);
    const queda = force ? null : await verificarQueda(pool, dados.get('EMBALAGEM')?.length ?? 0);
    if (queda) {
      await fecharCarga(pool, cargaId, 'REJEITADA', queda, validacao.avisos);
      console.error(`[cits] carga rejeitada: ${queda}`);
      process.exit(1);
    }
    try {
      const r = await gravar(pool, cargaId, dados, produtos, [...validacao.avisos, ...avisos]);
      console.log(`[cits] carga ${cargaId} concluída:`, r);
    } catch (e) {
      await fecharCarga(pool, cargaId, 'FALHADA', (e as Error).message);
      throw e;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('[cits] falhou:', e); process.exit(1); });
