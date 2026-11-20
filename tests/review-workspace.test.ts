import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  captureWorkspace,
  cleanupReviewWorkspace,
  createReviewWorkspace,
  verifyReviewWorkspace,
  verifyWorkspaceAnchor,
  verifyWorkspaceAnchorSync,
  type WorkspaceAnchor,
} from '../src/orchestrator/review-workspace.js';

const temporaryDirectories: string[] = [];
process.on('exit', () => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function testTempDir(prefix: string): string {
  const root = path.join(process.cwd(), '.test-tmp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function initRepository(root: string): void {
  git(root, 'init', '-q');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.cache/\n.env\nfixtures/\n', 'utf8');
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
  writeFileSync(path.join(root, 'tests', 'app.test.ts'), 'export const expected = 1;\n', 'utf8');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--no-verify', '-q', '-m', 'baseline');
}

async function fixture(): Promise<{ source: string; allowedRoot: string; anchor: WorkspaceAnchor }> {
  const base = testTempDir('dmw-review-');
  const source = path.join(base, 'source');
  const allowedRoot = path.join(base, 'reviews');
  mkdirSync(source);
  mkdirSync(allowedRoot);
  initRepository(source);
  writeFileSync(path.join(source, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
  writeFileSync(path.join(source, 'src', 'new.ts'), 'export const added = true;\n', 'utf8');
  return { source, allowedRoot, anchor: await captureWorkspace(source) };
}

test('captureWorkspace 固定全部文件并返回可复现的提交、树和差异', async () => {
  const { source, anchor } = await fixture();
  assert.match(anchor.commit, /^[0-9a-f]{40,64}$/);
  assert.match(anchor.treeHash, /^[0-9a-f]{40,64}$/);
  assert.match(anchor.baselineCommit ?? '', /^[0-9a-f]{40,64}$/);
  assert.deepEqual(anchor.fileTree, ['.gitignore', 'src/app.ts', 'src/new.ts', 'tests/app.test.ts']);
  assert.match(anchor.diffStat, /src\/app\.ts|src\\app\.ts/);
  assert.equal(git(source, 'status', '--porcelain=v1'), '');
  assert.equal(git(source, 'rev-parse', 'HEAD'), anchor.commit);
  assert.equal(git(source, 'rev-parse', 'HEAD^{tree}'), anchor.treeHash);
});

test('verifyWorkspaceAnchor 只读检测外部文件漂移并允许 ignored cache', async () => {
  const { source, anchor } = await fixture();
  const originalHead = git(source, 'rev-parse', 'HEAD');
  mkdirSync(path.join(source, '.cache'));
  writeFileSync(path.join(source, '.cache', 'generated.bin'), 'cache', 'utf8');
  assert.deepEqual(await verifyWorkspaceAnchor(source, anchor), { ok: true, errors: [] });
  assert.equal(git(source, 'rev-parse', 'HEAD'), originalHead, '只读核验不能提交或移动 HEAD');

  writeFileSync(path.join(source, 'src', 'external.ts'), 'export const drift = true;\n', 'utf8');
  const verification = await verifyWorkspaceAnchor(source, anchor);
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join('\n'), /未锚定|external\.ts/);
  assert.equal(git(source, 'rev-parse', 'HEAD'), originalHead);
});

test('verifyWorkspaceAnchor 检出外部自行提交后的 clean 漂移', async () => {
  const { source, anchor } = await fixture();
  writeFileSync(path.join(source, 'tests', 'app.test.ts'), 'export const expected = 99;\n', 'utf8');
  git(source, 'add', '-A');
  git(source, '-c', 'user.name=External', '-c', 'user.email=external@localhost', 'commit', '--no-verify', '-q', '-m', 'external change');
  assert.equal(git(source, 'status', '--porcelain=v1'), '');
  const verification = await verifyWorkspaceAnchor(source, anchor);
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join('\n'), /HEAD 已漂移|提交树已漂移/);
});

test('verifyWorkspaceAnchorSync 在 G4 点击瞬间同步检测干净、未提交和外部提交状态', async () => {
  const clean = await fixture();
  assert.deepEqual(verifyWorkspaceAnchorSync(clean.source, clean.anchor), { ok: true, errors: [] });
  mkdirSync(path.join(clean.source, '.cache'));
  writeFileSync(path.join(clean.source, '.cache', 'g4-generated.bin'), 'cache', 'utf8');
  assert.deepEqual(verifyWorkspaceAnchorSync(clean.source, clean.anchor), { ok: true, errors: [] });
  writeFileSync(path.join(clean.source, 'src', 'app.ts'), 'export const value = 77;\n', 'utf8');
  const dirty = verifyWorkspaceAnchorSync(clean.source, clean.anchor);
  assert.equal(dirty.ok, false);
  assert.match(dirty.errors.join('\n'), /未锚定|src\/app\.ts|src\\app\.ts/);

  const committed = await fixture();
  writeFileSync(path.join(committed.source, 'tests', 'app.test.ts'), 'export const expected = 88;\n', 'utf8');
  git(committed.source, 'add', '-A');
  git(committed.source, '-c', 'user.name=External', '-c', 'user.email=external@localhost', 'commit', '--no-verify', '-q', '-m', 'after final review');
  assert.equal(git(committed.source, 'status', '--porcelain=v1'), '');
  const drift = verifyWorkspaceAnchorSync(committed.source, committed.anchor);
  assert.equal(drift.ok, false);
  assert.match(drift.errors.join('\n'), /HEAD 已漂移|提交树已漂移/);
});

test('verifyWorkspaceAnchorSync 对非绝对、移位或不可读路径 fail-closed', async () => {
  const { source, anchor } = await fixture();
  const relative = verifyWorkspaceAnchorSync(path.relative(process.cwd(), source), anchor);
  assert.equal(relative.ok, false);
  assert.match(relative.errors.join('\n'), /绝对路径/);

  const moved = path.join(path.dirname(source), 'source-moved');
  renameSync(source, moved);
  const unavailable = verifyWorkspaceAnchorSync(source, anchor);
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.errors.join('\n'), /无法读取构建工作区真实路径/);
});

test('独立 clone 不改变源工作区，tracked 与未跟踪源码变化会令评审失效', async () => {
  const { source, allowedRoot, anchor } = await fixture();
  const beforeSource = readFileSync(path.join(source, 'src', 'app.ts'), 'utf8');
  const review = await createReviewWorkspace(source, path.join(allowedRoot, 'review-1'), anchor, allowedRoot);
  assert.equal((await verifyReviewWorkspace(review)).ok, true);
  assert.notEqual(path.resolve(review.workspaceDir, '.git'), path.resolve(source, '.git'));
  assert.equal(readFileSync(path.join(review.workspaceDir, 'src', 'app.ts'), 'utf8').replaceAll('\r\n', '\n'), beforeSource);

  mkdirSync(path.join(review.workspaceDir, '.cache'));
  writeFileSync(path.join(review.workspaceDir, '.cache', 'generated.bin'), 'cache', { encoding: 'utf8', flag: 'w' });
  assert.equal((await verifyReviewWorkspace(review)).ok, true, 'ignored cache is allowed');
  writeFileSync(path.join(review.workspaceDir, 'src', 'app.ts'), 'export const value = 99;\n', 'utf8');
  writeFileSync(path.join(review.workspaceDir, 'tests', 'hidden.test.ts'), 'throw new Error();\n', 'utf8');
  const verification = await verifyReviewWorkspace(review);
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join('\n'), /工作区|未忽略|源码/);
  assert.equal(readFileSync(path.join(source, 'src', 'app.ts'), 'utf8'), beforeSource);

  await cleanupReviewWorkspace(review);
  assert.equal(existsSync(review.workspaceDir), false);
  assert.equal(existsSync(source), true);
});

