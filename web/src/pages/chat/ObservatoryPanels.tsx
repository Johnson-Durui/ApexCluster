import { Fragment, type CSSProperties } from 'react';
import type { PipelineGeometry } from './observatoryLayout';
import type { Observatory } from './observatoryModel';
import { Chip, CHIP_WORDS, Glyph, SeatDot, TASK_CHIP, type ChipKind, type Stage } from './ObservatoryParts';
import type { Density } from './observatoryTheme';

export function stageKind(stage: Stage, userGate: boolean, cancelled = false): ChipKind {
  if (stage.state === 'hold') return userGate ? 'hold-user' : 'hold-children';
  // A terminated pipeline has no stage waiting for its predecessor any more.
  if (cancelled && stage.state === 'idle') return 'stopped';
  return stage.state;
}
const STAGE_WORDS: Record<ChipKind, string> = { ...CHIP_WORDS, active: '当前阶段', 'hold-user': '待你确认', 'hold-children': '会话受阻', error: '阶段异常', stopped: '已停止', idle: '未开始' };
const STAGE_FOOT: Record<ChipKind, string> = { ...CHIP_WORDS, done: '阶段已完成', active: '进行中', idle: '等待前序阶段', 'hold-user': '等待你在聊天中确认', 'hold-children': '会话受阻', error: '阶段异常', stopped: '运行已停止' };
const stageWord = (kind: ChipKind, cancelled: boolean) => cancelled && kind === 'stopped' ? '已终止' : STAGE_WORDS[kind];
const stageFoot = (kind: ChipKind, cancelled: boolean) => cancelled && kind === 'stopped' ? '流水线已终止' : STAGE_FOOT[kind];
const gateType = (stage: Stage) => stage.mode === 'auto' ? '自动关卡' : '人工关卡';
const stageType = (stage: Stage) => stage.id.startsWith('gate') ? gateType(stage) : '工作阶段';

export function StageChip({ stage, userGate, cancelled = false }: { stage: Stage; userGate: boolean; cancelled?: boolean }) {
  const kind = stageKind(stage, userGate, cancelled);
  return <Chip kind={kind}>{stageWord(kind, cancelled)}</Chip>;
}

export function pipelineSummary(model: Observatory) {
  const { stages, gateMode } = model.pipeline;
  const userGate = gateMode === 'user';
  const cursor = stages.findIndex(stage => stage.state === 'active' || stage.state === 'hold' || stage.state === 'error' || stage.state === 'stopped');
  // No invented position: a cancelled pipeline has no current stage, a finished one points at its last done stage.
  const current = cursor >= 0 ? stages[cursor] : stages.findLast(stage => stage.state === 'done');
  const held = userGate || model.waitingForUser;
  return {
    userGate, cursor, current, held,
    done: stages.filter(stage => stage.state === 'done'),
    running: cursor >= 0 && (stages[cursor].state === 'active' || stages[cursor].state === 'hold') ? 1 : 0,
    idle: stages.filter(stage => stage.state === 'idle').length,
    // A user gate counts once, plus every distinct task in the turn that waits on the user. Never 0 while held.
    waiting: Math.max(held ? 1 : 0, (userGate ? 1 : 0) + model.userWaits),
    // A stopped or failed stage offers no next decision.
    nextGate: cursor >= 0 && (stages[cursor].state === 'active' || stages[cursor].state === 'hold')
      ? stages.find((stage, index) => index > cursor && stage.id.startsWith('gate')) : undefined,
  };
}

/** Who the user is waiting on, by seat name. Only the root lead can ask in production, budget tickets also land on it. */
function waitText(model: Observatory, summary: ReturnType<typeof pipelineSummary>) {
  if (summary.userGate) return (summary.current?.label ?? '关卡') + ' 待你确认';
  const names = model.userWaitRoles.map(id => model.roles.find(role => role.id === id)?.label ?? id);
  return names.length ? names.join('、') + ' 等你回答' : '有 ' + summary.waiting + ' 项等你处理';
}

