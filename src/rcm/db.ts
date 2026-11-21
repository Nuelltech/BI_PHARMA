/** Persistência dos documentos e leitura da referência de CNP. */
import type { Pool } from 'pg';
import { chaveNome } from './parse.js';
import type { Referencia, ResultadoDocumento } from './worker.js';

/**
 * Referência para ligar CNP -> produto.
 *  - 'cits':   "ProdutoCits" (o normal, depois do primeiro ficheiro CITS)
 *  - 'mestre': "ProdutoMestre" (para testar antes de haver CITS; sem prod_id)
 */
export async function carregarReferencia(pool: Pool, fonte: 'cits' | 'mestre'): Promise<Referencia> {
  const sql = fonte === 'cits'
    ? `SELECT cnp_codigo AS cnp, nome, dci, prod_id FROM "ProdutoCits"`
    : `SELECT cnp_codigo AS cnp, designacao AS nome, NULLIF(trim(dci), '') AS dci, NULL::bigint AS prod_id FROM "ProdutoMestre"`;
  const r = await pool.query(sql);
  return new Map(r.rows.map((x) => [x.cnp, { cnp: x.cnp, nome: x.nome, dci: x.dci, prod_id: x.prod_id == null ? null : Number(x.prod_id) }]));
}

export async function carregarShas(pool: Pool): Promise<Set<string>> {
  const r = await pool.query(`SELECT sha256 FROM "DocumentoMedicamento"`);
  return new Set(r.rows.map((x) => x.sha256 as string));
}

/** RCM identificados em execuções anteriores, para ligar folhetos que cheguem depois. */
export async function carregarRcmPorNome(pool: Pool): Promise<Map<string, string[]>> {
  const r = await pool.query(
    `SELECT d.nome_chave, array_agg(DISTINCT c.cnp_codigo ORDER BY c.cnp_codigo) AS cnps
     FROM "DocumentoMedicamento" d JOIN "DocumentoCnp" c ON c.documento_id = d.id
     WHERE d.tipo = 'RCM' AND d.estado = 'IDENTIFICADO' AND d.nome_chave IS NOT NULL
     GROUP BY d.nome_chave`);
  return new Map(r.rows.map((x) => [x.nome_chave as string, x.cnps as string[]]));
}

export async function gravarDocumentos(pool: Pool, resultados: ResultadoDocumento[]): Promise<number> {
  const aGravar = resultados.filter((r) => r.estado !== 'DUPLICADO' && r.doc);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of aGravar) {
      const d = r.doc!;
      const { rows } = await client.query(
        `INSERT INTO "DocumentoMedicamento"(sha256, tipo, estado, motivo, ficheiro_original, ficheiro_final, paginas,
           nome_documento, composicao, data_revisao, cnps_seccao8, seccoes_em_falta, data_aprovacao, nome_chave)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (sha256) DO UPDATE SET estado = EXCLUDED.estado, motivo = EXCLUDED.motivo,
           ficheiro_final = EXCLUDED.ficheiro_final, processado_em = now()
         RETURNING id`,
        [r.sha256, d.tipo, r.estado, r.motivo, r.ficheiro_original, r.ficheiro_final, r.paginas, d.nome, d.composicao,
          d.data_revisao, d.cnps, d.seccoes_em_falta, d.data_aprovacao, chaveNome(d.nome)]);
      const id = rows[0].id;
      await client.query(`DELETE FROM "DocumentoCnp" WHERE documento_id = $1`, [id]);
      await client.query(`DELETE FROM "DocumentoSeccao" WHERE documento_id = $1`, [id]);
      if (r.cnps_ligados.length) {
        await client.query(
          `INSERT INTO "DocumentoCnp"(documento_id, cnp_codigo) SELECT $1, unnest($2::text[])`, [id, r.cnps_ligados]);
      }
      if (d.seccoes.length) {
        await client.query(
          `INSERT INTO "DocumentoSeccao"(documento_id, numero, titulo, texto, texto_hash)
           SELECT $1, x->>'numero', x->>'titulo', x->>'texto', x->>'texto_hash' FROM jsonb_array_elements($2::jsonb) x`,
          [id, JSON.stringify(d.seccoes)]);
      }
    }
    await client.query('COMMIT');
    return aGravar.length;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
