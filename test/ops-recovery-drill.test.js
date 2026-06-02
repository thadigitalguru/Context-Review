const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { migrateSnapshotToEventLog } = require('../src/storage/migrate');

test('ops recovery drill emits checklist and dry-run data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recovery-'));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recovery-artifacts-'));
  const output = execFileSync('node', [path.join(process.cwd(), 'scripts/ops-recovery-drill.js')], {
    env: {
      ...process.env,
      CONTEXT_REVIEW_DATA_DIR: dir,
      CI_STORAGE_ARTIFACT_DIR: artifactDir,
      CONTEXT_REVIEW_DISABLE_PERSISTENCE: '1',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.checklist));
  assert.ok(parsed.checklist.length >= 4);
  assert.ok(parsed.dryRuns);
  assert.equal(parsed.artifactFile, path.join(artifactDir, 'recovery-drill.json'));
  assert.equal(fs.existsSync(parsed.artifactFile), true);
  assert.equal(JSON.parse(fs.readFileSync(parsed.artifactFile, 'utf8')).ok, true);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(artifactDir, { recursive: true, force: true });
});

test('ops recovery drill can validate a provided backup file', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recovery-data-'));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-recovery-artifacts-'));
  const backupSnapshot = path.join(dataDir, 'sessions.json');
  fs.writeFileSync(backupSnapshot, JSON.stringify({
    sessions: {
      session_1: {
        id: 'session_1',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: 1,
        lastActivity: 1,
        requestCount: 1,
        totalInputTokens: 10,
        totalOutputTokens: 2,
        project: 'alpha',
        user: 'tester',
        agent: 'unknown',
        agents: ['unknown'],
      },
    },
    captures: [],
  }, null, 2));
  const migrated = migrateSnapshotToEventLog(dataDir, { backupExisting: false, verify: false });

  const output = execFileSync('node', [path.join(process.cwd(), 'scripts/ops-recovery-drill.js'), '--backup-file', migrated.eventFile], {
    env: {
      ...process.env,
      CONTEXT_REVIEW_DATA_DIR: dataDir,
      CI_STORAGE_ARTIFACT_DIR: artifactDir,
      CONTEXT_REVIEW_DISABLE_PERSISTENCE: '1',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.selectedBackupFile, migrated.eventFile);
  assert.equal(parsed.replayValidation.ok, true);
  assert.ok(parsed.replayValidation.eventCount >= 1);

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(artifactDir, { recursive: true, force: true });
});
