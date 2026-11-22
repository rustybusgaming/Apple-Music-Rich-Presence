const test = require('node:test');
const assert = require('node:assert/strict');
const { buildActivity, keepTimestamps, parseTrack, fitText, searchUrl } = require('../lib/presence');

const NOW = 1_700_000_000_000;
const song = { state: 'Playing', name: 'Let You Down', artist: 'NF', album: 'Perception', duration: 212, elapsed: 38.4 };

test('parseTrack keeps " - " in titles when the artist is known', () => {
  assert.deepEqual(parseTrack({ name: 'Help! - Remastered 2009', artist: 'The Beatles', album: 'Help!' }), {
    name: 'Help! - Remastered 2009',
    artist: 'The Beatles',
    album: 'Help!',
  });
});

test('parseTrack splits "Artist - Title" only on the first separator when there is no artist', () => {
  assert.deepEqual(parseTrack({ name: 'Jay-Z - Song - Live' }), { name: 'Song - Live', artist: 'Jay-Z', album: '' });
});

test('parseTrack uses the radio stream title and shows the station as the album', () => {
  assert.deepEqual(parseTrack({ name: 'Radio X', artist: '', streamTitle: 'Artist - Title' }), {
    name: 'Title',
    artist: 'Artist',
    album: 'Radio X',
  });
});

test('nothing is shown unless something is playing or paused', () => {
  for (const state of ['Stopped', 'Not Running', 'Unsupported', 'Starting']) {
    assert.equal(buildActivity({ ...song, state }, {}, null, NOW), null);
  }
  assert.equal(buildActivity({ state: 'Playing' }, {}, null, NOW), null);
});

test('a playing song shows as Listening with a progress bar', () => {
  const activity = buildActivity(song, { showProgress: true }, null, NOW);
  assert.equal(activity.type, 2);
  assert.equal(activity.details, 'Let You Down');
  assert.equal(activity.state, 'by NF');
  assert.equal(activity.assets.large_image, 'applemusic');
  assert.equal(activity.assets.large_text, 'Perception');
  assert.equal(activity.assets.small_image, 'pause');
  assert.deepEqual(activity.timestamps, { start: NOW - 38400, end: NOW - 38400 + 212000 });
  assert.deepEqual(
    activity.buttons.map((b) => b.label),
    ['Search on Apple Music', 'Search on Spotify']
  );
  assert.equal(activity.buttons[1].url, 'https://open.spotify.com/search/Let%20You%20Down%20NF');
});

test('progress bar can be turned off', () => {
  const activity = buildActivity(song, { showProgress: false }, null, NOW);
  assert.deepEqual(activity.timestamps, { start: NOW - 38400 });
});

test('a paused song has no running timer', () => {
  const activity = buildActivity({ ...song, state: 'Paused' }, {}, null, NOW);
  assert.equal(activity.state, 'Paused · NF');
  assert.equal(activity.assets.small_image, 'play');
  assert.equal(activity.timestamps, undefined);
});

test('artwork and a direct song link are used when found', () => {
  const artwork = { imageUrl: 'https://example.com/a.jpg', trackUrl: 'https://music.apple.com/us/album/x?i=1' };
  const activity = buildActivity(song, {}, artwork, NOW);
  assert.equal(activity.assets.large_image, artwork.imageUrl);
  assert.deepEqual(activity.buttons[0], { label: 'Listen on Apple Music', url: artwork.trackUrl });
});

test('text is kept within Discord limits', () => {
  assert.equal(fitText('X'), 'X​');
  assert.equal([...fitText('a'.repeat(300))].length, 128);
  assert.equal([...fitText('🎵'.repeat(200))].length, 128);
  assert.ok(searchUrl('https://open.spotify.com/search/', '音楽'.repeat(200)).length <= 512);
});

test('keepTimestamps ignores small drift but notices seeks and song changes', () => {
  const first = buildActivity(song, {}, null, NOW);
  const wobble = buildActivity({ ...song, elapsed: 39.1 }, {}, null, NOW + 1000);
  assert.deepEqual(keepTimestamps(wobble, first).timestamps, first.timestamps);

  const seeked = buildActivity({ ...song, elapsed: 120 }, {}, null, NOW + 1000);
  assert.deepEqual(keepTimestamps(seeked, first).timestamps, seeked.timestamps);

  const other = buildActivity({ ...song, name: 'Paralyzed', elapsed: 0 }, {}, null, NOW + 1000);
  assert.deepEqual(keepTimestamps(other, first).timestamps, other.timestamps);

  assert.equal(keepTimestamps(null, first), null);
});
