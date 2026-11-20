import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EmptyState, Icon } from '../../components/ui';
import { StatusConnection, TopBarActions, TopBarTitle } from '../../components/shell/ShellSlots';
import { useRun } from '../../lib/useRun';
import RunHeader from './header/RunHeader';
import RunRail from './rail/RunRail';
import { FOCUS_QUESTION_EVENT, gateTab, revealScroll, runTabs, tabForPhase, type RunTab } from './tabs';
import './run-layout.css';

const LivePanel = lazy(() => import('./live/LivePanel'));
const WorkspacePanel = lazy(() => import('./workspace/WorkspacePanel'));
const QuestionsPanel = lazy(() => import('./questions/QuestionsPanel'));
const CandidatesPanel = lazy(() => import('./candidates/CandidatesPanel'));
const DecisionPanel = lazy(() => import('./decision/DecisionPanel'));
const DocumentsPanel = lazy(() => import('./docs/DocumentsPanel'));
const ValidationPanel = lazy(() => import('./validation/ValidationPanel'));
const DeliveryPanel = lazy(() => import('./deliverables/DeliveryPanel'));
const RecordsPanel = lazy(() => import('./validation/RecordsPanel'));
const contextPreference = 'workbench:context';
/** Hairline group separators sit before these tabs (CSS only, `data-group-start`). */
const groupStarts = new Set<RunTab>(['proposals', 'documents', 'records']);

/** Connection words come from lib/events.ts; glyph + word, never colour alone. */
function connectionLook(connection: string): { glyph: string; tone: 'on' | 'wait' | 'warn' } {
  if (connection === '实时同步') return { glyph: '●', tone: 'on' };
  if (connection === '正在连接') return { glyph: '◌', tone: 'wait' };
  if (connection.includes('异常')) return { glyph: '!', tone: 'warn' };
  return { glyph: '↻', tone: 'warn' };
}

/** `.run-conn` in the top bar (the one live region) and the same words in status-bar cell 1 (not a live region). */
function RunConnection({ connection, active }: { connection: string; active: boolean }) {
  const { glyph, tone } = connectionLook(connection);
  const looping = active && tone === 'on' ? '' : undefined;
  return <>
    <TopBarActions><span className={`run-conn is-${tone}`} role="status" data-active={looping}><i className={tone === 'on' ? 'on' : ''} aria-hidden="true">{glyph}</i>{connection}</span></TopBarActions>
    <StatusConnection><span className={`sb-reach run-sb is-${tone}`}><i aria-hidden="true">{glyph}</i>{connection}</span></StatusConnection>
  </>;
}

