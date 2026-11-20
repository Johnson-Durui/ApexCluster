import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { PROJECT_OUTPUT_DIRECTORY } from '../artifacts/project-output.js';
import { buildWorkspaceDiff, type WorkspaceDiffReport } from './changes.js';

const REPARSE_POINT = 0x400;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const SENSITIVE = new Set([
  '.env', '.git', '.ssh', '.aws', '.azure', '.claude', '.codex', '.docker', '.gnupg', '.kube', '.terraform.d',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'credentials.json', 'secrets.json', 'auth.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SKIP_COPY = new Set(['node_modules', 'dist', 'build', '.cache', '__pycache__']);
const WINDOWS_INVALID_SEGMENT = /[<>:"|?*\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;

export interface WorkspaceGrant {
  id: string;
  path: string;
  name: string;
  version: number;
  active: boolean;
  grantedAt: string;
  revokedAt?: string;
}

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  taskId: string;
  kind: 'baseline' | 'edit' | 'test';
  path: string;
  createdAt: string;
  files: Record<string, string>;
  sourceSnapshotId?: string;
  /** Program-managed pipeline metadata was intentionally omitted from this source snapshot. */
  excludesPipelineMetadata?: true;
}

export interface IntegrationResult {
  journalId: string;
  changed: string[];
  created: string[];
}

export interface WorkspaceChanges {
  modified: string[];
  created: string[];
  deleted: string[];
}

interface StateFile { version: 1; workspaces: WorkspaceGrant[] }
interface IntegrationJournal {
  version: 1;
  id: string;
  workspaceId: string;
  baselineSnapshotId: string;
  editedSnapshotId: string;
  state: 'pending' | 'applied' | 'rolled_back' | 'rollback_uncertain';
  changed: string[];
  created: string[];
  entries: { path: string; beforeHash: string | null; afterHash: string; backup?: string }[];
  createdAt: string;
  appliedAt?: string;
  error?: string;
}

const REGISTRY_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
interface RegistryLockCandidate { directory: string; marker: string }
interface RegistryLockOwner { marker: string; pid: number }

function waitForRegistryLock(): void {
  Atomics.wait(REGISTRY_LOCK_WAIT, 0, 0, 10);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function lockOwner(file: string): RegistryLockOwner | undefined {
  try {
    const entries = readdirSync(file);
    if (entries.length !== 1) return undefined;
    const marker = entries[0]!;
    const match = /^owner-(\d+)-([0-9a-f-]+)\.json$/iu.exec(marker);
    if (!match) return undefined;
    const markerPath = path.join(file, marker);
    const info = lstatSync(markerPath);
    if (!info.isFile() || isReparse(info)) return undefined;
    const value = JSON.parse(readFileSync(markerPath, 'utf8')) as { pid?: unknown; token?: unknown };
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1
      || value.pid !== Number(match[1]) || value.token !== match[1] + '-' + match[2]) return undefined;
    return { marker, pid: value.pid };
  } catch {
    return undefined;
  }
}

function removeLockMarker(file: string, marker: string, strict = false): boolean {
  try {
    unlinkSync(path.join(file, marker));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (!strict && ['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '')) return false;
    throw error;
  }
  try {
    rmdirSync(file);
  } catch (error) {
    if (!['EACCES', 'EBUSY', 'ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  return true;
}

function recoverAbandonedRegistryLock(file: string): boolean {
  const owner = lockOwner(file);
  if (!owner || processExists(owner.pid)) return false;
  return removeLockMarker(file, owner.marker);
}

function recoverEmptyRegistryLock(file: string): boolean {
  try {
    const info = lstatSync(file);
    if (!info.isDirectory() || isReparse(info) || readdirSync(file).length !== 0) return false;
    rmdirSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if (['EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

function createRegistryLockCandidate(file: string): RegistryLockCandidate {
  const token = process.pid + '-' + randomUUID();
  const directory = file + '.candidate-' + token;
  const marker = 'owner-' + token + '.json';
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(path.join(directory, marker), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + '\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { directory, marker };
}

function discardRegistryLockCandidate(candidate: RegistryLockCandidate): void {
  try { unlinkSync(path.join(candidate.directory, candidate.marker)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try { rmdirSync(candidate.directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function acquireRegistryLock(file: string): string {
  const started = Date.now();
  const candidate = createRegistryLockCandidate(file);
  for (;;) {
    try {
      renameSync(candidate.directory, file);
      return candidate.marker;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code ?? '')) {
        discardRegistryLockCandidate(candidate);
        throw error;
      }
      if (!existsSync(file)) continue;
      if (recoverAbandonedRegistryLock(file)) continue;
      if (recoverEmptyRegistryLock(file)) continue;
      if (Date.now() - started >= REGISTRY_LOCK_TIMEOUT_MS) {
        discardRegistryLockCandidate(candidate);
        throw new Error('工作区授权注册表正被其他进程占用。');
      }
      waitForRegistryLock();
    }
  }
}

function withRegistryLock<T>(file: string, action: () => T): T {
  const marker = acquireRegistryLock(file);
  try {
    return action();
  } finally {
    if (!removeLockMarker(file, marker, true)) throw new Error('工作区授权注册表锁所有权已丢失。');
  }
}

function hash(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temp, file);
}

function isReparse(stats: Stats): boolean {
  const attributes = (stats as unknown as { fileAttributes?: number }).fileAttributes ?? 0;
  return stats.isSymbolicLink() || Boolean(attributes & REPARSE_POINT);
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sensitiveSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return SENSITIVE.has(lower) || lower.startsWith('.env.');
}

function sensitivePath(segments: string[]): boolean {
  const lower = segments.map(segment => segment.toLowerCase());
  return lower.some(sensitiveSegment) || lower.some((segment, index) =>
    segment === '.config' && ['gcloud', 'gh'].includes(lower[index + 1] ?? ''));
}

/** A rejected path has performed no file operation and can be corrected by the caller. */
export class WorkspacePathError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkspacePathError'; }
}

export class WorkspaceFileMissingError extends Error {
  constructor(relativePath: string) { super('文件路径不存在：' + relativePath); }
}

function assertSafeWindowsSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..') throw new WorkspacePathError('文件路径包含不安全的路径段。');
  if (/[ .]$/u.test(segment)) throw new WorkspacePathError('Windows 路径段不能以空格或句点结尾。');
  if (WINDOWS_INVALID_SEGMENT.test(segment)) throw new WorkspacePathError('Windows 路径段包含控制字符、通配符、备用数据流或其他非法字符。');
  if (WINDOWS_RESERVED_DEVICE.test(segment)) throw new WorkspacePathError('Windows 路径段不能使用保留设备名。');
}

function absoluteSegments(absolute: string): string[] {
  return absolute.split(/[\\/]+/).filter((segment) => segment && !/^[a-z]:$/iu.test(segment));
}

function safeRelative(relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new WorkspacePathError('文件路径必须是工作区内的相对路径。');
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  parts.forEach(assertSafeWindowsSegment);
  if (parts[0]!.toLowerCase() === PROJECT_OUTPUT_DIRECTORY) throw new WorkspacePathError('agent-outputs 是受管产物目录，请使用会话文件工具访问正式产物。');
  if (sensitivePath(parts)) {
    throw new WorkspacePathError('文件路径指向凭证、认证或版本控制元数据。');
  }
  return parts.join(path.sep);
}

function canonicalRoot(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('授权目录必须是绝对路径。');
  const resolved = path.resolve(input);
  const rootParts = absoluteSegments(resolved);
  rootParts.forEach(assertSafeWindowsSegment);
  if (sensitivePath(rootParts)) throw new Error('不能授权凭证或认证目录。');
  const info = lstatSync(resolved);
  if (!info.isDirectory() || isReparse(info)) throw new Error('授权目录必须是真实目录，不能是链接或 junction。');
  const actual = realpathSync.native(resolved);
  if (!sameWorkspacePath(actual, resolved)) {
    throw new Error('授权目录的规范路径与所选路径不一致。');
  }
  return actual;
}

function resolveSafe(root: string, relative: string, allowMissingLeaf = false): string {
  const safe = safeRelative(relative);
  const candidate = path.resolve(root, safe);
  if (!inside(candidate, root)) throw new Error('文件路径越过授权目录。');
  const parts = safe.split(path.sep);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    if (!existsSync(cursor)) {
      if (allowMissingLeaf && index === parts.length - 1) return candidate;
      throw new WorkspaceFileMissingError(relative);
    }
    const info = lstatSync(cursor);
    if (isReparse(info)) throw new Error(`文件路径包含链接或 junction：${relative}`);
    if (info.isFile() && info.nlink > 1) throw new Error(`文件路径包含硬链接：${relative}`);
    const actual = realpathSync.native(cursor);
    if (!inside(actual, root)) throw new Error(`文件实际路径越过授权目录：${relative}`);
  }
  return candidate;
}

function walk(root: string, copyRoot?: string, excludePipelineMetadata = false): Record<string, string> {
  const files: Record<string, string> = {};
  const queue = [''];
  while (queue.length) {
    const relativeDir = queue.shift()!;
    const absoluteDir = relativeDir ? resolveSafe(root, relativeDir) : root;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const lower = entry.name.toLowerCase();
      assertSafeWindowsSegment(entry.name);
      if (!relativeDir && (lower === PROJECT_OUTPUT_DIRECTORY || (excludePipelineMetadata && lower === '.agent'))) continue;
      if (sensitivePath(relative.split(path.sep)) || SKIP_COPY.has(entry.name)) continue;
      const absolute = path.join(absoluteDir, entry.name);
      const info = lstatSync(absolute);
      if (isReparse(info)) throw new Error(`工作区包含链接或 junction：${relative}`);
      if (info.isFile() && info.nlink > 1) throw new Error(`工作区包含硬链接：${relative}`);
      if (entry.isDirectory()) {
        queue.push(relative);
        if (copyRoot) mkdirSync(path.join(copyRoot, relative), { recursive: true });
        continue;
      }
      if (!entry.isFile()) throw new Error(`工作区包含非普通文件：${relative}`);
      if (info.size > MAX_FILE_BYTES) throw new Error(`文件超过快照上限：${relative}`);
      if (Object.keys(files).length >= MAX_FILES) throw new Error(`工作区文件数超过 ${MAX_FILES}。`);
      const data = readFileSync(absolute);
      files[relative.replaceAll('\\', '/')] = hash(data);
      if (copyRoot) {
        const destination = path.join(copyRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(absolute, destination, 0);
      }
    }
  }
  return files;
}

function snapshotFile(root: string, id: string): string {
  return path.join(root, 'snapshots', id, 'snapshot.json');
}

export class WorkspaceRegistry {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly pendingNativeRequests = new Set<string>();

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.statePath = path.join(root, 'workspaces.json');
    this.lockPath = path.join(root, '.workspaces.lock');
    this.readState();
  }

  issueNativeSelectionRequest(): string {
    const requestId = randomUUID();
    this.pendingNativeRequests.add(requestId);
    return requestId;
  }

  list(): WorkspaceGrant[] {
    return this.readState().workspaces.map((workspace) => ({ ...workspace }));
  }

  get(id: string): WorkspaceGrant {
    const workspace = this.readState().workspaces.find((candidate) => candidate.id === id);
    if (!workspace) throw new Error('工作区授权不存在。');
    return { ...workspace };
  }

  grantFromNativeSelection(selectedPath: string, requestId: string): WorkspaceGrant {
    if (!this.pendingNativeRequests.delete(requestId)) throw new Error('目录选择请求无效、已消费或不是由宿主签发。');
    const actual = canonicalRoot(selectedPath);
    return this.mutate((state) => {
      const existing = state.workspaces.find((workspace) => sameWorkspacePath(workspace.path, actual));
      const now = new Date().toISOString();
      if (existing) {
        existing.active = true;
        existing.version += 1;
        existing.grantedAt = now;
        delete existing.revokedAt;
        return { ...existing };
      }
      const workspace: WorkspaceGrant = {
        id: 'w-' + randomUUID(),
        path: actual,
        name: path.basename(actual),
        version: 1,
        active: true,
        grantedAt: now,
      };
      state.workspaces.push(workspace);
      return { ...workspace };
    });
  }

  revoke(id: string): WorkspaceGrant {
    return this.mutate((state) => {
      const workspace = this.mutable(state, id);
      workspace.active = false;
      workspace.version += 1;
      workspace.revokedAt = new Date().toISOString();
      return { ...workspace };
    });
  }

  assert(id: string, version?: number): WorkspaceGrant {
    const workspace = this.mutable(this.readState(), id);
    if (!workspace.active) throw new Error('工作区授权已撤销。');
    if (version !== undefined && version !== workspace.version) throw new Error('工作区授权版本已变化。');
    const actual = canonicalRoot(workspace.path);
    if (!sameWorkspacePath(actual, workspace.path)) throw new Error('工作区实际路径已变化。');
    return { ...workspace };
  }

  read(id: string, relativePath: string, maxChars = 4_000, offset = 0): { text: string; truncated: boolean; hash: string; next: number | null } {
    const workspace = this.assert(id);
    return this.readAt(workspace.path, relativePath, maxChars, offset);
  }

  listFiles(id: string, relativePath = ''): string[] {
    const workspace = this.assert(id);
    if (!relativePath) return Object.keys(walk(workspace.path)).sort();
    const absolute = resolveSafe(workspace.path, relativePath);
    const info = statSync(absolute);
    if (info.isFile()) return [relativePath.replaceAll('\\', '/')];
    return Object.keys(walk(absolute)).map((item) => `${relativePath.replaceAll('\\', '/')}/${item}`).sort();
  }

  search(id: string, query: string): { path: string; line: number; text: string }[] {
    if (!query || query.length > 500) throw new Error('搜索词长度无效。');
    const workspace = this.assert(id);
    const results: { path: string; line: number; text: string }[] = [];
    for (const relative of Object.keys(walk(workspace.path))) {
      const absolute = resolveSafe(workspace.path, relative);
      if (statSync(absolute).size > 1024 * 1024) continue;
      const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index]!.includes(query)) results.push({ path: relative, line: index + 1, text: lines[index]!.slice(0, 500) });
        if (results.length >= 200) return results;
      }
    }
    return results;
  }

  write(id: string, relativePath: string, text: string, expectedHash: string | null): { hash: string; created: boolean } {
    const workspace = this.assert(id);
    const absolute = resolveSafe(workspace.path, relativePath, true);
    const created = !existsSync(absolute);
    if (created && expectedHash !== null) throw new Error('文件不存在，不能使用已有文件哈希。');
    if (!created) {
      const current = hash(readFileSync(absolute));
      if (!expectedHash || current !== expectedHash) throw new Error('文件已被其他操作修改，拒绝覆盖。');
    }
    mkdirSync(path.dirname(absolute), { recursive: true });
    const data = Buffer.from(text, 'utf8');
    const temp = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, data, { flag: 'wx' });
    const parent = path.dirname(absolute);
    const parentInfo = lstatSync(parent);
    if (isReparse(parentInfo) || !inside(realpathSync.native(parent), workspace.path)) {
      unlinkSync(temp);
      throw new Error('文件父目录在写入期间发生变化。');
    }
    if (!created && hash(readFileSync(absolute)) !== expectedHash) {
      unlinkSync(temp);
      throw new Error('文件在写入提交前发生变化，拒绝覆盖。');
    }
    renameSync(temp, absolute);
    return { hash: hash(data), created };
  }

  /** Trusted program write that may create missing parent directories after checking every new segment. */
  writeManagedFile(id: string, relativePath: string, text: string, expectedHash: string | null): { hash: string; created: boolean } {
    const workspace = this.assert(id);
    const safe = safeRelative(relativePath);
    const parts = safe.split(path.sep);
    let cursor = workspace.path;
    for (const segment of parts.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      if (!existsSync(cursor)) mkdirSync(cursor);
      const info = lstatSync(cursor);
      if (!info.isDirectory() || isReparse(info) || !inside(realpathSync.native(cursor), workspace.path)) {
        throw new Error('受管文件父目录不安全。');
      }
    }
    return this.write(id, relativePath, text, expectedHash);
  }

  freeze(id: string, taskId: string, options?: { excludePipelineMetadata?: boolean }): WorkspaceSnapshot {
    const workspace = this.assert(id);
    return this.copySnapshot(workspace, taskId, 'baseline', workspace.path, undefined, options?.excludePipelineMetadata === true);
  }

  createEditCopy(baseline: WorkspaceSnapshot): WorkspaceSnapshot {
    baseline = this.verifiedSnapshot(baseline);
    if (JSON.stringify(walk(baseline.path)) !== JSON.stringify(baseline.files)) throw new Error('基线快照内容已漂移。');
    this.assert(baseline.workspaceId);
    return this.copySnapshot(this.get(baseline.workspaceId), baseline.taskId, 'edit', baseline.path, baseline.id, baseline.excludesPipelineMetadata === true);
  }

  cloneReadOnlySnapshot(source: WorkspaceSnapshot, taskId: string): WorkspaceSnapshot {
    source = this.verifiedSnapshot(source);
    if (!['baseline', 'edit'].includes(source.kind)) throw new Error('只读验收快照必须从冻结源码候选克隆。');
    if (JSON.stringify(walk(source.path)) !== JSON.stringify(source.files)) throw new Error('父验收快照内容已漂移。');
    this.assert(source.workspaceId);
    return this.copySnapshot(this.get(source.workspaceId), taskId, 'baseline', source.path, source.id, source.excludesPipelineMetadata === true);
  }

  freezeCopy(copy: WorkspaceSnapshot): WorkspaceSnapshot {
    copy = this.verifiedSnapshot(copy);
    if (!['edit', 'test'].includes(copy.kind)) throw new Error('只能冻结编辑或测试副本。');
    return this.copySnapshot(this.get(copy.workspaceId), copy.taskId, copy.kind, copy.path, copy.sourceSnapshotId, copy.excludesPipelineMetadata === true);
  }

  /** Bind a finished command's writable copy to the main snapshot captured before dispatch. */
  freezeExecEdit(copy: WorkspaceSnapshot, baseline: WorkspaceSnapshot): WorkspaceSnapshot {
    copy = this.verifiedSnapshot(copy);
    baseline = this.verifiedSnapshot(baseline);
    if (copy.kind !== 'edit' || baseline.kind !== 'baseline' || copy.workspaceId !== baseline.workspaceId ||
      copy.taskId !== baseline.taskId) throw new Error('执行副本与主工作区基线不匹配');
    return this.copySnapshot(this.assert(copy.workspaceId), copy.taskId, 'edit', copy.path, baseline.id, baseline.excludesPipelineMetadata === true);
  }

  createTestCopy(edited: WorkspaceSnapshot): WorkspaceSnapshot {
    edited = this.verifiedSnapshot(edited);
    if (!['baseline', 'edit'].includes(edited.kind)) throw new Error('测试副本必须由已冻结源码快照派生。');
    if (JSON.stringify(walk(edited.path)) !== JSON.stringify(edited.files)) throw new Error('源码快照内容已漂移。');
    return this.copySnapshot(this.get(edited.workspaceId), edited.taskId, 'test', edited.path, edited.id, edited.excludesPipelineMetadata === true);
  }

  snapshotRead(snapshot: WorkspaceSnapshot, relativePath: string, maxChars = 4_000, offset = 0): { text: string; truncated: boolean; hash: string; next: number | null } {
    snapshot = this.verifiedSnapshot(snapshot);
    this.assert(snapshot.workspaceId);
    return this.readAt(snapshot.path, relativePath, maxChars, offset);
  }

  snapshotList(snapshot: WorkspaceSnapshot, relativePath = ''): string[] {
    snapshot = this.verifiedSnapshot(snapshot);
    this.assert(snapshot.workspaceId);
    return this.listAt(snapshot.path, relativePath);
  }

  snapshotSearch(snapshot: WorkspaceSnapshot, query: string): { path: string; line: number; text: string }[] {
    snapshot = this.verifiedSnapshot(snapshot);
    this.assert(snapshot.workspaceId);
    return this.searchAt(snapshot.path, query);
  }

  snapshotWrite(snapshot: WorkspaceSnapshot, relativePath: string, text: string, expectedHash: string | null): { hash: string; created: boolean } {
    snapshot = this.verifiedSnapshot(snapshot);
    this.assert(snapshot.workspaceId);
    if (snapshot.kind !== 'edit') throw new Error('只有独立编辑副本允许写入。');
    return this.writeAt(snapshot.path, relativePath, text, expectedHash);
  }

  snapshotChanges(baseline: WorkspaceSnapshot, working: WorkspaceSnapshot): WorkspaceChanges {
    baseline = this.verifiedSnapshot(baseline);
    working = this.verifiedSnapshot(working);
    if (baseline.workspaceId !== working.workspaceId) throw new Error('不能比较不同工作区的快照。');
    this.assert(baseline.workspaceId);
    return changes(baseline.files, walk(working.path));
  }

  snapshotDiff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiffReport {
    before = this.verifiedSnapshot(before);
    after = this.verifiedSnapshot(after);
    if (before.workspaceId !== after.workspaceId || before.taskId !== after.taskId) throw new Error('不能比较不同工作区或任务的快照。');
    this.assert(before.workspaceId);
    if (JSON.stringify(walk(before.path)) !== JSON.stringify(before.files)) throw new Error('差异基线快照内容已漂移。');
    if (JSON.stringify(walk(after.path)) !== JSON.stringify(after.files)) throw new Error('差异目标快照内容已漂移。');
    return buildWorkspaceDiff(before, after);
  }

  workspaceChanges(baseline: WorkspaceSnapshot): WorkspaceChanges {
    baseline = this.verifiedSnapshot(baseline);
    const workspace = this.assert(baseline.workspaceId);
    return changes(baseline.files, walk(workspace.path, undefined, baseline.excludesPipelineMetadata === true));
  }

  /** Load a persisted host snapshot without accepting a caller-supplied path. */
  loadSnapshot(id: string): WorkspaceSnapshot {
    if (!/^wsnap-[0-9a-f-]+$/i.test(id)) throw new Error('快照身份无效。');
    const stored = JSON.parse(readFileSync(snapshotFile(this.root, id), 'utf8')) as WorkspaceSnapshot;
    if (stored.id !== id) throw new Error('快照身份与受管记录不一致。');
    return this.verifiedSnapshot(stored);
  }

  /** Read only the current hash so trusted program writes can preflight all replacements. */
  fileHash(id: string, relativePath: string): string | null {
    const workspace = this.assert(id);
    let absolute: string;
    try { absolute = resolveSafe(workspace.path, relativePath); }
    catch (error) {
      if (error instanceof WorkspaceFileMissingError) return null;
      throw error;
    }
    const info = statSync(absolute);
    if (!info.isFile()) throw new Error('受管路径必须指向普通文件。');
    return hash(readFileSync(absolute));
  }

  integrateEdit(
    workspaceId: string,
    baseline: WorkspaceSnapshot,
    edited: WorkspaceSnapshot,
    allowedFiles: readonly string[],
  ): IntegrationResult {
    const workspace = this.assert(workspaceId);
    baseline = this.verifiedSnapshot(baseline);
    edited = this.verifiedSnapshot(edited);
    if (baseline.workspaceId !== workspaceId || baseline.kind !== 'baseline' || edited.kind !== 'edit') throw new Error('集成快照关系无效。');
    if (edited.sourceSnapshotId !== baseline.id) throw new Error('编辑副本不是从指定基线派生。');
    if (JSON.stringify(walk(baseline.path)) !== JSON.stringify(baseline.files)) throw new Error('基线快照内容已漂移。');
    if (JSON.stringify(walk(edited.path)) !== JSON.stringify(edited.files)) throw new Error('编辑快照内容已漂移。');
    const pending = this.pendingJournals(workspaceId);
    if (pending.length) throw new Error(`存在未收口的集成 journal：${pending.join(', ')}`);
    const applied = this.findAppliedIntegration(workspaceId, baseline.id, edited.id);
    if (applied) return applied;
    const allowed = new Set(allowedFiles.map((item) => safeRelative(item).replaceAll('\\', '/')));
    const changed = Object.keys(edited.files).filter((file) => baseline.files[file] !== edited.files[file]);
    const deleted = Object.keys(baseline.files).filter((file) => !(file in edited.files));
    if (deleted.length) throw new Error(`自动集成不允许删除文件：${deleted.join(', ')}`);
    if (changed.some((file) => !allowed.has(file))) throw new Error('编辑副本包含允许文件清单外的变化。');
    const created = changed.filter((file) => !(file in baseline.files));
    for (const file of changed) {
      const destination = resolveSafe(workspace.path, file, true);
      if (baseline.files[file]) {
        if (!existsSync(destination) || hash(readFileSync(destination)) !== baseline.files[file]) {
          throw new Error(`原工作区在集成前发生变化：${file}`);
        }
      } else if (existsSync(destination)) {
        throw new Error(`待创建文件已由其他操作创建：${file}`);
      }
    }
    const lock = path.join(this.root, 'locks', `${workspaceId}.lock`);
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    const journal: IntegrationJournal = {
      version: 1,
      id: `ij-${randomUUID()}`,
      workspaceId,
      baselineSnapshotId: baseline.id,
      editedSnapshotId: edited.id,
      state: 'pending',
      changed,
      created,
      entries: [],
      createdAt: new Date().toISOString(),
    };
    const journalPath = path.join(this.root, 'integration', workspaceId, `${journal.id}.json`);
    try {
      const backupRoot = path.join(this.root, 'integration', workspaceId, journal.id, 'backups');
      for (const file of changed) {
        const destination = resolveSafe(workspace.path, file, true);
        const source = resolveSafe(edited.path, file);
        const actualBefore = existsSync(destination) ? hash(readFileSync(destination)) : null;
        const expectedBefore = baseline.files[file] ?? null;
        if (actualBefore !== expectedBefore) throw new Error(`文件在集成准备期间发生变化：${file}`);
        const entry: IntegrationJournal['entries'][number] = {
          path: file,
          beforeHash: actualBefore,
          afterHash: hash(readFileSync(source)),
        };
        if (entry.beforeHash) {
          const backup = path.join(backupRoot, file.split('/').join(path.sep));
          mkdirSync(path.dirname(backup), { recursive: true }); copyFileSync(destination, backup, 0);
          entry.backup = backup;
        }
        journal.entries.push(entry);
      }
      atomicJson(journalPath, journal);
      for (const file of changed) {
        const destination = resolveSafe(workspace.path, file, true);
        const source = resolveSafe(edited.path, file);
        const entry = journal.entries.find((candidate) => candidate.path === file)!;
        const actualBefore = existsSync(destination) ? hash(readFileSync(destination)) : null;
        if (actualBefore !== entry.beforeHash) throw new Error(`文件在集成提交期间发生变化：${file}`);
        mkdirSync(path.dirname(destination), { recursive: true });
        const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        copyFileSync(source, temp, 0);
        renameSync(temp, destination);
      }
      journal.state = 'applied';
      journal.appliedAt = new Date().toISOString();
      atomicJson(journalPath, journal);
      return { journalId: journal.id, changed, created };
    } catch (error) {
      const uncertain: string[] = [];
      for (const entry of [...journal.entries].reverse()) {
        const destination = path.resolve(workspace.path, entry.path.split('/').join(path.sep));
        try {
          if (!existsSync(destination)) continue;
          if (hash(readFileSync(destination)) !== entry.afterHash) {
            // 尚未写入的原文件无需回滚；其他内容说明出现并发变化，不能覆盖。
            if (entry.beforeHash && hash(readFileSync(destination)) === entry.beforeHash) continue;
            uncertain.push(entry.path); continue;
          }
          if (entry.beforeHash && entry.backup) {
            const temp = `${destination}.${process.pid}.${randomUUID()}.rollback.tmp`;
            copyFileSync(entry.backup, temp, 0); renameSync(temp, destination);
          } else unlinkSync(destination);
        } catch { uncertain.push(entry.path); }
      }
      journal.state = uncertain.length ? 'rollback_uncertain' : 'rolled_back';
      journal.error = `${error instanceof Error ? error.message : String(error)}${uncertain.length ? `；无法确认回滚：${uncertain.join(', ')}` : ''}`;
      atomicJson(journalPath, journal);
      throw new Error(`集成失败${uncertain.length ? '且回滚状态未知' : '，已回滚'}：${journal.error}`);
    } finally {
      if (existsSync(lock)) unlinkSync(lock);
    }
  }

  private copySnapshot(
    workspace: WorkspaceGrant,
    taskId: string,
    kind: WorkspaceSnapshot['kind'],
    source: string,
    sourceSnapshotId?: string,
    excludePipelineMetadata = false,
  ): WorkspaceSnapshot {
    this.assert(workspace.id);
    const id = `wsnap-${randomUUID()}`;
    const destination = path.join(this.root, 'snapshots', id, 'files');
    mkdirSync(destination, { recursive: true });
    const files = walk(source, destination, excludePipelineMetadata);
    const snapshot: WorkspaceSnapshot = {
      id,
      workspaceId: workspace.id,
      taskId,
      kind,
      path: destination,
      createdAt: new Date().toISOString(),
      files,
      ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
      ...(excludePipelineMetadata ? { excludesPipelineMetadata: true as const } : {}),
    };
    atomicJson(snapshotFile(this.root, id), snapshot);
    return snapshot;
  }

  private verifiedSnapshot(input: WorkspaceSnapshot): WorkspaceSnapshot {
    if (!/^wsnap-[0-9a-f-]+$/i.test(input.id)) throw new Error('快照身份无效。');
    const metadata = snapshotFile(this.root, input.id);
    if (!existsSync(metadata)) throw new Error('快照不是由工作台创建。');
    const stored = JSON.parse(readFileSync(metadata, 'utf8')) as WorkspaceSnapshot;
    if (
      stored.id !== input.id || stored.workspaceId !== input.workspaceId || stored.taskId !== input.taskId ||
      stored.kind !== input.kind || stored.path !== input.path || stored.sourceSnapshotId !== input.sourceSnapshotId ||
      stored.excludesPipelineMetadata !== input.excludesPipelineMetadata ||
      JSON.stringify(stored.files) !== JSON.stringify(input.files)
    ) throw new Error('快照元数据与受管记录不一致。');
    const snapshotRoot = canonicalRoot(path.dirname(metadata));
    const actual = canonicalRoot(stored.path);
    if (!inside(actual, snapshotRoot)) throw new Error('快照文件路径越过受管快照目录。');
    return stored;
  }

  private pendingJournals(workspaceId: string): string[] {
    const directory = path.join(this.root, 'integration', workspaceId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .filter((file) => ['pending', 'rollback_uncertain'].includes((JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as IntegrationJournal).state));
  }

  /** Find a durable completed integration so callers can make retry side effects idempotent. */
  findAppliedIntegration(workspaceId: string, baselineSnapshotId: string, editedSnapshotId: string): IntegrationResult | undefined {
    const directory = path.join(this.root, 'integration', workspaceId);
    if (!existsSync(directory)) return undefined;
    const journal = readdirSync(directory).filter(file => file.endsWith('.json')).map(file =>
      JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as IntegrationJournal)
      .find(item => item.state === 'applied' && item.baselineSnapshotId === baselineSnapshotId && item.editedSnapshotId === editedSnapshotId);
    return journal && { journalId: journal.id, changed: [...journal.changed], created: [...journal.created] };
  }

  private mutable(state: StateFile, id: string): WorkspaceGrant {
    const workspace = state.workspaces.find((candidate) => candidate.id === id);
    if (!workspace) throw new Error('工作区授权不存在。');
    return workspace;
  }

  private readState(): StateFile {
    if (!existsSync(this.statePath)) return { version: 1, workspaces: [] };
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as StateFile;
    if (state.version !== 1 || !Array.isArray(state.workspaces)) throw new Error('工作区授权注册表格式无效。');
    return state;
  }

  private mutate<T>(action: (state: StateFile) => T): T {
    return withRegistryLock(this.lockPath, () => {
      const state = this.readState();
      const result = action(state);
      atomicJson(this.statePath, state);
      return result;
    });
  }

  private readAt(root: string, relativePath: string, maxChars: number, offset: number) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('文件读取偏移量无效。');
    const absolute = resolveSafe(root, relativePath);
    const info = statSync(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('只允许读取大小受限的普通文件。');
    const data = readFileSync(absolute); const text = data.toString('utf8');
    const end = Math.min(text.length, offset + maxChars);
    return { text: text.slice(offset, end), truncated: end < text.length, hash: hash(data), next: end < text.length ? end : null };
  }

  private listAt(root: string, relativePath: string): string[] {
    if (!relativePath) return Object.keys(walk(root)).sort();
    const absolute = resolveSafe(root, relativePath); const info = statSync(absolute);
    if (info.isFile()) return [relativePath.replaceAll('\\', '/')];
    return Object.keys(walk(absolute)).map((item) => `${relativePath.replaceAll('\\', '/')}/${item}`).sort();
  }

  private searchAt(root: string, query: string) {
    if (!query || query.length > 500) throw new Error('搜索词长度无效。');
    const results: { path: string; line: number; text: string }[] = [];
    for (const relative of Object.keys(walk(root))) {
      const absolute = resolveSafe(root, relative); if (statSync(absolute).size > 1024 * 1024) continue;
      const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index]!.includes(query)) results.push({ path: relative, line: index + 1, text: lines[index]!.slice(0, 500) });
        if (results.length >= 200) return results;
      }
    }
    return results;
  }

  private writeAt(root: string, relativePath: string, text: string, expectedHash: string | null) {
    const absolute = resolveSafe(root, relativePath, true); const created = !existsSync(absolute);
    if (created && expectedHash !== null) throw new Error('文件不存在，不能使用已有文件哈希。');
    if (!created && (!expectedHash || hash(readFileSync(absolute)) !== expectedHash)) throw new Error('文件已被其他操作修改，拒绝覆盖。');
    mkdirSync(path.dirname(absolute), { recursive: true }); const data = Buffer.from(text, 'utf8');
    const temp = `${absolute}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, data, { flag: 'wx' });
    const parent = path.dirname(absolute); const parentInfo = lstatSync(parent);
    if (isReparse(parentInfo) || !inside(realpathSync.native(parent), root)) { unlinkSync(temp); throw new Error('文件父目录在写入期间发生变化。'); }
    if (!created && hash(readFileSync(absolute)) !== expectedHash) { unlinkSync(temp); throw new Error('文件在写入提交前发生变化，拒绝覆盖。'); }
    renameSync(temp, absolute); return { hash: hash(data), created };
  }
}

function changes(baseline: Record<string, string>, current: Record<string, string>): WorkspaceChanges {
  return {
    modified: Object.keys(current).filter((file) => file in baseline && baseline[file] !== current[file]).sort(),
    created: Object.keys(current).filter((file) => !(file in baseline)).sort(),
    deleted: Object.keys(baseline).filter((file) => !(file in current)).sort(),
  };
}
