import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { HttpError } from '../src/orchestrator/errors.js';
import {
  executionCompletionIssues, executionRoot, latchExecutionReview, materializeExecutionView,
  isExecutionReviewTask, reviewerCanReadTask, reviewReadinessIssues, submitExecutionReview,
} from '../src/chat/execution.js';
import { SessionFiles } from '../src/chat/session-files.js';
import { readSource, sourcePlan } from '../src/chat/source-context.js';
import { ChatStore } from '../src/chat/store.js';
import { CHAT_LIMITS, type AgentTask, type ChatRecord, type ResultReadPage } from '../src/chat/types.js';

const base = path.resolve('work/test-tmp/chat-execution');
mkdirSync(base, { recursive: true });
const temporaryDirectories = new Set<string>();
afterEach(() => {
  for (const directory of temporaryDirectories) {
    assert.equal(path.dirname(directory), base); assert.ok(path.basename(directory).startsWith('case-'));
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});
const authority = (task: AgentTask) => `authority:${task.id}`;

function task(id: string, role: AgentTask['role'], extra: Partial<AgentTask> = {}): AgentTask {
  return {
    id, turnId: 'turn-1', role, goal: `${id} goal`, status: 'running', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read', ...extra,
  };
}

function fixture() {
  const directory = mkdtempSync(path.join(base, 'case-')); temporaryDirectories.add(directory);
  const store = new ChatStore(directory); const chat = store.create();
  const message = store.appendMessage(chat, { role: 'user', text: '完成一项可验证的长任务', turnId: 'turn-1', clientMessageId: 'm1' });
  const root = task('root', 'claude', { goal: message.text, executionPolicyVersion: 1, mode: 'edit' });
  chat.tasks.push(root); chat.turns.push({ id: 'turn-1', rootTaskId: root.id, status: 'running', createdAt: root.createdAt });
  chat.todos = [
    { id: 'prepare', taskId: root.id, text: '准备', status: 'completed', dependsOn: [], linkedTaskIds: [], evidenceRefs: [], updatedAt: root.updatedAt },
    { id: 'verify', taskId: root.id, text: '验证', status: 'completed', dependsOn: ['prepare'], linkedTaskIds: [], evidenceRefs: [], updatedAt: root.updatedAt },
  ];
  store.save(chat); return { directory, store, chat, root, message, files: new SessionFiles(store) };
}

function page(task: AgentTask, ref: string, hash: string): ResultReadPage {
  const invocationId = task.invocationIds[0] ?? `${task.id}-inv`;
  return { ref, hash, offset: 0, next: null, workspaceId: null, workspaceVersion: null, sourceRevision: 0,
    baselineAuthority: authority(task), coverageIndex: 0, firstInvocationId: invocationId, firstToolCallId: `${invocationId}:1` };
}

function registerResultRead(fx: ReturnType<typeof fixture>, owner: AgentTask, ref: string, hash: string, next: number|null = null) {
  const invocationId = owner.invocationIds[0] ?? `${owner.id}-inv`; const toolNumber = fx.chat.seq + 100; const toolCallId = `${invocationId}:${toolNumber}`;
  const delivered = { ...page(owner, ref, hash), next, firstInvocationId: invocationId, firstToolCallId: toolCallId,
    coverageIndex: owner.resultReadPages?.length ?? 0 };
  (owner.resultReadPages ??= []).push(delivered);
  fx.store.appendEvent(fx.chat, { type: 'tool_started', taskId: owner.id, invocationId, turnId: owner.turnId, parentTaskId: owner.parentTaskId,
    data: { name: 'result_read', toolCallId } });
  fx.store.appendEvent(fx.chat, { type: 'tool_result', taskId: owner.id, invocationId, turnId: owner.turnId, parentTaskId: owner.parentTaskId,
    data: { name: 'result_read', toolCallId, text: 'delivered', readPage: { alreadyProvided: false, originalContentIncluded: true,
      ref, hash, offset: 0, next, baselineAuthority: authority(owner), coverageIndex: delivered.coverageIndex,
      firstInvocationId: invocationId, firstToolCallId: toolCallId } } });
  fx.store.save(fx.chat); return delivered;
}

function publishReviewReport(fx: ReturnType<typeof fixture>, reviewer: AgentTask, suffix = String(fx.chat.seq)) {
  const reportBlob = fx.store.putBlob(fx.chat.id, `${reviewer.id}-report-${suffix}.txt`, '独立评审报告：工作证据与步骤一致。');
  const report = { id: `report-${suffix}`, taskId: reviewer.id, name: `review-${suffix}.txt`, relativePath: reportBlob.relativePath,
    hash: reportBlob.hash, bytes: reportBlob.bytes, kind: 'report' as const, createdAt: reviewer.createdAt };
  const invocationId = reviewer.invocationIds[0]!; const toolCallId = `${invocationId}:${fx.chat.seq + 100}`;
  fx.store.appendEvent(fx.chat, { type: 'tool_started', taskId: reviewer.id, invocationId, turnId: reviewer.turnId,
    parentTaskId: reviewer.parentTaskId, data: { name: 'artifact_publish', toolCallId } });
  fx.chat.artifacts.push(report);
  fx.store.appendEvent(fx.chat, { type: 'tool_result', taskId: reviewer.id, invocationId, turnId: reviewer.turnId,
    parentTaskId: reviewer.parentTaskId, data: { name: 'artifact_publish', toolCallId, text: JSON.stringify(report) } });
  fx.store.save(fx.chat); return report;
}

function coverSources(fx: ReturnType<typeof fixture>, owner: AgentTask, durable: boolean) {
  for (const source of sourcePlan(fx.chat, owner, fx.store).sources) {
    let offset: number|null = 0;
    while (offset !== null) {
      const delivered = readSource(fx.chat, owner, fx.store, { sourceId: source.id, offset });
      (owner.sourceCoverageHashes ??= {})[source.id] = delivered.sourceHash;
      ((owner.sourceCoverage ??= {})[source.id] ??= []).push(offset);
      if (durable) {
        const invocationId = owner.invocationIds[0]!; const toolCallId = `${invocationId}:${fx.chat.seq + 100}`;
        const text = `来源 ${source.id}；offset=${offset}；next=${delivered.next ?? '完成'}；SHA256=${delivered.sourceHash}\n${delivered.text}`;
        fx.store.appendEvent(fx.chat, { type: 'tool_started', taskId: owner.id, invocationId, turnId: owner.turnId,
          parentTaskId: owner.parentTaskId, data: { name: 'user_source_read', toolCallId } });
        fx.store.appendEvent(fx.chat, { type: 'tool_result', taskId: owner.id, invocationId, turnId: owner.turnId,
          parentTaskId: owner.parentTaskId, data: { name: 'user_source_read', toolCallId, text } });
      }
      offset = delivered.next;
    }
  }
  fx.store.save(fx.chat);
}

function bindReviewer(fx: ReturnType<typeof fixture>) {
  const before = materializeExecutionView(fx.chat, fx.root, fx.store);
  const reviewer = task('reviewer', 'astra', { parentTaskId: fx.root.id, executionReviewOfTaskId: fx.root.id, mode: 'verify' });
  reviewer.invocationIds = ['reviewer-inv'];
  fx.chat.invocations.push({ id: 'reviewer-inv', taskId: reviewer.id, segment: 1, status: 'exited', startedAt: reviewer.createdAt,
    endedAt: reviewer.createdAt, toolCount: 1, promptVersion: 'test', inputEstimate: 1, contextWindow: null, contextUsed: null, exitConfirmed: true });
  fx.chat.tasks.push(reviewer);
  fx.root.executionReviewAttempts = [{ taskId: reviewer.id, contractHash: before.contractHash, evidenceHash: before.evidenceHash,
    viewRef: before.viewRef, viewHash: before.viewHash, createdAt: reviewer.createdAt }];
  const view = materializeExecutionView(fx.chat, fx.root, fx.store);
  registerResultRead(fx, reviewer, view.viewRef, view.viewHash);
  const report = publishReviewReport(fx, reviewer, 'initial');
  return { reviewer, view, report };
}

function reviewInput(view: ReturnType<typeof materializeExecutionView>, reportId: string, outcome: 'passed'|'failed'|'insufficient' = 'passed') {
  return { contractHash: view.contractHash, evidenceHash: view.evidenceHash, outcome, reportArtifactId: reportId,
    stepVerdicts: view.stepIds.map(stepId => ({ stepId, outcome })) };
}

function registerTypedRead(fx: ReturnType<typeof fixture>, reviewer: AgentTask, file: NonNullable<ChatRecord['attachments']>[number],
  name: 'document_read'|'image_read'|'session_file_read', options: { providerSourceHash?: string; inputHashes?: string[]; next?: number|null; resultContent?: string } = {}) {
  const toolNumber = (fx.chat.toolResults?.length ?? 0) + 10;
  const text = JSON.stringify({ readFile: { fileId: file.id, hash: file.hash, bytes: file.bytes, mime: file.mime, offset: 0,
    next: options.next ?? null, ...(options.providerSourceHash === undefined ? {} : { providerSourceHash: options.providerSourceHash }) },
    result: JSON.stringify({ inputHashes: options.inputHashes ?? [], ...(options.resultContent === undefined ? {} : { content: options.resultContent }) }) });
  const blob = fx.store.putBlob(fx.chat.id, `typed-${file.id}-${toolNumber}.json`, text);
  (fx.chat.toolResults ??= []).push({ taskId: reviewer.id, invocationId: 'reviewer-inv', ref: blob.relativePath, hash: blob.hash,
    bytes: blob.bytes, name, toolNumber, provenance: 'tool' });
  fx.store.appendEvent(fx.chat, { type: 'tool_started', taskId: reviewer.id, invocationId: 'reviewer-inv', turnId: reviewer.turnId,
    parentTaskId: reviewer.parentTaskId, data: { name, toolCallId: `reviewer-inv:${toolNumber}` } });
  fx.store.appendEvent(fx.chat, { type: 'tool_result', taskId: reviewer.id, invocationId: 'reviewer-inv', turnId: reviewer.turnId,
    parentTaskId: reviewer.parentTaskId, data: { name, toolCallId: `reviewer-inv:${toolNumber}`, text } });
  fx.store.save(fx.chat);
}

test('v1 latch is monotonic and legacy tasks are never upgraded', () => {
  const fx = fixture(); const legacy = task('legacy', 'claude'); fx.chat.tasks.push(legacy);
  latchExecutionReview(fx.chat, fx.root); assert.equal(fx.root.executionReviewRequired, true);
  fx.chat.todos = []; latchExecutionReview(fx.chat, fx.root); assert.equal(fx.root.executionReviewRequired, true);
  latchExecutionReview(fx.chat, legacy); assert.equal(legacy.executionPolicyVersion, undefined); assert.equal(legacy.executionReviewRequired, undefined);
});

test('reviewer binding exposes only the root non-review subtree', () => {
  const fx = fixture(); const child = task('child', 'sol', { parentTaskId: fx.root.id, status: 'completed', disposition: 'adopted' });
  const foreign = task('foreign', 'sol'); fx.chat.tasks.push(child, foreign);
  const { reviewer } = bindReviewer(fx); const nestedReview = task('review-child', 'grok', { parentTaskId: reviewer.id }); fx.chat.tasks.push(nestedReview);
  assert.equal(executionRoot(fx.chat, reviewer), fx.root);
  assert.equal(reviewerCanReadTask(fx.chat, reviewer, fx.root.id), true);
  assert.equal(reviewerCanReadTask(fx.chat, reviewer, child.id), true);
  assert.equal(reviewerCanReadTask(fx.chat, reviewer, reviewer.id), false);
  assert.equal(reviewerCanReadTask(fx.chat, reviewer, nestedReview.id), false);
  assert.equal(reviewerCanReadTask(fx.chat, reviewer, foreign.id), false);
});

test('review descendants and malformed review markers cannot satisfy root work bindings', () => {
  const fx = fixture(); const { reviewer } = bindReviewer(fx);
  const reviewGrandchild = task('review-grandchild', 'sol', { parentTaskId: reviewer.id, status: 'completed', disposition: 'adopted' });
  const malformed = task('malformed-review', 'sol', { parentTaskId: fx.root.id, executionReviewOfTaskId: 'missing-root', status: 'completed', disposition: 'adopted' });
  fx.chat.tasks.push(reviewGrandchild, malformed);
  fx.chat.todos![0]!.linkedTaskIds = [reviewGrandchild.id, malformed.id, 'missing-task'];
  assert.equal(isExecutionReviewTask(fx.chat, reviewGrandchild), true);
  assert.equal(isExecutionReviewTask(fx.chat, malformed), true);
  const issues = reviewReadinessIssues(fx.chat, fx.root, fx.store);
  assert.ok(issues.some(issue => issue.includes(`prepare:${reviewGrandchild.id}`)));
  assert.ok(issues.some(issue => issue.includes(`prepare:${malformed.id}`)));
  const view = materializeExecutionView(fx.chat, fx.root, fx.store);
  assert.deepEqual(view.unresolvedEvidenceRefs, ['task:malformed-review', 'task:missing-task', 'task:review-grandchild']);
});

test('a real non-review root descendant remains a valid work binding', () => {
  const fx = fixture(); const child = task('work-child', 'sol', { parentTaskId: fx.root.id, status: 'completed', disposition: 'adopted' });
  fx.chat.tasks.push(child); fx.chat.todos![0]!.linkedTaskIds = [child.id];
  assert.equal(isExecutionReviewTask(fx.chat, child), false);
  assert.equal(reviewReadinessIssues(fx.chat, fx.root, fx.store).some(issue => issue.includes('绑定无效')), false);
  assert.deepEqual(materializeExecutionView(fx.chat, fx.root, fx.store).unresolvedEvidenceRefs, []);
});

test('canonical execution view is deterministic and query-only changes do not change hashes', () => {
  const fx = fixture(); const first = materializeExecutionView(fx.chat, fx.root, fx.store);
  fx.chat.toolResults = [{ taskId: fx.root.id, invocationId: 'inv', ref: first.viewRef, hash: first.viewHash,
    bytes: first.viewBytes, name: 'execution_read', toolNumber: 1, provenance: 'tool' }];
  fx.root.segment = 8; fx.root.updatedAt = '2030-01-01T00:00:00.000Z'; fx.root.status = 'waiting_children';
  const second = materializeExecutionView(fx.chat, fx.root, fx.store);
  assert.deepEqual({ contract: second.contractHash, evidence: second.evidenceHash, ref: second.viewRef, hash: second.viewHash, text: second.viewText },
    { contract: first.contractHash, evidence: first.evidenceHash, ref: first.viewRef, hash: first.viewHash, text: first.viewText });
});

test('declared evidence accepts every registered artifact identity alias', () => {
  const fx = fixture(); const blob = fx.store.putBlob(fx.chat.id, 'alias-proof.txt', 'proof');
  fx.chat.artifacts.push({ id: 'artifact-alias', taskId: fx.root.id, name: 'proof.txt', ...blob, kind: 'report', createdAt: fx.root.createdAt });
  fx.chat.todos![0]!.evidenceRefs = ['artifact-alias'];
  assert.deepEqual(materializeExecutionView(fx.chat, fx.root, fx.store).unresolvedEvidenceRefs, []);
});

test('formal file directory carries fileId and rejects attachment lineage drift', () => {
  const fx = fixture(); const inputHash = 'a'.repeat(64);
  const batch = fx.files.publishArtifacts(fx.chat, fx.root.id, 'root-inv', [{ name: 'lineage.txt', bytes: Buffer.from('lineage'), inputHashes: [inputHash] }]);
  const file = batch.files[0]!; const artifact = batch.artifacts[0]!;
  const bound = bindReviewer(fx);
  assert.equal(bound.view.requiredRefs.find(item => item.ref === artifact.relativePath)?.fileId, file.id);
  file.inputHashes = ['b'.repeat(64)];
  const reply = submitExecutionReview(fx.chat, bound.reviewer, reviewInput(bound.view, bound.report.id), fx.store, fx.files, authority);
  assert.equal(reply.accepted, false); assert.ok(reply.issues?.some(issue => issue.includes('登记不一致')));
});

test('project export host metadata participates in the canonical evidence hash', () => {
  const fx = fixture(); const blob = fx.store.putBlob(fx.chat.id, 'exported.txt', 'exported');
  fx.chat.artifacts.push({ id: 'exported', taskId: fx.root.id, name: 'exported.txt', ...blob, kind: 'file', createdAt: fx.root.createdAt,
    projectExport: { status: 'saved', path: 'C:\\workspace\\agent-outputs\\chat\\exported.txt', relativePath: 'agent-outputs/chat/exported.txt', workspaceId: 'ws', version: 1, hash: blob.hash } });
  const before = materializeExecutionView(fx.chat, fx.root, fx.store);
  fx.chat.artifacts.at(-1)!.projectExport = { status: 'failed', error: 'copy verification failed' };
  const after = materializeExecutionView(fx.chat, fx.root, fx.store);
  assert.notEqual(after.evidenceHash, before.evidenceHash);
});

test('review submission is hash-bound, exact-covering, immutable and idempotent', () => {
  const fx = fixture(); latchExecutionReview(fx.chat, fx.root); const { reviewer, view, report } = bindReviewer(fx);
  assert.deepEqual(reviewReadinessIssues(fx.chat, fx.root, fx.store), []);
  const raw = { contractHash: view.contractHash, evidenceHash: view.evidenceHash, outcome: 'passed', reportArtifactId: report.id,
    stepVerdicts: view.stepIds.map(stepId => ({ stepId, outcome: 'passed' as const })) };
  assert.deepEqual(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority), { accepted: true });
  const submittedAt = fx.root.executionReviewAttempts![0]!.review!.submittedAt;
  assert.deepEqual(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority), { accepted: true, duplicate: true });
  assert.equal(fx.root.executionReviewAttempts![0]!.review!.submittedAt, submittedAt);
  const changed = submitExecutionReview(fx.chat, reviewer, { ...raw, outcome: 'failed', stepVerdicts: raw.stepVerdicts.map(item => ({ ...item, outcome: 'failed' as const })) }, fx.store, fx.files, authority);
  assert.equal(changed.accepted, false); assert.equal(changed.code, 'EXECUTION_REVIEW_REJECTED'); assert.equal(changed.next, 'execution_read');
  const outsider = task('outsider', 'astra', { mode: 'verify' }); fx.chat.tasks.push(outsider);
  assert.throws(() => submitExecutionReview(fx.chat, outsider, raw, fx.store, fx.files, authority), (error: unknown) => error instanceof HttpError && error.status === 403);
});

