// Fixed-demo playback controls: start (hands off to the new demo chat without a skeleton), pause/continue, and the
// product dialog that auto-opens once per demo id when the product is ready (kept: §1.10, the user chose option 1).
import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { ChatRecord } from '../../../lib/chat-api';
import { getFixedDemoPlayback, getFixedDemoSnapshot, isFixedDemoId, pauseFixedDemo, startFixedDemo } from '../../../lib/fixed-demo';
import type { ChatAction } from '../chatModel';
import { explain } from './explain';

/**
 * Real work is running (§7: loops run only while a real process is active). A paused fixed demo keeps its tasks
 * 'running' in the snapshot, but nothing progresses, so it is not active: the send ring and under-glow stop with the map.
 */
export function isWorkActive(tasks: ReadonlyArray<{ status: string }>, demoPaused: boolean): boolean {
  return !demoPaused && tasks.some(task => task.status === 'queued' || task.status === 'running' || task.status === 'waiting_children');
}

export function useFixedDemoPlayback({ chat, fresh, dispatch, handoff, onError, setSending, sending, onStarted }: {
  chat: ChatRecord | null;
  fresh: boolean;
  dispatch: Dispatch<ChatAction>;
  handoff: { current: string };
  onError(message: string): void;
  setSending(value: boolean): void;
  sending: boolean;
  onStarted(): void;
}) {
  const [productOpen, setProductOpen] = useState(false);
  const shown = useRef('');
  const demo = !fresh && isFixedDemoId(chat?.id);
  const playback = demo && chat ? getFixedDemoPlayback(chat.id) : null;

  useEffect(() => {
    if (!demo || !chat) { setProductOpen(false); return; }
    if (getFixedDemoPlayback(chat.id).productReady && shown.current !== chat.id) {
      shown.current = chat.id;
      setProductOpen(true);
    }
  }, [demo, chat?.id, chat?.seq, playback?.productReady]);

  async function start() {
    if (sending) return;
    setSending(true);
    onError('');
    setProductOpen(false);
    try {
      const snapshot = await startFixedDemo(crypto.randomUUID());
      handoff.current = snapshot.chat.id;
      dispatch({ type: 'reset' });
      dispatch({ type: 'snapshot', snapshot, origin: 'demo' });
      dispatch({ type: 'connection', connection: 'live' });
      onStarted();
      location.hash = `/?chat=${encodeURIComponent(snapshot.chat.id)}`;
      window.dispatchEvent(new Event('workbench:chat-created'));
    } catch (cause) { onError(explain(cause, '固定演示加载失败，请重试。')); }
    finally { setSending(false); }
  }

  async function togglePause() {
    if (!chat || !isFixedDemoId(chat.id)) return;
    try {
      const current = getFixedDemoPlayback(chat.id);
      await pauseFixedDemo(chat.id, !current.paused);
      dispatch({ type: 'snapshot', snapshot: await getFixedDemoSnapshot(chat.id), origin: 'demo' });
    } catch (cause) { onError(explain(cause, '演示暂停失败')); }
  }

  return { demo, playback, paused: demo && Boolean(playback?.paused), productOpen, setProductOpen, start, togglePause };
}
