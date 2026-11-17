
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 10000);
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const CHAT_MODEL =
  process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  'meta-llama/llama-4-scout-17b-16e-instruct';

const MAX_BODY = 12 * 1024 * 1024;

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function askGroq(model, messages) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY सेट नहीं है');
  }

  const response = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 2048
      }),
      signal: AbortSignal.timeout(85000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Groq API error');
  }

  return data.choices?.[0]?.message?.content || '';
}

async function chat(body) {
  let messages = Array.isArray(body.messages)
    ? body.messages
    : [];

  if (!messages.length) {
    const prompt = body.message || body.prompt || body.text || '';
    if (!String(prompt).trim()) {
      throw new Error('मैसेज खाली है');
    }
    messages = [{ role: 'user', content: String(prompt) }];
  }

  return askGroq(CHAT_MODEL, messages);
}

async function vision(body) {
  const image =
    body.image || body.imageUrl || body.photo || body.dataUrl;

  if (!image) throw new Error('तस्वीर नहीं मिली');

  const prompt =
    body.prompt || body.message ||
    'इस तस्वीर में क्या दिखाई दे रहा है?';

  return askGroq(VISION_MODEL, [{
    role: 'user',
    content: [
      { type: 'text', text: String(prompt) },
      { type: 'image_url', image_url: { url: image } }
    ]
  }]);
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
  const url =
    'https://html.duckduckgo.com/html/?q=' +
    encodeURIComponent(query);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 SmartSaathi/5.0',
      'Accept': 'text/html'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error('इंटरनेट सर्च सेवा उपलब्ध नहीं है');
  }

  const html = await response.text();
  const results = [];
  const blocks = html.split(
    /<div[^>]*class="[^"]*result[^"]*"[^>]*>/i
  );

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
  const query =
    body.query || body.message || body.prompt || '';

  if (!String(query).trim()) {
    throw new Error('खोजने के लिए सवाल लिखें');
  }

  const results = await internetSearch(String(query));

  if (!results.length) {
    throw new Error('इस सवाल के लिए इंटरनेट पर परिणाम नहीं मिले');
  }

  const searchContext = results.map((item, index) =>
    `${index + 1}. ${item.title}\nURL: ${item.url}\nजानकारी: ${item.snippet}`
  ).join('\n\n');

  const reply = await askGroq(CHAT_MODEL, [
    {
      role: 'system',
      content:
        'आप Smart Saathi हैं। नीचे दिए गए वेब सर्च परिणामों के आधार पर हिंदी में जवाब दें। ' +
        'केवल उपलब्ध जानकारी बताएं। परिणामों में जानकारी न हो तो साफ बताएं। ' +
        'ताज़ा जानकारी और अनुमान में अंतर रखें।'
    },
    {
      role: 'user',
      content:
        `मेरा सवाल: ${String(query)}\n\nइंटरनेट सर्च परिणाम:\n${searchContext}`
    }
  ]);

  return {
    reply,
    sources: results,
    liveSearch: true
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
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      status: 'ok',
      name: 'Smart Saathi API'
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, {
      status: 'ok',
      name: 'Smart Saathi API',
      provider: 'Groq',
      aiConfigured: Boolean(GROQ_API_KEY),
      visionConfigured: Boolean(GROQ_API_KEY),
      searchConfigured: true,
      openaiConfigured: false,
      model: CHAT_MODEL,
      visionModel: VISION_MODEL,
      endpoints: [
        '/api/health',
        '/api/chat',
        '/api/vision',
        '/api/search'
      ]
    });
  }

  if (req.method === 'POST' && routes[url.pathname]) {
    try {
      const body = await readBody(req);
      const result = await routes[url.pathname](body);

      return send(res, 200, {
        status: 'ok',
        ...(typeof result === 'string'
          ? { reply: result }
          : result),
        provider: 'Groq',
        paidOpenAIFallback: false
      });
    } catch (error) {
      return send(res, 500, {
        status: 'error',
        error: error.message || 'Server error',
        paidOpenAIFallback: false
      });
    }
  }

  return send(res, 404, {
    status: 'error',
    error: 'Endpoint नहीं मिला'
  });
});

server.listen(PORT, () => {
  console.log(`Smart Saathi API running on port ${PORT}`);
});
