#!/usr/bin/env node
const path = require('path');
const { SessionStorage } = require('../src/storage/storage');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir || process.env.CONTEXT_REVIEW_DATA_DIR || path.join(__dirname, '../data');
  const storage = new SessionStorage({
    adapterMode: 'event',
    dataDir,
    persistenceDisabled: false,
  });

  const maxAgeMs = args.maxAgeDays > 0 ? Math.floor(args.maxAgeDays * 24 * 60 * 60 * 1000) : undefined;
  const result = storage.compactEventLog({
    maxEvents: args.maxEvents > 0 ? args.maxEvents : undefined,
    maxAgeMs,
    dryRun: args.dryRun,
    backupExisting: !args.noBackup,
    reason: args.reason || 'cli',
  });

  if (result.reason === 'event_adapter_not_enabled') {
    console.error('Compaction requires event adapter mode.');
    process.exitCode = 1;
    return;
  }

  if (result.dryRun) {
    console.log('Dry-run compaction report');
  } else {
    console.log(`Compaction ${result.compacted ? 'completed' : 'skipped'}`);
  }
  console.log(`Event log: ${result.eventFile || storage.eventFile}`);
  if (result.backupFile) console.log(`Backup created: ${result.backupFile}`);
  if (result.stats) {
    console.log(`Events before: ${result.stats.totalEventsBefore}`);
    console.log(`Events retained: ${result.stats.retainedEvents}`);
    console.log(`Events after: ${result.stats.linesAfter}`);
    console.log(`Bytes before: ${result.stats.bytesBefore}`);
    console.log(`Bytes after: ${result.stats.bytesAfter}`);
  }
}

function parseArgs(argv) {
  const out = {
    dataDir: '',
    maxEvents: 0,
    maxAgeDays: 0,
    dryRun: false,
    noBackup: false,
    reason: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-backup') out.noBackup = true;
    else if (arg === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
    else if (arg === '--max-events' && argv[i + 1]) out.maxEvents = Number(argv[++i]) || 0;
    else if (arg === '--max-age-days' && argv[i + 1]) out.maxAgeDays = Number(argv[++i]) || 0;
    else if (arg === '--reason' && argv[i + 1]) out.reason = argv[++i];
  }

  return out;
}

main();
