// DEV-only route #/dev/thread?state=… (BUILD-SPEC-B §3.5, §9 WP1): the real workspace, thread, composer, map and inspector
// rendered from fixtures. No network writes: every action is a no-op or local. Not part of a production build.
import { useMemo, useState } from 'react';
import { TopBarTitle } from '../../components/shell/ShellSlots';
import { ConnChip, Crumb } from '../../components/shell/TopBar';
import ChatInspector from '../../pages/chat/ChatInspector';
import ChatMap from '../../pages/chat/ChatMap';
import { ChatStatusSlots, IdChip } from '../../pages/chat/ChatStatusSlots';
import ChatWorkspace from '../../pages/chat/ChatWorkspace';
import { activeTask, isLiveOrigin, pendingUserTicket } from '../../pages/chat/chatModel';
import { CollabPopover } from '../../pages/chat/composer/CollabPopover';
import { Composer } from '../../pages/chat/composer/Composer';
import { ProjectControl } from '../../pages/chat/composer/ProjectControl';
import { buildObservatory } from '../../pages/chat/observatoryModel';
import { GateCard, PipelineComposerControls, PipelineRail } from '../../pages/chat/PipelineStatus';
import { FixedDemoBar } from '../../pages/chat/thread/FixedDemoBar';
import { seatColor } from '../../pages/chat/thread/seats';
import { Thread, threadItemCount } from '../../pages/chat/thread/Thread';
import Welcome from '../../pages/chat/Welcome';
import { DEFAULT_INSPECTOR_TAB, type InspectorTab } from '../../pages/chat/workspaceContracts';
import '../../pages/chat/thread.css';
import '../../pages/chat/composer.css';
import '../../pages/chat/fixed-demo.css';
import { THREAD_STATES, threadFixture, type ThreadState } from './fixtures';

const noop = () => undefined;

export default function ThreadPreview() {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const requested = query.get('state') as ThreadState | null;
  const name: ThreadState = requested && (THREAD_STATES as readonly string[]).includes(requested) ? requested : 'welcome';
  return <PreviewSession key={name} name={name} />;
}

