// 协作详情 (BUILD-SPEC-B §4.9). Docks under the map stage (`placement="dock"`) or takes a right grid column that
// pushes the content (`placement="column"`); WP1 decides which. It is unmounted while closed. The tab lives in
// ChatPage, so a dock↔column remount keeps it; if focus was inside, the selected tab is refocused after the remount.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, Status, Tag, type StatusKind } from '../../components/ui';
import Splitter, { clampSplit, readSplit, writeSplit } from '../../components/Splitter';
import { useSeatFocus } from '../../components/seatFocus';
import type { AgentTask, ChatRecord, ChatStream } from '../../lib/chat-api';
import { ArtifactList, AttachmentList, ContextList, StreamList, TaskTree, TodoList, ToolEvidenceList } from './ChatPanels';
import { EventList } from './ObservatoryPanels';
import type { Observatory } from './observatoryModel';
import { SeatPanel } from './ObservatorySeatPanel';
import { PipelineStatus, type RotationNotice } from './PipelineStatus';
import SettingsSummary from './SettingsSummary';
import type { ToolEvidence } from './chatModel';
import type { ChatInspectorProps, InspectorTab } from './workspaceContracts';
import './inspector.css';

export const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTab; label: string; note: string }> = [
  { id: 'seat', label: '席位', note: '焦点与上下游' },
  { id: 'tasks', label: '任务', note: '分工与证据' },
  { id: 'files', label: '文件', note: '实际交付物' },
  { id: 'context', label: '上下文', note: '调用占用' },
  { id: 'settings', label: '设置', note: '扩展能力' },
];

// ---------- footer tally: every segment and word comes from a real task count ----------
const TALLY: ReadonlyArray<{ kind: StatusKind; statuses: AgentTask['status'][]; word: string }> = [
  { kind: 'ok', statuses: ['completed'], word: '已完成' },
  { kind: 'run', statuses: ['running'], word: '进行中' },
  { kind: 'you', statuses: ['waiting_user'], word: '等你回答' },
  { kind: 'child', statuses: ['waiting_children'], word: '等待子任务' },
  { kind: 'err', statuses: ['failed', 'interrupted'], word: '失败或中断' },
  { kind: 'stop', statuses: ['cancelled'], word: '已停止' },
  { kind: 'queue', statuses: ['queued'], word: '未开始' },
];
export function taskTally(tasks: AgentTask[]) {
  return TALLY.map(item => ({ ...item, count: tasks.filter(task => item.statuses.includes(task.status)).length })).filter(item => item.count > 0);
}
const pad = (value: number) => String(value).padStart(2, '0');

function InspectorFooter({ tasks }: { tasks: AgentTask[] }) {
  const tally = taskTally(tasks);
  const done = tasks.filter(task => task.status === 'completed').length;
  return <footer className="insp-foot">
    {tasks.length ? <>
      <div className="insp-foot-count"><span>全部任务（含主任务）</span><b className="numeral">{pad(done)}<small> / {pad(tasks.length)}</small></b></div>
      <div className="insp-bar" aria-hidden="true">{tally.map(item => <i key={item.kind} data-kind={item.kind} style={{ flexGrow: item.count }} />)}</div>
      <ul className="insp-tally" aria-label="任务状态">{tally.map(item => <li key={item.kind}><Status kind={item.kind}>{`${item.word} ${item.count}`}</Status></li>)}</ul>
    </> : <p className="muted">尚未创建任务</p>}
  </footer>;
}

// ---------- tab panels ----------
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section className="insp-sec"><div className="insp-sec-title"><h3>{title}</h3>{note ? <small>{note}</small> : null}</div>{children}</section>;
}

