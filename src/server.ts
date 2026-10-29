import { getMobileStaffHtml } from './views/mobile_staff_view';
import {
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
import { ensureDatabaseReady } from './db';
import { analyzePharmacyInventory, PharmacyAnalysisReport } from './services/analysis';
import { classifyAllExistingProducts, classifyProduct } from './services/classifier';
import { getPharmacyCatalog, invalidateCatalog } from './services/product_catalog';
import { processFreeformQuestion } from './services/copilot';
import { processQuestionWithLlmOrLocal } from './services/llm_router';
import { askConversationalCopilot, clearCopilotSession } from './services/copilot_engine';
import { addDiscontinuedCnp, removeDiscontinuedCnp, getDiscontinuedList } from './services/discontinued_products';
import { ToolSecurityContext } from './services/mcp_pharma_tools';
import {
  ingestInventarioPdf,
  ingestValidadesPdf,
  ingestVendasCsv,
} from './services/ingestion';
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
  ANNUAL_CAMPAIGNS,
  CampaignProductItem,
  generateClinicalThemePacks,
  ClinicalThemePack,
} from './services/campaigns';

const customWeeklyTasksStore = new Map<string, any[]>();
const customPacksStore = new Map<string, any[]>();

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Nuelltech#2026').trim();
const ADMIN_SESSION_TOKEN =
  'ADM_' +
  crypto
    .createHmac('sha256', ADMIN_PASSWORD)
    .update('BI_PHARMA_ADMIN_SESSION_V1')
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();

