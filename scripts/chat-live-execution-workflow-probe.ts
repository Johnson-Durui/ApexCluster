/**
 * 真实 ChatRuntime 全链路验收。默认只在显式 --execute-live 时允许产生模型调用；
 * 任何能力、proof 或双平台 runner 前置不满足时，都会在首次推理前退出。
 */
import assert from 'node:assert/strict';
import crypto, { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkbenchConfig } from '../src/config.js';
import type { ChatRuntime as ChatRuntimeType } from '../src/chat/runtime.js';
import type {
  ChatDriver, ChatEvent, ChatRecord, ChatRole, CliChatRole, DriverInput, DriverResult, WaitTicket,
} from '../src/chat/types.js';
import { findForbiddenToolAttempts, validateExecutionPolicyReceipt } from './chat-execution-policy-receipts.js';
import { validateRootGrokBatchReceipt } from './chat-workflow-event-receipts.js';
import { LiveNativeCallBudget, LiveNativeCallBudgetExceeded, type LiveBudgetState } from './chat-live-budget.js';

const DEFAULT_WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const MAX_RUNTIME_INVOCATIONS = 24;
const MAX_CONFIGURED_RUNTIME_INVOCATIONS = 48;
const MAX_TOOLS_PER_INVOCATION = 12;
const MAX_NATIVE_CALLS = MAX_RUNTIME_INVOCATIONS * (MAX_TOOLS_PER_INVOCATION + 1);
const SEGMENT_MS = 15 * 60_000;
const POLL_MS = 100;
const at = () => new Date().toISOString();

const WORKFLOW_CASES = ['standard', 'cancellation', 'ordinary'] as const;
type WorkflowCase = typeof WORKFLOW_CASES[number];

interface Cli {
  proofDir: string;
  dataRoot: string;
  appRoot: string;
  executeLive: boolean;
  maxRuntimeInvocations: number;
  maxNativeCalls: number;
  /** Default all three. r18 ran only the two cases the r17 run never reached (it stopped after the standard case). */
  cases: ReadonlySet<WorkflowCase>;
}

interface InvocationTrace {
  sequence: number;
  role: ChatRole;
  chatId: string;
  taskId: string;
  invocationId: string;
  startedAt: string;
  endedAt?: string;
  toolCalls: { sequence: number; name: string; at: string; fileReadPath?: string; grokBatchSize?: number; evidenceTaskId?: string; resultReadRef?: string }[];
  result?: Pick<DriverResult, 'exitConfirmed' | 'finishReason' | 'contextWindow' | 'contextUsed'>;
  error?: string;
  compiledAppHashesBefore: Record<string, string>;
  compiledAppHashesAfter?: Record<string, string>;
}

interface Report extends LiveBudgetState {
  version: 1;
  startedAt: string;
  endedAt?: string;
  appRoot: string;
  dataRoot: string;
  proofDir: string;
  executeLive: boolean;
  maximumRuntimeInvocations: number;
  nativeBudgetAccounting: {
    observedRoles: ['grok'];
    reservationOnlyRoles: ['claude', 'astra', 'sol'];
    policy: string;
  };
  nativePickerTested: false;
  preflight: Record<string, unknown>;
  paidInvocationsAttempted: number;
  invocations: InvocationTrace[];
  workflow?: Record<string, unknown>;
  cancellation?: Record<string, unknown>;
  ordinaryWorkflow?: Record<string, unknown>;
  cases?: WorkflowCase[];
  failure?: string;
  passed: boolean;
}

