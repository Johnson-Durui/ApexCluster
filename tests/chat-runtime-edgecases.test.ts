import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ChatRuntime, type WorkspaceToolHost } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { AgentTask, ChatDriver, ChatRecord, ChatRole, DriverInput, Invocation } from '../src/chat/types.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(invoke: (input: DriverInput) => Promise<{ text: string; exitConfirmed: boolean }>, workspace?: WorkspaceToolHost) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chat-runtime-edge-'));
  const drivers = Object.fromEntries(roles.map(role => [role, {
    capability: { role, available: true, isolationVerified: true }, invoke,
  } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  return { root, store: new ChatStore(root), drivers, runtime: new ChatRuntime({ store: new ChatStore(root), drivers, workspace, handoffMs: 5 }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readHost(delays: Record<string, number>, failures: Set<string>): WorkspaceToolHost {
  return {
    definitions: [{ name: 'read_test', description: 'deterministic read fixture', inputSchema: {} }],
    assertWorkspace: () => ({ version: 1 }),
    call: async (_name, args) => {
      const key = String((args as { key: string }).key); await wait(delays[key] ?? 0);
      if (failures.has(key)) throw new Error(`read failed: ${key}`);
      return { text: `read ok: ${key}` };
    },
  };
}

for (const [label, delays] of Object.entries({ 'failure-first': { bad: 5, good: 25 }, 'success-first': { bad: 25, good: 5 } })) {
  test(`a successful concurrent ${label} call does not clear another argument's failure`, async () => {
    const workspace = readHost(delays, new Set(['bad']));
    const fx = fixture(async input => {
      await Promise.allSettled([input.callTool('read_test', { key: 'bad' }), input.callTool('read_test', { key: 'good' })]);
      try { await input.callTool('task_complete', { result: 'must stay blocked' }); } catch { /* Expected after the fix. */ }
      return { text: 'done', exitConfirmed: true };
    }, workspace);
    try {
      const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'parallel', clientMessageId: label }); await fx.runtime.idle();
      assert.equal(chat.tasks[0]!.status, 'failed', JSON.stringify({ error: chat.tasks[0]!.error, blocked: chat.blockedReason, invocations: chat.invocations })); assert.match(chat.tasks[0]!.error!, /read_test/);
    } finally { fx.cleanup(); }
  });
}

test('a successful retry with the exact same arguments clears its prior failure', async () => {
  let attempts = 0;
  const workspace: WorkspaceToolHost = {
    definitions: [{ name: 'read_test', description: 'retry fixture', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }),
    call: async (_name, args) => { assert.deepEqual(args, { key: 'same' }); if (++attempts === 1) throw new Error('first failure'); return { text: 'recovered' }; },
  };
  const fx = fixture(async input => {
    await assert.rejects(input.callTool('read_test', { key: 'same' }), /first failure/);
    await input.callTool('read_test', { key: 'same' });
    await input.callTool('task_complete', { result: 'recovered' });
    return { text: '', exitConfirmed: true };
  }, workspace);
  try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'retry', clientMessageId: 'retry' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

for (const [label, delays] of Object.entries({ 'failure-first': [5, 25], 'success-first': [25, 5] })) {
  test(`a concurrent same-argument success (${label}) is not treated as a retry`, async () => {
    let attempt = 0;
    const workspace: WorkspaceToolHost = {
      definitions: [{ name: 'read_test', description: 'same argument fixture', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }),
      call: async (_name, args) => { assert.deepEqual(args, { key: 'same' }); const current = attempt++; await wait(delays[current]!); if (current === 0) throw new Error('concurrent failure'); return { text: 'concurrent success' }; },
    };
    const fx = fixture(async input => {
      await Promise.allSettled([input.callTool('read_test', { key: 'same' }), input.callTool('read_test', { key: 'same' })]);
      try { await input.callTool('task_complete', { result: 'must stay blocked' }); } catch { /* Expected: neither call started after the failure. */ }
      return { text: '', exitConfirmed: true };
    }, workspace);
    try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'same concurrent', clientMessageId: `same-${label}` }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'failed'); assert.match(chat.tasks[0]!.error!, /read_test/); }
    finally { fx.cleanup(); }
  });
}

test('a successful retry clears only failures observed before that retry started', async () => {
  let attempt = 0;
  const workspace: WorkspaceToolHost = {
    definitions: [{ name: 'read_test', description: 'failure generation fixture', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }),
    call: async () => {
      const current = attempt++;
      if (current === 0) throw new Error('seed failure');
      await wait(current === 1 ? 10 : 30);
      if (current === 1) throw new Error('new retry failure');
      return { text: 'other retry succeeded' };
    },
  };
  const fx = fixture(async input => {
    await assert.rejects(input.callTool('read_test', { key: 'same' }), /seed failure/);
    await Promise.allSettled([input.callTool('read_test', { key: 'same' }), input.callTool('read_test', { key: 'same' })]);
    try { await input.callTool('task_complete', { result: 'must stay blocked' }); } catch { /* The newer retry failure remains. */ }
    return { text: '', exitConfirmed: true };
  }, workspace);
  try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'failure generations', clientMessageId: 'failure-generations' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'failed'); assert.match(chat.tasks[0]!.error!, /read_test/); }
  finally { fx.cleanup(); }
});

