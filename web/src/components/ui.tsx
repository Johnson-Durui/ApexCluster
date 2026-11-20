import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { holdClock } from './motion';

const ICONS = {
  plus: <path d="M12 5v14M5 12h14" />,
  'arrow-up': <path d="M12 19V5m-6 6 6-6 6 6" />,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 1h18" />,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  edit: <><path d="m16 3 5 5M5 16l-1 5 5-1L21 8a2 2 0 0 0-5-5L5 16Z" /><path d="M12 4H5a2 2 0 0 0-2 2v5" /></>,
  'arrow-right': <path d="M5 12h14M12 5l7 7-7 7" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  alert: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  refresh: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8M16 13H8M16 17H8" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  copy: <><rect x="8" y="8" width="14" height="14" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
  activity: <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />,
  list: <path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13" />,
  layers: <><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" /></>,
  scale: <><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="M7 21h10M12 3v18" /><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" /></>,
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  flag: <><path d="M4 22V4" /><path d="M4 4h12l-2 4 2 4H4" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  settings: <><path d="M20 7h-9M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>,
  user: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="m16 11 2 2 4-4" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  help: <><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>,
  circle: <circle cx="12" cy="12" r="9" />,
  box: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></>,
  pin: <><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></>,
  maximize: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  minimize: <path d="m14 10 7-7M20 10h-6V4M3 21l7-7M4 14h6v6" />,
  'panel-right': <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>,
  'panel-bottom': <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 15h18" /></>,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  grip: <><circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" /></>,
  history: <><path d="M4 6h16M4 12h16M4 18h10" /><circle cx="19" cy="18" r="2" /></>,
  review: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M10 14h6M13 11v6" /></>,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={`icon ${className}`.trim()} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[name]}</svg>;
}

