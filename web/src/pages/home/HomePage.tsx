// 任务历史 (#/history, BUILD-SPEC-B §6.2): page head + KPI strip, then filters | queue listbox | inspector.
// Data: GET /api/runs (refetched on 刷新 and on workbench:run-created; no polling) and GET /api/config for the guide.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, initSession } from '../../lib/api';
import type { AppConfig, RunSummary } from '../../lib/types';
import { Icon, STATUS_GLYPH, type StatusKind } from '../../components/ui';
import { reducedMotion } from '../../components/motion';
import { Crumb } from '../../components/shell/TopBar';
import { StatusCell, StatusCells, TopBarActions, TopBarTitle } from '../../components/shell/ShellSlots';
import { homeStats, visibleRuns, type RunFilter } from './homeModel';
import { filterCounts, orderedRows, pad2, readSelected, sortRuns, writeSelected, type HistorySort } from './historyModel';
import { HistoryFilters, HistoryQueue, rise, useMedia } from './HistoryQueue';
import HistoryInspector from './HistoryInspector';
import './home.css';

/** §7 row 23 plays once per app launch, on the first successful /api/runs render (never on the `—` state). */
let entrancePlayed = false;
/** Windows' default double-click time: how long a just-opened narrow-window overlay lets the pointer through. */
const DOUBLE_CLICK_MS = 500;

/** One KPI cell: Georgia numeral, glyph + word, caption. The 等你决定 cell turns indigo only while something waits on you. */
function Kpi({ value, word, kind, caption, tone, index }: { value: number | null; word: string; kind?: StatusKind; caption: string; tone?: 'you'; index: number }) {
  const ink = kind === 'you' && tone !== 'you' ? 'idle' : kind;
  return <div className={`kpi rise${tone === 'you' ? ' is-you' : ''}`} style={rise(index)}>
    <b className="kpi-num numeral">{value === null ? '—' : pad2(value)}</b>
    <span className={`kpi-word${ink ? ` st ${ink}` : ''}`}>{kind ? <i aria-hidden="true">{STATUS_GLYPH[kind]}</i> : null}{word}</span>
    <small>{caption}</small>
  </div>;
}

