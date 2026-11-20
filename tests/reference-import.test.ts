import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  importReferenceDocuments,
  parseReferenceArchive,
  parseReferenceArchiveFile,
  REFERENCE_LIMITS,
} from '../src/core/reference-documents.js';
import { buildReferenceZip } from './fixtures/reference-zip.js';

test('直接文档支持 UTF-8 和带 BOM 的 UTF-16，但 ZIP 走独立入口', () => {
  assert.equal(importReferenceDocuments('需求.md', Buffer.from('\ufeff中文需求')).documents[0]!.content, '中文需求');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('说明', 'utf16le')]);
  assert.equal(importReferenceDocuments('说明.txt', le).documents[0]!.content, '说明');
  assert.throws(() => importReferenceDocuments('资料.zip', buildReferenceZip([])), /参考压缩包/);
  assert.throws(() => importReferenceDocuments('../需求.md', Buffer.from('x')), /路径/);
});

test('ZIP 展开所有普通文件，保留原名元数据并生成受控扁平路径', () => {
  const nested = buildReferenceZip([{ name: 'inside.txt', content: 'nested' }]);
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]);
  const result = parseReferenceArchive('项目资料.zip', buildReferenceZip([
    { name: 'docs/需求.md', content: '# 中文需求' },
    { name: 'src/main.TS', content: 'export {}', method: 8 },
    { name: 'manual.pdf', content: pdf, method: 8 },
    { name: 'archives/source.zip', content: nested },
    { name: '无扩展名', content: Buffer.from([0, 1, 2]) },
  ]));
  assert.deepEqual(result.files.map((file) => file.name), ['docs/需求.md', 'src/main.TS', 'manual.pdf', 'archives/source.zip', '无扩展名']);
  assert.deepEqual(result.files.map((file) => file.path), ['files/0001.md', 'files/0002.ts', 'files/0003.pdf', 'files/0004.zip', 'files/0005.bin']);
  assert.deepEqual(result.files[2]!.bytes, pdf);
  assert.deepEqual(result.files[3]!.bytes, nested);
  assert.deepEqual(result.notes, []);
});

test('无法安全展开的加密、ZIP64、文件名编码和压缩算法保留原包并返回说明', () => {
  const encrypted = parseReferenceArchive('x.zip', buildReferenceZip([{ name: 'a.txt', content: 'x', flags: 0x0801 }]));
  assert.equal(encrypted.files.length, 0);
  assert.match(encrypted.notes[0]!, /加密.*原始 ZIP.*未宣称/);

  const unsupported = parseReferenceArchive('x.zip', buildReferenceZip([{ name: 'a.rar', content: 'x', method: 12 }]));
  assert.equal(unsupported.files.length, 0);
  assert.match(unsupported.notes[0]!, /压缩算法 12/);

  const badName = buildReferenceZip([{ name: 'a.txt', content: 'x', flags: 0 }]);
  badName[30] = 0xff;
  badName[30 + 5 + 1 + 46] = 0xff;
  assert.match(parseReferenceArchive('x.zip', badName).notes[0]!, /非 UTF-8/);

  const zip64 = buildReferenceZip([{ name: 'a.txt', content: 'x' }]);
  zip64.writeUInt16LE(0xffff, zip64.length - 14);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.match(parseReferenceArchive('x.zip', zip64).notes[0]!, /ZIP64/);
});

test('空 ZIP 保留原包并说明没有展开文件', () => {
  const result = parseReferenceArchive('空.zip', buildReferenceZip([]));
  assert.deepEqual(result.files, []);
  assert.match(result.notes[0]!, /没有普通文件/);
});

test('拒绝路径穿越、绝对路径和大小写重复路径', () => {
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip([{ name: '../secret.txt', content: 'x' }])), /路径穿越/);
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip([{ name: 'C:/secret.txt', content: 'x' }])), /绝对路径/);
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip([
    { name: 'A.txt', content: 'x' }, { name: 'a.txt', content: 'y' },
  ])), /重复路径/);
});

test('拒绝畸形目录、本地头不一致、声明尺寸欺骗与 CRC 错误', () => {
  const malformed = buildReferenceZip([{ name: 'a.txt', content: 'x' }]);
  malformed.writeUInt32LE(0, malformed.length - 22 - 46 - 5);
  assert.throws(() => parseReferenceArchive('x.zip', malformed), /中央目录/);
  const mismatch = buildReferenceZip([{ name: 'a.txt', content: 'x' }]);
  mismatch.writeUInt16LE(8, 8);
  assert.throws(() => parseReferenceArchive('x.zip', mismatch), /不一致/);
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip([{ name: 'a.txt', content: 'x', declaredSize: 2 }])), /尺寸/);
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip([{ name: 'a.txt', content: 'x', crc: 123 }])), /CRC/);
});

