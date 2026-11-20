import { createHash } from 'node:crypto';
import type { AgentTask, ChatRecord, ChatMessage } from './types.js';
import type { ChatStore } from './store.js';

export const SOURCE_PAGE_CHARS = 3600;
// 给角色规范、程序事实与工具协议留出空间。UTF-8 字节用于保守材料估算，非模型窗口。
const INLINE_SOURCE_BYTES = 10_000;
export interface UserSource { id: string; kind: 'message' | 'clarification' | 'goal'; length: number; hash: string; pages: number }
export interface SourcePlan { inline: boolean; sources: UserSource[] }

/** Questions remain model material; only their paired answers are user decisions. */
export function clarificationSources(chat: ChatRecord, store: ChatStore) {
  return chat.tickets.filter(ticket => ticket.type === 'user' && !ticket.budget && ticket.status === 'resolved' && ticket.question && ticket.answer !== undefined)
    .map(ticket => {
      const answerSourceId = ticket.answerMessageId;
      if (answerSourceId) {
        const message = store.message(chat.id, answerSourceId);
        if (!chat.constraintMessageIds.includes(answerSourceId) || message.role !== 'user' || message.text !== ticket.answer) throw new Error('澄清回答来源身份无效');
      }
      return { id: `clarification:${ticket.id}`, kind: 'clarification' as const, answerSourceId,
        text: JSON.stringify({ question: ticket.question, options: ticket.options ?? [], ...(answerSourceId ? { answerSourceId } : { answer: ticket.answer }) }) };
    });
}

function authorized(chat: ChatRecord, task: AgentTask, store: ChatStore): Array<{ id: string; kind: UserSource['kind']; text: string }> {
  const actual = chat.tasks.find(t => t.id === task.id);
  if (!actual || actual.goal !== task.goal) throw new Error('任务来源身份无效');
  const seen = new Set<string>();
  const wanted = new Set(chat.constraintMessageIds); const messagesById = new Map<string, ChatMessage>();
  // Batch the existing message pages; per-ID disk scans become quadratic on long source sets.
  for (let before: number | undefined; messagesById.size < wanted.size;) {
    const page = store.messages(chat.id, { before, limit: 50 });
    for (const message of page.items) if (wanted.has(message.id)) messagesById.set(message.id, message);
    if (!page.nextBefore) break; before = page.nextBefore;
  }
  const messages = chat.constraintMessageIds.map(id => {
    if (seen.has(id)) throw new Error('用户来源身份重复'); seen.add(id);
    const message = messagesById.get(id);
    if (!message || message.role !== 'user' || message.id !== id) throw new Error('用户来源身份无效');
    return { id, kind: 'message' as const, text: message.text };
  });
  return [...messages, ...clarificationSources(chat, store), { id: `goal:${task.id}`, kind: 'goal' as const, text: actual.goal }];
}
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function offsets(text: string): number[] {
  const pages = [0]; let position = 0;
  while (position < text.length) {
    let end = Math.min(position + SOURCE_PAGE_CHARS, text.length);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF && text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF) end--;
    position = end; if (position < text.length) pages.push(position);
  }
  return pages;
}

export function sourcePlan(chat: ChatRecord, task: AgentTask, store: ChatStore): SourcePlan {
  const raw = authorized(chat, task, store);
  return { inline: !task.sourcePagingRequired && raw.reduce((sum, s) => sum + Buffer.byteLength(s.text, 'utf8') + 1, 0) <= INLINE_SOURCE_BYTES,
    sources: raw.map(s => ({ id: s.id, kind: s.kind, length: s.text.length, hash: digest(s.text), pages: offsets(s.text).length })) };
}

export function readSource(chat: ChatRecord, task: AgentTask, store: ChatStore, input: { sourceId: string; offset: number }): { text: string; next: number | null; sourceHash: string } {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('来源偏移必须为页起点');
  const source = authorized(chat, task, store).find(s => s.id === input.sourceId);
  if (!source) throw new Error('无权读取该来源');
  const pages = offsets(source.text); const page = pages.indexOf(input.offset);
  if (page < 0) throw new Error('来源偏移必须为有效页起点');
  const next = pages[page + 1] ?? null;
  return { text: source.text.slice(input.offset, next ?? source.text.length), next, sourceHash: digest(source.text) };
}

export function sourceCoverageIssues(chat: ChatRecord, task: AgentTask, store: ChatStore): string[] {
  const plan = sourcePlan(chat, task, store); if (plan.inline) return [];
  const state = task as AgentTask & { sourceCoverage?: Record<string, number[]>; sourceCoverageHashes?: Record<string, string> };
  const coverage = state.sourceCoverage ?? {}; const hashes = state.sourceCoverageHashes ?? {};
  const issues: string[] = []; let missing = 0;
  const raw = new Map(authorized(chat, task, store).map(source => [source.id, source.text]));
  for (const source of plan.sources) {
    const seen = new Set(hashes[source.id] === source.hash && Array.isArray(coverage[source.id]) ? coverage[source.id] : []);
    for (const offset of offsets(raw.get(source.id)!)) if (!seen.has(offset)) { missing++; if (issues.length < 32) issues.push(`${source.id}:${offset}`); }
  }
  if (missing > issues.length) issues.push(`另有 ${missing - issues.length} 页未核对`);
  return issues;
}
