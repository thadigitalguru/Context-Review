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
    this.refreshing = false;
    this.lastError = null;
    this.refreshesTotal = 0;
    this.refreshErrorsTotal = 0;
  }

  start() {
    if (this.timer) return;
    try {
      this.refresh();
    } catch (err) {
      this.recordError(err);
    }
    this.timer = setInterval(() => {
      try {
        this.refresh();
      } catch (err) {
        this.recordError(err);
      }
    }, this.intervalMs);
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
    if (this.refreshing) return { skipped: true, reason: 'refresh_in_progress' };
    this.refreshing = true;
    try {
      const now = Date.now();
      const uniqueDays = [...new Set((Array.isArray(daysList) ? daysList : []).map((d) => Number(d)).filter((d) => Number.isFinite(d) && d > 0))];
      const targets = uniqueDays.length > 0 ? uniqueDays : this.daysList;
      let succeeded = 0;
      for (const days of targets) {
        try {
          const report = buildReportsSummary(this.storage, days);
          const ci = buildCISummary(this.storage, days);
          this.reportCache.set(days, { data: report, refreshedAt: now, cacheAgeMs: 0 });
          this.ciCache.set(days, { data: ci, refreshedAt: now, cacheAgeMs: 0 });
          succeeded += 1;
        } catch (err) {
          this.recordError(err);
        }
      }
      if (succeeded > 0) this.lastRunAt = now;
      this.refreshesTotal += 1;
      return { skipped: false, succeeded, attempted: targets.length };
    } finally {
      this.refreshing = false;
    }
  }

  recordError(err) {
    this.lastError = { message: err && err.message ? err.message : String(err), at: Date.now() };
    this.refreshErrorsTotal += 1;
    console.error(`Background analysis error: ${this.lastError.message}`);
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
