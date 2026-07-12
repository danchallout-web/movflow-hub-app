/**
 * MovFlow Hub — Deleted Emails Registry
 * /.netlify/functions/deleted-emails
 * GET  → { uids:[...] }   lista de UIDs borrados definitivamente
 * POST { uids:[...] }     añade UIDs al registro (Netlify Blobs, persistente)
 */
import { getStore } from '@netlify/blobs';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const store = getStore({ name: 'deleted-emails', consistency: 'strong' });

  if (req.method === 'GET') {
    let uids = [];
    try { uids = JSON.parse(await store.get('uids') || '[]'); } catch(_) {}
    return new Response(JSON.stringify({ ok: true, uids }), { status: 200, headers: CORS });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch(_) {}
    const add = Array.isArray(body.uids) ? body.uids.map(String) : [];
    if (!add.length) return new Response(JSON.stringify({ ok: false, error: 'uids requerido' }), { status: 400, headers: CORS });
    let uids = [];
    try { uids = JSON.parse(await store.get('uids') || '[]'); } catch(_) {}
    const set = new Set(uids.map(String));
    add.forEach(u => set.add(u));
    await store.set('uids', JSON.stringify([...set]));
    return new Response(JSON.stringify({ ok: true, total: set.size }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: false, error: 'Método no soportado' }), { status: 405, headers: CORS });
};

export const config = { path: '/.netlify/functions/deleted-emails' };
