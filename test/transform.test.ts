import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { lerPastaCsv } from '../src/cits/source.js';
import { classificarDispensa, normalizarCnp, transformar } from '../src/cits/transform.js';

const PASTA = fileURLToPath(new URL('./fixtures/cits_sintetico', import.meta.url));
const DIA = '2026-11-20';

const { dados, validacao } = lerPastaCsv(PASTA);
const { produtos, avisos } = transformar(dados, DIA);
const p = (cnp: string) => {
  const r = produtos.find((x) => x.cnp_codigo === cnp);
  assert.ok(r, `CNP ${cnp} não encontrado`);
  return r;
};

test('estrutura válida e embalagens transformadas', () => {
  assert.deepEqual(validacao.erros, []);
  assert.equal(produtos.length, 19); // 20 embalagens, 1 sem NR_REGISTO
  assert.ok(avisos.some((a) => a.includes('1 embalagens sem NR_REGISTO')));
});

test('CNP normalizado para 7 dígitos', () => {
  assert.equal(normalizarCnp('123456'), '0123456');
  assert.equal(normalizarCnp(' 5000001 '), '5000001');
  assert.equal(normalizarCnp(null), null);
  assert.ok(p('0123456'));
});

test('receita e venda livre', () => {
  assert.equal(p('5000001').regime_dispensa, 'SEM_RECEITA_LIVRE');
  assert.equal(p('5000001').precisa_receita, false);
  assert.equal(p('5000006').regime_dispensa, 'SEM_RECEITA_SO_FARMACIA');
  assert.equal(p('5000006').tipo_venda_derivado, 'MNSRM');
  assert.equal(p('5000003').regime_dispensa, 'COM_RECEITA');
  assert.equal(p('5000007').regime_dispensa, 'COM_RECEITA_ESPECIAL');
  assert.equal(p('5000008').regime_dispensa, 'COM_RECEITA_RESTRITA');
  // MSRM-EF conta como receita (regra conservadora)
  assert.equal(p('5000009').regime_dispensa, 'RECEITA_OU_PROTOCOLO');
  assert.equal(p('5000009').precisa_receita, true);
});

test('várias classificações: fica a mais restritiva', () => {
  assert.deepEqual(p('0123456').classificacoes_dispensa, [1, 6]);
  assert.equal(p('0123456').regime_dispensa, 'COM_RECEITA');
  assert.equal(classificarDispensa([1, 8, 7], 'MUH').regime, 'RECEITA_OU_PROTOCOLO');
});

test('não medicamentos e medicamento sem classificação', () => {
  assert.equal(p('5000014').tipo_produto, 'DM');
  assert.equal(p('5000014').regime_dispensa, 'NAO_MEDICAMENTO');
  assert.equal(p('5000014').tipo_venda_derivado, 'VENDA_LIVRE');
  assert.equal(p('5000015').tipo_produto, 'COSMETICO');
  // medicamento sem classificação -> DESCONHECIDO e precisa de receita
  assert.equal(p('5000017').regime_dispensa, 'DESCONHECIDO');
  assert.equal(p('5000017').precisa_receita, true);
});

test('genérico, marca, biossimilar', () => {
  assert.equal(p('5000001').eh_generico, false);
  assert.equal(p('5000001').eh_marca, true);
  assert.equal(p('5000002').eh_generico, true);
  assert.equal(p('5000002').eh_marca, false);
  assert.equal(p('5000001').gh_codigo, p('5000002').gh_codigo); // marca e genérico no mesmo GH
  assert.equal(p('5000008').eh_biossimilar, true);
  assert.equal(p('5000008').eh_biologico, true);
  assert.equal(p('5000014').eh_marca, false); // dispositivo não é "marca"
});

test('público pediátrico com a fonte', () => {
  assert.deepEqual([p('5000011').publico, p('5000011').publico_fonte], ['PEDIATRICO', 'CITS_AIMUP']);
  assert.deepEqual([p('5000016').publico, p('5000016').publico_fonte], ['PEDIATRICO', 'CITS_SUBGRUPO']);
  assert.deepEqual([p('5000012').publico, p('5000012').publico_fonte], ['PEDIATRICO', 'INFERIDO_DESIGNACAO']);
  assert.equal(p('5000001').publico, 'DESCONHECIDO');
});

