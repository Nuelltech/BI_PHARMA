import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

export type CopilotEtapaTipo =
  | 'interpretacao'
  | 'ferramenta'
  | 'validacao_dados'
  | 'leitura'
  | 'validacao_texto'
  | 'reescrita'
  | 'renderizacao'
  | 'entrega';

export type CopilotInteracaoEstado =
  | 'ok'
  | 'ok_com_correcoes'
  | 'so_tabelas'
  | 'bloqueado_dados'
  | 'erro_api'
  | 'erro_interno';

export interface CopilotEtapaRecord {
  ordem: number;
  etapa: CopilotEtapaTipo;
  nome?: string | null;
  inicio_ms: number;
  duracao_ms: number;
  estado: 'ok' | 'aviso' | 'falha';
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_cache_write?: number | null;
  tokens_cache_read?: number | null;
  custo_eur?: number | null;
  detalhe?: Record<string, any> | null;
}

// Cache em memória leve para detetar perguntas repetidas em < 10 min sem latência de BD
const recentQuestionsCache = new Map<string, Array<{ qNorm: string; ts: number }>>();

function normalizeQuestionForRepeat(q: string): string {
  return (q || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkAndRecordRepeat10Min(key: string, question: string): boolean {
  const now = Date.now();
  const qNorm = normalizeQuestionForRepeat(question);
  if (!qNorm) return false;

  const list = (recentQuestionsCache.get(key) || []).filter((item) => now - item.ts < 10 * 60 * 1000);
  const isRepeat = list.some((item) => item.qNorm === qNorm);
  list.push({ qNorm, ts: now });
  if (list.length > 20) list.shift();
  recentQuestionsCache.set(key, list);
  return isRepeat;
}

export class CopilotAuditTracer {
  public readonly interacaoId: string;
  public readonly startTime: number;
  public readonly repetida10min: boolean;
  private readonly farmaciaId: string;
  private readonly etapas: CopilotEtapaRecord[] = [];
  private regrasFalhadasSet = new Set<string>();
  public frasesRemovidas = 0;
  public reescritas = 0;
  public nChamadasApi = 0;
  public escalouSonnet = false;

  constructor(farmaciaId: string, sessionId: string, question: string, utilizadorId?: string | null) {
    this.interacaoId = crypto.randomUUID();
    this.startTime = Date.now();
    this.farmaciaId = farmaciaId;
    const repeatKey = `${farmaciaId}:${utilizadorId || sessionId}`;
    this.repetida10min = checkAndRecordRepeat10Min(repeatKey, question);
  }

  public addEtapa(entry: Omit<CopilotEtapaRecord, 'ordem'>): void {
    this.etapas.push({
      ...entry,
      ordem: this.etapas.length + 1,
      inicio_ms: Math.max(0, Math.round(entry.inicio_ms)),
      duracao_ms: Math.max(0, Math.round(entry.duracao_ms)),
    });
  }

  public markRuleFailed(ruleCode: string): void {
    if (ruleCode) this.regrasFalhadasSet.add(ruleCode);
  }

  public getRegrasFalhadas(): string[] {
    return Array.from(this.regrasFalhadasSet);
  }

  public getEtapas(): CopilotEtapaRecord[] {
    return [...this.etapas];
  }

  /**
   * Gravação assíncrona fire-and-forget (um único insert em lote com nested create).
   * Nunca bloqueia nem afeta a resposta ao utilizador.
   */
  public persistAsync(
    prisma: PrismaClient,
    payload: {
      utilizadorId?: string | null;
      perfil?: string | null;
      sessionId: string;
      modo?: string | null;
      pergunta: string;
      intencao?: string | null;
      parametros?: Record<string, any> | null;
      pergunta_de_volta?: boolean;
      texto_referencias?: string | null;
      texto_final?: string | null;
      estado: CopilotInteracaoEstado;
      erro_codigo?: string | null;
      erro_mensagem?: string | null;
      modelo_final?: string | null;
      tokens_in?: number;
      tokens_out?: number;
      tokens_cache_write?: number;
      tokens_cache_read?: number;
      custo_eur?: number;
      duracao_ms?: number;
    }
  ): void {
    const duracaoTotal = payload.duracao_ms ?? Date.now() - this.startTime;
    const regras = this.getRegrasFalhadas();

    // Regista etapa final de entrega
    this.addEtapa({
      etapa: 'entrega',
      nome: payload.estado,
      inicio_ms: duracaoTotal,
      duracao_ms: 0,
      estado: payload.estado === 'ok' ? 'ok' : payload.estado === 'ok_com_correcoes' ? 'aviso' : 'falha',
      detalhe: {
        estado_final: payload.estado,
        regras_falhadas: regras,
        reescritas: this.reescritas,
        frases_removidas: this.frasesRemovidas,
      },
    });

    const etapasData = this.etapas.map((e) => ({
      farmaciaId: this.farmaciaId,
      ordem: e.ordem,
      etapa: e.etapa,
      nome: e.nome ?? null,
      inicio_ms: e.inicio_ms,
      duracao_ms: e.duracao_ms,
      estado: e.estado,
      tokens_in: e.tokens_in ?? null,
      tokens_out: e.tokens_out ?? null,
      tokens_cache_write: e.tokens_cache_write ?? null,
      tokens_cache_read: e.tokens_cache_read ?? null,
      custo_eur: e.custo_eur ?? null,
      detalhe: e.detalhe ? (e.detalhe as any) : undefined,
    }));

    prisma.copilotInteracao
      .create({
        data: {
          id: this.interacaoId,
          farmaciaId: this.farmaciaId,
          utilizadorId: payload.utilizadorId ?? null,
          perfil: payload.perfil ?? null,
          sessionId: payload.sessionId,
          modo: payload.modo ?? null,
          pergunta: payload.pergunta ? payload.pergunta.slice(0, 4000) : null,
          intencao: payload.intencao ?? null,
          parametros: payload.parametros ? (payload.parametros as any) : undefined,
          pergunta_de_volta: Boolean(payload.pergunta_de_volta),
          texto_referencias: payload.texto_referencias ?? null,
          texto_final: payload.texto_final ?? null,
          estado: payload.estado,
          erro_codigo: payload.erro_codigo ?? null,
          erro_mensagem: payload.erro_mensagem ?? null,
          modelo_final: payload.modelo_final ?? null,
          escalou_sonnet: this.escalouSonnet,
          n_chamadas_api: this.nChamadasApi,
          tokens_in: payload.tokens_in ?? 0,
          tokens_out: payload.tokens_out ?? 0,
          tokens_cache_write: payload.tokens_cache_write ?? 0,
          tokens_cache_read: payload.tokens_cache_read ?? 0,
          custo_eur: payload.custo_eur ?? 0,
          duracao_ms: duracaoTotal,
          frases_removidas: this.frasesRemovidas,
          reescritas: this.reescritas,
          regras_falhadas: regras,
          repetida_10min: this.repetida10min,
          etapas: {
            create: etapasData,
          },
        },
      })
      .catch((err: any) => {
        console.error('[CopilotAudit] Falha assíncrona ao gravar CopilotInteracao:', err?.message || err);
      });
  }
}

/**
 * Grava o feedback do utilizador (1 = 👍, -1 = 👎) associado à CopilotInteracao.
 */
export async function recordCopilotFeedback(
  prisma: PrismaClient,
  params: {
    interacaoId?: string | null;
    farmaciaId: string;
    sessionId?: string | null;
    feedback: number; // 1 ou -1
    comentario?: string | null;
  }
): Promise<{ ok: boolean; interacaoId?: string }> {
  const vote = params.feedback > 0 ? 1 : -1;
  const comment = params.comentario ? String(params.comentario).slice(0, 1000) : null;

  if (params.interacaoId) {
    const updated = await prisma.copilotInteracao.updateMany({
      where: { id: params.interacaoId, farmaciaId: params.farmaciaId },
      data: { feedback: vote, feedback_comentario: comment },
    });
    if (updated.count > 0) {
      return { ok: true, interacaoId: params.interacaoId };
    }
  }

  // Fallback: associa à interação mais recente desta farmácia/sessão
  const latest = await prisma.copilotInteracao.findFirst({
    where: {
      farmaciaId: params.farmaciaId,
      ...(params.sessionId ? { sessionId: { contains: params.sessionId } } : {}),
    },
    orderBy: { criadoEm: 'desc' },
    select: { id: true },
  });

  if (latest) {
    await prisma.copilotInteracao.update({
      where: { id: latest.id },
      data: { feedback: vote, feedback_comentario: comment },
    });
    return { ok: true, interacaoId: latest.id };
  }

  return { ok: false };
}
