// Looks up album artwork and a direct Apple Music link for the current song
// with Apple's public iTunes Search API. Results are cached per song, so
// there's at most one request each time the song changes.

const SEARCH_URL = 'https://itunes.apple.com/search';
const CACHE_LIMIT = 200;
const RETRY_FAILED_AFTER_MS = 5 * 60 * 1000;

const cache = new Map(); // key -> { value, expires }
const pending = new Map(); // key -> Promise

function clean(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
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

function toArtwork(result) {
  if (!result) return null;
  const imageUrl = result.artworkUrl100?.replace(/\/\d+x\d+bb\./, '/512x512bb.');
  const trackUrl = result.trackViewUrl;
  return {
    imageUrl: imageUrl && imageUrl.length <= 256 ? imageUrl : null,
    trackUrl: trackUrl && trackUrl.length <= 512 ? trackUrl : null,
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
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires });
  return value;
}

/**
 * Resolves to { imageUrl, trackUrl } or null. Waits at most `wait` ms so a
 * slow lookup never holds up the presence; the result is cached and picked
 * up on a later poll once it arrives.
 */
function lookupArtwork(track, { country = 'us', wait = 1500, fetchImpl = globalThis.fetch } = {}) {
  if (!track?.name) return Promise.resolve(null);
  const key = [track.name, track.artist, track.album, country].join('\n').toLowerCase();

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);

  let request = pending.get(key);
  if (!request) {
    request = search(track, country, fetchImpl)
      .then(
        (value) => remember(key, value, Infinity),
        () => remember(key, null, Date.now() + RETRY_FAILED_AFTER_MS)
      )
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }

  const timeout = new Promise((resolve) => setTimeout(resolve, wait, null).unref?.());
  return Promise.race([request, timeout]);
}

module.exports = { lookupArtwork, pickBest, normalize };
