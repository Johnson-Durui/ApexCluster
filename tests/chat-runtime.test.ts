import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { buildContext } from '../src/chat/context.js';
import { readSource, sourcePlan } from '../src/chat/source-context.js';
import { HttpError } from '../src/orchestrator/errors.js';
import { ChatDriverError } from '../src/chat/drivers.js';
import type { ChatDriver, ChatRole, DriverInput, DriverResult, ToolReply } from '../src/chat/types.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const result = (text = '完成'): DriverResult => ({ text, exitConfirmed: true });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate: () => boolean, timeout = 5000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise(r => setTimeout(r, 5)); } }
function setup(invoke: (role: ChatRole, input: DriverInput) => Promise<DriverResult>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-runtime-'));
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke: async (input: DriverInput) => { try { return await invoke(role, input); } catch (error) { if (error instanceof HttpError) throw new ChatDriverError(error.message, true); throw error; } } } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  const runtime = new ChatRuntime({ store: new ChatStore(dir), drivers, handoffMs: 20 });
  return { runtime, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ordinary answer becomes final only after process exit', async () => {
  let stop: ToolReply['stop']; const gate = deferred<DriverResult>(); const { runtime, cleanup } = setup(async (_r, i) => { stop = (await i.callTool('task_complete', { result: 'answer' })).stop; await assert.rejects(i.callTool('task_state', {}), /已结束/); return gate.promise; });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await until(() => runtime.activeCount === 1 && chat.invocations.length === 1); await new Promise(r => setTimeout(r, 20)); assert.equal(stop, 'completed'); assert.equal(chat.tasks[0]!.status, 'running'); gate.resolve(result()); await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed'); assert.equal(chat.tasks[0]!.result, 'answer'); } finally { gate.resolve(result()); cleanup(); }
});

test('plan_update query-verification rejection exposes stable actionable fields without mutating the plan', async () => {
  let caught: any;
  const { runtime, cleanup } = setup(async (_role, input) => {
    await assert.rejects(input.callTool('plan_update', { revision: 0, steps: [{ id: 'receipts', text: '核对回执', status: 'pending', verification: { kind: 'tool', toolName: 'task_evidence' } }] }), error => {
      caught = error; return error instanceof HttpError && /stepId=receipts.*invalidTool=task_evidence.*storedStatus=new/s.test(error.message);
    });
    await input.callTool('task_complete', { result: 'bad draft was rejected atomically' }); return result();
  });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'plan safely', clientMessageId: 'plan-1' }); await runtime.idle();
    assert.equal(caught?.code, 'PLAN_QUERY_VERIFICATION_FORBIDDEN');
    assert.deepEqual(caught?.details, { stepId: 'receipts', invalidTool: 'task_evidence', storedStatus: 'new', requestedStatus: 'pending', verificationLocked: false });
    assert.equal(chat.todos, undefined); assert.equal(chat.planRevision, undefined);
    const toolError = runtime.store.events(chat.id).items.find(item => item.type === 'tool_error');
    assert.deepEqual((toolError?.data as any).planError, { code: caught.code, details: caught.details });
  } finally { cleanup(); }
});

test('accepted completion cannot override an unknown process exit', async () => {
  let stop: ToolReply['stop']; const { runtime, cleanup } = setup(async (_r, i) => { stop = (await i.callTool('task_complete', { result: 'answer' })).stop; return { text: '', exitConfirmed: false, finishReason: 'exit_unknown' }; });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await runtime.idle(); assert.equal(stop, 'completed'); assert.equal(chat.tasks[0]!.status, 'interrupted'); assert.equal(chat.tasks[0]!.result, undefined); assert.ok(chat.blockedReason); } finally { cleanup(); }
});

test('task_fail finalizes only after a confirmed exit and preserves an unsuccessful report without completing the plan', async () => {
  const gate = deferred<DriverResult>(); let stop: ToolReply['stop'];
  const { runtime, cleanup } = setup(async (_role, input) => {
    await input.callTool('plan_update', { revision: 0, steps: [{ id: 'blocked', text: '无法继续', status: 'in_progress', verification: { kind: 'artifact', name: 'failure-report.md' } }] });
    await input.callTool('artifact_publish', { name: 'failure-report.md', text: 'observed failure', kind: 'report' });
    stop = (await input.callTool('task_fail', { reason: 'required verification failed', result: 'Failure report: tests did not meet the requirement.' })).stop;
    await assert.rejects(input.callTool('task_state', {}), /已结束/); return gate.promise;
  });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'fail explicitly', clientMessageId: 'task-fail' }); await until(() => stop === 'completed');
    assert.equal(chat.tasks[0]!.status, 'running'); gate.resolve(result()); await runtime.idle();
    const task = chat.tasks[0]!; assert.equal(task.status, 'failed'); assert.equal(task.error, 'required verification failed'); assert.match(task.result!, /Failure report/); assert.ok(task.resultRef);
    assert.equal(chat.todos?.[0]?.status, 'failed'); assert.equal(runtime.store.messages(chat.id).items.some(message => message.role === 'assistant'), false);
  } finally { gate.resolve(result()); cleanup(); }
});

