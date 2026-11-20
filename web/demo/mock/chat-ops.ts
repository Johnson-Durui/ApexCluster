// The runtime actions the scripts use. Each one changes the server record and emits the events the real runtime
// emits for it, in the same order and with the same refs (src/chat/runtime.ts):
//   start      task_updated(running, segment+1) → invocation_started
//   context    context_usage {window, used}
//   usage      api_usage {tokens, usd, unpriced} (running totals)
//   say        stream_delta chunks of 8-40 characters every 60-160 ms of demo time
//   tool       tool_started → (side effects) → tool_result
//   waitFor    task_updated(waiting_children) → waiting(ticket)
//   end        invocation_ended
//   complete   task_updated(completed)
//   resolve    ticket_updated(resolved) → task_updated(queued) of the parent
//   publish    artifact
// Timestamps come from DemoChat.iso(), which is real time when live.
import type { ChatArtifact, ChatMessage, ChatTodo, ChatTurn, TaskStatus, WaitTicket } from '../../src/lib/chat-api';
import { demoFile } from '../scenario/content';
import type { Script } from './chat-scheduler';
import type { DemoChat, ServerInvocation, ServerTask } from './chat-engine';

export interface SeatModel { role: string; model: string; effort: string; window: number; hard: number }

/** Seat and pool models (config/presets/roster.flagship.json). */
export const SEAT = {
  claude: { role: 'claude', model: 'claude-fable-5-2', effort: 'max', window: 1_000_000, hard: 240_000 },
  astra: { role: 'astra', model: 'gpt-6.2-astra', effort: 'max', window: 1_050_000, hard: 240_000 },
  opus: { role: 'opus', model: 'claude-opus-5-5', effort: 'max', window: 1_000_000, hard: 240_000 },
  opusBuild: { role: 'opus', model: 'claude-opus-5-5', effort: 'xhigh', window: 1_000_000, hard: 240_000 },
  carbon: { role: 'carbon', model: 'gemini-4-carbon', effort: 'high', window: 1_048_576, hard: 240_000 },
  sol: { role: 'sol', model: 'gpt-6.2-sol', effort: 'max', window: 1_050_000, hard: 240_000 },
  grok: { role: 'grok', model: 'grok-4.7', effort: 'high', window: 256_000, hard: 128_000 },
  hydrogen: { role: 'hydrogen', model: 'gemini-4-hydrogen', effort: 'high', window: 256_000, hard: 128_000 },
  deepseek: { role: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', window: 256_000, hard: 128_000 },
  mini: { role: 'mini', model: 'claude-haiku-5-5', effort: 'medium', window: 200_000, hard: 100_000 },
} satisfies Record<string, SeatModel>;

const PROMPT_VERSION = 'chat-api-v1-4f9c2e71';
const seatOf = new WeakMap<ServerInvocation, SeatModel>();
const ACTIVE: TaskStatus[] = ['queued', 'running', 'waiting_user', 'waiting_children'];
export const isActive = (task: { status: TaskStatus }) => ACTIVE.includes(task.status);
const round4 = (value: number) => Math.round(value * 10000) / 10000;

export interface TaskSpec {
  turnId: string;
  parent?: ServerTask;
  role: string;
  goal: string;
  mode?: ServerTask['mode'];
  status?: TaskStatus;
  phase?: string;
  groupId?: string;
  clusterId?: string;
  pipelineWork?: ServerTask['pipelineWork'];
  executionReviewOfTaskId?: string;
}

/** Creates a task in the record. No event: the caller emits task_updated when the runtime would. */
export function addTask(chat: DemoChat, spec: TaskSpec): ServerTask {
  const at = chat.iso();
  const workspaceId = chat.record.workspaceId;
  const task: ServerTask = {
    id: chat.rng.uuid(), turnId: spec.turnId, ...(spec.parent ? { parentTaskId: spec.parent.id } : {}),
    role: spec.role, goal: spec.goal, status: spec.status ?? 'queued', createdAt: at, updatedAt: at, segment: 0,
    invocationIds: [], noProgressSegments: 0, ...(workspaceId ? { workspaceId, workspaceVersion: 1 } : {}),
    mode: spec.mode ?? 'read',
    ...(spec.groupId ? { groupId: spec.groupId } : {}),
    ...(spec.phase ? { phase: spec.phase } : {}),
    ...(spec.clusterId ? { clusterId: spec.clusterId } : {}),
    ...(spec.pipelineWork ? { pipelineWork: spec.pipelineWork } : {}),
    ...(spec.executionReviewOfTaskId ? { executionReviewOfTaskId: spec.executionReviewOfTaskId } : {}),
  };
  chat.record.tasks.push(task);
  return task;
}

/** Adds the turn of a root task (the root's status is mirrored into the turn by taskUpdate). */
export function addTurn(chat: DemoChat, root: ServerTask, createdAt = chat.iso()): ChatTurn {
  const turn: ChatTurn = { id: root.turnId, rootTaskId: root.id, status: root.status, createdAt };
  chat.record.turns.push(turn);
  return turn;
}

function syncTurn(chat: DemoChat, task: ServerTask): void {
  if (task.parentTaskId) return;
  const turn = chat.record.turns.find(item => item.rootTaskId === task.id);
  if (!turn) return;
  turn.status = task.status;
  if (isActive(task)) delete turn.completedAt;
  else turn.completedAt ??= task.updatedAt;
}

/** runtime.update(): applies the patch and emits task_updated with the whole task. */
export function taskUpdate(chat: DemoChat, task: ServerTask, patch: Partial<ServerTask> = {}): void {
  Object.assign(task, patch);
  task.updatedAt = chat.iso();
  syncTurn(chat, task);
  chat.emit('task_updated', task, { task });
}

/** START(t, i): task running with a new segment, then invocation_started. */
export function start(chat: DemoChat, task: ServerTask, seat: SeatModel, inputEstimate: number): ServerInvocation {
  const invocation: ServerInvocation = {
    id: chat.rng.uuid(), taskId: task.id, segment: task.segment + 1, status: 'running', startedAt: chat.iso(), toolCount: 0,
    promptVersion: PROMPT_VERSION, inputEstimate, contextWindow: null, contextUsed: null, model: seat.model, effort: seat.effort, contextHard: seat.hard,
  };
  seatOf.set(invocation, seat);
  taskUpdate(chat, task, { status: 'running', segment: invocation.segment, invocationIds: [...task.invocationIds, invocation.id] });
  chat.record.invocations.push(invocation);
  chat.emit('invocation_started', invocation, { task, invocation });
  return invocation;
}

/** context_usage: the invocation's current window and use. */
export function context(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, used: number): void {
  const window = seatOf.get(invocation)?.window ?? invocation.contextWindow ?? 0;
  invocation.contextWindow = window;
  invocation.contextUsed = used;
  chat.emit('context_usage', { window, used }, { task, invocation });
}

/** api_usage: adds to the chat's running totals and emits the totals. */
export function usage(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, tokens: number, usd: number): void {
  const total = chat.record.apiUsage ?? { tokens: 0, usd: 0, unpriced: 0 };
  chat.record.apiUsage = { tokens: total.tokens + Math.round(tokens), usd: round4(total.usd + usd), unpriced: total.unpriced };
  chat.emit('api_usage', chat.record.apiUsage, { task, invocation });
}

/** Sets the chat's usage totals to exact values (the last call of a script, so the totals end on round figures). */
export function usageTo(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, tokens: number, usd: number): void {
  chat.record.apiUsage = { tokens, usd, unpriced: chat.record.apiUsage?.unpriced ?? 0 };
  chat.emit('api_usage', chat.record.apiUsage, { task, invocation });
}

/** Streams `text` as stream_delta events: chunks of 8-40 characters, 60-160 ms of demo time apart. */
export function* say(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, text: string, channel: 'agent' | 'answer' = task.parentTaskId ? 'agent' : 'answer'): Script {
  const characters = Array.from(text);
  let index = 0;
  while (index < characters.length) {
    const size = chat.rng.int(8, 40);
    const chunk = characters.slice(index, index + size).join('');
    index += size;
    const previous = chat.streams.get(invocation.id);
    chat.streams.set(invocation.id, { invocationId: invocation.id, taskId: task.id, role: task.role, text: `${previous?.text ?? ''}${chunk}`, status: 'running' });
    chat.emit('stream_delta', { text: chunk, role: task.role, channel, mode: 'delta' }, { task, invocation });
    yield chat.rng.int(60, 160);
  }
}

/** tool_started; returns the toolCallId ('<invocationId>:<n>'). */
export function toolStart(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, name: string): string {
  invocation.toolCount += 1;
  const toolCallId = `${invocation.id}:${invocation.toolCount}`;
  chat.emit('tool_started', { name, toolCallId }, { task, invocation });
  return toolCallId;
}

export function toolResult(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, toolCallId: string, name: string, text: string): void {
  chat.emit('tool_result', { name, text, toolCallId }, { task, invocation });
}

/** TOOL(t, i, name, text): started, a pause, the side effects, another pause, result. */
export function* tool(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, name: string, text: string, effects?: () => void, ms: [number, number] = [700, 1500]): Script {
  const toolCallId = toolStart(chat, task, invocation, name);
  yield chat.rng.int(ms[0], ms[1]);
  if (effects) {
    effects();
    yield chat.rng.int(250, 500);
  }
  toolResult(chat, task, invocation, toolCallId, name, text);
}

/** WAIT(t, i, ticket): the task waits on children; the ticket is created pending. */
export function waitFor(chat: DemoChat, task: ServerTask, invocation: ServerInvocation | null, spec: { childIds?: string[]; clusterId?: string }): WaitTicket {
  taskUpdate(chat, task, { status: 'waiting_children' });
  const ticket = newTicket(chat, task, invocation, spec);
  chat.emit('waiting', ticket, { task, ...(invocation ? { invocation } : {}) });
  return ticket;
}

/** A pending children ticket in the record, without an event (queueImplementation creates TK5 silently). */
export function newTicket(chat: DemoChat, task: ServerTask, invocation: ServerInvocation | null, spec: { childIds?: string[]; clusterId?: string }): WaitTicket {
  const ticket: WaitTicket & { clusterId?: string } = {
    id: chat.rng.uuid(), taskId: task.id, invocationId: invocation?.id ?? '', type: 'children',
    ...(spec.childIds ? { childIds: spec.childIds } : {}), ...(spec.clusterId ? { clusterId: spec.clusterId } : {}),
    status: 'pending', createdAt: chat.iso(),
  };
  chat.record.tickets.push(ticket);
  return ticket;
}

/** Adds children to a pending ticket (ticket_updated). */
export function extendTicket(chat: DemoChat, ticket: WaitTicket, task: ServerTask, childIds: string[]): void {
  ticket.childIds = [...(ticket.childIds ?? []), ...childIds];
  chat.emit('ticket_updated', ticket, { task });
}

/** A pending question to the user (ask_user): task waiting_user, then the question ticket. */
export function ask(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, question: string, options: string[]): WaitTicket {
  taskUpdate(chat, task, { status: 'waiting_user' });
  const ticket: WaitTicket = { id: chat.rng.uuid(), taskId: task.id, invocationId: invocation.id, type: 'user', question, options, status: 'pending', createdAt: chat.iso() };
  chat.record.tickets.push(ticket);
  chat.emit('question', ticket, { task, invocation });
  return ticket;
}

/** END(t, i): invocation_ended with the final context use and usage. */
export function end(chat: DemoChat, task: ServerTask, invocation: ServerInvocation, options: { used?: number; output: number; finishReason?: string; rotationReason?: string }): void {
  const seat = seatOf.get(invocation);
  invocation.status = 'exited';
  invocation.endedAt = chat.iso();
  invocation.exitConfirmed = true;
  invocation.contextWindow ??= seat?.window ?? null;
  invocation.contextUsed = options.used ?? invocation.contextUsed ?? invocation.inputEstimate;
  invocation.peakUsed = invocation.contextUsed ?? undefined;
  invocation.usage = { input: invocation.contextUsed ?? 0, cachedInput: 0, output: options.output };
  invocation.finishReason = options.finishReason ?? (options.rotationReason ? 'tool_wait' : 'stop');
  if (options.rotationReason) invocation.rotationReason = options.rotationReason;
  const stream = chat.streams.get(invocation.id);
  if (stream) stream.status = 'exited';
  chat.emit('invocation_ended', invocation, { task, invocation });
}

/** DONE(t): the task completes with its result (≤ 2000 characters). */
export function complete(chat: DemoChat, task: ServerTask, result: string, disposition?: ServerTask['disposition']): void {
  taskUpdate(chat, task, {
    status: 'completed', result: result.slice(0, 2000), resultRef: `blobs/result-${task.id}-${task.segment}.txt`,
    ...(disposition ? { disposition } : {}),
  });
}

/** RESOLVE(ticket, parent): the ticket resolves and the parent is queued again. */
export function resolve(chat: DemoChat, ticket: WaitTicket, parent: ServerTask): void {
  ticket.status = 'resolved';
  ticket.resolvedAt = chat.iso();
  chat.emit('ticket_updated', ticket, { task: parent });
  if (!chat.record.tickets.some(item => item.taskId === parent.id && item.status === 'pending')) taskUpdate(chat, parent, { status: 'queued' });
}

/** Publishes a registered file as an artifact of `task` (artifact_publish, or a workspace diff after an edit task). */
export function publish(chat: DemoChat, task: ServerTask, invocation: ServerInvocation | null, key: string, options: { name?: string; provenance?: ChatArtifact['provenance']; snapshots?: boolean } = {}): ChatArtifact {
  const file = demoFile(key);
  const id = chat.rng.uuid();
  const name = options.name ?? file.name;
  const workspaceId = chat.record.workspaceId;
  const artifact: ChatArtifact = {
    id, taskId: task.id, name, relativePath: file.relativePath.startsWith('blobs/') || file.kind === 'diff' ? `blobs/artifact-${id}.txt` : file.relativePath,
    hash: file.sha256, bytes: file.bytes, kind: file.kind, createdAt: chat.iso(), provenance: options.provenance ?? 'model',
    ...(options.snapshots ? { binding: { beforeSnapshotId: `wsnap-${chat.rng.hex(12)}`, afterSnapshotId: `wsnap-${chat.rng.hex(12)}` } } : {}),
    // Only a chat bound to the preset workspace (the pre-baked RoomDesk sample) records its files as saved to it.
    ...(workspaceId === 'w-roomdesk' ? { projectExport: { status: 'saved' as const, path: `D:\\Projects\\roomdesk\\agent-outputs\\${chat.id}\\${name}`, relativePath: `agent-outputs/${chat.id}/${name}`, workspaceId, version: 1, hash: file.sha256 } } : {}),
  };
  chat.record.artifacts.push(artifact);
  chat.artifactFiles.set(id, key);
  chat.emit('artifact', artifact, { task, ...(invocation ? { invocation } : {}) });
  return artifact;
}

/** appendMessage(): adds a message to the record without an event. */
export function appendMessage(chat: DemoChat, spec: Omit<ChatMessage, 'id' | 'seq' | 'createdAt'> & { accepted?: true }): ChatMessage {
  chat.record.messageSeq += 1;
  const message: ChatMessage = { id: chat.rng.uuid(), seq: chat.record.messageSeq, createdAt: chat.iso(), ...spec };
  chat.messages.push(message);
  return message;
}

/** The `message` event. A final root answer clears that root task's stream buffers, as the server does. */
export function emitMessage(chat: DemoChat, message: ChatMessage, refs: { task?: ServerTask; invocation?: ServerInvocation } = {}): void {
  if (message.role === 'assistant' && refs.task && !refs.task.parentTaskId) {
    for (const [key, stream] of chat.streams) if (stream.taskId === refs.task.id) chat.streams.delete(key);
  }
  chat.emit('message', message, refs);
}

/** plan_updated: replaces the chat's whole todo list. */
export function plan(chat: DemoChat, task: ServerTask, invocation: ServerInvocation | null, todos: ChatTodo[]): void {
  chat.record.todos = todos;
  chat.record.planRevision = (chat.record.planRevision ?? 0) + 1;
  chat.emit('plan_updated', { revision: chat.record.planRevision, todos }, { task, ...(invocation ? { invocation } : {}) });
}

/** Any other event (cursor-only types such as cluster_updated or exec_finished). */
export function raw(chat: DemoChat, type: string, data: unknown, task?: ServerTask, invocation?: ServerInvocation): void {
  chat.emit(type, data, { ...(task ? { task } : {}), ...(invocation ? { invocation } : {}) });
}

/**
 * Cancels every live task and pending ticket (runtime.cancel), then state {cancelled:true}. A tool call that was in
 * flight ends with tool_error '已停止' before its invocation ends, as on the server, where the aborted tool throws
 * into the dispatcher's catch (otherwise the row would show 正在调用 forever). The open calls are read from
 * chat.events, so a rebuild that replays the recorded cancel settles exactly the same calls.
 */
export function cancelAll(chat: DemoChat): void {
  chat.sched.clear();
  const running = chat.record.invocations.filter(item => item.status === 'running');
  const runningIds = new Set(running.map(item => item.id));
  const open = new Map<string, { name: string; invocationId: string }>();
  for (const event of chat.events) {
    const data = event.data as { toolCallId?: unknown; name?: unknown } | null;
    const callId = typeof data?.toolCallId === 'string' ? data.toolCallId : null;
    if (!callId) continue;
    if (event.type === 'tool_started' && event.invocationId && runningIds.has(event.invocationId)) open.set(callId, { name: String(data?.name ?? ''), invocationId: event.invocationId });
    else if (event.type === 'tool_result' || event.type === 'tool_error') open.delete(callId);
  }
  for (const invocation of running) {
    const task = chat.record.tasks.find(item => item.id === invocation.taskId);
    if (!task) continue;
    for (const [toolCallId, call] of open) {
      if (call.invocationId === invocation.id) chat.emit('tool_error', { name: call.name, error: '已停止', toolCallId }, { task, invocation });
    }
    end(chat, task, invocation, { output: 0, finishReason: 'cancelled' });
  }
  for (const task of chat.record.tasks.filter(isActive)) taskUpdate(chat, task, { status: 'cancelled' });
  for (const ticket of chat.record.tickets.filter(item => item.status === 'pending')) {
    ticket.status = 'cancelled';
    ticket.resolvedAt = chat.iso();
    const task = chat.record.tasks.find(item => item.id === ticket.taskId);
    chat.emit('ticket_updated', ticket, task ? { task } : {});
  }
  chat.emit('state', { cancelled: true });
}
