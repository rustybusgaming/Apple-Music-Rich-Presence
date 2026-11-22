// Extracts a zip file, for installing updates on Windows and Linux (macOS uses
// its own ditto). Handles what the release zips contain: stored and deflated
// files, folders, Unix permissions and symbolic links. Not Zip64 or encryption.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const UNIX = 3; // "made by" host system for zips made on macOS and Linux
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function findEndOfDirectory(zip) {
  // The record is 22 bytes, followed by a comment of up to 65535 bytes.
  const stop = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= stop; i--) {
    if (zip.readUInt32LE(i) === END_OF_DIRECTORY) return i;
  }
  throw new Error('Not a zip file');
}

/** Lists the entries of a zip held in `zip` (a Buffer). */
function listEntries(zip) {
  const end = findEndOfDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('Zip64 files are not supported');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== DIRECTORY_ENTRY) throw new Error('The zip file is damaged');
    const flags = zip.readUInt16LE(offset + 8);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const host = zip.readUInt8(offset + 5);
    const external = zip.readUInt32LE(offset + 38);
    const name = zip.toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
    if (flags & 1) throw new Error(`${name} is encrypted`);
    entries.push({
      name: name.replace(/\\/g, '/'),
      method: zip.readUInt16LE(offset + 10),
      crc: zip.readUInt32LE(offset + 16),
      compressedSize: zip.readUInt32LE(offset + 20),
      size: zip.readUInt32LE(offset + 24),
      mode: host === UNIX ? external >>> 16 : 0,
      headerOffset: zip.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readData(zip, entry) {
  const at = entry.headerOffset;
  if (zip.readUInt32LE(at) !== LOCAL_HEADER) throw new Error(`The zip file is damaged at ${entry.name}`);
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const raw = zip.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`${entry.name} uses an unsupported compression method (${entry.method})`);
  if (data.length !== entry.size || (zlib.crc32 && zlib.crc32(data) !== entry.crc)) {
    throw new Error(`The zip file is damaged at ${entry.name}`);
  }
  return data;
}

/** Extracts the zip file at `file` into the folder `destination`. */
async function extractZip(file, destination) {
  const zip = await fs.promises.readFile(file);
  const root = path.resolve(destination);
  await fs.promises.mkdir(root, { recursive: true });

  for (const entry of listEntries(zip)) {
    // Never write outside the destination, whatever the names say.
    const target = path.resolve(root, entry.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe path in zip: ${entry.name}`);
    if (entry.name.split('/').includes('..')) throw new Error(`Unsafe path in zip: ${entry.name}`);

    if (entry.name.endsWith('/')) {
      await fs.promises.mkdir(target, { recursive: true });
      continue;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const data = readData(zip, entry);
    if ((entry.mode & S_IFMT) === S_IFLNK) {
      await fs.promises.symlink(data.toString('utf8'), target);
    } else {
      const permissions = entry.mode & 0o777;
      await fs.promises.writeFile(target, data, { mode: permissions || 0o644 });
      if (permissions) await fs.promises.chmod(target, permissions); // not narrowed by the umask
    }
  }
}

module.exports = { extractZip, listEntries };
