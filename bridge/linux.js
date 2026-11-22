// Reports what's playing in Apple Music on Linux (and FreeBSD). It keeps
// running and prints one line of JSON whenever that changes. bridge/player.js
// starts it with Electron in Node mode and stops it when the app quits.
//
// There's no Apple Music app for Linux, so this reads MPRIS, the standard way
// Linux media players share what they're playing (over D-Bus). It uses
// players that are clearly Apple Music (Cider, Apple Music apps, or anything
// whose artwork or link points to Apple Music). Web browsers report the same
// way whatever site is playing, so they're only used when "Include Web
// Browsers" is turned on (AMRPC_INCLUDE_BROWSERS=1).

const fs = require('fs');
const path = require('path');

const PLAYER_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const CHECK_SECONDS = { Playing: 5, other: 15 };
const SIGNAL = 4; // D-Bus message type

const APPLE_MUSIC_PLAYER = /cider|apple ?music/i;
const APPLE_MUSIC_LINK = /mzstatic\.com|music\.apple\.com/i;
const BROWSER = /firefox|chrom|brave|vivaldi|edge|opera|epiphany|librewolf|floorp|zen|waterfox|falkon|qutebrowser/i;

// ---------------------------------------------------------------- helpers

// dbus-native returns a variant as [typeTree, [value]].
const unwrap = (variant) => (Array.isArray(variant) ? variant[1]?.[0] : variant);

function toObject(entries) {
  const out = {};
  for (const [key, variant] of entries || []) out[key] = unwrap(variant);
  return out;
}

const seconds = (microseconds) => (Number(microseconds) || 0) / 1e6;

/** Turns a player's MPRIS properties into a status like the other bridges report. */
function toStatus(identity, player) {
  const meta = toObject(player.Metadata);
  const state = { Playing: 'Playing', Paused: 'Paused' }[player.PlaybackStatus] || 'Stopped';
  const status = { state, player: identity };
  if (state === 'Stopped') return status;
  const artist = meta['xesam:artist'];
  return {
    ...status,
    name: meta['xesam:title'] || '',
    artist: Array.isArray(artist) ? artist.join(', ') : artist || '',
    album: meta['xesam:album'] || '',
    duration: seconds(meta['mpris:length']),
    elapsed: seconds(player.Position),
    link: `${meta['mpris:artUrl'] || ''} ${meta['xesam:url'] || ''}`,
  };
}

function isAppleMusic(busName, identity, status, includeBrowsers) {
  if (APPLE_MUSIC_PLAYER.test(`${busName} ${identity}`)) return true;
  if (APPLE_MUSIC_LINK.test(status.link || '')) return true;
  return includeBrowsers && BROWSER.test(`${busName} ${identity}`) && Boolean(status.name);
}

/** Playing beats paused beats stopped. */
function pickStatus(statuses) {
  for (const state of ['Playing', 'Paused', 'Stopped']) {
    const match = statuses.find((status) => status.state === state);
    if (match) {
      const { link, ...rest } = match;
      return rest;
    }
  }
  return { state: 'Not Running' };
}

function busAddress(env = process.env) {
  // Use the session's own bus. dbus-native can't open "abstract" sockets,
  // though, so for those (or if none is set) fall back to the socket file
  // that systemd-based systems keep in XDG_RUNTIME_DIR.
  const configured = env.DBUS_SESSION_BUS_ADDRESS;
  if (configured && !configured.includes('abstract=')) return configured;
  const socket = env.XDG_RUNTIME_DIR && path.join(env.XDG_RUNTIME_DIR, 'bus');
  if (socket && fs.existsSync(socket)) return `unix:path=${socket}`;
  return configured;
}

// ------------------------------------------------------------------- main

