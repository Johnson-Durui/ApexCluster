import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_CHANGED_LINES = 80;
const MAX_LINE_CHARS = 1_000;

export interface DiffSnapshot {
  id: string;
  path: string;
  files: Record<string, string>;
}

export interface WorkspaceDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  beforeHash: string | null;
  afterHash: string | null;
  beforeBytes: number | null;
  afterBytes: number | null;
  representation: 'text' | 'binary' | 'large';
  fragment?: string;
}

export interface WorkspaceDiffReport {
  beforeSnapshotId: string;
  afterSnapshotId: string;
  fingerprint: string;
  files: WorkspaceDiffFile[];
  text: string;
}

function hash(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function readFrozenFile(snapshot: DiffSnapshot, relative: string, expectedHash: string): Buffer {
  const root = realpathSync.native(snapshot.path);
  const absolute = path.resolve(root, relative.split('/').join(path.sep));
  if (!inside(absolute, root) || !existsSync(absolute)) throw new Error(`冻结快照文件缺失：${relative}`);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`冻结快照包含非普通文件：${relative}`);
  const actual = realpathSync.native(absolute);
  if (!inside(actual, root)) throw new Error(`冻结快照文件越过快照根目录：${relative}`);
  const data = readFileSync(actual);
  if (hash(data) !== expectedHash) throw new Error(`冻结快照文件哈希已漂移：${relative}`);
  return data;
}

function decodeText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function shown(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}…[line truncated]`;
}

function textFragment(before: string, after: string): string {
  const oldLines = before.split(/\r?\n/u);
  const newLines = after.split(/\r?\n/u);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const contextBefore = oldLines.slice(Math.max(0, prefix - 3), prefix);
  const contextAfter = oldLines.slice(oldLines.length - suffix, Math.min(oldLines.length - suffix + 3, oldLines.length));
  const lines = [`@@ old:${prefix + 1} new:${prefix + 1} @@`];
  lines.push(...contextBefore.map((line) => ` ${shown(line)}`));
  lines.push(...oldChanged.slice(0, MAX_CHANGED_LINES).map((line) => `-${shown(line)}`));
  if (oldChanged.length > MAX_CHANGED_LINES) lines.push(`-…[${oldChanged.length - MAX_CHANGED_LINES} old lines omitted]`);
  lines.push(...newChanged.slice(0, MAX_CHANGED_LINES).map((line) => `+${shown(line)}`));
  if (newChanged.length > MAX_CHANGED_LINES) lines.push(`+…[${newChanged.length - MAX_CHANGED_LINES} new lines omitted]`);
  lines.push(...contextAfter.map((line) => ` ${shown(line)}`));
  return lines.join('\n');
}

/** Build a program-generated report from already managed immutable snapshots. */
export function buildWorkspaceDiff(before: DiffSnapshot, after: DiffSnapshot): WorkspaceDiffReport {
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((file) => before.files[file] !== after.files[file])
    .sort();
  const files = paths.map((file): WorkspaceDiffFile => {
    const beforeHash = before.files[file] ?? null;
    const afterHash = after.files[file] ?? null;
    const beforeData = beforeHash ? readFrozenFile(before, file, beforeHash) : null;
    const afterData = afterHash ? readFrozenFile(after, file, afterHash) : null;
    const base = {
      path: file,
      status: beforeHash ? afterHash ? 'modified' as const : 'deleted' as const : 'added' as const,
      beforeHash,
      afterHash,
      beforeBytes: beforeData?.length ?? null,
      afterBytes: afterData?.length ?? null,
    };
    if ((beforeData?.length ?? 0) > MAX_TEXT_BYTES || (afterData?.length ?? 0) > MAX_TEXT_BYTES) {
      return { ...base, representation: 'large' };
    }
    const beforeText = beforeData ? decodeText(beforeData) : '';
    const afterText = afterData ? decodeText(afterData) : '';
    if (beforeText === null || afterText === null) return { ...base, representation: 'binary' };
    return { ...base, representation: 'text', fragment: textFragment(beforeText, afterText) };
  });
  const fingerprint = hash(JSON.stringify(files.map((file) => [file.path, file.beforeHash, file.afterHash])));
  const lines = [
    'Program-generated workspace diff. This report describes observed snapshot changes and does not attribute authorship.',
    `beforeSnapshot=${before.id}`,
    `afterSnapshot=${after.id}`,
  ];
  for (const file of files) {
    lines.push('', `=== ${file.status}: ${file.path} ===`, `beforeSHA256=${file.beforeHash ?? 'none'}`, `afterSHA256=${file.afterHash ?? 'none'}`, `beforeBytes=${file.beforeBytes ?? 'none'}`, `afterBytes=${file.afterBytes ?? 'none'}`);
    if (file.representation === 'text') lines.push(file.fragment!);
    else lines.push(`textFragment=omitted (${file.representation === 'large' ? 'file exceeds 256 KiB' : 'binary or invalid UTF-8'})`);
  }
  return { beforeSnapshotId: before.id, afterSnapshotId: after.id, fingerprint, files, text: lines.join('\n') };
}
