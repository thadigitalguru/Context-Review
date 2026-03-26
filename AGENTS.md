# AGENTS

## Project Goal

Context Review is a local proxy and dashboard for inspecting LLM request context composition, token usage, findings, diffs, session history, and estimated cost across Anthropic, OpenAI, and Google request formats.

## Current Architecture

- `index.js`: boots the dashboard on `5000`, proxy on `8080`, wires storage, parsing, and API routes.
- `src/proxy/proxy.js`: HTTP proxy that forwards supported API calls to upstream providers and captures request/response payloads.
- `src/parser/parser.js`: provider-specific request parsing into eight context categories with rough token estimation.
- `src/storage/storage.js`: in-memory session store with JSON persistence in `data/sessions.json`.
- `src/findings/findings.js`: heuristics for overflow risk, unused tools, large results, HTML in tool results, role confusion, growth, and compaction.
- `src/cost/pricing.js`: model pricing table and context window helpers.
- `src/api/routes.js`: REST API used by the dashboard.
- `public/`: single-page dashboard UI.

## Working Rules For Agents

- Preserve the current product shape: local-first, zero-code-change proxying, dashboard + proxy as one Node process.
- Prefer targeted changes over broad rewrites. The codebase is still small and mostly single-purpose modules.
- Keep provider support aligned across `proxy.js`, `parser.js`, `pricing.js`, and dashboard/API surfaces.
- Do not silently change listening ports without updating documentation and setup guidance.
- Treat session persistence compatibility as user-facing data. Avoid breaking `data/sessions.json` format unless migration is explicit.
- When adding findings or metrics, wire them end-to-end: parser/storage -> API -> UI.
- Keep dependencies light unless there is a clear accuracy or maintainability benefit.

## Immediate Technical Gaps

- No automated test suite.
- No exact tokenizer integration; token counts are heuristic.
- SSE reconstruction is partial and provider-specific.
- Storage is single-file JSON and not concurrency-safe.
- No real-time push channel; dashboard likely relies on polling.

## Safe Areas For Next Changes

- Add tests around parser, pricing, findings, and storage diff logic.
- Improve provider coverage and request/response normalization.
- Add tokenizer-backed counting behind a clean abstraction.
- Improve dashboard UX using existing API shapes before introducing new backend complexity.
