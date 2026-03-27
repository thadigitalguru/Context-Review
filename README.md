# Context Review

**See what your AI sees.** Local-first LLM context intelligence proxy and dashboard.

A local proxy that sits between your coding tools and LLM APIs to capture, analyze, and visualize what actually fills the context window. No code changes needed — just set the API base URL.

> Built in Nairobi for teams who can't afford to waste tokens or bandwidth.

## Why

Every time your AI coding agent makes an API call, it sends a context window full of tokens. Most of those tokens are invisible to you — system prompts, tool definitions, previous tool results, thinking blocks. You're paying for all of them.

Context Review shows you exactly what's in every request:

- **Composition treemap** — see that 53% of your context is tool definitions you never use
- **Context diff** — watch what grows and shrinks between turns
- **Findings** — get flagged when tool results contain HTML markup, role confusion patterns, or when your context is growing too fast
- **Simulation** — run what-if actions (trim results, remove tools, compact history) before changing prompts/tooling
- **Cost tracking** — per-turn and per-session cost with cache-aware pricing
- **Health scoring** — know when you're approaching overflow before it happens
- **Team + CI workflows** — segment by project/user and expose machine-readable regression checks

## Quick Start

```bash
# Clone and install
git clone https://github.com/thadigitalguru/Context-Review.git
cd Context-Review
npm install

# Start (dashboard on :5000, proxy on :8080)
npm start

# If those ports are busy, override them:
DASHBOARD_PORT=5050 PROXY_PORT=8081 npm start

# If proxy binds on all interfaces, keep client URL on localhost:
PROXY_HOST=0.0.0.0 PROXY_ADVERTISE_HOST=localhost npm start

# Optional: disable background analysis scheduler (Phase 5 architecture)
CONTEXT_REVIEW_DISABLE_BACKGROUND_ANALYSIS=1 npm start

# Optional: run with event-backed storage adapter
CONTEXT_REVIEW_STORAGE_ADAPTER=event npm start
```

Then point your LLM tool to the proxy:

```bash
# Claude Code / Anthropic
export ANTHROPIC_BASE_URL=http://localhost:8080

# Codex / Aider / OpenAI
export OPENAI_BASE_URL=http://localhost:8080

# Gemini CLI / Google
export GOOGLE_API_BASE_URL=http://localhost:8080
```

Use your tool normally. Every API call is captured and analyzed. Open `http://localhost:5000` (or your `DASHBOARD_PORT`) to see the dashboard.

### Team Context Headers (Optional)

For team/project segmentation, send these headers through your tool/proxy client:

- `x-context-review-project: <project-name>`
- `x-context-review-user: <user-or-agent-id>`

Context Review will group and filter sessions by these identities.

## What It Shows

### 8-Category Context Breakdown

Every API request is parsed into granular categories:

| Category | What it captures |
|---|---|
| **System Prompts** | System-level instructions sent to the model |
| **Tool Definitions** | Function/tool schemas (often the largest category) |
| **Tool Calls** | Assistant's tool_use blocks |
| **Tool Results** | Output from tool executions |
| **Assistant Text** | Model's text responses in conversation history |
| **User Text** | Your messages |
| **Thinking Blocks** | Extended thinking/reasoning content |
| **Media** | Images, files, binary data |

### Context Diff

Side-by-side comparison of consecutive turns showing what changed. Filter by category group (Drivers, Tools, Conversation) to drill into specific areas.

### Findings Engine

Automatic detection of optimization opportunities:

- **Overflow risk** — approaching context window limits
- **Unused tool definitions** — tools defined but never called
- **HTML in tool results** — markup wasting tokens
- **Role confusion** — instruction-like text in tool results
- **Rapid growth** — context growing faster than sustainable
- **Large tool results** — individual results over 2K tokens
- **Context compaction** — detecting when history was truncated

### Cost Tracking

Per-model pricing with cache-aware cost calculation for Anthropic, OpenAI, and Google models. Shows per-turn cost, session totals, and cache savings.

