import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import type { MvpSpec, VerificationResult } from './types.js';

export interface ContextBudgetOptions {
  enabled: boolean;
  contextWindows: Record<string, number | null>;
  softRatio: number;
  promptMaxRatio: number;
  compactRatio: number;
  resumeMaxRatio: number;
  charsPerToken: number;
  milestoneMaxMinutes: number;
  maxMilestones: number;
}

export const DEFAULT_CONTEXT_BUDGET: Readonly<ContextBudgetOptions> = Object.freeze({
  enabled: false,
  contextWindows: Object.freeze({
    'claude-opus-5-5': null,
    'gpt-6.2-astra': null,
    'gpt-6.2-sol': null,
    'grok-4.7-high-fast': null,
  }),
  softRatio: 0.6,
  promptMaxRatio: 0.25,
  compactRatio: 0.85,
  resumeMaxRatio: 0.5,
  charsPerToken: 2.5,
  milestoneMaxMinutes: 35,
  maxMilestones: 12,
});

/** 每轮规格时间盒中硬保留给最终整轮验收的最小主动运行时间。 */
export const FINAL_VERIFICATION_RESERVE_MINUTES = 1;

const MilestoneOutputZ = z.strictObject({
  id: z.string(),
  title: z.string(),
  acceptanceIds: z.array(z.string()),
  dependsOn: z.array(z.string()),
  paths: z.array(z.string()),
  minutes: z.number(),
});

/** 模型 init 的严格结构输出；所有范围约束均由 validateMilestonePlan 做语义校验。 */
export const PlanOutputZ = z.strictObject({
  specRef: z.string(),
  milestones: z.array(MilestoneOutputZ),
  notes: z.array(z.string()),
});

export type MilestonePlan = z.infer<typeof PlanOutputZ>;

