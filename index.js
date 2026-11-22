const { app, clipboard, Menu, Tray, nativeImage, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { getPlayerStatus } = require('./bridge/iTunesBridge');
const DiscordIPC = require('./lib/discord-ipc');
const { buildActivity, keepTimestamps, parseTrack } = require('./lib/presence');
const { lookupArtwork, lookupAppLogo } = require('./lib/artwork');

const DISCORD_CLIENT_ID = '861702238472241162';
const POLL_INTERVAL_MS = 1000; // while a song is playing or paused
const IDLE_POLL_INTERVAL_MS = 5000; // while the player is closed or stopped
const PLAYER_NAME = process.platform === 'win32' ? 'iTunes' : 'Music';
const DEFAULT_SETTINGS = { enabled: true, showProgress: true, showArtwork: true };
const AUTOMATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';

let tray = null;
let discord = null;
let settings = { ...DEFAULT_SETTINGS };
let status = { state: 'Starting' };
let activity = null;
let menuKey = '';
let pollTimer = null;

// ---------------------------------------------------------------- settings

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function changeSetting(key, value) {
  settings[key] = value;
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.warn('Could not save settings:', error.message);
  }
  updateMenu();
  updatePresence();
}

// ---------------------------------------------------------------- presence

async function updatePresence() {
  const show = settings.enabled && (status.state === 'Playing' || status.state === 'Paused');
  const lookup = {
    country: (app.getLocaleCountryCode() || 'us').toLowerCase(),
    fetchImpl: (...args) => net.fetch(...args),
  };
  const [artwork, logo] = await Promise.all([
    show && settings.showArtwork ? lookupArtwork(parseTrack(status), lookup) : null,
    show ? lookupAppLogo(lookup) : null,
  ]);

  const next = settings.enabled ? buildActivity(status, { ...settings, logo }, artwork) : null;
  activity = keepTimestamps(next, activity);
  discord.setActivity(activity); // only sent to Discord when something changed
}

async function poll() {
  try {
    const previousError = status.error;
    status = await getPlayerStatus();
    if (status.error && status.error !== previousError) console.warn(`Couldn't read ${PLAYER_NAME}:`, status.error);
    await updatePresence();
    updateMenu();
  } catch (error) {
    console.error('Update failed:', error);
  } finally {
    const active = status.state === 'Playing' || status.state === 'Paused';
    pollTimer = setTimeout(poll, active ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
  }
}

// -------------------------------------------------------------------- tray

function menuText(text, max = 60) {
  const chars = [...text];
  const short = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
  // Windows treats "&" in menu labels as a keyboard shortcut marker.
  return process.platform === 'win32' ? short.replace(/&/g, '&&') : short;
}

function nowPlayingText() {
  switch (status.state) {
    case 'Playing':
    case 'Paused': {
      const { name, artist } = parseTrack(status);
      return `${status.state}: ${artist ? `${name} — ${artist}` : name}`;
    }
    case 'Starting':
      return 'Starting…';
    case 'Not Running':
      return `${PLAYER_NAME} isn't open`;
    case 'Error':
      return status.permission ? `Not allowed to read ${PLAYER_NAME}` : `Couldn't read ${PLAYER_NAME}: ${status.error}`;
    case 'Unsupported':
      return 'Only macOS and Windows are supported';
    default:
      return 'Nothing playing';
  }
}

function updateMenu() {
  if (!tray) return;
  const nowPlaying = nowPlayingText();
  const discordText = discord?.ready ? 'Connected to Discord' : 'Waiting for Discord…';

  // macOS asks once whether the app may control Music. If that was denied,
  // offer a shortcut to where it can be turned back on.
  const needsPermission = status.permission && process.platform === 'darwin';

  // Rebuilding the menu while it's open closes it, so only do it on changes.
  const key = JSON.stringify([nowPlaying, discordText, needsPermission, settings]);
  if (key === menuKey) return;
  menuKey = key;

  tray.setToolTip(`Apple Music Rich Presence\n${nowPlaying}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: menuText(nowPlaying), enabled: false },
      ...(needsPermission
        ? [{ label: `Allow Access to ${PLAYER_NAME}…`, click: () => shell.openExternal(AUTOMATION_SETTINGS_URL) }]
        : []),
      ...(status.details
        ? [{ label: 'Copy Error Details', click: () => clipboard.writeText(status.details) }]
        : []),
      { label: discordText, enabled: false },
      { type: 'separator' },
      {
        label: 'Show on Discord',
        type: 'checkbox',
        checked: settings.enabled,
        click: (item) => changeSetting('enabled', item.checked),
      },
      {
        label: 'Show Progress Bar',
        type: 'checkbox',
        checked: settings.showProgress,
        click: (item) => changeSetting('showProgress', item.checked),
      },
      {
        label: 'Show Album Artwork',
        type: 'checkbox',
        checked: settings.showArtwork,
        click: (item) => changeSetting('showArtwork', item.checked),
      },
      {
        label: 'Open at Login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function createTray() {
  // On macOS, "Template" images are recolored to suit light and dark menu
  // bars. Electron loads the @2x versions for high-DPI screens automatically.
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icons', file)));
  // Windows only opens the menu on right-click by default.
  if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());
  updateMenu();
}

// --------------------------------------------------------------------- app

function start() {
  // This is a menu bar app, so keep it out of the Dock.
  app.dock?.hide();

  settings = loadSettings();
  discord = new DiscordIPC(DISCORD_CLIENT_ID);
  discord.on('ready', updateMenu);
  discord.on('disconnected', updateMenu);
  discord.on('warning', (message) => console.warn(message));
  discord.connect();

  createTray();
  poll();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start);
  app.on('before-quit', () => {
    clearTimeout(pollTimer);
    discord?.close();
  });
}