function SeatTab({ model }: { model: Observatory }) {
  const { useSeat } = useSeatFocus();
  const focus = useSeat();
  const seat = focus.seat ?? model.rootRole;
  return <>
    <div className="insp-seat-focus">{focus.pinned && focus.seat ? <Tag>已固定 · Esc 取消</Tag> : <small>{focus.seat ? '正在查看悬停的席位' : '默认显示主控；点击地图上的席位卡片可固定'}</small>}</div>
    <SeatPanel model={model} seat={seat} />
    <Section title="最近协作动态" note="本轮最近 5 条"><EventList model={model} /></Section>
  </>;
}

function TasksTab({ chat, streams, tools }: { chat: ChatRecord; streams: ChatStream[]; tools: ToolEvidence[] }) {
  const done = chat.tasks.filter(task => task.status === 'completed').length;
  const childIds = new Set(chat.tasks.filter(task => !!task.parentTaskId).map(task => task.id));
  const childStreams = streams.filter(stream => childIds.has(stream.taskId));
  return <>
    <Section title="任务分工" note={chat.tasks.length ? `${done} / ${chat.tasks.length} 项已完成 · 全部轮次` : undefined}>
      <TaskTree tasks={chat.tasks} invocations={chat.invocations} fanoutGroups={chat.fanoutGroups ?? []} clampGoals />
      {childStreams.length ? <details className="insp-subtask-streams"><summary>子任务输出 · {childStreams.length}</summary><StreamList streams={childStreams} scope="subtask" tasks={chat.tasks} tools={tools} /></details> : null}
    </Section>
    <Section title="工具证据" note={`工具执行与返回结果${tools.length ? ` · ${tools.length}` : ''}`}><ToolEvidenceList tools={tools} /></Section>
    <Section title="执行计划" note="仅显示程序保存的 Todo 状态"><TodoList todos={chat.todos ?? []} /></Section>
  </>;
}

function FilesTab({ chat }: { chat: ChatRecord }) {
  const count = chat.artifacts.length;
  return <>
    <Section title="产物文件" note={count ? `共 ${count} 项实际产物` : undefined}>
      {count ? <ArtifactList chatId={chat.id} artifacts={chat.artifacts} tasks={chat.tasks} /> : <p className="muted">当前会话尚无产物</p>}
    </Section>
    <Section title="附件" note="上传与 Agent 生成文件"><AttachmentList chatId={chat.id} attachments={chat.attachments ?? []} tasks={chat.tasks} /></Section>
  </>;
}

const ROTATION_REASONS: Record<string, string> = {
  soft: '接近上下文软限制', hard: '达到上下文硬限制', yield: 'Agent 主动交接', wait: '等待外部结果',
  time: '达到单窗口时限', actions: '达到工具动作上限', crash: '服务恢复交接',
};

function ContextTab({ chat, rotations }: { chat: ChatRecord; rotations: RotationNotice[] }) {
  const calls = chat.invocations.length;
  return <>
    {chat.pipeline ? <div className="insp-pipeline"><PipelineStatus chat={chat} rotations={rotations} /></div> : null}
    <Section title="调用上下文" note={calls ? `${calls} 次模型调用 · 全部轮次` : undefined}><ContextList chat={chat} /></Section>
    {!chat.pipeline && rotations.length ? <Section title={`窗口交接 · ${rotations.length}`} note="最近 5 次">
      <ol className="insp-rotations">{rotations.slice(-5).reverse().map(item => <li key={item.id}><b>{ROTATION_REASONS[item.reason] ?? item.reason}</b><span>{item.nextSegment ? `进入第 ${item.nextSegment} 段` : '已建立新窗口'}</span></li>)}</ol>
    </Section> : null}
  </>;
}

// ---------- dock height (§4.9): clamp(150, deckH − 40 − railH − 330, 320); mirrors tokens --top-h --status-h --deck-head-h --rail-h --stage-min ----------
const DOCK_KEY = 'dmw:deck:dock-h:v1';
const DOCK_MIN = 150;
function dockLimits(rail: boolean) {
  const viewport = typeof window === 'undefined' ? 900 : Math.max(600, window.innerHeight);
  const avail = viewport - 44 - 28 - 40 - (rail ? 68 : 0) - 330;
  return { max: Math.max(DOCK_MIN, avail), fallback: Math.max(DOCK_MIN, Math.min(320, avail)) };
}
function storedDock(): number | null {
  const value = readSplit(DOCK_KEY, Number.NaN);
  return Number.isFinite(value) ? value : null;
}

