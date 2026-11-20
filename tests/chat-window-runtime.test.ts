import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { loadRoster, parseRoster } from '../src/chat/roster.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { sourcePlan } from '../src/chat/source-context.js';
import { ChatStore } from '../src/chat/store.js';
import { assessWindow, contextPolicy, resolveLimits, WINDOW_REMINDER } from '../src/chat/window.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider, type ProviderScript } from '../src/providers/scripted.js';
import type { ProviderEvent } from '../src/providers/types.js';

const registry = loadModelRegistry();

function fixture(script: ProviderScript, roster = loadRoster('config/roster.json', registry)) {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-window-runtime-'));
  const store = new ChatStore(root);
  const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model => new ScriptedProvider(script, model.protocol) });
  const runtime = new ChatRuntime({ store, drivers: {}, api, handoffMs: 5 });
  return { store, runtime, close: () => rmSync(root, { recursive: true, force: true }) };
}

function tool(name: string, args: Record<string, unknown>, input = 80): ProviderEvent[] {
  return [
    { type: 'usage', input, cachedInput: 0, output: 100 },
    { type: 'tool_call', callId: name, name, args },
    { type: 'end', reason: 'tool_calls' },
  ];
}

test('default hard and physical ceilings bound every admitted projection on deterministic trajectories', () => {
  const model = registry.get('gpt-6.2-astra')!;
  const limits = resolveLimits(model, contextPolicy(undefined, 'astra', false));
  assert.deepEqual(limits, { soft: 160_000, hard: 240_000, ceiling: 783_700, initialMaxTokens: 40_000, outputReserve: 64_000 });
  let seed = 51073;
  for (let index = 0; index < 1000; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const occupied = seed % 250_000;
    const request = assessWindow(occupied, { toolResults: [{ callId: 'fixture', text: '盘点😀'.repeat(seed % 1000) }] }, limits, 1);
    if (!request.rotate) assert.ok(request.projected <= limits.hard && request.projected <= limits.ceiling);
    else assert.ok(request.projected > limits.hard);
  }
});

