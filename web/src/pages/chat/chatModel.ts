import type {
  AgentTask, ChatArtifact, ChatAttachment, ChatEvent, ChatMessage, ChatPipelineStage, ChatRecord, ChatSnapshot, ChatStream, ChatTodo,
  DriverCapability, Invocation, WaitTicket,
} from '../../lib/chat-api';
import type { RotationNotice } from './PipelineStatus';

export type ConnectionState = 'connecting' | 'live' | 'recovering' | 'offline';
/**
 * What produced the current state: a live SSE event, a POST response ('chat'), fixed-demo playback ('demo'),
 * or a snapshot load/reconcile. Motion runs only for 'event' | 'chat' | 'demo' (BUILD-SPEC-B §1.9).
 */
export type ChatOrigin = 'initial' | 'snapshot' | 'event' | 'chat' | 'demo';
export const isLiveOrigin = (origin: ChatOrigin): boolean => origin === 'event' || origin === 'chat' || origin === 'demo';
export interface ToolEvidence {
  id: string; seq: number; taskId?: string; invocationId?: string;
  name: string; status: 'running' | 'completed' | 'failed'; text?: string; at: string;
  startedAt?: string;
}
export interface ChatState {
  chat: ChatRecord | null; messages: ChatMessage[]; nextBefore?: number;
  streams: Record<string, ChatStream>; tools: ToolEvidence[]; activityTools: ToolEvidence[]; eventCursor: number;
  capabilities: DriverCapability[]; connection: ConnectionState;
  rotations: RotationNotice[];
  origin: ChatOrigin;
}
export type ChatAction =
  | { type: 'reset' }
  | { type: 'snapshot'; snapshot: ChatSnapshot; replayFrom?: number; origin?: 'demo' }
  | { type: 'older'; page: { items: ChatMessage[]; nextBefore?: number } }
  | { type: 'message'; message: ChatMessage }
  | { type: 'event'; event: ChatEvent }
  | { type: 'history'; chatId: string; events: ChatEvent[] }
  | { type: 'chat'; chat: ChatRecord }
  | { type: 'connection'; connection: ConnectionState };

const streamKey = (event: ChatEvent) => event.invocationId ?? event.taskId ?? 'root';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const hasString = (value: unknown, key: string): value is Record<string, string> => isRecord(value) && typeof value[key] === 'string';
const byMessageSeq = (a: ChatMessage, b: ChatMessage) => a.seq - b.seq;
function uniqueMessages(values: ChatMessage[]): ChatMessage[] {
  return [...new Map(values.map(message => [message.id, message])).values()].sort(byMessageSeq);
}
function replaceById<T extends { id: string }>(values: T[], value: T): T[] {
  const index = values.findIndex(item => item.id === value.id);
  if (index < 0) return [...values, value];
  const next = [...values]; next[index] = { ...next[index], ...value }; return next;
}
function eventChat(state: ChatState, patch: Partial<ChatRecord>): ChatRecord | null {
  return state.chat ? { ...state.chat, ...patch, seq: Math.max(state.chat.seq, patch.seq ?? state.chat.seq) } : null;
}
function ticketFrom(value: unknown): WaitTicket | null {
  return hasString(value, 'id') && hasString(value, 'taskId') && hasString(value, 'invocationId') ? value as unknown as WaitTicket : null;
}
function taskFrom(value: unknown): AgentTask | null { return hasString(value, 'id') ? value as unknown as AgentTask : null; }
function invocationFrom(value: unknown): Invocation | null { return hasString(value, 'id') ? value as unknown as Invocation : null; }
function artifactFrom(value: unknown): ChatArtifact | null { return hasString(value, 'id') ? value as unknown as ChatArtifact : null; }
function attachmentFrom(value: unknown): ChatAttachment | null { return hasString(value, 'id') && hasString(value, 'name') ? value as unknown as ChatAttachment : null; }
function messageFrom(value: unknown): ChatMessage | null { return hasString(value, 'id') && typeof value.seq === 'number' ? value as unknown as ChatMessage : null; }
function streamRecord(values: ChatStream[] = []): Record<string, ChatStream> { return Object.fromEntries(values.map(stream => [stream.invocationId, stream])); }
function appendToolEvidence(tools: ToolEvidence[], event: ChatEvent, metadataOnly = false): ToolEvidence[] {
  const data = event.data;
  if (event.type === 'test_result' && isRecord(data)) {
    const evidence: ToolEvidence = { id: `test:${typeof data.ticketId === 'string' ? data.ticketId : event.seq}`, seq: event.seq, taskId: event.taskId, invocationId: event.invocationId, name: '受控测试结果', status: data.ok === true ? 'completed' : 'failed', text: typeof data.text === 'string' ? data.text : undefined, at: event.at };
    if (metadataOnly) delete evidence.text;
    const updated = replaceById(tools, evidence);
    return metadataOnly ? updated : updated.slice(-100);
  }
  if (event.type !== 'tool_started' && event.type !== 'tool_result' && event.type !== 'tool_error') return tools;
  const name = isRecord(data) && typeof data.name === 'string' ? data.name : '未命名工具';
  const text = metadataOnly ? undefined : isRecord(data) && typeof data.text === 'string' ? data.text : isRecord(data) && typeof data.error === 'string' ? data.error : undefined;
  const status = event.type === 'tool_started' ? 'running' : event.type === 'tool_error' ? 'failed' : 'completed';
  const callId = isRecord(data) && typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
  const previous = callId ? tools.find(tool => tool.id === callId) : status === 'running' ? undefined : tools.findLast(tool => tool.name === name && tool.invocationId === event.invocationId && tool.status === 'running');
  const id = callId ?? previous?.id ?? `${event.seq}`;
  const updated = replaceById(tools, { id, seq: event.seq, taskId: event.taskId, invocationId: event.invocationId, name, status, text, at: event.at, startedAt: previous?.startedAt ?? previous?.at ?? event.at });
  return metadataOnly ? updated : updated.slice(-100);
}

