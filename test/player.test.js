const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { PlayerWatcher, commandFor, normalizeStatus, describeExit } = require('../bridge/player');

// A stand-in for the real player scripts: a Node one-liner.
function fakePlayer(code) {
  return [process.execPath, ['-e', code]];
}

function collect(watcher, count) {
  return new Promise((resolve) => {
    const statuses = [];
    watcher.on('status', (status) => {
      statuses.push(status);
      if (statuses.length === count) resolve(statuses);
    });
  });
}

test('emits each line the script prints as a status', async (t) => {
  const watcher = new PlayerWatcher({
    command: fakePlayer(`
      console.log(JSON.stringify({ state: 'Not Running' }));
      setTimeout(() => console.log('{"state":"Playing","name":"Let You Down","artist":"NF"}'), 50);
      setTimeout(() => console.log('not json'), 100);
      setInterval(() => {}, 1000);
    `),
  });
  t.after(() => watcher.stop());
  const statuses = collect(watcher, 3);
  watcher.start();
  const [first, second, third] = await statuses;
  assert.deepEqual(first, { state: 'Not Running' });
  assert.equal(second.name, 'Let You Down');
  assert.equal(third.state, 'Error');
  assert.match(third.error, /Unexpected output: not json/);
});

test('passes the parent PID to the script so it can stop if the app dies', async (t) => {
  const watcher = new PlayerWatcher({
    command: fakePlayer(`console.log(JSON.stringify({ state: 'Stopped', name: process.env.AMRPC_PARENT_PID })); setInterval(() => {}, 1000);`),
  });
  t.after(() => watcher.stop());
  const statuses = collect(watcher, 1);
  watcher.start();
  const [status] = await statuses;
  assert.equal(status.name, String(process.pid));
});

test('reports why the script stopped, then restarts it', async (t) => {
  const watcher = new PlayerWatcher({
    restartDelay: 20,
    command: fakePlayer(`
      console.log(JSON.stringify({ state: 'Not Running' }));
      setTimeout(() => { console.error('osascript: execution error: Error: Something broke (-1728)'); process.exit(1); }, 30);
    `),
  });
  t.after(() => watcher.stop());
  const statuses = collect(watcher, 3);
  watcher.start();
  const [first, crash, restarted] = await statuses;
  assert.deepEqual(first, { state: 'Not Running' });
  assert.equal(crash.state, 'Error');
  assert.equal(crash.error, 'Something broke (-1728)');
  assert.match(crash.details, /execution error/);
  assert.deepEqual(restarted, { state: 'Not Running' });
});

test('stop() ends the script and does not restart it', async () => {
  const watcher = new PlayerWatcher({
    restartDelay: 10,
    command: fakePlayer(`console.log(JSON.stringify({ state: 'Not Running' })); setInterval(() => {}, 1000);`),
  });
  watcher.start();
  await once(watcher, 'status');
  const child = watcher.child;
  watcher.stop();
  await once(child, 'exit');
  let more = false;
  watcher.on('status', () => (more = true));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(more, false);
});

test('a missing script program is reported as an error', async (t) => {
  const watcher = new PlayerWatcher({ restartDelay: 60000, command: ['/nonexistent/player-script', []] });
  t.after(() => watcher.stop());
  watcher.start();
  const [status] = await once(watcher, 'status');
  assert.equal(status.state, 'Error');
  assert.match(status.details, /ENOENT/);
});

test('a macOS permission denial is reported as a permission problem, not "not open"', () => {
  const reported = normalizeStatus({ state: 'Error', error: 'Not authorized to send Apple events to Music.', errorNumber: -1743 });
  assert.equal(reported.permission, true);
  assert.equal(reported.error, 'Not allowed to control Music');
  assert.equal(reported.details, 'Not authorized to send Apple events to Music.');

  const crashed = describeExit(1, null, 'execution error: Error: Not authorized to send Apple events to Music. (-1743)\n');
  assert.equal(crashed.permission, true);
});

test('other script errors keep the reason and full details', () => {
  const status = normalizeStatus({ state: 'Error', player: 'Apple Music', error: "Couldn't read the Windows media controls: Class not registered" });
  assert.equal(status.error, "Couldn't read the Windows media controls: Class not registered");
  assert.equal(status.permission, undefined);
  assert.equal(describeExit(null, 'SIGKILL', '').error, 'The player script stopped (SIGKILL)');
});

test('each platform runs its own long-running script', () => {
  const [osascript, macArgs] = commandFor('darwin');
  assert.equal(osascript, '/usr/bin/osascript');
  assert.deepEqual(macArgs.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(macArgs[3], /com\.apple\.Music\.playerInfo/);

  const [powershell, winArgs] = commandFor('win32');
  assert.match(powershell, /powershell\.exe$/);
  assert.equal(winArgs[winArgs.indexOf('-File') + 1].split(/[\\/]/).pop(), 'windows.ps1');

  assert.equal(commandFor('linux'), null);
});
