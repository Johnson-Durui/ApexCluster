import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { HttpError } from '../orchestrator/errors.js';
import { readSource, sourceCoverageIssues, sourcePlan } from './source-context.js';
import type { SessionFiles } from './session-files.js';
import type { ChatStore } from './store.js';
import { taskSeat } from './roster.js';
import { CHAT_LIMITS, terminalTask, type AgentTask, type ChatArtifact, type ChatEvent, type ChatRecord, type ExecutionReviewAttempt, type ExecutionReviewOutcome, type ResultReadPage } from './types.js';

const HASH = /^[a-f0-9]{64}$/;
export const NON_COMPLETION_TOOLS = [
  'plan_read', 'plan_update', 'task_state', 'task_evidence', 'result_read', 'execution_read', 'execution_submit_review',
  'user_source_list', 'user_source_read', 'file_list', 'session_file_list', 'grok_collect', 'grok_disposition', 'task_collect', 'task_disposition',
  'agent_submit', 'grok_submit', 'artifact_publish', 'task_yield', 'notes_write', 'task_complete', 'task_fail', 'ask_user',
] as const;
const QUERY_TOOLS = new Set<string>(NON_COMPLETION_TOOLS);
const READ_TOOLS = new Set(['document_read', 'image_read', 'session_file_read']);
const REVIEW_OUTCOMES = ['passed', 'failed', 'insufficient'] as const;

const reviewSchema = z.object({
  contractHash: z.string().regex(HASH),
  evidenceHash: z.string().regex(HASH),
  outcome: z.enum(REVIEW_OUTCOMES),
  stepVerdicts: z.array(z.object({ stepId: z.string().min(1).max(80), outcome: z.enum(REVIEW_OUTCOMES) }).strict()).max(32),
  reportArtifactId: z.string().min(1).max(200),
}).strict();

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  return value;
};
const canonical = (value: unknown) => JSON.stringify(sortValue(value));
const bounded = (issues: string[]) => [...new Set(issues)].slice(0, 8).map(issue => issue.slice(0, 240));
const sortedSet = (values: string[]) => [...new Set(values)].sort();

function descendants(chat: ChatRecord, parentId: string): AgentTask[] {
  const out: AgentTask[] = []; const queue = [parentId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const task of chat.tasks) if (task.parentTaskId === parent && !out.some(item => item.id === task.id)) { out.push(task); queue.push(task.id); }
  }
  return out;
}

export function isExecutionReviewTask(chat: ChatRecord, task: AgentTask): boolean {
  let current = chat.tasks.find(item => item.id === task.id); const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    if (current.executionReviewOfTaskId) return true;
    if (!current.parentTaskId) return false;
    current = chat.tasks.find(item => item.id === current!.parentTaskId);
  }
  return false;
}

function reviewerIds(chat: ChatRecord, root: AgentTask): Set<string> {
  return new Set(descendants(chat, root.id).filter(task => isExecutionReviewTask(chat, task)).map(task => task.id));
}

function workTasks(chat: ChatRecord, root: AgentTask): AgentTask[] {
  const excluded = reviewerIds(chat, root);
  return [root, ...descendants(chat, root.id)].filter(task => !excluded.has(task.id));
}

function workSteps(chat: ChatRecord, root: AgentTask) {
  return (chat.todos ?? []).filter(step => step.taskId === root.id);
}

function attemptReviewer(chat: ChatRecord, root: AgentTask, attempt: ExecutionReviewAttempt): AgentTask | undefined {
  const reviewer = chat.tasks.find(task => task.id === attempt.taskId);
  return reviewer && reviewer.parentTaskId === root.id && reviewer.executionReviewOfTaskId === root.id
    && taskSeat(chat, reviewer)?.can.acceptance && reviewer.mode === 'verify' ? reviewer : undefined;
}

export function executionRoot(chat: ChatRecord, task: AgentTask): AgentTask | undefined {
  const actual = chat.tasks.find(item => item.id === task.id);
  if (!actual) return undefined;
  if (actual.executionPolicyVersion === 1 && !actual.parentTaskId && !actual.executionReviewOfTaskId) return actual;
  if (!actual.executionReviewOfTaskId || !actual.parentTaskId || !taskSeat(chat, actual)?.can.acceptance || actual.mode !== 'verify') return undefined;
  const root = chat.tasks.find(item => item.id === actual.executionReviewOfTaskId);
  if (!root || root.executionPolicyVersion !== 1 || root.parentTaskId || actual.parentTaskId !== root.id) return undefined;
  return (root.executionReviewAttempts ?? []).some(attempt => attempt.taskId === actual.id) ? root : undefined;
}

