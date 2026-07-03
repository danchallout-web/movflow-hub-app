/**
 * MovFlow Hub — Emails Function (IMAP, pure Node TLS)
 * /.netlify/functions/emails
 *
 * Fetches INBOX emails via Gmail IMAP. Correctly parses MIME structure
 * so the user sees the real message text — never raw MIME boundaries,
 * Content-Type headers, or base64 blobs.
 *
 * MIME parsing strategy:
 *   MIXED > ALTERNATIVE > PLAIN  →  BODY.PEEK[1.1]
 *   MIXED > ALTERNATIVE > HTML   →  BODY.PEEK[1.2]  (fallback if no plain)
 *   ALTERNATIVE > PLAIN          →  BODY.PEEK[1]
 *   ALTERNATIVE > HTML           →  BODY.PEEK[2]    (fallback)
 *   Simple PLAIN                 →  BODY.PEEK[1]
 *
 * Encoding handling: 7BIT (pass-through), QUOTED-PRINTABLE (=XX decode),
 *                    BASE64 (atob), 8BIT (pass-through)
 */

import tls from 'tls';

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// ─────────────────────────────────────────────────────────
// IMAP Client — same minimal pure-TLS client as attachment fn
// ─────────────────────────────────────────────────────────
class Imap {
  constructor(u, p) {
    this.u = u; this.p = p;
    this.sock = null; this.buf = ''; this.seq = 0;
    this.pending = new Map(); this.waiting = [];
  }
  connect() {
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('connect timeout')), 15000);
      this.sock = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, rejectUnauthorized: false });
      this.sock.setEncoding('binary');
      this.sock.on('error', e => { clearTimeout(to); rej(e); });
      this.sock.on('data', d => { this.buf += d; this._drain(); });
      this._wait('* OK', () => { clearTimeout(to); res(); });
      this._wait('* BYE', () => { clearTimeout(to); rej(new Error('BYE')); });
    });
  }
  _wait(p, cb) { this.waiting.push({ p, cb }); }
  _drain() {
    const parts = this.buf.split('\r\n');
    this.buf = parts.pop();
    for (const l of parts) this._disp(l);
  }
  _disp(line) {
    for (let i = this.waiting.length - 1; i >= 0; i--)
      if (line.startsWith(this.waiting[i].p)) { const w = this.waiting.splice(i,1)[0]; w.cb(line); }
    for (const [tag, st] of this.pending) {
      if (line.startsWith(tag + ' OK')) { this.pending.delete(tag); st.res(st.lines); return; }
      if (line.startsWith(tag + ' NO') || line.startsWith(tag + ' BAD')) {
        this.pending.delete(tag); st.rej(new Error(line)); return;
      }
      st.lines.push(line);
    }
  }
  cmd(c, ms = 30000) {
    const tag = `T${String(++this.seq).padStart(4,'0')}`;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.pending.delete(tag); rej(new Error('cmd timeout')); }, ms);
      this.pending.set(tag, { lines: [], res: l => { clearTimeout(to); res(l); }, rej: e => { clearTimeout(to); rej(e); } });
      this.sock.write(`${tag} ${c}\r\n`);
    });
  }

  // Fetches a body part that may arrive as a literal {SIZE}\r\n<data>
  fetchLiteral(c, ms = 20000) {
    const tag = `T${String(++this.seq).padStart(4,'0')}`;
    return new Promise((res, rej) => {
      const to = setTimeout(() => {
        this.sock.removeAllListeners('data');
        this._restore();
        rej(new Error('literal timeout'));
      }, ms);

      let size = -1, remain = 0, chunks = [], preamble = '', inLit = false;

      this.sock.removeAllListeners('data');
      this.sock.on('data', chunk => {
        if (!inLit) {
          preamble += chunk;
          const m = preamble.match(/\{(\d+)\}\r?\n/);
          if (m) {
            size = parseInt(m[1]); remain = size; inLit = true;
            const after = preamble.slice(preamble.indexOf(m[0]) + m[0].length);
            if (after) { chunks.push(after); remain -= after.length; }
            if (remain <= 0) { inLit = false; this._done(tag, to, chunks, size, res, rej); }
          }
          // No literal (e.g. NIL response) — check for tagged OK
          if (!inLit && preamble.includes(tag + ' OK')) {
            clearTimeout(to); this._restore(); res('');
          }
        } else {
          chunks.push(chunk); remain -= chunk.length;
          if (remain <= 0) { inLit = false; this._done(tag, to, chunks, size, res, rej); }
        }
      });
      this.sock.write(`${tag} ${c}\r\n`);
    });
  }
  _done(tag, to, chunks, size, res, rej) {
    clearTimeout(to);
    this._restore();
    // Take exactly `size` bytes (strips the closing IMAP tag line)
    const raw = chunks.join('').slice(0, size);
    res(raw);
  }
  _restore() {
    this.sock.removeAllListeners('data');
    this.sock.on('data', d => { this.buf += d; this._drain(); });
  }
  async login() { await this.cmd(`LOGIN "${this.u}" "${this.p}"`); }
  async select(mb = 'INBOX') { return this.cmd(`SELECT "${mb}"`); }
  logout() { try { this.sock.write('TZZZZ LOGOUT\r\n'); this.sock.destroy(); } catch {} }
}

