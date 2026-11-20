import { STATUS_GLYPH, type StatusKind } from '../../../components/ui';
import { duration, phaseLabels, roleLabel, statusLabel } from '../../../lib/labels';
import { useNow } from '../../../lib/useNow';
import type { ModelRole, Run, TaskRecord } from '../../../lib/types';

const roles: ModelRole[] = ['claude', 'astra', 'sol', 'grok'];

export function latestTaskByRole(run: Pick<Run, 'tasks'>): Record<ModelRole, TaskRecord | undefined> {
  return Object.fromEntries(roles.map(role => [role, [...run.tasks].reverse().find(task => task.role === role)])) as Record<ModelRole, TaskRecord | undefined>;
}

export function elapsedMs(task: TaskRecord, now: number): number | null {
  if (task.meta?.durationMs !== undefined && task.endedAt) return task.meta.durationMs;
  if (!task.startedAt) return null;
  const end = task.endedAt ? Date.parse(task.endedAt) : now;
  const value = end - Date.parse(task.startedAt);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

/** Task status → Status kind (glyph + colour; the detail text carries the word). */
function statusKind(task: TaskRecord | undefined): StatusKind {
  if (!task) return 'idle';
  if (task.status === 'running') return 'run';
  if (task.status === 'queued') return 'queue';
  if (task.status === 'succeeded') return 'ok';
  if (task.status === 'cancelled') return 'stop';
  if (task.status === 'failed' || task.status === 'timed_out' || task.status === 'interrupted') return 'err';
  return 'idle';
}

/**
 * 运行页顶部的执行端状态：每位一枚带 3px 席位色左线的芯片。点击进入“执行过程”。
 * `now` is optional: without it the strip ticks its own clock (leaf), only while a task runs.
 */
export default function ModelStatusStrip({ run, now, onOpen }: { run: Run; now?: number; onOpen?: () => void }) {
  const tick = useNow(now === undefined && run.tasks.some(task => task.status === 'running'));
  const current = now ?? tick;
  const latest = latestTaskByRole(run);
  const visibleRoles = roles.filter(role => role !== 'grok' || run.models.grok || latest.grok);
  return <ul className="model-strip" aria-label="模型任务状态">{visibleRoles.map(role => {
    const task = latest[role];
    const ultra = task?.phase === 'adjudicate';
    const name = ultra ? 'Astra Ultra' : roleLabel[role];
    const elapsed = task ? elapsedMs(task, current) : null;
    const configured = run.models[role];
    const detail = !task ? `尚未启动 · ${configured?.model ?? '未记录配置'}`
      : task.status === 'running' ? `${phaseLabels[task.phase] ?? task.phase} · 进行中${elapsed !== null ? ` ${duration(elapsed)}` : ''}`
        : `${phaseLabels[task.phase] ?? task.phase} · ${statusLabel(task.status)}`;
    const kind = statusKind(task);
    return <li key={role}><button type="button" className={`ms ${task?.status ?? 'idle'}${ultra ? ' ultra' : ''}`} data-seat={role} onClick={onOpen} disabled={!onOpen} aria-label={`${name}：${detail}${onOpen ? '，查看执行过程' : ''}`}>
      <b>{name}</b>
      <span className={`st ${kind}`} aria-hidden="true"><i>{STATUS_GLYPH[kind]}</i></span>
      <small>{detail}</small>
      {task?.status === 'running' ? <span className="ms-live" aria-hidden="true" /> : null}
    </button></li>;
  })}</ul>;
}
