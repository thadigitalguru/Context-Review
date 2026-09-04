const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeThresholds,
  buildBudgetView,
  saveThresholds,
  loadThresholds,
  clearThresholds,
  isUsingCustomThresholds,
  describeThresholdConflict,
  buildBudgetExportPayload,
  buildBudgetShareText,
  parseBudgetShareText,
} = require('../public/js/budget-helpers.js');

test('budget helpers normalize thresholds and rebuild alerts from custom values', () => {
  const budget = {
    thresholds: {
      maxAvgInputTokensPerRequest: 1500,
      maxAvgCostPerRequest: 0.05,
      maxTotalCostPerProject: 1.0,
      maxSessionCost: 0.25,
    },
    items: [
      {
        project: 'alpha',
        sessionCount: 3,
        requestCount: 30,
        totalInputTokens: 70000,
        totalOutputTokens: 8000,
        totalCost: 1.4,
        maxSessionCost: 0.4,
        avgInputTokensPerRequest: 2300,
        avgCostPerRequest: 0.06,
        alerts: [],
      },
    ],
    alerts: [],
  };

  const defaults = normalizeThresholds({}, budget.thresholds);
  const view = buildBudgetView(budget, { ...defaults, maxAvgInputTokensPerRequest: 1200, maxAvgCostPerRequest: 0.04 });

  assert.equal(view.items[0].alerts.length >= 2, true);
  assert.equal(view.items[0].riskScore > 0, true);
  assert.equal(isUsingCustomThresholds(budget, view.thresholds), true);
});

test('budget helpers build shareable export payloads', () => {
  const payload = buildBudgetExportPayload({
    project: 'alpha',
    thresholds: { maxAvgInputTokensPerRequest: 1200 },
    source: 'storage',
    updatedAt: 1234,
  });
  const shareText = buildBudgetShareText(payload);

  assert.equal(payload.project, 'alpha');
  assert.equal(payload.source, 'storage');
  assert.equal(payload.thresholds.maxAvgInputTokensPerRequest, 1200);
  assert.match(shareText, /"project": "alpha"/);
});

test('budget helpers parse shareable import payloads', () => {
  const payload = buildBudgetExportPayload({
    project: 'alpha',
    thresholds: {
      maxAvgInputTokensPerRequest: 1200,
      maxAvgCostPerRequest: 0.02,
    },
    source: 'storage',
  });

  const parsed = parseBudgetShareText(JSON.stringify(payload));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.project, 'alpha');
  assert.equal(parsed.thresholds.maxAvgInputTokensPerRequest, 1200);
  assert.equal(parsed.thresholds.maxAvgCostPerRequest, 0.02);
  assert.equal(parseBudgetShareText('{bad json').ok, false);
});

test('budget helpers persist to a provided storage implementation', () => {
  const storage = (() => {
    const map = new Map();
    return {
      getItem(key) { return map.has(key) ? map.get(key) : null; },
      setItem(key, value) { map.set(key, value); },
      removeItem(key) { map.delete(key); },
    };
  })();

  const thresholds = {
    maxAvgInputTokensPerRequest: 1111,
    maxAvgCostPerRequest: 0.011,
    maxTotalCostPerProject: 0.22,
    maxSessionCost: 0.033,
  };

  assert.equal(saveThresholds(thresholds, storage), true);
  assert.deepEqual(loadThresholds(storage), normalizeThresholds(thresholds));
  assert.equal(clearThresholds(storage), true);
  assert.equal(loadThresholds(storage), null);
});

test('describeThresholdConflict flags server/local split-brain with fields', () => {
  const server = {
    maxAvgInputTokensPerRequest: 1500,
    maxAvgCostPerRequest: 0.05,
    maxTotalCostPerProject: 1.0,
    maxSessionCost: 0.25,
  };
  assert.equal(describeThresholdConflict(server, { ...server }), null);
  assert.equal(describeThresholdConflict(server, null), null);
  assert.equal(describeThresholdConflict(null, server), null);
  const conflict = describeThresholdConflict(server, { ...server, maxAvgCostPerRequest: 0.09, maxSessionCost: 0.5 });
  assert.ok(conflict);
  assert.deepEqual(conflict.fields, ['maxAvgCostPerRequest', 'maxSessionCost']);
  assert.match(conflict.message, /2 fields/);
  const single = describeThresholdConflict(server, { ...server, maxTotalCostPerProject: 2.0 });
  assert.deepEqual(single.fields, ['maxTotalCostPerProject']);
  assert.match(single.message, /1 field[^s]/);
});
