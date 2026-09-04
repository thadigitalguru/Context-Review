const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../public/js/app-helpers');

function composition(total, model, toolResultsPct = 10, toolDefsPct = 10) {
  return {
    composition: {
      total_tokens: total,
      model,
      categories: [
        { key: 'tool_results', percentage: toolResultsPct },
        { key: 'tool_definitions', percentage: toolDefsPct },
      ],
    },
  };
}

test('getContextWindow resolves known models and families', () => {
  assert.equal(helpers.getContextWindow('gpt-4o'), 128000);
  assert.equal(helpers.getContextWindow('gpt-4o-mini-2024-07-18'), 128000);
  assert.equal(helpers.getContextWindow('claude-sonnet-4-20250514'), 200000);
  assert.equal(helpers.getContextWindow('gemini-2.5-flash'), 1048576);
  assert.equal(helpers.getContextWindow('mystery-model'), 200000);
  assert.equal(helpers.getContextWindow(''), 200000);
  assert.equal(helpers.getContextWindow(null), 200000);
});

test('computeHealth penalizes overflow, tool-result bloat, and rapid growth', () => {
  assert.equal(helpers.computeHealth({}, null, []), 100);
  const healthy = helpers.computeHealth({}, composition(1000, 'gpt-4o'), []);
  assert.equal(healthy, 100);
  const critical = helpers.computeHealth({}, composition(125000, 'gpt-4o'), []);
  assert.ok(critical < 100);
  const bloated = helpers.computeHealth({}, composition(10000, 'gpt-4o', 70, 10), []);
  assert.ok(bloated < healthy);
  const growing = helpers.computeHealth({}, composition(10000, 'gpt-4o'), [
    { breakdown: { total: 1000 } },
    { breakdown: { total: 9000 } },
    { breakdown: { total: 25000 } },
  ]);
  assert.ok(growing < healthy);
});

test('health presentation helpers bucket scores consistently', () => {
  assert.equal(helpers.healthColor(90), 'var(--green)');
  assert.equal(helpers.healthColor(50), 'var(--orange)');
  assert.equal(helpers.healthColor(10), 'var(--red)');
  assert.equal(helpers.healthClass(90), 'good');
  assert.equal(helpers.healthClass(50), 'warning');
  assert.equal(helpers.healthClass(10), 'critical');
  assert.equal(helpers.healthLabel(90), 'healthy');
  assert.equal(helpers.healthLabel(10), 'critical risk');
});

test('isRefreshFailure detects unreachable backend without flagging empty states', () => {
  assert.equal(helpers.isRefreshFailure({ stats: null, sessions: null, reportSummary: null }), true);
  assert.equal(helpers.isRefreshFailure({ stats: null, sessions: [], reportSummary: null }), false);
  assert.equal(helpers.isRefreshFailure({ stats: { sessionCount: 0 }, sessions: [], reportSummary: {} }), false);
});
