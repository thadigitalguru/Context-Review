#!/usr/bin/env node
const path = require('path');
const { migrateSnapshotToEventLog } = require('../src/storage/migrate');

function main() {
  const dataDir = process.env.CONTEXT_REVIEW_DATA_DIR || path.join(__dirname, '../data');
  try {
    const result = migrateSnapshotToEventLog(dataDir);
    console.log(`Migrated snapshot to event log: ${result.eventFile}`);
    console.log(`Sessions: ${result.sessionCount}, Captures: ${result.captureCount}`);
  } catch (e) {
    console.error(`Migration failed: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
