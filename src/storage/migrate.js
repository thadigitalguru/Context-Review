const fs = require('fs');
const path = require('path');

function migrateSnapshotToEventLog(dataDir, options = {}) {
  const snapshotFile = options.snapshotFile || path.join(dataDir, 'sessions.json');
  const eventFile = options.eventFile || path.join(dataDir, 'events.ndjson');
  const backupExisting = options.backupExisting !== false;

  if (!fs.existsSync(snapshotFile)) {
    throw new Error(`Snapshot file not found: ${snapshotFile}`);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const sessions = snapshot && snapshot.sessions && typeof snapshot.sessions === 'object' ? snapshot.sessions : {};
  const captures = Array.isArray(snapshot && snapshot.captures) ? snapshot.captures : [];

  if (backupExisting && fs.existsSync(eventFile)) {
    const backupFile = `${eventFile}.bak.${Date.now()}`;
    fs.copyFileSync(eventFile, backupFile);
  }

  const seedEvent = {
    type: 'seed_state',
    timestamp: Date.now(),
    state: { sessions, captures },
  };

  fs.writeFileSync(eventFile, JSON.stringify(seedEvent) + '\n');

  return {
    eventFile,
    sessionCount: Object.keys(sessions).length,
    captureCount: captures.length,
  };
}

module.exports = { migrateSnapshotToEventLog };
