const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CONTEXT_REVIEW_DISABLE_PERSISTENCE = '1';

const { BackgroundAnalysisScheduler, resolveDaysList } = require('../src/analysis/background');

function throwingStorage() {
  return {
    getSessions() { throw new Error('boom'); },
    getSessionCaptures() { return []; },
    getSession() { return null; },
  };
}

function emptyStorage() {
  return {
    getSessions() { return []; },
    getSessionCaptures() { return []; },
    getSession() { return null; },
  };
}

test('scheduler isolates per-window errors and keeps serving healthy windows', () => {
  const scheduler = new BackgroundAnalysisScheduler(throwingStorage(), { intervalMs: 60000, daysList: [7] });
  const result = scheduler.refreshDays([7]);
  assert.equal(result.skipped, false);
  assert.equal(result.succeeded, 0);
  assert.equal(scheduler.refreshErrorsTotal, 1);
  assert.ok(scheduler.lastError);
  assert.match(scheduler.lastError.message, /boom/);
  scheduler.stop();
});

test('scheduler records successful refresh metadata', () => {
  const scheduler = new BackgroundAnalysisScheduler(emptyStorage(), { intervalMs: 60000, daysList: [7] });
  const result = scheduler.refreshDays([7]);
  assert.equal(result.succeeded, 1);
  assert.ok(scheduler.lastRunAt);
  const entry = scheduler.getReportSummaryEntry(7);
  assert.ok(entry);
  assert.ok(entry.cacheAgeMs >= 0);
  scheduler.stop();
});

test('scheduler skips overlapping refreshes', () => {
  const scheduler = new BackgroundAnalysisScheduler(emptyStorage(), { intervalMs: 60000 });
  scheduler.refreshing = true;
  const result = scheduler.refreshDays([7]);
  assert.equal(result.skipped, true);
  scheduler.refreshing = false;
  scheduler.stop();
});

test('resolveDaysList parses env windows with fallback and cap', () => {
  assert.deepEqual(resolveDaysList(undefined), [7]);
  assert.deepEqual(resolveDaysList(''), [7]);
  assert.deepEqual(resolveDaysList('7,14,30'), [7, 14, 30]);
  assert.deepEqual(resolveDaysList('14,14,7'), [14, 7]);
  assert.deepEqual(resolveDaysList('0,-3,abc,30'), [30]);
  assert.deepEqual(resolveDaysList('1,2,3,4,5'), [1, 2, 3, 4]);
  assert.deepEqual(resolveDaysList('garbage'), [7]);
});

test('scheduler honors explicit daysList and multi-window refresh', () => {
  const scheduler = new BackgroundAnalysisScheduler(emptyStorage(), { intervalMs: 60000, daysList: [7, 14] });
  assert.deepEqual(scheduler.daysList, [7, 14]);
  const result = scheduler.refreshDays([7, 14]);
  assert.equal(result.succeeded, 2);
  assert.ok(scheduler.getReportSummaryEntry(14));
  scheduler.stop();
});

test('storage close stops the maintenance scheduler without throwing', () => {
  const { SessionStorage } = require('../src/storage/storage');
  const storage = new SessionStorage({ persistenceDisabled: true });
  assert.equal(typeof storage.close, 'function');
  storage.close();
  storage.close();
});
