import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveCommand, runProcess, scrubEnv, type ResolvedCommand, type RunProcessResult } from '../adapters/process.js';

const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CURSOR_API_KEY',
  'XAI_API_KEY',
];

// runProcess 的内存尾部默认会截断；Git 树/状态一旦截断会造成错误的“未变化”结论。
// 本模块提高上限并在触顶时明确失败，不允许用不完整输出继续核验。
const MAX_GIT_OUTPUT_CHARS = 16 * 1024 * 1024;
const MAX_IGNORED_FILES = 20_000;
const MAX_IGNORED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_IGNORED_TOTAL_BYTES = 128 * 1024 * 1024;

const createdReviews = new WeakMap<ReviewWorkspace, { dev: number; ino: number }>();

export interface WorkspaceAnchor {
  commit: string;
  treeHash: string;
  baselineCommit: string | null;
  fileTree: string[];
  diffStat: string;
}

export interface ReviewWorkspace {
  sourceDir: string;
  workspaceDir: string;
  allowedRoot: string;
  anchor: WorkspaceAnchor;
  initialHead: string;
  initialTreeHash: string;
  initialReflog: string;
  /** 路径到 blob/mode 的程序快照；不依赖模型报告。 */
  sourceSnapshot: Readonly<Record<string, string>>;
  /** 非 tracked、被 Git ignore 的文件内容指纹；固定缓存目录仅记录存在性。 */
  initialIgnoredSnapshot: Readonly<Record<string, string>>;
}

export interface ReviewWorkspaceVerification {
  ok: boolean;
  errors: string[];
}

function gitCommand(): ResolvedCommand {
  const command = resolveCommand('git');
  if (!command) throw new Error('无法创建 Git 状态锚点：未找到 git 可执行文件。');
  return command;
}

function gitEnv(): NodeJS.ProcessEnv {
  return scrubEnv({ ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }, AUTH_ENV_KEYS).env;
}

function commandFailure(operation: string, result: RunProcessResult): Error {
  const detail = result.cancelled
    ? '操作已取消'
    : result.timedOut
      ? '操作超时'
      : result.spawnError
        ? `无法启动进程：${result.spawnError}`
        : `退出码 ${result.exitCode}${result.stderrTail.trim() ? `：${result.stderrTail.trim()}` : ''}`;
  return new Error(`${operation}失败（${detail}）。`);
}

async function git(
  command: ResolvedCommand,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
): Promise<RunProcessResult> {
  const result = await runProcess(command, args, {
    cwd,
    env: gitEnv(),
    stdinText: null,
    timeoutMs: 60_000,
    signal,
    tailBytes: MAX_GIT_OUTPUT_CHARS,
  });
  if (result.exitCode === null || !acceptedExitCodes.includes(result.exitCode)) {
    throw commandFailure(`Git ${args[0] ?? '命令'}`, result);
  }
  if (result.stdoutTail.length >= MAX_GIT_OUTPUT_CHARS) {
    throw new Error(`Git ${args[0] ?? '命令'}输出达到 ${MAX_GIT_OUTPUT_CHARS} 字符上限，拒绝使用可能不完整的结果。`);
  }
  return result;
}

function output(result: RunProcessResult): string {
  return result.stdoutTail.replace(/[\r\n]+$/, '');
}

function gitSync(command: ResolvedCommand, cwd: string, args: string[]): string {
  if (command.via === 'cmd-fallback') throw new Error('Git 仅能通过命令脚本启动，不能进行无 shell 的同步锚点核验。');
  const result = spawnSync(command.file, [...command.prefixArgs, ...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: MAX_GIT_OUTPUT_CHARS,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason = code === 'ETIMEDOUT'
      ? '操作超时'
      : code === 'ENOBUFS'
        ? `输出超过 ${MAX_GIT_OUTPUT_CHARS} 字符上限`
        : result.error.message;
    throw new Error(`Git ${args[0] ?? '命令'}失败（${reason}）。`);
  }
  if (result.signal) throw new Error(`Git ${args[0] ?? '命令'}失败（进程被 ${result.signal} 终止）。`);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`Git ${args[0] ?? '命令'}失败（退出码 ${result.status}${detail ? `：${detail}` : ''}）。`);
  }
  const stdout = result.stdout;
  if (stdout.length >= MAX_GIT_OUTPUT_CHARS) {
    throw new Error(`Git ${args[0] ?? '命令'}输出达到 ${MAX_GIT_OUTPUT_CHARS} 字符上限，拒绝使用可能不完整的结果。`);
  }
  return stdout.replace(/[\r\n]+$/, '');
}

