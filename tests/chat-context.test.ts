import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from '../src/chat/store.js';
import { buildContext, checkpoint, PROMPT_VERSION } from '../src/chat/context.js';
import type { AgentTask, Invocation } from '../src/chat/types.js';

test('context preserves user constraints and records checkpoint', () => {
  const s=new ChatStore(mkdtempSync(path.join(os.tmpdir(),'ctx-'))); const c=s.create(); const m=s.appendMessage(c,{role:'user',text:'必须保留这个约束'});
  const task:AgentTask={id:'task',turnId:'turn',role:'claude',goal:'完成任务',status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),segment:1,invocationIds:[],noProgressSegments:0,mode:'read'}; c.tasks.push(task);
  const x=buildContext(c,task,s); assert.match(x.systemPrompt,/必须保留这个约束/);
  const inv:Invocation={id:'inv',taskId:task.id,segment:1,status:'running',startedAt:new Date().toISOString(),toolCount:0,promptVersion:'chat-v1',inputEstimate:x.inputEstimate,contextWindow:null,contextUsed:null}; for(let i=0;i<50;i++) checkpoint(c,task,{...inv,id:`inv-${i}`},'继续'); assert.equal(c.checkpoints.length,50); assert.deepEqual(c.checkpoints[0]!.constraintMessageIds,[m.id]);
});

test('500 user messages and 50 checkpoints survive a disk restart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-stress-')); const s = new ChatStore(dir); const c = s.create();
  for (let n = 0; n < 500; n++) s.appendMessage(c, { role: 'user', text: `constraint-${n}` });
  const task: AgentTask = { id: 'task', turnId: 'turn', role: 'claude', goal: 'work', status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' }; c.tasks.push(task);
  const inv: Invocation = { id: 'inv', taskId: task.id, segment: 1, status: 'running', startedAt: '', toolCount: 0, promptVersion: 'chat-v1', inputEstimate: 0, contextWindow: null, contextUsed: null };
  for (let n = 0; n < 50; n++) checkpoint(c, task, { ...inv, id: `inv-${n}` }, `continue-${n}`); s.save(c);
  const restarted = new ChatStore(dir); const loaded = restarted.get(c.id); assert.equal(loaded.checkpoints.length, 50); assert.equal(loaded.constraintMessageIds.length, 500);
  const context = buildContext(loaded, loaded.tasks[0]!, restarted); assert.match(context.systemPrompt, /constraint-0/); assert.match(context.systemPrompt, /constraint-499/);
  const result: number[] = []; let before: number | undefined; do { const page = restarted.messages(c.id, { before, limit: 50 }); result.unshift(...page.items.map(m => m.seq)); before = page.nextBefore; } while (before);
  assert.deepEqual(result, Array.from({ length: 500 }, (_, i) => i + 1));
});

test('context names undisposed children without claiming they were disposed', () => {
  const s = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'ctx-children-'))); const c = s.create();
  const task: AgentTask = { id: 'parent', turnId: 'turn', role: 'claude', goal: 'work', status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' }; c.tasks.push(task);
  for (let n = 0; n < 40; n++) c.tasks.push({ ...task, id: `child-${n}`, parentTaskId: task.id, role: 'grok', status: 'completed', ...(n === 39 ? { disposition: 'reference' as const } : {}) });
  const context = buildContext(c, task, s); assert.match(context.systemPrompt, /child-0:completed::待处置/); assert.match(context.systemPrompt, /待处置 39 项；已处置 1 项/); assert.doesNotMatch(context.systemPrompt, /child-38:completed/);
});

test('resumed task sees only its latest eight completed tool results and its own pending tickets', () => {
  const s = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'ctx-results-'))); const c = s.create();
  const task: AgentTask = { id: 'mine', turnId: 'turn', role: 'astra', goal: 'work', status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' }; c.tasks.push(task);
  for (let n = 0; n < 9; n++) c.tickets.push({ id: `tool-${n}`, taskId: task.id, invocationId: 'inv', type: 'tool', status: 'resolved', createdAt: '', answer: `output-${n}`, resultRef: `blobs/test-${n}.txt` });
  c.tickets.push({ id: 'mine-question', taskId: task.id, invocationId: 'inv', type: 'user', status: 'pending', createdAt: '', question: 'my-question' });
  c.tickets.push({ id: 'other-question', taskId: 'other', invocationId: 'inv', type: 'user', status: 'pending', createdAt: '', question: 'other-secret' });
  c.tickets.push({ id: 'other-tool', taskId: 'other', invocationId: 'inv', type: 'tool', status: 'resolved', createdAt: '', answer: 'other-result' });
  const prompt = buildContext(c, task, s).systemPrompt;
  assert.match(prompt, /output-1/); assert.match(prompt, /output-8/); assert.match(prompt, /blobs\/test-8\.txt/); assert.doesNotMatch(prompt, /output-0|other-secret|other-result/); assert.match(prompt, /my-question/);
  assert.match(prompt, /你是 Astra/); assert.doesNotMatch(prompt, /你是 Claude|你是 Sol|你是 Grok/);
});

