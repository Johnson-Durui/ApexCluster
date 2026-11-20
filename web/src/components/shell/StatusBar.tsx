// Status bar (BUILD-SPEC-B §3.4): 28px mono strip across the full width.
// 1 connection (slot; fallback = the sidebar's last /api/chats result) · 2 sandbox (GET /api/chat-capabilities .exec,
// once per mount and on workbench:capabilities-changed) · 3 page cells (slot) · grow · 5 usage (slot).
// Cells are not live regions (the top-bar chip announces), except the unsafe-sandbox alert.
// The sandbox cell is the only one that shrinks: a backend reason can be 500 characters of CLI stderr, so the cell
// shows a one-line, ellipsised reason and keeps the full text in title=; page and usage cells are never pushed off.
import { useEffect, useState } from 'react';
import { chatApi, type ChatCapabilities, type ExecCapability } from '../../lib/chat-api';
import { SlotHost, StatusCell, useReachability, useSlotClaimed, type Reachability } from './ShellSlots';

export type ExecState = { status: 'loading' } | { status: 'ready'; exec?: ExecCapability } | { status: 'error' };

/** Fired on window after settings change the exec backend (SettingsPanel, EnvironmentPage). */
export const CAPABILITIES_CHANGED = 'workbench:capabilities-changed';
/** The longest reason the cell prints; the full reason stays in the cell's title. */
export const SANDBOX_REASON_MAX = 48;

const BACKEND_NAMES: Record<NonNullable<ExecCapability['backend']>, string> = {
  docker: 'Docker',
  'wsl-bwrap': 'WSL bwrap',
  'windows-mxc': 'Windows MXC',
  'local-unsafe': '本机直连',
};

/** Pure: a reason on one line, at most `max` characters (code points), ending in … when cut. */
export function shortReason(reason: string, max = SANDBOX_REASON_MAX): string {
  const line = reason.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : line;
}

export interface SandboxCellWords { text: string; title?: string; tone?: 'alert'; muted?: boolean }

function withReason(prefix: string, reason: string, muted?: boolean): SandboxCellWords {
  const text = `${prefix}${shortReason(reason)}`;
  const full = `${prefix}${reason.trim()}`;
  return { text, ...(full !== text ? { title: full } : {}), ...(muted ? { muted } : {}) };
}

/** Pure: the sandbox cell's words and tone. `title` carries the full reason when `text` had to shorten it. */
export function sandboxCell(state: ExecState): SandboxCellWords {
  if (state.status === 'loading') return { text: '执行沙箱 · 正在读取', muted: true };
  if (state.status === 'error') return { text: '执行沙箱 · 状态未知', muted: true };
  const exec = state.exec;
  if (exec?.unsafe) return { text: '本机无沙箱执行 · 模型命令可以访问宿主文件和网络', tone: 'alert' };
  if (!exec?.backend) return withReason('执行沙箱 · ', exec?.reason ?? '未配置', true);
  const name = BACKEND_NAMES[exec.backend] ?? exec.backend;
  return exec.available ? { text: `执行沙箱 ${name} · 已就绪` } : withReason(`执行沙箱 ${name} · `, exec.reason ?? '不可用');
}

const REACH: Record<Reachability, { glyph: string; word: string; tone: string }> = {
  ok: { glyph: '●', word: '服务可达', tone: 'is-ok' },
  connecting: { glyph: '…', word: '正在连接', tone: 'is-wait' },
  offline: { glyph: '✕', word: '服务离线', tone: 'is-err' },
};

/**
 * Loads the exec capability now and again on every `workbench:capabilities-changed` on `target`; a newer load aborts
 * the older one. Returns the stop function (removes the listener, aborts the load in flight).
 */
export function watchExecCapability(target: EventTarget, load: (signal: AbortSignal) => Promise<Pick<ChatCapabilities, 'exec'>>, onState: (state: ExecState) => void): () => void {
  let controller: AbortController | undefined;
  const refresh = () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    load(current.signal)
      .then(value => { if (!current.signal.aborted) onState({ status: 'ready', exec: value.exec }); })
      .catch(() => { if (!current.signal.aborted) onState({ status: 'error' }); });
  };
  refresh();
  target.addEventListener(CAPABILITIES_CHANGED, refresh);
  return () => { target.removeEventListener(CAPABILITIES_CHANGED, refresh); controller?.abort(); };
}

function useExecCapability(): ExecState {
  const [state, setState] = useState<ExecState>({ status: 'loading' });
  useEffect(() => watchExecCapability(window, signal => chatApi.capabilities(signal), setState), []);
  return state;
}

/** The sandbox cell: an alert when execution is unsandboxed, else a shrinkable, ellipsised wide cell. */
export function SandboxCell({ words }: { words: SandboxCellWords }) {
  return words.tone === 'alert'
    ? <StatusCell tone="alert" role="alert">{words.text}</StatusCell>
    : <StatusCell wide className="sb-sandbox" title={words.title ?? words.text}><span className={words.muted ? 'sb-muted' : undefined}>{words.text}</span></StatusCell>;
}

export default function StatusBar() {
  const reach = useReachability();
  const connectionClaimed = useSlotClaimed('status-connection');
  const sandbox = sandboxCell(useExecCapability());
  const words = REACH[reach];
  return <footer className="app-status" aria-label="状态栏">
    <span className="sb-cell sb-conn">
      <SlotHost name="status-connection" />
      {connectionClaimed ? null : <span className={`sb-reach ${words.tone}`}><i aria-hidden="true">{words.glyph}</i>{words.word}</span>}
      <span className="sb-local"> · 本机 · 仅本机访问</span>
    </span>
    <SandboxCell words={sandbox} />
    <SlotHost name="status-cells" />
    <span className="sb-grow" aria-hidden="true" />
    <SlotHost name="status-usage" className="sb-right" />
  </footer>;
}
