/**
 * MovFlow Hub — Real Estate Intelligence Engine
 * /.netlify/functions/real-estate-intel
 *
 * A specialized real-estate analyst layer. Pipeline:
 *   1. RETRIEVAL (lexical RAG): match glossary terms/synonyms/variants in the
 *      email text, retrieve relevant legal context. Decoupled per country.
 *   2. RULE-BASED EXTRACTION: operation, property type, location, budget,
 *      surface, rooms, condition, urgency — via patterns + glossary hits.
 *   3. LLM ENRICHMENT (Groq): normalized structured data + executive summary,
 *      risks, missing docs, next steps, CRM tags, priority. The retrieved
 *      glossary + legal context is injected so the model "knows" the domain
 *      without retraining (RAG).
 *
 * Country modules are loaded dynamically: add knowledge-uk.mjs etc. and the
 * engine picks it up via ?country=uk. España is the default.
 *
 * POST { email: {subject, body, fromEmail, ...}, country?: 'es' }
 *   → { country, retrieval, extraction, enrichment, confidence }
 */

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'qwen/qwen3.6-27b';

// ── Country module loader (decoupled, expandable) ──
const SUPPORTED_COUNTRIES = ['es']; // add 'uk','us','eu','latam','me' as modules ship
async function loadCountry(code) {
  const c = (code || 'es').toLowerCase();
  if (!SUPPORTED_COUNTRIES.includes(c)) return null;
  try {
    const mod = await import(`./knowledge-${c}.mjs`);
    return mod.default || mod;
  } catch { return null; }
}

// ── Normalize text for matching (lowercase, strip accents) ──
function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Levenshtein for fuzzy matching of misspellings (bounded, cheap)
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1] + (a[i-1]===b[j-1]?0:1));
  return d[m][n];
}

// ── RETRIEVAL: lexical RAG over the glossary ──
function retrieve(text, kb) {
  const nt = norm(text);
  const words = nt.split(/\W+/).filter(w => w.length > 2);
  const wordSet = new Set(words);
  const hits = [];

  for (const entry of kb.GLOSSARY) {
    const candidates = [entry.term, entry.canonical, ...(entry.syn || [])];
    let matched = null, how = null;
    for (const cand of candidates) {
      const nc = norm(cand);
      if (nc.includes(' ')) {
        // multi-word: substring match
        if (nt.includes(nc)) { matched = cand; how = 'phrase'; break; }
      } else {
        // single word: exact set membership
        if (wordSet.has(nc)) { matched = cand; how = 'exact'; break; }
      }
    }
    // fuzzy fallback for single-word misspellings.
    // Only fuzzy-match real words (length >= 5) to avoid false positives on
    // short abbreviations like "hoa", "vpo", "ibi", "itp" that collide easily.
    if (!matched) {
      for (const cand of candidates) {
        const nc = norm(cand);
        if (nc.includes(' ') || nc.length < 5) continue;
        for (const w of words) {
          if (w.length >= 5 && lev(w, nc) <= 1) { matched = cand; how = 'fuzzy'; break; }
        }
        if (matched) break;
      }
    }
    if (matched) {
      hits.push({ canonical: entry.canonical, category: entry.category, matched, how, def: entry.def });
    }
  }

  // Retrieve relevant legal context by trigger overlap
  const legal = [];
  for (const law of kb.LEGAL) {
    const triggered = (law.triggers || []).filter(t => nt.includes(norm(t)));
    if (triggered.length) legal.push({ id: law.id, name: law.name, summary: law.summary, matchedTriggers: triggered });
  }

  return { hits, legal };
}

