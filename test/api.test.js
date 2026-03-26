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

function createApp(storage) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAPIRouter(storage));
  return app;
}

function requestApp(app, { method = 'GET', url }) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      headers: {},
      body: undefined,
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
