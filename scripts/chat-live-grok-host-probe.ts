/** 已授权真实 smoke：Grok 仅通过宿主 JSON 工具编辑独立副本并提交受控测试。 */
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig as sourceLoadConfig } from '../src/config.js';
import { loadChatRunners as sourceLoadChatRunners } from '../src/chat/bootstrap.js';
import { runCursorHostTools as sourceRunCursorHostTools } from '../src/chat/drivers.js';
import { WorkspaceGateway as SourceWorkspaceGateway, type WorkspaceToolIdentity } from '../src/chat/gateway.js';
import { runIsolatedCursorRound as sourceRunIsolatedCursorRound } from '../src/chat/cursor-isolated.js';
import { CURSOR_GROK_PRESENTATION_ALIAS as sourceGrokPresentationAlias } from '../src/chat/cursor-model-state.js';
import { runProcess } from '../src/adapters/process.js';
import { SystemWslCursorDenyBridge } from '../src/chat/cursor-deny-bridge.js';
import { ChatStore as SourceChatStore } from '../src/chat/store.js';
import type { AgentTask, DriverInput, Invocation, ToolReply } from '../src/chat/types.js';
import { WorkspaceRegistry as SourceWorkspaceRegistry } from '../src/chat/workspace.js';
import type { CommandSpec, RunnerResult } from '../src/chat/runner.js';
import { dispatchGrokSegment } from './chat-grok-network-preflight.js';

const WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const MAX_MODEL_ROUNDS = 4;
const MAX_TOOL_ACTIONS = 12;
const SEGMENT_MS = 15 * 60_000;
const COMPILED_BINDING_FILES = ['config/workbench.config.json', 'src/config.js', 'src/chat/bootstrap.js', 'src/chat/drivers.js', 'src/chat/gateway.js', 'src/chat/cursor-isolated.js', 'src/chat/cursor-deny-bridge.js', 'src/chat/store.js', 'src/chat/workspace.js', 'src/chat/runner.js'] as const;
const at = () => new Date().toISOString();
const hash = (file: string) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex');

export async function loadGrokHostCandidateRuntime(appRoot?: string) {
  if (!appRoot) return { loadConfig: sourceLoadConfig, loadChatRunners: sourceLoadChatRunners, runCursorHostTools: sourceRunCursorHostTools, WorkspaceGateway: SourceWorkspaceGateway, runIsolatedCursorRound: sourceRunIsolatedCursorRound, ChatStore: SourceChatStore, WorkspaceRegistry: SourceWorkspaceRegistry, presentationAlias: sourceGrokPresentationAlias, source: 'repository' as const };
  const load = (relative: string) => import(pathToFileURL(path.join(appRoot, relative)).href);
  const [config, bootstrap, drivers, gateway, isolated, modelState, store, workspace] = await Promise.all([load('src/config.js'), load('src/chat/bootstrap.js'), load('src/chat/drivers.js'), load('src/chat/gateway.js'), load('src/chat/cursor-isolated.js'), load('src/chat/cursor-model-state.js'), load('src/chat/store.js'), load('src/chat/workspace.js')]);
  for (const [name,value] of Object.entries({ loadConfig:config.loadConfig, loadChatRunners:bootstrap.loadChatRunners, runCursorHostTools:drivers.runCursorHostTools, WorkspaceGateway:gateway.WorkspaceGateway, runIsolatedCursorRound:isolated.runIsolatedCursorRound, ChatStore:store.ChatStore, WorkspaceRegistry:workspace.WorkspaceRegistry })) assert.equal(typeof value,'function',`candidate compiled export missing: ${name}`);
  assert.ok(typeof modelState.CURSOR_GROK_PRESENTATION_ALIAS==='string'&&modelState.CURSOR_GROK_PRESENTATION_ALIAS.trim(), 'candidate compiled presentation alias missing');
  return { loadConfig:config.loadConfig, loadChatRunners:bootstrap.loadChatRunners, runCursorHostTools:drivers.runCursorHostTools, WorkspaceGateway:gateway.WorkspaceGateway, runIsolatedCursorRound:isolated.runIsolatedCursorRound, ChatStore:store.ChatStore, WorkspaceRegistry:workspace.WorkspaceRegistry, presentationAlias:modelState.CURSOR_GROK_PRESENTATION_ALIAS as string, source: 'candidate' as const };
}