test('pure reordering of set-valued metadata cannot manufacture a new review hash after a negative receipt', () => {
  const fx = fixture();
  const childA = task('child-a', 'sol', { parentTaskId: fx.root.id, status: 'completed', disposition: 'adopted', evidenceHashes: ['b'.repeat(64), 'a'.repeat(64)] });
  const childB = task('child-b', 'grok', { parentTaskId: fx.root.id, status: 'completed', disposition: 'reference' }); fx.chat.tasks.push(childA, childB);
  const first = fx.store.putBlob(fx.chat.id, 'set-first.txt', 'first'); const second = fx.store.putBlob(fx.chat.id, 'set-second.txt', 'second');
  fx.chat.artifacts.push(
    { id: 'set-first', taskId: fx.root.id, name: 'first.txt', ...first, kind: 'report', createdAt: fx.root.createdAt, inputHashes: ['d'.repeat(64), 'c'.repeat(64)] },
    { id: 'set-second', taskId: fx.root.id, name: 'second.txt', ...second, kind: 'test', createdAt: fx.root.createdAt },
  );
  fx.chat.todos![1]!.dependsOn = ['other', 'prepare']; fx.chat.todos![1]!.linkedTaskIds = [childB.id, childA.id];
  fx.chat.todos![1]!.evidenceRefs = [second.relativePath, first.relativePath];
  const bound = bindReviewer(fx); const raw = reviewInput(bound.view, bound.report.id, 'insufficient');
  assert.deepEqual(submitExecutionReview(fx.chat, bound.reviewer, raw, fx.store, fx.files, authority), { accepted: true });
  const submittedAt = fx.root.executionReviewAttempts![0]!.review!.submittedAt;
  fx.chat.todos![1]!.dependsOn.reverse(); fx.chat.todos![1]!.linkedTaskIds.reverse(); fx.chat.todos![1]!.evidenceRefs.reverse();
  childA.evidenceHashes!.reverse(); fx.chat.artifacts[0]!.inputHashes!.reverse();
  const reordered = materializeExecutionView(fx.chat, fx.root, fx.store);
  assert.deepEqual([reordered.contractHash, reordered.evidenceHash, reordered.viewHash, reordered.viewRef],
    [bound.view.contractHash, bound.view.evidenceHash, bound.view.viewHash, bound.view.viewRef]);
  assert.deepEqual(submitExecutionReview(fx.chat, bound.reviewer, raw, fx.store, fx.files, authority), { accepted: true, duplicate: true });
  assert.equal(fx.root.executionReviewAttempts![0]!.review!.submittedAt, submittedAt);
});

