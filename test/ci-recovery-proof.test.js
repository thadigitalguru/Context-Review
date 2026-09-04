const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('recovery proof validates crash recovery and rollback on production-like volume', () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-proof-artifacts-'));
  const output = execFileSync('node', [path.join(process.cwd(), 'scripts/ci-recovery-proof.js')], {
    env: {
      ...process.env,
      CI_STORAGE_ARTIFACT_DIR: artifactDir,
      CI_RECOVERY_PROOF_CAPTURES: '40',
    },
    encoding: 'utf8',
  });
  assert.match(output, /Recovery proof OK/);

  const artifactFile = path.join(artifactDir, 'recovery-proof.json');
  assert.equal(fs.existsSync(artifactFile), true);
  const parsed = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.seedCaptures, 40);
  assert.ok(parsed.checks.length >= 10);
  assert.ok(parsed.checks.every((c) => c.ok));

  fs.rmSync(artifactDir, { recursive: true, force: true });
});
