# Context Review — Project Audit

Date: 2026-09-04 | Branch: `main` @ `b05827e` | Auditor: principal AI engineer (read-only discovery + verified baselines)
Scope: full repo excluding `node_modules/`, `data/sessions.json` payload (sampled), `artifacts/` (metadata only).

## 1. Product Purpose

Context Review is a **local-first LLM context intelligence proxy + dashboard**. It sits between coding tools (Claude Code, Codex, Aider, Copilot, Cursor, Gemini CLI) and upstream LLM APIs, capturing each request/response, parsing it into **8 context categories** (system prompts, tool definitions, tool calls, tool results, assistant text, user text, thinking blocks, media), then visualizing composition, diffs, findings, trends, cost, and health.

Durable value proposition (per `PLANS.md`): answer with evidence — what filled the context, what drove cost, what is safe to remove/compact, how much it saves, whether waste recurs across sessions/teams.

Current product shape (must preserve):
- One Node process: dashboard `:5000` + proxy `:8080` (`index.js`).
- Zero-code-change proxying via `*_BASE_URL` env override.
- Local persistence (`data/sessions.json`, optional `data/events.ndjson`), no external DB.
- Dashboard SPA (`public/`) + REST API (`src/api/routes.js`) + team/CI endpoints.

## 2. Architecture

```
Tool (Claude Code etc)
  -> Proxy :8080 (src/proxy/proxy.js: detectProvider, forward, SSE reconstruct)
  -> Upstream LLM (Anthropic /v1/messages, OpenAI /v1/chat/completions, Google /v1beta/models/*)
  -> onCapture: parseRequest (src/parser/) -> storage.addCapture (src/storage/)
  -> Dashboard :5000 (public/js/app.js polling -> src/api/routes.js -> src/analysis/, src/findings/, src/cost/)
```

Backend modules (15 files inspected 2026-09-04):

| Module | Role |
|---|---|
| `index.js` | Boots Express dashboard + proxy, wires `SessionStorage`, `BackgroundAnalysisScheduler`, API router |
| `src/proxy/proxy.js` | Provider match, `https.request` forward, streaming passthrough, `reconstructAnthropicStream` / `reconstructOpenAIStream`, capture assembly |
| `src/parser/parser.js` | `parseRequest` → 8-category `breakdown` + `total_tokens` + `response_tokens` via `countTokens` |
| `src/parser/normalize.js` | Versioned (`1.0.0`) canonical schema `{model, systemPrompts[], toolDefinitions[], messages[]}`, `validateNormalizedCapture`, compat guards |
| `src/tokens/counter.js` | `js-tiktoken` exact for OpenAI families (`o200k_base`/`cl100k_base`), else `ceil(chars/3.5)` heuristic |
| `src/storage/storage.js` | `SessionStorage`: 30-min session windowing by provider+tenant/project/user/agent, diffs, budgets, LHAR export |
| `src/storage/adapters.js` | `FlatFileStorageAdapter` vs `EventLogStorageAdapter` (snapshot + `events.ndjson` replay/compact/recover) |
| `src/storage/migrate.js` | One-shot `migrateSnapshotToEventLog` with backup + ID-set verify |
| `src/findings/findings.js` | `generateFindings`: overflow, unused tools, HTML, role confusion, growth, large results, compaction, media |
| `src/cost/pricing.js` | Static `$ / 1M` table + `calculateCost`, `getContextWindow`, `findPricing` |
| `src/auth/middleware.js` | Optional API-key map + HS256 JWT, `requireRole(viewer<editor<admin)`, tenant/project scope |
| `src/api/routes.js` (~948 lines) | ~30 endpoints: sessions/captures/composition/timeline/diffs/findings/trends, reports/compare/snapshot, CI summary/check, simulate, storage/budget/ops/latency |
| `src/analysis/session-analysis.js` | Pure analytics: `filterSessions`, trends, reports summary, CI summary/check, cross-session compare, budgets |
| `src/analysis/background.js` | 15s scheduler pre-building report/CI caches (`daysList:[7]`) |
| `src/analysis/benchmark-baselines.js` | Benchmark history summarize + `p95*(1+headroom)` threshold recommendation |

