const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  appendBenchmarkHistory,
  loadBenchmarkHistory,
  summarizeBenchmarkHistory,
  recommendThresholds,
} = require('../src/analysis/benchmark-baselines');

test('benchmark baseline helper summarizes history and recommends thresholds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-benchmark-'));
  const file = path.join(dir, 'history.json');
  appendBenchmarkHistory(file, { checkedAt: 1, timings: { filterMs: 100, reportMs: 200, compareMs: 300, ciCheckMs: 400 } }, 10);
  appendBenchmarkHistory(file, { checkedAt: 2, timings: { filterMs: 120, reportMs: 220, compareMs: 320, ciCheckMs: 420 } }, 10);
  appendBenchmarkHistory(file, { checkedAt: 3, timings: { filterMs: 140, reportMs: 240, compareMs: 340, ciCheckMs: 440 } }, 10);

  const history = loadBenchmarkHistory(file);
  const summary = summarizeBenchmarkHistory(history, ['filterMs', 'reportMs', 'compareMs', 'ciCheckMs']);
  const thresholds = recommendThresholds(summary, { headroom: 0.2, min: 1 });

  assert.equal(history.length, 3);
  assert.equal(summary.count, 3);
  assert.equal(summary.metrics.filterMs.p95, 140);
  assert.equal(thresholds.filterMs, 168);
  assert.equal(thresholds.reportMs, 288);
  assert.equal(thresholds.compareMs, 408);
  assert.equal(thresholds.ciCheckMs, 528);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('long-horizon calibration script writes calibrated artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-calibration-'));
  const historyFile = path.join(dir, 'history.json');
  const outputFile = path.join(dir, 'calibration.json');
  fs.writeFileSync(historyFile, JSON.stringify([
    { checkedAt: 1, timings: { filterMs: 100, reportMs: 200, compareMs: 300, ciCheckMs: 400 } },
    { checkedAt: 2, timings: { filterMs: 150, reportMs: 250, compareMs: 350, ciCheckMs: 450 } },
  ]));

  const output = execFileSync('node', [path.join(process.cwd(), 'scripts/ci-long-horizon-calibrate.js')], {
    env: {
      ...process.env,
      CI_BENCHMARK_HISTORY_FILE: historyFile,
      CI_LONG_HORIZON_CALIBRATION_FILE: outputFile,
      CI_LONG_HORIZON_CALIBRATION_HEADROOM: '0.1',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  const artifact = JSON.parse(fs.readFileSync(outputFile, 'utf8'));

  assert.equal(parsed.historyCount, 2);
  assert.equal(artifact.thresholds.filterMaxMs, 165);
  assert.equal(artifact.thresholds.reportMaxMs, 275);
  assert.match(artifact.note, /historical/);

  fs.rmSync(dir, { recursive: true, force: true });
});