function recoveredRecord(store: ChatStore, childExit: Invocation['status']): ChatRecord {
  const chat = store.create();
  const parent: AgentTask = { id: 'parent', turnId: 'turn', role: 'claude', goal: 'parent', status: 'waiting_children', createdAt: '', updatedAt: '', segment: 1, invocationIds: ['parent-inv'], noProgressSegments: 0, mode: 'read' };
  const child: AgentTask = { id: 'child', turnId: 'turn', parentTaskId: parent.id, role: 'astra', goal: 'child', status: 'completed', createdAt: '', updatedAt: '', segment: 1, invocationIds: ['child-inv'], noProgressSegments: 0, mode: 'verify', disposition: 'reference', result: 'ok' };
  chat.tasks.push(parent, child); chat.turns.push({ id: 'turn', rootTaskId: parent.id, status: parent.status, createdAt: '' });
  chat.invocations.push(
    { id: 'parent-inv', taskId: parent.id, segment: 1, status: 'exited', exitConfirmed: true, startedAt: '', endedAt: '', toolCount: 1, promptVersion: 'test', inputEstimate: 0, contextWindow: null, contextUsed: null },
    { id: 'child-inv', taskId: child.id, segment: 1, status: childExit, exitConfirmed: childExit === 'exited', startedAt: '', endedAt: '', toolCount: 0, promptVersion: 'test', inputEstimate: 0, contextWindow: null, contextUsed: null },
  );
  chat.tickets.push({ id: 'children', taskId: parent.id, invocationId: 'parent-inv', type: 'children', childIds: [child.id], status: 'pending', createdAt: '' }); store.save(chat); return chat;
}

test('recovery resolves a completed child ticket and wakes its parent exactly once', async () => {
  let invoked = 0; const fx = fixture(async input => { invoked++; await input.callTool('task_complete', { result: 'resumed' }); return { text: '', exitConfirmed: true }; });
  try {
    const original = recoveredRecord(fx.store, 'exited'); const recovered = new ChatRuntime({ store: fx.store, drivers: fx.drivers }); recovered.recover(); await recovered.idle();
    const chat = recovered.get(original.id); assert.equal(invoked, 1); assert.equal(chat.tickets[0]!.status, 'resolved'); assert.equal(chat.tasks[0]!.status, 'completed');
    recovered.recover(); await recovered.idle(); assert.equal(invoked, 1);
  } finally { fx.cleanup(); }
});

test('recovery keeps a completed child ticket blocked when its process exit is unknown', async () => {
  let invoked = 0; const fx = fixture(async () => { invoked++; return { text: '', exitConfirmed: true }; });
  try {
    const original = recoveredRecord(fx.store, 'exit_unknown'); const recovered = new ChatRuntime({ store: fx.store, drivers: fx.drivers }); recovered.recover(); await recovered.idle();
    const chat = recovered.get(original.id); assert.equal(invoked, 0); assert.equal(chat.tickets[0]!.status, 'pending'); assert.equal(chat.tasks[0]!.status, 'waiting_children'); assert.ok(chat.blockedReason);
  } finally { fx.cleanup(); }
});

