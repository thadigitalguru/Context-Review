const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { URL } = require('url');

process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';
delete require.cache[require.resolve('../src/storage/storage')];
delete require.cache[require.resolve('../src/parser/parser')];

const { SessionStorage } = require('../src/storage/storage');
const { parseRequest } = require('../src/parser/parser');
const { createAPIRouter } = require('../src/api/routes');

function createCapture() {
  return {
    provider: 'openai',
    timestamp: 1000,
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'codex/1.0' },
      body: {
        model: 'gpt-4o',
        tools: [
          {
            type: 'function',
            function: {
              name: 'unused_tool',
              description: 'Never used',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        messages: [
          { role: 'system', content: 'You are Codex.' },
          { role: 'user', content: 'Inspect this output.' },
          { role: 'tool', tool_call_id: 'call-1', content: '<div>Large HTML payload</div>' },
        ],
      },
    },
    response: {
      statusCode: 200,
      headers: {},
      body: {
        model: 'gpt-4o',
        usage: {
          prompt_tokens: 500,
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 50 },
        },
      },
    },
    isStreaming: false,
  };
}

function createCaptureVariant({ timestamp, userText, toolResult, headers }) {
  const base = createCapture();
  return {
    ...base,
    timestamp,
    request: {
      ...base.request,
      headers: {
        ...base.request.headers,
        ...(headers || {}),
      },
      body: {
        ...base.request.body,
        messages: [
          { role: 'system', content: 'You are Codex.' },
          { role: 'user', content: userText },
          { role: 'tool', tool_call_id: 'call-1', content: toolResult },
        ],
      },
    },
    response: {
      ...base.response,
      body: {
        ...base.response.body,
        usage: {
          prompt_tokens: Math.max(500, Math.round(userText.length / 2)),
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 50 },
        },
      },
    },
  };
}

function createApp(storage, options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAPIRouter(storage, options));
  return app;
}

function requestApp(app, { method = 'GET', url, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url, 'http://localhost');
    const query = Object.fromEntries(parsed.searchParams.entries());
    const req = {
      method,
      url: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body,
      _body: body !== undefined,
      query,
      params: {},
      on(event, handler) {
        if (event === 'data') return this;
        if (event === 'end') process.nextTick(handler);
        return this;
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return this.headers[name.toLowerCase()];
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.setHeader('content-type', 'application/json');
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
      },
      end(payload) {
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
      },
    };

    app.handle(req, res, reject);
  });
}

test('api capture detail route is scoped to the requested session and findings expose savings', async () => {
  const storage = new SessionStorage();
  const capture = createCapture();
  const breakdown = parseRequest(capture);
  const added = storage.addCapture(capture, breakdown);

  const otherCapture = {
    ...capture,
    timestamp: 5000,
    request: {
      ...capture.request,
      headers: { 'user-agent': 'aider/0.50' },
      body: {
        ...capture.request.body,
        messages: [{ role: 'user', content: 'Other session' }],
      },
    },
  };
  const otherAdded = storage.addCapture(otherCapture, parseRequest(otherCapture));

  const app = createApp(storage);

  const scopedMissing = await requestApp(app, {
    url: `/api/sessions/${otherAdded.sessionId}/capture/${added.captureId}`,
  });
  assert.equal(scopedMissing.statusCode, 404);

  const findingsRes = await requestApp(app, {
    url: `/api/sessions/${added.sessionId}/findings`,
  });
  assert.equal(findingsRes.statusCode, 200);
  const findings = findingsRes.body;
  assert.ok(findings.some((finding) => finding.estimatedSavings));
  assert.ok(findings.some((finding) => finding.source || finding.sources || finding.tools));
});

