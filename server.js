'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 10000);
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const CHAT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_BODY = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 85000;

class ApiError extends Error {
  constructor(message, status = 502, code = 'API_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;

    req.on('data', chunk => {
      if (settled) return;
      raw += chunk.toString('utf8');

      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
        settled = true;
        reject(new ApiError('अनुरोध बहुत बड़ा है। छोटी फोटो या कम डेटा भेजें।', 413, 'BODY_TOO_LARGE'));
        req.pause();
      }
    });

    req.on('end', () => {
      if (settled) return;
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON object expected');
        }
        resolve(parsed);
      } catch {
        reject(new ApiError('अनुरोध का JSON सही नहीं है।', 400, 'INVALID_JSON'));
      }
    });

    req.on('error', error => {
      if (!settled) reject(error);
    });
  });
}

function extractText(data) {
  return data?.choices?.[0]?.message?.content || '';
}

function providerError(provider, status, data) {
  const raw = data?.error?.message || data?.message || '';

  if (status === 401 || status === 403 ||
      /invalid.*(api.?key|key)|api.?key.*invalid|unauthorized|authentication/i.test(raw)) {
    return new ApiError(
      `${provider} API Key अमान्य है या अनुमति नहीं है। Render में सही ${provider === 'Groq' ? 'GROQ_API_KEY' : 'GEMINI_API_KEY'} जाँचें।`,
      502,
      'INVALID_PROVIDER_KEY'
    );
  }

  if (status === 429) {
    return new ApiError(`${provider} की मुफ्त/वर्तमान API सीमा पूरी हो गई है। बाद में फिर कोशिश करें।`, 429, 'RATE_LIMIT');
  }

  if (status === 400 && /model|not found|unsupported/i.test(raw)) {
    return new ApiError(`${provider} में चुना गया मॉडल उपलब्ध नहीं है। Render के मॉडल नाम की जाँच करें।`, 502, 'MODEL_UNAVAILABLE');
  }

  return new ApiError(
    `${provider} सेवा से जवाब नहीं मिला${raw ? ': ' + raw.slice(0, 220) : '.'}`,
    502,
    'PROVIDER_ERROR'
  );
}

async function fetchJson(url, options, provider) {
  let response;

  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ApiError(`${provider} सेवा तक कनेक्शन नहीं हुआ।`, 502, 'PROVIDER_NETWORK');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) throw providerError(provider, response.status, data);
  return data;
}

async function askGroq(model, messages, systemInstruction = '') {
  if (!GROQ_API_KEY) {
    throw new ApiError('GROQ_API_KEY सेट नहीं है।', 503, 'GROQ_KEY_MISSING');
  }

  const safeMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const groqMessages = systemInstruction
    ? [{ role: 'system', content: String(systemInstruction).slice(0, 6000) }, ...safeMessages]
    : safeMessages;

  const data = await fetchJson('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: groqMessages,
      temperature: 0.6,
      max_completion_tokens: 2048
    })
  }, 'Groq');

  const text = extractText(data);
  if (!String(text).trim()) {
    throw new ApiError('Groq से खाली जवाब मिला।', 502, 'EMPTY_PROVIDER_REPLY');
  }

  return { text: String(text), provider: 'Groq' };
}

function toGeminiContents(messages) {
  const contents = [];

  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue;

    const role = message.role === 'assistant' ? 'model' : 'user';
    const raw = message.content;

    const parts = Array.isArray(raw)
      ? raw.map(part => {
          if (part?.type === 'text') {
            return { text: String(part.text || '') };
          }

          if (part?.type === 'image_url') {
            const url = part.image_url?.url || '';
            const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(url);

            if (match) {
              return {
                inlineData: {
                  mimeType: match[1],
                  data: match[2]
                }
              };
            }

            return { text: '[बाहरी इमेज URL को Gemini बैकअप में नहीं भेजा जा सका।]' };
          }

          return { text: '' };
        }).filter(p => p.text || p.inlineData)
      : [{ text: String(raw ?? '') }];

    if (parts.length) contents.push({ role, parts });
  }

  return contents;
}

async function askGemini(messages, systemInstruction = '') {
  if (!GEMINI_API_KEY) {
    throw new ApiError('GEMINI_API_KEY सेट नहीं है।', 503, 'GEMINI_KEY_MISSING');
  }

  const contents = toGeminiContents(messages);
  if (!contents.length) {
    throw new ApiError('Gemini के लिए संदेश खाली है।', 400, 'EMPTY_MESSAGES');
  }

  const body = {
    contents,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 2048
    }
  };

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 'Gemini');

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new ApiError('Gemini से खाली जवाब मिला।', 502, 'EMPTY_PROVIDER_REPLY');
  }

  return { text, provider: 'Gemini' };
}

