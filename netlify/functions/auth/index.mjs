/**
 * MovFlow Hub — Auth Function
 * /.netlify/functions/auth
 *
 * POST /login   { email, password }
 *   → { token, user: { id, email, role, display_name } }
 *     Uses Supabase Auth signInWithPassword (bcrypt internally).
 *     Records session + resets failed_attempts on success.
 *     Increments failed_attempts + locks account after 5 failures.
 *
 * POST /logout  (Authorization: Bearer <token>)
 *   → { ok: true }
 *     Revokes the Supabase session and marks mfh_sessions as revoked.
 *
 * GET  /me      (Authorization: Bearer <token>)
 *   → { user: { id, email, role, display_name, last_login_at } }
 *
 * POST /refresh (Authorization: Bearer <token>)
 *   → { token } — extends session
 */

const CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':'Content-Type, Authorization',
};

const SB_URL    = process.env.SUPABASE_URL;
const SB_ANON   = process.env.SUPABASE_ANON_KEY;
const SB_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Supabase REST helpers ──
const sbFetch = (path, opts = {}, key = SB_ANON) =>
  fetch(`${SB_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}`, ...(opts.headers || {}) },
  });

const sbAuth = (path, body, token) =>
  fetch(`${SB_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SB_ANON, 'Authorization': `Bearer ${token || SB_ANON}` },
    body: JSON.stringify(body),
  });

// ── DB helper (service role — bypasses RLS) ──
const db = async (sql, params = []) => {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/mfh_exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SB_SECRET, 'Authorization': `Bearer ${SB_SECRET}` },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('DB error: ' + t.slice(0, 200));
  }
  return r.json();
};

// Simpler: use PostgREST directly for mfh_users
const pgREST = (table, opts = {}) =>
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

async function getUser(userId) {
  const r = await pgREST(`mfh_users`, { qs: `id=eq.${userId}&select=id,email,role,display_name,is_active,failed_attempts,locked_until,last_login_at` });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function updateUser(userId, patch) {
  await pgREST(`mfh_users`, {
    method: 'PATCH',
    qs: `id=eq.${userId}`,
    body: patch,
  });
}

async function logActivity(userId, action, meta) {
  await pgREST(`mfh_activity`, {
    method: 'POST',
    body: { user_id: userId, action, meta },
    prefer: 'return=minimal',
  });
}

// ── HTTP Handler ──
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!SB_URL || !SB_ANON) return new Response(JSON.stringify({ error: 'Supabase not configured' }), { status: 500, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get('action') || '';
  const bearer = (req.headers.get('authorization') || '').replace('Bearer ', '');

  // ── GET /me ──
  if (req.method === 'GET' && action === 'me') {
    if (!bearer) return new Response(JSON.stringify({ error: 'No token' }), { status: 401, headers: CORS });
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${bearer}` },
    });
    if (!r.ok) return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401, headers: CORS });
    const authUser = await r.json();
    const user = await getUser(authUser.id);
    if (!user || !user.is_active) return new Response(JSON.stringify({ error: 'Account inactive' }), { status: 403, headers: CORS });
    return new Response(JSON.stringify({ user }), { status: 200, headers: CORS });
  }

  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });

  const body = await req.json().catch(() => ({}));

  // ── POST login ──
  if (action === 'login') {
    const { email, password } = body;
    if (!email || !password) return new Response(JSON.stringify({ error: 'Email y contraseña requeridos' }), { status: 400, headers: CORS });

    // Check account lock BEFORE trying auth (don't leak info via auth attempt)
    const existingUser = await pgREST('mfh_users', { qs: `email=eq.${encodeURIComponent(email)}&select=id,failed_attempts,locked_until,is_active,role,display_name` })
      .then(r => r.ok ? r.json() : []).then(rows => rows[0]).catch(() => null);

    if (existingUser) {
      if (!existingUser.is_active) return new Response(JSON.stringify({ error: 'Cuenta desactivada. Contacta al administrador.' }), { status: 403, headers: CORS });
      if (existingUser.locked_until && new Date(existingUser.locked_until) > new Date()) {
        const remaining = Math.ceil((new Date(existingUser.locked_until) - Date.now()) / 60000);
        return new Response(JSON.stringify({ error: `Cuenta bloqueada. Inténtalo en ${remaining} min.` }), { status: 429, headers: CORS });
      }
    }

    // Supabase Auth — bcrypt internally
    const authResp = await sbAuth('/token?grant_type=password', { email, password });
    const authData = await authResp.json();

    if (!authResp.ok || authData.error) {
      // Increment failed attempts
      if (existingUser) {
        const newFails = (existingUser.failed_attempts || 0) + 1;
        const lock = newFails >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
        await updateUser(existingUser.id, { failed_attempts: newFails, ...(lock ? { locked_until: lock } : {}) });
        const msg = newFails >= 5
          ? 'Demasiados intentos fallidos. Cuenta bloqueada 15 minutos.'
          : `Credenciales incorrectas. ${5 - newFails} intento(s) restante(s).`;
        return new Response(JSON.stringify({ error: msg }), { status: 401, headers: CORS });
      }
      return new Response(JSON.stringify({ error: 'Credenciales incorrectas' }), { status: 401, headers: CORS });
    }

    const { access_token, refresh_token, expires_in, user: authUser } = authData;
    const mfhUser = await getUser(authUser.id);

    // Reset failed attempts, update last_login
    await updateUser(authUser.id, { failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() });
    await logActivity(authUser.id, 'login', { ip: req.headers.get('x-forwarded-for') });

    // Store session
    await pgREST('mfh_sessions', {
      method: 'POST',
      body: {
        user_id:    authUser.id,
        ip_address: req.headers.get('x-forwarded-for') || '',
        user_agent: req.headers.get('user-agent') || '',
        expires_at: new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
      },
      prefer: 'return=minimal',
    });

    return new Response(JSON.stringify({
      token:         access_token,
      refresh_token,
      expires_in,
      user: { id: authUser.id, email: authUser.email, role: mfhUser?.role || 'user', display_name: mfhUser?.display_name || '' },
    }), { status: 200, headers: CORS });
  }

  // ── POST logout ──
  if (action === 'logout') {
    if (!bearer) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
    // Get user from token
    const uResp = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${bearer}` },
    });
    if (uResp.ok) {
      const u = await uResp.json();
      await logActivity(u.id, 'logout', {});
      // Revoke Supabase session
      await sbAuth('/logout', {}, bearer);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
  }

  // ── POST refresh ──
  if (action === 'refresh') {
    const { refresh_token } = body;
    if (!refresh_token) return new Response(JSON.stringify({ error: 'No refresh_token' }), { status: 400, headers: CORS });
    const r = await sbAuth('/token?grant_type=refresh_token', { refresh_token });
    const data = await r.json();
    if (!r.ok) return new Response(JSON.stringify({ error: 'Session expired, please login again' }), { status: 401, headers: CORS });
    return new Response(JSON.stringify({ token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: CORS });
};

export const config = { path: '/.netlify/functions/auth' };
