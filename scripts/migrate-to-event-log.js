#!/usr/bin/env node
const path = require('path');
const { migrateSnapshotToEventLog } = require('../src/storage/migrate');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir || process.env.CONTEXT_REVIEW_DATA_DIR || path.join(__dirname, '../data');
  try {
    const result = migrateSnapshotToEventLog(dataDir, {
      dryRun: args.dryRun,
      backupExisting: !args.noBackup,
      verify: !args.noVerify,
      snapshotFile: args.snapshotFile,
      eventFile: args.eventFile,
    });

    if (result.dryRun) {
      console.log('Dry-run migration report');
      console.log(`Snapshot: ${result.snapshotFile}`);
      console.log(`Event log: ${result.eventFile}`);
      console.log(`Existing event file: ${result.existingEventFile ? 'yes' : 'no'}`);
      console.log(`Would create backup: ${result.wouldBackup ? 'yes' : 'no'}`);
      console.log(`Sessions: ${result.sessionCount}, Captures: ${result.captureCount}`);
      return;
    }

    console.log(`Migrated snapshot to event log: ${result.eventFile}`);
    if (result.backupFile) console.log(`Backup created: ${result.backupFile}`);
    console.log(`Sessions: ${result.sessionCount}, Captures: ${result.captureCount}`);
    if (result.verified) console.log('Verification: OK');
  } catch (e) {
    console.error(`Migration failed: ${e.message}`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const out = {
    dryRun: false,
    noBackup: false,
    noVerify: false,
    dataDir: '',
    snapshotFile: '',
    eventFile: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-backup') out.noBackup = true;
    else if (arg === '--no-verify') out.noVerify = true;
    else if (arg === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
    else if (arg === '--snapshot-file' && argv[i + 1]) out.snapshotFile = argv[++i];
    else if (arg === '--event-file' && argv[i + 1]) out.eventFile = argv[++i];
  }

  return out;
}

main();
