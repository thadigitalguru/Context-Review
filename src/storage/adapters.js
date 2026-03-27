const fs = require('fs');
const path = require('path');

class FlatFileStorageAdapter {
  constructor({ dataDir, dataFile, persistenceDisabled }) {
    this.dataDir = dataDir;
    this.dataFile = dataFile || path.join(dataDir, 'sessions.json');
    this.persistenceDisabled = persistenceDisabled;
  }

  load() {
    if (this.persistenceDisabled) return { sessions: {}, captures: [] };
    try {
      ensureDir(this.dataDir);
      if (!fs.existsSync(this.dataFile)) return { sessions: {}, captures: [] };
      const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      return normalizeState(data);
    } catch (e) {
      console.error('Failed to load session snapshot:', e.message);
      return { sessions: {}, captures: [] };
    }
  }

  save(state) {
    if (this.persistenceDisabled) return;
    try {
      ensureDir(this.dataDir);
      fs.writeFileSync(this.dataFile, JSON.stringify(normalizeState(state), null, 2));
    } catch (e) {
      console.error('Failed to save session snapshot:', e.message);
    }
  }

  appendEvent(_event) {
    // Flat snapshot mode has no append-only event stream.
  }
}

class EventLogStorageAdapter extends FlatFileStorageAdapter {
  constructor({ dataDir, dataFile, eventFile, persistenceDisabled }) {
    super({ dataDir, dataFile, persistenceDisabled });
    this.eventFile = eventFile || path.join(dataDir, 'events.ndjson');
  }

  load() {
    const state = super.load();
    if (this.persistenceDisabled) return state;
    if (!fs.existsSync(this.eventFile)) return state;

    try {
      const lines = fs.readFileSync(this.eventFile, 'utf8').split('\n').filter(Boolean);
      let current = normalizeState(state);
      for (const line of lines) {
        const event = JSON.parse(line);
        current = applyEvent(current, event);
      }
      return normalizeState(current);
    } catch (e) {
      console.error('Failed to replay event log:', e.message);
      return state;
    }
  }

  appendEvent(event) {
    if (this.persistenceDisabled) return;
    try {
      ensureDir(this.dataDir);
      fs.appendFileSync(this.eventFile, JSON.stringify(event) + '\n');
    } catch (e) {
      console.error('Failed to append storage event:', e.message);
    }
  }

  compact(options = {}) {
    if (this.persistenceDisabled) {
      return { compacted: false, reason: 'persistence_disabled' };
    }

    if (!fs.existsSync(this.eventFile)) {
      return {
        compacted: false,
        reason: 'event_log_missing',
        eventFile: this.eventFile,
      };
    }

    const maxEvents = toPositiveInt(options.maxEvents, 0);
    const maxAgeMs = toPositiveInt(options.maxAgeMs, 0);
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const dryRun = options.dryRun === true;
    const backupExisting = options.backupExisting !== false;
    const reason = options.reason || 'manual';

    const events = this.readEvents();
    const retained = selectRetainedEvents(events, { maxEvents, maxAgeMs, now });
    const retainedIndexes = new Set(retained.indexes);
    const baseEvents = events.filter((_, idx) => !retainedIndexes.has(idx));
    const baseState = applyEvents(baseEvents);

    const seedEvent = {
      type: 'seed_state',
      timestamp: now,
      state: baseState,
      compaction: {
        reason,
        maxEvents,
        maxAgeMs,
        retainedEvents: retained.events.length,
        totalEventsBefore: events.length,
      },
    };

    const rewrittenLines = [JSON.stringify(seedEvent), ...retained.events.map((e) => JSON.stringify(e))];
    const bytesBefore = fs.statSync(this.eventFile).size;

    const result = {
      compacted: !dryRun,
      dryRun,
      eventFile: this.eventFile,
      backupFile: null,
      reason,
      limits: { maxEvents, maxAgeMs },
      stats: {
        totalEventsBefore: events.length,
        retainedEvents: retained.events.length,
        compactedAwayEvents: Math.max(0, events.length - retained.events.length),
        linesAfter: rewrittenLines.length,
        bytesBefore,
        bytesAfter: Buffer.byteLength(rewrittenLines.join('\n') + '\n', 'utf8'),
      },
    };

    if (dryRun) return result;

    if (backupExisting) {
      result.backupFile = `${this.eventFile}.bak.${now}`;
      fs.copyFileSync(this.eventFile, result.backupFile);
    }

    const tempFile = `${this.eventFile}.tmp.${process.pid}.${now}`;
    fs.writeFileSync(tempFile, rewrittenLines.join('\n') + '\n');
    fs.renameSync(tempFile, this.eventFile);

    return result;
  }

