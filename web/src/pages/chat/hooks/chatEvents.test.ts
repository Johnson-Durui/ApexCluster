import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api';
import type { ChatRecord, ChatSnapshot } from '../../../lib/chat-api';
import type { ChatAction } from '../chatModel';
import { connectChatEvents, watchFixedDemo, type EventStream } from './chatEvents';
import { canStream } from './useChatStream';

class FakeStream implements EventStream {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, data: string) { this.listeners.get(type)?.({ data } as MessageEvent<string>); }
  open() { this.onopen?.(new Event('open')); }
  fail() { this.onerror?.(new Event('error')); }
}

const record = (seq: number): ChatRecord => ({
  version: 1, id: 'c', title: 'c', createdAt: '', updatedAt: '', seq, messageSeq: 0, turns: [],
  tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
});
const snapshot = (seq: number): ChatSnapshot => ({ chat: record(seq), messages: [], capabilities: [], streams: [] });

function harness(load: (chatId: string) => Promise<ChatSnapshot>) {
  const streams: FakeStream[] = [];
  const actions: ChatAction[] = [];
  const notice = { text: '' };
  const stop = connectChatEvents({
    chatId: 'c', cursor: 4, dispatch: action => actions.push(action), setNotice: text => { notice.text = text; }, load,
    open: url => { const stream = new FakeStream(url); streams.push(stream); return stream; }, onRootUpdate: () => undefined,
  });
  return { streams, actions, notice, stop };
}

describe('live chat events', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clears a reconcile-failure notice once the stream reopens, whatever its wording', async () => {
    const load = vi.fn<(chatId: string) => Promise<ChatSnapshot>>().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(snapshot(9));
    const { streams, actions, notice, stop } = harness(load);
    expect(streams[0].url).toBe('/api/chats/c/events?since=4');
    streams[0].open();
    streams[0].fail();
    expect(notice.text).toBe('实时连接已中断，正在从 REST 快照校准并重连…');
    await vi.advanceTimersByTimeAsync(1200);
    expect(load).toHaveBeenCalledTimes(1);
    expect(notice.text).toBe('Failed to fetch');
    await vi.advanceTimersByTimeAsync(2500);
    expect(streams).toHaveLength(2);
    expect(streams[1].url).toBe('/api/chats/c/events?since=9');
    streams[1].open();
    expect(notice.text).toBe('');
    expect(actions.at(-1)).toEqual({ type: 'connection', connection: 'live' });
    stop();
    expect(streams[1].closed).toBe(true);
  });

  it('clears the proxy 5xx wording the same way', async () => {
    const load = vi.fn<(chatId: string) => Promise<ChatSnapshot>>().mockRejectedValueOnce(new ApiError('Bad Gateway', 502)).mockResolvedValue(snapshot(5));
    const { streams, notice, stop } = harness(load);
    streams[0].fail();
    await vi.advanceTimersByTimeAsync(1200);
    expect(notice.text).toContain('服务暂时不可用（502）');
    await vi.advanceTimersByTimeAsync(2500);
    streams[1].open();
    expect(notice.text).toBe('');
    stop();
  });

  it('clears the recalibration notice after an unreadable event once the stream is back', async () => {
    const { streams, notice, stop } = harness(async () => snapshot(12));
    streams[0].open();
    streams[0].emit('chat_event', '{not json');
    expect(notice.text).toBe('收到了无法识别的实时事件，正在从服务端重新校准。');
    expect(streams[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toHaveLength(2);
    streams[1].open();
    expect(notice.text).toBe('');
    stop();
  });
});

describe('fixed-demo feed', () => {
  it('clears a failed-tick notice on the next good tick, even when nothing visible changed', () => {
    let tick: (snapshot: ChatSnapshot) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const actions: ChatAction[] = [];
    let notice = '';
    const stop = watchFixedDemo({
      chatId: 'demo', dispatch: action => actions.push(action), setNotice: text => { notice = text; }, fingerprint: () => 'same',
      subscribe: (_id, listener, onError) => { tick = listener; fail = onError; return () => undefined; },
    });
    tick(snapshot(1));
    expect(actions.map(action => action.type)).toEqual(['snapshot', 'connection']);
    tick(snapshot(1));
    expect(actions).toHaveLength(2);
    fail(new Error('演示数据读取失败'));
    expect(notice).toBe('演示数据读取失败');
    expect(actions.at(-1)).toEqual({ type: 'connection', connection: 'offline' });
    tick(snapshot(1));
    expect(notice).toBe('');
    expect(actions.at(-1)).toEqual({ type: 'connection', connection: 'live' });
    stop();
  });
});

describe('stream gate', () => {
  it('keeps the stream closed on the quiet first-send hand-off until that chat\'s snapshot has landed', () => {
    // Route already ?chat=X, the in-memory chat is X, no skeleton: the GET is still in flight.
    const handoff = { loading: false, fresh: false, chatId: 'X', selectedId: 'X' };
    expect(canStream({ ...handoff, syncedId: null })).toBe(false);
    expect(canStream({ ...handoff, syncedId: 'W' })).toBe(false);
    expect(canStream({ ...handoff, syncedId: 'X' })).toBe(true);
  });

  it('never streams while loading, for a new chat, or for another chat than the route', () => {
    expect(canStream({ loading: true, fresh: false, chatId: 'X', selectedId: 'X', syncedId: 'X' })).toBe(false);
    expect(canStream({ loading: false, fresh: true, chatId: 'X', selectedId: 'X', syncedId: 'X' })).toBe(false);
    expect(canStream({ loading: false, fresh: false, chatId: 'Y', selectedId: 'X', syncedId: 'X' })).toBe(false);
    expect(canStream({ loading: false, fresh: false, chatId: undefined, selectedId: 'X', syncedId: 'X' })).toBe(false);
  });
});
