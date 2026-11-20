import { createHash } from 'node:crypto';
import { CHAT_LIMITS, type AgentTask, type ChatArtifact, type ChatAttachment, type ChatEvent, type ChatRecord, type ResultReadPage } from '../src/chat/types.js';

const HASH = /^[a-f0-9]{64}$/;

export interface RecomputedExecutionView {
  contractHash: string;
  evidenceHash: string;
  viewRef: string;
  viewHash: string;
  viewBytes: number;
}

export interface ExecutionPolicyReceiptInput {
  chat: ChatRecord;
  events: readonly ChatEvent[];
  rootTaskId: string;
  reviewerTaskId: string;
  recomputedView: RecomputedExecutionView;
  readBlob: (ref: string) => Uint8Array;
  readFile?: (fileId: string) => { metadata: ChatAttachment; bytes: Uint8Array };
}

export interface ExecutionPolicyReceipt {
  rootTaskId: string;
  reviewerTaskId: string;
  contractHash: string;
  evidenceHash: string;
  viewRef: string;
  viewHash: string;
  reportArtifactId: string;
  reportRef: string;
  reportHash: string;
  workStepIds: string[];
  requiredRefs: string[];
  sequence: {
    reviewDelegated: number;
    viewRead: number;
    reportPublished: number;
    reviewRecorded: number;
    reviewerCompleted: number;
    reviewerAdopted: number;
    reportRead: number;
    rootCompleted: number;
  };
}

type RecordValue = Record<string, unknown>;
type ToolPair = { start: ChatEvent; result: ChatEvent; startData: RecordValue; resultData: RecordValue };

export function findForbiddenToolAttempts(events: readonly ChatEvent[], allowedNames: ReadonlySet<string>): string[] {
  return events.filter(event => ['tool_started', 'tool_result', 'tool_error'].includes(event.type)).flatMap(event => {
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return [];
    const name = (event.data as RecordValue).name;
    return typeof name === 'string' && !allowedNames.has(name) ? [name] : [];
  });
}

function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!HASH.test(result)) throw new Error(`${label} must be a sha256`);
  return result;
}

function parseJson(value: unknown, label: string): unknown {
  try { return JSON.parse(text(value, label)); }
  catch { throw new Error(`${label} must be JSON`); }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as RecordValue)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function eventData(event: ChatEvent): RecordValue {
  return object(event.data, `${event.type} event data`);
}

function toolPairs(events: readonly ChatEvent[], taskId: string, name: string): ToolPair[] {
  const relevant = events.filter(event => event.taskId === taskId && ['tool_started', 'tool_result', 'tool_error'].includes(event.type)
    && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && (event.data as RecordValue).name === name);
  const pairs: ToolPair[] = [];
  let rejectedCalls = 0;
  for (const start of relevant.filter(event => event.type === 'tool_started')) {
    const startData = eventData(start); const callId = text(startData.toolCallId, `${name} started toolCallId`);
    const invocationId = text(start.invocationId, `${name} started invocationId`);
    if (!callId.startsWith(`${invocationId}:`) || !/^\d+$/u.test(callId.slice(invocationId.length + 1))) {
      throw new Error(`${name} ${callId} is not bound to its invocationId`);
    }
    const terminals = relevant.filter(event => event.type !== 'tool_started' && eventData(event).toolCallId === callId);
    if (terminals.length !== 1) throw new Error(`${name} ${callId} must have exactly one terminal event`);
    const result = terminals[0]!;
    if (start.chatId !== result.chatId || result.invocationId !== invocationId || start.taskId !== result.taskId || start.seq >= result.seq) {
      throw new Error(`${name} ${callId} started/result binding or sequence is invalid`);
    }
    // The runtime rejects bad calls with bounded feedback and agents may correct them (r17: a reviewer asked for
    // limit>20 once). A rejected call is a valid single terminal, but it is never evidence: only successful pairs are.
    if (result.type === 'tool_error') { rejectedCalls++; continue; }
    pairs.push({ start, result, startData, resultData: eventData(result) });
  }
  if (relevant.length !== (pairs.length + rejectedCalls) * 2) throw new Error(`${name} contains an orphan or duplicate terminal event`);
  return pairs;
}

function matchingPairs(events: readonly ChatEvent[], taskId: string, name: string, predicate: (parsed: unknown, pair: ToolPair) => boolean): ToolPair[] {
  return toolPairs(events, taskId, name).filter(pair => predicate(parseJson(pair.resultData.text, `${name} result text`), pair));
}

