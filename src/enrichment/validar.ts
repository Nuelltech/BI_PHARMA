// Validação determinística do perfil devolvido pelo modelo.
// Princípio: nada entra sem prova no texto que foi realmente obtido nesta execução.

import { normalizarAtc } from './atc';
import { classificarFonte } from './fontes';
import type { Corpus, ItemEvidencia, PerfilModelo, ProdutoAlvo, ResultadoValidacao } from './types';
import { ehPatologiaConhecida, ehSintomaConhecido, normalizarTermo } from './vocabulario';

const STOP = new Set(['de', 'da', 'do', 'e', 'com', 'x', 'mg', 'ml', 'g', 'ui', 'un', 'unidade', 'unidades', 'blister',
  'frasco', 'comp', 'comprimidos', 'caps', 'capsulas', 'cps', 'saq', 'saquetas', 'revest', 'pelic', 'sol', 'oral',
  'gel', 'creme', 'mg/ml', 'para', 'em', 'promo', 'of', 'oferta']);

export function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Palavras distintivas da designação (marca, nome) — sem unidades nem palavras genéricas. */
export function tokensDistintivos(designacao: string): string[] {
  return normalizar(designacao).split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+([.,]\d+)?$/.test(t));
}

export function correspondenciaProduto(p: ProdutoAlvo, perfil: PerfilModelo, corpus: Corpus): 'cnp' | 'nome' | 'nenhum' {
  const texto = normalizar(corpus.texto);
  if (texto.includes(p.cnp_codigo)) return 'cnp';
  const toks = tokensDistintivos(p.designacao);
  if (!toks.length) return 'nenhum';
  // A 1.ª palavra distintiva (normalmente a marca) tem de aparecer; e ≥60% das restantes.
  const presentes = toks.filter((t) => texto.includes(t));
  const marcaPresente = texto.includes(toks[0]);
  if (marcaPresente && presentes.length / toks.length >= 0.6) return 'nome';
  return 'nenhum';
}

/** A evidência tem de existir no texto obtido (igual, ou ≥90% das palavras em sequência curta). */
export function evidenciaPresente(evidencia: string | null | undefined, corpusNorm: string): boolean {
  if (!evidencia) return false;
  const e = normalizar(evidencia);
  if (e.length < 8) return false;
  if (corpusNorm.includes(e)) return true;
  // tolerância: quebras de linha/hífens nos PDFs — procurar janelas de 6 palavras
  const pal = e.split(' ');
  if (pal.length < 6) return false;
  let ok = 0, total = 0;
  for (let i = 0; i + 6 <= pal.length; i += 3) {
    total++;
    if (corpusNorm.includes(pal.slice(i, i + 6).join(' '))) ok++;
  }
  return total > 0 && ok / total >= 0.9;
}

