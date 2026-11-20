import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanDependencyError, PlanUpdateError, safePlanFeedback, updatePlan, planCompletionIssues } from '../src/chat/plans.js';
import { HttpError } from '../src/orchestrator/errors.js';
import type { AgentTask, ChatRecord, PlanStep } from '../src/chat/types.js';
import { newPipelineState } from '../src/pipeline/state.js';

function fixture() {
  const task = { id: 'root', status: 'running' } as AgentTask;
  const chat = { tasks: [task], artifacts: [], toolResults: [] } as unknown as ChatRecord;
  return { task, chat };
}
test('plan revisions, dependencies and evidence gate completion without changing task state', () => {
  const { task, chat } = fixture();
  updatePlan(chat, task, { revision: 0, steps: [{ id: 'read', text: '读取资料', status: 'in_progress', verification: { kind: 'tool', toolName: 'document_read' } }, { id: 'write', text: '生成文档', status: 'pending', dependsOn: ['read'], verification: { kind: 'artifact', name: '结果.pdf' } }] });
  assert.equal(task.status, 'running'); assert.equal(planCompletionIssues(chat, task).length, 2);
  assert.throws(() => updatePlan(chat, task, { revision: 0, steps: [{ id: 'read', text: '读取', status: 'pending' }] }), /revision/);
  assert.throws(() => updatePlan(chat, task, { revision: 1, steps: [{ id: 'read', text: '读取资料', status: 'completed' }] }), /真实产物/);
  assert.throws(() => updatePlan(chat, task, { revision: 1, steps: [{ id: 'write', text: '生成', status: 'in_progress', dependsOn: ['read'] }] }), /依赖步骤/);
  chat.toolResults = [{ taskId: task.id, invocationId: 'i', ref: 'blobs/read', name: 'document_read', hash: 'h', bytes: 1 }];
  updatePlan(chat, task, { revision: 1, steps: [{ id: 'read', text: '读取资料', status: 'completed', evidenceRefs: ['blobs/read'] }] });
  assert.equal(chat.planRevision, 2);
});

test('listing evidence cannot certify deliveries or be reused to complete distinct work', () => {
  const { task, chat } = fixture();
  chat.toolResults = [{ taskId: task.id, invocationId: 'i', ref: 'blobs/list', name: 'session_file_list', hash: 'h', bytes: 1 }, { taskId: task.id, invocationId: 'i', ref: 'blobs/read', name: 'document_read', hash: 'h', bytes: 1 }];
  assert.throws(() => updatePlan(chat,task,{ revision:0,steps:[{ id:'deliver',text:'生成报告',status:'completed',verification:{kind:'artifact',name:'报告.pdf'},evidenceRefs:['blobs/list'] }] }),
    (error: unknown) => error instanceof HttpError && error.status === 403 && /证据.*程序回执/.test(error.message));
  assert.throws(() => updatePlan(chat,task,{ revision:0,steps:[{ id:'list',text:'完工',status:'completed',verification:{kind:'tool',toolName:'session_file_list'},evidenceRefs:['blobs/list'] }] }),/不能作为/);
  assert.throws(() => updatePlan(chat,task,{ revision:0,steps:['one','two'].map(id=>({ id,text:id,status:'completed',verification:{kind:'tool',toolName:'document_read'},evidenceRefs:['blobs/read'] })) }),/不能重复/);
});

