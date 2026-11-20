import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createChatHttp, NativeDirectorySelector } from '../src/chat/http.js';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { loadRoster, type ApiChatBinding } from '../src/chat/roster.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatDriver, ChatRole, DriverInput } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { createApp } from '../src/server/app.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import { makeHarness, tempDir } from './helpers.js';

async function setup(invoke: (input: DriverInput) => ReturnType<ChatDriver['invoke']> = async () => ({ text: '完成', exitConfirmed: true }), api?: ApiChatBinding) {
  const root = tempDir('dmw-chat-http-');
  const legacy = makeHarness(); const registry = new WorkspaceRegistry(path.join(root, 'work')); const picker = new NativeDirectorySelector(registry);
  const drivers = Object.fromEntries((['claude', 'astra', 'sol', 'grok'] as ChatRole[]).map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke }])) as Record<ChatRole, ChatDriver>;
  const runtime = new ChatRuntime({ store: new ChatStore(root), drivers, api, requireCostConfirmation: true, workspace: { definitions: [], assertWorkspace: (id, version) => registry.assert(id, version), call: async () => { throw new Error('unused'); } } });
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  const server = createServer((q, s) => void handler(q, s));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; legacy.config.port = port;
  const bridgeToken = randomUUID(); const token = randomUUID();
  handler = createApp({ config: legacy.config, orchestrator: legacy.orch, bus: legacy.bus, token, staticDir: path.join(root, 'static'), chatHttp: createChatHttp({ runtime, registry, picker, bridgeToken, port, dataRoot: root }) });
  const base = `http://127.0.0.1:${port}`;
  const request = (url: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', 'x-workbench-token': token, ...headers }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  return { root, registry, picker, runtime, request, bridgeToken, close: async () => { await runtime.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}
test('chat HTTP preserves CSRF, validates input and keeps messages idempotent', async () => {
  const s = await setup(); try {
    assert.equal((await s.request('/api/chats', 'POST', {}, { 'x-workbench-token': '' })).status, 403);
    assert.equal((await s.request('/api/chats', 'POST', { title: 'x', forged: true })).status, 400);
    const chat = await (await s.request('/api/chats', 'POST', {})).json() as { id: string };
    const url = `/api/chats/${chat.id}/messages`;
    assert.equal((await s.request(url, 'POST', { text: '你好', clientMessageId: 'one' })).status, 400);
    const input = { text: '你好', clientMessageId: 'one', confirmCost: true };
    assert.equal((await s.request(url, 'POST', input)).status, 202); await s.runtime.idle();
    assert.equal((await s.request(url, 'POST', input)).status, 202);
    assert.equal(s.runtime.get(chat.id).turns.length, 1);
    assert.equal((await s.request(`${url}?limit=51`)).status, 400);
    assert.equal((await s.request('/api/runs')).status, 200);
  } finally { await s.close(); }
});

test('pipeline gate HTTP reuses the shared decision contract and dispatches an exact gate id', async () => {
  const s = await setup(); try {
    const chat = s.runtime.create({});
    const calls: unknown[][] = [];
    s.runtime.decidePipelineGate = (...args) => { calls.push(args); return chat; };
    assert.equal((await s.request(`/api/chats/${chat.id}/gates/A`, 'POST', { decision: 'revise' })).status, 400);
    assert.equal((await s.request(`/api/chats/${chat.id}/gates/A`, 'POST', { decision: 'confirm', extra: true })).status, 400);
    assert.equal((await s.request(`/api/chats/${chat.id}/gates/C`, 'POST', { decision: 'confirm' })).status, 404);
    assert.equal((await s.request(`/api/chats/${chat.id}/gates/A`, 'GET')).status, 405);
    const accepted = await s.request(`/api/chats/${chat.id}/gates/A`, 'POST', { decision: 'revise', feedback: '保留离线模式' });
    assert.equal(accepted.status, 200); assert.equal(((await accepted.json()) as { id: string }).id, chat.id);
    assert.deepEqual(calls, [[chat.id, 'A', { decision: 'revise', feedback: '保留离线模式' }]]);
  } finally { await s.close(); }
});

test('chat capabilities show roster and window limits without exposing a configured key', async () => {
  const models = loadModelRegistry('config');
  const roster = loadRoster('config/roster.json', models);
  const binding = createApiChatBinding(roster, models, null, { offline: true,
    providerFor: model => new ScriptedProvider(() => { throw new Error('capabilities must not invoke models'); }, model.protocol) });
  const s = await setup(undefined, binding);
  const env = 'OPENAI_API_KEY';
  const previous = process.env[env];
  const canary = 'capability-key-canary-m8';
  try {
    process.env[env] = canary;
    const result = await s.request('/api/chat-capabilities');
    assert.equal(result.status, 200);
    const body = await result.text();
    assert.ok(!body.includes(canary));
    const value = JSON.parse(body);
    assert.equal(value.apiConfiguration.mode, 'api');
    assert.ok(value.apiConfiguration.keyReadiness.some((item: { env: string; configured: boolean }) => item.env === env && item.configured));
    assert.ok(value.apiConfiguration.modelChecks.every((item: { status: string }) => item.status === 'simulated'));
    assert.ok(value.apiConfiguration.presets[0].seats.every((seat: { model: string; effort: string; contextHard: number }) => seat.model && seat.effort && seat.contextHard > 0));
    assert.equal(value.apiConfiguration.presets[0].available, false);
    assert.match(value.apiConfiguration.presets[0].reason, /执行后端/);
  } finally {
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
    await s.close();
  }
});

test('chat upload binds one immutable file to a message and preview stays inert', async () => {
  const s = await setup(); try {
    const chat = s.runtime.create({}); const other = s.runtime.create({});
    const input = { name: '网页.html', base64: Buffer.from('<script>alert(1)</script>').toString('base64'), clientUploadId: 'u1' };
    assert.equal((await s.request(`/api/chats/${chat.id}/attachments`, 'POST', input, { 'x-workbench-token': '' })).status, 403);
    const first = await s.request(`/api/chats/${chat.id}/attachments`, 'POST', input); assert.equal(first.status, 201);
    const file = await first.json() as { id: string; hash: string };
    const repeated = await (await s.request(`/api/chats/${chat.id}/attachments`, 'POST', input)).json() as { id: string }; assert.equal(repeated.id, file.id);
    assert.equal((await s.request(`/api/chats/${other.id}/attachments/${file.id}`)).status, 404);
    const preview = await s.request(`/api/chats/${chat.id}/attachments/${file.id}?preview=1`);
    assert.match(preview.headers.get('content-type')!, /text\/plain/); assert.match(preview.headers.get('content-security-policy')!, /sandbox/); assert.match(await preview.text(), /<script>/);
    const sent = await s.request(`/api/chats/${chat.id}/messages`, 'POST', { text: '请读文件', clientMessageId: 'm1', confirmCost: true, attachmentIds: [file.id] }); assert.equal(sent.status, 202); await s.runtime.idle();
    assert.equal((await s.request(`/api/chats/${chat.id}/attachments/${file.id}`, 'DELETE', {})).status, 409);
    const snapshot = await (await s.request(`/api/chats/${chat.id}`)).json() as { messages: { attachmentIds?: string[] }[]; streams: unknown[]; recentEvents: unknown[] };
    assert.deepEqual(snapshot.messages[0]?.attachmentIds, [file.id]); assert.ok(Array.isArray(snapshot.streams)); assert.ok(snapshot.recentEvents.length);
  } finally { await s.close(); }
});
test('native directory grant cannot be fabricated by browser JSON or replayed', async () => {
  const s = await setup(); try {
    assert.equal((await s.request('/api/workspaces/select', 'POST', {})).status, 503);
    let hostRequest = ''; s.picker.setTransport(id => { hostRequest = id; });
    assert.equal((await s.request('/api/workspaces/select', 'POST', { path: s.root })).status, 400);
    const selected = await (await s.request('/api/workspaces/select', 'POST', {})).json() as { requestId: string };
    assert.equal(selected.requestId, hostRequest); assert.equal(s.registry.list().length, 0);
    const project = path.join(s.root, 'project'); mkdirSync(project);
    s.picker.completeFromHost(hostRequest, project);
    assert.throws(() => s.picker.completeFromHost(hostRequest, project));
    const response = await (await s.request(`/api/workspaces/select/${hostRequest}`)).json() as { status: string; workspace: { id: string } };
    assert.equal(response.status, 'selected');
    assert.equal((await s.request(`/api/workspaces/${response.workspace.id}`, 'DELETE', {})).status, 200);
    assert.throws(() => s.registry.assert(response.workspace.id));
  } finally { await s.close(); }
});
test('internal MCP identity is scoped to a currently active invocation and rejects browser token', async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const s = await setup(async () => { await gate; return { text: 'ok', exitConfirmed: true }; });
  try {
    const chat = s.runtime.create({}); s.runtime.send(chat.id, { text: 'one', clientMessageId: 'one', confirmCost: true });
    await new Promise(resolve => setTimeout(resolve, 20)); const invocation = chat.invocations[0]!;
    const url = `/internal/chat-tools/${chat.id}/${invocation.id}`; const args = { name: 'grok_collect', arguments: {} };
    assert.equal((await s.request(url, 'POST', args)).status, 403);
    assert.equal((await s.request(url, 'POST', args, { authorization: `Bearer ${s.bridgeToken}` })).status, 403);
    const token = createHmac('sha256', s.bridgeToken).update(`${chat.id}\n${invocation.id}`).digest('hex');
    const planHeaders = { authorization: `Bearer ${token}` };
    const created = await s.request(url, 'POST', { name: 'plan_update', arguments: { revision: 0, steps: [{ id: 'prepare', text: 'private plan text', status: 'pending', verification: { kind: 'tool', toolName: 'file_read' } }, { id: 'finish', text: 'private finish text', status: 'pending', dependsOn: ['prepare'], verification: { kind: 'tool', toolName: 'file_write' } }] } }, planHeaders);
    assert.equal(created.status, 200);
    const dependency = await s.request(url, 'POST', { name: 'plan_update', arguments: { revision: 1, steps: [{ id: 'finish', text: 'CANARY private path', status: 'in_progress', dependsOn: ['prepare'] }] } }, planHeaders);
    assert.equal(dependency.status, 409); assert.deepEqual(await dependency.json(), { planError: { code: 'PLAN_DEPENDENCY_INCOMPLETE', details: { stepId: 'finish', requestedStatus: 'in_progress', incompleteDependencies: [{ stepId: 'prepare', status: 'pending' }] } } });
    const incomplete = await s.request(url, 'POST', { name: 'task_complete', arguments: { result: 'not complete' } }, planHeaders);
    assert.equal(incomplete.status, 409); assert.deepEqual(await incomplete.json(), { planError: { code: 'PLAN_INCOMPLETE', details: { steps: [{ stepId: 'prepare', status: 'pending' }, { stepId: 'finish', status: 'pending' }] } } });
    assert.equal((await s.request(url, 'POST', args, { authorization: `Bearer ${token}` })).status, 200);
    assert.equal((await s.request(url, 'POST', args, { authorization: `Bearer ${token}`, origin: 'http://evil.test' })).status, 403);
    s.runtime.cancel(chat.id); finish(); await s.runtime.idle();
    assert.equal((await s.request(url, 'POST', args, { authorization: `Bearer ${token}` })).status, 409);
  } finally { finish(); await s.close(); }
});
test('chat SSE on an idle chat opens at once instead of waiting for the first event or ping', async () => {
  const s = await setup(); try {
    const chat = s.runtime.create({});
    const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2_000));
    const response = await Promise.race([s.request(`/api/chats/${chat.id}/events?since=${chat.seq}`), timeout]);
    assert.notEqual(response, 'timeout', 'the stream headers must arrive without a pending event');
    if (response === 'timeout') return;
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await Promise.race([reader.read(), timeout]);
    assert.notEqual(first, 'timeout', 'the stream must send its opening comment at once');
    if (first !== 'timeout') assert.ok(new TextDecoder().decode(first.value).startsWith(':'));
    await reader.cancel();
  } finally { await s.close(); }
});
test('chat SSE replay is bounded at 500 and announces further pages', async () => {
  const s = await setup(); try {
    const chat = s.runtime.create({}); for (let n = 0; n < 501; n++) s.runtime.store.appendEvent(chat, { type: 'state', data: { n } }); s.runtime.store.save(chat);
    const response = await s.request(`/api/chats/${chat.id}/events?since=0`); const text = await response.text();
    assert.equal((text.match(/event: chat_event/g) ?? []).length, 500); assert.ok(text.includes('event: chat_more')); assert.ok(text.includes('"since":500'));
  } finally { await s.close(); }
});

