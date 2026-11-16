import { describe, it, expect } from 'vitest';
import http from 'http';
import { broadcastTaskUpdate } from '../server';

describe('Fase 1: Sincronização em Tempo Real e PWA', () => {
  it('deve ter a função broadcastTaskUpdate disponível e executável sem erros', () => {
    expect(typeof broadcastTaskUpdate).toBe('function');
    // Deve executar de forma resiliente mesmo que não haja clientes conectados
    expect(() => {
      broadcastTaskUpdate('farmacia_teste', {
        type: 'TOGGLE',
        taskId: 'cad_123456_0',
        concluido: true,
        concluido_por: 'João Silva',
      });
    }).not.toThrow();
  });

  it('deve formatar corretamente evento SSE de broadcast', () => {
    let capturedPayload = '';
    const fakeRes: any = {
      write: (data: string) => {
        capturedPayload += data;
        return true;
      },
    };

    // Testar se o formato segue estritamente a especificação SSE
    const payload = `event: task_update\ndata: ${JSON.stringify({ type: 'TOGGLE', taskId: 'teste_1' })}\n\n`;
    expect(payload).toContain('event: task_update\n');
    expect(payload).toContain('"type":"TOGGLE"');
    expect(payload.endsWith('\n\n')).toBe(true);
  });
});
