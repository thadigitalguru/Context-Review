const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  NORMALIZED_SCHEMA_VERSION,
  normalizeCapture,
  validateNormalizedCapture,
  ensureNormalizedCompatibility,
  resolveSchemaCompatibility,
} = require('../src/parser/normalize');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const CASES = [
  { provider: 'anthropic', capture: 'anthropic-capture.json' },
  { provider: 'openai', capture: 'openai-capture.json' },
  { provider: 'google', capture: 'google-capture.json' },
  { provider: 'anthropic', capture: 'anthropic-edge-capture.json' },
  { provider: 'openai', capture: 'openai-edge-capture.json' },
  { provider: 'google', capture: 'google-edge-capture.json' },
  { provider: 'anthropic', capture: 'anthropic-streaming-capture.json' },
  { provider: 'openai', capture: 'openai-streaming-capture.json' },
  { provider: 'google', capture: 'google-streaming-capture.json' },
];

for (const c of CASES) {
  test(`normalize contract is valid for ${c.provider} fixture (${c.capture})`, () => {
    const capture = loadFixture(c.capture);
    const normalized = normalizeCapture(capture);
    const validation = validateNormalizedCapture(normalized);

    assert.equal(normalized.provider, c.provider);
    assert.equal(normalized.schemaVersion, NORMALIZED_SCHEMA_VERSION);
    assert.equal(validation.ok, true, validation.error || 'expected normalized capture to be valid');
    assert.ok(Array.isArray(normalized.systemPrompts));
    assert.ok(Array.isArray(normalized.toolDefinitions));
    assert.ok(Array.isArray(normalized.items));
    assert.ok(normalized.items.length > 0);
  });
}

test('normalize contract rejects invalid item category', () => {
  const valid = normalizeCapture(loadFixture('openai-capture.json'));
  valid.items[0] = {
    ...valid.items[0],
    category: 'invalid_category',
  };
  const validation = validateNormalizedCapture(valid);
  assert.equal(validation.ok, false);
  assert.match(validation.error, /invalid category/);
});

test('normalize contract rejects invalid schemaVersion format', () => {
  const valid = normalizeCapture(loadFixture('openai-capture.json'));
  valid.schemaVersion = 'v1';
  const validation = validateNormalizedCapture(valid);
  assert.equal(validation.ok, false);
  assert.match(validation.error, /schemaVersion/);
});

test('normalize contract rejects unsupported major schema version', () => {
  const valid = normalizeCapture(loadFixture('openai-capture.json'));
  valid.schemaVersion = '2.0.0';
  const validation = validateNormalizedCapture(valid);
  assert.equal(validation.ok, false);
  assert.match(validation.error, /not supported/);
});

test('ensureNormalizedCompatibility fills missing arrays and keeps schema', () => {
  const compat = ensureNormalizedCompatibility({
    provider: 'openai',
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    model: 'gpt-4o',
  });
  assert.equal(compat.ok, true);
  assert.deepEqual(compat.normalized.systemPrompts, []);
  assert.deepEqual(compat.normalized.toolDefinitions, []);
  assert.deepEqual(compat.normalized.messages, []);
  assert.deepEqual(compat.normalized.items, []);
});

test('resolveSchemaCompatibility validates semver and major support', () => {
  assert.equal(resolveSchemaCompatibility('1.2.3').ok, true);
  assert.equal(resolveSchemaCompatibility('v1').ok, false);
  assert.equal(resolveSchemaCompatibility('3.0.0').ok, false);
});
