/**
 * MovFlow Hub — Attachment Intelligence (AI analysis)
 * /.netlify/functions/process-attachments
 * Preserved endpoint. Returns stored attachment metadata from Blobs.
 */
import { getStore } from '@netlify/blobs';
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    const store = getStore({ name: 'movflow-attachments', consistency: 'strong' });
    const params = new URL(req.url).searchParams;
    const uid = params.get('uid');
    if (uid) {
      const rec = await store.get(`email-index:${uid}`, { type: 'json' }).catch(() => null);
      return new Response(JSON.stringify(rec || { uid, note: 'no_index' }), { status: 200, headers: CORS });
    }
    return new Response(JSON.stringify({ ok: true, note: 'provide uid' }), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};
export const config = { path: '/.netlify/functions/process-attachments' };
