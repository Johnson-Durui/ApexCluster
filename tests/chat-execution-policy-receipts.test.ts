import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { materializeExecutionView } from '../src/chat/execution.js';
import { SessionFiles } from '../src/chat/session-files.js';
import { ChatStore } from '../src/chat/store.js';
import type { AgentTask, ChatEvent, ChatRecord, ResultReadPage } from '../src/chat/types.js';
import { findForbiddenToolAttempts, validateExecutionPolicyReceipt } from '../scripts/chat-execution-policy-receipts.js';

const base = path.resolve('work/test-tmp/execution-policy-receipts');
mkdirSync(base, { recursive: true });
const at = '2026-11-05T00:00:00.000Z';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function task(id: string, role: AgentTask['role'], extra: Partial<AgentTask> = {}): AgentTask {
  return { id, turnId: 'turn', role, goal: `${id} goal`, status: 'running', createdAt: at, updatedAt: at, segment: 1,
    invocationIds: [], noProgressSegments: 0, mode: 'read', ...extra };
}

function fixture(workspace = false, typed: 'none'|'source'|'unicode'|'file'|'image'|'zip'|'generated-zip' = 'none') {
  const directory = mkdtempSync(path.join(base, 'case-')); const store = new ChatStore(directory); const chat = store.create();
  const files = new SessionFiles(store);
  const workspaceFields = workspace ? { workspaceId: 'workspace', workspaceVersion: 7 } : {};
  const root = task('root', 'claude', { ...workspaceFields, executionPolicyVersion: 1, executionReviewRequired: true, mode: 'edit' });
  const child = task('child', 'sol', { ...workspaceFields, parentTaskId: root.id, status: 'completed', disposition: 'adopted', mode: 'edit' });
  const reviewer = task('reviewer', 'astra', { ...workspaceFields, parentTaskId: root.id, executionReviewOfTaskId: root.id, mode: 'verify' });
  if (workspace) { chat.workspaceId = 'workspace'; chat.sourceRevisions = { turn: 2 }; }
  const rootInvocation = { id: 'root-inv', taskId: root.id, segment: 1, status: 'exited' as const, startedAt: at, endedAt: at,
    toolCount: 20, promptVersion: 'test', inputEstimate: 1, contextWindow: null, contextUsed: null, exitConfirmed: true };
  const reviewerInvocation = { ...rootInvocation, id: 'reviewer-inv', taskId: reviewer.id, toolCount: 10 };
  root.invocationIds = [rootInvocation.id]; reviewer.invocationIds = [reviewerInvocation.id];
  chat.tasks.push(root, child); chat.turns.push({ id: 'turn', rootTaskId: root.id, status: 'running', createdAt: at });
  chat.invocations.push(rootInvocation, reviewerInvocation);

  const implementation = store.putBlob(chat.id, 'implementation.txt', `${'x'.repeat(3899)}😀tail`);
  const verification = store.putBlob(chat.id, 'verification.txt', 'verified behavior');
  chat.artifacts.push(
    { id: 'implementation', taskId: root.id, name: 'implementation.txt', ...implementation, kind: 'report', provenance: 'model', createdAt: at },
    { id: 'verification', taskId: root.id, name: 'verification.txt', ...verification, kind: 'test', provenance: 'model', createdAt: at },
  );
  chat.todos = [
    { id: 'implement', taskId: root.id, text: 'implement', status: 'completed', dependsOn: [], linkedTaskIds: [],
      evidenceRefs: [implementation.relativePath], verification: { kind: 'artifact', name: 'implementation.txt' }, updatedAt: at },
    { id: 'verify', taskId: root.id, text: 'verify', status: 'completed', dependsOn: ['implement'], linkedTaskIds: [],
      evidenceRefs: [verification.relativePath], verification: { kind: 'artifact', name: 'verification.txt' }, updatedAt: at },
    { id: 'child-internal', taskId: child.id, text: 'child internal bookkeeping', status: 'completed', dependsOn: [],
      linkedTaskIds: [], evidenceRefs: [], updatedAt: at },
  ];
  let sourceFile: ReturnType<SessionFiles['upload']> | undefined;
  if (typed === 'source' || typed === 'unicode' || typed === 'zip') {
    const sourceText = typed === 'unicode' ? '中'.repeat(1300) : 'typed source truth';
    sourceFile = files.upload(chat, { name: 'source.txt', base64: Buffer.from(sourceText).toString('base64'), clientUploadId: `source-${typed}` });
    const message = store.appendMessage(chat, { role: 'user', text: 'Use the attached source exactly.', turnId: 'turn', clientMessageId: `message-${typed}`, attachmentIds: [sourceFile.id] });
    files.bind(chat, [sourceFile.id], message.id);
  }
  if (typed === 'file') files.publishArtifacts(chat, root.id, rootInvocation.id, [{ name: 'result.pdf', bytes: Buffer.from('%PDF-typed-result') }]);
  if (typed === 'image') files.publishArtifacts(chat, root.id, rootInvocation.id,
    [{ name: 'result.png', bytes: Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]) }]);
  if (typed === 'zip') files.publishArtifacts(chat, root.id, rootInvocation.id,
    [{ name: 'bundle.zip', bytes: Buffer.from('PK\u0003\u0004typed-bundle'), inputHashes: [sourceFile!.hash] }]);
  if (typed === 'generated-zip') {
    const generated = files.publishArtifacts(chat, root.id, rootInvocation.id,
      [{ name: 'generated-input.txt', bytes: Buffer.from('generated input truth') }]).files[0]!;
    files.publishArtifacts(chat, root.id, rootInvocation.id,
      [{ name: 'generated-bundle.zip', bytes: Buffer.from('PK\u0003\u0004generated-bundle'), inputHashes: [generated.hash] }]);
  }
  const initial = materializeExecutionView(chat, root, store);
  chat.tasks.push(reviewer);
  root.executionReviewAttempts = [{ taskId: reviewer.id, contractHash: initial.contractHash, evidenceHash: initial.evidenceHash,
    viewRef: initial.viewRef, viewHash: initial.viewHash, createdAt: at }];
  const view = materializeExecutionView(chat, root, store);
  assert.deepEqual({ contract: view.contractHash, evidence: view.evidenceHash, ref: view.viewRef, hash: view.viewHash },
    { contract: initial.contractHash, evidence: initial.evidenceHash, ref: initial.viewRef, hash: initial.viewHash });

  let seq = 0; const events: ChatEvent[] = [];
  const event = (type: string, taskId: string, invocationId: string, data: unknown) => {
    const value = { seq: ++seq, chatId: chat.id, type, at, taskId, turnId: 'turn', invocationId, data: structuredClone(data) } satisfies ChatEvent;
    events.push(value); return value;
  };
  const tool = (taskId: string, invocationId: string, number: number, name: string, result: unknown, between?: () => void) => {
    const toolCallId = `${invocationId}:${number}`;
    const start = event('tool_started', taskId, invocationId, { name, toolCallId });
    between?.();
    const terminal = event('tool_result', taskId, invocationId, { name, toolCallId, text: JSON.stringify(result) });
    return { start, terminal, toolCallId };
  };
  const read = (owner: AgentTask, invocationId: string, number: number, ref: string, hash: string, offset = 0) => {
    const toolCallId = `${invocationId}:${number}`;
    const workspaceId = owner.workspaceId ?? null; const workspaceVersion = owner.workspaceVersion ?? null;
    const sourceRevision = workspaceId && workspaceVersion !== null ? chat.sourceRevisions?.[owner.turnId] ?? 0 : null;
    const baselineAuthority = workspaceId && workspaceVersion !== null
      ? `workspace:${workspaceId}:grant:${workspaceVersion}:source:${sourceRevision}` : `task:${owner.id}:no-workspace`;
    const body = store.readBlob(chat.id, ref).toString('utf8');
    let content = body.slice(offset, offset + 3900);
    if (content.length && /[\uD800-\uDBFF]/u.test(content.at(-1)!)) content = content.slice(0, -1);
    const next = offset + content.length < body.length ? offset + content.length : null;
    const start = event('tool_started', owner.id, invocationId, { name: 'result_read', toolCallId });
    const readPage = { alreadyProvided: false, originalContentIncluded: true, ref, hash, offset, next,
      workspaceId, workspaceVersion, sourceRevision, baselineAuthority, coverageIndex: owner.resultReadPages?.length ?? 0,
      firstInvocationId: invocationId, firstToolCallId: toolCallId, legacy: false };
    const terminal = event('tool_result', owner.id, invocationId, { name: 'result_read', toolCallId,
      text: `[程序分页 offset=${offset} next=${next ?? 'null'}]\n${content}`, readPage });
    const page: ResultReadPage = { ref, hash, offset, next, workspaceId, workspaceVersion, sourceRevision,
      baselineAuthority, coverageIndex: readPage.coverageIndex, firstInvocationId: invocationId, firstToolCallId: toolCallId };
    (owner.resultReadPages ??= []).push(page); return { start, terminal, page };
  };

  const delegated = tool(root.id, rootInvocation.id, 1, 'agent_submit', [{ taskId: reviewer.id, role: 'astra', status: 'queued' }]);
  const executionRead = tool(reviewer.id, reviewerInvocation.id, 1, 'execution_read', { policyVersion: 1, rootTaskId: root.id,
    reviewRequired: true, contractHash: view.contractHash, evidenceHash: view.evidenceHash, viewRef: view.viewRef, viewHash: view.viewHash,
    workStepIds: view.stepIds, workStepCount: view.stepIds.length, attempt: null, next: 'result_read' });
  const viewRead = read(reviewer, reviewerInvocation.id, 2, view.viewRef, view.viewHash);
  const body = JSON.parse(view.viewText) as { requiredRefs: { ref: string; hash: string; bytes?: number; kind: string; fileId?: string }[] };
  let requiredCallNumber = 3;
  const requiredReads = body.requiredRefs.filter(required => required.kind !== 'file' && required.kind !== 'source-file').flatMap(required => {
    const pages: ReturnType<typeof read>[] = []; let offset = 0;
    do {
      const page = read(reviewer, reviewerInvocation.id, requiredCallNumber++, required.ref, required.hash, offset);
      pages.push(page); offset = page.page.next ?? -1;
    } while (offset >= 0);
    return pages;
  });
  const typedReads = body.requiredRefs.filter(required => required.kind === 'source-file' || required.kind === 'file').flatMap(required => {
    const artifact = required.kind === 'file' ? chat.artifacts.find(item => item.relativePath === required.ref) : undefined;
    const fileId = required.fileId ?? artifact?.fileId; if (!fileId) throw new Error(`typed fixture lacks fileId for ${required.ref}`);
    const actual = files.read(chat, fileId, true);
    if (actual.metadata.mime === 'application/zip') return [];
    const name = actual.metadata.mime.startsWith('image/') ? 'image_read' : actual.metadata.mime.startsWith('text/') ? 'session_file_read' : 'document_read';
    const readFile = { fileId, hash: actual.metadata.hash, bytes: actual.metadata.bytes, mime: actual.metadata.mime, offset: 0, next: null,
      ...(name === 'image_read' ? { providerSourceHash: actual.metadata.hash } : {}) };
    const result = name === 'session_file_read'
      ? JSON.stringify({ file: actual.metadata, text: actual.bytes.toString('utf8'), next: null })
      : JSON.stringify({ inputHashes: [actual.metadata.hash], ...(typed === 'file' ? { detail: 'x'.repeat(4500) } : {}) });
    const envelope = JSON.stringify({ readFile, result });
    const blob = store.putBlob(chat.id, `typed-${fileId}.json`, envelope); const toolNumber = requiredCallNumber++;
    (chat.toolResults ??= []).push({ taskId: reviewer.id, invocationId: reviewerInvocation.id, name, toolNumber, provenance: 'tool',
      ref: blob.relativePath, hash: blob.hash, bytes: blob.bytes });
    const start = event('tool_started', reviewer.id, reviewerInvocation.id, { name, toolCallId: `${reviewerInvocation.id}:${toolNumber}` });
    const terminalText = envelope.length > 4000 ? `${envelope.slice(0, 3600)}\n完整结果引用：${blob.relativePath}` : envelope;
    const terminal = event('tool_result', reviewer.id, reviewerInvocation.id, { name, toolCallId: `${reviewerInvocation.id}:${toolNumber}`, text: terminalText });
    const receiptReads: ReturnType<typeof read>[] = [];
    if (envelope.length > 4000) {
      let offset = 0;
      do {
        const page = read(reviewer, reviewerInvocation.id, requiredCallNumber++, blob.relativePath, blob.hash, offset);
        receiptReads.push(page); offset = page.page.next ?? -1;
      } while (offset >= 0);
    }
    return [{ start, terminal, receiptReads, fileId, name }];
  });
  const reportBlob = store.putBlob(chat.id, 'execution-review.md', 'independent execution review passed');
  const report = { id: 'review-report', taskId: reviewer.id, name: 'execution-review.md', ...reportBlob, kind: 'report' as const,
    provenance: 'model' as const, createdAt: at };
  chat.artifacts.push(report);
  const publish = tool(reviewer.id, reviewerInvocation.id, requiredCallNumber++, 'artifact_publish', report);
  const stepVerdicts = view.stepIds.map(stepId => ({ stepId, outcome: 'passed' as const }));
  const submitToolCallId = `${reviewerInvocation.id}:${requiredCallNumber++}`;
  const submitStart = event('tool_started', reviewer.id, reviewerInvocation.id, { name: 'execution_submit_review', toolCallId: submitToolCallId });
  root.executionReviewAttempts[0]!.review = { outcome: 'passed', stepVerdicts, reportArtifactId: report.id, reportHash: report.hash, submittedAt: at };
  const reviewEvent = event('execution_review', reviewer.id, reviewerInvocation.id, { accepted: true, toolCallId: submitToolCallId,
    rootTaskId: root.id, reviewerTaskId: reviewer.id, contractHash: view.contractHash, evidenceHash: view.evidenceHash,
    review: root.executionReviewAttempts[0]!.review });
  const submitResult = event('tool_result', reviewer.id, reviewerInvocation.id, { name: 'execution_submit_review',
    toolCallId: submitToolCallId, text: JSON.stringify({ accepted: true }) });
  const reviewerComplete = tool(reviewer.id, reviewerInvocation.id, requiredCallNumber++, 'task_complete', { submitted: true, completion: 'awaiting_process_exit' });
  event('invocation_ended', reviewer.id, reviewerInvocation.id, reviewerInvocation);
  reviewer.status = 'completed'; event('task_updated', reviewer.id, reviewerInvocation.id, reviewer);
  const collected = tool(root.id, rootInvocation.id, 2, 'grok_collect', [{ taskId: reviewer.id, status: 'completed' }]);
  const reportRead = read(root, rootInvocation.id, 3, report.relativePath, report.hash);
  const adopted = tool(root.id, rootInvocation.id, 4, 'grok_disposition', { ok: true }, () => {
    reviewer.disposition = 'adopted'; event('task_updated', reviewer.id, rootInvocation.id, reviewer);
  });
  const rootComplete = tool(root.id, rootInvocation.id, 5, 'task_complete', { submitted: true, completion: 'awaiting_process_exit' });
  event('invocation_ended', root.id, rootInvocation.id, rootInvocation);
  root.status = 'completed'; chat.turns[0]!.status = 'completed'; event('task_updated', root.id, rootInvocation.id, root);
  store.save(chat);

  const recomputedView = materializeExecutionView(chat, root, store);
  const input = { chat, events, rootTaskId: root.id, reviewerTaskId: reviewer.id, recomputedView,
    readBlob: (ref: string) => store.readBlob(chat.id, ref), readFile: (fileId: string) => files.read(chat, fileId, true) };
  return { directory, store, files, chat, root, reviewer, report, view, input, events, body, typedReads,
    positions: { delegated, executionRead, viewRead, requiredReads, publish, submitStart, reviewEvent, submitResult,
      reviewerComplete, collected, adopted, reportRead, rootComplete } };
}