/** ApexCluster mark: vibrant multi-color braided stream A (3C Macaron Pop) with floating cluster beads. */
export function BrandMark({ size = 30 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  const archId = `bm-a-${uid}`;
  const waveId = `bm-w-${uid}`;
  const maskId = `bm-m-${uid}`;
  return <svg className="brand-mark" width={size} height={size} viewBox="5 6 54 54" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={archId} x1="20" y1="36" x2="44" y2="36" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#ff5e92" />
        <stop offset="50%" stopColor="#a364ff" />
        <stop offset="100%" stopColor="#4d8dff" />
      </linearGradient>
      <linearGradient id={waveId} x1="12" y1="38" x2="52" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#ff7847" />
        <stop offset="100%" stopColor="#ffc83d" />
      </linearGradient>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect x="0" y="0" width="64" height="64" fill="#ffffff" />
        <path d="M13.5 34.2 C21.0 34.2 24.4 43.2 32.2 43.2 C39.4 43.2 42.6 32.8 50.6 32.8" fill="none" stroke="#000000" strokeWidth="9.6" strokeLinecap="round" />
      </mask>
    </defs>
    <g fill="none" strokeLinecap="round" strokeLinejoin="round" mask={`url(#${maskId})`}>
      <path d="M12.5 46.8 C16.8 46.8 19.2 43.4 21.8 37.6" stroke="#24d4b0" strokeWidth="6.2" />
      <path d="M41.8 36.0 L43.6 40.4 C45.4 44.8 47.6 46.8 51.2 46.8" stroke="#42b8ff" strokeWidth="6.2" />
      <path d="M21.8 37.6 L27.6 23.4 C30.0 17.6 34.4 17.6 36.8 23.4 L41.8 36.0" stroke={`url(#${archId})`} strokeWidth="6.2" />
    </g>
    <path className="bm-flow" d="M13.5 34.2 C21.0 34.2 24.4 43.2 32.2 43.2 C39.4 43.2 42.6 32.8 50.6 32.8" fill="none" stroke={`url(#${waveId})`} strokeWidth="5.6" strokeLinecap="round" strokeLinejoin="round" />
    <circle className="bm-dot-2" cx="11.2" cy="26.2" r="2.8" fill="#ffc83d" />
    <circle className="bm-dot" cx="53.6" cy="25.2" r="3.2" fill="#24d4b0" />
  </svg>;
}

export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`.trim()}>{children}</span>; }

/** Status kinds (BUILD-SPEC-B §2): always glyph + word + colour, never colour alone. */
export type StatusKind = 'run' | 'ok' | 'you' | 'child' | 'queue' | 'err' | 'stop' | 'idle' | 'block' | 'demo';
export const STATUS_GLYPH: Record<StatusKind, string> = { run: '▶', ok: '✓', you: '◆', child: '‖', queue: '⋯', err: '✕', stop: '■', idle: '○', block: '⊘', demo: '▷' };
export const STATUS_WORD: Record<StatusKind, string> = { run: '运行中', ok: '已完成', you: '等你决定', child: '等待子任务', queue: '排队中', err: '已失败', stop: '已停止', idle: '未开始', block: '已阻塞', demo: '预设演示' };

/** `span.st.{kind}`: aria-hidden glyph + word. `hideWord` keeps the word for screen readers only. */
export function Status({ kind, children, hideWord = false, className = '' }: { kind: StatusKind; children?: ReactNode; hideWord?: boolean; className?: string }) {
  const word = children ?? STATUS_WORD[kind];
  return <span className={`st ${kind} ${className}`.trim()}><i aria-hidden="true">{STATUS_GLYPH[kind]}</i>{hideWord ? <span className="sr-only">{word}</span> : word}</span>;
}

export type TagTone = 'you' | 'ok' | 'err' | 'wait' | 'mock';
/** Small bordered label. `mock` is the dashed tag for fixed demos and simulated data (`▷ 预设演示`). */
export function Tag({ children, tone, className = '', title }: { children: ReactNode; tone?: TagTone; className?: string; title?: string }) {
  return <span className={`tag${tone ? ` ${tone}` : ''}${className ? ` ${className}` : ''}`} title={title}>{children}</span>;
}

/** Seat ink dot. Known seats resolve --ink-s from [data-seat]; pass `ink` (seatInk(id)) for any other seat. */
export function SeatDot({ seat, ink, className = '' }: { seat?: string; ink?: string; className?: string }) {
  return <span className={`seat-dot ${className}`.trim()} data-seat={seat} style={ink ? { '--ink-s': ink } as CSSProperties : undefined} aria-hidden="true" />;
}

export function EmptyState({ title, children, icon = 'layers', numeral, tone, role }: { title: string; children?: ReactNode; icon?: IconName; numeral?: ReactNode; tone?: 'error'; role?: 'alert' | 'status' }) {
  return <div className={`empty-state${tone === 'error' ? ' is-error' : ''}`} role={role}>
    <span className="empty-symbol" aria-hidden="true"><Icon name={icon} size={24} /></span>
    {numeral !== undefined ? <span className="empty-numeral">{numeral}</span> : null}
    <h3>{title}</h3><div className="muted">{children}</div>
  </div>;
}

export function SectionTitle({ title, eyebrow, children }: { title: string; eyebrow?: string; children?: ReactNode }) {
  return <div className="section-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>{children}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Native <dialog>. Escape closes the top layer only; a backdrop click closes; focus returns to the opener.
 * size: sm 440 · md 640 (default) · lg 840 · xl min(1180px, 100vw−48px). initialFocus defaults to the close button
 * (confirm sheets pass their safe button). While any Modal is open the shell recedes and the map clock pauses.
 */
export function Modal({ title, children, onClose, returnFocusTo, className = '', size = 'md', initialFocus, footer }: { title: string; children: ReactNode; onClose: () => void; returnFocusTo?: HTMLElement | null; className?: string; size?: ModalSize; initialFocus?: RefObject<HTMLElement | null>; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const close = useRef<HTMLButtonElement>(null); const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const release = holdClock();
    dialog?.showModal();
    (initialFocus?.current ?? close.current)?.focus({ preventScroll: true });
    return () => { release(); if (dialog?.open) dialog.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog className={`modal modal-${size} ${className}`.trim()} ref={ref} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClick={e => { if (e.target === ref.current) { const bounds = ref.current.getBoundingClientRect(); if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) onClose(); } }}>
    <div className="modal-head"><h2 id={id}>{title}</h2><button ref={close} type="button" aria-label="关闭对话框" className="icon-button ghost" onClick={onClose}><Icon name="x" size={18} /></button></div>
    <div className="modal-body">{children}</div>
    {footer ? <div className="modal-foot">{footer}</div> : null}
  </dialog>;
}
