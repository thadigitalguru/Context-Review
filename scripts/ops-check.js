#!/usr/bin/env node
const path = require('path');
const { SessionStorage } = require('../src/storage/storage');

function main() {
  try {
    const dataDir = process.env.CONTEXT_REVIEW_DATA_DIR || path.join(__dirname, '../data');
    const storage = new SessionStorage({
      adapterMode: process.env.CONTEXT_REVIEW_STORAGE_ADAPTER || 'event',
      dataDir,
      persistenceDisabled: process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE === '1',
    });
    const status = storage.getStorageStatus();
    const degraded = Boolean(status.eventLog?.integrity?.degraded);
    const replayBench = status.benchmarks?.latest?.storageReplay;
    const queryBench = status.benchmarks?.latest?.queryPerformance;
    const analysisBench = status.benchmarks?.latest?.analysisPerformance;
    const apiSlo = status.benchmarks?.latest?.apiSlo;

    const failures = [];
    if (degraded) failures.push(`storage degraded: ${status.eventLog.integrity.reason}`);
    if (replayBench && replayBench.pass === false) failures.push('storage replay benchmark failed');
    if (queryBench && queryBench.pass === false) failures.push('query benchmark failed');
    if (analysisBench && analysisBench.pass === false) failures.push('analysis benchmark failed');
    if (apiSlo && apiSlo.pass === false) failures.push('api slo benchmark failed');

    console.log(JSON.stringify({
      ok: failures.length === 0,
      generatedAt: Date.now(),
      failures,
      storage: status,
    }, null, 2));

    if (failures.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`ops check failed: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