export function latchExecutionReview(chat: ChatRecord, task: AgentTask): void {
  if (chat.team && !chat.team.requireAcceptanceReview) return;
  const root = executionRoot(chat, task) ?? (task.executionPolicyVersion === 1 && !task.parentTaskId ? task : undefined);
  if (!root || root.executionReviewRequired) return;
  const excluded = reviewerIds(chat, root);
  const nonReviewDescendant = descendants(chat, root.id).some(item => !excluded.has(item.id));
  const ownSteps = (chat.todos ?? []).filter(step => step.taskId === root.id);
  const formalArtifact = chat.artifacts.some(artifact => !excluded.has(artifact.taskId) && workTasks(chat, root).some(item => item.id === artifact.taskId));
  const generatedFile = (chat.attachments ?? []).some(file => file.source === 'generated' && file.taskId && !excluded.has(file.taskId)
    && workTasks(chat, root).some(item => item.id === file.taskId));
  if (ownSteps.length >= 2 || nonReviewDescendant || formalArtifact || generatedFile || root.segment >= 3) root.executionReviewRequired = true;
}

export function reviewerCanReadTask(chat: ChatRecord, reviewer: AgentTask, targetTaskId: string): boolean {
  const root = executionRoot(chat, reviewer);
  if (!root || reviewer.executionReviewOfTaskId !== root.id) return false;
  const allowed = new Set(workTasks(chat, root).map(task => task.id));
  return allowed.has(targetTaskId);
}

export function reviewReadinessIssues(chat: ChatRecord, root: AgentTask, store: ChatStore): string[] {
  if (executionRoot(chat, root)?.id !== root.id) return ['执行契约根任务无效'];
  const steps = workSteps(chat, root);
  const issues: string[] = [];
  if (!steps.length) issues.push('至少需要一个实际工作步骤');
  const rootDescendants = new Set(descendants(chat, root.id).map(task => task.id));
  for (const step of steps) {
    if (step.status !== 'completed') issues.push(`工作步骤尚未完成：${step.id}`);
    for (const linkedId of step.linkedTaskIds) {
      const linked = chat.tasks.find(task => task.id === linkedId);
      if (linkedId === root.id || !linked || !rootDescendants.has(linkedId) || isExecutionReviewTask(chat, linked)) issues.push(`工作步骤绑定无效：${step.id}:${linkedId}`);
    }
  }
  if (sourceCoverageIssues(chat, root, store).length) issues.push('根任务尚未核对完整用户来源');
  for (const task of workTasks(chat, root).filter(item => item.id !== root.id)) {
    if (!terminalTask(task.status)) issues.push(`子任务尚未收口：${task.id}`);
    if (task.status === 'interrupted') issues.push(`子任务处于不安全中断状态：${task.id}`);
    if (!task.disposition) issues.push(`子任务尚未处置：${task.id}`);
    if (task.invocationIds.some(id => { const invocation = chat.invocations.find(item => item.id === id); return !invocation || invocation.status !== 'exited' || invocation.exitConfirmed !== true; })) issues.push(`子任务退出状态未确认：${task.id}`);
    if (chat.unsafeProcesses?.some(process => process.taskId === task.id)) issues.push(`子任务仍有未确认进程：${task.id}`);
  }
  return bounded(issues);
}

function readRegisteredBlob(store: ChatStore, chat: ChatRecord, ref: string, expectedHash: string, expectedBytes?: number): Buffer {
  const bytes = store.readBlob(chat.id, ref);
  if (digest(bytes) !== expectedHash || (expectedBytes !== undefined && bytes.length !== expectedBytes)) throw new Error('registered blob changed');
  return bytes;
}

function relevantReceipts(chat: ChatRecord, taskIds: Set<string>) {
  const seenReads = new Set<string>();
  return (chat.toolResults ?? []).filter(item => taskIds.has(item.taskId) && !QUERY_TOOLS.has(item.name ?? '')).filter(item => {
    if (!READ_TOOLS.has(item.name ?? '')) return true;
    const key = `${item.taskId}\0${item.name}\0${item.hash}`;
    if (seenReads.has(key)) return false; seenReads.add(key); return true;
  });
}

export interface ExecutionView {
  contractHash: string; evidenceHash: string; viewRef: string; viewHash: string; viewBytes: number; viewText: string;
  stepIds: string[]; requiredRefs: { taskId: string; ref: string; hash: string; bytes?: number; kind: string; fileId?: string }[];
  sourceInputs: { id: string; name: string; hash: string; bytes: number; mime: string; messageIds: string[]; inputHashes: string[] }[];
  unresolvedEvidenceRefs: string[];
}

