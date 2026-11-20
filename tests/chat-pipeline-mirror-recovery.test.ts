import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { loadRoster } from '../src/chat/roster.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import type { AgentTask, ChatRecord } from '../src/chat/types.js';
import { ExecTools } from '../src/exec/tools.js';
import { PipelineMirrorCoordinator } from '../src/pipeline/mirror.js';
import type { ManagedPipelineFile, MilestoneDefinition, PipelineReview, PipelineWorkspaceHost } from '../src/pipeline/implementation-types.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { tempDir } from './helpers.js';

const roots: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class ExactMirrorHost {
  writes = 0;
  constructor(readonly root: string, private readonly failAfter?: number) {}

  writePipelineFiles(_chat: ChatRecord, _task: AgentTask, files: readonly ManagedPipelineFile[]): void {
    for (const file of files) {
      const target = path.join(this.root, file.path);
      const current = existsSync(target) ? hash(readFileSync(target, 'utf8')) : undefined;
      const desired = hash(file.text);
      if (current === desired) continue;
      if (current === undefined && file.expectedHash !== undefined) throw new Error(`missing:${file.path}`);
      if (current !== undefined && (file.expectedHash === undefined || current !== file.expectedHash)) throw new Error(`cas:${file.path}`);
    }
    if (this.failAfter === 0) throw new Error('crash-before-write');
    for (const file of files) {
      const target = path.join(this.root, file.path);
      if (existsSync(target) && hash(readFileSync(target, 'utf8')) === hash(file.text)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.text, 'utf8');
      this.writes += 1;
      if (this.failAfter === this.writes) throw new Error(`crash-after-${this.writes}`);
    }
  }
}

function host(value: ExactMirrorHost): PipelineWorkspaceHost {
  return value as unknown as PipelineWorkspaceHost;
}

function seed(afterWriteAhead?: (event: { type: string }) => void) {
  const root = tempDir('dmw-pipeline-mirror-');
  roots.push(root);
  const store = new ChatStore(path.join(root, 'store'), { afterWriteAhead });
  const pipeline = {
    version: 1, preset: 'flagship', stage: 'implementation', revision: 1,
    gates: [], gateDecisions: [], quality: [], clusters: [], priorContracts: [],
    implementation: { version: 1, round: 1, rootTaskId: 'root', solTaskId: 'sol', proposals: [], prepared: true, milestones: [] },
  } as unknown as NonNullable<ChatRecord['pipeline']>;
  const chat = store.create({ workspaceId: 'workspace', apiRoster: { test: true } as unknown as NonNullable<ChatRecord['apiRoster']>, pipeline });
  const task: AgentTask = {
    id: 'sol', turnId: randomUUID(), role: 'sol', goal: 'persist mirror', status: 'completed',
    createdAt: now(), updatedAt: now(), segment: 0, invocationIds: [], noProgressSegments: 0,
    mode: 'edit', phase: 'implementation', workspaceId: 'workspace', workspaceVersion: 1,
    pipelineWork: { kind: 'implementation-sol' },
  };
  chat.tasks.push(task);
  store.save(chat);
  return { root, store, chat, task, workspace: path.join(root, 'workspace') };
}

const files = () => [
  { path: '.agent/STATE.json', text: '{"state":1}\n' },
  { path: '.agent/HANDOFF.md', text: '# handoff\n' },
] satisfies ManagedPipelineFile[];

const milestoneEvent = { type: 'milestone_verified', data: { milestoneId: 'M1' }, taskId: 'sol' };

