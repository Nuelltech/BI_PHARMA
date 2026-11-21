import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { executeInteractiveImport, ImportExecutionStats } from './interactive_import';
import { computeAndPersistMarts } from './marts_service';

export interface IngestJobPayload {
  jobId: string;
  farmaciaId: string;
  fileBuffers: Array<{ name: string; bufferBase64: string }>;
  decisions: any;
}

export interface IngestProgress {
  status: 'IDLE' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  percent: number;
  step: string;
  detail: string;
  stats?: ImportExecutionStats;
  error?: string;
  updatedAt: number;
}

// Armazenamento de progresso por farmácia (acessível pelo endpoint de status)
const progressMap = new Map<string, IngestProgress>();

export function getIngestProgress(farmaciaId: string): IngestProgress {
  return (
    progressMap.get(farmaciaId) || {
      status: 'IDLE',
      percent: 0,
      step: 'A aguardar início...',
      detail: '',
      updatedAt: Date.now(),
    }
  );
}

export function updateIngestProgress(farmaciaId: string, progress: Partial<IngestProgress>): void {
  const cur = getIngestProgress(farmaciaId);
  progressMap.set(farmaciaId, {
    ...cur,
    ...progress,
    updatedAt: Date.now(),
  });
}

const REDIS_URL = process.env.REDIS_URL || '';
const QUEUE_NAME = 'ingest-pharmacy-data';

let redisConnection: IORedis | null = null;
let bullQueue: Queue | null = null;
let bullWorker: Worker | null = null;
let isRedisAvailable = false;

// Fallback assíncrono em fila em memória caso o Redis não esteja ativo no ambiente local
const localQueue: IngestJobPayload[] = [];
let localProcessing = false;

export function initIngestQueue(prisma: any, onCacheInvalidate?: (farmaciaId: string) => void) {
  if (REDIS_URL.trim().length > 0) {
    try {
      redisConnection = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy(times) {
          if (times > 3) {
            console.warn('[Queue] Redis indisponível. A usar fallback assíncrono em segundo plano.');
            return null;
          }
          return Math.min(times * 100, 2000);
        },
      });

      redisConnection.on('connect', () => {
        isRedisAvailable = true;
        console.log('⚡ [Queue] Ligação Redis estabelecida com sucesso para BullMQ!');
      });

      redisConnection.on('error', (err) => {
        isRedisAvailable = false;
      });

      bullQueue = new Queue(QUEUE_NAME, { connection: redisConnection });

      bullWorker = new Worker(
        QUEUE_NAME,
        async (job: Job<IngestJobPayload>) => {
          const { farmaciaId, fileBuffers, decisions } = job.data;
          await processIngestJob(prisma, farmaciaId, fileBuffers, decisions, onCacheInvalidate);
        },
        { connection: redisConnection, concurrency: 2 }
      );

      bullWorker.on('completed', (job) => {
        console.log(`✅ [Worker-ETL] Job ${job.id} concluído com sucesso para farmácia ${job.data.farmaciaId}!`);
      });

      bullWorker.on('failed', (job, err) => {
        console.error(`❌ [Worker-ETL] Falha no Job ${job?.id}:`, err.message);
      });
    } catch (err: any) {
      console.warn('[Queue] Inicialização BullMQ falhou, a usar worker assíncrono interno:', err.message);
    }
  } else {
    console.log('ℹ️ [Queue] REDIS_URL não configurado. A usar Worker assíncrono nativo em segundo plano.');
  }
}

/**
 * Enfileira um novo lote de ficheiros para importação em segundo plano.
 * Responde imediatamente em < 50ms para não bloquear a requisição HTTP.
 */
