import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw, inflateRawSync } from 'node:zlib';
import type { ReferenceDocument } from './types.js';

export const REFERENCE_LIMITS = {
  maxDocuments: 20,
  maxArchives: 5,
  maxDocumentChars: 50_000,
  maxTotalChars: 100_000,
  maxFileBytes: 524_288,
  // 仅用于旧 JSON/Base64 小文件兼容入口；流式 ZIP 上传不设此上限。
  maxZipBytes: 20 * 1024 * 1024,
  maxArchiveEntries: 1_000,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxEntryBytes: 20 * 1024 * 1024,
} as const;

export interface ParsedArchiveFile {
  name: string;
  path: string;
  bytes: Buffer;
}

export interface ParsedArchiveFileOnDisk {
  name: string;
  path: string;
  size: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const SUPPORTED_TEXT = /\.(?:md|txt)$/i;

export function importReferenceDocuments(name: string, bytes: Buffer): { documents: ReferenceDocument[]; skipped: string[] } {
  validateDisplayName(name);
  if (!SUPPORTED_TEXT.test(name)) throw new Error('直接参考文档仅支持 Markdown（.md）和文本（.txt）；ZIP 请作为参考压缩包上传。');
  if (bytes.length > REFERENCE_LIMITS.maxFileBytes) throw new Error(`参考文档“${name}”超过 512 KiB 限制。`);
  const content = decodeText(name, bytes);
  validateText(name, content);
  return { documents: [{ name, content }], skipped: [] };
}

/** 原包由调用方另行保存；这里仅在安全且受支持时生成受控的展开副本。 */
export function parseReferenceArchive(name: string, bytes: Buffer): { files: ParsedArchiveFile[]; notes: string[] } {
  validateDisplayName(name);
  if (!/\.zip$/i.test(name)) throw new Error('参考压缩包必须是 .zip 文件。');
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) throw new Error('ZIP 压缩包格式错误或已损坏。');
  if (bytes.length > REFERENCE_LIMITS.maxZipBytes) throw new Error('ZIP 压缩包超过 20 MiB 限制。');

  const eocd = findEocd(bytes);
  const disk = readU16(bytes, eocd + 4);
  const centralDisk = readU16(bytes, eocd + 6);
  const entriesOnDisk = readU16(bytes, eocd + 8);
  const entryCount = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error('不支持多卷 ZIP 压缩包。');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return fallback('该压缩包使用 ZIP64，工作台未展开；原始 ZIP 将原样提供给 AI。');
  }
  if (entryCount > REFERENCE_LIMITS.maxArchiveEntries) throw new Error(`ZIP 条目超过 ${REFERENCE_LIMITS.maxArchiveEntries} 个限制。`);
  if (centralOffset + centralSize !== eocd || centralOffset > bytes.length) throw new Error('ZIP 中央目录范围无效。');

  const entries: ArchiveEntry[] = [];
  const paths = new Set<string>();
  const unsupported = new Set<string>();
  let expandedDeclared = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || readU32(bytes, cursor) !== CENTRAL_SIGNATURE) throw new Error('ZIP 中央目录格式错误。');
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const expectedCrc = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const startDisk = readU16(bytes, cursor + 34);
    const localOffset = readU32(bytes, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw new Error('ZIP 中央目录条目越界。');
    if (startDisk !== 0) throw new Error('不支持多卷 ZIP 压缩包。');
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)
      || hasExtraField(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength), ZIP64_EXTRA_ID)) {
      return fallback('该压缩包使用 ZIP64，工作台未展开；原始 ZIP 将原样提供给 AI。');
    }
    if (uncompressedSize > REFERENCE_LIMITS.maxEntryBytes) throw new Error('ZIP 条目解压后超过 20 MiB 限制。');
    expandedDeclared += uncompressedSize;
    if (expandedDeclared > REFERENCE_LIMITS.maxExpandedBytes) throw new Error('ZIP 解压后总大小超过 100 MiB 限制。');
    if (flags & ENCRYPTED_FLAG) unsupported.add('加密条目');
    if (method !== 0 && method !== 8) unsupported.add(`压缩算法 ${method}`);

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const decoded = tryDecodeZipName(nameBytes, Boolean(flags & UTF8_FLAG));
    if (decoded === null) unsupported.add('非 UTF-8 文件名');
    else {
      if (decoded.length > 1024) throw new Error('ZIP 条目名称超过 1024 个字符限制。');
      validateArchivePath(decoded);
      const key = decoded.replaceAll('\\', '/').toLocaleLowerCase('en-US');
      if (paths.has(key)) throw new Error(`ZIP 中存在重复路径：“${decoded}”。`);
      paths.add(key);
    }

    const compressed = readLocalEntry(bytes, {
      displayName: decoded ?? `第 ${index + 1} 个条目`, nameBytes, flags, method, expectedCrc,
      compressedSize, uncompressedSize, localOffset, centralOffset,
    });
    entries.push({ name: decoded, method, expectedCrc, uncompressedSize, compressed });
    cursor = next;
  }
  if (cursor !== eocd) throw new Error('ZIP 中央目录大小不匹配。');
  if (unsupported.size > 0) {
    return fallback(`该压缩包包含工作台无法安全展开的内容（${[...unsupported].join('、')}）；原始 ZIP 将原样提供给 AI，工作台未宣称已读取其中内容。`);
  }

  const files: ParsedArchiveFile[] = [];
  let expandedActual = 0;
  for (const entry of entries) {
    if (entry.name!.endsWith('/') || entry.name!.endsWith('\\')) continue;
    const output = decompress(entry.name!, entry.method, entry.compressed, entry.uncompressedSize);
    expandedActual += output.length;
    if (expandedActual > REFERENCE_LIMITS.maxExpandedBytes) throw new Error('ZIP 解压后总大小超过 100 MiB 限制。');
    if (crc32(output) !== entry.expectedCrc) throw new Error(`ZIP 条目“${entry.name}”CRC 校验失败。`);
    files.push({ name: entry.name!, path: safeOutputPath(files.length + 1, entry.name!), bytes: output });
  }
  return { files, notes: files.length === 0 ? ['压缩包中没有普通文件；原始 ZIP 仍会保存并提供给 AI。'] : [] };
}