test('root completion requires safe adopted reviewer and root-owned full report read chain', () => {
  const fx = fixture(); latchExecutionReview(fx.chat, fx.root); const { reviewer, view, report } = bindReviewer(fx);
  const raw = { contractHash: view.contractHash, evidenceHash: view.evidenceHash, outcome: 'passed', reportArtifactId: report.id,
    stepVerdicts: view.stepIds.map(stepId => ({ stepId, outcome: 'passed' as const })) };
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, true);
  reviewer.status = 'completed'; reviewer.disposition = 'adopted';
  assert.ok(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority).some(issue => issue.includes('评审报告')));
  registerResultRead(fx, fx.root, report.relativePath, report.hash);
  assert.deepEqual(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority), []);
  reviewer.resultReadPages = [];
  assert.ok(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority).some(issue => issue.includes('执行视图')));
});

test('reviewer may complete after a negative review but the root remains blocked', () => {
  const fx = fixture(); latchExecutionReview(fx.chat, fx.root); const { reviewer, view, report } = bindReviewer(fx);
  const raw = { contractHash: view.contractHash, evidenceHash: view.evidenceHash, outcome: 'insufficient', reportArtifactId: report.id,
    stepVerdicts: view.stepIds.map(stepId => ({ stepId, outcome: 'insufficient' as const })) };
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, true);
  assert.deepEqual(executionCompletionIssues(fx.chat, reviewer, fx.store, fx.files, authority), []);
  reviewer.status = 'completed'; reviewer.disposition = 'adopted'; registerResultRead(fx, fx.root, report.relativePath, report.hash);
  assert.ok(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority).some(issue => issue.includes('未通过')));
});

