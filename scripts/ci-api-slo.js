#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');

const DASHBOARD_PORT = Number(process.env.CI_SLO_DASHBOARD_PORT || 6085);
const PROXY_PORT = Number(process.env.CI_SLO_PROXY_PORT || 6086);
const BASE = `http://127.0.0.1:${DASHBOARD_PORT}`;
const ARTIFACT_DIR = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'api-slo.json');
const P95_SESSIONS_MS = Number(process.env.CI_API_SLO_P95_SESSIONS_MS || 250);
const P95_REPORT_MS = Number(process.env.CI_API_SLO_P95_REPORT_MS || 500);

let server = null;

async function main() {
  try {
    await startServer();
    await waitForHealthy();
    await seedTraffic(40);

    const sessionsLatency = await benchmark('/api/sessions?limit=25&offset=0&view=lite', 25);
    const reportLatency = await benchmark('/api/reports/summary?days=7', 15);
    const p95Sessions = percentile(sessionsLatency, 95);
    const p95Report = percentile(reportLatency, 95);

    const out = {
      checkedAt: new Date().toISOString(),
      thresholds: {
        p95SessionsMs: P95_SESSIONS_MS,
        p95ReportMs: P95_REPORT_MS,
      },
      timings: {
        sessions: sessionsLatency,
        report: reportLatency,
      },
      p95: {
        sessions: p95Sessions,
        report: p95Report,
      },
      pass: p95Sessions <= P95_SESSIONS_MS && p95Report <= P95_REPORT_MS,
    };

    ensureDir(ARTIFACT_DIR);
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify(out, null, 2));
    if (!out.pass) {
      throw new Error(`SLO regression: p95 sessions=${p95Sessions}ms report=${p95Report}ms`);
    }
    console.log(`API SLO OK (p95 sessions=${p95Sessions}ms, report=${p95Report}ms)`);
  } catch (err) {
    console.error(`API SLO check failed: ${err.message}`);
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
    CONTEXT_REVIEW_DISABLE_PROXY: '1',
    CONTEXT_REVIEW_DISABLE_PERSISTENCE: '1',
    CONTEXT_REVIEW_DISABLE_BACKGROUND_ANALYSIS: '1',
    CONTEXT_REVIEW_DATA_DIR: path.join(os.tmpdir(), `context-review-ci-slo-${process.pid}`),
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
  throw new Error('server did not become ready in time');
}

async function seedTraffic(count) {
  for (let i = 0; i < count; i++) {
    const req = {
      provider: 'openai',
      request: {
        headers: {
          'user-agent': i % 2 === 0 ? 'codex/1.0' : 'aider/0.50',
          'x-context-review-project': `slo-${i % 8}`,
          'x-context-review-user': `user-${i % 4}`,
        },
        body: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: `SLO seed ${i}` }],
        },
        response: {
          usage: {
            prompt_tokens: 300 + (i % 50),
            completion_tokens: 80 + (i % 20),
          },
        },
      },
    };
    await post('/api/simulate', req);
  }
}

async function benchmark(pathname, runs) {
  const timings = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${BASE}${pathname}`);
    const body = await res.text();
    if (!res.ok) throw new Error(`benchmark call failed: ${res.status} ${body}`);
    const t1 = process.hrtime.bigint();
    timings.push(Number(t1 - t0) / 1_000_000);
  }
  return timings;
}

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${text}`);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[idx] * 1000) / 1000;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
