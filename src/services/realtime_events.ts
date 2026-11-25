import http from 'http';

export type RealtimeEventType =
  | 'TOGGLE'
  | 'RESET'
  | 'CUSTOM_REFRESH'
  | 'CAMPAIGNS_CHANGED'
  | 'DATA_IMPORTED';

export interface RealtimeEventPayload {
  type: RealtimeEventType;
  farmaciaId?: string;
  taskId?: string;
  concluido?: boolean;
  concluido_por?: string;
  concluido_em?: string;
  categoria?: string;
  cnp_codigo?: string;
  designacao?: string;
  valor_impacto?: number;
  titulo?: string;
  actor?: string;
  actorClientId?: string;
  version?: number;
  ts?: number;
}

export interface RealtimeClient {
  id: string;
  farmaciaId: string;
  res: http.ServerResponse;
  channel: 'desktop' | 'mobile';
  connectedAt: number;
}

const MAX_CLIENTS_PER_FARMACIA = 60;
const HEARTBEAT_INTERVAL_MS = 20_000;

const clientsByFarmacia = new Map<string, Set<RealtimeClient>>();
const versionByFarmacia = new Map<string, number>();

let heartbeatTimer: NodeJS.Timeout | null = null;

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const comment = `: keepalive ${Date.now()}\n\n`;
    for (const [farmaciaId, set] of clientsByFarmacia.entries()) {
      for (const client of Array.from(set)) {
        try {
          if (client.res.writableEnded || client.res.destroyed) {
            set.delete(client);
            continue;
          }
          client.res.write(comment);
        } catch {
          set.delete(client);
        }
      }
      if (set.size === 0) {
        clientsByFarmacia.delete(farmaciaId);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

export function getFarmaciaSyncVersion(farmaciaId: string): number {
  if (!farmaciaId) return 0;
  return versionByFarmacia.get(farmaciaId) || 0;
}

export function getActiveRealtimeClientsCount(farmaciaId?: string): number {
  if (farmaciaId) {
    return clientsByFarmacia.get(farmaciaId)?.size || 0;
  }
  let total = 0;
  for (const set of clientsByFarmacia.values()) {
    total += set.size;
  }
  return total;
}

export function subscribeFarmaciaEvents(
  farmaciaId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts?: { clientId?: string; channel?: 'desktop' | 'mobile' }
): RealtimeClient {
  ensureHeartbeat();

  const clientId =
    (opts?.clientId || '').trim().slice(0, 64) ||
    `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const channel: 'desktop' | 'mobile' = opts?.channel === 'mobile' ? 'mobile' : 'desktop';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let set = clientsByFarmacia.get(farmaciaId);
  if (!set) {
    set = new Set<RealtimeClient>();
    clientsByFarmacia.set(farmaciaId, set);
  }

  // Substitui apenas uma ligação órfã com o MESMO clientId (nunca por IP — vários
  // dispositivos na mesma farmácia partilham o mesmo IP público Wi-Fi).
  for (const existing of Array.from(set)) {
    if (existing.id === clientId) {
      try {
        existing.res.end();
      } catch {}
      set.delete(existing);
    }
  }

  // Limite de segurança por farmácia (evita leak de sockets)
  if (set.size >= MAX_CLIENTS_PER_FARMACIA) {
    let oldest: RealtimeClient | null = null;
    for (const c of set) {
      if (!oldest || c.connectedAt < oldest.connectedAt) oldest = c;
    }
    if (oldest) {
      try {
        oldest.res.end();
      } catch {}
      set.delete(oldest);
    }
  }

  const client: RealtimeClient = {
    id: clientId,
    farmaciaId,
    res,
    channel,
    connectedAt: Date.now(),
  };
  set.add(client);

  const version = getFarmaciaSyncVersion(farmaciaId);
  try {
    res.write(
      `event: connected\ndata: ${JSON.stringify({
        farmaciaId,
        clientId,
        channel,
        version,
        ts: Date.now(),
      })}\n\n`
    );
  } catch {
    set.delete(client);
  }

  const cleanup = () => {
    const currentSet = clientsByFarmacia.get(farmaciaId);
    if (currentSet) {
      currentSet.delete(client);
      if (currentSet.size === 0) {
        clientsByFarmacia.delete(farmaciaId);
      }
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  return client;
}

export function broadcastFarmaciaEvent(
  farmaciaId: string,
  eventData: RealtimeEventPayload
): { delivered: number; version: number } {
  if (!farmaciaId) return { delivered: 0, version: 0 };

  const nextVersion = (versionByFarmacia.get(farmaciaId) || 0) + 1;
  versionByFarmacia.set(farmaciaId, nextVersion);

  const enriched: RealtimeEventPayload = {
    ...eventData,
    farmaciaId,
    version: nextVersion,
    ts: Date.now(),
  };

  const set = clientsByFarmacia.get(farmaciaId);
  if (!set || set.size === 0) {
    return { delivered: 0, version: nextVersion };
  }

  const payload = `event: task_update\ndata: ${JSON.stringify(enriched)}\n\n`;
  let delivered = 0;

  for (const client of Array.from(set)) {
    try {
      if (client.res.writableEnded || client.res.destroyed) {
        set.delete(client);
        continue;
      }
      client.res.write(payload);
      delivered++;
    } catch {
      set.delete(client);
    }
  }

  if (set.size === 0) {
    clientsByFarmacia.delete(farmaciaId);
  }

  return { delivered, version: nextVersion };
}

export function clearAllRealtimeClientsForTests(): void {
  for (const set of clientsByFarmacia.values()) {
    for (const c of set) {
      try {
        c.res.end();
      } catch {}
    }
  }
  clientsByFarmacia.clear();
  versionByFarmacia.clear();
}
