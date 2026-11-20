// Seat focus (BUILD-SPEC-B §5.1, §5.3). {seat?, pinned} lives in an external store, not in props or a re-rendering
// context. Every change writes data-focus-seat / data-pinned on `.chat-work`; dimming is pure CSS, so hovering a seat
// causes no React render. Only the canvas and the inspector 席位 tab subscribe, through useSeatFocus().useSeat().
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type FocusEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';

export interface SeatFocusState { seat?: string; pinned: boolean }

export interface SeatFocusStore {
  get(): SeatFocusState;
  subscribe(listener: () => void): () => void;
  /** Hover or keyboard focus. Ignored while a seat is pinned; `undefined` clears an unpinned focus. */
  hover(id?: string): void;
  /** Pins a seat; pinning the already pinned seat unpins it. */
  pin(id: string): void;
  clear(): void;
}

const IDLE: SeatFocusState = { pinned: false };

/** Creates a store. `target` resolves the element that receives the data attributes (normally `.chat-work`). */
export function createSeatFocusStore(target?: () => HTMLElement | null | undefined): SeatFocusStore {
  let state = IDLE;
  const listeners = new Set<() => void>();
  const write = () => {
    const element = target?.();
    if (!element) return;
    if (state.seat) element.dataset.focusSeat = state.seat; else delete element.dataset.focusSeat;
    if (state.pinned) element.dataset.pinned = 'true'; else delete element.dataset.pinned;
  };
  const set = (next: SeatFocusState) => {
    if (next.seat === state.seat && next.pinned === state.pinned) return;
    state = next.seat || next.pinned ? next : IDLE;
    write();
    listeners.forEach(listener => listener());
  };
  return {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hover(id) { if (!state.pinned) set({ seat: id || undefined, pinned: false }); },
    pin(id) { set(state.pinned && state.seat === id ? IDLE : { seat: id, pinned: true }); },
    clear() { set(IDLE); },
  };
}

const fallbackStore = createSeatFocusStore(() => typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.chat-work'));
let activeStore: SeatFocusStore = fallbackStore;
const SeatFocusContext = createContext<SeatFocusStore | null>(null);

/**
 * Mounted by ChatWorkspace (keyed by chat id), so a pin never leaks across chats or routes.
 * `target` is the `.chat-work` element; without it the provider looks the element up when it writes.
 */
export function SeatFocusProvider({ target, children }: { target?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const store = useMemo(() => createSeatFocusStore(() => target?.current ?? (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.chat-work'))), [target]);
  useEffect(() => {
    const previous = activeStore;
    activeStore = store;
    return () => {
      store.clear();
      if (activeStore === store) activeStore = previous;
    };
  }, [store]);
  return <SeatFocusContext.Provider value={store}>{children}</SeatFocusContext.Provider>;
}

function useStore(): SeatFocusStore {
  return useContext(SeatFocusContext) ?? fallbackStore;
}

/** Hover/pin/clear actions plus `useSeat()`, the one subscription for components that must re-render on focus. */
export function useSeatFocus() {
  const store = useStore();
  return useMemo(() => ({
    hover: (id?: string) => store.hover(id),
    pin: (id: string) => store.pin(id),
    clear: () => store.clear(),
    // A hook: call it unconditionally at the top level of the consuming component.
    useSeat: (): SeatFocusState => useSyncExternalStore(store.subscribe, store.get, () => IDLE),
  }), [store]);
}

export interface SeatHandlers {
  'data-seat': string;
  onPointerEnter(event: PointerEvent<HTMLElement>): void;
  onPointerLeave(event: PointerEvent<HTMLElement>): void;
  onFocus(event: FocusEvent<HTMLElement>): void;
  onBlur(event: FocusEvent<HTMLElement>): void;
  onClick(): void;
}

/** Spread onto any `[data-seat]` element: hover/focus → hover(id), leave/blur → hover(), click → pin(id). */
export function seatHandlers(id: string, store?: SeatFocusStore): SeatHandlers {
  const current = () => store ?? activeStore;
  return {
    'data-seat': id,
    onPointerEnter: () => current().hover(id),
    onPointerLeave: () => current().hover(undefined),
    onFocus: () => current().hover(id),
    onBlur: () => current().hover(undefined),
    onClick: () => current().pin(id),
  };
}
