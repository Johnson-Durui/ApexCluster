// The map pane's stage (BUILD-SPEC-B §5.2): mist + grid, the fibre canvas, the cards of the current view, caption,
// legend and seat picker. Re-layout follows the stage size (≤ every 120 ms while a splitter drags), is held still while
// a docked ↔ full FLIP plays, and a camera preset re-lays the scene out crisply after a 420 ms CSS bridge.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { reducedMotion } from '../../components/motion';
import { seatHandlers, useSeatFocus } from '../../components/seatFocus';
import { Tag } from '../../components/ui';
import type { ChatRecord } from '../../lib/chat-api';
import ObservatoryGraphic, { type GraphicHandle, type GraphicScene } from './ObservatoryGraphic';
import { bridge, cameraFor, cameraStep, IDENTITY, presetTarget, sameCamera, type Camera, type CameraPreset } from './mapCamera';
import { playFlip, readRects, settleTimer, type Rects } from './mapFlip';
import { currentFocus, dimRules, markPressed, usePinnedSeat } from './mapFocus';
import { mapPlayback, runActive } from './mapMotion';
import { TopologyLayer, useTopologyScene } from './MapTopology';
import { contextGeometry, pipelineGeometry } from './observatoryLayout';
import type { Observatory } from './observatoryModel';
import { PipelineBand, PipelineLegend, PipelineStrip, pipelineSummary, StageCards, StageDetail, stageKind } from './ObservatoryPanels';
import { ContextCard, contextUsage, effortLabel, Glyph, LegendKey, roleKind, Chip } from './ObservatoryParts';
import { contextIds } from './observatoryScene';
import { CARD, densityFor, seatInk, type Density, type Size } from './observatoryTheme';
import { useMapMotion } from './useMapMotion';
import type { MapVariant } from './workspaceContracts';

export type MapView = 'topology' | 'pipeline' | 'context';
const ROTATION_LABELS: Record<string, string> = { soft: '接近软限制', hard: '达到硬限制', yield: '主动交接', wait: '等待外部结果', time: '窗口时限', actions: '工具动作上限', crash: '异常恢复' };
const EASE_IO = 'cubic-bezier(.65,0,.35,1)';
const RELAYOUT_MS = 120;
const pad = (value: number) => String(value).padStart(2, '0');
const NO_IDS: string[] = [];

export interface MapStageProps {
  model: Observatory; chat: ChatRecord | null; variant: MapVariant; view: MapView; demo: boolean;
  animateChanges: boolean; canFlow: boolean; welcome?: { ready: number; unavailable: { role: string; reason: string }[] };
  preset: CameraPreset; onGateNode(): void; onFlip(active: boolean): void; onTween(active: boolean): void;
}

/** Waiting seats for the 等待项 camera preset (and the head's disabled state). */
export function waitingSeats(model: Observatory) {
  const userGate = model.pipeline.gateMode === 'user';
  return model.roles.filter(role => role.waitsOnUser || role.state === 'hold' || (userGate && role.id === model.rootRole)).map(role => role.id);
}

function useStageSize(flipping: { current: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = { w: element.clientWidth, h: element.clientHeight };
    setSize(previous => previous.w === next.w && previous.h === next.h ? previous : next);
  }, []);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    measure();
    let last = 0;
    let trailing = 0;
    // The canvas keeps its last bitmap (CSS-stretched) while a splitter drags; re-layout at most every 120 ms.
    const observer = new ResizeObserver(() => {
      if (flipping.current) return;
      const wait = RELAYOUT_MS - (performance.now() - last);
      window.clearTimeout(trailing);
      if (wait <= 0) { last = performance.now(); measure(); } else trailing = window.setTimeout(() => { last = performance.now(); measure(); }, wait);
    });
    observer.observe(element);
    return () => { observer.disconnect(); window.clearTimeout(trailing); };
  }, [measure, flipping]);
  return { ref, size, measure };
}