// Set while the inspector unmounts with focus inside (a dock↔column remount); the next mount refocuses its tab.
let refocusAfterRemount = 0;

export default function ChatInspector({ chat, streams, tools, rotations, capabilities, globalCapabilities, model, fixedDemo, tab, onTab, placement, collapsed, onCollapse, onClose }: ChatInspectorProps) {
  const base = useId().replace(/:/g, '');
  const aside = useRef<HTMLElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [ownCollapsed, setOwnCollapsed] = useState(false);
  const [dockH, setDockH] = useState<number | null>(storedDock);
  const isDock = placement === 'dock';
  const isCollapsed = isDock && (collapsed ?? ownCollapsed);
  const active = INSPECTOR_TABS.some(item => item.id === tab) ? tab : 'tasks';
  const latest = useRef({ onTab, onClose });
  latest.current = { onTab, onClose };

  const setCollapsedState = (next: boolean) => { setOwnCollapsed(next); onCollapse?.(next); };
  const select = (next: InspectorTab) => { onTab(next); if (isCollapsed) setCollapsedState(false); };
  const close = () => {
    const opener = Array.from(document.querySelectorAll<HTMLElement>('[aria-controls="chat-inspector"]')).find(element => !aside.current?.contains(element));
    opener?.focus({ preventScroll: true });
    latest.current.onClose();
  };

  useLayoutEffect(() => {
    if (refocusAfterRemount && Date.now() - refocusAfterRemount < 1000) tabRefs.current[INSPECTOR_TABS.findIndex(item => item.id === active)]?.focus({ preventScroll: true });
    refocusAfterRemount = 0;
    const element = aside.current;
    return () => { refocusAfterRemount = element?.contains(document.activeElement) ? Date.now() : 0; };
  }, []);

  // A seat card or chip click that pins a seat switches to 席位 (never opens the inspector). Read from the
  // `.chat-work` attributes the seat-focus store writes, so hovering never re-renders this component.
  useEffect(() => {
    let before = '';
    const state = (target: EventTarget | null) => {
      const work = ((target as Element | null)?.closest?.('.chat-work') ?? document.querySelector('.chat-work')) as HTMLElement | null;
      return work?.dataset.pinned === 'true' ? work.dataset.focusSeat ?? '' : '';
    };
    const capture = (event: MouseEvent) => { before = state(event.target); };
    const bubble = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('[data-seat]') || aside.current?.contains(target)) return;
      const after = state(target);
      if (after && after !== before) latest.current.onTab('seat');
    };
    document.addEventListener('click', capture, true);
    document.addEventListener('click', bubble);
    return () => { document.removeEventListener('click', capture, true); document.removeEventListener('click', bubble); };
  }, []);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = INSPECTOR_TABS.length - 1;
    const next = event.key === 'ArrowRight' ? (index + 1) % INSPECTOR_TABS.length : event.key === 'ArrowLeft' ? (index + last) % INSPECTOR_TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    select(INSPECTOR_TABS[next].id);
    tabRefs.current[next]?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if ((event.target as Element).closest('dialog')) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  const rail = !!chat.pipeline;
  const limits = dockLimits(rail);
  const dockValue = Math.round(clampSplit(dockH ?? limits.fallback, DOCK_MIN, limits.max));
  const changeDock = (next: number) => setDockH(clampSplit(next, DOCK_MIN, limits.max));
  // ↑ grows the dock (moves the separator up), matching the pointer direction.
  const onSplitKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    const next = clampSplit(dockValue + (event.key === 'ArrowUp' ? 1 : -1) * 24 * (event.shiftKey ? 4 : 1), DOCK_MIN, limits.max);
    setDockH(next);
    writeSplit(DOCK_KEY, next);
  };
  const resetDock = () => { setDockH(null); try { localStorage.removeItem(DOCK_KEY); } catch { /* storage unavailable */ } };
  const labels = Object.fromEntries(model.roles.map(role => [role.id, role.label]));
  const tabCount: Partial<Record<InspectorTab, number>> = { tasks: chat.tasks.length, files: chat.artifacts.length };
  const style = isDock && dockH !== null ? { '--dock-h': `${dockValue}px` } as CSSProperties : undefined;

  return <aside ref={aside} id="chat-inspector" className="chat-inspector" aria-label="协作详情" data-placement={placement}
    data-collapsed={isCollapsed || undefined} data-rail={rail || undefined} style={style} onKeyDown={onKeyDown}>
    {isDock && !isCollapsed ? <div className="insp-dock-split" onKeyDownCapture={onSplitKeys}>
      <Splitter orientation="horizontal" invert value={dockValue} min={DOCK_MIN} max={limits.max} step={24} storageKey={DOCK_KEY}
        label="调整协作详情高度" valueText={`协作详情高度 ${dockValue} 像素`} controls="chat-inspector" onChange={changeDock} onReset={resetDock} />
    </div> : null}
    <div className="insp-frame">
      <div className="insp-title"><b>{chat.title}</b>{fixedDemo ? <Tag tone="mock">▷ 预设演示</Tag> : null}</div>
      <div className="insp-head">
        <div className="insp-tabs" role="tablist" aria-label="协作详情内容">
          {INSPECTOR_TABS.map((item, index) => {
            const selected = item.id === active;
            const count = tabCount[item.id];
            return <button key={item.id} ref={element => { tabRefs.current[index] = element; }} type="button" role="tab" className="btn-reset insp-tab"
              id={`${base}-${item.id}-tab`} aria-controls={`${base}-${item.id}-panel`} aria-selected={selected} tabIndex={selected ? 0 : -1}
              aria-label={`${item.label}：${item.note}`} onClick={() => select(item.id)} onKeyDown={event => onTabKey(event, index)}>
              <span>{item.label}</span>{count ? <span className="insp-tab-count">{count}</span> : null}<small>{item.note}</small>
            </button>;
          })}
        </div>
        {isDock ? <button type="button" className="icon-btn insp-collapse" aria-label={isCollapsed ? '展开协作详情面板' : '收起协作详情面板'}
          aria-expanded={!isCollapsed} aria-controls={`${base}-body`} onClick={() => setCollapsedState(!isCollapsed)}><Icon name="chevron-down" size={16} /></button> : null}
        <button type="button" className="icon-btn" aria-label="关闭协作详情" onClick={close}><Icon name="x" size={16} /></button>
      </div>
      <div className="insp-body" id={`${base}-body`}>
        {INSPECTOR_TABS.map(item => <section key={item.id} className={`inspector-page inspector-page-${item.id}`} id={`${base}-${item.id}-panel`} role="tabpanel"
          aria-labelledby={`${base}-${item.id}-tab`} tabIndex={0} hidden={item.id !== active} data-active={item.id === active ? 'true' : undefined}>
          {item.id !== active ? null
            : item.id === 'seat' ? <SeatTab model={model} />
            : item.id === 'tasks' ? <TasksTab chat={chat} streams={streams} tools={tools} />
            : item.id === 'files' ? <FilesTab chat={chat} />
            : item.id === 'context' ? <ContextTab chat={chat} rotations={rotations} />
            : <SettingsSummary capabilities={capabilities} globalCapabilities={globalCapabilities} fixedDemo={fixedDemo} labels={labels} />}
        </section>)}
      </div>
      <InspectorFooter tasks={chat.tasks} />
    </div>
  </aside>;
}
