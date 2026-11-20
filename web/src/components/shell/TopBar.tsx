// Top bar (BUILD-SPEC-B §3.3): 44px, two portal slots (<TopBarTitle>, <TopBarActions> from ShellSlots). Pages fill them;
// until a page claims a slot the shell shows a route fallback, so every route has a title. The fallback title is a span:
// the chat page's crumb h1 and the other pages' head h1 are owned by the pages.
import { Fragment, type ReactNode } from 'react';
import { Icon } from '../ui';
import { SlotHost, useSlotClaimed } from './ShellSlots';

export interface CrumbPart { label: string; href?: string }

/** Title-slot crumb: earlier segments (first one a link), then the current segment — an h1 only on chat routes. */
export function Crumb({ trail = [], current, heading = false, children }: { trail?: CrumbPart[]; current: ReactNode; heading?: boolean; children?: ReactNode }) {
  return <div className="crumb">
    {trail.map((part, index) => <Fragment key={`${part.label}-${index}`}>
      {part.href ? <a href={part.href}>{part.label}</a> : <span>{part.label}</span>}
      <span className="crumb-sep" aria-hidden="true">/</span>
    </Fragment>)}
    {heading ? <h1 className="crumb-current">{current}</h1> : <span className="crumb-current">{current}</span>}
    {children}
  </div>;
}

export type ConnState = 'live' | 'connecting' | 'recovering' | 'offline' | 'demo';
export const CONN_WORDS: Record<ConnState, { glyph: string; word: string }> = {
  live: { glyph: '●', word: '实时已连接' },
  connecting: { glyph: '◌', word: '正在连接' },
  recovering: { glyph: '↻', word: '正在恢复连接' },
  offline: { glyph: '✕', word: '服务离线' },
  demo: { glyph: '▷', word: '预设演示流' },
};

/**
 * Connection chip (glyph + word). `active` = some task is queued|running|waiting_children; only then does the live dot
 * loop (never for waiting_user or a gate alone). role=status; the text changes only on a state change.
 */
export function ConnChip({ state, active = false, className = '' }: { state: ConnState; active?: boolean; className?: string }) {
  const { glyph, word } = CONN_WORDS[state];
  return <span className={`conn-chip is-${state} ${className}`.trim()} role="status" data-active={active && state === 'live' ? '' : undefined}>
    <i aria-hidden="true">{glyph}</i>{word}
  </span>;
}

type Fallback = { title: ReactNode; actions?: ReactNode };
const DEV_NAMES: Record<string, string> = { trace: '执行轨迹', observatory: '架构视图', thread: '聊天线程', inspector: '协作详情' };

/** The shell's own title/actions for a route, shown until the page fills the slots (§3.3 table). */
export function routeFallback(route: string): Fallback {
  const [path = '/', query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  if (path === '/' || path === '') {
    return { title: <Crumb trail={[{ label: '聊天', href: '#/' }]} current={params.get('chat') ? '正在恢复聊天…' : '新聊天'} /> };
  }
  if (path === '/history') {
    return {
      title: <Crumb current="任务历史"><span className="crumb-note">· 评审运行队列</span></Crumb>,
      actions: <a className="btn primary" href="#/new"><Icon name="plus" size={15} />新建评审</a>,
    };
  }
  if (path === '/new') {
    return { title: <Crumb trail={[{ label: '任务历史', href: '#/history' }]} current="新建评审" />, actions: <a className="btn ghost" href="#/history">取消</a> };
  }
  if (path === '/environment') return { title: <Crumb current="环境与连接" /> };
  if (/^\/runs\/[^/]+$/.test(path)) return { title: <Crumb trail={[{ label: '任务历史', href: '#/history' }]} current="任务详情" /> };
  const dev = /^\/dev\/([a-z]+)$/.exec(path)?.[1];
  if (dev && import.meta.env.DEV && DEV_NAMES[dev]) return { title: <Crumb trail={[{ label: '开发演示' }]} current={DEV_NAMES[dev]} /> };
  return { title: <Crumb current="页面不存在" /> };
}

export default function TopBar({ route }: { route: string }) {
  const titleClaimed = useSlotClaimed('title');
  const actionsClaimed = useSlotClaimed('actions');
  const fallback = routeFallback(route);
  return <header className="app-top">
    <div className="top-title"><SlotHost name="title" />{titleClaimed ? null : fallback.title}</div>
    <div className="top-actions"><SlotHost name="actions" />{actionsClaimed ? null : fallback.actions}</div>
  </header>;
}
