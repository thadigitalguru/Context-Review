const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createStorageAdapter } = require('./adapters');

const ALL_CATS = ['system_prompts', 'tool_definitions', 'tool_calls', 'tool_results', 'assistant_text', 'user_text', 'thinking_blocks', 'media'];

class SessionStorage {
  constructor(options = {}) {
    this.sessions = new Map();
    this.captures = [];
    this.persistenceDisabled = options.persistenceDisabled !== undefined
      ? options.persistenceDisabled
      : process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE === '1';
    this.dataDir = options.dataDir || process.env.CONTEXT_REVIEW_DATA_DIR || path.join(__dirname, '../../data');
    this.dataFile = path.join(this.dataDir, 'sessions.json');
    this.eventFile = path.join(this.dataDir, 'events.ndjson');
    this.maintenanceHistoryFile = path.join(this.dataDir, 'maintenance-history.json');
    const created = createStorageAdapter({
      mode: options.adapterMode,
      dataDir: this.dataDir,
      dataFile: this.dataFile,
      eventFile: this.eventFile,
      persistenceDisabled: this.persistenceDisabled,
    });
    this.adapterMode = created.mode;
    this.adapter = created.adapter;
    this.eventRetentionMaxEvents = toPositiveInt(
      options.eventRetentionMaxEvents !== undefined
        ? options.eventRetentionMaxEvents
        : process.env.CONTEXT_REVIEW_EVENT_RETENTION_MAX_EVENTS,
      0,
    );
    this.eventRetentionMaxAgeMs = daysToMs(
      options.eventRetentionMaxAgeDays !== undefined
        ? options.eventRetentionMaxAgeDays
        : process.env.CONTEXT_REVIEW_EVENT_RETENTION_MAX_AGE_DAYS,
    );
    this.compactOnStart = options.compactOnStart !== undefined
      ? options.compactOnStart
      : process.env.CONTEXT_REVIEW_EVENT_COMPACT_ON_START === '1';
    this.maintenanceIntervalMinutes = toPositiveInt(
      options.maintenanceIntervalMinutes !== undefined
        ? options.maintenanceIntervalMinutes
        : process.env.CONTEXT_REVIEW_EVENT_COMPACT_INTERVAL_MINUTES,
      0,
    );
    this.maintenanceMinIdleMs = toPositiveInt(
      options.maintenanceMinIdleMs !== undefined
        ? options.maintenanceMinIdleMs
        : process.env.CONTEXT_REVIEW_EVENT_COMPACT_MIN_IDLE_MS,
      60_000,
    );
    this.lastCaptureAt = 0;
    this.lastMaintenanceRunAt = 0;
    this.lastMaintenanceResult = null;
    this.maintenanceHistoryLimit = toPositiveInt(
      options.maintenanceHistoryLimit !== undefined
        ? options.maintenanceHistoryLimit
        : process.env.CONTEXT_REVIEW_MAINTENANCE_HISTORY_LIMIT,
      200,
    );
    this.maintenanceHistory = [];
    this.maintenanceTimer = null;
    this.loadFromDisk();
    this.loadMaintenanceHistory();
    if (this.compactOnStart) {
      this.maybeCompactEventLog({ reason: 'startup' });
    }
    this.startMaintenanceScheduler();
  }

  loadFromDisk() {
    if (this.persistenceDisabled) return;
    const data = this.adapter.load();
    if (data.sessions) {
      for (const [id, session] of Object.entries(data.sessions)) {
        this.sessions.set(id, session);
      }
    }
    if (Array.isArray(data.captures)) this.captures = data.captures;
  }

  saveToDisk() {
    if (this.persistenceDisabled) return;
    this.adapter.save({
      sessions: Object.fromEntries(this.sessions),
      captures: this.captures.slice(-1000),
    });
  }

