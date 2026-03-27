# PLANS

## Objective

Evolve Context Review from a useful local request visualizer into a trusted context intelligence product that can explain token usage, identify waste precisely, recommend fixes, and scale from solo debugging to team workflows.

## Product Thesis

The durable product is not "a dashboard for token charts." The durable product is a system that answers:

- What filled this context window?
- Why did this request cost so much?
- What exact change reduces waste without reducing output quality?

## Execution Order

Build in this order:

1. Trust the data
2. Turn analysis into actions
3. Build repeatable optimization workflows
4. Add team and CI value
5. Scale the architecture

This sequence matters. Better charts without trusted data or actionable recommendations will not create durable value.

## Current Baseline

- Runtime: Node.js `>=18`
- Start command: `npm start`
- Dashboard: `http://localhost:5000`
- Proxy: `http://localhost:8080`
- Persistence: `data/sessions.json`
- Core server entrypoint: `index.js`
- Main backend modules:
  - `src/proxy/proxy.js`
  - `src/parser/parser.js`
  - `src/storage/storage.js`
  - `src/findings/findings.js`
  - `src/cost/pricing.js`
  - `src/api/routes.js`
- Main frontend modules:
  - `public/index.html`
  - `public/css/style.css`
  - `public/js/app.js`

## Current Execution Status (Updated 2026-03-27)

Completed highlights:

- Phase 1 reliability baseline:
  - parser/provider coverage in automated tests
  - fixture-driven parser golden regression tests (Anthropic/OpenAI/Google)
  - normalized parser schema contract validation tests
  - stream reconstruction hardening with malformed/partial SSE regression tests
- Phase 2 recommendations:
  - source-aware findings with savings estimates
  - simulation actions and before/after delta APIs
- Phase 3 workflows:
  - trends, forecasting, alerts, and reusable report summaries
- Phase 4 team/CI:
  - project/user/agent filtering
  - CI summary/check endpoints
  - report snapshot export formats
  - auth + RBAC + tenant scoping
- Phase 5 architecture:
  - optional event-log adapter mode
  - migration flow with dry-run/backup/verification
  - event-log compaction + retention controls
  - startup integrity checks + auto-recovery
  - storage observability (`/api/storage/status`, `/api/health/storage`) and CI health gate script

Remaining focus areas:

- parser fixture corpus expansion to additional real-world edge cases
- explicit normalized schema versioning for backward compatibility guarantees
- performance profiling for long event logs and large session sets
- lightweight operator docs/playbooks for incident and rollback workflows

## Phase 1: Make The Data Trustworthy

### Goal

Make token counts, category attribution, and streamed capture behavior accurate enough that users trust the product for operational decisions.

### Why First

All later recommendations, savings estimates, and alerts depend on this layer. If the numbers are weak, everything above them is weak.

### Workstreams

#### 1. Add parser and proxy test coverage

- Create a test harness for provider-specific request fixtures.
- Add fixtures for Anthropic, OpenAI, and Google request/response bodies.
- Cover:
  - system prompts
  - tool definitions
  - tool calls
  - tool results
  - assistant text
  - user text
  - thinking blocks
  - media
- Add regression tests for session diff behavior and model/pricing fallback logic.

Files likely involved:
- `src/parser/parser.js`
- `src/storage/storage.js`
- `src/cost/pricing.js`
- `src/proxy/proxy.js`

#### 2. Introduce a tokenizer abstraction

- Replace direct character-length token estimation with a pluggable counting layer.
- Keep a fallback estimator for unsupported models.
- Return both:
  - estimated tokens
  - counting method used
- Record whether a count is exact, provider-reported, or heuristic.

Suggested structure:
- `src/tokens/` for counting adapters and fallback logic

#### 3. Normalize provider payloads

- Create an internal normalized event shape so Anthropic, OpenAI, and Google parsing logic feed one common representation.
- Normalize:
  - role names
  - tool call/result representation
  - media parts
  - usage metadata
  - model naming
- Keep provider-specific parsing, but make downstream logic consume normalized data.

#### 4. Improve streaming reconstruction

- Capture tool call deltas and output content more completely for streaming responses.
- Preserve upstream timing and completion metadata where possible.
- Make the proxy resilient to malformed events and partial streams.

### Acceptance Criteria

- Parser tests cover all supported providers and major content categories.
- Token counting source is explicit in stored breakdowns.
- Streamed and non-streamed requests produce comparable breakdown quality.
- Known fixtures produce stable, test-backed outputs.

### Exit Outcome

Context Review can justify its numbers well enough for users to trust cost, composition, and overflow conclusions.

## Phase 2: Turn Analysis Into Recommendations

### Goal

Move from descriptive findings to prescriptive guidance with estimated impact.

### Why Second

Once the data is trustworthy, the product’s next job is to recommend concrete fixes instead of only highlighting symptoms.

### Workstreams

#### 1. Upgrade findings into recommendation rules

- Replace generic warnings with issue-specific recommendations.
- Every finding should answer:
  - what caused the issue
  - where it came from
  - how large it is
  - what to change
  - what savings are likely

Examples:
- Unused tool definitions by exact tool name and token cost
- Oversized tool result by turn and message index
- Repeated system prompt blocks across captures
- Redundant history carried forward without impact
- Expensive media or large inline data payloads

#### 2. Add savings estimation

