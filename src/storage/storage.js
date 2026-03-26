const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ALL_CATS = ['system_prompts', 'tool_definitions', 'tool_calls', 'tool_results', 'assistant_text', 'user_text', 'thinking_blocks', 'media'];

class SessionStorage {
  constructor() {
    this.sessions = new Map();
    this.captures = [];
    this.persistenceDisabled = process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE === '1';
    this.dataDir = process.env.CONTEXT_REVIEW_DATA_DIR || path.join(__dirname, '../../data');
    this.dataFile = path.join(this.dataDir, 'sessions.json');
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      if (this.persistenceDisabled) return;
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        if (data.sessions) {
          for (const [id, session] of Object.entries(data.sessions)) {
            this.sessions.set(id, session);
          }
        }
        if (data.captures) {
          this.captures = data.captures;
        }
      }
    } catch (e) {
      console.error('Failed to load session data:', e.message);
    }
  }

  saveToDisk() {
    try {
      if (this.persistenceDisabled) return;
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      const data = {
        sessions: Object.fromEntries(this.sessions),
        captures: this.captures.slice(-1000),
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Failed to save session data:', e.message);
    }
  }

  addCapture(capture, breakdown) {
    const captureId = uuidv4();
    const sessionId = this.resolveSession(capture, breakdown);

    const entry = {
      id: captureId,
      sessionId,
      timestamp: capture.timestamp,
      provider: capture.provider,
      model: breakdown ? breakdown.model : 'unknown',
      agent: breakdown ? breakdown.agent : { id: 'unknown', name: 'Unknown' },
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

    const session = this.sessions.get(sessionId);
    session.lastActivity = capture.timestamp;
    session.requestCount++;
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
    return { captureId, sessionId };
  }

  resolveSession(capture, breakdown) {
    const now = capture.timestamp;
    const agent = breakdown ? breakdown.agent : { id: 'unknown', name: 'Unknown' };
    const provider = capture.provider;

    for (const [id, session] of this.sessions) {
      if (session.provider === provider &&
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
          agents: session.agents,
        },
      },
    };
  }
}

function sameAgent(session, agent) {
  const sessionAgentIds = Object.keys(session.agents || {});
  if (sessionAgentIds.length === 0) return agent.id === 'unknown';
  return sessionAgentIds.includes(agent.id);
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