function run(mutator?: (fx: ReturnType<typeof fixture>) => void, workspace = false,
  typed: 'none'|'source'|'unicode'|'file'|'image'|'zip'|'generated-zip' = 'none') {
  const fx = fixture(workspace, typed);
  try { mutator?.(fx); return validateExecutionPolicyReceipt(fx.input); }
  finally { rmSync(fx.directory, { recursive: true, force: true }); }
}

function addSuccessfulToolPair(fx: ReturnType<typeof fixture>, taskId: string, invocationId: string, toolNumber: number,
  name: string, text: string, startSeq: number, resultSeq: number): { start: ChatEvent; result: ChatEvent } {
  const toolCallId = `${invocationId}:${toolNumber}`;
  const start = { seq: startSeq, chatId: fx.chat.id, type: 'tool_started', at, taskId, turnId: 'turn', invocationId,
    data: { name, toolCallId } } satisfies ChatEvent;
  const result = { seq: resultSeq, chatId: fx.chat.id, type: 'tool_result', at, taskId, turnId: 'turn', invocationId,
    data: { name, toolCallId, text } } satisfies ChatEvent;
  fx.events.push(start, result);
  return { start, result };
}

test('accepts actual canonical view binding, raw reads, report, adopted reviewer and safe completion order', () => {
  const receipt = run();
  assert.deepEqual(receipt.workStepIds, ['implement', 'verify']);
  assert.equal(receipt.requiredRefs.length, 2);
  assert.ok(receipt.sequence.reviewDelegated < receipt.sequence.viewRead);
  assert.ok(receipt.sequence.reportPublished < receipt.sequence.reviewRecorded);
  assert.ok(receipt.sequence.reviewerCompleted < receipt.sequence.reviewerAdopted);
  assert.ok(receipt.sequence.reportRead < receipt.sequence.reviewerAdopted);
  assert.ok(receipt.sequence.reportRead < receipt.sequence.rootCompleted);
});

