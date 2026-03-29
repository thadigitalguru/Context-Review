const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOpsActionRequest,
  buildOpsActionState,
  resolveDownloadInstruction,
  triggerJsonDownload,
} = require('../public/js/ops-panel-helpers.js');

test('buildOpsActionRequest maps supported action types', () => {
  const dry = buildOpsActionRequest('maintenanceDry');
  const force = buildOpsActionRequest('maintenanceForce');
  const compact = buildOpsActionRequest('compactDry');

  assert.equal(dry.path, '/storage/maintenance/run');
  assert.deepEqual(dry.payload, { dryRun: true });
  assert.equal(force.path, '/storage/maintenance/run');
  assert.deepEqual(force.payload, { dryRun: false, force: true });
  assert.equal(compact.path, '/storage/compact');
  assert.deepEqual(compact.payload, { dryRun: true });
  assert.equal(buildOpsActionRequest('unknown').error, 'Unknown ops action');
});

test('buildOpsActionState returns success and error states', () => {
  const ok = buildOpsActionState({ reason: 'manual_maintenance' });
  assert.equal(ok.error, '');
  assert.match(ok.message, /manual_maintenance/);
  assert.equal(ok.refreshNeeded, true);

  const serverError = buildOpsActionState({ _error: 'forbidden' });
  assert.equal(serverError.error, 'forbidden');
  assert.equal(serverError.refreshNeeded, false);

  const empty = buildOpsActionState(null);
  assert.equal(empty.error, 'Action failed');
  assert.equal(empty.refreshNeeded, false);
});

test('resolveDownloadInstruction handles payload and missing data', () => {
  const resolver = () => ({ payload: { ok: true }, filename: 'artifact.json' });
  const resolved = resolveDownloadInstruction({}, 'storage-status', resolver);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.filename, 'artifact.json');

  const missing = resolveDownloadInstruction({}, 'storage-status', () => ({ payload: null }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No data available/);
});

test('triggerJsonDownload performs anchor flow and revokes object URL', () => {
  const calls = [];
  class FakeBlob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = opts?.type;
    }
  }

  const anchor = {
    href: '',
    download: '',
    click() { calls.push('click'); },
  };
  const fakeDoc = {
    createElement(tag) {
      assert.equal(tag, 'a');
      return anchor;
    },
    body: {
      appendChild() { calls.push('append'); },
      removeChild() { calls.push('remove'); },
    },
  };
  const fakeURL = {
    createObjectURL(blob) {
      assert.equal(blob.type, 'application/json');
      calls.push('createObjectURL');
      return 'blob:test';
    },
    revokeObjectURL(url) {
      assert.equal(url, 'blob:test');
      calls.push('revokeObjectURL');
    },
  };

  const result = triggerJsonDownload({ a: 1 }, 'artifact.json', {
    BlobCtor: FakeBlob,
    URLApi: fakeURL,
    document: fakeDoc,
  });
  assert.equal(result.ok, true);
  assert.equal(anchor.download, 'artifact.json');
  assert.deepEqual(calls, ['createObjectURL', 'append', 'click', 'remove', 'revokeObjectURL']);
});

test('triggerJsonDownload returns unavailable without browser dependencies', () => {
  const result = triggerJsonDownload({ ok: true }, 'x.json', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Download unavailable/);
});
