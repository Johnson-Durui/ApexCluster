import { describe, expect, it } from 'vitest';
import type { AgentTask, ChatEvent, ChatRecord, ChatSnapshot } from '../../lib/chat-api';
import { activityAnchors, combinedStream, emptyChatState, isSteeringAcknowledgement, pendingUserTicket, publicActivities, reduceChat, visibleStreams } from './chatModel';

const task = (patch: Partial<AgentTask> = {}): AgentTask => ({
  id: 'task-1', turnId: 'turn-1', role: 'sol', goal: '实现功能', status: 'running', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'edit', ...patch,
});
const chat = (patch: Partial<ChatRecord> = {}): ChatRecord => ({
  version: 1, id: 'chat-1', title: '测试', createdAt: '2026-01-01', updatedAt: '2026-01-01', seq: 700, messageSeq: 0,
  turns: [], tasks: [task()], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [], ...patch,
});
const snapshot = (value = chat()): ChatSnapshot => ({ chat: value, messages: [], capabilities: [], nextBefore: 42 });
const event = (seq: number, type: string, data: unknown, extra: Partial<ChatEvent> = {}): ChatEvent => ({ seq, type, data, chatId: 'chat-1', at: '2026-01-01', ...extra });

describe('public activity presentation', () => {
  it('preserves declared plan order when a batch shares the same timestamp', () => {
    const value = chat({ todos: ['z-first', 'a-second'].map(id => ({ id, taskId: 'task-1', text: id, status: 'pending' as const, updatedAt: '2026-01-01T00:00:00Z' })) });
    expect(publicActivities(value, [], 'turn-1').map(item => item.text)).toEqual(['z-first', 'a-second']);
  });

  it('shows pending public plans and anchors a failed turn before the next turn', () => {
    const value = chat({ todos: [{ id: 'todo', taskId: 'task-1', text: '待开始的公开计划', status: 'pending', updatedAt: '' }] });
    expect(publicActivities(value, [], 'turn-1')[0]).toMatchObject({ kind: 'plan', status: 'pending', text: '待开始的公开计划' });
    const anchors = activityAnchors([
      { id: 'failed-user', seq: 1, role: 'user', turnId: 'failed-turn', text: '旧失败任务', createdAt: '' },
      { id: 'next-user', seq: 2, role: 'user', turnId: 'next-turn', text: '新任务', createdAt: '' },
      { id: 'next-final', seq: 3, role: 'assistant', turnId: 'next-turn', text: '完整结果', createdAt: '' },
    ]);
    expect(anchors.get('failed-turn')).toEqual({ messageId: 'failed-user', before: false });
    expect(anchors.get('next-turn')).toEqual({ messageId: 'next-final', before: true });
  });

  it('recovers more than 100 tool summaries after the last 500 events contain only generated deltas', () => {
    const recentEvents = Array.from({ length: 500 }, (_, index) => event(index + 501, 'stream_delta', { text: '生成碎片' }));
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: { ...snapshot(chat({ seq: 1000 })), recentEvents, streams: [] } });
    const history = Array.from({ length: 110 }, (_, index) => event(index + 1, 'tool_result', { name: `工具 ${index}`, toolCallId: `call-${index}`, text: '不保存的工具正文' }, { taskId: 'task-1' }));
    state = reduceChat(state, { type: 'history', chatId: 'chat-1', events: history });
    expect(state.activityTools).toHaveLength(110);
    expect(publicActivities(state.chat!, state.activityTools, 'turn-1')).toHaveLength(110);
    expect(JSON.stringify(state.activityTools)).not.toContain('不保存的工具正文');
    expect(state.eventCursor).toBe(1000);
    expect(reduceChat(state, { type: 'history', chatId: 'other-chat', events: history })).toBe(state);
    state = reduceChat(state, { type: 'event', event: event(1001, 'tool_error', { name: '工具 0', toolCallId: 'call-0', error: '失败' }, { taskId: 'task-1' }) });
    state = reduceChat(state, { type: 'history', chatId: 'chat-1', events: history });
    expect(state.activityTools.find(tool => tool.id === 'call-0')?.status).toBe('failed');
  });

  it('keeps generated output out of progress even when it contains complete sentences', () => {
    const text = '这是尚未完成的结果。\n包含完整句子与代码';
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot() });
    state = reduceChat(state, { type: 'event', event: event(701, 'stream_delta', { text }, { invocationId: 'inv' }) });
    expect(combinedStream(state)).toBe(text);
    expect(JSON.stringify(publicActivities(state.chat!, state.tools, 'turn-1'))).not.toContain(text);
  });

  it('reconstructs public plans and child-agent start/completion without showing child results', () => {
    const child = task({ id: 'child', parentTaskId: 'task-1', status: 'completed', goal: '核对接口', result: '子任务完整结果', createdAt: '2026-01-01T00:00:01Z', updatedAt: '2026-01-01T00:00:03Z' });
    const value = chat({ tasks: [task(), child], todos: [{ id: 'plan', taskId: 'task-1', text: '核查输入与设备协议', status: 'in_progress', updatedAt: '2026-01-01T00:00:02Z' }] });
    const items = publicActivities(value, [], 'turn-1');
    expect(items.map(item => [item.kind, item.status, item.text])).toEqual([
      ['agent', 'running', '核对接口'], ['plan', 'in_progress', '核查输入与设备协议'], ['agent', 'completed', '核对接口'],
    ]);
    expect(JSON.stringify(items)).not.toContain('子任务完整结果');
    expect(publicActivities(value, [], 'other-turn')).toEqual([]);
  });

  it('keeps tool placement stable through completion and resolves invocation-only event identity', () => {
    const invocation = { id: 'inv', taskId: 'task-1', segment: 1, status: 'running' as const, startedAt: '2026-01-01', toolCount: 0, promptVersion: 'v1', inputEstimate: 1, contextWindow: null, contextUsed: null };
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(chat({ invocations: [invocation] })) });
    state = reduceChat(state, { type: 'event', event: event(701, 'tool_started', { name: 'file_read', toolCallId: 'call' }, { invocationId: 'inv', at: '2026-01-01T00:00:01Z' }) });
    const started = publicActivities(state.chat!, state.tools, 'turn-1')[0];
    state = reduceChat(state, { type: 'event', event: event(702, 'tool_result', { name: 'file_read', toolCallId: 'call', text: '不要把工具返回值当进度正文' }, { invocationId: 'inv', at: '2026-01-01T00:00:03Z' }) });
    const completed = publicActivities(state.chat!, state.tools, 'turn-1')[0];
    expect(completed).toMatchObject({ id: started.id, at: started.at, kind: 'tool', text: 'file_read', status: 'completed' });
    expect(JSON.stringify(completed)).not.toContain('不要把工具返回值当进度正文');
  });
});