test('accepts the Runtime high-surrogate page boundary by removing the dangling high surrogate', () => {
  const fx = fixture();
  try {
    const pages = fx.positions.requiredReads.filter(item => item.page.ref === fx.body.requiredRefs[0]!.ref);
    assert.equal(pages[0]!.page.next, 3899);
    assert.equal(String((pages[0]!.terminal.data as Record<string, unknown>).text).endsWith('x'.repeat(3899)), true);
    assert.deepEqual(validateExecutionPolicyReceipt(fx.input).workStepIds, ['implement', 'verify']);
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('accepts exact current workspace authority and rejects a self-consistent stale source revision', () => {
  assert.deepEqual(run(undefined, true).workStepIds, ['implement', 'verify']);
  assert.throws(() => run(fx => {
    const page = fx.positions.viewRead.page;
    page.baselineAuthority = 'workspace:workspace:grant:7:source:1'; page.sourceRevision = 1;
    const readPage = (fx.positions.viewRead.terminal.data as Record<string, any>).readPage;
    readPage.baselineAuthority = page.baselineAuthority; readPage.sourceRevision = 1;
  }, true), /authority is foreign or stale/);
});

test('ignores completed child and unrelated todos outside the root canonical contract', () => {
  const receipt = run(fx => fx.chat.todos!.push({ id: 'foreign', taskId: 'unrelated-task', text: 'not root contract work',
    status: 'pending', dependsOn: [], linkedTaskIds: [], evidenceRefs: [], updatedAt: at }));
  assert.deepEqual(receipt.workStepIds, ['implement', 'verify']);
});

test('rejects summary-only review that did not read every canonical required ref', () => {
  assert.throws(() => run(fx => {
    const missing = fx.positions.requiredReads[0]!;
    fx.reviewer.resultReadPages = fx.reviewer.resultReadPages!.filter(page => page.firstToolCallId !== missing.page.firstToolCallId);
  }), /complete original-content page chain/);
});

test('rejects forged result_read bodies even when typed page metadata is valid', () => {
  assert.throws(() => run(fx => {
    const terminal = fx.positions.requiredReads[0]!.terminal;
    const data = terminal.data as Record<string, unknown>;
    data.text = String(data.text).replace(/\n[\s\S]*$/u, '\nforged summary');
  }), /body or metadata mismatch/);
});

test('rejects forged next, hash, duplicate offset, and foreign authority page chains', () => {
  assert.throws(() => run(fx => {
    fx.positions.viewRead.page.next = 1;
    (fx.positions.viewRead.terminal.data as Record<string, any>).readPage.next = 1;
  }), /complete original-content page chain|body or metadata mismatch/);
  assert.throws(() => run(fx => { fx.positions.viewRead.page.hash = 'f'.repeat(64); }), /complete original-content page chain/);
  assert.throws(() => run(fx => { fx.reviewer.resultReadPages!.push(structuredClone(fx.positions.viewRead.page)); }), /duplicate offsets/);
  assert.throws(() => run(fx => {
    fx.positions.viewRead.page.baselineAuthority = 'task:foreign:no-workspace';
    (fx.positions.viewRead.terminal.data as Record<string, any>).readPage.baselineAuthority = 'task:foreign:no-workspace';
  }), /authority is foreign/);
});

test('rejects the incorrect 3901-character surrogate extension rule', () => {
  assert.throws(() => run(fx => {
    const first = fx.positions.requiredReads.find(item => item.page.ref === fx.body.requiredRefs[0]!.ref && item.page.offset === 0)!;
    first.page.next = 3901;
    const data = first.terminal.data as Record<string, any>;
    data.readPage.next = 3901;
    data.text = `[程序分页 offset=0 next=3901]\n${fx.store.readBlob(fx.chat.id, first.page.ref).toString('utf8').slice(0, 3901)}`;
  }), /complete original-content page chain|body or metadata mismatch/);
});

test('rejects raw evidence reads reordered after report publication or submission', () => {
  assert.throws(() => run(fx => {
    fx.positions.requiredReads[0]!.terminal.seq = fx.positions.submitResult.seq + 1;
  }), /fully read before report publication/);
});

test('rejects a foreign or byte-drifted report artifact', () => {
  assert.throws(() => run(fx => { fx.report.taskId = fx.root.id; }), /reviewer-owned/);
  assert.throws(() => run(fx => { fx.report.hash = digest('forged'); }), /bytes\/hash mismatch/);
});

test('rejects fake execution_review events and mismatched successful call IDs', () => {
  assert.throws(() => run(fx => {
    (fx.positions.reviewEvent.data as Record<string, unknown>).contractHash = 'f'.repeat(64);
  }), /execution_review event binding/);
  assert.throws(() => run(fx => {
    (fx.positions.submitResult.data as Record<string, unknown>).toolCallId = 'foreign:1';
  }), /must have exactly one terminal event/);
});

test('rejects an unadopted reviewer or unconfirmed invocation exit', () => {
  assert.throws(() => run(fx => { delete fx.reviewer.disposition; }), /completed, adopted/);
  assert.throws(() => run(fx => { fx.chat.invocations.find(item => item.id === fx.reviewer.invocationIds[0])!.exitConfirmed = false; }), /exit is not confirmed/);
});

test('rejects missing root raw report read and completion before report delivery', () => {
  assert.throws(() => run(fx => { fx.root.resultReadPages = []; }), /complete original-content page chain/);
  assert.throws(() => run(fx => { fx.positions.rootComplete.start.seq = fx.positions.reportRead.start.seq; }), /task_complete must follow/);
  assert.throws(() => run(fx => { fx.positions.rootComplete.start.seq = fx.positions.adopted.start.seq; }), /task_complete must follow/);
});

test('rejects stale hashes after real work evidence changes', () => {
  assert.throws(() => run(fx => {
    const added = fx.store.putBlob(fx.chat.id, `late-${randomUUID()}.txt`, 'late work mutation');
    fx.chat.artifacts.push({ id: 'late', taskId: fx.root.id, name: 'late.txt', ...added, kind: 'report', createdAt: at });
    fx.input.recomputedView = materializeExecutionView(fx.chat, fx.root, fx.store);
  }), /stale after root completion/);
});

test('rejects reviewer self-review steps and failed or incomplete verdict coverage', () => {
  assert.throws(() => run(fx => { fx.chat.todos!.push({ id: 'self', taskId: fx.reviewer.id, text: 'self review', status: 'completed',
    dependsOn: [], linkedTaskIds: [], evidenceRefs: [], updatedAt: at }); }), /must not be represented/);
  assert.throws(() => run(fx => { fx.root.executionReviewAttempts![0]!.review!.stepVerdicts.pop(); }), /exactly pass all work steps/);
});

test('rejects a control preview that does not require the production review', () => {
  assert.throws(() => run(fx => {
    const result = fx.positions.executionRead.terminal.data as Record<string, unknown>;
    result.text = JSON.stringify({ ...(JSON.parse(String(result.text)) as Record<string, unknown>), reviewRequired: false });
  }), /execution_read must have at least one matching successful call/);
  assert.throws(() => run(fx => { delete fx.root.executionReviewRequired; }), /required review/);
});

test('detects forbidden tool attempts from started, result, and error events', () => {
  const events = [
    { type: 'tool_started', data: { name: 'ask_user' } },
    { type: 'tool_error', data: { name: 'search' } },
    { type: 'tool_result', data: { name: 'artifact_publish' } },
  ] as ChatEvent[];
  assert.deepEqual(findForbiddenToolAttempts(events, new Set(['artifact_publish'])), ['ask_user', 'search']);
});

test('accepts typed source, generated document, generated image, and ZIP input-hash inspection receipts', () => {
  for (const kind of ['source', 'file', 'image', 'zip', 'generated-zip'] as const) {
    const receipt = run(undefined, false, kind);
    assert.deepEqual(receipt.workStepIds, ['implement', 'verify']);
  }
});

test('rejects an ambiguous ZIP input hash even when both attachments claim the same bytes', () => {
  assert.throws(() => run(fx => {
    const generated = fx.chat.attachments!.find(item => item.name === 'generated-input.txt')!;
    fx.chat.attachments!.push({ ...structuredClone(generated), id: randomUUID(), name: 'ambiguous-generated-input.txt' });
  }, false, 'generated-zip'), /ZIP input hash is foreign or ambiguous/);
});

test('merges an identical host-authentic typed read retry and rejects a conflicting same-offset envelope', () => {
  const identical = run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'session_file_read')!;
    const original = fx.chat.toolResults!.find(item => item.name === typed.name)!;
    const toolNumber = 91;
    fx.chat.toolResults!.push({ ...structuredClone(original), toolNumber });
    const text = fx.store.readBlob(fx.chat.id, original.ref).toString('utf8');
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, typed.name, text,
      fx.positions.publish.start.seq - 0.4, fx.positions.publish.start.seq - 0.3);
  }, false, 'source');
  assert.deepEqual(identical.workStepIds, ['implement', 'verify']);

  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'session_file_read')!;
    const original = fx.chat.toolResults!.find(item => item.name === typed.name)!;
    const envelope = JSON.parse(fx.store.readBlob(fx.chat.id, original.ref).toString('utf8')) as Record<string, unknown>;
    envelope.retryMarker = 'conflicting-host-envelope';
    const replacement = fx.store.putBlob(fx.chat.id, 'typed-conflicting-retry.json', JSON.stringify(envelope));
    const toolNumber = 92;
    fx.chat.toolResults!.push({ ...structuredClone(original), toolNumber, ref: replacement.relativePath,
      hash: replacement.hash, bytes: replacement.bytes });
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, typed.name,
      fx.store.readBlob(fx.chat.id, replacement.relativePath).toString('utf8'),
      fx.positions.publish.start.seq - 0.4, fx.positions.publish.start.seq - 0.3);
  }, false, 'source'), /conflicting duplicate envelopes/);

  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'session_file_read')!;
    const original = fx.chat.toolResults!.find(item => item.name === typed.name)!;
    const envelope = JSON.parse(fx.store.readBlob(fx.chat.id, original.ref).toString('utf8')) as Record<string, any>;
    envelope.readFile.hash = 'f'.repeat(64);
    const replacement = fx.store.putBlob(fx.chat.id, 'typed-wrong-file-hash.json', JSON.stringify(envelope));
    const toolNumber = 95;
    fx.chat.toolResults!.push({ ...structuredClone(original), toolNumber, ref: replacement.relativePath,
      hash: replacement.hash, bytes: replacement.bytes });
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, typed.name,
      fx.store.readBlob(fx.chat.id, replacement.relativePath).toString('utf8'),
      fx.positions.publish.start.seq - 0.4, fx.positions.publish.start.seq - 0.3);
  }, false, 'source'), /conflicting file metadata/);

  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'session_file_read')!;
    const original = fx.chat.toolResults!.find(item => item.name === typed.name)!;
    const envelope = JSON.parse(fx.store.readBlob(fx.chat.id, original.ref).toString('utf8')) as Record<string, any>;
    envelope.readFile.next = 1;
    const replacement = fx.store.putBlob(fx.chat.id, 'typed-wrong-next.json', JSON.stringify(envelope));
    const toolNumber = 96;
    fx.chat.toolResults!.push({ ...structuredClone(original), toolNumber, ref: replacement.relativePath,
      hash: replacement.hash, bytes: replacement.bytes });
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, typed.name,
      fx.store.readBlob(fx.chat.id, replacement.relativePath).toString('utf8'),
      fx.positions.publish.start.seq - 0.4, fx.positions.publish.start.seq - 0.3);
  }, false, 'source'), /conflicting text page/);

  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'image_read')!;
    const original = fx.chat.toolResults!.find(item => item.name === typed.name)!;
    const envelope = JSON.parse(fx.store.readBlob(fx.chat.id, original.ref).toString('utf8')) as Record<string, any>;
    envelope.readFile.providerSourceHash = 'f'.repeat(64);
    const replacement = fx.store.putBlob(fx.chat.id, 'typed-wrong-provider-source.json', JSON.stringify(envelope));
    const toolNumber = 97;
    fx.chat.toolResults!.push({ ...structuredClone(original), toolNumber, ref: replacement.relativePath,
      hash: replacement.hash, bytes: replacement.bytes });
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, typed.name,
      fx.store.readBlob(fx.chat.id, replacement.relativePath).toString('utf8'),
      fx.positions.publish.start.seq - 0.4, fx.positions.publish.start.seq - 0.3);
  }, false, 'image'), /conflicting image source hash/);

  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'session_file_read')!;
    const original = fx.chat.toolResults!.find(item => item.name === typed.name)!;
    const toolNumber = 98;
    fx.chat.toolResults!.push({ ...structuredClone(original), toolNumber });
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, typed.name,
      JSON.stringify({ forged: 'terminal-body' }),
      fx.positions.publish.start.seq - 0.4, fx.positions.publish.start.seq - 0.3);
  }, false, 'source'), /conflicting terminal body/);

  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'document_read')!;
    const original = fx.chat.toolResults!.find(item => item.name === typed.name)!;
    fx.reviewer.resultReadPages = fx.reviewer.resultReadPages!.filter(page => page.ref !== original.ref);
    const toolNumber = 99;
    fx.chat.toolResults!.push({ ...structuredClone(original), toolNumber });
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, typed.name,
      String((typed.terminal.data as Record<string, unknown>).text),
      fx.positions.publish.start.seq - 0.4, fx.positions.publish.start.seq - 0.3);
  }, false, 'file'), /conflicting or incomplete long receipt pages/);
});

