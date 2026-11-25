import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WorkbenchConfig } from '../config.js';
import { killTree, resolveCommand, runProcess, runSimple, scrubEnv, type ResolvedCommand, type RunProcessResult } from '../adapters/process.js';
import { resolveCursorCommand } from '../adapters/cursor.js';
import { cursorWriteAvailability, type CursorWriteCapabilities } from '../adapters/cursor-writer.js';
import { CursorIsolationError, cursorNativeToolEvent, runIsolatedCursorRound } from './cursor-isolated.js';
import { CURSOR_GROK_PRESENTATION_ALIAS } from './cursor-model-state.js';
import { CURSOR_NATIVE_TOOL_EXCLUSION_POLICY, cursorNativeToolExclusionBinding, type CursorNativeToolExclusionBinding } from './cursor-native-tool-exclusion.js';
import { buildCodexDiscoveryArgs, buildCodexIsolationArgs, collectAllCodexPages, parseCodexIsolationMetadata, validateCodexIsolation, type CodexInventory } from './codex-policy.js';
import { CHAT_LIMITS, type ChatDriver, type CliChatRole, type DriverCapability, type DriverInput, type DriverResult } from './types.js';
import { createChatWindowsJobReceiptDirectory, loadChatWindowsJobSupervisorAssets, runChatWindowsJobProcess, type ChatWindowsJobOptions, type WindowsJobProcessPhase } from './windows-job-process.js';
import { WindowsJobAppServerProcess, type WindowsJobAppServerEvidence } from './windows-job-app-server.js';
import { WorkspacePathError } from './workspace.js';
import { safePlanFeedback } from './plans.js';
import { ZodError } from 'zod';

