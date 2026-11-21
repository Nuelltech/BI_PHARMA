import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chaveNome, detetarTipo, dividirSeccoes, extrairCnps, extrairData, hashTexto, lerDocumento, limparTexto, nomeFolheto, retirarCarimbos } from '../src/rcm/parse.js';
import { classificar, nomeConfere, processarPasta, type Referencia } from '../src/rcm/worker.js';

const PDFS = fileURLToPath(new URL('./fixtures/rcm_sintetico', import.meta.url));

const RCM = (corpo41: string, extra = '') => `RESUMO DAS CARACTERÍSTICAS DO MEDICAMENTO
1. NOME DO MEDICAMENTO
Dorfim 500 mg comprimidos
2. COMPOSIÇÃO QUALITATIVA E QUANTITATIVA
Cada comprimido contém 500 mg de paracetamol.
3. FORMA FARMACÊUTICA
Comprimido
4. INFORMAÇÕES CLÍNICAS
4.1 Indicações terapêuticas
${corpo41}
4.2 Posologia e modo de administração
Adultos: 1 comprimido. Ver secção 4.3 Contraindicações. ${extra}
4.3 Contraindicações
Hipersensibilidade.
7. TITULAR DA AUTORIZAÇÃO DE INTRODUÇÃO NO MERCADO
Laboratório Alfa
8. NÚMERO(S) DA AUTORIZAÇÃO DE INTRODUÇÃO NO MERCADO
N.º de registo: 5000001 - 20 comprimidos
N.º de registo: 5000004 - 40 comprimidos
10. DATA DA REVISÃO DO TEXTO
03/2025`;

test('tipo de documento pelo conteúdo', () => {
  assert.equal(detetarTipo('ANEXO I\nRESUMO DAS CARACTERÍSTICAS DO MEDICAMENTO\n1. NOME'), 'RCM');
  assert.equal(detetarTipo('Folheto informativo: Informação para o utilizador\nDorfim'), 'FI');
  assert.equal(detetarTipo('1. NOME DO MEDICAMENTO\nX'), 'RCM');
  assert.equal(detetarTipo('outra coisa qualquer'), 'DESCONHECIDO');
});

test('secções: ordem, remissões no texto não partem secções', () => {
  const d = lerDocumento(RCM('Febre e dor.'));
  assert.deepEqual(d.seccoes.map((s) => s.numero), ['1', '2', '3', '4', '4.1', '4.2', '4.3', '7', '8', '10']);
  const s42 = d.seccoes.find((s) => s.numero === '4.2')!;
  assert.match(s42.texto, /Ver secção 4\.3 Contraindicações/);
  assert.equal(d.seccoes.find((s) => s.numero === '4.3')!.texto, 'Hipersensibilidade.');
  assert.equal(d.nome, 'Dorfim 500 mg comprimidos');
  assert.deepEqual(d.cnps, ['5000001', '5000004']);
  assert.equal(d.data_revisao, '2025-03-01');
});

test('títulos colados ao texto (linhas juntas na extração)', () => {
  const colado = 'RESUMO DAS CARACTERÍSTICAS DO MEDICAMENTO 1. NOME DO MEDICAMENTO Dorfim 4.1 Indicações terapêuticas Febre. 4.2 Posologia e modo de administração Adultos. 8. NÚMERO DA AUTORIZAÇÃO DE INTRODUÇÃO NO MERCADO 5000001';
  const { seccoes } = dividirSeccoes(limparTexto(colado));
  assert.deepEqual(seccoes.map((s) => s.numero), ['1', '4.1', '4.2', '8']);
  assert.equal(seccoes.find((s) => s.numero === '4.1')!.texto, 'Febre.');
});

test('hash da secção ignora maiúsculas, acentos e espaços', () => {
  assert.equal(hashTexto('Tratamento da  febre.'), hashTexto('tratamento da febre.'));
  assert.equal(hashTexto('Indicações'), hashTexto('Indicacoes'));
  assert.notEqual(hashTexto('febre'), hashTexto('dor'));
});

test('CNP e datas', () => {
  assert.deepEqual(extrairCnps('Reg. 5000001, 5000001 e 12345678 e 500000'), ['5000001']);
  assert.equal(extrairData('12 de março de 2024'), '2024-03-12');
  assert.equal(extrairData('Novembro de 2024'), '2024-11-01');
  assert.equal(extrairData('03/2025'), '2025-03-01');
  assert.equal(extrairData('15/10/2019'), '2019-10-15');
});

test('classificação com referência', () => {
  const ref: Referencia = new Map([
    ['5000001', { cnp: '5000001', nome: 'Dorfim', dci: 'Paracetamol', prod_id: 1 }],
  ]);
  const d = lerDocumento(RCM('Febre.'));
  const c = classificar(d, ref);
  assert.equal(c.estado, 'IDENTIFICADO');
  assert.deepEqual(c.cnps_ligados, ['5000001']);
  assert.match(c.motivo ?? '', /1 CNP sem correspondência na referência/);
  assert.equal(nomeConfere('Paracetamol Beta 500 mg', [{ cnp: 'x', nome: 'PARACETAMOL BETA', dci: null, prod_id: null }]), true);
  assert.equal(nomeConfere('Zetamax 500 mg', [{ cnp: 'x', nome: 'Lipocor', dci: 'Atorvastatina', prod_id: null }]), false);
});