test('new result pages count as bounded progress across more than three segments', async () => {
  let calls = 0; let ref = '';
  const fx = fixture(async input => {
    calls++;
    if (calls === 1) { const artifact = await input.callTool('artifact_publish', { name: 'large.txt', text: 'page'.repeat(40_000), kind: 'report' }); ref = (artifact.data as { relativePath: string }).relativePath; }
    else if (calls <= 5) await input.callTool('result_read', { ref, offset: (calls - 2) * 3900 });
    if (calls <= 5) await input.callTool('task_yield', { next: 'continue paging' });
    else await input.callTool('task_complete', { result: 'all pages checked' });
    return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'pages', clientMessageId: 'pages' }); await fx.runtime.idle(); assert.equal(calls, 6); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('new task evidence pages count as progress across more than three segments', async () => {
  let calls = 0;
  const fx = fixture(async input => {
    calls++;
    if (calls === 1) for (let index = 0; index < 5; index++) await input.callTool('artifact_publish', { name: `evidence-${index}.txt`, text: `evidence-${index}`, kind: 'report' });
    else if (calls <= 5) await input.callTool('task_evidence', { offset: calls - 2, limit: 1 });
    if (calls <= 5) await input.callTool('task_yield', { next: 'continue evidence paging' });
    else await input.callTool('task_complete', { result: 'all evidence checked' });
    return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'evidence pages', clientMessageId: 'evidence-pages' }); await fx.runtime.idle(); assert.equal(calls, 6); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('one thousand supplied-page records remain durable while the model projection stays compact', async () => {
  const fx = fixture(async input => {
    const chat = fx.runtime.get(input.chatId); const artifact = await input.callTool('artifact_publish', { name: 'page-1000.txt', text: 'page-1000', kind: 'report' }); const ref = (artifact.data as { relativePath: string }).relativePath;
    input.task.evidenceReadCoverage = Array.from({ length: 999 }, (_, index) => createHash('sha256').update(`existing-${index}`).digest('hex'));
    (input.task as any).resultReadPages = Array.from({ length: 999 }, (_, index) => ({ ref: `blobs/existing-${index}.txt`, hash: createHash('sha256').update(`page-${index}`).digest('hex'), offset: 0, next: null, workspaceId: null, workspaceVersion: null, baselineAuthority: `task:${input.task.id}:no-workspace`, coverageIndex: index, firstInvocationId: `inv-${index}`, firstToolCallId: `inv-${index}:1` }));
    const first = await input.callTool('result_read', { ref, offset: 0 }); assert.match(first.text, /page-1000$/); assert.equal(input.task.evidenceReadCoverage.length, 1000); assert.equal((input.task as any).resultReadPages.length, 1000);
    const before = { reads: input.task.evidenceReadCoverage.length, pages: (input.task as any).resultReadPages.length, evidence: JSON.stringify(input.task.evidenceHashes), tools: JSON.stringify(chat.toolResults), artifacts: JSON.stringify(chat.artifacts) };
    const repeated = await input.callTool('result_read', { ref, offset: 0 }); assert.equal((repeated.data as any).alreadyProvided, true); assert.doesNotMatch(repeated.text, /page-1000/);
    assert.deepEqual({ reads: input.task.evidenceReadCoverage.length, pages: (input.task as any).resultReadPages.length, evidence: JSON.stringify(input.task.evidenceHashes), tools: JSON.stringify(chat.toolResults), artifacts: JSON.stringify(chat.artifacts) }, before);
    const state = (await input.callTool('task_state', {})).data as any; assert.equal(state.providedResultPages.total, 1000); assert.ok(state.providedResultPages.items.length <= 8); assert.equal(state.providedResultPages.truncated, true);
    await input.callTool('task_complete', { result: 'all 1000 page records retained' });
    return { text: '', exitConfirmed: true };
  });
  try {
    const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'large evidence set', clientMessageId: 'large-evidence' }); await fx.runtime.idle();
    assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); assert.equal(chat.tasks[0]!.evidenceReadCoverage?.length, 1000); assert.equal((chat.tasks[0] as any).resultReadPages.length, 1000);
  } finally { fx.cleanup(); }
});

test('a result page is supplied once across segments and recovery exposes a compact durable index', async () => {
  let calls = 0; let ref = ''; let original = ''; let notice = '';
  const fx = fixture(async input => {
    calls++;
    if (calls === 1) {
      const artifact = await input.callTool('artifact_publish', { name: 'r12-ledger.txt', text: 'ORIGINAL_RECEIPT_BODY', kind: 'report' }); ref = (artifact.data as { relativePath: string }).relativePath;
      original = (await input.callTool('result_read', { ref, offset: 0 })).text;
      await input.callTool('task_yield', { next: 'resume without rereading the supplied page' });
    } else {
      const chat = fx.runtime.get(input.chatId); const before = { reads: JSON.stringify(input.task.evidenceReadCoverage), evidence: JSON.stringify(input.task.evidenceHashes), tools: JSON.stringify(chat.toolResults), artifacts: JSON.stringify(chat.artifacts) };
      const state = (await input.callTool('task_state', {})).data as any;
      assert.equal(state.providedResultPages.total, 1); assert.equal(state.providedResultPages.items[0].ref, ref); assert.equal(state.providedResultPages.items[0].offset, 0);
      const repeated = await input.callTool('result_read', { ref, offset: 0 }); notice = repeated.text;
      assert.deepEqual(repeated.data, { alreadyProvided: true, originalContentIncluded: false, ref, hash: state.providedResultPages.items[0].hash, offset: 0, next: null, workspaceId: null, workspaceVersion: null, sourceRevision: null, baselineAuthority: state.providedResultPages.items[0].baselineAuthority, coverageIndex: state.providedResultPages.items[0].coverageIndex, firstInvocationId: state.providedResultPages.items[0].firstInvocationId, firstToolCallId: state.providedResultPages.items[0].firstToolCallId, legacy: false });
      assert.doesNotMatch(repeated.text, /ORIGINAL_RECEIPT_BODY/); assert.match(repeated.text, /已由当前任务.*提供.*不再次返回原文/);
      assert.deepEqual({ reads: JSON.stringify(input.task.evidenceReadCoverage), evidence: JSON.stringify(input.task.evidenceHashes), tools: JSON.stringify(chat.toolResults), artifacts: JSON.stringify(chat.artifacts) }, before);
      await input.callTool('task_complete', { result: 'deduplicated recovery complete' });
    }
    return { text: '', exitConfirmed: true };
  });
  try {
    const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'recover r12 receipt', clientMessageId: 'r12-repeat' }); await fx.runtime.idle();
    assert.equal(calls, 2); assert.match(original, /ORIGINAL_RECEIPT_BODY/); assert.match(notice, /alreadyProvided/); assert.equal(chat.tasks[0]!.status, 'completed', JSON.stringify({ error: chat.tasks[0]!.error, invocation: chat.invocations.at(-1) }));
    assert.equal((chat.tasks[0] as any).resultReadPages.length, 1);
  } finally { fx.cleanup(); }
});