function restoreActivityTools(current: ToolEvidence[], events: ChatEvent[]): ToolEvidence[] {
  const restored = events.reduce((tools, event) => appendToolEvidence(tools, event, true), [] as ToolEvidence[]);
  const merged = new Map(current.map(tool => [tool.id, tool]));
  for (const tool of restored) {
    const previous = merged.get(tool.id);
    const latest = previous && previous.seq > tool.seq ? previous : tool;
    const starts = [previous?.startedAt, tool.startedAt].filter((at): at is string => !!at).sort();
    merged.set(tool.id, { ...latest, startedAt: starts[0] ?? latest.at });
  }
  return [...merged.values()];
}

export function emptyChatState(): ChatState {
  return { chat: null, messages: [], streams: {}, tools: [], activityTools: [], eventCursor: 0, capabilities: [], connection: 'connecting', rotations: [], origin: 'initial' };
}

function snapshotRotations(snapshot: ChatSnapshot): RotationNotice[] {
  return snapshot.chat.invocations.filter(item => item.rotationReason).map(item => ({
    id: `invocation:${item.id}`, taskId: item.taskId, invocationId: item.id, reason: item.rotationReason!, nextSegment: item.segment + 1,
    at: item.endedAt ?? item.startedAt,
  })).slice(-20);
}

const ACTION_ORIGIN: Record<ChatAction['type'], ChatOrigin | null> = {
  reset: 'initial', snapshot: 'snapshot', older: 'snapshot', history: 'snapshot', message: 'chat', chat: 'chat', event: 'event', connection: null,
};

/** The reducer. It records which kind of action produced the state (`origin`) so motion can tell live changes from loads. */
export function reduceChat(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'reset') return emptyChatState();
  const next = reduceChatRecord(state, action);
  if (next === state) return state;
  const origin = action.type === 'snapshot' && action.origin === 'demo' ? 'demo' : ACTION_ORIGIN[action.type];
  return origin === null || next.origin === origin ? next : { ...next, origin };
}