function validateObjectId(value: string, label: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new Error(`${label} 不是有效的 Git 对象 ID。`);
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalDirectory(directory: string, label: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error(`${label}必须是绝对路径。`);
  let info;
  try {
    info = await stat(directory);
  } catch (error) {
    throw new Error(`${label}不可访问：${(error as Error).message}`);
  }
  if (!info.isDirectory()) throw new Error(`${label}不是目录。`);
  return realpath(directory);
}

async function ensureSafeDestination(destinationDir: string, allowedRoot: string): Promise<{ destination: string; root: string }> {
  if (!path.isAbsolute(destinationDir)) throw new Error('评审副本路径必须是绝对路径。');
  const root = await canonicalDirectory(allowedRoot, '评审副本根目录');
  const destination = path.resolve(destinationDir);
  if (!isInside(destination, root)) throw new Error('评审副本路径越过允许的根目录。');
  try {
    await lstat(destination);
    throw new Error('评审副本路径已存在，拒绝覆盖。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(destination);
  const realParent = await canonicalDirectory(parent, '评审副本父目录');
  if (!isInside(realParent, root) && realParent !== root) throw new Error('评审副本父目录经解析后越过允许的根目录。');
  return { destination, root };
}

async function removePartialClone(destination: string, root: string): Promise<void> {
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink()) {
      await rm(destination, { force: true });
      return;
    }
    const actual = await realpath(destination);
    if (isInside(actual, root)) await rm(actual, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function parseTree(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('Git 文件树输出格式无效。');
    const metadata = record.slice(0, tab).split(' ');
    const filePath = record.slice(tab + 1);
    const mode = metadata[0];
    const objectId = metadata[2];
    if (!mode || !objectId || !filePath) throw new Error('Git 文件树条目不完整。');
    entries[filePath] = `${mode}:${objectId}`;
  }
  return entries;
}

function isApprovedCachePath(filePath: string): boolean {
  const parts = filePath.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts[0] === '.cache' || parts[0] === '.pytest_cache') return parts.length > 1;
  if (parts.includes('__pycache__')) return true;
  return parts.some((part, index) => part === 'node_modules' && parts[index + 1] === '.cache' && parts.length > index + 2);
}

async function ignoredSnapshot(
  command: ResolvedCommand,
  cwd: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const listed = await git(command, cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], signal);
  const paths = listed.stdoutTail.split('\0').filter(Boolean);
  if (paths.length > MAX_IGNORED_FILES) {
    throw new Error(`ignored 文件数量 ${paths.length} 超过核验上限 ${MAX_IGNORED_FILES}。`);
  }
  const snapshot: Record<string, string> = {};
  let totalBytes = 0;
  for (const relative of paths) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || relative.split('\\').includes('..')) {
      throw new Error(`ignored 文件路径不安全：${relative}`);
    }
    const absolute = path.resolve(cwd, relative.split('/').join(path.sep));
    if (!isInside(absolute, cwd)) throw new Error(`ignored 文件越过评审副本：${relative}`);
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) throw new Error(`ignored 文件不能是符号链接或 junction：${relative}`);
    if (!before.isFile()) throw new Error(`ignored 路径不是普通文件：${relative}`);
    const actual = await realpath(absolute);
    if (!isInside(actual, cwd)) throw new Error(`ignored 文件实际路径越过评审副本：${relative}`);
    if (isApprovedCachePath(relative)) {
      snapshot[relative] = '<approved-cache-file>';
      continue;
    }
    if (before.size > MAX_IGNORED_FILE_BYTES) {
      throw new Error(`ignored 文件超过单文件核验上限：${relative}`);
    }
    totalBytes += before.size;
    if (totalBytes > MAX_IGNORED_TOTAL_BYTES) throw new Error(`ignored 文件总量超过 ${MAX_IGNORED_TOTAL_BYTES} 字节核验上限。`);
    const content = await readFile(actual);
    const after = await lstat(actual);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`ignored 文件在核验期间发生变化：${relative}`);
    }
    snapshot[relative] = `${content.length}:${createHash('sha256').update(content).digest('hex')}`;
  }
  return snapshot;
}