type Proof = { version: string; fingerprint: string; policy: string; verified: true; isolationVerified: true; tests: Record<string, boolean>; nativeToolExclusion?: CursorNativeToolExclusionBinding; runtime?: { windowsJobSupervisor?: ReturnType<typeof loadChatWindowsJobSupervisorAssets> } };
type CodexJobEvidence = WindowsJobAppServerEvidence & { phase: 'version' | 'discovery' | 'isolated'; role: 'astra' | 'sol' };
type Options = { bridgeUrl?: string; bridgeToken?: string; capabilitiesFile?: string; receiptRoot?: string; /** Local provisioning telemetry; not configurable over HTTP or files. */ onClaudeProcessResult?: (result: RunProcessResult) => void; onCodexJobEvidence?: (evidence: CodexJobEvidence) => void; /** Deterministic test seams; never configurable over HTTP or files. */ cursorRound?: (options: Parameters<typeof runIsolatedCursorRound>[0]) => Promise<RunProcessResult & { exitConfirmed: boolean }>; codexTreeKiller?: (pid: number) => Promise<boolean>; codexJobAssets?: ReturnType<typeof loadChatWindowsJobSupervisorAssets>; chatWindowsJobProcess?: typeof runChatWindowsJobProcess; removeReceiptDirectory?: (directory: string) => void };
const POLICIES: Record<CliChatRole, string> = { claude: 'claude-mcp-job-restricted-v2', astra: 'codex-two-stage-no-env-job-v4', sol: 'codex-two-stage-no-env-job-v4', grok: CURSOR_NATIVE_TOOL_EXCLUSION_POLICY };
const REQUIRED = ['outsideReadDenied', 'outsideWriteDenied', 'credentialReadDenied', 'networkDenied', 'childEscapeDenied', 'cancellationConfirmed', 'toolSurfaceVerified'];
const CODEX_REQUIRED = ['cancellationConfirmed', 'toolSurfaceVerified', 'dynamicToolsSchemaVerified', 'namedPermissionProfileSchemaVerified', 'environmentAccessDisabledVerified', 'nativeSurfaceUnavailableVerified', 'extensionsDisabledVerified', 'normalExitTreeVerified', 'windowsJobTreeVerified'];
const CODEX_PROFILE = 'workbench-chat';
const codexPolicyPath = fileURLToPath(new URL(`./codex-policy${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
const ASK_REQUIRED = [...REQUIRED, 'normalExitTreeVerified'];
const CLAUDE_REQUIRED = [...ASK_REQUIRED, 'windowsJobTreeVerified'];
// The remote service owns native network execution. Bind the client's typed
// approval rejection without claiming that its server-side tool surface is absent.
const GROK_REQUIRED = [...ASK_REQUIRED.filter(name => name !== 'networkDenied'), 'preToolHookVerified', 'profileGuardVerified', 'nativeApprovalDenyVerified', 'nativeToolExclusionRequestVerified'];
const bridgePath = fileURLToPath(new URL('./mcp-bridge.mjs', import.meta.url));
const GROK_HOST_JSON_HEAD = `【Grok 宿主 JSON 硬协议】
你本轮只能在普通 assistant 的 final 文本通道返回一个且仅一个 JSON 对象。文中“调用 X”“读取”“取证”一律只表示输出宿主 JSON 请求，不表示调用任何 Cursor 原生工具。
绝不使用、发现或列举 Cursor、CLI、MCP 或 tool_call 工具，也不输出 Markdown、解释或第二个对象。`;
function grokHostJsonTail(tools: DriverInput['tools'], history: Array<{ tool: string; text: string; ref?: string; error?: true }>): string {
  return `可用宿主工具及 schema：${JSON.stringify(tools)}
此前宿主回执：${JSON.stringify(history)}
【本轮最终输出位置】再次确认：所有“调用 X”“读取”“取证”只能在普通 assistant 的 final 文本通道输出唯一 JSON。调用宿主工具必须精确使用 {"tool":"工具名","arguments":{...}}；完成必须精确使用 {"result":"结果"}。字段、ref 或回执被截断时，若本轮 schema 提供 task_evidence 或 result_read，也只能按现有 schema 输出宿主 task_evidence 或 result_read 的 {"tool":"工具名","arguments":{...}} JSON；未提供的工具或字段不得编造。绝不使用、发现或列举 Cursor、CLI、MCP 或 tool_call 工具。`;
}
export class ChatDriverError extends Error {
  cleanupWarning?: string;
  constructor(message: string, public readonly exitConfirmed: boolean, public readonly phase?: WindowsJobProcessPhase) { super(message); this.name = 'ChatDriverError'; }
}
const driverError = (error: unknown, exitConfirmed: boolean, phase?: WindowsJobProcessPhase) => {
  if (error instanceof ChatDriverError) return error;
  const structured = error && typeof error === 'object' ? error as { exitConfirmed?: unknown; phase?: unknown } : undefined;
  const confirmed = typeof structured?.exitConfirmed === 'boolean' ? structured.exitConfirmed : exitConfirmed;
  const errorPhase = structured?.phase === 'pre_dispatch' || structured?.phase === 'post_dispatch' ? structured.phase : phase;
  return new ChatDriverError(error instanceof Error ? error.message : String(error), confirmed, errorPhase);
};
function beforeDispatch<T>(operation: () => T): T { try { return operation(); } catch (error) { throw driverError(error, true, 'pre_dispatch'); } }
function receiptRoot(options: Options): string {
  const root = options.receiptRoot ?? (options.capabilitiesFile ? path.dirname(options.capabilitiesFile) : '');
  if (!root) throw new ChatDriverError('聊天 Job 回执短根未配置', true, 'pre_dispatch');
  return root;
}
function removeReceiptDirectory(options: Options, directory: string): void {
  (options.removeReceiptDirectory ?? (value => rmSync(value, { recursive: true, force: true })))(directory);
}
function retainPrimaryError(primary: unknown): void {
  if (primary && typeof primary === 'object') (primary as { cleanupWarning?: string }).cleanupWarning = 'Job receipt cleanup failed';
}

/** Digest command and each file argument. A changed executable cannot reuse an old proof. */
export function commandFingerprint(cmd: ResolvedCommand, role: CliChatRole, model: string, effort: string, isolation: CursorWriteCapabilities | null = null, codexJobAssets?: ReturnType<typeof loadChatWindowsJobSupervisorAssets>): string {
  const hash = createHash('sha256').update(JSON.stringify({ file: cmd.file, args: cmd.prefixArgs, role, model, effort, policy: POLICIES[role] }));
  // A changed host implementation must not silently reuse a CLI-only proof.
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  const ext = path.extname(fileURLToPath(import.meta.url));
  for (const relative of [`../adapters/process${ext}`, `./types${ext}`, `./runtime${ext}`, `./capability-contract${ext}`, `./session-files${ext}`, `./plans${ext}`, `./profiles${ext}`, `./document-provider${ext}`]) hash.update(readFileSync(fileURLToPath(new URL(relative, import.meta.url))));
  const extensionRoot = fileURLToPath(new URL('./extensions/', import.meta.url));
  for (const relative of readdirSync(extensionRoot, { recursive: true }).filter(file => String(file).endsWith(ext)).map(String).sort()) hash.update(relative).update(readFileSync(path.join(extensionRoot, relative)));
  hash.update(readFileSync(process.execPath));
  if (role === 'claude') {
    hash.update(readFileSync(bridgePath));
    hash.update(readFileSync(fileURLToPath(new URL(`./windows-job-process${ext}`, import.meta.url))));
    const supervisor = loadChatWindowsJobSupervisorAssets();
    hash.update(JSON.stringify(supervisor));
  }
  if (role === 'grok') {
    for (const relative of [`./cursor-isolated${ext}`, `./cursor-deny-bridge${ext}`, `./cursor-model-state${ext}`, `./cursor-native-approval${ext}`, `./cursor-native-tool-exclusion${ext}`, `./cursor-readonly-runtime${ext}`, `./workspace${ext}`, `./gateway${ext}`, `../adapters/cursor-writer${ext}`, '../adapters/cursor-writer-runtime.mjs']) hash.update(readFileSync(fileURLToPath(new URL(relative, import.meta.url))));
    hash.update(JSON.stringify(cursorNativeToolExclusionBinding()));
    hash.update(JSON.stringify(isolation));
  }
  if (role === 'astra' || role === 'sol') {
    hash.update(readFileSync(codexPolicyPath));
    hash.update(readFileSync(fileURLToPath(new URL(`./windows-job-process${ext}`, import.meta.url))));
    hash.update(readFileSync(fileURLToPath(new URL(`./windows-job-app-server${ext}`, import.meta.url))));
    hash.update(JSON.stringify(codexJobAssets ?? loadChatWindowsJobSupervisorAssets()));
  }
  hash.update(readFileSync(cmd.file));
  for (const arg of cmd.prefixArgs) {
    if (arg.startsWith('-')) throw new Error('未验证的命令参数');
    hash.update(readFileSync(arg));
  }
  return hash.digest('hex');
}

function loadProof(file: string | undefined, role: CliChatRole): Proof | null {
  if (!file) return null;
  try {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object') return null;
    const proof = (doc as { roles?: Partial<Record<CliChatRole, Proof>> }).roles?.[role];
    const names = role === 'astra' || role === 'sol' ? CODEX_REQUIRED : role === 'grok' ? GROK_REQUIRED : CLAUDE_REQUIRED;
    if (!proof || proof.verified !== true || proof.isolationVerified !== true || proof.policy !== POLICIES[role] || !proof.version || !proof.fingerprint || !names.every(n => proof.tests?.[n] === true)) return null;
    if (role === 'grok' && JSON.stringify(proof.nativeToolExclusion) !== JSON.stringify(cursorNativeToolExclusionBinding())) return null;
    if (role === 'claude' && JSON.stringify(proof.runtime?.windowsJobSupervisor) !== JSON.stringify(loadChatWindowsJobSupervisorAssets())) return null;
    return proof;
  } catch { return null; }
}

export { cursorNativeToolExclusionBinding };

function commandFor(config: WorkbenchConfig, role: CliChatRole): ResolvedCommand | null {
  if (role === 'claude') return resolveCommand('claude', { override: config.adapters.claude.command });
  if (role === 'grok') return resolveCursorCommand(config.adapters.cursor.command);
  return resolveCommand('codex', { override: config.adapters.codex.command });
}

export interface ClaudeStream { init: boolean; result: boolean; text: string; error?: string; }
export function consumeClaudeLine(state: ClaudeStream, line: string, expected: { model: string; version: string; tools: string[] }, onText: (delta: string) => void): void {
  if (state.error) return;
  let event: any;
  try { event = JSON.parse(line); } catch { state.error = 'Claude 输出不是有效 JSON'; return; }
  if ((event?.type === 'assistant' && event.message?.stop_reason === 'refusal')
    || (event?.type === 'stream_event' && event.event?.type === 'message_delta' && event.event.delta?.stop_reason === 'refusal')
    || (event?.type === 'result' && event.stop_reason === 'refusal')) {
    state.error = 'Claude 上游返回安全拒绝，已停止本次调用；不会自动重试或切换模型。'; return;
  }
  if (event.type === 'system' && event.subtype === 'init') {
    if (state.init || event.model !== expected.model || event.claude_code_version !== expected.version || !Array.isArray(event.tools) || !Array.isArray(event.mcp_servers) || event.mcp_server_errors?.length) { state.error = 'Claude 初始化信息不匹配'; return; }
    const expectedTools = new Set(expected.tools.map(t => `mcp__workbench__${t}`));
    if (event.tools.some((t: unknown) => typeof t !== 'string' || (!expectedTools.has(t) && t !== 'EndConversation')) || !event.mcp_servers.some((s: any) => s.name === 'workbench' && s.status === 'connected')) { state.error = 'Claude 工具或 MCP 列表不符合授权'; return; }
    state.init = true;
  } else if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
    if (!state.init || state.result || typeof event.event.delta.text !== 'string') { state.error = 'Claude 流事件顺序错误'; return; }
    state.text += event.event.delta.text;
    onText(event.event.delta.text);
  } else if (event.type === 'result') {
    if (!state.init || state.result || event.is_error || event.subtype !== 'success') { state.error = 'Claude 返回错误或结果顺序错误'; return; }
    if (event.modelUsage && Object.keys(event.modelUsage).some(m => m !== expected.model && !m.startsWith(`${expected.model}-`))) { state.error = 'Claude 实际模型不匹配'; return; }
    state.result = true;
    if (!state.text && typeof event.result === 'string') { state.text = event.result; onText(event.result); }
  }
}

function validBridge(options: Options): boolean {
  try { const u = new URL(options.bridgeUrl ?? ''); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.search && !u.hash && !!options.bridgeToken; } catch { return false; }
}

async function checkVersion(cmd: ResolvedCommand, proof: Pick<Proof, 'version'>, input: DriverInput, env: NodeJS.ProcessEnv): Promise<void> {
  let r: RunProcessResult;
  try { r = await runSimple(cmd, ['--version'], { cwd: input.directory, env, timeoutMs: 10_000, signal: input.signal }); }
  catch (error) { throw driverError(error, false); }
  validateVersionResult(r, proof.version);
}
export function validateVersionResult(r: RunProcessResult, version: string): void {
  const versionOutput = r.stdoutTail.trim();
  const matches = versionOutput === version || versionOutput.startsWith(`${version} (`);
  if (r.spawnError && r.pid === null) throw new ChatDriverError('模型 CLI 版本未能启动', true, 'pre_dispatch');
  if (r.terminationWarning || (r.spawnError && r.pid !== null)) throw new ChatDriverError('模型 CLI 版本探测进程树退出状态未知', false, 'post_dispatch');
  if (r.cancelled || r.timedOut || r.spawnError || r.exitCode !== 0 || !matches) throw new ChatDriverError('模型 CLI 版本未通过验证', true, 'post_dispatch');
}

/** Shared production transport, also used by explicit live provisioning before enabling a role. */
export async function runClaudeHostTools(cmd: ResolvedCommand, config: WorkbenchConfig, proof: Pick<Proof, 'version'>, input: DriverInput, options: Options): Promise<DriverResult> {
  if (input.signal.aborted) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
  if (!validBridge(options)) throw new ChatDriverError('聊天 MCP 桥不可用', true, 'pre_dispatch');
  const supervisor = beforeDispatch(() => options.codexJobAssets ?? loadChatWindowsJobSupervisorAssets());
  // ChatRuntime supplies the private invocation directory, independently of the project grant.
  const receiptDirectory = beforeDispatch(() => createChatWindowsJobReceiptDirectory('claude-job-control-', receiptRoot(options)));
  const processJob = options.chatWindowsJobProcess ?? runChatWindowsJobProcess;
  let preserveReceiptDirectory = false;
  let primaryError: unknown;
  const executeJob = async (args: string[], jobOptions: ChatWindowsJobOptions) => {
    try {
      const result = await processJob(cmd, args, jobOptions);
      preserveReceiptDirectory ||= result.spawnError ? result.pid !== null : !!result.terminationWarning;
      return result;
    } catch (error) {
      preserveReceiptDirectory ||= !(error && typeof error === 'object' && (error as { exitConfirmed?: unknown }).exitConfirmed === true);
      throw error;
    }
  };
  try {
  const state: ClaudeStream = { init: false, result: false, text: '' };
  const model = config.models.claude.model;
  const env = beforeDispatch(() => scrubEnv(process.env, config.adapters.claude.scrubEnvKeys).env);
  const version = await executeJob(['--version'], { supervisorPath: supervisor.binaryPath, receiptDirectory, cwd: input.directory, env, stdinText: null, timeoutMs: 10_000, signal: input.signal });
  if (input.signal.aborted && !version.terminationWarning && !(version.spawnError && version.pid !== null)) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
  validateVersionResult(version, proof.version);
  const invocationToken = beforeDispatch(() => createHmac('sha256', options.bridgeToken!).update(`${input.chatId}\n${input.invocation.id}`).digest('hex'));
  Object.assign(env, { CHAT_BRIDGE_URL: options.bridgeUrl, CHAT_BRIDGE_TOKEN: invocationToken, CHAT_BRIDGE_CHAT: input.chatId, CHAT_BRIDGE_INVOCATION: input.invocation.id, CHAT_BRIDGE_TOOLS: JSON.stringify(input.tools) });
  const mcp = JSON.stringify({ mcpServers: { workbench: { command: process.execPath, args: [bridgePath] } } });
  const promptDir = beforeDispatch(() => mkdtempSync(path.join(os.tmpdir(), 'workbench-chat-')));
  const promptFile = path.join(promptDir, 'system.txt');
  beforeDispatch(() => writeFileSync(promptFile, input.systemPrompt, { encoding: 'utf8', mode: 0o600 }));
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, '--effort', config.models.claude.effort, '--restricted', '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', 'mcp__workbench__*', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--settings', '{"switchModelsOnFlag":false}', '--append-system-prompt-file', promptFile];
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) abort.abort();
  const r = await executeJob(args, { supervisorPath: supervisor.binaryPath, receiptDirectory, cwd: input.directory, env, stdinText: input.prompt, signal: abort.signal, timeoutMs: CHAT_LIMITS.invocationMs, onStdoutLine: line => { try { consumeClaudeLine(state, line, { model, version: proof.version, tools: input.tools.map(t => t.name) }, input.onText); } catch { state.error = 'Claude 输出处理失败'; } if (state.error) abort.abort(); } });
  options.onClaudeProcessResult?.(r);
  input.signal.removeEventListener('abort', onAbort);
  try { rmSync(promptDir, { recursive: true, force: true }); } catch (error) { throw driverError(error, !r.terminationWarning && !(r.spawnError && r.pid !== null)); }
  if (r.terminationWarning) throw new ChatDriverError(`Claude 进程树退出未确认：${r.terminationWarning.slice(0, 1000)}`, false, 'post_dispatch');
  if (r.spawnError && r.pid !== null) throw new ChatDriverError('Claude 进程退出状态未知', false, 'post_dispatch');
  if (input.signal.aborted) return { text: state.text, exitConfirmed: true, finishReason: 'cancelled' };
  if (state.error || !state.result || r.exitCode !== 0 || r.spawnError || r.timedOut) throw new ChatDriverError(state.error ?? 'Claude 调用失败或未完成', true);
  return { text: state.text, exitConfirmed: true, contextWindow: null, contextUsed: null, finishReason: 'completed' };
  } catch (error) {
    primaryError = error; throw error;
  } finally {
    if (!preserveReceiptDirectory) try { removeReceiptDirectory(options, receiptDirectory); } catch (error) { if (primaryError) retainPrimaryError(primaryError); else throw driverError(error, true, 'post_dispatch'); }
  }
}

/** The app-server can ask for many host operations; only declared invocation tools are dispatched. */
export async function respondCodexRequest(message: any, input: DriverInput, threadId: string, turnId: string): Promise<object> {
  if (message?.method !== 'item/tool/call' || message.id === undefined || message.params?.threadId !== threadId || message.params?.turnId !== turnId || message.params?.namespace != null || !input.tools.some(t => t.name === message.params?.tool) || input.signal.aborted) {
    return { id: message?.id, error: { code: -32601, message: 'Request not authorized' } };
  }
  try {
    const result = await input.callTool(message.params.tool, message.params.arguments);
    if (input.signal.aborted) throw new Error('cancelled');
    return { id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: result.text.slice(0, CHAT_LIMITS.toolText) }] } };
  } catch (error) { const feedback = !input.signal.aborted ? safePlanFeedback(error, message.params.tool) : null; return { id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: feedback?.text.slice(0, CHAT_LIMITS.toolText) ?? '工具调用失败' }] } }; }
}

type CodexRpc = { id?: number; method?: string; params?: any; result?: any; error?: any };

export class CodexAppServer {
  private readonly child: ReturnType<typeof spawn> | WindowsJobAppServerProcess;
  private readonly jobChild: WindowsJobAppServerProcess | null;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly waiters = new Set<{ test: (message: CodexRpc) => boolean; resolve: (message: CodexRpc) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly events: CodexRpc[] = [];
  private readonly closePromise: Promise<void>;
  private nextId = 1;
  private stopped: Promise<boolean> | null = null;
  private failure: Error | null = null;

  constructor(cmd: ResolvedCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly onRequest?: (message: CodexRpc) => Promise<object>, private readonly onEvent?: (message: CodexRpc) => void, private readonly treeKiller: (pid: number) => Promise<boolean> = killTree, windowsJob?: { supervisorPath: string; receiptDirectory: string }, private readonly maxLineBytes = 4 * 1024 * 1024) {
    this.jobChild = process.platform === 'win32' && windowsJob ? new WindowsJobAppServerProcess(cmd, args, { cwd, env, ...windowsJob }) : null;
    this.child = this.jobChild ?? spawn(cmd.file, [...cmd.prefixArgs, 'app-server', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
    this.closePromise = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.once('error', error => this.fail(error));
    this.child.once('close', code => this.rejectAll(new Error(`Codex app-server 已退出 (${code ?? 'signal'})`)));
    if (!this.child.pid) throw new ChatDriverError('Codex app-server 未能启动', true);
    this.child.stdin!.on('error', () => undefined);
    this.child.stderr!.resume();
    let buffered = Buffer.alloc(0);
    this.child.stdout!.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > this.maxLineBytes && !buffered.includes(0x0a)) { this.fail(new Error('Codex 输出行过大')); return; }
      for (;;) {
        const newline = buffered.indexOf(0x0a); if (newline < 0) break;
        const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
        if (line.length > this.maxLineBytes) { this.fail(new Error('Codex 输出行过大')); return; }
        this.consume(line.toString('utf8').replace(/\r$/, ''));
      }
      if (buffered.length > this.maxLineBytes) this.fail(new Error('Codex 输出行过大'));
    });
  }

  private send(message: CodexRpc): void {
    if (this.failure) throw this.failure;
    if (this.child.stdin!.destroyed) throw new Error('Codex app-server stdin 已关闭');
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private sendFlushed(message: CodexRpc): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.child.stdin!.destroyed) return Promise.reject(new Error('Codex app-server stdin 已关闭'));
    return new Promise((resolve, reject) => this.child.stdin!.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve()));
  }

  private consume(line: string): void {
    let message: CodexRpc;
    try { message = JSON.parse(line); } catch { this.fail(new Error('Codex 协议 JSON 无效')); return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) { this.fail(new Error('Codex 返回了未知请求 ID')); return; }
      clearTimeout(pending.timer); this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(`Codex RPC 失败: ${JSON.stringify(message.error).slice(0, 1000)}`)); else pending.resolve(message.result);
      return;
    }
    try { this.onEvent?.(message); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
    this.events.push(message);
    if (this.events.length > 512) this.events.shift();
    for (const waiter of [...this.waiters]) if (waiter.test(message)) { clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(message); }
    if (message.id !== undefined && message.method) {
      if (!this.onRequest) { this.fail(new Error(`Codex 请求未授权: ${message.method}`)); return; }
      void this.onRequest(message).then(async response => {
        await this.sendFlushed(response as CodexRpc);
        if ('error' in response) setTimeout(() => this.fail(new Error(`Codex 请求未授权: ${message.method}`)), 0);
      }).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.rejectAll(this.failure);
    void this.stop();
  }

  request(method: string, params: object = {}, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC 超时: ${method}`)); void this.stop(); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  waitFor(test: (message: CodexRpc) => boolean, timeoutMs = CHAT_LIMITS.invocationMs): Promise<CodexRpc> {
    const existing = this.events.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: undefined as unknown as NodeJS.Timeout };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error('Codex 事件等待超时')); void this.stop(); }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async initialize(): Promise<any> {
    const result = await this.request('initialize', { clientInfo: { name: 'dual_model_workbench', title: '多 Agent 工作台', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false, extensions: {} } });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  stop(): Promise<boolean> {
    if (this.stopped) return this.stopped;
    if (this.jobChild) return this.stopped = this.jobChild.stop();
    this.stopped = (async () => {
      this.rejectAll(new Error('Codex app-server 正在关闭'));
      const pid = this.child.pid;
      if (!pid) return false;
      const deadline = Date.now() + 5_000;
      let killTimer: NodeJS.Timeout | undefined;
      const confirmed = await Promise.race([
        this.treeKiller(pid).catch(() => false),
        new Promise<boolean>(resolve => { killTimer = setTimeout(() => resolve(false), 4_000); }),
      ]);
      if (killTimer) clearTimeout(killTimer);
      if (!confirmed && this.child.exitCode === null) (this.child as ReturnType<typeof spawn>).kill();
      const remaining = Math.max(1, deadline - Date.now());
      const closed = await Promise.race([this.closePromise.then(() => true), new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), remaining); timer.unref(); })]);
      return confirmed && closed;
    })();
    return this.stopped;
  }

  jobEvidence(): WindowsJobAppServerEvidence | null { return this.jobChild?.evidence() ?? null; }
}