test('allows execution_read metadata pagination without treating it as canonical proof', () => {
  const receipt = run(fx => {
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', 93, 'execution_read', JSON.stringify({
      section: 'steps', contractHash: fx.view.contractHash, evidenceHash: fx.view.evidenceHash,
      items: [{ id: 'implement' }], total: 2, next: 1, metadataOnly: true, viewRef: fx.view.viewRef,
    }), fx.positions.executionRead.terminal.seq + 0.2, fx.positions.viewRead.start.seq - 0.2);
  });
  assert.deepEqual(receipt.workStepIds, ['implement', 'verify']);
  assert.throws(() => run(fx => {
    const data = fx.positions.executionRead.terminal.data as Record<string, unknown>;
    const parsed = JSON.parse(String(data.text)) as Record<string, unknown>;
    parsed.workStepIds = ['implement']; parsed.workStepCount = 1; data.text = JSON.stringify(parsed);
  }), /execution_read must have at least one matching successful call/);
});

test('accepts the raw report read before collecting the exited reviewer, but both must precede adoption', () => {
  // r17 live workflow: Claude read the reviewer's report pages, then collected, then adopted.
  assert.deepEqual(run(fx => {
    const { collected, reportRead } = fx.positions;
    const collectSeqs = [collected.start.seq, collected.terminal.seq];
    collected.start.seq = reportRead.terminal.seq + 0.1; collected.terminal.seq = reportRead.terminal.seq + 0.2;
    reportRead.start.seq = collectSeqs[0]!; reportRead.terminal.seq = collectSeqs[1]!;
  }).workStepIds, ['implement', 'verify']);
  // Collecting after adoption is still rejected.
  assert.throws(() => run(fx => {
    fx.positions.collected.start.seq = fx.positions.adopted.terminal.seq + 0.1;
    fx.positions.collected.terminal.seq = fx.positions.adopted.terminal.seq + 0.2;
  }), /root must collect, read the raw review report, and then adopt|task_complete must follow/);
});

