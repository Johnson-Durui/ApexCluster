import type { CSSProperties } from 'react';
import { Icon } from '../../../components/ui';
import { trackStateLabels, type TrackGate, type TrackItem, type TrackSegment, type TrackState } from './trackModel';
import './gatePips.css';

/** 关卡处于当前位置时，一定是在等你决定。 */
const gateStateText = (state: TrackState) => state === 'now' ? '等你决定' : trackStateLabels[state];
const marked = (state: TrackState) => state === 'now' || state === 'blocked' || state === 'stopped';

/**
 * Segment line: the solid part covers finished steps only; the step in progress is marked as a separate dashed stretch
 * (state, not a measured amount), so the bar never implies progress the backend did not report.
 */
function SegmentBar({ item }: { item: TrackSegment }) {
  const total = item.steps.length || 1;
  const done = item.steps.filter(step => step.state === 'done').length;
  const activeIndex = item.steps.findIndex(step => marked(step.state));
  const activeState = activeIndex >= 0 ? item.steps[activeIndex]!.state : null;
  return <span className="gs-bar" aria-hidden="true">
    <i style={{ width: `${Math.round(done / total * 100)}%` }} />
    {activeState ? <b className={activeState} style={{ left: `${activeIndex / total * 100}%`, width: `${100 / total}%` } as CSSProperties} /> : null}
  </span>;
}

/** 完整进度条：5 道关卡（切角方块）+ 6 段模型工作。 */
export function GateTrack({ items, label = '运行进度' }: { items: TrackItem[]; label?: string }) {
  return <ol className="gate-track" aria-label={label}>
    {items.map(item => item.kind === 'gate'
      ? <li key={item.key} className={`gt ${item.state}`} aria-current={item.state === 'now' || item.state === 'blocked' ? 'step' : undefined}>
        <span className="gt-node">{item.state === 'done' ? <Icon name="check" size={13} /> : item.key}</span>
        <span className="gt-text">
          <span className="gt-label">{item.state === 'done' ? `${item.key} ` : ''}{item.label}</span>
          <span className="gt-state">{gateStateText(item.state)}</span>
        </span>
      </li>
      : <li key={item.key} className={`gs ${item.state}`}>
        <SegmentBar item={item} />
        <span className="gs-steps">{item.steps.map(step => <span key={step.phase} className={`gs-step ${step.state}`}>{step.label}{marked(step.state) ? <span className="sr-only">（{trackStateLabels[step.state]}）</span> : null}</span>)}</span>
        {item.loop.length ? <span className={`gs-loop${item.loop.some(step => step.state !== 'todo') ? ' active' : ''}`}><span aria-hidden="true">↻</span>{item.loop.map(step => <span key={step.phase} className={`gs-step ${step.state}`}>{step.label}</span>)}<span className="gs-step">按需</span></span> : null}
      </li>)}
  </ol>;
}

/** 列表里的紧凑关卡进度：只显示 G1–G5。 */
export function GatePips({ items }: { items: TrackItem[] }) {
  const gates = items.filter((item): item is TrackGate => item.kind === 'gate');
  return <span className="gate-pips" role="img" aria-label={`关卡进度：${gates.map(gate => `${gate.key}${gateStateText(gate.state)}`).join('，')}`}>
    {gates.map(gate => <span key={gate.key} className={`gp ${gate.state}`} title={`${gate.key} ${gate.label}：${gateStateText(gate.state)}`}>{gate.key}</span>)}
  </span>;
}
