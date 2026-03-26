const API = '/api';
let state = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  currentTab: 'overview',
  currentTurn: -1,
  captures: [],
  timeline: [],
  findings: [],
  composition: null,
  diffs: [],
  pollTimer: null,
  findingFilter: null,
  diffFilter: null,
};

async function api(path) {
  try {
    const r = await fetch(`${API}${path}`);
    if (!r.ok) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

function fmt(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n) {
  if (!n && n !== 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h';
  return Math.floor(d / 86400000) + 'd';
}

const AGENT_COLORS = {
  'claude_code': '#e8a855', 'Claude Code': '#e8a855',
  'aider': '#54a0ff', 'Aider': '#54a0ff',
  'codex': '#ff6b9d', 'Codex': '#ff6b9d',
  'cursor': '#a855f7', 'Cursor': '#a855f7',
  'copilot': '#3b82f6', 'GitHub Copilot': '#3b82f6',
  'gemini_cli': '#10b981', 'Gemini CLI': '#10b981',
  'pi': '#06b6d4', 'Pi': '#06b6d4',
  'unknown': '#6c5ce7', 'Unknown Agent': '#6c5ce7',
};

const CAT_COLORS = {
  system_prompts: { color: '#6366f1', label: 'System prompt' },
  tool_definitions: { color: '#f59e0b', label: 'Tool definitions' },
  tool_calls: { color: '#ef4444', label: 'Tool calls' },
  tool_results: { color: '#10b981', label: 'Tool results' },
  assistant_text: { color: '#f97316', label: 'Assistant text' },
  user_text: { color: '#06b6d4', label: 'User text' },
  thinking_blocks: { color: '#a855f7', label: 'Thinking' },
  media: { color: '#ec4899', label: 'Media' },
};

const CAT_ORDER = ['system_prompts', 'tool_definitions', 'tool_calls', 'tool_results', 'assistant_text', 'user_text', 'thinking_blocks', 'media'];

function getAgentColor(agent) {
  if (!agent) return '#6c5ce7';
  return AGENT_COLORS[agent.id] || AGENT_COLORS[agent.name] || '#6c5ce7';
}

function computeHealth(session, composition, timeline) {
  let score = 100;
  if (!composition || !composition.composition) return score;

  const comp = composition.composition;
  const ctxWindow = getContextWindow(comp.model);
  const usage = comp.total_tokens / ctxWindow;

  if (usage > 0.95) score -= 40;
  else if (usage > 0.8) score -= 25;
  else if (usage > 0.6) score -= 10;

  const cats = comp.categories;
  const toolResults = cats.find(c => c.key === 'tool_results');
  if (toolResults && toolResults.percentage > 60) score -= 15;
  else if (toolResults && toolResults.percentage > 40) score -= 8;

  const toolDefs = cats.find(c => c.key === 'tool_definitions');
  if (toolDefs && toolDefs.percentage > 30) score -= 10;

  if (timeline && timeline.length >= 2) {
    const last = timeline.slice(-3);
    let totalGrowth = 0;
    for (let i = 1; i < last.length; i++) {
      totalGrowth += (last[i].breakdown.total - last[i - 1].breakdown.total);
    }
    const avgGrowth = totalGrowth / (last.length - 1);
    if (avgGrowth > 10000) score -= 15;
    else if (avgGrowth > 5000) score -= 8;
  }

  return Math.max(0, Math.min(100, score));
}

function getContextWindow(model) {
  const windows = {
    'claude-sonnet-4-20250514': 200000, 'claude-3-5-sonnet-20241022': 200000,
    'claude-3-opus-20240229': 200000, 'claude-opus-4-20250514': 200000,
    'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
    'o1': 200000, 'o3': 200000,
    'gemini-2.5-pro': 1048576, 'gemini-2.5-flash': 1048576,
  };
  if (!model) return 200000;
  for (const [k, v] of Object.entries(windows)) {
    if (model.includes(k)) return v;
  }
  if (model.includes('claude')) return 200000;
  if (model.includes('gpt')) return 128000;
  if (model.includes('gemini')) return 1048576;
  return 200000;
}

function healthColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 40) return 'var(--orange)';
  return 'var(--red)';
}

function healthClass(score) {
  if (score >= 70) return 'good';
  if (score >= 40) return 'warning';
  return 'critical';
}

function healthLabel(score) {
  if (score >= 80) return 'healthy';
  if (score >= 60) return 'moderate risk';
  if (score >= 40) return 'elevated risk';
  if (score >= 20) return 'high risk';
  return 'critical risk';
}

async function refresh() {
  state.sessions = await api('/sessions') || [];
  const stats = await api('/stats');

  if (state.currentSessionId) {
    const [session, captures, timeline, findings, diffs] = await Promise.all([
      api(`/sessions/${state.currentSessionId}`),
      api(`/sessions/${state.currentSessionId}/captures`),
      api(`/sessions/${state.currentSessionId}/timeline`),
      api(`/sessions/${state.currentSessionId}/findings`),
      api(`/sessions/${state.currentSessionId}/diffs`),
    ]);
    state.currentSession = session;
    state.captures = captures || [];
    state.timeline = timeline || [];
    state.findings = findings || [];
    state.diffs = diffs || [];
    if (state.currentTurn === -1 && state.timeline.length > 0) state.currentTurn = state.timeline.length - 1;
    state.composition = await api(`/sessions/${state.currentSessionId}/composition?turn=${state.currentTurn}`);
  }

  renderTopBar(stats);
  renderTurnNav();
  renderSidebar();
  renderMain();
}

function renderTopBar(stats) {
  const bar = document.getElementById('top-bar-content');
  const s = state.currentSession;

  let agentName = 'No session';
  let modelName = '';
  let sessionIdShort = '';
  let turns = 0;
  let cost = '$0.00';
  let health = 100;

  if (s && s.id) {
    const agents = Object.values(s.agents || {});
    agentName = agents.length > 0 ? agents[0].name : s.provider || 'Unknown';
    modelName = s.model || 'unknown';
    sessionIdShort = s.id.substring(0, 12);
    turns = s.requestCount || 0;
    cost = s.cost ? fmtCost(s.cost.totalCost) : '$0.00';
    health = computeHealth(s, state.composition, state.timeline);
  }

  const hasSession = s && s.id;
  const agentColor = hasSession ? getAgentColor(Object.values(s.agents || {})[0]) : '#6c5ce7';

  bar.innerHTML = `
    <div class="top-bar-brand"><div class="icon">CR</div>Context Review</div>
    ${hasSession ? `
      <span class="agent-badge" style="background:${agentColor}">${agentName}</span>
      <span class="top-bar-meta">${modelName}</span>
      <span class="top-bar-sep">&bull;</span>
      <span class="top-bar-meta">SID ${sessionIdShort}</span>
      <span class="top-bar-sep">&bull;</span>
      <span class="top-bar-stat"><span class="val">${turns}</span> turns</span>
      <span class="top-bar-stat cost"><span class="val">${cost}</span></span>
      <span class="top-bar-stat">Health <span class="val" style="color:${healthColor(health)}">${health}</span></span>
      <span class="top-bar-sep">&bull;</span>
      <span class="live-dot"></span><span style="color:var(--green);font-size:11px;font-weight:600">Live</span>
    ` : `
      <span class="top-bar-meta">${stats ? stats.sessionCount + ' sessions' : ''}</span>
      <span class="top-bar-stat cost"><span class="val">${stats ? fmtCost(stats.totalCost) : '$0.00'}</span></span>
    `}
    <div class="top-bar-actions">
      ${hasSession ? `<button class="btn" onclick="exportLHAR()">Export</button>` : ''}
      <button class="btn" onclick="clearAll()">Reset</button>
    </div>
  `;
}

function renderTurnNav() {
  const nav = document.getElementById('turn-nav');
  if (!state.currentSession || state.timeline.length === 0) {
    nav.style.display = 'none';
    return;
  }
  nav.style.display = 'flex';

  const total = state.timeline.length;
  const current = state.currentTurn + 1;
  const maxTokens = Math.max(...state.timeline.map(t => t.breakdown.total), 1);

  const bars = state.timeline.map((t, i) => {
    const h = Math.max(4, (t.breakdown.total / maxTokens) * 22);
    const mainCat = Object.entries(t.breakdown)
      .filter(([k]) => k !== 'total')
      .sort((a, b) => b[1] - a[1])[0];
    const color = mainCat ? (CAT_COLORS[mainCat[0]] || { color: '#6c5ce7' }).color : '#6c5ce7';
    return `<div class="turn-bar ${i === state.currentTurn ? 'active' : ''}" style="height:${h}px;background:${color}" onclick="goToTurn(${i})" title="Turn ${i + 1}: ${fmt(t.breakdown.total)} tokens"></div>`;
  }).join('');

  nav.innerHTML = `
    <div class="turn-nav-arrows">
      <button onclick="prevTurn()">&#9664;</button>
      <span class="turn-counter">&#9679; ${current} <span>/ ${total}</span></span>
      <button onclick="nextTurn()">&#9654;</button>
    </div>
    <div class="turn-minimap">${bars}</div>
  `;
}

function renderSidebar() {
  const list = document.getElementById('session-list');
  if (state.sessions.length === 0) {
    list.innerHTML = '<div style="padding:20px 4px;text-align:center;font-size:10px;color:var(--text-muted)">No sessions</div>';
    return;
  }

  list.innerHTML = state.sessions.map(s => {
    const agents = Object.values(s.agents || {});
    const agent = agents.length > 0 ? agents[0] : { name: s.provider, id: 'unknown' };
    const color = getAgentColor(agent);
    const pct = s.totalInputTokens > 0 ? Math.min(100, Math.round((s.totalInputTokens / getContextWindow(s.model)) * 100)) : 0;
    const isActive = s.id === state.currentSessionId;

    return `<div class="session-chip ${isActive ? 'active' : ''}" onclick="selectSession('${s.id}')">
      <div class="session-chip-name" style="color:${color}">${agent.name.split(' ')[0].toLowerCase()}</div>
      <div class="session-chip-tokens">${fmt(s.totalInputTokens)}t</div>
      <div class="session-chip-bar" style="background:${color}22;color:${color}">${pct}%</div>
    </div>`;
  }).join('');
}

function renderMain() {
  const welcome = document.getElementById('welcome-screen');
  const session = document.getElementById('session-view');

  if (!state.currentSessionId || !state.currentSession || !state.currentSession.id) {
    welcome.style.display = 'flex';
    session.style.display = 'none';
    return;
  }

  welcome.style.display = 'none';
  session.style.display = 'flex';

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === state.currentTab);
  });

  const area = document.getElementById('tab-content');
  switch (state.currentTab) {
    case 'overview': renderOverview(area); break;
    case 'messages': renderMessages(area); break;
    case 'timeline': renderTimeline(area); break;
  }
}