export async function codexPages(client: CodexAppServer, method: string, params: Record<string, unknown>): Promise<any[]> {
  return collectAllCodexPages(async cursor => {
    const result = await client.request(method, { ...params, ...(cursor === null ? {} : { cursor }) });
    return { data: result?.data, nextCursor: result?.nextCursor ?? null };
  });
}

export async function codexInventory(client: CodexAppServer, cwd: string): Promise<CodexInventory> {
  const mcpServers = (await codexPages(client, 'mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' })).map((server: any) => {
    if (!server || typeof server.name !== 'string' || !server.name || !(server.pluginId == null || typeof server.pluginId === 'string') || !(server.runtimeStatus == null || typeof server.runtimeStatus === 'string') || !server.tools || typeof server.tools !== 'object' || Array.isArray(server.tools)) throw new Error('Codex MCP 清单无效');
    return { name: server.name, pluginId: server.pluginId ?? null, runtimeStatus: server.runtimeStatus ?? null, toolCount: Object.keys(server.tools).length };
  });
  if (new Set(mcpServers.map(server => server.name)).size !== mcpServers.length) throw new Error('Codex MCP 清单包含重复名称');
  const installed = await client.request('plugin/installed', { cwds: [cwd], installSuggestionPluginNames: [] });
  if (!Array.isArray(installed?.marketplaces) || installed.marketplaces.some((market: any) => market?.error || !Array.isArray(market?.plugins))) throw new Error('Codex 插件清单不完整');
  const plugins = installed.marketplaces.flatMap((market: any) => market.plugins.map((plugin: any) => {
    if (typeof plugin?.id !== 'string' || !plugin.id || typeof plugin.enabled !== 'boolean') throw new Error('Codex 插件清单项无效');
    return { id: plugin.id, enabled: plugin.enabled };
  }));
  if (new Set(plugins.map((plugin: { id: string }) => plugin.id)).size !== plugins.length) throw new Error('Codex 插件清单包含重复 ID');
  return { mcpServers, plugins };
}

