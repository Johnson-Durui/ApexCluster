import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from '../src/chat/store.js';
import { buildContext } from '../src/chat/context.js';
import { readSource, sourceCoverageIssues, sourcePlan, SOURCE_PAGE_CHARS } from '../src/chat/source-context.js';
import type { AgentTask } from '../src/chat/types.js';

const task = (id: string, goal: string): AgentTask => ({ id, turnId: 'turn', role: 'claude', goal, status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' });

test('100k Chinese user source and long goal are bounded, discoverable and reconstructible', () => {
  const store = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'source-'))); const chat = store.create();
  const text = 'x' + '深海探索😊'.repeat(17000); const message = store.appendMessage(chat, { role: 'user', text }); const current = task('mine', '任务要求'.repeat(12000)); chat.tasks.push(current);
  const plan = sourcePlan(chat, current, store); assert.equal(plan.inline, false); assert.equal(plan.sources.length, 2); assert.equal(plan.sources[0]!.hash, createHash('sha256').update(text).digest('hex'));
  assert.equal(readSource(chat, current, store, { sourceId: message.id, offset: 0 }).next, 3599);
  const context = buildContext(chat, current, store); assert.ok(context.inputEstimate <= 24_000); assert.match(context.systemPrompt, /必保原文未内联/); assert.match(context.systemPrompt, new RegExp(message.id)); assert.match(context.systemPrompt, /goal:mine/);
  assert.ok(sourceCoverageIssues(chat, current, store).length > 0);
  const covered: Record<string, number[]> = {};
  for (const source of plan.sources) {
    let output = ''; let offset: number | null = 0; covered[source.id] = [];
    while (offset !== null) { const start: number = offset; const page = readSource(chat, current, store, { sourceId: source.id, offset: start }); assert.ok(page.text.length <= SOURCE_PAGE_CHARS); assert.equal(Buffer.from(page.text, 'utf8').toString('utf8'), page.text); assert.equal(page.sourceHash, source.hash); output += page.text; covered[source.id]!.push(start); offset = page.next; }
    assert.equal(output, source.kind === 'message' ? text : current.goal);
  }
  const tracked = current as AgentTask & { sourceCoverage: Record<string, number[]>; sourceCoverageHashes: Record<string, string> }; tracked.sourceCoverage = covered;
  assert.ok(sourceCoverageIssues(chat, current, store).length > 0); // Offsets without matching hashes are not evidence.
  tracked.sourceCoverageHashes = Object.fromEntries(plan.sources.map(source => [source.id, source.hash]));
  assert.deepEqual(sourceCoverageIssues(chat, current, store), []);
  tracked.sourceCoverageHashes[message.id] = 'stale'; assert.ok(sourceCoverageIssues(chat, current, store).length > 0);
});

test('source reads are confined to this chat user messages and current task goal', () => {
  const store = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'source-auth-'))); const chat = store.create(); const other = store.create();
  const allowed = store.appendMessage(chat, { role: 'user', text: 'allowed' }); const assistant = store.appendMessage(chat, { role: 'assistant', text: 'secret' }); const foreign = store.appendMessage(other, { role: 'user', text: 'foreign' });
  const current = task('mine', 'my goal'); const sibling = task('sibling', 'other secret'); chat.tasks.push(current, sibling);
  assert.equal(readSource(chat, current, store, { sourceId: allowed.id, offset: 0 }).text, 'allowed');
  for (const sourceId of [assistant.id, foreign.id, 'goal:sibling', 'blobs/file.txt']) assert.throws(() => readSource(chat, current, store, { sourceId, offset: 0 }));
  assert.throws(() => readSource(chat, current, store, { sourceId: allowed.id, offset: 1 })); assert.throws(() => readSource(chat, current, store, { sourceId: allowed.id, offset: 4000 }));
  assert.equal(sourcePlan(chat, current, store).inline, true); assert.deepEqual(sourceCoverageIssues(chat, current, store), []); assert.match(buildContext(chat, current, store).systemPrompt, /allowed/);
});

test('large source lists remain bounded and expose index pagination', () => {
  const store = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'source-index-'))); const chat = store.create();
  for (let i = 0; i < 80; i++) store.appendMessage(chat, { role: 'user', text: `user-${i}-` + '约'.repeat(400) });
  const current = task('mine', 'goal'); chat.tasks.push(current); const plan = sourcePlan(chat, current, store); const context = buildContext(chat, current, store);
  assert.equal(plan.inline, false); assert.equal(plan.sources.length, 81); assert.ok(context.inputEstimate <= 24_000); assert.match(context.systemPrompt, /user_source_list/); assert.match(context.systemPrompt, /来源总数 81/);
  assert.match(context.systemPrompt, new RegExp(plan.sources[0]!.id)); assert.doesNotMatch(context.systemPrompt, new RegExp(plan.sources[50]!.id));
});