async function askAI(messages, systemInstruction = '') {
  const failures = [];

  if (GROQ_API_KEY) {
    try {
      return await askGroq(CHAT_MODEL, messages, systemInstruction);
    } catch (error) {
      failures.push(error);
    }
  }

  if (GEMINI_API_KEY) {
    try {
      return await askGemini(messages, systemInstruction);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length) {
    const invalidKey = failures.find(e => e.code === 'INVALID_PROVIDER_KEY');
    const rateLimit = failures.find(e => e.code === 'RATE_LIMIT');
    throw invalidKey || rateLimit || failures[failures.length - 1];
  }

  throw new ApiError(
    'AI सेवा की API Key सेट नहीं है। Render में GROQ_API_KEY या GEMINI_API_KEY जोड़ें।',
    503,
    'NO_AI_KEYS'
  );
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history.slice(-10).map(item => {
    const role = item?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(item?.content ?? '').trim();

    return content && content !== '[object MouseEvent]'
      ? { role, content: content.slice(0, 12000) }
      : null;
  }).filter(Boolean);
}

async function chat(body) {
  const system = [
    'आप Smart Saathi हैं। उपयोगकर्ता की भाषा में स्पष्ट, उपयोगी और विनम्र उत्तर दें।',
    `उत्तर की पसंदीदा भाषा: ${String(body.languageName || body.language || 'Hindi').slice(0, 50)}.`,
    String(body.instructions || '').slice(0, 3000),
    'तथ्य अनिश्चित हों तो साफ बताएं। अनुमान को तथ्य न बताएं।'
  ].filter(Boolean).join('\n');

  let messages;

  if (Array.isArray(body.messages) && body.messages.length) {
    messages = body.messages.slice(-12).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? '')
    }));
  } else {
    const history = safeHistory(body.history);
    const prompt = body.message ?? body.prompt ?? body.text ?? '';

    if (!String(prompt).trim() || String(prompt).trim() === '[object MouseEvent]') {
      throw new ApiError('मैसेज खाली या गलत है। कृपया सवाल दोबारा लिखें।', 400, 'EMPTY_MESSAGE');
    }

    messages = [
      ...history,
      { role: 'user', content: String(prompt).slice(0, 12000) }
    ];
  }

  const result = await askAI(messages, system);
  return { reply: result.text, provider: result.provider };
}

function parseImage(image) {
  if (typeof image !== 'string' || !image.trim()) return null;

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(image.trim());

  if (match) {
    return { mimeType: match[1], data: match[2] };
  }

  return null;
}

async function vision(body) {
  const image = body.image || body.imageUrl || body.photo || body.dataUrl;

  if (!image) {
    throw new ApiError('तस्वीर नहीं मिली।', 400, 'IMAGE_MISSING');
  }

  const question = body.question || body.prompt || body.message || body.text || 'इस तस्वीर में क्या दिखाई दे रहा है?';
  const imagePart = parseImage(image);

  const content = imagePart
    ? [
        { type: 'text', text: String(question).slice(0, 3000) },
        { type: 'image_url', image_url: { url: image } }
      ]
    : [{
        type: 'text',
        text: `${String(question).slice(0, 3000)}\nImage URL: ${String(image).slice(0, 5000)}`
      }];

  const messages = [{ role: 'user', content }];
  const failures = [];

  if (GROQ_API_KEY) {
    try {
      const result = await askGroq(
        VISION_MODEL,
        messages,
        `आप Smart Saathi हैं। तस्वीर का ध्यान से विश्लेषण करें और उपयोगकर्ता की भाषा (${String(body.languageName || body.language || 'Hindi').slice(0, 50)}) में उत्तर दें। तस्वीर में जो साफ दिखाई देता है वही बताएं; अनुमान को तथ्य न बताएं।`
      );

      return { reply: result.text, provider: result.provider };
    } catch (error) {
      failures.push(error);
    }
  }

  if (GEMINI_API_KEY) {
    try {
      const geminiMessages = [{
        role: 'user',
        content: imagePart
          ? [
              { type: 'text', text: String(question) },
              { type: 'image_url', image_url: { url: image } }
            ]
          : [{
              type: 'text',
              text: `${String(question)}\nImage URL: ${String(image)}`
            }]
      }];

      const result = await askGemini(
        geminiMessages,
        'आप Smart Saathi हैं। तस्वीर का ध्यान से विश्लेषण करें और उपयोगकर्ता की भाषा में उत्तर दें।'
      );

      return { reply: result.text, provider: result.provider };
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length) {
    throw failures.find(e => e.code === 'INVALID_PROVIDER_KEY') || failures[failures.length - 1];
  }

  throw new ApiError(
    'फोटो समझने के लिए GROQ_API_KEY या GEMINI_API_KEY चाहिए।',
    503,
    'NO_AI_KEYS'
  );
}

function cleanHTML(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function internetSearch(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  let response;

  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 SmartSaathi/5.0',
        Accept: 'text/html'
      },
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new ApiError('इंटरनेट सर्च सेवा तक कनेक्शन नहीं हुआ।', 502, 'SEARCH_NETWORK');
  }

  if (!response.ok) {
    throw new ApiError('इंटरनेट सर्च सेवा अभी उपलब्ध नहीं है।', 502, 'SEARCH_UNAVAILABLE');
  }

  const html = await response.text();
  const results = [];
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"[^>]*>/i);

  for (const block of blocks) {
    if (results.length >= 8) break;

    const titleMatch = block.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    );

    if (!titleMatch) continue;

    let link = titleMatch[1];

    try {
      const parsed = new URL(link, 'https://duckduckgo.com');
      if (parsed.searchParams.has('uddg')) {
        link = parsed.searchParams.get('uddg');
      }
    } catch {
      continue;
    }

    if (!/^https?:\/\//i.test(link)) continue;

    const snippetMatch = block.match(
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i
    );

    results.push({
      title: cleanHTML(titleMatch[2]),
      url: link,
      snippet: cleanHTML(snippetMatch?.[1] || '')
    });
  }

  return results;
}

