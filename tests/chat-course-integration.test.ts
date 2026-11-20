import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatCapabilityHost } from '../src/chat/capability-contract.js';
import type { ChatDriver, ChatRole, DriverInput } from '../src/chat/types.js';

const roles: ChatRole[] = ['claude','astra','sol','grok'];
function fixture(invoke: (input: DriverInput) => Promise<{ text: string; exitConfirmed: boolean }>, capabilities?: ChatCapabilityHost) {
  const root = mkdtempSync(path.join(tmpdir(), 'course-integration-')); const store = new ChatStore(root);
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke }])) as Record<ChatRole, ChatDriver>;
  const runtime = new ChatRuntime({ store, drivers, capabilities });
  return { runtime, store, root, close: () => rmSync(root, { recursive: true, force: true }) };
}
const host = (call: ChatCapabilityHost['call']): ChatCapabilityHost => ({ definitions: () => [{ name: 'document_test', description: '确定性测试工具', inputSchema: { type: 'object' } }], status: async () => [], call });
test('attachment → source read → file candidate → verified plan → durable delivery', async () => {
  let fileId = ''; const f = fixture(async input => {
    assert.match(input.systemPrompt, /资料.txt/);
    const read = JSON.parse((await input.callTool('session_file_read', { fileId })).text); assert.equal(read.text, '源数据 123');
    await input.callTool('plan_update', { revision: 0, steps: [{ id: 'deliver', text: '交付文档', status: 'in_progress', verification: { kind:'artifact', name:'结果.md' } }] });
    await assert.rejects(input.callTool('task_complete', { result: '尚未生成' }), /计划步骤/);
    const generated = await input.callTool('document_test', {});
    const files = (generated.data as { files: { id: string }[] }).files;
    await input.callTool('plan_update', { revision: 1, steps: [{ id: 'deliver', text: '交付文档', status: 'completed', evidenceRefs: [files[0]!.id] }] });
    await input.callTool('task_complete', { result: '已生成真实文件' }); return { text: '', exitConfirmed: true };
  }, host(async () => ({ text: '候选', files: [{ name: '结果.md', bytes: Buffer.from('最终 123') }] })));
  try {
    const chat = f.runtime.create({}); const file = f.runtime.upload(chat.id, { name: '资料.txt', base64: Buffer.from('源数据 123').toString('base64'), clientUploadId: 'u1' }); fileId = file.id;
    f.runtime.send(chat.id, { text: '根据附件生成文档', clientMessageId: 'm1', attachmentIds: [file.id] }); await f.runtime.idle();
    assert.equal(chat.tasks[0]!.status, 'completed'); assert.equal(chat.artifacts.length, 1);
    const restored = new ChatStore(f.root).get(chat.id); assert.equal(restored.todos?.[0]?.status, 'completed');
    assert.equal(f.runtime.files.read(restored, restored.artifacts[0]!.fileId!).bytes.toString(), '最终 123');
    assert.equal(restored.invocations[0]?.capabilitySnapshot?.length, 64);
  } finally { f.close(); }
});
test('partial streams survive snapshot and process restart without being joined across agents', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(async input => { input.onText('第一段'); input.onText('，正在执行'); started(); await gate; return { text: '最终回答', exitConfirmed: true }; });
  try {
    const chat = f.runtime.create({}); f.runtime.send(chat.id, { text: '流式任务', clientMessageId: 'm' }); await ready;
    assert.equal(f.runtime.streams(chat.id)[0]?.text, '第一段，正在执行');
    assert.equal(new ChatStore(f.root).readStream(chat.id, chat.invocations[0]!.id), '第一段，正在执行');
    release(); await f.runtime.idle(); assert.deepEqual(f.runtime.streams(chat.id), []);
    assert.equal(f.store.messages(chat.id).items.at(-1)?.text, '最终回答');
  } finally { release(); await f.runtime.idle(); f.close(); }
});
test('cancelled capability cannot publish late binary candidates', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(async input => { try { await input.callTool('document_test', {}); } catch { /* driver acknowledges tool cancellation */ } return { text: 'late', exitConfirmed: true }; }, host(async () => { started(); await gate; return { text: 'late', files: [{ name: 'late.txt', bytes: Buffer.from('late') }] }; }));
  try {
    const chat = f.runtime.create({}); f.runtime.send(chat.id, { text: '转换', clientMessageId: 'm' }); await ready; f.runtime.cancel(chat.id); release(); await f.runtime.idle();
    assert.equal(chat.tasks[0]?.status, 'cancelled'); assert.equal(chat.artifacts.length, 0); assert.equal(chat.attachments?.length ?? 0, 0);
  } finally { release(); await f.runtime.idle(); f.close(); }
});
test('unknown MCP process exit blocks all further dispatch even if model exits safely', async () => {
  const f = fixture(async input => { try { await input.callTool('document_test', {}); } catch { /* remote process still unknown */ } return { text: 'cannot finish', exitConfirmed: true }; }, host(async () => { throw Object.assign(new Error('unknown'), { exitConfirmed: false }); }));
  try {
    const chat = f.runtime.create({}); f.runtime.send(chat.id, { text: '扩展', clientMessageId: 'm' }); await f.runtime.idle();
    assert.equal(chat.tasks[0]?.status, 'interrupted'); assert.equal(chat.unsafeProcesses?.[0]?.kind, 'capability'); assert.ok(chat.blockedReason);
    assert.throws(() => f.runtime.send(chat.id, { text: '继续', clientMessageId: 'm2' }), /未知/);
  } finally { f.close(); }
});
test('model cannot finish while a concurrent tool is pending', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async input => {
    const running = input.callTool('document_test', {});
    await assert.rejects(input.callTool('task_complete', { result: 'too early' }), /仍有工具/);
    release(); await running; return { text: 'done', exitConfirmed: true };
  }, host(async () => { await gate; return { text: 'done' }; }));
  try { const chat = f.runtime.create({}); f.runtime.send(chat.id, { text: '并行工具', clientMessageId: 'm' }); await f.runtime.idle(); assert.equal(chat.tasks[0]?.status, 'completed'); } finally { release(); await f.runtime.idle(); f.close(); }
});

