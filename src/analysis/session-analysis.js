const { calculateCost, getContextWindow } = require('../cost/pricing');
const { generateFindings } = require('../findings/findings');

const TREND_CATEGORIES = ['system_prompts', 'tool_definitions', 'tool_calls', 'tool_results', 'assistant_text', 'user_text', 'thinking_blocks', 'media'];

function filterSessions(sessions, query) {
  const provider = query.provider ? String(query.provider).toLowerCase() : null;
  const model = query.model ? String(query.model).toLowerCase() : null;
  const project = query.project ? String(query.project).toLowerCase() : null;
  const user = query.user ? String(query.user).toLowerCase() : null;
  const agent = query.agent ? String(query.agent).toLowerCase() : null;
  const fromTs = parseTimeQuery(query.from);
  const toTs = parseTimeQuery(query.to);

  return sessions.filter((session) => {
    if (provider && String(session.provider || '').toLowerCase() !== provider) return false;
    if (model && !String(session.model || '').toLowerCase().includes(model)) return false;
    if (project && String(session.project || 'default').toLowerCase() !== project) return false;
    if (user && String(session.user || 'anonymous').toLowerCase() !== user) return false;
    if (agent && !sessionHasAgent(session, agent)) return false;
    if (fromTs && session.lastActivity < fromTs) return false;
    if (toTs && session.lastActivity > toTs) return false;
    return true;
  });
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

function buildCrossSessionComparison(storage, options = {}) {
  const now = Date.now();
  const days = Number.isFinite(Number(options.days)) ? Math.max(1, Number(options.days)) : 7;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(25, Number(options.limit))) : 8;
  const includeSessionIds = options.includeSessionIds === true;
  const sessionIdsLimit = Number.isFinite(Number(options.sessionIdsLimit))
    ? Math.max(1, Math.min(200, Number(options.sessionIdsLimit)))
    : 80;
  const groupBy = normalizeGroupBy(options.groupBy);
  const windowMs = days * 24 * 60 * 60 * 1000;
  const current = buildGroupedWindow(storage, {
    groupBy,
    start: now - windowMs,
    end: now,
    includeSessionIds,
    sessionIdsLimit,
  });
  const previous = buildGroupedWindow(storage, {
    groupBy,
    start: now - (2 * windowMs),
    end: now - windowMs,
    includeSessionIds,
    sessionIdsLimit,
  });

  const keys = new Set([...current.keys(), ...previous.keys()]);
  const items = [...keys].map((key) => {
    const currentRow = current.get(key) || createEmptyGroupRow(key);
    const previousRow = previous.get(key) || createEmptyGroupRow(key);
    return {
      group: key,
      current: finalizeGroupRow(currentRow, { includeSessionIds, sessionIdsLimit }),
      previous: finalizeGroupRow(previousRow, { includeSessionIds, sessionIdsLimit }),
      delta: {
        avgInputTokensPerRequestPct: percentDelta(previousRow.avgInputTokensPerRequest, currentRow.avgInputTokensPerRequest),
        avgCostPerRequestPct: percentDelta(previousRow.avgCostPerRequest, currentRow.avgCostPerRequest),
        estimatedWasteTokensPct: percentDelta(previousRow.estimatedWasteTokens, currentRow.estimatedWasteTokens),
      },
    };
  }).sort((a, b) => {
    const wasteDiff = b.current.estimatedWasteTokens - a.current.estimatedWasteTokens;
    if (wasteDiff !== 0) return wasteDiff;
    return b.current.totalCost - a.current.totalCost;
  }).slice(0, limit);

  return {
    generatedAt: now,
    windowDays: days,
    groupBy,
    itemCount: items.length,
    items,
  };
}

function buildSessionSnapshot(session, captures, findings, trends) {
  const cacheTokens = extractSessionCacheTokens(captures);
  const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
  const topFindings = (findings || []).slice(0, 5).map((finding) => ({
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    estimatedSavingsTokens: finding.estimatedSavings?.tokens || 0,
    recommendation: finding.recommendation?.summary || finding.suggestion || '',
  }));

  return {
    generatedAt: Date.now(),
    session: {
      id: session.id,
      provider: session.provider,
      model: session.model,
      project: session.project || 'default',
      user: session.user || 'anonymous',
      requestCount: session.requestCount,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCost: cost.totalCost,
      startTime: session.startTime,
      lastActivity: session.lastActivity,
    },
    trends: {
      growth: trends.growth,
      forecast: trends.forecast,
      alerts: trends.alerts,
      topContributors: trends.topContributors,
    },
    findings: topFindings,
  };
}

