// Minimal client for Discord's local RPC socket, the same IPC channel the
// official SDKs use. It only does what this app needs: handshake,
// SET_ACTIVITY, ping/pong, and reconnecting whenever Discord is closed or
// restarted (so the app can be started before Discord without crashing).

const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function ipcPath(id) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${id}`;
  const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
  return path.join(XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || '/tmp', `discord-ipc-${id}`);
}

// Where to look for Discord: on Linux, Discord installed as a Flatpak or Snap
// keeps its socket in a subfolder.
function ipcPaths(id) {
  const main = ipcPath(id);
  if (process.platform === 'win32' || process.platform === 'darwin') return [main];
  const dir = path.dirname(main);
  const file = path.basename(main);
  return [
    main,
    path.join(dir, 'app', 'com.discordapp.Discord', file),
    path.join(dir, 'app', 'com.discordapp.DiscordCanary', file),
    path.join(dir, 'snap.discord', file),
  ];
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function openSocket(file) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

class DiscordIPC extends EventEmitter {
  constructor(clientId, { retryDelay = 15000 } = {}) {
    super();
    this.clientId = clientId;
    this.retryDelay = retryDelay;
    this.socket = null;
    this.ready = false;
    this.connecting = false;
    this.closed = false;
    this.retryTimer = null;
    this.buffer = Buffer.alloc(0);
    this.activity = null; // what we want Discord to show
    this.sent = undefined; // JSON of what Discord was last told to show
  }

  async connect() {
    if (this.closed || this.socket || this.connecting) return;
    this.connecting = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    // Discord listens on the first free slot of discord-ipc-0 … discord-ipc-9.
    let socket = null;
    for (let id = 0; id < 10 && !socket; id++) {
      for (const file of ipcPaths(id)) {
        socket = await openSocket(file).catch(() => null);
        if (socket) break;
      }
    }
    this.connecting = false;

    if (!socket) return this.scheduleRetry();
    if (this.closed) return socket.destroy();

    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {}); // 'close' always follows and handles cleanup
    socket.on('close', () => this.onClose());
    this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
  }

  /** Show `activity` on the user's profile, or clear it when null. */
  setActivity(activity) {
    this.activity = activity || null;
    this.flush();
  }

  /** Disconnect for good. Discord clears our activity once the socket closes. */
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.socket) this.socket.end();
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);
  }

  flush() {
    if (!this.ready) return;
    const json = JSON.stringify(this.activity);
    if (json === this.sent) return; // nothing changed, don't spend Discord's rate limit
    this.sent = json;
    this.write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: this.activity || undefined },
      nonce: randomUUID(),
    });
  }

  write(op, payload) {
    if (this.socket && !this.socket.destroyed) this.socket.write(encode(op, payload));
  }

  onClose() {
    const wasReady = this.ready;
    this.socket = null;
    this.ready = false;
    this.sent = undefined;
    if (wasReady) this.emit('disconnected');
    this.scheduleRetry();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + length) break;
      const body = this.buffer.subarray(8, 8 + length).toString('utf8');
      this.buffer = this.buffer.subarray(8 + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.onMessage(op, message);
    }
  }

  onMessage(op, message) {
    if (op === OP.PING) {
      this.write(OP.PONG, message);
    } else if (op === OP.CLOSE) {
      this.emit('warning', `Discord closed the connection: ${message.message || message.code}`);
      this.socket?.end();
    } else if (op === OP.FRAME) {
      if (message.cmd === 'DISPATCH' && message.evt === 'READY') {
        this.ready = true;
        this.emit('ready', message.data?.user);
        this.flush();
      } else if (message.evt === 'ERROR') {
        this.emit('warning', `Discord rejected ${message.cmd}: ${message.data?.message}`);
      }
    }
  }
}

module.exports = DiscordIPC;
module.exports.ipcPath = ipcPath;
module.exports.ipcPaths = ipcPaths;
module.exports.encode = encode;
module.exports.OP = OP;
