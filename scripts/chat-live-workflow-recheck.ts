/** Recorded r9 workflow postflight plus one optional, fresh cancellation continuation. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkbenchConfig } from '../src/config.js';
import type { ChatDriver, ChatRecord, ChatRole, CliChatRole, DriverInput, DriverResult, WaitTicket } from '../src/chat/types.js';
import type { ChatRuntime as ChatRuntimeType } from '../src/chat/runtime.js';
import { validateRecordedWorkflow } from './chat-workflow-recorded-postflight.js';
import { validateCancelledAskUserReceipt } from './chat-workflow-event-receipts.js';

const WORK_ROOT = path.resolve(process.env.DMW_WORK_ROOT ?? 'work');
const at = () => new Date().toISOString();
type ClaudeJobResult = { timedOut: boolean; spawnError: string | null; terminationWarning?: string; windowsJob?: {
  confirmed: boolean; rootExited: boolean; jobActiveProcesses: number | null; cancelReceived: boolean; targetPid: number | null;
} };

function sourceTreeManifest(root: string): { digest: string; fileCount: number; directoryCount: number } {
  const entries: ({ path: string; type: 'directory' } | { path: string; type: 'file'; size: number; sha256: string })[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name); const info = lstatSync(absolute);
      assert.equal(info.isSymbolicLink(), false, `source tree contains symlink: ${path.relative(root, absolute)}`);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (info.isDirectory()) { entries.push({ path: relative, type: 'directory' }); visit(absolute); }
      else if (info.isFile()) entries.push({ path: relative, type: 'file', size: info.size, sha256: hash(readFileSync(absolute)) });
      else throw new Error(`source tree contains non-regular entry: ${path.relative(root, absolute)}`);
    }
  };
  visit(root);
  return { digest: hash(JSON.stringify(entries)), fileCount: entries.filter(item => item.type === 'file').length, directoryCount: entries.filter(item => item.type === 'directory').length };
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function parseCli(argv: string[]): { sourceEvidence: string; outputRoot: string; executeLive: boolean } {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: tsx scripts/chat-live-workflow-recheck.ts --source-evidence ABS [--output-root ABS] [--execute-live]\n');
    process.exit(0);
  }
  let sourceEvidence = ''; let outputRoot = ''; let executeLive = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--execute-live') { executeLive = true; continue; }
    const value = argv[++i]; if (!value) throw new Error(`${arg} missing value`);
    if (arg === '--source-evidence') sourceEvidence = path.resolve(value);
    else if (arg === '--output-root') outputRoot = path.resolve(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!sourceEvidence) throw new Error('--source-evidence is required');
  if (!outputRoot) outputRoot = path.join(WORK_ROOT, `chat-live-workflow-recheck-${at().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`);
  return { sourceEvidence, outputRoot, executeLive };
}

const cli = parseCli(process.argv.slice(2));
if (existsSync(cli.outputRoot)) throw new Error(`output root already exists: ${cli.outputRoot}`);
const evidenceFile = path.join(cli.outputRoot, 'evidence.json');
const source = JSON.parse(readFileSync(cli.sourceEvidence, 'utf8')) as { appRoot: string; proofDir: string; paidInvocationsAttempted: number };
const report: Record<string, unknown> = {
  schema: 'dual-model-workbench/workflow-recorded-recheck/v1', startedAt: at(), sourceEvidence: cli.sourceEvidence,
  sourceEvidencePassed: false, originalReportPreservedFailed: true, executeLive: cli.executeLive, offlineOnly: !cli.executeLive, readyForLive: false,
  sourcePaidInvocations: source.paidInvocationsAttempted, newPaidInvocationsAttempted: 0, cumulativePaidInvocations: source.paidInvocationsAttempted,
  realModelCalls: 0, cancellation: null, originalReportPassed: false, originalWorkflowRecheckPassed: false,
  compositePassed: false, passed: false,
};

function persist(): void { mkdirSync(cli.outputRoot, { recursive: true }); writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`); }
function safeError(error: unknown): string { return error instanceof Error ? error.stack ?? error.message : String(error); }
function moduleUrl(relative: string): string { return pathToFileURL(path.join(source.appRoot, relative.replaceAll('/', path.sep))).href; }
function pendingQuestion(chat: ChatRecord): WaitTicket | undefined { return chat.tickets.find(item => item.type === 'user' && item.status === 'pending'); }
function assertClosed(chat: ChatRecord): void {
  assert.equal(chat.blockedReason, undefined); assert.deepEqual(chat.unsafeProcesses ?? [], []);
  assert.equal(chat.tickets.some(item => item.status === 'pending'), false);
  assert.equal(chat.invocations.some(item => item.status !== 'exited' || item.exitConfirmed !== true), false);
}
function allEvents(runtime: ChatRuntimeType, chatId: string): import('../src/chat/types.js').ChatEvent[] {
  const events: import('../src/chat/types.js').ChatEvent[] = []; let since = 0;
  for (;;) { const page = runtime.store.events(chatId, since, 500); events.push(...page.items); if (!page.hasMore) return events; since = page.next; }
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); return address.port;
}
async function reservePort(): Promise<number> {
  const temporary = createServer(); const port = await listen(temporary); await close(temporary); return port;
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
async function waitForQuestion(runtime: ChatRuntimeType, chatId: string): Promise<{ chat: ChatRecord; ticket: WaitTicket }> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const chat = runtime.get(chatId); const ticket = pendingQuestion(chat);
    if (chat.blockedReason || chat.unsafeProcesses?.length || chat.tasks.some(task => ['failed', 'interrupted'].includes(task.status))) throw new Error('fresh cancellation chat entered an unsafe state');
    if (ticket) return { chat, ticket };
    if (Date.now() >= deadline) throw new Error('fresh cancellation question timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function runCancellation(): Promise<void> {
  const dataRoot = path.join(cli.outputRoot, 'cancel-data'); assert.equal(existsSync(dataRoot), false);
  const capabilitiesRoot = path.join(dataRoot, 'capabilities'); const workRoot = path.join(dataRoot, 'work');
  mkdirSync(capabilitiesRoot, { recursive: true }); mkdirSync(workRoot, { recursive: true });
  for (const name of ['models.json', 'runner-windows.json', 'runner-wsl.json']) copyFileSync(path.join(source.proofDir, name), path.join(capabilitiesRoot, name));
  const configModule = await import(moduleUrl('src/config.js')) as typeof import('../src/config.js');
  const bootstrapModule = await import(moduleUrl('src/chat/bootstrap.js')) as typeof import('../src/chat/bootstrap.js');
  const driversModule = await import(moduleUrl('src/chat/drivers.js')) as typeof import('../src/chat/drivers.js');
  const gatewayModule = await import(moduleUrl('src/chat/gateway.js')) as typeof import('../src/chat/gateway.js');
  const httpModule = await import(moduleUrl('src/chat/http.js')) as typeof import('../src/chat/http.js');
  const runtimeModule = await import(moduleUrl('src/chat/runtime.js')) as typeof import('../src/chat/runtime.js');
  const storeModule = await import(moduleUrl('src/chat/store.js')) as typeof import('../src/chat/store.js');
  const workspaceModule = await import(moduleUrl('src/chat/workspace.js')) as typeof import('../src/chat/workspace.js');
  const config: WorkbenchConfig = configModule.loadConfig(path.join(source.appRoot, 'config', 'workbench.config.json'), source.appRoot);
  const loaded = bootstrapModule.loadChatRunners(dataRoot); assert.ok(loaded.runner && loaded.availability.available);
  const fixture = path.join(workRoot, 'fixture'); mkdirSync(fixture, { recursive: true });
  writeFileSync(path.join(fixture, 'public.txt'), 'PUBLIC_CANCELLATION_FIXTURE\n', { flag: 'wx' });
  const registry = new workspaceModule.WorkspaceRegistry(path.join(workRoot, 'managed'));
  const grant = registry.grantFromNativeSelection(fixture, registry.issueNativeSelectionRequest());
  const gateway = new gatewayModule.WorkspaceGateway(registry, loaded.runner);
  const store = new storeModule.ChatStore(dataRoot); const bridgeToken = randomBytes(32).toString('hex'); const port = await reservePort();
  const httpOptions: import('../src/chat/http.js').ChatHttpOptions = { bridgeToken, port, dataRoot, registry, runner: loaded.availability };
  const chatHttp = httpModule.createChatHttp(httpOptions);
  const server = createServer(async (request, response) => {
    try {
      if (!await chatHttp(request, response)) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"not_found"}'); }
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500;
      if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: status === 500 ? 'internal_error' : 'request_rejected' }));
    }
  });
  let runtime: ChatRuntimeType | undefined; let chatId = ''; const claudeJobs: ClaudeJobResult[] = [];
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const production = driversModule.createChatDrivers(config, {
      bridgeUrl: `http://127.0.0.1:${port}`, bridgeToken, capabilitiesFile: path.join(capabilitiesRoot, 'models.json'),
      onClaudeProcessResult: result => claudeJobs.push(result as ClaudeJobResult),
    });
    for (const role of ['claude', 'astra', 'sol', 'grok'] as const) assert.ok(production[role].capability.available && production[role].capability.isolationVerified);
    const drivers = Object.fromEntries((Object.keys(production) as CliChatRole[]).map(role => [role, {
      capability: production[role].capability,
      async invoke(input: DriverInput): Promise<DriverResult> {
        assert.equal(role, 'claude', 'fresh cancellation must not dispatch a non-Claude role');
        assert.equal(report.newPaidInvocationsAttempted, 0, 'fresh cancellation permits exactly one new invocation');
        report.newPaidInvocationsAttempted = 1; report.realModelCalls = 1; report.cumulativePaidInvocations = source.paidInvocationsAttempted + 1; persist();
        const result = await production[role].invoke(input); assert.equal(result.exitConfirmed, true); return result;
      },
    } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
    runtime = new runtimeModule.ChatRuntime({ store, drivers, workspace: gateway, requireCostConfirmation: true }); httpOptions.runtime = runtime;
    const chat = runtime.create({ title: 'recorded workflow missing cancellation continuation', workspaceId: grant.id }); chatId = chat.id;
    runtime.send(chat.id, { clientMessageId: randomUUID(), confirmCost: true, text: '只调用 ask_user 询问“是否继续？”，选项为“继续”和“停止”，随后等待，不要调用其他工具。' });
    const waiting = await waitForQuestion(runtime, chat.id); runtime.cancel(chat.id); await runtime.idle(30_000);
    const cancelled = runtime.get(chat.id); assertClosed(cancelled); assert.equal(cancelled.tasks.some(task => task.status !== 'cancelled'), false); assert.equal(runtime.activeCount, 0);
    const cancelEvents = allEvents(runtime, chat.id);
    const askUserProgramReceipt = validateCancelledAskUserReceipt(cancelEvents, cancelled, '是否继续？', ['继续', '停止']);
    assert.equal(askUserProgramReceipt.ticketId, waiting.ticket.id);
    assert.equal(claudeJobs.length, 1, 'fresh cancellation must produce exactly one Claude Job receipt');
    const job = claudeJobs[0]!; assert.equal(job.timedOut, false); assert.equal(job.spawnError, null); assert.equal(job.terminationWarning, undefined);
    assert.ok(job.windowsJob && job.windowsJob.confirmed && job.windowsJob.rootExited && job.windowsJob.jobActiveProcesses === 0 && job.windowsJob.cancelReceived && Number.isInteger(job.windowsJob.targetPid) && job.windowsJob.targetPid! > 0,
      'fresh cancellation Windows Job must confirm CANCEL, root exit, and zero active processes');
    await runtime.shutdown(30_000); await close(server);
    report.cancellation = { dataRoot, chatId, ticketId: waiting.ticket.id, ticketStatus: cancelled.tickets.find(item => item.id === waiting.ticket.id)?.status,
      taskStatuses: cancelled.tasks.map(task => task.status), invocationExitConfirmed: cancelled.invocations.every(item => item.status === 'exited' && item.exitConfirmed === true),
      askUserProgramReceipt,
      activeCount: runtime.activeCount, blockedReason: cancelled.blockedReason ?? null, unsafeProcesses: cancelled.unsafeProcesses ?? [], serverClosed: !server.listening };
    (report.cancellation as Record<string, unknown>).windowsJob = job.windowsJob;
    (report.cancellation as Record<string, unknown>).processResult = {
      timedOut: job.timedOut, spawnError: job.spawnError,
      terminationWarningPresent: Object.prototype.hasOwnProperty.call(job, 'terminationWarning'),
      terminationWarning: job.terminationWarning ?? null,
      optionalTerminationWarningContract: 'RunProcessResult.terminationWarning is absent on a confirmed process tree and present only for an unknown termination state.',
    };
  } catch (error) {
    if (runtime) { if (chatId) { try { runtime.cancel(chatId); } catch {} } await runtime.shutdown(30_000); }
    throw error;
  } finally { await close(server); }
}

let manifestSourceRoot: string | undefined;
let manifestBefore: ReturnType<typeof sourceTreeManifest> | undefined;
try {
  assert.ok(path.isAbsolute(cli.sourceEvidence) && existsSync(cli.sourceEvidence) && lstatSync(cli.sourceEvidence).isFile());
  manifestSourceRoot = path.dirname(cli.sourceEvidence); manifestBefore = sourceTreeManifest(manifestSourceRoot);
  const postflight = validateRecordedWorkflow(cli.sourceEvidence); const sourceTreeAfter = sourceTreeManifest(manifestSourceRoot);
  assert.deepEqual(sourceTreeAfter, manifestBefore, 'recorded source tree changed during recheck');
  report.recordedPostflight = postflight; report.sourceTree = { before: manifestBefore, validationAfter: sourceTreeAfter, unchanged: true };
  report.sourceEvidencePassed = true; report.originalWorkflowRecheckPassed = true; report.readyForLive = true; persist();
  if (cli.executeLive) await runCancellation();
  const sourceTreeFinal = sourceTreeManifest(manifestSourceRoot); assert.deepEqual(sourceTreeFinal, manifestBefore, 'recorded source tree changed during composite recheck');
  report.sourceTree = { before: manifestBefore, validationAfter: sourceTreeAfter, final: sourceTreeFinal, unchanged: true };
  report.compositePassed = cli.executeLive && report.cancellation !== null; report.passed = true; report.endedAt = at(); persist();
  process.stdout.write(`${JSON.stringify({ evidenceFile, passed: true, executeLive: cli.executeLive, realModelCalls: report.realModelCalls })}\n`);
} catch (error) {
  report.failure = safeError(error); report.passed = false; report.endedAt = at();
  if (manifestSourceRoot && manifestBefore) {
    try {
      const final = sourceTreeManifest(manifestSourceRoot); assert.deepEqual(final, manifestBefore, 'recorded source tree changed during failed composite recheck');
      report.sourceTree = { ...(report.sourceTree as Record<string, unknown> | undefined), before: manifestBefore, final, unchanged: true };
    } catch (manifestError) {
      report.sourceTree = { ...(report.sourceTree as Record<string, unknown> | undefined), before: manifestBefore, unchanged: false, finalError: safeError(manifestError) };
      report.failure += `\nSOURCE_TREE_FINALIZATION_FAILURE: ${safeError(manifestError)}`;
    }
  }
  persist();
  process.stderr.write(`${JSON.stringify({ evidenceFile, passed: false, error: safeError(error) })}\n`); process.exitCode = 1;
}
