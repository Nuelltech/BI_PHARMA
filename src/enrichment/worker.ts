// Worker de enriquecimento.
// Uso:
//   npx tsx src/enrichment/worker.ts --semear medicamentos_sem_dci
//   npx tsx src/enrichment/worker.ts --limite 50            (processa 50 e termina)
//   npx tsx src/enrichment/worker.ts --limite 5 --seco      (não grava; imprime resultado)
// Agendar no servidor (cron), por exemplo todas as noites às 02:00:
//   0 2 * * *  cd /app && npx tsx src/enrichment/worker.ts --limite 200 >> logs/enrich.log 2>&1

import { assertConfig, config } from './config';
import { enriquecerProduto } from './claudeClient';
import {
  Ambito, carregarProduto, concluirTrabalho, devolverTrabalho, falharTrabalho, gravarEnriquecimento, prisma, reservarTrabalhos, semearFila,
} from './db';
import { classificarPorRegra } from './regrasInternas';
import { validarPerfil } from './validar';

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n: string) => args.includes(n);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const semear = arg('--semear') as Ambito | undefined;
  if (semear) {
    const n = await semearFila(semear);
    console.log(`[fila] ${n} produtos adicionados (${semear})`);
    return;
  }

  assertConfig();
  const limite = Number(arg('--limite') ?? 20);
  const seco = flag('--seco');
  const totais = { processados: 0, ativos: 0, revisao: 0, nao_encontrado: 0, regra: 0, erros: 0, input: 0, output: 0, pesquisas: 0, leituras: 0 };

  while (totais.processados < limite) {
    const lote = await reservarTrabalhos(Math.min(5, limite - totais.processados));
    if (!lote.length) break;

    for (const job of lote) {
      totais.processados++;
      try {
        const produto = await carregarProduto(job.cnp_codigo, job.via);
        if (!produto) { await concluirTrabalho(job.id, 'ignorado'); continue; }

        // 1) Regras internas (códigos internos, óculos, batons...) — sem chamar a API
        const regra = classificarPorRegra(produto.cnp_codigo, produto.designacao);
        if (regra) {
          totais.regra++;
          if (!seco) await gravarEnriquecimento({ produto, origem: 'regra_interna', perfil: null, validacao: null, regra });
          console.log(`[regra] ${produto.cnp_codigo} ${produto.designacao} → ${regra.categoria} > ${regra.subcategoria}`);
          await (seco ? devolverTrabalho(job.id) : concluirTrabalho(job.id, 'concluido'));
          continue;
        }

        // 2) Pesquisa + leitura + extração
        const { perfil, corpus, uso } = await enriquecerProduto(produto);
        totais.input += uso.input_tokens; totais.output += uso.output_tokens;
        totais.pesquisas += uso.web_search_requests; totais.leituras += uso.web_fetch_requests;

        // 3) Validação determinística
        const v = validarPerfil(produto, perfil, corpus);
        if (v.estado === 'ativo_provisorio') totais.ativos++;
        else if (v.estado === 'revisao') totais.revisao++;
        else totais.nao_encontrado++;

        console.log(`[${v.estado}] ${produto.cnp_codigo} ${produto.designacao} | conf=${v.confianca} match=${v.correspondencia}` +
          ` | pat=${v.patologias.length} sin=${v.sintomas.length} rej=${v.rejeitados.length}` +
          (v.motivos.length ? ` | ${v.motivos.join('; ')}` : ''));
        if (seco) console.dir({ perfil, validacao: v, urlsLidas: [...corpus.urlsLidas] }, { depth: 5 });
        else await gravarEnriquecimento({
          produto, origem: 'web_llm', perfil, validacao: v, urlsLidas: corpus.urlsLidas,
          uso, modelo: config.model, promptVersion: config.promptVersion,
        });
        await (seco ? devolverTrabalho(job.id) : concluirTrabalho(job.id, 'concluido'));
      } catch (e: any) {
        totais.erros++;
        console.error(`[erro] ${job.cnp_codigo}: ${e?.message ?? e}`);
        await falharTrabalho(job.id, job.tentativas, config.maxAttempts, String(e?.message ?? e));
        if (e?.status === 429 || e?.status === 529) await dormir(60_000); // limite/sobrecarga: esperar
      }
      await dormir(config.delayMs);
    }
  }
  console.log('[resumo]', totais);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