test('accepts repeated identical execution_read overviews across segments and orders on the first', () => {
  // r17 live workflow: the reviewer read the same overview at the start of each of its segments (19 matching reads).
  const repeat = (fx: ReturnType<typeof fixture>, toolNumber: number, startSeq: number, resultSeq: number) =>
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', toolNumber, 'execution_read', String((fx.positions.executionRead.terminal.data as Record<string, unknown>).text), startSeq, resultSeq);
  assert.deepEqual(run(fx => {
    repeat(fx, 96, fx.positions.viewRead.start.seq + 0.2, fx.positions.viewRead.start.seq + 0.3);
    repeat(fx, 97, fx.positions.submitStart.seq - 0.4, fx.positions.submitStart.seq - 0.3);
  }).workStepIds, ['implement', 'verify']);
  // The first matching read must still come after delegation and before the canonical view is read.
  assert.throws(() => run(fx => {
    fx.positions.executionRead.start.seq = fx.positions.viewRead.terminal.seq + 0.1;
    fx.positions.executionRead.terminal.seq = fx.positions.viewRead.terminal.seq + 0.15;
  }), /root must delegate before execution_read and canonical view reading/);
});

test('allows one immutable duplicate review acknowledgement but rejects wrong ordering or a second host review event', () => {
  assert.deepEqual(run(fx => {
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', 94, 'execution_submit_review',
      JSON.stringify({ accepted: true, duplicate: true }),
      fx.positions.submitResult.seq + 0.2, fx.positions.reviewerComplete.start.seq - 0.2);
  }).workStepIds, ['implement', 'verify']);
  assert.throws(() => run(fx => {
    addSuccessfulToolPair(fx, fx.reviewer.id, 'reviewer-inv', 94, 'execution_submit_review',
      JSON.stringify({ accepted: true, duplicate: true }),
      fx.positions.submitStart.seq - 0.4, fx.positions.submitStart.seq - 0.3);
  }), /duplicate review acknowledgement/);
  assert.throws(() => run(fx => {
    const duplicate = structuredClone(fx.positions.reviewEvent);
    duplicate.seq = fx.positions.reviewEvent.seq + 0.1;
    fx.events.push(duplicate);
  }), /expected one execution_review host event/);
});

