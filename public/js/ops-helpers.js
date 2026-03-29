(function initOpsHelpers(globalScope) {
  function deriveOpsAlerts(opsSummary) {
    if (!opsSummary || !opsSummary.storage) return [];
    const alerts = [];
    const storageHealth = opsSummary.health?.storage || 'unknown';
    if (storageHealth !== 'healthy') {
      alerts.push({
        severity: 'critical',
        title: 'Storage Degraded',
        text: opsSummary.storage?.eventLog?.integrity?.reason || 'Storage health endpoint reports degraded mode.',
      });
    }

    const replayBench = opsSummary.storage?.benchmarks?.latest?.storageReplay;
    if (replayBench && replayBench.pass === false) {
      alerts.push({
        severity: 'warning',
        title: 'Replay Benchmark Failed',
        text: `Replay ${replayBench.replayMs}ms exceeds threshold ${replayBench.maxReplayMs}ms.`,
      });
    }

    const queryBench = opsSummary.storage?.benchmarks?.latest?.queryPerformance;
    if (queryBench && queryBench.pass === false) {
      alerts.push({
        severity: 'warning',
        title: 'Query Benchmark Failed',
        text: `Filter ${queryBench.timings?.filterMs}ms, report ${queryBench.timings?.reportMs}ms exceeded thresholds.`,
      });
    }

    const apiSlo = opsSummary.storage?.benchmarks?.latest?.apiSlo;
    if (apiSlo && apiSlo.pass === false) {
      alerts.push({
        severity: 'warning',
        title: 'API SLO Breach',
        text: `p95 sessions ${apiSlo.p95?.sessions}ms or report ${apiSlo.p95?.report}ms over threshold.`,
      });
    }

    return alerts;
  }

  function resolveArtifactPayload(opsSummary, type) {
    const latest = opsSummary?.storage?.benchmarks?.latest || {};
    if (type === 'storage-status') {
      return { payload: opsSummary?.storage || null, filename: 'storage-status.json' };
    }
    if (type === 'storage-benchmark') {
      return { payload: latest.storageReplay || null, filename: 'storage-benchmark.json' };
    }
    if (type === 'query-benchmark') {
      return { payload: latest.queryPerformance || null, filename: 'query-benchmark.json' };
    }
    if (type === 'api-slo') {
      return { payload: latest.apiSlo || null, filename: 'api-slo.json' };
    }
    return { payload: null, filename: `${type}.json` };
  }

  const api = { deriveOpsAlerts, resolveArtifactPayload };
  globalScope.ContextReviewOpsHelpers = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
