/**
 * Ecrã /login da Fase 1 e Fase 4 (Spec v2.1)
 * - Email + Password + TOTP / Código de Recuperação
 * - Suporte a Passkeys (FIDO2 / WebAuthn)
 * - Suporte estrito a CSP Nonces
 * - ZERO tokens em localStorage (autenticação por cookie HttpOnly __Host-sid)
 */
export function getLoginHtml(nonce?: string): string {
  const nonceAttr = nonce ? `nonce="${nonce}"` : '';

  return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BI Pharma — Iniciar Sessão</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --primary: #0284c7;
      --primary-dark: #0369a1;
      --danger: #dc2626;
      --border: #e2e8f0;
      --success: #16a34a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 32px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08);
    }
    .brand { font-size: 1.45rem; font-weight: 800; color: var(--primary-dark); margin-bottom: 4px; }
    .subtitle { font-size: 0.88rem; color: var(--muted); margin-bottom: 24px; }
    label { display: block; font-size: 0.82rem; font-weight: 700; margin-bottom: 6px; color: #334155; }
    input {
      width: 100%;
      padding: 11px 13px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 0.95rem;
      margin-bottom: 16px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15);
    }
    .btn {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 8px;
      background: var(--primary);
      color: #fff;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn:hover { background: var(--primary-dark); }
    .btn:disabled { opacity: 0.65; cursor: not-allowed; }
    .btn-secondary {
      background: #0f172a;
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-secondary:hover { background: #1e293b; }
    .error {
      background: #fef2f2;
      color: var(--danger);
      border: 1px solid #fecaca;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 0.84rem;
      margin-bottom: 16px;
      display: none;
      line-height: 1.4;
    }
    .divider {
      display: flex;
      align-items: center;
      text-align: center;
      margin: 20px 0;
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      border-bottom: 1px solid var(--border);
    }
    .divider:not(:empty)::before { margin-right: .75em; }
    .divider:not(:empty)::after { margin-left: .75em; }
    .links { margin-top: 20px; text-align: center; font-size: 0.84rem; }
    .links a { color: var(--primary); text-decoration: none; font-weight: 600; }
    .links a:hover { text-decoration: underline; }
    #totpGroup {
      display: none;
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      padding: 14px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    #totpGroup label { color: #0369a1; }
    .totp-hint { font-size: 0.76rem; color: #0284c7; margin-top: -10px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">BI Pharma</div>
    <div class="subtitle">Portal de Gestão & Inteligência Farmacêutica</div>

    <div id="errorBox" class="error" role="alert"></div>

    <form id="loginForm" method="POST" action="javascript:void(0)" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required placeholder="nome@farmacia.pt" />

      <label for="password">Palavra-passe</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required placeholder="••••••••••" />

      <div id="totpGroup">
        <label for="totpCode">Código de Verificação 2FA ou Código de Recuperação</label>
        <input id="totpCode" name="totpCode" type="text" autocomplete="one-time-code" placeholder="ex: 123456 ou 11111111" />
        <div class="totp-hint">Introduza o código de 6 dígitos da sua aplicação autenticadora ou um código de recuperação de 8 dígitos.</div>
      </div>

      <button id="submitBtn" class="btn" type="submit">Entrar</button>
    </form>

    <div class="divider">ou</div>

    <button id="passkeyBtn" class="btn btn-secondary" type="button">
      <span>🔑 Entrar com Passkey (Biometria)</span>
    </button>

    <div class="links">
      <a href="/forgot-password">Esqueci-me da palavra-passe</a>
    </div>
  </main>

  <script ${nonceAttr}>
    const form = document.getElementById('loginForm');
    const errorBox = document.getElementById('errorBox');
    const totpGroup = document.getElementById('totpGroup');
    const submitBtn = document.getElementById('submitBtn');
    const passkeyBtn = document.getElementById('passkeyBtn');

    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.style.display = 'block';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      submitBtn.disabled = true;

      try {
        const payload = {
          email: document.getElementById('email').value.trim(),
          password: document.getElementById('password').value,
        };
        const totp = document.getElementById('totpCode').value.trim();
        if (totp) payload.totpCode = totp;

        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
          if (data.requiresTotp || data.requiresMfaSetup || data.requireDeviceChallenge) {
            totpGroup.style.display = 'block';
            document.getElementById('totpCode').focus();
          }
          showError(data.error || 'Não foi possível iniciar sessão.');
          return;
        }

        // Guardar identificador da farmácia ativa em sessionStorage (por separador)
        sessionStorage.removeItem('bi_pharma_active_farmacia_id');
        if (data.activeFarmaciaId) {
          sessionStorage.setItem('bi_pharma_active_farmacia_id', data.activeFarmaciaId);
        }
        window.location.href = '/';
      } catch (err) {
        showError('Sem ligação ao servidor. Tente novamente.');
      } finally {
        submitBtn.disabled = false;
      }
    });

    passkeyBtn.addEventListener('click', async () => {
      errorBox.style.display = 'none';
      passkeyBtn.disabled = true;

      try {
        const email = document.getElementById('email').value.trim();
        const optRes = await fetch('/api/auth/passkey/login-options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email || undefined }),
        });
        const options = await optRes.json();

        if (!optRes.ok) {
          showError(options.error || 'Erro ao iniciar autenticação Passkey.');
          return;
        }

        // Decodificar challenge base64url para Uint8Array
        options.challenge = Uint8Array.from(atob(options.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        if (options.allowCredentials) {
          for (const cred of options.allowCredentials) {
            cred.id = Uint8Array.from(atob(cred.id.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
          }
        }

        const credential = await navigator.credentials.get({ publicKey: options });
        if (!credential) {
          showError('Autenticação com Passkey cancelada.');
          return;
        }

        const verifyRes = await fetch('/api/auth/passkey/login-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            response: {
              id: credential.id,
              rawId: btoa(String.fromCharCode(...new Uint8Array(credential.rawId))),
              type: credential.type,
              response: {
                clientDataJSON: btoa(String.fromCharCode(...new Uint8Array(credential.response.clientDataJSON))),
                authenticatorData: btoa(String.fromCharCode(...new Uint8Array(credential.response.authenticatorData))),
                signature: btoa(String.fromCharCode(...new Uint8Array(credential.response.signature))),
                userHandle: credential.response.userHandle ? btoa(String.fromCharCode(...new Uint8Array(credential.response.userHandle))) : null,
              },
            },
          }),
        });

        const vData = await verifyRes.json();
        if (!verifyRes.ok || !vData.ok) {
          showError(vData.error || 'Falha na validação biométrica.');
          return;
        }

        if (vData.activeFarmaciaId) {
          sessionStorage.setItem('bi_pharma_active_farmacia_id', vData.activeFarmaciaId);
        }
        window.location.href = '/';
      } catch (err) {
        showError('Passkey não disponível ou cancelada neste dispositivo.');
      } finally {
        passkeyBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
