import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ChatEvent, ChatRecord } from '../src/chat/types.js';
import { validateRootGrokBatchReceipt } from './chat-workflow-event-receipts.js';

type InvocationTrace = {
  invocationId: string;
  taskId: string;
  role: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  result?: { exitConfirmed?: boolean; finishReason?: string };
  toolCalls: { name: string; fileReadPath?: string; evidenceTaskId?: string; resultReadRef?: string }[];
};

type SourceEvidence = {
  appRoot: string;
  dataRoot: string;
  proofDir: string;
  paidInvocationsAttempted: number;
  passed: boolean;
  failure?: string;
  preflight: {
    proofHashes?: Record<string, { source: string; copied: string }>;
    compiledAppHashes?: Record<string, string>;
    fixtureInsideRunnerWorkRoot?: string;
  };
  invocations: InvocationTrace[];
};

export interface RecordedWorkflowPostflight {
  sourceEvidenceSha256: string;
  chatSnapshotSha256: string;
  eventStreamSha256: string;
  eventFileSha256: Record<string, string>;
  fixtureFileSha256: Record<string, string>;
  chatId: string;
  rootTaskId: string;
  invocationCount: number;
  taskCount: number;
  rootGrokBatch: ReturnType<typeof validateRootGrokBatchReceipt>;
  maxConcurrentGrok: number;
  astraPlatforms: string[];
  astraSourceSnapshotId: string;
  sourceFingerprint: string;
  completionGateEquivalent: {
    runtimeCompletionIssuesReconstructed: false;
    successfulRootTaskCompleteEvent: true;
    finalRootTaskCompleted: true;
    latestAstraFrozenRevisionEvidenceVerified: true;
    taskCompleteResultSeq: number;
    invocationEndedSeq: number;
    rootCompletedSeq: number;
    runtimeKernelSha256: string;
    gatewayKernelSha256: string;
    boundary: string;
  };
  originalFailureClass: 'harness_root_grok_batch_trace_gap';
}

const shaBytes = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = (file: string) => shaBytes(readFileSync(file));

function json<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')) as T; }

function eventFiles(chatRoot: string): string[] {
  const root = path.join(chatRoot, 'events');
  return readdirSync(root).filter(name => /^events-\d+\.jsonl$/.test(name)).sort();
}

function readEvents(chatRoot: string): ChatEvent[] {
  const root = path.join(chatRoot, 'events');
  return eventFiles(chatRoot).flatMap(name =>
    readFileSync(path.join(root, name), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as ChatEvent));
}

function eventName(event: ChatEvent): string | undefined {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? (event.data as { name?: unknown }).name as string | undefined : undefined;
}

function artifactBytes(chatRoot: string, relativePath: string, expectedHash: string): Buffer {
  const file = path.resolve(chatRoot, relativePath);
  assert.ok(file.startsWith(`${path.resolve(chatRoot)}${path.sep}`), 'artifact escaped chat root');
  const bytes = readFileSync(file);
  assert.equal(shaBytes(bytes), expectedHash, `artifact hash mismatch: ${relativePath}`);
  return bytes;
}

function testEvidence(chatRoot: string, chat: ChatRecord, taskId: string): Record<string, unknown>[] {
  return chat.artifacts.filter(item => item.taskId === taskId && item.kind === 'test' && item.provenance === 'runner')
    .map(item => JSON.parse(artifactBytes(chatRoot, item.relativePath, item.hash).toString('utf8')) as Record<string, unknown>);
}

function verifySnapshot(dataRoot: string, evidence: Record<string, unknown>): void {
  assert.equal(evidence.ok, true, 'test evidence must pass');
  const id = evidence.sourceSnapshotId;
  const fingerprint = evidence.sourceFingerprint;
  assert.equal(typeof id, 'string'); assert.equal(typeof fingerprint, 'string');
  const snapshotRoot = path.join(dataRoot, 'work', 'managed', 'snapshots', id as string);
  const snapshot = json<{ id: string; files: Record<string, string> }>(path.join(snapshotRoot, 'snapshot.json'));
  assert.equal(snapshot.id, id);
  assert.equal(shaBytes(JSON.stringify(Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b)))), fingerprint);
  const filesRoot = path.resolve(snapshotRoot, 'files');
  for (const [relative, hash] of Object.entries(snapshot.files)) {
    const file = path.resolve(filesRoot, relative); assert.ok(file.startsWith(`${filesRoot}${path.sep}`), 'snapshot file escaped files root');
    assert.equal(shaFile(file), hash);
  }
}