test('material estimate does not undercount Chinese and never splits Unicode to fit auxiliary state', () => {
  const store = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'source-estimate-'))); const chat = store.create();
  store.appendMessage(chat, { role: 'user', text: '中文要求😀'.repeat(900) });
  const current = task('mine', '保留所有原文'); chat.tasks.push(current);
  const context = buildContext(chat, current, store);
  assert.equal(context.inputEstimate, Buffer.byteLength(context.systemPrompt + context.prompt, 'utf8'));
  assert.ok(context.inputEstimate <= 24_000); assert.equal(sourcePlan(chat, current, store).inline, false);
  assert.equal(Buffer.from(context.systemPrompt).toString('utf8'), context.systemPrompt);
});

test('resolved clarification pairs are shared after restart, excluding pending, cancelled and tool tickets', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'source-clarifications-')); const store = new ChatStore(root); const chat = store.create();
  store.appendMessage(chat, { role: 'user', text: 'A' });
  const current = task('mine', '协作架构'); chat.tasks.push(current);
  const resolved = { id: 'platform', taskId: current.id, invocationId: 'inv', type: 'user' as const, status: 'resolved' as const, createdAt: '', question: '部署平台？', options: ['A: Windows', 'B: Linux'], answer: 'A' };
  chat.tickets.push(resolved, { ...resolved, id: 'pending', taskId: 'other', status: 'pending', question: 'pending-secret' },
    { ...resolved, id: 'cancelled', taskId: 'other', status: 'cancelled', question: 'cancelled-secret' },
    { ...resolved, id: 'tool', taskId: 'other', type: 'tool', question: 'tool-secret' });
  for (let n = 0; n < 55; n++) store.appendMessage(chat, { role: 'assistant', text: `recent-${n}` });
  store.save(chat);
  const restarted = new ChatStore(root); const loaded = restarted.get(chat.id); const active = loaded.tasks[0]!;
  assert.equal(sourcePlan(loaded, active, restarted).sources.filter(source => source.kind === 'clarification').length, 1);
  const pair = JSON.parse(readSource(loaded, active, restarted, { sourceId: 'clarification:platform', offset: 0 }).text);
  assert.deepEqual(pair, { question: '部署平台？', options: ['A: Windows', 'B: Linux'], answer: 'A' });
  for (const role of ['claude', 'astra', 'sol', 'grok'] as const) {
    active.role = role; const context = buildContext(loaded, active, restarted);
    assert.match(context.systemPrompt, /部署平台/); assert.match(context.systemPrompt, /A: Windows/); assert.match(context.systemPrompt, /"answer":"A"/);
    assert.doesNotMatch(context.systemPrompt, /pending-secret|cancelled-secret|tool-secret/);
  }
  const foreign = restarted.create(); foreign.tasks.push(task('other', 'other'));
  assert.throws(() => readSource(foreign, foreign.tasks[0]!, restarted, { sourceId: 'clarification:platform', offset: 0 }), /无权/);
});

test('large clarification pairs use lossless source pages and invalidate coverage when the decision changes', () => {
  const store = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'source-clarification-pages-'))); const chat = store.create();
  const current = task('mine', '架构协作'); current.role = 'astra'; chat.tasks.push(current);
  const ticket = { id: 'large', taskId: current.id, invocationId: 'inv', type: 'user' as const, status: 'resolved' as const, createdAt: '', question: '需要保留哪些约束😀？'.repeat(1300), options: ['全部'], answer: '全部' };
  chat.tickets.push(ticket);
  const plan = sourcePlan(chat, current, store); assert.equal(plan.inline, false);
  const context = buildContext(chat, current, store); assert.ok(context.inputEstimate <= 24_000); assert.match(context.systemPrompt, /clarification:large/);
  current.sourceCoverage = {}; current.sourceCoverageHashes = {};
  let reconstructed = '';
  for (const source of plan.sources) {
    current.sourceCoverage[source.id] = []; current.sourceCoverageHashes[source.id] = source.hash;
    let offset: number | null = 0;
    while (offset !== null) {
      const start: number = offset; const page = readSource(chat, current, store, { sourceId: source.id, offset: start });
      assert.equal(Buffer.from(page.text).toString('utf8'), page.text);
      if (source.kind === 'clarification') reconstructed += page.text;
      current.sourceCoverage[source.id]!.push(start); offset = page.next;
    }
  }
  assert.deepEqual(JSON.parse(reconstructed), { question: ticket.question, options: ticket.options, answer: ticket.answer });
  assert.deepEqual(sourceCoverageIssues(chat, current, store), []);
  ticket.answer = '只保留第一项'; assert.ok(sourceCoverageIssues(chat, current, store).some(issue => issue.startsWith('clarification:large:')));
});
