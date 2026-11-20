import { hash } from 'node:crypto';
import { z } from 'zod/v4';
import { HttpError } from '../orchestrator/errors.js';
import { terminalTask, type AgentTask, type ChatRecord, type PlanStep } from './types.js';
import { isExecutionReviewTask, NON_COMPLETION_TOOLS } from './execution.js';
export { NON_COMPLETION_TOOLS } from './execution.js';

const step = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), text: z.string().trim().min(1).max(500),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  dependsOn: z.array(z.string()).max(32).optional(), linkedTaskIds: z.array(z.string()).max(32).optional(),
  evidenceRefs: z.array(z.string()).max(32).optional(),
  verification: z.object({ kind: z.enum(['artifact','tool','task']), name: z.string().min(1).max(160).optional(), toolName: z.string().min(1).max(100).optional() }).strict().optional(),
}).strict();
export const planInput = z.object({ revision: z.number().int().min(0), steps: z.array(step).min(1).max(32) }).strict();

export type PlanUpdateErrorDetails = { stepId: string; invalidTool: string; storedStatus: PlanStep['status'] | 'new'; requestedStatus: PlanStep['status']; verificationLocked: boolean };
export class PlanUpdateError extends HttpError {
  constructor(readonly code: 'PLAN_QUERY_VERIFICATION_FORBIDDEN', readonly details: PlanUpdateErrorDetails) {
    const recovery = details.verificationLocked
      ? '该步骤已started，验收条件仍按锁定规则不可改写或补设'
      : `原子拒绝后步骤仍为${details.storedStatus === 'new' ? '未创建' : 'pending'}，请保持pending并修正verification后用同一revision重试`;
    super(details.verificationLocked ? 409 : 400, `PLAN_QUERY_VERIFICATION_FORBIDDEN stepId=${details.stepId} invalidTool=${details.invalidTool} storedStatus=${details.storedStatus} requestedStatus=${details.requestedStatus}：协调/取证查询本身不能作为工作验收；${recovery}。合法子任务示例 {"verification":{"kind":"task"},"linkedTaskIds":["<真实childID>"]}；自身集成示例 {"verification":{"kind":"tool","toolName":"integrate_edit"},"evidenceRefs":["<真实integrate_edit ref>"]}；真实测试示例 {"verification":{"kind":"tool","toolName":"test_submit"},"evidenceRefs":["<真实test_submit ref>"]}`);
    this.name = 'PlanUpdateError';
  }
}

export type PlanDependencyErrorDetails = { stepId: string; requestedStatus: PlanStep['status']; incompleteDependencies: { stepId: string; status: PlanStep['status'] }[] };
export class PlanDependencyError extends HttpError {
  readonly code = 'PLAN_DEPENDENCY_INCOMPLETE' as const;
  constructor(readonly details: PlanDependencyErrorDetails) {
    super(409, `PLAN_DEPENDENCY_INCOMPLETE stepId=${details.stepId} requestedStatus=${details.requestedStatus}：依赖步骤尚未完成；先完成 ${details.incompleteDependencies.map(item => `${item.stepId}(${item.status})`).join('、')}，或将当前步骤保持pending后用同一revision修正。`);
    this.name = 'PlanDependencyError';
  }
}

export type PlanCompletionDetails = { steps: { stepId: string; status: PlanStep['status'] }[] };
export class PlanCompletionError extends HttpError {
  readonly code = 'PLAN_INCOMPLETE' as const;
  constructor(readonly details: PlanCompletionDetails) {
    super(409, `PLAN_INCOMPLETE 计划步骤未通过：${details.steps.map(item => `${item.stepId}(${item.status})`).join('、')}；当前任务计划尚未闭合；继续完成真实工作，若当前任务目标确实无法完成，则先保存可用报告或证据再调用task_fail。`);
    this.name = 'PlanCompletionError';
  }
}

