import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
dotenv.config();

import { ensureDatabaseReady } from './db.js';
import { ToolSecurityContext } from './services/mcp_pharma_tools.js';
import { createPharmaMcpServer } from './services/mcp_server_factory.js';

// ============================================================================
// SERVIDOR MCP (MODEL CONTEXT PROTOCOL) — BI PHARMA (STDIO / LOCAL)
// ============================================================================

async function main() {
  const code = (process.env.PHARMACY_ACCESS_CODE || '').trim().toUpperCase();

  if (!code) {
    console.error('❌ [MCP SECURITY ERROR]: PHARMACY_ACCESS_CODE não fornecido nas variáveis de ambiente.');
    console.error('   O servidor MCP recusa-se a iniciar sem autenticação da farmácia.');
    process.exit(1);
  }

  const { prisma } = await ensureDatabaseReady();

  // Validação na base de dados
  const farmacia = await prisma.farmacia.findUnique({
    where: { codigo_acesso: code },
  });

  if (!farmacia) {
    console.error(`❌ [MCP SECURITY ERROR]: Código de acesso "${code}" inválido ou não autorizado.`);
    process.exit(1);
  }

  const secContext: ToolSecurityContext = {
    farmaciaId: farmacia.id,
    farmaciaNome: farmacia.nome,
    nif: farmacia.nif,
  };

  console.error(`🔐 [MCP SERVER ATIVO]: Sessão trancada à ${farmacia.nome} (NIF: ${farmacia.nif})`);

  const server = createPharmaMcpServer(prisma, secContext);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal MCP Error:', err);
  process.exit(1);
});