test('root final gate revalidates every required blob delivery event', () => {
  const fx = fixture(); latchExecutionReview(fx.chat, fx.root); const proof = fx.store.putBlob(fx.chat.id, 'required-proof.txt', 'required proof');
  fx.chat.artifacts.push({ id: 'required-proof', taskId: fx.root.id, name: 'proof.txt', ...proof, kind: 'report', createdAt: fx.root.createdAt });
  fx.chat.todos![0]!.evidenceRefs = [proof.relativePath];
  const bound = bindReviewer(fx);
  registerResultRead(fx, bound.reviewer, proof.relativePath, proof.hash);
  assert.equal(submitExecutionReview(fx.chat, bound.reviewer, reviewInput(bound.view, bound.report.id), fx.store, fx.files, authority).accepted, false);
  const report = publishReviewReport(fx, bound.reviewer, 'required-after-read');
  assert.equal(submitExecutionReview(fx.chat, bound.reviewer, reviewInput(bound.view, report.id), fx.store, fx.files, authority).accepted, true);
  bound.reviewer.status = 'completed'; bound.reviewer.disposition = 'adopted'; registerResultRead(fx, fx.root, report.relativePath, report.hash);
  assert.deepEqual(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority), []);
  bound.reviewer.resultReadPages = bound.reviewer.resultReadPages!.filter(item => item.ref !== proof.relativePath);
  assert.ok(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority).length > 0);
});

