export const eventTypes = ['run.updated', 'task.updated', 'task.progress', 'question.added', 'question.updated', 'snapshot.created', 'proposals.updated', 'decision.updated', 'gate.opened', 'gate.resolved', 'job.updated', 'docs.updated'] as const;
export interface StreamEvent { seq: number; runId: string; at: string; type: typeof eventTypes[number]; payload: unknown }
export interface EventConnection { addEventListener(name: string, listener: (event: MessageEvent) => void): void; close(): void; onopen: (() => void) | null; onerror: (() => void) | null }
const invalidEventState = '事件格式异常，正在校准';
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isProgressPayload(value: unknown): boolean {
  if (!isObject(value) || typeof value.taskId !== 'string' || !value.taskId.trim() || !isObject(value.progress)) return false;
  const progress = value.progress;
  return typeof progress.at === 'string' && typeof progress.text === 'string' && (progress.kind === undefined || typeof progress.kind === 'string');
}
export function subscribeRun(runId: string, onEvent: (event: StreamEvent) => void, onState: (state: string) => void, factory: (url: string) => EventConnection = url => new EventSource(url) as unknown as EventConnection, onOpen?: () => void, onInvalid?: () => void) {
  let last = 0; let disposed = false; let connection: EventConnection; let timer: ReturnType<typeof setTimeout>; let backoff = 800;
  const invalid = () => { onState(invalidEventState); onInvalid?.(); };
  const connect = () => {
    if (disposed) return;
    onState(last ? '正在重连' : '正在连接');
    connection = factory(`/api/runs/${encodeURIComponent(runId)}/events?since=${last}`);
    const source = connection;
    let closed = false;
    source.onopen = () => { if (!disposed && !closed) { backoff = 800; onState('实时同步'); onOpen?.(); } };
    for (const type of eventTypes) source.addEventListener(type, event => {
      if (disposed || closed) return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch { invalid(); return; }
      if (!isObject(value)) { invalid(); return; }
      if (typeof value.runId === 'string' && value.runId !== runId) return;
      if (typeof value.type === 'string' && value.type !== type) return;
      if (value.runId !== runId || value.type !== type || !Number.isInteger(value.seq) || typeof value.at !== 'string' || !Object.prototype.hasOwnProperty.call(value, 'payload')) { invalid(); return; }
      const data = value as unknown as StreamEvent;
      if (data.seq <= last) return;
      if (type === 'task.progress' && !isProgressPayload(data.payload)) { invalid(); return; }
      last = data.seq;
      onEvent(data);
    });
    source.onerror = () => {
      if (disposed || closed) return;
      closed = true; source.close(); onState('连接中断，正在重连');
      timer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 10000);
    };
  };
  connect();
  return () => { disposed = true; clearTimeout(timer); connection.close(); };
}