export type SafePlanFeedback = {
  status: 400 | 409;
  code: 'PLAN_QUERY_VERIFICATION_FORBIDDEN' | 'PLAN_DEPENDENCY_INCOMPLETE' | 'PLAN_INCOMPLETE';
  details: PlanUpdateErrorDetails | PlanDependencyErrorDetails | PlanCompletionDetails;
  text: string;
};
const statuses: PlanStep['status'][] = ['pending', 'in_progress', 'completed', 'failed'];
const validStepId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const validStatus = (value: unknown): value is PlanStep['status'] => typeof value === 'string' && statuses.includes(value as PlanStep['status']);
/** Rebuild model-visible plan feedback from fixed, validated fields; never expose an exception message or arbitrary details. */
export function safePlanFeedback(error: unknown, toolName: string): SafePlanFeedback | null {
  if (toolName === 'plan_update' && error instanceof PlanUpdateError && error.code === 'PLAN_QUERY_VERIFICATION_FORBIDDEN') {
    const details = error.details;
    if (!details || typeof details !== 'object' || !validStepId(details.stepId) || typeof details.invalidTool !== 'string'
      || !NON_COMPLETION_TOOLS.includes(details.invalidTool as (typeof NON_COMPLETION_TOOLS)[number])
      || !(details.storedStatus === 'new' || validStatus(details.storedStatus)) || !validStatus(details.requestedStatus) || typeof details.verificationLocked !== 'boolean') return null;
    const recovery = details.verificationLocked
      ? '该步骤已started，verification仍锁定，不能改写或补设'
      : `拒绝未落盘；步骤仍为${details.storedStatus === 'new' ? '未创建' : 'pending'}，请保持pending并修正verification后用同一revision重试`;
    const clean: PlanUpdateErrorDetails = { stepId: details.stepId, invalidTool: details.invalidTool, storedStatus: details.storedStatus, requestedStatus: details.requestedStatus, verificationLocked: details.verificationLocked };
    return { status: clean.verificationLocked ? 409 : 400, code: error.code, details: clean, text: `PLAN_QUERY_VERIFICATION_FORBIDDEN stepId=${clean.stepId} invalidTool=${clean.invalidTool} storedStatus=${clean.storedStatus} requestedStatus=${clean.requestedStatus} verificationLocked=${clean.verificationLocked}：协调/取证查询本身不能作为工作验收；${recovery}。合法子任务使用 {"verification":{"kind":"task"},"linkedTaskIds":["<真实childID>"]}；自身集成使用 integrate_edit 真实ref；真实测试使用 test_submit 真实ref。` };
  }
  if (toolName === 'plan_update' && error instanceof PlanDependencyError && error.code === 'PLAN_DEPENDENCY_INCOMPLETE') {
    const details = error.details;
    if (!details || typeof details !== 'object' || !validStepId(details.stepId) || !validStatus(details.requestedStatus)
      || !Array.isArray(details.incompleteDependencies) || !details.incompleteDependencies.length || details.incompleteDependencies.length > 32
      || details.incompleteDependencies.some(item => !item || typeof item !== 'object' || !validStepId(item.stepId) || !validStatus(item.status) || item.status === 'completed')) return null;
    const clean: PlanDependencyErrorDetails = { stepId: details.stepId, requestedStatus: details.requestedStatus, incompleteDependencies: details.incompleteDependencies.map(item => ({ stepId: item.stepId, status: item.status })) };
    return { status: 409, code: error.code, details: clean, text: `PLAN_DEPENDENCY_INCOMPLETE stepId=${clean.stepId} requestedStatus=${clean.requestedStatus} incompleteDependencies=${clean.incompleteDependencies.map(item => `${item.stepId}(${item.status})`).join('、')}：先完成依赖步骤；或将当前步骤保持pending后用同一revision修正。` };
  }
  if (toolName === 'task_complete' && error instanceof PlanCompletionError && error.code === 'PLAN_INCOMPLETE') {
    const details = error.details;
    if (!details || typeof details !== 'object' || !Array.isArray(details.steps) || !details.steps.length || details.steps.length > 32
      || details.steps.some(item => !item || typeof item !== 'object' || !validStepId(item.stepId) || !validStatus(item.status))) return null;
    const clean: PlanCompletionDetails = { steps: details.steps.map(item => ({ stepId: item.stepId, status: item.status })) };
    return { status: 409, code: error.code, details: clean, text: `PLAN_INCOMPLETE steps=${clean.steps.map(item => `${item.stepId}(${item.status})`).join('、')}：当前任务计划尚未闭合；继续完成真实工作。只有当前任务目标确实无法完成时，才先保存可用报告或证据再调用task_fail；独立评审得出不通过结论仍可正常提交真实评审报告。` };
  }
  return null;
}

