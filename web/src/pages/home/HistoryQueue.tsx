// History filters + queue listbox (BUILD-SPEC-B §6.2). Options carry no links or buttons; ↑/↓ move the selection,
// Enter or a double-click opens the run. The waiting group comes first.
import { useSyncExternalStore, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import type { RunSummary } from '../../lib/types';
import { formatDate } from '../../lib/labels';
import { EmptyState, Icon, Status, STATUS_GLYPH, Tag, type StatusKind } from '../../components/ui';
import { GatePips } from '../run/header/GateTrack';
import { summaryTrack, type RunFilter } from './homeModel';
import { groupRuns, optionLabel, orderedRows, phaseText, rowStatusWord, runKind, type HistorySort } from './historyModel';

/** Viewport media query as React state (no polling; SSR = false). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    listener => { if (typeof window === 'undefined' || !window.matchMedia) return () => undefined; const media = window.matchMedia(query); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener); },
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
    () => false,
  );
}

/** Entrance (§7 row 23): 240ms each, 20ms stagger, capped so the whole sequence ends under 400ms. */
export const rise = (index: number): CSSProperties => ({ '--rise-delay': `${Math.min(index * 20, 140)}ms` } as CSSProperties);

const FILTERS: { value: RunFilter; label: string; kind?: StatusKind }[] = [
  { value: 'all', label: '全部' }, { value: 'waiting', label: '等你决定', kind: 'you' }, { value: 'active', label: '进行中', kind: 'run' }, { value: 'ended', label: '已结束', kind: 'ok' },
];

export interface FilterProps {
  filter: RunFilter; onFilter(value: RunFilter): void;
  counts: Record<RunFilter, number> | null;
  showLegacy: boolean; onLegacy(value: boolean): void; legacyCount: number;
  sort: HistorySort; onSort(value: HistorySort): void;
}

function LegacyToggle({ showLegacy, onLegacy, legacyCount }: Pick<FilterProps, 'showLegacy' | 'onLegacy' | 'legacyCount'>) {
  return <label className="check-label legacy-toggle"><input type="checkbox" checked={showLegacy} onChange={event => onLegacy(event.target.checked)} /><span>显示早期模拟测试记录（{legacyCount}）</span></label>;
}

function SortSelect({ sort, onSort }: Pick<FilterProps, 'sort' | 'onSort'>) {
  return <select className="hq-sort" aria-label="排序" value={sort} onChange={event => onSort(event.target.value as HistorySort)}><option value="updated">最近更新</option><option value="created">创建时间</option></select>;
}

/** The 196px filter column (≥1321px). */
export function HistoryFilters(props: FilterProps & { style?: CSSProperties }) {
  const { filter, onFilter, counts } = props;
  return <aside className="hq-filters rise" style={props.style} aria-label="筛选">
    <div><h2>状态</h2><div className="hq-flist" role="group" aria-label="按状态筛选">{FILTERS.map(item => <button key={item.value} type="button" className="btn-reset" aria-pressed={filter === item.value} onClick={() => onFilter(item.value)}>
      {item.kind ? <i className={`st ${item.kind}`} aria-hidden="true"><i>{STATUS_GLYPH[item.kind]}</i></i> : <i className="hq-fpad" aria-hidden="true" />}
      <span>{item.label}</span><span className="hq-n mono">{counts ? counts[item.value] : '—'}</span>
    </button>)}</div></div>
    {props.legacyCount ? <div><h2>记录</h2><LegacyToggle {...props} /></div> : null}
    <div><h2>排序</h2><SortSelect {...props} /></div>
  </aside>;
}

/** The same filters as chips inside the queue toolbar (≤1320px). */
function FilterChips(props: FilterProps) {
  return <div className="hq-compact">
    <div className="hq-chips" role="group" aria-label="按状态筛选">{FILTERS.map(item => <button key={item.value} type="button" className="btn-reset" aria-pressed={props.filter === item.value} onClick={() => props.onFilter(item.value)}>{item.label}<span className="mono">{props.counts ? props.counts[item.value] : '—'}</span></button>)}</div>
    <SortSelect {...props} />
    {props.legacyCount ? <LegacyToggle {...props} /> : null}
  </div>;
}

export interface QueueProps extends FilterProps {
  rows: RunSummary[];
  total: number;
  hasRealRuns: boolean;
  loading: boolean; loaded: boolean; error: string; onRetry(): void;
  query: string; onQuery(value: string): void;
  /** `via: 'pointer'` marks a row click: below 1100px the overlay then arms against the trailing click of a double-click. */
  selected: string | null; onSelect(id: string, via?: 'pointer'): void; onOpen(id: string): void;
  compact: boolean;
  listRef: RefObject<HTMLDivElement | null>;
}

export const optionId = (id: string) => `hq-opt-${id}`;

function Row({ run, selected, index }: { run: RunSummary; selected: boolean; index: number }) {
  const kind = runKind(run);
  const legacy = run.mode === 'mock';
  return <div role="option" id={optionId(run.id)} aria-selected={selected} aria-label={optionLabel(run)} data-id={run.id}
    className={`hq-row is-${kind}${legacy ? ' legacy' : ''}${index < 12 ? ' rise' : ''}`} style={index < 12 ? rise(index + 6) : undefined}>
    <span className={`hq-glyph st ${kind}`} aria-hidden="true"><i>{STATUS_GLYPH[kind]}</i></span>
    <span className="hq-title"><b>{run.title}</b><small><span className="mono">{run.id}</span>{legacy ? <Tag tone="mock">模拟数据</Tag> : null}</small></span>
    <span className="hq-phase">{phaseText(run)}</span>
    <GatePips items={summaryTrack(run)} />
    <Status kind={kind} className="hq-status">{rowStatusWord(run)}</Status>
    <span className="hq-upd mono">{formatDate(run.updatedAt)}</span>
  </div>;
}

function QueueBody(props: QueueProps) {
  const { rows, loading, loaded, error, selected } = props;
  if (!loaded) return loading ? <p className="loading" role="status">正在读取运行列表…</p> : null;
  if (!rows.length) {
    if (error) return null;
    return props.hasRealRuns || props.showLegacy
      ? <EmptyState title="没有符合条件的运行" icon="search"><p>调整筛选或搜索条件后再看。</p></EmptyState>
      : <EmptyState title="还没有评审运行" icon="list"><p>新建一次评审：两位模型独立设计、交叉评审，关键决定由你在关卡确认。</p><div className="empty-actions"><a className="btn primary" href="#/new"><Icon name="plus" size={15} />新建评审</a></div></EmptyState>;
  }
  const { waiting, others } = groupRuns(rows);
  let index = 0;
  const group = (items: RunSummary[], label: string, you: boolean) => items.length ? <div role="group" aria-label={`${label} · ${items.length}`} key={label}>
    <div className={`hq-sep${you ? ' is-you' : ''}`} aria-hidden="true">{you ? <i className="st you"><i>{STATUS_GLYPH.you}</i></i> : null}{label} · {items.length}</div>
    {items.map(run => <Row key={run.id} run={run} selected={run.id === selected} index={index++} />)}
  </div> : null;
  return <>{group(waiting, '等你决定', true)}{group(others, '其他运行', false)}</>;
}

export function HistoryQueue(props: QueueProps) {
  const { rows, selected, onSelect, onOpen, listRef } = props;
  const visibleSelected = selected && rows.some(run => run.id === selected) ? selected : null;
  const ordered = orderedRows(rows);
  const move = (next: RunSummary | undefined) => {
    if (!next) return;
    onSelect(next.id);
    window.requestAnimationFrame(() => document.getElementById(optionId(next.id))?.scrollIntoView({ block: 'nearest' }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = ordered.findIndex(run => run.id === visibleSelected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      move(ordered[at < 0 ? (step > 0 ? 0 : ordered.length - 1) : Math.max(0, Math.min(ordered.length - 1, at + step))]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      move(event.key === 'Home' ? ordered[0] : ordered.at(-1));
    } else if (event.key === 'Enter' && visibleSelected) {
      event.preventDefault();
      onOpen(visibleSelected);
    }
  };
  const rowOf = (target: EventTarget) => (target as HTMLElement).closest<HTMLElement>('[role=option]')?.dataset.id;
  return <section className="hq-queue" aria-label="运行队列">
    <div className="hq-tools rise" style={rise(5)}>
      <label className="hq-search"><span className="hq-prompt" aria-hidden="true">&gt;</span><input type="search" aria-label="搜索运行" value={props.query} onChange={event => props.onQuery(event.target.value)} placeholder="按标题或编号搜索" /></label>
      {props.compact ? <FilterChips {...props} /> : null}
      <span className="hq-count mono">{props.loaded ? `显示 ${rows.length} / ${props.total} 次运行` : ''}</span>
    </div>
    {props.error ? <div className="alert bad hq-error" role="alert"><span>{props.error}</span><button type="button" className="btn sm" onClick={props.onRetry}>重试连接</button></div> : null}
    <div className="hq-head" aria-hidden="true"><span /><span>运行</span><span className="hq-phase">当前阶段</span><span>关卡进度</span><span>状态</span><span className="hq-upd">最近更新</span></div>
    {props.loaded && rows.length
      ? <div className="hq-list" ref={listRef} role="listbox" tabIndex={0} aria-label="运行列表" aria-activedescendant={visibleSelected ? optionId(visibleSelected) : undefined}
        onKeyDown={onKeyDown}
        onClick={event => { const id = rowOf(event.target); if (id) { listRef.current?.focus({ preventScroll: true }); onSelect(id, 'pointer'); } }}
        onDoubleClick={event => { const id = rowOf(event.target); if (id) onOpen(id); }}>
        <QueueBody {...props} />
      </div>
      : <div className="hq-list hq-empty"><QueueBody {...props} /></div>}
  </section>;
}
