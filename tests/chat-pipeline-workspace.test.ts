import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceGateway, type WorkspaceToolIdentity } from '../src/chat/gateway.js';
import { loadRoster } from '../src/chat/roster.js';
import { ChatStore } from '../src/chat/store.js';
import type { AgentTask, ChatRecord, Invocation } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import type { PipelineTaskBinding } from '../src/pipeline/implementation-types.js';
import { newPipelineState } from '../src/pipeline/state.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { tempDir } from './helpers.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture(t: test.TestContext) {
  const root = tempDir('dmw-pipeline-workspace-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'src', 'value.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  const registry = new WorkspaceRegistry(path.join(root, 'managed'));
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  const store = new ChatStore(path.join(root, 'chat'));
  const chat = store.create({ workspaceId: grant.id }) as ChatRecord;
  const roster = loadRoster('config/roster.json', loadModelRegistry());
  chat.apiRoster = { roster, modelHashes: {} };
  chat.pipeline = newPipelineState({ preset: 'flagship', auto: false });
  const gateway = new WorkspaceGateway(registry);
  return { root, project, registry, grant, store, chat, gateway };
}

function task(f: ReturnType<typeof fixture>, id: string, role: string, mode: AgentTask['mode'], binding: PipelineTaskBinding) {
  const invocation: Invocation = {
    id: `inv-${id}`, taskId: id, segment: 1, status: 'running', startedAt: '', toolCount: 0,
    promptVersion: 'pipeline-workspace-test', inputEstimate: 1, contextWindow: null, contextUsed: null,
  };
  const value: AgentTask & { pipelineWork: PipelineTaskBinding } = {
    id, turnId: 'implementation-turn', role, phase: 'implementation', goal: id, status: 'running', createdAt: '', updatedAt: '',
    segment: 1, invocationIds: [invocation.id], noProgressSegments: 0, mode,
    workspaceId: f.grant.id, workspaceVersion: f.grant.version, pipelineWork: binding,
  };
  f.chat.tasks.push(value); f.chat.invocations.push(invocation);
  const identity: WorkspaceToolIdentity = { chat: f.chat, task: value, invocation, signal: new AbortController().signal };
  return { task: value, invocation, identity };
}

function finish(author: ReturnType<typeof task>) {
  author.invocation.status = 'exited';
  author.invocation.exitConfirmed = true;
  author.task.status = 'completed';
}

test('trusted pipeline files are constrained, exact-hash replaced, and .agent stays outside source snapshots', async t => {
  const f = fixture(t);
  const lead = task(f, 'lead', 'sol', 'edit', { kind: 'implementation-sol' });
  f.gateway.writePipelineFiles(f.chat, lead.task, [
    { path: 'docs/PRD.md', text: '# frozen PRD\n' },
    { path: '.agent/state.json', text: '{"version":1}\n' },
  ]);
  f.gateway.writePipelineFiles(f.chat, lead.task, [
    { path: 'docs/PRD.md', text: '# frozen PRD\n' },
    { path: '.agent/state.json', text: '{"version":1}\n' },
  ]);
  assert.equal(readFileSync(path.join(f.project, '.agent', 'state.json'), 'utf8'), '{"version":1}\n');
  await assert.rejects(f.gateway.call('file_read', { path: '.agent/state.json' }, lead.identity), /程序受管目录/);
  await assert.rejects(f.gateway.call('file_list', { path: '.agent' }, lead.identity), /程序受管目录/);
  assert.throws(() => f.gateway.writePipelineFiles(f.chat, lead.task, [{ path: 'src/injected.ts', text: 'bad\n' }]), /只能写入 docs\/ 或 \.agent\//);
  assert.throws(() => f.gateway.writePipelineFiles(f.chat, lead.task, [
    { path: '.agent/duplicate.json', text: 'one\n' }, { path: '.agent/duplicate.json', text: 'two\n' },
  ]), /不得重复/);
  assert.throws(() => f.gateway.writePipelineFiles(f.chat, lead.task, [{ path: 'docs/PRD.md', text: 'overwrite\n' }]), /拒绝覆盖/);
  f.gateway.writePipelineFiles(f.chat, lead.task, [{ path: 'docs/PRD.md', text: '# revision 2\n', expectedHash: sha('# frozen PRD\n') }]);
  const snapshot = f.registry.freeze(f.grant.id, 'snapshot', { excludePipelineMetadata: true });
  assert.ok(snapshot.files['docs/PRD.md']);
  assert.equal(Object.keys(snapshot.files).some(file => file.startsWith('.agent/')), false);
});

test('ordinary chat snapshots and tools retain user-owned .agent files', async t => {
  const f = fixture(t);
  f.chat.pipeline = undefined;
  mkdirSync(path.join(f.project, '.agent'));
  writeFileSync(path.join(f.project, '.agent', 'notes.md'), 'user notes\n');
  const ordinary = task(f, 'ordinary-sol', 'sol', 'edit', { kind: 'implementation-sol' });
  const reply = await f.gateway.call('file_read', { path: '.agent/notes.md' }, ordinary.identity);
  assert.equal((reply.data as { text: string }).text, 'user notes\n');
  const snapshot = f.registry.freeze(f.grant.id, ordinary.task.id);
  assert.equal(snapshot.files['.agent/notes.md'], sha('user notes\n'));
});

test('Sol milestone writes stay in declared paths and freeze an exact already-main candidate', async t => {
  const f = fixture(t);
  const author = task(f, 'sol-author', 'sol', 'edit', { kind: 'milestone-author', milestoneId: 'M1', attempt: 1, paths: ['src/value.ts'] });
  f.gateway.prepareMilestoneAuthor(author.identity);
  const current = await f.gateway.call('file_read', { path: 'src/value.ts' }, author.identity);
  await f.gateway.call('file_write', { path: 'src/value.ts', text: 'export const value = 2;\n', expectedHash: (current.data as { hash: string }).hash }, author.identity);
  await assert.rejects(f.gateway.call('file_write', { path: 'src/outside.ts', text: 'bad\n', expectedHash: null }, author.identity), /越出声明路径/);
  await f.gateway.afterInvocation(author.identity, true); finish(author);
  const candidate = f.gateway.freezeMilestoneCandidate(f.chat, author.task);
  assert.deepEqual(candidate.changes, { modified: ['src/value.ts'], created: [], deleted: [] });
  assert.equal(f.registry.loadSnapshot(candidate.snapshotId).kind, 'baseline');
  writeFileSync(path.join(f.project, 'src', 'parallel.ts'), 'export const parallel = true;\n');
  assert.deepEqual(f.gateway.freezeMilestoneCandidate(f.chat, author.task), candidate, 'candidate freeze retry returns the first exact snapshot');
  const integrated = f.gateway.integrateMilestone(f.chat, author.task, candidate, ['src/value.ts']);
  assert.match(integrated.journalId, /^main-wsnap-/);
  assert.equal(readFileSync(path.join(f.project, 'src', 'value.ts'), 'utf8'), 'export const value = 2;\n');
  assert.equal(readFileSync(path.join(f.project, 'src', 'parallel.ts'), 'utf8'), 'export const parallel = true;\n');
  writeFileSync(path.join(f.project, 'src', 'value.ts'), 'external drift\n');
  assert.throws(() => f.gateway.integrateMilestone(f.chat, author.task, candidate, ['src/value.ts']), /声明路径已漂移/);
});

test('Opus candidate is reviewed from a fresh frozen clone and integrated idempotently by Sol', async t => {
  const f = fixture(t);
  const author = task(f, 'opus-author', 'opus', 'edit', { kind: 'milestone-author', milestoneId: 'M2', attempt: 1, paths: ['src/value.ts'] });
  f.gateway.prepareMilestoneAuthor(author.identity);
  if (author.task.pipelineWork.kind !== 'milestone-author') throw new Error('test binding mismatch');
  assert.ok(author.task.pipelineWork.baselineSnapshotId);
  assert.ok(author.task.pipelineWork.editSnapshotId);
  const current = await f.gateway.call('file_read', { path: 'src/value.ts' }, author.identity);
  await f.gateway.call('file_write', { path: 'src/value.ts', text: 'export const value = 3;\n', expectedHash: (current.data as { hash: string }).hash }, author.identity);
  await f.gateway.afterInvocation(author.identity, true); finish(author);
  const candidate = f.gateway.freezeMilestoneCandidate(f.chat, author.task);
  assert.equal(f.registry.loadSnapshot(candidate.snapshotId).kind, 'edit');
  const restartedAuthorGateway = new WorkspaceGateway(new WorkspaceRegistry(path.join(f.root, 'managed')));
  const resumed = await restartedAuthorGateway.call('file_read', { path: 'src/value.ts' }, author.identity);
  assert.equal((resumed.data as { text: string }).text, 'export const value = 3;\n');

  const reviewer = task(f, 'sol-reviewer', 'sol', 'verify', {
    kind: 'milestone-review', milestoneId: 'M2', attempt: 1, subjectHash: candidate.diffHash,
    subjectRef: 'blobs/candidate.json', snapshotId: candidate.snapshotId,
  });
  const reviewed = await f.gateway.call('file_read', { path: 'src/value.ts' }, reviewer.identity);
  assert.equal((reviewed.data as { text: string }).text, 'export const value = 3;\n');
  const authority = f.gateway.resultReadBaseline(f.chat, reviewer.task);
  assert.equal(authority.sourceRevision, 0);
  assert.match(authority.authority, new RegExp(`candidate:${candidate.snapshotId}:${candidate.fingerprint}$`));
  const prepared = f.gateway.prepareExec(reviewer.identity);
  assert.notEqual(prepared.sourceSnapshotId, candidate.snapshotId, 'reviewer receives a fresh read-only clone');
  assert.equal(prepared.sourceFingerprint, candidate.fingerprint);

  const integrator = task(f, 'sol-integrator', 'sol', 'edit', { kind: 'implementation-sol' });
  const first = f.gateway.integrateMilestone(f.chat, integrator.task, candidate, ['src/value.ts']);
  const repeated = f.gateway.integrateMilestone(f.chat, integrator.task, candidate, ['src/value.ts']);
  assert.deepEqual(repeated, first);
  assert.equal(f.chat.sourceRevisions?.[integrator.task.turnId], 1, 'idempotent retry does not create a second source epoch');
  const restarted = new WorkspaceGateway(new WorkspaceRegistry(path.join(f.root, 'managed')));
  assert.deepEqual(restarted.integrateMilestone(f.chat, integrator.task, candidate, ['src/value.ts']), first);
  assert.equal(f.chat.sourceRevisions?.[integrator.task.turnId], 1, 'restart retry uses the durable journal without creating a source epoch');
  assert.equal(readFileSync(path.join(f.project, 'src', 'value.ts'), 'utf8'), 'export const value = 3;\n');
  writeFileSync(path.join(f.project, 'src', 'value.ts'), 'drift after integration\n');
  assert.throws(() => restarted.integrateMilestone(f.chat, integrator.task, candidate, ['src/value.ts']), /已集成候选.*漂移/);
  writeFileSync(path.join(f.project, 'src', 'value.ts'), 'export const value = 3;\n');
  const journals = path.join(f.root, 'managed', 'integration', f.grant.id);
  writeFileSync(path.join(journals, 'later-uncertain.json'), `${JSON.stringify({ state: 'rollback_uncertain' })}\n`);
  assert.throws(() => f.gateway.integrateMilestone(f.chat, integrator.task, candidate, ['src/value.ts']), /未收口.*journal/);
});

for (const role of ['sol', 'opus'] as const) {
  test(`${role} candidate survives a restart after task_updated and before the parent freezes it`, async t => {
    const f = fixture(t);
    const author = task(f, 'author', role, 'edit', { kind: 'milestone-author', milestoneId: 'M1', attempt: 1, paths: ['src/value.ts'] });
    f.gateway.prepareMilestoneAuthor(author.identity);
    const original = await f.gateway.call('file_read', { path: 'src/value.ts' }, author.identity);
    await f.gateway.call('file_write', { path: 'src/value.ts', text: 'completed bytes\n', expectedHash: (original.data as { hash: string }).hash }, author.identity);
    await f.gateway.afterInvocation(author.identity, true);
    finish(author);
    f.store.commitEvent(f.chat, { type: 'task_updated', taskId: author.task.id, data: author.task });

    const chat = new ChatStore(path.join(f.root, 'chat')).get(f.chat.id);
    const saved = chat.tasks.find(item => item.id === author.task.id)!;
    const binding = saved.pipelineWork;
    assert.ok(binding?.kind === 'milestone-author' && binding.exitSnapshot);
    const cold = () => new WorkspaceGateway(new WorkspaceRegistry(path.join(f.root, 'managed')));
    const candidate = cold().freezeMilestoneCandidate(chat, saved);
    assert.equal(candidate.snapshotId, binding.exitSnapshot.snapshotId);
    assert.deepEqual(candidate, f.gateway.freezeMilestoneCandidate(f.chat, author.task));
    assert.equal(f.registry.loadSnapshot(candidate.snapshotId).files['src/value.ts'], sha('completed bytes\n'));

    // Older records have a durable baseline/edit binding and confirmed exits, without an exit snapshot.
    const exit = binding.exitSnapshot;
    delete binding.exitSnapshot;
    assert.equal(cold().freezeMilestoneCandidate(chat, saved).fingerprint, candidate.fingerprint);
    binding.exitSnapshot = exit;
    const editable = binding.editSnapshotId ? f.registry.loadSnapshot(binding.editSnapshotId).path : f.project;
    writeFileSync(path.join(editable, 'src/value.ts'), 'later edit\n');
    assert.deepEqual(cold().freezeMilestoneCandidate(chat, saved), candidate);
    assert.equal(readFileSync(path.join(editable, 'src/value.ts'), 'utf8'), 'later edit\n');
    binding.exitSnapshot = { ...exit, fingerprint: '0'.repeat(64) };
    assert.throws(() => cold().freezeMilestoneCandidate(chat, saved), /指纹/);
    binding.exitSnapshot = exit;
    chat.invocations[0]!.exitConfirmed = false;
    assert.throws(() => cold().freezeMilestoneCandidate(chat, saved), /未确认安全退出/);
  });
}

test('command-produced milestone drift is rejected before promotion or candidate freeze', async t => {
  const f = fixture(t);
  const sol = task(f, 'sol-command', 'sol', 'edit', { kind: 'milestone-author', milestoneId: 'M3', attempt: 1, paths: ['src/value.ts'] });
  f.gateway.prepareMilestoneAuthor(sol.identity);
  const prepared = f.gateway.prepareExec(sol.identity);
  writeFileSync(path.join(prepared.copyDir, 'src', 'outside.ts'), 'drift\n');
  assert.throws(() => f.gateway.finishExecWrites(sol.identity, prepared), /越出声明路径/);
  assert.equal(f.registry.fileHash(f.grant.id, 'src/outside.ts'), null);

  const opus = task(f, 'opus-command', 'opus', 'edit', { kind: 'milestone-author', milestoneId: 'M4', attempt: 1, paths: ['src/value.ts'] });
  f.gateway.prepareMilestoneAuthor(opus.identity);
  const isolated = f.gateway.prepareExec(opus.identity);
  writeFileSync(path.join(isolated.copyDir, 'src', 'outside.ts'), 'drift\n');
  await assert.rejects(f.gateway.afterInvocation(opus.identity, true), /越出声明路径/);
});

test('program verification always uses a fresh copy of current main', t => {
  const f = fixture(t);
  const verifier = task(f, 'program-verify', 'sol', 'verify', { kind: 'alignment', milestoneId: 'M1', attempt: 1 });
  const prepared = f.gateway.prepareVerification(f.chat, verifier.task);
  assert.match(prepared.sourceSnapshotId, /^wsnap-/);
  assert.match(prepared.testSnapshotId!, /^wsnap-/);
  assert.notEqual(prepared.sourceSnapshotId, prepared.testSnapshotId);
  writeFileSync(path.join(prepared.copyDir, 'generated.tmp'), 'test-only\n');
  assert.equal(f.registry.fileHash(f.grant.id, 'generated.tmp'), null);
});

test('verified main snapshots create stable per-chat Git checkpoints', t => {
  const f = fixture(t);
  const verifier = task(f, 'checkpoint-sol', 'sol', 'edit', { kind: 'implementation-sol' });
  const initial = f.gateway.prepareVerification(f.chat, verifier.task);
  const first = f.gateway.commitMilestone(f.chat, verifier.task, { snapshotId: initial.sourceSnapshotId, paths: ['.'], message: 'baseline' });
  assert.match(first, /^[0-9a-f]{40,64}$/);
  const current = f.registry.fileHash(f.grant.id, 'src/value.ts')!;
  f.registry.write(f.grant.id, 'src/value.ts', 'export const value = 4;\n', current);
  const updated = f.gateway.prepareVerification(f.chat, verifier.task);
  const second = f.gateway.commitMilestone(f.chat, verifier.task, { snapshotId: updated.sourceSnapshotId, paths: ['src/value.ts'], message: 'M1 verified' });
  assert.notEqual(second, first);
  const restarted = new WorkspaceGateway(new WorkspaceRegistry(path.join(f.root, 'managed')));
  assert.equal(restarted.commitMilestone(f.chat, verifier.task, { snapshotId: updated.sourceSnapshotId, paths: ['src/value.ts'], message: 'M1 verified' }), second);
  const nextRound = restarted.commitMilestone(f.chat, verifier.task, { snapshotId: updated.sourceSnapshotId, paths: ['.'], message: 'Pipeline round 2' });
  assert.notEqual(nextRound, second);
  assert.equal(restarted.commitMilestone(f.chat, verifier.task, { snapshotId: updated.sourceSnapshotId, paths: ['.'], message: 'Pipeline round 2' }), nextRound);
});