for (const failAfter of [0, 1, 2]) test(`recovers a mirror crash after ${failAfter} workspace writes`, () => {
  const seeded = seed();
  assert.throws(() => new PipelineMirrorCoordinator(seeded.store, host(new ExactMirrorHost(seeded.workspace, failAfter)))
    .stage(seeded.chat, seeded.task, files(), milestoneEvent), /crash/);
  assert.ok(seeded.store.get(seeded.chat.id).pipeline?.implementation?.mirrorIntent);
  assert.equal(seeded.store.events(seeded.chat.id).items.length, 0);

  const restartedStore = new ChatStore(path.join(seeded.root, 'store'));
  const restarted = restartedStore.get(seeded.chat.id);
  const event = new PipelineMirrorCoordinator(restartedStore, host(new ExactMirrorHost(seeded.workspace)))
    .reconcile(restarted, restarted.tasks[0]!);
  assert.equal(event?.type, 'milestone_verified');
  assert.equal(readFileSync(path.join(seeded.workspace, '.agent/STATE.json'), 'utf8'), files()[0]!.text);
  assert.equal(readFileSync(path.join(seeded.workspace, '.agent/HANDOFF.md'), 'utf8'), files()[1]!.text);
  assert.equal(restartedStore.get(seeded.chat.id).pipeline?.implementation?.mirrorIntent, undefined);
  assert.equal(restartedStore.events(seeded.chat.id).items.filter(item => item.type === 'milestone_verified').length, 1);

  assert.equal(new PipelineMirrorCoordinator(restartedStore, host(new ExactMirrorHost(seeded.workspace)))
    .reconcile(restarted, restarted.tasks[0]!), undefined);
  assert.equal(restartedStore.events(seeded.chat.id).items.filter(item => item.type === 'milestone_verified').length, 1);
});

test('an unwritable event WAL leaves the in-memory sequence and mirror intent retryable', t => {
  const f = seed();
  const coordinator = new PipelineMirrorCoordinator(f.store, host(new ExactMirrorHost(f.workspace)));
  const journal = path.join(f.root, 'store', 'chats', f.chat.id, 'state.jsonl');
  const commit = f.store.commitEvent.bind(f.store);
  const fault = t.mock.method(f.store, 'commitEvent', (...args: Parameters<ChatStore['commitEvent']>) => {
    renameSync(journal, `${journal}.saved`);
    mkdirSync(journal);
    try { return commit(...args); }
    finally { rmdirSync(journal); renameSync(`${journal}.saved`, journal); }
  });
  const previousSeq = f.chat.seq;
  assert.throws(() => coordinator.stage(f.chat, f.task, files(), milestoneEvent), /EISDIR|EPERM|EACCES/);
  assert.equal(f.chat.seq, previousSeq);
  assert.ok(f.chat.pipeline!.implementation!.mirrorIntent);
  fault.mock.restore();
  assert.equal(coordinator.reconcile(f.chat, f.task)?.seq, previousSeq + 1);
  assert.equal(f.store.events(f.chat.id).items.filter(item => item.type === 'milestone_verified').length, 1);
});

test('recovers an event committed to the state WAL before event materialization', () => {
  let crash = true;
  const seeded = seed(event => {
    if (crash && event.type === 'milestone_verified') { crash = false; throw new Error('crash-after-event-wal'); }
  });
  assert.throws(() => new PipelineMirrorCoordinator(seeded.store, host(new ExactMirrorHost(seeded.workspace)))
    .stage(seeded.chat, seeded.task, files(), milestoneEvent), /crash-after-event-wal/);

  const restartedStore = new ChatStore(path.join(seeded.root, 'store'));
  const restarted = restartedStore.get(seeded.chat.id);
  assert.equal(restarted.pipeline?.implementation?.mirrorIntent, undefined);
  assert.equal(restartedStore.events(restarted.id).items.filter(item => item.type === 'milestone_verified').length, 1);
});

test('runtime recovery refuses user edits and preserves the pending intent', () => {
  const seeded = seed();
  assert.throws(() => new PipelineMirrorCoordinator(seeded.store, host(new ExactMirrorHost(seeded.workspace, 1)))
    .stage(seeded.chat, seeded.task, files(), milestoneEvent), /crash-after-1/);
  const statePath = path.join(seeded.workspace, '.agent/STATE.json');
  writeFileSync(statePath, 'USER EDIT\n', 'utf8');

  const runtime = new ChatRuntime({
    store: new ChatStore(path.join(seeded.root, 'store')), drivers: {}, api: {} as never,
    pipelineWorkspace: host(new ExactMirrorHost(seeded.workspace)),
  });
  runtime.recover();
  const recovered = runtime.get(seeded.chat.id);
  assert.match(recovered.blockedReason ?? '', /精确字节不一致|拒绝覆盖/);
  assert.ok(recovered.pipeline?.implementation?.mirrorIntent);
  assert.equal(readFileSync(statePath, 'utf8'), 'USER EDIT\n');
  assert.equal(existsSync(path.join(seeded.workspace, '.agent/HANDOFF.md')), false);
  assert.equal(runtime.store.events(recovered.id).items.filter(item => item.type === 'milestone_verified').length, 0);
});

