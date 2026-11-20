import path from 'node:path';
import { z } from 'zod';
import type { FailureClass } from './schemas.js';
import type { JobBudget } from './types.js';
import { budgetBlockReason } from './job-budget.js';

const DigestEntryZ = z.object({ text: z.string(), sourceId: z.string(), quote: z.string() }).strict();
export const DigestOutputZ = z.object({
  specRef: z.string().nullable(),
  workspaceCommit: z.string().nullable(),
  entries: z.array(DigestEntryZ),
}).strict();

const QuestionGroupZ = z.object({ label: z.string(), questionIds: z.array(z.string()) }).strict();
export const QgroupOutputZ = z.object({
  snapshotRef: z.string(),
  groups: z.array(QuestionGroupZ),
}).strict();

export type DigestOutput = z.infer<typeof DigestOutputZ>;
export type QgroupOutput = z.infer<typeof QgroupOutputZ>;

export interface ChoreSource {
  id: string;
  text: string;
  specRef: string | null;
  workspaceCommit: string | null;
  taskId: string;
  logRange: { from: number; to: number } | null;
}

export interface ChoreCheckResult {
  ok: boolean;
  errors: string[];
  validation: 'source_exact_semantics_unverified' | 'question_ids_exact';
}

export function checkDigest(
  output: DigestOutput,
  context: { specRef: string | null; workspaceCommit: string | null; sources: ChoreSource[] },
): ChoreCheckResult {
  const errors: string[] = [];
  if (output.specRef !== context.specRef) errors.push(`specRef 不匹配：期望 ${context.specRef ?? 'null'}`);
  if (output.workspaceCommit !== context.workspaceCommit) errors.push(`workspaceCommit 不匹配：期望 ${context.workspaceCommit ?? 'null'}`);

  const sources = new Map<string, ChoreSource>();
  for (const source of context.sources) {
    if (!source.id || sources.has(source.id)) errors.push(`来源编号不唯一：${source.id || '<empty>'}`);
    else sources.set(source.id, source);
  }

  for (const [index, entry] of output.entries.entries()) {
    const label = `entries[${index}]`;
    if (!entry.text.trim()) errors.push(`${label}.text 不能为空`);
    if (!entry.quote.trim()) errors.push(`${label}.quote 不能为空或纯空白`);
    const source = sources.get(entry.sourceId);
    if (!source) {
      errors.push(`${label}.sourceId 未知：${entry.sourceId}`);
      continue;
    }
    if (source.specRef !== context.specRef || source.workspaceCommit !== context.workspaceCommit) {
      errors.push(`${label}.sourceId 指向不同锚点的来源：${entry.sourceId}`);
      continue;
    }
    if (entry.quote && !source.text.includes(entry.quote)) errors.push(`${label}.quote 不是来源 ${entry.sourceId} 的逐字子串`);
  }

  return { ok: errors.length === 0, errors, validation: 'source_exact_semantics_unverified' };
}

export function checkQgroup(
  output: QgroupOutput,
  context: { snapshotRef: string; questionIds: string[] },
): ChoreCheckResult {
  const errors: string[] = [];
  if (output.snapshotRef !== context.snapshotRef) errors.push(`snapshotRef 不匹配：期望 ${context.snapshotRef}`);
  const expected = new Set(context.questionIds);
  if (expected.size !== context.questionIds.length) errors.push('输入问题编号不唯一，无法安全分组');

  const counts = new Map<string, number>();
  for (const [groupIndex, group] of output.groups.entries()) {
    if (!group.label.trim()) errors.push(`groups[${groupIndex}].label 不能为空`);
    for (const questionId of group.questionIds) counts.set(questionId, (counts.get(questionId) ?? 0) + 1);
  }
  for (const questionId of expected) {
    const count = counts.get(questionId) ?? 0;
    if (count === 0) errors.push(`遗漏问题：${questionId}`);
    else if (count > 1) errors.push(`问题重复分组：${questionId}`);
  }
  for (const questionId of counts.keys()) {
    if (!expected.has(questionId)) errors.push(`新增了未知问题：${questionId}`);
  }
  return { ok: errors.length === 0, errors, validation: 'question_ids_exact' };
}

export interface LightReworkDefect {
  id: string;
  severity: 'minor' | 'major' | 'critical';
  location: string;
  fix: string;
  failureClass: FailureClass;
  specRef: string;
  workspaceCommit: string;
  round: number;
}

export interface LightReworkInput {
  enabled: boolean;
  capabilities: {
    verifiedAt: string | null;
    cliVersion: string | null;
    model: string | null;
    commandExitEventsVerified?: boolean;
    toolPolicy?: 'workspace_edits_only' | null;
    terminationVerified?: boolean;
    fileChangesVerified: boolean;
    workspaceWriteVerified: boolean;
    isolatedWorkspaceVerified: boolean;
  } | null;
  expectedCliVersion: string;
  expectedModel: 'grok-4.7-high-fast';
  specRef: string;
  workspaceCommit: string;
  round: number;
  defects: LightReworkDefect[];
  verifiedDefectIds: string[];
  used: number;
  lastWriter: string | null;
  budget: JobBudget;
  now: string;
  reserveFinalReview: boolean;
  frozenCapabilityRef: string | null;
  currentCapabilityRef: string | null;
}

