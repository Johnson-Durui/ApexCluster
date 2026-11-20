// Dev-only route (#/dev/observatory): the map pane (ChatMap) on the frozen nine-seat sample, no server, no model calls.
// Query: variant=docked|full · view=topology|pipeline|context · stage=<pipeline stage> · demo=1 · seats=12 · empty=1 ·
// welcome=1 · question=1 · offline=1 · dock=1 · dispatch=1 (1.5 s after load one task flips queued → running, live).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SeatFocusProvider } from '../../components/seatFocus';
import { TopBarActions, TopBarTitle } from '../../components/shell/ShellSlots';
import type { ChatPipelineStage } from '../../lib/chat-api';
import ChatMap from '../../pages/chat/ChatMap';
import type { MapView } from '../../pages/chat/MapStage';
import { buildObservatory } from '../../pages/chat/observatoryModel';
import { PipelineRail } from '../../pages/chat/PipelineStatus';
import type { MapVariant } from '../../pages/chat/workspaceContracts';
import { previewCapabilities, previewChat } from './previewState';

const STAGES: ChatPipelineStage[] = ['architecture', 'gate-a', 'implementation', 'acceptance', 'gate-b', 'completed', 'cancelled'];
const dock = <aside style={{ height: 260, borderTop: '1px solid var(--line-2)', background: 'var(--surface)', padding: '12px 16px', color: 'var(--muted)', fontSize: 13 }}>
  协作详情（开发占位：检查停靠行与舞台最小高度）</aside>;

export default function ObservatoryPreview() {
  const query = useMemo(() => new URLSearchParams(window.location.hash.split('?')[1] ?? ''), []);
  const flag = (name: string) => query.get(name) === '1';
  const [stage, setStage] = useState<ChatPipelineStage>(STAGES.find(item => item === query.get('stage')) ?? 'implementation');
  const [variant, setVariant] = useState<MapVariant>(query.get('variant') === 'full' ? 'full' : 'docked');
  const view = (['topology', 'pipeline', 'context'] as const).find(item => item === query.get('view')) ?? 'topology' as MapView;
  const empty = flag('empty');
  const welcome = empty || flag('welcome');
  const dispatchMode = flag('dispatch');
  const [dispatched, setDispatched] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [fit, setFit] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const workRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!dispatchMode) return;
    const timer = window.setTimeout(() => {
      (window as unknown as Record<string, number>).__mapDispatchAt = performance.now();
      setAnimate(true);
      setDispatched(true);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [dispatchMode]);

  const sample = useMemo(() => previewChat({ stage, extraSeats: query.get('seats') === '12', question: flag('question'), dispatch: dispatchMode ? (dispatched ? 'after' : 'before') : null }),
    [stage, dispatched]);
  const chat = welcome ? null : sample.chat;
  const capabilities = empty ? [] : welcome ? previewCapabilities(sample.capabilities) : sample.capabilities;
  const model = useMemo(() => buildObservatory(chat, capabilities, sample.activity, sample.rotations, flag('demo')),
    [sample, welcome, empty]);
  const unavailable = capabilities.filter(seat => !seat.available).map(seat => ({ role: seat.role, reason: seat.reason ?? '当前不可用' }));
  const full = variant === 'full';
  const grid = { display: 'grid', height: '100%', minHeight: 0, gridTemplateColumns: collapsed ? 'minmax(0,1fr)' : full ? '60px minmax(0,1fr)' : 'clamp(460px,44%,700px) 7px minmax(0,1fr)' } as CSSProperties;

  return <>
    <TopBarTitle><span>开发演示 / 架构视图</span></TopBarTitle>
    <TopBarActions>
      <span className="mono muted" data-dock-fit={fit}>{fit}</span>
      <select aria-label="流水线阶段" value={stage} onChange={event => setStage(event.target.value as ChatPipelineStage)} style={{ width: 'auto', minHeight: 28 }}>
        {STAGES.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </TopBarActions>
    <section ref={workRef} className="chat-work dev-map-work" aria-label="架构视图预览" style={grid}>
      <SeatFocusProvider target={workRef}>
        {collapsed ? null : full
          ? <div style={{ borderRight: '1px solid var(--line-2)', background: 'var(--pane)' }} aria-hidden="true" />
          : <><div style={{ padding: 24, color: 'var(--muted)', fontSize: 13, background: 'var(--pane)' }}>聊天线程（开发占位）</div><div style={{ borderLeft: '1px solid var(--line-2)' }} /></>}
        {collapsed ? <div style={{ padding: 24 }}><button type="button" className="btn" onClick={() => setCollapsed(false)}>展开任务地图</button></div>
          : <ChatMap model={model} chat={chat} variant={variant} demo={flag('demo')} animateChanges={animate} canFlow={!flag('offline')}
            welcome={welcome ? { ready: capabilities.filter(seat => seat.available).length, unavailable, previewPipeline: false } : undefined}
            rail={chat?.pipeline ? <PipelineRail model={model} chat={chat} animate={animate} onGateNode={() => setFit('◆ 前往关卡')} /> : undefined}
            dock={flag('dock') ? dock : undefined} dockOpen={flag('dock')}
            onDockFit={(fits, deckH) => setFit((fits ? '可停靠' : '不可停靠') + ' · ' + deckH)}
            onToggleMax={() => setVariant(full ? 'docked' : 'full')} onCollapse={() => setCollapsed(true)} onGateNode={() => setFit('◆ 前往关卡')}
            initialView={view} />}
      </SeatFocusProvider>
    </section>
  </>;
}