/**
 * 从磁盘随机读取 ZIP 元数据并逐条目流式展开。原始 ZIP 由调用方保存；本函数只会写入
 * outputDir/files，并在不支持展开、超过自动展开预算或发生错误时清理该目录。
 */
export async function parseReferenceArchiveFile(
  name: string,
  zipPath: string,
  outputDir: string,
): Promise<{ files: ParsedArchiveFileOnDisk[]; notes: string[] }> {
  validateDisplayName(name);
  if (!/\.zip$/i.test(name)) throw new Error('参考压缩包必须是 .zip 文件。');

  const outputRoot = path.resolve(outputDir);
  const filesDir = path.resolve(outputRoot, 'files');
  if (path.dirname(filesDir) !== outputRoot) throw new Error('参考压缩包输出目录无效。');
  const cleanupFiles = async (recreate = true): Promise<void> => {
    try {
      const current = await lstat(filesDir);
      await rm(filesDir, current.isSymbolicLink()
        ? { force: true }
        : { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (recreate) await mkdir(filesDir, { recursive: true });
  };
  await mkdir(filesDir, { recursive: true });

  const archive = await open(zipPath, 'r');
  try {
    const stats = await archive.stat();
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 22) throw new Error('ZIP 压缩包格式错误或已损坏。');
    const tailLength = Math.min(stats.size, 65_557);
    const tail = await readExactFile(archive, stats.size - tailLength, tailLength);
    const relativeEocd = findEocd(tail);
    const eocd = stats.size - tailLength + relativeEocd;
    const disk = readU16(tail, relativeEocd + 4);
    const centralDisk = readU16(tail, relativeEocd + 6);
    const entriesOnDisk = readU16(tail, relativeEocd + 8);
    const entryCount = readU16(tail, relativeEocd + 10);
    const centralSize = readU32(tail, relativeEocd + 12);
    const centralOffset = readU32(tail, relativeEocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error('不支持多卷 ZIP 压缩包。');
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      await cleanupFiles();
      return fallbackOnDisk('该压缩包使用 ZIP64，工作台未展开；原始 ZIP 将原样提供给 AI。');
    }
    if (centralOffset + centralSize !== eocd || centralOffset > stats.size) throw new Error('ZIP 中央目录范围无效。');
    if (entryCount > REFERENCE_LIMITS.maxArchiveEntries) {
      await cleanupFiles();
      return fallbackOnDisk(`该压缩包超过自动展开的 ${REFERENCE_LIMITS.maxArchiveEntries} 个条目预算；原始 ZIP 将原样提供给 AI。`);
    }

    const entries: ArchiveFileEntry[] = [];
    const paths = new Set<string>();
    const unsupported = new Set<string>();
    let budgetNote: string | undefined;
    let expandedDeclared = 0;
    let cursor = centralOffset;

    for (let index = 0; index < entryCount; index += 1) {
      const header = await readExactFile(archive, cursor, 46);
      if (cursor + 46 > eocd || readU32(header, 0) !== CENTRAL_SIGNATURE) throw new Error('ZIP 中央目录格式错误。');
      const flags = readU16(header, 8);
      const method = readU16(header, 10);
      const expectedCrc = readU32(header, 16);
      const compressedSize = readU32(header, 20);
      const uncompressedSize = readU32(header, 24);
      const nameLength = readU16(header, 28);
      const extraLength = readU16(header, 30);
      const commentLength = readU16(header, 32);
      const startDisk = readU16(header, 34);
      const localOffset = readU32(header, 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > eocd) throw new Error('ZIP 中央目录条目越界。');
      if (startDisk !== 0) throw new Error('不支持多卷 ZIP 压缩包。');
      const variable = await readExactFile(archive, cursor + 46, nameLength + extraLength + commentLength);
      const nameBytes = variable.subarray(0, nameLength);
      const extra = variable.subarray(nameLength, nameLength + extraLength);
      if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff) || hasExtraField(extra, ZIP64_EXTRA_ID)) {
        await cleanupFiles();
        return fallbackOnDisk('该压缩包使用 ZIP64，工作台未展开；原始 ZIP 将原样提供给 AI。');
      }
      if (uncompressedSize > REFERENCE_LIMITS.maxEntryBytes) {
        budgetNote ??= '该压缩包包含超过 20 MiB 自动展开预算的条目；原始 ZIP 将原样提供给 AI。';
      }
      expandedDeclared += uncompressedSize;
      if (expandedDeclared > REFERENCE_LIMITS.maxExpandedBytes) {
        budgetNote ??= '该压缩包解压后超过 100 MiB 自动展开预算；原始 ZIP 将原样提供给 AI。';
      }
      if (flags & ENCRYPTED_FLAG) unsupported.add('加密条目');
      if (method !== 0 && method !== 8) unsupported.add(`压缩算法 ${method}`);

      const decoded = tryDecodeZipName(nameBytes, Boolean(flags & UTF8_FLAG));
      if (decoded === null) unsupported.add('非 UTF-8 文件名');
      else {
        if (decoded.length > 1024) throw new Error('ZIP 条目名称超过 1024 个字符限制。');
        validateArchivePath(decoded);
        const key = decoded.replaceAll('\\', '/').toLocaleLowerCase('en-US');
        if (paths.has(key)) throw new Error(`ZIP 中存在重复路径：“${decoded}”。`);
        paths.add(key);
      }

      const local = await readArchiveLocalEntry(archive, {
        displayName: decoded ?? `第 ${index + 1} 个条目`, nameBytes, flags, method, expectedCrc,
        compressedSize, uncompressedSize, localOffset, centralOffset,
      });
      entries.push({ name: decoded, method, expectedCrc, compressedSize, uncompressedSize, dataOffset: local.dataOffset });
      cursor = next;
    }
    if (cursor !== eocd) throw new Error('ZIP 中央目录大小不匹配。');
    if (unsupported.size > 0) {
      await cleanupFiles();
      return fallbackOnDisk(`该压缩包包含工作台无法安全展开的内容（${[...unsupported].join('、')}）；原始 ZIP 将原样提供给 AI，工作台未宣称已读取其中内容。`);
    }
    if (budgetNote) {
      await cleanupFiles();
      return fallbackOnDisk(budgetNote);
    }

    const files: ParsedArchiveFileOnDisk[] = [];
    for (const entry of entries) {
      if (entry.name!.endsWith('/') || entry.name!.endsWith('\\')) continue;
      const relativePath = safeOutputPath(files.length + 1, entry.name!);
      const destination = path.join(outputDir, ...relativePath.split('/'));
      await extractArchiveEntry(archive, entry, destination);
      files.push({ name: entry.name!, path: relativePath, size: entry.uncompressedSize });
    }
    return { files, notes: files.length === 0 ? ['压缩包中没有普通文件；原始 ZIP 仍会保存并提供给 AI。'] : [] };
  } catch (error) {
    await cleanupFiles().catch(() => undefined);
    throw error;
  } finally {
    await archive.close();
  }
}

