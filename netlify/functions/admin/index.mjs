/**
 * MovFlow Hub — Admin API
 * /.netlify/functions/admin
 * All endpoints require Authorization: Bearer <token> with role=admin.
 *
 * GET  ?action=users          → list all mfh_users
 * GET  ?action=activity       → recent activity log
 * GET  ?action=stats          → user/session/activity counts
 * POST ?action=create_user    { email, password, display_name, role }
 * POST ?action=update_user    { id, display_name, role, is_active }
 * POST ?action=delete_user    { id }
 * POST ?action=reset_password { id, new_password }
 */

const CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':'Content-Type, Authorization',
};
const SB_URL    = process.env.SUPABASE_URL;
const SB_ANON   = process.env.SUPABASE_ANON_KEY;
const SB_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Verify token and require admin role
async function requireAdmin(token) {
  if (!token) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  const rows = await pgREST('mfh_users', { qs: `id=eq.${u.id}&select=id,role,is_active` }).then(x => x.ok ? x.json() : []).catch(() => []);
  const user = rows[0];
  if (!user || user.role !== 'admin' || !user.is_active) return null;
  return u;
}

// Admin Auth API (user management)
const adminAuthFetch = (path, body) =>
  fetch(`${SB_URL}/auth/v1/admin${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SB_SECRET, 'Authorization': `Bearer ${SB_SECRET}` },
    body: JSON.stringify(body),
  });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!SB_URL || !SB_SECRET) return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500, headers: CORS });

  const token  = (req.headers.get('authorization') || '').replace('Bearer ', '');
  const admin  = await requireAdmin(token);
  if (!admin)  return new Response(JSON.stringify({ error: 'Acceso denegado. Se requiere rol admin.' }), { status: 403, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get('action') || '';

  // ── GET actions ──
  if (req.method === 'GET') {
    if (action === 'users') {
      const r = await pgREST('mfh_users', { qs: 'select=id,email,display_name,role,is_active,created_at,last_login_at,failed_attempts&order=created_at.desc' });
      const users = r.ok ? await r.json() : [];
      return new Response(JSON.stringify({ users }), { status: 200, headers: CORS });
    }
    if (action === 'activity') {
      const r = await pgREST('mfh_activity', { qs: 'select=id,user_id,action,meta,created_at,mfh_users(email,display_name)&order=created_at.desc&limit=100' });
      const activity = r.ok ? await r.json() : [];
      return new Response(JSON.stringify({ activity }), { status: 200, headers: CORS });
    }
    if (action === 'stats') {
      const [uResp, sResp, aResp] = await Promise.all([
        pgREST('mfh_users',    { qs: 'select=id', headers: { 'Prefer': 'count=exact' } }),
        pgREST('mfh_sessions', { qs: 'select=id&revoked=eq.false', headers: { 'Prefer': 'count=exact' } }),
        pgREST('mfh_activity', { qs: 'select=id', headers: { 'Prefer': 'count=exact' } }),
      ]);
      return new Response(JSON.stringify({
        userCount:     parseInt(uResp.headers?.get?.('content-range')?.split('/')[1] || '0'),
        sessionCount:  parseInt(sResp.headers?.get?.('content-range')?.split('/')[1] || '0'),
        activityCount: parseInt(aResp.headers?.get?.('content-range')?.split('/')[1] || '0'),
      }), { status: 200, headers: CORS });
    }
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: CORS });
  }

  // ── POST actions ──
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));

    if (action === 'create_user') {
      const { email, password, display_name, role = 'user' } = body;
      if (!email || !password) return new Response(JSON.stringify({ error: 'Email y contraseña requeridos' }), { status: 400, headers: CORS });
      // Create in Supabase Auth
      const authResp = await fetch(`${SB_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SB_SECRET, 'Authorization': `Bearer ${SB_SECRET}` },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const authData = await authResp.json();
      if (!authResp.ok) return new Response(JSON.stringify({ error: authData.message || 'Error creando usuario' }), { status: 400, headers: CORS });
      // Add to mfh_users
      await pgREST('mfh_users', { method: 'POST', body: { id: authData.id, email, display_name: display_name || email.split('@')[0], role }, prefer: 'return=minimal' });
      return new Response(JSON.stringify({ ok: true, id: authData.id }), { status: 200, headers: CORS });
    }

    if (action === 'update_user') {
      const { id, display_name, role, is_active } = body;
      if (!id) return new Response(JSON.stringify({ error: 'id requerido' }), { status: 400, headers: CORS });
      // Prevent removing last admin
      if (role === 'user') {
        const r = await pgREST('mfh_users', { qs: `role=eq.admin&select=id` });
        const admins = r.ok ? await r.json() : [];
        if (admins.length === 1 && admins[0].id === id) {
          return new Response(JSON.stringify({ error: 'No puedes degradar al último administrador' }), { status: 400, headers: CORS });
        }
      }
      const patch = {};
      if (display_name !== undefined) patch.display_name = display_name;
      if (role          !== undefined) patch.role = role;
      if (is_active     !== undefined) patch.is_active = is_active;
      await pgREST('mfh_users', { method: 'PATCH', qs: `id=eq.${id}`, body: patch, prefer: 'return=minimal' });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
    }

    if (action === 'delete_user') {
      const { id } = body;
      if (!id) return new Response(JSON.stringify({ error: 'id requerido' }), { status: 400, headers: CORS });
      if (id === admin.id) return new Response(JSON.stringify({ error: 'No puedes eliminar tu propia cuenta' }), { status: 400, headers: CORS });
      // Delete from Supabase Auth (cascades to mfh_users via FK)
      await fetch(`${SB_URL}/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { 'apikey': SB_SECRET, 'Authorization': `Bearer ${SB_SECRET}` },
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
    }

    if (action === 'reset_password') {
      const { id, new_password } = body;
      if (!id || !new_password) return new Response(JSON.stringify({ error: 'id y new_password requeridos' }), { status: 400, headers: CORS });
      if (new_password.length < 8) return new Response(JSON.stringify({ error: 'Mínimo 8 caracteres' }), { status: 400, headers: CORS });
      const r = await fetch(`${SB_URL}/auth/v1/admin/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'apikey': SB_SECRET, 'Authorization': `Bearer ${SB_SECRET}` },
        body: JSON.stringify({ password: new_password }),
      });
      if (!r.ok) return new Response(JSON.stringify({ error: 'Error cambiando contraseña' }), { status: 400, headers: CORS });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
};

export const config = { path: '/.netlify/functions/admin' };
