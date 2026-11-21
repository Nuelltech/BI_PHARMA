/**
 * Interface Web do Terminal de Balcão (Kiosk / Tablet Mode) - Fase 3
 * 
 * Auto-contido, sem dependências de CDN externas, otimizado para ecrãs táteis.
 * Suporta dois estados:
 *  1. Não emparelhado: Pede código de 6 carateres e nome do terminal.
 *  2. Emparelhado: Lista de operadores da farmácia + teclado numérico para PIN.
 *  3. Inatividade: 10 minutos voltam automaticamente à escolha de operador.
 */

export interface BalcaoViewOptions {
  isPaired: boolean;
  farmaciaNome?: string;
}

export function getBalcaoHtml(options: BalcaoViewOptions, nonce?: string): string {
  const { isPaired } = options;
  const nonceAttr = nonce ? `nonce="${nonce}"` : '';

  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>BI Pharma • Terminal de Balcão</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #0ea5e9;
      --accent-hover: #0284c7;
      --danger: #ef4444;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
      user-select: none;
      -webkit-user-select: none;
    }
    .header {
      margin-bottom: 24px;
      text-align: center;
    }
    .logo {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .subtitle {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      width: 100%;
      max-width: 440px;
      padding: 32px 24px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    input {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px;
      font-size: 18px;
      color: #fff;
      text-align: center;
      outline: none;
      letter-spacing: 2px;
    }
    input:focus {
      border-color: var(--accent);
    }
    .btn {
      width: 100%;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 14px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn:active { transform: scale(0.98); }
    .error-msg {
      color: var(--danger);
      font-size: 14px;
      text-align: center;
      margin-top: 12px;
      min-height: 20px;
    }
    
    /* Grelha de operadores */
    .operators-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-top: 16px;
    }
    .operator-btn {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 12px;
      color: var(--text-main);
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
    }
    .operator-btn:hover {
      border-color: var(--accent);
      background: #1e293b;
    }
    .operator-btn.selected {
      border-color: var(--accent);
      background: rgba(14, 165, 233, 0.15);
    }
    .operator-role {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 500;
    }

    /* Teclado numérico PIN */
    .keypad-container {
      margin-top: 24px;
      display: none;
    }
    .pin-display {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .pin-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid var(--card-border);
      transition: all 0.15s;
    }
    .pin-dot.filled {
      background: var(--accent);
      border-color: var(--accent);
      box-shadow: 0 0 10px rgba(14, 165, 233, 0.5);
    }
    .keypad-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    .key-btn {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
      font-size: 22px;
      font-weight: 600;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .key-btn:active {
      background: var(--accent);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      margin-bottom: 12px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
    }
    .inactivity-notice {
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
      margin-top: 20px;
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="logo">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M2 12h20"/></svg>
      BI PHARMA
    </div>
    <div class="subtitle">Terminal de Atendimento & Balcão</div>
  </div>

  <div class="card">
    ${!isPaired ? `
      <div style="text-align: center; margin-bottom: 20px;">
        <h2 style="font-size: 18px; margin-bottom: 6px;">Emparelhar Terminal</h2>
        <p style="font-size: 13px; color: var(--text-muted);">
          Introduza o código de 6 carateres gerado no painel do proprietário.
        </p>
      </div>

      <div class="form-group">
        <label>Código de Emparelhamento</label>
        <input type="text" id="pairCode" placeholder="XXX-XXX" maxlength="7" autofocus autocomplete="off">
      </div>

      <div class="form-group">
        <label>Nome deste Dispositivo</label>
        <input type="text" id="pairName" placeholder="Ex: Balcão 1" value="Balcão 1" maxlength="30" autocomplete="off">
      </div>

      <button class="btn" id="btnPair">Emparelhar Dispositivo</button>
      <div class="error-msg" id="pairError"></div>
    ` : `
      <div style="text-align: center; margin-bottom: 16px;">
        <div class="status-badge">
          <span class="dot"></span> Dispositivo Emparelhado & Seguro
        </div>
        <h2 style="font-size: 18px; margin-bottom: 4px;" id="screenTitle">Selecione o Operador</h2>
        <p style="font-size: 13px; color: var(--text-muted);" id="screenSubtitle">
          Escolha o seu perfil para desbloquear o terminal com o seu PIN.
        </p>
      </div>

      <div class="operators-grid" id="operatorsGrid">
        <div style="grid-column: span 2; text-align: center; padding: 20px; color: var(--text-muted);">
          A carregar operadores da farmácia...
        </div>
      </div>

      <div class="keypad-container" id="keypadContainer">
        <div class="pin-display">
          <div class="pin-dot" id="dot0"></div>
          <div class="pin-dot" id="dot1"></div>
          <div class="pin-dot" id="dot2"></div>
          <div class="pin-dot" id="dot3"></div>
        </div>

        <div class="keypad-grid">
          <button class="key-btn" onclick="pressKey('1')">1</button>
          <button class="key-btn" onclick="pressKey('2')">2</button>
          <button class="key-btn" onclick="pressKey('3')">3</button>
          <button class="key-btn" onclick="pressKey('4')">4</button>
          <button class="key-btn" onclick="pressKey('5')">5</button>
          <button class="key-btn" onclick="pressKey('6')">6</button>
          <button class="key-btn" onclick="pressKey('7')">7</button>
          <button class="key-btn" onclick="pressKey('8')">8</button>
          <button class="key-btn" onclick="pressKey('9')">9</button>
          <button class="key-btn" onclick="clearPin()" style="font-size: 14px; color: var(--text-muted);">LIMPAR</button>
          <button class="key-btn" onclick="pressKey('0')">0</button>
          <button class="key-btn" onclick="backspacePin()">⌫</button>
        </div>

        <button class="btn" onclick="cancelOperator()" style="margin-top: 16px; background: transparent; border: 1px solid var(--card-border); color: var(--text-muted);">
          ← Trocar Operador
        </button>
      </div>

      <div class="error-msg" id="pinError"></div>
      <div class="inactivity-notice">Inatividade de 10 min bloqueia e regressa à seleção de operador.</div>
    `}
  </div>

  <script ${nonceAttr}>
    ${!isPaired ? `
      const pairInput = document.getElementById('pairCode');
      const nameInput = document.getElementById('pairName');
      const btnPair = document.getElementById('btnPair');
      const pairError = document.getElementById('pairError');

      pairInput.addEventListener('input', (e) => {
        let v = e.target.value.toUpperCase().replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, '');
        if (v.length > 3) {
          v = v.slice(0, 3) + '-' + v.slice(3, 6);
        }
        e.target.value = v;
      });

      btnPair.addEventListener('click', async () => {
        const codigo = pairInput.value.trim();
        const nomeDispositivo = nameInput.value.trim() || 'Balcão 1';
        pairError.textContent = '';

        if (!codigo || codigo.length < 6) {
          pairError.textContent = 'Introduza o código completo de 6 carateres.';
          return;
        }

        btnPair.disabled = true;
        btnPair.textContent = 'A validar...';

        try {
          const res = await fetch('/api/devices/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo, nomeDispositivo })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            pairError.textContent = data.error || 'Erro ao emparelhar dispositivo.';
            btnPair.disabled = false;
            btnPair.textContent = 'Emparelhar Dispositivo';
          } else {
            // Emparelhado com sucesso! O cookie __Host-dev foi gravado pelo browser.
            window.location.reload();
          }
        } catch (err) {
          pairError.textContent = 'Erro de comunicação com o servidor.';
          btnPair.disabled = false;
          btnPair.textContent = 'Emparelhar Dispositivo';
        }
      });
    ` : `
      let selectedOperatorId = null;
      let currentPin = '';
      let inactivityTimer = null;

      function resetInactivityTimer() {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        // 10 minutos (600.000 ms)
        inactivityTimer = setTimeout(() => {
          cancelOperator();
        }, 10 * 60 * 1000);
      }

      ['click', 'touchstart', 'mousemove', 'keydown'].forEach(evt => {
        document.addEventListener(evt, resetInactivityTimer, { passive: true });
      });
      resetInactivityTimer();

      async function loadOperators() {
        try {
          const res = await fetch('/api/balcao/operadores');
          const data = await res.json();
          const grid = document.getElementById('operatorsGrid');
          if (!res.ok || !data.ok || !data.operadores) {
            grid.innerHTML = '<div style="grid-column: span 2; text-align: center; color: var(--danger);">' + (data.error || 'Erro ao carregar operadores.') + '</div>';
            return;
          }

          if (data.operadores.length === 0) {
            grid.innerHTML = '<div style="grid-column: span 2; text-align: center; color: var(--text-muted);">Nenhum operador configurado. Contacte o Diretor Técnico.</div>';
            return;
          }

          grid.innerHTML = data.operadores.map(op => \`
            <button class="operator-btn" onclick="selectOperator('\${op.id}', '\${op.nome}')">
              <span>\${op.nome}</span>
              <span class="operator-role">\${op.perfil.replace('_', ' ')}</span>
            </button>
          \`).join('');
        } catch (e) {
          document.getElementById('operatorsGrid').innerHTML = '<div style="grid-column: span 2; text-align: center; color: var(--danger);">Falha de ligação ao servidor.</div>';
        }
      }

      function selectOperator(id, name) {
        selectedOperatorId = id;
        currentPin = '';
        updatePinDots();
        document.getElementById('operatorsGrid').style.display = 'none';
        document.getElementById('keypadContainer').style.display = 'block';
        document.getElementById('screenTitle').textContent = 'PIN de Atendimento';
        document.getElementById('screenSubtitle').textContent = 'Operador: ' + name;
        document.getElementById('pinError').textContent = '';
      }

      function cancelOperator() {
        selectedOperatorId = null;
        currentPin = '';
        updatePinDots();
        document.getElementById('operatorsGrid').style.display = 'grid';
        document.getElementById('keypadContainer').style.display = 'none';
        document.getElementById('screenTitle').textContent = 'Selecione o Operador';
        document.getElementById('screenSubtitle').textContent = 'Escolha o seu perfil para desbloquear o terminal com o seu PIN.';
        document.getElementById('pinError').textContent = '';
      }

      function pressKey(num) {
        if (currentPin.length < 4) {
          currentPin += num;
          updatePinDots();
          if (currentPin.length === 4) {
            submitPin();
          }
        }
      }

      function clearPin() {
        currentPin = '';
        updatePinDots();
        document.getElementById('pinError').textContent = '';
      }

      function backspacePin() {
        if (currentPin.length > 0) {
          currentPin = currentPin.slice(0, -1);
          updatePinDots();
        }
      }

      function updatePinDots() {
        for (let i = 0; i < 4; i++) {
          const dot = document.getElementById('dot' + i);
          if (dot) {
            if (i < currentPin.length) dot.classList.add('filled');
            else dot.classList.remove('filled');
          }
        }
      }

      async function submitPin() {
        const pinError = document.getElementById('pinError');
        pinError.textContent = '';

        try {
          const res = await fetch('/api/auth/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              memberId: selectedOperatorId,
              pin: currentPin
            })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            pinError.textContent = data.error || 'PIN incorreto.';
            currentPin = '';
            updatePinDots();
          } else {
            // Sessão autorizada por PIN! Redirecionar para o painel de atendimento
            window.location.href = '/';
          }
        } catch (e) {
          pinError.textContent = 'Erro ao validar PIN no servidor.';
          currentPin = '';
          updatePinDots();
        }
      }

      loadOperators();
    `}
  </script>
</body>
</html>`;
}
