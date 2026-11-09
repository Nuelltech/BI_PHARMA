import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

export type McpPermissionProfile = 'COMPLETO' | 'GESTAO_COMPRAS' | 'BALCAO_CLINICO';

export interface McpAuthResult {
  allowed: boolean;
  reason?: 'MCP_DISABLED_BY_PHARMACY' | 'CONNECTOR_REVOKED' | 'INVALID_TOKEN' | 'FARMACIA_NOT_FOUND';
  farmacia?: {
    id: string;
    nome: string;
    nif: string;
    codigo_acesso: string | null;
  };
  connector?: {
    id: string;
    nome: string;
    token: string;
    agenteTipo: string;
    perfilPermissao: string;
    ativo: boolean;
  } | null;
  perfilPermissao: McpPermissionProfile;
}

const RESTRICTED_FINANCIAL_TOOLS = new Set([
  'analisar_evolucao_mensal_financeira',
  'comparar_performance_periodos',
  'calcular_perdas_financeiras_e_custo_oportunidade',
  'analisar_curva_abc_faturacao_e_margem',
  'auditar_anomalias_margem_e_precos',
  'avaliar_acordo_anual_compras_escalonadas',
]);

export function checkToolPermission(perfil: string, toolName: string): { allowed: boolean; reason?: string } {
  if (perfil === 'COMPLETO') {
    return { allowed: true };
  }

  if (perfil === 'BALCAO_CLINICO') {
    if (RESTRICTED_FINANCIAL_TOOLS.has(toolName)) {
      return {
        allowed: false,
        reason: `A ferramenta "${toolName}" contém dados financeiros confidenciais e requer permissão de Gestão ou Completa. O perfil atual deste conector é BALCÃO CLÍNICO.`,
      };
    }
    return { allowed: true };
  }

  if (perfil === 'GESTAO_COMPRAS') {
    if (toolName === 'auditar_anomalias_margem_e_precos') {
      return {
        allowed: false,
        reason: `A ferramenta "${toolName}" é restrita ao perfil de Direção Técnica Completo.`,
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

export async function resolveMcpAuthentication(
  prisma: PrismaClient,
  rawToken: string,
  clientInfo?: { ip?: string; userAgent?: string }
): Promise<McpAuthResult> {
  const token = (rawToken || '').trim();
  if (!token) {
    return { allowed: false, reason: 'INVALID_TOKEN', perfilPermissao: 'BALCAO_CLINICO' };
  }

  // 1. Verificar se é um token de conector específico (McpConnector)
  const connector = await prisma.mcpConnector.findUnique({
    where: { token },
    include: { farmacia: true },
  });

  if (connector) {
    if (!connector.farmacia.mcpPermitido) {
      return {
        allowed: false,
        reason: 'MCP_DISABLED_BY_PHARMACY',
        perfilPermissao: connector.perfilPermissao as McpPermissionProfile,
      };
    }

    if (!connector.ativo) {
      return {
        allowed: false,
        reason: 'CONNECTOR_REVOKED',
        perfilPermissao: connector.perfilPermissao as McpPermissionProfile,
      };
    }

    // Atualizar último acesso em background
    prisma.mcpConnector
      .update({
        where: { id: connector.id },
        data: {
          ultimoAcessoEm: new Date(),
          ultimoIp: clientInfo?.ip || connector.ultimoIp,
          ultimoUserAgent: clientInfo?.userAgent || connector.ultimoUserAgent,
        },
      })
      .catch(() => {});

    return {
      allowed: true,
      farmacia: {
        id: connector.farmacia.id,
        nome: connector.farmacia.nome,
        nif: connector.farmacia.nif,
        codigo_acesso: connector.farmacia.codigo_acesso,
      },
      connector: {
        id: connector.id,
        nome: connector.nome,
        token: connector.token,
        agenteTipo: connector.agenteTipo,
        perfilPermissao: connector.perfilPermissao,
        ativo: connector.ativo,
      },
      perfilPermissao: connector.perfilPermissao as McpPermissionProfile,
    };
  }

  // 2. Se não for token específico de conector, verificar se é o código mestre da farmácia
  const farmacia = await prisma.farmacia.findFirst({
    where: {
      codigo_acesso: {
        equals: token,
        mode: 'insensitive',
      },
    },
  });

  if (farmacia) {
    if (!farmacia.mcpPermitido) {
      return {
        allowed: false,
        reason: 'MCP_DISABLED_BY_PHARMACY',
        perfilPermissao: 'COMPLETO',
      };
    }

    return {
      allowed: true,
      farmacia: {
        id: farmacia.id,
        nome: farmacia.nome,
        nif: farmacia.nif,
        codigo_acesso: farmacia.codigo_acesso,
      },
      connector: null,
      perfilPermissao: 'COMPLETO',
    };
  }

  return { allowed: false, reason: 'INVALID_TOKEN', perfilPermissao: 'BALCAO_CLINICO' };
}

export async function recordMcpAuditLog(
  prisma: PrismaClient,
  data: {
    farmaciaId: string;
    connectorId?: string | null;
    ferramenta: string;
    parametros?: any;
    sucesso: boolean;
    duracaoMs?: number;
    ip?: string;
    userAgent?: string;
  }
) {
  try {
    let paramsStr: string | null = null;
    if (data.parametros) {
      try {
        paramsStr = typeof data.parametros === 'string' ? data.parametros : JSON.stringify(data.parametros);
        if (paramsStr.length > 4000) paramsStr = paramsStr.slice(0, 3997) + '...';
      } catch {}
    }

    await prisma.mcpAuditLog.create({
      data: {
        farmaciaId: data.farmaciaId,
        connectorId: data.connectorId || null,
        ferramenta: data.ferramenta,
        parametros: paramsStr,
        sucesso: data.sucesso,
        duracaoMs: data.duracaoMs,
        ip: data.ip,
        userAgent: data.userAgent ? data.userAgent.slice(0, 500) : null,
      },
    });

    if (data.connectorId) {
      await prisma.mcpConnector.update({
        where: { id: data.connectorId },
        data: {
          totalChamadas: { increment: 1 },
          ultimoAcessoEm: new Date(),
        },
      });
    }
  } catch (err) {
    console.error('Erro ao registar log de auditoria MCP:', err);
  }
}

export async function createMcpConnector(
  prisma: PrismaClient,
  farmaciaId: string,
  params: {
    nome: string;
    agenteTipo?: string;
    perfilPermissao?: McpPermissionProfile;
    criadoPor?: string;
  }
) {
  const tokenSuffix = crypto.randomBytes(8).toString('hex');
  const token = `mcp_live_${tokenSuffix}`;

  return await prisma.mcpConnector.create({
    data: {
      farmaciaId,
      nome: params.nome.trim(),
      token,
      agenteTipo: params.agenteTipo || 'CLAUDE_WEB',
      perfilPermissao: params.perfilPermissao || 'COMPLETO',
      criadoPor: params.criadoPor || 'DIRETOR',
      ativo: true,
    },
  });
}

export async function toggleMcpConnector(
  prisma: PrismaClient,
  connectorId: string,
  farmaciaId: string,
  ativo: boolean
) {
  return await prisma.mcpConnector.updateMany({
    where: { id: connectorId, farmaciaId },
    data: { ativo },
  });
}

export async function deleteMcpConnector(
  prisma: PrismaClient,
  connectorId: string,
  farmaciaId: string
) {
  return await prisma.mcpConnector.deleteMany({
    where: { id: connectorId, farmaciaId },
  });
}

export async function toggleGlobalMcpAccess(
  prisma: PrismaClient,
  farmaciaId: string,
  permitido: boolean
) {
  return await prisma.farmacia.update({
    where: { id: farmaciaId },
    data: { mcpPermitido: permitido },
  });
}

export async function getMcpGovernanceReport(
  prisma: PrismaClient,
  farmaciaId: string,
  activeSessions: Array<{
    sessionId: string;
    farmaciaId: string;
    connectorId?: string | null;
    connectorNome?: string | null;
    token: string;
    ip?: string;
    userAgent?: string;
    connectedAt: Date;
    lastActivity: Date;
    totalToolCalls: number;
  }>
) {
  const farmacia = await prisma.farmacia.findUnique({
    where: { id: farmaciaId },
    select: { id: true, nome: true, nif: true, codigo_acesso: true, mcpPermitido: true },
  });

  const conectores = await prisma.mcpConnector.findMany({
    where: { farmaciaId },
    orderBy: { criadoEm: 'desc' },
  });

  const sessoesAtivas = activeSessions.filter((s) => s.farmaciaId === farmaciaId);

  const ultimosLogs = await prisma.mcpAuditLog.findMany({
    where: { farmaciaId },
    include: {
      connector: {
        select: { nome: true, agenteTipo: true },
      },
    },
    orderBy: { criadoEm: 'desc' },
    take: 50,
  });

  return {
    farmacia,
    mcpPermitido: farmacia?.mcpPermitido ?? true,
    totalConectoresRegistados: conectores.length,
    totalSessoesAtivasEmDireto: sessoesAtivas.length,
    sessoesAtivas: sessoesAtivas.map((s) => ({
      sessionId: s.sessionId,
      connectorNome: s.connectorNome || 'Código Mestre da Farmácia',
      tokenMasked: s.token.length > 8 ? `${s.token.slice(0, 6)}...${s.token.slice(-4)}` : s.token,
      ip: s.ip || 'Desconhecido',
      userAgent: s.userAgent || 'Desconhecido',
      connectedAt: s.connectedAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      totalToolCalls: s.totalToolCalls,
    })),
    conectores: conectores.map((c) => ({
      id: c.id,
      nome: c.nome,
      token: c.token,
      tokenMasked: `${c.token.slice(0, 8)}...${c.token.slice(-4)}`,
      agenteTipo: c.agenteTipo,
      perfilPermissao: c.perfilPermissao,
      ativo: c.ativo,
      criadoPor: c.criadoPor,
      ultimoAcessoEm: c.ultimoAcessoEm ? c.ultimoAcessoEm.toISOString() : null,
      ultimoIp: c.ultimoIp,
      totalChamadas: c.totalChamadas,
      criadoEm: c.criadoEm.toISOString(),
    })),
    auditLogs: ultimosLogs.map((log) => ({
      id: log.id,
      ferramenta: log.ferramenta,
      connectorNome: log.connector?.nome || 'Código Mestre da Farmácia',
      agenteTipo: log.connector?.agenteTipo || 'MCP Client',
      parametros: log.parametros,
      sucesso: log.sucesso,
      duracaoMs: log.duracaoMs,
      ip: log.ip,
      criadoEm: log.criadoEm.toISOString(),
    })),
  };
}