test('resumed context exposes only a compact structured index of supplied result pages', () => {
  const s = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'ctx-result-pages-'))); const c = s.create();
  const task: AgentTask = { id: 'task', turnId: 'turn', role: 'astra', goal: 'resume', status: 'running', createdAt: '', updatedAt: '', segment: 2, invocationIds: [], noProgressSegments: 0, mode: 'verify' };
  (task as any).resultReadPages = Array.from({ length: 12 }, (_, index) => ({ ref: `blobs/page-${index}.txt`, hash: String(index).padStart(64, '0'), offset: 0, next: null, workspaceVersion: 7, coverageIndex: index, firstInvocationId: `inv-${index}`, firstToolCallId: `inv-${index}:1` })); c.tasks.push(task);
  const prompt = buildContext(c, task, s).systemPrompt;
  assert.match(prompt, /已提供结果页/); assert.match(prompt, /blobs\/page-11\.txt/); assert.match(prompt, /"workspaceVersion":7/); assert.doesNotMatch(prompt, /blobs\/page-0\.txt/);
});

test('runner recovery metadata is not displaced by the generic supplied-page tail', () => {
  const s = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'ctx-runner-evidence-'))); const c = s.create();
  const task: AgentTask = { id: 'task', turnId: 'turn', role: 'astra', goal: 'resume runner verification', status: 'running', createdAt: '', updatedAt: '', segment: 3, invocationIds: [], noProgressSegments: 0, mode: 'verify' };
  task.resultReadPages = [{ ref: 'blobs/runner.json', hash: 'a'.repeat(64), offset: 0, next: null, workspaceId: null, workspaceVersion: null, sourceRevision: null, baselineAuthority: 'task:task:no-workspace', coverageIndex: 0, firstInvocationId: 'inv-runner', firstToolCallId: 'inv-runner:2', runnerEvidence: { ok: true, platform: 'windows', sourceSnapshotId: 'wsnap-source', sourceFingerprint: 'b'.repeat(64), exitCode: 0, timedOut: false, cancelled: false, spawnError: null, processExitConfirmed: true, bodyFirstInvocationId: 'inv-runner', bodyFirstToolCallId: 'inv-runner:2' } },
    ...Array.from({ length: 12 }, (_, index) => ({ ref: `blobs/page-${index}.txt`, hash: String(index).padStart(64, '0'), offset: 0, next: null, workspaceId: null, workspaceVersion: null, sourceRevision: null, baselineAuthority: 'task:task:no-workspace', coverageIndex: index + 1, firstInvocationId: `inv-${index}`, firstToolCallId: `inv-${index}:1` }))]; c.tasks.push(task);
  const prompt = buildContext(c, task, s).systemPrompt; assert.match(prompt, /wsnap-source/); assert.match(prompt, /"currentBaseline":true/); assert.doesNotMatch(prompt, /blobs\/page-0\.txt/);
});

