// Installs a new version of the app from its GitHub release. The release zip
// is downloaded and checked, then unpacked next to the app. Once the app quits,
// a small script swaps the new version in (putting the old one back if that
// fails) and starts it again.

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { promisify } = require('util');
const { extractZip } = require('./unzip');

const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const STAGE_NAME = '.AppleMusicRPC-update';
// What the install script did, for when an update doesn't install.
const LOG_FILE = path.join(os.tmpdir(), 'AppleMusicRPC-update.log');

// The release download for each kind of computer.
const ASSETS = {
  'darwin-x64': 'AppleMusicRPC-Mac.zip',
  'darwin-arm64': 'AppleMusicRPC-Mac.zip',
  'win32-x64': 'AppleMusicRPC-Windows-64bit.zip',
  'win32-arm64': 'AppleMusicRPC-Windows-ARM.zip',
  'linux-x64': 'AppleMusicRPC-Linux-64bit.zip',
  'linux-arm64': 'AppleMusicRPC-Linux-ARM.zip',
};

function assetName(platform, arch) {
  return ASSETS[`${platform}-${arch}`] || null;
}

/**
 * Where the app is installed, from the path of its executable: `app` is the
 * folder (or .app bundle) that gets replaced, `executable` is relative to it,
 * and `launch` starts the app again.
 */
function appLayout(platform, execPath) {
  if (platform === 'darwin') {
    // AppleMusicRPC.app/Contents/MacOS/AppleMusicRPC
    const app = path.resolve(execPath, '..', '..', '..');
    if (!app.endsWith('.app')) return null;
    return { app, executable: path.join('Contents', 'MacOS', path.basename(execPath)), launch: ['open', app] };
  }
  const app = path.dirname(execPath);
  if (platform === 'win32') {
    const executable = path.basename(execPath);
    return { app, executable, launch: [path.join(app, executable)] };
  }
  if (platform === 'linux') {
    // The Linux download starts the app through an "AppleMusicRPC" launcher
    // script next to the real executable ("AppleMusicRPC-bin").
    return { app, executable: 'AppleMusicRPC', launch: [path.join(app, 'AppleMusicRPC')] };
  }
  return null;
}

const SH_SCRIPT = `#!/bin/sh
# Installs an AppleMusicRPC update: waits for the app to quit, swaps the new
# version in (putting the old one back if that fails) and starts the app.
pid=$1 app=$2 new=$3 stage=$4 log=$5
shift 5
exec >"$log" 2>&1
echo "Waiting for the app (process $pid) to quit"
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.2; i=$((i + 1)); done
echo "Installing $new as $app"
rm -rf "$app.old"
if mv "$app" "$app.old"; then
  if mv "$new" "$app"; then
    rm -rf "$app.old"
  else
    echo "Couldn't move the new version in"
    mv "$app.old" "$app"
  fi
else
  echo "Couldn't move the old version"
fi
rm -rf "$stage"
echo "Starting $*"
exec "$@" >/dev/null 2>&1
`;

const PS_SCRIPT = `# Installs an AppleMusicRPC update: waits for the app to quit, swaps the new
# version in (putting the old one back if that fails) and starts the app.
param([int]$AppPid, [string]$App, [string]$New, [string]$Stage, [string]$Log, [string]$Launch, [string]$LaunchArgs = '')
$ErrorActionPreference = 'Stop'
Start-Transcript -LiteralPath $Log -Force | Out-Null
try {
  Write-Output "Waiting for the app (process $AppPid) to quit"
  try { Wait-Process -Id $AppPid -Timeout 120 } catch {}
  Write-Output "Installing $New as $App"
  $leaf = Split-Path -Leaf $App
  $old = "$App.old"
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  # Windows can keep the app's files locked for a moment after it quits.
  $moved = $false
  for ($i = 0; $i -lt 100 -and -not $moved; $i++) {
    try { Rename-Item -LiteralPath $App -NewName "$leaf.old"; $moved = $true } catch { $problem = $_; Start-Sleep -Milliseconds 200 }
  }
  if (-not $moved) {
    Write-Output "Couldn't move the old version: $problem"
  } else {
    try {
      Move-Item -LiteralPath $New -Destination $App
      Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
      Write-Output "Couldn't move the new version in: $_"
      Rename-Item -LiteralPath $old -NewName $leaf
    }
  }
} catch {
  Write-Output "The update failed: $_"
} finally {
  Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "Starting $Launch $LaunchArgs"
  if ($LaunchArgs) { Start-Process -FilePath $Launch -ArgumentList $LaunchArgs } else { Start-Process -FilePath $Launch }
  Stop-Transcript | Out-Null
}
`;

