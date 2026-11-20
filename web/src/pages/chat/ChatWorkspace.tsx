// The chat workspace (BUILD-SPEC-B §4.1–4.2): thread | splitter | map pane [| inspector column]. Owns the thread width,
// map collapse and 架构视图 (the map maximised in place), the mini rail, inspector placement, Esc / Alt+A and the
// seat-focus provider. The subtree is not keyed by chat: the first-send hand-off (new → chat id) keeps the thread,
// composer focus and map; only the seat focus is cleared when the chat changes, so a pin never leaks across chats.
// (A real chat switch remounts everything through ChatPage's session key.)
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Splitter from '../../components/Splitter';
import { SeatFocusProvider, useSeatFocus } from '../../components/seatFocus';
import { TopBarActions } from '../../components/shell/ShellSlots';
import { Icon } from '../../components/ui';
import type { MapVariant } from './workspaceContracts';
import { autoCollapse, COLLAPSED_KEY, dockRoom, DOCK_MIN, gridTemplate, inspectorPlacement, readStoredFlag, readStoredNumber, splitterRange, syncDockCollapse, threadBounds, threadWidth, THREAD_KEY, writeStored, type DockCollapse, type InspectorPlacement } from './workspaceLayout';

export interface MapContext { variant: MapVariant; dock?: ReactNode; dockOpen: boolean; onDockFit(fits: boolean, deckH: number): void; onToggleMax(): void; onCollapse(): void; onGateNode(): void }
export interface ThreadContext { mapCollapsed: boolean; expandMap(): void; focusGate(): void; focusQuestion(): void }
export interface InspectorContext { placement: InspectorPlacement; collapsed?: boolean; onCollapse?(collapsed: boolean): void }

export interface ChatWorkspaceProps {
  chatKey: string;
  /** `active`: a real process is running (drives the send ring); `paused`: a paused fixed demo (stops the thinking dots). */
  flags: { welcome: boolean; sending: boolean; working: boolean; active: boolean; paused?: boolean };
  speak?: string;
  connection: ReactNode;
  /** A loaded chat exists: 协作详情 is offered. */
  hasChat: boolean;
  hasPipeline: boolean;
  /** Loading skeleton: the map pane shows the mist only. */
  skeleton: boolean;
  inspectorOpen: boolean;
  onInspector(open: boolean): void;
  /** Bumped by an open-to-tab request (查看交付物, 在协作详情中查看): expands a collapsed dock. */
  reveal?: number;
  pendingGate: 'A' | 'B' | null;
  pendingQuestion: boolean;
  /** article.chat-message + activity rows (for the mini-rail unread count). */
  itemCount: number;
  thread(context: ThreadContext): ReactNode;
  map(context: MapContext): ReactNode;
  inspector(context: InspectorContext): ReactNode;
}

const GATE_TARGET = '.gate-wrap [data-gate-confirm]';
const QUESTION_TARGET = '.chat-question [data-first-option]';

export default function ChatWorkspace(props: ChatWorkspaceProps) {
  const work = useRef<HTMLElement | null>(null);
  return <SeatFocusProvider target={work}><WorkspaceGrid {...props} workRef={work} /></SeatFocusProvider>;
}

function readInspectorWidth(): number {
  if (typeof document === 'undefined') return 340;
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--insp-w'));
  return Number.isFinite(value) ? value : 340;
}

