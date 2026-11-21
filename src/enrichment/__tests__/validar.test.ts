// Testes sem base de dados nem API: correr com  npx tsx --test src/enrichment/__tests__/*.test.ts
// Casos tirados do piloto de 30 produtos (20-11-2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarPerfil, correspondenciaProduto, evidenciaPresente, normalizar } from '../validar';
import { classificarPorRegra, pareceCodigoInterno } from '../regrasInternas';
import type { Corpus, PerfilModelo, ProdutoAlvo } from '../types';

const corpus = (texto: string, lidas: string[] = []): Corpus =>
  ({ texto, urlsLidas: new Set(lidas), urlsVistas: new Set() });

const docealivio: ProdutoAlvo = {
  cnp_codigo: '9838102', designacao: 'Doce Alívio x 30 comp', tipo_venda: 'MNSRM',
  laboratorio_titular: 'Moreno', dci: null, categoria: null, subcategoria: null, via: 'MEDICAMENTO',
};

test('Doce Alívio: página sobre bisacodilo (produto errado) → não corresponde → revisão', () => {
  const c = corpus('Bisacodil. Alívio de curto prazo da constipação e para a limpeza intestinal antes de procedimentos médicos.',
    ['https://www.apollohospitals.com/pt/medicines/bisacodyl']);
  const perfil: PerfilModelo = {
    encontrado: true, dci: 'Bisacodilo', finalidade_curta: 'laxante',
    finalidade_evidencia: 'Alívio de curto prazo da constipação',
    patologias: [{ termo: 'obstipacao', evidencia: 'Alívio de curto prazo da constipação', url: 'https://www.apollohospitals.com/pt/medicines/bisacodyl' }],
    fontes: [{ url: 'https://www.apollohospitals.com/pt/medicines/bisacodyl', tipo: 'outro' }],
  };
  const v = validarPerfil(docealivio, perfil, c);
  assert.equal(v.correspondencia, 'nenhum');
  assert.equal(v.estado, 'revisao');
});

test('Doce Alívio: folheto PT certo → corresponde pelo nome → ativo com confiança alta', () => {
  const url = 'https://medikamio.com/pt-pt/medicamentos/doce-alivio/pil';
  const c = corpus('Doce Alívio comprimidos, contém 0,1345g Cáscara Sagrada, 0,0051g Extrato de Beladona ... ' +
    'O Doce Alívio pertence ao grupo dos medicamentos utilizados como laxantes de contacto.', [url]);
  const perfil: PerfilModelo = {
    encontrado: true, finalidade_curta: 'laxante de contacto',
    finalidade_evidencia: 'pertence ao grupo dos medicamentos utilizados como laxantes de contacto',
    patologias: [{ termo: 'obstipacao', evidencia: 'medicamentos utilizados como laxantes de contacto', url }],
    fontes: [{ url, tipo: 'folheto_pt_espelho' }],
  };
  const v = validarPerfil(docealivio, perfil, c);
  assert.equal(v.correspondencia, 'nome');
  assert.equal(v.confianca, 'alta');
  assert.equal(v.estado, 'ativo_provisorio');
});

test('Avène: CNP presente na página da farmácia PT → corresponde por CNP', () => {
  const p: ProdutoAlvo = { cnp_codigo: '7559021', designacao: 'Avene Solar Ultra Ser PreenchSPF50+30Ml', tipo_venda: 'VENDA_LIVRE',
    laboratorio_titular: null, dci: null, categoria: null, subcategoria: null, via: 'VENDA_LIVRE' };
  const m = correspondenciaProduto(p, { encontrado: true }, corpus('27,64€ 42,53€ 7559021 Avène Solar Ultra Filler Serum SPF50+ 30ml'));
  assert.equal(m, 'cnp');
});

test('Evidência inventada é rejeitada; evidência literal (com quebras de linha) é aceite', () => {
  const texto = normalizar('Vibrocil Actilong 0,5 mg/ml é indicado para crianças entre 1 e\n11 anos de idade.');
  assert.equal(evidenciaPresente('é indicado para crianças entre 1 e 11 anos de idade', texto), true);
  assert.equal(evidenciaPresente('indicado para bebés a partir dos 3 meses de idade', texto), false);
});