function main() {
  const includeBrowsers = process.env.AMRPC_INCLUDE_BROWSERS === '1';
  const debug = (text) => process.env.AMRPC_DEBUG && process.stderr.write(`${text}\n`);
  const print = (status) => process.stdout.write(`${JSON.stringify(status)}\n`);

  const address = busAddress();
  if (!address) {
    print({ state: 'Error', error: "Couldn't find the D-Bus session bus (DBUS_SESSION_BUS_ADDRESS isn't set)" });
    process.exit(1);
  }

  const dbus = require('@homebridge/dbus-native');
  const bus = dbus.sessionBus({ busAddress: address });
  bus.connection.on('error', (error) => {
    print({ state: 'Error', error: `Lost the D-Bus connection: ${error.message}` });
    process.exit(1);
  });

  const call = (destination, objectPath, iface, member, signature, body) =>
    new Promise((resolve, reject) =>
      bus.invoke({ destination, path: objectPath, interface: iface, member, signature, body }, (error, ...result) =>
        error ? reject(new Error(error.message || error.name)) : resolve(result)
      )
    );

  async function getStatus() {
    const [names] = await call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames');
    const statuses = [];
    for (const name of names.filter((n) => n.startsWith(PLAYER_PREFIX))) {
      try {
        const [[identityVariant], [playerProps]] = await Promise.all([
          call(name, MPRIS_PATH, PROPERTIES, 'Get', 'ss', ['org.mpris.MediaPlayer2', 'Identity']).catch(() => [[]]),
          call(name, MPRIS_PATH, PROPERTIES, 'GetAll', 's', ['org.mpris.MediaPlayer2.Player']),
        ]);
        const identity = unwrap(identityVariant) || name.slice(PLAYER_PREFIX.length);
        const status = toStatus(identity, toObject(playerProps));
        if (isAppleMusic(name, identity, status, includeBrowsers)) statuses.push(status);
      } catch (error) {
        debug(`Skipping ${name}: ${error.message}`); // a player that quit mid-check
      }
    }
    return pickStatus(statuses);
  }

  // Only print when something changed. While playing, the position always
  // moves, so compare when the song started instead: that only jumps when
  // the user seeks.
  let lastKey = null;
  let lastStart = 0;
  function report(status) {
    const now = Date.now();
    const start = status.state === 'Playing' ? now - (status.elapsed || 0) * 1000 : 0;
    const key = JSON.stringify([status.state, status.player, status.name, status.artist, status.album, status.duration, status.error]);
    if (key !== lastKey || Math.abs(start - lastStart) > 2000) {
      lastKey = key;
      lastStart = start;
      print(status);
    }
  }

  let running = false;
  let again = false;
  let timer = null;
  async function check() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    let status;
    try {
      status = await getStatus();
    } catch (error) {
      status = { state: 'Error', error: error.message };
    }
    report(status);
    running = false;
    if (again) {
      again = false;
      return check();
    }
    timer = setTimeout(check, (CHECK_SECONDS[status.state] || CHECK_SECONDS.other) * 1000);
  }

  // Players announce changes with signals; check soon after any of them.
  let soon = null;
  bus.connection.on('message', (message) => {
    if (message.type !== SIGNAL) return;
    const fromPlayer = message.path === MPRIS_PATH;
    const playerAppeared = message.member === 'NameOwnerChanged' && String(message.body?.[0]).startsWith(PLAYER_PREFIX);
    if (!fromPlayer && !playerAppeared) return;
    debug(`signal ${message.member}`);
    clearTimeout(soon);
    soon = setTimeout(check, 150);
  });
  for (const rule of [
    `type='signal',interface='${PROPERTIES}',member='PropertiesChanged',path='${MPRIS_PATH}'`,
    `type='signal',interface='org.mpris.MediaPlayer2.Player',member='Seeked',path='${MPRIS_PATH}'`,
    `type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'`,
  ]) {
    bus.addMatch(rule, () => {});
  }

  // The app keeps our stdin open. When it closes, the app has quit (or
  // crashed), so stop too.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();

  check();
}

if (require.main === module) main();

module.exports = { toStatus, isAppleMusic, pickStatus, busAddress, unwrap, toObject };
