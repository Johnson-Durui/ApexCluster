import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { ReferenceArchive } from '../core/types.js';
import { parseReferenceArchive, parseReferenceArchiveFile, REFERENCE_LIMITS } from '../core/reference-documents.js';

const ID_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_FILE_PATTERN = /^files\/[0-9]+\.[a-z0-9]{1,16}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PARTIAL_PATTERN = /^\.partial-[a-z0-9.-]+$/i;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

interface ArchiveIntegrity {
  version: 1;
  zipSha256: string;
  manifestSha256: string;
  files: { path: string; sha256: string }[];
}

export async function saveReferenceArchiveStream(
  dataDir: string,
  name: string,
  source: AsyncIterable<Uint8Array>,
): Promise<ReferenceArchive> {
  validateArchiveUploadName(name);
  const root = path.join(dataDir, 'reference-uploads');
  assertNoSymlinkIfExists(root);
  await mkdir(root, { recursive: true });
  assertNoSymlinkIfExists(root);
  const temporary = await mkdtemp(path.join(root, '.partial-'));
  const archiveFile = path.join(temporary, 'archive.zip');
  const idHash = createHash('sha256').update(name, 'utf8').update(Buffer.from([0]));
  const zipHash = createHash('sha256');
  let size = 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await mkdir(path.join(temporary, 'files'), { recursive: true });
    handle = await open(archiveFile, 'wx');
    for await (const value of source) {
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      size += chunk.length;
      if (!Number.isSafeInteger(size)) throw new Error('参考压缩包大小超出安全整数范围。');
      idHash.update(chunk);
      zipHash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten <= 0) throw new Error('参考压缩包写入中断。');
        offset += bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    handle = null;
    const id = idHash.digest('hex');
    const finalDir = path.join(root, id);
    const existing = lstatIfExists(finalDir);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('参考压缩包目标路径不安全。');
      const loaded = await loadReferenceArchiveAsync(dataDir, id);
      await utimes(finalDir, new Date(), new Date());
      return loaded;
    }

    const parsed = await parseReferenceArchiveFile(name, archiveFile, temporary);
    const manifest: ReferenceArchive = { id, name, size, files: parsed.files, notes: parsed.notes };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(temporary, 'manifest.json'), manifestBytes, { flag: 'wx' });
    const fileDigests: ArchiveIntegrity['files'] = [];
    for (const file of manifest.files) {
      fileDigests.push({ path: file.path, sha256: await hashFileAsync(safeStoredPath(temporary, file.path)) });
    }
    const integrity: ArchiveIntegrity = {
      version: 1,
      zipSha256: zipHash.digest('hex'),
      manifestSha256: sha256(manifestBytes),
      files: fileDigests,
    };
    await writeFile(path.join(temporary, 'integrity.json'), `${JSON.stringify(integrity, null, 2)}\n`, { flag: 'wx' });
    try { await rename(temporary, finalDir); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') || !lstatIfExists(finalDir)) throw error;
      const loaded = await loadReferenceArchiveAsync(dataDir, id);
      await utimes(finalDir, new Date(), new Date());
      return loaded;
    }
    return manifest;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    const absoluteRoot = path.resolve(root);
    const absoluteTemporary = path.resolve(temporary);
    if (path.dirname(absoluteTemporary) === absoluteRoot && path.basename(absoluteTemporary).startsWith('.partial-')) {
      await rm(absoluteTemporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function saveReferenceArchive(dataDir: string, name: string, bytes: Buffer): ReferenceArchive {
  const id = archiveId(name, bytes);
  const root = path.join(dataDir, 'reference-uploads');
  const archiveDir = path.join(root, id);
  assertNoSymlinkIfExists(root);
  assertNoSymlinkIfExists(archiveDir);
  const existingManifest = path.join(archiveDir, 'manifest.json');
  if (existsSync(existingManifest)) {
    const existing = loadReferenceArchive(dataDir, id);
    const now = new Date();
    utimesSync(archiveDir, now, now);
    return existing;
  }

  const parsed = parseReferenceArchive(name, bytes);
  const filesDir = path.join(archiveDir, 'files');
  assertNoSymlinkIfExists(filesDir);
  mkdirSync(filesDir, { recursive: true });
  const archiveFile = path.join(archiveDir, 'archive.zip');
  assertSafeWriteTarget(archiveFile);
  writeFileSync(archiveFile, bytes);
  for (const file of parsed.files) {
    const target = safeStoredPath(archiveDir, file.path);
    assertSafeWriteTarget(target);
    writeFileSync(target, file.bytes);
  }
  const manifest: ReferenceArchive = {
    id,
    name,
    size: bytes.length,
    files: parsed.files.map((file) => ({ name: file.name, path: file.path, size: file.bytes.length })),
    notes: parsed.notes,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  assertSafeWriteTarget(existingManifest);
  writeFileSync(existingManifest, manifestBytes);
  const integrity = buildIntegrity(bytes, manifestBytes, parsed.files);
  const integrityFile = path.join(archiveDir, 'integrity.json');
  assertSafeWriteTarget(integrityFile);
  writeFileSync(integrityFile, `${JSON.stringify(integrity, null, 2)}\n`, 'utf8');
  return manifest;
}

export function loadReferenceArchive(dataDir: string, id: string): ReferenceArchive {
  if (!ID_PATTERN.test(id)) throw new Error('非法的参考压缩包编号。');
  const uploadsRoot = path.join(dataDir, 'reference-uploads');
  const archiveDir = path.join(uploadsRoot, id);
  assertNoSymlinkIfExists(uploadsRoot);
  assertNoSymlinkIfExists(archiveDir);
  assertNoSymlinkIfExists(path.join(archiveDir, 'files'));
  const manifestFile = path.join(archiveDir, 'manifest.json');
  const integrityFile = path.join(archiveDir, 'integrity.json');
  const archiveFile = path.join(archiveDir, 'archive.zip');
  assertRegularFile(manifestFile, '参考压缩包清单不存在或不是普通文件。');
  assertRegularFile(archiveFile, '参考压缩包原件不存在或不是普通文件。');
  const manifestBytes = readFileSync(manifestFile);
  let raw: unknown;
  try { raw = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('参考压缩包清单已损坏。'); }
  const manifest = validateManifest(raw, id);
  const archiveStat = statSync(archiveFile);
  if (Number(archiveStat.size) !== manifest.size) throw new Error('参考压缩包原件完整性校验失败。');
  const archiveDigests = hashArchiveFileSync(manifest.name, archiveFile);
  if (archiveDigests.id !== id) throw new Error('参考压缩包原件完整性校验失败。');
  const integrityStat = lstatIfExists(integrityFile);
  let integrity: ArchiveIntegrity;
  if (integrityStat === null) {
    if (manifest.size > REFERENCE_LIMITS.maxZipBytes) throw new Error('大型旧版参考压缩包缺少完整性记录，请重新上传。');
    integrity = migrateLegacyIntegrity(archiveDir, manifest, manifestBytes, readFileSync(archiveFile), integrityFile);
  }
  else {
    assertRegularFile(integrityFile, '参考压缩包完整性记录不存在或不是普通文件。');
    integrity = readIntegrity(integrityFile, manifest);
  }
  if (archiveDigests.zipSha256 !== integrity.zipSha256 || sha256(manifestBytes) !== integrity.manifestSha256) throw new Error('参考压缩包原件或清单完整性校验失败。');
  for (const file of manifest.files) {
    const source = safeStoredPath(archiveDir, file.path);
    assertRegularFile(source, `参考压缩包展开文件缺失：“${file.path}”。`);
    const expected = integrity.files.find((item) => item.path === file.path)!;
    if (hashFileSync(source) !== expected.sha256) throw new Error(`参考压缩包展开文件完整性校验失败：“${file.path}”。`);
  }
  return manifest;
}

export async function loadReferenceArchiveAsync(dataDir: string, id: string): Promise<ReferenceArchive> {
  if (!ID_PATTERN.test(id)) throw new Error('非法的参考压缩包编号。');
  const archiveDir = path.join(dataDir, 'reference-uploads', id);
  assertNoSymlinkIfExists(path.join(dataDir, 'reference-uploads'));
  assertNoSymlinkIfExists(archiveDir);
  assertNoSymlinkIfExists(path.join(archiveDir, 'files'));
  const manifestFile = path.join(archiveDir, 'manifest.json');
  const integrityFile = path.join(archiveDir, 'integrity.json');
  const archiveFile = path.join(archiveDir, 'archive.zip');
  assertRegularFile(manifestFile, '参考压缩包清单不存在或不是普通文件。');
  assertRegularFile(archiveFile, '参考压缩包原件不存在或不是普通文件。');
  if (lstatIfExists(integrityFile) === null) return loadReferenceArchive(dataDir, id);
  assertRegularFile(integrityFile, '参考压缩包完整性记录不存在或不是普通文件。');
  const manifestBytes = await readFile(manifestFile);
  let raw: unknown;
  try { raw = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('参考压缩包清单已损坏。'); }
  const manifest = validateManifest(raw, id);
  const archiveStat = await stat(archiveFile);
  if (Number(archiveStat.size) !== manifest.size) throw new Error('参考压缩包原件完整性校验失败。');
  const integrity = readIntegrity(integrityFile, manifest);
  const archiveDigests = await hashArchiveFileAsync(manifest.name, archiveFile);
  if (archiveDigests.id !== id || archiveDigests.zipSha256 !== integrity.zipSha256 || sha256(manifestBytes) !== integrity.manifestSha256) {
    throw new Error('参考压缩包原件或清单完整性校验失败。');
  }
  for (const file of manifest.files) {
    const source = safeStoredPath(archiveDir, file.path);
    assertRegularFile(source, `参考压缩包展开文件缺失：“${file.path}”。`);
    const expected = integrity.files.find((item) => item.path === file.path)!;
    if (await hashFileAsync(source) !== expected.sha256) throw new Error(`参考压缩包展开文件完整性校验失败：“${file.path}”。`);
  }
  return manifest;
}

export function pruneUnusedReferenceArchives(dataDir: string, retainedIds: ReadonlySet<string>, now = Date.now()): number {
  const uploadsRoot = path.resolve(dataDir, 'reference-uploads');
  const rootStat = lstatIfExists(uploadsRoot);
  if (!rootStat) return 0;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('参考压缩包存储目录不是安全的普通目录。');
  let removed = 0;
  for (const entry of readdirSync(uploadsRoot, { withFileTypes: true })) {
    const isArchive = ID_PATTERN.test(entry.name);
    const isPartial = PARTIAL_PATTERN.test(entry.name);
    if ((!isArchive && !isPartial) || (isArchive && retainedIds.has(entry.name)) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.resolve(uploadsRoot, entry.name);
    if (path.dirname(candidate) !== uploadsRoot) continue;
    const stat = lstatIfExists(candidate);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || now - Number(stat.mtimeMs) < RETENTION_MS) continue;
    if (treeContainsSymlink(candidate)) continue;
    rmSync(candidate, { recursive: true, force: false });
    removed += 1;
  }
  return removed;
}

export function copyReferenceArchives(dataDir: string, archives: ReferenceArchive[], destinationRoot: string): void {
  if (archives.length > REFERENCE_LIMITS.maxArchives) throw new Error(`参考压缩包超过 ${REFERENCE_LIMITS.maxArchives} 个限制。`);
  assertNoSymlinkChain(destinationRoot);
  mkdirSync(destinationRoot, { recursive: true });
  const destinationBase = path.join(destinationRoot, '.workbench-references');
  assertNoSymlinkIfExists(destinationBase);
  mkdirSync(destinationBase, { recursive: true });
  const ids = new Set<string>();
  for (const requested of archives) {
    if (!ID_PATTERN.test(requested.id) || ids.has(requested.id)) throw new Error('参考压缩包编号非法或重复。');
    ids.add(requested.id);
    const manifest = loadReferenceArchive(dataDir, requested.id);
    const sourceDir = path.join(dataDir, 'reference-uploads', manifest.id);
    const destinationDir = path.join(destinationBase, manifest.id);
    assertNoSymlinkIfExists(destinationDir);
    const destinationFiles = path.join(destinationDir, 'files');
    assertNoSymlinkIfExists(destinationFiles);
    mkdirSync(destinationFiles, { recursive: true });
    copyRegularFile(path.join(sourceDir, 'archive.zip'), path.join(destinationDir, 'archive.zip'));
    copyRegularFile(path.join(sourceDir, 'manifest.json'), path.join(destinationDir, 'manifest.json'));
    for (const file of manifest.files) {
      copyRegularFile(safeStoredPath(sourceDir, file.path), safeStoredPath(destinationDir, file.path));
    }
  }
}

export async function copyReferenceArchivesAsync(dataDir: string, archives: ReferenceArchive[], destinationRoot: string): Promise<void> {
  if (archives.length > REFERENCE_LIMITS.maxArchives) throw new Error(`参考压缩包超过 ${REFERENCE_LIMITS.maxArchives} 个限制。`);
  assertNoSymlinkChain(destinationRoot);
  await mkdir(destinationRoot, { recursive: true });
  const destinationBase = path.join(destinationRoot, '.workbench-references');
  assertNoSymlinkIfExists(destinationBase);
  await mkdir(destinationBase, { recursive: true });
  const ids = new Set<string>();
  for (const requested of archives) {
    if (!ID_PATTERN.test(requested.id) || ids.has(requested.id)) throw new Error('参考压缩包编号非法或重复。');
    ids.add(requested.id);
    const manifest = await loadReferenceArchiveAsync(dataDir, requested.id);
    const sourceDir = path.join(dataDir, 'reference-uploads', manifest.id);
    const destinationDir = path.join(destinationBase, manifest.id);
    assertNoSymlinkIfExists(destinationDir);
    const destinationFiles = path.join(destinationDir, 'files');
    assertNoSymlinkIfExists(destinationFiles);
    await mkdir(destinationFiles, { recursive: true });
    await copyRegularFileAsync(path.join(sourceDir, 'archive.zip'), path.join(destinationDir, 'archive.zip'));
    await copyRegularFileAsync(path.join(sourceDir, 'manifest.json'), path.join(destinationDir, 'manifest.json'));
    for (const file of manifest.files) await copyRegularFileAsync(safeStoredPath(sourceDir, file.path), safeStoredPath(destinationDir, file.path));
  }
}

function archiveId(name: string, bytes: Buffer): string {
  return createHash('sha256').update(name, 'utf8').update(Buffer.from([0])).update(bytes).digest('hex');
}

function validateArchiveUploadName(name: string): void {
  if (!name || name.length > 240 || !/\.zip$/i.test(name) || /[\\/:\x00-\x1f]/.test(name)) throw new Error('参考压缩包文件名无效。');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashFileSync(file: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
  return hash.digest('hex');
}

function hashArchiveFileSync(name: string, file: string): { id: string; zipSha256: string } {
  const idHash = createHash('sha256').update(name, 'utf8').update(Buffer.from([0]));
  const zipHash = createHash('sha256');
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      idHash.update(chunk);
      zipHash.update(chunk);
    }
  } finally { closeSync(descriptor); }
  return { id: idHash.digest('hex'), zipSha256: zipHash.digest('hex') };
}

async function hashFileAsync(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

async function hashArchiveFileAsync(name: string, file: string): Promise<{ id: string; zipSha256: string }> {
  const idHash = createHash('sha256').update(name, 'utf8').update(Buffer.from([0]));
  const zipHash = createHash('sha256');
  const handle = await open(file, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      idHash.update(chunk);
      zipHash.update(chunk);
    }
  } finally { await handle.close(); }
  return { id: idHash.digest('hex'), zipSha256: zipHash.digest('hex') };
}

function buildIntegrity(zipBytes: Buffer, manifestBytes: Buffer, files: { path: string; bytes: Buffer }[]): ArchiveIntegrity {
  return {
    version: 1,
    zipSha256: sha256(zipBytes),
    manifestSha256: sha256(manifestBytes),
    files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
  };
}

function migrateLegacyIntegrity(
  archiveDir: string,
  manifest: ReferenceArchive,
  manifestBytes: Buffer,
  archiveBytes: Buffer,
  integrityFile: string,
): ArchiveIntegrity {
  const parsed = parseReferenceArchive(manifest.name, archiveBytes);
  const expected: ReferenceArchive = {
    id: manifest.id,
    name: manifest.name,
    size: archiveBytes.length,
    files: parsed.files.map((file) => ({ name: file.name, path: file.path, size: file.bytes.length })),
    notes: parsed.notes,
  };
  if (!isDeepStrictEqual(manifest, expected)) throw new Error('旧版参考压缩包清单与原件不一致。');
  for (let index = 0; index < parsed.files.length; index += 1) {
    const parsedFile = parsed.files[index]!;
    const stored = safeStoredPath(archiveDir, parsedFile.path);
    assertRegularFile(stored, `参考压缩包展开文件缺失：“${parsedFile.path}”。`);
    if (!readFileSync(stored).equals(parsedFile.bytes)) throw new Error(`参考压缩包展开文件完整性校验失败：“${parsedFile.path}”。`);
  }
  const integrity = buildIntegrity(archiveBytes, manifestBytes, parsed.files);
  assertSafeWriteTarget(integrityFile);
  writeFileSync(integrityFile, `${JSON.stringify(integrity, null, 2)}\n`, 'utf8');
  return integrity;
}

function readIntegrity(file: string, manifest: ReferenceArchive): ArchiveIntegrity {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('参考压缩包完整性记录已损坏。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参考压缩包完整性记录格式无效。');
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.zipSha256 !== 'string' || !DIGEST_PATTERN.test(item.zipSha256)
    || typeof item.manifestSha256 !== 'string' || !DIGEST_PATTERN.test(item.manifestSha256) || !Array.isArray(item.files)
    || item.files.length !== manifest.files.length) throw new Error('参考压缩包完整性记录格式无效。');
  const paths = new Set<string>();
  const files = item.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('参考压缩包完整性记录格式无效。');
    const fileEntry = entry as Record<string, unknown>;
    if (typeof fileEntry.path !== 'string' || !SAFE_FILE_PATTERN.test(fileEntry.path) || paths.has(fileEntry.path)
      || typeof fileEntry.sha256 !== 'string' || !DIGEST_PATTERN.test(fileEntry.sha256)) throw new Error('参考压缩包完整性记录格式无效。');
    paths.add(fileEntry.path);
    return { path: fileEntry.path, sha256: fileEntry.sha256 };
  });
  if (manifest.files.some((fileEntry) => !paths.has(fileEntry.path))) throw new Error('参考压缩包完整性记录与清单不一致。');
  return { version: 1, zipSha256: item.zipSha256, manifestSha256: item.manifestSha256, files };
}