export interface LightReworkDecision {
  allowed: boolean;
  reason: string;
}

export function safeLightReworkDefectPath(location: string): string | null {
  const trimmed = location.trim();
  if (!trimmed || trimmed.includes('\0') || path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || /^[\\/~]/.test(trimmed)) return null;
  const withoutLine = trimmed.replace(/:\d+(?::\d+)?$/, '');
  if (withoutLine.includes(':')) return null;
  const segments = withoutLine.replace(/\\/g, '/').split('/');
  if (!withoutLine || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

export function canRouteLightRework(input: LightReworkInput): LightReworkDecision {
  const deny = (reason: string): LightReworkDecision => ({ allowed: false, reason });
  if (!input.enabled) return deny('轻量返工未显式启用');
  if (!input.frozenCapabilityRef?.trim() || !input.currentCapabilityRef?.trim() || input.frozenCapabilityRef !== input.currentCapabilityRef) {
    return deny('轻量返工冻结能力引用与当前能力不一致');
  }
  if (!input.capabilities) return deny('缺少受信任的 Cursor H7 写入能力记录');
  if (!input.capabilities.verifiedAt || !Number.isFinite(Date.parse(input.capabilities.verifiedAt))) return deny('H7 写入能力记录缺少有效 verifiedAt');
  if (!input.capabilities.cliVersion || input.capabilities.cliVersion !== input.expectedCliVersion) return deny('H7 写入能力记录与当前 Cursor CLI 版本不一致');
  if (!input.capabilities.model || input.capabilities.model !== input.expectedModel) return deny('H7 写入能力记录与当前 Grok 型号不一致');
  if (input.capabilities.toolPolicy !== 'workspace_edits_only') return deny('H7 未冻结 workspace_edits_only 工具策略');
  if (input.capabilities.terminationVerified !== true) return deny('H7 未验证进程树完整终止');
  if (!input.capabilities.fileChangesVerified) return deny('H7 未验证文件变更事件');
  if (!input.capabilities.workspaceWriteVerified) return deny('H7 未验证工作区写权限边界');
  if (!input.capabilities.isolatedWorkspaceVerified) return deny('H7 未验证独立安全工作区');
  if (!input.defects.length) return deny('没有可返工的已验证缺陷');
  if (!input.specRef.trim() || !input.workspaceCommit.trim() || !Number.isInteger(input.round) || input.round < 1) return deny('当前返工锚点无效');
  if (input.defects.some((defect) => defect.failureClass !== 'implementation_defect')) return deny('只允许程序确认的 implementation_defect 进入轻量返工');
  if (input.defects.some((defect) => defect.specRef !== input.specRef || defect.workspaceCommit !== input.workspaceCommit || defect.round !== input.round)) {
    return deny('返工缺陷必须绑定当前规格、代码提交与轮次');
  }
  if (input.defects.some((defect) => defect.severity !== 'minor')) return deny('只允许 minor 缺陷进入轻量返工');
  if (input.defects.some((defect) => !defect.id.trim())) return deny('缺陷编号不能为空');
  const defectIds = input.defects.map((defect) => defect.id);
  if (new Set(defectIds).size !== defectIds.length) return deny('缺陷编号必须唯一');
  if (input.defects.some((defect) => !defect.fix.trim())) return deny('每个缺陷必须有非空修复说明');
  const files = input.defects.map((defect) => safeLightReworkDefectPath(defect.location));
  if (files.some((file) => file === null)) return deny('每个缺陷必须有安全的任务相对文件位置');
  if (new Set((files as string[]).map((file) => file.toLowerCase())).size > 5) return deny('轻量返工最多涉及 5 个不同文件');

  const verified = new Set(input.verifiedDefectIds);
  if (verified.size !== input.verifiedDefectIds.length || verified.size !== defectIds.length || defectIds.some((id) => !verified.has(id))) {
    return deny('返工缺陷必须与程序确认的 verifiedDefectIds 精确一致');
  }
  if (input.used !== 0) return deny('每个作业最多一次轻量返工');
  if (input.lastWriter === 'grok') return deny('Grok 不能连续担任写者');

  let budgetReason: string | null;
  try {
    budgetReason = budgetBlockReason(input.budget, {
      writer: true,
      newRound: true,
      reserveFinalReview: input.reserveFinalReview,
      now: input.now,
    });
  } catch (error) {
    return deny(`共享预算记录无效：${(error as Error).message}`);
  }
  if (budgetReason) return deny(budgetReason);
  return { allowed: true, reason: '所有轻量返工前提已通过；仍需由调用方在共享预算中原子预留调用与新轮次' };
}
