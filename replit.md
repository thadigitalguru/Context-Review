# Context Review

## Overview
A local proxy that sits between coding tools and LLM APIs (Anthropic, OpenAI, Google) to capture and visualize what fills the context window. No code changes needed in the user's tools — just set the API base URL. Answers "why is this session so expensive?" with composition breakdowns, cost tracking, and optimization suggestions.

**Tagline:** "See inside your LLM context and stop burning tokens you can't see."

## Project Architecture
- **Runtime**: Node.js 20
- **Framework**: Express.js
- **Entry point**: `index.js` — runs both the dashboard (port 5000) and proxy (port 8080)
- **Dashboard**: port 5000 (0.0.0.0) — web UI
- **Proxy**: port 8080 (localhost) — transparent LLM API proxy

### Directory Structure
```
src/
  proxy/proxy.js      — Transparent proxy server, auto-detects provider
  parser/parser.js    — Parses requests into categories, estimates tokens
  storage/storage.js  — Session storage with disk persistence
  cost/pricing.js     — Model pricing data and cost calculation
  findings/findings.js — Smart analysis and optimization suggestions
  api/routes.js       — REST API endpoints for dashboard
public/
  index.html          — Dashboard SPA
  css/style.css       — Styles (dark theme, reference-based design)
  js/app.js           — Frontend JavaScript
data/                 — Persisted session data (gitignored)
```

### Supported Providers
- **Anthropic** (`/v1/messages`) — Claude Code, etc.
- **OpenAI** (`/v1/chat/completions`) — Codex, Aider, etc.
- **Google** (`/v1beta/models/*`) — Gemini CLI

### Key Features
- Top bar with agent badge, session metadata, cost, health score, live indicator
- Turn navigator with mini colored bar chart and navigation
- Session sidebar with color-coded agent names and percentage bars
- Stats row: Context %, Turn Cost, Output, Health gauge
- Health alert banner with risk level and action buttons
- Composition treemap with proportional blocks
- Findings with filterable tags, scores, and severity labels (Structural/Critical/Suggestion)
- Context diff view (what grew/shrank each turn)
- Agent auto-detection and breakdown
- LHAR export for offline analysis
- Session persistence to disk
- SSE streaming passthrough for all providers
- Demo data loading for quick exploration

### Parser Categories (8 granular)
- `system_prompts` — System prompt text
- `tool_definitions` — Tool/function schemas
- `tool_calls` — Assistant tool_use blocks
- `tool_results` — Tool result content
- `assistant_text` — Assistant text responses
- `user_text` — User messages
- `thinking_blocks` — Extended thinking content
- `media` — Images, files, binary data

## Recent Changes
- 2026-02-20: Context Diff visualization with stacked bars, filter tabs (Drivers/Tools/Conversation), per-category delta tracking
- 2026-02-20: Content-level findings — HTML detection in tool results, role confusion patterns, unused tool definitions with message references and content previews
- 2026-02-20: Findings styling polish — warning triangle icons, severity badges (Critical/Structural/Suggestion), filterable tags with scores
- 2026-02-20: Granular 8-category parsing replacing lumped conversation_history
- 2026-02-20: Full redesign matching reference UI — top bar, turn navigator, sidebar, stats, health banner, treemap composition
- 2026-02-20: Initial implementation — proxy, parser, storage, cost engine, findings, dashboard

## User Preferences
- Dark theme dashboard (reference-based design)
- Focus on cost-sensitive workflows (African startup context)
- "Built in Nairobi for teams who can't afford to waste tokens or bandwidth"
