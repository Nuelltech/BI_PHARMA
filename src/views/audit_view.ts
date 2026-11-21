/**
 * Interface Web do Visualizador de Auditoria de Segurança (Fase 4 / Spec v2.1)
 *
 * Apenas acessível a utilizadores com permissão 'ver_auditoria' (Proprietário ou Superadmin).
 * Mostra histórico imutável de logins, falhas, emparelhamentos, consentimentos e importações.
 */

export interface AuditLogEntry {
  id: string;
  evento: string;
  utilizadorNome?: string | null;
  membroNome?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  ts: Date;
  detalhes?: any;
}

export function getAuditViewHtml(options: {
  farmaciaNome: string;
  logs: AuditLogEntry[];
}): string {
  const { farmaciaNome, logs } = options;

  function formatDetails(d: any): string {
    if (!d || typeof d !== 'object') return '—';
    const entries = Object.entries(d)
      .filter(([k]) => !['password', 'pin', 'token'].includes(k))
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return entries.slice(0, 3).join(', ');
  }

  function getBadgeClass(evento: string): string {
    if (evento.includes('FAIL') || evento.includes('LOCKED') || evento.includes('NEGADO')) {
      return 'badge-danger';
    }
    if (evento.includes('OK') || evento.includes('VERIFIED') || evento.includes('PAIRED')) {
      return 'badge-success';
    }
    if (evento.includes('REVOKED') || evento.includes('RESET')) {
      return 'badge-warning';
    }
    return 'badge-info';
  }

  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registo de Auditoria • ${farmaciaNome} • BI Pharma</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #0ea5e9;
      --danger: #ef4444;
      --success: #10b981;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body {
      background: var(--bg);
      color: var(--text);
      padding: 32px 24px;
      min-height: 100vh;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .title h1 {
      font-size: 22px;
      font-weight: 700;
    }
    .title p {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .nav-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
    }
    .nav-link:hover { text-decoration: underline; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th {
      background: #172554;
      color: #93c5fd;
      padding: 12px 16px;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: middle;
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      font-family: monospace;
    }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .badge-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .badge-info { background: rgba(14, 165, 233, 0.15); color: #38bdf8; }
    .meta-time {
      color: var(--text-muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .details-text {
      font-family: monospace;
      font-size: 11px;
      color: var(--text-muted);
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty-state {
      text-align: center;
      padding: 48px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">
        <h1>Auditoria de Segurança</h1>
        <p>${farmaciaNome} • Registo imutável de eventos e conformidade</p>
      </div>
      <div>
        <a href="/" class="nav-link">← Voltar ao Início</a>
      </div>
    </div>

    <div class="card">
      ${logs.length === 0 ? `
        <div class="empty-state">
          Nenhum evento de segurança registado recentemente.
        </div>
      ` : `
        <table>
          <thead>
            <tr>
              <th>Data / Hora</th>
              <th>Evento</th>
              <th>Utilizador / Membro</th>
              <th>Endereço IP</th>
              <th>Detalhes</th>
            </tr>
          </thead>
          <tbody>
            ${logs.map((log) => `
              <tr>
                <td class="meta-time">${new Date(log.ts).toLocaleString('pt-PT')}</td>
                <td><span class="badge ${getBadgeClass(log.evento)}">${log.evento}</span></td>
                <td>${log.utilizadorNome || log.membroNome || 'Sistema / Balcão'}</td>
                <td><code>${log.ip || '—'}</code></td>
                <td class="details-text" title="${formatDetails(log.detalhes)}">${formatDetails(log.detalhes)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  </div>
</body>
</html>`;
}
