#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  loadBenchmarkHistory,
  summarizeBenchmarkHistory,
  recommendThresholds,
} = require('../src/analysis/benchmark-baselines');

function main() {
  try {
    const artifactDir = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
    const historyFile = process.env.CI_BENCHMARK_HISTORY_FILE || path.join(artifactDir, 'benchmark-history', 'long-horizon-history.json');
    const outputFile = process.env.CI_LONG_HORIZON_CALIBRATION_FILE || path.join(artifactDir, 'long-horizon-calibration.json');
    const history = loadBenchmarkHistory(historyFile);
    const summary = summarizeBenchmarkHistory(history, ['filterMs', 'reportMs', 'compareMs', 'ciCheckMs']);
    const thresholds = recommendThresholds(summary, { headroom: Number(process.env.CI_LONG_HORIZON_CALIBRATION_HEADROOM || 0.2), min: 1 });

    const out = {
      generatedAt: Date.now(),
      historyFile,
      historyCount: summary.count,
      summary,
      thresholds: {
        filterMaxMs: thresholds.filterMs,
        reportMaxMs: thresholds.reportMs,
        compareMaxMs: thresholds.compareMs,
        ciCheckMaxMs: thresholds.ciCheckMs,
      },
      note: summary.count > 0
        ? 'Calibrated from historical long-horizon benchmark runs.'
        : 'No benchmark history available; thresholds reflect empty-history defaults.',
    };

    ensureDir(path.dirname(outputFile));
    fs.writeFileSync(outputFile, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error(`long-horizon calibration failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