export default function MapStage({ model, chat, variant, view, demo, animateChanges, canFlow, welcome, preset, onGateNode, onFlip, onTween }: MapStageProps) {
  const flipping = useRef(false);
  const { ref: stageRef, size, measure } = useStageSize(flipping);
  const worldRef = useRef<HTMLDivElement>(null);
  const graphic = useRef<GraphicHandle | null>(null);
  const focus = useSeatFocus();
  const frameRef = useRef<HTMLDivElement>(null);
  const pinned = usePinnedSeat(frameRef);
  // New cards and picker buttons pick up aria-pressed from the current focus after every commit.
  useLayoutEffect(() => markPressed(frameRef.current, currentFocus(frameRef.current)));
  const [replayTurn, setReplayTurn] = useState<string | null>(null);
  const [motionPaused, setMotionPaused] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [phase, setPhase] = useState<string>();
  const [camera, setCamera] = useState<Camera>(IDENTITY);

  // FLIP "first": read in render while the DOM still shows the previous framing (painted rects, so mid-move retargets).
  const lastVariant = useRef(variant);
  const first = useRef<Rects | null>(null);
  const armed = useRef(false);
  if (lastVariant.current !== variant) {
    first.current = readRects(stageRef.current);
    lastVariant.current = variant;
  }

  const full = variant === 'full';
  // 回放 / 暂停流线 live in the full view only; leaving it drops both so re-maximising starts clean (mapPlayback gates them too).
  useEffect(() => {
    if (full) return;
    setReplayTurn(null);
    setMotionPaused(false);
  }, [full]);

  const ready = size.w > 0 && size.h > 0;
  const wide = densityFor(size.w);
  const density: Density = variant === 'docked' && wide === 'regular' ? 'compact' : wide;
  const tiny = density === 'tiny';
  const tight = variant === 'docked' && ready && size.h < 340;
  const userGate = model.pipeline.gateMode === 'user';
  const held = userGate || model.waitingForUser;
  const loading = !chat && !welcome;
  const dormant = Boolean(welcome) && !model.tasks.length && model.roles.length > 0;
  const canReplay = !dormant && model.links.some(link => link.flow.outbound || link.flow.returning);
  const { replay, playback, paused } = mapPlayback({ full, topology: view === 'topology', canReplay, replayTurn, turnId: model.turnId, motionPaused, canFlow });
  const topology = useTopologyScene({ model, pinned, size, density, tight, replay, dormant, canFlow, camera });
  const roleById = useMemo(() => new Map(model.roles.map(role => [role.id, role])), [model]);
  const card = CARD[density];

  const orbit = useRef<string[]>([]);
  const context = useMemo(() => {
    const ids = contextIds(model, pinned, orbit.current[0] === model.rootRole ? orbit.current : []);
    orbit.current = ids;
    return { ids, geometry: contextGeometry(ids, size, density, card.context) };
  }, [model, pinned, size, density, card.context]);
  const pipeline = useMemo(() => pipelineGeometry(model.pipeline.stages.length, size, density), [model.pipeline.stages.length, size, density]);
  const activeStage = model.pipeline.stages.find(item => item.id === model.pipeline.active);
  const stage = model.pipeline.stages.find(item => item.id === phase) ?? (model.pipeline.cancelled ? undefined : activeStage ?? model.pipeline.stages[0]);

  const scene: GraphicScene = useMemo(() => view === 'topology' ? { mode: view, links: topology.links, routes: topology.routes }
    : view === 'pipeline' ? { mode: view, geometry: pipeline, stations: model.pipeline.stages.map(item => ({ gate: item.id.startsWith('gate'), state: item.state, userHold: userGate, selected: item.id === stage?.id })) }
    : { mode: view, geometry: context.geometry, seats: context.ids.flatMap(id => {
      const role = roleById.get(id);
      if (!role) return [];
      const usage = contextUsage(role);
      return [{ color: seatInk(id), known: usage.fraction != null, active: role.state === 'active', state: role.state,
        level: usage.fraction == null ? 0 : Math.max(1, Math.min(6, Math.round(6 * usage.fraction / 100))) }];
    }) }, [view, topology, pipeline, context, model, roleById, userGate, stage?.id]);
  const sceneKey = useMemo(() => JSON.stringify(view === 'topology'
    ? [view, topology.boxes.map(box => [box.id, Math.round(box.cx), Math.round(box.cy), box.w]), topology.links.map(link => [link.key, link.active, link.flow, link.effort, link.returnUntil, link.potential])]
    : view === 'pipeline' ? [view, scene.mode === 'pipeline' ? scene.stations : null, pipeline.stations]
    : [view, context.geometry.boxes.map(box => [box.id, Math.round(box.cx), Math.round(box.cy)]), scene.mode === 'context' ? scene.seats : null, held]), [view, topology, pipeline, context, scene, held]);
  const ids = view === 'topology' ? topology.ids : view === 'context' ? context.ids : NO_IDS;
  // Focus dimming for the cards of whichever view is shown (topology or 上下文, §5.3).
  const focusRules = useMemo(() => dimRules(ids), [ids]);

  useMapMotion({ model, animateChanges: animateChanges && !loading, scope: stageRef, graphic, topology });

  // docked ↔ full: measure at once (a synchronous re-render before paint), then play the FLIP from the old rects. One settle
  // timer at a time: a toggle in mid-move drops the earlier one, so it cannot lift the FLIP guard while cards still move.
  const [settle] = useState(settleTimer);
  useEffect(() => () => settle.cancel(), [settle]);
  useLayoutEffect(() => {
    if (!first.current) return;
    settle.cancel();
    armed.current = true;
    flipping.current = true;
    onFlip(true);
    measure();
  }, [variant, measure, onFlip, settle]);
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!armed.current || !element || element.clientWidth !== size.w || element.clientHeight !== size.h) return;
    armed.current = false;
    const rects = first.current ?? new Map();
    first.current = null;
    settle.arm(playFlip(element, rects), () => { flipping.current = false; onFlip(false); measure(); });
  });

  // Camera: a preset change bridges with a 420 ms transform on the world, then commits the crisp re-layout.
  const waiting = useMemo(() => waitingSeats(model), [model]);
  const target = useMemo(() => variant === 'full' && view === 'topology'
    ? cameraFor(presetTarget(preset, topology.world, topology.ids[0], waiting), size) : IDENTITY, [variant, view, preset, topology.world, topology.ids, waiting, size]);
  const lastPreset = useRef(preset);
  const tween = useRef<Animation | null>(null);
  /** Where the running tween is headed; a model update that recomputes the same target leaves it alone. */
  const tweenTo = useRef<Camera | null>(null);
  useLayoutEffect(() => {
    const presetChanged = lastPreset.current !== preset;
    lastPreset.current = preset;
    const world = worldRef.current;
    const step = cameraStep(target, camera, tween.current ? tweenTo.current : null, presetChanged,
      Boolean(world) && variant === 'full' && !flipping.current && !reducedMotion());
    if (step.kind === 'hold') return;
    const running = tween.current;
    if (step.kind === 'snap' || !world) {
      running?.cancel();
      tween.current = null;
      tweenTo.current = null;
      onTween(false);
      if (!sameCamera(target, camera)) setCamera(target);
      return;
    }
    // Start, or retarget from the painted matrix (reversing mid-move included): the bridge is always from the committed camera.
    const painted = getComputedStyle(world).transform;
    running?.cancel();
    const destination = target;
    const animation = world.animate([{ transform: painted === 'none' ? 'matrix(1,0,0,1,0,0)' : painted }, { transform: bridge(camera, destination) }], { duration: 420, easing: EASE_IO, fill: 'forwards' });
    tween.current = animation;
    tweenTo.current = destination;
    onTween(true);
    animation.onfinish = () => {
      if (tween.current !== animation) return;
      if (step.commit) flushSync(() => setCamera(destination));
      animation.cancel();
      tween.current = null;
      tweenTo.current = null;
      onTween(false);
    };
  }, [target, camera, preset, variant, onTween]);
  useEffect(() => () => tween.current?.cancel(), []);

  const summary = pipelineSummary(model);
  const caption: ReactNode[] = view === 'topology'
    ? dormant ? ['任务光纤', (welcome?.ready ?? 0) + ' 个席位就绪', '发送后分派']
      : [(playback ? '记录回放 · ' : '') + '任务光纤', model.links.length + ' 条席位分派', <b key="you" data-you={summary.waiting > 0 || undefined}>{summary.waiting} 项等你</b>,
        ...(topology.ids.length < model.roles.length ? ['显示 ' + topology.ids.length + ' / ' + model.roles.length + ' 席位'] : [])]
    : view === 'pipeline' ? ['阶段轨迹', '预设 ' + (chat?.pipeline?.preset ?? '普通聊天'),
      ...(model.pipeline.cancelled ? ['已终止'] : activeStage ? ['当前 ' + pad(model.pipeline.stages.indexOf(activeStage) + 1) + ' / ' + pad(model.pipeline.stages.length)] : [])]
    : ['模型调用', model.roles.filter(role => role.latestInvocation).length + ' 个席位有调用记录', model.rotationCount + ' 次交接',
      ...(context.ids.length < model.roles.length ? ['显示 ' + context.ids.length + ' / ' + model.roles.length + ' 席位'] : [])];
  // 阶段详情 of a stage the user picked: right of the caption, or in place of the 当前阶段 band on a tiny map (the stage keeps its rows).
  const detail = view === 'pipeline' && phase && stage?.id === phase ? <StageDetail model={model} stage={stage} onClose={() => setPhase(undefined)} /> : null;
  const controls = full && view !== 'pipeline' ? <div className="obs-controls">
    {pinned ? <button type="button" className="btn sm" onClick={() => focus.clear()}>全图</button> : null}
    {view === 'topology' && canReplay ? <button type="button" className="btn sm" aria-pressed={replay} onClick={() => {
      setReplayTurn(replay ? null : model.turnId ?? '');
      setMotionPaused(false);
      setEpoch(value => value + 1);
    }}>回放</button> : null}
    {view === 'topology' && !dormant && (playback || (canFlow && model.links.some(link => link.flow.outbound > 0))) ? <button type="button" className="btn sm" aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? '继续流线' : '暂停流线'}</button> : null}
  </div> : null;
  const captionBar = loading ? null : <div className="obs-caption"><span className="obs-cap">{caption.map((part, index) => <span key={index}>{part}</span>)}
    {demo ? <Tag tone="mock">▷ 预设演示</Tag> : null}</span>{controls}{tiny ? null : detail}</div>;
  const long = full && density === 'regular';
  const legend = loading || dormant ? null : view === 'topology' ? <div className="obs-legend">
    <LegendKey kind="out">{long ? '分派 · 向外' : '分派'}</LegendKey><LegendKey kind="back">{long ? '回传 · 向内' : '回传'}</LegendKey>
    <LegendKey kind="user">等你决定</LegendKey><span data-opt=""><LegendKey kind="wait">等待子任务</LegendKey></span>
    <span data-opt=""><LegendKey kind="effort">{long ? '粗纤维根数 = 思考档位' : '根数 = 档位'}</LegendKey></span>
    <span data-opt=""><LegendKey kind="queued">{long ? '空心箭头 = 排队中' : '排队'}</LegendKey></span><span data-opt=""><LegendKey kind="unknown">{long ? '虚线 = 档位未知' : '虚线 = 未知'}</LegendKey></span>
  </div> : view === 'context' ? <div className="obs-legend">
    <LegendKey kind="gauge">{long ? '弧长 = 已用 / 硬上限' : '已用 / 上限'}</LegendKey><span data-opt=""><LegendKey kind="unknown">{long ? '虚线 = 尚无调用报告' : '虚线 = 未知'}</LegendKey></span><LegendKey kind="out">{long ? '运行中的调用' : '运行中'}</LegendKey>
  </div> : <PipelineLegend />;
  const empty = loading ? null : view === 'pipeline' && !model.pipeline.stages.length ? ['当前会话没有流水线', '新聊天启用「流水线」后，可在这里查看阶段和关卡。']
    : view !== 'pipeline' && !model.roles.length ? ['尚无协作席位', '选中会话或连接模型席位后，可查看任务分派。'] : null;
  const shownSeats = view === 'topology' ? topology.ids.length : context.ids.length;
  const picker = loading || !model.roles.length ? false : view === 'pipeline' ? full && model.pipeline.stages.length > 0 : full || shownSeats < model.roles.length;
  const rotationLabel = (id: string) => { const reason = roleById.get(id)?.latestInvocation?.rotationReason; return reason ? '⚠ ' + (ROTATION_LABELS[reason] ?? '已交接') : undefined; };

  return <div className="obs-frame" ref={frameRef} data-density={density} data-tight={tight || undefined} data-view={view}
    style={{ '--ctx-w': card.context.w + 'px', '--ctx-h': card.context.h + 'px' } as CSSProperties}>
    {tiny ? captionBar : null}
    {tiny && view === 'pipeline' && model.pipeline.stages.length ? detail ?? <PipelineBand model={model} /> : null}
    <div className="obs-stage" ref={stageRef} data-held={held || undefined}>
      <div className="obs-world" ref={worldRef}>
        {ready && !loading ? <ObservatoryGraphic scene={scene} sceneKey={sceneKey} size={size} density={density} ids={ids} held={held}
          paused={paused} live={canFlow && runActive(model)} epoch={epoch} handle={graphic} /> : null}
        {focusRules ? <style>{focusRules}</style> : null}
        {ready && !loading && view === 'topology' ? <TopologyLayer model={model} scene={topology} density={density} userGate={userGate} held={held}
          dormant={dormant} welcome={welcome} showYou={Boolean(chat) && !dormant} onGateNode={onGateNode} /> : null}
        {ready && !loading && view === 'context' ? <>
          {context.geometry.boxes.map(box => {
            const role = roleById.get(box.id);
            return role ? <ContextCard key={box.id} role={role} box={box} density={density} related={[box.id]} rotationLabel={rotationLabel(box.id)} handlers={seatHandlers(box.id)} /> : null;
          })}
          {context.ids.length ? <div className="obs-core-label" style={{ left: context.geometry.center[0] + 'px', top: context.geometry.center[1] + 'px' }}>
            <strong>上下文窗口</strong>
            <small>{context.ids.filter(id => { const role = roleById.get(id); return role && contextUsage(role).fraction != null; }).length} / {context.ids.length} 席位已报告</small>
            {held && !tiny ? <Chip kind="hold-user">等待人工确认</Chip> : null}
          </div> : null}
        </> : null}
        {ready && !loading && view === 'pipeline' && model.pipeline.stages.length ? <StageCards model={model} geometry={pipeline} density={density} selected={stage?.id} onSelect={setPhase} /> : null}
      </div>
      {ready && !loading && view === 'pipeline' && model.pipeline.stages.length && !tiny ? <><PipelineBand model={model} /><PipelineStrip model={model} /></> : null}
      {!tiny ? captionBar : null}
      {!tiny && !empty ? legend : null}
      {empty ? <div className="obs-graph-empty"><strong>{empty[0]}</strong><span>{empty[1]}</span></div> : null}
    </div>
    {tiny && view === 'pipeline' && model.pipeline.stages.length ? <PipelineStrip model={model} /> : null}
    {tiny && !empty ? legend : null}
    {picker ? <div className="obs-picker" role="group" aria-label={view === 'pipeline' ? '查看阶段' : '查看席位'}>
      {view === 'pipeline' ? model.pipeline.stages.map(item => <button type="button" className="btn-reset" key={item.id} aria-pressed={stage?.id === item.id} onClick={() => setPhase(item.id)}>
        <Glyph kind={stageKind(item, userGate, model.pipeline.cancelled)} /><span className="obs-picker-name">{item.label}</span><code>{item.code}</code></button>)
        : model.roles.map(role => {
          const usage = contextUsage(role);
          return <button type="button" className="btn-reset" key={role.id} style={{ '--node-color': seatInk(role.id) } as CSSProperties} {...seatHandlers(role.id)}>
            <i className="obs-seat-dot" aria-hidden="true" /><span className="obs-picker-name">{role.label}</span><Glyph kind={roleKind(role)} />
            {view === 'context' ? <code>{usage.fraction == null ? '—' : usage.fraction + '%'}</code> : <code>{effortLabel(role.effort, true)}</code>}
          </button>;
        })}
    </div> : null}
  </div>;
}
