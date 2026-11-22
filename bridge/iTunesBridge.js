// Runs the platform's bridge script (OSABridge.js on macOS, WSBridge.js on
// Windows) and returns what the player is doing:
//   { state: 'Playing' | 'Paused' | 'Stopped' | 'Not Running' | 'Unsupported',
//     name, artist, album, duration, elapsed, streamTitle }

const { execFile } = require('child_process');
const path = require('path');

// osascript/cscript can't read files inside an asar archive, so use the
// unpacked copy if the app is ever packaged with asar.
const BRIDGE_DIR = __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');

const COMMANDS = {
  darwin: ['/usr/bin/osascript', ['-l', 'JavaScript', path.join(BRIDGE_DIR, 'OSABridge.js')]],
  win32: ['cscript', ['//Nologo', path.join(BRIDGE_DIR, 'WSBridge.js')]],
};

function getPlayerStatus() {
  const command = COMMANDS[process.platform];
  if (!command) return Promise.resolve({ state: 'Unsupported' });

  return new Promise((resolve) => {
    const options = { encoding: 'utf8', timeout: 10000, windowsHide: true };
    execFile(command[0], command[1], options, (error, stdout) => {
      if (error) return resolve({ state: 'Not Running', error: error.message });
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ state: 'Not Running', error: `Unexpected output: ${stdout.trim()}` });
      }
    });
  });
}

module.exports = { getPlayerStatus };