function reduceChatRecord(state: ChatState, action: Exclude<ChatAction, { type: 'reset' }>): ChatState {
  if (action.type === 'history') {
    if (state.chat?.id !== action.chatId) return state;
    return { ...state, activityTools: restoreActivityTools(state.activityTools, action.events.filter(event => event.chatId === action.chatId && event.seq <= state.eventCursor)) };
  }
  if (action.type === 'connection') return { ...state, connection: action.connection };
  if (action.type === 'chat') {
    if (state.chat && (state.chat.id !== action.chat.id || action.chat.seq < state.chat.seq)) return state;
    return { ...state, chat: action.chat };
  }
  if (action.type === 'snapshot') {
    const sameChat = state.chat?.id === action.snapshot.chat.id;
    const completeStreams = action.snapshot.streams !== undefined;
    const tools = action.snapshot.recentEvents ? action.snapshot.recentEvents.reduce((tools, event) => appendToolEvidence(tools, event), [] as ToolEvidence[]) : sameChat ? state.tools : [];
    return {
    ...(sameChat ? state : emptyChatState()),
    chat: action.snapshot.chat,
    messages: sameChat ? uniqueMessages([...state.messages, ...action.snapshot.messages]) : uniqueMessages(action.snapshot.messages),
    streams: action.snapshot.streams ? streamRecord(action.snapshot.streams) : sameChat ? state.streams : {},
    tools,
    activityTools: restoreActivityTools(sameChat ? state.activityTools : [], action.snapshot.recentEvents ?? []),
    nextBefore: action.snapshot.nextBefore,
    capabilities: action.snapshot.capabilities,
    rotations: snapshotRotations(action.snapshot),
    eventCursor: completeStreams ? action.snapshot.chat.seq : action.replayFrom ?? (sameChat ? state.eventCursor : 0),
  };
  }
  if (action.type === 'message') return { ...state, messages: uniqueMessages([...state.messages, action.message]) };
  if (action.type === 'older') return { ...state, messages: uniqueMessages([...action.page.items, ...state.messages]), nextBefore: action.page.nextBefore };

  const event = action.event;
  if (state.chat && event.chatId !== state.chat.id) return state;
  if (event.seq <= state.eventCursor) return state;
  const base = { ...state, eventCursor: event.seq };
  const data = event.data;
  if (event.type === 'stream_delta') {
    const text = typeof data === 'string' ? data : isRecord(data) && typeof data.text === 'string' ? data.text : '';
    const key = streamKey(event);
    const invocationTaskId = state.chat?.invocations.find(item => item.id === event.invocationId)?.taskId;
    const task = state.chat?.tasks.find(item => item.id === (event.taskId ?? invocationTaskId)) ?? state.chat?.tasks.find(item => item.invocationIds.includes(event.invocationId ?? ''));
    const previous = state.streams[key];
    const stream: ChatStream = { invocationId: event.invocationId ?? key, taskId: event.taskId ?? previous?.taskId ?? task?.id ?? key, role: previous?.role ?? task?.role ?? 'claude', text: `${previous?.text ?? ''}${text}`, status: 'running' };
    return { ...base, streams: { ...state.streams, [key]: stream } };
  }
  if (event.type === 'message') {
    const message = messageFrom(data);
    if (!message) return base;
    const streams = { ...state.streams };
    const finalTaskId = event.taskId ?? message.taskId;
    const finalTask = state.chat?.tasks.find(task => task.id === finalTaskId);
    for (const [key, stream] of Object.entries(streams)) {
      const matches = finalTask && !finalTask.parentTaskId ? stream.taskId === finalTask.id : event.invocationId ? stream.invocationId === event.invocationId : !!finalTaskId && stream.taskId === finalTaskId;
      if (matches) delete streams[key];
    }
    return { ...base, messages: uniqueMessages([...state.messages, message]), streams };
  }
  if (event.type === 'task_updated') {
    const task = taskFrom(data);
    return task && state.chat ? { ...base, chat: eventChat(state, { tasks: replaceById(state.chat.tasks, task), seq: event.seq }) } : base;
  }
  if (event.type === 'invocation_started') {
    const invocation = invocationFrom(data);
    return invocation && state.chat ? { ...base, chat: eventChat(state, { invocations: replaceById(state.chat.invocations, invocation), seq: event.seq }) } : base;
  }
  if (event.type === 'invocation_ended') {
    const invocation = invocationFrom(data);
    if (!invocation || !state.chat) return base;
    const streams = { ...state.streams };
    const key = event.invocationId ?? invocation.id;
    if (streams[key]) streams[key] = { ...streams[key], status: invocation.status };
    return { ...base, streams, chat: eventChat(state, { invocations: replaceById(state.chat.invocations, invocation), seq: event.seq }) };
  }
  if (event.type === 'context_rotated') {
    if (!event.invocationId) return base;
    const streams = { ...state.streams };
    if (streams[event.invocationId]) streams[event.invocationId] = { ...streams[event.invocationId], status: 'rotated' };
    const invocation = state.chat?.invocations.find(item => item.id === event.invocationId);
    const reason = isRecord(data) && typeof data.reason === 'string' ? data.reason : invocation?.rotationReason ?? 'yield';
    const nextSegment = isRecord(data) && typeof data.nextSegment === 'number' ? data.nextSegment : invocation ? invocation.segment + 1 : undefined;
    const notice: RotationNotice = { id: `event:${event.seq}`, taskId: event.taskId ?? invocation?.taskId, invocationId: event.invocationId, reason, nextSegment, at: event.at };
    return { ...base, streams, rotations: [...state.rotations, notice].slice(-20) };
  }
  if (event.type === 'context_usage' && state.chat && event.invocationId && isRecord(data)) {
    const contextWindow = typeof data.window === 'number' ? data.window : null;
    const contextUsed = typeof data.used === 'number' ? data.used : null;
    const invocations = state.chat.invocations.map(item => item.id === event.invocationId ? { ...item, contextWindow, contextUsed } : item);
    return { ...base, chat: eventChat(state, { invocations, seq: event.seq }) };
  }
  if (event.type === 'question' || event.type === 'waiting' || event.type === 'ticket_updated') {
    const ticket = ticketFrom(data);
    return ticket && state.chat ? { ...base, chat: eventChat(state, { tickets: replaceById(state.chat.tickets, ticket), seq: event.seq }) } : base;
  }
  if (event.type === 'test_result') return { ...base, tools: appendToolEvidence(state.tools, event), activityTools: appendToolEvidence(state.activityTools, event, true) };
  if (event.type === 'artifact') {
    const artifact = artifactFrom(data);
    return artifact && state.chat ? { ...base, chat: eventChat(state, { artifacts: replaceById(state.chat.artifacts, artifact), seq: event.seq }) } : base;
  }
  if (event.type === 'attachment') {
    const attachment = attachmentFrom(data);
    return attachment && state.chat ? { ...base, chat: eventChat(state, { attachments: replaceById(state.chat.attachments ?? [], attachment), seq: event.seq }) } : base;
  }
  if (event.type === 'attachment_removed' && state.chat) {
    const id = typeof data === 'string' ? data : isRecord(data) && typeof data.id === 'string' ? data.id : '';
    return id ? { ...base, chat: eventChat(state, { attachments: (state.chat.attachments ?? []).filter(item => item.id !== id), seq: event.seq }) } : base;
  }
  if (event.type === 'plan_updated' && state.chat && isRecord(data) && Array.isArray(data.todos)) {
    return { ...base, chat: eventChat(state, { todos: data.todos as ChatTodo[], seq: event.seq }) };
  }
  if (event.type === 'pipeline_gate_opened' && state.chat?.pipeline && isRecord(data)) {
    const stage = data.gateId === 'A' ? 'gate-a' : data.gateId === 'B' ? 'gate-b' : state.chat.pipeline.stage;
    return { ...base, chat: eventChat(state, { pipeline: { ...state.chat.pipeline, stage }, seq: event.seq }) };
  }
  if (event.type === 'pipeline_gate_decided' && state.chat?.pipeline && isRecord(data)) {
    const gate = data.gateId; const decision = data.decision;
    const stage = decision === 'cancel' ? 'cancelled' : gate === 'A' ? decision === 'confirm' ? 'implementation' : 'architecture' : decision === 'confirm' ? 'completed' : 'implementation';
    return { ...base, chat: eventChat(state, { pipeline: { ...state.chat.pipeline, stage }, seq: event.seq }) };
  }
  if (event.type === 'implementation_updated' && state.chat?.pipeline && isRecord(data) && Array.isArray(data.milestones)) {
    const implementation = { milestones: data.milestones as Array<{ id: string; status: string }>, ...(typeof data.error === 'string' ? { error: data.error } : {}) };
    return { ...base, chat: eventChat(state, { pipeline: { ...state.chat.pipeline, implementation }, seq: event.seq }) };
  }
  if (event.type === 'pipeline_stage' && state.chat?.pipeline && isRecord(data) && typeof data.stage === 'string' &&
    ['architecture', 'gate-a', 'implementation', 'acceptance', 'gate-b', 'completed', 'cancelled'].includes(data.stage)) {
    return { ...base, chat: eventChat(state, { pipeline: { ...state.chat.pipeline, stage: data.stage as ChatPipelineStage }, seq: event.seq }) };
  }
  if (event.type === 'api_usage' && state.chat && isRecord(data) && typeof data.tokens === 'number' && typeof data.usd === 'number' && typeof data.unpriced === 'number') {
    return { ...base, chat: eventChat(state, { apiUsage: { tokens: data.tokens, usd: data.usd, unpriced: data.unpriced }, seq: event.seq }) };
  }
  if (event.type === 'fanout_queued' && state.chat && isRecord(data) && typeof data.groupId === 'string' && typeof data.pool === 'string' && typeof data.count === 'number' && event.taskId) {
    const fanout = { id: data.groupId, parentTaskId: event.taskId, pool: data.pool, total: data.count };
    return { ...base, chat: eventChat(state, { fanoutGroups: replaceById(state.chat.fanoutGroups ?? [], fanout), seq: event.seq }) };
  }
  if (event.type === 'tool_started' || event.type === 'tool_result' || event.type === 'tool_error') {
    return { ...base, tools: appendToolEvidence(state.tools, event), activityTools: appendToolEvidence(state.activityTools, event, true) };
  }
  if (event.type === 'state' && isRecord(data)) {
    const chat = (isRecord(data.chat) ? data.chat : data) as unknown as ChatRecord;
    if (typeof chat.id === 'string') return { ...base, chat };
    if (typeof data.blockedReason === 'string') return { ...base, chat: eventChat(state, { blockedReason: data.blockedReason, seq: event.seq }) };
  }
  return base;
}

