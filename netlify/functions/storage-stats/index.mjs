/**
 * MovFlow Hub — Storage Stats
 * /.netlify/functions/storage-stats
 */
import { getStore } from '@netlify/blobs';
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    const store = getStore({ name: 'movflow-attachments', consistency: 'strong' });
    const { blobs } = await store.list();
    let attachmentCount = 0, attachmentBytes = 0;
    for (const b of blobs) {
      if (b.key.startsWith('binary:')) { attachmentCount++; if (b.size) attachmentBytes += b.size; }
    }
    return new Response(JSON.stringify({ blobCount: blobs.length, attachmentCount, attachmentBytes }), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, blobCount: 0, attachmentCount: 0, attachmentBytes: 0 }), { status: 500, headers: CORS });
  }
};
export const config = { path: '/.netlify/functions/storage-stats' };