function WorkspaceGrid(props: ChatWorkspaceProps & { workRef: { current: HTMLElement | null } }) {
  const { workRef, inspectorOpen, onInspector, hasPipeline } = props;
  const seatFocus = useSeatFocus();
  const [size, setSize] = useState({ w: 0, h: 0, insp: 340 });
  const [fraction, setFraction] = useState<number | null>(() => readStoredNumber(THREAD_KEY));
  const [userCollapsed, setUserCollapsed] = useState(() => readStoredFlag(COLLAPSED_KEY));
  const [maximised, setMaximised] = useState(false);
  const [deckReport, setDeckReport] = useState<number | null>(null);
  const reveal = props.reveal ?? 0;
  const [dockState, setDockState] = useState<DockCollapse>(() => ({ collapsed: false, open: inspectorOpen, reveal }));
  // Synced during render (not in an effect), so an open-to-tab request never paints a bare collapsed tab bar first.
  const dockSync = syncDockCollapse(dockState, inspectorOpen, reveal);
  if (dockSync !== dockState) setDockState(dockSync);
  const dockCollapsed = dockSync.collapsed;
  const setDockCollapsed = useCallback((collapsed: boolean) => setDockState(current => current.collapsed === collapsed ? current : { ...current, collapsed }), []);
  const [unreadBase, setUnreadBase] = useState(0);
  const dragging = useRef(false);
  const fractionRef = useRef(fraction);
  fractionRef.current = fraction;
  const returnFocus = useRef<HTMLElement | null>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const inspectorButton = useRef<HTMLButtonElement>(null);

  // A pin belongs to one chat: clear it when the chat changes (the new → chat id hand-off, 重新演示).
  useEffect(() => () => seatFocus.clear(), [props.chatKey, seatFocus]);

  useLayoutEffect(() => {
    const element = workRef.current;
    if (!element) return;
    const measure = () => setSize(current => {
      const next = { w: Math.round(element.clientWidth), h: Math.round(element.clientHeight), insp: readInspectorWidth() };
      return next.w === current.w && next.h === current.h && next.insp === current.insp ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [workRef]);

  const railH = hasPipeline ? 68 : 0;
  const deckH = deckReport ?? size.h;
  const wantsColumn = inspectorOpen && dockRoom(deckH, railH) < DOCK_MIN;
  const collapsed = userCollapsed || autoCollapse(size.w, wantsColumn ? size.insp : 0);
  const placement = inspectorPlacement({ maximised, collapsed, deckH, railH });
  const column = inspectorOpen && placement === 'column';
  const bounds = threadBounds(size.w, column && !collapsed ? size.insp : 0);
  const threadPx = size.w ? threadWidth(size.w, fraction, column && !collapsed ? size.insp : 0) : 0;
  const range = splitterRange(size.w, threadPx, bounds);

  const persistFraction = (value: number | null) => writeStored(THREAD_KEY, value === null ? null : String(Math.round(value * 10000) / 10000));
  const onSplit = (pct: number) => {
    const next = pct / 100;
    fractionRef.current = next;
    setFraction(next);
    if (!dragging.current) persistFraction(next);
  };

  const focusLater = (selector: string) => window.requestAnimationFrame(() => {
    const target = workRef.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  });
  const restore = useCallback((focus?: string) => {
    setMaximised(false);
    window.requestAnimationFrame(() => {
      if (focus) { focusLater(focus); return; }
      const previous = returnFocus.current;
      (previous?.isConnected && !previous.closest('[inert]') ? previous : toggleButton.current)?.focus({ preventScroll: true });
    });
  }, []);
  const maximise = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUnreadBase(props.itemCount);
    setMaximised(true);
    window.requestAnimationFrame(() => {
      const tab = workRef.current?.querySelector<HTMLElement>('.chat-map [role=tablist] [aria-selected=true]') ?? workRef.current?.querySelector<HTMLElement>('.chat-map [role=tablist]');
      tab?.focus({ preventScroll: true });
    });
  }, [props.itemCount, workRef]);
  const toggleMax = useCallback(() => { if (maximised) restore(); else maximise(); }, [maximised, maximise, restore]);
  const focusGate = useCallback(() => { if (maximised) restore(GATE_TARGET); else focusLater(GATE_TARGET); }, [maximised, restore]);
  const focusQuestion = useCallback(() => { if (maximised) restore(QUESTION_TARGET); else focusLater(QUESTION_TARGET); }, [maximised, restore]);

  // Alt+A and the Esc order (§4.2): popovers/modals first (they stop propagation), then inspector, pin, maximise.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('dialog[open]')) return;
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyA' || event.key.toLowerCase() === 'a')) {
        event.preventDefault();
        toggleMax();
        return;
      }
      if (event.key !== 'Escape') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (inspectorOpen && target?.closest('#chat-inspector')) {
        event.preventDefault();
        onInspector(false);
        window.requestAnimationFrame(() => inspectorButton.current?.focus({ preventScroll: true }));
        return;
      }
      const field = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type));
      if (field && (target as HTMLInputElement | HTMLTextAreaElement).value) return;
      if (workRef.current?.dataset.pinned) { seatFocus.clear(); return; }
      if (maximised) { event.preventDefault(); restore(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspectorOpen, maximised, onInspector, restore, seatFocus, toggleMax, workRef]);

  // A dock↔column remount keeps keyboard users on the selected tab: ChatInspector records at unmount whether focus was
  // inside it and refocuses its tab on the next mount. No workspace-level focus tracking (it went stale when focus left
  // through the portaled top-bar buttons and then pulled focus into the inspector on a later placement change).

  const expandMap = () => { setUserCollapsed(false); writeStored(COLLAPSED_KEY, null); };
  const collapseMap = () => { setUserCollapsed(true); writeStored(COLLAPSED_KEY, '1'); if (maximised) restore(); };
  // The dock row sizes itself: ChatInspector owns its height, its row splitter and dmw:deck:dock-h:v1 (§4.9). This
  // wrapper only carries the collapsed state, so the page has exactly one 调整协作详情高度 separator.
  const dock = inspectorOpen && placement === 'dock' ? <div className={`inspector-dock${dockCollapsed ? ' is-collapsed' : ''}`}>
    {props.inspector({ placement: 'dock', collapsed: dockCollapsed, onCollapse: setDockCollapsed })}
  </div> : undefined;

  const showMap = maximised || !collapsed;
  const unread = Math.max(0, props.itemCount - unreadBase);
  const { flags } = props;
  const className = ['chat-page', 'chat-work', flags.welcome && 'is-welcome', flags.sending && 'is-sending', flags.working && 'is-working', maximised && 'is-max', collapsed && !maximised && 'is-collapsed', column && 'has-column'].filter(Boolean).join(' ');
  const style = { gridTemplateColumns: gridTemplate({ maximised, collapsed, inspectorColumn: column }), '--thread-w': `${threadPx}px`, ...(props.speak ? { '--speak': props.speak } : {}) } as CSSProperties;

  return <section ref={workRef} className={className} aria-label="聊天工作台" style={style} data-active={flags.active ? '' : undefined} data-paused={flags.paused ? '' : undefined} data-placement={inspectorOpen ? placement : undefined}>
    <TopBarActions>
      {props.connection}
      <button ref={toggleButton} type="button" className="btn ghost" aria-pressed={maximised} aria-keyshortcuts="Alt+A" title="把任务地图展开为完整的架构视图（Alt+A）" onClick={toggleMax}><Icon name="maximize" size={14} />架构视图</button>
      {props.hasChat ? <button ref={inspectorButton} id="chat-inspector-toggle" type="button" className="btn ghost" aria-expanded={inspectorOpen} aria-controls="chat-inspector" onClick={() => onInspector(!inspectorOpen)}><Icon name="panel-right" size={14} />协作详情</button> : null}
    </TopBarActions>
    <div className="thread-cell">
      <div className="thread-holder" inert={maximised} style={maximised && threadPx ? { width: threadPx } : undefined}>
        {props.thread({ mapCollapsed: collapsed && !maximised, expandMap, focusGate, focusQuestion })}
      </div>
      {maximised ? <nav className="mini-rail" aria-label="聊天（已收起）">
        <button type="button" className="mini-back" onClick={() => restore()}><Icon name="message" size={16} />返回聊天{unread ? <span className="unread mono">{unread}</span> : null}</button>
        {props.pendingGate ? <button type="button" className="btn gate outline mini-flag" onClick={focusGate}>◆<span>关卡 {props.pendingGate}</span></button> : null}
        {props.pendingQuestion ? <button type="button" className="btn gate outline mini-flag" onClick={focusQuestion}>◆<span>待回答</span></button> : null}
      </nav> : null}
    </div>
    {showMap && !maximised ? <Splitter orientation="vertical" value={range.now} min={range.min} max={range.max} step={size.w ? (24 / size.w) * 100 : 1} scale={size.w / 100 || 1}
      label="调整聊天与任务地图宽度" controls="chat-thread" valueText={`聊天宽度 ${Math.round(range.now)}%`} className="thread-splitter"
      onChange={onSplit} onReset={() => { setFraction(null); persistFraction(null); }}
      onDragState={state => { dragging.current = state; if (state) workRef.current?.setAttribute('data-dragging', ''); else { workRef.current?.removeAttribute('data-dragging'); persistFraction(fractionRef.current); } }} /> : null}
    {showMap ? <div className="map-cell">{props.skeleton ? <div className="map-skeleton" aria-hidden="true" /> : props.map({
      variant: maximised ? 'full' : 'docked', dock, dockOpen: Boolean(dock), onDockFit: (_fits, height) => setDeckReport(current => current === height ? current : height),
      onToggleMax: toggleMax, onCollapse: collapseMap, onGateNode: focusGate,
    })}</div> : null}
    {column ? <div className="inspector-cell">{props.inspector({ placement: 'column' })}</div> : null}
  </section>;
}
