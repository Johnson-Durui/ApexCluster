/**
 * Codex 适配器：调用官方 `codex exec`（非交互），使用用户自己在 Codex CLI 中完成的 ChatGPT 登录。
 *
 * 命令形如（提示词经 stdin，末尾的 "-" 表示从 stdin 读取）：
 *   codex [--search] exec --json -m gpt-6.2-astra -c model_reasoning_effort=max --sandbox read-only
 *         --skip-git-repo-check --output-schema <schema.json> -o <final-message.txt> -
 * 修复输出时续接会话：
 *   codex exec --json ... resume <thread_id> -
 *
 * 依据（2026-10 核实，需在目标 Windows 上复测）：
 * - --json 输出 JSONL 事件：thread.started{thread_id} / turn.started / item.started|updated|completed{item}
 *   / turn.completed{usage} / turn.failed{error} / error{message}
 * - item 类型：agent_message{text}、reasoning{text}、command_execution{command,aggregated_output,exit_code,status}、
 *   file_change{changes[{path,kind}],status}、mcp_tool_call、web_search{query}、todo_list、error
 * - model_reasoning_effort 取值 low/medium/high/xhigh/max/ultra（ultra = 子代理并行，仅部分型号与账号可用）
 * - 事件流里没有服务端确认的型号字段 → 型号只能记录为“客户端配置”，界面显示“未确认”
 * - --search 是全局参数，放在 exec 之前；“resume 前放 exec 参数”的写法需在 Windows 上实测
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TaskPhase } from '../core/schemas.js';
import { schemaToCompactString } from '../core/strict-json-schema.js';
import type { ExecutionMeta, FailureKind } from '../core/types.js';
import type { ToolLogItem } from '../core/verify-mvp.js';
import { describeCommand, resolveCommand, runProcess, runSimple, scrubEnv, type ResolvedCommand } from './process.js';
import { emptyMeta, type AdapterProgress, type AdapterResult, type CommandOverride, type ModelAdapter, type ModelTaskSpec } from './types.js';

export interface CodexOptions {
  command: CommandOverride | null;
  extraArgs: string[];
  scrubEnvKeys: string[];
  /** 是否加 --ignore-user-config（默认不加：Windows 沙箱等设置在用户的 config.toml 里） */
  ignoreUserConfig: boolean;
  promptOnlySchemaPhases: TaskPhase[];
}

export const DEFAULT_CODEX_OPTIONS: CodexOptions = {
  command: null,
  extraArgs: [],
  scrubEnvKeys: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_WINDOWS_REGISTERED_CORE'],
  ignoreUserConfig: false,
  promptOnlySchemaPhases: [],
};

const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function buildCodexArgs(spec: ModelTaskSpec, opts: CodexOptions, schemaPath: string, lastMessagePath: string): string[] {
  const args: string[] = [];
  if (spec.allowWeb && spec.sandbox === 'read_only') args.push('--search');
  args.push('exec', '--json', '-m', spec.model, '-c', `model_reasoning_effort=${spec.effort}`);
  if (spec.sandbox === 'read_only') {
    args.push('--sandbox', 'read-only');
  } else {
    args.push('--sandbox', 'workspace-write');
    args.push('-c', `sandbox_workspace_write.network_access=${spec.allowNetwork}`);
  }
  if (!spec.gitRepo) args.push('--skip-git-repo-check');
  if (opts.ignoreUserConfig) args.push('--ignore-user-config');
  if (!opts.promptOnlySchemaPhases.includes(spec.phase)) args.push('--output-schema', schemaPath);
  args.push('-o', lastMessagePath, '--color', 'never');
  args.push(...opts.extraArgs);
  if (spec.resumeSessionId) args.push('resume', spec.resumeSessionId);
  args.push('-');
  return args;
}

interface CodexStreamState {
  threadId: string | null;
  usage: Record<string, number> | null;
  turnFailed: string | null;
  errors: string[];
  lastAgentMessage: string | null;
  toolLog: ToolLogItem[];
  seq: number;
}

