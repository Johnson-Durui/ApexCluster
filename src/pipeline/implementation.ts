import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { HttpError } from '../orchestrator/errors.js';
import type { FrozenContract } from './contract.js';
import type {
  ImplementationPlan,
  ImplementationState,
  MilestoneDefinition,
  MilestoneProof,
  MilestoneOwner,
  PipelineReview,
  ReviewDefect,
} from './implementation-types.js';
import type { WorkspaceChanges } from '../chat/workspace.js';

const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const ACCEPTANCE_ID = /^AC-\d{3}$/;
const activeStatuses = new Set(['authoring', 'reviewing', 'integrating', 'verifying']);
const protectedDirectories = ['.agent', 'agent-outputs'];
const protectedFiles = ['docs/PRD.md', 'docs/ARCHITECTURE.md', 'docs/DEV_GUIDE.md', 'docs/CONTRACT.json'];

const unique = (values: readonly string[]) => new Set(values).size === values.length;
const sortUnique = (values: readonly string[]) => [...new Set(values)].sort();

function validPath(value: string): boolean {
  if (value === '.') return true;
  if (!value || value !== value.trim() || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes(':') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f]/u.test(part));
}

function pathCovers(declared: string, changed: string): boolean {
  return declared === '.' || changed === declared || changed.startsWith(`${declared}/`);
}

function validMilestonePath(value: string): boolean {
  if (!validPath(value)) return false;
  const comparable = value.toLowerCase();
  if (protectedDirectories.some(path => pathCovers(comparable, path) || pathCovers(path, comparable))) return false;
  return !protectedFiles.some(path => pathCovers(comparable, path.toLowerCase()) || pathCovers(path.toLowerCase(), comparable));
}

const checkSchema = z.object({
  id: z.string().regex(ID),
  acceptanceIds: z.array(z.string().regex(ACCEPTANCE_ID)).min(1).max(1_000),
  argv: z.array(z.string().min(1).max(20_000)).min(1).max(100),
  cwd: z.string().max(2_000).refine(validPath, 'cwd 必须是规范的工作区相对路径'),
  timeoutMs: z.number().int().min(100).max(3_600_000),
}).strict();

const milestoneSchema = z.object({
  id: z.string().regex(ID),
  title: z.string().trim().min(1).max(500),
  owner: z.enum(['sol', 'opus']),
  acceptanceIds: z.array(z.string().regex(ACCEPTANCE_ID)).min(1).max(1_000),
  dependsOn: z.array(z.string().regex(ID)).max(32),
  paths: z.array(z.string().max(2_000).refine(validMilestonePath, 'path 必须是规范且非保留的工作区相对路径')).min(1).max(200),
  checks: z.array(checkSchema).min(1).max(100),
}).strict();

/** Strict model payload for impl_plan_submit. Contract identity is supplied by the host. */
export const implementationPlanSchema = z.object({
  milestones: z.array(milestoneSchema).min(1).max(32),
}).strict();

/** An author can refine only the checks of their own milestone before writing. */
export const milestoneRefinementSchema = z.object({
  milestoneId: z.string().regex(ID),
  checks: z.array(checkSchema).min(1).max(100),
}).strict();

const defectSchema = z.object({
  id: z.string().regex(ID),
  description: z.string().trim().min(1).max(4_000),
  acceptanceIds: z.array(z.string().regex(ACCEPTANCE_ID)).max(1_000),
}).strict();

/** Strict model payload shared by plan and milestone review_submit. */
export const pipelineReviewSchema = z.object({
  subjectHash: z.string().regex(HASH),
  outcome: z.enum(['passed', 'failed']),
  defects: z.array(defectSchema).max(200),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'passed' && value.defects.length) context.addIssue({ code: 'custom', path: ['defects'], message: '通过评审不能包含未解决缺陷' });
  if (value.outcome === 'failed' && !value.defects.length) context.addIssue({ code: 'custom', path: ['defects'], message: '未通过评审必须给出编号缺陷' });
});