test('api simulate returns before/after deltas for recommendation actions', async () => {
  const storage = new SessionStorage();
  const capture = createCapture();
  const breakdown = parseRequest(capture);
  const added = storage.addCapture(capture, breakdown);
  const app = createApp(storage);

  const simRes = await requestApp(app, {
    method: 'POST',
    url: '/api/simulate',
    body: {
      sessionId: added.sessionId,
      captureId: added.captureId,
      actions: [
        { type: 'remove_tools', params: { names: ['unused_tool'] } },
        { type: 'trim_tool_results', params: { msgIndex: 3, maxTokens: 10 } },
      ],
    },
  });

  assert.equal(simRes.statusCode, 200);
  assert.ok(simRes.body.baseline.total_tokens > 0);
  assert.ok(simRes.body.simulated.total_tokens <= simRes.body.baseline.total_tokens);
  assert.ok(simRes.body.delta.tokens_saved >= 0);
  assert.ok(Array.isArray(simRes.body.simulated.actions));
  assert.equal(simRes.body.simulated.actions.length, 2);
});

test('api trends exposes growth, forecast, alerts, and tool usage', async () => {
  const storage = new SessionStorage();
  const c1 = createCaptureVariant({
    timestamp: 1000,
    userText: 'Short request.',
    toolResult: '<div>small html</div>',
  });
  const c2 = createCaptureVariant({
    timestamp: 2000,
    userText: `Longer request ${'A'.repeat(2400)}`,
    toolResult: `<div>${'B'.repeat(3200)}</div>`,
  });
  const c3 = createCaptureVariant({
    timestamp: 3000,
    userText: `Longest request ${'C'.repeat(4200)}`,
    toolResult: `<div>${'D'.repeat(4200)}</div>`,
  });

  const added = storage.addCapture(c1, parseRequest(c1));
  storage.addCapture(c2, parseRequest(c2));
  storage.addCapture(c3, parseRequest(c3));

  const app = createApp(storage);
  const trendsRes = await requestApp(app, { url: `/api/sessions/${added.sessionId}/trends` });

  assert.equal(trendsRes.statusCode, 200);
  assert.ok(Array.isArray(trendsRes.body.points));
  assert.ok(trendsRes.body.points.length >= 3);
  assert.ok(trendsRes.body.growth.avgDeltaTokens > 0);
  assert.ok(Object.prototype.hasOwnProperty.call(trendsRes.body.forecast, 'turnsRemaining'));
  assert.ok(Array.isArray(trendsRes.body.toolUsage));
});

test('api reports summary exposes top waste drivers and expensive sessions', async () => {
  const storage = new SessionStorage();
  const c1 = createCaptureVariant({
    timestamp: Date.now() - 1000,
    userText: `Report baseline ${'X'.repeat(1200)}`,
    toolResult: `<div>${'Y'.repeat(2800)}</div>`,
  });
  const c2 = createCaptureVariant({
    timestamp: Date.now(),
    userText: `Report follow-up ${'Z'.repeat(1600)}`,
    toolResult: `<div>${'K'.repeat(2400)}</div>`,
  });
  storage.addCapture(c1, parseRequest(c1));
  storage.addCapture(c2, parseRequest(c2));

  const app = createApp(storage);
  const summaryRes = await requestApp(app, { url: '/api/reports/summary' });

  assert.equal(summaryRes.statusCode, 200);
  assert.ok(Array.isArray(summaryRes.body.topWasteDrivers));
  assert.ok(Array.isArray(summaryRes.body.mostExpensiveSessions));
  assert.ok(summaryRes.body.sessionCount >= 1);

  const compareRes = await requestApp(app, { url: '/api/reports/compare?days=7&groupBy=project&limit=3&includeSessionIds=1&sessionIdsLimit=5' });
  assert.equal(compareRes.statusCode, 200);
  assert.equal(compareRes.body.groupBy, 'project');
  assert.ok(Array.isArray(compareRes.body.items));
  assert.ok(compareRes.body.items.length >= 1);
  assert.ok(Object.prototype.hasOwnProperty.call(compareRes.body.items[0].current, 'estimatedWasteTokens'));
  assert.ok(Object.prototype.hasOwnProperty.call(compareRes.body.items[0].delta, 'estimatedWasteTokensPct'));
  assert.ok(Array.isArray(compareRes.body.items[0].current.sessionIds));
  assert.ok(compareRes.body.items[0].current.sessionIds.length >= 1);
});

