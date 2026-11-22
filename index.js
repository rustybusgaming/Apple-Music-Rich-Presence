const { app, clipboard, dialog, Menu, Notification, Tray, nativeImage, net, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PlayerWatcher, PLAYER_NAME } = require('./bridge/player');
const DiscordIPC = require('./lib/discord-ipc');
const { buildActivity, keepTimestamps, parseTrack } = require('./lib/presence');
const { lookupArtwork, lookupAppLogo, lookupAnimatedCovers, findAnimatedCover } = require('./lib/artwork');
const { checkForUpdate } = require('./lib/updates');

const DISCORD_CLIENT_ID = '861702238472241162';
const DEFAULT_SETTINGS = { enabled: true, showProgress: true, showArtwork: true, showAnimated: true, includeBrowsers: false };
const AUTOMATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
const IS_LINUX = process.platform === 'linux' || process.platform === 'freebsd';
const UPDATE_CHECK_DELAY_MS = 30 * 1000; // after starting
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// This app shows no web pages, so Chromium's sandbox isn't needed. On Linux it
// can stop the app from starting at all (newer Ubuntu releases restrict what it
// relies on). That check happens before this code runs, so the Linux download
// starts the app through a launcher script that passes --no-sandbox; this line
// keeps the sandbox off for the app's helper processes too.
if (IS_LINUX) app.commandLine.appendSwitch('no-sandbox');

let tray = null;
let discord = null;
let settings = { ...DEFAULT_SETTINGS };
let status = { state: 'Starting' };
let activity = null;
let menuKey = '';
let watcher = null;
let availableUpdate = null; // { version, url } when a newer release is out
let updateTimer = null;
let updateNotification = null; // kept so its click handler isn't garbage collected

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

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.warn('Could not save settings:', error.message);
  }
}

function changeSetting(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === 'includeBrowsers') watcher?.setEnv(watcherEnv());
  updateMenu();
  updatePresence();
}

// Settings the player script reads.
function watcherEnv() {
  return { AMRPC_INCLUDE_BROWSERS: settings.includeBrowsers ? '1' : '0' };
}

// ------------------------------------------------------------ open at login

// Electron handles this on macOS and Windows. Linux desktops start the apps
// listed in ~/.config/autostart instead.
function autostartFile() {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', 'apple-music-rich-presence.desktop');
}