function renderOverview(area) {
  const s = state.currentSession;
  const comp = state.composition?.composition;
  const tl = state.timeline;
  const health = computeHealth(s, state.composition, tl);

  const ctxWindow = getContextWindow(s.model);
  const totalTokens = comp ? comp.total_tokens : s.totalInputTokens;
  const ctxPct = ((totalTokens / ctxWindow) * 100).toFixed(1);
  const avgPerTurn = s.requestCount > 0 ? totalTokens / s.requestCount : 0;
  const turnsLeft = avgPerTurn > 0 ? Math.floor((ctxWindow - totalTokens) / avgPerTurn) : 0;

  const turnCost = tl.length > 0 && tl[tl.length - 1].cost ? tl[tl.length - 1].cost.totalCost : 0;
  const sessionCost = s.cost ? s.cost.totalCost : 0;

  const lastTurn = tl.length > 0 ? tl[tl.length - 1] : null;

  const ctxColor = ctxPct > 90 ? 'red' : ctxPct > 70 ? 'orange' : 'green';
  const turnsLeftColor = turnsLeft <= 5 ? 'red' : turnsLeft <= 15 ? 'orange' : 'green';

  const statsHTML = `<div class="stats-row">
    <div class="stat-box">
      <div class="stat-box-value ${ctxColor}">${ctxPct}%</div>
      <div class="stat-box-label">Context</div>
      <div class="stat-box-sub">${fmt(totalTokens)} / ${fmt(ctxWindow)}</div>
      <div class="stat-box-sub ${turnsLeftColor}">~${turnsLeft} turns left</div>
    </div>
    <div class="stat-box">
      <div class="stat-box-value yellow">${fmtCost(turnCost)}</div>
      <div class="stat-box-label">Turn Cost</div>
      <div class="stat-box-sub">${fmtCost(sessionCost)} session</div>
    </div>
    <div class="stat-box">
      <div class="stat-box-value">${fmt(s.totalOutputTokens || 0)}</div>
      <div class="stat-box-label">Output</div>
      <div class="stat-box-sub">${s.requestCount} requests</div>
    </div>
    <div class="stat-box">
      <div class="health-gauge" style="border:3px solid ${healthColor(health)}">
        <div class="health-gauge-value" style="color:${healthColor(health)}">${health}</div>
      </div>
      <div class="stat-box-label">Health</div>
    </div>
  </div>`;

  const findingsHTML = renderFindingsSection();
  const diffHTML = renderContextDiff();
  const compHTML = renderComposition(comp);

  const msgCount = comp ? (comp.messageCount || 0) : state.captures.length;
  const msgTokens = comp ? comp.total_tokens : s.totalInputTokens;
  const messagesHTML = `<div class="section-header" style="margin-top:4px;cursor:pointer" onclick="switchTab('messages')">
    <div class="section-title">MESSAGES<span class="turn-info">${msgCount} messages &middot; ${fmt(msgTokens)}</span></div>
    <div style="font-size:11px;color:var(--text-muted)">View all &rarr;</div>
  </div>`;

  area.innerHTML = statsHTML + findingsHTML + diffHTML + compHTML + messagesHTML;
}

