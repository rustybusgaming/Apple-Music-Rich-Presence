// Looks up album artwork for the current song and Apple's current Apple Music
// logo with Apple's public iTunes Search API, and animated covers from the
// list published by https://github.com/rustybusgaming/apple-music-animated-covers.
// Results are cached, so there's at most one request each time the song
// changes, one a day for the logo and one every 6 hours for the animated list.

const SEARCH_URL = 'https://itunes.apple.com/search';
const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const APPLE_MUSIC_APP_ID = 1108187390; // Apple Music (com.apple.Music) on the App Store
const CACHE_LIMIT = 200;
const LOGO_REFRESH_MS = 24 * 60 * 60 * 1000;
const ANIMATED_COVERS_URL = 'https://rustybusgaming.github.io/apple-music-animated-covers/index.json';
const ANIMATED_REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_FAILED_AFTER_MS = 5 * 60 * 1000;

const cache = new Map(); // key -> { value, expires }
const pending = new Map(); // key -> Promise

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

function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 2;
  return a.includes(b) || b.includes(a) ? 1 : 0;
}

function pickBest(results, track) {
  let best = null;
  let bestScore = 0;
  for (const result of results) {
    const name = similarity(result.trackName, track.name);
    const artist = track.artist ? similarity(result.artistName, track.artist) : 1;
    if (!name || !artist) continue;
    const album = track.album ? similarity(result.collectionName, track.album) : 0;
    const score = name * 3 + artist * 2 + album;
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

async function search(track, country, fetchImpl) {
  const params = new URLSearchParams({
    term: [track.name, track.artist].filter(Boolean).join(' '),
    media: 'music',
    entity: 'song',
    limit: '10',
    country,
  });
  const response = await fetchImpl(`${SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`iTunes Search API returned ${response.status}`);
  const { results = [] } = await response.json();
  return toArtwork(pickBest(results, track));
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
function cached(key, load, { ttl, wait, onLate }) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  const fallback = hit?.value ?? null;

  let request = pending.get(key);
  if (!request) {
    request = load()
      .then(
        (value) => remember(key, value, Date.now() + ttl),
        () => remember(key, fallback, Date.now() + RETRY_FAILED_AFTER_MS)
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
  return cached(key, () => search(track, country, fetchImpl), { ttl: Infinity, wait, onLate });
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