interface ArchiveEntry { name: string | null; method: number; expectedCrc: number; uncompressedSize: number; compressed: Buffer }

interface ArchiveFileEntry {
  name: string | null;
  method: number;
  expectedCrc: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

function fallback(note: string): { files: ParsedArchiveFile[]; notes: string[] } {
  return { files: [], notes: [note] };
}

function fallbackOnDisk(note: string): { files: ParsedArchiveFileOnDisk[]; notes: string[] } {
  return { files: [], notes: [note] };
}

async function readExactFile(
  file: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error('ZIP 压缩包数据越界。');
  }
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error('ZIP 压缩包数据越界。');
    offset += result.bytesRead;
  }
  return buffer;
}

async function readArchiveLocalEntry(
  file: Awaited<ReturnType<typeof open>>,
  entry: {
    displayName: string; nameBytes: Buffer; flags: number; method: number; expectedCrc: number;
    compressedSize: number; uncompressedSize: number; localOffset: number; centralOffset: number;
  },
): Promise<{ dataOffset: number }> {
  const { displayName, nameBytes, flags, method, expectedCrc, compressedSize, uncompressedSize, localOffset, centralOffset } = entry;
  if (localOffset + 30 > centralOffset) throw new Error(`ZIP 条目“${displayName}”的本地头无效。`);
  const header = await readExactFile(file, localOffset, 30);
  if (readU32(header, 0) !== LOCAL_SIGNATURE) throw new Error(`ZIP 条目“${displayName}”的本地头无效。`);
  const localFlags = readU16(header, 6);
  const localMethod = readU16(header, 8);
  const localCrc = readU32(header, 14);
  const localCompressedSize = readU32(header, 18);
  const localUncompressedSize = readU32(header, 22);
  const localNameLength = readU16(header, 26);
  const localExtraLength = readU16(header, 28);
  const headerEnd = localOffset + 30 + localNameLength + localExtraLength;
  if (headerEnd > centralOffset || headerEnd + compressedSize > centralOffset) throw new Error(`ZIP 条目“${displayName}”的数据范围无效。`);
  if (localFlags !== flags || localMethod !== method) throw new Error(`ZIP 条目“${displayName}”的目录与本地头不一致。`);
  const variable = await readExactFile(file, localOffset + 30, localNameLength + localExtraLength);
  if (!variable.subarray(0, localNameLength).equals(nameBytes)) throw new Error(`ZIP 条目“${displayName}”的文件名不一致。`);
  const localExtra = variable.subarray(localNameLength);
  const localZip64 = hasExtraField(localExtra, ZIP64_EXTRA_ID);
  if (!localZip64 && !(flags & 0x0008)
    && (localCrc !== expectedCrc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) {
    throw new Error(`ZIP 条目“${displayName}”的尺寸或 CRC 信息不一致。`);
  }
  return { dataOffset: headerEnd };
}

async function extractArchiveEntry(
  file: Awaited<ReturnType<typeof open>>,
  entry: ArchiveFileEntry,
  destination: string,
): Promise<void> {
  const source = entry.compressedSize === 0
    ? Readable.from([])
    : createReadStream('', {
      fd: file.fd,
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1,
      autoClose: false,
      highWaterMark: 64 * 1024,
    });
  let actualSize = 0;
  let actualCrc = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      actualSize += chunk.length;
      if (actualSize > entry.uncompressedSize || actualSize > REFERENCE_LIMITS.maxEntryBytes) {
        callback(new Error(`ZIP 条目“${entry.name}”解压失败或膨胀输出过大。`));
        return;
      }
      actualCrc = crc32(chunk, actualCrc);
      callback(null, chunk);
    },
  });
  try {
    if (entry.method === 8) {
      await pipeline(source, createInflateRaw(), verify, createWriteStream(destination, { flags: 'wx' }));
    } else {
      await pipeline(source, verify, createWriteStream(destination, { flags: 'wx' }));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'EIO' || code === 'EDQUOT') throw error;
    throw new Error(`ZIP 条目“${entry.name}”解压失败或膨胀输出过大。`);
  }
  if (actualSize !== entry.uncompressedSize) throw new Error(`ZIP 条目“${entry.name}”解压尺寸不匹配。`);
  if (actualCrc !== entry.expectedCrc) throw new Error(`ZIP 条目“${entry.name}”CRC 校验失败。`);
}

