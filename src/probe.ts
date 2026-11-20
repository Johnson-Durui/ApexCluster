/**
 * 环境探测。
 * - probeEnvironment：只读检查（不调用任何模型、不产生费用）：可执行文件、版本、登录状态、环境变量、Windows 长路径等。
 * - liveProbe：最小真实调用（会消耗额度），只在你明确要求时运行；用来确认“指定型号 + 指定强度 + 结构化输出 + 元数据”在目标机器上真的可用。
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter, cursorCommandBindingMatches, cursorExecutableMismatch, resolveCursorCommand, type CursorCapabilities } from './adapters/cursor.js';
import { assertDispatchSafe, recordUnconfirmedProcess } from './adapters/dispatch-safety.js';
import { resolveCommand, runSimple, scrubEnv, type ResolvedCommand } from './adapters/process.js';
import type { ModelAdapter, ModelTaskSpec } from './adapters/types.js';
import type { WorkbenchConfig } from './config.js';
import { OUTPUT_SCHEMAS } from './core/schemas.js';
import { toStrictJsonSchema } from './core/strict-json-schema.js';
import type { Effort, ExecutionMeta, ModelRole } from './core/types.js';
import { validateOutput, extractJson } from './core/validate.js';
import { buildProbePrompt } from './prompts/render.js';

export type Level = 'ok' | 'warn' | 'error';
export interface Finding {
  id: string;
  level: Level;
  message: string;
  detail?: string;
}
export interface ProbeReport {
  at: string;
  platform: string;
  node: string;
  findings: Finding[];
  tools: Record<string, { path: string | null; via: string | null; version: string | null }>;
}

export const MIN_CLAUDE_CODE = [2, 1, 280] as const;

export interface ProbeDependencies {
  runSimple?: typeof runSimple;
  adapterFor?: (role: ModelRole, cfg: WorkbenchConfig) => ModelAdapter;
}

export function parseVersion(text: string | null): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function versionAtLeast(v: number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) > min[i]!) return true;
    if ((v[i] ?? 0) < min[i]!) return false;
  }
  return true;
}

async function guardedSimple(
  dataDir: string,
  key: string,
  runner: typeof runSimple,
  cmd: ResolvedCommand,
  args: string[],
  opts: Parameters<typeof runSimple>[2],
) {
  assertDispatchSafe(dataDir);
  const result = await runner(cmd, args, opts);
  if (result.terminationWarning) recordUnconfirmedProcess(dataDir, key, result.terminationWarning);
  return result;
}

async function version(dataDir: string, key: string, runner: typeof runSimple, cmd: ResolvedCommand | null, args = ['--version']): Promise<string | null> {
  if (!cmd) return null;
  const r = await guardedSimple(dataDir, key, runner, cmd, args, { timeoutMs: 20_000 });
  return r.exitCode === 0 ? (r.stdoutTail.trim() || r.stderrTail.trim()).split('\n')[0] ?? null : null;
}

export async function probeEnvironment(cfg: WorkbenchConfig, deps: ProbeDependencies = {}): Promise<ProbeReport> {
  const run = deps.runSimple ?? runSimple;
  const findings: Finding[] = [];
  const tools: ProbeReport['tools'] = {};
  const add = (id: string, level: Level, message: string, detail?: string) => findings.push({ id, level, message, ...(detail ? { detail } : {}) });

  if (process.platform !== 'win32') add('platform', 'warn', `当前平台是 ${process.platform}，不是目标平台 Windows：这里的结果不能代替 Windows 验收`);
  const [maj] = process.versions.node.split('.').map(Number);
  add('node', (maj ?? 0) >= 22 ? 'ok' : 'error', `Node.js ${process.versions.node}${(maj ?? 0) >= 22 ? '' : '（需要 ≥ 22）'}`);

  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    accessSync(cfg.dataDir, constants.W_OK);
    add('dataDir', 'ok', `数据目录可写：${cfg.dataDir}`);
  } catch (e) {
    add('dataDir', 'error', `数据目录不可写：${cfg.dataDir}`, (e as Error).message);
  }

  assertDispatchSafe(cfg.dataDir);

  // Claude Code
  const claude = resolveCommand('claude', { override: cfg.adapters.claude.command });
  const cv = await version(cfg.dataDir, 'probe:claude:version', run, claude);
  tools.claude = { path: claude?.file ?? null, via: claude?.via ?? null, version: cv };
  if (!claude) add('claude.install', 'error', '找不到 claude（Claude Code）。Windows 安装：PowerShell 执行 irm https://claude.ai/install.ps1 | iex，或 winget install Anthropic.ClaudeCode');
  else {
    const v = parseVersion(cv);
    if (!v) add('claude.version', 'warn', `无法解析 Claude Code 版本：${cv ?? '(无输出)'}`);
    else if (!versionAtLeast(v, MIN_CLAUDE_CODE)) add('claude.version', 'error', `Claude Code ${v.join('.')} 过旧：Opus 5.5 需要 ≥ ${MIN_CLAUDE_CODE.join('.')}（旧版的 opus 别名会静默指向旧型号）`);
    else add('claude.version', 'ok', `Claude Code ${v.join('.')}`);
    if (claude.via === 'cmd-fallback') add('claude.shim', 'warn', 'claude 通过 .cmd 垫片调用：--json-schema 将自动关闭（命令行经 cmd.exe 有长度/转义风险），改用提示词 + 本地校验');
    const st = await guardedSimple(cfg.dataDir, 'probe:claude:auth', run, claude, ['auth', 'status'], { timeoutMs: 20_000 });
    let method: string | null = null;
    try {
      method = (JSON.parse(st.stdoutTail) as { authMethod?: string }).authMethod ?? null;
    } catch {
      /* 旧版本可能不是 JSON */
    }
    if (st.exitCode === 0) add('claude.auth', method === 'claude.ai' || method === 'oauth_token' ? 'ok' : 'warn', `Claude Code 已登录（方式：${method ?? '未知'}）${method && !['claude.ai', 'oauth_token'].includes(method) ? '：不是订阅登录，可能按 API 计费' : ''}`);
    else add('claude.auth', 'error', 'Claude Code 未登录：在终端运行 claude 并按提示登录（需要 Pro/Max 等付费计划；工作台不代为登录）');
  }

  // Codex
  const codex = resolveCommand('codex', { override: cfg.adapters.codex.command });
  const xv = await version(cfg.dataDir, 'probe:codex:version', run, codex);
  tools.codex = { path: codex?.file ?? null, via: codex?.via ?? null, version: xv };
  if (!codex) add('codex.install', 'error', '找不到 codex（Codex CLI）。请按官方文档在 Windows 上安装，并运行 codex login');
  else {
    add('codex.version', 'ok', `Codex CLI ${xv ?? '(版本未知)'}${codex.via !== 'direct' ? `（调用方式：${codex.via}）` : ''}`);
    const st = await guardedSimple(cfg.dataDir, 'probe:codex:auth', run, codex, ['login', 'status'], { timeoutMs: 20_000 });
    const text = `${st.stdoutTail}\n${st.stderrTail}`.trim().split('\n')[0] ?? '';
    if (st.exitCode === 0) add('codex.auth', /api key/i.test(text) ? 'warn' : 'ok', `Codex 已登录：${text}${/api key/i.test(text) ? '（API key 方式会按量计费）' : ''}`);
    else add('codex.auth', 'error', 'Codex 未登录：在终端运行 codex login，选择 ChatGPT 登录');
  }

  // Cursor 仅探测可执行文件与版本；不读登录信息，不调用模型、不自动形成 H7 记录。
  const cursor = resolveCursorCommand(cfg.adapters.cursor.command);
  const cursorBinding = cfg.adapters.cursor.capabilities?.commandBinding
    ? cfg.adapters.cursor.capabilities
    : cursor
      ? ({ commandBinding: { file: cursor.file, prefixArgs: cursor.prefixArgs } } as CursorCapabilities)
      : null;
  const cursorSafe = cursorCommandBindingMatches(cursor, cursorBinding);
  const cursorEnv = scrubEnv(process.env, [...cfg.adapters.cursor.scrubEnvKeys, 'CURSOR_API_KEY', 'CURSOR_API_ENDPOINT']).env;
  const cursorResult = cursor && cursorSafe
    ? await guardedSimple(cfg.dataDir, 'probe:cursor:version', run, cursor, ['--version'], { timeoutMs: 20_000, env: cursorEnv })
    : null;
  const cursorVersion = cursorResult?.exitCode === 0 ? cursorResult.stdoutTail.trim().split('\n')[0] ?? null : null;
  const cursorMismatch = cursorVersion ? cursorExecutableMismatch(cursorVersion) : null;
  tools.cursor = { path: cursor?.file ?? null, via: cursor?.via ?? null, version: cursorMismatch ? null : cursorVersion };
  add('cursor.capabilities', cursorMismatch || (cursor && !cursorSafe) ? 'error' : 'warn', cursorMismatch ?? (cursor && !cursorSafe
    ? 'Cursor 候选命令包含未经允许的入口参数或与 H7 绑定不符；已拒绝版本探测'
    : cursor ? `找到 Cursor Agent 候选命令（${cursorVersion ?? '版本未知'}）；身份、Grok 可用性与只读能力须经 H7 单独实测` : '未找到 Cursor Agent 候选命令；Grok 整理保持关闭，不自动安装或登录'), cursorMismatch ? cursor?.file : undefined);
  if (cursorResult?.terminationWarning) add('cursor.termination', 'error', 'Cursor 版本检查的进程树退出未确认', cursorResult.terminationWarning);

  // git（Sol 工作区需要）
  const git = resolveCommand('git');
  const gv = await version(cfg.dataDir, 'probe:git:version', run, git);
  tools.git = { path: git?.file ?? null, via: git?.via ?? null, version: gv };
  add('git', git ? 'ok' : 'warn', git ? `git 可用：${gv}` : '没有 git：Sol 工作区无法初始化为仓库（Codex 将以 --skip-git-repo-check 运行，无法回滚）');

  // Codex Windows 沙箱：你有管理员权限，建议使用 elevated（只读检查配置，不修改）
  const codexConfig = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  const sandboxMode = existsSync(codexConfig) ? /\[windows\][^[]*?sandbox\s*=\s*"(elevated|unelevated)"/s.exec(readFileSync(codexConfig, 'utf8'))?.[1] ?? null : null;
  if (process.platform === 'win32') {
    if (sandboxMode === 'elevated') add('codex.sandbox', 'ok', 'Codex Windows 沙箱：elevated');
    else add('codex.sandbox', 'warn', `Codex Windows 沙箱：${sandboxMode ?? '未设置'}。你有管理员权限，建议在 ${codexConfig} 中加入 [windows] sandbox = "elevated"（首次使用会请求管理员批准）`);
  }

  // 可能影响“两边独立、可复现”的个人全局说明文件（只提示，不修改）
  const codexGlobal = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'AGENTS.md');
  if (existsSync(codexGlobal)) add('codex.agents', 'warn', `存在 Codex 全局说明 ${codexGlobal}：会被 Astra/Sol 读取，可能影响独立性（工作台不修改你的配置）`);
  const claudeGlobal = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (existsSync(claudeGlobal)) add('claude.memory', 'ok', `存在 ${claudeGlobal}：设计任务使用 --safe-mode，不会加载它`);

  // 会改变计费方式的环境变量（只报名字）
  const risky = [...new Set([...cfg.adapters.claude.scrubEnvKeys, ...cfg.adapters.codex.scrubEnvKeys, ...cfg.adapters.cursor.scrubEnvKeys, 'CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'])].filter((k) => process.env[k] !== undefined);
  if (risky.length) add('env', 'warn', `环境中存在 ${risky.join(', ')}：调用模型时会从子进程环境中移除，以保持订阅登录方式`);

  // Windows 专项
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'], { encoding: 'utf8', windowsHide: true });
      const on = /0x1/.test(out);
      add('win.longpaths', on ? 'ok' : 'warn', on ? '已启用 Windows 长路径' : '未启用 Windows 长路径：Sol 工作区里的 node_modules 可能超过 260 字符');
    } catch {
      add('win.longpaths', 'warn', '无法读取 LongPathsEnabled（可能需要权限）');
    }
  }
  const sample = path.join(cfg.workspacesRoot, 'r-20261008-abcdef', 'j-C1-1');
  add('workspaces', sample.length > 60 ? 'warn' : 'ok', `Sol 工作区根目录：${cfg.workspacesRoot}${sample.length > 60 ? '（路径偏长，建议改到更短的位置，例如 C:\\dmw）' : ''}`);

  return { at: new Date().toISOString(), platform: `${process.platform} ${os.release()}`, node: process.versions.node, findings, tools };
}

