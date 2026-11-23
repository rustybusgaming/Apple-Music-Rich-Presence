const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { extractZip } = require('../lib/unzip');
const { prepareUpdate, assetName, appLayout, STAGE_NAME } = require('../lib/installer');

const POSIX = process.platform !== 'win32';

// Builds a zip in memory: entries are { name, data, mode, deflate }.
function makeZip(entries) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const method = entry.deflate ? 8 : 0;
    const stored = entry.deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made on Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amrpc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('extracts files, folders, permissions and links', { skip: !POSIX }, async (t) => {
  const dir = tempDir(t);
  const zip = path.join(dir, 'test.zip');
  fs.writeFileSync(
    zip,
    makeZip([
      { name: 'App/' },
      { name: 'App/run', data: '#!/bin/sh\necho hi\n', mode: 0o100755 },
      { name: 'App/data/big.txt', data: 'x'.repeat(10000), deflate: true },
      { name: 'App/link', data: 'run', mode: 0o120777 },
    ])
  );
  await extractZip(zip, path.join(dir, 'out'));
  assert.equal(fs.readFileSync(path.join(dir, 'out/App/data/big.txt'), 'utf8'), 'x'.repeat(10000));
  assert.equal(fs.statSync(path.join(dir, 'out/App/run')).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(path.join(dir, 'out/App/link')), 'run');
});

test('extracts zips made by the zip command, as the Linux download is', { skip: !POSIX }, async (t) => {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
  } catch {
    return t.skip('zip is not installed');
  }
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'src/AppleMusicRPC/locales'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/AppleMusicRPC/AppleMusicRPC'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'src/AppleMusicRPC/locales/en-US.pak'), crypto.randomBytes(50000));
  fs.symlinkSync('AppleMusicRPC', path.join(dir, 'src/AppleMusicRPC/alias'));
  execFileSync('zip', ['-qry', '../app.zip', 'AppleMusicRPC'], { cwd: path.join(dir, 'src') });
  await extractZip(path.join(dir, 'app.zip'), path.join(dir, 'out'));
  const same = (file) => assert.deepEqual(fs.readFileSync(path.join(dir, 'out', file)), fs.readFileSync(path.join(dir, 'src', file)));
  same('AppleMusicRPC/locales/en-US.pak');
  assert.equal(fs.statSync(path.join(dir, 'out/AppleMusicRPC/AppleMusicRPC')).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(path.join(dir, 'out/AppleMusicRPC/alias')), 'AppleMusicRPC');
});

test("refuses zips that would write outside the folder, or that are damaged", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'evil.zip'), makeZip([{ name: '../evil.txt', data: 'x' }]));
  await assert.rejects(extractZip(path.join(dir, 'evil.zip'), path.join(dir, 'out')), /Unsafe path/);
  assert.equal(fs.existsSync(path.join(dir, 'evil.txt')), false);

  const damaged = makeZip([{ name: 'a.txt', data: 'hello world', deflate: false }]);
  damaged[30 + 'a.txt'.length] ^= 0xff; // flip a byte of the data
  fs.writeFileSync(path.join(dir, 'damaged.zip'), damaged);
  await assert.rejects(extractZip(path.join(dir, 'damaged.zip'), path.join(dir, 'out2')), /damaged/);
});

test('picks the download for each kind of computer', () => {
  assert.equal(assetName('darwin', 'arm64'), 'AppleMusicRPC-Mac.zip');
  assert.equal(assetName('darwin', 'x64'), 'AppleMusicRPC-Mac.zip');
  assert.equal(assetName('win32', 'x64'), 'AppleMusicRPC-Windows-64bit.zip');
  assert.equal(assetName('win32', 'arm64'), 'AppleMusicRPC-Windows-ARM.zip');
  assert.equal(assetName('linux', 'x64'), 'AppleMusicRPC-Linux-64bit.zip');
  assert.equal(assetName('linux', 'arm64'), 'AppleMusicRPC-Linux-ARM.zip');
  assert.equal(assetName('win32', 'ia32'), null);
  assert.equal(assetName('freebsd', 'x64'), null);
});

test("finds the app's folder from its executable", () => {
  const mac = appLayout('darwin', '/Applications/AppleMusicRPC.app/Contents/MacOS/AppleMusicRPC');
  assert.equal(mac.app, path.resolve('/Applications/AppleMusicRPC.app'));
  assert.deepEqual(mac.launch, ['open', path.resolve('/Applications/AppleMusicRPC.app')]);
  const linux = appLayout('linux', '/home/me/AppleMusicRPC/AppleMusicRPC-bin');
  assert.equal(linux.app, '/home/me/AppleMusicRPC');
  assert.deepEqual(linux.launch, ['/home/me/AppleMusicRPC/AppleMusicRPC']);
  assert.equal(appLayout('darwin', '/usr/local/bin/electron'), null);
});

