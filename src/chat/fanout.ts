import { z } from 'zod/v4';
import { seatIdSchema } from './roster.js';
import type { AgentTask, TaskStatus } from './types.js';

const modeSchema = z.enum(['read', 'edit', 'verify']);
const goalSchema = z.string().trim().min(1).max(100_000);
const taskInputSchema = z.object({ goal: goalSchema, mode: modeSchema.default('read') }).strict();

export const workerSubmitSchema = z.object({
  pool: seatIdSchema,
  tasks: z.array(taskInputSchema).min(1),
}).strict();

const fanoutItemSchema = z.unknown().refine(value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return typeof text === 'string' && text.length > 0 && Buffer.byteLength(text, 'utf8') <= 50_000;
}, '扇出条目必须可序列化且不超过 50,000 字节');

export const fanoutSubmitSchema = z.object({
  pool: seatIdSchema,
  mode: modeSchema.default('read'),
  template: z.string().trim().min(1).max(50_000),
  items: z.array(fanoutItemSchema).min(1),
  reduce: z.string().trim().min(1).max(20_000).optional(),
}).strict();

export const collectSchema = z.object({
  taskIds: z.array(z.string().min(1)).optional(),
  groupId: z.string().min(1).optional(),
  wait: z.boolean().default(false),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const dispositionSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).optional(),
  groupId: z.string().min(1).optional(),
  disposition: z.enum(['adopted', 'reference', 'rejected']),
}).strict().refine(input => !!input.taskIds || !!input.groupId, '批量处置必须指定 taskIds 或 groupId');

export const workerReportSchema = z.object({
  status: z.enum(['completed', 'blocked', 'failed']),
  summary: z.string().trim().min(1).max(1_200),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(64).default([]),
  changedFiles: z.array(z.string().min(1).max(500)).max(64).default([]),
  deviations: z.array(z.string().min(1).max(500)).max(32).default([]),
  concerns: z.array(z.string().min(1).max(500)).max(32).default([]),
}).strict();

export type WorkerReport = z.infer<typeof workerReportSchema>;
export type FanoutMode = z.infer<typeof modeSchema>;
export interface FanoutGroup {
  id: string;
  parentTaskId: string;
  pool: string;
  mode: FanoutMode;
  total: number;
  createdAt: string;
  reduce?: string;
}

export function parseWorkerReport(value: unknown): WorkerReport {
  const input = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return workerReportSchema.parse(input);
}

export function createFanoutGroup(id: string, parentTaskId: string, value: unknown, createdAt: string): FanoutGroup {
  const input = fanoutSubmitSchema.parse(value);
  return {
    id,
    parentTaskId,
    pool: input.pool,
    mode: input.mode,
    total: input.items.length,
    createdAt,
    ...(input.reduce ? { reduce: input.reduce } : {}),
  };
}

function serializedItem(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Render deterministic item goals. Runtime owns task IDs and durable queue insertion. */
export function fanoutGoals(value: unknown): Array<{ goal: string; mode: FanoutMode; itemIndex: number }> {
  const input = fanoutSubmitSchema.parse(value);
  return input.items.map((item, itemIndex) => {
    const text = serializedItem(item);
    const rendered = input.template.includes('{{item}}')
      ? input.template.replaceAll('{{item}}', text).replaceAll('{{index}}', String(itemIndex + 1))
      : `${input.template}\n\n条目 ${itemIndex + 1}：${text}`;
    return { goal: goalSchema.parse(rendered), mode: input.mode, itemIndex };
  });
}

type Selector = { taskIds?: readonly string[]; groupId?: string };

export function selectChildTasks(tasks: readonly AgentTask[], parentTaskId: string, selector: Selector): AgentTask[] {
  const ids = selector.taskIds ? new Set(selector.taskIds) : undefined;
  return tasks.filter(task => task.parentTaskId === parentTaskId
    && (!ids || ids.has(task.id)) && (!selector.groupId || task.groupId === selector.groupId));
}

const taskStatuses: TaskStatus[] = ['queued', 'running', 'waiting_user', 'waiting_children', 'completed', 'failed', 'cancelled', 'interrupted'];
function boundedUtf8(text: string, bytes: number): string {
  let result = '';
  let used = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (used + size > bytes) break;
    result += point;
    used += size;
  }
  return result;
}

/** Build a byte-bounded mechanical index. Full worker results remain available by ref. */
export function mechanicalCollect(tasks: readonly AgentTask[], parentTaskId: string, raw: unknown) {
  const input = collectSchema.parse(raw);
  const selected = selectChildTasks(tasks, parentTaskId, input);
  const counts = Object.fromEntries(taskStatuses.map(status => [status, selected.filter(task => task.status === status).length])) as Record<TaskStatus, number>;
  const dispositions = Object.fromEntries(['pending', 'adopted', 'reference', 'rejected'].map(disposition => [disposition,
    selected.filter(task => (task.disposition ?? 'pending') === disposition).length])) as Record<'pending' | 'adopted' | 'reference' | 'rejected', number>;
  const page = selected.slice(input.offset, input.offset + input.limit).map(task => {
    let summary = task.error ?? '';
    try { summary = parseWorkerReport(task.result ?? '').summary; } catch { summary ||= task.result ?? ''; }
    return { taskId: task.id, role: task.role, status: task.status, disposition: task.disposition ?? null,
      summary: boundedUtf8(summary, 240), ref: task.resultRef ?? null, errorCode: task.errorCode ?? null };
  });
  const result = () => ({ total: selected.length, counts, dispositions, offset: input.offset,
    next: input.offset + page.length < selected.length ? input.offset + page.length : null, items: page });
  while (page.length > 1 && Buffer.byteLength(JSON.stringify(result()), 'utf8') > 3_700) page.pop();
  return result();
}

export function selectForDisposition(tasks: readonly AgentTask[], parentTaskId: string, raw: unknown): {
  tasks: AgentTask[];
  disposition: AgentTask['disposition'];
} {
  const input = dispositionSchema.parse(raw);
  const selected = selectChildTasks(tasks, parentTaskId, input);
  if (!selected.length) throw new Error('没有匹配的直属子任务');
  if (input.taskIds && selected.length !== new Set(input.taskIds).size) throw new Error('部分子任务不存在或不属于当前父任务');
  return { tasks: selected, disposition: input.disposition };
}
