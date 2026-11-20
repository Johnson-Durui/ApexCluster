/**
 * Cursor CLI read-only adapter.
 *
 * This integration is deliberately capability-closed. A trusted H7 probe must
 * first establish that the installed CLI consumes stdin as the prompt and that
 * its read-only permissions are effective. The adapter never installs, logs in,
 * retries, changes model, or enables a write-capable invocation.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionMeta, FailureKind } from '../core/types.js';
import type { ToolLogItem } from '../core/verify-mvp.js';
import { describeCommand, resolveCommand, runProcess, runSimple, scrubEnv, type ResolvedCommand, type RunProcessResult } from './process.js';
import { emptyMeta, type AdapterProgress, type AdapterResult, type CommandOverride, type ModelAdapter, type ModelTaskSpec } from './types.js';

export interface CursorCapabilities {
  verifiedAt: string | null;
  cliVersion: string | null;
  /** 请求 ID；生产配置冻结为 grok-4.7-high-fast。 */
  model: string | null;
  /** Cursor system/init 实际回报的显示名；旧记录缺失时必须失效。 */
  reportedModel?: string | null;
  /** 当前只允许经过 H7 证明的全工具拒绝策略；旧记录缺失时必须失效。 */
  toolPolicy?: 'deny_all' | null;
  /** H7 绑定的解析后入口；旧记录缺失时必须失效。 */
  commandBinding?: { file: string; prefixArgs: string[] } | null;
  stdinPromptVerified: boolean;
  readOnlyToolsVerified: boolean;
  commandExitEventsVerified: boolean;
  fileChangesVerified: boolean;
}

export interface CursorOptions {
  command: CommandOverride | null;
  /** Reserved for a future, separately verified CLI surface. Currently must be empty. */
  extraArgs: string[];
  scrubEnvKeys: string[];
  capabilities: CursorCapabilities | null;
  /** Tests may shorten only the non-inference version check. */
  versionTimeoutMs?: number;
}

export const DEFAULT_CURSOR_OPTIONS: CursorOptions = {
  command: null,
  extraArgs: [],
  scrubEnvKeys: ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'],
  capabilities: null,
};

/** 优先使用专名；通用 agent 仍只是候选，不能据命令名确认提供方。 */
export function resolveCursorCommand(command: CommandOverride | null, env: NodeJS.ProcessEnv = process.env): ResolvedCommand | null {
  if (command) return resolveCommand('agent', { override: command, env });
  return resolveCommand('cursor-agent', { env }) ?? resolveCommand('agent', { env });
}

/** 本机已观测到 Grok Build 占用 agent.exe；它不是 Cursor 的同型号入口。 */
export function cursorExecutableMismatch(version: string): string | null {
  return /^grok(?:\s|$)/i.test(version.trim())
    ? `检测到 Grok Build CLI（${version}），并非 Cursor Agent；请配置已验证的 Cursor Agent 可执行文件`
    : null;
}

const READ_ONLY_PHASES = new Set<string>(['digest', 'qgroup', 'probe']);
const GROK_MODEL = 'grok-4.7-high-fast';
const GROK_EFFORT = 'high';
const TOOL_KEYS = new Map([
  ['readToolCall', 'read'],
  ['editToolCall', 'edit'],
  ['writeToolCall', 'write'],
  ['shellToolCall', 'shell'],
  ['webFetchToolCall', 'web'],
  ['mcpToolCall', 'mcp'],
]);

export function cursorInvocationDirectory(spec: ModelTaskSpec): string {
  return path.join(spec.logDir, 'cursor-workspace');
}

export function cursorProfileDirectory(spec: ModelTaskSpec): string {
  return path.join(spec.logDir, 'cursor-profile-');
}

