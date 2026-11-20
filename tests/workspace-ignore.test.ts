import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { captureWorkspace, verifyWorkspaceAnchor } from '../src/orchestrator/review-workspace.js';
import { ensureGeneratedWorkspaceExcludes } from '../src/orchestrator/workspace-ignore.js';

const temporaryDirectories: string[] = [];
process.on('exit', () => temporaryDirectories.forEach(directory => rmSync(directory, { recursive: true, force: true })));

function tempRepository(): string {
  const parent = path.join(process.cwd(), '.test-tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'workspace-ignore-'));
  temporaryDirectories.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

test('生成工作区只排除运行依赖和缓存，保留现有规则与业务漂移门禁', async () => {
  const root = tempRepository();
  const exclude = path.join(root, '.git', 'info', 'exclude');
  const existing = `${readFileSync(exclude, 'utf8')}\n# user rule\n*.local\n!keep.local\n`;
  writeFileSync(exclude, existing, 'utf8');

  ensureGeneratedWorkspaceExcludes(root);
  const once = readFileSync(exclude, 'utf8');
  ensureGeneratedWorkspaceExcludes(root);
  assert.equal(readFileSync(exclude, 'utf8'), once, '重复调用不能堆叠受控规则');
  assert.match(once, /# user rule\n\*\.local\n!keep\.local/);

  mkdirSync(path.join(root, '.venv', 'Lib', 'site-packages'), { recursive: true });
  mkdirSync(path.join(root, '.python-bootstrap', 'runtime', 'Lib', '__pycache__'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, '.venv', 'Lib', 'site-packages', 'runtime.py'), 'generated\n');
  writeFileSync(path.join(root, '.python-bootstrap', 'runtime', 'Lib', '__pycache__', 'x.pyc'), 'generated\n');
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'generated\n');
  writeFileSync(path.join(root, 'src', 'app.py'), 'VALUE = 1\n');
  writeFileSync(path.join(root, 'src', 'native.pyd'), 'native extension fixture\n');
  writeFileSync(path.join(root, 'tests', 'test_app.py'), 'def test_value(): assert True\n');
  writeFileSync(path.join(root, 'requirements.txt'), 'pytest==9.1.1\n');
  writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
  writeFileSync(path.join(root, 'keep.local'), 'tracked by user negation\n');

  const status = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  assert.doesNotMatch(status, /\.venv|\.python-bootstrap|node_modules/);
  assert.match(status, /src\/app\.py/);
  assert.match(status, /src\/native\.pyd/, '可交付本地扩展不能被当作缓存忽略');
  assert.match(status, /tests\/test_app\.py/);
  assert.match(status, /requirements\.txt/);
  assert.match(status, /package-lock\.json/);
  assert.match(status, /keep\.local/, '原有显式反向规则应继续生效');

  const anchor = await captureWorkspace(root);
  assert.deepEqual(anchor.fileTree.sort(), ['keep.local', 'package-lock.json', 'requirements.txt', 'src/app.py', 'src/native.pyd', 'tests/test_app.py']);

  writeFileSync(path.join(root, '.venv', 'Lib', 'site-packages', 'later.py'), 'generated later\n');
  assert.deepEqual(await verifyWorkspaceAnchor(root, anchor), { ok: true, errors: [] });

  writeFileSync(path.join(root, 'src', 'new.py'), 'VALUE = 2\n');
  const drift = await verifyWorkspaceAnchor(root, anchor);
  assert.equal(drift.ok, false);
  assert.match(drift.errors.join('\n'), /src\/new\.py|src\\new\.py/);
});

test('仓库自己的 .gitignore 和显式反向规则优先于生成规则', () => {
  const root = tempRepository();
  const gitignore = path.join(root, '.gitignore');
  const userRules = '/.venv/*\n!/.venv/keep.txt\n';
  writeFileSync(gitignore, userRules, 'utf8');
  ensureGeneratedWorkspaceExcludes(root);
  assert.equal(readFileSync(gitignore, 'utf8'), userRules);

  mkdirSync(path.join(root, '.venv'), { recursive: true });
  writeFileSync(path.join(root, '.venv', 'discard.py'), 'ignored\n');
  writeFileSync(path.join(root, '.venv', 'keep.txt'), 'explicitly included\n');
  const status = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  assert.doesNotMatch(status, /discard\.py/);
  assert.match(status, /\.venv\/keep\.txt|\.venv\\keep\.txt/);
});

test('已有 Git 工作区若已跟踪运行依赖则每次都 fail closed，且不改 HEAD、index 或文件', () => {
  const root = tempRepository();
  mkdirSync(path.join(root, '.venv', 'Lib', 'site-packages'), { recursive: true });
  mkdirSync(path.join(root, '.python-bootstrap', 'runtime'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, '.venv', 'Lib', 'site-packages', 'runtime.py'), 'tracked dependency\n');
  writeFileSync(path.join(root, '.python-bootstrap', 'runtime', 'bootstrap.pyc'), 'tracked cache\n');
  writeFileSync(path.join(root, 'src', 'app.py'), 'VALUE = 1\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Workspace Test', '-c', 'user.email=workspace@example.invalid', 'commit', '-qm', 'baseline');

  const head = git(root, 'rev-parse', 'HEAD');
  const index = git(root, 'ls-files', '--stage');
  const dependency = readFileSync(path.join(root, '.venv', 'Lib', 'site-packages', 'runtime.py'), 'utf8');
  const exclude = path.join(root, '.git', 'info', 'exclude');
  const originalExclude = readFileSync(exclude, 'utf8');
  const expected = /已有运行依赖\/缓存被Git跟踪，请新建验证作业\/工作区，原记录保留/;

  assert.throws(() => ensureGeneratedWorkspaceExcludes(root), expected);
  assert.equal(readFileSync(exclude, 'utf8'), originalExclude, '拒绝时不能安装真实 exclude 规则');
  assert.equal(readdirSync(path.dirname(exclude)).some(file => file.startsWith('dmw-generated-')), false, '预检临时规则必须清理');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'ls-files', '--stage'), index);
  assert.equal(readFileSync(path.join(root, '.venv', 'Lib', 'site-packages', 'runtime.py'), 'utf8'), dependency);

  assert.throws(() => ensureGeneratedWorkspaceExcludes(root), expected, '幂等重试也必须重新检查已跟踪生成物');
  assert.equal(readFileSync(exclude, 'utf8'), originalExclude, '重复拒绝仍不能污染真实 exclude');
  assert.equal(readdirSync(path.dirname(exclude)).some(file => file.startsWith('dmw-generated-')), false, '重复预检也不能遗留临时规则');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'ls-files', '--stage'), index);
});

test('已跟踪的 .pyd 与用户显式反向保留文件不会被生成规则误拦截', () => {
  const root = tempRepository();
  writeFileSync(path.join(root, '.gitignore'), '/.venv/*\n!/.venv/keep.txt\n', 'utf8');
  mkdirSync(path.join(root, '.venv'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, '.venv', 'keep.txt'), 'explicitly retained\n');
  writeFileSync(path.join(root, 'src', 'native.pyd'), 'deliverable extension\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Workspace Test', '-c', 'user.email=workspace@example.invalid', 'commit', '-qm', 'baseline');

  assert.doesNotThrow(() => ensureGeneratedWorkspaceExcludes(root));
  assert.doesNotThrow(() => ensureGeneratedWorkspaceExcludes(root));
  assert.deepEqual(git(root, 'ls-files').split(/\r?\n/), ['.gitignore', '.venv/keep.txt', 'src/native.pyd']);
});
