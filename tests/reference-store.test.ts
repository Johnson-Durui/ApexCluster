import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ReferenceArchive } from '../src/core/types.js';
import { copyReferenceArchives, loadReferenceArchive, pruneUnusedReferenceArchives, saveReferenceArchive } from '../src/orchestrator/reference-store.js';
import { buildReferenceZip } from './fixtures/reference-zip.js';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'dmw-reference-'));
}

test('保存原始 ZIP 字节、展开文件与清单，重启后可按哈希读取', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zip = buildReferenceZip([
    { name: 'src/app.js', content: 'console.log(1)', method: 8 },
    { name: 'manual.pdf', content: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
  ]);
  const saved = saveReferenceArchive(root, '项目.zip', zip);
  assert.match(saved.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(readFileSync(path.join(root, 'reference-uploads', saved.id, 'archive.zip')), zip);
  assert.deepEqual(loadReferenceArchive(root, saved.id), saved);
  assert.ok(existsSync(path.join(root, 'reference-uploads', saved.id, 'integrity.json')));
  assert.equal(readFileSync(path.join(root, 'reference-uploads', saved.id, 'files', '0001.js'), 'utf8'), 'console.log(1)');
});

test('旧存档缺少 integrity 时安全迁移一次，随后使用摘要拒绝同尺寸篡改', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = saveReferenceArchive(root, '旧资料.zip', buildReferenceZip([{ name: 'a.txt', content: 'x' }]));
  const archiveDir = path.join(root, 'reference-uploads', saved.id);
  const integrityFile = path.join(archiveDir, 'integrity.json');
  rmSync(integrityFile);
  assert.deepEqual(loadReferenceArchive(root, saved.id), saved);
  assert.ok(existsSync(integrityFile));
  const expanded = path.join(archiveDir, 'files', '0001.txt');
  writeFileSync(expanded, 'y');
  assert.throws(() => loadReferenceArchive(root, saved.id), /展开文件完整性/);
  writeFileSync(expanded, 'x');
  writeFileSync(integrityFile, '{}');
  assert.throws(() => loadReferenceArchive(root, saved.id), /完整性记录格式/);
  assert.equal(readFileSync(integrityFile, 'utf8'), '{}');
});

test('复制时仅信任服务器清单，包含原包、展开文件和 manifest', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = saveReferenceArchive(root, '资料.zip', buildReferenceZip([{ name: 'a.py', content: 'print(1)' }]));
  const forged: ReferenceArchive = { ...saved, name: '伪造.zip', files: [{ name: 'x', path: '../../escape', size: 1 }] };
  const destination = path.join(root, 'workspace');
  copyReferenceArchives(root, [forged], destination);
  const copied = path.join(destination, '.workbench-references', saved.id);
  assert.ok(existsSync(path.join(copied, 'archive.zip')));
  assert.ok(existsSync(path.join(copied, 'manifest.json')));
  assert.equal(readFileSync(path.join(copied, 'files', '0001.py'), 'utf8'), 'print(1)');
  assert.equal(existsSync(path.join(root, 'escape')), false);
});

test('拒绝虚假编号、被篡改的原件、清单路径和重复客户端编号', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => loadReferenceArchive(root, '../../bad'), /编号/);
  const zip = buildReferenceZip([{ name: 'a.txt', content: 'x' }]);
  const saved = saveReferenceArchive(root, '资料.zip', zip);
  const archiveDir = path.join(root, 'reference-uploads', saved.id);
  const manifestPath = path.join(archiveDir, 'manifest.json');
  const originalManifest = readFileSync(manifestPath);
  writeFileSync(path.join(archiveDir, 'archive.zip'), Buffer.from('tampered'));
  assert.throws(() => loadReferenceArchive(root, saved.id), /完整性/);
  writeFileSync(path.join(archiveDir, 'archive.zip'), zip);
  const expandedPath = path.join(archiveDir, 'files', '0001.txt');
  writeFileSync(expandedPath, 'y');
  assert.throws(() => loadReferenceArchive(root, saved.id), /展开文件完整性/);
  writeFileSync(expandedPath, 'x');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReferenceArchive;
  manifest.files[0]!.path = '../bad';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => loadReferenceArchive(root, saved.id), /清单格式/);
  writeFileSync(manifestPath, originalManifest);
  assert.throws(() => copyReferenceArchives(root, [saved, saved], path.join(root, 'workspace')), /重复/);
});

