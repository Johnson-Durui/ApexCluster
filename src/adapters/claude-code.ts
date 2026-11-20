/**
 * Claude Code 适配器：调用未经修改的官方 `claude` CLI（非交互 -p 模式），由用户自己登录订阅。
 * 工作台不读取、不保存、不转发任何凭证。
 *
 * 命令形如（提示词经 stdin）：
 *   claude -p --output-format stream-json --verbose --model claude-opus-5-5 --effort max
 *          --json-schema <严格 schema> --safe-mode --tools "WebSearch,WebFetch" --disallowedTools "mcp__*"
 *          --permission-mode dontAsk --permission-prompts none --settings <task>/claude-settings.json
 *
 * 依据（2026-10 核实，需在目标 Windows 上复测）：
 * - --effort 支持 low/medium/high/xhigh/max；Opus 5.5 默认 medium，必须显式传 max；
 *   不支持的档位会被“降到最高可用档位”，所以只能事后核对，不能假设生效。
 * - 旧版本 CLI 的 `opus` 别名会静默指向旧型号 → 只允许完整型号 ID（claude-opus-5-5）。
 * - 内容分类器触发时可能自动换到后备型号 → 设置 switchModelsOnFlag=false，-p 模式下改为拒答而不是换型号；
 *   同时用 result.modelUsage（服务端用量）核对实际型号。
 * - --bare 不读订阅登录，所以不用 --bare；用 --safe-mode 关闭 CLAUDE.md/hooks/MCP/插件等个人定制，保证两边独立、可复现。
 * - Windows 原生 Claude Code 不支持沙箱 → 无附件的设计任务只开放联网检索工具，不开放 Bash/编辑。
 * - 有本地参考资料时，用 --restricted 将文件工具限制到进程工作目录，并把进程工作目录切到专用
 *   `.workbench-references`；只开放 Read/Glob/Grep，以及按任务配置可选的 WebSearch/WebFetch。
 */
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TaskPhase } from '../core/schemas.js';
import { schemaToCompactString } from '../core/strict-json-schema.js';
import type { ExecutionMeta, FailureKind } from '../core/types.js';
import { describeCommand, resolveCommand, runProcess, runSimple, scrubEnv, type ResolvedCommand } from './process.js';
import {
  emptyMeta,
  FORBIDDEN_MODEL_ALIASES,
  modelReported,
  type AdapterProgress,
  type AdapterResult,
  type CommandOverride,
  type ModelAdapter,
  type ModelTaskSpec,
} from './types.js';

export interface ClaudeCodeOptions {
  command: CommandOverride | null;
  /** auto：可执行文件不是 .cmd/.bat 且 schema 足够短时使用 --json-schema */
  nativeSchema: 'auto' | 'always' | 'never';
  /** 指定阶段只在提示词中提供 schema，仍由工作台严格校验。 */
  promptOnlySchemaPhases: TaskPhase[];
  /** 隔离个人定制的参数，默认 ['--safe-mode'] */
  isolationArgs: string[];
  extraArgs: string[];
  /** 订阅模式下从子进程环境移除的变量（否则 -p 模式会优先用 API key 计费） */
  scrubEnvKeys: string[];
}

export const DEFAULT_CLAUDE_OPTIONS: ClaudeCodeOptions = {
  command: null,
  nativeSchema: 'auto',
  promptOnlySchemaPhases: [],
  isolationArgs: ['--safe-mode'],
  extraArgs: [],
  scrubEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL'],
};

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SCHEMA_ARG_BUDGET = 24_000;

export function useNativeSchema(cmd: ResolvedCommand, schemaText: string, mode: ClaudeCodeOptions['nativeSchema']): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  const viaCmd = cmd.via === 'cmd-fallback' || /\.(cmd|bat)$/i.test(cmd.file);
  return !viaCmd && schemaText.length <= SCHEMA_ARG_BUDGET;
}

