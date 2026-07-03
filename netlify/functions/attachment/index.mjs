/**
 * MovFlow Hub — Attachment Download Function
 * /.netlify/functions/attachment
 * Downloads real attachment binaries from Gmail via IMAP (pure Node TLS).
 */
import tls from 'tls';
import { getStore } from '@netlify/blobs';

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

class ImapClient {
  constructor(user, password) {
    this.user = user; this.password = password;
    this.sock = null; this.buf = ''; this.seq = 0;
    this.pending = new Map(); this.waiting = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('IMAP connect timeout (15s)')), 15000);
      this.sock = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, rejectUnauthorized: false });
      this.sock.setEncoding('binary');
      this.sock.on('error', err => { clearTimeout(to); reject(err); });
      this.sock.on('data', data => { this.buf += data; this._drain(); });
      this._waitUntagged('* OK', () => { clearTimeout(to); resolve(); });
      this._waitUntagged('* BYE', () => { clearTimeout(to); reject(new Error('IMAP BYE')); });
    });
  }
  _waitUntagged(prefix, cb) { this.waiting.push({ prefix, cb }); }
  _drain() {
    const parts = this.buf.split('\r\n');
    this.buf = parts.pop();
    for (const line of parts) this._dispatch(line);
  }
  _dispatch(line) {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (line.startsWith(this.waiting[i].prefix)) {
        const w = this.waiting.splice(i, 1)[0]; w.cb(line);
      }
    }
    for (const [tag, state] of this.pending) {
      if (line.startsWith(tag + ' OK')) { this.pending.delete(tag); state.resolve(state.lines); return; }
      if (line.startsWith(tag + ' NO') || line.startsWith(tag + ' BAD')) {
        this.pending.delete(tag); state.reject(new Error('IMAP: ' + line)); return;
      }
      state.lines.push(line);
    }
  }
  _cmd(command, timeoutMs = 20000) {
    const tag = `T${String(++this.seq).padStart(4, '0')}`;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.pending.delete(tag); reject(new Error('cmd timeout: ' + command.slice(0,40))); }, timeoutMs);
      this.pending.set(tag, {
        lines: [],
        resolve: l => { clearTimeout(to); resolve(l); },
        reject:  e => { clearTimeout(to); reject(e); },
      });
      this.sock.write(`${tag} ${command}\r\n`);
    });
  }
  async login() { await this._cmd(`LOGIN "${this.user}" "${this.password}"`); }
  async select(mb = 'INBOX') { return this._cmd(`SELECT "${mb}"`); }
  async fetchStructure(uid) { return (await this._cmd(`UID FETCH ${uid} (BODYSTRUCTURE)`, 15000)).join('\r\n'); }

  fetchBodyPart(uid, partId, timeoutMs = 25000) {
    const tag = `T${String(++this.seq).padStart(4, '0')}`;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.sock.removeAllListeners('data'); reject(new Error('body fetch timeout')); }, timeoutMs);
      let literalSize = -1, literalRemain = 0, literalChunks = [], preamble = '', inLiteral = false;
      this.sock.removeAllListeners('data');
      this.sock.on('data', chunk => {
        if (!inLiteral) {
          preamble += chunk;
          const m = preamble.match(/\{(\d+)\}\r?\n/);
          if (m) {
            literalSize = parseInt(m[1]); literalRemain = literalSize; inLiteral = true;
            const after = preamble.slice(preamble.indexOf(m[0]) + m[0].length);
            if (after.length > 0) { literalChunks.push(after); literalRemain -= after.length; }
            if (literalRemain <= 0) { inLiteral = false; this._finishBody(tag, to, literalChunks, literalSize, resolve, reject); }
          }
        } else {
          literalChunks.push(chunk); literalRemain -= chunk.length;
          if (literalRemain <= 0) { inLiteral = false; this._finishBody(tag, to, literalChunks, literalSize, resolve, reject); }
        }
      });
      this.sock.write(`${tag} UID FETCH ${uid} (BODY.PEEK[${partId}])\r\n`);
    });
  }
  _finishBody(tag, to, chunks, expectedSize, resolve, reject) {
    clearTimeout(to);
    this.sock.removeAllListeners('data');
    this.sock.on('data', data => { this.buf += data; this._drain(); });
    const raw = chunks.join('');
    // Strip IMAP closing delimiter: find first ) BEFORE removing whitespace
    const parenIdx = raw.indexOf(')');
    const trimmed  = parenIdx > 0 ? raw.slice(0, parenIdx) : raw;
    const b64      = trimmed.replace(/\r\n/g, '').replace(/\r/g, '').replace(/\n/g, '').trim();
    console.log('[IMAP] raw=' + raw.length + ' parenAt=' + parenIdx + ' b64=' + b64.length);
    if (b64.length < 20) { reject(new Error('Empty literal')); return; }
    resolve(b64);
  }
  logout() { try { this.sock.write('T9999 LOGOUT\r\n'); this.sock.destroy(); } catch {} }
}