// ─────────────────────────────────────────────────────────
// MIME BODYSTRUCTURE PARSER
// Locates the correct IMAP part IDs for text/plain and text/html
// without any third-party libraries.
// ─────────────────────────────────────────────────────────
function locateTextParts(structRaw) {
  const m = structRaw.match(/BODYSTRUCTURE \((.+)\)[\s\S]*$/);
  if (!m) return { plainId: '1', htmlId: null, plainEncoding: '7BIT', htmlEncoding: null };
  const struct = m[1];

  const isMixed   = /"MIXED"/i.test(struct);
  const isRelated = /"RELATED"/i.test(struct);  // inline images — same structure as MIXED
  const isAlt     = /"ALTERNATIVE"/i.test(struct);

  // "TEXT" "PLAIN"|"HTML" (charset-params) NIL NIL "ENCODING"
  const textRe = /"TEXT"\s+"(PLAIN|HTML)"\s+\([^)]*\)\s+NIL\s+NIL\s+"([^"]+)"/gi;
  const textParts = [];
  let tm;
  while ((tm = textRe.exec(struct)) !== null) {
    textParts.push({ subtype: tm[1].toUpperCase(), encoding: tm[2].toUpperCase() });
  }

  let plainId = null, htmlId = null;
  let plainEncoding = '7BIT', htmlEncoding = '7BIT';

  if (isMixed || isRelated) {
    // MIXED or RELATED at root: ALTERNATIVE is part 1, text parts are 1.1 and 1.2
    const plain = textParts.find(t => t.subtype === 'PLAIN');
    const html  = textParts.find(t => t.subtype === 'HTML');
    if (plain) { plainId = '1.1'; plainEncoding = plain.encoding; }
    if (html)  { htmlId  = '1.2'; htmlEncoding  = html.encoding; }
  } else if (isAlt) {
    // ALTERNATIVE at root: parts 1 and 2
    const plain = textParts.find(t => t.subtype === 'PLAIN');
    const html  = textParts.find(t => t.subtype === 'HTML');
    if (plain) { plainId = '1'; plainEncoding = plain.encoding; }
    if (html)  { htmlId  = '2'; htmlEncoding  = html.encoding; }
  } else {
    // Simple single-part message — part 1
    plainId = '1';
    if (textParts[0]) plainEncoding = textParts[0].encoding;
  }

  if (!plainId && !htmlId) plainId = '1';  // ultimate fallback

  return { plainId, htmlId, plainEncoding, htmlEncoding };
}

// ─────────────────────────────────────────────────────────
// TEXT DECODERS
// ─────────────────────────────────────────────────────────

// Decode QUOTED-PRINTABLE
function decodeQP(s) {
  return s
    .replace(/=\r?\n/g, '')                                    // soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Decode BASE64 (binary → utf-8 string)
function decodeBase64(s) {
  const b64 = s.replace(/\r\n|\r|\n/g, '').replace(/\s/g, '');
  // Find closing ) if IMAP tag line leaked in
  const parenIdx = b64.indexOf(')');
  const clean = parenIdx > 0 ? b64.slice(0, parenIdx) : b64;
  // decode bytes
  try {
    const binary = atob(clean);
    // Try to interpret as UTF-8 via TextDecoder
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return atob(clean);
  }
}

// Decode by transfer encoding
function decodeBody(raw, encoding) {
  const enc = (encoding || '7BIT').toUpperCase();
  let text;
  if (enc === 'QUOTED-PRINTABLE') text = decodeQP(raw);
  else if (enc === 'BASE64')      text = decodeBase64(raw);
  else                            text = raw;  // 7BIT or 8BIT
  return fixEncoding(text);
}

// Fix encoding corruption caused by IMAP socket using 'binary' encoding.
// The socket treats data as Latin-1 (one byte per char). If the actual
// content is UTF-8, multi-byte sequences arrive as multiple Latin-1 chars.
// Example: UTF-8 U+200C (e2 80 8c) arrives as "â" (3 Latin-1 chars).
// Fix: convert the Latin-1 string back to a byte array, decode as UTF-8,
// then strip invisible/zero-width chars used as email spam-bypass tricks.
function fixEncoding(str) {
  if (!str) return str;
  // Try to recover UTF-8 by treating each char as a Latin-1 byte
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xff;
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Use the UTF-8 version if it has fewer replacement chars (U+FFFD)
    const replCount = (decoded.match(/\ufffd/g) || []).length;
    const origNonAscii = (str.match(/[\x80-\xff]/g) || []).length;
    if (replCount < origNonAscii * 0.5) {
      str = decoded;
    }
  } catch {}
  // Strip invisible/control characters used in marketing emails:
  // U+200B-200F (zero-width), U+2028-2029 (line/para sep), U+FEFF (BOM), U+00AD (soft hyphen)
  str = str.replace(/[\u200b-\u200f\u2028\u2029\ufeff\u00ad]/g, '');
  // Replace non-breaking space and other spacing variants with regular space
  str = str.replace(/[\xa0\u2003\u2002\u2001\u2000\u3000]/g, ' ');
  return str;
}

