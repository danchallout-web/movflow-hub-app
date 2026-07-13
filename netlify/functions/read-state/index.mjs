/**
 * MovFlow Hub — Read State Registry (sync entre dispositivos)
 * /.netlify/functions/read-state
 * GET  → { read:[...uids] }   estado leído compartido
 * POST { read:[...], unread:[...] }  aplica cambios (añade a read, quita de read)
 * Fuente única de verdad para leído/no-leído en Netlify Blobs.
 */
import { getStore } from '@netlify/blobs';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const store = getStore({ name: 'read-state', consistency: 'strong' });

  const loadSet = async () => {
    try { return new Set(JSON.parse(await store.get('read') || '[]').map(String)); }
    catch { return new Set(); }
  };

  if (req.method === 'GET') {
    const set = await loadSet();
    return new Response(JSON.stringify({ ok: true, read: [...set] }), { status: 200, headers: CORS });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch(_) {}
    const addRead    = Array.isArray(body.read)   ? body.read.map(String)   : [];
    const addUnread  = Array.isArray(body.unread) ? body.unread.map(String) : [];
    if (!addRead.length && !addUnread.length)
      return new Response(JSON.stringify({ ok: false, error: 'read o unread requerido' }), { status: 400, headers: CORS });
    const set = await loadSet();
    addRead.forEach(u => set.add(u));
    addUnread.forEach(u => set.delete(u));
    await store.set('read', JSON.stringify([...set]));
    return new Response(JSON.stringify({ ok: true, total: set.size }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: false, error: 'Método no soportado' }), { status: 405, headers: CORS });
};

export const config = { path: '/.netlify/functions/read-state' };
