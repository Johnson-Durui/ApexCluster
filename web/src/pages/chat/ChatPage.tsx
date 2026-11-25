// Chat page container (BUILD-SPEC-B §4): routes the chat id to a session, wires data hooks, the thread, the map pane
// and the inspector into ChatWorkspace, and fills the shell slots. A session is kept across the hand-off from
// `?new=1` to the chat this page just created, so the first send plays without a skeleton.
import { useEffect, useMemo, useRef, useState } from 'react';
import { chatApi } from '../../lib/chat-api';
import { FIXED_DEMO_PROMPT, isFixedDemoId, isFixedDemoPrompt } from '../../lib/fixed-demo';
import { Modal } from '../../components/ui';
import { toast } from '../../components/Toast';
import { animateOnce } from '../../components/motion';
import { TopBarTitle } from '../../components/shell/ShellSlots';
import { ConnChip, Crumb } from '../../components/shell/TopBar';
import ChatInspector from './ChatInspector';
import ChatMap from './ChatMap';
import ChatWorkspace from './ChatWorkspace';
import { activeTask, isLiveOrigin, pendingUserTicket, visibleStreams } from './chatModel';
import { parseChatHash } from './chatNavigation';
import { ChatStatusSlots, IdChip } from './ChatStatusSlots';
import { CollabPopover } from './composer/CollabPopover';
import { Composer } from './composer/Composer';
import { ProjectControl } from './composer/ProjectControl';
import FixedDemoProduct from './FixedDemoProduct';
import { explain, useChatStream } from './hooks/useChatStream';
import { MAX_ATTACHMENT_BATCH, useChatSend } from './hooks/useChatSend';
import { isWorkActive, useFixedDemoPlayback } from './hooks/useFixedDemoPlayback';
import { useGateDecision } from './hooks/useGateDecision';
import { useTicketAnswer } from './hooks/useTicketAnswer';
import { useWorkspaceGrants } from './hooks/useWorkspaceGrants';
import { buildObservatory } from './observatoryModel';
import { GateCard, PipelineComposerControls, PipelineRail } from './PipelineStatus';
import { FixedDemoBar } from './thread/FixedDemoBar';
import { seatColor, seatLabel } from './thread/seats';
import { Thread, threadItemCount } from './thread/Thread';
import Welcome from './Welcome';
import { DEFAULT_INSPECTOR_TAB, type InspectorTab } from './workspaceContracts';
import './thread.css';
import './composer.css';
import './fixed-demo.css';

export { validateAttachmentFiles } from './hooks/useChatSend';

const NO_DRIVERS: never[] = [];
type Route = { chatId: string | null; fresh: boolean; demoParam: boolean };

export default function ChatPage() {
  const parsed = parseChatHash(location.hash);
  const route: Route = { chatId: parsed.chatId, fresh: parsed.newChat || !parsed.chatId, demoParam: new URLSearchParams(location.hash.split('?')[1] ?? '').get('demo') === 'play' };
  const want = route.fresh ? `new${route.demoParam ? ':demo' : ''}` : route.chatId!;
  const handoff = useRef('');
  const session = useRef({ key: 0, want });
  if (session.current.want !== want) {
    if (want !== handoff.current) { session.current.key += 1; handoff.current = ''; }
    session.current.want = want;
  }
  return <ChatSession key={session.current.key} route={route} handoff={handoff} />;
}