test('api sessions supports team filters by project user and agent', async () => {
  const storage = new SessionStorage();
  const alpha = createCaptureVariant({
    timestamp: Date.now() - 2000,
    userText: 'Alpha request',
    toolResult: '<div>alpha</div>',
    headers: {
      'x-context-review-project': 'alpha',
      'x-context-review-user': 'alice',
      'user-agent': 'codex/1.0',
    },
  });
  const beta = createCaptureVariant({
    timestamp: Date.now() - 1000,
    userText: 'Beta request',
    toolResult: '<div>beta</div>',
    headers: {
      'x-context-review-project': 'beta',
      'x-context-review-user': 'bob',
      'user-agent': 'aider/0.50',
    },
  });
  storage.addCapture(alpha, parseRequest(alpha));
  storage.addCapture(beta, parseRequest(beta));
  const app = createApp(storage);

  const byProject = await requestApp(app, { url: '/api/sessions?project=alpha' });
  assert.equal(byProject.statusCode, 200);
  assert.equal(byProject.body.length, 1);
  assert.equal(byProject.body[0].project, 'alpha');

  const byUser = await requestApp(app, { url: '/api/sessions?user=bob' });
  assert.equal(byUser.statusCode, 200);
  assert.equal(byUser.body.length, 1);
  assert.equal(byUser.body[0].user, 'bob');

  const byAgent = await requestApp(app, { url: '/api/sessions?agent=aider' });
  assert.equal(byAgent.statusCode, 200);
  assert.equal(byAgent.body.length, 1);
});

test('api sessions and captures support pagination with lightweight view', async () => {
  const storage = new SessionStorage();
  const t0 = Date.now() - 4000;
  const main1 = createCaptureVariant({
    timestamp: t0,
    userText: 'Main one',
    toolResult: '<div>m1</div>',
    headers: { 'x-context-review-project': 'main', 'x-context-review-user': 'owner', 'user-agent': 'codex/1.0' },
  });
  const main2 = createCaptureVariant({
    timestamp: t0 + 1000,
    userText: 'Main two',
    toolResult: '<div>m2</div>',
    headers: { 'x-context-review-project': 'main', 'x-context-review-user': 'owner', 'user-agent': 'codex/1.0' },
  });
  const main3 = createCaptureVariant({
    timestamp: t0 + 2000,
    userText: 'Main three',
    toolResult: '<div>m3</div>',
    headers: { 'x-context-review-project': 'main', 'x-context-review-user': 'owner', 'user-agent': 'codex/1.0' },
  });
  const auxA = createCaptureVariant({
    timestamp: t0 + 2500,
    userText: 'Aux A',
    toolResult: '<div>a</div>',
    headers: { 'x-context-review-project': 'aux-a', 'x-context-review-user': 'owner', 'user-agent': 'aider/0.50' },
  });
  const auxB = createCaptureVariant({
    timestamp: t0 + 3000,
    userText: 'Aux B',
    toolResult: '<div>b</div>',
    headers: { 'x-context-review-project': 'aux-b', 'x-context-review-user': 'owner', 'user-agent': 'cursor/1.0' },
  });

  const first = storage.addCapture(main1, parseRequest(main1));
  storage.addCapture(main2, parseRequest(main2));
  storage.addCapture(main3, parseRequest(main3));
  storage.addCapture(auxA, parseRequest(auxA));
  storage.addCapture(auxB, parseRequest(auxB));
  const app = createApp(storage);

  const pagedLite = await requestApp(app, { url: '/api/sessions?limit=2&offset=0&view=lite' });
  assert.equal(pagedLite.statusCode, 200);
  assert.ok(Array.isArray(pagedLite.body.items));
  assert.equal(pagedLite.body.items.length, 2);
  assert.equal(typeof pagedLite.body.page.total, 'number');
  assert.equal(pagedLite.body.page.offset, 0);
  assert.equal(pagedLite.body.page.limit, 2);
  assert.equal(pagedLite.body.items[0].turnBreakdowns, undefined);
  assert.equal(pagedLite.body.items[0].cost, undefined);

  const pagedCaptures = await requestApp(app, {
    url: `/api/sessions/${first.sessionId}/captures?limit=1&offset=0`,
  });
  assert.equal(pagedCaptures.statusCode, 200);
  assert.ok(Array.isArray(pagedCaptures.body.items));
  assert.equal(pagedCaptures.body.items.length, 1);
  assert.equal(pagedCaptures.body.page.total, 3);
  assert.equal(pagedCaptures.body.page.hasMore, true);
});