function ignoredChanges(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  const changes: string[] = [];
  for (const filePath of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isApprovedCachePath(filePath)) continue;
    if (!(filePath in before)) changes.push(`新增 ${filePath}`);
    else if (!(filePath in after)) changes.push(`删除 ${filePath}`);
    else if (before[filePath] !== after[filePath]) changes.push(`修改 ${filePath}`);
  }
  return changes.sort();
}

async function treeSnapshot(command: ResolvedCommand, cwd: string, revision: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const result = await git(command, cwd, ['ls-tree', '-r', '-z', '--full-tree', revision], signal);
  return parseTree(result.stdoutTail);
}

async function currentHead(command: ResolvedCommand, cwd: string, signal?: AbortSignal): Promise<string> {
  return output(await git(command, cwd, ['rev-parse', '--verify', 'HEAD'], signal));
}

async function currentTree(command: ResolvedCommand, cwd: string, signal?: AbortSignal): Promise<string> {
  return output(await git(command, cwd, ['rev-parse', 'HEAD^{tree}'], signal));
}

async function reflogSnapshot(command: ResolvedCommand, cwd: string, signal?: AbortSignal): Promise<string> {
  return output(await git(command, cwd, ['reflog', 'show', '--format=%H%x00%gs'], signal));
}

/**
 * 固定主工作区状态。此函数只 add/commit，不 reset、clean 或回滚用户文件。
 */
export async function captureWorkspace(workspaceDir: string, signal?: AbortSignal): Promise<WorkspaceAnchor> {
  const directory = await canonicalDirectory(workspaceDir, '构建工作区');
  const command = gitCommand();
  await git(command, directory, ['rev-parse', '--is-inside-work-tree'], signal);

  const previous = await git(command, directory, ['rev-parse', '--verify', 'HEAD'], signal, [0, 128]);
  const baselineCommit = previous.exitCode === 0 ? output(previous) : null;
  if (baselineCommit) validateObjectId(baselineCommit, '基线提交');

  await git(command, directory, ['add', '-A'], signal);
  const staged = await git(command, directory, ['diff', '--cached', '--quiet'], signal, [0, 1]);
  if (staged.exitCode === 1 || baselineCommit === null) {
    await git(
      command,
      directory,
      ['-c', 'user.name=Dual Model Workbench', '-c', 'user.email=workbench@localhost', 'commit', '--no-verify', '-q', '-m', 'Freeze workspace for review'],
      signal,
    );
  }

  const commit = await currentHead(command, directory, signal);
  const treeHash = await currentTree(command, directory, signal);
  validateObjectId(commit, '工作区提交');
  validateObjectId(treeHash, '工作区树');
  const snapshot = await treeSnapshot(command, directory, commit, signal);
  const diffArgs = baselineCommit
    ? ['diff', '--stat', '--no-renames', baselineCommit, commit]
    : ['show', '--stat', '--format=', '--no-renames', commit];
  const diffStat = output(await git(command, directory, diffArgs, signal));
  const status = output(await git(command, directory, ['status', '--porcelain=v1', '--untracked-files=all'], signal));
  if (status) throw new Error(`固定 Git 状态后工作区仍有未提交变化：\n${status}`);

  return { commit, treeHash, baselineCommit, fileTree: Object.keys(snapshot).sort(), diffStat };
}

