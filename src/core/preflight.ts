import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLAUDE_OPTIONS } from '../adapters/claude-code.js';
import { DEFAULT_CODEX_OPTIONS } from '../adapters/codex.js';
import { resolveCommand, runSimple, scrubEnv, type ResolvedCommand, type RunProcessResult } from '../adapters/process.js';
import type { MvpSpec, PreflightResult } from './types.js';

const TOOL_ORDER = ['node', 'npm', 'python', 'dotnet', 'cargo', 'pwsh', 'git'] as const;
type Tool = (typeof TOOL_ORDER)[number];

const VERSION_ARGS: Record<Tool, readonly string[]> = {
  node: ['--version'],
  npm: ['--version'],
  python: ['--version'],
  dotnet: ['--version'],
  cargo: ['--version'],
  pwsh: ['--version'],
  git: ['--version'],
};

const NODE_TECH = /\b(node(?:\.js|js)?|npm|npx|typescript|javascript|react|vite|electron|fastify|express|next(?:\.js|js)?)\b/i;
const PYTHON_TECH = /\b(python|pip|pytest|fastapi|django|flask|uvicorn)\b/i;
const DOTNET_TECH = /(?:\b(?:dotnet|asp\.net)\b|\.net\b|c#)/i;
const CARGO_TECH = /\b(rust|cargo)\b/i;
const PWSH_TECH = /\b(powershell|pwsh)\b/i;
const GIT_TECH = /\bgit\b/i;
const NO_TOOL_TECH = /\b(sqlite|html|css|htmx|browser|web api)\b/i;
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const AUTH_ENV_KEYS = [...new Set([...DEFAULT_CLAUDE_OPTIONS.scrubEnvKeys, ...DEFAULT_CODEX_OPTIONS.scrubEnvKeys])];

type Resolve = (name: string) => ResolvedCommand | null;
type Run = (
  cmd: ResolvedCommand,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
) => Promise<RunProcessResult>;

export interface PreflightOptions {
  signal?: AbortSignal;
  now?: () => string;
  resolve?: Resolve;
  run?: Run;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface PreflightInput {
  spec: MvpSpec;
  stack: readonly { layer: string; choice: string; reason: string }[];
  workspaceDir: string;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('预检已取消', 'AbortError');
}

function commandHead(command: string): string | null {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command);
  const token = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!token || /[\\/]/.test(token)) return null;
  return token.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
}

function addMappedTool(head: string, tools: Set<Tool>): boolean {
  if (head === 'node') tools.add('node');
  else if (head === 'npm' || head === 'npx') {
    tools.add('node');
    tools.add('npm');
  } else if (head === 'python' || head === 'pip' || head === 'py') tools.add('python');
  else if (head === 'dotnet') tools.add('dotnet');
  else if (head === 'cargo') tools.add('cargo');
  else if (head === 'pwsh') tools.add('pwsh');
  else if (head === 'git') tools.add('git');
  else return false;
  return true;
}

function inferTools(input: PreflightInput): { tools: Set<Tool>; explicitGit: boolean; warnings: string[]; nodeEcosystem: boolean } {
  const tools = new Set<Tool>(['git']);
  const warnings: string[] = [];
  let explicitGit = false;
  for (const criterion of input.spec.acceptance) {
    if (criterion.kind !== 'command' || !criterion.command) continue;
    const head = commandHead(criterion.command);
    if (!head || !addMappedTool(head, tools)) warnings.push(`验收项 ${criterion.id} 的命令头无法映射到已知工具，未执行：${head ?? '无法安全解析'}`);
    if (head === 'git') explicitGit = true;
  }
  for (const item of input.stack) {
    const technology = item.choice.trim();
    if (!technology) continue;
    let known = false;
    if (NODE_TECH.test(technology)) {
      tools.add('node');
      tools.add('npm');
      known = true;
    }
    if (PYTHON_TECH.test(technology)) {
      tools.add('python');
      known = true;
    }
    if (DOTNET_TECH.test(technology)) {
      tools.add('dotnet');
      known = true;
    }
    if (CARGO_TECH.test(technology)) {
      tools.add('cargo');
      known = true;
    }
    if (PWSH_TECH.test(technology)) {
      tools.add('pwsh');
      known = true;
    }
    if (GIT_TECH.test(technology)) {
      tools.add('git');
      known = true;
    }
    if (NO_TOOL_TECH.test(technology)) known = true;
    if (!known) warnings.push(`技术栈“${technology}”无法映射到已知工具，未执行任何命令`);
  }
  return { tools, explicitGit, warnings, nodeEcosystem: tools.has('node') || tools.has('npm') };
}