test('task_fail cannot turn unknown exit or cancellation into a clean failure and rejects late calls', async () => {
  const unknown = setup(async (_role, input) => { await input.callTool('task_fail', { reason: 'known work failure', result: 'unsafe exit must win' }); return { text: '', exitConfirmed: false, finishReason: 'exit_unknown' }; });
  try {
    const chat = unknown.runtime.create({}); unknown.runtime.send(chat.id, { text: 'unknown', clientMessageId: 'unknown-fail' }); await unknown.runtime.idle();
    assert.equal(chat.tasks[0]!.status, 'interrupted'); assert.equal(chat.tasks[0]!.result, undefined); assert.ok(chat.blockedReason);
    await assert.rejects(unknown.runtime.callTool(chat.id, chat.invocations[0]!.id, 'task_fail', { reason: 'late' }), /已结束/);
  } finally { unknown.cleanup(); }

  const gate = deferred<DriverResult>(); const cancelled = setup(async (_role, input) => { await input.callTool('task_fail', { reason: 'cancel must win', result: 'not final' }); return gate.promise; });
  try {
    const chat = cancelled.runtime.create({}); cancelled.runtime.send(chat.id, { text: 'cancel', clientMessageId: 'cancel-fail' }); await until(() => cancelled.runtime.activeCount === 1 && chat.invocations[0]!.toolCount === 1);
    cancelled.runtime.cancel(chat.id); gate.resolve(result()); await cancelled.runtime.idle(); assert.equal(chat.tasks[0]!.status, 'cancelled'); assert.equal(chat.tasks[0]!.result, undefined);
  } finally { gate.resolve(result()); cancelled.cleanup(); }
});

test('task_fail parameter rejection is correctable and a safely failed child wakes its parent once', async () => {
  let parentCalls = 0; let childCalls = 0;
  const { runtime, cleanup } = setup(async (role, input) => {
    if (role === 'astra') { childCalls++; await input.callTool('task_fail', { reason: 'child verification failed', result: 'child failure evidence' }); return result(); }
    parentCalls++;
    if (parentCalls === 1) {
      await assert.rejects(input.callTool('task_fail', { reason: '', extra: true }), /Invalid input|too small|expected/i);
      const child = await input.callTool('agent_submit', { role: 'astra', goal: 'verify child', mode: 'verify' }); assert.ok(child.data);
      await input.callTool('grok_collect', { wait: true }); return result();
    }
    const child = runtime.get(input.chatId).tasks.find(task => task.parentTaskId === input.task.id)!; assert.equal(child.status, 'failed'); assert.equal(child.error, 'child verification failed');
    await input.callTool('grok_disposition', { taskId: child.id, disposition: 'rejected' });
    await input.callTool('task_fail', { reason: 'required child verification failed', result: 'parent observed the failed child' }); return result();
  });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'parent child failure', clientMessageId: 'parent-fail' }); await runtime.idle();
    assert.equal(childCalls, 1); assert.equal(parentCalls, 2); assert.equal(chat.tasks[0]!.status, 'failed'); assert.equal(chat.tickets.filter(ticket => ticket.type === 'children' && ticket.status === 'resolved').length, 1);
  } finally { cleanup(); }
});

test('task_fail cancels its unfinished owned subtree and waits for confirmed child exit before failing', async () => {
  const childStarted = deferred<void>(); let childAborted = false;
  const { runtime, cleanup } = setup(async (role, input) => {
    if (role === 'grok') {
      childStarted.resolve(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { childAborted = true; resolve(); }, { once: true })); return result('late child');
    }
    await input.callTool('grok_submit', { tasks: [{ goal: 'unfinished child' }] }); await childStarted.promise;
    await input.callTool('task_fail', { reason: 'parent cannot continue', result: 'subtree was stopped' }); return result();
  });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'stop subtree', clientMessageId: 'stop-subtree' }); await runtime.idle();
    assert.equal(childAborted, true); assert.equal(chat.tasks[0]!.status, 'failed'); const child = chat.tasks.find(task => task.parentTaskId === chat.tasks[0]!.id)!; assert.equal(child.status, 'cancelled');
    assert.equal(chat.invocations.find(invocation => invocation.taskId === child.id)?.exitConfirmed, true);
  } finally { cleanup(); }
});

