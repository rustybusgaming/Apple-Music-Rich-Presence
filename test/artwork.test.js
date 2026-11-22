const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupArtwork, pickBest } = require('../lib/artwork');

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
  assert.deepEqual(artwork, {
    imageUrl: 'https://is1.mzstatic.com/perception/512x512bb.jpg',
    trackUrl: 'https://music.apple.com/us/album/perception?i=2',
  });
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