test('runtime recovery rejects receipt drift before touching workspace files', () => {
  const seeded = seed();
  assert.throws(() => new PipelineMirrorCoordinator(seeded.store, host(new ExactMirrorHost(seeded.workspace, 0)))
    .stage(seeded.chat, seeded.task, files(), milestoneEvent), /crash-before-write/);
  const drifted = seeded.store.get(seeded.chat.id);
  const intent = drifted.pipeline!.implementation!.mirrorIntent!;
  intent.event!.data = { milestoneId: 'M2' };
  seeded.store.save(drifted);

  const runtime = new ChatRuntime({
    store: new ChatStore(path.join(seeded.root, 'store')), drivers: {}, api: {} as never,
    pipelineWorkspace: host(new ExactMirrorHost(seeded.workspace)),
  });
  runtime.recover();
  const recovered = runtime.get(seeded.chat.id);
  assert.match(recovered.blockedReason ?? '', /精确字节不一致|拒绝覆盖/);
  assert.ok(recovered.pipeline?.implementation?.mirrorIntent);
  assert.equal(existsSync(path.join(seeded.workspace, '.agent/STATE.json')), false);
  assert.equal(runtime.store.events(recovered.id).items.filter(item => item.type === 'milestone_verified').length, 0);
});

test('legacy records without an intent do not adopt external mirror bytes', () => {
  const seeded = seed();
  mkdirSync(path.join(seeded.workspace, '.agent'), { recursive: true });
  writeFileSync(path.join(seeded.workspace, '.agent/STATE.json'), 'EXTERNAL\n', 'utf8');
  const before = JSON.stringify(seeded.chat.pipeline!.implementation);
  const result = new PipelineMirrorCoordinator(seeded.store, host(new ExactMirrorHost(seeded.workspace)))
    .reconcile(seeded.chat, seeded.task);
  assert.equal(result, undefined);
  assert.equal(JSON.stringify(seeded.chat.pipeline!.implementation), before);
  assert.equal(readFileSync(path.join(seeded.workspace, '.agent/STATE.json'), 'utf8'), 'EXTERNAL\n');
});

