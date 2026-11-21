// Acesso à base de dados (Prisma + SQL explícito, para não depender do cliente gerado).
// Ajustar o import do prisma ao do projeto (ex.: '../lib/prisma').
import { PrismaClient, Prisma } from '@prisma/client';
import { classificarFonte, dominioDe } from './fontes';
import type { PerfilModelo, ProdutoAlvo, ResultadoValidacao, Via } from './types';

export const prisma = new PrismaClient();

export type Ambito = 'medicamentos_sem_dci' | 'venda_livre_generica' | 'todos_com_stock';

const CAT_GENERICAS = [
  'Outros Cuidados de Saúde', 'Saúde e Bem-Estar Geral (Venda Livre)', 'Venda Livre / OTC',
  'Especialidades Farmacêuticas / Outros',
];
const SUB_GENERICAS = ['Geral', 'Terapêutica Crónica / Geral'];

/** Enche a fila. Prioridade = valor em stock (custo) somado em todas as farmácias. Não duplica. */
export async function semearFila(ambito: Ambito): Promise<number> {
  const filtro =
    ambito === 'medicamentos_sem_dci'
      ? Prisma.sql`p.tipo_venda IN ('MSRM','MNSRM') AND NULLIF(TRIM(p.dci),'') IS NULL`
      : ambito === 'venda_livre_generica'
        ? Prisma.sql`p.tipo_venda = 'VENDA_LIVRE' AND (p.subcategoria IN (${Prisma.join(SUB_GENERICAS)}) OR p.categoria IN (${Prisma.join(CAT_GENERICAS)}))`
        : Prisma.sql`TRUE`;

  return prisma.$executeRaw`
    INSERT INTO "EnriquecimentoFila" (cnp_codigo, via, prioridade)
    SELECT p.cnp_codigo,
           CASE WHEN p.tipo_venda IN ('MSRM','MNSRM') THEN 'MEDICAMENTO' ELSE 'VENDA_LIVRE' END,
           COALESCE(s.valor, 0)
    FROM "ProdutoMestre" p
    JOIN (SELECT cnp_codigo, SUM(stock_total_valor_custo) AS valor, SUM(stock_total_unidades) AS un
          FROM "MartProdutoMetricas" GROUP BY cnp_codigo) s USING (cnp_codigo)
    WHERE s.un > 0 AND ${filtro}
    ON CONFLICT (cnp_codigo) DO NOTHING`;
}

/** Reserva N trabalhos de forma segura mesmo com vários workers (SKIP LOCKED). */
export async function reservarTrabalhos(n: number): Promise<{ id: number; cnp_codigo: string; via: Via; tentativas: number }[]> {
  return prisma.$queryRaw`
    UPDATE "EnriquecimentoFila" f SET estado = 'em_curso', tentativas = f.tentativas + 1, atualizado_em = now()
    WHERE f.id IN (
      SELECT id FROM "EnriquecimentoFila"
      WHERE estado IN ('pendente','erro') AND proxima_tentativa <= now()
      ORDER BY prioridade DESC
      LIMIT ${n}
      FOR UPDATE SKIP LOCKED)
    RETURNING f.id, f.cnp_codigo, f.via, f.tentativas`;
}

export async function carregarProduto(cnp: string, via: Via): Promise<ProdutoAlvo | null> {
  const rows = await prisma.$queryRaw<any[]>`
    SELECT cnp_codigo, designacao, tipo_venda, laboratorio_titular, dci, categoria, subcategoria
    FROM "ProdutoMestre" WHERE cnp_codigo = ${cnp}`;
  return rows[0] ? { ...rows[0], via } : null;
}

export async function concluirTrabalho(id: number, estado: 'concluido' | 'ignorado') {
  await prisma.$executeRaw`UPDATE "EnriquecimentoFila" SET estado = ${estado}, ultimo_erro = NULL, atualizado_em = now() WHERE id = ${id}`;
}

/** Modo seco: devolve o trabalho à fila sem contar a tentativa. */
export async function devolverTrabalho(id: number) {
  await prisma.$executeRaw`UPDATE "EnriquecimentoFila" SET estado = 'pendente', tentativas = GREATEST(tentativas - 1, 0), atualizado_em = now() WHERE id = ${id}`;
}