function formatSnapshotMarkdown(snapshot) {
  const lines = [];
  const s = snapshot.session;
  lines.push('# Context Review Snapshot');
  lines.push('');
  lines.push(`- Session: \`${s.id}\``);
  lines.push(`- Provider/Model: ${s.provider} / ${s.model}`);
  lines.push(`- Project/User: ${s.project} / ${s.user}`);
  lines.push(`- Requests: ${s.requestCount}`);
  lines.push(`- Input Tokens: ${s.totalInputTokens}`);
  lines.push(`- Output Tokens: ${s.totalOutputTokens}`);
  lines.push(`- Cost: $${Number(s.totalCost || 0).toFixed(4)}`);
  lines.push('');
  lines.push('## Forecast');
  lines.push(`- Turns remaining: ${snapshot.trends.forecast.turnsRemaining === null ? 'N/A' : snapshot.trends.forecast.turnsRemaining}`);
  lines.push(`- Remaining tokens: ${snapshot.trends.forecast.remainingTokens}`);
  lines.push(`- Growth trajectory: ${snapshot.trends.forecast.trajectoryTokensPerTurn} tokens/turn`);
  lines.push('');
  lines.push('## Alerts');
  if ((snapshot.trends.alerts || []).length === 0) {
    lines.push('- None');
  } else {
    for (const alert of snapshot.trends.alerts) lines.push(`- [${alert.severity}] ${alert.message}`);
  }
  lines.push('');
  lines.push('## Top Findings');
  if ((snapshot.findings || []).length === 0) {
    lines.push('- None');
  } else {
    for (const finding of snapshot.findings) {
      lines.push(`- [${finding.severity}] ${finding.title} (save ~${finding.estimatedSavingsTokens}t)`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildCISummary(storage, days) {
  const current = buildMetricsWindow(storage, days, 0);
  const previous = buildMetricsWindow(storage, days, 1);
  const regression = {
    avgInputTokensDeltaPct: percentDelta(previous.avgInputTokensPerRequest, current.avgInputTokensPerRequest),
    avgCostDeltaPct: percentDelta(previous.avgCostPerRequest, current.avgCostPerRequest),
    unusedToolFindingsDeltaPct: percentDelta(previous.unusedToolFindingsPerSession, current.unusedToolFindingsPerSession),
    avgToolDefinitionPctDelta: roundMetric(current.avgToolDefinitionPct - previous.avgToolDefinitionPct),
  };
  return {
    generatedAt: Date.now(),
    windowDays: days,
    current,
    previous,
    regression,
  };
}

function runCICheck(storage, payload) {
  const days = Number.isFinite(Number(payload.days)) ? Math.max(1, Number(payload.days)) : 7;
  const summary = buildCISummary(storage, days);
  const thresholds = {
    maxInputInflationPct: Number.isFinite(Number(payload.maxInputInflationPct)) ? Number(payload.maxInputInflationPct) : 15,
    maxCostInflationPct: Number.isFinite(Number(payload.maxCostInflationPct)) ? Number(payload.maxCostInflationPct) : 20,
    maxUnusedToolsIncreasePct: Number.isFinite(Number(payload.maxUnusedToolsIncreasePct)) ? Number(payload.maxUnusedToolsIncreasePct) : 15,
    maxToolDefinitionPct: Number.isFinite(Number(payload.maxToolDefinitionPct)) ? Number(payload.maxToolDefinitionPct) : 35,
  };

  const failures = [];
  if (summary.regression.avgInputTokensDeltaPct > thresholds.maxInputInflationPct) {
    failures.push(`Input tokens/request grew by ${summary.regression.avgInputTokensDeltaPct}% (threshold ${thresholds.maxInputInflationPct}%)`);
  }
  if (summary.regression.avgCostDeltaPct > thresholds.maxCostInflationPct) {
    failures.push(`Cost/request grew by ${summary.regression.avgCostDeltaPct}% (threshold ${thresholds.maxCostInflationPct}%)`);
  }
  if (summary.regression.unusedToolFindingsDeltaPct > thresholds.maxUnusedToolsIncreasePct) {
    failures.push(`Unused-tool findings/session grew by ${summary.regression.unusedToolFindingsDeltaPct}% (threshold ${thresholds.maxUnusedToolsIncreasePct}%)`);
  }
  if (summary.current.avgToolDefinitionPct > thresholds.maxToolDefinitionPct) {
    failures.push(`Average tool-definition share is ${summary.current.avgToolDefinitionPct}% (threshold ${thresholds.maxToolDefinitionPct}%)`);
  }

  return {
    passed: failures.length === 0,
    failures,
    thresholds,
    summary,
  };
}

function buildMetricsWindow(storage, days, offsetWindow) {
  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const end = now - (offsetWindow * windowMs);
  const start = end - windowMs;
  const sessions = storage.getSessions().filter((session) => session.lastActivity >= start && session.lastActivity < end);

  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalCost = 0;
  let toolDefinitionPctSum = 0;
  let toolDefinitionPctSamples = 0;
  let unusedToolFindings = 0;

  for (const session of sessions) {
    totalRequests += session.requestCount;
    totalInputTokens += session.totalInputTokens;
    const captures = storage.getSessionCaptures(session.id);
    const cacheTokens = extractSessionCacheTokens(captures);
    const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
    totalCost += cost.totalCost;
    const findings = generateFindings(session, captures);
    unusedToolFindings += findings.filter((finding) => finding.category === 'tool_definitions' && Array.isArray(finding.tools)).length;
    for (const capture of captures) {
      const total = capture.breakdown?.total_tokens || 0;
      const defs = capture.breakdown?.tool_definitions?.tokens || 0;
      if (total > 0) {
        toolDefinitionPctSum += (defs / total) * 100;
        toolDefinitionPctSamples += 1;
      }
    }
  }

  return {
    start,
    end,
    sessionCount: sessions.length,
    requestCount: totalRequests,
    avgInputTokensPerRequest: totalRequests > 0 ? Math.round(totalInputTokens / totalRequests) : 0,
    avgCostPerRequest: totalRequests > 0 ? roundMetric(totalCost / totalRequests) : 0,
    unusedToolFindingsPerSession: sessions.length > 0 ? roundMetric(unusedToolFindings / sessions.length) : 0,
    avgToolDefinitionPct: toolDefinitionPctSamples > 0 ? roundMetric(toolDefinitionPctSum / toolDefinitionPctSamples) : 0,
  };
}

function normalizeGroupBy(value) {
  const valid = new Set(['project', 'user', 'model', 'provider']);
  const requested = String(value || 'project').toLowerCase();
  return valid.has(requested) ? requested : 'project';
}

function buildGroupedWindow(storage, options) {
  const sessions = storage.getSessions().filter((session) => session.lastActivity >= options.start && session.lastActivity < options.end);
  const map = new Map();
  for (const session of sessions) {
    const key = resolveGroupKey(session, options.groupBy);
    if (!map.has(key)) map.set(key, createEmptyGroupRow(key));
    const row = map.get(key);
    const captures = storage.getSessionCaptures(session.id);
    const cacheTokens = extractSessionCacheTokens(captures);
    const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
    const findings = generateFindings(session, captures);

    row.sessionCount += 1;
    row.requestCount += session.requestCount || 0;
    row.totalInputTokens += session.totalInputTokens || 0;
    row.totalCost += cost.totalCost || 0;
    row.estimatedWasteTokens += findings.reduce((sum, finding) => sum + (finding.estimatedSavings?.tokens || 0), 0);
    if (options.includeSessionIds === true && row.sessionIds.length < options.sessionIdsLimit) {
      row.sessionIds.push(session.id);
    }
  }
  return map;
}

function resolveGroupKey(session, groupBy) {
  if (groupBy === 'user') return session.user || 'anonymous';
  if (groupBy === 'model') return session.model || 'unknown';
  if (groupBy === 'provider') return session.provider || 'unknown';
  return session.project || 'default';
}

function createEmptyGroupRow(group) {
  return {
    group,
    sessionCount: 0,
    requestCount: 0,
    totalInputTokens: 0,
    totalCost: 0,
    estimatedWasteTokens: 0,
    avgInputTokensPerRequest: 0,
    avgCostPerRequest: 0,
    sessionIds: [],
  };
}

function finalizeGroupRow(row, options = {}) {
  const out = {
    group: row.group,
    sessionCount: row.sessionCount,
    requestCount: row.requestCount,
    totalInputTokens: row.totalInputTokens,
    totalCost: roundMetric(row.totalCost),
    estimatedWasteTokens: row.estimatedWasteTokens,
    avgInputTokensPerRequest: row.requestCount > 0 ? Math.round(row.totalInputTokens / row.requestCount) : 0,
    avgCostPerRequest: row.requestCount > 0 ? roundMetric(row.totalCost / row.requestCount) : 0,
  };
  if (options.includeSessionIds === true) {
    out.sessionIds = [...new Set(row.sessionIds || [])].slice(0, options.sessionIdsLimit || 80);
  }
  return out;
}

function parseTimeQuery(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionHasAgent(session, agentFilter) {
  const normalized = String(agentFilter).toLowerCase();
  const entries = Object.entries(session.agents || {});
  if (entries.length === 0) return normalized === 'unknown';
  return entries.some(([id, data]) => {
    return String(id).toLowerCase().includes(normalized) || String(data?.name || '').toLowerCase().includes(normalized);
  });
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

function percentDelta(previous, current) {
  if (!previous && !current) return 0;
  if (!previous && current) return 100;
  return roundMetric(((current - previous) / previous) * 100);
}

function roundMetric(value) {
  return Math.round((value || 0) * 100) / 100;
}

module.exports = {
  filterSessions,
  buildSessionTrends,
  buildReportsSummary,
  buildSessionSnapshot,
  formatSnapshotMarkdown,
  buildCISummary,
  runCICheck,
  buildCrossSessionComparison,
};
