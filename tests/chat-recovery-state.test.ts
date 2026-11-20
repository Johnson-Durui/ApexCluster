import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ChatDriverError } from '../src/chat/drivers.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { sourceCoverageIssues } from '../src/chat/source-context.js';
import { HttpError } from '../src/orchestrator/errors.js';
import type { AgentTask, ChatDriver, ChatRole, DriverInput, DriverResult, ToolReply, WaitTicket } from '../src/chat/types.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const result = (text = 'done'): DriverResult => ({ text, exitConfirmed: true });
const json = <T>(reply: ToolReply): T => reply.data as T;
const now = () => new Date().toISOString();
const task = (id: string, parentTaskId?: string): AgentTask => ({ id, turnId: 'turn', ...(parentTaskId ? { parentTaskId } : {}), role: 'grok', goal: id, status: 'completed', createdAt: now(), updatedAt: now(), segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read', disposition: 'reference' });
const ticket = (id: string, taskId: string, status: WaitTicket['status'] = 'pending'): WaitTicket => ({ id, taskId, invocationId: `inv-${id}`, type: 'user', status, question: id, createdAt: now() });

function fixture(t: TestContext, invoke: (role: ChatRole, input: DriverInput) => Promise<DriverResult>) {
  const workRoot = path.join(process.cwd(), 'work'); mkdirSync(workRoot, { recursive: true });
  const root = mkdtempSync(path.join(workRoot, 'chat-recovery-'));
  t.after(() => { if (path.dirname(root) !== workRoot || !path.basename(root).startsWith('chat-recovery-')) throw new Error(`unsafe cleanup ${root}`); rmSync(root, { recursive: true, force: true }); });
  const driverErrors: unknown[] = [];
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke: async (input: DriverInput) => { try { return await invoke(role, input); } catch (error) { driverErrors.push(error); throw new ChatDriverError(error instanceof Error ? error.message : String(error), true); } } } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  return { runtime: new ChatRuntime({ store: new ChatStore(path.join(root, 'store')), drivers, handoffMs: 10 }), driverErrors };
}

function readBody(reply: ToolReply) {
  const header = /^\[程序分页 offset=(\d+) next=(\d+|null)\]\n/.exec(reply.text); assert.ok(header);
  return reply.text.slice(header[0].length);
}

test('explicit yield checkpoint survives exit and contains only self plus direct children', async (t) => {
  let runtime!: ChatRuntime; let yieldedInvocation = ''; const ids = { parent: 'parent', sibling: 'sibling', direct: 'direct', selfTicket: 'self-ticket', directTicket: 'direct-ticket', parentTicket: 'parent-ticket', siblingTicket: 'sibling-ticket' };
  const f = fixture(t, async (_role, input) => {
    const chat = runtime.get(input.chatId);
    if (input.task.segment === 1) {
      input.task.parentTaskId = ids.parent; yieldedInvocation = input.invocation.id;
      chat.tasks.push(task(ids.parent), task(ids.sibling, ids.parent), task(ids.direct, input.task.id));
      chat.tickets.push(ticket(ids.selfTicket, input.task.id), ticket(ids.directTicket, ids.direct), ticket(ids.parentTicket, ids.parent), ticket(ids.siblingTicket, ids.sibling));
      await input.callTool('task_yield', { next: 'resume exact verification', note: 'keep exact operator note' }); return result('yielded');
    }
    for (const pending of chat.tickets) pending.status = 'cancelled';
    await input.callTool('task_complete', { result: 'finished' }); return result();
  }); runtime = f.runtime;
  const chat = runtime.create({}); runtime.send(chat.id, { text: 'yield scope', clientMessageId: 'yield' }); await runtime.idle();
  assert.deepEqual(f.driverErrors, []);
  const checkpoints = chat.checkpoints.filter(checkpoint => checkpoint.invocationId === yieldedInvocation); assert.equal(checkpoints.length, 1);
  const checkpoint = checkpoints[0]!; assert.equal(checkpoint.next, 'resume exact verification'); assert.equal(checkpoint.note, 'keep exact operator note');
  assert.deepEqual(checkpoint.taskStates.map(state => state.id).sort(), [chat.tasks[0]!.id, ids.direct].sort());
  assert.deepEqual(checkpoint.pendingTicketIds.sort(), [ids.selfTicket, ids.directTicket].sort());
});

test('large task_state stays bounded, recoverable, original-goal grounded, and query-stable', async (t) => {
  const largeGoal = `ORIGINAL_GOAL_SENTINEL:${'g'.repeat(2600)}:ORIGINAL_GOAL_END`;
  let runtime!: ChatRuntime;
  const f = fixture(t, async (_role, input) => {
    const chat = runtime.get(input.chatId);
    assert.equal(input.task.goal, largeGoal);
    if (input.task.segment === 1) {
      assert.match(input.systemPrompt, /ORIGINAL_GOAL_SENTINEL:[g]+:ORIGINAL_GOAL_END/);
      for (let index = 0; index < 30; index++) chat.tasks.push(task(`child-${index}`, input.task.id));
      for (let index = 0; index < 30; index++) chat.tickets.push({ ...ticket(`ticket-${index}`, input.task.id, index < 15 ? 'pending' : 'resolved'), answer: `resolved-${index}-${'a'.repeat(1200)}`, processStatus: index < 15 ? undefined : 'exited' });
      const before = { tools: chat.toolResults?.length ?? 0, evidence: JSON.stringify(input.task.evidenceHashes), noProgress: input.task.noProgressSegments };
      let first: any;
      for (let index = 0; index < 3; index++) {
        const reply = await input.callTool('task_state', {}); assert.ok(reply.text.length <= 3800); const state = json<any>(reply); first ??= state;
        assert.equal(state.children.total, 30); assert.ok(state.children.shown < state.children.total); assert.equal(state.children.truncated, true);
        assert.equal(state.tickets.total, 30); assert.ok(state.tickets.shown < state.tickets.total); assert.equal(state.tickets.truncated, true);
        assert.ok(Array.isArray(state.recovery) && state.recovery.length > 0); assert.equal(JSON.stringify(state.tickets.items).includes('resolved-'), false, 'resolved answers stay out of compact state');
      }
      const catalog = json<{ entries: Array<{ name?: string }> }>(await input.callTool('task_evidence', {})); assert.equal(catalog.entries.some(entry => entry.name === 'task_state'), false);
      assert.equal(chat.toolResults?.length ?? 0, before.tools); assert.equal(JSON.stringify(input.task.evidenceHashes), before.evidence); assert.equal(input.task.noProgressSegments, before.noProgress);
      assert.equal(first.task.id, input.task.id); assert.ok(first.recovery.some((item: string) => /task_evidence|grok_collect/.test(item)));
      for (const pending of chat.tickets) if (pending.status === 'pending') pending.status = 'cancelled';
    }
    // Resolved user answers are now preserved original sources too; read them through the real tool gate.
    while (input.invocation.toolCount < 10) {
      const missing = sourceCoverageIssues(chat, input.task, runtime.store)[0]; if (!missing) break;
      const colon = missing.lastIndexOf(':'); assert.ok(colon > 0);
      await input.callTool('user_source_read', { sourceId: missing.slice(0, colon), offset: Number(missing.slice(colon + 1)) });
    }
    if (sourceCoverageIssues(chat, input.task, runtime.store).length) { await input.callTool('task_yield', { next: '继续核对已回答的用户原文' }); return result(); }
    await input.callTool('task_complete', { result: 'state recovered' }); return result();
  }); runtime = f.runtime;
  const chat = runtime.create({}); runtime.send(chat.id, { text: largeGoal, clientMessageId: 'large' }); await runtime.idle();
  assert.deepEqual(f.driverErrors, []); assert.equal(chat.tasks[0]?.status, 'completed');
});

test('recent receipts are deduplicated, capped, readable, and exclude unsafe or foreign evidence', async (t) => {
  let runtime!: ChatRuntime; let foreignRef = '';
  const f = fixture(t, async (_role, input) => {
    const chat = runtime.get(input.chatId);
    if (input.task.goal === 'foreign setup') {
      const foreign = runtime.store.putBlob(chat.id, 'foreign.txt', 'foreign'); foreignRef = foreign.relativePath;
      chat.toolResults = [{ taskId: input.task.id, invocationId: input.invocation.id, name: 'file_read', provenance: 'workspace', ref: foreign.relativePath, hash: foreign.hash, bytes: foreign.bytes }];
      await input.callTool('task_complete', { result: 'foreign ready' }); return result();
    }
    for (let index = 0; index < 10; index++) {
      const blob = runtime.store.putBlob(chat.id, `receipt-${index}.txt`, `receipt-${index}`);
      (chat.toolResults ??= []).push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'file_read', toolNumber: index + 1, provenance: 'workspace', ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    }
    chat.toolResults!.push({ ...chat.toolResults![0]! });
    const runner = runtime.store.putBlob(chat.id, 'runner-ok.txt', 'runner ok');
    const runnerTicket = { id: randomUUID(), taskId: input.task.id, invocationId: input.invocation.id, type: 'tool' as const, status: 'resolved' as const, createdAt: now(), externalId: 'runner-ok', resultRef: runner.relativePath, processStatus: 'exited' as const };
    chat.tickets.push(runnerTicket); chat.toolResults!.push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref: runner.relativePath, hash: runner.hash, bytes: runner.bytes });
    const failed = runtime.store.putBlob(chat.id, 'runner-failed.txt', 'runner failed'); chat.tickets.push({ ...runnerTicket, id: randomUUID(), externalId: 'runner-failed', resultRef: failed.relativePath });
    const unknown = runtime.store.putBlob(chat.id, 'runner-unknown.txt', 'runner unknown'); const unknownTicket = { ...runnerTicket, id: randomUUID(), externalId: 'runner-unknown', resultRef: unknown.relativePath, processStatus: 'exit_unknown' as const };
    chat.tickets.push(unknownTicket); chat.toolResults!.push({ taskId: input.task.id, invocationId: input.invocation.id, name: 'test_submit', provenance: 'runner', ref: unknown.relativePath, hash: unknown.hash, bytes: unknown.bytes });
    const before = chat.toolResults!.length;
    const stateReply = await input.callTool('task_state', {}); assert.ok(stateReply.text.length <= 3800); const state = json<any>(stateReply); const recent = state.recentReceipts;
    assert.equal(recent.total, 11); assert.equal(recent.shown, 8); assert.equal(recent.truncated, true); assert.equal(recent.items.length, recent.shown); assert.equal(new Set(recent.items.map((item: any) => `${item.ref}:${item.hash}`)).size, recent.items.length);
    assert.ok(recent.items.some((item: any) => item.ref === runner.relativePath && item.provenance === 'runner'));
    assert.equal(recent.items.some((item: any) => item.ref === failed.relativePath || item.ref === unknown.relativePath), false);
    assert.equal(readBody(await input.callTool('result_read', { ref: runner.relativePath })), 'runner ok');
    await assert.rejects(input.callTool('result_read', { ref: unknown.relativePath }), error => error instanceof HttpError && error.status === 403);
    await assert.rejects(input.callTool('result_read', { ref: foreignRef }), error => error instanceof HttpError && error.status === 403);
    assert.equal(chat.toolResults!.length, before);
    await input.callTool('task_complete', { result: 'recent receipts checked' }); return result();
  }); runtime = f.runtime;
  const foreign = runtime.create({}); runtime.send(foreign.id, { text: 'foreign setup', clientMessageId: 'foreign' }); await runtime.idle();
  const chat = runtime.create({}); runtime.send(chat.id, { text: 'inspect recent receipts', clientMessageId: 'main' }); await runtime.idle();
  assert.deepEqual(f.driverErrors, []); assert.equal(chat.tasks[0]?.status, 'completed');
});
