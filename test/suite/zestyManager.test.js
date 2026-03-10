const assert = require('assert');

const { buildZestyManagerUrl } = require('../../out/src/zestyManager');

suite('Zesty Manager URL', () => {
  test('builds the manager url for views', () => {
    const url = buildZestyManagerUrl({
      instanceZuid: '8-abcd1234efgh5678ijkl9012',
      resourceType: 'views',
      fileZuid: '7-zyxw9876vuts5432rqpo1098'
    });

    assert.strictEqual(
      url,
      'https://8-abcd1234efgh5678ijkl9012.manager.zesty.io/code/file/views/7-zyxw9876vuts5432rqpo1098'
    );
  });

  test('builds the manager url for stylesheets', () => {
    const url = buildZestyManagerUrl({
      instanceZuid: '8-test',
      resourceType: 'stylesheets',
      fileZuid: '7-style'
    });

    assert.strictEqual(url, 'https://8-test.manager.zesty.io/code/file/stylesheets/7-style');
  });
});
