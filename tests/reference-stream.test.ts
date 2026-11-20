import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyReferenceArchivesAsync, loadReferenceArchive, saveReferenceArchive, saveReferenceArchiveStream } from '../src/orchestrator/reference-store.js';
import { buildReferenceZip } from './fixtures/reference-zip.js';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'dmw-reference-stream-'));
}

async function* chunks(bytes: Buffer, size = 73_777): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, Math.min(bytes.length, offset + size));
}

function expectedId(name: string, bytes: Buffer): string {
  return createHash('sha256').update(name).update(Buffer.from([0])).update(bytes).digest('hex');
}

test('超过 20 MiB 的 ZIP 可分块保存且原字节与摘要保持一致', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
  const zip = buildReferenceZip(Array.from({ length: 21 }, (_, index) => ({ name: `${index}.bin`, content: oneMiB })));
  assert.ok(zip.length > 20 * 1024 * 1024);
  const saved = await saveReferenceArchiveStream(root, '大资料.zip', chunks(zip));
  assert.equal(saved.id, expectedId('大资料.zip', zip));
  assert.equal(saved.size, zip.length);
  assert.deepEqual(readFileSync(path.join(root, 'reference-uploads', saved.id, 'archive.zip')), zip);
  assert.deepEqual(loadReferenceArchive(root, saved.id), saved);
});

test('上传源中断会清理 partial 目录且不会留下正式存档', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  async function* interrupted(): AsyncGenerator<Uint8Array> {
    yield Buffer.from('PK');
    throw new Error('模拟上传中断');
  }
  await assert.rejects(saveReferenceArchiveStream(root, '中断.zip', interrupted()), /模拟上传中断/);
  const uploads = path.join(root, 'reference-uploads');
  assert.deepEqual(existsSync(uploads) ? readdirSync(uploads) : [], []);
});

test('同一压缩包并发上传收敛到一个完整目录且不会覆盖', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zip = buildReferenceZip([{ name: 'src/app.ts', content: 'export const x = 1', method: 8 }]);
  const [first, second] = await Promise.all([
    saveReferenceArchiveStream(root, '并发.zip', chunks(zip, 3)),
    saveReferenceArchiveStream(root, '并发.zip', chunks(zip, 5)),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(readdirSync(path.join(root, 'reference-uploads')), [first.id]);
  assert.deepEqual(loadReferenceArchive(root, first.id), first);
});

test('异步复制兼容缺少 integrity 的小型旧存档', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = saveReferenceArchive(root, '旧包.zip', buildReferenceZip([{ name: 'a.txt', content: 'x' }]));
  rmSync(path.join(root, 'reference-uploads', saved.id, 'integrity.json'));
  const destination = path.join(root, 'workspace');
  await copyReferenceArchivesAsync(root, [saved], destination);
  assert.ok(existsSync(path.join(root, 'reference-uploads', saved.id, 'integrity.json')));
  assert.equal(readFileSync(path.join(destination, '.workbench-references', saved.id, 'files', '0001.txt'), 'utf8'), 'x');
});
