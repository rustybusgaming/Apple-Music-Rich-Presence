const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupArtwork, lookupAppLogo, lookupAnimatedCover, pickBest } = require('../lib/artwork');

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
  assert.equal(artwork.imageUrl, 'https://is1.mzstatic.com/perception/512x512bb.jpg');
  assert.equal(artwork.album, 'Perception (Deluxe)');
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

// A fake iTunes Search API: `answer(params)` returns the results for a search.
function fakeSearch(answer, calls = []) {
  return async (url) => {
    const params = { path: new URL(url).pathname, ...Object.fromEntries(new URL(url).searchParams) };
    calls.push(params);
    return { ok: true, json: async () => ({ results: answer(params) }) };
  };
}

const blonde = {
  trackName: 'Pink + White',
  artistName: 'Frank Ocean',
  collectionName: 'Blonde',
  collectionId: 1146195596,
  artworkUrl100: 'https://is1.mzstatic.com/blonde/100x100bb.jpg',
};

test("uses another song from the same album when Apple's search leaves the song out", async () => {
  const calls = [];
  const fetchImpl = fakeSearch(() => [{ ...blonde, artistName: 'Someone Else', collectionName: 'Covers' }, blonde], calls);
  const artwork = await lookupArtwork({ name: 'Nights', artist: 'Frank Ocean', album: 'Blonde' }, { fetchImpl });
  assert.equal(artwork.imageUrl, 'https://is1.mzstatic.com/blonde/512x512bb.jpg');
  assert.equal(artwork.albumId, '1146195596');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, '25');
});

test('searches for the album when no song from it comes up', async () => {
  const calls = [];
  const album = { artistName: 'Frank Ocean', collectionName: 'Blonde', collectionId: 1146195596, artworkUrl100: blonde.artworkUrl100 };
  const fetchImpl = fakeSearch((params) => (params.entity === 'album' ? [album] : []), calls);
  const artwork = await lookupArtwork({ name: 'Solo', artist: 'Frank Ocean', album: 'Blonde' }, { fetchImpl });
  assert.equal(artwork.imageUrl, 'https://is1.mzstatic.com/blonde/512x512bb.jpg');
  assert.deepEqual(
    calls.map((c) => [c.entity, c.term]),
    [
      ['song', 'Solo Frank Ocean'],
      ['album', 'Blonde Frank Ocean'],
    ]
  );
});

test("tries the US store when the computer's country has no match", async () => {
  const calls = [];
  const fetchImpl = fakeSearch((params) => (params.country === 'us' ? results : []), calls);
  const artwork = await lookupArtwork({ name: 'Let You Down', artist: 'NF', album: 'Perception' }, { country: 'jp', fetchImpl });
  assert.equal(artwork.imageUrl, 'https://is1.mzstatic.com/perception/512x512bb.jpg');
  assert.deepEqual([...new Set(calls.map((c) => c.country))], ['jp', 'us']);
});

// Apple's search leaves out explicit albums with no clean version, like IGOR.
const tyler = { wrapperType: 'artist', artistName: 'Tyler, The Creator', artistId: 420368335 };
const igor = {
  wrapperType: 'collection',
  artistName: 'Tyler, The Creator',
  artistId: 420368335,
  collectionName: 'IGOR',
  collectionId: 1463409338,
  collectionExplicitness: 'explicit',
  artworkUrl100: 'https://is1.mzstatic.com/igor/100x100bb.jpg',
};
const earfquake = { ...igor, wrapperType: 'track', trackName: 'EARFQUAKE' };
const chromakopia = { ...igor, collectionName: 'CHROMAKOPIA', collectionId: 1789446415, collectionExplicitness: 'cleaned' };

test("looks through the artist's songs when Apple's search leaves the album out", async () => {
  const calls = [];
  const fetchImpl = fakeSearch((params) => {
    if (params.path === '/lookup') return params.entity === 'song' ? [tyler, earfquake] : [];
    return params.entity === 'album' ? [chromakopia] : [];
  }, calls);
  const artwork = await lookupArtwork({ name: 'EARFQUAKE', artist: 'Tyler, The Creator', album: 'IGOR' }, { fetchImpl });
  assert.equal(artwork.imageUrl, 'https://is1.mzstatic.com/igor/512x512bb.jpg');
  assert.equal(artwork.albumId, '1463409338');
  // The artist's ID came with the album search, so no artist search is needed.
  assert.deepEqual(
    calls.map((c) => [c.path, c.entity, c.id]),
    [
      ['/search', 'song', undefined],
      ['/search', 'album', undefined],
      ['/lookup', 'song', '420368335'],
    ]
  );
});

test("finds the artist, then looks through their albums, for a song that isn't among their most popular", async () => {
  const calls = [];
  const fetchImpl = fakeSearch((params) => {
    if (params.entity === 'musicArtist') return [{ ...tyler, artistName: 'Tyler Childers', artistId: 1 }, tyler];
    if (params.path === '/lookup') return params.entity === 'album' ? [tyler, chromakopia, igor] : [tyler];
    return [];
  }, calls);
  const artwork = await lookupArtwork({ name: 'GONE, GONE / THANK YOU', artist: 'Tyler, The Creator', album: 'IGOR' }, { fetchImpl });
  assert.equal(artwork.albumId, '1463409338');
  assert.deepEqual(
    calls.map((c) => [c.path, c.entity]),
    [
      ['/search', 'song'],
      ['/search', 'album'],
      ['/search', 'musicArtist'],
      ['/lookup', 'song'],
      ['/lookup', 'album'],
    ]
  );
});

