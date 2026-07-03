/**
 * MovFlow Hub — Folders Function (minimal)
 * The frontend builds sender-based folders client-side from emails,
 * so this returns an empty set and the client falls back to buildFoldersFromEmails().
 */
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  return new Response(JSON.stringify({ folders: [] }), { status: 200, headers: CORS });
};
export const config = { path: '/.netlify/functions/folders' };