test('root final gate revalidates durable non-inline source coverage', () => {
  const fx = fixture(); latchExecutionReview(fx.chat, fx.root); fx.store.appendMessage(fx.chat, { role: 'user', text: '长来源'.repeat(5_000), turnId: fx.root.turnId, clientMessageId: 'long-source' });
  coverSources(fx, fx.root, false);
  const bound = bindReviewer(fx); coverSources(fx, bound.reviewer, true);
  const report = publishReviewReport(fx, bound.reviewer, 'sources-after-read');
  assert.equal(submitExecutionReview(fx.chat, bound.reviewer, reviewInput(bound.view, report.id), fx.store, fx.files, authority).accepted, true);
  bound.reviewer.status = 'completed'; bound.reviewer.disposition = 'adopted'; registerResultRead(fx, fx.root, report.relativePath, report.hash);
  assert.deepEqual(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority), []);
  const sourceId = sourcePlan(fx.chat, bound.reviewer, fx.store).sources[0]!.id;
  bound.reviewer.sourceCoverage![sourceId]!.shift();
  assert.ok(executionCompletionIssues(fx.chat, fx.root, fx.store, fx.files, authority).length > 0);
});

test('document evidence requires a durable full read bound to the actual input hash', () => {
  const fx = fixture(); const batch = fx.files.publishArtifacts(fx.chat, fx.root.id, 'root-inv', [{ name: 'evidence.txt', bytes: Buffer.from('verified document') }]);
  const file = batch.files[0]!; const { reviewer, view, report } = bindReviewer(fx); const raw = reviewInput(view, report.id);
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, false);
  registerTypedRead(fx, reviewer, file, 'document_read', { inputHashes: ['0'.repeat(64)] });
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, false);
  registerTypedRead(fx, reviewer, file, 'document_read', { inputHashes: [file.hash] });
  const currentReport = publishReviewReport(fx, reviewer, 'document-after-read');
  assert.equal(submitExecutionReview(fx.chat, reviewer, reviewInput(view, currentReport.id), fx.store, fx.files, authority).accepted, true);
});

