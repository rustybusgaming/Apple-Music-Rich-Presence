const test = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdate, isNewer } = require('../lib/updates');

test('versions are compared as numbers, not text', () => {
  assert.equal(isNewer('1.4.0', '1.3.0'), true);
  assert.equal(isNewer('v1.3.1', '1.3.0'), true);
  assert.equal(isNewer('1.10.0', '1.9.0'), true); // "1.10" sorts before "1.9" as text
  assert.equal(isNewer('2.0.0', '1.99.9'), true);
  assert.equal(isNewer('v1.3.0', '1.3.0'), false);
  assert.equal(isNewer('1.2.9', '1.3.0'), false);
  assert.equal(isNewer('nonsense', '1.3.0'), false);
});

function release(body, status = 200, seen = {}) {
  return async (url, options) => {
    seen.url = url;
    seen.options = options;
    return { ok: status === 200, status, json: async () => body };
  };
}

test('a newer release on GitHub is reported with its page', async () => {
  const seen = {};
  const result = await checkForUpdate('1.3.0', {
    fetchImpl: release({ tag_name: 'v1.4.0', html_url: 'https://github.com/x/y/releases/tag/v1.4.0' }, 200, seen),
  });
  assert.deepEqual(result, { version: '1.4.0', url: 'https://github.com/x/y/releases/tag/v1.4.0', newer: true });
  assert.match(seen.url, /api\.github\.com\/repos\/rustybusgaming\/Apple-Music-Rich-Presence\/releases\/latest$/);
  assert.equal(seen.options.headers.Accept, 'application/vnd.github+json');
});

test('being on the latest version is not an update', async () => {
  const result = await checkForUpdate('1.3.0', { fetchImpl: release({ tag_name: 'v1.3.0', html_url: 'u' }) });
  assert.equal(result.newer, false);
});

test('GitHub errors and odd releases are reported, not ignored', async () => {
  await assert.rejects(checkForUpdate('1.3.0', { fetchImpl: release({}, 403) }), /GitHub returned 403/);
  await assert.rejects(checkForUpdate('1.3.0', { fetchImpl: release({ tag_name: 'latest' }) }), /no version number/);
});