test('task_fail persistence failure aborts every owned job and cannot accept a clean failed outcome', async () => {
  const childStarted = deferred<void>(); let childAborted = false; let runtime!: ChatRuntime;
  const built = setup(async (role, input) => {
    if (role === 'grok') { childStarted.resolve(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { childAborted = true; resolve(); }, { once: true })); return result('aborted child'); }
    await input.callTool('grok_submit', { tasks: [{ goal: 'owned child' }] }); await childStarted.promise;
    const append = runtime.store.appendEvent.bind(runtime.store); let injected = false;
    (runtime.store as any).appendEvent = (chat: any, event: any) => {
      if (!injected && event.type === 'task_updated' && event.data?.parentTaskId === input.task.id && event.data?.status === 'cancelled') { injected = true; throw new Error('injected child task persistence failure'); }
      return append(chat, event);
    };
    await assert.rejects(input.callTool('task_fail', { reason: 'must not be accepted' }), /injected child task persistence failure/);
    (runtime.store as any).appendEvent = append; return result();
  }); runtime = built.runtime;
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'fail persistence', clientMessageId: 'fail-persistence' }); await runtime.idle();
    assert.equal(childAborted, true); assert.equal(runtime.activeCount, 0); assert.equal(chat.tasks[0]!.status, 'interrupted'); assert.notEqual(chat.tasks[0]!.error, 'must not be accepted'); assert.ok(chat.blockedReason);
    const child = chat.tasks.find(task => task.parentTaskId === chat.tasks[0]!.id)!; assert.notEqual(chat.invocations.find(item => item.taskId === child.id)?.status, 'running');
  } finally { built.cleanup(); }
});

test('an interrupted child never resolves its parent children ticket or triggers a retry', async () => {
  let parentCalls = 0;
  const { runtime, cleanup } = setup(async (role, input) => {
    if (role === 'astra') { await input.callTool('task_fail', { reason: 'cannot verify safely' }); return { text: '', exitConfirmed: false, finishReason: 'exit_unknown' }; }
    parentCalls++; await input.callTool('agent_submit', { role: 'astra', goal: 'unsafe child', mode: 'verify' }); await input.callTool('grok_collect', { wait: true }); return result();
  });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'unsafe child', clientMessageId: 'unsafe-child' }); await runtime.idle();
    const child = chat.tasks.find(task => task.parentTaskId === chat.tasks[0]!.id)!; const ticket = chat.tickets.find(item => item.type === 'children')!;
    assert.equal(child.status, 'interrupted'); assert.equal(chat.invocations.find(item => item.taskId === child.id)?.exitConfirmed, false); assert.equal(ticket.status, 'pending'); assert.equal(parentCalls, 1);
  } finally { cleanup(); }
});

test('confirmed task_fail preserves its explicit report when the driver later throws', async () => {
  const canary = 'C:\\private\\credential.txt bearer-secret'; let parentCalls = 0;
  const { runtime, cleanup } = setup(async (role, input) => {
    if (role === 'astra') { await input.callTool('task_fail', { reason: 'verification target cannot pass', result: 'PUBLIC_FAILURE_REPORT' }); throw Object.assign(new Error(canary), { exitConfirmed: true }); }
    if (++parentCalls === 1) { await input.callTool('agent_submit', { role: 'astra', goal: 'failing verification', mode: 'verify' }); await input.callTool('grok_collect', { wait: true }); return result(); }
    const collected = await input.callTool('grok_collect', {}); assert.match(collected.text, /PUBLIC_FAILURE_REPORT/); assert.doesNotMatch(collected.text, /private|credential|bearer-secret/);
    const child = runtime.get(input.chatId).tasks.find(task => task.parentTaskId === input.task.id)!; assert.equal(child.error, 'verification target cannot pass'); assert.equal(child.result, 'PUBLIC_FAILURE_REPORT');
    await input.callTool('grok_disposition', { taskId: child.id, disposition: 'rejected' }); await input.callTool('task_complete', { result: 'failure was safely reported' }); return result();
  });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'explicit failure report', clientMessageId: 'explicit-failure' }); await runtime.idle();
    const child = chat.tasks.find(task => task.parentTaskId === chat.tasks[0]!.id)!; assert.equal(child.status, 'failed'); assert.equal(chat.tasks[0]!.status, 'completed');
    assert.match(chat.invocations.find(item => item.taskId === child.id)?.failureMessage ?? '', /private/);
  } finally { cleanup(); }
});

