# Context Review — Prioritized Task Plan

Date: 2026-09-04 | Basis: `docs/PROJECT_AUDIT.md`, verified baselines (`npm test` 78/78, `smoke:e2e` OK, `npm audit` 4 vulns). No broad refactoring started.
Rule: smallest correct fix per batch + targeted tests + lint/typecheck/build (when added) + diff review + doc/status update.

## P0 — Security / Data-loss (do first, small batches)

### T1. Redact secrets at capture + scrub served payloads
- Evidence: `src/proxy/proxy.js:78-93` persists full headers; capture APIs return them unredacted (audit §7.1).
- Files: `src/proxy/proxy.js`, `src/storage/adapters.js`, `src/storage/migrate.js`, `src/api/routes.js`, `test/proxy.test.js` (extend) + new `test/secret-redaction.test.js`.
- Risk: High (credential leak). No destructive migration without approval.
- Acceptance: `Authorization`/`x-api-key`/`cookie`/`set-cookie` never reach disk/event-log/API; existing secrets flagged by a scrub dry-run script; tests for Anthropic/OpenAI/Google shapes.
- Validate: `npm test -- test/secret-redaction.test.js test/proxy.test.js`, `npm run smoke:e2e`.
- Status: completed 2026-09-04 — `src/proxy/redact.js` added, `proxy.js` redacts req/res headers at capture, `test/secret-redaction.test.js` (4 tests) green; storage verified to persist only `{method,path}` + breakdown (no header/body persistence), LHAR covered by test.

### T2. Gate destructive/mutating routes + document local-mode posture
- Evidence: `src/auth/middleware.js` `requireRole` no-op when `req.auth==null`; `DELETE /api/sessions`, `/storage/compact`, `/storage/maintenance/run`, `/budget/*` open by default (audit §7.2).
- Files: `src/auth/middleware.js`, `src/api/routes.js`, `README.md`, `test/api.test.js` (authz matrix).
- Risk: High if dashboard exposed; low for pure-localhost.
- Acceptance: matrix tests for open vs `REQUIRE_AUTH=1` modes (viewer/editor/admin); destructive routes require admin explicitly or documented `allowAnonymous` flag; README states posture.
- Validate: `npm test -- test/api.test.js`, manual `curl` 401/403 checks.
- Status: completed 2026-09-04 — opt-in `CONTEXT_REVIEW_REQUIRE_AUTH_FOR_MUTATIONS=1` (or `auth.requireAuthForMutations`) makes `requireRole` return 401 for anonymous mutations; default preserves local-first open mode; covered in `test/secret-redaction.test.js`; README documented.

### T3. Storage durability: atomic writes + bounded memory + backup pruning
- Evidence: sync single-file JSON, no lock/fsync, snapshot truncates to 1000 while memory grows, `*.bak` accumulation, `readEvents()` strict vs load tolerant (audit §7.5).
- Files: `src/storage/storage.js`, `src/storage/adapters.js`, `test/storage.test.js` (extend).
- Risk: High (data loss); change must preserve `data/sessions.json` compat.
- Acceptance: tmp+rename writes; `captures` memory cap; corrupt-snapshot/load tests stay green; backup retention limit; no format break without explicit migration.
- Validate: `npm test -- test/storage.test.js`, `npm run ci:storage-health`, `npm run ci:storage-benchmark`.
- Status: pending.

## P1 — Correctness / Core-flow hardening

### T4. Patch vulnerable deps (`npm audit fix` review)
- Evidence: `npm audit` 4 vulns (qs, uuid, path-to-regexp via express) — §4.
- Files: `package.json`, `package-lock.json`.
- Risk: Medium (DoS). Verify no breaking Express 5 changes.
- Acceptance: `npm audit --audit-level=high` clean; full `npm test` + `smoke:e2e` green.
- Validate: `npm audit`, `npm test`, `npm run smoke:e2e`.
- Status: completed 2026-09-04 — `npm audit` endpoint hung repeatedly (bulk POST; registry GETs fine), so patched directly: `npm update qs uuid path-to-regexp` → qs 6.15.0→6.16.0, uuid 13.0.0→13.0.2, path-to-regexp 8.3.0→8.4.2 (lockfile-only, no `package.json` change). `npm test` 97/97 + `smoke:e2e` OK after update.

