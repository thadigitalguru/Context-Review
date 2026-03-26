const test = require('node:test');
const assert = require('node:assert/strict');

const { countTokens } = require('../src/tokens/counter');

test('uses tiktoken-backed counting for supported openai models', () => {
  const result = countTokens('Write a concise summary of this file.', { model: 'gpt-4o', label: 'unit_test' });
  assert.ok(result.tokens > 0);
  assert.ok(result.method.startsWith('tiktoken_'));
  assert.equal(result.confidence, 'high');
});

test('falls back to heuristic counting for unsupported models', () => {
  const result = countTokens('Count me heuristically.', { model: 'claude-sonnet-4-20250514', label: 'unit_test' });
  assert.ok(result.tokens > 0);
  assert.equal(result.method, 'heuristic_chars');
  assert.equal(result.confidence, 'low');
});
