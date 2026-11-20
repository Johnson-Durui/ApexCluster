// History queue helpers (BUILD-SPEC-B §6.2). Pure; the page and its tests share them. homeModel.ts keeps its exports.
import type { ModelRole, RunMetrics, RunSummary } from '../../lib/types';
import type { StatusKind } from '../../components/ui';
import { formatDate, phaseLabels } from '../../lib/labels';
import { outcomeText, runState, summaryTrack, waitingGate, type RunFilter } from './homeModel';
import type { TrackGate, TrackState } from '../run/header/trackModel';

export type HistorySort = 'updated' | 'created';
export const SELECTED_KEY = 'dmw:history:selected:v1';

/** Two-digit KPI numerals (`02`), never a fake 0 while loading: callers show `—` until the first load. */
export const pad2 = (value: number) => String(value).padStart(2, '0');

/** Status primitive kind for a run row: glyph + word + colour. */
export function runKind(run: RunSummary): StatusKind {
  if (run.terminal === 'cancelled') return 'stop';
  if (run.terminal === 'done') return outcomeText(run).includes('停止') ? 'stop' : 'ok';
  const state = runState(run);
  return state === 'waiting' ? 'you' : state === 'blocked' ? 'block' : 'run';
}

/** The queue's status word: the homeModel string, shortened to the gate key for waiting rows (the stage column says which step). */
export function rowStatusWord(run: RunSummary): string {
  return runState(run) === 'waiting' ? `等你决定 · ${waitingGate(run)}` : outcomeText(run);
}

export const phaseText = (run: RunSummary) => phaseLabels[run.phase] ?? run.phase;

/** `{title}，{status}，{当前阶段}，更新于 {time}` (the option's accessible name; GatePips are flattened into it). */
export function optionLabel(run: RunSummary): string {
  return `${run.title}，${outcomeText(run)}，${phaseText(run)}，更新于 ${formatDate(run.updatedAt)}`;
}

export function sortRuns(runs: RunSummary[], sort: HistorySort): RunSummary[] {
  const key = sort === 'created' ? 'createdAt' : 'updatedAt';
  return [...runs].sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]));
}

/** Waiting rows first (`等你决定 · N`), then everything else (`其他运行 · N`). */
export function groupRuns(rows: RunSummary[]): { waiting: RunSummary[]; others: RunSummary[] } {
  const waiting = rows.filter(run => runState(run) === 'waiting');
  return { waiting, others: rows.filter(run => runState(run) !== 'waiting') };
}

/** The flat visual order of the listbox, used for ↑/↓. */
export const orderedRows = (rows: RunSummary[]) => { const { waiting, others } = groupRuns(rows); return [...waiting, ...others]; };

/** Counts beside the status filters, over the rows the legacy toggle includes. */
export function filterCounts(runs: RunSummary[], showLegacy: boolean): Record<RunFilter, number> {
  const pool = showLegacy ? runs : runs.filter(run => run.mode !== 'mock');
  const count = (match: (run: RunSummary) => boolean) => pool.filter(match).length;
  return {
    all: pool.length,
    waiting: count(run => runState(run) === 'waiting'),
    active: count(run => runState(run) === 'active' || runState(run) === 'blocked'),
    ended: count(run => runState(run) === 'ended'),
  };
}

export interface GateCell { key: string; label: string; kind: StatusKind; word: string; state: TrackState }
const gateWords: Record<TrackState, [StatusKind, string]> = {
  done: ['ok', '已完成'], now: ['you', '等你决定'], todo: ['idle', '未开始'], off: ['idle', '已关闭'], blocked: ['block', '已阻塞'], stopped: ['stop', '在此停止'],
};

/** The labelled G1–G5 track. `now` is indigo only while the run really waits on the user. */
export function gateCells(run: RunSummary): GateCell[] {
  const waiting = runState(run) === 'waiting';
  return summaryTrack(run).filter((item): item is TrackGate => item.kind === 'gate').map(gate => {
    const [kind, word] = gate.state === 'now' && !waiting ? ['run', '进行中'] as [StatusKind, string] : gateWords[gate.state];
    return { key: gate.key, label: gate.label, kind, word, state: gate.state };
  });
}