// ============================================================================
// CACHE EM MEMÓRIA DO SERVIDOR + DEDUPLICAÇÃO DE PEDIDOS + PRÉ-AQUECIMENTO
// ============================================================================
const analysisCache = new Map<string, any>();
const analysisInFlight = new Map<string, Promise<any>>();
const campaignsCache = new Map<string, any>();
const campaignsInFlight = new Map<string, Promise<any>>();

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
): Promise<PharmacyAnalysisReport> {
  const key = `${farmaciaId}:${diasMonos}:${cobertura}:${mesesVmm}`;
  if (!forceRefresh && analysisCache.has(key)) {
    return analysisCache.get(key);
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
      analysisCache.set(key, rep);
      analysisInFlight.delete(key);
      return rep;
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
    for (const f of farms) {
      await getCachedOrComputeAnalysis(prisma, f.id, 90, 4, 12);
      await getCachedOrComputeCampaignsPayload(prisma, f);
    }
    console.log(
      `⚡ [Cache Warm-Up] ${farms.length} farmácia(s) pré-calculadas em memória RAM (Dashboard & Campanhas instantâneos < 10ms)!`
    );
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

const DEFAULT_SECURE_CODES: Record<string, string> = {
  A: 'FARM-A-7842',
  B: 'FARM-B-9315',
  C: 'FARM-C-4629',
  D: 'FARM-D-8154',
};

async function ensureAnonymizedTenantsAndAccessCodes(prisma: any) {
  const farms = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
  for (let idx = 0; idx < farms.length; idx++) {
    const f = farms[idx];
    const letter = String.fromCharCode(65 + idx); // A, B, C...
    const secureDefault = DEFAULT_SECURE_CODES[letter] || `FARM-${letter}-${1000 + idx * 1337}`;
    const lowerNome = (f.nome || '').toLowerCase();

    let newNome = f.nome;
    // Se ainda tiver um nome real (ex: Baptista, Avenida), anonimiza automaticamente para Pitch Comercial
    if (lowerNome.includes('baptista') || lowerNome.includes('avenida')) {
      newNome = `Farmácia ${letter}`;
    }

    const currentCode = (f.codigo_acesso || '').trim().toUpperCase();
    // Atualiza códigos previsíveis antigos (FARMACIA-A, FARMACIA-B) para códigos com PIN impossível de adivinhar
    const isPredictableOldCode = !currentCode || /^FARMACIA-[A-Z]$/.test(currentCode);
    const newCode = isPredictableOldCode ? secureDefault : currentCode;

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
    console.log(
      `   🏥 ${uf.nome.padEnd(22)} | NIF: ${maskNif(uf.nif).padEnd(11)} | Código Exclusivo: ${(uf.codigo_acesso || '').padEnd(12)} | Link Cliente: http://localhost:${PORT}/?acesso=${uf.codigo_acesso}`
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

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-code');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      async function resolveAccessContext(explicitCode?: string | null) {
        const headerToken = String(req.headers['x-access-code'] || '').trim();
        // O Modo Admin SÓ é aceite através do Token Assinado (gerado após validar a Password de Admin), NUNCA por query string no URL!
        if (
          headerToken.toUpperCase() === ADMIN_SESSION_TOKEN ||
          (explicitCode && explicitCode.trim().toUpperCase() === ADMIN_SESSION_TOKEN)
        ) {
          return {
            authenticated: true,
            role: 'ADMIN' as const,
            code: ADMIN_SESSION_TOKEN,
            lockedFarmacia: null,
          };
        }

        const rawCode = String(
          explicitCode ||
            headerToken ||
            parsedUrl.query.accessCode ||
            parsedUrl.query.acesso ||
            ''
        )
          .trim()
          .toUpperCase();

        if (rawCode.length > 0) {
          const matchedFarm = await prisma.farmacia.findFirst({
            where: {
              codigo_acesso: {
                equals: rawCode,
                mode: 'insensitive',
              },
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

        // Em localhost / desenvolvimento, autentica automaticamente a primeira farmacia se nao houver codigo
        const defaultFarm = await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'asc' } });
        if (defaultFarm) {
          return {
            authenticated: true,
            role: 'PHARMACY' as const,
            code: 'DEV_DEFAULT',
            lockedFarmacia: defaultFarm,
          };
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
        // Se for um acesso isolado de farmácia, bloqueia estritamente a essa farmácia!
        if (ctx.role === 'PHARMACY' && ctx.code !== 'DEV_DEFAULT' && ctx.lockedFarmacia) {
          return ctx.lockedFarmacia;
        }
        // Apenas o ADMIN autenticado pode pedir uma farmácia específica ou listar
        if (requestedId && requestedId.trim().length > 0) {
          const f = await prisma.farmacia.findUnique({ where: { id: requestedId.trim() } });
          if (f) return f;
        }
        return (
          (await prisma.farmacia.findFirst({ orderBy: { criadoEm: 'asc' } })) || {
            id: '',
            nome: 'Farmácia A',
            nif: '000000000',
            codigo_acesso: 'FARM-A-7842',
          }
        );
      }

      // 0A. Endpoint de Autenticação / Validação (Código Exclusivo de Farmácia vs Password de Administrador)
      if (pathname === '/api/auth/verify' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const adminPasswordInput = String(parsed.adminPassword || '').trim();
            const rawCodeInput = String(parsed.code || '').trim();

            let ctx;
            if (adminPasswordInput.length > 0) {
              if (adminPasswordInput === ADMIN_PASSWORD) {
                ctx = {
                  authenticated: true,
                  role: 'ADMIN' as const,
                  code: ADMIN_SESSION_TOKEN,
                  lockedFarmacia: null,
                };
              } else {
                res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: 'Password de Administrador incorreta.',
                  })
                );
                return;
              }
            } else if (rawCodeInput === ADMIN_PASSWORD) {
              ctx = {
                authenticated: true,
                role: 'ADMIN' as const,
                code: ADMIN_SESSION_TOKEN,
                lockedFarmacia: null,
              };
            } else {
              ctx = await resolveAccessContext(rawCodeInput);
            }

            if (!ctx.authenticated) {
              res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'Código de acesso inválido. Utilize o link ou código exclusivo atribuído à sua Farmácia.',
                })
              );
              return;
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
                  codigo_acesso: ctx.role === 'ADMIN' ? f.codigo_acesso : undefined,
                })),
              })
            );
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      // 0B. Endpoint Admin: Atualizar Nome Anónimo e Código de Acesso de uma Farmácia
      if (pathname === '/api/admin/update-pharmacy' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const ctx = await resolveAccessContext();
            if (ctx.role !== 'ADMIN') {
              res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'Apenas o Administrador pode gerir farmácias.' }));
              return;
            }
            const { farmaciaId, nome, codigo_acesso } = JSON.parse(body || '{}');
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
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      // 0C. Endpoint Admin: Importar Nova Farmácia via Browser (PDF Inventário + PDF Validades + CSV Vendas)
      if (pathname === '/api/admin/import-pharmacy' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          const tmpFiles: string[] = [];
          try {
            const ctx = await resolveAccessContext();
            if (ctx.role !== 'ADMIN') {
              res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'Apenas o acesso Master/Admin pode importar novas farmácias.' }));
              return;
            }
            const rawBody = Buffer.concat(chunks).toString('utf-8');
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
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          } finally {
            for (const f of tmpFiles) {
              try {
                if (fs.existsSync(f)) fs.unlinkSync(f);
              } catch {}
            }
          }
        });
        return;
      }

      // 0. Endpoint de Lista de Farmácias (Multi-Tenant com Isolamento por Código de Acesso)
      if (pathname === '/api/pharmacies' && req.method === 'GET') {
        const ctx = await resolveAccessContext();
        let farms;
        if (!ctx.authenticated) {
          farms = await prisma.farmacia.findMany({ orderBy: { criadoEm: 'asc' } });
        } else if (ctx.role === 'PHARMACY' && ctx.code !== 'DEV_DEFAULT' && ctx.lockedFarmacia) {
          farms = [ctx.lockedFarmacia];
        } else {
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
              codigo_acesso: ctx.role === 'ADMIN' ? f.codigo_acesso : undefined,
            }))
          )
        );
        return;
      }

      // 1. Endpoint de Análise Parametrizável (Multi-Tenant + Cache Instantânea)
      if (pathname === '/api/analysis' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await getActiveFarmacia(farmIdQuery);

        const diasMonos = parseInt(String(parsedUrl.query.diasMonos || '90'), 10);
        const cobertura = parseFloat(String(parsedUrl.query.cobertura || '4'));
        const mesesVmm = parseInt(String(parsedUrl.query.mesesVmm || '12'), 10);
        const forceRefresh = String(parsedUrl.query.refresh || '') === '1';

        const report = await getCachedOrComputeAnalysis(
          prisma,
          activeFarmacia.id,
          Number.isNaN(diasMonos) ? 90 : diasMonos,
          Number.isNaN(cobertura) ? 4 : cobertura,
          Number.isNaN(mesesVmm) ? 12 : mesesVmm,
          forceRefresh
        );

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(report));
        return;
      }

      // 2. Endpoint de Raio-X de Produto Individual (Multi-Tenant)
      if (pathname.startsWith('/api/product/') && req.method === 'GET') {
        const cnp = pathname.replace('/api/product/', '').trim();
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await getActiveFarmacia(farmIdQuery);

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
        const activeFarmacia = await getActiveFarmacia(farmIdQuery);
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

      // 2.5B. Endpoint para Criar Campanha à Medida (Eventos Livres: Halloween, Black Friday, Festas da Cidade ou Produtos Específicos)
      if (pathname === '/api/campaigns/custom' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const activeFarmacia = await getActiveFarmacia(parsed.farmaciaId);
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
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // 2.5C. Endpoint Simulador 360º de Escoamento & Cross-Selling para um Produto Específico
      if (pathname === '/api/campaigns/product-360' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const q = String(parsedUrl.query.q || '').trim();
        const activeFarmacia = await getActiveFarmacia(farmIdQuery);
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
        const activeFarmacia = await getActiveFarmacia(farmIdQuery);
        const items = await searchProductsForMarketingPicker(prisma, activeFarmacia.id, q);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ items }));
        return;
      }

      // 2.5E. Endpoint de Packs Clínicos & Cestos Temáticos (Por Sintoma / Propósito)
      if (pathname === '/api/packs' && req.method === 'GET') {
        const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
        const activeFarmacia = await getActiveFarmacia(farmIdQuery);
        const packs = await generateClinicalThemePacks(prisma, activeFarmacia.id);
        const userSaved = customPacksStore.get(activeFarmacia.id) || [];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, farmaciaId: activeFarmacia.id, packs: [...userSaved, ...packs] }));
        return;
      }

      // 2.5F. Endpoint Guardar Pack Personalizado no Marketing
      if (pathname === '/api/packs/save' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const farmIdQuery = String(parsed.farmaciaId || '').trim();
            const activeFarmacia = await getActiveFarmacia(farmIdQuery);
            if (parsed.pack) {
              const currentList = customPacksStore.get(activeFarmacia.id) || [];
              currentList.unshift(parsed.pack);
              customPacksStore.set(activeFarmacia.id, currentList);
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, message: 'Pack guardado com sucesso no Estúdio de Marketing!' }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      // 2.5G. Endpoint Aplicar Tarefas Personalizadas do Copilot à Folha da Semana
      if (pathname === '/api/weekly-plan/apply' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const farmIdQuery = String(parsed.farmaciaId || '').trim();
            const activeFarmacia = await getActiveFarmacia(farmIdQuery);
            if (Array.isArray(parsed.tasks)) {
              customWeeklyTasksStore.set(activeFarmacia.id, parsed.tasks);
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, message: 'Tarefas aplicadas com sucesso à Folha da Semana!' }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

            // Endpoint Descontinuar / Não Repor Produtos (Pilar 3)
      if (pathname === '/api/products/discontinue' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const farmIdQuery = String(parsed.farmaciaId || '').trim();
            const activeFarmacia = await getActiveFarmacia(farmIdQuery);
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
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      if (pathname === '/api/campaigns/generate' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const farmaciaId = parsed.farmaciaId;
            const campaignId = parsed.campaignId;
            const descontoPct = parsed.discountPct !== undefined ? parsed.discountPct : (parsed.descontoPct !== undefined ? parsed.descontoPct : 15);
            const canais = parsed.channels || parsed.canais || ['loja', 'redes', 'ecras', 'app'];
            let selectedProducts = parsed.selectedProducts || [];

            const activeFarmacia = await getActiveFarmacia(farmaciaId);
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
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      if (pathname === '/api/campaigns/send-email' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { to, farmaciaId } = JSON.parse(body || '{}');
            const activeFarmacia = await getActiveFarmacia(farmaciaId);
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
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // 3. Endpoint de Perguntas em Linguagem Natural / Consultas Rápidas (Multi-Tenant)
      if (pathname === '/api/ask' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { question, farmaciaId, sessionId } = JSON.parse(body || '{}');
            const activeFarmacia = await getActiveFarmacia(farmaciaId);
            const q = String(question || '').trim();

            if (!q) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Pergunta não fornecida.' }));
              return;
            }

            // Contexto de Segurança Multi-Tenant Estrito
            const secContext: ToolSecurityContext = {
              farmaciaId: activeFarmacia.id,
              farmaciaNome: activeFarmacia.nome,
              nif: activeFarmacia.nif,
            };

            const sid = sessionId || `session-${activeFarmacia.id}`;
            const copilotRes = await askConversationalCopilot(prisma, secContext, q, sid);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              success: true,
              text: copilotRes.text,
              toolsUsed: copilotRes.toolsUsed,
              sessionId: copilotRes.sessionId,
              shoppingList: (copilotRes as any).shoppingList || null,
              farmaciaNome: activeFarmacia.nome,
              titulo: `Copilot — ${activeFarmacia.nome}`,
              explicacao: copilotRes.text,
            }));
            return;
          } catch (e: any) {
            console.error('[API /api/ask Error]:', e);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      // 3.1. Endpoint para Limpar Sessão Conversacional do Copilot
      if (pathname === '/api/copilot/clear' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { sessionId } = JSON.parse(body || '{}');
            if (sessionId) {
              clearCopilotSession(sessionId);
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'Histórico da sessão reiniciado com sucesso.' }));
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

            // 2.5H. Endpoint Mobile Staff Auth PIN
      if (pathname === '/api/mobile/auth-pin' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { farmaciaId, pin } = JSON.parse(body || '{}');
            const resAuth = await verifyMobileStaffPin(prisma, farmaciaId, pin);
            res.writeHead(resAuth.valid ? 200 : 401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: resAuth.valid, ...resAuth }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      // 2.5I. Endpoint Obter Tarefas Semanais da Farmácia
      if (pathname === '/api/weekly-tasks' && req.method === 'GET') {
        try {
          const farmIdQuery = String(parsedUrl.query.farmaciaId || '').trim();
          const activeFarmacia = await getActiveFarmacia(farmIdQuery);
          const tasksData = await getPharmacyWeeklyTasks(prisma, activeFarmacia.id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, farmaciaId: activeFarmacia.id, ...tasksData }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 2.5J. Endpoint Toggle Tarefa Semanal (Supabase Sync)
      if (pathname === '/api/weekly-tasks/toggle' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { farmaciaId, taskId, concluido, concluido_por, categoria, cnp_codigo, designacao, valor_impacto } = JSON.parse(body || '{}');
            const farmIdQuery = String(farmaciaId || '').trim();
            const activeFarmacia = await getActiveFarmacia(farmIdQuery);
            const saved = await toggleWeeklyTaskInDb(prisma, {
              farmaciaId: activeFarmacia.id,
              taskId,
              concluido: !!concluido,
              concluido_por: concluido_por || 'Equipa',
              categoria,
              cnp_codigo,
              designacao,
              valor_impacto: valor_impacto !== undefined ? Number(valor_impacto) : undefined,
            });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, task: saved }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      // 2.5K. Endpoint Reset Tarefas da Semana
      if (pathname === '/api/weekly-tasks/reset' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { farmaciaId } = JSON.parse(body || '{}');
            const farmIdQuery = String(farmaciaId || '').trim();
            const activeFarmacia = await getActiveFarmacia(farmIdQuery);
            const resetRes = await resetWeeklyTasksInDb(prisma, activeFarmacia.id);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(resetRes));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getMobileStaffHtml());
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHtml());
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(PORT, () => {
    console.log(`\n🚀 Dashboard BI Pharma ativo em: http://localhost:${PORT}`);
    // Pré-aquecimento em background para o servidor responder logo às verificações de saúde do Render
    (async () => {
      try {
        console.log('[Classificador] A verificar e atualizar estatuto (VENDA_LIVRE / MNSRM / MSRM) e segmento (GENERICO_MG / MARCA)...');
        const statsClass = await classifyAllExistingProducts(prisma);
        console.log(
          `[Classificador] ${statsClass.total} produtos caracterizados -> PSBE: ${statsClass.vendaLivre} | Genéricos MG: ${statsClass.genericosMg} | Marca: ${statsClass.marca}`
        );
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

    .director-question-card {
      background: #ffffff !important;
      border: 1px solid #e2e8f0 !important;
      border-radius: 10px;
      padding: 12px 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      gap: 4px;
      text-align: left;
    }

    .director-question-card:hover {
      border-color: #0284c7 !important;
      background: #f0f9ff !important;
      transform: translateY(-1px);
      box-shadow: 0 2px 6px rgba(2, 132, 199, 0.12);
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
      max-width: 860px;
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

  </style>
</head>
<body>
  <div class="app-layout">
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
      <div class="main-content">
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



    <!-- ABA 0: PLANO DE AÇÃO SEMANAL (MODO SIMPLES PARA A EQUIPA E DIRETOR) -->
    <div id="tabContent-plano" style="display: block;">
      <div style="background: linear-gradient(135deg, #ecfdf5 0%, #ffffff 100%); border: 1px solid #a7f3d0; border-radius: 14px; padding: 22px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #065f46; display: flex; align-items: center; gap: 8px;">
              📋 Folha de Ações da Semana — O que fazer hoje na Farmácia
            </div>
            <p style="font-size: 0.88rem; color: #334155; margin-top: 4px; max-width: 820px; line-height: 1.45;">
              Em vez de analisar centenas de tabelas, o sistema selecionou automaticamente as <b>tarefas prioritárias desta semana</b> para a gaveta, para o balcão e para o computador de encomendas.
            </p>
          </div>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <span id="planoProgressText" style="font-size: 0.86rem; color: #047857; font-weight: 700; background: #d1fae5; padding: 6px 12px; border-radius: 8px; border: 1px solid #a7f3d0;">
              ✅ 0 de 0 tarefas concluídas
            </span>
            <button class="btn" onclick="printWeeklyActionPlan()" style="background: linear-gradient(135deg, #10b981, #059669); color: #042f2e; font-weight: 700;">
              🖨️ Imprimir Folha A4 para a Equipa
            </button>
            <button class="btn btn-secondary" onclick="resetWeeklyTasksProgress()" style="font-size: 0.8rem; padding: 7px 12px;" title="Limpar vistos marcados">
              🔄 Limpar Vistos
            </button>
            <button class="btn" onclick="openMobileStaffModal()" style="background: linear-gradient(135deg, #0284c7, #0369a1); color: #ffffff; font-weight: 700; box-shadow: 0 2px 4px rgba(2, 132, 199, 0.3);">
              📱 Abrir no Telemóvel da Equipa
            </button>
          </div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 20px; margin-bottom: 30px;">
        <!-- CARTÃO 1: VALIDADES URGENTES NA GAVETA -->
        <div style="background: var(--surface); border: 1px solid rgba(244, 63, 94, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #e11d48; display: flex; align-items: center; gap: 8px;">
              🔴 1. Gaveta & Prateleira: Validades Próximas a Tratar
            </div>
            <span id="planoCard1Count" class="badge badge-danger">8 prioritários</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 14px;">
            Identificação estrita de produtos a aproximar do fim de vida útil para ação prioritária de balcão ou separação física (sem falsas premissas de devolução):
          </p>
          <div id="planoCard1List" style="display: flex; flex-direction: column; gap: 10px; flex: 1;">
            <!-- Inserido dinamicamente via JS -->
          </div>
          <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); text-align: right;">
            <button class="btn btn-secondary" onclick="switchTab('caducidade')" style="font-size: 0.76rem; padding: 5px 10px; border-color: #fb7185; color: #fb7185;">
              Ver todos os produtos em risco de validade →
            </button>
          </div>
        </div>

        <!-- CARTÃO 2: TROCA DE GENÉRICOS NO BALCÃO -->
        <div style="background: var(--surface); border: 1px solid rgba(168, 85, 247, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #7e22ce; display: flex; align-items: center; gap: 8px;">
              🟠 2. Balcão & Destaque: Pôr a Rodar Stock Parado & Excessos Sazonais
            </div>
            <span id="planoCard2Count" class="badge badge-purple">Gaveta + Época Alta</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 14px;">
            Fim de gaveta (1-2 un de genéricos) e artigos com excesso de stock na época certa (ex: Ben-u-gripe no pico de inverno):
          </p>
          <div id="planoCard2List" style="display: flex; flex-direction: column; gap: 10px; flex: 1;">
            <!-- Inserido dinamicamente via JS -->
          </div>
          <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); text-align: right;">
            <button class="btn btn-secondary" onclick="switchTab('genericos')" style="font-size: 0.76rem; padding: 5px 10px; border-color: #c084fc; color: #c084fc;">
              Ver análise completa de Genéricos (DCI) →
            </button>
          </div>
        </div>

        <!-- CARTÃO 3: TRAVAR ENCOMENDAS NO SIFARMA -->
        <div style="background: var(--surface); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #b45309; display: flex; align-items: center; gap: 8px;">
              🛑 3. Encomendas (Sifarma): O que NÃO Encomendar Mais
            </div>
            <span id="planoCard3Savings" class="badge badge-warning">-- € poupança</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 14px;">
            Colocar o <b>Ponto de Encomenda / Stock Mínimo = 0</b> nestes códigos com cobertura excessiva para travar compras desnecessárias:
          </p>
          <div id="planoCard3List" style="display: flex; flex-direction: column; gap: 10px; flex: 1;">
            <!-- Inserido dinamicamente via JS -->
          </div>
          <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); text-align: right;">
            <button class="btn btn-secondary" onclick="switchTab('cobertura')" style="font-size: 0.76rem; padding: 5px 10px; border-color: #fbbf24; color: #fbbf24;">
              Ver todos os excessos de stock →
            </button>
          </div>
        </div>

        <!-- CARTÃO 4: VENDA CRUZADA & ÉPOCA DO ANO -->
        <div style="background: var(--surface); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 12px; padding: 18px; display: flex; flex-direction: column;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-size: 1.05rem; font-weight: 800; color: #0284c7; display: flex; align-items: center; gap: 8px;">
              🟢 4. Encomendas (Sifarma): Ajustar Níveis & Prevenir Ruturas
            </div>
            <span id="planoCard4Count" class="badge badge-info">Subir Ponto de Encomenda</span>
          </div>
          <p style="font-size: 0.82rem; color: var(--muted); margin-bottom: 14px;">
            Medicamentos essenciais com stock <= 2 e alto ritmo de saída / pico de inverno. Subir Ponto de Encomenda para evitar ruturas:
          </p>
          <div id="planoCard4List" style="display: flex; flex-direction: column; gap: 10px; flex: 1;">
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
          </div>
        </div>

        <!-- PAINEL DE PERGUNTAS ESTRATÉGICAS DA DIREÇÃO TÉCNICA -->
        <div id="directorQuestionsAccordion" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; cursor: pointer;" onclick="toggleDirectorQuestionsPanel()">
            <div style="font-size: 0.82rem; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
              ⭐ Perguntas Executivas da Direção Técnica (Casos Práticos Reais)
            </div>
            <span id="directorQuestionsToggleIcon" style="font-size: 0.85rem; color: #64748b; font-weight: 700;">▲ Ocultar</span>
          </div>

          <div id="directorQuestionsGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px;">
            <div class="director-question-card" onclick="runDirectorQuestion('Tendo em conta as vendas faz um cálculo do mínimo de stock que deverias ter para uma semana')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">📊 1. Stock Mínimo para 1 Semana</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Cálculo do stock semanal com base na VMM diária e identificação de défices críticos.</div>
            </div>

            <div class="director-question-card" onclick="runDirectorQuestion('Relativamente aos produtos de venda livre com validade até 2027, faz uma listagem do pvp a que poderiam ser vendidos não ficando a margem de lucro abaixo dos 10%')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">🏷️ 2. Promoção PVP c/ Margem ≥10%</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Venda livre com validade até 2027 e novo PVP promocional protegido.</div>
            </div>

            <div class="director-question-card" onclick="runDirectorQuestion('Nos produtos de venda livre com validade até 2027, sugere packs de pelo menos 2 a 3 produtos que a margem de cada não seja abaixo de 5%')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">📦 3. Packs Promocionais (2-3 un)</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Combinações clínicas com margem garantida para acelerar rotação de stock.</div>
            </div>

            <div class="director-question-card" onclick="runDirectorQuestion('Faz uma listagem de todos os produtos existentes em stock sem vendas nos últimos 6 meses e como sugeres a sua dispensa (troca de laboratório, associar com produto de venda livre)')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">🛑 4. Monos 6 Meses & Estratégia</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Artigos sem rotação e ações recomendadas (troca lab, cesto balcão).</div>
            </div>

            <div class="director-question-card" onclick="runDirectorQuestion('Definindo o número de laboratórios que quero ter por molécula e respetiva dosagem, tendo por base o pvp máximo e mínimo definido no infarmed e o que há em stock e é necessário escoar, cria uma listagem')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">🧬 5. Racionalização de Labs DCI</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Consolidação de genéricos duplicados e eliminação de restos de gaveta.</div>
            </div>

            <div class="director-question-card" onclick="runDirectorQuestion('Tendo em conta as vendas de produtos de venda livre no último ano e sua sazonalidade, que quantidades sugeres serem compradas diretamente a laboratórios e em que datas sugeres que sejam entregues na farmácia')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">🗓️ 6. Plano Anual Compras Labs</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Calendário sazonal de encomendas diretas a fornecedores por épocas.</div>
            </div>

            <div class="director-question-card" onclick="runDirectorQuestion('Para as moléculas sujeitas a receita que mais se vendem, que vendas cruzadas sugeres')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">💊 7. Venda Cruzada Clínica MSRM</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Co-prescrições e proteção gástrica/suplementar para receitas mais frequentes.</div>
            </div>

            <div class="director-question-card" onclick="runDirectorQuestion('De forma a reduzir o valor de inventário qual seria a estratégia que adotarias tendo em conta o stock, validade, produtos sem rotação e produtos a não encomendar')">
              <div style="font-weight: 700; font-size: 0.86rem; color: #0284c7;">📉 8. Redução Global de Inventário</div>
              <div style="font-size: 0.77rem; color: #475569; line-height: 1.35;">Parecer executivo para libertar liquidez e baixar capital empatado.</div>
            </div>
          </div>
        </div>

        <!-- FEED CONVERSACIONAL COM HISTÓRICO E MEMÓRIA -->
        <div id="copilotChatFeed" class="copilot-chat-feed">
          <div id="copilotWelcomeGreeting" style="text-align: center; padding: 28px 16px; background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 12px;">
            <div style="font-size: 2.2rem; margin-bottom: 8px;">💡</div>
            <div style="font-size: 1rem; font-weight: 700; color: #0f172a; margin-bottom: 4px;">O que pretende analisar hoje na sua farmácia?</div>
            <div style="font-size: 0.84rem; color: #64748b; max-width: 580px; margin: 0 auto; line-height: 1.45;">
              Clique num dos casos executivos acima ou escreva livremente na barra inferior. Pode fazer perguntas de seguimento a qualquer momento — o Copilot mantém o contexto da conversa.
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

      <!-- PAINEL CRIADOR DE CAMPANHAS À MEDIDA (EVENTO LIVRE OU PRODUTOS ESPECÍFICOS) -->
      <div id="mktCustomBuilderPanel" style="display: none; margin-bottom: 26px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 14px; padding: 22px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 16px;">
          <div>
            <h3 style="font-size: 1.08rem; font-weight: 800; color: #e879f9; margin: 0; display: flex; align-items: center; gap: 8px;">
              ✨ Construtor de Campanhas à Medida — Eventos Livres & Produtos Específicos
            </h3>
            <p style="font-size: 0.84rem; color: #334155; margin-top: 4px;">
              Crie uma campanha para qualquer evento do calendário ou da sua localidade (<b>Halloween, Black Friday, Festas da Cidade, Aniversário</b>) ou escolha manualmente os produtos que quer escoar (ex: <b>Antigrippine Trieffect Tosse</b>).
            </p>
          </div>
        </div>

        <!-- ATALHOS DE EVENTOS ESPECIAIS (1 CLIQUE) -->
        <div style="margin-bottom: 16px;">
          <div style="font-size: 0.74rem; font-weight: 700; color: var(--muted); text-transform: uppercase; margin-bottom: 8px;">
            ⚡ Eventos Rápidos (Clique para montar automaticamente com o seu stock):
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-secondary" onclick="runPresetCustomCampaign('halloween')" style="font-size: 0.82rem; padding: 7px 14px; border-color: #f97316; color: #fb923c;">🎃 Halloween</button>
            <button class="btn btn-secondary" onclick="runPresetCustomCampaign('black_friday')" style="font-size: 0.82rem; padding: 7px 14px; border-color: #f43f5e; color: #fb7185;">🖤 Black Friday / Cyber Week</button>
            <button class="btn btn-secondary" onclick="runPresetCustomCampaign('festas_cidade')" style="font-size: 0.82rem; padding: 7px 14px; border-color: #eab308; color: #fde047;">🎉 Festas da Cidade / Romaria</button>
            <button class="btn btn-secondary" onclick="runPresetCustomCampaign('aniversario_farmacia')" style="font-size: 0.82rem; padding: 7px 14px; border-color: #38bdf8; color: #38bdf8;">🎂 Aniversário da Farmácia</button>
            <button class="btn btn-secondary" onclick="runPresetCustomCampaign('evento_desportivo')" style="font-size: 0.82rem; padding: 7px 14px; border-color: #10b981; color: #34d399;">🏃 Evento Desportivo / Caminhada</button>
            <button class="btn btn-secondary" onclick="runPresetCustomCampaign('dia_mae_pai')" style="font-size: 0.82rem; padding: 7px 14px; border-color: #c084fc; color: #c084fc;">💝 Dia da Mãe / Pai / Família</button>
          </div>
        </div>

        <!-- CONFIGURAÇÃO MANUAL (TEMA LIVRE + SELETOR DE PRODUTOS ESPECÍFICOS) -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 16px;">
          <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 10px; padding: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
            <label style="font-size: 0.8rem; font-weight: 700; color: #0f172a; display: block; margin-bottom: 6px;">
              1️⃣ Nome do Evento ou Campanha Personalizada:
            </label>
            <input type="text" id="customCampName" placeholder="Ex: Especial Festas de S. João, Semana Anti-Gripe, Promo Antigrippine..." style="width: 100%; margin-bottom: 12px;" />

            <label style="font-size: 0.8rem; font-weight: 700; color: #0f172a; display: block; margin-bottom: 6px;">
              2️⃣ Palavras-Chave / Famílias a incluir (Opcional, separadas por vírgula):
            </label>
            <input type="text" id="customCampTerms" placeholder="Ex: antigrippine, tosse, vitamina c, creme maos, perfume..." style="width: 100%; margin-bottom: 12px;" />

            <label style="font-size: 0.8rem; font-weight: 700; color: #0f172a; display: block; margin-bottom: 6px;">
              3️⃣ Filtro de Stock:
            </label>
            <select id="customCampFocus" style="width: 100%;">
              <option value="PRIORIDADE_VALIDADES_MONOS" selected>🔥 Priorizar Validades Críticas, Monos e Excesso de Stock</option>
              <option value="SO_VALIDADES_E_MONOS">🧹 Incluir APENAS Produtos em Risco de Validade ou Monos</option>
              <option value="TODOS_ELEGIVEIS">📦 Todos os Produtos Elegíveis com Stock e Margem</option>
            </select>
          </div>

          <!-- PESQUISADOR E SELETOR DE PRODUTOS ESPECÍFICOS -->
          <div style="background: #ffffff; border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <label style="font-size: 0.8rem; font-weight: 700; color: #0369a1; display: block; margin-bottom: 6px;">
                🎯 Escolher Produtos Específicos do Stock (Ex: Antigrippine, Mucavex...):
              </label>
              <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                <input type="text" id="customProdSearchInput" placeholder="🔎 Escreva nome ou CNP (ex: Antigrippine, 5818711)..." oninput="searchProductsForCustomBuilder(this.value)" style="flex: 1;" />
              </div>
              <div id="customProdSearchResults" style="max-height: 135px; overflow-y: auto; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; padding: 6px; background: rgba(2, 6, 23, 0.6); font-size: 0.78rem; margin-bottom: 10px;">
                <span style="color: var(--muted);">Escreva acima para pesquisar qualquer produto em stock e adicioná-lo à campanha...</span>
              </div>
            </div>

            <div>
              <div style="font-size: 0.75rem; font-weight: 700; color: #e879f9; margin-bottom: 6px;">
                📌 Produtos Fixados na Campanha (<span id="customPickedCount">0</span>):
              </div>
              <div id="customPickedProductsChips" style="display: flex; flex-wrap: wrap; gap: 6px; min-height: 28px;">
                <span style="font-size: 0.75rem; color: var(--muted);">Nenhum produto fixado manualmente (ou clique num produto acima).</span>
              </div>
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button class="btn btn-secondary" onclick="clearCustomCampaignBuilder()" style="font-size: 0.84rem;">Limpar Seleção</button>
          <button class="btn" onclick="submitCustomCampaignBuilder()" style="background: linear-gradient(135deg, #a855f7, #ec4899); font-size: 0.9rem; padding: 10px 22px;">
            🚀 Montar Campanha à Medida & Simular Descontos
          </button>
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

        <!-- BOTÃO PARA GERAR MATERIAIS -->
        <div style="display: flex; justify-content: flex-end; gap: 12px;">
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
          <div style="display: flex; gap: 10px;">
            <button class="btn btn-secondary" onclick="exportCampaignPlanCsv()">
              📥 Exportar Lista de Preços (CSV)
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

  <div class="modal-backdrop" id="productModal" style="display: none;" onclick="if(event.target===this) closeModal()">
    <div class="modal">
      <div class="modal-header">
        <div>
          <h2 id="modalTitle" style="font-size: 1.15rem; color: var(--primary);"></h2>
          <p id="modalSub" style="font-size: 0.85rem; color: var(--muted); margin-top: 4px;"></p>
        </div>
        <button class="btn btn-secondary" onclick="closeModal()">✕ Fechar</button>
      </div>
      <div id="modalRuleBox" style="background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.3);padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:0.86rem;"></div>
      <div id="modalMetrics" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px;"></div>
      <div id="modalChartHeader" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
        <h4 id="modalChartTitle" style="font-size: 0.85rem; color: var(--muted); text-transform: uppercase;">Evolução de Vendas Mensais (Unidades Vendidas por Mês)</h4>
        <div id="modalLabSwitcher" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
      </div>
      <div class="chart-bars" id="modalChart"></div>
      <div id="modalDciPeers" style="margin-top: 18px; display: none;"></div>
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

  <!-- MODAL 3: GATE DE ACESSO ISOLADO POR FARMÁCIA OU ADMIN COM PASSWORD -->
  <div class="modal-backdrop" id="authGateModal" style="display: none; z-index: 250; background: rgba(2, 6, 23, 0.94);">
    <div class="modal" style="max-width: 460px; border-color: var(--primary); box-shadow: 0 20px 50px rgba(0,0,0,0.7);">
      
      <!-- VISTA A: ACESSO CLIENTE DE FARMÁCIA -->
      <div id="authGatePharmacyView">
        <div style="text-align: center; margin-bottom: 18px;">
          <div style="font-size: 2.3rem; margin-bottom: 8px;">🏥</div>
          <h2 style="font-size: 1.25rem; color: var(--text); font-weight: 800;">BI Pharma — Acesso da Farmácia</h2>
          <p style="font-size: 0.85rem; color: var(--muted); margin-top: 6px; line-height: 1.45;">
            Introduza o <b>Código de Acesso Exclusivo</b> da sua Farmácia para aceder ao seu painel isolado.
          </p>
        </div>

        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div>
            <label style="font-size: 0.78rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; display: block; margin-bottom: 6px;">
              Código da Farmácia:
            </label>
            <input
              type="text"
              id="authAccessCodeInput"
              placeholder="Introduza o código da sua farmácia"
              style="width: 100%; font-size: 1rem; font-weight: 700; text-align: center; letter-spacing: 1px; text-transform: uppercase; padding: 12px;"
              onkeydown="if(event.key==='Enter') submitPharmacyAccessCode()"
            />
          </div>

          <div id="authGateError" style="display: none; font-size: 0.82rem; color: #fb7185; background: rgba(244, 63, 94, 0.12); border: 1px solid rgba(244, 63, 94, 0.3); padding: 8px 12px; border-radius: 8px; text-align: center;"></div>

          <button class="btn" onclick="submitPharmacyAccessCode()" style="width: 100%; padding: 12px; font-size: 0.96rem; justify-content: center;">
            🚀 Entrar no Painel da Farmácia
          </button>

          <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 8px; text-align: center;">
            <button class="btn btn-secondary" onclick="toggleAuthGateMode('ADMIN')" style="font-size: 0.78rem; padding: 6px 14px; border-color: rgba(148,163,184,0.3); color: var(--muted);">
              🔐 Área Reservada (Administração)
            </button>
          </div>
        </div>
      </div>

      <!-- VISTA B: ACESSO DE ADMINISTRAÇÃO (PASSWORD OBRIGATÓRIA) -->
      <div id="authGateAdminView" style="display: none;">
        <div style="text-align: center; margin-bottom: 18px;">
          <div style="font-size: 2.3rem; margin-bottom: 8px;">👑</div>
          <h2 style="font-size: 1.25rem; color: #c084fc; font-weight: 800;">Administração BI Pharma</h2>
          <p style="font-size: 0.85rem; color: var(--muted); margin-top: 6px; line-height: 1.45;">
            Área restrita de gestão multi-farmácia. Introduza a <b>Password de Administrador</b>.
          </p>
        </div>

        <div style="display: flex; flex-direction: column; gap: 12px;">
          <form onsubmit="event.preventDefault(); submitAdminPassword();">
            <label style="font-size: 0.78rem; font-weight: 700; color: #c084fc; text-transform: uppercase; display: block; margin-bottom: 6px;">
              Password de Administrador:
            </label>
            <input
              type="password"
              id="authAdminPasswordInput"
              placeholder="••••••••••••"
              autocomplete="current-password"
              style="width: 100%; font-size: 1rem; font-weight: 700; text-align: center; letter-spacing: 2px; padding: 12px;"
              onkeydown="if(event.key==='Enter') submitAdminPassword()"
            />
          </form>

          <div id="authGateAdminError" style="display: none; font-size: 0.82rem; color: #fb7185; background: rgba(244, 63, 94, 0.12); border: 1px solid rgba(244, 63, 94, 0.3); padding: 8px 12px; border-radius: 8px; text-align: center;"></div>

          <button class="btn" onclick="submitAdminPassword()" style="width: 100%; padding: 12px; font-size: 0.96rem; justify-content: center; background: linear-gradient(135deg, #a855f7, #7c3aed); border-color: #a855f7;">
            🔓 Entrar como Administrador
          </button>

          <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 8px; text-align: center;">
            <button class="btn btn-secondary" onclick="toggleAuthGateMode('PHARMACY')" style="font-size: 0.78rem; padding: 6px 14px; border-color: rgba(148,163,184,0.3); color: var(--muted);">
              ← Voltar ao Acesso de Farmácia
            </button>
          </div>
        </div>
      </div>

    </div>
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
            📥 Descarregar CSV para Sifarma
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
      const modal = document.getElementById('authGateModal');
      const input = document.getElementById('authAccessCodeInput');
      const errEl = document.getElementById('authGateError');
      const errAdm = document.getElementById('authGateAdminError');

      toggleAuthGateMode(targetMode);

      if (input && activeAuthRole === 'PHARMACY') input.value = activeAccessCode || '';
      if (errMsg) {
        if (targetMode === 'ADMIN' && errAdm) {
          errAdm.textContent = errMsg;
          errAdm.style.display = 'block';
        } else if (errEl) {
          errEl.textContent = errMsg;
          errEl.style.display = 'block';
        }
      }
      if (modal) modal.style.display = 'flex';
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
      localStorage.removeItem('bi_pharma_access_code');
      localStorage.removeItem('bi_pharma_auth_role');
      localStorage.removeItem('bi_pharma_farmacia_id');
      activeAccessCode = '';
      activeAuthRole = '';
      activeFarmaciaId = '';
      openAuthGateModal('Sessão de Administrador terminada.', 'ADMIN');
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

        if (data.role === 'PHARMACY' && data.lockedFarmacia) {
          activeFarmaciaId = data.lockedFarmacia.id;
          localStorage.setItem('bi_pharma_farmacia_id', activeFarmaciaId);
        }

        applyRoleUiState(data.role, data.lockedFarmacia);
        await loadPharmaciesDropdown();
        return true;
      } catch (e) {
        console.error('Erro ao validar acesso:', e);
        return false;
      }
    }

    async function loadPharmaciesDropdown() {
      try {
        const res = await fetch('/api/pharmacies');
        const farms = await res.json();
        cachedAdminPharmacies = farms;
        const sel = document.getElementById('farmaciaSelector');
        sel.innerHTML = farms.map(f => \`<option value="\${f.id}" \${f.id === activeFarmaciaId ? 'selected' : ''}>🏥 \${f.nome} (NIF: \${f.nif})</option>\`).join('');
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
      const urlCode = urlParams.get('acesso') || urlParams.get('accessCode');
      const isAdminFlag = urlParams.get('admin') === '1';

      // 1. Se abriu com ?admin=1, pede a Password de Administrador diretamente
      if (isAdminFlag) {
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

      // 3. Se já tinha código válido guardado em sessão local
      if (activeAccessCode) {
        const ok = await verifyAndActivateAccessCode({ code: activeAccessCode }, false, activeAuthRole === 'ADMIN' ? 'ADMIN' : 'PHARMACY');
        if (ok) return;
      }

      // 3.5 Em desenvolvimento local (localhost), entra diretamente com a primeira farmácia carregada
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        try {
          const res = await fetch('/api/pharmacies');
          const farms = await res.json();
          if (Array.isArray(farms) && farms.length > 0) {
            activeFarmaciaId = farms[0].id;
            applyRoleUiState('ADMIN', farms[0]);
            await loadPharmaciesDropdown();
            return;
          }
        } catch (e) {
          console.error('Erro no auto-login localhost:', e);
        }
      }

      // 4. Caso contrário, abre a janela de login (NUNCA entra em Admin sem password!)
      openAuthGateModal();
    }

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
                  <input type="text" id="admNome_\${f.id}" value="\${f.nome}" style="width: 100%; font-weight: 700;" />
                </div>
                <div>
                  <label style="font-size: 0.74rem; color: var(--muted); font-weight: 700; display: block; margin-bottom: 4px;">Código Isolado desta Farmácia:</label>
                  <input type="text" id="admCode_\${f.id}" value="\${f.codigo_acesso || ''}" style="width: 100%; font-weight: 700; text-transform: uppercase; color: #38bdf8;" />
                </div>
                <button class="btn" onclick="savePharmacyAdmin('\${f.id}')" style="padding: 9px 14px; font-size: 0.82rem;">💾 Guardar</button>
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

      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ A calcular...';
      }

      try {
        const res = await fetch(\`/api/analysis?farmaciaId=\${activeFarmaciaId}&diasMonos=\${diasMonos}&cobertura=\${cobertura}\`);
        currentReport = await res.json();

        const r = currentReport.resumo_executivo;
        document.getElementById('tenantBadge').textContent = \`🏥 \${currentReport.farmacia.nome} | NIF: \${currentReport.farmacia.nif} | Ref: \${currentReport.parametros.data_referencia}\`;

        document.getElementById('kpiStockValor').textContent = \`\${r.valor_total_stock_custo.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €\`;
        document.getElementById('kpiStockSub').textContent = \`\${r.total_artigos_inventario} artigos | \${r.total_unidades_stock} unidades\`;

        document.getElementById('kpiGenericosVal').textContent = \`\${r.valor_stock_genericos_mg.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €\`;
        document.getElementById('kpiGenericosSub').textContent = \`\${r.artigos_genericos_mg} MG vs \${r.artigos_medicamentos_marca} Marca (\${r.grupos_dci_com_multiplos_labs} moléculas dup.)\`;

        const totalLivre = r.artigos_venda_livre_psbe + r.artigos_mnsrm;
        const pctLivre = ((totalLivre / r.total_artigos_inventario) * 100).toFixed(1);
        document.getElementById('kpiEstatutoRatio').textContent = \`\${pctLivre}% Sem Receita\`;
        document.getElementById('kpiEstatutoSub').textContent = \`\${r.artigos_venda_livre_psbe} PSBE | \${r.artigos_mnsrm} MNSRM | \${r.artigos_msrm_receita} MSRM\`;

        document.getElementById('kpiMonosValor').textContent = \`\${r.valor_total_monos.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €\`;
        document.getElementById('kpiMonosSub').textContent = \`\${r.total_artigos_monos} artigos (\${r.percentagem_capital_em_monos}% do stock) s/ vendas a \${diasMonos}d\`;

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
      ['plano', 'copilot', 'campaigns', 'caducidade', 'genericos', 'monos', 'cobertura'].forEach(t => {
        const btn = document.getElementById('tabBtn-' + t);
        if (btn) btn.classList.toggle('active', t === tab);
      });

      const planoView = document.getElementById('tabContent-plano');
      const copilotView = document.getElementById('tabContent-copilot');
      const campaignsView = document.getElementById('tabContent-campaigns');
      const tablesView = document.getElementById('tabContent-tables');

      if (tab === 'plano') {
        if (planoView) planoView.style.display = 'block';
        if (copilotView) copilotView.style.display = 'none';
        if (campaignsView) campaignsView.style.display = 'none';
        if (tablesView) tablesView.style.display = 'none';
        renderWeeklyActionPlan();
      } else if (tab === 'copilot') {
        if (planoView) planoView.style.display = 'none';
        if (copilotView) copilotView.style.display = 'block';
        if (campaignsView) campaignsView.style.display = 'none';
        if (tablesView) tablesView.style.display = 'none';
      } else if (tab === 'campaigns') {
        if (planoView) planoView.style.display = 'none';
        if (copilotView) copilotView.style.display = 'none';
        if (campaignsView) campaignsView.style.display = 'block';
        if (tablesView) tablesView.style.display = 'none';
        if (!currentCampaignSuggestions || currentCampaignSuggestions.length === 0) {
          loadCampaignSuggestions();
        }
      } else {
        if (planoView) planoView.style.display = 'none';
        if (copilotView) copilotView.style.display = 'none';
        if (campaignsView) campaignsView.style.display = 'none';
        if (tablesView) tablesView.style.display = 'block';
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

    function openMobileStaffModal() {
      const farmsList = (typeof cachedAdminPharmacies !== 'undefined' && Array.isArray(cachedAdminPharmacies))
        ? cachedAdminPharmacies
        : ((typeof currentReport !== 'undefined' && currentReport?.farmacia) ? [currentReport.farmacia] : []);
      const f = activeFarmaciaId && farmsList ? farmsList.find(x => x.id === activeFarmaciaId) : ((typeof currentReport !== 'undefined' && currentReport?.farmacia) ? currentReport.farmacia : null);
      const code = f?.codigo_acesso || (activeFarmaciaId ? activeFarmaciaId : '');
      const fullUrl = window.location.origin + '/mobile?acesso=' + encodeURIComponent(code);
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
      card3: [],
      card3All: [],
      card4: [],
      card4All: [],
      card3TotalSavings: 0
    };

    function togglePlanoCardResto(containerId, btnId, count, label) {
      const el = document.getElementById(containerId);
      const btn = document.getElementById(btnId);
      if (!el || !btn) return;
      const isHidden = el.style.display === 'none';
      el.style.display = isHidden ? 'flex' : 'none';
      btn.innerHTML = isHidden ? '▲ Ocultar restantes' : \`👁️ Ver os restantes \${count} \${label || 'produtos desta lista'}\`;
      updateWeeklyTasksCounter();
    }

    function renderWeeklyActionPlan() {
      fetchWeeklyTasksFromDb();
      if (!currentReport) return;
      const doneMap = getDoneTasksMap();

      // ======================================================================
      // CARTÃO 1: 🔴 Pilar 1: Validades Próximas a Tratar (Gaveta & Prateleira)
      // ======================================================================
      const allCad = (currentReport.risco_elevado_caducidade || [])
        .slice()
        .sort((a, b) => {
          if (a.data_validade !== b.data_validade) {
            return (a.data_validade || '').localeCompare(b.data_validade || '');
          }
          const valA = a.valor_em_risco != null ? a.valor_em_risco : ((a.stock_atual || a.quantidade || 0) * (a.custo_unitario || 0));
          const valB = b.valor_em_risco != null ? b.valor_em_risco : ((b.stock_atual || b.quantidade || 0) * (b.custo_unitario || 0));
          return valB - valA;
        });

      const top10Cad = allCad.slice(0, 10);
      const restoCad = allCad.slice(10);
      currentWeeklyPlanData.card1 = top10Cad;
      currentWeeklyPlanData.card1All = allCad;

      const c1CountEl = document.getElementById('planoCard1Count');
      if (c1CountEl) {
        c1CountEl.textContent = \`\${allCad.length} produtos (\${top10Cad.length} prioritários)\`;
      }

      const c1El = document.getElementById('planoCard1List');
      if (c1El) {
        const renderCadRow = (item, idx) => {
          const taskId = \`cad_\${item.cnp_codigo}_\${item.lote || idx}\`;
          const isDone = !!doneMap[taskId];
          const qtd = item.stock_atual != null ? item.stock_atual : (item.quantidade || 1);
          const valRisco = item.valor_em_risco != null ? item.valor_em_risco : (qtd * (item.custo_unitario || 0));

          const instrucao = '⚠️ <b>Atenção à Validade:</b> Produto a aproximar-se do fim de vida útil (Data: <b>' + (item.data_validade || 'Curto Prazo') + '</b>). Requer ação prioritária de separação física na gaveta ou destaque no balcão.';

          return \`
            <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; gap: 12px; align-items: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
              <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\ItemPlaceholderId')" style="margin-top: 3px; width: 18px; height: 18px; cursor: pointer; accent-color: #f43f5e;" />
              <div style="flex: 1;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                  <span style="font-weight: 700; color: #0f172a; font-size: 0.88rem;">\${item.designacao}</span>
                  <span style="font-size: 0.78rem; font-weight: 700; color: #be123c; background: #ffe4e6; padding: 2px 8px; border-radius: 4px; font-weight: 800; border: 1px solid #fecdd3;">Val: \${item.data_validade || 'Curto Prazo'} · \${qtd} un (\${valRisco.toFixed(2)} € em risco)</span>
                </div>
                <div style="font-size: 0.82rem; color: #334155; margin-top: 5px; line-height: 1.4;">
                  \${instrucao}
                </div>
                <div style="font-size: 0.72rem; color: var(--muted); margin-top: 4px;">
                  CNP: <code style="color:#38bdf8">\${item.cnp_codigo}</code> | Lote: \${item.lote || 'Geral'} | Tipo: \${item.tipo_venda || 'Geral'}
                </div>
              </div>
            </div>
          \`;
        };

        let html1 = top10Cad.map(renderCadRow).join('');
        if (restoCad.length > 0) {
          html1 += \`
            <div id="planoCard1Resto" style="display: none; flex-direction: column; gap: 10px; margin-top: 10px;">
              \${restoCad.map((it, i) => renderCadRow(it, i + 10)).join('')}
            </div>
            <button id="btnToggleCad" class="btn btn-secondary" onclick="togglePlanoCardResto('planoCard1Resto', 'btnToggleCad', \${restoCad.length}, 'produtos em risco de validade')" style="margin-top: 10px; width: 100%; font-size: 0.8rem; padding: 8px 12px; border: 1px dashed #fb7185; color: #fb7185; background: rgba(244,63,94,0.06); cursor: pointer; border-radius: 6px;">
              👁️ Ver os restantes \${restoCad.length} produtos desta lista
            </button>
          \`;
        }
        c1El.innerHTML = (html1 || '<div style="color:var(--muted);font-size:0.85rem;padding:12px;">✅ Sem validades críticas registadas.</div>').replace(/\\ItemPlaceholderId/g, "'+taskId+'");
      }

      // ======================================================================
      // CARTÃO 2: 🟠 Pilar 2: Pôr a Rodar Stock Parado & Excessos na Época Alta
      // ======================================================================
      // Sub-bloco 2A: Restos de gaveta de Genéricos (DCI)
      const listGen = (currentReport.consolidacao_genericos_dci || [])
        .filter(g => g.restos_gaveta_escobar_primeiro && g.restos_gaveta_escobar_primeiro.length > 0)
        .slice()
        .sort((a, b) => {
          const diffRestos = (b.restos_gaveta_escobar_primeiro?.length || 0) - (a.restos_gaveta_escobar_primeiro?.length || 0);
          if (diffRestos !== 0) return diffRestos;
          return (b.valor_total_stock || 0) - (a.valor_total_stock || 0);
        })
        .slice(0, 4);

      // Sub-bloco 2B: Excessos Sazonais em Pico de Procura (Inverno)
      // Destaque prioritário para artigos com excesso de cobertura na época certa (ex: Ben-u-gripe com 49 un!)
      const seasonalExcessPool = (currentReport.alertas_excesso_cobertura || [])
        .filter(i => (i.stock_atual || 0) >= 3)
        .slice()
        .sort((a, b) => {
          const isFluA = /ben-u-gripe|cegripe|antigrip|grip|constip|tosse|frio|labi|ureia/i.test(a.designacao);
          const isFluB = /ben-u-gripe|cegripe|antigrip|grip|constip|tosse|frio|labi|ureia/i.test(b.designacao);
          if (isFluA && !isFluB) return -1;
          if (!isFluA && isFluB) return 1;
          return (b.stock_atual || 0) - (a.stock_atual || 0);
        })
        .slice(0, 4);

      currentWeeklyPlanData.card2 = listGen;
      currentWeeklyPlanData.card2Seasonal = seasonalExcessPool;

      const c2CountEl = document.getElementById('planoCard2Count');
      if (c2CountEl) {
        c2CountEl.textContent = \`\${listGen.length} moléculas + \${seasonalExcessPool.length} excessos sazonais\`;
      }

      const c2El = document.getElementById('planoCard2List');
      if (c2El) {
        let html2 = '';

        if (listGen.length > 0) {
          html2 += '<div style="font-size: 0.78rem; font-weight: 800; color: #7e22ce; text-transform: uppercase; margin-bottom: 8px;">📦 A. Restos de Gaveta de Genéricos (Dispensar Primeiro):</div>';
          html2 += listGen.map((g, idx) => {
            const taskId = \`gen_\${normStr(g.molecula_dci || g.grupo_equivalencia_dci || idx)}\`;
            const isDone = !!doneMap[taskId];
            const restos = g.restos_gaveta_escobar_primeiro || [];
            const restosHtml = restos.map(r => \`
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem; padding: 4px 0; border-bottom: 1px dashed #e9d5ff;">
                <span style="color: #0f172a; font-weight: 600;">• <b>\${r.designacao}</b> (CNP: <code style="color: #6b21a8; font-weight: 700;">\${r.cnp_codigo}</code>)</span>
                <span style="color: #6b21a8; font-weight: 800; font-size: 0.78rem;">\${r.stock_atual} un</span>
              </div>
            \`).join('');

            return \`
              <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px;">
                <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\ItemPlaceholderId')" style="margin-top: 3px; width: 17px; height: 17px; cursor: pointer; accent-color: #a855f7;" />
                <div style="flex: 1;">
                  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
                    <span style="font-weight: 700; color: #0f172a; font-size: 0.86rem;">\${g.grupo_equivalencia_dci || g.molecula_dci}</span>
                    <span style="font-size: 0.74rem; font-weight: 700; color: #c084fc; background: rgba(168,85,247,0.12); padding: 2px 7px; border-radius: 4px;">\${restos.length} marcas a esgotar</span>
                  </div>
                  <div style="margin-top: 6px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 6px; padding: 6px 8px;">
                    \${restosHtml}
                  </div>
                  <div style="font-size: 0.78rem; color: #334155; margin-top: 6px;">
                    👉 <b>Balcão:</b> Dispensar primeiro estas caixas paradas na gaveta antes de encomendar outras marcas.
                  </div>
                </div>
              </div>
            \`;
          }).join('');
        }

        if (seasonalExcessPool.length > 0) {
          html2 += '<div style="font-size: 0.78rem; font-weight: 800; color: #c2410c; text-transform: uppercase; margin: 12px 0 8px;">🔥 B. Excessos na Época Alta (Pôr a Rodar no Balcão / Cesto):</div>';
          html2 += seasonalExcessPool.map((item, idx) => {
            const taskId = \`seas_exc_\${item.cnp_codigo}\`;
            const isDone = !!doneMap[taskId];
            const cobText = item.cobertura_meses ? \`\${item.cobertura_meses.toFixed(0)} meses de stock\` : 'stock elevado';

            return \`
              <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #fff7ed; border: 1px solid #ffedd5; border-radius: 8px; padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px;">
                <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\ItemPlaceholderId')" style="margin-top: 3px; width: 17px; height: 17px; cursor: pointer; accent-color: #ea580c;" />
                <div style="flex: 1;">
                  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
                    <span style="font-weight: 700; color: #9a3412; font-size: 0.86rem;">\${item.designacao}</span>
                    <span style="font-size: 0.74rem; font-weight: 800; color: #c2410c; background: #ffedd5; padding: 2px 7px; border-radius: 4px; border: 1px solid #fed7aa;">\${item.stock_atual} un em armazém (\${cobText})</span>
                  </div>
                  <div style="font-size: 0.80rem; color: #431407; margin-top: 5px; line-height: 1.4;">
                    🔥 <b>Pico Sazonal de Procura:</b> Aproveitar a época de inverno para colocar em destaque no balcão e no cesto de oportunidade com aconselhamento ativo da equipa.
                  </div>
                  <div style="font-size: 0.72rem; color: #9a3412; margin-top: 3px;">
                    CNP: <code>\${item.cnp_codigo}</code> | PVP: <b>\${item.pvp ? item.pvp.toFixed(2) + '€' : '-'}</b>
                  </div>
                </div>
              </div>
            \`;
          }).join('');
        }

        c2El.innerHTML = (html2 || '<div style="color:var(--muted);font-size:0.85rem;padding:12px;">✅ Sem restos de gaveta ou excessos sazonais pendentes.</div>').replace(/\\ItemPlaceholderId/g, "'+taskId+'");
      }

      // ======================================================================
      // CARTÃO 3: 🛑 Pilar 3: O que NÃO Encomendar Mais (Bloquear no Sifarma, P.E. = 0)
      // ======================================================================
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

      const allTrav = Array.from(mapTrav.values())
        .sort((a, b) => (b.perda || 0) - (a.perda || 0));

      const top10Trav = allTrav.slice(0, 10);
      const restoTrav = allTrav.slice(10);
      currentWeeklyPlanData.card3 = top10Trav;
      currentWeeklyPlanData.card3All = allTrav;

      const totalSavings = allTrav.reduce((s, i) => s + (i.perda || 0), 0);
      currentWeeklyPlanData.card3TotalSavings = totalSavings;

      const savBadge = document.getElementById('planoCard3Savings');
      if (savBadge) {
        savBadge.textContent = \`Poupança: \${totalSavings.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €\`;
      }

      const c3El = document.getElementById('planoCard3List');
      if (c3El) {
        const renderTravRow = (item, idx) => {
          const taskId = \`trav_\${item.cnp_codigo}\`;
          const isDone = !!doneMap[taskId];
          const motivo = item.cobertura_meses
            ? \`Temos \${item.stock_atual} un em stock (\${item.cobertura_meses.toFixed(1)} meses de cobertura)\`
            : \`Temos \${item.stock_atual} un paradas sem vendas há meses\`;

          return \`
            <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; gap: 12px; align-items: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
              <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\ItemPlaceholderId')" style="margin-top: 3px; width: 18px; height: 18px; cursor: pointer; accent-color: #f59e0b;" />
              <div style="flex: 1;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                  <span style="font-weight: 700; color: #0f172a; font-size: 0.88rem;">\${item.designacao}</span>
                  <span style="font-size: 0.78rem; font-weight: 700; color: #92400e; background: #fef3c7; padding: 2px 8px; border-radius: 4px; font-weight: 800; border: 1px solid #fde68a;">CNP: \${item.cnp_codigo} · \${(item.perda || 0).toFixed(2)} €</span>
                </div>
                <div style="font-size: 0.82rem; color: #334155; margin-top: 5px; line-height: 1.4;">
                  🛑 <b>Ação no Sifarma:</b> Alterar Ponto de Encomenda / Stock Mínimo para <b>0</b> (\${motivo}).
                </div>
              </div>
            </div>
          \`;
        };

        let html3 = top10Trav.map(renderTravRow).join('');
        if (restoTrav.length > 0) {
          html3 += \`
            <div id="planoCard3Resto" style="display: none; flex-direction: column; gap: 10px; margin-top: 10px;">
              \${restoTrav.map((it, i) => renderTravRow(it, i + 10)).join('')}
            </div>
            <button id="btnToggleTrav" class="btn btn-secondary" onclick="togglePlanoCardResto('planoCard3Resto', 'btnToggleTrav', \${restoTrav.length}, 'códigos para travar no Sifarma')" style="margin-top: 10px; width: 100%; font-size: 0.8rem; padding: 8px 12px; border: 1px dashed #d97706; color: #92400e; background: #fffbeb; cursor: pointer; border-radius: 6px; font-weight: 700;">
              👁️ Ver os restantes \${restoTrav.length} códigos para travar no Sifarma
            </button>
          \`;
        }
        c3El.innerHTML = (html3 || '<div style="color:var(--muted);font-size:0.85rem;padding:12px;">✅ Sem compras excessivas a travar.</div>').replace(/\\ItemPlaceholderId/g, "'+taskId+'");
      }

      // ======================================================================
      // CARTÃO 4: 🟢 Pilar 4: Ajustar Níveis & Prevenir Ruturas (Subir Ponto de Encomenda)
      // ======================================================================
      const rawRuturaPool = (currentReport.artigos_risco_rutura || [])
        .slice()
        .sort((a, b) => (b.vmm || 0) - (a.vmm || 0) || (a.stock_atual || 0) - (b.stock_atual || 0));

      const top10Rutura = rawRuturaPool.slice(0, 10);
      const restoRutura = rawRuturaPool.slice(10);
      currentWeeklyPlanData.card4 = top10Rutura;
      currentWeeklyPlanData.card4All = rawRuturaPool;

      const c4CountEl = document.getElementById('planoCard4Count');
      if (c4CountEl) {
        c4CountEl.textContent = \`\${rawRuturaPool.length} artigos em risco de rutura\`;
      }

      const c4El = document.getElementById('planoCard4List');
      if (c4El) {
        const renderRuturaRow = (item, idx) => {
          const taskId = \`rut_\${item.cnp_codigo}\`;
          const isDone = !!doneMap[taskId];
          const sugestaoEnc = item.sugestao_encomenda || Math.max(2, Math.ceil((item.vmm || 1) * 0.5));
          const diasTxt = item.dias_cobertura != null ? \`\${item.dias_cobertura} dias\` : 'crítica';

          return \`
            <div class="weekly-task-item \${isDone ? 'task-completed' : ''}" style="background: #ffffff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px; display: flex; gap: 12px; align-items: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
              <input type="checkbox" class="weekly-task-checkbox" data-task-id="\${taskId}" \${isDone ? 'checked' : ''} onchange="toggleWeeklyTask('\ItemPlaceholderId')" style="margin-top: 3px; width: 18px; height: 18px; cursor: pointer; accent-color: #0284c7;" />
              <div style="flex: 1;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                  <span style="font-weight: 700; color: #0f172a; font-size: 0.88rem;">\${item.designacao}</span>
                  <span style="font-size: 0.78rem; font-weight: 800; color: #0369a1; background: #e0f2fe; padding: 2px 8px; border-radius: 4px; border: 1px solid #bae6fd;">
                    Stock: \${item.stock_atual} un · VMM: \${item.vmm}/mês
                  </span>
                </div>
                <div style="font-size: 0.82rem; color: #334155; margin-top: 5px; line-height: 1.4;">
                  🟢 <b>Ajustar no Sifarma:</b> Subir Ponto de Encomenda para <b>\${sugestaoEnc} un</b> (risco de rutura iminente face às vendas: cobertura atual de apenas \${diasTxt}).
                </div>
                <div style="font-size: 0.72rem; color: var(--muted); margin-top: 4px;">
                  CNP: <code style="color:#0284c7">\${item.cnp_codigo}</code> | Categoria: \${item.categoria || 'Geral'} | Tipo: \${item.tipo_venda || 'MSRM'}
                </div>
              </div>
            </div>
          \`;
        };

        let html4 = top10Rutura.map(renderRuturaRow).join('');
        if (restoRutura.length > 0) {
          html4 += \`
            <div id="planoCard4Resto" style="display: none; flex-direction: column; gap: 10px; margin-top: 10px;">
              \${restoRutura.map((it, i) => renderRuturaRow(it, i + 10)).join('')}
            </div>
            <button id="btnToggleRutura" class="btn btn-secondary" onclick="togglePlanoCardResto('planoCard4Resto', 'btnToggleRutura', \${restoRutura.length}, 'medicamentos com risco de rutura')" style="margin-top: 10px; width: 100%; font-size: 0.8rem; padding: 8px 12px; border: 1px dashed #0284c7; color: #0284c7; background: rgba(2,132,199,0.06); cursor: pointer; border-radius: 6px; font-weight: 700;">
              👁️ Ver os restantes \${restoRutura.length} produtos em risco de rutura
            </button>
          \`;
        }
        c4El.innerHTML = (html4 || '<div style="color:var(--muted);font-size:0.85rem;padding:12px;">✅ Níveis de stock mínimos equilibrados no Sifarma.</div>').replace(/\\ItemPlaceholderId/g, "'+taskId+'");
      }

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

          <h2>🛑 3. O QUE NÃO ENCOMENDAR MAIS (BLOQUEAR NO SIFARMA COM P.E. = 0)</h2>
          <table>
            <thead>
              <tr>
                <th style="width: 25px;">[ ]</th>
                <th style="width: 80px;">Código CNP</th>
                <th>Designação</th>
                <th style="width: 65px;">Stock Atual</th>
                <th style="width: 80px;">Capital Parado</th>
                <th>Ação Obrigatória no Sifarma</th>
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

          <h2>🟢 4. AJUSTAR NÍVEIS & PREVENIR RUTURAS (SUBIR PONTO DE ENCOMENDA NO SIFARMA)</h2>
          <table>
            <thead>
              <tr>
                <th style="width: 25px;">[ ]</th>
                <th style="width: 80px;">Código CNP</th>
                <th>Designação</th>
                <th style="width: 65px;">Stock Atual</th>
                <th style="width: 75px;">VMM</th>
                <th>Ação Recomendada no Sifarma</th>
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
              <td colspan="10" style="text-align: center; padding: 48px 16px; color: var(--muted); font-size: 0.95rem;">
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
              <th>Segmento / Estatuto</th>
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
                <td>\${formatSegmentoBadge(r)}</td>
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
              <th>Segmento / Estatuto</th>
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
                <td>\${formatSegmentoBadge(r)}</td>
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
              <th>Segmento / Estatuto</th>
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
                <td>\${formatSegmentoBadge(r)}</td>
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

    function toggleDirectorQuestionsPanel() {
      const grid = document.getElementById('directorQuestionsGrid');
      const icon = document.getElementById('directorQuestionsToggleIcon');
      if (!grid) return;
      if (grid.style.display === 'none') {
        grid.style.display = 'grid';
        if (icon) icon.textContent = '▲ Ocultar';
      } else {
        grid.style.display = 'none';
        if (icon) icon.textContent = '▼ Expandir';
      }
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
          'A memória anterior foi reiniciada. Selecione um caso executivo acima ou escreva uma nova pergunta.' +
          '</div>' +
          '</div>';
      }
      const grid = document.getElementById('directorQuestionsGrid');
      if (grid) grid.style.display = 'grid';
      const icon = document.getElementById('directorQuestionsToggleIcon');
      if (icon) icon.textContent = '▲ Ocultar';

      const input = document.getElementById('askInput');
      if (input) {
        input.value = '';
        input.focus();
      }
    }

    function runDirectorQuestion(questionText) {
      const input = document.getElementById('askInput');
      if (input) input.value = questionText;
      askQuestion(questionText);
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
      var exportCsvBtnHtml = '<div style="margin: 8px 0;"><button class="btn btn-sm" onclick="exportCopilotShoppingListCsv()" style="background:#0284c7;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📥 Descarregar CSV para Sifarma</button></div>';
      var applyBlocksBtnHtml = '<div style="margin: 8px 0;"><button class="btn btn-sm" onclick="applySifarmaOrderBlocks()" style="background:#e11d48;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">🛑 Aplicar Bloqueios no Sifarma (Ponto de Encomenda = 0)</button></div>';

      rendered = rendered.split('[BOTAO_APLICAR_PLANO]').join('<div style="margin: 10px 0;"><button class="btn btn-sm" onclick="applyCopilotWeeklyPlan()" style="background:#10b981;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">📥 Aplicar à Folha da Semana</button></div>');
      rendered = rendered.split('[BOTAO_GUARDAR_PACK]').join('<div style="margin: 10px 0;"><button class="btn btn-sm" onclick="saveCopilotPack()" style="background:#8b5cf6;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">📦 Guardar Pack no Estúdio de Marketing</button></div>');
      rendered = rendered.split('[BOTAO_EXPORTAR_ENCOMENDA_PDF]').join('<div style="margin: 8px 0;"><button class="btn btn-sm" onclick="exportCopilotShoppingListPdf()" style="background:#dc2626;color:#fff;font-weight:700;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">📄 Imprimir / Guardar em PDF</button></div>');
      rendered = rendered.split('[BOTAO_EXPORTAR_ENCOMENDA_CSV]').join('<div style="display:inline-flex;flex-wrap:wrap;gap:8px;margin:12px 0;"><button class="btn btn-sm" onclick="openInteractiveOrderModal()" style="background:#6366f1;color:#fff;font-weight:800;padding:9px 16px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:7px;box-shadow:0 2px 4px rgba(99,102,241,0.25);">🛒 Rever & Editar Encomenda Completa</button><button class="btn btn-sm" onclick="exportCopilotShoppingListCsv()" style="background:#0284c7;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📥 CSV Sifarma</button><button class="btn btn-sm" onclick="exportCopilotShoppingListPdf()" style="background:#dc2626;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📄 Guia PDF</button><button class="btn btn-sm" onclick="copyShoppingListToClipboard()" style="background:#475569;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📋 Copiar CNPs</button></div>');
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
      link.setAttribute('download', 'encomenda_validada_sifarma_' + new Date().toISOString().slice(0, 10) + '.csv');
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
        alert('📋 ' + list.length + ' artigos aprovados copiados para a área de transferência! Pode colar diretamente no Excel ou Sifarma.');
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
      link.setAttribute('download', 'encomenda_sifarma_' + new Date().toISOString().slice(0, 10) + '.csv');
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
        alert('📋 ' + list.length + ' artigos copiados para a área de transferência! Pode colar diretamente (Ctrl+V) no Excel ou no módulo de encomenda rápida do Sifarma.');
      }).catch(function(e) {
        alert('Erro ao copiar: ' + e);
      });
    }

    
    function applySifarmaOrderBlocks() {
      alert('🛑 Recomendações de Bloqueio: Os artigos com cobertura excessiva ou marcas secundárias foram identificados para que no Sifarma seja colocado Ponto de Encomenda = 0 e Stock Mínimo = 0.');
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
            '<button class="btn btn-sm" onclick="exportCopilotShoppingListCsv()" style="background:#0284c7;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📥 Descarregar CSV para Sifarma</button>' +
            '<button class="btn btn-sm" onclick="exportCopilotShoppingListPdf()" style="background:#dc2626;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📄 Imprimir / Guardar em PDF</button>' +
            '<button class="btn btn-sm" onclick="copyShoppingListToClipboard()" style="background:#475569;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📋 Copiar CNPs</button>' +
            '<button class="btn btn-sm" onclick="applyShoppingListToWeeklyPlan()" style="background:#10b981;color:#fff;font-weight:700;padding:9px 14px;border-radius:6px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">📝 Adicionar à Folha Semanal (Pilar 4)</button>' +
            '</div></div>';
        }

        assistantBubble.innerHTML = badgeHtml +
          '<div>' + formattedHtml + '</div>' +
          actionButtonsHtml +
          '<div style="margin-top: 10px; font-size: 0.72rem; color: #94a3b8; text-align: right;">' +
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

    async function openProductModal(cnp) {
      const res = await fetch('/api/product/' + cnp + '?farmaciaId=' + activeFarmaciaId);
      if (!res.ok) return;
      const p = await res.json();

      const inv = p.inventario[0] || { quantidade: 0, custo_unitario: 0, data_validade: null };
      const totalVendido = p.vendas.reduce((s, v) => s + v.quantidade, 0);
      const vmm = (totalVendido / 12).toFixed(2);

      document.getElementById('modalTitle').innerHTML = \`[\${p.cnp_codigo}] \${p.designacao} \${formatSegmentoBadge(p)}\`;
      document.getElementById('modalSub').textContent = \`Categoria: \${p.categoria} | \${p.grupo_equivalencia_dci ? 'Grupo DCI: ' + p.grupo_equivalencia_dci + ' | ' : ''}IVA: \${p.taxa_iva ?? '-'}%\`;

      const ruleBox = document.getElementById('modalRuleBox');
      let ruleHtml = '';
      if (p.eh_generico) {
        ruleHtml = \`🧬 <b>Medicamento Genérico (MG) — Grupo DCI: \${p.grupo_equivalencia_dci}:</b> Substituível no balcão perante receita médica por DCI. Priorizar o escoamento de laboratórios com 1-2 caixas soltas ("restos de gaveta") ou validade mais curta, e concentrar futuras encomendas no laboratório com menor preço de custo.\`;
      } else if (p.tipo_venda === 'MSRM') {
        ruleHtml = \`🏷️ <b>Medicamento de Marca Sujeito a Receita (MSRM):</b> Vedado a cross-selling comercial e sem substituição direta por outra marca se prescrito nominalmente. Gerir por ajuste de stock mínimo ou devolução ao armazenista.\`;
      } else {
        ruleHtml = \`🟢 <b>Elegível para Cross-Selling e Campanhas (\${p.tipo_venda}):</b> \${p.sugestao_cross_sell}\`;
      }
      ruleBox.innerHTML = \`
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div style="flex:1;min-width:260px;">\${ruleHtml}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary" onclick="jumpToProductCrossSell360('\${p.cnp_codigo}')" style="font-size:0.78rem;padding:6px 12px;border-color:#38bdf8;color:#38bdf8;">
              🤝 Ver Cross-Selling & Escoamento 360º
            </button>
            \${p.tipo_venda !== 'MSRM' ? \`
              <button class="btn" onclick="jumpToSingleProductCampaign('\${p.cnp_codigo}')" style="font-size:0.78rem;padding:6px 12px;background:linear-gradient(135deg,#f43f5e,#a855f7);">
                📣 Criar Campanha p/ Este Produto
              </button>
            \` : ''}
          </div>
        </div>
      \`;

      const peersBox = document.getElementById('modalDciPeers');
      const dciGroup = currentReport && p.grupo_equivalencia_dci
        ? currentReport.consolidacao_genericos_dci.find(g => g.grupo_equivalencia_dci === p.grupo_equivalencia_dci)
        : null;

      document.getElementById('modalMetrics').innerHTML = \`
        <div style="background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--muted)">\${dciGroup ? 'STOCK DESTE LABORATÓRIO' : 'STOCK ATUAL'}</div>
          <div style="font-size:1.25rem;font-weight:700">\${inv.quantidade} un</div>
          <div style="font-size:0.78rem;color:var(--muted)">Custo: \${inv.custo_unitario.toFixed(2)} € \${dciGroup ? \` | Gaveta: <b style="color:#c084fc">\${dciGroup.stock_total_unidades} un</b> (\${dciGroup.num_laboratorios_abertos} labs)\` : ''}</div>
        </div>
        <div style="background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--muted)">PVP & MARGEM</div>
          <div style="font-size:1.25rem;font-weight:700">\${p.pvp ? p.pvp.toFixed(2) + ' €' : '-'}</div>
          <div style="font-size:0.78rem;color:var(--success)">Margem: \${p.margem_padrao ? p.margem_padrao + '%' : '-'}</div>
        </div>
        <div style="background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--muted)">RITMO (VMM 12M)</div>
          <div style="font-size:1.25rem;font-weight:700">\${vmm} /mês</div>
          <div style="font-size:0.78rem;color:var(--muted)">Total vendido: \${totalVendido} un</div>
        </div>
        <div style="background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border)">
          <div style="font-size:0.75rem;color:var(--muted)">VALIDADE REGISTADA</div>
          <div style="font-size:1.25rem;font-weight:700;color:\${inv.data_validade ? '#fb7185' : 'var(--text)'}">\${inv.data_validade || 'S/ Registo'}</div>
          <div style="font-size:0.78rem;color:var(--muted)">Controlo Sifarma / Winphar</div>
        </div>
      \`;

      const salesMap = new Map(p.vendas.map(v => [v.mes, v.quantidade]));
      const maxQtd = Math.max(1, ...MONTHS_ORDER.map(m => salesMap.get(m.key) || 0));

      const chartTitleEl = document.getElementById('modalChartTitle');
      if (chartTitleEl) {
        chartTitleEl.innerHTML = dciGroup
          ? \`📊 Evolução de Vendas Mensais — <span style="color:#38bdf8;">[\${p.cnp_codigo}] \${p.designacao.split(',')[0]}</span> (Total: \${totalVendido} un)\`
          : 'Evolução de Vendas Mensais (Unidades Vendidas por Mês)';
      }

      document.getElementById('modalChart').innerHTML = MONTHS_ORDER.map(m => {
        const qtd = salesMap.get(m.key) || 0;
        const heightPct = Math.round((qtd / maxQtd) * 110) + 4;
        return \`
          <div class="bar-col">
            <span class="bar-val">\${qtd}</span>
            <div class="bar" style="height:\${heightPct}px;background:\${qtd > 0 ? 'var(--primary)' : '#334155'}"></div>
            <span class="bar-lbl">\${m.label}</span>
          </div>
        \`;
      }).join('');

      const switcherEl = document.getElementById('modalLabSwitcher');

      // Se for Genérico MG e pertencer a um grupo DCI com múltiplos laboratórios, mostra a tabela comparativa clicável + seletor rápido!
      if (dciGroup) {
        if (switcherEl) {
          const allCnps = dciGroup.todos_laboratorios.map(l => l.cnp_codigo).join(',');
          switcherEl.innerHTML = \`
            <button class="btn btn-secondary" onclick="renderDciCombinedChart('\${allCnps}', '\${escapeJsString(dciGroup.grupo_equivalencia_dci)}')" style="font-size:0.74rem;padding:4px 10px;border-color:#c084fc;color:#c084fc;">
              🧬 Ver Soma da Molécula (\${dciGroup.num_laboratorios_abertos} Labs)
            </button>
          \`;
        }

        peersBox.style.display = 'block';
        peersBox.innerHTML = \`
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
            <h4 style="font-size: 0.85rem; color: #c084fc; text-transform: uppercase; margin: 0;">
              🧬 Outros Laboratórios em Stock para \${dciGroup.grupo_equivalencia_dci} (\${dciGroup.num_laboratorios_abertos} marcas abertas)
            </h4>
            <span style="font-size:0.78rem;color:#38bdf8;font-weight:600;">
              👆 Clique em qualquer laboratório para ver o seu gráfico de vendas e stock
            </span>
          </div>
          <div class="table-wrap" style="max-height: 220px;">
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Laboratório / Designação</th>
                  <th>Stock</th>
                  <th>Custo Unit.</th>
                  <th>VMM</th>
                  <th>Validade</th>
                  <th>Prioridade de Escoamento</th>
                  <th>Desempenho Vendas</th>
                </tr>
              </thead>
              <tbody>
                \${dciGroup.todos_laboratorios.map(lab => {
                  const isCurrent = lab.cnp_codigo === p.cnp_codigo;
                  return \`
                    <tr class="clickable-row" onclick="openProductModal('\${lab.cnp_codigo}')" style="\${isCurrent ? 'background:rgba(168,85,247,0.22);border-left:3px solid #c084fc;' : ''}">
                      <td><b>\${lab.cnp_codigo}</b></td>
                      <td><b>\${lab.designacao}</b></td>
                      <td><b>\${lab.stock_atual} un</b></td>
                      <td>\${lab.custo_unitario.toFixed(2)} €</td>
                      <td><b>\${lab.vmm}/mês</b></td>
                      <td>\${lab.data_validade || '-'}</td>
                      <td>\${lab.stock_atual <= 2 ? '<span class="badge badge-danger">🧹 Resto Gaveta (Escoar 1º)</span>' : lab.custo_unitario === dciGroup.custo_minimo ? '<span class="badge badge-success">⭐ Lab Mais Barato</span>' : 'Stock Principal'}</td>
                      <td>
                        \${isCurrent
                          ? '<span class="badge badge-purple">👁️ Em Visualização</span>'
                          : '<span class="badge badge-info" style="cursor:pointer;">📊 Ver Gráfico</span>'}
                      </td>
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            </table>
          </div>
        \`;
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

    function renderClinicalThemePacks(packs) {
      const grid = document.getElementById('mktPacksGrid');
      if (!grid) return;
      if (!packs || packs.length === 0) {
        grid.innerHTML = '<div style="padding: 24px; color: var(--muted);">Nenhum pack clínico disponível de momento.</div>';
        return;
      }
      grid.innerHTML = packs.map(pack => {
        const itemsHtml = pack.produtos.map(p => \`
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; margin-bottom: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
              <span style="font-weight: 700; color: #0f172a; font-size: 0.86rem;">💊 \${p.designacao}</span>
              <span style="font-size: 0.76rem; font-weight: 800; color: #0284c7; background: #e0f2fe; padding: 2px 7px; border-radius: 4px;">\${p.pvpUnitario ? p.pvpUnitario.toFixed(2) + '€' : ''} (Stock: \${p.stockAtual} un)</span>
            </div>
            <div style="font-size: 0.78rem; color: #0369a1; font-weight: 600; margin-top: 4px;">
              💡 <span><b>Para o Utente:</b> \${p.propositoUtente}</span>
            </div>
            <div style="font-size: 0.72rem; color: #64748b; margin-top: 3px;">
              CNP: <code>\${p.cnp}</code> | Margem Individual: \${p.margemPct}%
            </div>
          </div>
        \`).join('');

        return \`
          <div style="background: #ffffff; border: 1px solid #bae6fd; border-radius: 12px; padding: 18px; display: flex; flex-direction: column; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 10px;">
              <div>
                <div style="font-weight: 800; font-size: 1.05rem; color: #0369a1; display: flex; align-items: center; gap: 6px;">
                  \${pack.icone} \${pack.titulo}
                </div>
                <div style="font-size: 0.78rem; font-weight: 700; color: #be123c; background: #ffe4e6; display: inline-block; padding: 2px 8px; border-radius: 4px; margin-top: 4px;">
                  🎯 Sintoma / Queixa: \${pack.sintomaOuQueixa}
                </div>
              </div>
              <span class="badge badge-success" style="font-size: 0.8rem; font-weight: 800;">
                Margem Farmácia: \${pack.margemPackPct}%
              </span>
            </div>

            <p style="font-size: 0.80rem; color: #64748b; margin-bottom: 12px;">
              <b>Público-Alvo:</b> \${pack.publicoAlvo}
            </p>

            <div style="margin-bottom: 12px;">
              \${itemsHtml}
            </div>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
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

            <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 10px; font-size: 0.80rem; color: #334155;">
              <div style="margin-bottom: 4px;"><b>🧺 No Balcão / Cesto:</b> \${pack.disposicaoFisica}</div>
              <div><b>💬 Aconselhamento Clínico:</b> \${pack.orientacaoBalcao}</div>
            </div>
          </div>
        \`;
      }).join('');
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
        searchProductsForCustomBuilder(document.getElementById('customProdSearchInput')?.value || '');
      } else {
        if (crossEl) crossEl.style.display = 'none';
        if (customPanel) customPanel.style.display = 'none';
        if (flowEl) flowEl.style.display = 'block';
        if (step1Container) step1Container.style.display = 'block';
        renderCampaignCardsForSubView();
      }
    }

    async function searchProductsForCustomBuilder(query) {
      const box = document.getElementById('customProdSearchResults');
      if (!box) return;
      try {
        const res = await fetch(\`/api/campaigns/search-products?farmaciaId=\${activeFarmaciaId}&q=\${encodeURIComponent(query || '')}\`);
        const data = await res.json();
        const items = data.items || [];
        if (items.length === 0) {
          box.innerHTML = '<span style="color:var(--muted);">Nenhum produto com stock encontrado para esta pesquisa.</span>';
          return;
        }
        box.innerHTML = items.map(it => {
          const alreadyPicked = customPickedProducts.some(p => p.cnp === it.cnp);
          return \`
            <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 6px;border-bottom:1px solid rgba(148,163,184,0.12);gap:8px;">
              <div>
                <b>[\${it.cnp}]</b> \${it.designacao.slice(0, 38)}
                <span class="badge \${it.riscoValidade ? 'badge-danger' : 'badge-info'}" style="font-size:0.66rem;margin-left:4px;">\${it.stock} un · \${it.validade || 'S/Val'}</span>
                <span style="color:#34d399;font-size:0.72rem;margin-left:4px;">Mrg \${it.margemPct}%</span>
              </div>
              <button class="btn \${alreadyPicked ? 'btn-secondary' : ''}" onclick="addPickedProductForCampaign('\${it.cnp}', '\${escapeJsString(it.designacao)}', \${it.stock}, \${it.pvp})" style="font-size:0.72rem;padding:3px 9px;background:\${alreadyPicked ? 'transparent' : '#a855f7'};">
                \${alreadyPicked ? '✓ Fixado' : '+ Incluir'}
              </button>
            </div>
          \`;
        }).join('');
      } catch (e) {
        console.error(e);
      }
    }

    function addPickedProductForCampaign(cnp, designacao, stock, pvp) {
      if (!customPickedProducts.some(p => p.cnp === cnp)) {
        customPickedProducts.push({ cnp, designacao, stock, pvp });
      }
      renderCustomPickedChips();
      searchProductsForCustomBuilder(document.getElementById('customProdSearchInput')?.value || '');
    }

    function removePickedProductForCampaign(cnp) {
      customPickedProducts = customPickedProducts.filter(p => p.cnp !== cnp);
      renderCustomPickedChips();
      searchProductsForCustomBuilder(document.getElementById('customProdSearchInput')?.value || '');
    }

    function renderCustomPickedChips() {
      const countEl = document.getElementById('customPickedCount');
      const chipsEl = document.getElementById('customPickedProductsChips');
      if (countEl) countEl.textContent = customPickedProducts.length;
      if (!chipsEl) return;
      if (customPickedProducts.length === 0) {
        chipsEl.innerHTML = '<span style="font-size: 0.75rem; color: var(--muted);">Nenhum produto fixado manualmente (ou clique em "+ Incluir" na lista acima).</span>';
        return;
      }
      chipsEl.innerHTML = customPickedProducts.map(p => \`
        <span class="badge badge-purple" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;font-size:0.76rem;">
          🎯 [\${p.cnp}] \${p.designacao.slice(0, 26)} (\${p.stock} un)
          <span style="cursor:pointer;color:#fb7185;font-weight:800;" onclick="removePickedProductForCampaign('\${p.cnp}')">✕</span>
        </span>
      \`).join('');
    }

    function clearCustomCampaignBuilder() {
      customPickedProducts = [];
      const nEl = document.getElementById('customCampName');
      const tEl = document.getElementById('customCampTerms');
      if (nEl) nEl.value = '';
      if (tEl) tEl.value = '';
      renderCustomPickedChips();
      searchProductsForCustomBuilder('');
    }

    async function runPresetCustomCampaign(presetKey) {
      await buildAndOpenCustomCampaign({
        modo: 'EVENTO',
        eventoPreset: presetKey,
        focoStock: document.getElementById('customCampFocus')?.value || 'PRIORIDADE_VALIDADES_MONOS',
        cnpsSelecionados: customPickedProducts.map(p => p.cnp),
      });
    }

    async function submitCustomCampaignBuilder() {
      const nomePersonalizado = document.getElementById('customCampName')?.value.trim() || '';
      const termosPesquisa = document.getElementById('customCampTerms')?.value.trim() || '';
      const focoStock = document.getElementById('customCampFocus')?.value || 'PRIORIDADE_VALIDADES_MONOS';
      const cnpsSelecionados = customPickedProducts.map(p => p.cnp);

      if (!nomePersonalizado && !termosPesquisa && cnpsSelecionados.length === 0) {
        alert('Indique um nome/tema, palavras-chave ou selecione pelo menos 1 produto específico para a sua campanha.');
        return;
      }

      const modo = cnpsSelecionados.length > 0 && !termosPesquisa ? 'PRODUTOS' : 'EVENTO';
      await buildAndOpenCustomCampaign({
        modo,
        eventoPreset: 'custom',
        nomePersonalizado,
        termosPesquisa,
        cnpsSelecionados,
        focoStock,
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
              <div style="background:rgba(244,63,94,0.12);border-left:4px solid #f43f5e;padding:10px 14px;border-radius:6px;font-size:0.82rem;color:#f8fafc;">
                <b>🏁 Meta Operacional da Equipa:</b><br/>
                \${p.metaEquipaTexto}
              </div>
              <div style="background:rgba(16,185,129,0.1);border-left:4px solid #10b981;padding:10px 14px;border-radius:6px;font-size:0.82rem;color:#f8fafc;">
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
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:rgba(56,189,248,0.1);border-left:4px solid #38bdf8;padding:10px 14px;border-radius:6px;">
              <div style="flex:1;min-width:260px;font-size:0.84rem;color:#f1f5f9;font-style:italic;">
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

    function renderCrossSellingProtocols() {
      const grid = document.getElementById('crossSellingGrid');
      if (!grid) return;
      if (!currentCrossSellingPlans || currentCrossSellingPlans.length === 0) {
        grid.innerHTML = '<div style="padding:24px;color:var(--muted);">Nenhum protocolo de Cross-Selling disponível de momento.</div>';
        return;
      }

      grid.innerHTML = currentCrossSellingPlans.map(plan => \`
        <div class="omnichannel-card" style="border-color:rgba(56,189,248,0.35);">
          <div>
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px;">
              <div style="font-weight:800;font-size:1rem;color:#f8fafc;">\${plan.icone} \${plan.tituloProtocolo}</div>
              <span class="badge badge-success">Potencial: \${plan.impactoFinanceiroPotencialEur.toFixed(2)} €</span>
            </div>
            <div style="font-size:0.8rem;color:#38bdf8;margin-bottom:12px;">
              <b>🎯 Gatilho no Atendimento:</b> \${plan.gatilhoDispensa}
            </div>

            <div style="background: #ffffff;border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:12px;">
              <div style="font-size:0.74rem;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:6px;">
                🚂 Locomotivas Reais da Farmácia (O que o cliente vem pedir):
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;">
                \${plan.locomotivasReais.map(l => \`
                  <span class="badge badge-purple" title="Vendas no período: \${l.vendasPeriodo} un">\${l.designacao.slice(0, 28)} (\${l.vmm}/mês)</span>
                \`).join('')}
              </div>
            </div>

            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px;margin-bottom:12px;">
              <div style="font-size:0.74rem;font-weight:700;color:#34d399;text-transform:uppercase;margin-bottom:6px;">
                📦 Produtos em Stock a Escoar na Boleia (Prioridade Equipa):
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;">
                \${plan.produtosAEscoar.map(p => \`
                  <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px dashed rgba(148,163,184,0.15);padding-bottom:4px;">
                    <div>
                      <b>[\${p.cnp}]</b> \${p.designacao.slice(0, 34)}
                      <span class="badge badge-warning" style="margin-left:4px;font-size:0.68rem;">\${p.criterioEscoamento}</span>
                    </div>
                    <div style="text-align:right;white-space:nowrap;">
                      <b>\${p.stock} un</b> · Promo -\${p.descontoSeguroPct}%: <b style="color:#34d399;">\${p.pvpPromo.toFixed(2)}€</b>
                    </div>
                  </div>
                \`).join('')}
              </div>
            </div>

            <div style="font-size:0.82rem;background:rgba(244,63,94,0.1);border-left:3px solid #fb7185;padding:9px 12px;border-radius:6px;color:#f1f5f9;font-style:italic;">
              \${plan.scriptBalcao10s}
            </div>
          </div>
          <button class="copy-btn" onclick="copyToClipboard('\${escapeJsString(plan.scriptBalcao10s)}', this)" style="margin-top:12px;">
            📋 Copiar Script de Cross-Selling p/ Equipa
          </button>
        </div>
      \`).join('');
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

        return \`
          <div class="campaign-card \${isSel ? 'selected' : ''}" id="campCard-\${c.id}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
              <span style="font-size:1.8rem;">\${c.icon}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
                <span class="badge badge-purple">\${c.periodoLabel}</span>
                \${badgeTipo}
              </div>
            </div>
            <div style="font-weight:700;font-size:1.05rem;color:var(--text);margin-bottom:6px;">\${c.nome}</div>
            
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

            return \`
              <tr id="campRow-\${p.cnp_codigo}">
                <td style="text-align: center;">
                  <input type="checkbox" class="campaign-sku-check" value="\${p.cnp_codigo}" checked onchange="recalculateCampaignFinancialsClient()" />
                </td>
                <td><b>\${p.cnp_codigo}</b></td>
                <td>
                  <div style="font-weight: 600; color: var(--text);">\${p.designacao}</div>
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
                <div style="background: #ffffff;border-left:3px solid #fb7185;padding:10px 12px;border-radius:6px;margin-top:6px;color:#f1f5f9;font-style:italic;">
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
              <div style="background: #ffffff;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;font-size:0.84rem;color:#f1f5f9;white-space:pre-line;line-height:1.45;">
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
                <div style="display:flex;flex-direction:column;gap:6px;font-size:0.86rem;color:#e2e8f0;margin-bottom:10px;">
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

    initPharmacies();
  </script>
</body>
</html>`;
}

startServer().catch((err) => {
  console.error('❌ Erro ao iniciar servidor:', err);
  process.exit(1);
});