## Supported Providers

| Provider | Path | Tools Detected |
|---|---|---|
| **Anthropic** | `/v1/messages` | Claude Code, Cursor |
| **OpenAI** | `/v1/chat/completions` | Codex, Aider, GitHub Copilot |
| **Google** | `/v1beta/models/*` | Gemini CLI |

Agent auto-detection works via user-agent headers and system prompt fingerprinting.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Your Tool  │────▶│ Context      │────▶│  LLM API    │
│  (Claude    │◀────│ Review Proxy │◀────│  (Anthropic, │
│   Code etc) │     │  :8080       │     │   OpenAI,    │
└─────────────┘     └──────┬───────┘     │   Google)   │
                           │             └─────────────┘
                    ┌──────▼───────┐
                    │  Dashboard   │
                    │  :5000       │
                    │              │
                    │  Parser ─────│── 8-category breakdown
                    │  Storage ────│── Session persistence
                    │  Findings ───│── Optimization suggestions
                    │  Cost ───────│── Cache-aware pricing
                    └──────────────┘
```

### Directory Structure

```
src/
  proxy/proxy.js        Transparent proxy, auto-detects provider, SSE passthrough
  parser/parser.js      Parses requests into 8 categories, estimates tokens
  storage/storage.js    Session storage with disk persistence and context diffs
  analysis/             Trend/report/CI analysis modules + background scheduler
  cost/pricing.js       Model pricing data with cache-aware cost calculation
  findings/findings.js  Optimization analysis and content-level detection
  api/routes.js         REST API endpoints for dashboard
public/
  index.html            Dashboard SPA
  css/style.css         Dark theme styles
  js/app.js             Frontend (treemap, diff bars, timeline, findings)
```

## LHAR Export

Export session data as LHAR (LLM HTTP Archive) for offline analysis — a JSON format containing every API call's breakdown, timing, and session metadata.

## Team + CI APIs

- `GET /api/sessions?project=<id>&user=<id>&agent=<name>&provider=<name>&model=<contains>&from=<ts|iso>&to=<ts|iso>`
- `GET /api/ci/summary?days=7` machine-readable metrics for current vs previous windows
- `POST /api/ci/check` regression gate endpoint (`422` on threshold failures)
- `GET /api/reports/session/:id/snapshot` JSON shareable summary
- `GET /api/reports/session/:id/snapshot?format=md` markdown snapshot for PRs/reviews

## Phase 5 Architecture Notes

- Analysis logic is split into `src/analysis/session-analysis.js` to keep API routing thin.
- Background analysis caching runs in `src/analysis/background.js` and precomputes summary/CI windows.
- Optional event-log mode (`CONTEXT_REVIEW_EVENT_LOG=1`) appends capture events to `data/events.ndjson` while preserving local-first `sessions.json` mode.
- Recommended adapter toggle: `CONTEXT_REVIEW_STORAGE_ADAPTER=event` (`flat` remains default).
- Migration path: `npm run migrate:event-log` seeds `events.ndjson` from existing `sessions.json`.

## Key Design Decisions

- **Local proxy, not cloud** — your API keys never leave your machine
- **Zero code changes** — just an environment variable change
- **Estimate-then-verify** — parses request bodies for composition, uses API-reported tokens for accuracy when available
- **Framework-agnostic** — works with any tool that uses standard API endpoints
- **8 granular categories** — not just "input/output" but exactly what type of content fills the window
- **SSE streaming passthrough** — streaming responses are forwarded in real-time, captured after completion

## Roadmap

- [ ] WebSocket real-time updates (replace polling)
- [ ] Multi-session comparison view
- [ ] Token budget alerts and session cost limits
- [ ] CLI-only mode for headless environments
- [ ] Sub-agent tracking (main agent vs spawned agents)
- [ ] Plugin system for custom findings rules
- [ ] Tokenizer integration (tiktoken/anthropic) for exact counts
- [ ] Import from Helicone/LiteLLM for migration

## License

MIT
