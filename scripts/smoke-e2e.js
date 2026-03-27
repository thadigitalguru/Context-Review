#!/usr/bin/env node
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');

const DASHBOARD_PORT = Number(process.env.SMOKE_DASHBOARD_PORT || 6065);
const PROXY_PORT = Number(process.env.SMOKE_PROXY_PORT || 6066);
const BASE = `http://127.0.0.1:${DASHBOARD_PORT}`;

let server = null;

async function main() {
  try {
    await startServer();
    await waitForHealthy();
    await simulateTraffic();
    await refreshAnalysis();
    await validateSummaryAndCheck();
    await validateStorageHealth();
    console.log('SMOKE OK: end-to-end CI flow succeeded');
  } catch (err) {
    console.error('SMOKE FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

async function startServer() {
  const env = {
    ...process.env,
    DASHBOARD_PORT: String(DASHBOARD_PORT),
    DASHBOARD_HOST: '127.0.0.1',
    PROXY_PORT: String(PROXY_PORT),
    PROXY_HOST: '127.0.0.1',
    PROXY_ADVERTISE_HOST: '127.0.0.1',
    CONTEXT_REVIEW_DISABLE_PERSISTENCE: '1',
    CONTEXT_REVIEW_DISABLE_BACKGROUND_ANALYSIS: '0',
    CONTEXT_REVIEW_DATA_DIR: path.join(os.tmpdir(), `context-review-smoke-${process.pid}`),
  };

  server = spawn('node', ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk) => process.stdout.write(String(chunk)));
  server.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
}

async function stopServer() {
  if (!server || server.killed) return;
  server.kill('SIGTERM');
  await sleep(300);
}

async function waitForHealthy() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/stats`);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Server did not become ready in time');
}

async function simulateTraffic() {
  const turn1 = {
    provider: 'openai',
    request: {
      headers: {
        'user-agent': 'codex/1.0',
        'x-context-review-project': 'smoke-project',
        'x-context-review-user': 'ci-bot',
      },
      body: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a coding assistant.' },
          { role: 'user', content: 'Inspect a codebase and summarize architecture.' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'unused_tool',
              description: 'Unused tool for smoke test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      },
      response: {
        usage: {
          prompt_tokens: 900,
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      },
    },
  };

  const turn2 = {
    provider: 'openai',
    request: {
      headers: {
        'user-agent': 'codex/1.0',
        'x-context-review-project': 'smoke-project',
        'x-context-review-user': 'ci-bot',
      },
      body: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a coding assistant.' },
          { role: 'user', content: `Analyze this verbose tool output ${'A'.repeat(2400)}` },
          { role: 'tool', tool_call_id: 'call-1', content: `<div>${'B'.repeat(2600)}</div>` },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'unused_tool',
              description: 'Unused tool for smoke test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      },
      response: {
        usage: {
          prompt_tokens: 1600,
          completion_tokens: 160,
          prompt_tokens_details: { cached_tokens: 120 },
        },
      },
    },
  };

  await post('/api/simulate', turn1);
  await post('/api/simulate', turn2);
}

async function refreshAnalysis() {
  const refresh = await post('/api/analysis/refresh', { days: [7, 14] });
  if (!refresh.ok) {
    throw new Error(`analysis refresh failed: ${refresh.status} ${refresh.text}`);
  }
}

async function validateSummaryAndCheck() {
  const summary = await get('/api/ci/summary?days=7');
  if (!summary.ok) throw new Error(`ci summary failed: ${summary.status} ${summary.text}`);
  const summaryJson = summary.json;
  if (!summaryJson._cache || !summaryJson._cache.source) {
    throw new Error('ci summary missing cache metadata');
  }

  const check = await post('/api/ci/check', {
    days: 7,
    maxInputInflationPct: 1000,
    maxCostInflationPct: 1000,
    maxUnusedToolsIncreasePct: 1000,
    maxToolDefinitionPct: 1000,
  });
  if (!check.ok) {
    throw new Error(`ci check returned non-2xx: ${check.status} ${check.text}`);
  }
  if (!check.json || check.json.passed !== true) {
    throw new Error('ci check did not pass under permissive thresholds');
  }
}

async function validateStorageHealth() {
  const health = await get('/api/health/storage');
  if (!health.ok) {
    throw new Error(`storage health failed: ${health.status} ${health.text}`);
  }
  if (!health.json || health.json.ok !== true) {
    throw new Error('storage health returned non-healthy payload');
  }
}

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

main();