export interface LiveProbeResult {
  role: ModelRole;
  model: string;
  effort: Effort;
  status: string;
  failure: { kind: string; message: string } | null;
  outputValid: boolean;
  meta: ExecutionMeta;
}

/** 真实最小调用：会消耗额度。efforts 可以一次测多个档位，例如 sol: ['max','ultra'] */
export async function liveProbe(cfg: WorkbenchConfig, targets: { role: ModelRole; effort?: Effort }[], deps: ProbeDependencies = {}): Promise<LiveProbeResult[]> {
  const schema = toStrictJsonSchema(OUTPUT_SCHEMAS.probe);
  const out: LiveProbeResult[] = [];
  for (const t of targets) {
    assertDispatchSafe(cfg.dataDir);
    const m = cfg.models[t.role];
    if (!m) throw new Error(`未知模型角色 ${t.role}`);
    const adapter: ModelAdapter = deps.adapterFor?.(t.role, cfg)
      ?? (m.adapter === 'cursor' ? new CursorAdapter(cfg.adapters.cursor) : m.adapter === 'claude-code' ? new ClaudeCodeAdapter(cfg.adapters.claude) : new CodexAdapter(cfg.adapters.codex));
    const dir = path.join(cfg.dataDir, 'probe', `${t.role}-${t.effort ?? m.effort}-${Date.now()}`);
    const spec: ModelTaskSpec = {
      taskId: `probe-${t.role}`,
      runId: 'probe',
      role: t.role,
      phase: 'probe',
      attempt: 1,
      model: m.model,
      effort: t.effort ?? m.effort,
      prompt: buildProbePrompt(schema),
      outputSchema: schema,
      cwd: path.join(dir, 'cwd'),
      logDir: dir,
      timeoutMs: cfg.timeoutsMinutes.probe * 60_000,
      sandbox: 'read_only',
      allowNetwork: false,
      allowWeb: false,
      gitRepo: false,
      resumeSessionId: null,
      context: { snapshotRef: null, constraintIds: [], criterionIds: [], knownQuestionIds: [], anonymousMap: null, recheckItems: null, spec: null, mockScenario: null },
    };
    const r = await adapter.run(spec, () => undefined, new AbortController().signal);
    if (r.meta.terminationWarning) recordUnconfirmedProcess(cfg.dataDir, `probe:${t.role}:live`, r.meta.terminationWarning);
    const raw = r.structured ?? extractJson(r.rawText);
    const v = r.status === 'succeeded' ? validateOutput('probe', raw, {}) : null;
    out.push({ role: t.role, model: m.model, effort: spec.effort, status: r.status, failure: r.failure, outputValid: !!v?.ok, meta: r.meta });
  }
  return out;
}