function parseCli(argv: string[]): Cli {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(`Usage: tsx scripts/chat-live-execution-workflow-probe.ts --proof-dir ABS --app-root ABS [--data-root ABS] [--max-runtime-invocations 1-${MAX_CONFIGURED_RUNTIME_INVOCATIONS}] [--max-native-calls 1-${MAX_NATIVE_CALLS}] [--execute-live]\n\nWithout --execute-live, all compiled-app, proof, runner, model and workspace preflights run but no model is dispatched. Runtime invocations retain their fixed limit of ${MAX_RUNTIME_INVOCATIONS} by default; --max-runtime-invocations defaults to ${MAX_RUNTIME_INVOCATIONS}. --max-native-calls defaults to ${MAX_RUNTIME_INVOCATIONS}; Grok is observed and charged before every injected Cursor round, while Claude/Astra/Sol reserve one call before their Runtime driver dispatch because they expose no equivalent pre-inference hook.\n`);
    process.exit(0);
  }
  const values = new Map<string, string>();
  let executeLive = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--execute-live') {
      if (executeLive) throw new Error('--execute-live 重复');
      executeLive = true; continue;
    }
    if (!['--proof-dir', '--data-root', '--app-root', '--max-runtime-invocations', '--max-native-calls', '--cases'].includes(arg)) throw new Error(`未知参数：${arg}`);
    if (values.has(arg)) throw new Error(`${arg} 重复`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    values.set(arg, value);
  }
  const proof = values.get('--proof-dir');
  if (!proof) throw new Error('必须显式传入 --proof-dir，目录内需同时包含 models.json、runner-windows.json、runner-wsl.json');
  const app = values.get('--app-root');
  if (!app) throw new Error('最终真实联测必须显式传入 --app-root，使用实际打包后的 JavaScript 应用。');
  const rawMaxRuntimeInvocations = values.get('--max-runtime-invocations') ?? String(MAX_RUNTIME_INVOCATIONS);
  if (!/^\d+$/u.test(rawMaxRuntimeInvocations)) throw new Error('--max-runtime-invocations 必须是整数');
  const maxRuntimeInvocations = Number(rawMaxRuntimeInvocations);
  if (!Number.isSafeInteger(maxRuntimeInvocations) || maxRuntimeInvocations < 1 || maxRuntimeInvocations > MAX_CONFIGURED_RUNTIME_INVOCATIONS) {
    throw new Error(`--max-runtime-invocations 必须在 1-${MAX_CONFIGURED_RUNTIME_INVOCATIONS} 之间`);
  }
  const rawMaxNativeCalls = values.get('--max-native-calls') ?? String(MAX_RUNTIME_INVOCATIONS);
  if (!/^\d+$/u.test(rawMaxNativeCalls)) throw new Error('--max-native-calls 必须是整数');
  const maxNativeCalls = Number(rawMaxNativeCalls);
  if (!Number.isSafeInteger(maxNativeCalls) || maxNativeCalls < 1 || maxNativeCalls > MAX_NATIVE_CALLS) {
    throw new Error(`--max-native-calls 必须在 1-${MAX_NATIVE_CALLS} 之间`);
  }
  const requestedCases = (values.get('--cases') ?? WORKFLOW_CASES.join(',')).split(',').map(item => item.trim());
  if (!requestedCases.length || requestedCases.some(item => !(WORKFLOW_CASES as readonly string[]).includes(item)) || new Set(requestedCases).size !== requestedCases.length) {
    throw new Error(`--cases 只能是 ${WORKFLOW_CASES.join('、')} 中不重复的组合`);
  }
  const suffix = `chat-live-workflow-${at().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  return {
    proofDir: path.resolve(proof),
    dataRoot: path.resolve(values.get('--data-root') ?? path.join(DEFAULT_WORK_ROOT, suffix, 'data')),
    appRoot: path.resolve(app),
    executeLive,
    maxRuntimeInvocations,
    maxNativeCalls,
    cases: new Set(requestedCases as WorkflowCase[]),
  };
}

const cli = parseCli(process.argv.slice(2));
const EXECUTION_POLICY_INTERFACE_FROZEN = true as const;
if (cli.executeLive && !EXECUTION_POLICY_INTERFACE_FROZEN) {
  throw new Error('R15_EXECUTION_POLICY_INTERFACE_NOT_FROZEN');
}
const compiledFiles = ['src/config.js', 'src/artifacts/project-output.js', 'src/chat/bootstrap.js', 'src/chat/context.js', 'src/chat/drivers.js', 'src/chat/cursor-isolated.js', 'src/chat/cursor-native-tool-exclusion.js', 'src/chat/execution.js', 'src/chat/gateway.js', 'src/chat/http.js', 'src/chat/plans.js', 'src/chat/runtime.js', 'src/chat/session-files.js', 'src/chat/source-context.js', 'src/chat/store.js', 'src/chat/workspace.js', 'config/workbench.config.json'] as const;
assert.ok(path.isAbsolute(cli.appRoot), '--app-root must be absolute');
assert.ok(existsSync(cli.appRoot) && lstatSync(cli.appRoot).isDirectory() && !lstatSync(cli.appRoot).isSymbolicLink(), '--app-root must be a real directory');
for (const relative of compiledFiles) {
  const file = path.join(cli.appRoot, relative.replaceAll('/', path.sep));
  assert.ok(existsSync(file), `compiled app file missing: ${relative}`);
  const info = lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink(), `compiled app file must be regular and not a symlink: ${relative}`);
}
assert.ok(path.isAbsolute(cli.proofDir), '--proof-dir must be absolute');
assert.ok(existsSync(cli.proofDir) && lstatSync(cli.proofDir).isDirectory() && !lstatSync(cli.proofDir).isSymbolicLink(), '--proof-dir must be a real directory');
for (const name of ['models.json', 'runner-windows.json', 'runner-wsl.json']) {
  const file = path.join(cli.proofDir, name); assert.ok(existsSync(file), `proof missing: ${name}`);
  const info = lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink(), `proof must be regular and not a symlink: ${name}`);
}
const modulePath = (relative: string) => pathToFileURL(path.join(cli.appRoot, relative.replaceAll('/', path.sep))).href;
const configModule = await import(modulePath('src/config.js')) as typeof import('../src/config.js');
const projectOutputModule = await import(modulePath('src/artifacts/project-output.js')) as typeof import('../src/artifacts/project-output.js');
const bootstrapModule = await import(modulePath('src/chat/bootstrap.js')) as typeof import('../src/chat/bootstrap.js');
const driversModule = await import(modulePath('src/chat/drivers.js')) as typeof import('../src/chat/drivers.js');
const cursorModule = await import(modulePath('src/chat/cursor-isolated.js')) as typeof import('../src/chat/cursor-isolated.js');
const executionModule = await import(modulePath('src/chat/execution.js')) as typeof import('../src/chat/execution.js');
const gatewayModule = await import(modulePath('src/chat/gateway.js')) as typeof import('../src/chat/gateway.js');
const httpModule = await import(modulePath('src/chat/http.js')) as typeof import('../src/chat/http.js');
const runtimeModule = await import(modulePath('src/chat/runtime.js')) as typeof import('../src/chat/runtime.js');
const storeModule = await import(modulePath('src/chat/store.js')) as typeof import('../src/chat/store.js');
const workspaceModule = await import(modulePath('src/chat/workspace.js')) as typeof import('../src/chat/workspace.js');

const reportRoot = path.dirname(cli.dataRoot);
const reportFile = path.join(reportRoot, 'evidence.json');
const report: Report = {
  version: 1,
  startedAt: at(),
  appRoot: cli.appRoot,
  dataRoot: cli.dataRoot,
  proofDir: cli.proofDir,
  executeLive: cli.executeLive,
  maximumRuntimeInvocations: cli.maxRuntimeInvocations,
  nativeBudgetAccounting: {
    observedRoles: ['grok'],
    reservationOnlyRoles: ['claude', 'astra', 'sol'],
    policy: 'Grok increments at injected cursorRound immediately before runIsolatedCursorRound; other roles reserve one before Runtime driver invoke and are not reported as observed native CLI invocations.',
  },
  maximumNativeCallsReserved: cli.maxNativeCalls,
  nativeCallsReserved: 0,
  nativeCliInvocations: 0,
  nativeCallsReservedByRole: {},
  nativeCliInvocationsByRole: {},
  nativePickerTested: false,
  preflight: {},
  paidInvocationsAttempted: 0,
  invocations: [],
  passed: false,
};

function persist(): void {
  mkdirSync(reportRoot, { recursive: true });
  const temporary = `${reportFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, reportFile);
}
const nativeBudget = new LiveNativeCallBudget(report, persist);

function sha256(file: string): string {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

const compiledAppHashes = Object.fromEntries(compiledFiles.map(relative => [
  relative, sha256(path.join(cli.appRoot, relative.replaceAll('/', path.sep))),
]));
const policyOracleFile = path.resolve('scripts/chat-execution-policy-receipts.ts');
assert.ok(existsSync(policyOracleFile) && lstatSync(policyOracleFile).isFile() && !lstatSync(policyOracleFile).isSymbolicLink(),
  'execution policy receipt oracle source must be a regular local file');
const policyOracleSha256 = sha256(policyOracleFile);

function verifyCompiledAppSnapshot(label: string): Record<string, string> {
  const current = Object.fromEntries(compiledFiles.map(relative => [
    relative, sha256(path.join(cli.appRoot, relative.replaceAll('/', path.sep))),
  ]));
  assert.deepEqual(current, compiledAppHashes, `compiled app drifted ${label}`);
  return current;
}

function allEvents(runtime: ChatRuntimeType, chatId: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  let since = 0;
  for (;;) {
    const page = runtime.store.events(chatId, since, 500);
    events.push(...page.items);
    if (!page.hasMore) return events;
    since = page.next;
  }
}

function eventToolName(event: ChatEvent): string | undefined {
  const data = event.data as { name?: unknown } | null;
  return data && typeof data.name === 'string' ? data.name : undefined;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'loopback server did not expose a TCP address');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error('loopback server did not close within 5 seconds'));
    }, 5_000);
    server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    server.closeIdleConnections();
  });
}

