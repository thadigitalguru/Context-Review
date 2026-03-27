const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateSnapshotToEventLog } = require('../src/storage/migrate');

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

test('event adapter replays captures across process restart', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-event-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_STORAGE_ADAPTER = 'event';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  delete require.cache[require.resolve('../src/storage/storage')];
  delete require.cache[require.resolve('../src/parser/parser')];

  const { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');

  const capture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });

  const storage = new SessionStorage();
  const first = storage.addCapture(capture, parseRequest(capture));
  const sessionsBefore = storage.getSessions();
  const capturesBefore = storage.getSessionCaptures(first.sessionId);
  assert.equal(sessionsBefore.length, 1);
  assert.equal(capturesBefore.length, 1);

  const reloaded = new SessionStorage();
  const sessionsAfter = reloaded.getSessions();
  const capturesAfter = reloaded.getSessionCaptures(first.sessionId);
  assert.equal(sessionsAfter.length, 1);
  assert.equal(capturesAfter.length, 1);
  assert.equal(capturesAfter[0].provider, 'openai');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('snapshot can migrate into event-backed adapter without losing session data', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-migrate-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  delete process.env.CONTEXT_REVIEW_STORAGE_ADAPTER;
  delete require.cache[require.resolve('../src/storage/storage')];
  delete require.cache[require.resolve('../src/parser/parser')];

  let { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');

  const storage = new SessionStorage({ adapterMode: 'flat', dataDir: tempDir, persistenceDisabled: false });
  const firstCapture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });
  const secondCapture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 2000,
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Second message with more content' }] },
  });

  const first = storage.addCapture(firstCapture, parseRequest(firstCapture));
  storage.addCapture(secondCapture, parseRequest(secondCapture));

  const migration = migrateSnapshotToEventLog(tempDir, { backupExisting: false });
  assert.ok(fs.existsSync(migration.eventFile));
  assert.equal(migration.sessionCount, 1);
  assert.ok(migration.captureCount >= 2);

  delete require.cache[require.resolve('../src/storage/storage')];
  ({ SessionStorage } = require('../src/storage/storage'));
  const eventStorage = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });
  assert.equal(eventStorage.getSessions().length, 1);
  assert.equal(eventStorage.getSessionCaptures(first.sessionId).length, 2);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('event adapter preserves clearAll across restart', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-clear-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_STORAGE_ADAPTER = 'event';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  delete require.cache[require.resolve('../src/storage/storage')];
  delete require.cache[require.resolve('../src/parser/parser')];

  const { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');

  const capture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });
  const storage = new SessionStorage();
  storage.addCapture(capture, parseRequest(capture));
  assert.equal(storage.getSessions().length, 1);

  storage.clearAll();
  assert.equal(storage.getSessions().length, 0);

  const reloaded = new SessionStorage();
  assert.equal(reloaded.getSessions().length, 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