function readLocalEntry(bytes: Buffer, entry: {
  displayName: string; nameBytes: Buffer; flags: number; method: number; expectedCrc: number;
  compressedSize: number; uncompressedSize: number; localOffset: number; centralOffset: number;
}): Buffer {
  const { displayName, nameBytes, flags, method, expectedCrc, compressedSize, uncompressedSize, localOffset, centralOffset } = entry;
  if (localOffset + 30 > centralOffset || readU32(bytes, localOffset) !== LOCAL_SIGNATURE) throw new Error(`ZIP 条目“${displayName}”的本地头无效。`);
  const localFlags = readU16(bytes, localOffset + 6);
  const localMethod = readU16(bytes, localOffset + 8);
  const localCrc = readU32(bytes, localOffset + 14);
  const localCompressedSize = readU32(bytes, localOffset + 18);
  const localUncompressedSize = readU32(bytes, localOffset + 22);
  const localNameLength = readU16(bytes, localOffset + 26);
  const localExtraLength = readU16(bytes, localOffset + 28);
  const headerEnd = localOffset + 30 + localNameLength + localExtraLength;
  if (headerEnd > centralOffset || headerEnd + compressedSize > centralOffset) throw new Error(`ZIP 条目“${displayName}”的数据范围无效。`);
  if (localFlags !== flags || localMethod !== method) throw new Error(`ZIP 条目“${displayName}”的目录与本地头不一致。`);
  if (!bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) throw new Error(`ZIP 条目“${displayName}”的文件名不一致。`);
  const localExtra = bytes.subarray(localOffset + 30 + localNameLength, headerEnd);
  const localZip64 = hasExtraField(localExtra, ZIP64_EXTRA_ID);
  if (!localZip64 && !(flags & 0x0008) && (localCrc !== expectedCrc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) {
    throw new Error(`ZIP 条目“${displayName}”的尺寸或 CRC 信息不一致。`);
  }
  return bytes.subarray(headerEnd, headerEnd + compressedSize);
}

function decompress(name: string, method: number, compressed: Buffer, expectedSize: number): Buffer {
  let output: Buffer;
  try { output = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: REFERENCE_LIMITS.maxEntryBytes + 1 }); }
  catch { throw new Error(`ZIP 条目“${name}”解压失败或膨胀输出过大。`); }
  if (output.length !== expectedSize) throw new Error(`ZIP 条目“${name}”解压尺寸不匹配。`);
  return output;
}