// Downloads `asset` to `file`, checking its size and SHA-256 digest.
async function download(asset, file, { fetchImpl, onProgress }) {
  const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`The download failed (${response.status})`);
  const total = asset.size || Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await once(out, 'drain');
      if (total) onProgress?.(Math.min(received / total, 1));
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
  if (asset.size && received !== asset.size) throw new Error('The download was incomplete');
  const [algorithm, expected] = String(asset.digest || '').split(':');
  if (algorithm === 'sha256' && hash.digest('hex') !== expected) throw new Error('The download was damaged');
}

// The one folder (or .app) a release zip unpacks to.
async function unpackedApp(folder) {
  const names = (await fs.promises.readdir(folder)).filter((name) => name !== '__MACOSX' && !name.startsWith('.'));
  if (names.length !== 1) throw new Error("The download doesn't contain the app");
  return path.join(folder, names[0]);
}

/**
 * Downloads and unpacks `update` ({ version, assets }) next to the running
 * app. Resolves to { install(pid) }, which starts the script that swaps it in
 * once process `pid` (this app) has quit; quit the app straight after.
 * Throws an Error with a message for people when it can't install the update.
 */
async function prepareUpdate(update, options) {
  const { platform = process.platform, arch = process.arch, execPath = process.execPath, fetchImpl, onProgress } = options;
  const layout = appLayout(platform, execPath);
  const name = assetName(platform, arch);
  const asset = update.assets?.find((item) => item.name === name);
  if (!layout || !name) throw new Error("There's no download for this computer");
  if (!asset) throw new Error(`Version ${update.version} has no download for this computer`);
  if (platform === 'darwin' && layout.app.includes('/AppTranslocation/')) {
    throw new Error('Move AppleMusicRPC to your Applications folder first, then it can update itself');
  }
  const launch = options.launch || layout.launch;

  // Unpack next to the app, so it can be moved into place in one step.
  const stage = path.join(path.dirname(layout.app), STAGE_NAME);
  await fs.promises.rm(stage, { recursive: true, force: true });
  try {
    await fs.promises.mkdir(stage);
  } catch (error) {
    throw new Error(`The app can't update itself in ${path.dirname(layout.app)} (${error.code || error.message})`);
  }

  try {
    const zip = path.join(stage, 'update.zip');
    const unpacked = path.join(stage, 'new');
    await download(asset, zip, { fetchImpl, onProgress });
    if (platform === 'darwin') {
      // ditto keeps the app bundle's links, permissions and signature intact.
      await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
    } else {
      await extractZip(zip, unpacked);
    }
    await fs.promises.rm(zip, { force: true });
    const newApp = await unpackedApp(unpacked);
    await fs.promises.access(path.join(newApp, layout.executable));

    const script = path.join(stage, platform === 'win32' ? 'install.ps1' : 'install.sh');
    await fs.promises.writeFile(script, platform === 'win32' ? PS_SCRIPT : SH_SCRIPT, { mode: 0o755 });
    return {
      install(pid) {
        let file;
        let args;
        if (platform === 'win32') {
          file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
          args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
          args.push('-AppPid', String(pid), '-App', layout.app, '-New', newApp, '-Stage', stage, '-Log', LOG_FILE);
          args.push('-Launch', launch[0]);
          if (launch.length > 1) args.push('-LaunchArgs', launch.slice(1).join(' '));
        } else {
          file = '/bin/sh';
          args = [script, String(pid), layout.app, newApp, stage, LOG_FILE, ...launch];
        }
        // Run from outside the app's folder, which Windows won't move while
        // a program is using it.
        const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() });
        child.on('error', (error) => console.warn("Couldn't start the update's install script:", error.message));
        child.unref();
        return child;
      },
    };
  } catch (error) {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { prepareUpdate, assetName, appLayout, STAGE_NAME, LOG_FILE };