export function buildClaudeArgs(spec: ModelTaskSpec, opts: ClaudeCodeOptions, settingsPath: string, schemaText: string | null): string[] {
  const isDoc = spec.phase === 'prd' || spec.phase === 'handbook' || spec.phase === 'devdoc';
  const hasReferences = !isDoc && spec.sandbox === 'read_only' && !!spec.referenceDirectory;
  const tools = isDoc
    ? ''
    : hasReferences
    ? ['Read', 'Glob', 'Grep', ...(spec.allowWeb ? ['WebSearch', 'WebFetch'] : [])].join(',')
    : spec.sandbox === 'read_only'
      ? spec.allowWeb
        ? 'WebSearch,WebFetch'
        : ''
      : 'default';
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    spec.model,
    '--effort',
    spec.effort,
  ];
  if (schemaText) args.push('--json-schema', schemaText);
  args.push(...opts.isolationArgs);
  if (hasReferences) args.push('--restricted', '--strict-mcp-config');
  args.push(
    '--tools',
    tools,
    '--disallowedTools',
    isDoc
      ? 'Bash,PowerShell,REPL,Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch,WebFetch,mcp__*'
      : hasReferences
        ? 'Bash,PowerShell,REPL,Edit,Write,NotebookEdit,mcp__*'
        : 'mcp__*',
  );
  args.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none');
  args.push('--settings', settingsPath);
  if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
  args.push(...opts.extraArgs);
  return args;
}

function referenceExecutionCwd(spec: ModelTaskSpec): { cwd: string; error: string | null } {
  if (spec.phase === 'prd' || spec.phase === 'handbook' || spec.phase === 'devdoc') return { cwd: spec.cwd, error: null };
  if (!spec.referenceDirectory) return { cwd: spec.cwd, error: null };
  if (spec.sandbox !== 'read_only') {
    return { cwd: spec.cwd, error: '参考资料目录只能用于只读设计任务。' };
  }
  if (!path.isAbsolute(spec.referenceDirectory)) {
    return { cwd: spec.cwd, error: '参考资料目录必须是绝对路径。' };
  }
  try {
    const base = realpathSync(spec.cwd);
    const reference = realpathSync(spec.referenceDirectory);
    if (!statSync(reference).isDirectory()) return { cwd: spec.cwd, error: '参考资料路径不是目录。' };
    const relative = path.relative(base, reference);
    if (relative.toLowerCase() !== '.workbench-references' && !(spec.phase === 'final_review' && relative === '')) {
      return { cwd: spec.cwd, error: '参考资料目录必须是任务工作目录下的 .workbench-references。' };
    }
    return { cwd: reference, error: null };
  } catch (error) {
    return { cwd: spec.cwd, error: `参考资料目录不可用：${error instanceof Error ? error.message : String(error)}` };
  }
}

interface ClaudeStreamState {
  sessionId: string | null;
  initModel: string | null;
  /** init 事件里的 claude_code_version */
  cliVersion: string | null;
  /** init 事件里的 apiKeySource：'none' 表示没有使用 API key（订阅登录） */
  apiKeySource: string | null;
  result: Record<string, unknown> | null;
  lastRetryError: string | null;
  lastAssistantText: string | null;
}