export function newCodexState(): CodexStreamState {
  return { threadId: null, usage: null, turnFailed: null, errors: [], lastAgentMessage: null, toolLog: [], seq: 0 };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
  query?: string;
  server?: string;
  tool?: string;
  message?: string;
}

export function handleCodexLine(line: string, st: CodexStreamState): AdapterProgress | null {
  const at = new Date().toISOString();
  let ev: { type?: string; thread_id?: string; usage?: Record<string, number>; error?: { message?: string }; message?: string; item?: CodexItem };
  try {
    ev = JSON.parse(line);
  } catch {
    return line.trim() ? { at, kind: 'info', text: line.slice(0, 200) } : null;
  }
  switch (ev.type) {
    case 'thread.started':
      st.threadId = ev.thread_id ?? null;
      return { at, kind: 'started', text: `会话已启动（${st.threadId ?? '无编号'}）` };
    case 'turn.started':
      return { at, kind: 'info', text: '开始处理' };
    case 'turn.completed':
      st.usage = ev.usage ?? null;
      return { at, kind: 'usage', text: `完成；输出 tokens：${ev.usage?.output_tokens ?? '?'}，推理 tokens：${ev.usage?.reasoning_output_tokens ?? '?'}` };
    case 'turn.failed':
      st.turnFailed = ev.error?.message ?? '未知错误';
      return { at, kind: 'info', text: `失败：${st.turnFailed}` };
    case 'error':
      st.errors.push(ev.message ?? '');
      return { at, kind: 'info', text: `错误：${ev.message ?? ''}` };
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const it = ev.item ?? {};
      const done = ev.type === 'item.completed';
      if (it.type === 'agent_message' && done) {
        st.lastAgentMessage = it.text ?? null;
        return { at, kind: 'message', text: '输出消息' };
      }
      if (it.type === 'reasoning') return ev.type === 'item.started' ? { at, kind: 'info', text: '推理中…' } : null;
      if (it.type === 'command_execution') {
        if (done) {
          st.toolLog.push({
            seq: st.seq++,
            type: 'command_execution',
            command: it.command ?? null,
            exitCode: typeof it.exit_code === 'number' ? it.exit_code : null,
            output: it.aggregated_output ?? null,
            status: it.status ?? null,
            paths: [],
          });
          return { at, kind: 'tool', text: `命令结束（退出码 ${it.exit_code ?? '?'}）：${(it.command ?? '').slice(0, 160)}` };
        }
        return ev.type === 'item.started' ? { at, kind: 'tool', text: `执行命令：${(it.command ?? '').slice(0, 160)}` } : null;
      }
      if (it.type === 'file_change' && done) {
        const paths = (it.changes ?? []).map((c) => c.path);
        st.toolLog.push({ seq: st.seq++, type: 'file_change', command: null, exitCode: null, output: null, status: it.status ?? null, paths });
        return { at, kind: 'tool', text: `修改文件：${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ' …' : ''}` };
      }
      if (it.type === 'web_search' && ev.type === 'item.started') return { at, kind: 'tool', text: `联网搜索：${it.query ?? ''}` };
      if (it.type === 'mcp_tool_call' && ev.type === 'item.started') return { at, kind: 'tool', text: `调用工具：${it.server ?? ''}/${it.tool ?? ''}` };
      if (it.type === 'error' && done) {
        st.errors.push(it.message ?? '');
        return { at, kind: 'info', text: `错误：${it.message ?? ''}` };
      }
      return null;
    }
    default:
      return null;
  }
}

/** 从 stderr 的配置摘要中取型号/强度（客户端配置，不是服务端确认） */
export function parseCodexConfigSummary(stderr: string): { model: string | null; effort: string | null } {
  const model = /^\s*model:\s*(\S+)/im.exec(stderr)?.[1] ?? null;
  const effort = /^\s*reasoning effort:\s*(\S+)/im.exec(stderr)?.[1] ?? null;
  return { model, effort };
}

