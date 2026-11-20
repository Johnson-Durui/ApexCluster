import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { loadRoster } from '../src/chat/roster.js';
import { ChatRuntime, type ChatRuntimeOptions } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider, type ProviderScript, type ScriptedTurn } from '../src/providers/scripted.js';
import type { ProviderEvent } from '../src/providers/types.js';

const registry = loadModelRegistry();

function tool(name: string, args: Record<string, unknown>, input = 60): ProviderEvent[] {
  return [
    { type: 'usage', input, cachedInput: 0, output: 20 },
    { type: 'tool_call', callId: name + '-' + input, name, args },
    { type: 'end', reason: 'tool_calls' },
  ];
}

function report(index: string) {
  return {
    status: 'completed',
    summary: '模拟数据：worker ' + index + ' 完成',
    evidenceRefs: [],
    changedFiles: [],
    deviations: [],
    concerns: [],
  };
}

function parseReceipt(turn: ScriptedTurn): unknown {
  const text = turn.input.toolResults?.at(-1)?.text;
  return text === undefined ? undefined : JSON.parse(text);
}

function fixture(script: ProviderScript, options: Partial<ChatRuntimeOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-fanout-runtime-'));
  const store = new ChatStore(root);
  const roster = loadRoster('config/roster.json', registry);
  const api = createApiChatBinding(roster, registry, null, {
    offline: true,
    providerFor: model => new ScriptedProvider(script, model.protocol),
  });
  const runtime = new ChatRuntime({ store, drivers: {}, api, handoffMs: 5, ...options });
  return { root, store, runtime, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('two 1,000-item fanouts complete without loss or duplication and share 64 model slots', { timeout: 600_000 }, async () => {
  const items = Array.from({ length: 1_000 }, (_, index) => 'item-' + index);
  const rootStages = new Map<string, { stage: 'submit' | 'wait' | 'collect' | 'dispose' | 'complete'; groupId?: string }>();
  const workerOrdinals = new Map<string, number>();
  const workerStarts: string[] = [];
  const rateLimited = new Set<string>();
  let active = 0;
  let peak = 0;
  let chatA: ReturnType<ChatRuntime['create']>;
  let chatB: ReturnType<ChatRuntime['create']>;
  const collectBytes: number[] = [];

  const owner = (taskId: string) => {
    const chat = [chatA, chatB].find(item => item?.tasks.some(task => task.id === taskId));
    return chat?.id ?? 'unknown';
  };
  const script: ProviderScript = async turn => {
    if (turn.init.model.id === 'gemini-4-hydrogen') {
      let ordinal = workerOrdinals.get(turn.init.cacheKey);
      if (ordinal === undefined) {
        ordinal = workerOrdinals.size;
        workerOrdinals.set(turn.init.cacheKey, ordinal);
        workerStarts.push(owner(turn.init.cacheKey));
      }
      if (ordinal % 20 === 0 && turn.attempt === 1) {
        rateLimited.add(turn.init.cacheKey);
        throw Object.assign(new Error('simulated 429'), { status: 429, headers: { 'retry-after': '0' } });
      }
      active++;
      peak = Math.max(peak, active);
      try {
        await delay(5 + ordinal % 46, undefined, { signal: turn.signal });
        return tool('task_complete', { report: report(String(ordinal)) });
      } finally {
        active--;
      }
    }

    assert.equal(turn.init.model.id, 'claude-fable-5-2');
    const state = rootStages.get(turn.init.cacheKey) ?? { stage: 'submit' as const };
    rootStages.set(turn.init.cacheKey, state);
    if (state.stage === 'submit') {
      state.stage = 'wait';
      return tool('fanout_submit', { pool: 'hydrogen', mode: 'read', template: '处理 {{item}}（{{index}}）', items });
    }
    if (state.stage === 'wait') {
      const receipt = parseReceipt(turn) as { groupId?: string } | undefined;
      if (receipt?.groupId) state.groupId = receipt.groupId;
      assert.ok(state.groupId);
      state.stage = 'collect';
      return tool('task_collect', { groupId: state.groupId, wait: true });
    }
    if (state.stage === 'collect') {
      if (!turn.input.toolResults) return tool('task_collect', { groupId: state.groupId, wait: false });
      const text = turn.input.toolResults.at(-1)!.text;
      collectBytes.push(Buffer.byteLength(text, 'utf8'));
      const collected = JSON.parse(text) as { total: number; counts: { completed: number } };
      assert.equal(collected.total, 1_000);
      assert.equal(collected.counts.completed, 1_000);
      state.stage = 'dispose';
      return tool('task_disposition', { groupId: state.groupId, disposition: 'reference' });
    }
    if (state.stage === 'dispose') {
      state.stage = 'complete';
      return tool('task_complete', { result: '模拟数据：扇出全部收口' });
    }
    throw new Error('root was invoked after completion');
  };

  const f = fixture(script, { apiRunSettings: {
    scheduler: { seatConcurrency: 6, fanoutMaxItemsPerCall: null, workerMaxItemsPerCall: null, parentOutstanding: null, queued: null },
    budget: { maxUsd: null, maxTokens: null },
    recovery: { autoResume: false },
  } });
  try {
    chatA = f.runtime.create({ title: 'fanout-a' });
    chatB = f.runtime.create({ title: 'fanout-b' });
    f.runtime.send(chatA.id, { text: '运行第一组模拟扇出', clientMessageId: 'a' });
    f.runtime.send(chatB.id, { text: '运行第二组模拟扇出', clientMessageId: 'b' });
    await f.runtime.idle(600_000);

    for (const chat of [chatA, chatB]) {
      const workers = chat.tasks.filter(task => task.role === 'hydrogen');
      assert.equal(workers.length, 1_000);
      assert.equal(new Set(workers.map(task => task.id)).size, 1_000);
      assert.ok(workers.every(task => task.status === 'completed' && task.disposition === 'reference'));
      assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
    }
    assert.equal(workerOrdinals.size, 2_000);
    assert.equal(rateLimited.size, 100);
    assert.ok(peak <= 64, 'observed ' + peak + ' concurrent Hydrogen requests');
    const first128 = workerStarts.slice(0, 128);
    assert.ok(first128.filter(id => id === chatA.id).length >= 48);
    assert.ok(first128.filter(id => id === chatB.id).length >= 48);
    assert.ok(collectBytes.every(bytes => bytes < 12_000), 'collect bytes: ' + collectBytes.join(', '));
  } finally {
    f.close();
  }
});

test('budget exhaustion pauses before the first provider request and resumes after approval', async () => {
  let requests = 0;
  const f = fixture(() => {
    requests++;
    return tool('task_complete', { result: '模拟数据：预算放行后完成' });
  }, { apiRunSettings: {
    scheduler: { seatConcurrency: 6, fanoutMaxItemsPerCall: null, workerMaxItemsPerCall: null, parentOutstanding: null, queued: null },
    budget: { maxUsd: null, maxTokens: 1 },
    recovery: { autoResume: false },
  } });
  try {
    const chat = f.runtime.create({ title: 'budget' });
    f.runtime.send(chat.id, { text: '验证预算暂停', clientMessageId: 'budget' });
    await f.runtime.idle();
    assert.equal(requests, 0);
    const ticket = chat.tickets.find(item => item.budget && item.status === 'pending');
    assert.ok(ticket);
    assert.equal(chat.tasks[0]?.status, 'queued');

    f.runtime.answer(chat.id, { ticketId: ticket.id, text: JSON.stringify({ maxTokens: null }), clientMessageId: 'budget-approval' });
    await f.runtime.idle();
    assert.equal(requests, 1);
    assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
  } finally {
    f.close();
  }
});

test('an unavailable pool model fails its worker without dispatching another model', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-unavailable-pool-'));
  const store = new ChatStore(root);
  const roster = loadRoster('config/roster.json', registry);
  let hydrogenResolutions = 0;
  let rootStage = 0;
  let groupId = '';
  const rootProvider = new ScriptedProvider(turn => {
    rootStage++;
    if (rootStage === 1) return tool('fanout_submit', { pool: 'hydrogen', template: '{{item}}', items: ['one'] });
    if (rootStage === 2) {
      groupId = (parseReceipt(turn) as { groupId: string }).groupId;
      return tool('task_collect', { groupId, wait: false });
    }
    if (rootStage === 3) return tool('task_disposition', { groupId, disposition: 'rejected' });
    return tool('task_complete', { result: '模拟数据：不可用池已收口' });
  }, 'anthropic-messages');
  const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model => {
    if (model.id === 'gemini-4-hydrogen') {
      hydrogenResolutions++;
      throw new Error('fixture unavailable');
    }
    return rootProvider;
  } });
  const runtime = new ChatRuntime({ store, drivers: {}, api, handoffMs: 5 });
  try {
    const chat = runtime.create({});
    runtime.send(chat.id, { text: '验证不可用 worker 池', clientMessageId: 'unavailable' });
    await runtime.idle();
    const worker = chat.tasks.find(task => task.role === 'hydrogen');
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.errorCode, 'POOL_MODEL_UNAVAILABLE');
    assert.equal(worker?.disposition, 'rejected');
    assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
    assert.ok(hydrogenResolutions >= 1);
    assert.equal(worker?.invocationIds.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
