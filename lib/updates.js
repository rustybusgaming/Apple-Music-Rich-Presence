// Checks GitHub for a newer release of the app.

const LATEST_RELEASE_URL = 'https://api.github.com/repos/rustybusgaming/Apple-Music-Rich-Presence/releases/latest';
const RELEASES_PAGE = 'https://github.com/rustybusgaming/Apple-Music-Rich-Presence/releases/latest';

function parseVersion(version) {
  const match = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

/** True when `latest` is a higher version than `current` ("v1.4.0" > "1.3.0"). */
function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Resolves to { version, url, newer, assets } for the latest release, where
 * `newer` says whether it's newer than `currentVersion` and `assets` lists its
 * downloads ({ name, url, size, digest }). Throws if GitHub can't be reached.
 */
async function checkForUpdate(currentVersion, { fetchImpl = globalThis.fetch, url = LATEST_RELEASE_URL } = {}) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!parseVersion(version)) throw new Error(`GitHub's latest release has no version number (${release.tag_name})`);
  return {
    version,
    url: release.html_url || RELEASES_PAGE,
    newer: isNewer(version, currentVersion),
    assets: (release.assets || [])
      .filter((asset) => asset.name && asset.browser_download_url)
      .map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest })),
  };
}

module.exports = { checkForUpdate, isNewer, RELEASES_PAGE };