function renderFindingsSection() {
  if (state.findings.length === 0) return '';

  const tagCounts = {};
  state.findings.forEach(f => {
    const cat = f.category || 'other';
    tagCounts[cat] = (tagCounts[cat] || 0) + 1;
  });

  const tagColors = {
    overflow: 'red', tool_definitions: 'yellow', tool_results: 'green',
    growth: 'orange', thinking: 'purple', system_prompts: 'blue',
    compaction: 'blue', media: 'pink', other: 'blue',
  };

  const filtered = state.findingFilter
    ? state.findings.filter(f => f.category === state.findingFilter)
    : state.findings;

  return `<div style="margin-bottom:20px">
    <div class="findings-header">
      <div class="section-title">FINDINGS</div>
      <div class="findings-count">${state.findings.length}</div>
    </div>
    <div class="findings-tags">
      ${Object.entries(tagCounts).map(([cat, count]) => {
        const c = tagColors[cat] || 'blue';
        return `<div class="findings-tag ${c} ${state.findingFilter === cat ? 'active' : ''}" onclick="toggleFindingFilter('${cat}')">
          ${cat.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} <span class="findings-tag-count">${count}</span>
        </div>`;
      }).join('')}
    </div>
    <div>
      ${filtered.map(f => {
        const sevClass = f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'structural' : f.severity === 'medium' ? 'suggestion' : 'info';
        const sevLabel = f.severity === 'critical' ? 'Critical' : f.severity === 'high' ? 'Structural' : f.severity === 'medium' ? 'Suggestion' : 'Info';
        const icon = f.severity === 'critical' ? '&#9888;' : f.severity === 'high' ? '&#9888;' : '&#9888;';
        const iconClass = f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'warn' : 'info';
        return `<div class="finding-card">
          <div class="finding-icon ${iconClass}">${icon}</div>
          <div class="finding-body">
            <div class="finding-title">${f.title}</div>
            <div class="finding-desc">${f.description}</div>
            ${renderFindingMeta(f)}
            ${f.preview ? `<div class="finding-preview">${escapeHtml(f.preview.substring(0, 140))}</div>` : ''}
          </div>
          <div class="finding-severity ${sevClass}">${sevLabel}</div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderFindingMeta(finding) {
  const chips = [];
  const details = [];

  if (finding.estimatedSavings && typeof finding.estimatedSavings.tokens === 'number') {
    const confidence = finding.estimatedSavings.confidence || 'heuristic';
    chips.push(`<span class="finding-chip savings">Save ~${fmt(finding.estimatedSavings.tokens)} tokens</span>`);
    chips.push(`<span class="finding-chip confidence">${escapeHtml(confidence)}</span>`);
  }

  if (finding.source) {
    details.push(`<div class="finding-detail-row"><span class="finding-detail-label">Source</span><span class="finding-detail-value">${formatSource(finding.source)}</span></div>`);
  }

  if (Array.isArray(finding.sources) && finding.sources.length > 0) {
    details.push(`<div class="finding-detail-row"><span class="finding-detail-label">Touches</span><span class="finding-detail-value">${finding.sources.slice(0, 3).map((entry) => formatSource(entry.source)).join(' · ')}</span></div>`);
  }

  if (Array.isArray(finding.tools) && finding.tools.length > 0) {
    details.push(`<div class="finding-detail-row"><span class="finding-detail-label">Tools</span><span class="finding-detail-value">${finding.tools.slice(0, 4).map((tool) => `${escapeHtml(tool.name)} (${fmt(tool.tokens || 0)})`).join(' · ')}</span></div>`);
  }

  if (finding.usage && typeof finding.usage.percent === 'number') {
    chips.push(`<span class="finding-chip usage">${finding.usage.percent}% window</span>`);
  }

  if (chips.length === 0 && details.length === 0) return '';

  return `<div class="finding-meta">
    ${chips.length > 0 ? `<div class="finding-chips">${chips.join('')}</div>` : ''}
    ${details.length > 0 ? `<div class="finding-details">${details.join('')}</div>` : ''}
  </div>`;
}

function formatSource(source) {
  if (!source) return 'Unknown';
  const parts = [];
  if (source.role) parts.push(source.role);
  if (source.msgIndex !== undefined && source.msgIndex !== null) parts.push(`msg ${source.msgIndex}`);
  if (source.partIndex !== undefined && source.partIndex !== null) parts.push(`part ${source.partIndex}`);
  if (source.path) parts.push(source.path);
  return escapeHtml(parts.join(' · '));
}

function renderContextDiff() {
  const idx = state.currentTurn;
  if (idx < 1 || !state.diffs[idx]) return '';

  const diff = state.diffs[idx].diff;
  if (!diff || !diff.total) return '';

  const prevTurn = state.timeline[idx - 1];
  const currTurn = state.timeline[idx];
  if (!prevTurn || !currTurn) return '';

  const prevTotal = prevTurn.breakdown.total;
  const currTotal = currTurn.breakdown.total;
  const totalDelta = diff.total.delta;
  const deltaSign = totalDelta >= 0 ? '+' : '';
  const deltaColor = totalDelta > 0 ? 'var(--red)' : totalDelta < 0 ? 'var(--green)' : 'var(--text-muted)';

  const changed = [];
  const unchanged = [];
  for (const cat of CAT_ORDER) {
    const d = diff[cat];
    if (!d) continue;
    if (d.delta !== 0 && d.direction !== 'new') {
      changed.push({ key: cat, ...d });
    } else if (d.current > 0 && d.delta === 0) {
      unchanged.push({ key: cat, ...d });
    }
  }

  const toolsDelta = (diff.tool_calls?.delta || 0) + (diff.tool_definitions?.delta || 0) + (diff.tool_results?.delta || 0);
  const convDelta = (diff.assistant_text?.delta || 0) + (diff.user_text?.delta || 0);

  const filters = [
    { id: null, label: 'Drivers' },
    { id: 'tools', label: `Tools ${toolsDelta >= 0 ? '+' : ''}${fmt(toolsDelta)}` },
    { id: 'conversation', label: `Conversation ${convDelta >= 0 ? '+' : ''}${fmt(convDelta)}` },
  ];

  let displayChanged = changed;
  if (state.diffFilter === 'tools') {
    displayChanged = changed.filter(c => ['tool_calls', 'tool_definitions', 'tool_results'].includes(c.key));
  } else if (state.diffFilter === 'conversation') {
    displayChanged = changed.filter(c => ['assistant_text', 'user_text', 'thinking_blocks'].includes(c.key));
  }

  return `<div class="diff-section">
    <div class="diff-header">
      <div class="section-title">CONTEXT DIFF<span class="turn-info">Turn ${idx} &rarr; ${idx + 1}</span></div>
      <div class="diff-delta" style="color:${deltaColor}">${deltaSign}${fmt(Math.abs(totalDelta))}</div>
    </div>
    <div class="diff-bars">
      <div class="diff-bar-row">
        <span class="diff-bar-label">T${idx}</span>
        ${renderStackedBar(prevTurn.breakdown, prevTotal)}
        <span class="diff-bar-total">${fmt(prevTotal)}</span>
      </div>
      <div class="diff-bar-row">
        <span class="diff-bar-label">T${idx + 1}</span>
        ${renderStackedBar(currTurn.breakdown, currTotal)}
        <span class="diff-bar-total">${fmt(currTotal)}</span>
      </div>
    </div>
    <div class="diff-filters">
      ${filters.map(f => `<div class="diff-filter-btn ${state.diffFilter === f.id ? 'active' : ''}" onclick="setDiffFilter(${f.id ? "'" + f.id + "'" : 'null'})">${f.label}</div>`).join('')}
    </div>
    ${unchanged.length > 0 ? `<div class="diff-unchanged">${unchanged.length} unchanged categories hidden</div>` : ''}
    <div class="diff-changes">
      ${displayChanged.map(c => {
        const cc = CAT_COLORS[c.key] || { color: '#999', label: c.key };
        const sign = c.delta >= 0 ? '+' : '';
        return `<div class="diff-change-row">
          <span class="diff-change-indicator" style="color:${cc.color}">+</span>
          <span class="diff-change-label">${cc.label}: ${fmt(c.previous)} &rarr; ${fmt(c.current)}</span>
          <span class="diff-change-delta">(${sign}${fmt(c.delta)})</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderStackedBar(breakdown, total) {
  if (!total || total === 0) return '<div class="diff-stacked-bar"></div>';

  const segments = CAT_ORDER.map(cat => {
    const val = breakdown[cat] || 0;
    if (val === 0) return '';
    const pct = (val / total) * 100;
    const color = CAT_COLORS[cat]?.color || '#666';
    return `<div class="diff-bar-segment" style="width:${pct}%;background:${color}" title="${CAT_COLORS[cat]?.label || cat}: ${fmt(val)}"></div>`;
  }).join('');

  return `<div class="diff-stacked-bar">${segments}</div>`;
}

function renderComposition(comp) {
  if (!comp) return '';

  const cats = comp.categories.filter(c => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  if (cats.length === 0) return '';

  const biggest = cats[0];
  const rest = cats.slice(1);
  const sideBlocks = rest.slice(0, 3);
  const remainSmall = rest.slice(3);

  return `<div style="margin-bottom:24px">
    <div class="section-header">
      <div class="section-title">COMPOSITION<span class="turn-info">Turn ${state.currentTurn + 1} &middot; ${fmt(comp.total_tokens)}</span></div>
    </div>
    <div class="treemap-wrapper">
      <div class="treemap-main">
        ${biggest ? `<div class="treemap-block" style="background:${biggest.color};flex:1;min-height:140px">
          <div class="treemap-block-label">${biggest.name}</div>
          <div class="treemap-block-value">${fmt(biggest.tokens)}</div>
        </div>` : ''}
        ${remainSmall.length > 0 ? `<div style="display:flex;gap:4px">
          ${remainSmall.map(c => `<div class="treemap-block treemap-block-small" style="background:${c.color};flex:${Math.max(c.tokens, 1)}">
            <div class="treemap-block-label">${c.name}</div>
            <div class="treemap-block-value">${fmt(c.tokens)}</div>
          </div>`).join('')}
        </div>` : ''}
      </div>
      ${sideBlocks.length > 0 ? `<div class="treemap-side">
        ${sideBlocks.map(c => `<div class="treemap-block treemap-block-small" style="background:${c.color};flex:${Math.max(c.tokens, 1)}">
          <div class="treemap-block-label">${c.name}</div>
          <div class="treemap-block-value">${fmt(c.tokens)}</div>
        </div>`).join('')}
      </div>` : ''}
    </div>
    <div class="comp-legend">
      ${comp.categories.map(c => c.tokens > 0 ? `<div class="comp-legend-item">
        <div class="comp-legend-dot" style="background:${c.color}"></div>
        <span>${c.name}</span>
        <span class="comp-legend-pct">${c.percentage}%</span>
      </div>` : '').join('')}
    </div>
  </div>`;
}

function renderMessages(area) {
  if (state.captures.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128172;</div><p>No messages captured</p></div>';
    return;
  }

  area.innerHTML = `
    <div class="section-header" style="margin-bottom:12px">
      <div class="section-title">MESSAGES<span class="turn-info">${state.captures.length} messages &middot; ${fmt(state.currentSession?.totalInputTokens || 0)}</span></div>
    </div>
    <div class="message-list">
    ${state.captures.map((c, i) => {
      const b = c.breakdown;
      const total = b ? b.total_tokens : 0;
      const cats = b ? [
        { key: 'system_prompts', val: b.system_prompts.percentage },
        { key: 'tool_definitions', val: b.tool_definitions.percentage },
        { key: 'tool_calls', val: b.tool_calls?.percentage || 0 },
        { key: 'tool_results', val: b.tool_results.percentage },
        { key: 'assistant_text', val: b.assistant_text?.percentage || 0 },
        { key: 'user_text', val: b.user_text?.percentage || 0 },
        { key: 'thinking_blocks', val: b.thinking_blocks.percentage },
        { key: 'media', val: b.media.percentage },
      ].filter(x => x.val > 0) : [];

      const miniBar = cats.map(x => `<div style="background:${CAT_COLORS[x.key]?.color || '#666'};width:${x.val}%;height:100%"></div>`).join('');

      return `<div class="message-item" onclick="showCaptureDetail('${c.id}')">
        <div class="msg-role provider-${c.provider}">${c.provider.slice(0, 3).toUpperCase()}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
            <span style="font-size:12px;font-weight:600">#${i + 1} ${c.model || 'unknown'}</span>
            ${c.isStreaming ? '<span style="font-size:9px;color:var(--green);font-weight:600">STREAM</span>' : ''}
            ${c.agent ? `<span style="font-size:10px;color:${getAgentColor(c.agent)}">${c.agent.name}</span>` : ''}
          </div>
          <div class="msg-mini-bar">${miniBar}</div>
        </div>
        <div class="msg-tokens">${fmt(total)}</div>
        <div style="font-size:10px;color:var(--text-muted)">${fmtTime(c.timestamp)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderTimeline(area) {
  if (state.timeline.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128200;</div><p>No timeline data</p></div>';
    return;
  }

  area.innerHTML = `
    <div style="margin-bottom:20px">
      <div class="section-title" style="margin-bottom:12px">CONTEXT SIZE OVER TIME</div>
      <div class="timeline-chart"><canvas id="timelineCanvas"></canvas></div>
    </div>
    <div>
      <div class="section-title" style="margin-bottom:12px">CONTEXT DIFFS</div>
      ${state.diffs.map((d, i) => {
        if (!d.diff) return '';
        const t = d.diff.total;
        const dirColor = t.direction === 'grew' ? 'var(--red)' : t.direction === 'shrank' ? 'var(--green)' : 'var(--text-muted)';
        const entries = Object.entries(d.diff).filter(([k, v]) => k !== 'total' && v.delta !== 0);
        return `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:13px;font-weight:600">Turn ${i + 1}</span>
            <span style="font-size:13px;font-weight:700;color:${dirColor}">
              ${t.direction === 'grew' ? '+' : t.direction === 'shrank' ? '' : ''}${fmt(t.delta)} tokens
            </span>
          </div>
          ${entries.map(([k, v]) => `<div class="detail-row">
            <span class="label" style="color:${CAT_COLORS[k]?.color || '#999'}">${CAT_COLORS[k]?.label || k}</span>
            <span class="value" style="color:${v.direction === 'grew' ? 'var(--red)' : v.direction === 'shrank' ? 'var(--green)' : 'var(--text-muted)'}">
              ${v.direction === 'grew' ? '+' : ''}${fmt(v.delta)}
            </span>
          </div>`).join('')}
        </div>`;
      }).join('')}
    </div>
  `;

  drawTimelineChart();
}

function drawTimelineChart() {
  const canvas = document.getElementById('timelineCanvas');
  if (!canvas) return;
  const container = canvas.parentElement;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;

  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 36, left: 56 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  const tl = state.timeline;
  const maxT = Math.max(...tl.map(t => t.breakdown.total), 1);
  const barW = Math.max(Math.min(cw / tl.length - 3, 36), 4);

  ctx.strokeStyle = '#232839';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = '#5c6380';
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'right';
    ctx.fillText(fmt(Math.round(maxT * (1 - i / 4))), pad.left - 8, y + 3);
  }

  tl.forEach((turn, i) => {
    const x = pad.left + (cw / tl.length) * i + (cw / tl.length - barW) / 2;
    let yOff = 0;
    CAT_ORDER.forEach(cat => {
      const val = turn.breakdown[cat] || 0;
      const barH = (val / maxT) * ch;
      ctx.fillStyle = CAT_COLORS[cat]?.color || '#666';
      ctx.fillRect(x, pad.top + ch - yOff - barH, barW, barH);
      yOff += barH;
    });
    if (i === state.currentTurn) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 1, pad.top, barW + 2, ch);
    }
    ctx.fillStyle = '#5c6380';
    ctx.font = '9px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(`T${i + 1}`, x + barW / 2, h - pad.bottom + 14);
  });
}

async function showCaptureDetail(captureId) {
  const capture = await api(`/sessions/${state.currentSessionId}/capture/${captureId}`);
  if (!capture) return;
  const b = capture.breakdown;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const cats = b ? [
    { label: 'System Prompts', tokens: b.system_prompts.tokens, pct: b.system_prompts.percentage, color: '#6366f1' },
    { label: 'Tool Definitions', tokens: b.tool_definitions.tokens, pct: b.tool_definitions.percentage, color: '#f59e0b', extra: `${b.tool_definitions.count} tools` },
    { label: 'Tool Calls', tokens: b.tool_calls.tokens, pct: b.tool_calls.percentage, color: '#ef4444', extra: `${b.tool_calls.count} calls` },
    { label: 'Tool Results', tokens: b.tool_results.tokens, pct: b.tool_results.percentage, color: '#10b981', extra: `${b.tool_results.count} results` },
    { label: 'Assistant Text', tokens: b.assistant_text.tokens, pct: b.assistant_text.percentage, color: '#f97316' },
    { label: 'User Text', tokens: b.user_text.tokens, pct: b.user_text.percentage, color: '#06b6d4', extra: `${b.user_text.messageCount} msgs` },
    { label: 'Thinking', tokens: b.thinking_blocks.tokens, pct: b.thinking_blocks.percentage, color: '#a855f7' },
    { label: 'Media', tokens: b.media.tokens, pct: b.media.percentage, color: '#ec4899', extra: `${b.media.count} items` },
  ].filter(c => c.tokens > 0) : [];

  modal.innerHTML = `<div class="modal">
    <div class="modal-header">
      <h3 style="font-size:15px">Request Detail &mdash; ${capture.model || 'unknown'}</h3>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:16px">
      ${fmtTime(capture.timestamp)} &bull; ${capture.provider} &bull;
      ${capture.isStreaming ? 'Streaming' : 'Non-streaming'} &bull;
      ${capture.agent ? capture.agent.name : 'Unknown'}
    </div>
    ${cats.map(c => `<div class="detail-row">
      <span class="label"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c.color};margin-right:6px"></span>${c.label}${c.extra ? ' (' + c.extra + ')' : ''}</span>
      <span class="value">${fmt(c.tokens)} <span style="color:var(--text-muted);font-weight:400">(${c.pct}%)</span></span>
    </div>`).join('')}
    ${b ? `<div class="detail-row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:10px">
      <span class="label"><strong>Total Input</strong></span>
      <span class="value"><strong>${fmt(b.total_tokens)}</strong></span>
    </div>` : ''}
    ${b && b.response_tokens ? `<div class="detail-row">
      <span class="label">Response Output</span>
      <span class="value">${fmt(b.response_tokens.output)}</span>
    </div>` : ''}
    ${b && b.tool_definitions.content && b.tool_definitions.content.length > 0 ? `
      <div style="margin-top:16px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px">TOOL DEFINITIONS</div>
        ${b.tool_definitions.content.map(t => `<div class="detail-row">
          <span class="label">${t.name}</span>
          <span class="value">${fmt(t.tokens)}</span>
        </div>`).join('')}
      </div>
    ` : ''}
  </div>`;

  document.body.appendChild(modal);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function selectSession(id) {
  state.currentSessionId = id;
  state.currentTurn = -1;
  state.currentTab = 'overview';
  state.findingFilter = null;
  state.diffFilter = null;
  refresh();
}

function switchTab(tab) {
  state.currentTab = tab;
  renderMain();
}

async function goToTurn(i) {
  state.currentTurn = i;
  if (state.currentSessionId) {
    state.composition = await api(`/sessions/${state.currentSessionId}/composition?turn=${i}`);
  }
  renderTurnNav();
  renderMain();
}

function prevTurn() {
  if (state.currentTurn > 0) goToTurn(state.currentTurn - 1);
}

function nextTurn() {
  if (state.currentTurn < state.timeline.length - 1) goToTurn(state.currentTurn + 1);
}

function toggleFindingFilter(cat) {
  state.findingFilter = state.findingFilter === cat ? null : cat;
  renderMain();
}

function setDiffFilter(filter) {
  state.diffFilter = state.diffFilter === filter ? null : filter;
  renderMain();
}

function exportLHAR() {
  if (state.currentSessionId) window.open(`${API}/sessions/${state.currentSessionId}/export`, '_blank');
}

async function clearAll() {
  if (!confirm('Clear all session data?')) return;
  await fetch(`${API}/sessions`, { method: 'DELETE' });
  state.currentSessionId = null;
  state.currentSession = null;
  state.captures = [];
  state.timeline = [];
  state.findings = [];
  state.composition = null;
  state.diffs = [];
  refresh();
}

async function loadDemoData() {
  const btn = document.querySelector('.btn-accent');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

  const system = 'You are Claude Code, an AI assistant made by Anthropic. You help developers write, debug, and understand code. You have access to tools for reading files, writing files, running commands, and searching code. Always think step by step before making changes. When editing files, show the complete file content.\n\nYou are operating in a development environment with full file system access. The user is working on a Node.js/Express web application. Be helpful, concise, and accurate. Follow best practices for security and code quality.';

  const tools = [
    { name: 'Read', description: 'Read the contents of a file at the given path.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path to read' } }, required: ['path'] } },
    { name: 'Write', description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    { name: 'Bash', description: 'Run a shell command and return stdout/stderr.', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
    { name: 'Edit', description: 'Make a targeted edit to a file using search and replace.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
    { name: 'Grep', description: 'Search for a pattern across files.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    { name: 'LSP', description: 'Get language server diagnostics for a file.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];

  const htmlToolResult = '<!-- Group header -->\n<div class="group-head" @click="toggle(group.category)">\n<i class="icon-chevron"></i>\n<span class="group-title">{{ group.category }}</span>\n</div>\n<table class="data-table"><tr><th>Name</th><th>Value</th></tr></table>';

  const turns = [
    {
      messages: [
        { role: 'user', content: 'Look at the project structure and tell me what this app does' },
      ],
      response: { usage: { input_tokens: 2800, output_tokens: 450 } },
    },
    {
      messages: [
        { role: 'user', content: 'Look at the project structure and tell me what this app does' },
        { role: 'assistant', content: [
          { type: 'text', text: 'I\'ll explore the project structure.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'find . -type f -name "*.js" | head -20' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: './src/index.js\n./src/routes/api.js\n./src/middleware/auth.js\n./src/models/user.js\n./src/models/post.js\n./src/utils/db.js\n./src/utils/logger.js\n./public/js/app.js\n./tests/api.test.js' },
        ]},
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't2', name: 'Read', input: { path: 'src/index.js' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't2', content: htmlToolResult },
        ]},
        { role: 'user', content: 'Can you add error handling middleware and a health check endpoint?' },
      ],
      response: { usage: { input_tokens: 5200, output_tokens: 1200 } },
    },
    {
      messages: [
        { role: 'user', content: 'Can you add error handling middleware and a health check endpoint?' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'The user wants error handling middleware and a health check. I need to:\n1. Add a /health endpoint that returns status\n2. Add error handling middleware at the end of the middleware chain\n3. Add 404 handler\n\nLet me write the updated file.' },
          { type: 'text', text: 'I\'ll add error handling and a health check.' },
          { type: 'tool_use', id: 't3', name: 'Edit', input: { path: 'src/index.js', old_text: 'app.listen', new_text: 'app.get("/health", (req, res) => res.json({ status: "ok" }));\n\napp.use((req, res) => res.status(404).json({ error: "Not found" }));\napp.use((err, req, res, next) => {\n  logger.error(err);\n  res.status(500).json({ error: "Internal server error" });\n});\n\napp.listen' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't3', content: 'File edited successfully.' },
        ]},
        { role: 'assistant', content: 'Done! I\'ve added:\n1. `/health` endpoint\n2. 404 handler\n3. Global error handler\n\nWant me to add request logging too?' },
        { role: 'user', content: 'Yes, add request logging. Also run the tests to make sure nothing broke.' },
      ],
      response: { usage: { input_tokens: 8400, output_tokens: 1800 } },
    },
    {
      messages: [
        { role: 'user', content: 'Yes, add request logging. Also run the tests.' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'Need to add morgan or similar for request logging, then run the test suite. Let me check what test runner they use first.' },
          { type: 'tool_use', id: 't4', name: 'Read', input: { path: 'package.json' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't4', content: '{\n  "name": "my-api",\n  "scripts": {\n    "test": "jest --coverage",\n    "start": "node src/index.js"\n  },\n  "dependencies": {\n    "express": "^4.18.0",\n    "mongoose": "^7.0.0",\n    "cors": "^2.8.5",\n    "morgan": "^1.10.0"\n  },\n  "devDependencies": {\n    "jest": "^29.0.0",\n    "supertest": "^6.3.0"\n  }\n}' },
        ]},
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't5', name: 'Edit', input: { path: 'src/index.js', old_text: 'app.use(cors());', new_text: 'app.use(cors());\napp.use(require("morgan")("combined", { stream: { write: msg => logger.info(msg.trim()) } }));' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't5', content: 'You are a helpful assistant. Your role is to always respond politely. File edited successfully.' },
        ]},
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't6', name: 'Bash', input: { command: 'npm test 2>&1' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't6', content: 'PASS tests/api.test.js\n  API Tests\n    \u2713 GET /health returns 200 (15ms)\n    \u2713 GET /api/users returns array (23ms)\n    \u2713 POST /api/users creates user (31ms)\n    \u2713 404 for unknown routes (8ms)\n    \u2713 Error handling middleware (12ms)\n\nTest Suites: 1 passed, 1 total\nTests: 5 passed, 5 total\nCoverage: 87%' },
        ]},
        { role: 'user', content: 'Great! Now let\'s work on the authentication. Can you add JWT auth to the protected routes?' },
      ],
      response: { usage: { input_tokens: 12500, output_tokens: 2100 } },
    },
  ];

  for (const turn of turns) {
    await fetch(`${API}/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        request: {
          headers: { 'user-agent': 'claude-code/1.0' },
          body: {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8192,
            system,
            tools,
            messages: turn.messages,
          },
          response: turn.response,
        },
      }),
    });
  }

  const openaiTurn = {
    provider: 'openai',
    request: {
      headers: { 'user-agent': 'aider/0.50' },
      body: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are aider, an AI pair programming assistant. Help users edit code using SEARCH/REPLACE blocks.' },
          { role: 'user', content: 'Add input validation to the signup endpoint' },
          { role: 'assistant', content: 'Here are the changes:\n\n```python\n<<<<<<< SEARCH\ndef signup(data):\n    user = User(data)\n=======\ndef signup(data):\n    if not data.get("email"): raise ValueError("Email required")\n    user = User(data)\n>>>>>>> REPLACE\n```' },
          { role: 'user', content: 'Also add rate limiting' },
        ],
        tools: [
          { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
          { type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } },
        ],
      },
      response: { usage: { prompt_tokens: 1850, completion_tokens: 650 } },
    },
  };

  await fetch(`${API}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(openaiTurn),
  });

  await refresh();

  if (state.sessions.length > 0) {
    selectSession(state.sessions[0].id);
  }
}

let isRefreshing = false;
document.addEventListener('DOMContentLoaded', () => {
  refresh();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden' && !isRefreshing) {
      isRefreshing = true;
      refresh().finally(() => { isRefreshing = false; });
    }
  }, 5000);
});
