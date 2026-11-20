import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatRuntime, type WorkspaceToolHost } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatDriver, ChatRole, DriverInput, DriverResult } from '../src/chat/types.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate: () => boolean) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } }
function make(invoke: (role: ChatRole, input: DriverInput) => Promise<DriverResult>, workspace: WorkspaceToolHost) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chat-security-'));
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke: (input: DriverInput) => invoke(role, input) } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  return { runtime: new ChatRuntime({ store: new ChatStore(root), drivers, workspace, handoffMs: 20 }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('unknown model exit blocks queued children before asynchronous cleanup finishes', async () => {
  const roots = deferred(); const finish = deferred(); const cleanup = deferred(); let rootCount = 0; let childStarted = false; let cleanupStarted = false;
  const host: WorkspaceToolHost = { definitions: [], assertWorkspace: () => ({ version: 1 }), call: async () => ({ text: '' }), afterInvocation: async identity => { if (identity.task.goal === 'first') { cleanupStarted = true; await cleanup.promise; } return []; } };
  const { runtime, cleanup: remove } = make(async (role, i) => {
    if (role === 'astra') { childStarted = true; return { text: 'child', exitConfirmed: true }; }
    rootCount++; if (rootCount === 3) roots.resolve(); await roots.promise;
    if (i.task.goal === 'first') { await i.callTool('agent_submit', { role: 'astra', goal: 'child' }); return { text: '', exitConfirmed: false }; }
    await finish.promise; return { text: 'done', exitConfirmed: true };
  }, host);
  try {
    const first = runtime.create({}); const second = runtime.create({}); const third = runtime.create({});
    runtime.send(first.id, { text: 'first', clientMessageId: '1' }); runtime.send(second.id, { text: 'second', clientMessageId: '2' }); runtime.send(third.id, { text: 'third', clientMessageId: '3' });
    await until(() => cleanupStarted); await new Promise(r => setTimeout(r, 50)); assert.equal(childStarted, false); assert.ok(first.blockedReason);
  } finally { cleanup.resolve(); finish.resolve(); await runtime.idle(); remove(); }
});

test('unknown runner exit blocks continuation after test result', async () => {
  let calls = 0; const host: WorkspaceToolHost = { definitions: [{ name: 'test_submit', description: 'test', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }), call: async () => ({ text: 'queued', stop: 'wait', ticketId: 'test-1' }), afterInvocation: async () => [{ ticketId: 'test-1', reply: { text: JSON.stringify({ ok: false, result: { terminationWarning: 'tree unknown' } }), data: { ok: false, result: { terminationWarning: 'tree unknown' } } } }] };
  const { runtime, cleanup } = make(async (_role, i) => { calls++; if (calls === 1) await i.callTool('test_submit', {}); return { text: 'continued', exitConfirmed: true }; }, host);
  try { const chat = runtime.create({ workspaceId: 'w' }); runtime.send(chat.id, { text: 'test', clientMessageId: '1' }); await runtime.idle(); assert.ok(chat.blockedReason); assert.equal(calls, 1); } finally { cleanup(); }
});

test('recovery blocks a pending test runner whose exit was not persisted', () => {
  const host: WorkspaceToolHost = { definitions: [], assertWorkspace: () => ({ version: 1 }), call: async () => ({ text: '' }) };
  const { runtime, cleanup } = make(async () => ({ text: '', exitConfirmed: true }), host);
  try {
    const chat = runtime.create({ workspaceId: 'w' });
    chat.tasks.push({ id: 'task', turnId: 'turn', role: 'sol', goal: 'test', status: 'waiting_children', createdAt: '', updatedAt: '', segment: 1, invocationIds: ['inv'], noProgressSegments: 0, mode: 'edit', workspaceId: 'w', workspaceVersion: 1 });
    chat.turns.push({ id: 'turn', rootTaskId: 'task', status: 'waiting_children', createdAt: '' });
    chat.invocations.push({ id: 'inv', taskId: 'task', segment: 1, status: 'exited', startedAt: '', endedAt: '', exitConfirmed: true, toolCount: 1, promptVersion: 'test', inputEstimate: 0, contextWindow: null, contextUsed: null });
    chat.tickets.push({ id: 'ticket', taskId: 'task', invocationId: 'inv', type: 'tool', externalId: 'test-1', status: 'pending', createdAt: '' }); runtime.store.save(chat);
    const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke: async () => ({ text: '', exitConfirmed: true }) } satisfies ChatDriver])) as unknown as Record<ChatRole, ChatDriver>;
    const restarted = new ChatRuntime({ store: runtime.store, drivers, workspace: host }); restarted.recover(); const recovered = restarted.get(chat.id);
    assert.ok(recovered.blockedReason); assert.equal(recovered.tasks[0]!.status, 'interrupted');
  } finally { cleanup(); }
});

test('planned model release does not cancel the subsequent test and duplicate receipts do not wake twice', async () => {
  let calls = 0; let hooks = 0; let released = false;
  const host: WorkspaceToolHost = {
    definitions: [{ name: 'test_wait', description: 'fake lifecycle fixture', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }),
    call: async () => ({ text: 'registered', stop: 'wait', ticketId: 'release-test' }),
    afterInvocation: async identity => {
      hooks++; assert.equal(identity.signal.aborted, false);
      return [{ ticketId: 'release-test', reply: { text: '{"ok":true,"result":{"exitCode":0}}', data: { ok: true, result: { exitCode: 0 } }, processExitConfirmed: true } }];
    },
  };
  const { runtime, cleanup } = make(async (_role, input) => {
    if (++calls === 1) { await input.callTool('test_wait', {}); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { released = true; resolve(); }, { once: true })); }
    return { text: 'done', exitConfirmed: true };
  }, host);
  try { const chat = runtime.create({ workspaceId: 'w' }); runtime.send(chat.id, { text: 'wait', clientMessageId: '1' }); await runtime.idle(); assert.equal(released, true); assert.equal(calls, 2); assert.equal(hooks, 2); assert.equal(chat.tasks[0]!.status, 'completed'); assert.equal(chat.artifacts.filter(a => a.provenance === 'runner').length, 1); }
  finally { cleanup(); }
});

test('new report ids from an unchanged failing test do not bypass the no-progress limit', async () => {
  let calls = 0; let ticket = '';
  const host: WorkspaceToolHost = {
    definitions: [{ name: 'test_wait', description: 'fake progress fixture', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }),
    call: async () => { ticket = `test-${calls}`; return { text: 'registered', stop: 'wait', ticketId: ticket }; },
    afterInvocation: async () => [{ ticketId: ticket, reply: { text: JSON.stringify({ ok: false, snapshotId: `different-${calls}`, result: { exitCode: 1 } }), data: { ok: false, progressFingerprint: 'a'.repeat(64), result: { exitCode: 1 } }, processExitConfirmed: true } }],
  };
  const { runtime, cleanup } = make(async (_role, input) => { calls++; await input.callTool('test_wait', {}); return { text: '', exitConfirmed: true }; }, host);
  try { const chat = runtime.create({ workspaceId: 'w' }); runtime.send(chat.id, { text: 'same failure', clientMessageId: 'same' }); await runtime.idle(); assert.equal(calls, 4); assert.equal(chat.tasks[0]!.status, 'failed'); assert.match(chat.tasks[0]!.error!, /三段/); assert.equal(chat.artifacts.filter(a => a.provenance === 'runner').length, 4); }
  finally { cleanup(); }
});