function matchingPair(events: readonly ChatEvent[], taskId: string, name: string, predicate: (parsed: unknown, pair: ToolPair) => boolean): ToolPair {
  const matches = matchingPairs(events, taskId, name, predicate);
  if (matches.length !== 1) throw new Error(`${name} must have exactly one matching successful call (found ${matches.length})`);
  return matches[0]!;
}

function taskUpdated(events: readonly ChatEvent[], taskId: string, status: string, predicate: (data: RecordValue) => boolean = () => true): ChatEvent {
  const matches = events.filter(event => event.taskId === taskId && event.type === 'task_updated' && event.data
    && typeof event.data === 'object' && !Array.isArray(event.data) && (event.data as RecordValue).status === status && predicate(event.data as RecordValue));
  if (matches.length !== 1) throw new Error(`${taskId} must have exactly one task_updated(${status}) event`);
  return matches[0]!;
}

function invocationEnded(events: readonly ChatEvent[], invocationId: string): ChatEvent {
  const matches = events.filter(event => event.invocationId === invocationId && event.type === 'invocation_ended');
  if (matches.length !== 1) throw new Error(`${invocationId} must have exactly one invocation_ended event`);
  const data = eventData(matches[0]!);
  if (data.status !== 'exited' || data.exitConfirmed !== true) throw new Error(`${invocationId} event does not confirm exit`);
  return matches[0]!;
}

function completePageChain(chat: ChatRecord, events: readonly ChatEvent[], task: AgentTask, ref: string, expectedHash: string,
  readBlob: (ref: string) => Uint8Array): { firstSeq: number; lastSeq: number } {
  const bytes = readBlob(ref);
  if (sha256(bytes) !== expectedHash) throw new Error(`result_read blob hash mismatch for ${ref}`);
  const body = Buffer.from(bytes).toString('utf8');
  const groups = new Map<string, ResultReadPage[]>();
  for (const page of task.resultReadPages ?? []) {
    if (page.ref !== ref || page.hash !== expectedHash) continue;
    const pages = groups.get(page.baselineAuthority) ?? []; pages.push(page); groups.set(page.baselineAuthority, pages);
  }
  const complete: { pages: ResultReadPage[]; firstSeq: number; lastSeq: number }[] = [];
  for (const pages of groups.values()) {
    const authority = pages[0]?.baselineAuthority ?? '';
    const workspaceId = task.workspaceId ?? null; const workspaceVersion = task.workspaceVersion ?? null;
    const sourceRevision = workspaceId && workspaceVersion !== null ? chat.sourceRevisions?.[task.turnId] ?? 0 : null;
    const expectedAuthority = workspaceId && workspaceVersion !== null
      ? `workspace:${workspaceId}:grant:${workspaceVersion}:source:${sourceRevision}` : `task:${task.id}:no-workspace`;
    if (authority !== expectedAuthority) throw new Error(`result_read authority is foreign or stale for ${ref}`);
    if (new Set(pages.map(page => page.offset)).size !== pages.length) throw new Error(`result_read contains duplicate offsets for ${ref}`);
    let offset: number | null = 0; const seen = new Set<number>(); const ordered: ResultReadPage[] = [];
    while (offset !== null) {
      if (seen.has(offset)) break; seen.add(offset);
      const page = pages.find(candidate => candidate.offset === offset);
      if (!page) break; ordered.push(page); offset = page.next;
    }
    if (offset !== null) continue;
    const seqs = ordered.map(page => {
      if (page.offset < 0 || page.offset > body.length) throw new Error(`result_read page offset is invalid for ${ref}`);
      let content = body.slice(page.offset, page.offset + 3900);
      if (content.length && /[\uD800-\uDBFF]/u.test(content.at(-1)!)) content = content.slice(0, -1);
      const expectedNext = page.offset + content.length < body.length ? page.offset + content.length : null;
      const pair = toolPairs(events, task.id, 'result_read').find(candidate => candidate.startData.toolCallId === page.firstToolCallId);
      if (!pair) throw new Error(`result_read page ${ref}@${page.offset} is not bound to its successful firstToolCallId`);
      const readPage = object(pair.resultData.readPage, 'result_read readPage');
      if (readPage.originalContentIncluded !== true || readPage.alreadyProvided !== false || readPage.ref !== page.ref || readPage.hash !== page.hash
        || readPage.offset !== page.offset || readPage.next !== expectedNext || page.next !== expectedNext || readPage.baselineAuthority !== page.baselineAuthority
        || page.workspaceId !== workspaceId || page.workspaceVersion !== workspaceVersion || page.sourceRevision !== sourceRevision
        || readPage.workspaceId !== workspaceId || readPage.workspaceVersion !== workspaceVersion || readPage.sourceRevision !== sourceRevision
        || readPage.firstInvocationId !== page.firstInvocationId || readPage.firstToolCallId !== page.firstToolCallId
        || pair.start.invocationId !== page.firstInvocationId
        || pair.resultData.text !== `[程序分页 offset=${page.offset} next=${expectedNext ?? 'null'}]\n${content}`) {
        throw new Error(`result_read page ${ref}@${page.offset} body or metadata mismatch`);
      }
      return pair.result.seq;
    });
    complete.push({ pages: ordered, firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) });
  }
  if (complete.length !== 1) throw new Error(`expected exactly one complete original-content page chain for ${ref} (found ${complete.length})`);
  return { firstSeq: complete[0]!.firstSeq, lastSeq: complete[0]!.lastSeq };
}