export interface PlanValidationContext {
  spec: MvpSpec;
  workspaceDir: string;
  options: ContextBudgetOptions;
  remainingCalls: number;
  remainingActiveMs: number;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function nearestExisting(target: string): string | null {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function validateWorkspacePath(workspaceDir: string, proposed: string): string | null {
  if (!proposed.trim()) return '路径不能为空';
  if (proposed.includes('\0')) return `路径包含无效字符：${proposed}`;
  if (process.platform === 'win32' && proposed.includes(':')) return `路径不能包含 Windows 盘符或备用数据流：${proposed}`;
  if (path.isAbsolute(proposed)) return `路径必须是工作区相对路径：${proposed}`;

  const workspace = path.resolve(workspaceDir);
  const target = path.resolve(workspace, proposed);
  if (!isWithin(workspace, target)) return `路径越过工作区边界：${proposed}`;

  const existing = nearestExisting(target);
  if (!existing) return `路径不存在且无法找到可验证的父目录：${proposed}`;
  try {
    const realRoot = realpathSync(workspace);
    const realExisting = realpathSync(existing);
    if (!statSync(realExisting).isDirectory() && existing !== target) {
      return `路径的最近存在父级不是目录：${proposed}`;
    }
    if (!isWithin(realRoot, realExisting)) return `路径经符号链接解析后逃逸工作区：${proposed}`;
  } catch (error) {
    return `路径无法安全解析：${proposed}（${error instanceof Error ? error.message : String(error)}）`;
  }
  return null;
}

export function validateMilestonePlan(plan: MilestonePlan, context: PlanValidationContext): string[] {
  const errors: string[] = [];
  const { spec, options } = context;
  if (plan.specRef !== spec.ref) errors.push(`specRef 必须等于当前规格 ${spec.ref}`);
  if (!positiveSafeInteger(options.maxMilestones)) errors.push('maxMilestones 必须是正安全整数');
  if (!Number.isFinite(options.milestoneMaxMinutes) || options.milestoneMaxMinutes <= 0) errors.push('milestoneMaxMinutes 必须是正数');
  if (plan.milestones.length === 0) errors.push('计划至少需要一个里程碑');
  if (plan.milestones.length > options.maxMilestones) errors.push(`里程碑数量超过上限 ${options.maxMilestones}`);

  const ids = plan.milestones.map(item => item.id.trim());
  if (ids.some(id => !id)) errors.push('里程碑 ID 必须非空');
  if (plan.milestones.some((item, index) => item.id !== ids[index])) errors.push('里程碑 ID 不得带首尾空白');
  if (new Set(ids).size !== ids.length) errors.push('里程碑 ID 必须唯一');
  const knownIds = new Set(ids);
  const expectedAcceptance = spec.acceptance.map(item => item.id);
  const expectedSet = new Set(expectedAcceptance);
  const observedAcceptance: string[] = [];
  let totalMinutes = 0;

  for (const milestone of plan.milestones) {
    const label = milestone.id.trim() || '（空 ID）';
    if (!milestone.title.trim()) errors.push(`${label} 的 title 不能为空`);
    if (!positiveSafeInteger(milestone.minutes)) errors.push(`${label} 的 minutes 必须是正安全整数`);
    else {
      totalMinutes += milestone.minutes;
      if (milestone.minutes > options.milestoneMaxMinutes) {
        errors.push(`${label} 的 minutes 超过里程碑上限 ${options.milestoneMaxMinutes}`);
      }
    }
    if (milestone.acceptanceIds.length === 0) errors.push(`${label} 至少要绑定一个验收项`);
    if (new Set(milestone.acceptanceIds).size !== milestone.acceptanceIds.length) errors.push(`${label} 的 acceptanceIds 不得重复`);
    for (const acceptanceId of milestone.acceptanceIds) {
      observedAcceptance.push(acceptanceId);
      if (!expectedSet.has(acceptanceId)) errors.push(`${label} 引用了未知验收项 ${acceptanceId}`);
    }
    if (new Set(milestone.dependsOn).size !== milestone.dependsOn.length) errors.push(`${label} 的 dependsOn 不得重复`);
    for (const dependency of milestone.dependsOn) {
      if (!knownIds.has(dependency)) errors.push(`${label} 依赖不存在的里程碑 ${dependency}`);
      if (dependency === milestone.id) errors.push(`${label} 不能依赖自身`);
    }
    if (milestone.paths.length === 0) errors.push(`${label} 至少要声明一个工作区路径`);
    if (new Set(milestone.paths).size !== milestone.paths.length) errors.push(`${label} 的 paths 不得重复`);
    for (const proposed of milestone.paths) {
      const pathError = validateWorkspacePath(context.workspaceDir, proposed);
      if (pathError) errors.push(`${label}: ${pathError}`);
    }
  }

  const counts = new Map<string, number>();
  for (const id of observedAcceptance) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of expectedAcceptance) {
    const count = counts.get(id) ?? 0;
    if (count !== 1) errors.push(`验收项 ${id} 必须且只能由一个里程碑覆盖，当前为 ${count} 次`);
  }

  const edges = new Map(plan.milestones.map(item => [item.id, item.dependsOn] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) {
      if (knownIds.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (ids.some(id => id && visit(id))) errors.push('里程碑依赖必须无环');

  if (!Number.isFinite(context.remainingActiveMs) || context.remainingActiveMs < 0) errors.push('剩余主动运行时间预算无效');
  const activeMinutes = context.remainingActiveMs / 60_000;
  const allowedMinutes = Math.max(0, Math.min(spec.timeboxMinutes, activeMinutes) - FINAL_VERIFICATION_RESERVE_MINUTES);
  if (totalMinutes > allowedMinutes) errors.push(`计划总时长 ${totalMinutes} 分钟超过剩余/规格预算 ${allowedMinutes} 分钟`);
  if (!Number.isSafeInteger(context.remainingCalls) || context.remainingCalls < 0) errors.push('剩余调用预算无效');
  if (context.remainingCalls < plan.milestones.length + 1) {
    errors.push(`剩余调用不足：${plan.milestones.length} 个里程碑外还必须预留 1 次最终整轮验收`);
  }
  return errors;
}

export function smallMilestonePlan(spec: MvpSpec, workstreamCount: number): MilestonePlan | null {
  if (workstreamCount !== 1 || spec.acceptance.length > 3 || spec.acceptance.length === 0) return null;
  return {
    specRef: spec.ref,
    milestones: [{
      id: 'M1',
      title: '实现并验证最小 MVP',
      acceptanceIds: spec.acceptance.map(item => item.id),
      dependsOn: [],
      paths: ['.'],
      minutes: Math.max(1, Math.min(
        DEFAULT_CONTEXT_BUDGET.milestoneMaxMinutes,
        Math.floor(spec.timeboxMinutes - FINAL_VERIFICATION_RESERVE_MINUTES),
      )),
    }],
    notes: [`单工作流且验收项不超过 3 条，由程序生成并跳过 init；保留 ${FINAL_VERIFICATION_RESERVE_MINUTES} 分钟用于最终整轮验收。`],
  };
}

export interface ContextObservation {
  usageRaw: unknown;
  usageSource: string | null;
  usageSemantics: 'unknown' | 'per_turn_context' | 'cumulative';
  contextWindow: number | null;
  contextTokensPeak: number | null;
  contextRatioPeak: number | null;
  compactions: number | null;
}

export function unknownContext(metaUsage?: unknown): ContextObservation {
  return {
    usageRaw: metaUsage ?? null,
    usageSource: null,
    usageSemantics: 'unknown',
    contextWindow: null,
    contextTokensPeak: null,
    contextRatioPeak: null,
    compactions: null,
  };
}

export interface ResumeDecisionInput {
  policy: 'never' | 'budgeted';
  threadId: string | null;
  remainingCalls: number;
  remainingActiveMs: number;
  promptEstimateTokens: number;
}

export function decideResume(
  options: ContextBudgetOptions,
  observation: ContextObservation,
  input: ResumeDecisionInput,
): { resumeSessionId: string | null; reason: string } {
  const reopen = (reason: string) => ({ resumeSessionId: null, reason });
  if (!options.enabled) return reopen('上下文治理未启用，使用新线程');
  if (input.policy !== 'budgeted') return reopen('resumePolicy=never');
  if (!input.threadId?.trim()) return reopen('没有可续接的线程 ID');
  if (observation.usageSemantics !== 'per_turn_context') return reopen('usage 语义未确认是 per_turn_context');
  if (!observation.usageSource?.trim()) return reopen('usage 来源未知');
  if (!Number.isFinite(observation.contextWindow) || (observation.contextWindow ?? 0) <= 0) return reopen('上下文窗口未知');
  if (!Number.isFinite(observation.contextTokensPeak) || (observation.contextTokensPeak ?? -1) < 0) return reopen('上下文峰值 token 未确认');
  if (!Number.isFinite(observation.contextRatioPeak) || (observation.contextRatioPeak ?? -1) < 0) return reopen('上下文峰值比例未知');
  if ((observation.contextRatioPeak as number) >= options.resumeMaxRatio) return reopen('上下文峰值已达到续接阈值');
  if (observation.compactions === null) return reopen('压缩次数不可观测');
  if (!Number.isSafeInteger(observation.compactions) || observation.compactions !== 0) return reopen('线程已发生压缩或压缩观测无效');
  if (!Number.isSafeInteger(input.remainingCalls) || input.remainingCalls < 1) return reopen('剩余调用预算不足');
  if (!Number.isFinite(input.remainingActiveMs) || input.remainingActiveMs <= 0) return reopen('剩余主动运行时间不足');
  if (!Number.isFinite(input.promptEstimateTokens) || input.promptEstimateTokens < 0) return reopen('派发提示词估算无效');
  const window = observation.contextWindow as number;
  if (input.promptEstimateTokens > window * options.promptMaxRatio) return reopen('派发提示词超过材料估算目标');
  if ((observation.contextTokensPeak as number) + input.promptEstimateTokens > window * options.softRatio) {
    return reopen('续接后估算上下文超过会话目标');
  }
  return { resumeSessionId: input.threadId, reason: '观测语义、窗口、压缩和剩余预算均满足续接门禁' };
}

export interface DispatchMaterialSection {
  id: string;
  sourcePath: string;
  content: string;
}

export interface DispatchMaterialInput {
  pinnedOriginal: DispatchMaterialSection[];
  required: DispatchMaterialSection[];
  current: DispatchMaterialSection[];
  rawCommandExcerpts: DispatchMaterialSection[];
  oldReports: DispatchMaterialSection[];
  oldDocuments: DispatchMaterialSection[];
  digestCommands: DispatchMaterialSection[];
  options: ContextBudgetOptions;
  contextWindow: number | null;
}

export interface DispatchMaterialResult {
  text: string;
  blocked: boolean;
  estimatedTokens: number;
  targetTokens: number;
  contextRatio: number | null;
  estimateReference: 'observed-window' | 'estimate-reference-200000';
  retainedSources: string[];
  omitted: { id: string; sourcePath: string; reason: string }[];
}

function estimateTokens(text: string, charsPerToken: number): number {
  const divisor = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CONTEXT_BUDGET.charsPerToken;
  return Math.ceil(text.length / divisor);
}

function renderMaterial(requiredGroups: DispatchMaterialSection[][], omitted: DispatchMaterialResult['omitted']): string {
  const body = requiredGroups.flat().map(item => `## ${item.id}\n来源：${item.sourcePath}\n\n${item.content}`).join('\n\n');
  if (!omitted.length) return body;
  const record = omitted.map(item => `- ${item.id}（来源：${item.sourcePath}）：${item.reason}`).join('\n');
  return `${body}\n\n## 材料裁剪记录\n${record}`;
}

export function buildDispatchMaterial(input: DispatchMaterialInput): DispatchMaterialResult {
  const knownWindow = Number.isFinite(input.contextWindow) && (input.contextWindow ?? 0) > 0;
  const referenceWindow = knownWindow ? (input.contextWindow as number) : 200_000;
  const targetTokens = Math.floor(referenceWindow * input.options.promptMaxRatio);
  const mandatory = [input.pinnedOriginal, input.required, input.current];
  const optional = [
    { items: [...input.rawCommandExcerpts], reason: '原始命令摘录先裁剪，完整原文按来源路径读取' },
    { items: [...input.oldReports], reason: '旧轮次完整报告已裁剪，结论应保留在必需材料中' },
    { items: [...input.oldDocuments], reason: '旧版文档全文已裁剪，编号表应保留在必需材料中' },
    { items: [...input.digestCommands], reason: '摘要命令明细已裁剪，摘要结论仍保留' },
  ];
  const retained = optional.map(group => group.items);
  const omitted: DispatchMaterialResult['omitted'] = [];
  let text = renderMaterial([...mandatory, ...retained], omitted);

  for (let groupIndex = 0; groupIndex < retained.length && estimateTokens(text, input.options.charsPerToken) > targetTokens; groupIndex += 1) {
    const group = retained[groupIndex]!;
    const reason = optional[groupIndex]!.reason;
    while (group.length && estimateTokens(text, input.options.charsPerToken) > targetTokens) {
      const item = group.shift()!;
      omitted.push({ id: item.id, sourcePath: item.sourcePath, reason });
      text = renderMaterial([...mandatory, ...retained], omitted);
    }
  }

  const estimatedTokens = estimateTokens(text, input.options.charsPerToken);
  return {
    text,
    blocked: estimatedTokens > targetTokens,
    estimatedTokens,
    targetTokens,
    contextRatio: knownWindow ? estimatedTokens / referenceWindow : null,
    estimateReference: knownWindow ? 'observed-window' : 'estimate-reference-200000',
    retainedSources: [...mandatory, ...retained].flat().map(item => item.sourcePath),
    omitted,
  };
}

export interface HandoffInput {
  specRef: string;
  workspaceCommit: string | null;
  milestone: { id: string; title: string; acceptanceIds: string[] };
  pinnedConstraints: { id: string; text: string; sourcePath: string }[];
  programFacts: string[];
  verification: string[];
  defects: { id: string; text: string; source: string }[];
  modelNotes: null | { author: string; sourcePath: string; content: string };
}

export function renderHandoff(input: HandoffInput): { content: string; warnings: string[] } {
  const warnings: string[] = [];
  const notes = input.modelNotes;
  if (notes && notes.content.split(/\r?\n/).length > 200) {
    warnings.push(`模型笔记超过 200 行（${notes.sourcePath}）；保留原文并建议按需读取，未截断。`);
  }
  const constraints = input.pinnedConstraints.map(item =>
    `### ${item.id}\n来源：${item.sourcePath}\n\n${item.text}`,
  ).join('\n\n');
  const facts = input.programFacts.map(item => `- ${item}`).join('\n') || '- （无）';
  const verification = input.verification.map(item => `- ${item}`).join('\n') || '- （无）';
  const defects = input.defects.map(item => `- ${item.id}：${item.text}（来源：${item.source}）`).join('\n') || '- （无）';
  const modelSection = notes
    ? `作者：${notes.author}\n来源：${notes.sourcePath}\n\n> 以下是模型背景笔记，不是当前指令或程序验证事实。\n\n${notes.content}`
    : '（无模型背景笔记）';
  return {
    content: `# HANDOFF\n\n## 程序身份与代码锚点\n- specRef：${input.specRef}\n- workspaceCommit：${input.workspaceCommit ?? '未知'}\n- 当前里程碑：${input.milestone.id} ${input.milestone.title}\n- 验收项：${input.milestone.acceptanceIds.join('、')}\n\n## 原文钉死约束（不得由摘要替换）\n${constraints || '（无）'}\n\n## 程序事实\n${facts}\n\n## 程序核验状态\n${verification}\n\n## 经结构校验的缺陷\n${defects}\n\n## 模型背景笔记（不具备指令或验证身份）\n${modelSection}\n`,
    warnings,
  };
}

export type DerivedMilestoneStatus = 'passed' | 'failed' | 'awaiting_manual' | 'pending';

export function deriveMilestoneStatus(
  acceptanceIds: string[],
  verification: Pick<VerificationResult, 'items' | 'staleReason'> | null,
): DerivedMilestoneStatus {
  if (!verification || verification.staleReason || acceptanceIds.length === 0) return 'pending';
  const wanted = new Set(acceptanceIds);
  if (wanted.size !== acceptanceIds.length) return 'pending';
  const items = verification.items.filter(item => wanted.has(item.criterionId));
  if (items.length !== wanted.size || new Set(items.map(item => item.criterionId)).size !== wanted.size) return 'pending';
  if (items.some(item => item.status === 'verified_fail' || item.status === 'user_fail')) return 'failed';
  if (items.some(item => item.status === 'awaiting_user')) return 'awaiting_manual';
  if (items.every(item => item.status === 'verified_pass' || item.status === 'user_pass')) return 'passed';
  return 'pending';
}