/**
 * 只读核对主工作区仍与程序锚点一致。不会 add、commit、reset、clean 或修改文件。
 * ignored 缓存由 Git status 排除；tracked 变化和未忽略的新源码/依赖文件都会令锚点失效。
 */
export async function verifyWorkspaceAnchor(
  workspaceDir: string,
  anchor: WorkspaceAnchor,
  signal?: AbortSignal,
): Promise<ReviewWorkspaceVerification> {
  const errors: string[] = [];
  let directory: string;
  let command: ResolvedCommand;
  try {
    validateObjectId(anchor.commit, '工作区提交');
    validateObjectId(anchor.treeHash, '工作区树');
    directory = await canonicalDirectory(workspaceDir, '构建工作区');
    command = gitCommand();
  } catch (error) {
    return { ok: false, errors: [(error as Error).message] };
  }

  const check = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      errors.push(`${label}：${(error as Error).message}`);
    }
  };
  await check('无法核对主工作区 HEAD', async () => {
    const head = await currentHead(command, directory, signal);
    if (head !== anchor.commit) errors.push(`主工作区 HEAD 已漂移：预期 ${anchor.commit}，实际 ${head}。`);
  });
  await check('无法核对主工作区提交树', async () => {
    const tree = await currentTree(command, directory, signal);
    if (tree !== anchor.treeHash) errors.push(`主工作区提交树已漂移：预期 ${anchor.treeHash}，实际 ${tree}。`);
  });
  await check('无法核对主工作区文件树', async () => {
    const snapshot = await treeSnapshot(command, directory, 'HEAD', signal);
    if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify([...anchor.fileTree].sort())) {
      errors.push('主工作区 HEAD 的文件树清单与程序锚点不一致。');
    }
  });
  await check('无法核对主工作区状态', async () => {
    const status = output(await git(command, directory, ['status', '--porcelain=v1', '--untracked-files=all'], signal));
    if (status) errors.push(`主工作区含未锚定的源码、测试、依赖或未忽略新文件：\n${status}`);
  });
  return { ok: errors.length === 0, errors };
}

/**
 * G4 接受动作的同步、即时锚点检查。只执行固定只读 Git argv，并在超时、输出过大或路径异常时关闭通过路径。
 */
export function verifyWorkspaceAnchorSync(workspaceDir: string, anchor: WorkspaceAnchor): ReviewWorkspaceVerification {
  const errors: string[] = [];
  let directory: string;
  let command: ResolvedCommand;
  try {
    validateObjectId(anchor.commit, '工作区提交');
    validateObjectId(anchor.treeHash, '工作区树');
    if (!path.isAbsolute(workspaceDir)) throw new Error('构建工作区必须是绝对路径。');
    const info = statSync(workspaceDir);
    if (!info.isDirectory()) throw new Error('构建工作区不是目录。');
    if (lstatSync(workspaceDir).isSymbolicLink()) throw new Error('构建工作区路径不能是符号链接或 junction。');
    directory = realpathSync(workspaceDir);
    if (path.resolve(workspaceDir) !== directory) throw new Error('构建工作区的真实路径与记录路径不一致。');
    command = gitCommand();
  } catch (error) {
    return { ok: false, errors: [`无法读取构建工作区真实路径：${(error as Error).message}`] };
  }

  const check = (label: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      errors.push(`${label}：${(error as Error).message}`);
    }
  };
  check('无法核对主工作区 HEAD', () => {
    const head = gitSync(command, directory, ['rev-parse', '--verify', 'HEAD']);
    if (head !== anchor.commit) errors.push(`主工作区 HEAD 已漂移：预期 ${anchor.commit}，实际 ${head}。`);
  });
  check('无法核对主工作区提交树', () => {
    const tree = gitSync(command, directory, ['rev-parse', 'HEAD^{tree}']);
    if (tree !== anchor.treeHash) errors.push(`主工作区提交树已漂移：预期 ${anchor.treeHash}，实际 ${tree}。`);
  });
  check('无法核对主工作区文件树', () => {
    const snapshot = parseTree(gitSync(command, directory, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']));
    if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify([...anchor.fileTree].sort())) {
      errors.push('主工作区 HEAD 的文件树清单与程序锚点不一致。');
    }
  });
  check('无法核对主工作区状态', () => {
    const status = gitSync(command, directory, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status) errors.push(`主工作区含未锚定的源码、测试、依赖或未忽略新文件：\n${status}`);
  });
  return { ok: errors.length === 0, errors };
}

