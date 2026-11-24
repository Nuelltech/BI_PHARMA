import { describe, it, expect } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPharmaMcpServer } from '../services/mcp_server_factory';

describe('MCP Streamable HTTP Handshake (Claude Web)', () => {
  it('completes initialize -> notifications/initialized -> tools/list -> DELETE cleanly', async () => {
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const server = http.createServer(async (req, res) => {
      const sid = String(req.headers['mcp-session-id'] || '');
      if (sid && sessions.has(sid)) {
        await sessions.get(sid)!.handleRequest(req, res);
        return;
      }

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });

      const mcp = createPharmaMcpServer({} as any, {
        farmaciaId: 'farm-test',
        farmaciaNome: 'Farmácia Teste',
        nif: '000000000',
      });

      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const url = `http://127.0.0.1:${port}/mcp`;

    try {
      // 1. initialize
      const r1 = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'claude-web-sim', version: '1.0' },
          },
        }),
      });
      expect(r1.status).toBe(200);
      const sid = r1.headers.get('mcp-session-id');
      expect(sid).toBeTruthy();
      const j1: any = await r1.json();
      expect(j1?.result?.serverInfo?.name).toBeTruthy();

      // 2. notifications/initialized
      const r2 = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sid!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(r2.status).toBe(202);

      // 3. tools/list
      const r3 = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sid!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(r3.status).toBe(200);
      const j3: any = await r3.json();
      expect(Array.isArray(j3?.result?.tools)).toBe(true);
      expect(j3.result.tools.length).toBeGreaterThan(5);

      // 4. DELETE session
      const r4 = await fetch(url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': sid! },
      });
      expect([200, 204]).toContain(r4.status);
      expect(sessions.size).toBe(0);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
