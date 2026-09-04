const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';

const { SessionStorage } = require('../src/storage/storage');
const { createAPIRouter } = require('../src/api/routes');
const { resolveBudgetThresholds, DEFAULT_BUDGET_THRESHOLDS } = require('../src/analysis/session-analysis');

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
    app.handle(req, res, (err) => (err ? reject(err) : resolve(res)));
  });
}

function seedSession(storage) {
  const capture = {
    provider: 'openai',
    timestamp: Date.now(),
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    },
    response: { statusCode: 200, headers: {}, body: { usage: { prompt_tokens: 20, completion_tokens: 5 } } },
    isStreaming: false,
  };
  const { parseRequest } = require('../src/parser/parser');
  return storage.addCapture(capture, parseRequest(capture));
}

test('simulate rejects unknown action types with supported list', async () => {
  const storage = new SessionStorage({ persistenceDisabled: true });
  const { sessionId, captureId } = seedSession(storage);
  const app = createApp(storage, {});
  const res = await requestApp(app, {
    method: 'POST',
    url: '/api/simulate',
    body: { sessionId, captureId, actions: [{ type: 'delete_everything' }] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Unknown simulation action/);
});

test('simulate survives circular breakdown payloads with 400 instead of 500', async () => {
  const storage = new SessionStorage({ persistenceDisabled: true });
  const app = createApp(storage, {});
  const circular = { total_tokens: 10 };
  circular.self = circular;
  const res = await requestApp(app, {
    method: 'POST',
    url: '/api/simulate',
    body: { breakdown: circular, actions: [{ type: 'compact_history' }] },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error);
});

test('ci/check rejects non-object payloads', async () => {
  const storage = new SessionStorage({ persistenceDisabled: true });
  const app = createApp(storage, {});
  const res = await requestApp(app, { method: 'POST', url: '/api/ci/check', body: [1, 2, 3] });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /JSON object/);
});

test('single-pass cache-token aggregation matches per-session extraction', async () => {
  const storage = new SessionStorage({ persistenceDisabled: true });
  const { parseRequest } = require('../src/parser/parser');
  const { calculateCost } = require('../src/cost/pricing');
  for (let i = 0; i < 3; i++) {
    const capture = {
      provider: 'openai',
      timestamp: Date.now() + i,
      request: {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: `hello ${i}` }] },
      },
      response: {
        statusCode: 200,
        headers: {},
        body: { usage: { prompt_tokens: 40, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } },
      },
      isStreaming: false,
    };
    storage.addCapture(capture, parseRequest(capture));
  }
  const bySession = storage.getCacheTokensBySession();
  assert.ok(bySession.size >= 1);
  for (const session of storage.getSessions()) {
    const captures = storage.getSessionCaptures(session.id);
    let read = 0;
    let creation = 0;
    for (const c of captures) {
      read += c.breakdown?.response_tokens?.cacheRead || 0;
      creation += c.breakdown?.response_tokens?.cacheCreation || 0;
    }
    const expected = read === 0 && creation === 0 ? null : { read, creation };
    assert.deepEqual(bySession.get(session.id) || null, expected);
  }
  const app = createApp(storage, {});
  const sessionsRes = await requestApp(app, { url: '/api/sessions' });
  assert.equal(sessionsRes.statusCode, 200);
  const statsRes = await requestApp(app, { url: '/api/stats' });
  assert.equal(statsRes.statusCode, 200);
  assert.ok(statsRes.body.totalCost > 0);
  const [first] = sessionsRes.body;
  const expectedCost = calculateCost(first.totalInputTokens, first.totalOutputTokens, first.model, bySession.get(first.id) || null);
  assert.equal(first.cost.totalCost, expectedCost.totalCost);
});

test('resolveBudgetThresholds falls back to defaults on garbage env', () => {
  const keys = [
    'CONTEXT_REVIEW_BUDGET_MAX_INPUT_TOKENS_PER_REQUEST',
    'CONTEXT_REVIEW_BUDGET_MAX_COST_PER_REQUEST',
    'CONTEXT_REVIEW_BUDGET_MAX_TOTAL_COST_PER_PROJECT',
    'CONTEXT_REVIEW_BUDGET_MAX_SESSION_COST',
  ];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    process.env[key] = 'not-a-number';
  }
  try {
    assert.deepEqual(resolveBudgetThresholds(), { ...DEFAULT_BUDGET_THRESHOLDS });
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
