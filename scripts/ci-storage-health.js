#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');

const DASHBOARD_PORT = Number(process.env.CI_STORAGE_DASHBOARD_PORT || 6075);
const PROXY_PORT = Number(process.env.CI_STORAGE_PROXY_PORT || 6076);
const BASE = `http://127.0.0.1:${DASHBOARD_PORT}`;
const ARTIFACT_DIR = process.env.CI_STORAGE_ARTIFACT_DIR || path.join(process.cwd(), 'artifacts');
const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'storage-status.json');

let server = null;

async function main() {
  try {
    await startServer();
    await waitForReady();
    const health = await get('/api/health/storage');
    const status = await get('/api/storage/status');

    ensureDir(ARTIFACT_DIR);
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify({
      checkedAt: new Date().toISOString(),
      health,
      status,
    }, null, 2));

    if (!health.ok || !health.json || health.json.ok !== true) {
      throw new Error(`storage health is degraded: ${health.status} ${health.text}`);
    }
    console.log(`Storage health OK. Artifact: ${ARTIFACT_FILE}`);
  } catch (err) {
    console.error(`Storage health check failed: ${err.message}`);
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
    CONTEXT_REVIEW_DISABLE_PERSISTENCE: '0',
    CONTEXT_REVIEW_DISABLE_BACKGROUND_ANALYSIS: '1',
    CONTEXT_REVIEW_STORAGE_ADAPTER: 'event',
    CONTEXT_REVIEW_DATA_DIR: path.join(os.tmpdir(), `context-review-ci-storage-${process.pid}`),
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

async function waitForReady() {
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

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main();
