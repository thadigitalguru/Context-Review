(function initBudgetHelpers(globalScope) {
  const STORAGE_KEY = 'context-review-budget-thresholds';

  function normalizeThresholds(input = {}, fallback = {}) {
    const defaults = {
      maxAvgInputTokensPerRequest: Number(fallback.maxAvgInputTokensPerRequest || 1500),
      maxAvgCostPerRequest: Number(fallback.maxAvgCostPerRequest || 0.05),
      maxTotalCostPerProject: Number(fallback.maxTotalCostPerProject || 1.0),
      maxSessionCost: Number(fallback.maxSessionCost || 0.25),
    };

    return {
      maxAvgInputTokensPerRequest: normalizeInteger(input.maxAvgInputTokensPerRequest, defaults.maxAvgInputTokensPerRequest),
      maxAvgCostPerRequest: normalizeFloat(input.maxAvgCostPerRequest, defaults.maxAvgCostPerRequest),
      maxTotalCostPerProject: normalizeFloat(input.maxTotalCostPerProject, defaults.maxTotalCostPerProject),
      maxSessionCost: normalizeFloat(input.maxSessionCost, defaults.maxSessionCost),
    };
  }

  function loadThresholds(storage = getStorage()) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return normalizeThresholds(parsed);
    } catch {
      return null;
    }
  }

  function saveThresholds(thresholds, storage = getStorage()) {
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalizeThresholds(thresholds)));
      return true;
    } catch {
      return false;
    }
  }

  function clearThresholds(storage = getStorage()) {
    if (!storage) return false;
    try {
      storage.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function buildBudgetView(budget, overrides = null) {
    if (!budget || !Array.isArray(budget.items)) {
      return null;
    }

    const thresholds = normalizeThresholds(overrides || budget.thresholds || {}, budget.thresholds || {});
    const items = budget.items.map((item) => {
      const alerts = [];
      if (item.avgInputTokensPerRequest > thresholds.maxAvgInputTokensPerRequest) {
        alerts.push({
          type: 'input_tokens',
          severity: 'warning',
          message: `Average input tokens/request is ${item.avgInputTokensPerRequest}, above ${thresholds.maxAvgInputTokensPerRequest}.`,
        });
      }
      if (item.avgCostPerRequest > thresholds.maxAvgCostPerRequest) {
        alerts.push({
          type: 'cost_per_request',
          severity: 'warning',
          message: `Average cost/request is $${item.avgCostPerRequest.toFixed(4)}, above $${thresholds.maxAvgCostPerRequest.toFixed(4)}.`,
        });
      }
      if (item.totalCost > thresholds.maxTotalCostPerProject) {
        alerts.push({
          type: 'total_cost',
          severity: 'high',
          message: `Total cost $${item.totalCost.toFixed(4)} exceeds $${thresholds.maxTotalCostPerProject.toFixed(4)} for this window.`,
        });
      }
      return {
        ...item,
        alerts,
        riskScore: alerts.length * 25 + (item.maxSessionCost > thresholds.maxSessionCost ? 15 : 0),
      };
    }).sort((a, b) => (b.riskScore - a.riskScore) || (b.totalCost - a.totalCost));

    const alerts = items.flatMap((item) => item.alerts.map((alert) => ({
      project: item.project,
      ...alert,
    })));

    return { thresholds, items, alerts };
  }

  function isUsingCustomThresholds(budget, thresholds) {
    const defaults = budget?.thresholds || {};
    if (!thresholds) return false;
    return Object.keys(thresholds).some((key) => Number(thresholds[key]) !== Number(defaults[key]));
  }

  // Compares stored server thresholds against browser-local ones so the UI
  // can surface a split-brain instead of silently preferring the server.
  // Returns null when there is nothing to resolve.
  function describeThresholdConflict(serverThresholds, localThresholds) {
    if (!serverThresholds || !localThresholds) return null;
    const fields = [
      'maxAvgInputTokensPerRequest',
      'maxAvgCostPerRequest',
      'maxTotalCostPerProject',
      'maxSessionCost',
    ].filter((key) => Number(serverThresholds[key]) !== Number(localThresholds[key]));
    if (fields.length === 0) return null;
    return {
      fields,
      message: `Browser-local settings differ from stored project settings (${fields.length} field${fields.length === 1 ? '' : 's'}).`,
    };
  }

  function buildBudgetExportPayload(options = {}) {
    const project = String(options.project || 'default');
    const thresholds = normalizeThresholds(options.thresholds || {});
    return {
      project,
      thresholds,
      updatedAt: options.updatedAt || null,
      source: options.source || 'storage',
      exportedAt: Date.now(),
      app: {
        name: 'Context Review',
        feature: 'budget-settings',
      },
    };
  }

  function buildBudgetShareText(payload) {
    const exportPayload = payload && payload.project ? payload : buildBudgetExportPayload(payload);
    return JSON.stringify(exportPayload, null, 2);
  }

  function parseBudgetShareText(text) {
    try {
      const parsed = typeof text === 'string' ? JSON.parse(text) : text;
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'Budget settings must be a JSON object.' };
      }
      const project = String(parsed.project || 'default').trim() || 'default';
      const thresholds = normalizeThresholds(parsed.thresholds || parsed);
      return {
        ok: true,
        project,
        thresholds,
        source: parsed.source || 'import',
        updatedAt: parsed.updatedAt || null,
      };
    } catch (err) {
      return { ok: false, error: err?.message || 'Invalid budget settings JSON.' };
    }
  }

  function normalizeInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(1, Math.floor(Number(fallback) || 1));
    return Math.floor(parsed);
  }

  function normalizeFloat(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return Number(fallback) || 0;
    return Math.round(parsed * 1000000) / 1000000;
  }

  function getStorage() {
    if (typeof globalScope.localStorage === 'undefined') return null;
    return globalScope.localStorage;
  }

  const api = {
    STORAGE_KEY,
    normalizeThresholds,
    loadThresholds,
    saveThresholds,
    clearThresholds,
    buildBudgetView,
    isUsingCustomThresholds,
    describeThresholdConflict,
    buildBudgetExportPayload,
    buildBudgetShareText,
    parseBudgetShareText,
  };

  globalScope.ContextReviewBudgetHelpers = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
