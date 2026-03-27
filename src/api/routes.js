const express = require('express');
const { calculateCost, MODEL_PRICING, getContextWindow } = require('../cost/pricing');
const { generateFindings } = require('../findings/findings');
const { parseRequest } = require('../parser/parser');
const TREND_CATEGORIES = ['system_prompts', 'tool_definitions', 'tool_calls', 'tool_results', 'assistant_text', 'user_text', 'thinking_blocks', 'media'];

function createAPIRouter(storage) {
  const router = express.Router();

  router.post('/simulate', (req, res) => {
    if (Array.isArray(req.body.actions) && req.body.actions.length > 0) {
      const simulation = runActionSimulation(storage, req.body);
      if (simulation.error) return res.status(400).json({ error: simulation.error });
      return res.json(simulation);
    }

    const { provider, request: simReq } = req.body;
    if (!provider || !simReq) return res.status(400).json({ error: 'Missing provider or request' });

    const capture = {
      provider,
      timestamp: Date.now(),
      request: {
        method: 'POST',
        path: provider === 'anthropic' ? '/v1/messages' : provider === 'openai' ? '/v1/chat/completions' : '/v1beta/models/gemini/generateContent',
        headers: simReq.headers || {},
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
    const sessions = storage.getSessions();
    const enriched = sessions.map(session => {
      const cacheTokens = extractSessionCacheTokens(storage.getSessionCaptures(session.id));
      const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
      return {
        ...session,
        cost,
        turnBreakdowns: undefined,
      };
    });
    res.json(enriched);
  });

  router.get('/sessions/:id', (req, res) => {
    const session = storage.getSession(req.params.id);
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
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const captures = storage.getSessionCaptures(req.params.id);
    res.json(captures.map(c => ({
      id: c.id,
      timestamp: c.timestamp,
      provider: c.provider,
      model: c.model,
      agent: c.agent,
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
    })));
  });

  router.get('/sessions/:id/capture/:captureId', (req, res) => {
    const capture = storage.getCaptureDetail(req.params.captureId);
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    if (capture.sessionId !== req.params.id) return res.status(404).json({ error: 'Capture not found in session' });
    res.json(capture);
  });

  router.get('/sessions/:id/composition', (req, res) => {
    const captures = storage.getSessionCaptures(req.params.id);
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
    const timeline = storage.getTimeline(req.params.id);
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const enriched = timeline.map(turn => {
      const cost = calculateCost(turn.breakdown.total, 0, turn.model);
      return { ...turn, cost };
    });

    res.json(enriched);
  });

  router.get('/sessions/:id/diffs', (req, res) => {
    const timeline = storage.getTimeline(req.params.id);
    const diffs = timeline.map(turn => ({
      captureId: turn.captureId,
      timestamp: turn.timestamp,
      diff: turn.diff,
      model: turn.model,
    }));
    res.json(diffs);
  });

  router.get('/sessions/:id/findings', (req, res) => {
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const captures = storage.getSessionCaptures(req.params.id);
    const findings = generateFindings(session, captures);
    res.json(findings);
  });

  router.get('/sessions/:id/trends', (req, res) => {
    const session = storage.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const captures = storage.getSessionCaptures(req.params.id);
    const findings = generateFindings(session, captures);
    res.json(buildSessionTrends(session, captures, findings));
  });

  router.get('/reports/summary', (req, res) => {
    const days = Number.isFinite(Number(req.query.days)) ? Math.max(1, Number(req.query.days)) : 7;
    const summary = buildReportsSummary(storage, days);
    res.json(summary);
  });

  router.get('/sessions/:id/export', (req, res) => {
    const lhar = storage.exportLHAR(req.params.id);
    if (!lhar) return res.status(404).json({ error: 'Session not found' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=context-review-${req.params.id}.lhar.json`);
    res.json(lhar);
  });

  router.get('/stats', (req, res) => {
    const sessions = storage.getSessions();
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

  router.delete('/sessions', (req, res) => {
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

  const categoryKeys = [
    'system_prompts',
    'tool_definitions',
    'tool_calls',
    'tool_results',
    'assistant_text',
    'user_text',
    'thinking_blocks',
    'media',
  ];

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

function buildSessionTrends(session, captures, findings) {
  const turns = session.turnBreakdowns || [];
  const contextWindow = getContextWindow(session.model);
  const points = turns.map((turn, idx) => {
    const inputTokens = turn.breakdown.total || 0;
    const outputTokens = captures[idx]?.breakdown?.response_tokens?.output || 0;
    const cost = calculateCost(inputTokens, outputTokens, session.model);
    return {
      turn: idx + 1,
      captureId: turn.captureId,
      timestamp: turn.timestamp,
      total_tokens: inputTokens,
      cost: cost.totalCost,
      categories: summarizeCategoriesFromTurn(turn.breakdown),
    };
  });

  const deltas = [];
  for (let i = 1; i < points.length; i++) deltas.push(points[i].total_tokens - points[i - 1].total_tokens);
  const avgGrowth = deltas.length > 0 ? Math.round(deltas.reduce((sum, d) => sum + d, 0) / deltas.length) : 0;
  const positiveGrowth = deltas.filter((d) => d > 0);
  const trajectory = positiveGrowth.length > 0
    ? Math.round(positiveGrowth.reduce((sum, d) => sum + d, 0) / positiveGrowth.length)
    : 0;
  const currentTokens = points.length > 0 ? points[points.length - 1].total_tokens : 0;
  const remaining = Math.max(contextWindow - currentTokens, 0);
  const turnsRemaining = trajectory > 0 ? Math.max(0, Math.floor(remaining / trajectory)) : null;

  const avgTurnCost = points.length > 0
    ? points.reduce((sum, p) => sum + p.cost, 0) / points.length
    : 0;
  const latestTurnCost = points.length > 0 ? points[points.length - 1].cost : 0;
  const toolDefinitionPct = points.length > 0
    ? Math.round((points.reduce((sum, p) => sum + (p.categories.tool_definitions || 0), 0) / Math.max(1, points.reduce((sum, p) => sum + p.total_tokens, 0))) * 100)
    : 0;

  const largeToolResults = captures.reduce((count, c) => {
    const results = c.breakdown?.tool_results?.content || [];
    return count + results.filter((r) => (r.tokens || 0) > 2000).length;
  }, 0);

  const alerts = [];
  if (trajectory > 4000) {
    alerts.push({
      type: 'growth_trajectory',
      severity: 'high',
      message: `Context is growing by ~${trajectory} tokens on growth turns.`,
    });
  }
  if (avgTurnCost > 0 && latestTurnCost > avgTurnCost * 1.7) {
    alerts.push({
      type: 'cost_spike',
      severity: 'medium',
      message: `Latest turn cost ($${latestTurnCost.toFixed(4)}) is significantly above session average.`,
    });
  }
  if (largeToolResults >= 2) {
    alerts.push({
      type: 'large_tool_results',
      severity: 'medium',
      message: `${largeToolResults} oversized tool results detected across this session.`,
    });
  }
  if (toolDefinitionPct >= 30) {
    alerts.push({
      type: 'tool_definition_overhead',
      severity: 'medium',
      message: `Tool definitions account for ${toolDefinitionPct}% of session context.`,
    });
  }

  const recurringWaste = summarizeRecurringWaste(findings);
  const toolUsage = summarizeToolUsage(captures);
  const topContributors = summarizeTopContributors(points);

  return {
    sessionId: session.id,
    model: session.model,
    requestCount: session.requestCount,
    contextWindow,
    currentTokens,
    points,
    growth: {
      avgDeltaTokens: avgGrowth,
      positiveTrajectoryTokens: trajectory,
      turnsAnalyzed: points.length,
    },
    forecast: {
      turnsRemaining,
      remainingTokens: remaining,
      trajectoryTokensPerTurn: trajectory,
    },
    alerts,
    recurringWaste,
    toolUsage,
    topContributors,
  };
}

function summarizeCategoriesFromTurn(turnBreakdown) {
  if (!turnBreakdown) return {};
  const total = turnBreakdown.total || 1;
  const output = {};
  for (const key of TREND_CATEGORIES) {
    const value = turnBreakdown[key] || 0;
    output[key] = Math.round((value / total) * 100);
  }
  return output;
}

function summarizeRecurringWaste(findings) {
  const byCategory = new Map();
  for (const finding of findings || []) {
    const key = finding.category || 'other';
    const current = byCategory.get(key) || { category: key, count: 0, estimatedSavingsTokens: 0 };
    current.count += 1;
    current.estimatedSavingsTokens += finding.estimatedSavings?.tokens || 0;
    byCategory.set(key, current);
  }
  return [...byCategory.values()]
    .sort((a, b) => (b.estimatedSavingsTokens - a.estimatedSavingsTokens) || (b.count - a.count))
    .slice(0, 5);
}

function summarizeToolUsage(captures) {
  const calls = new Map();
  const definitions = new Map();

  for (const capture of captures || []) {
    const toolDefs = capture.breakdown?.tool_definitions?.content || [];
    for (const tool of toolDefs) {
      if (!tool?.name) continue;
      const current = definitions.get(tool.name) || { name: tool.name, definitionTokens: 0 };
      current.definitionTokens += tool.tokens || 0;
      definitions.set(tool.name, current);
    }

    const toolCalls = capture.breakdown?.tool_calls?.content || [];
    for (const call of toolCalls) {
      if (!call?.name) continue;
      const current = calls.get(call.name) || { name: call.name, callCount: 0, callTokens: 0 };
      current.callCount += 1;
      current.callTokens += call.tokens || 0;
      calls.set(call.name, current);
    }
  }

  const names = new Set([...definitions.keys(), ...calls.keys()]);
  return [...names].map((name) => {
    const d = definitions.get(name) || { definitionTokens: 0 };
    const c = calls.get(name) || { callCount: 0, callTokens: 0 };
    return {
      name,
      callCount: c.callCount,
      callTokens: c.callTokens,
      definitionTokens: d.definitionTokens,
      wasteScore: d.definitionTokens - c.callTokens,
    };
  }).sort((a, b) => (b.wasteScore - a.wasteScore) || (b.definitionTokens - a.definitionTokens)).slice(0, 10);
}

function summarizeTopContributors(points) {
  const latest = points[points.length - 1];
  if (!latest) return [];
  return Object.entries(latest.categories || {})
    .map(([category, percentage]) => ({ category, percentage }))
    .sort((a, b) => b.percentage - a.percentage)
    .slice(0, 3);
}

function buildReportsSummary(storage, days) {
  const now = Date.now();
  const cutoff = now - (days * 24 * 60 * 60 * 1000);
  const sessions = storage.getSessions().filter((session) => session.lastActivity >= cutoff);

  const expensiveSessions = [];
  const categoryAggregate = new Map();
  const unusedToolAggregate = new Map();
  const repeatedSystemBlocks = new Map();

  for (const session of sessions) {
    const captures = storage.getSessionCaptures(session.id);
    const cacheTokens = extractSessionCacheTokens(captures);
    const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
    expensiveSessions.push({
      sessionId: session.id,
      provider: session.provider,
      model: session.model,
      requestCount: session.requestCount,
      totalCost: cost.totalCost,
      totalInputTokens: session.totalInputTokens,
      lastActivity: session.lastActivity,
    });

    const findings = generateFindings(session, captures);
    for (const finding of findings) {
      const key = finding.category || 'other';
      const current = categoryAggregate.get(key) || { category: key, count: 0, estimatedSavingsTokens: 0 };
      current.count += 1;
      current.estimatedSavingsTokens += finding.estimatedSavings?.tokens || 0;
      categoryAggregate.set(key, current);

      if (Array.isArray(finding.tools)) {
        for (const tool of finding.tools) {
          const row = unusedToolAggregate.get(tool.name) || { name: tool.name, count: 0, tokens: 0 };
          row.count += 1;
          row.tokens += tool.tokens || 0;
          unusedToolAggregate.set(tool.name, row);
        }
      }
    }

    for (const capture of captures) {
      const prompts = capture.breakdown?.system_prompts?.content || [];
      for (const p of prompts) {
        const key = String(p.text || '').trim().slice(0, 120);
        if (!key) continue;
        const current = repeatedSystemBlocks.get(key) || { preview: key, count: 0, tokens: 0 };
        current.count += 1;
        current.tokens += p.tokens || 0;
        repeatedSystemBlocks.set(key, current);
      }
    }
  }

  return {
    generatedAt: now,
    windowDays: days,
    sessionCount: sessions.length,
    topWasteDrivers: [...categoryAggregate.values()]
      .sort((a, b) => (b.estimatedSavingsTokens - a.estimatedSavingsTokens) || (b.count - a.count))
      .slice(0, 5),
    mostExpensiveSessions: expensiveSessions
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 5),
    mostRepeatedSystemBlocks: [...repeatedSystemBlocks.values()]
      .filter((block) => block.count > 1)
      .sort((a, b) => (b.count - a.count) || (b.tokens - a.tokens))
      .slice(0, 5),
    unusedTools: [...unusedToolAggregate.values()]
      .sort((a, b) => (b.tokens - a.tokens) || (b.count - a.count))
      .slice(0, 8),
  };
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

module.exports = { createAPIRouter };
