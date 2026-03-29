#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { SessionStorage } = require('../src/storage/storage');
const { buildReportsSummary, buildCISummary, buildSessionTrends } = require('../src/analysis/session-analysis');
const { generateFindings } = require('../src/findings/findings');

const ARTIFACT_DIR = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'analysis-benchmark.json');
const SESSION_COUNT = Number(process.env.CI_ANALYSIS_BENCH_SESSION_COUNT || 900);
const CAPTURES_PER_SESSION = Number(process.env.CI_ANALYSIS_BENCH_CAPTURES_PER_SESSION || 3);
const REPORT_MAX_MS = Number(process.env.CI_ANALYSIS_BENCH_MAX_REPORT_MS || 3500);
const CI_SUMMARY_MAX_MS = Number(process.env.CI_ANALYSIS_BENCH_MAX_CI_MS || 2500);
const TRENDS_MAX_MS = Number(process.env.CI_ANALYSIS_BENCH_MAX_TRENDS_MS || 600);

function main() {
  try {
    const storage = new SessionStorage({ persistenceDisabled: true });
    seedSyntheticData(storage, SESSION_COUNT, CAPTURES_PER_SESSION);
    const sessions = storage.getSessions();
    const sampleSession = sessions[Math.min(5, sessions.length - 1)];
    const sampleCaptures = storage.getSessionCaptures(sampleSession.id);

    const reportStarted = Date.now();
    const report = buildReportsSummary(storage, 30);
    const reportMs = Date.now() - reportStarted;

    const ciStarted = Date.now();
    const ciSummary = buildCISummary(storage, 14);
    const ciMs = Date.now() - ciStarted;

    const trendsStarted = Date.now();
    const findings = generateFindings(sampleSession, sampleCaptures);
    const trends = buildSessionTrends(sampleSession, sampleCaptures, findings);
    const trendsMs = Date.now() - trendsStarted;

    const out = {
      checkedAt: new Date().toISOString(),
      sessionCount: SESSION_COUNT,
      capturesPerSession: CAPTURES_PER_SESSION,
      thresholds: {
        reportMaxMs: REPORT_MAX_MS,
        ciSummaryMaxMs: CI_SUMMARY_MAX_MS,
        trendsMaxMs: TRENDS_MAX_MS,
      },
      timings: {
        reportMs,
        ciSummaryMs: ciMs,
        trendsMs,
      },
      sample: {
        reportSessionCount: report.sessionCount,
        ciCurrentRequestCount: ciSummary.current.requestCount,
        trendsPoints: trends.points.length,
      },
      pass: reportMs <= REPORT_MAX_MS && ciMs <= CI_SUMMARY_MAX_MS && trendsMs <= TRENDS_MAX_MS,
    };

    ensureDir(ARTIFACT_DIR);
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify(out, null, 2));

    if (!out.pass) {
      throw new Error(`analysis benchmark exceeded thresholds: report=${reportMs}ms ci=${ciMs}ms trends=${trendsMs}ms`);
    }
    console.log(`Analysis benchmark OK (report=${reportMs}ms, ci=${ciMs}ms, trends=${trendsMs}ms)`);
  } catch (err) {
    console.error(`Analysis benchmark failed: ${err.message}`);
    process.exitCode = 1;
  }
}

function seedSyntheticData(storage, sessionCount, capturesPerSession) {
  const now = Date.now();
  for (let i = 0; i < sessionCount; i++) {
    const sessionId = `analysis-bench-session-${i}`;
    const provider = i % 3 === 0 ? 'google' : i % 2 === 0 ? 'openai' : 'anthropic';
    const model = provider === 'openai'
      ? 'gpt-4o'
      : provider === 'anthropic'
        ? 'claude-sonnet-4-20250514'
        : 'gemini-2.5-pro';
    const project = `project-${i % 14}`;
    const user = `user-${i % 10}`;
    const lastActivity = now - (i % 60) * 60_000;
    const turnBreakdowns = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let t = 0; t < capturesPerSession; t++) {
      const captureId = `${sessionId}-capture-${t}`;
      const input = 900 + ((i + t) % 500);
      const output = 140 + ((i + t) % 100);
      const totalTokens = 1050 + ((i + t) % 200);
      totalInputTokens += input;
      totalOutputTokens += output;
      turnBreakdowns.push({
        captureId,
        timestamp: lastActivity - ((capturesPerSession - t) * 1000),
        breakdown: {
          system_prompts: 130,
          tool_definitions: 190,
          tool_calls: 140,
          tool_results: 210,
          assistant_text: 160,
          user_text: 140,
          thinking_blocks: 50,
          media: 30,
          total: totalTokens,
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
        isStreaming: t % 2 === 0,
        breakdown: {
          total_tokens: totalTokens,
          model,
          system_prompts: { tokens: 130, content: [{ text: 'system prompt', tokens: 130 }] },
          tool_definitions: { tokens: 190, count: 2, content: [{ name: 'search', tokens: 90 }, { name: 'edit', tokens: 100 }] },
          tool_calls: { tokens: 140, count: 2, content: [{ name: 'search', tokens: 70 }, { name: 'edit', tokens: 70 }] },
          tool_results: { tokens: 210, count: 2, content: [{ name: 'search', tokens: 100 }, { name: 'edit', tokens: 110 }] },
          assistant_text: { tokens: 160, content: [{ tokens: 160 }] },
          user_text: { tokens: 140, messageCount: 1, content: [{ tokens: 140 }] },
          thinking_blocks: { tokens: 50, content: [{ tokens: 50 }] },
          media: { tokens: 30, count: 1, content: [{ tokens: 30 }] },
          response_tokens: { input, output, cacheRead: 0, cacheCreation: 0 },
        },
        request: { method: 'POST', path: '/v1/messages' },
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
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