function validCursorCommandBinding(binding: CursorCapabilities['commandBinding']): binding is NonNullable<CursorCapabilities['commandBinding']> {
  if (!binding || !path.isAbsolute(binding.file) || !Array.isArray(binding.prefixArgs)) return false;
  if (binding.prefixArgs.length === 0) return true;
  if (binding.prefixArgs.length !== 1) return false;
  const entry = binding.prefixArgs[0];
  if (!entry || entry.startsWith('-') || !path.isAbsolute(entry)) return false;
  return path.basename(entry).toLowerCase() === 'index.js' || path.extname(entry).toLowerCase() === '.mjs';
}

/** 只接受 H7 精确绑定的解析后入口；任何附加选项或子命令都会静态关闭。 */
export function cursorCommandBindingMatches(command: ResolvedCommand | null, capabilities: CursorCapabilities | null): boolean {
  const binding = capabilities?.commandBinding;
  if (!command || !validCursorCommandBinding(binding) || !path.isAbsolute(command.file)) return false;
  if (command.file !== binding.file || command.prefixArgs.length !== binding.prefixArgs.length) return false;
  return command.prefixArgs.every((arg, index) => arg === binding.prefixArgs[index]);
}

export function buildCursorArgs(spec: ModelTaskSpec, opts: CursorOptions, workspace = cursorInvocationDirectory(spec)): string[] {
  if (opts.extraArgs.length) {
    throw new Error('Cursor extraArgs 尚未经 H7 验证；不允许覆盖权限、凭证、型号或工作区参数');
  }
  return ['--print', '--output-format', 'stream-json', '--mode', 'ask', '--trust', '--model', spec.model, '--workspace', workspace];
}

export interface CursorStreamState {
  sessionId: string | null;
  initSessionId: string | null;
  initModel: string | null;
  initCwd: string | null;
  result: { subtype: string | null; result: string | null; durationMs: number | null; sessionId: string | null; isError: boolean | null } | null;
  usage: Record<string, number> | null;
  invalidUsage: boolean;
  errors: string[];
  violations: string[];
  toolLog: ToolLogItem[];
  seq: number;
  readRoot: string | null;
  initCount: number;
  resultCount: number;
}

export function newCursorState(readRoot: string | null = null): CursorStreamState {
  return { sessionId: null, initSessionId: null, initModel: null, initCwd: null, result: null, usage: null, invalidUsage: false, errors: [], violations: [], toolLog: [], seq: 0, readRoot, initCount: 0, resultCount: 0 };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function findToolKind(toolCall: Record<string, unknown>): { key: string; value: Record<string, unknown> | null } | null {
  for (const key of TOOL_KEYS.keys()) {
    if (key in toolCall) return { key, value: objectValue(toolCall[key]) };
  }
  return null;
}

function toolPath(call: Record<string, unknown> | null): string[] {
  const args = objectValue(call?.args);
  const candidate = stringValue(args?.path) ?? stringValue(args?.filePath) ?? stringValue(args?.file_path);
  return candidate ? [candidate] : [];
}

function validateInitCwd(candidate: string | null, root: string | null): string | null {
  if (!candidate) return 'init_cwd_missing';
  if (!root) return 'controlled_cwd_unknown';
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    return realCandidate === realRoot ? null : 'init_cwd_mismatch';
  } catch {
    return 'init_cwd_unverified';
  }
}

function parseUsage(value: unknown): Record<string, number> | null {
  const usage = objectValue(value);
  if (!usage) return null;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
  const parsed: Record<string, number> = {};
  for (const key of keys) {
    const amount = usage[key];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
    parsed[key] = amount;
  }
  return parsed;
}

