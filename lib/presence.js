// Turns the player status reported by the bridge scripts into a Discord
// activity payload. Everything here is a pure function so it's easy to test.

const ACTIVITY_LISTENING = 2; // shows as "Listening to Apple Music"
const TEXT_LIMIT = 128; // Discord rejects text shorter than 2 or longer than 128 chars
const URL_LIMIT = 512;
const SEEK_TOLERANCE_MS = 3000;

function fitText(value) {
  let chars = [...String(value ?? '').trim()];
  if (chars.length > TEXT_LIMIT) chars = [...chars.slice(0, TEXT_LIMIT - 1), '…'];
  return chars.join('').padEnd(2, '​');
}

function searchUrl(base, terms) {
  let chars = [...terms];
  let url = base + encodeURIComponent(terms);
  while (url.length > URL_LIMIT && chars.length) {
    chars = chars.slice(0, -1);
    url = base + encodeURIComponent(chars.join(''));
  }
  return url;
}

/** Works out the real song, artist and album from what the player reports. */
function parseTrack(status = {}) {
  let name = String(status.name || '').trim();
  let artist = String(status.artist || '').trim();
  let album = String(status.album || '').trim();
  const streamTitle = String(status.streamTitle || '').trim();

  // Internet radio reports the station as the track and the song that's
  // actually playing as the stream title.
  if (streamTitle && streamTitle !== name) {
    album = album || name;
    name = streamTitle;
    artist = '';
  }

  // Radio streams and untagged files often use "Artist - Title" as the name.
  // Only split when there's no artist, so titles like "Song - Remastered 2011"
  // keep their real artist.
  if (!artist) {
    const separator = name.indexOf(' - ');
    if (separator > 0) {
      artist = name.slice(0, separator).trim();
      name = name.slice(separator + 3).trim();
    }
  }

  return { name, artist, album };
}

/**
 * Builds the activity to send to Discord, or null when nothing should be shown.
 * `artwork` is the optional result of lookupArtwork(), and `logo` the optional
 * URL from lookupAppLogo(), shown when there's no album artwork.
 */
function buildActivity(status, { showProgress = true, logo = null } = {}, artwork = null, now = Date.now()) {
  const playing = status.state === 'Playing';
  if (!playing && status.state !== 'Paused') return null;

  const { name, artist, album } = parseTrack(status);
  if (!name) return null;

  const terms = artist ? `${name} ${artist}` : name;
  let byline;
  if (playing) byline = artist ? `by ${artist}` : 'Unknown artist';
  else byline = artist ? `Paused · ${artist}` : 'Paused';

  const activity = {
    type: ACTIVITY_LISTENING,
    details: fitText(name),
    state: fitText(byline),
    assets: {
      // 'applemusic' is the logo uploaded to the Discord application, used
      // only if Apple's current logo couldn't be looked up.
      large_image: artwork?.imageUrl || logo || 'applemusic',
      large_text: fitText(album || 'Apple Music'),
      small_image: playing ? 'pause' : 'play',
      small_text: playing ? 'Playing' : 'Paused',
    },
    buttons: [
      artwork?.trackUrl
        ? { label: 'Listen on Apple Music', url: artwork.trackUrl }
        : { label: 'Search on Apple Music', url: searchUrl('https://music.apple.com/us/search?term=', terms) },
      { label: 'Search on Spotify', url: searchUrl('https://open.spotify.com/search/', terms) },
    ],
  };

  if (playing) {
    const elapsed = Math.max(0, Number(status.elapsed) || 0);
    const duration = Number(status.duration) || 0;
    const start = Math.round(now - elapsed * 1000);
    activity.timestamps = { start };
    if (showProgress && duration > elapsed) activity.timestamps.end = Math.round(start + duration * 1000);
  }

  return activity;
}

/**
 * The start time is recalculated on every poll, so it wobbles by a few hundred
 * milliseconds. Keep the previous timestamps unless the song changed or the
 * user seeked, so we only update Discord when something actually changed.
 */
function keepTimestamps(next, previous, tolerance = SEEK_TOLERANCE_MS) {
  const before = previous?.timestamps;
  const after = next?.timestamps;
  if (!before || !after || next.details !== previous.details || next.state !== previous.state) return next;

  const drift = before.start - after.start;
  if (Math.abs(drift) > tolerance) return next;

  const timestamps = { start: before.start };
  if (after.end) timestamps.end = after.end + drift;
  return { ...next, timestamps };
}

module.exports = { buildActivity, keepTimestamps, parseTrack, fitText, searchUrl };
