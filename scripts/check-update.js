// Checks that the app can install a release zip as an update, on the system
// it runs on: unpacks the zip as if it were installed, then installs the same
// zip over it with the app's own installer and swap script.
// Usage: node scripts/check-update.js AppleMusicRPC-Mac.zip

const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareUpdate, assetName, STAGE_NAME } = require('../lib/installer');
const { extractZip } = require('../lib/unzip');

const EXECUTABLES = {
  darwin: path.join('Contents', 'MacOS', 'AppleMusicRPC'),
  win32: 'AppleMusicRPC.exe',
  linux: 'AppleMusicRPC-bin',
};

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function waitFor(file, ms) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) fail("The installer didn't start the app again");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main() {
  const zipFile = path.resolve(process.argv[2]);
  const zip = fs.readFileSync(zipFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amrpc-update-'));

  // "Install" the app, and mark this copy to see that it gets replaced.
  const installed = path.join(dir, 'Apps');
  if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-x', '-k', zipFile, installed]);
  else await extractZip(zipFile, installed);
  const [name] = fs.readdirSync(installed).filter((entry) => entry !== '__MACOSX');
  const app = path.join(installed, name);
  const execPath = path.join(app, EXECUTABLES[process.platform]);
  fs.accessSync(execPath);
  const marker = path.join(app, process.platform === 'darwin' ? 'Contents' : '', 'old-version');
  fs.writeFileSync(marker, 'old');

  // Serve the zip as the update's download.
  const asset = {
    name: assetName(process.platform, process.arch),
    url: 'https://example.invalid/update.zip',
    size: zip.length,
    digest: `sha256:${crypto.createHash('sha256').update(zip).digest('hex')}`,
  };
  const fetchImpl = async () => new Response(zip);

  // Instead of starting the app, the installer runs a script that says so.
  const started = path.join(dir, 'started');
  const startScript = path.join(dir, 'start.js');
  fs.writeFileSync(startScript, `require('fs').writeFileSync(${JSON.stringify(started)}, 'yes')`);

  const ready = await prepareUpdate(
    { version: 'test', assets: [asset] },
    { execPath, fetchImpl, launch: [process.execPath, startScript] }
  );
  // Stands in for the running app: the swap waits until it has quit.
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
  ready.install(running.pid);
  await waitFor(started, 3 * 60 * 1000);

  if (fs.existsSync(marker)) fail('The old version is still installed');
  if (!fs.existsSync(execPath)) fail('The new version is missing');
  if (fs.existsSync(path.join(installed, STAGE_NAME))) fail('The update files were left behind');
  if (fs.existsSync(`${app}.old`)) fail('The old version was left behind');
  if (process.platform === 'darwin') execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  if (process.platform === 'linux') fs.accessSync(path.join(app, 'AppleMusicRPC'), fs.constants.X_OK);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`The app installs ${path.basename(zipFile)} as an update`);
}

main().catch((error) => fail(error.stack || error.message));