export function validarPerfil(p: ProdutoAlvo, perfil: PerfilModelo | null, corpus: Corpus): ResultadoValidacao {
  const rejeitados: ResultadoValidacao['rejeitados'] = [];
  const motivos: string[] = [];
  const termosNovos: string[] = [];

  if (!perfil || !perfil.encontrado) {
    return {
      estado: 'nao_encontrado', confianca: 'baixa', correspondencia: 'nenhum', patologias: [], sintomas: [],
      publico: null, finalidade: null, atc: null, rejeitados, termosNovos, motivos: [perfil?.motivo_nao_encontrado ?? 'sem perfil'],
    };
  }

  const corpusNorm = normalizar(corpus.texto);
  const correspondencia = correspondenciaProduto(p, perfil, corpus);
  if (correspondencia === 'nenhum') motivos.push('a página obtida não menciona o CNP nem o nome do produto');

  const filtrar = (itens: ItemEvidencia[] | undefined, campo: 'patologias' | 'sintomas') => {
    const ok: ItemEvidencia[] = [];
    for (const it of itens ?? []) {
      if (!evidenciaPresente(it.evidencia, corpusNorm)) {
        rejeitados.push({ campo, valor: it, motivo: 'evidência não encontrada no texto obtido' });
        continue;
      }
      const termo = normalizarTermo(it.termo);
      const conhecido = campo === 'patologias' ? ehPatologiaConhecida(termo) : ehSintomaConhecido(termo);
      if (!conhecido) termosNovos.push(`${campo}:${termo}`);
      ok.push({ ...it, termo });
    }
    return ok;
  };
  const patologias = filtrar(perfil.patologias, 'patologias');
  const sintomas = filtrar(perfil.sintomas, 'sintomas');

  // Público: cada campo só fica se a evidência existir
  let publico: PerfilModelo['publico'] = null;
  if (perfil.publico) {
    publico = { sexo: null, sexo_evidencia: null, idade_min_meses: null, idade_evidencia: null };
    if (perfil.publico.sexo && perfil.publico.sexo !== 'ambos') {
      if (evidenciaPresente(perfil.publico.sexo_evidencia, corpusNorm)) {
        publico.sexo = perfil.publico.sexo; publico.sexo_evidencia = perfil.publico.sexo_evidencia;
      } else rejeitados.push({ campo: 'publico.sexo', valor: perfil.publico.sexo, motivo: 'evidência não encontrada' });
    } else if (perfil.publico.sexo === 'ambos') publico.sexo = 'ambos';
    const idade = perfil.publico.idade_min_meses;
    if (idade != null) {
      if (idade < 0 || idade > 18 * 12) rejeitados.push({ campo: 'publico.idade', valor: idade, motivo: 'idade fora do intervalo 0–216 meses' });
      else if (evidenciaPresente(perfil.publico.idade_evidencia, corpusNorm)) {
        publico.idade_min_meses = idade; publico.idade_evidencia = perfil.publico.idade_evidencia;
      } else rejeitados.push({ campo: 'publico.idade', valor: idade, motivo: 'evidência não encontrada' });
    }
  }

  // Finalidade: aceite se tiver evidência, ou se houver patologias/sintomas verificados
  let finalidade: string | null = perfil.finalidade_curta ?? null;
  if (finalidade && !evidenciaPresente(perfil.finalidade_evidencia, corpusNorm) && !patologias.length && !sintomas.length) {
    rejeitados.push({ campo: 'finalidade', valor: finalidade, motivo: 'sem evidência' });
    finalidade = null;
  }

  // v1.1: a confiança vem SÓ das fontes de onde saíram as evidências aceites
  // (antes: melhor fonte lida, mesmo que não sustentasse nenhum dado — caso Dalzior).
  const urlsEvidencia = new Set([...patologias, ...sintomas].map((i) => i.url).filter(Boolean));
  const lidas = (perfil.fontes ?? []).filter((f) => corpus.urlsLidas.has(f.url));
  if (!lidas.length) motivos.push('nenhuma das fontes declaradas foi aberta (web_fetch)');
  const base = urlsEvidencia.size
    ? [...urlsEvidencia].filter((u) => corpus.urlsLidas.has(u))
    : lidas.map((f) => f.url); // só finalidade: usa as fontes lidas, mas no máximo confiança média
  if (urlsEvidencia.size && !base.length) motivos.push('as evidências citam páginas que não foram abertas');
  const melhorNivel = Math.min(5, ...base.map((u) => classificarFonte(u).nivel));

  let confianca: ResultadoValidacao['confianca'] = 'baixa';
  if (correspondencia !== 'nenhum') {
    if (melhorNivel <= 2) confianca = urlsEvidencia.size ? 'alta' : 'media';
    else if (melhorNivel === 3 || (melhorNivel === 4 && correspondencia === 'cnp')) confianca = 'media';
  }

  const atcNorm = normalizarAtc(perfil.atc);
  if (atcNorm.nota) motivos.push(atcNorm.nota);

  const temConteudo = patologias.length > 0 || sintomas.length > 0 || !!finalidade;
  const estado: ResultadoValidacao['estado'] =
    correspondencia !== 'nenhum' && confianca !== 'baixa' && temConteudo && rejeitados.length <= 2
      ? 'ativo_provisorio'
      : 'revisao';
  if (rejeitados.length > 2) motivos.push(`${rejeitados.length} itens rejeitados na validação`);
  if (!temConteudo) motivos.push('sem finalidade, patologias ou sintomas verificados');

  return { estado, confianca, correspondencia, patologias, sintomas, publico, finalidade, atc: atcNorm.atc, rejeitados, termosNovos, motivos };
}
