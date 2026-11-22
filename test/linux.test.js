const test = require('node:test');
const assert = require('node:assert/strict');
const { toStatus, isAppleMusic, pickStatus, busAddress } = require('../bridge/linux');

// MPRIS properties as bridge/linux.js sees them after unwrapping, with the
// metadata still in dbus-native's [key, [type, [value]]] form.
const v = (value) => [[{ type: '?' }], [value]];
function mpris({ status = 'Playing', title = 'Let You Down', artist = ['NF'], album = 'Perception', art = '', position = 38.4 } = {}) {
  return {
    PlaybackStatus: status,
    Position: position * 1e6,
    Metadata: [
      ['xesam:title', v(title)],
      ['xesam:artist', v(artist)],
      ['xesam:album', v(album)],
      ['mpris:length', v(212 * 1e6)],
      ['mpris:artUrl', v(art)],
    ],
  };
}

test('MPRIS properties become a status like the other platforms report', () => {
  const status = toStatus('Cider', mpris());
  assert.deepEqual(
    { ...status, link: undefined },
    { state: 'Playing', player: 'Cider', name: 'Let You Down', artist: 'NF', album: 'Perception', duration: 212, elapsed: 38.4, link: undefined }
  );
  assert.equal(toStatus('Cider', mpris({ artist: ['A', 'B'] })).artist, 'A, B');
  assert.deepEqual(toStatus('Cider', mpris({ status: 'Stopped' })), { state: 'Stopped', player: 'Cider' });
});

test('Apple Music players are recognised by name or by Apple Music artwork', () => {
  const plain = toStatus('Some Player', mpris());
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.cider', 'Cider', plain, false), true);
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.foo', 'Apple Music', plain, false), true);
  const appleArt = toStatus('Some Player', mpris({ art: 'https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg' }));
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.foo', 'Some Player', appleArt, false), true);
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.spotify', 'Spotify', plain, false), false);
});

test('web browsers only count when "Include Web Browsers" is on', () => {
  const tab = toStatus('Mozilla Firefox', mpris({ art: 'file:///tmp/firefox-mpris/1.png' }));
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.firefox.instance_1_2', 'Mozilla Firefox', tab, false), false);
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.firefox.instance_1_2', 'Mozilla Firefox', tab, true), true);
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.chromium.instance42', 'Chromium', tab, true), true);
  assert.equal(isAppleMusic('org.mpris.MediaPlayer2.vlc', 'VLC media player', tab, true), false);
});

test('a playing player wins over a paused one', () => {
  const paused = toStatus('Cider', mpris({ status: 'Paused', title: 'A' }));
  const playing = toStatus('Firefox', mpris({ title: 'B' }));
  assert.equal(pickStatus([paused, playing]).name, 'B');
  assert.equal(pickStatus([paused]).state, 'Paused');
  assert.equal(pickStatus([]).state, 'Not Running');
  assert.equal('link' in pickStatus([playing]), false);
});

test("the session's own bus is used, with the socket file as a fallback for abstract sockets", () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-test-'));
  fs.writeFileSync(path.join(dir, 'bus'), '');
  // A session started with its own bus (like dbus-run-session) keeps it.
  assert.equal(busAddress({ XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/other-bus' }), 'unix:path=/tmp/other-bus');
  assert.equal(busAddress({ XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x,guid=1' }), `unix:path=${path.join(dir, 'bus')}`);
  assert.equal(busAddress({ XDG_RUNTIME_DIR: dir }), `unix:path=${path.join(dir, 'bus')}`);
  assert.equal(busAddress({}), undefined);
});
