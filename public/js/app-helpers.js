/* Context Review dashboard pure helpers (no DOM): health scoring, context
 * windows, and refresh-failure detection. Loaded before app.js; also
 * required by node tests via module.exports. */
(function initAppHelpers(globalScope) {
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

  function isRefreshFailure({ stats, sessions, reportSummary }) {
    // The dashboard treats unreachable-backend as all core fetches failing.
    // An empty-but-reachable backend still returns objects (possibly []).
    return stats === null && sessions === null && reportSummary === null;
  }

  const api = {
    getContextWindow,
    computeHealth,
    healthColor,
    healthClass,
    healthLabel,
    isRefreshFailure,
  };
  globalScope.ContextReviewAppHelpers = api;
  globalScope.getContextWindow = getContextWindow;
  globalScope.computeHealth = computeHealth;
  globalScope.healthColor = healthColor;
  globalScope.healthClass = healthClass;
  globalScope.healthLabel = healthLabel;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