function validateManifest(value: unknown, expectedId: string): ReferenceArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参考压缩包清单格式无效。');
  const item = value as Record<string, unknown>;
  if (item.id !== expectedId || typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 240
    || !Number.isSafeInteger(item.size) || (item.size as number) < 0
    || !Array.isArray(item.files) || item.files.length > REFERENCE_LIMITS.maxArchiveEntries
    || !Array.isArray(item.notes) || !item.notes.every((note) => typeof note === 'string')) {
    throw new Error('参考压缩包清单格式无效。');
  }
  const paths = new Set<string>();
  let totalSize = 0;
  const files: ReferenceArchive['files'] = item.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('参考压缩包文件清单格式无效。');
    const file = entry as Record<string, unknown>;
    if (typeof file.name !== 'string' || file.name.length > 1024 || typeof file.path !== 'string' || !SAFE_FILE_PATTERN.test(file.path)
      || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > REFERENCE_LIMITS.maxEntryBytes
      || paths.has(file.path)) throw new Error('参考压缩包文件清单格式无效。');
    paths.add(file.path);
    totalSize += file.size as number;
    if (totalSize > REFERENCE_LIMITS.maxExpandedBytes) throw new Error('参考压缩包文件清单格式无效。');
    return { name: file.name, path: file.path, size: file.size as number };
  });
  return { id: expectedId, name: item.name, size: item.size as number, files, notes: item.notes as string[] };
}

