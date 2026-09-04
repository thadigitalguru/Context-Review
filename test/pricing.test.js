const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateCost,
  findPricing,
  getContextWindow,
  isKnownModel,
  getPricingMetadata,
  MODEL_PRICING,
  PRICING_VERSION,
} = require('../src/cost/pricing');
const { countTokens, clearEncodingCache } = require('../src/tokens/counter');

test('findPricing prefers exact and longest-substring matches', () => {
  assert.equal(findPricing('gpt-4o-mini'), MODEL_PRICING['gpt-4o-mini']);
  assert.equal(findPricing('gpt-4o'), MODEL_PRICING['gpt-4o']);
  assert.equal(findPricing('o1-mini'), MODEL_PRICING['o1-mini']);
  assert.equal(findPricing('o1'), MODEL_PRICING['o1']);
  assert.equal(findPricing('claude-3-5-haiku-20241022'), MODEL_PRICING['claude-3-5-haiku-20241022']);
});

test('findPricing falls back by family and then default', () => {
  assert.equal(findPricing('claude-future-x').input, MODEL_PRICING['claude-sonnet-4-20250514'].input);
  assert.equal(findPricing('gpt-4-future').input, MODEL_PRICING['gpt-4'].input);
  assert.equal(findPricing('gemini-future').input, MODEL_PRICING['gemini-2.5-flash'].input);
  const unknown = findPricing('mystery-model-9');
  assert.equal(unknown.input, 3.0);
  assert.equal(unknown.output, 15.0);
  assert.equal(findPricing(null).input, 3.0);
});

test('isKnownModel distinguishes table models from fallbacks', () => {
  assert.equal(isKnownModel('gpt-4o'), true);
  assert.equal(isKnownModel('gpt-4o-mini'), true);
  assert.equal(isKnownModel('claude-sonnet-4-20250514'), true);
  assert.equal(isKnownModel('unknown'), false);
  assert.equal(isKnownModel(''), false);
  assert.equal(isKnownModel(null), false);
  assert.equal(isKnownModel('mystery-model-9'), false);
});

test('pricing metadata exposes version for drift tracking', () => {
  const meta = getPricingMetadata();
  assert.equal(meta.version, PRICING_VERSION);
  assert.ok(meta.updatedAt);
  assert.equal(meta.modelCount, Object.keys(MODEL_PRICING).length);
});

test('calculateCost applies cache read/write rates and savings', () => {
  const cost = calculateCost(1000, 100, 'claude-sonnet-4-20250514', { read: 400, creation: 100 });
  assert.ok(cost.totalCost > 0);
  assert.ok(cost.cacheSavings > 0);
  assert.equal(cost.cacheReadTokens, 400);
  assert.equal(cost.cacheCreationTokens, 100);
  assert.equal(cost.standardInputTokens, 500);
  const plain = calculateCost(1000, 100, 'gpt-4o');
  assert.equal(plain.cacheSavings, 0);
  assert.equal(plain.standardInputTokens, 1000);
});

test('getContextWindow returns per-model windows', () => {
  assert.equal(getContextWindow('gpt-4o'), 128000);
  assert.equal(getContextWindow('gemini-2.5-pro'), 1048576);
});

test('token counter reuses cached encodings with identical results', () => {
  clearEncodingCache();
  const first = countTokens('Write a concise summary of this file.', { model: 'gpt-4o' });
  const second = countTokens('Write a concise summary of this file.', { model: 'gpt-4o' });
  assert.equal(first.tokens, second.tokens);
  assert.ok(first.method.startsWith('tiktoken_'));
});

test('token counter falls back for oversized payloads without blocking', () => {
  const big = 'x'.repeat(600_000);
  const result = countTokens(big, { model: 'gpt-4o' });
  assert.equal(result.method, 'heuristic_large_payload');
  assert.equal(result.confidence, 'low');
});
