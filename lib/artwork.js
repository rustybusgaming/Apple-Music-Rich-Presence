// Looks up album artwork for the current song and Apple's current Apple Music
// logo with Apple's public iTunes Search API, and animated covers from the
// list published by https://github.com/rustybusgaming/apple-music-animated-covers.
// Results are cached, so there's one request each time the song changes (a
// few when Apple's search can't find it), one a day for the logo and one every
// 6 hours for the animated list.

const SEARCH_URL = 'https://itunes.apple.com/search';
const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const APPLE_MUSIC_APP_ID = 1108187390; // Apple Music (com.apple.Music) on the App Store
const CACHE_LIMIT = 200;
const LOGO_REFRESH_MS = 24 * 60 * 60 * 1000;
const ANIMATED_COVERS_URL = 'https://rustybusgaming.github.io/apple-music-animated-covers/index.json';
const ANIMATED_REFRESH_MS = 6 * 60 * 60 * 1000;
// A failed request (a network blip, or Apple's limit of about 20 searches a
// minute) is retried after 30 seconds, then less often if it keeps failing.
const RETRY_FAILED_AFTER_MS = 30 * 1000;
const RETRY_FAILED_MAX_MS = 10 * 60 * 1000;
// A song Apple has no match for is looked up again if it plays an hour later.
const RETRY_MISSING_AFTER_MS = 60 * 60 * 1000;

// Artists' song and album lists, kept so that the next song by the same
// artist doesn't need them again (Apple allows about 20 requests a minute).
const ARTIST_CACHE_MS = 6 * 60 * 60 * 1000;
const ARTIST_CACHE_LIMIT = 20;

const cache = new Map(); // key -> { value, expires }
const pending = new Map(); // key -> Promise
const failures = new Map(); // key -> failures in a row
const artistCache = new Map(); // key -> { promise, expires }

function clean(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Ignore "(feat. …)", "[Remastered]", "(Deluxe Edition)" and so on, unless
// that's all there is.
function normalize(text) {
  const value = String(text || '');
  return clean(value.replace(/\s*[([][^)\]]*[)\]]/g, '')) || clean(value);
}

// 2 when the names are the same, 1 when one contains the other as whole
// words ("Encore" in "Encore - Deluxe", but not "U" in "Music"), otherwise 0.
function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 2;
  return ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `) ? 1 : 0;
}

// The artists credited in "A & B", "A, B", "A x B", "A feat. B" or "A with B".
const ARTIST_SEPARATOR = /\s*(?:&|,|\s+x\s+|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bwith\b)\s*/i;

function artistNames(text) {
  return String(text || '')
    .split(ARTIST_SEPARATOR)
    .map(normalize)
    .filter(Boolean);
}

// 2 for the same artist, 1 when they share one of their credited artists
// ("Kendrick Lamar & SZA" and "Kendrick Lamar"), otherwise 0: a name that's
// only part of another ("underscores" and "TMS Underscores") is someone else.
function artistSimilarity(a, b) {
  if (!normalize(a) || !normalize(b)) return 0;
  if (normalize(a) === normalize(b)) return 2;
  const names = new Set(artistNames(a));
  return artistNames(b).some((name) => names.has(name)) ? 1 : 0;
}

// Names that are the same including any "(Director's Cut)" or "(Remix)", which
// similarity() ignores: preferred when both versions are in the results.
function sameText(a, b) {
  return Boolean(a && b) && clean(String(a)) === clean(String(b));
}

// A compilation or DJ mix: an album by someone else, with their cover.
function isCompilation(result, track) {
  return Boolean(result.collectionArtistName) && !artistSimilarity(result.collectionArtistName, track.artist);
}

// The result for this song. With `sameAlbum`, only one from the album it's on;
// otherwise any of the artist's own albums (a single, say), but not someone
// else's compilation.
function pickBest(results, track, { sameAlbum = false } = {}) {
  let best = null;
  let bestScore = 0;
  for (const result of results) {
    const name = similarity(result.trackName, track.name);
    const artist = track.artist ? artistSimilarity(result.artistName, track.artist) : 1;
    if (!name || !artist) continue;
    const album = track.album ? similarity(result.collectionName, track.album) : 0;
    if (!album && (isCompilation(result, track) || (sameAlbum && track.album))) continue;
    const exact = (sameText(result.trackName, track.name) ? 0.5 : 0) + (sameText(result.collectionName, track.album) ? 0.5 : 0);
    const score = name * 3 + artist * 2 + album + exact;
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }
  return best;
}

// Another song from the same album (or the album itself) has the same cover.
function pickAlbum(results, track) {
  if (!track.album) return null;
  let best = null;
  let bestScore = 0;
  for (const result of results) {
    const album = similarity(result.collectionName, track.album);
    const artist = track.artist
      ? Math.max(artistSimilarity(result.artistName, track.artist), artistSimilarity(result.collectionArtistName, track.artist))
      : 1;
    if (!album || !artist) continue;
    const score = album * 2 + artist + (sameText(result.collectionName, track.album) ? 0.5 : 0);
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }
  return best;
}

function imageUrl(url) {
  const large = url?.replace(/\/\d+x\d+bb\./, '/512x512bb.');
  return large && large.length <= 256 ? large : null;
}

function toArtwork(result) {
  if (!result) return null;
  return {
    imageUrl: imageUrl(result.artworkUrl100),
    albumId: result.collectionId ? String(result.collectionId) : null,
    artist: result.artistName,
    album: result.collectionName,
  };
}

async function requestItunes(url, params, fetchImpl) {
  const response = await fetchImpl(`${url}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`iTunes Search API returned ${response.status}`);
  return (await response.json()).results || [];
}

