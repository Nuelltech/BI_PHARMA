import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import vm from 'vm';
import {
  subscribeFarmaciaEvents,
  broadcastFarmaciaEvent,
  getFarmaciaSyncVersion,
  getActiveRealtimeClientsCount,
  clearAllRealtimeClientsForTests,
} from '../services/realtime_events';
import { getMobileStaffHtml } from '../views/mobile_staff_view';

function createMockReqRes() {
  const req: any = new EventEmitter();
  const chunks: string[] = [];
  const res: any = new EventEmitter();
  res.headers = {};
  res.statusCode = 0;
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    res.emit('close');
  };
  return { req, res, chunks };
}

describe('Realtime SSE Sync Hub (Multi-Tenant & Multi-Device)', () => {
  beforeEach(() => {
    clearAllRealtimeClientsForTests();
  });

  it('mantém múltiplos dispositivos da mesma farmácia ligados em simultâneo e isola tenants', () => {
    const deskA = createMockReqRes();
    const mobA1 = createMockReqRes();
    const mobA2 = createMockReqRes();
    const mobB = createMockReqRes();

    subscribeFarmaciaEvents('farm-A', deskA.req, deskA.res, { clientId: 'desk_1', channel: 'desktop' });
    subscribeFarmaciaEvents('farm-A', mobA1.req, mobA1.res, { clientId: 'mob_1', channel: 'mobile' });
    subscribeFarmaciaEvents('farm-A', mobA2.req, mobA2.res, { clientId: 'mob_2', channel: 'mobile' });
    subscribeFarmaciaEvents('farm-B', mobB.req, mobB.res, { clientId: 'mob_b1', channel: 'mobile' });

    expect(getActiveRealtimeClientsCount('farm-A')).toBe(3);
    expect(getActiveRealtimeClientsCount('farm-B')).toBe(1);
    expect(deskA.res.headers['X-Accel-Buffering']).toBe('no');
    expect(deskA.res.headers['Access-Control-Allow-Origin']).toBeUndefined();

    const result = broadcastFarmaciaEvent('farm-A', {
      type: 'TOGGLE',
      taskId: 'val_123',
      concluido: true,
      concluido_por: 'Maria',
      actorClientId: 'mob_1',
    });

    expect(result.delivered).toBe(3);
    expect(result.version).toBe(1);
    expect(getFarmaciaSyncVersion('farm-A')).toBe(1);
    expect(getFarmaciaSyncVersion('farm-B')).toBe(0);

    // Todos os 3 dispositivos de farm-A receberam o evento
    expect(deskA.chunks.some((c) => c.includes('"taskId":"val_123"'))).toBe(true);
    expect(mobA1.chunks.some((c) => c.includes('"taskId":"val_123"'))).toBe(true);
    expect(mobA2.chunks.some((c) => c.includes('"taskId":"val_123"'))).toBe(true);

    // farm-B NÃO recebeu nada de farm-A
    expect(mobB.chunks.some((c) => c.includes('val_123'))).toBe(false);
  });

  it('substitui apenas o mesmo clientId em reconexão e limpa ao fechar', () => {
    const c1Old = createMockReqRes();
    const c2 = createMockReqRes();
    const c1New = createMockReqRes();

    subscribeFarmaciaEvents('farm-A', c1Old.req, c1Old.res, { clientId: 'mob_1', channel: 'mobile' });
    subscribeFarmaciaEvents('farm-A', c2.req, c2.res, { clientId: 'mob_2', channel: 'mobile' });
    expect(getActiveRealtimeClientsCount('farm-A')).toBe(2);

    // Reconexão do mob_1 substitui apenas c1Old, mantendo c2 ativo
    subscribeFarmaciaEvents('farm-A', c1New.req, c1New.res, { clientId: 'mob_1', channel: 'mobile' });
    expect(c1Old.res.writableEnded).toBe(true);
    expect(c2.res.writableEnded).toBe(false);
    expect(getActiveRealtimeClientsCount('farm-A')).toBe(2);

    // Fecho do mob_2 remove-o
    c2.req.emit('close');
    expect(getActiveRealtimeClientsCount('farm-A')).toBe(1);
  });

  it('valida sintaxe JS de todos os blocos <script> da App Mobile (mobile_staff_view.ts)', () => {
    const html = getMobileStaffHtml();
    const scriptMatches = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));
    expect(scriptMatches.length).toBeGreaterThan(0);
    for (const m of scriptMatches) {
      const code = m[1].trim();
      if (!code) continue;
      expect(() => new vm.Script(code)).not.toThrow();
    }
  });
});