test('typed receipt paging follows runtime JS character length instead of UTF-8 byte length', () => {
  const shortFx = fixture(); const shortBatch = shortFx.files.publishArtifacts(shortFx.chat, shortFx.root.id, 'root-inv', [{ name: 'unicode.txt', bytes: Buffer.from('source') }]);
  const shortFile = shortBatch.files[0]!; const shortBound = bindReviewer(shortFx);
  registerTypedRead(shortFx, shortBound.reviewer, shortFile, 'document_read', { inputHashes: [shortFile.hash], resultContent: '中'.repeat(1_500) });
  const shortReceipt = shortFx.chat.toolResults!.at(-1)!; const shortText = shortFx.store.readBlob(shortFx.chat.id, shortReceipt.ref).toString('utf8');
  assert.ok(shortReceipt.bytes > CHAT_LIMITS.toolText); assert.ok(shortText.length <= CHAT_LIMITS.toolText);
  const shortReport = publishReviewReport(shortFx, shortBound.reviewer, 'unicode-short-after-read');
  assert.equal(submitExecutionReview(shortFx.chat, shortBound.reviewer, reviewInput(shortBound.view, shortReport.id), shortFx.store, shortFx.files, authority).accepted, true);

  const longFx = fixture(); const longBatch = longFx.files.publishArtifacts(longFx.chat, longFx.root.id, 'root-inv', [{ name: 'long.txt', bytes: Buffer.from('source') }]);
  const longFile = longBatch.files[0]!; const longBound = bindReviewer(longFx);
  registerTypedRead(longFx, longBound.reviewer, longFile, 'document_read', { inputHashes: [longFile.hash], resultContent: 'x'.repeat(CHAT_LIMITS.toolText + 100) });
  const longReport = publishReviewReport(longFx, longBound.reviewer, 'true-long-after-read');
  const longReply = submitExecutionReview(longFx.chat, longBound.reviewer, reviewInput(longBound.view, longReport.id), longFx.store, longFx.files, authority);
  assert.equal(longReply.accepted, false); assert.ok(longReply.issues?.some(issue => issue.includes('完整检查')));
});

test('image evidence fails closed without the exact provider source hash', () => {
  const fx = fixture(); const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('fixture')]);
  const batch = fx.files.publishArtifacts(fx.chat, fx.root.id, 'root-inv', [{ name: 'image.png', bytes: png }]);
  const file = batch.files[0]!; const { reviewer, view, report } = bindReviewer(fx); const raw = reviewInput(view, report.id);
  registerTypedRead(fx, reviewer, file, 'image_read');
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, false);
  registerTypedRead(fx, reviewer, file, 'image_read', { providerSourceHash: 'f'.repeat(64) });
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, false);
  registerTypedRead(fx, reviewer, file, 'image_read', { providerSourceHash: file.hash });
  const currentReport = publishReviewReport(fx, reviewer, 'image-after-read');
  assert.equal(submitExecutionReview(fx.chat, reviewer, reviewInput(view, currentReport.id), fx.store, fx.files, authority).accepted, true);
});

