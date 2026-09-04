const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';

const { redactHeaders, sanitizeCaptureHeaders, REDACTED_VALUE } = require('../src/proxy/redact');
const { SessionStorage } = require('../src/storage/storage');
const { parseRequest } = require('../src/parser/parser');
const { createAPIRouter } = require('../src/api/routes');

function createApp(storage, options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAPIRouter(storage, options));
  return app;
}

function requestApp(app, { method = 'GET', url, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const { URL } = require('url');
    const parsed = new URL(url, 'http://localhost');
    const req = {
      method,
      url: `${parsed.pathname}${parsed.search}`,
      headers: { ...headers },
      body,
      query: Object.fromEntries(parsed.searchParams.entries()),
      params: {},
      on(event, handler) {
        if (event === 'end') process.nextTick(handler);
        return this;
      },
    };
    const res = {
      statusCode: 200,
      body: null,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
      send(payload) { this.body = payload; resolve(this); return this; },
      setHeader(k, v) { this.headers[k] = v; },
      on() { return this; },
    };
    const next = () => {};
    app.handle(req, res, (err) => (err ? reject(err) : resolve(res)));
  });
}

test('redactHeaders masks sensitive headers case-insensitively and preserves others', () => {
  const out = redactHeaders({
    authorization: 'Bearer sk-secret',
    'X-Api-Key': 'key-secret',
    Cookie: 'session=abc',
    'x-context-review-api-key': 'viewer-token',
    'user-agent': 'codex/1.0',
    'x-context-review-project': 'platform',
  });
  assert.equal(out.authorization, REDACTED_VALUE);
  assert.equal(out['X-Api-Key'], REDACTED_VALUE);
  assert.equal(out.Cookie, REDACTED_VALUE);
  assert.equal(out['x-context-review-api-key'], REDACTED_VALUE);
  assert.equal(out['user-agent'], 'codex/1.0');
  assert.equal(out['x-context-review-project'], 'platform');
});

test('sanitizeCaptureHeaders redacts request headers without mutating original', () => {
  const capture = {
    request: { method: 'POST', path: '/v1/messages', headers: { authorization: 'Bearer x' } },
  };
  const sanitized = sanitizeCaptureHeaders(capture);
  assert.equal(sanitized.request.headers.authorization, REDACTED_VALUE);
  assert.equal(capture.request.headers.authorization, 'Bearer x');
});

test('storage entries and LHAR export never persist upstream secrets', () => {
  const storage = new SessionStorage({ persistenceDisabled: true });
  const capture = {
    provider: 'anthropic',
    timestamp: Date.now(),
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer sk-ant-secret',
        'x-api-key': 'ant-secret',
        cookie: 'sess=1',
        'user-agent': 'claude-code',
      },
      body: { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
    },
    response: { statusCode: 200, headers: {}, body: { content: [{ type: 'text', text: 'ok' }] } },
    isStreaming: false,
  };
  const breakdown = parseRequest(capture);
  const { sessionId, captureId } = storage.addCapture(capture, breakdown);
  const detail = storage.getCaptureDetail(captureId);
  const serialized = JSON.stringify(detail);
  assert.ok(!serialized.includes('sk-ant-secret'), 'secret must not persist');
  assert.ok(!serialized.includes('ant-secret'), 'api key must not persist');
  const lhar = storage.exportLHAR(sessionId);
  assert.ok(!JSON.stringify(lhar).includes('sk-ant-secret'));
});

test('anonymous mutations can be denied when strict flag is enabled', async () => {
  const storage = new SessionStorage({ persistenceDisabled: true });
  const openApp = createApp(storage, {});
  const strictApp = createApp(storage, { auth: { requireAuthForMutations: true } });

  const openDelete = await requestApp(openApp, { method: 'DELETE', url: '/api/sessions' });
  assert.equal(openDelete.statusCode, 200);

  const strictDelete = await requestApp(strictApp, { method: 'DELETE', url: '/api/sessions' });
  assert.equal(strictDelete.statusCode, 401);
});
