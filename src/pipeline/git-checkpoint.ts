import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface GitCheckpointRequest {
  workspaceRoot: string;
  /** Complete verified tree. Values are SHA-256 hashes of current file bytes. */
  files: Readonly<Record<string, string>>;
  /** Only these exact paths or descendants may differ from the parent tree. */
  reviewedPaths: readonly string[];
  message: string;
  ref?: string;
}

export interface GitCheckpointResult {
  commit: string;
  tree: string;
  ref: string;
  created: boolean;
  parent?: string;
}

interface GitContext {
  root: string;
  gitDir: string;
  ref: string;
  createdRepository: boolean;
  env: NodeJS.ProcessEnv;
}

interface TreeNode {
  files: Map<string, { oid: string; mode: '100644' | '100755' }>;
  directories: Map<string, TreeNode>;
}

interface VerifiedFile {
  file: string;
  data: Buffer;
  oid: string;
  mode: '100644' | '100755';
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function relativePath(input: string): string {
  const value = input.replaceAll('\\', '/');
  if (!value || path.isAbsolute(value) || /[\0\r\n]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Git checkpoint 路径无效：${input}`);
  }
  if (value.split('/')[0]!.toLowerCase() === '.git') throw new Error('Git checkpoint 不能把 .git 纳入产品树');
  return value;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertDirectoryChain(root: string, target: string): void {
  if (!isInside(target, root)) throw new Error('Git checkpoint 受管目录越出授权根目录');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!existsSync(current)) mkdirSync(current);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !isInside(realpathSync.native(current), root)) {
      throw new Error(`Git checkpoint 受管目录不安全：${current}`);
    }
  }
}

function assertObjectStore(gitDir: string): void {
  const objects = path.join(gitDir, 'objects');
  for (const entry of readdirSync(objects, { withFileTypes: true })) {
    const absolute = path.join(objects, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isInside(realpathSync.native(absolute), gitDir)) {
      throw new Error(`Git checkpoint 对象目录不安全：${absolute}`);
    }
  }
}

function baseEnvironment(gitDir: string, root: string, hooks: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    HOME: path.join(gitDir, 'dmw', 'no-home'),
    GIT_DIR: gitDir,
    GIT_WORK_TREE: root,
    GIT_INDEX_FILE: path.join(gitDir, 'dmw', 'isolated-index'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: 'core.logAllRefUpdates',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: root,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_AUTHOR_NAME: 'Dual Model Workbench',
    GIT_AUTHOR_EMAIL: 'checkpoint@localhost.invalid',
    GIT_COMMITTER_NAME: 'Dual Model Workbench',
    GIT_COMMITTER_EMAIL: 'checkpoint@localhost.invalid',
  };
}

function runGit(context: GitContext, args: readonly string[], input?: string | Buffer, allowMissing = false): string | undefined {
  const result = spawnSync('git', [...args], {
    cwd: context.root,
    env: context.env,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Git checkpoint 无法启动 git：${result.error.message}`);
  if (result.status !== 0) {
    if (allowMissing && result.status === 1) return undefined;
    const detail = `${result.stderr || result.stdout || `exit ${result.status}`}`.trim();
    throw new Error(`Git checkpoint 命令失败（git ${args[0]}）：${detail}`);
  }
  return `${result.stdout}`.trim();
}

function prepareContext(request: GitCheckpointRequest): GitContext {
  if (!path.isAbsolute(request.workspaceRoot)) throw new Error('Git checkpoint 工作区必须是绝对路径');
  const root = realpathSync.native(request.workspaceRoot);
  if (!statSync(root).isDirectory()) throw new Error('Git checkpoint 工作区不是目录');
  const gitDir = path.join(root, '.git');
  const createdRepository = !existsSync(gitDir);
  if (!createdRepository) {
    const info = lstatSync(gitDir);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(gitDir) !== gitDir) {
      throw new Error('只支持授权根目录内的普通 .git 目录；拒绝父仓库、worktree 指针或链接');
    }
  } else {
    mkdirSync(gitDir);
    mkdirSync(path.join(gitDir, 'objects'));
    mkdirSync(path.join(gitDir, 'refs'));
    writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tlogallrefupdates = true\n');
  }
  for (const directory of ['objects', 'refs', path.join('dmw', 'no-hooks'), path.join('dmw', 'no-home')]) {
    assertDirectoryChain(gitDir, path.join(gitDir, directory));
  }
  assertObjectStore(gitDir);
  const requestedRef = request.ref ?? 'refs/dmw/checkpoints/main';
  const refPrefix = 'refs/dmw/checkpoints/';
  const refParts = requestedRef.slice(refPrefix.length).split('/');
  if (!requestedRef.startsWith(refPrefix) || !/^[A-Za-z0-9._/-]+$/.test(requestedRef) || refParts.some(part =>
    !part || part === '.' || part === '..' || part.startsWith('.') || part.endsWith('.') || part.toLowerCase().endsWith('.lock'))) {
    throw new Error('Git checkpoint ref 必须位于程序专用命名空间');
  }
  const refNamespace = path.join(gitDir, 'refs', 'dmw', 'checkpoints');
  assertDirectoryChain(gitDir, refNamespace);
  assertDirectoryChain(refNamespace, path.dirname(path.join(refNamespace, ...refParts)));
  if (createdRepository) writeFileSync(path.join(gitDir, 'HEAD'), `ref: ${requestedRef}\n`, { flag: 'wx' });
  const context: GitContext = {
    root,
    gitDir,
    ref: requestedRef,
    createdRepository,
    env: baseEnvironment(gitDir, root, path.join(gitDir, 'dmw', 'no-hooks')),
  };
  const absoluteGitDir = runGit(context, ['rev-parse', '--absolute-git-dir']);
  if (!absoluteGitDir || realpathSync.native(absoluteGitDir) !== gitDir) throw new Error('Git checkpoint 拒绝使用授权根目录外的 Git 元数据');
  return context;
}