test('清理只删除七天以上且未引用的安全存档，复用上传会更新时间', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const retained = saveReferenceArchive(root, '保留.zip', buildReferenceZip([{ name: 'a.txt', content: 'a' }]));
  const stale = saveReferenceArchive(root, '过期.zip', buildReferenceZip([{ name: 'b.txt', content: 'b' }]));
  const recent = saveReferenceArchive(root, '近期.zip', buildReferenceZip([{ name: 'c.txt', content: 'c' }]));
  const uploads = path.join(root, 'reference-uploads');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  utimesSync(path.join(uploads, retained.id), old, old);
  utimesSync(path.join(uploads, stale.id), old, old);
  const invalid = path.join(uploads, 'not-an-id');
  mkdirSync(invalid);
  utimesSync(invalid, old, old);
  const partial = path.join(uploads, '.partial-123-old');
  mkdirSync(partial);
  writeFileSync(path.join(partial, 'archive.zip'), 'partial');
  utimesSync(partial, old, old);

  assert.equal(pruneUnusedReferenceArchives(root, new Set([retained.id])), 2);
  assert.ok(existsSync(path.join(uploads, retained.id)));
  assert.equal(existsSync(path.join(uploads, stale.id)), false);
  assert.ok(existsSync(path.join(uploads, recent.id)));
  assert.ok(existsSync(invalid));
  assert.equal(existsSync(partial), false);

  const before = statSync(path.join(uploads, retained.id)).mtimeMs;
  saveReferenceArchive(root, '保留.zip', buildReferenceZip([{ name: 'a.txt', content: 'a' }]));
  assert.ok(statSync(path.join(uploads, retained.id)).mtimeMs > before);
});

test('清理不会跟随名称合法的目录链接', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const uploads = path.join(root, 'reference-uploads');
  const outside = path.join(root, 'outside');
  mkdirSync(uploads, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const linkedId = 'a'.repeat(64);
  try { symlinkSync(outside, path.join(uploads, linkedId), 'junction'); }
  catch (error) {
    t.skip(`当前环境不能创建测试用目录链接：${String(error)}`);
    return;
  }
  assert.equal(pruneUnusedReferenceArchives(root, new Set(), Date.now() + 8 * 24 * 60 * 60 * 1_000), 0);
  assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('重试复制不会覆盖目的地已有的硬链接', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = saveReferenceArchive(root, '资料.zip', buildReferenceZip([{ name: 'a.txt', content: 'x' }]));
  const destination = path.join(root, 'workspace');
  const destinationDir = path.join(destination, '.workbench-references', saved.id);
  mkdirSync(path.join(destinationDir, 'files'), { recursive: true });
  const outside = path.join(root, 'outside.txt');
  writeFileSync(outside, 'sentinel');
  linkSync(outside, path.join(destinationDir, 'archive.zip'));
  assert.throws(() => copyReferenceArchives(root, [saved], destination), /链接/);
  assert.equal(readFileSync(outside, 'utf8'), 'sentinel');
});

test('目的路径含符号链接时拒绝复制', (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = saveReferenceArchive(root, '资料.zip', buildReferenceZip([{ name: 'a.txt', content: 'x' }]));
  const real = path.join(root, 'real');
  const link = path.join(root, 'linked-workspace');
  mkdirSync(real);
  try { symlinkSync(real, link, 'junction'); }
  catch (error) {
    t.skip(`当前环境不能创建测试用目录链接：${String(error)}`);
    return;
  }
  assert.throws(() => copyReferenceArchives(root, [saved], link), /符号链接/);
});