  getEventLogStats() {
    if (this.persistenceDisabled) {
      return { mode: 'event', persistenceDisabled: true, eventFile: this.eventFile, eventCount: 0, bytes: 0 };
    }
    if (!fs.existsSync(this.eventFile)) {
      return { mode: 'event', persistenceDisabled: false, eventFile: this.eventFile, eventCount: 0, bytes: 0 };
    }
    const lines = fs.readFileSync(this.eventFile, 'utf8').split('\n').filter(Boolean);
    return {
      mode: 'event',
      persistenceDisabled: false,
      eventFile: this.eventFile,
      eventCount: lines.length,
      bytes: fs.statSync(this.eventFile).size,
    };
  }

  readEvents() {
    const lines = fs.readFileSync(this.eventFile, 'utf8').split('\n').filter(Boolean);
    const events = [];
    for (const line of lines) {
      events.push(JSON.parse(line));
    }
    return events;
  }
}

function createStorageAdapter(options = {}) {
  const mode = resolveAdapterMode(options.mode);
  const dataDir = options.dataDir;
  const persistenceDisabled = options.persistenceDisabled;
  const dataFile = options.dataFile;
  const eventFile = options.eventFile;

  if (mode === 'event') {
    return {
      mode,
      adapter: new EventLogStorageAdapter({ dataDir, dataFile, eventFile, persistenceDisabled }),
    };
  }

  return {
    mode: 'flat',
    adapter: new FlatFileStorageAdapter({ dataDir, dataFile, persistenceDisabled }),
  };
}

function resolveAdapterMode(mode) {
  if (mode === 'event' || mode === 'flat') return mode;
  if (process.env.CONTEXT_REVIEW_STORAGE_ADAPTER === 'event') return 'event';
  if (process.env.CONTEXT_REVIEW_EVENT_LOG === '1') return 'event';
  return 'flat';
}

function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return state;

  if (event.type === 'seed_state' && event.state) {
    return normalizeState(event.state);
  }

  if (event.type === 'clear_all') {
    return { sessions: {}, captures: [] };
  }

  if (event.type === 'capture_added' && event.entry && event.session) {
    const sessions = { ...(state.sessions || {}) };
    const captures = Array.isArray(state.captures) ? [...state.captures] : [];
    sessions[event.session.id] = event.session;
    const existingIdx = captures.findIndex((capture) => capture.id === event.entry.id);
    if (existingIdx >= 0) {
      captures[existingIdx] = event.entry;
    } else {
      captures.push(event.entry);
    }
    return { sessions, captures };
  }

  return state;
}

function applyEvents(events) {
  let current = { sessions: {}, captures: [] };
  for (const event of events) {
    current = applyEvent(current, event);
  }
  return normalizeState(current);
}

function selectRetainedEvents(events, options) {
  const maxEvents = toPositiveInt(options.maxEvents, 0);
  const maxAgeMs = toPositiveInt(options.maxAgeMs, 0);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const minTs = maxAgeMs > 0 ? now - maxAgeMs : null;

  const kept = [];
  for (let idx = 0; idx < events.length; idx++) {
    const event = events[idx];
    const timestamp = Number(event && event.timestamp);
    const oldByAge = minTs !== null && Number.isFinite(timestamp) && timestamp < minTs;
    if (!oldByAge) kept.push({ idx, event });
  }

  const bounded = maxEvents > 0 ? kept.slice(-maxEvents) : kept;
  return {
    indexes: bounded.map((e) => e.idx),
    events: bounded.map((e) => e.event),
  };
}

function normalizeState(data) {
  return {
    sessions: data && typeof data.sessions === 'object' && data.sessions !== null ? data.sessions : {},
    captures: Array.isArray(data && data.captures) ? data.captures : [],
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

module.exports = {
  FlatFileStorageAdapter,
  EventLogStorageAdapter,
  createStorageAdapter,
  applyEvent,
};
