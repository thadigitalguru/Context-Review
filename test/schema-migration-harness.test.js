const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('schema migration harness emits a report for current and future vectors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-schema-harness-'));
  const outputFile = path.join(dir, 'schema-migration-report.json');
  const fixtureFile = path.join(process.cwd(), 'test', 'fixtures', 'schema-migration-vectors.json');

  const output = execFileSync('node', [path.join(process.cwd(), 'scripts', 'ci-schema-migration-harness.js')], {
    env: {
      ...process.env,
      CI_SCHEMA_MIGRATION_FIXTURES: fixtureFile,
      CI_SCHEMA_MIGRATION_REPORT_FILE: outputFile,
    },
    encoding: 'utf8',
  });

  const report = JSON.parse(output);
  const artifact = JSON.parse(fs.readFileSync(outputFile, 'utf8'));

  assert.equal(report.vectorCount, artifact.vectorCount);
  assert.equal(report.failCount, 0);
  assert.equal(artifact.failCount, 0);
  assert.ok(Array.isArray(artifact.checks));
  assert.ok(artifact.checks.length >= 2);
  assert.match(JSON.stringify(artifact.checks), /future-2\.x/);

  fs.rmSync(dir, { recursive: true, force: true });
});