test('拒绝条目、单项、展开总量和实际膨胀超限', () => {
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip(Array.from({ length: 1_001 }, (_, i) => ({ name: `${i}.bin`, content: 'x' })))), /1000/);
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip([{ name: 'large.bin', content: 'x', declaredSize: REFERENCE_LIMITS.maxEntryBytes + 1 }])), /20 MiB/);
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip(Array.from({ length: 6 }, (_, i) => ({
    name: `${i}.bin`, content: 'x', declaredSize: REFERENCE_LIMITS.maxEntryBytes,
  })))), /100 MiB/);
  const bomb = Buffer.alloc(REFERENCE_LIMITS.maxEntryBytes + 1, 65);
  assert.throws(() => parseReferenceArchive('x.zip', buildReferenceZip([{
    name: 'bomb.bin', content: bomb, method: 8, declaredSize: REFERENCE_LIMITS.maxEntryBytes,
  }])), /膨胀|尺寸/);
});

test('拒绝多卷、过大原包和错误扩展名', () => {
  const split = buildReferenceZip([{ name: 'a.txt', content: 'x' }]);
  split.writeUInt16LE(1, split.length - 18);
  assert.throws(() => parseReferenceArchive('x.zip', split), /多卷/);
  assert.throws(() => parseReferenceArchive('x.zip', Buffer.alloc(REFERENCE_LIMITS.maxZipBytes + 1)), /20 MiB/);
  assert.throws(() => parseReferenceArchive('x.rar', buildReferenceZip([])), /.zip/);
});

test('文件解析器流式展开超过 20 MiB 的原始 ZIP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reference-file-parser-'));
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const zip = buildReferenceZip(Array.from({ length: 21 }, (_, index) => ({
      name: `资料/${String(index).padStart(2, '0')}.bin`,
      content: chunk,
    })));
    assert.ok(zip.length > REFERENCE_LIMITS.maxZipBytes);
    const archivePath = path.join(root, 'archive.zip');
    await writeFile(archivePath, zip);

    const result = await parseReferenceArchiveFile('大型资料.zip', archivePath, root);
    assert.equal(result.files.length, 21);
    assert.equal(result.files.reduce((sum, file) => sum + file.size, 0), 21 * 1024 * 1024);
    assert.deepEqual(await readFile(path.join(root, result.files[20]!.path)), chunk);
    assert.deepEqual(result.notes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件解析器流式解压 Deflate 并校验 CRC，失败时清理残片', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reference-file-parser-'));
  try {
    const goodPath = path.join(root, 'good.zip');
    await writeFile(goodPath, buildReferenceZip([{ name: 'docs/readme.md', content: '# 流式内容\n'.repeat(20_000), method: 8 }]));
    const good = await parseReferenceArchiveFile('good.zip', goodPath, root);
    assert.equal(good.files.length, 1);
    assert.match((await readFile(path.join(root, good.files[0]!.path), 'utf8')), /流式内容/);

    await rm(path.join(root, 'files'), { recursive: true, force: true });
    const badPath = path.join(root, 'bad.zip');
    await writeFile(badPath, buildReferenceZip([
      { name: 'first.txt', content: '先写入' },
      { name: 'bad.txt', content: 'CRC 错误', method: 8, crc: 123 },
    ]));
    await assert.rejects(() => parseReferenceArchiveFile('bad.zip', badPath, root), /CRC/);
    assert.deepEqual(await readdir(path.join(root, 'files')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件解析器超过自动展开预算时保留原包并清理 files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reference-file-parser-'));
  try {
    const archivePath = path.join(root, 'archive.zip');
    const archive = buildReferenceZip([{ name: 'large.bin', content: 'x', declaredSize: REFERENCE_LIMITS.maxEntryBytes + 1 }]);
    await writeFile(archivePath, archive);
    const result = await parseReferenceArchiveFile('预算.zip', archivePath, root);
    assert.deepEqual(result.files, []);
    assert.match(result.notes[0]!, /20 MiB.*原始 ZIP/);
    assert.deepEqual(await readdir(path.join(root, 'files')), []);
    assert.deepEqual(await readFile(archivePath), archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
