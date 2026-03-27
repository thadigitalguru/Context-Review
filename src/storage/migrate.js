const fs = require('fs');
const path = require('path');
const { EventLogStorageAdapter } = require('./adapters');

function migrateSnapshotToEventLog(dataDir, options = {}) {
  const snapshotFile = options.snapshotFile || path.join(dataDir, 'sessions.json');
  const eventFile = options.eventFile || path.join(dataDir, 'events.ndjson');
  const dryRun = options.dryRun === true;
  const backupExisting = options.backupExisting !== false;
  const verify = options.verify !== false;

  if (!fs.existsSync(snapshotFile)) {
    throw new Error(`Snapshot file not found: ${snapshotFile}`);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const state = normalizeState(snapshot);
  const existingEventFile = fs.existsSync(eventFile);
  let backupFile = null;

  if (dryRun) {
    return {
      dryRun: true,
      snapshotFile,
      eventFile,
      existingEventFile,
      wouldBackup: backupExisting && existingEventFile,
      wouldWriteSeedEvent: true,
      sessionCount: Object.keys(state.sessions).length,
      captureCount: state.captures.length,
      verified: false,
      verification: null,
    };
  }

  if (backupExisting && existingEventFile) {
    backupFile = `${eventFile}.bak.${Date.now()}`;
    fs.copyFileSync(eventFile, backupFile);
  }

  const seedEvent = {
    type: 'seed_state',
    timestamp: Date.now(),
    state,
  };

  fs.writeFileSync(eventFile, JSON.stringify(seedEvent) + '\n');
  const verification = verify ? verifyEventLogState(dataDir, eventFile, state) : null;
  if (verification && !verification.ok) {
    throw new Error(`Migration verification failed: ${verification.reason}`);
  }

  return {
    dryRun: false,
    snapshotFile,
    eventFile,
    backupFile,
    existingEventFile,
    sessionCount: Object.keys(state.sessions).length,
    captureCount: state.captures.length,
    verified: verify,
    verification,
  };
}

function verifyEventLogState(dataDir, eventFile, expectedState) {
  const adapter = new EventLogStorageAdapter({
    dataDir,
    eventFile,
    persistenceDisabled: false,
  });
  const loaded = normalizeState(adapter.load());
  const expected = normalizeState(expectedState);

  const loadedSessionIds = Object.keys(loaded.sessions).sort();
  const expectedSessionIds = Object.keys(expected.sessions).sort();
  if (!sameArray(loadedSessionIds, expectedSessionIds)) {
    return { ok: false, reason: 'session ids mismatch' };
  }

  const loadedCaptureIds = loaded.captures.map((capture) => capture.id).sort();
  const expectedCaptureIds = expected.captures.map((capture) => capture.id).sort();
  if (!sameArray(loadedCaptureIds, expectedCaptureIds)) {
    return { ok: false, reason: 'capture ids mismatch' };
  }

  return {
    ok: true,
    reason: null,
    sessionCount: loadedSessionIds.length,
    captureCount: loadedCaptureIds.length,
  };
}

function sameArray(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function normalizeState(data) {
  return {
    sessions: data && data.sessions && typeof data.sessions === 'object' ? data.sessions : {},
    captures: Array.isArray(data && data.captures) ? data.captures : [],
  };
}

module.exports = { migrateSnapshotToEventLog };
