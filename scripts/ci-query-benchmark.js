#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { SessionStorage } = require('../src/storage/storage');
const { filterSessions, buildReportsSummary } = require('../src/analysis/session-analysis');
const { calculateCost } = require('../src/cost/pricing');

const ARTIFACT_DIR = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'query-benchmark.json');
const SESSION_COUNT = Number(process.env.CI_QUERY_BENCH_SESSION_COUNT || 1200);
const CAPTURES_PER_SESSION = Number(process.env.CI_QUERY_BENCH_CAPTURES_PER_SESSION || 2);
const FILTER_MAX_MS = Number(process.env.CI_QUERY_BENCH_MAX_FILTER_MS || 800);
const REPORT_MAX_MS = Number(process.env.CI_QUERY_BENCH_MAX_REPORT_MS || 3000);

function main() {
  try {
    const storage = new SessionStorage({ persistenceDisabled: true });
    seedSyntheticData(storage, SESSION_COUNT, CAPTURES_PER_SESSION);

    const filterStarted = Date.now();
    const filtered = filterSessions(storage.getSessions(), {
      provider: 'openai',
      project: 'project-3',
      user: 'user-2',
      from: Date.now() - (7 * 24 * 60 * 60 * 1000),
    });
    const filterMs = Date.now() - filterStarted;

    const listStarted = Date.now();
    let listCostTotal = 0;
    for (const session of filtered) {
      const captures = storage.getSessionCaptures(session.id);
      const cacheTokens = extractSessionCacheTokens(captures);
      const cost = calculateCost(session.totalInputTokens, session.totalOutputTokens, session.model, cacheTokens);
      listCostTotal += cost.totalCost;
    }
    const listMs = Date.now() - listStarted;

    const reportStarted = Date.now();
    const report = buildReportsSummary(storage, 30);
    const reportMs = Date.now() - reportStarted;

    const out = {
      checkedAt: new Date().toISOString(),
      sessionCount: SESSION_COUNT,
      capturesPerSession: CAPTURES_PER_SESSION,
      thresholds: {
        filterMaxMs: FILTER_MAX_MS,
        reportMaxMs: REPORT_MAX_MS,
      },
      timings: {
        filterMs,
        listMs,
        reportMs,
      },
      sample: {
        filteredCount: filtered.length,
        listCostTotal,
        reportSessionCount: report.sessionCount,
      },
      pass: filterMs <= FILTER_MAX_MS && reportMs <= REPORT_MAX_MS,
    };

    ensureDir(ARTIFACT_DIR);
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify(out, null, 2));

    if (!out.pass) {
      throw new Error(`query benchmark exceeded thresholds: filter=${filterMs}ms report=${reportMs}ms`);
    }
    console.log(`Query benchmark OK (filter=${filterMs}ms, report=${reportMs}ms)`);
  } catch (err) {
    console.error(`Query benchmark failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function seedSyntheticData(storage, sessionCount, capturesPerSession) {
  const now = Date.now();
  for (let i = 0; i < sessionCount; i++) {
    const sessionId = `bench-session-${i}`;
    const provider = i % 2 === 0 ? 'openai' : 'anthropic';
    const model = provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514';
    const project = `project-${i % 10}`;
    const user = `user-${i % 6}`;
    const lastActivity = now - (i % 40) * 60_000;
    const turnBreakdowns = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let t = 0; t < capturesPerSession; t++) {
      const captureId = `${sessionId}-capture-${t}`;
      const input = 800 + ((i + t) % 300);
      const output = 120 + ((i + t) % 80);
      totalInputTokens += input;
      totalOutputTokens += output;
      turnBreakdowns.push({
        captureId,
        timestamp: lastActivity - ((capturesPerSession - t) * 1000),
        breakdown: {
          system_prompts: 100,
          tool_definitions: 120,
          tool_calls: 110,
          tool_results: 140,
          assistant_text: 150,
          user_text: 140,
          thinking_blocks: 80,
          media: 60,
          total: 900,
        },
        diff: {},
        model,
        agent: { id: 'codex', name: 'Codex' },
      });
      storage.captures.push({
        id: captureId,
        sessionId,
        timestamp: lastActivity - ((capturesPerSession - t) * 1000),
        provider,
        model,
        agent: { id: 'codex', name: 'Codex' },
        tenant: 'bench',
        project,
        user,
        isStreaming: false,
        breakdown: {
          total_tokens: 900,
          model,
          system_prompts: { tokens: 100, content: [{ text: 'system', tokens: 100 }] },
          tool_definitions: { tokens: 120, count: 1, content: [{ name: 'tool', tokens: 120 }] },
          tool_calls: { tokens: 110, count: 1, content: [{ name: 'tool', tokens: 110 }] },
          tool_results: { tokens: 140, count: 1, content: [{ name: 'tool', tokens: 140 }] },
          assistant_text: { tokens: 150, content: [{ tokens: 150 }] },
          user_text: { tokens: 140, messageCount: 1, content: [{ tokens: 140 }] },
          thinking_blocks: { tokens: 80, content: [{ tokens: 80 }] },
          media: { tokens: 60, count: 1, content: [{ tokens: 60 }] },
          response_tokens: { input, output, cacheRead: 0, cacheCreation: 0 },
        },
        request: { method: 'POST', path: '/v1/chat/completions' },
        response: { statusCode: 200 },
      });
    }

    storage.sessions.set(sessionId, {
      id: sessionId,
      provider,
      startTime: lastActivity - capturesPerSession * 1000,
      lastActivity,
      requestCount: capturesPerSession,
      totalInputTokens,
      totalOutputTokens,
      agents: {
        codex: {
          name: 'Codex',
          requestCount: capturesPerSession,
          totalTokens: capturesPerSession * 900,
          totalCost: 0,
        },
      },
      turnBreakdowns,
      model,
      tenant: 'bench',
      project,
      user,
    });
  }
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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
