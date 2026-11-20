import { phaseLabels, roleLabel } from '../../../lib/labels';
import type { ProgressEntry, ProgressMap, Run, TaskRecord } from '../../../lib/types';

export interface LiveStage {
  /** 例如 propose-1、propose-2（重新设计后的第二轮） */
  id: string;
  key: string;
  label: string;
  description: string;
  /** 每个执行槽位只保留最新一次尝试 */
  tasks: TaskRecord[];
}

const STAGE_OF: Record<string, string> = {
  clarify: 'clarify', propose: 'propose', review: 'review', recheck: 'recheck', adjudicate: 'adjudicate',
  handbook: 'docs', devdoc: 'docs', prd: 'prd', build: 'build', evaluate: 'evaluate', final_review: 'final_review',
  digest: 'digest', qgroup: 'qgroup',
};

export const STAGE_META: Record<string, { label: string; description: string }> = {
  clarify: { label: '澄清提问', description: '两位模型分别阅读需求快照，提出带选项的澄清问题。' },
  propose: { label: '独立提案', description: 'Claude 与 Astra 各自独立设计 1–3 个方案，彼此看不到对方的内容。' },
  review: { label: '交叉评审', description: '双方匿名评审全部方案，按锚点打分并附依据；推荐结果由程序按冻结规则计算。' },
  recheck: { label: '复核分歧', description: '双方针对所选分歧各自独立重判，不交换结论。' },
  adjudicate: { label: 'Astra Ultra 裁决', description: '只读读取双方方案、评审与复核记录，形成独立建议；不改评分、不自动选择候选、不启动 Sol。' },
  docs: { label: '撰写构建前文档', description: '撰写者并行写《架构说明手册》和《开发文档》；只依据本次运行的材料，不联网、不读写文件。' },
  build: { label: 'Sol 构建 MVP', description: 'Sol 在隔离工作区按确认的规格构建；验收以执行日志为准，不以自报为准。' },
  evaluate: { label: 'Astra 独立评审', description: 'Astra 在绑定当前提交的独立副本中逐项复现，不修改构建工作区。' },
  final_review: { label: 'Claude 终审', description: 'Claude 在全新线程中只读审查已绑定的代码与核验材料，不运行命令。' },
  digest: { label: 'Grok 构建摘要', description: 'Grok 按绑定来源生成带引用的导航摘要；不能替代程序核验。' },
  qgroup: { label: 'Grok 问题分组', description: 'Grok 只提供问题浏览分组，不合并问题，也不修改答案。' },
  prd: { label: '撰写 PRD', description: '依据 G4 接受的作业、执行日志和你的人工验收结果撰写 PRD。' },
};

const slotOf = (task: TaskRecord) => `${task.phase}|${task.role}|${task.jobId ?? ''}`;

/** 把任务按阶段分组：连续的同类任务属于同一阶段；同一槽位的重试或修订只保留最新一次。 */
export function groupStages(tasks: TaskRecord[]): LiveStage[] {
  const ordered = tasks.filter(task => STAGE_OF[task.phase]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const stages: LiveStage[] = [];
  const counts: Record<string, number> = {};
  for (const task of ordered) {
    const key = STAGE_OF[task.phase]!;
    const last = stages.at(-1);
    if (last && last.key === key) {
      const index = last.tasks.findIndex(item => slotOf(item) === slotOf(task));
      if (index < 0) last.tasks.push(task);
      else last.tasks[index] = task;
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
    const meta = STAGE_META[key]!;
    stages.push({ id: `${key}-${counts[key]}`, key, label: counts[key] > 1 ? `${meta.label} · 第 ${counts[key]} 次` : meta.label, description: meta.description, tasks: [task] });
  }
  return stages;
}

export function taskEntries(task: TaskRecord, progress: ProgressMap): ProgressEntry[] {
  const entries = progress[task.id];
  if (entries?.length) return entries;
  return task.lastProgress ? [{ at: task.lastProgressAt ?? task.createdAt, text: task.lastProgress }] : [];
}

const TOKEN_ESTIMATE = /估计已生成\s*(\d+)\s*tokens/;

/** 从进度事件里统计工具调用、接口重试和推理 token 估计（Claude 的 thinking_tokens 事件；非最终用量）。 */
export function liveMetrics(entries: ProgressEntry[]) {
  let tools = 0; let retries = 0; let tokens: number | null = null;
  for (const entry of entries) {
    if (entry.kind === 'tool') tools += 1;
    else if (entry.kind === 'retry') retries += 1;
    const match = TOKEN_ESTIMATE.exec(entry.text);
    if (match) tokens = Number(match[1]);
  }
  return { tools, retries, tokens, events: entries.length };
}

export function taskActor(task: TaskRecord): string {
  if (task.phase === 'adjudicate') return 'Astra Ultra';
  if (task.phase === 'evaluate') return 'Astra · 独立评审';
  if (task.phase === 'final_review') return 'Claude · 终审';
  if (task.phase === 'handbook' || task.phase === 'devdoc' || task.phase === 'prd') return `${roleLabel[task.role]} · 撰写者`;
  return roleLabel[task.role];
}

export function taskTitle(task: TaskRecord, run: Pick<Run, 'jobs'>): string {
  if (task.phase === 'build') {
    const job = run.jobs.find(item => item.id === task.jobId);
    return job ? `作业 ${job.id} · 候选 ${job.candidateId}` : 'MVP 构建';
  }
  if (task.phase === 'evaluate' || task.phase === 'final_review') {
    const job = run.jobs.find(item => item.id === task.jobId);
    return job ? `作业 ${job.id} · ${phaseLabels[task.phase]}` : phaseLabels[task.phase];
  }
  return phaseLabels[task.phase] ?? task.phase;
}

export function requestedSettings(task: TaskRecord, run: Pick<Run, 'models' | 'jobs' | 'docWriter'>): { model: string; effort: string } {
  const configured = run.models[task.role];
  const model = task.meta?.requestedModel || configured?.model || '未记录';
  if (task.meta?.requestedEffort) return { model, effort: task.meta.requestedEffort };
  if (task.phase === 'adjudicate') return { model, effort: 'ultra' };
  if (task.phase === 'handbook' || task.phase === 'devdoc' || task.phase === 'prd') return { model, effort: run.docWriter?.effort ?? configured?.effort ?? '未记录' };
  if (task.phase === 'build') return { model, effort: run.jobs.find(item => item.id === task.jobId)?.effort ?? configured?.effort ?? '未记录' };
  return { model, effort: configured?.effort ?? '未记录' };
}

export function waitingText(task: TaskRecord): string {
  if (task.status === 'queued') return '排队中：等待空闲的执行槽位后启动。';
  if (task.status === 'running') return '已启动，等待第一条进度事件…';
  return '这个任务没有保存实时进度记录。';
}

export function stageWindow(stage: LiveStage, now: number): { startedAt: string | null; elapsedMs: number | null; running: boolean } {
  const started = stage.tasks.map(task => task.startedAt).filter((value): value is string => Boolean(value)).sort();
  const running = stage.tasks.some(task => task.status === 'running' || task.status === 'queued');
  if (!started.length) return { startedAt: null, elapsedMs: null, running };
  const ended = stage.tasks.map(task => task.endedAt).filter((value): value is string => Boolean(value)).sort();
  const end = running ? now : Date.parse(ended.at(-1) ?? started[0]!);
  return { startedAt: started[0]!, elapsedMs: Math.max(0, end - Date.parse(started[0]!)), running };
}