  addCapture(capture, breakdown) {
    const captureId = uuidv4();
    const context = extractContextIdentity(capture.request?.headers || {});
    const sessionId = this.resolveSession(capture, breakdown);

    const entry = {
      id: captureId,
      sessionId,
      timestamp: capture.timestamp,
      provider: capture.provider,
      model: breakdown ? breakdown.model : 'unknown',
      agent: breakdown ? breakdown.agent : { id: 'unknown', name: 'Unknown' },
      tenant: context.tenant,
      project: context.project,
      user: context.user,
      isStreaming: capture.isStreaming,
      breakdown,
      request: {
        method: capture.request.method,
        path: capture.request.path,
      },
      response: {
        statusCode: capture.response.statusCode,
      },
    };

    this.captures.push(entry);
    this.lastCaptureAt = capture.timestamp || Date.now();

    const session = this.sessions.get(sessionId);
    session.lastActivity = capture.timestamp;
    session.requestCount++;
    session.tenant = session.tenant || context.tenant;
    session.project = session.project || context.project;
    session.user = session.user || context.user;
    if (breakdown && breakdown.model && breakdown.model !== 'unknown') {
      session.model = breakdown.model;
    }
    if (breakdown) {
      const reportedInput = breakdown.response_tokens?.input || 0;
      const effectiveInput = reportedInput > 0 ? reportedInput : breakdown.total_tokens;
      session.totalInputTokens += effectiveInput;
      if (breakdown.response_tokens) {
        session.totalOutputTokens += breakdown.response_tokens.output || 0;
      }

      const prevBreakdown = session.turnBreakdowns.length > 0
        ? session.turnBreakdowns[session.turnBreakdowns.length - 1]
        : null;

      const diff = computeContextDiff(prevBreakdown, breakdown);

      session.turnBreakdowns.push({
        captureId,
        timestamp: capture.timestamp,
        breakdown: {
          system_prompts: breakdown.system_prompts.tokens,
          tool_definitions: breakdown.tool_definitions.tokens,
          tool_calls: breakdown.tool_calls.tokens,
          tool_results: breakdown.tool_results.tokens,
          assistant_text: breakdown.assistant_text.tokens,
          user_text: breakdown.user_text.tokens,
          thinking_blocks: breakdown.thinking_blocks.tokens,
          media: breakdown.media.tokens,
          total: breakdown.total_tokens,
        },
        diff,
        model: breakdown.model,
        agent: breakdown.agent,
      });

      if (breakdown.agent && breakdown.agent.id !== 'unknown') {
        if (!session.agents[breakdown.agent.id]) {
          session.agents[breakdown.agent.id] = {
            name: breakdown.agent.name,
            requestCount: 0,
            totalTokens: 0,
            totalCost: 0,
          };
        }
        session.agents[breakdown.agent.id].requestCount++;
        session.agents[breakdown.agent.id].totalTokens += breakdown.total_tokens;
      }
    }

    this.saveToDisk();
    this.appendEvent({
      type: 'capture_added',
      timestamp: capture.timestamp,
      entry,
      session,
    });
    return { captureId, sessionId };
  }

  resolveSession(capture, breakdown) {
    const now = capture.timestamp;
    const agent = breakdown ? breakdown.agent : { id: 'unknown', name: 'Unknown' };
    const provider = capture.provider;
    const context = extractContextIdentity(capture.request?.headers || {});

    for (const [id, session] of this.sessions) {
      if (session.provider === provider &&
        sameContext(session, context) &&
        sameAgent(session, agent) &&
        (now - session.lastActivity) < 30 * 60 * 1000) {
        return id;
      }
    }

    const sessionId = uuidv4();
    this.sessions.set(sessionId, {
      id: sessionId,
      provider,
      startTime: now,
      lastActivity: now,
      requestCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      agents: {},
      turnBreakdowns: [],
      model: breakdown ? breakdown.model : 'unknown',
      tenant: context.tenant,
      project: context.project,
      user: context.user,
    });

    return sessionId;
  }