test('a ZIP without registered inspectable originals cannot receive a passing review', () => {
  const fx = fixture(); const batch = fx.files.publishArtifacts(fx.chat, fx.root.id, 'root-inv', [{ name: 'bundle.zip', bytes: Buffer.from('PK\u0003\u0004fixture') }]);
  const { reviewer, view, report } = bindReviewer(fx);
  const reply = submitExecutionReview(fx.chat, reviewer, reviewInput(view, report.id), fx.store, fx.files, authority);
  assert.equal(reply.accepted, false); assert.ok(reply.issues?.some(issue => issue.includes('压缩文件')));
});

test('a ZIP passes only through verified bytes and completely inspected registered originals', () => {
  const unreadFx = fixture(); const unreadInput = unreadFx.files.publish(unreadFx.chat, unreadFx.root.id, 'root-inv', [{ name: 'source.txt', bytes: Buffer.from('inspect me') }])[0]!;
  unreadFx.files.publishArtifacts(unreadFx.chat, unreadFx.root.id, 'root-inv', [{ name: 'bundle.zip', bytes: Buffer.from('PK\u0003\u0004fixture'), inputHashes: [unreadInput.hash] }]);
  const unreadBound = bindReviewer(unreadFx);
  const unread = submitExecutionReview(unreadFx.chat, unreadBound.reviewer, reviewInput(unreadBound.view, unreadBound.report.id), unreadFx.store, unreadFx.files, authority);
  assert.equal(unread.accepted, false); assert.ok(unread.issues?.some(issue => issue.includes('原件未检查')));

  const fx = fixture(); const input = fx.files.publish(fx.chat, fx.root.id, 'root-inv', [{ name: 'source.txt', bytes: Buffer.from('inspect me') }])[0]!;
  fx.files.publishArtifacts(fx.chat, fx.root.id, 'root-inv', [{ name: 'bundle.zip', bytes: Buffer.from('PK\u0003\u0004fixture'), inputHashes: [input.hash] }]);
  const { reviewer, view, report } = bindReviewer(fx);
  registerTypedRead(fx, reviewer, input, 'document_read', { inputHashes: [input.hash] });
  assert.equal(submitExecutionReview(fx.chat, reviewer, reviewInput(view, report.id), fx.store, fx.files, authority).accepted, false);
  const currentReport = publishReviewReport(fx, reviewer, 'zip-after-read');
  assert.equal(submitExecutionReview(fx.chat, reviewer, reviewInput(view, currentReport.id), fx.store, fx.files, authority).accepted, true);
});

test('registered blob and formal file byte tampering are rejected with bounded feedback', () => {
  const blobFx = fixture(); const blob = blobFx.store.putBlob(blobFx.chat.id, 'work-proof.txt', 'original');
  blobFx.chat.artifacts.push({ id: 'proof', taskId: blobFx.root.id, name: 'proof.txt', ...blob, kind: 'report', createdAt: blobFx.root.createdAt });
  const boundBlob = bindReviewer(blobFx); writeFileSync(path.join(blobFx.directory, 'chats', blobFx.chat.id, blob.relativePath), 'tampered');
  const blobReply = submitExecutionReview(blobFx.chat, boundBlob.reviewer, reviewInput(boundBlob.view, boundBlob.report.id), blobFx.store, blobFx.files, authority);
  assert.deepEqual(blobReply, { accepted: false, code: 'EXECUTION_REVIEW_REJECTED', issues: ['当前执行视图或登记证据校验失败'], next: 'execution_read' });

  const fileFx = fixture(); const batch = fileFx.files.publishArtifacts(fileFx.chat, fileFx.root.id, 'root-inv', [{ name: 'proof.txt', bytes: Buffer.from('original') }]);
  const file = batch.files[0]!; const boundFile = bindReviewer(fileFx); registerTypedRead(fileFx, boundFile.reviewer, file, 'document_read', { inputHashes: [file.hash] });
  const currentReport = publishReviewReport(fileFx, boundFile.reviewer, 'tamper-after-read');
  writeFileSync(path.join(fileFx.directory, 'chats', fileFx.chat.id, 'files', 'outputs', file.id), 'tampered');
  const fileReply = submitExecutionReview(fileFx.chat, boundFile.reviewer, reviewInput(boundFile.view, currentReport.id), fileFx.store, fileFx.files, authority);
  assert.equal(fileReply.accepted, false); assert.ok(fileReply.issues?.some(issue => issue.includes('字节校验失败')));
});