export function validateRecordedWorkflow(sourceEvidenceFile: string): RecordedWorkflowPostflight {
  const sourceFile = path.resolve(sourceEvidenceFile);
  const source = json<SourceEvidence>(sourceFile);
  const sourceRoot = path.dirname(sourceFile); const dataRoot = path.resolve(source.dataRoot);
  assert.ok(dataRoot.startsWith(`${sourceRoot}${path.sep}`), 'source dataRoot must be inside the recorded source root');
  assert.equal(source.passed, false, 'source report must remain failed');
  assert.equal(source.paidInvocationsAttempted, 19, 'source report must contain the original 19 invocations');
  assert.match(source.failure ?? '', /Claude must submit its read children in one batch[\s\S]*0 !== 1[\s\S]*chat-live-workflow-probe\.ts:448/u);
  assert.equal(source.invocations.length, 19);
  assert.equal(source.invocations.some(item => item.error), false, 'source invocation trace contains an error');
  assert.equal(source.invocations.some(item => item.result?.exitConfirmed !== true), false, 'source invocation exit was not confirmed');

  const requiredCompiled = ['src/config.js', 'src/chat/bootstrap.js', 'src/chat/drivers.js', 'src/chat/gateway.js', 'src/chat/http.js', 'src/chat/runtime.js', 'src/chat/store.js', 'src/chat/workspace.js', 'config/workbench.config.json'];
  const compiledHashes = source.preflight.compiledAppHashes ?? {};
  assert.deepEqual(Object.keys(compiledHashes).sort(), [...requiredCompiled].sort(), 'compiled app hash key set mismatch');
  assert.ok(lstatSync(source.appRoot).isDirectory() && !lstatSync(source.appRoot).isSymbolicLink());
  for (const [relative, expected] of Object.entries(compiledHashes)) {
    assert.equal(shaFile(path.join(source.appRoot, relative.replaceAll('/', path.sep))), expected, `compiled app drift: ${relative}`);
  }
  const proofHashes = source.preflight.proofHashes ?? {};
  assert.deepEqual(Object.keys(proofHashes).sort(), ['models.json', 'runner-windows.json', 'runner-wsl.json']);
  assert.ok(lstatSync(source.proofDir).isDirectory() && !lstatSync(source.proofDir).isSymbolicLink());
  for (const [name, hashes] of Object.entries(proofHashes)) {
    assert.equal(hashes.source, hashes.copied, `source/copy proof mismatch: ${name}`);
    assert.equal(shaFile(path.join(source.proofDir, name)), hashes.source, `source proof drift: ${name}`);
    assert.equal(shaFile(path.join(source.dataRoot, 'capabilities', name)), hashes.copied, `copied proof drift: ${name}`);
  }

  const chatDirs = readdirSync(path.join(source.dataRoot, 'chats')).filter(name => existsSync(path.join(source.dataRoot, 'chats', name, 'chat.json')));
  assert.equal(chatDirs.length, 1, 'recorded workflow must have exactly one chat (cancellation did not run)');
  const chatRoot = path.join(source.dataRoot, 'chats', chatDirs[0]!);
  const chatFile = path.join(chatRoot, 'chat.json');
  const chat = json<ChatRecord>(chatFile);
  const events = readEvents(chatRoot);
  assert.equal(events.every(event => event.chatId === chat.id), true, 'event stream contains a foreign chatId');
  assert.equal(chat.tasks.length, 8); assert.equal(chat.invocations.length, 19);
  const tasksById = new Map(chat.tasks.map(task => [task.id, task]));
  for (const trace of source.invocations) {
    const invocation = chat.invocations.find(item => item.id === trace.invocationId);
    assert.ok(invocation && invocation.taskId === trace.taskId, `source/chat invocation binding mismatch: ${trace.invocationId}`);
    assert.equal(tasksById.get(invocation.taskId)?.role, trace.role, `source/chat invocation role mismatch: ${trace.invocationId}`);
  }
  assert.equal(new Set(source.invocations.map(item => item.invocationId)).size, 19);
  assert.equal(chat.tasks.some(task => task.status !== 'completed'), false, 'all eight workflow tasks must be completed');
  assert.equal(chat.invocations.some(item => item.status !== 'exited' || item.exitConfirmed !== true), false, 'recorded invocation not safely exited');
  assert.equal(chat.tickets.some(ticket => ticket.status === 'pending'), false, 'recorded workflow has pending tickets');
  assert.equal(chat.blockedReason, undefined); assert.deepEqual(chat.unsafeProcesses ?? [], []);

  const rootTaskId = chat.turns.at(-1)?.rootTaskId;
  assert.equal(typeof rootTaskId, 'string');
  const rootTask = chat.tasks.find(task => task.id === rootTaskId)!;
  const sol = chat.tasks.find(task => task.role === 'sol')!;
  const astra = chat.tasks.find(task => task.role === 'astra')!;
  assert.ok(rootTask && sol && astra);
  assert.equal(rootTask.role, 'claude');
  assert.deepEqual([...new Set(source.invocations.map(item => item.role))].sort(), ['astra', 'claude', 'grok', 'sol']);
  const reads = chat.tasks.filter(task => task.parentTaskId === rootTask.id && task.role === 'grok' && task.mode === 'read');
  const edit = chat.tasks.find(task => task.parentTaskId === sol.id && task.role === 'grok' && task.mode === 'edit')!;
  const verify = chat.tasks.find(task => task.parentTaskId === astra.id && task.role === 'grok' && task.mode === 'verify')!;
  assert.equal(reads.length, 3); assert.ok(edit && verify);
  const rootGrokBatch = validateRootGrokBatchReceipt(events, rootTask.id, reads.map(task => task.id), chat.id);

  const readCoverage = reads.map(task => [...new Set(source.invocations.filter(item => item.taskId === task.id).flatMap(item => item.toolCalls)
    .filter(item => item.name === 'file_read').map(item => item.fileReadPath))].sort().join(',')).sort();
  assert.deepEqual(readCoverage, ['test.mjs', 'test.mjs,value.mjs', 'value.mjs']);
  const toolNames = (taskId: string) => events.filter(event => event.taskId === taskId && event.type === 'tool_result').map(eventName).filter(Boolean) as string[];
  for (const task of reads) assert.ok(toolNames(task.id).includes('file_read'));
  for (const name of ['file_read', 'file_write', 'test_submit']) assert.ok(toolNames(edit.id).includes(name));
  for (const name of ['file_read', 'test_submit']) assert.ok(toolNames(verify.id).includes(name));
  for (const name of ['grok_submit', 'grok_collect', 'grok_disposition', 'integrate_edit']) assert.ok(toolNames(sol.id).includes(name));
  for (const name of ['grok_submit', 'grok_collect', 'grok_disposition', 'test_submit']) assert.ok(toolNames(astra.id).includes(name));
  for (const name of ['grok_submit', 'grok_collect', 'grok_disposition', 'task_complete']) assert.ok(toolNames(rootTask.id).includes(name));
  assert.equal(chat.tasks.some(task => task.parentTaskId && !task.disposition), false);

  const parentCalls = (taskId: string) => source.invocations.filter(item => item.taskId === taskId).flatMap(item => item.toolCalls);
  for (const [parent, child, names] of [[sol, edit, ['file_write', 'test_submit']], [astra, verify, ['test_submit']]] as const) {
    const calls = parentCalls(parent.id);
    assert.ok(calls.some(call => call.name === 'task_evidence' && call.evidenceTaskId === child.id));
    for (const name of names) {
      const receipt = chat.toolResults?.find(item => item.taskId === child.id && item.name === name && item.provenance === (name === 'test_submit' ? 'runner' : 'workspace'));
      assert.ok(receipt); assert.ok(calls.some(call => call.name === 'result_read' && call.resultReadRef === receipt.ref));
    }
  }

  const activity = chat.invocations.filter(item => chat.tasks.find(task => task.id === item.taskId)?.role === 'grok')
    .flatMap(item => [{ at: Date.parse(item.startedAt), delta: 1 }, { at: Date.parse(item.endedAt!), delta: -1 }])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0; let maxConcurrentGrok = 0;
  for (const edge of activity) { assert.ok(Number.isFinite(edge.at)); active += edge.delta; maxConcurrentGrok = Math.max(maxConcurrentGrok, active); }
  assert.ok(maxConcurrentGrok >= 2);

  const astraEvidence = testEvidence(chatRoot, chat, astra.id); const astraPlatforms = new Set(astraEvidence.map(item => item.platform as string));
  assert.deepEqual([...astraPlatforms].sort(), ['linux', 'windows']);
  for (const item of astraEvidence) verifySnapshot(source.dataRoot, item);
  const astraSnapshots = new Set(astraEvidence.map(item => item.sourceSnapshotId as string)); assert.equal(astraSnapshots.size, 1);
  for (const task of [edit, verify]) {
    const evidence = testEvidence(chatRoot, chat, task.id); assert.ok(evidence.some(item => item.platform === 'linux' && item.ok === true));
    for (const item of evidence) verifySnapshot(source.dataRoot, item);
  }
  const sourceFingerprints = new Set([...astraEvidence, ...testEvidence(chatRoot, chat, edit.id), ...testEvidence(chatRoot, chat, verify.id)]
    .map(item => item.sourceFingerprint as string)); assert.equal(sourceFingerprints.size, 1);

  const editDiffs = chat.artifacts.filter(item => item.taskId === edit.id && item.kind === 'diff' && item.provenance === 'workspace');
  const integrationDiffs = chat.artifacts.filter(item => item.taskId === sol.id && item.kind === 'diff' && item.provenance === 'workspace');
  assert.ok(editDiffs.length && integrationDiffs.length);
  for (const item of editDiffs) assert.doesNotMatch(artifactBytes(chatRoot, item.relativePath, item.hash).toString('utf8'), /test-pollution/u);
  for (const item of integrationDiffs) {
    const diff = artifactBytes(chatRoot, item.relativePath, item.hash).toString('utf8');
    assert.match(diff, /value\.mjs/u); assert.doesNotMatch(diff, /test\.mjs|test-pollution/u);
  }
  const workRoot = path.resolve(source.dataRoot, 'work');
  const fixture = path.resolve(workRoot, source.preflight.fixtureInsideRunnerWorkRoot ?? 'fixture');
  assert.ok(fixture.startsWith(`${workRoot}${path.sep}`), 'source fixture escaped runner work root');
  assert.deepEqual(readdirSync(fixture).sort(), ['test.mjs', 'value.mjs'], 'source fixture must contain exactly value.mjs and test.mjs');
  assert.equal(readFileSync(path.join(fixture, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
  assert.ok(lstatSync(path.join(fixture, 'test.mjs')).isFile()); assert.equal(existsSync(path.join(fixture, 'test-pollution.txt')), false);
  const latestAstraSnapshotId = [...astraSnapshots][0]!;
  const latestAstraSnapshot = json<{ files: Record<string, string> }>(path.join(source.dataRoot, 'work', 'managed', 'snapshots', latestAstraSnapshotId, 'snapshot.json'));
  const currentFixtureFiles = Object.fromEntries(readdirSync(fixture).sort().map(name => [name, shaFile(path.join(fixture, name))]));
  assert.deepEqual(currentFixtureFiles, latestAstraSnapshot.files, 'current source fixture must exactly match Astra latest frozen source files');
  assert.equal(shaBytes(JSON.stringify(Object.entries(currentFixtureFiles).sort(([a], [b]) => a.localeCompare(b)))), [...sourceFingerprints][0]);

  const taskComplete = events.filter(event => event.taskId === rootTask.id && event.type === 'tool_result' && eventName(event) === 'task_complete');
  assert.equal(taskComplete.length, 1, 'root task_complete must have one successful tool_result');
  const taskCompleteResult = taskComplete[0]!;
  const taskCompleteStarted = events.filter(event => event.taskId === rootTask.id && event.type === 'tool_started' && eventName(event) === 'task_complete');
  assert.equal(taskCompleteStarted.length, 1, 'root task_complete must have one tool_started');
  const startedData = taskCompleteStarted[0]!.data as { toolCallId?: unknown };
  const resultData = taskCompleteResult.data as { toolCallId?: unknown; text?: unknown };
  assert.equal(taskCompleteStarted[0]!.chatId, chat.id); assert.equal(taskCompleteResult.chatId, chat.id);
  assert.equal(taskCompleteStarted[0]!.invocationId, taskCompleteResult.invocationId);
  assert.equal(startedData.toolCallId, resultData.toolCallId); assert.equal(typeof startedData.toolCallId, 'string');
  assert.ok(taskCompleteStarted[0]!.seq < taskCompleteResult.seq);
  assert.deepEqual(JSON.parse(String(resultData.text)), { submitted: true, completion: 'awaiting_process_exit' });
  assert.equal(typeof taskCompleteResult.invocationId, 'string');
  const taskCompleteInvocation = chat.invocations.find(item => item.id === taskCompleteResult.invocationId);
  assert.ok(taskCompleteInvocation && taskCompleteInvocation.taskId === rootTask.id && taskCompleteInvocation.status === 'exited' && taskCompleteInvocation.exitConfirmed === true);
  const invocationEnded = events.filter(event => event.type === 'invocation_ended' && event.invocationId === taskCompleteResult.invocationId);
  assert.equal(invocationEnded.length, 1);
  const rootCompleted = events.filter(event => event.type === 'task_updated' && event.taskId === rootTask.id && (event.data as { status?: unknown })?.status === 'completed');
  assert.equal(rootCompleted.length, 1);
  assert.ok(taskCompleteResult.seq < invocationEnded[0]!.seq && invocationEnded[0]!.seq < rootCompleted[0]!.seq, 'task_complete acceptance must precede confirmed invocation exit and root completion');
  const runtimeKernelSha256 = source.preflight.compiledAppHashes?.['src/chat/runtime.js'];
  const gatewayKernelSha256 = source.preflight.compiledAppHashes?.['src/chat/gateway.js'];
  assert.match(runtimeKernelSha256 ?? '', /^[a-f0-9]{64}$/u); assert.match(gatewayKernelSha256 ?? '', /^[a-f0-9]{64}$/u);
  return {
    sourceEvidenceSha256: shaFile(sourceFile), chatSnapshotSha256: shaFile(chatFile), eventStreamSha256: shaBytes(JSON.stringify(events)),
    eventFileSha256: Object.fromEntries(eventFiles(chatRoot).map(name => [name, shaFile(path.join(chatRoot, 'events', name))])),
    fixtureFileSha256: { 'value.mjs': shaFile(path.join(fixture, 'value.mjs')), 'test.mjs': shaFile(path.join(fixture, 'test.mjs')) },
    chatId: chat.id, rootTaskId: rootTask.id, invocationCount: chat.invocations.length, taskCount: chat.tasks.length,
    rootGrokBatch, maxConcurrentGrok, astraPlatforms: [...astraPlatforms].sort(), astraSourceSnapshotId: [...astraSnapshots][0]!,
    sourceFingerprint: [...sourceFingerprints][0]!, originalFailureClass: 'harness_root_grok_batch_trace_gap',
    completionGateEquivalent: {
      runtimeCompletionIssuesReconstructed: false, successfulRootTaskCompleteEvent: true, finalRootTaskCompleted: true,
      latestAstraFrozenRevisionEvidenceVerified: true,
      taskCompleteResultSeq: taskCompleteResult.seq, invocationEndedSeq: invocationEnded[0]!.seq, rootCompletedSeq: rootCompleted[0]!.seq,
      runtimeKernelSha256: runtimeKernelSha256!, gatewayKernelSha256: gatewayKernelSha256!,
      boundary: 'The process-local WorkspaceGateway.completionIssues array cannot be reconstructed after restart. The recorded successful root task_complete event proves that the runtime gate ran in-process; compiled runtime/gateway hashes, runner artifacts, frozen snapshot hashes, source fingerprints, and final task state are independently revalidated here.',
    },
  };
}