export function handleCursorLine(line: string, st: CursorStreamState): AdapterProgress | null {
  const at = new Date().toISOString();
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    const obj = objectValue(parsed);
    if (!obj) return line.trim() ? { at, kind: 'info', text: '收到未识别的 Cursor 输出' } : null;
    event = obj;
  } catch {
    return line.trim() ? { at, kind: 'info', text: line.slice(0, 200) } : null;
  }

  const type = stringValue(event.type);
  const subtype = stringValue(event.subtype);
  if (type === 'system' && subtype === 'init') {
    st.initCount += 1;
    if (st.initCount > 1) st.violations.push('duplicate_init');
    const sessionId = stringValue(event.session_id);
    if (st.result?.sessionId && sessionId && st.result.sessionId !== sessionId) st.violations.push('session_mismatch');
    if (st.initCount === 1) {
      st.sessionId = sessionId;
      st.initSessionId = sessionId;
      st.initModel = stringValue(event.model);
      st.initCwd = stringValue(event.cwd);
      const cwdViolation = validateInitCwd(st.initCwd, st.readRoot);
      if (cwdViolation) st.violations.push(cwdViolation);
    }
    return { at, kind: 'started', text: `Cursor 会话已初始化（${st.sessionId ?? '无编号'}）` };
  }
  if (type === 'result') {
    st.resultCount += 1;
    if (st.resultCount > 1) st.violations.push('duplicate_result');
    const nextResult = {
      subtype,
      result: stringValue(event.result),
      durationMs: typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms) ? event.duration_ms : null,
      sessionId: stringValue(event.session_id),
      isError: typeof event.is_error === 'boolean' ? event.is_error : null,
    };
    if (subtype === 'success' && nextResult.isError !== false) st.violations.push('result_success_is_error_not_false');
    if ('usage' in event) {
      const usage = parseUsage(event.usage);
      if (usage) st.usage = usage;
      else st.invalidUsage = true;
    }
    if (st.sessionId && nextResult.sessionId && st.sessionId !== nextResult.sessionId) st.violations.push('session_mismatch');
    if (st.resultCount === 1) st.result = nextResult;
    if (!st.sessionId && nextResult.sessionId) st.sessionId = nextResult.sessionId;
    if (subtype !== 'success') st.errors.push(stringValue(event.error) ?? stringValue(event.result) ?? `Cursor result/${subtype ?? 'unknown'}`);
    return { at, kind: subtype === 'success' ? 'message' : 'info', text: subtype === 'success' ? 'Cursor 输出完成' : `Cursor 失败：${st.errors.at(-1)}` };
  }
  if (type === 'tool_call') {
    const toolCall = objectValue(event.tool_call);
    const found = toolCall ? findToolKind(toolCall) : null;
    const label = found ? (TOOL_KEYS.get(found.key) ?? found.key) : 'unknown_tool';
    const violation = `tool_call:${label}`;
    if (!st.violations.includes(violation)) st.violations.push(violation);
    if (!found) return { at, kind: 'tool', text: 'Cursor 触发了无法识别的工具调用' };
    const done = subtype === 'completed';
    if (done) {
      st.toolLog.push({
        seq: st.seq++,
        type: found.key === 'writeToolCall' ? 'file_change' : found.key === 'shellToolCall' ? 'command_execution' : 'other',
        command: null,
        exitCode: null,
        output: null,
        status: subtype,
        paths: toolPath(found.value),
      });
      return { at, kind: 'tool', text: `Cursor 触发了禁止的 ${label} 工具` };
    }
    return { at, kind: 'tool', text: `Cursor 正在尝试禁止的 ${label} 工具` };
  }
  return null;
}