function canonicalPlan(plan: ImplementationPlan): ImplementationPlan {
  return {
    version: 1,
    contractHash: plan.contractHash.toLowerCase(),
    milestones: plan.milestones.map(milestone => ({
      ...milestone,
      acceptanceIds: sortUnique(milestone.acceptanceIds),
      dependsOn: sortUnique(milestone.dependsOn),
      paths: sortUnique(milestone.paths),
      checks: milestone.checks.map(check => ({ ...check, acceptanceIds: sortUnique(check.acceptanceIds) }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function canonicalText(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Validate and canonicalize a complete implementation plan against the frozen contract. */
export function validateImplementationPlan(raw: unknown, frozenContract: FrozenContract, contractHash: string): {
  plan: ImplementationPlan;
  hash: string;
  text: string;
} {
  const input = implementationPlanSchema.parse(raw);
  if (!HASH.test(contractHash) || frozenContract.sha256 !== contractHash) {
    throw new HttpError(409, '实现计划绑定的冻结契约哈希不一致');
  }
  const plan: ImplementationPlan = { version: 1, contractHash, milestones: input.milestones };
  const issues: string[] = [];
  const milestoneIds = plan.milestones.map(item => item.id);
  if (!unique(milestoneIds)) issues.push('里程碑 ID 必须唯一');
  if (!plan.milestones.some(item => item.owner === 'sol') || !plan.milestones.some(item => item.owner === 'opus')) {
    issues.push('计划必须同时包含 Sol 和 Opus 负责的里程碑');
  }
  const knownMilestones = new Set(milestoneIds);
  const expectedAcceptance = frozenContract.acceptance.map(item => item.id);
  const expectedSet = new Set(expectedAcceptance);
  const acceptanceCounts = new Map<string, number>();
  const checkIds = new Set<string>();
  for (const milestone of plan.milestones) {
    if (!unique(milestone.acceptanceIds)) issues.push(`${milestone.id} 的 acceptanceIds 不得重复`);
    if (!unique(milestone.dependsOn)) issues.push(`${milestone.id} 的 dependsOn 不得重复`);
    if (!unique(milestone.paths)) issues.push(`${milestone.id} 的 paths 不得重复`);
    if (!unique(milestone.checks.map(check => check.id))) issues.push(`${milestone.id} 的检查 ID 不得重复`);
    for (const dependency of milestone.dependsOn) {
      if (!knownMilestones.has(dependency)) issues.push(`${milestone.id} 依赖不存在的里程碑 ${dependency}`);
      if (dependency === milestone.id) issues.push(`${milestone.id} 不能依赖自身`);
    }
    for (const acceptanceId of milestone.acceptanceIds) {
      acceptanceCounts.set(acceptanceId, (acceptanceCounts.get(acceptanceId) ?? 0) + 1);
      if (!expectedSet.has(acceptanceId)) issues.push(`${milestone.id} 引用了未知验收条目 ${acceptanceId}`);
    }
    const milestoneAcceptance = new Set(milestone.acceptanceIds);
    const checked = new Set<string>();
    for (const check of milestone.checks) {
      if (checkIds.has(check.id)) issues.push(`检查 ID ${check.id} 必须在整个计划内唯一`);
      checkIds.add(check.id);
      if (!unique(check.acceptanceIds)) issues.push(`${milestone.id}/${check.id} 的 acceptanceIds 不得重复`);
      for (const acceptanceId of check.acceptanceIds) {
        if (!milestoneAcceptance.has(acceptanceId)) issues.push(`${milestone.id}/${check.id} 引用了本里程碑之外的验收条目 ${acceptanceId}`);
        checked.add(acceptanceId);
      }
    }
    for (const acceptanceId of milestone.acceptanceIds) if (!checked.has(acceptanceId)) {
      issues.push(`${milestone.id} 的验收条目 ${acceptanceId} 没有完成检查覆盖`);
    }
  }
  for (const acceptanceId of expectedAcceptance) {
    const count = acceptanceCounts.get(acceptanceId) ?? 0;
    if (count < 1) issues.push(`验收条目 ${acceptanceId} 必须至少由一个里程碑覆盖`);
  }

  const dependencies = new Map(plan.milestones.map(item => [item.id, item.dependsOn] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (knownMilestones.has(dependency) && visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (milestoneIds.some(visit)) issues.push('里程碑依赖必须无环');
  if (issues.length) throw new HttpError(400, [...new Set(issues)].slice(0, 16).join('；'));

  const canonical = canonicalPlan(plan);
  const text = canonicalText(canonical);
  return { plan: canonical, hash: digest(text), text };
}

export interface ReviewValidationContext {
  subjectHash: string;
  reviewerTaskId: string;
  reviewer: MilestoneOwner;
  reviewerModel: string;
  reviewerFamily: string;
  author: MilestoneOwner;
  authorModel: string;
  authorFamily: string;
  checks: readonly MilestoneProof[];
  acceptanceIds: readonly string[];
  requireChecks?: boolean;
}

/** Bind a model verdict to trusted task/model identities and an immutable subject. */
export function validatePipelineReview(raw: unknown, context: ReviewValidationContext): PipelineReview {
  const input = pipelineReviewSchema.parse(raw);
  if (!HASH.test(context.subjectHash) || input.subjectHash !== context.subjectHash) throw new HttpError(409, '评审对象哈希已变化');
  if (!context.reviewerTaskId || !context.reviewerModel || !context.authorModel || !context.reviewerFamily || !context.authorFamily) {
    throw new HttpError(409, '评审身份不完整');
  }
  if (context.reviewer === context.author) throw new HttpError(409, '作者和评审席位必须不同');
  if (context.reviewerFamily.toLowerCase() === context.authorFamily.toLowerCase()) throw new HttpError(409, '作者和评审者必须来自不同厂商家族');
  if (context.requireChecks && (!context.checks.length || context.checks.some(check => !check.ok))) {
    throw new HttpError(409, '里程碑评审必须绑定全部通过的真实检查');
  }
  const allowedAcceptance = new Set(context.acceptanceIds);
  if (!unique(input.defects.map(item => item.id))) throw new HttpError(400, '评审缺陷 ID 必须唯一');
  for (const defect of input.defects) {
    if (!unique(defect.acceptanceIds)) throw new HttpError(400, `缺陷 ${defect.id} 的验收条目不得重复`);
    if (defect.acceptanceIds.some(id => !allowedAcceptance.has(id))) throw new HttpError(400, `缺陷 ${defect.id} 引用了评审范围之外的验收条目`);
  }
  return {
    subjectHash: context.subjectHash,
    reviewerTaskId: context.reviewerTaskId,
    reviewer: context.reviewer,
    reviewerModel: context.reviewerModel,
    reviewerFamily: context.reviewerFamily,
    author: context.author,
    authorModel: context.authorModel,
    authorFamily: context.authorFamily,
    outcome: input.outcome,
    defects: input.defects.map((defect): ReviewDefect => ({ ...defect, acceptanceIds: sortUnique(defect.acceptanceIds) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    checks: [...context.checks].sort((left, right) => left.checkId.localeCompare(right.checkId)),
  };
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => pathCovers(a, b) || pathCovers(b, a)));
}

/** Report source changes outside a milestone's declared path boundary. */
export function milestonePathIssues(paths: readonly string[], changes: WorkspaceChanges): string[] {
  const declared = paths.filter(validMilestonePath);
  const invalid = paths.filter(path => !validMilestonePath(path)).map(path => `里程碑声明了无效或保留路径 ${JSON.stringify(path)}`);
  const changed = sortUnique([...changes.created, ...changes.modified, ...changes.deleted].map(path => path.replaceAll('\\', '/')));
  const escaped = changed.filter(path => !validPath(path) || !declared.some(candidate => pathCovers(candidate, path)))
    .map(path => `改动越出里程碑声明路径：${path}`);
  return [...invalid, ...escaped];
}

/** Select a deterministic, dependency-ready batch with no owner or path conflicts. */
export function readyMilestones(plan: ImplementationPlan, state: ImplementationState): MilestoneDefinition[] {
  const progress = new Map(state.milestones.map(item => [item.id, item]));
  const complete = new Set(state.milestones.filter(item => item.status === 'complete').map(item => item.id));
  const active = plan.milestones.filter(item => activeStatuses.has(progress.get(item.id)?.status ?? ''));
  const selected: MilestoneDefinition[] = [];
  for (const milestone of plan.milestones) {
    if (progress.get(milestone.id)?.status !== 'ready') continue;
    if (milestone.dependsOn.some(id => !complete.has(id))) continue;
    if (active.some(item => item.owner === milestone.owner || pathsOverlap(item.paths, milestone.paths))) continue;
    if (selected.some(item => item.owner === milestone.owner || pathsOverlap(item.paths, milestone.paths))) continue;
    selected.push(milestone);
  }
  return selected;
}