export function assertGrokHostInitIdentity(init:unknown,reportedModel:unknown,presentationAlias:unknown):asserts init is {model:string;cwd:string;[key:string]:unknown}{
  assert.ok(init&&typeof init==='object'&&!Array.isArray(init),'Grok init event is required');
  assert.ok(typeof reportedModel==='string'&&reportedModel.trim(),'Grok capability reportedModel is required');
  assert.ok(typeof presentationAlias==='string'&&presentationAlias.trim(),'Grok presentation alias is required');
  const value=init as Record<string,unknown>;
  assert.ok(value.model===reportedModel||value.model===presentationAlias,'Grok init model does not match reportedModel or exact presentation alias');
  assert.equal(value.cwd,'/workspace','Grok init cwd must be /workspace');
}

export function persistGrokCancellationReceipt(target:Record<string,any>,init:unknown,result:Record<string,any>,persist:()=>void):Record<string,any>{
  const receipt={passed:false,init,cancelled:result.cancelled,exitConfirmed:result.exitConfirmed,exitCode:result.exitCode,terminationWarning:result.terminationWarning??null,lifecycle:result.lifecycle,nativeToolDetected:result.nativeToolDetected??false};
  target.cancellation=receipt;persist();return receipt;
}

const runRoot = path.join(WORK_ROOT, `chat-live-grok-host-${at().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`);
const dataRoot = path.join(runRoot, 'data');
const project = path.join(dataRoot, 'work', 'fixture');
const managedRoot = path.join(dataRoot, 'work', 'managed');
const reportFile = path.join(runRoot, 'evidence.json');
const report: Record<string, any> = {
  startedAt: at(), runRoot, model: 'grok-4.7-high-fast', effort: 'high', authorization: 'human user: 我给你授权',
  scope: 'functional host JSON smoke only; no native boundary claim', paidSegmentsAttempted: 0, hostToolActions: 0,
  normal: null, cancellation: null, passed: false,
};
const overallDeadline = Date.now() + SEGMENT_MS;

function normalCli(argv: string[]): { proofDir: string; appRoot?: string; executeLive: boolean } {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: tsx scripts/chat-live-grok-host-probe.ts --proof-dir ABS [--app-root ABS] --execute-live\n       tsx scripts/chat-live-grok-host-probe.ts --resume-tests PRIOR_ROOT LINUX_PROOF\n       tsx scripts/chat-live-grok-host-probe.ts --cancel-only\n');
    process.exit(0);
  }
  let proofDir: string | undefined, appRoot: string | undefined; let executeLive = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--execute-live') { executeLive = true; continue; }
    if (!arg || !['--proof-dir','--app-root'].includes(arg)) throw new Error(`unsupported argument: ${arg ?? '<missing>'}`);
    const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error('--proof-dir requires a value');
    if (arg === '--proof-dir') { if (proofDir) throw new Error('duplicate --proof-dir'); proofDir = path.resolve(value); }
    else { if (appRoot) throw new Error('duplicate --app-root'); appRoot = path.resolve(value); }
  }
  if (!proofDir || !path.isAbsolute(proofDir)) throw new Error('normal live probe requires absolute --proof-dir');
  for (const name of ['runner-wsl.json', 'runner-windows.json']) {
    const file = path.join(proofDir, name); assert.ok(existsSync(file), `runner proof missing: ${name}`);
    const info = lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink(), `runner proof must be regular and not a symlink: ${name}`);
  }
  if (!executeLive) throw new Error('runner proof preflight passed; --execute-live is required before any model dispatch');
  if (appRoot) { assert.ok(path.isAbsolute(appRoot) && existsSync(appRoot) && lstatSync(appRoot).isDirectory() && !lstatSync(appRoot).isSymbolicLink(), '--app-root must be a real directory'); for (const relative of COMPILED_BINDING_FILES) { const file=path.join(appRoot,relative); assert.ok(existsSync(file)&&lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink(),`compiled binding file invalid: ${relative}`); } }
  return { proofDir, ...(appRoot ? { appRoot } : {}), executeLive };
}