describe('reducer origin', () => {
  it('records which kind of action produced the state, so only live changes animate', () => {
    let state = emptyChatState();
    expect(state.origin).toBe('initial');
    state = reduceChat(state, { type: 'snapshot', snapshot: snapshot() });
    expect(state.origin).toBe('snapshot');
    state = reduceChat(state, { type: 'event', event: event(701, 'task_updated', task({ status: 'completed' })) });
    expect(state.origin).toBe('event');
    state = reduceChat(state, { type: 'connection', connection: 'live' });
    expect(state.origin).toBe('event');
    state = reduceChat(state, { type: 'chat', chat: { ...state.chat!, seq: 800 } });
    expect(state.origin).toBe('chat');
    state = reduceChat(state, { type: 'snapshot', snapshot: snapshot(chat({ seq: 900 })), origin: 'demo' });
    expect(state.origin).toBe('demo');
    expect(reduceChat(state, { type: 'reset' })).toEqual(emptyChatState());
    // an ignored event keeps the same state object (and its origin)
    expect(reduceChat(state, { type: 'event', event: event(1, 'task_updated', task()) })).toBe(state);
  });
});

describe('steering acknowledgement', () => {
  it('only acknowledges a reply bound to the same chat and active root turn', () => {
    const running = chat({ tasks: [task({ turnId: 'turn-active' })] });
    const history = [{ id: 'root-message', seq: 1, role: 'user' as const, text: '开始任务', createdAt: '2026-01-01', turnId: 'turn-active', clientMessageId: 'client-root' }];
    const reply = { id: 'steering-message', turnId: 'turn-active', clientMessageId: 'client-steering' };
    expect(isSteeringAcknowledgement(running, history, 'chat-1', reply)).toBe(true);
    expect(isSteeringAcknowledgement(running, history, 'chat-1', { ...reply, turnId: 'turn-new' })).toBe(false);
    expect(isSteeringAcknowledgement(running, history, 'chat-2', reply)).toBe(false);
    expect(isSteeringAcknowledgement(chat({ tasks: [task({ status: 'completed' })] }), history, 'chat-1', { ...reply, turnId: 'turn-1' })).toBe(false);
    expect(isSteeringAcknowledgement(chat({ tasks: [] }), [{ ...history[0], turnId: undefined }], 'chat-1', { ...reply, turnId: undefined })).toBe(false);
  });

  it('does not mistake an initial-message retry for steering but accepts a real steering retry', () => {
    const running = chat({ tasks: [task({ turnId: 'turn-active' })] });
    const root = { id: 'root-message', seq: 1, role: 'user' as const, text: '开始任务', createdAt: '2026-01-01', turnId: 'turn-active', clientMessageId: 'client-root' };
    expect(isSteeringAcknowledgement(running, [root], 'chat-1', root)).toBe(false);
    const steering = { id: 'steering-message', seq: 2, role: 'user' as const, text: '补充要求', createdAt: '2026-01-01', turnId: 'turn-active', clientMessageId: 'client-steering' };
    expect(isSteeringAcknowledgement(running, [root, steering], 'chat-1', steering)).toBe(true);
  });
});