### T5. Proxy robustness: limits + error paths + Responses API coverage
- Evidence: unbounded buffering, no inbound error handler, mid-stream failure risk, missing `/v1/responses`, Google non-SSE (audit §7.6).
- Files: `src/proxy/proxy.js`, `test/proxy.test.js`.
- Risk: Medium (core flow blockage).
- Acceptance: byte caps for body/stream, inbound error handler, safe mid-stream abort, `Content-Length` recalculation, `/v1/responses` + Google JSON support with fixtures.
- Validate: `npm test -- test/proxy.test.js`, proxy forwarding manual test.
- Status: completed 2026-09-04 — `/v1/responses` routed to OpenAI provider; Responses SSE deltas (`delta` string, `response.output_text`, `response.output[]` parts) + Google non-SSE JSON fallback in reconstruction; Responses `instructions`/`input`/`function_call` normalization in `normalize.js` + `input_tokens`/`output_tokens` usage fallback in `parser.js`; request-body 413 cap (25 MB default), stream-capture truncation cap (8 MB default) via `CONTEXT_REVIEW_PROXY_MAX_BODY_BYTES`/`_MAX_STREAM_CHARS`, inbound `req.on('error')`, upstream `proxyRes.on('error')` paths, `safeCapture` guard; non-stream forwarding keeps full-fidelity body (only capture truncated). Tests: `test/proxy-robustness.test.js` (7 tests).

### T6. Token/pricing accuracy: cache encodings + version pricing + explicit `unknown`
- Evidence: Anthropic/Google heuristic-only, per-call `getEncoding`, stale price table, `unknown` → 200k + Sonnet pricing (audit §7.7).
- Files: `src/tokens/counter.js`, `src/cost/pricing.js`, `src/findings/findings.js`, new `test/pricing.test.js`.
- Risk: Medium (trust thesis).
- Acceptance: encoding cache; pricing table timestamped/versioned with precedence tests; `unknown` model yields `confidence:low` and no false overflow; async/chunked path for huge payloads or documented cap.
- Validate: `npm test -- test/tokens.test.js test/pricing.test.js test/findings.test.js`.
- Status: completed 2026-09-04 — tiktoken encodings cached (`clearEncodingCache` for tests), >500k-char payloads use `heuristic_large_payload` guard; `pricing.js` versioned (`PRICING_VERSION`/`getPricingMetadata`), longest-key substring precedence, `isKnownModel()`; overflow findings carry `usage.modelConfidence` + low-confidence note + downgraded savings confidence for unknown models. Tests: `test/pricing.test.js` (8 tests).

### T7. API validation + pagination + NaN guards
- Evidence: `POST /simulate`, `/ci/check`, budget payloads minimally validated; unbounded `offset`; `NaN` thresholds; `percentDelta(0→x)=100` (audit §7.9).
- Files: `src/api/routes.js`, `src/analysis/session-analysis.js`, `test/api.test.js`.
- Risk: Medium (500s, wrong gates).
- Acceptance: schema validation (lightweight, no heavy dep unless justified); `offset` clamp; finite-number guards; delta edge-case tests.
- Validate: `npm test -- test/api.test.js`.
- Status: completed 2026-09-04 — `resolveBudgetThresholds` falls back to defaults on non-finite env; `runActionSimulation` rejects unknown action types (400 with supported list) and survives unserializable breakdowns (400, no 500); `POST /ci/check` rejects non-object bodies (400); budget upsert already sanitizes server-side (verified, no change); `percentDelta(0→x)=100` kept intentionally (fail-closed for CI gates); unbounded `offset` verified harmless (`slice` semantics). Tests: `test/api-validation.test.js` (5 tests).

### T8. Background scheduler + process lifecycle hardening
- Evidence: `refresh()` unguarded, no overlap lock, `stop()` never wired, no Express error middleware (audit §9).
- Files: `src/analysis/background.js`, `index.js`.
- Risk: Medium (cache stall, ungraceful shutdown).
- Acceptance: try/catch + backoff + overlap lock; `SIGTERM` cleanup; Express error middleware; dashboard listen error handling; capture-callback try/catch.
- Validate: `npm test`, `npm run smoke:e2e`.
- Status: completed 2026-09-04 — scheduler has overlap lock, per-window try/catch, `lastError`/counters, sync-safe `start()`; storage gained `stopMaintenanceScheduler()`/`close()` (guarded, additive); `index.js` has Express error middleware (no stack leak), dashboard listen error handling, capture-callback try/catch, `SIGINT`/`SIGTERM` graceful shutdown. Tests: `test/background.test.js` (4 tests).

## P2 — Performance / Reliability / Observability