Frontend (`public/js/app.js` 2289 lines + 4 helpers, `style.css` 1632 lines):
- Routes: `/` landing (`index.html`, duplicated as `landing.html`), `/app` dashboard (`app.html`).
- **Polling only** — `setInterval(refresh, 5000)` gated on `visibilityState` + `isRefreshing`; ~6 global + ~7 per-session GETs per tick; no WebSocket/SSE/EventSource (`app.js:2277-2289`).
- Full `innerHTML` re-render each tick; `escapeHtml` is sole XSS barrier; canvas timeline, treemap, diff bars, findings with `POST /simulate` actions, workflow insights (trends/compare drill-down via `cf_*` URL params), budget guardrails (server + `localStorage` fallback), ops panel with artifact downloads.

## 3. Core Flows

1. **Capture**: tool → proxy path match → buffer body → detect streaming → forward with rewritten host → buffer/accumulate response → `parseStreamedResponse` → `onCapture({provider, request, response, timing})`.
2. **Parse**: `normalizeCapture` → compat check → per-item `countTokens` → 8-category totals + method/confidence → `extractResponseTokens` (provider usage metadata when present).
3. **Store**: `resolveSession` (identity headers `x-context-review-project/user`, agent fingerprint) → append capture → `computeContextDiff` vs prior turn → `saveToDisk` (snapshot slice -1000) + `appendEvent` (event mode).
4. **Analyze**: on read — `generateFindings(lastCapture)`, `calculateCost`, trends/forecast, reports/compare, CI summary/check, budgets.
5. **Simulate**: `POST /api/simulate {sessionId, captureId, actions[]}` (`remove_tools`, `trim_tool_results`, `compact_history`, `shorten_system_prompt`) → before/after token+cost delta.
6. **Team/CI**: `GET /api/sessions?project&user&agent&provider&model&from&to`, `GET /api/ci/summary?days=`, `POST /api/ci/check`, `GET /api/reports/*`, `POST /api/analysis/refresh`, snapshot export (JSON/MD), LHAR export, storage/ops/budget endpoints.
7. **Storage ops**: `migrate:event-log`, `compact:event-log`, integrity auto-recovery on boot (backup + truncate to last valid event), `/api/storage/status`, `/api/health/storage`, `/api/ops/*`, `ops:check/repair/recovery-drill` scripts.

## 4. Build / Run / Test Commands (verified)

| Command | Result 2026-09-04 |
|---|---|
| `node --version` / `npm --version` | `v22.23.2` / `10.9.8` (repo requires `>=18`) |
| `npm install` / `npm ls --depth=0` | OK — `express@5.2.1`, `js-tiktoken@1.0.21`, `uuid@13.0.0` only |
| `npm test` (`node --test`) | **78 pass / 0 fail** (~22.6s) — 15 test files, fixtures for 3 providers |
| `npm run smoke:e2e` | **SMOKE OK** — boot 6065, simulate ingest, refresh, CI summary/check, storage health |
| `npm audit --audit-level=high` | **4 vulns (1 high, 2 moderate, 1 low)**: `qs` DoS chain via express, `uuid` bounds check, `path-to-regexp` — `npm audit fix` not yet run |
| Lint / typecheck / build | **None configured** — no eslint, tsc, or build script; CI (`ci-smoke.yml`, Node 20) runs tests + 6 benchmark gates only |

CI gates: `ci:storage-health`, `ci:storage-benchmark`, `ci:query-benchmark`, `ci:analysis-benchmark`, `ci:long-horizon-benchmark`, `ci:api-slo` — all produce `artifacts/*.json`.

## 5. Environment-Variable Categories (names only, no values read)

