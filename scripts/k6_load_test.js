/**
 * ============================================================================
 * BI_PHARMA — Suite de Testes de Carga com k6
 * Simulação de Escala Enterprise: 100 Farmácias Concorrentes
 * ============================================================================
 * 
 * Como executar (com k6 instalado):
 *   k6 run scripts/k6_load_test.js
 * 
 * Variáveis de Ambiente suportadas:
 *   BASE_URL: URL base do servidor (padrão: http://localhost:3000)
 *   FARMACIA_ID: ID da farmácia de teste
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Métricas Customizadas para Validação de SLOs Arquiteturais
const errorRate = new Rate('error_rate');
const modalDuration = new Trend('duration_modal_ms');
const dashboardDuration = new Trend('duration_dashboard_ms');
const ingestDuration = new Trend('duration_ingest_enqueue_ms');

export const options = {
  scenarios: {
    // Cenário A: 100 utilizadores em simultâneo a navegar em catálogos e a abrir modais
    navegacao_catalogo_e_modais: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 50 },  // Ramp-up até 50 utilizadores
        { duration: '1m', target: 100 },  // Pico de 100 utilizadores em simultâneo
        { duration: '30s', target: 0 },   // Ramp-down
      ],
      gracefulRampDown: '10s',
      exec: 'cenarioNavegacao',
    },

    // Cenário B: Carga mista com Ingestão e Copilot
    carga_mista_ingest_copilot: {
      executor: 'constant-vus',
      vus: 10,
      duration: '1m',
      startTime: '30s',
      exec: 'cenarioMisto',
    },
  },

  // SLOs Contratuais Rigorosos (Arquitetura Alvo)
  thresholds: {
    'error_rate': ['rate<0.01'], // Taxa de erro < 1%
    'duration_dashboard_ms': ['p(95)<150'], // Dashboard p95 < 150ms
    'duration_modal_ms': ['p(95)<50'],      // Modal de produto p95 < 50ms
    'duration_ingest_enqueue_ms': ['p(95)<100'], // Enqueue de ingestão p95 < 100ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const FARMACIA_ID = __ENV.FARMACIA_ID || '3ac42c32-87a8-4afe-98cc-4ca61ac64aca';

// Lista de CNPs para simulação de cliques em modais
const CNP_LIST = [
  '7588137', '2584282', '5821707', '7941781', '7234918',
  '9012345', '7021345', '6045123', '5034123', '4023123'
];

export function cenarioNavegacao() {
  const params = {
    headers: { 'Accept': 'application/json' },
  };

  group('1. Carregar Dashboard Geral (Leitura de Marts)', function () {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/analysis?farmaciaId=${FARMACIA_ID}`, params);
    const duration = Date.now() - start;

    dashboardDuration.add(duration);
    const ok = check(res, {
      'status 200': (r) => r.status === 200,
      'dados retornados': (r) => r.body && r.body.length > 500,
    });
    errorRate.add(!ok);
  });

  sleep(Math.random() * 2 + 1);

  group('2. Abertura Rápida de Modal de Produto', function () {
    const randomCnp = CNP_LIST[Math.floor(Math.random() * CNP_LIST.length)];
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/product/${randomCnp}?farmaciaId=${FARMACIA_ID}`, params);
    const duration = Date.now() - start;

    modalDuration.add(duration);
    const ok = check(res, {
      'status 200': (r) => r.status === 200,
      'detalhe do produto valido': (r) => r.json('cnp') !== undefined || r.json('produto') !== undefined,
    });
    errorRate.add(!ok);
  });

  sleep(Math.random() * 1.5 + 0.5);
}

export function cenarioMisto() {
  const headers = { 'Content-Type': 'application/json' };

  group('1. Submissão Assíncrona de Ingestão (Worker-ETL)', function () {
    const payload = JSON.stringify({
      farmaciaId: FARMACIA_ID,
      fromAvenida: false,
      files: [
        {
          name: 'Vendas_Stress_k6.csv',
          base64: 'Q05QO0Rlc2lnbmFjYW87RGF0YTtRdWFudGlkYWRlO1ZhbG9yVmVuZGEKOTk5OTk5OTtURVNURTsyMDI2LTAzLTAxOzE7MTAuMDAK',
        },
      ],
      decisions: {},
    });

    const start = Date.now();
    const res = http.post(`${BASE_URL}/api/admin/execute-import`, payload, { headers });
    const duration = Date.now() - start;

    ingestDuration.add(duration);
    const ok = check(res, {
      'status 202 Accepted': (r) => r.status === 202,
      'job queued': (r) => r.json('queued') === true,
    });
    errorRate.add(!ok);
  });

  sleep(5);
}
