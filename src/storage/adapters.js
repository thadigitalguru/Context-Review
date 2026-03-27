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

function normalizeState(data) {
  return {
    sessions: data && typeof data.sessions === 'object' && data.sessions !== null ? data.sessions : {},
    captures: Array.isArray(data && data.captures) ? data.captures : [],
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  FlatFileStorageAdapter,
  EventLogStorageAdapter,
  createStorageAdapter,
};
