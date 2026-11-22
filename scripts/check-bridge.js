// CI check for the player scripts, run on real macOS, Windows and Linux
// machines. No music player is running there, so a working script reports
// "Not Running". It also checks that:
//   - macOS: the script hears Music's "playerInfo" notifications, and stops
//     when the app that started it closes its stdin
//   - Windows: the script stops when the app that started it is gone
//   - Linux: with a fake Cider player on D-Bus, the script reports what it's
//     playing, notices pausing, ignores web browsers unless asked, and stops
//     when its stdin closes. Run it with dbus-run-session on machines
//     without a desktop session.

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
    'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("com.apple.Music.playerInfo", $(), $(), true); ""',
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

// ----------------------------------------------------------------- Linux

const MPRIS_PATH = '/org/mpris/MediaPlayer2';

// A fake MPRIS player on the session bus, like Cider or a browser tab.
function fakeMprisPlayer(busName, identity, track) {
  const dbus = require('@homebridge/dbus-native');
  const bus = dbus.sessionBus();
  const player = {
    PlaybackStatus: 'Playing',
    Position: Math.round(track.elapsed * 1e6),
    Metadata: [
      ['xesam:title', ['s', track.name]],
      ['xesam:artist', ['as', [track.artist]]],
      ['xesam:album', ['s', track.album]],
      ['mpris:length', ['x', Math.round(track.duration * 1e6)]],
    ],
  };
  bus.exportInterface(player, MPRIS_PATH, {
    name: 'org.mpris.MediaPlayer2.Player',
    methods: {},
    signals: {},
    properties: { PlaybackStatus: 's', Position: 'x', Metadata: 'a{sv}' },
  });
  bus.exportInterface({ Identity: identity }, MPRIS_PATH, {
    name: 'org.mpris.MediaPlayer2',
    methods: {},
    signals: {},
    properties: { Identity: 's' },
  });
  return {
    claim: () => new Promise((resolve) => bus.requestName(busName, 0, resolve)),
    setStatus(status) {
      player.PlaybackStatus = status;
      bus.sendSignal(MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', [
        'org.mpris.MediaPlayer2.Player',
        [['PlaybackStatus', ['s', status]]],
        [],
      ]);
    },
    close: () => bus.connection.end(),
  };
}

function nextStatus(watcher, predicate, what) {
  return within(
    10000,
    new Promise((resolve) => {
      const listener = (status) => {
        if (!predicate(status)) return;
        watcher.off('status', listener);
        resolve(status);
      };
      watcher.on('status', listener);
    }),
    what
  );
}

async function checkLinuxPlayers(watcher) {
  const track = { name: 'Let You Down', artist: 'NF', album: 'Perception', duration: 212, elapsed: 38 };

  // A browser tab is ignored unless "Include Web Browsers" is on...
  const browser = fakeMprisPlayer('org.mpris.MediaPlayer2.firefox.instance_1_2', 'Mozilla Firefox', { ...track, name: 'Some Video' });
  await browser.claim();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // ...while Cider is picked up as soon as it appears.
  const cider = fakeMprisPlayer('org.mpris.MediaPlayer2.cider', 'Cider', track);
  await cider.claim();
  const playing = await nextStatus(watcher, (s) => s.state === 'Playing', 'the script to see Cider playing');
  console.log('Cider playing:', playing);
  if (playing.name !== track.name || playing.artist !== track.artist || playing.album !== track.album || playing.player !== 'Cider') {
    fail('the script reported the wrong song');
  }
  if (Math.abs(playing.elapsed - track.elapsed) > 1 || playing.duration !== track.duration) fail('the script reported the wrong timing');

  cider.setStatus('Paused');
  console.log('Cider paused:', await nextStatus(watcher, (s) => s.state === 'Paused', 'the script to notice pausing'));

  cider.close();
  console.log('Cider quit:', await nextStatus(watcher, (s) => s.state === 'Not Running', 'the script to notice Cider quitting'));

  watcher.setEnv({ AMRPC_INCLUDE_BROWSERS: '1' });
  const tab = await nextStatus(watcher, (s) => s.state === 'Playing', 'the script to use the browser once allowed');
  console.log('Browser, once allowed:', tab);
  if (tab.name !== 'Some Video') fail('the script reported the wrong browser song');
  browser.close();
}

async function checkLinuxStopsWithApp() {
  const [file, args, env] = commandFor(process.platform);
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  await within(30000, once(child.stdout, 'data'), 'the script to start');
  child.stdin.end(); // what happens when the app quits or crashes
  await within(10000, once(child, 'exit'), 'the script to stop after its stdin closed');
  console.log('The script stopped when its stdin closed.');
}

// ------------------------------------------------------------------ main

async function main() {
  if (!commandFor(process.platform)) {
    console.log('No player script for this OS, skipping.');
    return;
  }
  const watcher = await checkFirstStatus();
  if (process.platform === 'darwin') await checkMacNotifications(watcher);
  if (process.platform === 'linux') await checkLinuxPlayers(watcher);
  watcher.stop();

  if (process.platform === 'darwin') await checkMacStopsWithApp();
  if (process.platform === 'win32') await checkWindowsStopsWithApp();
  if (process.platform === 'linux') await checkLinuxStopsWithApp();
  console.log('All player script checks passed.');
}

main().catch((error) => fail(error.message));