export function materializeExecutionView(chat: ChatRecord, root: AgentTask, store: ChatStore): ExecutionView {
  if (executionRoot(chat, root)?.id !== root.id) throw new HttpError(409, '执行契约根任务无效');
  const tasks = workTasks(chat, root); const taskIds = new Set(tasks.map(task => task.id));
  const steps = workSteps(chat, root);
  const sources = sourcePlan(chat, root, store).sources.map(source => ({ id: source.id, hash: source.hash, kind: source.kind, length: source.length, pages: source.pages }));
  const sourceMessageIds = new Set(sources.filter(source => source.kind === 'message').map(source => source.id));
  const sourceMessageOrder = new Map([...sourceMessageIds].map((id, index) => [id, index]));
  const sourceInputs = (chat.attachments ?? []).flatMap(file => {
    const messageIds = [...new Set((file.messageIds ?? []).filter(messageId => sourceMessageIds.has(messageId)))]
      .sort((left, right) => sourceMessageOrder.get(left)! - sourceMessageOrder.get(right)!);
    return messageIds.length ? [{ id: file.id, name: file.name, hash: file.hash, bytes: file.bytes, mime: file.mime,
      messageIds, inputHashes: sortedSet(file.inputHashes ?? []) }] : [];
  });
  const contract = {
    policyVersion: 1, rootTaskId: root.id, goal: root.goal, sources, sourceInputs,
    steps: steps.map(step => ({ id: step.id, taskId: step.taskId, text: step.text, dependsOn: sortedSet(step.dependsOn),
      linkedTaskIds: sortedSet(step.linkedTaskIds), verification: step.verification ?? null })),
    responsibilities: tasks.filter(task => task.id !== root.id).map(task => ({ id: task.id, parentTaskId: task.parentTaskId ?? null,
      role: task.role, goal: task.goal, mode: task.mode })),
  };
  const artifacts = chat.artifacts.filter(artifact => taskIds.has(artifact.taskId)
    && artifact.id !== chat.pipeline?.implementation?.trace?.artifactId).map(artifact => ({ id: artifact.id, taskId: artifact.taskId,
    name: artifact.name, relativePath: artifact.relativePath, hash: artifact.hash, bytes: artifact.bytes, kind: artifact.kind,
    provenance: artifact.provenance ?? null, fileId: artifact.fileId ?? null, mime: artifact.mime ?? null, inputHashes: sortedSet(artifact.inputHashes ?? []),
    binding: artifact.binding ? { beforeSnapshotId: artifact.binding.beforeSnapshotId, afterSnapshotId: artifact.binding.afterSnapshotId } : null,
    projectExport: artifact.projectExport ?? null }));
  for (const artifact of artifacts) if (!artifact.fileId && artifact.relativePath.startsWith('blobs/')) readRegisteredBlob(store, chat, artifact.relativePath, artifact.hash, artifact.bytes);
  const receipts = relevantReceipts(chat, taskIds).map(item => {
    if (item.ref.startsWith('blobs/')) readRegisteredBlob(store, chat, item.ref, item.hash, item.bytes);
    return { taskId: item.taskId, ref: item.ref, hash: item.hash, bytes: item.bytes, name: item.name ?? null, provenance: item.provenance ?? 'tool' };
  });
  const taskEvidence = tasks.filter(task => task.id !== root.id).map(task => ({ id: task.id, parentTaskId: task.parentTaskId ?? null, role: task.role,
    goal: task.goal, mode: task.mode, status: task.status, disposition: task.disposition ?? null, resultRef: task.resultRef ?? null,
    resultHash: task.resultHash ?? (task.result === undefined ? null : digest(task.result)), result: task.result ?? null,
    evidenceHashes: sortedSet(task.evidenceHashes ?? []), workspaceId: task.workspaceId ?? null, workspaceVersion: task.workspaceVersion ?? null,
    invocations: task.invocationIds.map(id => { const invocation = chat.invocations.find(item => item.id === id); return invocation
      ? { id, status: invocation.status, exitConfirmed: invocation.exitConfirmed ?? false, finishReason: invocation.finishReason ?? null,
          failurePhase: invocation.failurePhase ?? null }
      : { id, status: 'missing', exitConfirmed: false, finishReason: null, failurePhase: null }; }) }));
  for (const task of tasks) if (task.id !== root.id && task.resultRef && task.resultHash && task.resultRef.startsWith('blobs/')) readRegisteredBlob(store, chat, task.resultRef, task.resultHash);
  const evidence = { sourceRevision: chat.sourceRevisions?.[root.turnId] ?? 0, workspaceId: root.workspaceId ?? chat.workspaceId ?? null,
    workspaceVersion: root.workspaceVersion ?? null, tasks: taskEvidence, artifacts, receipts,
    stepEvidence: steps.map(step => ({ id: step.id, status: step.status, evidenceRefs: sortedSet(step.evidenceRefs) })) };
  const contractHash = digest(canonical(contract)); const evidenceHash = digest(canonical(evidence));
  const requiredRefs: ExecutionView['requiredRefs'] = [
    ...tasks.filter(task => task.id !== root.id && task.resultRef && task.resultHash).map(task => ({ taskId: task.id, ref: task.resultRef!, hash: task.resultHash!, kind: 'task-result' })),
    ...artifacts.map(artifact => ({ taskId: artifact.taskId, ref: artifact.relativePath, hash: artifact.hash, bytes: artifact.bytes,
      kind: artifact.fileId ? 'file' : 'artifact', ...(artifact.fileId ? { fileId: artifact.fileId } : {}) })),
    ...receipts.map(receipt => ({ taskId: receipt.taskId, ref: receipt.ref, hash: receipt.hash, bytes: receipt.bytes, kind: 'receipt' })),
    ...sourceInputs.map(file => ({ taskId: root.id, ref: `session:${file.id}`, hash: file.hash, bytes: file.bytes, kind: 'source-file', fileId: file.id })),
  ];
  const registeredAliases = new Set(requiredRefs.map(item => item.ref));
  for (const artifact of artifacts) { registeredAliases.add(artifact.id); if (artifact.fileId) registeredAliases.add(artifact.fileId); }
  const rootDescendants = new Set(descendants(chat, root.id).map(task => task.id));
  const invalidTaskBindings = steps.flatMap(step => step.linkedTaskIds).filter(linkedId => {
    const linked = chat.tasks.find(task => task.id === linkedId);
    return linkedId === root.id || !linked || !rootDescendants.has(linkedId) || isExecutionReviewTask(chat, linked);
  }).map(linkedId => `task:${linkedId}`);
  const unresolvedEvidenceRefs = [...new Set([
    ...steps.flatMap(step => step.evidenceRefs).filter(ref => !registeredAliases.has(ref)), ...invalidTaskBindings,
  ])].sort();
  const viewBody = { version: 1, contractHash, evidenceHash, contract, evidence, requiredRefs, unresolvedEvidenceRefs };
  const viewText = canonical(viewBody); const viewHash = digest(viewText); const name = `execution-${root.id}-${contractHash.slice(0, 16)}-${evidenceHash.slice(0, 16)}.json`;
  let viewRef: string;
  try { viewRef = store.putBlob(chat.id, name, viewText).relativePath; }
  catch (error) {
    const ref = `blobs/${name}`;
    try { const bytes = store.readBlob(chat.id, ref); if (digest(bytes) !== viewHash || bytes.toString('utf8') !== viewText) throw new Error('mismatch'); viewRef = ref; }
    catch { throw new HttpError(409, '既有执行视图内容校验失败'); }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return { contractHash, evidenceHash, viewRef, viewHash, viewBytes: Buffer.byteLength(viewText), viewText, stepIds: steps.map(step => step.id), requiredRefs, sourceInputs, unresolvedEvidenceRefs };
}

function allEvents(store: ChatStore, chatId: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (let since = 0;;) { const page = store.events(chatId, since, 500); events.push(...page.items); if (!page.hasMore) return events; since = page.next; }
}

function successfulToolEvent(events: ChatEvent[], task: AgentTask, name: string, toolCallId: string, beforeSeq: number,
  predicate: (event: ChatEvent, data: Record<string, unknown>) => boolean): boolean {
  const result = events.find(event => event.seq < beforeSeq && event.type === 'tool_result' && event.taskId === task.id
    && event.invocationId && event.data && typeof event.data === 'object' && (event.data as Record<string, unknown>).name === name
    && (event.data as Record<string, unknown>).toolCallId === toolCallId && predicate(event, event.data as Record<string, unknown>));
  if (!result) return false;
  return events.some(event => event.seq < result.seq && event.type === 'tool_started' && event.taskId === task.id
    && event.invocationId === result.invocationId && event.data && typeof event.data === 'object'
    && (event.data as Record<string, unknown>).name === name && (event.data as Record<string, unknown>).toolCallId === toolCallId);
}

/** Verify a complete read of one immutable result at the given authority. */
export function hasFullPageChain(task: AgentTask, ref: string, hash: string, baselineAuthority: string, events?: ChatEvent[], beforeSeq = Number.POSITIVE_INFINITY): boolean {
  const pages = (task.resultReadPages ?? []).filter(page => page.ref === ref && page.hash === hash && page.baselineAuthority === baselineAuthority);
  if (new Set(pages.map(page => page.offset)).size !== pages.length) return false;
  let offset: number | null = 0; const seen = new Set<number>();
  while (offset !== null) {
    if (seen.has(offset)) return false; seen.add(offset);
    const page: ResultReadPage | undefined = pages.find(item => item.offset === offset);
    if (!page || (page.next !== null && page.next <= page.offset)) return false;
    if (events && !successfulToolEvent(events, task, 'result_read', page.firstToolCallId, beforeSeq, (event, data) => {
      const delivered = data.readPage;
      return event.invocationId === page.firstInvocationId && !!delivered && typeof delivered === 'object' && (delivered as Record<string, unknown>).originalContentIncluded === true
        && (delivered as Record<string, unknown>).ref === page.ref && (delivered as Record<string, unknown>).hash === page.hash
        && (delivered as Record<string, unknown>).offset === page.offset && (delivered as Record<string, unknown>).next === page.next
        && (delivered as Record<string, unknown>).baselineAuthority === page.baselineAuthority;
    })) return false;
    offset = page.next;
  }
  return true;
}

function hasDurableReceipt(chat: ChatRecord, store: ChatStore, task: AgentTask, receipt: NonNullable<ChatRecord['toolResults']>[number],
  events?: ChatEvent[], beforeSeq = Number.POSITIVE_INFINITY): boolean {
  let expectedText: string;
  try { expectedText = readRegisteredBlob(store, chat, receipt.ref, receipt.hash, receipt.bytes).toString('utf8'); }
  catch { return false; }
  const callId = receipt.toolNumber === undefined ? undefined : `${receipt.invocationId}:${receipt.toolNumber}`;
  const indexed = events ?? allEvents(store, chat.id);
  if (!callId) return false;
  return successfulToolEvent(indexed, task, receipt.name ?? '', callId, beforeSeq, (_event, data) => data.text === expectedText);
}

interface ReadEnvelope { readFile: { fileId: string; hash: string; bytes: number; mime: string; offset: number; next: number | null; providerSourceHash?: string }; result: unknown }
function readEnvelope(store: ChatStore, chat: ChatRecord, receipt: NonNullable<ChatRecord['toolResults']>[number]): ReadEnvelope | undefined {
  if (!receipt.ref.startsWith('blobs/')) return undefined;
  try {
    const bytes = readRegisteredBlob(store, chat, receipt.ref, receipt.hash, receipt.bytes);
    const value = JSON.parse(bytes.toString('utf8')) as Partial<ReadEnvelope>;
    const file = value.readFile;
    if (!file || typeof file.fileId !== 'string' || typeof file.hash !== 'string' || typeof file.bytes !== 'number'
      || typeof file.mime !== 'string' || typeof file.offset !== 'number' || !(file.next === null || typeof file.next === 'number')) return undefined;
    return value as ReadEnvelope;
  } catch { return undefined; }
}

function receiptDelivered(chat: ChatRecord, store: ChatStore, reviewer: AgentTask, receipt: NonNullable<ChatRecord['toolResults']>[number], authority: string,
  events?: ChatEvent[], beforeSeq = Number.POSITIVE_INFINITY): boolean {
  let long: boolean;
  try { long = readRegisteredBlob(store, chat, receipt.ref, receipt.hash, receipt.bytes).toString('utf8').length > CHAT_LIMITS.toolText; }
  catch { return false; }
  if (long) return hasFullPageChain(reviewer, receipt.ref, receipt.hash, authority, events, beforeSeq);
  if (chat.apiRoster && !chat.invocations.find(item => item.id === receipt.invocationId)?.toolReceiptDeliveries
    ?.some(item => item.ref === receipt.ref && item.hash === receipt.hash && item.delivered)) return false;
  return hasDurableReceipt(chat, store, reviewer, receipt, events, beforeSeq);
}

function completeFileRead(chat: ChatRecord, reviewer: AgentTask, store: ChatStore, authority: string,
  file: { id: string; hash: string; bytes: number; mime: string }, allowedNames: Set<string>, events?: ChatEvent[], beforeSeq = Number.POSITIVE_INFINITY): boolean {
  const candidates = (chat.toolResults ?? []).filter(item => item.taskId === reviewer.id && allowedNames.has(item.name ?? '')).flatMap(receipt => {
    const envelope = readEnvelope(store, chat, receipt);
    if (!envelope || envelope.readFile.fileId !== file.id || envelope.readFile.hash !== file.hash || envelope.readFile.bytes !== file.bytes
      || envelope.readFile.mime !== file.mime || !receiptDelivered(chat, store, reviewer, receipt, authority, events, beforeSeq)) return [];
    if (receipt.name === 'document_read') {
      try {
        const provider = typeof envelope.result === 'string' ? JSON.parse(envelope.result) as { inputHashes?: unknown } : envelope.result as { inputHashes?: unknown };
        if (!Array.isArray(provider?.inputHashes) || !provider.inputHashes.includes(file.hash)) return [];
      } catch { return []; }
    }
    if (receipt.name === 'image_read' && envelope.readFile.providerSourceHash !== file.hash) return [];
    return [{ receipt, envelope }];
  });
  let offset: number | null = 0; const seen = new Set<number>();
  while (offset !== null) {
    if (seen.has(offset)) return false; seen.add(offset);
    const match = candidates.find(item => item.envelope.readFile.offset === offset);
    if (!match) return false;
    offset = match.envelope.readFile.next;
  }
  return true;
}

function fileInspectionIssues(chat: ChatRecord, reviewer: AgentTask, artifacts: ChatArtifact[], store: ChatStore, files: SessionFiles, authority: string,
  events?: ChatEvent[], beforeSeq = Number.POSITIVE_INFINITY): string[] {
  const issues: string[] = [];
  const inspected = new Set<string>();
  for (const artifact of artifacts.filter(item => item.fileId)) {
    let actual: ReturnType<SessionFiles['read']>;
    try { actual = files.read(chat, artifact.fileId!, true); }
    catch { issues.push(`正式文件字节校验失败：${artifact.id}`); continue; }
    if (actual.metadata.hash !== artifact.hash || actual.metadata.bytes !== artifact.bytes || (artifact.mime && actual.metadata.mime !== artifact.mime)
      || canonical(sortedSet(actual.metadata.inputHashes ?? [])) !== canonical(sortedSet(artifact.inputHashes ?? []))) {
      issues.push(`正式文件登记不一致：${artifact.id}`); continue;
    }
    const unsupported = actual.metadata.mime === 'application/octet-stream';
    const archive = actual.metadata.mime === 'application/zip';
    if (!archive) {
      const allowed = actual.metadata.mime.startsWith('image/') ? new Set(['image_read']) : new Set(['document_read', 'session_file_read']);
      if (!completeFileRead(chat, reviewer, store, authority, actual.metadata, allowed, events, beforeSeq)) issues.push(`评审未完整检查正式文件：${artifact.id}`);
      else inspected.add(artifact.hash);
    }
    if (unsupported) issues.push(`正式文件格式不可检查：${artifact.id}`);
    if (archive && !(artifact.inputHashes?.length)) issues.push(`压缩文件缺少可检查原件：${artifact.id}`);
  }
  for (const artifact of artifacts.filter(item => item.fileId && item.mime === 'application/zip')) {
    for (const inputHash of artifact.inputHashes ?? []) {
      const input = (chat.attachments ?? []).find(item => item.hash === inputHash);
      if (!input) { issues.push(`压缩文件原件未登记：${artifact.id}`); continue; }
      if (input.mime === 'application/octet-stream' || input.mime === 'application/zip') { issues.push(`压缩文件原件格式不可检查：${artifact.id}`); continue; }
      const allowed = input.mime.startsWith('image/') ? new Set(['image_read']) : new Set(['document_read', 'session_file_read']);
      try { files.read(chat, input.id, true); }
      catch { issues.push(`压缩文件原件字节校验失败：${artifact.id}`); continue; }
      if (!inspected.has(inputHash) && !completeFileRead(chat, reviewer, store, authority, input, allowed, events, beforeSeq)) issues.push(`压缩文件原件未检查：${artifact.id}`);
    }
  }
  return issues;
}

function sourceInputInspectionIssues(chat: ChatRecord, reviewer: AgentTask, sourceInputs: ExecutionView['sourceInputs'], store: ChatStore,
  files: SessionFiles, authority: string, events?: ChatEvent[], beforeSeq = Number.POSITIVE_INFINITY): string[] {
  const descriptors: ChatArtifact[] = sourceInputs.map(file => ({ id: `source:${file.id}`, taskId: reviewer.executionReviewOfTaskId ?? reviewer.id,
    name: file.name, relativePath: `files/source/${file.id}`, hash: file.hash, bytes: file.bytes, kind: 'file', createdAt: '',
    fileId: file.id, mime: file.mime, inputHashes: file.inputHashes }));
  return fileInspectionIssues(chat, reviewer, descriptors, store, files, authority, events, beforeSeq).map(issue => issue.replace('正式文件', '来源附件'));
}

function rejection(issues: string[]) {
  return { accepted: false as const, code: 'EXECUTION_REVIEW_REJECTED', issues: bounded(issues), next: 'execution_read' as const };
}

function actualReport(chat: ChatRecord, reviewer: AgentTask, artifactId: string, store: ChatStore): { artifact?: ChatArtifact; issue?: string } {
  const artifact = chat.artifacts.find(item => item.id === artifactId);
  if (!artifact || artifact.taskId !== reviewer.id || artifact.kind !== 'report' || artifact.bytes <= 0 || !artifact.relativePath.startsWith('blobs/')) return { issue: '评审报告必须是评审任务自有的非空 report artifact' };
  try { readRegisteredBlob(store, chat, artifact.relativePath, artifact.hash, artifact.bytes); }
  catch { return { issue: '评审报告实际字节或哈希已变化' }; }
  return { artifact };
}

function reportPublicationStart(events: ChatEvent[], reviewer: AgentTask, artifact: ChatArtifact): number | undefined {
  for (const result of events) {
    if (result.type !== 'tool_result' || result.taskId !== reviewer.id || !result.data || typeof result.data !== 'object') continue;
    const data = result.data as Record<string, unknown>;
    if (data.name !== 'artifact_publish' || typeof data.toolCallId !== 'string' || typeof data.text !== 'string') continue;
    let published: Record<string, unknown>;
    try { published = JSON.parse(data.text) as Record<string, unknown>; } catch { continue; }
    if (published.id !== artifact.id || published.hash !== artifact.hash || published.relativePath !== artifact.relativePath) continue;
    const started = events.find(event => event.seq < result.seq && event.type === 'tool_started' && event.taskId === reviewer.id
      && event.invocationId === result.invocationId && event.data && typeof event.data === 'object'
      && (event.data as Record<string, unknown>).name === 'artifact_publish'
      && (event.data as Record<string, unknown>).toolCallId === data.toolCallId);
    if (started) return started.seq;
  }
  return undefined;
}

function durableSourceIssues(chat: ChatRecord, reviewer: AgentTask, store: ChatStore, events: ChatEvent[], beforeSeq: number): string[] {
  const plan = sourcePlan(chat, reviewer, store);
  if (plan.inline) return [];
  const issues: string[] = [];
  for (const source of plan.sources) for (const offset of reviewer.sourceCoverage?.[source.id] ?? []) {
    let expected: ReturnType<typeof readSource>;
    try { expected = readSource(chat, reviewer, store, { sourceId: source.id, offset }); } catch { issues.push('评审来源交付记录无效'); continue; }
    const text = `来源 ${source.id}；offset=${offset}；next=${expected.next ?? '完成'}；SHA256=${expected.sourceHash}\n${expected.text}`;
    const result = events.find(event => event.seq < beforeSeq && event.type === 'tool_result' && event.taskId === reviewer.id
      && event.data && typeof event.data === 'object' && (event.data as Record<string, unknown>).name === 'user_source_read'
      && (event.data as Record<string, unknown>).text === text && typeof (event.data as Record<string, unknown>).toolCallId === 'string');
    const callId = result?.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>).toolCallId : undefined;
    if (!result || typeof callId !== 'string' || !successfulToolEvent(events, reviewer, 'user_source_read', callId, beforeSeq, event => event.seq === result.seq)) {
      issues.push('评审用户来源未在报告形成前完整交付');
    }
  }
  return bounded(issues);
}

