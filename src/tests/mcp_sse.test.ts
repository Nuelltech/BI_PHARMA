import { describe, it, expect } from 'vitest';
import http from 'http';

describe('MCP SSE Remote Server Endpoint', () => {
  it('deve ter o módulo createPharmaMcpServer funcional', async () => {
    const { createPharmaMcpServer } = await import('../services/mcp_server_factory.js');
    expect(createPharmaMcpServer).toBeDefined();

    const mockPrisma: any = {};
    const mockSecContext = {
      farmaciaId: 'farm-123',
      farmaciaNome: 'Farmácia de Teste',
      nif: '500123456',
    };

    const server = createPharmaMcpServer(mockPrisma, mockSecContext);
    expect(server).toBeDefined();
  });
});
