import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { loadRoster, freezeApiRoster } from '../src/chat/roster.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { AgentTask, Invocation } from '../src/chat/types.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider, type ProviderScript } from '../src/providers/scripted.js';

const registry = loadModelRegistry();
const roster = loadRoster('config/roster.json', registry);
const roots: string[] = [];
const now = () => new Date().toISOString();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxLoader = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const crashFixture = path.join(projectRoot, 'tests', 'fixtures', 'chat-api-recovery-crash.ts');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(input: Partial<AgentTask> & Pick<AgentTask, 'id' | 'turnId' | 'role' | 'goal' | 'status'>): AgentTask {
  return {
    createdAt: now(), updatedAt: now(), segment: 0, invocationIds: [], noProgressSegments: 0, mode: 'read',
    phase: 'architecture', ...input,
  };
}

function invocation(taskId: string): Invocation {
  return {
    id: randomUUID(), taskId, segment: 1, status: 'running', startedAt: now(), toolCount: 0,
    promptVersion: 'recovery-fixture', inputEstimate: 1, contextWindow: 1_000_000, contextUsed: 10,
  };
}

function seed(status: 'queued' | 'running', sideEffect = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-api-recovery-'));
  roots.push(root);
  const store = new ChatStore(root);
  const chat = store.create({ apiRoster: freezeApiRoster(roster, registry) });
  const turnId = randomUUID();
  const parent = task({ id: randomUUID(), turnId, role: 'claude', goal: '恢复父任务', status: 'interrupted' });
  const child = task({
    id: randomUUID(), turnId, parentTaskId: parent.id, role: 'hydrogen', goal: '恢复有界 worker',
    status, ...(status === 'running' ? { segment: 1 } : {}),
  });
  chat.tasks.push(parent, child);
  chat.turns.push({ id: turnId, rootTaskId: parent.id, status: parent.status, createdAt: now() });
  let prior: Invocation | undefined;
  if (status === 'running') {
    prior = invocation(child.id);
    child.invocationIds.push(prior.id);
    chat.invocations.push(prior);
    if (sideEffect) store.appendEvent(chat, {
      type: 'tool_started', taskId: child.id, parentTaskId: parent.id, turnId, invocationId: prior.id,
      data: { name: 'file_write', toolCallId: `${prior.id}:1` },
    });
  }
  store.save(chat);
  return { root, store, chatId: chat.id, childId: child.id, prior };
}

function runtime(root: string, script: ProviderScript, autoResume: boolean, maxTokens: number | null = null) {
  const api = createApiChatBinding(roster, registry, null, {
    offline: true,
    providerFor: model => new ScriptedProvider(script, model.protocol),
  });
  return new ChatRuntime({
    store: new ChatStore(root), drivers: {}, api, handoffMs: 5,
    apiRunSettings: {
      scheduler: { seatConcurrency: 6, fanoutMaxItemsPerCall: null, workerMaxItemsPerCall: null, parentOutstanding: null, queued: null },
      budget: { maxUsd: null, maxTokens },
      recovery: { autoResume },
    },
  });
}

const report = {
  report: {
    status: 'completed' as const,
    summary: '模拟数据：恢复后完成',
    evidenceRefs: [],
    changedFiles: [],
    deviations: [],
    concerns: [],
  },
};

test('recovery releases a reservation that never reached a provider attempt', async () => {
  const fixture = seed('running');
  const before = fixture.store.get(fixture.chatId);
  before.invocations[0]!.budgetReservation = { tokens: 80_000, usd: 1 };
  fixture.store.save(before);
  let attempts = 0;
  const recovered = runtime(fixture.root, () => {
    attempts++;
    return [
      { type: 'usage', input: 20, cachedInput: 0, output: 3 },
      { type: 'tool_call', callId: 'complete', name: 'task_complete', args: report },
      { type: 'end', reason: 'tool_calls' },
    ];
  }, true, 80_000);
  recovered.recover();
  await recovered.idle();
  const actual = recovered.get(fixture.chatId);
  assert.equal(attempts, 1);
  assert.equal(actual.tasks.find(item => item.id === fixture.childId)?.status, 'completed');
  assert.equal(actual.apiUsage?.tokens, 23);
  assert.equal(actual.apiUnresolvedUsage, undefined);
  assert.equal(actual.tickets.length, 0);
});

test('recovery reserves unresolved dispatched usage without charging it as observed usage', async () => {
  const fixture = seed('running');
  const before = fixture.store.get(fixture.chatId);
  before.invocations[0]!.budgetReservation = { tokens: 80_000, usd: 1, started: true };
  fixture.store.save(before);
  let attempts = 0;
  const recovered = runtime(fixture.root, () => {
    attempts++;
    throw new Error('requests must wait for budget approval');
  }, true, 80_000);
  recovered.recover();
  await recovered.idle();
  const actual = recovered.get(fixture.chatId);
  assert.equal(attempts, 0);
  assert.equal(actual.apiUsage, undefined);
  assert.deepEqual(actual.apiUnresolvedUsage, { tokens: 80_000, usd: 1, unpriced: 0 });
  assert.ok(actual.tickets.some(ticket => ticket.budget && ticket.status === 'pending'));
});

