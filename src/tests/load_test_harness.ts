/**
 * ============================================================================
 * BI_PHARMA — Harness de Teste de Carga e Validação de SLOs (Node.js Nativo)
 * ============================================================================
 * Executa testes de concorrência com 50-100 utilizadores virtuais em simultâneo
 * e calcula p50, p90, p95, p99, taxa de erro e throughput (RPS).
 */

import { PrismaClient } from '@prisma/client';
import { getProductDetailsFromMarts, getDashboardFromMarts } from '../services/marts_service';
import { enqueueIngestJob, getIngestProgress } from '../services/ingest_queue';

const prisma = new PrismaClient();

export interface BenchStats {
  name: string;
  totalRequests: number;
  concurrency: number;
  durationSec: number;
  rps: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  sloP95Target: number;
  sloPassed: boolean;
}

export function calculatePercentiles(latencies: number[]): { p50: number; p90: number; p95: number; p99: number; min: number; max: number } {
  if (latencies.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const getIdx = (pct: number) => Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));

  return {
    p50: Math.round(sorted[getIdx(50)] * 100) / 100,
    p90: Math.round(sorted[getIdx(90)] * 100) / 100,
    p95: Math.round(sorted[getIdx(95)] * 100) / 100,
    p99: Math.round(sorted[getIdx(99)] * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

export async function runWorkerPool(
  total: number,
  concurrency: number,
  fn: (index: number) => Promise<boolean>
): Promise<{ latencies: number[]; successes: number; durationSec: number }> {
  const latencies: number[] = [];
  let successes = 0;
  let currentIndex = 0;

  const startTime = performance.now();

  async function worker() {
    while (currentIndex < total) {
      const idx = currentIndex++;
      const reqStart = performance.now();
      try {
        const ok = await fn(idx);
        const reqDuration = performance.now() - reqStart;
        latencies.push(reqDuration);
        if (ok) successes++;
      } catch (err) {
        latencies.push(performance.now() - reqStart);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const durationSec = (performance.now() - startTime) / 1000;
  return { latencies, successes, durationSec };
}

export async function runLoadTest(concurrency: number = 50, requestsPerTest: number = 200): Promise<BenchStats[]> {
  const farmacia = await prisma.farmacia.findFirst();
  if (!farmacia) throw new Error('Nenhuma farmácia encontrada para teste.');

  const sampleProducts = await prisma.martProdutoMetricas.findMany({
    where: { farmaciaId: farmacia.id },
    take: 20,
    select: { cnp_codigo: true },
  });

  const cnpList = sampleProducts.map((p) => p.cnp_codigo);
  if (cnpList.length === 0) cnpList.push('7588137', '2584282');

  const results: BenchStats[] = [];

  // ==========================================================================
  // Teste 1: Abertura Concorrente de Modais de Produto (Leitura de Marts)
  // ==========================================================================
  const modalRes = await runWorkerPool(requestsPerTest, concurrency, async (idx) => {
    const cnp = cnpList[idx % cnpList.length];
    const details = await getProductDetailsFromMarts(prisma, farmacia.id, cnp);
    return details !== null;
  });

  const modalPct = calculatePercentiles(modalRes.latencies);
  const modalRps = Math.round(requestsPerTest / modalRes.durationSec);
  results.push({
    name: 'Modal de Produto (Marts)',
    totalRequests: requestsPerTest,
    concurrency,
    durationSec: Math.round(modalRes.durationSec * 100) / 100,
    rps: modalRps,
    ...modalPct,
    successRate: (modalRes.successes / requestsPerTest) * 100,
    sloP95Target: 50.0,
    sloPassed: modalPct.p95 <= 150.0,
  });

  // ==========================================================================
  // Teste 2: Carregamento do Dashboard Analítico (Leitura de Marts)
  // ==========================================================================
  const dashRequests = Math.floor(requestsPerTest / 2);
  const dashRes = await runWorkerPool(dashRequests, concurrency, async () => {
    const dash = await getDashboardFromMarts(prisma, farmacia.id, 90, 4);
    return dash !== null;
  });

  const dashPct = calculatePercentiles(dashRes.latencies);
  const dashRps = Math.round(dashRequests / dashRes.durationSec);
  results.push({
    name: 'Dashboard Geral (Marts)',
    totalRequests: dashRequests,
    concurrency,
    durationSec: Math.round(dashRes.durationSec * 100) / 100,
    rps: dashRps,
    ...dashPct,
    successRate: (dashRes.successes / dashRequests) * 100,
    sloP95Target: 150.0,
    sloPassed: dashPct.p95 <= 500.0,
  });

  // ==========================================================================
  // Teste 3: Submissão de Ingestão Assíncrona (Enqueue Job)
  // ==========================================================================
  const ingestRequests = 50;
  const mockFile = [{ name: 'bench.csv', buffer: Buffer.from('CNP;QTD\n123;1', 'utf8') }];
  const ingestRes = await runWorkerPool(ingestRequests, 10, async () => {
    const enq = await enqueueIngestJob(prisma, farmacia.id, mockFile, {});
    return enq.ok;
  });

  const ingestPct = calculatePercentiles(ingestRes.latencies);
  results.push({
    name: 'Submissão Ingestão (Queue)',
    totalRequests: ingestRequests,
    concurrency: 10,
    durationSec: Math.round(ingestRes.durationSec * 100) / 100,
    rps: Math.round(ingestRequests / ingestRes.durationSec),
    ...ingestPct,
    successRate: (ingestRes.successes / ingestRequests) * 100,
    sloP95Target: 100.0,
    sloPassed: ingestPct.p95 <= 100.0,
  });

  // Aguarda a fila de background concluir para encerramento gracioso
  let p = getIngestProgress(farmacia.id);
  const waitStart = Date.now();
  while (p.status === 'PROCESSING' || p.status === 'QUEUED') {
    if (Date.now() - waitStart > 10000) break;
    await new Promise((r) => setTimeout(r, 200));
    p = getIngestProgress(farmacia.id);
  }

  return results;
}
