const fs = require('fs');
const path = require('path');

function loadBenchmarkHistory(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveBenchmarkHistory(filePath, history, limit = 20) {
  ensureDir(path.dirname(filePath));
  const next = Array.isArray(history) ? history.slice(0, limit) : [];
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

function appendBenchmarkHistory(filePath, record, limit = 20) {
  const history = loadBenchmarkHistory(filePath);
  history.unshift(record);
  return saveBenchmarkHistory(filePath, history, limit);
}

function summarizeBenchmarkHistory(history, timingKeys) {
  const records = Array.isArray(history) ? history.filter(Boolean) : [];
  const keys = Array.isArray(timingKeys) && timingKeys.length > 0
    ? timingKeys
    : inferTimingKeys(records);

  const out = {
    count: records.length,
    keys,
    metrics: {},
  };

  for (const key of keys) {
    const values = records
      .map((record) => Number(record?.timings?.[key]))
      .filter((value) => Number.isFinite(value));
    out.metrics[key] = summarizeValues(values);
  }

  return out;
}

function recommendThresholds(summary, options = {}) {
  const headroom = Number.isFinite(Number(options.headroom)) ? Math.max(0, Number(options.headroom)) : 0.2;
  const min = Number.isFinite(Number(options.min)) ? Math.max(0, Number(options.min)) : 0;
  const thresholds = {};

  for (const [key, stats] of Object.entries(summary?.metrics || {})) {
    const base = Number.isFinite(stats?.p95) && stats.p95 > 0
      ? stats.p95
      : Number.isFinite(stats?.median) && stats.median > 0
        ? stats.median
        : Number.isFinite(stats?.max) && stats.max > 0
          ? stats.max
          : 0;
    thresholds[key] = Math.max(min, Math.ceil(base * (1 + headroom)));
  }

  return thresholds;
}

function summarizeValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { min: 0, median: 0, p95: 0, max: 0, average: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    average: Math.round((sum / sorted.length) * 100) / 100,
  };
}

function percentile(sortedValues, pct) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * pct) - 1));
  return sortedValues[index];
}

function inferTimingKeys(records) {
  const keys = new Set();
  for (const record of records || []) {
    const timings = record?.timings;
    if (!timings || typeof timings !== 'object') continue;
    for (const [key, value] of Object.entries(timings)) {
      if (Number.isFinite(Number(value))) keys.add(key);
    }
  }
  return [...keys];
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  loadBenchmarkHistory,
  saveBenchmarkHistory,
  appendBenchmarkHistory,
  summarizeBenchmarkHistory,
  recommendThresholds,
};