async function search(body) {
  const query = body.query || body.message || body.prompt || '';

  if (!String(query).trim()) {
    throw new ApiError('खोजने के लिए सवाल लिखें।', 400, 'EMPTY_QUERY');
  }

  const results = await internetSearch(String(query).slice(0, 500));

  if (!results.length) {
    throw new ApiError('इस सवाल के लिए इंटरनेट पर परिणाम नहीं मिले।', 404, 'NO_RESULTS');
  }

  const context = results.map((item, i) =>
    `${i + 1}. ${item.title}\nURL: ${item.url}\nजानकारी: ${item.snippet}`
  ).join('\n\n');

  const messages = [{
    role: 'user',
    content: `मेरा सवाल: ${String(query)}\n\nइंटरनेट सर्च परिणाम:\n${context}\n\nइन परिणामों के आधार पर उपयोगकर्ता की भाषा में जवाब दें। स्रोतों के URL अंत में दें।`
  }];

  const result = await askAI(
    messages,
    'आप Smart Saathi हैं। वेब सर्च परिणामों के आधार पर जवाब दें। केवल उपलब्ध जानकारी बताएं; अपुष्ट दावे न करें।'
  );

  return {
    reply: result.text,
    sources: results,
    liveSearch: true,
    provider: result.provider
  };
}

const routes = {
  '/api/chat': chat,
  '/api/vision': vision,
  '/api/search': search
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, { status: 'error', error: 'गलत URL है।' });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/health')) {
    return send(res, 200, {
      status: 'ok',
      name: 'Smart Saathi API',
      aiConfigured: Boolean(GROQ_API_KEY || GEMINI_API_KEY),
      groqConfigured: Boolean(GROQ_API_KEY),
      geminiConfigured: Boolean(GEMINI_API_KEY),
      visionConfigured: Boolean(GROQ_API_KEY || GEMINI_API_KEY),
      searchConfigured: true,
      openaiConfigured: false,
      providerOrder: ['Groq', 'Gemini'],
      chatModel: CHAT_MODEL,
      visionModel: VISION_MODEL,
      geminiModel: GEMINI_MODEL,
      endpoints: ['/api/health', '/api/chat', '/api/vision', '/api/search']
    });
  }

  if (req.method === 'POST' && routes[url.pathname]) {
    try {
      const body = await readBody(req);
      const result = await routes[url.pathname](body);
      const provider = result.provider || 'Groq/Gemini';

      return send(res, 200, {
        status: 'ok',
        ...result,
        provider,
        paidOpenAIFallback: false
      });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;

      return send(res, status, {
        status: 'error',
        error: error.message || 'Server error',
        code: error.code || 'SERVER_ERROR',
        paidOpenAIFallback: false
      });
    }
  }

  return send(res, 404, {
    status: 'error',
    error: 'Endpoint नहीं मिला।'
  });
});

server.listen(PORT, () => {
  console.log(`Smart Saathi API running on port ${PORT}`);
});
