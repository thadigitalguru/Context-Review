#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionStorage } = require('../src/storage/storage');

const ARTIFACT_DIR = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'storage-benchmark.json');
const EVENT_COUNT = Number(process.env.CI_STORAGE_BENCH_EVENT_COUNT || 500);
const MAX_REPLAY_MS = Number(process.env.CI_STORAGE_BENCH_MAX_REPLAY_MS || 2000);

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-storage-bench-'));
  try {
    buildSyntheticEventLog(tempDir, EVENT_COUNT);

    const started = Date.now();
    const reloaded = new SessionStorage({
      adapterMode: 'event',
      dataDir: tempDir,
      persistenceDisabled: false,
    });
    const replayMs = Date.now() - started;
    const status = reloaded.getStorageStatus();

    const report = {
      checkedAt: new Date().toISOString(),
      eventCount: EVENT_COUNT,
      maxReplayMs: MAX_REPLAY_MS,
      replayMs,
      pass: replayMs <= MAX_REPLAY_MS,
      storageTelemetry: status.eventLog?.telemetry || null,
    };

    ensureDir(ARTIFACT_DIR);
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify(report, null, 2));
    if (!report.pass) {
      throw new Error(`storage replay benchmark exceeded threshold: ${replayMs}ms > ${MAX_REPLAY_MS}ms`);
    }
    console.log(`Storage replay benchmark OK (${replayMs}ms <= ${MAX_REPLAY_MS}ms)`);
  } catch (err) {
    console.error(`Storage replay benchmark failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildSyntheticEventLog(dataDir, turns) {
  ensureDir(dataDir);
  const sessionId = 'bench-session-1';
  const started = Date.now() - turns * 1000;
  const session = {
    id: sessionId,
    provider: 'openai',
    startTime: started,
    lastActivity: started,
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    agents: {
      codex: {
        name: 'Codex',
        requestCount: 0,
        totalTokens: 0,
        totalCost: 0,
      },
    },
    turnBreakdowns: [],
    model: 'gpt-4o',
    tenant: 'bench',
    project: 'bench',
    user: 'ci',
  };

  const events = [];
  for (let i = 0; i < turns; i++) {
    const ts = started + i * 1000;
    const input = 1000 + (i % 100);
    const output = 200 + (i % 20);
    const entry = {
      id: `bench-capture-${i}`,
      sessionId,
      timestamp: ts,
      provider: 'openai',
      model: 'gpt-4o',
      agent: { id: 'codex', name: 'Codex' },
      tenant: 'bench',
      project: 'bench',
      user: 'ci',
      isStreaming: false,
      breakdown: {
        system_prompts: { tokens: 100, percentage: 10 },
        tool_definitions: { tokens: 150, percentage: 15 },
        tool_calls: { tokens: 100, percentage: 10 },
        tool_results: { tokens: 200, percentage: 20 },
        assistant_text: { tokens: 150, percentage: 15 },
        user_text: { tokens: 150, percentage: 15 },
        thinking_blocks: { tokens: 100, percentage: 10 },
        media: { tokens: 50, percentage: 5 },
        total_tokens: 1000,
        model: 'gpt-4o',
        response_tokens: { input, output, cacheRead: 0 },
      },
      request: { method: 'POST', path: '/v1/chat/completions' },
      response: { statusCode: 200 },
    };

    session.requestCount += 1;
    session.lastActivity = ts;
    session.totalInputTokens += input;
    session.totalOutputTokens += output;
    session.agents.codex.requestCount += 1;
    session.agents.codex.totalTokens += 1000;
    session.turnBreakdowns.push({
      captureId: entry.id,
      timestamp: ts,
      breakdown: {
        system_prompts: 100,
        tool_definitions: 150,
        tool_calls: 100,
        tool_results: 200,
        assistant_text: 150,
        user_text: 150,
        thinking_blocks: 100,
        media: 50,
        total: 1000,
      },
      diff: {},
      model: 'gpt-4o',
      agent: { id: 'codex', name: 'Codex' },
    });

    events.push({
      type: 'capture_added',
      timestamp: ts,
      entry,
      session: { ...session },
    });
  }

  const eventFile = path.join(dataDir, 'events.ndjson');
  fs.writeFileSync(eventFile, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