- **Ports/hosts**: `DASHBOARD_PORT`, `PORT`, `DASHBOARD_HOST`, `PROXY_PORT`, `PROXY_HOST`, `PROXY_ADVERTISE_HOST`
- **Feature toggles**: `CONTEXT_REVIEW_DISABLE_PROXY`, `CONTEXT_REVIEW_DISABLE_BACKGROUND_ANALYSIS`
- **Storage**: `CONTEXT_REVIEW_STORAGE_ADAPTER` (`flat`|`event`), `CONTEXT_REVIEW_EVENT_LOG`, `CONTEXT_REVIEW_DATA_DIR`, `CONTEXT_REVIEW_BENCHMARK_ARTIFACT_DIR`, retention `CONTEXT_REVIEW_EVENT_RETENTION_MAX_EVENTS`, `CONTEXT_REVIEW_EVENT_RETENTION_MAX_AGE_DAYS`, `CONTEXT_REVIEW_EVENT_COMPACT_ON_START`, `CONTEXT_REVIEW_EVENT_COMPACT_INTERVAL_MINUTES`, `CONTEXT_REVIEW_EVENT_COMPACT_MIN_IDLE_MS`, `CONTEXT_REVIEW_MAINTENANCE_HISTORY_LIMIT`
- **Auth**: `CONTEXT_REVIEW_REQUIRE_AUTH`, `CONTEXT_REVIEW_API_KEYS` (JSON map), `CONTEXT_REVIEW_JWT_SECRET`
- **Budgets**: `CONTEXT_REVIEW_BUDGET_MAX_INPUT_TOKENS_PER_REQUEST`, `CONTEXT_REVIEW_BUDGET_MAX_COST_PER_REQUEST`, `CONTEXT_REVIEW_BUDGET_MAX_TOTAL_COST_PER_PROJECT`, `CONTEXT_REVIEW_BUDGET_MAX_SESSION_COST`
- **Benchmark thresholds**: `CI_STORAGE_BENCH_MAX_REPLAY_MS` (2000), `CI_QUERY_BENCH_MAX_FILTER_MS`, `CI_QUERY_BENCH_MAX_REPORT_MS`, `CI_ANALYSIS_BENCH_MAX_*`, `CI_LONG_HORIZON_BENCH_MAX_*`
- No `.env` / `.env.example` in repo (verified — `.gitignore` lists `.env`); all config via process env.

## 6. Baseline Health

**Working**: proxy capture + SSE reconstruction (with regression tests), normalized schema + golden fixtures, findings with savings, simulation deltas, trends/forecast/alerts, cross-session compare + drill-down deep-links, auth/RBAC + tenant scoping, event-log adapter + migration/compact/recovery, background cache, 6 CI benchmark gates + ops scripts, budget guardrails save/export/import.

**Contradicts stale docs**: `AGENTS.md` ("no automated test suite", "no tokenizer") and `project-context.txt` ("no tests") are outdated — 78 tests + `js-tiktoken` abstraction exist. SSE/concurrency/no-push gaps remain partially true.

## 7. Broken Items / Defects (evidence-backed)

