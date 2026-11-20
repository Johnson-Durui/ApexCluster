// Rebuilds the published copies of the RoomDesk deliverables after a change to one of their sources:
//   - public/demo-project/roomdesk.zip (17 entries under roomdesk/, forward-slash names, fixed timestamps, so the same
//     sources always give the same bytes);
//   - bytes and sha256 of every entry in scenario/content/manifest.json (scenario/content.ts serves the text files
//     from their sources and the zip record from the manifest).
// With --test-report it first runs the delivered tests (node --test, no install needed) and rewrites
// scenario/content/test-report.txt from their output.
//
// Usage (from the repository root): node web/demo/scripts/pack-demo-project.mjs [--test-report]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.join(DEMO_ROOT, 'public/demo-project');
const MANIFEST = path.join(DEMO_ROOT, 'scenario/content/manifest.json');
const ZIP = path.join(PROJECT, 'roomdesk.zip');
/** 2026-11-20 10:19:00 in MS-DOS date/time form. */
const DOS_TIME = (10 << 11) | (19 << 5);
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 20;

if (process.argv.includes('--test-report')) {
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=spec', 'tests/*-test.mjs'], { cwd: PROJECT, encoding: 'utf8' });
  const report = `$ node --test "tests/*-test.mjs"   # npm test, Node.js ${process.version}\n${output.replace(/\r\n/g, '\n').trimEnd()}\n`;
  writeFileSync(path.join(DEMO_ROOT, 'scenario/content/test-report.txt'), report);
  console.log(`test report: ${/ℹ pass (\d+)/.exec(report)?.[1]} passed, ${/ℹ fail (\d+)/.exec(report)?.[1]} failed`);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const files = manifest.filter(entry => entry.id !== 'zip');
/** Zip path of a manifest entry: the project layout (docs/ for the documents). */
const zipPath = entry => `roomdesk/${entry.relativePath}`;
const names = files.map(zipPath).sort();
const directories = [...new Set(names.flatMap(name => name.split('/').slice(0, -1).map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/`)))].sort();

const locals = [];
const centrals = [];
let offset = 0;
for (const name of [...directories, ...names]) {
  const entry = files.find(item => zipPath(item) === name);
  const data = entry ? readFileSync(path.join(DEMO_ROOT, entry.source)) : Buffer.alloc(0);
  const packed = entry ? deflateRawSync(data, { level: 9 }) : data;
  const method = entry ? 8 : 0;
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(entry ? 0 : 0x10, 38);
  central.writeUInt32LE(offset, 42);
  locals.push(local, nameBytes, packed);
  centrals.push(central, nameBytes);
  offset += local.length + nameBytes.length + packed.length;
}
const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(directories.length + names.length, 8);
end.writeUInt16LE(directories.length + names.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, ...centrals, end]);
writeFileSync(ZIP, zip);

for (const entry of manifest) {
  const bytes = readFileSync(path.join(DEMO_ROOT, entry.source));
  entry.bytes = bytes.length;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`roomdesk.zip: ${directories.length + names.length} entries, ${zip.length} bytes; manifest.json updated`);
