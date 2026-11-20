import { describe, expect, it, vi, afterEach } from 'vitest';
import { subscribeRun, type EventConnection } from './events';
afterEach(() => vi.useRealTimers());
describe('SSE 断线与补发', () => {
  it('从最近序号重连，过滤重复事件、校准事实状态并在取消时关闭', () => {
    vi.useFakeTimers();
    const sources: { url: string; connection: EventConnection; listeners: Record<string, (event: MessageEvent) => void> }[] = [];
    const events = vi.fn();
    const opened = vi.fn();
    const stop = subscribeRun('r-test', events, vi.fn(), url => {
      const listeners: Record<string, (event: MessageEvent) => void> = {};
      const connection = { addEventListener: (name: string, cb: (event: MessageEvent) => void) => { listeners[name] = cb; }, close: vi.fn(), onopen: null, onerror: null } as EventConnection;
      sources.push({ url, connection, listeners }); return connection;
    }, opened);
    expect(sources[0].url).toContain('since=0');
    sources[0].connection.onopen!();
    expect(opened).toHaveBeenCalledOnce();
    const payload = (seq: number) => ({ data: JSON.stringify({ seq, runId: 'r-test', type: 'question.added', payload: {}, at: '' }) }) as MessageEvent;
    sources[0].listeners['question.added'](payload(7));
    sources[0].connection.onerror!();
    sources[0].connection.onerror!();
    expect(sources[0].connection.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(800);
    expect(sources[1].url).toContain('since=7');
    sources[1].connection.onopen!();
    expect(opened).toHaveBeenCalledTimes(2);
    sources[1].listeners['question.added'](payload(7));
    sources[1].listeners['question.added'](payload(8));
    expect(events).toHaveBeenCalledTimes(2);
    stop();
    sources[1].listeners['question.added'](payload(9));
    sources[1].connection.onopen!();
    expect(events).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenCalledTimes(2);
    sources[1].connection.onerror!();
    expect(sources[1].connection.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20000);
    expect(sources).toHaveLength(2);
  });

  it('安全忽略损坏、跨运行和类型不匹配的事件，且不消耗序号', () => {
    const events = vi.fn();
    let source!: { connection: EventConnection; listeners: Record<string, (event: MessageEvent) => void> };
    const states = vi.fn();
    const invalid = vi.fn();
    const stop = subscribeRun('r-test', events, states, () => {
      const listeners: Record<string, (event: MessageEvent) => void> = {};
      const connection = { addEventListener: (name: string, cb: (event: MessageEvent) => void) => { listeners[name] = cb; }, close: vi.fn(), onopen: null, onerror: null } as EventConnection;
      source = { connection, listeners }; return connection;
    }, undefined, invalid);
    const send = (data: unknown) => source.listeners['question.added']({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent);
    send('{');
    send({ seq: 9, runId: 'r-other', type: 'question.added', payload: {}, at: '' });
    send({ seq: 9, runId: 'r-test', type: 'run.updated', payload: {}, at: '' });
    send({ seq: 9, runId: 'r-test', type: 'question.added', at: '' });
    send({ seq: 1.5, runId: 'r-test', type: 'question.added', payload: {}, at: '' });
    send({ seq: 9, runId: 'r-test', type: 'question.added', payload: {}, at: '' });
    expect(events).toHaveBeenCalledOnce();
    expect(invalid).toHaveBeenCalledTimes(3);
    expect(states).toHaveBeenCalledWith('事件格式异常，正在校准');
    stop();
  });

  it('不推进损坏进度的序号，允许同序号正确事件重放', () => {
    const events = vi.fn(); const invalid = vi.fn();
    let listener!: (event: MessageEvent) => void;
    const stop = subscribeRun('r-test', events, vi.fn(), () => {
      const connection = { addEventListener: (name: string, cb: (event: MessageEvent) => void) => { if (name === 'task.progress') listener = cb; }, close: vi.fn(), onopen: null, onerror: null } as EventConnection;
      return connection;
    }, undefined, invalid);
    const send = (payload: unknown) => listener({ data: JSON.stringify({ seq: 12, runId: 'r-test', type: 'task.progress', payload, at: '' }) } as MessageEvent);
    send({ taskId: 'task-1', progress: { at: '', text: { unsafe: true }, kind: 'message' } });
    send({ taskId: 'task-1', progress: { at: '', text: '安全文本', kind: 'message' } });
    expect(invalid).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledOnce();
    expect(events.mock.calls[0][0].seq).toBe(12);
    stop();
  });

  it('不吞掉应用事件回调抛出的异常', () => {
    let listener!: (event: MessageEvent) => void;
    const stop = subscribeRun('r-test', () => { throw new Error('render failed'); }, vi.fn(), () => {
      const connection = { addEventListener: (name: string, cb: (event: MessageEvent) => void) => { if (name === 'run.updated') listener = cb; }, close: vi.fn(), onopen: null, onerror: null } as EventConnection;
      return connection;
    });
    expect(() => listener({ data: JSON.stringify({ seq: 1, runId: 'r-test', type: 'run.updated', payload: {}, at: '' }) } as MessageEvent)).toThrow('render failed');
    stop();
  });
});