test('api ci summary/check and snapshot endpoints are machine-readable', async () => {
  const storage = new SessionStorage();
  const projectCapture = createCaptureVariant({
    timestamp: Date.now() - 500,
    userText: `CI run ${'R'.repeat(2600)}`,
    toolResult: `<div>${'S'.repeat(2600)}</div>`,
    headers: {
      'x-context-review-project': 'ci-project',
      'x-context-review-user': 'ci-bot',
    },
  });
  const added = storage.addCapture(projectCapture, parseRequest(projectCapture));
  const app = createApp(storage);

  const ciSummary = await requestApp(app, { url: '/api/ci/summary?days=7' });
  assert.equal(ciSummary.statusCode, 200);
  assert.ok(ciSummary.body.current);
  assert.ok(Object.prototype.hasOwnProperty.call(ciSummary.body.regression, 'avgInputTokensDeltaPct'));
  assert.ok(ciSummary.body._cache);

  const ciCheck = await requestApp(app, {
    method: 'POST',
    url: '/api/ci/check',
    body: { days: 7, maxInputInflationPct: 1000, maxCostInflationPct: 1000, maxUnusedToolsIncreasePct: 1000, maxToolDefinitionPct: 1000 },
  });
  assert.equal(ciCheck.statusCode, 200);
  assert.equal(typeof ciCheck.body.passed, 'boolean');
  assert.ok(Array.isArray(ciCheck.body.failures));

  const snapshotJson = await requestApp(app, { url: `/api/reports/session/${added.sessionId}/snapshot` });
  assert.equal(snapshotJson.statusCode, 200);
  assert.equal(snapshotJson.body.session.project, 'ci-project');
  assert.ok(snapshotJson.body.trends);

  const snapshotMd = await requestApp(app, { url: `/api/reports/session/${added.sessionId}/snapshot?format=md` });
  assert.equal(snapshotMd.statusCode, 200);
  assert.equal(typeof snapshotMd.body, 'string');
  assert.ok(snapshotMd.body.includes('# Context Review Snapshot'));
});

test('api summaries are cache-first with metadata when scheduler is available', async () => {
  const storage = new SessionStorage();
  const stubScheduler = {
    getReportSummaryEntry(days) {
      return {
        data: {
          generatedAt: 1,
          windowDays: days,
          sessionCount: 0,
          topWasteDrivers: [],
          mostExpensiveSessions: [],
          mostRepeatedSystemBlocks: [],
          unusedTools: [],
        },
        refreshedAt: 12345,
        cacheAgeMs: 50,
      };
    },
    getCISummaryEntry(days) {
      return {
        data: {
          generatedAt: 1,
          windowDays: days,
          current: { requestCount: 0 },
          previous: { requestCount: 0 },
          regression: { avgInputTokensDeltaPct: 0 },
        },
        refreshedAt: 23456,
        cacheAgeMs: 40,
      };
    },
    refreshDays(days) {
      this.lastRefresh = days;
    },
    lastRunAt: 34567,
  };
  const app = createApp(storage, { analysisScheduler: stubScheduler });

  const reportRes = await requestApp(app, { url: '/api/reports/summary?days=7' });
  assert.equal(reportRes.statusCode, 200);
  assert.equal(reportRes.body._cache.source, 'background_cache');
  assert.equal(reportRes.body._cache.refreshedAt, 12345);

  const ciRes = await requestApp(app, { url: '/api/ci/summary?days=7' });
  assert.equal(ciRes.statusCode, 200);
  assert.equal(ciRes.body._cache.source, 'background_cache');
  assert.equal(ciRes.body._cache.refreshedAt, 23456);

  const refreshRes = await requestApp(app, {
    method: 'POST',
    url: '/api/analysis/refresh',
    body: { days: [7, 14] },
  });
  assert.equal(refreshRes.statusCode, 200);
  assert.deepEqual(stubScheduler.lastRefresh, [7, 14]);
  assert.equal(refreshRes.body.ok, true);
});

