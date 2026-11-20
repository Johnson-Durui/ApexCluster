import { Status } from '../../../components/ui';
import { roleLabel, statusLabel } from '../../../lib/labels';
import type { CandidateTotals, CellResult, ConstraintResult } from '../../../lib/types';
import { scoreCellText, scoreKindMeta } from './scoreCell';

const verdictGlyph = (value: string | null | undefined) => value === 'pass' ? '✓' : value === 'fail' ? '✕' : '?';

/** One judgement per constraint cell: ✓ 满足 / ✕ 不满足 / ‖ 分歧 C ✓ · A ✕ (unknown cells are hatched by CSS). */
export function ConstraintVerdict({ cell }: { cell: ConstraintResult }) {
  const override = cell.source === 'user' ? <span className="tag user">你的覆盖</span> : null;
  if (cell.status === 'pass') return <><Status kind="ok">{statusLabel('pass')}</Status>{override}</>;
  if (cell.status === 'fail') return <><Status kind="err">{statusLabel('fail')}</Status>{override}</>;
  if (cell.status === 'disputed') return <><Status kind="child">分歧</Status><span className="v">C {verdictGlyph(cell.judgeStatuses.claude)} · A {verdictGlyph(cell.judgeStatuses.astra)}</span>{override}</>;
  return <><span className="v muted">{statusLabel(cell.status)}</span>{override}</>;
}

export function constraintLabel(cell: ConstraintResult, name: string) {
  const judge = (role: 'claude' | 'astra') => `${roleLabel[role]} ${statusLabel(cell.judgeStatuses[role] ?? 'unknown')}`;
  return `${name}：${statusLabel(cell.status)}（${judge('claude')}，${judge('astra')}）${cell.source === 'user' ? '，你的覆盖' : ''}，查看依据`;
}

const scoreTag: Partial<Record<CellResult['kind'], string>> = { disputed: 'wait', single: '', user: 'user' };

/** Score cell: mono `4 / 3 → 3.5`; a tag only for 分歧 / 单方 / 你的覆盖 (agreed cells carry no tag). */
export function ScoreValue({ cell }: { cell: CellResult }) {
  const tone = scoreTag[cell.kind];
  return <><span className="v">{scoreCellText(cell)}</span>{tone !== undefined ? <span className={`tag${tone ? ` ${tone}` : ''}`}>{scoreKindMeta[cell.kind].label}</span> : null}</>;
}

export function scoreLabel(cell: CellResult, name: string) {
  return `${name}：${scoreCellText(cell)}，${scoreKindMeta[cell.kind].label}，查看依据`;
}

/** Interval rows with an SVG track per candidate: a δ band (tie width) centred on the interval midpoint. */
export function IntervalChart({ totals, delta, name }: { totals: CandidateTotals[]; delta: number; name: (id: string) => string }) {
  if (!totals.length) return null;
  const low = Math.max(0, Math.floor((Math.min(...totals.map(total => total.lo)) - delta) * 2) / 2);
  const high = Math.min(5, Math.ceil((Math.max(...totals.map(total => total.hi)) + delta) * 2) / 2);
  const span = Math.max(0.5, high - low);
  const x = (value: number) => Math.max(0, Math.min(100, (value - low) / span * 100));
  const ticks: number[] = [];
  for (let value = low; value <= high + 1e-9; value += 0.5) ticks.push(Number(value.toFixed(1)));
  return <div className="interval-list">
    {totals.map(total => {
      const mid = (total.lo + total.hi) / 2;
      const band = Math.min(100, delta / span * 100);
      return <div className="interval-row" key={total.candidateId}>
        <div><strong className="mono">{total.candidateId}</strong><small>{name(total.candidateId)}</small></div>
        <svg className="interval-track" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label={`${total.candidateId} 总分区间 ${total.lo.toFixed(2)} 到 ${total.hi.toFixed(2)}`}>
          {ticks.map(tick => <line key={tick} className="grid" x1={x(tick)} x2={x(tick)} y1="0" y2="20" />)}
          <rect className="delta-band" x={x(mid) - band / 2} y="2" width={band} height="16" />
          {/* a point estimate (lo = hi) is drawn as a point, never widened into a fake interval */}
          {x(total.hi) - x(total.lo) > 2
            ? <><rect className="interval-band" x={x(total.lo)} y="6" width={x(total.hi) - x(total.lo)} height="8" /><line className="mid" x1={x(mid)} x2={x(mid)} y1="3" y2="17" /></>
            : <line className="point" x1={x(mid)} x2={x(mid)} y1="3" y2="17" />}
        </svg>
        <span className="mono">{total.lo.toFixed(2)}–{total.hi.toFixed(2)}</span>
      </div>;
    })}
    <div className="interval-row interval-axis" aria-hidden="true"><span /><div>{ticks.map(tick => <span key={tick} style={{ left: `${x(tick)}%` }}>{tick.toFixed(1)}</span>)}</div><span /></div>
  </div>;
}
