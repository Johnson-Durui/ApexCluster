import type { ProgressMap, Run, TaskRecord } from '../../../lib/types';
import { taskEntries } from '../live/liveModel';

export function latestAgentTasks(tasks: TaskRecord[]) {
  const latest = new Map<string, TaskRecord>();
  for (const task of [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const slot = `${task.role}|${task.phase}|${task.scope}|${task.jobId ?? ''}|${task.rootTaskId}`;
    latest.set(slot, task);
  }
  return [...latest.values()];
}

export function executionTools(run: Pick<Run, 'tasks'>, progress: ProgressMap) {
  return run.tasks.flatMap(task => taskEntries(task, progress).filter(entry => entry.kind === 'tool').map((entry, index) => ({ id: `${task.id}-${index}`, task, entry })));
}

export function previewKind(path: string, size: number): 'text' | null {
  // 预览只读取小型文本，HTML/SVG 也作为源码显示，不在页面中执行。
  return size <= 512 * 1024 && /\.(md|txt|json|html?|svg|css|[cm]?[jt]sx?|py|ya?ml|toml|csv|log|xml|ini|sh|ps1)$/i.test(path) ? 'text' : null;
}

export interface ToolEvidence { seq: number; type: string; command: string | null; exitCode: number | null; output: string | null; status: string | null; paths: string[] }
export function readToolEvidence(content: string): ToolEvidence[] {
  const data: unknown = JSON.parse(content);
  if (!Array.isArray(data)) throw new Error('服务端工具记录格式不受支持，可在原始文件中查看。');
  return data.filter((value): value is ToolEvidence => Boolean(value && typeof value === 'object' && Number.isSafeInteger(value.seq) && typeof value.type === 'string'))
    .map(value => ({ seq: value.seq, type: value.type, command: typeof value.command === 'string' ? value.command : null, exitCode: typeof value.exitCode === 'number' ? value.exitCode : null, output: typeof value.output === 'string' ? value.output : null, status: typeof value.status === 'string' ? value.status : null, paths: Array.isArray(value.paths) ? value.paths.filter(path => typeof path === 'string') : [] }));
}