// ─────────────────────────────────────────────────────────
// HTML → PLAIN TEXT converter (no npm, no DOM)
// Preserves paragraph breaks and list structure.
// ─────────────────────────────────────────────────────────
function htmlToText(html) {
  return html
    // Block elements → line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote)[^>]*>/gi, '\n')
    // Collapse whitespace inside tags
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    // Collapse runs of blank lines (max 2)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────────────
// SIGNATURE / QUOTE TRIMMER
// Cuts off common signature and reply-chain markers.
// ─────────────────────────────────────────────────────────
function trimSignature(text) {
  // Trim after common signature delimiters
  const delimiters = [
    /^--\s*$/m,                           // standard sig delimiter
    /^_{3,}$/m,                           // Gmail underscores
    /^-{3,} ?Mensaje original/im,         // forwarded in Spanish
    /^-{3,} ?Original [Mm]essage/m,       // forwarded in English
    /^El .{5,60} escribi[oó]:/m,          // Gmail reply attribution
    /^On .{5,80} wrote:/m,                // English reply attribution
    /^>{3,}/m,                            // heavy quoting
  ];
  let cut = text.length;
  for (const re of delimiters) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

// ─────────────────────────────────────────────────────────
// MIME utils
// ─────────────────────────────────────────────────────────
function decodeMimeWord(s) {
  if (!s) return '';
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(txt, 'base64').toString('utf8');
      return Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x,h) => String.fromCharCode(parseInt(h,16))), 'binary').toString('utf8');
    } catch { return txt; }
  });
}

function parseFrom(raw) {
  const dec = decodeMimeWord(raw || '');
  const m = dec.match(/"?([^"<]*)"?\s*<([^>]+)>/) || dec.match(/([^\s<]+@[^\s>]+)/);
  if (m && m[2]) return { name: (m[1]||'').trim() || m[2], email: m[2].trim().toLowerCase() };
  if (m) return { name: m[1], email: m[1].trim().toLowerCase() };
  return { name: dec, email: dec.trim().toLowerCase() };
}

function parseAttachmentsMeta(struct) {
  const atts = [];
  const re = /"(IMAGE|APPLICATION|VIDEO|AUDIO)"\s+"([A-Z0-9\-+]+)"\s+\([^)]*"(?:NAME|FILENAME)"\s+"([^"]+)"[^)]*\)[^)]*?"BASE64"\s+(\d{2,})/gi;
  let m;
  while ((m = re.exec(struct)) !== null) {
    const type = m[1].toLowerCase();
    atts.push({ filename: decodeMimeWord(m[3]), size: parseInt(m[4]), contentType: `${type}/${m[2].toLowerCase()}` });
  }
  return atts;
}

