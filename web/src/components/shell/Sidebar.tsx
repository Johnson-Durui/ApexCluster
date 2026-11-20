// Sidebar (BUILD-SPEC-B §3.2): one navigation on every route. 248px at ≥1321px; a 64px icon rail at ≤1320px, where the
// recent-chat list moves into a 最近聊天 dialog. Data: GET /api/chats + fixed demos (refetched on every route change and on
// the workbench:* events), GET /api/runs (waiting badge only). The last chat-list result also feeds the status bar.
import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { api } from '../../lib/api';
import { chatApi, type ChatSummary } from '../../lib/chat-api';
import { isFixedDemoId } from '../../lib/fixed-demo';
import type { RunSummary } from '../../lib/types';
import { chatStatusKind, chatStatusLabel, parseChatHash } from '../../pages/chat/chatNavigation';
import { BrandMark, Icon, Modal, Status, Tag, type IconName } from '../ui';
import { setReachability } from './ShellSlots';

export type NavKey = 'chat' | 'history' | 'new' | 'environment';
export const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; href: string; icon: IconName }> = [
  { key: 'chat', label: '聊天', href: '#/', icon: 'message' },
  { key: 'history', label: '任务历史', href: '#/history', icon: 'history' },
  { key: 'new', label: '新建评审', href: '#/new', icon: 'review' },
  { key: 'environment', label: '环境与连接', href: '#/environment', icon: 'shield' },
];
const CHAT_LIMIT = 20;

/**
 * aria-current of a nav row: "page" on an exact match (the chat home `#/` and `#/?new=1` count as 聊天), "true" when a
 * child page is open (`#/?chat=` → 聊天, `#/runs/:id` → 任务历史), whose own row/page then owns "page".
 */
export function navCurrent(key: NavKey, route: string): 'page' | 'true' | undefined {
  const path = route.split('?')[0] || '/';
  if (key === 'chat') return path === '/' ? (parseChatHash(route).chatId ? 'true' : 'page') : undefined;
  if (key === 'history') return path === '/history' ? 'page' : /^\/runs\/[^/]+$/.test(path) ? 'true' : undefined;
  if (key === 'new') return path === '/new' ? 'page' : undefined;
  return path === '/environment' ? 'page' : undefined;
}

/** Waiting-on-you counts for the nav badges. Legacy simulated runs are not counted (as on the history page). */
export function waitingCounts(chats: ChatSummary[], runs: RunSummary[] | null) {
  return {
    chat: chats.filter(chat => chat.status === 'waiting_user').length,
    history: (runs ?? []).filter(run => run.mode !== 'mock' && run.phaseStatus === 'waiting_user' && !run.terminal).length,
  };
}

