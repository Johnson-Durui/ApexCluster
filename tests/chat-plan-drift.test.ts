import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCompletionIssues, PlanUpdateError, updatePlan } from '../src/chat/plans.js';
import type { AgentTask, ChatRecord } from '../src/chat/types.js';

function fixture() {
  const task = { id: 'root', status: 'running' } as AgentTask;
  const chat = { tasks: [task], artifacts: [], toolResults: [
    { taskId: task.id, invocationId: 'i', name: 'file_read', ref: 'blobs/read', hash: 'h', bytes: 1 },
    { taskId: task.id, invocationId: 'i', name: 'test_submit', ref: 'blobs/test', hash: 't', bytes: 1 },
  ] } as unknown as ChatRecord;
  updatePlan(chat, task, { revision: 0, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'in_progress', verification: { kind: 'tool', toolName: 'test_submit' } }] });
  return { task, chat };
}

test('started work cannot return to pending to unlock its acceptance condition', () => {
  const { task, chat } = fixture();
  const before = structuredClone(chat);
  assert.throws(() => updatePlan(chat, task, { revision: 1, steps: [{ id: 'build', text: before.todos![0]!.text, status: 'pending' }] }), /回退|状态/);
  assert.deepEqual(chat, before);
});

for (const toolName of ['user_source_read', 'agent_submit', 'artifact_publish']) {
  test(`${toolName} control receipts cannot lock a work step into an impossible acceptance condition`, () => {
    const { task, chat } = fixture();
    chat.toolResults!.push({ taskId: task.id, invocationId: 'i', name: toolName, ref: `blobs/${toolName}`, hash: 'control', bytes: 1 });
    const before = structuredClone(chat);
    assert.throws(() => updatePlan(chat, task, { revision: 1, steps: [{ id: 'control', text: '实际工作', status: 'pending', verification: { kind: 'tool', toolName } }] }),
      (error: unknown) => error instanceof PlanUpdateError && error.code === 'PLAN_QUERY_VERIFICATION_FORBIDDEN' && error.details.invalidTool === toolName);
    assert.deepEqual(chat, before);
    updatePlan(chat, task, { revision: 1, steps: [{ id: 'control', text: '实际工作', status: 'pending', verification: { kind: 'tool', toolName: 'file_read' } }] });
    assert.equal(chat.planRevision, 2);
  });
}

test('started work cannot silently change its goal or remove a dependency', () => {
  const { task, chat } = fixture();
  let before = structuredClone(chat);
  assert.throws(() => updatePlan(chat, task, { revision: 1, steps: [{ id: 'build', text: '只读取说明即可完成', status: 'in_progress' }] }), /描述|定义/);
  assert.deepEqual(chat, before);
  updatePlan(chat, task, { revision: 1, steps: [{ id: 'prepare', text: '先核对输入', status: 'completed', verification: { kind: 'tool', toolName: 'file_read' }, evidenceRefs: ['blobs/read'] },
    { id: 'verify', text: '验证最终输出', status: 'in_progress', dependsOn: ['prepare'], verification: { kind: 'tool', toolName: 'test_submit' } }] });
  before = structuredClone(chat);
  assert.throws(() => updatePlan(chat, task, { revision: 2, steps: [{ id: 'verify', text: '验证最终输出', status: 'in_progress', dependsOn: [] }] }), /依赖|定义/);
  assert.deepEqual(chat, before);
});

test('omitted fields retain recorded dependencies, child identities and evidence', () => {
  const { task, chat } = fixture();
  chat.tasks.push({ id: 'child', parentTaskId: task.id, status: 'completed' } as AgentTask);
  updatePlan(chat, task, { revision: 1, steps: [
    { id: 'prepare', text: '核对输入', status: 'completed', verification: { kind: 'tool', toolName: 'file_read' }, evidenceRefs: ['blobs/read'] },
    { id: 'delegate', text: '检查子任务', status: 'in_progress', dependsOn: ['prepare'], linkedTaskIds: ['child'], evidenceRefs: ['blobs/test'], verification: { kind: 'task' } },
  ] });
  updatePlan(chat, task, { revision: 2, steps: [{ id: 'delegate', text: '检查子任务', status: 'completed' }] });
  const step = chat.todos!.find(step => step.id === 'delegate')!;
  assert.deepEqual(step.dependsOn, ['prepare']);
  assert.deepEqual(step.linkedTaskIds, ['child']);
  assert.deepEqual(step.evidenceRefs, ['blobs/test']);
});

test('completed and failed steps cannot be reopened or have their evidence replaced', () => {
  const { task, chat } = fixture();
  updatePlan(chat, task, { revision: 1, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'completed', evidenceRefs: ['blobs/test'] }] });
  for (const status of ['pending', 'in_progress', 'failed'] as const) {
    const before = structuredClone(chat);
    assert.throws(() => updatePlan(chat, task, { revision: 2, steps: [{ id: 'build', text: '实现并验证原定功能', status }] }), /终态|状态|回退/);
    assert.deepEqual(chat, before);
  }
  const failed = fixture();
  updatePlan(failed.chat, failed.task, { revision: 1, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'failed' }] });
  assert.throws(() => updatePlan(failed.chat, failed.task, { revision: 2, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'in_progress' }] }), /终态|状态|回退/);
  updatePlan(failed.chat, failed.task, { revision: 2, steps: [{ id: 'replacement', text: '另一个步骤不能抹除失败', status: 'completed', verification: { kind: 'tool', toolName: 'test_submit' }, evidenceRefs: ['blobs/test'] }] });
  assert.deepEqual(planCompletionIssues(failed.chat, failed.task), ['计划步骤未通过：build(failed)']);
  const before = structuredClone(chat);
  assert.throws(() => updatePlan(chat, task, { revision: 2, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'completed', evidenceRefs: ['blobs/test', 'blobs/read'] }] }), /终态|证据/);
  assert.deepEqual(chat, before);
});

test('active work can append genuine evidence but cannot discard recorded child ownership', () => {
  const { task, chat } = fixture();
  chat.tasks.push({ id: 'child', parentTaskId: task.id, status: 'completed' } as AgentTask);
  updatePlan(chat, task, { revision: 1, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'in_progress', linkedTaskIds: ['child'] }] });
  const before = structuredClone(chat);
  assert.throws(() => updatePlan(chat, task, { revision: 2, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'in_progress', linkedTaskIds: [] }] }), /子任务|关联/);
  assert.deepEqual(chat, before);
  updatePlan(chat, task, { revision: 2, steps: [{ id: 'build', text: '实现并验证原定功能', status: 'completed', evidenceRefs: ['blobs/test'] }] });
  assert.equal(chat.todos![0]!.status, 'completed');
  assert.deepEqual(chat.todos![0]!.linkedTaskIds, ['child']);
});
