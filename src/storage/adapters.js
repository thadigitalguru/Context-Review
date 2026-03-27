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
    this.lastIntegrityReport = {
      checkedAt: Date.now(),
      healthy: true,
      recovered: false,
      degraded: false,
      droppedLines: 0,
      reason: 'not_checked',
      backupFile: null,
    };
  }

  load() {
    const state = super.load();
    if (this.persistenceDisabled) return state;
    if (!fs.existsSync(this.eventFile)) return state;

    try {
      const events = this.readEventsForLoad();
      this.lastIntegrityReport = events.integrityReport;
      let current = normalizeState(state);
      for (const event of events.events) {
        current = applyEvent(current, event);
      }
      return normalizeState(current);
    } catch (e) {
      console.error('Failed to replay event log:', e.message);
      this.lastIntegrityReport = {
        checkedAt: Date.now(),
        healthy: false,
        recovered: false,
        degraded: true,
        droppedLines: 0,
        reason: `replay_failed:${e.message}`,
        backupFile: null,
      };
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
      return { mode: 'event', persistenceDisabled: true, eventFile: this.eventFile, eventCount: 0, bytes: 0, integrity: this.lastIntegrityReport };
    }
    if (!fs.existsSync(this.eventFile)) {
      return { mode: 'event', persistenceDisabled: false, eventFile: this.eventFile, eventCount: 0, bytes: 0, integrity: this.lastIntegrityReport };
    }
    const lines = fs.readFileSync(this.eventFile, 'utf8').split('\n').filter(Boolean);
    return {
      mode: 'event',
      persistenceDisabled: false,
      eventFile: this.eventFile,
      eventCount: lines.length,
      bytes: fs.statSync(this.eventFile).size,
      integrity: this.lastIntegrityReport,
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

  readEventsForLoad() {
    const raw = fs.readFileSync(this.eventFile, 'utf8');
    const parsed = parseEventLog(raw);
    if (parsed.invalidLineIndex === -1) {
      return {
        events: parsed.events,
        integrityReport: {
          checkedAt: Date.now(),
          healthy: true,
          recovered: false,
          degraded: false,
          droppedLines: 0,
          reason: 'ok',
          backupFile: null,
        },
      };
    }

    const recovery = this.recoverEventLog(parsed);
    if (!recovery.ok) {
      return {
        events: [],
        integrityReport: {
          checkedAt: Date.now(),
          healthy: false,
          recovered: false,
          degraded: true,
          droppedLines: parsed.totalLines - parsed.events.length,
          reason: recovery.reason,
          backupFile: recovery.backupFile || null,
        },
      };
    }

    return {
      events: parsed.events,
      integrityReport: {
        checkedAt: Date.now(),
        healthy: false,
        recovered: true,
        degraded: false,
        droppedLines: parsed.totalLines - parsed.events.length,
        reason: recovery.reason,
        backupFile: recovery.backupFile || null,
      },
    };
  }

  recoverEventLog(parsed) {
    const now = Date.now();
    const backupFile = `${this.eventFile}.corrupt.${now}.bak`;
    const validLines = parsed.validLines;

    try {
      fs.copyFileSync(this.eventFile, backupFile);
      const out = validLines.length > 0 ? `${validLines.join('\n')}\n` : '';
      fs.writeFileSync(this.eventFile, out);
      return {
        ok: true,
        reason: parsed.reason || 'corrupt_event_log_recovered',
        backupFile,
      };
    } catch (e) {
      console.error('Failed to recover event log:', e.message);
      return {
        ok: false,
        reason: `recovery_failed:${e.message}`,
        backupFile: fs.existsSync(backupFile) ? backupFile : null,
      };
    }
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

function parseEventLog(raw) {
  const hasTrailingNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (hasTrailingNewline) lines.pop();
  const events = [];
  const validLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      const partialTail = i === lines.length - 1 && !hasTrailingNewline;
      return {
        totalLines: lines.length,
        events,
        validLines,
        invalidLineIndex: i,
        reason: partialTail ? 'partial_last_line' : 'invalid_json_line',
      };
    }

    if (!isValidStorageEvent(parsed)) {
      return {
        totalLines: lines.length,
        events,
        validLines,
        invalidLineIndex: i,
        reason: 'invalid_event_shape',
      };
    }

    events.push(parsed);
    validLines.push(line);
  }

  return {
    totalLines: lines.length,
    events,
    validLines,
    invalidLineIndex: -1,
    reason: 'ok',
  };
}

function isValidStorageEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.type !== 'string' || !event.type) return false;

  if (event.type === 'seed_state') {
    return !!event.state && typeof event.state === 'object';
  }
  if (event.type === 'clear_all') return true;
  if (event.type === 'capture_added') {
    return !!event.entry && typeof event.entry === 'object' && !!event.session && typeof event.session === 'object';
  }
  return false;
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
