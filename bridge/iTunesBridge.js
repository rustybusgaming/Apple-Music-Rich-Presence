// Runs the platform's bridge script (OSABridge.js on macOS, WSBridge.js on
// Windows) and returns what the player is doing:
//   { state: 'Playing' | 'Paused' | 'Stopped' | 'Not Running' | 'Unsupported',
//     name, artist, album, duration, elapsed, streamTitle }
// or, when the script fails, { state: 'Error', error, permission }.

const { execFile } = require('child_process');
const path = require('path');

const PLAYER_NAME = process.platform === 'win32' ? 'iTunes' : 'Music';

// osascript/cscript can't read files inside an asar archive, so use the
// unpacked copy if the app is ever packaged with asar.
const BRIDGE_DIR = __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');

const COMMANDS = {
  darwin: ['/usr/bin/osascript', ['-l', 'JavaScript', path.join(BRIDGE_DIR, 'OSABridge.js')]],
  win32: ['cscript', ['//Nologo', path.join(BRIDGE_DIR, 'WSBridge.js')]],
};

// Generous, because the first run can sit on macOS's "wants to control
// Music" prompt until the user answers it.
const TIMEOUT_MS = 60000;

/** Turns a failed run into a status that says what went wrong. */
function describeError(error, stderr = '') {
  const output = `${stderr}\n${error.message}`;
  if (/-1743|not authori[sz]ed to send apple events/i.test(output)) {
    return { state: 'Error', permission: true, error: `Not allowed to control ${PLAYER_NAME}` };
  }
  if (error.killed) return { state: 'Error', error: `${PLAYER_NAME} didn't respond` };
  const lines = (stderr.trim() || error.message).split('\n').filter((line) => line.trim());
  return { state: 'Error', error: lines.pop().trim() };
}

function getPlayerStatus() {
  const command = COMMANDS[process.platform];
  if (!command) return Promise.resolve({ state: 'Unsupported' });

  return new Promise((resolve) => {
    const options = { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true };
    execFile(command[0], command[1], options, (error, stdout, stderr) => {
      if (error) return resolve(describeError(error, stderr));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ state: 'Error', error: `Unexpected output: ${stdout.trim() || '(nothing)'}` });
      }
    });
  });
}

module.exports = { getPlayerStatus, describeError };