test('uses Runtime JS string length for a non-ASCII small typed envelope', () => {
  const fx = fixture(false, 'unicode');
  try {
    const receipt = fx.chat.toolResults!.find(item => item.name === 'session_file_read')!;
    const envelope = fx.store.readBlob(fx.chat.id, receipt.ref).toString('utf8');
    assert.ok(receipt.bytes > 4000); assert.ok(envelope.length <= 4000);
    assert.equal(fx.typedReads[0]!.receiptReads.length, 0);
    assert.deepEqual(validateExecutionPolicyReceipt(fx.input).workStepIds, ['implement', 'verify']);
  } finally { rmSync(fx.directory, { recursive: true, force: true }); }
});

test('rejects unread, foreign, forged-hash, and forged typed read envelopes', () => {
  assert.throws(() => run(fx => { fx.chat.toolResults = fx.chat.toolResults?.filter(item => item.name !== 'session_file_read'); }, false, 'source'),
    /typed read is missing/);
  assert.throws(() => run(fx => { fx.chat.toolResults!.find(item => item.name === 'session_file_read')!.taskId = fx.root.id; }, false, 'source'),
    /typed read is missing/);
  assert.throws(() => run(fx => { fx.chat.artifacts.find(item => item.fileId)!.hash = 'f'.repeat(64); }, false, 'file'),
    /typed required ref descriptor mismatch|stale after root completion/);
  assert.throws(() => run(fx => {
    const receipt = fx.chat.toolResults!.find(item => item.name === 'image_read')!;
    const envelope = JSON.parse(fx.store.readBlob(fx.chat.id, receipt.ref).toString('utf8')) as Record<string, any>;
    envelope.readFile.providerSourceHash = 'f'.repeat(64);
    const replacement = fx.store.putBlob(fx.chat.id, 'forged-image-envelope.json', JSON.stringify(envelope));
    receipt.ref = replacement.relativePath; receipt.hash = replacement.hash; receipt.bytes = replacement.bytes;
    fx.typedReads.find(item => item.name === 'image_read')!.terminal.data = {
      name: 'image_read', toolCallId: `${receipt.invocationId}:${receipt.toolNumber}`, text: JSON.stringify(envelope),
    };
  }, false, 'image'), /conflicting image source hash/);
  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'document_read')!;
    assert.ok(typed.receiptReads.length > 1, 'fixture must exercise long typed receipt pagination');
    typed.receiptReads[0]!.start.seq = typed.start.seq - 2;
    typed.receiptReads[0]!.terminal.seq = typed.start.seq - 1;
  }, false, 'file'), /long receipt pages precede|typed read is missing/);
});