/** 处理一行 stream-json；返回给界面的进度（可为空） */
export function handleClaudeLine(line: string, st: ClaudeStreamState): AdapterProgress | null {
  const at = new Date().toISOString();
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line.trim() ? { at, kind: 'info', text: line.slice(0, 200) } : null;
  }
  const type = ev.type;
  if (type === 'system' && ev.subtype === 'init') {
    st.sessionId = (ev.session_id as string) ?? st.sessionId;
    st.initModel = (ev.model as string) ?? null;
    st.cliVersion = (ev.claude_code_version as string) ?? null;
    st.apiKeySource = (ev.apiKeySource as string) ?? null;
    return { at, kind: 'started', text: `会话已启动（客户端型号：${st.initModel ?? '未知'}；凭证来源：${st.apiKeySource ?? '未知'}）` };
  }
  if (type === 'system' && ev.subtype === 'api_retry') {
    st.lastRetryError = (ev.error as string) ?? null;
    return { at, kind: 'retry', text: `接口重试 #${ev.attempt}：${ev.error ?? ''}（HTTP ${ev.error_status ?? '无响应'}）` };
  }
  if (type === 'system' && ev.subtype === 'thinking_tokens') {
    const estimatedTokens = ev.estimated_tokens;
    return typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) && estimatedTokens >= 0
      ? { at, kind: 'info', text: `推理中（估计已生成 ${estimatedTokens} tokens，非最终用量）` }
      : null;
  }
  if (type === 'assistant') {
    const msg = ev.message as { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] } | undefined;
    for (const c of msg?.content ?? []) {
      if (c.type === 'tool_use') {
        const q = (c.input?.query ?? c.input?.url ?? '') as string;
        return { at, kind: 'tool', text: `调用 ${c.name}${q ? `：${String(q).slice(0, 120)}` : ''}` };
      }
      if (c.type === 'text' && c.text) {
        st.lastAssistantText = c.text;
        return { at, kind: 'message', text: '正在输出…' };
      }
    }
    return null;
  }
  if (type === 'result') {
    st.result = ev;
    st.sessionId = (ev.session_id as string) ?? st.sessionId;
    return { at, kind: 'info', text: `结束：${ev.subtype}${ev.is_error ? '（错误）' : ''}` };
  }
  return null;
}

export function classifyClaudeFailure(args: {
  spawnError: string | null;
  exitCode: number | null;
  stderr: string;
  result: Record<string, unknown> | null;
  lastRetryError: string | null;
}): { kind: FailureKind; message: string } {
  const { spawnError, exitCode, stderr, result, lastRetryError } = args;
  if (spawnError) {
    return /ENOENT|not found|cannot find/i.test(spawnError)
      ? { kind: 'not_installed', message: '找不到 claude 可执行文件。请在 Windows 上安装 Claude Code（官方安装脚本或 winget），或在配置中指定路径。' }
      : { kind: 'process_error', message: spawnError };
  }
  const resultText = typeof result?.result === 'string' ? (result.result as string) : '';
  const all = `${resultText}\n${stderr}`;
  if (/unknown option|unrecognized|invalid option|error: unknown/i.test(stderr)) {
    return { kind: 'process_error', message: `CLI 不认识某个参数，可能版本过旧（需要 ≥ 2.1.280）：${stderr.trim().slice(0, 300)}` };
  }
  if (lastRetryError === 'authentication_failed' || lastRetryError === 'oauth_org_not_allowed' || /not logged in|please run \/login|login expired|invalid api key/i.test(all)) {
    return { kind: 'not_logged_in', message: '未登录或登录已过期：请在终端运行 claude 并完成登录（工作台不代为登录）。' };
  }
  if (lastRetryError === 'billing_error' || lastRetryError === 'account_on_hold') {
    return { kind: 'auth_failed', message: `账号或订阅状态异常：${lastRetryError}` };
  }
  if (lastRetryError === 'model_not_found' || /model.{0,40}(not found|not available|unavailable|invalid|does not exist)/i.test(all)) {
    return { kind: 'model_unavailable', message: `请求的型号不可用：${resultText.slice(0, 300) || lastRetryError}` };
  }
  if (lastRetryError === 'rate_limit' || /rate limit|usage limit|limit reached|hit your limit|weekly limit|session limit|resets \d/i.test(all)) {
    return { kind: 'rate_limited', message: `触发了用量或速率限制（Claude Pro 的 5 小时额度与 Claude 应用共用）。CLI 提示：${(resultText || stderr).trim().slice(0, 300) || lastRetryError}` };
  }
  if (result?.subtype === 'error_max_structured_output_retries') {
    return { kind: 'invalid_output', message: 'CLI 多次尝试后仍未产生符合 schema 的输出（也可能是型号回退撤回了输出）。' };
  }
  if (/refus/i.test(resultText) || result?.stop_reason === 'refusal') {
    return { kind: 'refusal', message: '模型拒绝了该请求（可能触发了安全分类器；已禁止自动换型号）。' };
  }
  if (!result) return { kind: 'process_error', message: `没有收到 result 事件（退出码 ${exitCode}）：${stderr.trim().slice(0, 300)}` };
  return { kind: 'unknown', message: resultText.slice(0, 500) || `退出码 ${exitCode}` };
}