export const activeTask = (task: AgentTask): boolean => ['queued', 'running', 'waiting_user', 'waiting_children'].includes(task.status);
export function isSteeringAcknowledgement(requestChat: ChatRecord | null, requestMessages: ChatMessage[], responseChatId: string, responseMessage: Pick<ChatMessage, 'id' | 'turnId' | 'clientMessageId'>): boolean {
  const activeRoots = requestChat?.tasks.filter(task => !task.parentTaskId && activeTask(task)) ?? [];
  const activeTurnId = activeRoots.length === 1 ? activeRoots[0].turnId : undefined;
  const earlierUserMessage = requestMessages.some(message => message.role === 'user' && message.turnId === activeTurnId && message.id !== responseMessage.id && message.clientMessageId !== responseMessage.clientMessageId);
  return requestChat !== null && requestChat.id === responseChatId && activeTurnId !== undefined && activeTurnId === responseMessage.turnId && earlierUserMessage;
}
export const pendingUserTicket = (chat: ChatRecord | null): WaitTicket | undefined => chat?.tickets.find(ticket => ticket.type === 'user' && ticket.status === 'pending');
export const visibleStreams = (state: ChatState): ChatStream[] => Object.values(state.streams).filter(stream => !!stream.text);
export const combinedStream = (state: ChatState): string => visibleStreams(state).map(stream => stream.text).join('\n');

