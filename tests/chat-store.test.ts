import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../src/chat/store.js';

test('ChatStore persists messages, events, blobs and paginates', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-')); const s = new ChatStore(dir); const c = s.create({ title: 't' });
  for (let i=0;i<500;i++) s.appendMessage(c,{role:'user',text:`m${i}`});
  assert.equal(s.messages(c.id,{limit:50}).items.length,50); assert.equal(s.message(c.id,s.messages(c.id,{limit:1}).items[0]!.id).text,'m499');
  for(let i=0;i<100000;i++) s.appendEvent(c,{type:'tick',data:{i}});
  const index = JSON.parse(readFileSync(path.join(dir, 'chats', c.id, 'events', 'index.json'), 'utf8')) as Array<{ count: number; bytes: number }>;
  assert.equal(index.length, 10); assert.ok(index.every(x => x.count === 10000 && x.bytes <= 8 * 1024 * 1024));
  let seen=0,last=0; for(let since=0;;){ const page=s.events(c.id,since,500); for(const e of page.items){ assert.equal(e.seq,last+1); last=e.seq; seen++; } if(!page.hasMore) break; since=page.next; }
  assert.equal(seen,100000); assert.equal(last,100000);
  const b=s.putBlob(c.id,'report.txt','hello'); assert.equal(s.readBlob(c.id,b.relativePath).toString(),'hello');
});

test('cold start reconciles unsnapshotted event sequence without duplicates', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-cold-')); const s = new ChatStore(dir); const c = s.create();
  s.appendEvent(c, { type: 'tick', data: 1 }); s.appendEvent(c, { type: 'tick', data: 2 });
  const restarted = new ChatStore(dir); const loaded = restarted.get(c.id); restarted.appendEvent(loaded, { type: 'tick', data: 3 });
  assert.deepEqual(restarted.events(c.id).items.map(e => e.seq), [1, 2, 3]);
});

test('damaged event index is recovered from durable segments', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-index-')); const s = new ChatStore(dir); const c = s.create();
  s.appendEvent(c, { type: 'tick', data: 'one' }); s.appendEvent(c, { type: 'tick', data: 'two' });
  writeFileSync(path.join(dir, 'chats', c.id, 'events', 'index.json'), '{');
  const restarted = new ChatStore(dir); assert.deepEqual(restarted.events(c.id).items.map(e => e.seq), [1, 2]);
  unlinkSync(path.join(dir, 'chats', c.id, 'events', 'index.json')); assert.deepEqual(new ChatStore(dir).events(c.id).items.map(e => e.seq), [1, 2]);
});

test('unindexed complete event after interrupted index write is recovered', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-index-')); const s = new ChatStore(dir); const c = s.create();
  s.appendEvent(c, { type: 'tick', data: 1 });
  const dirEvents = path.join(dir, 'chats', c.id, 'events'); const index = JSON.parse(readFileSync(path.join(dirEvents, 'index.json'), 'utf8'));
  appendFileSync(path.join(dirEvents, index[0].file), JSON.stringify({ seq: 2, chatId: c.id, at: new Date().toISOString(), type: 'tick', data: 2 }) + '\n');
  const restarted = new ChatStore(dir); assert.deepEqual(restarted.events(c.id).items.map(e => e.seq), [1, 2]);
  assert.equal(restarted.get(c.id).seq, 2);
});

test('message pagination traverses all 500 messages without gaps after restart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-messages-')); const s = new ChatStore(dir); const c = s.create();
  for (let i = 0; i < 500; i++) s.appendMessage(c, { role: 'user', text: `m${i}` });
  const restarted = new ChatStore(dir); const found: number[] = []; let before: number | undefined;
  do { const page = restarted.messages(c.id, { before, limit: 50 }); found.unshift(...page.items.map(m => m.seq)); before = page.nextBefore; } while (before);
  assert.deepEqual(found, Array.from({ length: 500 }, (_, i) => i + 1));
});

test('large events create byte-bounded segments and paginate in sequence', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-bytes-')); const s = new ChatStore(dir); const c = s.create();
  for (let i = 0; i < 10; i++) s.appendEvent(c, { type: 'large', data: 'x'.repeat(1024 * 1024) });
  const index = JSON.parse(readFileSync(path.join(dir, 'chats', c.id, 'events', 'index.json'), 'utf8'));
  assert.ok(index.length >= 2); assert.ok(index.every((segment: { bytes: number }) => segment.bytes <= 8 * 1024 * 1024)); const first = s.events(c.id, 0, 5); const second = s.events(c.id, first.next, 5);
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, false); assert.deepEqual([...first.items, ...second.items].map(e => e.seq), Array.from({ length: 10 }, (_, i) => i + 1));
});

