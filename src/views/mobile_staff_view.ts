export function getMobileStaffHtml(): string {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <meta name="theme-color" content="#0f172a" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
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
    }

    .operator-chip:active {
      background: #38bdf8;
      color: #0f172a;
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

    /* Barra de Tabs com Transição Deslizante */
    .tabs-bar {
      display: flex;
      background: #0f172a;
      border-bottom: 2px solid #1e293b;
      position: relative;
      flex-shrink: 0;
    }

    .tab-btn {
      flex: 1;
      padding: 12px 6px;
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 0.78rem;
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
      font-size: 0.68rem;
      padding: 1px 6px;
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

    .tab-indicator {
      position: absolute;
      bottom: -2px;
      left: 0;
      height: 2px;
      width: 33.333%;
      background: #38bdf8;
      transition: transform 0.25s cubic-bezier(0.25, 1, 0.5, 1), background-color 0.2s;
    }

    /* Swipeable Viewport (Deslizar para o lado) */
    .viewport {
      flex: 1;
      display: flex;
      width: 300vw;
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
      padding: 12px 14px 40px 14px;
      -webkit-overflow-scrolling: touch;
      user-select: text;
    }

    /* Barra de Pesquisa e Filtros */
    .search-filter-bar {
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .search-input-wrapper {
      position: relative;
    }

    .search-input {
      width: 100%;
      padding: 10px 14px 10px 36px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      color: #f8fafc;
      font-size: 0.85rem;
      outline: none;
    }

    .search-input:focus {
      border-color: #38bdf8;
    }

    .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: #64748b;
      font-size: 0.85rem;
    }

    .filter-chips {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .filter-chip {
      background: #0f172a;
      border: 1px solid #334155;
      color: #94a3b8;
      padding: 4px 10px;
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

    /* Cartões de Tarefa em Formato Lista */
    .task-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .task-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 14px;
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
      font-size: 0.92rem;
      font-weight: 700;
      color: #f8fafc;
      line-height: 1.3;
      margin-bottom: 4px;
      word-break: break-word;
    }

    .task-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 6px;
    }

    .tag {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 2px 7px;
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

    .tag-cnp {
      background: #0f172a;
      color: #38bdf8;
      border: 1px solid #334155;
      font-family: monospace;
      font-size: 0.72rem;
    }

    .task-instruction {
      font-size: 0.78rem;
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
      margin-top: 8px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 6px 10px;
    }

    .resto-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      padding: 4px 0;
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
      margin-top: 20px;
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
        <select id="pinFarmSelect" class="select-farmacia">
          <option value="">A carregar farmácias...</option>
        </select>
      </div>

      <div class="form-group">
        <label>O Teu Nome / Operador</label>
        <input type="text" id="pinOperatorInput" class="input-operator" placeholder="Ex: Ana, Rui, Balcão 1" />
        <div class="operator-chips">
          <span class="operator-chip" onclick="setOperator('Ana')">Ana</span>
          <span class="operator-chip" onclick="setOperator('Marta')">Marta</span>
          <span class="operator-chip" onclick="setOperator('Rui')">Rui</span>
          <span class="operator-chip" onclick="setOperator('Balcão 1')">Balcão 1</span>
          <span class="operator-chip" onclick="setOperator('Armazém')">Armazém</span>
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
       Ecrã Principal Mobile com Slide Horizontal
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
          <div class="user-pill" onclick="changeOperator()" id="hdrOperatorPill">
            👤 <span id="hdrOperatorName">Operador</span>
          </div>
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

    <!-- Barra de Separadores / Tabs -->
    <div class="tabs-bar">
      <button class="tab-btn tab-1 active" onclick="goToSection(0)">
        <span>🔴 1. Validades</span>
        <span class="badge-pill" id="tabCount1">0</span>
      </button>
      <button class="tab-btn tab-2" onclick="goToSection(1)">
        <span>🟣 2. Balcão</span>
        <span class="badge-pill" id="tabCount2">0</span>
      </button>
      <button class="tab-btn tab-3" onclick="goToSection(2)">
        <span>🟡 3. Sifarma</span>
        <span class="badge-pill" id="tabCount3">0</span>
      </button>
      <div class="tab-indicator" id="tabIndicator"></div>
    </div>

    <!-- Viewport Deslizante (Slide / Swipe) -->
    <div class="viewport" id="viewport">
      
      <!-- ====================================================================
           SECÇÃO 1: VALIDADES PRÓXIMAS (GAVETA & PRATELEIRA)
           ==================================================================== -->
      <div class="section-page" id="page0">
        <div class="search-filter-bar">
          <div class="search-input-wrapper">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="search0" placeholder="Pesquisar por produto ou CNP..." oninput="filterSection(0)" />
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
        <div class="swipe-hint">👉 Deslize para a esquerda para ver a secção "2. Balcão"</div>
      </div>

      <!-- ====================================================================
           SECÇÃO 2: BALCÃO & RESTOS DE GAVETA & SAZONAIS
           ==================================================================== -->
      <div class="section-page" id="page1">
        <div class="search-filter-bar">
          <div class="search-input-wrapper">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="search1" placeholder="Pesquisar molécula ou artigo..." oninput="filterSection(1)" />
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
           SECÇÃO 3: TRAVAR NO SIFARMA (O QUE NÃO ENCOMENDAR)
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
            <p>A carregar artigos para travar no Sifarma...</p>
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
    let currentOperator = localStorage.getItem('bi_pharma_operator') || 'Ana';
    let rawReport = null;
    let tasksMap = {};
    let allFarmacias = [];
    let statusFilters = ['all', 'all', 'all'];
    let syncInterval = null;

    // Gestos de Touch / Swipe
    let touchStartX = 0;
    let touchStartY = 0;
    let touchEndX = 0;
    let touchEndY = 0;

    // Inicialização
    window.addEventListener('DOMContentLoaded', async () => {
      setupTouchSwipe();
      document.getElementById('pinOperatorInput').value = currentOperator;
      await loadFarmaciasList();
      checkSavedSession();
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
    // GESTÃO DE TOUCH SWIPE (DESLIZAR PARA O LADO)
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
          if (currentSectionIndex < 2) {
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
      else indicator.style.backgroundColor = '#fbbf24';
    }

    // ========================================================================
    // AUTENTICAÇÃO POR PIN MÍNIMO
    // ========================================================================
    async function loadFarmaciasList() {
      try {
        const res = await fetch('/api/pharmacies');
        const data = await res.json();
        allFarmacias = data.pharmacies || [];
        const sel = document.getElementById('pinFarmSelect');
        sel.innerHTML = allFarmacias
          .map(f => \`<option value="\${f.id}">\${f.nome} (\${f.codigo_acesso || f.nif})</option>\`)
          .join('');

        // Se houver query param ?acesso= ou ?farmacia= selecionar automaticamente
        const urlParams = new URLSearchParams(window.location.search);
        const accessParam = urlParams.get('acesso') || urlParams.get('code') || urlParams.get('farmacia');
        if (accessParam) {
          const match = allFarmacias.find(
            f => (f.codigo_acesso && f.codigo_acesso.toLowerCase() === accessParam.toLowerCase()) || f.id === accessParam
          );
          if (match) {
            sel.value = match.id;
          }
        }
      } catch (err) {
        console.error('Erro ao listar farmácias:', err);
      }
    }

    function setOperator(name) {
      document.getElementById('pinOperatorInput').value = name;
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
          body: JSON.stringify({ farmaciaId: farmId, pin: enteredPin }),
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

    function checkSavedSession() {
      try {
        const saved = JSON.parse(localStorage.getItem('bi_pharma_mobile_session') || '{}');
        if (saved && saved.farmacia && saved.farmacia.id) {
          currentFarmacia = saved.farmacia;
          if (saved.operator) currentOperator = saved.operator;
          document.getElementById('pinOverlay').style.display = 'none';
          document.getElementById('hdrFarmName').textContent = currentFarmacia.nome;
          document.getElementById('hdrOperatorName').textContent = currentOperator;
          loadMobileData();
          startLiveSync();
        }
      } catch (err) {}
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
    // CARREGAMENTO E SINCRONIZAÇÃO EM DIRETO (SUPABASE)
    // ========================================================================
    async function loadMobileData() {
      if (!currentFarmacia) return;
      try {
        // Obter simultaneamente a análise da farmácia e o mapa de tarefas concluídas no Supabase
        const [repRes, tasksRes] = await Promise.all([
          fetch('/api/analysis?farmaciaId=' + currentFarmacia.id),
          fetch('/api/weekly-tasks?farmaciaId=' + currentFarmacia.id),
        ]);

        rawReport = await repRes.json();
        const tData = await tasksRes.json();
        tasksMap = tData.tasksMap || {};

        renderSection1();
        renderSection2();
        renderSection3();
        updateOverallProgress();
      } catch (err) {
        console.error('Erro ao carregar dados:', err);
      }
    }

    function startLiveSync() {
      if (syncInterval) clearInterval(syncInterval);
      // Polling a cada 4 segundos para refletir em direto o que outros colegas picam
      syncInterval = setInterval(async () => {
        if (!currentFarmacia) return;
        try {
          const res = await fetch('/api/weekly-tasks?farmaciaId=' + currentFarmacia.id);
          const tData = await res.json();
          tasksMap = tData.tasksMap || {};
          renderSection1(true);
          renderSection2(true);
          renderSection3(true);
          updateOverallProgress();
        } catch {}
      }, 4000);
    }

    // ========================================================================
    // RENDERIZAÇÃO DAS 3 SECÇÕES EM FORMATO LISTA
    // ========================================================================

    // SECÇÃO 1: VALIDADES PRÓXIMAS (GAVETA & PRATELEIRA)
    function renderSection1(preserveScroll = false) {
      if (!rawReport) return;
      const container = document.getElementById('list0');
      const allCad = rawReport.risco_elevado_caducidade || [];
      document.getElementById('tabCount1').textContent = allCad.length;

      const q = (document.getElementById('search0').value || '').toLowerCase().trim();
      const statusF = statusFilters[0];

      const filtered = allCad.filter(it => {
        const taskId = 'cad_' + it.cnp_codigo + '_' + (it.lote || 0);
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
            <p>Nenhuma validade pendente nesta lista.</p>
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
              <div class="task-title">\${it.designacao}</div>
              <div class="task-tags">
                <span class="tag tag-danger">📅 Val: \${it.data_validade || 'Curto Prazo'}</span>
                <span class="tag tag-danger">📦 \${qtd} un (\${Number(valRisco).toFixed(2)} €)</span>
                <span class="tag tag-cnp">CNP: \${it.cnp_codigo}</span>
              </div>
              <div class="task-instruction">
                ⚠️ <b>Ação Gaveta:</b> Separar fisicamente da prateleira ou colocar em destaque imediato de balcão.
              </div>
              \${isDone ? \`
                <div class="task-completion-stamp">
                  ✓ Concluído por \${tInfo?.concluido_por || 'Equipa'} · \${formatTime(tInfo?.concluido_em)}
                </div>
              \` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    // SECÇÃO 2: BALCÃO & RESTOS DE GAVETA & SAZONAIS
    function renderSection2(preserveScroll = false) {
      if (!rawReport) return;
      const container = document.getElementById('list1');

      // Moléculas com restos de gaveta
      const listGen = (rawReport.consolidacao_genericos_dci || [])
        .filter(g => g.restos_gaveta_escobar_primeiro && g.restos_gaveta_escobar_primeiro.length > 0);

      // Excessos sazonais em pico de inverno
      const listSeasonal = (rawReport.alertas_excesso_cobertura || [])
        .filter(i => (i.stock_atual || 0) >= 3 && /ben-u-gripe|cegripe|antigrip|grip|constip|tosse|frio|labi|ureia/i.test(i.designacao))
        .slice(0, 10);

      const totalItems = listGen.length + listSeasonal.length;
      document.getElementById('tabCount2').textContent = totalItems;

      const q = (document.getElementById('search1').value || '').toLowerCase().trim();
      const statusF = statusFilters[1];

      let html = '';

      // Bloco A: Restos de gaveta
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
        html += '<div style="font-size: 0.78rem; font-weight: 800; color: #c084fc; text-transform: uppercase; margin: 4px 0 8px 0;">📦 Restos de Gaveta (Dispensar Primeiro):</div>';
        html += filteredGen.map(g => {
          const taskId = 'gen_' + normStr(g.molecula_dci || g.grupo_equivalencia_dci);
          const tInfo = tasksMap[taskId];
          const isDone = !!tInfo?.concluido;
          const restos = g.restos_gaveta_escobar_primeiro || [];
          const name = g.grupo_equivalencia_dci || g.molecula_dci;

          const restosRows = restos.map(r => \`
            <div class="resto-row">
              <span class="resto-name">• \${r.designacao} (<code>\${r.cnp_codigo}</code>)</span>
              <span class="resto-qtd">\${r.stock_atual} un</span>
            </div>
          \`).join('');

          return \`
            <div class="task-card \${isDone ? 'completed' : ''}" id="card_\${taskId}">
              <div class="task-check-btn" onclick="toggleTask('\${taskId}', 'RESTO_GAVETA', null, '\${escapeHtml(name)}', 0)">
                \${isDone ? '✓' : ''}
              </div>
              <div class="task-body">
                <div class="task-title">\${name}</div>
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
                    ✓ Concluído por \${tInfo?.concluido_por || 'Equipa'} · \${formatTime(tInfo?.concluido_em)}
                  </div>
                \` : ''}
              </div>
            </div>
          \`;
        }).join('');
      }

      // Bloco B: Excessos Sazonais
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
        html += '<div style="font-size: 0.78rem; font-weight: 800; color: #fb923c; text-transform: uppercase; margin: 16px 0 8px 0;">🔥 Destaque Sazonal de Inverno:</div>';
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
                <div class="task-title">\${s.designacao}</div>
                <div class="task-tags">
                  <span class="tag" style="background: rgba(249, 115, 22, 0.2); color: #fdba74;">📦 \${s.stock_atual} un em stock</span>
                  <span class="tag tag-cnp">CNP: \${s.cnp_codigo}</span>
                </div>
                <div class="task-instruction">
                  🌟 <b>Ação Balcão:</b> Colocar no linear de topo ou balcão de atendimento ativo.
                </div>
                \${isDone ? \`
                  <div class="task-completion-stamp">
                    ✓ Concluído por \${tInfo?.concluido_por || 'Equipa'} · \${formatTime(tInfo?.concluido_em)}
                  </div>
                \` : ''}
              </div>
            </div>
          \`;
        }).join('');
      }

      container.innerHTML = html || \`
        <div class="empty-state">
          <div class="empty-icon">✅</div>
          <p>Nenhuma tarefa de balcão pendente nesta lista.</p>
        </div>
      \`;
    }

    // SECÇÃO 3: TRAVAR NO SIFARMA (O QUE NÃO ENCOMENDAR)
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
            <p>Nenhum artigo pendente para travar no Sifarma.</p>
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
              <div class="task-title">\${it.designacao}</div>
              <div class="task-tags">
                <span class="tag tag-warning">💰 \${stockVal.toFixed(2)} € em stock</span>
                <span class="tag tag-warning">📦 \${it.stock_atual} un (\${Number(it.meses_cobertura || 0).toFixed(1)} meses)</span>
                <span class="tag tag-cnp">CNP: \${it.cnp_codigo}</span>
              </div>
              <div class="task-instruction">
                🛑 <b>Ação no Sifarma:</b> Alterar <b>Ponto de Encomenda / Stock Mínimo = 0</b> para travar novas compras.
              </div>
              \${isDone ? \`
                <div class="task-completion-stamp">
                  ✓ Travado por \${tInfo?.concluido_por || 'Equipa'} · \${formatTime(tInfo?.concluido_em)}
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

      // Atualização otimista imediata na interface
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

      // Re-renderizar secção atual
      if (currentSectionIndex === 0) renderSection1();
      else if (currentSectionIndex === 1) renderSection2();
      else renderSection3();
      updateOverallProgress();

      // Gravar na base de dados Supabase via API
      try {
        await fetch('/api/weekly-tasks/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            farmaciaId: currentFarmacia.id,
            taskId: taskId,
            concluido: nextDoneState,
            concluido_por: currentOperator,
            categoria: categoria,
            cnp_codigo: cnp,
            designacao: designacao,
            valor_impacto: valor,
          }),
        });
      } catch (e) {
        console.error('Erro ao guardar no Supabase:', e);
      }
    }

    function updateOverallProgress() {
      if (!rawReport) return;
      const c1 = (rawReport.risco_elevado_caducidade || []).length;
      const c2 = (rawReport.consolidacao_genericos_dci || []).filter(g => g.restos_gaveta_escobar_primeiro?.length > 0).length +
                 (rawReport.alertas_excesso_cobertura || []).filter(i => (i.stock_atual || 0) >= 3 && /ben-u-gripe|cegripe|antigrip|grip|constip|tosse|frio|labi|ureia/i.test(i.designacao)).slice(0, 10).length;
      const c3 = (rawReport.alertas_excesso_cobertura || []).length;
      const totalPossible = c1 + c2 + c3;

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
      else renderSection3();
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
      return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
</body>
</html>`;
}
