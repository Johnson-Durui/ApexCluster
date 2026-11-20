import assert from 'node:assert/strict';
import test from 'node:test';
import { createFanoutGroup, fanoutGoals, mechanicalCollect, parseWorkerReport, selectForDisposition } from '../src/chat/fanout.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { loadRoster, resolvePool, taskSeat } from '../src/chat/roster.js';
import type { AgentTask, ChatRecord } from '../src/chat/types.js';

const registry = loadModelRegistry();
const roster = loadRoster('config/roster.json', registry);
const now = '2026-11-18T00:00:00.000Z';

function task(id: string, parentTaskId = 'parent'): AgentTask {
  return { id, parentTaskId, turnId: 'turn', role: 'grok', goal: id, phase: 'architecture', status: 'completed', createdAt: now,
    updatedAt: now, segment: 1, result: JSON.stringify({ status: 'completed', summary: `结果${id}`, evidenceRefs: [], changedFiles: [], deviations: [], concerns: [] }),
    resultRef: `blobs/${id}.json`, invocationIds: [], noProgressSegments: 0, mode: 'read' };
}

test('pool resolution is phase-scoped and provider-specific without fallback', () => {
  assert.equal(resolvePool(roster, 'grok', 'architecture')?.binding.model, 'grok-4.7');
  assert.equal(resolvePool(roster, 'deepseek', 'architecture'), undefined);
  assert.equal(resolvePool(roster, 'deepseek', 'implementation')?.binding.model, 'deepseek-v4-pro');
  assert.equal(resolvePool(roster, 'mini', 'architecture'), undefined);
  assert.equal(resolvePool(roster, 'mini', 'architecture', 'openai')?.binding.model, 'gpt-6-luna');
  assert.equal(resolvePool(roster, 'mini', 'architecture', 'xai'), undefined);
  const chat = { apiRoster: { roster }, id: 'chat' } as ChatRecord;
  assert.equal(taskSeat(chat, { ...task('worker'), role: 'mini', poolProvider: 'google' } as AgentTask & { poolProvider: string })?.binding.model, 'gemini-4-hydrogen');
  assert.equal(taskSeat({} as ChatRecord, { ...task('legacy'), role: 'grok', phase: undefined })?.binding.model, 'grok-4.7-high-fast');
  assert.equal(resolvePool(roster, 'grok', 'architecture')?.can.writeMain, false);
  assert.equal(resolvePool(roster, 'grok', 'architecture')?.can.writeIsolated, true);
});

test('fanout renders stable goals and records group identity without an item ceiling', () => {
  const input = { pool: 'grok', mode: 'read', template: '检查 {{index}}：{{item}}', items: Array.from({ length: 2_000 }, (_, index) => ({ index })) };
  const goals = fanoutGoals(input);
  assert.equal(goals.length, 2_000);
  assert.equal(goals[0]?.goal, '检查 1：{"index":0}');
  assert.equal(goals.at(-1)?.goal, '检查 2000：{"index":1999}');
  assert.deepEqual(createFanoutGroup('group', 'parent', { ...input, reduce: '分层归并' }, now), {
    id: 'group', parentTaskId: 'parent', pool: 'grok', mode: 'read', total: 2_000, createdAt: now, reduce: '分层归并',
  });
});

test('mechanical collection stays bounded, paginates and batch disposition is exact', () => {
  const tasks = Array.from({ length: 500 }, (_, index) => ({ ...task(`child-${index}`), groupId: 'group',
    disposition: index < 100 ? 'adopted' as const : undefined }));
  const collected = mechanicalCollect(tasks, 'parent', { groupId: 'group' });
  assert.equal(collected.total, 500);
  assert.equal(collected.counts.completed, 500);
  assert.equal(collected.dispositions.adopted, 100);
  assert.equal(collected.dispositions.pending, 400);
  assert.ok(collected.next && collected.items.length <= 50);
  assert.ok(Buffer.byteLength(JSON.stringify(collected), 'utf8') <= 10_000);
  const selected = selectForDisposition(tasks, 'parent', { taskIds: ['child-1', 'child-2'], disposition: 'reference' });
  assert.deepEqual(selected.tasks.map(item => item.id), ['child-1', 'child-2']);
  assert.equal(selected.disposition, 'reference');
  assert.throws(() => selectForDisposition(tasks, 'parent', { taskIds: ['child-1', 'foreign'], disposition: 'rejected' }), /不存在|不属于/);
});

test('worker reports reject prose and overlong summaries', () => {
  assert.equal(parseWorkerReport(JSON.stringify({ status: 'blocked', summary: '需要输入', evidenceRefs: [], changedFiles: [], deviations: [], concerns: [] })).status, 'blocked');
  assert.throws(() => parseWorkerReport('ordinary prose'));
  assert.throws(() => parseWorkerReport({ status: 'completed', summary: 'x'.repeat(1_201) }));
});