export function classifyCodexFailure(args: { spawnError: string | null; exitCode: number | null; stderr: string; turnFailed: string | null; errors: string[] }): {
  kind: FailureKind;
  message: string;
} {
  const { spawnError, exitCode, stderr, turnFailed, errors } = args;
  if (spawnError) {
    return /ENOENT|not found|cannot find/i.test(spawnError)
      ? { kind: 'not_installed', message: '找不到 codex 可执行文件。请安装 Codex CLI，或在配置中指定路径。' }
      : { kind: 'process_error', message: spawnError };
  }
  const all = [stderr, turnFailed ?? '', ...errors].join('\n');
  if (/reasoning[ _]effort|model_reasoning_effort/i.test(all) && /invalid|unsupported|not supported|unknown variant|not available/i.test(all)) {
    return { kind: 'effort_unsupported', message: `该型号/账号不支持请求的推理强度：${all.trim().slice(0, 300)}` };
  }
  if (/not logged in|please (log ?in|sign in)|codex login|401|unauthorized|authentication/i.test(all)) {
    return { kind: 'not_logged_in', message: '未登录或登录失效：请在终端运行 codex login 完成 ChatGPT 登录（工作台不代为登录）。' };
  }
  if (/model[^\n]{0,60}(not found|does not exist|not supported|unavailable|not available|no access)|unknown model|model_not_found/i.test(all)) {
    return { kind: 'model_unavailable', message: `请求的型号不可用（可能是计划/灰度/工作区权限）：${all.trim().slice(0, 300)}` };
  }
  if (/429|rate limit|usage limit|quota|too many requests|hit your limit|limit reached|weekly limit/i.test(all)) {
    return { kind: 'rate_limited', message: `触发了用量或速率限制。CLI 提示：${all.trim().slice(0, 300)}` };
  }
  if (/unexpected argument|unrecognized|unknown option|invalid value/i.test(stderr)) {
    return { kind: 'process_error', message: `CLI 不认识某个参数，可能版本不符：${stderr.trim().slice(0, 300)}` };
  }
  return { kind: exitCode === 0 ? 'unknown' : 'process_error', message: (turnFailed ?? errors.at(-1) ?? stderr.trim().slice(0, 300)) || `退出码 ${exitCode}` };
}

export class CodexAdapter implements ModelAdapter {
  readonly kind = 'codex' as const;
  constructor(private readonly opts: CodexOptions = DEFAULT_CODEX_OPTIONS) {}

  resolve(): ResolvedCommand | null {
    return resolveCommand('codex', { override: this.opts.command });
  }

  async version(): Promise<string | null> {
    const cmd = this.resolve();
    if (!cmd) return null;
    const r = await runSimple(cmd, ['--version'], { timeoutMs: 20_000 });
    return r.exitCode === 0 ? r.stdoutTail.trim().split('\n')[0] ?? null : null;
  }