test('preços em vigor na data de referência', () => {
  assert.equal(p('5000001').pvp_oficial, 2.65);      // ignora o PVP terminado
  assert.equal(p('5000005').pvp_oficial, 4.12);      // ignora o preço do próximo mês
  assert.equal(p('5000005').preco_referencia, 4.12);
  assert.equal(p('5000007').pvp_max, 18.4);
  assert.equal(p('5000013').pvp_notificado, 7.9);
  // PVP/PVP Max: manda a flag ATIVO do ficheiro, não a data. O preço do próximo mês (ATIVO = 0)
  // só passa a contar quando um ficheiro novo o trouxer com ATIVO = 1.
  assert.equal(transformar(dados, '2026-12-05').produtos.find((x) => x.cnp_codigo === '5000005')?.pvp_oficial, 4.12);
});

test('comparticipação, comercialização, escoamento, conservação, alertas', () => {
  assert.deepEqual(p('5000005').comparticipacoes.map((c) => [c.regime, c.percentagem]),
    [['Regime Especial', 90], ['Regime Geral', 69]]);
  assert.deepEqual(p('5000009').comparticipacoes, []); // comparticipação já terminada
  assert.equal(p('5000009').estado_comercializacao, 'Temporariamente indisponível');
  assert.equal(p('5000009').data_prevista_reposicao, '2026-12-15');
  assert.equal(p('5000001').data_prevista_reposicao, null);
  assert.equal(p('5000018').fim_escoamento, '2027-02-28');
  assert.equal(p('5000018').estado_aim, 'Revogado');
  assert.equal(p('5000008').conservacao, 'Conservar no frigorífico (2ºC - 8ºC)');
  assert.deepEqual(p('5000007').alertas[0].faixa_etaria, [0, 6]);
});

test('descritivos: DCI, forma, ATC, CFT, vias, titular', () => {
  const x = p('5000003');
  assert.equal(x.dci, 'Atorvastatina');
  assert.equal(x.forma_farmaceutica, 'Comprimido revestido por película');
  assert.deepEqual(x.atc_codigos, ['C10AA05']);
  assert.deepEqual(x.cft_descricoes, ['Antidislipidémicos']);
  assert.deepEqual(x.vias_administracao, ['Via oral']);
  assert.equal(x.titular_aim, 'Laboratório Alfa, S.A.');
  assert.equal(x.gh_descricao, 'Atorvastatina 20 mg Comprimido revestido');
});

test('hash estável entre execuções', () => {
  const outra = transformar(lerPastaCsv(PASTA).dados, DIA).produtos;
  assert.deepEqual(outra.map((x) => x.hash_conteudo), produtos.map((x) => x.hash_conteudo));
});

test('coluna obrigatória em falta rejeita a estrutura', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cits-test-'));
  cpSync(PASTA, tmp, { recursive: true });
  const f = join(tmp, 'EMBALAGEM.csv');
  writeFileSync(f, readFileSync(f, 'utf8').replace('NR_REGISTO', 'NR_REGISTO_X'));
  const v = lerPastaCsv(tmp).validacao;
  assert.ok(v.erros.some((e) => e.includes('EMBALAGEM') && e.includes('NR_REGISTO')));
});

test('tabela com acento no nome é reconhecida (COMPARTICIPAÇÃO)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cits-test-'));
  cpSync(PASTA, tmp, { recursive: true });
  writeFileSync(join(tmp, 'COMPARTICIPAÇÃO.csv'), readFileSync(join(tmp, 'COMPARTICIPACAO.csv')));
  rmSync(join(tmp, 'COMPARTICIPACAO.csv'));
  const r = lerPastaCsv(tmp);
  assert.deepEqual(r.validacao.erros, []);
  assert.equal(r.dados.get('COMPARTICIPACAO')?.length, 4);
});
