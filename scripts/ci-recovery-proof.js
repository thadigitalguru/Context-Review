#!/usr/bin/env node
// Recovery proof against a production-like event log: seeds realistic volume
// across all providers, then walks three failure scenarios every operator
// dreads — torn tail writes, snapshot loss, and a bad write requiring
// rollback — verifying boot auto-recovery, the documented backup-restore
// rollback path, and post-recovery compaction. Fails non-zero on mismatch.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionStorage } = require('../src/storage/storage');
const { parseRequest } = require('../src/parser/parser');

const ARTIFACT_DIR = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'recovery-proof.json');
const SEED_CAPTURES = Number(process.env.CI_RECOVERY_PROOF_CAPTURES || 200);

function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recovery-proof-'));
  const eventFile = path.join(dataDir, 'events.ndjson');
  const snapshotFile = path.join(dataDir, 'sessions.json');
  const checks = [];
  try {
    const seed = seedProductionLike(dataDir, SEED_CAPTURES);
    checks.push(check('seeded production-like volume', seed.captures === SEED_CAPTURES, `captures=${seed.captures}`));

    // Scenario A: torn tail write, snapshot intact. Snapshot covers the torn
    // event, so no capture may be lost.
    tearTail(eventFile, 40);
    const recoveredA = boot(dataDir);
    checks.push(check('A: torn tail with snapshot intact loses nothing',
      recoveredA.captures.length === SEED_CAPTURES, `captures=${recoveredA.captures.length}/${SEED_CAPTURES}`));
    checks.push(check('A: recovery backup was written', listBackups(dataDir).length >= 1, `backups=${listBackups(dataDir).length}`));
    checks.push(check('A: storage healthy after recovery', recoveredA.integrity.degraded === false, `degraded=${recoveredA.integrity.degraded}`));
    recoveredA.storage.close();

    // Scenario B: torn tail write plus snapshot loss. Only the torn write may
    // be lost; everything durable in the log must replay.
    const linesBeforeTear = countLines(eventFile);
    tearTail(eventFile, 40);
    fs.rmSync(snapshotFile, { force: true });
    const recoveredB = boot(dataDir);
    checks.push(check('B: torn tail with snapshot loss loses only the torn write',
      recoveredB.captures.length === linesBeforeTear - 1, `captures=${recoveredB.captures.length}/${linesBeforeTear - 1}`));
    checks.push(check('B: sessions replay from the log', recoveredB.sessions >= 1, `sessions=${recoveredB.sessions}`));
    checks.push(check('B: storage healthy after recovery', recoveredB.integrity.degraded === false, `degraded=${recoveredB.integrity.degraded}`));
    recoveredB.storage.close();

    // Scenario C: rollback. Take a backup, poison the live log, restore the
    // backup over it, and verify the boot is clean with no recovery needed.
    const rollbackBase = boot(dataDir);
    const preRollbackCount = rollbackBase.captures.length;
    const compactRes = rollbackBase.storage.compactEventLog({ reason: 'recovery_proof_baseline', dryRun: false, backupExisting: true });
    rollbackBase.storage.close();
    checks.push(check('C: pre-rollback backup was written', Boolean(compactRes.backupFile) && fs.existsSync(compactRes.backupFile), `backup=${compactRes.backupFile || 'none'}`));
    fs.appendFileSync(eventFile, '{"type":"capture_added","corrupt":tru\n');
    fs.copyFileSync(compactRes.backupFile, eventFile);
    const rolledBack = boot(dataDir);
    checks.push(check('C: rollback restore replays cleanly with no recovery needed',
      rolledBack.captures.length === preRollbackCount && rolledBack.integrity.recovered === false,
      `captures=${rolledBack.captures.length}/${preRollbackCount} recovered=${rolledBack.integrity.recovered}`));
    rolledBack.storage.close();

    // Post-recovery compaction must be stable across reboots.
    const compacter = boot(dataDir);
    const beforeCompact = compacter.captures.length;
    const compacted = compacter.storage.compactEventLog({ reason: 'recovery_proof', dryRun: false, backupExisting: false });
    compacter.storage.close();
    const afterCompact = boot(dataDir);
    checks.push(check('D: post-recovery compaction is stable across reboots',
      compacted.compacted === true && afterCompact.captures.length === beforeCompact,
      `compacted=${compacted.compacted} captures=${afterCompact.captures.length}/${beforeCompact}`));
    afterCompact.storage.close();

    const failed = checks.filter((c) => !c.ok);
    const out = {
      ok: failed.length === 0,
      generatedAt: Date.now(),
      seedCaptures: SEED_CAPTURES,
      checks,
      artifactFile: ARTIFACT_FILE,
    };
    ensureDir(ARTIFACT_DIR);
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify(out, null, 2));
    console.log(`Recovery proof ${out.ok ? 'OK' : 'FAILED'} (${checks.length - failed.length}/${checks.length} checks)`);
    for (const c of checks) console.log(`  [${c.ok ? 'pass' : 'FAIL'}] ${c.name} (${c.detail})`);
    if (!out.ok) process.exitCode = 1;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function boot(dataDir) {
  const storage = new SessionStorage({ adapterMode: 'event', dataDir, persistenceDisabled: false });
  const status = storage.getStorageStatus();
  return {
    storage,
    captures: storage.captures,
    sessions: storage.getSessions().length,
    integrity: status.eventLog?.integrity || {},
  };
}