export async function runCodexHostTools(cmd: ResolvedCommand, config: WorkbenchConfig, proof: Proof, input: DriverInput, role: 'astra' | 'sol', options: Options): Promise<DriverResult> {
  if (input.signal.aborted) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
  const env = beforeDispatch(() => scrubEnv(process.env, config.adapters.codex.scrubEnvKeys).env);
  const supervisor = beforeDispatch(() => options.codexJobAssets ?? loadChatWindowsJobSupervisorAssets());
  const receiptDirectory = beforeDispatch(() => createChatWindowsJobReceiptDirectory('codex-job-control-', receiptRoot(options)));
  const windowsJob = { supervisorPath: supervisor.binaryPath, receiptDirectory };
  let discovery: CodexAppServer | null = null;
  let isolated: CodexAppServer | null = null;
  let current: CodexAppServer | null = null;
  const reportedJobs = new Set<CodexAppServer>();
  let text = '', threadId = '', turnId = ''; let primaryError: unknown;
  let allTreesConfirmed = true, turnRequested = false, turnActive = false, forceStopTimer: NodeJS.Timeout | undefined;
  let interrupt: Promise<unknown> | null = null;
  let readySettled = false;
  let resolveTurnReady!: () => void;
  let rejectTurnReady!: (error: Error) => void;
  const turnReady = new Promise<void>((resolve, reject) => { resolveTurnReady = resolve; rejectTurnReady = reject; });
  void turnReady.catch(() => undefined);
  const close = async (client: CodexAppServer | null): Promise<boolean> => {
    if (!client) return true;
    const confirmed = await client.stop().catch(() => false);
    const evidence = client.jobEvidence();
    if (evidence && !reportedJobs.has(client)) { reportedJobs.add(client); options.onCodexJobEvidence?.({ ...evidence, phase: client === discovery ? 'discovery' : 'isolated', role }); }
    allTreesConfirmed &&= confirmed;
    if (current === client) current = null;
    return confirmed;
  };
  const onAbort = () => {
    const client = current;
    if (!client) return;
    if (turnActive && threadId && turnId) {
      if (!interrupt) interrupt = client.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => undefined);
      if (!forceStopTimer) { forceStopTimer = setTimeout(() => { void close(client); }, 5_000); forceStopTimer.unref(); }
    } else {
      void close(client);
    }
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const version = await (options.chatWindowsJobProcess ?? runChatWindowsJobProcess)(cmd, ['--version'], { ...windowsJob, cwd: input.directory, env, stdinText: null, timeoutMs: 10_000, signal: input.signal });
    if ('windowsJob' in version) options.onCodexJobEvidence?.({ phase: 'version', role, confirmed: version.windowsJob.confirmed, targetPid: version.windowsJob.targetPid, activeBeforeStop: version.windowsJob.activeBeforeStop, activeProcesses: version.windowsJob.jobActiveProcesses, rootExited: version.windowsJob.rootExited, cancelReceived: version.windowsJob.cancelReceived, targetExitCode: version.windowsJob.targetExitCode });
    if (input.signal.aborted && !version.terminationWarning && !(version.spawnError && version.pid !== null)) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
    validateVersionResult(version, proof.version);
    if (input.signal.aborted) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
    discovery = new CodexAppServer(cmd, buildCodexDiscoveryArgs(), input.directory, env, undefined, undefined, options.codexTreeKiller, windowsJob);
    current = discovery;
    if (input.signal.aborted) onAbort();
    await discovery.initialize();
    const inventory = await codexInventory(discovery, input.directory);
    if (!await close(discovery)) return { text: '', exitConfirmed: false, finishReason: 'exit_unknown' };
    discovery = null;
    if (input.signal.aborted) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };

    const declaredTools = new Set(input.tools.map(tool => tool.name));
    isolated = new CodexAppServer(cmd, buildCodexIsolationArgs(inventory), input.directory, env, async message => {
      const possibleSynchronousTurnTool = turnRequested
        && message.method === 'item/tool/call'
        && message.params?.threadId === threadId
        && message.params?.namespace == null
        && declaredTools.has(message.params?.tool)
        && !input.signal.aborted;
      if (possibleSynchronousTurnTool) await turnReady;
      return respondCodexRequest(message, input, threadId, turnId);
    }, message => {
      const itemType = message.params?.item?.type;
      if ((typeof itemType === 'string' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView'].includes(itemType)) || /item\/(?:commandExecution|fileChange|mcpToolCall|autoApprovalReview)|webSearch|approval/i.test(message.method ?? '')) throw new Error(`Codex 暴露了未授权原生工具: ${itemType ?? message.method}`);
      if (message.method === 'item/agentMessage/delta' && message.params?.threadId === threadId && message.params?.turnId === turnId && typeof message.params?.delta === 'string') {
        text += message.params.delta;
        input.onText(message.params.delta);
      }
    }, options.codexTreeKiller, windowsJob);
    current = isolated;
    if (input.signal.aborted) onAbort();
    await isolated.initialize();
    const features = await codexPages(isolated, 'experimentalFeature/list', { limit: 100 });
    const profiles = await codexPages(isolated, 'permissionProfile/list', { cwd: input.directory, limit: 100 });
    const isolatedInventory = await codexInventory(isolated, input.directory);
    const apps = await isolated.request('app/installed', { forceRefresh: false });
    const hooks = await isolated.request('hooks/list', { cwds: [input.directory] });
    const metadata = parseCodexIsolationMetadata({ features, profiles, mcpServers: isolatedInventory.mcpServers, plugins: isolatedInventory.plugins, apps: apps?.apps, hooks: hooks?.data });
    const failures = validateCodexIsolation(inventory, metadata, 'preflight');
    if (failures.length) throw new Error(`Codex 隔离元数据未通过: ${failures.join('; ')}`);

    const started = await isolated.request('thread/start', {
      model: config.models[role].model, allowProviderModelFallback: false, cwd: input.directory, runtimeWorkspaceRoots: [input.directory], approvalPolicy: 'never', permissions: CODEX_PROFILE,
      ephemeral: true, historyMode: 'paginated', environments: [], selectedCapabilityRoots: [], config: { apps: { _default: { enabled: false } } },
      developerInstructions: input.systemPrompt, dynamicTools: input.tools.map(tool => ({ type: 'function', ...tool })),
    });
    threadId = typeof started?.thread?.id === 'string' ? started.thread.id : '';
    if (!threadId || started?.model !== config.models[role].model || started?.approvalPolicy !== 'never' || started?.activePermissionProfile?.id !== CODEX_PROFILE || !Array.isArray(started?.thread?.environments) || started.thread.environments.length !== 0) throw new Error('Codex 线程策略、模型或原生环境不匹配');
    await isolated.request('thread/settings/update', { threadId, disabledPluginIds: [] });
    const threadMcp = await codexPages(isolated, 'mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly', threadId });
    const threadMetadata = parseCodexIsolationMetadata({ features, profiles, mcpServers: threadMcp, plugins: isolatedInventory.plugins, apps: apps?.apps, hooks: hooks?.data });
    const threadFailures = validateCodexIsolation(inventory, threadMetadata);
    if (threadFailures.length) throw new Error(`Codex 线程工具面未通过: ${threadFailures.join('; ')}`);
    if (input.signal.aborted) {
      const confirmed = await close(isolated); isolated = null;
      return { text: '', exitConfirmed: confirmed, finishReason: confirmed ? 'cancelled' : 'exit_unknown' };
    }

    turnRequested = true;
    const turn = await isolated.request('turn/start', { threadId, input: [{ type: 'text', text: input.prompt }], cwd: input.directory, runtimeWorkspaceRoots: [input.directory], model: config.models[role].model, effort: config.models[role].effort, approvalPolicy: 'never', permissions: CODEX_PROFILE, environments: [], disabledPluginIds: [] });
    turnId = typeof turn?.turn?.id === 'string' ? turn.turn.id : '';
    if (!turnId) throw new Error('Codex 回合启动失败');
    turnActive = true; readySettled = true; resolveTurnReady();
    const completed = isolated.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === threadId && message.params?.turn?.id === turnId);
    if (input.signal.aborted) onAbort();
    if (interrupt) await interrupt;
    const done = await completed;
    const status = done.params?.turn?.status;
    turnActive = false;
    if (forceStopTimer) { clearTimeout(forceStopTimer); forceStopTimer = undefined; }
    const confirmed = await close(isolated); isolated = null;
    if (!confirmed) return { text, exitConfirmed: false, finishReason: 'exit_unknown' };
    if (input.signal.aborted && status === 'interrupted') return { text, exitConfirmed: true, finishReason: 'cancelled' };
    if (status !== 'completed') throw new ChatDriverError(`Codex 回合未完成: ${String(status || '无状态')}`, true);
    return { text, exitConfirmed: true, contextWindow: null, contextUsed: null, finishReason: 'completed' };
  } catch (error) {
    if (error && typeof error === 'object' && (error as { exitConfirmed?: unknown }).exitConfirmed === false) allTreesConfirmed = false;
    if (!readySettled) { readySettled = true; rejectTurnReady(error instanceof Error ? error : new Error(String(error))); }
    await close(discovery);
    await close(isolated);
    if (input.signal.aborted) return { text, exitConfirmed: allTreesConfirmed, finishReason: allTreesConfirmed ? 'cancelled' : 'exit_unknown' };
    primaryError = driverError(error, allTreesConfirmed); throw primaryError;
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    if (forceStopTimer) clearTimeout(forceStopTimer);
    if (!readySettled) { readySettled = true; rejectTurnReady(new Error('Codex 回合未启动')); }
    if (allTreesConfirmed) try { removeReceiptDirectory(options, receiptDirectory); } catch (error) { if (primaryError) retainPrimaryError(primaryError); else throw driverError(error, true, 'post_dispatch'); }
  }
}