function addTreeFile(root: TreeNode, relative: string, oid: string, mode: '100644' | '100755'): void {
  const parts = relative.split('/');
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (node.files.has(part)) throw new Error(`Git checkpoint 文件与目录冲突：${relative}`);
    let child = node.directories.get(part);
    if (!child) {
      child = { files: new Map(), directories: new Map() };
      node.directories.set(part, child);
    }
    node = child;
  }
  const name = parts.at(-1)!;
  if (node.directories.has(name) || node.files.has(name)) throw new Error(`Git checkpoint 路径重复或冲突：${relative}`);
  node.files.set(name, { oid, mode });
}

function byteSort(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function writeTree(context: GitContext, node: TreeNode): string {
  const entries: string[] = [];
  for (const [name, file] of [...node.files].sort(([left], [right]) => byteSort(left, right))) {
    entries.push(`${file.mode} blob ${file.oid}\t${name}\0`);
  }
  for (const [name, child] of [...node.directories].sort(([left], [right]) => byteSort(`${left}/`, `${right}/`))) {
    entries.push(`040000 tree ${writeTree(context, child)}\t${name}\0`);
  }
  return runGit(context, ['mktree', '-z'], entries.join(''))!;
}

function verifyManifest(context: GitContext, files: Readonly<Record<string, string>>): VerifiedFile[] {
  const entries = Object.entries(files).map(([input, expected]) => ({ input, file: relativePath(input), expected }));
  if (new Set(entries.map(entry => entry.file)).size !== entries.length) throw new Error('Git checkpoint 清单含规范化后的重复路径');
  const verified: VerifiedFile[] = [];
  for (const { file, expected } of entries.sort((left, right) => byteSort(left.file, right.file))) {
    if (!/^[0-9a-f]{64}$/i.test(expected)) throw new Error(`Git checkpoint 缺少有效 SHA-256：${file}`);
    const absolute = path.resolve(context.root, ...file.split('/'));
    if (!isInside(absolute, context.root)) throw new Error(`Git checkpoint 文件越出授权根目录：${file}`);
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink() || !isInside(realpathSync.native(absolute), context.root)) throw new Error(`Git checkpoint 只接受根目录内普通文件：${file}`);
    const data = readFileSync(absolute);
    if (sha256(data) !== expected.toLowerCase()) throw new Error(`Git checkpoint 文件与已验证哈希不一致：${file}`);
    verified.push({ file, data, oid: runGit(context, ['hash-object', '--stdin'], data)!, mode: info.mode & 0o111 ? '100755' : '100644' });
  }
  return verified;
}

