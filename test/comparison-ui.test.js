const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildComparisonFilterFromRow,
  serializeComparisonFilter,
  parseComparisonFilter,
  buildSessionsApiPath,
  filterSessionsByIds,
  clearComparisonFilterFromSearch,
} = require('../public/js/comparison-helpers.js');

test('buildComparisonFilterFromRow creates filter for project/user/model/provider with time window', () => {
  const now = 1_700_000_000_000;
  const project = buildComparisonFilterFromRow({ groupBy: 'project', group: 'alpha', windowDays: 7, now, sessionIds: ['s1', 's2'] });
  const user = buildComparisonFilterFromRow({ groupBy: 'user', group: 'alice', windowDays: 14, now });
  const model = buildComparisonFilterFromRow({ groupBy: 'model', group: 'gpt-4o', windowDays: 30, now });
  const provider = buildComparisonFilterFromRow({ groupBy: 'provider', group: 'openai', windowDays: 10, now });

  assert.equal(project.project, 'alpha');
  assert.equal(user.user, 'alice');
  assert.equal(model.model, 'gpt-4o');
  assert.equal(provider.provider, 'openai');
  assert.equal(project.to, now);
  assert.equal(project.from, now - (7 * 24 * 60 * 60 * 1000));
  assert.deepEqual(project.sessionIds, ['s1', 's2']);
});

test('serialize + parse comparison filter supports deep-link restore', () => {
  const filter = buildComparisonFilterFromRow({
    groupBy: 'project',
    group: 'platform',
    windowDays: 7,
    now: 1_700_000_000_000,
    sessionIds: ['a', 'b', 'c'],
  });
  const serialized = serializeComparisonFilter(filter).toString();
  const parsed = parseComparisonFilter(`?${serialized}`);

  assert.equal(parsed.active, true);
  assert.equal(parsed.groupBy, 'project');
  assert.equal(parsed.group, 'platform');
  assert.equal(parsed.project, 'platform');
  assert.equal(parsed.windowDays, 7);
  assert.deepEqual(parsed.sessionIds, ['a', 'b', 'c']);
});

test('buildSessionsApiPath and filterSessionsByIds apply drill-down filters and id matching', () => {
  const filter = buildComparisonFilterFromRow({
    groupBy: 'provider',
    group: 'openai',
    windowDays: 7,
    now: 1_700_000_000_000,
    sessionIds: ['s-2'],
  });
  const path = buildSessionsApiPath(filter);
  assert.match(path, /provider=openai/);
  assert.match(path, /from=/);
  assert.match(path, /to=/);

  const sessions = [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }];
  const filtered = filterSessionsByIds(sessions, filter.sessionIds);
  assert.deepEqual(filtered, [{ id: 's-2' }]);
});

test('clearComparisonFilterFromSearch resets comparison query params only', () => {
  const cleaned = clearComparisonFilterFromSearch('?foo=1&cf_active=1&cf_groupBy=project&cf_group=alpha&bar=2');
  assert.equal(cleaned, '?foo=1&bar=2');
});