describe('chat event reducer', () => {
  it('keeps pipeline stage, usage, fanout and rotation events live', () => {
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(chat({
      pipeline: { preset: 'flagship', stage: 'implementation', revision: 1, gates: { clarify: 'user', architecture: 'user', delivery: 'user' } },
      invocations: [{ id: 'inv', taskId: 'task-1', segment: 1, status: 'running', startedAt: '', toolCount: 0, promptVersion: 'v1', inputEstimate: 1, contextWindow: 1000, contextUsed: 700, contextHard: 800 }],
    })), replayFrom: 0 });
    state = reduceChat(state, { type: 'event', event: event(701, 'fanout_queued', { groupId: 'group', pool: 'hydrogen', count: 3 }, { taskId: 'task-1' }) });
    state = reduceChat(state, { type: 'event', event: event(702, 'api_usage', { tokens: 1234, usd: 0.25, unpriced: 1 }) });
    state = reduceChat(state, { type: 'event', event: event(703, 'context_rotated', { reason: 'hard', nextSegment: 2 }, { taskId: 'task-1', invocationId: 'inv' }) });
    state = reduceChat(state, { type: 'event', event: event(704, 'pipeline_stage', { stage: 'acceptance' }) });
    expect(state.chat?.fanoutGroups).toEqual([{ id: 'group', parentTaskId: 'task-1', pool: 'hydrogen', total: 3 }]);
    expect(state.chat?.apiUsage).toEqual({ tokens: 1234, usd: 0.25, unpriced: 1 });
    expect(state.rotations[0]).toMatchObject({ reason: 'hard', nextSegment: 2, invocationId: 'inv' });
    expect(state.chat?.pipeline?.stage).toBe('acceptance');
  });

  it('uses an independent replay cursor and ignores duplicate or older SSE events', () => {
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(), replayFrom: 200 });
    state = reduceChat(state, { type: 'event', event: event(201, 'stream_delta', { text: '你好' }, { invocationId: 'inv-1' }) });
    const duplicate = reduceChat(state, { type: 'event', event: event(201, 'stream_delta', { text: '重复' }, { invocationId: 'inv-1' }) });
    expect(combinedStream(duplicate)).toBe('你好');
    expect(duplicate.eventCursor).toBe(201);
    expect(duplicate.chat?.seq).toBe(700);
  });

  it('retains tools, restores snapshot artifacts, and updates tickets/tasks/context by server ids', () => {
    const initial = chat({
      artifacts: [{ id: 'saved', taskId: 'task-1', name: 'saved.diff', relativePath: 'a', hash: 'h', bytes: 10, kind: 'diff', createdAt: '2026-01-01' }],
      invocations: [{ id: 'inv-1', taskId: 'task-1', segment: 1, status: 'running', startedAt: '2026-01-01', toolCount: 0, promptVersion: 'v1', inputEstimate: 1, contextWindow: null, contextUsed: null }],
    });
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(initial), replayFrom: 0 });
    state = reduceChat(state, { type: 'event', event: event(1, 'tool_started', { name: 'read_file' }, { taskId: 'task-1', invocationId: 'inv-1' }) });
    state = reduceChat(state, { type: 'event', event: event(2, 'tool_result', { name: 'read_file', text: '读取成功' }, { taskId: 'task-1', invocationId: 'inv-1' }) });
    state = reduceChat(state, { type: 'event', event: event(3, 'task_updated', task({ status: 'waiting_user' })) });
    state = reduceChat(state, { type: 'event', event: event(4, 'question', { id: 'ticket-1', taskId: 'task-1', invocationId: 'inv-1', type: 'user', status: 'pending', createdAt: '2026-01-01', question: '选择？', options: ['A', 'B'] }) });
    state = reduceChat(state, { type: 'event', event: event(5, 'context_usage', { window: 1000, used: 250 }, { invocationId: 'inv-1' }) });
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ status: 'completed', text: '读取成功' });
    expect(state.chat?.artifacts.map(item => item.id)).toEqual(['saved']);
    expect(state.chat?.tasks[0]?.status).toBe('waiting_user');
    expect(pendingUserTicket(state.chat)?.id).toBe('ticket-1');
    expect(state.chat?.invocations[0]?.contextUsed).toBe(250);
  });

  it('pairs concurrent tool completions by invocation identity rather than leaving them running', () => {
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(), replayFrom: 0 });
    state = reduceChat(state, { type: 'event', event: event(1, 'tool_started', { name: 'file_read', toolCallId: 'inv:1' }, { invocationId: 'inv' }) });
    state = reduceChat(state, { type: 'event', event: event(2, 'tool_started', { name: 'file_read', toolCallId: 'inv:2' }, { invocationId: 'inv' }) });
    state = reduceChat(state, { type: 'event', event: event(3, 'tool_result', { name: 'file_read', toolCallId: 'inv:2', text: 'second' }, { invocationId: 'inv' }) });
    state = reduceChat(state, { type: 'event', event: event(4, 'tool_error', { name: 'file_read', toolCallId: 'inv:1', error: 'first failed' }, { invocationId: 'inv' }) });
    expect(state.tools).toHaveLength(2);
    expect(state.tools.find(t => t.id === 'inv:1')).toMatchObject({ status: 'failed', text: 'first failed' });
    expect(state.tools.find(t => t.id === 'inv:2')).toMatchObject({ status: 'completed', text: 'second' });
  });

  it('keeps newer SSE facts when an older POST acknowledgement arrives after them', () => {
    const waiting = { id: 'ticket', taskId: 'task-1', invocationId: 'inv', type: 'user' as const, status: 'pending' as const, createdAt: '' };
    const original = chat({ seq: 0, tasks: [task({ status: 'waiting_user' })], tickets: [waiting] });
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(original), replayFrom: 0 });
    state = reduceChat(state, { type: 'event', event: event(1, 'ticket_updated', { ...waiting, status: 'resolved' }) });
    state = reduceChat(state, { type: 'event', event: event(2, 'task_updated', task({ status: 'completed' })) });
    state = reduceChat(state, { type: 'chat', chat: original });
    expect(pendingUserTicket(state.chat)).toBeUndefined(); expect(state.chat?.tasks[0]?.status).toBe('completed');
    state = reduceChat(state, { type: 'event', event: event(3, 'state', { blockedReason: '测试进程退出未知' }) });
    state = reduceChat(state, { type: 'event', event: event(4, 'test_result', { ticketId: 'test-1', ok: false, text: '真实退出状态待确认' }) });
    expect(state.chat?.blockedReason).toBe('测试进程退出未知'); expect(state.tools[0]).toMatchObject({ name: '受控测试结果', status: 'failed' });
  });

  it('retains each invocation stream through exit and rotation until its matching final message', () => {
    const running = { id: 'inv-1', taskId: 'task-1', segment: 1, status: 'running' as const, startedAt: '2026-01-01', toolCount: 0, promptVersion: 'v1', inputEstimate: 1, contextWindow: null, contextUsed: null };
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(chat({ invocations: [running] })), replayFrom: 0 });
    state = reduceChat(state, { type: 'event', event: event(1, 'stream_delta', { text: '未完成残留' }, { invocationId: 'inv-1' }) });
    state = reduceChat(state, { type: 'event', event: event(2, 'invocation_ended', { ...running, status: 'exited', endedAt: '2026-01-02', contextWindow: 1000, contextUsed: 700, exitConfirmed: true }, { invocationId: 'inv-1' }) });
    expect(combinedStream(state)).toBe('未完成残留');
    expect(visibleStreams(state)[0]).toMatchObject({ invocationId: 'inv-1', taskId: 'task-1', role: 'sol', status: 'exited' });
    expect(state.chat?.invocations[0]).toMatchObject({ status: 'exited', contextUsed: 700, exitConfirmed: true });
    state = reduceChat(state, { type: 'event', event: event(3, 'stream_delta', { text: '新段前残留' }, { invocationId: 'inv-1' }) });
    state = reduceChat(state, { type: 'event', event: event(4, 'context_rotated', {}, { invocationId: 'inv-1' }) });
    expect(combinedStream(state)).toBe('未完成残留新段前残留');
    expect(visibleStreams(state)[0]?.status).toBe('rotated');
    state = reduceChat(state, { type: 'event', event: event(5, 'message', { id: 'm-final', seq: 1, role: 'assistant', text: '最终回答', createdAt: '2026-01-02', taskId: 'task-1' }, { taskId: 'task-1', invocationId: 'inv-1' }) });
    expect(visibleStreams(state)).toEqual([]);
  });

  it('restores independent streams from snapshots and never mixes a different chat', () => {
    const first = { ...snapshot(), streams: [{ invocationId: 'inv-sol', taskId: 'task-1', role: 'sol' as const, text: 'Sol 正在工作', status: 'running' as const }] };
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: first, replayFrom: 10 });
    state = reduceChat(state, { type: 'event', event: event(701, 'stream_delta', { text: ' + Claude' }, { taskId: 'task-2', invocationId: 'inv-claude' }) });
    expect(visibleStreams(state).map(stream => stream.invocationId)).toEqual(['inv-sol', 'inv-claude']);
    const other = chat({ id: 'chat-2', tasks: [task({ id: 'other-task', role: 'grok' })], seq: 0 });
    state = reduceChat(state, { type: 'snapshot', snapshot: { ...snapshot(other), streams: [{ invocationId: 'inv-grok', taskId: 'other-task', role: 'grok', text: '整段结果', status: 'exited' }] }, replayFrom: 0 });
    expect(state.chat?.id).toBe('chat-2');
    expect(visibleStreams(state)).toEqual([{ invocationId: 'inv-grok', taskId: 'other-task', role: 'grok', text: '整段结果', status: 'exited' }]);
    const wrongChatEvent = { ...event(12, 'stream_delta', { text: '串流' }, { invocationId: 'old' }), chatId: 'chat-1' };
    expect(reduceChat(state, { type: 'event', event: wrongChatEvent })).toBe(state);
  });

  it('clears every old root segment on its final message without deleting a different task stream', () => {
    const streams = [
      { invocationId: 'inv-a', taskId: 'task-1', role: 'sol' as const, text: 'A', status: 'exited' as const },
      { invocationId: 'inv-old', taskId: 'task-1', role: 'claude' as const, text: '旧段', status: 'exited' as const },
      { invocationId: 'inv-b', taskId: 'task-2', role: 'astra' as const, text: 'B', status: 'running' as const },
    ];
    const tasks = [task(), task({ id: 'task-2', parentTaskId: 'task-1', role: 'astra' })];
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: { ...snapshot(chat({ seq: 0, tasks })), streams }, replayFrom: 0 });
    state = reduceChat(state, { type: 'event', event: event(1, 'message', { id: 'm-a', seq: 1, role: 'assistant', text: 'A 最终结果', createdAt: '2026-01-02', taskId: 'task-1' }, { taskId: 'task-1', invocationId: 'inv-a' }) });
    expect(visibleStreams(state)).toEqual([streams[2]]);
  });

  it('uses complete snapshot streams as the cursor and recent events only for tool reconstruction', () => {
    const complete = { ...snapshot(chat({ seq: 10 })), streams: [{ invocationId: 'inv-1', taskId: 'task-1', role: 'sol' as const, text: '完整文本', status: 'running' as const }], recentEvents: [
      event(7, 'stream_delta', { text: '不应重放' }, { invocationId: 'inv-1', taskId: 'task-1' }),
      event(8, 'tool_started', { name: 'file_read', toolCallId: 'tool-1' }, { invocationId: 'inv-1' }),
      event(9, 'tool_result', { name: 'file_read', toolCallId: 'tool-1', text: '已读取' }, { invocationId: 'inv-1' }),
    ] };
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: complete, replayFrom: 0 });
    expect(state.eventCursor).toBe(10);
    expect(combinedStream(state)).toBe('完整文本');
    expect(state.tools).toEqual([expect.objectContaining({ id: 'tool-1', status: 'completed', text: '已读取' })]);
    state = reduceChat(state, { type: 'event', event: event(9, 'stream_delta', { text: '重复' }, { invocationId: 'inv-1' }) });
    expect(combinedStream(state)).toBe('完整文本');
  });

  it('updates attachments and program todos idempotently from SSE', () => {
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: snapshot(chat({ attachments: [], todos: [] })), replayFrom: 0 });
    const attachment = { id: 'a1', name: '需求.md', bytes: 20, hash: 'hash', mime: 'text/markdown', createdAt: '2026-01-01', source: 'upload' as const };
    state = reduceChat(state, { type: 'event', event: event(1, 'attachment', attachment) });
    state = reduceChat(state, { type: 'event', event: event(2, 'attachment', attachment) });
    state = reduceChat(state, { type: 'event', event: event(3, 'plan_updated', { todos: [{ id: 'todo-1', taskId: 'task-1', text: '核对需求', status: 'in_progress', updatedAt: '2026-01-01' }] }) });
    expect(state.chat?.attachments).toEqual([attachment]);
    expect(state.chat?.todos).toHaveLength(1);
    expect(state.chat?.todos?.[0]?.status).toBe('in_progress');
    state = reduceChat(state, { type: 'event', event: event(4, 'attachment_removed', { id: 'a1' }) });
    expect(state.chat?.attachments).toEqual([]);
  });

  it('deduplicates REST pages and direct POST acknowledgements without losing pagination', () => {
    const message = { id: 'm1', seq: 1, role: 'user' as const, text: '草稿', createdAt: '2026-01-01' };
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: { ...snapshot(), messages: [message] }, replayFrom: 0 });
    state = reduceChat(state, { type: 'message', message });
    state = reduceChat(state, { type: 'older', page: { items: [message], nextBefore: 8 } });
    expect(state.messages).toEqual([message]);
    expect(state.nextBefore).toBe(8);
  });
});
