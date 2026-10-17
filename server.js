const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 9 * 1024 * 1024) { reject(new Error('Request too large (max 9 MB).')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON request.')); }
    });
    req.on('error', reject);
  });
}
function langPrompt(data) {
  const lang = String(data.languageName || data.language || 'Hindi').slice(0, 80);
  return `You are Smart Saathi, a helpful assistant. Reply in ${lang} unless the user asks for another language. Use clear, practical wording. For calculations, show the result and units. Do not claim you performed actions outside this chat. If unsure, say so.`;
}
async function openAI(messages, options = {}) {
  if (!API_KEY) throw Object.assign(new Error('सर्वर पर OPENAI_API_KEY सेट नहीं है।'), { status: 503 });
  const payload = { model: MODEL, messages, temperature: 0.4 };
  if (options.max_tokens) payload.max_tokens = options.max_tokens;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message || `AI provider returned HTTP ${r.status}`), { status: r.status >= 500 ? 502 : 400 });
  const reply = d.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) throw Object.assign(new Error('AI से खाली जवाब मिला।'), { status: 502 });
  return reply.trim();
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { name: 'Smart Saathi API', status: 'ok', endpoints: ['/api/health', '/api/chat', '/api/vision', '/api/search'] });
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {
    status: 'ok', aiConfigured: Boolean(API_KEY), visionConfigured: Boolean(API_KEY), searchConfigured: false, pushConfigured: false,
    model: MODEL, message: API_KEY ? 'AI key configured' : 'OPENAI_API_KEY is missing'
  });
  if (req.method !== 'POST' || !['/api/chat', '/api/vision', '/api/search'].includes(url.pathname)) return send(res, 404, { error: 'Endpoint नहीं मिला।' });
  try {
    const data = await readBody(req);
    let reply;
    if (url.pathname === '/api/chat') {
      const history = Array.isArray(data.history) ? data.history.slice(-10).filter(x => ['user','assistant'].includes(x.role) && typeof x.content === 'string').map(x => ({ role: x.role, content: x.content.slice(0, 6000) })) : [];
      const message = String(data.message || '').trim();
      if (!message) return send(res, 400, { error: 'सवाल खाली है।' });
      reply = await openAI([{ role: 'system', content: langPrompt(data) }, ...history, { role: 'user', content: message.slice(0, 12000) }], { max_tokens: 1200 });
    } else if (url.pathname === '/api/vision') {
      const question = String(data.question || 'इस फोटो में क्या है?').slice(0, 2000);
      const image = String(data.image || '');
      if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(image)) return send(res, 400, { error: 'मान्य फोटो डेटा नहीं मिला।' });
      reply = await openAI([{ role: 'system', content: langPrompt(data) }, { role: 'user', content: [ { type: 'text', text: question }, { type: 'image_url', image_url: { url: image, detail: 'auto' } } ] }], { max_tokens: 1000 });
    } else {
      return send(res, 501, { error: 'इंटरनेट सर्च इस शुरुआती सर्वर पैकेज में चालू नहीं है।' });
    }
    return send(res, 200, { reply });
  } catch (e) {
    const status = e.status || 500;
    return send(res, status, { error: e.message || 'सर्वर में समस्या हुई।' });
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Smart Saathi API listening on ${PORT}; model=${MODEL}; key=${Boolean(API_KEY)}`));