// ---------- metrics (GET /api/runs/:id/metrics) ----------
export interface SeatMinutes { role: ModelRole; minutes: number; known: boolean; unknownCount: number }
const ROLE_ORDER: ModelRole[] = ['claude', 'astra', 'sol', 'grok'];

/** modelTime.buckets summed by role. A role whose buckets all have knownCount===0 is `known:false` (shown as 未知, never a 0 bar). */
export function seatMinutes(metrics: RunMetrics): SeatMinutes[] {
  const byRole = new Map<ModelRole, SeatMinutes>();
  for (const bucket of metrics.modelTime.buckets) {
    const seat = byRole.get(bucket.role) ?? { role: bucket.role, minutes: 0, known: false, unknownCount: 0 };
    seat.minutes += bucket.knownCount > 0 ? bucket.minutes : 0;
    seat.known = seat.known || bucket.knownCount > 0;
    seat.unknownCount += bucket.unknownCount;
    byRole.set(bucket.role, seat);
  }
  const rank = (role: ModelRole) => { const index = ROLE_ORDER.indexOf(role); return index < 0 ? ROLE_ORDER.length : index; };
  return [...byRole.values()].sort((a, b) => rank(a.role) - rank(b.role) || a.role.localeCompare(b.role));
}

export const formatMinutes = (value: number) => value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');

/** A duration KPI: a number when something is known, `未知` when only unknown records exist, `—` when there is nothing. */
export function durationValue(metric: { minutes: number; knownCount: number; unknownCount: number } | undefined): number | '未知' | '—' {
  if (!metric) return '—';
  if (metric.knownCount > 0) return metric.minutes;
  return metric.unknownCount > 0 ? '未知' : '—';
}

export type KpiKind = 'minutes' | 'duration' | 'count';
export function miniKpis(metrics: RunMetrics | null | undefined): { label: string; value: number | '未知' | '—'; kind: KpiKind }[] {
  return [
    { label: '总模型分钟', value: durationValue(metrics?.modelTime.total), kind: 'minutes' },
    { label: '墙钟时间', value: !metrics ? '—' : metrics.wallClockMinutes === null ? '未知' : metrics.wallClockMinutes, kind: 'duration' },
    { label: '关卡等待', value: durationValue(metrics?.gateWait.total), kind: 'duration' },
    { label: '构建尝试', value: typeof metrics?.buildAttempts === 'number' ? metrics.buildAttempts : '—', kind: 'count' },
  ];
}

/** Metrics read for one version of a run summary. A refetch (刷新, workbench:run-created) that brings a newer updatedAt
 *  re-reads /api/runs/:id/metrics; until then the old numbers stay up, marked stale (never a fresh status beside old numbers). */
export interface MetricsState { id: string; updatedAt: string; data?: RunMetrics; error?: string }
export function metricsStale(metrics: MetricsState | null, run: Pick<RunSummary, 'id' | 'updatedAt'>): boolean {
  return !metrics || metrics.id !== run.id || metrics.updatedAt !== run.updatedAt;
}

const trim1 = (value: number) => value.toFixed(1).replace(/\.0$/, '');
/** [number, unit] for a KPI: minutes stay minutes; wall-clock and gate waits read as 分 / 小时 / 天. */
export function kpiParts(value: number, kind: KpiKind): [string, string] {
  if (kind === 'count') return [String(Math.round(value)), '次'];
  if (kind === 'minutes' || value < 60) return [formatMinutes(value), '分'];
  return value < 1440 ? [trim1(value / 60), '小时'] : [trim1(value / 1440), '天'];
}

export function readSelected(storage: Pick<Storage, 'getItem'> | undefined = typeof sessionStorage === 'undefined' ? undefined : sessionStorage): string | null {
  try { return storage?.getItem(SELECTED_KEY) || null; } catch { return null; }
}

export function writeSelected(id: string | null) {
  try { if (id) sessionStorage.setItem(SELECTED_KEY, id); else sessionStorage.removeItem(SELECTED_KEY); } catch { /* the selection is a convenience */ }
}
