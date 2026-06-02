#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionStorage } = require('../src/storage/storage');

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const dataDir = args.dataDir || process.env.CONTEXT_REVIEW_DATA_DIR || path.join(__dirname, '../data');
    const artifactDir = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
    const outputFile = args.outputFile || process.env.CONTEXT_REVIEW_RECOVERY_DRILL_FILE || path.join(artifactDir, 'recovery-drill.json');
    const storage = new SessionStorage({
      adapterMode: process.env.CONTEXT_REVIEW_STORAGE_ADAPTER || 'event',
      dataDir,
      persistenceDisabled: process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE === '1',
    });

    const before = storage.getStorageStatus();
    const maintenanceDryRun = storage.runMaintenanceCompaction({
      reason: 'recovery_drill',
      dryRun: true,
      force: true,
    });
    const compactionDryRun = storage.compactEventLog({
      reason: 'recovery_drill',
      dryRun: true,
      backupExisting: true,
    });

    const backupCandidates = listBackupCandidates(before.eventFile || storage.eventFile, args.maxBackups);
    const selectedBackup = args.backupFile || backupCandidates[0]?.file || null;
    const replayValidation = validateBackupReplay(selectedBackup);
    const checklist = buildChecklist({ before, maintenanceDryRun, compactionDryRun, backupCandidates, replayValidation, selectedBackup });

    const result = {
      ok: true,
      generatedAt: Date.now(),
      dataDir,
      artifactFile: outputFile,
      before,
      dryRuns: {
        maintenance: maintenanceDryRun,
        compaction: compactionDryRun,
      },
      backups: backupCandidates,
      selectedBackupFile: selectedBackup,
      replayValidation,
      checklist,
    };

    ensureDir(path.dirname(outputFile));
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`recovery drill failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function listBackupCandidates(eventFile, maxBackups = 10) {
  if (!eventFile) return [];
  const dir = path.dirname(eventFile);
  if (!fs.existsSync(dir)) return [];
  const prefix = path.basename(eventFile).split('.')[0];
  return fs.readdirSync(dir)
    .filter((name) => name.includes(prefix) && (name.includes('.bak') || name.includes('.corrupt.')))
    .slice(0, Math.max(1, Math.min(25, Number(maxBackups) || 10)))
    .map((name) => ({ file: path.join(dir, name), exists: true }));
}

function validateBackupReplay(backupFile) {
  if (!backupFile || !fs.existsSync(backupFile)) {
    return { ok: false, reason: 'no_backup_available' };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-replay-'));
  const tempEventFile = path.join(tempDir, 'events.ndjson');
  try {
    fs.copyFileSync(backupFile, tempEventFile);
    const replayStorage = new SessionStorage({
      adapterMode: 'event',
      dataDir: tempDir,
      persistenceDisabled: false,
    });
    const status = replayStorage.getStorageStatus();
    return {
      ok: true,
      backupFile,
      eventCount: status.eventLog?.eventCount || 0,
      integrity: status.eventLog?.integrity || null,
      replayMs: status.eventLog?.telemetry?.replayMs || 0,
    };
  } catch (err) {
    return {
      ok: false,
      backupFile,
      reason: `replay_failed:${err.message}`,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildChecklist({ before, maintenanceDryRun, compactionDryRun, backupCandidates, replayValidation, selectedBackup }) {
  const steps = [
    {
      step: 'Verify storage adapter mode',
      status: before.adapterMode === 'event' ? 'pass' : 'warn',
      detail: `adapterMode=${before.adapterMode}`,
    },
    {
      step: 'Confirm dry-run maintenance plan can be produced',
      status: maintenanceDryRun ? 'pass' : 'fail',
      detail: maintenanceDryRun?.reason || 'no maintenance result',
    },
    {
      step: 'Confirm dry-run compaction plan can be produced',
      status: compactionDryRun ? 'pass' : 'fail',
      detail: compactionDryRun?.reason || 'no compaction result',
    },
    {
      step: 'Inspect backup candidates for replay validation',
      status: backupCandidates.length > 0 ? 'pass' : 'warn',
      detail: backupCandidates.length > 0 ? `${backupCandidates.length} candidate(s) found` : 'no backup files detected',
    },
    {
      step: 'Replay-validate a backup candidate',
      status: replayValidation?.ok ? 'pass' : 'warn',
      detail: replayValidation?.ok ? `replayed ${replayValidation.eventCount} events from ${path.basename(selectedBackup || replayValidation.backupFile || 'backup')}` : replayValidation?.reason || 'no replay validation available',
    },
    {
      step: 'Record rollback/replay note',
      status: 'pass',
      detail: selectedBackup ? `Selected backup: ${selectedBackup}` : 'Dry-run only; no files were mutated.',
    },
  ];

  return steps;
}

function parseArgs(argv) {
  const out = {
    dataDir: '',
    outputFile: '',
    backupFile: '',
    maxBackups: 10,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
    else if (arg === '--output-file' && argv[i + 1]) out.outputFile = argv[++i];
    else if (arg === '--backup-file' && argv[i + 1]) out.backupFile = argv[++i];
    else if (arg === '--max-backups' && argv[i + 1]) out.maxBackups = Number(argv[++i]);
  }

  return out;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
