/**
 * MovFlow Hub — Registro de estados de email (sync entre dispositivos)
 * /.netlify/functions/deleted-emails
 *
 * Estados diferenciados (punto 4):
 *   - uids   → borrados PERMANENTEMENTE (no reaparecen nunca)
 *   - trash  → en PAPELERA (recuperables 30 días, sincronizados entre dispositivos)
 *
 * GET  → { uids:[...], trash:[...] }
 * POST { uids:[...] }                    añade a permanentes
 * POST { trash:[...], untrash:[...] }    añade/quita de papelera
 *
 * Fuente única de verdad en Netlify Blobs.
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

  const load = async (k) => { try { return JSON.parse(await store.get(k) || '[]').map(String); } catch { return []; } };

  if (req.method === 'GET') {
    const [uids, trash] = await Promise.all([load('uids'), load('trash')]);
    return new Response(JSON.stringify({ ok: true, uids, trash }), { status: 200, headers: CORS });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch(_) {}

    // Borrados permanentes
    const addPerm = Array.isArray(body.uids) ? body.uids.map(String) : [];
    // Papelera: añadir / quitar
    const addTrash = Array.isArray(body.trash) ? body.trash.map(String) : [];
    const rmTrash  = Array.isArray(body.untrash) ? body.untrash.map(String) : [];

    if (!addPerm.length && !addTrash.length && !rmTrash.length)
      return new Response(JSON.stringify({ ok: false, error: 'Nada que actualizar' }), { status: 400, headers: CORS });

    if (addPerm.length) {
      const set = new Set(await load('uids'));
      addPerm.forEach(u => set.add(u));
      // Un email permanentemente borrado sale de la papelera
      const trashSet = new Set(await load('trash'));
      addPerm.forEach(u => trashSet.delete(u));
      await store.set('uids', JSON.stringify([...set]));
      await store.set('trash', JSON.stringify([...trashSet]));
    }

    if (addTrash.length || rmTrash.length) {
      const set = new Set(await load('trash'));
      addTrash.forEach(u => set.add(u));
      rmTrash.forEach(u => set.delete(u));
      await store.set('trash', JSON.stringify([...set]));
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: false, error: 'Método no soportado' }), { status: 405, headers: CORS });
};

export const config = { path: '/.netlify/functions/deleted-emails' };
