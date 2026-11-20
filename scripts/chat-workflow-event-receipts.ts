import type { ChatEvent, ChatRecord } from '../src/chat/types.js';

export interface GrokBatchReceipt {
  taskId: string;
  invocationId: string;
  toolCallId: string;
  childTaskIds: string[];
}

export interface CancelledAskUserReceipt {
  taskId: string;
  invocationId: string;
  ticketId: string;
  toolCallId: string;
  startedSeq: number;
  questionSeq: number;
  resultSeq: number;
}

function eventData(event: ChatEvent): Record<string, unknown> {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error('grok_submit event data must be an object');
  return event.data as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function validateRootGrokBatchReceipt(
  events: readonly ChatEvent[],
  rootTaskId: string,
  expectedChildTaskIds: readonly string[],
  expectedChatId: string,
): GrokBatchReceipt {
  if (new Set(expectedChildTaskIds).size !== 3 || expectedChildTaskIds.length !== 3) {
    throw new Error('expected exactly three distinct direct Grok child task IDs');
  }
  const relevant = events.filter((event) => {
    if (event.taskId !== rootTaskId) return false;
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
    return (event.data as { name?: unknown }).name === 'grok_submit';
  });
  const started = relevant.filter((event) => event.type === 'tool_started');
  const results = relevant.filter((event) => event.type === 'tool_result');
  const errors = relevant.filter((event) => event.type === 'tool_error');
  if (started.length !== 1 || results.length !== 1 || errors.length !== 0 || relevant.length !== 2) {
    throw new Error(`root grok_submit must have exactly one started/result pair and no other events (started=${started.length}, result=${results.length}, error=${errors.length}, total=${relevant.length})`);
  }
  const start = started[0]!;
  const result = results[0]!;
  if (start.chatId !== result.chatId) throw new Error('grok_submit started/result chatId mismatch');
  if (start.chatId !== expectedChatId) throw new Error('grok_submit receipt belongs to an unexpected chatId');
  if (!Number.isSafeInteger(start.seq) || !Number.isSafeInteger(result.seq) || start.seq >= result.seq) throw new Error('grok_submit started/result sequence is invalid');
  const startData = eventData(start);
  const resultData = eventData(result);
  const invocationId = nonEmptyString(start.invocationId, 'started invocationId');
  if (result.invocationId !== invocationId) throw new Error('grok_submit started/result invocationId mismatch');
  const toolCallId = nonEmptyString(startData.toolCallId, 'started toolCallId');
  if (resultData.toolCallId !== toolCallId) throw new Error('grok_submit started/result toolCallId mismatch');
  const text = nonEmptyString(resultData.text, 'grok_submit result text');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('grok_submit result text must be a JSON array'); }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('grok_submit result must contain exactly three queued tasks');
  const childTaskIds = parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`grok_submit result item ${index} must be an object`);
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'role,status,taskId') throw new Error(`grok_submit result item ${index} has unexpected fields`);
    if (record.role !== 'grok' || record.status !== 'queued') throw new Error(`grok_submit result item ${index} is not a queued Grok task`);
    return nonEmptyString(record.taskId, `grok_submit result item ${index} taskId`);
  });
  if (new Set(childTaskIds).size !== 3) throw new Error('grok_submit result task IDs must be distinct');
  const actual = [...childTaskIds].sort();
  const expected = [...expectedChildTaskIds].sort();
  if (actual.some((id, index) => id !== expected[index])) throw new Error('grok_submit result task IDs do not match the three direct read children');
  return { taskId: rootTaskId, invocationId, toolCallId, childTaskIds };
}

export function validateCancelledAskUserReceipt(
  events: readonly ChatEvent[], chat: ChatRecord, expectedQuestion: string, expectedOptions: readonly string[],
): CancelledAskUserReceipt {
  if (chat.turns.length !== 1 || chat.tasks.length !== 1 || chat.invocations.length !== 1 || chat.tickets.length !== 1) throw new Error('cancel chat must have one turn, task, invocation, and ticket');
  const task = chat.tasks[0]!; const invocation = chat.invocations[0]!; const ticket = chat.tickets[0]!;
  if (chat.turns[0]!.rootTaskId !== task.id || invocation.taskId !== task.id || ticket.taskId !== task.id || ticket.invocationId !== invocation.id) throw new Error('cancel chat task/turn/invocation/ticket binding mismatch');
  if (ticket.type !== 'user' || ticket.status !== 'cancelled' || ticket.question !== expectedQuestion || JSON.stringify(ticket.options) !== JSON.stringify(expectedOptions)) throw new Error('cancel chat ticket mismatch');
  if (invocation.status !== 'exited' || invocation.exitConfirmed !== true) throw new Error('cancel chat invocation exit is not confirmed');
  if (!events.every(event => event.chatId === chat.id)) throw new Error('cancel event stream contains a foreign chatId');
  const toolEvents = events.filter(event => ['tool_started', 'tool_result', 'tool_error'].includes(event.type));
  if (toolEvents.some(event => eventData(event).name !== 'ask_user')) throw new Error('cancel chat used a tool other than ask_user');
  const started = toolEvents.filter(event => event.type === 'tool_started'); const results = toolEvents.filter(event => event.type === 'tool_result');
  if (started.length !== 1 || results.length !== 1 || toolEvents.some(event => event.type === 'tool_error')) throw new Error('cancel chat must have one ask_user started/result pair');
  const start = started[0]!; const result = results[0]!; const startData = eventData(start); const resultData = eventData(result);
  if (start.taskId !== task.id || result.taskId !== task.id || start.invocationId !== invocation.id || result.invocationId !== invocation.id) throw new Error('ask_user pair task/invocation mismatch');
  const toolCallId = nonEmptyString(startData.toolCallId, 'ask_user toolCallId'); if (resultData.toolCallId !== toolCallId) throw new Error('ask_user toolCallId mismatch');
  const questions = events.filter(event => event.type === 'question' && event.taskId === task.id && event.invocationId === invocation.id);
  if (questions.length !== 1) throw new Error('cancel chat must have one persisted question event');
  const question = questions[0]!; const data = eventData(question);
  if (data.id !== ticket.id || data.taskId !== task.id || data.invocationId !== invocation.id || data.status !== 'pending' || data.question !== expectedQuestion || JSON.stringify(data.options) !== JSON.stringify(expectedOptions)) throw new Error('persisted question event does not match ticket');
  if (!(start.seq < question.seq && question.seq < result.seq)) throw new Error('ask_user started/question/result sequence is invalid');
  return { taskId: task.id, invocationId: invocation.id, ticketId: ticket.id, toolCallId, startedSeq: start.seq, questionSeq: question.seq, resultSeq: result.seq };
}
