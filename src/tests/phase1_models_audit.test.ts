import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  TENANT_MODELS,
  GLOBAL_MODELS,
  SYSTEM_MODELS,
  applyTenantScope,
  createTenantPrisma,
} from '../platform/tenant_prisma';

describe('Fase 1 — Auditoria de Modelos Prisma e Cliente de Tenant', () => {
  it('1. Todos os modelos definidos no schema.prisma estão estritamente classificados (100% de cobertura)', () => {
    const allSchemaModels = Prisma.dmmf.datamodel.models.map((m) => m.name);
    expect(allSchemaModels.length).toBeGreaterThan(0);

    const unclassified: string[] = [];
    const duplicates: string[] = [];

    for (const modelName of allSchemaModels) {
      let count = 0;
      if (TENANT_MODELS.has(modelName)) count++;
      if (GLOBAL_MODELS.has(modelName)) count++;
      if (SYSTEM_MODELS.has(modelName)) count++;

      if (count === 0) {
        unclassified.push(modelName);
      } else if (count > 1) {
        duplicates.push(modelName);
      }
    }

    expect(unclassified, `Modelos esquecidos sem classificação: ${unclassified.join(', ')}`).toEqual([]);
    expect(duplicates, `Modelos classificados em mais de uma categoria: ${duplicates.join(', ')}`).toEqual([]);

    // Verificar se não há modelos obsoletos nos conjuntos
    const validModelSet = new Set(allSchemaModels);
    const staleInTenant = [...TENANT_MODELS].filter((m) => !validModelSet.has(m));
    const staleInGlobal = [...GLOBAL_MODELS].filter((m) => !validModelSet.has(m));
    const staleInSystem = [...SYSTEM_MODELS].filter((m) => !validModelSet.has(m));

    expect(staleInTenant, `Modelos inexistentes em TENANT_MODELS: ${staleInTenant.join(', ')}`).toEqual([]);
    expect(staleInGlobal, `Modelos inexistentes em GLOBAL_MODELS: ${staleInGlobal.join(', ')}`).toEqual([]);
    expect(staleInSystem, `Modelos inexistentes em SYSTEM_MODELS: ${staleInSystem.join(', ')}`).toEqual([]);
  });

  it('2. Modelos de sistema (ex: Utilizador, Sessao) são estritamente inacessíveis pelo cliente de tenant', () => {
    const allowed = ['farm-baptista-id'];

    for (const sysModel of SYSTEM_MODELS) {
      expect(() => {
        applyTenantScope(sysModel, 'findMany', {}, allowed);
      }).toThrow(/inacessível no cliente de tenant/i);

      expect(() => {
        applyTenantScope(sysModel, 'create', { data: {} }, allowed);
      }).toThrow(/inacessível no cliente de tenant/i);
    }
  });

  it('3. Modelos globais (ProdutoMestre) permitem apenas leitura e bloqueiam escrita no cliente de tenant', () => {
    const allowed = ['farm-baptista-id'];

    // Leituras permitidas sem mutação
    const readArgs = applyTenantScope('ProdutoMestre', 'findMany', { where: { ativo: true } }, allowed);
    expect(readArgs).toEqual({ where: { ativo: true } });

    // Escritas estritamente proibidas
    for (const writeOp of ['create', 'update', 'delete', 'upsert', 'createMany', 'updateMany', 'deleteMany']) {
      expect(() => {
        applyTenantScope('ProdutoMestre', writeOp, { data: {} }, allowed);
      }).toThrow(/Escrita no modelo global/i);
    }
  });

  it('4. Operações de leitura e contagem em modelos de tenant injetam farmaciaId incondicionalmente', () => {
    const allowed = ['farm-baptista-id'];

    // findMany sem where prévio
    const res1 = applyTenantScope('Inventario', 'findMany', {}, allowed);
    expect(res1.where).toEqual({ AND: [{}, { farmaciaId: 'farm-baptista-id' }] });

    // findMany com where existente (combina com AND)
    const res2 = applyTenantScope('Venda', 'findMany', { where: { codNacional: '1234567' } }, allowed);
    expect(res2.where.AND[0]).toEqual({ codNacional: '1234567' });
    expect(res2.where.AND[1]).toEqual({ farmaciaId: 'farm-baptista-id' });

    // count
    const res3 = applyTenantScope('TarefaEquipa', 'count', {}, allowed);
    expect(res3.where).toEqual({ AND: [{}, { farmaciaId: 'farm-baptista-id' }] });
  });

  it('5. create e createMany forçam o farmaciaId do contexto e impedem spoofing de outra farmácia', () => {
    const allowed = ['farm-baptista-id'];
    const spoofedFarmaciaId = 'farm-avenida-id-hacker';

    // create com farmaciaId malicioso nos dados
    const resCreate = applyTenantScope(
      'Inventario',
      'create',
      {
        data: {
          farmaciaId: spoofedFarmaciaId,
          codNacional: '9999999',
          stockTotal: 10,
        },
      },
      allowed
    );

    // O farmaciaId deve ser substituído pelo do contexto
    expect(resCreate.data.farmaciaId).toBe('farm-baptista-id');
    expect(resCreate.data.codNacional).toBe('9999999');

    // createMany
    const resCreateMany = applyTenantScope(
      'Inventario',
      'createMany',
      {
        data: [
          { farmaciaId: spoofedFarmaciaId, codNacional: '111' },
          { codNacional: '222' },
        ],
      },
      allowed
    );
    expect(resCreateMany.data[0].farmaciaId).toBe('farm-baptista-id');
    expect(resCreateMany.data[1].farmaciaId).toBe('farm-baptista-id');
  });

  it('6. update, delete e upsert por ID isolam por farmaciaId', () => {
    const allowed = ['farm-baptista-id'];

    // update
    const resUpdate = applyTenantScope(
      'Inventario',
      'update',
      {
        where: { id: 'inv-item-123' },
        data: { stockTotal: 50 },
      },
      allowed
    );
    expect(resUpdate.where).toEqual({ id: 'inv-item-123', farmaciaId: 'farm-baptista-id' });
    expect(resUpdate.data.stockTotal).toBe(50);

    // delete
    const resDelete = applyTenantScope(
      'Inventario',
      'delete',
      {
        where: { id: 'inv-item-123' },
      },
      allowed
    );
    expect(resDelete.where).toEqual({ id: 'inv-item-123', farmaciaId: 'farm-baptista-id' });
  });

  it('7. include e select relacional são rejeitados para evitar fuga ao filtro do modelo pai', () => {
    const allowed = ['farm-baptista-id'];

    expect(() => {
      applyTenantScope('Inventario', 'findMany', { include: { farmacia: true } }, allowed);
    }).toThrow(/include não é permitido/i);

    expect(() => {
      applyTenantScope(
        'Inventario',
        'findMany',
        { select: { id: true, farmacia: { select: { nome: true } } } },
        allowed
      );
    }).toThrow(/select relacional não é permitido/i);
  });

  it('8. Escritas aninhadas (nested writes) são rejeitadas no cliente de tenant', () => {
    const allowed = ['farm-baptista-id'];

    expect(() => {
      applyTenantScope(
        'Inventario',
        'create',
        {
          data: {
            codNacional: '123',
            farmacia: { connect: { id: 'outra-farmacia' } },
          },
        },
        allowed
      );
    }).toThrow(/Escritas aninhadas não são permitidas/i);
  });

  it('9. Métodos de baixo nível e transações são bloqueados no wrapper de tenant', () => {
    const dummyCtx: any = {
      tipo: 'UTILIZADOR',
      farmaciaIds: ['farm-baptista-id'],
      activeFarmaciaId: 'farm-baptista-id',
      permissoes: ['ver_stock_validades'],
    };

    const mockPrisma: any = {
      $extends: (_ext: any) => ({
        $queryRaw: () => 'raw',
        $executeRaw: () => 'exec',
        $transaction: () => 'tx',
      }),
    };

    const tenantPrisma = createTenantPrisma(mockPrisma, dummyCtx);

    expect(() => (tenantPrisma as any).$queryRaw`SELECT 1`).toThrow(/\$queryRaw.*não é permitido/i);
    expect(() => (tenantPrisma as any).$executeRaw`DELETE FROM Inventario`).toThrow(/\$executeRaw.*não é permitido/i);
    expect(() => (tenantPrisma as any).$transaction([])).toThrow(/\$transaction.*não é permitido/i);
  });
});