test('ask_user releases invocation and answer wakes exactly once', async () => {
  let count = 0; const { runtime, cleanup } = setup(async (_r, i) => { if (++count === 1) { assert.equal((await i.callTool('ask_user', { question: 'which?' })).stop, 'wait'); return result(); } return result('answered'); });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'waiting_user'); const ticket = chat.tickets[0]!; runtime.answer(chat.id, { ticketId: ticket.id, text: 'yes', clientMessageId: '2' }); runtime.answer(chat.id, { ticketId: ticket.id, text: 'yes', clientMessageId: '2' }); await runtime.idle(); assert.equal(count, 2); assert.equal(chat.tasks[0]!.status, 'completed'); } finally { cleanup(); }
});

test('Claude asks once and every collaborator receives the paired decision without a separate question tool', async () => {
  let rootCalls = 0; const seen = new Set<ChatRole>();
  const { runtime, cleanup } = setup(async (role, input) => {
    if (role !== 'claude') {
      seen.add(role);
      assert.match(input.systemPrompt, /目标运行平台是什么/); assert.match(input.systemPrompt, /Windows 11/); assert.match(input.systemPrompt, /Linux/);
      assert.equal(input.tools.some(tool => tool.name === 'ask_user'), false);
      await assert.rejects(input.callTool('ask_user', { question: '再问一次平台？' }), /没有该工具权限/);
      return result('根据共享决定补充实现建议');
    }
    if (++rootCalls === 1) {
      assert.ok(input.tools.some(tool => tool.name === 'ask_user'));
      await input.callTool('ask_user', { question: '目标运行平台是什么？', options: ['Windows 11', 'Linux'] });
    } else if (rootCalls === 2) {
      await input.callTool('agent_submit', { role: 'astra', goal: '围绕当前方案检查 Windows 约束', mode: 'read' });
      await input.callTool('agent_submit', { role: 'sol', goal: '补充同一方案的实现约束', mode: 'read' });
      await input.callTool('grok_submit', { tasks: [{ goal: '整理现有资料', mode: 'read' }] });
      await input.callTool('grok_collect', { wait: true });
    } else {
      for (const child of runtime.get(input.chatId).tasks.filter(task => task.parentTaskId === input.task.id)) {
        await input.callTool('grok_disposition', { taskId: child.id, disposition: 'adopted' });
      }
      await input.callTool('task_complete', { result: 'Claude 汇总共同方案' });
    }
    return result();
  });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: '协作设计架构', clientMessageId: 'architecture-1' }); await runtime.idle();
    assert.equal(chat.tasks[0]!.status, 'waiting_user'); assert.equal(chat.tickets.filter(ticket => ticket.type === 'user').length, 1);
    runtime.answer(chat.id, { ticketId: chat.tickets[0]!.id, text: 'Windows 11', clientMessageId: 'architecture-2' }); await runtime.idle();
    assert.deepEqual([...seen].sort(), ['astra', 'grok', 'sol']);
    assert.equal(chat.tickets.filter(ticket => ticket.type === 'user').length, 1); assert.equal(chat.tasks[0]!.status, 'completed');
  } finally { cleanup(); }
});