export interface PublicActivity {
  id: string; kind: 'agent' | 'tool' | 'plan'; text: string; at: string;
  status: AgentTask['status'] | ChatTodo['status']; role?: AgentTask['role'];
}

/** Only public plans and execution metadata belong here. Generated text stays in streams until final delivery. */
export function publicActivities(chat: ChatRecord, tools: ToolEvidence[], turnId: string): PublicActivity[] {
  const tasks = chat.tasks.filter(task => task.turnId === turnId);
  const taskIds = new Set(tasks.map(task => task.id));
  const items: PublicActivity[] = [];
  for (const task of tasks.filter(task => task.parentTaskId)) {
    const invocation = chat.invocations.find(invocation => invocation.taskId === task.id);
    const started = !!invocation || ['running', 'waiting_user', 'waiting_children', 'completed'].includes(task.status);
    items.push({ id: `task:${task.id}:start`, kind: 'agent', text: task.goal, role: task.role, status: started ? 'running' : 'queued', at: invocation?.startedAt ?? task.createdAt });
    if (!['queued', 'running'].includes(task.status)) items.push({ id: `task:${task.id}:state`, kind: 'agent', text: task.goal, role: task.role, status: task.status, at: task.updatedAt });
  }
  for (const todo of chat.todos ?? []) {
    if (taskIds.has(todo.taskId)) items.push({ id: `plan:${todo.id}`, kind: 'plan', text: todo.text, status: todo.status, at: todo.updatedAt });
  }
  for (const tool of tools) {
    const taskId = tool.taskId ?? chat.invocations.find(invocation => invocation.id === tool.invocationId)?.taskId ?? tasks.find(task => task.invocationIds.includes(tool.invocationId ?? ''))?.id;
    if (taskId && taskIds.has(taskId)) items.push({ id: `tool:${tool.id}`, kind: 'tool', text: tool.name, status: tool.status, at: tool.startedAt ?? tool.at, role: tasks.find(task => task.id === taskId)?.role });
  }
  const timestamp = (value: string) => Date.parse(value) || 0;
  return items.sort((a, b) => timestamp(a.at) - timestamp(b.at));
}

export function activityAnchors(messages: ChatMessage[]): Map<string, { messageId: string; before: boolean }> {
  const anchors = new Map<string, { messageId: string; before: boolean }>();
  for (const message of messages) {
    if (!message.turnId || anchors.get(message.turnId)?.before) continue;
    anchors.set(message.turnId, { messageId: message.id, before: message.role === 'assistant' });
  }
  return anchors;
}