function capabilityError(spec: ModelTaskSpec, capabilities: CursorCapabilities | null): string | null {
  if (!READ_ONLY_PHASES.has(spec.phase)) return `Cursor 当前只允许 digest/qgroup/probe 只读任务，收到 ${spec.phase}`;
  if (spec.sandbox !== 'read_only') return 'Cursor 写入模式尚未经 H7 验证';
  if (!capabilities) return '缺少受信任的 Cursor H7 能力记录';
  if (!capabilities.verifiedAt || !Number.isFinite(Date.parse(capabilities.verifiedAt))) return 'Cursor H7 能力记录没有有效 verifiedAt';
  if (!capabilities.cliVersion) return 'Cursor H7 能力记录缺少 cliVersion';
  if (spec.model !== GROK_MODEL) return `Cursor 当前只冻结允许型号 ${GROK_MODEL}`;
  if (!capabilities.model || capabilities.model !== spec.model) return `Cursor H7 未验证请求型号 ${spec.model}`;
  if (!capabilities.reportedModel || !capabilities.reportedModel.trim()) return 'Cursor H7 能力记录缺少 system/init 精确显示名';
  if (capabilities.toolPolicy !== 'deny_all') return 'Cursor H7 能力记录缺少 deny_all 工具策略';
  if (!validCursorCommandBinding(capabilities.commandBinding)) return 'Cursor H7 能力记录缺少有效的绝对命令绑定';
  if (spec.effort !== GROK_EFFORT) return `Cursor ${GROK_MODEL} 当前只冻结 effort=${GROK_EFFORT}，收到 ${spec.effort}`;
  if (!capabilities.stdinPromptVerified) return 'Cursor H7 未证明 stdin 内容会被当作 prompt';
  if (!capabilities.readOnlyToolsVerified) return 'Cursor H7 未证明只读权限与任务目录边界有效';
  return null;
}

function classifyCursorFailure(args: { spawnError: string | null; exitCode: number | null; stderr: string; errors: string[] }): { kind: FailureKind; message: string } {
  const { spawnError, exitCode, stderr, errors } = args;
  if (spawnError) {
    return /ENOENT|not found|cannot find/i.test(spawnError)
      ? { kind: 'not_installed', message: '找不到 Cursor agent 可执行文件。工作台不代为安装。' }
      : { kind: 'process_error', message: spawnError };
  }
  const all = [stderr, ...errors].join('\n');
  if (/not logged in|please (log ?in|sign in)|login required/i.test(all)) return { kind: 'not_logged_in', message: `Cursor 未登录或登录失效：${all.trim().slice(0, 300)}` };
  if (/401|403|unauthorized|authentication|invalid api key/i.test(all)) return { kind: 'auth_failed', message: `Cursor 认证失败：${all.trim().slice(0, 300)}` };
  if (/model[^\n]{0,80}(not found|does not exist|not supported|unavailable|not available|no access)|unknown model|model_not_found/i.test(all)) {
    return { kind: 'model_unavailable', message: `Cursor 账号或工作区不可用请求型号：${all.trim().slice(0, 300)}` };
  }
  if (/429|rate limit|usage limit|quota|too many requests|limit reached/i.test(all)) return { kind: 'rate_limited', message: `Cursor 用量或速率受限：${all.trim().slice(0, 300)}` };
  return {
    kind: exitCode === 0 ? 'unknown' : 'process_error',
    message: errors.at(-1) ?? (stderr.trim().slice(0, 300) || `Cursor 退出码 ${exitCode}`),
  };
}

function cursorPermissions(): object {
  return {
    permissions: {
      allow: [],
      deny: ['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)'],
    },
  };
}

function cursorProfile(): object {
  return {
    version: 1,
    editor: { vimMode: false },
    autoAcceptWebSearch: false,
    ...cursorPermissions(),
  };
}

function ensureExactConfig(file: string, value: object): void {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(file, expected, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' && readFileSync(file, 'utf8') === expected) return;
    throw error;
  }
}

interface CursorProfileHandle {
  directory: string;
  realLogDirectory: string;
}

function createCursorProfile(spec: ModelTaskSpec): CursorProfileHandle {
  mkdirSync(spec.logDir, { recursive: true });
  const realLogDirectory = realpathSync(spec.logDir);
  ensureExactConfig(path.join(spec.logDir, 'cursor-policy.json'), cursorProfile());
  const directory = mkdtempSync(cursorProfileDirectory(spec));
  try {
    ensureExactConfig(path.join(directory, 'cli-config.json'), cursorProfile());
  } catch (error) {
    const cleanupWarning = cleanupCursorProfile({ directory, realLogDirectory });
    if (cleanupWarning) throw new Error(`${(error as Error).message}; ${cleanupWarning}`);
    throw error;
  }
  return { directory, realLogDirectory };
}