// ── RULE-BASED EXTRACTION ──
function extractStructured(text, retrieval, kb) {
  const nt = norm(text);
  const byCat = cat => retrieval.hits.filter(h => h.category === cat).map(h => h.canonical);

  // Budget: €, euros, k, mil, millones. Spanish number formats handled.
  // "millones" must precede "mil" in the alternation (mil is a prefix of millones).
  let budget = null;
  const amounts = [];
  const moneyRe = /(\d[\d.,]*)\s*(?:€|euros?|eur)(?![a-z])|(?:€|eur)\s*(\d[\d.,]*)|(\d+(?:[.,]\d+)?)\s*(millones?|mil|k)(?![a-z])/gi;
  let mm;
  while ((mm = moneyRe.exec(nt)) !== null) {
    const raw  = mm[1] || mm[2] || mm[3];
    if (!raw) continue;
    const unit = (mm[4] || '').toLowerCase();
    let val;
    if (unit && /^\d+\.\d{1,2}$/.test(raw)) {
      val = parseFloat(raw);                 // "1.5 millones" → dot is decimal
    } else {
      val = parseFloat(raw.replace(/\./g, '').replace(',', '.'));  // "350.000" → 350000
    }
    if (unit === 'k' || unit === 'mil') val *= 1000;
    if (unit.startsWith('millon')) val *= 1000000;
    if (val > 0) amounts.push(Math.round(val));
  }
  if (amounts.length) budget = { values: amounts, min: Math.min(...amounts), max: Math.max(...amounts), currency: 'EUR' };

  // Surface: m2, metros
  let surface = null;
  const surfRe = /(\d{1,5})\s*(?:m2|m²|metros?(?:\s+cuadrados?)?|mts?)\b/i;
  const sm = nt.match(surfRe);
  if (sm) surface = { value: parseInt(sm[1]), unit: 'm2' };

  // Rooms: habitaciones, dormitorios, hab
  let rooms = null;
  const roomRe = /(\d{1,2})\s*(?:habitaciones?|dormitorios?|hab\b|dorm\b|recamaras?)/i;
  const rm = nt.match(roomRe);
  if (rm) rooms = parseInt(rm[1]);

  // Bathrooms
  let bathrooms = null;
  const bathRe = /(\d{1,2})\s*(?:baños?|banos?|aseos?)/i;
  const bm = nt.match(bathRe);
  if (bm) bathrooms = parseInt(bm[1]);

  // Location: Spanish cities/provinces + "en X" patterns
  const cities = ['madrid','barcelona','valencia','sevilla','malaga','bilbao','zaragoza','murcia','palma','alicante','cordoba','valladolid','vigo','gijon','granada','marbella','san sebastian','santander','pamplona','toledo','salamanca','cadiz','tarragona','girona','ibiza','tenerife','las palmas','costa del sol','costa brava'];
  const foundCities = cities.filter(c => nt.includes(c));
  // also "en <Capitalized>" / "zona <X>" / "calle <X>"
  const zoneM = text.match(/\b(?:en|zona|barrio|calle|avenida|plaza)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ]?[a-záéíóúñ]+){0,2})/);
  const location = {
    cities: foundCities,
    raw: zoneM ? zoneM[0] : null,
  };

  // Urgency
  const urgencyHits = (kb.URGENCY_SIGNALS || []).filter(s => nt.includes(norm(s)));
  const urgency = urgencyHits.length >= 2 ? 'alta' : urgencyHits.length === 1 ? 'media' : 'baja';

  return {
    operationTypes: [...new Set(byCat('operation'))],
    propertyTypes:  [...new Set(byCat('property'))],
    conditions:     [...new Set(byCat('condition'))],
    financialTerms: [...new Set(byCat('financial'))],
    documents:      [...new Set(byCat('document'))],
    legalTerms:     [...new Set(byCat('legal'))],
    budget, surface, rooms, bathrooms, location,
    urgency, urgencySignals: urgencyHits,
  };
}

// ── Confidence score from extraction completeness ──
function scoreConfidence(ext, retrieval) {
  let score = 0, max = 0;
  const fields = ['operationTypes','propertyTypes','budget','surface','rooms','location'];
  for (const f of fields) {
    max += 1;
    const v = ext[f];
    if (Array.isArray(v) ? v.length : (v && (v.cities ? v.cities.length || v.raw : true))) score += 1;
  }
  const base = max ? score / max : 0;
  // boost by glossary hit density
  const boost = Math.min(0.2, retrieval.hits.length * 0.03);
  return Math.min(1, +(base * 0.8 + boost).toFixed(2));
}

