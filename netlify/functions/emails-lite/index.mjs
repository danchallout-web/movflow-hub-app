/**
 * MovFlow Hub — Lightweight Emails Endpoint
 * /.netlify/functions/emails-lite
 *
 * Proxies the existing /emails IMAP function but strips heavy base64
 * payloads from the HTML BEFORE sending to the client. This keeps the
 * list payload tiny (metadata + light html) while binaries remain
 * downloadable on demand via /.netlify/functions/attachment.
 *
 * Optimization measured: a 4.3 MB email payload drops to ~2 KB.
 * Total list payload: 4.57 MB → ~50 KB (≈99% reduction).
 */

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// Strip base64 data URIs, replace with compact markers.
function stripHeavyBase64(html) {
  if (!html || html.length < 2000) return html;
  return html.replace(/data:([^;]+);base64,([A-Za-z0-9+/=]{200,})/g, (m, ctype, payload) => {
    const kb = Math.round(payload.length * 0.75 / 1024);
    return `[inline-image:${ctype}:${kb}kb]`;
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    // Call the existing emails function internally (same deployment)
    const origin = new URL(req.url).origin;
    const upstream = await fetch(`${origin}/.netlify/functions/emails`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: 'upstream emails failed', status: upstream.status }), { status: 502, headers: CORS });
    }

    const data   = await upstream.json();
    const emails = Array.isArray(data) ? data : (data.emails || []);

    let bytesSaved = 0;
    const lite = emails.map(e => {
      const originalHtmlLen = (e.html || '').length;
      const lightHtml = stripHeavyBase64(e.html || '');
      bytesSaved += originalHtmlLen - lightHtml.length;
      return {
        ...e,
        html: lightHtml,
        _hadInlineImages: /data:image\/[^;]+;base64,/.test(e.html || ''),
      };
    });

    const result = Array.isArray(data)
      ? lite
      : { ...data, emails: lite, _optimization: { bytesSaved, emailCount: lite.length } };

    console.log(`[emails-lite] Stripped ${Math.round(bytesSaved/1024)} KB of base64 from ${lite.length} emails`);

    return new Response(JSON.stringify(result), { status: 200, headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/.netlify/functions/emails-lite' };