async function cursor(cmd: ResolvedCommand, config: WorkbenchConfig, proof: Proof, input: DriverInput, options: Options): Promise<DriverResult> {
  const editing = input.task.mode === 'edit';
  if (editing && (proof.tests.hostEditIsolationVerified !== true || proof.tests.normalExitTreeVerified !== true)) throw new ChatDriverError('Grok 编辑的宿主工具隔离或正常退出进程树尚未验证', true);
  if (!editing && input.task.mode !== 'read' && input.task.mode !== 'verify') throw new ChatDriverError('不支持的 Grok 任务模式', true);
  const isolation = config.adapters.cursorWriter.capabilities;
  const reportedModel = isolation?.reportedModel;
  const availability = cursorWriteAvailability(isolation);
  if (!availability.available || !isolation || proof.version !== isolation.cliVersion) throw new ChatDriverError(availability.reason || 'Cursor WSL 版本与证明不匹配', true);
  if (config.models.grok.model !== 'grok-4.7-high-fast' || config.models.grok.effort !== 'high' || !reportedModel) throw new ChatDriverError('Cursor 型号与强度缺少验证', true);
  const env = beforeDispatch(() => scrubEnv(process.env, config.adapters.cursor.scrubEnvKeys).env);
  await checkVersion(cmd, proof, input, env);
  return runCursorHostTools(input, isolation, options.cursorRound);
}

