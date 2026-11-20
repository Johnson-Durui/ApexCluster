import { createHash } from 'node:crypto';
import type { AgentTask, ChatRecord, Invocation, RotationReason } from './types.js';
import type { ChatStore } from './store.js';
import { sourcePlan } from './source-context.js';
import { taskSeat } from './roster.js';
import { executionRoot } from './execution.js';

const MAX_PACKET_BYTES = 24_000;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
}

/** Retry a deterministic write only when the existing blob has identical bytes. */
export function immutableBlob(store: ChatStore, chatId: string, name: string, text: string) {
  try { return store.putBlob(chatId, name, text); }
  catch (error) {
    const ref = `blobs/${name}`;
    try {
      const existing = store.readBlob(chatId, ref);
      if (existing.toString('utf8') === text) return { relativePath: ref, hash: hash(text), bytes: existing.length };
    } catch { /* Preserve the original immutable-write failure. */ }
    throw error;
  }
}

function scopedTaskIds(chat: ChatRecord, task: AgentTask): Set<string> {
  const ids = new Set([task.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of chat.tasks) if (candidate.parentTaskId && ids.has(candidate.parentTaskId) && !ids.has(candidate.id)) { ids.add(candidate.id); changed = true; }
  }
  return ids;
}

function verifiedNote(task: AgentTask, store: ChatStore, chatId: string) {
  const latest = task.notes?.at(-1); if (!latest) return null;
  const text = store.readBlob(chatId, latest.ref).toString('utf8');
  if (Buffer.byteLength(text, 'utf8') !== latest.bytes || hash(text) !== latest.hash) throw new Error('模型笔记引用或哈希不一致');
  return { metadata: latest, text };
}

function renderPacket(reason: RotationReason, from: number, to: number, state: Record<string, unknown>, stateRef: string, stateHash: string): string {
  const header = `交接包 · 第 ${from} 窗 → 第 ${to} 窗 · 原因：${reason}\n完整结构化状态：${stateRef}\n状态 SHA-256：${stateHash}\n`;
  const sections: Array<[string, unknown]> = [
    ['1 你是谁', state.identity],
    ['2 北极星（原文身份，不可改写）', state.northStar],
    ['3 程序事实', state.program],
    ['4 模型笔记（不是事实）', state.notes],
    ['5 对齐提醒', state.alignment],
    ['6 下一步', state.next],
    ['7 取证指引', state.recovery],
  ];
  const fallback = (title: string) => `\n${title}\n本节完整内容见 ${stateRef}；状态哈希 ${stateHash}。\n`;
  let text = header;
  for (let index = 0; index < sections.length; index++) {
    const [title, value] = sections[index]!;
    const full = `\n${title}\n${JSON.stringify(canonical(value))}\n`;
    const reserve = sections.slice(index + 1).reduce((sum, [next]) => sum + Buffer.byteLength(fallback(next), 'utf8'), 0);
    text += Buffer.byteLength(text + full, 'utf8') + reserve <= MAX_PACKET_BYTES ? full : fallback(title);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PACKET_BYTES) throw new Error('交接包固定索引超过 24,000 字节');
  return text;
}

