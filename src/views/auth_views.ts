/**
 * Ecrãs de Autenticação da Fase 2 (Spec v2.1)
 *  - /accept-invite: Aceitar convite e definir password inicial (+ PIN opcional se balcão)
 *  - /forgot-password: Pedir recuperação de password por email (validade 15 min)
 *  - /reset-password: Definir nova password com token opaco (validade 15 min)
 *
 * Requisitos de Segurança:
 *  - Referrer-Policy: no-referrer (meta tag e cabeçalho HTTP)
 *  - Remoção imediata do token da barra de endereço via history.replaceState
 *  - Política de password: min 10 caracteres, sem regras forçadas de composição
 *  - Zero recursos externos (sem Google Fonts ou CDNs terceiros)
 */

export function getAcceptInviteHtml(nonce?: string): string {
  const nonceAttr = nonce ? `nonce="${nonce}"` : '';
  return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <title>BI Pharma — Ativação de Conta</title>
  <style>
    :root { --bg: #f8fafc; --surface: #ffffff; --text: #0f172a; --muted: #64748b; --primary: #0284c7; --primary-dark: #0369a1; --danger: #dc2626; --success: #16a34a; --border: #e2e8f0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 32px; width: 100%; max-width: 440px; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08); }
    .brand { font-size: 1.35rem; font-weight: 800; color: var(--primary-dark); margin-bottom: 4px; }
    .subtitle { font-size: 0.88rem; color: var(--muted); margin-bottom: 24px; }
    label { display: block; font-size: 0.82rem; font-weight: 700; margin-bottom: 6px; color: #334155; }
    input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; margin-bottom: 16px; outline: none; }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15); }
    button { width: 100%; padding: 11px; border: none; border-radius: 8px; background: var(--primary); color: #fff; font-size: 0.95rem; font-weight: 700; cursor: pointer; }
    button:hover { background: var(--primary-dark); }
    button:disabled { opacity: 0.65; cursor: not-allowed; }
    .error { background: #fef2f2; color: var(--danger); border: 1px solid #fecaca; padding: 10px 12px; border-radius: 8px; font-size: 0.84rem; margin-bottom: 16px; display: none; line-height: 1.4; }
    .success { background: #f0fdf4; color: var(--success); border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; font-size: 0.88rem; margin-bottom: 16px; display: none; }
    .hint { font-size: 0.78rem; color: var(--muted); margin-top: -12px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">BI Pharma</div>
    <div class="subtitle">Ativação de Conta e Acesso</div>

    <div id="errorBox" class="error"></div>
    <div id="successBox" class="success"></div>

    <form id="inviteForm">
      <label for="nome">O seu Nome Completo</label>
      <input id="nome" name="nome" type="text" placeholder="Dr. António Silva" />

      <label for="password">Palavra-passe (Mínimo 10 caracteres)</label>
      <input id="password" name="password" type="password" required minlength="10" placeholder="••••••••••" />
      <div class="hint">Pelo menos 10 caracteres. Evite palavras comuns ou o seu nome.</div>

      <label for="confirmPassword">Confirmar Palavra-passe</label>
      <input id="confirmPassword" name="confirmPassword" type="password" required minlength="10" placeholder="Repita a palavra-passe" />

      <label for="pin">PIN de Balcão (Opcional — 4 a 6 dígitos)</label>
      <input id="pin" name="pin" type="password" inputmode="numeric" maxlength="6" pattern="[0-9]{4,6}" placeholder="PIN rápido para tablet" />
      <div class="hint">Evite sequências óbvias como 1234, 0000 ou 9876.</div>

      <button id="submitBtn" type="submit">Ativar Conta e Entrar</button>
    </form>
  </main>

  <script ${nonceAttr}>
    const form = document.getElementById('inviteForm');
    const errBox = document.getElementById('errorBox');
    const succBox = document.getElementById('successBox');
    const submitBtn = document.getElementById('submitBtn');

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';

    // Remove imediatamente o token da barra de endereço para proteger contra fugas de URL
    if (token && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!token) {
      errBox.textContent = 'Token de convite em falta ou link incompleto.';
      errBox.style.display = 'block';
      submitBtn.disabled = true;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.style.display = 'none';

      const pwd = document.getElementById('password').value;
      const conf = document.getElementById('confirmPassword').value;
      const nome = document.getElementById('nome').value.trim();
      const pin = document.getElementById('pin').value.trim();

      if (pwd !== conf) {
        errBox.textContent = 'As palavras-passe não coincidem.';
        errBox.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'A ativar conta...';

      try {
        const res = await fetch('/api/auth/accept-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password: pwd, nome, pin: pin || undefined }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (data.requiresLogin) {
            errBox.innerHTML = data.error + '<br/><br/><a href="/login" style="color:var(--primary);font-weight:700;">→ Iniciar Sessão com a Conta Existente</a>';
          } else {
            errBox.textContent = data.error || 'Falha ao ativar conta.';
          }
          errBox.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Ativar Conta e Entrar';
          return;
        }

        succBox.textContent = 'Conta ativada com sucesso! A redirecionar para o painel...';
        succBox.style.display = 'block';
        form.style.display = 'none';

        setTimeout(() => {
          window.location.href = '/';
        }, 1500);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Ativar Conta e Entrar';
      }
    });
  </script>
</body>
</html>`;
}

export function getForgotPasswordHtml(nonce?: string): string {
  const nonceAttr = nonce ? `nonce="${nonce}"` : '';
  return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <title>BI Pharma — Recuperar Palavra-passe</title>
  <style>
    :root { --bg: #f8fafc; --surface: #ffffff; --text: #0f172a; --muted: #64748b; --primary: #0284c7; --primary-dark: #0369a1; --danger: #dc2626; --success: #16a34a; --border: #e2e8f0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 32px; width: 100%; max-width: 400px; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08); }
    .brand { font-size: 1.35rem; font-weight: 800; color: var(--primary-dark); margin-bottom: 4px; }
    .subtitle { font-size: 0.88rem; color: var(--muted); margin-bottom: 24px; }
    label { display: block; font-size: 0.82rem; font-weight: 700; margin-bottom: 6px; color: #334155; }
    input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; margin-bottom: 16px; outline: none; }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15); }
    button { width: 100%; padding: 11px; border: none; border-radius: 8px; background: var(--primary); color: #fff; font-size: 0.95rem; font-weight: 700; cursor: pointer; }
    button:hover { background: var(--primary-dark); }
    button:disabled { opacity: 0.65; cursor: not-allowed; }
    .error { background: #fef2f2; color: var(--danger); border: 1px solid #fecaca; padding: 10px 12px; border-radius: 8px; font-size: 0.84rem; margin-bottom: 16px; display: none; }
    .success { background: #f0fdf4; color: var(--success); border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; font-size: 0.88rem; margin-bottom: 16px; display: none; line-height: 1.5; }
    .hint { font-size: 0.78rem; color: var(--muted); margin-top: -10px; margin-bottom: 16px; }
    .links { margin-top: 18px; text-align: center; font-size: 0.84rem; }
    .links a { color: var(--primary); text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">BI Pharma</div>
    <div class="subtitle">Recuperação de Acesso</div>

    <div id="errorBox" class="error"></div>
    <div id="successBox" class="success"></div>

    <form id="forgotForm">
      <label for="email">Email da sua Conta</label>
      <input id="email" name="email" type="email" required placeholder="nome@farmacia.pt" />
      <div class="hint">O link enviado por email expira em 15 minutos e só pode ser utilizado uma vez.</div>

      <button id="submitBtn" type="submit">Enviar Link de Recuperação</button>
    </form>

    <div class="links">
      <a href="/login">Voltar ao Início de Sessão</a>
    </div>
  </main>

  <script ${nonceAttr}>
    const form = document.getElementById('forgotForm');
    const errBox = document.getElementById('errorBox');
    const succBox = document.getElementById('successBox');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.style.display = 'none';
      succBox.style.display = 'none';
      submitBtn.disabled = true;

      const email = document.getElementById('email').value.trim();

      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        succBox.textContent = data.message || 'Se o endereço estiver registado, enviámos as instruções.';
        succBox.style.display = 'block';
        form.style.display = 'none';
      } catch (err) {
        errBox.textContent = 'Erro ao processar o pedido. Tente novamente.';
        errBox.style.display = 'block';
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export function getResetPasswordHtml(nonce?: string): string {
  const nonceAttr = nonce ? `nonce="${nonce}"` : '';
  return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <title>BI Pharma — Redefinir Palavra-passe</title>
  <style>
    :root { --bg: #f8fafc; --surface: #ffffff; --text: #0f172a; --muted: #64748b; --primary: #0284c7; --primary-dark: #0369a1; --danger: #dc2626; --success: #16a34a; --border: #e2e8f0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 32px; width: 100%; max-width: 400px; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08); }
    .brand { font-size: 1.35rem; font-weight: 800; color: var(--primary-dark); margin-bottom: 4px; }
    .subtitle { font-size: 0.88rem; color: var(--muted); margin-bottom: 24px; }
    label { display: block; font-size: 0.82rem; font-weight: 700; margin-bottom: 6px; color: #334155; }
    input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; margin-bottom: 16px; outline: none; }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15); }
    button { width: 100%; padding: 11px; border: none; border-radius: 8px; background: var(--primary); color: #fff; font-size: 0.95rem; font-weight: 700; cursor: pointer; }
    button:hover { background: var(--primary-dark); }
    button:disabled { opacity: 0.65; cursor: not-allowed; }
    .error { background: #fef2f2; color: var(--danger); border: 1px solid #fecaca; padding: 10px 12px; border-radius: 8px; font-size: 0.84rem; margin-bottom: 16px; display: none; }
    .success { background: #f0fdf4; color: var(--success); border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; font-size: 0.88rem; margin-bottom: 16px; display: none; }
    .hint { font-size: 0.78rem; color: var(--muted); margin-top: -12px; margin-bottom: 14px; }
    .links { margin-top: 18px; text-align: center; font-size: 0.84rem; }
    .links a { color: var(--primary); text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">BI Pharma</div>
    <div class="subtitle">Definição de Nova Palavra-passe</div>

    <div id="errorBox" class="error"></div>
    <div id="successBox" class="success"></div>

    <form id="resetForm">
      <label for="password">Nova Palavra-passe (Mínimo 10 caracteres)</label>
      <input id="password" name="password" type="password" required minlength="10" placeholder="••••••••••" />
      <div class="hint">Pelo menos 10 caracteres. Evite palavras comuns ou o seu nome.</div>

      <label for="confirmPassword">Confirmar Palavra-passe</label>
      <input id="confirmPassword" name="confirmPassword" type="password" required minlength="10" placeholder="••••••••••" />

      <button id="submitBtn" type="submit">Guardar Palavra-passe</button>
    </form>

    <div class="links">
      <a href="/login">Voltar ao Início de Sessão</a>
    </div>
  </main>

  <script ${nonceAttr}>
    const form = document.getElementById('resetForm');
    const errBox = document.getElementById('errorBox');
    const succBox = document.getElementById('successBox');
    const submitBtn = document.getElementById('submitBtn');

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';

    // Remove imediatamente o token da barra de endereço para proteger contra histórico e logs
    if (token && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!token) {
      errBox.textContent = 'Link de recuperação inválido ou token em falta.';
      errBox.style.display = 'block';
      submitBtn.disabled = true;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.style.display = 'none';

      const pwd = document.getElementById('password').value;
      const conf = document.getElementById('confirmPassword').value;

      if (pwd !== conf) {
        errBox.textContent = 'As palavras-passe não coincidem.';
        errBox.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'A guardar...';

      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, newPassword: pwd }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Erro ao redefinir palavra-passe.');
        }

        succBox.textContent = 'Palavra-passe atualizada com sucesso! A redirecionar para o login...';
        succBox.style.display = 'block';
        form.style.display = 'none';

        setTimeout(() => {
          window.location.href = '/login';
        }, 2000);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Guardar Palavra-passe';
      }
    });
  </script>
</body>
</html>`;
}