  async run(spec: ModelTaskSpec, onProgress: (p: AdapterProgress) => void, signal: AbortSignal): Promise<AdapterResult> {
    const startedAt = new Date().toISOString();
    const meta: ExecutionMeta = emptyMeta('codex', spec, startedAt);
    const fail = (kind: FailureKind, message: string): AdapterResult => ({
      status: 'failed',
      failure: { kind, message },
      rawText: null,
      structured: null,
      meta: { ...meta, endedAt: new Date().toISOString() },
      toolLog: [],
      simulated: false,
    });
    if (!CODEX_EFFORTS.has(spec.effort)) return fail('effort_unsupported', `Codex 不支持强度「${spec.effort}」`);
    const cmd = this.resolve();
    if (!cmd) return fail('not_installed', '找不到 codex 可执行文件。请安装 Codex CLI 或在配置 adapters.codex.command 中指定路径。');

    mkdirSync(spec.logDir, { recursive: true });
    mkdirSync(spec.cwd, { recursive: true });
    const schemaPath = path.join(spec.logDir, 'output-schema.json');
    const lastPath = path.join(spec.logDir, 'final-message.txt');
    writeFileSync(schemaPath, schemaToCompactString(spec.outputSchema), 'utf8');
    const args = buildCodexArgs(spec, this.opts, schemaPath, lastPath);
    const { env, removed } = scrubEnv({ ...process.env, NO_COLOR: '1' }, this.opts.scrubEnvKeys);
    meta.command = describeCommand(cmd, args);
    meta.nativeSchema = !this.opts.promptOnlySchemaPhases.includes(spec.phase);
    if (!meta.nativeSchema) meta.warnings.push('本阶段按配置不使用 --output-schema（schema 只写在提示词里），输出由工作台校验');
    meta.scrubbedEnv = removed;
    if (removed.length) meta.warnings.push(`已从子进程环境移除：${removed.join(', ')}（隔离宿主进程标志与 API 计费变量，避免误入桌面注册分支或改用 API 计费）`);

    const st = newCodexState();
    const r = await runProcess(cmd, args, {
      cwd: spec.cwd,
      env,
      stdinText: spec.prompt,
      timeoutMs: spec.timeoutMs,
      signal,
      stdoutLogPath: path.join(spec.logDir, 'events.jsonl'),
      stderrLogPath: path.join(spec.logDir, 'stderr.log'),
      onStarted: (pid) => {
        meta.processStarted = true;
        onProgress({ at: new Date().toISOString(), kind: 'started', text: `Codex 子进程已启动（PID ${pid}）` });
      },
      onStdoutLine: (line) => {
        const p = handleCodexLine(line, st);
        if (p) onProgress(p);
      },
      onStderrLine: (line) => {
        if (line.trim()) onProgress({ at: new Date().toISOString(), kind: 'stderr', text: line.slice(0, 300) });
      },
    });

    const summary = parseCodexConfigSummary(r.stderrTail);
    const finalMeta: ExecutionMeta = {
      ...meta,
      processStarted: r.pid !== null,
      sessionId: st.threadId,
      exitCode: r.exitCode,
      endedAt: new Date().toISOString(),
      durationMs: r.durationMs,
      reportedModels: summary.model ? [summary.model] : [],
      reportedModelSource: summary.model ? 'cli_config' : null,
      modelConfirmed: false, // 事件流没有服务端确认的型号字段
      reportedEffort: summary.effort,
      effortConfirmed: false,
      usage: st.usage,
    };
    if (r.terminationWarning) { finalMeta.terminationWarning = r.terminationWarning; finalMeta.warnings.push(r.terminationWarning); }
    if (summary.model && summary.model !== spec.model) finalMeta.warnings.push(`CLI 配置摘要显示的型号（${summary.model}）与请求（${spec.model}）不一致`);
    if (summary.effort && summary.effort !== spec.effort) finalMeta.warnings.push(`CLI 配置摘要显示的强度（${summary.effort}）与请求（${spec.effort}）不一致`);

    const toolLog = st.toolLog;
    if (r.cancelled) return { status: 'cancelled', failure: { kind: 'cancelled', message: '已取消' }, rawText: null, structured: null, meta: finalMeta, toolLog, simulated: false };
    if (r.timedOut) return { status: 'timed_out', failure: { kind: 'timeout', message: `超过 ${Math.round(spec.timeoutMs / 60000)} 分钟未完成` }, rawText: null, structured: null, meta: finalMeta, toolLog, simulated: false };

    const rawText = existsSync(lastPath) ? readFileSync(lastPath, 'utf8') : st.lastAgentMessage;
    if (r.exitCode !== 0 || st.turnFailed) {
      const f = classifyCodexFailure({ spawnError: r.spawnError, exitCode: r.exitCode, stderr: r.stderrTail, turnFailed: st.turnFailed, errors: st.errors });
      return { status: 'failed', failure: f, rawText, structured: null, meta: finalMeta, toolLog, simulated: false };
    }
    return { status: 'succeeded', failure: null, rawText, structured: null, meta: finalMeta, toolLog, simulated: false };
  }
}