test('评审模型自行提交后恢复到原提交仍会被 reflog 检出', async () => {
  const { source, allowedRoot, anchor } = await fixture();
  const review = await createReviewWorkspace(source, path.join(allowedRoot, 'review-commit'), anchor, allowedRoot);
  writeFileSync(path.join(review.workspaceDir, 'src', 'app.ts'), 'export const value = 3;\n', 'utf8');
  git(review.workspaceDir, 'add', '-A');
  git(review.workspaceDir, '-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@localhost', 'commit', '--no-verify', '-q', '-m', 'tamper');
  git(review.workspaceDir, 'checkout', '--detach', '-q', anchor.commit);
  const verification = await verifyReviewWorkspace(review);
  assert.equal(git(review.workspaceDir, 'status', '--porcelain=v1'), '');
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join('\n'), /reflog|历史/);
  await cleanupReviewWorkspace(review);
});

test('路径逃逸和伪造清理请求被拒绝，Git 失败清晰可见', async () => {
  const { source, allowedRoot, anchor } = await fixture();
  const outside = path.join(path.dirname(allowedRoot), 'outside-review');
  await assert.rejects(createReviewWorkspace(source, outside, anchor, allowedRoot), /越过允许的根目录/);
  await assert.rejects(
    cleanupReviewWorkspace({
      sourceDir: source,
      workspaceDir: source,
      allowedRoot,
      anchor,
      initialHead: anchor.commit,
      initialTreeHash: anchor.treeHash,
      initialReflog: '',
      sourceSnapshot: {},
      initialIgnoredSnapshot: {},
    }),
    /不是由本模块创建/,
  );
  // Keep this fixture outside the checkout so Git cannot discover its parent repository.
  const notGit = mkdtempSync(path.join(tmpdir(), 'dmw-not-git-'));
  temporaryDirectories.push(notGit);
  await assert.rejects(captureWorkspace(notGit), /Git rev-parse失败/);
});

