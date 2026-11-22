const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupArtwork, lookupAppLogo, pickBest } = require('../lib/artwork');

const results = [
  {
    trackName: 'Let You Down',
    artistName: 'Some Cover Band',
    collectionName: 'Covers',
    artworkUrl100: 'https://is1.mzstatic.com/cover/100x100bb.jpg',
    trackViewUrl: 'https://music.apple.com/us/album/covers?i=1',
  },
  {
    trackName: 'Let You Down',
    artistName: 'NF',
    collectionName: 'Perception (Deluxe)',
    artworkUrl100: 'https://is1.mzstatic.com/perception/100x100bb.jpg',
    trackViewUrl: 'https://music.apple.com/us/album/perception?i=2',
  },
  {
    trackName: 'Let You Down',
    artistName: 'NF',
    collectionName: 'Let You Down - Single',
    artworkUrl100: 'https://is1.mzstatic.com/single/100x100bb.jpg',
    trackViewUrl: 'https://music.apple.com/us/album/single?i=3',
  },
];

function fakeFetch(body, calls = []) {
  return async (url) => {
    calls.push(url);
    return { ok: true, json: async () => body };
  };
}

test('pickBest prefers the matching artist and album', () => {
  const best = pickBest(results, { name: 'Let You Down', artist: 'NF', album: 'Perception' });
  assert.equal(best.trackViewUrl, 'https://music.apple.com/us/album/perception?i=2');
});

test('pickBest returns null when nothing matches', () => {
  assert.equal(pickBest(results, { name: 'Something Else', artist: 'NF', album: '' }), null);
});

test('lookupArtwork returns large artwork and caches the result', async () => {
  const calls = [];
  const track = { name: 'Let You Down', artist: 'NF', album: 'Perception' };
  const fetchImpl = fakeFetch({ results }, calls);

  const artwork = await lookupArtwork(track, { fetchImpl });
  assert.deepEqual(artwork, { imageUrl: 'https://is1.mzstatic.com/perception/512x512bb.jpg' });
  assert.match(calls[0], /^https:\/\/itunes\.apple\.com\/search\?term=Let\+You\+Down\+NF&/);

  await lookupArtwork(track, { fetchImpl });
  assert.equal(calls.length, 1);
});

test('lookupArtwork gives up quietly on network errors', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  assert.equal(await lookupArtwork({ name: 'Offline Song', artist: 'X' }, { fetchImpl }), null);
});

test("lookupAppLogo returns Apple's current Apple Music icon at 512px", async () => {
  const calls = [];
  const fetchImpl = fakeFetch(
    { results: [{ artworkUrl512: 'https://is1-ssl.mzstatic.com/image/thumb/Purple/music.png/512x512bb.jpg' }] },
    calls
  );
  const logo = await lookupAppLogo({ country: 'gb', fetchImpl });
  assert.equal(logo, 'https://is1-ssl.mzstatic.com/image/thumb/Purple/music.png/512x512bb.jpg');
  assert.equal(calls[0], 'https://itunes.apple.com/lookup?id=1108187390&country=gb');

  await lookupAppLogo({ country: 'gb', fetchImpl });
  assert.equal(calls.length, 1);
});

test('lookupAppLogo returns null when Apple is unreachable', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  assert.equal(await lookupAppLogo({ country: 'fr', fetchImpl }), null);
});

test('a slow lookup returns straight away, then calls onLate when it finishes', async () => {
  const fetchImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { ok: true, json: async () => ({ results }) };
  };
  let late = false;
  const lateCalled = new Promise((resolve) => {
    const result = lookupArtwork({ name: 'Let You Down', artist: 'NF', album: 'Slow' }, { fetchImpl, wait: 10, onLate: () => resolve((late = true)) });
    result.then((value) => assert.equal(value, null));
  });
  await lateCalled;
  assert.equal(late, true);
  const cachedNow = await lookupArtwork({ name: 'Let You Down', artist: 'NF', album: 'Slow' }, { fetchImpl, wait: 10 });
  assert.ok(cachedNow.imageUrl);
});