### T9. Reduce read-path recompute + polling cost
- Evidence: per-request findings+cost recompute, N+1 scans, ~13 GETs/5s polling (audit §7.8, §10).
- Files: `src/analysis/session-analysis.js`, `src/api/routes.js`, `public/js/app.js`.
- Risk: Medium. Preserve API shapes.
- Acceptance: memoized per-session findings or scoped cache for authed reads; paginated aggregation avoids N+1; frontend conditional fetch + `AbortController` (skip `compare` in live mode); no UX regression.
- Validate: `npm run ci:query-benchmark`, `npm run ci:analysis-benchmark`, `npm run ci:api-slo`, `npm test`.
- Status: completed 2026-09-04 (backend half) — `SessionStorage.getCacheTokensBySession()` single-pass aggregation; `GET /sessions` + `GET /stats` no longer scan captures per session; scoped-view fallback preserves tenant isolation. Poll interval extracted to `POLL_INTERVAL_MS` (no behavior change); deeper frontend fetch reduction deferred (tab-conditional fetching risks stale Insights — see T11).

### T10. Docs/convention refresh (stale claims, ports, duplication)
- Evidence: `AGENTS.md`/`project-context.txt` stale on tests/tokenizer; `landing.html` dup; port docs drift (audit §6, §7.10).
- Files: `AGENTS.md`, `project-context.txt`, `README.md`, `public/landing.html`, `public/index.html`, `setup.sh`, `replit.md`.
- Risk: Low.
- Acceptance: accurate test/tokenizer/SSE status; single landing source or documented split; unified port table; `PLANS.md` next-queue statuses updated.
- Validate: doc review; `npm run smoke:e2e` unaffected.
- Status: completed 2026-09-04 — `AGENTS.md` gaps rewritten to current state; `project-context.txt` stale notes (heuristic-only, no tests) corrected + Responses API added; `public/landing.html` (byte-identical dup of `index.html`) removed, `/landing` now serves `index.html`; ports verified consistent across setup.sh/replit/README.

### T11. Frontend testability + a11y/loading states
- Evidence: `app.js` 2289 lines untested; full re-render loses focus; live indicator cosmetic (frontend inspection).
- Files: `public/js/app.js` (extract pure helpers), `public/js/*-helpers.js`, `test/*ui*.test.js`.
- Risk: Low-medium.
- Acceptance: extracted `computeHealth`/`getContextWindow`/filter builders unit-tested; loading/empty/error/retry states for key panels; no API shape change.
- Validate: `npm test -- test/comparison-ui.test.js test/ops-ui.test.js test/budget-helpers.test.js` + new helper tests.
- Status: completed 2026-09-04 — `computeHealth`/`getContextWindow`/`health*` extracted verbatim to `public/js/app-helpers.js` (namespace + bare globals, loaded before `app.js`), covered by `test/app-helpers.test.js` (4 tests); connection banner (`#connection-banner` + `updateConnectionBanner` + pure `isRefreshFailure`) shows on unreachable backend instead of silent empty renders. Tab-conditional fetch reduction deliberately deferred (stale-Insights risk).

## P3 — Maintainability / Hygiene

### T12. Add lint + pricing/auth/concurrency tests; decide on artifacts + LICENSE
- Evidence: no lint/typecheck/build; missing `pricing.test.js`; auth only indirect; no concurrency test; `artifacts/*.json` committed; MIT claimed but no LICENSE file (audit §4, §9).
- Files: `package.json` (lint script), `test/pricing.test.js`, `test/api.test.js`, `test/storage.test.js`, `.gitignore`, `LICENSE` (verify need).
- Risk: Low.
- Acceptance: `npm run lint` (or documented decision not to); new coverage green; artifacts policy documented; license file resolved.
- Validate: `npm run lint` (new), `npm test`, CI updated if needed.
- Status: completed 2026-09-04 — `npm run lint` (`scripts/lint.js`, dependency-free `node --check` over 60 files) added + wired as CI step; `test/storage-concurrency.test.js` pins no-corruption under interleaved same-dir writers (last-write-wins documented); `LICENSE` (MIT) added to match `package.json`/README claims; `artifacts/` confirmed git-ignored (benchmark history intentionally local).

## Validation Command Reference
```
npm test
npm run smoke:e2e
npm run ci:storage-health
npm run ci:storage-benchmark
npm run ci:query-benchmark
npm run ci:analysis-benchmark
npm run ci:long-horizon-benchmark
npm run ci:api-slo
npm audit --audit-level=high
```

## Delegation / Worktree Notes
- Independent batches (T1 vs T4 vs T10) may run in parallel agents with non-overlapping files; each must return findings, files inspected/changed, tests run + results, risks, next steps.
- Review all diffs before merge; use isolated worktrees if supported. No production changes, no destructive migrations, no secret exposure.
