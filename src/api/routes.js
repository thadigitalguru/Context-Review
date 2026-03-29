const express = require('express');
const { calculateCost, MODEL_PRICING } = require('../cost/pricing');
const { generateFindings } = require('../findings/findings');
const { parseRequest } = require('../parser/parser');
const { createAuthMiddleware, requireRole } = require('../auth/middleware');
const {
  filterSessions,
  buildSessionTrends,
  buildReportsSummary,
  buildSessionSnapshot,
  formatSnapshotMarkdown,
  buildCISummary,
  runCICheck,
  buildCrossSessionComparison,
} = require('../analysis/session-analysis');

function createAPIRouter(storage, options = {}) {
  const router = express.Router();
  const analysisScheduler = options.analysisScheduler || null;
  const latencyStore = createLatencyStore();
  router.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const path = (req.originalUrl || req.url || '').split('?')[0];
      latencyStore.record(req.method, path, res.statusCode, elapsedMs);
    });
    next();
  });
  const authMiddleware = createAuthMiddleware(options.auth || {});
  router.use(authMiddleware);

  router.post('/simulate', requireRole('editor'), (req, res) => {
    if (Array.isArray(req.body.actions) && req.body.actions.length > 0) {
      const simulation = runActionSimulation(storage, req.body);
      if (simulation.error) return res.status(400).json({ error: simulation.error });
      return res.json(simulation);
    }

    const { provider, request: simReq } = req.body;
    if (!provider || !simReq) return res.status(400).json({ error: 'Missing provider or request' });
    const scopedHeaders = applyAuthScopeToHeaders(req.auth, simReq.headers || {});

    const capture = {
      provider,
      timestamp: Date.now(),
      request: {
        method: 'POST',
        path: provider === 'anthropic' ? '/v1/messages' : provider === 'openai' ? '/v1/chat/completions' : '/v1beta/models/gemini/generateContent',
        headers: scopedHeaders,
        body: simReq.body,
      },
      response: {
        statusCode: 200,
        headers: {},
        body: simReq.response || null,
      },
      isStreaming: false,
    };

    const breakdown = parseRequest(capture);
    const result = storage.addCapture(capture, breakdown);
    res.json({ ...result, breakdown });
  });

  router.get('/sessions', (req, res) => {
    const scoped = scopeSessionsForAuth(storage.getSessions(), req.auth);
    const sessions = filterSessions(scoped, req.query);
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Number(req.query.offset)) : 0;
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(500, Number(req.query.limit))) : null;
    const lite = String(req.query.view || '').toLowerCase() === 'lite';
    const paged = limit !== null || req.query.offset !== undefined || String(req.query.paged || '') === '1';

    const selected = limit !== null ? sessions.slice(offset, offset + limit) : sessions.slice(offset);
    const enriched = selected.map((session) => {
      if (lite) {
        return {
          id: session.id,
          provider: session.provider,
          model: session.model,
          project: session.project || 'default',
          user: session.user || 'anonymous',
          tenant: session.tenant || 'default',
          requestCount: session.requestCount,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          lastActivity: session.lastActivity,
        };
      }
      const cacheTokens = extractSessionCacheTokens(storage.getSessionCaptures(session.id));
      const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
      return {
        ...session,
        cost,
        turnBreakdowns: undefined,
      };
    });

    if (!paged) return res.json(enriched);
    const effectiveLimit = limit !== null ? limit : enriched.length;
    return res.json({
      items: enriched,
      page: {
        total: sessions.length,
        offset,
        limit: effectiveLimit,
        hasMore: offset + effectiveLimit < sessions.length,
      },
    });
  });

  router.get('/sessions/:id', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const captures = storage.getSessionCaptures(req.params.id);
    const cacheTokens = extractSessionCacheTokens(captures);
    const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
    const findings = generateFindings(session, captures);

    res.json({
      ...session,
      cost,
      findings,
      captureCount: captures.length,
    });
  });

  router.get('/sessions/:id/captures', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const allCaptures = storage.getSessionCaptures(req.params.id);
    const offset = Number.isFinite(Number(req.query.offset)) ? Math.max(0, Number(req.query.offset)) : 0;
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(1000, Number(req.query.limit))) : null;
    const paged = limit !== null || req.query.offset !== undefined || String(req.query.paged || '') === '1';
    const captures = limit !== null ? allCaptures.slice(offset, offset + limit) : allCaptures.slice(offset);
    const items = captures.map((c) => ({
      id: c.id,
      timestamp: c.timestamp,
      provider: c.provider,
      model: c.model,
      agent: c.agent,
      project: c.project || session.project || 'default',
      user: c.user || session.user || 'anonymous',
      isStreaming: c.isStreaming,
      breakdown: c.breakdown ? {
        total_tokens: c.breakdown.total_tokens,
        system_prompts: { tokens: c.breakdown.system_prompts.tokens, percentage: c.breakdown.system_prompts.percentage, token_method: c.breakdown.system_prompts.token_method, token_confidence: c.breakdown.system_prompts.token_confidence },
        tool_definitions: { tokens: c.breakdown.tool_definitions.tokens, percentage: c.breakdown.tool_definitions.percentage, count: c.breakdown.tool_definitions.count, token_method: c.breakdown.tool_definitions.token_method, token_confidence: c.breakdown.tool_definitions.token_confidence },
        tool_calls: { tokens: c.breakdown.tool_calls.tokens, percentage: c.breakdown.tool_calls.percentage, count: c.breakdown.tool_calls.count, token_method: c.breakdown.tool_calls.token_method, token_confidence: c.breakdown.tool_calls.token_confidence },
        tool_results: { tokens: c.breakdown.tool_results.tokens, percentage: c.breakdown.tool_results.percentage, count: c.breakdown.tool_results.count, token_method: c.breakdown.tool_results.token_method, token_confidence: c.breakdown.tool_results.token_confidence },
        assistant_text: { tokens: c.breakdown.assistant_text.tokens, percentage: c.breakdown.assistant_text.percentage, token_method: c.breakdown.assistant_text.token_method, token_confidence: c.breakdown.assistant_text.token_confidence },
        user_text: { tokens: c.breakdown.user_text.tokens, percentage: c.breakdown.user_text.percentage, messageCount: c.breakdown.user_text.messageCount, token_method: c.breakdown.user_text.token_method, token_confidence: c.breakdown.user_text.token_confidence },
        thinking_blocks: { tokens: c.breakdown.thinking_blocks.tokens, percentage: c.breakdown.thinking_blocks.percentage, token_method: c.breakdown.thinking_blocks.token_method, token_confidence: c.breakdown.thinking_blocks.token_confidence },
        media: { tokens: c.breakdown.media.tokens, percentage: c.breakdown.media.percentage, count: c.breakdown.media.count, token_method: c.breakdown.media.token_method, token_confidence: c.breakdown.media.token_confidence },
        model: c.breakdown.model,
        response_tokens: c.breakdown.response_tokens,
      } : null,
      request: c.request,
      response: c.response,
    }));
    if (!paged) return res.json(items);
    const effectiveLimit = limit !== null ? limit : items.length;
    return res.json({
      items,
      page: {
        total: allCaptures.length,
        offset,
        limit: effectiveLimit,
        hasMore: offset + effectiveLimit < allCaptures.length,
      },
    });
  });

  router.get('/sessions/:id/capture/:captureId', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const capture = storage.getCaptureDetail(req.params.captureId);
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    if (capture.sessionId !== req.params.id) return res.status(404).json({ error: 'Capture not found in session' });
    res.json(capture);
  });

  router.get('/sessions/:id/composition', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const captures = storage.getSessionCaptures(session.id);
    if (captures.length === 0) return res.json({ composition: null });

    const rawTurn = req.query.turn !== undefined ? parseInt(req.query.turn, 10) : captures.length - 1;
    const turnIdx = Number.isNaN(rawTurn) ? captures.length - 1 : rawTurn;
    const capture = captures[Math.min(Math.max(0, turnIdx), captures.length - 1)];
    if (!capture || !capture.breakdown) return res.json({ composition: null });

    const b = capture.breakdown;
    const cost = calculateCost(b.total_tokens, b.response_tokens ? b.response_tokens.output : 0, b.model);

    const messageCount = (b.user_text.messageCount || 0) +
      (b.assistant_text.content ? b.assistant_text.content.length : 0) +
      (b.tool_calls.count || 0) +
      (b.tool_results.count || 0);

    res.json({
      composition: {
        categories: [
          { name: 'System Prompts', key: 'system_prompts', tokens: b.system_prompts.tokens, percentage: b.system_prompts.percentage, color: '#6366f1', token_method: b.system_prompts.token_method, token_confidence: b.system_prompts.token_confidence },
          { name: 'Tool Definitions', key: 'tool_definitions', tokens: b.tool_definitions.tokens, percentage: b.tool_definitions.percentage, color: '#f59e0b', token_method: b.tool_definitions.token_method, token_confidence: b.tool_definitions.token_confidence },
          { name: 'Tool Calls', key: 'tool_calls', tokens: b.tool_calls.tokens, percentage: b.tool_calls.percentage, color: '#ef4444', token_method: b.tool_calls.token_method, token_confidence: b.tool_calls.token_confidence },
          { name: 'Tool Results', key: 'tool_results', tokens: b.tool_results.tokens, percentage: b.tool_results.percentage, color: '#10b981', token_method: b.tool_results.token_method, token_confidence: b.tool_results.token_confidence },
          { name: 'Assistant Text', key: 'assistant_text', tokens: b.assistant_text.tokens, percentage: b.assistant_text.percentage, color: '#f97316', token_method: b.assistant_text.token_method, token_confidence: b.assistant_text.token_confidence },
          { name: 'User Text', key: 'user_text', tokens: b.user_text.tokens, percentage: b.user_text.percentage, color: '#06b6d4', token_method: b.user_text.token_method, token_confidence: b.user_text.token_confidence },
          { name: 'Thinking', key: 'thinking_blocks', tokens: b.thinking_blocks.tokens, percentage: b.thinking_blocks.percentage, color: '#a855f7', token_method: b.thinking_blocks.token_method, token_confidence: b.thinking_blocks.token_confidence },
          { name: 'Media', key: 'media', tokens: b.media.tokens, percentage: b.media.percentage, color: '#ec4899', token_method: b.media.token_method, token_confidence: b.media.token_confidence },
        ],
        total_tokens: b.total_tokens,
        model: b.model,
        cost,
        turn: turnIdx,
        messageCount,
        token_counting: b.token_counting,
      },
    });
  });

  router.get('/sessions/:id/timeline', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const timeline = storage.getTimeline(session.id);

    const enriched = timeline.map((turn) => {
      const cost = calculateCost(turn.breakdown.total, 0, turn.model);
      return { ...turn, cost };
    });
    res.json(enriched);
  });

  router.get('/sessions/:id/diffs', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const timeline = storage.getTimeline(session.id);
    const diffs = timeline.map((turn) => ({
      captureId: turn.captureId,
      timestamp: turn.timestamp,
      diff: turn.diff,
      model: turn.model,
    }));
    res.json(diffs);
  });

  router.get('/sessions/:id/findings', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const captures = storage.getSessionCaptures(req.params.id);
    res.json(generateFindings(session, captures));
  });

  router.get('/sessions/:id/trends', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const captures = storage.getSessionCaptures(req.params.id);
    const findings = generateFindings(session, captures);
    res.json(buildSessionTrends(session, captures, findings));
  });

  router.get('/reports/summary', (req, res) => {
    const days = Number.isFinite(Number(req.query.days)) ? Math.max(1, Number(req.query.days)) : 7;
    const scopedStorage = createScopedStorageView(storage, req.auth);
    const cachedEntry = analysisScheduler && analysisScheduler.getReportSummaryEntry
      ? analysisScheduler.getReportSummaryEntry(days)
      : null;
    const summary = (req.auth ? null : cachedEntry?.data) || buildReportsSummary(scopedStorage, days);
    res.json({
      ...summary,
      _cache: {
        source: !req.auth && cachedEntry ? 'background_cache' : 'request_path',
        refreshedAt: cachedEntry?.refreshedAt || Date.now(),
        cacheAgeMs: cachedEntry?.cacheAgeMs || 0,
      },
    });
  });

  router.get('/reports/compare', (req, res) => {
    const days = Number.isFinite(Number(req.query.days)) ? Math.max(1, Number(req.query.days)) : 7;
    const limit = Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(25, Number(req.query.limit))) : 8;
    const groupBy = req.query.groupBy ? String(req.query.groupBy) : 'project';
    const scopedStorage = createScopedStorageView(storage, req.auth);
    const comparison = buildCrossSessionComparison(scopedStorage, { days, limit, groupBy });
    return res.json(comparison);
  });

  router.get('/reports/session/:id/snapshot', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const captures = storage.getSessionCaptures(req.params.id);
    const findings = generateFindings(session, captures);
    const trends = buildSessionTrends(session, captures, findings);
    const snapshot = buildSessionSnapshot(session, captures, findings, trends);
    if (req.query.format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(formatSnapshotMarkdown(snapshot));
    }
    return res.json(snapshot);
  });

  router.get('/ci/summary', (req, res) => {
    const days = Number.isFinite(Number(req.query.days)) ? Math.max(1, Number(req.query.days)) : 7;
    const scopedStorage = createScopedStorageView(storage, req.auth);
    const cachedEntry = analysisScheduler && analysisScheduler.getCISummaryEntry
      ? analysisScheduler.getCISummaryEntry(days)
      : null;
    const summary = (req.auth ? null : cachedEntry?.data) || buildCISummary(scopedStorage, days);
    res.json({
      ...summary,
      _cache: {
        source: !req.auth && cachedEntry ? 'background_cache' : 'request_path',
        refreshedAt: cachedEntry?.refreshedAt || Date.now(),
        cacheAgeMs: cachedEntry?.cacheAgeMs || 0,
      },
    });
  });

  router.post('/analysis/refresh', requireRole('editor'), (req, res) => {
    if (!analysisScheduler || typeof analysisScheduler.refreshDays !== 'function') {
      return res.status(503).json({ error: 'Background analysis scheduler is disabled' });
    }

    const inputDays = req.body && Array.isArray(req.body.days) ? req.body.days : [req.body?.days || 7];
    const days = [...new Set(inputDays.map((d) => Number(d)).filter((d) => Number.isFinite(d) && d > 0))];
    analysisScheduler.refreshDays(days);
    return res.json({
      ok: true,
      refreshedDays: days,
      refreshedAt: analysisScheduler.lastRunAt || Date.now(),
    });
  });

  router.post('/ci/check', (req, res) => {
    const scopedStorage = createScopedStorageView(storage, req.auth);
    const report = runCICheck(scopedStorage, req.body || {});
    res.status(report.passed ? 200 : 422).json(report);
  });

  router.get('/sessions/:id/export', (req, res) => {
    const session = getScopedSession(storage, req, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const lhar = storage.exportLHAR(session.id);
    if (!lhar) return res.status(404).json({ error: 'Session not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=context-review-${req.params.id}.lhar.json`);
    res.json(lhar);
  });

  router.get('/stats', (req, res) => {
    const scoped = scopeSessionsForAuth(storage.getSessions(), req.auth);
    const sessions = filterSessions(scoped, req.query);
    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    for (const session of sessions) {
      totalRequests += session.requestCount;
      totalInputTokens += session.totalInputTokens;
      totalOutputTokens += session.totalOutputTokens;
      const cacheTokens = extractSessionCacheTokens(storage.getSessionCaptures(session.id));
      const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
      totalCost += cost.totalCost;
    }

    res.json({
      sessionCount: sessions.length,
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      totalCost: Math.round(totalCost * 1000000) / 1000000,
      models: MODEL_PRICING,
    });
  });

  router.get('/storage/status', (req, res) => {
    if (!storage || typeof storage.getStorageStatus !== 'function') {
      return res.status(503).json({ error: 'Storage status unavailable' });
    }
    return res.json(storage.getStorageStatus());
  });

  router.get('/health/storage', (req, res) => {
    if (!storage || typeof storage.getStorageStatus !== 'function') {
      return res.status(503).json({ ok: false, error: 'storage_status_unavailable' });
    }
    const status = storage.getStorageStatus();
    const degraded = Boolean(status.eventLog && status.eventLog.integrity && status.eventLog.integrity.degraded);
    if (degraded) {
      return res.status(503).json({
        ok: false,
        status: 'degraded',
        reason: status.eventLog.integrity.reason,
        storage: status,
      });
    }
    return res.json({ ok: true, status: 'healthy', storage: status });
  });

  router.get('/ops/summary', (req, res) => {
    if (!storage || typeof storage.getStorageStatus !== 'function') {
      return res.status(503).json({ ok: false, error: 'storage_status_unavailable' });
    }
    const storageStatus = storage.getStorageStatus();
    const degraded = Boolean(storageStatus.eventLog && storageStatus.eventLog.integrity && storageStatus.eventLog.integrity.degraded);
    const includeCi = String(req.query.includeCi || '') === '1';
    const ciWindowDays = Number.isFinite(Number(req.query.ciDays)) ? Math.max(1, Number(req.query.ciDays)) : 7;

    let ci = null;
    if (includeCi) {
      const scopedStorage = createScopedStorageView(storage, req.auth);
      ci = buildCISummary(scopedStorage, ciWindowDays);
    }

    return res.json({
      ok: !degraded,
      generatedAt: Date.now(),
      health: {
        storage: degraded ? 'degraded' : 'healthy',
      },
      storage: storageStatus,
      latency: latencyStore.snapshot(),
      ci,
    });
  });

  router.get('/ops/latency', (req, res) => {
    return res.json(latencyStore.snapshot());
  });

  router.post('/storage/compact', requireRole('admin'), (req, res) => {
    if (!storage || typeof storage.compactEventLog !== 'function') {
      return res.status(503).json({ error: 'Storage compaction unavailable' });
    }
    const maxEvents = Number.isFinite(Number(req.body?.maxEvents)) ? Number(req.body.maxEvents) : undefined;
    const maxAgeDays = Number.isFinite(Number(req.body?.maxAgeDays)) ? Number(req.body.maxAgeDays) : undefined;
    const maxAgeMs = maxAgeDays !== undefined ? Math.max(0, Math.floor(maxAgeDays * 24 * 60 * 60 * 1000)) : undefined;
    const result = storage.compactEventLog({
      maxEvents,
      maxAgeMs,
      dryRun: req.body?.dryRun === true,
      backupExisting: req.body?.backupExisting !== false,
      reason: req.body?.reason || 'api',
    });
    return res.json(result);
  });

  router.post('/storage/maintenance/run', requireRole('admin'), (req, res) => {
    if (!storage || typeof storage.runMaintenanceCompaction !== 'function') {
      return res.status(503).json({ error: 'Storage maintenance unavailable' });
    }
    const result = storage.runMaintenanceCompaction({
      reason: req.body?.reason || 'manual_maintenance',
      dryRun: req.body?.dryRun === true,
      force: req.body?.force === true,
    });
    return res.json(result);
  });

  router.delete('/sessions', requireRole('admin'), (req, res) => {
    storage.clearAll();
    res.json({ success: true });
  });

  return router;
}

function runActionSimulation(storage, payload) {
  const baseline = resolveSimulationBaseline(storage, payload);
  if (!baseline || !baseline.breakdown) {
    return { error: 'Missing simulation baseline. Provide sessionId/captureId or breakdown.' };
  }

  const actions = normalizeActions(payload.actions);
  if (actions.length === 0) return { error: 'No valid actions provided' };

  const simulated = applySimulationActions(baseline.breakdown, actions);
  const baselineInputTokens = inferInputTokens(baseline.breakdown);
  const simulatedInputTokens = inferSimulatedInputTokens(baseline.breakdown, simulated.breakdown, baselineInputTokens);
  const outputTokens = baseline.breakdown.response_tokens?.output || 0;
  const baselineCost = calculateCost(baselineInputTokens, outputTokens, baseline.breakdown.model);
  const simulatedCost = calculateCost(simulatedInputTokens, outputTokens, baseline.breakdown.model);

  return {
    baseline: {
      captureId: baseline.captureId,
      sessionId: baseline.sessionId,
      model: baseline.breakdown.model,
      total_tokens: baseline.breakdown.total_tokens,
      categories: summarizeCategories(baseline.breakdown),
      cost: baselineCost,
    },
    simulated: {
      model: baseline.breakdown.model,
      total_tokens: simulated.breakdown.total_tokens,
      categories: summarizeCategories(simulated.breakdown),
      cost: simulatedCost,
      actions: simulated.appliedActions,
    },
    delta: {
      tokens: simulated.breakdown.total_tokens - baseline.breakdown.total_tokens,
      tokens_saved: Math.max(0, baseline.breakdown.total_tokens - simulated.breakdown.total_tokens),
      token_percent_saved: baseline.breakdown.total_tokens > 0
        ? Math.round(((baseline.breakdown.total_tokens - simulated.breakdown.total_tokens) / baseline.breakdown.total_tokens) * 1000) / 10
        : 0,
      input_cost_delta: roundCurrency(simulatedCost.inputCost - baselineCost.inputCost),
      total_cost_delta: roundCurrency(simulatedCost.totalCost - baselineCost.totalCost),
      estimated_dollar_savings: roundCurrency(Math.max(0, baselineCost.totalCost - simulatedCost.totalCost)),
    },
  };
}

function resolveSimulationBaseline(storage, payload) {
  if (payload && payload.breakdown) {
    return {
      breakdown: payload.breakdown,
      captureId: payload.captureId || null,
      sessionId: payload.sessionId || null,
    };
  }

  if (!payload || !payload.captureId) return null;
  const capture = storage.getCaptureDetail(payload.captureId);
  if (!capture) return null;
  if (payload.sessionId && capture.sessionId !== payload.sessionId) return null;

  return {
    breakdown: capture.breakdown,
    captureId: capture.id,
    sessionId: capture.sessionId,
  };
}

function normalizeActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .map((action) => {
      if (!action) return null;
      if (typeof action === 'string') return { type: action };
      if (typeof action === 'object' && action.type) return action;
      return null;
    })
    .filter(Boolean);
}

function applySimulationActions(breakdown, actions) {
  const draft = JSON.parse(JSON.stringify(breakdown || {}));
  const appliedActions = [];
  if (!draft || typeof draft !== 'object') return { breakdown: null, appliedActions };

  const categoryKeys = ['system_prompts', 'tool_definitions', 'tool_calls', 'tool_results', 'assistant_text', 'user_text', 'thinking_blocks', 'media'];

  for (const action of actions) {
    const type = action.type;
    let reduced = 0;

    if (type === 'remove_tools') {
      reduced = applyToolRemoval(draft, action);
    } else if (type === 'trim_tool_results') {
      reduced = applyToolResultTrim(draft, action);
    } else if (type === 'compact_history') {
      reduced = applyHistoryCompaction(draft, action);
    } else if (type === 'shorten_system_prompt') {
      reduced = applySystemPromptShortening(draft, action);
    } else {
      continue;
    }

    appliedActions.push({
      type,
      params: action.params || {},
      estimatedTokenReduction: Math.max(0, Math.round(reduced)),
    });
  }

  draft.total_tokens = categoryKeys.reduce((sum, key) => sum + (draft[key]?.tokens || 0), 0);
  for (const key of categoryKeys) {
    if (!draft[key]) continue;
    draft[key].percentage = draft.total_tokens > 0
      ? Math.round(((draft[key].tokens || 0) / draft.total_tokens) * 100)
      : 0;
  }

  return { breakdown: draft, appliedActions };
}

function applyToolRemoval(breakdown, action) {
  const category = breakdown.tool_definitions;
  if (!category || !Array.isArray(category.content)) return 0;
  const params = action.params || {};
  const names = Array.isArray(params.names) ? new Set(params.names) : null;
  const fallbackRatio = Number.isFinite(params.ratio) ? clamp(params.ratio, 0, 1) : 0.3;

  let removed = 0;
  if (names && names.size > 0) {
    for (const tool of category.content) {
      if (names.has(tool.name)) removed += tool.tokens || 0;
    }
  } else {
    removed = Math.round((category.tokens || 0) * fallbackRatio);
  }

  category.tokens = Math.max(0, (category.tokens || 0) - removed);
  return removed;
}

function applyToolResultTrim(breakdown, action) {
  const category = breakdown.tool_results;
  if (!category || !Array.isArray(category.content)) return 0;
  const params = action.params || {};
  const msgIndex = Number.isFinite(params.msgIndex) ? params.msgIndex : null;
  const maxTokens = Number.isFinite(params.maxTokens) ? Math.max(0, params.maxTokens) : 1000;
  const defaultRatio = Number.isFinite(params.ratio) ? clamp(params.ratio, 0, 1) : 0.35;

  let removed = 0;
  if (msgIndex !== null) {
    for (const result of category.content) {
      if (result.msgIndex === msgIndex && (result.tokens || 0) > maxTokens) {
        removed += (result.tokens || 0) - maxTokens;
      }
    }
  } else {
    removed = Math.round((category.tokens || 0) * defaultRatio);
  }

  category.tokens = Math.max(0, (category.tokens || 0) - removed);
  return removed;
}

function applyHistoryCompaction(breakdown, action) {
  const params = action.params || {};
  const ratio = Number.isFinite(params.ratio) ? clamp(params.ratio, 0, 1) : 0.25;
  const targets = ['assistant_text', 'user_text', 'thinking_blocks', 'tool_results'];
  let removed = 0;
  for (const key of targets) {
    if (!breakdown[key]) continue;
    const delta = Math.round((breakdown[key].tokens || 0) * ratio);
    breakdown[key].tokens = Math.max(0, (breakdown[key].tokens || 0) - delta);
    removed += delta;
  }
  return removed;
}

function applySystemPromptShortening(breakdown, action) {
  const params = action.params || {};
  const ratio = Number.isFinite(params.ratio) ? clamp(params.ratio, 0, 1) : 0.2;
  const category = breakdown.system_prompts;
  if (!category) return 0;
  const removed = Math.round((category.tokens || 0) * ratio);
  category.tokens = Math.max(0, (category.tokens || 0) - removed);
  return removed;
}

function summarizeCategories(breakdown) {
  if (!breakdown) return {};
  return {
    system_prompts: breakdown.system_prompts?.tokens || 0,
    tool_definitions: breakdown.tool_definitions?.tokens || 0,
    tool_calls: breakdown.tool_calls?.tokens || 0,
    tool_results: breakdown.tool_results?.tokens || 0,
    assistant_text: breakdown.assistant_text?.tokens || 0,
    user_text: breakdown.user_text?.tokens || 0,
    thinking_blocks: breakdown.thinking_blocks?.tokens || 0,
    media: breakdown.media?.tokens || 0,
  };
}

function inferInputTokens(breakdown) {
  const reported = breakdown?.response_tokens?.input || 0;
  if (reported > 0) return reported;
  return breakdown?.total_tokens || 0;
}

function inferSimulatedInputTokens(baseline, simulated, baselineInputTokens) {
  const baseTotal = baseline?.total_tokens || 0;
  const simTotal = simulated?.total_tokens || 0;
  if (baseTotal <= 0) return baselineInputTokens;
  const ratio = simTotal / baseTotal;
  return Math.max(0, Math.round(baselineInputTokens * ratio));
}

function roundCurrency(value) {
  return Math.round((value || 0) * 1_000_000) / 1_000_000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function extractSessionCacheTokens(captures) {
  let totalRead = 0;
  let totalCreation = 0;
  for (const c of captures) {
    if (c.breakdown?.response_tokens) {
      totalRead += c.breakdown.response_tokens.cacheRead || 0;
      totalCreation += c.breakdown.response_tokens.cacheCreation || 0;
    }
  }
  if (totalRead === 0 && totalCreation === 0) return null;
  return { read: totalRead, creation: totalCreation };
}

function scopeSessionsForAuth(sessions, auth) {
  if (!auth) return sessions;
  const projects = Array.isArray(auth.projects) ? auth.projects : [];
  const users = Array.isArray(auth.users) ? auth.users : [];
  return sessions.filter((session) => {
    if ((session.tenant || 'default') !== auth.tenant) return false;
    if (projects.length > 0 && !projects.includes(session.project || 'default')) return false;
    if (users.length > 0 && !users.includes(session.user || 'anonymous')) return false;
    return true;
  });
}

function getScopedSession(storage, req, sessionId) {
  const session = storage.getSession(sessionId);
  if (!session) return null;
  const scoped = scopeSessionsForAuth([session], req.auth);
  return scoped.length > 0 ? session : null;
}

function createScopedStorageView(storage, auth) {
  if (!auth) return storage;
  return {
    getSessions() {
      return scopeSessionsForAuth(storage.getSessions(), auth);
    },
    getSessionCaptures(sessionId) {
      const session = storage.getSession(sessionId);
      if (!session) return [];
      const visible = scopeSessionsForAuth([session], auth);
      if (visible.length === 0) return [];
      return storage.getSessionCaptures(sessionId);
    },
    getSession(sessionId) {
      const session = storage.getSession(sessionId);
      if (!session) return null;
      const visible = scopeSessionsForAuth([session], auth);
      return visible.length > 0 ? session : null;
    },
  };
}

function applyAuthScopeToHeaders(auth, headers) {
  const merged = { ...headers };
  if (!auth) return merged;
  const projects = Array.isArray(auth.projects) ? auth.projects : [];
  const users = Array.isArray(auth.users) ? auth.users : [];
  merged['x-context-review-tenant'] = auth.tenant;

  if (projects.length > 0) {
    const requestedProject = String(merged['x-context-review-project'] || '').trim();
    merged['x-context-review-project'] = projects.includes(requestedProject) ? requestedProject : projects[0];
  } else if (!merged['x-context-review-project']) {
    merged['x-context-review-project'] = 'default';
  }

  if (users.length > 0) {
    const requestedUser = String(merged['x-context-review-user'] || '').trim();
    merged['x-context-review-user'] = users.includes(requestedUser) ? requestedUser : users[0];
  } else if (!merged['x-context-review-user'] && auth.subject) {
    merged['x-context-review-user'] = auth.subject;
  }

  return merged;
}

function createLatencyStore() {
  const byRoute = new Map();
  const startedAt = Date.now();
  const maxSamples = 200;

  return {
    record(method, path, statusCode, elapsedMs) {
      const key = `${method} ${path}`;
      const current = byRoute.get(key) || { count: 0, errors: 0, maxMs: 0, totalMs: 0, samples: [] };
      current.count += 1;
      current.totalMs += elapsedMs;
      if (statusCode >= 500) current.errors += 1;
      if (elapsedMs > current.maxMs) current.maxMs = elapsedMs;
      current.samples.push(elapsedMs);
      if (current.samples.length > maxSamples) current.samples.shift();
      byRoute.set(key, current);
    },
    snapshot() {
      const routes = [...byRoute.entries()].map(([route, stats]) => {
        const p50 = percentile(stats.samples, 50);
        const p95 = percentile(stats.samples, 95);
        const p99 = percentile(stats.samples, 99);
        return {
          route,
          count: stats.count,
          errors: stats.errors,
          avgMs: roundLatency(stats.count > 0 ? stats.totalMs / stats.count : 0),
          maxMs: roundLatency(stats.maxMs),
          p50Ms: p50,
          p95Ms: p95,
          p99Ms: p99,
        };
      }).sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);
      return {
        startedAt,
        generatedAt: Date.now(),
        routeCount: routes.length,
        routes,
      };
    },
  };
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return roundLatency(sorted[idx]);
}

function roundLatency(value) {
  return Math.round((value || 0) * 1000) / 1000;
}

module.exports = { createAPIRouter };