export default function RunPage({ id }: { id: string }) {
  const state = useRun(id);
  const { run, error, connection } = state;
  const [tab, setTab] = useState<RunTab>('workspace');
  const currentTab = useRef<RunTab>('workspace');
  const [visited, setVisited] = useState<RunTab[]>(['workspace']);
  const [focusQuestionId, setFocusQuestionId] = useState<string | null>(null);
  const [gateRequest, setGateRequest] = useState<RunTab | null>(null);
  // The rail defaults to expanded; only an explicit 'collapsed' preference hides it.
  const [contextCollapsed, setContextCollapsed] = useState(() => {
    try { return localStorage.getItem(contextPreference) === 'collapsed'; }
    catch { return false; }
  });
  const lastState = useRef('');
  const pane = useRef<HTMLDivElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const select = useCallback((next: RunTab) => {
    setGateRequest(null);
    currentTab.current = next;
    setTab(next);
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
  }, []);

  useEffect(() => {
    if (!run) return;
    const key = `${run.phase}|${run.phaseStatus}|${run.terminal ?? ''}`;
    if (lastState.current === key) return;
    lastState.current = key;
    // Kept as-is (BUILD-SPEC-B §1.10, decided by the user): never auto-switches away from the overview.
    if (currentTab.current !== 'workspace') select(tabForPhase(run));
  }, [run, select]);
  useEffect(() => { pane.current?.scrollTo?.({ top: 0 }); }, [tab]);
  // A narrow strip scrolls sideways: keep the selected tab (auto switch, gate jump, rail links) in view. Strip only, never the page.
  const loaded = Boolean(run);
  useEffect(() => {
    const strip = tabStrip.current;
    const button = strip?.querySelector<HTMLElement>(`#tab-${tab}`);
    const left = strip && button ? revealScroll(strip, button) : null;
    if (strip && left !== null) strip.scrollLeft = left;
  }, [tab, loaded]);
  useEffect(() => {
    if (!gateRequest || gateRequest !== tab || !pane.current) return;
    const locate = () => {
      const panel = pane.current?.querySelector(`#run-panel-${gateRequest}`);
      const target = panel?.querySelector<HTMLElement>('.gate-section, .g1-submit');
      if (!target) return false;
      target.tabIndex = -1;
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
      setGateRequest(null);
      return true;
    };
    if (locate()) return;
    // 文档和延迟加载的面板可能尚未就绪，确认区出现后再定位。
    const observer = new MutationObserver(() => { if (locate()) observer.disconnect(); });
    observer.observe(pane.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [gateRequest, tab]);
  useEffect(() => {
    const focus = (event: Event) => {
      select('questions');
      setFocusQuestionId((event as CustomEvent<string>).detail);
    };
    window.addEventListener(FOCUS_QUESTION_EVENT, focus);
    return () => window.removeEventListener(FOCUS_QUESTION_EVENT, focus);
  }, [select]);

  const active = Boolean(run?.tasks.some(task => task.status === 'running' || task.status === 'queued'));
  const chrome = <>
    {/* The run page owns aria-current=page (the 任务历史 nav row carries aria-current=true); the page head owns the h1. */}
    <TopBarTitle><div className="crumb"><a href="#/history">任务历史</a><span className="crumb-sep" aria-hidden="true">/</span><span className="crumb-current" aria-current="page" title={run?.title}>{run?.title ?? '任务详情'}</span></div></TopBarTitle>
    <RunConnection connection={connection} active={active} />
  </>;

  if (!run) return <div className="page run-loading">{chrome}{error
    ? <div className="alert bad" role="alert">{error}<div className="btnbar"><button type="button" onClick={() => void state.refresh()}>重新加载</button><a className="button" href="#/history">返回运行列表</a></div></div>
    : <EmptyState title="正在读取运行" icon="activity"><p>正在恢复运行、任务与问题记录…</p></EmptyState>}</div>;

  const props = { run, busy: state.busy, progress: state.progress, act: state.act, refresh: state.refresh, error };
  const gate = gateTab(run);
  const gateLabel = gate === 'questions' ? '前往 G1 提交'
    : gate === 'decision' ? '前往 G2 确认'
      : gate === 'validation' ? '前往 G4 验收'
        : run.phase === 'prd_gate' ? '前往 G5 确认' : '前往 G3 确认';
  const openGate = (next: RunTab) => { select(next); setGateRequest(next); };
  const toggleContext = () => {
    setContextCollapsed(!contextCollapsed);
    try { localStorage.setItem(contextPreference, contextCollapsed ? 'expanded' : 'collapsed'); }
    catch { /* 无法保存偏好时，本次展开/收起仍可使用。 */ }
  };
  const overview = tab === 'workspace';
  // The overview keeps its own execution sidebar: the context rail and its toggle never show there.
  const railHidden = contextCollapsed || overview;
  const openQuestions = run.questions.filter(question => question.status === 'open').length;
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = runTabs.map(item => item.key);
    const index = keys.indexOf(tab);
    const next = event.key === 'ArrowRight' ? keys[(index + 1) % keys.length] : event.key === 'ArrowLeft' ? keys[(index + keys.length - 1) % keys.length] : event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[keys.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    select(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  const panel = (key: RunTab) => {
    switch (key) {
      case 'workspace': return <WorkspacePanel {...props} onNavigate={select} onOpenGate={openGate} />;
      case 'live': return <LivePanel {...props} />;
      case 'questions': return <QuestionsPanel {...props} focusQuestionId={focusQuestionId} onFocusHandled={() => setFocusQuestionId(null)} />;
      case 'proposals': return <CandidatesPanel {...props} view="proposals" />;
      case 'compare': return <CandidatesPanel {...props} view="compare" />;
      case 'decision': return <DecisionPanel {...props} />;
      case 'documents': return <DocumentsPanel {...props} />;
      case 'validation': return <ValidationPanel {...props} />;
      case 'deliverables': return <DeliveryPanel {...props} onOpenRecords={() => select('records')} />;
      case 'records': return <RecordsPanel {...props} />;
    }
  };

  return <div className={`run-page${railHidden ? ' context-collapsed' : ''}${overview ? ' overview-active' : ''}`}>
    {chrome}
    <RunHeader {...props} onOpenLive={() => select('live')} onOpenDeliverables={() => select('deliverables')} />
    {error ? <div className="run-error" role="alert"><Icon name="alert" /><span>{error}</span><button type="button" className="compact" onClick={() => void state.refresh()}>刷新状态</button></div> : null}
    <div className="run-toolbar">
      <div className="run-tabs" ref={tabStrip} role="tablist" aria-label="运行详情" onKeyDown={onTabKey}>
        {runTabs.map(item => <button key={item.key} id={`tab-${item.key}`} type="button" role="tab" aria-selected={tab === item.key} aria-controls={`run-panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} data-group-start={groupStarts.has(item.key) ? '' : undefined} onClick={() => select(item.key)}>
          {item.label}
          {item.key === 'live' && active ? <span className="tab-live" role="img" aria-label="有任务在运行" /> : null}
          {item.key === 'questions' && openQuestions ? <span className="tab-count" aria-label={`${openQuestions} 题未回答`}>{openQuestions}</span> : null}
          {gate === item.key ? <span className="tab-dot" role="img" aria-label="等你决定" /> : null}
        </button>)}
      </div>
      <div className="run-tools">
        {gate ? <button type="button" className="gate outline compact" onClick={() => openGate(gate)}><span aria-hidden="true">◆</span>{gateLabel}</button> : null}
        {overview ? null : <button type="button" className="ghost compact" aria-expanded={!contextCollapsed} aria-controls="run-context" onClick={toggleContext}><Icon name="panel-right" size={14} />{contextCollapsed ? '展开上下文' : '收起上下文'}</button>}
      </div>
    </div>
    <div className="run-body">
      <div className="run-main">
        <div className="run-pane" ref={pane}>
          <Suspense fallback={<p className="loading" role="status">正在载入…</p>}>
            {visited.map(key => <div key={key} id={`run-panel-${key}`} role="tabpanel" aria-labelledby={`tab-${key}`} hidden={key !== tab} className={key === 'live' || key === 'workspace' ? 'fill' : undefined}>{panel(key)}</div>)}
          </Suspense>
        </div>
      </div>
      <RunRail run={run} collapsed={railHidden} onNavigate={select} onOpenGate={openGate} />
    </div>
  </div>;
}