function acceptedReviewIssues(chat: ChatRecord, root: AgentTask, reviewer: AgentTask, view: ExecutionView,
  review: { outcome: ExecutionReviewOutcome; stepVerdicts: { stepId: string; outcome: ExecutionReviewOutcome }[]; reportArtifactId: string; reportHash?: string },
  store: ChatStore, files: SessionFiles, authority: (task: AgentTask) => string): { issues: string[]; report?: ChatArtifact; events: ChatEvent[] } {
  const issues: string[] = [];
  const verdictIds = review.stepVerdicts.map(item => item.stepId); const expected = [...view.stepIds].sort();
  if (new Set(verdictIds).size !== verdictIds.length || canonical([...verdictIds].sort()) !== canonical(expected)) issues.push('逐步骤 verdict 必须唯一且精确覆盖全部工作步骤');
  if ((review.outcome === 'passed') !== review.stepVerdicts.every(item => item.outcome === 'passed')) issues.push('总体 verdict 与逐步骤 verdict 不一致');
  const report = actualReport(chat, reviewer, review.reportArtifactId, store); if (report.issue) issues.push(report.issue);
  if (report.artifact && review.reportHash && report.artifact.hash !== review.reportHash) issues.push('评审报告哈希已变化');
  const events = allEvents(store, chat.id);
  const reportStart = report.artifact ? reportPublicationStart(events, reviewer, report.artifact) : undefined;
  if (report.artifact && reportStart === undefined) issues.push('评审报告缺少真实发布事件');
  if (sourceCoverageIssues(chat, reviewer, store).length) issues.push('评审任务尚未核对完整用户来源');
  if (reportStart !== undefined) issues.push(...durableSourceIssues(chat, reviewer, store, events, reportStart));
  const reviewerAuthority = authority(reviewer);
  if (reportStart === undefined || !hasFullPageChain(reviewer, view.viewRef, view.viewHash, reviewerAuthority, events, reportStart)) issues.push('评审任务尚未在报告形成前完整读取当前执行视图');
  if (review.outcome === 'passed') {
    if (view.unresolvedEvidenceRefs.length) issues.push('工作步骤包含未登记的证据引用');
    const taskIds = new Set(workTasks(chat, root).map(task => task.id));
    for (const required of view.requiredRefs.filter(item => item.kind !== 'file' && item.kind !== 'source-file')) {
      if (reportStart === undefined || !hasFullPageChain(reviewer, required.ref, required.hash, reviewerAuthority, events, reportStart)) issues.push(`评审证据尚未在报告形成前完整读取：${required.ref}`);
    }
    issues.push(...fileInspectionIssues(chat, reviewer, chat.artifacts.filter(item => taskIds.has(item.taskId)), store, files, reviewerAuthority, events, reportStart));
    issues.push(...sourceInputInspectionIssues(chat, reviewer, view.sourceInputs, store, files, reviewerAuthority, events, reportStart));
  }
  return { issues: bounded(issues), report: report.artifact, events };
}