function parentFiles(context: GitContext, tree: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!tree) return result;
  const output = runGit(context, ['ls-tree', '-r', '-z', tree]) ?? '';
  for (const entry of output.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\S+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Git checkpoint 无法解析父树');
    const [, mode, kind, oid, file] = match;
    result.set(file!, `${mode}:${kind}:${oid}`);
  }
  return result;
}

function changedPaths(parent: Map<string, string>, files: readonly VerifiedFile[]): string[] {
  const desired = new Map(files.map(file => [file.file, `${file.mode}:blob:${file.oid}`]));
  return [...new Set([...parent.keys(), ...desired.keys()])].filter(file => parent.get(file) !== desired.get(file)).sort(byteSort);
}

function storeTree(context: GitContext, files: readonly VerifiedFile[]): string {
  const root: TreeNode = { files: new Map(), directories: new Map() };
  for (const file of files) {
    const written = runGit(context, ['hash-object', '-w', '--stdin'], file.data)!;
    if (written !== file.oid) throw new Error(`Git checkpoint blob 身份在写入期间变化：${file.file}`);
    addTreeFile(root, file.file, file.oid, file.mode);
  }
  return writeTree(context, root);
}

function allowed(candidate: string, reviewedPaths: readonly string[]): boolean {
  return reviewedPaths.some(item => candidate === item || candidate.startsWith(`${item}/`));
}

function checkpointMessage(context: GitContext, commit: string): string {
  const object = runGit(context, ['cat-file', 'commit', commit])!;
  const separator = object.indexOf('\n\n');
  if (separator < 0) throw new Error('Git checkpoint 无法读取父提交说明');
  return object.slice(separator + 2).trimEnd();
}

/**
 * Stores an exact verified product tree without invoking checkout, add, commit,
 * filters, hooks, or the user's index. Existing repositories receive a
 * dedicated checkpoint ref; their HEAD and staging area remain untouched.
 */
export function createGitCheckpoint(request: GitCheckpointRequest): GitCheckpointResult {
  if (!request.message.trim() || request.message !== request.message.trim() || request.message.length > 4_000 || request.message.includes('\0')) {
    throw new Error('Git checkpoint 提交说明无效');
  }
  const reviewedPaths = [...new Set(request.reviewedPaths.map(relativePath))];
  const context = prepareContext(request);
  const refCommit = runGit(context, ['rev-parse', '--verify', '--quiet', `${context.ref}^{commit}`], undefined, true);
  const headCommit = refCommit ?? (!context.createdRepository ? runGit(context, ['rev-parse', '--verify', 'HEAD^{commit}'], undefined, true) : undefined);
  const parentTree = headCommit ? runGit(context, ['rev-parse', `${headCommit}^{tree}`]) : undefined;
  const files = verifyManifest(context, request.files);
  const changed = changedPaths(parentFiles(context, parentTree), files);
  const outside = changed.filter(file => !allowed(file, reviewedPaths));
  if (outside.length) throw new Error(`Git checkpoint 发现未评审的树变化：${outside.join(', ')}`);
  const tree = storeTree(context, files);
  if (headCommit && parentTree === tree && checkpointMessage(context, headCommit) === request.message) {
    if (!refCommit) runGit(context, ['update-ref', context.ref, headCommit, '0'.repeat(headCommit.length)]);
    return { commit: headCommit, tree, ref: context.ref, created: false, parent: headCommit };
  }
  const args = ['commit-tree', tree];
  if (headCommit) args.push('-p', headCommit);
  args.push('-m', request.message);
  const commit = runGit(context, args)!;
  runGit(context, ['update-ref', context.ref, commit, refCommit ?? '0'.repeat(commit.length)]);
  return { commit, tree, ref: context.ref, created: true, ...(headCommit ? { parent: headCommit } : {}) };
}