function seedProductionLike(dataDir, count) {
  const storage = new SessionStorage({ adapterMode: 'event', dataDir, persistenceDisabled: false });
  const providers = ['anthropic', 'openai', 'google'];
  for (let i = 0; i < count; i++) {
    const capture = makeCapture(providers[i % providers.length], i, count);
    storage.addCapture(capture, parseRequest(capture));
  }
  const result = { captures: storage.captures.length, sessions: storage.getSessions().length };
  storage.close();
  return result;
}

function makeCapture(provider, i, total) {
  const html = i % 7 === 0 ? '<div>markup payload</div>' : 'plain result';
  const byProvider = {
    anthropic: {
      path: '/v1/messages',
      body: {
        model: 'claude-sonnet-4-20250514',
        system: 'You are a coding assistant.',
        messages: [
          { role: 'user', content: `Task ${i}: refactor the module` },
          { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: `${html} run ${i}` }] },
        ],
      },
    },
    openai: {
      path: '/v1/responses',
      body: {
        model: 'gpt-4o',
        instructions: 'You are helpful.',
        input: `Task ${i}: fix the test`,
      },
    },
    google: {
      path: '/v1beta/models/gemini-2.5-flash:generateContent',
      body: {
        model: 'gemini-2.5-flash',
        systemInstruction: { parts: [{ text: 'You are helpful.' }] },
        contents: [{ role: 'user', parts: [{ text: `Task ${i}: review the diff` }] }],
      },
    },
  };
  const shape = byProvider[provider];
  return {
    provider,
    timestamp: Date.now() - (total - i) * 1000,
    request: { method: 'POST', path: shape.path, headers: { 'user-agent': 'proof-seed/1.0' }, body: shape.body },
    response: { statusCode: 200, headers: {}, body: { content: [{ type: 'text', text: 'ok' }] } },
    isStreaming: false,
  };
}

function tearTail(eventFile, bytes) {  // Torn write: chop the final bytes so the log ends mid-line, as a killed
  // process would leave it.
  const fd = fs.openSync(eventFile, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    fs.ftruncateSync(fd, Math.max(0, size - bytes));
  } finally {
    fs.closeSync(fd);
  }
}

function countLines(eventFile) {
  const raw = fs.readFileSync(eventFile, 'utf8');
  return raw.split('\n').filter((line) => line.trim().length > 0).length;
}

function listBackups(dataDir) {
  return fs.readdirSync(dataDir)
    .filter((name) => name.includes('.bak') || name.includes('.corrupt.'))
    .map((name) => {
      const file = path.join(dataDir, name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    });
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: String(detail) };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (require.main === module) main();

module.exports = { seedProductionLike, tearTail, listBackups };