export function submitExecutionReview(chat: ChatRecord, reviewer: AgentTask, raw: unknown, store: ChatStore, files: SessionFiles,
  authority: (task: AgentTask) => string): { accepted: boolean; duplicate?: true; code?: string; issues?: string[]; next?: string } {
  const root = executionRoot(chat, reviewer);
  if (!root || reviewer.executionReviewOfTaskId !== root.id) {
    throw new HttpError(403, chat.team ? '仅绑定的独立验收评审任务可提交执行评审' : '仅绑定的 Astra verify 评审任务可提交执行评审');
  }
  const input = reviewSchema.parse(raw); const issues = reviewReadinessIssues(chat, root, store);
  let view: ExecutionView;
  try { view = materializeExecutionView(chat, root, store); }
  catch { return rejection(['当前执行视图或登记证据校验失败']); }
  const attempt = (root.executionReviewAttempts ?? []).find(item => item.taskId === reviewer.id);
  if (!attempt) return rejection(['当前评审任务没有固定的执行评审尝试']);
  if (attempt.contractHash !== input.contractHash || attempt.evidenceHash !== input.evidenceHash || attempt.viewRef !== view.viewRef || attempt.viewHash !== view.viewHash
    || view.contractHash !== input.contractHash || view.evidenceHash !== input.evidenceHash) issues.push('执行契约或证据已变化，请重新读取当前视图');
  const accepted = acceptedReviewIssues(chat, root, reviewer, view, input, store, files, authority);
  issues.push(...accepted.issues); const report = accepted.report;
  if (attempt.review) {
    const exact = attempt.review.outcome === input.outcome && attempt.review.reportArtifactId === input.reportArtifactId
      && attempt.review.reportHash === report?.hash && canonical([...attempt.review.stepVerdicts].sort((a,b) => a.stepId.localeCompare(b.stepId)))
      === canonical([...input.stepVerdicts].sort((a,b) => a.stepId.localeCompare(b.stepId)));
    return exact && !issues.length ? { accepted: true, duplicate: true } : rejection(['当前执行评审已经提交，不能覆盖']);
  }
  if (issues.length || !report) return rejection(issues);
  attempt.review = { outcome: input.outcome, stepVerdicts: [...input.stepVerdicts].sort((a,b) => a.stepId.localeCompare(b.stepId)),
    reportArtifactId: report.id, reportHash: report.hash, submittedAt: new Date().toISOString() };
  return { accepted: true };
}