/** Shared production protocol loop, also used by explicit provisioning probes before a capability can be enabled. */
export async function runCursorHostTools(input: DriverInput, isolation: CursorWriteCapabilities, roundRunner: Options['cursorRound'] = runIsolatedCursorRound): Promise<DriverResult> {
  const availability = cursorWriteAvailability(isolation);
  if (!availability.available) throw new ChatDriverError(availability.reason, true);
  const reportedModel = isolation.reportedModel;
  const deadline = Date.now() + CHAT_LIMITS.invocationMs; const history: Array<{ tool: string; text: string; ref?: string; error?: true }> = [];
  for (let round = 0; round <= CHAT_LIMITS.toolActions; round++) {
    let init = false, result = false, text = '', error = '';
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new ChatDriverError('Grok 工具回合超时', true);
    const instructions = grokHostJsonTail(input.tools, history);
    const abort = new AbortController(); const onAbort = () => abort.abort(); input.signal.addEventListener('abort', onAbort, { once: true }); if (input.signal.aborted) abort.abort();
    let r: RunProcessResult & { exitConfirmed: boolean };
    try { r = await roundRunner({ capabilities: isolation, prompt: `${GROK_HOST_JSON_HEAD}\n\n${input.systemPrompt}\n\n${input.prompt}\n${instructions}`, signal: abort.signal, timeoutMs: remaining, stdoutLogPath: path.join(input.directory, `cursor-${round}.stdout.jsonl`), stderrLogPath: path.join(input.directory, `cursor-${round}.stderr.log`), onStdoutLine: line => {
      let e: any; try { e = JSON.parse(line); } catch { error = 'Cursor 输出不是 JSON'; abort.abort(); return; }
      if (e.type === 'system' && e.subtype === 'init') { if (init || (e.model !== reportedModel && e.model !== CURSOR_GROK_PRESENTATION_ALIAS) || e.cwd !== '/workspace') error = 'Cursor 初始化型号或目录不匹配'; init = true; }
      if (e.type !== 'system' && cursorNativeToolEvent(e)) error = 'Cursor 隔离策略出现原生工具调用';
      if (e.type === 'result') { if (!init || result || e.is_error || e.subtype !== 'success' || typeof e.result !== 'string') error = 'Cursor 执行结果不合法'; else { result = true; text = e.result; } }
      if (error) abort.abort();
    } }); } catch (e) { throw driverError(e, e instanceof CursorIsolationError ? e.exitConfirmed : false); } finally { input.signal.removeEventListener('abort', onAbort); }
    if (!r.exitConfirmed || r.terminationWarning) return { text: '', exitConfirmed: false, finishReason: 'exit_unknown' };
    if (r.spawnError && r.pid !== null) throw new ChatDriverError('Cursor 进程退出状态未知', false);
    if (input.signal.aborted) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
    if (error || !result || r.exitCode !== 0 || r.timedOut || r.spawnError) throw new ChatDriverError(error || 'Cursor 调用失败', true);
    let response: unknown; try { response = JSON.parse(text); } catch { throw new ChatDriverError('Grok 工具回合返回无效 JSON', true); }
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ChatDriverError('Grok 工具回合格式错误', true);
    const obj = response as Record<string, unknown>; const keys = Object.keys(obj).sort().join(',');
    if (keys === 'result' && typeof obj.result === 'string' && obj.result.trim()) { try { input.onText(obj.result); } catch (e) { throw driverError(e, true); } return { text: obj.result, exitConfirmed: true, finishReason: 'completed' }; }
    if (keys !== 'arguments,tool' || typeof obj.tool !== 'string' || !obj.arguments || typeof obj.arguments !== 'object' || Array.isArray(obj.arguments) || !input.tools.some(t => t.name === obj.tool)) throw new ChatDriverError('Grok 请求了未授权或格式错误的宿主工具', true);
    if (round >= CHAT_LIMITS.toolActions) throw new ChatDriverError('Grok 工具回合超过 12 次', true);
    if (input.signal.aborted || Date.now() >= deadline) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
    let reply;
    try { reply = await input.callTool(obj.tool, obj.arguments); }
    catch (e) {
      if (input.signal.aborted) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
      if (e && typeof e === 'object' && (e as { exitConfirmed?: boolean }).exitConfirmed === false) throw driverError(e, false);
      const feedback = safePlanFeedback(e, obj.tool);
      if (feedback) {
        history.push({ tool: obj.tool, error: true, text: feedback.text.slice(0, CHAT_LIMITS.toolText) });
        continue;
      }
      if (!(e instanceof WorkspacePathError || e instanceof ZodError)) throw driverError(e, true);
      const message = e instanceof WorkspacePathError ? e.message : '宿主工具参数不符合所提供的 schema。';
      const guidance = obj.tool === 'file_list' ? '列出根目录请使用空对象 {}，子目录使用工作区内相对路径。' : '请根据工具 schema 修正参数；原请求已拒绝。';
      history.push({ tool: obj.tool, error: true, text: JSON.stringify({ error: message, guidance }).slice(0, CHAT_LIMITS.toolText) });
      continue;
    }
    if (input.signal.aborted) return { text: '', exitConfirmed: true, finishReason: 'cancelled' };
    if (reply.stop) return { text: '', exitConfirmed: true, finishReason: reply.stop };
    const ref = reply.data && typeof reply.data === 'object' && 'ref' in reply.data && typeof reply.data.ref === 'string' ? reply.data.ref : undefined;
    history.push({ tool: obj.tool, text: reply.text.slice(0, CHAT_LIMITS.toolText), ...(ref ? { ref } : {}) });
  }
  throw new ChatDriverError('Grok 工具回合未完成', true);
}