test('partial event and message tails fail closed on restart', () => {
  for (const kind of ['events', 'messages'] as const) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-partial-')); const s = new ChatStore(dir); const c = s.create();
    if (kind === 'events') s.appendEvent(c, { type: 'tick', data: 1 }); else s.appendMessage(c, { role: 'user', text: 'one' });
    const file = path.join(dir, 'chats', c.id, kind, `${kind}-000001.jsonl`); appendFileSync(file, '{"seq":');
    assert.throws(() => new ChatStore(dir).get(c.id), /不完整/);
  }
});

test('message log ahead of snapshot restores sequence and user constraints', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-message-recovery-')); const s = new ChatStore(dir); const c = s.create();
  s.appendMessage(c, { role: 'user', text: 'one' });
  const id = 'recovered-message'; appendFileSync(path.join(dir, 'chats', c.id, 'messages', 'messages-000001.jsonl'), JSON.stringify({ id, seq: 2, role: 'user', text: 'two', createdAt: new Date().toISOString() }) + '\n');
  const restarted = new ChatStore(dir); const recovered = restarted.get(c.id); assert.equal(recovered.messageSeq, 2); assert.ok(recovered.constraintMessageIds.includes(id));
  restarted.appendMessage(recovered, { role: 'user', text: 'three' }); assert.deepEqual(restarted.messages(c.id).items.map(m => m.seq), [1, 2, 3]);
});

test('equal-length event sequence tampering fails closed when read', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-tamper-')); const s = new ChatStore(dir); const c = s.create(); s.appendEvent(c, { type: 'tick', data: 1 });
  const file = path.join(dir, 'chats', c.id, 'events', 'events-000001.jsonl'); const original = readFileSync(file, 'utf8'); const altered = original.replace('"seq":1', '"seq":9'); assert.equal(altered.length, original.length); assert.notEqual(altered, original); writeFileSync(file, altered);
  assert.throws(() => s.events(c.id), /序号或身份不一致/);
});

test('missing or truncated indexed segment is not silently discarded', () => {
  for (const damage of ['missing', 'truncated']) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-loss-')); const s = new ChatStore(dir); const c = s.create(); s.appendEvent(c, { type: 'tick', data: 1 });
    const file = path.join(dir, 'chats', c.id, 'events', 'events-000001.jsonl');
    if (damage === 'missing') unlinkSync(file); else writeFileSync(file, '');
    assert.throws(() => new ChatStore(dir).events(c.id), /缺失或截断/);
  }
});

const apiRoster = { version: 1, roster: {}, modelHashes: {}, registryHash: 'test' } as never;
const task = (id: string) => ({
  id, turnId: 'turn', role: 'worker', goal: `goal-${id}`, status: 'queued' as const,
  createdAt: '', updatedAt: '', segment: 0, invocationIds: [], noProgressSegments: 0, mode: 'read' as const,
});

test('API state journal replays keyed task updates and recovers an incomplete final append', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-state-')); const store = new ChatStore(dir); const chat = store.create({ apiRoster });
  chat.tasks.push(task('a'), task('b')); store.save(chat);
  chat.tasks[0]!.status = 'completed'; chat.tasks[0]!.result = 'done'; chat.tasks.splice(1, 1); store.save(chat);
  const journal = path.join(dir, 'chats', chat.id, 'state.jsonl');
  appendFileSync(journal, '{"version":1');
  const recovered = new ChatStore(dir).get(chat.id);
  assert.deepEqual(recovered.tasks.map(item => [item.id, item.status, item.result]), [['a', 'completed', 'done']]);
  assert.ok(readFileSync(journal, 'utf8').endsWith('\n'));
});

test('API state journal fails closed when a committed entry changes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-state-tamper-')); const store = new ChatStore(dir); const chat = store.create({ apiRoster });
  chat.tasks.push(task('a')); store.save(chat);
  const journal = path.join(dir, 'chats', chat.id, 'state.jsonl');
  const original = readFileSync(journal, 'utf8'); const altered = original.replace('goal-a', 'goal-z');
  assert.equal(altered.length, original.length); writeFileSync(journal, altered);
  assert.throws(() => new ChatStore(dir).get(chat.id), /状态增量序号或哈希不一致/);
});