test('accepts a corrected rejected call but still needs one clean matching call and one terminal per call', () => {
  // r17 live workflow: the reviewer once called execution_read with limit>20, got the schema error, and corrected it.
  const rejected = (fx: ReturnType<typeof fixture>, toolNumber: number, startSeq: number, errorSeq: number) => {
    const toolCallId = `reviewer-inv:${toolNumber}`;
    const start = { seq: startSeq, chatId: fx.chat.id, type: 'tool_started', at, taskId: fx.reviewer.id, turnId: 'turn', invocationId: 'reviewer-inv',
      data: { name: 'execution_read', toolCallId } } satisfies ChatEvent;
    const error = { seq: errorSeq, chatId: fx.chat.id, type: 'tool_error', at, taskId: fx.reviewer.id, turnId: 'turn', invocationId: 'reviewer-inv',
      data: { name: 'execution_read', toolCallId, error: 'Too big: expected number to be <=20' } } satisfies ChatEvent;
    fx.events.push(start, error);
    return { start, error };
  };
  const after = (fx: ReturnType<typeof fixture>) => fx.positions.executionRead.terminal.seq;
  assert.deepEqual(run(fx => { rejected(fx, 95, after(fx) + 0.2, after(fx) + 0.3); }).workStepIds, ['implement', 'verify']);
  // An error and a result for the same call is still a duplicate terminal.
  assert.throws(() => run(fx => {
    const { start } = rejected(fx, 95, after(fx) + 0.2, after(fx) + 0.3);
    fx.events.push({ ...structuredClone(fx.positions.executionRead.terminal), seq: after(fx) + 0.4, data: { ...(fx.positions.executionRead.terminal.data as Record<string, unknown>), toolCallId: (start.data as Record<string, unknown>).toolCallId } });
  }), /must have exactly one terminal event/);
  // If the matching read itself was rejected, nothing successful matches.
  assert.throws(() => run(fx => { fx.positions.executionRead.terminal.type = 'tool_error'; }), /execution_read must have at least one matching successful call/);
});

