import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ChatStore } from '../src/chat/store.js';
import { buildContext } from '../src/chat/context.js';
import { readSource, sourceCoverageIssues, sourcePlan } from '../src/chat/source-context.js';
import type { AgentTask } from '../src/chat/types.js';
import { createProductionChatRuntime } from '../src/chat/bootstrap.js';
import type { ChatRuntime } from '../src/chat/runtime.js';
import type { ChatDriver, ChatRole, DriverInput } from '../src/chat/types.js';

test('production fixed material that exceeds 24k switches to complete durable original-source paging', t => {
  const work = path.join(process.cwd(), 'work'); mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(path.join(work, 'execution-context-'));
  t.after(() => { assert.equal(path.dirname(directory), work); assert.ok(path.basename(directory).startsWith('execution-context-')); rmSync(directory, { recursive: true, force: true }); });
  const store = new ChatStore(directory); const chat = store.create();
  for (let index = 0; index < 100; index++) store.appendMessage(chat, { role: 'user', text: `constraint-${index}:${'x'.repeat(65)}🙂` });
  const task: AgentTask = { id: 'root', turnId: 'turn', role: 'claude', goal: '保留全部原文并执行', mode: 'read', status: 'running',
    createdAt: '', updatedAt: '', segment: 3, invocationIds: [], noProgressSegments: 0, executionPolicyVersion: 1, executionReviewRequired: true };
  chat.tasks.push(task);
  assert.equal(sourcePlan(chat, task, store).inline, true, 'fixture must begin below the ordinary inline byte threshold');
  const context = buildContext(chat, task, store);
  assert.equal(task.sourcePagingRequired, true);
  assert.ok(context.inputEstimate <= 24_000);
  assert.match(context.systemPrompt, /必保原文未内联|user_source_list/);
  assert.ok(sourceCoverageIssues(chat, task, store).length > 0, 'offloading must not pretend sources were delivered');
  for (const source of sourcePlan(chat, task, store).sources) {
    let offset: number | null = 0; let original = '';
    while (offset !== null) { const page = readSource(chat, task, store, { sourceId: source.id, offset }); original += page.text; offset = page.next; }
    assert.equal(original, source.kind === 'goal' ? task.goal : store.message(chat.id, source.id).text);
  }
  store.save(chat);
  const restarted = new ChatStore(directory); const loaded = restarted.get(chat.id); const restored = loaded.tasks[0]!;
  assert.equal(restored.sourcePagingRequired, true);
  assert.equal(sourcePlan(loaded, restored, restarted).inline, false);
  assert.ok(buildContext(loaded, restored, restarted).inputEstimate <= 24_000);
  assert.ok(sourceCoverageIssues(loaded, restored, restarted).length > 0, 'direct retrieval in this fixture is not a runtime delivery receipt');
});

test('all 32 step identities and paged evidence metadata remain recoverable without replacing actual view delivery', async t => {
  const work = path.join(process.cwd(), 'work'); mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(path.join(work, 'execution-metadata-'));
  t.after(() => { assert.equal(path.dirname(directory), work); assert.ok(path.basename(directory).startsWith('execution-metadata-')); rmSync(directory, { recursive: true, force: true }); });
  let runtime!: ChatRuntime;
  let verified = false;
  const ids = Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, '0')}_${'x'.repeat(77)}`);
  const invoke = async (input: DriverInput) => {
    assert.equal(input.task.role, 'claude');
    await input.callTool('plan_update', { revision: 0, steps: ids.map(id => ({ id, text: 'definition '.repeat(45), status: 'pending' })) });
    const overview = await input.callTool('execution_read', {});
    assert.ok(overview.text.length <= 4000);
    assert.deepEqual((overview.data as { workStepIds: string[] }).workStepIds, ids);
    const recovered: string[] = []; let offset: number | null = 0;
    while (offset !== null) {
      const reply = await input.callTool('execution_read', { section: 'steps', offset, limit: 20 });
      assert.ok(reply.text.length <= 3800);
      const data = reply.data as { items: { stepId: string }[]; next: number | null; metadataOnly: boolean };
      assert.equal(data.metadataOnly, true); recovered.push(...data.items.map(item => item.stepId)); offset = data.next;
      assert.ok(input.invocation.toolCount < 11, 'fixture must stay within one bounded segment');
    }
    assert.deepEqual(recovered, ids);
    assert.equal(input.task.resultReadPages?.length ?? 0, 0, 'metadata projections cannot fake canonical body delivery');
    const attempt = await input.callTool('agent_submit', { role: 'astra', mode: 'verify', purpose: 'execution_review', goal: 'must not start unfinished work review' });
    assert.equal((attempt.data as { accepted: boolean }).accepted, false);
    assert.equal(runtime.get(input.chatId).tasks.length, 1);
    verified = true;
    await input.callTool('task_fail', { reason: 'metadata-only fixture stops without claiming pending work complete' });
    return { text: '', exitConfirmed: true };
  };
  const roles: ChatRole[] = ['claude','astra','sol','grok'];
  const drivers = Object.fromEntries(roles.map(role => [role, { capability: { role, available: true, isolationVerified: true }, invoke } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  runtime = createProductionChatRuntime({ store: new ChatStore(directory), drivers, handoffMs: 1 });
  const chat = runtime.create({}); runtime.send(chat.id, { text: 'recover a large work definition', clientMessageId: 'metadata' });
  await runtime.idle(); assert.equal(verified, true); assert.equal(chat.tasks[0]?.status, 'failed');
  assert.equal(chat.tasks[0]?.error, 'metadata-only fixture stops without claiming pending work complete');
  assert.ok(runtime.store.messages(chat.id).items.every(message => message.role !== 'assistant'));
});