function validateStartedVerification(stepId: string, requestedStatus: PlanStep['status'], previous: PlanStep | undefined, verification: PlanStep['verification']) {
  if (verification?.kind === 'tool' && verification.toolName && NON_COMPLETION_TOOLS.includes(verification.toolName as (typeof NON_COMPLETION_TOOLS)[number])) {
    throw new PlanUpdateError('PLAN_QUERY_VERIFICATION_FORBIDDEN', { stepId, invalidTool: verification.toolName,
      storedStatus: previous?.status ?? 'new', requestedStatus, verificationLocked: !!previous && previous.status !== 'pending' });
  }
}

function scope(chat: ChatRecord, task: AgentTask): Set<string> {
  const ids = new Set([task.id]); let changed = true;
  while (changed) { changed = false; for (const child of chat.tasks) if (child.parentTaskId && ids.has(child.parentTaskId) && !ids.has(child.id)) { ids.add(child.id); changed = true; } }
  return ids;
}
const sameMembers = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
/** A plan describes verifiable work; it never creates or schedules an AgentTask. */
export function updatePlan(chat: ChatRecord, task: AgentTask, raw: unknown) {
  if (isExecutionReviewTask(chat, task)) throw new HttpError(403, '独立执行评审子树在公共工作计划之外，不能修改工作步骤');
  const input = planInput.parse(raw);
  if (input.revision !== (chat.planRevision ?? 0)) throw new HttpError(409, '计划已变化，请先 plan_read 获取最新revision');
  const own = (chat.todos ?? []).filter(item => item.taskId === task.id);
  const rest = (chat.todos ?? []).filter(item => item.taskId !== task.id);
  const retryStepIds = new Set<string>();
  if (chat.pipeline?.stage === 'architecture' && task.parentTaskId && task.phase === 'demo' && task.role === 'sol' && task.mode === 'edit') {
    const failedAttempts = new Set(chat.tasks.filter(candidate => candidate.parentTaskId === task.parentTaskId &&
      candidate.turnId === task.turnId && candidate.phase === 'demo' && candidate.role === 'sol' &&
      candidate.mode === 'edit' && candidate.status === 'failed').map(candidate => candidate.id));
    for (const item of rest) if (failedAttempts.has(item.taskId)) retryStepIds.add(item.id);
  }
  // Keep historical steps intact and give the new Demo attempt its own stable IDs for reused names.
  const canonicalId = (id: string) => retryStepIds.has(id)
    ? `demo-${hash('sha256', JSON.stringify([task.id, id])).slice(0, 24)}` : id;
  const steps = retryStepIds.size ? input.steps.map(item => ({
    ...item, id: canonicalId(item.id), dependsOn: item.dependsOn?.map(canonicalId),
  })) : input.steps;
  if (new Set(steps.map(item => item.id)).size !== steps.length) throw new HttpError(400, '计划步骤ID重复');
  if (steps.some(item => rest.some(other => other.id === item.id))) throw new HttpError(409, '步骤ID已属于其他任务');
  const merged = new Map(own.map(item => [item.id, item]));
  const taskIds = scope(chat, task);
  const validEvidence = new Set([
    ...chat.artifacts.filter(item => taskIds.has(item.taskId)).flatMap(item => [item.id, item.relativePath, item.fileId].filter((v): v is string => !!v)),
    ...(chat.toolResults ?? []).filter(item => taskIds.has(item.taskId) && !NON_COMPLETION_TOOLS.includes(item.name as (typeof NON_COMPLETION_TOOLS)[number])).map(item => item.ref),
    ...chat.tasks.filter(item => taskIds.has(item.id) && item.status === 'completed' && item.resultRef).map(item => item.resultRef!),
  ]);
  const now = new Date().toISOString();
  for (const update of steps) {
    const previous = merged.get(update.id);
    const item = { ...update, dependsOn: update.dependsOn ?? previous?.dependsOn ?? [],
      linkedTaskIds: update.linkedTaskIds ?? previous?.linkedTaskIds ?? [], evidenceRefs: update.evidenceRefs ?? previous?.evidenceRefs ?? [] };
    const reviewers = chat.tasks.filter(candidate => candidate.executionReviewOfTaskId === task.id);
    const reviewerIds = new Set(reviewers.flatMap(candidate => [...scope(chat, candidate)]));
    const reviewerRefs = new Set([...chat.tasks.filter(candidate => reviewerIds.has(candidate.id)).flatMap(candidate => candidate.resultRef ? [candidate.resultRef] : []),
      ...chat.artifacts.filter(artifact => reviewerIds.has(artifact.taskId)).flatMap(artifact => [artifact.id, artifact.relativePath, artifact.fileId].filter((ref): ref is string => !!ref)),
      ...(chat.toolResults ?? []).filter(receipt => reviewerIds.has(receipt.taskId)).map(receipt => receipt.ref)]);
    if (item.linkedTaskIds.some(id => reviewerIds.has(id)) || item.evidenceRefs.some(ref => reviewerRefs.has(ref))) throw new HttpError(409, '独立执行评审在公共工作计划之外，不能作为工作步骤或其完成证据');
    if (previous && previous.status !== 'pending') {
      if (item.status === 'pending' || (['completed', 'failed'].includes(previous.status) && item.status !== previous.status)) throw new HttpError(409, '已开始步骤的状态不能回退，终态步骤不能重新打开');
      if (item.text !== previous.text) throw new HttpError(409, '已开始步骤的描述不能改写');
      if (!sameMembers(item.dependsOn, previous.dependsOn)) throw new HttpError(409, '已开始步骤的依赖定义不能改写');
      if (previous.linkedTaskIds.some(id => !item.linkedTaskIds.includes(id))) throw new HttpError(409, '已开始步骤不能移除已关联子任务');
      if (previous.evidenceRefs.some(ref => !item.evidenceRefs.includes(ref))) throw new HttpError(409, '已开始步骤不能移除已登记证据');
      if (['completed', 'failed'].includes(previous.status) && (!sameMembers(item.linkedTaskIds, previous.linkedTaskIds) || !sameMembers(item.evidenceRefs, previous.evidenceRefs))) throw new HttpError(409, '终态步骤的子任务和证据不能改写');
    }
    const verification = item.verification ?? previous?.verification;
    if (item.verification) validateStartedVerification(item.id, item.status, previous, item.verification);
    if (previous && previous.status !== 'pending' && item.verification && JSON.stringify(item.verification) !== JSON.stringify(previous.verification)) throw new HttpError(409, '已开始步骤的验收条件不能改写或补设');
    if (['in_progress','completed'].includes(item.status) && (!verification || (verification.kind === 'artifact' && !verification.name) || (verification.kind === 'tool' && !verification.toolName))) throw new HttpError(409, '开始步骤前必须设置完整验收条件verification');
    if (['in_progress','completed'].includes(item.status) && !item.verification) validateStartedVerification(item.id, item.status, previous, verification);
    if (item.linkedTaskIds.some(id => id === task.id || !taskIds.has(id))) throw new HttpError(403, '计划只能关联当前任务的子任务');
    if (item.evidenceRefs.some(ref => !validEvidence.has(ref))) throw new HttpError(403, '计划证据不属于当前任务或没有程序回执');
    const linked = chat.tasks.filter(t => item.linkedTaskIds.includes(t.id));
    if (item.status === 'completed' && linked.some(t => t.status !== 'completed')) throw new HttpError(409, '关联子任务尚未成功完成');
    if (item.status === 'completed' && !linked.length && !item.evidenceRefs.length) throw new HttpError(409, '完成步骤需要真实产物、工具回执或成功子任务');
    if (item.status === 'completed') {
      if (!verification) throw new HttpError(409, '计划步骤缺少可核验条件verification');
      if (verification.kind === 'artifact') {
        if (!verification.name) throw new HttpError(400, '产物验收必须指定准确name');
        const matches = chat.artifacts.filter(artifact => taskIds.has(artifact.taskId) && artifact.name === verification.name && artifact.bytes > 0 && item.evidenceRefs.some(ref => [artifact.id, artifact.fileId, artifact.relativePath].includes(ref)));
        if (!matches.length) throw new HttpError(409, '步骤要求的实际产物与证据不匹配');
      } else if (verification.kind === 'tool') {
        if (!verification.toolName) throw new HttpError(400, '工具验收必须指定准确toolName');
        if (!(chat.toolResults ?? []).some(receipt => taskIds.has(receipt.taskId) && receipt.name === verification.toolName && item.evidenceRefs.includes(receipt.ref))) throw new HttpError(409, '步骤要求的工具与证据不匹配');
      } else if (!linked.length || linked.some(child => child.status !== 'completed')) throw new HttpError(409, '任务验收需要关联成功子任务');
    }
    merged.set(item.id, { ...item, ...(verification ? { verification } : {}), taskId: task.id, updatedAt: now });
  }
  if (merged.size > 32) throw new HttpError(413, '每个任务最多32个计划步骤');
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new HttpError(400, '计划依赖不能形成循环');
    if (visited.has(id)) return;
    const item = merged.get(id); if (!item) throw new HttpError(400, '计划依赖不存在');
    visiting.add(id); for (const dependency of item.dependsOn) visit(dependency); visiting.delete(id); visited.add(id);
    const incompleteDependencies = item.dependsOn.map(dep => merged.get(dep)!).filter(dependency => dependency.status !== 'completed');
    if (['in_progress', 'completed'].includes(item.status) && incompleteDependencies.length) throw new PlanDependencyError({ stepId: item.id, requestedStatus: item.status, incompleteDependencies: incompleteDependencies.map(dependency => ({ stepId: dependency.id, status: dependency.status })) });
  };
  merged.forEach(item => visit(item.id));
  const used = new Map<string,string>();
  for (const item of merged.values()) if (item.status === 'completed') {
    const refs = [...item.linkedTaskIds.map(id => `task:${id}`), ...item.evidenceRefs.map(ref => {
      const artifact = chat.artifacts.find(artifact => [artifact.id,artifact.fileId,artifact.relativePath].includes(ref));
      if (artifact) return `artifact:${artifact.id}`;
      const resultTask = chat.tasks.find(task => task.resultRef === ref); return resultTask ? `task:${resultTask.id}` : `receipt:${ref}`;
    })];
    for (const ref of new Set(refs)) { if (used.has(ref) && used.get(ref) !== item.id) throw new HttpError(409, '同一证据不能重复完成不同计划步骤'); used.set(ref,item.id); }
  }
  chat.todos = [...rest, ...merged.values()]; chat.planRevision = input.revision + 1;
  return { revision: chat.planRevision, todos: chat.todos };
}
export function planCompletionIssues(chat: ChatRecord, task: AgentTask): string[] {
  return planCompletionDetails(chat, task).steps.map(step => `计划步骤未通过：${step.stepId}(${step.status})`);
}
export function planCompletionDetails(chat: ChatRecord, task: AgentTask): PlanCompletionDetails {
  const own = (chat.todos ?? []).filter(step => step.taskId === task.id);
  return { steps: own.filter(step => step.status !== 'completed' || step.linkedTaskIds.some(id => chat.tasks.find(child => child.id === id)?.status !== 'completed')).map(step => ({ stepId: step.id, status: step.status })) };
}
export function settlePlans(chat: ChatRecord, task: AgentTask) {
  if (!terminalTask(task.status) || task.status === 'completed') return;
  for (const step of chat.todos ?? []) if (step.taskId === task.id && step.status === 'in_progress') { step.status = 'failed'; step.updatedAt = new Date().toISOString(); }
}
