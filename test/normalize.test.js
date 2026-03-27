const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { normalizeCapture, validateNormalizedCapture } = require('../src/parser/normalize');

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
];

for (const c of CASES) {
  test(`normalize contract is valid for ${c.provider} fixture (${c.capture})`, () => {
    const capture = loadFixture(c.capture);
    const normalized = normalizeCapture(capture);
    const validation = validateNormalizedCapture(normalized);

    assert.equal(normalized.provider, c.provider);
    assert.equal(normalized.schemaVersion, '1.0.0');
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