function PreviewSession({ name }: { name: ThreadState }) {
  const fixture = useMemo(() => threadFixture(name), [name]);
  const { state, chat } = fixture;
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'normal' | 'pipeline'>('normal');
  const [costConfirmed, setCostConfirmed] = useState(name !== 'welcome');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>(DEFAULT_INSPECTOR_TAB);
  const [answer, setAnswer] = useState('');
  const capabilities = chat ? state.capabilities : fixture.capabilities;
  const model = useMemo(() => buildObservatory(chat, capabilities, state.activityTools, state.rotations, fixture.demo), [chat, capabilities, state, fixture.demo]);
  const ticket = pendingUserTicket(chat);
  const canStop = chat?.tasks.some(activeTask) ?? false;
  const active = model.tasks.some(task => task.status === 'queued' || task.status === 'running' || task.status === 'waiting_children');
  const welcome = !fixture.loading && !state.messages.length;
  const pendingGate = chat?.pipeline?.stage === 'gate-a' ? 'A' : chat?.pipeline?.stage === 'gate-b' ? 'B' : null;
  const runningSeat = model.tasks.find(task => task.status === 'running')?.role;
  const rail = chat?.pipeline ? <PipelineRail model={model} chat={chat} />
    : welcome && mode === 'pipeline' ? <PipelineRail model={model} chat={null} preview presetName="flagship" /> : undefined;
  const title = fixture.loading ? '正在恢复聊天…' : chat ? chat.title : '新聊天';
  const playback = { elapsedMs: 95_000, paused: false, completed: false, cancelled: false, productReady: false };

  return <>
    <TopBarTitle><Crumb trail={[{ label: '聊天', href: '#/' }]} current={title} heading>{chat ? <IdChip id={chat.id} /> : null}</Crumb></TopBarTitle>
    <ChatStatusSlots chat={chat} model={model} fresh={!chat} fixedDemo={fixture.demo} connection={chat ? (fixture.demo ? 'demo' : state.connection) : null} active={active} />
    <ChatWorkspace
      chatKey={`dev-${name}`}
      flags={{ welcome, sending: false, working: canStop, active }}
      speak={seatColor(runningSeat)}
      connection={chat ? <ConnChip state={fixture.demo ? 'demo' : state.connection} active={active} /> : <span className="conn-chip is-local"><i aria-hidden="true">●</i>此计算机</span>}
      hasChat={Boolean(chat)}
      hasPipeline={Boolean(rail)}
      skeleton={fixture.loading}
      inspectorOpen={inspectorOpen && Boolean(chat)}
      onInspector={setInspectorOpen}
      pendingGate={pendingGate}
      pendingQuestion={Boolean(ticket)}
      itemCount={threadItemCount(chat, state)}
      thread={context => <Thread state={state} chat={chat} model={model} demo={fixture.demo} loading={fixture.loading} loadError="" onRetryLoad={noop}
        notice={fixture.notice} backfill={false} mapCollapsed={context.mapCollapsed} onExpandMap={context.expandMap}
        band={fixture.demo ? <FixedDemoBar playback={playback} sending={false} onPause={noop} onRestart={noop} onProduct={noop} />
          : context.mapCollapsed && chat?.pipeline ? <PipelineRail model={model} chat={chat} compact onGateNode={context.focusGate} /> : null}
        welcome={welcome ? <Welcome leaving={false} onStart={setInput} onDemo={noop} /> : null}
        question={ticket ? { ticket, busy: false, value: answer, error: '', onChange: setAnswer, onAnswer: noop } : null}
        gateCard={chat && pendingGate ? <GateCard chat={chat} model={model} state={fixture.gate} onDecide={noop} onRetry={noop} /> : null}
        gate={pendingGate} onGate={context.focusGate} onOpenInspector={next => { setTab(next); setInspectorOpen(true); }}
        older={{ available: false, loading: false, error: '', onLoad: noop }}
        composer={<Composer inputRef={{ current: null }} input={input} onInput={setInput} onSubmit={noop} fresh={!chat} fixedDemo={fixture.demo} demoInput={false}
          unavailable={fixture.loading ? 'loading' : false} sending={false} workspaceBusy={false} canStop={canStop} stopping={false} onStop={noop}
          pending={[]} maxFiles={10} onFiles={noop} onRetryUpload={noop} onRemoveUpload={noop} error="" costConfirmed={costConfirmed}
          onCostConfirm={setCostConfirmed} onCostRevoke={() => setCostConfirmed(false)} steeringAck={false}
          pipeline={{ mode, workspace: false, preset: true }}
          runMode={!chat && !fixture.loading ? <PipelineComposerControls mode={mode} preset="flagship" auto={false} disabled={false} workspaceGranted={false} onMode={setMode} onPreset={noop} onAuto={noop}
            configuration={{ mode: 'api', keyReadiness: [], modelChecks: [], presets: [{ id: 'flagship', rootSeat: 'claude', seats: [], available: true }] }} /> : null}
          project={<ProjectControl chat={chat} workspaces={[]} selected="" busy={false} sending={false} onSelect={noop} onChoose={noop} onRevoke={noop} />}
          collab={<CollabPopover capabilities={capabilities} model={model} demo={fixture.demo} />} />} />}
      map={context => <ChatMap model={model} chat={chat} variant={context.variant} demo={fixture.demo} animateChanges={isLiveOrigin(state.origin)} canFlow={state.connection === 'live'}
        welcome={welcome && !chat ? { ready: capabilities.filter(item => item.available).length, unavailable: [], previewPipeline: mode === 'pipeline' } : undefined}
        rail={rail} dock={context.dock} dockOpen={context.dockOpen} onDockFit={context.onDockFit} onToggleMax={context.onToggleMax} onCollapse={context.onCollapse} onGateNode={context.onGateNode} />}
      inspector={context => chat ? <ChatInspector chat={chat} streams={[]} tools={state.tools} rotations={state.rotations} capabilities={state.capabilities} globalCapabilities={null}
        model={model} fixedDemo={fixture.demo} tab={tab} onTab={setTab} placement={context.placement} collapsed={context.collapsed} onCollapse={context.onCollapse} onClose={() => setInspectorOpen(false)} /> : null}
    />
  </>;
}
