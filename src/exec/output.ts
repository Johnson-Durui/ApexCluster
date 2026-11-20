import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ChatStore } from '../chat/store.js';

/** Lightweight status preview while a background command is still writing its logs. */
export function readExecTail(directory: string, name: 'stdout' | 'stderr'): string {
  const file = path.join(directory, `${name}.txt`);
  if (!existsSync(file) || !lstatSync(file).isFile()) return '';
  const descriptor = openSync(file, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const bytes = Buffer.alloc(Math.min(size, 1_500));
    const read = readSync(descriptor, bytes, 0, bytes.length, size - bytes.length);
    return bytes.subarray(0, read).toString('utf8');
  } finally { closeSync(descriptor); }
}

/** Transfer logs from a backend-owned output directory into immutable chat evidence. */
export function registerExecOutput(store: ChatStore, chatId: string, jobId: string, name: 'stdout' | 'stderr', ref: string, directory: string) {
  const filePath = path.resolve(directory, ref);
  const actual = realpathSync(filePath);
  const root = realpathSync(directory);
  const relative = path.relative(root, actual);
  const info = lstatSync(filePath);
  if (!relative || relative.split(path.sep)[0] === '..' || path.isAbsolute(relative) || !info.isFile() || info.isSymbolicLink()) {
    throw new Error('执行输出引用不在作业输出目录中');
  }
  if (info.size > 8 * 1024 * 1024) throw new Error('执行输出超过 8 MiB 登记上限');
  const text = readFileSync(actual, 'utf8');
  const file = `exec-${jobId}-${name}.txt`;
  try {
    return store.putBlob(chatId, file, text);
  } catch (error) {
    const relativePath = `blobs/${file}`;
    const bytes = Buffer.from(text);
    try {
      if (store.readBlob(chatId, relativePath).equals(bytes)) {
        return { relativePath, hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
      }
    } catch { /* Preserve the original publication failure. */ }
    throw error;
  }
}