// ─────────────────────────────────────────────────────────
// HTTP HANDLER
// ─────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const u = process.env.GMAIL_USER;
  const p = process.env.GMAIL_APP_PASSWORD;
  if (!u || !p) return new Response(JSON.stringify({ error: 'Missing GMAIL creds' }), { status: 500, headers: CORS });

  const imap = new Imap(u, p);
  try {
    await imap.connect();
    await imap.login();
    const sel = await imap.select('INBOX');

    const existsLine = sel.find(l => /EXISTS/.test(l)) || '';
    const total = parseInt((existsLine.match(/\* (\d+) EXISTS/) || [])[1] || '0');
    if (!total) {
      imap.logout();
      return new Response(JSON.stringify({ success: true, folder: 'INBOX', total: 0, emails: [] }), { status: 200, headers: CORS });
    }

    // Fetch the last 12 messages
    const start = Math.max(1, total - 11);
    const metaLines = await imap.cmd(`FETCH ${start}:${total} (UID FLAGS ENVELOPE BODYSTRUCTURE)`, 30000);
    const metaRaw = metaLines.join('\n');

    // ── Parse each message ──
    const emails = [];
    const blocks = metaRaw.split(/\* \d+ FETCH /).slice(1);

    for (const block of blocks) {
      const uid = (block.match(/UID (\d+)/) || [])[1];
      if (!uid) continue;

      const isRead    = /\\Seen/.test(block);
      const isStarred = /\\Flagged/.test(block);

      // Envelope fields
      let subject = '', from = '', dateStr = '';
      const envMatch = block.match(/ENVELOPE \(/);
      if (envMatch) {
        const envStart = block.indexOf('ENVELOPE (') + 10;
        const env = block.slice(envStart, envStart + 2000);
        const dm = env.match(/^\s*"([^"]*)"/);
        if (dm) dateStr = dm[1];
        const afterDate = env.slice(dm ? dm[0].length : 0);
        const sm = afterDate.match(/"([^"]*)"/);
        if (sm) subject = decodeMimeWord(sm[1]);
        const fm = env.match(/\(\("([^"]*)"\s+NIL\s+"([^"]*)"\s+"([^"]*)"\)\)/);
        if (fm) from = `"${fm[1]}" <${fm[2]}@${fm[3]}>`;
      }

      const fromP = parseFrom(from);
      const attachments = parseAttachmentsMeta(block);
      const hasAtt = attachments.length > 0 || /"(IMAGE|APPLICATION|VIDEO|AUDIO)"/i.test(block);

      // ── Locate text body parts from BODYSTRUCTURE ──
      const { plainId, htmlId, plainEncoding, htmlEncoding } = locateTextParts(block);

      emails.push({
        uid: parseInt(uid),
        messageId: (block.match(/<[^>@]+@[^>]+>/) || [''])[0],
        from, fromName: fromP.name, fromEmail: fromP.email,
        to: u, subject,
        date: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
        preview: '', body: '', html: '',
        isRead, isStarred,
        hasAttachments: hasAtt,
        attachments,
        // Store part IDs for body fetch phase
        _plainId: plainId,
        _htmlId: htmlId,
        _plainEncoding: plainEncoding,
        _htmlEncoding: htmlEncoding,
      });
    }

    // ── Fetch body text with deadline ──
    const deadline = Date.now() + 18000;

    for (const e of emails) {
      if (Date.now() > deadline) break;

      const partId   = e._plainId || e._htmlId;
      const encoding = e._plainId ? e._plainEncoding : e._htmlEncoding;
      const isHtml   = !e._plainId && !!e._htmlId;

      if (!partId) continue;

      try {
        const raw = await imap.fetchLiteral(`UID FETCH ${e.uid} (BODY.PEEK[${partId}])`, 7000);

        if (!raw || raw.length < 2) {
          // Plain part empty — try HTML part as fallback
          if (isHtml || (e._htmlId && !raw)) {
            const htmlRaw = await imap.fetchLiteral(`UID FETCH ${e.uid} (BODY.PEEK[${e._htmlId}])`, 7000).catch(() => '');
            const decoded = decodeBody(htmlRaw, e._htmlEncoding);
            const text = trimSignature(htmlToText(decoded));
            e.body = text.slice(0, 5000);
            e.preview = e.body.replace(/\s+/g,' ').slice(0, 200);
          }
        } else {
          let text = decodeBody(raw, encoding);
          if (isHtml) text = htmlToText(text);
          // Normalize line endings and trim signature
          text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          text = trimSignature(text);
          // Remove bold markdown from names (Gmail wraps in *asterisks*)
          text = text.replace(/\*([^*]+)\*/g, '$1');
          // Collapse excessive blank lines
          text = text.replace(/\n{3,}/g, '\n\n').trim();
          e.body = text.slice(0, 5000);
          e.preview = e.body.replace(/\s+/g,' ').slice(0, 200);
        }
      } catch {
        // Timeout or error on this email — leave body empty, continues to next
      }

      // Clean up internal fields before sending to client
      delete e._plainId;
      delete e._htmlId;
      delete e._plainEncoding;
      delete e._htmlEncoding;
    }

    // Clean any emails that hit the deadline without fetching
    for (const e of emails) {
      delete e._plainId; delete e._htmlId;
      delete e._plainEncoding; delete e._htmlEncoding;
    }

    imap.logout();
    emails.sort((a, b) => b.uid - a.uid);
    return new Response(
      JSON.stringify({ success: true, folder: 'INBOX', total, emails }),
      { status: 200, headers: CORS }
    );

  } catch (err) {
    try { imap.logout(); } catch {}
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/.netlify/functions/emails' };