test('api storage status and compaction endpoints expose event-log ops controls', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-review-api-compact-'));
  const storage = new SessionStorage({
    adapterMode: 'event',
    dataDir: tempDir,
    persistenceDisabled: false,
  });
  const capture = createCaptureVariant({
    timestamp: 1000,
    userText: 'Compaction API test',
    toolResult: '<div>payload</div>',
  });
  storage.addCapture(capture, parseRequest(capture));

  const app = createApp(storage);
  const statusRes = await requestApp(app, { url: '/api/storage/status' });
  assert.equal(statusRes.statusCode, 200);
  assert.equal(statusRes.body.adapterMode, 'event');
  assert.ok(statusRes.body.eventLog.eventCount >= 1);
  assert.equal(typeof statusRes.body.eventLog.telemetry.compactionsTotal, 'number');
  assert.equal(typeof statusRes.body.eventLog.telemetry.replayMs, 'number');
  assert.equal(typeof statusRes.body.benchmarks.config.storageReplayMaxMs, 'number');
  assert.ok(Object.prototype.hasOwnProperty.call(statusRes.body.benchmarks.latest, 'storageReplay'));
  assert.ok(Object.prototype.hasOwnProperty.call(statusRes.body.benchmarks.latest, 'analysisPerformance'));
  assert.ok(Object.prototype.hasOwnProperty.call(statusRes.body.benchmarks.latest, 'longHorizonPerformance'));

  const healthRes = await requestApp(app, { url: '/api/health/storage' });
  assert.equal(healthRes.statusCode, 200);
  assert.equal(healthRes.body.ok, true);
  assert.equal(healthRes.body.status, 'healthy');

  const opsRes = await requestApp(app, { url: '/api/ops/summary' });
  assert.equal(opsRes.statusCode, 200);
  assert.equal(typeof opsRes.body.generatedAt, 'number');
  assert.equal(typeof opsRes.body.health.storage, 'string');
  assert.ok(opsRes.body.storage);
  assert.ok(opsRes.body.latency);
  assert.ok(Array.isArray(opsRes.body.latency.routes));

  const latencyRes = await requestApp(app, { url: '/api/ops/latency' });
  assert.equal(latencyRes.statusCode, 200);
  assert.ok(Array.isArray(latencyRes.body.routes));

  const dryRunRes = await requestApp(app, {
    method: 'POST',
    url: '/api/storage/compact',
    body: {
      dryRun: true,
      maxEvents: 1,
      reason: 'api-test',
    },
  });
  assert.equal(dryRunRes.statusCode, 200);
  assert.equal(dryRunRes.body.dryRun, true);
  assert.equal(dryRunRes.body.compacted, false);
  assert.equal(dryRunRes.body.reason, 'api-test');

  const maintenanceRes = await requestApp(app, {
    method: 'POST',
    url: '/api/storage/maintenance/run',
    body: { dryRun: true, force: true },
  });
  assert.equal(maintenanceRes.statusCode, 200);
  assert.equal(typeof maintenanceRes.body.reason, 'string');
  assert.ok(Object.prototype.hasOwnProperty.call(maintenanceRes.body, 'compacted'));

  const statusAfterMaintenance = await requestApp(app, { url: '/api/storage/status' });
  assert.equal(statusAfterMaintenance.statusCode, 200);
  assert.ok(Array.isArray(statusAfterMaintenance.body.maintenance.history));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('api storage health returns 503 for degraded storage status', async () => {
  const fakeStorage = {
    getStorageStatus() {
      return {
        adapterMode: 'event',
        eventLog: {
          integrity: {
            degraded: true,
            reason: 'recovery_failed:test',
          },
        },
      };
    },
  };
  const app = createApp(fakeStorage);
  const health = await requestApp(app, { url: '/api/health/storage' });
  assert.equal(health.statusCode, 503);
  assert.equal(health.body.ok, false);
  assert.equal(health.body.status, 'degraded');
  assert.equal(health.body.reason, 'recovery_failed:test');
});

test('auth middleware enforces credentials, roles, and tenant scoping', async () => {
  const storage = new SessionStorage();
  const tenantACapture = createCaptureVariant({
    timestamp: 1000,
    userText: 'Tenant A request',
    toolResult: '<div>a</div>',
    headers: {
      'x-context-review-tenant': 'tenant-a',
      'x-context-review-project': 'alpha',
      'x-context-review-user': 'alice',
      'user-agent': 'codex/1.0',
    },
  });
  const tenantBCapture = createCaptureVariant({
    timestamp: 2000,
    userText: 'Tenant B request',
    toolResult: '<div>b</div>',
    headers: {
      'x-context-review-tenant': 'tenant-b',
      'x-context-review-project': 'beta',
      'x-context-review-user': 'bob',
      'user-agent': 'codex/1.0',
    },
  });
  storage.addCapture(tenantACapture, parseRequest(tenantACapture));
  storage.addCapture(tenantBCapture, parseRequest(tenantBCapture));

  const apiKeys = new Map([
    ['viewer-key', { tenant: 'tenant-a', role: 'viewer' }],
    ['editor-key', { tenant: 'tenant-a', role: 'editor' }],
    ['admin-key', { tenant: 'tenant-a', role: 'admin' }],
  ]);
  const app = createApp(storage, {
    auth: {
      requireAuth: true,
      apiKeys,
    },
  });

  const unauth = await requestApp(app, { url: '/api/sessions' });
  assert.equal(unauth.statusCode, 401);

  const viewerSessions = await requestApp(app, {
    url: '/api/sessions',
    headers: { 'x-context-review-api-key': 'viewer-key' },
  });
  assert.equal(viewerSessions.statusCode, 200);
  assert.equal(viewerSessions.body.length, 1);
  assert.equal(viewerSessions.body[0].tenant, 'tenant-a');

  const viewerWrite = await requestApp(app, {
    method: 'POST',
    url: '/api/simulate',
    headers: { 'x-context-review-api-key': 'viewer-key' },
    body: {
      provider: 'openai',
      request: {
        headers: { 'user-agent': 'codex/1.0' },
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
        response: { usage: { prompt_tokens: 20, completion_tokens: 5 } },
      },
    },
  });
  assert.equal(viewerWrite.statusCode, 403);

  const editorWrite = await requestApp(app, {
    method: 'POST',
    url: '/api/simulate',
    headers: { 'x-context-review-api-key': 'editor-key' },
    body: {
      provider: 'openai',
      request: {
        headers: {
          'user-agent': 'codex/1.0',
          'x-context-review-tenant': 'tenant-b',
          'x-context-review-project': 'alpha',
          'x-context-review-user': 'alice',
        },
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'editor write' }] },
        response: { usage: { prompt_tokens: 30, completion_tokens: 8 } },
      },
    },
  });
  assert.equal(editorWrite.statusCode, 200);

  const editorDelete = await requestApp(app, {
    method: 'DELETE',
    url: '/api/sessions',
    headers: { 'x-context-review-api-key': 'editor-key' },
  });
  assert.equal(editorDelete.statusCode, 403);

  const adminDelete = await requestApp(app, {
    method: 'DELETE',
    url: '/api/sessions',
    headers: { 'x-context-review-api-key': 'admin-key' },
  });
  assert.equal(adminDelete.statusCode, 200);
});
