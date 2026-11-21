/**
 * Adaptador de Rotas Legadas para Fastify (Spec v2.1 Secção 17 & Fase 1)
 *
 * Mapeia 100% das rotas legadas do sistema para a tabela declarativa do Fastify:
 * - Toda a rota antiga é declarada com o seu nível de acesso ('PUBLIC', 'AUTHENTICATED', 'PERMISSION', 'SUPERADMIN')
 * - O Fastify atua como porta de entrada única (Single Point of Entry)
 * - Hooks de Tenant, CSRF e Headers de Segurança correm antes do handler legado
 * - Respostas longas e SSE usam reply.hijack() + reply.raw garantindo streaming sem quebras
 */

import type http from 'http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DeclaredRoute, RouteAccessRule } from './app_fastify';

export interface LegacyRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  rule: RouteAccessRule;
}

export const LEGACY_ROUTES: LegacyRouteDefinition[] = [
  // 1. Páginas HTML e Assets Públicos
  { method: 'GET', url: '/', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/index.html', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/equipa', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/mobile', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/tarefas-mobile', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/sw.js', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/manifest.json', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/manifest.webmanifest', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/icons/icon-192.png', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/icons/icon-512.png', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/icons/icon.svg', rule: { access: 'PUBLIC' } },

  // 2. Auth Legada & Recuperação
  { method: 'GET', url: '/api/auth/verify', rule: { access: 'AUTHENTICATED' } },

  // 3. Mobile Balcão (PIN)
  { method: 'POST', url: '/api/mobile/change-pin', rule: { access: 'AUTHENTICATED' } },

  // 4. Admin / Importação / FinOps
  { method: 'GET', url: '/api/admin/avenida-files', rule: { access: 'SUPERADMIN' } },
  { method: 'GET', url: '/api/admin/copilot-finops', rule: { access: 'SUPERADMIN' } },
  { method: 'POST', url: '/api/admin/execute-import', rule: { access: 'PERMISSION', permissao: 'importar_dados' } },
  { method: 'POST', url: '/api/admin/import-pharmacy', rule: { access: 'PERMISSION', permissao: 'importar_dados' } },
  { method: 'GET', url: '/api/admin/import-progress', rule: { access: 'PERMISSION', permissao: 'importar_dados' } },
  { method: 'GET', url: '/api/admin/inspect-import', rule: { access: 'PERMISSION', permissao: 'importar_dados' } },
  { method: 'POST', url: '/api/admin/update-pharmacy', rule: { access: 'SUPERADMIN' } },

  // 5. Gestão de Equipa & Sessões (gerir_equipa_dispositivos)
  { method: 'GET', url: '/api/settings/team', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/settings/team/invite', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/settings/team/update', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/settings/team/delete', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'GET', url: '/api/settings/sessions', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/settings/sessions/revoke', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },

  // 6. Inventário, Análise e Comercial
  { method: 'GET', url: '/api/pharmacies', rule: { access: 'AUTHENTICATED' } },
  { method: 'GET', url: '/api/analysis', rule: { access: 'PERMISSION', permissao: 'ver_stock_validades' } },
  { method: 'GET', url: '/api/analytics/aims', rule: { access: 'PERMISSION', permissao: 'ver_faturacao' } },
  { method: 'GET', url: '/api/analytics/labs', rule: { access: 'PERMISSION', permissao: 'ver_faturacao' } },
  { method: 'GET', url: '/api/analytics/stock-evolution', rule: { access: 'PERMISSION', permissao: 'ver_stock_validades' } },
  { method: 'GET', url: '/api/product/:cnp', rule: { access: 'PERMISSION', permissao: 'ver_stock_validades' } },
  { method: 'POST', url: '/api/products/discontinue', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'POST', url: '/api/campaigns/generate', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'GET', url: '/api/campaigns/active', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'POST', url: '/api/campaigns/activate', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'POST', url: '/api/campaigns/deactivate', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'POST', url: '/api/campaigns/custom', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'GET', url: '/api/campaigns/search-products', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'GET', url: '/api/campaigns/product-360', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'POST', url: '/api/campaigns/send-email', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'GET', url: '/api/campaigns/smart-baskets', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'GET', url: '/api/campaigns/suggestions', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'GET', url: '/api/packs', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'POST', url: '/api/packs/save', rule: { access: 'PERMISSION', permissao: 'gerir_campanhas_tarefas' } },
  { method: 'POST', url: '/api/packs/approve', rule: { access: 'PUBLIC' } },
  { method: 'POST', url: '/api/packs/reject', rule: { access: 'PUBLIC' } },
  { method: 'POST', url: '/api/packs/deactivate', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/api/groups/summary', rule: { access: 'PERMISSION', permissao: 'ver_faturacao', allowGroup: true } },
  { method: 'POST', url: '/api/groups/rebalance', rule: { access: 'PERMISSION', permissao: 'gerir_compras', allowGroup: true } },

  // 7. Tarefas Semanais (inclui SSE em /api/weekly-tasks/stream)
  { method: 'GET', url: '/api/weekly-tasks', rule: { access: 'PERMISSION', permissao: 'ver_stock_validades' } },
  { method: 'POST', url: '/api/weekly-tasks/toggle', rule: { access: 'PERMISSION', permissao: 'ver_stock_validades' } },
  { method: 'POST', url: '/api/weekly-tasks/reset', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'GET', url: '/api/weekly-tasks/audit', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'GET', url: '/api/weekly-tasks/stream', rule: { access: 'PERMISSION', permissao: 'ver_stock_validades' } },
  { method: 'POST', url: '/api/weekly-plan/apply', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },

  // 8. Copilot Conversacional
  { method: 'POST', url: '/api/copilot', rule: { access: 'PERMISSION', permissao: 'usar_copilot' } },
  { method: 'POST', url: '/api/copilot/clear', rule: { access: 'PERMISSION', permissao: 'usar_copilot' } },
  { method: 'POST', url: '/api/copilot/feedback', rule: { access: 'PERMISSION', permissao: 'usar_copilot' } },
  { method: 'POST', url: '/api/ask', rule: { access: 'PERMISSION', permissao: 'usar_copilot' } },

  // 9. MCP Protocol & OAuth Metadata (Autenticação RFC Bearer Própria)
  { method: 'GET', url: '/.well-known/oauth-authorization-server', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/.well-known/oauth-protected-resource', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/.well-known/oauth-protected-resource/mcp', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/.well-known/openid-configuration', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/oauth/authorize', rule: { access: 'PUBLIC' } },
  { method: 'POST', url: '/oauth/token', rule: { access: 'PUBLIC' } },
  { method: 'POST', url: '/oauth/register', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/oauth/jwks', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/mcp', rule: { access: 'PUBLIC' } },
  { method: 'POST', url: '/mcp/messages', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/mcp/sse', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/sse', rule: { access: 'PUBLIC' } },
  { method: 'POST', url: '/sse/messages', rule: { access: 'PUBLIC' } },
  { method: 'GET', url: '/api/mcp/governance', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/mcp/governance/connectors/create', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/mcp/governance/connectors/toggle', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/mcp/governance/connectors/delete', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/mcp/governance/sessions/disconnect', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
  { method: 'POST', url: '/api/mcp/governance/toggle-global', rule: { access: 'PERMISSION', permissao: 'gerir_equipa_dispositivos' } },
];

export type LegacyRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => Promise<void> | void;

/**
 * Regista todas as rotas legadas no Fastify com adaptação transparente para Node HTTP.
 */
export function registerLegacyRoutes(
  app: FastifyInstance,
  declareRoute: (r: DeclaredRoute) => void,
  legacyHandler: LegacyRequestHandler
): void {
  for (const r of LEGACY_ROUTES) {
    declareRoute({ method: r.method, url: r.url, rule: r.rule });

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      // Anexa o body pré-analisado pelo Fastify no raw req para handlers que esperam body
      (req.raw as any).body = req.body;
      (req.raw as any).authCtx = req.authCtx;
      // reply.hijack() entrega o controlo do socket e da stream para o handler legado (vital para SSE)
      reply.hijack();
      await legacyHandler(req.raw, reply.raw);
    };

    switch (r.method) {
      case 'GET':
        app.get(r.url, handler);
        break;
      case 'POST':
        app.post(r.url, handler);
        break;
      case 'PUT':
        app.put(r.url, handler);
        break;
      case 'DELETE':
        app.delete(r.url, handler);
        break;
      case 'PATCH':
        app.patch(r.url, handler);
        break;
    }
  }
}