- Estimate token and dollar savings per recommendation.
- Distinguish confidence levels:
  - high confidence
  - moderate confidence
  - heuristic estimate

#### 3. Add simulation support

- Extend `/api/simulate` or add a dedicated route for "what if" comparisons.
- Let the UI compare baseline vs proposed reductions:
  - remove tools
  - trim tool results
  - compact history
  - shorten system prompts

### Acceptance Criteria

- Findings include exact sources and likely impact.
- Recommendations can be tied back to turns, tools, or prompt sections.
- Simulation can show before/after token and cost changes for common actions.

### Exit Outcome

The product answers "what should I change next?" with evidence.

## Phase 3: Build Repeatable Optimization Workflows

### Goal

Make the product useful across sessions and projects, not just single captures.

### Why Third

After fixing per-request visibility, the next source of value is spotting patterns that recur over time.

### Workstreams

#### 1. Session and trend analysis

- Add views for:
  - token growth over time
  - repeated waste patterns
  - model-specific cost drivers
  - tool usage frequency and waste contribution
- Show top contributors to context bloat per session.

#### 2. Budget and overflow forecasting

- Add alerts for:
  - context growth trajectory
  - cost spikes
  - frequent large tool results
  - high tool-definition overhead
- Forecast turns remaining before practical overflow.

#### 3. Reusable reports

- Add summaries such as:
  - top waste drivers this week
  - most expensive sessions
  - most repeated system blocks
  - unused tools across sessions

### Acceptance Criteria

- Users can compare sessions and identify recurring inefficiencies.
- The UI supports trend-based inspection, not only per-turn inspection.
- Reports are exportable or easy to share.

### Exit Outcome

Context Review becomes an optimization workflow rather than a one-time debugger.

## Phase 4: Add Team And CI Value

### Goal

Make the product useful in engineering workflows beyond a single local machine.

### Why Fourth

This is the step that creates organizational value and begins building product defensibility.

### Workstreams

#### 1. Team/project data model

- Add project identity and optional user/agent grouping.
- Support filtering by:
  - project
  - agent
  - model
  - provider
  - time range

#### 2. CI and regression workflows

- Add machine-readable summaries that CI can inspect.
- Detect regressions such as:
  - prompt token inflation
  - new unused tools
  - higher average context per turn
  - higher average cost per task

#### 3. Sharing and export

- Improve LHAR and summary exports.
- Add report snapshots suitable for PRs or internal reviews.

### Acceptance Criteria

- Session data can be segmented by project or agent.
- CI can fail or warn on major context regressions.
- Teams can share summaries without exposing raw traffic unnecessarily.

### Exit Outcome

Context Review becomes part of engineering operations, not just personal debugging.

## Phase 5: Scale The Architecture

### Goal

Refactor the implementation so local mode remains simple, while team or hosted modes become practical without a rewrite.

### Why Last

Premature infrastructure work is expensive. Do this only after the product shape is validated through real usage.

### Workstreams

#### 1. Split core responsibilities

- Separate ingestion, normalization, analysis, storage, and API serving more clearly.
- Keep the single-process local mode available.

#### 2. Replace flat-file persistence for scaled modes

- Move from `data/sessions.json` to a durable event-backed store when needed.
- Preserve export compatibility and keep migration explicit.

#### 3. Add background analysis

- Run heavier scoring, aggregation, and reporting outside the request path.
- Keep capture ingestion fast and resilient.

### Acceptance Criteria

- Local mode still works with minimal setup.
- Storage and analysis architecture can support higher volume and longer history.
- The system can evolve toward self-hosted or managed deployment without a major rewrite.

### Exit Outcome

The architecture supports growth without losing the simplicity of the current MVP.

## First 90 Days

### Weeks 1-2

- Add test framework and fixture coverage
- Add parser, pricing, findings, and storage regression tests
- Define normalized internal event schema

### Weeks 3-4

- Introduce tokenizer abstraction and fallback strategy
- Add counting source metadata
- Improve streamed response reconstruction

### Weeks 5-6

- Upgrade findings to source-aware recommendations
- Add token and cost savings estimates
- Extend simulation support

### Weeks 7-8

- Add trend analysis and comparison views
- Add budget and overflow forecasting
- Expose report-friendly API outputs

### Weeks 9-12

- Add project/agent grouping
- Add CI-friendly summaries and regression checks
- Begin storage refactor design based on actual usage

## Implementation Principles

- Keep the app local-first by default.
- Preserve the current zero-code-change proxy setup.
- Do not add heavy infrastructure before the accuracy and recommendation layers are strong.
- Prefer end-to-end features over isolated backend or frontend work.
- When changing schemas, keep migration and backward compatibility explicit.
- Do not optimize for more charts. Optimize for clearer decisions.

## Immediate Next Build Tasks

Current next queue:

1. Expand fixture corpus with streaming-heavy and multimodal edge cases for all providers.
2. Add normalized schema versioning + migration guards for parser output compatibility.
3. Add replay/analysis performance benchmarks and budget thresholds in CI.
4. Add operator runbooks for recovery validation, rollback, and storage maintenance windows.
5. Add cross-session comparison UX to surface recurring waste patterns across teams/projects.

## Definition Of Success

Context Review is succeeding when a user can inspect a session and answer, with evidence:

- what filled the context
- what drove the cost
- what is safe to remove or compact
- how much that change will save
- whether the same waste pattern is recurring across sessions or teams