function getOpenAtLogin() {
  return IS_LINUX ? fs.existsSync(autostartFile()) : app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(enabled) {
  if (!IS_LINUX) return app.setLoginItemSettings({ openAtLogin: enabled });
  try {
    if (!enabled) return fs.rmSync(autostartFile(), { force: true });
    // An AppImage sets APPIMAGE to its own path; otherwise run this binary
    // (when running from source, that's Electron, so add the app's folder).
    const program = process.env.APPIMAGE || process.execPath;
    const exec = app.isPackaged ? `"${program}" --no-sandbox` : `"${program}" --no-sandbox "${app.getAppPath()}"`;
    fs.mkdirSync(path.dirname(autostartFile()), { recursive: true });
    fs.writeFileSync(
      autostartFile(),
      `[Desktop Entry]\nType=Application\nName=Apple Music Rich Presence\nExec=${exec}\nX-GNOME-Autostart-enabled=true\n`
    );
  } catch (error) {
    console.warn('Could not change Open at Login:', error.message);
  }
}

// ----------------------------------------------------------------- updates

// Checks GitHub for a newer release. Automatic checks are quiet apart from a
// menu item and one notification per new version; a manual check always says
// what it found.
async function checkForUpdates({ manual = false } = {}) {
  let result;
  try {
    result = await checkForUpdate(app.getVersion(), { fetchImpl: (...args) => net.fetch(...args) });
  } catch (error) {
    console.warn("Couldn't check for updates:", error.message);
    if (manual) await showDialog({ type: 'warning', message: "Couldn't check for updates", detail: error.message });
    return;
  }

  availableUpdate = result.newer ? result : null;
  updateMenu();

  if (manual) {
    if (!result.newer) {
      await showDialog({
        type: 'info',
        message: "You're up to date",
        detail: `Apple Music Rich Presence ${app.getVersion()} is the latest version.`,
      });
      return;
    }
    const { response } = await showDialog({
      type: 'info',
      message: `Version ${result.version} is available`,
      detail: `You have version ${app.getVersion()}. Download the new version?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(result.url);
  } else if (result.newer && settings.notifiedVersion !== result.version) {
    settings.notifiedVersion = result.version;
    saveSettings();
    notifyUpdate(result);
  }
}

function notifyUpdate(update) {
  const title = 'Apple Music Rich Presence update';
  const body = `Version ${update.version} is available. Click to download it.`;
  // Windows only shows standard notifications for installed apps (with a
  // Start menu shortcut), which a zip download isn't, so use the tray's own.
  if (process.platform === 'win32') {
    tray.displayBalloon({ title, content: body, iconType: 'info' });
    return;
  }
  if (!Notification.isSupported()) return;
  updateNotification = new Notification({ title, body });
  updateNotification.on('click', () => shell.openExternal(update.url));
  updateNotification.show();
}

function showDialog(options) {
  // With no windows (and no Dock icon), make sure the dialog comes to the front.
  if (process.platform === 'darwin') app.focus({ steal: true });
  return dialog.showMessageBox({ title: 'Apple Music Rich Presence', ...options });
}

function scheduleUpdateChecks() {
  updateTimer = setTimeout(function check() {
    checkForUpdates();
    updateTimer = setTimeout(check, UPDATE_CHECK_INTERVAL_MS);
  }, UPDATE_CHECK_DELAY_MS);
}

// ---------------------------------------------------------------- presence

let presenceRun = 0;

async function updatePresence() {
  // Lookups can take a moment, so a newer update (a song change, say) can
  // start before this one finishes. Work from a snapshot, and give up if a
  // newer update started, so an older one never overwrites it.
  const run = ++presenceRun;
  const current = status;
  const show = settings.enabled && (current.state === 'Playing' || current.state === 'Paused');
  const lookup = {
    country: (app.getLocaleCountryCode() || 'us').toLowerCase(),
    fetchImpl: (...args) => net.fetch(...args),
    // A slow lookup doesn't hold up the status; update it once it arrives.
    onLate: () => updatePresence(),
  };
  const track = parseTrack(current);
  const wantArtwork = show && settings.showArtwork;
  const [artwork, logo, animatedCovers] = await Promise.all([
    wantArtwork ? lookupArtwork(track, lookup) : null,
    show ? lookupAppLogo(lookup) : null,
    wantArtwork && settings.showAnimated ? lookupAnimatedCovers(lookup) : null,
  ]);

  // Use the animated version of the cover when there is one.
  const animated = findAnimatedCover(animatedCovers, track, artwork);
  const cover = animated ? { ...artwork, imageUrl: animated } : artwork;

  if (run !== presenceRun) return;
  const next = settings.enabled ? buildActivity(current, { ...settings, logo }, cover) : null;
  activity = keepTimestamps(next, activity);
  discord.setActivity(activity); // only sent to Discord when something changed
}

// Called by the player watcher whenever what's playing changes.
async function onPlayerStatus(next) {
  if (next.error && next.error !== status.error) console.warn(`Couldn't read ${next.player || PLAYER_NAME}:`, next.details || next.error);
  status = next;
  updateMenu();
  try {
    await updatePresence();
  } catch (error) {
    console.error('Update failed:', error);
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
      if (process.platform === 'win32') return "Apple Music and iTunes aren't open";
      if (IS_LINUX) return settings.includeBrowsers ? 'Nothing playing' : 'No Apple Music player open';
      return "Music isn't open";
    case 'Error': {
      const player = status.player || PLAYER_NAME;
      return status.permission ? `Not allowed to read ${player}` : `Couldn't read ${player}: ${status.error}`;
    }
    case 'Unsupported':
      return 'Only macOS, Windows and Linux are supported';
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
  const key = JSON.stringify([nowPlaying, discordText, needsPermission, settings, availableUpdate]);
  if (key === menuKey) return;
  menuKey = key;

  tray.setToolTip(`Apple Music Rich Presence\n${nowPlaying}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(availableUpdate
        ? [
            { label: `Update Available: ${availableUpdate.version}…`, click: () => shell.openExternal(availableUpdate.url) },
            { type: 'separator' },
          ]
        : []),
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
        label: 'Show Animated Covers',
        type: 'checkbox',
        checked: settings.showAnimated,
        enabled: settings.showArtwork,
        click: (item) => changeSetting('showAnimated', item.checked),
      },
      // Browsers report every site the same way, so the app can't tell an
      // Apple Music tab from, say, YouTube: let people opt in.
      ...(IS_LINUX
        ? [
            {
              label: 'Include Web Browsers',
              type: 'checkbox',
              checked: settings.includeBrowsers,
              click: (item) => changeSetting('includeBrowsers', item.checked),
            },
          ]
        : []),
      {
        label: 'Open at Login',
        type: 'checkbox',
        checked: getOpenAtLogin(),
        click: (item) => {
          setOpenAtLogin(item.checked);
          menuKey = ''; // show the real state, in case it couldn't be changed
          updateMenu();
        },
      },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Check for Updates…', click: () => checkForUpdates({ manual: true }) },
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
  if (process.platform === 'win32') {
    tray.on('click', () => tray.popUpContextMenu());
    tray.on('balloon-click', () => availableUpdate && shell.openExternal(availableUpdate.url));
  }
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

  watcher = new PlayerWatcher({ env: watcherEnv() });
  watcher.on('status', onPlayerStatus);
  watcher.start();

  scheduleUpdateChecks();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start);
  app.on('before-quit', () => {
    clearTimeout(updateTimer);
    watcher?.stop();
    discord?.close();
  });
}