function persist(): void {
  mkdirSync(runRoot, { recursive: true });
  const temp = `${reportFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, reportFile);
}

function makeTask(chatId: string, workspaceId: string, workspaceVersion: number): { task: AgentTask; invocation: Invocation } {
  const taskId = `task-${randomUUID()}`; const invocationId = `inv-${randomUUID()}`;
  const task: AgentTask = {
    id: taskId, turnId: `turn-${randomUUID()}`, role: 'grok', mode: 'edit', goal: '把 value 从 1 改为 2 并运行指定测试',
    status: 'running', createdAt: at(), updatedAt: at(), segment: 1, invocationIds: [invocationId], noProgressSegments: 0,
    workspaceId, workspaceVersion,
  };
  const invocation: Invocation = {
    id: invocationId, taskId, segment: 1, status: 'running', startedAt: at(), toolCount: 0,
    promptVersion: 'chat-live-grok-host-v1', inputEstimate: 1, contextWindow: null, contextUsed: null,
  };
  void chatId;
  return { task, invocation };
}

async function main(proofDir: string, appRoot?: string): Promise<void> {
  mkdirSync(WORK_ROOT, { recursive: true });
  const disk = statfsSync(WORK_ROOT);
  assert.ok(disk.bavail * disk.bsize >= 256 * 1024 * 1024, 'work filesystem free space below 256 MiB');
  mkdirSync(path.join(dataRoot, 'capabilities'), { recursive: true }); mkdirSync(path.join(dataRoot, 'work'), { recursive: true }); mkdirSync(project, { recursive: true });
  for (const name of ['runner-wsl.json', 'runner-windows.json']) copyFileSync(path.join(proofDir, name), path.join(dataRoot, 'capabilities', name));
  writeFileSync(path.join(project, 'value.mjs'), 'export const value = 1;\n', { flag: 'wx' });
  writeFileSync(path.join(project, 'test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { writeFile } from 'node:fs/promises';",
    "const { value } = await import('./value.mjs');",
    "assert.equal(value, 2);",
    "await writeFile('test-pollution.txt', 'derived-copy-only');",
    "process.stdout.write('GROK_HOST_TEST_OK');",
  ].join('\n') + '\n', { flag: 'wx' });
  persist();

  const runtime = await loadGrokHostCandidateRuntime(appRoot);
  const config = appRoot ? runtime.loadConfig(path.join(appRoot,'config/workbench.config.json'),appRoot) : runtime.loadConfig();
  const isolation = config.adapters.cursorWriter.capabilities;
  assert.ok(isolation, 'verified Cursor WSL capabilities missing');
  assert.equal(config.models.grok.model, 'grok-4.7-high-fast'); assert.equal(config.models.grok.effort, 'high');
  const networkPreflightDeps = { runtimeFile: appRoot ? path.join(appRoot, 'src/adapters/cursor-writer-runtime.mjs') : path.resolve('src/adapters/cursor-writer-runtime.mjs') };
  const loaded = runtime.loadChatRunners(dataRoot);
  assert.ok(loaded.runner, `runner unavailable: ${JSON.stringify(loaded.availability)}`);
  const commands = loaded.runner.commandInfo();
  const linux = commands.find((command: CommandSpec) => command.platform === 'linux');
  assert.ok(linux, `verified Linux runner unavailable: ${JSON.stringify(loaded.availability)}`);
  assert.ok(commands.some((command: CommandSpec) => command.platform === 'windows'), `verified Windows runner unavailable: ${JSON.stringify(loaded.availability)}`);
  report.preflight = {
    completedAt: at(), proofDir, dataRoot, workRoot: path.join(dataRoot, 'work'), fixture: project, managedRoot,
    ...(appRoot ? { appRoot, compiledFiles: Object.fromEntries(COMPILED_BINDING_FILES.map(relative=>[relative,hash(path.join(appRoot,relative))])) } : {}),
    presentationAliasBinding: { value: runtime.presentationAlias, module: appRoot ? 'src/chat/cursor-model-state.js' : 'src/chat/cursor-model-state.ts', sha256: hash(path.join(appRoot ?? path.resolve(), appRoot ? 'src/chat/cursor-model-state.js' : 'src/chat/cursor-model-state.ts')) },
    fixtureInsideWorkRoot: path.relative(path.join(dataRoot, 'work'), project), runnerAvailability: loaded.availability,
    proofHashes: Object.fromEntries(['runner-wsl.json', 'runner-windows.json'].map(name => [name, {
      source: hash(path.join(proofDir, name)), copied: hash(path.join(dataRoot, 'capabilities', name)),
    }])),
  };
  assert.ok(!String(report.preflight.fixtureInsideWorkRoot).startsWith('..') && !path.isAbsolute(String(report.preflight.fixtureInsideWorkRoot)), 'fixture escaped dataRoot/work');
  persist();

  const registry = new runtime.WorkspaceRegistry(managedRoot);
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  const gateway = new runtime.WorkspaceGateway(registry, loaded.runner);
  const store = new runtime.ChatStore(dataRoot);
  const chat = store.create({ title: 'Grok 宿主 JSON 真实 smoke', workspaceId: grant.id });
  const { task, invocation } = makeTask(chat.id, grant.id, grant.version);
  chat.tasks.push(task); chat.invocations.push(invocation); store.save(chat);
  const controller = new AbortController();
  const identity: WorkspaceToolIdentity = { chat, task, invocation, signal: controller.signal };
  const toolReceipts: Record<string, unknown>[] = []; const roundReceipts: Record<string, unknown>[] = [];
  report.trace = { rounds: roundReceipts, hostTools: toolReceipts };
  let completedRounds = 0;
  const tools = gateway.definitions.filter((tool: { name: string }) => ['file_read', 'file_write', 'test_submit'].includes(tool.name));
  const input: DriverInput = {
    chatId: chat.id, task, invocation, directory: store.invocationDirectory(chat.id, invocation.id), signal: controller.signal,
    systemPrompt: '这是普通功能 smoke。只使用宿主 JSON 协议；禁止使用 Cursor 自身工具。严格依次调用 file_read、file_write、test_submit。test_submit 返回 wait 后立即结束。',
    prompt: [
      '目标文件 value.mjs 当前导出 value=1。',
      '第一步调用 file_read 读取 value.mjs 并取得 hash。',
      '第二步调用 file_write，把内容精确改为：export const value = 2;\\n，并使用刚取得的 expectedHash。',
      `第三步调用 test_submit：executable=${linux.executablePaths[0]}，platform=linux，args=["test.mjs"]，cwd="."，timeoutMs=30000。`,
      '每一轮只返回一个严格 JSON 对象；不要解释，不要提前返回 result。',
    ].join('\n'),
    tools, onText: () => undefined,
    callTool: async (name: string, args: unknown): Promise<ToolReply> => {
      assert.ok(report.hostToolActions < MAX_TOOL_ACTIONS, 'host tool action limit exceeded');
      assert.ok(completedRounds > toolReceipts.length, 'host tool called before its CLI round safely exited');
      report.hostToolActions += 1;
      const startedAt = at(); const reply = await gateway.call(name, args, identity);
      toolReceipts.push({ sequence: toolReceipts.length + 1, name, args, startedAt, afterExitedRound: completedRounds, reply });
      persist(); return reply;
    },
  };

  const normal = await runtime.runCursorHostTools(input, isolation, async (options:any) => {
    if (report.paidSegmentsAttempted >= MAX_MODEL_ROUNDS) throw new Error('normal model round limit exceeded');
    const remaining = overallDeadline - Date.now(); if (remaining <= 0) throw new Error('overall 15 minute budget exhausted');
    return dispatchGrokSegment(report, persist, isolation, async () => {
      const dispatchRemaining = overallDeadline - Date.now(); if (dispatchRemaining <= 0) throw new Error('overall 15 minute budget exhausted after network preflight');
      const startedAt = at(); const result = await runtime.runIsolatedCursorRound({ ...options, timeoutMs: Math.min(options.timeoutMs, dispatchRemaining) }); completedRounds += 1;
      roundReceipts.push({ round: completedRounds, startedAt, endedAt: at(), exitConfirmed: result.exitConfirmed, exitCode: result.exitCode,
        cancelled: result.cancelled, timedOut: result.timedOut, terminationWarning: result.terminationWarning ?? null,
        nativeToolDetected: result.nativeToolDetected ?? false, lifecycle: result.lifecycle });
      persist(); return result;
    }, networkPreflightDeps);
  });
  assert.equal(normal.finishReason, 'wait', JSON.stringify(normal));
  assert.deepEqual(toolReceipts.map(receipt => receipt.name), ['file_read', 'file_write', 'test_submit']);
  assert.equal(readFileSync(path.join(project, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(existsSync(path.join(project, 'test-pollution.txt')), false);
  invocation.status = 'exited'; invocation.exitConfirmed = normal.exitConfirmed; invocation.finishReason = normal.finishReason; invocation.endedAt = at();
  const testReceipts = await gateway.afterInvocation(identity, normal.exitConfirmed);
  report.normal = { passed: false, driver: normal, rounds: roundReceipts, hostToolReceipts: toolReceipts, testReceipts,
    original: { valueSha256: hash(path.join(project, 'value.mjs')), unchanged: readFileSync(path.join(project, 'value.mjs'), 'utf8') === 'export const value = 1;\n', testPollutionAbsent: !existsSync(path.join(project, 'test-pollution.txt')) },
    runnerAvailability: loaded.availability };
  persist();
  assert.equal(testReceipts.length, 1);
  const testData = testReceipts[0]!.reply.data as { ok: boolean; platform: string; sourceSnapshotId: string; testSnapshotId: string; result: { stdoutTail?: string; terminationWarning?: string } };
  assert.equal(testData.ok, true, JSON.stringify(testData)); assert.equal(testData.platform, 'linux');
  assert.equal(testData.result.stdoutTail, 'GROK_HOST_TEST_OK'); assert.equal(testData.result.terminationWarning, undefined);
  assert.equal(readFileSync(path.join(project, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(existsSync(path.join(project, 'test-pollution.txt')), false);
  const sourceMetadata = JSON.parse(readFileSync(path.join(managedRoot, 'snapshots', testData.sourceSnapshotId, 'snapshot.json'), 'utf8')) as { path: string; files: Record<string, string> };
  assert.equal(readFileSync(path.join(sourceMetadata.path, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
  const artifacts = await gateway.takeArtifacts(identity);
  assert.equal(artifacts.length, 1); assert.match(artifacts[0]!.text, /modified: value\.mjs/); assert.doesNotMatch(artifacts[0]!.text, /test-pollution/);
  task.status = 'completed'; store.save(chat);
  report.normal = {
    passed: true, driver: normal, rounds: roundReceipts, hostToolReceipts: toolReceipts, testReceipts, programDiff: artifacts,
    original: { valueSha256: hash(path.join(project, 'value.mjs')), unchanged: true, testPollutionAbsent: true },
    frozenSource: { snapshotId: testData.sourceSnapshotId, metadata: sourceMetadata, value: 'export const value = 2;\\n' },
    runnerAvailability: loaded.availability,
  };
  persist();

  const cancelController = new AbortController(); let initSeen = false; let cancelInit: Record<string, unknown> | null = null;
  const cancelBudget = overallDeadline - Date.now(); if (cancelBudget <= 0) throw new Error('overall 15 minute budget exhausted before cancellation');
  const cancelResult = await dispatchGrokSegment(report, persist, isolation, async () => {
    const dispatchRemaining = overallDeadline - Date.now(); if (dispatchRemaining <= 0) throw new Error('overall 15 minute budget exhausted after cancellation network preflight');
    return runtime.runIsolatedCursorRound({
      capabilities: isolation, signal: cancelController.signal, timeoutMs: Math.min(60_000, dispatchRemaining),
      prompt: '这是取消生命周期 smoke。不要调用任何工具，只返回 {"result":"cancel"}。',
      stdoutLogPath: path.join(runRoot, 'cancel.stdout.jsonl'), stderrLogPath: path.join(runRoot, 'cancel.stderr.log'),
      onStdoutLine(line: string) {
        let event: any; try { event = JSON.parse(line); } catch { return; }
        if (!initSeen && event.type === 'system' && event.subtype === 'init') {
          initSeen = true; cancelInit = { model: event.model, cwd: event.cwd, apiKeySource: event.apiKeySource ?? null }; cancelController.abort();
        }
      },
    });
  }, networkPreflightDeps);
  const observedCancelInit = cancelInit as Record<string, unknown> | null;
  const cancellation=persistGrokCancellationReceipt(report,cancelInit,cancelResult,persist);
  assert.equal(initSeen, true); assertGrokHostInitIdentity(observedCancelInit,isolation.reportedModel,runtime.presentationAlias);
  assert.equal(cancelResult.cancelled, true); assert.equal(cancelResult.exitConfirmed, true); assert.equal(cancelResult.terminationWarning, undefined);
  cancellation.passed=true;
  report.completedAt = at(); report.passed = true; persist();
  process.stdout.write(`${JSON.stringify({ reportFile, passed: true, paidSegmentsAttempted: report.paidSegmentsAttempted,
    normalRounds: roundReceipts.length, hostToolActions: report.hostToolActions, cancellation: true })}\n`);
}

async function resumeTests(priorRoot: string, linuxProof: string): Promise<void> {
  priorRoot = path.resolve(priorRoot); linuxProof = path.resolve(linuxProof);
  const output = path.join(priorRoot, 'resume-tests.json');
  const resumeData = path.join(priorRoot, 'resume-runner');
  const postmortemFile = path.join(priorRoot, 'postmortem.json');
  const originalEvidenceFile = path.join(priorRoot, 'evidence.json');
  const post = JSON.parse(readFileSync(postmortemFile, 'utf8')) as any;
  assert.equal(post.actualModelSegments, 3); assert.equal(post.hostToolActions, 3);
  for (const round of post.rounds as any[]) assert.equal(hash(round.file), round.sha256, `raw event hash drifted: ${round.file}`);
  const request = post.rounds[2]?.hostEnvelope;
  assert.equal(request?.tool, 'test_submit'); assert.deepEqual(request.arguments.args, ['test.mjs']); assert.equal(request.arguments.platform, 'linux');
  const store = new SourceChatStore(path.join(priorRoot, 'chat-store'));
  const chats = store.list(); assert.equal(chats.length, 1);
  const chat = store.get(chats[0]!.id); assert.equal(chat.tasks.length, 1); assert.equal(chat.invocations.length, 1);
  const task = chat.tasks[0]!; const invocation = chat.invocations[0]!;
  assert.equal(task.role, 'grok'); assert.equal(task.mode, 'edit'); assert.equal(invocation.taskId, task.id);
  assert.ok((post.rounds as any[]).every(round => String(round.file).includes(chat.id) && String(round.file).includes(invocation.id)));
  const snapshotId = String(post.testReceipt.sourceSnapshotId);
  const snapshotFile = path.join(priorRoot, 'managed', 'snapshots', snapshotId, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as { id: string; taskId: string; path: string; files: Record<string, string> };
  assert.equal(snapshot.id, snapshotId); assert.equal(snapshot.taskId, task.id); assert.equal(path.resolve(snapshot.path), path.resolve(post.frozenEdit.path, '..'));
  for (const [name, expected] of Object.entries(snapshot.files)) assert.equal(hash(path.join(snapshot.path, name)), expected, `frozen snapshot drifted: ${name}`);

  mkdirSync(path.join(resumeData, 'capabilities'), { recursive: true }); mkdirSync(path.join(resumeData, 'work'), { recursive: true });
  copyFileSync(linuxProof, path.join(resumeData, 'capabilities', 'runner-wsl.json'));
  copyFileSync(path.join(priorRoot, 'data', 'capabilities', 'runner-windows.json'), path.join(resumeData, 'capabilities', 'runner-windows.json'));
  const loaded = sourceLoadChatRunners(resumeData); assert.ok(loaded.runner, JSON.stringify(loaded.availability));
  const commands = loaded.runner.commandInfo();
  for (const platform of ['linux', 'windows'] as const) assert.ok(commands.some(command => command.platform === platform), `${platform} runner unavailable: ${JSON.stringify(loaded.availability)}`);
  const resumed: Record<string, any> = {
    createdAt: at(), kind: 'no-model-resume-of-real-test-submit', paidModelSegments: 0,
    prior: { root: priorRoot, evidenceFile: originalEvidenceFile, evidenceSha256: hash(originalEvidenceFile), postmortemFile, postmortemSha256: hash(postmortemFile) },
    identity: { chatId: chat.id, taskId: task.id, invocationId: invocation.id, workspaceId: task.workspaceId, workspaceVersion: task.workspaceVersion },
    source: { snapshotId, metadataFile: snapshotFile, metadataSha256: hash(snapshotFile), path: snapshot.path, files: snapshot.files },
    originalRequest: request, linuxProof: { file: linuxProof, sha256: hash(linuxProof) }, availability: loaded.availability,
    results: [] as any[], passed: false,
  };
  const save = () => { const temp = `${output}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(resumed, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, output); };
  save();
  try {
    for (const platform of ['linux', 'windows'] as const) {
      const command = commands.find(candidate => candidate.platform === platform)!;
      const derived = path.join(resumeData, 'work', `derived-${platform}-${randomUUID()}`);
      cpSync(snapshot.path, derived, { recursive: true, errorOnExist: true, force: false });
      const executable = platform === 'linux' ? String(request.arguments.executable) : command.executablePaths[0]!;
      const spec: CommandSpec = {
        executable, args: [...request.arguments.args], cwd: path.resolve(derived, String(request.arguments.cwd ?? '.')),
        env: request.arguments.env ?? {}, timeoutMs: Number(request.arguments.timeoutMs), network: 'none', platform,
      };
      const ticket = loaded.runner.issueTicket(invocation.id, spec, derived);
      const result: RunnerResult = await loaded.runner.run(ticket, invocation.id);
      const passed: boolean = result.exitCode === 0 && !result.spawnError && !result.timedOut && !result.cancelled && !result.terminationWarning && result.stdoutTail === 'GROK_HOST_TEST_OK';
      resumed.results.push({ platform, ticket, identityInvocationId: invocation.id, derived, effectiveRequest: spec, result, passed,
        derivedTestPollution: existsSync(path.join(derived, 'test-pollution.txt')) });
      save(); assert.equal(passed, true, JSON.stringify(result));
      for (const [name, expected] of Object.entries(snapshot.files)) assert.equal(hash(path.join(snapshot.path, name)), expected, `frozen source changed after ${platform}: ${name}`);
    }
    resumed.passed = true; resumed.completedAt = at(); save();
    process.stdout.write(`${JSON.stringify({ output, passed: true, platforms: resumed.results.map((item: any) => item.platform), paidModelSegments: 0 })}\n`);
  } catch (error) {
    resumed.completedAt = at(); resumed.failure = error instanceof Error ? error.stack : String(error); save(); throw error;
  }
}