test('Idade sem evidência é removida; termo fora do vocabulário vai para termos_novos', () => {
  const url = 'https://ema.europa.eu/x';
  const p: ProdutoAlvo = { ...docealivio, cnp_codigo: '5653928', designacao: 'Synjardy 5 mg + 1000 mg' };
  const c = corpus('Synjardy é indicado em adultos e crianças com idade igual ou superior a 10 anos no tratamento de diabetes mellitus tipo 2', [url]);
  const v = validarPerfil(p, {
    encontrado: true,
    patologias: [
      { termo: 'diabetes_tipo_2', evidencia: 'no tratamento de diabetes mellitus tipo 2', url },
      { termo: 'controlo_glicemico', evidencia: 'adultos e crianças com idade igual ou superior a 10 anos', url },
    ],
    publico: { sexo: 'ambos', idade_min_meses: 6, idade_evidencia: 'a partir dos 6 meses' },
    fontes: [{ url, tipo: 'ema' }],
  }, c);
  assert.equal(v.publico?.idade_min_meses, null);
  assert.ok(v.termosNovos.includes('patologias:controlo_glicemico'));
  assert.equal(v.confianca, 'alta');
});

test('Fonte não aberta (só vista na pesquisa) não dá confiança', () => {
  const url = 'https://ema.europa.eu/y';
  const p: ProdutoAlvo = { ...docealivio, cnp_codigo: '5588678', designacao: 'Brintellix, 20 mg x 28 comp rev' };
  const v = validarPerfil(p, {
    encontrado: true, finalidade_curta: 'antidepressivo', finalidade_evidencia: 'Brintellix is an antidepressant medicine',
    fontes: [{ url, tipo: 'ema' }],
  }, corpus('Brintellix is an antidepressant medicine containing the active substance vortioxetine.' /* sem urlsLidas */));
  assert.equal(v.confianca, 'baixa');
  assert.equal(v.estado, 'revisao');
});

test('Regras internas: códigos e artigos genéricos do piloto', () => {
  assert.equal(pareceCodigoInterno('1111111'), true);
  assert.equal(pareceCodigoInterno('0090201'), true);
  assert.equal(pareceCodigoInterno('5725320'), false);
  assert.equal(classificarPorRegra('1111111', 'VITRY OCULOS LEITURA')?.subcategoria, 'Óculos de leitura');
  assert.equal(classificarPorRegra('0904191', 'ÓCULOS SOL')?.subcategoria, 'Óculos de sol');
  assert.equal(classificarPorRegra('0090201', 'LIPS BATOM')?.categoria, 'Maquilhagem');
  assert.equal(classificarPorRegra('5725320', 'Prolif, 250 mg x 20 cáps'), null);
});

// ---------------- v1.1 ----------------
import { normalizarAtc } from '../atc';
import { classificarFonte } from '../fontes';

test('v1.1 Dalzior: evidência de folheto polaco → confiança média, mesmo com página do Infarmed lida', () => {
  const pl = 'https://rejestry.ezdrowie.gov.pl/api/rpl/medicinal-products/50071/leaflet';
  const inf = 'https://www.infarmed.pt/documents/x';
  const p: ProdutoAlvo = { ...docealivio, cnp_codigo: '5919766', designacao: 'Dalzior MG, 10 mg Blister 28 Unidade(s) Comp revest pelic' };
  const c = corpus('Lek Dalzior jest stosowany w leczeniu: Cukrzycy typu 2 u dorosłych i dzieci w wieku 10 lat i starszych. Infarmed lista de preços', [pl, inf]);
  const v = validarPerfil(p, {
    encontrado: true, atc: 'A10BX09',
    patologias: [{ termo: 'diabetes_tipo_2', evidencia: 'Lek Dalzior jest stosowany w leczeniu: Cukrzycy typu 2', url: pl }],
    fontes: [{ url: pl, tipo: 'folheto_pt_espelho' }, { url: inf, tipo: 'infarmed_publico' }],
  }, c);
  assert.equal(v.confianca, 'media');
  assert.equal(v.atc, 'A10BK01');
});

test('v1.1 fontes: o tipo declarado pelo modelo não sobe o nível de um domínio desconhecido', () => {
  assert.equal(classificarFonte('https://exemplo.pl/folheto', 'folheto_pt_espelho').nivel, 4);
  assert.equal(classificarFonte('https://rejestry.ezdrowie.gov.pl/x').nivel, 3);
  assert.equal(classificarFonte('https://medikamio.com/pt-pt/x').nivel, 2);
  assert.equal(classificarFonte('https://www.ema.europa.eu/x').nivel, 1);
});

test('v1.1 ATC: formato, reclassificação SGLT2 e códigos válidos mantidos', () => {
  assert.equal(normalizarAtc('A10BX12').atc, 'A10BK03');
  assert.equal(normalizarAtc('a07f a02').atc, 'A07FA02');
  assert.equal(normalizarAtc('G04BE03').atc, 'G04BE03');
  assert.equal(normalizarAtc('xpto').atc, null);
});
