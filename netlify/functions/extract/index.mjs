/**
 * MovFlow Hub — Extract Function
 * /.netlify/functions/extract
 *
 * Extrae información estructurada de documentos usando Groq.
 * Modos de operación:
 *   1. template_mapping: recibe prompt completo desde el frontend (Plantillas v2)
 *   2. document: extrae campos genéricos de texto libre
 *
 * POST { prompt, mode, text, templateName, fields }
 *   → { ok, mapping, fields, resumen, source }
 */

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const GROQ_API   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'qwen/qwen3.6-27b';

async function callGroq(systemPrompt, userPrompt, apiKey) {
  const resp = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      temperature: 0.1,
      max_tokens:  2000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq HTTP ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data    = await resp.json();
  let   content = data.choices?.[0]?.message?.content || '';
  content = content.replace(/```json|```/g, '').trim();
  return content;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: true, service: 'extract' }), { status: 200, headers: CORS });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'GROQ_API_KEY no configurada', source: 'config_error' }),
      { status: 500, headers: CORS }
    );
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ ok: false, error: 'JSON inválido' }), { status: 400, headers: CORS }); }

  const mode = body.mode || 'document';

  /* ── Modo 1: template_mapping ── */
  /* El frontend envía el prompt completo con instrucciones de plantilla + datos */
  if (mode === 'template_mapping') {
    const prompt = body.prompt;
    if (!prompt) {
      return new Response(JSON.stringify({ ok: false, error: 'Falta el campo prompt' }), { status: 400, headers: CORS });
    }

    const sys = `Eres un extractor de datos especializado en documentos legales y comerciales españoles.
Tu tarea es extraer información estructurada siguiendo las instrucciones exactas que recibes.
IMPORTANTE: Devuelve ÚNICAMENTE un objeto JSON válido. Sin texto adicional, sin explicaciones, sin markdown.`;

    try {
      const raw     = await callGroq(sys, prompt, apiKey);
      const mapping = JSON.parse(raw);
      return new Response(
        JSON.stringify({ ok: true, mapping, source: 'groq', model: GROQ_MODEL }),
        { status: 200, headers: CORS }
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: e.message, source: 'groq_error' }),
        { status: 200, headers: CORS } // 200 para que el frontend maneje el fallback
      );
    }
  }

  /* ── Modo 2: document (extracción genérica) ── */
  const text         = body.text || body.content || '';
  const templateName = body.templateName || 'documento genérico';
  const fields       = body.fields || [];

  if (!text.trim()) {
    return new Response(JSON.stringify({ ok: false, error: 'No se proporcionó texto a extraer' }), { status: 400, headers: CORS });
  }

  const fieldsStr = fields.length
    ? `Extrae estos campos específicos: ${fields.join(', ')}.`
    : 'Extrae todos los datos relevantes del documento.';

  const sys = `Eres un extractor especializado en documentos españoles (contratos, facturas, escrituras, informes).
Extraes información estructurada y devuelves ÚNICAMENTE JSON válido. Sin texto adicional.`;

  const user = `Tipo de documento: ${templateName}
${fieldsStr}

TEXTO DEL DOCUMENTO:
${text.slice(0, 4000)}

Devuelve un objeto JSON con los campos extraídos. Si un campo no aparece en el documento, usa cadena vacía "".
Incluye también: "resumen" (2-3 frases sobre el documento) y "tipo_documento" (clasificación).`;

  try {
    const raw    = await callGroq(sys, user, apiKey);
    let   result;
    try   { result = JSON.parse(raw); }
    catch { result = { _raw: raw, _parse_error: true }; }

    return new Response(
      JSON.stringify({ ok: true, fields: result, resumen: result.resumen || null, source: 'groq', model: GROQ_MODEL }),
      { status: 200, headers: CORS }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e.message, source: 'groq_error' }),
      { status: 500, headers: CORS }
    );
  }
};

export const config = { path: '/.netlify/functions/extract' };
