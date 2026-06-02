#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildSchemaMigrationChecklist } = require('../src/parser/normalize');

function main() {
  try {
    const fixtureFile = process.env.CI_SCHEMA_MIGRATION_FIXTURES || path.join(process.cwd(), 'test/fixtures/schema-migration-vectors.json');
    const outputFile = process.env.CI_SCHEMA_MIGRATION_REPORT_FILE || path.join(process.cwd(), 'artifacts/schema-migration-harness.json');
    const vectors = loadVectors(fixtureFile);
    const checks = vectors.map((vector) => {
      const checklist = buildSchemaMigrationChecklist(vector.normalized, vector.targetVersion);
      return {
        name: vector.name,
        targetVersion: vector.targetVersion,
        canAutoMigrate: checklist.canAutoMigrate,
        expectedCanAutoMigrate: vector.canAutoMigrate,
        pass: checklist.canAutoMigrate === vector.canAutoMigrate,
        currentVersion: checklist.currentVersion,
        currentMajor: checklist.currentMajor,
        targetMajor: checklist.targetMajor,
        notes: checklist.notes,
        checklist: checklist.checklist,
      };
    });

    const failures = checks.filter((item) => !item.pass);
    const report = {
      generatedAt: Date.now(),
      fixtureFile,
      vectorCount: checks.length,
      passCount: checks.length - failures.length,
      failCount: failures.length,
      failures,
      checks,
    };

    ensureDir(path.dirname(outputFile));
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`schema migration harness failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function loadVectors(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Fixture file not found: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error('Schema migration fixtures must be an array');
  }
  return raw;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