test('a pending milestone mirror blocks every other milestone before side effects in the same process', async t => {
  const f = seed();
  mkdirSync(f.workspace);
  const registry = new WorkspaceRegistry(path.join(f.root, 'managed'));
  const grant = registry.grantFromNativeSelection(f.workspace, registry.issueNativeSelectionRequest());
  const gateway = new WorkspaceGateway(registry);
  f.chat.workspaceId = f.task.workspaceId = grant.id;
  f.chat.apiRoster = { roster: loadRoster('config/roster.json', loadModelRegistry()), modelHashes: {} };
  f.task.workspaceVersion = grant.version;
  f.task.parentTaskId = 'root';
  f.task.status = 'running';
  f.task.invocationIds = ['inv-sol'];
  f.chat.invocations.push({
    id: 'inv-sol', taskId: f.task.id, segment: 1, status: 'exited', exitConfirmed: true, startedAt: now(),
    toolCount: 0, promptVersion: 'mirror-retry-test', inputEstimate: 1, contextWindow: null, contextUsed: null,
  });
  f.chat.tasks.push({
    id: 'root', turnId: randomUUID(), role: 'sol', goal: 'lead', status: 'running', createdAt: now(), updatedAt: now(),
    segment: 0, invocationIds: [], noProgressSegments: 0, mode: 'edit', phase: 'implementation',
    workspaceId: grant.id, workspaceVersion: grant.version, pipelineWork: { kind: 'implementation-lead' },
  });
  const state = f.chat.pipeline!.implementation!;
  state.planHash = 'a'.repeat(64);
  const secondPath = 'second.txt';
  const check = { id: 'check-2', acceptanceIds: ['A2'], argv: ['fixture-check'], cwd: '.', timeoutMs: 1_000 };
  const second: MilestoneDefinition = { id: 'M2', title: 'Second', owner: 'sol', acceptanceIds: ['A2'], dependsOn: [],
    paths: [secondPath], checks: [check] };
  const review: PipelineReview = { subjectHash: state.planHash, reviewerTaskId: 'reviewer', reviewer: 'opus',
    reviewerModel: 'claude-opus-5-5', reviewerFamily: 'anthropic', author: 'sol', authorModel: 'gpt-6.1-sol', authorFamily: 'openai',
    outcome: 'passed', defects: [], checks: [] };
  state.proposals = [{ plan: { version: 1, contractHash: hash('contract'), milestones: [
    { ...second, id: 'M1', owner: 'opus', paths: ['first.txt'] }, second,
  ] }, ref: 'plan', hash: state.planHash, reviewTaskId: review.reviewerTaskId, review }];
  const author: AgentTask = { ...f.task, id: 'author-2', parentTaskId: f.task.id, invocationIds: ['inv-author-2'],
    pipelineWork: { kind: 'milestone-author', milestoneId: 'M2', attempt: 1, paths: [secondPath] } };
  const authorInvocation = { ...f.chat.invocations[0]!, id: 'inv-author-2', taskId: author.id, status: 'running' as const };
  const authorIdentity = { chat: f.chat, task: author, invocation: authorInvocation, signal: new AbortController().signal };
  f.chat.tasks.push(author);
  f.chat.invocations.push(authorInvocation);
  gateway.prepareMilestoneAuthor(authorIdentity);
  await gateway.call('file_write', { path: secondPath, text: 'second milestone\n', expectedHash: null }, authorIdentity);
  await gateway.afterInvocation(authorIdentity, true);
  author.status = 'completed';
  Object.assign(authorInvocation, { status: 'exited', exitConfirmed: true });
  const candidate = gateway.freezeMilestoneCandidate(f.chat, author);
  state.milestones = [
    { id: 'M1', status: 'complete', attempts: [{ number: 1, authorTaskId: 'author-1', checks: [] }] },
    { id: 'M2', status: 'verifying', attempts: [{ number: 1, authorTaskId: author.id, candidate,
      review: { ...review, subjectHash: candidate.diffHash } }] },
  ];
  const commit = t.mock.method(gateway, 'commitMilestone');
  let checksRun = 0;
  const executor = new ExecTools({ id: 'docker', probe: async () => ({ ok: true }), run: async (_spec, context) => {
    checksRun += 1;
    assert.equal(readFileSync(path.join(context.copyDir, secondPath), 'utf8'), 'second milestone\n');
    writeFileSync(path.join(context.outputDir, 'stdout.txt'), 'verified\n');
    writeFileSync(path.join(context.outputDir, 'stderr.txt'), '');
    return { exitCode: 0, timedOut: false, cancelled: false, exitConfirmed: true, durationMs: 1,
      stdoutRef: 'stdout.txt', stderrRef: 'stderr.txt', network: 'none' };
  } }, path.join(f.root, 'exec'));
  const runtime = new ChatRuntime({ store: f.store, drivers: {}, api: {} as never, workspace: gateway, pipelineWorkspace: gateway, executor });
  const internals = runtime as unknown as {
    implementationStateText(value: typeof state): string;
    verifyPipelineMilestone(active: unknown, raw: unknown): Promise<{ data?: unknown }>;
    complete(chat: ChatRecord, task: AgentTask, result: string): void;
    wakeParents(chat: ChatRecord): void;
  };
  const oldText = '{"state":"old"}\n';
  gateway.writePipelineFiles(f.chat, f.task, [{ path: '.agent/STATE.json', text: oldText }]);
  state.stateFileHash = hash(oldText);
  const desiredText = internals.implementationStateText(state);
  const statePath = path.join(f.workspace, '.agent/STATE.json');
  writeFileSync(statePath, 'USER EDIT\n', 'utf8');
  assert.throws(() => new PipelineMirrorCoordinator(f.store, gateway).stage(f.chat, f.task, [
    { path: '.agent/STATE.json', text: desiredText, expectedHash: state.stateFileHash },
  ], milestoneEvent), /拒绝覆盖/);
  assert.ok(state.mirrorIntent);
  assert.equal(readFileSync(statePath, 'utf8'), 'USER EDIT\n');

  const active = { chat: f.chat, task: f.task, invocation: f.chat.invocations[0], toolController: new AbortController() };
  await assert.rejects(internals.verifyPipelineMilestone(active, { milestoneId: 'M2' }), /尚未按精确字节对账/);
  assert.ok(state.mirrorIntent);
  assert.equal(state.milestones[1]!.status, 'verifying');
  assert.equal(state.milestones[1]!.attempts[0]!.checks, undefined);
  assert.equal(checksRun, 0);
  assert.equal(commit.mock.callCount(), 0);
  assert.equal(readFileSync(statePath, 'utf8'), 'USER EDIT\n');
  internals.complete(f.chat, f.task, 'done');
  internals.wakeParents(f.chat);
  assert.equal(f.task.status, 'queued');
  assert.equal(f.chat.pipeline!.stage, 'implementation');
  assert.equal(f.store.events(f.chat.id).items.filter(item => item.type === 'milestone_verified').length, 0);

  writeFileSync(statePath, oldText, 'utf8');
  const retried = await internals.verifyPipelineMilestone(active, { milestoneId: 'M1' });
  assert.deepEqual(retried.data, { ok: true, milestoneId: 'M1', checks: [], duplicate: true });
  assert.equal(state.mirrorIntent, undefined);
  assert.equal(readFileSync(statePath, 'utf8'), desiredText);
  const verified = await internals.verifyPipelineMilestone(active, { milestoneId: 'M2' });
  assert.equal(state.milestones[1]!.status, 'complete', JSON.stringify(verified.data));
  assert.equal(checksRun, 1);
  assert.equal(commit.mock.callCount(), 1);
  assert.match(state.milestones[1]!.attempts[0]!.commit!, /^[a-f0-9]{40,64}$/);
  const milestoneEvents = f.store.events(f.chat.id).items.filter(item => item.type === 'milestone_verified');
  assert.deepEqual(milestoneEvents.map(item => (item.data as { milestoneId: string }).milestoneId), ['M1', 'M2']);
  internals.complete(f.chat, f.task, 'done');
  internals.wakeParents(f.chat);
  assert.equal(f.task.status, 'completed');
  assert.equal(f.chat.pipeline!.stage, 'acceptance');
  assert.deepEqual(f.store.events(f.chat.id).items.filter(item => item.type === 'milestone_verified')
    .map(item => (item.data as { milestoneId: string }).milestoneId), ['M1', 'M2']);
});

