#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { SessionStorage } = require('../src/storage/storage');
const { filterSessions, buildReportsSummary, buildCrossSessionComparison, runCICheck } = require('../src/analysis/session-analysis');

const ARTIFACT_DIR = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'long-horizon-benchmark.json');

const HORIZON_DAYS = Number(process.env.CI_LONG_HORIZON_BENCH_DAYS || 45);
const SESSIONS_PER_DAY = Number(process.env.CI_LONG_HORIZON_BENCH_SESSIONS_PER_DAY || 24);
const CAPTURES_PER_SESSION = Number(process.env.CI_LONG_HORIZON_BENCH_CAPTURES_PER_SESSION || 2);

const MAX_FILTER_MS = Number(process.env.CI_LONG_HORIZON_BENCH_MAX_FILTER_MS || 1400);
const MAX_REPORT_MS = Number(process.env.CI_LONG_HORIZON_BENCH_MAX_REPORT_MS || 5200);
const MAX_COMPARE_MS = Number(process.env.CI_LONG_HORIZON_BENCH_MAX_COMPARE_MS || 3200);
const MAX_CI_CHECK_MS = Number(process.env.CI_LONG_HORIZON_BENCH_MAX_CI_CHECK_MS || 2500);

function main() {
  try {
    const storage = new SessionStorage({ persistenceDisabled: true });
    seedLongHorizonData(storage, {
      horizonDays: HORIZON_DAYS,
      sessionsPerDay: SESSIONS_PER_DAY,
      capturesPerSession: CAPTURES_PER_SESSION,
    });

    const filterStarted = Date.now();
    const filtered = filterSessions(storage.getSessions(), {
      from: Date.now() - (30 * 24 * 60 * 60 * 1000),
      project: 'project-3',
      provider: 'openai',
    });
    const filterMs = Date.now() - filterStarted;

    const reportStarted = Date.now();
    const report = buildReportsSummary(storage, 30);
    const reportMs = Date.now() - reportStarted;

    const compareStarted = Date.now();
    const compare = buildCrossSessionComparison(storage, { days: 30, groupBy: 'project', limit: 10 });
    const compareMs = Date.now() - compareStarted;

    const ciStarted = Date.now();
    const ciCheck = runCICheck(storage, {
      days: 30,
      maxInputInflationPct: 1000,
      maxCostInflationPct: 1000,
      maxUnusedToolsIncreasePct: 1000,
      maxToolDefinitionPct: 1000,
    });
    const ciCheckMs = Date.now() - ciStarted;

    const out = {
      checkedAt: new Date().toISOString(),
      horizonDays: HORIZON_DAYS,
      sessionsPerDay: SESSIONS_PER_DAY,
      capturesPerSession: CAPTURES_PER_SESSION,
      totals: {
        sessions: HORIZON_DAYS * SESSIONS_PER_DAY,
        captures: HORIZON_DAYS * SESSIONS_PER_DAY * CAPTURES_PER_SESSION,
      },
      thresholds: {
        filterMaxMs: MAX_FILTER_MS,
        reportMaxMs: MAX_REPORT_MS,
        compareMaxMs: MAX_COMPARE_MS,
        ciCheckMaxMs: MAX_CI_CHECK_MS,
      },
      timings: {
        filterMs,
        reportMs,
        compareMs,
        ciCheckMs,
      },
      sample: {
        filteredSessions: filtered.length,
        reportSessionCount: report.sessionCount,
        comparisonItems: compare.itemCount,
        ciPassed: ciCheck.passed,
      },
      pass: filterMs <= MAX_FILTER_MS &&
        reportMs <= MAX_REPORT_MS &&
        compareMs <= MAX_COMPARE_MS &&
        ciCheckMs <= MAX_CI_CHECK_MS,
    };

    ensureDir(ARTIFACT_DIR);
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify(out, null, 2));

    if (!out.pass) {
      throw new Error(`long-horizon benchmark exceeded thresholds: filter=${filterMs}ms report=${reportMs}ms compare=${compareMs}ms ciCheck=${ciCheckMs}ms`);
    }
    console.log(`Long-horizon benchmark OK (filter=${filterMs}ms, report=${reportMs}ms, compare=${compareMs}ms, ciCheck=${ciCheckMs}ms)`);
  } catch (err) {
    console.error(`Long-horizon benchmark failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function seedLongHorizonData(storage, options) {
  const now = Date.now();
  const providers = ['openai', 'anthropic', 'google'];
  const models = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514',
    google: 'gemini-2.5-pro',
  };

  let counter = 0;
  for (let day = 0; day < options.horizonDays; day++) {
    for (let i = 0; i < options.sessionsPerDay; i++) {
      const sessionId = `long-horizon-session-${counter}`;
      const provider = providers[counter % providers.length];
      const model = models[provider];
      const dayTs = now - (day * 24 * 60 * 60 * 1000);
      const minuteOffset = (i % 24) * 60_000;
      const lastActivity = dayTs - minuteOffset;
      const project = `project-${counter % 16}`;
      const user = `user-${counter % 10}`;
      const turnBreakdowns = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (let t = 0; t < options.capturesPerSession; t++) {
        const captureId = `${sessionId}-capture-${t}`;
        const ts = lastActivity - ((options.capturesPerSession - t) * 1000);
        const input = 700 + ((counter + t) % 450);
        const output = 120 + ((counter + t) % 120);
        const total = 980 + ((counter + t) % 220);
        totalInputTokens += input;
        totalOutputTokens += output;
        turnBreakdowns.push({
          captureId,
          timestamp: ts,
          breakdown: {
            system_prompts: 120,
            tool_definitions: 170,
            tool_calls: 140,
            tool_results: 200,
            assistant_text: 170,
            user_text: 120,
            thinking_blocks: 40,
            media: 20,
            total,
          },
          diff: {},
          model,
          agent: { id: 'codex', name: 'Codex' },
        });
        storage.captures.push({
          id: captureId,
          sessionId,
          timestamp: ts,
          provider,
          model,
          agent: { id: 'codex', name: 'Codex' },
          tenant: 'bench',
          project,
          user,
          isStreaming: t % 2 === 0,
          breakdown: {
            total_tokens: total,
            model,
            system_prompts: { tokens: 120, content: [{ text: 'system block', tokens: 120 }] },
            tool_definitions: { tokens: 170, count: 2, content: [{ name: 'search', tokens: 80 }, { name: 'edit', tokens: 90 }] },
            tool_calls: { tokens: 140, count: 2, content: [{ name: 'search', tokens: 70 }, { name: 'edit', tokens: 70 }] },
            tool_results: { tokens: 200, count: 2, content: [{ name: 'search', tokens: 100 }, { name: 'edit', tokens: 100 }] },
            assistant_text: { tokens: 170, content: [{ tokens: 170 }] },
            user_text: { tokens: 120, messageCount: 1, content: [{ tokens: 120 }] },
            thinking_blocks: { tokens: 40, content: [{ tokens: 40 }] },
            media: { tokens: 20, count: 1, content: [{ tokens: 20 }] },
            response_tokens: { input, output, cacheRead: 0, cacheCreation: 0 },
          },
          request: { method: 'POST', path: '/v1/messages' },
          response: { statusCode: 200 },
        });
      }

      storage.sessions.set(sessionId, {
        id: sessionId,
        provider,
        startTime: lastActivity - options.capturesPerSession * 1000,
        lastActivity,
        requestCount: options.capturesPerSession,
        totalInputTokens,
        totalOutputTokens,
        agents: {
          codex: {
            name: 'Codex',
            requestCount: options.capturesPerSession,
            totalTokens: turnBreakdowns.reduce((sum, turn) => sum + turn.breakdown.total, 0),
            totalCost: 0,
          },
        },
        turnBreakdowns,
        model,
        tenant: 'bench',
        project,
        user,
      });

      counter += 1;
    }
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