test('durable send intent repairs missing task/binding exactly once after restart', async () => {
  let invocations = 0; const f = fixture(async () => { invocations++; return { text:'recovered',exitConfirmed:true }; });
  try {
    const chat = f.store.create(); const file = f.runtime.files.upload(chat,{name:'intent.txt',base64:'eA==',clientUploadId:'u'});
    f.store.appendMessage(chat,{role:'user',text:'never started',turnId:'turn-intent',clientMessageId:'m',accepted:true,attachmentIds:[file.id]});
    f.runtime.recover(); await f.runtime.idle();
    const recovered = f.runtime.get(chat.id); assert.equal(recovered.tasks.length,1); assert.equal(recovered.turns.length,1); assert.equal(recovered.tasks[0]?.status,'completed');
    assert.ok(recovered.attachments?.[0]?.messageIds?.length); assert.equal(invocations,1);
    f.runtime.send(chat.id,{text:'never started',clientMessageId:'m',attachmentIds:[file.id]}); await f.runtime.idle(); assert.equal(invocations,1);
  } finally { f.close(); }
});
test('same message retry repairs an already logged legacy orphan without a new message', async () => {
  const f = fixture(async () => ({ text:'fixed',exitConfirmed:true })); try {
    const chat = f.runtime.create({}); f.store.appendMessage(chat,{role:'user',text:'logged',turnId:'orphan',clientMessageId:'m'});
    f.runtime.send(chat.id,{text:'logged',clientMessageId:'m'}); await f.runtime.idle(); assert.equal(chat.tasks[0]?.status,'completed'); assert.equal(f.store.messages(chat.id).items.filter(message=>message.role==='user').length,1);
  } finally { f.close(); }
});
test('an asynchronous unawaited tool rejection cannot become a completed task', async () => {
  const f = fixture(async input => { void input.callTool('document_test',{}).catch(()=>undefined); return {text:'premature',exitConfirmed:true}; },host(async()=>{ await new Promise(resolve=>setTimeout(resolve,20)); throw new Error('tool failed'); }));
  try { const chat=f.runtime.create({});f.runtime.send(chat.id,{text:'fail',clientMessageId:'m'});await f.runtime.idle();assert.equal(chat.tasks[0]?.status,'failed');assert.match(chat.tasks[0]!.error!,/工具/);assert.equal(f.store.messages(chat.id).items.filter(message=>message.role==='assistant').length,0); } finally {f.close();}
});
