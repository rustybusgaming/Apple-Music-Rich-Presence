// Runs the platform's bridge script (OSABridge.js on macOS, WSBridge.js on
// Windows) and returns what the player is doing:
//   { state: 'Playing' | 'Paused' | 'Stopped' | 'Not Running' | 'Unsupported',
//     name, artist, album, duration, elapsed, streamTitle }
// or, when the script fails, { state: 'Error', error, permission, details }.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLAYER_NAME = process.platform === 'win32' ? 'iTunes' : 'Music';

// osascript/cscript can't read files inside an asar archive, so use the
// unpacked copy if the app is ever packaged with asar.
const BRIDGE_DIR = __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');

function commandFor(platform) {
  if (platform === 'darwin') {
    // Pass the script's text rather than its path. macOS may run a downloaded
    // app from a temporary, quarantined copy (App Translocation), and
    // osascript can refuse to load script files from there.
    const script = fs.readFileSync(path.join(__dirname, 'OSABridge.js'), 'utf8');
    return ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]];
  }
  if (platform === 'win32') return ['cscript', ['//Nologo', path.join(BRIDGE_DIR, 'WSBridge.js')]];
  return null;
}

const COMMAND = commandFor(process.platform);

// Generous, because the first run can sit on macOS's "wants to control
// Music" prompt until the user answers it.
const TIMEOUT_MS = 60000;

// Drops what osascript puts in front of the actual reason, e.g.
// "osascript: /path/OSABridge.js: execution error: Error: Error: Can't get object. (-1728)"
function cleanMessage(line) {
  return line
    .replace(/^osascript:\s*/, '')
    .replace(/^.*?\.js:\s*/, '')
    .replace(/^execution error:\s*/, '')
    .replace(/^(Error:\s*)+/, '')
    .trim();
}

/**
 * Turns a failed run into a status that says what went wrong. `details` keeps
 * the full output for the tray's "Copy Error Details" item.
 */
function describeError(error, stderr = '') {
  const output = String(stderr).trim();
  const details = output || error.message;
  if (/-1743|not authori[sz]ed to send apple events/i.test(details)) {
    return { state: 'Error', permission: true, error: `Not allowed to control ${PLAYER_NAME}`, details };
  }
  if (error.killed) return { state: 'Error', error: `${PLAYER_NAME} didn't respond`, details };
  const lastLine = output.split('\n').filter((line) => line.trim()).pop();
  const message = lastLine ? cleanMessage(lastLine) : `The script stopped with exit code ${error.code}`;
  return { state: 'Error', error: message, details };
}

function getPlayerStatus() {
  const command = COMMAND;
  if (!command) return Promise.resolve({ state: 'Unsupported' });

  return new Promise((resolve) => {
    const options = { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true };
    execFile(command[0], command[1], options, (error, stdout, stderr) => {
      if (error) return resolve(describeError(error, stderr));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        const output = stdout.trim() || '(nothing)';
        resolve({ state: 'Error', error: `Unexpected output: ${output}`, details: `${output}\n${stderr}`.trim() });
      }
    });
  });
}

module.exports = { getPlayerStatus, describeError, commandFor };