export async function enqueueIngestJob(
  prisma: any,
  farmaciaId: string,
  fileBuffers: Array<{ name: string; buffer: Buffer }>,
  decisions: any,
  onCacheInvalidate?: (farmaciaId: string) => void
): Promise<{ ok: boolean; jobId: string }> {
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  updateIngestProgress(farmaciaId, {
    status: 'QUEUED',
    percent: 5,
    step: 'Job registado na fila assíncrona...',
    detail: `${fileBuffers.length} ficheiro(s) aguardando processamento pelo Worker`,
  });

  const serializablePayload: IngestJobPayload = {
    jobId,
    farmaciaId,
    fileBuffers: fileBuffers.map((f) => ({
      name: f.name,
      bufferBase64: f.buffer.toString('base64'),
    })),
    decisions,
  };

  if (isRedisAvailable && bullQueue) {
    await bullQueue.add('import-files', serializablePayload, {
      jobId,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    console.log(`📥 [Queue] Job ${jobId} submetido ao BullMQ para farmácia ${farmaciaId}`);
  } else {
    // Executa em fila assíncrona local fora da thread do pedido HTTP
    localQueue.push(serializablePayload);
    triggerLocalQueue(prisma, onCacheInvalidate);
  }

  return { ok: true, jobId };
}

async function triggerLocalQueue(prisma: any, onCacheInvalidate?: (farmaciaId: string) => void) {
  if (localProcessing || localQueue.length === 0) return;
  localProcessing = true;

  setImmediate(async () => {
    while (localQueue.length > 0) {
      const item = localQueue.shift()!;
      try {
        await processIngestJob(prisma, item.farmaciaId, item.fileBuffers, item.decisions, onCacheInvalidate);
      } catch (err: any) {
        console.error(`[Worker-ETL Local] Erro ao processar job ${item.jobId}:`, err);
      }
    }
    localProcessing = false;
  });
}

/**
 * Função central de execução do Worker-ETL
 */
async function processIngestJob(
  prisma: any,
  farmaciaId: string,
  files: Array<{ name: string; bufferBase64: string }>,
  decisions: any,
  onCacheInvalidate?: (farmaciaId: string) => void
): Promise<void> {
  const buffers = files.map((f) => ({
    name: f.name,
    buffer: Buffer.from(f.bufferBase64, 'base64'),
  }));

  try {
    updateIngestProgress(farmaciaId, {
      status: 'PROCESSING',
      percent: 10,
      step: 'Worker a iniciar processamento e validação de dados...',
      detail: `${buffers.length} ficheiro(s) em análise`,
    });

    // 1. Executa a importação interativa oficial
    const stats = await executeInteractiveImport(
      buffers,
      decisions || {},
      farmaciaId,
      prisma,
      (percent, step, detail) => {
        // Reduz escala de 0 a 85% para reservar os últimos 15% para a computação dos Marts
        const mappedPercent = Math.min(85, Math.round(percent * 0.85));
        updateIngestProgress(farmaciaId, {
          status: 'PROCESSING',
          percent: mappedPercent,
          step,
          detail,
        });
      }
    );

    // 2. Computa e atualiza os Marts analíticos imediatamente no fim da importação
    updateIngestProgress(farmaciaId, {
      status: 'PROCESSING',
      percent: 90,
      step: 'A recalcular tabelas analíticas (Marts) e VMM...',
      detail: 'A computar indicadores para navegação instantânea a 0ms',
    });

    await computeAndPersistMarts(prisma, farmaciaId);

    // 3. Notificar invalidação de caches
    if (onCacheInvalidate) {
      onCacheInvalidate(farmaciaId);
    }

    updateIngestProgress(farmaciaId, {
      status: 'COMPLETED',
      percent: 100,
      step: '🎉 Importação e Marts Concluídos com Sucesso!',
      detail: `Registos integrados: ${stats.totalInventarioAtivoAtualizado || 0} produtos stock, ${stats.totalVendasCriadas || 0} vendas.`,
      stats,
    });
  } catch (err: any) {
    updateIngestProgress(farmaciaId, {
      status: 'FAILED',
      percent: 100,
      step: '❌ Erro na importação',
      detail: err.message,
      error: err.message,
    });
    throw err;
  }
}