test('rejects cross-invocation call pairs, host review events, and late invocation exits', () => {
  assert.throws(() => run(fx => {
    const typed = fx.typedReads.find(item => item.name === 'session_file_read')!;
    typed.start.invocationId = 'other-reviewer-inv'; typed.terminal.invocationId = 'other-reviewer-inv';
  }, false, 'source'), /not bound to (?:its|a registered task) invocationId|not bound to a registered task invocation/);
  assert.throws(() => run(fx => { fx.positions.reviewEvent.invocationId = fx.positions.rootComplete.start.invocationId; }),
    /execution_review event (?:binding|is not bound)/);
  assert.throws(() => run(fx => {
    const ended = fx.events.find(event => event.type === 'invocation_ended' && event.invocationId === 'reviewer-inv')!;
    ended.seq = fx.positions.adopted.terminal.seq + 1;
  }), /reviewer final invocation must exit/);
  assert.throws(() => run(fx => {
    const ended = fx.events.find(event => event.type === 'invocation_ended' && event.invocationId === 'root-inv')!;
    const completed = fx.events.find(event => event.type === 'task_updated' && event.taskId === fx.root.id)!;
    ended.seq = completed.seq + 1;
  }), /root final invocation must exit/);
  assert.throws(() => run(fx => {
    fx.positions.executionRead.start.invocationId = 'ghost-inv';
    fx.positions.executionRead.terminal.invocationId = 'ghost-inv';
    (fx.positions.executionRead.start.data as Record<string, unknown>).toolCallId = 'ghost-inv:1';
    (fx.positions.executionRead.terminal.data as Record<string, unknown>).toolCallId = 'ghost-inv:1';
  }), /not bound to a registered task invocation/);
});