test('runner metadata survives a segment without replaying an already supplied body', async () => {
  let calls = 0; let ref = ''; const snapshot = 'wsnap-32377ab5-8ca2-443e-b7d2-d6c027230d80'; const fingerprint = '39c718c94a02d99857aa368b1c8f9dbee80018767ccc70b83429d31d8d239537';
  const fx = fixture(async input => {
    calls++; const chat = fx.runtime.get(input.chatId);
    if (calls === 1) {
      const body = JSON.stringify({ ticketId: 'test-1', ok: true, result: { exitCode: 0, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'RUNNER_PRIVATE_BODY' }, testSnapshotId: 'wsnap-test-1', sourceSnapshotId: snapshot, sourceFingerprint: fingerprint, platform: 'linux' });
      const blob = fx.runtime.store.putBlob(chat.id, 'runner-recovery.json', body); ref = blob.relativePath;
      chat.tickets.push({ id: 'runner-ticket', taskId: input.task.id, invocationId: input.invocation.id, type: 'tool', status: 'resolved', createdAt: '', resultRef: ref, processStatus: 'exited' });
      (chat.toolResults ??= []).push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref, hash: blob.hash, bytes: blob.bytes });
      assert.match((await input.callTool('result_read', { ref, offset: 0 })).text, /RUNNER_PRIVATE_BODY/);
      for (let index = 0; index < 9; index++) input.task.resultReadPages!.push({ ref: `blobs/later-${index}.txt`, hash: String(index).padStart(64, '0'), offset: 0, next: null, workspaceId: null, workspaceVersion: null, sourceRevision: null, baselineAuthority: `task:${input.task.id}:no-workspace`, coverageIndex: 20 + index, firstInvocationId: `later-${index}`, firstToolCallId: `later-${index}:1` });
      await input.callTool('task_yield', { next: 'continue from program state without model notes' });
    } else {
      assert.match(input.systemPrompt, new RegExp(snapshot)); assert.match(input.systemPrompt, new RegExp(fingerprint)); assert.doesNotMatch(input.systemPrompt, /RUNNER_PRIVATE_BODY/);
      const state = (await input.callTool('task_state', {})).data as any; assert.equal(state.providedRunnerEvidence.total, 1); assert.equal(state.providedRunnerEvidence.items[0].currentBaseline, true);
      assert.equal(state.providedRunnerEvidence.items[0].metadata.sourceSnapshotId, snapshot); assert.equal(state.providedRunnerEvidence.items[0].metadata.bodyFirstToolCallId.endsWith(':1'), true);
      const evidence = (await input.callTool('task_evidence', {})).data as any; const runner = evidence.entries.find((entry: any) => entry.ref === ref); assert.equal(runner.providedRunnerEvidence.metadata.sourceFingerprint, fingerprint);
      const duplicate = await input.callTool('result_read', { ref, offset: 0 }); assert.equal((duplicate.data as any).alreadyProvided, true); assert.equal((duplicate.data as any).runnerEvidence.sourceFingerprint, fingerprint); assert.doesNotMatch(duplicate.text, /RUNNER_PRIVATE_BODY/);
      await input.callTool('task_complete', { result: 'runner metadata recovered without replay' });
    }
    return { text: '', exitConfirmed: true };
  });
  try {
    const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'runner recovery', clientMessageId: 'runner-recovery' }); await fx.runtime.idle(); assert.equal(calls, 2); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error);
    chat.tasks[0]!.resultReadPages = undefined; chat.tasks[0]!.evidenceReadCoverage = undefined; fx.runtime.store.save(chat);
    const recovered = new ChatRuntime({ store: new ChatStore(fx.root), drivers: fx.drivers, handoffMs: 5 }); recovered.recover();
    const restored = recovered.get(chat.id).tasks[0]!.resultReadPages ?? []; assert.equal(restored.length, 1); assert.equal(restored[0]!.runnerEvidence?.sourceSnapshotId, snapshot); assert.equal(restored[0]!.runnerEvidence?.bodyFirstToolCallId.endsWith(':1'), true);
  }
  finally { fx.cleanup(); }
});