function safeOutputPath(index: number, originalName: string): string {
  const raw = path.extname(originalName).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  return `files/${String(index).padStart(4, '0')}.${raw || 'bin'}`;
}

function decodeText(name: string, bytes: Buffer): string {
  if (bytes.length === 0) throw new Error(`参考文档“${name}”为空。`);
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let body = bytes;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; body = bytes.subarray(2); }
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; body = bytes.subarray(2); }
  else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) body = bytes.subarray(3);
  try { return new TextDecoder(encoding, { fatal: true }).decode(body).replace(/^\uFEFF/, ''); }
  catch { throw new Error(`参考文档“${name}”不是有效的 UTF-8 或带 BOM 的 UTF-16 文本。`); }
}

function validateText(name: string, content: string): void {
  if (!content.trim()) throw new Error(`参考文档“${name}”为空。`);
  if (content.length > REFERENCE_LIMITS.maxDocumentChars) throw new Error(`参考文档“${name}”超过 ${REFERENCE_LIMITS.maxDocumentChars} 字符限制。`);
  let controls = 0;
  for (const char of content) {
    const code = char.codePointAt(0)!;
    if (code === 0 || (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code))) controls += 1;
  }
  if (controls > 0 && controls * 100 > content.length) throw new Error(`参考文档“${name}”疑似二进制文件。`);
}

function validateDisplayName(name: string): void {
  if (!name.trim()) throw new Error('参考文件名称不能为空。');
  if (name.length > 240) throw new Error('参考文件名称不能超过 240 个字符。');
  if (/[\\/:\x00-\x1f]/.test(name)) throw new Error('参考文件名称不能包含路径、冒号或控制字符。');
}

function validateArchivePath(value: string): void {
  if (!value || value.includes('\0')) throw new Error('ZIP 中存在无效文件名。');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error(`ZIP 中存在绝对路径：“${value}”。`);
  if (normalized.split('/').some((part) => part === '..')) throw new Error(`ZIP 中存在路径穿越：“${value}”。`);
}

function tryDecodeZipName(bytes: Buffer, utf8: boolean): string | null {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

function findEocd(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (readU32(bytes, offset) === EOCD_SIGNATURE && offset + 22 + readU16(bytes, offset + 20) === bytes.length) return offset;
  }
  throw new Error('ZIP 压缩包格式错误或已损坏。');
}

function hasExtraField(extra: Buffer, soughtId: number): boolean {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw new Error('ZIP 扩展字段格式错误。');
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) throw new Error('ZIP 扩展字段格式错误。');
    if (id === soughtId) return true;
    offset += size;
  }
  return false;
}

function readU16(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error('ZIP 压缩包数据越界。');
  return bytes.readUInt16LE(offset);
}

function readU32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error('ZIP 压缩包数据越界。');
  return bytes.readUInt32LE(offset);
}
