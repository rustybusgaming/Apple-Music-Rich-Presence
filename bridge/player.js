// Watches the music player by running the platform's script (bridge/mac.js
// on macOS, bridge/windows.ps1 on Windows, bridge/linux.js on Linux and
// FreeBSD) in the background. The script
// prints a line of JSON whenever something changes, and this emits it as a
// 'status' event:
//   { state: 'Playing' | 'Paused' | 'Stopped' | 'Not Running' | 'Unsupported',
//     player, name, artist, album, duration, elapsed, streamTitle }
// or, when something goes wrong, { state: 'Error', error, permission, details }.
// If the script stops, it's restarted.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const PLAYER_NAME = process.platform === 'darwin' ? 'Music' : 'Apple Music';

// Scripts can't be run from inside an asar archive, so use the unpacked copy
// if the app is ever packaged with asar.
const BRIDGE_DIR = __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');

// Returns [program, args, env] for the platform's script, or null.
function commandFor(platform) {
  if (platform === 'darwin') {
    // Pass the script's text rather than its path. macOS may run a downloaded
    // app from a temporary, quarantined copy (App Translocation), and
    // osascript can refuse to load script files from there.
    const script = fs.readFileSync(path.join(__dirname, 'mac.js'), 'utf8');
    return ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]];
  }
  if (platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = path.join(BRIDGE_DIR, 'windows.ps1');
    return [powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]];
  }
  if (platform === 'linux' || platform === 'freebsd') {
    // Run it with the app's own Electron, acting as plain Node.
    return [process.execPath, [path.join(BRIDGE_DIR, 'linux.js')], { ELECTRON_RUN_AS_NODE: '1' }];
  }
  return null;
}

// Drops what osascript puts in front of the actual reason, e.g.
// "execution error: Error: Error: Can't get object. (-1728)"
function cleanMessage(text) {
  return String(text)
    .trim()
    .replace(/^osascript:\s*/, '')
    .replace(/^.*?\.js:\s*/, '')
    .replace(/^execution error:\s*/, '')
    .replace(/^(Error:\s*)+/, '')
    .trim();
}

function isPermissionError(text) {
  return /-1743|not authori[sz]ed to send apple events/i.test(text);
}

/** Tidies up an error the script reported, spotting macOS permission denials. */
function normalizeStatus(status) {
  if (status.state !== 'Error') return status;
  const details = status.details || status.error || '';
  // Permission denials only happen on macOS, where the player is Music.
  if (status.errorNumber === -1743 || isPermissionError(details)) {
    return { ...status, permission: true, error: 'Not allowed to control Music', details };
  }
  return { ...status, error: cleanMessage(details) || 'Unknown error', details };
}

/** Describes the script stopping unexpectedly. `stderr` is what it printed last. */
function describeExit(code, signal, stderr = '') {
  const output = String(stderr).trim();
  const details = output || `The player script stopped (${signal || `exit code ${code}`})`;
  if (isPermissionError(details)) {
    return { state: 'Error', permission: true, error: 'Not allowed to control Music', details };
  }
  const lastLine = output.split('\n').filter((line) => line.trim()).pop();
  return { state: 'Error', error: lastLine ? cleanMessage(lastLine) : details, details };
}

class PlayerWatcher extends EventEmitter {
  constructor({ command = commandFor(process.platform), env = {}, restartDelay = 3000, maxRestartDelay = 60000 } = {}) {
    super();
    this.command = command;
    this.env = env;
    this.restartDelay = restartDelay;
    this.maxRestartDelay = maxRestartDelay;
    this.nextDelay = restartDelay;
    this.child = null;
    this.stopped = false;
    this.restartTimer = null;
  }

  start() {
    this.stopped = false;
    if (!this.command) {
      this.emit('status', { state: 'Unsupported' });
      return;
    }
    this.spawn();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.child) this.child.kill();
    this.child = null;
  }

  /** Changes the script's settings (environment variables) and restarts it. */
  setEnv(env) {
    this.env = { ...this.env, ...env };
    if (this.stopped || !this.command) return;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null; // so its exit isn't reported as a crash
    if (child) child.kill();
    this.nextDelay = this.restartDelay;
    this.spawn();
  }

  spawn() {
    const [file, args, commandEnv] = this.command;
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, AMRPC_PARENT_PID: String(process.pid), ...commandEnv, ...this.env },
      });
    } catch (error) {
      this.finish(null, describeExit(null, null, error.message));
      return;
    }
    this.child = child;

    let buffer = '';
    let stderr = '';
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      this.finish(child, status);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
      this.emit('log', chunk);
    });
    child.stdin.on('error', () => {}); // the script may exit before reading
    child.on('error', (error) => finish(describeExit(null, null, `${stderr}\n${error.message}`)));
    child.on('exit', (code, signal) => finish(describeExit(code, signal, stderr)));
  }

  handleLine(line) {
    let status;
    try {
      status = JSON.parse(line);
    } catch {
      status = { state: 'Error', error: `Unexpected output: ${line}` };
    }
    if (status.state !== 'Error') this.nextDelay = this.restartDelay; // healthy again
    this.emit('status', normalizeStatus(status));
  }

  finish(child, status) {
    if (child && this.child !== child) return; // replaced by setEnv()
    this.child = null;
    if (this.stopped) return;
    this.emit('status', status);
    // Restart, waiting longer each time it keeps failing.
    this.restartTimer = setTimeout(() => this.spawn(), this.nextDelay);
    this.nextDelay = Math.min(this.nextDelay * 2, this.maxRestartDelay);
  }
}

module.exports = { PlayerWatcher, commandFor, normalizeStatus, describeExit, PLAYER_NAME };