  getSessions() {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getSessionCaptures(sessionId) {
    return this.captures.filter(c => c.sessionId === sessionId);
  }

  getCaptureDetail(captureId) {
    return this.captures.find(c => c.id === captureId) || null;
  }

  getTimeline(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.turnBreakdowns;
  }

  clearAll() {
    this.sessions.clear();
    this.captures = [];
    this.saveToDisk();
    this.appendEvent({ type: 'clear_all', timestamp: Date.now() });
  }

  appendEvent(event) {
    if (this.persistenceDisabled) return;
    this.adapter.appendEvent(event);
  }

  compactEventLog(options = {}) {
    if (this.adapterMode !== 'event' || !this.adapter || typeof this.adapter.compact !== 'function') {
      return {
        compacted: false,
        reason: 'event_adapter_not_enabled',
        mode: this.adapterMode,
      };
    }

    return this.adapter.compact({
      maxEvents: options.maxEvents !== undefined ? options.maxEvents : this.eventRetentionMaxEvents,
      maxAgeMs: options.maxAgeMs !== undefined ? options.maxAgeMs : this.eventRetentionMaxAgeMs,
      dryRun: options.dryRun === true,
      backupExisting: options.backupExisting !== false,
      reason: options.reason || 'manual',
    });
  }

  maybeCompactEventLog(options = {}) {
    const maxEvents = options.maxEvents !== undefined ? options.maxEvents : this.eventRetentionMaxEvents;
    const maxAgeMs = options.maxAgeMs !== undefined ? options.maxAgeMs : this.eventRetentionMaxAgeMs;
    if (toPositiveInt(maxEvents, 0) <= 0 && toPositiveInt(maxAgeMs, 0) <= 0) {
      return { compacted: false, reason: 'retention_limits_not_configured', mode: this.adapterMode };
    }
    return this.compactEventLog({
      ...options,
      maxEvents,
      maxAgeMs,
    });
  }

  runMaintenanceCompaction(options = {}) {
    const now = Date.now();
    this.lastMaintenanceRunAt = now;
    const recentlyActive = this.lastCaptureAt > 0 && (now - this.lastCaptureAt) < this.maintenanceMinIdleMs;
    if (recentlyActive && options.force !== true) {
      const skipped = {
        compacted: false,
        reason: 'skipped_active_load',
        lastCaptureAt: this.lastCaptureAt,
        maintenanceMinIdleMs: this.maintenanceMinIdleMs,
      };
      this.lastMaintenanceResult = skipped;
      this.recordMaintenanceRun(skipped, options.reason || 'scheduled_maintenance');
      return skipped;
    }
    const result = this.maybeCompactEventLog({
      reason: options.reason || 'scheduled_maintenance',
      dryRun: options.dryRun === true,
      force: options.force === true,
    });
    this.lastMaintenanceResult = result;
    this.recordMaintenanceRun(result, options.reason || 'scheduled_maintenance');
    return result;
  }

  startMaintenanceScheduler() {
    if (this.maintenanceIntervalMinutes <= 0) return;
    if (this.persistenceDisabled) return;
    if (this.adapterMode !== 'event') return;
    const intervalMs = this.maintenanceIntervalMinutes * 60 * 1000;
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenanceCompaction({ reason: 'scheduled_maintenance' });
    }, intervalMs);
    if (this.maintenanceTimer.unref) this.maintenanceTimer.unref();
  }

  getStorageStatus() {
    const benchmarkDir = process.env.CONTEXT_REVIEW_BENCHMARK_ARTIFACT_DIR || path.join(__dirname, '../../artifacts');
    const base = {
      adapterMode: this.adapterMode,
      dataDir: this.dataDir,
      dataFile: this.dataFile,
      eventFile: this.eventFile,
      retention: {
        maxEvents: this.eventRetentionMaxEvents,
        maxAgeMs: this.eventRetentionMaxAgeMs,
      },
      benchmarks: {
        config: {
          storageReplayMaxMs: Number(process.env.CI_STORAGE_BENCH_MAX_REPLAY_MS || 2000),
          queryFilterMaxMs: Number(process.env.CI_QUERY_BENCH_MAX_FILTER_MS || 800),
          queryReportMaxMs: Number(process.env.CI_QUERY_BENCH_MAX_REPORT_MS || 3000),
        },
        latest: loadLatestBenchmarkArtifacts(benchmarkDir),
      },
      maintenance: {
        intervalMinutes: this.maintenanceIntervalMinutes,
        minIdleMs: this.maintenanceMinIdleMs,
        lastRunAt: this.lastMaintenanceRunAt || null,
        lastResult: this.lastMaintenanceResult,
        history: this.maintenanceHistory.slice(0, 20),
      },
    };
    if (this.adapterMode !== 'event' || !this.adapter || typeof this.adapter.getEventLogStats !== 'function') {
      return base;
    }
    return {
      ...base,
      eventLog: this.adapter.getEventLogStats(),
    };
  }

  exportLHAR(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const captures = this.getSessionCaptures(sessionId);
    return {
      log: {
        version: '1.0',
        creator: { name: 'Context Review', version: '1.0.0' },
        entries: captures.map(c => ({
          id: c.id,
          timestamp: new Date(c.timestamp).toISOString(),
          provider: c.provider,
          model: c.model,
          agent: c.agent,
          tenant: c.tenant || session.tenant || 'default',
          project: c.project || session.project || 'default',
          user: c.user || session.user || 'anonymous',
          breakdown: c.breakdown,
          request: c.request,
          response: c.response,
        })),
        session: {
          id: session.id,
          provider: session.provider,
          startTime: new Date(session.startTime).toISOString(),
          lastActivity: new Date(session.lastActivity).toISOString(),
          requestCount: session.requestCount,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          tenant: session.tenant || 'default',
          project: session.project || 'default',
          user: session.user || 'anonymous',
          agents: session.agents,
        },
      },
    };
  }

  loadMaintenanceHistory() {
    if (this.persistenceDisabled) return;
    try {
      if (!fs.existsSync(this.maintenanceHistoryFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.maintenanceHistoryFile, 'utf8'));
      if (!Array.isArray(raw)) return;
      this.maintenanceHistory = raw.slice(0, this.maintenanceHistoryLimit);
    } catch {
      this.maintenanceHistory = [];
    }
  }

  saveMaintenanceHistory() {
    if (this.persistenceDisabled) return;
    try {
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.maintenanceHistoryFile, JSON.stringify(this.maintenanceHistory.slice(0, this.maintenanceHistoryLimit), null, 2));
    } catch {
      // Non-fatal: maintenance history is best-effort metadata.
    }
  }

  recordMaintenanceRun(result, reason) {
    const entry = {
      at: Date.now(),
      reason: reason || 'maintenance',
      compacted: Boolean(result?.compacted),
      dryRun: Boolean(result?.dryRun),
      resultReason: result?.reason || 'unknown',
      stats: result?.stats || null,
    };
    this.maintenanceHistory.unshift(entry);
    if (this.maintenanceHistory.length > this.maintenanceHistoryLimit) {
      this.maintenanceHistory = this.maintenanceHistory.slice(0, this.maintenanceHistoryLimit);
    }
    this.saveMaintenanceHistory();
  }
}

