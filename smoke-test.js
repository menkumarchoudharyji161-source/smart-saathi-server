
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 18765;
const base = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
  env: { PATH: process.env.PATH || '', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
child.stdout.on('data', x => logs += x.toString());
child.stderr.on('data', x => logs += x.toString());

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(url, options) {
  return fetch(base + url, options);
}

(async () => {
  try {
    let ready = false;

    for (let i = 0; i < 40; i++) {
      try {
        const r = await request('/api/health');
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await sleep(150);
    }

    assert.ok(ready, `server did not start: ${logs}`);

    let r = await request('/api/health');
    let j = await r.json();

    assert.equal(r.status, 200);
    assert.equal(j.status, 'ok');
    assert.equal(j.aiConfigured, false);
    assert.equal(j.openaiConfigured, false);
    assert.deepEqual(j.providerOrder, ['Groq', 'Gemini']);

    r = await request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'नमस्ते' })
    });

    j = await r.json();
    assert.equal(r.status, 503);
    assert.equal(j.code, 'NO_AI_KEYS');
    assert.equal(j.paidOpenAIFallback, false);

    r = await request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json'
    });

    j = await r.json();
    assert.equal(r.status, 400);
    assert.equal(j.code, 'INVALID_JSON');

    r = await request('/api/vision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    j = await r.json();
    assert.equal(r.status, 400);
    assert.equal(j.code, 'IMAGE_MISSING');

    r = await request('/api/document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    assert.equal(r.status, 404);

    r = await request('/api/health', { method: 'OPTIONS' });
    assert.equal(r.status, 204);

    console.log('PASS health / free-provider order / no paid OpenAI fallback');
    console.log('PASS no-key chat returns 503 NO_AI_KEYS');
    console.log('PASS malformed JSON returns 400 INVALID_JSON');
    console.log('PASS missing image returns 400 IMAGE_MISSING');
    console.log('PASS unimplemented document endpoint remains clearly 404');
    console.log('PASS CORS preflight returns 204');

  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
})();
￼Enter