export function SidebarNav({ route, counts }: { route: string; counts: Partial<Record<NavKey, number>> }) {
  return <nav className="side-nav" aria-label="工作区导航">
    {NAV_ITEMS.map(item => {
      const count = counts[item.key] ?? 0;
      return <a key={item.key} href={item.href} className="side-nav-item" data-nav={item.key} aria-current={navCurrent(item.key, route)}
        aria-label={count ? `${item.label}，${count} 项等你处理` : undefined}>
        <Icon name={item.icon} size={16} /><span className="side-nav-label">{item.label}</span>
        {count ? <span className="side-count" aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
      </a>;
    })}
  </nav>;
}

export function filterChats(chats: ChatSummary[], query: string): ChatSummary[] {
  const needle = query.trim().toLowerCase();
  return chats.filter(chat => !needle || `${chat.title} ${chat.id} ${chatStatusLabel(chat.status)}`.toLowerCase().includes(needle)).slice(0, CHAT_LIMIT);
}

/** The recent-chat list and its states. Shared by the full sidebar and the rail's 最近聊天 dialog. */
export function ChatList({ chats, route, query, loading, error, onRetry, onNavigate }: {
  chats: ChatSummary[]; route: string; query: string; loading: boolean; error: string; onRetry(): void; onNavigate?(): void;
}) {
  const visible = filterChats(chats, query);
  const current = (route.split('?')[0] || '/') === '/' ? parseChatHash(route).chatId : null;
  const showLoading = loading && !chats.length && !error;
  const empty = !visible.length && !error && !showLoading && (!loading || !!query.trim());
  return <div className="side-chats">
    {visible.length ? <ul>{visible.map(chat => <li key={chat.id}>
      <a href={`#/?chat=${encodeURIComponent(chat.id)}`} aria-current={chat.id === current ? 'page' : undefined} title={chat.title} onClick={onNavigate}>
        <b>{chat.title}</b>
        <span className="side-chat-meta"><Status kind={chatStatusKind(chat.status)}>{chatStatusLabel(chat.status)}</Status>{isFixedDemoId(chat.id) ? <Tag tone="mock">▷ 演示</Tag> : null}</span>
      </a>
    </li>)}</ul> : null}
    {error ? <div className="side-error" role="alert"><span>{error}</span><button type="button" className="btn sm" onClick={onRetry}>重试</button></div> : null}
    {showLoading ? <p className="side-note" role="status">正在读取记录…</p>
      : empty ? <p className="side-note">{query.trim() ? '没有匹配的聊天' : '你的聊天会保存在这里。'}</p> : null}
  </div>;
}

function ChatSearch({ value, onChange, inputRef }: { value: string; onChange(value: string): void; inputRef?: Ref<HTMLInputElement> }) {
  return <label className="side-search"><span className="side-prompt" aria-hidden="true">&gt;</span>
    <input ref={inputRef} type="search" aria-label="搜索聊天" placeholder="搜索聊天" value={value} onChange={event => onChange(event.target.value)} />
  </label>;
}

export default function Sidebar({ route }: { route: string }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [recentOpen, setRecentOpen] = useState(false);
  const dialogSearch = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let updateTimer: number | undefined;
    const created = () => setRevision(value => value + 1);
    const updated = () => {
      if (updateTimer !== undefined) return;
      updateTimer = window.setTimeout(() => { updateTimer = undefined; setRevision(value => value + 1); }, 500);
    };
    window.addEventListener('workbench:run-created', created);
    window.addEventListener('workbench:chat-created', created);
    window.addEventListener('workbench:chat-updated', updated);
    return () => {
      window.removeEventListener('workbench:run-created', created);
      window.removeEventListener('workbench:chat-created', created);
      window.removeEventListener('workbench:chat-updated', updated);
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    setLoading(true);
    chatApi.list(controller.signal)
      .then(value => { if (!live()) return; setChats(value); setError(''); setReachability('ok'); })
      .catch(cause => { if (!live()) return; setError(cause instanceof Error && cause.message ? cause.message : '聊天记录读取失败'); setReachability('offline'); })
      .finally(() => { if (live()) setLoading(false); });
    api.get<RunSummary[]>('/api/runs', controller.signal).then(value => { if (live()) setRuns(value); }).catch(() => undefined);
    return () => controller.abort();
  }, [route, revision]);

  const counts = useMemo(() => waitingCounts(chats, runs), [chats, runs]);
  const retry = () => setRevision(value => value + 1);
  const listProps = { chats, route, query, loading, error, onRetry: retry };

  return <aside className="app-side" aria-label="工作区">
    <div className="side-brand"><BrandMark size={24} /><b>多 Agent 工作台</b><small>本机</small></div>
    <a className="btn primary side-new" href="#/?new=1"><Icon name="plus" size={16} /><span>新聊天</span></a>
    <SidebarNav route={route} counts={counts} />
    <button type="button" className="btn-reset side-tile side-recent-tile" aria-haspopup="dialog" aria-expanded={recentOpen} onClick={() => setRecentOpen(true)}>
      <Icon name="search" size={16} /><span>最近聊天</span>
    </button>
    <section className="side-recent" aria-labelledby="side-recent-title">
      <div className="side-recent-head"><span id="side-recent-title">最近聊天</span>
        <button type="button" className="icon-btn side-refresh" aria-label="刷新聊天列表" disabled={loading} onClick={retry}><Icon name="refresh" size={14} /></button>
      </div>
      <ChatSearch value={query} onChange={setQuery} />
      <ChatList {...listProps} />
    </section>
    <div className="side-foot"><Icon name="shield" size={15} /><span>本机工作空间 · 记录保存在本机</span></div>
    {recentOpen ? <Modal title="最近聊天" size="sm" className="side-recent-dialog" initialFocus={dialogSearch} onClose={() => setRecentOpen(false)}>
      <ChatSearch value={query} onChange={setQuery} inputRef={dialogSearch} />
      <ChatList {...listProps} onNavigate={() => setRecentOpen(false)} />
    </Modal> : null}
  </aside>;
}
