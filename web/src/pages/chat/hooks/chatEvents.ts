// Live chat updates (BUILD-SPEC-B §4.3.3): one EventSource per chat with a REST reconcile after a drop, and the
// fixed-demo snapshot feed. Connection and recalibration problems go to `notice` (the line above the log). The notice
// holds nothing else, so any successful reconnect clears it, whatever its wording (a reconcile failure reads
// "Failed to fetch" or "服务暂时不可用…", not "连接…"). Plain functions with injectable I/O, so they run under test.
import { chatApi, type ChatEvent, type ChatSnapshot } from '../../../lib/chat-api';
import { getFixedDemoPlayback, subscribeFixedDemo } from '../../../lib/fixed-demo';
import type { ChatAction } from '../chatModel';
import { explain } from './explain';

/** The part of EventSource this module uses. */
export interface EventStream {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface ChatEventsOptions {
  chatId: string;
  /** The last event seq the state already holds; the stream resumes after it. */
  cursor: number;
  dispatch(action: ChatAction): void;
  setNotice(text: string): void;
  load?(chatId: string): Promise<ChatSnapshot>;
  open?(url: string): EventStream;
  /** A root task changed (the sidebar refreshes its status). */
  onRootUpdate?(): void;
}

const announceRootUpdate = () => window.dispatchEvent(new Event('workbench:chat-updated'));

/** Opens the chat's event stream and keeps it alive; returns the teardown. */
export function connectChatEvents(options: ChatEventsOptions): () => void {
  const { chatId, dispatch, setNotice, load = (id: string) => chatApi.get(id), open = (url: string) => new EventSource(url), onRootUpdate = announceRootUpdate } = options;
  let closed = false;
  let source: EventStream | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let cursor = options.cursor;
  const schedule = (reconcile: boolean, delay = 0) => {
    if (closed) return;
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(() => void connect(reconcile), delay);
  };
  const connect = async (reconcile: boolean) => {
    if (closed) return;
    if (reconcile) {
      dispatch({ type: 'connection', connection: 'recovering' });
      try {
        const snapshot = await load(chatId);
        if (closed) return;
        dispatch({ type: 'snapshot', snapshot });
        if (snapshot.streams !== undefined) cursor = snapshot.chat.seq;
      } catch (cause) {
        if (!closed) { dispatch({ type: 'connection', connection: 'offline' }); setNotice(explain(cause, '服务恢复检查失败')); schedule(true, 2500); }
        return;
      }
    }
    source?.close();
    const currentSource = open(`/api/chats/${chatId}/events?since=${cursor}`);
    let intentionalClose = false;
    source = currentSource;
    // Recovery is proven: the stream is open again. Clear whatever the notice says.
    currentSource.onopen = () => { dispatch({ type: 'connection', connection: 'live' }); setNotice(''); };
    currentSource.addEventListener('chat_event', raw => {
      try {
        const event = JSON.parse(raw.data) as ChatEvent;
        cursor = Math.max(cursor, event.seq);
        dispatch({ type: 'event', event });
        if (event.type === 'task_updated' && !event.parentTaskId) onRootUpdate();
      } catch { setNotice('收到了无法识别的实时事件，正在从服务端重新校准。'); intentionalClose = true; currentSource.close(); schedule(true, 0); }
    });
    currentSource.addEventListener('chat_more', raw => {
      try { const value = JSON.parse(raw.data) as { since?: unknown }; if (typeof value.since === 'number') cursor = Math.max(cursor, value.since); } catch { /* use last accepted cursor */ }
      intentionalClose = true; currentSource.close(); schedule(false, 0);
    });
    currentSource.onerror = () => {
      if (intentionalClose || closed) return;
      currentSource.close(); dispatch({ type: 'connection', connection: 'recovering' });
      setNotice('实时连接已中断，正在从 REST 快照校准并重连…'); schedule(true, 1200);
    };
  };
  void connect(false);
  return () => { closed = true; source?.close(); if (retry !== undefined) clearTimeout(retry); };
}

/** Fixed-demo snapshots arrive every 200ms; only a visible change (or the next whole second while playing) is dispatched. */
export function demoFingerprint(snapshot: ChatSnapshot): string {
  const playback = getFixedDemoPlayback(snapshot.chat.id);
  const chat = snapshot.chat;
  return [Math.floor(playback.elapsedMs / 1000), playback.paused, playback.cancelled, playback.completed,
    chat.tasks.map(task => task.status).join(), snapshot.messages.length, chat.artifacts.length, (chat.todos ?? []).map(todo => todo.status).join(), chat.turns.map(turn => turn.status).join()].join('|');
}

export interface FixedDemoFeedOptions {
  chatId: string;
  dispatch(action: ChatAction): void;
  setNotice(text: string): void;
  subscribe?: typeof subscribeFixedDemo;
  fingerprint?(snapshot: ChatSnapshot): string;
}

/** Follows a fixed demo's playback. A failed tick goes to `notice`; the next good tick clears it, even an unchanged one. */
export function watchFixedDemo({ chatId, dispatch, setNotice, subscribe = subscribeFixedDemo, fingerprint = demoFingerprint }: FixedDemoFeedOptions): () => void {
  let last = '';
  let failed = false;
  return subscribe(chatId, snapshot => {
    const print = fingerprint(snapshot);
    if (print === last && !failed) return;
    last = print;
    dispatch({ type: 'snapshot', snapshot, origin: 'demo' });
    dispatch({ type: 'connection', connection: 'live' });
    if (failed) { failed = false; setNotice(''); }
  }, cause => { failed = true; dispatch({ type: 'connection', connection: 'offline' }); setNotice(cause.message); });
}