test('runner metadata appears only after the complete immutable page chain was supplied', async () => {
  const fx = fixture(async input => {
    const chat = fx.runtime.get(input.chatId); const body = JSON.stringify({ ticketId: 'test-long', ok: true, result: { exitCode: 0, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'x'.repeat(5000) }, testSnapshotId: 'wsnap-test-long', sourceSnapshotId: 'wsnap-source-long', sourceFingerprint: 'a'.repeat(64), platform: 'windows' });
    const blob = fx.runtime.store.putBlob(chat.id, 'runner-long.json', body); chat.tickets.push({ id: 'runner-long', taskId: input.task.id, invocationId: input.invocation.id, type: 'tool', status: 'resolved', createdAt: '', resultRef: blob.relativePath, processStatus: 'exited' });
    (chat.toolResults ??= []).push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    assert.equal(((await input.callTool('task_state', {})).data as any).providedRunnerEvidence.total, 0, 'directory presence is not body delivery');
    const first = await input.callTool('result_read', { ref: blob.relativePath, offset: 0 }); assert.equal(((await input.callTool('task_state', {})).data as any).providedRunnerEvidence.total, 0, 'partial chain is not complete');
    const next = (first.data as { next: number }).next; await input.callTool('result_read', { ref: blob.relativePath, offset: next });
    const complete = ((await input.callTool('task_state', {})).data as any).providedRunnerEvidence; assert.equal(complete.total, 1); assert.equal(complete.items[0].metadata.sourceSnapshotId, 'wsnap-source-long');
    await input.callTool('task_complete', { result: 'long runner chain complete' }); return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'long runner', clientMessageId: 'long-runner' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('concurrent pages register runner metadata when the committed ledger completes the chain', async () => {
  const fx = fixture(async input => {
    const chat = fx.runtime.get(input.chatId); const body = JSON.stringify({ ok: true, result: { exitCode: 0, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'x'.repeat(5000) }, sourceSnapshotId: 'wsnap-concurrent-source', sourceFingerprint: 'd'.repeat(64), platform: 'linux' });
    const blob = fx.runtime.store.putBlob(chat.id, 'runner-concurrent.json', body); chat.tickets.push({ id: 'runner-concurrent', taskId: input.task.id, invocationId: input.invocation.id, type: 'tool', status: 'resolved', createdAt: '', resultRef: blob.relativePath, processStatus: 'exited' });
    (chat.toolResults ??= []).push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    const replies = await Promise.all([input.callTool('result_read', { ref: blob.relativePath, offset: 0 }), input.callTool('result_read', { ref: blob.relativePath, offset: 3900 })]); assert.equal(replies.filter(reply => reply.text.includes('x')).length, 2);
    const state = (await input.callTool('task_state', {})).data as any; assert.equal(state.providedRunnerEvidence.total, 1); assert.equal(state.providedRunnerEvidence.items[0].metadata.sourceSnapshotId, 'wsnap-concurrent-source'); assert.equal(input.task.resultReadPages?.length, 2);
    await input.callTool('task_complete', { result: 'concurrent runner chain registered' }); return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'concurrent runner pages', clientMessageId: 'concurrent-runner-pages' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('runner recovery rejects derived snapshot identities and marks stale source epochs', async () => {
  let revision = 0;
  const workspace: WorkspaceToolHost = { definitions: [], assertWorkspace: () => ({ version: 1 }), call: async () => { throw new Error('unused'); }, resultReadBaseline: (_chat, task) => ({ authority: `workspace:${task.workspaceId}:grant:${task.workspaceVersion}:source:${revision}`, sourceRevision: revision }) };
  const fx = fixture(async input => {
    const chat = fx.runtime.get(input.chatId); const malformed = JSON.stringify({ ok: true, result: { exitCode: 0, timedOut: false, cancelled: false, spawnError: null }, testSnapshotId: 'wsnap-derived-only', sourceFingerprint: 'b'.repeat(64), platform: 'linux' });
    const blob = fx.runtime.store.putBlob(chat.id, 'runner-derived.json', malformed); chat.tickets.push({ id: 'runner-derived', taskId: input.task.id, invocationId: input.invocation.id, type: 'tool', status: 'resolved', createdAt: '', resultRef: blob.relativePath, processStatus: 'exited' });
    (chat.toolResults ??= []).push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    await input.callTool('result_read', { ref: blob.relativePath, offset: 0 }); assert.equal(((await input.callTool('task_state', {})).data as any).providedRunnerEvidence.total, 0);
    const valid = JSON.stringify({ ok: true, result: { exitCode: 0, timedOut: false, cancelled: false, spawnError: null }, sourceSnapshotId: 'wsnap-real-source', sourceFingerprint: 'c'.repeat(64), platform: 'linux' });
    const validBlob = fx.runtime.store.putBlob(chat.id, 'runner-valid.json', valid); chat.tickets.push({ id: 'runner-valid', taskId: input.task.id, invocationId: input.invocation.id, type: 'tool', status: 'resolved', createdAt: '', resultRef: validBlob.relativePath, processStatus: 'exited' });
    chat.toolResults!.push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref: validBlob.relativePath, hash: validBlob.hash, bytes: validBlob.bytes }); await input.callTool('result_read', { ref: validBlob.relativePath, offset: 0 });
    revision = 1; const state = (await input.callTool('task_state', {})).data as any; assert.equal(state.providedRunnerEvidence.items[0].currentBaseline, false); assert.match(state.providedRunnerEvidence.currentBaselineAuthority, /source:1$/);
    await input.callTool('task_complete', { result: 'invalid identity and stale epoch rejected' }); return { text: '', exitConfirmed: true };
  }, workspace);
  try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'runner negatives', clientMessageId: 'runner-negatives' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('task evidence prefers current runner metadata and otherwise returns only the latest stale baseline', async () => {
  let revision = 0;
  const workspace: WorkspaceToolHost = { definitions: [], assertWorkspace: () => ({ version: 1 }), call: async () => { throw new Error('unused'); }, resultReadBaseline: (_chat, task) => ({ authority: `workspace:${task.workspaceId}:grant:${task.workspaceVersion}:source:${revision}`, sourceRevision: revision }) };
  const fx = fixture(async input => {
    const chat = fx.runtime.get(input.chatId); const body = JSON.stringify({ ok: true, result: { exitCode: 0, timedOut: false, cancelled: false, spawnError: null }, sourceSnapshotId: 'wsnap-baseline-choice', sourceFingerprint: 'e'.repeat(64), platform: 'linux' });
    const blob = fx.runtime.store.putBlob(chat.id, 'runner-baseline-choice.json', body); chat.tickets.push({ id: 'runner-baseline-choice', taskId: input.task.id, invocationId: input.invocation.id, type: 'tool', status: 'resolved', createdAt: '', resultRef: blob.relativePath, processStatus: 'exited' });
    (chat.toolResults ??= []).push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    await input.callTool('result_read', { ref: blob.relativePath, offset: 0 }); revision = 1; await input.callTool('result_read', { ref: blob.relativePath, offset: 0 });
    const state = ((await input.callTool('task_state', {})).data as any).providedRunnerEvidence.items; assert.deepEqual(state.map((item: any) => item.currentBaseline), [false, true]);
    const current = ((await input.callTool('task_evidence', {})).data as any).entries.find((entry: any) => entry.ref === blob.relativePath).providedRunnerEvidence; assert.equal(current.currentBaseline, true); assert.match(current.baselineAuthority, /source:1$/);
    revision = 2; const stale = ((await input.callTool('task_evidence', {})).data as any).entries.find((entry: any) => entry.ref === blob.relativePath).providedRunnerEvidence; assert.equal(stale.currentBaseline, false); assert.match(stale.baselineAuthority, /source:1$/);
    await input.callTool('task_complete', { result: 'baseline selection is deterministic' }); return { text: '', exitConfirmed: true };
  }, workspace);
  try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'runner baseline selection', clientMessageId: 'runner-baseline-selection' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('legacy opaque result coverage suppresses the same page without inventing first-call identities', async () => {
  const fx = fixture(async input => {
    const artifact = await input.callTool('artifact_publish', { name: 'legacy.txt', text: 'LEGACY_PRIVATE_BODY', kind: 'report' }); const ref = (artifact.data as { relativePath: string; hash: string }).relativePath;
    const chat = fx.runtime.get(input.chatId); const hash = chat.artifacts.find(item => item.relativePath === ref)!.hash;
    input.task.evidenceReadCoverage = [createHash('sha256').update(JSON.stringify({ read: 'result_read', ref, hash, offset: 0 })).digest('hex')];
    const reply = await input.callTool('result_read', { ref, offset: 0 }); const data = reply.data as any;
    assert.equal(data.alreadyProvided, true); assert.equal(data.legacy, true); assert.equal(data.firstInvocationId, null); assert.equal(data.firstToolCallId, null); assert.doesNotMatch(reply.text, /LEGACY_PRIVATE_BODY/);
    await input.callTool('task_complete', { result: 'legacy coverage honored' }); return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'legacy', clientMessageId: 'legacy-page' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed'); }
  finally { fx.cleanup(); }
});

test('an authoritative workspace baseline change permits the same immutable page to be supplied again', async () => {
  let version = 1;
  const workspace: WorkspaceToolHost = { definitions: [], assertWorkspace: (_id, expected) => { if (expected !== undefined) assert.equal(expected, version); return { version }; }, call: async () => { throw new Error('unused'); } };
  const fx = fixture(async input => {
    const artifact = await input.callTool('artifact_publish', { name: 'baseline.txt', text: 'BASELINE_BODY', kind: 'report' }); const ref = (artifact.data as { relativePath: string }).relativePath;
    assert.match((await input.callTool('result_read', { ref, offset: 0 })).text, /BASELINE_BODY/);
    version = 2; input.task.workspaceVersion = 2;
    const changed = await input.callTool('result_read', { ref, offset: 0 }); assert.match(changed.text, /BASELINE_BODY/); assert.equal((changed.data as any).alreadyProvided, undefined);
    assert.deepEqual((input.task as any).resultReadPages.map((page: any) => page.workspaceVersion), [1, 2]);
    await input.callTool('task_complete', { result: 'baseline changed' }); return { text: '', exitConfirmed: true };
  }, workspace);
  try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'baseline', clientMessageId: 'baseline-change' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed'); }
  finally { fx.cleanup(); }
});

test('a source revision change permits re-supply without changing the workspace grant', async () => {
  let revision = 0;
  const workspace: WorkspaceToolHost = { definitions: [], assertWorkspace: () => ({ version: 7 }), call: async () => { throw new Error('unused'); },
    resultReadBaseline: (_chat, task) => ({ authority: `workspace:${task.workspaceId}:grant:${task.workspaceVersion}:source:${revision}`, sourceRevision: revision }) };
  const fx = fixture(async input => {
    const artifact = await input.callTool('artifact_publish', { name: 'revision.txt', text: 'REVISION_BODY', kind: 'report' }); const ref = (artifact.data as { relativePath: string }).relativePath;
    assert.match((await input.callTool('result_read', { ref, offset: 0 })).text, /REVISION_BODY/);
    assert.equal((await input.callTool('result_read', { ref, offset: 0 }).then(reply => reply.data as any)).alreadyProvided, true);
    revision = 1;
    const changed = await input.callTool('result_read', { ref, offset: 0 }); assert.match(changed.text, /REVISION_BODY/);
    assert.deepEqual((input.task.resultReadPages ?? []).map(page => page.sourceRevision), [0, 1]);
    await input.callTool('task_complete', { result: 'revision changed' }); return { text: '', exitConfirmed: true };
  }, workspace);
  try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'source revision', clientMessageId: 'source-revision' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('tampering an existing result ref fails before body delivery or acknowledgement', async () => {
  const fx = fixture(async input => {
    const artifact = await input.callTool('artifact_publish', { name: 'immutable.txt', text: 'REGISTERED_BODY', kind: 'report' }); const ref = (artifact.data as { relativePath: string }).relativePath;
    const before = JSON.stringify({ reads: input.task.evidenceReadCoverage, pages: input.task.resultReadPages });
    writeFileSync(path.join(fx.root, 'chats', input.chatId, ref), 'TAMPERED_BODY');
    await assert.rejects(input.callTool('result_read', { ref, offset: 0 }), /哈希漂移/);
    assert.equal(JSON.stringify({ reads: input.task.evidenceReadCoverage, pages: input.task.resultReadPages }), before);
    await input.callTool('task_fail', { reason: 'immutable result ref drifted' }); return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'tamper', clientMessageId: 'tamper-ref' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'failed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('published artifacts stay chat-shared while raw sibling tool receipts remain scoped', async () => {
  let artifactRef = ''; let rawRef = ''; let release!: () => void; const published = new Promise<void>(resolve => { release = resolve; }); let rootCalls = 0;
  const workspace: WorkspaceToolHost = { definitions: [{ name: 'raw_read', description: 'raw receipt', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }), call: async () => ({ text: 'RAW_CHILD_BODY' }) };
  const fx = fixture(async input => {
    if (input.task.role === 'claude') {
      if (++rootCalls === 1) { await input.callTool('agent_submit', { role: 'sol', goal: 'publish child receipt', mode: 'read' }); await input.callTool('agent_submit', { role: 'sol', goal: 'attempt sibling read', mode: 'read' }); await input.callTool('grok_collect', { wait: true }); }
      else {
        assert.match((await input.callTool('result_read', { ref: artifactRef, offset: 0 })).text, /DIRECT_CHILD_BODY/);
        assert.match((await input.callTool('result_read', { ref: rawRef, offset: 0 })).text, /RAW_CHILD_BODY/);
        for (const child of fx.runtime.get(input.chatId).tasks.filter(task => task.parentTaskId === input.task.id)) await input.callTool('grok_disposition', { taskId: child.id, disposition: 'reference' });
        await input.callTool('task_complete', { result: 'shared artifact readable; raw sibling denied' });
      }
    } else if (input.task.goal === 'publish child receipt') {
      const artifact = await input.callTool('artifact_publish', { name: 'child.txt', text: 'DIRECT_CHILD_BODY', kind: 'report' }); artifactRef = (artifact.data as { relativePath: string }).relativePath;
      await input.callTool('raw_read', {}); rawRef = fx.runtime.get(input.chatId).toolResults!.find(result => result.taskId === input.task.id && result.name === 'raw_read')!.ref;
      release(); await input.callTool('task_complete', { result: 'published' });
    } else { await published; assert.match((await input.callTool('result_read', { ref: artifactRef, offset: 0 })).text, /DIRECT_CHILD_BODY/); await assert.rejects(input.callTool('result_read', { ref: rawRef, offset: 0 }), /没有该结果的读取权限/); await input.callTool('task_complete', { result: 'shared artifact read; raw sibling denied' }); }
    return { text: '', exitConfirmed: true };
  }, workspace);
  try { const chat = fx.runtime.create({ workspaceId: 'w' }); fx.runtime.send(chat.id, { text: 'scope artifacts', clientMessageId: 'artifact-scope' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { fx.cleanup(); }
});

test('concurrent reads expose one body and bind the duplicate notice to the first successful tool result', async () => {
  let ref = '';
  const fx = fixture(async input => {
    const artifact = await input.callTool('artifact_publish', { name: 'concurrent.txt', text: 'CONCURRENT_BODY', kind: 'report' }); ref = (artifact.data as { relativePath: string }).relativePath;
    const replies = await Promise.all([input.callTool('result_read', { ref, offset: 0 }), input.callTool('result_read', { ref, offset: 0 })]);
    assert.equal(replies.filter(reply => reply.text.includes('CONCURRENT_BODY')).length, 1); assert.equal(replies.filter(reply => (reply.data as any).alreadyProvided === true).length, 1);
    await input.callTool('task_complete', { result: 'concurrent read complete' }); return { text: '', exitConfirmed: true };
  });
  try {
    const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'concurrent read', clientMessageId: 'concurrent-page' }); await fx.runtime.idle();
    const events = fx.store.events(chat.id).items.filter(event => event.type === 'tool_result' && (event.data as any).name === 'result_read'); assert.equal(events.length, 2);
    const first = events.find(event => (event.data as any).readPage?.originalContentIncluded === true)!; const duplicate = events.find(event => (event.data as any).readPage?.alreadyProvided === true)!;
    assert.ok(first.seq < duplicate.seq); assert.equal((duplicate.data as any).readPage.firstToolCallId, (first.data as any).toolCallId); assert.equal((duplicate.data as any).readPage.firstInvocationId, first.invocationId);
  } finally { fx.cleanup(); }
});

test('a failed first result tool event does not leave a false supplied-page acknowledgement', async () => {
  const fx = fixture(async input => {
    const artifact = await input.callTool('artifact_publish', { name: 'event-failure.txt', text: 'EVENT_BODY', kind: 'report' }); const ref = (artifact.data as { relativePath: string }).relativePath;
    const append = fx.runtime.store.appendEvent.bind(fx.runtime.store); (fx.runtime.store as any).appendEvent = (chat: ChatRecord, event: any) => {
      if (event.type === 'tool_result' && event.data?.name === 'result_read') throw new Error('injected event persistence failure'); return append(chat, event);
    };
    await assert.rejects(input.callTool('result_read', { ref, offset: 0 }), /injected event persistence failure/); (fx.runtime.store as any).appendEvent = append;
    assert.equal((input.task as any).resultReadPages?.length ?? 0, 0); assert.equal(input.task.evidenceReadCoverage?.length ?? 0, 0);
    await input.callTool('task_fail', { reason: 'event persistence failed' }); return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'event failure', clientMessageId: 'event-failure' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'failed', JSON.stringify({ error: chat.tasks[0]!.error, invocation: chat.invocations[0] })); }
  finally { fx.cleanup(); }
});

test('a post-append result event error cannot roll back delivery or create success and error terminals', async () => {
  const fx = fixture(async input => {
    const artifact = await input.callTool('artifact_publish', { name: 'post-append.txt', text: 'POST_APPEND_BODY', kind: 'report' }); const ref = (artifact.data as { relativePath: string }).relativePath;
    const append = fx.runtime.store.appendEvent.bind(fx.runtime.store); let injected = false;
    (fx.runtime.store as any).appendEvent = (chat: ChatRecord, event: any) => {
      const saved = append(chat, event);
      if (!injected && event.type === 'tool_result' && event.data?.name === 'result_read') { injected = true; throw new Error('post-append bookkeeping failure'); }
      return saved;
    };
    const first = await input.callTool('result_read', { ref, offset: 0 }); assert.match(first.text, /POST_APPEND_BODY/);
    const duplicate = await input.callTool('result_read', { ref, offset: 0 }); assert.equal((duplicate.data as any).alreadyProvided, true); assert.doesNotMatch(duplicate.text, /POST_APPEND_BODY/);
    (fx.runtime.store as any).appendEvent = append;
    await input.callTool('task_complete', { result: 'post-append delivery retained' }); return { text: '', exitConfirmed: true };
  });
  try {
    const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'post append', clientMessageId: 'post-append' }); await fx.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error);
    const events = fx.runtime.store.events(chat.id).items.filter(event => (event.data as any)?.name === 'result_read');
    assert.equal(events.filter(event => event.type === 'tool_result').length, 2); assert.equal(events.filter(event => event.type === 'tool_error').length, 0); assert.equal(chat.tasks[0]!.resultReadPages?.length, 1);
    chat.tasks[0]!.resultReadPages = undefined; chat.tasks[0]!.evidenceReadCoverage = undefined; fx.runtime.store.save(chat);
    const recovered = new ChatRuntime({ store: new ChatStore(fx.root), drivers: fx.drivers, handoffMs: 5 }); recovered.recover();
    assert.equal(recovered.get(chat.id).tasks[0]!.resultReadPages?.length, 1); assert.equal(recovered.get(chat.id).tasks[0]!.evidenceReadCoverage?.length, 1);
  } finally { fx.cleanup(); }
});

test('re-reading the same result page still stops after three no-progress segments', async () => {
  let calls = 0; let ref = '';
  const fx = fixture(async input => {
    calls++;
    if (calls === 1) { const artifact = await input.callTool('artifact_publish', { name: 'large.txt', text: 'page'.repeat(4000), kind: 'report' }); ref = (artifact.data as { relativePath: string }).relativePath; }
    else await input.callTool('result_read', { ref, offset: 0 });
    await input.callTool('task_yield', { next: 'repeat' }); return { text: '', exitConfirmed: true };
  });
  try { const chat = fx.runtime.create({}); fx.runtime.send(chat.id, { text: 'repeat', clientMessageId: 'repeat' }); await fx.runtime.idle(); assert.equal(calls, 5); assert.equal(chat.tasks[0]!.status, 'failed'); assert.match(chat.tasks[0]!.error!, /三段/); }
  finally { fx.cleanup(); }
});