test('real answer and steering paths link long decisions once and preserve sharing through paging and restart', async () => {
  const cursors = new Map<string, number | null>();
  const { runtime, dir, cleanup } = setup(async (_role, input) => {
    const chat = runtime.get(input.chatId);
    if (!chat.tickets.some(ticket => ticket.type === 'user')) {
      await input.callTool('ask_user', { question: '请给出完整部署约束？', options: ['按完整说明'] }); return result();
    }
    if (!sourcePlan(chat, input.task, runtime.store).inline) {
      const reply = await input.callTool('user_source_list', { limit: 40 }); let actions = 1;
      const sources = (reply.data as { sources: { id: string }[] }).sources;
      for (const source of sources) {
        const key = `${chat.id}:${source.id}`; let offset: number | null = cursors.has(key) ? cursors.get(key)! : 0;
        while (offset !== null && actions < 10) {
          const page = await input.callTool('user_source_read', { sourceId: source.id, offset }); actions++;
          offset = (page.data as { next: number | null }).next; cursors.set(key, offset);
        }
      }
      if (sources.some(source => cursors.get(`${chat.id}:${source.id}`) !== null)) {
        await input.callTool('task_yield', { next: '继续读取剩余决定原文' }); return result();
      }
    }
    await input.callTool('task_complete', { result: '使用共享决定完成架构' }); return result();
  });
  try {
    for (const steering of [false, true]) {
      const chat = runtime.create({}); runtime.send(chat.id, { text: '架构协作', clientMessageId: 'first' }); await runtime.idle();
      const answer = '决定开始|' + '保留部署约束😀'.repeat(steering ? 1500 : 200) + '|决定结束';
      if (steering) runtime.send(chat.id, { text: answer, clientMessageId: 'decision' });
      else runtime.answer(chat.id, { ticketId: chat.tickets[0]!.id, text: answer, clientMessageId: 'decision' });
      await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error);
      const restarted = new ChatStore(dir); const loaded = restarted.get(chat.id); const task = loaded.tasks[0]!; const ticket = loaded.tickets[0]!;
      assert.ok(ticket.answerMessageId); assert.equal(restarted.message(chat.id, ticket.answerMessageId).text, answer);
      const pair = JSON.parse(readSource(loaded, task, restarted, { sourceId: `clarification:${ticket.id}`, offset: 0 }).text);
      assert.equal(pair.answerSourceId, ticket.answerMessageId); assert.equal(pair.answer, undefined);
      assert.equal(sourcePlan(loaded, task, restarted).inline, !steering);
      for (const role of roles) {
        task.role = role; const context = buildContext(loaded, task, restarted); assert.ok(context.inputEstimate <= 24_000);
        if (!steering) { assert.match(context.systemPrompt, /请给出完整部署约束/); assert.equal(context.systemPrompt.split(answer).length - 1, 1); }
      }
    }
  } finally { cleanup(); }
});

test('steering starts a fresh segment with the added message', async () => {
  const started = deferred<void>(); let calls = 0; let prompt = ''; const { runtime, cleanup } = setup(async (_r, i) => { calls++; if (calls === 1) { started.resolve(); await new Promise<void>(r => i.signal.addEventListener('abort', () => r(), { once: true })); return result(); } prompt = i.prompt; return result('done'); });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'first', clientMessageId: '1' }); await started.promise; runtime.send(chat.id, { text: 'more', clientMessageId: '2' }); await runtime.idle(); assert.equal(calls, 2); assert.match(prompt, /more/); assert.equal(chat.tasks[0]!.status, 'completed'); } finally { cleanup(); }
});

test('cancellation cannot be undone by a late driver result', async () => {
  const gate = deferred<DriverResult>(); const { runtime, cleanup } = setup(async () => gate.promise);
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await until(() => runtime.activeCount === 1); runtime.cancel(chat.id); gate.resolve(result('late')); await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'cancelled'); assert.equal(chat.tasks[0]!.result, undefined); } finally { cleanup(); }
});

test('unknown exit blocks further dispatch', async () => {
  const { runtime, cleanup } = setup(async () => ({ text: 'unsafe', exitConfirmed: false }));
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'interrupted'); assert.ok(chat.blockedReason); assert.throws(() => runtime.send(chat.id, { text: 'again', clientMessageId: '2' })); } finally { cleanup(); }
});

test('unknown post-dispatch failure durably preserves a bounded sanitized cause and phase', async () => {
  const raw = `driver failed\u0000with secret line\n${'x'.repeat(2000)}`;
  const { runtime, dir, cleanup } = setup(async () => { throw new ChatDriverError(raw, false, 'post_dispatch'); });
  try {
    const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await runtime.idle();
    const invocation = chat.invocations[0]!;
    assert.equal(chat.tasks[0]!.status, 'interrupted');
    assert.equal(invocation.status, 'exit_unknown');
    assert.equal(invocation.failurePhase, 'post_dispatch');
    assert.ok(invocation.failureMessage?.startsWith('driver failed with secret line '));
    assert.ok((invocation.failureMessage?.length ?? 0) <= 1000);
    assert.equal(chat.tasks[0]!.error, invocation.failureMessage);
    assert.ok(chat.blockedReason);
    const persisted = new ChatStore(dir).get(chat.id);
    assert.equal(persisted.invocations[0]!.failureMessage, invocation.failureMessage);
    assert.equal(persisted.invocations[0]!.failurePhase, 'post_dispatch');
    const ended = new ChatStore(dir).events(chat.id).items.find(event => event.type === 'invocation_ended');
    assert.equal((ended?.data as { failureMessage?: string }).failureMessage, invocation.failureMessage);
  } finally { cleanup(); }
});