test('query-only verification is rejected atomically before work starts and can be corrected while pending', () => {
  const { task, chat } = fixture();
  const before = structuredClone(chat);
  assert.throws(
    () => updatePlan(chat, task, { revision: 0, steps: [{ id: 'receipts', text: '核对回执', status: 'pending', verification: { kind: 'tool', toolName: 'task_evidence' } }] }),
    (error: unknown) => error instanceof HttpError && error.status === 400
      && (error as any).code === 'PLAN_QUERY_VERIFICATION_FORBIDDEN'
      && (error as any).details?.stepId === 'receipts' && (error as any).details?.invalidTool === 'task_evidence'
      && (error as any).details?.storedStatus === 'new' && (error as any).details?.requestedStatus === 'pending'
      && /pending.*verification.*task.*linkedTaskIds.*integrate_edit.*test_submit/s.test(error.message),
  );
  assert.deepEqual(chat, before); assert.equal(chat.todos, undefined); assert.equal(chat.planRevision, undefined);

  const paged = fixture();
  assert.throws(() => updatePlan(paged.chat, paged.task, { revision: 0, steps: [{ id: 'page', text: '分页取证', status: 'pending', verification: { kind: 'tool', toolName: 'result_read' } }] }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && (error as any).details?.invalidTool === 'result_read');
  assert.equal(paged.chat.todos, undefined); assert.equal(paged.chat.planRevision, undefined);
  const failureControl = fixture();
  assert.throws(() => updatePlan(failureControl.chat, failureControl.task, { revision: 0, steps: [{ id: 'fail', text: '失败结案', status: 'pending', verification: { kind: 'tool', toolName: 'task_fail' } }] }),
    (error: unknown) => error instanceof HttpError && (error as any).details?.invalidTool === 'task_fail');
  assert.equal(failureControl.chat.todos, undefined); assert.equal(failureControl.chat.planRevision, undefined);

  updatePlan(chat, task, { revision: 0, steps: [{ id: 'inspect', text: '检查资料', status: 'pending' }] });
  const pending = structuredClone(chat.todos);
  assert.throws(() => updatePlan(chat, task, { revision: 1, steps: [{ id: 'inspect', text: '检查资料', status: 'pending', verification: { kind: 'tool', toolName: 'file_list' } }] }), /stepId=inspect.*invalidTool=file_list.*storedStatus=pending/s);
  assert.deepEqual(chat.todos, pending); assert.equal(chat.planRevision, 1);
  updatePlan(chat, task, { revision: 1, steps: [{ id: 'inspect', text: '检查资料', status: 'pending', verification: { kind: 'tool', toolName: 'file_read' } }] });
  chat.toolResults = [{ taskId: task.id, invocationId: 'i', ref: 'blobs/read', name: 'file_read', hash: 'h', bytes: 1 }];
  updatePlan(chat, task, { revision: 2, steps: [{ id: 'inspect', text: '检查资料', status: 'completed', evidenceRefs: ['blobs/read'] }] });
  const currentTodos = () => (Reflect.get(chat, 'todos') as PlanStep[] | undefined) ?? [];
  assert.equal(currentTodos()[0]?.status, 'completed'); assert.equal(chat.planRevision, 3);

  chat.toolResults.push({ taskId: task.id, invocationId: 'i2', ref: 'blobs/test', name: 'test_submit', hash: 'h2', bytes: 1 });
  updatePlan(chat, task, { revision: 3, steps: [{ id: 'verify', text: '运行验收', status: 'completed', verification: { kind: 'tool', toolName: 'test_submit' }, evidenceRefs: ['blobs/test'] }] });
  assert.equal(currentTodos().find(item => item.id === 'verify')?.status, 'completed'); assert.equal(chat.planRevision, 4);
});

test('dependency rejection identifies only validated step fields and leaves the revision atomic', () => {
  const { task, chat } = fixture();
  updatePlan(chat, task, { revision: 0, steps: [
    { id: 'prepare', text: 'prepare secret-free', status: 'pending', verification: { kind: 'tool', toolName: 'file_read' } },
    { id: 'finish', text: 'finish', status: 'pending', dependsOn: ['prepare'], verification: { kind: 'tool', toolName: 'file_write' } },
  ] });
  const before = structuredClone(chat);
  assert.throws(() => updatePlan(chat, task, { revision: 1, steps: [{ id: 'finish', text: 'changed private text', status: 'in_progress', dependsOn: ['prepare'] }] }),
    (error: unknown) => error instanceof PlanDependencyError && error.details.stepId === 'finish' && error.details.requestedStatus === 'in_progress'
      && JSON.stringify(error.details.incompleteDependencies) === JSON.stringify([{ stepId: 'prepare', status: 'pending' }]));
  assert.deepEqual(chat, before);
});

test('safe query plan feedback rebuilds an exact five-field envelope without canary details', () => {
  const error = new PlanUpdateError('PLAN_QUERY_VERIFICATION_FORBIDDEN', { stepId: 'receipts', invalidTool: 'task_evidence', storedStatus: 'pending', requestedStatus: 'pending', verificationLocked: false });
  (error.details as any).secret = 'C:\\private\\token.txt bearer-secret'; error.message = 'CANARY';
  const feedback = safePlanFeedback(error, 'plan_update');
  assert.deepEqual(feedback?.details, { stepId: 'receipts', invalidTool: 'task_evidence', storedStatus: 'pending', requestedStatus: 'pending', verificationLocked: false });
  assert.doesNotMatch(JSON.stringify(feedback), /CANARY|private|bearer-secret/);
});

test('legacy revision 5 pending query criterion is rejected without mutation and can be corrected at the same revision', () => {
  const { task, chat } = fixture();
  chat.planRevision = 5;
  chat.todos = [{ id: 'receipts', taskId: task.id, text: '核对回执', status: 'pending', dependsOn: [], linkedTaskIds: [], evidenceRefs: [], verification: { kind: 'tool', toolName: 'task_evidence' }, updatedAt: 'legacy' }];
  const before = structuredClone(chat);
  assert.throws(
    () => updatePlan(chat, task, { revision: 5, steps: [{ id: 'receipts', text: '核对回执', status: 'in_progress' }] }),
    (error: unknown) => error instanceof HttpError && error.status === 400
      && (error as any).code === 'PLAN_QUERY_VERIFICATION_FORBIDDEN'
      && (error as any).details?.stepId === 'receipts' && (error as any).details?.invalidTool === 'task_evidence'
      && (error as any).details?.storedStatus === 'pending' && (error as any).details?.requestedStatus === 'in_progress'
      && (error as any).details?.verificationLocked === false,
  );
  assert.deepEqual(chat, before);
  updatePlan(chat, task, { revision: 5, steps: [{ id: 'receipts', text: '核对回执', status: 'pending', verification: { kind: 'tool', toolName: 'file_read' } }] });
  assert.equal(chat.planRevision, 6);
  assert.deepEqual(chat.todos?.[0]?.verification, { kind: 'tool', toolName: 'file_read' });
});

test('pending drafts can add legal task, integration and test criteria before starting and complete with distinct real evidence', () => {
  const { task, chat } = fixture();
  const child = { id: 'real-child', parentTaskId: task.id, status: 'completed', resultRef: 'blobs/child-result' } as AgentTask;
  chat.tasks.push(child);
  chat.toolResults = [
    { taskId: task.id, invocationId: 'i1', ref: 'blobs/integrate', name: 'integrate_edit', hash: 'h1', bytes: 1 },
    { taskId: task.id, invocationId: 'i2', ref: 'blobs/test', name: 'test_submit', hash: 'h2', bytes: 1 },
  ];
  const base = [
    { id: 'child', text: '采用子任务', status: 'pending' as const },
    { id: 'integrate', text: '集成编辑', status: 'pending' as const },
    { id: 'test', text: '运行测试', status: 'pending' as const },
  ];
  updatePlan(chat, task, { revision: 0, steps: base });
  updatePlan(chat, task, { revision: 1, steps: [
    { ...base[0], verification: { kind: 'task' }, linkedTaskIds: [child.id] },
    { ...base[1], verification: { kind: 'tool', toolName: 'integrate_edit' } },
    { ...base[2], verification: { kind: 'tool', toolName: 'test_submit' } },
  ] });
  updatePlan(chat, task, { revision: 2, steps: base.map(item => ({ ...item, status: 'in_progress' })) });
  updatePlan(chat, task, { revision: 3, steps: [
    { ...base[0], status: 'completed', linkedTaskIds: [child.id] },
    { ...base[1], status: 'completed', evidenceRefs: ['blobs/integrate'] },
    { ...base[2], status: 'completed', evidenceRefs: ['blobs/test'] },
  ] });
  assert.deepEqual(chat.todos?.map(item => item.status), ['completed', 'completed', 'completed']);
  assert.equal(planCompletionIssues(chat, task).length, 0); assert.equal(chat.planRevision, 4);
});
test('cyclic plans, foreign evidence and failed children cannot become completed', () => {
  const { task, chat } = fixture();
  assert.throws(() => updatePlan(chat, task, { revision: 0, steps: [{ id: 'a', text: 'a', status: 'pending', dependsOn: ['b'] }, { id: 'b', text: 'b', status: 'pending', dependsOn: ['a'] }] }), /循环/);
  assert.equal(chat.todos, undefined);
  chat.tasks.push({ id: 'child', parentTaskId: 'root', status: 'failed' } as AgentTask);
  assert.throws(() => updatePlan(chat, task, { revision: 0, steps: [{ id: 'a', text: 'a', status: 'completed', linkedTaskIds: ['child'], verification: { kind:'task' } }] }), /尚未成功/);
  assert.throws(() => updatePlan(chat, task, { revision: 0, steps: [{ id: 'a', text: 'a', status: 'completed', evidenceRefs: ['made-up'], verification: { kind:'tool',toolName:'document_read' } }] }), /程序回执/);
});

test('verification must be defined before work starts and cannot be added to legacy active steps', () => {
  const { task, chat } = fixture();
  assert.throws(() => updatePlan(chat,task,{revision:0,steps:[{id:'deploy',text:'部署生产',status:'in_progress'}]}),/开始步骤前/);
  assert.throws(() => updatePlan(chat,task,{revision:0,steps:[{id:'deploy',text:'部署生产',status:'in_progress',verification:{kind:'artifact'}}]}),/完整验收条件/);
  chat.todos = [{id:'legacy',taskId:task.id,text:'旧步骤',status:'in_progress',dependsOn:[],linkedTaskIds:[],evidenceRefs:[],updatedAt:''}];
  chat.toolResults = [{taskId:task.id,invocationId:'i',ref:'blobs/read',name:'document_read',hash:'h',bytes:1}];
  assert.throws(() => updatePlan(chat,task,{revision:0,steps:[{id:'legacy',text:'旧步骤',status:'completed',verification:{kind:'tool',toolName:'task_evidence'}}]}),
    (error: unknown) => error instanceof HttpError && error.status === 409 && (error as any).details?.verificationLocked === true
      && /stepId=legacy.*storedStatus=in_progress.*已started.*锁定/s.test(error.message));
  assert.throws(() => updatePlan(chat,task,{revision:0,steps:[{id:'legacy',text:'旧步骤',status:'completed',verification:{kind:'tool',toolName:'document_read'},evidenceRefs:['blobs/read']}]}),/不能改写或补设/);
  assert.equal(chat.planRevision,undefined);
});

test('Sol Demo can reuse failed sibling step names with private dependencies and evidence', () => {
  const { task, chat } = fixture();
  chat.pipeline = newPipelineState({ preset: 'single-provider' });
  const first = { id: 'first-demo', parentTaskId: task.id, turnId: 'turn', role: 'sol', phase: 'demo', mode: 'edit', status: 'running' } as AgentTask;
  const retry = { ...first, id: 'retry-demo' };
  chat.tasks.push(first, retry);
  const oldEvidence = { taskId: first.id, invocationId: 'i1', ref: 'blobs/old', name: 'exec', hash: 'h1', bytes: 1 };
  chat.toolResults = [oldEvidence];
  const steps = [
    { id: 'demo-cli', text: 'Prepare the CLI', status: 'pending', verification: { kind: 'tool', toolName: 'exec' } },
    { id: 'demo-run', text: 'Run the CLI', status: 'pending', dependsOn: ['demo-cli'], verification: { kind: 'tool', toolName: 'exec' } },
  ];
  updatePlan(chat, first, { revision: 0, steps: [{ ...steps[0], status: 'completed', evidenceRefs: [oldEvidence.ref] }, steps[1]] });
  const historical = structuredClone(chat.todos);
  assert.throws(() => updatePlan(chat, retry, { revision: 1, steps }), /步骤ID已属于其他任务/);
  first.status = 'completed';
  assert.throws(() => updatePlan(chat, retry, { revision: 1, steps }), /步骤ID已属于其他任务/);
  assert.equal(chat.planRevision, 1);

  first.status = 'failed';
  const retryPlan = updatePlan(chat, retry, { revision: 1, steps }).todos.filter(step => step.taskId === retry.id);
  const [prepare, run] = retryPlan;
  assert.notEqual(prepare!.id, 'demo-cli');
  assert.notEqual(run!.id, 'demo-run');
  assert.deepEqual(run!.dependsOn, [prepare!.id]);
  assert.throws(() => updatePlan(chat, retry, { revision: 2, steps: [{ ...steps[0], status: 'completed', evidenceRefs: [oldEvidence.ref] }] }), /证据不属于当前任务/);
  assert.equal(chat.planRevision, 2);

  const ownEvidence = { ...oldEvidence, taskId: retry.id, invocationId: 'i2', ref: 'blobs/new' };
  chat.toolResults.push(ownEvidence);
  updatePlan(chat, retry, { revision: 2, steps: [{ ...steps[0], status: 'completed', evidenceRefs: [ownEvidence.ref] }] });
  const final = updatePlan(chat, retry, { revision: 3, steps: [{ ...steps[1], id: run!.id, dependsOn: [prepare!.id], status: 'in_progress' }] });
  assert.deepEqual(final.todos.filter(step => step.taskId === first.id), historical);
  assert.deepEqual(final.todos.filter(step => step.taskId === retry.id).map(step => [step.id, step.status, step.evidenceRefs]), [
    [prepare!.id, 'completed', [ownEvidence.ref]],
    [run!.id, 'in_progress', []],
  ]);
});
