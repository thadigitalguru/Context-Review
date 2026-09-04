const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionStorage } = require('../src/storage/storage');
const { parseRequest } = require('../src/parser/parser');

function makeCapture(text, timestamp) {
  return {
    provider: 'openai',
    timestamp,
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: text }] },
    },
    response: { statusCode: 200, headers: {}, body: { usage: { prompt_tokens: 20, completion_tokens: 5 } } },
    isStreaming: false,
  };
}

// Documents current single-writer semantics: interleaved writers sharing one
// dataDir must never corrupt the snapshot file, even though last-write-wins
// applies (multi-process locking is out of scope by design).
test('interleaved writers sharing a dataDir never corrupt the snapshot', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-concurrency-'));
  const writerA = new SessionStorage({ persistenceDisabled: false, dataDir });
  const writerB = new SessionStorage({ persistenceDisabled: false, dataDir });

  for (let i = 0; i < 10; i++) {
    const captureA = makeCapture(`writer-a-${i}`, Date.now() + i);
    writerA.addCapture(captureA, parseRequest(captureA));
    const captureB = makeCapture(`writer-b-${i}`, Date.now() + 1000 + i);
    writerB.addCapture(captureB, parseRequest(captureB));
  }

  const raw = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.sessions && typeof parsed.sessions === 'object');
  assert.ok(Array.isArray(parsed.captures));

  const reloaded = new SessionStorage({ persistenceDisabled: false, dataDir });
  assert.ok(reloaded.getSessions().length >= 1);

  writerA.close();
  writerB.close();
  reloaded.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
