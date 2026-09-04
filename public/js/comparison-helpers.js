(function initComparisonHelpers(globalScope) {
  const STORAGE_KEY = 'context-review-comparison-presets';

  function buildComparisonFilterFromRow(args) {
    const now = Number.isFinite(Number(args.now)) ? Number(args.now) : Date.now();
    const windowDays = Number.isFinite(Number(args.windowDays)) ? Math.max(1, Number(args.windowDays)) : 7;
    const from = now - (windowDays * 24 * 60 * 60 * 1000);
    const groupBy = normalizeGroupBy(args.groupBy);
    const group = String(args.group || '').trim();
    const filter = {
      active: true,
      groupBy,
      group,
      from,
      to: now,
      windowDays,
      sessionIds: Array.isArray(args.sessionIds) ? args.sessionIds.slice(0, 200) : [],
    };
    if (groupBy === 'project') filter.project = group;
    if (groupBy === 'user') filter.user = group;
    if (groupBy === 'model') filter.model = group;
    if (groupBy === 'provider') filter.provider = group;
    return filter;
  }

  function serializeComparisonFilter(filter) {
    const params = new URLSearchParams();
    if (!filter || filter.active !== true) return params;
    params.set('cf_active', '1');
    params.set('cf_groupBy', String(filter.groupBy || 'project'));
    params.set('cf_group', String(filter.group || ''));
    if (Number.isFinite(Number(filter.from))) params.set('cf_from', String(Math.floor(Number(filter.from))));
    if (Number.isFinite(Number(filter.to))) params.set('cf_to', String(Math.floor(Number(filter.to))));
    if (Number.isFinite(Number(filter.windowDays))) params.set('cf_days', String(Math.floor(Number(filter.windowDays))));
    if (Array.isArray(filter.sessionIds) && filter.sessionIds.length > 0) {
      params.set('cf_ids', filter.sessionIds.slice(0, 200).join(','));
    }
    return params;
  }

  function parseComparisonFilter(search) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    if (params.get('cf_active') !== '1') return null;
    const groupBy = normalizeGroupBy(params.get('cf_groupBy') || 'project');
    const group = String(params.get('cf_group') || '').trim();
    if (!group) return null;
    const from = Number(params.get('cf_from'));
    const to = Number(params.get('cf_to'));
    const windowDays = Number(params.get('cf_days'));
    const sessionIds = String(params.get('cf_ids') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    const filter = {
      active: true,
      groupBy,
      group,
      from: Number.isFinite(from) ? from : null,
      to: Number.isFinite(to) ? to : null,
      windowDays: Number.isFinite(windowDays) ? windowDays : 7,
      sessionIds,
    };
    if (groupBy === 'project') filter.project = group;
    if (groupBy === 'user') filter.user = group;
    if (groupBy === 'model') filter.model = group;
    if (groupBy === 'provider') filter.provider = group;
    return filter;
  }

  function buildSessionsApiPath(filter) {
    if (!filter || filter.active !== true) return '/sessions';
    const params = new URLSearchParams();
    if (filter.project) params.set('project', filter.project);
    if (filter.user) params.set('user', filter.user);
    if (filter.model) params.set('model', filter.model);
    if (filter.provider) params.set('provider', filter.provider);
    if (Number.isFinite(Number(filter.from))) params.set('from', String(Math.floor(Number(filter.from))));
    if (Number.isFinite(Number(filter.to))) params.set('to', String(Math.floor(Number(filter.to))));
    const suffix = params.toString();
    return suffix ? `/sessions?${suffix}` : '/sessions';
  }

  function serializeComparisonConfig(config) {
    const params = new URLSearchParams();
    if (!config || typeof config !== 'object') return params;
    if (Number.isFinite(Number(config.days))) params.set('cp_days', String(Math.max(1, Math.floor(Number(config.days)))));
    if (config.groupBy) params.set('cp_groupBy', normalizeGroupBy(config.groupBy));
    if (Number.isFinite(Number(config.limit))) params.set('cp_limit', String(Math.max(1, Math.min(25, Math.floor(Number(config.limit))))));
    if (Number.isFinite(Number(config.sessionIdsLimit))) params.set('cp_sessionIdsLimit', String(Math.max(1, Math.min(200, Math.floor(Number(config.sessionIdsLimit))))));
    return params;
  }

  function parseComparisonConfig(search) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const days = Number(params.get('cp_days'));
    const groupBy = params.get('cp_groupBy');
    const limit = Number(params.get('cp_limit'));
    const sessionIdsLimit = Number(params.get('cp_sessionIdsLimit'));
    const config = {};
    if (Number.isFinite(days) && days > 0) config.days = Math.max(1, Math.floor(days));
    if (groupBy) config.groupBy = normalizeGroupBy(groupBy);
    if (Number.isFinite(limit) && limit > 0) config.limit = Math.max(1, Math.min(25, Math.floor(limit)));
    if (Number.isFinite(sessionIdsLimit) && sessionIdsLimit > 0) config.sessionIdsLimit = Math.max(1, Math.min(200, Math.floor(sessionIdsLimit)));
    return config;
  }

  function clearComparisonConfigFromSearch(search) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    for (const key of [...params.keys()]) {
      if (key.startsWith('cp_')) params.delete(key);
    }
    const result = params.toString();
    return result ? `?${result}` : '';
  }

  function filterSessionsByIds(sessions, sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return sessions || [];
    const allow = new Set(sessionIds);
    return (sessions || []).filter((session) => allow.has(session.id));
  }

  function describeComparisonFilter(filter, options = {}) {
    if (!filter || filter.active !== true) return '';
    const window = Number.isFinite(Number(filter.windowDays)) ? `${Math.floor(Number(filter.windowDays))}d` : 'window';
    const scope = String(filter.groupBy || 'project');
    const group = String(filter.group || 'unknown');
    const base = `${scope}: ${group} (${window})`;
    const count = Number(options.sessionCount);
    if (Number.isFinite(count) && count >= 0) {
      return `${base} · ${count} session${count === 1 ? '' : 's'}`;
    }
    return base;
  }

  function clearComparisonFilterFromSearch(search) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    for (const key of [...params.keys()]) {
      if (key.startsWith('cf_')) params.delete(key);
    }
    const result = params.toString();
    return result ? `?${result}` : '';
  }

  function loadComparisonPresets(storage = getStorage()) {
    if (!storage) return [];
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(normalizeComparisonPreset).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveComparisonPresets(presets, storage = getStorage()) {
    if (!storage) return false;
    try {
      const next = Array.isArray(presets) ? presets.map(normalizeComparisonPreset).filter(Boolean).slice(0, 12) : [];
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  }

  function buildComparisonPreset(options = {}) {
    const now = Number.isFinite(Number(options.savedAt)) ? Number(options.savedAt) : Date.now();
    const config = normalizeComparisonConfig(options.config || options);
    const filter = options.filter && options.filter.active === true ? normalizeComparisonFilter(options.filter) : null;
    return normalizeComparisonPreset({
      id: String(options.id || `${config.groupBy || 'project'}-${config.days || 7}-${config.limit || 5}-${now}`),
      label: String(options.label || describePresetLabel(config, filter, options.label)),
      savedAt: now,
      config,
      filter,
    });
  }

  function upsertComparisonPreset(presets, preset) {
    const nextPreset = normalizeComparisonPreset(preset);
    if (!nextPreset) return Array.isArray(presets) ? presets : [];
    const next = Array.isArray(presets) ? presets.map(normalizeComparisonPreset).filter(Boolean) : [];
    const idx = next.findIndex((item) => item.id === nextPreset.id || item.label === nextPreset.label);
    if (idx >= 0) next[idx] = nextPreset;
    else next.unshift(nextPreset);
    return next.slice(0, 12);
  }

  function removeComparisonPreset(presets, presetId) {
    return (Array.isArray(presets) ? presets : []).filter((preset) => String(preset?.id || '') !== String(presetId || ''));
  }

  function normalizeComparisonPreset(preset) {
    if (!preset || typeof preset !== 'object') return null;
    const config = normalizeComparisonConfig(preset.config || preset);
    const filter = preset.filter && preset.filter.active === true ? normalizeComparisonFilter(preset.filter) : null;
    return {
      id: String(preset.id || `${config.groupBy || 'project'}-${config.days || 7}-${config.limit || 5}-${preset.savedAt || Date.now()}`),
      label: String(preset.label || describePresetLabel(config, filter, preset.label)),
      savedAt: Number.isFinite(Number(preset.savedAt)) ? Number(preset.savedAt) : Date.now(),
      config,
      filter,
    };
  }

  function normalizeComparisonConfig(config) {
    const next = {};
    if (Number.isFinite(Number(config?.days)) && Number(config.days) > 0) next.days = Math.max(1, Math.floor(Number(config.days)));
    if (config?.groupBy) next.groupBy = normalizeGroupBy(config.groupBy);
    if (Number.isFinite(Number(config?.limit)) && Number(config.limit) > 0) next.limit = Math.max(1, Math.min(25, Math.floor(Number(config.limit))));
    if (Number.isFinite(Number(config?.sessionIdsLimit)) && Number(config.sessionIdsLimit) > 0) next.sessionIdsLimit = Math.max(1, Math.min(200, Math.floor(Number(config.sessionIdsLimit))));
    return next;
  }

  function normalizeComparisonFilter(filter) {
    if (!filter || filter.active !== true) return null;
    const normalized = {
      active: true,
      groupBy: normalizeGroupBy(filter.groupBy),
      group: String(filter.group || '').trim(),
      from: Number.isFinite(Number(filter.from)) ? Math.floor(Number(filter.from)) : null,
      to: Number.isFinite(Number(filter.to)) ? Math.floor(Number(filter.to)) : null,
      windowDays: Number.isFinite(Number(filter.windowDays)) ? Math.max(1, Math.floor(Number(filter.windowDays))) : 7,
      sessionIds: Array.isArray(filter.sessionIds) ? filter.sessionIds.slice(0, 200).map((id) => String(id)).filter(Boolean) : [],
    };
    if (normalized.groupBy === 'project') normalized.project = normalized.group;
    if (normalized.groupBy === 'user') normalized.user = normalized.group;
    if (normalized.groupBy === 'model') normalized.model = normalized.group;
    if (normalized.groupBy === 'provider') normalized.provider = normalized.group;
    return normalized;
  }

  function describePresetLabel(config, filter, fallback) {
    if (fallback && String(fallback).trim()) return String(fallback).trim();
    const scope = filter?.active ? `${filter.groupBy}: ${filter.group}` : `${config.groupBy || 'project'} · ${config.days || 7}d`;
    return `${scope}`;
  }

  function normalizeGroupBy(groupBy) {
    const valid = new Set(['project', 'user', 'model', 'provider']);
    const requested = String(groupBy || 'project').toLowerCase();
    return valid.has(requested) ? requested : 'project';
  }

  const api = {
    STORAGE_KEY,
    buildComparisonFilterFromRow,
    serializeComparisonFilter,
    parseComparisonFilter,
    buildSessionsApiPath,
    filterSessionsByIds,
    describeComparisonFilter,
    clearComparisonFilterFromSearch,
    normalizeGroupBy,
    serializeComparisonConfig,
    parseComparisonConfig,
    clearComparisonConfigFromSearch,
    loadComparisonPresets,
    saveComparisonPresets,
    buildComparisonPreset,
    upsertComparisonPreset,
    removeComparisonPreset,
  };
  globalScope.ContextReviewComparisonHelpers = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