test('stale source or incomplete canonical view cannot be reviewed', () => {
  const sourceFx = fixture(); const sourceBound = bindReviewer(sourceFx);
  sourceFx.store.appendMessage(sourceFx.chat, { role: 'user', text: '新增不可忽略要求', turnId: sourceFx.root.turnId, clientMessageId: 'steer' });
  const stale = submitExecutionReview(sourceFx.chat, sourceBound.reviewer, reviewInput(sourceBound.view, sourceBound.report.id), sourceFx.store, sourceFx.files, authority);
  assert.equal(stale.accepted, false); assert.ok(stale.issues?.some(issue => issue.includes('已变化')));

  const pageFx = fixture(); const pageBound = bindReviewer(pageFx);
  pageBound.reviewer.resultReadPages = [{ ...page(pageBound.reviewer, pageBound.view.viewRef, pageBound.view.viewHash), next: 10 }];
  const partial = submitExecutionReview(pageFx.chat, pageBound.reviewer, reviewInput(pageBound.view, pageBound.report.id), pageFx.store, pageFx.files, authority);
  assert.equal(partial.accepted, false); assert.ok(partial.issues?.some(issue => issue.includes('完整读取')));
});

test('root terminal lifecycle and final result bytes do not change the canonical hashes', () => {
  const fx = fixture(); const before = materializeExecutionView(fx.chat, fx.root, fx.store);
  const resultBlob = fx.store.putBlob(fx.chat.id, 'root-final.txt', 'final answer');
  fx.root.status = 'completed'; fx.root.result = 'final answer'; fx.root.resultRef = resultBlob.relativePath; fx.root.resultHash = resultBlob.hash;
  fx.root.updatedAt = '2031-01-01T00:00:00.000Z'; fx.root.segment = 99;
  const after = materializeExecutionView(fx.chat, fx.root, fx.store);
  assert.deepEqual([after.contractHash, after.evidenceHash, after.viewHash, after.viewRef], [before.contractHash, before.evidenceHash, before.viewHash, before.viewRef]);
});

test('sent text PDF and image source attachments require complete typed inspection', () => {
  const fx = fixture();
  const textFile = fx.files.upload(fx.chat, { name: 'requirements.txt', base64: Buffer.from('exact text constraints').toString('base64'), clientUploadId: 'text-source' });
  const pdfFile = fx.files.upload(fx.chat, { name: 'requirements.pdf', base64: Buffer.from('%PDF-1.7 fixture').toString('base64'), clientUploadId: 'pdf-source' });
  const imageFile = fx.files.upload(fx.chat, { name: 'reference.png', base64: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('source')]).toString('base64'), clientUploadId: 'image-source' });
  fx.files.bind(fx.chat, [textFile.id, pdfFile.id, imageFile.id], fx.message.id);
  const { reviewer, view, report } = bindReviewer(fx); const raw = reviewInput(view, report.id);
  assert.deepEqual(view.sourceInputs.map(file => file.id), [textFile.id, pdfFile.id, imageFile.id]);
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, false);
  registerTypedRead(fx, reviewer, textFile, 'session_file_read');
  registerTypedRead(fx, reviewer, pdfFile, 'document_read', { inputHashes: [pdfFile.hash] });
  registerTypedRead(fx, reviewer, imageFile, 'image_read', { providerSourceHash: imageFile.hash });
  assert.equal(submitExecutionReview(fx.chat, reviewer, raw, fx.store, fx.files, authority).accepted, false);
  const currentReport = publishReviewReport(fx, reviewer, 'sources-after-read');
  assert.equal(submitExecutionReview(fx.chat, reviewer, reviewInput(view, currentReport.id), fx.store, fx.files, authority).accepted, true);
});

test('pending unbound uploads are outside the source contract and review gate', () => {
  const fx = fixture(); fx.files.upload(fx.chat, { name: 'pending.txt', base64: Buffer.from('not sent').toString('base64'), clientUploadId: 'pending-source' });
  const { reviewer, view, report } = bindReviewer(fx);
  assert.deepEqual(view.sourceInputs, []);
  assert.equal(submitExecutionReview(fx.chat, reviewer, reviewInput(view, report.id), fx.store, fx.files, authority).accepted, true);
});

test('a newly bound steering attachment invalidates the prior contract hash', () => {
  const fx = fixture(); const bound = bindReviewer(fx);
  const steering = fx.store.appendMessage(fx.chat, { role: 'user', text: '新增附件约束', turnId: fx.root.turnId, clientMessageId: 'attachment-steer' });
  const file = fx.files.upload(fx.chat, { name: 'steering.txt', base64: Buffer.from('new attachment constraint').toString('base64'), clientUploadId: 'steering-source' });
  fx.files.bind(fx.chat, [file.id], steering.id);
  const current = materializeExecutionView(fx.chat, fx.root, fx.store);
  assert.notEqual(current.contractHash, bound.view.contractHash);
  assert.deepEqual(current.sourceInputs.map(item => item.id), [file.id]);
  const reply = submitExecutionReview(fx.chat, bound.reviewer, reviewInput(bound.view, bound.report.id), fx.store, fx.files, authority);
  assert.equal(reply.accepted, false); assert.ok(reply.issues?.some(issue => issue.includes('已变化')));
});
