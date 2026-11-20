// Chat data: snapshot load, older tool-activity backfill, then live updates (chatEvents.ts: SSE with REST reconcile,
// or the fixed-demo feed). Connection problems go to `notice` (the line above the log), never to the composer strip. A
// failed load is reported as `loadError`; the page never falls back to the new-chat UI for it.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { chatApi } from '../../../lib/chat-api';
import { isFixedDemoId } from '../../../lib/fixed-demo';
import { emptyChatState, reduceChat } from '../chatModel';
import { connectChatEvents, watchFixedDemo } from './chatEvents';
import { explain } from './explain';

export { explain } from './explain';
export { demoFingerprint } from './chatEvents';

export interface ChatTarget { chatId: string | null; fresh: boolean }

export interface StreamGate {
  loading: boolean;
  fresh: boolean;
  /** The chat held in state. */
  chatId: string | undefined;
  /** The route's chat. */
  selectedId: string | null;
  /** The chat whose snapshot has been dispatched since the route last changed. */
  syncedId: string | null;
}

/**
 * Live updates start only after this route's snapshot has landed, so the stream resumes from the snapshot's cursor.
 * A quiet hand-off (first send) shows no skeleton, but it still waits: an EventSource opened at since=0 next to the
 * GET would let the older snapshot overwrite events the stream had already applied.
 */
export function canStream({ loading, fresh, chatId, selectedId, syncedId }: StreamGate): boolean {
  return !loading && !fresh && Boolean(chatId) && chatId === selectedId && syncedId === selectedId;
}

/**
 * `target` = the route's chat. `handoff` holds the chat id that this page itself just created; for it the in-memory
 * state is kept (no skeleton) and the snapshot reconciles silently.
 */
export function useChatStream(target: ChatTarget, handoff: { current: string }) {
  const [state, dispatch] = useReducer(reduceChat, undefined, emptyChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loading, setLoading] = useState(!target.fresh && Boolean(target.chatId));
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [backfill, setBackfill] = useState(false);
  const [syncedId, setSyncedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { chatId: selectedId, fresh } = target;

  useEffect(() => {
    setSyncedId(null);
    if (fresh || !selectedId) { setLoading(false); setLoadError(''); return; }
    const controller = new AbortController();
    let alive = true;
    const quiet = handoff.current === selectedId && stateRef.current.chat?.id === selectedId;
    if (!quiet) setLoading(true);
    setLoadError('');
    setNotice('');
    setBackfill(false);
    void (async () => {
      try {
        const snapshot = await chatApi.get(selectedId, controller.signal);
        if (!alive) return;
        const replayFrom = snapshot.streams !== undefined ? snapshot.chat.seq : Math.max(0, snapshot.chat.seq - 500);
        dispatch({ type: 'snapshot', snapshot, replayFrom, ...(isFixedDemoId(snapshot.chat.id) && quiet ? { origin: 'demo' as const } : {}) });
        setSyncedId(selectedId);
        setLoading(false);
        if (isFixedDemoId(snapshot.chat.id)) return;
        const through = snapshot.recentEvents?.length ? snapshot.recentEvents[0].seq - 1 : snapshot.chat.seq;
        let since = 0;
        try {
          while (since < through && !controller.signal.aborted) {
            const page = await chatApi.trace(snapshot.chat.id, since, controller.signal);
            const events = page.items.filter(event => event.seq <= through);
            if (!alive) return;
            dispatch({ type: 'history', chatId: snapshot.chat.id, events: events.filter(event => ['tool_started', 'tool_result', 'tool_error', 'test_result'].includes(event.type)) });
            const next = page.items.at(-1)?.seq ?? since;
            if (next <= since) break;
            since = next;
          }
        } catch { if (alive && !controller.signal.aborted) setBackfill(true); }
      } catch (cause) {
        if (!alive || controller.signal.aborted) return;
        setLoadError(explain(cause, '聊天加载失败'));
        setLoading(false);
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [selectedId, fresh, attempt, handoff]);

  const chatId = state.chat?.id;
  const live = canStream({ loading, fresh, chatId, selectedId, syncedId });
  useEffect(() => {
    if (!live || !chatId) return;
    if (isFixedDemoId(chatId)) return watchFixedDemo({ chatId, dispatch, setNotice });
    return connectChatEvents({ chatId, cursor: stateRef.current.eventCursor, dispatch, setNotice });
  }, [chatId, live]);

  const retryLoad = useCallback(() => setAttempt(value => value + 1), []);
  return { state, dispatch, loading, loadError, retryLoad, notice, setNotice, backfill };
}