function safeStoredPath(root: string, relative: string): string {
  if (!SAFE_FILE_PATTERN.test(relative)) throw new Error('参考压缩包包含非法的存储路径。');
  return path.join(root, ...relative.split('/'));
}

function assertRegularFile(file: string, message: string): void {
  const stat = lstatIfExists(file);
  if (!stat) throw new Error(message);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(message);
}

function assertNoSymlinkIfExists(target: string): void {
  const stat = lstatIfExists(target);
  if (stat?.isSymbolicLink()) throw new Error(`拒绝使用符号链接路径：“${target}”。`);
}

function assertNoSymlinkChain(target: string): void {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assertNoSymlinkIfExists(current);
  }
}

function copyRegularFile(source: string, destination: string): void {
  assertRegularFile(source, `参考文件源不存在或不是普通文件：“${source}”。`);
  assertSafeWriteTarget(destination);
  copyFileSync(source, destination);
}

async function copyRegularFileAsync(source: string, destination: string): Promise<void> {
  assertRegularFile(source, `参考文件源不存在或不是普通文件：“${source}”。`);
  assertSafeWriteTarget(destination);
  await copyFile(source, destination);
}

function assertSafeWriteTarget(target: string): void {
  const stat = lstatIfExists(target);
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)) {
    throw new Error(`拒绝覆盖链接或非普通文件：“${target}”。`);
  }
}

function lstatIfExists(target: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function treeContainsSymlink(root: string): boolean {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    const stat = lstatIfExists(child);
    if (!stat || stat.isSymbolicLink()) return true;
    if (stat.isDirectory() && treeContainsSymlink(child)) return true;
  }
  return false;
}
