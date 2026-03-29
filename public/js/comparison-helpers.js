(function initComparisonHelpers(globalScope) {
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

  function filterSessionsByIds(sessions, sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return sessions || [];
    const allow = new Set(sessionIds);
    return (sessions || []).filter((session) => allow.has(session.id));
  }

  function describeComparisonFilter(filter) {
    if (!filter || filter.active !== true) return '';
    const window = Number.isFinite(Number(filter.windowDays)) ? `${Math.floor(Number(filter.windowDays))}d` : 'window';
    const scope = String(filter.groupBy || 'project');
    const group = String(filter.group || 'unknown');
    return `${scope}: ${group} (${window})`;
  }

  function clearComparisonFilterFromSearch(search) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    for (const key of [...params.keys()]) {
      if (key.startsWith('cf_')) params.delete(key);
    }
    const result = params.toString();
    return result ? `?${result}` : '';
  }

  function normalizeGroupBy(groupBy) {
    const valid = new Set(['project', 'user', 'model', 'provider']);
    const requested = String(groupBy || 'project').toLowerCase();
    return valid.has(requested) ? requested : 'project';
  }

  const api = {
    buildComparisonFilterFromRow,
    serializeComparisonFilter,
    parseComparisonFilter,
    buildSessionsApiPath,
    filterSessionsByIds,
    describeComparisonFilter,
    clearComparisonFilterFromSearch,
    normalizeGroupBy,
  };
  globalScope.ContextReviewComparisonHelpers = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
