import type { CSSProperties, ReactNode } from 'react';
import type { SeatHandlers } from '../../components/seatFocus';
import type { TaskStatus } from '../../lib/chat-api';
import type { Box } from './observatoryLayout';
import type { Observatory, ObservatoryEffort } from './observatoryModel';
import { contextUsage, type ContextUsage } from './observatoryScene';
import { EFFORT_SHORT, seatInk, type Density } from './observatoryTheme';

export { contextUsage };

export type Role = Observatory['roles'][number];
export type Stage = Observatory['pipeline']['stages'][number];
export type ChipKind = 'active' | 'done' | 'hold-user' | 'hold-children' | 'error' | 'stopped' | 'idle' | 'unknown' | 'unavailable' | 'queued' | 'gate';

export const CHIP_WORDS: Record<ChipKind, string> = {
  active: '运行中', done: '已完成', 'hold-user': '等待你回答', 'hold-children': '等待子任务', error: '异常', stopped: '已停止',
  idle: '待命', unknown: '未知', unavailable: '当前不可用', queued: '排队中', gate: '关卡',
};
export const TASK_CHIP: Record<TaskStatus, { kind: ChipKind; word: string }> = {
  queued: { kind: 'queued', word: '排队中' },
  running: { kind: 'active', word: '执行中' },
  waiting_user: { kind: 'hold-user', word: '等待你回答' },
  waiting_children: { kind: 'hold-children', word: '等待子任务' },
  completed: { kind: 'done', word: '已完成' },
  failed: { kind: 'error', word: '失败' },
  cancelled: { kind: 'stopped', word: '已取消' },
  interrupted: { kind: 'error', word: '已中断' },
};
const SOURCE_WORDS = { recorded: '调用记录', configured: '席位配置' } as const;

export function roleKind(role: Role): ChipKind {
  // A wait on the user outranks everything else the seat is doing; it is the one thing the user must act on.
  if (role.waitsOnUser) return 'hold-user';
  if (role.state === 'hold') return 'hold-children';
  if ((role.state === 'idle' || role.state === 'done') && role.tasks.some(task => task.status === 'queued')) return 'queued';
  if (role.state === 'idle') return role.available === false ? 'unavailable' : 'idle';
  return role.state;
}

/** The §2 status primitive drawn crisp: ▶ ✓ ◆ ‖ ⋯ ✕ ■ ○ ⊘, always beside a word. */
export function Glyph({ kind }: { kind: ChipKind }) {
  const dashed = kind === 'unknown';
  return <svg className="obs-glyph" data-kind={kind} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
    {kind === 'active' ? <path d="M2 1 9 5 2 9Z" fill="currentColor" /> :
      kind === 'queued' ? <><circle cx="1.6" cy="5" r="1.1" fill="currentColor" /><circle cx="5" cy="5" r="1.1" fill="currentColor" /><circle cx="8.4" cy="5" r="1.1" fill="currentColor" /></> :
      kind === 'unavailable' ? <><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2.5 7.5 7.5 2.5" stroke="currentColor" strokeWidth="1.4" /></> :
      kind === 'done' ? <path d="M1.4 5.4 4 8 8.6 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /> :
      kind === 'hold-children' ? <><rect x="2" y="1.5" width="2.1" height="7" fill="currentColor" /><rect x="5.9" y="1.5" width="2.1" height="7" fill="currentColor" /></> :
      kind === 'hold-user' ? <path d="M5 .6 9.4 5 5 9.4.6 5Z" fill="currentColor" /> :
      kind === 'error' ? <path d="M2 2 8 8M8 2 2 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> :
      kind === 'stopped' ? <rect x="2.2" y="2.2" width="5.6" height="5.6" rx=".6" fill="currentColor" /> :
      kind === 'gate' ? <path d="M5 1.1 8.9 5 5 8.9 1.1 5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /> :
      <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dashed ? '1.6 1.5' : undefined} />}
  </svg>;
}

export function Chip({ kind, children, className = '' }: { kind: ChipKind; children?: ReactNode; className?: string }) {
  return <span className={('obs-chip ' + className).trim()} data-kind={kind}><Glyph kind={kind} />{children ?? CHIP_WORDS[kind]}</span>;
}

export function effortSource(effort?: ObservatoryEffort) {
  return effort ? SOURCE_WORDS[effort.source] : '暂无记录';
}

export function effortLabel(effort: ObservatoryEffort | undefined, short = false) {
  if (!effort) return short ? '未知' : '档位未知';
  if (!effort.level) return effort.label.toUpperCase();
  return short ? EFFORT_SHORT[effort.level] : effort.label.toUpperCase();
}

