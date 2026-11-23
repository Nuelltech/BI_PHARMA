export function getMobileStaffHtml(): string {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <meta name="theme-color" content="#0f172a" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
  <link rel="apple-touch-icon" href="/icons/icon.svg" />
  <meta name="apple-mobile-web-app-title" content="BI Pharma" />
  <meta name="application-name" content="BI Pharma" />
  <title>BI Pharma — Modo Equipa (Mobile)</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #0b1120;
      color: #f1f5f9;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      touch-action: pan-y;
    }

    /* ========================================================================
       TELA DE AUTENTICAÇÃO POR PIN
       ======================================================================== */
    #pinOverlay {
      position: fixed;
      inset: 0;
      background: radial-gradient(circle at top, #1e293b, #0b1120 70%);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .pin-card {
      width: 100%;
      max-width: 360px;
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(12px);
      border-radius: 20px;
      padding: 26px 20px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }

    .pin-card h2 {
      font-size: 1.35rem;
      font-weight: 800;
      color: #38bdf8;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .pin-card p {
      font-size: 0.82rem;
      color: #94a3b8;
      margin-bottom: 20px;
    }

    .form-group {
      margin-bottom: 14px;
      text-align: left;
    }

    .form-group label {
      display: block;
      font-size: 0.76rem;
      font-weight: 700;
      color: #cbd5e1;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    .select-farmacia, .input-operator {
      width: 100%;
      padding: 12px 14px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      color: #f8fafc;
      font-size: 0.95rem;
      font-weight: 600;
      outline: none;
      transition: border-color 0.2s;
    }

    .select-farmacia:focus, .input-operator:focus {
      border-color: #38bdf8;
    }

    .operator-chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }

    .operator-chip {
      background: #1e293b;
      border: 1px solid #475569;
      color: #93c5fd;
      border-radius: 14px;
      padding: 4px 10px;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .operator-chip:active, .operator-chip.active {
      background: #38bdf8 !important;
      color: #0f172a !important;
      border-color: #38bdf8 !important;
      font-weight: 700;
    }

    .pin-dots {
      display: flex;
      justify-content: center;
      gap: 14px;
      margin: 18px 0 16px 0;
    }

    .pin-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid #475569;
      background: transparent;
      transition: all 0.2s;
    }

    .pin-dot.filled {
      background: #38bdf8;
      border-color: #38bdf8;
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.6);
      transform: scale(1.15);
    }

    .keypad {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 10px;
    }

    .keypad-btn {
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      font-size: 1.35rem;
      font-weight: 700;
      height: 56px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      transition: background 0.15s, transform 0.1s;
    }

    .keypad-btn:active {
      background: #1e293b;
      transform: scale(0.95);
      border-color: #38bdf8;
    }

    .keypad-btn.action {
      font-size: 0.95rem;
      font-weight: 600;
      color: #94a3b8;
    }

    .pin-hint {
      font-size: 0.72rem;
      color: #64748b;
      margin-top: 14px;
    }

    /* ========================================================================
       LAYOUT PRINCIPAL DO APLICATIVO MOBILE
       ======================================================================== */
    #appContainer {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Header Fixo */
    header {
      background: #0f172a;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 10px 16px 8px 16px;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }

    .brand-title {
      font-size: 0.95rem;
      font-weight: 800;
      color: #38bdf8;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .brand-title span {
      color: #94a3b8;
      font-weight: 600;
      font-size: 0.8rem;
    }

    .header-user-badge {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .live-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    .user-pill {
      background: #1e293b;
      border: 1px solid #334155;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 700;
      color: #cbd5e1;
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }

    .logout-btn {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(244, 63, 94, 0.4);
      color: #fda4af;
      padding: 4px 10px;
      border-radius: 16px;
      font-size: 0.74rem;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      outline: none;
    }

    .logout-btn:active {
      background: rgba(239, 68, 68, 0.35);
      transform: scale(0.95);
    }

    /* Barra de Progresso Semanal */
    .progress-bar-container {
      margin-top: 4px;
    }

    .progress-info {
      display: flex;
      justify-content: space-between;
      font-size: 0.74rem;
      font-weight: 700;
      color: #94a3b8;
      margin-bottom: 4px;
    }

    .progress-track {
      width: 100%;
      height: 6px;
      background: #1e293b;
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #10b981, #06b6d4);
      width: 0%;
      transition: width 0.3s ease;
    }

    /* Barra de Tabs (4 Secções) */
    .tabs-bar {
      display: flex;
      background: #0f172a;
      border-bottom: 2px solid #1e293b;
      position: relative;
      flex-shrink: 0;
    }

    .tab-btn {
      flex: 1;
      padding: 10px 4px;
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 0.74rem;
      font-weight: 800;
      text-align: center;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      position: relative;
      transition: color 0.2s;
    }

    .tab-btn.active {
      color: #f8fafc;
    }

    .tab-btn .badge-pill {
      font-size: 0.66rem;
      padding: 1px 5px;
      border-radius: 10px;
      background: #1e293b;
      color: #cbd5e1;
      font-weight: 700;
    }

    .tab-btn.tab-1.active .badge-pill {
      background: rgba(244, 63, 94, 0.2);
      color: #fb7185;
    }
    .tab-btn.tab-2.active .badge-pill {
      background: rgba(168, 85, 247, 0.2);
      color: #c084fc;
    }
    .tab-btn.tab-3.active .badge-pill {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }
    .tab-btn.tab-4.active .badge-pill {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }

    .tab-indicator {
      position: absolute;
      bottom: -2px;
      left: 0;
      height: 2px;
      width: 25%;
      background: #fb7185;
      transition: transform 0.25s cubic-bezier(0.25, 1, 0.5, 1), background-color 0.2s;
    }

    /* Swipeable Viewport (4 Secções = 400vw) */
    .viewport {
      flex: 1;
      display: flex;
      width: 400vw;
      transform: translateX(0%);
      transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1);
      overflow-y: hidden;
      touch-action: pan-y;
    }

    .section-page {
      width: 100vw;
      height: 100%;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      padding: 10px 14px 40px 14px;
      -webkit-overflow-scrolling: touch;
      user-select: text;
    }

    /* Barra de Pesquisa e Filtros */
    .search-filter-bar {
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .search-input-wrapper {
      position: relative;
    }

    .search-input {
      width: 100%;
      padding: 9px 14px 9px 34px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      color: #f8fafc;
      font-size: 0.84rem;
      outline: none;
    }

    .search-input:focus {
      border-color: #38bdf8;
    }

    .search-icon {
      position: absolute;
      left: 11px;
      top: 50%;
      transform: translateY(-50%);
      color: #64748b;
      font-size: 0.82rem;
    }

    .filter-chips {
      display: flex;
      gap: 5px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
    }
    .filter-chips::-webkit-scrollbar {
      display: none;
    }

    .filter-chip {
      background: #0f172a;
      border: 1px solid #334155;
      color: #94a3b8;
      padding: 4px 9px;
      border-radius: 12px;
      font-size: 0.72rem;
      font-weight: 700;
      white-space: nowrap;
      cursor: pointer;
    }

    .filter-chip.active {
      background: #38bdf8;
      color: #0f172a;
      border-color: #38bdf8;
    }

    /* Controles Avançados da Secção 1 (Validades) */
    .validades-toolbar {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 10px 10px;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
    }

    .toolbar-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
    }

    .toolbar-row-bottom {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
    }

    .toolbar-select {
      width: 100%;
      min-width: 0;
      height: 38px;
      padding: 0 24px 0 8px;
      background: #1e293b;
      border: 1px solid #475569;
      border-radius: 8px;
      color: #f8fafc;
      font-size: 0.76rem;
      font-weight: 600;
      outline: none;
      box-sizing: border-box;
      cursor: pointer;
      -webkit-appearance: none;
      -moz-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M7.247 11.14L2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: calc(100% - 8px) center;
      background-size: 10px;
    }

    .toolbar-select:focus {
      border-color: #38bdf8;
    }

    .filter-counter-badge {
      font-size: 0.74rem;
      color: #94a3b8;
      font-weight: 700;
      padding: 4px 6px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* Sub-tabs do Balcão */
    .balcao-subtabs {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }

    .subtab-btn {
      flex: 1;
      background: #1e293b;
      border: 1px solid #334155;
      color: #94a3b8;
      padding: 7px 8px;
      border-radius: 8px;
      font-size: 0.74rem;
      font-weight: 700;
      text-align: center;
      cursor: pointer;
    }

    .subtab-btn.active {
      background: rgba(168, 85, 247, 0.2);
      border-color: #a855f7;
      color: #f3e8ff;
    }
    .subtab-btn.active.winter {
      background: rgba(56, 189, 248, 0.2);
      border-color: #38bdf8;
      color: #e0f2fe;
    }

    /* Cartões de Tarefa em Formato Lista */
    .task-list {
      display: flex;
      flex-direction: column;
      gap: 9px;
    }

    .task-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 13px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
      transition: all 0.2s ease;
      position: relative;
    }

    .task-card.completed {
      background: rgba(16, 185, 129, 0.08);
      border-color: rgba(16, 185, 129, 0.4);
    }

    .task-card.completed .task-title {
      text-decoration: line-through;
      color: #94a3b8;
    }

    /* Botão de Picar Grande para Dedos */
    .task-check-btn {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      border: 2px solid #475569;
      background: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.3rem;
      color: transparent;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }

    .task-card.completed .task-check-btn {
      background: #10b981;
      border-color: #10b981;
      color: #ffffff;
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
    }

    .task-body {
      flex: 1;
      min-width: 0;
    }

    .task-title {
      font-size: 0.90rem;
      font-weight: 700;
      color: #f8fafc;
      line-height: 1.3;
      margin-bottom: 4px;
      word-break: break-word;
    }

    .task-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 5px;
    }

    .tag {
      font-size: 0.69rem;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }

    .tag-danger {
      background: rgba(244, 63, 94, 0.18);
      color: #fda4af;
      border: 1px solid rgba(244, 63, 94, 0.3);
    }

    .tag-purple {
      background: rgba(168, 85, 247, 0.18);
      color: #d8b4fe;
      border: 1px solid rgba(168, 85, 247, 0.3);
    }

    .tag-warning {
      background: rgba(245, 158, 11, 0.18);
      color: #fde68a;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .tag-success {
      background: rgba(16, 185, 129, 0.18);
      color: #6ee7b7;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .tag-cnp {
      background: #0f172a;
      color: #38bdf8;
      border: 1px solid #334155;
      font-family: monospace;
      font-size: 0.70rem;
    }

    .tag-shelf {
      background: #042f2e;
      color: #2dd4bf;
      border: 1px solid #0d9488;
      font-size: 0.68rem;
    }

    .task-instruction {
      font-size: 0.77rem;
      color: #cbd5e1;
      line-height: 1.35;
      margin-top: 5px;
    }

    .task-instruction b {
      color: #ffffff;
    }

    .task-completion-stamp {
      font-size: 0.72rem;
      font-weight: 700;
      color: #34d399;
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Sub-lista de genéricos (marcas a esgotar) */
    .restos-box {
      margin-top: 7px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 6px 10px;
    }

    .resto-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.74rem;
      padding: 3px 0;
      border-bottom: 1px dashed #1e293b;
    }

    .resto-row:last-child {
      border-bottom: none;
    }

    .resto-name {
      color: #e2e8f0;
      font-weight: 600;
    }

    .resto-qtd {
      color: #c084fc;
      font-weight: 800;
    }

    /* Rodapé com Dica de Deslizar */
    .swipe-hint {
      text-align: center;
      font-size: 0.72rem;
      color: #64748b;
      margin-top: 18px;
      padding-bottom: 20px;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: #64748b;
    }

    .empty-icon {
      font-size: 2.2rem;
      margin-bottom: 10px;
    }

    /* Toast Notification */
    #toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #0284c7;
      color: #ffffff;
      padding: 10px 18px;
      border-radius: 24px;
      font-size: 0.82rem;
      font-weight: 700;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      z-index: 99999;
      transition: transform 0.25s cubic-bezier(0.25, 1, 0.5, 1);
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: none;
    }

    #toast.show {
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>

  <!-- ========================================================================
       Ecrã de Autenticação Rápida por PIN
       ======================================================================== -->
  <div id="pinOverlay">
    <div class="pin-card">
      <h2>🔒 BI Pharma Staff</h2>
      <p>Área de Operações da Equipa da Farmácia</p>

      <div class="form-group">
        <label>Farmácia Ativa</label>
        <select id="pinFarmSelect" class="select-farmacia" onchange="loadPharmacyTeamChips(this.value)">
          <option value="">A carregar farmácias...</option>
        </select>
      </div>

      <div class="form-group">
        <label>O Teu Nome / Operador</label>
        <input type="text" id="pinOperatorInput" class="input-operator" placeholder="Ex: Nome do colaborador" />
        <div class="operator-chips" id="operatorChipsContainer">
          <span style="font-size: 0.72rem; color: #94a3b8;">A carregar equipa...</span>
        </div>
      </div>

      <div class="form-group" style="text-align: center; margin-top: 14px;">
        <label>PIN de Acesso (4 dígitos)</label>
        <div class="pin-dots">
          <div class="pin-dot" id="dot1"></div>
          <div class="pin-dot" id="dot2"></div>
          <div class="pin-dot" id="dot3"></div>
          <div class="pin-dot" id="dot4"></div>
        </div>
      </div>

      <div class="keypad">
        <button class="keypad-btn" onclick="pressPin('1')">1</button>
        <button class="keypad-btn" onclick="pressPin('2')">2</button>
        <button class="keypad-btn" onclick="pressPin('3')">3</button>
        <button class="keypad-btn" onclick="pressPin('4')">4</button>
        <button class="keypad-btn" onclick="pressPin('5')">5</button>
        <button class="keypad-btn" onclick="pressPin('6')">6</button>
        <button class="keypad-btn" onclick="pressPin('7')">7</button>
        <button class="keypad-btn" onclick="pressPin('8')">8</button>
        <button class="keypad-btn" onclick="pressPin('9')">9</button>
        <button class="keypad-btn action" onclick="clearPin()">Limpar</button>
        <button class="keypad-btn" onclick="pressPin('0')">0</button>
        <button class="keypad-btn action" onclick="submitPin()" style="color: #38bdf8;">OK ➔</button>
      </div>

      <div class="pin-hint">💡 PIN padrão: <b>1234</b> ou os 4 dígitos do código da farmácia</div>
    </div>
  </div>

  <!-- ========================================================================
       Ecrã Principal Mobile com Slide Horizontal (4 Secções)
       ======================================================================== -->
  <div id="appContainer">
    <!-- Header Fixo -->
    <header>
      <div class="header-top">
        <div class="brand-title">
          💊 BI Pharma <span id="hdrFarmName">—</span>
        </div>
        <div class="header-user-badge">
          <span class="live-dot" title="Sincronização em direto ativa"></span>
          <div class="user-pill" onclick="changeOperator()" id="hdrOperatorPill" title="Mudar operador">
            👤 <span id="hdrOperatorName">Operador</span>
          </div>
          <button type="button" class="logout-btn" onclick="logoutMobile()" title="Terminar sessão / Mudar de farmácia">
            🚪 Sair
          </button>
        </div>
      </div>

      <!-- Barra de Progresso Semanal -->
      <div class="progress-bar-container">
        <div class="progress-info">
          <span id="hdrProgressCount">0 de 0 concluídas</span>
          <span id="hdrProgressSavings" style="color: #34d399;">0 € poupados</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" id="hdrProgressFill"></div>
        </div>
      </div>
    </header>

        <!-- Banner de Instalação PWA -->
    <div id="pwaInstallBanner" style="display:none; background: linear-gradient(135deg, #0284c7, #0369a1); padding: 10px 14px; border-radius: 12px; margin: 10px 14px 4px 14px; box-shadow: 0 4px 12px rgba(2,132,199,0.3); align-items: center; justify-content: space-between; gap: 8px;">
      <div style="font-size: 0.82rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 6px;">
        <span>📲</span> <span>Adicionar BI Pharma ao ecrã inicial</span>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <button id="pwaInstallBtn" type="button" style="background: #fff; color: #0369a1; border: none; padding: 5px 12px; border-radius: 8px; font-weight: 800; font-size: 0.78rem; cursor: pointer;">
          Instalar
        </button>
        <button onclick="document.getElementById('pwaInstallBanner').style.display='none'" type="button" style="background: transparent; border: none; color: #bae6fd; font-size: 0.9rem; cursor: pointer; padding: 2px 4px;">✕</button>
      </div>
    </div>

    <!-- Barra de Separadores / Tabs (4 Secções) -->
    <div class="tabs-bar">
      <button class="tab-btn tab-1 active" onclick="goToSection(0)">
        <span>🔴 Validades</span>
        <span class="badge-pill" id="tabCount1">0</span>
      </button>
      <button class="tab-btn tab-2" onclick="goToSection(1)">
        <span>🟣 Balcão</span>
        <span class="badge-pill" id="tabCount2">0</span>
      </button>
      <button class="tab-btn tab-3" onclick="goToSection(2)">
        <span>🟡 Encomendas</span>
        <span class="badge-pill" id="tabCount3">0</span>
      </button>
      <button class="tab-btn tab-4" onclick="goToSection(3)">
        <span>🟢 Ruturas</span>
        <span class="badge-pill" id="tabCount4">0</span>
      </button>
      <div class="tab-indicator" id="tabIndicator"></div>
    </div>

    <!-- Viewport Deslizante (Slide / Swipe em 4 Secções) -->
    <div class="viewport" id="viewport">
      
      <!-- ====================================================================
           SECÇÃO 1: VALIDADES PRÓXIMAS (GAVETA & PRATELEIRA COM FILTROS)
           ==================================================================== -->
      <div class="section-page" id="page0">
        <!-- Toolbar com Filtros de Categoria, Horizonte de Validade e Ordenação -->
        <div class="validades-toolbar">
          <div class="toolbar-grid">
            <select id="cadMacroFilter" class="toolbar-select" onchange="renderSection1()">
              <option value="all">📂 Todas as Áreas</option>
              <option value="MSRM">💊 Receita (MSRM)</option>
              <option value="MNSRM_OTC">🌿 Venda Livre (OTC)</option>
              <option value="DERMOCOSMETICA">🧴 Dermocosmética</option>
              <option value="NUTRICAO_SUPLEMENTOS">🍎 Suplementos</option>
              <option value="DISPOSITIVOS_SAUDE">🩺 Dispositivos</option>
            </select>
            <select id="cadHorizonFilter" class="toolbar-select" onchange="renderSection1()">
              <option value="all">📅 Todos os Prazos</option>
              <option value="urgent">🚨 Urgente (≤ 3M)</option>
              <option value="mid">⚠️ 3 a 6 Meses</option>
              <option value="year">🗓️ 6 a 12 Meses</option>
            </select>
          </div>
          <div class="toolbar-row-bottom">
            <select id="cadSortOrder" class="toolbar-select" onchange="renderSection1()">
              <option value="date_asc">⏱️ Validade Mais Próxima</option>
              <option value="name_asc">🔤 Alfabética (A ➔ Z)</option>
              <option value="shelf_asc">📍 Prateleira / Gaveta</option>
              <option value="val_desc">💶 Maior Valor em Risco (€)</option>
            </select>
            <div class="filter-counter-badge" id="cadCounterBadge">0 produtos</div>
          </div>
        </div>

        <div class="search-filter-bar">
          <div class="search-input-wrapper">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="search0" placeholder="Pesquisar produto, lote ou CNP..." oninput="filterSection(0)" />
          </div>
          <div class="filter-chips">
            <span class="filter-chip active" id="f0_all" onclick="setStatusFilter(0, 'all')">Todos</span>
            <span class="filter-chip" id="f0_pending" onclick="setStatusFilter(0, 'pending')">Pendentes</span>
            <span class="filter-chip" id="f0_done" onclick="setStatusFilter(0, 'done')">Concluídos</span>
          </div>
        </div>
        <div class="task-list" id="list0">
          <div class="empty-state">
            <div class="empty-icon">⏳</div>
            <p>A carregar validades da farmácia...</p>
          </div>
        </div>
        <div class="swipe-hint">👉 Deslize para a esquerda para "2. Balcão"</div>
      </div>

      <!-- ====================================================================
           SECÇÃO 2: BALCÃO (A-Z ALFABÉTICO + DESTAQUES DE INVERNO)
           ==================================================================== -->
      <div class="section-page" id="page1">
        <!-- Sub-tabs do Balcão: Restos de Gaveta A-Z vs Destaques de Inverno -->
        <div class="balcao-subtabs">
          <button class="subtab-btn active" id="btnSubtabRestos" onclick="setBalcaoSubtab('restos')">
            📦 Restos de Gaveta A-Z
          </button>
          <button class="subtab-btn winter" id="btnSubtabWinter" onclick="setBalcaoSubtab('winter')">
            ❄️ Destaques Inverno (Pico)
          </button>
          <button class="subtab-btn" id="btnSubtabAll" onclick="setBalcaoSubtab('all')">
            🌟 Todos
          </button>
        </div>

        <div class="search-filter-bar">
          <div class="search-input-wrapper">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="search1" placeholder="Pesquisar molécula DCI ou produto..." oninput="filterSection(1)" />
          </div>
          <div class="filter-chips">
            <span class="filter-chip active" id="f1_all" onclick="setStatusFilter(1, 'all')">Todos</span>
            <span class="filter-chip" id="f1_pending" onclick="setStatusFilter(1, 'pending')">Pendentes</span>
            <span class="filter-chip" id="f1_done" onclick="setStatusFilter(1, 'done')">Concluídos</span>
          </div>
        </div>
        <div class="task-list" id="list1">
          <div class="empty-state">
            <div class="empty-icon">⏳</div>
            <p>A carregar sugestões de balcão...</p>
          </div>
        </div>
        <div class="swipe-hint">👈 Deslize para a direita ou esquerda 👉</div>
      </div>

      <!-- ====================================================================
           SECÇÃO 3: TRAVAR ENCOMENDAS (O QUE NÃO ENCOMENDAR)
           ==================================================================== -->
      <div class="section-page" id="page2">
        <div class="search-filter-bar">
          <div class="search-input-wrapper">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="search2" placeholder="Pesquisar artigo ou CNP a travar..." oninput="filterSection(2)" />
          </div>
          <div class="filter-chips">
            <span class="filter-chip active" id="f2_all" onclick="setStatusFilter(2, 'all')">Todos</span>
            <span class="filter-chip" id="f2_pending" onclick="setStatusFilter(2, 'pending')">Pendentes</span>
            <span class="filter-chip" id="f2_done" onclick="setStatusFilter(2, 'done')">Concluídos</span>
          </div>
        </div>
        <div class="task-list" id="list2">
          <div class="empty-state">
            <div class="empty-icon">⏳</div>
            <p>A carregar artigos para travar no sistema de gestão...</p>
          </div>
        </div>
        <div class="swipe-hint">👈 Deslize para a direita ou esquerda 👉</div>
      </div>

      <!-- ====================================================================
           SECÇÃO 4: PREVENIR RUTURAS & ENCOMENDAS (PONTO 4)
           ==================================================================== -->
      <div class="section-page" id="page3">
        <div class="search-filter-bar">
          <div class="search-input-wrapper">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="search3" placeholder="Pesquisar produto em rutura ou CNP..." oninput="filterSection(3)" />
          </div>
          <div class="filter-chips">
            <span class="filter-chip active" id="f3_all" onclick="setStatusFilter(3, 'all')">Todos</span>
            <span class="filter-chip" id="f3_pending" onclick="setStatusFilter(3, 'pending')">Pendentes</span>
            <span class="filter-chip" id="f3_done" onclick="setStatusFilter(3, 'done')">Concluídos</span>
          </div>
        </div>
        <div class="task-list" id="list3">
          <div class="empty-state">
            <div class="empty-icon">⏳</div>
            <p>A carregar artigos com risco de rutura...</p>
          </div>
        </div>
        <div class="swipe-hint">👈 Deslize para a direita para ver as secções anteriores</div>
      </div>

    </div>
  </div>

  <!-- Toast de Notificação -->
  <div id="toast">✅ Tarefa concluída!</div>

  <script>
    // ========================================================================
    // ESTADO GLOBAL DA APLICAÇÃO MOBILE
    // ========================================================================
    let currentSectionIndex = 0;
    let enteredPin = '';
    let currentFarmacia = null;
    let currentOperator = localStorage.getItem('bi_pharma_operator') || '';
    let selectedMemberId = null;
    let rawReport = null;
    let tasksMap = {};
    let allFarmacias = [];
    let statusFilters = ['all', 'all', 'all', 'all'];
    let balcaoSubtab = 'restos'; // 'restos' | 'winter' | 'all'
    let syncInterval = null;
    let taskEventSource = null;

    // Gestos de Touch / Swipe
    let touchStartX = 0;
    let touchStartY = 0;
    let touchEndX = 0;
    let touchEndY = 0;

    // Inicialização
    window.addEventListener('DOMContentLoaded', async () => {
      setupTouchSwipe();
      document.getElementById('pinOperatorInput').value = currentOperator;
      await initMobileApp();
    });

    function showToast(msg, bg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.background = bg || '#0284c7';
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2200);
      if (navigator.vibrate) {
        navigator.vibrate(35);
      }
    }

    // ========================================================================
    // GESTÃO DE TOUCH SWIPE (DESLIZAR PARA O LADO EM 4 SECÇÕES)
    // ========================================================================
    function setupTouchSwipe() {
      const viewport = document.getElementById('viewport');

      viewport.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
      }, { passive: true });

      viewport.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        touchEndY = e.changedTouches[0].screenY;
        handleSwipeGesture();
      }, { passive: true });
    }

    function handleSwipeGesture() {
      const deltaX = touchEndX - touchStartX;
      const deltaY = touchEndY - touchStartY;

      // Verificar se foi um deslize horizontal dominante
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 45) {
        if (deltaX < 0) {
          // Deslizar para a esquerda -> Próxima secção
          if (currentSectionIndex < 3) {
            goToSection(currentSectionIndex + 1);
          }
        } else {
          // Deslizar para a direita -> Secção anterior
          if (currentSectionIndex > 0) {
            goToSection(currentSectionIndex - 1);
          }
        }
      }
    }

    function goToSection(index) {
      currentSectionIndex = index;
      const viewport = document.getElementById('viewport');
      viewport.style.transform = \`translateX(-\${index * 100}vw)\`;

      // Atualizar botões de tabs e indicador
      document.querySelectorAll('.tab-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx === index);
      });

      const indicator = document.getElementById('tabIndicator');
      indicator.style.transform = \`translateX(\${index * 100}%)\`;

      if (index === 0) indicator.style.backgroundColor = '#fb7185';
      else if (index === 1) indicator.style.backgroundColor = '#c084fc';
      else if (index === 2) indicator.style.backgroundColor = '#fbbf24';
      else indicator.style.backgroundColor = '#34d399';
    }

    // ========================================================================
    // AUTENTICAÇÃO POR PIN MÍNIMO
    // ========================================================================
    // INICIALIZAÇÃO DA APP MOBILE
    // ========================================================================
    async function initMobileApp() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const targetId = (urlParams.get('farmaciaId') || urlParams.get('farmacia') || '').trim();
        const accessCode = (urlParams.get('acesso') || urlParams.get('code') || urlParams.get('accessCode') || '').trim();

        // 1. Chamar /api/pharmacies passando x-access-code se estiver no URL para autorizar de imediato
        const fetchHeaders = {};
        if (accessCode) {
          fetchHeaders['x-access-code'] = accessCode;
        }
        const res = await fetch('/api/pharmacies' + (accessCode ? '?acesso=' + encodeURIComponent(accessCode) : ''), {
          headers: fetchHeaders
        });
        const data = await res.json();
        allFarmacias = Array.isArray(data) ? data : (data.pharmacies || []);
        
        const sel = document.getElementById('pinFarmSelect');
        sel.innerHTML = allFarmacias
          .map(f => \`<option value="\${escapeHtml(f.id)}">\${escapeHtml(f.nome)} (\${escapeHtml(f.codigo_acesso || f.nif)})</option>\`)
          .join('');

        let targetFarmFromUrl = null;
        if (targetId || accessCode) {
          targetFarmFromUrl = allFarmacias.find(f => {
            if (targetId && (f.id === targetId || f.nif === targetId)) return true;
            if (accessCode && f.codigo_acesso && f.codigo_acesso.toLowerCase() === accessCode.toLowerCase()) return true;
            if (accessCode && f.id === accessCode) return true;
            return false;
          });
          if (targetFarmFromUrl) {
            sel.value = targetFarmFromUrl.id;
          }
        }

        // Se o endpoint retornou apenas 1 farmácia (ex: autenticada por x-access-code ou cookie)
        if (!targetFarmFromUrl && allFarmacias.length === 1) {
          targetFarmFromUrl = allFarmacias[0];
          sel.value = targetFarmFromUrl.id;
        }

        if (sel.value) {
          loadPharmacyTeamChips(sel.value);
        }

        const saved = JSON.parse(localStorage.getItem('bi_pharma_mobile_session') || '{}');

        // Se o utilizador abriu um link específico da Farmácia ou foi autenticado:
        if (targetFarmFromUrl) {
          currentFarmacia = targetFarmFromUrl;
          if (accessCode && !currentFarmacia.codigo_acesso) {
            currentFarmacia.codigo_acesso = accessCode;
          }
          if (saved && saved.operator) {
            currentOperator = saved.operator;
          }
          localStorage.setItem('bi_pharma_mobile_session', JSON.stringify({
            farmacia: currentFarmacia,
            operator: currentOperator,
            savedAt: Date.now(),
          }));
          document.getElementById('pinOverlay').style.display = 'none';
          document.getElementById('hdrFarmName').textContent = currentFarmacia.nome;
          document.getElementById('hdrOperatorName').textContent = currentOperator;
          loadMobileData();
          startLiveSync();
          return;
        }

        // Sem link de farmácia no URL: restaura a sessão guardada se existir
        if (saved && saved.farmacia && saved.farmacia.id) {
          restoreMobileSession(saved);
        } else {
          document.getElementById('pinOverlay').style.display = 'flex';
        }
      } catch (err) {
        console.error('Erro na inicialização mobile:', err);
        document.getElementById('pinOverlay').style.display = 'flex';
      }
    }

    function restoreMobileSession(saved) {
      currentFarmacia = saved.farmacia;
      if (saved.operator) currentOperator = saved.operator;
      document.getElementById('pinOverlay').style.display = 'none';
      document.getElementById('hdrFarmName').textContent = currentFarmacia.nome;
      document.getElementById('hdrOperatorName').textContent = currentOperator;
      loadMobileData();
      startLiveSync();
    }

    function logoutMobile() {
      const nomeFarm = currentFarmacia?.nome || 'esta farmácia';
      if (confirm('Deseja terminar a sessão na ' + nomeFarm + ' e mudar de farmácia?')) {
        if (syncInterval) clearInterval(syncInterval);
        syncInterval = null; if (taskEventSource) { try { taskEventSource.close(); } catch(e) {} taskEventSource = null; }
        localStorage.removeItem('bi_pharma_mobile_session');
        currentFarmacia = null;
        rawReport = null;
        tasksMap = {};
        clearPin();

        // Limpar parâmetros de query da URL para não forçar a mesma farmácia após logout
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);

        document.getElementById('pinOverlay').style.display = 'flex';
        showToast('👋 Sessão terminada. Pode escolher outra farmácia.', '#64748b');
      }
    }

    function setOperator(name, memberId) {
      const input = document.getElementById('pinOperatorInput');
      if (input) input.value = name;
      currentOperator = name;
      selectedMemberId = memberId || null;
      document.querySelectorAll('.operator-chip').forEach(c => {
        c.classList.toggle('active', c.textContent.trim() === name.trim());
      });
    }

    function handleOperatorChipClick(el) {
      if (!el) return;
      const name = el.getAttribute('data-name') || el.textContent.trim();
      const id = el.getAttribute('data-id') || null;
      setOperator(name, id);
    }

    async function loadPharmacyTeamChips(farmId) {
      const container = document.getElementById('operatorChipsContainer');
      if (!container || !farmId) return;
      container.innerHTML = '<span style="font-size: 0.72rem; color: #94a3b8;">A carregar colaboradores...</span>';
      try {
        const res = await fetch('/api/mobile/team-members?farmaciaId=' + encodeURIComponent(farmId));
        const data = await res.json();
        let chipsHtml = '';
        if (data.ok && Array.isArray(data.members) && data.members.length > 0) {
          chipsHtml = data.members.map(function(m) {
            return '<span class="operator-chip" data-name="' + escapeHtml(m.nome) + '" data-id="' + escapeHtml(m.id) + '" onclick="handleOperatorChipClick(this)">' + escapeHtml(m.nome) + '</span>';
          }).join('');

          const input = document.getElementById('pinOperatorInput');
          if (input && (!input.value || input.value === 'Ana' || input.value === 'Balcão 1')) {
            setOperator(data.members[0].nome, data.members[0].id);
          }
        }
        chipsHtml += '<span class="operator-chip" data-name="Balcão 1" data-id="" onclick="handleOperatorChipClick(this)">Balcão 1</span>';
        chipsHtml += '<span class="operator-chip" data-name="Armazém" data-id="" onclick="handleOperatorChipClick(this)">Armazém</span>';
        container.innerHTML = chipsHtml;
      } catch (err) {
        container.innerHTML = 
          '<span class="operator-chip" data-name="Balcão 1" data-id="" onclick="handleOperatorChipClick(this)">Balcão 1</span>' +
          '<span class="operator-chip" data-name="Armazém" data-id="" onclick="handleOperatorChipClick(this)">Armazém</span>';
      }
    }

    function pressPin(digit) {
      if (enteredPin.length < 4) {
        enteredPin += digit;
        updatePinDots();
        if (enteredPin.length === 4) {
          setTimeout(submitPin, 150);
        }
      }
    }

    function clearPin() {
      enteredPin = '';
      updatePinDots();
    }

    function updatePinDots() {
      for (let i = 1; i <= 4; i++) {
        const dot = document.getElementById('dot' + i);
        dot.classList.toggle('filled', i <= enteredPin.length);
      }
    }

    async function submitPin() {
      const farmId = document.getElementById('pinFarmSelect').value;
      const opName = (document.getElementById('pinOperatorInput').value || '').trim() || 'Equipa';
      currentOperator = opName;
      localStorage.setItem('bi_pharma_operator', currentOperator);

      if (!enteredPin) {
        showToast('⚠️ Introduza o PIN.', '#e11d48');
        return;
      }

      try {
        const res = await fetch('/api/mobile/auth-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ farmaciaId: farmId, pin: enteredPin, memberId: selectedMemberId }),
        });
        const data = await res.json();

        if (data.ok && data.farmacia) {
          currentFarmacia = data.farmacia;
          localStorage.setItem('bi_pharma_mobile_session', JSON.stringify({
            farmacia: currentFarmacia,
            operator: currentOperator,
            savedAt: Date.now(),
          }));
          document.getElementById('pinOverlay').style.display = 'none';
          document.getElementById('hdrFarmName').textContent = currentFarmacia.nome;
          document.getElementById('hdrOperatorName').textContent = currentOperator;
          showToast('👋 Bem-vindo(a), ' + currentOperator + '!', '#10b981');
          await loadMobileData();
          startLiveSync();
        } else {
          clearPin();
          showToast(data.error || 'PIN incorreto!', '#e11d48');
        }
      } catch (e) {
        showToast('Erro de ligação ao servidor.', '#e11d48');
      }
    }

    function changeOperator() {
      const novo = prompt('Identifique-se (Nome do colaborador):', currentOperator);
      if (novo && novo.trim()) {
        currentOperator = novo.trim();
        localStorage.setItem('bi_pharma_operator', currentOperator);
        document.getElementById('hdrOperatorName').textContent = currentOperator;
        showToast('👤 Operador alterado para ' + currentOperator, '#0284c7');
      }
    }

    // ========================================================================
    // AUTENTICAÇÃO E COMUNICAÇÃO PROTEGIDA COM A API
    // ========================================================================
    function getMobileAccessCode() {
      const urlParams = new URLSearchParams(window.location.search);
      const fromUrl = (urlParams.get('acesso') || urlParams.get('code') || urlParams.get('accessCode') || '').trim();
      if (fromUrl) return fromUrl;
      if (currentFarmacia && currentFarmacia.codigo_acesso) return currentFarmacia.codigo_acesso;
      if (currentFarmacia && currentFarmacia.id) return currentFarmacia.id;
      try {
        const saved = JSON.parse(localStorage.getItem('bi_pharma_mobile_session') || '{}');
        if (saved && saved.farmacia && saved.farmacia.codigo_acesso) return saved.farmacia.codigo_acesso;
        if (saved && saved.farmacia && saved.farmacia.id) return saved.farmacia.id;
      } catch {}
      return '';
    }

    function fetchMobileAuth(url, options) {
      options = options || {};
      const code = getMobileAccessCode();
      const headers = Object.assign({}, options.headers || {});
      if (code) {
        headers['x-access-code'] = code;
      }
      const separator = url.includes('?') ? '&' : '?';
      const finalUrl = code ? (url + separator + 'acesso=' + encodeURIComponent(code)) : url;
      return fetch(finalUrl, Object.assign({}, options, { headers }));
    }

    // ========================================================================
    // CARREGAMENTO E SINCRONIZAÇÃO EM DIRETO (SUPABASE)
    // ========================================================================
    async function loadMobileData() {
      if (!currentFarmacia) return;
      try {
        document.getElementById('tabCount1').textContent = '...';
        document.getElementById('tabCount2').textContent = '...';
        document.getElementById('tabCount3').textContent = '...';
        document.getElementById('tabCount4').textContent = '...';

        const [repRes, tasksRes] = await Promise.all([
          fetchMobileAuth('/api/analysis?farmaciaId=' + currentFarmacia.id),
          fetchMobileAuth('/api/weekly-tasks?farmaciaId=' + currentFarmacia.id),
        ]);

        if (!repRes.ok) {
          console.warn('Erro ao carregar dados mobile:', repRes.status);
          document.getElementById('pinOverlay').style.display = 'flex';
          showToast('⚠️ Sessão da farmácia expirada. Insira o PIN.', '#e11d48');
          return;
        }

        rawReport = await repRes.json();
        if (rawReport.ok === false || rawReport.error) {
          console.warn('Erro na resposta:', rawReport.error);
          document.getElementById('pinOverlay').style.display = 'flex';
          showToast('⚠️ ' + (rawReport.error || 'Acesso não autorizado.'), '#e11d48');
          return;
        }

        const tData = await tasksRes.json();
        tasksMap = tData.tasksMap || {};

        renderSection1();
        renderSection2();
        renderSection3();
        renderSection4();
        updateOverallProgress();
      } catch (err) {
        console.error('Erro ao carregar dados:', err);
        showToast('Erro de ligação ao servidor.', '#e11d48');
      }
    }

    // ========================================================================
    // SINCRONIZAÇÃO EM TEMPO REAL VIA SSE (SEM REDESENHAR O ECRÃ) + OFFLINE
    // ========================================================================
    // (taskEventSource já declarado no topo)
    const OFFLINE_QUEUE_KEY = 'bi_pharma_offline_tasks_queue';

    function getOfflineQueue() {
      try {
        return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
      } catch { return []; }
    }

    function saveOfflineQueue(queue) {
      try {
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
      } catch {}
    }

    async function flushOfflineQueue() {
      if (!navigator.onLine || !currentFarmacia) return;
      const queue = getOfflineQueue();
      if (!queue.length) return;

      const remaining = [];
      let syncedCount = 0;

      for (const item of queue) {
        try {
          await fetchMobileAuth('/api/weekly-tasks/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item),
          });
          syncedCount++;
        } catch {
          remaining.push(item);
        }
      }

      saveOfflineQueue(remaining);
      if (syncedCount > 0) {
        showToast('📡 ' + syncedCount + ' tarefa(s) sincronizada(s) após recuperar rede!', '#10b981', 3000);
      }
    }

    window.addEventListener('online', flushOfflineQueue);

    function startLiveSync() {
      // Fecha qualquer polling anterior
      if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null; if (taskEventSource) { try { taskEventSource.close(); } catch(e) {} taskEventSource = null; }
      }

      if (!currentFarmacia) return;
      if (taskEventSource) {
        try { taskEventSource.close(); } catch(e) {}
        taskEventSource = null;
      }

      const streamUrl = '/api/weekly-tasks/stream?farmaciaId=' + encodeURIComponent(currentFarmacia.id);
      try {
        taskEventSource = new EventSource(streamUrl);

        taskEventSource.addEventListener('task_update', (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.type === 'RESET') {
              tasksMap = {};
              filterSection(currentSectionIndex);
              updateOverallProgress();
              showToast('🔄 As tarefas foram reiniciadas pelo Diretor', '#0284c7');
              return;
            }

            if (data.type === 'TOGGLE' && data.taskId) {
              if (data.concluido) {
                tasksMap[data.taskId] = {
                  concluido: true,
                  concluido_por: data.concluido_por,
                  concluido_em: data.concluido_em,
                  valor_impacto: data.valor_impacto,
                  categoria: data.categoria
                };
              } else {
                delete tasksMap[data.taskId];
              }

              // Atualização CIRÚRGICA do DOM sem tocar no scroll nem inputs
              applyLiveTaskPatch(data);
              updateOverallProgress();

              // Se outro colega concluiu a tarefa, avisa suavemente
              if (data.concluido && data.concluido_por && data.concluido_por !== currentOperator) {
                showToast('✓ ' + escapeHtml(data.concluido_por) + ' picou: ' + escapeHtml(data.designacao || 'produto'), '#059669', 2400);
              }
            }
          } catch(err) {
            console.warn('[SSE] Erro ao processar:', err);
          }
        });

        taskEventSource.onerror = () => {
          // EventSource nativo reconecta automaticamente
        };
      } catch (err) {
        console.warn('SSE não suportado ou erro de ligação, a usar fallback leve');
      }

      // Verificação pontual silenciosa apenas quando a app volta a estar visível (após desbloquear telemóvel)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && currentFarmacia) {
          fetchMobileAuth('/api/weekly-tasks?farmaciaId=' + currentFarmacia.id)
            .then(r => r.json())
            .then(tData => {
              if (tData.ok && tData.tasksMap) {
                tasksMap = tData.tasksMap;
                updateOverallProgress();
                for (const taskId in tasksMap) {
                  applyLiveTaskPatch({ taskId, ...tasksMap[taskId] });
                }
              }
            })
            .catch(() => {});
          flushOfflineQueue();
        }
      });
    }

    function applyLiveTaskPatch(data) {
      const card = document.getElementById('card_' + data.taskId);
      if (!card) return;

      const checkBtn = card.querySelector('.task-check-btn');
      const body = card.querySelector('.task-body');

      if (data.concluido) {
        card.classList.add('completed');
        if (checkBtn) checkBtn.textContent = '✓';

        let stamp = card.querySelector('.task-completion-stamp');
        if (!stamp && body) {
          stamp = document.createElement('div');
          stamp.className = 'task-completion-stamp';
          body.appendChild(stamp);
        }
        if (stamp) {
          const time = formatTime(data.concluido_em || new Date().toISOString());
          stamp.innerHTML = '✓ Concluído por ' + escapeHtml(data.concluido_por || 'Equipa') + (time ? ' · ' + time : '');
        }

        // Se o utilizador estiver no filtro "Pendentes", aplica fade-out suave ao item
        const statusF = statusFilters[currentSectionIndex];
        if (statusF === 'pending') {
          setTimeout(() => {
            if (tasksMap[data.taskId]?.concluido && statusFilters[currentSectionIndex] === 'pending') {
              card.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
              card.style.opacity = '0';
              card.style.transform = 'scale(0.95)';
              setTimeout(() => { if (card.parentNode) card.style.display = 'none'; }, 400);
            }
          }, 600);
        }
      } else {
        card.classList.remove('completed');
        card.style.display = '';
        card.style.opacity = '1';
        card.style.transform = '';
        if (checkBtn) checkBtn.textContent = '';
        const stamp = card.querySelector('.task-completion-stamp');
        if (stamp) stamp.remove();
      }
    }

    // ========================================================================
    // RENDERIZAÇÃO DAS 4 SECÇÕES EM FORMATO LISTA
    // ========================================================================

    // SECÇÃO 1: VALIDADES PRÓXIMAS (GAVETA & PRATELEIRA COM FILTROS AVANÇADOS)
    function renderSection1(preserveScroll = false) {
      if (!rawReport) return;
      const container = document.getElementById('list0');
      const allCad = (rawReport.risco_elevado_caducidade || []).slice();
      document.getElementById('tabCount1').textContent = allCad.length;

      const q = (document.getElementById('search0').value || '').toLowerCase().trim();
      const statusF = statusFilters[0];
      const macroF = document.getElementById('cadMacroFilter')?.value || 'all';
      const horizonF = document.getElementById('cadHorizonFilter')?.value || 'all';
      const sortOrder = document.getElementById('cadSortOrder')?.value || 'date_asc';

      const filtered = allCad.filter(it => {
        const taskId = 'cad_' + it.cnp_codigo + '_' + (it.lote || 0);
        const isDone = !!tasksMap[taskId]?.concluido;
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
        return dateA.localeCompare(dateB);
      });

      const badgeEl = document.getElementById('cadCounterBadge');
      if (badgeEl) {
        badgeEl.textContent = \`\${filtered.length} de \${allCad.length} produtos\`;
      }

      if (filtered.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">✅</div>
            <p>Nenhuma validade pendente com os filtros selecionados.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = filtered.map(it => {
        const taskId = 'cad_' + it.cnp_codigo + '_' + (it.lote || 0);
        const tInfo = tasksMap[taskId];
        const isDone = !!tInfo?.concluido;
        const qtd = it.stock_atual != null ? it.stock_atual : (it.quantidade || 1);
        const valRisco = it.valor_em_risco != null ? it.valor_em_risco : (qtd * (it.custo_unitario || 0));

        return \`
          <div class="task-card \${isDone ? 'completed' : ''}" id="card_\${taskId}">
            <div class="task-check-btn" onclick="toggleTask('\${taskId}', 'VALIDADE', '\${it.cnp_codigo}', '\${escapeHtml(it.designacao)}', \${valRisco})">
              \${isDone ? '✓' : ''}
            </div>
            <div class="task-body">
              <div class="task-title">\${escapeHtml(it.designacao)}</div>
              <div class="task-tags">
                <span class="tag tag-danger">📅 Val: \${escapeHtml(it.data_validade || 'Curto Prazo')}</span>
                <span class="tag tag-danger">📦 \${qtd} un (\${Number(valRisco).toFixed(2)} €)</span>
                \${it.prateleira ? \`<span class="tag tag-shelf">📍 \${escapeHtml(it.prateleira)}</span>\` : ''}
                <span class="tag tag-cnp">CNP: \${escapeHtml(it.cnp_codigo)}</span>
              </div>
              <div class="task-instruction">
                ⚠️ <b>Ação Gaveta / Balcão:</b> Separar fisicamente da prateleira ou colocar em destaque imediato de balcão.
              </div>
              \${isDone ? \`
                <div class="task-completion-stamp">
                  ✓ Concluído por \${escapeHtml(tInfo?.concluido_por || 'Equipa')} · \${formatTime(tInfo?.concluido_em)}
                </div>
              \` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    // SECÇÃO 2: BALCÃO (A-Z ALFABÉTICO + DESTAQUES DE INVERNO)
    function setBalcaoSubtab(tab) {
      balcaoSubtab = tab;
      document.getElementById('btnSubtabRestos').classList.toggle('active', tab === 'restos');
      document.getElementById('btnSubtabWinter').classList.toggle('active', tab === 'winter');
      document.getElementById('btnSubtabAll').classList.toggle('active', tab === 'all');
      renderSection2();
    }

    function renderSection2(preserveScroll = false) {
      if (!rawReport) return;
      const container = document.getElementById('list1');

      // Moléculas com restos de gaveta, estritamente ordenadas por ORDEM ALFABÉTICA (A ➔ Z)
      const listGen = (rawReport.consolidacao_genericos_dci || [])
        .filter(g => g.restos_gaveta_escobar_primeiro && g.restos_gaveta_escobar_primeiro.length > 0)
        .slice()
        .sort((a, b) => {
          const nameA = a.grupo_equivalencia_dci || a.molecula_dci || '';
          const nameB = b.grupo_equivalencia_dci || b.molecula_dci || '';
          return nameA.localeCompare(nameB, 'pt');
        });

      // Excessos sazonais em pico de inverno (ordenados alfabeticamente)
      const listSeasonal = (rawReport.alertas_excesso_cobertura || [])
        .filter(i => (i.stock_atual || 0) >= 3 && /ben-u-gripe|cegripe|antigrip|grip|constip|tosse|frio|labi|ureia|vapor|pastilh|gargant|nasal/i.test(i.designacao))
        .slice()
        .sort((a, b) => (a.designacao || '').localeCompare(b.designacao || '', 'pt'));

      const totalItems = listGen.length + listSeasonal.length;
      document.getElementById('tabCount2').textContent = totalItems;

      const q = (document.getElementById('search1').value || '').toLowerCase().trim();
      const statusF = statusFilters[1];

      let html = '';

      // Bloco A: Restos de gaveta A-Z
      if (balcaoSubtab === 'restos' || balcaoSubtab === 'all') {
        const filteredGen = listGen.filter(g => {
          const taskId = 'gen_' + normStr(g.molecula_dci || g.grupo_equivalencia_dci);
          const isDone = !!tasksMap[taskId]?.concluido;
          if (statusF === 'pending' && isDone) return false;
          if (statusF === 'done' && !isDone) return false;
          if (q) {
            const mol = (g.molecula_dci || '').toLowerCase();
            const eq = (g.grupo_equivalencia_dci || '').toLowerCase();
            return mol.includes(q) || eq.includes(q);
          }
          return true;
        });

        if (filteredGen.length > 0) {
          html += '<div style="font-size: 0.78rem; font-weight: 800; color: #c084fc; text-transform: uppercase; margin: 4px 0 8px 0;">📦 Restos de Gaveta Alfabéticos (A ➔ Z):</div>';
          html += filteredGen.map(g => {
            const taskId = 'gen_' + normStr(g.molecula_dci || g.grupo_equivalencia_dci);
            const tInfo = tasksMap[taskId];
            const isDone = !!tInfo?.concluido;
            const restos = g.restos_gaveta_escobar_primeiro || [];
            const name = g.grupo_equivalencia_dci || g.molecula_dci;

            const restosRows = restos.map(r => \`
              <div class="resto-row">
                <span class="resto-name">• \${escapeHtml(r.designacao)} (<code>\${escapeHtml(r.cnp_codigo)}</code>)</span>
                <span class="resto-qtd">\${r.stock_atual} un</span>
              </div>
            \`).join('');

            return \`
              <div class="task-card \${isDone ? 'completed' : ''}" id="card_\${taskId}">
                <div class="task-check-btn" onclick="toggleTask('\${taskId}', 'RESTO_GAVETA', null, '\${escapeHtml(name)}', 0)">
                  \${isDone ? '✓' : ''}
                </div>
                <div class="task-body">
                  <div class="task-title">\${escapeHtml(name)}</div>
                  <div class="task-tags">
                    <span class="tag tag-purple">💊 \${restos.length} marcas a esgotar</span>
                  </div>
                  <div class="restos-box">
                    \${restosRows}
                  </div>
                  <div class="task-instruction" style="margin-top: 6px;">
                    👉 <b>Ação Balcão:</b> Dispensar primeiro estas caixas paradas antes de abrir novas marcas.
                  </div>
                  \${isDone ? \`
                    <div class="task-completion-stamp">
                      ✓ Concluído por \${escapeHtml(tInfo?.concluido_por || 'Equipa')} · \${formatTime(tInfo?.concluido_em)}
                    </div>
                  \` : ''}
                </div>
              </div>
            \`;
          }).join('');
        }
      }

      // Bloco B: Excessos Sazonais em Pico de Inverno
      if (balcaoSubtab === 'winter' || balcaoSubtab === 'all') {
        const filteredSeasonal = listSeasonal.filter(s => {
          const taskId = 'saz_' + s.cnp_codigo;
          const isDone = !!tasksMap[taskId]?.concluido;
          if (statusF === 'pending' && isDone) return false;
          if (statusF === 'done' && !isDone) return false;
          if (q) {
            const name = (s.designacao || '').toLowerCase();
            const cnp = (s.cnp_codigo || '').toLowerCase();
            return name.includes(q) || cnp.includes(q);
          }
          return true;
        });

        if (filteredSeasonal.length > 0) {
          html += '<div style="font-size: 0.78rem; font-weight: 800; color: #38bdf8; text-transform: uppercase; margin: 12px 0 8px 0;">❄️ Destaques da Época de Inverno (A ➔ Z):</div>';
          html += filteredSeasonal.map(s => {
            const taskId = 'saz_' + s.cnp_codigo;
            const tInfo = tasksMap[taskId];
            const isDone = !!tInfo?.concluido;

            return \`
              <div class="task-card \${isDone ? 'completed' : ''}" id="card_\${taskId}">
                <div class="task-check-btn" onclick="toggleTask('\${taskId}', 'DESTAQUE_SAZONAL', '\${s.cnp_codigo}', '\${escapeHtml(s.designacao)}', 0)">
                  \${isDone ? '✓' : ''}
                </div>
                <div class="task-body">
                  <div class="task-title">\${escapeHtml(s.designacao)}</div>
                  <div class="task-tags">
                    <span class="tag" style="background: rgba(56, 189, 248, 0.2); color: #bae6fd;">❄️ Inverno: \${s.stock_atual} un em stock</span>
                    <span class="tag tag-cnp">CNP: \${escapeHtml(s.cnp_codigo)}</span>
                  </div>
                  <div class="task-instruction">
                    🌟 <b>Ação Balcão:</b> Colocar no linear de topo ou sugerir ativamente em queixas respiratórias/gripais.
                  </div>
                  \${isDone ? \`
                    <div class="task-completion-stamp">
                      ✓ Concluído por \${escapeHtml(tInfo?.concluido_por || 'Equipa')} · \${formatTime(tInfo?.concluido_em)}
                    </div>
                  \` : ''}
                </div>
              </div>
            \`;
          }).join('');
        }
      }

      container.innerHTML = html || \`
        <div class="empty-state">
          <div class="empty-icon">✅</div>
          <p>Nenhuma tarefa de balcão pendente nesta lista.</p>
        </div>
      \`;
    }

    // SECÇÃO 3: TRAVAR ENCOMENDAS (O QUE NÃO ENCOMENDAR)
    function renderSection3(preserveScroll = false) {
      if (!rawReport) return;
      const container = document.getElementById('list2');
      const allExcess = rawReport.alertas_excesso_cobertura || [];
      document.getElementById('tabCount3').textContent = allExcess.length;

      const q = (document.getElementById('search2').value || '').toLowerCase().trim();
      const statusF = statusFilters[2];

      const filtered = allExcess.filter(it => {
        const taskId = 'travar_' + it.cnp_codigo;
        const isDone = !!tasksMap[taskId]?.concluido;
        if (statusF === 'pending' && isDone) return false;
        if (statusF === 'done' && !isDone) return false;
        if (q) {
          const name = (it.designacao || '').toLowerCase();
          const cnp = (it.cnp_codigo || '').toLowerCase();
          return name.includes(q) || cnp.includes(q);
        }
        return true;
      });

      if (filtered.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">✅</div>
            <p>Nenhum artigo pendente para travar no sistema de gestão.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = filtered.map(it => {
        const taskId = 'travar_' + it.cnp_codigo;
        const tInfo = tasksMap[taskId];
        const isDone = !!tInfo?.concluido;
        const stockVal = Number((it.stock_atual || 0) * (it.custo_unitario || 0));

        return \`
          <div class="task-card \${isDone ? 'completed' : ''}" id="card_\${taskId}">
            <div class="task-check-btn" onclick="toggleTask('\${taskId}', 'TRAVAR_SIFARMA', '\${it.cnp_codigo}', '\${escapeHtml(it.designacao)}', \${stockVal})">
              \${isDone ? '✓' : ''}
            </div>
            <div class="task-body">
              <div class="task-title">\${escapeHtml(it.designacao)}</div>
              <div class="task-tags">
                <span class="tag tag-warning">💰 \${stockVal.toFixed(2)} € em stock</span>
                <span class="tag tag-warning">📦 \${it.stock_atual} un (\${Number(it.meses_cobertura || 0).toFixed(1)} meses)</span>
                <span class="tag tag-cnp">CNP: \${escapeHtml(it.cnp_codigo)}</span>
              </div>
              <div class="task-instruction">
                🛑 <b>Ação no Sistema:</b> Alterar <b>Ponto de Encomenda / Stock Mínimo = 0</b> para travar novas compras.
              </div>
              \${isDone ? \`
                <div class="task-completion-stamp">
                  ✓ Travado por \${escapeHtml(tInfo?.concluido_por || 'Equipa')} · \${formatTime(tInfo?.concluido_em)}
                </div>
              \` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    // SECÇÃO 4: PREVENIR RUTURAS & ENCOMENDAS (PONTO 4)
    function renderSection4(preserveScroll = false) {
      if (!rawReport) return;
      const container = document.getElementById('list3');
      const allRutura = (rawReport.artigos_risco_rutura || []).slice();
      document.getElementById('tabCount4').textContent = allRutura.length;

      const q = (document.getElementById('search3').value || '').toLowerCase().trim();
      const statusF = statusFilters[3];

      const filtered = allRutura.filter(it => {
        const taskId = 'rut_' + it.cnp_codigo;
        const isDone = !!tasksMap[taskId]?.concluido;
        if (statusF === 'pending' && isDone) return false;
        if (statusF === 'done' && !isDone) return false;
        if (q) {
          const name = (it.designacao || '').toLowerCase();
          const cnp = (it.cnp_codigo || '').toLowerCase();
          return name.includes(q) || cnp.includes(q);
        }
        return true;
      });

      if (filtered.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">✅</div>
            <p>Nenhum artigo com risco de rutura pendente.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = filtered.map(it => {
        const taskId = 'rut_' + it.cnp_codigo;
        const tInfo = tasksMap[taskId];
        const isDone = !!tInfo?.concluido;
        const sugestaoEnc = it.sugestao_encomenda || Math.max(2, Math.ceil((it.vmm || 1) * 0.5));
        const diasTxt = it.dias_cobertura != null ? \`\${it.dias_cobertura} dias\` : 'crítica';

        return \`
          <div class="task-card \${isDone ? 'completed' : ''}" id="card_\${taskId}">
            <div class="task-check-btn" onclick="toggleTask('\${taskId}', 'PREVENIR_RUTURA', '\${it.cnp_codigo}', '\${escapeHtml(it.designacao)}', 0)">
              \${isDone ? '✓' : ''}
            </div>
            <div class="task-body">
              <div class="task-title">\${escapeHtml(it.designacao)}</div>
              <div class="task-tags">
                <span class="tag tag-danger">🚨 Cobertura: apenas \${escapeHtml(diasTxt)}</span>
                <span class="tag tag-success">📦 Encomendar: \${sugestaoEnc} un</span>
                <span class="tag" style="background:#0f172a; color:#94a3b8; border:1px solid #334155;">Stock: \${it.stock_atual} · VMM: \${it.vmm}/mês</span>
                <span class="tag tag-cnp">CNP: \${escapeHtml(it.cnp_codigo)}</span>
              </div>
              <div class="task-instruction">
                🟢 <b>Ajustar no Sistema:</b> Subir Ponto de Encomenda para <b>\${sugestaoEnc} un</b> ou gerar encomenda imediata ao fornecedor habitual.
              </div>
              \${isDone ? \`
                <div class="task-completion-stamp">
                  ✓ Encomendado/Ajustado por \${escapeHtml(tInfo?.concluido_por || 'Equipa')} · \${formatTime(tInfo?.concluido_em)}
                </div>
              \` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    // ========================================================================
    // TOGGLE / PICAR TAREFA (COM ATRIBUIÇÃO AO COLABORADOR)
    // ========================================================================
    async function toggleTask(taskId, categoria, cnp, designacao, valor) {
      if (!currentFarmacia) return;
      const isCurrentlyDone = !!tasksMap[taskId]?.concluido;
      const nextDoneState = !isCurrentlyDone;

      if (nextDoneState) {
        tasksMap[taskId] = {
          concluido: true,
          concluido_por: currentOperator,
          concluido_em: new Date().toISOString(),
          valor_impacto: valor,
          categoria: categoria,
        };
        showToast('✓ Tarefa picada por ' + currentOperator, '#10b981');
      } else {
        delete tasksMap[taskId];
        showToast('↩️ Tarefa reaberta', '#64748b');
      }

      // Feedback háptico suave no telemóvel
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try { navigator.vibrate(40); } catch(e) {}
      }

      // Atualização cirúrgica instantânea (0ms) do nó no DOM sem saltar o ecrã
      applyLiveTaskPatch({
        taskId: taskId,
        concluido: nextDoneState,
        concluido_por: currentOperator,
        concluido_em: new Date().toISOString(),
        designacao: designacao,
        valor_impacto: valor,
        categoria: categoria
      });
      updateOverallProgress();

      const payload = {
        farmaciaId: currentFarmacia.id,
        taskId: taskId,
        concluido: nextDoneState,
        concluido_por: currentOperator,
        categoria: categoria,
        cnp_codigo: cnp,
        designacao: designacao,
        valor_impacto: valor,
      };

      try {
        await fetchMobileAuth('/api/weekly-tasks/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        console.warn('Falha de rede ao enviar tarefa, a colocar em fila offline:', e);
        const queue = getOfflineQueue();
        queue.push(payload);
        saveOfflineQueue(queue);
        showToast('📶 Guardado no dispositivo. Sincroniza ao recuperar rede.', '#f59e0b', 3000);
      }
    }

    function updateOverallProgress() {
      if (!rawReport) return;
      const c1 = (rawReport.risco_elevado_caducidade || []).length;
      const c2 = (rawReport.consolidacao_genericos_dci || []).filter(g => g.restos_gaveta_escobar_primeiro?.length > 0).length +
                 (rawReport.alertas_excesso_cobertura || []).filter(i => (i.stock_atual || 0) >= 3 && /ben-u-gripe|cegripe|antigrip|grip|constip|tosse|frio|labi|ureia/i.test(i.designacao)).slice(0, 10).length;
      const c3 = (rawReport.alertas_excesso_cobertura || []).length;
      const c4 = (rawReport.artigos_risco_rutura || []).length;
      const totalPossible = c1 + c2 + c3 + c4;

      let doneCount = 0;
      let savings = 0;
      for (const k in tasksMap) {
        if (tasksMap[k]?.concluido) {
          doneCount++;
          if (tasksMap[k]?.valor_impacto) {
            savings += Number(tasksMap[k].valor_impacto);
          }
        }
      }

      const pct = totalPossible > 0 ? Math.round((doneCount / totalPossible) * 100) : 0;
      document.getElementById('hdrProgressCount').textContent = \`\${doneCount} de \${totalPossible} concluídas (\${pct}%)\`;
      document.getElementById('hdrProgressSavings').textContent = \`\${savings.toFixed(2)} € poupados\`;
      document.getElementById('hdrProgressFill').style.width = pct + '%';
    }

    // ========================================================================
    // FILTROS E UTILITÁRIOS
    // ========================================================================
    function filterSection(idx) {
      if (idx === 0) renderSection1();
      else if (idx === 1) renderSection2();
      else if (idx === 2) renderSection3();
      else renderSection4();
    }

    function setStatusFilter(secIdx, filter) {
      statusFilters[secIdx] = filter;
      const prefix = 'f' + secIdx + '_';
      document.getElementById(prefix + 'all').classList.toggle('active', filter === 'all');
      document.getElementById(prefix + 'pending').classList.toggle('active', filter === 'pending');
      document.getElementById(prefix + 'done').classList.toggle('active', filter === 'done');
      filterSection(secIdx);
    }

    function normStr(s) {
      return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
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

    function formatTime(isoStr) {
      if (!isoStr) return '';
      try {
        const d = new Date(isoStr);
        return d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }
  </script>
<script>
    // ========================================================================
    // GESTÃO DO PWA (SERVICE WORKER & INSTALAÇÃO NO ECRÃ INICIAL)
    // ========================================================================
    let deferredPrompt = null;

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.getRegistrations().then((regs) => {
          for (const r of regs) r.unregister();
        }).catch(() => {});
      });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const banner = document.getElementById('pwaInstallBanner');
      if (banner && !window.matchMedia('(display-mode: standalone)').matches) {
        banner.style.display = 'flex';
      }
    });

    document.addEventListener('DOMContentLoaded', () => {
      const installBtn = document.getElementById('pwaInstallBtn');
      if (installBtn) {
        installBtn.addEventListener('click', async () => {
          if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') {
              showToast('🎉 Aplicação adicionada com sucesso!', '#10b981');
            }
            deferredPrompt = null;
            document.getElementById('pwaInstallBanner').style.display = 'none';
          } else {
            // Instruções amigáveis para Safari / iOS
            showToast('💡 No iPhone: toque no botão Partilhar ⎋ e escolha "Adicionar ao Ecrã Principal"', '#0284c7', 5000);
          }
        });
      }
    });
</script>
</body>
</html>`;
}