function ChatSession({ route, handoff }: { route: Route; handoff: { current: string } }) {
  const stream = useChatStream({ chatId: route.chatId, fresh: route.fresh }, handoff);
  const { state, dispatch, loading, loadError } = stream;
  const errorSink = useRef<(message: string) => void>(() => undefined);
  const grants = useWorkspaceGrants(message => errorSink.current(message));
  const startDemo = useRef<() => Promise<void>>(async () => undefined);
  const fresh = route.fresh;
  const chat = fresh ? null : state.chat?.id === route.chatId ? state.chat : null;
  const defaultPreset = grants.globalCapabilities?.apiConfiguration?.presets.find(item => item.available)?.id
    ?? grants.globalCapabilities?.apiConfiguration?.presets.find(item => item.architectureAvailable)?.id;
  const send = useChatSend({
    chat, messages: state.messages, fresh, ready: !loading && (fresh || Boolean(chat)), dispatch, workspace: grants.selected, setWorkspace: grants.setSelected,
    workspaceBusy: grants.busy, demoParam: route.demoParam, defaultPreset, teamConfiguration: grants.globalCapabilities?.teamConfiguration,
    handoff, startDemo: () => startDemo.current(),
  });
  errorSink.current = send.setError;
  const demo = useFixedDemoPlayback({ chat, fresh, dispatch, handoff, onError: send.setError, setSending: send.setSending, sending: send.sending, onStarted: send.resetDraft });
  startDemo.current = demo.start;
  const gate = useGateDecision(chat, dispatch);
  const ticket = pendingUserTicket(chat);
  const answer = useTicketAnswer(chat, ticket, dispatch);
  const [stopping, setStopping] = useState(false);
  const [older, setOlder] = useState({ loading: false, error: '' });
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>(DEFAULT_INSPECTOR_TAB);
  // Open-to-tab requests also expand a collapsed dock (ChatWorkspace `reveal`).
  const [reveal, setReveal] = useState(0);
  const openInspectorTo = (next: InspectorTab) => { setTab(next); setInspectorOpen(true); setReveal(value => value + 1); };
  const composeInput = useRef<HTMLTextAreaElement>(null);

  const fixedDemo = demo.demo;
  const demoInput = !chat && isFixedDemoPrompt(send.input);
  const capabilities = chat ? state.capabilities : grants.globalCapabilities?.drivers ?? NO_DRIVERS;
  const model = useMemo(() => buildObservatory(chat, capabilities, state.activityTools, state.rotations, fixedDemo), [chat, capabilities, state.activityTools, state.rotations, fixedDemo]);
  const canStop = chat?.tasks.some(activeTask) ?? false;
  const active = isWorkActive(model.tasks, demo.paused);
  const streams = visibleStreams(state);
  const welcome = !loading && !loadError && !state.messages.length && !streams.length;
  const pendingGate = chat?.pipeline?.stage === 'gate-a' ? 'A' : chat?.pipeline?.stage === 'gate-b' ? 'B' : null;
  const live = isLiveOrigin(state.origin);
  const bound = grants.workspaces.find(item => item.id === (chat?.workspaceId ?? grants.selected));
  const runningSeat = model.tasks.filter(task => task.status === 'running').sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0]?.role;

  // Completion observed live (§7 row 13): one toast; its action has a non-toast twin (deliverables, inspector 文件).
  const lastRoot = useRef(model.rootStatus);
  useEffect(() => {
    const before = lastRoot.current;
    lastRoot.current = model.rootStatus;
    if (!chat || !live || before === model.rootStatus || model.rootStatus !== 'completed' || !before) return;
    const files = model.counts.artifacts;
    // Deliverable sheen (§7 row 13): one pass per card, 80ms stagger, at most 12 cards; WAAPI, cancelled when done.
    document.querySelectorAll<HTMLElement>('.chat-delivery .deliv-card').forEach((card, index) => { if (index < 12) animateOnce(card, [{ transform: 'translateX(0) skewX(-18deg)', opacity: 1 }, { transform: 'translateX(380%) skewX(-18deg)', opacity: 1 }], { duration: 1150, delay: index * 80, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::after' }); });
    toast({ id: `chat-done-${chat.id}`, title: '已完成', body: files ? `${files} 个交付文件${chat.artifacts.every(item => item.projectExport?.status === 'saved') ? '已保存到项目' : ''}` : undefined, actions: files ? [{ label: '查看交付物', primary: true, onClick: () => openInspectorTo('files') }] : undefined });
  }, [model.rootStatus, live, chat, model.counts.artifacts]);

  async function stop() {
    if (!chat || stopping) return;
    setStopping(true); send.setError('');
    try {
      const cancelled = await chatApi.cancel(chat.id);
      if (isFixedDemoId(chat.id)) dispatch({ type: 'snapshot', snapshot: await chatApi.get(chat.id), origin: 'demo' });
      else dispatch({ type: 'chat', chat: cancelled });
    } catch (cause) { send.setError(explain(cause, '停止任务失败')); }
    finally { setStopping(false); }
  }
  async function loadOlder(keep: () => void) {
    if (!chat || state.nextBefore === undefined || older.loading) return;
    setOlder({ loading: true, error: '' });
    try {
      const page = await chatApi.messages(chat.id, state.nextBefore);
      keep();
      dispatch({ type: 'older', page });
      setOlder({ loading: false, error: '' });
    } catch (cause) { setOlder({ loading: false, error: explain(cause, '更早消息加载失败') }); }
  }
  const prepareDemo = () => {
    if (!fresh) { location.hash = '/?new=1&demo=play'; return; }
    send.setInput(FIXED_DEMO_PROMPT); send.setError(''); composeInput.current?.focus();
  };

  const title = loading ? '正在恢复聊天…' : loadError ? '加载失败' : chat ? chat.title : '新聊天';
  const connection = chat ? <ConnChip state={fixedDemo ? 'demo' : state.connection} active={active} /> : fresh ? <span className="conn-chip is-local"><i aria-hidden="true">●</i>此计算机</span> : null;
  const previewPipeline = !chat && send.mode === 'pipeline';
  const previewRail = previewPipeline && welcome;
  // The map's rail takes the workspace's focusGate (restores 架构视图 first, then focuses 确认继续), like every other
  // gate jump: a raw focus() on the inert thread did nothing while the map was maximised.
  const mapRail = (onGateNode: () => void) => chat?.pipeline ? <PipelineRail model={model} chat={chat} animate={live} onGateNode={onGateNode} />
    : previewRail ? <PipelineRail model={model} chat={null} preview presetName={send.preset || undefined} /> : undefined;

  return <>
    <TopBarTitle><Crumb trail={[{ label: '聊天', href: '#/' }]} current={title} heading>{chat ? <IdChip id={chat.id} /> : null}</Crumb></TopBarTitle>
    <ChatStatusSlots chat={chat} model={model} fresh={fresh} fixedDemo={fixedDemo} connection={chat ? (fixedDemo ? 'demo' : state.connection) : null} active={active} />
    <ChatWorkspace
      chatKey={chat?.id ?? (fresh ? 'new' : route.chatId ?? 'new')}
      flags={{ welcome, sending: send.sending, working: canStop, active, paused: demo.paused }}
      speak={seatColor(runningSeat)}
      connection={connection}
      hasChat={Boolean(chat)}
      hasPipeline={Boolean(chat?.pipeline) || previewRail}
      skeleton={loading}
      inspectorOpen={inspectorOpen && Boolean(chat)}
      onInspector={setInspectorOpen}
      reveal={reveal}
      pendingGate={pendingGate}
      pendingQuestion={Boolean(ticket)}
      itemCount={threadItemCount(chat, state)}
      thread={context => <Thread state={state} chat={chat} model={model} demo={fixedDemo} loading={loading} loadError={loadError} onRetryLoad={stream.retryLoad}
        notice={stream.notice} backfill={stream.backfill} mapCollapsed={context.mapCollapsed} onExpandMap={context.expandMap}
        band={demo.playback ? <FixedDemoBar playback={demo.playback} sending={send.sending} onPause={() => void demo.togglePause()} onRestart={() => void demo.start()} onProduct={() => demo.setProductOpen(true)} />
          : context.mapCollapsed && chat?.pipeline ? <PipelineRail model={model} chat={chat} compact animate={live} onGateNode={context.focusGate} /> : null}
        welcome={welcome ? <Welcome workspaceName={bound?.name} leaving={send.sending} onStart={text => { send.setInput(text); composeInput.current?.focus(); }} onDemo={prepareDemo} /> : null}
        question={ticket ? { ticket, busy: answer.busy, value: answer.value, error: answer.error, onChange: answer.setValue, onAnswer: value => void answer.submit(value) } : null}
        gateCard={chat && pendingGate ? <GateCard key={`${pendingGate}-${chat.pipeline?.revision}`} chat={chat} model={model} state={gate.state} onDecide={(id, action) => void gate.decide(id, action)} onRetry={gate.retry} /> : null}
        gate={pendingGate} onGate={context.focusGate} onOpenInspector={openInspectorTo}
        older={{ available: state.nextBefore !== undefined, loading: older.loading, error: older.error, onLoad: keep => void loadOlder(keep) }}
        composer={<Composer inputRef={composeInput} input={send.input} onInput={send.setInput} onSubmit={() => void send.send()} fresh={!chat} fixedDemo={fixedDemo} demoInput={demoInput}
          unavailable={loadError ? 'failed' : loading ? 'loading' : false} sending={send.sending} workspaceBusy={grants.busy} canStop={canStop} stopping={stopping} onStop={() => void stop()}
          pending={send.pending} maxFiles={MAX_ATTACHMENT_BATCH} onFiles={send.addFiles} onRetryUpload={item => void send.retryUpload(item)} onRemoveUpload={item => void send.removeUpload(item)}
          error={send.error} costConfirmed={send.costConfirmed} onCostConfirm={send.confirmCost} onCostRevoke={send.revokeCost} steeringAck={send.steeringAck}
          pipeline={{ mode: send.mode, workspace: Boolean(grants.selected), preset: Boolean(send.preset) }}
          team={{ custom: send.teamDraft.mode === 'custom', invalid: !send.teamValidation.valid, reason: send.teamValidation.error }}
          runMode={!chat && !demoInput && !loadError && !loading ? <PipelineComposerControls configuration={grants.globalCapabilities?.apiConfiguration} mode={send.mode} preset={send.preset} auto={send.auto} disabled={send.sending || grants.busy} workspaceGranted={Boolean(grants.selected)} onMode={send.setMode} onPreset={send.setPreset} onAuto={send.setAuto} /> : null}
          project={<ProjectControl chat={chat} unavailable={!fresh && !chat ? (loadError ? 'failed' : 'loading') : false} workspaces={grants.workspaces} selected={grants.selected} busy={grants.busy} sending={send.sending}
            nativePicker={grants.globalCapabilities?.nativePicker} onSelect={grants.setSelected} onChoose={grants.choose} onRevoke={id => void grants.revoke(id)} />}
          collab={<CollabPopover capabilities={capabilities} model={model} demo={fixedDemo} chat={chat} runMode={send.mode} preset={send.preset}
            teamConfiguration={grants.globalCapabilities?.teamConfiguration} teamDraft={send.teamDraft} onTeamDraft={send.setTeamDraft}
            teamValidation={send.teamValidation} disabled={send.sending || grants.busy || Boolean(loadError || loading)} />} />} />}
      map={context => <ChatMap model={model} chat={chat} variant={context.variant} demo={fixedDemo} animateChanges={live} canFlow={fixedDemo ? !demo.playback?.paused : state.connection === 'live'}
        welcome={welcome && !chat ? { ready: capabilities.filter(item => item.available).length, unavailable: capabilities.filter(item => !item.available).map(item => ({ role: seatLabel(item.role), reason: item.reason ?? '当前不可用' })), previewPipeline } : undefined}
        rail={mapRail(context.onGateNode)} dock={context.dock} dockOpen={context.dockOpen} onDockFit={context.onDockFit} onToggleMax={context.onToggleMax} onCollapse={context.onCollapse} onGateNode={context.onGateNode} />}
      inspector={context => chat ? <ChatInspector chat={chat} streams={streams} tools={state.tools} rotations={state.rotations} capabilities={state.capabilities} globalCapabilities={grants.globalCapabilities}
        model={model} fixedDemo={fixedDemo} tab={tab} onTab={setTab} placement={context.placement} collapsed={context.collapsed} onCollapse={context.onCollapse} onClose={() => setInspectorOpen(false)} /> : null}
    />
    {demo.productOpen && fixedDemo ? <Modal title="RoomDesk 会议室预约工具 · 交付成品" size="xl" className="fixed-demo-product-dialog" onClose={() => demo.setProductOpen(false)}>
      <FixedDemoProduct paused={demo.playback?.paused ?? false} cancelled={demo.playback?.cancelled ?? false} active={!demo.playback?.completed && !demo.playback?.cancelled} onPause={() => void demo.togglePause()} onStop={() => void stop()} />
    </Modal> : null}
  </>;
}