test('runner metadata is either complete JSON or atomically replaced by a pagination hint', () => {
  const s = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'ctx-runner-atomic-'))); const c = s.create();
  const task: AgentTask = { id: 'task', turnId: 'turn', role: 'astra', goal: 'atomic runner context', status: 'running', createdAt: '', updatedAt: '', segment: 3, invocationIds: [], noProgressSegments: 0, mode: 'verify' };
  const fingerprint = 'b'.repeat(64); task.resultReadPages = [{ ref: 'blobs/runner.json', hash: 'a'.repeat(64), offset: 3900, next: null, workspaceId: null, workspaceVersion: null, sourceRevision: null, baselineAuthority: 'task:task:no-workspace', coverageIndex: 1, firstInvocationId: 'inv', firstToolCallId: 'inv:2', runnerEvidence: { ok: true, platform: 'linux', sourceSnapshotId: 'wsnap-atomic-context', sourceFingerprint: fingerprint, exitCode: 0, timedOut: false, cancelled: false, spawnError: null, processExitConfirmed: true, bodyFirstInvocationId: 'inv', bodyFirstToolCallId: 'inv:1' } }]; c.tasks.push(task);
  c.todos = [{ id: 'step', taskId: task.id, text: 'P', status: 'pending', dependsOn: [], linkedTaskIds: [], evidenceRefs: [], updatedAt: '' }];
  const full = buildContext(c, task, s).systemPrompt; const marker = '已提供runner证据元数据'; assert.match(full, new RegExp(fingerprint));
  const jsonStart = full.indexOf('[', full.indexOf(marker)); const jsonEnd = full.indexOf('\n产物：', jsonStart); assert.doesNotThrow(() => JSON.parse(full.slice(jsonStart, jsonEnd)));
  let compact = '';
  for (let length = 0; length <= 30_000; length += 25) { c.todos[0]!.text = 'P'.repeat(length); const built = buildContext(c, task, s); if (built.systemPrompt.includes('runner元数据未内联')) { compact = built.systemPrompt; assert.ok(built.inputEstimate <= 24_000); break; } }
  assert.ok(compact, 'fixture must reach the atomic runner omission boundary'); assert.match(compact, /task_evidence按next分页恢复/); assert.doesNotMatch(compact, /已提供runner证据元数据|blobs\/runner\.json|wsnap-atomic-context|b{8}/);
});

test('fixed material that leaves no room for the runner recovery hint pages the sources instead of failing', () => {
  // r16 live workflow: Astra's fixed material ended 0-127 bytes under 24 000 with runner metadata to resume, so the
  // recovery hint could not fit, paging never started (room was not negative) and the verify task failed.
  const s = new ChatStore(mkdtempSync(path.join(os.tmpdir(), 'ctx-runner-boundary-'))); const c = s.create();
  s.appendMessage(c, { role: 'user', text: '目标值为 2；必须保留 test.mjs。' });
  let paged = 0;
  for (let length = 4_000; length <= 9_800; length += 25) {
    const task: AgentTask = { id: 'task', turnId: 'turn', role: 'astra', goal: `verify ${'G'.repeat(length)}`, status: 'running', createdAt: '', updatedAt: '', segment: 3, invocationIds: [], noProgressSegments: 0, mode: 'verify' };
    task.resultReadPages = [{ ref: 'blobs/runner.json', hash: 'a'.repeat(64), offset: 0, next: null, workspaceId: null, workspaceVersion: null, sourceRevision: null, baselineAuthority: 'task:task:no-workspace', coverageIndex: 0, firstInvocationId: 'inv', firstToolCallId: 'inv:2', runnerEvidence: { ok: true, platform: 'linux', sourceSnapshotId: 'wsnap-boundary', sourceFingerprint: 'b'.repeat(64), exitCode: 0, timedOut: false, cancelled: false, spawnError: null, processExitConfirmed: true, bodyFirstInvocationId: 'inv', bodyFirstToolCallId: 'inv:2' } }];
    c.tasks = [task];
    const built = buildContext(c, task, s);
    assert.ok(built.inputEstimate <= 24_000, `goal length ${length} exceeds the budget`);
    if (task.sourcePagingRequired) {
      paged++;
      assert.match(built.systemPrompt, /必保原文未内联/);
      assert.match(built.systemPrompt, /wsnap-boundary|task_evidence按next分页恢复/, `goal length ${length} lost the runner recovery path`);
      assert.doesNotMatch(built.systemPrompt, /G{100}/, 'paged goal must not also be inlined');
    }
  }
  assert.ok(paged > 0, 'fixture must cross the fixed-material boundary');
});

test('prompt version binds all six prompt sources', () => {
  const names = ['common', 'claude', 'astra', 'sol', 'grok', 'handoff'];
  const sources = names.map(name => [name, readFileSync(path.join(process.cwd(), 'src/chat/prompts', `${name}.md`), 'utf8')]);
  const hash = createHash('sha256').update(JSON.stringify(sources)).digest('hex'); assert.equal(PROMPT_VERSION, `chat-v1-${hash}`);
});
