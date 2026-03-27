const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';
delete require.cache[require.resolve('../src/storage/storage')];
delete require.cache[require.resolve('../src/parser/parser')];

const { SessionStorage } = require('../src/storage/storage');
const { parseRequest } = require('../src/parser/parser');
const { createAPIRouter } = require('../src/api/routes');

function createCapture() {
  return {
    provider: 'openai',
    timestamp: 1000,
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'codex/1.0' },
      body: {
        model: 'gpt-4o',
        tools: [
          {
            type: 'function',
            function: {
              name: 'unused_tool',
              description: 'Never used',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        messages: [
          { role: 'system', content: 'You are Codex.' },
          { role: 'user', content: 'Inspect this output.' },
          { role: 'tool', tool_call_id: 'call-1', content: '<div>Large HTML payload</div>' },
        ],
      },
    },
    response: {
      statusCode: 200,
      headers: {},
      body: {
        model: 'gpt-4o',
        usage: {
          prompt_tokens: 500,
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 50 },
        },
      },
    },
    isStreaming: false,
  };
}

function createCaptureVariant({ timestamp, userText, toolResult }) {
  const base = createCapture();
  return {
    ...base,
    timestamp,
    request: {
      ...base.request,
      body: {
        ...base.request.body,
        messages: [
          { role: 'system', content: 'You are Codex.' },
          { role: 'user', content: userText },
          { role: 'tool', tool_call_id: 'call-1', content: toolResult },
        ],
      },
    },
    response: {
      ...base.response,
      body: {
        ...base.response.body,
        usage: {
          prompt_tokens: Math.max(500, Math.round(userText.length / 2)),
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 50 },
        },
      },
    },
  };
}

function createApp(storage) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAPIRouter(storage));
  return app;
}

function requestApp(app, { method = 'GET', url, body }) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body,
      _body: body !== undefined,
      query: {},
      params: {},
      on(event, handler) {
        if (event === 'data') return this;
        if (event === 'end') process.nextTick(handler);
        return this;
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return this.headers[name.toLowerCase()];
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.setHeader('content-type', 'application/json');
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
      },
      end(payload) {
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
      },
    };

    app.handle(req, res, reject);
  });
}

test('api capture detail route is scoped to the requested session and findings expose savings', async () => {
  const storage = new SessionStorage();
  const capture = createCapture();
  const breakdown = parseRequest(capture);
  const added = storage.addCapture(capture, breakdown);

  const otherCapture = {
    ...capture,
    timestamp: 5000,
    request: {
      ...capture.request,
      headers: { 'user-agent': 'aider/0.50' },
      body: {
        ...capture.request.body,
        messages: [{ role: 'user', content: 'Other session' }],
      },
    },
  };
  const otherAdded = storage.addCapture(otherCapture, parseRequest(otherCapture));

  const app = createApp(storage);

  const scopedMissing = await requestApp(app, {
    url: `/api/sessions/${otherAdded.sessionId}/capture/${added.captureId}`,
  });
  assert.equal(scopedMissing.statusCode, 404);

  const findingsRes = await requestApp(app, {
    url: `/api/sessions/${added.sessionId}/findings`,
  });
  assert.equal(findingsRes.statusCode, 200);
  const findings = findingsRes.body;
  assert.ok(findings.some((finding) => finding.estimatedSavings));
  assert.ok(findings.some((finding) => finding.source || finding.sources || finding.tools));
});

test('api simulate returns before/after deltas for recommendation actions', async () => {
  const storage = new SessionStorage();
  const capture = createCapture();
  const breakdown = parseRequest(capture);
  const added = storage.addCapture(capture, breakdown);
  const app = createApp(storage);

  const simRes = await requestApp(app, {
    method: 'POST',
    url: '/api/simulate',
    body: {
      sessionId: added.sessionId,
      captureId: added.captureId,
      actions: [
        { type: 'remove_tools', params: { names: ['unused_tool'] } },
        { type: 'trim_tool_results', params: { msgIndex: 3, maxTokens: 10 } },
      ],
    },
  });

  assert.equal(simRes.statusCode, 200);
  assert.ok(simRes.body.baseline.total_tokens > 0);
  assert.ok(simRes.body.simulated.total_tokens <= simRes.body.baseline.total_tokens);
  assert.ok(simRes.body.delta.tokens_saved >= 0);
  assert.ok(Array.isArray(simRes.body.simulated.actions));
  assert.equal(simRes.body.simulated.actions.length, 2);
});

test('api trends exposes growth, forecast, alerts, and tool usage', async () => {
  const storage = new SessionStorage();
  const c1 = createCaptureVariant({
    timestamp: 1000,
    userText: 'Short request.',
    toolResult: '<div>small html</div>',
  });
  const c2 = createCaptureVariant({
    timestamp: 2000,
    userText: `Longer request ${'A'.repeat(2400)}`,
    toolResult: `<div>${'B'.repeat(3200)}</div>`,
  });
  const c3 = createCaptureVariant({
    timestamp: 3000,
    userText: `Longest request ${'C'.repeat(4200)}`,
    toolResult: `<div>${'D'.repeat(4200)}</div>`,
  });

  const added = storage.addCapture(c1, parseRequest(c1));
  storage.addCapture(c2, parseRequest(c2));
  storage.addCapture(c3, parseRequest(c3));

  const app = createApp(storage);
  const trendsRes = await requestApp(app, { url: `/api/sessions/${added.sessionId}/trends` });

  assert.equal(trendsRes.statusCode, 200);
  assert.ok(Array.isArray(trendsRes.body.points));
  assert.ok(trendsRes.body.points.length >= 3);
  assert.ok(trendsRes.body.growth.avgDeltaTokens > 0);
  assert.ok(Object.prototype.hasOwnProperty.call(trendsRes.body.forecast, 'turnsRemaining'));
  assert.ok(Array.isArray(trendsRes.body.toolUsage));
});

test('api reports summary exposes top waste drivers and expensive sessions', async () => {
  const storage = new SessionStorage();
  const c1 = createCaptureVariant({
    timestamp: Date.now() - 1000,
    userText: `Report baseline ${'X'.repeat(1200)}`,
    toolResult: `<div>${'Y'.repeat(2800)}</div>`,
  });
  const c2 = createCaptureVariant({
    timestamp: Date.now(),
    userText: `Report follow-up ${'Z'.repeat(1600)}`,
    toolResult: `<div>${'K'.repeat(2400)}</div>`,
  });
  storage.addCapture(c1, parseRequest(c1));
  storage.addCapture(c2, parseRequest(c2));

  const app = createApp(storage);
  const summaryRes = await requestApp(app, { url: '/api/reports/summary' });

  assert.equal(summaryRes.statusCode, 200);
  assert.ok(Array.isArray(summaryRes.body.topWasteDrivers));
  assert.ok(Array.isArray(summaryRes.body.mostExpensiveSessions));
  assert.ok(summaryRes.body.sessionCount >= 1);
});