test('12 tool actions rotate and three unproductive segments stop', async () => {
  let segments = 0; const { runtime, cleanup } = setup(async (_r, i) => { segments++; for (let n = 0; n < 12; n++) { const reply = await i.callTool('grok_collect', {}); if (n === 11) assert.equal(reply.stop, 'rotate'); } return result(); });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await runtime.idle(); assert.equal(segments, 3); assert.equal(chat.tasks[0]!.status, 'failed'); } finally { cleanup(); }
});

test('reported context usage at 50 percent forces a new segment', async () => {
  let calls = 0; const { runtime, cleanup } = setup(async (_role, input) => { if (++calls === 1) { (input as DriverInput & { onContext: (usage: { window: number; used: number }) => void }).onContext({ window: 100, used: 50 }); await assert.rejects(input.callTool('grok_collect', {})); return result('partial'); } return result('final'); });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'hello', clientMessageId: '1' }); await runtime.idle(); assert.equal(calls, 2); assert.equal(chat.tasks[0]!.result, 'final'); } finally { cleanup(); }
});

test('Grok concurrency is capped at eight and parent waits for exit and disposition', async () => {
  const gate = deferred<void>(); let running = 0; let peak = 0; let parentCalls = 0;
  const { runtime, cleanup } = setup(async (role, i) => {
    if (role === 'grok') { running++; peak = Math.max(peak, running); await gate.promise; running--; return result('child'); }
    if (++parentCalls === 1) {
      await i.callTool('grok_submit', { tasks: Array.from({ length: 9 }, (_, n) => ({ goal: `child ${n}` })) });
      await assert.rejects(i.callTool('task_complete', { result: 'too early' }));
      await i.callTool('grok_collect', { wait: true }); return result();
    }
    for (const child of runtime.get(i.chatId).tasks.filter(t => t.parentTaskId === i.task.id)) await i.callTool('grok_disposition', { taskId: child.id, disposition: 'reference' });
    await i.callTool('task_complete', { result: 'parent' }); return result();
  });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'delegate', clientMessageId: '1' }); await until(() => running === 8); assert.equal(chat.tasks[0]!.status, 'waiting_children'); assert.equal(chat.tasks.filter(t => t.role === 'grok' && t.status === 'queued').length, 1); gate.resolve(); await runtime.idle(15000); assert.equal(peak, 8); assert.equal(chat.tasks[0]!.status, 'completed'); assert.equal(chat.tasks.filter(t => t.role === 'grok' && t.disposition === 'reference').length, 9); } finally { gate.resolve(); cleanup(); }
});

test('Grok wait handoff preserves children when the parent driver exits as cancelled', async () => {
  const childGates = [deferred<void>(), deferred<void>()]; const childrenStarted = deferred<void>(); const childSignals: AbortSignal[] = []; let startedChildren = 0; let parentCalls = 0; let ticketResolutions = 0;
  const { runtime, cleanup } = setup(async (role, i) => {
    if (role === 'grok') {
      const index = Number(i.task.goal.slice(-1)); childSignals[index] = i.signal;
      if (++startedChildren === 2) childrenStarted.resolve();
      await childGates[index]!.promise; return result(`child ${index}`);
    }
    if (++parentCalls === 1) {
      await i.callTool('grok_submit', { tasks: [{ goal: 'child 0' }, { goal: 'child 1' }] });
      await i.callTool('grok_collect', { wait: true });
      if (!i.signal.aborted) await new Promise<void>(resolve => i.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ...result(), finishReason: 'cancelled' };
    }
    for (const child of runtime.get(i.chatId).tasks.filter(t => t.parentTaskId === i.task.id)) await i.callTool('grok_disposition', { taskId: child.id, disposition: 'reference' });
    await i.callTool('task_complete', { result: 'parent' }); return result();
  });
  try {
    const chat = runtime.create({});
    const unsubscribe = runtime.subscribe(chat.id, event => { if (event.type === 'ticket_updated' && (event.data as { type?: string; status?: string }).type === 'children' && (event.data as { status?: string }).status === 'resolved') ticketResolutions++; });
    try {
      runtime.send(chat.id, { text: 'delegate', clientMessageId: '1' }); await childrenStarted.promise;
      await until(() => chat.invocations.filter(invocation => invocation.taskId === chat.tasks[0]!.id)[0]?.status === 'exited');
      const parent = chat.tasks[0]!; const ticket = chat.tickets.find(candidate => candidate.taskId === parent.id && candidate.type === 'children')!;
      const firstParentInvocation = chat.invocations.find(invocation => invocation.id === parent.invocationIds[0])!;
      assert.equal(parent.status, 'waiting_children'); assert.equal(ticket.status, 'pending'); assert.equal(ticketResolutions, 0);
      assert.deepEqual(childSignals.map(signal => signal.aborted), [false, false]);
      assert.equal(firstParentInvocation.status, 'exited'); assert.equal(firstParentInvocation.exitConfirmed, true); assert.equal(firstParentInvocation.finishReason, 'cancelled');

      childGates[0]!.resolve(); await until(() => chat.tasks.find(task => task.goal === 'child 0')?.status === 'completed');
      assert.equal(ticket.status, 'pending'); assert.equal(ticketResolutions, 0); assert.equal(parentCalls, 1);

      childGates[1]!.resolve(); await runtime.idle();
      assert.equal(ticket.status, 'resolved'); assert.equal(ticketResolutions, 1); assert.equal(parentCalls, 2);
      assert.equal(parent.invocationIds.length, 2); assert.equal(parent.status, 'completed');
      assert.equal(chat.tasks.filter(task => task.parentTaskId === parent.id && task.disposition === 'reference').length, 2);
    } finally { unsubscribe(); }
  } finally { childGates.forEach(gate => gate.resolve()); cleanup(); }
});