/** 创建带独立 Git 元数据、固定在锚点提交上的 detached 评审副本。 */
export async function createReviewWorkspace(
  sourceDir: string,
  destinationDir: string,
  anchor: WorkspaceAnchor,
  allowedRoot: string,
  signal?: AbortSignal,
): Promise<ReviewWorkspace> {
  validateObjectId(anchor.commit, '工作区提交');
  validateObjectId(anchor.treeHash, '工作区树');
  const source = await canonicalDirectory(sourceDir, '源工作区');
  const { destination, root } = await ensureSafeDestination(destinationDir, allowedRoot);
  if (source === root || isInside(source, root)) throw new Error('评审副本根目录不能包含源工作区。');
  const command = gitCommand();
  await git(command, source, ['cat-file', '-e', `${anchor.commit}^{commit}`], signal);
  const sourceTree = output(await git(command, source, ['rev-parse', `${anchor.commit}^{tree}`], signal));
  if (sourceTree !== anchor.treeHash) throw new Error('工作区锚点的提交与树哈希不匹配。');
  const anchoredSnapshot = await treeSnapshot(command, source, anchor.commit, signal);
  if (JSON.stringify(Object.keys(anchoredSnapshot).sort()) !== JSON.stringify([...anchor.fileTree].sort())) {
    throw new Error('工作区锚点的文件树清单与提交不匹配。');
  }

  try {
    // --local 避免本地路径被 transport/upload-pack 处理；--no-hardlinks 保证对象库物理隔离。
    await git(command, root, ['clone', '--local', '--no-hardlinks', '--no-checkout', '--', source, destination], signal);
    const realDestination = await realpath(destination);
    if (!isInside(realDestination, root)) throw new Error('评审副本经解析后越过允许的根目录。');
    await git(command, realDestination, ['checkout', '--detach', '-q', anchor.commit], signal);

    const gitMarker = path.join(realDestination, '.git');
    const gitInfo = await lstat(gitMarker);
    if (!gitInfo.isDirectory()) {
      throw new Error('评审副本没有独立 Git 目录。');
    }
    const commonDirRaw = output(await git(command, realDestination, ['rev-parse', '--git-common-dir'], signal));
    const commonDir = await realpath(path.resolve(realDestination, commonDirRaw));
    const sourceGit = await realpath(path.join(source, '.git'));
    if (!isInside(commonDir, realDestination) || commonDir === sourceGit || isInside(commonDir, sourceGit)) {
      throw new Error('评审副本共享了源工作区的 Git 元数据。');
    }

    const initialHead = await currentHead(command, realDestination, signal);
    const initialTreeHash = await currentTree(command, realDestination, signal);
    if (initialHead !== anchor.commit || initialTreeHash !== anchor.treeHash) throw new Error('评审副本未固定到请求的工作区锚点。');
    const sourceSnapshot = await treeSnapshot(command, realDestination, initialHead, signal);
    const initialIgnoredSnapshot = await ignoredSnapshot(command, realDestination, signal);
    const initialReflog = await reflogSnapshot(command, realDestination, signal);
    const review: ReviewWorkspace = {
      sourceDir: source,
      workspaceDir: realDestination,
      allowedRoot: root,
      anchor: { ...anchor, fileTree: [...anchor.fileTree] },
      initialHead,
      initialTreeHash,
      initialReflog,
      sourceSnapshot,
      initialIgnoredSnapshot,
    };
    const workspaceInfo = await lstat(realDestination);
    createdReviews.set(review, { dev: workspaceInfo.dev, ino: workspaceInfo.ino });
    return review;
  } catch (error) {
    // clone 失败留下的半成品只在已经验证过的根目录内删除。
    await removePartialClone(destination, root).catch(() => undefined);
    throw error;
  }
}

