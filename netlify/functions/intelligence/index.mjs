const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  return new Response(JSON.stringify({ ok: true, note: 'intelligence stub' }), { status: 200, headers: CORS });
};
export const config = { path: '/.netlify/functions/intelligence' };
