import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { subscribeRun } from './events';
import type { Run, ProgressMap, ProgressEntry } from './types';
export function useRun(id: string) {
  const [run, setRun] = useState<Run>(); const [error, setError] = useState(''); const [connection, setConnection] = useState('正在连接');
  const [progress, setProgress] = useState<ProgressMap>({}); const [busy, setBusy] = useState(false); const lock = useRef(false); const request = useRef(0); const action = useRef(0); const activeId = useRef(id); const runRef = useRef<Run | undefined>(undefined);
  activeId.current = id;
  const load = useCallback(async () => {
    const current = ++request.current;
    try { const next = await api.get<Run>(`/api/runs/${id}`); if (request.current === current && activeId.current === id) { runRef.current = next; setRun(next); setError(''); return true; } }
    catch (e) { if (request.current === current && activeId.current === id) setError((e as Error).message); }
    return false;
  }, [id]);
  const refresh = useCallback(async () => { await load(); }, [load]);
  useEffect(() => {
    ++action.current;
    lock.current = false; setBusy(false); runRef.current = undefined; setRun(undefined); setProgress({}); void refresh();
    let timer: ReturnType<typeof setTimeout>;
    let invalidPending = false;
    const scheduleRefresh = (invalid = false) => {
      invalidPending ||= invalid;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const repair = invalidPending;
        invalidPending = false;
        void load().then(ok => { if (repair && ok) setConnection(current => current === '事件格式异常，正在校准' ? '实时同步' : current); });
      }, 100);
    };
    const unsubscribe = subscribeRun(id, event => {
      if (event.type === 'task.progress') {
        const item = event.payload as { taskId: string; progress: ProgressEntry };
        if (item.taskId && item.progress && runRef.current?.terminal !== 'cancelled') setProgress(prev => ({ ...prev, [item.taskId]: [...(prev[item.taskId] ?? []), item.progress].slice(-500) }));
      } else scheduleRefresh();
    }, setConnection, undefined, () => void refresh(), () => scheduleRefresh(true));
    return () => { ++request.current; ++action.current; lock.current = false; clearTimeout(timer); unsubscribe(); };
  }, [id, load, refresh]);
  const act = async (suffix: string, body: unknown = {}) => {
    if (lock.current) return false;
    const current = ++action.current;
    lock.current = true; setBusy(true); setError('');
    try {
      const next = await api.post<Run>(`/api/runs/${id}/${suffix.replace(/^\/+/, '')}`, body);
      if (action.current !== current || activeId.current !== id) return false;
      ++request.current; runRef.current = next; setRun(next); return true;
    }
    catch (e) { if (action.current === current && activeId.current === id) setError((e as Error).message); return false; }
    finally { if (action.current === current) { lock.current = false; setBusy(false); } }
  };
  return { run, refresh, act, error, connection, progress, busy };
}