export function PipelineBand({ model }: { model: Observatory }) {
  const summary = pipelineSummary(model);
  const { stages, cancelled } = model.pipeline;
  const pad = (value: number) => String(value).padStart(2, '0');
  return <div className="obs-band">
    <div className="obs-band-current">
      <small>{cancelled ? '流水线状态' : '当前阶段'}</small>
      <strong>{cancelled ? '已终止' : summary.current?.label ?? '—'}</strong>
      {cancelled ? null : <code>{summary.current?.code}</code>}
    </div>
    <div className="obs-band-progress">
      <div className="obs-segments" aria-hidden="true">{stages.map(stage => <i key={stage.id} data-kind={stageKind(stage, summary.userGate, cancelled)} />)}</div>
      {cancelled ? <p>流水线已在关卡处终止，后续阶段不会再运行。</p> : <p><b>{pad(summary.done.length)}</b> 已完成 · <b>{pad(summary.running)}</b> 进行中 · <b>{pad(summary.idle)}</b> 未开始 · <b data-gate={summary.waiting > 0 || undefined}>{pad(summary.waiting)} 待你处理</b></p>}
    </div>
    {summary.held ? <div className="obs-band-meta"><Chip kind="hold-user">会话等待用户</Chip></div> : null}
  </div>;
}

export function PipelineStrip({ model }: { model: Observatory }) {
  const summary = pipelineSummary(model);
  const next = summary.nextGate;
  return <div className="obs-strip">
    <div><small>已通过</small><span>{summary.done.length ? summary.done.map((stage, index) =>
      <Fragment key={stage.id}>{index ? ' · ' : ''}<Glyph kind="done" />{stage.label}</Fragment>) : '— 尚无'}</span></div>
    <div><small>下一个决定</small><span>{next ? <><Glyph kind="gate" />{next.label} · {next.code}{next.mode === 'auto' ? ' · 自动通过' : ''}</> :
      model.pipeline.cancelled ? '— 流水线已终止' : summary.current?.state === 'stopped' ? '— 运行已停止' :
      summary.current?.state === 'error' ? '— 阶段异常' : '— 无后续关卡'}</span></div>
    <div data-gate={summary.held || undefined}><small>等你处理</small>
      <span>{summary.held ? <><Glyph kind="hold-user" />{waitText(model, summary)}</> : <><Glyph kind="idle" />当前无需你处理</>}</span></div>
  </div>;
}

export function PipelineLegend() {
  return <div className="obs-legend obs-legend-line" aria-label="图例">
    <Chip kind="done">已完成</Chip><Chip kind="active">当前阶段</Chip><Chip kind="idle">未开始</Chip>
    <Chip kind="gate">菱形 = 关卡</Chip><Chip kind="hold-user">等待你确认</Chip><Chip kind="stopped">已停止 / 已终止</Chip>
  </div>;
}

export function StageCards({ model, geometry, density, selected, onSelect }: {
  model: Observatory; geometry: PipelineGeometry; density: Density; selected?: string; onSelect: (id: string) => void;
}) {
  const userGate = model.pipeline.gateMode === 'user';
  const { cancelled } = model.pipeline;
  return <>{model.pipeline.stages.map((stage, index) => {
    const [x, y] = geometry.stations[index] ?? [0, 0];
    const kind = stageKind(stage, userGate, cancelled);
    const style = geometry.vertical
      ? { left: 48 + 'px', top: y - 20 + 'px', width: geometry.cardW + 'px' }
      : { left: x - geometry.cardW / 2 + 'px', top: geometry.cardTop + 'px', width: geometry.cardW + 'px', height: geometry.cardH + 'px' };
    const roomy = !geometry.vertical && geometry.cardW >= 150 && geometry.cardH >= 190;
    // Description lines that fit between the chip and the footer (fixed rows ≈ 126–131 px; 13 px × 1.55 per line).
    const lines = Math.max(0, Math.min(6, Math.floor((geometry.cardH - (density === 'compact' ? 126 : 131)) / 20.15)));
    const shown = density !== 'tiny' && !geometry.vertical && lines > 0;
    // The type and description stay in the accessible name (sr-only) and the tooltip when the card has no room for them.
    return <button type="button" key={stage.id} className="obs-stage-card btn-reset" style={style as CSSProperties} data-kind={kind} data-flip={'stage:' + stage.id}
      data-current={stage.id === model.pipeline.active || undefined} aria-pressed={selected === stage.id} onClick={() => onSelect(stage.id)} title={shown ? undefined : stage.description}>
      <span className="obs-stage-code">{String(index + 1).padStart(2, '0')} · {stage.code}{roomy ? <small>{stageType(stage)}</small> : <span className="sr-only"> · {stageType(stage)}</span>}</span>
      <strong>{stage.label}</strong>
      <Chip kind={kind}>{stageWord(kind, cancelled)}</Chip>
      {shown ? <p style={{ WebkitLineClamp: lines }}>{stage.description}</p> : <span className="sr-only">{stage.description}</span>}
      {!geometry.vertical ? <small className="obs-stage-foot">{stageFoot(kind, cancelled)}</small> : null}
      {roomy ? <i className="obs-watermark" aria-hidden="true">{String(index + 1).padStart(2, '0')}</i> : null}
    </button>;
  })}</>;
}