test('API chat warns once, sends no over-hard request and resumes with the unread receipt', async () => {
  let windows = 0;
  let firstWindowSends = 0;
  let reminders = 0;
  let transferred = '';
  let readAfterRotation = '';
  const f = fixture(({ turn, input }) => {
    if (turn === 1) windows++;
    if (windows > 1) {
      if (turn === 1) {
        transferred = input.text ?? '';
        const ref = /blobs\/api-receipt-[^"\s]+\.txt/.exec(transferred)?.[0];
        assert.ok(ref, '交接包应包含未送达的回执引用');
        return tool('result_read', { ref });
      }
      readAfterRotation = input.toolResults?.[0]?.text ?? '';
      return tool('task_complete', { result: '模拟数据：换窗后完成' });
    }
    firstWindowSends++;
    if (input.toolResults?.some(receipt => receipt.text.includes(WINDOW_REMINDER))) reminders++;
    return tool('task_state', {}, turn * 30_000 - 16_000);
  });
  try {
    const chat = f.runtime.create({});
    f.runtime.send(chat.id, { text: '完整的原始需求与约束', clientMessageId: 'window' });
    await f.runtime.idle();
    assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
    assert.deepEqual([windows, firstWindowSends, reminders], [2, 7, 1]);
    const initial = chat.invocations[0]!;
    assert.equal(initial.rotationReason, 'hard');
    assert.ok(initial.handoffRef && initial.handoffStateRef);
    const receipt = initial.toolReceiptDeliveries?.at(-1);
    assert.ok(receipt && !receipt.delivered);
    assert.ok(initial.toolReceiptDeliveries?.slice(0, -1).every(item => item.delivered));
    assert.equal(transferred, f.store.readBlob(chat.id, initial.handoffRef).toString('utf8'));
    assert.ok(readAfterRotation.includes(f.store.readBlob(chat.id, receipt.ref).toString('utf8')));
    assert.ok(Buffer.byteLength(transferred) <= 24_000);
    const handoff = f.store.readBlob(chat.id, initial.handoffStateRef).toString('utf8');
    assert.ok(handoff.includes(receipt.ref));
    for (const source of sourcePlan(chat, chat.tasks[0]!, f.store).sources) {
      assert.ok(handoff.includes(source.id) && handoff.includes(source.hash));
    }
  } finally { f.close(); }
});

test('an unsent source page grants no coverage and can be read again in the next window', async () => {
  let windows = 0;
  let sourceId = '';
  let observed = false;
  const f = fixture(({ turn, input }) => {
    if (turn === 1) {
      windows++;
      if (windows === 2) assert.equal(chat.tasks[0]?.sourceCoverage?.[sourceId]?.includes(0) ?? false, false);
      return tool('user_source_read', { sourceId, offset: 0 }, windows === 1 ? 235_000 : 100);
    }
    observed = input.toolResults?.[0]?.text.includes('必须完整核对的来源') ?? false;
    return tool('task_fail', { reason: '模拟数据：已验证原文回执重读' });
  });
  const chat = f.runtime.create({});
  try {
    f.runtime.send(chat.id, { text: '必须完整核对的来源'.repeat(1000), clientMessageId: 'unread-source' });
    sourceId = chat.constraintMessageIds[0]!;
    await f.runtime.idle();
    assert.equal(windows, 2);
    assert.ok(observed);
    assert.deepEqual(chat.tasks[0]?.sourceCoverage?.[sourceId], [0]);
    assert.equal(chat.invocations[0]?.toolReceiptDeliveries?.[0]?.delivered, undefined);
    assert.equal(chat.invocations[1]?.toolReceiptDeliveries?.[0]?.delivered, true);
  } finally { f.close(); }
});

test('a named worker fixture stops after two windows and reports its split reason to the parent', async () => {
  const roster = loadRoster('config/roster.json', registry);
  const root = roster.seats.find(seat => seat.id === roster.rootSeat)!;
  root.can.delegateSeats.push('fixture-worker');
  roster.seats.push({ id: 'fixture-worker', kind: 'worker', delegationWeight: 1, promptFile: 'worker.md', strengths: '离线窗口上限夹具',
    bindings: { default: { model: 'gpt-6-luna', effort: 'medium', delegation: 'none' } },
    can: { askUser: false, delegateSeats: [], writeMain: false, writeIsolated: false, integrate: false, acceptance: false, exec: false },
  });
  let rootStage = 'spawn';
  let childId = '';
  let childReport: { errorCode?: string } | undefined;
  const f = fixture(({ init, input }) => {
    if (init.model.id === 'gpt-6-luna') return tool('task_yield', { next: '继续下一段' });
    if (rootStage === 'spawn') {
      rootStage = 'wait';
      return tool('agent_submit', { role: 'fixture-worker', goal: '有界离线任务', mode: 'read' });
    }
    if (rootStage === 'wait') {
      childId = JSON.parse(input.toolResults![0]!.text)[0].taskId;
      rootStage = 'collect';
      return tool('task_collect', { taskIds: [childId], wait: true });
    }
    if (rootStage === 'collect') {
      if (!input.toolResults) return tool('task_collect', { taskIds: [childId], wait: true });
      childReport = JSON.parse(input.toolResults[0]!.text)[0];
      rootStage = 'complete';
      return tool('task_disposition', { taskId: childId, disposition: 'rejected' });
    }
    return tool('task_complete', { result: '模拟数据：已接收拆分请求' });
  }, parseRoster(roster, registry));
  try {
    const chat = f.runtime.create({});
    f.runtime.send(chat.id, { text: '完成一个有界任务', clientMessageId: 'worker' });
    await f.runtime.idle();
    const worker = chat.tasks.find(task => task.role === 'fixture-worker');
    assert.deepEqual([worker?.status, worker?.segment, childReport?.errorCode], ['failed', 2, 'TASK_TOO_LARGE_NEEDS_SPLIT']);
    assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
  } finally { f.close(); }
});
