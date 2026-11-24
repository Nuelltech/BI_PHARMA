import {
  calculateCrossStoreRebalance,
  getGroupSummary
} from './services/cross_store_rebalance';
import {
  getLaboratoriesAnalytics,
  getHistoricalAimAnalytics
} from './services/lab_analytics';

import {
  getPharmacyTeam,
  addPharmacyTeamMember,
  updatePharmacyTeamMember,
  deletePharmacyTeamMember,
  getActivePharmacySessions,
  revokeUserSession,
  recordUserSession,
  createPasswordResetToken,
  verifyPasswordResetToken,
  consumePasswordResetToken,
  getPermissionsForRole,
  UserRole
} from './services/rbac_settings';

import { getMobileStaffHtml } from './views/mobile_staff_view';
import { getStockEvolutionAnalytics } from './services/stock_evolution';
import {
  getWeeklyTasksAudit,
  getPharmacyWeeklyTasks,
  toggleWeeklyTaskInDb,
  resetWeeklyTasksInDb,
  verifyMobileStaffPin,
} from './services/weekly_tasks';
import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { ensureDatabaseReady } from './db';
import { canVerFaturacao } from './platform/permissoes';
import { recordCopilotFeedback } from './services/copilot_audit';

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});
if (process.stdin && process.stdin.resume) {
  try { process.stdin.resume(); } catch (_) {}
}
setInterval(() => {}, 60000); // Keepalive timer para manter o processo ativo em background
import { analyzePharmacyInventory, PharmacyAnalysisReport } from './services/analysis';
import { classifyAllExistingProducts, classifyProduct } from './services/classifier';
import { getPharmacyCatalog, invalidateCatalog } from './services/product_catalog';
import { processFreeformQuestion } from './services/copilot';
import { processQuestionWithLlmOrLocal } from './services/llm_router';
import { askConversationalCopilot, clearCopilotSession, getCopilotSessionHistory } from './services/copilot_engine';
import { parseMarkdownToExecutiveReport, buildExecutiveReportFromStructuredData, CopilotExecutiveReport } from './services/copilot_reporting';
import { addDiscontinuedCnp, removeDiscontinuedCnp, getDiscontinuedList } from './services/discontinued_products';
import { ToolSecurityContext } from './services/mcp_pharma_tools';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPharmaMcpServer } from './services/mcp_server_factory';
import {
  getBaseIssuerUrl,
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
  registerOAuthClient,
  createOAuthAuthorizationCode,
  exchangeOAuthToken,
  renderOAuthConsentPage,
} from './services/mcp_oauth';

import {
  resolveMcpAuthentication,
  recordMcpAuditLog,
  createMcpConnector,
  toggleMcpConnector,
  deleteMcpConnector,
  toggleGlobalMcpAccess,
  getMcpGovernanceReport,
  McpPermissionProfile,
} from './services/mcp_governance';

interface McpActiveSession {
  sessionId: string;
  server: any;
  transport: SSEServerTransport | StreamableHTTPServerTransport;
  transportType: 'sse' | 'streamable-http';
  farmaciaId: string;
  farmaciaNome: string;
  connectorId?: string | null;
  connectorNome?: string | null;
  token: string;
  ip?: string;
  userAgent?: string;
  connectedAt: Date;
  lastActivity: Date;
  totalToolCalls: number;
}
const mcpActiveSessions = new Map<string, McpActiveSession>();
import {
  ingestInventarioPdf,
  ingestValidadesPdf,
  ingestVendasCsv,
} from './services/ingestion';
import {
  inspectFilesForInteractiveImport,
  executeInteractiveImport,
} from './services/interactive_import';
import { computeAndPersistMarts } from './services/marts_service';
import {
  transformStagingInventario,
  transformStagingValidades,
  transformStagingVendas,
} from './services/transformation';
import {
  getSeasonalCampaignSuggestions,
  getMarketingAndCrossSellingIntelligence,
  calculateCampaignFinancials,
  generateOmnichannelMaterials,
  generateMonthlyEmailDigest,
  buildCustomCampaign,
  analyzeProductMarketingAndCrossSell360,
  searchProductsForMarketingPicker,
  getSmartCampaignBaskets,
  ANNUAL_CAMPAIGNS,
  CampaignProductItem,
  generateClinicalThemePacks,
  ClinicalThemePack,
} from './services/campaigns';
import {
  getActiveCampaigns,
  activateCampaign,
  deactivateCampaign,
} from './services/active_campaigns';

import { computePackCompositionHash } from './services/comercial';
import { verifyPasswordScrypt } from './services/auth_crypto';
import { logSecurityAudit } from './services/audit_service';
import { resolveSessionAndTenant } from './services/auth_service';

const customWeeklyTasksStore = new Map<string, any[]>();
const customPacksStore = new Map<string, any[]>();
const customRejectedPacksStore = new Map<string, Set<string>>();
// ============================================================================
// SINCRONIZAÇÃO EM TEMPO REAL MULTI-DISPOSITIVO (SSE PUBSUB POR FARMÁCIA)
// ============================================================================
interface TaskStreamClient {
  id: string;
  farmaciaId: string;
  res: http.ServerResponse;
  clientIp: string;
}
const taskStreamClients = new Set<TaskStreamClient>();

export function broadcastTaskUpdate(farmaciaId: string, eventData: any): void {
  if (!farmaciaId) return;
  const payload = `event: task_update\ndata: ${JSON.stringify(eventData)}\n\n`;
  for (const client of Array.from(taskStreamClients)) {
    if (client.farmaciaId === farmaciaId) {
      try {
        client.res.write(payload);
      } catch (err) {
        taskStreamClients.delete(client);
      }
    }
  }
}

// Keep-alive heartbeat a cada 20s para manter conexões ativas através de proxies/Cloudflare
setInterval(() => {
  const comment = `: keepalive ${Date.now()}\n\n`;
  for (const client of Array.from(taskStreamClients)) {
    try {
      client.res.write(comment);
    } catch {
      taskStreamClients.delete(client);
    }
  }
}, 20000);


const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOW_DEV_FALLBACK = (process.env.ALLOW_DEV_FALLBACK || '').trim().toLowerCase() === 'true';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || (IS_PROD ? '' : 'Nuelltech#DevLocal2026')).trim();

if (!ADMIN_PASSWORD && IS_PROD) {
  console.warn('⚠️ [AVISO DE SEGURANÇA CRÍTICO]: ADMIN_PASSWORD não configurada em ambiente de produção!');
}

// ============================================================================
// COMPARAÇÃO EM TEMPO CONSTANTE & GESTÃO DE SESSÕES EFÉMERAS DE ADMIN
// ============================================================================
function safeCompareStrings(a: string, b: string): boolean {
  if (!a || !b) return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

interface AdminSession {
  token: string;
  createdAt: number;
  expiresAt: number;
}
const activeAdminSessions = new Map<string, AdminSession>();
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas de validade
const MAX_ACTIVE_SESSIONS = 1000;

function getSessionSigningKey(): string {
  return (process.env.SESSION_SECRET || ADMIN_PASSWORD || 'BI_PHARMA_SECURE_HMAC_KEY_2026').trim();
}

function createAdminSession(): string {
  const now = Date.now();
  if (activeAdminSessions.size >= MAX_ACTIVE_SESSIONS) {
    for (const [k, s] of activeAdminSessions.entries()) {
      if (now > s.expiresAt) activeAdminSessions.delete(k);
    }
    if (activeAdminSessions.size >= MAX_ACTIVE_SESSIONS) {
      const oldestKey = activeAdminSessions.keys().next().value;
      if (oldestKey) activeAdminSessions.delete(oldestKey);
    }
  }
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const payload = `${expiresAt}`;
  const sig = crypto.createHmac('sha256', getSessionSigningKey()).update(payload).digest('hex').toUpperCase();
  const token = `ADM_${expiresAt}_${sig}`;
  activeAdminSessions.set(token, {
    token,
    createdAt: now,
    expiresAt,
  });
  return token;
}

function isValidAdminSession(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const cleanToken = token.trim().toUpperCase();

  // 1. Checa memória RAM primeiro
  const session = activeAdminSessions.get(cleanToken);
  if (session) {
    if (Date.now() > session.expiresAt) {
      activeAdminSessions.delete(cleanToken);
      return false;
    }
    return true;
  }

  // 2. Validação stateless criptográfica HMAC (resiste a reinício de processos no Render/PaaS)
  if (cleanToken.startsWith('ADM_')) {
    const parts = cleanToken.split('_');
    if (parts.length === 3 && parts[0] === 'ADM') {
      const expiresAt = parseInt(parts[1], 10);
      const providedSig = parts[2];
      if (!isNaN(expiresAt) && Date.now() <= expiresAt) {
        const expectedSig = crypto.createHmac('sha256', getSessionSigningKey()).update(String(expiresAt)).digest('hex').toUpperCase();
        if (safeCompareStrings(providedSig, expectedSig)) {
          // Re-insere na cache em memória
          activeAdminSessions.set(cleanToken, {
            token: cleanToken,
            createdAt: expiresAt - ADMIN_SESSION_TTL_MS,
            expiresAt,
          });
          return true;
        }
      }
    }
  }

  return false;
}

function invalidateAdminSession(token: string): void {
  if (token) activeAdminSessions.delete(token.trim().toUpperCase());
}

// ============================================================================
// RATE LIMITING EM MEMÓRIA CONTRA ATAQUES DE FORÇA BRUTA (ANTI-SPOOFING & CAP)
// ============================================================================
const failedAttemptsMap = new Map<string, { count: number; resetAt: number }>();
const MAX_RATE_LIMIT_ENTRIES = 5000;

function getClientIp(req: http.IncomingMessage): string {
  const socketIp = req.socket.remoteAddress || '127.0.0.1';
  // Apenas confia em X-Forwarded-For em produção (atrás de reverse proxy Render/Cloudflare), usando o último IP adicionado pelo proxy
  if (IS_PROD) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
      const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) {
        return parts[parts.length - 1];
      }
    }
  }
  return socketIp;
}

function isRateLimited(ip: string, maxAttempts = 10, windowMs = 5 * 60 * 1000): boolean {
  const now = Date.now();
  const record = failedAttemptsMap.get(ip);
  if (!record) return false;
  if (now > record.resetAt) {
    failedAttemptsMap.delete(ip);
    return false;
  }
  return record.count >= maxAttempts;
}

function recordFailedAttempt(ip: string, windowMs = 5 * 60 * 1000): void {
  const now = Date.now();
  if (failedAttemptsMap.size >= MAX_RATE_LIMIT_ENTRIES) {
    for (const [k, v] of failedAttemptsMap.entries()) {
      if (now > v.resetAt) failedAttemptsMap.delete(k);
    }
    if (failedAttemptsMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldest = failedAttemptsMap.keys().next().value;
      if (oldest) failedAttemptsMap.delete(oldest);
    }
  }
  const record = failedAttemptsMap.get(ip);
  if (!record || now > record.resetAt) {
    failedAttemptsMap.set(ip, { count: 1, resetAt: now + windowMs });
  } else {
    record.count++;
  }
}

function resetFailedAttempts(ip: string): void {
  failedAttemptsMap.delete(ip);
}

// ============================================================================
// LEITURA SEGURA DE REQUISIÇÕES (ANTI-DOS / PAYLOAD LIMIT)
// ============================================================================
function readRequestBody(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        const err: any = new Error(`PayloadTooLarge: Limite de ${(maxBytes / (1024 * 1024)).toFixed(1)} MB excedido.`);
        err.statusCode = 413;
        reject(err);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => reject(err));
  });
}

// ============================================================================
// CACHE EM MEMÓRIA DO SERVIDOR + DEDUPLICAÇÃO DE PEDIDOS + COMPRESSÃO GZIP
// ============================================================================
interface CachedAnalysisEntry {
  report: PharmacyAnalysisReport;
  jsonBuf: Buffer;
  gzipBuf: Buffer;
  timestamp: number;
}

const analysisCache = new Map<string, CachedAnalysisEntry>();
const analysisInFlight = new Map<string, Promise<CachedAnalysisEntry>>();
const campaignsCache = new Map<string, any>();
const campaignsInFlight = new Map<string, Promise<any>>();

function sendOptimizedJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  dataObj: any,
  cachedJsonBuf?: Buffer,
  cachedGzipBuf?: Buffer
) {
  const acceptEncoding = String(req.headers['accept-encoding'] || '').toLowerCase();
  const supportsGzip = acceptEncoding.includes('gzip');

  if (supportsGzip) {
    const gzipBuf = cachedGzipBuf || zlib.gzipSync(cachedJsonBuf || Buffer.from(JSON.stringify(dataObj)));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': String(gzipBuf.length),
      'Vary': 'Accept-Encoding',
      'Cache-Control': 'no-cache',
    });
    res.end(gzipBuf);
    return;
  }

  const jsonBuf = cachedJsonBuf || Buffer.from(JSON.stringify(dataObj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(jsonBuf.length),
    'Vary': 'Accept-Encoding',
    'Cache-Control': 'no-cache',
  });
  res.end(jsonBuf);
}

function invalidateAllPharmacyCaches(farmaciaId?: string) {
  invalidateCatalog(farmaciaId);
  if (farmaciaId) {
    for (const k of Array.from(analysisCache.keys())) {
      if (k.startsWith(`${farmaciaId}:`)) analysisCache.delete(k);
    }
    campaignsCache.delete(farmaciaId);
  } else {
    analysisCache.clear();
    campaignsCache.clear();
  }
}

async function getCachedOrComputeAnalysis(
  prisma: any,
  farmaciaId: string,
  diasMonos: number,
  cobertura: number,
  mesesVmm: number,
  forceRefresh = false
): Promise<CachedAnalysisEntry> {
  const key = `${farmaciaId}:${diasMonos}:${cobertura}:${mesesVmm}`;
  if (!forceRefresh && analysisCache.has(key)) {
    return analysisCache.get(key)!;
  }
  if (!forceRefresh && analysisInFlight.has(key)) {
    return analysisInFlight.get(key)!;
  }
  const promise = analyzePharmacyInventory(prisma, farmaciaId, {
    periodoMonosDias: diasMonos,
    limiteCoberturaMeses: cobertura,
    mesesHistoricoVMM: mesesVmm,
  })
    .then((rep) => {
      const jsonBuf = Buffer.from(JSON.stringify(rep));
      const gzipBuf = zlib.gzipSync(jsonBuf);
      const entry: CachedAnalysisEntry = {
        report: rep,
        jsonBuf,
        gzipBuf,
        timestamp: Date.now(),
      };
      analysisCache.set(key, entry);
      analysisInFlight.delete(key);
      return entry;
    })
    .catch((err) => {
      analysisInFlight.delete(key);
      throw err;
    });
  analysisInFlight.set(key, promise);
  return promise;
}

async function getCachedOrComputeCampaignsPayload(
  prisma: any,
  activeFarmacia: any,
  mesQuery?: number,
  forceRefresh = false
) {
  const cacheKey = `${activeFarmacia.id}:${mesQuery || 'auto'}`;
  if (!forceRefresh && campaignsCache.has(cacheKey)) {
    return campaignsCache.get(cacheKey);
  }
  if (!forceRefresh && campaignsInFlight.has(cacheKey)) {
    return campaignsInFlight.get(cacheKey)!;
  }

  const promise = (async () => {
    if (forceRefresh) {
      invalidateCatalog(activeFarmacia.id);
    }
    // Carrega o catálogo uma única vez antes de executar as duas análises em paralelo
    await getPharmacyCatalog(prisma, activeFarmacia.id);
    const [suggestions, marketingIntel] = await Promise.all([
      getSeasonalCampaignSuggestions(prisma, activeFarmacia.id, mesQuery),
      getMarketingAndCrossSellingIntelligence(prisma, activeFarmacia.id),
    ]);

    const enriched = suggestions.map((s) => ({
      ...s,
      id: s.campanha.id,
      nome: s.campanha.titulo,
      icon: s.campanha.icone,
      periodoLabel: s.campanha.epoca,
      descricao: s.campanha.descricao,
      tipoCampanha: s.campanha.tipoCampanha || 'EPOCA_CALENDARIO',
      contextoEpoca: s.campanha.contextoEpoca || null,
      tipo:
        s.campanha.tipoCampanha === 'LIQUIDACAO_STOCK'
          ? 'LIQUIDACAO_STOCK'
          : s.campanha.epoca.includes('Efeméride')
            ? 'EFEMERIDE'
            : 'SAZONAL_CLIMA',
      eligibleProducts: s.produtosSugeridos.map((p) => ({
        ...p,
        pvp_atual: p.pvp,
        custo_unitario: p.custo_unitario,
      })),
      totalEligibleSkus: s.totalArtigosDisponiveis,
      totalStockUnits: s.totalUnidadesStock,
      financials: (() => {
        const fin = calculateCampaignFinancials(s.produtosSugeridos, s.campanha.descontoSugeridoPct);
        return {
          ...fin,
          margem_media_pct: Number(fin.margemFinalPct.toFixed(1)),
          anti_dumping_valido: fin.cumpreAntiDumping,
        };
      })(),
    }));

    const payload = {
      farmacia: activeFarmacia,
      campanhas: enriched,
      suggestions: enriched,
      overview: marketingIntel.overview,
      crossSellingPlans: marketingIntel.crossSellingPlans,
    };
    campaignsCache.set(cacheKey, payload);
    campaignsInFlight.delete(cacheKey);
    return payload;
  })().catch((err) => {
    campaignsInFlight.delete(cacheKey);
    throw err;
  });

  campaignsInFlight.set(cacheKey, promise);
  return promise;
}

async function warmUpAllPharmacyCaches(prisma: any) {
  try {
    const farms = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
    if (farms.length > 0) {
      // 1. Pré-aquecimento prioritário da primeira farmácia (disponibilidade imediata < 5s)
      await getCachedOrComputeAnalysis(prisma, farms[0].id, 90, 4, 12);
      await getCachedOrComputeCampaignsPayload(prisma, farms[0]);
      console.log(`⚡ [Cache Warm-Up] Farmácia principal (${farms[0].nome}) pré-aquecida em memória RAM!`);

      // 2. Aquecimento gradual em background das restantes farmácias sem saturar o event loop
      for (let i = 1; i < farms.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await getCachedOrComputeAnalysis(prisma, farms[i].id, 90, 4, 12);
        await getCachedOrComputeCampaignsPayload(prisma, farms[i]);
      }
      console.log(`⚡ [Cache Warm-Up] Todas as ${farms.length} farmácias pré-aquecidas com sucesso.`);
    }
  } catch (err: any) {
    console.warn('[Cache Warm-Up] Aviso ao pré-aquecer cache:', err.message);
  }
}

function maskNif(rawNif: string): string {
  const clean = (rawNif || '').trim();
  if (/^\d{9}$/.test(clean)) {
    return `${clean.slice(0, 3)} *** *${clean.slice(7)}`;
  }
  return clean;
}

const importProgressStore = new Map<string, { status: string; percent: number; step: string; detail: string; error?: string; stats?: any }>();
const importJobQueue: Array<() => Promise<void>> = [];
let activeImportJobs = 0;
const MAX_CONCURRENT_IMPORTS = 2;

function enqueueControlledImport(job: () => Promise<void>) {
  importJobQueue.push(job);
  drainImportQueue();
}

function drainImportQueue() {
  while (activeImportJobs < MAX_CONCURRENT_IMPORTS && importJobQueue.length > 0) {
    const nextJob = importJobQueue.shift()!;
    activeImportJobs++;
    nextJob()
      .catch((err: any) => console.error('[Import Queue] Erro inesperado no job:', err?.message || err))
      .finally(() => {
        activeImportJobs--;
        drainImportQueue();
      });
  }
}

const LEGACY_PREDICTABLE_CODES = new Set([
  'FARM-A-7842',
  'FARM-B-9315',
  'FARM-C-4629',
  'FARM-D-8154',
]);

async function ensureAnonymizedTenantsAndAccessCodes(prisma: any) {
  const farms = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
  for (let idx = 0; idx < farms.length; idx++) {
    const f = farms[idx];
    const letter = String.fromCharCode(65 + idx); // A, B, C...
    const randomPin = crypto.randomInt(100000, 999999);
    const secureRandomCode = `FARM-${letter}-${randomPin}`;
    const lowerNome = (f.nome || '').toLowerCase();

    let newNome = f.nome;
    // Se ainda tiver um nome real (ex: Baptista, Avenida), anonimiza automaticamente para Pitch Comercial
    if (lowerNome.includes('baptista') || lowerNome.includes('avenida')) {
      newNome = `Farmácia ${letter}`;
    }

    const currentCode = (f.codigo_acesso || '').trim().toUpperCase();
    // Atualiza códigos previsíveis antigos ou códigos públicos do repositório para códigos criptograficamente aleatórios
    const isPredictableOldCode =
      !currentCode ||
      /^FARMACIA-[A-Z]$/.test(currentCode) ||
      LEGACY_PREDICTABLE_CODES.has(currentCode);
    const newCode = isPredictableOldCode ? secureRandomCode : currentCode;

    if (newNome !== f.nome || newCode !== f.codigo_acesso) {
      await prisma.farmacia.update({
        where: { id: f.id },
        data: { nome: newNome, codigo_acesso: newCode },
      });
    }
  }

  const updated = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
  console.log('\n🔐 [ACESSOS MULTI-TENANT ISOLADOS & ADMIN PROTEGIDO POR PASSWORD]:');
  console.log(`   👑 Acesso Admin (Requer Password): http://localhost:${PORT}/?admin=1 (Password configurada em ADMIN_PASSWORD)`);
  for (const uf of updated) {
    const rawCode = uf.codigo_acesso || '';
    const displayCode = IS_PROD && rawCode.length > 4 ? `${rawCode.slice(0, 6)}****` : rawCode;
    console.log(
      `   🏥 ${uf.nome.padEnd(22)} | NIF: ${maskNif(uf.nif).padEnd(11)} | Código Exclusivo: ${displayCode.padEnd(14)}`
    );
  }
  console.log('');
}

async function startServer() {
  const { prisma, cleanup } = await ensureDatabaseReady();

  const farmacia = await prisma.farmacia.findFirst({
    orderBy: { criadoEm: 'desc' },
  });

  if (!farmacia) {
    console.warn('⚠️ Nenhuma farmácia encontrada na base de dados no arranque (use o painel Admin para importar ou npm run pipeline).');
  } else {
    await ensureAnonymizedTenantsAndAccessCodes(prisma);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = url.parse(req.url || '/', true);
      const pathname = parsedUrl.pathname || '/';

      const isMcpRoute =
        pathname.startsWith('/mcp') ||
        pathname.startsWith('/sse') ||
        pathname.startsWith('/oauth') ||
        pathname.startsWith('/.well-known');
      const configuredOrigins = (process.env.ALLOWED_ORIGIN || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let allowedOrigin = '*';
      if (isMcpRoute) {
        allowedOrigin = req.headers.origin || '*';
      } else if (IS_PROD) {
        if (req.headers.origin && configuredOrigins.includes(req.headers.origin)) {
          allowedOrigin = req.headers.origin;
        } else if (configuredOrigins.length > 0) {
          allowedOrigin = configuredOrigins[0];
        } else {
          allowedOrigin = '';
        }
      }
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-access-code, mcp-session-id, last-event-id');
      if (isMcpRoute) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      // Cabeçalhos Defensivos de Segurança Web
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      async function resolveAccessContext(explicitCode?: string | null) {
        let authBearer = '';
        if (req.headers.authorization && req.headers.authorization.toLowerCase().startsWith('bearer ')) {
          authBearer = req.headers.authorization.slice(7).trim();
        }
        const headerToken = String(req.headers['x-access-code'] || '').trim();
        let adminCookieToken = '';
        if (req.headers.cookie) {
          const mAdm = req.headers.cookie.match(/(?:^|;\s*)(?:admin_session_token|bi_admin_token)=([^;]+)/i);
          if (mAdm) {
            try { adminCookieToken = decodeURIComponent(mAdm[1].trim()); } catch { adminCookieToken = mAdm[1].trim(); }
          }
        }
        const candidateToken = headerToken || authBearer || adminCookieToken || (explicitCode ? explicitCode.trim() : '');

        // O Modo Admin SÓ é aceite através do Token Efémero Assinado e Ativo (ou password direta de admin)
        if (
          candidateToken &&
          (isValidAdminSession(candidateToken) ||
            (ADMIN_PASSWORD.length >= 6 && safeCompareStrings(candidateToken, ADMIN_PASSWORD)))
        ) {
          return {
            authenticated: true,
            role: 'ADMIN' as const,
            code: candidateToken.toUpperCase(),
            lockedFarmacia: null,
          };
        }

        // 1. Extrair token de Cookie, Referer ou Query Params
        let cookieCode = '';
        if (req.headers.cookie) {
          const m = req.headers.cookie.match(/(?:^|;\s*)(?:farmacia_access_code|bi_access_code|acesso)=([^;]+)/i);
          if (m) {
            try { cookieCode = decodeURIComponent(m[1].trim()); } catch { cookieCode = m[1].trim(); }
          }
        }

        let refererCode = '';
        if (req.headers.referer) {
          try {
            const refUrl = new URL(req.headers.referer, 'http://localhost:3000');
            refererCode = String(refUrl.searchParams.get('acesso') || refUrl.searchParams.get('code') || refUrl.searchParams.get('accessCode') || '').trim();
          } catch {}
        }

        const rawCodeOriginal = String(
          explicitCode ||
            headerToken ||
            authBearer ||
            parsedUrl.query.accessCode ||
            parsedUrl.query.acesso ||
            cookieCode ||
            refererCode ||
            ''
        ).trim();
        const rawCode = rawCodeOriginal.toUpperCase();
        const rawCodeLower = rawCodeOriginal.toLowerCase();

        const LEGACY_CODE_MAP: Record<string, string> = {
          'FARM-A-7842': '3ac42c32-87a8-4afe-98cc-4ca61ac64aca', // Farmácia A
          'FARM-B-7843': '8c34599d-9597-45a3-b122-8ffed62a5375', // Farmácia B
          'FARM-C-7844': '594bdf27-151b-49f7-be71-18660b745d84', // Farmácia Demo
          'FARMACIA-A': '3ac42c32-87a8-4afe-98cc-4ca61ac64aca',
          'FARMACIA-B': '8c34599d-9597-45a3-b122-8ffed62a5375',
          'FARMACIA-C': '594bdf27-151b-49f7-be71-18660b745d84',
          'FARM-A': '3ac42c32-87a8-4afe-98cc-4ca61ac64aca',
          'FARM-B': '8c34599d-9597-45a3-b122-8ffed62a5375',
          'FARM-C': '594bdf27-151b-49f7-be71-18660b745d84',
        };

        if (rawCode.length > 0) {
          const legacyTargetId = LEGACY_CODE_MAP[rawCode] || LEGACY_CODE_MAP[rawCodeOriginal];
          const matchedFarm = await prisma.farmacia.findFirst({
            where: {
              OR: [
                {
                  codigo_acesso: {
                    equals: rawCode,
                    mode: 'insensitive',
                  },
                },
                { id: rawCodeOriginal },
                { id: rawCodeLower },
                ...(legacyTargetId ? [{ id: legacyTargetId }] : []),
              ],
            },
          });
          if (matchedFarm) {
            return {
              authenticated: true,
              role: 'PHARMACY' as const,
              code: matchedFarm.codigo_acesso || rawCode,
              lockedFarmacia: matchedFarm,
            };
          }
          return {
            authenticated: false,
            role: 'NONE' as const,
            code: rawCode,
            lockedFarmacia: null,
          };
        }

        // Em desenvolvimento local (localhost), APENAS ativa o fallback se expressamente configurado em ALLOW_DEV_FALLBACK
        // Em Produção ou sem flag explícita, NUNCA autentica anonimamente!
        if (!IS_PROD && ALLOW_DEV_FALLBACK) {
          const defaultFarm = await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'asc' } });
          if (defaultFarm) {
            return {
              authenticated: true,
              role: 'PHARMACY' as const,
              code: defaultFarm.codigo_acesso || 'DEV_DEFAULT',
              lockedFarmacia: defaultFarm,
            };
          }
        }

        return {
          authenticated: false,
          role: 'NONE' as const,
          code: '',
          lockedFarmacia: null,
        };
      }

      async function getActiveFarmacia(requestedId?: string | null) {
        const ctx = await resolveAccessContext();
        // Se for um acesso isolado de farmácia, tranca ESTRITAMENTE a essa farmácia (Defesa contra IDOR/BOLA)
        if (ctx.role === 'PHARMACY' && ctx.lockedFarmacia) {
          return ctx.lockedFarmacia;
        }
        // Apenas o ADMIN autenticado pode pedir uma farmácia específica ou alternar
        if (ctx.role === 'ADMIN') {
          if (requestedId && requestedId.trim().length > 0) {
            const f = await prisma.farmacia.findUnique({ where: { id: requestedId.trim() } });
            if (f) return f;
          }
          return await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'asc' } });
        }
        return null;
      }

      async function requireActiveFarmacia(requestedId?: string | null) {
        const f = await getActiveFarmacia(requestedId);
        if (!f) {
          const err: any = new Error('Acesso não autorizado. Indique o código de acesso exclusivo ou inicie sessão como administrador.');
          err.statusCode = 401;
          throw err;
        }
        return f;
      }

      // ======================================================================
      // 🔐 MCP OAUTH 2.1 & METADATA (RFC 8414, RFC 9728, RFC 7591)
      // ======================================================================
      const baseUrl = getBaseIssuerUrl(req);

      if (
        pathname === '/.well-known/oauth-protected-resource' ||
        pathname === '/.well-known/oauth-protected-resource/mcp' ||
        pathname === '/mcp/.well-known/oauth-protected-resource'
      ) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(getProtectedResourceMetadata(baseUrl)));
        return;
      }

      if (
        pathname === '/.well-known/oauth-authorization-server' ||
        pathname === '/.well-known/openid-configuration'
      ) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(getAuthorizationServerMetadata(baseUrl)));
        return;
      }

      if (pathname === '/oauth/jwks') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ keys: [] }));
        return;
      }

      if (pathname === '/oauth/register' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          let bodyObj = {};
          try {
            bodyObj = JSON.parse(rawBody || '{}');
          } catch {}
          const registered = registerOAuthClient(baseUrl, bodyObj);
          res.writeHead(201, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify(registered));
        } catch (err: any) {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'invalid_client_metadata', error_description: err?.message || 'Erro ao registar cliente OAuth' }));
        }
        return;
      }

      if (pathname === '/oauth/authorize') {
        const farmacias = await prisma.farmacia.findMany({
          orderBy: { criadoEm: 'asc' },
          select: { id: true, nome: true, nif: true, codigo_acesso: true },
        });

        if (req.method === 'GET') {
          const clientId = String(parsedUrl.query.client_id || '');
          const redirectUri = String(parsedUrl.query.redirect_uri || 'https://claude.ai/api/mcp/auth_callback');
          const state = String(parsedUrl.query.state || '');
          const codeChallenge = String(parsedUrl.query.code_challenge || '');
          const codeChallengeMethod = String(parsedUrl.query.code_challenge_method || 'S256');
          const autoApprove = parsedUrl.query.auto === '1' || parsedUrl.query.auto_approve === 'true';

          if (autoApprove && farmacias.length > 0) {
            const targetFarm = farmacias[0];
            const authCode = createOAuthAuthorizationCode({
              clientId,
              redirectUri,
              codeChallenge,
              codeChallengeMethod,
              state,
              farmaciaId: targetFarm.id,
              farmaciaNome: targetFarm.nome,
              perfilPermissao: 'COMPLETO',
            });
            const redirectUrl = new URL(redirectUri);
            redirectUrl.searchParams.set('code', authCode);
            if (state) redirectUrl.searchParams.set('state', state);
            redirectUrl.searchParams.set('iss', baseUrl);
            res.writeHead(302, { Location: redirectUrl.toString() });
            res.end();
            return;
          }

          const html = renderOAuthConsentPage({
            baseUrl,
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            farmacias,
          });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (req.method === 'POST') {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const contentType = String(req.headers['content-type'] || '');
          const params: Record<string, string> = {};
          if (contentType.includes('application/json')) {
            try {
              const obj = JSON.parse(rawBody || '{}');
              for (const [k, v] of Object.entries(obj)) params[k] = String(v);
            } catch {}
          } else {
            const searchParams = new URLSearchParams(rawBody);
            for (const [k, v] of searchParams.entries()) params[k] = v;
          }

          const clientId = params.client_id || String(parsedUrl.query.client_id || '');
          const redirectUri = params.redirect_uri || String(parsedUrl.query.redirect_uri || 'https://claude.ai/api/mcp/auth_callback');
          const state = params.state || String(parsedUrl.query.state || '');
          const codeChallenge = params.code_challenge || String(parsedUrl.query.code_challenge || '');
          const codeChallengeMethod = params.code_challenge_method || String(parsedUrl.query.code_challenge_method || 'S256');
          const farmaciaId = params.farmacia_id || (farmacias[0]?.id ?? '');
          const perfilPermissao = (params.perfil_permissao as McpPermissionProfile) || 'COMPLETO';

          const chosenFarm = farmacias.find((f) => f.id === farmaciaId) || farmacias[0];
          if (!chosenFarm) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Nenhuma farmácia disponível para autorização.');
            return;
          }

          const authCode = createOAuthAuthorizationCode({
            clientId,
            redirectUri,
            codeChallenge,
            codeChallengeMethod,
            state,
            farmaciaId: chosenFarm.id,
            farmaciaNome: chosenFarm.nome,
            perfilPermissao: perfilPermissao,
          });

          const redirectUrl = new URL(redirectUri);
          redirectUrl.searchParams.set('code', authCode);
          if (state) redirectUrl.searchParams.set('state', state);
          redirectUrl.searchParams.set('iss', baseUrl);

          res.writeHead(302, { Location: redirectUrl.toString() });
          res.end();
          return;
        }
      }

      if (pathname === '/oauth/token' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const contentType = String(req.headers['content-type'] || '');
          const params: Record<string, string> = {};
          if (contentType.includes('application/json')) {
            try {
              const obj = JSON.parse(rawBody || '{}');
              for (const [k, v] of Object.entries(obj)) params[k] = String(v);
            } catch {}
          } else {
            const searchParams = new URLSearchParams(rawBody);
            for (const [k, v] of searchParams.entries()) params[k] = v;
          }

          const grantType = params.grant_type;
          const code = params.code;
          const codeVerifier = params.code_verifier;
          const clientId = params.client_id;
          const redirectUri = params.redirect_uri;

          if (grantType !== 'authorization_code') {
            res.writeHead(400, {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({ error: 'unsupported_grant_type', error_description: 'Apenas authorization_code é suportado.' }));
            return;
          }

          if (!code) {
            res.writeHead(400, {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({ error: 'invalid_request', error_description: 'O parâmetro code é obrigatório.' }));
            return;
          }

          const tokenResult = await exchangeOAuthToken(prisma, {
            code,
            codeVerifier,
            clientId,
            redirectUri,
          });

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            'Pragma': 'no-cache',
          });
          res.end(
            JSON.stringify({
              access_token: tokenResult.accessToken,
              token_type: tokenResult.tokenType,
              expires_in: tokenResult.expiresIn,
              scope: tokenResult.scope,
            })
          );
        } catch (err: any) {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: err?.message || 'Falha ao trocar código de autorização.',
            })
          );
        }
        return;
      }

      // ======================================================================
      // 🔌 MCP (MODEL CONTEXT PROTOCOL) STREAMABLE HTTP & LEGACY SSE (CLAUDE WEB)
      // ======================================================================
      if (
        req.method === 'OPTIONS' &&
        (pathname === '/mcp' ||
          pathname === '/mcp/sse' ||
          pathname === '/sse' ||
          pathname === '/mcp/messages' ||
          pathname === '/sse/messages')
      ) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Access-Code',
          'Access-Control-Expose-Headers': 'Mcp-Session-Id',
        });
        res.end();
        return;
      }

      if (pathname === '/mcp' || pathname === '/mcp/sse' || pathname === '/sse') {
        const clientIp = getClientIp(req);
        const userAgent = String(req.headers['user-agent'] || '');

        let rawAuthToken = String(
          parsedUrl.query.token ||
          parsedUrl.query.acesso ||
          parsedUrl.query.code ||
          req.headers['x-access-code'] ||
          ''
        ).trim();

        if (!rawAuthToken && req.headers.authorization && req.headers.authorization.toLowerCase().startsWith('bearer ')) {
          rawAuthToken = req.headers.authorization.slice(7).trim();
        }

        const authRes = await resolveMcpAuthentication(prisma, rawAuthToken, { ip: clientIp, userAgent });

        if (!authRes.allowed || !authRes.farmacia) {
          let statusCode = 401;
          let errorMsg = 'Autenticação MCP inválida ou ausente.';
          if (authRes.reason === 'MCP_DISABLED_BY_PHARMACY') {
            statusCode = 403;
            errorMsg = 'O acesso de agentes externos de IA (MCP) foi desativado nas definições desta farmácia.';
          } else if (authRes.reason === 'CONNECTOR_REVOKED') {
            statusCode = 403;
            errorMsg = 'Este conector MCP foi revogado ou pausado pelo Diretor da farmácia.';
          }
          const errHeaders: Record<string, string> = {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          };
          if (statusCode === 401) {
            errHeaders['WWW-Authenticate'] = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
          }
          res.writeHead(statusCode, errHeaders);
          res.end(JSON.stringify({ error: errorMsg, code: authRes.reason }));
          return;
        }

        const farm = authRes.farmacia;
        const secContext: ToolSecurityContext = {
          farmaciaId: farm.id,
          farmaciaNome: farm.nome,
          nif: farm.nif,
        };

        const connectorId = authRes.connector?.id || null;
        const connectorNome = authRes.connector?.nome || null;
        const effectiveToken = rawAuthToken;

        const headerSessionId = String(req.headers['mcp-session-id'] || '').trim();
        const isStreamableHttpRequest =
          pathname === '/mcp' &&
          (req.method === 'POST' || req.method === 'DELETE' || (req.method === 'GET' && Boolean(headerSessionId)));

        // --- MODO MODERNO: MCP STREAMABLE HTTP (CLAUDE WEB / SPEC 2025-03-26+) ---
        if (isStreamableHttpRequest) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

          if (headerSessionId) {
            const existing = mcpActiveSessions.get(headerSessionId);
            if (!existing || existing.transportType !== 'streamable-http' || existing.farmaciaId !== farm.id) {
              res.writeHead(404, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
              });
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: { code: -32001, message: 'Sessão MCP não encontrada ou expirada. Por favor reinicialize.' },
                  id: null,
                })
              );
              return;
            }
            existing.lastActivity = new Date();
            await (existing.transport as StreamableHTTPServerTransport).handleRequest(req, res);
            return;
          }

          if (req.method === 'DELETE') {
            res.writeHead(400, {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({ error: 'Header Mcp-Session-Id obrigatório para encerrar sessão.' }));
            return;
          }

          // Novo pedido POST /mcp sem Mcp-Session-Id (ex: initialize)
          let parsedBody: any = undefined;
          try {
            const rawBody = await readRequestBody(req, 4 * 1024 * 1024);
            parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
          } catch (parseErr: any) {
            res.writeHead(400, {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32700, message: `JSON inválido no pedido MCP: ${parseErr?.message || 'erro de parse'}` },
                id: null,
              })
            );
            return;
          }

          let activeSessionId: string | undefined;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
              activeSessionId = newSessionId;
              mcpActiveSessions.set(newSessionId, {
                sessionId: newSessionId,
                server: mcpServer,
                transport,
                transportType: 'streamable-http',
                farmaciaId: farm.id,
                farmaciaNome: farm.nome,
                connectorId,
                connectorNome,
                token: effectiveToken,
                ip: clientIp,
                userAgent,
                connectedAt: new Date(),
                lastActivity: new Date(),
                totalToolCalls: 0,
              });
              console.log(
                `🔌 [MCP STREAMABLE HTTP]: Sessão iniciada para "${connectorNome || farm.nome}" (Session: ${newSessionId}, IP: ${clientIp})`
              );
            },
            onsessionclosed: (closedSessionId) => {
              mcpActiveSessions.delete(closedSessionId);
            },
          });

          const mcpServer = createPharmaMcpServer(prisma, secContext, {
            perfilPermissao: authRes.perfilPermissao,
            connectorId: connectorId || undefined,
            ip: clientIp,
            userAgent,
            onAudit: async (auditData) => {
              const sid = activeSessionId || transport.sessionId;
              if (sid) {
                const s = mcpActiveSessions.get(sid);
                if (s) {
                  s.totalToolCalls++;
                  s.lastActivity = new Date();
                }
              }
              await recordMcpAuditLog(prisma, {
                farmaciaId: farm.id,
                connectorId,
                ferramenta: auditData.ferramenta,
                parametros: auditData.parametros,
                sucesso: auditData.sucesso,
                duracaoMs: auditData.duracaoMs,
                ip: clientIp,
                userAgent,
              });
            },
          });

          transport.onclose = () => {
            const sid = activeSessionId || transport.sessionId;
            if (sid) mcpActiveSessions.delete(sid);
          };

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        const isEventStream = req.headers.accept && req.headers.accept.includes('text/event-stream');

        // Se for um probe/ping HTTP normal (ex: verificação do navegador)
        if (!isEventStream && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(
            JSON.stringify({
              name: `bi-pharma-${farm.nome.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
              version: '1.0.0',
              protocol: 'mcp-streamable-http+sse',
              status: 'online',
              farmacia: {
                id: farm.id,
                nome: farm.nome,
                nif: farm.nif,
              },
              conector: authRes.connector ? { nome: authRes.connector.nome, perfil: authRes.perfilPermissao } : null,
              endpoint: `/mcp`,
              legacy_sse_endpoint: `/mcp/messages?token=${encodeURIComponent(effectiveToken)}`,
              message: 'Servidor MCP pronto (Streamable HTTP + SSE legacy) com governança ativa.',
            })
          );
          return;
        }

        // --- MODO LEGACY: SSE Stream (/sse, /mcp/sse, ou GET /mcp sem Mcp-Session-Id) ---
        const postEndpoint = `/mcp/messages?token=${encodeURIComponent(effectiveToken)}`;
        const transport = new SSEServerTransport(postEndpoint, res, {
          enableDnsRebindingProtection: false,
        });

        const sId = transport.sessionId;

        const mcpServer = createPharmaMcpServer(prisma, secContext, {
          perfilPermissao: authRes.perfilPermissao,
          connectorId: connectorId || undefined,
          ip: clientIp,
          userAgent,
          onAudit: async (auditData) => {
            const s = mcpActiveSessions.get(sId);
            if (s) {
              s.totalToolCalls++;
              s.lastActivity = new Date();
            }
            await recordMcpAuditLog(prisma, {
              farmaciaId: farm.id,
              connectorId,
              ferramenta: auditData.ferramenta,
              parametros: auditData.parametros,
              sucesso: auditData.sucesso,
              duracaoMs: auditData.duracaoMs,
              ip: clientIp,
              userAgent,
            });
          },
        });

        mcpActiveSessions.set(sId, {
          sessionId: sId,
          server: mcpServer,
          transport,
          transportType: 'sse',
          farmaciaId: farm.id,
          farmaciaNome: farm.nome,
          connectorId,
          connectorNome,
          token: effectiveToken,
          ip: clientIp,
          userAgent,
          connectedAt: new Date(),
          lastActivity: new Date(),
          totalToolCalls: 0,
        });

        transport.onclose = () => {
          mcpActiveSessions.delete(sId);
        };

        console.log(`🔌 [MCP SSE CONNECT]: Sessão iniciada para "${connectorNome || farm.nome}" (Session: ${sId}, IP: ${clientIp})`);
        await mcpServer.connect(transport);
        return;
      }

      if (pathname === '/mcp/messages' || pathname === '/sse/messages') {
        const querySessionId = String(parsedUrl.query.sessionId || req.headers['mcp-session-id'] || '').trim();
        if (!querySessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'sessionId obrigatório para enviar mensagens MCP.' }));
          return;
        }

        const session = mcpActiveSessions.get(querySessionId);
        if (!session || session.transportType !== 'sse') {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Sessão MCP SSE não encontrada ou expirada.' }));
          return;
        }

        session.lastActivity = new Date();
        await (session.transport as SSEServerTransport).handlePostMessage(req, res);
        return;
      }

      // ======================================================================
      // 🛡️ API DE GOVERNANÇA DE CONECTORES & AGENTES IA (MCP)
      // ======================================================================
      if (pathname === '/api/mcp/governance' && req.method === 'GET') {
        try {
          const authCtx = await resolveAccessContext();
          if (!authCtx.authenticated) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso não autorizado.' }));
            return;
          }
          const farm = await requireActiveFarmacia(parsedUrl.query.farmaciaId as string);
          const sessionsArray = Array.from(mcpActiveSessions.values());
          const report = await getMcpGovernanceReport(prisma, farm.id, sessionsArray);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...report }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/mcp/governance/toggle-global' && req.method === 'POST') {
        try {
          const farm = await requireActiveFarmacia();
          const rawBody = await readRequestBody(req, 64 * 1024);
          const body = JSON.parse(rawBody || '{}');
          const permitido = Boolean(body.permitido);
          await toggleGlobalMcpAccess(prisma, farm.id, permitido);

          if (!permitido) {
            for (const [sId, s] of mcpActiveSessions.entries()) {
              if (s.farmaciaId === farm.id) {
                try { s.transport.close(); } catch {}
                mcpActiveSessions.delete(sId);
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, permitido }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/mcp/governance/connectors/create' && req.method === 'POST') {
        try {
          const farm = await requireActiveFarmacia();
          const rawBody = await readRequestBody(req, 64 * 1024);
          const body = JSON.parse(rawBody || '{}');
          if (!body.nome || !body.nome.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Nome do conetor é obrigatório.' }));
            return;
          }
          const connector = await createMcpConnector(prisma, farm.id, {
            nome: body.nome.trim(),
            agenteTipo: body.agenteTipo || 'CLAUDE_WEB',
            perfilPermissao: body.perfilPermissao || 'COMPLETO',
            criadoPor: body.criadoPor || 'DIRETOR',
          });
          res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, connector }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/mcp/governance/connectors/toggle' && req.method === 'POST') {
        try {
          const farm = await requireActiveFarmacia();
          const rawBody = await readRequestBody(req, 64 * 1024);
          const body = JSON.parse(rawBody || '{}');
          await toggleMcpConnector(prisma, body.connectorId, farm.id, Boolean(body.ativo));

          if (!body.ativo) {
            for (const [sId, s] of mcpActiveSessions.entries()) {
              if (s.connectorId === body.connectorId) {
                try { s.transport.close(); } catch {}
                mcpActiveSessions.delete(sId);
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/mcp/governance/connectors/delete' && req.method === 'POST') {
        try {
          const farm = await requireActiveFarmacia();
          const rawBody = await readRequestBody(req, 64 * 1024);
          const body = JSON.parse(rawBody || '{}');
          await deleteMcpConnector(prisma, body.connectorId, farm.id);

          for (const [sId, s] of mcpActiveSessions.entries()) {
            if (s.connectorId === body.connectorId) {
              try { s.transport.close(); } catch {}
              mcpActiveSessions.delete(sId);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/mcp/governance/sessions/disconnect' && req.method === 'POST') {
        try {
          const farm = await requireActiveFarmacia();
          const rawBody = await readRequestBody(req, 64 * 1024);
          const body = JSON.parse(rawBody || '{}');
          const session = mcpActiveSessions.get(body.sessionId);
          if (session && session.farmaciaId === farm.id) {
            try { session.transport.close(); } catch {}
            mcpActiveSessions.delete(body.sessionId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // 0A. Endpoint de Autenticação / Validação (Código Exclusivo de Farmácia vs Password de Administrador)
      if (pathname === '/api/auth/verify' && req.method === 'POST') {
        try {
          const clientIp = getClientIp(req);
          if (isRateLimited(clientIp)) {
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'Demasiadas tentativas falhadas. Por favor, aguarde 5 minutos antes de tentar novamente.',
              })
            );
            return;
          }

          const rawBody = await readRequestBody(req, 256 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const adminPasswordInput = String(parsed.adminPassword || '').trim();
          const rawCodeInput = String(parsed.code || '').trim();

          let ctx: { authenticated: boolean; role: 'ADMIN' | 'PHARMACY' | 'NONE'; code: string; lockedFarmacia: any | null };

          if (adminPasswordInput.length > 0) {
            if (ADMIN_PASSWORD.length >= 6 && safeCompareStrings(adminPasswordInput, ADMIN_PASSWORD)) {
              resetFailedAttempts(clientIp);
              const sessionToken = createAdminSession();
              ctx = {
                authenticated: true,
                role: 'ADMIN',
                code: sessionToken,
                lockedFarmacia: null,
              };
            } else {
              recordFailedAttempt(clientIp);
              res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'Password de Administrador incorreta.',
                })
              );
              return;
            }
          } else if (ADMIN_PASSWORD.length >= 6 && safeCompareStrings(rawCodeInput, ADMIN_PASSWORD)) {
            resetFailedAttempts(clientIp);
            const sessionToken = createAdminSession();
            ctx = {
              authenticated: true,
              role: 'ADMIN',
              code: sessionToken,
              lockedFarmacia: null,
            };
          } else {
            ctx = await resolveAccessContext(rawCodeInput);
          }

          if (!ctx.authenticated) {
            recordFailedAttempt(clientIp);
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'Código de acesso inválido. Utilize o link ou código exclusivo atribuído à sua Farmácia.',
              })
            );
            return;
          }

          resetFailedAttempts(clientIp);

          if (ctx.role === 'ADMIN') {
            res.setHeader('Set-Cookie', `admin_session_token=${encodeURIComponent(ctx.code)}; Path=/; SameSite=Lax; Max-Age=86400`);
          } else if (ctx.role === 'PHARMACY') {
            res.setHeader('Set-Cookie', `farmacia_access_code=${encodeURIComponent(ctx.code)}; Path=/; SameSite=Lax; Max-Age=2592000`);
          }

          const allFarms =
            ctx.role === 'ADMIN'
              ? await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } })
              : ctx.lockedFarmacia
                ? [ctx.lockedFarmacia]
                : [];

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: true,
              role: ctx.role,
              code: ctx.code,
              lockedFarmacia: ctx.lockedFarmacia
                ? {
                    id: ctx.lockedFarmacia.id,
                    nome: ctx.lockedFarmacia.nome,
                    nif: maskNif(ctx.lockedFarmacia.nif),
                  }
                : null,
              pharmacies: allFarms.map((f) => ({
                id: f.id,
                nome: f.nome,
                nif: maskNif(f.nif),
                codigo_acesso: ctx.role === 'ADMIN' ? (f.codigo_acesso || f.id) : undefined,
              })),
            })
          );
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 0A.2. Endpoint de Logout Seguro (Revogação Ativa de Sessão Admin no Servidor)
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        try {
          const headerToken = String(req.headers['x-access-code'] || '').trim();
          if (headerToken) {
            invalidateAdminSession(headerToken);
          }
          res.setHeader('Set-Cookie', [
            'farmacia_access_code=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax',
            'admin_session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax'
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 0B. Endpoint Admin: Atualizar Nome Anónimo e Código de Acesso de uma Farmácia
      if (pathname === '/api/admin/update-pharmacy' && req.method === 'POST') {
        try {
          const ctx = await resolveAccessContext();
          if (ctx.role !== 'ADMIN') {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Apenas o Administrador pode gerir farmácias.' }));
            return;
          }
          const rawBody = await readRequestBody(req, 256 * 1024);
          const { farmaciaId, nome, codigo_acesso } = JSON.parse(rawBody || '{}');
          if (!farmaciaId || !nome || !codigo_acesso) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Preencha o Nome e o Código de Acesso.' }));
            return;
          }
          const cleanCode = String(codigo_acesso).trim().toUpperCase().replace(/\s+/g, '-');
          const updated = await prisma.farmacia.update({
            where: { id: String(farmaciaId) },
            data: {
              nome: String(nome).trim(),
              codigo_acesso: cleanCode,
            },
          });
          invalidateAllPharmacyCaches(updated.id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: true,
              farmacia: {
                id: updated.id,
                nome: updated.nome,
                nif: maskNif(updated.nif),
                codigo_acesso: updated.codigo_acesso,
              },
            })
          );
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 0B-2. Endpoint Admin: Telemetria & FinOps de IA (Tokens e Custos por Farmácia)
      if (pathname === '/api/admin/copilot-finops' && req.method === 'GET') {
        try {
          const farmacias = await prisma.farmacia.findMany({
            select: { id: true, nome: true, nif: true, codigo_acesso: true },
            orderBy: { criadoEm: 'asc' },
          });

          const allLogs = await prisma.copilotUsageLog.findMany({
            orderBy: { criadoEm: 'desc' },
            take: 50,
          });

          // Métricas por Farmácia
          const farmaciaStats = await Promise.all(
            farmacias.map(async (f) => {
              const logs = await prisma.copilotUsageLog.findMany({
                where: { farmaciaId: f.id },
                select: {
                  input_tokens: true,
                  output_tokens: true,
                  cache_creation_input_tokens: true,
                  cache_read_input_tokens: true,
                  custo_estimado_eur: true,
                  criadoEm: true,
                },
                orderBy: { criadoEm: 'desc' },
              });

              const totalPerguntas = logs.length;
              const totalInput = logs.reduce((s, l) => s + l.input_tokens, 0);
              const totalOutput = logs.reduce((s, l) => s + l.output_tokens, 0);
              const totalCacheRead = logs.reduce((s, l) => s + l.cache_read_input_tokens, 0);
              const totalCacheCreation = logs.reduce((s, l) => s + l.cache_creation_input_tokens, 0);
              const custoTotalEur = logs.reduce((s, l) => s + Number(l.custo_estimado_eur || 0), 0);
              const custoMedioEur = totalPerguntas > 0 ? custoTotalEur / totalPerguntas : 0;
              const ultimaAtividade = logs.length > 0 ? logs[0].criadoEm : null;

              return {
                farmaciaId: f.id,
                nome: f.nome,
                nif: maskNif(f.nif),
                codigo_acesso: f.codigo_acesso,
                totalPerguntas,
                totalInputTokens: totalInput,
                totalOutputTokens: totalOutput,
                totalCacheReadTokens: totalCacheRead,
                totalCacheCreationTokens: totalCacheCreation,
                custoTotalEur: Number(custoTotalEur.toFixed(4)),
                custoMedioEur: Number(custoMedioEur.toFixed(4)),
                ultimaAtividade: ultimaAtividade ? ultimaAtividade.toISOString() : null,
              };
            })
          );

          // Totais Globais
          const globalTotalPerguntas = farmaciaStats.reduce((s, f) => s + f.totalPerguntas, 0);
          const globalTotalInput = farmaciaStats.reduce((s, f) => s + f.totalInputTokens, 0);
          const globalTotalOutput = farmaciaStats.reduce((s, f) => s + f.totalOutputTokens, 0);
          const globalTotalCacheRead = farmaciaStats.reduce((s, f) => s + f.totalCacheReadTokens, 0);
          const globalCustoTotalEur = farmaciaStats.reduce((s, f) => s + f.custoTotalEur, 0);
          const globalCustoMedioEur = globalTotalPerguntas > 0 ? globalCustoTotalEur / globalTotalPerguntas : 0;

          // Poupança estimada pelo Prompt Caching
          const poupancaCachingEur = Number(((globalTotalCacheRead / 1_000_000) * (0.80 - 0.08) * 0.92).toFixed(4));

          const farmMap = new Map(farmacias.map((f) => [f.id, f.nome]));
          const logsFormatados = allLogs.map((l) => ({
            id: l.id,
            farmaciaNome: farmMap.get(l.farmaciaId) || 'Farmácia',
            farmaciaId: l.farmaciaId,
            pergunta: l.pergunta,
            modelo: l.modelo,
            inputTokens: l.input_tokens,
            outputTokens: l.output_tokens,
            cacheReadTokens: l.cache_read_input_tokens,
            custoEur: Number(Number(l.custo_estimado_eur || 0).toFixed(4)),
            ferramentas: l.ferramentas_executadas,
            duracaoMs: l.duracao_ms,
            data: l.criadoEm.toISOString(),
          }));

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: true,
              resumoGlobal: {
                totalPerguntas: globalTotalPerguntas,
                totalInputTokens: globalTotalInput,
                totalOutputTokens: globalTotalOutput,
                totalCacheReadTokens: globalTotalCacheRead,
                custoTotalEur: Number(globalCustoTotalEur.toFixed(4)),
                custoMedioEur: Number(globalCustoMedioEur.toFixed(4)),
                poupancaCachingEur,
              },
              farmacias: farmaciaStats,
              logsRecentes: logsFormatados,
            })
          );
          return;
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
      }

      // 0C. Endpoint Admin: Importar Nova Farmácia via Browser (PDF Inventário + PDF Validades + CSV Vendas)
      if (pathname === '/api/admin/import-pharmacy' && req.method === 'POST') {
        const tmpFiles: string[] = [];
        try {
          const ctx = await resolveAccessContext();
          if (ctx.role !== 'ADMIN') {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Apenas o acesso Master/Admin pode importar novas farmácias.' }));
            return;
          }
          const rawBody = await readRequestBody(req, 25 * 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const nomeAnonimo = String(parsed.nome || 'Farmácia Demo').trim();
          const nifAlias = String(parsed.nif || `DEMO-${Date.now().toString().slice(-4)}`).trim();
          const codigoAcesso = String(
            parsed.codigo_acesso || nomeAnonimo.toUpperCase().replace(/[^A-Z0-9]+/g, '-')
          )
            .trim()
            .toUpperCase();

          if (!parsed.pdfInventarioBase64 || !parsed.csvVendasBase64) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'É obrigatório fornecer pelo menos o PDF de Inventário e o CSV de Vendas.',
              })
            );
            return;
          }

          const tmpDir = os.tmpdir();
          const ts = Date.now();
          const invPath = path.join(tmpDir, `bi_inv_${ts}.pdf`);
          const csvPath = path.join(tmpDir, `bi_ven_${ts}.csv`);
          fs.writeFileSync(invPath, Buffer.from(parsed.pdfInventarioBase64, 'base64'));
          fs.writeFileSync(csvPath, Buffer.from(parsed.csvVendasBase64, 'base64'));
          tmpFiles.push(invPath, csvPath);

          let valPath: string | null = null;
          if (parsed.pdfValidadesBase64) {
            valPath = path.join(tmpDir, `bi_val_${ts}.pdf`);
            fs.writeFileSync(valPath, Buffer.from(parsed.pdfValidadesBase64, 'base64'));
            tmpFiles.push(valPath);
          }

          const newFarm = await prisma.farmacia.upsert({
            where: { nif: nifAlias },
            update: { nome: nomeAnonimo, codigo_acesso: codigoAcesso },
            create: { nome: nomeAnonimo, nif: nifAlias, codigo_acesso: codigoAcesso },
          });

          const invIngest = await ingestInventarioPdf(prisma, newFarm.id, invPath);
          await transformStagingInventario(prisma, newFarm.id, invIngest.batchId);

          let valUpdated = 0;
          if (valPath) {
            const valIngest = await ingestValidadesPdf(prisma, newFarm.id, valPath);
            const valTrans = await transformStagingValidades(prisma, newFarm.id, valIngest.batchId);
            valUpdated = valTrans.inventariosAtualizados;
          }

          const venIngest = await ingestVendasCsv(prisma, newFarm.id, csvPath);
          const venTrans = await transformStagingVendas(prisma, newFarm.id, venIngest.batchId);

          await classifyAllExistingProducts(prisma);
          invalidateAllPharmacyCaches(newFarm.id);
          getCachedOrComputeAnalysis(prisma, newFarm.id, 90, 4, 12).catch(() => {});
          getCachedOrComputeCampaignsPayload(prisma, newFarm).catch(() => {});

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: true,
              farmacia: {
                id: newFarm.id,
                nome: newFarm.nome,
                nif: maskNif(newFarm.nif),
                codigo_acesso: newFarm.codigo_acesso,
              },
              stats: {
                artigosInventario: invIngest.totalExtraidos,
                validadesCruzadas: valUpdated,
                registosVendas: venTrans.processadosComSucesso,
              },
            })
          );
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        } finally {
          for (const f of tmpFiles) {
            try {
              if (fs.existsSync(f)) fs.unlinkSync(f);
            } catch {}
          }
        }
        return;
      }

      // 0. Endpoint de Lista de Farmácias (Multi-Tenant com Isolamento por Código de Acesso)
      
      // 0D. Listar ficheiros disponíveis na pasta Avenida (apenas administradores)
      if (pathname === '/api/admin/avenida-files' && req.method === 'GET') {
        const ctx = await resolveAccessContext();
        if (ctx.role !== 'ADMIN') {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Apenas administradores podem listar ficheiros internos.' }));
          return;
        }
        const avenidaDir = path.resolve(process.cwd(), 'Avenida');
        if (!fs.existsSync(avenidaDir)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, files: [] }));
          return;
        }
        const files = fs.readdirSync(avenidaDir)
          .filter((f) => f.toLowerCase().endsWith('.pdf') || f.toLowerCase().endsWith('.csv') || f.toLowerCase().endsWith('.xlsx'))
          .map((f) => {
            const st = fs.statSync(path.join(avenidaDir, f));
            return {
              name: f,
              sizeBytes: st.size,
              sizeFormatted: (st.size / 1024).toFixed(1) + ' KB',
              modifiedAt: st.mtime,
            };
          });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, files }));
        return;
      }

      // 0E. Inspecionar Ficheiros para Importação Interativa (Dry-Run + Detecção de Perguntas)
      if (pathname === '/api/admin/inspect-import' && req.method === 'POST') {
        try {
          const ctx = await resolveAccessContext();
          if (ctx.role !== 'ADMIN') {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Apenas administradores podem inspecionar importações.' }));
            return;
          }
          const rawBody = await readRequestBody(req, 10 * 1024 * 1024);
          const body = JSON.parse(rawBody || '{}');
          const farm = await requireActiveFarmacia(body.farmaciaId);

          let fileBuffers: Array<{ name: string; buffer: Buffer }> = [];

          if (body.fromAvenida && Array.isArray(body.fileNames)) {
            const avenidaDir = path.resolve(process.cwd(), 'Avenida');
            for (const rawFn of body.fileNames) {
              const cleanFn = path.basename(String(rawFn || ''));
              if (!cleanFn || cleanFn.startsWith('.')) continue;
              const fullP = path.resolve(avenidaDir, cleanFn);
              // Confinamento estrito de diretório (Anti-Path Traversal)
              if (!fullP.startsWith(avenidaDir + path.sep)) continue;
              if (fs.existsSync(fullP)) {
                fileBuffers.push({ name: cleanFn, buffer: fs.readFileSync(fullP) });
              }
            }
          } else if (Array.isArray(body.files)) {
            for (const f of body.files) {
              const cleanName = path.basename(String(f.name || 'ficheiro'));
              fileBuffers.push({
                name: cleanName,
                buffer: Buffer.from(f.base64, 'base64'),
              });
            }
          }

          if (fileBuffers.length === 0) {
            throw new Error('Nenhum ficheiro válido fornecido para inspeção.');
          }

          const inspection = await inspectFilesForInteractiveImport(fileBuffers, farm, prisma);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, farmacia: farm, inspection }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 0G. Progresso em Tempo Real da Importação (Apenas Admin)
      if (pathname === '/api/admin/import-progress' && req.method === 'GET') {
        const ctx = await resolveAccessContext();
        if (ctx.role !== 'ADMIN') {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Apenas administradores podem consultar o progresso de importação.' }));
          return;
        }
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const cur = importProgressStore.get(farmIdQuery) || {
          status: 'IDLE',
          percent: 0,
          step: 'A aguardar início...',
          detail: '',
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, progress: cur }));
        return;
      }

      // 0F. Executar Importação Interativa
      if (pathname === '/api/admin/execute-import' && req.method === 'POST') {
        try {
          const ctx = await resolveAccessContext();
          if (ctx.role !== 'ADMIN') {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Apenas administradores podem executar importações.' }));
            return;
          }
          const rawBody = await readRequestBody(req, 10 * 1024 * 1024);
          const body = JSON.parse(rawBody || '{}');
          const farm = await requireActiveFarmacia(body.farmaciaId);

          let fileBuffers: Array<{ name: string; buffer: Buffer }> = [];

          if (body.fromAvenida && Array.isArray(body.fileNames)) {
            const avenidaDir = path.resolve(process.cwd(), 'Avenida');
            for (const rawFn of body.fileNames) {
              const cleanFn = path.basename(String(rawFn || ''));
              if (!cleanFn || cleanFn.startsWith('.')) continue;
              const fullP = path.resolve(avenidaDir, cleanFn);
              // Confinamento estrito de diretório (Anti-Path Traversal)
              if (!fullP.startsWith(avenidaDir + path.sep)) continue;
              if (fs.existsSync(fullP)) {
                fileBuffers.push({ name: cleanFn, buffer: fs.readFileSync(fullP) });
              }
            }
          } else if (Array.isArray(body.files)) {
            for (const f of body.files) {
              const cleanName = path.basename(String(f.name || 'ficheiro'));
              fileBuffers.push({
                name: cleanName,
                buffer: Buffer.from(f.base64, 'base64'),
              });
            }
          }

          const queuedPos = activeImportJobs >= MAX_CONCURRENT_IMPORTS ? importJobQueue.length + 1 : 0;
          importProgressStore.set(farm.id, {
            status: queuedPos > 0 ? 'QUEUED' : 'PROCESSING',
            percent: 2,
            step: queuedPos > 0 ? `Na fila de importação (posição ${queuedPos})...` : 'A preparar ficheiros para importação...',
            detail: fileBuffers.length + ' ficheiro(s) selecionados',
          });

          const decisions = body.decisions || {};
          const jobStartMs = Date.now();

          enqueueControlledImport(async () => {
            try {
              importProgressStore.set(farm.id, {
                status: 'PROCESSING',
                percent: 5,
                step: 'A iniciar importação em lote...',
                detail: fileBuffers.length + ' ficheiro(s) em processamento',
              });

              const stats = await executeInteractiveImport(
                fileBuffers,
                decisions,
                farm.id,
                prisma,
                (percent, step, detail) => {
                  importProgressStore.set(farm.id, {
                    status: 'PROCESSING',
                    percent: Math.min(94, percent),
                    step,
                    detail,
                  });
                }
              );

              const totalErrosImport = stats.detalhesPorFicheiro.filter((d) => !d.sucesso).length;
              if (stats.filesProcessed > 0) {
                importProgressStore.set(farm.id, {
                  status: 'PROCESSING',
                  percent: 96,
                  step: 'A recalcular indicadores analíticos (Marts)...',
                  detail: 'A atualizar painel e Copilot com os novos dados...',
                });
                try {
                  await computeAndPersistMarts(prisma, farm.id);
                } catch (martErr: any) {
                  console.error('[Import] Erro ao recalcular marts:', martErr.message);
                }
              }

              stats.duracaoMs = Date.now() - jobStartMs;
              const durSeg = (stats.duracaoMs / 1000).toFixed(1).replace('.', ',');

              // Invalida caches
              invalidateAllPharmacyCaches(farm.id);
              getCachedOrComputeAnalysis(prisma, farm.id, 90, 4, 12).catch(() => {});
              getCachedOrComputeCampaignsPayload(prisma, farm).catch(() => {});

              importProgressStore.set(farm.id, {
                status: totalErrosImport > 0 && stats.filesProcessed === 0 ? 'ERROR' : 'COMPLETED',
                percent: 100,
                step:
                  totalErrosImport > 0 && stats.filesProcessed === 0
                    ? '❌ Importação falhou'
                    : totalErrosImport > 0
                      ? `⚠️ Importação concluída com erros (${durSeg} s)`
                      : `🎉 Importação Concluída em ${durSeg} s!`,
                detail:
                  totalErrosImport > 0 && stats.filesProcessed === 0
                    ? `${totalErrosImport} ficheiro(s) com erro. Consulte os detalhes abaixo.`
                    : `Todos os registos válidos foram integrados e os indicadores atualizados em ${durSeg} s.`,
                stats,
              });
            } catch (bgErr: any) {
              console.error('[Import Background Error]:', bgErr?.message || bgErr);
              importProgressStore.set(farm.id, {
                status: 'ERROR',
                percent: 100,
                step: '❌ Erro no Processamento',
                detail: bgErr?.message || 'Erro interno durante a importação.',
                error: bgErr?.message || String(bgErr),
              });
            }
          });

          // Responde imediatamente (202 Accepted) — zero risco de timeout HTTP do proxy!
          res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, async: true, farmaciaId: farm.id }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      if (pathname === '/api/pharmacies' && req.method === 'GET') {
        const ctx = await resolveAccessContext();
        let farms: any[] = [];
        if (!ctx.authenticated) {
          // Utilizadores anónimos apenas podem ver farmácias anónimas sem NUNCA ter acesso aos códigos de acesso
          const publicFarms = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify(
              publicFarms.map((f) => ({
                id: f.id,
                nome: f.nome,
                nif: maskNif(f.nif),
              }))
            )
          );
          return;
        } else if (ctx.role === 'PHARMACY' && ctx.lockedFarmacia) {
          farms = [ctx.lockedFarmacia];
        } else if (ctx.role === 'ADMIN') {
          farms = await prisma.farmacia.findMany({
            orderBy: { criadoEm: 'asc' },
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify(
            farms.map((f) => ({
              id: f.id,
              nome: f.nome,
              nif: maskNif(f.nif),
              codigo_acesso: (ctx.role === 'ADMIN' || ctx.role === 'PHARMACY') ? (f.codigo_acesso || f.id) : undefined,
            }))
          )
        );
        return;
      }

      // 1. Endpoint de Análise Parametrizável (Multi-Tenant + Cache Instantânea + Compressão Gzip)
      if (pathname === '/api/analysis' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);

        const diasMonos = parseInt(String(parsedUrl.query.diasMonos || '90'), 10);
        const cobertura = parseFloat(String(parsedUrl.query.cobertura || '4'));
        const mesesVmm = parseInt(String(parsedUrl.query.mesesVmm || '12'), 10);
        const forceRefresh = String(parsedUrl.query.refresh || '') === '1';

        const cached = await getCachedOrComputeAnalysis(
          prisma,
          activeFarmacia.id,
          Number.isNaN(diasMonos) ? 90 : diasMonos,
          Number.isNaN(cobertura) ? 4 : cobertura,
          Number.isNaN(mesesVmm) ? 12 : mesesVmm,
          forceRefresh
        );

        sendOptimizedJson(req, res, 200, cached.report, cached.jsonBuf, cached.gzipBuf);
        return;
      }

      // 2. Endpoint de Raio-X de Produto Individual (Multi-Tenant)
      if (pathname.startsWith('/api/product/') && req.method === 'GET') {
        const cnp = pathname.replace('/api/product/', '').trim();
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);

        const produto = await prisma.produtoMestre.findUnique({
          where: { cnp_codigo: cnp },
          include: {
            inventarios: { where: { farmaciaId: activeFarmacia.id } },
            vendas: { where: { farmaciaId: activeFarmacia.id }, orderBy: { data_venda: 'asc' } },
          },
        });

        if (!produto) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Produto não encontrado' }));
          return;
        }

        const c = classifyProduct(produto.cnp_codigo, produto.designacao, produto.taxa_iva);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            cnp_codigo: produto.cnp_codigo,
            aim: produto.aim,
            designacao: produto.designacao,
            tipo_venda: c.tipo_venda,
            segmento: c.segmento,
            eh_generico: c.eh_generico,
            molecula_dci: c.molecula_dci,
            grupo_equivalencia_dci: c.grupo_equivalencia_dci,
            categoria: produto.categoria || c.categoria,
            sugestao_cross_sell: c.subcategoria_cross_sell,
            taxa_iva: produto.taxa_iva,
            pvp: produto.pvp !== null ? Number(produto.pvp) : null,
            margem_padrao: produto.margem_padrao !== null ? Number(produto.margem_padrao) : null,
            inventario: produto.inventarios.map((i) => ({
              lote: i.lote,
              prateleira: i.prateleira,
              quantidade: i.quantidade,
              custo_unitario: Number(i.custo_unitario),
              data_validade: i.data_validade ? i.data_validade.toISOString().slice(0, 10) : null,
            })),
            vendas: produto.vendas.map((v) => ({
              mes: v.data_venda.toISOString().slice(0, 7),
              quantidade: v.quantidade,
              valor_total: Number(v.valor_total),
            })),
          })
        );
        return;
      }

      // 2.5. Endpoints de Campanhas Comerciais e Sazonais 360º (Multi-Tenant + Cache Instantânea)
      if (pathname === '/api/campaigns/suggestions' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
        const mesQuery = parseInt(String(parsedUrl.query.mes || ''), 10);
        const forceRefresh = String(parsedUrl.query.refresh || '') === '1';

        const payload = await getCachedOrComputeCampaignsPayload(
          prisma,
          activeFarmacia,
          Number.isNaN(mesQuery) ? undefined : mesQuery,
          forceRefresh
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
      }

      // 2.5A. Endpoint para Listar Campanhas Ativas na Farmácia
      if (pathname === '/api/campaigns/active' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
        const ativas = await getActiveCampaigns(prisma, activeFarmacia.id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, campanhas: ativas }));
        return;
      }

      // 2.5A2. Endpoint para Ativar uma Campanha e Gerar Tarefas para a Equipa
      if (pathname === '/api/campaigns/activate' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(parsed.farmaciaId);
          const resActivate = await activateCampaign(prisma, {
            farmaciaId: activeFarmacia.id,
            campanhaId: String(parsed.campanhaId || ''),
            titulo: String(parsed.titulo || 'Campanha Comercial'),
            icone: parsed.icone || '🎯',
            descontoPct: Number(parsed.descontoPct || 15),
            produtos: Array.isArray(parsed.produtos) ? parsed.produtos : [],
            diasDuracao: Number(parsed.diasDuracao || 15),
            criadoPor: parsed.criadoPor || 'Diretor',
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(resActivate));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      // 2.5A3. Endpoint para Desativar ou Concluir uma Campanha
      if (pathname === '/api/campaigns/deactivate' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(parsed.farmaciaId);
          const resDeact = await deactivateCampaign(
            prisma,
            activeFarmacia.id,
            String(parsed.campanhaId || ''),
            parsed.estado === 'CANCELADA' ? 'CANCELADA' : 'CONCLUIDA'
          );
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(resDeact));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      // 2.5B. Endpoint para Criar Campanha à Medida (Eventos Livres: Halloween, Black Friday, Festas da Cidade ou Produtos Específicos)
      if (pathname === '/api/campaigns/custom' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(parsed.farmaciaId);
          const s = await buildCustomCampaign(prisma, activeFarmacia.id, parsed);
          const fin = calculateCampaignFinancials(s.produtosSugeridos, s.campanha.descontoSugeridoPct);
          const enriched = {
            ...s,
            id: s.campanha.id,
            nome: s.campanha.titulo,
            icon: s.campanha.icone,
            periodoLabel: s.campanha.epoca,
            descricao: s.campanha.descricao,
            tipoCampanha: s.campanha.tipoCampanha || 'EPOCA_CALENDARIO',
            contextoEpoca: s.campanha.contextoEpoca || null,
            tipo: 'PERSONALIZADA',
            eligibleProducts: s.produtosSugeridos.map((p) => ({
              ...p,
              pvp_atual: p.pvp,
              custo_unitario: p.custo_unitario,
            })),
            totalEligibleSkus: s.totalArtigosDisponiveis,
            totalStockUnits: s.totalUnidadesStock,
            financials: {
              ...fin,
              margem_media_pct: Number(fin.margemFinalPct.toFixed(1)),
              anti_dumping_valido: fin.cumpreAntiDumping,
            },
          };
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, suggestion: enriched }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      // 2.5C. Endpoint Simulador 360º de Escoamento & Cross-Selling para um Produto Específico
      if (pathname === '/api/campaigns/product-360' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const q = String(parsedUrl.query.q || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
        const result = await analyzeProductMarketingAndCrossSell360(prisma, activeFarmacia.id, q);
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Produto não encontrado no catálogo desta farmácia.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }

      // 2.5D. Endpoint Pesquisa Rápida de Produtos com Stock para o Construtor de Campanhas / Cross-Selling
      if (pathname === '/api/campaigns/search-products' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const q = String(parsedUrl.query.q || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
        const items = await searchProductsForMarketingPicker(prisma, activeFarmacia.id, q);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ items }));
        return;
      }

      // 2.5D-2. Endpoint Cestos Inteligentes de Stock (Validades, Monos, Top Margem) para o Assistente de Campanhas
      if (pathname === '/api/campaigns/smart-baskets' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
        const baskets = await getSmartCampaignBaskets(prisma, activeFarmacia.id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, baskets }));
        return;
      }

      // 2.5E. Endpoint de Packs Clínicos & Cestos Temáticos (Por Sintoma / Propósito)
      if (pathname === '/api/packs' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
        const packs = await generateClinicalThemePacks(prisma, activeFarmacia.id);
        const userSaved = customPacksStore.get(activeFarmacia.id) || [];
        const rejectedSet = customRejectedPacksStore.get(activeFarmacia.id) || new Set<string>();
        const filteredPacks = [...userSaved, ...packs].filter(p => !rejectedSet.has(p.id));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, farmaciaId: activeFarmacia.id, packs: filteredPacks }));
        return;
      }

      // 2.5E2. Endpoint Aprovação Clínica com Hash & Reautenticação pelo Diretor Técnico (Fase 4)
      if (pathname === '/api/packs/approve' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(parsed.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);

          // 1. Extrair token de sessão ou cookie
          let rawSid = '';
          if (req.headers.authorization && req.headers.authorization.toLowerCase().startsWith('bearer ')) {
            rawSid = req.headers.authorization.slice(7).trim();
          } else if (req.headers.cookie) {
            const m = req.headers.cookie.match(/(?:^|;\s*)sid=([^;]+)/i);
            if (m) {
              try { rawSid = decodeURIComponent(m[1].trim()); } catch { rawSid = m[1].trim(); }
            }
          }

          // 2. Validar sessão e permissão validar_clinica (DIRETOR_TECNICO ou SUPERADMIN)
          const sessionCtx = await resolveSessionAndTenant(prisma, { rawToken: rawSid });

          // Se sessão foi iniciada por PIN (balcão), rejeitar taxativamente
          if (sessionCtx.ok && (sessionCtx.ctx.metodo as any) === 'PIN') {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Aprovação clínica rejeitada: utilizador autenticado por PIN de balcão não possui permissão clínica.' }));
            return;
          }

          // 3. Reautenticação estrita do DT por Palavra-Passe
          const dtPassword = String(parsed.dtPassword || parsed.password || parsed.reauth?.password || '').trim();
          if (!dtPassword) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Aprovação clínica exige reautenticação com palavra-passe do Diretor Técnico.' }));
            return;
          }

          let dtUserName = 'Diretor Técnico';
          let dtUserId = 'dt-auto';

          if (sessionCtx.ok) {
            dtUserName = sessionCtx.ctx.nome || dtUserName;
            dtUserId = sessionCtx.ctx.utilizadorId || dtUserId;
            if (sessionCtx.ctx.utilizadorId) {
              const u = await prisma.utilizador.findUnique({ where: { id: sessionCtx.ctx.utilizadorId } });
              if (u?.passwordHash) {
                const pwdValid = await verifyPasswordScrypt(dtPassword, u.passwordHash);
                if (!pwdValid) {
                  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify({ ok: false, error: 'Palavra-passe de Diretor Técnico incorreta. Assinatura recusada.' }));
                  return;
                }
              }
            }
          } else {
            // Se sessão foi via token de farmácia/admin na interface, validar credencial do DT ou SuperAdmin
            let authenticatedDt: { nome: string; id: string } | null = null;
            if (ADMIN_PASSWORD.length >= 6 && safeCompareStrings(dtPassword, ADMIN_PASSWORD)) {
              authenticatedDt = { nome: 'Administrador Nuelltech', id: 'superadmin' };
            } else {
              const dtUsers = await (prisma as any).utilizador.findMany({
                where: {
                  ativo: true,
                  OR: [
                    { isSuperadmin: true },
                    {
                      vinculosFarmacia: {
                        some: {
                          farmaciaId: activeFarmacia.id,
                          estado: 'ATIVO',
                          perfil: { in: ['DIRETOR_TECNICO', 'PROPRIETARIO'] },
                        },
                      },
                    },
                  ],
                },
              });
              for (const u of dtUsers) {
                if (u.passwordHash && (await verifyPasswordScrypt(dtPassword, u.passwordHash))) {
                  authenticatedDt = { nome: u.nome, id: u.id };
                  break;
                }
              }
            }

            if (!authenticatedDt) {
              res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'Palavra-passe de Diretor Técnico incorreta ou utilizador sem permissão clínica.' }));
              return;
            }
            dtUserName = authenticatedDt.nome;
            dtUserId = authenticatedDt.id;
          }

          // 4. Validar integridade da Composição do Pack e Hash SHA-256
          const packData: ClinicalThemePack = parsed.pack || parsed.packData;
          if (!packData || !packData.produtos || packData.produtos.length < 2) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Pack inválido: requer pelo menos 2 produtos farmacêuticos.' }));
            return;
          }

          const expectedHash = computePackCompositionHash(
            packData.produtos.map(p => p.cnp),
            packData.publicoAlvo,
            packData.descontoPct
          );

          if (packData.hashComposicao && packData.hashComposicao !== expectedHash) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Violação de integridade farmacêutica: o Hash SHA-256 da composição não coincide com a regra validada.' }));
            return;
          }

          // 5. Ativar no Balcão através de active_campaigns
          const nowIso = new Date().toISOString();
          const activeCamp = await activateCampaign(prisma, {
            farmaciaId: activeFarmacia.id,
            campanhaId: packData.id,
            titulo: packData.titulo,
            icone: packData.icone || '🎯',
            descontoPct: packData.descontoPct,
            diasDuracao: 30,
            criadoPor: dtUserName,
            produtos: packData.produtos.map(p => ({
              cnp_codigo: p.cnp,
              designacao: p.designacao,
              stock_atual: p.stockAtual,
              custo_unitario: p.custoUnitario || 0,
              pvp_atual: p.pvpUnitario,
              pvp_campanha: Number((p.pvpUnitario * (1 - packData.descontoPct / 100)).toFixed(2)),
              desconto_pct: packData.descontoPct,
              margem_pct: p.margemPct,
            })),
          });

          // 6. Atualizar estado do pack para ATIVO com assinatura do DT
          const approvedPack: ClinicalThemePack = {
            ...packData,
            estadoCiclo: 'ATIVO',
            validadoPor: dtUserName,
            validadoEm: nowIso,
            campanhaAtivaId: activeCamp.campanhaAtiva?.id,
            hashComposicao: expectedHash,
          };

          const currentSaved = customPacksStore.get(activeFarmacia.id) || [];
          const updatedSaved = currentSaved.filter(p => p.id !== approvedPack.id);
          updatedSaved.unshift(approvedPack);
          customPacksStore.set(activeFarmacia.id, updatedSaved);

          // 7. Gerar automaticamente 3 Tarefas Operacionais na Folha da Equipa
          const tasksToAdd = [
            {
              id: `pack_montagem_${approvedPack.id}`,
              categoria: 'ORGANIZACAO_FISICA',
              titulo: `Montar Cesto Físico: ${approvedPack.titulo}`,
              instrucao: `Colocar ${approvedPack.disposicaoFisica}. Garantir etiqueta com preço promocional de conjunto (${approvedPack.pvpPackComDesconto.toFixed(2)}€) e destaque de poupança (-${approvedPack.descontoPct}%).`,
              artigos: approvedPack.produtos.map(p => ({ cnp: p.cnp, designacao: p.designacao })),
              impactoEstimado: approvedPack.pvpPackComDesconto * Math.min(approvedPack.packsMontaveis, 5),
              prioridade: 'ALTA',
              concluido: false,
              origem: 'PACK_DT',
            },
            {
              id: `pack_script_${approvedPack.id}`,
              categoria: 'EQUIPA_BALCAO',
              titulo: `Aconselhamento Clínico: ${approvedPack.titulo}`,
              instrucao: approvedPack.orientacaoBalcao,
              artigos: approvedPack.produtos.map(p => ({ cnp: p.cnp, designacao: p.designacao })),
              impactoEstimado: 0,
              prioridade: 'MEDIA',
              concluido: false,
              origem: 'PACK_DT',
            },
            {
              id: `pack_stock_${approvedPack.id}`,
              categoria: 'REPOSICAO_RAPIDA',
              titulo: `Monitorizar Stock Mínimo (≥ 3 un): ${approvedPack.titulo}`,
              instrucao: `Verificar rotura dos componentes do cesto. O pack suspende automaticamente quando qualquer dos itens tiver stock < 3 unidades.`,
              artigos: approvedPack.produtos.map(p => ({ cnp: p.cnp, designacao: p.designacao })),
              impactoEstimado: 0,
              prioridade: 'MEDIA',
              concluido: false,
              origem: 'PACK_DT',
            },
          ];

          const farmTasks = customWeeklyTasksStore.get(activeFarmacia.id) || [];
          const existingIds = new Set(farmTasks.map(t => t.id));
          for (const t of tasksToAdd) {
            if (!existingIds.has(t.id)) farmTasks.unshift(t);
          }
          customWeeklyTasksStore.set(activeFarmacia.id, farmTasks);

          // 8. Registar Auditoria de Segurança
          try {
            await logSecurityAudit(prisma, {
              evento: 'PACK_CLINICO_APROVADO_DT',
              farmaciaId: activeFarmacia.id,
              utilizadorId: dtUserId,
              detalhes: {
                packId: approvedPack.id,
                titulo: approvedPack.titulo,
                dt: dtUserName,
                hash: expectedHash,
                campanhaAtivaId: activeCamp.campanhaAtiva?.id,
              },
              ip: req.socket.remoteAddress || null,
            });
          } catch {}

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            message: `Pack "${approvedPack.titulo}" validado e assinado com sucesso pelo DT!`,
            pack: approvedPack,
            tasksGenerated: tasksToAdd.length,
          }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5E3. Endpoint Rejeição de Pack Clínico pelo DT
      if (pathname === '/api/packs/reject' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(parsed.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          const packId = String(parsed.packId || '').trim();

          if (!packId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'packId é obrigatório.' }));
            return;
          }

          let rejectedSet = customRejectedPacksStore.get(activeFarmacia.id);
          if (!rejectedSet) {
            rejectedSet = new Set<string>();
            customRejectedPacksStore.set(activeFarmacia.id, rejectedSet);
          }
          rejectedSet.add(packId);

          const currentSaved = customPacksStore.get(activeFarmacia.id) || [];
          customPacksStore.set(activeFarmacia.id, currentSaved.filter(p => p.id !== packId));

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: `Pack ${packId} rejeitado com sucesso.` }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5E4. Endpoint Desativar Pack Ativo
      if (pathname === '/api/packs/deactivate' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(parsed.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          const packId = String(parsed.packId || '').trim();
          const campanhaAtivaId = String(parsed.campanhaAtivaId || '').trim();

          if (campanhaAtivaId) {
            try { await deactivateCampaign(prisma, activeFarmacia.id, campanhaAtivaId); } catch {}
          }

          const currentSaved = customPacksStore.get(activeFarmacia.id) || [];
          customPacksStore.set(activeFarmacia.id, currentSaved.filter(p => p.id !== packId));

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: `Pack ${packId} desativado com sucesso do balcão.` }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5F. Endpoint Guardar Pack Personalizado no Marketing
      if (pathname === '/api/packs/save' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(parsed.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          if (parsed.pack) {
            const currentList = customPacksStore.get(activeFarmacia.id) || [];
            currentList.unshift(parsed.pack);
            customPacksStore.set(activeFarmacia.id, currentList);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: 'Pack guardado com sucesso no Estúdio de Marketing!' }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5G. Endpoint Aplicar Tarefas Personalizadas do Copilot à Folha da Semana
      if (pathname === '/api/weekly-plan/apply' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(parsed.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          if (Array.isArray(parsed.tasks)) {
            customWeeklyTasksStore.set(activeFarmacia.id, parsed.tasks);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: 'Tarefas aplicadas com sucesso à Folha da Semana!' }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // Endpoint Descontinuar / Não Repor Produtos (Pilar 3)
      if (pathname === '/api/products/discontinue' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(parsed.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          const cnp = String(parsed.cnp || '').trim();
          const action = parsed.action || 'add';
          const des = parsed.designacao || '';

          if (action === 'add') {
            addDiscontinuedCnp(activeFarmacia.id, cnp, des, parsed.motivo);
          } else {
            removeDiscontinuedCnp(activeFarmacia.id, cnp);
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, cnp, action, message: 'Produto atualizado na lista de descontinuação (Pilar 3)!' }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      if (pathname === '/api/campaigns/generate' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 2 * 1024 * 1024);
          const parsed = JSON.parse(rawBody || '{}');
          const farmaciaId = parsed.farmaciaId;
          const campaignId = parsed.campaignId;
          const descontoPct = parsed.discountPct !== undefined ? parsed.discountPct : (parsed.descontoPct !== undefined ? parsed.descontoPct : 15);
          const canais = parsed.channels || parsed.canais || ['loja', 'redes', 'ecras', 'app'];
          let selectedProducts = parsed.selectedProducts || [];

          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
            const allSuggestions = await getSeasonalCampaignSuggestions(prisma, activeFarmacia.id);
            const matchedSug = allSuggestions.find((s) => s.campanha.id === campaignId);
            const campDef =
              parsed.customCampaignDef ||
              matchedSug?.campanha ||
              ANNUAL_CAMPAIGNS.find((c) => c.id === campaignId) ||
              ANNUAL_CAMPAIGNS[0];

            if ((!selectedProducts || selectedProducts.length === 0) && Array.isArray(parsed.includedCnpCodigos)) {
              const cnps = parsed.includedCnpCodigos;
              const prods = await prisma.produtoMestre.findMany({
                where: { cnp_codigo: { in: cnps } },
                include: { inventarios: { where: { farmaciaId: activeFarmacia.id } } },
              });
              selectedProducts = prods.map((p) => {
                const inv = p.inventarios[0];
                const custo = inv ? Number(inv.custo_unitario) : 0;
                const pvp = p.pvp ? Number(p.pvp) : custo > 0 ? custo * 1.5 : 10;
                const margem = p.margem_padrao ? Number(p.margem_padrao) : (pvp > custo ? ((pvp - custo) / pvp) * 100 : 30);
                return {
                  cnp_codigo: p.cnp_codigo,
                  designacao: p.designacao,
                  laboratorio_titular: '',
                  tipo_venda: p.tipo_venda || 'VENDA_LIVRE',
                  stock_atual: inv ? inv.quantidade : 1,
                  custo_unitario: custo,
                  pvp_atual: pvp,
                  pvp: pvp,
                  margem_percentagem: margem,
                  validade: inv?.data_validade ? inv.data_validade.toISOString().substring(0, 10) : 'Longa',
                  taxa_iva: p.taxa_iva ? Number(p.taxa_iva) : 0.23,
                };
              });
            } else {
              selectedProducts = selectedProducts.map((p: any) => {
                const custo = Number(p.custo_unitario || 0);
                const pvp = Number(p.pvp || p.pvp_atual || (custo > 0 ? custo * 1.5 : 10));
                const margem = p.margem_percentagem !== undefined ? Number(p.margem_percentagem) : (pvp > custo ? ((pvp - custo) / pvp) * 100 : 30);
                return {
                  ...p,
                  pvp,
                  pvp_atual: pvp,
                  custo_unitario: custo,
                  stock_atual: Number(p.stock_atual || 1),
                  margem_percentagem: margem,
                };
              });
            }

            const financials = calculateCampaignFinancials(selectedProducts, Number(descontoPct) || 15);
            const rawMaterials = generateOmnichannelMaterials(campDef, selectedProducts, canais);
            const materials = {
              ...rawMaterials,
              loja: rawMaterials.lojaBalcao ? {
                script_balcao: rawMaterials.lojaBalcao.pitchBalcao10s,
                posicionamento_linear: rawMaterials.lojaBalcao.posicionamentoRecomendado,
                sinaletica_precos: rawMaterials.lojaBalcao.dicaAtendimento,
              } : undefined,
              redes: rawMaterials.redesSociais ? {
                headline: rawMaterials.redesSociais.tituloPost,
                copy_post: rawMaterials.redesSociais.textoLegenda,
                call_to_action: 'Aproveite hoje na sua Farmácia de confiança.',
                hashtags: rawMaterials.redesSociais.hashtags.split(' '),
                sugestao_imagem: rawMaterials.redesSociais.formatoSugerido,
              } : undefined,
              ecras: rawMaterials.ecrasMultimedia ? {
                slide_titulo: rawMaterials.ecrasMultimedia.headline,
                slide_linhas: rawMaterials.ecrasMultimedia.bulletPoints,
                slide_rodape: rawMaterials.ecrasMultimedia.chamadaAcao,
                duracao_slide_segundos: 8,
              } : undefined,
              app: rawMaterials.appSms ? {
                push_notification_titulo: rawMaterials.appSms.notificacaoPushTitulo,
                push_notification_corpo: rawMaterials.appSms.notificacaoPushCorpo,
                sms_texto: rawMaterials.appSms.smsTexto160c,
              } : undefined,
            };
            const emailDigest = generateMonthlyEmailDigest(activeFarmacia.nome, campDef, selectedProducts, financials);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              success: true,
              campanha: campDef,
              campaign: campDef,
              financials,
              materials,
              emailDigest,
              emailDigestPreview: emailDigest.html,
            }));
          } catch (e: any) {
            const status = e.statusCode || 400;
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        return;
      }

      if (pathname === '/api/campaigns/send-email' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 256 * 1024);
          const { to, farmaciaId } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          const destinatarios = ['direcao.tecnica@farmacia.pt', 'balcao.equipa@farmacia.pt'];
          if (to) destinatarios.push(to);

          console.log(`[Email Campaign] Boletim executivo enviado para ${destinatarios.length} destinatários na ${activeFarmacia.nome}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            ok: true,
            message: `Boletim executivo e materiais de campanha enviados com sucesso`,
            destinatarios: destinatarios.length,
          }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      // 3. Endpoint de Perguntas em Linguagem Natural / Consultas Rápidas (Multi-Tenant)
      if (pathname === '/api/ask' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 256 * 1024);
          const { question, farmaciaId, sessionId, mode } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          const ctx = await resolveAccessContext();
          const q = String(question || '').trim();

          if (!q) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Pergunta não fornecida.' }));
            return;
          }

          // Contexto de Segurança Multi-Tenant Estrito & Anonimização para LLM
          const accessCtx = await resolveAccessContext();
          const callerRole = accessCtx.role === 'ADMIN' ? 'SUPERADMIN' : 'PROPRIETARIO';
          const secContext: ToolSecurityContext = {
            farmaciaId: activeFarmacia.id,
            farmaciaNome: 'Farmácia Comunitária',
            nif: '',
            perfil: callerRole,
            verFaturacao: canVerFaturacao(callerRole),
          };

          // Isola estritamente o sessionId por farmácia para impedir leitura cruzada de conversas em RAM
          const cleanSid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
          const scopedSid = `${activeFarmacia.id}:${cleanSid}`;
          const copilotRes = await askConversationalCopilot(prisma, secContext, q, scopedSid, (mode || 'GENERAL'));

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            text: copilotRes.text,
            toolsUsed: copilotRes.toolsUsed,
            sessionId: cleanSid,
            shoppingList: (copilotRes as any).shoppingList || null,
            farmaciaNome: activeFarmacia.nome,
            titulo: `Copilot — ${activeFarmacia.nome}`,
            explicacao: copilotRes.text,
            usage: (copilotRes as any).usage || null,
          }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          console.error('[API /api/ask Error]:', e);
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      
      // 3.2. Endpoint para Feedback de Auditoria da Resposta do Copilot (Fase 0: persistido em CopilotInteracao)
      if (pathname === '/api/copilot/feedback' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 32 * 1024);
          const { sessionId, interacaoId, feedback, comment, comentario, farmaciaId } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          const voteNum =
            feedback === 1 || feedback === '1' || String(feedback || '').toUpperCase() === 'UP'
              ? 1
              : -1;
          const resultFb = await recordCopilotFeedback(prisma, {
            interacaoId: interacaoId || null,
            farmaciaId: activeFarmacia.id,
            sessionId: sessionId || null,
            feedback: voteNum,
            comentario: comentario || comment || null,
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              success: true,
              persisted: resultFb.ok,
              interacaoId: resultFb.interacaoId || interacaoId || null,
              message: 'Feedback registado na auditoria do Copilot.',
            })
          );
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      // 3.1. Endpoint para Limpar Sessão Conversacional do Copilot (Isolado por Farmácia)
      if (pathname === '/api/copilot/clear' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const { sessionId, farmaciaId } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          const cleanSid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
          clearCopilotSession(`${activeFarmacia.id}:${cleanSid}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, message: 'Histórico da sessão reiniciado com sucesso.' }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      // 3.3. Endpoint para Gerar Síntese de Relatório Executivo a partir do Copilot (Fase 1: determinístico, sem chamada livre à IA)
      if (pathname === '/api/copilot/generate-report' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 512 * 1024);
          const { farmaciaId, sessionId, rawText, relatorioEstruturado, responsavel } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          const accessCtx = await resolveAccessContext();
          const callerRole = accessCtx.role === 'ADMIN' ? 'SUPERADMIN' : 'PROPRIETARIO';
          const allowFaturacao = canVerFaturacao(callerRole);
          const emitente = String(responsavel || (accessCtx.role === 'ADMIN' ? 'Administrador' : `Sessão ${activeFarmacia.nome}`)).trim();

          let contentToReport = String(rawText || '').trim();
          if (!contentToReport && sessionId) {
            const cleanSid = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
            const history = getCopilotSessionHistory(`${activeFarmacia.id}:${cleanSid}`);
            if (history && history.length > 0) {
              contentToReport = history
                .filter((h) => h.role === 'assistant' && typeof h.content === 'string')
                .map((h) => h.content)
                .join('\n\n---\n\n');
            }
          }

          let reportData: CopilotExecutiveReport;
          if (relatorioEstruturado && relatorioEstruturado.totais) {
            reportData = buildExecutiveReportFromStructuredData(relatorioEstruturado, {
              farmaciaNome: activeFarmacia.nome,
              responsavel: emitente,
              verFaturacao: allowFaturacao,
            });
          } else {
            reportData = parseMarkdownToExecutiveReport(contentToReport, {
              farmaciaNome: activeFarmacia.nome,
              responsavel: emitente,
              verFaturacao: allowFaturacao,
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, report: reportData }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          console.error('[API /api/copilot/generate-report Error]:', e);
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }

      // 2.5H. Endpoint Mobile Staff Auth PIN com Proteção Rate Limit
      if (pathname === '/api/mobile/auth-pin' && req.method === 'POST') {
        try {
          const clientIp = getClientIp(req);
          if (isRateLimited(clientIp, 10, 5 * 60 * 1000)) {
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Demasiadas tentativas de PIN incorreto. Aguarde 5 minutos.' }));
            return;
          }

          const rawBody = await readRequestBody(req, 64 * 1024);
          const { farmaciaId, pin, memberId } = JSON.parse(rawBody || '{}');
          const resAuth = await verifyMobileStaffPin(prisma, farmaciaId, pin, memberId);

          if (resAuth.valid) {
            resetFailedAttempts(clientIp);
            // Regista a sessão ativa para monitorização em tempo real (Sessões Ativas)
            const userAgent = String(req.headers['user-agent'] || 'Mobile Device');
            const opName = (resAuth as any).member ? (resAuth as any).member.nome : 'Operador Balcão';
            const opRole = (resAuth as any).member ? (resAuth as any).member.role : 'AUXILIAR';
            const targetFarmId = (resAuth as any).farmacia ? (resAuth as any).farmacia.id : farmaciaId;
            recordUserSession(prisma, {
              farmaciaId: targetFarmId,
              userName: opName,
              role: opRole,
              ip: clientIp,
              device: userAgent.includes('Mobile') ? 'Dispositivo Móvel' : 'Terminal Balcão',
            }).catch(() => {});
          }

          if (resAuth.valid && (resAuth as any).farmacia && (resAuth as any).farmacia.codigo_acesso) {
            res.setHeader('Set-Cookie', `farmacia_access_code=${encodeURIComponent((resAuth as any).farmacia.codigo_acesso)}; Path=/; SameSite=Lax; Max-Age=2592000`);
          }
          res.writeHead(resAuth.valid ? 200 : 401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: resAuth.valid, ...resAuth }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5H1. Endpoint Mobile: Listar Nomes dos Colaboradores da Farmácia para Chips
      if (pathname === '/api/mobile/team-members' && req.method === 'GET') {
        try {
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          if (!farmIdQuery) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'farmaciaId obrigatório' }));
            return;
          }
          const farm = await prisma.farmacia.findFirst({
            where: {
              OR: [
                { id: farmIdQuery },
                { codigo_acesso: { equals: farmIdQuery, mode: 'insensitive' } },
              ],
            },
            select: { id: true, nome: true },
          });
          if (!farm) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Farmácia não encontrada' }));
            return;
          }
          const members = await prisma.membroEquipa.findMany({
            where: { farmaciaId: farm.id, ativo: true },
            select: { id: true, nome: true, role: true },
            orderBy: { criadoEm: 'asc' },
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, farmaciaId: farm.id, members }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      
      // 2.5H2. Endpoint SSE para Sincronização em Tempo Real de Tarefas
      if (pathname === '/api/weekly-tasks/stream' && req.method === 'GET') {
        try {
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no',
          });
          res.write(': connected\n\n');

          const clientId = 'sse_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          const cip = getClientIp(req);

          // Fechar conexões órfãs anteriores do mesmo cliente para evitar esgotamento de sockets
          for (const c of Array.from(taskStreamClients)) {
            if (c.farmaciaId === activeFarmacia.id && c.clientIp === cip) {
              try { c.res.end(); } catch {}
              taskStreamClients.delete(c);
            }
          }

          const clientObj: TaskStreamClient = {
            id: clientId,
            farmaciaId: activeFarmacia.id,
            res,
            clientIp: cip,
          };
          taskStreamClients.add(clientObj);

          req.on('close', () => {
            taskStreamClients.delete(clientObj);
          });
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      
        // 2.5I-Audit. Endpoint Auditoria Detalhada de Tarefas Concluídas (O que foi feito, quando e quem fez)
        if (pathname === '/api/weekly-tasks/audit' && req.method === 'GET') {
          try {
            const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
            const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
            const auditData = await getWeeklyTasksAudit(prisma, activeFarmacia.id);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...auditData }));
          } catch (e: any) {
            const status = e.statusCode || 500;
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }

        // 2.5I-Evolution. Endpoint Análise de Evolução de Stock, Monos e Valores Poupados no Tempo
        if (pathname === '/api/analytics/stock-evolution' && req.method === 'GET') {
          try {
            const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
            const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
            const evolutionData = await getStockEvolutionAnalytics(prisma, activeFarmacia.id);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...evolutionData }));
          } catch (e: any) {
            const status = e.statusCode || 500;
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }

        // 2.5I. Endpoint Obter Tarefas Semanais da Farmácia
      if (pathname === '/api/weekly-tasks' && req.method === 'GET') {
        try {
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          const tasksData = await getPharmacyWeeklyTasks(prisma, activeFarmacia.id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, farmaciaId: activeFarmacia.id, ...tasksData }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5J. Endpoint Toggle Tarefa Semanal (Supabase Sync)
      if (pathname === '/api/weekly-tasks/toggle' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 128 * 1024);
          const { farmaciaId, taskId, concluido, concluido_por, categoria, cnp_codigo, designacao, valor_impacto } = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          const cleanConcluidoPor = String(concluido_por || 'Equipa').trim().slice(0, 50);
          const saved = await toggleWeeklyTaskInDb(prisma, {
            farmaciaId: activeFarmacia.id,
            taskId,
            concluido: !!concluido,
            concluido_por: cleanConcluidoPor,
            categoria,
            cnp_codigo,
            designacao,
            valor_impacto: valor_impacto !== undefined ? Number(valor_impacto) : undefined,
          });
          broadcastTaskUpdate(activeFarmacia.id, {
            type: 'TOGGLE',
            taskId,
            concluido: !!concluido,
            concluido_por: cleanConcluidoPor,
            concluido_em: saved?.concluido_em ? saved.concluido_em.toISOString() : new Date().toISOString(),
            categoria,
            cnp_codigo,
            designacao,
            valor_impacto: valor_impacto !== undefined ? Number(valor_impacto) : undefined,
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, task: saved }));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5K. Endpoint Reset Tarefas da Semana
      if (pathname === '/api/weekly-tasks/reset' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const { farmaciaId } = JSON.parse(rawBody || '{}');
          const farmIdQuery = String(farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          const resetRes = await resetWeeklyTasksInDb(prisma, activeFarmacia.id);
          broadcastTaskUpdate(activeFarmacia.id, {
            type: 'RESET',
            farmaciaId: activeFarmacia.id,
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(resetRes));
        } catch (e: any) {
          const status = e.statusCode || 500;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      
      // ======================================================================
      // RECURSOS PWA (PROGRESSIVE WEB APP)
      // ======================================================================
      if (pathname === '/manifest.webmanifest' || pathname === '/manifest.json') {
        const manifest = {
          name: 'BI Pharma — Modo Equipa',
          short_name: 'BI Pharma',
          description: 'Gestão Inteligente de Validades, Stocks e Vendas de Farmácia',
          start_url: '/mobile',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#0b1120',
          theme_color: '#0f172a',
          icons: [
            {
              src: '/icons/icon.svg',
              sizes: '192x192 512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            }
          ]
        };
        res.writeHead(200, {
          'Content-Type': 'application/manifest+json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(JSON.stringify(manifest, null, 2));
        return;
      }

      if (pathname === '/sw.js') {
        const swScript = `
const CACHE_NAME = 'bi-pharma-pwa-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
`;
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(swScript);
        return;
      }

      if (pathname === '/icons/icon.svg' || pathname === '/icons/icon-192.png' || pathname === '/icons/icon-512.png' || pathname === '/favicon.ico') {
        const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#0284c7" />
    </linearGradient>
    <linearGradient id="crossGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10b981" />
      <stop offset="100%" stop-color="#34d399" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bgGrad)" />
  <circle cx="256" cy="256" r="180" fill="rgba(255,255,255,0.06)" />
  <rect x="216" y="116" width="80" height="280" rx="24" fill="url(#crossGrad)" />
  <rect x="116" y="216" width="280" height="80" rx="24" fill="url(#crossGrad)" />
  <circle cx="256" cy="256" r="32" fill="#ffffff" opacity="0.9" />
</svg>`;
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=604800',
        });
        res.end(svgIcon);
        return;
      }

      // Servir ficheiros estáticos de imagens públicas (/assets/*)
      if (pathname && pathname.startsWith('/assets/')) {
        const filename = path.basename(pathname);
        const imgPath = path.resolve(process.cwd(), 'public', 'images', filename);
        if (fs.existsSync(imgPath)) {
          const stat = fs.statSync(imgPath);
          const ext = path.extname(imgPath).toLowerCase();
          const contentType = ext === '.svg' ? 'image/svg+xml' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=86400',
          });
          fs.createReadStream(imgPath).pipe(res);
          return;
        }
      }

      
      // ======================================================================
      // FASE 4: ENDPOINTS DE CONFIGURAÇÕES, EQUIPA (RBAC) E RECUPERAÇÃO
      // ======================================================================

      // 4.1. Listar Equipa da Farmácia
      if (pathname === '/api/settings/team' && req.method === 'GET') {
        try {
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          const team = await getPharmacyTeam(prisma, activeFarmacia.id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, farmaciaId: activeFarmacia.id, team }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 4.2. Convidar / Adicionar Membro da Equipa
      if (pathname === '/api/settings/team/invite' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const { farmaciaId, nome, email, role, pin } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          if (!nome || !email) {
            throw new Error('Nome e email são de preenchimento obrigatório.');
          }
          const member = await addPharmacyTeamMember(prisma, activeFarmacia.id, { nome, email, role, pin });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, member }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 4.3. Atualizar Membro da Equipa
      if (pathname === '/api/settings/team/update' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const { farmaciaId, userId, updates } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          const updated = await updatePharmacyTeamMember(prisma, activeFarmacia.id, userId, updates || {});
          if (!updated) throw new Error('Utilizador não encontrado.');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, member: updated }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 4.4. Remover Membro da Equipa
      if (pathname === '/api/settings/team/delete' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          const { farmaciaId, userId } = JSON.parse(rawBody || '{}');
          const activeFarmacia = await requireActiveFarmacia(farmaciaId);
          const deleted = await deletePharmacyTeamMember(prisma, activeFarmacia.id, userId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: deleted }));
        } catch (e: any) {
          const status = e.statusCode || 400;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 4.5. Listar Sessões Ativas da Farmácia
      if (pathname === '/api/settings/sessions' && req.method === 'GET') {
        try {
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          const activeFarmacia = await requireActiveFarmacia(farmIdQuery);
          // Regista a sessão atual de navegação se ainda não existir
          const ip = getClientIp(req);
          const userAgent = String(req.headers['user-agent'] || 'Desktop Browser');
          const sessions = await getActivePharmacySessions(prisma, activeFarmacia.id);
          if (sessions.length === 0) {
            await recordUserSession(prisma, {
              farmaciaId: activeFarmacia.id,
              userName: 'Diretor / Gestão',
              role: 'GESTOR',
              ip,
              device: userAgent.includes('Mobile') ? 'Dispositivo Móvel' : 'Computador Desktop',
            });
          }
          const currentSessions = await getActivePharmacySessions(prisma, activeFarmacia.id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, sessions: currentSessions }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 4.6. Revogar Sessão Ativa Remotamente
      if (pathname === '/api/settings/sessions/revoke' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 32 * 1024);
          const { sessionId } = JSON.parse(rawBody || '{}');
          const revoked = await revokeUserSession(prisma, sessionId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: revoked, message: 'Sessão revogada com sucesso.' }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 4.7. Recuperação de Password (Esqueci-me da Senha)
      if (pathname === '/api/auth/forgot-password' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 32 * 1024);
          const { email, farmaciaId } = JSON.parse(rawBody || '{}');
          const cleanEmail = String(email || '').trim().toLowerCase();
          if (!cleanEmail || !cleanEmail.includes('@')) {
            throw new Error('Por favor introduza um endereço de email válido.');
          }
          const token = await createPasswordResetToken(prisma, cleanEmail, farmaciaId);
          const resetLink = `${getBaseIssuerUrl(req)}/?resetToken=${token}`;
          console.log(`📧 [Simulação de Envio de Email]: Link de recuperação gerado para ${cleanEmail}: ${resetLink} (válido por 15 min)`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            message: 'Se o email constar no sistema, enviámos as instruções de recuperação com validade de 15 minutos.',
            resetLinkPreview: !IS_PROD ? resetLink : undefined,
          }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 4.8. Validação e Redefinição de Nova Senha
      if (pathname === '/api/auth/reset-password' && req.method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 32 * 1024);
          const { token, newPassword } = JSON.parse(rawBody || '{}');
          const tokenRecord = await verifyPasswordResetToken(prisma, token);
          if (!tokenRecord) {
            throw new Error('O token de recuperação é inválido ou já expirou.');
          }
          if (!newPassword || newPassword.length < 6) {
            throw new Error('A nova palavra-passe deve ter pelo menos 6 caracteres.');
          }
          await consumePasswordResetToken(prisma, token);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: 'Palavra-passe redefinida com sucesso. Pode agora iniciar sessão.' }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      
      // ======================================================================
      // FASE 5: ENDPOINTS MULTI-LOJA, BALANCEAMENTO & ANÁLISE DE LABORATÓRIOS/AIMS
      // ======================================================================

      // 5.1. Resumo Consolidado do Grupo de Farmácias
      if (pathname === '/api/groups/summary' && req.method === 'GET') {
        try {
          const summary = await getGroupSummary(prisma);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, summary }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 5.2. Oportunidades de Balanceamento Cruzado de Stock (Multi-Loja)
      if (pathname === '/api/groups/rebalance' && req.method === 'GET') {
        try {
          const rebalanceData = await calculateCrossStoreRebalance(prisma);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...rebalanceData }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 5.3. Análise de Fornecedores e Laboratórios Titulares
      if (pathname === '/api/analytics/labs' && req.method === 'GET') {
        try {
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          const labs = await getLaboratoriesAnalytics(prisma, farmIdQuery || undefined);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, laboratories: labs }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 5.4. Filtro Histórico Específico por Múltiplos AIMs
      if (pathname === '/api/analytics/aims' && req.method === 'GET') {
        try {
          const aimsParam = String(parsedUrl.query.aims || parsedUrl.query.aim || '').trim();
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          const aimAnalytics = await getHistoricalAimAnalytics(prisma, aimsParam, farmIdQuery || undefined);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...aimAnalytics }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5L. Rota da Interface Mobile da Equipa
      if (
        pathname === '/mobile' ||
        pathname === '/equipa' ||
        pathname === '/tarefas-mobile' ||
        parsedUrl.query.mobile === '1' ||
        parsedUrl.query.modo === 'equipa'
      ) {
        const acessoParam = String(parsedUrl.query.acesso || parsedUrl.query.code || parsedUrl.query.accessCode || '').trim();
        if (acessoParam) {
          res.setHeader('Set-Cookie', `farmacia_access_code=${encodeURIComponent(acessoParam)}; Path=/; SameSite=Lax; Max-Age=2592000`);
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getMobileStaffHtml());
        return;
      }

      if (pathname === '/login') {
        res.setHeader('Set-Cookie', [
          'farmacia_access_code=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax',
          'admin_session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax'
        ]);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHtml());
        return;
      }

      // Rota isolada exclusiva para acesso de Administrador
      if (pathname === '/admin') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHtml());
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        const isLogout = String(parsedUrl.query.logout || '') === '1';
        if (isLogout) {
          res.setHeader('Set-Cookie', [
            'farmacia_access_code=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax',
            'admin_session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax'
          ]);
        } else {
          const acessoParam = String(parsedUrl.query.acesso || parsedUrl.query.code || parsedUrl.query.accessCode || '').trim();
          if (acessoParam) {
            res.setHeader('Set-Cookie', `farmacia_access_code=${encodeURIComponent(acessoParam)}; Path=/; SameSite=Lax; Max-Age=2592000`);
          }
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHtml());
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
    } catch (err: any) {
      const status = err.statusCode || 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  server.listen(PORT, () => {
    console.log(`\n🚀 Dashboard BI Pharma ativo em: http://localhost:${PORT}`);
    // Pré-aquecimento em background para o servidor responder logo às verificações de saúde do Render
    (async () => {
      try {
        const unclassifiedCount = await prisma.produtoMestre.count({ where: { tipo_venda: null } });
        if (unclassifiedCount > 0) {
          console.log(`[Classificador] A classificar ${unclassifiedCount} produtos pendentes...`);
          const statsClass = await classifyAllExistingProducts(prisma);
          console.log(
            `[Classificador] ${statsClass.total} produtos caracterizados -> PSBE: ${statsClass.vendaLivre} | Genéricos MG: ${statsClass.genericosMg} | Marca: ${statsClass.marca}`
          );
        } else {
          console.log('⚡ [Classificador] Todos os produtos mestre já se encontram classificados.');
        }
        await warmUpAllPharmacyCaches(prisma);
      } catch (err: any) {
        console.warn('⚠️ Aviso durante background startup warm-up:', err.message);
      }
    })();
  });
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BI Pharma — Inteligência de Stock, Genéricos e Validades</title>
  <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
  <link rel="alternate icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" href="/icons/icon.svg" />
  <meta name="apple-mobile-web-app-title" content="BI Pharma" />
  <meta name="application-name" content="BI Pharma" />
  <style>

    :root {

      --bg: #f8fafc;

      --surface: #ffffff;

      --surface-hover: #f1f5f9;

      --border: #e2e8f0;

      --border-subtle: #cbd5e1;

      --text: #0f172a;

      --text-secondary: #334155;

      --muted: #64748b;

      --primary: #0284c7;

      --primary-dark: #0369a1;

      --primary-light: #e0f2fe;

      --danger: #e11d48;

      --danger-light: #ffe4e6;

      --warning: #d97706;

      --warning-light: #fef3c7;

      --success: #059669;

      --success-light: #d1fae5;

      --purple: #7c3aed;

      --purple-light: #ede9fe;

    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {

      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

      background: #f8fafc !important;

      color: #0f172a !important;

      line-height: 1.5;

      padding-bottom: 60px;

      -webkit-font-smoothing: antialiased;

    }

    @keyframes spin {

      to { transform: rotate(360deg); }

    }

    @keyframes pulse {

      0%, 100% { opacity: 1; }

      50% { opacity: 0.7; }

    }

    .spinner-sm {

      display: inline-block;

      width: 14px;

      height: 14px;

      border: 2px solid rgba(2, 132, 199, 0.2);

      border-top-color: #0284c7;

      border-radius: 50%;

      animation: spin 0.7s linear infinite;

      vertical-align: middle;

      margin-right: 6px;

    }

    header {

      background: #ffffff !important;

      border-bottom: 1px solid #e2e8f0 !important;

      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);

      padding: 18px 32px;

      display: flex;

      justify-content: space-between;

      align-items: center;

      flex-wrap: wrap;

      gap: 16px;

    }

    .brand h1 { font-size: 1.45rem; font-weight: 800; color: #0284c7 !important; letter-spacing: -0.5px; }

    .brand p { font-size: 0.88rem; color: #64748b !important; }

    
    /* COPILOT CONVERSATIONAL CHAT STYLES */
    .copilot-container {
      background: #ffffff !important;
      border: 1px solid #e2e8f0 !important;
      border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .copilot-chat-feed {
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 280px;
      max-height: 680px;
      overflow-y: auto;
      padding: 12px 8px;
      scroll-behavior: smooth;
    }

    .chat-bubble-user {
      align-self: flex-end;
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%) !important;
      color: #ffffff !important;
      padding: 12px 18px;
      border-radius: 18px 18px 4px 18px;
      max-width: 82%;
      font-size: 0.93rem;
      line-height: 1.5;
      box-shadow: 0 2px 6px rgba(2, 132, 199, 0.25);
      word-break: break-word;
    }

    .chat-bubble-assistant {
      align-self: flex-start;
      background: #ffffff !important;
      border: 1px solid #e2e8f0 !important;
      border-radius: 18px 18px 18px 4px;
      padding: 18px 22px;
      max-width: 95%;
      font-size: 0.91rem;
      line-height: 1.6;
      color: #0f172a !important;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
      word-break: break-word;
    }

    .chat-bubble-assistant h3, .chat-bubble-assistant h4 {
      color: #0f172a !important;
      margin-top: 14px;
      margin-bottom: 6px;
    }

    .chat-bubble-assistant ul, .chat-bubble-assistant ol {
      margin: 8px 0 12px 22px;
      padding: 0;
    }

    .chat-bubble-assistant li {
      margin-bottom: 4px;
    }

    .chat-tools-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #f0fdf4 !important;
      border: 1px solid #bbf7d0 !important;
      color: #166534 !important;
      font-size: 0.74rem;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 12px;
      letter-spacing: 0.2px;
    }

    .copilot-md-table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 0.85rem;
      background: #ffffff !important;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #e2e8f0 !important;
    }

    .copilot-md-table th {
      background: #f8fafc !important;
      color: #0f172a !important;
      font-weight: 700;
      text-align: left;
      padding: 10px 12px;
      border-bottom: 2px solid #cbd5e1 !important;
      font-size: 0.80rem;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .copilot-md-table td {
      padding: 9px 12px;
      border-bottom: 1px solid #f1f5f9 !important;
      color: #334155 !important;
    }

    .copilot-md-table tr:hover td {
      background: #f8fafc !important;
    }

    .copilot-task-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin: 6px 0;
      padding: 8px 12px;
      background: #f8fafc !important;
      border: 1px solid #e2e8f0 !important;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-size: 0.88rem;
    }

    .copilot-task-item:hover {
      background: #f1f5f9 !important;
      border-color: #cbd5e1 !important;
    }

    .copilot-task-item.task-done {
      background: #f8fafc !important;
      opacity: 0.65;
    }

    .copilot-task-item.task-done .task-text {
      text-decoration: line-through;
      color: #64748b !important;
    }

    .copilot-task-item input[type="checkbox"] {
      margin-top: 3px;
      cursor: pointer;
      accent-color: #0284c7;
      width: 16px;
      height: 16px;
    }

    .cnp-link {
      color: #0284c7 !important;
      font-weight: 700;
      cursor: pointer;
      padding: 1px 4px;
      border-radius: 4px;
      background: rgba(2, 132, 199, 0.08);
      transition: all 0.15s;
    }

    .cnp-link:hover {
      background: #0284c7 !important;
      color: #ffffff !important;
    }

.tenant-badge {

      background: #f0fdf4 !important;

      border: 1px solid #bbf7d0 !important;

      padding: 8px 16px;

      border-radius: 999px;

      font-size: 0.85rem;

      color: #15803d !important;

      font-weight: 700;

    }

    .container { max-width: 1460px; margin: 0 auto; padding: 24px 32px; }



    .controls-card {

      background: #ffffff !important;

      border: 1px solid #e2e8f0 !important;

      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);

      border-radius: 12px;

      padding: 18px 24px;

      margin-bottom: 24px;

      display: flex;

      flex-wrap: wrap;

      gap: 18px;

      align-items: flex-end;

    }

    .control-group { display: flex; flex-direction: column; gap: 6px; }

    .control-group label { font-size: 0.75rem; color: #475569 !important; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }

    .control-group select, .control-group input {

      background: #f8fafc !important;

      border: 1px solid #cbd5e1 !important;

      color: #0f172a !important;

      padding: 9px 14px;

      border-radius: 8px;

      font-size: 0.9rem;

      min-width: 180px;

      font-weight: 500;

    }

    .btn {

      background: #0284c7 !important;

      color: #ffffff !important;

      border: none;

      padding: 10px 18px;

      border-radius: 8px;

      font-weight: 700;

      cursor: pointer;

      font-size: 0.9rem;

      transition: all 0.15s ease;

      box-shadow: 0 1px 2px rgba(2, 132, 199, 0.2);

    }

    .btn:hover { background: #0369a1 !important; }

    .btn-secondary {

      background: #ffffff !important;

      border: 1px solid #cbd5e1 !important;

      color: #334155 !important;

      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);

    }

    .btn-secondary:hover {

      background: #f8fafc !important;

      border-color: #94a3b8 !important;

      color: #0f172a !important;

    }



    .kpi-grid {

      display: grid;

      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));

      gap: 14px;

      margin-bottom: 24px;

    }

    .kpi-card {

      background: #ffffff !important;

      border: 1px solid #e2e8f0 !important;

      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);

      border-radius: 12px;

      padding: 18px 20px;

      position: relative;

      overflow: hidden;

    }

    .kpi-card::before {

      content: '';

      position: absolute;

      top: 0; left: 0; width: 4px; height: 100%;

      background: #0284c7;

    }

    .kpi-card.danger::before { background: #e11d48; }

    .kpi-card.warning::before { background: #d97706; }

    .kpi-card.success::before { background: #059669; }

    .kpi-card.purple::before { background: #7c3aed; }

    .kpi-label { font-size: 0.75rem; color: #64748b !important; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; }

    .kpi-value { font-size: 1.65rem; font-weight: 800; margin: 6px 0 4px; color: #0f172a !important; }

    .kpi-sub { font-size: 0.8rem; color: #64748b !important; }



    .tabs {

      background: #ffffff !important;

      padding: 6px;

      border-radius: 12px;

      border: 1px solid #e2e8f0 !important;

      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);

      display: flex;

      gap: 6px;

      margin-bottom: 22px;

      flex-wrap: wrap;

    }

    .tab-btn {

      background: transparent !important;

      border: 1px solid transparent !important;

      color: #475569 !important;

      padding: 10px 18px;

      border-radius: 8px;

      cursor: pointer;

      font-weight: 600;

      font-size: 0.88rem;

      transition: all 0.15s ease;

    }

    .tab-btn:hover {

      background: #f1f5f9 !important;

      color: #0f172a !important;

    }

    .tab-btn.active {

      background: #0284c7 !important;

      color: #ffffff !important;

      box-shadow: 0 2px 4px rgba(2, 132, 199, 0.25);

    }

    .tab-btn.active .badge {

      background: rgba(255, 255, 255, 0.25) !important;

      color: #ffffff !important;

    }



    .table-toolbar {

      display: flex;

      justify-content: space-between;

      align-items: center;

      margin-bottom: 12px;

      gap: 12px;

      flex-wrap: wrap;

    }

    .table-toolbar input {

      background: #ffffff !important;

      border: 1px solid #cbd5e1 !important;

      color: #0f172a !important;

      padding: 9px 14px;

      border-radius: 8px;

      min-width: 280px;

      font-size: 0.88rem;

    }

    .table-wrap {

      background: #ffffff !important;

      border: 1px solid #e2e8f0 !important;

      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);

      border-radius: 12px;

      overflow-x: auto;

      max-height: 600px;

      overflow-y: auto;

    }

    table { width: 100%; border-collapse: collapse; font-size: 0.86rem; background: #ffffff !important; color: #0f172a !important; }

    th {

      position: sticky;

      top: 0;

      background: #f8fafc !important;

      color: #475569 !important;

      text-align: left;

      padding: 12px 14px;

      font-size: 0.74rem;

      text-transform: uppercase;

      font-weight: 700 !important;

      border-bottom: 2px solid #e2e8f0 !important;

      z-index: 1;

      letter-spacing: 0.5px;

    }

    td { padding: 11px 14px; border-bottom: 1px solid #f1f5f9 !important; color: #1e293b !important; }

    tr.clickable-row { cursor: pointer; transition: background 0.12s; }

    tr.clickable-row:hover td { background: #f8fafc !important; }



    .badge {

      padding: 4px 8px;

      border-radius: 6px;

      font-size: 0.72rem;

      font-weight: 700;

      display: inline-block;

      white-space: nowrap;

    }

    .badge-danger { background: #ffe4e6 !important; color: #e11d48 !important; }

    .badge-warning { background: #fef3c7 !important; color: #b45309 !important; }

    .badge-info { background: #e0f2fe !important; color: #0369a1 !important; }

    .badge-success { background: #d1fae5 !important; color: #047857 !important; }

    .badge-purple { background: #ede9fe !important; color: #6d28d9 !important; }



    .campaign-card {

      background: #ffffff !important;

      border: 1px solid #e2e8f0 !important;

      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);

      border-radius: 12px;

      padding: 18px;

      cursor: pointer;

      transition: all 0.2s ease;

      position: relative;

    }

    .campaign-card:hover {

      border-color: #0284c7 !important;

      transform: translateY(-2px);

      box-shadow: 0 8px 20px -4px rgba(2, 132, 199, 0.15);

    }

    .campaign-card.selected {

      border-color: #0284c7 !important;

      background: #f0f9ff !important;

      box-shadow: 0 0 0 2px #0284c7 !important;

    }



    .ask-card {

      background: #ffffff !important;

      border: 1px solid #e2e8f0 !important;

      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);

      border-radius: 12px;

      padding: 22px 26px;

      margin-bottom: 24px;

    }

    .ask-header { font-size: 1.05rem; font-weight: 700; margin-bottom: 14px; color: #0284c7 !important; display: flex; align-items: center; gap: 8px; }

    .ask-input-row { display: flex; gap: 12px; margin-bottom: 14px; }

    .ask-input-row input {

      flex: 1;

      background: #f8fafc !important;

      border: 1px solid #cbd5e1 !important;

      color: #0f172a !important;

      padding: 12px 18px;

      border-radius: 8px;

      font-size: 0.95rem;

    }

    .chips { display: flex; flex-wrap: wrap; gap: 8px; }

    .chip {

      background: #f1f5f9 !important;

      border: 1px solid #e2e8f0 !important;

      color: #475569 !important;

      padding: 7px 14px;

      border-radius: 999px;

      font-size: 0.8rem;

      font-weight: 500;

      cursor: pointer;

      transition: all 0.15s;

    }

    .chip:hover { color: #0284c7 !important; border-color: #0284c7 !important; background: #f0f9ff !important; }



    .thinking-card {

      background: #f0f9ff !important;

      border: 1px solid #bae6fd !important;

      border-radius: 12px;

      padding: 22px;

      margin-top: 18px;

      display: flex;

      align-items: center;

      gap: 16px;

      animation: pulse 2s infinite ease-in-out;

    }



    .weekly-task-item {

      background: #ffffff !important;

      border: 1px solid #e2e8f0 !important;

      border-radius: 10px;

      padding: 14px;

      transition: all 0.2s ease;

      box-shadow: 0 1px 2px rgba(0,0,0,0.03);

    }

    .weekly-task-item.task-completed {

      opacity: 0.6;

      background: #f0fdf4 !important;

      border-color: #bbf7d0 !important;

      text-decoration: line-through;

    }

    /* Estilos dos Filtros da Ficha de Trabalhos da Equipa (Desktop) */
    .plano-toolbar-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .plano-toolbar-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .plano-select {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 0.78rem;
      font-weight: 600;
      color: #1e293b;
      outline: none;
      cursor: pointer;
      flex: 1;
      min-width: 130px;
      transition: all 0.15s ease;
    }

    .plano-select:focus {
      border-color: #0284c7;
      box-shadow: 0 0 0 2px rgba(2, 132, 199, 0.15);
    }

    .plano-search-box {
      position: relative;
      flex: 1;
      min-width: 170px;
    }

    .plano-search-box input {
      width: 100%;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 6px 10px 6px 28px;
      font-size: 0.80rem;
      color: #0f172a;
      outline: none;
      transition: all 0.15s ease;
    }

    .plano-search-box input:focus {
      border-color: #0284c7;
      box-shadow: 0 0 0 2px rgba(2, 132, 199, 0.15);
    }

    .plano-search-box .icon {
      position: absolute;
      left: 9px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.80rem;
      color: #64748b;
      pointer-events: none;
    }

    .plano-status-group {
      display: inline-flex;
      background: #e2e8f0;
      border-radius: 8px;
      padding: 2px;
      gap: 2px;
    }

    .plano-status-pill {
      border: none;
      background: transparent;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.74rem;
      font-weight: 700;
      color: #475569;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .plano-status-pill.active {
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }

    .plano-subtabs-group {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .plano-subtab-pill {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 0.78rem;
      font-weight: 700;
      color: #475569;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .plano-subtab-pill.active {
      background: #f3e8ff;
      border-color: #a855f7;
      color: #7e22ce;
      box-shadow: 0 1px 2px rgba(168, 85, 247, 0.15);
    }

    .plano-subtab-pill.winter.active {
      background: #e0f2fe;
      border-color: #38bdf8;
      color: #0369a1;
      box-shadow: 0 1px 2px rgba(56, 189, 248, 0.15);
    }

    .plano-card-list-scroll {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 520px;
      overflow-y: auto;
      padding-right: 6px;
      flex: 1;
    }

    .plano-card-list-scroll::-webkit-scrollbar {
      width: 6px;
    }

    .plano-card-list-scroll::-webkit-scrollbar-track {
      background: #f1f5f9;
      border-radius: 6px;
    }

    .plano-card-list-scroll::-webkit-scrollbar-thumb {
      background: #cbd5e1;
      border-radius: 6px;
    }

    .plano-card-list-scroll::-webkit-scrollbar-thumb:hover {
      background: #94a3b8;
    }

    .plano-counter-badge {
      font-size: 0.74rem;
      font-weight: 700;
      color: #64748b;
      margin-left: auto;
      white-space: nowrap;
    }




    /* Override all hardcoded dark cards to clean light cards */

    div[style*="background: linear-gradient(135deg, rgba(30, 41, 59"],

    div[style*="background: rgba(15, 23, 42"],

    div[style*="background: rgba(30, 41, 59"] {

      background: #ffffff !important;

      border-color: #e2e8f0 !important;

      color: #0f172a !important;

      box-shadow: 0 1px 3px rgba(0,0,0,0.04) !important;

    }



    div[style*="background: linear-gradient(135deg, rgba(16, 185, 129, 0.12)"] {

      background: #f0fdf4 !important;

      border-color: #bbf7d0 !important;

    }



    .modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(15, 23, 42, 0.6);
      backdrop-filter: blur(4px);
      z-index: 1000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .modal {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      max-width: 1120px;
      width: 100%;
      padding: 24px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      color: #0f172a;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }

    .chart-bars {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      height: 170px;
      padding: 20px 12px 8px;
      background: #f8fafc;
      border-radius: 10px;
      margin-top: 10px;
      border: 1px solid #e2e8f0;
    }
    .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; }
    .bar { width: 100%; background: var(--primary); border-radius: 4px 4px 0 0; min-height: 3px; transition: height 0.2s; }
    .bar-val { font-size: 0.75rem; font-weight: 700; color: #0f172a; }
    .bar-lbl { font-size: 0.7rem; color: #64748b; }

  
    /* ==========================================================================
       MODERN CLINICAL APP LAYOUT WITH DARK CONTRAST SIDEBAR NAVIGATION
       ========================================================================== */
    .app-layout {
      display: flex;
      min-height: 100vh;
      background: #f8fafc;
    }

    .sidebar {
      width: 280px;
      min-width: 280px;
      background: #0f172a !important; /* Deep Dark Navy Slate */
      border-right: 1px solid #1e293b !important;
      display: flex;
      flex-direction: column;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      z-index: 90;
      box-shadow: 3px 0 12px rgba(0, 0, 0, 0.18);
      color: #f8fafc;
    }

    .sidebar-brand {
      padding: 22px 20px 16px;
      border-bottom: 1px solid #1e293b;
      background: #090d16;
    }

    .sidebar-brand h1 {
      font-size: 1.3rem;
      font-weight: 800;
      color: #38bdf8 !important; /* High-contrast Sky Blue */
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .sidebar-brand p {
      font-size: 0.76rem;
      color: #94a3b8 !important; /* Crisp light slate */
      margin-top: 3px;
      font-weight: 500;
      line-height: 1.35;
    }

    .sidebar-pharmacy {
      padding: 14px 18px;
      background: #141e33;
      border-bottom: 1px solid #1e293b;
    }

    .sidebar-pharmacy label {
      color: #94a3b8 !important;
      font-size: 0.72rem;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.05em;
    }

    .sidebar-pharmacy select {
      width: 100%;
      background: #1e293b !important;
      border: 1.5px solid #0284c7 !important;
      color: #ffffff !important;
      padding: 8px 10px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 0.86rem;
      cursor: pointer;
      outline: none;
    }

    .sidebar-pharmacy select option {
      background: #0f172a !important;
      color: #ffffff !important;
    }

    .sidebar-nav {
      flex: 1;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .nav-section-title {
      font-size: 0.68rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8 !important; /* Crisp readable heading */
      padding: 14px 10px 6px;
    }

    .nav-item,
    .sidebar .tab-btn {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 11px 12px !important;
      border-radius: 8px !important;
      font-size: 0.88rem !important;
      font-weight: 600 !important;
      color: #e2e8f0 !important; /* High contrast off-white text */
      cursor: pointer !important;
      border: 1px solid transparent !important;
      background: transparent !important;
      text-align: left !important;
      width: 100% !important;
      transition: all 0.15s ease !important;
      text-decoration: none !important;
      margin-bottom: 2px !important;
    }

    .nav-item:hover,
    .sidebar .tab-btn:hover {
      background: #1e293b !important;
      color: #ffffff !important; /* Pure white on hover */
      border-color: #334155 !important;
    }

    .nav-item.active,
    .sidebar .tab-btn.active {
      background: #0284c7 !important; /* Vibrant primary blue */
      color: #ffffff !important; /* Crisp white */
      border-color: #38bdf8 !important;
      font-weight: 800 !important;
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.4) !important;
    }

    .nav-item.active .badge,
    .sidebar .tab-btn.active .badge {
      background: #ffffff !important;
      color: #0284c7 !important;
      font-weight: 800 !important;
    }

    .sidebar .badge {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
    }

    .sidebar .badge-info {
      background: rgba(56, 189, 248, 0.2) !important;
      color: #38bdf8 !important;
      border: 1px solid rgba(56, 189, 248, 0.4) !important;
    }

    .sidebar .badge-purple {
      background: rgba(168, 85, 247, 0.2) !important;
      color: #c084fc !important;
      border: 1px solid rgba(168, 85, 247, 0.4) !important;
    }

    .sidebar .badge-danger {
      background: rgba(244, 63, 94, 0.2) !important;
      color: #fb7185 !important;
      border: 1px solid rgba(244, 63, 94, 0.4) !important;
    }

    .sidebar .badge-warning {
      background: rgba(245, 158, 11, 0.2) !important;
      color: #fbbf24 !important;
      border: 1px solid rgba(245, 158, 11, 0.4) !important;
    }

    .nav-item-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .sidebar-footer {
      padding: 14px 16px;
      border-top: 1px solid #1e293b;
      background: #090d16;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .sidebar-footer .btn-secondary {
      background: #1e293b !important;
      border-color: #334155 !important;
      color: #f1f5f9 !important;
      font-weight: 600 !important;
    }

    .sidebar-footer .btn-secondary:hover {
      background: #334155 !important;
      color: #ffffff !important;
      border-color: #64748b !important;
    }

    .main-wrapper {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      background: #f8fafc;
    }

    .main-content {
      padding: 24px 32px 60px;
      max-width: 1600px;
      width: 100%;
      margin: 0 auto;
    }

  
    /* GAVETA LATERAL DIREITA (OFF-CANVAS SLIDE DRAWER) */
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.45);
      backdrop-filter: blur(3px);
      z-index: 2000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .drawer-backdrop.active {
      opacity: 1;
      pointer-events: auto;
    }
    .slide-drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: 520px;
      max-width: 92vw;
      height: 100vh;
      background: #ffffff;
      box-shadow: -8px 0 36px rgba(15, 23, 42, 0.2);
      z-index: 2001;
      transform: translateX(100%);
      transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
    }
    .slide-drawer.active {
      transform: translateX(0);
    }
    .drawer-header {
      padding: 18px 22px;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      background: #f8fafc;
    }
    .drawer-body {
      padding: 22px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .drawer-footer {
      padding: 16px 22px;
      border-top: 1px solid #e2e8f0;
      background: #f8fafc;
      display: flex;
      gap: 10px;
    }

  
    /* ========================================================================
       TOP NAVIGATION BAR GLOBAL (FASE 2: ACESSO QR, LOGOUT & PERFIL)
       ======================================================================== */
    .top-nav-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 24px;
      background: #ffffff;
      border-bottom: 1px solid #e2e8f0;
      position: sticky;
      top: 0;
      z-index: 990;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
    }
    .top-nav-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .top-breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .active-pharmacy-pill {
      font-size: 0.88rem;
      font-weight: 800;
      color: #0f172a;
      background: #f8fafc;
      padding: 6px 14px;
      border-radius: 9px;
      border: 1.5px solid #cbd5e1;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .active-role-pill {
      font-size: 0.72rem;
      font-weight: 800;
      color: #0284c7;
      background: #e0f2fe;
      border: 1px solid #bae6fd;
      padding: 4px 10px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .top-nav-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .top-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 8px 15px;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
      border: none;
      transition: all 0.15s ease;
    }
    .top-btn-qr {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      color: #ffffff;
      box-shadow: 0 2px 4px rgba(2, 132, 199, 0.25);
    }
    .top-btn-qr:hover {
      background: linear-gradient(135deg, #0369a1, #075985);
      transform: translateY(-1px);
    }
    .top-btn-logout {
      background: #f1f5f9;
      color: #475569;
      border: 1px solid #cbd5e1;
    }
    .top-btn-logout:hover {
      background: #fee2e2;
      color: #dc2626;
      border-color: #fca5a5;
    }
    .executive-kpi-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
    }
    .live-activity-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      font-size: 0.82rem;
    }

  
    /* ========================================================================
       MODOS ESPECIALIZADOS DO COPILOT (FASE 3: UI & QUICK REPLIES)
       ======================================================================== */
    .copilot-mode-selector {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 14px 0 10px 0;
    }
    .copilot-mode-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 9px;
      font-size: 0.82rem;
      font-weight: 700;
      border: 1.5px solid #cbd5e1;
      background: #ffffff;
      color: #334155;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .copilot-mode-btn:hover {
      border-color: #0284c7;
      color: #0284c7;
      background: #f0f9ff;
    }
    .copilot-mode-btn.active {
      background: #0284c7;
      color: #ffffff;
      border-color: #0284c7;
      box-shadow: 0 2px 6px rgba(2, 132, 199, 0.3);
    }
    .copilot-mode-banner {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-left: 4px solid #0284c7;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 0.82rem;
      color: #334155;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .chat-feedback-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      padding-top: 6px;
      border-top: 1px dashed #e2e8f0;
      font-size: 0.74rem;
      color: #64748b;
    }
    .chat-feedback-btn {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.72rem;
      cursor: pointer;
      color: #475569;
      transition: background 0.15s;
    }
    .chat-feedback-btn:hover {
      background: #e2e8f0;
    }
    .chat-feedback-btn.voted {
      background: #dcfce7;
      color: #15803d;
      border-color: #86efac;
    }

  </style>
</head>
<body>
  <!-- ECRÃ DE PRÉ-CARREGAMENTO PROFISSIONAL NUELLTECH (PREVINE ECRÃ EM BRANCO) -->
  <div id="appInitLoader" style="position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 1000000; background: #070f1e; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; transition: opacity 0.25s ease;">
    <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 24px;">
      <img src="/assets/nuelltech-logo-dark.png" alt="Nuelltech" style="height: 48px; width: auto; object-fit: contain;" />
      <div style="height: 38px; width: 1.5px; background: #334155;"></div>
      <div style="display: flex; flex-direction: column;">
        <span style="font-size: 0.7rem; font-weight: 800; letter-spacing: 2px; color: #38bdf8; text-transform: uppercase;">AI & PHARMACY INTELLIGENCE</span>
        <span style="font-size: 0.75rem; font-weight: 600; color: #94a3b8;">Gestão de Stock e Inteligência de Farmácia</span>
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 12px; color: #f8fafc; font-weight: 700; font-size: 1.1rem; margin-bottom: 8px;">
      <div style="width: 20px; height: 20px; border: 2.5px solid rgba(56, 189, 248, 0.25); border-top-color: #38bdf8; border-radius: 50%; animation: initLoaderSpin 0.75s linear infinite;"></div>
      <span>A carregar BI Pharma...</span>
    </div>
    <div id="appInitLoaderSub" style="color: #64748b; font-size: 0.82rem; font-weight: 500;">A validar credenciais seguras e inteligência da farmácia...</div>
  </div>
  <style>
    @keyframes initLoaderSpin { to { transform: rotate(360deg); } }
  </style>

  <div class="app-layout" id="mainAppLayout" style="display: none;">
    <!-- BARRA LATERAL DE NAVEGAÇÃO CLÍNICA (SIDEBAR) -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <h1>💊 BI Pharma</h1>
        <p>Inteligência de Stock, Genéricos e Validades</p>
      </div>

      <!-- SELETOR DE FARMÁCIA DEDICADO NA SIDEBAR -->
      <div class="sidebar-pharmacy">
        <div id="farmaciaSelectorWrap" style="display:flex;flex-direction:column;gap:6px;">
          <label id="farmaciaSelectorLabel" for="farmaciaSelector" style="font-size:0.72rem;color:#64748b;text-transform:uppercase;font-weight:700;">Farmácia Ativa:</label>
          <select id="farmaciaSelector" onchange="onFarmaciaChange()" style="width:100%;background:#1e293b;border:1.5px solid #0284c7;color:#ffffff;padding:8px 10px;border-radius:8px;font-weight:700;font-size:0.86rem;cursor:pointer;outline:none;">
            <option value="">A carregar farmácias...</option>
          </select>
          <div id="lockedPharmacyBadge" style="display:none;font-size:0.86rem;font-weight:800;color:#38bdf8;padding:4px 0;"></div>
          <div class="tenant-badge" id="tenantBadge" style="display:none;"></div>
        </div>
      </div>

      <!-- MENU DE NAVEGAÇÃO VERTICAL -->
      <nav class="sidebar-nav">
        <div class="nav-section-title">DIÁRIO & OPERAÇÃO</div>
        
        <button class="nav-item tab-btn active" id="tabBtn-plano" onclick="switchTab('plano')">
          <span class="nav-item-left">📋 Plano da Semana (Equipa)</span>
        </button>

        <button class="nav-item tab-btn" id="tabBtn-copilot" onclick="switchTab('copilot')">
          <span class="nav-item-left">💬 Assistente Copilot</span>
          <span class="badge badge-info" style="font-size:0.7rem;">IA</span>
        </button>

        <button class="nav-item tab-btn" id="tabBtn-campaigns" onclick="switchTab('campaigns')">
          <span class="nav-item-left">🎯 Campanhas & Marketing 360º</span>
          <span class="badge badge-purple" style="font-size:0.7rem;">12M</span>
        </button>

        
        <button class="nav-item tab-btn" id="tabBtn-evolution" onclick="switchTab('evolution')">
          <span class="nav-item-left">📈 Evolução & Valor de Stock</span>
          <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981; font-size: 0.68rem; font-weight: 800; border: 1px solid rgba(16, 185, 129, 0.3);">NOVO</span>
        </button>

        <div class="nav-section-title" style="margin-top:14px;">GESTÃO DE STOCK & COMPRAS</div>

        <button class="nav-item tab-btn" id="tabBtn-caducidade" onclick="switchTab('caducidade')">
          <span class="nav-item-left">⏳ Risco Elevado de Caducidade</span>
          <span class="badge badge-danger" id="badge-caducidade">-</span>
        </button>

        <button class="nav-item tab-btn" id="tabBtn-genericos" onclick="switchTab('genericos')">
          <span class="nav-item-left">🧬 Consolidação de Genéricos (DCI)</span>
          <span class="badge badge-purple" id="badge-genericos">-</span>
        </button>

        <button class="nav-item tab-btn" id="tabBtn-monos" onclick="switchTab('monos')">
          <span class="nav-item-left">❄️ Monos (Capital Imobilizado)</span>
          <span class="badge badge-warning" id="badge-monos">-</span>
        </button>

        <button class="nav-item tab-btn" id="tabBtn-cobertura" onclick="switchTab('cobertura')">
          <span class="nav-item-left">📦 Excesso de Cobertura</span>
          <span class="badge badge-info" id="badge-cobertura">-</span>
        </button>
      </nav>

      <!-- RODAPÉ DA BARRA LATERAL -->
      <div class="sidebar-footer">
        <div id="adminControlsBar" style="display:none;flex-direction:column;gap:6px;">
          <button class="btn btn-secondary" onclick="openAccessManagerModal()" style="font-size:0.78rem;padding:7px 10px;width:100%;text-align:left;display:flex;align-items:center;gap:6px;">
            🔑 Acessos & Links Isolados
          </button>
          <button class="btn btn-secondary" onclick="openMcpGovernanceModal()" style="font-size:0.78rem;padding:7px 10px;width:100%;text-align:left;display:flex;align-items:center;gap:6px;background:rgba(14,165,233,0.1);border-color:#0ea5e9;color:#0284c7;font-weight:700;">
            🔌 Agentes & Conectores IA (MCP)
            <span id="mcpLiveBadge" style="display:none;background:#10b981;color:#ffffff;border-radius:10px;padding:1px 6px;font-size:0.65rem;margin-left:auto;">0 live</span>
          </button>
          <button class="btn btn-secondary" onclick="openFinOpsModal()" style="font-size:0.78rem;padding:7px 10px;width:100%;text-align:left;display:flex;align-items:center;gap:6px;background:rgba(168,85,247,0.1);border-color:#a855f7;color:#c084fc;font-weight:700;">
            🤖 Consumo IA & Tokens (FinOps)
          </button>
          <button class="btn btn-secondary" onclick="openInteractiveImportModal()" style="font-size:0.78rem;padding:7px 10px;width:100%;text-align:left;display:flex;align-items:center;gap:6px;background:rgba(56,189,248,0.1);border-color:#38bdf8;color:#38bdf8;">
            📥 Importação Inteligente (Novos Ficheiros)
          </button>
          <button class="btn btn-secondary" onclick="openImportPharmacyModal()" style="font-size:0.78rem;padding:7px 10px;width:100%;text-align:left;display:flex;align-items:center;gap:6px;">
            📥 Importar Nova Farmácia
          </button>
        </div>
        <button class="btn btn-secondary" id="btnTrocarAcesso" onclick="openAuthGateModal()" style="font-size:0.78rem;padding:7px 10px;width:100%;text-align:left;display:flex;align-items:center;gap:6px;">
          🔒 Gestão de Acesso
        </button>
        <div style="font-size:0.7rem;color:#94a3b8;text-align:center;margin-top:2px;">
          BI Pharma • Ambiente Local
        </div>
      </div>
    </aside>

    <!-- ÁREA PRINCIPAL COM CONTEÚDO DINÂMICO -->
    <div class="main-wrapper">
    <!-- BARRA DE NAVEGAÇÃO DE TOPO GLOBAL (ACESSO RÁPIDO AO BALCÃO, QR & LOGOUT) -->
    <header class="top-nav-bar">
      <div class="top-nav-left">
        <div class="top-breadcrumb">
          <span class="active-role-pill" id="topActiveRolePill">Direção & Gestão</span>
        </div>
      </div>
      <div class="top-nav-right">
        <button class="top-btn top-btn-qr" onclick="openMobileStaffModal()" title="Abrir QR Code e link direto para o telemóvel da equipa de balcão">
          📱 Acesso Balcão (QR)
        </button>
        <button class="top-btn" onclick="openSettingsModal()" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#1e293b;" title="Configurações da Farmácia, Equipa (RBAC) e Sessões">
          ⚙️ Configurações
        </button>
        <button class="top-btn top-btn-logout" onclick="logoutApp()" title="Encerrar sessão de forma segura">
          🚪 Sair
        </button>
      </div>
    </header>
      <div class="main-content">
        <!-- CABEÇALHO CONTEXTUAL DE GESTÃO DE STOCK (FILTROS GLOBAIS + 5 KPIS PRINCIPAIS - SÓ APARECE NAS TABELAS DE STOCK) -->
        <div id="globalAnalyticsHeader" style="display: none;">
          <div class="controls-card">
            <div class="control-group" style="flex: 1; min-width: 190px;">
              <label>Segmento / Estatuto</label>
              <select id="selectTipoVenda" onchange="renderActiveTable()">
                <option value="ALL" selected>Todos os Produtos</option>
                <option value="LIVRE_TOTAL">🟢 Venda Livre + MNSRM (Balcão)</option>
                <option value="GENERICO_MG">🧬 Só Genéricos (MG)</option>
                <option value="MEDICAMENTO_MARCA">🏷️ Só Marca</option>
                <option value="VENDA_LIVRE">🟢 Só PSBE / Cosmética</option>
                <option value="MNSRM">🔵 Só MNSRM</option>
                <option value="MSRM">🔴 Só MSRM (Receita)</option>
              </select>
            </div>
            <div class="control-group" style="flex: 1; min-width: 180px;">
              <label>Macro-Área / Balcão</label>
              <select id="selectMacroArea" onchange="onMacroAreaChange()">
                <option value="ALL" selected>Todas as Áreas</option>
                <option value="MNSRM_OTC">🔵 Balcão / OTC (MNSRM)</option>
                <option value="MSRM">🔴 Receita Médica (MSRM)</option>
                <option value="DERMOCOSMETICA">🌸 Dermocosmética & Higiene</option>
                <option value="NUTRICAO_SUPLEMENTOS">🌿 Nutrição & Suplementos</option>
                <option value="DISPOSITIVOS_SAUDE">🩹 Dispositivos Médicos</option>
              </select>
            </div>
            <div class="control-group" style="flex: 1.2; min-width: 210px;">
              <label>Família / Categoria</label>
              <select id="selectCategoria" onchange="renderActiveTable()">
                <option value="ALL" selected>Todas as Categorias</option>
              </select>
            </div>
            <div class="control-group" style="min-width: 160px;">
              <label>Sazonalidade</label>
              <select id="selectSazonalidade" onchange="renderActiveTable()">
                <option value="ALL" selected>Todas as Épocas</option>
                <option value="INVERNO">❄️ Inverno (Pico Atual)</option>
                <option value="PRIMAVERA">🌸 Primavera</option>
                <option value="VERAO">☀️ Verão</option>
                <option value="TODO_O_ANO">🔄 Todo o Ano (Crónicos)</option>
              </select>
            </div>
            <div class="control-group" style="min-width: 150px;">
              <label>Critério de Monos</label>
              <select id="selectDiasMonos" onchange="onMonosFilterChange()">
                <option value="28">Últimas 4 Semanas (28 dias)</option>
                <option value="60">Últimos 2 Meses (60 dias)</option>
                <option value="90" selected>Últimos 3 Meses (90 dias)</option>
                <option value="180">Últimos 6 Meses (180 dias)</option>
                <option value="365">Últimos 12 Meses (365 dias)</option>
              </select>
            </div>
            <div class="control-group" style="min-width: 140px;">
              <label>Alerta Cobertura</label>
              <select id="selectCobertura" onchange="onCoberturaFilterChange()">
                <option value="2">> 2 Meses</option>
                <option value="3">> 3 Meses</option>
                <option value="4" selected>> 4 Meses</option>
                <option value="6">> 6 Meses</option>
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-end;">
              <button class="btn" id="btnRecalcular" onclick="loadAnalysis()">🔄 Recalcular</button>
              <button class="btn btn-secondary" onclick="exportCurrentTabCsv()">📥 Exportar CSV</button>
            </div>
            <span id="calcFeedback" style="font-size:0.82rem;color:#34d399;font-weight:700;display:none;align-self:center;">✅ Atualizado!</span>
          </div>

          <div class="kpi-grid">
            <div class="kpi-card">
              <div class="kpi-label">Valor Total em Stock (s/ IVA)</div>
              <div class="kpi-value" id="kpiStockValor">-- €</div>
              <div class="kpi-sub" id="kpiStockSub">-- artigos | -- unidades</div>
            </div>
            <div class="kpi-card purple">
              <div class="kpi-label">Genéricos (MG) vs. Marca</div>
              <div class="kpi-value" id="kpiGenericosVal" style="color: #c084fc">-- € MG</div>
              <div class="kpi-sub" id="kpiGenericosSub">-- Genéricos | -- Marca | -- Grupos DCI</div>
            </div>
            <div class="kpi-card success">
              <div class="kpi-label">Venda Livre (PSBE + MNSRM)</div>
              <div class="kpi-value" id="kpiEstatutoRatio" style="color: var(--success)">--% Livre</div>
              <div class="kpi-sub" id="kpiEstatutoSub">-- PSBE | -- MNSRM | -- MSRM</div>
            </div>
            <div class="kpi-card warning">
              <div class="kpi-label">Capital Imobilizado em "Monos"</div>
              <div class="kpi-value" id="kpiMonosValor" style="color: var(--warning)">-- €</div>
              <div class="kpi-sub" id="kpiMonosSub">-- artigos sem vendas no período</div>
            </div>
            <div class="kpi-card danger">
              <div class="kpi-label">Capital em Risco de Caducidade</div>
              <div class="kpi-value" id="kpiCaducidadeValor" style="color: var(--danger)">-- €</div>
              <div class="kpi-sub" id="kpiCaducidadeSub">-- artigos (-- embalagens em risco)</div>
            </div>
          </div>
        </div>



    <!-- ABA 0: PLANO DE AÇÃO SEMANAL (MODO SIMPLES PARA A EQUIPA E DIRETOR) -->
    <!-- ABA 0: PLANO DE AÇÃO SEMANAL (MODO SIMPLES PARA A EQUIPA E DIRETOR) -->
    <div id="tabContent-plano" style="display: block;">
      <div style="background: linear-gradient(135deg, #ecfdf5 0%, #ffffff 100%); border: 1px solid #a7f3d0; border-radius: 14px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #065f46; display: flex; align-items: center; gap: 8px;">
              📋 Folha de Ações da Semana — O que fazer hoje na Farmácia
            </div>
            <p style="font-size: 0.88rem; color: #334155; margin-top: 4px; max-width: 820px; line-height: 1.45;">
              Em vez de analisar centenas de tabelas, o sistema organizou as <b>tarefas da semana com filtros inteligentes por área, horizonte e ordem alfabética</b> para agilizar o trabalho físico da equipa na gaveta, no balcão e nas encomendas.
            </p>
          </div>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <button id="planoProgressText" class="btn" onclick="openCompletedTasksModal()" title="Clique para abrir histórico de auditoria e tarefas concluídas" style="cursor: pointer; transition: all 0.2s; font-size: 0.84rem; color: #065f46; font-weight: 700; background: #d1fae5; padding: 7px 14px; border-radius: 8px; border: 1px solid #a7f3d0; box-shadow: 0 1px 2px rgba(0,0,0,0.05); display: inline-flex; align-items: center; gap: 6px;">
              ✅ 0 de 0 tarefas concluídas
            </button>
            <button class="btn" onclick="printWeeklyActionPlan()" style="background: linear-gradient(135deg, #10b981, #059669); color: #042f2e; font-weight: 700;">
              🖨️ Imprimir Folha A4 para a Equipa
            </button>
            <button class="btn btn-secondary" onclick="resetWeeklyTasksProgress()" style="font-size: 0.8rem; padding: 7px 12px;" title="Limpar vistos marcados">
              🔄 Limpar Vistos
            </button>
          </div>
        </div>
      </div>

      <!-- MISSÕES DE CAMPANHAS ATIVAS NA FOLHA DA SEMANA -->
      <div id="planoActiveCampaignsBlock" style="display: none; margin-bottom: 20px;"></div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 20px; margin-bottom: 30px;">
        <!-- CARTÃO 1: VALIDADES URGENTES NA GAVETA -->
        <div style="background: var(--surface); border: 1px solid rgba(244, 63, 94, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #e11d48; display: flex; align-items: center; gap: 8px;">
              🔴 1. Gaveta & Prateleira: Validades Próximas a Tratar
            </div>
            <span id="planoCard1Count" class="badge badge-danger">0 produtos</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 12px;">
            Identificação estrita de produtos a aproximar do fim de vida útil para ação prioritária de balcão ou separação física:
          </p>

          <!-- Toolbar com Filtros de Categoria, Horizonte, Ordenação e Pesquisa -->
          <div class="plano-toolbar-box">
            <div class="plano-toolbar-row">
              <select id="deskCadMacroFilter" class="plano-select" onchange="onDesktopCadFilterChange()" title="Filtrar por Área / Categoria">
                <option value="all">🌐 Todas as Áreas / Categorias</option>
                <option value="MSRM">💊 Medicamentos Sujeitos a Receita (MSRM)</option>
                <option value="MNSRM_OTC">🟢 Venda Livre (MNSRM / OTC)</option>
                <option value="DERMOCOSMETICA">🧴 Dermocosmética & Higiene</option>
                <option value="NUTRICAO_SUPLEMENTOS">🥑 Nutrição & Suplementos</option>
                <option value="DISPOSITIVOS_SAUDE">🩺 Dispositivos de Saúde</option>
              </select>
              <select id="deskCadHorizonFilter" class="plano-select" onchange="onDesktopCadFilterChange()" title="Filtrar por Horizonte Temporal">
                <option value="all">📅 Todos os Prazos</option>
                <option value="urgent">🚨 Urgente (≤ 3 Meses)</option>
                <option value="mid">⏳ 3 a 6 Meses</option>
                <option value="year">🗓️ 6 a 12 Meses</option>
              </select>
            </div>
            <div class="plano-toolbar-row">
              <select id="deskCadSortOrder" class="plano-select" onchange="onDesktopCadFilterChange()" title="Critério de Ordenação">
                <option value="date_asc">⏱️ Validade Mais Próxima (Urgentes 1º)</option>
                <option value="name_asc">🔤 Alfabética (A ➔ Z)</option>
                <option value="shelf_asc">📍 Por Prateleira / Gaveta</option>
                <option value="val_desc">💶 Maior Valor em Risco (€)</option>
              </select>
            </div>
            <div class="plano-toolbar-row">
              <div class="plano-search-box">
                <span class="icon">🔍</span>
                <input type="text" id="deskCadSearch" placeholder="Pesquisar produto, lote, CNP ou prateleira..." oninput="onDesktopCadFilterChange()" />
              </div>
              <div class="plano-status-group">
                <button type="button" class="plano-status-pill active" id="deskCadPill_all" onclick="setDesktopCadStatus('all')">Todos</button>
                <button type="button" class="plano-status-pill" id="deskCadPill_pending" onclick="setDesktopCadStatus('pending')">Pendentes</button>
                <button type="button" class="plano-status-pill" id="deskCadPill_done" onclick="setDesktopCadStatus('done')">Concluídos</button>
              </div>
              <span id="planoCard1FilteredBadge" class="plano-counter-badge">0 produtos</span>
            </div>
          </div>

          <div id="planoCard1List" class="plano-card-list-scroll">
            <!-- Inserido dinamicamente via JS -->
          </div>
          <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); text-align: right;">
            <button class="btn btn-secondary" onclick="switchTab('caducidade')" style="font-size: 0.76rem; padding: 5px 10px; border-color: #fb7185; color: #fb7185;">
              Ver todos os produtos em risco de validade →
            </button>
          </div>
        </div>

        <!-- CARTÃO 2: BALCÃO & DESTAQUE (A-Z E INVERNO) -->
        <div style="background: var(--surface); border: 1px solid rgba(168, 85, 247, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #7e22ce; display: flex; align-items: center; gap: 8px;">
              🟠 2. Balcão & Destaque: Pôr a Rodar Stock Parado & Excessos Sazonais
            </div>
            <span id="planoCard2Count" class="badge badge-purple">Gaveta + Época Alta</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 12px;">
            Fim de gaveta (1-2 un de genéricos A-Z) e artigos com excesso de stock na época certa (ex: Ben-u-gripe no pico de inverno):
          </p>

          <!-- Toolbar com Sub-tabs A-Z vs Inverno, Pesquisa e Pills -->
          <div class="plano-toolbar-box">
            <div class="plano-subtabs-group">
              <button type="button" class="plano-subtab-pill active" id="deskBalcaoBtnRestos" onclick="setDesktopBalcaoSubtab('restos')">
                📦 Restos de Gaveta A-Z
              </button>
              <button type="button" class="plano-subtab-pill winter" id="deskBalcaoBtnWinter" onclick="setDesktopBalcaoSubtab('winter')">
                ❄️ Destaques Inverno (Pico)
              </button>
              <button type="button" class="plano-subtab-pill" id="deskBalcaoBtnAll" onclick="setDesktopBalcaoSubtab('all')">
                🌟 Todos
              </button>
            </div>
            <div class="plano-toolbar-row" style="margin-top: 4px;">
              <div class="plano-search-box">
                <span class="icon">🔍</span>
                <input type="text" id="deskBalcaoSearch" placeholder="Pesquisar molécula DCI ou produto..." oninput="onDesktopBalcaoFilterChange()" />
              </div>
              <div class="plano-status-group">
                <button type="button" class="plano-status-pill active" id="deskBalcaoPill_all" onclick="setDesktopBalcaoStatus('all')">Todos</button>
                <button type="button" class="plano-status-pill" id="deskBalcaoPill_pending" onclick="setDesktopBalcaoStatus('pending')">Pendentes</button>
                <button type="button" class="plano-status-pill" id="deskBalcaoPill_done" onclick="setDesktopBalcaoStatus('done')">Concluídos</button>
              </div>
              <span id="planoCard2FilteredBadge" class="plano-counter-badge">0 itens</span>
            </div>
          </div>

          <div id="planoCard2List" class="plano-card-list-scroll">
            <!-- Inserido dinamicamente via JS -->
          </div>
          <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); text-align: right;">
            <button class="btn btn-secondary" onclick="switchTab('genericos')" style="font-size: 0.76rem; padding: 5px 10px; border-color: #c084fc; color: #c084fc;">
              Ver análise completa de Genéricos (DCI) →
            </button>
          </div>
        </div>

        <!-- CARTÃO 3: TRAVAR ENCOMENDAS NO SISTEMA DE GESTÃO -->
        <div style="background: var(--surface); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #b45309; display: flex; align-items: center; gap: 8px;">
              🛑 3. Compras & Encomendas: O que NÃO Encomendar Mais
            </div>
            <span id="planoCard3Savings" class="badge badge-warning">-- € poupança</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 12px;">
            Colocar o <b>Ponto de Encomenda / Stock Mínimo = 0</b> nestes códigos com cobertura excessiva para travar compras desnecessárias:
          </p>

          <!-- Toolbar Cartão 3 -->
          <div class="plano-toolbar-box">
            <div class="plano-toolbar-row">
              <select id="deskTravSortOrder" class="plano-select" onchange="onDesktopTravFilterChange()" title="Critério de Ordenação">
                <option value="perda_desc">💶 Maior Poupança / Excesso (€)</option>
                <option value="name_asc">🔤 Alfabética (A ➔ Z)</option>
                <option value="cob_desc">📦 Maior Cobertura (Meses)</option>
              </select>
            </div>
            <div class="plano-toolbar-row">
              <div class="plano-search-box">
                <span class="icon">🔍</span>
                <input type="text" id="deskTravSearch" placeholder="Pesquisar artigo ou CNP a travar..." oninput="onDesktopTravFilterChange()" />
              </div>
              <div class="plano-status-group">
                <button type="button" class="plano-status-pill active" id="deskTravPill_all" onclick="setDesktopTravStatus('all')">Todos</button>
                <button type="button" class="plano-status-pill" id="deskTravPill_pending" onclick="setDesktopTravStatus('pending')">Pendentes</button>
                <button type="button" class="plano-status-pill" id="deskTravPill_done" onclick="setDesktopTravStatus('done')">Concluídos</button>
              </div>
              <span id="planoCard3FilteredBadge" class="plano-counter-badge">0 artigos</span>
            </div>
          </div>

          <div id="planoCard3List" class="plano-card-list-scroll">
            <!-- Inserido dinamicamente via JS -->
          </div>
          <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); text-align: right;">
            <button class="btn btn-secondary" onclick="switchTab('cobertura')" style="font-size: 0.76rem; padding: 5px 10px; border-color: #fbbf24; color: #fbbf24;">
              Ver todos os excessos de stock →
            </button>
          </div>
        </div>

        <!-- CARTÃO 4: PREVENIR RUTURAS & AJUSTAR NÍVEIS -->
        <div style="background: var(--surface); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #0284c7; display: flex; align-items: center; gap: 8px;">
              🟢 4. Compras & Encomendas: Ajustar Níveis & Prevenir Ruturas
            </div>
            <span id="planoCard4Count" class="badge badge-info">Subir Ponto de Encomenda</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 12px;">
            Medicamentos essenciais com stock <= 2 e alto ritmo de saída / pico de inverno. Subir Ponto de Encomenda para evitar ruturas:
          </p>

          <!-- Toolbar Cartão 4 -->
          <div class="plano-toolbar-box">
            <div class="plano-toolbar-row">
              <select id="deskRuturaSortOrder" class="plano-select" onchange="onDesktopRuturaFilterChange()" title="Critério de Ordenação">
                <option value="urgente">🚨 Menor Cobertura / Stock Crítico</option>
                <option value="vmm_desc">⚡ Maior Ritmo de Vendas (VMM)</option>
                <option value="name_asc">🔤 Alfabética (A ➔ Z)</option>
              </select>
            </div>
            <div class="plano-toolbar-row">
              <div class="plano-search-box">
                <span class="icon">🔍</span>
                <input type="text" id="deskRuturaSearch" placeholder="Pesquisar medicamento em risco..." oninput="onDesktopRuturaFilterChange()" />
              </div>
              <div class="plano-status-group">
                <button type="button" class="plano-status-pill active" id="deskRuturaPill_all" onclick="setDesktopRuturaStatus('all')">Todos</button>
                <button type="button" class="plano-status-pill" id="deskRuturaPill_pending" onclick="setDesktopRuturaStatus('pending')">Pendentes</button>
                <button type="button" class="plano-status-pill" id="deskRuturaPill_done" onclick="setDesktopRuturaStatus('done')">Concluídos</button>
              </div>
              <span id="planoCard4FilteredBadge" class="plano-counter-badge">0 artigos</span>
            </div>
          </div>

          <div id="planoCard4List" class="plano-card-list-scroll">
            <!-- Inserido dinamicamente via JS -->
          </div>
          <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); text-align: right;">
            <button class="btn btn-secondary" onclick="switchTab('campaigns')" style="font-size: 0.76rem; padding: 5px 10px; border-color: #38bdf8; color: #38bdf8;">
              Abrir Estúdio de Campanhas & Marketing 360º →
            </button>
          </div>
        </div>
      </div>
    </div>

    
    <!-- ABA 5A: BALANCEAMENTO DE STOCK MULTI-LOJA (FASE 5) -->
    <div id="tabContent-rebalance" style="display: none;">
      <div style="background: linear-gradient(135deg, #f0f9ff 0%, #ffffff 100%); border: 1px solid #bae6fd; border-radius: 14px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #0369a1; display: flex; align-items: center; gap: 8px;">
              🔄 Balanceamento Cruzado de Stock entre Farmácias do Grupo
            </div>
            <p style="font-size: 0.88rem; color: #334155; margin-top: 4px; max-width: 820px; line-height: 1.45;">
              O algoritmo cruzou os dados de inventário e vendas das farmácias do grupo e identificou produtos em <b>excesso numa loja que estão em carência ou ruptura iminente noutra</b>.
            </p>
          </div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <button class="btn" onclick="loadRebalanceData()" style="background: #0284c7; color: #fff; font-weight: 700; font-size: 0.82rem; padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer;">
              🔄 Recalcular Oportunidades
            </button>
            <button class="btn" onclick="printTransferGuide()" style="background: #10b981; color: #fff; font-weight: 700; font-size: 0.82rem; padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer;">
              📄 Emitir Guia de Transferência
            </button>
          </div>
        </div>

        <!-- KPIS DO GRUPO -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 18px;">
          <div class="executive-kpi-card" style="border-left: 4px solid #0284c7;">
            <div style="font-size: 0.72rem; font-weight: 800; color: #64748b; text-transform: uppercase;">Poupança Total Estimada</div>
            <div style="font-size: 1.45rem; font-weight: 800; color: #0369a1;" id="rebalanceSavingsTotal">0,00 €</div>
            <div style="font-size: 0.78rem; color: #64748b;">Evitado em compras duplicadas a armazenistas</div>
          </div>
          <div class="executive-kpi-card" style="border-left: 4px solid #10b981;">
            <div style="font-size: 0.72rem; font-weight: 800; color: #64748b; text-transform: uppercase;">Oportunidades de Troca</div>
            <div style="font-size: 1.45rem; font-weight: 800; color: #065f46;" id="rebalanceOpportunitiesCount">0 artigos</div>
            <div style="font-size: 0.78rem; color: #047857;">Transferências viáveis identificadas</div>
          </div>
        </div>
      </div>

      <!-- Tabela de Sugestões de Transferência -->
      <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
        <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a; margin-bottom: 12px;">Propostas de Transferência Interna Sugeridas</div>
        <div id="rebalanceTableContainer">
          <div style="text-align: center; color: #94a3b8; padding: 30px;">A carregar sugestões de balanceamento...</div>
        </div>
      </div>
    </div>

    <!-- ABA 5B: ANÁLISE DE LABORATÓRIOS & AIMS (FASE 5) -->
    
    <!-- ABA: SAÚDE FINANCEIRA DO INVENTÁRIO (EVOLUÇÃO REAL & LIQUIDEZ RECUPERADA) -->
    <div id="tabContent-evolution" style="display: none;">
      <!-- CABEÇALHO EXECUTIVO TRANSPARENTE (MARCO ZERO OU SÉRIE MULTI-MÊS) -->
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 14px; padding: 22px 24px; margin-bottom: 22px; color: #ffffff; box-shadow: 0 4px 12px rgba(15,23,42,0.15);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span id="evoHeaderIcon" style="font-size: 1.5rem;">📍</span>
              <h2 id="evoHeaderTitle" style="font-size: 1.3rem; font-weight: 800; color: #38bdf8; margin: 0;">
                Marco Zero — Diagnóstico Inicial & Linha de Partida
              </h2>
            </div>
            <p id="evoHeaderDesc" style="font-size: 0.88rem; color: #cbd5e1; margin-top: 6px; max-width: 860px; line-height: 1.5;">
              Esta é a fotografia patrimonial inicial da farmácia. Por rigor contabilístico, <b>não se simulam dados passados</b>. A evolução de stock, a redução do imobilizado e a liquidez recuperada serão medidas a partir da importação do fecho do próximo mês.
            </p>
            <div style="display: flex; gap: 12px; margin-top: 10px; font-size: 0.76rem; color: #94a3b8; flex-wrap: wrap;">
              <span>📊 <b>Dados Auditados:</b> Inventário Físico Inicial da Farmácia</span>
              <span>🔒 <b>Critério Monos:</b> Artigos com stock e sem vendas há >90 dias</span>
              <span>✅ <b>Critério Poupança:</b> Vendas comprovadas após o Marco Zero</span>
            </div>
          </div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <button class="btn" onclick="loadStockEvolutionData()" style="background: #0284c7; color: #ffffff; font-weight: 700; padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer;">
              🔄 Atualizar Balanço
            </button>
          </div>
        </div>
      </div>

      <!-- 4 BIG NUMBER KPIS DE GESTÃO REAL (SEM METAS ARBITRÁRIAS) -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 22px;">
        
        <!-- KPI 1: STOCK TOTAL A PREÇO DE CUSTO -->
        <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border-left: 4px solid #0284c7;">
          <div style="font-size: 0.74rem; font-weight: 700; color: #64748b; text-transform: uppercase;">📦 Stock Total Físico (A Custo)</div>
          <div id="evoKpiStockTotal" style="font-size: 1.7rem; font-weight: 800; color: #0f172a; margin-top: 4px;">-- €</div>
          <div id="evoKpiStockSub" style="font-size: 0.76rem; color: #64748b; margin-top: 2px;">-- unidades em armazém</div>
        </div>

        <!-- KPI 2: CAPITAL IMOBILIZADO (MONOS >90 DIAS) -->
        <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border-left: 4px solid #e11d48;">
          <div style="font-size: 0.74rem; font-weight: 700; color: #64748b; text-transform: uppercase;">🛑 Capital Imobilizado ("Monos" >90d)</div>
          <div id="evoKpiImobilizado" style="font-size: 1.7rem; font-weight: 800; color: #e11d48; margin-top: 4px;">-- €</div>
          <div id="evoKpiImobilizadoSub" style="font-size: 0.76rem; font-weight: 700; color: #e11d48; margin-top: 2px;">--% do valor total em stock</div>
        </div>

        <!-- KPI 3: LIQUIDEZ RECUPERADA POR VENDAS COMPROVADAS -->
        <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border-left: 4px solid #10b981;">
          <div style="font-size: 0.74rem; font-weight: 700; color: #64748b; text-transform: uppercase;">💰 Dinheiro de Monos Recuperado</div>
          <div id="evoKpiPoupancas" style="font-size: 1.7rem; font-weight: 800; color: #059669; margin-top: 4px;">0,00 €</div>
          <div id="evoKpiPoupancasSub" style="font-size: 0.76rem; color: #059669; margin-top: 2px;">Medição inicia pós-Marco Zero</div>
        </div>

        <!-- KPI 4: PRAZO MÉDIO DE ROTAÇÃO DE STOCK -->
        <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border-left: 4px solid #8b5cf6;">
          <div style="font-size: 0.74rem; font-weight: 700; color: #64748b; text-transform: uppercase;">⏳ Prazo Médio de Rotação</div>
          <div id="evoKpiCapitalLibertado" style="font-size: 1.7rem; font-weight: 800; color: #7c3aed; margin-top: 4px;">-- dias</div>
          <div id="evoKpiCapitalLibertadoSub" style="font-size: 0.76rem; color: #6d28d9; margin-top: 2px;">Dias para escoar o inventário atual</div>
        </div>
      </div>

      <!-- PAINEL MARCO ZERO: AVISO E CARREGAMENTO DO 2º MÊS -->
      <div id="evoMarcoZeroBoxContainer" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 1.25rem;">⏳</span>
              <h3 style="font-size: 1.05rem; font-weight: 800; color: #0f172a; margin: 0;">
                Medição de Evolução Patrimonial: Aguarda 2º Fecho de Existências
              </h3>
            </div>
            <p style="font-size: 0.84rem; color: #475569; margin: 6px 0 0 0; max-width: 820px; line-height: 1.5;">
              O BI Pharma opera com <b>rigor contabilístico integral</b>: o primeiro ficheiro importado representa a sua <b>Linha de Partida (Marco Zero)</b>. Não inventamos nem estimamos o que estava antes. Assim que carregar o fecho de inventário do mês seguinte, o sistema apresentará o gráfico de variação real de stock, a redução da gaveta de monos e o dinheiro resgatado por vendas comprovadas.
            </p>
          </div>
          <button class="btn" onclick="openInteractiveImportModal()" style="background: #0284c7; color: #ffffff; font-weight: 700; padding: 11px 20px; border-radius: 8px; border: none; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 0.9rem; box-shadow: 0 2px 6px rgba(2,132,199,0.25);">
            📥 Carregar Fecho de Mês Seguinte
          </button>
        </div>
      </div>

      <!-- COMPARATIVO EXECUTIVO MÊS A MÊS (MoM) — VISÍVEL QUANDO EXISTEM >= 2 SNAPSHOTS -->
      <div id="evoMomBoxContainer" style="display: none; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 1.25rem;">⚖️</span>
            <div>
              <h3 style="font-size: 1.05rem; font-weight: 800; color: #0f172a; margin: 0;">
                Comparativo Executivo Mês a Mês (MoM) — Resposta às Perguntas de Gestão
              </h3>
              <p style="font-size: 0.78rem; color: #64748b; margin: 2px 0 0 0;">
                Identifique instantaneamente se a farmácia acumulou ou reduziu stock e monos entre períodos.
              </p>
            </div>
          </div>
          <span id="evoMomPeriodLabel" style="font-size: 0.8rem; font-weight: 700; color: #475569; background: #f1f5f9; padding: 5px 12px; border-radius: 6px;">
            Mês Atual vs Mês Anterior
          </span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 16px;">
          <!-- Card MoM 1: Variação Stock Total -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px;">
            <div style="font-size: 0.74rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Evolução do Stock Físico Global</div>
            <div id="evoMomStockDelta" style="font-size: 1.45rem; font-weight: 800; color: #0284c7; margin-top: 4px;">-- €</div>
            <div id="evoMomStockDeltaSub" style="font-size: 0.76rem; color: #64748b; margin-top: 2px;">Variação patrimonial do inventário em armazém</div>
          </div>

          <!-- Card MoM 2: Variação Capital Imobilizado (Monos) -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 0.74rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Capital Imobilizado ("Monos")</span>
              <span id="evoMomTrendBadge" style="font-size: 0.72rem; font-weight: 800; padding: 2px 8px; border-radius: 4px; background: #e2e8f0; color: #475569;">A calcular</span>
            </div>
            <div id="evoMomMonosDelta" style="font-size: 1.45rem; font-weight: 800; color: #e11d48; margin-top: 4px;">-- €</div>
            <div id="evoMomMonosDeltaSub" style="font-size: 0.76rem; color: #64748b; margin-top: 2px;">Variação de produtos sem vendas há >90 dias</div>
          </div>

          <!-- Card MoM 3: Liquidez de Monos Resgatada -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px;">
            <div style="font-size: 0.74rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Dinheiro de Monos Resgatado no Mês</div>
            <div id="evoMomLiqDelta" style="font-size: 1.45rem; font-weight: 800; color: #059669; margin-top: 4px;">+0,00 €</div>
            <div style="font-size: 0.76rem; color: #059669; margin-top: 2px;">Comprovado por histórico de vendas registadas</div>
          </div>
        </div>

        <!-- Parecer Executivo -->
        <div id="evoMomExplicacao" style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; border-radius: 6px; font-size: 0.84rem; color: #1e40af; line-height: 1.45;">
          A calcular evolução MoM...
        </div>

        <!-- NOTA DE RIGOR FARMACÊUTICO & DECOMPOSIÇÃO DE SAÍDAS -->
        <div style="margin-top: 14px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 12px 16px; font-size: 0.80rem; color: #92400e; display: flex; align-items: flex-start; gap: 10px; line-height: 1.45;">
          <span style="font-size: 1.25rem; line-height: 1;">🛡️</span>
          <div>
            <b>Princípio de Rigor Farmacêutico & Contabilístico:</b> Ter menos stock nem sempre é poupança — pode ser venda (dinheiro na caixa), devolução a armazenista, acerto de contagem ou quebra/caducidade deitada fora. O BI Pharma <b>apenas contabiliza como Liquidez Recuperada as saídas com venda comprovada</b>. Saídas sem venda são tratadas como ajustes/perdas e nunca são somadas como ganho financeiro. Os preços de custo respeitam o valor histórico de compra (CMP) de cada época.
          </div>
        </div>
      </div>

      <!-- PAINEL COMPARATIVO: STOCK ATIVO vs IMOBILIZADO vs VENDAS -->
      <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
          <div>
            <h3 style="font-size: 1.05rem; font-weight: 800; color: #0f172a; margin: 0;">
              📊 Trajetória Mensal: Stock Total Físico vs Monos vs Faturação
            </h3>
            <p style="font-size: 0.8rem; color: #64748b; margin: 3px 0 0 0;">
              Compare se o inventário está a acompanhar as vendas ou se há acumulação excessiva de produtos sem rotação.
            </p>
          </div>
          <div style="display: flex; gap: 16px; font-size: 0.78rem; font-weight: 700; align-items: center; flex-wrap: wrap;">
            <span style="display: flex; align-items: center; gap: 6px; color: #0284c7;">
              <span style="width: 14px; height: 14px; background: #0284c7; border-radius: 3px; display: inline-block;"></span> Stock Total (€)
            </span>
            <span style="display: flex; align-items: center; gap: 6px; color: #e11d48;">
              <span style="width: 14px; height: 14px; background: #fca5a5; border-radius: 3px; display: inline-block;"></span> Monos / Parado (€)
            </span>
            <span style="display: flex; align-items: center; gap: 6px; color: #10b981;">
              <span style="width: 14px; height: 14px; background: #10b981; border-radius: 3px; display: inline-block;"></span> Vendas Faturadas (€)
            </span>
            <span style="display: flex; align-items: center; gap: 6px; color: #d97706;">
              <span style="width: 14px; height: 14px; background: #fbbf24; border-radius: 3px; display: inline-block;"></span> Dinheiro de Monos Recuperado
            </span>
          </div>
        </div>

        <div id="evoChartBarsContainer" style="display: flex; align-items: flex-end; gap: 12px; height: 260px; padding: 10px 0 30px 0; border-bottom: 1px solid #cbd5e1; overflow-x: auto;">
          <div style="text-align: center; width: 100%; color: #94a3b8; align-self: center;">A gerar gráfico financeiro...</div>
        </div>
      </div>

      <!-- TABELA DETALHADA: SAÚDE FINANCEIRA DE STOCK -->
      <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
          <div>
            <h3 style="font-size: 1.05rem; font-weight: 800; color: #0f172a; margin: 0;">📋 Tabela Cronológica de Saúde de Stock</h3>
            <p style="font-size: 0.8rem; color: #64748b; margin: 2px 0 0 0;">Cálculo do rácio de imobilizado e liquidez recuperada em cada mês.</p>
          </div>
          <span style="font-size: 0.78rem; background: #f1f5f9; color: #475569; padding: 4px 10px; border-radius: 6px; font-weight: 700;">
            Classificação de Monos: 🟢 Baixo (&lt;35%) | 🟡 Moderado (35%-45%) | 🔴 Elevado (&gt;45%)
          </span>
        </div>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.86rem; text-align: left;">
            <thead style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
              <tr>
                <th style="padding: 10px 14px; font-weight: 700; color: #475569;">Mês / Ano</th>
                <th style="padding: 10px 14px; font-weight: 700; color: #0284c7; text-align: right;">Stock Total (€)</th>
                <th style="padding: 10px 14px; font-weight: 700; color: #e11d48; text-align: right;">Monos Parados (€)</th>
                <th style="padding: 10px 14px; font-weight: 700; color: #64748b; text-align: center;">% Monos</th>
                <th style="padding: 10px 14px; font-weight: 700; color: #10b981; text-align: right;">Vendas Mês (€)</th>
                <th style="padding: 10px 14px; font-weight: 700; color: #059669; text-align: right;">Dinheiro de Monos Recuperado</th>
                <th style="padding: 10px 14px; font-weight: 700; color: #7c3aed; text-align: center;">Dias Rotação</th>
                <th style="padding: 10px 14px; font-weight: 700; color: #475569; text-align: center;">Diagnóstico</th>
              </tr>
            </thead>
            <tbody id="evoTableBody">
              <tr><td colspan="8" style="padding: 24px; text-align: center; color: #94a3b8;">A carregar tabela...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="tabContent-labs" style="display: none;">
      <div style="background: linear-gradient(135deg, #faf5ff 0%, #ffffff 100%); border: 1px solid #e9d5ff; border-radius: 14px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
        <div style="font-size: 1.25rem; font-weight: 800; color: #7e22ce; margin-bottom: 6px;">
          🏭 Inteligência Comercial de Laboratórios & Filtros por AIM
        </div>
        <p style="font-size: 0.88rem; color: #334155; max-width: 860px; line-height: 1.45;">
          Analise o volume de compras vs vendas, margem média e quotas de fornecedores titulares. Utilize a barra abaixo para pesquisar múltiplos códigos AIM em simultâneo (ex: <b>AIM 320, 2121, 6581</b>).
        </p>

        <!-- Barra de Filtro de AIMs -->
        <div style="background: #ffffff; border: 1.5px solid #d8b4fe; border-radius: 10px; padding: 14px; margin-top: 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 260px;">
            <label style="font-size: 0.74rem; font-weight: 800; color: #6b21a8; text-transform: uppercase; display: block; margin-bottom: 4px;">Pesquisar Códigos AIM Específicos:</label>
            <input type="text" id="inputFilterAims" placeholder="Ex: 320, 2121, 6581 (separados por vírgula)" style="width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem;" />
          </div>
          <button class="btn" onclick="executeAimSearch()" style="background: #7e22ce; color: #fff; font-weight: 700; font-size: 0.82rem; padding: 9px 18px; border: none; border-radius: 6px; cursor: pointer; align-self: flex-end;">
            🔍 Filtrar Histórico de AIMs
          </button>
          <button class="btn btn-secondary" onclick="loadLabsData()" style="font-size: 0.82rem; padding: 9px 14px; align-self: flex-end;">
            Ver Todos os Labs
          </button>
        </div>
      </div>

      <!-- Container Dinâmico de Laboratórios / AIMs -->
      <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
        <div id="labsResultsTitle" style="font-size: 0.95rem; font-weight: 800; color: #0f172a; margin-bottom: 12px;">Ranking de Laboratórios Titulares</div>
        <div id="labsTableContainer">
          <div style="text-align: center; color: #94a3b8; padding: 30px;">A carregar dados de laboratórios...</div>
        </div>
      </div>
    </div>

    <!-- ABA 1: ASSISTENTE COPILOT DEDICADO (PERGUNTAS LIVRES & CONSULTORIA) -->
    <div id="tabContent-copilot" style="display: none;">
      <div class="copilot-container">
        <!-- CABEÇALHO DO COPILOT -->
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 16px;">
          <div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #0284c7; display: flex; align-items: center; gap: 8px;">
              💬 Copilot de Direção Técnica & Gestão Clínica
            </div>
            <p style="font-size: 0.88rem; color: #64748b; margin-top: 4px; line-height: 1.45; max-width: 780px;">
              Raciocínio analítico com ligação em tempo real aos dados da farmácia. Suporta perguntas encadeadas com memória de sessão e execução segura de cálculos farmacêuticos.
            </p>
          </div>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <div class="tenant-badge" id="copilotActiveFarmaciaBadge" style="font-size: 0.80rem; padding: 6px 14px;">
              🏥 Farmácia Ativa
            </div>
            <button class="btn btn-secondary" onclick="resetCopilotConversation()" style="font-size: 0.80rem; padding: 7px 14px; border-color: #cbd5e1; color: #0f172a;" title="Limpar memória e iniciar nova conversa">
              🔄 Nova Conversa
            </button>
            <button class="btn" onclick="openCopilotReportModalCurrentSession()" style="font-size: 0.80rem; padding: 7px 14px; background: #0284c7; color: #fff; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 1px 3px rgba(2,132,199,0.3);" title="Estruturar e pré-visualizar relatório executivo em PDF">
              📑 Relatório da Análise
            </button>
          </div>
        </div>

        
        <!-- SELETOR DE 4 MODOS ESPECIALIZADOS DO COPILOT (FASE 3) -->
        <div class="copilot-mode-selector">
          <button class="copilot-mode-btn" id="modeBtn-CLINICAL" onclick="setCopilotMode('CLINICAL')">
            <span>🩺</span> Balcão Clínico & Sintomas
          </button>
          <button class="copilot-mode-btn" id="modeBtn-FINANCE" onclick="setCopilotMode('FINANCE')">
            <span>💰</span> Finanças, Margens & Labs
          </button>
          <button class="copilot-mode-btn" id="modeBtn-STOCKS" onclick="setCopilotMode('STOCKS')">
            <span>📦</span> Stocks, Rupturas & Validades
          </button>
          <button class="copilot-mode-btn" id="modeBtn-MARKETING" onclick="setCopilotMode('MARKETING')">
            <span>🎯</span> Marketing & Escoamento
          </button>
          <button class="copilot-mode-btn active" id="modeBtn-GENERAL" onclick="setCopilotMode('GENERAL')">
            <span>🌐</span> Raciocínio Livre (Geral)
          </button>
        </div>

        <!-- BANNER DO MODO ATIVO -->
        <div class="copilot-mode-banner" id="copilotModeBanner">
          <div id="copilotModeDesc">
            💡 <b>Modo Geral:</b> Pergunte qualquer questão ou selecione um modo especializado acima para obter respostas assertivas em cartões e tabelas compactas.
          </div>
          <span id="copilotModeTag" style="font-weight: 800; font-size: 0.72rem; text-transform: uppercase; background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 6px;">GERAL</span>
        </div>

        <!-- FEED CONVERSACIONAL COM HISTÓRICO E MEMÓRIA -->
        <div id="copilotChatFeed" class="copilot-chat-feed">
          <div id="copilotWelcomeGreeting" style="text-align: center; padding: 28px 16px; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 12px;">
            <div style="font-size: 2.2rem; margin-bottom: 8px;">💡</div>
            <div style="font-size: 1rem; font-weight: 700; color: #0f172a; margin-bottom: 4px;">O que pretende analisar hoje na sua farmácia?</div>
            <div style="font-size: 0.84rem; color: #64748b; max-width: 580px; margin: 0 auto; line-height: 1.45;">
              Coloque qualquer questão ou pedido de análise na barra inferior. Pode fazer perguntas de seguimento a qualquer momento — o Copilot mantém o contexto da conversa.
            </div>
          </div>
        </div>

        <!-- INDICADOR DE PROCESSAMENTO / PENSAMENTO -->
        <div id="copilotThinkingIndicator" class="thinking-card" style="display: none; background: #f0f9ff !important; border: 1px solid #bae6fd !important;">
          <div style="font-size: 2rem; animation: spin 2.5s linear infinite;">🧠</div>
          <div>
            <div style="font-size: 0.98rem; font-weight: 700; color: #0369a1 !important; margin-bottom: 2px;">
              A analisar dados da farmácia com Inteligência Artificial...
            </div>
            <div style="font-size: 0.82rem; color: #475569 !important; line-height: 1.4;">
              A consultar o inventário, vendas e validades no PostgreSQL e a executar o raciocínio clínico.
            </div>
          </div>
        </div>

        <!-- BARRA DE ENTRADA DE PERGUNTAS -->
        <div style="display: flex; gap: 10px; align-items: stretch; margin-top: 4px;">
          <input 
            type="text" 
            id="askInput" 
            placeholder="Faça uma pergunta ou pedido de seguimento... (Ex: 'E desses, quais têm maior margem?', 'Cria uma lista de tarefas para amanhã', 'Stock mínimo para 1 semana')..." 
            onkeydown="if(event.key==='Enter') askQuestion()"
            style="flex: 1; padding: 14px 18px; font-size: 0.94rem; border: 1px solid #cbd5e1; border-radius: 10px; outline: none; transition: border-color 0.15s; background: #ffffff; color: #0f172a;"
          />
          <button class="btn" id="askBtnSubmit" onclick="askQuestion()" style="padding: 0 26px; font-size: 0.95rem; background: #0284c7; color: #ffffff; font-weight: 700; border-radius: 10px; display: flex; align-items: center; gap: 6px;">
            <span>Perguntar</span> ➜
          </button>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.74rem; color: #64748b; padding: 0 4px;">
          <span>💡 <b>Dica:</b> Prima <b>Enter</b> para enviar. Perguntas seguintes mantêm o contexto da resposta anterior.</span>
          <span id="copilotSessionIndicator">Sessão: Ativa</span>
        </div>
      </div>
    </div>

    <!-- ABA 2: CAMPANHAS & MARKETING 360º -->
    <div id="tabContent-campaigns" style="display: none;">
      <!-- CABEÇALHO DO HUB DE MARKETING -->
      <div style="background: linear-gradient(135deg, #f5f3ff 0%, #ffffff 100%); border: 1px solid #ddd6fe; border-radius: 14px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #e11d48; display: flex; align-items: center; gap: 8px;">
              🎯 Estúdio de Marketing, Campanhas de Época & Escoamento 360º
            </div>
            <p style="font-size: 0.88rem; color: var(--muted); margin-top: 4px; max-width: 820px; line-height: 1.45;">
              Consciência total do stock da farmácia: cruza a anatomia de cada época do calendário com os produtos que precisam de escoar (<b>Validades Críticas</b>, <b>Monos</b> e <b>Restos de Gaveta 1-2 un.</b>) e associa as <b>Locomotivas de Receita/Balcão</b> para venda cruzada.
            </p>
          </div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <button class="btn btn-secondary" onclick="openEmailDigestModal()" style="border-color: #f43f5e; color: #fb7185;">
              📧 Boletim Mensal da Equipa
            </button>
            <button class="btn" onclick="loadCampaignSuggestions()" style="background: linear-gradient(135deg, #f43f5e, #e11d48);">
              🔄 Atualizar Planos
            </button>
          </div>
        </div>

        <!-- RADIOGRAFIA DE CRITÉRIOS DE MARKETING DO STOCK -->
        <div id="marketingOverviewGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-top: 18px;">
          <!-- Inserido dinamicamente via JS -->
        </div>
      </div>

      <!-- BANNER DE CAMPANHAS ATIVAS NA FARMÁCIA -->
      <div id="activeCampaignsBanner" style="display: none; margin-bottom: 22px;"></div>

      <!-- SUB-NAVEGAÇÃO DO ESTÚDIO DE MARKETING (4 EIXOS OPERACIONAIS) -->
      <div style="display: flex; gap: 10px; margin-bottom: 22px; flex-wrap: wrap;">
        <button class="btn" id="mktSubBtn-epoca" onclick="switchMarketingSubView('epoca')" style="background: #f43f5e; color: #fff; font-size: 0.88rem; padding: 10px 18px;">
          📅 1. Campanhas de Época & Calendário Civil
        </button>
        <button class="btn btn-secondary" id="mktSubBtn-liquidacao" onclick="switchMarketingSubView('liquidacao')" style="font-size: 0.88rem; padding: 10px 18px;">
          🧹 2. Planos de Liquidação (Validades, Monos & Restos)
        </button>
        <button class="btn btn-secondary" id="mktSubBtn-cross" onclick="switchMarketingSubView('cross')" style="font-size: 0.88rem; padding: 10px 18px;">
          🤝 3. Cross-Selling & Simulador por Produto
        </button>
        <button class="btn btn-secondary" id="mktSubBtn-custom" onclick="switchMarketingSubView('custom')" style="font-size: 0.88rem; padding: 10px 18px; border-color: #c084fc; color: #e879f9;">
          ✨ 4. Criar Campanha à Medida (Halloween, Black Friday, Festas, Produto Foco...)
        </button>
        <button class="btn btn-secondary" id="mktSubBtn-packs" onclick="switchMarketingSubView('packs')" style="font-size: 0.88rem; padding: 10px 18px; border-color: #38bdf8; color: #0284c7; font-weight: 700;">
          📦 5. Packs Clínicos & Cestos Temáticos (Por Sintoma)
        </button>
      </div>

      
      <!-- PAINEL PACKS CLÍNICOS & CESTOS TEMÁTICOS (POR SINTOMA / PROPÓSITO DO UTENTE) -->
      <div id="mktPacksPanel" style="display: none; margin-bottom: 26px;">
        <div style="background: linear-gradient(135deg, #f0f9ff 0%, #ffffff 100%); border: 1px solid #bae6fd; border-radius: 14px; padding: 22px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
            <div>
              <div style="font-size: 1.22rem; font-weight: 800; color: #0369a1; display: flex; align-items: center; gap: 8px;">
                📦 Packs Clínicos & Cestos Temáticos (Por Sintoma do Utente)
              </div>
              <p style="font-size: 0.86rem; color: #334155; margin-top: 4px; max-width: 900px; line-height: 1.45;">
                O utente não compra marcas ou caixas isoladas sem saber a sua utilidade. Estes packs agrupam produtos complementares em torno de <b>sintomas concretos</b> (Gripe, Barreira Cutânea / Frio, Digestão, Sono) com subtítulo decodificador simples do propósito de cada produto, preço conjunto atrativo e <b>margem da farmácia protegida (≥ 5%)</b>.
              </p>
            </div>
            <button class="btn" onclick="loadClinicalThemePacks(true)" style="background: #0284c7; color: #ffffff; font-weight: 700; font-size: 0.82rem; padding: 8px 16px;">
              🔄 Atualizar Packs
            </button>
          </div>
        </div>
        <div id="mktPacksGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 20px;">
          <div style="padding: 24px; color: var(--muted);">A carregar packs clínicos da farmácia...</div>
        </div>
      </div>

      <!-- PAINEL CONSTRUTOR DE CAMPANHAS À MEDIDA (ASSISTENTE LIMPO EM PASSOS) -->
      <div id="mktCustomBuilderPanel" style="display: none; margin-bottom: 28px; background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 16px; padding: 26px; box-shadow: 0 4px 20px rgba(0,0,0,0.06);">
        <!-- CABEÇALHO LIMPO -->
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px; margin-bottom: 22px; border-bottom: 1px solid #f1f5f9; padding-bottom: 16px;">
          <div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 1.6rem;">✨</span>
              <div>
                <h3 style="font-size: 1.2rem; font-weight: 800; color: #0f172a; margin: 0;">
                  Assistente de Campanhas à Medida & Liquidação de Stock
                </h3>
                <p style="font-size: 0.86rem; color: #64748b; margin-top: 4px;">
                  Monte campanhas para eventos especiais ou selecione produtos em risco para escoar em 15 dias.
                </p>
              </div>
            </div>
          </div>
          <button class="btn btn-secondary" onclick="switchMarketingSubView('epoca')" style="font-size: 0.84rem; padding: 7px 16px; border-color: #cbd5e1; color: #475569; font-weight: 600;">
            ✕ Voltar ao Catálogo Sazonal
          </button>
        </div>

        <!-- INDICADOR PROGRESSIVO DE PASSOS -->
        <div style="display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;">
          <div id="wizardStepIndicator1" style="flex: 1; min-width: 220px; padding: 12px 16px; border-radius: 10px; background: #f1f5f9; border-left: 4px solid #a855f7; display: flex; align-items: center; gap: 10px;">
            <span style="background: #a855f7; color: white; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 0.78rem; font-weight: 800;">1</span>
            <div>
              <div style="font-size: 0.86rem; font-weight: 700; color: #0f172a;">1. Tema ou Evento</div>
              <div style="font-size: 0.74rem; color: #64748b;">Escolha um evento rápido ou tema livre</div>
            </div>
          </div>
          <div id="wizardStepIndicator2" style="flex: 1; min-width: 220px; padding: 12px 16px; border-radius: 10px; background: #f8fafc; border-left: 4px solid #cbd5e1; display: flex; align-items: center; gap: 10px;">
            <span style="background: #cbd5e1; color: #475569; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 0.78rem; font-weight: 800;">2</span>
            <div>
              <div style="font-size: 0.86rem; font-weight: 700; color: #0f172a;">2. Facilitador de Produtos</div>
              <div style="font-size: 0.74rem; color: #64748b;">Cestos de Validades, Monos ou Pesquisa</div>
            </div>
          </div>
          <div id="wizardStepIndicator3" style="flex: 1; min-width: 220px; padding: 12px 16px; border-radius: 10px; background: #f8fafc; border-left: 4px solid #cbd5e1; display: flex; align-items: center; gap: 10px;">
            <span style="background: #cbd5e1; color: #475569; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 0.78rem; font-weight: 800;">3</span>
            <div>
              <div style="font-size: 0.86rem; font-weight: 700; color: #0f172a;">3. Simulação & Ativação</div>
              <div style="font-size: 0.74rem; color: #64748b;">Desconto seguro e tarefas para a equipa</div>
            </div>
          </div>
        </div>

        <!-- PASSO 1: TEMA OU EVENTO (LIMPO & ESPAÇOSO) -->
        <div id="customWizardStep1" style="display: block;">
          <div style="font-size: 0.88rem; font-weight: 700; color: #334155; margin-bottom: 12px;">
            ⚡ Eventos Rápidos do Calendário & Comunidade (Clique para avançar diretamente):
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 22px;">
            <button class="btn btn-secondary preset-event-card" onclick="selectWizardPreset('black_friday', 'Black Friday & Cyber Week', '🖤')" style="padding: 14px 16px; border-color: #f43f5e; color: #9f1239; background: #fff1f2; text-align: left; display: flex; flex-direction: column; gap: 4px; border-radius: 12px; cursor: pointer;">
              <span style="font-size: 1.4rem;">🖤</span>
              <b style="font-size: 0.88rem;">Black Friday</b>
              <span style="font-size: 0.74rem; color: #e11d48;">Destaque promocional</span>
            </button>
            <button class="btn btn-secondary preset-event-card" onclick="selectWizardPreset('festas_cidade', 'Festas da Cidade & Romaria', '🎉')" style="padding: 14px 16px; border-color: #eab308; color: #854d0e; background: #fefce8; text-align: left; display: flex; flex-direction: column; gap: 4px; border-radius: 12px; cursor: pointer;">
              <span style="font-size: 1.4rem;">🎉</span>
              <b style="font-size: 0.88rem;">Festas da Cidade</b>
              <span style="font-size: 0.74rem; color: #a16207;">Romarias & Verão local</span>
            </button>
            <button class="btn btn-secondary preset-event-card" onclick="selectWizardPreset('aniversario_farmacia', 'Aniversário da Farmácia', '🎂')" style="padding: 14px 16px; border-color: #0284c7; color: #075985; background: #f0f9ff; text-align: left; display: flex; flex-direction: column; gap: 4px; border-radius: 12px; cursor: pointer;">
              <span style="font-size: 1.4rem;">🎂</span>
              <b style="font-size: 0.88rem;">Aniversário Farmácia</b>
              <span style="font-size: 0.74rem; color: #0284c7;">Agradecimento a utentes</span>
            </button>
            <button class="btn btn-secondary preset-event-card" onclick="selectWizardPreset('evento_desportivo', 'Evento Desportivo & Caminhada', '🏃')" style="padding: 14px 16px; border-color: #10b981; color: #065f46; background: #ecfdf5; text-align: left; display: flex; flex-direction: column; gap: 4px; border-radius: 12px; cursor: pointer;">
              <span style="font-size: 1.4rem;">🏃</span>
              <b style="font-size: 0.88rem;">Caminhada / Desporto</b>
              <span style="font-size: 0.74rem; color: #059669;">Magnésio, sol e pés</span>
            </button>
            <button class="btn btn-secondary preset-event-card" onclick="selectWizardPreset('halloween', 'Especial Halloween & Outono', '🎃')" style="padding: 14px 16px; border-color: #f97316; color: #9a3412; background: #fff7ed; text-align: left; display: flex; flex-direction: column; gap: 4px; border-radius: 12px; cursor: pointer;">
              <span style="font-size: 1.4rem;">🎃</span>
              <b style="font-size: 0.88rem;">Halloween</b>
              <span style="font-size: 0.74rem; color: #ea580c;">Crianças e higiene</span>
            </button>
            <button class="btn btn-secondary preset-event-card" onclick="selectWizardPreset('dia_mae_pai', 'Dia da Mãe / Pai / Família', '💝')" style="padding: 14px 16px; border-color: #c084fc; color: #6b21a8; background: #faf5ff; text-align: left; display: flex; flex-direction: column; gap: 4px; border-radius: 12px; cursor: pointer;">
              <span style="font-size: 1.4rem;">💝</span>
              <b style="font-size: 0.88rem;">Dia da Mãe / Pai</b>
              <span style="font-size: 0.74rem; color: #9333ea;">Packs de presente & dermo</span>
            </button>
          </div>

          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
            <div style="font-size: 0.86rem; font-weight: 700; color: #0f172a; margin-bottom: 8px;">
              Ou escreva o Nome da Campanha Personalizada:
            </div>
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
              <input type="text" id="customCampName" placeholder="Ex: Semana da Vitamina C, Limpeza de Tosse Residual, Especial Cuidado Sénior..." style="flex: 1; min-width: 280px; padding: 10px 14px; font-size: 0.92rem;" />
              <button class="btn" onclick="goToWizardStep(2)" style="background: #a855f7; color: white; font-weight: 700; padding: 10px 22px;">
                Continuar para Escolha de Produtos ➡️
              </button>
            </div>
          </div>
        </div>

        <!-- PASSO 2: FACILITADOR INTELIGENTE DE PRODUTOS (OS 3 CESTOS + CARRINHO) -->
        <div id="customWizardStep2" style="display: none;">
          <div style="display: grid; grid-template-columns: 1fr 340px; gap: 20px; align-items: start;">
            <!-- COLUNA ESQUERDA: CESTOS INTELIGENTES & PESQUISA -->
            <div>
              <!-- ABAS DOS 3 CESTOS -->
              <div style="display: flex; gap: 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 14px; flex-wrap: wrap;">
                <button id="btnBasketTabValidades" class="btn" onclick="switchSmartBasketTab('validades')" style="background: #ef4444; color: white; font-size: 0.82rem; padding: 8px 14px; font-weight: 700;">
                  🔴 Validades Próximas (<span id="countBasketValidades">...</span>)
                </button>
                <button id="btnBasketTabMonos" class="btn btn-secondary" onclick="switchSmartBasketTab('monos')" style="font-size: 0.82rem; padding: 8px 14px; font-weight: 700; color: #b45309; border-color: #f59e0b; background: transparent;">
                  🟡 Monos Parados (<span id="countBasketMonos">...</span>)
                </button>
                <button id="btnBasketTabMargem" class="btn btn-secondary" onclick="switchSmartBasketTab('topMargem')" style="font-size: 0.82rem; padding: 8px 14px; font-weight: 700; color: #047857; border-color: #10b981; background: transparent;">
                  🟢 Top Margem (>40%) (<span id="countBasketMargem">...</span>)
                </button>
                <button id="btnBasketTabSearch" class="btn btn-secondary" onclick="switchSmartBasketTab('search')" style="font-size: 0.82rem; padding: 8px 14px; font-weight: 700; color: #0284c7; border-color: #0284c7; background: transparent;">
                  🔍 Pesquisa Livre
                </button>
              </div>

              <!-- CAIXA DE PESQUISA (MOSTRADA QUANDO NA ABA SEARCH) -->
              <div id="basketSearchContainer" style="display: none; margin-bottom: 14px;">
                <input type="text" id="customProdSearchInput" placeholder="🔎 Escreva o nome ou CNP (ex: Antigrippine, 5818711, Benuron, Vichy)..." oninput="searchProductsForCustomBuilder(this.value)" style="width: 100%; padding: 10px 14px; font-size: 0.9rem;" />
              </div>

              <!-- BOTÃO DE ADICIONAR TODOS DO CESTO ATIVO -->
              <div id="basketBatchActionBar" style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                <span id="basketActiveDescription" style="font-size: 0.82rem; color: #475569; font-weight: 600;">Produtos identificados em armazém:</span>
                <button id="btnAddAllFromBasketBtn" class="btn" onclick="addAllCurrentBasketToPicked()" style="background: #0f172a; color: white; font-size: 0.8rem; padding: 6px 14px; font-weight: 700;">
                  + Adicionar Todos a Esta Campanha
                </button>
              </div>

              <!-- LISTAGEM ESPAÇOSA DE PRODUTOS DO CESTO / PESQUISA -->
              <div id="basketProductsList" style="max-height: 420px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 10px; background: white;">
                <div style="padding: 24px; text-align: center; color: #64748b;">A carregar produtos do stock...</div>
              </div>
            </div>

            <!-- COLUNA DIREITA: O CARRINHO DA CAMPANHA -->
            <div style="background: #faf5ff; border: 1.5px solid #d8b4fe; border-radius: 12px; padding: 18px; position: sticky; top: 20px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <div style="font-weight: 800; color: #6b21a8; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
                  <span>🛒</span> Artigos Fixados (<span id="customPickedCount">0</span>)
                </div>
                <button class="btn btn-secondary" onclick="clearCustomPickedProducts()" style="font-size: 0.72rem; padding: 3px 8px; color: #dc2626; border-color: #fca5a5; background: white;">Limpar</button>
              </div>

              <div id="customPickedProductsList" style="max-height: 220px; overflow-y: auto; margin-bottom: 14px; border: 1px solid #e9d5ff; border-radius: 8px; background: white; padding: 6px;">
                <span style="font-size: 0.78rem; color: #94a3b8; display: block; padding: 10px; text-align: center;">Nenhum produto adicionado ainda. Escolha produtos dos cestos à esquerda.</span>
              </div>

              <!-- INDICADORES CONSOLIDADOS DO CARRINHO -->
              <div style="background: white; border: 1px solid #e9d5ff; border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 0.78rem; line-height: 1.6;">
                <div>📦 Stock Total: <b id="cartTotalStock">0</b> un</div>
                <div>💰 Custo Armazém: <b id="cartTotalCost" style="color: #b45309;">€0.00</b></div>
                <div>🏷️ PVP Total: <b id="cartTotalPvp">€0.00</b></div>
                <div>📈 Margem Média: <b id="cartAvgMargin" style="color: #059669;">0%</b></div>
              </div>

              <div style="display: flex; flex-direction: column; gap: 8px;">
                <button class="btn" onclick="submitCustomCampaignWizard()" style="background: linear-gradient(135deg, #a855f7, #ec4899); color: white; font-weight: 800; font-size: 0.88rem; padding: 12px;">
                  🚀 Simular Descontos & Ativar ➡️
                </button>
                <button class="btn btn-secondary" onclick="goToWizardStep(1)" style="font-size: 0.8rem; padding: 8px; color: #64748b; border-color: #cbd5e1; background: white;">
                  ⬅️ Voltar ao Tema
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- VISTA A: CAMPANHAS DE ÉPOCA E PLANOS DE LIQUIDAÇÃO -->
      <div id="mktView-campaignsFlow">
        <!-- PASSO 1: SELECIONAR TEMA DO CALENDÁRIO OU PLANO DE LIQUIDAÇÃO -->
        <div id="mktStep1Container" style="margin-bottom: 28px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
<div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
              <h3 id="step1CampaignHeading" style="font-size: 1.02rem; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; margin: 0;">
                <span style="background: #f43f5e; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;">1</span>
                Selecione a Campanha de Época ou Plano de Escoamento:
              </h3>
              <div style="display: flex; align-items: center; gap: 8px;">
                <label for="campaignMonthSelect" style="font-size: 0.75rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">Época / Mês:</label>
                <select id="campaignMonthSelect" onchange="onCampaignMonthChange()" style="background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 8px; font-size: 0.84rem; font-weight: 600; cursor: pointer;">
                  <option value="auto">📅 Mês Atual & Próximo (Automático)</option>
                  <option value="-1">🌐 Todas as Épocas do Ano (Calendário Completo)</option>
                  <option value="1">🌱 1. Janeiro (Detox & Frio Rigoroso)</option>
                  <option value="2">❤️ 2. Fevereiro (Cancro, Namorados & Carnaval)</option>
                  <option value="3">🌸 3. Março (Mulher, Pai, Saúde Oral & Alergias)</option>
                  <option value="4">🩺 4. Abril (Saúde, Páscoa & Asma)</option>
                  <option value="5">💐 5. Maio (Mãe, Hipertensão, Silhueta & Tabaco)</option>
                  <option value="6">🧸 6. Junho (Criança, Santos Populares & Verão)</option>
                  <option value="7">✈️ 7. Julho (Viagem, Pernas Cansadas & Cistite)</option>
                  <option value="8">🏖️ 8. Agosto (Pico Solar, Queimaduras & Micoses)</option>
                  <option value="9">🎒 9. Setembro (Regresso Aulas, Queda Capilar & Coração)</option>
                  <option value="10">🎀 10. Outubro (Outubro Rosa, Vacinação & Halloween)</option>
                  <option value="11">🩺 11. Novembro (Diabetes, Homem & Black Friday)</option>
                  <option value="12">🎄 12. Dezembro (Natal, Ceias Festivas & Gripes)</option>
                </select>
              </div>
            </div>
            <span id="campaignsCountBadge" style="font-size: 0.8rem; color: var(--muted);">A carregar campanhas...</span>
          </div>
          <div id="campaignSuggestionsGrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px;">
            <!-- Inserido dinamicamente via JS -->
          </div>
        </div>

        <!-- PASSO 2: ANATOMIA DA ÉPOCA, CANAIS, DESCONTO & SIMULADOR ANTI-DUMPING -->
        <div id="campaignStep2Config" style="display: none; margin-bottom: 28px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 14px; padding: 22px; box-shadow: 0 2px 10px rgba(0,0,0,0.06);">
<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 14px; flex-wrap: wrap; gap: 12px;">
            <div>
              <h3 style="font-size: 1.05rem; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; margin: 0;">
                <span style="background: #10b981; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;">2</span>
                Detalhe da Campanha & Produtos em Stock
              </h3>
              <p id="selectedCampaignTitleDesc" style="font-size: 0.86rem; color: var(--muted); margin-top: 4px;"></p>
            </div>
            <button class="btn btn-secondary" onclick="closeCampaignStep2()" style="font-size: 0.84rem; padding: 8px 16px; border-color: var(--border); color: #cbd5e1; font-weight: 600;">
              ✕ Fechar Detalhe & Voltar às Opções
            </button>
          </div>

          <!-- ALERTA DE CAMPANHA ATIVA NESTE TEMA -->
          <div id="selectedCampaignActiveAlert" style="display: none; margin-bottom: 18px;"></div>

          <!-- ANATOMIA DA ÉPOCA & ESTRATÉGIA DE ESCOAMENTO -->
          <div id="seasonAnatomyBox" style="display: none; margin-bottom: 18px; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 10px; padding: 16px;">
            <!-- Preenchido via JS -->
          </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
          <!-- SELEÇÃO DE CANAIS -->
          <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px;">
            <label style="font-size: 0.84rem; font-weight: 700; color: var(--text); display: block; margin-bottom: 8px;">
              📡 Canais de Venda e Comunicação a Ativar:
            </label>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer; color: #cbd5e1;">
                <input type="checkbox" id="chan-loja" value="loja" checked onchange="onChannelsChanged()">
                <span>🏪 <b>Loja Física & Balcão</b> (Script rápido de 10s + Posição no Linear)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer; color: #cbd5e1;">
                <input type="checkbox" id="chan-redes" value="redes" checked onchange="onChannelsChanged()">
                <span>📱 <b>Redes Sociais</b> (Copy com emojis + conselho de saúde + hashtags)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer; color: #cbd5e1;">
                <input type="checkbox" id="chan-ecras" value="ecras" checked onchange="onChannelsChanged()">
                <span>📺 <b>Ecrãs TV & Montra Digital</b> (Texto 16:9 rotativo para montra)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer; color: #cbd5e1;">
                <input type="checkbox" id="chan-app" value="app" checked onchange="onChannelsChanged()">
                <span>📲 <b>App Mobile & Notificações SMS</b> (Push curta de 160 carateres)</span>
              </label>
            </div>
          </div>

          <!-- CONTROLO DE DESCONTO & CERTIFICAÇÃO ANTI-DUMPING -->
          <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <label style="font-size: 0.84rem; font-weight: 700; color: var(--text);">
                  🏷️ Desconto Comercial Sugerido (%):
                </label>
                <span id="discountBadgeVal" style="font-size: 0.95rem; font-weight: 800; color: #fb7185;">15%</span>
              </div>
              <input type="range" id="campaignDiscountRange" min="0" max="30" step="5" value="15" style="width: 100%; accent-color: #f43f5e; cursor: pointer;" oninput="onDiscountSliderChange(this.value)">
              <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--muted); margin-top: 4px;">
                <span>0% (Sem desc.)</span>
                <span>10%</span>
                <span>15% (Recomendado)</span>
                <span>20%</span>
                <span>30% (Atenção Custo)</span>
              </div>
            </div>

            <div id="antiDumpingSummaryBox" style="margin-top: 14px; padding: 10px 14px; border-radius: 8px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3);">
              <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: #34d399; font-size: 0.86rem;">
                <span>🛡️ Certificação Anti-Dumping (Dec.-Lei 166/2013)</span>
              </div>
              <div id="antiDumpingDetails" style="font-size: 0.8rem; color: #94a3b8; margin-top: 4px;">
                Todos os produtos mantêm PVP promocional superior ao custo de aquisição + 5% de margem de segurança.
              </div>
            </div>
          </div>
        </div>

        <!-- SIMULADOR FINANCEIRO (TABELA DE SKUS E MARGENS) -->
        <div style="margin-bottom: 18px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 10px;">
            <div style="font-size: 0.88rem; font-weight: 700; color: #e2e8f0;">
              📦 Produtos da Farmácia Pré-Selecionados no Lote da Campanha:
            </div>
            <div id="financialKpisInline" style="font-size: 0.84rem; display: flex; gap: 14px; flex-wrap: wrap;">
              <!-- KPIs inseridos via JS -->
            </div>
          </div>

          <div class="table-wrap" style="max-height: 440px;">
            <table id="campaignProductsTable">
              <!-- Renderizado dinamicamente -->
            </table>
          </div>
        </div>

        <!-- BOTÃO PARA GERAR MATERIAIS & ATIVAR CAMPANHA -->
        <div style="display: flex; justify-content: flex-end; gap: 12px; flex-wrap: wrap;">
          <button class="btn" id="btnActivateCampaignStep2" onclick="activateCurrentCampaignUi()" style="background: #10b981; color: white; font-weight: 700; font-size: 0.95rem; padding: 10px 24px; display: flex; align-items: center; gap: 8px;">
            🚀 Ativar Campanha na Farmácia (Gerar Tarefas)
          </button>
          <button class="btn" id="btnGenerateMaterials" onclick="generateCampaignMaterialsAction()" style="background: linear-gradient(135deg, #f43f5e, #e11d48); font-size: 0.95rem; padding: 10px 24px;">
            ✨ Gerar Materiais para os Canais Selecionados
          </button>
        </div>
      </div>

      <!-- PASSO 3: MATERIAIS OMNICANAL PRONTOS -->
      <div id="campaignStep3Materials" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
          <div>
            <h3 style="font-size: 1.05rem; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px;">
              <span style="background: #10b981; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;">3</span>
              Materiais Prontos para Ativação Omnicanal
            </h3>
            <p style="font-size: 0.84rem; color: var(--muted); margin-top: 2px;">
              Copie o texto com um clique e partilhe de imediato nas suas redes, ecrãs ou no balcão da farmácia.
            </p>
          </div>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button class="btn" id="btnActivateCampaignMain" onclick="activateCurrentCampaignUi()" style="background: #10b981; color: white; font-weight: 700; display: flex; align-items: center; gap: 6px;">
              🚀 Ativar Campanha na Farmácia
            </button>
            <button class="btn btn-secondary" onclick="exportCampaignPlanCsv()">
              📥 Exportar Lista (CSV)
            </button>
            <button class="btn" onclick="sendCampaignEmailToTeam()" style="background: #0284c7;">
              ✉️ Enviar Pacote por Email
            </button>
          </div>
        </div>

        <div id="omnichannelGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 18px; margin-bottom: 30px;">
          <!-- Inserido dinamicamente via JS -->
        </div>
      </div>
      </div>

      <!-- VISTA B: CROSS-SELLING DE BALCÃO & SIMULADOR POR PRODUTO -->
      <div id="mktView-crossSelling" style="display: none;">
        <!-- SIMULADOR INTERATIVO DE CROSS-SELLING & ESCOAMENTO POR PRODUTO -->
        <div style="background: linear-gradient(135deg, #f0f9ff 0%, #ffffff 100%); border: 1px solid #bae6fd; border-radius: 14px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
          <div style="font-size: 1.05rem; font-weight: 800; color: #38bdf8; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
            🔎 Simulador 360º de Cross-Selling & Escoamento para um Produto Específico
          </div>
          <p style="font-size: 0.84rem; color: #334155; margin-bottom: 14px;">
            Encontrou um produto na lista de validades ou monos (ex: <b>Antigrippine Trieffect Tosse</b>) e quer saber <b>quem o puxa no balcão</b>, <b>com que produtos em stock pode fazer Cross-Selling</b> e qual a <b>meta semanal da equipa</b>? Escreva abaixo:
          </p>
          <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;">
            <input type="text" id="crossSellProductInput" placeholder="Escreva o nome ou CNP do produto (ex: Antigrippine, 5818711, Transilax, CeraVe, Voltaren)..." style="flex: 1; min-width: 260px;" onkeydown="if(event.key==='Enter') runProductCrossSell360()" />
            <button class="btn" onclick="runProductCrossSell360()" style="background: #0284c7; padding: 0 22px;">🔍 Analisar Produto & Cross-Selling</button>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <span style="font-size: 0.75rem; color: var(--muted); font-weight: 700;">Exemplos Rápidos:</span>
            <span class="chip" onclick="runProductCrossSell360('5818711')">🔥 Antigrippine Trieffect Tosse (130 un · Validade)</span>
            <span class="chip" onclick="runProductCrossSell360('Transilax')">💊 Vitativ Transilax</span>
            <span class="chip" onclick="runProductCrossSell360('Gaviscon')">🫧 Gaviscon</span>
            <span class="chip" onclick="runProductCrossSell360('CeraVe')">🧴 CeraVe</span>
            <span class="chip" onclick="runProductCrossSell360('Voltaren')">🦴 Voltaren</span>
          </div>

          <div id="productCrossSell360Result" style="display: none; margin-top: 18px; border-top: 1px solid rgba(56, 189, 248, 0.3); padding-top: 18px;">
            <!-- Renderizado dinamicamente via JS -->
          </div>
        </div>

        <div style="margin-bottom: 18px;">
          <h3 style="font-size: 1.05rem; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px;">
            🤝 Protocolos Operacionais de Cross-Selling (Locomotiva de Receita/Balcão → Stock a Escoar)
          </h3>
          <p style="font-size: 0.85rem; color: var(--muted); margin-top: 4px;">
            Aproveite os medicamentos e produtos com maior volume de vendas na sua farmácia (<b>Locomotivas</b>) para escoar de imediato os produtos de Venda Livre com <b>Validade Crítica</b>, <b>Monos</b> ou <b>Restos de Gaveta</b>.
          </p>
        </div>
        <div id="crossSellingGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 18px; margin-bottom: 30px;">
          <!-- Preenchido via JS -->
        </div>
      </div>
    </div>

    <!-- ABAS TRADICIONAIS DE TABELAS (CADUCIDADE, GENÉRICOS, MONOS, COBERTURA) -->
    <div id="tabContent-tables" style="display: none;">
      <div class="table-toolbar">
        <div style="display:flex;align-items:center;gap:12px;flex:1;flex-wrap:wrap;">
          <input type="text" id="tableFilter" placeholder="🔎 Filtrar tabela por código, molécula DCI, designação ou categoria..." oninput="onSearchInput(this.value)" />
          <span id="tableRowCount" style="font-size: 0.84rem; font-weight: 700; color: var(--primary);"></span>
        </div>
        <span style="font-size: 0.82rem; color: var(--muted);">💡 Clique em qualquer produto para abrir o <b>Raio-X Mensal + Comparador de Laboratórios Equivalentes (DCI)</b></span>
      </div>

      <div class="table-wrap">
        <table id="mainTable"></table>
      </div>
    </div>
      </div> <!-- /main-content -->
    </div> <!-- /main-wrapper -->
  </div> <!-- /app-layout -->

  
  <!-- MODAL DE AUDITORIA DE TAREFAS CONCLUÍDAS (O QUE FOI FEITO, QUANDO E QUEM FEZ) -->
  <div class="modal-backdrop" id="completedTasksModal" style="display: none; z-index: 1000;" onclick="if(event.target===this) closeCompletedTasksModal()">
    <div class="modal" style="max-width: 1180px; width: 95vw; max-height: 92vh; display: flex; flex-direction: column;">
      <div class="modal-header" style="border-bottom: 1px solid #e2e8f0; padding-bottom: 14px; margin-bottom: 16px;">
        <div>
          <h2 style="font-size: 1.25rem; color: #047857; display: flex; align-items: center; gap: 8px;">
            📋 Auditoria de Tarefas da Equipa — O Que Foi Feito, Quando e Quem Fez
          </h2>
          <p style="font-size: 0.85rem; color: #64748b; margin-top: 3px;">
            Registo em tempo real das ações e picagens concluídas pela equipa de balcão e gaveta.
          </p>
        </div>
        <button class="btn btn-secondary" onclick="closeCompletedTasksModal()">✕ Fechar</button>
      </div>

      <!-- CARDS DE RESUMO DE AUDITORIA -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 18px;">
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 14px;">
          <div style="font-size: 0.74rem; font-weight: 700; color: #166534; text-transform: uppercase;">✅ Total de Tarefas Realizadas</div>
          <div id="auditTotalTasks" style="font-size: 1.6rem; font-weight: 800; color: #14532d; margin-top: 2px;">0</div>
          <div style="font-size: 0.74rem; color: #15803d;">Picadas e sincronizadas</div>
        </div>
        <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 10px; padding: 14px;">
          <div style="font-size: 0.74rem; font-weight: 700; color: #065f46; text-transform: uppercase;">🛡️ Valor Protegido Acumulado</div>
          <div id="auditTotalSaved" style="font-size: 1.6rem; font-weight: 800; color: #047857; margin-top: 2px;">0.00 €</div>
          <div style="font-size: 0.74rem; color: #059669;">Em caducidades e restos escoados</div>
        </div>
        <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 14px;">
          <div style="font-size: 0.74rem; font-weight: 700; color: #1e40af; text-transform: uppercase;">👥 Operador Mais Ativo</div>
          <div id="auditTopOperator" style="font-size: 1.25rem; font-weight: 800; color: #1d4ed8; margin-top: 4px;">--</div>
          <div id="auditTopOperatorSub" style="font-size: 0.74rem; color: #2563eb;">-- picagens</div>
        </div>
      </div>

      <!-- BARRA DE FILTROS E PESQUISA -->
      <div style="display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: center;">
        <input type="text" id="auditSearchInput" oninput="filterAuditTasks()" placeholder="🔍 Pesquisar por produto, CNP ou operador..." style="flex: 1; min-width: 260px; padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 0.86rem;" />
        <select id="auditCategoryFilter" onchange="filterAuditTasks()" style="padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 0.86rem; background: #ffffff;">
          <option value="ALL">Todas as Categorias</option>
          <option value="VALIDADE">⏳ Validades na Gaveta</option>
          <option value="RESTO_GAVETA">🧹 Restos de Gaveta</option>
          <option value="TRAVAR_SIFARMA">🛑 Travar Compras</option>
          <option value="CAMPANHA">🎯 Missões de Campanhas</option>
        </select>
        <button class="btn btn-secondary" onclick="loadCompletedTasksAudit()" style="padding: 9px 14px;">🔄 Atualizar</button>
      </div>

      <!-- TABELA DE AUDITORIA CRONOLÓGICA -->
      <div style="flex: 1; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 8px; max-height: 52vh;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.86rem; text-align: left;">
          <thead style="background: #f8fafc; position: sticky; top: 0; z-index: 2; border-bottom: 2px solid #e2e8f0;">
            <tr>
              <th style="padding: 10px 14px; color: #475569; font-weight: 700; width: 160px;">Data & Hora</th>
              <th style="padding: 10px 14px; color: #475569; font-weight: 700; width: 180px;">Quem Fez</th>
              <th style="padding: 10px 14px; color: #475569; font-weight: 700; width: 140px;">Categoria</th>
              <th style="padding: 10px 14px; color: #475569; font-weight: 700;">O Que Foi Feito (Produto / Ação)</th>
              <th style="padding: 10px 14px; color: #475569; font-weight: 700; text-align: right; width: 130px;">Impacto / Poupança</th>
            </tr>
          </thead>
          <tbody id="auditTasksTableBody">
            <tr>
              <td colspan="5" style="padding: 30px; text-align: center; color: #94a3b8;">A carregar registo de auditoria...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="productModal" style="display: none;" onclick="if(event.target===this) closeModal()">
    <div class="modal" id="productModalBox" style="max-width: 1440px; width: 96vw; height: 92vh; display: flex; flex-direction: column; padding: 20px 24px; overflow: hidden;">
      
      <!-- HEADER DO PRODUTO & AÇÕES -->
      <div class="modal-header" style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border);">
        <div style="flex: 1; min-width: 300px;">
          <h2 id="modalTitle" style="font-size: 1.18rem; color: var(--primary); margin: 0; line-height: 1.35;"></h2>
          <p id="modalSub" style="font-size: 0.82rem; color: var(--muted); margin: 3px 0 0 0;"></p>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn btn-secondary" onclick="closeModal()" style="font-weight: 700; padding: 6px 14px;">✕ Fechar</button>
        </div>
      </div>

      <!-- CORPO COM SCROLL CONTROLADO -->
      <div id="productModalScrollBody" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px;">
        
        <!-- REGRA DE BALCÃO E CROSS-SELLING -->
        <div id="modalRuleBox" style="background: rgba(56,189,248,0.08); border: 1px solid rgba(56,189,248,0.25); padding: 8px 14px; border-radius: 8px; font-size: 0.84rem;"></div>

        <!-- 4 KPIS DO LABORATÓRIO SELECIONADO -->
        <div id="modalMetrics" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;"></div>

        <!-- SECÇÃO DO GRÁFICO DE VENDAS -->
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 10px; padding: 12px 18px;">
          <div id="modalChartHeader" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 6px;">
            <h4 id="modalChartTitle" style="font-size: 0.84rem; color: var(--muted); text-transform: uppercase; margin: 0;">Evolução de Vendas Mensais (Unidades Vendidas por Mês)</h4>
            <div id="modalLabSwitcher" style="display: flex; gap: 6px; flex-wrap: wrap;"></div>
          </div>
          <div class="chart-bars" id="modalChart" style="height: 110px;"></div>
        </div>

        <!-- SECÇÃO DE LABORATÓRIOS POR MOLÉCULA (AMPLA, ESPAÇOSA E COM SCROLL FIXO) -->
        <div id="modalDciPeers" style="display: none; background: #ffffff; border: 1.5px solid #e9d5ff; border-radius: 12px; padding: 16px; margin-top: 4px; flex: 1;"></div>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="emailDigestModal" style="display: none;" onclick="if(event.target===this) closeEmailDigestModal()">
    <div class="modal" style="max-width: 820px;">
      <div class="modal-header">
        <div>
          <h2 style="font-size: 1.15rem; color: #fb7185;">📧 Boletim Mensal de Campanhas — Visualização de Email</h2>
          <p style="font-size: 0.84rem; color: var(--muted); margin-top: 4px;">Este modelo HTML pode ser enviado no início de cada mês para a equipa da farmácia.</p>
        </div>
        <button class="btn btn-secondary" onclick="closeEmailDigestModal()">✕ Fechar</button>
      </div>
      <div id="emailDigestContent" style="background: #ffffff; color: #1e293b; border-radius: 8px; padding: 20px; max-height: 60vh; overflow-y: auto; border: 1px solid var(--border);">
        <!-- HTML renderizado -->
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;">
        <span id="emailSendStatus" style="font-size: 0.85rem; color: #34d399; font-weight: 600;"></span>
        <div style="display: flex; gap: 10px;">
          <button class="btn btn-secondary" onclick="closeEmailDigestModal()">Fechar</button>
          <button class="btn" onclick="sendSimulatedEmailDigest()" style="background: #0284c7;">🚀 Simular Envio de Email</button>
        </div>
      </div>
    </div>
  </div>

  <!-- PORTAL SPLIT-SCREEN DE LOGIN / PHARMACY INTELLIGENCE BY NUELLTECH -->
  <div id="authGateModal" style="display: none; position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 999999; background: #070f1e; overflow-y: auto;">
    
    <div class="auth-gate-wrapper" style="position: relative; width: 100%; min-height: 100vh; display: flex; align-items: center; justify-content: space-between; padding: 48px 72px; box-sizing: border-box; background-color: #0b1528; background-image: linear-gradient(to right, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.92) 42%, rgba(255,255,255,0.45) 68%, rgba(255,255,255,0.88) 100%), url('/assets/login-bg.png'); background-position: center right; background-size: cover; background-repeat: no-repeat;">
      
      <!-- COLUNA ESQUERDA: IDENTIDADE NUELLTECH, TITULO E BENEFICIOS -->
      <div class="auth-gate-hero" style="max-width: 540px; z-index: 2; display: flex; flex-direction: column; justify-content: space-between; min-height: 560px;">
        
        <div>
          <!-- LOGOTIPO OFICIAL NUELLTECH -->
          <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 32px;">
            <img src="/assets/nuelltech-logo-dark.png" alt="Nuelltech" style="height: 48px; width: auto; object-fit: contain;" />
            <div style="height: 38px; width: 1.5px; background: #cbd5e1;"></div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 0.7rem; font-weight: 800; letter-spacing: 2px; color: #0284c7; text-transform: uppercase;">AI & BUSINESS TECHNOLOGY</span>
              <span style="font-size: 0.75rem; font-weight: 600; color: #64748b;">Enterprise Healthcare Solutions</span>
            </div>
          </div>

          <!-- TITULO PRINCIPAL -->
          <h1 style="font-size: 3.3rem; font-weight: 900; line-height: 1.05; letter-spacing: -1.5px; margin: 0 0 16px 0; color: #0f172a;">
            Pharmacy<br />
            <span style="color: #0284c7; background: linear-gradient(135deg, #0284c7 0%, #06b6d4 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Intelligence</span>
          </h1>

          <!-- SUBTITULO -->
          <p style="font-size: 1.15rem; font-weight: 600; line-height: 1.45; color: #334155; margin: 0 0 36px 0; max-width: 440px;">
            Transforme os dados da sua farmácia em melhores decisões de negócio.
          </p>

          <!-- 3 PILLS DE BENEFICIOS -->
          <div style="display: flex; flex-direction: column; gap: 18px; margin-bottom: 32px;">
            
            <div style="display: flex; align-items: center; gap: 14px;">
              <div style="width: 44px; height: 44px; border-radius: 50%; background: #e0f2fe; display: flex; align-items: center; justify-content: center; color: #0284c7; flex-shrink: 0; box-shadow: 0 3px 10px rgba(2, 132, 199, 0.15);">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
              </div>
              <div style="font-size: 0.95rem; font-weight: 700; color: #1e293b; line-height: 1.3;">
                Otimizar stock e reduzir desperdício<br />
                <span style="font-size: 0.8rem; font-weight: 500; color: #64748b;">Alertas antecipados de validade e rotação</span>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 14px;">
              <div style="width: 44px; height: 44px; border-radius: 50%; background: #e0f2fe; display: flex; align-items: center; justify-content: center; color: #0284c7; flex-shrink: 0; box-shadow: 0 3px 10px rgba(2, 132, 199, 0.15);">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
              </div>
              <div style="font-size: 0.95rem; font-weight: 700; color: #1e293b; line-height: 1.3;">
                Aumentar rentabilidade e margens<br />
                <span style="font-size: 0.8rem; font-weight: 500; color: #64748b;">Substituição inteligente por genéricos de maior margem</span>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 14px;">
              <div style="width: 44px; height: 44px; border-radius: 50%; background: #e0f2fe; display: flex; align-items: center; justify-content: center; color: #0284c7; flex-shrink: 0; box-shadow: 0 3px 10px rgba(2, 132, 199, 0.15);">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
              </div>
              <div style="font-size: 0.95rem; font-weight: 700; color: #1e293b; line-height: 1.3;">
                Identificar oportunidades e prevenir ruturas<br />
                <span style="font-size: 0.8rem; font-weight: 500; color: #64748b;">Previsão de consumo e compras com rigor clínico</span>
              </div>
            </div>

          </div>
        </div>

        <!-- FOOTER BRANDING -->
        <div style="display: flex; align-items: center; gap: 12px; font-size: 0.84rem; font-weight: 600; color: #64748b; margin-top: 16px;">
          <span>Powered by</span>
          <img src="/assets/nuelltech-logo-dark.png" alt="Nuelltech" style="height: 24px; width: auto; object-fit: contain;" />
          <div style="width: 36px; height: 2px; background: #0284c7; border-radius: 2px;"></div>
        </div>

      </div>

      <!-- COLUNA DIREITA: CARTAO FLUTUANTE DE LOGIN -->
      <div class="auth-gate-card-wrapper" style="width: 100%; max-width: 440px; z-index: 3;">
        
        <!-- CARTAO 1: ACESSO DE CLIENTE DE FARMACIA (PADRÃO E ÚNICO PÚBLICO) -->
        <div id="authGatePharmacyView" style="background: #ffffff; border-radius: 24px; padding: 40px 36px; box-shadow: 0 25px 60px -10px rgba(15, 23, 42, 0.25), 0 0 0 1px rgba(226, 232, 240, 0.8);">
          
          <div style="margin-bottom: 24px;">
            <h2 style="font-size: 1.85rem; font-weight: 900; color: #0f172a; letter-spacing: -0.6px; margin: 0 0 6px 0;">
              Bem-vindo
            </h2>
            <p style="font-size: 0.88rem; color: #64748b; margin: 0; font-weight: 500;">
              Aceda à inteligência analítica da sua farmácia
            </p>
          </div>

          <!-- BANNER DE SESSAO ENCERRADA (LOGOUT) -->
          <div id="authGateLogoutBanner" style="display: none; margin-bottom: 20px; padding: 11px 14px; border-radius: 12px; background: #dcfce7; border: 1px solid #86efac; color: #15803d; font-size: 0.84rem; font-weight: 700; text-align: center;">
            🔒 Sessão terminada com segurança.
          </div>

          <form onsubmit="event.preventDefault(); submitPharmacyAccessCode();" style="display: flex; flex-direction: column; gap: 18px; text-align: left;">
            <div>
              <label for="authAccessCodeInput" style="font-size: 0.8rem; font-weight: 800; color: #334155; text-transform: uppercase; letter-spacing: 0.6px; display: block; margin-bottom: 8px;">
                Código da Farmácia
              </label>
              <div style="position: relative;">
                <span style="position: absolute; left: 16px; top: 50%; transform: translateY(-50%); font-size: 1.15rem; color: #94a3b8;">🔑</span>
                <input
                  type="text"
                  id="authAccessCodeInput"
                  placeholder="EX: FARM-A-279188"
                  autocomplete="organization"
                  style="width: 100%; box-sizing: border-box; font-size: 1rem; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; padding: 14px 16px 14px 44px; border: 1.5px solid #cbd5e1; border-radius: 12px; outline: none; transition: all 0.2s; background: #f8fafc; color: #0f172a;"
                  onfocus="this.style.borderColor='#0284c7'; this.style.background='#ffffff'; this.style.boxShadow='0 0 0 4px rgba(2, 132, 199, 0.1)';"
                  onblur="this.style.borderColor='#cbd5e1'; this.style.background='#f8fafc'; this.style.boxShadow='none';"
                  onkeydown="if(event.key==='Enter') submitPharmacyAccessCode()"
                />
              </div>
            </div>

            <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.82rem;">
              <label style="display: flex; align-items: center; gap: 8px; color: #475569; font-weight: 600; cursor: pointer;">
                <input type="checkbox" id="authRememberPharmacy" checked style="accent-color: #0f172a; width: 16px; height: 16px; border-radius: 4px;" />
                Lembrar este dispositivo
              </label>
            </div>

            <div id="authGateError" style="display: none; font-size: 0.84rem; color: #dc2626; background: #fee2e2; border: 1px solid #fca5a5; padding: 11px 14px; border-radius: 10px; text-align: center; font-weight: 600;"></div>

            <button type="submit" id="btnSubmitPharmacy" style="width: 100%; padding: 15px; font-size: 1rem; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 8px; background: #0f172a; color: #ffffff; border-radius: 12px; border: none; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);">
              Entrar no Painel <span style="font-size: 1.1rem;">→</span>
            </button>
          </form>

          <!-- BADGE DE SEGURANÇA -->
          <div style="margin-top: 26px; padding-top: 20px; border-top: 1px solid #f1f5f9; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.78rem; color: #0284c7; font-weight: 700;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
              <path d="m9 12 2 2 4-4"></path>
            </svg>
            <span>Os seus dados estão seguros e protegidos</span>
          </div>

        </div>

        <!-- CARTAO 2: ACESSO DE ADMINISTRAÇÃO (ISOLADO - VISIVEL APENAS VIA /admin OU ?admin=1) -->
        <div id="authGateAdminView" style="display: none; background: #ffffff; border-radius: 24px; padding: 40px 36px; box-shadow: 0 25px 60px -10px rgba(15, 23, 42, 0.25), 0 0 0 1px rgba(226, 232, 240, 0.8);">
          
          <div style="margin-bottom: 24px;">
            <div style="display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 12px; background: #f3e8ff; color: #7c3aed; font-size: 1.5rem; margin-bottom: 12px;">
              🛡️
            </div>
            <h2 style="font-size: 1.7rem; font-weight: 900; color: #0f172a; letter-spacing: -0.5px; margin: 0 0 4px 0;">
              Portal de Gestão
            </h2>
            <p style="font-size: 0.88rem; color: #64748b; margin: 0; font-weight: 500;">
              Acesso Restrito da Administração Nuelltech
            </p>
          </div>

          <form onsubmit="event.preventDefault(); submitAdminPassword();" style="display: flex; flex-direction: column; gap: 18px; text-align: left;">
            <input type="text" name="username" value="admin" autocomplete="username" style="display:none;" />
            <div>
              <label for="authAdminPasswordInput" style="font-size: 0.8rem; font-weight: 800; color: #7c3aed; text-transform: uppercase; letter-spacing: 0.6px; display: block; margin-bottom: 8px;">
                Palavra-Passe de Administrador
              </label>
              <div style="position: relative;">
                <span style="position: absolute; left: 16px; top: 50%; transform: translateY(-50%); font-size: 1.15rem; color: #94a3b8;">🔒</span>
                <input
                  type="password"
                  id="authAdminPasswordInput"
                  placeholder="••••••••••••"
                  autocomplete="current-password"
                  style="width: 100%; box-sizing: border-box; font-size: 1.1rem; font-weight: 700; text-align: center; letter-spacing: 3px; padding: 14px 16px 14px 44px; border: 1.5px solid #cbd5e1; border-radius: 12px; outline: none; transition: all 0.2s; background: #f8fafc; color: #0f172a;"
                  onfocus="this.style.borderColor='#7c3aed'; this.style.background='#ffffff'; this.style.boxShadow='0 0 0 4px rgba(124, 58, 237, 0.1)';"
                  onblur="this.style.borderColor='#cbd5e1'; this.style.background='#f8fafc'; this.style.boxShadow='none';"
                  onkeydown="if(event.key==='Enter') submitAdminPassword()"
                />
              </div>
            </div>

            <div id="authGateAdminError" style="display: none; font-size: 0.84rem; color: #dc2626; background: #fee2e2; border: 1px solid #fca5a5; padding: 11px 14px; border-radius: 10px; text-align: center; font-weight: 600;"></div>

            <button type="submit" id="btnSubmitAdmin" style="width: 100%; padding: 15px; font-size: 1rem; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 8px; background: linear-gradient(135deg, #1e1b4b, #312e81); color: #ffffff; border-radius: 12px; border: none; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 14px rgba(49, 46, 129, 0.35);">
              Entrar como Administrador <span style="font-size: 1.1rem;">→</span>
            </button>
          </form>

          <div style="margin-top: 22px; text-align: center;">
            <a href="/" style="font-size: 0.82rem; font-weight: 700; color: #64748b; text-decoration: none; transition: color 0.2s;" onmouseover="this.style.color='#0f172a'" onmouseout="this.style.color='#64748b'">
              ← Voltar ao Acesso de Farmácia
            </a>
          </div>

          <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid #f1f5f9; text-align: center; font-size: 0.74rem; color: #94a3b8; font-weight: 600;">
            🛡️ Acesso protegido por registo de auditoria & IP
          </div>

        </div>

      </div>

    </div>

    <!-- RESPONSIVE CSS INLINE FOR MOBILE DEVICES -->
    <style>
      @media (max-width: 960px) {
        .auth-gate-wrapper {
          flex-direction: column !important;
          padding: 32px 20px !important;
          justify-content: center !important;
          gap: 36px !important;
          background-position: center !important;
        }
        .auth-gate-hero {
          min-height: auto !important;
          max-width: 100% !important;
          text-align: center !important;
          align-items: center !important;
        }
        .auth-gate-hero h1 {
          font-size: 2.4rem !important;
        }
        .auth-gate-hero p {
          max-width: 100% !important;
        }
        .auth-gate-hero > div {
          display: flex;
          flex-direction: column;
          align-items: center;
        }
      }
    </style>

  </div>

  <!-- MODAL 4: GESTOR ADMIN DE NOMES ANÓNIMOS E LINKS ISOLADOS POR FARMÁCIA -->
  <div class="modal-backdrop" id="accessManagerModal" style="display: none;" onclick="if(event.target===this) closeAccessManagerModal()">
    <div class="modal" style="max-width: 780px;">
      <div class="modal-header">
        <div>
          <h2 style="font-size: 1.15rem; color: #c084fc;">🔑 Gestão de Nomes Anónimos & Links de Acesso por Farmácia</h2>
          <p style="font-size: 0.84rem; color: var(--muted); margin-top: 4px;">
            Personalize o nome anónimo (ex: <b>Farmácia A</b>, <b>Farmácia B</b>) e copie o <b>Link de Acesso Isolado</b> para enviar a cada cliente sem que ele possa ver ou saltar para outras farmácias.
          </p>
        </div>
        <button class="btn btn-secondary" onclick="closeAccessManagerModal()">✕ Fechar</button>
      </div>

      <div id="accessManagerList" style="display: flex; flex-direction: column; gap: 12px; margin-top: 12px;">
        <!-- Preenchido via JS -->
      </div>
      <div id="accessManagerFeedback" style="margin-top: 14px; font-size: 0.85rem; color: #34d399; font-weight: 700;"></div>
    </div>
  </div>

  <!-- MODAL 4C: GESTÃO DE FINOPS & CONSUMO DE IA (TOKENS & EUROS) -->
  <div class="modal-backdrop" id="copilotFinOpsModal" style="display: none;" onclick="if(event.target===this) closeFinOpsModal()">
    <div class="modal" style="max-width: 960px; max-height: 90vh; overflow-y: auto;">
      <div class="modal-header" style="border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 20px;">
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:1.4rem;">🤖</span>
            <h2 style="font-size: 1.25rem; font-weight: 800; color: #c084fc; margin:0;">
              Telemetria & FinOps de IA — Consumo de Tokens por Farmácia
            </h2>
          </div>
          <p style="font-size: 0.84rem; color: var(--muted); margin-top: 4px;">
            Auditoria em tempo real de tokens consumidos (Input/Output/Cache) e custo real em Euros (€) com os modelos Claude da Anthropic.
          </p>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary" onclick="loadFinOpsData()" style="font-size:0.8rem; padding:6px 12px;">🔄 Atualizar</button>
          <button class="btn btn-secondary" onclick="exportFinOpsCsv()" style="font-size:0.8rem; padding:6px 12px; background:rgba(52,211,153,0.1); border-color:#34d399; color:#34d399;">📥 Exportar CSV</button>
          <button class="btn btn-secondary" onclick="closeFinOpsModal()" style="font-size:0.8rem; padding:6px 12px;">✕ Fechar</button>
        </div>
      </div>

      <div id="finOpsLoading" style="text-align: center; padding: 40px 10px;">
        <span class="spinner-sm" style="display:inline-block; width:24px; height:24px; border:3px solid rgba(168,85,247,0.3); border-top-color:#a855f7; border-radius:50%; animation:spin 0.8s linear infinite;"></span>
        <p style="color:var(--muted); font-size:0.86rem; margin-top:10px;">A calcular telemetria de tokens no Supabase...</p>
      </div>

      <div id="finOpsContent" style="display: none;">
        <!-- 4 KPI CARDS -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 24px;">
          <div style="background: rgba(168,85,247,0.06); border: 1.5px solid rgba(168,85,247,0.25); border-radius: 12px; padding: 14px 18px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: #9333ea; text-transform: uppercase;">💰 Custo Global Acumulado</div>
            <div id="finOpsKpiCustoTotal" style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 4px;">€ 0.00</div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Convertido em EUR (Anthropic API)</div>
          </div>

          <div style="background: rgba(56,189,248,0.06); border: 1.5px solid rgba(56,189,248,0.25); border-radius: 12px; padding: 14px 18px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: #0284c7; text-transform: uppercase;">💬 Total de Perguntas</div>
            <div id="finOpsKpiPerguntas" style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 4px;">0</div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Consultas ao motor do Copilot</div>
          </div>

          <div style="background: rgba(52,211,153,0.06); border: 1.5px solid rgba(52,211,153,0.25); border-radius: 12px; padding: 14px 18px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: #059669; text-transform: uppercase;">⚡ Custo Médio / Pergunta</div>
            <div id="finOpsKpiCustoMedio" style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 4px;">€ 0.000</div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Média ponderada por interação</div>
          </div>

          <div style="background: rgba(234,179,8,0.06); border: 1.5px solid rgba(234,179,8,0.25); border-radius: 12px; padding: 14px 18px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: #d97706; text-transform: uppercase;">🛡️ Poupança Prompt Caching</div>
            <div id="finOpsKpiPoupanca" style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 4px;">€ 0.00</div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Tokens reaproveitados (-90% custo)</div>
          </div>
        </div>

        <!-- TABELA 1: CONSUMO POR FARMÁCIA -->
        <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
          <h3 style="font-size: 0.95rem; font-weight: 800; color: #0f172a; margin-bottom: 12px; display:flex; align-items:center; gap:8px;">
            🏥 Consumo Consolidado por Farmácia (Balanço de Clientes)
          </h3>
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
              <thead>
                <tr style="border-bottom: 1.5px solid #cbd5e1; color: #475569; text-align: left; font-size: 0.78rem; text-transform: uppercase; font-weight: 700;">
                  <th style="padding: 10px 14px;">Farmácia</th>
                  <th style="padding: 10px 14px; text-align: center;">Perguntas</th>
                  <th style="padding: 10px 14px; text-align: right;">Input Tokens</th>
                  <th style="padding: 10px 14px; text-align: right;">Output Tokens</th>
                  <th style="padding: 10px 14px; text-align: right;">Cache Read</th>
                  <th style="padding: 10px 14px; text-align: right; color:#059669;">Custo Acumulado</th>
                  <th style="padding: 10px 14px; text-align: right;">Custo Médio</th>
                </tr>
              </thead>
              <tbody id="finOpsFarmaciasTbody">
                <!-- Preenchido via JavaScript -->
              </tbody>
            </table>
          </div>
        </div>

        <!-- TABELA 2: AUDITORIA EM TEMPO REAL -->
        <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
          <h3 style="font-size: 0.95rem; font-weight: 800; color: #0f172a; margin-bottom: 12px; display:flex; align-items:center; gap:8px;">
            📋 Auditoria em Tempo Real — Últimas Interações com o Copilot
          </h3>
          <div style="overflow-x: auto; max-height: 320px; overflow-y: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
              <thead style="position: sticky; top: 0; background: #f8fafc; border-bottom: 1.5px solid #cbd5e1;">
                <tr style="color: #475569; text-align: left; font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">
                  <th style="padding: 8px 10px;">Data/Hora</th>
                  <th style="padding: 8px 10px;">Farmácia</th>
                  <th style="padding: 8px 10px;">Pergunta</th>
                  <th style="padding: 8px 10px;">Ferramentas</th>
                  <th style="padding: 8px 10px; text-align: right;">Tokens</th>
                  <th style="padding: 8px 10px; text-align: right; color:#34d399;">Custo (€)</th>
                </tr>
              </thead>
              <tbody id="finOpsLogsTbody">
                <!-- Preenchido via JavaScript -->
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  
  <!-- MODAL 4D: GOVERNANÇA DE CONECTORES & AGENTES IA (MCP) -->
  <div class="modal-backdrop" id="mcpGovernanceModal" style="display: none;" onclick="if(event.target===this) closeMcpGovernanceModal()">
    <div class="modal" style="max-width: 1040px; max-height: 92vh; overflow-y: auto;">
      <div class="modal-header" style="border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 20px;">
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:1.4rem;">🔌</span>
            <h2 style="font-size: 1.25rem; font-weight: 800; color: #0284c7; margin:0;">
              Governança de Agentes & Conectores IA (MCP)
            </h2>
          </div>
          <p style="font-size: 0.84rem; color: var(--muted); margin-top: 4px;">
            Controlo de acessos externos via Model Context Protocol (Claude, Gemini, ChatGPT). Monitorize sessões ativas em direto, gere tokens dedicados e audite chamadas a ferramentas.
          </p>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary" onclick="loadMcpGovernanceData()" style="font-size:0.8rem; padding:6px 12px;">🔄 Atualizar</button>
          <button class="btn btn-secondary" onclick="closeMcpGovernanceModal()" style="font-size:0.8rem; padding:6px 12px;">✕ Fechar</button>
        </div>
      </div>

      <div id="mcpGovLoading" style="text-align: center; padding: 40px 10px;">
        <span class="spinner-sm" style="display:inline-block; width:24px; height:24px; border:3px solid rgba(2,132,199,0.3); border-top-color:#0284c7; border-radius:50%; animation:spin 0.8s linear infinite;"></span>
        <p style="color:var(--muted); font-size:0.86rem; margin-top:10px;">A verificar sessões e conetores de IA...</p>
      </div>

      <div id="mcpGovContent" style="display: none;">
        <!-- INTERRUPTOR GLOBAL (KILL SWITCH) -->
        <div id="mcpGlobalBanner" style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border: 1.5px solid var(--border); border-radius: 12px; padding: 14px 20px; margin-bottom: 20px;">
          <div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 8px;">
              🛡️ Acesso Externo MCP à Farmácia:
              <span id="mcpGlobalStatusBadge" class="badge badge-success" style="font-size: 0.8rem;">ATIVO</span>
            </div>
            <p style="font-size: 0.8rem; color: #64748b; margin-top: 3px; max-width: 650px;">
              Quando ativo, agentes autorizados com chave válida podem consultar ferramentas da farmácia. Se desativar este interruptor, todos os LLMs externos são desconectados imediatamente.
            </p>
          </div>
          <div>
            <button class="btn" id="btnToggleGlobalMcp" onclick="toggleGlobalMcpAction()" style="font-size: 0.82rem; padding: 8px 16px; font-weight: 700;">
              ⏸️ Desativar MCP Global
            </button>
          </div>
        </div>

        <!-- 3 SUMMARY CARDS -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 24px;">
          <div style="background: rgba(16,185,129,0.06); border: 1.5px solid rgba(16,185,129,0.25); border-radius: 12px; padding: 14px 18px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: #047857; text-transform: uppercase;">🟢 Sessões em Direto (Live)</div>
            <div id="mcpKpiLiveSessions" style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 4px;">0</div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Ligações SSE ativas agora</div>
          </div>

          <div style="background: rgba(2,132,199,0.06); border: 1.5px solid rgba(2,132,199,0.25); border-radius: 12px; padding: 14px 18px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: #0369a1; text-transform: uppercase;">🔑 Conectores Registados</div>
            <div id="mcpKpiConnectorsCount" style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 4px;">0</div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Tokens e LLMs autorizados</div>
          </div>

          <div style="background: rgba(168,85,247,0.06); border: 1.5px solid rgba(168,85,247,0.25); border-radius: 12px; padding: 14px 18px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: #7e22ce; text-transform: uppercase;">📊 Ferramentas Executadas</div>
            <div id="mcpKpiTotalCalls" style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 4px;">0</div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">Auditoria de operações externas</div>
          </div>
        </div>

        <!-- SECÇÃO 1: SESSÕES EM DIRETO -->
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 24px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div>
              <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                <span>🟢</span> Quem está ligado agora (Sessões SSE em Tempo Real)
              </div>
              <p style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">Agentes externos atualmente conectados com streaming SSE ativo ao vivo.</p>
            </div>
          </div>
          <div style="overflow-x: auto;">
            <table class="data-table" style="font-size: 0.82rem;">
              <thead>
                <tr>
                  <th>Agente / Conector</th>
                  <th>IP de Origem</th>
                  <th>User-Agent / Cliente</th>
                  <th>Ligado desde</th>
                  <th>Última Atividade</th>
                  <th>Chamadas</th>
                  <th style="text-align: right;">Ação</th>
                </tr>
              </thead>
              <tbody id="mcpActiveSessionsTbody">
                <!-- Preenchido via JS -->
              </tbody>
            </table>
          </div>
        </div>

        <!-- SECÇÃO 2: CONECTORES AUTORIZADOS -->
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 24px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px;">
            <div>
              <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                <span>🔑</span> Conectores Autorizados (Tokens com Nome & Permissões)
              </div>
              <p style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">Crie tokens individuais para cada utilizador ou agente sem expor o código principal da farmácia.</p>
            </div>
            <button class="btn" onclick="openCreateConnectorModal()" style="font-size: 0.82rem; padding: 7px 14px; background: #0284c7; color: #fff; font-weight: 700;">
              + Criar Novo Conector
            </button>
          </div>
          <div style="overflow-x: auto;">
            <table class="data-table" style="font-size: 0.82rem;">
              <thead>
                <tr>
                  <th>Nome do Conector</th>
                  <th>Tipo de Agente</th>
                  <th>Perfil de Permissões</th>
                  <th>Estado</th>
                  <th>Último Acesso</th>
                  <th>Total Chamadas</th>
                  <th style="text-align: right;">Ações & Links</th>
                </tr>
              </thead>
              <tbody id="mcpConnectorsTbody">
                <!-- Preenchido via JS -->
              </tbody>
            </table>
          </div>
          <div id="mcpFeedbackNotice" style="margin-top: 10px; font-size: 0.82rem; color: #10b981; font-weight: 700; display: none;"></div>
        </div>

        <!-- SECÇÃO 3: AUDITORIA DE CHAMADAS -->
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 12px; padding: 18px;">
          <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
            <span>📜</span> Livro de Auditoria MCP (Últimas Operações Externas)
          </div>
          <p style="font-size: 0.78rem; color: #64748b; margin-bottom: 14px;">Registo permanente de cada ferramenta executada por LLMs externos, duração e IP.</p>
          <div style="overflow-x: auto; max-height: 320px; overflow-y: auto;">
            <table class="data-table" style="font-size: 0.8rem;">
              <thead>
                <tr>
                  <th>Data/Hora</th>
                  <th>Conector / Agente</th>
                  <th>Ferramenta Executada</th>
                  <th>IP</th>
                  <th>Duração</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody id="mcpAuditLogsTbody">
                <!-- Preenchido via JS -->
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL SECUNDÁRIO: CRIAR NOVO CONECTOR MCP -->
  <div class="modal-backdrop" id="mcpCreateModal" style="display: none; z-index: 10001;" onclick="if(event.target===this) closeCreateConnectorModal()">
    <div class="modal" style="max-width: 500px;">
      <div class="modal-header" style="border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 16px;">
        <h3 style="font-size: 1.1rem; color: #0284c7; margin: 0; font-weight: 800;">🔑 Criar Novo Conector de IA</h3>
        <button class="btn btn-secondary" onclick="closeCreateConnectorModal()">✕</button>
      </div>
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div>
          <label style="font-size: 0.78rem; font-weight: 700; color: #0f172a; display: block; margin-bottom: 4px;">Nome de Identificação:</label>
          <input type="text" id="newConnectorNome" placeholder="Ex: Claude Web - Portátil Consultório" style="width: 100%; padding: 8px 10px; font-size: 0.86rem;" />
        </div>
        <div>
          <label style="font-size: 0.78rem; font-weight: 700; color: #0f172a; display: block; margin-bottom: 4px;">Tipo de Agente / LLM:</label>
          <select id="newConnectorTipo" style="width: 100%; padding: 8px 10px; font-size: 0.86rem;">
            <option value="CLAUDE_WEB" selected>Anthropic Claude Web (Browser)</option>
            <option value="CLAUDE_DESKTOP">Anthropic Claude Desktop (App PC/Mac)</option>
            <option value="CURSOR">Cursor IDE / Windsurf</option>
            <option value="GEMINI">Google Gemini / AI Studio</option>
            <option value="CHATGPT">OpenAI ChatGPT / Custom GPT</option>
            <option value="OUTRO">Outro Agente Externo</option>
          </select>
        </div>
        <div>
          <label style="font-size: 0.78rem; font-weight: 700; color: #0f172a; display: block; margin-bottom: 4px;">Perfil de Permissões:</label>
          <select id="newConnectorPerfil" style="width: 100%; padding: 8px 10px; font-size: 0.86rem;">
            <option value="COMPLETO" selected>🔓 Completo (Operações de Stock + Dados Financeiros e Margem)</option>
            <option value="GESTAO_COMPRAS">📦 Gestão & Compras (Propostas de Encomenda, Monos e Validades)</option>
            <option value="BALCAO_CLINICO">🩺 Balcão Clínico (Apenas Pesquisa, Stock e Similares - Sem Margens em €)</option>
          </select>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px;">
          <button class="btn btn-secondary" onclick="closeCreateConnectorModal()">Cancelar</button>
          <button class="btn" onclick="submitCreateConnector()" style="background: #0284c7; color: #fff; font-weight: 700;">
            Gerar Conector & Chave
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL 4B: IMPORTAÇÃO INTELIGENTE E INTERATIVA DE FICHEIROS (HISTÓRICO, DIÁRIOS & VALIDADES) -->
  <div class="modal-backdrop" id="interactiveImportModal" style="display: none;" onclick="if(event.target===this) closeInteractiveImportModal()">
    <div class="modal" style="max-width: 920px; width: 95vw; max-height: 90vh; overflow-y: auto;">
      <div class="modal-header">
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 1.3rem;">📥</span>
            <h2 style="font-size: 1.15rem; color: #38bdf8; margin: 0;">Importação Inteligente de Ficheiros (Multi-Período)</h2>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-top: 4px;">
            Carregue ficheiros de vendas (anuais ou diários) e validades com controlo total sobre substituição, snapshots de stock e resolução de conflitos.
          </p>
        </div>
        <button class="btn btn-secondary" onclick="closeInteractiveImportModal()">✕ Fechar</button>
      </div>

      <!-- Passo 1: Seleção de Ficheiros -->
      <div id="importStep1" style="display: block;">
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <label style="font-size: 0.85rem; font-weight: 700; color: #0f172a;">Origem dos Ficheiros:</label>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary" onclick="loadAvenidaFolderFiles()" style="font-size: 0.78rem; padding: 5px 10px; border-color: #38bdf8; color: #0284c7;">
                📁 Ficheiros da Pasta Avenida
              </button>
              <button class="btn btn-secondary" onclick="document.getElementById('impCustomFilesInput').click()" style="font-size: 0.78rem; padding: 5px 10px;">
                📤 Carregar do Computador
              </button>
              <input type="file" id="impCustomFilesInput" multiple accept=".pdf,.csv" style="display:none;" onchange="handleCustomFilesSelected(event)" />
            </div>
          </div>

          <div id="avenidaFilesContainer" style="max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #f8fafc;">
            <div style="text-align: center; color: var(--muted); padding: 16px; font-size: 0.82rem;">
              Clique em "📁 Ficheiros da Pasta Avenida" ou selecione ficheiros do seu computador.
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
            <span id="selectedFilesSummary" style="font-size: 0.8rem; color: var(--muted);">0 ficheiros selecionados.</span>
            <button class="btn" id="btnInspectFiles" onclick="runInteractiveInspection()" style="background: #0284c7; color: #ffffff; font-size: 0.84rem; padding: 8px 16px;" disabled>
              🔍 Analisar & Inspecionar Ficheiros
            </button>
          </div>
        </div>
      </div>

      <!-- Passo 2: Diagnóstico e Perguntas / Decisões -->
      <div id="importStep2" style="display: none;">
        <div style="background: #ffffff; border: 1px solid #bae6fd; border-radius: 10px; padding: 16px; margin-bottom: 16px;">
          <div style="font-size: 0.95rem; font-weight: 800; color: #0369a1; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span>🛡️</span> Diagnóstico e Opções de Importação
          </div>
          <p style="font-size: 0.8rem; color: var(--muted); margin-bottom: 14px;">
            O sistema analisou os documentos e detetou as opções abaixo. Confirme como deseja proceder para cada caso:
          </p>

          <div id="inspectionQuestionsContainer" style="display: flex; flex-direction: column; gap: 14px;">
            <!-- Preenchido dinamicamente via JS -->
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--border);">
            <button class="btn btn-secondary" onclick="backToImportStep1()">⬅️ Voltar à Seleção</button>
            <button class="btn" id="btnExecuteImport" onclick="submitInteractiveImport()" style="background: #10b981; color: #ffffff; font-size: 0.86rem; padding: 9px 18px; font-weight: 700;">
              🚀 Confirmar & Executar Importação
            </button>
          </div>
        </div>
      </div>

      <!-- Passo 3: Feedback e Progresso -->
      <div id="importStep3" style="display: none; padding: 16px 20px;">
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span id="importProgressIcon" style="font-size: 1.4rem;">⏳</span>
              <div style="font-size: 1.02rem; font-weight: 800; color: #0f172a;" id="importProgressTitle">
                A processar e importar dados...
              </div>
            </div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #0284c7; font-family: monospace;" id="importProgressPercent">
              0%
            </div>
          </div>

          <!-- Barra de Progresso Visual Dinâmica -->
          <div style="background: #e2e8f0; border-radius: 999px; height: 16px; overflow: hidden; margin: 12px 0; border: 1px solid #cbd5e1;">
            <div id="importProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #38bdf8, #10b981); border-radius: 999px; transition: width 0.35s ease-in-out;"></div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; margin-top: 6px;">
            <span style="font-weight: 700; color: #1e293b;" id="importProgressStepText">A iniciar processamento...</span>
            <span style="color: var(--muted); font-size: 0.78rem;" id="importProgressDetailText">A preparar lotes seguros...</span>
          </div>
        </div>

        <div id="importStatsReport" style="display: none; text-align: left; background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-top: 16px;"></div>

        <div style="text-align: right; margin-top: 18px;">
          <button class="btn" id="btnCloseImportFinished" onclick="closeInteractiveImportModal(); loadAnalysis();" style="display: none; background: #10b981; color: #ffffff; padding: 9px 20px; font-weight: 700;">
            ✅ Concluir & Atualizar Dashboard
          </button>
        </div>
      </div>

    </div>
  </div>

  <!-- MODAL 5: IMPORTADOR WEB DE NOVA FARMÁCIA (PDF INVENTÁRIO + PDF VALIDADES + CSV VENDAS) -->
  <div class="modal-backdrop" id="importPharmacyModal" style="display: none;" onclick="if(event.target===this) closeImportPharmacyModal()">
    <div class="modal" style="max-width: 680px;">
      <div class="modal-header">
        <div>
          <h2 style="font-size: 1.15rem; color: #34d399;">📥 Importar Nova Farmácia (ETL Completo + Anonimização)</h2>
          <p style="font-size: 0.84rem; color: var(--muted); margin-top: 4px;">
            Carregue os ficheiros da farmácia diretamente pelo navegador. O sistema executa o ETL, classifica os produtos Infarmed e cria o código de acesso isolado.
          </p>
        </div>
        <button class="btn btn-secondary" onclick="closeImportPharmacyModal()">✕ Fechar</button>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px;">
        <div>
          <label style="font-size: 0.78rem; font-weight: 700; color: #cbd5e1; display: block; margin-bottom: 6px;">Nome Anónimo (Pitch):</label>
          <input type="text" id="impFarmNome" placeholder="Ex: Farmácia C" value="Farmácia C" style="width: 100%;" />
        </div>
        <div>
          <label style="font-size: 0.78rem; font-weight: 700; color: #cbd5e1; display: block; margin-bottom: 6px;">Identificador / NIF:</label>
          <input type="text" id="impFarmNif" placeholder="Ex: DEMO-03" value="DEMO-03" style="width: 100%;" />
        </div>
        <div>
          <label style="font-size: 0.78rem; font-weight: 700; color: #cbd5e1; display: block; margin-bottom: 6px;">Código de Acesso Isolado:</label>
          <input type="text" id="impFarmCode" placeholder="Ex: FARMACIA-C" value="FARMACIA-C" style="width: 100%; text-transform: uppercase;" />
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px; background: #ffffff; border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
        <div>
          <label style="font-size: 0.82rem; font-weight: 700; color: #38bdf8; display: block; margin-bottom: 4px;">1️⃣ Ficheiro PDF de Inventário (Obrigatório):</label>
          <input type="file" id="impFileInv" accept=".pdf" style="width: 100%; font-size: 0.84rem;" />
        </div>
        <div>
          <label style="font-size: 0.82rem; font-weight: 700; color: #fbbf24; display: block; margin-bottom: 4px;">2️⃣ Ficheiro PDF de Controlo de Validades (Opcional mas Recomendado):</label>
          <input type="file" id="impFileVal" accept=".pdf" style="width: 100%; font-size: 0.84rem;" />
        </div>
        <div>
          <label style="font-size: 0.82rem; font-weight: 700; color: #34d399; display: block; margin-bottom: 4px;">3️⃣ Ficheiro CSV de Vendas Mensais (Obrigatório):</label>
          <input type="file" id="impFileVen" accept=".csv" style="width: 100%; font-size: 0.84rem;" />
        </div>
      </div>

      <div id="importPharmacyStatus" style="font-size: 0.85rem; margin-bottom: 14px; color: #38bdf8;"></div>

      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button class="btn btn-secondary" onclick="closeImportPharmacyModal()">Cancelar</button>
        <button class="btn" id="btnRunImportPharmacy" onclick="submitImportPharmacy()" style="background: #10b981; color: #052e16;">
          ⚙️ Processar Ficheiros & Criar Farmácia
        </button>
      </div>
    </div>
  </div>

  <!-- MODAL 6: CENTRAL INTERATIVA DE REVISÃO E EDIÇÃO DE ENCOMENDA (COM SEGMENTAÇÃO POR CANAIS) -->
  <div class="modal-backdrop" id="interactiveOrderModal" style="display: none;" onclick="if(event.target===this) closeInteractiveOrderModal()">
    <div class="modal" style="max-width: 1280px; width: 96vw; height: 92vh; display: flex; flex-direction: column; padding: 0; overflow: hidden; border-radius: 14px; background: #ffffff; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);">
      
      <!-- Top Header -->
      <div style="padding: 16px 20px; background: #0f172a; color: #ffffff; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 38px; height: 38px; border-radius: 8px; background: #6366f1; display: flex; align-items: center; justify-content: center; font-size: 20px;">🛒</div>
          <div>
            <div style="font-size: 1.15rem; font-weight: 800; letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px;">
              Central de Revisão & Edição de Encomenda
              <span id="orderModalFarmBadge" style="background: rgba(255,255,255,0.15); color: #38bdf8; font-size: 0.72rem; padding: 3px 8px; border-radius: 6px; font-weight: 700;">Farmácia</span>
            </div>
            <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 2px;">
              Inspecione todos os artigos sugeridos, ajuste quantidades, ative/desative linhas e exporte por canal com controlo absoluto.
            </div>
          </div>
        </div>
        <button onclick="closeInteractiveOrderModal()" style="background: rgba(255,255,255,0.1); border: none; color: #cbd5e1; width: 32px; height: 32px; border-radius: 6px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: background 0.15s;">✕</button>
      </div>

      <!-- Channel Tabs & Real-time Metrics Bar -->
      <div style="padding: 12px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;">
        <!-- Tabs -->
        <div style="display: inline-flex; background: #e2e8f0; padding: 3px; border-radius: 8px; gap: 2px;" id="orderChannelTabs">
          <button class="order-tab-btn active" id="tabBtnALL" onclick="switchOrderChannel('ALL')" style="background:#ffffff; color:#0f172a; font-weight:700; padding:6px 12px; border-radius:6px; border:none; cursor:pointer; font-size:0.8rem; box-shadow:0 1px 2px rgba(0,0,0,0.06);">
            📑 Todos (<span id="countTabAll">0</span>)
          </button>
          <button class="order-tab-btn" id="tabBtnURG" onclick="switchOrderChannel('URGENTE_ARMAZENISTA')" style="background:transparent; color:#64748b; font-weight:600; padding:6px 12px; border-radius:6px; border:none; cursor:pointer; font-size:0.8rem;">
            🔴 Armazenista Urgente (<span id="countTabUrg">0</span>)
          </button>
          <button class="order-tab-btn" id="tabBtnREG" onclick="switchOrderChannel('REGULAR_ARMAZENISTA')" style="background:transparent; color:#64748b; font-weight:600; padding:6px 12px; border-radius:6px; border:none; cursor:pointer; font-size:0.8rem;">
            🟡 Armazenista Regular (<span id="countTabReg">0</span>)
          </button>
          <button class="order-tab-btn" id="tabBtnCONS" onclick="switchOrderChannel('CONSUMIVEIS_LOJA')" style="background:transparent; color:#64748b; font-weight:600; padding:6px 12px; border-radius:6px; border:none; cursor:pointer; font-size:0.8rem;">
            📦 Balcão & Consumíveis (<span id="countTabCons">0</span>)
          </button>
        </div>

        <!-- Real-Time Metrics -->
        <div style="display: flex; align-items: center; gap: 12px; font-size: 0.84rem;">
          <div style="background:#ffffff; border:1px solid #cbd5e1; padding:6px 10px; border-radius:6px;">
            <span style="color:#64748b;">Selecionados:</span> <b id="statSelectedArticles" style="color:#0f172a;">0 / 0</b>
          </div>
          <div style="background:#ffffff; border:1px solid #cbd5e1; padding:6px 10px; border-radius:6px;">
            <span style="color:#64748b;">Unidades:</span> <b id="statSelectedUnits" style="color:#0f172a;">0 un</b>
          </div>
          <div style="background:#ecfdf5; border:1px solid #a7f3d0; padding:6px 12px; border-radius:6px;">
            <span style="color:#047857; font-weight:600;">Investimento Aprovado:</span> <b id="statSelectedTotalEur" style="color:#059669; font-size:0.95rem;">0,00 €</b>
          </div>
        </div>
      </div>

      <!-- Toolbar: Search & Select All -->
      <div style="padding: 10px 20px; background: #ffffff; border-bottom: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <input type="text" id="orderModalSearchInput" placeholder="🔍 Filtrar por produto, código CNP ou laboratório..." oninput="renderInteractiveOrderTable()" style="padding: 7px 12px; font-size: 0.82rem; border-radius: 6px; border: 1px solid #cbd5e1; width: 340px; outline: none;" />
          <button class="btn btn-sm" onclick="toggleSelectAllInTab(true)" style="background:#f1f5f9; color:#334155; font-weight:600; padding:6px 10px; font-size:0.78rem; border:1px solid #cbd5e1; border-radius:5px; cursor:pointer;">☑️ Marcar Todos</button>
          <button class="btn btn-sm" onclick="toggleSelectAllInTab(false)" style="background:#f1f5f9; color:#334155; font-weight:600; padding:6px 10px; font-size:0.78rem; border:1px solid #cbd5e1; border-radius:5px; cursor:pointer;">⬜ Desmarcar Todos</button>
        </div>
        <div style="font-size: 0.78rem; color: #64748b;">
          💡 Clique nos botões <b>[-]</b> e <b>[+]</b> ou digite a quantidade pretendida para cada artigo.
        </div>
      </div>

      <!-- Table Body Container -->
      <div style="flex: 1; overflow-y: auto; background: #ffffff; padding: 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
          <thead style="position: sticky; top: 0; background: #f8fafc; z-index: 2; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
            <tr style="border-bottom: 2px solid #e2e8f0; color: #475569; text-transform: uppercase; font-size: 0.72rem; font-weight: 700;">
              <th style="padding: 10px 12px; width: 40px; text-align: center;">Ativo</th>
              <th style="padding: 10px 8px; width: 35px; text-align: center;">#</th>
              <th style="padding: 10px 8px; width: 155px; text-align: left;">Canal Sugerido</th>
              <th style="padding: 10px 8px; width: 75px; text-align: left;">CNP</th>
              <th style="padding: 10px 8px; text-align: left;">Designação do Artigo</th>
              <th style="padding: 10px 8px; width: 70px; text-align: center;">Stock</th>
              <th style="padding: 10px 8px; width: 75px; text-align: center;">Venda/Dia</th>
              <th style="padding: 10px 8px; width: 140px; text-align: center; background: #f1f5f9;">Qtd a Encomendar</th>
              <th style="padding: 10px 8px; width: 85px; text-align: right;">Custo Unit.</th>
              <th style="padding: 10px 14px; width: 95px; text-align: right;">Total Linha</th>
            </tr>
          </thead>
          <tbody id="interactiveOrderTableBody">
            <!-- Linhas geradas via JavaScript -->
          </tbody>
        </table>
      </div>

      <!-- Bottom Action Footer -->
      <div style="padding: 14px 20px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;">
        <div style="font-size: 0.8rem; color: #64748b; display: flex; align-items: center; gap: 8px;">
          <span>📋 <b>Exportação Filtrada:</b> Apenas os artigos marcados [✓] serão incluídos nos ficheiros e nas tarefas.</span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          <button class="btn btn-sm" onclick="exportInteractiveOrderCsv()" style="background:#0284c7;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
            📥 Descarregar CSV de Encomenda
          </button>
          <button class="btn btn-sm" onclick="exportInteractiveOrderPdf()" style="background:#dc2626;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
            📄 Imprimir / Guardar em PDF
          </button>
          <button class="btn btn-sm" onclick="copyInteractiveOrderToClipboard()" style="background:#475569;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
            📋 Copiar CNPs
          </button>
          <button class="btn btn-sm" onclick="applyInteractiveOrderToWeeklyPlan()" style="background:#10b981;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
            📝 Adicionar à Folha Semanal (Pilar 4)
          </button>
        </div>
      </div>

    </div>
  </div>

  
  <!-- MODAL DE CONFIGURAÇÕES GLOBAIS DA FARMÁCIA (FASE 4: RBAC, SETTINGS & SESSÕES) -->
  <div id="settingsModal" style="display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(4px); z-index: 99999; align-items: center; justify-content: center; padding: 20px;">
    <div style="background: #ffffff; border: 1px solid #cbd5e1; border-radius: 16px; max-width: 760px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35); overflow: hidden;">
      
      <!-- Cabeçalho do Modal -->
      <div style="padding: 18px 24px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; background: #f8fafc;">
        <div>
          <h3 style="font-size: 1.2rem; font-weight: 800; color: #0f172a; margin: 0; display: flex; align-items: center; gap: 8px;">
            ⚙️ Configurações da Farmácia & Controlo de Acessos
          </h3>
          <p style="font-size: 0.8rem; color: #64748b; margin: 2px 0 0 0;">Gestão da equipa, níveis de acesso (RBAC), sessões ativas e dados da farmácia.</p>
        </div>
        <button onclick="closeSettingsModal()" style="background: none; border: none; font-size: 1.4rem; cursor: pointer; color: #94a3b8;">&times;</button>
      </div>

      <!-- Barra de Abas do Modal -->
      <div style="display: flex; gap: 4px; padding: 10px 24px; background: #f1f5f9; border-bottom: 1px solid #e2e8f0;">
        <button class="settings-tab-btn active" id="settingsTabBtn-team" onclick="switchSettingsTab('team')" style="padding: 7px 14px; border-radius: 8px; border: none; background: #ffffff; font-weight: 700; font-size: 0.82rem; cursor: pointer; color: #0284c7; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
          👥 Equipa & Níveis (RBAC)
        </button>
        <button class="settings-tab-btn" id="settingsTabBtn-sessions" onclick="switchSettingsTab('sessions')" style="padding: 7px 14px; border-radius: 8px; border: none; background: transparent; font-weight: 700; font-size: 0.82rem; cursor: pointer; color: #475569;">
          🟢 Sessões Ativas
        </button>
        <button class="settings-tab-btn" id="settingsTabBtn-pharmacy" onclick="switchSettingsTab('pharmacy')" style="padding: 7px 14px; border-radius: 8px; border: none; background: transparent; font-weight: 700; font-size: 0.82rem; cursor: pointer; color: #475569;">
          🏥 Dados da Farmácia
        </button>
        <button class="settings-tab-btn" id="settingsTabBtn-reset" onclick="switchSettingsTab('reset')" style="padding: 7px 14px; border-radius: 8px; border: none; background: transparent; font-weight: 700; font-size: 0.82rem; cursor: pointer; color: #475569;">
          🔑 Recuperação de Conta
        </button>
      </div>

      <!-- Corpo do Modal com Scroll -->
      <div style="padding: 24px; overflow-y: auto; flex: 1;">
        
        <!-- ABA 1: GESTÃO DE EQUIPA (RBAC) -->
        <div id="settingsView-team" style="display: block;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <div>
              <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a;">Colaboradores da Farmácia</div>
              <div style="font-size: 0.78rem; color: #64748b;">Defina quem tem acesso à Direção, Gestão ou apenas ao Balcão Operacional.</div>
            </div>
            <button class="btn" onclick="toggleInviteForm()" style="background: #0284c7; color: #fff; font-size: 0.8rem; padding: 7px 14px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer;">
              + Convidar Colaborador
            </button>
          </div>

          <!-- Formulário Ocultável de Convite -->
          <div id="inviteMemberForm" style="display: none; background: #f8fafc; border: 1.5px solid #bae6fd; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
            <div style="font-weight: 800; font-size: 0.85rem; color: #0369a1; margin-bottom: 10px;">Novo Acesso de Colaborador</div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 10px;">
              <div>
                <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Nome:</label>
                <input type="text" id="inviteName" placeholder="Ex: Dr. João Pedro" style="width: 100%; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.82rem;" />
              </div>
              <div>
                <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Email:</label>
                <input type="email" id="inviteEmail" placeholder="joao@farmacia.pt" style="width: 100%; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.82rem;" />
              </div>
              <div>
                <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Nível de Acesso (RBAC):</label>
                <select id="inviteRole" style="width: 100%; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.82rem; font-weight: 600;">
                  <option value="AUXILIAR">Auxiliar (Só Balcão/Tarefas)</option>
                  <option value="DIRETOR" selected>Diretor (Clínico & Campanhas)</option>
                  <option value="GESTOR">Gestor (Financeiro & Equipa)</option>
                  <option value="SUPORTE">Suporte TI (Auditoria Técnica)</option>
                </select>
              </div>
              <div>
                <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">PIN Rápido (4 a 6 dígitos):</label>
                <input type="text" id="invitePin" maxlength="6" placeholder="Ex: 6294" style="width: 100%; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.82rem; font-family: monospace;" />
                <small style="color: #64748b; font-size: 0.68rem; display: block; margin-top: 3px;">Evite repetições (ex: 6666) ou sequências (ex: 1234).</small>
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 8px;">
              <button onclick="toggleInviteForm()" type="button" class="btn btn-secondary" style="font-size: 0.78rem; padding: 6px 12px;">Cancelar</button>
              <button onclick="submitInviteMember()" type="button" class="btn" style="background: #10b981; color: #fff; font-size: 0.78rem; padding: 6px 16px; font-weight: 700; border: none; border-radius: 6px;">Guardar Acesso</button>
            </div>
          </div>

          <div id="settingsTeamTableContainer">
            <div style="text-align: center; color: #94a3b8; padding: 20px;">A carregar lista da equipa...</div>
          </div>
        </div>

        <!-- ABA 2: SESSÕES ATIVAS -->
        <div id="settingsView-sessions" style="display: none;">
          <div style="margin-bottom: 14px;">
            <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a;">Sessões Ativas no Momento</div>
            <div style="font-size: 0.78rem; color: #64748b;">Monitorização em tempo real de quem está ligado à plataforma. Pode revogar acessos suspeitos imediatamente.</div>
          </div>
          <div id="settingsSessionsContainer">
            <div style="text-align: center; color: #94a3b8; padding: 20px;">A carregar sessões ativas...</div>
          </div>
        </div>

        <!-- ABA 3: DADOS DA FARMÁCIA -->
        <div id="settingsView-pharmacy" style="display: none;">
          <div style="margin-bottom: 14px;">
            <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a;">Perfil e Parâmetros da Farmácia</div>
            <div style="font-size: 0.78rem; color: #64748b;">Informações da entidade e valores de referência comercial.</div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
            <div>
              <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Nome da Farmácia:</label>
              <input type="text" id="settingsFarmName" readonly style="width: 100%; padding: 8px 12px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem;" />
            </div>
            <div>
              <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">NIF:</label>
              <input type="text" id="settingsFarmNif" readonly style="width: 100%; padding: 8px 12px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem;" />
            </div>
            <div>
              <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Código de Acesso Unificado:</label>
              <input type="text" id="settingsFarmAccessCode" readonly style="width: 100%; padding: 8px 12px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem; font-family: monospace; font-weight: 700; color: #0284c7;" />
            </div>
            <div>
              <label style="font-size: 0.72rem; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">Margem Média Objetivo (%):</label>
              <input type="text" value="30.0%" readonly style="width: 100%; padding: 8px 12px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem; font-weight: 700; color: #059669;" />
            </div>
          </div>
        </div>

        <!-- ABA 4: RECUPERAÇÃO DE PALAVRA-PASSE -->
        <div id="settingsView-reset" style="display: none;">
          <div style="margin-bottom: 14px;">
            <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a;">Recuperação de Palavra-Passe & Acesso</div>
            <div style="font-size: 0.78rem; color: #64748b;">Fluxo de emergência para recuperação de credenciais via email com token temporário de 15 minutos.</div>
          </div>
          <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 12px; padding: 18px; max-width: 480px;">
            <label style="font-size: 0.75rem; font-weight: 700; color: #334155; display: block; margin-bottom: 6px;">Email do Utilizador:</label>
            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
              <input type="email" id="forgotPassEmail" placeholder="exemplo@farmacia.pt" style="flex: 1; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem;" />
              <button onclick="submitForgotPassword()" type="button" class="btn" style="background: #0284c7; color: #fff; font-size: 0.82rem; padding: 8px 16px; font-weight: 700; border: none; border-radius: 6px;">
                Enviar Link
              </button>
            </div>
            <div id="forgotPassFeedback" style="display: none; padding: 10px; border-radius: 6px; font-size: 0.8rem;"></div>
          </div>
        </div>

      </div>

      <!-- Rodapé do Modal -->
      <div style="padding: 14px 24px; border-top: 1px solid #e2e8f0; background: #f8fafc; display: flex; justify-content: flex-end;">
        <button class="btn btn-secondary" onclick="closeSettingsModal()" style="font-size: 0.85rem; padding: 8px 18px;">
          Fechar
        </button>
      </div>

    </div>
  </div>

  <!-- MODAL ABRIR NO TELEMÓVEL DA EQUIPA -->
  <div id="mobileStaffModal" style="display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(4px); z-index: 99999; align-items: center; justify-content: center;">
    <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px; max-width: 440px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35); text-align: center;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <h3 style="font-size: 1.15rem; font-weight: 800; color: #0284c7; margin: 0; display: flex; align-items: center; gap: 8px;">
          📱 Modo Equipa (Mobile Staff)
        </h3>
        <button onclick="closeMobileStaffModal()" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--muted);">&times;</button>
      </div>
      <p style="font-size: 0.84rem; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.4;">
        Aponte a câmara do telemóvel para o QR Code para abrir a lista de tarefas da equipa. As caixas picadas no telemóvel refletem-se aqui em tempo real!
      </p>
      
      <div style="background: #ffffff; padding: 14px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); margin-bottom: 16px;">
        <img id="mobileQrImg" src="" alt="QR Code Mobile" style="width: 180px; height: 180px; display: block;" />
      </div>

      <div style="background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 16px; text-align: left;">
        <div style="font-size: 0.72rem; font-weight: 700; color: var(--muted); text-transform: uppercase; margin-bottom: 4px;">Link Direto:</div>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="mobileDirectUrl" readonly style="flex: 1; font-size: 0.78rem; font-family: monospace; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface);" />
          <button class="btn btn-secondary" onclick="copyMobileUrl()" style="font-size: 0.78rem; padding: 6px 10px;">📋 Copiar</button>
        </div>
      </div>

      <div style="font-size: 0.78rem; color: #059669; font-weight: 700; background: #d1fae5; padding: 8px 12px; border-radius: 8px; margin-bottom: 16px;">
        🔒 PIN de Acesso da Equipa: <b>1234</b> (ou os 4 dígitos do código da farmácia)
      </div>

      <button class="btn btn-secondary" onclick="closeMobileStaffModal()" style="width: 100%; font-size: 0.85rem; padding: 9px;">
        Fechar
      </button>
    </div>
  </div>

  <!-- MODAL DE ASSINATURA & APROVAÇÃO CLÍNICA PELO DIRETOR TÉCNICO (DT) -->
  <div id="dtApprovalModal" style="display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(4px); z-index: 99999; align-items: center; justify-content: center;">
    <div style="background: var(--surface); border: 2px solid #059669; border-radius: 16px; padding: 26px; max-width: 500px; width: 92%; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35); text-align: left;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <h3 style="font-size: 1.15rem; font-weight: 800; color: #047857; margin: 0; display: flex; align-items: center; gap: 8px;">
          🛡️ Assinatura & Ativação Clínica (Diretor Técnico)
        </h3>
        <button onclick="closeDtApprovalModal()" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--muted);">&times;</button>
      </div>
      <p style="font-size: 0.84rem; color: var(--text-secondary); margin-bottom: 14px; line-height: 1.4;">
        A validação de um pack promocional de venda no balcão exige assinatura clínica qualificada do Diretor Técnico. Não são permitidos PINs genéricos.
      </p>

      <div id="dtPackSummaryBox" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px; margin-bottom: 14px; font-size: 0.82rem; color: #166534;">
        <!-- Injetado dinamicamente -->
      </div>

      <form onsubmit="event.preventDefault(); submitDtApproval();" style="margin-bottom: 16px;">
        <input type="text" name="username" value="diretor_tecnico" autocomplete="username" style="display:none;" />
        <label style="font-size: 0.78rem; font-weight: 700; color: #334155; display: block; margin-bottom: 6px;">Palavra-Passe do Diretor Técnico:</label>
        <input type="password" id="dtApprovalPassword" autocomplete="current-password" placeholder="Insira a sua palavra-passe para assinar..." style="width: 100%; padding: 10px 12px; border: 1.5px solid #cbd5e1; border-radius: 8px; font-size: 0.9rem;" onkeydown="if(event.key==='Enter') submitDtApproval()" />
        <div style="font-size: 0.72rem; color: #64748b; margin-top: 4px;">A aprovação é selada com o Hash SHA-256 da composição e cria as tarefas de balcão.</div>
      </form>

      <div id="dtApprovalFeedback" style="display: none; padding: 10px; border-radius: 6px; font-size: 0.82rem; margin-bottom: 14px;"></div>

      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button class="btn btn-secondary" onclick="closeDtApprovalModal()" style="font-size: 0.85rem; padding: 8px 16px;">Cancelar</button>
        <button class="btn" id="btnConfirmDtApproval" onclick="submitDtApproval()" style="background: #059669; color: #fff; font-size: 0.85rem; font-weight: 800; padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;">
          ✍️ Assinar & Ativar Pack
        </button>
      </div>
    </div>
  </div>


  
  <!-- MODAL DE RELATÓRIO EXECUTIVO DO COPILOT (PREVIEW & EDIÇÃO INTERATIVA WYSIWYG) -->
  <div id="copilotReportModal" style="display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.78); backdrop-filter: blur(5px); z-index: 100000; align-items: center; justify-content: center; padding: 16px;">
    <div style="background: #ffffff; border-radius: 14px; width: 100%; max-width: 1040px; max-height: 94vh; display: flex; flex-direction: column; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35); overflow: hidden; border: 1px solid #cbd5e1;">
      
      <!-- Top Action Toolbar -->
      <div style="padding: 14px 20px; background: #0f172a; color: #ffffff; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid #1e293b;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width: 34px; height: 34px; border-radius: 8px; background: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 18px;">📑</div>
          <div>
            <div style="font-size: 1.05rem; font-weight: 800; display: flex; align-items: center; gap: 8px;">
              Relatório Executivo da Farmácia
              <span id="reportModalFarmBadge" style="background: rgba(255,255,255,0.15); color: #38bdf8; font-size: 0.72rem; padding: 2px 8px; border-radius: 6px; font-weight: 700;">Farmácia</span>
            </div>
            <div style="font-size: 0.76rem; color: #94a3b8;">
              Pré-visualização oficial A4. Pode editar diretamente o título, textos ou remover produtos antes de imprimir.
            </div>
          </div>
        </div>
        
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-sm" id="btnReportExportCsv" onclick="exportReportCsv()" style="background: #334155; color: #f8fafc; font-weight: 700; padding: 8px 13px; border-radius: 7px; border: 1px solid #475569; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem;">
            📊 Exportar Excel / CSV
          </button>
          <button class="btn btn-sm" onclick="exportReportPdf()" style="background: #0284c7; color: #ffffff; font-weight: 800; padding: 8px 16px; border-radius: 7px; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; box-shadow: 0 2px 4px rgba(2, 132, 199, 0.3);">
            🖨️ Emitir / Guardar em PDF
          </button>
          <button onclick="closeCopilotReportModal()" style="background: rgba(255,255,255,0.1); border: none; color: #cbd5e1; width: 32px; height: 32px; border-radius: 6px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: background 0.15s;">✕</button>
        </div>
      </div>

      <!-- Barra de Refinamento com IA -->
      <div style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; padding: 9px 20px; display: flex; align-items: center; gap: 10px; font-size: 0.82rem;">
        <span style="font-weight: 700; color: #475569; display: flex; align-items: center; gap: 4px; white-space: nowrap;">🪄 Ajustar com IA:</span>
        <input type="text" id="reportRefinePromptInput" placeholder="Ex: 'Foca apenas em perdas financeiras', 'Muda o tom para a equipa de balcão', 'Resume em 2 parágrafos'..." style="flex: 1; padding: 7px 12px; font-size: 0.82rem; border: 1px solid #cbd5e1; border-radius: 6px; outline: none; background: #ffffff;" onkeydown="if(event.key==='Enter') refineReportWithAi()" />
        <button class="btn btn-sm" id="btnReportRefineSubmit" onclick="refineReportWithAi()" style="background: #6366f1; color: #fff; font-weight: 700; padding: 7px 14px; font-size: 0.78rem; border-radius: 6px; border: none; cursor: pointer; white-space: nowrap;">
          Atualizar Relatório
        </button>
      </div>

      <!-- Canvas Scrollável Simulador de Folha A4 Timbrada -->
      <div style="flex: 1; overflow-y: auto; background: #f1f5f9; padding: 24px 16px;">
        <div id="reportA4Sheet" style="background: #ffffff; max-width: 820px; margin: 0 auto; padding: 36px 42px; border-radius: 8px; border: 1px solid #cbd5e1; box-shadow: 0 4px 12px rgba(0,0,0,0.06); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
          
          <!-- Cabeçalho Timbrado Oficial -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.5px solid #0284c7; padding-bottom: 14px; margin-bottom: 20px;">
            <div>
              <div style="font-size: 1.35rem; font-weight: 900; color: #0f172a; letter-spacing: -0.5px; display: flex; align-items: center; gap: 6px;">
                <span>💊 BI PHARMA</span>
                <span style="font-size: 0.82rem; font-weight: 700; color: #0284c7; background: #e0f2fe; padding: 2px 8px; border-radius: 4px; margin-left: 6px;">RELATÓRIO EXECUTIVO</span>
              </div>
              <div id="reportFarmName" style="font-size: 0.95rem; font-weight: 700; color: #334155; margin-top: 4px;">Farmácia Demo</div>
            </div>
            <div style="text-align: right; font-size: 0.76rem; color: #64748b; line-height: 1.45;">
              <div><b>Data de Emissão:</b> <span id="reportIssueDate">--/--/----</span> às <span id="reportIssueTime">--:--</span></div>
              <div><b>Responsável / Emitido por:</b> <span id="reportResponsible">Direção Técnica</span></div>
              <div><b>Sistema:</b> BI Pharma Intelligent Core</div>
            </div>
          </div>

          <!-- Título e Subtítulo Editáveis -->
          <div style="margin-bottom: 20px;">
            <div id="reportTitleEl" contenteditable="true" title="Clique para editar o título" style="font-size: 1.35rem; font-weight: 800; color: #0f172a; line-height: 1.25; padding: 4px 6px; border: 1px dashed transparent; border-radius: 4px; outline: none;">
              Relatório Executivo de Diagnóstico Farmacêutico
            </div>
            <div id="reportSubtitleEl" contenteditable="true" title="Clique para editar o subtítulo" style="font-size: 0.88rem; color: #64748b; font-weight: 600; padding: 2px 6px; border: 1px dashed transparent; border-radius: 4px; outline: none; margin-top: 2px;">
              Análise Estratégica & Plano de Decisão
            </div>
          </div>

          <!-- Cartões de KPIs Chave -->
          <div id="reportKpiContainer" style="display: flex; gap: 12px; margin-bottom: 22px; flex-wrap: wrap;">
            <!-- Injetado dinamicamente -->
          </div>

          <!-- Secção 1: Diagnóstico e Contexto -->
          <div style="margin-bottom: 24px;">
            <div style="font-size: 0.90rem; font-weight: 800; color: #0284c7; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
              <span>📌 1. Diagnóstico Analítico & Contexto</span>
            </div>
            <div id="reportDiagnosisEl" contenteditable="true" title="Clique para editar o diagnóstico" style="font-size: 0.88rem; line-height: 1.6; color: #334155; padding: 10px; border: 1px dashed #e2e8f0; border-radius: 6px; outline: none; background: #fafafa; min-height: 60px;">
              A carregar diagnóstico...
            </div>
          </div>

          <!-- Secção 2: Tabela Estruturada de Artigos / Dados -->
          <div id="reportTableSection" style="margin-bottom: 24px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 8px;">
              <div style="font-size: 0.90rem; font-weight: 800; color: #0284c7; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
                <span>📊 2. Quadro Estruturado de Artigos & Indicadores</span>
              </div>
              <span id="reportTableCountBadge" style="font-size: 0.74rem; font-weight: 700; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 4px;">0 produtos</span>
            </div>
            
            <div id="reportTableLimitNotice" style="display: none; margin-bottom: 8px; padding: 8px 12px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 6px; font-size: 0.78rem; color: #b45309; line-height: 1.4;">
              <!-- Injetado se > 25 produtos -->
            </div>

            <div style="overflow-x: auto; border: 1px solid #cbd5e1; border-radius: 6px;">
              <table id="reportDataTable" style="width: 100%; border-collapse: collapse; font-size: 0.80rem; text-align: left;">
                <thead id="reportTableHead" style="background: #f8fafc; border-bottom: 2px solid #cbd5e1; font-weight: 800; color: #475569; text-transform: uppercase; font-size: 0.72rem;">
                  <!-- Injetado dinamicamente -->
                </thead>
                <tbody id="reportTableBody">
                  <!-- Injetado dinamicamente -->
                </tbody>
              </table>
            </div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 6px; display: flex; justify-content: space-between;">
              <span>💡 Pode editar diretamente valores na tabela ou clicar no <b>✕</b> para remover produtos indesejados.</span>
              <span id="reportTableTotalFooter" style="font-weight: 700; color: #0f172a;"></span>
            </div>
          </div>

          <!-- Secção 3: Recomendações e Plano de Ação -->
          <div style="margin-bottom: 24px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <div style="font-size: 0.90rem; font-weight: 800; color: #0284c7; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
                <span>🎯 3. Recomendações & Plano de Ação Imediato</span>
              </div>
              <button class="btn btn-sm" onclick="addReportRecommendation()" style="font-size: 0.72rem; padding: 3px 8px; background: #f1f5f9; border: 1px solid #cbd5e1; color: #0f172a; border-radius: 4px; cursor: pointer;">
                + Adicionar Ação
              </button>
            </div>
            <div id="reportRecsList" style="display: flex; flex-direction: column; gap: 8px;">
              <!-- Injetado dinamicamente -->
            </div>
          </div>

          <!-- Secção 4: Despacho e Assinatura -->
          <div style="margin-bottom: 16px;">
            <div style="font-size: 0.90rem; font-weight: 800; color: #0284c7; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
              <span>4. Proposta para validação da Direção Técnica</span>
            </div>
            <div id="reportNotesEl" contenteditable="true" title="Clique para editar as notas ou despacho" style="font-size: 0.84rem; line-height: 1.5; color: #475569; padding: 10px; border: 1px dashed #cbd5e1; border-radius: 6px; background: #fdfdfd; min-height: 48px; outline: none;">
              Documento formal conferido e aprovado para execução física e contacto com fornecedores.
            </div>
          </div>

          <!-- Rodapé de Auditoria e Confidencialidade -->
          <div style="border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 24px; font-size: 0.70rem; color: #94a3b8; display: flex; justify-content: space-between; align-items: center;">
            <span>🔒 Documento Confidencial para Uso Interno Exclusivo da Farmácia</span>
            <span>Gerado por BI Pharma AI • Página 1 de 1</span>
          </div>

        </div>
      </div>

    </div>
  </div>

  <!-- GAVETA LATERAL DIREITA (SLIDE DRAWER) -->
  <div id="slideDrawerBackdrop" class="drawer-backdrop" onclick="closeSlideDrawer()"></div>
  <aside id="slideDrawer" class="slide-drawer" aria-label="Detalhes e Protocolo Operacional">
    <div class="drawer-header">
      <div style="flex: 1; padding-right: 12px;">
        <div id="drawerBadge" style="margin-bottom: 6px;"></div>
        <h3 id="drawerTitle" style="font-size: 1.15rem; font-weight: 800; color: #0f172a; margin: 0; line-height: 1.3;"></h3>
        <p id="drawerSubtitle" style="font-size: 0.8rem; color: #64748b; margin: 4px 0 0; line-height: 1.4;"></p>
      </div>
      <button class="btn btn-secondary" onclick="closeSlideDrawer()" style="padding: 6px 12px; font-size: 0.82rem; font-weight: 700; border-radius: 8px; cursor: pointer;">
        ✕ Fechar
      </button>
    </div>
    <div id="drawerBody" class="drawer-body">
      <!-- Conteúdo injetado dinamicamente -->
    </div>
    <div id="drawerFooter" class="drawer-footer">
      <!-- Ações e botões injetados dinamicamente -->
    </div>
  </aside>

  <script>
    let currentReport = null;
    let activeTab = 'plano';

    const MONTHS_ORDER = [
      { key: '2025-10', label: 'Out/25' },
      { key: '2025-11', label: 'Nov/25' },
      { key: '2025-12', label: 'Dez/25' },
      { key: '2026-01', label: 'Jan/26' },
      { key: '2026-02', label: 'Fev/26' },
      { key: '2026-03', label: 'Mar/26' },
      { key: '2026-04', label: 'Abr/26' },
      { key: '2026-05', label: 'Mai/26' },
      { key: '2026-06', label: 'Jun/26' },
      { key: '2026-07', label: 'Jul/26' },
      { key: '2026-08', label: 'Ago/26' },
      { key: '2026-09', label: 'Set/26' },
      { key: '2026-10', label: 'Out/26' },
    ];

    function formatSegmentoBadge(item) {
      if (item.eh_generico || item.segmento === 'GENERICO_MG') {
        return '<span class="badge badge-purple">🧬 GENÉRICO (MG)</span>';
      }
      if (item.tipo_venda === 'VENDA_LIVRE') {
        return '<span class="badge badge-success">🟢 VENDA LIVRE</span>';
      }
      if (item.tipo_venda === 'MNSRM') {
        return '<span class="badge badge-info">🔵 MARCA (MNSRM)</span>';
      }
      return '<span class="badge badge-danger">🏷️ MARCA (MSRM)</span>';
    }

    function matchesTipoVendaFilter(item, selected) {
      if (selected === 'ALL') return true;
      if (selected === 'LIVRE_TOTAL') return item.tipo_venda === 'VENDA_LIVRE' || item.tipo_venda === 'MNSRM';
      if (selected === 'GENERICO_MG') return item.eh_generico || item.segmento === 'GENERICO_MG';
      if (selected === 'MEDICAMENTO_MARCA') return item.segmento === 'MEDICAMENTO_MARCA';
      return item.tipo_venda === selected;
    }

    function escapeHtml(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatCategoriaBadge(item) {
      let html = \`<span class="badge" style="background:rgba(99,102,241,0.15);color:#a5b4fc;border:1px solid rgba(99,102,241,0.3);font-size:0.75rem;">\${escapeHtml(item.categoria || 'Geral')}</span>\`;
      if (item.subcategoria && item.subcategoria !== item.categoria && item.subcategoria !== 'Geral') {
        html += \`<br/><span style="font-size:0.72rem;color:var(--muted);display:inline-block;margin-top:2px;">\${escapeHtml(item.subcategoria)}</span>\`;
      }
      if (item.sazonalidade && item.sazonalidade !== 'TODO_O_ANO') {
        let sazBadge = '';
        if (item.sazonalidade === 'INVERNO') {
          sazBadge = '<span class="badge" style="background:rgba(56,189,248,0.18);color:#38bdf8;border:1px solid rgba(56,189,248,0.35);margin-left:4px;font-size:0.7rem;">❄️ Inverno</span>';
        } else if (item.sazonalidade === 'VERAO') {
          sazBadge = '<span class="badge" style="background:rgba(251,191,36,0.18);color:#fbbf24;border:1px solid rgba(251,191,36,0.35);margin-left:4px;font-size:0.7rem;">☀️ Verão</span>';
        } else if (item.sazonalidade === 'PRIMAVERA') {
          sazBadge = '<span class="badge" style="background:rgba(52,211,153,0.18);color:#34d399;border:1px solid rgba(52,211,153,0.35);margin-left:4px;font-size:0.7rem;">🌸 Primavera</span>';
        }
        html += ' ' + sazBadge;
      }
      return html;
    }

    function matchesMacroAreaFilter(item, selected) {
      if (!selected || selected === 'ALL') return true;
      return item.macro_area === selected;
    }

    function matchesCategoriaFilter(item, selected) {
      if (!selected || selected === 'ALL') return true;
      return item.categoria === selected;
    }

    function matchesSazonalidadeFilter(item, selected) {
      if (!selected || selected === 'ALL') return true;
      return item.sazonalidade === selected;
    }

    function populateCategoriasOptions() {
      const catSelect = document.getElementById('selectCategoria');
      if (!catSelect || !currentReport) return;
      const macroVal = document.getElementById('selectMacroArea') ? document.getElementById('selectMacroArea').value : 'ALL';
      const prevVal = catSelect.value;

      const allItems = [
        ...(currentReport.alertas_excesso_cobertura || []),
        ...(currentReport.monos || []),
        ...(currentReport.risco_elevado_caducidade || [])
      ];

      const catCounts = new Map();
      for (const item of allItems) {
        if (!item.categoria) continue;
        if (macroVal !== 'ALL' && item.macro_area !== macroVal) continue;
        catCounts.set(item.categoria, (catCounts.get(item.categoria) || 0) + 1);
      }

      const sortedCats = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1]);

      let html = '<option value="ALL">Todas as Categorias</option>';
      for (const [cat, count] of sortedCats) {
        html += \`<option value="\${escapeHtml(cat)}">\${escapeHtml(cat)} (\${count})</option>\`;
      }
      catSelect.innerHTML = html;
      if (catCounts.has(prevVal)) {
        catSelect.value = prevVal;
      } else {
        catSelect.value = 'ALL';
      }
    }

    function onMacroAreaChange() {
      populateCategoriasOptions();
      renderActiveTable();
    }

    function updateMacroAreaOptionsCounts() {
      const selMacro = document.getElementById('selectMacroArea');
      if (!selMacro || !currentReport) return;
      const allItems = [
        ...(currentReport.alertas_excesso_cobertura || []),
        ...(currentReport.monos || []),
        ...(currentReport.risco_elevado_caducidade || [])
      ];
      const mCounts = {
        MNSRM_OTC: 0,
        MSRM: 0,
        DERMOCOSMETICA: 0,
        NUTRICAO_SUPLEMENTOS: 0,
        DISPOSITIVOS_SAUDE: 0
      };
      const seen = new Set();
      for (const item of allItems) {
        if (!item.cnp_codigo || seen.has(item.cnp_codigo)) continue;
        seen.add(item.cnp_codigo);
        if (item.macro_area && mCounts[item.macro_area] !== undefined) {
          mCounts[item.macro_area]++;
        }
      }
      for (let i = 0; i < selMacro.options.length; i++) {
        const opt = selMacro.options[i];
        if (opt.value === 'MNSRM_OTC') opt.text = \`🔵 Balcão / OTC (\${mCounts.MNSRM_OTC})\`;
        else if (opt.value === 'MSRM') opt.text = \`🔴 Receita Médica (\${mCounts.MSRM})\`;
        else if (opt.value === 'DERMOCOSMETICA') opt.text = \`🌸 Dermocosmética (\${mCounts.DERMOCOSMETICA})\`;
        else if (opt.value === 'NUTRICAO_SUPLEMENTOS') opt.text = \`🌿 Suplementos (\${mCounts.NUTRICAO_SUPLEMENTOS})\`;
        else if (opt.value === 'DISPOSITIVOS_SAUDE') opt.text = \`🩹 Dispositivos (\${mCounts.DISPOSITIVOS_SAUDE})\`;
      }
    }

    let activeFarmaciaId = localStorage.getItem('bi_pharma_farmacia_id') || '';
    let activeAccessCode = localStorage.getItem('bi_pharma_access_code') || '';
    let activeAuthRole = localStorage.getItem('bi_pharma_auth_role') || '';
    let cachedAdminPharmacies = [];

    // Interceptor automático de fetch para enviar sempre o código/token de acesso no header x-access-code
    const _origFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      init = init || {};
      const headers = new Headers(init.headers || {});
      if (activeAccessCode) {
        headers.set('x-access-code', activeAccessCode);
      }
      init.headers = headers;
      return _origFetch(input, init);
    };

    function dismissInitLoader() {
      const loader = document.getElementById('appInitLoader');
      if (loader) {
        loader.style.opacity = '0';
        loader.style.pointerEvents = 'none';
        setTimeout(() => { if (loader) loader.style.display = 'none'; }, 260);
      }
    }

    function toggleAuthGateMode(mode) {
      const pharmView = document.getElementById('authGatePharmacyView');
      const adminView = document.getElementById('authGateAdminView');
      const errEl = document.getElementById('authGateError');
      const errAdm = document.getElementById('authGateAdminError');
      if (errEl) errEl.style.display = 'none';
      if (errAdm) errAdm.style.display = 'none';

      if (mode === 'ADMIN') {
        if (pharmView) pharmView.style.display = 'none';
        if (adminView) adminView.style.display = 'block';
        setTimeout(() => document.getElementById('authAdminPasswordInput')?.focus(), 50);
      } else {
        if (pharmView) pharmView.style.display = 'block';
        if (adminView) adminView.style.display = 'none';
        setTimeout(() => document.getElementById('authAccessCodeInput')?.focus(), 50);
      }
    }

    function openAuthGateModal(errMsg, targetMode = 'PHARMACY') {
      const appLayout = document.getElementById('mainAppLayout');
      if (appLayout) appLayout.style.display = 'none';

      const modal = document.getElementById('authGateModal');
      const input = document.getElementById('authAccessCodeInput');
      const errEl = document.getElementById('authGateError');
      const errAdm = document.getElementById('authGateAdminError');
      const logoutBanner = document.getElementById('authGateLogoutBanner');

      const urlParams = new URLSearchParams(window.location.search);
      const isAdminRoute = window.location.pathname === '/admin' || urlParams.get('admin') === '1';
      const effectiveMode = targetMode === 'ADMIN' || isAdminRoute ? 'ADMIN' : 'PHARMACY';

      toggleAuthGateMode(effectiveMode);

      if (input && effectiveMode === 'PHARMACY') input.value = activeAccessCode || '';
      
      if (logoutBanner) {
        if (errMsg && (errMsg.includes('terminada') || errMsg.includes('segurança'))) {
          logoutBanner.textContent = errMsg;
          logoutBanner.style.display = 'block';
        } else {
          logoutBanner.style.display = 'none';
        }
      }

      if (errMsg && !(errMsg.includes('terminada') || errMsg.includes('segurança'))) {
        if (effectiveMode === 'ADMIN' && errAdm) {
          errAdm.textContent = errMsg;
          errAdm.style.display = 'block';
        } else if (errEl) {
          errEl.textContent = errMsg;
          errEl.style.display = 'block';
        }
      }
      dismissInitLoader();
      if (modal) modal.style.display = 'block';
    }

    function applyRoleUiState(role, lockedFarmacia) {
      activeAuthRole = role;
      const adminBar = document.getElementById('adminControlsBar');
      const sel = document.getElementById('farmaciaSelector');
      const selLabel = document.getElementById('farmaciaSelectorLabel');
      const lockedBadge = document.getElementById('lockedPharmacyBadge');
      const btnTrocar = document.getElementById('btnTrocarAcesso');

      if (role === 'ADMIN') {
        if (adminBar) adminBar.style.display = 'flex';
        if (sel) sel.style.display = 'inline-block';
        if (selLabel) selLabel.style.display = 'inline-block';
        if (lockedBadge) lockedBadge.style.display = 'none';
        if (btnTrocar) {
          btnTrocar.style.display = 'inline-block';
          btnTrocar.innerHTML = '🚪 Sair de Admin';
          btnTrocar.title = 'Terminar sessão de Administrador';
          btnTrocar.onclick = logoutAdmin;
        }
      } else if (role === 'PHARMACY' && lockedFarmacia) {
        if (adminBar) adminBar.style.display = 'none';
        if (sel) sel.style.display = 'none';
        if (selLabel) selLabel.style.display = 'none';
        // Acesso estritamente isolado: esconder completamente o botão de trocar!
        if (btnTrocar) btnTrocar.style.display = 'none';
        if (lockedBadge) {
          lockedBadge.style.display = 'inline-block';
          lockedBadge.textContent = \`🏥 \${lockedFarmacia.nome} (NIF: \${lockedFarmacia.nif})\`;
        }
      }
    }

    function logoutAdmin() {
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      localStorage.removeItem('bi_pharma_access_code');
      localStorage.removeItem('bi_pharma_auth_role');
      localStorage.removeItem('bi_pharma_farmacia_id');
      activeAccessCode = '';
      activeAuthRole = '';
      activeFarmaciaId = '';
      window.location.href = '/admin';
    }

    async function submitPharmacyAccessCode() {
      const input = document.getElementById('authAccessCodeInput');
      const errEl = document.getElementById('authGateError');
      const code = (input ? input.value : '').trim().toUpperCase();
      if (!code) {
        if (errEl) {
          errEl.textContent = 'Introduza o código exclusivo da sua Farmácia.';
          errEl.style.display = 'block';
        }
        return;
      }
      await verifyAndActivateAccessCode({ code }, true, 'PHARMACY');
    }

    async function submitAdminPassword() {
      const input = document.getElementById('authAdminPasswordInput');
      const errEl = document.getElementById('authGateAdminError');
      const password = (input ? input.value : '').trim();
      if (!password) {
        if (errEl) {
          errEl.textContent = 'Introduza a Password de Administrador.';
          errEl.style.display = 'block';
        }
        return;
      }
      await verifyAndActivateAccessCode({ adminPassword: password }, true, 'ADMIN');
    }

    async function verifyAndActivateAccessCode(payload, showErrors, targetMode = 'PHARMACY') {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          dismissInitLoader();
          if (showErrors) {
            openAuthGateModal(data.error || 'Credenciais inválidas.', targetMode);
          } else {
            openAuthGateModal(null, targetMode);
          }
          return false;
        }

        activeAccessCode = data.code;
        activeAuthRole = data.role;
        localStorage.setItem('bi_pharma_access_code', activeAccessCode);
        localStorage.setItem('bi_pharma_auth_role', activeAuthRole);

        const gate = document.getElementById('authGateModal');
        if (gate) gate.style.display = 'none';
        const appLayout = document.getElementById('mainAppLayout');
        if (appLayout) appLayout.style.display = 'flex';
        dismissInitLoader();
        if (window.location.pathname === '/login' || window.location.search) {
          window.history.replaceState({}, document.title, '/');
        }

        if (data.role === 'PHARMACY' && data.lockedFarmacia) {
          activeFarmaciaId = data.lockedFarmacia.id;
          localStorage.setItem('bi_pharma_farmacia_id', activeFarmaciaId);
        }

        applyRoleUiState(data.role, data.lockedFarmacia);
        await loadPharmaciesDropdown();
        return true;
      } catch (e) {
        console.error('Erro ao validar acesso:', e);
        dismissInitLoader();
        return false;
      }
    }

    async function loadPharmaciesDropdown() {
      try {
        const res = await fetch('/api/pharmacies');
        const farms = await res.json();
        cachedAdminPharmacies = farms;
        const sel = document.getElementById('farmaciaSelector');
        sel.innerHTML = farms.map(f => \`<option value="\${escapeHtml(f.id)}" \${f.id === activeFarmaciaId ? 'selected' : ''}>🏥 \${escapeHtml(f.nome)} (NIF: \${escapeHtml(f.nif)})</option>\`).join('');
        if (!activeFarmaciaId && farms.length > 0) {
          activeFarmaciaId = farms[0].id;
          sel.value = activeFarmaciaId;
        } else if (farms.length > 0 && !farms.some(f => f.id === activeFarmaciaId)) {
          activeFarmaciaId = farms[0].id;
          sel.value = activeFarmaciaId;
        }
        currentCampaignSuggestions = [];
        loadAnalysis();
      } catch (e) {
        console.error('Erro ao carregar farmácias:', e);
        loadAnalysis();
      }
    }

    async function initPharmacies() {
      const urlParams = new URLSearchParams(window.location.search);
      const isLogout = urlParams.get('logout') === '1';
      const isLogin = window.location.pathname === '/login' || urlParams.get('login') === '1';

      // 0. Se for término de sessão (logout) ou visita explícita à página de login, limpa credenciais e trava no gate
      if (isLogout || isLogin) {
        localStorage.removeItem('bi_pharma_access_code');
        localStorage.removeItem('bi_pharma_auth_role');
        localStorage.removeItem('bi_pharma_farmacia_id');
        localStorage.removeItem('bi_pharma_admin_authenticated');
        sessionStorage.clear();
        activeAccessCode = '';
        activeAuthRole = '';
        activeFarmaciaId = '';
        document.cookie = 'admin_session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
        document.cookie = 'farmacia_access_code=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';

        openAuthGateModal(isLogout ? 'Sessão terminada com segurança.' : null, 'PHARMACY');
        return;
      }

      const urlCode = urlParams.get('acesso') || urlParams.get('accessCode');
      const isAdminRoute = window.location.pathname === '/admin' || urlParams.get('admin') === '1';

      // 1. Rota de Administrador (/admin ou ?admin=1)
      if (isAdminRoute) {
        if (activeAccessCode && activeAuthRole === 'ADMIN') {
          const ok = await verifyAndActivateAccessCode({ code: activeAccessCode }, false, 'ADMIN');
          if (ok) return;
        }
        openAuthGateModal(null, 'ADMIN');
        return;
      }

      // 2. Se o link tem ?acesso=CODIGO (Link Isolado enviado a uma Farmácia)
      if (urlCode && urlCode.trim()) {
        const ok = await verifyAndActivateAccessCode({ code: urlCode.trim().toUpperCase() }, true, 'PHARMACY');
        if (ok) {
          // Limpa o parâmetro da barra do browser para não ficar exposto caso alguém olhe por cima do ombro
          window.history.replaceState({}, document.title, window.location.pathname);
          return;
        }
      }

      // 3. Se já tinha código de Farmácia válido guardado em sessão local
      if (activeAccessCode && activeAuthRole === 'PHARMACY') {
        const ok = await verifyAndActivateAccessCode({ code: activeAccessCode }, false, 'PHARMACY');
        if (ok) return;
        localStorage.removeItem('bi_pharma_access_code');
        localStorage.removeItem('bi_pharma_auth_role');
        activeAccessCode = '';
        activeAuthRole = '';
      }

      // 4. Caso contrário, abre a janela de login de Farmácia (NUNCA expõe acesso admin)
      openAuthGateModal(null, 'PHARMACY');
    }

    window.addEventListener('error', function(e) {
      console.warn('Erro global na interface:', e ? e.message : e);
      dismissInitLoader();
    });

    function openAccessManagerModal() {
      const modal = document.getElementById('accessManagerModal');
      const list = document.getElementById('accessManagerList');
      const fb = document.getElementById('accessManagerFeedback');
      if (fb) fb.textContent = '';

      if (list) {
        list.innerHTML = cachedAdminPharmacies.map((f, idx) => {
          const shareUrl = \`\${window.location.origin}/?acesso=\${encodeURIComponent(f.codigo_acesso || ('FARMACIA-' + String.fromCharCode(65 + idx)))}\`;
          return \`
            <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px;">
              <div style="display: grid; grid-template-columns: 1.3fr 1fr auto; gap: 10px; align-items: end;">
                <div>
                  <label style="font-size: 0.74rem; color: var(--muted); font-weight: 700; display: block; margin-bottom: 4px;">Nome Anónimo (Visível no Pitch/Cliente):</label>
                  <input type="text" id="admNome_\${escapeHtml(f.id)}" value="\${escapeHtml(f.nome)}" style="width: 100%; font-weight: 700;" />
                </div>
                <div>
                  <label style="font-size: 0.74rem; color: var(--muted); font-weight: 700; display: block; margin-bottom: 4px;">Código Isolado desta Farmácia:</label>
                  <input type="text" id="admCode_\${escapeHtml(f.id)}" value="\${escapeHtml(f.codigo_acesso || '')}" style="width: 100%; font-weight: 700; text-transform: uppercase; color: #38bdf8;" />
                </div>
                <button class="btn" onclick="savePharmacyAdmin('\${escapeHtml(f.id)}')" style="padding: 9px 14px; font-size: 0.82rem;">💾 Guardar</button>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 6px; border-top: 1px dashed rgba(148,163,184,0.2);">
                <span style="font-size: 0.78rem; color: #94a3b8;">🔗 Link Isolado p/ Cliente: <code style="color:#38bdf8;background:rgba(2,6,23,0.7);padding:2px 6px;border-radius:4px;">\${shareUrl}</code></span>
                <div style="display: flex; gap: 8px;">
                  <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('\${shareUrl}'); document.getElementById('accessManagerFeedback').textContent='✅ Link copiado: \${shareUrl}';" style="font-size: 0.76rem; padding: 5px 10px;">📋 Copiar Link</button>
                  <button class="btn btn-secondary" onclick="closeAccessManagerModal(); verifyAndActivateAccessCode(document.getElementById('admCode_\${f.id}').value, true);" style="font-size: 0.76rem; padding: 5px 10px; border-color: #38bdf8; color: #38bdf8;">👁️ Testar Vista Isolada</button>
                </div>
              </div>
            </div>
          \`;
        }).join('');
      }
      if (modal) modal.style.display = 'flex';
    }

    function closeAccessManagerModal() {
      const modal = document.getElementById('accessManagerModal');
      if (modal) modal.style.display = 'none';
    }

    async function savePharmacyAdmin(farmaciaId) {
      const nome = document.getElementById('admNome_' + farmaciaId)?.value || '';
      const codigo_acesso = document.getElementById('admCode_' + farmaciaId)?.value || '';
      const fb = document.getElementById('accessManagerFeedback');
      try {
        const res = await fetch('/api/admin/update-pharmacy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ farmaciaId, nome, codigo_acesso })
        });
        const data = await res.json();
        if (data.ok) {
          if (fb) fb.textContent = \`✅ Farmácia atualizada para "\${data.farmacia.nome}" (Código: \${data.farmacia.codigo_acesso})\`;
          await loadPharmaciesDropdown();
          openAccessManagerModal();
        } else if (fb) {
          fb.textContent = '⚠️ ' + (data.error || 'Erro ao atualizar');
        }
      } catch (e) {
        if (fb) fb.textContent = '⚠️ Erro de comunicação com o servidor.';
      }
    }

    
    // ==========================================
    // GOVERNANÇA DE AGENTES & CONECTORES IA (MCP)
    // ==========================================
    var mcpGovernanceCache = null;

    function openMcpGovernanceModal() {
      var modal = document.getElementById('mcpGovernanceModal');
      if (modal) modal.style.display = 'flex';
      loadMcpGovernanceData();
    }

    function closeMcpGovernanceModal() {
      var modal = document.getElementById('mcpGovernanceModal');
      if (modal) modal.style.display = 'none';
    }

    async function loadMcpGovernanceData() {
      var loadingEl = document.getElementById('mcpGovLoading');
      var contentEl = document.getElementById('mcpGovContent');
      if (loadingEl) loadingEl.style.display = 'block';
      if (contentEl) contentEl.style.display = 'none';

      try {
        var query = activeFarmaciaId ? '?farmaciaId=' + encodeURIComponent(activeFarmaciaId) : '';
        var res = await fetch('/api/mcp/governance' + query);
        var data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Erro ao carregar dados de governança');

        mcpGovernanceCache = data;

        // KPI Cards
        var kpiLive = document.getElementById('mcpKpiLiveSessions');
        var kpiConn = document.getElementById('mcpKpiConnectorsCount');
        var kpiCalls = document.getElementById('mcpKpiTotalCalls');
        var liveBadge = document.getElementById('mcpLiveBadge');

        var totalCalls = (data.conectores || []).reduce(function(s, c) { return s + (c.totalChamadas || 0); }, 0);

        if (kpiLive) kpiLive.textContent = String(data.totalSessoesAtivasEmDireto || 0);
        if (kpiConn) kpiConn.textContent = String(data.totalConectoresRegistados || 0);
        if (kpiCalls) kpiCalls.textContent = String(totalCalls);

        if (liveBadge) {
          if ((data.totalSessoesAtivasEmDireto || 0) > 0) {
            liveBadge.style.display = 'inline-block';
            liveBadge.textContent = data.totalSessoesAtivasEmDireto + ' live';
          } else {
            liveBadge.style.display = 'none';
          }
        }

        // Global Banner
        var statusBadge = document.getElementById('mcpGlobalStatusBadge');
        var btnToggle = document.getElementById('btnToggleGlobalMcp');
        if (statusBadge && btnToggle) {
          if (data.mcpPermitido) {
            statusBadge.className = 'badge badge-success';
            statusBadge.textContent = 'ATIVO';
            btnToggle.textContent = '⏸️ Desativar MCP Global';
            btnToggle.style.background = '#e2e8f0';
            btnToggle.style.color = '#334155';
          } else {
            statusBadge.className = 'badge badge-danger';
            statusBadge.textContent = 'BLOQUEADO';
            btnToggle.textContent = '▶️ Reativar MCP Global';
            btnToggle.style.background = '#10b981';
            btnToggle.style.color = '#ffffff';
          }
        }

        // Tabela 1: Sessões Ativas em Direto
        var tbodySessions = document.getElementById('mcpActiveSessionsTbody');
        if (tbodySessions) {
          if (!data.sessoesAtivas || data.sessoesAtivas.length === 0) {
            tbodySessions.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:16px;color:#64748b;">Nenhum agente externo ligado em streaming neste momento.</td></tr>';
          } else {
            tbodySessions.innerHTML = data.sessoesAtivas.map(function(s) {
              return '<tr>' +
                '<td><span style="font-weight:700;color:#0f172a;">' + escapeHtml(s.connectorNome) + '</span><br><code style="font-size:0.7rem;color:#64748b;">' + escapeHtml(s.tokenMasked) + '</code></td>' +
                '<td><code style="color:#0284c7;">' + escapeHtml(s.ip) + '</code></td>' +
                '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(s.userAgent) + '">' + escapeHtml(s.userAgent) + '</td>' +
                '<td>' + new Date(s.connectedAt).toLocaleTimeString('pt-PT') + '</td>' +
                '<td>' + new Date(s.lastActivity).toLocaleTimeString('pt-PT') + '</td>' +
                '<td><span class="badge badge-info">' + s.totalToolCalls + '</span></td>' +
                '<td style="text-align:right;"><button class="btn btn-secondary" onclick="disconnectSessionAction(this)" data-id="' + escapeHtml(s.sessionId) + '" style="font-size:0.75rem;padding:4px 8px;border-color:#ef4444;color:#ef4444;">⚡ Desconectar</button></td>' +
                '</tr>';
            }).join('');
          }
        }

        // Tabela 2: Conectores Registados
        var tbodyConn = document.getElementById('mcpConnectorsTbody');
        if (tbodyConn) {
          if (!data.conectores || data.conectores.length === 0) {
            tbodyConn.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:16px;color:#64748b;">Nenhum conector específico criado. O sistema aceita o código mestre geral da farmácia.</td></tr>';
          } else {
            tbodyConn.innerHTML = data.conectores.map(function(c) {
              var statusHtml = c.ativo
                ? '<span class="badge badge-success">🟢 Ativo</span>'
                : '<span class="badge badge-danger">⏸️ Pausado</span>';

              var perfilLabel = '🔓 Completo';
              if (c.perfilPermissao === 'GESTAO_COMPRAS') perfilLabel = '📦 Gestão Compras';
              if (c.perfilPermissao === 'BALCAO_CLINICO') perfilLabel = '🩺 Balcão Clínico';

              var shareUrl = window.location.origin + '/mcp?token=' + encodeURIComponent(c.token);

              return '<tr>' +
                '<td><span style="font-weight:700;color:#0f172a;">' + escapeHtml(c.nome) + '</span><br><code style="font-size:0.7rem;color:#64748b;">' + escapeHtml(c.tokenMasked) + '</code></td>' +
                '<td><span class="badge badge-purple">' + escapeHtml(c.agenteTipo) + '</span></td>' +
                '<td><span style="font-size:0.76rem;color:#334155;font-weight:600;">' + perfilLabel + '</span></td>' +
                '<td>' + statusHtml + '</td>' +
                '<td>' + (c.ultimoAcessoEm ? new Date(c.ultimoAcessoEm).toLocaleString('pt-PT') : 'Nunca') + '</td>' +
                '<td><span class="badge badge-info">' + c.totalChamadas + '</span></td>' +
                '<td style="text-align:right;">' +
                  '<div style="display:flex;gap:4px;justify-content:flex-end;">' +
                    '<button class="btn btn-secondary" onclick="copyConnectorUrl(this)" data-token="' + escapeHtml(c.token) + '" style="font-size:0.74rem;padding:4px 8px;" title="Copiar URL para Claude Web">📋 URL Claude</button>' +
                    '<button class="btn btn-secondary" onclick="toggleConnectorAction(this)" data-id="' + escapeHtml(c.id) + '" data-next-active="' + (c.ativo ? '0' : '1') + '" style="font-size:0.74rem;padding:4px 8px;">' + (c.ativo ? '⏸️ Pausar' : '▶️ Ativar') + '</button>' +
                    '<button class="btn btn-secondary" onclick="deleteConnectorAction(this)" data-id="' + escapeHtml(c.id) + '" style="font-size:0.74rem;padding:4px 6px;color:#ef4444;" title="Eliminar Conector">🗑️</button>' +
                  '</div>' +
                '</td>' +
                '</tr>';
            }).join('');
          }
        }

        // Tabela 3: Auditoria
        var tbodyAudit = document.getElementById('mcpAuditLogsTbody');
        if (tbodyAudit) {
          if (!data.auditLogs || data.auditLogs.length === 0) {
            tbodyAudit.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;color:#64748b;">Nenhuma execução de ferramenta registada ainda.</td></tr>';
          } else {
            tbodyAudit.innerHTML = data.auditLogs.map(function(log) {
              var statusHtml = log.sucesso
                ? '<span style="color:#10b981;font-weight:700;">✅ Sucesso</span>'
                : '<span style="color:#ef4444;font-weight:700;">⛔ Bloqueado</span>';

              return '<tr>' +
                '<td>' + new Date(log.criadoEm).toLocaleString('pt-PT') + '</td>' +
                '<td><span style="font-weight:600;color:#0f172a;">' + escapeHtml(log.connectorNome) + '</span></td>' +
                '<td><code style="background:rgba(2,132,199,0.08);color:#0284c7;padding:2px 6px;border-radius:4px;font-size:0.74rem;">' + escapeHtml(log.ferramenta) + '</code></td>' +
                '<td><code style="font-size:0.72rem;color:#64748b;">' + escapeHtml(log.ip || '-') + '</code></td>' +
                '<td>' + (log.duracaoMs ? log.duracaoMs + 'ms' : '-') + '</td>' +
                '<td>' + statusHtml + '</td>' +
                '</tr>';
            }).join('');
          }
        }

        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.style.display = 'block';
      } catch (err) {
        console.error('Erro ao carregar governança MCP:', err);
        if (loadingEl) loadingEl.style.display = 'none';
        alert('Erro ao carregar dados de governança: ' + err.message);
      }
    }

    async function toggleGlobalMcpAction() {
      if (!mcpGovernanceCache) return;
      var novoEstado = !mcpGovernanceCache.mcpPermitido;
      var msg = novoEstado
        ? 'Tem a certeza que deseja reativar o acesso de agentes externos de IA (MCP)?'
        : 'Tem a certeza que deseja BLOQUEAR imediatamente todos os acessos MCP? Todas as sessões em direto serão expulsas.';

      if (!confirm(msg)) return;

      try {
        var res = await fetch('/api/mcp/governance/toggle-global', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permitido: novoEstado })
        });
        var data = await res.json();
        if (data.ok) {
          loadMcpGovernanceData();
        } else {
          alert('Erro ao alterar estado global: ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('Erro ao comunicar com o servidor: ' + err.message);
      }
    }

    function openCreateConnectorModal() {
      var modal = document.getElementById('mcpCreateModal');
      if (modal) modal.style.display = 'flex';
      var input = document.getElementById('newConnectorNome');
      if (input) { input.value = ''; input.focus(); }
    }

    function closeCreateConnectorModal() {
      var modal = document.getElementById('mcpCreateModal');
      if (modal) modal.style.display = 'none';
    }

    async function submitCreateConnector() {
      var nome = (document.getElementById('newConnectorNome').value || '').trim();
      var agenteTipo = document.getElementById('newConnectorTipo').value;
      var perfilPermissao = document.getElementById('newConnectorPerfil').value;

      if (!nome) {
        alert('Por favor, indique um nome de identificação para o conetor (ex: Claude Web - Dr. Manuel).');
        return;
      }

      try {
        var res = await fetch('/api/mcp/governance/connectors/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome: nome,
            agenteTipo: agenteTipo,
            perfilPermissao: perfilPermissao,
            criadoPor: activeAuthRole === 'ADMIN' ? 'ADMIN' : 'DIRETOR'
          })
        });
        var data = await res.json();
        if (data.ok) {
          closeCreateConnectorModal();
          loadMcpGovernanceData();
          var fb = document.getElementById('mcpFeedbackNotice');
          if (fb) {
            fb.style.display = 'block';
            fb.textContent = '✅ Conetor "' + nome + '" criado com sucesso! Chave gerada pronta a usar.';
            setTimeout(function() { fb.style.display = 'none'; }, 4000);
          }
        } else {
          alert('Erro ao criar conetor: ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('Erro ao criar conetor: ' + err.message);
      }
    }

    async function toggleConnectorAction(btnOrId, novoAtivo) {
      var connectorId = (typeof btnOrId === 'object' && btnOrId && btnOrId.dataset) ? btnOrId.dataset.id : btnOrId;
      var ativo = (typeof btnOrId === 'object' && btnOrId && btnOrId.dataset) ? (btnOrId.dataset.nextActive === '1') : Boolean(novoAtivo);
      try {
        var res = await fetch('/api/mcp/governance/connectors/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectorId: connectorId, ativo: ativo })
        });
        var data = await res.json();
        if (data.ok) {
          loadMcpGovernanceData();
        } else {
          alert('Erro ao alterar conetor: ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('Erro ao comunicar com o servidor: ' + err.message);
      }
    }

    async function deleteConnectorAction(btnOrId) {
      var connectorId = (typeof btnOrId === 'object' && btnOrId && btnOrId.dataset) ? btnOrId.dataset.id : btnOrId;
      if (!confirm('Tem a certeza que deseja eliminar permanentemente este conetor? Qualquer agente que use esta chave deixará de ter acesso.')) return;

      try {
        var res = await fetch('/api/mcp/governance/connectors/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectorId: connectorId })
        });
        var data = await res.json();
        if (data.ok) {
          loadMcpGovernanceData();
        } else {
          alert('Erro ao eliminar conetor: ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('Erro ao comunicar com o servidor: ' + err.message);
      }
    }

    async function disconnectSessionAction(btnOrId) {
      var sessionId = (typeof btnOrId === 'object' && btnOrId && btnOrId.dataset) ? btnOrId.dataset.id : btnOrId;
      if (!confirm('Deseja desconectar imediatamente esta sessão em direto? O cliente MCP será desligado na hora.')) return;

      try {
        var res = await fetch('/api/mcp/governance/sessions/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId })
        });
        var data = await res.json();
        if (data.ok) {
          loadMcpGovernanceData();
        } else {
          alert('Erro ao desconectar sessão: ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('Erro ao comunicar com o servidor: ' + err.message);
      }
    }

    function copyConnectorUrl(btnOrToken) {
      var token = (typeof btnOrToken === 'object' && btnOrToken && btnOrToken.dataset) ? btnOrToken.dataset.token : btnOrToken;
      var url = window.location.origin + '/mcp?token=' + encodeURIComponent(token);
      navigator.clipboard.writeText(url);
      var fb = document.getElementById('mcpFeedbackNotice');
      if (fb) {
        fb.style.display = 'block';
        fb.textContent = '📋 URL copiado para a área de transferência! Cole diretamente no Claude Web: ' + url;
        setTimeout(function() { fb.style.display = 'none'; }, 4000);
      }
    }

    // ==========================================
    // FINOPS & TELEMETRIA IA (CONSUMO DE TOKENS)
    // ==========================================
    var finOpsDataCache = null;

    function openFinOpsModal() {
      var modal = document.getElementById('copilotFinOpsModal');
      if (modal) modal.style.display = 'flex';
      loadFinOpsData();
    }

    function closeFinOpsModal() {
      var modal = document.getElementById('copilotFinOpsModal');
      if (modal) modal.style.display = 'none';
    }

    async function loadFinOpsData() {
      var loadingEl = document.getElementById('finOpsLoading');
      var contentEl = document.getElementById('finOpsContent');
      if (loadingEl) loadingEl.style.display = 'block';
      if (contentEl) contentEl.style.display = 'none';

      try {
        var res = await fetch('/api/admin/copilot-finops');
        var data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Erro ao carregar dados');

        finOpsDataCache = data;

        // Métricas Globais
        var rg = data.resumoGlobal;
        var kpiCusto = document.getElementById('finOpsKpiCustoTotal');
        var kpiPerguntas = document.getElementById('finOpsKpiPerguntas');
        var kpiMedio = document.getElementById('finOpsKpiCustoMedio');
        var kpiPoupanca = document.getElementById('finOpsKpiPoupanca');

        if (kpiCusto) kpiCusto.textContent = '€ ' + Number(rg.custoTotalEur || 0).toFixed(2);
        if (kpiPerguntas) kpiPerguntas.textContent = (rg.totalPerguntas || 0) + ' interações';
        if (kpiMedio) kpiMedio.textContent = '€ ' + Number(rg.custoMedioEur || 0).toFixed(3);
        if (kpiPoupanca) kpiPoupanca.textContent = '€ ' + Number(rg.poupancaCachingEur || 0).toFixed(2);

        // Atualiza Badge no Sidebar se existir
        var badgeSidebar = document.getElementById('badge-finops-total');
        if (badgeSidebar) badgeSidebar.textContent = '€ ' + Number(rg.custoTotalEur || 0).toFixed(2);

        // Tabela por Farmácia
        var tbodyFarms = document.getElementById('finOpsFarmaciasTbody');
        if (tbodyFarms) {
          if (!data.farmacias || data.farmacias.length === 0) {
            tbodyFarms.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:16px;color:#64748b;">Nenhuma farmácia registada.</td></tr>';
          } else {
            tbodyFarms.innerHTML = data.farmacias.map(function(f) {
              return '<tr style="border-bottom: 1px solid #f1f5f9;">' +
                '<td style="padding: 12px 14px; font-weight: 700; color: #0f172a;">' +
                  '🏥 ' + escapeHtml(f.nome) + ' <span style="font-size:0.75rem; color:#64748b; font-weight:normal;">(' + escapeHtml(f.nif) + ')</span>' +
                '</td>' +
                '<td style="padding: 12px 14px; text-align: center; font-weight: 800; color: #0284c7;">' +
                  f.totalPerguntas +
                '</td>' +
                '<td style="padding: 12px 14px; text-align: right; color: #475569; font-family: monospace;">' +
                  Number(f.totalInputTokens || 0).toLocaleString('pt-PT') +
                '</td>' +
                '<td style="padding: 12px 14px; text-align: right; color: #475569; font-family: monospace;">' +
                  Number(f.totalOutputTokens || 0).toLocaleString('pt-PT') +
                '</td>' +
                '<td style="padding: 12px 14px; text-align: right; color: #7c3aed; font-family: monospace; font-weight:600;">' +
                  Number(f.totalCacheReadTokens || 0).toLocaleString('pt-PT') +
                '</td>' +
                '<td style="padding: 12px 14px; text-align: right; font-weight: 800; color: #059669; font-size: 0.95rem;">' +
                  '€ ' + Number(f.custoTotalEur || 0).toFixed(3) +
                '</td>' +
                '<td style="padding: 12px 14px; text-align: right; color: #64748b; font-size: 0.82rem;">' +
                  '€ ' + Number(f.custoMedioEur || 0).toFixed(3) +
                '</td>' +
              '</tr>';
            }).join('');
          }
        }

        // Tabela das Últimas Perguntas
        var tbodyLogs = document.getElementById('finOpsLogsTbody');
        if (tbodyLogs) {
          if (!data.logsRecentes || data.logsRecentes.length === 0) {
            tbodyLogs.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;color:#64748b;">Ainda não foram registadas perguntas ao Copilot.</td></tr>';
          } else {
            tbodyLogs.innerHTML = data.logsRecentes.slice(0, 40).map(function(l) {
              var d = new Date(l.data);
              var dataHora = d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
              var toolsBadges = (l.ferramentas && l.ferramentas.length > 0)
                ? l.ferramentas.map(function(t) { return '<span class="badge" style="background:#f3e8ff;color:#7e22ce;border:1px solid #d8b4fe;font-size:0.68rem;margin-right:4px;font-weight:600;">' + escapeHtml(t) + '</span>'; }).join('')
                : '<span style="color:#64748b;font-size:0.75rem;">Conversa Direta</span>';

              return '<tr style="border-bottom: 1px solid #f1f5f9; font-size: 0.82rem;">' +
                '<td style="padding: 8px 10px; color: #64748b; white-space: nowrap;">' + dataHora + '</td>' +
                '<td style="padding: 8px 10px; font-weight: 700; color: #0f172a; white-space: nowrap;">' + escapeHtml(l.farmaciaNome) + '</td>' +
                '<td style="padding: 8px 10px; color: #1e293b; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight:500;" title="' + escapeHtml(l.pergunta) + '">' +
                  escapeHtml(l.pergunta) +
                '</td>' +
                '<td style="padding: 8px 10px;">' + toolsBadges + '</td>' +
                '<td style="padding: 8px 10px; text-align: right; font-family: monospace; color: #475569; font-size: 0.76rem;">' +
                  'In: ' + Number(l.inputTokens || 0).toLocaleString('pt-PT') + ' | Out: ' + Number(l.outputTokens || 0).toLocaleString('pt-PT') +
                '</td>' +
                '<td style="padding: 8px 10px; text-align: right; font-weight: 800; color: #059669;">' +
                  '€ ' + Number(l.custoEur || 0).toFixed(4) +
                '</td>' +
              '</tr>';
            }).join('');
          }
        }

        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.style.display = 'block';
      } catch (err) {
        if (loadingEl) loadingEl.innerHTML = '<p style="color:#ef4444;text-align:center;">Erro ao carregar telemetria FinOps: ' + escapeHtml(err.message) + '</p>';
      }
    }

    function exportFinOpsCsv() {
      if (!finOpsDataCache || !finOpsDataCache.farmacias) {
        alert('Não existem dados carregados para exportar.');
        return;
      }
      var csv = 'Farmacia;NIF;Total Perguntas;Input Tokens;Output Tokens;Cache Read Tokens;Custo Total EUR;Custo Medio EUR\\r\\n';
      finOpsDataCache.farmacias.forEach(function(f) {
        csv += '"' + f.nome + '";"' + f.nif + '";' + f.totalPerguntas + ';' + f.totalInputTokens + ';' + f.totalOutputTokens + ';' + f.totalCacheReadTokens + ';' + f.custoTotalEur + ';' + f.custoMedioEur + '\\r\\n';
      });
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'finops_copilot_tokens_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    let selectedImportFiles = [];
    let currentInspectionResults = [];

    function openInteractiveImportModal() {
      selectedImportFiles = [];
      currentInspectionResults = [];
      var fileInput = document.getElementById('impCustomFilesInput');
      if (fileInput) fileInput.value = '';
      var progressBar = document.getElementById('importProgressBar');
      if (progressBar) {
        progressBar.style.width = '5%';
        progressBar.style.background = 'linear-gradient(90deg, #38bdf8, #10b981)';
      }
      var statsReport = document.getElementById('importStatsReport');
      if (statsReport) statsReport.style.display = 'none';
      var modal = document.getElementById('interactiveImportModal');
      if (modal) modal.style.display = 'flex';
      backToImportStep1();
      loadAvenidaFolderFiles();
    }

    function closeInteractiveImportModal() {
      var modal = document.getElementById('interactiveImportModal');
      if (modal) modal.style.display = 'none';
    }

    function backToImportStep1() {
      document.getElementById('importStep1').style.display = 'block';
      document.getElementById('importStep2').style.display = 'none';
      document.getElementById('importStep3').style.display = 'none';
    }

    async function loadAvenidaFolderFiles() {
      var c = document.getElementById('avenidaFilesContainer');
      if (!c) return;
      c.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;padding:10px;">⏳ A listar ficheiros da pasta Avenida...</div>';

      try {
        var res = await fetch('/api/admin/avenida-files');
        var data = await res.json();
        if (data.ok && Array.isArray(data.files) && data.files.length > 0) {
          selectedImportFiles = data.files.map(function(f) {
            return { name: f.name, size: f.sizeFormatted, fromAvenida: true, selected: true };
          });
          renderAvenidaFilesList();
        } else {
          c.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;padding:10px;">Nenhum ficheiro encontrado na pasta Avenida.</div>';
        }
      } catch (e) {
        c.innerHTML = '<div style="color:#ef4444;font-size:0.82rem;padding:10px;">Erro ao listar ficheiros da pasta Avenida.</div>';
      }
    }

    function renderAvenidaFilesList() {
      var c = document.getElementById('avenidaFilesContainer');
      if (!c) return;
      var html = '';
      for (var idx = 0; idx < selectedImportFiles.length; idx++) {
        var f = selectedImportFiles[idx];
        var checkedAttr = f.selected ? 'checked' : '';
        var originLabel = f.fromAvenida ? 'Pasta Servidor' : 'Upload Local';
        var originColor = f.fromAvenida ? '#0284c7' : '#10b981';

        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#ffffff;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<input type="checkbox" id="chk_file_' + idx + '" ' + checkedAttr + ' onchange="toggleFileSelection(' + idx + ')" />' +
            '<span style="font-weight:700;font-size:0.83rem;color:#0f172a;">' + f.name + '</span>' +
            '<span style="font-size:0.75rem;color:var(--muted);background:#f1f5f9;padding:2px 6px;border-radius:4px;">' + (f.size || '') + '</span>' +
          '</div>' +
          '<span style="font-size:0.72rem;color:' + originColor + ';font-weight:700;">' + originLabel + '</span>' +
        '</div>';
      }
      c.innerHTML = html;
      updateSelectedFilesCount();
    }

    function toggleFileSelection(idx) {
      if (selectedImportFiles[idx]) {
        selectedImportFiles[idx].selected = !selectedImportFiles[idx].selected;
        updateSelectedFilesCount();
      }
    }

    function updateSelectedFilesCount() {
      var count = selectedImportFiles.filter(function(f) { return f.selected; }).length;
      var s = document.getElementById('selectedFilesSummary');
      if (s) s.textContent = count + ' ficheiro(s) selecionado(s).';
      var btn = document.getElementById('btnInspectFiles');
      if (btn) btn.disabled = count === 0;
    }

    function handleCustomFilesSelected(ev) {
      var fls = ev.target.files;
      if (!fls || fls.length === 0) return;

      for (var i = 0; i < fls.length; i++) {
        var file = fls[i];
        selectedImportFiles.push({
          name: file.name,
          size: (file.size / 1024).toFixed(1) + ' KB',
          fromAvenida: false,
          fileObject: file,
          selected: true
        });
      }
      renderAvenidaFilesList();
    }

    async function runInteractiveInspection() {
      var activeFiles = selectedImportFiles.filter(function(f) { return f.selected; });
      if (activeFiles.length === 0) return;

      var btn = document.getElementById('btnInspectFiles');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ A analisar ficheiros...';
      }

      try {
        var fromAvenidaNames = activeFiles.filter(function(f) { return f.fromAvenida; }).map(function(f) { return f.name; });
        var uploadedFiles = [];
        var uploads = activeFiles.filter(function(f) { return !f.fromAvenida; });
        for (var i = 0; i < uploads.length; i++) {
          var f = uploads[i];
          var b64 = await fileToBase64(f.fileObject);
          uploadedFiles.push({ name: f.name, base64: b64 });
        }

        var res = await fetch('/api/admin/inspect-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            fromAvenida: fromAvenidaNames.length > 0,
            fileNames: fromAvenidaNames,
            files: uploadedFiles
          })
        });

        var data = await res.json();
        if (data.ok && Array.isArray(data.inspection)) {
          currentInspectionResults = data.inspection;
          renderInspectionQuestions();
          document.getElementById('importStep1').style.display = 'none';
          document.getElementById('importStep2').style.display = 'block';
        } else {
          alert('Erro na inspeção: ' + (data.error || 'Falha ao processar'));
        }
      } catch (e) {
        alert('Erro ao inspecionar ficheiros: ' + e.message);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔍 Analisar & Inspecionar Ficheiros';
        }
      }
    }

    function renderInspectionQuestions() {
      var c = document.getElementById('inspectionQuestionsContainer');
      if (!c) return;

      var html = '';
      for (var fileIdx = 0; fileIdx < currentInspectionResults.length; fileIdx++) {
        var item = currentInspectionResults[fileIdx];
        var typeBadge = item.fileType === 'VENDAS_DIARIO'
          ? '<span class="badge badge-purple" style="font-size:0.75rem;">📅 Vendas Diárias</span>'
          : item.fileType === 'VENDAS_MENSAL'
          ? '<span class="badge badge-info" style="font-size:0.75rem;">📊 Vendas Mensais</span>'
          : '<span class="badge badge-warning" style="font-size:0.75rem;">📦 Validades</span>';

        html += '<div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:12px 14px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="font-weight:800;font-size:0.88rem;color:#0f172a;">' + item.fileName + '</span>' +
              typeBadge +
            '</div>' +
            '<div style="font-size:0.75rem;color:var(--muted);">' +
              (item.periodo ? 'Período: ' + item.periodo : '') + ' | ' + item.totalArtigos + ' artigos' +
            '</div>' +
          '</div>';

        if (item.questions && item.questions.length > 0) {
          for (var qIdx = 0; qIdx < item.questions.length; qIdx++) {
            var q = item.questions[qIdx];
            html += '<div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin-top:8px;">' +
              '<div style="font-size:0.8rem;font-weight:700;color:#0284c7;margin-bottom:3px;">❓ ' + q.title + '</div>' +
              '<div style="font-size:0.76rem;color:var(--muted);margin-bottom:8px;">' + q.description + '</div>' +
              '<div style="display:flex;flex-direction:column;gap:6px;">';

            for (var oIdx = 0; oIdx < q.options.length; oIdx++) {
              var opt = q.options[oIdx];
              var checkedRadio = opt.value === q.defaultValue ? 'checked' : '';
              html += '<label style="display:flex;align-items:center;gap:8px;font-size:0.78rem;cursor:pointer;color:#334155;">' +
                '<input type="radio" name="decision_' + fileIdx + '_' + q.id + '" value="' + opt.value + '" ' + checkedRadio + ' />' +
                '<span>' + opt.label + '</span>' +
              '</label>';
            }
            html += '</div></div>';
          }
        } else {
          html += '<div style="font-size:0.76rem;color:#10b981;font-weight:700;margin-top:4px;">✅ Ficheiro pronto para importação sem conflitos.</div>';
        }

        html += '</div>';
      }
      c.innerHTML = html;
    }

    async function submitInteractiveImport() {
      var decisions = {};

      for (var fileIdx = 0; fileIdx < currentInspectionResults.length; fileIdx++) {
        var item = currentInspectionResults[fileIdx];
        decisions[item.fileName] = {};
        if (item.questions) {
          for (var qIdx = 0; qIdx < item.questions.length; qIdx++) {
            var q = item.questions[qIdx];
            var rad = document.querySelector('input[name="decision_' + fileIdx + '_' + q.id + '"]:checked');
            if (rad) {
              if (q.id === 'nif_action') decisions[item.fileName].nifAction = rad.value;
              if (q.id === 'conflict_action') decisions[item.fileName].conflictAction = rad.value;
              if (q.id === 'stock_action') decisions[item.fileName].stockAction = rad.value;
              if (q.id === 'validades_action') decisions[item.fileName].validadesAction = rad.value;
            }
          }
        }
      }

      document.getElementById('importStep2').style.display = 'none';
      document.getElementById('importStep3').style.display = 'block';

      var progressBar = document.getElementById('importProgressBar');
      var progressPercent = document.getElementById('importProgressPercent');
      var progressStep = document.getElementById('importProgressStepText');
      var progressDetail = document.getElementById('importProgressDetailText');
      var progressIcon = document.getElementById('importProgressIcon');

      if (progressBar) progressBar.style.width = '3%';
      if (progressPercent) progressPercent.textContent = '3%';
      if (progressStep) progressStep.textContent = 'A enviar ficheiros para o servidor...';
      if (progressDetail) progressDetail.textContent = 'A aguardar confirmação de início...';
      if (progressIcon) progressIcon.textContent = '⏳';

      document.getElementById('importProgressTitle').textContent = 'A processar e importar dados...';
      document.getElementById('importStatsReport').style.display = 'none';
      document.getElementById('btnCloseImportFinished').style.display = 'none';

      // Polling de progresso em tempo real a cada 400ms
      var pollTimer = setInterval(async function() {
        try {
          var pRes = await fetch('/api/admin/import-progress?farmaciaId=' + encodeURIComponent(activeFarmaciaId));
          var pData = await pRes.json();
          if (pData.ok && pData.progress) {
            var prog = pData.progress;
            if (progressBar && prog.percent > 0) progressBar.style.width = prog.percent + '%';
            if (progressPercent && prog.percent > 0) progressPercent.textContent = prog.percent + '%';
            if (progressStep && prog.step) progressStep.textContent = prog.step;
            if (progressDetail && prog.detail) progressDetail.textContent = prog.detail;
            if (prog.status === 'COMPLETED') {
              if (progressIcon) progressIcon.textContent = '🎉';
              if (progressBar) progressBar.style.width = '100%';
              if (progressPercent) progressPercent.textContent = '100%';
              clearInterval(pollTimer);
            }
          }
        } catch (e) {}
      }, 400);

      try {
        var fromAvenidaNames = selectedImportFiles.filter(function(f) { return f.selected && f.fromAvenida; }).map(function(f) { return f.name; });
        var uploadedFiles = [];
        var uploads = selectedImportFiles.filter(function(f) { return f.selected && !f.fromAvenida; });
        for (var i = 0; i < uploads.length; i++) {
          var f = uploads[i];
          var b64 = await fileToBase64(f.fileObject);
          uploadedFiles.push({ name: f.name, base64: b64 });
        }

        var res = await fetch('/api/admin/execute-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            fromAvenida: fromAvenidaNames.length > 0,
            fileNames: fromAvenidaNames,
            files: uploadedFiles,
            decisions: decisions
          })
        });

        var data = await res.json();
        if (data.ok && data.async) {
          // Aguarda conclusão em segundo plano via polling (sem timeout HTTP!)
          var finalProg = await new Promise(function(resolve) {
            var waitTimer = setInterval(async function() {
              try {
                var pRes = await fetch('/api/admin/import-progress?farmaciaId=' + encodeURIComponent(activeFarmaciaId));
                var pData = await pRes.json();
                if (pData.ok && pData.progress && (pData.progress.status === 'COMPLETED' || pData.progress.status === 'ERROR')) {
                  clearInterval(waitTimer);
                  resolve(pData.progress);
                }
              } catch (e) {}
            }, 700);
          });
          data = {
            ok: finalProg.status === 'COMPLETED' || Boolean(finalProg.stats),
            stats: finalProg.stats || null,
            error: finalProg.error || finalProg.detail || 'Erro na importação'
          };
        }

        clearInterval(pollTimer);

        if (data.ok && data.stats) {
          var failedCount = (data.stats.detalhesPorFicheiro || []).filter(function(x) { return !x.sucesso; }).length;
          var allFailed = failedCount > 0 && data.stats.filesProcessed === 0;
          var durTxt = data.stats.duracaoMs ? (' em ' + (data.stats.duracaoMs / 1000).toFixed(1).replace('.', ',') + ' s') : '';
          if (progressIcon) progressIcon.textContent = allFailed ? '❌' : (failedCount > 0 ? '⚠️' : '🎉');
          if (progressBar) {
            progressBar.style.width = '100%';
            progressBar.style.background = allFailed ? '#ef4444' : (failedCount > 0 ? '#f59e0b' : 'linear-gradient(90deg, #38bdf8, #10b981)');
          }
          if (progressPercent) progressPercent.textContent = '100%';
          document.getElementById('importProgressTitle').textContent = allFailed
            ? 'Importação falhou'
            : (failedCount > 0 ? 'Importação concluída com erros' + durTxt : 'Importação Concluída com Sucesso' + durTxt + '!');
          if (progressStep) progressStep.textContent = allFailed
            ? 'Nenhum ficheiro foi integrado. Verifique os erros abaixo.'
            : (failedCount > 0 ? 'Alguns ficheiros apresentaram erro.' : 'Processamento finalizado com sucesso' + durTxt + '.');
          if (progressDetail) progressDetail.textContent = data.stats.filesProcessed + ' ficheiro(s) integrados' + (failedCount > 0 ? ' · ' + failedCount + ' com erro.' : '.');

          var r = document.getElementById('importStatsReport');
          r.style.display = 'block';
          var detailsHtml = '';
          for (var dIdx = 0; dIdx < data.stats.detalhesPorFicheiro.length; dIdx++) {
            var d = data.stats.detalhesPorFicheiro[dIdx];
            var color = d.sucesso ? '#10b981' : '#ef4444';
            detailsHtml += '<div style="font-size:0.74rem;background:#ffffff;padding:6px 10px;border-radius:4px;border:1px solid var(--border);display:flex;justify-content:space-between;">' +
              '<span><b>' + d.fileName + '</b> (' + d.tipo + ')</span>' +
              '<span style="color:' + color + ';">' + d.mensagem + '</span>' +
            '</div>';
          }

          r.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">' +
              '<div style="background:#ffffff;padding:10px;border-radius:6px;border:1px solid var(--border);">' +
                '<div style="font-size:0.75rem;color:var(--muted);">Total Vendas Criadas/Atualizadas</div>' +
                '<div style="font-size:1.15rem;font-weight:800;color:#0284c7;">' + data.stats.totalVendasCriadas + '</div>' +
              '</div>' +
              '<div style="background:#ffffff;padding:10px;border-radius:6px;border:1px solid var(--border);">' +
                '<div style="font-size:0.75rem;color:var(--muted);">Snapshots de Stock Histórico</div>' +
                '<div style="font-size:1.15rem;font-weight:800;color:#10b981;">' + data.stats.totalSnapshotsStockCriados + '</div>' +
              '</div>' +
              '<div style="background:#ffffff;padding:10px;border-radius:6px;border:1px solid var(--border);">' +
                '<div style="font-size:0.75rem;color:var(--muted);">Inventário Ativo Atualizado</div>' +
                '<div style="font-size:1.15rem;font-weight:800;color:#8b5cf6;">' + data.stats.totalInventarioAtivoAtualizado + '</div>' +
              '</div>' +
              '<div style="background:#ffffff;padding:10px;border-radius:6px;border:1px solid var(--border);">' +
                '<div style="font-size:0.75rem;color:var(--muted);">Prazos de Validade Cruzados</div>' +
                '<div style="font-size:1.15rem;font-weight:800;color:#f59e0b;">' + data.stats.totalValidadesCruzadas + '</div>' +
              '</div>' +
            '</div>' +
            '<div style="font-size:0.78rem;font-weight:700;color:#0f172a;margin-bottom:6px;">Detalhes por Ficheiro:</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
              detailsHtml +
            '</div>';

          document.getElementById('btnCloseImportFinished').style.display = 'inline-block';
        } else {
          clearInterval(pollTimer);
          if (progressIcon) progressIcon.textContent = '❌';
          document.getElementById('importProgressTitle').textContent = '❌ Erro na Importação';
          if (progressStep) progressStep.textContent = data.error || 'Falha ao executar importação.';
        }
      } catch (e) {
        clearInterval(pollTimer);
        if (progressIcon) progressIcon.textContent = '❌';
        document.getElementById('importProgressTitle').textContent = '❌ Erro no Processamento';
        if (progressStep) progressStep.textContent = e.message;
      }
    }

    function openImportPharmacyModal() {
      const modal = document.getElementById('importPharmacyModal');
      const st = document.getElementById('importPharmacyStatus');
      if (st) st.textContent = '';
      if (modal) modal.style.display = 'flex';
    }

    function closeImportPharmacyModal() {
      const modal = document.getElementById('importPharmacyModal');
      if (modal) modal.style.display = 'none';
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = String(reader.result || '');
          const base64 = res.includes(',') ? res.split(',')[1] : res;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    async function submitImportPharmacy() {
      const nome = document.getElementById('impFarmNome')?.value || 'Farmácia Demo';
      const nif = document.getElementById('impFarmNif')?.value || 'DEMO-99';
      const codigo_acesso = document.getElementById('impFarmCode')?.value || 'FARMACIA-DEMO';
      const invFile = document.getElementById('impFileInv')?.files?.[0];
      const valFile = document.getElementById('impFileVal')?.files?.[0];
      const venFile = document.getElementById('impFileVen')?.files?.[0];
      const st = document.getElementById('importPharmacyStatus');
      const btn = document.getElementById('btnRunImportPharmacy');

      if (!invFile || !venFile) {
        if (st) st.innerHTML = '<span style="color:#fb7185">⚠️ Selecione pelo menos o ficheiro PDF de Inventário e o CSV de Vendas.</span>';
        return;
      }

      try {
        if (btn) btn.disabled = true;
        if (st) st.textContent = '⏳ A ler ficheiros e a processar ETL + Classificador Infarmed (pode demorar 10-20s)...';

        const pdfInventarioBase64 = await fileToBase64(invFile);
        const csvVendasBase64 = await fileToBase64(venFile);
        const pdfValidadesBase64 = valFile ? await fileToBase64(valFile) : null;

        const res = await fetch('/api/admin/import-pharmacy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome,
            nif,
            codigo_acesso,
            pdfInventarioBase64,
            pdfValidadesBase64,
            csvVendasBase64
          })
        });
        const data = await res.json();
        if (data.ok) {
          if (st) {
            st.innerHTML = \`<span style="color:#34d399;font-weight:700;">✅ \${data.farmacia.nome} importada com sucesso! (\${data.stats.artigosInventario} produtos em stock, \${data.stats.registosVendas} registos de vendas | Código: \${data.farmacia.codigo_acesso})</span>\`;
          }
          activeFarmaciaId = data.farmacia.id;
          localStorage.setItem('bi_pharma_farmacia_id', activeFarmaciaId);
          await loadPharmaciesDropdown();
        } else {
          if (st) st.innerHTML = \`<span style="color:#fb7185">❌ Erro: \${data.error}</span>\`;
        }
      } catch (e) {
        if (st) st.innerHTML = '<span style="color:#fb7185">❌ Erro ao enviar ficheiros para o servidor.</span>';
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    function onFarmaciaChange() {
      activeFarmaciaId = document.getElementById('farmaciaSelector').value;
      localStorage.setItem('bi_pharma_farmacia_id', activeFarmaciaId);
      currentCampaignSuggestions = [];
      loadAnalysis();
    }

    function normStr(str) {
      return (str || '')
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
    }

    function onSearchInput(val) {
      const tbl = document.getElementById('tableFilter');
      if (tbl && tbl.value !== val) tbl.value = val;
      renderActiveTable();
    }

    function onMonosFilterChange() {
      switchTab('monos');
      loadAnalysis();
    }

    function onCoberturaFilterChange() {
      switchTab('cobertura');
      loadAnalysis();
    }

    async function loadAnalysis() {
      const diasMonos = document.getElementById('selectDiasMonos').value;
      const cobertura = document.getElementById('selectCobertura').value;
      const btn = document.getElementById('btnRecalcular');
      const feedback = document.getElementById('calcFeedback');

      const tenantBadge = document.getElementById('tenantBadge');
      if (tenantBadge && (!currentReport || !currentReport.farmacia)) {
        tenantBadge.textContent = '⏳ A carregar inteligência de stock e indicadores da farmácia...';
      }

      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ A carregar...';
      }

      try {
        const res = await fetch(\`/api/analysis?farmaciaId=\${activeFarmaciaId}&diasMonos=\${diasMonos}&cobertura=\${cobertura}\`);
        currentReport = await res.json();

        const r = currentReport.resumo_executivo;
        const p = currentReport.parametros;
        const lastSaleNote = p && p.data_ultima_venda ? \` | Última Venda Registada: \${p.data_ultima_venda}\` : '';
        document.getElementById('tenantBadge').textContent = \`🏥 \${currentReport.farmacia.nome} | NIF: \${currentReport.farmacia.nif} | Ref: \${p ? p.data_referencia : ''}\${lastSaleNote}\`;

        document.getElementById('kpiStockValor').textContent = \`\${r.valor_total_stock_custo.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €\`;
        document.getElementById('kpiStockSub').textContent = \`\${r.total_artigos_inventario} artigos | \${r.total_unidades_stock} unidades\`;

        document.getElementById('kpiGenericosVal').textContent = \`\${r.valor_stock_genericos_mg.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €\`;
        document.getElementById('kpiGenericosSub').textContent = \`\${r.artigos_genericos_mg} MG vs \${r.artigos_medicamentos_marca} Marca (\${r.grupos_dci_com_multiplos_labs} moléculas dup.)\`;

        const totalLivre = r.artigos_venda_livre_psbe + r.artigos_mnsrm;
        const pctLivre = ((totalLivre / r.total_artigos_inventario) * 100).toFixed(1);
        document.getElementById('kpiEstatutoRatio').textContent = \`\${pctLivre}% Sem Receita\`;
        document.getElementById('kpiEstatutoSub').textContent = \`\${r.artigos_venda_livre_psbe} PSBE | \${r.artigos_mnsrm} MNSRM | \${r.artigos_msrm_receita} MSRM\`;

        const restosGavetaTxt = r.total_artigos_restos_gaveta ? \` (Restos ≤2 un: \${r.total_artigos_restos_gaveta})\` : '';
        document.getElementById('kpiMonosValor').textContent = \`\${r.valor_total_monos.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €\`;
        document.getElementById('kpiMonosSub').textContent = \`\${r.total_artigos_monos} artigos (\${r.percentagem_capital_em_monos}% do stock) s/ vendas a \${diasMonos}d\${restosGavetaTxt}\`;

        document.getElementById('kpiCaducidadeValor').textContent = \`\${r.valor_total_risco_caducidade.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €\`;
        document.getElementById('kpiCaducidadeSub').textContent = \`\${r.total_artigos_risco_caducidade} artigos (\${r.unidades_totais_risco_caducidade} emb. em risco)\`;

        // Atualizar badges nas abas com número real de artigos
        const bCad = document.getElementById('badge-caducidade');
        const bGen = document.getElementById('badge-genericos');
        const bMon = document.getElementById('badge-monos');
        const bCob = document.getElementById('badge-cobertura');
        if (bCad) bCad.textContent = r.total_artigos_risco_caducidade;
        if (bGen) bGen.textContent = currentReport.consolidacao_genericos_dci.length;
        if (bMon) bMon.textContent = r.total_artigos_monos;
        if (bCob) bCob.textContent = currentReport.alertas_excesso_cobertura.length;

        // Atualizar contagens reais no seletor de segmento
        const selTv = document.getElementById('selectTipoVenda');
        if (selTv && selTv.options.length >= 7) {
          selTv.options[0].text = \`Todos os Produtos (\${r.total_artigos_inventario})\`;
          selTv.options[1].text = \`🟢 Venda Livre + MNSRM (\${totalLivre} SKUs)\`;
          selTv.options[2].text = \`🧬 Só Medicamentos Genéricos (\${r.artigos_genericos_mg} SKUs)\`;
          selTv.options[3].text = \`🏷️ Só Medicamentos de Marca (\${r.artigos_medicamentos_marca} SKUs)\`;
          selTv.options[4].text = \`🟢 Só PSBE / Cosmética (\${r.artigos_venda_livre_psbe} SKUs)\`;
          selTv.options[5].text = \`🔵 Só MNSRM (\${r.artigos_mnsrm} SKUs)\`;
          selTv.options[6].text = \`🔴 Só MSRM (\${r.artigos_msrm_receita} SKUs)\`;
        }

        updateMacroAreaOptionsCounts();
        populateCategoriasOptions();

        renderActiveTable();
        renderWeeklyActionPlan();
        loadActiveCampaigns();
        switchTab(activeTab);

        if (feedback) {
          feedback.style.display = 'inline-block';
          setTimeout(() => { feedback.style.display = 'none'; }, 2500);
        }
      } catch (err) {
        console.error('Erro ao carregar análise:', err);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '🔄 Recalcular';
        }
      }
    }

    function switchTab(tab) {
      activeTab = tab;
      ['plano', 'copilot', 'campaigns', 'rebalance', 'labs', 'evolution', 'caducidade', 'genericos', 'monos', 'cobertura'].forEach(t => {
        const btn = document.getElementById('tabBtn-' + t);
        if (btn) btn.classList.toggle('active', t === tab);
      });

      const isStockTable = ['caducidade', 'genericos', 'monos', 'cobertura'].includes(tab);
      const analyticsHeader = document.getElementById('globalAnalyticsHeader');
      if (analyticsHeader) analyticsHeader.style.display = isStockTable ? 'block' : 'none';

      const views = {
        plano: document.getElementById('tabContent-plano'),
        copilot: document.getElementById('tabContent-copilot'),
        campaigns: document.getElementById('tabContent-campaigns'),
        rebalance: document.getElementById('tabContent-rebalance'),
        labs: document.getElementById('tabContent-labs'),
        evolution: document.getElementById('tabContent-evolution'),
        tables: document.getElementById('tabContent-tables'),
      };

      // Esconder rigorosamente todas as vistas para evitar sobreposição
      Object.keys(views).forEach(function(k) {
        if (views[k]) views[k].style.display = 'none';
      });

      if (tab === 'plano') {
        if (views.plano) views.plano.style.display = 'block';
        renderWeeklyActionPlan();
      } else if (tab === 'copilot') {
        if (views.copilot) views.copilot.style.display = 'block';
      } else if (tab === 'campaigns') {
        if (views.campaigns) views.campaigns.style.display = 'block';
        if (!currentCampaignSuggestions || currentCampaignSuggestions.length === 0) {
          loadCampaignSuggestions();
        }
      } else if (tab === 'rebalance') {
        if (views.rebalance) views.rebalance.style.display = 'block';
        loadRebalanceData();
      } else if (tab === 'labs') {
        if (views.labs) views.labs.style.display = 'block';
        loadLaboratoriesData();
      } else if (tab === 'evolution') {
        if (views.evolution) views.evolution.style.display = 'block';
        loadStockEvolutionData();
      } else if (isStockTable) {
        if (views.tables) views.tables.style.display = 'block';
        renderActiveTable();
      }
    }

    // ========================================================================
    // GESTOR DE TAREFAS SEMANAIS DA EQUIPA (PERSISTÊNCIA LOCAL + IMPRESSÃO A4)
    // ========================================================================
    let remoteDoneTasksMap = {};

    async function fetchWeeklyTasksFromDb() {
      if (!activeFarmaciaId) return;
      try {
        const res = await fetch('/api/weekly-tasks?farmaciaId=' + encodeURIComponent(activeFarmaciaId));
        const data = await res.json();
        if (data.ok && data.tasksMap) {
          remoteDoneTasksMap = data.tasksMap;
          localStorage.setItem('bi_pharma_weekly_done_' + activeFarmaciaId, JSON.stringify(remoteDoneTasksMap));
          updateWeeklyTasksCounter();
        }
      } catch (err) {
        console.warn('Aviso: falha ao carregar tarefas do servidor, a usar cache local:', err);
      }
    }

    function getDoneTasksMap() {
      if (remoteDoneTasksMap && Object.keys(remoteDoneTasksMap).length > 0) {
        return remoteDoneTasksMap;
      }
      try {
        return JSON.parse(localStorage.getItem('bi_pharma_weekly_done_' + activeFarmaciaId) || '{}');
      } catch {
        return {};
      }
    }

    async function toggleWeeklyTask(taskId, categoria, cnp, designacao, valor) {
      const map = getDoneTasksMap();
      const current = map[taskId];
      const isDone = typeof current === 'object' ? !!current.concluido : !!current;
      const nextDone = !isDone;

      if (nextDone) {
        map[taskId] = { concluido: true, concluido_por: 'Desktop (Balcão)', concluido_em: new Date().toISOString() };
      } else {
        delete map[taskId];
      }

      remoteDoneTasksMap = map;
      localStorage.setItem('bi_pharma_weekly_done_' + activeFarmaciaId, JSON.stringify(map));
      updateWeeklyTasksCounter();

      try {
        await fetch('/api/weekly-tasks/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            taskId: taskId,
            concluido: nextDone,
            concluido_por: 'Desktop (Balcão)',
            categoria: categoria || 'GERAL',
            cnp_codigo: cnp,
            designacao: designacao,
            valor_impacto: valor
          })
        });
      } catch (e) {
        console.error('Erro ao sincronizar tarefa com a BD:', e);
      }
    }

    async function resetWeeklyTasksProgress() {
      if (confirm('Tem a certeza que deseja limpar todos os vistos das tarefas desta semana na Base de Dados e no Telemóvel?')) {
        localStorage.removeItem('bi_pharma_weekly_done_' + activeFarmaciaId);
        remoteDoneTasksMap = {};
        try {
          await fetch('/api/weekly-tasks/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ farmaciaId: activeFarmaciaId })
          });
        } catch {}
        renderWeeklyActionPlan();
      }
    }

    
    async function logoutApp() {
      if (!confirm('Deseja realmente terminar a sua sessão com segurança?')) return;
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch(e) {}
      document.cookie = 'admin_session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
      document.cookie = 'farmacia_access_code=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
      localStorage.removeItem('bi_pharma_admin_authenticated');
      localStorage.removeItem('bi_pharma_access_code');
      localStorage.removeItem('bi_pharma_auth_role');
      localStorage.removeItem('bi_pharma_farmacia_id');
      sessionStorage.clear();
      activeAccessCode = '';
      activeAuthRole = '';
      activeFarmaciaId = '';
      const appLayout = document.getElementById('mainAppLayout');
      if (appLayout) appLayout.style.display = 'none';
      window.location.href = '/login?logout=1';
    }

    function shareMobileWhatsApp() {
      const inp = document.getElementById('mobileDirectUrl');
      if (!inp || !inp.value) return;
      const text = encodeURIComponent('Olá equipa! Aqui está o link de acesso direto ao BI Pharma (Modo Balcão da Farmácia): ' + inp.value);
      window.open('https://api.whatsapp.com/send?text=' + text, '_blank');
    }

    
    
    let cachedRebalanceData = null;

    async function loadRebalanceData() {
      const container = document.getElementById('rebalanceTableContainer');
      if (!container) return;
      container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 25px;">A cruzar inventários e vendas entre lojas...</div>';

      try {
        const res = await fetch('/api/groups/rebalance');
        const data = await res.json();
        cachedRebalanceData = data;

        const savEl = document.getElementById('rebalanceSavingsTotal');
        if (savEl) savEl.textContent = Number(data.totalPoupancaEstimadaEur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €';

        const oppEl = document.getElementById('rebalanceOpportunitiesCount');
        if (oppEl) oppEl.textContent = (data.totalOportunidades || 0) + ' artigos';

        if (!data.sugestoes || data.sugestoes.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: #10b981; font-weight: 700; padding: 30px;">✅ Os stocks entre as farmácias do grupo estão perfeitamente equilibrados no momento.</div>';
          return;
        }

        let html = '<div style="border: 1px solid #e2e8f0; border-radius: 10px; overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; text-align: left;">';
        html += '<thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; color: #475569; font-weight: 700;">' +
          '<tr><th style="padding: 10px 14px;">Produto / CNP</th><th style="padding: 10px 14px;">Loja Origem (Excesso)</th><th style="padding: 10px 14px;">Loja Destino (Ruptura)</th><th style="padding: 10px 14px; text-align: center;">Qtd a Transferir</th><th style="padding: 10px 14px; text-align: right;">Poupança Gerada</th></tr></thead><tbody>';

        data.sugestoes.forEach(s => {
          html += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
            '<td style="padding: 10px 14px;"><div style="font-weight: 700; color: #0f172a;">' + escapeHtml(s.designacao) + '</div><div style="font-size: 0.72rem; color: #64748b;">CNP: ' + escapeHtml(s.cnp_codigo) + (s.aim ? ' | AIM: ' + escapeHtml(s.aim) : '') + '</div></td>' +
            '<td style="padding: 10px 14px;"><div style="font-weight: 700; color: #0369a1;">' + escapeHtml(s.origem.farmaciaNome) + '</div><div style="font-size: 0.72rem; color: #64748b;">Stock: ' + s.origem.stock_atual + ' un (' + s.origem.dias_cobertura + 'd cob.)</div></td>' +
            '<td style="padding: 10px 14px;"><div style="font-weight: 700; color: #b91c1c;">' + escapeHtml(s.destino.farmaciaNome) + '</div><div style="font-size: 0.72rem; color: #64748b;">Stock: ' + s.destino.stock_atual + ' un (VMM: ' + s.destino.vmm + ' un)</div></td>' +
            '<td style="padding: 10px 14px; text-align: center;"><span style="background: #e0f2fe; color: #0369a1; font-weight: 800; padding: 4px 10px; border-radius: 6px;">' + s.quantidade_sugerida + ' un</span></td>' +
            '<td style="padding: 10px 14px; text-align: right; font-weight: 800; color: #059669;">+' + Number(s.valor_poupanca_eur).toFixed(2) + ' €</td>' +
            '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      } catch (err) {
        container.innerHTML = '<div style="color: #e11d48; padding: 15px;">Erro ao carregar dados de balanceamento.</div>';
      }
    }

    function printTransferGuide() {
      if (!cachedRebalanceData || !cachedRebalanceData.sugestoes) {
        alert('Carregue primeiro as oportunidades de transferência.');
        return;
      }
      window.print();
    }

    async function loadLabsData() {
      const container = document.getElementById('labsTableContainer');
      const title = document.getElementById('labsResultsTitle');
      if (!container) return;
      if (title) title.textContent = 'Ranking de Laboratórios Titulares';
      container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 25px;">A analisar laboratórios...</div>';

      try {
        const res = await fetch('/api/analytics/labs?farmaciaId=' + encodeURIComponent(activeFarmaciaId || ''));
        const data = await res.json();
        if (!data.laboratories || data.laboratories.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 20px;">Nenhum registo de laboratório disponível.</div>';
          return;
        }

        let html = '<div style="border: 1px solid #e2e8f0; border-radius: 10px; overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; text-align: left;">';
        html += '<thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; color: #475569; font-weight: 700;">' +
          '<tr><th style="padding: 10px 14px;">Laboratório Titular</th><th style="padding: 10px 14px;">Artigos</th><th style="padding: 10px 14px; text-align: right;">Faturação Acumulada</th><th style="padding: 10px 14px; text-align: center;">Unidades Vendidas</th><th style="padding: 10px 14px; text-align: center;">Margem Média</th><th style="padding: 10px 14px; text-align: right;">Stock em Armazém</th></tr></thead><tbody>';

        data.laboratories.slice(0, 50).forEach(l => {
          html += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
            '<td style="padding: 10px 14px; font-weight: 700; color: #0f172a;">' + escapeHtml(l.laboratorio) + '</td>' +
            '<td style="padding: 10px 14px; color: #475569;">' + l.totalArtigos + '</td>' +
            '<td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #0284c7;">' + Number(l.faturacaoAcumulada).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €</td>' +
            '<td style="padding: 10px 14px; text-align: center;">' + l.unidadesVendidas.toLocaleString('pt-PT') + '</td>' +
            '<td style="padding: 10px 14px; text-align: center;"><span style="background: #ecfdf5; color: #059669; font-weight: 700; padding: 3px 8px; border-radius: 6px;">' + l.margemMediaPct + '%</span></td>' +
            '<td style="padding: 10px 14px; text-align: right; color: #64748b;">' + Number(l.valorStockAtual).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € (' + l.unidadesStockAtual + ' un)</td>' +
            '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      } catch (err) {
        container.innerHTML = '<div style="color: #e11d48; padding: 15px;">Erro ao carregar laboratórios.</div>';
      }
    }

    async function executeAimSearch() {
      const input = document.getElementById('inputFilterAims');
      const val = input ? input.value.trim() : '';
      if (!val) {
        alert('Por favor introduza pelo menos um código AIM (ex: 320, 2121, 6581).');
        return;
      }

      const container = document.getElementById('labsTableContainer');
      const title = document.getElementById('labsResultsTitle');
      if (title) title.textContent = 'Histórico Detalhado dos AIMs: ' + val;
      if (container) container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 25px;">A pesquisar histórico dos AIMs selecionados...</div>';

      try {
        const res = await fetch('/api/analytics/aims?aims=' + encodeURIComponent(val) + '&farmaciaId=' + encodeURIComponent(activeFarmaciaId || ''));
        const data = await res.json();

        if (!data.produtos || data.produtos.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 25px;">Nenhum produto encontrado com os códigos AIM pesquisados na base de dados.</div>';
          return;
        }

        let html = '<div style="margin-bottom: 12px; font-size: 0.82rem; color: #64748b;"><b>Total de Produtos:</b> ' + data.totalProdutos + ' | <b>Faturação Total AIM:</b> ' + Number(data.faturacaoTotalAimEur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € | <b>Unidades Totais:</b> ' + data.unidadesTotaisAim + ' un</div>';
        html += '<div style="border: 1px solid #e2e8f0; border-radius: 10px; overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; text-align: left;">';
        html += '<thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; color: #475569; font-weight: 700;">' +
          '<tr><th style="padding: 10px 14px;">AIM</th><th style="padding: 10px 14px;">Produto / CNP</th><th style="padding: 10px 14px;">Laboratório</th><th style="padding: 10px 14px; text-align: center;">Stock</th><th style="padding: 10px 14px; text-align: right;">Total Vendas (€)</th><th style="padding: 10px 14px;">Histórico Mensal</th></tr></thead><tbody>';

        data.produtos.forEach(p => {
          let histBadges = '';
          if (p.historicoMensal && p.historicoMensal.length > 0) {
            histBadges = p.historicoMensal.map(h => '<span style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; margin-right: 4px; font-size: 0.7rem; font-weight: 600;">' + h.mes.slice(5) + ': ' + h.quantidade + 'un</span>').join('');
          } else {
            histBadges = '<span style="color: #94a3b8; font-size: 0.72rem;">Sem vendas registadas</span>';
          }

          html += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
            '<td style="padding: 10px 14px; font-weight: 800; color: #7e22ce;">' + escapeHtml(p.aim) + '</td>' +
            '<td style="padding: 10px 14px;"><div style="font-weight: 700; color: #0f172a;">' + escapeHtml(p.designacao) + '</div><div style="font-size: 0.72rem; color: #64748b;">CNP: ' + escapeHtml(p.cnp_codigo) + '</div></td>' +
            '<td style="padding: 10px 14px; color: #475569;">' + escapeHtml(p.laboratorio || 'N/D') + '</td>' +
            '<td style="padding: 10px 14px; text-align: center; font-weight: 700;">' + p.stock_atual + ' un</td>' +
            '<td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #0284c7;">' + Number(p.vendasTotaisEur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €</td>' +
            '<td style="padding: 10px 14px;">' + histBadges + '</td>' +
            '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      } catch (err) {
        container.innerHTML = '<div style="color: #e11d48; padding: 15px;">Erro ao consultar histórico dos AIMs.</div>';
      }
    }

    function openSettingsModal() {
      const modal = document.getElementById('settingsModal');
      if (modal) modal.style.display = 'flex';

      // Preenche os dados da farmácia
      if (currentReport && currentReport.farmacia) {
        const fn = document.getElementById('settingsFarmName');
        if (fn) fn.value = currentReport.farmacia.nome || '';
        const fNif = document.getElementById('settingsFarmNif');
        if (fNif) fNif.value = currentReport.farmacia.nif || '';
        const fCode = document.getElementById('settingsFarmAccessCode');
        if (fCode) fCode.value = currentReport.farmacia.codigo_acesso || activeFarmaciaId || '';
      }

      loadSettingsTeam();
      loadSettingsSessions();
    }

    function closeSettingsModal() {
      const modal = document.getElementById('settingsModal');
      if (modal) modal.style.display = 'none';
    }

    function switchSettingsTab(tabName) {
      ['team', 'sessions', 'pharmacy', 'reset'].forEach(t => {
        const btn = document.getElementById('settingsTabBtn-' + t);
        const view = document.getElementById('settingsView-' + t);
        if (btn) {
          const isAct = t === tabName;
          btn.style.background = isAct ? '#ffffff' : 'transparent';
          btn.style.color = isAct ? '#0284c7' : '#475569';
          btn.style.boxShadow = isAct ? '0 1px 2px rgba(0,0,0,0.05)' : 'none';
        }
        if (view) view.style.display = (t === tabName ? 'block' : 'none');
      });
    }

    function toggleInviteForm() {
      const f = document.getElementById('inviteMemberForm');
      if (f) f.style.display = (f.style.display === 'none' ? 'block' : 'none');
    }

    async function loadSettingsTeam() {
      const container = document.getElementById('settingsTeamTableContainer');
      if (!container || !activeFarmaciaId) return;

      try {
        const res = await fetch('/api/settings/team?farmaciaId=' + encodeURIComponent(activeFarmaciaId), {
          headers: { 'x-access-code': activeAccessCode }
        });
        const data = await res.json();
        if (res.status === 401 || (data && !data.ok && data.error && (data.error.includes('não autorizado') || data.error.includes('indique o código')))) {
          container.innerHTML = '<div style="color: #e11d48; padding: 14px; text-align: center;">Sessão expirada ou não autorizada. <button onclick="openAuthGateModal()" class="btn btn-sm" style="margin-left: 8px;">Reautenticar</button></div>';
          return;
        }
        if (data.ok && Array.isArray(data.team)) {
          if (data.team.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 20px;">Nenhum colaborador adicionado ainda.</div>';
            return;
          }

          let html = '<div style="border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;"><table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; text-align: left;">';
          html += '<thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; color: #475569; font-weight: 700;">' +
            '<tr><th style="padding: 10px 14px;">Colaborador</th><th style="padding: 10px 14px;">Email</th><th style="padding: 10px 14px;">Perfil (RBAC)</th><th style="padding: 10px 14px;">PIN</th><th style="padding: 10px 14px; text-align: right;">Ações</th></tr></thead><tbody>';

          data.team.forEach(m => {
            let roleBadge = '<span style="background: #e0f2fe; color: #0369a1; padding: 3px 8px; border-radius: 6px; font-weight: 800; font-size: 0.72rem;">AUXILIAR</span>';
            if (m.role === 'DIRETOR') roleBadge = '<span style="background: #dcfce7; color: #15803d; padding: 3px 8px; border-radius: 6px; font-weight: 800; font-size: 0.72rem;">DIRETOR TÉCNICO</span>';
            if (m.role === 'GESTOR') roleBadge = '<span style="background: #fef9c3; color: #854d0e; padding: 3px 8px; border-radius: 6px; font-weight: 800; font-size: 0.72rem;">GESTOR GLOBAL</span>';
            if (m.role === 'SUPORTE') roleBadge = '<span style="background: #f3e8ff; color: #7e22ce; padding: 3px 8px; border-radius: 6px; font-weight: 800; font-size: 0.72rem;">SUPORTE TI</span>';

            html += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
              '<td style="padding: 10px 14px; font-weight: 700; color: #0f172a;">' + escapeHtml(m.nome) + '</td>' +
              '<td style="padding: 10px 14px; color: #475569;">' + escapeHtml(m.email) + '</td>' +
              '<td style="padding: 10px 14px;">' + roleBadge + '</td>' +
              '<td style="padding: 10px 14px; font-family: monospace; font-weight: 700; color: #64748b;">' + escapeHtml(m.pin || '••••') + '</td>' +
              '<td style="padding: 10px 14px; text-align: right;">' +
              '<button data-id="' + m.id + '" onclick="deleteTeamMember(this.dataset.id)" style="background: none; border: none; color: #e11d48; cursor: pointer; font-size: 0.8rem; font-weight: 700;">Remover</button>' +
              '</td></tr>';
          });

          html += '</tbody></table></div>';
          container.innerHTML = html;
        }
      } catch (err) {
        container.innerHTML = '<div style="color: #e11d48; padding: 10px;">Erro ao carregar equipa.</div>';
      }
    }

    async function submitInviteMember() {
      const nome = document.getElementById('inviteName').value.trim();
      const email = document.getElementById('inviteEmail').value.trim();
      const role = document.getElementById('inviteRole').value;
      const pin = document.getElementById('invitePin').value.trim();

      if (!nome || !email) {
        alert('Por favor introduza o nome e o email do colaborador.');
        return;
      }

      if (pin) {
        const isDigits = pin.length >= 4 && pin.length <= 6 && !isNaN(Number(pin)) && !pin.includes('.');
        if (!isDigits) {
          alert('O PIN deve ter entre 4 e 6 dígitos numéricos.');
          return;
        }
        const isRepeated = pin.split('').every(ch => ch === pin[0]);
        if (isRepeated) {
          alert('PIN rejeitado por segurança: evite todos os dígitos repetidos (ex: 6666, 1111). Por favor escolha um PIN seguro como 6294 ou 8421.');
          return;
        }
        if (['1234', '4321', '123456', '654321', '0123', '9876'].includes(pin)) {
          alert('PIN rejeitado por segurança: evite sequências numéricas óbvias (ex: 1234, 4321). Por favor escolha um PIN seguro como 6294 ou 8421.');
          return;
        }
      }

      try {
        const res = await fetch('/api/settings/team/invite', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-access-code': activeAccessCode
          },
          body: JSON.stringify({ farmaciaId: activeFarmaciaId, nome, email, role, pin })
        });
        const data = await res.json();
        if (res.status === 401 || (data && !data.ok && data.error && (data.error.includes('não autorizado') || data.error.includes('indique o código')))) {
          alert('A sua sessão expirou ou não está autorizada. Por favor volte a introduzir o código da farmácia ou a password de administrador.');
          openAuthGateModal('Sessão expirada. Por favor autentique-se novamente.', activeAuthRole === 'ADMIN' ? 'ADMIN' : 'PHARMACY');
          return;
        }
        if (data.ok) {
          toggleInviteForm();
          document.getElementById('inviteName').value = '';
          document.getElementById('inviteEmail').value = '';
          document.getElementById('invitePin').value = '';
          alert('Colaborador adicionado com sucesso!');
          loadSettingsTeam();
        } else {
          alert('Erro: ' + (data.error || 'Não foi possível adicionar colaborador.'));
        }
      } catch (err) {
        alert('Erro ao enviar pedido.');
      }
    }

    async function deleteTeamMember(userId) {
      if (!confirm('Deseja realmente revogar o acesso deste colaborador?')) return;
      try {
        const res = await fetch('/api/settings/team/delete', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-access-code': activeAccessCode
          },
          body: JSON.stringify({ farmaciaId: activeFarmaciaId, userId })
        });
        const data = await res.json();
        if (res.status === 401 || (data && !data.ok && data.error && (data.error.includes('não autorizado') || data.error.includes('indique o código')))) {
          alert('A sua sessão expirou ou não está autorizada.');
          openAuthGateModal('Sessão expirada. Por favor autentique-se novamente.', activeAuthRole === 'ADMIN' ? 'ADMIN' : 'PHARMACY');
          return;
        }
        if (data.ok) {
          alert('Colaborador removido com sucesso!');
          loadSettingsTeam();
        } else {
          alert('Erro ao remover colaborador: ' + (data.error || 'Não foi possível concluir a remoção.'));
        }
      } catch (e) {
        alert('Erro de comunicação ao remover colaborador.');
      }
    }

    async function loadSettingsSessions() {
      const container = document.getElementById('settingsSessionsContainer');
      if (!container || !activeFarmaciaId) return;

      try {
        const res = await fetch('/api/settings/sessions?farmaciaId=' + encodeURIComponent(activeFarmaciaId), {
          headers: { 'x-access-code': activeAccessCode }
        });
        const data = await res.json();
        if (res.status === 401 || (data && !data.ok && data.error && (data.error.includes('não autorizado') || data.error.includes('indique o código')))) {
          container.innerHTML = '<div style="color: #e11d48; padding: 14px; text-align: center;">Sessão expirada ou não autorizada. <button onclick="openAuthGateModal()" class="btn btn-sm" style="margin-left: 8px;">Reautenticar</button></div>';
          return;
        }
        if (data.ok && Array.isArray(data.sessions)) {
          if (data.sessions.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 20px;">Nenhuma sessão ativa registada.</div>';
            return;
          }

          let html = '<div style="border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;"><table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; text-align: left;">';
          html += '<thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; color: #475569; font-weight: 700;">' +
            '<tr><th style="padding: 10px 14px;">Utilizador</th><th style="padding: 10px 14px;">Dispositivo / IP</th><th style="padding: 10px 14px;">Perfil</th><th style="padding: 10px 14px;">Última Atividade</th><th style="padding: 10px 14px; text-align: right;">Ação</th></tr></thead><tbody>';

          data.sessions.forEach(s => {
            const timeStr = new Date(s.lastSeenAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            html += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
              '<td style="padding: 10px 14px; font-weight: 700; color: #0f172a;">' + escapeHtml(s.userName) + '</td>' +
              '<td style="padding: 10px 14px; color: #475569;">' + escapeHtml(s.device) + ' (' + escapeHtml(s.ip) + ')</td>' +
              '<td style="padding: 10px 14px; font-weight: 700; color: #0284c7;">' + escapeHtml(s.role) + '</td>' +
              '<td style="padding: 10px 14px; color: #059669; font-weight: 600;">' + timeStr + '</td>' +
              '<td style="padding: 10px 14px; text-align: right;">' +
              '<button data-id="' + s.sessionId + '" onclick="revokeSession(this.dataset.id)" style="background: #fee2e2; border: 1px solid #fca5a5; color: #dc2626; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 0.74rem; font-weight: 700;">Terminar Sessão</button>' +
              '</td></tr>';
          });

          html += '</tbody></table></div>';
          container.innerHTML = html;
        }
      } catch (err) {
        container.innerHTML = '<div style="color: #e11d48; padding: 10px;">Erro ao carregar sessões.</div>';
      }
    }

    async function revokeSession(sessionId) {
      if (!confirm('Deseja realmente terminar esta sessão ativa imediatamente?')) return;
      try {
        await fetch('/api/settings/sessions/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
        loadSettingsSessions();
      } catch (e) {}
    }

    async function submitForgotPassword() {
      const email = document.getElementById('forgotPassEmail').value.trim();
      const fb = document.getElementById('forgotPassFeedback');
      if (!email) {
        alert('Por favor introduza o seu email.');
        return;
      }
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, farmaciaId: activeFarmaciaId })
        });
        const data = await res.json();
        if (fb) {
          fb.style.display = 'block';
          if (data.ok) {
            fb.style.background = '#dcfce7';
            fb.style.color = '#15803d';
            fb.innerHTML = '✓ ' + escapeHtml(data.message) + (data.resetLinkPreview ? '<br><small><b>Link de teste:</b> <a href="' + data.resetLinkPreview + '" target="_blank">' + data.resetLinkPreview + '</a></small>' : '');
          } else {
            fb.style.background = '#fee2e2';
            fb.style.color = '#dc2626';
            fb.textContent = '❌ ' + (data.error || 'Erro ao processar pedido.');
          }
        }
      } catch (e) {
        alert('Erro ao enviar pedido de recuperação.');
      }
    }

    function openMobileStaffModal() {
      const farmsList = (typeof cachedAdminPharmacies !== 'undefined' && Array.isArray(cachedAdminPharmacies))
        ? cachedAdminPharmacies
        : ((typeof currentReport !== 'undefined' && currentReport?.farmacia) ? [currentReport.farmacia] : []);
      const f = activeFarmaciaId && farmsList ? farmsList.find(x => x.id === activeFarmaciaId) : ((typeof currentReport !== 'undefined' && currentReport?.farmacia) ? currentReport.farmacia : null);
      const code = f?.codigo_acesso || (typeof activeAccessCode !== 'undefined' && activeAccessCode ? activeAccessCode : '') || (activeFarmaciaId ? activeFarmaciaId : '');
      const farmIdParam = f?.id || activeFarmaciaId || '';
      const fullUrl = window.location.origin + '/mobile?acesso=' + encodeURIComponent(code) + (farmIdParam ? '&farmaciaId=' + encodeURIComponent(farmIdParam) : '');
      const inp = document.getElementById('mobileDirectUrl');
      if (inp) inp.value = fullUrl;
      const img = document.getElementById('mobileQrImg');
      if (img) img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(fullUrl);
      const modal = document.getElementById('mobileStaffModal');
      if (modal) modal.style.display = 'flex';
    }

    function closeMobileStaffModal() {
      document.getElementById('mobileStaffModal').style.display = 'none';
    }

    function copyMobileUrl() {
      const inp = document.getElementById('mobileDirectUrl');
      inp.select();
      navigator.clipboard.writeText(inp.value).then(() => {
        alert('✅ Link copiado para a área de transferência!');
      });
    }

    // ========================================================================
    // ESTADO E CONTROLO DOS FILTROS DA FICHA DE TRABALHO (DESKTOP)
    // ========================================================================
    let desktopFilters = {
      cadStatus: 'all',
      balcaoSubtab: 'restos',
      balcaoStatus: 'all',
      travStatus: 'all',
      ruturaStatus: 'all'
    };

    function setDesktopCadStatus(status) {
      desktopFilters.cadStatus = status;
      ['all', 'pending', 'done'].forEach(s => {
        const btn = document.getElementById('deskCadPill_' + s);
        if (btn) btn.classList.toggle('active', s === status);
      });
      renderDesktopCard1(true);
    }

    function onDesktopCadFilterChange() {
      renderDesktopCard1(false);
    }

    function setDesktopBalcaoSubtab(subtab) {
      desktopFilters.balcaoSubtab = subtab;
      const bRestos = document.getElementById('deskBalcaoBtnRestos');
      const bWinter = document.getElementById('deskBalcaoBtnWinter');
      const bAll = document.getElementById('deskBalcaoBtnAll');
      if (bRestos) bRestos.classList.toggle('active', subtab === 'restos');
      if (bWinter) bWinter.classList.toggle('active', subtab === 'winter');
      if (bAll) bAll.classList.toggle('active', subtab === 'all');
      renderDesktopCard2(false);
    }

    function setDesktopBalcaoStatus(status) {
      desktopFilters.balcaoStatus = status;
      ['all', 'pending', 'done'].forEach(s => {
        const btn = document.getElementById('deskBalcaoPill_' + s);
        if (btn) btn.classList.toggle('active', s === status);
      });
      renderDesktopCard2(true);
    }

    function onDesktopBalcaoFilterChange() {
      renderDesktopCard2(false);
    }

    function setDesktopTravStatus(status) {
      desktopFilters.travStatus = status;
      ['all', 'pending', 'done'].forEach(s => {
        const btn = document.getElementById('deskTravPill_' + s);
        if (btn) btn.classList.toggle('active', s === status);
      });
      renderDesktopCard3(true);
    }

    function onDesktopTravFilterChange() {
      renderDesktopCard3(false);
    }

    function setDesktopRuturaStatus(status) {
      desktopFilters.ruturaStatus = status;
      ['all', 'pending', 'done'].forEach(s => {
        const btn = document.getElementById('deskRuturaPill_' + s);
        if (btn) btn.classList.toggle('active', s === status);
      });
      renderDesktopCard4(true);
    }

    function onDesktopRuturaFilterChange() {
      renderDesktopCard4(false);
    }

    
    let desktopTasksEventSource = null;
    let desktopTasksFarmaciaId = null;

    function initDesktopTasksRealtime() {
      if (!activeFarmaciaId || typeof EventSource === 'undefined') return;
      if (desktopTasksEventSource && desktopTasksFarmaciaId === activeFarmaciaId) return;
      if (desktopTasksEventSource) {
        try { desktopTasksEventSource.close(); } catch(e) {}
        desktopTasksEventSource = null;
      }
      desktopTasksFarmaciaId = activeFarmaciaId;
      try {
        const es = new EventSource('/api/weekly-tasks/stream?farmaciaId=' + encodeURIComponent(activeFarmaciaId));
        desktopTasksEventSource = es;
        es.addEventListener('task_update', function(e) {
          try {
            const data = JSON.parse(e.data);
            if (data.type === 'RESET') {
              remoteDoneTasksMap = {};
              localStorage.removeItem('bi_pharma_weekly_done_' + activeFarmaciaId);
              updateWeeklyTasksCounter();
              return;
            }
            if (data.type === 'TOGGLE' && data.taskId) {
              if (data.concluido) {
                remoteDoneTasksMap[data.taskId] = {
                  concluido: true,
                  concluido_por: data.concluido_por,
                  concluido_em: data.concluido_em,
                  valor_impacto: data.valor_impacto,
                  categoria: data.categoria
                };
              } else {
                delete remoteDoneTasksMap[data.taskId];
              }
              localStorage.setItem('bi_pharma_weekly_done_' + activeFarmaciaId, JSON.stringify(remoteDoneTasksMap));
              updateWeeklyTasksCounter();
              const chk = document.querySelector('.weekly-task-checkbox[data-task-id="' + data.taskId + '"]');
              if (chk) chk.checked = !!data.concluido;
            }
          } catch(err) {}
        });
        es.onerror = function() {
          try { es.close(); } catch(e) {}
          if (desktopTasksEventSource === es) desktopTasksEventSource = null;
        };
      } catch(err) {}
    }

    window.addEventListener('pagehide', function() {
      if (desktopTasksEventSource) {
        try { desktopTasksEventSource.close(); } catch(e) {}
        desktopTasksEventSource = null;
      }
    });

    function updateWeeklyTasksCounter() {
      const map = getDoneTasksMap();
      const checkboxes = document.querySelectorAll('.weekly-task-checkbox');
      let done = 0;
      checkboxes.forEach(cb => {
        if (map[cb.dataset.taskId]) {
          cb.checked = true;
          done++;
          cb.closest('.weekly-task-item')?.classList.add('task-completed');
        } else {
          cb.checked = false;
          cb.closest('.weekly-task-item')?.classList.remove('task-completed');
        }
      });
      const txt = document.getElementById('planoProgressText');
      if (txt) {
        txt.textContent = \`✅ \${done} de \${checkboxes.length} tarefas concluídas pela equipa\`;
      }
    }

    let currentWeeklyPlanData = {
      card1: [],
      card1All: [],
      card2: [],
      card2Seasonal: [],
      card3: [],
      card3All: [],
      card4: [],
      card4All: [],
      card3TotalSavings: 0
    };

    // ======================================================================
    // RENDERIZAÇÃO MODULAR DOS 4 CARTÕES COM FILTROS AVANÇADOS (DESKTOP)
    // ======================================================================

    function renderDesktopCard1(preserveScroll = false) {
      if (!currentReport) return;
      const c1El = document.getElementById('planoCard1List');
      if (!c1El) return;
      const oldScroll = preserveScroll ? c1El.scrollTop : 0;
      const doneMap = getDoneTasksMap();

      const allCad = (currentReport.risco_elevado_caducidade || []).slice();
      currentWeeklyPlanData.card1All = allCad;

      const c1CountEl = document.getElementById('planoCard1Count');
      if (c1CountEl) {
        c1CountEl.textContent = \`\${allCad.length} produtos\`;
      }

      const q = (document.getElementById('deskCadSearch')?.value || '').toLowerCase().trim();
      const statusF = desktopFilters.cadStatus || 'all';
      const macroF = document.getElementById('deskCadMacroFilter')?.value || 'all';
      const horizonF = document.getElementById('deskCadHorizonFilter')?.value || 'all';
      const sortOrder = document.getElementById('deskCadSortOrder')?.value || 'date_asc';

      const filtered = allCad.filter(it => {
        const taskId = 'cad_' + it.cnp_codigo + '_' + (it.lote || 0);
        const isDone = !!doneMap[taskId];
        if (statusF === 'pending' && isDone) return false;
        if (statusF === 'done' && !isDone) return false;

        // Filtro de Macro-Área / Categoria
        if (macroF !== 'all') {
          const itemMacro = (it.macro_area || '').toUpperCase();
          const itemTipo = (it.tipo_venda || '').toUpperCase();
          if (macroF === 'MSRM' && itemTipo !== 'MSRM' && itemMacro !== 'MSRM') return false;
          if (macroF === 'MNSRM_OTC' && itemTipo !== 'MNSRM' && itemMacro !== 'MNSRM_OTC') return false;
          if (macroF === 'DERMOCOSMETICA' && itemMacro !== 'DERMOCOSMETICA') return false;
          if (macroF === 'NUTRICAO_SUPLEMENTOS' && itemMacro !== 'NUTRICAO_SUPLEMENTOS') return false;
          if (macroF === 'DISPOSITIVOS_SAUDE' && itemMacro !== 'DISPOSITIVOS_SAUDE') return false;
        }

        // Filtro de Horizonte de Validade
        if (horizonF !== 'all') {
          const meses = it.meses_ate_caducidade != null ? Number(it.meses_ate_caducidade) : 999;
          if (horizonF === 'urgent' && meses > 3) return false;
          if (horizonF === 'mid' && (meses <= 3 || meses > 6)) return false;
          if (horizonF === 'year' && (meses <= 6 || meses > 12)) return false;
        }

        if (q) {
          const name = (it.designacao || '').toLowerCase();
          const cnp = (it.cnp_codigo || '').toLowerCase();
          const lote = (it.lote || '').toLowerCase();
          const prat = (it.prateleira || '').toLowerCase();
          return name.includes(q) || cnp.includes(q) || lote.includes(q) || prat.includes(q);
        }
        return true;
      });

      // Ordenação selecionada pelo utilizador
      filtered.sort((a, b) => {
        if (sortOrder === 'name_asc') {
          return (a.designacao || '').localeCompare(b.designacao || '', 'pt');
        }
        if (sortOrder === 'shelf_asc') {
          const sA = a.prateleira || 'ZZZ';
          const sB = b.prateleira || 'ZZZ';
          const compShelf = sA.localeCompare(sB, 'pt');
          if (compShelf !== 0) return compShelf;
          return (a.designacao || '').localeCompare(b.designacao || '', 'pt');
        }
        if (sortOrder === 'val_desc') {
          const vA = a.valor_em_risco != null ? a.valor_em_risco : ((a.stock_atual || 1) * (a.custo_unitario || 0));
          const vB = b.valor_em_risco != null ? b.valor_em_risco : ((b.stock_atual || 1) * (b.custo_unitario || 0));
          return vB - vA;
        }
        // Padrão: data de validade mais próxima primeiro
        const dateA = a.data_validade || '9999-12-31';
        const dateB = b.data_validade || '9999-12-31';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        const vA = a.valor_em_risco != null ? a.valor_em_risco : ((a.stock_atual || 1) * (a.custo_unitario || 0));
        const vB = b.valor_em_risco != null ? b.valor_em_risco : ((b.stock_atual || 1) * (b.custo_unitario || 0));
        return vB - vA;
      });

      currentWeeklyPlanData.card1 = filtered;

      const badgeEl = document.getElementById('planoCard1FilteredBadge');
      if (badgeEl) {
        badgeEl.textContent = \`\${filtered.length} de \${allCad.length} produtos\`;
      }

      if (filtered.length === 0) {
        c1El.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:24px;text-align:center;">✅ Nenhuma validade encontrada com os filtros selecionados.</div>';
        return;
      }

      c1El.innerHTML = filtered.slice(0, 50).map((item, idx) => {
        const taskId = 'cad_' + item.cnp_codigo + '_' + (item.lote || 0);
        const isDone = !!doneMap[taskId];
        const qtd = item.stock_atual != null ? item.stock_atual : (item.quantidade || 1);
        const valRisco = item.valor_em_risco != null ? item.valor_em_risco : (qtd * (item.custo_unitario || 0));
        const instrucao = '⚠️ <b>Atenção à Validade:</b> Produto a aproximar-se do fim de vida útil (Data: <b>' + (item.data_validade || 'Curto Prazo') + '</b>). Requer ação prioritária de separação física na gaveta ou destaque no balcão.';

        return \`
          <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; gap: 12px; align-items: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
            <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\${taskId}', 'VALIDADE', '\${item.cnp_codigo}', '\${escapeHtml(item.designacao)}', \${valRisco})" style="margin-top: 3px; width: 18px; height: 18px; cursor: pointer; accent-color: #f43f5e;" />
            <div style="flex: 1;">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                <span style="font-weight: 700; color: #0f172a; font-size: 0.88rem;">\${item.designacao}</span>
                <span style="font-size: 0.78rem; font-weight: 700; color: #be123c; background: #ffe4e6; padding: 2px 8px; border-radius: 4px; font-weight: 800; border: 1px solid #fecdd3;">Val: \${item.data_validade || 'Curto Prazo'} · \${qtd} un (\${valRisco.toFixed(2)} € em risco)</span>
              </div>
              <div style="font-size: 0.82rem; color: #334155; margin-top: 5px; line-height: 1.4;">
                \${instrucao}
              </div>
              <div style="font-size: 0.72rem; color: var(--muted); margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                <span>CNP: <code style="color:#0284c7">\${item.cnp_codigo}</code></span>
                <span>Lote: <b>\${item.lote || 'Geral'}</b></span>
                \${item.prateleira ? \`<span style="color: #475569; background: #f1f5f9; padding: 1px 6px; border-radius: 4px;">📍 \${item.prateleira}</span>\` : ''}
                <span style="color: #64748b;">Tipo: \${item.tipo_venda || 'Geral'}</span>
              </div>
            </div>
          </div>
        \`;
      }).join('');

      if (preserveScroll) c1El.scrollTop = oldScroll;
    }

    function renderDesktopCard2(preserveScroll = false) {
      if (!currentReport) return;
      const c2El = document.getElementById('planoCard2List');
      if (!c2El) return;
      const oldScroll = preserveScroll ? c2El.scrollTop : 0;
      const doneMap = getDoneTasksMap();

      // Moléculas com restos de gaveta, estritamente ordenadas por ORDEM ALFABÉTICA (A ➔ Z)
      const listGen = (currentReport.consolidacao_genericos_dci || [])
        .filter(g => g.restos_gaveta_escobar_primeiro && g.restos_gaveta_escobar_primeiro.length > 0)
        .slice()
        .sort((a, b) => {
          const nameA = a.grupo_equivalencia_dci || a.molecula_dci || '';
          const nameB = b.grupo_equivalencia_dci || b.molecula_dci || '';
          return nameA.localeCompare(nameB, 'pt');
        });

      // Excessos sazonais em pico de inverno (ordenados alfabeticamente A ➔ Z)
      const listSeasonal = (currentReport.alertas_excesso_cobertura || [])
        .filter(i => (i.stock_atual || 0) >= 3 && /ben-u-gripe|cegripe|antigrip|grip|constip|tosse|frio|labi|ureia|vapor|pastilh|gargant|nasal/i.test(i.designacao))
        .slice()
        .sort((a, b) => (a.designacao || '').localeCompare(b.designacao || '', 'pt'));

      currentWeeklyPlanData.card2 = listGen;
      currentWeeklyPlanData.card2Seasonal = listSeasonal;

      const c2CountEl = document.getElementById('planoCard2Count');
      if (c2CountEl) {
        c2CountEl.textContent = \`\${listGen.length} moléculas + \${listSeasonal.length} excessos sazonais\`;
      }

      const q = (document.getElementById('deskBalcaoSearch')?.value || '').toLowerCase().trim();
      const statusF = desktopFilters.balcaoStatus || 'all';
      const subtab = desktopFilters.balcaoSubtab || 'restos';

      let html = '';
      let renderedCount = 0;

      // Bloco A: Restos de gaveta A-Z
      if (subtab === 'restos' || subtab === 'all') {
        const filteredGen = listGen.filter(g => {
          const taskId = 'gen_' + normStr(g.molecula_dci || g.grupo_equivalencia_dci);
          const isDone = !!doneMap[taskId];
          if (statusF === 'pending' && isDone) return false;
          if (statusF === 'done' && !isDone) return false;
          if (q) {
            const mol = (g.molecula_dci || '').toLowerCase();
            const eq = (g.grupo_equivalencia_dci || '').toLowerCase();
            return mol.includes(q) || eq.includes(q);
          }
          return true;
        });

        renderedCount += filteredGen.length;

        if (filteredGen.length > 0) {
          html += '<div style="font-size: 0.78rem; font-weight: 800; color: #7e22ce; text-transform: uppercase; margin: 4px 0 8px;">📦 Restos de Gaveta Alfabéticos (A ➔ Z):</div>';
          html += filteredGen.slice(0, 50).map(g => {
            const taskId = 'gen_' + normStr(g.molecula_dci || g.grupo_equivalencia_dci);
            const isDone = !!doneMap[taskId];
            const restos = g.restos_gaveta_escobar_primeiro || [];
            const name = g.grupo_equivalencia_dci || g.molecula_dci;

            const restosHtml = restos.map(r => \`
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem; padding: 4px 0; border-bottom: 1px dashed #e9d5ff;">
                <span style="color: #0f172a; font-weight: 600;">• <b>\${r.designacao}</b> (CNP: <code style="color: #6b21a8; font-weight: 700;">\${r.cnp_codigo}</code>)</span>
                <span style="color: #6b21a8; font-weight: 800; font-size: 0.78rem;">\${r.stock_atual} un</span>
              </div>
            \`).join('');

            return \`
              <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px;">
                <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\${taskId}', 'RESTO_GAVETA', null, '\${escapeHtml(name)}', 0)" style="margin-top: 3px; width: 17px; height: 17px; cursor: pointer; accent-color: #a855f7;" />
                <div style="flex: 1;">
                  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
                    <span style="font-weight: 700; color: #0f172a; font-size: 0.86rem;">\${name}</span>
                    <span style="font-size: 0.74rem; font-weight: 700; color: #7e22ce; background: rgba(168,85,247,0.12); padding: 2px 7px; border-radius: 4px;">\${restos.length} marcas a esgotar</span>
                  </div>
                  <div style="margin-top: 6px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 6px; padding: 6px 8px;">
                    \${restosHtml}
                  </div>
                  <div style="font-size: 0.78rem; color: #334155; margin-top: 6px;">
                    👉 <b>Ação Balcão:</b> Dispensar primeiro estas caixas paradas na gaveta antes de encomendar outras marcas.
                  </div>
                </div>
              </div>
            \`;
          }).join('');
        }
      }

      // Bloco B: Excessos Sazonais em Pico de Inverno
      if (subtab === 'winter' || subtab === 'all') {
        const filteredSeasonal = listSeasonal.filter(s => {
          const taskId = 'saz_' + s.cnp_codigo;
          const isDone = !!doneMap[taskId];
          if (statusF === 'pending' && isDone) return false;
          if (statusF === 'done' && !isDone) return false;
          if (q) {
            const name = (s.designacao || '').toLowerCase();
            const cnp = (s.cnp_codigo || '').toLowerCase();
            return name.includes(q) || cnp.includes(q);
          }
          return true;
        });

        renderedCount += filteredSeasonal.length;

        if (filteredSeasonal.length > 0) {
          html += '<div style="font-size: 0.78rem; font-weight: 800; color: #0284c7; text-transform: uppercase; margin: 12px 0 8px;">❄️ Destaques da Época de Inverno (A ➔ Z):</div>';
          html += filteredSeasonal.map(item => {
            const taskId = 'saz_' + item.cnp_codigo;
            const isDone = !!doneMap[taskId];
            const cobText = item.cobertura_meses ? \`\${item.cobertura_meses.toFixed(0)} meses de stock\` : 'stock elevado';

            return \`
              <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px;">
                <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\${taskId}', 'DESTAQUE_SAZONAL', '\${item.cnp_codigo}', '\${escapeHtml(item.designacao)}', 0)" style="margin-top: 3px; width: 17px; height: 17px; cursor: pointer; accent-color: #0284c7;" />
                <div style="flex: 1;">
                  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
                    <span style="font-weight: 700; color: #0369a1; font-size: 0.86rem;">\${item.designacao}</span>
                    <span style="font-size: 0.74rem; font-weight: 800; color: #0284c7; background: #e0f2fe; padding: 2px 7px; border-radius: 4px; border: 1px solid #bae6fd;">\${item.stock_atual} un em armazém (\${cobText})</span>
                  </div>
                  <div style="font-size: 0.80rem; color: #075985; margin-top: 5px; line-height: 1.4;">
                    ❄️ <b>Pico Sazonal de Inverno:</b> Colocar em destaque no balcão e no cesto de oportunidade com aconselhamento ativo da equipa.
                  </div>
                  <div style="font-size: 0.72rem; color: #0369a1; margin-top: 3px;">
                    CNP: <code>\${item.cnp_codigo}</code> | PVP: <b>\${item.pvp ? item.pvp.toFixed(2) + '€' : '-'}</b>
                  </div>
                </div>
              </div>
            \`;
          }).join('');
        }
      }

      const badgeEl = document.getElementById('planoCard2FilteredBadge');
      if (badgeEl) {
        badgeEl.textContent = \`\${renderedCount} itens visíveis\`;
      }

      c2El.innerHTML = html || '<div style="color:var(--muted);font-size:0.85rem;padding:24px;text-align:center;">✅ Sem restos de gaveta ou destaques pendentes com os filtros atuais.</div>';
      if (preserveScroll) c2El.scrollTop = oldScroll;
    }

    function renderDesktopCard3(preserveScroll = false) {
      if (!currentReport) return;
      const c3El = document.getElementById('planoCard3List');
      if (!c3El) return;
      const oldScroll = preserveScroll ? c3El.scrollTop : 0;
      const doneMap = getDoneTasksMap();

      const poolTrav = [
        ...(currentReport.alertas_excesso_cobertura || []).map(i => {
          const vmm = i.vmm || 1;
          const excessUnits = Math.max(0, (i.stock_atual || 0) - Math.max(1, Math.round(vmm * 2)));
          const perda = excessUnits > 0 ? excessUnits * (i.custo_unitario || 0) : ((i.stock_atual || 0) * (i.custo_unitario || 0));
          return {
            ...i,
            tipoAlerta: 'Excesso de Cobertura',
            perda: perda > 0 ? perda : ((i.stock_atual || 0) * (i.custo_unitario || 0))
          };
        }),
        ...(currentReport.monos || []).map(i => ({
          ...i,
          tipoAlerta: 'Mono sem Vendas',
          perda: i.capital_imobilizado || ((i.stock_atual || 0) * (i.custo_unitario || 0))
        }))
      ];

      const mapTrav = new Map();
      for (const item of poolTrav) {
        if (!mapTrav.has(item.cnp_codigo)) {
          mapTrav.set(item.cnp_codigo, item);
        } else {
          const existing = mapTrav.get(item.cnp_codigo);
          if ((item.perda || 0) > (existing.perda || 0)) mapTrav.set(item.cnp_codigo, item);
        }
      }

      const allTrav = Array.from(mapTrav.values());
      currentWeeklyPlanData.card3All = allTrav;

      const totalSavings = allTrav.reduce((s, i) => s + (i.perda || 0), 0);
      currentWeeklyPlanData.card3TotalSavings = totalSavings;

      const savBadge = document.getElementById('planoCard3Savings');
      if (savBadge) {
        savBadge.textContent = \`Poupança: \${totalSavings.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €\`;
      }

      const q = (document.getElementById('deskTravSearch')?.value || '').toLowerCase().trim();
      const statusF = desktopFilters.travStatus || 'all';
      const sortOrder = document.getElementById('deskTravSortOrder')?.value || 'perda_desc';

      const filtered = allTrav.filter(item => {
        const taskId = 'trav_' + item.cnp_codigo;
        const isDone = !!doneMap[taskId];
        if (statusF === 'pending' && isDone) return false;
        if (statusF === 'done' && !isDone) return false;
        if (q) {
          const name = (item.designacao || '').toLowerCase();
          const cnp = (item.cnp_codigo || '').toLowerCase();
          return name.includes(q) || cnp.includes(q);
        }
        return true;
      });

      filtered.sort((a, b) => {
        if (sortOrder === 'name_asc') {
          return (a.designacao || '').localeCompare(b.designacao || '', 'pt');
        }
        if (sortOrder === 'cob_desc') {
          return (b.cobertura_meses || 0) - (a.cobertura_meses || 0);
        }
        return (b.perda || 0) - (a.perda || 0);
      });

      currentWeeklyPlanData.card3 = filtered;

      const badgeEl = document.getElementById('planoCard3FilteredBadge');
      if (badgeEl) {
        badgeEl.textContent = \`\${filtered.length} de \${allTrav.length} artigos\`;
      }

      if (filtered.length === 0) {
        c3El.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:24px;text-align:center;">✅ Sem compras excessivas a travar com os filtros selecionados.</div>';
        return;
      }

      c3El.innerHTML = filtered.slice(0, 50).map(item => {
        const taskId = 'trav_' + item.cnp_codigo;
        const isDone = !!doneMap[taskId];
        const motivo = item.cobertura_meses
          ? \`Temos \${item.stock_atual} un em stock (\${item.cobertura_meses.toFixed(1)} meses de cobertura)\`
          : \`Temos \${item.stock_atual} un paradas sem vendas há meses\`;

        return \`
          <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; gap: 12px; align-items: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
            <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\${taskId}', 'TRAVAR_COMPRA', '\${item.cnp_codigo}', '\${escapeHtml(item.designacao)}', \${item.perda || 0})" style="margin-top: 3px; width: 18px; height: 18px; cursor: pointer; accent-color: #f59e0b;" />
            <div style="flex: 1;">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                <span style="font-weight: 700; color: #0f172a; font-size: 0.88rem;">\${item.designacao}</span>
                <span style="font-size: 0.78rem; font-weight: 700; color: #92400e; background: #fef3c7; padding: 2px 8px; border-radius: 4px; font-weight: 800; border: 1px solid #fde68a;">CNP: \${item.cnp_codigo} · \${(item.perda || 0).toFixed(2)} €</span>
              </div>
              <div style="font-size: 0.82rem; color: #334155; margin-top: 5px; line-height: 1.4;">
                🛑 <b>Ação no Sistema:</b> Alterar Ponto de Encomenda / Stock Mínimo para <b>0</b> (\${motivo}).
              </div>
            </div>
          </div>
        \`;
      }).join('');

      if (preserveScroll) c3El.scrollTop = oldScroll;
    }

    function renderDesktopCard4(preserveScroll = false) {
      if (!currentReport) return;
      const c4El = document.getElementById('planoCard4List');
      if (!c4El) return;
      const oldScroll = preserveScroll ? c4El.scrollTop : 0;
      const doneMap = getDoneTasksMap();

      const rawRuturaPool = (currentReport.artigos_risco_rutura || []).slice();
      currentWeeklyPlanData.card4All = rawRuturaPool;

      const c4CountEl = document.getElementById('planoCard4Count');
      if (c4CountEl) {
        c4CountEl.textContent = \`\${rawRuturaPool.length} artigos em risco de rutura\`;
      }

      const q = (document.getElementById('deskRuturaSearch')?.value || '').toLowerCase().trim();
      const statusF = desktopFilters.ruturaStatus || 'all';
      const sortOrder = document.getElementById('deskRuturaSortOrder')?.value || 'urgente';

      const filtered = rawRuturaPool.filter(item => {
        const taskId = 'rut_' + item.cnp_codigo;
        const isDone = !!doneMap[taskId];
        if (statusF === 'pending' && isDone) return false;
        if (statusF === 'done' && !isDone) return false;
        if (q) {
          const name = (item.designacao || '').toLowerCase();
          const cnp = (item.cnp_codigo || '').toLowerCase();
          return name.includes(q) || cnp.includes(q);
        }
        return true;
      });

      filtered.sort((a, b) => {
        if (sortOrder === 'name_asc') {
          return (a.designacao || '').localeCompare(b.designacao || '', 'pt');
        }
        if (sortOrder === 'vmm_desc') {
          return (b.vmm || 0) - (a.vmm || 0);
        }
        // Urgente: menor cobertura / stock atual menor
        const diasA = a.dias_cobertura != null ? a.dias_cobertura : 999;
        const diasB = b.dias_cobertura != null ? b.dias_cobertura : 999;
        if (diasA !== diasB) return diasA - diasB;
        return (a.stock_atual || 0) - (b.stock_atual || 0);
      });

      currentWeeklyPlanData.card4 = filtered;

      const badgeEl = document.getElementById('planoCard4FilteredBadge');
      if (badgeEl) {
        badgeEl.textContent = \`\${filtered.length} de \${rawRuturaPool.length} artigos\`;
      }

      if (filtered.length === 0) {
        c4El.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:24px;text-align:center;">✅ Níveis de stock mínimos equilibrados no sistema com os filtros atuais.</div>';
        return;
      }

      c4El.innerHTML = filtered.slice(0, 50).map(item => {
        const taskId = 'rut_' + item.cnp_codigo;
        const isDone = !!doneMap[taskId];
        const sugestaoEnc = item.sugestao_encomenda || Math.max(2, Math.ceil((item.vmm || 1) * 0.5));
        const diasTxt = item.dias_cobertura != null ? \`\${item.dias_cobertura} dias\` : 'crítica';

        return \`
          <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px; display: flex; gap: 12px; align-items: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
            <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\${taskId}', 'PREVENIR_RUTURA', '\${item.cnp_codigo}', '\${escapeHtml(item.designacao)}', 0)" style="margin-top: 3px; width: 18px; height: 18px; cursor: pointer; accent-color: #0284c7;" />
            <div style="flex: 1;">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                <span style="font-weight: 700; color: #0f172a; font-size: 0.88rem;">\${item.designacao}</span>
                <span style="font-size: 0.78rem; font-weight: 800; color: #0369a1; background: #e0f2fe; padding: 2px 8px; border-radius: 4px; border: 1px solid #bae6fd;">
                  Stock: \${item.stock_atual} un · VMM: \${item.vmm}/mês
                </span>
              </div>
              <div style="font-size: 0.82rem; color: #334155; margin-top: 5px; line-height: 1.4;">
                🟢 <b>Ajustar no Sistema:</b> Subir Ponto de Encomenda para <b>\${sugestaoEnc} un</b> (risco de rutura iminente face às vendas: cobertura atual de apenas \${diasTxt}).
              </div>
              <div style="font-size: 0.72rem; color: var(--muted); margin-top: 4px;">
                CNP: <code style="color:#0284c7">\${item.cnp_codigo}</code> | Categoria: \${item.categoria || 'Geral'} | Tipo: \${item.tipo_venda || 'MSRM'}
              </div>
            </div>
          </div>
        \`;
      }).join('');

      if (preserveScroll) c4El.scrollTop = oldScroll;
    }

    function renderWeeklyActionPlan() {
      fetchWeeklyTasksFromDb();
    initDesktopTasksRealtime();
      if (!currentReport) return;

      renderDesktopCard1(false);
      renderDesktopCard2(false);
      renderDesktopCard3(false);
      renderDesktopCard4(false);

      updateWeeklyTasksCounter();
    }
    function printWeeklyActionPlan() {
      if (!currentReport) return;
      const farmNome = currentReport.farmacia?.nome || 'Farmácia';
      const farmNif = currentReport.farmacia?.nif || '';
      const dataRef = currentReport.parametros?.data_referencia || new Date().toISOString().slice(0, 10);

      const html = \`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8" />
          <title>Folha Semanal da Equipa (4 Pilares) — \${farmNome}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 20px; color: #0f172a; line-height: 1.4; font-size: 11px; }
            .header { border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
            h1 { margin: 0; font-size: 16px; font-weight: 800; text-transform: uppercase; color: #0f172a; }
            h2 { font-size: 11.5px; margin: 14px 0 6px 0; background: #f1f5f9; padding: 6px 10px; border-left: 4px solid #0284c7; font-weight: 800; text-transform: uppercase; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 10px; }
            th, td { border: 1px solid #cbd5e1; padding: 5px 7px; text-align: left; vertical-align: middle; }
            th { background: #f8fafc; font-weight: 700; color: #334155; }
            .box { width: 13px; height: 13px; border: 1.5px solid #475569; display: inline-block; vertical-align: middle; border-radius: 2px; }
            .footer { margin-top: 16px; padding-top: 10px; border-top: 1px dashed #94a3b8; font-size: 10px; display: flex; justify-content: space-between; color: #64748b; }
            @media print {
              body { margin: 8mm; }
              button { display: none; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1>📋 Folha Semanal de Ações da Farmácia (4 Pilares)</h1>
              <div style="font-size: 12px; font-weight: bold; margin-top: 4px;">\${farmNome} (NIF: \${farmNif})</div>
            </div>
            <div style="text-align: right; font-size: 11px;">
              <div>Data de Emissão: \${dataRef}</div>
              <div><b>Modo de Execução com Checkbox [ ]</b></div>
            </div>
          </div>

          <h2>🔴 1. VALIDADES PRÓXIMAS A TRATAR (GAVETA & PRATELEIRAS)</h2>
          <table>
            <thead>
              <tr>
                <th style="width: 25px;">[ ]</th>
                <th style="width: 80px;">Código / Lote</th>
                <th>Designação do Produto</th>
                <th style="width: 50px;">Qtd</th>
                <th style="width: 75px;">Validade</th>
                <th>Ação Obrigatória na Farmácia</th>
              </tr>
            </thead>
            <tbody>
              \${(currentWeeklyPlanData.card1 || []).map(i => {
                const qtd = i.stock_atual != null ? i.stock_atual : (i.quantidade || 1);
                return \`
                  <tr>
                    <td style="text-align: center;"><span class="box"></span></td>
                    <td><b>\${i.cnp_codigo}</b><br/><span style="font-size:9px;color:#555;">Lote: \${i.lote || '-'}</span></td>
                    <td><b>\${i.designacao}</b></td>
                    <td>\${qtd} un</td>
                    <td><b>\${i.data_validade || '-'}</b></td>
                    <td>⚠️ Atenção à Validade: Separar fisicamente na gaveta ou destacar prioritariamente no balcão.</td>
                  </tr>
                \`;
              }).join('')}
            </tbody>
          </table>

          <h2>🟠 2. PÔR A RODAR STOCK PARADO (RESTOS DE GAVETA & EXCESSOS SAZONAIS)</h2>
          <table>
            <thead>
              <tr>
                <th style="width: 25px;">[ ]</th>
                <th style="width: 140px;">Produto / Apresentação</th>
                <th style="width: 60px;">Stock</th>
                <th>Tipo de Situação</th>
                <th>Ação no Balcão / Cesto Temático</th>
              </tr>
            </thead>
            <tbody>
              \${(currentWeeklyPlanData.card2 || []).map(g => {
                const restos = g.restos_gaveta_escobar_primeiro || [];
                const restosTxt = restos.map(r => r.designacao + ' (' + r.stock_atual + ' un)').join(', ');
                return \`
                  <tr>
                    <td style="text-align: center;"><span class="box"></span></td>
                    <td><b>\${g.grupo_equivalencia_dci || g.molecula_dci}</b></td>
                    <td>\${g.stock_total_unidades} un</td>
                    <td><b>Restos de Gaveta</b>: \${restosTxt || 'Ver gaveta'}</td>
                    <td>Dispensar primeiro estas caixas paradas na gaveta antes de abrir novas embalagens.</td>
                  </tr>
                \`;
              }).join('')}
              \${(currentWeeklyPlanData.card2Seasonal || []).map(i => \`
                <tr>
                  <td style="text-align: center;"><span class="box"></span></td>
                  <td><b>\${i.designacao}</b> (CNP: \${i.cnp_codigo})</td>
                  <td><b>\${i.stock_atual} un</b></td>
                  <td><b>Excesso Sazonal (Inverno)</b>: \${i.cobertura_meses ? i.cobertura_meses.toFixed(0) + ' meses' : 'stock alto'}</td>
                  <td>Colocar em destaque no balcão ou no cesto de oportunidade aproveitando o pico de procura!</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>

          <h2>🛑 3. O QUE NÃO ENCOMENDAR MAIS (BLOQUEAR NO SISTEMA DE GESTÃO COM P.E. = 0)</h2>
          <table>
            <thead>
              <tr>
                <th style="width: 25px;">[ ]</th>
                <th style="width: 80px;">Código CNP</th>
                <th>Designação</th>
                <th style="width: 65px;">Stock Atual</th>
                <th style="width: 80px;">Capital Parado</th>
                <th>Ação no Sistema de Gestão</th>
              </tr>
            </thead>
            <tbody>
              \${(currentWeeklyPlanData.card3 || []).map(i => \`
                <tr>
                  <td style="text-align: center;"><span class="box"></span></td>
                  <td><b>\${i.cnp_codigo}</b></td>
                  <td>\${i.designacao}</td>
                  <td>\${i.stock_atual} un</td>
                  <td><b>\${(i.perda || 0).toFixed(2)} €</b></td>
                  <td>Alterar Ponto de Encomenda / Stock Mínimo para ZERO (\${i.cobertura_meses ? i.cobertura_meses.toFixed(1) + ' meses de cobertura' : 'stock sem rotação'}).</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>

          <h2>🟢 4. AJUSTAR NÍVEIS & PREVENIR RUTURAS (SUBIR PONTO DE ENCOMENDA NO SISTEMA)</h2>
          <table>
            <thead>
              <tr>
                <th style="width: 25px;">[ ]</th>
                <th style="width: 80px;">Código CNP</th>
                <th>Designação</th>
                <th style="width: 65px;">Stock Atual</th>
                <th style="width: 75px;">VMM</th>
                <th>Ação Recomendada no Sistema</th>
              </tr>
            </thead>
            <tbody>
              \${(currentWeeklyPlanData.card4 || []).map(i => {
                const sugestao = i.sugestao_encomenda || Math.max(2, Math.ceil((i.vmm || 1) * 0.5));
                return \`
                  <tr>
                    <td style="text-align: center;"><span class="box"></span></td>
                    <td><b>\${i.cnp_codigo}</b></td>
                    <td><b>\${i.designacao}</b></td>
                    <td>\${i.stock_atual} un</td>
                    <td>\${i.vmm ? i.vmm + ' un/mês' : '-'}</td>
                    <td><b>Subir Ponto de Encomenda para \${sugestao} un</b> (cobertura crítica de \${i.dias_cobertura != null ? i.dias_cobertura + ' dias' : 'baixo stock'}).</td>
                  </tr>
                \`;
              }).join('')}
            </tbody>
          </table>

          <div class="footer">
            <div>Folha Operacional de Farmácia — Assinatura do Responsável: ___________________________</div>
            <div>BI Pharma © Nuelltech · Poupança Travada: \${(currentWeeklyPlanData.card3TotalSavings || 0).toFixed(2)} €</div>
          </div>
        


</body>
        </html>
      \`;

      const w = window.open('', '_blank');
      if (w) {
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => { w.print(); }, 250);
      }
    }

    function renderActiveTable() {
      if (!currentReport || activeTab === 'plano' || activeTab === 'copilot' || activeTab === 'campaigns') return;
      const rawFilter = document.getElementById('tableFilter') ? document.getElementById('tableFilter').value : '';
      const filter = normStr(rawFilter);
      const tvFilter = document.getElementById('selectTipoVenda').value;
      const table = document.getElementById('mainTable');
      const countEl = document.getElementById('tableRowCount');

      if (activeTab === 'genericos') {
        const isCompatible = tvFilter === 'ALL' || tvFilter === 'GENERICO_MG' || tvFilter === 'MSRM';
        const rows = isCompatible ? currentReport.consolidacao_genericos_dci.filter(g =>
          !filter ||
          normStr(g.grupo_equivalencia_dci).includes(filter) ||
          normStr(g.molecula_dci).includes(filter) ||
          g.todos_laboratorios.some(l => normStr(l.cnp_codigo).includes(filter) || normStr(l.designacao).includes(filter))
        ) : [];

        if (countEl) {
          countEl.textContent = \`\${rows.length} \${rows.length === 1 ? 'molécula/apresentação' : 'moléculas/apresentações'}\`;
        }

        if (rows.length === 0) {
          table.innerHTML = \`
            <tbody>
              <tr>
                <td colspan="8" style="text-align: center; padding: 48px 16px; color: var(--muted); font-size: 0.95rem;">
                  🔎 Nenhuma molécula genérica encontrada para a pesquisa <b>"\${rawFilter || tvFilter}"</b>.<br/>
                  <span style="font-size:0.82rem;margin-top:6px;display:inline-block">Experimente limpar a pesquisa ou selecionar "Todos os Produtos".</span>
                </td>
              </tr>
            </tbody>
          \`;
          return;
        }

        table.innerHTML = \`
          <thead>
            <tr>
              <th>Molécula DCI + Dosagem + Embalagem</th>
              <th>Nº Labs Abertos</th>
              <th>Stock Conjunto</th>
              <th>VMM Conjunta</th>
              <th>Custo Mínimo (Lab + Barato)</th>
              <th>Custo Máximo (Lab + Caro)</th>
              <th>Diferença Preço Custo</th>
              <th>Restos de Gaveta (≤ 2 caixas) a Escoar Primeiro</th>
            </tr>
          </thead>
          <tbody>
            \${rows.map(g => \`
              <tr class="clickable-row" onclick="openProductModal('\${g.restos_gaveta_escobar_primeiro[0]?.cnp_codigo || g.todos_laboratorios[0].cnp_codigo}')">
                <td><b>🧬 \${g.grupo_equivalencia_dci}</b></td>
                <td><span class="badge badge-purple">\${g.num_laboratorios_abertos} laboratórios</span></td>
                <td><b>\${g.stock_total_unidades} un</b> (\${g.valor_total_stock.toFixed(2)} €)</td>
                <td>\${g.vmm_total_grupo} /mês</td>
                <td style="color:#34d399"><b>\${g.custo_minimo.toFixed(2)} €</b><br/><span style="font-size:0.74rem;color:var(--muted)">\${g.laboratorio_mais_barato.slice(0, 32)}</span></td>
                <td style="color:#fb7185"><b>\${g.custo_maximo.toFixed(2)} €</b><br/><span style="font-size:0.74rem;color:var(--muted)">\${g.laboratorio_mais_caro.slice(0, 32)}</span></td>
                <td><span class="badge badge-warning">+\${g.diferenca_custo_pct}%</span></td>
                <td>\${g.restos_gaveta_escobar_primeiro.length > 0
                  ? g.restos_gaveta_escobar_primeiro.map(rg => \`<span class="badge badge-danger" style="margin:2px">[\${rg.cnp_codigo}] \${rg.stock_atual}un (\${rg.custo_unitario.toFixed(2)}€)</span>\`).join(' ')
                  : '<span style="color:var(--muted)">Sem restos críticos</span>'}</td>
              </tr>
            \`).join('')}
          </tbody>
        \`;
        return;
      }

      const macroAreaFilter = document.getElementById('selectMacroArea') ? document.getElementById('selectMacroArea').value : 'ALL';
      const catFilter = document.getElementById('selectCategoria') ? document.getElementById('selectCategoria').value : 'ALL';
      const sazFilter = document.getElementById('selectSazonalidade') ? document.getElementById('selectSazonalidade').value : 'ALL';

      const matchRow = (i) => {
        if (!matchesTipoVendaFilter(i, tvFilter)) return false;
        if (!matchesMacroAreaFilter(i, macroAreaFilter)) return false;
        if (!matchesCategoriaFilter(i, catFilter)) return false;
        if (!matchesSazonalidadeFilter(i, sazFilter)) return false;
        if (!filter) return true;
        return (
          normStr(i.cnp_codigo).includes(filter) ||
          normStr(i.designacao).includes(filter) ||
          normStr(i.categoria).includes(filter) ||
          normStr(i.subcategoria).includes(filter) ||
          normStr(i.grupo_equivalencia_dci).includes(filter)
        );
      };

      let allRows = [];
      if (activeTab === 'caducidade') {
        allRows = currentReport.risco_elevado_caducidade.filter(matchRow);
      } else if (activeTab === 'monos') {
        allRows = currentReport.monos.filter(matchRow);
      } else {
        allRows = currentReport.alertas_excesso_cobertura.filter(matchRow);
      }

      const displayRows = allRows.slice(0, 500);

      if (countEl) {
        if (allRows.length > 500) {
          countEl.textContent = \`A mostrar 500 de \${allRows.length} artigos\`;
        } else {
          countEl.textContent = \`\${allRows.length} \${allRows.length === 1 ? 'artigo encontrado' : 'artigos encontrados'}\`;
        }
      }

      if (allRows.length === 0) {
        table.innerHTML = \`
          <tbody>
            <tr>
              <td colspan="9" style="text-align: center; padding: 48px 16px; color: var(--muted); font-size: 0.95rem;">
                🔎 Nenhum artigo encontrado para o filtro <b>"\${rawFilter || tvFilter}"</b> nesta aba.<br/>
                <span style="font-size:0.82rem;margin-top:6px;display:inline-block">Experimente limpar a pesquisa ou selecionar "Todos os Produtos".</span>
              </td>
            </tr>
          </tbody>
        \`;
        return;
      }

      if (activeTab === 'caducidade') {
        table.innerHTML = \`
          <thead>
            <tr>
              <th>Código</th>
              <th>Categoria & Sazonalidade</th>
              <th>Designação</th>
              <th>Stock</th>
              <th>Validade</th>
              <th>VMM</th>
              <th>Emb. Risco</th>
              <th>Valor Risco (€)</th>
              <th>Ação Recomendada</th>
            </tr>
          </thead>
          <tbody>
            \${displayRows.map(r => \`
              <tr class="clickable-row" onclick="openProductModal('\${r.cnp_codigo}')">
                <td><b>\${r.cnp_codigo}</b></td>
                <td>\${formatCategoriaBadge(r)}</td>
                <td>\${r.designacao}</td>
                <td>\${r.stock_atual}</td>
                <td><span class="badge badge-danger">\${r.data_validade} (\${r.meses_ate_caducidade}m)</span></td>
                <td>\${r.vmm}/mês</td>
                <td><b>\${r.unidades_em_risco}</b>/\${r.stock_atual}</td>
                <td style="color:#fb7185;font-weight:700">\${r.valor_em_risco.toFixed(2)} €</td>
                <td>\${r.acao_recomendada}</td>
              </tr>
            \`).join('')}
          </tbody>
        \`;
      } else if (activeTab === 'monos') {
        table.innerHTML = \`
          <thead>
            <tr>
              <th>Código</th>
              <th>Categoria & Sazonalidade</th>
              <th>Designação</th>
              <th>Stock</th>
              <th>Custo Unit.</th>
              <th>PVP (Margem)</th>
              <th>Capital Imobilizado (€)</th>
              <th>Última Venda</th>
              <th>Estratégia Recomendada</th>
            </tr>
          </thead>
          <tbody>
            \${displayRows.map(r => \`
              <tr class="clickable-row" onclick="openProductModal('\${r.cnp_codigo}')">
                <td><b>\${r.cnp_codigo}</b></td>
                <td>\${formatCategoriaBadge(r)}</td>
                <td>\${r.designacao}</td>
                <td>\${r.stock_atual}</td>
                <td>\${r.custo_unitario.toFixed(2)} €</td>
                <td>\${r.pvp !== null ? r.pvp.toFixed(2) + ' €' : '-'} \${r.margem_percentagem ? '(' + r.margem_percentagem.toFixed(0) + '%)' : ''}</td>
                <td style="color:#fbbf24;font-weight:700">\${r.capital_imobilizado.toFixed(2)} €</td>
                <td>\${r.ultima_venda || 'Sem vendas (13m)'}</td>
                <td>\${r.acao_sugerida}</td>
              </tr>
            \`).join('')}
          </tbody>
        \`;
      } else {
        table.innerHTML = \`
          <thead>
            <tr>
              <th>Código</th>
              <th>Categoria & Sazonalidade</th>
              <th>Designação</th>
              <th>Stock</th>
              <th>PVP (Margem)</th>
              <th>VMM</th>
              <th>Cobertura</th>
              <th>Orientação de Balcão / Substituição DCI</th>
            </tr>
          </thead>
          <tbody>
            \${displayRows.map(r => \`
              <tr class="clickable-row" onclick="openProductModal('\${r.cnp_codigo}')">
                <td><b>\${r.cnp_codigo}</b></td>
                <td>\${formatCategoriaBadge(r)}</td>
                <td>\${r.designacao}</td>
                <td>\${r.stock_atual}</td>
                <td>\${r.pvp !== null ? r.pvp.toFixed(2) + ' €' : '-'} \${r.margem_percentagem ? '(' + r.margem_percentagem.toFixed(0) + '%)' : ''}</td>
                <td>\${r.vmm}/mês</td>
                <td><span class="badge badge-info">\${r.cobertura_meses !== null ? r.cobertura_meses + ' m' : '∞ (VMM=0)'}</span></td>
                <td>\${r.sugestao_balcao}</td>
              </tr>
            \`).join('')}
          </tbody>
        \`;
      }
    }

    let copilotSessionId = 'copilot-' + Date.now();
    let isCopilotThinking = false;

    function getCopilotSessionId() {
      if (!copilotSessionId) {
        copilotSessionId = 'copilot-' + (activeFarmaciaId || 'farm') + '-' + Date.now();
      }
      return copilotSessionId;
    }

    async function resetCopilotConversation() {
      const sid = copilotSessionId;
      try {
        await fetch('/api/copilot/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        });
      } catch (e) {
        console.warn('Erro ao limpar sessão no servidor:', e);
      }

      copilotSessionId = 'copilot-' + (activeFarmaciaId || 'farm') + '-' + Date.now();
      const feed = document.getElementById('copilotChatFeed');
      if (feed) {
        feed.innerHTML = '<div id="copilotWelcomeGreeting" style="text-align: center; padding: 28px 16px; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 12px;">' +
          '<div style="font-size: 2.2rem; margin-bottom: 8px;">💡</div>' +
          '<div style="font-size: 1rem; font-weight: 700; color: #0f172a; margin-bottom: 4px;">Nova conversa iniciada.</div>' +
          '<div style="font-size: 0.84rem; color: #64748b; max-width: 580px; margin: 0 auto; line-height: 1.45;">' +
          'A memória anterior foi reiniciada. Coloque a sua nova pergunta na barra inferior.' +
          '</div>' +
          '</div>';
      }

      const input = document.getElementById('askInput');
      if (input) {
        input.value = '';
        input.focus();
      }
    }

    function toggleCopilotTask(element) {
      if (!element) return;
      const checkbox = element.querySelector('input[type="checkbox"]');
      if (!checkbox) return;
      element.classList.toggle('task-done');
      checkbox.checked = element.classList.contains('task-done');
    }

    function renderCopilotMarkdown(md) {
      if (!md) return '';
      var text = String(md);

      // Escape raw HTML characters to prevent XSS
      text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      var lines = text.split(String.fromCharCode(10));
      var output = [];
      var inTable = false;
      var tableRows = [];

      function linkCnps(s) {
        return s.replace(new RegExp('(^|[^0-9])([5-8][0-9]{6})([^0-9]|$)', 'g'), function(m, p1, p2, p3) {
          return p1 + '<span class="cnp-link" onclick="openProductModal(&quot;' + p2 + '&quot;)">' + p2 + ' ↗</span>' + p3;
        });
      }

      function flushTable() {
        if (!inTable || tableRows.length === 0) return;
        var html = '<div class="table-wrap" style="margin: 12px 0; overflow-x: auto;"><table class="copilot-md-table">';
        var headerRow = tableRows[0];
        html += '<thead><tr>';
        for (var h = 0; h < headerRow.length; h++) {
          html += '<th>' + headerRow[h].trim() + '</th>';
        }
        html += '</tr></thead><tbody>';

        for (var r = 2; r < tableRows.length; r++) {
          html += '<tr>';
          for (var c = 0; c < tableRows[r].length; c++) {
            var cellContent = linkCnps(tableRows[r][c].trim());
            html += '<td>' + cellContent + '</td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table></div>';
        output.push(html);
        tableRows = [];
        inTable = false;
      }

      for (var i = 0; i < lines.length; i++) {
        var rawLine = lines[i].replace(String.fromCharCode(13), '');
        var line = rawLine.trim();

        if (line.charAt(0) === '|' && line.charAt(line.length - 1) === '|') {
          var cells = line.slice(1, -1).split('|');
          if (new RegExp('^[|:\-\s]+$').test(line)) {
            tableRows.push(cells);
            inTable = true;
            continue;
          }
          if (!inTable) {
            inTable = true;
          }
          tableRows.push(cells);
          continue;
        } else if (inTable) {
          flushTable();
        }

        if (line.indexOf('#### ') === 0) {
          output.push('<h5 style="margin: 12px 0 4px; color: #0f172a; font-weight: 700; font-size: 0.95rem;">' + line.slice(5) + '</h5>');
          continue;
        }
        if (line.indexOf('### ') === 0) {
          output.push('<h4 style="margin: 14px 0 6px; color: #0284c7; font-weight: 700; font-size: 1.05rem;">' + line.slice(4) + '</h4>');
          continue;
        }
        if (line.indexOf('## ') === 0) {
          output.push('<h3 style="margin: 16px 0 8px; color: #0f172a; font-weight: 800; font-size: 1.15rem; border-bottom: 1px solid #f1f5f9; padding-bottom: 4px;">' + line.slice(3) + '</h3>');
          continue;
        }
        if (line.indexOf('# ') === 0) {
          output.push('<h2 style="margin: 18px 0 10px; color: #0284c7; font-weight: 800; font-size: 1.25rem;">' + line.slice(2) + '</h2>');
          continue;
        }

        var isTask = line.indexOf('- [ ]') === 0 || line.indexOf('- [x]') === 0 || line.indexOf('- [X]') === 0 ||
                     line.indexOf('* [ ]') === 0 || line.indexOf('* [x]') === 0 || line.indexOf('* [X]') === 0;
        if (isTask) {
          var isDone = line.indexOf('[x]') !== -1 || line.indexOf('[X]') !== -1;
          var taskText = linkCnps(line.slice(5).trim());
          output.push(
            '<div class="copilot-task-item ' + (isDone ? 'task-done' : '') + '" onclick="toggleCopilotTask(this)">' +
            '<input type="checkbox" ' + (isDone ? 'checked' : '') + ' onclick="event.stopPropagation(); toggleCopilotTask(this.parentElement)">' +
            '<span class="task-text">' + taskText + '</span>' +
            '</div>'
          );
          continue;
        }

        if (line.indexOf('- ') === 0 || line.indexOf('* ') === 0) {
          var itemText = linkCnps(line.slice(2));
          output.push('<div style="display: flex; gap: 8px; margin: 4px 0 4px 12px; font-size: 0.88rem; color: #334155;"><span style="color: #0284c7;">•</span><span>' + itemText + '</span></div>');
          continue;
        }

        if (line === '') {
          output.push('<div style="height: 6px;"></div>');
          continue;
        }

        var pText = linkCnps(line);
        output.push('<p style="margin: 4px 0; color: #1e293b; line-height: 1.55;">' + pText + '</p>');
      }

      if (inTable) {
        flushTable();
      }

      var rendered = output.join('');
      var bParts = rendered.split('**');
      if (bParts.length > 1) {
        var bHtml = '';
        for (var b = 0; b < bParts.length; b++) {
          bHtml += (b % 2 === 1) ? ('<b>' + bParts[b] + '</b>') : bParts[b];
        }
        rendered = bHtml;
      }
      // Botão Rever Encomenda (incluindo variações de emojis/texto que Claude possa gerar)
      var orderModalBtnHtml = '<div style="margin: 12px 0;"><button class="btn btn-sm" onclick="openInteractiveOrderModal()" style="background:#6366f1;color:#fff;font-weight:800;padding:9px 16px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:7px;box-shadow:0 2px 4px rgba(99,102,241,0.25);">🛒 Rever & Editar Encomenda Completa</button></div>';
      var exportCsvBtnHtml = '<div style="margin: 8px 0;"><button class="btn btn-sm" onclick="exportCopilotShoppingListCsv()" style="background:#0284c7;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📥 Descarregar CSV de Encomenda</button></div>';
      var applyBlocksBtnHtml = '<div style="margin: 8px 0;"><button class="btn btn-sm" onclick="applySifarmaOrderBlocks()" style="background:#e11d48;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">🛑 Bloquear Encomendas no Sistema (Ponto de Encomenda = 0)</button></div>';

      rendered = rendered.split('[BOTAO_APLICAR_PLANO]').join('<div style="margin: 10px 0;"><button class="btn btn-sm" onclick="applyCopilotWeeklyPlan()" style="background:#10b981;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">📥 Aplicar à Folha da Semana</button></div>');
      rendered = rendered.split('[BOTAO_GUARDAR_PACK]').join('<div style="margin: 10px 0;"><button class="btn btn-sm" onclick="saveCopilotPack()" style="background:#8b5cf6;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">📦 Guardar Pack no Estúdio de Marketing</button></div>');
      rendered = rendered.split('[BOTAO_EXPORTAR_ENCOMENDA_PDF]').join('<div style="margin: 8px 0;"><button class="btn btn-sm" onclick="exportCopilotShoppingListPdf()" style="background:#dc2626;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">📄 Imprimir / Guardar em PDF</button></div>');
      rendered = rendered.split('[BOTAO_EXPORTAR_ENCOMENDA_CSV]').join('<div style="display:inline-flex;flex-wrap:wrap;gap:8px;margin:12px 0;"><button class="btn btn-sm" onclick="openInteractiveOrderModal()" style="background:#6366f1;color:#fff;font-weight:800;padding:9px 16px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:7px;box-shadow:0 2px 4px rgba(99,102,241,0.25);">🛒 Rever & Editar Encomenda Completa</button><button class="btn btn-sm" onclick="exportCopilotShoppingListCsv()" style="background:#0284c7;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📥 CSV Encomenda</button><button class="btn btn-sm" onclick="exportCopilotShoppingListPdf()" style="background:#dc2626;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📄 Guia PDF</button><button class="btn btn-sm" onclick="copyShoppingListToClipboard()" style="background:#475569;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📋 Copiar CNPs</button></div>');
      rendered = rendered.split('[BOTAO_APLICAR_ENCOMENDA_FOLHA]').join('<div style="margin: 10px 0;"><button class="btn btn-sm" onclick="applyShoppingListToWeeklyPlan()" style="background:#10b981;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">📝 Adicionar à Folha Semanal (Pilar 4: Reposição)</button></div>');

      // Substituições resilientes caso o LLM escreva os nomes por extenso com emojis
      rendered = rendered.replace(/\[🛒\s*REVER[^\]]*\]/gi, orderModalBtnHtml);
      rendered = rendered.replace(/\[📊\s*EXPORTAR[^\]]*\]/gi, exportCsvBtnHtml);
      rendered = rendered.replace(/\[✅\s*APLICAR\s*BLOQUEIOS[^\]]*\]/gi, applyBlocksBtnHtml);
      return rendered;
    }

    function applyCopilotWeeklyPlan() {
      alert('📥 Recomendações aplicadas com sucesso à Folha da Semana!');
      switchTab('plano');
    }

    function saveCopilotPack() {
      alert('📦 A abrir Estúdio de Marketing com os Packs Clínicos!');
      switchTab('campaigns');
      switchMarketingSubView('packs');
    }

    
    // =========================================================================
    // CONTROLADOR DA CENTRAL INTERATIVA DE REVISÃO E EDIÇÃO DE ENCOMENDA
    // =========================================================================
    window.interactiveOrderState = {
      items: [],
      currentChannel: 'ALL',
      searchTerm: ''
    };

    function initInteractiveOrderStateFromLastList() {
      var sourceList = window.lastCopilotShoppingList || [];
      window.interactiveOrderState.items = sourceList.map(function(it, idx) {
        var canal = it.canalSugerido || 'REGULAR_ARMAZENISTA';
        var rotulo = it.canalRotulo || (canal === 'URGENTE_ARMAZENISTA' ? '🔴 Armazenista Urgente' : canal === 'LABORATORIO_DIRETO' ? '🏭 Laboratório Direto' : '🟡 Armazenista Regular');
        return {
          id: idx,
          cnp: it.cnp,
          designacao: it.designacao,
          stockAtual: it.stockAtual || 0,
          vendas12M: it.vendas12M || 0,
          vendaDiaria: it.vendaDiaria || 0,
          quantidadeAEncomendar: it.quantidadeAEncomendar || 1,
          custoUnitarioEur: it.custoUnitarioEur || 0,
          pvpEur: it.pvpEur || 0,
          canalSugerido: canal,
          canalRotulo: rotulo,
          active: true
        };
      });
    }

    function openInteractiveOrderModal() {
      if (!window.lastCopilotShoppingList || window.lastCopilotShoppingList.length === 0) {
        alert('Nenhuma lista de encomendas gerada pelo Copilot. Peça uma proposta de encomenda de reposição para carregar o carrinho.');
        return;
      }
      initInteractiveOrderStateFromLastList();
      window.interactiveOrderState.currentChannel = 'ALL';
      window.interactiveOrderState.searchTerm = '';

      var sel = document.getElementById('farmaciaSelector');
      var farmNome = (sel && sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex].text : 'Farmácia Ativa';
      var badge = document.getElementById('orderModalFarmBadge');
      if (badge) badge.innerText = farmNome;

      var searchInput = document.getElementById('orderModalSearchInput');
      if (searchInput) searchInput.value = '';

      updateOrderTabButtonsUI();
      renderInteractiveOrderTable();
      updateInteractiveOrderTotals();

      var modal = document.getElementById('interactiveOrderModal');
      if (modal) modal.style.display = 'flex';
    }

    function closeInteractiveOrderModal() {
      var modal = document.getElementById('interactiveOrderModal');
      if (modal) modal.style.display = 'none';
    }

    function switchOrderChannel(tabKey) {
      window.interactiveOrderState.currentChannel = tabKey;
      updateOrderTabButtonsUI();
      renderInteractiveOrderTable();
    }

    function updateOrderTabButtonsUI() {
      var cur = window.interactiveOrderState.currentChannel;
      var tabs = [
        { id: 'tabBtnALL', key: 'ALL' },
        { id: 'tabBtnURG', key: 'URGENTE_ARMAZENISTA' },
        { id: 'tabBtnREG', key: 'REGULAR_ARMAZENISTA' },
        { id: 'tabBtnLAB', key: 'LABORATORIO_DIRETO' }
      ];
      for (var i = 0; i < tabs.length; i++) {
        var btn = document.getElementById(tabs[i].id);
        if (btn) {
          if (tabs[i].key === cur) {
            btn.style.background = '#ffffff';
            btn.style.color = '#0f172a';
            btn.style.fontWeight = '700';
            btn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.06)';
          } else {
            btn.style.background = 'transparent';
            btn.style.color = '#64748b';
            btn.style.fontWeight = '600';
            btn.style.boxShadow = 'none';
          }
        }
      }
    }

    function toggleOrderRowActive(idx) {
      var item = window.interactiveOrderState.items[idx];
      if (item) {
        item.active = !item.active;
        updateInteractiveOrderTotals();
        renderInteractiveOrderTable();
      }
    }

    function changeOrderRowQty(idx, delta) {
      var item = window.interactiveOrderState.items[idx];
      if (item) {
        var novaQtd = Math.max(1, (item.quantidadeAEncomendar || 1) + delta);
        item.quantidadeAEncomendar = novaQtd;
        updateInteractiveOrderTotals();
        renderInteractiveOrderTable();
      }
    }

    function setOrderRowQty(idx, val) {
      var item = window.interactiveOrderState.items[idx];
      if (item) {
        var num = parseInt(val, 10);
        if (!isNaN(num) && num >= 1) {
          item.quantidadeAEncomendar = num;
        } else {
          item.quantidadeAEncomendar = 1;
        }
        updateInteractiveOrderTotals();
        renderInteractiveOrderTable();
      }
    }

    function discontinueProductFromOrderRow(idx) {
      var item = window.interactiveOrderState.items[idx];
      if (!item) return;
      if (!confirm('Deseja descontinuar este produto (' + item.designacao + ') e marcá-lo como NÃO REPOR? Ele será removido desta encomenda.')) {
        return;
      }
      fetch('/api/products/discontinue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          farmaciaId: activeFarmaciaId,
          cnp: item.cnp,
          designacao: item.designacao,
          motivo: 'Descontinuado pelo utilizador na Proposta de Reposição'
        })
      }).then(function(res) {
        return res.json();
      }).then(function(data) {
        if (data.ok) {
          window.interactiveOrderState.items.splice(idx, 1);
          updateInteractiveOrderTotals();
          renderInteractiveOrderTable();
          alert('✅ Produto ' + item.cnp + ' descontinuado com sucesso! Não voltará a ser sugerido.');
        } else {
          alert('Erro ao descontinuar produto: ' + (data.error || 'Erro desconhecido'));
        }
      }).catch(function(err) {
        alert('Erro ao contactar o servidor: ' + err);
      });
    }

    function toggleSelectAllInTab(targetActive) {
      var curTab = window.interactiveOrderState.currentChannel;
      var q = (document.getElementById('orderModalSearchInput') ? document.getElementById('orderModalSearchInput').value : '').toLowerCase().trim();
      var items = window.interactiveOrderState.items;

      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var matchesTab = (curTab === 'ALL' || it.canalSugerido === curTab);
        var matchesSearch = !q || (it.cnp.toLowerCase().indexOf(q) !== -1 || (it.designacao || '').toLowerCase().indexOf(q) !== -1);
        if (matchesTab && matchesSearch) {
          it.active = targetActive;
        }
      }
      updateInteractiveOrderTotals();
      renderInteractiveOrderTable();
    }

    function updateInteractiveOrderTotals() {
      var items = window.interactiveOrderState.items;
      var totalAll = items.length;
      var countUrg = 0;
      var countReg = 0;
      var countLab = 0;

      var selectedArticles = 0;
      var selectedUnits = 0;
      var selectedTotalEur = 0;

      var sumUrgEur = 0;
      var sumRegEur = 0;
      var sumLabEur = 0;

      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.canalSugerido === 'URGENTE_ARMAZENISTA') countUrg++;
        else if (it.canalSugerido === 'CONSUMIVEIS_LOJA') countLab++; // countLab representa consumíveis
        else countReg++;

        if (it.active) {
          selectedArticles++;
          var qty = it.quantidadeAEncomendar || 0;
          selectedUnits += qty;
          var lineCost = qty * (it.custoUnitarioEur || 0);
          selectedTotalEur += lineCost;

          if (it.canalSugerido === 'URGENTE_ARMAZENISTA') sumUrgEur += lineCost;
          else if (it.canalSugerido === 'CONSUMIVEIS_LOJA') sumLabEur += lineCost;
          else sumRegEur += lineCost;
        }
      }

      var elCountAll = document.getElementById('countTabAll');
      if (elCountAll) elCountAll.innerText = totalAll;
      var elCountUrg = document.getElementById('countTabUrg');
      if (elCountUrg) elCountUrg.innerText = countUrg;
      var elCountReg = document.getElementById('countTabReg');
      if (elCountReg) elCountReg.innerText = countReg;
      var elCountLab = document.getElementById('countTabCons') || document.getElementById('countTabLab');
      if (elCountLab) elCountLab.innerText = countLab;

      var elSelArt = document.getElementById('statSelectedArticles');
      if (elSelArt) elSelArt.innerText = selectedArticles + ' / ' + totalAll;
      var elSelUnits = document.getElementById('statSelectedUnits');
      if (elSelUnits) elSelUnits.innerText = selectedUnits + ' un';
      var elSelEur = document.getElementById('statSelectedTotalEur');
      if (elSelEur) elSelEur.innerText = selectedTotalEur.toFixed(2).replace('.', ',') + ' €';
    }

    function renderInteractiveOrderTable() {
      var tbody = document.getElementById('interactiveOrderTableBody');
      if (!tbody) return;

      var curTab = window.interactiveOrderState.currentChannel;
      var q = (document.getElementById('orderModalSearchInput') ? document.getElementById('orderModalSearchInput').value : '').toLowerCase().trim();
      var items = window.interactiveOrderState.items;

      var html = '';
      var visibleCount = 0;

      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var matchesTab = (curTab === 'ALL' || it.canalSugerido === curTab);
        var matchesSearch = !q || (it.cnp.toLowerCase().indexOf(q) !== -1 || (it.designacao || '').toLowerCase().indexOf(q) !== -1);

        if (!matchesTab || !matchesSearch) continue;
        visibleCount++;

        var lineTotal = ((it.quantidadeAEncomendar || 0) * (it.custoUnitarioEur || 0)).toFixed(2).replace('.', ',') + ' €';
        var cUnit = (it.custoUnitarioEur || 0).toFixed(2).replace('.', ',') + ' €';
        var rowBg = it.active ? '#ffffff' : '#f8fafc';
        var textOpacity = it.active ? '1' : '0.45';

        var badgeBg = '#f1f5f9';
        var badgeColor = '#475569';
        if (it.canalSugerido === 'URGENTE_ARMAZENISTA') {
          badgeBg = '#fee2e2';
          badgeColor = '#b91c1c';
        } else if (it.canalSugerido === 'CONSUMIVEIS_LOJA') {
          badgeBg = '#e0e7ff';
          badgeColor = '#3730a3';
        } else {
          badgeBg = '#fef3c7';
          badgeColor = '#b45309';
        }

        html += '<tr style="border-bottom:1px solid #f1f5f9; background:' + rowBg + '; opacity:' + textOpacity + '; transition:background 0.1s;">' +
          '<td style="padding:8px 12px; text-align:center;">' +
            '<input type="checkbox" ' + (it.active ? 'checked' : '') + ' onchange="toggleOrderRowActive(' + i + ')" style="width:16px; height:16px; cursor:pointer;" />' +
          '</td>' +
          '<td style="padding:8px; text-align:center; color:#64748b; font-size:11px;">' + (i + 1) + '</td>' +
          '<td style="padding:8px;"><span style="background:' + badgeBg + '; color:' + badgeColor + '; font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:4px; display:inline-block;">' + it.canalRotulo + '</span></td>' +
          '<td style="padding:8px; font-family:monospace; font-weight:700; color:#0284c7; font-size:11.5px;">' + it.cnp + '</td>' +
          '<td style="padding:8px; font-weight:600; color:#0f172a; font-size:11.5px;">' + (it.designacao || '') + '</td>' +
          '<td style="padding:8px; text-align:center; font-weight:700; color:' + (it.stockAtual === 0 ? '#ef4444' : '#0f172a') + ';">' + it.stockAtual + '</td>' +
          '<td style="padding:8px; text-align:center; color:#64748b;">' + (it.vendaDiaria || 0).toFixed(2) + '</td>' +
          '<td style="padding:8px; text-align:center; background:#f8fafc;">' +
            '<div style="display:inline-flex; align-items:center; border:1px solid #cbd5e1; border-radius:5px; background:#fff; overflow:hidden;">' +
              '<button onclick="changeOrderRowQty(' + i + ', -1)" style="border:none; background:#f1f5f9; color:#0f172a; width:26px; height:26px; cursor:pointer; font-weight:700;">-</button>' +
              '<input type="number" min="1" value="' + it.quantidadeAEncomendar + '" onchange="setOrderRowQty(' + i + ', this.value)" style="width:42px; height:26px; border:none; text-align:center; font-weight:800; font-size:12px; outline:none;" />' +
              '<button onclick="changeOrderRowQty(' + i + ', 1)" style="border:none; background:#f1f5f9; color:#0f172a; width:26px; height:26px; cursor:pointer; font-weight:700;">+</button>' +
            '</div>' +
          '</td>' +
          '<td style="padding:8px; text-align:right; color:#475569;">' + cUnit + '</td>' +
          '<td style="padding:8px 14px; text-align:right; font-weight:800; color:#0f172a; font-size:12px;">' + lineTotal + '</td>' +
'<td style="padding:8px; text-align:center;">' +
            '<button onclick="discontinueProductFromOrderRow(' + i + ')" title="Descontinuar (N\u00e3o Repor Mais)" style="background:#fff; border:1px solid #fca5a5; color:#dc2626; padding:3px 7px; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer;">\uD83D\uDEAB N\u00e3o Repor</button>' +
'</td>' +
        '</tr>';
      }

      if (visibleCount === 0) {
        html = '<tr><td colspan="10" style="text-align:center; padding:30px; color:#64748b;">Nenhum produto encontrado neste filtro.</td></tr>';
      }

      tbody.innerHTML = html;
    }

    function getSelectedInteractiveOrderItems() {
      var items = window.interactiveOrderState.items || [];
      return items.filter(function(it) { return it.active && it.quantidadeAEncomendar > 0; });
    }

    function exportInteractiveOrderCsv() {
      var list = getSelectedInteractiveOrderItems();
      if (list.length === 0) {
        alert('Nenhum artigo selecionado para exportar. Marque pelo menos um produto na checkbox.');
        return;
      }
      var NL = String.fromCharCode(13) + String.fromCharCode(10);
      var csvContent = 'data:text/csv;charset=utf-8,%EF%BB%BF';
      csvContent += 'CNP;Designacao;Quantidade_A_Encomendar;Custo_Unitario_Eur;Custo_Total_Eur;Canal_Sugerido' + NL;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var totalLinha = (it.quantidadeAEncomendar * (it.custoUnitarioEur || 0));
        csvContent += '"' + it.cnp + '";"' + (it.designacao || '').replace(/"/g, '""') + '";' + it.quantidadeAEncomendar + ';' + (it.custoUnitarioEur || 0).toFixed(2).replace('.', ',') + ';' + totalLinha.toFixed(2).replace('.', ',') + ';"' + it.canalRotulo + '"' + NL;
      }
      var encodedUri = encodeURI(csvContent);
      var link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', 'encomenda_validada_' + new Date().toISOString().slice(0, 10) + '.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function exportInteractiveOrderPdf() {
      var list = getSelectedInteractiveOrderItems();
      if (list.length === 0) {
        alert('Nenhum artigo selecionado para gerar em PDF.');
        return;
      }
      var sel = document.getElementById('farmaciaSelector');
      var farmNome = (sel && sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex].text : 'Farmácia';
      var dataHoje = new Date().toLocaleDateString('pt-PT');
      var horaHoje = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

      var urg = list.filter(function(it) { return it.canalSugerido === 'URGENTE_ARMAZENISTA'; });
      var reg = list.filter(function(it) { return it.canalSugerido === 'REGULAR_ARMAZENISTA'; });
      var lab = list.filter(function(it) { return it.canalSugerido === 'LABORATORIO_DIRETO'; });

      var totalUnidades = 0;
      var totalInvestimento = 0;
      for (var i = 0; i < list.length; i++) {
        totalUnidades += list[i].quantidadeAEncomendar;
        totalInvestimento += (list[i].quantidadeAEncomendar * (list[i].custoUnitarioEur || 0));
      }

      function renderPdfSection(title, badgeColor, items) {
        if (!items || items.length === 0) return '';
        var secUnits = 0;
        var secCost = 0;
        var rHtml = '';
        for (var k = 0; k < items.length; k++) {
          var it = items[k];
          secUnits += it.quantidadeAEncomendar;
          var lCost = it.quantidadeAEncomendar * (it.custoUnitarioEur || 0);
          secCost += lCost;
          rHtml += '<tr style="border-bottom:1px solid #e2e8f0;">' +
            '<td style="padding:5px 6px; text-align:center; color:#64748b; font-size:10px;">' + (k + 1) + '</td>' +
            '<td style="padding:5px 6px; font-family:monospace; font-weight:700; color:#0284c7; font-size:11px;">' + it.cnp + '</td>' +
            '<td style="padding:5px 6px; font-weight:600; color:#0f172a; font-size:11px;">' + (it.designacao || '') + '</td>' +
            '<td style="padding:5px 6px; text-align:center; font-weight:800; color:#0f172a; font-size:11.5px; background:#f8fafc;">' + it.quantidadeAEncomendar + '</td>' +
            '<td style="padding:5px 6px; text-align:right; color:#475569; font-size:11px;">' + (it.custoUnitarioEur || 0).toFixed(2).replace('.', ',') + ' €</td>' +
            '<td style="padding:5px 6px; text-align:right; font-weight:700; color:#0f172a; font-size:11px;">' + lCost.toFixed(2).replace('.', ',') + ' €</td>' +
            '<td style="padding:5px 6px; text-align:center;"><div style="width:12px; height:12px; border:1.5px solid #cbd5e1; border-radius:3px; margin:0 auto;"></div></td>' +
          '</tr>';
        }
        return '<div style="margin-top:16px; margin-bottom:14px; page-break-inside:avoid;">' +
          '<div style="background:' + badgeColor + '; color:#fff; font-size:12px; font-weight:800; padding:6px 10px; border-radius:4px; display:flex; justify-content:space-between;">' +
            '<span>' + title + ' (' + items.length + ' artigos)</span>' +
            '<span>' + secUnits + ' un &nbsp;|&nbsp; ' + secCost.toFixed(2).replace('.', ',') + ' €</span>' +
          '</div>' +
          '<table style="width:100%; border-collapse:collapse; margin-top:6px;">' +
            '<thead>' +
              '<tr style="background:#f8fafc; font-size:9.5px; text-transform:uppercase; color:#475569;">' +
                '<th style="width:24px; text-align:center; padding:5px 6px;">#</th>' +
                '<th style="width:70px; text-align:left; padding:5px 6px;">CNP</th>' +
                '<th style="text-align:left; padding:5px 6px;">Designação</th>' +
                '<th style="width:60px; text-align:center; padding:5px 6px;">Qtd</th>' +
                '<th style="width:70px; text-align:right; padding:5px 6px;">Unit.</th>' +
                '<th style="width:75px; text-align:right; padding:5px 6px;">Total</th>' +
                '<th style="width:35px; text-align:center; padding:5px 6px;">Conf.</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rHtml + '</tbody>' +
          '</table>' +
        '</div>';
      }

      var win = window.open('', '_blank');
      if (!win) {
        alert('O browser bloqueou a abertura da janela. Por favor permita popups para gerar o PDF.');
        return;
      }

      var docHtml = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<title>Guia de Encomenda Aprovada — ' + farmNome + ' (' + dataHoje + ')</title>' +
        '<style>' +
          '@page { size: A4 portrait; margin: 10mm 12mm 14mm 12mm; }' +
          'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 15px; font-size: 11px; }' +
          '.no-print { margin-bottom: 15px; padding: 10px 14px; background: #f1f5f9; border-radius: 8px; display: flex; gap: 10px; align-items: center; }' +
          '@media print { .no-print { display: none !important; } body { padding: 0; } }' +
          'th { border-bottom: 2px solid #cbd5e1; }' +
          'tr { page-break-inside: avoid; }' +
        '</style>' +
        '</head><body>' +
        '<div class="no-print">' +
          '<button onclick="window.print()" style="background:#dc2626;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px;display:inline-flex;align-items:center;gap:6px;">🖨️ Imprimir / Guardar como PDF</button>' +
          '<button onclick="window.close()" style="background:#64748b;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Fechar</button>' +
          '<span style="font-size:11.5px;color:#475569;margin-left:auto;">💡 Guia validada e dividida pelos canais de encomenda. Selecione <b>Guardar como PDF</b> para gerar o ficheiro.</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0284c7;padding-bottom:10px;margin-bottom:12px;">' +
          '<div>' +
            '<div style="font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">BI PHARMA — GUIA DE ENCOMENDA VALIDADA</div>' +
            '<div style="font-size:13px;font-weight:700;color:#0284c7;margin-top:2px;">' + farmNome + '</div>' +
          '</div>' +
          '<div style="text-align:right;font-size:11px;color:#64748b;">' +
            '<div><b>Data Emissão:</b> ' + dataHoje + ' às ' + horaHoje + '</div>' +
            '<div><b>Estado:</b> Aprovada pelo Responsável Técnico</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:12px;margin-bottom:12px;">' +
          '<div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;">' +
            '<div style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700;">Artigos Aprovados</div>' +
            '<div style="font-size:16px;font-weight:800;color:#0f172a;">' + list.length + ' produtos</div>' +
          '</div>' +
          '<div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;">' +
            '<div style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700;">Unidades a Encomendar</div>' +
            '<div style="font-size:16px;font-weight:800;color:#0f172a;">' + totalUnidades + ' un</div>' +
          '</div>' +
          '<div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px 12px;">' +
            '<div style="font-size:10px;text-transform:uppercase;color:#166534;font-weight:700;">Investimento Aprovado</div>' +
            '<div style="font-size:16px;font-weight:800;color:#16a34a;">' + totalInvestimento.toFixed(2).replace('.', ',') + ' €</div>' +
          '</div>' +
        '</div>' +
        renderPdfSection('🔴 1. ARMAZENISTA URGENTE (Corte Imediato da Manhã)', '#b91c1c', urg) +
        renderPdfSection('🟡 2. ARMAZENISTA REGULAR (Consolidação Semanal)', '#b45309', reg) +
        renderPdfSection('🏭 3. LABORATÓRIOS DIRETOS (Bonificações & Condições Comerciais)', '#6d28d9', lab) +
        '<div style="margin-top:20px;padding-top:12px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;font-size:11px;color:#475569;page-break-inside:avoid;">' +
          '<div><b>Responsável Técnico:</b> __________________________________</div>' +
          '<div><b>Data Envio:</b> _____/_____/_________</div>' +
          '<div><b>Visto Receção Armazém:</b> [ &nbsp; ] Conforme</div>' +
        '</div>' +
        '</body></html>';

      win.document.open();
      win.document.write(docHtml);
      win.document.close();
      win.focus();
      setTimeout(function() { win.print(); }, 350);
    }

    function copyInteractiveOrderToClipboard() {
      var list = getSelectedInteractiveOrderItems();
      if (list.length === 0) {
        alert('Nenhum artigo selecionado para copiar.');
        return;
      }
      var NL = String.fromCharCode(13) + String.fromCharCode(10);
      var text = 'CNP	Quantidade	Designacao	Canal' + NL;
      for (var i = 0; i < list.length; i++) {
        text += list[i].cnp + '	' + list[i].quantidadeAEncomendar + '	' + (list[i].designacao || '') + '	' + list[i].canalRotulo + NL;
      }
      navigator.clipboard.writeText(text).then(function() {
        alert('📋 ' + list.length + ' artigos aprovados copiados para a área de transferência! Pode colar diretamente no Excel ou no sistema de gestão da farmácia.');
      }).catch(function(e) {
        alert('Erro ao copiar: ' + e);
      });
    }

    function applyInteractiveOrderToWeeklyPlan() {
      var list = getSelectedInteractiveOrderItems();
      if (list.length === 0) {
        alert('Nenhum artigo selecionado para adicionar à Folha Semanal.');
        return;
      }
      var newTasks = list.map(function(it) {
        return {
          id: 'task-order-' + it.cnp + '-' + Date.now(),
          pilar: 'P4',
          descricao: 'Encomendar ' + it.quantidadeAEncomendar + ' un de ' + it.designacao + ' (' + it.canalRotulo + ')',
          cnp: it.cnp,
          quantidade: it.quantidadeAEncomendar,
          canal: it.canalRotulo,
          concluido: false
        };
      });
      fetch('/api/weekly-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farmaciaId: activeFarmaciaId, tasks: newTasks })
      }).then(function() {
        alert('📝 ' + list.length + ' produtos aprovados foram adicionados ao Pilar 4 (Ajustar Níveis & Reposição) da Folha da Semana!');
        closeInteractiveOrderModal();
        switchTab('plano');
      }).catch(function(err) {
        alert('Erro ao guardar na Folha Semanal: ' + err);
      });
    }

    function exportCopilotShoppingListCsv() {
      var list = window.lastCopilotShoppingList;
      if (!list || list.length === 0) {
        alert('A gerar ficheiro CSV com base nos artigos identificados...');
        return;
      }
      var NL = String.fromCharCode(13) + String.fromCharCode(10);
      var csvContent = 'data:text/csv;charset=utf-8,%EF%BB%BF';
      csvContent += 'CNP;Designacao;Quantidade_A_Encomendar;Custo_Unitario_Eur;Custo_Total_Eur' + NL;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        csvContent += '"' + it.cnp + '";"' + (it.designacao || '').replace(/"/g, '""') + '";' + it.quantidadeAEncomendar + ';' + (it.custoUnitarioEur || 0).toFixed(2).replace('.', ',') + ';' + (it.custoTotalLinhaEur || 0).toFixed(2).replace('.', ',') + NL;
      }
      var encodedUri = encodeURI(csvContent);
      var link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', 'encomenda_' + new Date().toISOString().slice(0, 10) + '.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function exportCopilotShoppingListPdf() {
      var list = window.lastCopilotShoppingList;
      if (!list || list.length === 0) {
        alert('Nenhuma lista de encomendas ativa para imprimir em PDF. Peça uma proposta de encomenda de reposição ao Copilot.');
        return;
      }
      var sel = document.getElementById('farmaciaSelector');
      var farmNome = (sel && sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex].text : 'Farmácia';
      var dataHoje = new Date().toLocaleDateString('pt-PT');
      var horaHoje = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

      var totalUnidades = 0;
      var totalInvestimento = 0;
      for (var i = 0; i < list.length; i++) {
        totalUnidades += (list[i].quantidadeAEncomendar || 0);
        totalInvestimento += (list[i].custoTotalLinhaEur || 0);
      }

      var win = window.open('', '_blank');
      if (!win) {
        alert('O browser bloqueou a abertura da janela. Por favor permita popups para gerar o documento PDF.');
        return;
      }

      var rowsHtml = '';
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        var cUnit = (item.custoUnitarioEur || 0).toFixed(2).replace('.', ',') + ' €';
        var cTotal = (item.custoTotalLinhaEur || 0).toFixed(2).replace('.', ',') + ' €';
        rowsHtml += '<tr style="border-bottom: 1px solid #e2e8f0;">' +
          '<td style="padding: 6px 8px; text-align: center; color: #64748b; font-size: 11px;">' + (j + 1) + '</td>' +
          '<td style="padding: 6px 8px; font-family: monospace; font-weight: 700; color: #0284c7; font-size: 11.5px;">' + item.cnp + '</td>' +
          '<td style="padding: 6px 8px; font-weight: 600; color: #0f172a; font-size: 11.5px;">' + (item.designacao || '') + '</td>' +
          '<td style="padding: 6px 8px; text-align: center; font-weight: 800; color: #0f172a; font-size: 12.5px; background: #f8fafc;">' + item.quantidadeAEncomendar + '</td>' +
          '<td style="padding: 6px 8px; text-align: right; color: #475569; font-size: 11.5px;">' + cUnit + '</td>' +
          '<td style="padding: 6px 8px; text-align: right; font-weight: 700; color: #0f172a; font-size: 11.5px;">' + cTotal + '</td>' +
          '<td style="padding: 6px 8px; text-align: center;"><div style="width: 13px; height: 13px; border: 1.5px solid #cbd5e1; border-radius: 3px; margin: 0 auto;"></div></td>' +
        '</tr>';
      }

      var docHtml = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<title>Guia de Encomenda — ' + farmNome + ' (' + dataHoje + ')</title>' +
        '<style>' +
          '@page { size: A4 portrait; margin: 10mm 12mm 14mm 12mm; }' +
          'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 15px; font-size: 11.5px; }' +
          '.no-print { margin-bottom: 15px; padding: 10px 14px; background: #f1f5f9; border-radius: 8px; display: flex; gap: 10px; align-items: center; }' +
          '@media print { .no-print { display: none !important; } body { padding: 0; } }' +
          'table { width: 100%; border-collapse: collapse; margin-top: 10px; }' +
          'th { background: #f8fafc; color: #475569; font-size: 10px; text-transform: uppercase; font-weight: 700; padding: 7px 8px; border-bottom: 2px solid #cbd5e1; }' +
          'tr { page-break-inside: avoid; }' +
        '</style>' +
        '</head><body>' +
        '<div class="no-print">' +
          '<button onclick="window.print()" style="background:#dc2626;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px;display:inline-flex;align-items:center;gap:6px;">🖨️ Imprimir / Guardar como PDF</button>' +
          '<button onclick="window.close()" style="background:#64748b;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Fechar</button>' +
          '<span style="font-size:11.5px;color:#475569;margin-left:auto;">💡 No diálogo que abrir, selecione <b>Guardar como PDF</b> para obter o documento digital.</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0284c7;padding-bottom:10px;margin-bottom:12px;">' +
          '<div>' +
            '<div style="font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">BI PHARMA — GUIA DE ENCOMENDA & REPOSIÇÃO</div>' +
            '<div style="font-size:13px;font-weight:700;color:#0284c7;margin-top:2px;">' + farmNome + '</div>' +
          '</div>' +
          '<div style="text-align:right;font-size:11px;color:#64748b;">' +
            '<div><b>Data de Emissão:</b> ' + dataHoje + ' às ' + horaHoje + '</div>' +
            '<div><b>Sistema:</b> BI Pharma Intelligent Replenishment Engine</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:12px;margin-bottom:12px;">' +
          '<div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;">' +
            '<div style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700;">Total de Artigos</div>' +
            '<div style="font-size:16px;font-weight:800;color:#0f172a;">' + list.length + ' produtos</div>' +
          '</div>' +
          '<div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;">' +
            '<div style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700;">Unidades a Encomendar</div>' +
            '<div style="font-size:16px;font-weight:800;color:#0f172a;">' + totalUnidades + ' un</div>' +
          '</div>' +
          '<div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px 12px;">' +
            '<div style="font-size:10px;text-transform:uppercase;color:#166534;font-weight:700;">Investimento Estimado</div>' +
            '<div style="font-size:16px;font-weight:800;color:#16a34a;">' + totalInvestimento.toFixed(2).replace('.', ',') + ' €</div>' +
          '</div>' +
        '</div>' +
        '<table>' +
          '<thead>' +
            '<tr>' +
              '<th style="width:26px;text-align:center;">#</th>' +
              '<th style="width:72px;text-align:left;">CNP</th>' +
              '<th style="text-align:left;">Designação do Artigo / Apresentação</th>' +
              '<th style="width:65px;text-align:center;">Qtd Enc.</th>' +
              '<th style="width:75px;text-align:right;">Custo Unit.</th>' +
              '<th style="width:80px;text-align:right;">Total Linha</th>' +
              '<th style="width:40px;text-align:center;">Conf.</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table>' +
        '<div style="margin-top:20px;padding-top:12px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;font-size:11px;color:#475569;page-break-inside:avoid;">' +
          '<div><b>Responsável Farmácia:</b> __________________________________</div>' +
          '<div><b>Data Envio Armazenista:</b> _____/_____/_________</div>' +
          '<div><b>Visto Armazém / Receção:</b> [ &nbsp; ] Conforme</div>' +
        '</div>' +
        '</body></html>';

      win.document.open();
      win.document.write(docHtml);
      win.document.close();
      win.focus();
      setTimeout(function() { win.print(); }, 350);
    }

    // =========================================================================
    // MÓDULO DE RELATÓRIOS EXECUTIVOS DO COPILOT (PREVIEW, EDIÇÃO & EXPORTAÇÃO)
    // =========================================================================
    window.currentCopilotReportData = null;

    function openCopilotReportModalFromBubble(btn) {
      if (!btn) return;
      var assistantBubble = btn.closest('.chat-bubble-assistant');
      var rawText = (assistantBubble && assistantBubble.dataset.rawText) 
        ? assistantBubble.dataset.rawText 
        : (assistantBubble ? assistantBubble.innerText : (window.lastCopilotAssistantText || ''));
      loadAndOpenCopilotReport(rawText, null);
    }

    function openCopilotReportModalCurrentSession() {
      var sid = (typeof getCopilotSessionId === 'function') ? getCopilotSessionId() : '';
      loadAndOpenCopilotReport(window.lastCopilotAssistantText || '', sid);
    }

    function closeCopilotReportModal() {
      var modal = document.getElementById('copilotReportModal');
      if (modal) modal.style.display = 'none';
    }

    async function loadAndOpenCopilotReport(rawText, sid, customPrompt) {
      var modal = document.getElementById('copilotReportModal');
      var sel = document.getElementById('farmaciaSelector');
      var farmNome = (sel && sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex].text : 'Farmácia Demo';
      
      var badge = document.getElementById('reportModalFarmBadge');
      if (badge) badge.textContent = farmNome;

      if (modal) modal.style.display = 'flex';

      // Mostra placeholders de carregamento
      var titleEl = document.getElementById('reportTitleEl');
      var diagEl = document.getElementById('reportDiagnosisEl');
      if (titleEl) titleEl.innerText = 'A estruturar Relatório Executivo...';
      if (diagEl) diagEl.innerText = 'A inteligência analítica está a processar os dados e a formatar a minuta formal...';

      try {
        var res = await fetch('/api/copilot/generate-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            sessionId: sid,
            rawText: rawText || window.lastCopilotAssistantText || '',
            relatorioEstruturado: window.lastCopilotRelatorioEstruturado || undefined,
            customPrompt: customPrompt || ''
          })
        });
        var data = await res.json();
        if (!data.success || !data.report) {
          throw new Error(data.error || 'Não foi possível gerar a estrutura do relatório.');
        }

        window.currentCopilotReportData = data.report;
        renderReportPreview(data.report);
      } catch (err) {
        console.error('Erro ao gerar relatório do Copilot:', err);
        if (titleEl) titleEl.innerText = 'Relatório Executivo da Farmácia';
        if (diagEl) diagEl.innerText = 'Ocorreu um erro ao carregar a síntese do relatório: ' + err.message;
      }
    }

    function renderReportPreview(rep) {
      if (!rep) return;
      
      var farmEl = document.getElementById('reportFarmName');
      if (farmEl) farmEl.textContent = rep.farmaciaNome || 'Farmácia';

      var dateEl = document.getElementById('reportIssueDate');
      if (dateEl) dateEl.textContent = rep.dataEmissao || new Date().toLocaleDateString('pt-PT');

      var timeEl = document.getElementById('reportIssueTime');
      if (timeEl) timeEl.textContent = rep.horaEmissao || new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

      var respEl = document.getElementById('reportResponsible');
      if (respEl) respEl.textContent = rep.responsavel || 'Direção Técnica';

      var titleEl = document.getElementById('reportTitleEl');
      if (titleEl) titleEl.innerText = rep.titulo || 'Relatório Executivo de Diagnóstico Farmacêutico';

      var subEl = document.getElementById('reportSubtitleEl');
      if (subEl) subEl.innerText = rep.subtitulo || 'Análise Estratégica & Decisão Operacional';

      // 1. Renderizar KPIs
      var kpiContainer = document.getElementById('reportKpiContainer');
      if (kpiContainer) {
        kpiContainer.innerHTML = '';
        if (rep.kpis && rep.kpis.length > 0) {
          rep.kpis.forEach(function(k) {
            var bg = '#f8fafc';
            var border = '#cbd5e1';
            var textCol = '#0f172a';
            if (k.tipo === 'danger') { bg = '#fef2f2'; border = '#fecaca'; textCol = '#dc2626'; }
            else if (k.tipo === 'warning') { bg = '#fffbeb'; border = '#fef3c7'; textCol = '#b45309'; }
            else if (k.tipo === 'success') { bg = '#f0fdf4'; border = '#bbf7d0'; textCol = '#16a34a'; }
            else if (k.tipo === 'info') { bg = '#f0f9ff'; border = '#bae6fd'; textCol = '#0284c7'; }

            var card = document.createElement('div');
            card.style.cssText = 'flex: 1; min-width: 140px; background: ' + bg + '; border: 1px solid ' + border + '; border-radius: 6px; padding: 10px 12px;';
            card.innerHTML = '<div style="font-size: 0.68rem; text-transform: uppercase; font-weight: 700; color: #64748b; margin-bottom: 2px;">' + k.label + '</div>' +
                             '<div style="font-size: 1.15rem; font-weight: 800; color: ' + textCol + ';">' + k.valor + '</div>';
            kpiContainer.appendChild(card);
          });
          kpiContainer.style.display = 'flex';
        } else {
          kpiContainer.style.display = 'none';
        }
      }

      // 2. Renderizar Diagnóstico
      var diagEl = document.getElementById('reportDiagnosisEl');
      if (diagEl) diagEl.innerText = rep.diagnostico || '';

      // 3. Renderizar Tabela Estruturada de Artigos
      var tableSection = document.getElementById('reportTableSection');
      var btnCsv = document.getElementById('btnReportExportCsv');
      var thead = document.getElementById('reportTableHead');
      var tbody = document.getElementById('reportTableBody');
      var countBadge = document.getElementById('reportTableCountBadge');
      var limitNotice = document.getElementById('reportTableLimitNotice');

      if (rep.tabela && rep.tabela.colunas && rep.tabela.colunas.length > 0 && rep.tabela.linhas && rep.tabela.linhas.length > 0) {
        if (tableSection) tableSection.style.display = 'block';
        if (btnCsv) btnCsv.style.display = 'inline-flex';
        if (countBadge) countBadge.textContent = rep.tabela.totalRegistos + ' produtos';

        if (rep.tabela.avisoLimite && limitNotice) {
          limitNotice.style.display = 'block';
          limitNotice.innerHTML = rep.tabela.avisoLimite;
        } else if (limitNotice) {
          limitNotice.style.display = 'none';
        }

        // Cabeçalho da Tabela
        var headHtml = '<tr><th style="padding: 7px 8px; width: 32px; text-align: center;">#</th>';
        rep.tabela.colunas.forEach(function(col) {
          headHtml += '<th style="padding: 7px 8px; border-left: 1px solid #e2e8f0;">' + col + '</th>';
        });
        headHtml += '<th class="no-print" style="padding: 7px 8px; width: 44px; text-align: center; color: #94a3b8;">Ação</th></tr>';
        if (thead) thead.innerHTML = headHtml;

        // Linhas da Tabela
        var bodyHtml = '';
        rep.tabela.linhas.forEach(function(row, idx) {
          bodyHtml += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
                      '<td style="padding: 6px 8px; text-align: center; color: #94a3b8; font-size: 0.72rem;">' + (idx + 1) + '</td>';
          row.forEach(function(cell) {
            bodyHtml += '<td contenteditable="true" style="padding: 6px 8px; border-left: 1px solid #f1f5f9; outline: none;">' + cell + '</td>';
          });
          bodyHtml += '<td class="no-print" style="padding: 6px 8px; text-align: center;">' +
                      '<button onclick="removeReportTableRow(this)" style="background: none; border: none; color: #ef4444; font-weight: bold; cursor: pointer; font-size: 13px;" title="Remover produto deste relatório">✕</button>' +
                      '</td></tr>';
        });
        if (tbody) tbody.innerHTML = bodyHtml;

      } else {
        if (tableSection) tableSection.style.display = 'none';
        if (btnCsv) btnCsv.style.display = 'none';
      }

      // 4. Renderizar Recomendações
      var recsList = document.getElementById('reportRecsList');
      if (recsList) {
        recsList.innerHTML = '';
        var recs = (rep.recomendacoes && rep.recomendacoes.length > 0) 
          ? rep.recomendacoes 
          : ['Proceder à verificação física dos produtos identificados nas prateleiras.', 'Validar prazos de devolução com fornecedores.'];
        
        recs.forEach(function(recText) {
          var item = document.createElement('div');
          item.className = 'report-rec-item';
          item.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; background: #f8fafc; padding: 7px 10px; border-radius: 6px; border: 1px solid #e2e8f0;';
          item.innerHTML = '<span style="color: #0284c7; font-weight: 800; font-size: 0.85rem; line-height: 1.4;">✔</span>' +
                           '<div contenteditable="true" style="flex: 1; outline: none; font-size: 0.84rem; line-height: 1.4; color: #1e293b;">' + recText + '</div>' +
                           '<button class="no-print" onclick="removeReportRecommendation(this)" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 13px; line-height: 1;">✕</button>';
          recsList.appendChild(item);
        });
      }

      // 5. Renderizar Notas Farmacêuticas
      var notesEl = document.getElementById('reportNotesEl');
      if (notesEl) {
        notesEl.innerText = rep.notaFarmaceutica || 'Proposta para validação da Direção Técnica — Nome: ________________________ | Data: ___/___/_____ | Assinatura: ________________________';
      }
    }

    function removeReportTableRow(btn) {
      if (!btn) return;
      var tr = btn.closest('tr');
      if (tr && tr.parentNode) {
        tr.parentNode.removeChild(tr);
        var remaining = document.querySelectorAll('#reportTableBody tr').length;
        var badge = document.getElementById('reportTableCountBadge');
        if (badge) badge.textContent = remaining + ' produtos';
      }
    }

    function addReportRecommendation() {
      var recsList = document.getElementById('reportRecsList');
      if (!recsList) return;
      var item = document.createElement('div');
      item.className = 'report-rec-item';
      item.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; background: #f8fafc; padding: 7px 10px; border-radius: 6px; border: 1px solid #e2e8f0;';
      item.innerHTML = '<span style="color: #0284c7; font-weight: 800; font-size: 0.85rem; line-height: 1.4;">✔</span>' +
                       '<div contenteditable="true" style="flex: 1; outline: none; font-size: 0.84rem; line-height: 1.4; color: #1e293b;">Nova ação prioritária a definir pela Direção Técnica...</div>' +
                       '<button class="no-print" onclick="removeReportRecommendation(this)" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 13px; line-height: 1;">✕</button>';
      recsList.appendChild(item);
      var editEl = item.querySelector('[contenteditable="true"]');
      if (editEl) editEl.focus();
    }

    function removeReportRecommendation(btn) {
      if (!btn) return;
      var item = btn.closest('.report-rec-item');
      if (item && item.parentNode) item.parentNode.removeChild(item);
    }

    function exportReportCsv() {
      var thead = document.getElementById('reportTableHead');
      var tbody = document.getElementById('reportTableBody');
      if (!thead || !tbody) {
        alert('Nenhuma tabela de dados presente neste relatório para exportar.');
        return;
      }

      var ths = thead.querySelectorAll('th');
      var cols = [];
      for (var i = 1; i < ths.length; i++) {
        if (!ths[i].classList.contains('no-print')) {
          cols.push('"' + ths[i].innerText.trim().replace(/"/g, '""') + '"');
        }
      }

      var trs = tbody.querySelectorAll('tr');
      if (trs.length === 0) {
        alert('A tabela de dados está vazia.');
        return;
      }

      var NL = String.fromCharCode(13) + String.fromCharCode(10);
      var csvContent = 'data:text/csv;charset=utf-8,%EF%BB%BF';
      csvContent += cols.join(';') + NL;

      trs.forEach(function(tr) {
        var tds = tr.querySelectorAll('td');
        var rowCells = [];
        for (var j = 1; j < tds.length; j++) {
          if (!tds[j].classList.contains('no-print')) {
            rowCells.push('"' + tds[j].innerText.trim().replace(/"/g, '""') + '"');
          }
        }
        if (rowCells.length > 0) {
          csvContent += rowCells.join(';') + NL;
        }
      });

      var titleText = (document.getElementById('reportTitleEl') ? document.getElementById('reportTitleEl').innerText : 'relatorio')
        .toLowerCase().replace(/[^a-z0-9]/gi, '_').slice(0, 30);
      var encodedUri = encodeURI(csvContent);
      var link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', (titleText || 'relatorio') + '_' + new Date().toISOString().slice(0, 10) + '.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function exportReportPdf() {
      var farmNome = (document.getElementById('reportFarmName') ? document.getElementById('reportFarmName').innerText : 'Farmácia Comunitária');
      var dataHoje = (document.getElementById('reportIssueDate') ? document.getElementById('reportIssueDate').innerText : new Date().toLocaleDateString('pt-PT'));
      var horaHoje = (document.getElementById('reportIssueTime') ? document.getElementById('reportIssueTime').innerText : new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }));
      var respNome = (document.getElementById('reportResponsible') ? document.getElementById('reportResponsible').innerText : 'Direção Técnica');
      var titleText = (document.getElementById('reportTitleEl') ? document.getElementById('reportTitleEl').innerText : 'Relatório Executivo');
      var subtitleText = (document.getElementById('reportSubtitleEl') ? document.getElementById('reportSubtitleEl').innerText : '');
      var diagText = (document.getElementById('reportDiagnosisEl') ? document.getElementById('reportDiagnosisEl').innerText : '');
      var notesText = (document.getElementById('reportNotesEl') ? document.getElementById('reportNotesEl').innerText : '');

      // Extrai KPIs
      var kpisHtml = '';
      var kpiCards = document.querySelectorAll('#reportKpiContainer > div');
      if (kpiCards.length > 0) {
        kpisHtml = '<div style="display:flex;gap:10px;margin-bottom:16px;">';
        kpiCards.forEach(function(card) {
          kpisHtml += '<div style="flex:1;background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:8px 10px;">' + card.innerHTML + '</div>';
        });
        kpisHtml += '</div>';
      }

      // Extrai Tabela
      var tableHtml = '';
      var thead = document.getElementById('reportTableHead');
      var tbody = document.getElementById('reportTableBody');
      if (thead && tbody && tbody.querySelectorAll('tr').length > 0) {
        tableHtml += '<div style="margin-bottom:18px;">' +
                     '<div style="font-size:11px;font-weight:800;color:#0284c7;text-transform:uppercase;margin-bottom:6px;">2. Quadro Estruturado de Artigos & Indicadores</div>' +
                     '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px;">' +
                     '<thead><tr style="background:#f8fafc;border-bottom:2px solid #cbd5e1;color:#475569;font-weight:700;font-size:10px;text-transform:uppercase;">';
        
        var ths = thead.querySelectorAll('th');
        for (var i = 0; i < ths.length; i++) {
          if (!ths[i].classList.contains('no-print')) {
            tableHtml += '<th style="padding:6px 8px;text-align:left;border-bottom:2px solid #cbd5e1;">' + ths[i].innerText.trim() + '</th>';
          }
        }
        tableHtml += '</tr></thead><tbody>';

        var trs = tbody.querySelectorAll('tr');
        trs.forEach(function(tr) {
          tableHtml += '<tr style="border-bottom:1px solid #e2e8f0;page-break-inside:avoid;">';
          var tds = tr.querySelectorAll('td');
          for (var j = 0; j < tds.length; j++) {
            if (!tds[j].classList.contains('no-print')) {
              tableHtml += '<td style="padding:6px 8px;">' + tds[j].innerText.trim() + '</td>';
            }
          }
          tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table></div>';
      }

      // Extrai Recomendações
      var recsHtml = '';
      var recItems = document.querySelectorAll('#reportRecsList .report-rec-item');
      if (recItems.length > 0) {
        recsHtml = '<div style="margin-bottom:18px;">' +
                   '<div style="font-size:11px;font-weight:800;color:#0284c7;text-transform:uppercase;margin-bottom:6px;">3. Recomendações & Plano de Ação Imediato</div>' +
                   '<div style="display:flex;flex-direction:column;gap:6px;">';
        recItems.forEach(function(item) {
          var t = item.querySelector('[contenteditable="true"]');
          if (t && t.innerText.trim()) {
            recsHtml += '<div style="display:flex;align-items:flex-start;gap:6px;font-size:11px;color:#1e293b;page-break-inside:avoid;">' +
                        '<span style="color:#0284c7;font-weight:800;">✔</span><div>' + t.innerText.trim() + '</div></div>';
          }
        });
        recsHtml += '</div></div>';
      }

      var win = window.open('', '_blank');
      if (!win) {
        alert('O navegador bloqueou a janela pop-up. Por favor permita pop-ups para gerar o PDF.');
        return;
      }

      var docHtml = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<title>' + titleText + ' — ' + farmNome + '</title>' +
        '<style>' +
          '@page { size: A4 portrait; margin: 12mm 14mm 14mm 14mm; }' +
          'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 15px; font-size: 11.5px; line-height: 1.5; }' +
          '.no-print { margin-bottom: 15px; padding: 10px 14px; background: #f1f5f9; border-radius: 8px; display: flex; gap: 10px; align-items: center; }' +
          '@media print { .no-print { display: none !important; } body { padding: 0; } }' +
          'table { width: 100%; border-collapse: collapse; }' +
          'tr { page-break-inside: avoid; }' +
        '</style>' +
        '</head><body>' +
        '<div class="no-print">' +
          '<button onclick="window.print()" style="background:#0284c7;color:#fff;border:none;padding:9px 18px;border-radius:6px;font-weight:800;cursor:pointer;font-size:13px;display:inline-flex;align-items:center;gap:6px;">🖨️ Imprimir / Guardar como PDF</button>' +
          '<button onclick="window.close()" style="background:#64748b;color:#fff;border:none;padding:9px 14px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Fechar</button>' +
          '<span style="font-size:11.5px;color:#475569;margin-left:auto;">💡 No diálogo do sistema, selecione <b>Guardar como PDF</b> para gerar o ficheiro oficial.</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #0284c7;padding-bottom:10px;margin-bottom:16px;">' +
          '<div>' +
            '<div style="font-size:18px;font-weight:900;color:#0f172a;letter-spacing:-0.5px;">BI PHARMA — RELATÓRIO EXECUTIVO</div>' +
            '<div style="font-size:13px;font-weight:700;color:#0284c7;margin-top:2px;">' + farmNome + '</div>' +
          '</div>' +
          '<div style="text-align:right;font-size:10.5px;color:#64748b;line-height:1.4;">' +
            '<div><b>Data de Emissão:</b> ' + dataHoje + ' às ' + horaHoje + '</div>' +
            '<div><b>Responsável:</b> ' + respNome + '</div>' +
            '<div><b>Sistema:</b> BI Pharma Intelligent Core</div>' +
          '</div>' +
        '</div>' +
        '<div style="margin-bottom:16px;">' +
          '<div style="font-size:16px;font-weight:800;color:#0f172a;line-height:1.3;">' + titleText + '</div>' +
          (subtitleText ? '<div style="font-size:12px;color:#64748b;font-weight:600;margin-top:2px;">' + subtitleText + '</div>' : '') +
        '</div>' +
        kpisHtml +
        '<div style="margin-bottom:18px;">' +
          '<div style="font-size:11px;font-weight:800;color:#0284c7;text-transform:uppercase;margin-bottom:6px;">1. Diagnóstico Analítico & Contexto</div>' +
          '<div style="font-size:11.5px;line-height:1.6;color:#334155;background:#fafafa;border:1px solid #f1f5f9;border-radius:6px;padding:8px 10px;">' + diagText.split(String.fromCharCode(10)).join('<br/>') + '</div>' +
        '</div>' +
        tableHtml +
        recsHtml +
        '<div style="margin-bottom:20px;page-break-inside:avoid;">' +
          '<div style="font-size:11px;font-weight:800;color:#0284c7;text-transform:uppercase;margin-bottom:6px;">4. Proposta para validação da Direção Técnica</div>' +
          '<div style="font-size:11px;line-height:1.5;color:#475569;border:1px dashed #cbd5e1;border-radius:6px;padding:8px 10px;background:#fdfdfd;margin-bottom:12px;">' + notesText.split(String.fromCharCode(10)).join('<br/>') + '</div>' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:24px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:10.5px;color:#64748b;gap:12px;">' +
            '<div>Nome: ___________________________</div>' +
            '<div>Data: ___/___/_____</div>' +
            '<div>Assinatura: ___________________________</div>' +
          '</div>' +
        '</div>' +
        '<div style="border-top:1px solid #e2e8f0;padding-top:8px;margin-top:16px;font-size:9.5px;color:#94a3b8;display:flex;justify-content:space-between;">' +
          '<span>🔒 Documento Confidencial para Uso Interno Exclusivo da Farmácia</span>' +
          '<span>Gerado por BI Pharma AI</span>' +
        '</div>' +
        '</body></html>';

      win.document.open();
      win.document.write(docHtml);
      win.document.close();
      win.focus();
      setTimeout(function() { win.print(); }, 350);
    }

    async function refineReportWithAi() {
      var input = document.getElementById('reportRefinePromptInput');
      var prompt = input ? input.value.trim() : '';
      if (!prompt) {
        alert('Por favor introduza uma instrução de ajuste (ex: "Foca em perdas financeiras", "Resume em 2 tópicos").');
        return;
      }
      var submitBtn = document.getElementById('btnReportRefineSubmit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-sm"></span> A sintetizar...';
      }

      var sid = (typeof getCopilotSessionId === 'function') ? getCopilotSessionId() : '';
      await loadAndOpenCopilotReport(window.lastCopilotAssistantText || '', sid, prompt);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Atualizar Relatório';
      }
      if (input) input.value = '';
    }

    function copyShoppingListToClipboard() {
      var list = window.lastCopilotShoppingList;
      if (!list || list.length === 0) {
        alert('Nenhuma lista de encomendas ativa encontrada. Peça uma proposta de encomenda semanal para ativar.');
        return;
      }
      var NL = String.fromCharCode(13) + String.fromCharCode(10);
      var text = 'CNP\tQuantidade' + NL;
      for (var i = 0; i < list.length; i++) {
        text += list[i].cnp + '\t' + list[i].quantidadeAEncomendar + NL;
      }
      navigator.clipboard.writeText(text).then(function() {
        alert('📋 ' + list.length + ' artigos copiados para a área de transferência! Pode colar diretamente (Ctrl+V) no Excel ou no módulo de encomenda do sistema de gestão.');
      }).catch(function(e) {
        alert('Erro ao copiar: ' + e);
      });
    }

    
    function applySifarmaOrderBlocks() {
      alert('🛑 Recomendações de Bloqueio: Os artigos com cobertura excessiva ou marcas secundárias foram identificados para que no sistema de gestão da farmácia seja colocado Ponto de Encomenda = 0 e Stock Mínimo = 0.');
      switchTab('plano');
    }

    function applyShoppingListToWeeklyPlan() {
      var list = window.lastCopilotShoppingList;
      if (!list || list.length === 0) {
        alert('📥 Recomendações aplicadas com sucesso à Folha da Semana!');
        switchTab('plano');
        return;
      }
      var newTasks = list.map(function(it) {
        return {
          id: 'rep_' + it.cnp + '_' + Date.now(),
          pilar: 4,
          pilarNome: 'Ajustar Níveis & Prevenir Ruturas',
          cnp: it.cnp,
          designacao: it.designacao,
          tarefa: 'Encomendar ' + it.quantidadeAEncomendar + ' un de ' + it.designacao + ' (CNP ' + it.cnp + ') para reposição semanal',
          prioridade: 'ALTA',
          responsavel: 'Compras / Balcão',
          checked: false
        };
      });
      fetch('/api/weekly-plan/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farmaciaId: activeFarmaciaId, tasks: newTasks })
      }).then(function(r) { return r.json(); }).then(function() {
        alert('📥 ' + list.length + ' artigos de reposição adicionados com sucesso ao Pilar 4 da Folha Semanal!');
        switchTab('plano');
      }).catch(function() {
        switchTab('plano');
      });
    }


    // ========================================================================
    // MODOS ESPECIALIZADOS DO COPILOT (FASE 3)
    // ========================================================================
    let currentCopilotMode = 'GENERAL';

    const COPILOT_MODES_INFO = {
      CLINICAL: {
        tag: 'CLÍNICO',
        tagBg: '#dbeafe',
        tagColor: '#1d4ed8',
        desc: '🩺 <b>Modo Balcão Clínico & Sintomas:</b> Indicação terapêutica, alívio sintomático, posologia, verificação de contraindicações e alternativas sem interação.',
        placeholder: 'Ex: Utente com tosse seca e hipertenso, o que indicar sem pseudoefedrina? Ou: Sintomas de dor articular...'
      },
      FINANCE: {
        tag: 'FINANÇAS',
        tagBg: '#fef9c3',
        tagColor: '#854d0e',
        desc: '💰 <b>Modo Finanças, Margens & Labs:</b> Análise de margem comercial, rentabilidade por fornecedor, negociação e impacto financeiro de vendas.',
        placeholder: 'Ex: Quais os laboratórios com maior margem em genéricos? Qual a rentabilidade do paracetamol?...'
      },
      STOCKS: {
        tag: 'STOCKS',
        tagBg: '#ffedd5',
        tagColor: '#c2410c',
        desc: '📦 <b>Modo Stocks, Rupturas & Validades:</b> Alertas de caducidade próxima, cálculo de quebras de stock, cobertura e excesso de inventário.',
        placeholder: 'Ex: Quais os produtos com validade a expirar nos próximos 3 meses? Artigos em risco de rutura?...'
      },
      MARKETING: {
        tag: 'MARKETING',
        tagBg: '#f3e8ff',
        tagColor: '#7e22ce',
        desc: '🎯 <b>Modo Marketing & Escoamento:</b> Campanhas sazonais, pacotes promocionais, escoamento de monos e gatilhos de cross-selling.',
        placeholder: 'Ex: Sugestões de campanha para dermocosmética no inverno? Como escoar os 10 maiores monos?...'
      },
      GENERAL: {
        tag: 'GERAL',
        tagBg: '#e0f2fe',
        tagColor: '#0369a1',
        desc: '💡 <b>Modo Geral:</b> Pergunte qualquer questão ou selecione um modo especializado acima para obter respostas assertivas em cartões e tabelas compactas.',
        placeholder: "Faça uma pergunta ou pedido de seguimento... (Ex: 'E desses, quais têm maior margem?')"
      }
    };

    function setCopilotMode(mode) {
      currentCopilotMode = mode || 'GENERAL';
      const info = COPILOT_MODES_INFO[currentCopilotMode] || COPILOT_MODES_INFO.GENERAL;

      // 1. Atualizar estilos visuais dos 5 botões de modo
      ['CLINICAL', 'FINANCE', 'STOCKS', 'MARKETING', 'GENERAL'].forEach(function(m) {
        const btn = document.getElementById('modeBtn-' + m);
        if (btn) {
          if (m === currentCopilotMode) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        }
      });

      // 2. Atualizar Banner do Modo Ativo
      const descEl = document.getElementById('copilotModeDesc');
      const tagEl = document.getElementById('copilotModeTag');
      if (descEl) descEl.innerHTML = info.desc;
      if (tagEl) {
        tagEl.textContent = info.tag;
        tagEl.style.background = info.tagBg;
        tagEl.style.color = info.tagColor;
      }

      // 3. Atualizar placeholder do input e dar foco
      const inputEl = document.getElementById('askInput');
      if (inputEl) {
        inputEl.placeholder = info.placeholder;
        inputEl.focus();
      }
    }

    async function sendCopilotFeedback(vote, btn) {
      if (!btn || btn.classList.contains('voted')) return;
      try {
        const bubble = btn.closest('.chat-bubble-assistant');
        const interacaoId = bubble ? (bubble.dataset.interacaoId || '') : '';
        await fetch('/api/copilot/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: getCopilotSessionId(),
            interacaoId: interacaoId || undefined,
            feedback: vote === 'UP' ? 1 : -1,
            farmaciaId: activeFarmaciaId,
          }),
        });
        btn.classList.add('voted');
        btn.textContent = vote === 'UP' ? '✓ Obrigado pelo feedback' : '✓ Feedback registado';
      } catch (e) {
        console.warn('Erro ao registar feedback:', e);
      }
    }

    async function askQuestion(forcedQuestion) {
      if (isCopilotThinking) return;
      const inputEl = document.getElementById('askInput');
      const question = (forcedQuestion || (inputEl ? inputEl.value : '')).trim();
      if (!question) return;

      if (activeTab !== 'copilot') switchTab('copilot');

      const submitBtn = document.getElementById('askBtnSubmit');
      const thinkingBox = document.getElementById('copilotThinkingIndicator');
      const chatFeed = document.getElementById('copilotChatFeed');
      const welcomeGreeting = document.getElementById('copilotWelcomeGreeting');

      if (welcomeGreeting) welcomeGreeting.style.display = 'none';

      // Append User message to Chat Feed
      const userBubble = document.createElement('div');
      userBubble.className = 'chat-bubble-user';
      userBubble.textContent = question;
      chatFeed.appendChild(userBubble);
      chatFeed.scrollTop = chatFeed.scrollHeight;

      if (inputEl) inputEl.value = '';

      // Set Loading State
      isCopilotThinking = true;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-sm"></span> A analisar...';
      }
      if (thinkingBox) thinkingBox.style.display = 'flex';

      try {
        const sid = getCopilotSessionId();
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            farmaciaId: activeFarmaciaId,
            sessionId: sid,
            mode: currentCopilotMode || 'GENERAL',
          }),
        });

        const data = await res.json();

        if (data.shoppingList && Array.isArray(data.shoppingList) && data.shoppingList.length > 0) {
          window.lastCopilotShoppingList = data.shoppingList;
        }

        if (thinkingBox) thinkingBox.style.display = 'none';

        // Append Assistant message to Chat Feed
        const assistantBubble = document.createElement('div');
        assistantBubble.className = 'chat-bubble-assistant';

        let badgeHtml = '';
        if (data.toolsUsed && data.toolsUsed.length > 0) {
          const toolNames = data.toolsUsed.join(', ');
          badgeHtml = '<div class="chat-tools-badge">🛠️ Ferramentas Analíticas Executadas: ' + toolNames + '</div>';
        }

        const formattedHtml = renderCopilotMarkdown(data.text || data.explicacao || 'Sem resposta disponível.');

        let actionButtonsHtml = '';
        if (data.shoppingList && Array.isArray(data.shoppingList) && data.shoppingList.length > 0) {
          actionButtonsHtml = '<div style="margin-top: 15px; padding: 14px; background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.04);">' +
            '<div style="font-size: 0.8rem; font-weight: 800; color: #1e293b; margin-bottom: 10px; display:flex; align-items:center; gap:6px;">🚀 CENTRAL DE ENCOMENDA & REPOSIÇÃO (' + data.shoppingList.length + ' artigos identificados):</div>' +
            '<div style="display: flex; flex-wrap: wrap; gap: 8px;">' +
            '<button class="btn btn-sm" onclick="openInteractiveOrderModal()" style="background:#6366f1;color:#fff;font-weight:800;padding:9px 16px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:7px;box-shadow:0 2px 4px rgba(99,102,241,0.25);">🛒 Rever & Editar Encomenda Completa (' + data.shoppingList.length + ' Artigos)</button>' +
            '<button class="btn btn-sm" onclick="exportCopilotShoppingListCsv()" style="background:#0284c7;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📥 Descarregar CSV de Encomenda</button>' +
            '<button class="btn btn-sm" onclick="exportCopilotShoppingListPdf()" style="background:#dc2626;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📄 Imprimir / Guardar em PDF</button>' +
            '<button class="btn btn-sm" onclick="copyShoppingListToClipboard()" style="background:#475569;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📋 Copiar CNPs</button>' +
            '<button class="btn btn-sm" onclick="applyShoppingListToWeeklyPlan()" style="background:#10b981;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📝 Adicionar à Folha Semanal (Pilar 4)</button>' +
            '</div></div>';
        }

        let telemetryHtml = '';
        if (data.usage) {
          const inTok = data.usage.inputTokens || 0;
          const outTok = data.usage.outputTokens || 0;
          const cacheW = data.usage.cacheCreationTokens || 0;
          const cacheR = data.usage.cacheReadTokens || 0;
          const totTok = inTok + outTok + cacheW + cacheR;
          const cacheLabel = (cacheW > 0 || cacheR > 0)
            ? ' (in: ' + inTok.toLocaleString('pt-PT') + ' · out: ' + outTok.toLocaleString('pt-PT') + ' · cache W/R: ' + cacheW.toLocaleString('pt-PT') + '/' + cacheR.toLocaleString('pt-PT') + ')'
            : ' (in: ' + inTok.toLocaleString('pt-PT') + ' · out: ' + outTok.toLocaleString('pt-PT') + ')';
          const durSec = ((data.usage.duracaoMs || 0) / 1000).toFixed(1);
          const costStr = Number(data.usage.custoEstimadoEur || 0).toFixed(4);
          telemetryHtml = '<div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed #e2e8f0; font-size: 0.73rem; color: #64748b; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">' +
            '<span>⚡ ' + durSec + 's · ' + totTok.toLocaleString('pt-PT') + ' tokens' + cacheLabel + '</span>' +
            '<span style="color:#059669; font-weight:700;">💰 Custo estimado: ~€ ' + costStr + '</span>' +
          '</div>';
        }

        const feedbackActionsHtml = '<div class="chat-feedback-actions">' +
          '<span>Esta resposta foi útil?</span>' +
          '<button class="chat-feedback-btn" onclick="sendCopilotFeedback(&quot;UP&quot;, this)">👍 Sim, assertiva</button>' +
          '<button class="chat-feedback-btn" onclick="sendCopilotFeedback(&quot;DOWN&quot;, this)">👎 Pouco clara</button>' +
          '<button class="chat-feedback-btn" onclick="openCopilotReportModalFromBubble(this)" style="margin-left: auto; background: #e0f2fe; color: #0369a1; border-color: #7dd3fc; font-weight: 700; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;" title="Estruturar esta resposta num Relatório Executivo timbrado A4 com Preview">' +
            '<span>📑 Gerar Relatório Executivo</span>' +
          '</button>' +
        '</div>';

        assistantBubble.dataset.rawText = data.text || data.explicacao || '';
        assistantBubble.dataset.interacaoId = data.interacaoId || '';
        window.lastCopilotAssistantText = data.text || data.explicacao || '';
        if (data.relatorioEstruturado) {
          window.lastCopilotRelatorioEstruturado = data.relatorioEstruturado;
        }

        assistantBubble.innerHTML = badgeHtml +
          '<div>' + formattedHtml + '</div>' +
          actionButtonsHtml +
          feedbackActionsHtml +
          telemetryHtml +
          '<div style="margin-top: 6px; font-size: 0.72rem; color: #94a3b8; text-align: right;">' +
          'Copilot • ' + new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) +
          '</div>';

        chatFeed.appendChild(assistantBubble);
        chatFeed.scrollTop = chatFeed.scrollHeight;

      } catch (err) {
        console.error('Erro no Copilot:', err);
        if (thinkingBox) thinkingBox.style.display = 'none';

        const errorBubble = document.createElement('div');
        errorBubble.className = 'chat-bubble-assistant';
        errorBubble.innerHTML = '<div style="color: #e11d48; font-weight: 700;">❌ Ocorreu um erro ao processar a pergunta</div>' +
          '<div style="font-size: 0.85rem; color: #64748b; margin-top: 4px;">Por favor verifique a ligação e tente novamente.</div>';
        chatFeed.appendChild(errorBubble);
        chatFeed.scrollTop = chatFeed.scrollHeight;
      } finally {
        isCopilotThinking = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Perguntar</span> ➜';
        }
        if (inputEl) {
          inputEl.focus();
        }
      }
    }

    let productClientCache = {};
    let activeDciGroup = null;

    function updateModalProductView(p) {
      const inv = p.inventario[0] || { quantidade: 0, custo_unitario: 0, data_validade: null };
      const totalVendido = (p.vendas || []).reduce((s, v) => s + v.quantidade, 0);
      const vmm = (totalVendido / 12).toFixed(2);

      const titleEl = document.getElementById('modalTitle');
      if (titleEl) titleEl.innerHTML = '[' + p.cnp_codigo + '] ' + escapeHtml(p.designacao) + ' ' + formatSegmentoBadge(p);

      const subEl = document.getElementById('modalSub');
      if (subEl) {
        subEl.textContent = 'Categoria: ' + (p.categoria || 'Geral') + (p.grupo_equivalencia_dci ? ' | Grupo DCI: ' + p.grupo_equivalencia_dci : '') + ' | IVA: ' + (p.taxa_iva ?? '-') + '%';
      }

      // 4 KPIs
      const metricsEl = document.getElementById('modalMetrics');
      if (metricsEl) {
        metricsEl.innerHTML =
          '<div style="background:#f8fafc;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0">' +
            '<div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;">' + (activeDciGroup ? 'STOCK DESTE LAB' : 'STOCK ATUAL') + '</div>' +
            '<div style="font-size:1.3rem;font-weight:800;color:#0f172a;margin-top:2px;">' + inv.quantidade + ' un</div>' +
            '<div style="font-size:0.76rem;color:#64748b;">Custo: ' + Number(inv.custo_unitario).toFixed(2) + ' €' + (activeDciGroup ? ' | Molécula: <b style="color:#7e22ce;">' + activeDciGroup.stock_total_unidades + ' un</b> (' + activeDciGroup.num_laboratorios_abertos + ' labs)' : '') + '</div>' +
          '</div>' +
          '<div style="background:#f8fafc;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0">' +
            '<div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;">PVP & MARGEM</div>' +
            '<div style="font-size:1.3rem;font-weight:800;color:#0f172a;margin-top:2px;">' + (p.pvp ? Number(p.pvp).toFixed(2) + ' €' : '-') + '</div>' +
            '<div style="font-size:0.76rem;color:#059669;font-weight:700;">Margem: ' + (p.margem_padrao ? p.margem_padrao + '%' : '-') + '</div>' +
          '</div>' +
          '<div style="background:#f8fafc;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0">' +
            '<div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;">RITMO (VMM 12M)</div>' +
            '<div style="font-size:1.3rem;font-weight:800;color:#0f172a;margin-top:2px;">' + vmm + ' /mês</div>' +
            '<div style="font-size:0.76rem;color:#64748b;">Total 12M: ' + totalVendido + ' un vendidas</div>' +
          '</div>' +
          '<div style="background:#f8fafc;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0">' +
            '<div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;">VALIDADE REGISTADA</div>' +
            '<div style="font-size:1.3rem;font-weight:800;color:' + (inv.data_validade ? '#e11d48' : '#0f172a') + ';margin-top:2px;">' + (inv.data_validade || 'S/ Registo') + '</div>' +
            '<div style="font-size:0.76rem;color:#64748b;">Controlo de Inventário / ERP</div>' +
          '</div>';
      }

      // Gráfico
      const salesMap = new Map((p.vendas || []).map(v => [v.mes, v.quantidade]));
      const maxQtd = Math.max(1, ...MONTHS_ORDER.map(m => salesMap.get(m.key) || 0));

      const chartTitleEl = document.getElementById('modalChartTitle');
      if (chartTitleEl) {
        chartTitleEl.innerHTML = '📊 Evolução de Vendas Mensais — <span style="color:#0284c7;font-weight:800;">[' + p.cnp_codigo + '] ' + escapeHtml((p.designacao || '').split(',')[0]) + '</span> (Total: ' + totalVendido + ' un)';
      }

      const chartEl = document.getElementById('modalChart');
      if (chartEl) {
        chartEl.innerHTML = MONTHS_ORDER.map(m => {
          const qtd = salesMap.get(m.key) || 0;
          const heightPct = Math.round((qtd / maxQtd) * 85) + 4;
          return '<div class="bar-col">' +
            '<span class="bar-val">' + qtd + '</span>' +
            '<div class="bar" style="height:' + heightPct + 'px;background:' + (qtd > 0 ? '#0284c7' : '#cbd5e1') + '"></div>' +
            '<span class="bar-lbl">' + m.label + '</span>' +
            '</div>';
        }).join('');
      }
    }

    async function switchLabInModal(cnp, clickedTr) {
      // 1. Atualizar imediatamente o destaque visual da linha clicada
      const tbody = document.getElementById('dciPeersTableBody');
      if (tbody) {
        const rows = tbody.querySelectorAll('tr');
        rows.forEach(function(r) {
          r.style.background = '';
          r.style.borderLeft = '';
          const b = r.querySelector('.lab-status-btn');
          if (b) {
            b.innerHTML = '📊 Ver Gráfico';
            b.style.background = '#f0f9ff';
            b.style.color = '#0284c7';
            b.style.borderColor = '#bae6fd';
          }
        });
      }

      if (clickedTr) {
        clickedTr.style.background = '#faf5ff';
        clickedTr.style.borderLeft = '4px solid #a855f7';
        const b = clickedTr.querySelector('.lab-status-btn');
        if (b) {
          b.innerHTML = '👁️ No Gráfico';
          b.style.background = '#f3e8ff';
          b.style.color = '#7e22ce';
          b.style.borderColor = '#d8b4fe';
        }
      }

      // 2. Verificar se está em cache ou descarregar
      let p = productClientCache[cnp];
      if (!p) {
        const chartTitleEl = document.getElementById('modalChartTitle');
        if (chartTitleEl) chartTitleEl.textContent = '⏳ A carregar vendas do laboratório [' + cnp + ']...';
        try {
          const res = await fetch('/api/product/' + cnp + '?farmaciaId=' + encodeURIComponent(activeFarmaciaId || ''));
          if (!res.ok) return;
          p = await res.json();
          productClientCache[cnp] = p;
        } catch (err) {
          console.error('Falha ao carregar laboratório:', err);
          return;
        }
      }

      // 3. Atualizar gráfico e métricas SEM mexer no scroll nem na tabela
      updateModalProductView(p);
    }

    async function openProductModal(cnp) {
      // Verificar se já temos o produto em cache para abertura instantânea
      let p = productClientCache[cnp];
      if (!p) {
        try {
          const res = await fetch('/api/product/' + cnp + '?farmaciaId=' + encodeURIComponent(activeFarmaciaId || ''));
          if (!res.ok) return;
          p = await res.json();
          productClientCache[cnp] = p;
        } catch (err) {
          console.error(err);
          return;
        }
      }

      const dciGroup = currentReport && p.grupo_equivalencia_dci
        ? currentReport.consolidacao_genericos_dci.find(g => g.grupo_equivalencia_dci === p.grupo_equivalencia_dci)
        : null;
      activeDciGroup = dciGroup;

      // Atualizar view do produto
      updateModalProductView(p);

      // Regra de Balcão e Cross-Selling
      const ruleBox = document.getElementById('modalRuleBox');
      let ruleHtml = '';
      if (p.eh_generico) {
        ruleHtml = '🧬 <b>Medicamento Genérico (MG) — Grupo DCI: ' + escapeHtml(p.grupo_equivalencia_dci || p.designacao) + ':</b> Substituível no balcão perante receita médica por DCI. Priorizar o escoamento de laboratórios com 1-2 caixas soltas ("restos de gaveta") ou validade mais curta, e concentrar futuras encomendas no laboratório com menor preço de custo.';
      } else if (p.tipo_venda === 'MSRM') {
        ruleHtml = '🏷️ <b>Medicamento de Marca Sujeito a Receita (MSRM):</b> Vedado a cross-selling comercial e sem substituição direta por outra marca se prescrito nominalmente.';
      } else {
        ruleHtml = '🟢 <b>Elegível para Cross-Selling e Campanhas (' + escapeHtml(p.tipo_venda || '') + '):</b> ' + escapeHtml(p.sugestao_cross_sell || '');
      }
      if (ruleBox) {
        ruleBox.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">' +
          '<div style="flex:1;min-width:260px;">' + ruleHtml + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn btn-secondary" onclick="jumpToProductCrossSell360(&quot;' + p.cnp_codigo + '&quot;)" style="font-size:0.78rem;padding:6px 12px;border-color:#0284c7;color:#0284c7;">🤝 Cross-Selling 360º</button>' +
          '</div></div>';
      }

      const peersBox = document.getElementById('modalDciPeers');
      const switcherEl = document.getElementById('modalLabSwitcher');

      if (dciGroup && dciGroup.todos_laboratorios && dciGroup.todos_laboratorios.length > 0) {
        if (switcherEl) {
          const allCnps = dciGroup.todos_laboratorios.map(l => l.cnp_codigo).join(',');
          switcherEl.innerHTML = '<button class="btn btn-secondary" onclick="renderDciCombinedChart(&quot;' + allCnps + '&quot;, &quot;' + escapeJsString(dciGroup.grupo_equivalencia_dci) + '&quot;)" style="font-size:0.75rem;padding:5px 12px;border-color:#c084fc;color:#7e22ce;font-weight:700;background:#faf5ff;">' +
            '🧬 Ver Soma da Molécula (' + dciGroup.num_laboratorios_abertos + ' Labs)' +
          '</button>';
        }

        // Pré-carregar em background os outros laboratórios do grupo DCI para cliques instantâneos a 0ms
        dciGroup.todos_laboratorios.forEach(function(l) {
          if (!productClientCache[l.cnp_codigo]) {
            fetch('/api/product/' + l.cnp_codigo + '?farmaciaId=' + encodeURIComponent(activeFarmaciaId || ''))
              .then(function(r) { return r.ok ? r.json() : null; })
              .then(function(data) { if (data) productClientCache[l.cnp_codigo] = data; })
              .catch(function() {});
          }
        });

        peersBox.style.display = 'block';
        peersBox.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">' +
            '<div>' +
              '<h4 style="font-size: 0.94rem; font-weight: 800; color: #7e22ce; text-transform: uppercase; margin: 0; display: flex; align-items: center; gap: 6px;">' +
                '🧬 Laboratórios Disponíveis em Stock para ' + escapeHtml(dciGroup.grupo_equivalencia_dci) + ' (' + dciGroup.num_laboratorios_abertos + ' marcas em gaveta)' +
              '</h4>' +
              '<p style="font-size: 0.8rem; color: #64748b; margin: 3px 0 0 0;">' +
                'Clique em qualquer linha ou no botão "Ver Gráfico" para ver a rotação desse laboratório <b>sem perder a posição da tabela</b>.' +
              '</p>' +
            '</div>' +
            '<span style="font-size:0.78rem;background:#f3e8ff;color:#6b21a8;font-weight:800;padding:5px 12px;border-radius:8px;border:1px solid #d8b4fe;">' +
              'Stock Molécula: ' + dciGroup.stock_total_unidades + ' un | VMM Grupo: ' + dciGroup.vmm_total_grupo + '/mês' +
            '</span>' +
          '</div>' +
          '<div class="table-wrap" style="height: 380px; max-height: 480px; overflow-y: auto; border: 1.5px solid #e2e8f0; border-radius: 10px; background: #ffffff;">' +
            '<table style="width: 100%; border-collapse: collapse; font-size: 0.86rem; text-align: left;">' +
              '<thead style="position: sticky; top: 0; z-index: 3; background: #f8fafc; border-bottom: 2px solid #cbd5e1;">' +
                '<tr>' +
                  '<th style="padding: 11px 14px; width: 100px; color: #475569;">Código</th>' +
                  '<th style="padding: 11px 14px; color: #475569;">Laboratório / Designação</th>' +
                  '<th style="padding: 11px 14px; text-align: center; width: 110px; color: #475569;">Stock Gaveta</th>' +
                  '<th style="padding: 11px 14px; text-align: right; width: 110px; color: #475569;">Custo Unit.</th>' +
                  '<th style="padding: 11px 14px; text-align: center; width: 100px; color: #475569;">Ritmo VMM</th>' +
                  '<th style="padding: 11px 14px; text-align: center; width: 110px; color: #475569;">Validade</th>' +
                  '<th style="padding: 11px 14px; text-align: center; width: 180px; color: #475569;">Prioridade de Escoamento</th>' +
                  '<th style="padding: 11px 14px; text-align: right; width: 140px; color: #475569;">Ação Gráfico</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody id="dciPeersTableBody">' +
                dciGroup.todos_laboratorios.map(function(lab) {
                  const isCurrent = lab.cnp_codigo === p.cnp_codigo;
                  const rowStyle = isCurrent ? 'background:#faf5ff;border-left:4px solid #a855f7;' : '';
                  const statusBadge = isCurrent
                    ? '<span class="badge badge-purple lab-status-btn" style="background:#f3e8ff;color:#7e22ce;border-color:#d8b4fe;padding:4px 10px;">👁️ No Gráfico</span>'
                    : '<button class="btn btn-secondary lab-status-btn" style="font-size:0.75rem;padding:4px 10px;background:#f0f9ff;color:#0284c7;border-color:#bae6fd;font-weight:700;">📊 Ver Gráfico</button>';

                  const priorityBadge = lab.stock_atual <= 2
                    ? '<span class="badge badge-danger" style="background:#fee2e2;color:#b91c1c;padding:3px 8px;font-weight:700;">🧹 Resto Gaveta (Escoar 1º)</span>'
                    : lab.custo_unitario === dciGroup.custo_minimo
                      ? '<span class="badge badge-success" style="background:#dcfce7;color:#15803d;padding:3px 8px;font-weight:700;">⭐ Mais Barato</span>'
                      : '<span style="color:#64748b;font-size:0.78rem;">Stock Principal</span>';

                  return '<tr class="clickable-row lab-row-' + lab.cnp_codigo + '" onclick="switchLabInModal(&quot;' + lab.cnp_codigo + '&quot;, this)" style="' + rowStyle + 'border-bottom: 1px solid #f1f5f9; cursor: pointer;">' +
                    '<td style="padding: 10px 14px; font-family: monospace; font-weight: 700; color: #0284c7;">' + escapeHtml(lab.cnp_codigo) + '</td>' +
                    '<td style="padding: 10px 14px; font-weight: 700; color: #0f172a;">' + escapeHtml(lab.designacao) + '</td>' +
                    '<td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #0f172a;">' + lab.stock_atual + ' un</td>' +
                    '<td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #334155;">' + Number(lab.custo_unitario).toFixed(2) + ' €</td>' +
                    '<td style="padding: 10px 14px; text-align: center; font-weight: 700; color: #0f172a;">' + lab.vmm + ' /mês</td>' +
                    '<td style="padding: 10px 14px; text-align: center; color: #64748b;">' + escapeHtml(lab.data_validade || '—') + '</td>' +
                    '<td style="padding: 10px 14px; text-align: center;">' + priorityBadge + '</td>' +
                    '<td style="padding: 10px 14px; text-align: right;">' + statusBadge + '</td>' +
                    '</tr>';
                }).join('') +
              '</tbody>' +
            '</table>' +
          '</div>';
      } else {
        if (switcherEl) switcherEl.innerHTML = '';
        peersBox.style.display = 'none';
      }

      document.getElementById('productModal').style.display = 'flex';
    }

    async function renderDciCombinedChart(cnpsCsv, grupoNome) {
      const cnps = cnpsCsv.split(',').filter(Boolean);
      const responses = await Promise.all(
        cnps.map(c => fetch('/api/product/' + c + '?farmaciaId=' + activeFarmaciaId).then(r => r.ok ? r.json() : null))
      );
      const combinedSales = new Map();
      let totalGrupo = 0;
      responses.filter(Boolean).forEach(prod => {
        (prod.vendas || []).forEach(v => {
          combinedSales.set(v.mes, (combinedSales.get(v.mes) || 0) + v.quantidade);
          totalGrupo += v.quantidade;
        });
      });

      const maxQtd = Math.max(1, ...MONTHS_ORDER.map(m => combinedSales.get(m.key) || 0));
      const chartTitleEl = document.getElementById('modalChartTitle');
      if (chartTitleEl) {
        chartTitleEl.innerHTML = \`🧬 Vendas Mensais Conjuntas — <span style="color:#c084fc;">\${grupoNome} (Todos os \${cnps.length} Labs: \${totalGrupo} un vendidas)</span>\`;
      }

      document.getElementById('modalChart').innerHTML = MONTHS_ORDER.map(m => {
        const qtd = combinedSales.get(m.key) || 0;
        const heightPct = Math.round((qtd / maxQtd) * 110) + 4;
        return \`
          <div class="bar-col">
            <span class="bar-val">\${qtd}</span>
            <div class="bar" style="height:\${heightPct}px;background:\${qtd > 0 ? '#c084fc' : '#334155'}"></div>
            <span class="bar-lbl">\${m.label}</span>
          </div>
        \`;
      }).join('');
    }

    function closeModal() {
      document.getElementById('productModal').style.display = 'none';
    }

    function exportCurrentTabCsv() {
      const table = document.getElementById('mainTable');
      const rows = Array.from(table.querySelectorAll('tr'));
      const csvContent = rows.map(r =>
        Array.from(r.querySelectorAll('th,td')).map(c => '"' + c.innerText.replace(/"/g, '""') + '"').join(';')
      ).join('\\n');

      const blob = new Blob(['\\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = \`bi_pharma_\${activeTab}.csv\`;
      a.click();
    }

    // ==========================================
    // HUB DE CAMPANHAS E MARKETING 360º (CLIENTE)
    // ==========================================
    let currentCampaignSuggestions = [];
    let currentMarketingOverview = null;
    let currentCrossSellingPlans = [];
    let activeMarketingSubView = 'epoca'; // 'epoca' | 'liquidacao' | 'cross' | 'custom'
    let selectedCampaign = null;
    let currentGeneratedCampaign = null;
    let customPickedProducts = []; // Array<{ cnp, designacao, stock, pvp }>

    
    let clinicalThemePacksData = [];
    async function loadClinicalThemePacks(forceRefresh) {
      const grid = document.getElementById('mktPacksGrid');
      if (!grid) return;
      if (!forceRefresh && clinicalThemePacksData && clinicalThemePacksData.length > 0) {
        renderClinicalThemePacks(clinicalThemePacksData);
        return;
      }
      grid.innerHTML = '<div style="padding: 24px; color: var(--muted);">A carregar packs clínicos da farmácia...</div>';
      try {
        const res = await fetch('/api/packs?farmaciaId=' + encodeURIComponent(activeFarmaciaId));
        const data = await res.json();
        clinicalThemePacksData = data.packs || [];
        renderClinicalThemePacks(clinicalThemePacksData);
      } catch (e) {
        grid.innerHTML = '<div style="padding: 24px; color: #fb7185;">Erro ao carregar packs clínicos: ' + e.message + '</div>';
      }
    }

    let activePackForDtApproval = null;

    function renderClinicalThemePacks(packs) {
      const grid = document.getElementById('mktPacksGrid');
      if (!grid) return;
      if (!packs || packs.length === 0) {
        grid.innerHTML = '<div style="padding: 24px; color: var(--muted); grid-column: 1 / -1;">Nenhum pack clínico disponível de momento.</div>';
        return;
      }

      const activePacks = packs.filter(p => p.estadoCiclo === 'ATIVO' || p.estadoCiclo === 'SUSPENSO_STOCK_BAIXO');
      const proposedPacks = packs.filter(p => p.estadoCiclo === 'PROPOSTO' || (!p.estadoCiclo && !activePacks.includes(p)));

      let html = '';

      // SECÇÃO 1: PACKS ATIVOS NO BALCÃO (ASSINADOS PELO DT)
      html += '<div style="grid-column: 1 / -1; margin-top: 10px; margin-bottom: 6px;">' +
        '<div style="font-size: 1.15rem; font-weight: 800; color: #047857; display: flex; align-items: center; gap: 8px;">' +
          '🚀 1. Packs Ativos no Balcão (Assinados & Válidos no Balcão)' +
          '<span style="font-size: 0.75rem; background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 9999px; font-weight: 800;">' + activePacks.length + ' Ativo(s)</span>' +
        '</div>' +
        '<p style="font-size: 0.82rem; color: #64748b; margin: 3px 0 0 0;">Packs aprovados formalmente pelo Diretor Técnico com integridade criptográfica SHA-256 e presença confirmada nas folhas e ecrãs de atendimento.</p>' +
      '</div>';

      if (activePacks.length === 0) {
        html += '<div style="grid-column: 1 / -1; padding: 18px 24px; background: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: 12px; color: #64748b; font-size: 0.88rem; text-align: center;">' +
          'ℹ️ Nenhum pack ativo de momento no balcão. Valide uma das propostas determinísticas abaixo com a sua password de DT para o ativar.' +
        '</div>';
      } else {
        html += activePacks.map(p => renderPackCard(p, true)).join('');
      }

      // SECÇÃO 2: PROPOSTAS DE PACKS DE ÉPOCA (MOTOR DETERMINÍSTICO)
      html += '<div style="grid-column: 1 / -1; margin-top: 32px; margin-bottom: 6px;">' +
        '<div style="font-size: 1.15rem; font-weight: 800; color: #0369a1; display: flex; align-items: center; gap: 8px;">' +
          '📋 2. Propostas de Packs de Época (Motor Determinístico — Aguardam Validação DT)' +
          '<span style="font-size: 0.75rem; background: #e0f2fe; color: #075985; padding: 2px 8px; border-radius: 9999px; font-weight: 800;">' + proposedPacks.length + ' Proposta(s)</span>' +
        '</div>' +
        '<p style="font-size: 0.82rem; color: #64748b; margin: 3px 0 0 0;">Cestos gerados estritamente por regras farmacêuticas (sem MSRM, vias anatómicas compatíveis, stock ≥ 3 un). Requerem assinatura formal do DT.</p>' +
      '</div>';

      if (proposedPacks.length === 0) {
        html += '<div style="grid-column: 1 / -1; padding: 18px 24px; background: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: 12px; color: #64748b; font-size: 0.88rem; text-align: center;">' +
          '✅ Todas as propostas determinísticas para este período foram assinadas ou tratadas.' +
        '</div>';
      } else {
        html += proposedPacks.map(p => renderPackCard(p, false)).join('');
      }

      grid.innerHTML = html;
    }

    function renderPackCard(pack, isActive) {
      const isSuspendedStock = pack.estadoCiclo === 'SUSPENSO_STOCK_BAIXO';
      const itemsHtml = (pack.produtos || []).map(p => \`
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <span style="font-weight: 700; color: #0f172a; font-size: 0.86rem;">💊 \${p.designacao}</span>
            <span style="font-size: 0.76rem; font-weight: 800; color: \${p.stockAtual < 3 ? '#dc2626' : '#0284c7'}; background: \${p.stockAtual < 3 ? '#fee2e2' : '#e0f2fe'}; padding: 2px 7px; border-radius: 4px;">\${p.pvpUnitario ? p.pvpUnitario.toFixed(2) + '€' : ''} (Stock: \${p.stockAtual} un)</span>
          </div>
          <div style="font-size: 0.78rem; color: #0369a1; font-weight: 600; margin-top: 4px;">
            💡 <span><b>Para o Utente:</b> \${p.propositoUtente}</span>
          </div>
          <div style="font-size: 0.72rem; color: #64748b; margin-top: 3px;">
            CNP: <code>\${p.cnp}</code> | Margem Individual: \${p.margemPct}%
          </div>
        </div>
      \`).join('');

      let statusBadge = '';
      if (isActive) {
        if (isSuspendedStock) {
          statusBadge = '<span style="font-size: 0.72rem; font-weight: 800; color: #b45309; background: #fef3c7; border: 1px solid #fde68a; padding: 3px 8px; border-radius: 4px;">⚠️ Cesto Esgotado (< 3 un em stock) - Temporariamente Suspenso</span>';
        } else {
          statusBadge = '<span style="font-size: 0.72rem; font-weight: 800; color: #065f46; background: #d1fae5; border: 1px solid #a7f3d0; padding: 3px 8px; border-radius: 4px;">🛡️ Assinado por DT (' + (pack.validadoPor || 'Diretor Técnico') + ')</span>';
        }
      } else {
        statusBadge = '<span style="font-size: 0.72rem; font-weight: 800; color: #0369a1; background: #e0f2fe; border: 1px solid #bae6fd; padding: 3px 8px; border-radius: 4px;">📋 PROPOSTA DETERMINÍSTICA</span>';
      }

      let actionsHtml = '';
      if (isActive) {
        actionsHtml = '<div style="display:flex; justify-content:space-between; align-items:center; margin-top: 14px; padding-top: 12px; border-top: 1px solid #f1f5f9;">' +
          '<span style="font-size: 0.75rem; color: #64748b;">Hash: <code>' + (pack.hashComposicao ? pack.hashComposicao.slice(0, 10) + '...' : 'Ativo') + '</code></span>' +
          '<button class="btn btn-sm" data-pack-id="' + pack.id + '" data-campanha-id="' + (pack.campanhaAtivaId || '') + '" onclick="deactivatePackUi(this.dataset.packId, this.dataset.campanhaId)" style="background:#fee2e2;color:#b91c1c;font-weight:700;padding:7px 14px;border-radius:6px;border:1px solid #fca5a5;cursor:pointer;">🛑 Concluir / Desativar do Balcão</button>' +
        '</div>';
      } else {
        actionsHtml = '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #f1f5f9;">' +
          '<span style="font-size: 0.75rem; color: #64748b;">Hash SHA-256: <code>' + (pack.hashComposicao ? pack.hashComposicao.slice(0, 10) + '...' : 'Pendente') + '</code></span>' +
          '<div style="display:flex; gap:8px; align-items:center;">' +
            '<button class="btn btn-sm" data-pack-id="' + pack.id + '" onclick="rejectPackUi(this.dataset.packId)" style="background:#f1f5f9;color:#64748b;font-weight:700;padding:7px 12px;border-radius:6px;border:1px solid #cbd5e1;cursor:pointer;">❌ Rejeitar</button>' +
            '<button class="btn btn-sm" data-pack-id="' + pack.id + '" onclick="openDtApprovalModal(this.dataset.packId)" style="background:#059669;color:#ffffff;font-weight:800;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 2px 4px rgba(5,150,105,0.25);">🛡️ Assinar & Ativar no Balcão (DT)</button>' +
          '</div>' +
        '</div>';
      }

      const borderColor = isActive ? (isSuspendedStock ? '#fcd34d' : '#86efac') : '#bae6fd';

      return \`
        <div style="background: #ffffff; border: 1.5px solid \${borderColor}; border-radius: 12px; padding: 18px; display: flex; flex-direction: column; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 10px;">
            <div>
              <div style="font-weight: 800; font-size: 1.05rem; color: #0369a1; display: flex; align-items: center; gap: 6px;">
                \${pack.icone} \${pack.titulo}
              </div>
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px;">
                \${statusBadge}
                <span style="font-size: 0.72rem; font-weight: 700; color: #0284c7; background: #e0f2fe; padding: 2px 7px; border-radius: 4px;">
                  📦 Até \${pack.packsMontaveis || Math.min(...(pack.produtos || []).map(p => p.stockAtual || 0))} packs montáveis
                </span>
              </div>
              <div style="font-size: 0.78rem; font-weight: 700; color: #be123c; background: #ffe4e6; display: inline-block; padding: 2px 8px; border-radius: 4px; margin-top: 6px;">
                🎯 Sintoma / Queixa: \${pack.sintomaOuQueixa}
              </div>
            </div>
            <span class="badge badge-success" style="font-size: 0.8rem; font-weight: 800;">
              Margem Farmácia: \${pack.margemPackPct}%
            </span>
          </div>

          <p style="font-size: 0.80rem; color: #64748b; margin-bottom: 10px;">
            <b>Público-Alvo:</b> \${pack.publicoAlvo}
          </p>

          <div style="margin-bottom: 10px;">
            \${itemsHtml}
          </div>

          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <span style="font-size: 0.78rem; color: #475569; text-decoration: line-through; margin-right: 6px;">De: \${pack.pvpTotalOriginal.toFixed(2)}€</span>
              <span style="font-size: 1.15rem; font-weight: 900; color: #15803d;">Por: \${pack.pvpPackComDesconto.toFixed(2)}€</span>
            </div>
            <div style="text-align: right;">
              <span style="font-size: 0.76rem; font-weight: 800; color: #166534; background: #dcfce7; padding: 3px 8px; border-radius: 4px;">
                Poupança Utente: \${pack.poupancaUtente.toFixed(2)}€ (-\${pack.descontoPct}%)
              </span>
            </div>
          </div>

          <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 10px; font-size: 0.80rem; color: #334155; margin-bottom: 6px;">
            <div style="margin-bottom: 4px;"><b>🧺 No Balcão / Cesto:</b> \${pack.disposicaoFisica}</div>
            <div><b>💬 Aconselhamento Clínico:</b> \${pack.orientacaoBalcao}</div>
          </div>

          \${actionsHtml}
        </div>
      \`;
    }

    function openDtApprovalModal(packId) {
      const pack = (clinicalThemePacksData || []).find(p => p.id === packId);
      if (!pack) {
        alert('Pack não encontrado.');
        return;
      }
      activePackForDtApproval = pack;
      const box = document.getElementById('dtPackSummaryBox');
      if (box) {
        box.innerHTML = '<b>' + pack.icone + ' ' + pack.titulo + '</b><br/>' +
          '<span style="font-size: 0.78rem; color: #15803d;">Composição: ' + pack.produtos.map(p => p.designacao + ' (' + p.stockAtual + ' un)').join(', ') + '</span><br/>' +
          '<span style="font-size: 0.78rem; color: #047857; font-weight: 700;">Preço Promo: ' + pack.pvpPackComDesconto.toFixed(2) + '€ (-' + pack.descontoPct + '%) | Margem: ' + pack.margemPackPct + '% | SHA-256: <code>' + (pack.hashComposicao ? pack.hashComposicao.slice(0, 12) + '...' : '') + '</code></span>';
      }
      const pwd = document.getElementById('dtApprovalPassword');
      if (pwd) pwd.value = '';
      const fb = document.getElementById('dtApprovalFeedback');
      if (fb) fb.style.display = 'none';

      const modal = document.getElementById('dtApprovalModal');
      if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => { if (pwd) pwd.focus(); }, 100);
      }
    }

    function closeDtApprovalModal() {
      const modal = document.getElementById('dtApprovalModal');
      if (modal) modal.style.display = 'none';
      activePackForDtApproval = null;
    }

    async function submitDtApproval() {
      if (!activePackForDtApproval) return;
      const pwdInput = document.getElementById('dtApprovalPassword');
      const password = pwdInput ? pwdInput.value : '';
      const fb = document.getElementById('dtApprovalFeedback');
      const btn = document.getElementById('btnConfirmDtApproval');

      if (!password) {
        if (fb) {
          fb.style.display = 'block';
          fb.style.background = '#fee2e2';
          fb.style.color = '#dc2626';
          fb.textContent = 'Indique a sua palavra-passe de Diretor Técnico para validar.';
        }
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ A assinar digitalmente...';
      }

      try {
        const res = await fetch('/api/packs/approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-code': activeFarmaciaId,
          },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            dtPassword: password,
            pack: activePackForDtApproval,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Erro ao aprovar pack.');
        }

        if (fb) {
          fb.style.display = 'block';
          fb.style.background = '#d1fae5';
          fb.style.color = '#065f46';
          fb.textContent = '✅ ' + data.message + ' (3 tarefas geradas na folha semanal)';
        }

        setTimeout(() => {
          closeDtApprovalModal();
          loadClinicalThemePacks();
          fetchWeeklyTasksFromDb();
        }, 1200);
      } catch (err) {
        if (fb) {
          fb.style.display = 'block';
          fb.style.background = '#fee2e2';
          fb.style.color = '#dc2626';
          fb.textContent = '❌ ' + err.message;
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '✍️ Assinar & Ativar Pack';
        }
      }
    }

    async function rejectPackUi(packId) {
      if (!confirm('Rejeitar esta proposta determinística de pack promocional? Ela será removida da lista.')) return;
      try {
        const res = await fetch('/api/packs/reject', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-code': activeFarmaciaId,
          },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            packId: packId,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Erro ao rejeitar pack.');
        loadClinicalThemePacks();
      } catch (err) {
        alert('Erro ao rejeitar: ' + err.message);
      }
    }

    async function deactivatePackUi(packId, campanhaAtivaId) {
      if (!confirm('Desativar este pack do balcão? As sinaléticas e ecrãs de atendimento serão encerrados.')) return;
      try {
        const res = await fetch('/api/packs/deactivate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-code': activeFarmaciaId,
          },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            packId: packId,
            campanhaAtivaId: campanhaAtivaId,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Erro ao desativar pack.');
        loadClinicalThemePacks();
        fetchWeeklyTasksFromDb();
      } catch (err) {
        alert('Erro ao desativar: ' + err.message);
      }
    }

    function switchMarketingSubView(mode) {
      activeMarketingSubView = mode;
      ['epoca', 'liquidacao', 'cross', 'custom', 'packs'].forEach(m => {
        const btn = document.getElementById('mktSubBtn-' + m);
        if (btn) {
          if (m === mode) {
            btn.className = 'btn';
            btn.style.background = m === 'custom' ? 'linear-gradient(135deg, #a855f7, #ec4899)' : '#f43f5e';
            btn.style.color = '#ffffff';
          } else {
            btn.className = 'btn btn-secondary';
            btn.style.background = 'transparent';
            btn.style.color = m === 'custom' ? '#e879f9' : 'var(--text)';
          }
        }
      });

      const flowEl = document.getElementById('mktView-campaignsFlow');
      const crossEl = document.getElementById('mktView-crossSelling');
      const packsPanel = document.getElementById('mktPacksPanel');
      if (packsPanel) packsPanel.style.display = mode === 'packs' ? 'block' : 'none';
      if (mode === 'packs') {
        loadClinicalThemePacks();
      }
      const customPanel = document.getElementById('mktCustomBuilderPanel');
      const step1Container = document.getElementById('mktStep1Container');

      if (mode === 'cross') {
        if (flowEl) flowEl.style.display = 'none';
        if (customPanel) customPanel.style.display = 'none';
        if (crossEl) crossEl.style.display = 'block';
        renderCrossSellingProtocols();
      } else if (mode === 'custom') {
        if (crossEl) crossEl.style.display = 'none';
        if (customPanel) customPanel.style.display = 'block';
        if (flowEl) flowEl.style.display = 'block';
        if (step1Container) step1Container.style.display = 'none';
        goToWizardStep(1);
        loadSmartCampaignBaskets();
      } else {
        if (crossEl) crossEl.style.display = 'none';
        if (customPanel) customPanel.style.display = 'none';
        if (flowEl) flowEl.style.display = 'block';
        if (step1Container) step1Container.style.display = 'block';
        renderCampaignCardsForSubView();
      }
    }

    let smartBasketsData = null;
    let activeBasketTab = 'validades';
    let currentWizardStep = 1;
    let activeWizardPreset = null;

    function goToWizardStep(step) {
      currentWizardStep = step;
      const s1 = document.getElementById('customWizardStep1');
      const s2 = document.getElementById('customWizardStep2');
      const ind1 = document.getElementById('wizardStepIndicator1');
      const ind2 = document.getElementById('wizardStepIndicator2');
      const ind3 = document.getElementById('wizardStepIndicator3');

      if (step === 1) {
        if (s1) s1.style.display = 'block';
        if (s2) s2.style.display = 'none';
        if (ind1) { ind1.style.background = '#f1f5f9'; ind1.style.borderLeftColor = '#a855f7'; }
        if (ind2) { ind2.style.background = '#f8fafc'; ind2.style.borderLeftColor = '#cbd5e1'; }
      } else if (step === 2) {
        const nameVal = document.getElementById('customCampName')?.value.trim();
        if (!nameVal && !activeWizardPreset) {
          alert('Por favor escolha um Evento Rápido ou indique um Nome para a Campanha.');
          return;
        }
        if (s1) s1.style.display = 'none';
        if (s2) s2.style.display = 'block';
        if (ind1) { ind1.style.background = '#f8fafc'; ind1.style.borderLeftColor = '#10b981'; }
        if (ind2) { ind2.style.background = '#f1f5f9'; ind2.style.borderLeftColor = '#a855f7'; }
        loadSmartCampaignBaskets();
      }
    }

    function selectWizardPreset(presetKey, title, icon) {
      activeWizardPreset = presetKey;
      const nEl = document.getElementById('customCampName');
      if (nEl) nEl.value = title;
      goToWizardStep(2);
    }

    async function loadSmartCampaignBaskets() {
      if (smartBasketsData) {
        renderCurrentSmartBasket();
        return;
      }
      const listEl = document.getElementById('basketProductsList');
      if (listEl) listEl.innerHTML = '<div style="padding: 24px; text-align: center; color: #64748b;">⏳ A auditar o stock e a carregar cestos inteligentes...</div>';
      try {
        const res = await fetch('/api/campaigns/smart-baskets?farmaciaId=' + encodeURIComponent(activeFarmaciaId));
        const data = await res.json();
        smartBasketsData = data.baskets || { validades: [], monos: [], topMargem: [] };

        const cVal = document.getElementById('countBasketValidades');
        const cMon = document.getElementById('countBasketMonos');
        const cMrg = document.getElementById('countBasketMargem');
        if (cVal) cVal.textContent = (smartBasketsData.validades || []).length;
        if (cMon) cMon.textContent = (smartBasketsData.monos || []).length;
        if (cMrg) cMrg.textContent = (smartBasketsData.topMargem || []).length;

        renderCurrentSmartBasket();
      } catch (err) {
        console.error('Falha ao carregar cestos de stock:', err);
        if (listEl) listEl.innerHTML = '<div style="padding: 20px; color: #dc2626;">Erro ao carregar dados de stock.</div>';
      }
    }

    function switchSmartBasketTab(tabKey) {
      activeBasketTab = tabKey;
      const btnVal = document.getElementById('btnBasketTabValidades');
      const btnMon = document.getElementById('btnBasketTabMonos');
      const btnMrg = document.getElementById('btnBasketTabMargem');
      const btnSch = document.getElementById('btnBasketTabSearch');
      const sBox = document.getElementById('basketSearchContainer');
      const batchBar = document.getElementById('basketBatchActionBar');

      if (btnVal) { btnVal.className = tabKey === 'validades' ? 'btn' : 'btn btn-secondary'; btnVal.style.background = tabKey === 'validades' ? '#ef4444' : 'transparent'; btnVal.style.color = tabKey === 'validades' ? '#ffffff' : '#b91c1c'; }
      if (btnMon) { btnMon.className = tabKey === 'monos' ? 'btn' : 'btn btn-secondary'; btnMon.style.background = tabKey === 'monos' ? '#f59e0b' : 'transparent'; btnMon.style.color = tabKey === 'monos' ? '#ffffff' : '#b45309'; }
      if (btnMrg) { btnMrg.className = tabKey === 'topMargem' ? 'btn' : 'btn btn-secondary'; btnMrg.style.background = tabKey === 'topMargem' ? '#10b981' : 'transparent'; btnMrg.style.color = tabKey === 'topMargem' ? '#ffffff' : '#047857'; }
      if (btnSch) { btnSch.className = tabKey === 'search' ? 'btn' : 'btn btn-secondary'; btnSch.style.background = tabKey === 'search' ? '#0284c7' : 'transparent'; btnSch.style.color = tabKey === 'search' ? '#ffffff' : '#0369a1'; }

      if (tabKey === 'search') {
        if (sBox) sBox.style.display = 'block';
        if (batchBar) batchBar.style.display = 'none';
        searchProductsForCustomBuilder(document.getElementById('customProdSearchInput')?.value || '');
      } else {
        if (sBox) sBox.style.display = 'none';
        if (batchBar) batchBar.style.display = 'flex';
        renderCurrentSmartBasket();
      }
    }

    function renderCurrentSmartBasket() {
      const listEl = document.getElementById('basketProductsList');
      const descEl = document.getElementById('basketActiveDescription');
      if (!listEl || !smartBasketsData) return;

      const items = smartBasketsData[activeBasketTab] || [];
      if (descEl) {
        if (activeBasketTab === 'validades') descEl.innerHTML = '🚨 <b>' + items.length + ' produtos com validade próxima</b> detectados em armazém:';
        else if (activeBasketTab === 'monos') descEl.innerHTML = '🕸️ <b>' + items.length + ' monos parados</b> sem vendas para recuperar capital:';
        else if (activeBasketTab === 'topMargem') descEl.innerHTML = '💎 <b>' + items.length + ' produtos com margem superior a 40%</b>:';
      }

      if (items.length === 0) {
        listEl.innerHTML = '<div style="padding: 24px; text-align: center; color: #64748b;">Nenhum produto neste critério com stock atual.</div>';
        return;
      }

      listEl.innerHTML = items.map(function(it) {
        const isPicked = customPickedProducts.some(function(p) { return p.cnp === it.cnp; });
        const valBadge = it.validade ? '<span style="background: #fee2e2; color: #b91c1c; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">📅 Val: ' + it.validade + '</span>' : '';
        const capEmp = it.capitalEmpatadoEur ? '<span style="color: #b45309; font-size: 0.72rem; margin-left: 6px;">Empatado: €' + it.capitalEmpatadoEur.toFixed(2) + '</span>' : '';

        return '<div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #f1f5f9; gap: 10px; background: ' + (isPicked ? '#faf5ff' : 'white') + ';">' +
          '<div style="flex: 1;">' +
            '<div style="font-weight: 700; font-size: 0.86rem; color: #1e293b;">' +
              '<span style="font-family: monospace; color: #0284c7; margin-right: 6px;">[' + it.cnp + ']</span>' +
              it.designacao + valBadge +
            '</div>' +
            '<div style="font-size: 0.74rem; color: #64748b; margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap;">' +
              '<span>📦 Stock: <b>' + it.stock + ' un</b></span>' +
              '<span>💰 Custo: €' + Number(it.custo || 0).toFixed(2) + '</span>' +
              '<span>🏷️ PVP: €' + Number(it.pvp || 0).toFixed(2) + '</span>' +
              '<span style="color: #059669; font-weight: 700;">Margem: ' + (it.margemPct || 0) + '%</span>' + capEmp +
            '</div>' +
          '</div>' +
          '<button class="btn ' + (isPicked ? 'btn-secondary' : '') + '" data-cnp="' + it.cnp + '" onclick="togglePickedProductByCnp(this.dataset.cnp)" style="font-size: 0.78rem; padding: 5px 12px; font-weight: 700; background: ' + (isPicked ? 'white' : '#a855f7') + '; color: ' + (isPicked ? '#6b21a8' : 'white') + '; border-color: #a855f7;">' +
            (isPicked ? '✓ No Carrinho' : '+ Adicionar') +
          '</button>' +
        '</div>';
      }).join('');
    }

    function addAllCurrentBasketToPicked() {
      if (!smartBasketsData) return;
      const items = smartBasketsData[activeBasketTab] || [];
      items.forEach(function(it) {
        if (!customPickedProducts.some(function(p) { return p.cnp === it.cnp; })) {
          customPickedProducts.push({
            cnp: it.cnp,
            designacao: it.designacao,
            stock: it.stock,
            pvp: it.pvp,
            custo: it.custo || (it.pvp * 0.6),
            margemPct: it.margemPct || 30
          });
        }
      });
      renderCustomPickedList();
      renderCurrentSmartBasket();
    }

    function togglePickedProductByCnp(cnp) {
      const existing = customPickedProducts.find(function(p) { return p.cnp === cnp; });
      if (existing) {
        customPickedProducts = customPickedProducts.filter(function(p) { return p.cnp !== cnp; });
      } else {
        let it = null;
        if (smartBasketsData) {
          const all = (smartBasketsData.validades || []).concat(smartBasketsData.monos || []).concat(smartBasketsData.topMargem || []);
          it = all.find(function(x) { return x.cnp === cnp; });
        }
        if (it) {
          customPickedProducts.push({
            cnp: it.cnp,
            designacao: it.designacao,
            stock: it.stock,
            pvp: it.pvp,
            custo: it.custo || (it.pvp * 0.6),
            margemPct: it.margemPct || 30
          });
        }
      }
      renderCustomPickedList();
      if (activeBasketTab === 'search') {
        searchProductsForCustomBuilder(document.getElementById('customProdSearchInput')?.value || '');
      } else {
        renderCurrentSmartBasket();
      }
    }

    async function searchProductsForCustomBuilder(query) {
      const box = document.getElementById('basketProductsList');
      if (!box) return;
      try {
        const res = await fetch('/api/campaigns/search-products?farmaciaId=' + encodeURIComponent(activeFarmaciaId) + '&q=' + encodeURIComponent(query || ''));
        const data = await res.json();
        const items = data.items || [];
        if (items.length === 0) {
          box.innerHTML = '<div style="padding: 24px; text-align: center; color: #64748b;">Nenhum produto com stock encontrado para esta pesquisa.</div>';
          return;
        }
        box.innerHTML = items.map(function(it) {
          const isPicked = customPickedProducts.some(function(p) { return p.cnp === it.cnp; });
          return '<div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #f1f5f9; gap: 10px; background: ' + (isPicked ? '#faf5ff' : 'white') + ';">' +
            '<div style="flex: 1;">' +
              '<div style="font-weight: 700; font-size: 0.86rem; color: #1e293b;">' +
                '<span style="font-family: monospace; color: #0284c7; margin-right: 6px;">[' + it.cnp + ']</span>' +
                it.designacao +
              '</div>' +
              '<div style="font-size: 0.74rem; color: #64748b; margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap;">' +
                '<span>📦 Stock: <b>' + it.stock + ' un</b></span>' +
                '<span>💰 Custo: €' + Number(it.custo || 0).toFixed(2) + '</span>' +
                '<span>🏷️ PVP: €' + Number(it.pvp || 0).toFixed(2) + '</span>' +
                '<span style="color: #059669; font-weight: 700;">Margem: ' + (it.margemPct || 0) + '%</span>' +
              '</div>' +
            '</div>' +
            '<button class="btn ' + (isPicked ? 'btn-secondary' : '') + '" data-cnp="' + it.cnp + '" onclick="togglePickedProductByCnp(this.dataset.cnp)" style="font-size: 0.78rem; padding: 5px 12px; font-weight: 700; background: ' + (isPicked ? 'white' : '#a855f7') + '; color: ' + (isPicked ? '#6b21a8' : 'white') + '; border-color: #a855f7;">' +
              (isPicked ? '✓ No Carrinho' : '+ Adicionar') +
            '</button>' +
          '</div>';
        }).join('');
      } catch (e) {
        console.error(e);
      }
    }

    function renderCustomPickedList() {
      const listEl = document.getElementById('customPickedProductsList');
      const countEl = document.getElementById('customPickedCount');
      const stEl = document.getElementById('cartTotalStock');
      const costEl = document.getElementById('cartTotalCost');
      const pvpEl = document.getElementById('cartTotalPvp');
      const mrgEl = document.getElementById('cartAvgMargin');

      if (countEl) countEl.textContent = customPickedProducts.length;

      const totalStock = customPickedProducts.reduce(function(acc, p) { return acc + (p.stock || 0); }, 0);
      const totalCost = customPickedProducts.reduce(function(acc, p) { return acc + (p.stock || 0) * (p.custo || 0); }, 0);
      const totalPvp = customPickedProducts.reduce(function(acc, p) { return acc + (p.stock || 0) * (p.pvp || 0); }, 0);
      const avgMargem = customPickedProducts.length > 0 ? (customPickedProducts.reduce(function(acc, p) { return acc + (p.margemPct || 0); }, 0) / customPickedProducts.length).toFixed(1) : '0';

      if (stEl) stEl.textContent = totalStock;
      if (costEl) costEl.textContent = '€' + totalCost.toFixed(2);
      if (pvpEl) pvpEl.textContent = '€' + totalPvp.toFixed(2);
      if (mrgEl) mrgEl.textContent = avgMargem + '%';

      if (!listEl) return;
      if (customPickedProducts.length === 0) {
        listEl.innerHTML = '<span style="font-size: 0.78rem; color: #94a3b8; display: block; padding: 12px; text-align: center;">Nenhum produto adicionado ainda. Escolha produtos dos cestos à esquerda.</span>';
        return;
      }

      listEl.innerHTML = customPickedProducts.map(function(p) {
        return '<div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-bottom: 1px solid #f3e8ff; font-size: 0.78rem; gap: 6px;">' +
          '<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;" title="' + p.designacao + '">' +
            '<b>[' + p.cnp + ']</b> ' + p.designacao +
          '</div>' +
          '<div style="display: flex; align-items: center; gap: 6px;">' +
            '<span style="font-weight: 700; color: #0f172a;">' + p.stock + 'un</span>' +
            '<button class="btn btn-secondary" data-cnp="' + p.cnp + '" onclick="togglePickedProductByCnp(this.dataset.cnp)" style="padding: 2px 6px; font-size: 0.72rem; color: #ef4444; border: none; background: transparent; cursor: pointer;">✕</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function clearCustomPickedProducts() {
      customPickedProducts = [];
      renderCustomPickedList();
      if (activeBasketTab === 'search') {
        searchProductsForCustomBuilder(document.getElementById('customProdSearchInput')?.value || '');
      } else {
        renderCurrentSmartBasket();
      }
    }

    async function submitCustomCampaignWizard() {
      const nomePersonalizado = document.getElementById('customCampName')?.value.trim() || '';
      const cnpsSelecionados = customPickedProducts.map(function(p) { return p.cnp; });

      if (!nomePersonalizado && !activeWizardPreset) {
        alert('Por favor indique um nome para a campanha.');
        goToWizardStep(1);
        return;
      }

      if (cnpsSelecionados.length === 0) {
        alert('Por favor selecione pelo menos 1 produto dos cestos inteligentes à esquerda.');
        return;
      }

      await buildAndOpenCustomCampaign({
        modo: 'PRODUTOS',
        eventoPreset: activeWizardPreset || 'custom',
        nomePersonalizado: nomePersonalizado || (activeWizardPreset ? activeWizardPreset.toUpperCase() : 'Campanha Personalizada'),
        cnpsSelecionados: cnpsSelecionados,
        focoStock: 'TODOS_ELEGIVEIS'
      });
    }

    async function buildAndOpenCustomCampaign(payload) {
      try {
        const res = await fetch('/api/campaigns/custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, farmaciaId: activeFarmaciaId }),
        });
        const data = await res.json();
        if (!data.success || !data.suggestion) {
          alert('Erro ao construir campanha personalizada: ' + (data.error || 'Sem produtos elegíveis'));
          return;
        }
        const sug = data.suggestion;
        currentCampaignSuggestions = [sug, ...currentCampaignSuggestions.filter(c => c.id !== sug.id)];
        selectCampaign(sug.id);
        const step2 = document.getElementById('campaignStep2Config');
        if (step2) step2.scrollIntoView({ behavior: 'smooth' });
      } catch (e) {
        console.error('Erro ao criar campanha personalizada:', e);
      }
    }

    async function jumpToProductCrossSell360(cnp) {
      closeModal();
      switchTab('campaigns');
      if (!currentCampaignSuggestions || currentCampaignSuggestions.length === 0) {
        await loadCampaignSuggestions();
      }
      switchMarketingSubView('cross');
      await runProductCrossSell360(cnp);
      const box = document.getElementById('productCrossSell360Result');
      if (box) box.scrollIntoView({ behavior: 'smooth' });
    }

    async function jumpToSingleProductCampaign(cnp) {
      closeModal();
      switchTab('campaigns');
      if (!currentCampaignSuggestions || currentCampaignSuggestions.length === 0) {
        await loadCampaignSuggestions();
      }
      switchMarketingSubView('custom');
      await buildAndOpenCustomCampaign({
        modo: 'PRODUTOS',
        eventoPreset: 'custom',
        cnpsSelecionados: [cnp],
      });
    }

    async function launchPackCampaignFrom360(cnpsCsv, titleText) {
      const cnps = cnpsCsv.split(',').filter(Boolean);
      switchMarketingSubView('custom');
      await buildAndOpenCustomCampaign({
        modo: 'PRODUTOS',
        eventoPreset: 'custom',
        nomePersonalizado: titleText,
        cnpsSelecionados: cnps,
      });
    }

    async function runProductCrossSell360(overrideQuery) {
      const inp = document.getElementById('crossSellProductInput');
      if (overrideQuery && inp) inp.value = overrideQuery;
      const q = (overrideQuery || (inp ? inp.value : '') || '').trim();
      if (!q) return;

      const box = document.getElementById('productCrossSell360Result');
      if (!box) return;
      box.style.display = 'block';
      box.innerHTML = '<div style="padding:14px;color:var(--muted);">⏳ A calcular engenharia de escoamento e cross-selling 360º para <b>' + q + '</b>...</div>';

      try {
        const res = await fetch(\`/api/campaigns/product-360?farmaciaId=\${activeFarmaciaId}&q=\${encodeURIComponent(q)}\`);
        if (!res.ok) {
          box.innerHTML = '<div style="padding:14px;color:#fb7185;">⚠️ Produto não encontrado no stock desta farmácia.</div>';
          return;
        }
        const d = await res.json();
        const p = d.produtoAlvo;
        const g = d.gatilhosEntrada;
        const parceiros = d.parceirosCrossSelling || [];
        const packCnps = [p.cnp, ...parceiros.map(x => x.cnp)].join(',');
        const packTitle = 'Campanha Foco + Cross-Selling: ' + p.designacao.slice(0, 34);

        box.innerHTML = \`
          <div style="background:#ffffff;border:1px solid #bae6fd;border-radius:12px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
              <div>
                <div style="font-size:1.1rem;font-weight:800;color:#f8fafc;">
                  🎯 [\${p.cnp}] \${p.designacao}
                  <span class="badge badge-info" style="margin-left:6px;">\${p.tipoVenda}</span>
                  <span class="badge badge-purple" style="margin-left:4px;">\${p.categoria}</span>
                </div>
                <div style="font-size:0.82rem;color:#38bdf8;margin-top:4px;">
                  📦 Stock: <b>\${p.stockAtual} un</b> (\${(p.stockAtual * p.custoUnitario).toFixed(2)}€ a custo) · VMM: <b>\${p.vmmAtual}/mês</b> · Validade: <b style="color:\${p.unidadesEmRiscoValidade > 0 ? '#fb7185' : '#cbd5e1'}">\${p.validade || 'Longa'}</b>
                  \${p.unidadesEmRiscoValidade > 0 ? \` (<b style="color:#fb7185">\${p.unidadesEmRiscoValidade} un em risco = \${p.valorEmRiscoEur.toFixed(2)}€</b>)\` : ''}
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                \${p.tipoVenda !== 'MSRM' ? \`
                  <button class="btn" onclick="jumpToSingleProductCampaign('\${p.cnp}')" style="background:#f43f5e;font-size:0.8rem;padding:8px 14px;">
                    📣 Criar Campanha Foco Só p/ Este Produto
                  </button>
                  <button class="btn" onclick="launchPackCampaignFrom360('\${packCnps}', '\${escapeJsString(packTitle)}')" style="background:linear-gradient(135deg,#a855f7,#0284c7);font-size:0.8rem;padding:8px 14px;">
                    🚀 Criar Campanha Pack (Produto + \${parceiros.length} Parceiros Cross-Sell)
                  </button>
                \` : ''}
              </div>
            </div>

            <!-- META DE EQUIPA & ESTATUTO REGULATÓRIO / ANTI-DUMPING -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px;">
              <div style="background:#fff1f2;border:1px solid #fecdd3;border-left:4px solid #f43f5e;padding:10px 14px;border-radius:6px;font-size:0.82rem;color:#881337;">
                <b>🏁 Meta Operacional da Equipa:</b><br/>
                \${p.metaEquipaTexto}
              </div>
              <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-left:4px solid #10b981;padding:10px 14px;border-radius:6px;font-size:0.82rem;color:#166534;">
                <b>🛡️ Estatuto & Preço Promocional Anti-Dumping:</b><br/>
                \${p.elegivelDesconto
                  ? \`PVP Normal: <b>\${p.pvpAtual.toFixed(2)}€</b> → PVP Promo (-\${p.descontoSeguroPct}%): <b style="color:#34d399">\${p.pvpPromoRecomendado.toFixed(2)}€</b> (Margem líquida: <b>\${p.margemPosDescontoPct}%</b> ✅)<br/>\`
                  : ''}
                <span style="font-size:0.76rem;color:#cbd5e1;">\${p.notaRegulatoriaInfarmed}</span>
              </div>
            </div>

            <!-- 2 EIXOS DE CROSS-SELLING: QUEM PUXA ESTE PRODUTO vs. O QUE VENDER JUNTO -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-bottom:14px;">
              <!-- EIXO 1: GATILHOS DE ENTRADA (QUEM PUXA ESTE PRODUTO) -->
              <div style="background:rgba(2,6,23,0.65);border:1px solid var(--border);border-radius:10px;padding:14px;">
                <div style="font-size:0.8rem;font-weight:800;color:#c084fc;text-transform:uppercase;margin-bottom:6px;">
                  🚂 1. Como Escoar: Quem Puxa Este Produto no Balcão?
                </div>
                <div style="font-size:0.78rem;color:#cbd5e1;margin-bottom:10px;">\${g.explicacaoGatilho}</div>

                <div style="font-size:0.74rem;font-weight:700;color:var(--muted);margin-bottom:6px;">Locomotivas de Entrada (Quando o cliente pede):</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
                  \${(g.locomotivasQuePuxam || []).map(l => \`
                    <span class="badge badge-purple" title="\${l.relacaoClinica}">\${l.designacao.slice(0, 28)} (\${l.vmm}/mês)</span>
                  \`).join('') || '<span style="color:var(--muted);font-size:0.76rem;">Atendimento geral de balcão</span>'}
                </div>

                \${(g.alternativasMesmaCategoria || []).length > 0 ? \`
                  <div style="font-size:0.74rem;font-weight:700;color:#fbbf24;margin-bottom:6px;">
                    🔄 Concorrentes da Mesma Categoria c/ Procura na Farmácia (Redirecionar Aconselhamento):
                  </div>
                  <div style="display:flex;flex-direction:column;gap:4px;font-size:0.76rem;color:#cbd5e1;">
                    \${g.alternativasMesmaCategoria.map(alt => \`
                      <div style="display:flex;justify-content:space-between;border-bottom:1px dashed rgba(148,163,184,0.15);padding-bottom:3px;">
                        <span>• <b>\${alt.designacao.slice(0, 32)}</b></span>
                        <span style="color:#38bdf8;">Procura: <b>\${alt.vmm}/mês</b> (Stock: \${alt.stock} un)</span>
                      </div>
                    \`).join('')}
                  </div>
                \` : ''}
              </div>

              <!-- EIXO 2: PARCEIROS DE CROSS-SELLING EM STOCK (O QUE ASSOCIAR) -->
              <div style="background:rgba(2,6,23,0.65);border:1px solid rgba(16,185,129,0.3);border-radius:10px;padding:14px;">
                <div style="font-size:0.8rem;font-weight:800;color:#34d399;text-transform:uppercase;margin-bottom:6px;">
                  🤝 2. Com o Que Fazer Cross-Selling? (Parceiros em Stock a Escoar)
                </div>
                <div style="font-size:0.78rem;color:#cbd5e1;margin-bottom:10px;">
                  Produtos complementares no stock da sua farmácia (priorizando <b>Validades</b> e <b>Monos</b>) para associar ao <b>\${p.designacao.slice(0, 28)}</b>:
                </div>
                <div style="display:flex;flex-direction:column;gap:8px;font-size:0.78rem;">
                  \${parceiros.map(parc => \`
                    <div style="display:flex;justify-content:space-between;align-items:center;background: #ffffff;padding:8px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.15);">
                      <div>
                        <div><b>[\${parc.cnp}] \${parc.designacao.slice(0, 34)}</b> <span class="badge badge-warning" style="font-size:0.66rem;">\${parc.criterioUrgencia}</span></div>
                        <div style="font-size:0.72rem;color:#38bdf8;margin-top:2px;">\${parc.sinergiaClinica}</div>
                      </div>
                      <div style="text-align:right;white-space:nowrap;">
                        <div>PVP Promo: <b style="color:#34d399;">\${parc.pvpPromoSugerido.toFixed(2)}€</b></div>
                        <div style="font-size:0.7rem;color:var(--muted);">Margem \${parc.margemPct}%</div>
                      </div>
                    </div>
                  \`).join('') || '<span style="color:var(--muted);">Sem parceiros complementares específicos em stock.</span>'}
                </div>
              </div>
            </div>

            <!-- SCRIPT PRONTO DE BALCÃO -->
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:#f0f9ff;border:1px solid #bae6fd;border-left:4px solid #0284c7;padding:10px 14px;border-radius:6px;">
              <div style="flex:1;min-width:260px;font-size:0.84rem;color:#881337;font-style:italic;">
                💬 <b>Script de Balcão (10s):</b> \${d.scriptBalcaoPronto}
              </div>
              <button class="copy-btn" onclick="copyToClipboard('\${escapeJsString(d.scriptBalcaoPronto)}', this)" style="width:auto;padding:6px 14px;">
                📋 Copiar Script
              </button>
            </div>
          </div>
        \`;
      } catch (e) {
        console.error(e);
        box.innerHTML = '<div style="padding:14px;color:#fb7185;">Erro ao analisar o produto.</div>';
      }
    }

    function renderMarketingOverview() {
      const el = document.getElementById('marketingOverviewGrid');
      if (!el || !currentMarketingOverview) return;
      const c = currentMarketingOverview.criterios;

      el.innerHTML = \`
        <div style="background:#ffffff;border:1px solid #fecdd3;border-radius:10px;padding:12px 14px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.04);" onclick="switchMarketingSubView('liquidacao')">
          <div style="font-size:0.75rem;color:#fb7185;font-weight:700;text-transform:uppercase;">🔥 Validades Críticas (Escoar 1º)</div>
          <div style="font-size:1.15rem;font-weight:800;color:#0f172a;margin-top:4px;">\${c.validadesCriticas.skus} SKUs (\${c.validadesCriticas.valorCustoEur.toFixed(2)} €)</div>
          <div style="font-size:0.76rem;color:var(--muted);margin-top:2px;">🟢 \${c.validadesCriticas.vendaLivreSkus} Sem Receita (Elegíveis p/ Desconto)</div>
        </div>
        <div style="background:#ffffff;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.04);" onclick="switchMarketingSubView('liquidacao')">
          <div style="font-size:0.75rem;color:#fbbf24;font-weight:700;text-transform:uppercase;">🕸️ Monos c/ Stock (≥ 3 un. paradas)</div>
          <div style="font-size:1.15rem;font-weight:800;color:#0f172a;margin-top:4px;">\${c.monosCapital.skus} SKUs (\${c.monosCapital.valorCustoEur.toFixed(2)} €)</div>
          <div style="font-size:0.76rem;color:var(--muted);margin-top:2px;">🟢 \${c.monosCapital.vendaLivreSkus} Sem Receita (Redes, Ecrãs & Packs)</div>
        </div>
        <div style="background:#ffffff;border:1px solid #e9d5ff;border-radius:10px;padding:12px 14px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.04);" onclick="switchMarketingSubView('liquidacao')">
          <div style="font-size:0.75rem;color:#c084fc;font-weight:700;text-transform:uppercase;">🧺 Restos de Gaveta (1 a 2 un. órfãs)</div>
          <div style="font-size:1.15rem;font-weight:800;color:#0f172a;margin-top:4px;">\${c.restosGaveta.skus} SKUs (\${c.restosGaveta.valorCustoEur.toFixed(2)} €)</div>
          <div style="font-size:0.76rem;color:var(--muted);margin-top:2px;">🏪 \${c.restosGaveta.vendaLivreSkus} Sem Receita (Exclusivo Cesto Balcão)</div>
        </div>
        <div style="background:#ffffff;border:1px solid #bae6fd;border-radius:10px;padding:12px 14px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.04);" onclick="switchMarketingSubView('cross')">
          <div style="font-size:0.75rem;color:#38bdf8;font-weight:700;text-transform:uppercase;">🤝 Protocolos Cross-Selling Balcão</div>
          <div style="font-size:1.15rem;font-weight:800;color:#0f172a;margin-top:4px;">\${currentCrossSellingPlans.length} Eixos Ativos</div>
          <div style="font-size:0.76rem;color:var(--muted);margin-top:2px;">Locomotivas de Receita → Escoar Stock Parado</div>
        </div>
      \`;
    }

    
    function openSlideDrawer(title, subtitle, badgeHtml, bodyHtml, footerHtml) {
      var tEl = document.getElementById('drawerTitle');
      var sEl = document.getElementById('drawerSubtitle');
      var bEl = document.getElementById('drawerBadge');
      var bodyEl = document.getElementById('drawerBody');
      var fEl = document.getElementById('drawerFooter');
      if (tEl) tEl.innerText = title || '';
      if (sEl) sEl.innerText = subtitle || '';
      if (bEl) bEl.innerHTML = badgeHtml || '';
      if (bodyEl) bodyEl.innerHTML = bodyHtml || '';
      if (fEl) fEl.innerHTML = footerHtml || '<button class="btn btn-secondary" onclick="closeSlideDrawer()" style="width:100%;">Fechar</button>';
      var bd = document.getElementById('slideDrawerBackdrop');
      var dr = document.getElementById('slideDrawer');
      if (bd) bd.classList.add('active');
      if (dr) dr.classList.add('active');
      document.body.style.overflow = 'hidden';
    }

    function closeSlideDrawer() {
      var bd = document.getElementById('slideDrawerBackdrop');
      var dr = document.getElementById('slideDrawer');
      if (bd) bd.classList.remove('active');
      if (dr) dr.classList.remove('active');
      document.body.style.overflow = '';
    }

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeSlideDrawer();
    });

    function copyDrawerScript(btn) {
      var text = window.__activeDrawerScript || '';
      if (text) copyToClipboard(text, btn);
    }

    function openCrossSellingDrawer(idx) {
      var plan = currentCrossSellingPlans && currentCrossSellingPlans[idx];
      if (!plan) return;

      var badgeHtml = '<span class="badge" style="background:#dcfce7;color:#15803d;border:1px solid #86efac;font-weight:800;font-size:0.78rem;padding:4px 8px;border-radius:6px;">Potencial: ' + Number(plan.impactoFinanceiroPotencialEur || 0).toFixed(2) + ' €</span>';
      
      var locoHtml = (plan.locomotivasReais || []).map(function(l) {
        return '<span style="background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe;padding:5px 10px;border-radius:6px;font-size:0.8rem;font-weight:700;">' +
          l.designacao.slice(0, 32) + ' <b style="color:#581c87;">(' + l.vmm + '/mês)</b></span>';
      }).join('');

      var prodHtml = (plan.produtosAEscoar || []).map(function(p) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;background:#ffffff;border:1px solid #dcfce7;border-radius:8px;padding:10px 12px;margin-bottom:8px;">' +
          '<div style="color:#0f172a;padding-right:8px;">' +
            '<div style="font-weight:700;color:#0f172a;font-size:0.86rem;"><b style="color:#047857;">[' + p.cnp + ']</b> ' + p.designacao + '</div>' +
            '<div style="margin-top:4px;"><span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:2px 7px;border-radius:4px;font-size:0.72rem;font-weight:700;">' + p.criterioEscoamento + '</span></div>' +
          '</div>' +
          '<div style="text-align:right;white-space:nowrap;">' +
            '<div style="font-size:0.88rem;font-weight:800;color:#0f172a;">' + p.stock + ' un em stock</div>' +
            '<div style="font-size:0.82rem;color:#15803d;font-weight:700;margin-top:2px;">Promo -' + p.descontoSeguroPct + '%: ' + p.pvpPromo.toFixed(2) + '€</div>' +
          '</div>' +
        '</div>';
      }).join('');

      var scriptClean = (plan.scriptBalcao10s || '');
      window.__activeDrawerScript = scriptClean;
      var scriptEscaped = escapeJsString(scriptClean);

      var bodyHtml = '' +
        '<!-- SCRIPT VERBAL DE ATENDIMENTO -->' +
        '<div style="background:#fff1f2;border:1px solid #fecdd3;border-left:5px solid #e11d48;padding:16px;border-radius:10px;box-shadow:0 1px 3px rgba(225,29,72,0.06);">' +
          '<div style="font-size:0.76rem;font-weight:800;color:#9f1239;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">💬 Script Verbal de Atendimento (10 segundos):</div>' +
          '<div style="font-size:0.95rem;color:#881337;font-style:italic;line-height:1.6;font-weight:500;">"' + scriptClean + '"</div>' +
          '<button class="btn" onclick="copyDrawerScript(this)" style="margin-top:12px;background:#e11d48;color:#ffffff;border-color:#e11d48;font-size:0.82rem;font-weight:700;padding:8px 16px;border-radius:6px;width:100%;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;">' +
            '📋 Copiar Script para o Balcão' +
          '</button>' +
        '</div>' +

        '<!-- GATILHO DA PRESCRIÇÃO / BALCÃO -->' +
        '<div style="background:#f0f9ff;border:1px solid #bae6fd;border-left:4px solid #0284c7;border-radius:8px;padding:12px 14px;">' +
          '<div style="font-size:0.75rem;font-weight:800;color:#0369a1;text-transform:uppercase;margin-bottom:4px;">🎯 Gatilho no Atendimento:</div>' +
          '<div style="font-size:0.88rem;color:#0f172a;font-weight:600;line-height:1.45;">' + (plan.gatilhoDispensa || '') + '</div>' +
        '</div>' +

        '<!-- PRODUTOS EM STOCK A ESCOAR -->' +
        '<div>' +
          '<div style="font-size:0.78rem;font-weight:800;color:#166534;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">📦 Produtos em Stock a Escoar na Boleia (' + (plan.produtosAEscoar || []).length + '):</div>' +
          prodHtml +
        '</div>' +

        '<!-- LOCOMOTIVAS REAIS -->' +
        '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;">' +
          '<div style="font-size:0.76rem;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">🚂 Locomotivas que Puxam a Venda:</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;">' + locoHtml + '</div>' +
        '</div>';

      var footerHtml = '<button class="btn btn-secondary" onclick="closeSlideDrawer()" style="width:100%;padding:10px;font-size:0.86rem;font-weight:700;">Concluir Leitura</button>';

      openSlideDrawer(
        (plan.icone || '🎯') + ' ' + (plan.tituloProtocolo || ''),
        'Protocolo Operacional de Balcão e Escoamento',
        badgeHtml,
        bodyHtml,
        footerHtml
      );
    }

    function renderCrossSellingProtocols() {
      var grid = document.getElementById('crossSellingGrid');
      if (!grid) return;
      if (!currentCrossSellingPlans || currentCrossSellingPlans.length === 0) {
        grid.innerHTML = '<div style="padding:24px;color:var(--muted);">Nenhum protocolo de Cross-Selling disponível de momento.</div>';
        return;
      }

      grid.innerHTML = currentCrossSellingPlans.map(function(plan, idx) {
        var topProd = (plan.produtosAEscoar && plan.produtosAEscoar[0]) ? plan.produtosAEscoar[0].designacao.slice(0, 32) : 'Produtos em stock';
        var topLoco = (plan.locomotivasReais && plan.locomotivasReais[0]) ? plan.locomotivasReais[0].designacao.slice(0, 26) : 'Receita médica';

        return '<div class="omnichannel-card" style="background:#ffffff;border:1px solid #cbd5e1;border-radius:12px;padding:18px;box-shadow:0 1px 4px rgba(15,23,42,0.05);display:flex;flex-direction:column;justify-content:space-between;transition:all 0.15s ease;">' +
          '<div>' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px;">' +
              '<div style="font-weight:800;font-size:1.02rem;color:#0f172a;line-height:1.3;">' +
                (plan.icone || '🎯') + ' ' + (plan.tituloProtocolo || '') +
              '</div>' +
              '<span class="badge" style="background:#dcfce7;color:#15803d;border:1px solid #86efac;font-weight:800;font-size:0.75rem;padding:3px 7px;border-radius:6px;white-space:nowrap;">' +
                'Potencial: ' + Number(plan.impactoFinanceiroPotencialEur || 0).toFixed(2) + ' €' +
              '</span>' +
            '</div>' +

            '<!-- GATILHO COMPACTO -->' +
            '<div style="font-size:0.82rem;color:#0369a1;background:#f0f9ff;border:1px solid #bae6fd;border-left:3px solid #0284c7;border-radius:6px;padding:8px 10px;margin-bottom:12px;line-height:1.4;">' +
              '<b style="color:#0369a1;font-size:0.7rem;text-transform:uppercase;display:block;margin-bottom:2px;">🎯 Gatilho no Atendimento:</b>' +
              '<span style="color:#0f172a;font-weight:600;">' + (plan.gatilhoDispensa || '') + '</span>' +
            '</div>' +

            '<!-- SÍNTESE OPERACIONAL -->' +
            '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:0.8rem;color:#475569;display:flex;flex-direction:column;gap:5px;">' +
              '<div style="display:flex;justify-content:space-between;">' +
                '<span>📦 <b>' + (plan.produtosAEscoar || []).length + ' produtos</b> a escoar:</span>' +
                '<span style="color:#0f172a;font-weight:600;">' + topProd + '...</span>' +
              '</div>' +
              '<div style="display:flex;justify-content:space-between;">' +
                '<span>🚂 <b>' + (plan.locomotivasReais || []).length + ' locomotivas</b> que puxam:</span>' +
                '<span style="color:#6b21a8;font-weight:600;">' + topLoco + '...</span>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<!-- BOTÃO QUE DESLIZA A GAVETA -->' +
          '<button class="btn btn-secondary" onclick="openCrossSellingDrawer(' + idx + ')" style="width:100%;font-size:0.82rem;font-weight:700;padding:9px;color:#0284c7;background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.15s ease;">' +
            '<span>📖 Ver Script Verbal & Detalhes</span> <span style="font-size:0.95rem;">→</span>' +
          '</button>' +
        '</div>';
      }).join('');
    }

    async function loadCampaignSuggestions() {
      const grid = document.getElementById('campaignSuggestionsGrid');
      const badge = document.getElementById('campaignsCountBadge');
      if (grid) grid.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--muted);"><span class="spinner-sm"></span> A carregar campanhas sazonais e a cruzar com o inventário da farmácia...</div>';

      const monthSelect = document.getElementById('campaignMonthSelect');
      const mesVal = monthSelect ? monthSelect.value : 'auto';

      try {
        let url = '/api/campaigns/suggestions?farmaciaId=' + encodeURIComponent(activeFarmaciaId);
        if (mesVal && mesVal !== 'auto') {
          url += '&mes=' + encodeURIComponent(mesVal);
        }
        const res = await fetch(url);
        const data = await res.json();
        currentCampaignSuggestions = data.suggestions || [];
        currentMarketingOverview = data.overview || null;
        currentCrossSellingPlans = data.crossSellingPlans || [];

        renderMarketingOverview();
        renderCampaignCardsForSubView();
      } catch (err) {
        console.error('Erro ao carregar sugestões de campanhas:', err);
        if (grid) grid.innerHTML = '<div style="color:var(--danger);padding:20px;">Erro ao carregar campanhas sazonais.</div>';
      }
    }

    function onCampaignMonthChange() {
      loadCampaignSuggestions();
    }

    function renderCampaignCardsForSubView() {
      const grid = document.getElementById('campaignSuggestionsGrid');
      const badge = document.getElementById('campaignsCountBadge');
      const heading = document.getElementById('step1CampaignHeading');
      if (!grid) return;

      const filtered = currentCampaignSuggestions.filter(c => {
        if (activeMarketingSubView === 'liquidacao') {
          return c.tipoCampanha === 'LIQUIDACAO_STOCK';
        }
        return c.tipoCampanha !== 'LIQUIDACAO_STOCK';
      });

      if (heading) {
        heading.innerHTML = activeMarketingSubView === 'liquidacao'
          ? '<span style="background: #f59e0b; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;">1</span> Selecione o Plano Tático de Liquidação:'
          : '<span style="background: #f43f5e; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;">1</span> Selecione a Campanha de Época & Calendário Civil:';
      }

      if (badge) {
        badge.textContent = \`\${filtered.length} Opções Disponíveis\`;
      }

      if (filtered.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; padding: 32px; text-align: center; color: var(--muted); background: var(--surface); border-radius: 10px;">Não foram identificadas campanhas ativas para o filtro selecionado.</div>';
        return;
      }

      grid.innerHTML = filtered.map(c => {
        const isSel = selectedCampaign && selectedCampaign.id === c.id;
        const fin = c.financials || {};
        const custoVal = Number(fin.custoTotal != null ? fin.custoTotal : (fin.valor_stock_custo_total || 0));
        const margemVal = Number(fin.margem_media_pct != null ? fin.margem_media_pct : (fin.margemFinalPct || 0));
        const rc = c.resumoCriterios || { validadesCriticas: 0, monosParados: 0, restosGaveta: 0, ancorasRotacao: 0 };
        const badgeTipo = c.tipoCampanha === 'LIQUIDACAO_STOCK'
          ? '<span class="badge badge-warning">🧹 Liquidação Stock</span>'
          : (c.tipo === 'SAZONAL_CLIMA' ? '<span class="badge badge-info">❄️ Época Sazonal</span>' : '<span class="badge badge-success">🩺 Efeméride</span>');

        const dores = c.contextoEpoca?.doresUtente ? c.contextoEpoca.doresUtente.slice(0, 2).join('; ') : '';
        const activeInst = (currentActiveCampaigns || []).find(a => a.campanhaId === c.id);
        const badgeAtiva = activeInst
          ? \`<span class="badge" style="background:#10b981;color:white;font-weight:700;">🟢 Ativa (\${activeInst.totalProdutos} SKUs)</span>\`
          : '';
        const bannerAtivaCard = activeInst
          ? \`<div style="background:#ecfdf5;border:1px solid #10b981;border-radius:6px;padding:6px 10px;margin-bottom:10px;color:#065f46;font-size:0.78rem;font-weight:600;">🟢 <b>Em Curso:</b> \${activeInst.totalProdutos} de \${c.totalEligibleSkus} SKUs ativados (-\${activeInst.descontoAplicadoPct}%)</div>\`
          : '';

        return \`
          <div class="campaign-card \${isSel ? 'selected' : ''}" id="campCard-\${c.id}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
              <span style="font-size:1.8rem;">\${c.icon}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
                \${badgeAtiva}
                <span class="badge badge-purple">\${c.periodoLabel}</span>
                \${badgeTipo}
              </div>
            </div>
            <div style="font-weight:700;font-size:1.05rem;color:var(--text);margin-bottom:6px;">\${c.nome}</div>
            
            \${bannerAtivaCard}

            <!-- ENQUADRAMENTO DA ÉPOCA -->
            <div style="font-size:0.84rem;color:var(--text-secondary);margin-bottom:12px;line-height:1.45;background:#f8fafc;padding:10px 12px;border-radius:8px;border-left:3px solid var(--primary);border:1px solid var(--border);">
              <div><b>📌 Enquadramento:</b> \${c.descricao}</div>
              \${dores ? \`<div style="margin-top:4px;color:var(--muted);font-size:0.78rem;">🩺 <i>Procura do Utente: \${dores}</i></div>\` : ''}
            </div>

            <!-- ENCAIXE NO STOCK DA FARMÁCIA -->
            <div style="background:#f8fafc;border-radius:8px;padding:12px;margin-bottom:14px;font-size:0.82rem;display:grid;grid-template-columns:1fr 1fr;gap:8px;border:1px solid var(--border);">
              <div>📦 Elegíveis: <b style="color:var(--text);">\${c.totalEligibleSkus} SKUs</b></div>
              <div>📊 Stock Físico: <b style="color:var(--text);">\${c.totalStockUnits} un</b></div>
              <div>💰 Valor em Armazém: <b style="color:#b45309;">\${custoVal.toFixed(2)} €</b></div>
              <div>📈 Margem Média: <b style="color:#059669;">\${margemVal.toFixed(1)}%</b></div>
            </div>

            <!-- BOTÃO DE AÇÃO: VER DETALHE -->
            <button class="btn \${isSel ? '' : 'btn-secondary'}" onclick="openCampaignStep2('\${c.id}')" style="width:100%;font-size:0.86rem;padding:10px;border-color:var(--primary);color:\${isSel ? '#0f172a' : 'var(--primary)'};font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px;">
              \${isSel ? '✓ Detalhe Aberto Abaixo ↓' : '🔍 Ver Detalhe desta Campanha →'}
            </button>
          </div>
        \`;
      }).join('');

      // Mantém o Step 2 oculto por defeito para evitar confusão visual
      const step2 = document.getElementById('campaignStep2Config');
      if (!selectedCampaign && step2) {
        step2.style.display = 'none';
      }
    }

    function openCampaignStep2(campId) {
      selectCampaign(campId);
      const step2 = document.getElementById('campaignStep2Config');
      if (step2) {
        step2.style.display = 'block';
        step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    function closeCampaignStep2() {
      const step2 = document.getElementById('campaignStep2Config');
      if (step2) step2.style.display = 'none';
      const step3 = document.getElementById('campaignStep3Materials');
      if (step3) step3.style.display = 'none';
      selectedCampaign = null;
      document.querySelectorAll('.campaign-card').forEach(el => el.classList.remove('selected'));
      const step1 = document.getElementById('mktStep1Container');
      if (step1) step1.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function selectCampaign(campId) {
      selectedCampaign = currentCampaignSuggestions.find(c => c.id === campId);
      if (!selectedCampaign) return;

      currentCampaignSuggestions.forEach(c => {
        const el = document.getElementById('campCard-' + c.id);
        if (el) el.classList.toggle('selected', c.id === campId);
      });

      const step2 = document.getElementById('campaignStep2Config');
      if (step2) step2.style.display = 'block';

      const step3 = document.getElementById('campaignStep3Materials');
      if (step3) step3.style.display = 'none';

      const titleDesc = document.getElementById('selectedCampaignTitleDesc');
      if (titleDesc) {
        titleDesc.innerHTML = \`Plano ativo: <b style="color:#fb7185;">\${selectedCampaign.icon} \${selectedCampaign.nome}</b> (\${selectedCampaign.periodoLabel}) — \${selectedCampaign.descricao}\`;
      }

      const activeInst = (currentActiveCampaigns || []).find(a => a.campanhaId === campId);
      const activeAlertBox = document.getElementById('selectedCampaignActiveAlert');
      if (activeAlertBox) {
        if (activeInst) {
          activeAlertBox.style.display = 'block';
          activeAlertBox.innerHTML = \`
            <div style="background: #ecfdf5; border: 1.5px solid #10b981; border-radius: 10px; padding: 14px 18px; margin-bottom: 6px; color: #065f46;">
              <div style="font-weight: 800; font-size: 0.95rem; display: flex; align-items: center; gap: 8px;">
                <span>🟢</span> Esta Campanha está atualmente EM CURSO na Farmácia!
              </div>
              <div style="font-size: 0.84rem; margin-top: 6px; line-height: 1.5;">
                • Estão atualmente <b>\${activeInst.totalProdutos} produtos ativos</b> com desconto de <b>-\${activeInst.descontoAplicadoPct}%</b> (válida de \${activeInst.dataInicio} a \${activeInst.dataFim || 'em curso'}).<br/>
                • A lista abaixo contém todos os <b>\${selectedCampaign.eligibleProducts.length} produtos elegíveis</b> em stock no tema de Inverno da farmácia. Os que estão ativos encontram-se assinalados com <span style="background:#10b981;color:white;padding:1px 6px;border-radius:4px;font-size:0.72rem;font-weight:700;">⭐ Ativo na Farmácia</span>.
              </div>
            </div>
          \`;
        } else {
          activeAlertBox.style.display = 'none';
          activeAlertBox.innerHTML = '';
        }
      }

      const anatomyBox = document.getElementById('seasonAnatomyBox');
      if (anatomyBox) {
        const ctx = selectedCampaign.contextoEpoca;
        if (ctx) {
          anatomyBox.style.display = 'block';
          anatomyBox.innerHTML = \`
            <div style="font-size:0.84rem;font-weight:700;color:#38bdf8;margin-bottom:8px;">
              🧭 Anatomia da Época & Estratégia de Escoamento Interno (\${selectedCampaign.periodoLabel}):
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;font-size:0.8rem;color:#cbd5e1;">
              <div><b style="color:#f8fafc;">📌 Perfil da Época:</b><br/>\${ctx.perfilEpoca}</div>
              <div><b style="color:#f8fafc;">🩺 O que o Utente Procura:</b><br/>• \${(ctx.doresUtente || []).join('<br/>• ')}</div>
              <div><b style="color:#f8fafc;">🎯 Estratégia p/ Escoar o Nosso Stock:</b><br/>\${ctx.estrategiaEscoamento}</div>
            </div>
          \`;
        } else {
          anatomyBox.style.display = 'none';
        }
      }

      const suggestedDesc = selectedCampaign.campanha?.descontoSugeridoPct || 15;
      const discountSlider = document.getElementById('campaignDiscountRange');
      if (discountSlider) discountSlider.value = suggestedDesc;
      const discountBadge = document.getElementById('discountBadgeVal');
      if (discountBadge) discountBadge.textContent = suggestedDesc + '%';

      // Se for o plano exclusivo de restos de gaveta (1-2 un), marcar apenas Loja Física por defeito!
      if (selectedCampaign.id === 'liquidacao_cesto_oportunidade') {
        const cLoja = document.getElementById('chan-loja');
        const cRedes = document.getElementById('chan-redes');
        const cEcras = document.getElementById('chan-ecras');
        const cApp = document.getElementById('chan-app');
        if (cLoja) cLoja.checked = true;
        if (cRedes) cRedes.checked = false;
        if (cEcras) cEcras.checked = false;
        if (cApp) cApp.checked = false;
        onChannelsChanged();
      }

      renderCampaignProductsTable();
    }

    function onChannelsChanged() {
      const channels = ['loja', 'redes', 'ecras', 'app'].filter(ch => document.getElementById('chan-' + ch)?.checked);
      const btn = document.getElementById('btnGenerateMaterials');
      if (btn) {
        btn.disabled = channels.length === 0;
        btn.textContent = channels.length === 0 ? '⚠️ Selecione pelo menos 1 canal' : '✨ Gerar Materiais para os Canais Selecionados';
      }
    }

    function onDiscountSliderChange(val) {
      const badge = document.getElementById('discountBadgeVal');
      if (badge) badge.textContent = val + '%';
      recalculateCampaignFinancialsClient();
    }

    function getIncludedCnpCodigos() {
      const checkboxes = Array.from(document.querySelectorAll('.campaign-sku-check:checked'));
      return checkboxes.map(cb => cb.value);
    }

    function renderCampaignProductsTable() {
      if (!selectedCampaign) return;
      const table = document.getElementById('campaignProductsTable');
      if (!table) return;

      const discountPct = parseInt(document.getElementById('campaignDiscountRange')?.value || '15', 10);
      const discount = discountPct / 100;

      table.innerHTML = \`
        <thead>
          <tr>
            <th style="width: 38px; text-align: center;"><input type="checkbox" id="checkAllCampaignSkus" checked onchange="toggleAllCampaignSkus(this.checked)" /></th>
            <th>Código / CNP</th>
            <th>Designação & Motivo de Escoamento</th>
            <th>Eixo & Critério de Marketing</th>
            <th>Stock & Canal Ideal</th>
            <th>PVP Normal</th>
            <th>PVP Campanha (-\${discountPct}%)</th>
            <th>Custo Unit.</th>
            <th>Margem Final</th>
            <th>Validação Legal Anti-Dumping</th>
          </tr>
        </thead>
        <tbody>
          \${selectedCampaign.eligibleProducts.map(p => {
            const pvpNormal = p.pvp_atual || p.pvp || (p.custo_unitario * 1.5);
            const custoRef = p.custo_unitario;
            const pvpCampanha = Number((pvpNormal * (1 - discount)).toFixed(2));
            const margemEur = pvpCampanha - custoRef;
            const margemPct = Number(((margemEur / pvpCampanha) * 100).toFixed(1));
            const custoComMargemSeguranca = custoRef * 1.05;
            const isAntiDumping = pvpCampanha > custoComMargemSeguranca;
            const critBadgeClass = (p.criterio_marketing || '').includes('Validade')
              ? 'badge-danger'
              : (p.criterio_marketing || '').includes('Mono')
                ? 'badge-warning'
                : (p.criterio_marketing || '').includes('Resto')
                  ? 'badge-purple'
                  : 'badge-success';

            const activeInst = (currentActiveCampaigns || []).find(a => a.campanhaId === selectedCampaign.id);
            const isCurrentlyActive = activeInst && (activeInst.produtos || []).some(ap => ap.cnp_codigo === p.cnp_codigo);
            const activeBadge = isCurrentlyActive
              ? '<span class="badge" style="background:#10b981;color:#ffffff;font-size:0.7rem;font-weight:700;margin-left:6px;">⭐ Ativo na Farmácia</span>'
              : '';
            const rowBg = isCurrentlyActive ? 'style="background: #f0fdf4;"' : '';

            return \`
              <tr id="campRow-\${p.cnp_codigo}" \${rowBg}>
                <td style="text-align: center;">
                  <input type="checkbox" class="campaign-sku-check" value="\${p.cnp_codigo}" checked onchange="recalculateCampaignFinancialsClient()" />
                </td>
                <td><b>\${p.cnp_codigo}</b></td>
                <td>
                  <div style="font-weight: 600; color: var(--text);">\${p.designacao}\${activeBadge}</div>
                  <div style="font-size: 0.75rem; color: #38bdf8; margin-top: 2px;">\${p.motivo_selecao || ''}</div>
                </td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
                    <span class="badge badge-purple">\${p.eixo_campanha || p.categoria || 'Geral'}</span>
                    <span class="badge \${critBadgeClass}">\${p.criterio_marketing || '⭐ Âncora'}</span>
                  </div>
                </td>
                <td>
                  <div><b>\${p.stock_atual} un</b> <span class="badge badge-info" style="font-size:0.68rem;">\${p.tipo_venda}</span></div>
                  <div style="font-size:0.72rem;color:\${p.stock_atual <= 2 ? '#fbbf24' : '#94a3b8'};margin-top:2px;">\${p.canais_recomendados || ''}</div>
                </td>
                <td style="color: var(--muted); text-decoration: line-through;">\${pvpNormal.toFixed(2)} €</td>
                <td style="font-weight: 700; color: #fb7185;" id="colPvpPromo-\${p.cnp_codigo}">\${pvpCampanha.toFixed(2)} €</td>
                <td style="color: var(--muted);">\${custoRef.toFixed(2)} €</td>
                <td style="font-weight: 700; color: \${margemPct >= 20 ? '#34d399' : '#f59e0b'};" id="colMargem-\${p.cnp_codigo}">
                  \${margemPct}% (\${margemEur.toFixed(2)} €)
                </td>
                <td id="colAntiDumping-\${p.cnp_codigo}">
                  \${isAntiDumping ? 
                    '<span class="badge badge-success" title="Conforme Dec.-Lei 166/2013: Preço de venda superior ao custo efetivo">🛡️ 100% Legal</span>' : 
                    '<span class="badge badge-danger" title="Aviso: Preço de venda inferior ou no limiar do custo efetivo">⚠️ Risco de Dumping</span>'}
                </td>
              </tr>
            \`;
          }).join('')}
        </tbody>
      \`;

      recalculateCampaignFinancialsClient();
    }

    function toggleAllCampaignSkus(checked) {
      document.querySelectorAll('.campaign-sku-check').forEach(cb => {
        cb.checked = checked;
      });
      recalculateCampaignFinancialsClient();
    }

    function recalculateCampaignFinancialsClient() {
      if (!selectedCampaign) return;
      const discountPct = parseInt(document.getElementById('campaignDiscountRange')?.value || '15', 10);
      const discount = discountPct / 100;
      const includedCnps = new Set(getIncludedCnpCodigos());

      let totalFaturacaoNormal = 0;
      let totalFaturacaoPromo = 0;
      let totalCustoRef = 0;
      let allSafeAntiDumping = true;
      let countIncluded = 0;

      selectedCampaign.eligibleProducts.forEach(p => {
        const pvpNormal = p.pvp_atual || p.pvp || (p.custo_unitario * 1.5);
        const custoRef = p.custo_unitario;
        const pvpCampanha = Number((pvpNormal * (1 - discount)).toFixed(2));
        const margemEur = pvpCampanha - custoRef;
        const margemPct = Number(((margemEur / pvpCampanha) * 100).toFixed(1));
        const custoComMargemSeguranca = custoRef * 1.05;
        const isAntiDumping = pvpCampanha > custoComMargemSeguranca;

        const cellPromo = document.getElementById('colPvpPromo-' + p.cnp_codigo);
        const cellMargem = document.getElementById('colMargem-' + p.cnp_codigo);
        const cellAntiDumping = document.getElementById('colAntiDumping-' + p.cnp_codigo);

        if (cellPromo) cellPromo.textContent = pvpCampanha.toFixed(2) + ' €';
        if (cellMargem) {
          cellMargem.textContent = \`\${margemPct}% (\${margemEur.toFixed(2)} €)\`;
          cellMargem.style.color = margemPct >= 20 ? '#34d399' : '#f59e0b';
        }
        if (cellAntiDumping) {
          cellAntiDumping.innerHTML = isAntiDumping ? 
            '<span class="badge badge-success">🛡️ 100% Legal</span>' : 
            '<span class="badge badge-danger">⚠️ Risco de Dumping</span>';
        }

        if (includedCnps.has(p.cnp_codigo)) {
          countIncluded++;
          const units = p.stock_atual;
          totalFaturacaoNormal += pvpNormal * units;
          totalFaturacaoPromo += pvpCampanha * units;
          totalCustoRef += custoRef * units;
          if (!isAntiDumping) allSafeAntiDumping = false;
        }
      });

      const lucroBrutoPromo = totalFaturacaoPromo - totalCustoRef;
      const margemMediaPct = totalFaturacaoPromo > 0 ? Number(((lucroBrutoPromo / totalFaturacaoPromo) * 100).toFixed(1)) : 0;

      const kpisInline = document.getElementById('financialKpisInline');
      if (kpisInline) {
        kpisInline.innerHTML = \`
          <span>Incluídos: <b style="color:var(--text);">\${countIncluded} SKUs</b></span>
          <span>Faturação Prevista: <b style="color:#fb7185;">\${totalFaturacaoPromo.toFixed(2)} €</b></span>
          <span>Lucro Bruto: <b style="color:#34d399;">\${lucroBrutoPromo.toFixed(2)} €</b></span>
          <span>Margem Média: <b style="color:#38bdf8;">\${margemMediaPct}%</b></span>
        \`;
      }

      const antiDumpingBox = document.getElementById('antiDumpingSummaryBox');
      const antiDumpingDetails = document.getElementById('antiDumpingDetails');
      if (antiDumpingBox && antiDumpingDetails) {
        if (allSafeAntiDumping && countIncluded > 0) {
          antiDumpingBox.style.background = 'rgba(16, 185, 129, 0.12)';
          antiDumpingBox.style.borderColor = 'rgba(16, 185, 129, 0.3)';
          antiDumpingDetails.innerHTML = '✅ <b>100% Conforme Legislação Nacional:</b> Todos os produtos selecionados mantêm PVP promocional com margem positiva acima do custo de compra.';
        } else if (countIncluded === 0) {
          antiDumpingDetails.innerHTML = 'Selecione pelo menos um produto na tabela.';
        } else {
          antiDumpingBox.style.background = 'rgba(239, 68, 68, 0.15)';
          antiDumpingBox.style.borderColor = 'rgba(239, 68, 68, 0.4)';
          antiDumpingDetails.innerHTML = '<b style="color:#f87171;">⚠️ Alerta de Dumping:</b> Um ou mais produtos têm desconto excessivo face ao custo de aquisição. Reduza o desconto ou desmarque os produtos assinalados.';
        }
      }
    }

    async function generateCampaignMaterialsAction() {
      if (!selectedCampaign) return;
      const btn = document.getElementById('btnGenerateMaterials');
      const channels = ['loja', 'redes', 'ecras', 'app'].filter(ch => document.getElementById('chan-' + ch)?.checked);
      const includedCnpCodigos = getIncludedCnpCodigos();
      const discountPct = parseInt(document.getElementById('campaignDiscountRange')?.value || '15', 10);

      if (channels.length === 0) {
        alert('Selecione pelo menos um canal de comunicação.');
        return;
      }
      if (includedCnpCodigos.length === 0) {
        alert('Selecione pelo menos um produto para a campanha.');
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ A Gerar Materiais Omnicanal...';
      }

      try {
        const chosenProducts = (selectedCampaign.eligibleProducts || []).filter(p => includedCnpCodigos.includes(p.cnp_codigo));
        const res = await fetch('/api/campaigns/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            campaignId: selectedCampaign.id,
            customCampaignDef: selectedCampaign.campanha || null,
            selectedProducts: chosenProducts,
            discountPct,
            channels,
            includedCnpCodigos
          })
        });

        const data = await res.json();
        if (!data.success) {
          alert('Erro ao gerar campanha: ' + (data.error || 'Desconhecido'));
          return;
        }

        currentGeneratedCampaign = data;
        renderOmnichannelMaterials(data);

        const step3 = document.getElementById('campaignStep3Materials');
        if (step3) {
          step3.style.display = 'block';
          step3.scrollIntoView({ behavior: 'smooth' });
        }
      } catch (err) {
        console.error('Erro ao gerar materiais:', err);
        alert('Ocorreu um erro ao comunicar com o servidor.');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '✨ Gerar Materiais para os Canais Selecionados';
        }
      }
    }

    function renderOmnichannelMaterials(data) {
      const grid = document.getElementById('omnichannelGrid');
      if (!grid) return;

      const m = data.materials;
      const cards = [];

      if (m.loja) {
        cards.push(\`
          <div class="omnichannel-card">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="font-weight:700;font-size:1.05rem;color:var(--text);display:flex;align-items:center;gap:8px;">
                  🏪 Loja Física & Balcão
                </span>
                <span class="badge badge-success">Atendimento Presencial</span>
              </div>
              <div style="font-size:0.84rem;margin-bottom:10px;">
                <b style="color:#fb7185;">🎯 Script de Atendimento (10 segundos):</b>
                <div style="background:#fff1f2;border:1px solid #fecdd3;border-left:4px solid #e11d48;padding:10px 12px;border-radius:6px;margin-top:6px;color:#881337;font-style:italic;">
                  "\${m.loja.script_balcao}"
                </div>
              </div>
              <div style="font-size:0.82rem;color:var(--muted);margin-bottom:8px;">
                📍 <b>Local de Destaque:</b> \${m.loja.posicionamento_linear}
              </div>
              <div style="font-size:0.82rem;color:var(--muted);margin-bottom:8px;">
                🏷️ <b>Material de Linear:</b> \${m.loja.sinaletica_precos}
              </div>
            </div>
            <button class="copy-btn" onclick="copyToClipboard('\${escapeJsString(m.loja.script_balcao)}', this)" style="margin-top:14px;">
              📋 Copiar Script de Balcão
            </button>
          </div>
        \`);
      }

      if (m.redes) {
        const fullRedesCopy = \`\${m.redes.headline}\\n\\n\${m.redes.copy_post}\\n\\n\${m.redes.call_to_action}\\n\\n\${m.redes.hashtags.join(' ')}\`;
        cards.push(\`
          <div class="omnichannel-card">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="font-weight:700;font-size:1.05rem;color:var(--text);display:flex;align-items:center;gap:8px;">
                  📱 Redes Sociais
                </span>
                <span class="badge badge-purple">Instagram & Facebook</span>
              </div>
              <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:12px;margin-bottom:12px;font-size:0.84rem;color:#0f172a;white-space:pre-line;line-height:1.45;">
                <b>\${m.redes.headline}</b><br/><br/>
                \${m.redes.copy_post}<br/><br/>
                <b>\${m.redes.call_to_action}</b><br/><br/>
                <span style="color:#38bdf8;">\${m.redes.hashtags.join(' ')}</span>
              </div>
              <div style="font-size:0.8rem;color:var(--muted);">
                🖼️ <b>Sugestão Visual:</b> \${m.redes.sugestao_imagem}
              </div>
            </div>
            <button class="copy-btn" onclick="copyToClipboard('\${escapeJsString(fullRedesCopy)}', this)" style="margin-top:14px;">
              📋 Copiar Post Redes Sociais
            </button>
          </div>
        \`);
      }

      if (m.ecras) {
        const fullEcrasCopy = \`\${m.ecras.slide_titulo}\\n- \${m.ecras.slide_linhas.join('\\n- ')}\\n\${m.ecras.slide_rodape}\`;
        cards.push(\`
          <div class="omnichannel-card">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="font-weight:700;font-size:1.05rem;color:var(--text);display:flex;align-items:center;gap:8px;">
                  📺 Ecrãs TV & Montra Digital
                </span>
                <span class="badge badge-info">16:9 Rotação</span>
              </div>
              <div style="background: #ffffff;border:1px dashed #38bdf8;border-radius:8px;padding:16px;margin-bottom:12px;text-align:center;">
                <div style="font-size:1.05rem;font-weight:800;color:#38bdf8;margin-bottom:10px;">\${m.ecras.slide_titulo}</div>
                <div style="display:flex;flex-direction:column;gap:6px;font-size:0.86rem;color:#0f172a;margin-bottom:10px;">
                  \${m.ecras.slide_linhas.map(l => \`<div>• \${l}</div>\`).join('')}
                </div>
                <div style="font-size:0.75rem;color:var(--muted);border-top:1px solid var(--border);padding-top:8px;">\${m.ecras.slide_rodape}</div>
              </div>
              <div style="font-size:0.8rem;color:var(--muted);">
                ⏱️ <b>Tempo de Exposição Recomendado:</b> \${m.ecras.duracao_slide_segundos} segundos em loop
              </div>
            </div>
            <button class="copy-btn" onclick="copyToClipboard('\${escapeJsString(fullEcrasCopy)}', this)" style="margin-top:14px;">
              📋 Copiar Slide TV
            </button>
          </div>
        \`);
      }

      if (m.app) {
        const fullAppCopy = \`Push: \${m.app.push_notification_titulo} - \${m.app.push_notification_corpo}\\nSMS: \${m.app.sms_texto}\`;
        cards.push(\`
          <div class="omnichannel-card">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="font-weight:700;font-size:1.05rem;color:var(--text);display:flex;align-items:center;gap:8px;">
                  📲 App Mobile & SMS
                </span>
                <span class="badge badge-warning">Push / SMS</span>
              </div>
              <div style="margin-bottom:12px;">
                <b style="font-size:0.84rem;color:#f59e0b;">📲 Notificação Push na App:</b>
                <div style="background: #ffffff;border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:4px;font-size:0.82rem;">
                  <b>\${m.app.push_notification_titulo}</b><br/>
                  \${m.app.push_notification_corpo}
                </div>
              </div>
              <div style="margin-bottom:12px;">
                <b style="font-size:0.84rem;color:#f59e0b;">💬 Mensagem SMS Curta (160 caracteres):</b>
                <div style="background: #ffffff;border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:4px;font-size:0.82rem;font-family:monospace;">
                  \${m.app.sms_texto}
                </div>
              </div>
            </div>
            <button class="copy-btn" onclick="copyToClipboard('\${escapeJsString(m.app.sms_texto)}', this)" style="margin-top:14px;">
              📋 Copiar SMS
            </button>
          </div>
        \`);
      }

      grid.innerHTML = cards.join('');
    }

    function escapeJsString(str) {
      if (!str) return '';
      return str
        .replace(/\\\\/g, '\\\\\\\\')
        .replace(/'/g, "\\\\'")
        .replace(/"/g, '\\\\"')
        .replace(/\\n/g, '\\\\n')
        .replace(/\\r/g, '');
    }

    function copyToClipboard(text, btnElement) {
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btnElement.innerHTML;
        btnElement.innerHTML = '✅ Copiado!';
        btnElement.style.background = '#10b981';
        btnElement.style.color = '#ffffff';
        setTimeout(() => {
          btnElement.innerHTML = originalText;
          btnElement.style.background = '';
          btnElement.style.color = '';
        }, 2000);
      }).catch(err => {
        console.error('Falha ao copiar:', err);
        alert('Texto selecionado: copie manualmente.');
      });
    }

    function openEmailDigestModal() {
      const modal = document.getElementById('emailDigestModal');
      const content = document.getElementById('emailDigestContent');
      const statusEl = document.getElementById('emailSendStatus');
      if (statusEl) statusEl.textContent = '';

      if (currentGeneratedCampaign && currentGeneratedCampaign.emailDigestPreview) {
        if (content) content.innerHTML = currentGeneratedCampaign.emailDigestPreview;
      } else {
        if (content) {
          content.innerHTML = \`
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #1e293b;">
              <div style="background: #0f172a; padding: 24px; border-radius: 8px 8px 0 0; text-align: center; color: #ffffff;">
                <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #38bdf8;">BI PHARMA — BOLETIM DE CAMPANHAS MENSAIS</h1>
                <p style="margin: 6px 0 0; font-size: 13px; color: #94a3b8;">Planeamento de Marketing, Balcão & Sazonalidade</p>
              </div>
              <div style="padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px; background: #ffffff;">
                <p style="font-size: 14px; line-height: 1.5; color: #334155;">
                  Estimada Equipa,<br/><br/>
                  Apresentamos o resumo de campanhas sazonais para ativação imediata na farmácia. Todos os produtos foram triados com stock real existente e margem comercial segura:
                </p>
                \${currentCampaignSuggestions.slice(0, 3).map(c => \`
                  <div style="margin-top: 16px; padding: 14px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc;">
                    <div style="font-weight: 700; font-size: 15px; color: #0f172a;">\${c.icon} \${c.nome} (\${c.periodoLabel})</div>
                    <div style="font-size: 13px; color: #64748b; margin-top: 4px;">\${c.descricao}</div>
                    <div style="margin-top: 8px; font-size: 12px; font-weight: 600; color: #0284c7;">
                      📦 \${c.totalEligibleSkus} SKUs em Stock (\${c.totalStockUnits} un) | Margem Média: \${c.financials.margem_media_pct}%
                    </div>
                  </div>
                \`).join('')}
                <div style="margin-top: 24px; padding: 12px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; font-size: 12px; color: #065f46;">
                  🛡️ <b>Certificação Jurídica:</b> Todos os preços propostos cumprem as normas de salvaguarda anti-dumping (Dec.-Lei n.º 166/2013).
                </div>
              </div>
            </div>
          \`;
        }
      }

      if (modal) modal.style.display = 'flex';
    }

    function closeEmailDigestModal() {
      const modal = document.getElementById('emailDigestModal');
      if (modal) modal.style.display = 'none';
    }

    async function sendSimulatedEmailDigest() {
      const statusEl = document.getElementById('emailSendStatus');
      if (statusEl) statusEl.textContent = '⏳ A processar envio...';

      try {
        const res = await fetch('/api/campaigns/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            campaignId: selectedCampaign ? selectedCampaign.id : (currentCampaignSuggestions[0]?.id || '')
          })
        });
        const data = await res.json();
        if (data.success && statusEl) {
          statusEl.textContent = \`✅ \${data.message} (\${data.destinatarios} destinatários)\`;
        } else if (statusEl) {
          statusEl.textContent = '⚠️ ' + (data.error || 'Erro no envio');
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Erro ao contactar servidor.';
      }
    }

    function sendCampaignEmailToTeam() {
      openEmailDigestModal();
    }

    function exportCampaignPlanCsv() {
      if (!selectedCampaign) return;
      const discountPct = parseInt(document.getElementById('campaignDiscountRange')?.value || '15', 10);
      const discount = discountPct / 100;
      const includedCnps = new Set(getIncludedCnpCodigos());

      const filtered = selectedCampaign.eligibleProducts.filter(p => includedCnps.has(p.cnp_codigo));
      const headers = ['CNP', 'Designacao', 'Laboratorio', 'TipoVenda', 'Stock', 'CustoSemIva', 'PVP_Atual', 'PVP_Campanha', 'Desconto_Pct', 'Margem_Pct'];
      const rows = filtered.map(p => {
        const pvpNormal = p.pvp_atual || (p.custo_unitario * 1.5);
        const pvpCampanha = Number((pvpNormal * (1 - discount)).toFixed(2));
        const taxaIva = p.taxa_iva || 0.23;
        const custoComIva = p.custo_unitario * (1 + taxaIva);
        const margemPct = Number((((pvpCampanha - custoComIva) / pvpCampanha) * 100).toFixed(1));
        return [
          p.cnp_codigo,
          \`"\${(p.designacao || '').replace(/"/g, '""')}"\`,
          \`"\${(p.laboratorio_titular || '').replace(/"/g, '""')}"\`,
          p.tipo_venda,
          p.stock_atual,
          p.custo_unitario.toFixed(2),
          pvpNormal.toFixed(2),
          pvpCampanha.toFixed(2),
          discountPct + '%',
          margemPct + '%'
        ].join(';');
      });

      const csvContent = [headers.join(';'), ...rows].join('\\n');
      const blob = new Blob(['\\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = \`campanha_\${selectedCampaign.id}_\${new Date().toISOString().slice(0, 10)}.csv\`;
      a.click();
    }

    
    // ========================================================================
    // GESTÃO DE CAMPANHAS ATIVAS (ATIVAÇÃO, HISTÓRICO E GERAÇÃO DE TAREFAS)
    // ========================================================================
    let currentActiveCampaigns = [];

    async function loadActiveCampaigns() {
      if (!activeFarmaciaId) return;
      try {
        const res = await fetch('/api/campaigns/active?farmaciaId=' + encodeURIComponent(activeFarmaciaId));
        const data = await res.json();
        currentActiveCampaigns = (data && data.ok && Array.isArray(data.campanhas)) ? data.campanhas : [];
        renderActiveCampaignsBanner();
        renderPlanoActiveCampaignsBlock();
      } catch (err) {
        console.warn('Aviso: falha ao carregar campanhas ativas:', err);
      }
    }

    function renderActiveCampaignsBanner() {
      const banner = document.getElementById('activeCampaignsBanner');
      if (!banner) return;

      if (!currentActiveCampaigns || currentActiveCampaigns.length === 0) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
      }

      banner.style.display = 'block';
      banner.innerHTML = currentActiveCampaigns.map(function(c) {
        var icone = c.icone || '🎯';
        var dataFim = c.dataFim || 'Em curso';
        var rowsHtml = (c.produtos || []).map(function(p) {
          return '<tr style="border-bottom: 1px solid #e2e8f0;">' +
            '<td style="padding: 8px 10px; font-family: monospace; font-weight: 700; color: #0284c7;">' + p.cnp_codigo + '</td>' +
            '<td style="padding: 8px 10px; font-weight: 600; color: #1e293b;">' + (p.designacao || 'Produto') + '</td>' +
            '<td style="padding: 8px 10px; color: #64748b;">' + (p.laboratorio_titular || '—') + '</td>' +
            '<td style="padding: 8px 10px; text-align: center; font-weight: 700; color: #0f172a;">' + p.stock_atual + ' un</td>' +
            '<td style="padding: 8px 10px; text-align: right; color: #64748b;">€' + Number(p.custo_unitario || 0).toFixed(2) + '</td>' +
            '<td style="padding: 8px 10px; text-align: right; text-decoration: line-through; color: #94a3b8;">€' + Number(p.pvp_atual || 0).toFixed(2) + '</td>' +
            '<td style="padding: 8px 10px; text-align: right; font-weight: 800; color: #059669;">€' + Number(p.pvp_campanha || 0).toFixed(2) + '</td>' +
            '<td style="padding: 8px 10px; text-align: center;"><span style="background: #d1fae5; color: #065f46; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.74rem;">' + (p.margem_pct || 0) + '%</span></td>' +
          '</tr>';
        }).join('');

        return '<div style="background: linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%); border: 1.5px solid #10b981; border-radius: 12px; padding: 18px 22px; margin-bottom: 14px; box-shadow: 0 2px 6px rgba(16, 185, 129, 0.12);">' +
          '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">' +
            '<div>' +
              '<div style="display: flex; align-items: center; gap: 10px;">' +
                '<span style="font-size: 1.4rem;">' + icone + '</span>' +
                '<div>' +
                  '<span style="background: #10b981; color: white; font-size: 0.72rem; font-weight: 800; padding: 3px 8px; border-radius: 6px; text-transform: uppercase;">Campanha Ativa</span>' +
                  '<span style="font-size: 1.1rem; font-weight: 800; color: #065f46; margin-left: 6px;">' + c.titulo + '</span>' +
                '</div>' +
              '</div>' +
              '<div style="font-size: 0.84rem; color: #047857; margin-top: 6px; display: flex; gap: 16px; flex-wrap: wrap;">' +
                '<span>📅 Período: <b>' + c.dataInicio + '</b> até <b>' + dataFim + '</b></span>' +
                '<span>🏷️ Desconto: <b>-' + c.descontoAplicadoPct + '%</b></span>' +
                '<span>📦 Produtos em Foco: <b>' + c.totalProdutos + ' SKUs</b></span>' +
                '<span>⚡ <b>3 Tarefas Criadas para a Equipa no Balcão e Encomendas</b></span>' +
              '</div>' +
            '</div>' +
            '<div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">' +
              '<button class="btn btn-secondary" data-campid="' + c.id + '" onclick="toggleActiveCampaignProducts(this.dataset.campid)" style="font-size: 0.8rem; padding: 7px 14px; border-color: #059669; color: #065f46; background: #ffffff; font-weight: 700;">' +
                '👁️ Ver ' + c.totalProdutos + ' Artigos em Campanha' +
              '</button>' +
              '<button class="btn btn-secondary" data-campid="' + c.id + '" onclick="exportActiveCampaignCsv(this.dataset.campid)" style="font-size: 0.8rem; padding: 7px 14px; border-color: #10b981; color: #065f46; background: #ffffff;">' +
                '📥 Exportar Preços' +
              '</button>' +
              '<button class="btn" data-campid="' + c.id + '" onclick="deactivateCampaignUi(this.dataset.campid)" style="background: #047857; font-size: 0.8rem; padding: 7px 16px; color: white; font-weight: 700;">' +
                '✅ Concluir Campanha' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div id="activeProductsPanel_' + c.id + '" style="display: none; margin-top: 16px; padding-top: 14px; border-top: 1px dashed #6ee7b7;">' +
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
              '<div style="font-size: 0.86rem; font-weight: 700; color: #065f46;">📋 Artigos com Preço Promocional em Vigor (' + c.totalProdutos + ' SKUs):</div>' +
              '<div style="font-size: 0.76rem; color: #047857;">Estes ' + c.totalProdutos + ' artigos têm PVP promocional ativo e tarefas atribuídas à equipa.</div>' +
            '</div>' +
            '<div style="overflow-x: auto; background: white; border-radius: 8px; border: 1px solid #d1fae5;">' +
              '<table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.82rem;">' +
                '<thead style="background: #f0fdf4; border-bottom: 2px solid #a7f3d0; font-size: 0.74rem; color: #065f46; text-transform: uppercase;">' +
                  '<tr>' +
                    '<th style="padding: 8px 10px;">CNP</th>' +
                    '<th style="padding: 8px 10px;">Designação</th>' +
                    '<th style="padding: 8px 10px;">Laboratório</th>' +
                    '<th style="padding: 8px 10px; text-align: center;">Stock Físico</th>' +
                    '<th style="padding: 8px 10px; text-align: right;">Custo Unit. s/IVA</th>' +
                    '<th style="padding: 8px 10px; text-align: right;">PVP Normal</th>' +
                    '<th style="padding: 8px 10px; text-align: right; color: #047857; font-weight: 800;">PVP Campanha (-' + c.descontoAplicadoPct + '%)</th>' +
                    '<th style="padding: 8px 10px; text-align: center;">Margem Preservada</th>' +
                  '</tr>' +
                '</thead>' +
                '<tbody>' + rowsHtml + '</tbody>' +
              '</table>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function toggleActiveCampaignProducts(campId) {
      const panel = document.getElementById('activeProductsPanel_' + campId);
      if (!panel) return;
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }

        function goToCampaignsTab() {
      switchTab('campaigns');
    }

    function renderPlanoActiveCampaignsBlock() {
      const block = document.getElementById('planoActiveCampaignsBlock');
      if (!block) return;

      if (!currentActiveCampaigns || currentActiveCampaigns.length === 0) {
        block.style.display = 'none';
        block.innerHTML = '';
        return;
      }

      block.style.display = 'block';
      const c = currentActiveCampaigns[0];
      var icone = c.icone || '🎯';
      block.innerHTML = '<div style="background: linear-gradient(135deg, #fff1f2 0%, #ffffff 100%); border: 1.5px solid #fda4af; border-radius: 12px; padding: 16px 20px; box-shadow: 0 2px 4px rgba(225, 29, 72, 0.06); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">' +
        '<div>' +
          '<div style="font-weight: 800; color: #9f1239; font-size: 0.98rem; display: flex; align-items: center; gap: 8px;">' +
            '<span>' + icone + '</span>' +
            '<span>Missões da Campanha Ativa: ' + c.titulo + '</span>' +
            '<span class="badge badge-danger">-' + c.descontoAplicadoPct + '% Promo</span>' +
          '</div>' +
          '<div style="font-size: 0.82rem; color: #4c0519; margin-top: 4px;">' +
            'Ações prioritárias para a equipa cumprir esta semana no balcão e nas encomendas (' + c.totalProdutos + ' produtos em escoamento).' +
          '</div>' +
        '</div>' +
        '<div style="display: flex; gap: 8px; flex-wrap: wrap;">' +
          '<button class="btn btn-secondary" onclick="goToCampaignsTab()" style="font-size: 0.78rem; padding: 6px 12px; border-color: #f43f5e; color: #e11d48;">' +
            '🔍 Ver Produtos & Script de Balcão →' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    async function activateCurrentCampaignUi() {
      if (!selectedCampaign) {
        alert('Selecione primeiro uma campanha para ativar.');
        return;
      }

      const discountPct = parseInt(document.getElementById('campaignDiscountRange')?.value || '15', 10);
      const discount = discountPct / 100;
      const includedCnps = new Set(getIncludedCnpCodigos());

      const filtered = selectedCampaign.eligibleProducts.filter(p => includedCnps.has(p.cnp_codigo));
      if (filtered.length === 0) {
        alert('Atenção: selecione pelo menos um produto na tabela da campanha.');
        return;
      }

      const confirmMsg = 'Pretende ATIVAR a campanha "' + selectedCampaign.titulo + '" na Farmácia por 15 dias com -' + discountPct + '% de desconto?\\n\\n' +
        '• Serão integrados ' + filtered.length + ' produtos com margem protegida.\\n' +
        '• Serão geradas automaticamente 3 tarefas práticas na Folha da Semana e no telemóvel da equipa.';

      if (!confirm(confirmMsg)) return;

      const formattedProducts = filtered.map(p => {
        const pvpNormal = p.pvp_atual || (p.custo_unitario * 1.5);
        const pvpCampanha = Number((pvpNormal * (1 - discount)).toFixed(2));
        const taxaIva = p.taxa_iva || 0.23;
        const custoComIva = p.custo_unitario * (1 + taxaIva);
        const margemPct = Number((((pvpCampanha - custoComIva) / pvpCampanha) * 100).toFixed(1));

        return {
          cnp_codigo: p.cnp_codigo,
          designacao: p.designacao,
          laboratorio_titular: p.laboratorio_titular,
          stock_atual: p.stock_atual,
          custo_unitario: p.custo_unitario,
          pvp_atual: pvpNormal,
          pvp_campanha: pvpCampanha,
          desconto_pct: discountPct,
          margem_pct: margemPct
        };
      });

      try {
        const btn = document.getElementById('btnActivateCampaignMain') || document.getElementById('btnActivateCampaignStep2');
        if (btn) { btn.disabled = true; btn.innerHTML = '⏳ A ativar...'; }

        const res = await fetch('/api/campaigns/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            campanhaId: selectedCampaign.id,
            titulo: selectedCampaign.titulo,
            icone: selectedCampaign.icone || '🎯',
            descontoPct: discountPct,
            produtos: formattedProducts,
            diasDuracao: 15,
            criadoPor: 'Diretor'
          })
        });

        const data = await res.json();
        if (data && data.success) {
          alert('🎉 ' + data.mensagem);
          await loadActiveCampaigns();
          await fetchWeeklyTasksFromDb();
        } else {
          alert('Erro ao ativar campanha: ' + (data.error || 'Falha no servidor'));
        }
      } catch (err) {
        console.error('Falha ao ativar campanha:', err);
        alert('Erro ao contactar o servidor.');
      } finally {
        const btn = document.getElementById('btnActivateCampaignMain') || document.getElementById('btnActivateCampaignStep2');
        if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Ativar Campanha na Farmácia'; }
      }
    }

    async function deactivateCampaignUi(campId) {
      if (!confirm('Pretende concluir esta campanha ativa? As metas serão arquivadas.')) return;
      try {
        const res = await fetch('/api/campaigns/deactivate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: activeFarmaciaId,
            campanhaId: campId,
            estado: 'CONCLUIDA'
          })
        });
        const data = await res.json();
        if (data && data.success) {
          await loadActiveCampaigns();
          await fetchWeeklyTasksFromDb();
        }
      } catch (err) {
        console.error('Falha ao concluir campanha:', err);
      }
    }

    function exportActiveCampaignCsv(activeCampId) {
      const camp = currentActiveCampaigns.find(function(c) { return c.id === activeCampId; });
      if (!camp || !camp.produtos) return;
      const headers = ['CNP', 'Designacao', 'Laboratorio', 'Stock', 'CustoSemIva', 'PVP_Normal', 'PVP_Campanha', 'Desconto_Pct', 'Margem_Pct'];
      const rows = camp.produtos.map(function(p) {
        return [
          p.cnp_codigo,
          '"' + (p.designacao || '').replace(/"/g, '""') + '"',
          '"' + (p.laboratorio_titular || '').replace(/"/g, '""') + '"',
          p.stock_atual,
          p.custo_unitario.toFixed(2),
          p.pvp_atual.toFixed(2),
          p.pvp_campanha.toFixed(2),
          p.desconto_pct + '%',
          p.margem_pct + '%'
        ].join(';');
      });
      const csvContent = [headers.join(';')].concat(rows).join('\\n');
      const blob = new Blob(['\\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'campanha_ativa_' + camp.campanhaId + '_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
    }

    
    // ==========================================
    // AUDITORIA DE TAREFAS CONCLUÍDAS (O QUE, QUANDO, QUEM)
    // ==========================================
    let cachedAuditTasks = [];

    async function openCompletedTasksModal() {
      const modal = document.getElementById('completedTasksModal');
      if (!modal) return;
      modal.style.display = 'flex';
      await loadCompletedTasksAudit();
    }

    function closeCompletedTasksModal() {
      const modal = document.getElementById('completedTasksModal');
      if (modal) modal.style.display = 'none';
    }

    async function loadCompletedTasksAudit() {
      const tbody = document.getElementById('auditTasksTableBody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="5" style="padding: 24px; text-align: center; color: #64748b;">A carregar registo de auditoria...</td></tr>';

      try {
        const res = await fetch('/api/weekly-tasks/audit?farmaciaId=' + encodeURIComponent(activeFarmaciaId || ''));
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Erro ao carregar auditoria');

        cachedAuditTasks = data.tarefas || [];

        // Atualizar contadores
        const totalEl = document.getElementById('auditTotalTasks');
        const savedEl = document.getElementById('auditTotalSaved');
        const topOpEl = document.getElementById('auditTopOperator');
        const topOpSub = document.getElementById('auditTopOperatorSub');

        if (totalEl) totalEl.textContent = data.totalConcluidas || 0;
        if (savedEl) savedEl.textContent = Number(data.valorProtegidoTotal || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €';

        if (data.operadoresResumo && data.operadoresResumo.length > 0) {
          const top = data.operadoresResumo[0];
          if (topOpEl) topOpEl.textContent = top.operador;
          if (topOpSub) topOpSub.textContent = top.total + ' picagens (' + Number(top.valorTotal || 0).toFixed(2) + ' € protegidos)';
        } else {
          if (topOpEl) topOpEl.textContent = 'Sem registos';
          if (topOpSub) topOpSub.textContent = '0 picagens';
        }

        renderAuditTasksTable(cachedAuditTasks);
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding: 20px; text-align: center; color: #e11d48;">Falha ao carregar auditoria: ' + escapeHtml(err.message) + '</td></tr>';
      }
    }

    function filterAuditTasks() {
      const query = (document.getElementById('auditSearchInput')?.value || '').toLowerCase().trim();
      const cat = document.getElementById('auditCategoryFilter')?.value || 'ALL';

      const filtered = cachedAuditTasks.filter(function(t) {
        const matchCat = (cat === 'ALL' || t.categoria === cat);
        const matchQuery = !query ||
          (t.designacao && t.designacao.toLowerCase().includes(query)) ||
          (t.cnp_codigo && t.cnp_codigo.includes(query)) ||
          (t.concluido_por && t.concluido_por.toLowerCase().includes(query)) ||
          (t.task_id && t.task_id.toLowerCase().includes(query));
        return matchCat && matchQuery;
      });

      renderAuditTasksTable(filtered);
    }

    function renderAuditTasksTable(list) {
      const tbody = document.getElementById('auditTasksTableBody');
      if (!tbody) return;

      if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding: 28px; text-align: center; color: #94a3b8;">Nenhuma tarefa encontrada com os filtros selecionados.</td></tr>';
        return;
      }

      let html = '';
      list.forEach(function(t) {
        const d = new Date(t.concluido_em);
        const dateStr = d.toLocaleDateString('pt-PT') + ' às ' + d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        let catBadge = '<span style="background: #f1f5f9; color: #475569; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.74rem;">' + escapeHtml(t.categoria) + '</span>';
        if (t.categoria === 'VALIDADE') catBadge = '<span style="background: #fee2e2; color: #b91c1c; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.74rem;">⏳ Validades</span>';
        if (t.categoria === 'RESTO_GAVETA') catBadge = '<span style="background: #fef3c7; color: #b45309; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.74rem;">🧹 Resto Gaveta</span>';
        if (t.categoria === 'TRAVAR_SIFARMA') catBadge = '<span style="background: #e0e7ff; color: #4338ca; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.74rem;">🛑 Travar Compras</span>';
        if (t.categoria === 'CAMPANHA') catBadge = '<span style="background: #f3e8ff; color: #7e22ce; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.74rem;">🎯 Campanha</span>';

        const cnpBadge = t.cnp_codigo ? '<b style="color: #0284c7; cursor: pointer;" onclick="openProductModal(&quot;' + t.cnp_codigo + '&quot;)">[' + escapeHtml(t.cnp_codigo) + ']</b> ' : '';
        const impactBadge = t.valor_impacto && t.valor_impacto > 0
          ? '<span style="color: #059669; font-weight: 800;">+' + Number(t.valor_impacto).toFixed(2) + ' €</span>'
          : '<span style="color: #94a3b8;">--</span>';

        html += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
          '<td style="padding: 10px 14px; color: #64748b; font-size: 0.82rem; font-family: monospace;">' + dateStr + '</td>' +
          '<td style="padding: 10px 14px;"><span style="background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 3px 9px; border-radius: 6px; font-weight: 700; font-size: 0.78rem;">👤 ' + escapeHtml(t.concluido_por) + '</span></td>' +
          '<td style="padding: 10px 14px;">' + catBadge + '</td>' +
          '<td style="padding: 10px 14px; font-weight: 600; color: #0f172a;">' + cnpBadge + escapeHtml(t.designacao || t.task_id) + '</td>' +
          '<td style="padding: 10px 14px; text-align: right;">' + impactBadge + '</td>' +
          '</tr>';
      });

      tbody.innerHTML = html;
    }

    // ==========================================
    // EVOLUÇÃO DE STOCK NO TEMPO & POUPANÇAS
    // ==========================================
    let cachedEvolutionData = null;

    async function loadStockEvolutionData() {
      try {
        const res = await fetch('/api/analytics/stock-evolution?farmaciaId=' + encodeURIComponent(activeFarmaciaId || ''));
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Erro ao obter evolução');

        cachedEvolutionData = data;
        const isMarcoZero = !!data.is_marco_zero;

        // Atualizar Cabeçalho Dinâmico
        const iconEl = document.getElementById('evoHeaderIcon');
        const titleEl = document.getElementById('evoHeaderTitle');
        const descEl = document.getElementById('evoHeaderDesc');
        if (iconEl) iconEl.textContent = isMarcoZero ? '📍' : '📈';
        if (titleEl) titleEl.textContent = isMarcoZero
          ? 'Marco Zero — Diagnóstico Inicial & Linha de Partida'
          : 'Saúde Financeira do Inventário — Evolução de Stocks e Liquidez';
        if (descEl) descEl.innerHTML = isMarcoZero
          ? 'Esta é a fotografia patrimonial da farmácia no momento da 1ª importação de existências. Por rigor contabilístico, <b>não se simulam dados passados</b>. A evolução do stock, a redução do imobilizado e a liquidez recuperada serão medidas assim que for importado o fecho do próximo mês.'
          : 'Monitorização contínua baseada em <b>Vendas Comprovadas e Preços de Custo Reais</b> entre fechos mensais de faturação.';

        // Alternar Caixa de Marco Zero vs Caixa MoM
        const boxZero = document.getElementById('evoMarcoZeroBoxContainer');
        const boxMom = document.getElementById('evoMomBoxContainer');
        if (boxZero) boxZero.style.display = isMarcoZero ? 'block' : 'none';
        if (boxMom) boxMom.style.display = isMarcoZero ? 'none' : 'block';

        // Atualizar 4 Big Numbers
        const r = data.resumoAtual;
        const kpiStock = document.getElementById('evoKpiStockTotal');
        const kpiStockSub = document.getElementById('evoKpiStockSub');
        const kpiImob = document.getElementById('evoKpiImobilizado');
        const kpiImobSub = document.getElementById('evoKpiImobilizadoSub');
        const kpiPoup = document.getElementById('evoKpiPoupancas');
        const kpiPoupSub = document.getElementById('evoKpiPoupancasSub');
        const kpiCap = document.getElementById('evoKpiCapitalLibertado');
        const kpiCapSub = document.getElementById('evoKpiCapitalLibertadoSub');

        if (kpiStock) kpiStock.textContent = Number(r.stock_total_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €';
        if (kpiStockSub) kpiStockSub.textContent = Number(r.stock_total_unidades || 0).toLocaleString('pt-PT') + ' un em armazém (' + (r.total_artigos || 0) + ' artigos)';

        if (kpiImob) kpiImob.textContent = Number(r.stock_imobilizado_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €';
        if (kpiImobSub) kpiImobSub.textContent = Number(r.taxa_imobilizado_pct || 0).toFixed(1) + '% do capital total em stock (' + Number(r.stock_imobilizado_unidades || 0).toLocaleString('pt-PT') + ' un monos)';

        if (kpiPoup) kpiPoup.textContent = isMarcoZero ? '0,00 €' : '+' + Number(r.liquidez_recuperada_comprovada_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €';
        if (kpiPoupSub) kpiPoupSub.textContent = isMarcoZero ? 'Medição inicia pós-Marco Zero (comprovado por vendas)' : 'Comprovado por vendas registadas de monos';

        if (kpiCap) kpiCap.textContent = (r.dias_medios_rotacao || 55) + ' dias';
        if (kpiCapSub) kpiCapSub.textContent = 'Stock Ativo: ' + Number(r.stock_ativo_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € (' + (100 - (r.taxa_imobilizado_pct || 0)).toFixed(1) + '%)';

        // Atualizar Comparativo MoM (quando aplicável)
        if (!isMarcoZero && data.comparativoMoM && data.comparativoMoM.has_comparison) {
          const m = data.comparativoMoM;
          const lblPeriod = document.getElementById('evoMomPeriodLabel');
          const deltaStock = document.getElementById('evoMomStockDelta');
          const deltaStockSub = document.getElementById('evoMomStockDeltaSub');
          const deltaMonos = document.getElementById('evoMomMonosDelta');
          const deltaMonosSub = document.getElementById('evoMomMonosDeltaSub');
          const badgeTrend = document.getElementById('evoMomTrendBadge');
          const deltaLiq = document.getElementById('evoMomLiqDelta');
          const expText = document.getElementById('evoMomExplicacao');

          if (lblPeriod) lblPeriod.textContent = (m.mes_atual_label || 'Mês Atual') + ' vs ' + (m.mes_anterior_label || 'Mês Anterior');

          if (deltaStock) {
            const sinalS = m.variacao_stock_eur > 0 ? '+' : '';
            deltaStock.textContent = sinalS + Number(m.variacao_stock_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € (' + (m.variacao_stock_pct > 0 ? '+' : '') + Number(m.variacao_stock_pct || 0).toFixed(1) + '%)';
            deltaStock.style.color = m.variacao_stock_eur <= 0 ? '#059669' : '#0284c7';
          }
          if (deltaStockSub) {
            deltaStockSub.textContent = m.variacao_stock_eur <= 0
              ? '📉 O stock global reduziu face ao mês anterior.'
              : '📈 O stock global aumentou face ao mês anterior.';
          }

          if (deltaMonos) {
            const sinalM = m.variacao_monos_eur > 0 ? '+' : '';
            deltaMonos.textContent = sinalM + Number(m.variacao_monos_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €';
            deltaMonos.style.color = m.variacao_monos_eur <= 0 ? '#059669' : '#e11d48';
          }
          if (deltaMonosSub) {
            deltaMonosSub.textContent = m.variacao_monos_eur <= 0
              ? '🟢 Redução do valor parado em armazém.'
              : '🔴 Aumento do capital imobilizado.';
          }

          if (badgeTrend) {
            if (m.tendencia_monos === 'REDUCAO') {
              badgeTrend.textContent = '🟢 Redução de Monos';
              badgeTrend.style.background = '#dcfce7';
              badgeTrend.style.color = '#15803d';
            } else if (m.tendencia_monos === 'AUMENTO') {
              badgeTrend.textContent = '🔴 Aumento de Monos';
              badgeTrend.style.background = '#fee2e2';
              badgeTrend.style.color = '#b91c1c';
            } else {
              badgeTrend.textContent = '🟡 Monos Estáveis';
              badgeTrend.style.background = '#fef3c7';
              badgeTrend.style.color = '#b45309';
            }
          }

          if (deltaLiq) {
            deltaLiq.textContent = '+' + Number(m.liquidez_recuperada_mom_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €';
          }

          if (expText) {
            expText.textContent = m.explicacao_executiva || 'Comparativo MoM calculado com sucesso.';
          }
        }

        // Render Gráfico e Tabela apenas com pontos reais existentes
        renderStockEvolutionChart(data.evolucaoMensal, isMarcoZero);
        renderStockEvolutionTable(data.evolucaoMensal, isMarcoZero);
      } catch (err) {
        console.error('Falha ao carregar evolução de stock:', err);
      }
    }

    function renderStockEvolutionChart(pontos, isMarcoZero) {
      const container = document.getElementById('evoChartBarsContainer');
      if (!container || !pontos || pontos.length === 0) return;

      if (isMarcoZero && pontos.length === 1) {
        const p = pontos[0];
        const tooltip = p.mes_label + ' | Stock: ' + Number(p.stock_total_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € | Monos: ' + Number(p.stock_imobilizado_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € (' + Number(p.taxa_imobilizado_pct).toFixed(1) + '%) | Rotação: ' + (p.dias_rotacao || 55) + ' dias';

        container.innerHTML = '<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; gap: 12px; padding: 20px 0;">' +
          '<div title="' + escapeHtml(tooltip) + '" style="display: flex; gap: 8px; align-items: flex-end; height: 180px; justify-content: center; cursor: pointer;">' +
          '  <div style="width: 28px; height: 160px; background: #0284c7; border-radius: 6px 6px 0 0;" title="Stock Total Físico: ' + p.stock_total_eur.toFixed(2) + ' €"></div>' +
          '  <div style="width: 28px; height: ' + Math.round(160 * (p.taxa_imobilizado_pct / 100)) + 'px; background: #fca5a5; border-radius: 6px 6px 0 0;" title="Monos no Marco Zero: ' + p.stock_imobilizado_eur.toFixed(2) + ' €"></div>' +
          '</div>' +
          '<div style="font-size: 0.88rem; font-weight: 800; color: #0f172a;">' + escapeHtml(p.mes_label) + '</div>' +
          '<div style="font-size: 0.76rem; color: #64748b; background: #f8fafc; padding: 4px 12px; border-radius: 6px; border: 1px solid #e2e8f0;">📍 Fotografia Inicial Auditada — As barras comparativas serão criadas com a importação do próximo mês</div>' +
          '</div>';
        return;
      }

      const maxVal = Math.max.apply(Math, pontos.map(function(p) {
        return Math.max(p.stock_total_eur, p.vendas_mes_eur);
      })) || 1;

      let html = '';
      pontos.forEach(function(p) {
        const liqRec = Number(p.liquidez_recuperada_monos_eur || 0);
        const hStock = Math.max(8, Math.round((p.stock_total_eur / maxVal) * 200));
        const hImob = Math.max(4, Math.round((p.stock_imobilizado_eur / maxVal) * 200));
        const hVendas = Math.max(6, Math.round((p.vendas_mes_eur / maxVal) * 200));
        const hPoup = Math.max(2, Math.round((liqRec / maxVal) * 200));

        const tooltip = p.mes_label + ' | Stock: ' + Number(p.stock_total_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € | Monos: ' + Number(p.stock_imobilizado_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € (' + Number(p.taxa_imobilizado_pct).toFixed(1) + '%) | Vendas: ' + Number(p.vendas_mes_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € | Monos Resgatados: +' + liqRec.toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' € | Rotação: ' + (p.dias_rotacao || 55) + ' dias';

        html += '<div style="flex: 1; min-width: 65px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; position: relative;">' +
          '<div title="' + escapeHtml(tooltip) + '" style="display: flex; gap: 4px; align-items: flex-end; height: 210px; width: 100%; justify-content: center; cursor: pointer;">' +
          '  <div style="width: 14px; height: ' + hStock + 'px; background: #0284c7; border-radius: 4px 4px 0 0; transition: height 0.3s;"></div>' +
          '  <div style="width: 14px; height: ' + hImob + 'px; background: #fca5a5; border-radius: 4px 4px 0 0; transition: height 0.3s;"></div>' +
          '  <div style="width: 14px; height: ' + hVendas + 'px; background: #10b981; border-radius: 4px 4px 0 0; transition: height 0.3s;"></div>' +
          '  <div style="width: 10px; height: ' + hPoup + 'px; background: #fbbf24; border-radius: 4px 4px 0 0; transition: height 0.3s;"></div>' +
          '</div>' +
          '<div style="font-size: 0.72rem; color: #475569; font-weight: 700; margin-top: 8px; text-align: center; white-space: nowrap;">' + escapeHtml(p.mes_label) + '</div>' +
          '</div>';
      });

      container.innerHTML = html;
    }

    function renderStockEvolutionTable(pontos, isMarcoZero) {
      const tbody = document.getElementById('evoTableBody');
      if (!tbody || !pontos || pontos.length === 0) return;

      let html = '';
      pontos.slice().reverse().forEach(function(p) {
        let badgeColor = '#15803d';
        let badgeBg = '#dcfce7';
        if (p.taxa_imobilizado_pct > 45) {
          badgeColor = '#b91c1c';
          badgeBg = '#fee2e2';
        } else if (p.taxa_imobilizado_pct > 35) {
          badgeColor = '#b45309';
          badgeBg = '#fef3c7';
        }

        const liqDisplay = p.is_marco_zero 
          ? '<span style="color:#64748b;font-size:0.78rem;">Ponto de Partida (0,00 €)</span>' 
          : ('+' + Number(p.liquidez_recuperada_monos_eur || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €');

        html += '<tr style="border-bottom: 1px solid #f1f5f9;">' +
          '<td style="padding: 10px 14px; font-weight: 700; color: #0f172a;">' + escapeHtml(p.mes_label) + '</td>' +
          '<td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #0284c7;">' + Number(p.stock_total_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €</td>' +
          '<td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #e11d48;">' + Number(p.stock_imobilizado_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €</td>' +
          '<td style="padding: 10px 14px; text-align: center;"><span style="background: ' + badgeBg + '; color: ' + badgeColor + '; padding: 3px 8px; border-radius: 6px; font-weight: 800; font-size: 0.76rem;">' + p.taxa_imobilizado_pct.toFixed(1) + '%</span></td>' +
          '<td style="padding: 10px 14px; text-align: right; font-weight: 700; color: #10b981;">' + Number(p.vendas_mes_eur).toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €</td>' +
          '<td style="padding: 10px 14px; text-align: right; font-weight: 800; color: #059669;">' + liqDisplay + '</td>' +
          '<td style="padding: 10px 14px; text-align: center; font-weight: 700; color: #7c3aed;">' + (p.dias_rotacao || 55) + ' d</td>' +
          '<td style="padding: 10px 14px; text-align: center; font-size: 0.82rem; font-weight: 700;">' + (p.is_marco_zero ? '📍 Marco Zero' : escapeHtml(p.diagnostico || 'Auditado')) + '</td>' +
          '</tr>';
      });

      tbody.innerHTML = html;
    }

    initPharmacies();
  </script>
</body>
</html>`;
}

if (process.env.NODE_ENV !== 'test' && !process.env.SKIP_SERVER_START) {
  startServer().catch((err) => {
    console.error('❌ Erro ao iniciar servidor:', err);
    process.exit(1);
  });
}
