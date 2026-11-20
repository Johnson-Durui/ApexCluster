// Pipeline rail (BUILD-SPEC-B §5.1 rail slot, §7 rows 9 and 13): six nodes, gates drawn as diamonds. Stage states come
// only from the observatory model (model.pipeline.stages / pipelineSummary) — there is no second chat.pipeline.stage
// mapping here. Transitions run only under [data-animate] (a live change), never on load.
import { useEffect, useRef } from 'react';
import type { ChatRecord } from '../../../lib/chat-api';
import { Status, type StatusKind } from '../../../components/ui';
import { animateOnce } from '../../../components/motion';
import type { Observatory } from '../observatoryModel';
import { pipelineSummary } from '../ObservatoryPanels';
import './pipeline.css';

type Stage = Observatory['pipeline']['stages'][number];
const PREVIEW: Array<{ id: string; label: string; code: string }> = [
  { id: 'architecture', label: '架构', code: 'ARCH' }, { id: 'gate-a', label: '关卡 A', code: 'GATE A' },
  { id: 'implementation', label: '实现', code: 'BUILD' }, { id: 'acceptance', label: '独立验收', code: 'VERIFY' },
  { id: 'gate-b', label: '关卡 B', code: 'GATE B' }, { id: 'completed', label: '完成', code: 'SHIP' },
];

export function railNode(stage: Pick<Stage, 'state'>, userGate: boolean, cancelled: boolean): { kind: StatusKind; word: string; cls: string } {
  if (stage.state === 'done') return { kind: 'ok', word: '已完成', cls: 'done' };
  if (stage.state === 'active') return { kind: 'run', word: '进行中', cls: 'now' };
  if (stage.state === 'hold') return userGate ? { kind: 'you', word: '等你决定', cls: 'you' } : { kind: 'block', word: '会话受阻', cls: 'held' };
  if (stage.state === 'error') return { kind: 'err', word: '阶段异常', cls: 'err' };
  if (stage.state === 'stopped' || cancelled) return { kind: 'stop', word: cancelled ? '已终止' : '已停止', cls: 'stop' };
  return { kind: 'idle', word: '未开始', cls: 'idle' };
}

const tick = <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.4 6.3l2.3 2.3 4.9-5" /></svg>;

export function PipelineRail({ model, chat, compact = false, preview = false, presetName, animate = false, onGateNode }: {
  model: Observatory;
  chat: ChatRecord | null;
  /** The 40px band in the thread when the map is collapsed. */
  compact?: boolean;
  /** Welcome with 流水线 selected: the six stages, dashed, nothing started. */
  preview?: boolean;
  presetName?: string;
  /** True only for a live change (reducer origin event | chat | demo). */
  animate?: boolean;
  onGateNode?(): void;
}) {
  const sweep = useRef<HTMLSpanElement>(null);
  const summary = pipelineSummary(model);
  const cancelled = model.pipeline.cancelled;
  const stages: Array<{ id: string; label: string; code: string; state: Stage['state'] }> = preview || !model.pipeline.stages.length ? PREVIEW.map(stage => ({ ...stage, state: 'idle' as const })) : model.pipeline.stages;
  const completed = model.pipeline.active === 'completed';
  const previous = useRef(completed);
  useEffect(() => {
    if (completed && !previous.current && animate) animateOnce(sweep.current, [{ transform: 'translateX(-110%)', opacity: 1 }, { transform: 'translateX(360%)', opacity: 1 }], { duration: 700, easing: 'cubic-bezier(.16,1,.3,1)' });
    previous.current = completed;
  }, [completed, animate]);
  const usage = chat?.apiUsage;
  const preset = presetName ?? chat?.pipeline?.preset;
  return <div className={`pipe-rail${compact ? ' is-compact' : ''}${preview ? ' is-preview' : ''}`} role="group" aria-label="流水线进度" data-animate={animate ? '' : undefined}>
    <ol className="pipe-nodes">{stages.map((stage, index) => {
      const node = preview ? { kind: 'idle' as StatusKind, word: '预览', cls: 'idle' } : railNode(stage, summary.userGate, cancelled);
      const gate = stage.id.startsWith('gate');
      const knob = <span className="knob" aria-hidden="true"><span className="fill" />{tick}{node.cls === 'you' ? <span className="ring" /> : null}</span>;
      const label = <><b>{stage.label}{compact ? null : <small>{stage.code}</small>}</b><span className="roll"><Status kind={node.kind} hideWord={compact}>{node.word}</Status></span></>;
      return <li key={stage.id} className={`pnode ${node.cls}${gate ? ' is-gate' : ''}`} data-stage={stage.id}>
        {index < stages.length - 1 ? <span className="edge" aria-hidden="true"><i /></span> : null}
        {node.cls === 'you' && onGateNode
          ? <button type="button" className="btn-reset pnode-hit" onClick={onGateNode} aria-label={`${stage.label} 等你决定，前往处理`}>{knob}{label}</button>
          : <>{knob}{label}</>}
      </li>;
    })}</ol>
    {compact ? null : <div className="pipe-read mono">
      <span>流水线 · {preset ?? '—'}{preview ? ' · 预览' : ''}</span>
      <span>Token <b>{usage ? usage.tokens.toLocaleString('zh-CN') : '—'}</b></span>
      <span>费用估算 <b>{usage ? `$${usage.usd.toFixed(4)}` : '—'}</b>{usage?.unpriced ? ` · 未计价 ${usage.unpriced}` : ''}</span>
    </div>}
    <span className="pipe-sweep" ref={sweep} aria-hidden="true" />
  </div>;
}
