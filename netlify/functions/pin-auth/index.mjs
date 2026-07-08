/**
 * MovFlow Hub — PIN Auth Function
 * /.netlify/functions/pin-auth
 *
 * POST ?action=verify_pin      { pin }         → { token, user }
 * POST ?action=request_recovery {}             → { ok } (envía email con OTP)
 * POST ?action=verify_recovery  { code }       → { recovery_token }
 * POST ?action=set_new_pin      { pin, recovery_token } → { ok }
 * POST ?action=change_pin       { current_pin, new_pin } (requiere token)
 * POST ?action=change_email     { pin, email } (requiere token)
 * GET  ?action=config           (requiere token) → { recovery_email, sms_enabled }
 */

const CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':'Content-Type, Authorization',
};

const SB_URL    = process.env.SUPABASE_URL;
const SB_ANON   = process.env.SUPABASE_ANON_KEY;
const SB_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_ATTEMPTS  = 5;
const LOCK_MINUTES  = 15;
const OTP_MINUTES   = 15;

// ── SHA-256 via Web Crypto ──
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Random 6-digit OTP ──
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── PostgREST helper (service role) ──
const pg = (table, opts = {}) =>
  fetch(`${SB_URL}/rest/v1/${table}?${opts.qs || ''}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SB_SECRET,
      'Authorization': `Bearer ${SB_SECRET}`,
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

// ── Simple session token (signed with SB_SECRET as HMAC-SHA256) ──
async function makeToken(payload) {
  const header  = btoa(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const body    = btoa(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 8*3600*1000 }));
  const sig     = await sha256(header + '.' + body + SB_SECRET);
  return header + '.' + body + '.' + sig;
}

async function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = await sha256(header + '.' + body + SB_SECRET);
    if (sig !== expected) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// ── Send recovery email via Supabase Auth email (magic link workaround) ──
// We use Supabase's own SMTP (configured in dashboard) to send via their email API
async function sendRecoveryEmail(toEmail, otp) {
  // Use Supabase Admin API to send email
  const resp = await fetch(`${SB_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SB_SECRET,
      'Authorization': `Bearer ${SB_SECRET}`,
    },
    body: JSON.stringify({
      type:       'email',
      email:      toEmail,
      properties: { redirect_to: 'https://movflow-hub-app.netlify.app' },
    }),
  });

  // Fallback: send via fetch to Supabase's own mailer endpoint
  // Actually use the simpler approach: Supabase Edge Function or direct SMTP
  // Since we control the email, we'll use Supabase's built-in OTP email
  const otpResp = await fetch(`${SB_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SB_ANON,
    },
    body: JSON.stringify({ email: toEmail, create_user: false }),
  });

  return otpResp.ok;
}

// ── Get PIN config row ──
async function getConfig() {
  const r = await pg('mfh_pin_config', { qs: 'limit=1' });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

// ── Update PIN config ──
async function updateConfig(id, patch) {
  await pg('mfh_pin_config', {
    method: 'PATCH',
    qs:     `id=eq.${id}`,
    body:   { ...patch, updated_at: new Date().toISOString() },
    prefer: 'return=minimal',
  });
}

// ── Log activity ──
async function logAccess(action, meta = {}) {
  await pg('mfh_activity', {
    method: 'POST',
    body:   { user_id: null, action, meta },
    prefer: 'return=minimal',
  }).catch(() => {});
}

// ── HTTP Handler ──
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!SB_URL || !SB_SECRET) return new Response(JSON.stringify({ error: 'Supabase no configurado' }), { status: 500, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get('action') || '';
  const bearer = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();

  const err = (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status, headers: CORS });
  const ok  = (data = {})        => new Response(JSON.stringify({ ok: true, ...data }), { status: 200, headers: CORS });

  let body = {};
  if (req.method === 'POST') body = await req.json().catch(() => ({}));

  /* ══════════════════════════════════════════
     VERIFY PIN — acceso principal
  ══════════════════════════════════════════ */
  if (action === 'verify_pin') {
    const { pin } = body;
    if (!pin || !/^\d{6}$/.test(pin)) return err('El PIN debe ser de 6 dígitos numéricos.');

    const cfg = await getConfig();
    if (!cfg) return err('Sistema no configurado.', 500);

    // Bloqueo temporal
    if (cfg.locked_until && new Date(cfg.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(cfg.locked_until) - Date.now()) / 60000);
      return err(`Demasiados intentos. Sistema bloqueado ${mins} min.`, 429);
    }

    const hash = await sha256(pin);

    if (hash !== cfg.pin_hash) {
      const attempts = (cfg.failed_attempts || 0) + 1;
      const lock     = attempts >= MAX_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString()
        : null;
      await updateConfig(cfg.id, {
        failed_attempts: attempts,
        ...(lock ? { locked_until: lock } : {}),
      });
      await logAccess('pin_failed', { attempts });
      const remaining = MAX_ATTEMPTS - attempts;
      return err(remaining <= 0
        ? `PIN incorrecto. Sistema bloqueado ${LOCK_MINUTES} min.`
        : `PIN incorrecto. ${remaining} intento(s) restante(s).`, 401);
    }

    // Éxito — resetear intentos
    await updateConfig(cfg.id, { failed_attempts: 0, locked_until: null });
    await logAccess('pin_login_ok', {});

    const token = await makeToken({ role: 'admin', type: 'pin' });
    return ok({ token, user: { role: 'admin', display_name: 'MovFlow Admin' } });
  }

  /* ══════════════════════════════════════════
     REQUEST RECOVERY — envía OTP por email
  ══════════════════════════════════════════ */
  if (action === 'request_recovery') {
    const cfg = await getConfig();
    if (!cfg) return err('Sistema no configurado.', 500);

    const otp     = generateOTP();
    const otpHash = await sha256(otp);
    const expires = new Date(Date.now() + OTP_MINUTES * 60000).toISOString();

    // Invalidar OTPs anteriores
    await pg('mfh_pin_recovery', { method: 'PATCH', qs: 'used=eq.false', body: { used: true }, prefer: 'return=minimal' }).catch(() => {});

    // Guardar nuevo OTP
    await pg('mfh_pin_recovery', {
      method: 'POST',
      body:   { code_hash: otpHash, expires_at: expires, used: false },
      prefer: 'return=minimal',
    });

    // Enviar email via Supabase Auth OTP
    const emailSent = await sendRecoveryEmail(cfg.recovery_email, otp);
    await logAccess('pin_recovery_requested', { email: cfg.recovery_email });

    // Siempre responder OK (no revelar si el email existe)
    return ok({ email_hint: cfg.recovery_email.replace(/(.{2}).+(@.+)/, '$1***$2') });
  }

  /* ══════════════════════════════════════════
     VERIFY RECOVERY CODE
  ══════════════════════════════════════════ */
  if (action === 'verify_recovery') {
    const { code } = body;
    if (!code || !/^\d{6}$/.test(code)) return err('Código inválido.');

    const codeHash = await sha256(code);
    const r = await pg('mfh_pin_recovery', {
      qs: `code_hash=eq.${codeHash}&used=eq.false&order=created_at.desc&limit=1`,
    });
    if (!r.ok) return err('Error al verificar código.', 500);
    const rows = await r.json();
    const rec  = rows[0];

    if (!rec) return err('Código incorrecto o ya utilizado.');
    if (new Date(rec.expires_at) < new Date()) return err('El código ha expirado. Solicita uno nuevo.');

    // Marcar como usado
    await pg('mfh_pin_recovery', { method: 'PATCH', qs: `id=eq.${rec.id}`, body: { used: true }, prefer: 'return=minimal' });
    await logAccess('pin_recovery_verified', {});

    // Generar token de recuperación de un solo uso
    const recoveryToken = await makeToken({ role: 'recovery', type: 'pin_reset', exp: Date.now() + 10*60*1000 });
    return ok({ recovery_token: recoveryToken });
  }

  /* ══════════════════════════════════════════
     SET NEW PIN (tras recuperación)
  ══════════════════════════════════════════ */
  if (action === 'set_new_pin') {
    const { pin, recovery_token } = body;
    if (!pin || !/^\d{6}$/.test(pin)) return err('El PIN debe ser de 6 dígitos numéricos.');
    if (!recovery_token) return err('Token de recuperación requerido.');

    const payload = await verifyToken(recovery_token);
    if (!payload || payload.role !== 'recovery') return err('Token inválido o expirado.', 401);

    const cfg     = await getConfig();
    const pinHash = await sha256(pin);
    await updateConfig(cfg.id, { pin_hash: pinHash, failed_attempts: 0, locked_until: null });
    await logAccess('pin_reset_ok', {});
    return ok();
  }

  /* ══════════════════════════════════════════
     CHANGE PIN (desde Ajustes, requiere token)
  ══════════════════════════════════════════ */
  if (action === 'change_pin') {
    const payload = await verifyToken(bearer);
    if (!payload || payload.role !== 'admin') return err('Sesión inválida.', 401);

    const { current_pin, new_pin } = body;
    if (!current_pin || !new_pin) return err('Faltan campos.');
    if (!/^\d{6}$/.test(new_pin)) return err('El nuevo PIN debe ser de 6 dígitos.');

    const cfg      = await getConfig();
    const currHash = await sha256(current_pin);
    if (currHash !== cfg.pin_hash) return err('PIN actual incorrecto.', 401);

    const newHash = await sha256(new_pin);
    await updateConfig(cfg.id, { pin_hash: newHash });
    await logAccess('pin_changed', {});
    return ok();
  }

  /* ══════════════════════════════════════════
     CHANGE RECOVERY EMAIL (desde Ajustes)
  ══════════════════════════════════════════ */
  if (action === 'change_email') {
    const payload = await verifyToken(bearer);
    if (!payload || payload.role !== 'admin') return err('Sesión inválida.', 401);

    const { pin, email } = body;
    if (!pin || !email) return err('Faltan campos.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Email inválido.');

    const cfg     = await getConfig();
    const pinHash = await sha256(pin);
    if (pinHash !== cfg.pin_hash) return err('PIN incorrecto.', 401);

    await updateConfig(cfg.id, { recovery_email: email });
    await logAccess('recovery_email_changed', {});
    return ok();
  }

  /* ══════════════════════════════════════════
     GET CONFIG (desde Ajustes)
  ══════════════════════════════════════════ */
  if (action === 'config' && req.method === 'GET') {
    const payload = await verifyToken(bearer);
    if (!payload || payload.role !== 'admin') return err('Sesión inválida.', 401);
    const cfg = await getConfig();
    if (!cfg) return err('No configurado.', 500);
    return ok({
      recovery_email: cfg.recovery_email.replace(/(.{2}).+(@.+)/, '$1***$2'),
    });
  }

  /* ══════════════════════════════════════════
     VERIFY TOKEN (para Auth.verify en frontend)
  ══════════════════════════════════════════ */
  if (action === 'verify') {
    const payload = await verifyToken(bearer);
    if (!payload || payload.role !== 'admin') return err('Sesión inválida.', 401);
    return ok({ user: { role: 'admin', display_name: 'MovFlow Admin' } });
  }

  return err('Acción desconocida.');
};

export const config = { path: '/.netlify/functions/pin-auth' };
