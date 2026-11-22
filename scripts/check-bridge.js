// CI check for the player scripts, run on real macOS and Windows machines.
// Music, Apple Music and iTunes aren't running there, so a working script
// reports "Not Running". It also checks that:
//   - macOS: the script hears Music's "playerInfo" notifications, and stops
//     when the app that started it closes its stdin
//   - Windows: the script stops when the app that started it is gone

const { spawn } = require('child_process');
const { once } = require('events');
const { PlayerWatcher, commandFor } = require('../bridge/player');

function fail(message) {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}

function within(ms, promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkFirstStatus() {
  const watcher = new PlayerWatcher({ env: { AMRPC_DEBUG: '1' } });
  watcher.on('log', (text) => process.stderr.write(`  [script] ${text}`));
  watcher.start();
  const [status] = await within(60000, once(watcher, 'status'), 'the first status');
  console.log('First status:', status);
  if (status.state !== 'Not Running' && !status.permission) {
    watcher.stop();
    fail('the player script failed on this OS');
  }
  return watcher;
}

async function checkMacNotifications(watcher) {
  const heard = new Promise((resolve) => {
    watcher.on('log', (text) => text.includes('playerInfo') && resolve());
  });
  // Pretend to be Music announcing a track change.
  const post = spawn('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("com.apple.Music.playerInfo", null, null, true); ""',
  ]);
  const [code] = await once(post, 'exit');
  if (code !== 0) fail('could not post a test notification');
  await within(10000, heard, 'the script to hear the playerInfo notification');
  console.log('The script heard the playerInfo notification.');
}

async function checkMacStopsWithApp() {
  const [file, args] = commandFor('darwin');
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  await within(30000, once(child.stdout, 'data'), 'the script to start');
  child.stdin.end(); // what happens when the app quits or crashes
  await within(10000, once(child, 'exit'), 'the script to stop after its stdin closed');
  console.log('The script stopped when its stdin closed.');
}

async function checkWindowsStopsWithApp() {
  // The PID of a process that has already exited.
  const gone = spawn(process.execPath, ['-e', '']);
  await once(gone, 'exit');

  const [file, args] = commandFor('win32');
  const child = spawn(file, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
    env: { ...process.env, AMRPC_PARENT_PID: String(gone.pid) },
  });
  const [code] = await within(60000, once(child, 'exit'), 'the script to stop when its parent is gone');
  if (code !== 0) fail(`the script exited with code ${code}`);
  console.log('The script stopped when the app that started it was gone.');
}

async function main() {
  if (!commandFor(process.platform)) {
    console.log('No player script for this OS, skipping.');
    return;
  }
  const watcher = await checkFirstStatus();
  if (process.platform === 'darwin') await checkMacNotifications(watcher);
  watcher.stop();

  if (process.platform === 'darwin') await checkMacStopsWithApp();
  if (process.platform === 'win32') await checkWindowsStopsWithApp();
  console.log('All player script checks passed.');
}

main().catch((error) => fail(error.message));