function parseBodyStructure(raw) {
  const parts = [];
  let partIndex = 2;
  const re = /\("(IMAGE|APPLICATION|TEXT|VIDEO|AUDIO)"[^"]*?"([A-Z0-9\-+]+)"[^(]*\([^)]*"(?:NAME|FILENAME)"[^"]*"([^"]+)"[^)]*\)[^)]*?"BASE64"[^)]*?(\d{3,})/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    parts.push({ partId: String(partIndex++), contentType: `${m[1].toLowerCase()}/${m[2].toLowerCase()}`, filename: m[3], size: parseInt(m[4]) });
  }
  if (!parts.length) {
    const nameRe = /"(?:NAME|FILENAME)"[^"]*?"([^"]{3,})"/gi;
    while ((m = nameRe.exec(raw)) !== null) {
      parts.push({ partId: String(partIndex++), contentType: 'application/octet-stream', filename: m[1], size: 0 });
    }
  }
  return parts;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const user = process.env.GMAIL_USER, password = process.env.GMAIL_APP_PASSWORD;
  if (!user || !password) return new Response(JSON.stringify({ error: 'Missing GMAIL creds' }), { status: 500, headers: CORS });

  const params = new URL(req.url).searchParams;
  const uid = params.get('uid'), filename = params.get('filename');
  const diag = params.get('diag') === '1', partId = params.get('partId');
  const bust = params.get('bust') === '1';
  const raw  = params.get('raw')  === '1';  // serve binary directly (for WhatsApp share links)
  if (!uid) return new Response(JSON.stringify({ error: 'uid required' }), { status: 400, headers: CORS });

  const store = getStore({ name: 'movflow-attachments', consistency: 'strong' });
  const cacheKey = `binary:${uid}:${filename || 'first'}`;

  if (!bust && !diag) {
    try {
      const cached = await store.get(cacheKey, { type: 'json' });
      if (cached) {
        // ?raw=1 → decode base64 and serve as binary file.
        // This URL is shareable: opening it shows the real image/document.
        if (raw && cached.base64 && cached.contentType) {
          const binaryStr = atob(cached.base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          const fname = cached.filename || filename || 'adjunto';
          return new Response(bytes, {
            status: 200,
            headers: {
              'Content-Type':        cached.contentType,
              'Content-Disposition': `inline; filename="${fname}"`,
              'Cache-Control':       'public, max-age=3600',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
        if (!cached.dataUrl && cached.base64) cached.dataUrl = `data:${cached.contentType};base64,${cached.base64}`;
        return new Response(JSON.stringify({ ...cached, cached: true }), { status: 200, headers: CORS });
      }
    } catch {}
  }

  const client = new ImapClient(user, password);
  try {
    await client.connect(); await client.login(); await client.select('INBOX');
    const structRaw = await client.fetchStructure(uid);
    const parts = parseBodyStructure(structRaw);
    if (diag) { client.logout(); return new Response(JSON.stringify({ uid, parts, structRaw: structRaw.slice(0,2000) }), { status: 200, headers: CORS }); }
    if (!parts.length) { client.logout(); return new Response(JSON.stringify({ error: 'No parts', uid, structSample: structRaw.slice(0,500) }), { status: 404, headers: CORS }); }
    const target = filename ? (parts.find(p => p.filename === filename) || parts[0]) : parts[0];
    const b64 = await client.fetchBodyPart(uid, partId || target.partId);
    client.logout();
    const result = {
      uid, partId: partId || target.partId, filename: target.filename,
      contentType: target.contentType, size: target.size || Math.round(b64.length * 0.75),
      base64: b64, dataUrl: `data:${target.contentType};base64,${b64}`,
      cached: false, downloadedAt: new Date().toISOString(),
    };
    try { const tc = { ...result }; delete tc.dataUrl; await store.setJSON(cacheKey, tc); } catch {}
    return new Response(JSON.stringify(result), { status: 200, headers: CORS });
  } catch (err) {
    try { client.logout(); } catch {}
    return new Response(JSON.stringify({ error: err.message, uid, filename }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/.netlify/functions/attachment' };