function cleanupCursorProfile(handle: CursorProfileHandle): string | null {
  try {
    if (!path.isAbsolute(handle.directory)) return 'Cursor 临时 profile 路径不是绝对路径，已保留供人工检查';
    const info = lstatSync(handle.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return 'Cursor 临时 profile 类型异常，已保留供人工检查';
    const realDirectory = realpathSync(handle.directory);
    if (path.dirname(realDirectory) !== handle.realLogDirectory || !path.basename(realDirectory).startsWith('cursor-profile-')) {
      return 'Cursor 临时 profile 已越出任务日志目录，拒绝清理';
    }
    rmSync(realDirectory, { recursive: true, force: false });
    return null;
  } catch (error) {
    return `Cursor 临时 profile 无法安全清理：${(error as Error).message}`;
  }
}

export function recordCursorVersionLifecycle(meta: ExecutionMeta, result: Pick<RunProcessResult, 'durationMs' | 'terminationWarning'>): void {
  meta.durationMs = result.durationMs;
  meta.endedAt = new Date().toISOString();
  if (result.terminationWarning) {
    meta.terminationWarning = result.terminationWarning;
    meta.warnings.push(result.terminationWarning);
  }
}

export class CursorAdapter implements ModelAdapter {
  readonly kind = 'cursor' as const;
  constructor(private readonly opts: CursorOptions = DEFAULT_CURSOR_OPTIONS) {}

  resolve(): ResolvedCommand | null {
    return resolveCursorCommand(this.opts.command);
  }

  async run(spec: ModelTaskSpec, onProgress: (progress: AdapterProgress) => void, signal: AbortSignal): Promise<AdapterResult> {
    const startedAt = new Date().toISOString();
    const meta: ExecutionMeta = emptyMeta('cursor', spec, startedAt);
    const fail = (kind: FailureKind, message: string): AdapterResult => ({
      status: 'failed', failure: { kind, message }, rawText: null, structured: null,
      meta: { ...meta, endedAt: new Date().toISOString() }, toolLog: [], simulated: false,
    });

    const blocked = capabilityError(spec, this.opts.capabilities);
    if (blocked) return fail((spec.model !== GROK_MODEL || (this.opts.capabilities?.model && this.opts.capabilities.model !== spec.model)) ? 'model_unavailable' : 'unknown', blocked);
    if (this.opts.extraArgs.length) return fail('unknown', 'Cursor extraArgs 未经 H7 验证，本次不启动推理');

    const command = this.resolve();
    if (!command) return fail('not_installed', '找不到 Cursor agent 可执行文件。工作台不代为安装或登录。');
    if (!cursorCommandBindingMatches(command, this.opts.capabilities)) {
      return fail('unknown', 'Cursor 解析后命令与 H7 绝对绑定不一致，本次不查询版本或启动推理');
    }
    const scrubKeys = [...new Set(['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT', ...this.opts.scrubEnvKeys])];
    const { env: scrubbedEnv, removed } = scrubEnv({ ...process.env, NO_COLOR: '1' }, scrubKeys);
    meta.scrubbedEnv = removed;
    if (removed.length) meta.warnings.push(`已从 Cursor 子进程环境移除：${removed.join(', ')}`);
    const invocationDir = cursorInvocationDirectory(spec);
    mkdirSync(invocationDir, { recursive: true });
    meta.cwd = invocationDir;
    let profile: CursorProfileHandle;
    try {
      profile = createCursorProfile(spec);
    } catch (error) {
      return fail('unknown', `Cursor 临时受控 profile 无法安全创建：${(error as Error).message}`);
    }
    const env = { ...scrubbedEnv, CURSOR_CONFIG_DIR: profile.directory };
    let completed: AdapterResult | null = null;
    const finish = (result: AdapterResult): AdapterResult => {
      completed = result;
      return result;
    };
    let versionAttempted = false;
    let versionSettled = false;
    let versionTerminationWarning: string | null = null;
    let inferenceAttempted = false;
    let inferenceSettled = false;
    let inferenceTerminationWarning: string | null = null;
    try {
      versionAttempted = true;
      const versionResult = await runSimple(command, ['--version'], { cwd: invocationDir, env, timeoutMs: this.opts.versionTimeoutMs ?? 20_000, signal });
      versionSettled = true;
      versionTerminationWarning = versionResult.terminationWarning ?? null;
      recordCursorVersionLifecycle(meta, versionResult);
      if (versionResult.spawnError) return finish(fail(/ENOENT|not found|cannot find/i.test(versionResult.spawnError) ? 'not_installed' : 'process_error', versionResult.spawnError));
      if (versionResult.cancelled) return finish({ ...fail('cancelled', '已取消'), status: 'cancelled' });
      if (versionResult.timedOut) return finish({ ...fail('timeout', 'Cursor --version 超时'), status: 'timed_out' });
      if (versionResult.terminationWarning) {
        return finish(fail('process_error', `Cursor 版本进程树终止状态未确认：${versionResult.terminationWarning}`));
      }
      const actualVersion = versionResult.stdoutTail.trim().split(/\r?\n/)[0] ?? '';
      meta.cliVersion = actualVersion || null;
      if (versionResult.exitCode !== 0 || !actualVersion) return finish(fail('unknown', '无法确认 Cursor CLI 版本，本次不启动推理'));
      const executableMismatch = cursorExecutableMismatch(actualVersion);
      if (executableMismatch) return finish(fail('not_installed', executableMismatch));
      if (actualVersion !== this.opts.capabilities!.cliVersion) {
        return finish(fail('unknown', `Cursor CLI 版本已变化：H7=${this.opts.capabilities!.cliVersion}，当前=${actualVersion}`));
      }

      const cursorDir = path.join(invocationDir, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      try {
        ensureExactConfig(path.join(cursorDir, 'cli.json'), cursorPermissions());
      } catch (error) {
        return finish(fail('unknown', `Cursor 受控工作目录已有权限配置或无法安全创建：${(error as Error).message}`));
      }

      const args = buildCursorArgs(spec, this.opts, invocationDir);
      meta.command = describeCommand(command, args);

      const state = newCursorState(invocationDir);
      const policyAbort = new AbortController();
      const processSignal = AbortSignal.any([signal, policyAbort.signal]);
      inferenceAttempted = true;
      const result = await runProcess(command, args, {
        cwd: invocationDir,
        env,
        stdinText: spec.prompt,
        timeoutMs: spec.timeoutMs,
        signal: processSignal,
        stdoutLogPath: path.join(spec.logDir, 'events.jsonl'),
        stderrLogPath: path.join(spec.logDir, 'stderr.log'),
        onStarted: (pid) => {
          meta.processStarted = true;
          onProgress({ at: new Date().toISOString(), kind: 'started', text: `Cursor 子进程已启动（PID ${pid}）` });
        },
        onStdoutLine: (line) => {
          const previousViolationCount = state.violations.length;
          const progress = handleCursorLine(line, state);
          if (progress) onProgress(progress);
          if (state.violations.slice(previousViolationCount).some((violation) => violation.startsWith('tool_call:'))) policyAbort.abort();
        },
        onStderrLine: (line) => {
          if (line.trim()) onProgress({ at: new Date().toISOString(), kind: 'stderr', text: line.slice(0, 300) });
        },
      });
      inferenceSettled = true;
      inferenceTerminationWarning = result.terminationWarning ?? null;

      const finalMeta: ExecutionMeta = {
        ...meta,
        processStarted: result.pid !== null,
        exitCode: result.exitCode,
        endedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        sessionId: state.sessionId,
        reportedModels: state.initModel ? [state.initModel] : [],
        reportedModelSource: state.initModel ? 'init_event' : null,
        modelConfirmed: false,
        reportedEffort: null,
        effortConfirmed: false,
        usage: state.usage,
        costUsd: null,
        nativeSchema: false,
      };
      if (result.terminationWarning) {
        finalMeta.terminationWarning = result.terminationWarning;
        finalMeta.warnings.push(result.terminationWarning);
      }
      if (state.initModel) finalMeta.warnings.push('Cursor init 事件的型号不是服务端用量确认，仍记为未确认');
      if (state.invalidUsage) finalMeta.warnings.push('Cursor result usage 不是四项完整的非负有限数值，已保守记为 null');

      const base = { rawText: state.result?.result ?? null, structured: null, meta: finalMeta, toolLog: state.toolLog, simulated: false } as const;
      if (state.violations.length) {
        return finish({ ...base, status: 'failed', failure: { kind: 'process_error', message: `Cursor 事件流违反只读契约：${state.violations.join(', ')}` } });
      }
      if (result.cancelled) return finish({ ...base, status: 'cancelled', failure: { kind: 'cancelled', message: '已取消' } });
      if (result.timedOut) return finish({ ...base, status: 'timed_out', failure: { kind: 'timeout', message: `超过 ${Math.round(spec.timeoutMs / 60000)} 分钟未完成` } });
      if (result.terminationWarning) {
        return finish({ ...base, status: 'failed', failure: { kind: 'process_error', message: `Cursor 推理进程树终止状态未确认：${result.terminationWarning}` } });
      }
      if (result.exitCode !== 0) {
        const failure = classifyCursorFailure({ spawnError: result.spawnError, exitCode: result.exitCode, stderr: result.stderrTail, errors: state.errors });
        return finish({ ...base, status: 'failed', failure });
      }
      if (state.initModel && state.initModel !== this.opts.capabilities!.reportedModel) {
        return finish({ ...base, status: 'failed', failure: { kind: 'model_mismatch', message: `Cursor init 事件显示名 ${state.initModel} 与 H7 记录 ${this.opts.capabilities!.reportedModel} 不一致` } });
      }
      if (!state.initModel) return finish({ ...base, status: 'failed', failure: { kind: 'unknown', message: 'Cursor 事件流缺少 system/init 型号记录' } });
      if (!state.result) return finish({ ...base, status: 'failed', failure: { kind: 'unknown', message: 'Cursor 事件流没有 terminal result' } });
      if (!state.initSessionId || !state.result.sessionId) return finish({ ...base, status: 'failed', failure: { kind: 'unknown', message: 'Cursor init/result 缺少可核对的 session_id' } });
      if (state.result.subtype !== 'success') {
        const failure = classifyCursorFailure({ spawnError: result.spawnError, exitCode: result.exitCode, stderr: result.stderrTail, errors: state.errors });
        return finish({ ...base, status: 'failed', failure });
      }
      if (state.result.isError !== false) {
        return finish({ ...base, status: 'failed', failure: { kind: 'unknown', message: 'Cursor result/success 的 is_error 必须严格为 false' } });
      }
      if (state.result.result === null) {
        return finish({ ...base, status: 'failed', failure: { kind: 'unknown', message: 'Cursor result/success 缺少 result 文本' } });
      }
      return finish({ ...base, status: 'succeeded', failure: null });
    } catch (error) {
      return finish(fail('process_error', `Cursor 调用异常：${(error as Error).message}`));
    } finally {
      const versionSafe = !versionAttempted || (versionSettled && !versionTerminationWarning);
      const inferenceSafe = !inferenceAttempted || (inferenceSettled && !inferenceTerminationWarning);
      const warning = versionSafe && inferenceSafe
        ? cleanupCursorProfile(profile)
        : 'Cursor 子进程树终止状态未确认，临时 profile 已保留并阻止静默复用';
      if (warning) {
        const completedResult = completed as AdapterResult | null;
        const targetMeta = completedResult?.meta ?? meta;
        targetMeta.warnings.push(warning);
        targetMeta.terminationWarning ??= warning;
      }
    }
  }
}