async function reservePort(): Promise<number> {
  const temporary = createServer();
  const port = await listen(temporary);
  await closeServer(temporary);
  return port;
}

function wrapDrivers(source: Record<CliChatRole, ChatDriver>): Record<ChatRole, ChatDriver> {
  return Object.fromEntries((Object.keys(source) as CliChatRole[]).map(role => {
    const original = source[role];
    return [role, {
      capability: original.capability,
      async invoke(input: DriverInput): Promise<DriverResult> {
        assert.ok(report.paidInvocationsAttempted < report.maximumRuntimeInvocations, `Runtime invocation 达到固定上限 ${report.maximumRuntimeInvocations}`);
        const trace: InvocationTrace = {
          sequence: ++report.paidInvocationsAttempted,
          role,
          chatId: input.chatId,
          taskId: input.task.id,
          invocationId: input.invocation.id,
          startedAt: at(),
          toolCalls: [],
          compiledAppHashesBefore: verifyCompiledAppSnapshot(`before invocation ${input.invocation.id}`),
        };
        report.invocations.push(trace); persist();
        if (role !== 'grok') nativeBudget.reserve(role, false);
        const started = Date.now();
        const guarded: DriverInput = {
          ...input,
          callTool: async (name, args) => {
            assert.ok(trace.toolCalls.length < MAX_TOOLS_PER_INVOCATION, `单调用段工具超过 ${MAX_TOOLS_PER_INVOCATION}`);
            const request = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
            const readPath = typeof request.path === 'string' ? path.posix.normalize(request.path.replaceAll('\\', '/')) : '';
            trace.toolCalls.push({ sequence: trace.toolCalls.length + 1, name, at: at(),
              ...(name === 'file_read' ? { fileReadPath: readPath === 'value.mjs' || readPath === 'test.mjs' ? readPath : '<other>' } : {}),
              ...(name === 'grok_submit' ? { grokBatchSize: Array.isArray(request.tasks) ? request.tasks.length : 0 } : {}),
              ...(name === 'task_evidence' && typeof request.taskId === 'string' ? { evidenceTaskId: request.taskId } : {}),
              ...(name === 'result_read' && typeof request.ref === 'string' ? { resultReadRef: request.ref } : {}),
            }); persist();
            return input.callTool(name, args);
          },
        };
        try {
          const result = await original.invoke(guarded);
          trace.result = {
            exitConfirmed: result.exitConfirmed,
            ...(result.finishReason ? { finishReason: result.finishReason } : {}),
            ...(result.contextWindow !== undefined ? { contextWindow: result.contextWindow } : {}),
            ...(result.contextUsed !== undefined ? { contextUsed: result.contextUsed } : {}),
          };
          assert.ok(Date.now() - started <= SEGMENT_MS + 30_000, '调用段超过15分钟派发预算及30秒安全收口余量');
          return result;
        } catch (error) {
          trace.error = safeError(error);
          throw error;
        } finally {
          trace.compiledAppHashesAfter = verifyCompiledAppSnapshot(`after invocation ${input.invocation.id}`);
          trace.endedAt = at(); persist();
        }
      },
    } satisfies ChatDriver];
  })) as Record<ChatRole, ChatDriver>;
}

async function waitFor(
  runtime: ChatRuntimeType,
  chatId: string,
  description: string,
  predicate: (chat: ChatRecord) => boolean,
  timeoutMs = SEGMENT_MS,
  rejectExtraQuestion = false,
): Promise<ChatRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chat = runtime.get(chatId);
    if (chat.blockedReason || chat.unsafeProcesses?.length) throw new Error(`聊天进入不安全状态：${chat.blockedReason ?? JSON.stringify(chat.unsafeProcesses)}`);
    if (chat.tasks.some(task => ['failed', 'interrupted'].includes(task.status))) {
      throw new Error(`聊天任务失败：${JSON.stringify(chat.tasks.filter(task => ['failed', 'interrupted'].includes(task.status)))}`);
    }
    if (predicate(chat)) return chat;
    if (rejectExtraQuestion && pendingUserTicket(chat)) throw new Error(`验收流程提出了额外问题：${pendingUserTicket(chat)!.question}`);
    if (Date.now() >= deadline) throw new Error(`等待${description}超时`);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

function pendingUserTicket(chat: ChatRecord): WaitTicket | undefined {
  return chat.tickets.find(ticket => ticket.type === 'user' && ticket.status === 'pending');
}

function assertClosed(chat: ChatRecord): void {
  assert.equal(chat.blockedReason, undefined, 'chat must not be blocked');
  assert.deepEqual(chat.unsafeProcesses ?? [], [], 'chat must not retain unsafe processes');
  assert.equal(chat.tickets.some(ticket => ticket.status === 'pending'), false, 'all tickets must be closed');
  assert.equal(chat.invocations.some(invocation => invocation.status !== 'exited' || invocation.exitConfirmed !== true), false, 'all invocations must have confirmed exits');
}

function readTestEvidence(runtime: ChatRuntimeType, chat: ChatRecord, taskId: string): Record<string, unknown>[] {
  return chat.artifacts
    .filter(artifact => artifact.taskId === taskId && artifact.kind === 'test' && artifact.provenance === 'runner')
    .map(artifact => JSON.parse(runtime.store.readBlob(chat.id, artifact.relativePath).toString('utf8')) as Record<string, unknown>);
}

async function safeShutdown(runtime: ChatRuntimeType | undefined, chatIds: string[]): Promise<void> {
  if (!runtime) return;
  for (const id of chatIds) {
    try { runtime.cancel(id); } catch { /* chat may not have been created */ }
  }
  await runtime.shutdown(30_000);
}