// ── LLM ENRICHMENT via Groq (RAG: inject retrieved context) ──
async function enrich(email, retrieval, extraction, kb) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { _note: 'GROQ_API_KEY not configured — enrichment skipped', _ruleBasedOnly: true };

  // Build RAG context from retrieved glossary + legal
  const glossaryContext = retrieval.hits.slice(0, 25)
    .map(h => `- ${h.canonical} (${h.category}): ${h.def || ''}`).join('\n');
  const legalContext = retrieval.legal
    .map(l => `- ${l.name}: ${l.summary}`).join('\n');

  const sys = `Eres un analista inmobiliario digital especializado en el mercado español. Analizas correos del sector y devuelves SOLO JSON válido, sin texto adicional ni markdown. No emites asesoramiento jurídico vinculante; interpretas y clasificas.`;

  const user = `CONTEXTO INMOBILIARIO RECUPERADO (úsalo para interpretar):
Glosario relevante:
${glossaryContext || '(ninguno)'}

Contexto legal relevante:
${legalContext || '(ninguno)'}

DATOS YA EXTRAÍDOS POR REGLAS:
${JSON.stringify(extraction)}

EMAIL:
Asunto: ${email.subject || ''}
Cuerpo: ${(email.body || email.snippet || '').slice(0, 2500)}

Devuelve un objeto JSON con esta forma exacta:
{
  "resumenEjecutivo": "2-3 frases en español",
  "intencionReal": "qué quiere realmente el remitente",
  "datosEstructurados": { "operacion": "", "inmueble": "", "ubicacion": "", "presupuesto": "", "superficie": "", "habitaciones": "", "estado": "", "rentabilidadEsperada": "" },
  "riesgosDetectados": ["..."],
  "documentacionFaltante": ["..."],
  "proximosPasos": ["..."],
  "etiquetasCRM": ["..."],
  "prioridad": "alta|media|baja",
  "contextoLegal": ["normas aplicables mencionadas, sin asesoramiento vinculante"]
}`;

  try {
    const resp = await fetch(GROQ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      }),
    });
    if (!resp.ok) return { _error: 'groq_http_' + resp.status, _detail: (await resp.text()).slice(0, 200) };
    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/```json|```/g, '').trim();
    try { return JSON.parse(content); }
    catch { return { _error: 'json_parse_failed', _raw: content.slice(0, 500) }; }
  } catch (e) {
    return { _error: 'groq_exception', _detail: e.message };
  }
}

// ── HTTP handler ──
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: true, service: 'real-estate-intel', supportedCountries: SUPPORTED_COUNTRIES }), { status: 200, headers: CORS });
  }

  try {
    const body = await req.json();
    const email = body.email || body;
    const countryCode = body.country || 'es';

    const kb = await loadCountry(countryCode);
    if (!kb) return new Response(JSON.stringify({ error: 'country_not_supported', country: countryCode, supported: SUPPORTED_COUNTRIES }), { status: 400, headers: CORS });

    const text = `${email.subject || ''}\n${email.body || email.snippet || ''}`;
    if (text.trim().length < 3) return new Response(JSON.stringify({ error: 'empty_email' }), { status: 400, headers: CORS });

    // Pipeline
    const retrieval  = retrieve(text, kb);
    const extraction = extractStructured(text, retrieval, kb);
    const confidence = scoreConfidence(extraction, retrieval);
    const enrichment = await enrich(email, retrieval, extraction, kb);

    return new Response(JSON.stringify({
      country: countryCode,
      retrieval: {
        glossaryHits: retrieval.hits,
        legalContext: retrieval.legal,
        hitCount: retrieval.hits.length,
      },
      extraction,
      confidence,
      enrichment,
      processedAt: new Date().toISOString(),
    }), { status: 200, headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/.netlify/functions/real-estate-intel' };