interface TypedFileDescriptor { id: string; hash: string; bytes: number; mime: string; inputHashes: string[] }

function completeTypedFileRead(chat: ChatRecord, events: readonly ChatEvent[], reviewer: AgentTask, file: TypedFileDescriptor,
  readBlob: (ref: string) => Uint8Array, readFile: NonNullable<ExecutionPolicyReceiptInput['readFile']>): { firstSeq: number; lastSeq: number } {
  const actual = readFile(file.id);
  if (actual.metadata.id !== file.id || actual.metadata.hash !== file.hash || actual.metadata.bytes !== file.bytes
    || actual.metadata.mime !== file.mime || canonical([...(actual.metadata.inputHashes ?? [])].sort()) !== canonical([...file.inputHashes].sort())
    || actual.bytes.byteLength !== file.bytes || sha256(actual.bytes) !== file.hash) {
    throw new Error(`typed file bytes or metadata mismatch: ${file.id}`);
  }
  if (file.mime === 'application/octet-stream' || file.mime === 'application/zip') throw new Error(`typed file format is not directly inspectable: ${file.id}`);
  const allowed = file.mime.startsWith('image/') ? new Set(['image_read']) : new Set(['document_read', 'session_file_read']);
  const candidates = (chat.toolResults ?? []).filter(receipt => receipt.taskId === reviewer.id && allowed.has(receipt.name ?? '')).flatMap(receipt => {
    if (!receipt.name || receipt.toolNumber === undefined || !receipt.ref.startsWith('blobs/')) return [];
    const bytes = readBlob(receipt.ref); if (bytes.byteLength !== receipt.bytes || sha256(bytes) !== receipt.hash) return [];
    let envelope: RecordValue;
    try { envelope = object(JSON.parse(Buffer.from(bytes).toString('utf8')), 'typed read envelope'); } catch { return []; }
    let readFileData: RecordValue;
    try { readFileData = object(envelope.readFile, 'typed readFile'); } catch { return []; }
    if (readFileData.fileId !== file.id) return [];
    const callId = `${receipt.invocationId}:${receipt.toolNumber}`;
    const typedPair = toolPairs(events, reviewer.id, receipt.name).find(item => item.startData.toolCallId === callId
      && item.start.invocationId === receipt.invocationId && item.result.invocationId === receipt.invocationId);
    if (!typedPair) return [];
    if (readFileData.hash !== file.hash || readFileData.bytes !== file.bytes || readFileData.mime !== file.mime
      || !Number.isSafeInteger(readFileData.offset) || !(readFileData.next === null || Number.isSafeInteger(readFileData.next))) {
      throw new Error(`typed read has conflicting file metadata: ${file.id}`);
    }
    if (receipt.name === 'image_read' && readFileData.providerSourceHash !== file.hash) {
      throw new Error(`typed read has conflicting image source hash: ${file.id}`);
    }
    if (receipt.name === 'document_read') {
      try {
        const provider = typeof envelope.result === 'string' ? object(JSON.parse(envelope.result), 'document result') : object(envelope.result, 'document result');
        if (!Array.isArray(provider.inputHashes) || !provider.inputHashes.includes(file.hash)) {
          throw new Error(`typed read has conflicting document input hashes: ${file.id}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('typed read has conflicting')) throw error;
        throw new Error(`typed read has conflicting document envelope: ${file.id}`);
      }
    }
    if (receipt.name === 'session_file_read') {
      if (!file.mime.startsWith('text/')) return [];
      try {
        const result = typeof envelope.result === 'string' ? object(JSON.parse(envelope.result), 'session file result') : object(envelope.result, 'session file result');
        const textBody = Buffer.from(actual.bytes).toString('utf8'); const offset = integer(readFileData.offset, 'typed offset');
        const content = textBody.slice(offset, offset + 3500); const next = offset + content.length < textBody.length ? offset + content.length : null;
        if (result.text !== content || result.next !== next || readFileData.next !== next) {
          throw new Error(`typed read has conflicting text page: ${file.id}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('typed read has conflicting')) throw error;
        throw new Error(`typed read has conflicting text envelope: ${file.id}`);
      }
    }
    let delivery: { firstSeq: number; lastSeq: number };
    const envelopeText = Buffer.from(bytes).toString('utf8');
    if (envelopeText.length <= CHAT_LIMITS.toolText) {
      if (typedPair.resultData.text !== envelopeText) throw new Error(`typed read has conflicting terminal body: ${file.id}`);
      delivery = { firstSeq: typedPair.result.seq, lastSeq: typedPair.result.seq };
    } else {
      try { delivery = completePageChain(chat, events, reviewer, receipt.ref, receipt.hash, readBlob); }
      catch { throw new Error(`typed read has conflicting or incomplete long receipt pages: ${file.id}`); }
      if (typedPair.result.seq >= delivery.firstSeq) throw new Error(`typed read long receipt pages precede the successful call: ${file.id}`);
    }
    return [{ offset: integer(readFileData.offset, 'typed offset'), next: readFileData.next as number | null, delivery,
      signature: `${receipt.name}:${receipt.hash}:${canonical(envelope)}` }];
  });
  let offset: number | null = 0; const seen = new Set<number>(); const chain: typeof candidates = [];
  while (offset !== null) {
    if (seen.has(offset)) throw new Error(`typed read contains duplicate offset: ${file.id}`); seen.add(offset);
    const matches = candidates.filter(item => item.offset === offset);
    if (!matches.length) throw new Error(`typed read is missing or foreign: ${file.id}@${offset}`);
    if (new Set(matches.map(item => item.signature)).size !== 1) throw new Error(`typed read has conflicting duplicate envelopes: ${file.id}@${offset}`);
    const selected = [...matches].sort((left, right) => left.delivery.firstSeq - right.delivery.firstSeq)[0]!;
    chain.push(selected); offset = selected.next;
  }
  return { firstSeq: Math.min(...chain.map(item => item.delivery.firstSeq)), lastSeq: Math.max(...chain.map(item => item.delivery.lastSeq)) };
}

function artifact(chat: ChatRecord, reviewerId: string, artifactId: string, readBlob: (ref: string) => Uint8Array): ChatArtifact {
  const matches = chat.artifacts.filter(item => item.id === artifactId);
  if (matches.length !== 1) throw new Error('review report artifact ID is missing or duplicated');
  const result = matches[0]!;
  if (result.taskId !== reviewerId || result.kind !== 'report' || result.bytes <= 0 || !result.relativePath.startsWith('blobs/')) {
    throw new Error('review report must be a non-empty reviewer-owned report artifact');
  }
  const bytes = readBlob(result.relativePath);
  if (bytes.length !== result.bytes || sha256(bytes) !== result.hash) throw new Error('review report artifact bytes/hash mismatch');
  return result;
}

export function validateExecutionPolicyReceipt(input: ExecutionPolicyReceiptInput): ExecutionPolicyReceipt {
  const { chat, events, rootTaskId, reviewerTaskId, recomputedView, readBlob, readFile } = input;
  if (!events.every(event => event.chatId === chat.id)) throw new Error('execution receipt contains a foreign chatId');
  const root = chat.tasks.find(task => task.id === rootTaskId);
  const reviewer = chat.tasks.find(task => task.id === reviewerTaskId);
  if (!root || root.parentTaskId || root.role !== 'claude' || root.executionPolicyVersion !== 1
    || root.executionReviewRequired !== true || root.status !== 'completed') throw new Error('root is not a completed production policy v1 Claude root with required review');
  if (!reviewer || reviewer.parentTaskId !== root.id || reviewer.role !== 'astra' || reviewer.mode !== 'verify'
    || reviewer.executionReviewOfTaskId !== root.id || reviewer.status !== 'completed' || reviewer.disposition !== 'adopted') {
    throw new Error('reviewer is not a completed, adopted, direct Astra execution reviewer');
  }
  if ((chat.todos ?? []).some(step => step.taskId === reviewer.id)) throw new Error('execution reviewer must not be represented as a reviewed work step');
  const workSteps = (chat.todos ?? []).filter(step => step.taskId === root.id);
  if (!workSteps.length || workSteps.some(step => step.status !== 'completed')) throw new Error('all reviewed work steps must be completed');
  if (chat.tickets.some(ticket => ticket.status === 'pending') || chat.unsafeProcesses?.length || chat.blockedReason) throw new Error('workflow is not safely closed');
  for (const task of chat.tasks) {
    if (task.status !== 'completed') throw new Error(`workflow task is not completed: ${task.id}`);
    if (task.parentTaskId && !task.disposition) throw new Error(`child task is not disposed: ${task.id}`);
  }
  const tasksById = new Map(chat.tasks.map(task => [task.id, task]));
  const invocationsById = new Map(chat.invocations.map(invocation => [invocation.id, invocation]));
  for (const event of events.filter(item => ['tool_started', 'tool_result', 'tool_error', 'execution_review', 'invocation_ended'].includes(item.type))) {
    const invocationId = text(event.invocationId, `${event.type} invocationId`);
    const invocation = invocationsById.get(invocationId);
    const task = event.taskId ? tasksById.get(event.taskId) : undefined;
    if (!invocation || !task || invocation.taskId !== task.id || !task.invocationIds.includes(invocationId)) {
      throw new Error(`${event.type} event is not bound to a registered task invocation: ${invocationId}`);
    }
  }
  const invocationEnds = new Map<string, ChatEvent>();
  for (const invocation of chat.invocations) {
    if (invocation.status !== 'exited' || invocation.exitConfirmed !== true) throw new Error(`invocation exit is not confirmed: ${invocation.id}`);
    invocationEnds.set(invocation.id, invocationEnded(events, invocation.id));
  }

  const attempts = (root.executionReviewAttempts ?? []).filter(attempt => attempt.taskId === reviewer.id);
  if (attempts.length !== 1 || !attempts[0]!.review) throw new Error('root must contain one immutable submitted review attempt');
  const attempt = attempts[0]!; const review = attempt.review!;
  if (review.outcome !== 'passed') throw new Error('execution review outcome must be passed');
  if (![attempt.contractHash, attempt.evidenceHash, attempt.viewHash, review.reportHash].every(value => HASH.test(value))) throw new Error('review attempt contains an invalid hash');

  const viewBytes = readBlob(attempt.viewRef); const viewText = Buffer.from(viewBytes).toString('utf8');
  if (sha256(viewBytes) !== attempt.viewHash || canonical(parseJson(viewText, 'canonical execution view')) !== viewText) {
    throw new Error('canonical execution view bytes/hash/serialization mismatch');
  }
  const view = object(parseJson(viewText, 'canonical execution view'), 'canonical execution view');
  if (view.version !== 1 || view.contractHash !== attempt.contractHash || view.evidenceHash !== attempt.evidenceHash) throw new Error('canonical execution view binding mismatch');
  const required = Array.isArray(view.requiredRefs) ? view.requiredRefs.map((item, index) => {
    const value = object(item, `requiredRefs[${index}]`);
    return { taskId: text(value.taskId, `requiredRefs[${index}].taskId`), ref: text(value.ref, `requiredRefs[${index}].ref`),
      hash: hash(value.hash, `requiredRefs[${index}].hash`), kind: text(value.kind, `requiredRefs[${index}].kind`),
      bytes: value.bytes === undefined ? undefined : integer(value.bytes, `requiredRefs[${index}].bytes`),
      fileId: value.fileId === undefined ? undefined : text(value.fileId, `requiredRefs[${index}].fileId`) };
  }) : (() => { throw new Error('canonical execution view requiredRefs must be an array'); })();
  if (!Array.isArray(view.unresolvedEvidenceRefs) || view.unresolvedEvidenceRefs.length) throw new Error('canonical execution view has unresolved evidence refs');
  const contract = object(view.contract, 'canonical execution contract');
  const sourceInputValues = Array.isArray(view.sourceInputs) ? view.sourceInputs : contract.sourceInputs;
  const sourceInputs = Array.isArray(sourceInputValues) ? sourceInputValues.map((item, index) => {
    const value = object(item, `sourceInputs[${index}]`);
    return { id: text(value.id, `sourceInputs[${index}].id`), hash: hash(value.hash, `sourceInputs[${index}].hash`),
      bytes: integer(value.bytes, `sourceInputs[${index}].bytes`), mime: text(value.mime, `sourceInputs[${index}].mime`),
      inputHashes: Array.isArray(value.inputHashes) ? value.inputHashes.map((item, hashIndex) => hash(item, `sourceInputs[${index}].inputHashes[${hashIndex}]`)) : [] };
  }) : [];
  const contractSteps = Array.isArray(contract.steps) ? contract.steps.map((item, index) => text(object(item, `contract.steps[${index}]`).id, `contract.steps[${index}].id`)) : [];
  const expectedStepIds = [...new Set(workSteps.map(step => step.id))].sort();
  if (canonical([...contractSteps].sort()) !== canonical(expectedStepIds)) throw new Error('canonical execution view does not exactly cover work steps');
  const verdictIds = review.stepVerdicts.map(item => item.stepId);
  if (review.stepVerdicts.some(item => item.outcome !== 'passed') || new Set(verdictIds).size !== verdictIds.length
    || canonical([...verdictIds].sort()) !== canonical(expectedStepIds)) throw new Error('review verdicts do not exactly pass all work steps');

  if (attempt.contractHash !== recomputedView.contractHash || attempt.evidenceHash !== recomputedView.evidenceHash
    || attempt.viewRef !== recomputedView.viewRef || attempt.viewHash !== recomputedView.viewHash || viewBytes.length !== recomputedView.viewBytes) {
    throw new Error('execution contract/evidence is stale after root completion');
  }

  const delegated = matchingPair(events, root.id, 'agent_submit', parsed => Array.isArray(parsed)
    && parsed.some(item => item && typeof item === 'object' && (item as RecordValue).taskId === reviewer.id));
  // A review that spans several segments re-reads this overview at the start of each one (its prompt says to recover
  // state with execution_read), so identical matching reads may repeat. Ordering is checked on the first of them.
  const executionReads = matchingPairs(events, reviewer.id, 'execution_read', parsed => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const value = parsed as RecordValue;
    return value.policyVersion === 1 && value.rootTaskId === root.id && value.reviewRequired === true && value.contractHash === attempt.contractHash
      && value.evidenceHash === attempt.evidenceHash && value.viewRef === attempt.viewRef && value.viewHash === attempt.viewHash
      && value.workStepCount === expectedStepIds.length && Array.isArray(value.workStepIds)
      && canonical([...value.workStepIds].sort()) === canonical(expectedStepIds);
  });
  if (!executionReads.length) throw new Error('execution_read must have at least one matching successful call (found 0)');
  const executionRead = executionReads.reduce((first, pair) => pair.start.seq < first.start.seq ? pair : first);
  const viewRead = completePageChain(chat, events, reviewer, attempt.viewRef, attempt.viewHash, readBlob);
  if (!(delegated.result.seq < executionRead.start.seq && executionRead.result.seq < viewRead.firstSeq)) {
    throw new Error('root must delegate before execution_read and canonical view reading');
  }
  let allRawReadsCompleted = viewRead.lastSeq;
  for (const entry of required.filter(item => item.kind !== 'file' && item.kind !== 'source-file')) {
    const delivered = completePageChain(chat, events, reviewer, entry.ref, entry.hash, readBlob);
    if (delivered.firstSeq <= viewRead.lastSeq) throw new Error(`required raw ref was read before the canonical view completed: ${entry.ref}`);
    allRawReadsCompleted = Math.max(allRawReadsCompleted, delivered.lastSeq);
  }
  for (const entry of required.filter(item => item.kind === 'file' || item.kind === 'source-file')) {
    if (!readFile || entry.bytes === undefined) throw new Error(`typed required ref lacks a file reader or descriptor: ${entry.ref}`);
    let descriptor: TypedFileDescriptor | undefined;
    if (entry.kind === 'source-file') {
      if (!entry.fileId) throw new Error(`source-file lacks fileId: ${entry.ref}`);
      if (entry.ref !== `session:${entry.fileId}`) throw new Error(`source-file ref is not canonical: ${entry.ref}`);
      descriptor = sourceInputs.find(file => file.id === entry.fileId);
    } else {
      const artifact = chat.artifacts.find(item => item.relativePath === entry.ref && !!item.fileId);
      if (artifact?.mime && artifact.fileId) descriptor = { id: artifact.fileId, hash: artifact.hash, bytes: artifact.bytes, mime: artifact.mime, inputHashes: artifact.inputHashes ?? [] };
    }
    if (!descriptor || descriptor.hash !== entry.hash || descriptor.bytes !== entry.bytes) throw new Error(`typed required ref descriptor mismatch: ${entry.ref}`);
    const actual = readFile(descriptor.id);
    if (actual.metadata.hash !== descriptor.hash || actual.metadata.bytes !== descriptor.bytes || actual.metadata.mime !== descriptor.mime
      || canonical([...(actual.metadata.inputHashes ?? [])].sort()) !== canonical([...descriptor.inputHashes].sort())
      || actual.bytes.byteLength !== descriptor.bytes || sha256(actual.bytes) !== descriptor.hash) throw new Error(`typed file bytes or metadata mismatch: ${descriptor.id}`);
    if (descriptor.mime === 'application/zip') {
      if (!descriptor.inputHashes.length) throw new Error(`ZIP file lacks inspectable input hashes: ${descriptor.id}`);
      for (const inputHash of descriptor.inputHashes) {
        const inputs = (chat.attachments ?? []).filter(file => file.hash === inputHash);
        if (inputs.length !== 1) throw new Error(`ZIP input hash is foreign or ambiguous: ${inputHash}`);
        const input = inputs[0]!;
        const source: TypedFileDescriptor = { id: input.id, hash: input.hash, bytes: input.bytes, mime: input.mime, inputHashes: input.inputHashes ?? [] };
        const delivered = completeTypedFileRead(chat, events, reviewer, source, readBlob, readFile);
        if (delivered.firstSeq <= viewRead.lastSeq) throw new Error(`typed ZIP input was read before the canonical view completed: ${source.id}`);
        allRawReadsCompleted = Math.max(allRawReadsCompleted, delivered.lastSeq);
      }
    } else {
      const delivered = completeTypedFileRead(chat, events, reviewer, descriptor, readBlob, readFile);
      if (delivered.firstSeq <= viewRead.lastSeq) throw new Error(`typed required ref was read before the canonical view completed: ${entry.ref}`);
      allRawReadsCompleted = Math.max(allRawReadsCompleted, delivered.lastSeq);
    }
  }

  const report = artifact(chat, reviewer.id, review.reportArtifactId, readBlob);
  if (report.hash !== review.reportHash) throw new Error('review attempt report hash does not match the actual artifact');
  const reportPublish = matchingPair(events, reviewer.id, 'artifact_publish', parsed => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const value = parsed as RecordValue;
    return value.id === report.id && value.relativePath === report.relativePath && value.hash === report.hash && value.bytes === report.bytes && value.kind === 'report';
  });
  const submit = matchingPair(events, reviewer.id, 'execution_submit_review', parsed => !!parsed && typeof parsed === 'object'
    && !Array.isArray(parsed) && (parsed as RecordValue).accepted === true && (parsed as RecordValue).duplicate !== true);
  const duplicateSubmits = toolPairs(events, reviewer.id, 'execution_submit_review').filter(pair => {
    const parsed = parseJson(pair.resultData.text, 'execution_submit_review duplicate text');
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as RecordValue).accepted === true && (parsed as RecordValue).duplicate === true;
  });
  if (!(allRawReadsCompleted < reportPublish.start.seq && reportPublish.result.seq < submit.start.seq)) {
    throw new Error('canonical view and all required raw refs must be fully read before report publication and review submission');
  }
  const reviewEvents = events.filter(event => event.type === 'execution_review' && event.taskId === reviewer.id);
  if (reviewEvents.length !== 1) throw new Error('expected one execution_review host event');
  const reviewEvent = reviewEvents[0]!; const reviewData = eventData(reviewEvent); const eventReview = object(reviewData.review, 'execution_review review');
  if (!(submit.start.seq < reviewEvent.seq && reviewEvent.seq < submit.result.seq) || reviewData.rootTaskId !== root.id || reviewData.reviewerTaskId !== reviewer.id
    || reviewEvent.invocationId !== submit.start.invocationId || reviewData.toolCallId !== submit.startData.toolCallId || reviewData.accepted !== true
    || reviewData.contractHash !== attempt.contractHash || reviewData.evidenceHash !== attempt.evidenceHash || eventReview.outcome !== 'passed'
    || eventReview.reportArtifactId !== report.id || eventReview.reportHash !== report.hash
    || canonical(eventReview.stepVerdicts) !== canonical(review.stepVerdicts)) throw new Error('execution_review event binding or sequence mismatch');

  const reviewerCompleteCall = matchingPair(events, reviewer.id, 'task_complete', parsed => !!parsed && typeof parsed === 'object'
    && !Array.isArray(parsed) && (parsed as RecordValue).submitted === true);
  if (duplicateSubmits.some(pair => !(submit.result.seq < pair.start.seq && pair.result.seq < reviewerCompleteCall.start.seq))) {
    throw new Error('duplicate review acknowledgement must follow the immutable review and precede reviewer completion');
  }
  if (reviewerCompleteCall.start.seq <= submit.result.seq) throw new Error('reviewer task_complete must occur after review submission');
  const reviewerCompleted = taskUpdated(events, reviewer.id, 'completed', data => data.disposition !== 'adopted');
  const reviewerEnd = invocationEnds.get(reviewerCompleteCall.result.invocationId!);
  if (!reviewerEnd || !(reviewerCompleteCall.result.seq < reviewerEnd.seq && reviewerEnd.seq < reviewerCompleted.seq)) {
    throw new Error('reviewer final invocation must exit after task_complete and before completed state');
  }

  const collected = matchingPair(events, root.id, 'grok_collect', parsed => Array.isArray(parsed)
    && parsed.some(item => !!item && typeof item === 'object' && !Array.isArray(item) && (item as RecordValue).taskId === reviewer.id));
  const reportRead = completePageChain(chat, events, root, report.relativePath, report.hash, readBlob);
  const reviewerAdopted = taskUpdated(events, reviewer.id, 'completed', data => data.disposition === 'adopted');
  const dispositionPairs = toolPairs(events, root.id, 'grok_disposition').filter(pair => {
    const parsed = parseJson(pair.resultData.text, 'grok_disposition result text');
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as RecordValue).ok === true
      && pair.start.seq < reviewerAdopted.seq && reviewerAdopted.seq < pair.result.seq;
  });
  if (dispositionPairs.length !== 1) throw new Error('reviewer adopted task_updated must be bound to one successful grok_disposition call');
  const adopted = dispositionPairs[0]!;
  // Collecting the result and reading the raw report are both read-only and may happen in either order (r17: Claude
  // read the report first); both must follow the reviewer's safe exit and precede adoption.
  if (!(reviewerEnd.seq < reviewerCompleted.seq && reviewerCompleted.seq < collected.start.seq && reviewerCompleted.seq < reportRead.firstSeq
    && collected.result.seq < adopted.start.seq && reportRead.lastSeq < adopted.start.seq)) throw new Error('root must collect, read the raw review report, and then adopt the safely exited reviewer');
  const rootCompleteCall = matchingPair(events, root.id, 'task_complete', parsed => !!parsed && typeof parsed === 'object'
    && !Array.isArray(parsed) && (parsed as RecordValue).submitted === true);
  if (rootCompleteCall.start.seq <= adopted.result.seq) throw new Error('root task_complete must follow report reading and reviewer adoption');
  const rootCompleted = taskUpdated(events, root.id, 'completed');
  const rootEnd = invocationEnds.get(rootCompleteCall.result.invocationId!);
  if (!rootEnd || !(rootCompleteCall.result.seq < rootEnd.seq && rootEnd.seq < rootCompleted.seq)) {
    throw new Error('root final invocation must exit after task_complete and before completed state');
  }

  return {
    rootTaskId: root.id,
    reviewerTaskId: reviewer.id,
    contractHash: attempt.contractHash,
    evidenceHash: attempt.evidenceHash,
    viewRef: attempt.viewRef,
    viewHash: attempt.viewHash,
    reportArtifactId: report.id,
    reportRef: report.relativePath,
    reportHash: report.hash,
    workStepIds: expectedStepIds,
    requiredRefs: required.map(item => item.ref),
    sequence: {
      reviewDelegated: delegated.result.seq,
      viewRead: viewRead.lastSeq,
      reportPublished: reportPublish.result.seq,
      reviewRecorded: reviewEvent.seq,
      reviewerCompleted: reviewerCompleted.seq,
      reviewerAdopted: adopted.result.seq,
      reportRead: reportRead.lastSeq,
      rootCompleted: rootCompleted.seq,
    },
  };
}
