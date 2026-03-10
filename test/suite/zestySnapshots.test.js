const assert = require('assert');

const {
  buildRollbackSnapshotFileName,
  buildRollbackSnapshotPrefix,
  parseRollbackSnapshotPayload
} = require('../../out/src/zestySnapshots');

suite('Zesty Snapshot Helpers', () => {
  test('builds a stable snapshot prefix and filename', () => {
    const prefix = buildRollbackSnapshotPrefix('views', 'webengine/views/pages/home');
    const fileName = buildRollbackSnapshotFileName(
      'views',
      'webengine/views/pages/home',
      '2026-03-10T12:00:00.000Z',
      'Before Hero Refactor'
    );

    assert.ok(prefix.startsWith('/_zesty/rollbacks/views/'));
    assert.ok(fileName.startsWith(prefix));
    assert.ok(fileName.includes('before-hero-refactor--'));
    assert.ok(fileName.endsWith('.json'));
  });

  test('parses snapshot payload JSON', () => {
    const payload = parseRollbackSnapshotPayload(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'zesty-webengine-rollback-snapshot',
        createdAt: '2026-03-10T12:00:00.000Z',
        snapshotName: 'Before Hero Refactor',
        source: {
          instanceZuid: '8-test',
          resourceType: 'views',
          relativePath: 'webengine/views/pages/home',
          filename: 'pages/home'
        },
        snapshot: {
          code: '<h1>Hello</h1>'
        }
      })
    );

    assert.strictEqual(payload.snapshot.code, '<h1>Hello</h1>');
    assert.strictEqual(payload.source.instanceZuid, '8-test');
    assert.strictEqual(payload.snapshotName, 'Before Hero Refactor');
  });
});