export function createChatDrivers(config: WorkbenchConfig, options: Options = {}): Record<CliChatRole, ChatDriver> {
  return Object.fromEntries((['claude', 'astra', 'sol', 'grok'] as const).map(role => {
    const cmd = commandFor(config, role);
    const proof = loadProof(options.capabilitiesFile, role);
    let reason = '';
    if (!cmd || cmd.via === 'cmd-fallback') reason = '找不到可直接启动的 CLI';
    else if (!proof) reason = '缺少该角色的隔离和协议能力验证';
    else {
      try { if (commandFingerprint(cmd, role, config.models[role].model, config.models[role].effort, role === 'grok' ? config.adapters.cursorWriter.capabilities : null, options.codexJobAssets) !== proof.fingerprint) reason = 'CLI、模型或权限指纹已变化'; }
      catch { reason = '无法核对 CLI 指纹'; }
    }
    if (!reason && role === 'claude' && !validBridge(options)) reason = '聊天 MCP 桥不可用';
    if (!reason && role === 'grok' && (!cursorWriteAvailability(config.adapters.cursorWriter.capabilities).available || proof?.version !== config.adapters.cursorWriter.capabilities?.cliVersion || config.models.grok.model !== 'grok-4.7-high-fast' || config.models.grok.effort !== 'high')) reason = 'Cursor WSL 隔离、型号或强度缺少验证';
    const provider = role === 'claude' ? 'anthropic' : role === 'grok' ? 'xai' : 'openai';
    const capability: DriverCapability = { role, available: !reason, isolationVerified: !reason, model: config.models[role].model, effort: config.models[role].effort, provider, ...(reason ? { reason } : {}), ...(proof ? { version: proof.version, fingerprint: proof.fingerprint } : {}) };
    const driver: ChatDriver = { capability, async invoke(input) {
      try {
        if (!capability.available || !cmd || !proof) throw new ChatDriverError(capability.reason ?? '模型能力不可用', true);
        let fingerprint: string; try { fingerprint = commandFingerprint(cmd, role, config.models[role].model, config.models[role].effort, role === 'grok' ? config.adapters.cursorWriter.capabilities : null, options.codexJobAssets); } catch (error) { throw driverError(error, true); }
        if (fingerprint !== proof.fingerprint) throw new ChatDriverError('CLI 指纹已变化', true);
        if (role === 'claude') return await runClaudeHostTools(cmd, config, proof, input, options);
        if (role === 'grok') return await cursor(cmd, config, proof, input, options);
        return await runCodexHostTools(cmd, config, proof, input, role, options);
      } catch (error) { throw driverError(error, false); }
    } };
    return [role, driver];
  })) as Record<CliChatRole, ChatDriver>;
}