/** Persist a lossless program snapshot and a bounded first-message packet without model summarization. */
export function buildHandoff(chat: ChatRecord, task: AgentTask, previous: Invocation, reason: RotationReason, store: ChatStore): {
  text: string; ref: string; hash: string; stateRef: string; stateHash: string;
} {
  if (!chat.apiRoster) throw new Error('只有 API 聊天生成窗口交接包');
  if (previous.taskId !== task.id) throw new Error('交接调用段与任务不匹配');
  const seat = taskSeat(chat, task); if (!seat) throw new Error(`交接席位不存在：${task.role}`);
  const ids = scopedTaskIds(chat, task);
  const checkpoint = chat.checkpoints.find(item => item.id === task.checkpointId && item.taskId === task.id) ?? null;
  const notes = verifiedNote(task, store, chat.id);
  const sources = sourcePlan(chat, task, store).sources;
  const root = executionRoot(chat, task);
  const executionContracts = (root?.executionReviewAttempts ?? task.executionReviewAttempts ?? [])
    .filter(item => !root || root.id === task.id || item.taskId === task.id);
  const unreadReceipts = chat.invocations.filter(item => ids.has(item.taskId)).flatMap(item =>
    (item.toolReceiptDeliveries ?? []).filter(receipt => !receipt.delivered)
      .map(receipt => ({ invocationId: item.id, ...receipt, delivered: false })));
  const unreadRefs = new Set(unreadReceipts.map(item => item.ref));
  const deliveredReceipts = (chat.toolResults ?? []).filter(item => ids.has(item.taskId) && !unreadRefs.has(item.ref)
    && (item.provenance === 'runner' || ['test_submit', 'exec', 'job_start', 'job_output', 'job_stop'].includes(item.name ?? '')))
    .slice(-16).map(item => ({ taskId: item.taskId, invocationId: item.invocationId, name: item.name ?? null,
      ref: item.ref, hash: item.hash, bytes: item.bytes, provenance: item.provenance ?? null, delivered: true }));
  const state = canonical({
    version: 1,
    identity: { chatId: chat.id, taskId: task.id, parentTaskId: task.parentTaskId ?? null, seat: seat.id, kind: seat.kind,
      phase: task.phase ?? null, mode: task.mode, fromSegment: previous.segment, toSegment: previous.segment + 1, reason },
    northStar: {
      sources,
      pipelineContract: chat.pipeline?.contract ?? null,
      clarifications: chat.tickets.filter(item => item.type === 'user' && !item.budget && item.status === 'resolved' && ids.has(item.taskId))
        .map(item => ({ id: item.id, question: item.question, options: item.options ?? [], answerSourceId: item.answerMessageId ?? null, legacyAnswer: item.answerMessageId ? undefined : item.answer })).sort((left, right) => left.id < right.id ? -1 : 1),
      executionContracts: executionContracts.map(item => ({ taskId: item.taskId, contractHash: item.contractHash, evidenceHash: item.evidenceHash, viewRef: item.viewRef, viewHash: item.viewHash })).sort((left, right) => left.taskId < right.taskId ? -1 : 1),
    },
    program: {
      plan: { revision: chat.planRevision ?? 0, steps: (chat.todos ?? []).filter(item => ids.has(item.taskId)) },
      tasks: chat.tasks.filter(item => ids.has(item.id)).map(item => ({ id: item.id, parentTaskId: item.parentTaskId ?? null, role: item.role, mode: item.mode,
        status: item.status, disposition: item.disposition ?? null, groupId: item.groupId ?? null, resultRef: item.resultRef ?? null, resultHash: item.resultHash ?? null, error: item.error ?? null })).sort((left, right) => left.id < right.id ? -1 : 1),
      pendingTickets: chat.tickets.filter(item => item.status === 'pending' && ids.has(item.taskId)).map(item => ({ id: item.id, taskId: item.taskId, type: item.type, childIds: item.childIds ?? [], externalId: item.externalId ?? null, processStatus: item.processStatus ?? null })).sort((left, right) => left.id < right.id ? -1 : 1),
      artifacts: chat.artifacts.filter(item => ids.has(item.taskId)).map(item => ({ id: item.id, taskId: item.taskId, name: item.name, ref: item.relativePath, hash: item.hash, bytes: item.bytes, provenance: item.provenance ?? null })).sort((left, right) => left.id < right.id ? -1 : 1),
      workspace: { id: task.workspaceId ?? null, version: task.workspaceVersion ?? null, sourceRevision: chat.sourceRevisions?.[task.turnId] ?? null },
      execJobs: chat.execJobs?.filter(item => ids.has(item.taskId)),
      receipts: {
        unread: unreadReceipts.sort((left, right) => left.id < right.id ? -1 : 1),
        delivered: deliveredReceipts,
      },
      usage: { model: previous.model ?? null, effort: previous.effort ?? null, latest: previous.usage ?? null, contextWindow: previous.contextWindow, contextUsed: previous.contextUsed, peakUsed: previous.peakUsed ?? null },
    },
    notes: { label: '模型笔记，不是程序事实', latest: notes, yield: checkpoint ? { done: checkpoint.done ?? [], unverified: checkpoint.unverified ?? [], next: checkpoint.next, risks: checkpoint.risks ?? [] } : null },
    alignment: { blockedReason: chat.blockedReason ?? null,
      ...(task.pipelineWork?.kind === 'milestone-author' ? { drift: chat.pipeline?.implementation?.milestones
        .find(item => item.attempts.at(-1)?.authorTaskId === task.id)?.attempts.at(-1)?.drift } : {}) },
    next: { action: checkpoint?.next ?? '读取程序状态并继续当前任务', stopCondition: '取得当前步骤要求的真实回执，或遇到必须等待/换窗的程序边界',
      fanoutGroups: chat.fanoutGroups?.filter(group => group.parentTaskId === task.id).map(group => ({ groupId: group.id, total: group.total, pool: group.pool })),
      clusters: chat.pipeline?.clusters.filter(cluster => cluster.rootTaskId === task.id ||
        (chat.pipeline?.architectureTaskId === task.id && cluster.id === chat.pipeline.carriedClusterId)).map(cluster => ({
        groupId: cluster.groupId, mode: cluster.mode, status: cluster.status, ref: cluster.summaryRef,
      })),
      estimatedUsage: chat.apiUsage ?? null, unresolvedUsageReservation: chat.apiUnresolvedUsage ?? null },
    recovery: { source: 'user_source_list / user_source_read', state: 'task_state', plan: 'plan_read', evidence: 'task_evidence / result_read', warning: '需要细节时按引用读取；不要凭记忆补全。' },
  }) as Record<string, unknown>;
  const stateText = `${JSON.stringify(state)}\n`;
  const stateBlob = immutableBlob(store, chat.id, `handoff-state-${previous.id}.json`, stateText);
  const text = renderPacket(reason, previous.segment, previous.segment + 1, state, stateBlob.relativePath, stateBlob.hash);
  const packetBlob = immutableBlob(store, chat.id, `handoff-${previous.id}.txt`, text);
  return { text, ref: packetBlob.relativePath, hash: packetBlob.hash, stateRef: stateBlob.relativePath, stateHash: stateBlob.hash };
}
