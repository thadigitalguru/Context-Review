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

    const before = storage.getStorageStatus();
    const maintenancePlan = storage.runMaintenanceCompaction({
      reason: 'ops_repair_dry_run',
      dryRun: true,
      force: true,
    });
    const compactionPlan = storage.compactEventLog({
      reason: 'ops_repair_dry_run',
      dryRun: true,
      backupExisting: true,
    });

    console.log(JSON.stringify({
      ok: true,
      generatedAt: Date.now(),
      before,
      proposed: {
        maintenancePlan,
        compactionPlan,
      },
      note: 'Dry-run only. No file mutations were applied.',
    }, null, 2));
  } catch (err) {
    console.error(`ops repair failed: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