test('符号链接或 junction 父目录不能把 clone 引出允许根目录', async (t) => {
  const { source, allowedRoot, anchor } = await fixture();
  const outside = testTempDir('dmw-review-outside-');
  const link = path.join(allowedRoot, 'escape');
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`当前系统不能创建目录链接：${code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(createReviewWorkspace(source, path.join(link, 'review'), anchor, allowedRoot), /父目录经解析后越过/);
});

test('ignored 语义文件和 fixture 变化令评审失效，固定 .cache 仍允许', async () => {
  const { source, allowedRoot, anchor } = await fixture();
  const cacheReview = await createReviewWorkspace(source, path.join(allowedRoot, 'review-cache'), anchor, allowedRoot);
  mkdirSync(path.join(cacheReview.workspaceDir, '.cache'));
  writeFileSync(path.join(cacheReview.workspaceDir, '.cache', 'result.json'), '{"ok":true}', 'utf8');
  assert.equal((await verifyReviewWorkspace(cacheReview)).ok, true);
  await cleanupReviewWorkspace(cacheReview);

  const envReview = await createReviewWorkspace(source, path.join(allowedRoot, 'review-env'), anchor, allowedRoot);
  writeFileSync(path.join(envReview.workspaceDir, '.env'), 'FEATURE_FLAG=unsafe\n', 'utf8');
  const envResult = await verifyReviewWorkspace(envReview);
  assert.equal(envResult.ok, false);
  assert.match(envResult.errors.join('\n'), /ignored.*\.env|\.env.*ignored/si);
  await cleanupReviewWorkspace(envReview);

  const fixtureReview = await createReviewWorkspace(source, path.join(allowedRoot, 'review-fixture'), anchor, allowedRoot);
  mkdirSync(path.join(fixtureReview.workspaceDir, 'fixtures'));
  const fixturePath = path.join(fixtureReview.workspaceDir, 'fixtures', 'case.json');
  writeFileSync(fixturePath, '{"value":1}', 'utf8');
  let fixtureResult = await verifyReviewWorkspace(fixtureReview);
  assert.equal(fixtureResult.ok, false);
  assert.match(fixtureResult.errors.join('\n'), /fixtures\/case\.json/);
  writeFileSync(fixturePath, '{"value":2}', 'utf8');
  fixtureResult = await verifyReviewWorkspace(fixtureReview);
  assert.equal(fixtureResult.ok, false);
  assert.match(fixtureResult.errors.join('\n'), /fixtures\/case\.json/);
  await cleanupReviewWorkspace(fixtureReview);
});