export function EffortMeter({ effort, large = false }: { effort?: ObservatoryEffort; large?: boolean }) {
  return <span className="obs-meter" data-large={large || undefined} aria-hidden="true">
    {Array.from({ length: 6 }, (_, index) => <i key={index} data-lit={index < (effort?.level ?? 0) || undefined} />)}
  </span>;
}

export function EffortTag({ effort, short = false }: { effort?: ObservatoryEffort; short?: boolean }) {
  return <span className="obs-effort" title={effortSource(effort) + ' · ' + effortLabel(effort)}>
    <EffortMeter effort={effort} />
    <b data-unknown={!effort || undefined}>{effortLabel(effort, short)}</b>
    {effort?.source === 'configured' ? <span className="obs-source" data-kind="configured">配置</span> : null}
  </span>;
}

export function SeatDot({ id }: { id: string }) {
  return <i className="obs-seat-dot" style={{ '--node-color': seatInk(id) } as CSSProperties} aria-hidden="true" />;
}

/** Card position: left/top from the box (never a transform, which FLIP and the camera own). */
export function boxStyle(box: Box, id: string): CSSProperties {
  return { left: box.cx - box.w / 2 + 'px', top: box.cy - box.h / 2 + 'px', width: box.w + 'px', height: box.h + 'px', '--node-color': seatInk(id), '--ink-s': seatInk(id) } as CSSProperties;
}

/** `{Seat} · {status word} · 任务 {x}/{y}` (BUILD-SPEC-B §5.2): completed / all tasks of this seat in the turn. */
export function seatCardLabel(role: Role, word: string) {
  return role.label + ' · ' + word + ' · 任务 ' + role.tasks.filter(task => task.status === 'completed').length + '/' + role.tasks.length;
}

export interface TopologyCardProps {
  role: Role; box: Box; root: boolean; density: Density; kind: ChipKind; word: string;
  /** Seat ids that stay lit while one of them is focused (itself + its bundles' other ends). */
  related: string[];
  /** Root only: completed / total child tasks of the turn. */
  counter?: { completed: number; total: number; id: string };
  dormant?: boolean;
  handlers: SeatHandlers;
}

export function TopologyCard({ role, box, root, density, kind, word, related, counter, dormant, handlers }: TopologyCardProps) {
  const pad = (value: number) => String(value).padStart(2, '0');
  const count = counter ? <span className="obs-counter" id={counter.id}><small>本轮子任务</small> <b>{pad(counter.completed)}</b>/{pad(counter.total)}</span> : null;
  return <button type="button" className="obs-node btn-reset" style={boxStyle(box, role.id)} data-kind={kind} data-root={root || undefined}
    data-dormant={dormant || undefined} data-rel={related.join(' ')} aria-label={seatCardLabel(role, word)}
    aria-describedby={counter?.id} {...handlers}>
    <i className="obs-node-ring" aria-hidden="true" />
    {density === 'tiny' ? <><strong>{role.label}</strong><Glyph kind={kind} />{count}</> : <>
      <span className="obs-node-name"><strong>{role.label}</strong><small>{root ? '主控' : role.description}</small>{count}</span>
      <span className="obs-node-st"><Chip kind={kind}>{word}</Chip></span>
      <span className="obs-node-meta"><EffortTag effort={role.effort} short={density !== 'regular'} /></span>
    </>}
  </button>;
}

export function formatTokens(value: number | null | undefined, short: boolean) {
  if (value == null) return '—';
  if (!short) return value.toLocaleString('zh-CN');
  if (value >= 1_000_000) return +(value / 1_000_000).toFixed(2) + 'M';
  if (value >= 1000) return +(value / 1000).toFixed(1) + 'k';
  return String(value);
}

export function Gauge({ usage }: { usage: ContextUsage }) {
  const known = usage.fraction != null;
  return <span className="obs-gauge" data-unknown={!known || undefined} style={{ '--p': Math.min(100, usage.fraction ?? 0) } as CSSProperties} aria-hidden="true">
    <b>{known ? usage.fraction : '—'}</b>{known ? <small>%</small> : null}
  </span>;
}