/**
 * 阶段详情 read-out of a stage the user picked (a card or picker button): 序号, 类型, description and the neighbouring
 * stages with their states, one line in the caption bar (wrapping on a tiny map). The full text is also its tooltip.
 */
export function StageDetail({ model, stage, onClose }: { model: Observatory; stage: Stage; onClose(): void }) {
  const { stages, cancelled } = model.pipeline;
  const userGate = model.pipeline.gateMode === 'user';
  const index = stages.indexOf(stage);
  const pad = (value: number) => String(value).padStart(2, '0');
  const neighbour = (label: string, item: Stage | undefined) => {
    if (!item) return <span>{label} —</span>;
    const kind = stageKind(item, userGate, cancelled);
    return <span>{label} {item.label} <Chip kind={kind}>{stageWord(kind, cancelled)}</Chip></span>;
  };
  const before = stages[index - 1];
  const after = stages[index + 1];
  const word = (item: Stage | undefined) => item ? item.label + ' ' + stageWord(stageKind(item, userGate, cancelled), cancelled) : '—';
  const text = [stage.label + ' ' + pad(index + 1) + ' / ' + pad(stages.length), stageType(stage), stage.description, '上一阶段 ' + word(before), '下一阶段 ' + word(after)].join(' · ');
  return <div className="obs-stage-detail" role="group" aria-label="阶段详情">
    <span className="obs-stage-detail-text" title={text}>
      <b>{stage.label}</b><code>{pad(index + 1)} / {pad(stages.length)}</code><span>{stageType(stage)}</span>
      <span className="obs-stage-detail-desc">{stage.description}</span>{neighbour('上一阶段', before)}{neighbour('下一阶段', after)}
    </span>
    <button type="button" className="btn-reset obs-stage-detail-close" aria-label="关闭阶段详情" onClick={onClose}>×</button>
  </div>;
}

export function EventList({ model }: { model: Observatory }) {
  if (!model.signals.length) return <p className="obs-empty-note">当前轮次还没有可展示的协作事件。</p>;
  const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  };
  return <ul className="obs-events-list">{model.signals.map(signal => {
    const task = signal.id.startsWith('task:') ? model.tasks.find(item => 'task:' + item.id === signal.id) : undefined;
    const kind: ChipKind = task ? (model.userWaitIds.includes(task.id) ? 'hold-user' : TASK_CHIP[task.status].kind) : signal.state === 'hold' ? 'hold-children' : signal.state;
    const role = model.roles.find(item => item.id === signal.role);
    return <li key={signal.id} data-kind={kind}>
      <time dateTime={signal.at}>{time(signal.at)}</time>
      <Glyph kind={kind} />
      <span title={signal.label}>{signal.label}</span>
      <small>{role ? <SeatDot id={role.id} /> : null}{role?.label ?? '工作台'}</small>
    </li>;
  })}</ul>;
}