1. **Secrets persisted + served** — `src/proxy/proxy.js:78-93` clones full headers (`Authorization`, `x-api-key`, cookies) into `captureData`, written to `data/sessions.json` / `data/events.ndjson` + backups, returned by `GET /api/sessions/:id/capture*` with no redaction.
2. **Mutating APIs open by default** — `requireAuth=0` default; `requireRole` no-ops when `req.auth==null` (`src/auth/middleware.js`), so `DELETE /api/sessions`, `POST /simulate`, `/storage/compact`, `/storage/maintenance/run`, `/budget/*` are unauthenticated in default local mode.
3. **No lint/typecheck/build** — drift risk; `app.js` (2289 lines) and `routes.js` (~948 lines) have zero dedicated static checks.
4. **Known vulnerable deps** — `npm audit` 4 vulns (express→qs/path-to-regexp, uuid) unpatched.
5. **Storage durability gaps** — sync single-file JSON + `appendFileSync` per capture, no locking/`fsync`; `saveToDisk` truncates snapshot to 1000 captures while memory grows unbounded; corrupt `sessions.json` load returns empty (silent loss beyond console); `*.bak`/`*.corrupt.*.bak` accumulate without pruning; `readEvents()` (compact path) throws on corrupt line where load path recovers.
6. **Proxy robustness** — unbounded body/stream buffering, no inbound `req.on('error')`, mid-stream upstream failure can cause `ERR_STREAM_WRITE_AFTER_END`, `Content-Length` forwarded verbatim, SSE malformed lines silently dropped, no `/v1/responses` (OpenAI Responses API) or Google non-SSE JSON handling.
7. **Accuracy risks** — Anthropic/Google always heuristic (`chars/3.5`); `tiktoken` encodings re-created per call (no cache, blocks loop on 50 MB payloads); `pricing.js` stale (no gpt-5/claude-4.x/gemini-3, no date metadata, fragile substring match); `unknown` model → 200k window + Sonnet pricing → misleading overflow/cost.
8. **Perf** — per-request full recompute of findings+costs (cache bypassed when authed), `GET /sessions` N+1 capture scans, 15s full-report background rebuild with no overlap lock or error guard, polling fan-out (~13 GETs/5s) with no abort/dedupe/ETag.
9. **Validation gaps** — `POST /simulate`, `/ci/check`, budget payloads minimally validated; `offset` unbounded; `resolveBudgetThresholds` `NaN` propagation; `percentDelta(0→x)=100` masks jumps.
10. **Frontend fragility** — full `innerHTML` re-render loses focus/scroll; `app.js` core logic untested (only `*-helpers.js` covered); client `getContextWindow()` hardcodes windows, can diverge from `pricing.js`; `landing.html` duplicates `index.html`; port docs drift (`setup.sh`/`replit.md`/landing/`AGENTS.md`).

## 8. Risks

| # | Risk | Impact |
|---|---|---|
| 1 | API-key leakage via persisted/served captures | High — credential exposure on shared machines/dashboards |
| 2 | Unauthenticated destructive ops (delete/compact/maintenance) | High in team-exposed deployments |
| 3 | Data loss on concurrent writes / corrupt snapshot | High — single-file, no atomicity |
| 4 | Misleading cost/overflow from heuristic counts + stale pricing | Medium — erodes trust thesis (Phase 1) |
| 5 | Proxy crash/hang under large streams or upstream failure | Medium — blocks core capture flow |
| 6 | Dashboard perf collapse with many sessions/tabs | Medium — polling + recompute |
| 7 | Unpatched transitive vulns (qs/uuid/path-to-regexp) | Medium — DoS surface via Express |
| 8 | No static checks; large untested UI core | Low-medium — regression risk |

## 9. Technical Debt

- `AGENTS.md` + `project-context.txt` stale re: tests/tokenizer; `PLANS.md` "Immediate Next Build Tasks" partially done but not marked (drill-down, recovery drill, budget alerts shipped; long-horizon calibration + `2.x` migration vectors remain).
- Missing `pricing.test.js`; `auth/middleware.js`, `session-analysis.js`, `background.js` only indirectly tested; proxy forwarding/headers/timeouts untested; no concurrency test.
- `index.js`: no Express error middleware, no dashboard listen error handling, no `SIGTERM` cleanup (`analysisScheduler.stop()`, maintenance timer, proxy close), capture callback without `try/catch`.
- Background cache shared across tenants (correctly bypassed when authed, but unauthed team mode leaks cross-tenant aggregates).
- Budget threshold split-brain: server storage vs `localStorage` vs report defaults (`source: default|local|storage|forbidden`).
- Artifacts committed to `artifacts/` (benchmark JSONs) — should be git-ignored or documented as intentional history for calibration.
- No Docker/deployment manifests, no database migrations (by design — local-first), no `.env.example`, no LICENSE file despite `package.json: MIT` + README claim (verify).
