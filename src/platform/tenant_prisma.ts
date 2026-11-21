import type { PrismaClient } from '@prisma/client';
import type { RequestAuthContext } from '../services/auth_service';

// ============================================================================
// CLASSIFICAÇÃO OBRIGATÓRIA DE TODOS OS MODELOS PRISMA (Revisão Fase 1)
// Um modelo novo não classificado faz o teste de CI falhar.
//   TENANT: dados por farmácia; o cliente de tenant injeta farmaciaId em todas as operações
//   GLOBAL: dados de referência partilhados (leitura sem filtro)
//   SYSTEM: identidade/segurança/infra; NUNCA acessíveis pelo cliente de tenant (só por serviços de auth)
// ============================================================================

export const TENANT_MODELS = new Set<string>([
  'Inventario', 'Venda', 'StagingInventario', 'StagingVendas', 'StagingValidades',
  'InventarioSnapshot', 'PrecoFarmacia', 'TarefaEquipa', 'CampanhaAtiva', 'CopilotUsageLog',
  'McpConnector', 'McpAuditLog', 'MartTenantKpis', 'MartProdutoMetricas', 'MartProdutoMes',
  'MartDciGrupo', 'MembroEquipa', 'MembroFarmacia', 'DispositivoBalcao', 'CodigoEmparelhamento',
]);

export const GLOBAL_MODELS = new Set<string>([
  'ProdutoMestre',
  'EnriquecimentoFila',
  'ProdutoEnriquecimento',
  'EnriquecimentoFonte',
  'CitsCarga',
  'CitsRaw',
  'ProdutoCits',
  'ProdutoCitsHistorico',
  'DocumentoMedicamento',
  'DocumentoCnp',
  'DocumentoSeccao',
]);

export const SYSTEM_MODELS = new Set<string>([
  'Organizacao', 'Farmacia', 'Utilizador', 'SessaoUtilizador', 'TokenRecuperacao', 'SessaoAdmin',
  'LimiteTaxa', 'Sessao', 'DispositivoConfiado', 'TokenSeguranca', 'AuditoriaSeguranca', 'ConsentimentoSuporte',
  'CredencialPasskey', 'DesafioWebAuthn',
]);

const BLOCKED_CLIENT_MEMBERS = new Set<string>([
  '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe', '$transaction', '$extends', '$on', '$use',
]);

const NESTED_WRITE_KEYS = new Set<string>([
  'connect', 'connectOrCreate', 'create', 'createMany', 'update', 'updateMany', 'upsert',
  'delete', 'deleteMany', 'disconnect', 'set',
]);

function tenantError(message: string, statusCode = 403): Error {
  return Object.assign(new Error(message), { statusCode });
}

function assertNoRelationAccess(args: any): void {
  if (!args) return;
  if (args.include) throw tenantError('include não é permitido no cliente de tenant (escapa ao filtro de farmácia).');
  if (args.select && typeof args.select === 'object') {
    for (const v of Object.values(args.select)) {
      if (v && typeof v === 'object') throw tenantError('select relacional não é permitido no cliente de tenant.');
    }
  }
}

function assertNoNestedWrites(data: any): void {
  if (!data || typeof data !== 'object') return;
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !('toFixed' in (v as any))) {
      for (const k of Object.keys(v as any)) {
        if (NESTED_WRITE_KEYS.has(k)) throw tenantError('Escritas aninhadas não são permitidas no cliente de tenant.');
      }
    }
  }
}

function stripFarmaciaId(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const { farmaciaId: _f, farmacia: _rel, ...rest } = data;
  return rest;
}

/**
 * Função pura (testável sem BD): aplica o âmbito de tenant aos argumentos de uma operação Prisma.
 */
export function applyTenantScope(model: string, operation: string, args: any, allowedIds: string[]): any {
  if (SYSTEM_MODELS.has(model)) {
    throw tenantError(`Modelo de sistema (${model}) inacessível no cliente de tenant.`);
  }
  if (GLOBAL_MODELS.has(model)) {
    if (!['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy'].includes(operation)) {
      throw tenantError(`Escrita no modelo global (${model}) não permitida no cliente de tenant.`);
    }
    return args;
  }
  if (!TENANT_MODELS.has(model)) {
    throw tenantError(`Modelo não classificado (${model}). Classifique-o como TENANT, GLOBAL ou SYSTEM.`);
  }
  if (!allowedIds.length) throw tenantError('Contexto sem farmácia autorizada.');

  const tenantFilter: any = allowedIds.length === 1 ? allowedIds[0] : { in: allowedIds };
  const a: any = args ? { ...args } : {};
  const isWrite = !['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy'].includes(operation);

  assertNoRelationAccess(a);
  if (isWrite && allowedIds.length !== 1) throw tenantError('Escrita não permitida em modo de grupo.');

  switch (operation) {
    case 'findMany':
    case 'findFirst':
    case 'findFirstOrThrow':
    case 'count':
    case 'aggregate':
    case 'groupBy':
    case 'updateMany':
    case 'updateManyAndReturn':
    case 'deleteMany':
      a.where = { AND: [a.where || {}, { farmaciaId: tenantFilter }] };
      if (a.data) {
        assertNoNestedWrites(a.data);
        a.data = stripFarmaciaId(a.data);
      }
      return a;

    case 'findUnique':
    case 'findUniqueOrThrow':
    case 'delete':
      a.where = { ...(a.where || {}), farmaciaId: tenantFilter };
      return a;

    case 'update':
      assertNoNestedWrites(a.data);
      a.where = { ...(a.where || {}), farmaciaId: allowedIds[0] };
      a.data = stripFarmaciaId(a.data);
      return a;

    case 'create':
      assertNoNestedWrites(a.data);
      a.data = { ...stripFarmaciaId(a.data), farmaciaId: allowedIds[0] };
      return a;

    case 'createMany':
    case 'createManyAndReturn': {
      const rows = Array.isArray(a.data) ? a.data : [a.data];
      a.data = rows.map((r: any) => ({ ...stripFarmaciaId(r), farmaciaId: allowedIds[0] }));
      return a;
    }

    case 'upsert':
      assertNoNestedWrites(a.create);
      assertNoNestedWrites(a.update);
      a.where = { ...(a.where || {}), farmaciaId: allowedIds[0] };
      a.create = { ...stripFarmaciaId(a.create), farmaciaId: allowedIds[0] };
      a.update = stripFarmaciaId(a.update);
      return a;

    default:
      throw tenantError(`Operação não suportada no cliente de tenant: ${operation}.`);
  }
}

/**
 * Cliente Prisma isolado ao contexto de tenant do pedido (Spec v2.1 Secção 8).
 * - Aplica applyTenantScope a TODAS as operações de modelo
 * - Bloqueia $queryRaw/$executeRaw/$transaction/$extends no cliente devolvido
 */
export function createTenantPrisma(prisma: PrismaClient, ctx: RequestAuthContext) {
  if (!ctx.farmaciaIds || ctx.farmaciaIds.length === 0) {
    throw tenantError('Contexto sem farmácia autorizada. Superadmin necessita de consentimento explícito.');
  }
  const allowedIds = [...ctx.farmaciaIds];

  const extended = prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return query(applyTenantScope(model as string, operation, args, allowedIds));
        },
      },
    },
  });

  return new Proxy(extended, {
    get(target: any, prop: string | symbol, receiver: any) {
      if (typeof prop === 'string' && BLOCKED_CLIENT_MEMBERS.has(prop)) {
        return () => {
          throw tenantError(`${prop} não é permitido no cliente de tenant. Use o auxiliar SQL com ctx.`);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof extended;
}
