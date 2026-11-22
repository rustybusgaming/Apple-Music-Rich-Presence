const test = require('node:test');
const assert = require('node:assert/strict');
const { describeError, commandFor } = require('../bridge/iTunesBridge');

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
  assert.equal(status.error, 'WSBridge.js(12, 5) Microsoft JScript runtime error: Object required');
  assert.equal(status.details, 'WSBridge.js(12, 5) Microsoft JScript runtime error: Object required');
});

test("osascript's prefixes are dropped so the menu shows the actual reason", () => {
  const error = Object.assign(new Error('Command failed'), { code: 1 });
  const stderr =
    "osascript: /private/var/folders/ab/T/AppTranslocation/X/d/AppleMusicRPC.app/Contents/Resources/app/bridge/OSABridge.js: execution error: Error: Error: Can't get object. (-1728)\n";
  const status = describeError(error, stderr);
  assert.equal(status.error, "Can't get object. (-1728)");
  assert.match(status.details, /AppTranslocation/);
});

test('macOS runs the Music script from its text, not its file path', () => {
  const [program, args] = commandFor('darwin');
  assert.equal(program, '/usr/bin/osascript');
  assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(args[3], /Application\("Music"\)/);
  assert.doesNotMatch(args.join(' '), /OSABridge\.js$/);
});