test('worker sobre os PDF sintéticos (sem BD, sem copiar)', async () => {
  const ref: Referencia = new Map(['5000001', '5000002', '5000003', '5000012'].map((c) => [c, {
    cnp: c, nome: { '5000001': 'Dorfim', '5000002': 'Paracetamol Beta', '5000003': 'Lipocor', '5000012': 'Dorfim Pediátrico' }[c]!,
    dci: 'x', prod_id: Number(c),
  }]));
  const r = await processarPasta({ entrada: PDFS, saida: mkdtempSync(join(tmpdir(), 'rcm-')), referencia: ref, dryRun: true });
  const por = (f: string) => r.find((x) => x.ficheiro_original === f)!;
  assert.equal(r.length, 9);
  assert.equal(por('documento (1).pdf').ficheiro_final, '5000002_RCM.pdf');
  assert.equal(por('documento (2).pdf').estado, 'IDENTIFICADO');
  assert.equal(por('documento (3).pdf').estado, 'POR_REVER');  // sem nº de registo
  assert.equal(por('documento (4).pdf').estado, 'POR_REVER');  // CNP inexistente
  assert.equal(por('documento (5).pdf').doc?.tipo, 'FI');
  assert.match(por('documento (6).pdf').motivo ?? '', /OCR/);
  assert.equal(r.filter((x) => x.estado === 'DUPLICADO').length, 1);
  assert.match(por('documento (8).pdf').motivo ?? '', /não confere/);
  // marca e genérico com a mesma 4.1 partilham o hash
  const h = (f: string) => por(f).doc!.seccoes.find((s) => s.numero === '4.1')!.texto_hash;
  assert.equal(h('documento (1).pdf'), h('documento (7).pdf'));
  assert.notEqual(h('documento (1).pdf'), h('documento (2).pdf'));
});

// ---- Casos encontrados nos RCM reais do Infomed (21-11-2026) ----

test('real: grafia antiga, variantes de título e títulos sem número', () => {
  const t = `RESUMO DAS CARACTERÍSTICAS DO MEDICAMENTO
1. NOME DO MEDICAMENTO
Synalar Rectal, pomada rectal
4.INFORMAÇÕES CLÍNICAS
4.1 Indicações terapêuticas
Hemorróidas.
4.2 Posologia e modo de administração
Duas vezes por dia.
Contraindicações
Hipersensibilidade às substâncias activas.
4.5 Interacções medicamentosas e outras formas de interacção
Não aplicável.
4.6 Fertilidade, gravidez e amamentação
Evitar.
6. INFORMAÇÕES FARMACÊUTICAS
6.1 Lista de excipientes
Mentol.
8. NÚMERO DE AUTORIZAÇÃO DE INTRODUÇÃO NO MERCADO
5396932
DATA DA REVISÃO DO TEXTO
06/2024`;
  const d = lerDocumento(t);
  const n = d.seccoes.map((s) => s.numero);
  for (const x of ['4', '4.3', '4.5', '4.6', '6.1', '8', '10']) assert.ok(n.includes(x), `falta ${x}`);
  assert.equal(d.seccoes.find((s) => s.numero === '4.3')!.texto, 'Hipersensibilidade às substâncias activas.');
  assert.equal(d.data_revisao, '2024-06-01');
});

test('real: "contraindicações" a meio de uma frase não é título', () => {
  const t = `1. NOME DO MEDICAMENTO\nX\n4.1 Indicações terapêuticas\nFebre.\n4.2 Posologia e modo de administração\nRespeitar as contraindicações\nAdultos.\n4.3 Contraindicações\nAlergia.`;
  const d = lerDocumento(t);
  assert.equal(d.seccoes.find((s) => s.numero === '4.3')!.texto, 'Alergia.');
});

test('real: carimbo APROVADO EM ... INFARMED sai do texto e dá a data', () => {
  const r = retirarCarimbos('6.1 Lista de excipientes\nPovidona\nAPROVADO EM\n20-08-2022\nINFARMED\nGlicerol\nAPROVADO EM\nINFARMED\nfim');
  assert.equal(r.data, '2022-08-20');
  assert.doesNotMatch(r.texto, /APROVADO|INFARMED/);
  assert.match(r.texto, /Povidona\nGlicerol/);
});

test('real: RCM com campos de modelo por preencher', () => {
  const d = lerDocumento(RCM('Febre.').replace(/N\.º de registo: \d+ - \d+ comprimidos/g, 'Registo n.º xxxxxxx no INFARMED'));
  assert.equal(d.modelo_por_preencher, true);
  assert.deepEqual(d.cnps, []);
  assert.match(classificar(d).motivo ?? '', /por preencher/);
});

test('real: folheto ligado ao RCM pelo nome', () => {
  const fi = 'APROVADO EM\n06-05-2022\nINFARMED\nFolheto informativo: Informação para o utilizador\nAciclosina 50 mg/g Creme\nAciclovir\n' + 'Leia com atenção. '.repeat(30);
  const d = lerDocumento(fi);
  assert.equal(d.tipo, 'FI');
  assert.equal(d.nome, 'Aciclosina 50 mg/g Creme');
  assert.equal(nomeFolheto('FOLHETO INFORMATIVO: INFORMAÇÃO PARA O UTILIZADOR\nSYNALAR 0,25 mg/g Creme'), 'SYNALAR 0,25 mg/g Creme');
  const porNome = new Map([[chaveNome('Aciclosina 50 mg/g creme')!, ['5216908', '9610709']]]);
  const c = classificar(d, undefined, porNome);
  assert.equal(c.estado, 'IDENTIFICADO');
  assert.deepEqual(c.cnps_ligados, ['5216908', '9610709']);
  assert.equal(classificar(d, undefined, new Map()).estado, 'POR_REVER');
});