export function ContextCard({ role, box, density, related, rotationLabel, handlers }: {
  role: Role; box: Box; density: Density; related: string[]; rotationLabel?: string; handlers: SeatHandlers;
}) {
  const usage = contextUsage(role);
  const kind = roleKind(role);
  const short = density !== 'regular';
  const reading = usage.fraction == null ? '上下文占用未知' : '窗口占用 ' + usage.fraction + '%';
  return <button type="button" className="obs-ctx btn-reset" style={boxStyle(box, role.id)} data-kind={kind} data-rel={related.join(' ')}
    aria-label={role.label + ' · ' + CHIP_WORDS[kind] + ' · ' + reading} {...handlers}>
    <Gauge usage={usage} />
    <span className="obs-ctx-body">
      <strong>{role.label}</strong>
      {density === 'tiny' ? null : <>
        <Chip kind={kind} />
        {usage.fraction == null ? <small className="obs-ctx-unknown">上下文占用未知</small> :
          <small className="obs-ctx-tokens" title={formatTokens(usage.used, false) + ' / ' + formatTokens(usage.hard, false) + ' tokens'}>
            {formatTokens(usage.used, short)} / {formatTokens(usage.hard, short)}</small>}
        {rotationLabel && density === 'regular' ? <small className="obs-tag-warn">{rotationLabel}</small> : null}
      </>}
    </span>
  </button>;
}

export function Panel({ title, icon, hint, className = '', children }: { title: string; icon: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={('obs-panel ' + className).trim()}>
    <h4>{icon}<span>{title}</span>{hint ? <small>{hint}</small> : null}</h4>
    {children}
  </section>;
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="obs-kv"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function TaskMix({ tasks, waitIds }: { tasks: Observatory['tasks']; waitIds: string[] }) {
  // A task that waits on the user (status or pending ticket) counts once, under 等你, never in its status bucket.
  const waiting = new Set(waitIds);
  const count = (statuses: TaskStatus[]) => tasks.filter(task => !waiting.has(task.id) && statuses.includes(task.status)).length;
  const parts = [
    { key: 'done', label: '完成', value: count(['completed']) },
    { key: 'active', label: '运行', value: count(['running']) },
    { key: 'hold-children', label: '等子任务', value: count(['waiting_children']) },
    { key: 'hold-user', label: '等你', value: tasks.filter(task => waiting.has(task.id)).length },
    { key: 'queued', label: '排队', value: count(['queued']) },
    { key: 'stopped', label: '已取消', value: count(['cancelled']) },
    { key: 'error', label: '异常', value: count(['failed', 'interrupted']) },
  ].filter(part => part.value > 0 || ['done', 'active', 'queued'].includes(part.key));
  const total = tasks.length || 1;
  return <div className="obs-mix">
    <div className="obs-mix-bar" aria-hidden="true">{parts.filter(part => part.value).map(part =>
      <i key={part.key} data-kind={part.key} style={{ flexGrow: part.value / total }} />)}</div>
    <ul aria-label="本轮任务构成">{parts.map(part => <li key={part.key} data-kind={part.key}><i aria-hidden="true" />{part.label} <b>{part.value}</b></li>)}</ul>
  </div>;
}

export function LegendKey({ kind, children }: { kind: string; children: ReactNode }) {
  const art: Record<string, ReactNode> = {
    queued: <><path d="M1 6h13" stroke="currentColor" strokeWidth="1.4" /><path d="M22 6 14 2.4v7.2Z" fill="#fff" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></>,
    out: <><path d="M1 6h22" stroke="currentColor" strokeWidth="1.6" /><circle cx="14" cy="6" r="3" fill="#fff" stroke="currentColor" strokeWidth="1.5" /></>,
    back: <><path d="M1 6h22" stroke="currentColor" strokeWidth="1.6" /><circle cx="10" cy="6" r="3" fill="currentColor" stroke="#fff" strokeWidth="1.2" /></>,
    effort: <><path d="M1 3h22M1 6h22M1 9h22" stroke="currentColor" strokeWidth="1.2" /></>,
    wait: <circle cx="12" cy="6" r="4.2" fill="none" stroke="#a35a08" strokeWidth="1.5" strokeDasharray="2.4 1.8" />,
    user: <><circle cx="12" cy="6" r="4.6" fill="none" stroke="#586b99" strokeWidth="1.5" /><path d="M12 3.4 14.6 6 12 8.6 9.4 6Z" fill="#586b99" /></>,
    unknown: <path d="M1 6h22" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 3" />,
    gauge: <><circle cx="12" cy="6" r="4.4" fill="none" stroke="#cfd6e2" strokeWidth="2.2" /><path d="M12 1.6a4.4 4.4 0 0 1 4.2 5.6" fill="none" stroke="currentColor" strokeWidth="2.2" /></>,
  };
  return <span className="obs-legend-key"><svg viewBox="0 0 24 12" width="24" height="12" aria-hidden="true" focusable="false">{art[kind]}</svg>{children}</span>;
}
