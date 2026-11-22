// Runs the client against a fake Discord that speaks the IPC protocol.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const DiscordIPC = require('../lib/discord-ipc');
const { ipcPath, encode, OP } = DiscordIPC;

if (process.platform !== 'win32') {
  process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-ipc-test-'));
}

function fakeDiscord() {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readInt32LE(4)) {
        const op = buffer.readInt32LE(0);
        const length = buffer.readInt32LE(4);
        const message = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8'));
        buffer = buffer.subarray(8 + length);
        received.push({ op, message });
        server.emit('message', { op, message });
        if (op === OP.HANDSHAKE) {
          socket.write(encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'tester' } } }));
        }
      }
    });
  });
  server.received = received;
  server.sockets = sockets;
  server.nextMessage = async (op) => {
    for (;;) {
      const [event] = await once(server, 'message');
      if (event.op === op) return event.message;
    }
  };
  return server;
}

test('handshakes, sends activities only when they change, and reconnects', async (t) => {
  const file = ipcPath(0);
  let server = fakeDiscord();
  server.listen(file);
  await once(server, 'listening');

  const client = new DiscordIPC('123', { retryDelay: 50 });
  t.after(() => {
    client.close();
    server.close();
  });

  const activity = { type: 2, details: 'Let You Down', state: 'by NF' };
  client.setActivity(activity); // before connecting: should be sent once ready
  const ready = once(client, 'ready');
  client.connect();

  const handshake = await server.nextMessage(OP.HANDSHAKE);
  assert.deepEqual(handshake, { v: 1, client_id: '123' });
  const [user] = await ready;
  assert.equal(user.username, 'tester');

  const first = await server.nextMessage(OP.FRAME);
  assert.equal(first.cmd, 'SET_ACTIVITY');
  assert.equal(first.args.pid, process.pid);
  assert.deepEqual(first.args.activity, activity);

  // The same activity again is not re-sent; clearing it is.
  client.setActivity({ ...activity });
  client.setActivity(null);
  const cleared = await server.nextMessage(OP.FRAME);
  assert.equal(cleared.args.activity, undefined);
  assert.equal(server.received.filter((m) => m.op === OP.FRAME).length, 2);

  // Answers pings.
  const [socket] = server.sockets;
  socket.write(encode(OP.PING, { n: 1 }));
  assert.deepEqual(await server.nextMessage(OP.PONG), { n: 1 });

  // Discord quits and comes back: the client reconnects and restores the activity.
  const disconnected = once(client, 'disconnected');
  for (const s of server.sockets) s.destroy();
  server.close();
  await disconnected;

  client.setActivity(activity);
  server = fakeDiscord();
  server.listen(file);
  await once(server, 'listening');
  const restored = await server.nextMessage(OP.FRAME);
  assert.deepEqual(restored.args.activity, activity);
});

test('keeps retrying quietly while Discord is not running', async (t) => {
  const client = new DiscordIPC('123', { retryDelay: 20 });
  t.after(() => client.close());
  const file = ipcPath(0);
  if (process.platform !== 'win32') fs.rmSync(file, { force: true });

  await client.connect();
  assert.equal(client.ready, false);
  assert.ok(client.retryTimer, 'a retry should be scheduled');
});