function searchItunes(params, fetchImpl) {
  return requestItunes(SEARCH_URL, { term: params.term, media: 'music', ...params }, fetchImpl);
}

// Runs `load` once for `key` every few hours, sharing the answer. Failures
// aren't kept.
function fromArtistCache(key, load) {
  const hit = artistCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = load();
  artistCache.delete(key);
  if (artistCache.size >= ARTIST_CACHE_LIMIT) artistCache.delete(artistCache.keys().next().value);
  artistCache.set(key, { promise, expires: Date.now() + ARTIST_CACHE_MS });
  promise.catch(() => artistCache.get(key)?.promise === promise && artistCache.delete(key));
  return promise;
}

// The artist's ID, from results that are already in or with an artist search.
// A collaboration ("Dave & Central Cee") is often only listed under its first
// artist, so that's tried too.
async function findArtistId(track, results, country, fetchImpl) {
  const first = track.artist.split(ARTIST_SEPARATOR)[0];
  const names = [...new Set([track.artist, first].filter(Boolean))];
  const find = (list) => {
    for (const name of names) {
      const hit = list.find((result) => result.artistId && similarity(result.artistName, name) === 2);
      if (hit) return hit.artistId;
    }
    return null;
  };
  let id = find(results);
  for (const name of names) {
    if (id) break;
    const artists = await fromArtistCache(['artist', country, normalize(name)].join('\n'), () =>
      searchItunes({ term: name, entity: 'musicArtist', limit: '10', country }, fetchImpl)
    );
    id = find(artists);
  }
  return id;
}

async function searchStore(track, country, fetchImpl) {
  // The cover is the album's, so look for the album the song is on. Apple's
  // search doesn't always have the song from it: it can leave the song out,
  // rank a cover version first, or only have it on a compilation. So fall
  // back to another song from the same album, then to the album itself.
  const sameAlbum = (results) => pickBest(results, track, { sameAlbum: true }) || pickAlbum(results, track);
  const term = [track.name, track.artist].filter(Boolean).join(' ');
  const songs = await searchItunes({ term, entity: 'song', limit: '25', country }, fetchImpl);
  let match = sameAlbum(songs);
  if (match) return match;
  let albums = [];
  if (track.album) {
    const albumTerm = [track.album, track.artist].filter(Boolean).join(' ');
    albums = await searchItunes({ term: albumTerm, entity: 'album', limit: '10', country }, fetchImpl);
    match = pickAlbum(albums, track);
    if (match) return match;
  }

  // Apple's search also leaves out explicit albums that have no clean version
  // (a lot of hip hop), but looking up the artist lists all their songs and
  // albums: their 200 most popular songs, then their albums.
  const artistId = track.artist && (await findArtistId(track, [...songs, ...albums], country, fetchImpl));
  let catalog = [];
  if (artistId) {
    const lookup = (entity) =>
      fromArtistCache([entity, country, artistId].join('\n'), () =>
        requestItunes(LOOKUP_URL, { id: String(artistId), entity, limit: '200', country }, fetchImpl)
      );
    catalog = await lookup('song');
    match = sameAlbum(catalog);
    if (match) return match;
    if (track.album) {
      match = pickAlbum(await lookup('album'), track);
      if (match) return match;
    }
  }
  // The album isn't anywhere: use the song from another of the artist's albums.
  return pickBest([...songs, ...catalog], track);
}

async function search(track, country, fetchImpl) {
  let match = await searchStore(track, country, fetchImpl);
  // The computer's region isn't always the Apple Music account's country.
  if (!match && country !== 'us') match = await searchStore(track, 'us', fetchImpl);
  return toArtwork(match);
}