test('revoking workspace aborts an in-flight tool and ignores its late completion', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-revoke-')); const gate = deferred<void>(); const started = deferred<void>(); let signal: AbortSignal | undefined; let rejected = false;
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke: async (i: DriverInput) => { try { await i.callTool('read_test', {}); } catch { rejected = true; } return result('late'); } } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  const runtime = new ChatRuntime({ store: new ChatStore(dir), drivers, workspace: { definitions: [{ name: 'read_test', description: 'test', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }), call: async (_n, _a, identity) => { signal = identity.signal; started.resolve(); await gate.promise; return { text: 'late' }; } } });
  try { const chat = runtime.create({ workspaceId: 'w' }); runtime.send(chat.id, { text: 'read', clientMessageId: '1' }); await started.promise; runtime.revokeWorkspace('w'); assert.equal(signal?.aborted, true); gate.resolve(); await runtime.idle(); assert.equal(rejected, true); assert.equal(chat.tasks[0]!.status, 'cancelled'); assert.equal(chat.tasks[0]!.result, undefined); } finally { gate.resolve(); rmSync(dir, { recursive: true, force: true }); }
});

test('a parent cannot submit over 32 per batch or have over 32 outstanding', async () => {
  const gate = deferred<void>(); let checked = false;
  const { runtime, cleanup } = setup(async (role, i) => {
    if (role === 'grok') { await gate.promise; return result('child'); }
    await assert.rejects(i.callTool('grok_submit', { tasks: Array.from({ length: 33 }, () => ({ goal: 'x' })) }));
    await i.callTool('grok_submit', { tasks: Array.from({ length: 32 }, () => ({ goal: 'x' })) });
    await assert.rejects(i.callTool('grok_submit', { tasks: [{ goal: 'overflow' }] })); checked = true; await gate.promise; return result('done');
  });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'delegate', clientMessageId: '1' }); await until(() => checked); assert.equal(chat.tasks.filter(t => t.role === 'grok').length, 32); runtime.cancel(chat.id); gate.resolve(); await runtime.idle(15000); } finally { gate.resolve(); cleanup(); }
});

for (const delegatedRole of ['astra', 'sol'] as const) test(`${delegatedRole} can delegate to Grok and results require disposition`, async () => {
  const segments = new Map<string, number>();
  const { runtime, cleanup } = setup(async (role, i) => {
    if (role === 'grok') return result('grok result');
    const segment = (segments.get(i.task.id) ?? 0) + 1; segments.set(i.task.id, segment);
    if (segment === 1) {
      if (role === 'claude') await i.callTool('agent_submit', { role: delegatedRole, goal: 'delegate' });
      else await i.callTool('grok_submit', { tasks: [{ goal: 'inspect' }] });
      await i.callTool('grok_collect', { wait: true }); return result();
    }
    const child = runtime.get(i.chatId).tasks.find(t => t.parentTaskId === i.task.id)!;
    await i.callTool('grok_disposition', { taskId: child.id, disposition: 'reference' });
    return result(`${role} done`);
  });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'delegate', clientMessageId: '1' }); await runtime.idle(15000); assert.equal(chat.tasks[0]!.status, 'completed'); assert.equal(chat.tasks.find(t => t.role === delegatedRole)?.status, 'completed'); assert.equal(chat.tasks.find(t => t.role === 'grok')?.status, 'completed'); } finally { cleanup(); }
});

