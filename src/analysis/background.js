const { buildReportsSummary, buildCISummary } = require('./session-analysis');

class BackgroundAnalysisScheduler {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.intervalMs = Number(options.intervalMs || process.env.ANALYSIS_INTERVAL_MS || 15000);
    this.daysList = Array.isArray(options.daysList) && options.daysList.length > 0 ? options.daysList : [7];
    this.timer = null;
    this.reportCache = new Map();
    this.ciCache = new Map();
    this.lastRunAt = null;
  }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  refresh() {
    this.refreshDays(this.daysList);
  }

  refreshDays(daysList) {
    const now = Date.now();
    const uniqueDays = [...new Set((Array.isArray(daysList) ? daysList : []).map((d) => Number(d)).filter((d) => Number.isFinite(d) && d > 0))];
    const targets = uniqueDays.length > 0 ? uniqueDays : this.daysList;
    for (const days of targets) {
      const report = buildReportsSummary(this.storage, days);
      const ci = buildCISummary(this.storage, days);
      this.reportCache.set(days, { data: report, refreshedAt: now, cacheAgeMs: 0 });
      this.ciCache.set(days, { data: ci, refreshedAt: now, cacheAgeMs: 0 });
    }
    this.lastRunAt = now;
  }

  getReportSummary(days) {
    return this.getReportSummaryEntry(days)?.data || null;
  }

  getCISummary(days) {
    return this.getCISummaryEntry(days)?.data || null;
  }

  getReportSummaryEntry(days) {
    const entry = this.reportCache.get(days) || null;
    if (!entry) return null;
    return {
      ...entry,
      cacheAgeMs: Math.max(0, Date.now() - entry.refreshedAt),
    };
  }

  getCISummaryEntry(days) {
    const entry = this.ciCache.get(days) || null;
    if (!entry) return null;
    return {
      ...entry,
      cacheAgeMs: Math.max(0, Date.now() - entry.refreshedAt),
    };
  }
}

module.exports = { BackgroundAnalysisScheduler };