function nearestExistingDirectory(target: string): string | null {
  let current = path.resolve(target);
  while (true) {
    if (existsSync(current)) {
      try {
        return statSync(current).isDirectory() ? current : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function firstLine(result: RunProcessResult): string {
  return (result.stdoutTail || result.stderrTail).split(/\r?\n/, 1)[0]?.trim().slice(0, 200) || '版本命令成功';
}

async function resolvePython(resolve: Resolve, run: Run, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ status: 'ok' | 'missing'; detail: string }> {
  for (const candidate of [
    { launcher: 'python', args: ['--version'] },
    { launcher: 'py', args: ['-3', '--version'] },
  ] as const) {
    abortIfNeeded(signal);
    const cmd = resolve(candidate.launcher);
    if (!cmd) continue;
    const result = await run(cmd, [...candidate.args], { cwd, env, timeoutMs: 10_000, signal });
    abortIfNeeded(signal);
    if (result.cancelled) throw signal?.reason ?? new DOMException('预检已取消', 'AbortError');
    if (result.terminationWarning) return { status: 'missing', detail: `${candidate.launcher} 版本探测无法确认进程树已结束：${result.terminationWarning}` };
    if (result.timedOut) return { status: 'missing', detail: `${candidate.launcher} 版本探测超时` };
    if (result.spawnError) return { status: 'missing', detail: `${candidate.launcher} 版本探测失败：${result.spawnError}` };
    if (result.exitCode === 0) return { status: 'ok', detail: `${candidate.launcher}：${firstLine(result)}` };
  }
  return { status: 'missing', detail: '未找到可用的 python 或 py -3 启动器' };
}

async function checkNetwork(fetchFn: typeof fetch, signal?: AbortSignal): Promise<PreflightResult['items'][number]> {
  abortIfNeeded(signal);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('联网探测超时', 'TimeoutError')), 5_000);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetchFn(NPM_REGISTRY, { method: 'HEAD', redirect: 'manual', signal: combined });
    abortIfNeeded(signal);
    return response.ok
      ? { check: 'network:npm-registry', status: 'ok', detail: `固定 Node 注册站可达（HTTP ${response.status}）` }
      : { check: 'network:npm-registry', status: 'warn', detail: `固定 Node 注册站返回 HTTP ${response.status}；不代表其他生态联网状态` };
  } catch (error) {
    abortIfNeeded(signal);
    const timedOut = timeout.signal.aborted || (error as Error).name === 'TimeoutError';
    return { check: 'network:npm-registry', status: 'warn', detail: `${timedOut ? '固定 Node 注册站探测超时（5 秒）' : '固定 Node 注册站不可达'}；不代表其他生态联网状态` };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPreflight(input: PreflightInput, options: PreflightOptions = {}): Promise<PreflightResult> {
  const signal = options.signal;
  const resolve = options.resolve ?? ((name) => resolveCommand(name));
  const run = options.run ?? runSimple;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const items: PreflightResult['items'] = [];
  abortIfNeeded(signal);

  const workspaceDir = path.resolve(input.workspaceDir);
  const probeDir = nearestExistingDirectory(workspaceDir);
  if (!probeDir) items.push({ check: 'workspace', status: 'missing', detail: '工作区及其父目录不可访问' });
  else {
    try {
      accessSync(probeDir, constants.W_OK);
      items.push({ check: 'workspace', status: 'ok', detail: probeDir === workspaceDir ? '工作区目录可写' : `工作区尚未创建；最近存在的父目录可写：${probeDir}` });
    } catch {
      items.push({ check: 'workspace', status: 'missing', detail: `工作区无法创建或写入；最近存在的父目录不可写：${probeDir}` });
    }
  }
  if (workspaceDir.length > 200) items.push({ check: 'workspace:path-length', status: 'warn', detail: `工作区绝对路径长度为 ${workspaceDir.length}，超过 200 字符` });

  const inferred = inferTools(input);
  for (const warning of inferred.warnings) items.push({ check: 'tool:mapping', status: 'warn', detail: warning });
  const { env } = scrubEnv({ ...(options.env ?? process.env), NO_COLOR: '1' }, AUTH_ENV_KEYS);
  const cwd = probeDir ?? process.cwd();

  for (const tool of TOOL_ORDER) {
    if (!inferred.tools.has(tool)) continue;
    abortIfNeeded(signal);
    if (tool === 'python') {
      const checked = await resolvePython(resolve, run, cwd, env, signal);
      items.push({ check: 'tool:python', ...checked });
      continue;
    }
    const cmd = resolve(tool);
    const missingStatus = tool === 'git' && !inferred.explicitGit ? 'warn' : 'missing';
    if (!cmd) {
      items.push({ check: `tool:${tool}`, status: missingStatus, detail: tool === 'git' && !inferred.explicitGit ? '未找到 Git；可继续无 Git 模式，但无法提供提交绑定证据' : `未找到必需工具 ${tool}` });
      continue;
    }
    const result = await run(cmd, [...VERSION_ARGS[tool]], { cwd, env, timeoutMs: 10_000, signal });
    abortIfNeeded(signal);
    if (result.cancelled) throw signal?.reason ?? new DOMException('预检已取消', 'AbortError');
    if (result.terminationWarning) items.push({ check: `tool:${tool}`, status: 'missing', detail: `${tool} 版本探测无法确认进程树已结束：${result.terminationWarning}` });
    else if (result.timedOut) items.push({ check: `tool:${tool}`, status: missingStatus, detail: `${tool} 版本探测超时` });
    else if (result.spawnError) items.push({ check: `tool:${tool}`, status: missingStatus, detail: `${tool} 版本探测失败：${result.spawnError}` });
    else if (result.exitCode === 0) items.push({ check: `tool:${tool}`, status: 'ok', detail: firstLine(result) });
    else items.push({ check: `tool:${tool}`, status: missingStatus, detail: `${tool} 版本探测失败（退出码 ${result.exitCode ?? '未知'}）` });
  }

  if (input.spec.allowNetwork && inferred.nodeEcosystem) items.push(await checkNetwork(fetchFn, signal));
  abortIfNeeded(signal);
  return { ok: !items.some((item) => item.status === 'missing'), checkedAt: (options.now ?? (() => new Date().toISOString()))(), items };
}

export function renderPreflight(result: PreflightResult): string {
  const label = { ok: '通过', missing: '缺失', warn: '警告' } as const;
  return [
    '# 环境预检',
    '',
    `- 结论：${result.ok ? '通过' : '未通过'}`,
    `- 检查时间：${result.checkedAt}`,
    '',
    '| 检查项 | 状态 | 详情 |',
    '| --- | --- | --- |',
    ...result.items.map((item) => `| ${item.check.replaceAll('|', '\\|')} | ${label[item.status]} | ${item.detail.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`),
    '',
  ].join('\n');
}