function safeReviewer(chat: ChatRecord, reviewer: AgentTask): boolean {
  return reviewer.status === 'completed' && reviewer.disposition === 'adopted' && reviewer.invocationIds.length > 0 && reviewer.invocationIds.every(id => {
    const invocation = chat.invocations.find(item => item.id === id); return !!invocation && invocation.status === 'exited' && invocation.exitConfirmed === true;
  });
}

export function executionCompletionIssues(chat: ChatRecord, task: AgentTask, store: ChatStore, files: SessionFiles,
  authority: (task: AgentTask) => string): string[] {
  const root = executionRoot(chat, task);
  if (!root) return [];
  if (task.id !== root.id) {
    const attempt = (root.executionReviewAttempts ?? []).find(item => item.taskId === task.id);
    return attempt?.review ? [] : ['评审任务必须先提交 execution review；无法提交时使用 task_fail'];
  }
  if (!root.executionReviewRequired) return [];
  const issues = reviewReadinessIssues(chat, root, store);
  let view: ExecutionView;
  try { view = materializeExecutionView(chat, root, store); } catch { return bounded([...issues, '当前执行视图或登记证据校验失败']); }
  const attempt = root.executionReviewAttempts?.at(-1);
  if (!attempt?.review || attempt.contractHash !== view.contractHash || attempt.evidenceHash !== view.evidenceHash) return bounded([...issues, '当前执行契约尚无评审结果']);
  if (attempt.viewRef !== view.viewRef || attempt.viewHash !== view.viewHash) issues.push('当前评审视图已失效');
  if (attempt.review.outcome !== 'passed') issues.push('当前执行评审未通过');
  const reviewer = attemptReviewer(chat, root, attempt);
  if (!reviewer || !safeReviewer(chat, reviewer)) {
    issues.push(chat.team
      ? (reviewer ? `独立评审席位（${reviewer.role}）评审任务尚未安全完成并由根任务采用` : '独立评审任务尚未安全完成并由根任务采用')
      : 'Astra 评审任务尚未安全完成并由根任务采用');
  }
  if (reviewer) {
    const accepted = acceptedReviewIssues(chat, root, reviewer, view, attempt.review, store, files, authority);
    issues.push(...accepted.issues);
    if (accepted.report && !hasFullPageChain(root, accepted.report.relativePath, accepted.report.hash, authority(root), accepted.events)) issues.push('根任务尚未完整读取当前评审报告');
  }
  return bounded(issues);
}
