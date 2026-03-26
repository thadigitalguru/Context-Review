# SKILLS

## Repo Skills Map

### Proxy Debugging

- Files: `index.js`, `src/proxy/proxy.js`
- Use when: request forwarding fails, streaming is broken, provider detection is incomplete, or headers/timeouts need adjustment.

### Request Parsing

- Files: `src/parser/parser.js`
- Use when: token composition looks wrong, categories are missing, agent detection is wrong, or a new request schema must be supported.

### Session Persistence

- Files: `src/storage/storage.js`
- Use when: sessions merge incorrectly, diffs look wrong, exports are incomplete, or disk persistence needs changes.

### Findings And Costing

- Files: `src/findings/findings.js`, `src/cost/pricing.js`
- Use when: optimization suggestions are noisy, thresholds need tuning, cost numbers are off, or context window mapping needs updates.

### Dashboard API

- Files: `src/api/routes.js`
- Use when: frontend data is missing, capture details need richer payloads, or new views require backend endpoints.

### Frontend Dashboard

- Files: `public/index.html`, `public/css/style.css`, `public/js/app.js`
- Use when: treemap, diffs, timelines, findings rendering, or dashboard interactions need work.

## Engineering Preferences

- Keep features wired across backend and UI, not half-implemented.
- Prefer low-dependency solutions.
- Preserve current REST API behavior unless the frontend is updated in the same change.
- Add tests before large parser or pricing refactors.