/**
 * 核对副本未被评审任务篡改。ignored 缓存不会出现在 status；任何未忽略的新文件都令评审失效。
 */
export async function verifyReviewWorkspace(review: ReviewWorkspace, signal?: AbortSignal): Promise<ReviewWorkspaceVerification> {
  const errors: string[] = [];
  const command = gitCommand();
  let directory: string;
  try {
    directory = await realpath(review.workspaceDir);
  } catch (error) {
    return { ok: false, errors: [`评审副本不可访问：${(error as Error).message}`] };
  }
  if (directory !== review.workspaceDir || !isInside(directory, review.allowedRoot)) {
    return { ok: false, errors: ['评审副本路径或实际位置已变化。'] };
  }

  const check = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      errors.push(`${label}：${(error as Error).message}`);
    }
  };
  await check('无法核对 HEAD', async () => {
    const head = await currentHead(command, directory, signal);
    if (head !== review.initialHead) errors.push(`HEAD 已变化：预期 ${review.initialHead}，实际 ${head}。`);
  });
  await check('无法核对代码树', async () => {
    const tree = await currentTree(command, directory, signal);
    if (tree !== review.initialTreeHash) errors.push(`提交树已变化：预期 ${review.initialTreeHash}，实际 ${tree}。`);
  });
  await check('无法核对源码快照', async () => {
    const snapshot = await treeSnapshot(command, directory, 'HEAD', signal);
    if (JSON.stringify(snapshot) !== JSON.stringify(review.sourceSnapshot)) errors.push('HEAD 中的源码/测试文件快照已变化。');
  });
  await check('无法核对工作区文件', async () => {
    const status = output(await git(command, directory, ['status', '--porcelain=v1', '--untracked-files=all'], signal));
    if (status) errors.push(`评审副本含源码、测试或未忽略的新文件变化：\n${status}`);
  });
  await check('无法核对 ignored 文件', async () => {
    const current = await ignoredSnapshot(command, directory, signal);
    const changes = ignoredChanges(review.initialIgnoredSnapshot, current);
    if (changes.length) {
      const shown = changes.slice(0, 20);
      errors.push(`评审副本含非缓存 ignored 文件变化：\n${shown.join('\n')}${changes.length > shown.length ? `\n另有 ${changes.length - shown.length} 项` : ''}`);
    }
  });
  await check('无法核对提交历史', async () => {
    const reflog = await reflogSnapshot(command, directory, signal);
    if (reflog !== review.initialReflog) errors.push('评审副本 reflog 已变化，检测到自行提交、切换或恢复历史。');
  });
  return { ok: errors.length === 0, errors };
}

/** 只清理由本进程、本模块创建且仍位于允许根目录内的评审副本。 */
export async function cleanupReviewWorkspace(review: ReviewWorkspace): Promise<void> {
  const identity = createdReviews.get(review);
  if (!identity) throw new Error('拒绝清理：该评审副本不是由本模块创建的。');
  const root = await canonicalDirectory(review.allowedRoot, '评审副本根目录');
  let destination: string;
  try {
    destination = await realpath(review.workspaceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      createdReviews.delete(review);
      return;
    }
    throw error;
  }
  if (destination === review.sourceDir || !isInside(destination, root)) throw new Error('拒绝清理：评审副本路径越过允许根目录或指向源工作区。');
  const current = await lstat(destination);
  if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error('拒绝清理：评审副本目录已被替换。');
  }
  await rm(destination, { recursive: true, force: false });
  createdReviews.delete(review);
}
