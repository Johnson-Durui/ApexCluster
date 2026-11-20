import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../src/chat/store.js';
import { buildHandoff } from '../src/chat/handoff.js';
import { buildContext } from '../src/chat/context.js';
import type { AgentTask, Invocation } from '../src/chat/types.js';
import type { Roster } from '../src/chat/roster.js';

function fixture() {
  const store = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'handoff-')));
  const capabilities = { askUser: true, delegateSeats: ['sol'], writeMain: false, writeIsolated: false, integrate: false, acceptance: false, exec: false };
  const roster: Roster = { version: 1, rootSeat: 'claude', seats: [
    { id: 'claude', kind: 'lead', promptFile: 'claude.md', strengths: 'lead', bindings: { default: { model: 'model', effort: 'max', delegation: 'explicit' } }, can: capabilities },
    { id: 'sol', kind: 'builder', promptFile: 'sol.md', strengths: 'build', bindings: { default: { model: 'model-sol', effort: 'max', delegation: 'none' } }, can: { ...capabilities, askUser: false, delegateSeats: [], writeMain: true, integrate: true, exec: true } },
    { id: 'astra', kind: 'secondary', promptFile: 'astra.md', strengths: 'review', bindings: { default: { model: 'model-astra', effort: 'max', delegation: 'none' } }, can: { ...capabilities, askUser: false, delegateSeats: [], acceptance: true } },
  ], pools: [], layers: { architecture: { pools: [] }, implementation: { pools: [] } } };
  const chat = store.create({ apiRoster: { roster, modelHashes: {}, context: { seats: { initialMaxTokens: 80_000 } } } });
  const user = store.appendMessage(chat, { role: 'user', text: '必须保留：海量中文约束。' });
  const task: AgentTask = { id: 'root', turnId: 'turn', role: 'claude', goal: '完成交接', status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' };
  const child: AgentTask = { ...task, id: 'child', parentTaskId: task.id, role: 'sol', status: 'completed', disposition: 'adopted', resultRef: 'blobs/result.txt', resultHash: 'b'.repeat(64) };
  chat.tasks.push(task, child);
  chat.todos = Array.from({ length: 32 }, (_, index) => ({ id: `step-${index}`, taskId: task.id, text: `步骤${index}${'界'.repeat(500)}`, status: index ? 'pending' as const : 'in_progress' as const, dependsOn: [], linkedTaskIds: [], evidenceRefs: [], updatedAt: '' }));
  chat.planRevision = 7;
  chat.todos.push({ id: 'child-step', taskId: child.id, text: '子任务步骤', status: 'completed', dependsOn: [], linkedTaskIds: [child.id], evidenceRefs: [], updatedAt: '' });
  const note = store.putBlob(chat.id, 'note.txt', '这是模型笔记，不是事实。');
  task.notes = [{ version: 1, invocationId: 'inv', ref: note.relativePath, hash: note.hash, bytes: note.bytes }];
  const receipt = store.putBlob(chat.id, 'receipt.txt', '真实工具回执');
  const priorTest = store.putBlob(chat.id, 'prior-test.txt', '已交付测试回执');
  const invocation: Invocation = { id: 'inv', taskId: task.id, segment: 1, status: 'exited', startedAt: '', endedAt: '', toolCount: 1, promptVersion: 'v', inputEstimate: 0, contextWindow: 1_000_000, contextUsed: 120_000, peakUsed: 125_000, exitConfirmed: true,
    toolReceiptDeliveries: [{ id: 'inv:1', name: 'file_read', ref: receipt.relativePath, hash: receipt.hash, bytes: receipt.bytes }] };
  chat.invocations.push(invocation); task.invocationIds.push(invocation.id);
  chat.toolResults = [{ taskId: task.id, invocationId: 'prior-invocation', name: 'test_submit', provenance: 'runner',
    ref: priorTest.relativePath, hash: priorTest.hash, bytes: priorTest.bytes }];
  return { store, chat, task, child, invocation, sourceId: user.id, receipt };
}