async function cancelOnly(): Promise<void> {
  const root = path.join(WORK_ROOT, `chat-live-grok-cancel-${at().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`);
  const output = path.join(root, 'evidence.json'); mkdirSync(root, { recursive: true });
  const config = sourceLoadConfig(); const capabilities = config.adapters.cursorWriter.capabilities;
  assert.ok(capabilities); assert.equal(config.models.grok.model, 'grok-4.7-high-fast'); assert.equal(config.models.grok.effort, 'high');
  class RecordingBridge extends SystemWslCursorDenyBridge {
    guestRoot: string | null = null;
    override async setup(...args: Parameters<SystemWslCursorDenyBridge['setup']>): Promise<void> { this.guestRoot = args[1]; await super.setup(...args); }
  }
  const bridge = new RecordingBridge(); const controller = new AbortController();
  let init: Record<string, unknown> | null = null; let initCount = 0;
  const implementation = [
    'src/chat/cursor-isolated.ts', 'src/chat/cursor-deny-bridge.ts',
    'src/adapters/cursor-writer.ts', 'src/adapters/cursor-writer-runtime.mjs',
  ].map(relative => ({ relative, sha256: hash(path.resolve(relative)) }));
  const evidence: Record<string, any> = {
    startedAt: at(), kind: 'authorized-grok-init-start-cancellation-only', model: config.models.grok.model, effort: config.models.grok.effort,
    paidSegmentsAttempted: 0, hostToolActions: 0, timeoutMs: 60_000,
    capability: { verifiedAt: capabilities.verifiedAt, cliVersion: capabilities.cliVersion, reportedModel: capabilities.reportedModel,
      distro: capabilities.distro, machineId: capabilities.machineId, nodeSha256: capabilities.nodeSha256, entrySha256: capabilities.entrySha256,
      bwrapSha256: capabilities.bwrapSha256, setsidSha256: capabilities.setsidSha256 },
    implementation, passed: false,
  };
  const save = () => { const temp = `${output}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, output); };
  save();
  try {
    const result = await dispatchGrokSegment(evidence, save, capabilities, async () => sourceRunIsolatedCursorRound({
        capabilities, bridge, signal: controller.signal, timeoutMs: 60_000,
        prompt: '这是已授权的取消生命周期验收。不得调用任何工具；保持运行直到宿主取消。',
        stdoutLogPath: path.join(root, 'cancel.stdout.jsonl'), stderrLogPath: path.join(root, 'cancel.stderr.log'),
        onStdoutLine(line) {
          let event: any; try { event = JSON.parse(line); } catch { return; }
          if (event.type === 'system' && event.subtype === 'init') {
            initCount += 1;
            if (initCount === 1) { init = { model: event.model, cwd: event.cwd, sessionId: event.session_id, apiKeySource: event.apiKeySource ?? null }; controller.abort(); }
          }
        },
      }),
    );
    const observed = init as Record<string, unknown> | null;
    const cancellation=persistGrokCancellationReceipt(evidence,init,result,save);
    assert.equal(initCount, 1); assertGrokHostInitIdentity(observed,capabilities.reportedModel,sourceGrokPresentationAlias); assert.ok(observed.sessionId);
    assert.equal(result.cancelled, true); assert.equal(result.exitConfirmed, true); assert.equal(result.timedOut, false); assert.equal(result.terminationWarning, undefined);
    assert.equal(result.nativeToolDetected, false); assert.ok(result.lifecycle?.confirmed); assert.ok(result.lifecycle?.supervisorGone); assert.ok(result.lifecycle?.bwrapGone); assert.deepEqual(result.lifecycle?.remaining, []);
    assert.ok(bridge.guestRoot);
    const absence = await runProcess({ file: 'C:\\Windows\\System32\\wsl.exe', prefixArgs: [], via: 'config' }, [
      '-d', capabilities.distro, '--cd', '/home/codex', '--exec', capabilities.nodePath, '--input-type=module', '-e',
      "import fs from 'node:fs';process.stdout.write(JSON.stringify(!fs.existsSync(process.argv[1])))", bridge.guestRoot,
    ], { cwd: process.cwd(), timeoutMs: 15_000, stdinText: null,
      env: Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    });
    const rootRemoved = absence.exitCode === 0 && !absence.spawnError && !absence.timedOut && !absence.terminationWarning && absence.stdoutTail.trim() === 'true';
    assert.equal(rootRemoved, true, 'controlled UUID root remained after cleanup');
    cancellation.passed=true;
    evidence.result = { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled,
      spawnError: result.spawnError, durationMs: result.durationMs, exitConfirmed: result.exitConfirmed,
      terminationWarning: result.terminationWarning ?? null, lifecycle: result.lifecycle, nativeToolDetected: result.nativeToolDetected ?? false };
    evidence.init = observed; evidence.guestRoot = bridge.guestRoot; evidence.guestRootRemoved = rootRemoved;
    evidence.raw = { stdout: path.join(root, 'cancel.stdout.jsonl'), stdoutSha256: hash(path.join(root, 'cancel.stdout.jsonl')),
      stderr: path.join(root, 'cancel.stderr.log'), stderrSha256: hash(path.join(root, 'cancel.stderr.log')), stderrBytes: readFileSync(path.join(root, 'cancel.stderr.log')).length };
    evidence.completedAt = at(); evidence.passed = true; save();
    process.stdout.write(`${JSON.stringify({ output, passed: true, paidSegmentsAttempted: 1, hostToolActions: 0, guestRootRemoved: true })}\n`);
  } catch (error) {
    evidence.completedAt = at(); evidence.failure = error instanceof Error ? error.stack : String(error); evidence.init = init; evidence.guestRoot = bridge.guestRoot; save(); throw error;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain && process.argv[2] === '--resume-tests') {
  try { await resumeTests(process.argv[3]!, process.argv[4]!); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
} else if (isMain && process.argv[2] === '--cancel-only') {
  try { await cancelOnly(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
} else if (isMain) {
  try {
    const cli = normalCli(process.argv.slice(2)); if (cli.appRoot) report.appRoot=cli.appRoot; persist(); await main(cli.proofDir,cli.appRoot);
  }
  catch (error) {
    report.completedAt = at(); report.passed = false; report.failure = error instanceof Error ? error.stack : String(error); persist();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
  }
}
