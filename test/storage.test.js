const test = require('node:test');
const assert = require('node:assert/strict');

function createCapture({ provider, model, agentUserAgent, timestamp, body }) {
  return {
    provider,
    timestamp,
    request: {
      method: 'POST',
      path: provider === 'openai' ? '/v1/chat/completions' : '/v1/messages',
      headers: { 'user-agent': agentUserAgent },
      body: body || {
        model,
        messages: [{ role: 'user', content: 'Hello' }],
      },
    },
    response: {
      statusCode: 200,
      headers: {},
      body: provider === 'openai'
        ? { model, usage: { prompt_tokens: 10, completion_tokens: 2 } }
        : { model, usage: { input_tokens: 10, output_tokens: 2 } },
    },
    isStreaming: false,
  };
}

test('session storage separates sessions by agent identity within the same provider window', () => {
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';
  delete require.cache[require.resolve('../src/storage/storage')];
  delete require.cache[require.resolve('../src/parser/parser')];

  const { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');

  const storage = new SessionStorage();
  const firstCapture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });
  const secondCapture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'aider/0.50',
    timestamp: 2000,
  });

  const first = storage.addCapture(firstCapture, parseRequest(firstCapture));
  const second = storage.addCapture(secondCapture, parseRequest(secondCapture));

  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(storage.getSessions().length, 2);
});

test('session storage computes diffs across captures in the same session', () => {
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';
  delete require.cache[require.resolve('../src/storage/storage')];
  delete require.cache[require.resolve('../src/parser/parser')];

  const { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');

  const storage = new SessionStorage();
  const firstCapture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
    body: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Short' }],
    },
  });
  const secondCapture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 2000,
    body: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'This message is longer than the previous one.' }],
    },
  });

  const first = storage.addCapture(firstCapture, parseRequest(firstCapture));
  storage.addCapture(secondCapture, parseRequest(secondCapture));

  const timeline = storage.getTimeline(first.sessionId);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[1].diff.total.direction, 'grew');
  assert.ok(timeline[1].diff.total.delta > 0);
});