function remember(key, value, expires) {
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires });
  return value;
}

// Returns the cached value for `key`, loading it with `load()` when missing or
// expired. Waits at most `wait` ms so a slow request never holds up the
// presence; if it finishes later, `onLate` is called so the caller can update.
function cached(key, load, { ttl, missTtl = ttl, wait, onLate }) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  const fallback = hit?.value ?? null;

  let request = pending.get(key);
  if (!request) {
    request = load()
      .then(
        (value) => {
          failures.delete(key);
          return remember(key, value, Date.now() + (value == null ? missTtl : ttl));
        },
        () => {
          // Try again later, and tell the caller then, so a song that's still
          // playing gets its artwork without waiting for the next song.
          const count = (failures.get(key) || 0) + 1;
          failures.delete(key);
          if (failures.size >= CACHE_LIMIT) failures.delete(failures.keys().next().value);
          failures.set(key, count);
          const delay = Math.min(RETRY_FAILED_AFTER_MS * 2 ** (count - 1), RETRY_FAILED_MAX_MS);
          if (onLate) setTimeout(onLate, delay + 100).unref?.();
          return remember(key, fallback, Date.now() + delay);
        }
      )
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }

  let timedOut = false;
  const timeout = new Promise((resolve) =>
    setTimeout(() => {
      timedOut = true;
      resolve(fallback);
    }, wait).unref?.()
  );
  if (onLate) request.then(() => timedOut && onLate());
  return Promise.race([request, timeout]);
}

/** Resolves to { imageUrl, albumId, artist, album } for the song, or null. */
function lookupArtwork(track, { country = 'us', wait = 1500, fetchImpl = globalThis.fetch, onLate } = {}) {
  if (!track?.name) return Promise.resolve(null);
  const key = ['track', track.name, track.artist, track.album, country].join('\n').toLowerCase();
  return cached(key, () => search(track, country, fetchImpl), {
    ttl: Infinity,
    missTtl: RETRY_MISSING_AFTER_MS,
    wait,
    onLate,
  });
}

/** Resolves to the URL of Apple's current Apple Music app icon, or null. */
function lookupAppLogo({ country = 'us', wait = 1500, fetchImpl = globalThis.fetch, onLate } = {}) {
  return cached(
    `logo\n${country}`,
    async () => {
      const params = new URLSearchParams({ id: APPLE_MUSIC_APP_ID, country });
      const response = await fetchImpl(`${LOOKUP_URL}?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`iTunes Lookup API returned ${response.status}`);
      const { results = [] } = await response.json();
      const url = imageUrl(results[0]?.artworkUrl512);
      if (!url) throw new Error('No logo in the lookup result');
      return url;
    },
    { ttl: LOGO_REFRESH_MS, wait, onLate }
  );
}

/** Resolves to the list of animated covers, or null if it couldn't be loaded. */
function lookupAnimatedCovers({ indexUrl = ANIMATED_COVERS_URL, wait = 1500, fetchImpl = globalThis.fetch, onLate } = {}) {
  return cached(
    `animated\n${indexUrl}`,
    async () => {
      const response = await fetchImpl(indexUrl, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`The animated cover list returned ${response.status}`);
      return { indexUrl, covers: (await response.json()).covers || {} };
    },
    { ttl: ANIMATED_REFRESH_MS, wait, onLate }
  );
}

/**
 * Finds the URL of the animated version of the album's cover in the list from
 * lookupAnimatedCovers(), or null. `artwork` is the result of lookupArtwork(),
 * if there is one: its album ID gives an exact match. Otherwise the album and
 * artist names are compared.
 */
function findAnimatedCover(list, track, artwork) {
  if (!list) return null;
  const { covers, indexUrl } = list;
  let entry = artwork?.albumId ? covers[artwork.albumId] : null;
  if (!entry) {
    const album = normalize(artwork?.album || track?.album);
    const artist = normalize(artwork?.artist || track?.artist);
    if (album && artist) {
      entry = Object.values(covers).find((cover) => normalize(cover.album) === album && normalize(cover.artist) === artist);
    }
  }
  if (!entry?.url) return null;
  const url = new URL(entry.url, indexUrl).href;
  return url.length <= 256 ? url : null;
}

/** Looks up the list and finds the album's animated cover in one go. */
async function lookupAnimatedCover(track, artwork, options) {
  return findAnimatedCover(await lookupAnimatedCovers(options), track, artwork);
}

module.exports = {
  lookupArtwork,
  lookupAppLogo,
  lookupAnimatedCovers,
  findAnimatedCover,
  lookupAnimatedCover,
  pickBest,
  normalize,
};
