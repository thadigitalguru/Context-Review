# PLANS

## Current Baseline

- Runtime: Node.js `>=18`
- Start command: `npm start`
- Dashboard: `http://localhost:5000`
- Proxy: `http://localhost:8080`
- Persistence: `data/sessions.json`

## Build Plan

### Phase 1: Stabilize Core Logic

- Add unit coverage for parser category extraction across Anthropic, OpenAI, and Google payloads.
- Add tests for pricing fallback behavior and cache-aware cost calculation.
- Add tests for findings thresholds and storage diff/session resolution behavior.
- Harden malformed JSON and non-JSON upstream response handling in the proxy.

### Phase 2: Improve Accuracy

- Introduce pluggable tokenizer support instead of character-length heuristics.
- Normalize model names and pricing lookups more consistently.
- Improve streamed response reconstruction for tool calls, usage data, and provider-specific deltas.

### Phase 3: Improve UX

- Replace polling with server-sent or websocket updates.
- Add multi-session comparison and stronger filtering in the dashboard.
- Surface more actionable findings with direct jump links to turns or categories.

### Phase 4: Operational Readiness

- Add environment-based configuration for ports and persistence location.
- Add export/import workflows and retention controls.
- Add CI for linting/tests and basic startup validation.

## Decision Notes

- Keep the app local-first by default.
- Avoid adding databases before JSON persistence becomes a real bottleneck.
- Prefer incremental extension of current modules over framework migration.
