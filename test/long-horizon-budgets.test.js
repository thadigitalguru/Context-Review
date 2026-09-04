const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEffectiveThresholds } = require('../scripts/ci-long-horizon-benchmark');

const STATIC = { filterMaxMs: 1400, reportMaxMs: 5200, compareMaxMs: 3200, ciCheckMaxMs: 2500 };

test('baseline budgets tighten toward history but respect floors and ceilings', () => {
  const effective = resolveEffectiveThresholds(
    { filterMaxMs: 2, reportMaxMs: 27, compareMaxMs: 57, ciCheckMaxMs: 38 },
    STATIC,
    0.05,
  );
  assert.deepEqual(effective, { filterMaxMs: 70, reportMaxMs: 260, compareMaxMs: 160, ciCheckMaxMs: 125 });
});

test('history can never loosen the gate above static maxima', () => {
  const effective = resolveEffectiveThresholds(
    { filterMaxMs: 5000, reportMaxMs: 9000, compareMaxMs: 9000, ciCheckMaxMs: 9000 },
    STATIC,
    0.05,
  );
  assert.deepEqual(effective, STATIC);
});

test('missing recommendations fall back to static maxima', () => {
  const effective = resolveEffectiveThresholds({}, STATIC, 0.05);
  assert.deepEqual(effective, STATIC);
});

test('mid-range recommendations pass through unchanged', () => {
  const effective = resolveEffectiveThresholds(
    { filterMaxMs: 500, reportMaxMs: 1000, compareMaxMs: 1000, ciCheckMaxMs: 1000 },
    STATIC,
    0.05,
  );
  assert.deepEqual(effective, { filterMaxMs: 500, reportMaxMs: 1000, compareMaxMs: 1000, ciCheckMaxMs: 1000 });
});