test('API journal persists 2,000 task updates without rewriting the base snapshot', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-state-scale-')); const store = new ChatStore(dir); const chat = store.create({ apiRoster });
  const snapshot = path.join(dir, 'chats', chat.id, 'chat.json'); const initialBytes = statSync(snapshot).size;
  const started = performance.now();
  for (let index = 0; index < 2_000; index++) chat.tasks.push(task(`task-${index}`));
  store.save(chat);
  for (let offset = 0; offset < chat.tasks.length; offset += 64) {
    for (const item of chat.tasks.slice(offset, offset + 64)) item.status = 'completed';
    store.save(chat);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(statSync(snapshot).size, initialBytes);
  const restored = new ChatStore(dir).get(chat.id);
  assert.equal(restored.tasks.length, 2_000);
  assert.deepEqual(restored.tasks.slice(0, 2).map(item => [item.id, item.status]), [['task-0', 'completed'], ['task-1', 'completed']]);
  assert.ok(elapsedMs < 10_000, `2,000 durable task transitions took ${elapsedMs.toFixed(0)}ms`);
});

test('API commitEvent restores bulk enqueue state after write-ahead interruption', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-event-wal-')); let interrupted = true;
  const store = new ChatStore(dir, { afterWriteAhead: () => { if (interrupted) throw new Error('injected interruption'); } });
  const chat = store.create({ apiRoster }); chat.tasks.push(...Array.from({ length: 40 }, (_, index) => task(`bulk-${index}`)));
  assert.throws(() => store.commitEvent(chat, { type: 'fanout_enqueued', data: { count: 40 } }), /injected interruption/);
  interrupted = false;
  const recoveredStore = new ChatStore(dir); const recovered = recoveredStore.get(chat.id);
  assert.equal(recovered.tasks.length, 40); assert.equal(recovered.seq, 1);
  assert.deepEqual(recoveredStore.events(chat.id).items.map(event => [event.seq, event.type, event.data]), [[1, 'fanout_enqueued', { count: 40 }]]);
});

test('API write-ahead recovery keeps tool_started and tool_result receipt state consistent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-receipt-wal-')); let writes = 0;
  const store = new ChatStore(dir, { afterWriteAhead: () => { if (++writes === 2) throw new Error('injected result interruption'); } });
  const chat = store.create({ apiRoster });
  store.commitEvent(chat, { type: 'tool_started', taskId: 'root', invocationId: 'inv', data: { name: 'worker_submit', toolCallId: 'inv:1' } });
  chat.toolResults = [{ taskId: 'root', invocationId: 'inv', name: 'worker_submit', toolNumber: 1, provenance: 'tool',
    ref: 'blobs/receipt.txt', hash: 'a'.repeat(64), bytes: 7 }];
  assert.throws(() => store.commitEvent(chat, { type: 'tool_result', taskId: 'root', invocationId: 'inv',
    data: { name: 'worker_submit', toolCallId: 'inv:1', text: 'queued' } }), /injected result interruption/);
  const recoveredStore = new ChatStore(dir); const recovered = recoveredStore.get(chat.id);
  assert.equal(recovered.toolResults?.[0]?.ref, 'blobs/receipt.txt');
  assert.deepEqual(recoveredStore.events(chat.id).items.map(event => [event.seq, event.type]), [[1, 'tool_started'], [2, 'tool_result']]);
});

test('API cold recovery rejects a non-stream event without a state commit', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-event-divergence-')); const store = new ChatStore(dir); const chat = store.create({ apiRoster });
  store.appendEvent(chat, { type: 'task_updated', data: { id: 'orphan' } });
  assert.throws(() => new ChatStore(dir).get(chat.id), /没有对应状态提交/);
});

test('API commitEvent rejects oversized input before the write-ahead record', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-event-oversized-')); const store = new ChatStore(dir); const chat = store.create({ apiRoster });
  assert.throws(() => store.commitEvent(chat, { type: 'task_updated', data: { text: 'x'.repeat(8 * 1024 * 1024) } }), /超过分段容量/);
  assert.equal(chat.seq, 0);
  assert.equal(new ChatStore(dir).get(chat.id).seq, 0);
  assert.deepEqual(new ChatStore(dir).events(chat.id).items, []);
});