async function main(): Promise<void> {
  assert.equal(existsSync(cli.dataRoot), false, 'dataRoot must be a fresh path; refusing to overwrite an existing run');
  mkdirSync(reportRoot, { recursive: true });
  const disk = statfsSync(reportRoot);
  assert.ok(disk.bavail * disk.bsize >= 512 * 1024 * 1024, 'dataRoot filesystem free space below 512 MiB');

  const proofNames = ['models.json', 'runner-windows.json', 'runner-wsl.json'] as const;
  const capabilitiesRoot = path.join(cli.dataRoot, 'capabilities');
  const workRoot = path.join(cli.dataRoot, 'work');
  mkdirSync(capabilitiesRoot, { recursive: true }); mkdirSync(workRoot, { recursive: true });
  for (const name of proofNames) copyFileSync(path.join(cli.proofDir, name), path.join(capabilitiesRoot, name));

  const configFile = path.join(cli.appRoot, 'config', 'workbench.config.json');
  const config: WorkbenchConfig = configModule.loadConfig(configFile, cli.appRoot);
  assert.deepEqual({ model: config.models.claude.model, effort: config.models.claude.effort }, { model: 'claude-opus-5-5', effort: 'max' });
  assert.deepEqual({ model: config.models.astra.model, effort: config.models.astra.effort }, { model: 'gpt-6.2-astra', effort: 'max' });
  assert.deepEqual({ model: config.models.sol.model, effort: config.models.sol.effort }, { model: 'gpt-6.2-sol', effort: 'max' });
  assert.deepEqual({ model: config.models.grok.model, effort: config.models.grok.effort }, { model: 'grok-4.7-high-fast', effort: 'high' });

  const loaded = bootstrapModule.loadChatRunners(cli.dataRoot);
  assert.ok(loaded.runner, `verified runners unavailable: ${JSON.stringify(loaded.availability)}`);
  const commands = loaded.runner.commandInfo();
  for (const platform of ['windows', 'linux'] as const) assert.ok(commands.some(command => command.platform === platform), `verified ${platform} runner unavailable`);

  const fixture = path.join(workRoot, 'fixture');
  const managed = path.join(workRoot, 'managed');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(path.join(fixture, 'value.mjs'), 'export const value = 1;\n', { flag: 'wx' });
  writeFileSync(path.join(fixture, 'test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { writeFile } from 'node:fs/promises';",
    "const { value } = await import('./value.mjs');",
    'assert.equal(value, 2);',
    "await writeFile('test-pollution.txt', 'derived-test-copy-only');",
    "process.stdout.write('CHAT_WORKFLOW_TEST_OK');",
  ].join('\n') + '\n', { flag: 'wx' });

  const registry = new workspaceModule.WorkspaceRegistry(managed);
  const grant = registry.grantFromNativeSelection(fixture, registry.issueNativeSelectionRequest());
  const projectOutputs = new projectOutputModule.ProjectOutputStore(registry);
  const gateway = new gatewayModule.WorkspaceGateway(registry, loaded.runner);
  const store = new storeModule.ChatStore(cli.dataRoot);
  const bridgeToken = randomBytes(32).toString('hex');
  const port = await reservePort();
  const httpOptions: import('../src/chat/http.js').ChatHttpOptions = {
    bridgeToken, port, dataRoot: cli.dataRoot, registry, runner: loaded.availability,
  };
  const chatHttp = httpModule.createChatHttp(httpOptions);
  const server = createServer(async (request, response) => {
    try {
      if (!new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname.startsWith('/internal/chat-tools/')) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'not_found' })); return;
      }
      if (!await chatHttp(request, response)) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'not_found' }));
      }
    } catch (error) {
      const candidate = error as { status?: unknown; message?: unknown };
      const status = typeof candidate.status === 'number' && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 500;
      if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: status === 500 ? 'internal_error' : String(candidate.message ?? 'request_rejected') }));
    }
  });

  let runtime: ChatRuntimeType | undefined;
  const chatIds: string[] = [];
  try {
    await listen(server, port);
    const productionDrivers = driversModule.createChatDrivers(config, {
      bridgeUrl: `http://127.0.0.1:${port}`,
      bridgeToken,
      capabilitiesFile: path.join(capabilitiesRoot, 'models.json'),
      cursorRound: async options => {
        try { nativeBudget.reserve('grok', true); }
        catch (error) {
          if (error instanceof LiveNativeCallBudgetExceeded) throw new cursorModule.CursorIsolationError(error.message, true);
          throw error;
        }
        return cursorModule.runIsolatedCursorRound(options);
      },
    });
    const capabilities = Object.values(productionDrivers).map(driver => driver.capability);
    assert.equal(capabilities.length, 4);
    for (const role of ['claude', 'astra', 'sol', 'grok'] as const) {
      const capability = productionDrivers[role].capability;
      assert.equal(capability.available, true, `${role}: ${capability.reason ?? 'unavailable'}`);
      assert.equal(capability.isolationVerified, true, `${role}: isolation not verified`);
    }
    report.preflight = {
      completedAt: at(), models: config.models, capabilities, runners: loaded.availability,
      proofHashes: Object.fromEntries(proofNames.map(name => [name, {
        source: sha256(path.join(cli.proofDir, name)), copied: sha256(path.join(capabilitiesRoot, name)),
      }])),
      compiledAppHashes,
      policyReceiptOracle: { file: path.relative(process.cwd(), policyOracleFile).replaceAll('\\', '/'), sha256: policyOracleSha256 },
      fixtureInsideRunnerWorkRoot: path.relative(workRoot, fixture), loopbackPort: port,
    };
    persist();
    assert.ok(cli.executeLive, `零推理前置已通过；未提供 --execute-live，未派发模型。证据：${reportFile}`);

    runtime = bootstrapModule.createProductionChatRuntime({
      store,
      drivers: wrapDrivers(productionDrivers),
      workspace: gateway,
      projectOutputs,
      requireCostConfirmation: true,
    });
    httpOptions.runtime = runtime;
    report.cases = [...cli.cases];
    persist();

    if (cli.cases.has('standard')) {
    const workflow = runtime.create({ title: '真实四角色工作流验收', workspaceId: grant.id });
    chatIds.push(workflow.id);
    runtime.send(workflow.id, {
      clientMessageId: randomUUID(), confirmCost: true,
      text: [
        '这是一次工作台四角色协作的完整流程检查，只处理当前工作区。',
        '第一步必须调用 ask_user，问题为“目标值选 2 还是 3？”，选项为 2、3；等待回答，不得自行假定。',
        '收到回答后，Claude 必须用一次 grok_submit 同批并行提交三个 read 子任务：一个只读取 value.mjs 确认当前值，一个只读取 test.mjs 确认测试要求，一个读取这两个文件独立核对最小修改范围。这三个只读任务不执行测试、不修改文件，分别收集并声明 disposition。',
        '随后 agent_submit 一个 Sol edit 子任务。Sol 必须亲自 grok_submit edit；该 Grok 严格依次 file_read、file_write（目标值）、选择 task_state 中 Linux 命令运行一次 test_submit；Sol collect/disposition 后只允许 integrate_edit value.mjs。',
        'Sol 收集 Grok 后必须调用 task_evidence(taskId=该 Grok)，分页取得程序的 file_write 原始回执和 kind=test/provenance=runner 的原始成功测试回执，用 result_read 逐一核对，再声明采用并 integrate_edit。Grok 总结没贴引用不等于程序没证据；先查程序目录，不能把模型转述当回执，也不能只因总结缺引用拒收。',
        'Sol 完成后 agent_submit Astra verify。Astra 必须亲自 grok_submit verify；该 Grok 先 file_read value.mjs，再选择 task_state 中 Linux 命令运行一次 test_submit。Astra collect/disposition 后，自己必须在同一最新冻结基线上分别用 Linux、Windows 的真实 test_submit 验收。',
        'Astra 收集验证 Grok 后也必须调用 task_evidence(taskId=该 Grok)，用 result_read 核对 kind=test/provenance=runner 的原始测试回执，再声明采用；这不替代 Astra 自己的双平台测试。',
        // r13 failed because the agents treated a former "never re-read" line here as a hard rule they then broke.
        '读取建议：同一 ref、hash、分页 offset 核对过一次后尽量不要重复读取，重复读取不算新进展；若换段后缺少所需信息（例如 sourceSnapshotId），可以按程序给出的引用继续核对，这不算违规。不得因此省略父任务读取子任务原始回执、Astra 自己的双平台测试或最终源码校验。',
        '宿主已提供页幂等 ack 若 originalContentIncluded=false，不是再次正文交付，也不构成新的阅读/验收证据；必须指向首次真实正文事件，不得用 ack 省略首次核验。',
        '完成原源码修改、集成与Astra双平台测试后，Claude必须新增并完成一个根计划步骤“交付项目摘要”：调用 artifact_publish 发布 name=project-delivery.txt、kind=report，正文逐字为“value.mjs=2；Linux与Windows测试均通过。\n”（末尾为真实LF），并用该真实artifact验收此步骤。之后才创建执行评审。',
        '最后 Claude collect 并 disposition 所有直接子任务，再 task_complete。任何失败都不得宣称成功。',
        '生产执行策略额外要求：原工作计划的全部步骤完成且全部工作子任务已处置后，再单独 agent_submit 一个新的 Astra verify，purpose 必须是 execution_review；该 reviewer 不是被审工作步骤，禁止把 reviewer 自身加入原工作计划。',
        '执行 reviewer 必须先 execution_read，随后用 result_read 完整读取 viewRef，并按 canonical view 的 requiredRefs 完整读取每一项原始引用；只看摘要、目录或模型转述不算。然后先 artifact_publish 自己的非空 kind:report 报告，再用当前 contractHash/evidenceHash、精确覆盖全部工作步骤的 stepVerdicts 调用 execution_submit_review。',
        '执行 reviewer 提交通过后才能 task_complete。Claude 必须等待 reviewer 安全退出后 collect，用 result_read 完整读取 reviewer 的原始 report ref，再明确 disposition=adopted，最后才可 task_complete；若评审 failed/insufficient、哈希过期、漏页、退出未确认或无法采用，根任务不得宣称成功。',
      ].join('\n'),
    });

    const awaiting = await waitFor(runtime, workflow.id, '首次用户问题', chat => !!pendingUserTicket(chat));
    const question = pendingUserTicket(awaiting)!;
    assert.match(question.question ?? '', /2.*3|3.*2/);
    runtime.answer(workflow.id, { ticketId: question.id, text: '2', clientMessageId: randomUUID() });
    runtime.send(workflow.id, {
      clientMessageId: randomUUID(), confirmCost: true,
      text: '补充约束：目标值确定为 2；必须保留 test.mjs，测试产生的 test-pollution.txt 只能存在于派生测试副本，绝不能集成到原工作区。',
    });

    const completed = await waitFor(runtime, workflow.id, '完整四角色工作流', chat => {
      const root = chat.turns.at(-1) && chat.tasks.find(task => task.id === chat.turns.at(-1)!.rootTaskId);
      return root?.status === 'completed';
    }, SEGMENT_MS * 12, true);
    await runtime.idle(30_000);
    assertClosed(completed);
    assert.equal(readFileSync(path.join(fixture, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
    assert.equal(existsSync(path.join(fixture, 'test.mjs')), true);
    assert.equal(existsSync(path.join(fixture, 'test-pollution.txt')), false);

    const events = allEvents(runtime, completed.id);
    const invokedRoles = new Set(completed.invocations.map(invocation => completed.tasks.find(task => task.id === invocation.taskId)?.role));
    assert.deepEqual([...invokedRoles].filter(Boolean).sort(), ['astra', 'claude', 'grok', 'sol']);
    const rootsById = new Map(completed.tasks.map(task => [task.id, task]));
    const grokChildren = completed.tasks.filter(task => task.role === 'grok' && task.parentTaskId);
    for (const parentRole of ['claude', 'sol', 'astra'] as const) {
      assert.ok(grokChildren.some(task => rootsById.get(task.parentTaskId!)?.role === parentRole), `${parentRole} did not create a Grok child`);
    }
    const rootTask = completed.tasks.find(task => task.id === completed.turns.at(-1)!.rootTaskId)!;
    assert.equal(rootTask.executionPolicyVersion, 1, 'fresh workflow root must use production execution policy v1');
    const sol = completed.tasks.find(task => task.role === 'sol');
    const astra = completed.tasks.find(task => task.role === 'astra' && !task.executionReviewOfTaskId);
    assert.ok(sol && astra, 'Sol/Astra tasks missing');
    const executionReviewer = completed.tasks.find(task => task.parentTaskId === rootTask.id && task.executionReviewOfTaskId === rootTask.id);
    assert.ok(executionReviewer, 'independent execution reviewer missing');
    assert.notEqual(executionReviewer.id, astra.id, 'execution reviewer must be distinct from the source verifier');
    const claudeReads = grokChildren.filter(task => task.parentTaskId === rootTask.id && task.mode === 'read');
    const edit = grokChildren.find(task => task.parentTaskId === sol.id && task.mode === 'edit');
    const verify = grokChildren.find(task => task.parentTaskId === astra.id && task.mode === 'verify');
    assert.equal(claudeReads.length, 3, 'Claude must create exactly three direct read children');
    assert.ok(edit && verify, 'required Sol-edit/Astra-verify Grok children missing');
    const rootGrokBatch = validateRootGrokBatchReceipt(events, rootTask.id, claudeReads.map(task => task.id), completed.id);
    const readCoverage = claudeReads.map(task => [...new Set(report.invocations.filter(item => item.taskId === task.id).flatMap(item => item.toolCalls)
      .filter(item => item.name === 'file_read').map(item => item.fileReadPath))].sort().join(',')).sort();
    assert.deepEqual(readCoverage, ['test.mjs', 'test.mjs,value.mjs', 'value.mjs'], 'the three Grok read tasks must cover value-only, test-only and both files');
    const toolNames = (taskId: string) => events.filter(event => event.taskId === taskId && event.type === 'tool_result').map(eventToolName).filter((name): name is string => !!name);
    for (const task of claudeReads) assert.ok(toolNames(task.id).includes('file_read'), 'Claude Grok-read child did not actually read a file');
    const grokActivity = completed.invocations
      .filter(invocation => rootsById.get(invocation.taskId)?.role === 'grok')
      .flatMap(invocation => [{ at: Date.parse(invocation.startedAt), delta: 1 }, { at: Date.parse(invocation.endedAt!), delta: -1 }])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let grokActive = 0; let maxConcurrentGrok = 0;
    for (const edge of grokActivity) { assert.ok(Number.isFinite(edge.at)); grokActive += edge.delta; maxConcurrentGrok = Math.max(maxConcurrentGrok, grokActive); }
    assert.ok(maxConcurrentGrok >= 2, 'real Grok task invocations never overlapped');
    for (const required of ['file_read', 'file_write', 'test_submit']) assert.ok(toolNames(edit.id).includes(required), `Grok edit missing ${required}`);
    for (const required of ['file_read', 'test_submit']) assert.ok(toolNames(verify.id).includes(required), `Grok verify missing ${required}`);
    for (const required of ['grok_submit', 'grok_collect', 'grok_disposition', 'integrate_edit']) assert.ok(toolNames(sol.id).includes(required), `Sol missing ${required}`);
    for (const required of ['grok_submit', 'grok_collect', 'grok_disposition', 'test_submit']) assert.ok(toolNames(astra.id).includes(required), `Astra missing ${required}`);
    const parentCalls = (taskId: string) => report.invocations.filter(item => item.taskId === taskId).flatMap(item => item.toolCalls);
    for (const [parent, child, names] of [[sol, edit, ['file_write', 'test_submit']], [astra, verify, ['test_submit']]] as const) {
      const calls = parentCalls(parent.id);
      assert.ok(calls.some(call => call.name === 'task_evidence' && call.evidenceTaskId === child.id), `${parent.role} did not query its child's program evidence`);
      for (const name of names) {
        const receipt = completed.toolResults?.find(item => item.taskId === child.id && item.name === name && item.provenance === (name === 'test_submit' ? 'runner' : 'workspace'));
        assert.ok(receipt, `program ${name} receipt missing`);
        assert.ok(calls.some(call => call.name === 'result_read' && call.resultReadRef === receipt.ref), `${parent.role} did not read the original ${name} receipt`);
      }
    }
    for (const required of ['grok_submit', 'grok_collect', 'grok_disposition', 'task_complete']) {
      assert.ok(toolNames(rootTask.id).includes(required), `Claude missing ${required}`);
    }
    assert.equal(completed.tasks.some(task => task.parentTaskId && !task.disposition), false, 'all child results need disposition');
    assert.equal(completed.tasks.some(task => task.status !== 'completed'), false, 'all workflow tasks must complete');
    assert.deepEqual(gateway.completionIssues(completed, completed.tasks.find(task => task.id === completed.turns.at(-1)!.rootTaskId)!), []);
    const recomputedExecutionView = executionModule.materializeExecutionView(completed, rootTask, runtime.store);
    const executionPolicyReceipt = validateExecutionPolicyReceipt({
      chat: completed,
      events,
      rootTaskId: rootTask.id,
      reviewerTaskId: executionReviewer.id,
      recomputedView: recomputedExecutionView,
      readBlob: ref => runtime!.store.readBlob(completed.id, ref),
      readFile: fileId => runtime!.files.read(completed, fileId, true),
    });
    const deliveryText = 'value.mjs=2；Linux与Windows测试均通过。\n';
    const projectDelivery = completed.artifacts.find(artifact => artifact.taskId === rootTask.id && artifact.name === 'project-delivery.txt');
    assert.ok(projectDelivery, 'root project delivery artifact missing');
    assert.equal(runtime.store.readBlob(completed.id, projectDelivery.relativePath).toString('utf8'), deliveryText);
    assert.equal(projectDelivery.projectExport?.status, 'saved', 'root project delivery was not copied to the selected project');
    if (projectDelivery.projectExport?.status !== 'saved') throw new Error('root project delivery export unavailable');
    projectOutputs.verify(projectDelivery.projectExport, projectDelivery.hash);
    assert.equal(projectDelivery.projectExport.workspaceId, grant.id); assert.equal(projectDelivery.projectExport.version, grant.version);
    assert.equal(projectDelivery.projectExport.hash, projectDelivery.hash);
    assert.equal(readFileSync(projectDelivery.projectExport.path, 'utf8'), deliveryText);
    assert.equal(projectDelivery.projectExport.relativePath, `agent-outputs/${completed.id}/project-delivery.txt`);
    assert.equal(registry.listFiles(grant.id).some(relative => relative.startsWith('agent-outputs/')), false,
      'managed project outputs must not enter source snapshots or source listings');

    const astraEvidence = readTestEvidence(runtime, completed, astra.id);
    const astraPlatforms = new Set(astraEvidence.map(item => item.platform));
    assert.ok(astraPlatforms.has('windows') && astraPlatforms.has('linux'), 'Astra must have passing Windows and Linux evidence');
    assert.ok(astraEvidence.every(item => item.ok === true), 'Astra test evidence must pass');
    const astraSnapshots = new Set(astraEvidence.map(item => item.sourceSnapshotId));
    assert.equal(astraSnapshots.size, 1, 'Astra platform tests must bind to one latest frozen revision');
    for (const task of [edit, verify]) {
      const evidence = readTestEvidence(runtime, completed, task.id);
      assert.ok(evidence.some(item => item.platform === 'linux' && item.ok === true), `Grok ${task.mode} missing passing Linux test evidence`);
      assert.ok(evidence.every(item => item.ok === true), `Grok ${task.mode} test evidence must pass`);
    }
    const editArtifacts = completed.artifacts.filter(artifact => artifact.taskId === edit.id && artifact.kind === 'diff' && artifact.provenance === 'workspace');
    assert.ok(editArtifacts.length > 0, 'Grok edit workspace diff missing');
    for (const artifact of editArtifacts) assert.doesNotMatch(runtime.store.readBlob(completed.id, artifact.relativePath).toString('utf8'), /test-pollution/);
    const integrationArtifacts = completed.artifacts.filter(artifact => artifact.taskId === sol.id && artifact.kind === 'diff' && artifact.provenance === 'workspace');
    assert.ok(integrationArtifacts.length > 0, 'Sol integration diff missing');
    for (const artifact of integrationArtifacts) {
      const diff = runtime.store.readBlob(completed.id, artifact.relativePath).toString('utf8');
      assert.match(diff, /value\.mjs/); assert.doesNotMatch(diff, /test\.mjs|test-pollution/);
    }

    report.workflow = {
      chatId: completed.id, questionTicketId: question.id, finalValue: readFileSync(path.join(fixture, 'value.mjs'), 'utf8'),
      taskRoles: completed.tasks.map(task => ({ id: task.id, parentTaskId: task.parentTaskId, role: task.role, mode: task.mode, status: task.status, disposition: task.disposition })),
      eventCount: events.length, eventHash: crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex'),
      maxConcurrentGrok, claudeReadTaskIds: claudeReads.map(task => task.id), rootGrokBatch,
      astraPlatforms: [...astraPlatforms], astraSourceSnapshotIds: [...astraSnapshots],
      artifacts: completed.artifacts,
      executionPolicy: executionPolicyReceipt,
      projectOutput: projectDelivery.projectExport,
      originalContainsTestPollution: false,
    };
    persist();
    }

    if (cli.cases.has('cancellation')) {
    const cancellation = runtime.create({ title: '真实问题等待取消验收', workspaceId: grant.id });
    chatIds.push(cancellation.id);
    runtime.send(cancellation.id, {
      clientMessageId: randomUUID(), confirmCost: true,
      text: '只调用 ask_user 询问“是否继续？”，选项为“继续”和“停止”，随后等待，不要调用其他工具。',
    });
    const cancelWaiting = await waitFor(runtime, cancellation.id, '取消样本用户问题', chat => !!pendingUserTicket(chat));
    const cancelTicket = pendingUserTicket(cancelWaiting)!;
    runtime.cancel(cancellation.id);
    await runtime.idle(30_000);
    const cancelled = runtime.get(cancellation.id);
    assertClosed(cancelled);
    assert.equal(cancelled.tasks.some(task => task.status !== 'cancelled'), false, 'cancellation chat tasks must be cancelled');
    assert.equal(runtime.activeCount, 0);
    report.cancellation = {
      chatId: cancelled.id, ticketId: cancelTicket.id, ticketStatus: cancelled.tickets.find(ticket => ticket.id === cancelTicket.id)?.status,
      taskStatuses: cancelled.tasks.map(task => task.status), activeCount: runtime.activeCount,
      blockedReason: cancelled.blockedReason ?? null, unsafeProcesses: cancelled.unsafeProcesses ?? [],
    };
    persist();
    }

    if (cli.cases.has('ordinary')) {
    const ordinary = runtime.create({ title: '普通长任务执行策略验收' });
    chatIds.push(ordinary.id);
    runtime.send(ordinary.id, {
      clientMessageId: randomUUID(), confirmCost: true,
      text: [
        '这是一个无工作区、无附件、无需追问的普通长任务执行策略验收。用户给定的全部事实只有：A=3，B=5，总数=8。不得调用 ask_user，不得调用媒体、搜索、MCP、runner、项目文件或其他外部服务，不得臆测额外来源。',
        'Claude 必须建立恰好两个真实工作步骤，分别以 artifact 验收 counts.csv 和 summary.txt；不得增加执行评审步骤。',
        '先 artifact_publish kind=report 的 counts.csv，字节必须逐字为：item,count\\nA,3\\nB,5\\nTOTAL,8\\n。再 artifact_publish kind=report 的 summary.txt，字节必须逐字为：A为3，B为5，总计8。\\n。这里\\n表示真实LF换行，文件中不得写入反斜线字符。用各自真实 artifact ref 完成两个计划步骤。',
        '全部工作步骤完成后，单独 agent_submit 一个 Astra verify，purpose=execution_review、mode=verify。reviewer 必须 execution_read，result_read 完整读取 canonical view 和其中每个 requiredRefs 原始引用，发布自己非空 kind=report 的执行评审报告，再按当前 contractHash/evidenceHash 和恰好覆盖两个工作步骤的 passed verdicts 调用 execution_submit_review，最后 task_complete。',
        'Claude 必须等待 reviewer 安全退出后 collect reviewer、result_read 完整读取 reviewer 原始报告、再 grok_disposition adopted，最后才 task_complete。任何漏页、哈希过期、非 passed 评审、额外子任务、外部调用或退出未确认都不得宣称成功。',
      ].join('\n'),
    });
    const ordinaryCompleted = await waitFor(runtime, ordinary.id, '普通长任务执行策略验收', chat => {
      const root = chat.turns.at(-1) && chat.tasks.find(task => task.id === chat.turns.at(-1)!.rootTaskId);
      return root?.status === 'completed';
    }, SEGMENT_MS * 6, true);
    await runtime.idle(30_000);
    assertClosed(ordinaryCompleted);
    assert.equal(ordinaryCompleted.workspaceId, undefined, 'ordinary workflow must not have a workspace');
    assert.equal(ordinaryCompleted.tickets.some(ticket => ticket.type === 'user'), false, 'ordinary workflow must not ask the user');
    assert.equal(ordinaryCompleted.tasks.length, 2, 'ordinary workflow must contain only Claude root and one Astra execution reviewer');
    const ordinaryRoot = ordinaryCompleted.tasks.find(task => !task.parentTaskId)!;
    const ordinaryReviewer = ordinaryCompleted.tasks.find(task => task.executionReviewOfTaskId === ordinaryRoot.id)!;
    assert.equal(ordinaryRoot.role, 'claude'); assert.equal(ordinaryRoot.executionPolicyVersion, 1);
    assert.equal(ordinaryReviewer.role, 'astra'); assert.equal(ordinaryReviewer.mode, 'verify'); assert.equal(ordinaryReviewer.disposition, 'adopted');
    assert.deepEqual(ordinaryCompleted.tasks.map(task => task.status), ['completed', 'completed']);
    const ordinarySteps = (ordinaryCompleted.todos ?? []).filter(step => step.taskId === ordinaryRoot.id);
    assert.equal(ordinarySteps.length, 2); assert.equal(ordinarySteps.every(step => step.status === 'completed'), true);
    assert.deepEqual(ordinarySteps.map(step => step.verification?.kind), ['artifact', 'artifact']);
    assert.deepEqual(ordinarySteps.map(step => step.verification?.name).sort(), ['counts.csv', 'summary.txt']);
    assert.equal((ordinaryCompleted.todos ?? []).some(step => step.taskId === ordinaryReviewer.id), false, 'execution reviewer must not be a work step');
    const counts = ordinaryCompleted.artifacts.find(artifact => artifact.taskId === ordinaryRoot.id && artifact.name === 'counts.csv');
    const summary = ordinaryCompleted.artifacts.find(artifact => artifact.taskId === ordinaryRoot.id && artifact.name === 'summary.txt');
    assert.ok(counts && summary, 'ordinary workflow artifacts missing');
    const countsText = runtime.store.readBlob(ordinaryCompleted.id, counts.relativePath).toString('utf8');
    const summaryText = runtime.store.readBlob(ordinaryCompleted.id, summary.relativePath).toString('utf8');
    assert.equal(countsText, 'item,count\nA,3\nB,5\nTOTAL,8\n');
    assert.equal(summaryText, 'A为3，B为5，总计8。\n');
    assert.equal(crypto.createHash('sha256').update(Buffer.from(countsText)).digest('hex'), counts.hash);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(summaryText)).digest('hex'), summary.hash);
    assert.equal(counts.bytes, Buffer.byteLength(countsText)); assert.equal(summary.bytes, Buffer.byteLength(summaryText));
    const ordinaryEvents = allEvents(runtime, ordinaryCompleted.id);
    const ordinaryAllowedTools = new Set(['plan_read', 'plan_update', 'artifact_publish', 'agent_submit', 'execution_read', 'result_read',
      'execution_submit_review', 'task_state', 'task_evidence', 'task_yield', 'grok_collect', 'grok_disposition', 'task_complete']);
    const ordinaryForbiddenAttempts = findForbiddenToolAttempts(ordinaryEvents, ordinaryAllowedTools);
    const ordinaryExternalToolsUsed = ordinaryForbiddenAttempts.length > 0;
    assert.equal(ordinaryExternalToolsUsed, false, `ordinary workflow attempted a forbidden tool: ${ordinaryForbiddenAttempts.join(', ')}`);
    const ordinaryRecomputed = executionModule.materializeExecutionView(ordinaryCompleted, ordinaryRoot, runtime.store);
    const ordinaryPolicyReceipt = validateExecutionPolicyReceipt({
      chat: ordinaryCompleted,
      events: ordinaryEvents,
      rootTaskId: ordinaryRoot.id,
      reviewerTaskId: ordinaryReviewer.id,
      recomputedView: ordinaryRecomputed,
      readBlob: ref => runtime!.store.readBlob(ordinaryCompleted.id, ref),
      readFile: fileId => runtime!.files.read(ordinaryCompleted, fileId, true),
    });
    assert.equal(ordinaryCompleted.artifacts.some(artifact => artifact.projectExport !== undefined), false,
      'no-workspace artifacts must remain downloadable without exporting to the previous project');
    assert.equal((ordinaryCompleted.attachments ?? []).some(file => file.projectExport !== undefined), false,
      'no-workspace generated files must not export to the previous project');
    assert.equal(existsSync(path.join(fixture, 'agent-outputs', ordinaryCompleted.id)), false,
      'no-workspace chat must not create a directory in the previous project');
    report.ordinaryWorkflow = {
      chatId: ordinaryCompleted.id,
      rootTaskId: ordinaryRoot.id,
      reviewerTaskId: ordinaryReviewer.id,
      counts: { artifactId: counts.id, ref: counts.relativePath, hash: counts.hash, bytes: counts.bytes },
      summary: { artifactId: summary.id, ref: summary.relativePath, hash: summary.hash, bytes: summary.bytes },
      executionPolicy: ordinaryPolicyReceipt,
      projectOutputs: { exported: false, previousProjectDirectoryCreated: false },
      runtimeCalls: report.invocations.filter(invocation => invocation.chatId === ordinaryCompleted.id)
        .map(invocation => ({ sequence: invocation.sequence, role: invocation.role, taskId: invocation.taskId, invocationId: invocation.invocationId })),
      eventCount: ordinaryEvents.length,
      eventHash: crypto.createHash('sha256').update(JSON.stringify(ordinaryEvents)).digest('hex'),
      externalToolsUsed: ordinaryExternalToolsUsed,
      userQuestionAsked: false,
    };
    persist();
    }

    await runtime.shutdown(30_000);
    await closeServer(server);
    report.passed = true; report.endedAt = at(); persist();
  } catch (error) {
    report.passed = false; report.failure = safeError(error); report.endedAt = at(); persist();
    try { await safeShutdown(runtime, chatIds); }
    catch (shutdownError) { report.failure += `\nSAFE_SHUTDOWN_FAILURE: ${safeError(shutdownError)}`; persist(); }
    throw error;
  } finally {
    await closeServer(server);
  }
}

try {
  await main();
  process.stdout.write(`${JSON.stringify({ reportFile, passed: report.passed, paidInvocationsAttempted: report.paidInvocationsAttempted, nativeCallsReserved: report.nativeCallsReserved, nativeCliInvocations: report.nativeCliInvocations })}\n`);
} catch (error) {
  report.passed = false;
  const failure = safeError(error);
  if (report.failure && !report.failure.includes(failure)) report.failure += `\nFINALIZATION_FAILURE: ${failure}`;
  else report.failure ??= failure;
  report.endedAt = at();
  if (existsSync(reportFile)) persist();
  process.stderr.write(`${JSON.stringify({ reportFile, passed: false, paidInvocationsAttempted: report.paidInvocationsAttempted, nativeCallsReserved: report.nativeCallsReserved, nativeCliInvocations: report.nativeCliInvocations, error: safeError(error) })}\n`);
  process.exitCode = 1;
}