test('recovery continues a queued API worker that never started', async () => {
  const fixture = seed('queued');
  let calls = 0;
  const recovered = runtime(fixture.root, () => {
    calls++;
    return [
      { type: 'usage', input: 20, cachedInput: 0, output: 3 },
      { type: 'tool_call', callId: 'complete', name: 'task_complete', args: report },
      { type: 'end', reason: 'tool_calls' },
    ];
  }, false);

  recovered.recover();
  await recovered.idle();

  const child = recovered.get(fixture.chatId).tasks.find(item => item.id === fixture.childId)!;
  assert.equal(calls, 1);
  assert.equal(child.status, 'completed');
  assert.equal(child.invocationIds.length, 1);
});

test('default recovery interrupts a running API window without replaying it', async () => {
  const fixture = seed('running');
  let calls = 0;
  const recovered = runtime(fixture.root, () => {
    calls++;
    return [{ type: 'end', reason: 'stop' }];
  }, false);

  recovered.recover();
  await recovered.idle();

  const chat = recovered.get(fixture.chatId);
  const child = chat.tasks.find(item => item.id === fixture.childId)!;
  assert.equal(calls, 0);
  assert.equal(child.status, 'interrupted');
  assert.match(child.error ?? '', /等待上层决定/);
  assert.equal(chat.invocations[0]?.status, 'exited');
  assert.equal(chat.invocations[0]?.exitConfirmed, true);
});

test('auto recovery opens a new crash handoff window for a side-effect-free API task', async () => {
  const fixture = seed('running');
  let calls = 0;
  let firstPrompt = '';
  const recovered = runtime(fixture.root, ({ input }) => {
    calls++;
    firstPrompt ||= input.text ?? '';
    return [
      { type: 'usage', input: 20, cachedInput: 0, output: 3 },
      { type: 'tool_call', callId: 'complete', name: 'task_complete', args: report },
      { type: 'end', reason: 'tool_calls' },
    ];
  }, true);

  recovered.recover();
  await recovered.idle();

  const chat = recovered.get(fixture.chatId);
  const child = chat.tasks.find(item => item.id === fixture.childId)!;
  assert.equal(calls, 1);
  assert.equal(child.status, 'completed');
  assert.equal(child.invocationIds.length, 2);
  assert.equal(chat.invocations[0]?.status, 'exited');
  assert.equal(chat.invocations[0]?.exitConfirmed, true);
  assert.equal(chat.invocations[0]?.rotationReason, 'crash');
  assert.match(firstPrompt, /原因：crash/);
});

test('auto recovery never replays a window with an unfinished side-effect tool', async () => {
  const fixture = seed('running', true);
  let calls = 0;
  const recovered = runtime(fixture.root, () => {
    calls++;
    return [{ type: 'end', reason: 'stop' }];
  }, true);

  recovered.recover();
  await recovered.idle();

  const chat = recovered.get(fixture.chatId);
  const child = chat.tasks.find(item => item.id === fixture.childId)!;
  assert.equal(calls, 0);
  assert.equal(child.status, 'interrupted');
  assert.equal(child.invocationIds.length, 1);
  assert.equal(chat.invocations[0]?.status, 'exit_unknown');
});

test('auto recovery resumes from durable state after the runtime process exits mid-window', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dmw-api-process-crash-'));
  roots.push(root);
  const marker = path.join(root, 'crashed-chat.txt');
  const child = spawn(process.execPath, ['--import', pathToFileURL(tsxLoader).href, crashFixture, root, marker], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  assert.equal(exit, 73, stderr);
  assert.ok(existsSync(marker), 'crash marker must be durable before abrupt exit');
  const chatId = readFileSync(marker, 'utf8');

  let prompt = '';
  const recovered = runtime(root, ({ input }) => {
    prompt ||= input.text ?? '';
    return [
      { type: 'usage', input: 20, cachedInput: 0, output: 3 },
      { type: 'tool_call', callId: 'complete', name: 'task_complete', args: { result: '模拟数据：进程崩溃后续接' } },
      { type: 'end', reason: 'tool_calls' },
    ];
  }, true);
  recovered.recover();
  await recovered.idle();

  const chat = recovered.get(chatId);
  assert.equal(chat.tasks[0]?.status, 'completed');
  assert.equal(chat.invocations.length, 2);
  assert.equal(chat.invocations[0]?.rotationReason, 'crash');
  assert.match(prompt, /原因：crash/);
});
