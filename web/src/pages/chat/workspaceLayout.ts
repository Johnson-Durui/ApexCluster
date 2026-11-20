// Pure layout rules for the chat workspace (BUILD-SPEC-B §4.1, §4.2): grid tracks, the thread width clamp,
// the splitter's computed aria range, map auto-collapse and the inspector placement. No DOM access here.

export const THREAD_MIN = 400;
export const THREAD_MAX_FRACTION = 0.62;
export const MAP_MIN = 420;
export const SPLITTER_W = 7;
export const DECK_HEAD_H = 40;
export const RAIL_H = 68;
export const STAGE_MIN = 330;
export const DOCK_MIN = 150;
export const DOCK_MAX = 320;
/** Below this `.chat-work` width the map cannot keep 420px next to a 400px thread. */
export const COLLAPSE_BELOW = THREAD_MIN + SPLITTER_W + MAP_MIN;
export const THREAD_KEY = 'dmw:deck:thread-w:v1';
export const COLLAPSED_KEY = 'dmw:deck:collapsed:v1';
export const DOCK_KEY = 'dmw:deck:dock-h:v1';

export type InspectorPlacement = 'dock' | 'column';

export interface PlacementInput {
  maximised: boolean;
  collapsed: boolean;
  /** Height of the map pane, as reported by ChatMap.onDockFit (or measured). */
  deckH: number;
  /** 68 for pipeline chats (the rail row), else 0. */
  railH: number;
}

/** Dock under the stage when it keeps ≥150px next to a ≥330px stage; otherwise a pushing right column. */
export function inspectorPlacement({ maximised, collapsed, deckH, railH }: PlacementInput): InspectorPlacement {
  if (maximised || collapsed) return 'column';
  return dockRoom(deckH, railH) < DOCK_MIN ? 'column' : 'dock';
}

/** Height left for a dock under the head, the rail and a minimum stage. */
export function dockRoom(deckH: number, railH: number): number {
  return deckH - DECK_HEAD_H - railH - STAGE_MIN;
}

/** Default dock height: clamp(150px, deckH − 40 − railH − 330, 320px). */
export function defaultDockHeight(deckH: number, railH: number): number {
  return clampNumber(dockRoom(deckH, railH), DOCK_MIN, DOCK_MAX);
}

/** The largest dock that still leaves a 330px stage. */
export function maxDockHeight(deckH: number, railH: number): number {
  return Math.max(DOCK_MIN, dockRoom(deckH, railH));
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, Math.min(min, max)), Math.max(min, max));
}

/** True when the map must auto-collapse (not persisted): the workspace cannot hold thread 400 + splitter + map 420 (+ a column inspector). */
export function autoCollapse(workW: number, columnInspectorW: number): boolean {
  return workW > 0 && workW < COLLAPSE_BELOW + columnInspectorW;
}

export interface ThreadBounds { min: number; max: number }

/** Thread width limits in px: at least 400, at most 62% of `.chat-work`, and the map keeps 420px. */
export function threadBounds(workW: number, columnInspectorW = 0): ThreadBounds {
  const byFraction = Math.floor(workW * THREAD_MAX_FRACTION);
  const byMap = workW - columnInspectorW - SPLITTER_W - MAP_MIN;
  return { min: THREAD_MIN, max: Math.max(THREAD_MIN, Math.min(byFraction, byMap)) };
}

/** Default thread width: clamp(460px, 44%, 700px). */
export function defaultThreadWidth(workW: number): number {
  return clampNumber(Math.round(workW * 0.44), 460, 700);
}

/** Thread width in px from a persisted fraction of `.chat-work` (or the default), clamped to its bounds. */
export function threadWidth(workW: number, fraction: number | null, columnInspectorW = 0): number {
  const bounds = threadBounds(workW, columnInspectorW);
  const wanted = fraction !== null && Number.isFinite(fraction) && fraction > 0 && fraction < 1 ? Math.round(fraction * workW) : defaultThreadWidth(workW);
  return clampNumber(wanted, bounds.min, bounds.max);
}

/** The splitter's aria range in percent of `.chat-work`, computed from the px limits (30% is unreachable at 1216px). */
export function splitterRange(workW: number, threadPx: number, bounds: ThreadBounds): { now: number; min: number; max: number } {
  if (workW <= 0) return { now: 0, min: 0, max: 0 };
  const pct = (px: number) => (px / workW) * 100;
  return { now: pct(threadPx), min: pct(bounds.min), max: pct(bounds.max) };
}

export interface GridInput {
  maximised: boolean;
  collapsed: boolean;
  /** A column inspector is open (always a column while maximised). */
  inspectorColumn: boolean;
}

/** `grid-template-columns` for `.chat-work`: thread | splitter | map | inspector column. */
export function gridTemplate({ maximised, collapsed, inspectorColumn }: GridInput): string {
  if (maximised) return `var(--mini-rail-w) 0 minmax(0,1fr) ${inspectorColumn ? 'clamp(320px,26%,400px)' : '0'}`;
  if (collapsed) return `minmax(0,1fr) 0 0${inspectorColumn ? ' var(--insp-w)' : ' 0'}`;
  return `var(--thread-w) var(--splitter-w) minmax(0,1fr)${inspectorColumn ? ' var(--insp-w)' : ' 0'}`;
}

/** The dock's ▾ collapse, with the inputs it was last synced to. */
export interface DockCollapse { collapsed: boolean; open: boolean; reveal: number }

/**
 * The collapse survives tab clicks and seat pins, but an explicit open shows content: opening the inspector
 * (closed → open) or an open-to-tab request (`reveal` changed: 查看交付物, 在协作详情中查看) expands the dock.
 * Returns `state` itself when nothing changed.
 */
export function syncDockCollapse(state: DockCollapse, open: boolean, reveal: number): DockCollapse {
  if (state.open === open && state.reveal === reveal) return state;
  const expand = (open && !state.open) || reveal !== state.reveal;
  return { collapsed: expand ? false : state.collapsed, open, reveal };
}

/** Reads a persisted number; a missing, invalid or throwing storage returns null. */
export function readStoredNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

export function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable: keep the in-memory value */ }
}

export function readStoredFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