test('steering the root preserves an already running Grok child', async () => {
  const childStarted = deferred<void>(); const childGate = deferred<void>(); let aborted = false; let rootCalls = 0;
  const { runtime, cleanup } = setup(async (role, i) => {
    if (role === 'grok') { i.signal.addEventListener('abort', () => { aborted = true; }); childStarted.resolve(); await childGate.promise; return result('child'); }
    if (++rootCalls === 1) { await i.callTool('grok_submit', { tasks: [{ goal: 'child' }] }); await i.callTool('grok_collect', { wait: true }); return result(); }
    const child = runtime.get(i.chatId).tasks.find(t => t.parentTaskId === i.task.id)!;
    if (child.status !== 'completed') { await i.callTool('grok_collect', { wait: true }); return result(); }
    await i.callTool('grok_disposition', { taskId: child.id, disposition: 'reference' }); return result('done');
  });
  try { const chat = runtime.create({}); runtime.send(chat.id, { text: 'start', clientMessageId: '1' }); await childStarted.promise; runtime.send(chat.id, { text: 'more', clientMessageId: '2' }); await new Promise(r => setTimeout(r, 60)); assert.equal(aborted, false); childGate.resolve(); await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed'); } finally { childGate.resolve(); cleanup(); }
});

test('1000 Grok tasks run in bounded batches without a cumulative cap', { timeout: 60000 }, async () => {
  // Persistence is tested separately; this store keeps the scheduling stress test in memory.
  const messages: any[] = []; const blobs = new Map<string, Buffer>(); let chat: any;
  const store = {
    create: () => chat = { version: 1, id: randomUUID(), title: '新聊天', createdAt: '', updatedAt: '', seq: 0, messageSeq: 0, turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [] },
    save: () => {}, get: () => chat, list: () => [], invocationDirectory: () => '.',
    events: () => ({ items: [], hasMore: false, next: 0 }),
    appendEvent: (c: any, e: any) => ({ ...e, seq: ++c.seq, chatId: c.id, at: '' }),
    appendMessage: (c: any, m: any) => { const item = { ...m, id: randomUUID(), seq: ++c.messageSeq, createdAt: '' }; messages.push(item); if (m.role === 'user') c.constraintMessageIds.push(item.id); return item; },
    messages: (_id: string, options: any) => ({ items: messages.filter(m => m.seq < (options.before ?? Infinity)).slice(-50) }),
    message: (_id: string, id: string) => messages.find(m => m.id === id),
    putBlob: (_id: string, name: string, value: string) => { const relativePath = `blobs/${name}`; const data = Buffer.from(value); blobs.set(relativePath, data); return { relativePath, hash: name, bytes: data.length }; },
    readBlob: (_id: string, ref: string) => blobs.get(ref),
  } as unknown as ChatStore;
  let maxBatch = 0; let maxOutstanding = 0; let runtime: ChatRuntime;
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke: async (i: DriverInput) => {
    if (role === 'grok') return result('ok');
    const children = chat.tasks.filter((t: any) => t.parentTaskId === i.task.id);
    const pending = children.filter((t: any) => t.status !== 'completed');
    maxOutstanding = Math.max(maxOutstanding, pending.length);
    if (pending.length) { await i.callTool('grok_collect', { wait: true }); return result(); }
    const unhandled = children.filter((t: any) => !t.disposition);
    if (unhandled.length) { for (const child of unhandled.slice(0, 10)) await i.callTool('grok_disposition', { taskId: child.id, disposition: 'reference' }); await i.callTool('task_yield', { next: 'continue' }); return result(); }
    if (children.length < 1000) { const n = Math.min(32, 1000 - children.length); maxBatch = Math.max(maxBatch, n); await i.callTool('grok_submit', { tasks: Array.from({ length: n }, () => ({ goal: 'inspect' })) }); await i.callTool('grok_collect', { wait: true }); return result(); }
    return result('done');
  } } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  runtime = new ChatRuntime({ store, drivers, handoffMs: 20 });
  const created = runtime.create({}); runtime.send(created.id, { text: 'inspect', clientMessageId: '1' }); await runtime.idle(55000);
  assert.equal(created.tasks.filter(t => t.role === 'grok').length, 1000, `root: ${created.tasks[0]!.status} ${created.tasks[0]!.error ?? ''}`); assert.ok(maxBatch <= 32); assert.ok(maxOutstanding <= 32); assert.equal(created.tasks[0]!.status, 'completed');
});
