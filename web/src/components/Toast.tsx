// Toasts (BUILD-SPEC-B §3.6): toast({title, body?, actions?, sticky?}). The region `.toasts[role=status][aria-live=polite]`
// is rendered last inside `.app`, so toast actions are in Tab order. Non-sticky toasts dismiss after 6s (paused on
// hover/focus). Every toast action must also exist outside the toast (thread deliverables, inspector 文件, history list).
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Icon } from './ui';
import { reducedMotion } from './motion';

export interface ToastAction { label: string; href?: string; onClick?(): void; primary?: boolean }
export interface ToastOptions {
  title: string;
  body?: string;
  actions?: ToastAction[];
  sticky?: boolean;
  /** Re-using an id replaces that toast instead of stacking a second one. */
  id?: string;
  className?: string;
  /** aria-label of the close button (default 关闭通知). */
  closeLabel?: string;
}
interface ToastItem extends ToastOptions { id: string; leaving: boolean }

const AUTO_DISMISS_MS = 6000;
const LEAVE_MS = 160;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();
let counter = 0;
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => items;

/** Shows a toast and returns its id. */
export function toast(options: ToastOptions): string {
  const id = options.id ?? `toast-${++counter}`;
  const item: ToastItem = { ...options, id, leaving: false };
  items = items.some(existing => existing.id === id) ? items.map(existing => existing.id === id ? item : existing) : [...items, item];
  emit();
  return id;
}

/** Dismisses a toast (160ms fade, instant under reduced motion). Unknown ids are ignored. */
export function dismissToast(id: string) {
  const item = items.find(existing => existing.id === id);
  if (!item || item.leaving) return;
  if (reducedMotion() || typeof window === 'undefined') { items = items.filter(existing => existing.id !== id); emit(); return; }
  items = items.map(existing => existing.id === id ? { ...existing, leaving: true } : existing);
  emit();
  // Remove only the leaving copy: a toast re-shown under the same id during the fade must survive.
  window.setTimeout(() => { items = items.filter(existing => !(existing.id === id && existing.leaving)); emit(); }, LEAVE_MS);
}

function ToastCard({ item }: { item: ToastItem }) {
  const paused = useRef(false);
  const remaining = useRef(AUTO_DISMISS_MS);
  const started = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const run = () => {
    if (item.sticky || item.leaving || paused.current) return;
    started.current = Date.now();
    timer.current = window.setTimeout(() => dismissToast(item.id), remaining.current);
  };
  const pause = () => {
    if (paused.current) return;
    paused.current = true;
    if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined; remaining.current = Math.max(800, remaining.current - (Date.now() - started.current)); }
  };
  const resume = (element: HTMLElement | null) => {
    if (!paused.current || element?.matches(':hover') || element?.contains(document.activeElement)) return;
    paused.current = false;
    run();
  };
  useEffect(() => {
    remaining.current = AUTO_DISMISS_MS;
    run();
    return () => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; };
  }, [item.sticky, item.title, item.body]);

  return <div className={`toast${item.leaving ? ' is-leaving' : ''}${item.className ? ` ${item.className}` : ''}`}
    onPointerEnter={pause} onPointerLeave={event => resume(event.currentTarget)}
    onFocus={pause} onBlur={event => { const element = event.currentTarget; window.setTimeout(() => resume(element), 0); }}>
    <div className="toast-text"><b>{item.title}</b>{item.body ? <span>{item.body}</span> : null}</div>
    {item.actions?.length ? <div className="toast-actions">{item.actions.map(action => action.href
      ? <a key={action.label} href={action.href} onClick={() => { action.onClick?.(); dismissToast(item.id); }}>{action.label}</a>
      : <button key={action.label} type="button" className={`btn sm${action.primary ? ' primary' : ''}`} onClick={() => { action.onClick?.(); dismissToast(item.id); }}>{action.label}</button>)}</div> : null}
    <button type="button" className="icon-btn" aria-label={item.closeLabel ?? '关闭通知'} onClick={() => dismissToast(item.id)}><Icon name="x" size={14} /></button>
  </div>;
}

/** The toast region. Render it once, as the last child of `.app`. */
export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return <div className="toasts" role="status" aria-live="polite" data-stack={list.length > 1 ? '' : undefined}>
    {list.map(item => <ToastCard key={item.id} item={item} />)}
  </div>;
}
