import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatDriver, ChatRole, DriverInput } from '../src/chat/types.js';

test('large original requirements are read across segments before completion with every reply bounded', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chat-source-runtime-')); let calls = 0; let runtime: ChatRuntime;
  const cursors = new Map<string, number | null>();
  const invoke = async (input: DriverInput) => {
    calls++; assert.ok(input.invocation.inputEstimate <= 24_000);
    if (calls === 1) await assert.rejects(input.callTool('task_complete', { result: '未读取就完成' }));
    const listed = await input.callTool('user_source_list', { limit: 40 });
    const plan = listed.data as { sources: { id: string }[] }; assert.ok(plan.sources.length);
    let actions = calls === 1 ? 2 : 1;
    for (const source of plan.sources) {
      let offset: number | null = cursors.has(source.id) ? cursors.get(source.id)! : 0;
      while (offset !== null && actions < 10) {
        const reply = await input.callTool('user_source_read', { sourceId: source.id, offset });
        assert.ok(reply.text.length <= 4000); actions++;
        offset = (reply.data as { next: number | null }).next; cursors.set(source.id, offset);
      }
    }
    if (plan.sources.every(s => cursors.get(s.id) === null)) await input.callTool('task_complete', { result: '已完整提供原始要求，并完成核对。' });
    else await input.callTool('task_yield', { next: '继续读取尚未提供的必保原文页' });
    return { text: '', exitConfirmed: true };
  };
  const drivers = Object.fromEntries((['claude', 'astra', 'sol', 'grok'] as ChatRole[]).map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  runtime = new ChatRuntime({ store: new ChatStore(root), drivers });
  try {
    const chat = runtime.create({}); const original = '必须保留原始要求😀\n'.repeat(6000);
    runtime.send(chat.id, { text: original, clientMessageId: 'large' }); await runtime.idle(15_000);
    assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); assert.ok(calls >= 3);
    assert.equal(runtime.store.messages(chat.id, { limit: 50 }).items.find(m => m.role === 'user')!.text, original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('long host tool receipts retain a readable task-scoped reference', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chat-receipt-runtime-')); const long = '真实工具证据'.repeat(1600);
  const invoke = async (input: DriverInput) => {
    const receipt = await input.callTool('file_read', {}); assert.ok(receipt.text.length <= 4000);
    const ref = (receipt.data as { ref: string }).ref; assert.ok(ref);
    const full = await input.callTool('result_read', { ref, offset: 0 }); assert.ok(full.text.startsWith('[程序分页 offset=0 next=3900]\n')); assert.equal(full.text.split('\n').slice(1).join('\n'), long.slice(0, 3900));
    return { text: '引用可读取', exitConfirmed: true };
  };
  const drivers = Object.fromEntries((['claude', 'astra', 'sol', 'grok'] as ChatRole[]).map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  const runtime = new ChatRuntime({ store: new ChatStore(root), drivers, workspace: { definitions: [{ name: 'file_read', description: 'fixture', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }), call: async () => ({ text: long }) } });
  try { const chat = runtime.create({ workspaceId: 'fixture' }); runtime.send(chat.id, { text: '读取证据', clientMessageId: 'read' }); await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent large tool receipts get unique references and stable call identities', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chat-parallel-receipt-')); let runtime: ChatRuntime;
  const invoke = async (input: DriverInput) => {
    const replies = await Promise.all([input.callTool('file_read', { key: 'first' }), input.callTool('file_read', { key: 'second' })]);
    const refs = replies.map(reply => (reply.data as { ref: string }).ref);
    assert.notEqual(refs[0], refs[1]);
    assert.ok(runtime.store.readBlob(input.chatId, refs[0]!).toString().endsWith('first'));
    assert.ok(runtime.store.readBlob(input.chatId, refs[1]!).toString().endsWith('second'));
    return { text: '两个结果均可核对', exitConfirmed: true };
  };
  const drivers = Object.fromEntries((['claude', 'astra', 'sol', 'grok'] as ChatRole[]).map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  runtime = new ChatRuntime({ store: new ChatStore(root), drivers, workspace: { definitions: [{ name: 'file_read', description: 'fixture', inputSchema: {} }], assertWorkspace: () => ({ version: 1 }), call: async (_name, args) => { await new Promise(resolve => setTimeout(resolve, 5)); return { text: '真实长回执'.repeat(1600) + (args as { key: string }).key }; } } });
  try { const chat = runtime.create({ workspaceId: 'fixture' }); runtime.send(chat.id, { text: '并行读取', clientMessageId: 'parallel' }); await runtime.idle(); assert.equal(chat.tasks[0]!.status, 'completed', chat.tasks[0]!.error); const results = runtime.store.events(chat.id).items.filter(e => e.type === 'tool_result'); assert.equal(new Set(results.map(e => (e.data as { toolCallId: string }).toolCallId)).size, 2); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
