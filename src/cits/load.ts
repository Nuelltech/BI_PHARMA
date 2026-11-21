/**
 * Escrita na base de dados (Postgres / Supabase) numa única transação.
 * Nunca escreve no "ProdutoMestre".
 */
import type { Pool, PoolClient } from 'pg';
import { CAMPOS_HISTORICO, QUEDA_MAXIMA_EMBALAGENS } from './config.js';
import type { DadosCits } from './source.js';
import type { ProdutoCitsLinha } from './transform.js';

const LOTE = 2000;

async function emLotes<T>(itens: T[], fn: (lote: T[]) => Promise<unknown>) {
  for (let i = 0; i < itens.length; i += LOTE) await fn(itens.slice(i, i + LOTE));
}

export async function cargaJaConcluida(pool: Pool, sha: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM "CitsCarga" WHERE ficheiro_sha256 = $1 AND estado = 'CONCLUIDA'`, [sha]);
  return (r.rowCount ?? 0) > 0;
}

export async function registarCarga(pool: Pool, ficheiro: string, sha: string): Promise<number> {
  const r = await pool.query(
    `INSERT INTO "CitsCarga"(ficheiro, ficheiro_sha256) VALUES ($1, $2) RETURNING id`, [ficheiro, sha]);
  return Number(r.rows[0].id);
}

export async function fecharCarga(pool: Pool, id: number, estado: 'FALHADA' | 'REJEITADA', erro: string, avisos: string[] = []) {
  await pool.query(
    `UPDATE "CitsCarga" SET estado = $2, erro = $3, avisos = $4::jsonb, terminada_em = now() WHERE id = $1`,
    [id, estado, erro, JSON.stringify(avisos)]);
}

/** Proteção contra ficheiros truncados: compara com a última carga concluída. */
export async function verificarQueda(pool: Pool, embalagens: number): Promise<string | null> {
  const r = await pool.query(
    `SELECT (linhas_por_tabela->>'EMBALAGEM')::int AS n FROM "CitsCarga"
     WHERE estado = 'CONCLUIDA' ORDER BY terminada_em DESC LIMIT 1`);
  const anterior = r.rows[0]?.n as number | undefined;
  if (anterior && embalagens < anterior * (1 - QUEDA_MAXIMA_EMBALAGENS)) {
    return `EMBALAGEM caiu de ${anterior} para ${embalagens} linhas (> ${QUEDA_MAXIMA_EMBALAGENS * 100}%)`;
  }
  return null;
}

/** JSON com chaves ordenadas: o jsonb do Postgres reordena as chaves dos objetos. */
const canonico = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonico)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonico((v as Record<string, unknown>)[k])]))
      : v;
const valorComparavel = (v: unknown) => JSON.stringify(canonico(v ?? null));

export interface ResumoCarga {
  inseridos: number;
  alterados: number;
  removidos: number;
  alteracoesHistorico: number;
}

export async function gravar(
  pool: Pool, cargaId: number, dados: DadosCits, produtos: ProdutoCitsLinha[], avisos: string[],
): Promise<ResumoCarga> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Espelho bruto: substituído por inteiro
    await client.query('DELETE FROM "CitsRaw"');
    const linhasPorTabela: Record<string, number> = {};
    for (const [tabela, linhas] of dados) {
      linhasPorTabela[tabela] = linhas.length;
      const numeradas = linhas.map((d, i) => ({ linha: i + 1, dados: d }));
      await emLotes(numeradas, (lote) => client.query(
        `INSERT INTO "CitsRaw"(tabela, linha, dados, carga_id)
         SELECT $1, (x->>'linha')::int, x->'dados', $2 FROM jsonb_array_elements($3::jsonb) x`,
        [tabela, cargaId, JSON.stringify(lote)]));
    }

    // 2. Estado atual para comparar
    const atuais = await client.query(
      `SELECT cnp_codigo, hash_conteudo, ativo_no_cits, ${CAMPOS_HISTORICO.map((c) => `to_jsonb(${c}) AS ${c}`).join(', ')}
       FROM "ProdutoCits"`);
    const porCnp = new Map(atuais.rows.map((r) => [r.cnp_codigo as string, r]));

    const novosOuAlterados: (ProdutoCitsLinha & { carga_id: number })[] = [];
    const historico: { cnp_codigo: string; campo: string; valor_anterior: unknown; valor_novo: unknown }[] = [];
    let inseridos = 0;
    let alterados = 0;

    for (const p of produtos) {
      const atual = porCnp.get(p.cnp_codigo);
      if (!atual) { inseridos++; novosOuAlterados.push({ ...p, carga_id: cargaId }); continue; }
      if (atual.hash_conteudo === p.hash_conteudo && atual.ativo_no_cits) continue;
      alterados++;
      novosOuAlterados.push({ ...p, carga_id: cargaId });
      for (const campo of CAMPOS_HISTORICO) {
        const antes = atual[campo];
        const depois = (p as unknown as Record<string, unknown>)[campo];
        // números vindos do Postgres (numeric) chegam como número em to_jsonb
        if (valorComparavel(antes) !== valorComparavel(depois)) {
          historico.push({ cnp_codigo: p.cnp_codigo, campo, valor_anterior: antes ?? null, valor_novo: depois ?? null });
        }
      }
    }

    // 3. Upsert do resultado
    await emLotes(novosOuAlterados, (lote) => client.query(
      `INSERT INTO "ProdutoCits"
       SELECT * FROM jsonb_populate_recordset(NULL::"ProdutoCits",
         (SELECT jsonb_agg(x || jsonb_build_object('ativo_no_cits', true, 'atualizado_em', now()))
          FROM jsonb_array_elements($1::jsonb) x))
       ON CONFLICT (cnp_codigo) DO UPDATE SET
         ${COLUNAS_UPDATE.map((c) => `${c} = EXCLUDED.${c}`).join(',\n         ')}`,
      [JSON.stringify(lote)]));

    // 4. Histórico
    await emLotes(historico, (lote) => client.query(
      `INSERT INTO "ProdutoCitsHistorico"(cnp_codigo, campo, valor_anterior, valor_novo, carga_id)
       SELECT x->>'cnp_codigo', x->>'campo', x->'valor_anterior', x->'valor_novo', $2
       FROM jsonb_array_elements($1::jsonb) x`,
      [JSON.stringify(lote), cargaId]));

    // 5. Produtos que deixaram de vir no ficheiro: marcados, nunca apagados
    const removidos = await client.query(
      `UPDATE "ProdutoCits" SET ativo_no_cits = false, carga_id = $2, atualizado_em = now()
       WHERE ativo_no_cits AND NOT (cnp_codigo = ANY($1::text[]))`,
      [produtos.map((p) => p.cnp_codigo), cargaId]);

    await client.query(
      `UPDATE "CitsCarga" SET estado = 'CONCLUIDA', terminada_em = now(), linhas_por_tabela = $2::jsonb,
         avisos = $3::jsonb, produtos_inseridos = $4, produtos_alterados = $5, produtos_removidos = $6
       WHERE id = $1`,
      [cargaId, JSON.stringify(linhasPorTabela), JSON.stringify(avisos), inseridos, alterados, removidos.rowCount ?? 0]);

    await client.query('COMMIT');
    return { inseridos, alterados, removidos: removidos.rowCount ?? 0, alteracoesHistorico: historico.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const COLUNAS_UPDATE = [
  'emb_id', 'prod_id', 'ativo_no_cits', 'nome', 'descricao_embalagem', 'marca', 'tipo_produto', 'nr_processo',
  'titular_aim', 'dci', 'substancias', 'dosagem', 'dosagem_completa', 'forma_farmaceutica',
  'forma_farmaceutica_agrupada', 'vias_administracao', 'atc_codigos', 'atc_descricoes', 'cft_codigos',
  'cft_descricoes', 'gh_codigo', 'gh_descricao', 'cnpem', 'classificacoes_dispensa', 'regime_dispensa',
  'precisa_receita', 'tipo_venda_derivado', 'eh_generico', 'eh_marca', 'eh_biossimilar', 'eh_biologico',
  'publico', 'publico_fonte', 'grupos_produto', 'pvp_oficial', 'pvp_max', 'preco_referencia', 'pvp_notificado',
  'comparticipacoes', 'estado_comercializacao', 'data_prevista_reposicao', 'estado_aim', 'fim_escoamento',
  'pem_amb', 'margem_terapeutica_estreita', 'monitorizacao_adicional', 'substituicao_farmacia', 'conservacao',
  'alertas', 'cits_data_alteracao', 'hash_conteudo', 'carga_id', 'atualizado_em',
];
