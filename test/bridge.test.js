const test = require('node:test');
const assert = require('node:assert/strict');
const { describeError } = require('../bridge/iTunesBridge');

test('a macOS permission denial is reported as a permission problem, not "not open"', () => {
  const error = Object.assign(new Error('Command failed: osascript -l JavaScript OSABridge.js'), { code: 1 });
  const stderr = 'OSABridge.js: execution error: Error: Error: Not authorized to send Apple events to Music. (-1743)\n';
  const status = describeError(error, stderr);
  assert.equal(status.state, 'Error');
  assert.equal(status.permission, true);
});

test('a timeout says the player did not respond', () => {
  const error = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  assert.match(describeError(error, '').error, /didn't respond/);
});

test('other failures keep the last line of the error output', () => {
  const error = Object.assign(new Error('Command failed'), { code: 1 });
  const status = describeError(error, 'WSBridge.js(12, 5) Microsoft JScript runtime error: Object required\r\n');
  assert.deepEqual(status, { state: 'Error', error: 'WSBridge.js(12, 5) Microsoft JScript runtime error: Object required' });
});
