// Splitter (BUILD-SPEC-B §4.2): a focusable role=separator, not a button (Enter would also fire click).
// Values are in the consumer's units (px or %); `scale` converts pointer pixels into those units.
// Pointer drag reports at most once per animation frame; keys move by `step` (Shift ×4); Home/End jump; Enter or
// double-click resets. The value is persisted under `storageKey` when a drag or key change ends (try/catch).
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

export type SplitterOrientation = 'vertical' | 'horizontal';

export interface SplitterProps {
  /** `vertical` separates left|right panes (←/→); `horizontal` separates top/bottom panes (↑/↓). */
  orientation: SplitterOrientation;
  value: number;
  min: number;
  max: number;
  /** Key step in value units (the thread splitter uses 24px). Shift multiplies it by 4. */
  step: number;
  storageKey?: string;
  label: string;
  valueText?: string;
  /** id of the pane this separator resizes (aria-controls). */
  controls?: string;
  onChange(value: number): void;
  onReset?(): void;
  /** Pointer pixels per value unit (default 1). */
  scale?: number;
  /** Moving the pointer right/down shrinks the value (e.g. a dock below the splitter grows when dragged up). */
  invert?: boolean;
  /** Called with true on pointerdown and false on pointerup, so consumers can defer expensive re-layout. */
  onDragState?(dragging: boolean): void;
  className?: string;
}

export const clampSplit = (value: number, min: number, max: number) => Math.min(Math.max(value, Math.min(min, max)), Math.max(min, max));

/** Pure key reducer: the next value for a key, `'reset'` for Enter, or null when the key is not handled. */
export function splitterKey(key: string, shift: boolean, state: { value: number; min: number; max: number; step: number }, orientation: SplitterOrientation): number | 'reset' | null {
  const step = state.step * (shift ? 4 : 1);
  const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
  const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
  if (key === 'Enter') return 'reset';
  if (key === 'Home') return clampSplit(state.min, state.min, state.max);
  if (key === 'End') return clampSplit(state.max, state.min, state.max);
  if (key === decrease) return clampSplit(state.value - step, state.min, state.max);
  if (key === increase) return clampSplit(state.value + step, state.min, state.max);
  return null;
}

/** Reads a persisted splitter value; a missing, invalid or throwing storage returns `fallback`. */
export function readSplit(storageKey: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(storageKey);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}

export function writeSplit(storageKey: string | undefined, value: number) {
  if (!storageKey) return;
  try { localStorage.setItem(storageKey, String(Math.round(value * 10000) / 10000)); } catch { /* storage unavailable: keep the in-memory value */ }
}

export default function Splitter({ orientation, value, min, max, step, storageKey, label, valueText, controls, onChange, onReset, scale = 1, invert = false, onDragState, className = '' }: SplitterProps) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; origin: number; start: number; pending: number | null; frame: number } | null>(null);
  const latest = useRef({ value, min, max, onChange });
  latest.current = { value, min, max, onChange };

  useEffect(() => () => { if (drag.current?.frame) window.cancelAnimationFrame(drag.current.frame); }, []);

  const flush = () => {
    const state = drag.current;
    if (!state) return;
    state.frame = 0;
    if (state.pending !== null) { latest.current.onChange(state.pending); state.pending = null; }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    element.current?.setPointerCapture?.(event.pointerId);
    element.current?.focus({ preventScroll: true });
    drag.current = { pointer: event.pointerId, origin: orientation === 'vertical' ? event.clientX : event.clientY, start: value, pending: null, frame: 0 };
    if (element.current) element.current.dataset.dragging = '';
    onDragState?.(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    const delta = ((orientation === 'vertical' ? event.clientX : event.clientY) - state.origin) / (scale || 1);
    state.pending = clampSplit(state.start + (invert ? -delta : delta), latest.current.min, latest.current.max);
    if (!state.frame) state.frame = window.requestAnimationFrame(flush);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    if (state.frame) window.cancelAnimationFrame(state.frame);
    const final = state.pending ?? latest.current.value;
    if (state.pending !== null) latest.current.onChange(state.pending);
    drag.current = null;
    if (element.current) delete element.current.dataset.dragging;
    element.current?.releasePointerCapture?.(event.pointerId);
    writeSplit(storageKey, final);
    onDragState?.(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = splitterKey(event.key, event.shiftKey, { value, min, max, step }, orientation);
    if (next === null) return;
    event.preventDefault();
    if (next === 'reset') { onReset?.(); return; }
    if (next !== value) { onChange(next); writeSplit(storageKey, next); }
  };

  const now = Math.round(clampSplit(value, min, max));
  return <div ref={element} role="separator" tabIndex={0} className={`splitter ${className}`.trim()}
    aria-orientation={orientation} aria-label={label} aria-controls={controls}
    aria-valuenow={now} aria-valuemin={Math.round(Math.min(min, max))} aria-valuemax={Math.round(Math.max(min, max))} aria-valuetext={valueText}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
    onKeyDown={onKeyDown} onDoubleClick={() => onReset?.()} />;
}
