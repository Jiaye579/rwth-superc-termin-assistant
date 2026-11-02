'use strict';

// Dependency-free release builder. Only these reviewed files may enter a ZIP.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const RUNTIME_FILES = Object.freeze([
  'adapter.js', 'alert.wav', 'background.js', 'content.js', 'core.js',
  'diagnostics.js', 'icon.png', 'manifest.json', 'offscreen.html',
  'offscreen.js', 'options.css', 'options.html', 'options.js', 'sound.js'
]);
const RELEASE_FILES = Object.freeze([
  ...RUNTIME_FILES.map(name => 'extension/' + name), 'README.zh-CN.txt', '安装说明.html'
]);
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  CRC_TABLE[i] = crc >>> 0;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function requireDirectory(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Expected a regular directory, not a symlink: ' + file);
}
function readRegular(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Expected a regular file, not a symlink: ' + file);
  if (stat.size > 16 * 1024 * 1024) throw new Error('Release source exceeds 16 MiB: ' + file);
  return fs.readFileSync(file);
}
function existingRegular(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing to replace a non-regular output file: ' + file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function makeZip(entries) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(bytes, {level: 9});
    const crc = crc32(bytes);
    if (offset + compressed.length > 0xffffffff || bytes.length > 0xffffffff) throw new Error('ZIP64 is not supported.');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // 1980-01-01 00:00
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(0x81a40000, 38); // Unix regular file, 0644; never a symlink.
    central.writeUInt32LE(offset, 42);
    chunks.push(local, filename, compressed); directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDirectory, end]);
}
function buildRelease(root, outputDir) {
  root = path.resolve(root);
  requireDirectory(root);
  const extension = path.join(root, 'extension');
  requireDirectory(extension);
  const found = fs.readdirSync(extension).sort();
  const expected = [...RUNTIME_FILES].sort();
  if (found.length !== expected.length || found.some((name, i) => name !== expected[i])) throw new Error('Unexpected or missing files in extension/. Build accepts only the reviewed runtime allowlist.');
  const packageBytes = readRegular(path.join(root, 'package.json'));
  const entries = RELEASE_FILES.map(name => [name, readRegular(path.join(root, name))]);
  const manifest = JSON.parse(entries.find(([name]) => name === 'extension/manifest.json')[1].toString('utf8'));
  const pkg = JSON.parse(packageBytes.toString('utf8'));
  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid manifest release version.');
  if (pkg.version !== version) throw new Error('package.json and manifest.json versions do not match.');
  const bytes = makeZip(entries);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const target = path.resolve(outputDir || path.join(root, 'release'));
  // Check each existing directory below the repository before writing. This
  // prevents an output-directory junction from redirecting release writes.
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Output directory must be within the release source root.');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { requireDirectory(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
    }
  }
  const filename = 'RWTH-Termin-Assistant-v' + version + '.zip';
  const zipPath = path.join(target, filename), sha256Path = path.join(target, 'SHA256SUMS.txt');
  existingRegular(zipPath); existingRegular(sha256Path);
  fs.writeFileSync(zipPath, bytes, {flag: 'w'});
  fs.writeFileSync(sha256Path, sha256 + '  ' + filename + '\n', 'utf8');
  return {version, zipPath, sha256Path, sha256, files: [...RELEASE_FILES]};
}
module.exports = {buildRelease, RELEASE_FILES};
if (require.main === module) {
  try {
    const result = buildRelease(process.argv[2] || path.resolve(__dirname, '..'), process.argv[3]);
    process.stdout.write(result.zipPath + '\n' + result.sha256 + '\n');
  } catch (error) { process.stderr.write('Release build failed: ' + error.message + '\n'); process.exitCode = 1; }
}