test('handoff persists lossless state and bounds the Unicode first message by whole sections', () => {
  const { store, chat, task, child, invocation, sourceId, receipt } = fixture();
  const result = buildHandoff(chat, task, invocation, 'hard', store);
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 24_000);
  assert.match(result.text, new RegExp(result.stateRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(createHash('sha256').update(result.text).digest('hex'), result.hash);
  const stateText = store.readBlob(chat.id, result.stateRef).toString('utf8');
  assert.equal(createHash('sha256').update(stateText).digest('hex'), result.stateHash);
  const state = JSON.parse(stateText);
  assert.equal(state.northStar.sources[0].id, sourceId);
  assert.equal(state.program.plan.revision, 7);
  assert.equal(state.program.plan.steps.length, 33);
  assert.equal(state.program.plan.steps.find((item: { id: string }) => item.id === 'child-step').taskId, child.id);
  assert.equal(state.program.tasks.find((item: { id: string }) => item.id === child.id).disposition, 'adopted');
  assert.equal(state.program.receipts.unread[0].ref, receipt.relativePath);
  assert.equal(state.program.receipts.delivered[0].name, 'test_submit');
  assert.equal(state.notes.label, '模型笔记，不是程序事实');
  assert.equal(buildHandoff(chat, task, invocation, 'hard', store).hash, result.hash, 'same invocation/state is idempotent');
});

test('API context uses the latest verified handoff as its first prompt', () => {
  const { store, chat, task, invocation } = fixture();
  const handoff = buildHandoff(chat, task, invocation, 'yield', store);
  Object.assign(invocation, { handoffRef: handoff.ref, handoffHash: handoff.hash, handoffStateRef: handoff.stateRef, handoffStateHash: handoff.stateHash });
  assert.equal(buildContext(chat, task, store).prompt, handoff.text);
  invocation.handoffHash = '0'.repeat(64);
  assert.throws(() => buildContext(chat, task, store), /交接包哈希不一致/);
});

test('an oversized first-message handoff stays recoverable within the initial budget', () => {
  const { store, chat, task, invocation, sourceId } = fixture();
  chat.apiRoster!.context = { seats: { initialMaxTokens: 40_000 } };
  chat.todos = chat.todos!.slice(0, 12);
  task.phase = 'architecture';
  task.executionPolicyVersion = 1;
  const handoff = buildHandoff(chat, task, invocation, 'wait', store);
  Object.assign(invocation, { handoffRef: handoff.ref, handoffHash: handoff.hash, handoffStateRef: handoff.stateRef, handoffStateHash: handoff.stateHash });

  const context = buildContext(chat, task, store);
  assert.ok(context.inputEstimate <= 40_000);
  assert.match(context.prompt, /result_read/);
  assert.ok(context.prompt.includes(handoff.stateRef));
  assert.ok(context.prompt.includes(handoff.stateHash));
  assert.ok(context.systemPrompt.includes(store.message(chat.id, sourceId).text));
  assert.equal(task.sourcePagingRequired, undefined);
  assert.equal(store.readBlob(chat.id, handoff.ref).toString('utf8'), handoff.text);
  const recovered = store.readBlob(chat.id, handoff.stateRef);
  assert.equal(createHash('sha256').update(recovered).digest('hex'), handoff.stateHash);
  assert.equal(JSON.parse(recovered.toString('utf8')).program.plan.steps.length, 12);
});

test('five consecutive handoff prompts preserve every source, plan step, and child disposition', () => {
  const { store, chat, task, invocation } = fixture();
  let previous = invocation;
  let baseline: unknown;
  for (let index = 0; index < 5; index++) {
    const handoff = buildHandoff(chat, task, previous, 'hard', store);
    Object.assign(previous, { handoffRef: handoff.ref, handoffHash: handoff.hash, handoffStateRef: handoff.stateRef, handoffStateHash: handoff.stateHash });
    const stored = JSON.parse(store.readBlob(chat.id, handoff.stateRef).toString('utf8'));
    const facts = {
      sources: stored.northStar.sources,
      plan: stored.program.plan,
      tasks: stored.program.tasks.map(({ id, status, disposition }: { id: string; status: string; disposition?: string }) => ({ id, status, disposition })),
      unreadReceipts: stored.program.receipts.unread,
    };
    if (index === 0) baseline = facts;
    else assert.deepEqual(facts, baseline);
    assert.equal(buildContext(chat, task, store).prompt, handoff.text);
    assert.ok(Buffer.byteLength(handoff.text, 'utf8') <= 24_000);
    const { handoffRef: _ref, handoffHash: _hash, handoffStateRef: _stateRef, handoffStateHash: _stateHash, ...next } = previous;
    previous = { ...next, id: `inv-${index + 2}`, segment: index + 2, toolReceiptDeliveries: [] };
    chat.invocations.push(previous); task.invocationIds.push(previous.id); task.segment = previous.segment;
  }
});

test('reviewer handoffs preserve the exact execution contract owned by the root', () => {
  const { store, chat, task } = fixture();
  task.executionPolicyVersion = 1;
  const reviewer: AgentTask = {
    ...task, id: 'reviewer', parentTaskId: task.id, role: 'astra', goal: '独立验收', mode: 'verify',
    executionPolicyVersion: undefined, executionReviewOfTaskId: task.id, invocationIds: [], segment: 1,
  };
  const binding = {
    taskId: reviewer.id,
    contractHash: '1'.repeat(64),
    evidenceHash: '2'.repeat(64),
    viewRef: 'blobs/execution-view.json',
    viewHash: '3'.repeat(64),
    createdAt: '',
  };
  task.executionReviewAttempts = [binding];
  chat.tasks.push(reviewer);
  let previous: Invocation = {
    id: 'review-1', taskId: reviewer.id, segment: 1, status: 'exited', startedAt: '', endedAt: '',
    toolCount: 0, promptVersion: 'v', inputEstimate: 0, contextWindow: 1_000_000, contextUsed: 1_000,
    peakUsed: 1_000, exitConfirmed: true,
  };
  chat.invocations.push(previous);
  reviewer.invocationIds.push(previous.id);

  for (let index = 0; index < 2; index++) {
    const handoff = buildHandoff(chat, reviewer, previous, 'yield', store);
    const state = JSON.parse(store.readBlob(chat.id, handoff.stateRef).toString('utf8'));
    assert.deepEqual(state.northStar.executionContracts, [{
      contractHash: binding.contractHash,
      evidenceHash: binding.evidenceHash,
      taskId: reviewer.id,
      viewHash: binding.viewHash,
      viewRef: binding.viewRef,
    }]);
    previous = { ...previous, id: 'review-' + (index + 2), segment: previous.segment + 1 };
    chat.invocations.push(previous);
    reviewer.invocationIds.push(previous.id);
  }
});
