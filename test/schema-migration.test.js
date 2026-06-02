const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildSchemaMigrationChecklist } = require('../src/parser/normalize');

test('schema migration vectors cover current 1.x and future 2.x planning', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-migration-vectors.json'), 'utf8'));

  for (const vector of vectors) {
    const checklist = buildSchemaMigrationChecklist(vector.normalized, vector.targetVersion);
    assert.equal(checklist.canAutoMigrate, vector.canAutoMigrate, vector.name);
    assert.ok(Array.isArray(checklist.checklist));
    assert.ok(checklist.checklist.length >= 4);
    assert.ok(Array.isArray(checklist.notes));
    if (vector.name === 'future-2.x') {
      assert.match(checklist.notes.join(' '), /migration layer/i);
    }
  }
});