export default function HomePage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [filter, setFilter] = useState<RunFilter>('all');
  const [query, setQuery] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  const [sort, setSort] = useState<HistorySort>('updated');
  const [selected, setSelected] = useState<string | null>(() => readSelected());
  const [userSelected, setUserSelected] = useState(false);
  const [entering, setEntering] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const compact = useMedia('(max-width: 1320px)');
  const overlay = useMedia('(max-width: 1099px)');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([initSession(), api.get<RunSummary[]>('/api/runs')])
      .then(([, data]) => { setRuns(data); setError(''); setLoaded(true); })
      .catch(cause => setError(cause instanceof Error ? cause.message : '读取运行列表失败'))
      .finally(() => setLoading(false));
  }, []);
  const loadConfig = useCallback(() => {
    setConfigError(false);
    api.get<AppConfig>('/api/config').then(setConfig).catch(() => { setConfig(null); setConfigError(true); });
  }, []);
  useEffect(() => { load(); loadConfig(); }, [load, loadConfig]);
  useEffect(() => {
    window.addEventListener('workbench:run-created', load);
    return () => window.removeEventListener('workbench:run-created', load);
  }, [load]);
  useEffect(() => {
    if (!loaded || entrancePlayed) return;
    entrancePlayed = true;
    if (reducedMotion()) return;
    setEntering(true);
    // Fail-open: the entrance never holds content back. Not cleared on cleanup, so a StrictMode re-run cannot leave
    // `data-entering` on (which would replay the rise on rows added later by filtering).
    window.setTimeout(() => setEntering(false), 900);
  }, [loaded]);

  const stats = useMemo(() => loaded ? homeStats(runs) : null, [loaded, runs]);
  const counts = useMemo(() => loaded ? filterCounts(runs, showLegacy) : null, [loaded, runs, showLegacy]);
  const rows = useMemo(() => orderedRows(sortRuns(visibleRuns(runs, { filter, query, showLegacy }), sort)), [runs, filter, query, showLegacy, sort]);
  const selectedRun = runs.find(run => run.id === selected) ?? null;
  const selectedRef = useRef(selected);
  const select = useCallback((id: string | null) => {
    if (selectedRef.current === id) return;   // re-selecting is a no-op (§7 row 22)
    selectedRef.current = id;
    setSelected(id);
    setUserSelected(true);
    writeSelected(id);
  }, []);
  const open = (id: string) => { window.location.hash = `/runs/${id}`; };
  // Below 1100px a row click opens the inspector over the queue. For one double-click interval the overlay lets the
  // pointer through, so the second click still reaches the row and the listbox's double-click opens the run; focus then
  // moves to 返回列表 so it is not left on the covered list. Keyboard selection keeps focus on the list (↑/↓, Enter).
  const [arming, setArming] = useState(false);
  const armTimer = useRef(0);
  const backRef = useRef<HTMLButtonElement>(null);
  const focusBack = useRef(false);
  useEffect(() => () => window.clearTimeout(armTimer.current), []);
  const pick = useCallback((id: string, via?: 'pointer') => {
    const changed = selectedRef.current !== id;
    select(id);
    if (!overlay || via !== 'pointer') return;
    if (changed) focusBack.current = true;   // the button mounts with the overlay: focus it after the commit
    else backRef.current?.focus({ preventScroll: true });
    setArming(true);
    window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArming(false), DOUBLE_CLICK_MS);
  }, [overlay, select]);
  useEffect(() => {
    if (!focusBack.current) return;
    focusBack.current = false;
    if (overlay && selectedRun) backRef.current?.focus({ preventScroll: true });
  }, [overlay, selectedRun]);
  useEffect(() => {
    if (!overlay || !selectedRun) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      select(null);
      listRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, selectedRun, select]);

  const filterProps = { filter, onFilter: setFilter, counts, showLegacy, onLegacy: setShowLegacy, legacyCount: stats?.legacy ?? 0, sort, onSort: setSort };
  return <div className="history-page" data-entering={entering ? '' : undefined} data-overlay={overlay && selectedRun ? '' : undefined}>
    <TopBarTitle><Crumb current="任务历史"><span className="crumb-note">· 评审运行队列</span></Crumb></TopBarTitle>
    <TopBarActions>
      <button type="button" className="btn ghost" onClick={load} disabled={loading}><Icon name="refresh" size={15} />{loading ? '正在刷新…' : '刷新'}</button>
      <a className="btn primary" href="#/new"><Icon name="plus" size={15} />新建评审</a>
    </TopBarActions>
    <StatusCells>
      <StatusCell>运行 {stats ? pad2(stats.total) : '—'}</StatusCell>
      <StatusCell tone={stats?.waiting ? 'gate' : undefined}>等你 {stats ? pad2(stats.waiting) : '—'}</StatusCell>
      <StatusCell>进行中 {stats ? pad2(stats.active) : '—'}</StatusCell>
      <StatusCell>已结束 {stats ? pad2(stats.ended) : '—'}</StatusCell>
    </StatusCells>

    <header className="hist-head">
      <div className="hist-title"><h1>任务历史</h1><p>评审运行队列</p></div>
      <section className="kpis" aria-label="运行概况">
        <Kpi index={0} value={stats?.total ?? null} word="全部运行" caption="真实运行，不含早期模拟记录" />
        <Kpi index={1} value={stats?.waiting ?? null} word="等你决定" kind="you" tone={stats?.waiting ? 'you' : undefined} caption="停在关卡，需要你确认" />
        <Kpi index={2} value={stats?.active ?? null} word="进行中" kind="run" caption={stats?.blocked ? `其中 ${stats.blocked} 个已阻塞` : '模型正在工作或排队'} />
        <Kpi index={3} value={stats?.ended ?? null} word="已结束" kind="ok" caption="已接受、已停止或已取消" />
      </section>
    </header>

    <div className="hist-grid">
      {compact ? null : <HistoryFilters {...filterProps} style={rise(4) as CSSProperties} />}
      <HistoryQueue {...filterProps} rows={rows} total={(stats?.total ?? 0) + (showLegacy ? stats?.legacy ?? 0 : 0)} hasRealRuns={Boolean(stats?.total)}
        loading={loading} loaded={loaded} error={error} onRetry={load} query={query} onQuery={setQuery}
        selected={selected} onSelect={pick} onOpen={open} compact={compact} listRef={listRef} />
      <HistoryInspector run={selectedRun} config={config} configError={configError} onRetryConfig={loadConfig} animate={userSelected}
        onBack={overlay ? () => { select(null); listRef.current?.focus({ preventScroll: true }); } : undefined} backRef={backRef} arming={overlay && arming} />
    </div>
  </div>;
}
