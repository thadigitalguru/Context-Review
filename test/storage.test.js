const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateSnapshotToEventLog } = require('../src/storage/migrate');
const { generateFindings } = require('../src/findings/findings');

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

function clearStorageModuleCache() {
  delete require.cache[require.resolve('../src/storage/storage')];
  delete require.cache[require.resolve('../src/parser/parser')];
}

function sortById(items) {
  return [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

test('session storage separates sessions by agent identity within the same provider window', () => {
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';
  clearStorageModuleCache();

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
  clearStorageModuleCache();

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
  clearStorageModuleCache();

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
  clearStorageModuleCache();

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

  clearStorageModuleCache();
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
  clearStorageModuleCache();

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

test('flat snapshot and event-backed storage return equivalent sessions captures and findings after migration', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-parity-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  delete process.env.CONTEXT_REVIEW_STORAGE_ADAPTER;
  clearStorageModuleCache();

  let { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');
  const flatStorage = new SessionStorage({ adapterMode: 'flat', dataDir: tempDir, persistenceDisabled: false });

  const c1 = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'First prompt' }] },
  });
  const c2 = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 2000,
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Second prompt with more detail' }] },
  });
  const c3 = createCapture({
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    agentUserAgent: 'claude-code/0.1',
    timestamp: 3000,
    body: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'Anthropic turn' }] },
  });

  const first = flatStorage.addCapture(c1, parseRequest(c1));
  flatStorage.addCapture(c2, parseRequest(c2));
  flatStorage.addCapture(c3, parseRequest(c3));

  const flatSessions = sortById(flatStorage.getSessions());
  const flatCaptures = sortById(flatStorage.captures);

  const migration = migrateSnapshotToEventLog(tempDir, { backupExisting: false, verify: true });
  assert.equal(migration.verified, true);
  assert.equal(migration.verification.ok, true);

  clearStorageModuleCache();
  ({ SessionStorage } = require('../src/storage/storage'));
  const eventStorage = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });
  const eventSessions = sortById(eventStorage.getSessions());
  const eventCaptures = sortById(eventStorage.captures);

  assert.deepEqual(eventSessions, flatSessions);
  assert.deepEqual(eventCaptures, flatCaptures);
  assert.deepEqual(eventStorage.getTimeline(first.sessionId), flatStorage.getTimeline(first.sessionId));

  const targetSession = flatSessions.find((session) => session.provider === 'openai');
  const flatFindings = generateFindings(targetSession, flatStorage.getSessionCaptures(targetSession.id));
  const eventFindings = generateFindings(
    eventStorage.getSession(targetSession.id),
    eventStorage.getSessionCaptures(targetSession.id),
  );
  assert.deepEqual(eventFindings, flatFindings);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('migration supports dry-run report and backup creation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-migrate-flow-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  delete process.env.CONTEXT_REVIEW_STORAGE_ADAPTER;
  clearStorageModuleCache();

  const { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');

  const storage = new SessionStorage({ adapterMode: 'flat', dataDir: tempDir, persistenceDisabled: false });
  const capture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });
  storage.addCapture(capture, parseRequest(capture));

  const eventFile = path.join(tempDir, 'events.ndjson');
  fs.writeFileSync(eventFile, '{"type":"clear_all","timestamp":1}\n');

  const dryRun = migrateSnapshotToEventLog(tempDir, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.existingEventFile, true);
  assert.equal(dryRun.wouldBackup, true);
  assert.equal(dryRun.wouldWriteSeedEvent, true);
  assert.equal(fs.readFileSync(eventFile, 'utf8'), '{"type":"clear_all","timestamp":1}\n');

  const migrated = migrateSnapshotToEventLog(tempDir, { verify: true });
  assert.equal(migrated.dryRun, false);
  assert.equal(migrated.verified, true);
  assert.equal(migrated.verification.ok, true);
  assert.ok(migrated.backupFile);
  assert.ok(fs.existsSync(migrated.backupFile));

  const lines = fs.readFileSync(eventFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const seed = JSON.parse(lines[0]);
  assert.equal(seed.type, 'seed_state');
  assert.ok(seed.state);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('event log compaction keeps replayed state identical while shrinking retained events', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-compact-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  process.env.CONTEXT_REVIEW_STORAGE_ADAPTER = 'event';
  clearStorageModuleCache();

  let { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');
  const storage = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });

  for (let i = 0; i < 8; i++) {
    const capture = createCapture({
      provider: 'openai',
      model: 'gpt-4o',
      agentUserAgent: 'codex/1.0',
      timestamp: 1_000 + i * 1_000,
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: `turn-${i}` }] },
    });
    storage.addCapture(capture, parseRequest(capture));
  }

  const sessionsBefore = sortById(storage.getSessions());
  const capturesBefore = sortById(storage.captures);
  const eventFile = path.join(tempDir, 'events.ndjson');
  const linesBefore = fs.readFileSync(eventFile, 'utf8').trim().split('\n').length;

  const compacted = storage.compactEventLog({
    maxEvents: 2,
    backupExisting: false,
    reason: 'test',
  });
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.stats.retainedEvents, 2);

  const linesAfter = fs.readFileSync(eventFile, 'utf8').trim().split('\n').length;
  assert.ok(linesAfter <= 3);
  assert.ok(linesAfter < linesBefore);

  clearStorageModuleCache();
  ({ SessionStorage } = require('../src/storage/storage'));
  const reloaded = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });
  assert.deepEqual(sortById(reloaded.getSessions()), sessionsBefore);
  assert.deepEqual(sortById(reloaded.captures), capturesBefore);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('event log compaction dry-run reports changes without mutating file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-compact-dry-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  process.env.CONTEXT_REVIEW_STORAGE_ADAPTER = 'event';
  clearStorageModuleCache();

  const { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');
  const storage = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });

  for (let i = 0; i < 3; i++) {
    const capture = createCapture({
      provider: 'openai',
      model: 'gpt-4o',
      agentUserAgent: 'codex/1.0',
      timestamp: 2_000 + i * 1_000,
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: `dry-${i}` }] },
    });
    storage.addCapture(capture, parseRequest(capture));
  }

  const eventFile = path.join(tempDir, 'events.ndjson');
  const before = fs.readFileSync(eventFile, 'utf8');
  const report = storage.compactEventLog({
    maxEvents: 1,
    dryRun: true,
    backupExisting: false,
    reason: 'test-dry',
  });
  const after = fs.readFileSync(eventFile, 'utf8');

  assert.equal(report.dryRun, true);
  assert.equal(report.compacted, false);
  assert.equal(before, after);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('startup auto-recovers event log on malformed JSON and preserves last valid state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recover-json-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  process.env.CONTEXT_REVIEW_STORAGE_ADAPTER = 'event';
  clearStorageModuleCache();

  let { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');
  const storage = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });

  const capture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });
  const added = storage.addCapture(capture, parseRequest(capture));
  const eventFile = path.join(tempDir, 'events.ndjson');
  fs.appendFileSync(eventFile, '{"type":"capture_added"');
  fs.appendFileSync(eventFile, '\n{"type":"clear_all","timestamp":2000}\n');

  clearStorageModuleCache();
  ({ SessionStorage } = require('../src/storage/storage'));
  const reloaded = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });
  const status = reloaded.getStorageStatus();
  assert.equal(reloaded.getSessionCaptures(added.sessionId).length, 1);
  assert.equal(status.eventLog.integrity.recovered, true);
  assert.equal(status.eventLog.integrity.reason, 'invalid_json_line');
  assert.ok(status.eventLog.integrity.backupFile);
  assert.ok(fs.existsSync(status.eventLog.integrity.backupFile));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('startup auto-recovers when event log ends with a partial line', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recover-partial-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  process.env.CONTEXT_REVIEW_STORAGE_ADAPTER = 'event';
  clearStorageModuleCache();

  let { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');
  const storage = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });

  const capture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });
  const added = storage.addCapture(capture, parseRequest(capture));
  const eventFile = path.join(tempDir, 'events.ndjson');
  fs.appendFileSync(eventFile, '{"type":"clear_all"');

  clearStorageModuleCache();
  ({ SessionStorage } = require('../src/storage/storage'));
  const reloaded = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });
  const status = reloaded.getStorageStatus();
  assert.equal(reloaded.getSessionCaptures(added.sessionId).length, 1);
  assert.equal(status.eventLog.integrity.recovered, true);
  assert.equal(status.eventLog.integrity.reason, 'partial_last_line');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('startup auto-recovers when event shape is invalid', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recover-shape-'));
  process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '0';
  process.env.CONTEXT_REVIEW_DATA_DIR = tempDir;
  process.env.CONTEXT_REVIEW_STORAGE_ADAPTER = 'event';
  clearStorageModuleCache();

  let { SessionStorage } = require('../src/storage/storage');
  const { parseRequest } = require('../src/parser/parser');
  const storage = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });

  const capture = createCapture({
    provider: 'openai',
    model: 'gpt-4o',
    agentUserAgent: 'codex/1.0',
    timestamp: 1000,
  });
  const added = storage.addCapture(capture, parseRequest(capture));
  const eventFile = path.join(tempDir, 'events.ndjson');
  fs.appendFileSync(eventFile, '\n{"type":"capture_added","timestamp":2}\n');

  clearStorageModuleCache();
  ({ SessionStorage } = require('../src/storage/storage'));
  const reloaded = new SessionStorage({ adapterMode: 'event', dataDir: tempDir, persistenceDisabled: false });
  const status = reloaded.getStorageStatus();
  assert.equal(reloaded.getSessionCaptures(added.sessionId).length, 1);
  assert.equal(status.eventLog.integrity.recovered, true);
  assert.equal(status.eventLog.integrity.reason, 'invalid_event_shape');

  fs.rmSync(tempDir, { recursive: true, force: true });
});