test("a collaboration is looked up under its first artist", async () => {
  const calls = [];
  const dave = { wrapperType: 'artist', artistName: 'Dave', artistId: 1 };
  const sprinter = {
    wrapperType: 'track',
    artistName: 'Dave & Central Cee',
    trackName: 'Sprinter',
    collectionName: 'Sprinter - Single',
    collectionId: 1689467155,
    artworkUrl100: 'https://is1.mzstatic.com/sprinter/100x100bb.jpg',
  };
  const fetchImpl = fakeSearch((params) => {
    if (params.entity === 'musicArtist') return params.term === 'Dave' ? [dave] : [];
    if (params.path === '/lookup') return params.id === '1' && params.entity === 'song' ? [dave, sprinter] : [];
    return [];
  }, calls);
  const artwork = await lookupArtwork({ name: 'Sprinter', artist: 'Dave & Central Cee', album: 'Sprinter - Single' }, { fetchImpl });
  assert.equal(artwork.albumId, '1689467155');
  assert.deepEqual(
    calls.filter((c) => c.entity === 'musicArtist').map((c) => c.term),
    ['Dave & Central Cee', 'Dave']
  );
});

test('a failed lookup is retried during the song, waiting longer each time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let online = false;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!online) throw new Error('offline');
    return { ok: true, json: async () => ({ results }) };
  };
  let late = 0;
  const options = { country: 'nz', fetchImpl, onLate: () => late++ };
  const track = { name: 'Let You Down', artist: 'NF', album: 'Perception' };

  assert.equal(await lookupArtwork(track, options), null);
  t.mock.timers.tick(29_000);
  assert.equal(await lookupArtwork(track, options), null);
  assert.equal(calls.length, 1, "doesn't retry before 30 seconds");
  t.mock.timers.tick(1_200);
  assert.equal(late, 1, 'asks for an update once the retry is due');

  assert.equal(await lookupArtwork(track, options), null);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(30_200);
  assert.equal(late, 1, 'waits 60 seconds after a second failure');
  t.mock.timers.tick(30_000);
  assert.equal(late, 2);

  online = true;
  const artwork = await lookupArtwork(track, options);
  assert.equal(artwork.imageUrl, 'https://is1.mzstatic.com/perception/512x512bb.jpg');
});

test('a song with no match is looked up again an hour later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const fetchImpl = fakeSearch(() => [], calls);
  const track = { name: 'Home Recording', artist: 'Me', album: 'Voice Memos' };
  assert.equal(await lookupArtwork(track, { fetchImpl }), null);
  const searches = calls.length;
  assert.equal(await lookupArtwork(track, { fetchImpl }), null);
  assert.equal(calls.length, searches);
  t.mock.timers.tick(61 * 60 * 1000);
  await lookupArtwork(track, { fetchImpl });
  assert.equal(calls.length, searches * 2);
});

const coverList = {
  version: 1,
  covers: {
    1440848910: { artist: 'NF', album: 'Perception', url: 'covers/1440848910.webp' },
    1700000000: { artist: 'Taylor Swift', album: 'The Tortured Poets Department', url: 'covers/1700000000.webp' },
  },
};
const LIST_URL = 'https://example.github.io/covers/index.json';

test('animated covers are found by Apple album ID', async () => {
  const calls = [];
  const fetchImpl = fakeFetch(coverList, calls);
  const url = await lookupAnimatedCover({ name: 'Let You Down', artist: 'NF' }, { albumId: '1440848910' }, { indexUrl: LIST_URL, fetchImpl });
  assert.equal(url, 'https://example.github.io/covers/covers/1440848910.webp');

  // The list is cached, so a second song doesn't download it again.
  await lookupAnimatedCover({ name: 'Paralyzed', artist: 'NF' }, { albumId: '1440848910' }, { indexUrl: LIST_URL, fetchImpl });
  assert.equal(calls.length, 1);
});

test('animated covers are found by album and artist name when the ID differs', async () => {
  const fetchImpl = fakeFetch(coverList);
  const url = await lookupAnimatedCover(
    { name: 'Fortnight', artist: 'Taylor Swift', album: 'THE TORTURED POETS DEPARTMENT (Anthology)' },
    { albumId: '999', artist: 'Taylor Swift', album: 'The Tortured Poets Department (Anthology)' },
    { indexUrl: `${LIST_URL}?names`, fetchImpl }
  );
  assert.equal(url, 'https://example.github.io/covers/covers/1700000000.webp');
});

test('no animated cover for albums not in the list, or when the list is unreachable', async () => {
  const fetchImpl = fakeFetch(coverList);
  assert.equal(await lookupAnimatedCover({ name: 'X', artist: 'Someone', album: 'Else' }, null, { indexUrl: `${LIST_URL}?miss`, fetchImpl }), null);

  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal(await lookupAnimatedCover({ name: 'X', artist: 'NF', album: 'Perception' }, null, { indexUrl: `${LIST_URL}?offline`, fetchImpl: offline }), null);
});
