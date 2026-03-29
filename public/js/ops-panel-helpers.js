(function initOpsPanelHelpers(globalScope) {
  function buildOpsActionRequest(type) {
    if (type === 'maintenanceDry') {
      return { path: '/storage/maintenance/run', payload: { dryRun: true } };
    }
    if (type === 'maintenanceForce') {
      return { path: '/storage/maintenance/run', payload: { dryRun: false, force: true } };
    }
    if (type === 'compactDry') {
      return { path: '/storage/compact', payload: { dryRun: true } };
    }
    return { error: 'Unknown ops action' };
  }

  function buildOpsActionState(result) {
    if (result?._error) {
      return { loading: false, message: '', error: String(result._error), refreshNeeded: false };
    }
    if (!result) {
      return { loading: false, message: '', error: 'Action failed', refreshNeeded: false };
    }
    const reason = result.reason || (result.compacted ? 'completed' : 'no changes');
    return { loading: false, message: `Result: ${reason}`, error: '', refreshNeeded: true };
  }

  function resolveDownloadInstruction(opsSummary, type, resolver) {
    const resolved = resolver
      ? resolver(opsSummary, type)
      : { payload: null, filename: `${type}.json` };
    if (!resolved || !resolved.payload) {
      return { ok: false, error: `No data available for ${type}` };
    }
    return {
      ok: true,
      payload: resolved.payload,
      filename: resolved.filename || `${type}.json`,
    };
  }

  function triggerJsonDownload(payload, filename, deps = {}) {
    const BlobCtor = deps.BlobCtor || (typeof Blob !== 'undefined' ? Blob : null);
    const URLApi = deps.URLApi || (typeof URL !== 'undefined' ? URL : null);
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    if (!BlobCtor || !URLApi || !doc || !doc.createElement || !doc.body) {
      return { ok: false, error: 'Download unavailable in current environment' };
    }

    const blob = new BlobCtor([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URLApi.createObjectURL(blob);
    try {
      const a = doc.createElement('a');
      a.href = url;
      a.download = filename;
      doc.body.appendChild(a);
      if (typeof a.click === 'function') a.click();
      doc.body.removeChild(a);
      return { ok: true };
    } finally {
      URLApi.revokeObjectURL(url);
    }
  }

  const api = {
    buildOpsActionRequest,
    buildOpsActionState,
    resolveDownloadInstruction,
    triggerJsonDownload,
  };
  globalScope.ContextReviewOpsPanelHelpers = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