function sameAgent(session, agent) {
  const sessionAgentIds = Object.keys(session.agents || {});
  if (sessionAgentIds.length === 0) return agent.id === 'unknown';
  return sessionAgentIds.includes(agent.id);
}

function sameContext(session, context) {
  const sessionTenant = session.tenant || 'default';
  const sessionProject = session.project || 'default';
  const sessionUser = session.user || 'anonymous';
  const incomingTenant = context.tenant || 'default';
  const incomingProject = context.project || 'default';
  const incomingUser = context.user || 'anonymous';
  return sessionTenant === incomingTenant && sessionProject === incomingProject && sessionUser === incomingUser;
}

function extractContextIdentity(headers) {
  const tenant = getHeader(headers, ['x-context-review-tenant', 'x-cr-tenant', 'x-tenant-id']) || 'default';
  const project = getHeader(headers, ['x-context-review-project', 'x-cr-project', 'x-project-id']) || 'default';
  const user = getHeader(headers, ['x-context-review-user', 'x-cr-user', 'x-user-id']) || 'anonymous';
  return { tenant, project, user };
}

function getHeader(headers, keys) {
  if (!headers || typeof headers !== 'object') return '';
  for (const key of keys) {
    if (headers[key]) return String(headers[key]).trim();
  }
  for (const [name, value] of Object.entries(headers)) {
    const normalized = String(name).toLowerCase();
    if (keys.includes(normalized)) return String(value).trim();
  }
  return '';
}

function computeContextDiff(prevBreakdown, currentBreakdown) {
  if (!prevBreakdown) {
    const diff = {};
    for (const cat of ALL_CATS) {
      const val = currentBreakdown[cat] ? currentBreakdown[cat].tokens : 0;
      diff[cat] = { delta: val, direction: 'new', previous: 0, current: val };
    }
    diff.total = { delta: currentBreakdown.total_tokens, direction: 'new', previous: 0, current: currentBreakdown.total_tokens };
    return diff;
  }

  const diff = {};
  for (const cat of ALL_CATS) {
    const prev = prevBreakdown.breakdown ? (prevBreakdown.breakdown[cat] || 0) : 0;
    const curr = currentBreakdown[cat] ? currentBreakdown[cat].tokens : 0;
    const delta = curr - prev;
    diff[cat] = {
      delta,
      direction: delta > 0 ? 'grew' : delta < 0 ? 'shrank' : 'unchanged',
      previous: prev,
      current: curr,
    };
  }

  const prevTotal = prevBreakdown.breakdown ? (prevBreakdown.breakdown.total || 0) : 0;
  diff.total = {
    delta: currentBreakdown.total_tokens - prevTotal,
    direction: currentBreakdown.total_tokens > prevTotal ? 'grew' : currentBreakdown.total_tokens < prevTotal ? 'shrank' : 'unchanged',
    previous: prevTotal,
    current: currentBreakdown.total_tokens,
  };

  return diff;
}

module.exports = { SessionStorage };

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function daysToMs(days) {
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed * 24 * 60 * 60 * 1000);
}

function loadLatestBenchmarkArtifacts(dir) {
  return {
    storageReplay: safeLoadJson(path.join(dir, 'storage-benchmark.json')),
    queryPerformance: safeLoadJson(path.join(dir, 'query-benchmark.json')),
    apiSlo: safeLoadJson(path.join(dir, 'api-slo.json')),
  };
}

function safeLoadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
