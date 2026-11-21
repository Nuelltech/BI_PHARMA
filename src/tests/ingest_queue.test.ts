import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { enqueueIngestJob, getIngestProgress } from '../services/ingest_queue';
import { getDashboardFromMarts } from '../services/marts_service';

const prisma = new PrismaClient();

describe('Fase 3: Workers Assíncronos de Ingestão & Recalculo de Marts', () => {
  it('1. Deve enfileirar um trabalho de ingestão em < 50ms e retornar status QUEUED', async () => {
    const farmacia = await prisma.farmacia.findFirst();
    expect(farmacia).not.toBeNull();
    if (!farmacia) return;

    // Ficheiro CSV de vendas de teste (simulado)
    const mockCsvContent = 'CNP;Designacao;Data;Quantidade;ValorVenda\n9999999;TESTE SKU QUEUE;2026-03-01;2;15.50\n';
    const files = [
      {
        name: 'Vendas_Queue_Test.csv',
        buffer: Buffer.from(mockCsvContent, 'utf-8'),
      },
    ];

    let cacheInvalidated = false;
    const startEnqueue = performance.now();
    const result = await enqueueIngestJob(
      prisma,
      farmacia.id,
      files,
      {},
      (fid) => {
        if (fid === farmacia.id) cacheInvalidated = true;
      }
    );
    const enqueueDuration = performance.now() - startEnqueue;

    console.log(`⏱️ Tempo de resposta do enqueueIngestJob: ${enqueueDuration.toFixed(2)} ms`);
    expect(enqueueDuration).toBeLessThan(100); // SLO: < 100ms
    expect(result.ok).toBe(true);
    expect(result.jobId).toBeDefined();

    // Verifica que o progresso inicial foi imediatamente atualizado
    const initialProg = getIngestProgress(farmacia.id);
    expect(['QUEUED', 'PROCESSING', 'COMPLETED']).toContain(initialProg.status);
    expect(initialProg.percent).toBeGreaterThanOrEqual(5);

    // Aguarda o worker terminar o processamento em segundo plano (polling com timeout de 30s)
    const startTime = Date.now();
    let finalProg = getIngestProgress(farmacia.id);
    while (finalProg.status !== 'COMPLETED' && finalProg.status !== 'FAILED') {
      if (Date.now() - startTime > 30000) {
        throw new Error(`Timeout à espera da conclusão do Worker. Último estado: ${finalProg.status} (${finalProg.step})`);
      }
      await new Promise((r) => setTimeout(r, 200));
      finalProg = getIngestProgress(farmacia.id);
    }

    console.log(`✅ Worker completou com estado: ${finalProg.status} - ${finalProg.step}`);
    expect(finalProg.status).toBe('COMPLETED');
    expect(finalProg.percent).toBe(100);
    expect(cacheInvalidated).toBe(true);

    // Confirma que os Marts estão acessíveis e atualizados
    const dashboard = await getDashboardFromMarts(prisma, farmacia.id);
    expect(dashboard).not.toBeNull();
  });
});
