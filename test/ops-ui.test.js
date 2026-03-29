const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveOpsAlerts, resolveArtifactPayload } = require('../public/js/ops-helpers.js');

test('deriveOpsAlerts reports degraded and benchmark failures', () => {
  const summary = {
    health: { storage: 'degraded' },
    storage: {
      eventLog: { integrity: { reason: 'recovery_failed:test' } },
      benchmarks: {
        latest: {
          storageReplay: { pass: false, replayMs: 3000, maxReplayMs: 2000 },
          queryPerformance: { pass: false, timings: { filterMs: 1200, reportMs: 4500 } },
          analysisPerformance: { pass: false, timings: { reportMs: 5000, ciSummaryMs: 4200, trendsMs: 900 } },
          longHorizonPerformance: { pass: false, timings: { filterMs: 1700, reportMs: 5400, compareMs: 3600, ciCheckMs: 2800 } },
          apiSlo: { pass: false, p95: { sessions: 600, report: 900 } },
        },
      },
    },
  };

  const alerts = deriveOpsAlerts(summary);
  assert.equal(alerts.length, 6);
  assert.equal(alerts[0].severity, 'critical');
  assert.match(alerts[0].text, /recovery_failed/);
});

test('resolveArtifactPayload maps known artifact types', () => {
  const summary = {
    storage: {
      benchmarks: {
        latest: {
          storageReplay: { pass: true },
          queryPerformance: { pass: true },
          analysisPerformance: { pass: true },
          longHorizonPerformance: { pass: true },
          apiSlo: { pass: true },
        },
      },
    },
  };

  const storage = resolveArtifactPayload(summary, 'storage-status');
  const replay = resolveArtifactPayload(summary, 'storage-benchmark');
  const query = resolveArtifactPayload(summary, 'query-benchmark');
  const analysis = resolveArtifactPayload(summary, 'analysis-benchmark');
  const horizon = resolveArtifactPayload(summary, 'long-horizon-benchmark');
  const slo = resolveArtifactPayload(summary, 'api-slo');

  assert.equal(storage.filename, 'storage-status.json');
  assert.equal(replay.filename, 'storage-benchmark.json');
  assert.equal(query.filename, 'query-benchmark.json');
  assert.equal(analysis.filename, 'analysis-benchmark.json');
  assert.equal(horizon.filename, 'long-horizon-benchmark.json');
  assert.equal(slo.filename, 'api-slo.json');
  assert.equal(replay.payload.pass, true);
});
