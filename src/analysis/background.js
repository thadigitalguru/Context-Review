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
    for (const days of this.daysList) {
      const report = buildReportsSummary(this.storage, days);
      const ci = buildCISummary(this.storage, days);
      this.reportCache.set(days, { data: report, refreshedAt: Date.now() });
      this.ciCache.set(days, { data: ci, refreshedAt: Date.now() });
    }
    this.lastRunAt = Date.now();
  }

  getReportSummary(days) {
    return this.reportCache.get(days)?.data || null;
  }

  getCISummary(days) {
    return this.ciCache.get(days)?.data || null;
  }
}

module.exports = { BackgroundAnalysisScheduler };