export async function falharTrabalho(id: number, tentativas: number, maxTentativas: number, erro: string) {
  const final = tentativas >= maxTentativas;
  const minutos = Math.min(60 * 24, 5 * 2 ** tentativas); // backoff: 10, 20, 40 min ...
  await prisma.$executeRaw`
    UPDATE "EnriquecimentoFila"
    SET estado = ${final ? 'ignorado' : 'erro'}, ultimo_erro = ${erro.slice(0, 1000)},
        proxima_tentativa = now() + make_interval(mins => ${minutos}::int), atualizado_em = now()
    WHERE id = ${id}`;
}

/** Grava uma nova versão do enriquecimento (desativa a anterior) + fontes. */
export async function gravarEnriquecimento(args: {
  produto: ProdutoAlvo;
  origem: 'web_llm' | 'regra_interna';
  perfil: PerfilModelo | null;
  validacao: ResultadoValidacao | null;
  regra?: { categoria: string; subcategoria: string; motivo: string };
  urlsLidas?: Set<string>;
  uso?: unknown;
  modelo?: string;
  promptVersion?: string;
}) {
  const { produto, origem, perfil, validacao, regra } = args;
  await prisma.$transaction(async (tx) => {
    const ant = await tx.$queryRaw<{ versao: number }[]>`
      SELECT COALESCE(MAX(versao),0) AS versao FROM "ProdutoEnriquecimento" WHERE cnp_codigo = ${produto.cnp_codigo}`;
    const versao = Number(ant[0]?.versao ?? 0) + 1;
    await tx.$executeRaw`UPDATE "ProdutoEnriquecimento" SET ativo = false WHERE cnp_codigo = ${produto.cnp_codigo} AND ativo`;

    const j = (v: unknown) => (v == null ? null : JSON.stringify(v));
    const inserido = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "ProdutoEnriquecimento" (
        cnp_codigo, versao, ativo, estado, confianca, correspondencia_produto, origem, tipo_produto, dci, atc,
        composicao, forma, via_administracao, finalidade, patologias, sintomas, publico, tipo_venda_fonte,
        categoria_sugerida, subcategoria_sugerida, rejeitados, termos_novos, modelo, prompt_version, uso_tokens)
      VALUES (
        ${produto.cnp_codigo}, ${versao}, true,
        ${origem === 'regra_interna' ? 'regra_interna' : validacao!.estado},
        ${origem === 'regra_interna' ? 'media' : validacao!.confianca},
        ${origem === 'regra_interna' ? 'nenhum' : validacao!.correspondencia},
        ${origem}, ${perfil?.tipo_produto ?? null}, ${perfil?.dci ?? null}, ${validacao?.atc ?? null},
        ${j(perfil?.composicao)}::jsonb, ${perfil?.forma ?? null}, ${perfil?.via_administracao ?? null},
        ${validacao?.finalidade ?? null},
        ${j(validacao?.patologias)}::jsonb, ${j(validacao?.sintomas)}::jsonb, ${j(validacao?.publico)}::jsonb,
        ${perfil?.tipo_venda_fonte ?? null},
        ${regra?.categoria ?? null}, ${regra?.subcategoria ?? null},
        ${j(validacao ? { itens: validacao.rejeitados, motivos: validacao.motivos } : regra ? { motivo: regra.motivo } : null)}::jsonb,
        ${j(validacao?.termosNovos)}::jsonb, ${args.modelo ?? null}, ${args.promptVersion ?? null}, ${j(args.uso)}::jsonb)
      RETURNING id`;
    const enriquecimentoId = inserido[0].id;

    for (const f of perfil?.fontes ?? []) {
      const { tipo, nivel } = classificarFonte(f.url, f.tipo);
      await tx.$executeRaw`
        INSERT INTO "EnriquecimentoFonte" (enriquecimento_id, cnp_codigo, url, dominio, tipo, nivel, titulo, data_documento, lida_pelo_modelo)
        VALUES (${enriquecimentoId}, ${produto.cnp_codigo}, ${f.url}, ${dominioDe(f.url)}, ${tipo}, ${nivel},
                ${f.titulo ?? null}, ${f.data_documento ?? null}, ${args.urlsLidas?.has(f.url) ?? false})`;
    }
  });
}