for (const edited of ['neither', '.agent/STATE.json', '.agent/HANDOFF.md']) {
  test(`upgrades legacy confirmed mirror hashes with ${edited} edited`, () => {
    const f = seed();
    mkdirSync(f.workspace);
    const registry = new WorkspaceRegistry(path.join(f.root, 'managed'));
    const grant = registry.grantFromNativeSelection(f.workspace, registry.issueNativeSelectionRequest());
    f.chat.workspaceId = f.task.workspaceId = grant.id;
    f.task.workspaceVersion = grant.version;
    const oldFiles = files().map(file => ({ path: file.path, text: `old ${file.path}\n` }));
    new WorkspaceGateway(registry).writePipelineFiles(f.chat, f.task, oldFiles);
    const old = f.chat.pipeline!.implementation!;
    old.stateFileHash = hash(oldFiles[0]!.text);
    old.handoffFileHash = hash(oldFiles[1]!.text);
    f.store.save(f.chat);
    if (edited !== 'neither') writeFileSync(path.join(f.workspace, edited), 'user revision\n');

    const store = new ChatStore(path.join(f.root, 'store'));
    const chat = store.get(f.chat.id);
    const state = chat.pipeline!.implementation!;
    assert.equal(state.mirrorIntent, undefined);
    const host = new WorkspaceGateway(new WorkspaceRegistry(path.join(f.root, 'managed')));
    const batch = files().map((file, index) => ({ ...file, expectedHash: index === 0 ? state.stateFileHash : state.handoffFileHash }));
    const stage = () => new PipelineMirrorCoordinator(store, host).stage(chat, chat.tasks[0]!, batch, milestoneEvent);
    if (edited === 'neither') {
      assert.equal(stage()?.type, 'milestone_verified');
      assert.deepEqual(files().map(file => readFileSync(path.join(f.workspace, file.path), 'utf8')), files().map(file => file.text));
      const updated = store.get(chat.id).pipeline!.implementation!;
      assert.deepEqual([updated.stateFileHash, updated.handoffFileHash], files().map(file => hash(file.text)));
      assert.equal(updated.mirrorIntent, undefined);
    } else {
      assert.throws(stage, /拒绝覆盖/);
      const pending = store.get(chat.id).pipeline!.implementation!;
      assert.ok(pending.mirrorIntent);
      assert.deepEqual([pending.stateFileHash, pending.handoffFileHash], [old.stateFileHash, old.handoffFileHash]);
      assert.equal(store.events(chat.id).items.length, 0);
      for (const file of oldFiles) assert.equal(readFileSync(path.join(f.workspace, file.path), 'utf8'), file.path === edited ? 'user revision\n' : file.text);
    }
  });
}