export class ClaudeCodeAdapter implements ModelAdapter {
  readonly kind = 'claude-code' as const;
  constructor(private readonly opts: ClaudeCodeOptions = DEFAULT_CLAUDE_OPTIONS) {}

  resolve(): ResolvedCommand | null {
    return resolveCommand('claude', { override: this.opts.command });
  }

  async version(): Promise<string | null> {
    const cmd = this.resolve();
    if (!cmd) return null;
    const r = await runSimple(cmd, ['--version'], { timeoutMs: 20_000 });
    return r.exitCode === 0 ? r.stdoutTail.trim().split('\n')[0] ?? null : null;
  }

  async run(spec: ModelTaskSpec, onProgress: (p: AdapterProgress) => void, signal: AbortSignal): Promise<AdapterResult> {
    const startedAt = new Date().toISOString();
    const meta: ExecutionMeta = emptyMeta('claude-code', spec, startedAt);
    const fail = (kind: FailureKind, message: string): AdapterResult => ({
      status: 'failed',
      failure: { kind, message },
      rawText: null,
      structured: null,
      meta: { ...meta, endedAt: new Date().toISOString() },
      toolLog: [],
      simulated: false,
    });

    if (FORBIDDEN_MODEL_ALIASES.includes(spec.model.toLowerCase())) {
      return fail('model_unavailable', `不允许使用会静默变化的别名「${spec.model}」，请填写完整型号 ID（例如 claude-opus-5-5）。`);
    }
    if (!CLAUDE_EFFORTS.has(spec.effort)) {
      return fail('effort_unsupported', `Claude Code 不支持强度「${spec.effort}」（可用：low/medium/high/xhigh/max）。不会自动降级，请显式选择。`);
    }
    const cmd = this.resolve();
    if (!cmd) return fail('not_installed', '找不到 claude 可执行文件。请安装 Claude Code 或在配置 adapters.claude.command 中指定路径。');

    mkdirSync(spec.logDir, { recursive: true });
    mkdirSync(spec.cwd, { recursive: true });
    const execution = referenceExecutionCwd(spec);
    if (execution.error) return fail('process_error', execution.error);
    meta.cwd = execution.cwd;
    const settingsPath = path.join(spec.logDir, 'claude-settings.json');
    writeFileSync(settingsPath, JSON.stringify({ switchModelsOnFlag: false }), 'utf8');
    const schemaText = schemaToCompactString(spec.outputSchema);
    writeFileSync(path.join(spec.logDir, 'output-schema.json'), schemaText, 'utf8');
    const native = !(this.opts.promptOnlySchemaPhases ?? []).includes(spec.phase) && useNativeSchema(cmd, schemaText, this.opts.nativeSchema);
    const args = buildClaudeArgs(spec, this.opts, settingsPath, native ? schemaText : null);
    const { env, removed } = scrubEnv({ ...process.env, NO_COLOR: '1' }, this.opts.scrubEnvKeys);
    meta.command = describeCommand(cmd, args).map((a) => (a === schemaText ? '<output-schema.json>' : a));
    meta.nativeSchema = native;
    meta.scrubbedEnv = removed;
    if (removed.length) meta.warnings.push(`已从子进程环境移除：${removed.join(', ')}（订阅模式，防止改用 API 计费）`);

    const st: ClaudeStreamState = { sessionId: null, initModel: null, cliVersion: null, apiKeySource: null, result: null, lastRetryError: null, lastAssistantText: null };
    const r = await runProcess(cmd, args, {
      cwd: execution.cwd,
      env,
      stdinText: spec.prompt,
      timeoutMs: spec.timeoutMs,
      signal,
      stdoutLogPath: path.join(spec.logDir, 'stdout.jsonl'),
      stderrLogPath: path.join(spec.logDir, 'stderr.log'),
      onStarted: (pid) => {
        meta.processStarted = true;
        onProgress({ at: new Date().toISOString(), kind: 'started', text: `Claude Code 子进程已启动（PID ${pid}）` });
      },
      onStdoutLine: (line) => {
        const p = handleClaudeLine(line, st);
        if (p) onProgress(p);
      },
      onStderrLine: (line) => {
        if (line.trim()) onProgress({ at: new Date().toISOString(), kind: 'stderr', text: line.slice(0, 300) });
      },
    });

    const endedAt = new Date().toISOString();
    const res = st.result;
    const modelUsage = (res?.modelUsage ?? null) as Record<string, Record<string, number>> | null;
    const reported = modelUsage ? Object.keys(modelUsage) : st.initModel ? [st.initModel] : [];
    const usage = (res?.usage ?? null) as Record<string, number> | null;
    const finalMeta: ExecutionMeta = {
      ...meta,
      processStarted: r.pid !== null,
      cliVersion: st.cliVersion,
      sessionId: st.sessionId,
      exitCode: r.exitCode,
      endedAt,
      durationMs: r.durationMs,
      reportedModels: reported,
      reportedModelSource: modelUsage ? 'server_usage' : st.initModel ? 'init_event' : null,
      modelConfirmed: !!modelUsage && modelReported(spec.model, reported),
      usage: usage && typeof usage === 'object' ? Object.fromEntries(Object.entries(usage).filter(([, v]) => typeof v === 'number')) : null,
      costUsd: typeof res?.total_cost_usd === 'number' ? (res.total_cost_usd as number) : null,
    };
    if (r.terminationWarning) { finalMeta.terminationWarning = r.terminationWarning; finalMeta.warnings.push(r.terminationWarning); }
    if (modelUsage && reported.length > 1) finalMeta.warnings.push(`本次调用涉及多个型号：${reported.join(', ')}（辅助任务可能使用其他型号）`);
    if (st.apiKeySource && st.apiKeySource !== 'none') {
      finalMeta.warnings.push(`Claude Code 报告的凭证来源是「${st.apiKeySource}」，不是订阅登录，可能按 API 计费`);
    }

    if (r.cancelled) return { status: 'cancelled', failure: { kind: 'cancelled', message: '已取消' }, rawText: null, structured: null, meta: finalMeta, toolLog: [], simulated: false };
    if (r.timedOut) return { status: 'timed_out', failure: { kind: 'timeout', message: `超过 ${Math.round(spec.timeoutMs / 60000)} 分钟未完成` }, rawText: null, structured: null, meta: finalMeta, toolLog: [], simulated: false };

    const ok = r.exitCode === 0 && res && res.subtype === 'success' && !res.is_error;
    if (!ok) {
      const f = classifyClaudeFailure({ spawnError: r.spawnError, exitCode: r.exitCode, stderr: r.stderrTail, result: res, lastRetryError: st.lastRetryError });
      return { status: 'failed', failure: f, rawText: typeof res?.result === 'string' ? (res.result as string) : null, structured: null, meta: finalMeta, toolLog: [], simulated: false };
    }
    const rawText = typeof res.result === 'string' ? (res.result as string) : st.lastAssistantText;
    writeFileSync(path.join(spec.logDir, 'final-message.txt'), rawText ?? '', 'utf8');
    return { status: 'succeeded', failure: null, rawText, structured: res.structured_output ?? null, meta: finalMeta, toolLog: [], simulated: false };
  }
}
