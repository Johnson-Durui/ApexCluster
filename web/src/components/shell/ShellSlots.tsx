// Shell slots (BUILD-SPEC-B §3.3, §3.4). Pages portal their top-bar title/actions and status-bar cells into hosts that
// TopBar and StatusBar render. A claimed slot hides the shell's route fallback, so a page never shows two titles.
// Usage: <TopBarTitle><Crumb trail={[{ label: '任务历史', href: '#/history' }]} current={title} /></TopBarTitle>
//        <StatusCells><StatusCell>运行 12</StatusCell><StatusCell tone="gate">等你 02</StatusCell></StatusCells>
import { useCallback, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type SlotName = 'title' | 'actions' | 'status-connection' | 'status-cells' | 'status-usage';

const hosts: Partial<Record<SlotName, HTMLElement>> = {};
const claims: Record<SlotName, number> = { title: 0, actions: 0, 'status-connection': 0, 'status-cells': 0, 'status-usage': 0 };
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version += 1; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getVersion = () => version;

function useSlotVersion() {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** Rendered by TopBar/StatusBar. `display:contents` hosts let page cells sit directly in the status bar's flex row. */
export function SlotHost({ name, className }: { name: SlotName; className?: string }) {
  // A stable ref: an inline callback would detach/re-attach on every render and re-emit.
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element && hosts[name] !== element) { hosts[name] = element; emit(); }
    else if (!element && hosts[name]) { delete hosts[name]; emit(); }
  }, [name]);
  return <div className={`slot-host ${className ?? ''}`.trim()} data-slot={name} ref={ref} />;
}

/** True while some page fills the slot (the shell then hides its fallback). */
export function useSlotClaimed(name: SlotName): boolean {
  useSlotVersion();
  return claims[name] > 0;
}

function Slot({ name, children }: { name: SlotName; children?: ReactNode }) {
  useSlotVersion();
  useLayoutEffect(() => {
    claims[name] += 1;
    emit();
    return () => { claims[name] = Math.max(0, claims[name] - 1); emit(); };
  }, [name]);
  const host = hosts[name];
  return host ? createPortal(children, host) : null;
}

/** Top-bar title: a crumb whose first segment is a link; an h1 only on chat routes (elsewhere the page head owns it). */
export const TopBarTitle = ({ children }: { children?: ReactNode }) => <Slot name="title">{children}</Slot>;
/** Top-bar actions (right side). */
export const TopBarActions = ({ children }: { children?: ReactNode }) => <Slot name="actions">{children}</Slot>;
/** Status-bar cell 1: the page's own live-connection words (chat SSE, run SSE). ` · 本机 · 仅本机访问` is appended by the shell. */
export const StatusConnection = ({ children }: { children?: ReactNode }) => <Slot name="status-connection">{children}</Slot>;
/** Status-bar cell 3: page cells (use <StatusCell>). */
export const StatusCells = ({ children }: { children?: ReactNode }) => <Slot name="status-cells">{children}</Slot>;
/** Status-bar cell 5: usage on the right (chat: Token · 费用估算 · 用时). */
export const StatusUsage = ({ children }: { children?: ReactNode }) => <Slot name="status-usage">{children}</Slot>;

/** One status-bar cell. `wide` cells hide at ≤1320px; `gate` tints a waiting-on-you cell indigo; `alert` is amber. */
export function StatusCell({ children, wide = false, tone, title, role, className }: { children: ReactNode; wide?: boolean; tone?: 'gate' | 'alert'; title?: string; role?: 'alert' | 'status'; className?: string }) {
  return <span className={`sb-cell${wide ? ' wide' : ''}${tone === 'gate' ? ' is-gate' : tone === 'alert' ? ' is-alert' : ''}${className ? ` ${className}` : ''}`} title={title} role={role}>{children}</span>;
}

// ---------- service reachability (the status-bar fallback on routes without their own live connection) ----------
export type Reachability = 'connecting' | 'ok' | 'offline';
let reach: Reachability = 'connecting';
const reachListeners = new Set<() => void>();

/** Set by the sidebar from its last `/api/chats` result. No polling. */
export function setReachability(next: Reachability) {
  if (next === reach) return;
  reach = next;
  reachListeners.forEach(listener => listener());
}

export function useReachability(): Reachability {
  return useSyncExternalStore(listener => { reachListeners.add(listener); return () => { reachListeners.delete(listener); }; }, () => reach, () => reach);
}