// A release with a zip of the new version, and a fetch that serves it.
function fakeRelease(zipData, { digest } = {}) {
  const name = assetName('linux', 'x64');
  const url = `https://example.com/${name}`;
  const asset = {
    name,
    url,
    size: zipData.length,
    digest: digest || `sha256:${crypto.createHash('sha256').update(zipData).digest('hex')}`,
  };
  const fetchImpl = async (requested) => {
    assert.equal(requested, url);
    return new Response(zipData);
  };
  return { update: { version: '9.9.9', assets: [asset] }, fetchImpl };
}

function newVersionZip() {
  return makeZip([
    { name: 'AppleMusicRPC/' },
    { name: 'AppleMusicRPC/AppleMusicRPC', data: '#!/bin/sh\n', mode: 0o100755 },
    { name: 'AppleMusicRPC/AppleMusicRPC-bin', data: 'binary', mode: 0o100755 },
    { name: 'AppleMusicRPC/version.txt', data: 'new', deflate: true },
  ]);
}

function installedApp(dir) {
  const app = path.join(dir, 'Apps', 'AppleMusicRPC');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'AppleMusicRPC-bin'), 'old binary');
  fs.writeFileSync(path.join(app, 'version.txt'), 'old');
  return app;
}

async function waitFor(file, ms = 20000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('installs an update once the app has quit, then starts it', { skip: !POSIX }, async (t) => {
  const dir = tempDir(t);
  const app = installedApp(dir);
  const { update, fetchImpl } = fakeRelease(newVersionZip());
  const progress = [];
  // Instead of starting the real app, write a file saying it was started.
  const started = path.join(dir, 'started');
  const marker = path.join(dir, 'start.js');
  fs.writeFileSync(marker, `require('fs').writeFileSync(${JSON.stringify(started)}, process.cwd())`);

  const ready = await prepareUpdate(update, {
    platform: 'linux',
    arch: 'x64',
    execPath: path.join(app, 'AppleMusicRPC-bin'),
    fetchImpl,
    onProgress: (fraction) => progress.push(fraction),
    launch: [process.execPath, marker],
  });
  assert.equal(progress.at(-1), 1);
  assert.equal(fs.readFileSync(path.join(app, 'version.txt'), 'utf8'), 'old', 'nothing changes before the app quits');

  // Stands in for the running app: the swap waits until it has quit.
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);
  ready.install(running.pid);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fs.readFileSync(path.join(app, 'version.txt'), 'utf8'), 'old', 'waits for the app to quit');

  await waitFor(started);
  assert.equal(fs.readFileSync(path.join(app, 'version.txt'), 'utf8'), 'new');
  assert.equal(fs.statSync(path.join(app, 'AppleMusicRPC')).mode & 0o111, 0o111);
  assert.equal(fs.existsSync(path.join(path.dirname(app), STAGE_NAME)), false, 'cleans up');
  assert.equal(fs.existsSync(`${app}.old`), false, 'removes the old version');
});

test("doesn't install a damaged download, and cleans up", async (t) => {
  const dir = tempDir(t);
  const app = installedApp(dir);
  const { update, fetchImpl } = fakeRelease(newVersionZip(), { digest: `sha256:${'0'.repeat(64)}` });
  await assert.rejects(
    prepareUpdate(update, { platform: 'linux', arch: 'x64', execPath: path.join(app, 'AppleMusicRPC-bin'), fetchImpl }),
    /damaged/
  );
  assert.equal(fs.existsSync(path.join(path.dirname(app), STAGE_NAME)), false);
  assert.equal(fs.readFileSync(path.join(app, 'version.txt'), 'utf8'), 'old');
});

test("says so when there's no download for this computer", async () => {
  await assert.rejects(
    prepareUpdate({ version: '9.9.9', assets: [] }, { platform: 'linux', arch: 'x64', execPath: '/tmp/x/AppleMusicRPC-bin' }),
    /no download for this computer/
  );
  await assert.rejects(prepareUpdate({ version: '9.9.9', assets: [] }, { platform: 'freebsd', arch: 'x64', execPath: '/x' }), /no download/);
});
