import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCommand } from '../adapters/process.js';

const START = '# BEGIN DUAL MODEL WORKBENCH GENERATED EXCLUDES';
const END = '# END DUAL MODEL WORKBENCH GENERATED EXCLUDES';
const MANAGED = [
  START,
  '/.venv/**',
  '/.python-bootstrap/**',
  '/node_modules/**',
  '/.cache/**',
  '/.pytest_cache/**',
  '/.mypy_cache/**',
  '/.ruff_cache/**',
  '**/__pycache__/**',
  '*.pyc',
  '*.pyo',
  END,
  '',
].join('\n');
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const GENERATED_ROOTS = new Set([
  '.venv',
  '.python-bootstrap',
  'node_modules',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

function git(workspaceDir: string, args: readonly string[], input?: string, acceptedStatuses: readonly number[] = [0]): string {
  const command = resolveCommand('git');
  if (!command) throw new Error('无法核验生成工作区：未找到 git 可执行文件');
  if (command.via === 'cmd-fallback') throw new Error('无法核验生成工作区：Git 只能通过命令脚本启动');
  const result = spawnSync(command.file, [...command.prefixArgs, ...args], {
    cwd: workspaceDir,
    env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    input,
    windowsHide: true,
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason = code === 'ETIMEDOUT'
      ? '操作超时'
      : code === 'ENOBUFS'
        ? `输出超过 ${MAX_GIT_OUTPUT_BYTES} 字节上限`
        : result.error.message;
    throw new Error(`无法核验生成工作区：Git ${args[0] ?? '命令'}失败（${reason}）`);
  }
  if (result.signal) throw new Error(`无法核验生成工作区：Git ${args[0] ?? '命令'}被 ${result.signal} 终止`);
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    const detail = result.stderr.trim();
    throw new Error(`无法核验生成工作区：Git ${args[0] ?? '命令'}退出码 ${result.status}${detail ? `：${detail}` : ''}`);
  }
  if (result.stdout.length >= MAX_GIT_OUTPUT_BYTES) {
    throw new Error(`无法核验生成工作区：Git ${args[0] ?? '命令'}输出达到上限`);
  }
  return result.stdout;
}

function isManagedGeneratedPath(file: string): boolean {
  const parts = file.replaceAll('\\', '/').split('/');
  const first = (parts[0] ?? '').toLowerCase();
  return GENERATED_ROOTS.has(first)
    || parts.some(part => part.toLowerCase() === '__pycache__')
    || /\.(?:pyc|pyo)$/i.test(parts.at(-1) ?? '');
}

function rejectTrackedGeneratedFiles(workspaceDir: string, infoDirectory: string): void {
  const tracked = git(workspaceDir, ['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(isManagedGeneratedPath);
  if (tracked.length === 0) return;

  // A temporary global exclude has lower precedence than the repository's
  // info/exclude and .gitignore rules, matching a managed block prepended to
  // info/exclude while leaving the real file untouched until validation wins.
  mkdirSync(infoDirectory, { recursive: true });
  const temporaryExclude = path.join(infoDirectory, `dmw-generated-${process.pid}-${randomUUID()}.exclude`);
  writeFileSync(temporaryExclude, MANAGED, { encoding: 'utf8', flag: 'wx' });
  let ignored: string[];
  try {
    ignored = git(
      workspaceDir,
      ['-c', `core.excludesFile=${temporaryExclude}`, 'check-ignore', '--no-index', '-z', '--stdin'],
      `${tracked.join('\0')}\0`,
      [0, 1],
    ).split('\0').filter(Boolean);
  } finally {
    unlinkSync(temporaryExclude);
  }
  if (ignored.length === 0) return;

  const samples = ignored.slice(0, 5).map(file => JSON.stringify(file.length > 160 ? `${file.slice(0, 157)}...` : file));
  throw new Error(
    `检测到 ${ignored.length} 个已跟踪的生成文件${samples.length ? `（示例：${samples.join('、')}）` : ''}。`
    + '已有运行依赖/缓存被Git跟踪，请新建验证作业/工作区，原记录保留。',
  );
}

/**
 * Keep generated dependencies outside the source anchor without changing the
 * repository's .gitignore. Existing exclude rules remain later and therefore
 * retain their override/negation semantics.
 */
export function ensureGeneratedWorkspaceExcludes(workspaceDir: string): void {
  const gitDirectory = path.join(workspaceDir, '.git');
  if (!existsSync(gitDirectory) || !lstatSync(gitDirectory).isDirectory()) {
    throw new Error('生成工作区尚未初始化独立 Git 仓库');
  }
  const infoDirectory = path.join(gitDirectory, 'info');
  const excludeFile = path.join(infoDirectory, 'exclude');
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
    throw new Error('生成工作区 Git exclude 的受控区块不完整');
  }
  const retained = start < 0
    ? current
    : current.slice(0, start) + current.slice(end + END.length).replace(/^\r?\n/, '');
  const next = MANAGED + retained;
  rejectTrackedGeneratedFiles(workspaceDir, infoDirectory);
  if (next !== current) {
    mkdirSync(infoDirectory, { recursive: true });
    writeFileSync(excludeFile, next, 'utf8');
  }
}
