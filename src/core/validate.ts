/**
 * 模型输出校验：结构（zod）+ 语义（交叉引用、覆盖完整性）。
 * 结构/语义错误 → 触发一次“只修结构”的修复请求；仍失败 → 任务标记“输出结构不合法”。
 * 这与“模型完成生成”“方案通过评审”是不同状态，界面要分开展示。
 */
import type { z } from 'zod/v4';
import { checkEvaluation, checkFinalReview, type ReviewValidationContext } from './build-review.js';
import { checkDigest, checkQgroup, type ChoreSource, type DigestOutput, type QgroupOutput } from './chores.js';
import { checkDevDoc, checkHandbook, checkPrd, type DevDocCheckContext } from './doc-checks.js';
import {
  OUTPUT_SCHEMAS,
  type AdjudicationOutput,
  type BuildReportOutput,
  type EvaluationOutput,
  type FinalReviewOutput,
  type ClarifyOutput,
  type DevDocOutput,
  type HandbookOutput,
  type PrdOutput,
  type ProposeOutput,
  type QuestionOut,
  type RecheckOutput,
  type ReviewOutput,
  type TaskPhase,
} from './schemas.js';

export interface ValidationContext extends ReviewValidationContext {
  choreSources?: ChoreSource[];
  choreQuestionIds?: string[];
  snapshotRef?: string;
  constraintIds?: string[];
  criterionIds?: string[];
  /** review：本评审看到的匿名编号 */
  anonymousIds?: string[];
  /** recheck：需要复核的条目及类型 */
  recheckItems?: { id: string; kind: 'cell' | 'constraint' }[];
  adjudicationItemIds?: string[];
  eligibleCandidateIds?: string[];
  /** build */
  specRef?: string;
  acceptanceIds?: string[];
  hypothesisIds?: string[];
  maxProposals?: number;
  maxQuestions?: number;
  /** 快照中已存在的问题编号（用于检查假设引用；只给警告） */
  knownQuestionIds?: string[];
  /** 文档任务 */
  docRef?: string;
  docSourceIds?: string[];
  docSpecs?: { ref: string; acceptanceIds: string[] }[];
  docCandidates?: { id: string; moduleIds: string[] }[];
  devCandidates?: DevDocCheckContext['candidates'];
  previousDoc?: unknown;
}

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  errors: string[];
  warnings: string[];
}

export type PhaseOutput = {
  digest: DigestOutput;
  qgroup: QgroupOutput;
  clarify: ClarifyOutput;
  propose: ProposeOutput;
  review: ReviewOutput;
  recheck: RecheckOutput;
  adjudicate: AdjudicationOutput;
  build: BuildReportOutput;
  evaluate: EvaluationOutput;
  final_review: FinalReviewOutput;
  prd: PrdOutput;
  handbook: HandbookOutput;
  devdoc: DevDocOutput;
  probe: { ok: boolean; note: string };
};

/** 从模型文本里提取 JSON（CLI 不支持原生 schema 时的兜底） */
export function extractJson(text: string | null | undefined): unknown {
  if (!text) return null;
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* 继续尝试 */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续 */
    }
  }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function zodErrors(err: z.ZodError): string[] {
  return err.issues.slice(0, 30).map((i) => `结构错误 ${i.path.join('.') || '(根)'}：${i.message}`);
}

function dupes(xs: string[]): string[] {
  const seen = new Set<string>();
  const d = new Set<string>();
  for (const x of xs) (seen.has(x) ? d : seen).add(x);
  return [...d];
}

function isScore(x: number | null): boolean {
  return x === null || (Number.isInteger(x) && x >= 0 && x <= 5);
}

function checkQuestions(qs: QuestionOut[], where: string, ctx: ValidationContext, errors: string[], warnings: string[]): void {
  const max = ctx.maxQuestions ?? 15;
  if (qs.length > max) errors.push(`${where}：问题数量 ${qs.length} 超过上限 ${max}，请只保留最重要的`);
  const d = dupes(qs.map((q) => q.localId));
  if (d.length) errors.push(`${where}：问题 localId 重复：${d.join(',')}`);
  for (const q of qs) {
    const p = `${where}.问题 ${q.localId}`;
    if (!q.text.trim()) errors.push(`${p}：text 为空`);
    if (q.options.length < 2) errors.push(`${p}：至少需要 2 个选项（界面会另外提供“其他/不确定/跳过”）`);
    if (q.options.length > 6) errors.push(`${p}：选项过多（>6）`);
    const ids = q.options.map((o) => o.id);
    if (dupes(ids).length) errors.push(`${p}：选项 id 重复`);
    for (const id of q.defaultOptionIds) if (!ids.includes(id)) errors.push(`${p}：defaultOptionIds 引用了不存在的选项 ${id}`);
    if (!q.multiSelect && q.defaultOptionIds.length > 1) errors.push(`${p}：单选题的默认选项只能有 1 个`);
    if (!q.defaultAssumption.trim()) errors.push(`${p}：必须给出不回答时采用的默认假设`);
    if (!q.whyItMatters.trim()) warnings.push(`${p}：缺少 whyItMatters`);
  }
}

function checkSnapshotRef(got: string, ctx: ValidationContext, errors: string[]): void {
  if (ctx.snapshotRef && got !== ctx.snapshotRef) {
    errors.push(`snapshotRef 不匹配：期望 ${ctx.snapshotRef}，实际 ${got}（模型可能读取了错误版本的需求）`);
  }
}

function validateClarify(v: ClarifyOutput, ctx: ValidationContext, errors: string[], warnings: string[]): void {
  checkSnapshotRef(v.snapshotRef, ctx, errors);
  checkQuestions(v.questions, 'clarify', ctx, errors, warnings);
}

function validatePropose(v: ProposeOutput, ctx: ValidationContext, errors: string[], warnings: string[]): void {
  checkSnapshotRef(v.snapshotRef, ctx, errors);
  const max = ctx.maxProposals ?? 3;
  if (v.proposals.length < 1) errors.push('至少需要 1 个方案');
  if (v.proposals.length > max) errors.push(`方案数量 ${v.proposals.length} 超过上限 ${max}`);
  if (!v.whyThisCount.trim()) errors.push('whyThisCount 不能为空（说明为什么是这个数量）');
  const pd = dupes(v.proposals.map((p) => p.localId));
  if (pd.length) errors.push(`方案 localId 重复：${pd.join(',')}`);
  for (const p of v.proposals) {
    const w = `方案 ${p.localId}`;
    if (p.modules.length === 0) errors.push(`${w}：modules 不能为空`);
    const mids = p.modules.map((m) => m.id);
    const md = dupes(mids);
    if (md.length) errors.push(`${w}：模块 id 重复：${md.join(',')}`);
    for (const f of p.flows) {
      if (!mids.includes(f.from)) errors.push(`${w}：数据流引用了不存在的模块 from=${f.from}（外部参与者也要作为模块列出）`);
      if (!mids.includes(f.to)) errors.push(`${w}：数据流引用了不存在的模块 to=${f.to}`);
    }
    if (p.stack.length === 0) errors.push(`${w}：stack 不能为空`);
    if (ctx.constraintIds) {
      const got = p.constraintChecks.map((c) => c.constraintId);
      for (const id of ctx.constraintIds) if (!got.includes(id)) errors.push(`${w}：缺少对硬约束 ${id} 的自检`);
      for (const id of got) if (!ctx.constraintIds.includes(id)) errors.push(`${w}：自检引用了不存在的约束 ${id}`);
    }
    const plan = p.mvpPlan;
    if (plan.acceptance.length === 0) errors.push(`${w}：mvpPlan.acceptance 至少 1 条`);
    if (!plan.acceptance.some((a) => a.kind === 'command')) warnings.push(`${w}：没有可自动核验的命令型验收项，MVP 只能人工验收`);
    const ad = dupes(plan.acceptance.map((a) => a.id));
    if (ad.length) errors.push(`${w}：验收项 id 重复：${ad.join(',')}`);
    for (const a of plan.acceptance) {
      if (a.kind === 'command' && !a.command?.trim()) errors.push(`${w}：验收项 ${a.id} 是命令型但没有 command`);
    }
    const wids = plan.workstreams.map((x) => x.id);
    for (const ws of plan.workstreams) {
      for (const dep of ws.dependsOn) if (!wids.includes(dep)) errors.push(`${w}：工作流 ${ws.id} 依赖不存在的 ${dep}`);
    }
    if (ctx.knownQuestionIds) {
      for (const a of p.assumptions) {
        if (a.questionId && !ctx.knownQuestionIds.includes(a.questionId)) warnings.push(`${w}：假设引用了未知问题 ${a.questionId}`);
      }
    }
  }
  checkQuestions(v.questions, 'propose', ctx, errors, warnings);
}

function validateReview(v: ReviewOutput, ctx: ValidationContext, errors: string[], warnings: string[]): void {
  checkSnapshotRef(v.snapshotRef, ctx, errors);
  const ids = ctx.anonymousIds ?? [];
  const got = v.reviews.map((r) => r.candidateId);
  for (const id of ids) if (!got.includes(id)) errors.push(`缺少对候选 ${id} 的评审`);
  for (const id of got) if (!ids.includes(id)) errors.push(`评审了不存在的候选 ${id}`);
  const dd = dupes(got);
  if (dd.length) errors.push(`候选重复评审：${dd.join(',')}`);
  const inGroups: string[] = [];
  for (const g of v.equivalentGroups) {
    if (g.length < 2) errors.push(`equivalentGroups 中的分组至少 2 个成员：${JSON.stringify(g)}`);
    for (const id of g) if (!ids.includes(id)) errors.push(`equivalentGroups 引用了不存在的候选 ${id}`);
    inGroups.push(...g);
  }
  if (dupes(inGroups).length) errors.push('同一候选出现在多个等价分组中');
  for (const r of v.reviews) {
    const w = `候选 ${r.candidateId}`;
    if (ctx.criterionIds) {
      const sc = r.scores.map((s) => s.criterionId);
      for (const id of ctx.criterionIds) if (!sc.includes(id)) errors.push(`${w}：缺少评分项 ${id}`);
      for (const id of sc) if (!ctx.criterionIds.includes(id)) errors.push(`${w}：未知评分项 ${id}`);
      if (dupes(sc).length) errors.push(`${w}：评分项重复`);
    }
    for (const s of r.scores) {
      if (!isScore(s.score)) errors.push(`${w}.${s.criterionId}：分数必须是 0–5 的整数或 null，实际 ${s.score}`);
      if (s.score !== null && s.evidence.length === 0) errors.push(`${w}.${s.criterionId}：给分必须附至少 1 条依据；没有依据请给 null`);
      if (!s.rationale.trim()) errors.push(`${w}.${s.criterionId}：rationale 不能为空`);
    }
    if (ctx.constraintIds) {
      const cc = r.constraintChecks.map((c) => c.constraintId);
      for (const id of ctx.constraintIds) if (!cc.includes(id)) errors.push(`${w}：缺少硬约束 ${id} 的判定`);
      for (const id of cc) if (!ctx.constraintIds.includes(id)) errors.push(`${w}：未知约束 ${id}`);
    }
    for (const c of r.constraintChecks) {
      if (c.status === 'fail' && c.evidence.length === 0) errors.push(`${w}.${c.constraintId}：判定“不满足”必须附依据`);
    }
    if (dupes(r.objections.map((o) => o.id)).length) errors.push(`${w}：反对意见 id 重复`);
    for (const o of r.objections) {
      if (o.criterionId && ctx.criterionIds && !ctx.criterionIds.includes(o.criterionId)) errors.push(`${w}：反对意见引用未知评分项 ${o.criterionId}`);
      if (o.verifiable && !o.howToVerify?.trim()) warnings.push(`${w}：可验证的反对意见 ${o.id} 缺少验证方法`);
    }
  }
  checkQuestions(v.questions, 'review', ctx, errors, warnings);
}

function validateRecheck(v: RecheckOutput, ctx: ValidationContext, errors: string[], warnings: string[]): void {
  checkSnapshotRef(v.snapshotRef, ctx, errors);
  const items = ctx.recheckItems ?? [];
  const got = v.items.map((i) => i.itemId);
  for (const it of items) if (!got.includes(it.id)) errors.push(`缺少复核项 ${it.id}`);
  for (const id of got) if (!items.some((x) => x.id === id)) errors.push(`未知复核项 ${id}`);
  for (const i of v.items) {
    const kind = items.find((x) => x.id === i.itemId)?.kind;
    if (kind === 'cell') {
      if (!isScore(i.revisedScore)) errors.push(`复核项 ${i.itemId}：分数必须是 0–5 整数或 null`);
      if (i.revisedStatus !== null) errors.push(`复核项 ${i.itemId}：评分项的 revisedStatus 必须为 null`);
      if (i.revisedScore !== null && i.evidence.length === 0) errors.push(`复核项 ${i.itemId}：给分必须附依据`);
    }
    if (kind === 'constraint') {
      if (i.revisedStatus === null) errors.push(`复核项 ${i.itemId}：约束项必须给出 revisedStatus`);
      if (i.revisedScore !== null) errors.push(`复核项 ${i.itemId}：约束项的 revisedScore 必须为 null`);
    }
    if (!i.rationale.trim()) errors.push(`复核项 ${i.itemId}：rationale 不能为空`);
  }
  checkQuestions(v.questions, 'recheck', ctx, errors, warnings);
}

function validateBuild(v: BuildReportOutput, ctx: ValidationContext, errors: string[], warnings: string[]): void {
  if (ctx.specRef && v.specRef !== ctx.specRef) errors.push(`specRef 不匹配：期望 ${ctx.specRef}，实际 ${v.specRef}`);
  const acc = v.acceptanceResults.map((a) => a.criterionId);
  for (const id of ctx.acceptanceIds ?? []) if (!acc.includes(id)) errors.push(`缺少验收项 ${id} 的结果`);
  const hyp = v.hypothesisResults.map((h) => h.hypothesisId);
  for (const id of ctx.hypothesisIds ?? []) if (!hyp.includes(id)) errors.push(`缺少假设 ${id} 的结果`);
  if (v.failureClass !== 'none' && !v.failureDetail?.trim()) errors.push('failureClass 不是 none 时必须填写 failureDetail');
  if (v.howToRun.run.length === 0) warnings.push('howToRun.run 为空');
  checkQuestions(v.questions, 'build', ctx, errors, warnings);
}

function validateAdjudication(v: AdjudicationOutput, ctx: ValidationContext, errors: string[], warnings: string[]): void {
  checkSnapshotRef(v.snapshotRef, ctx, errors);
  const expected = ctx.adjudicationItemIds ?? [];
  const ids = v.items.map(item => item.itemId);
  for (const id of expected) if (!ids.includes(id)) errors.push(`缺少裁决项 ${id}`);
  for (const id of ids) if (!expected.includes(id)) errors.push(`未知裁决项 ${id}`);
  if (dupes(ids).length) errors.push('裁决项重复');
  if (v.recommendation.candidateId !== null && !ctx.eligibleCandidateIds?.includes(v.recommendation.candidateId)) errors.push('裁决建议引用了不存在或已淘汰的候选');
  if (!v.recommendation.rationale.trim()) errors.push('裁决建议必须说明理由');
  for (const item of v.items) {
    if (!item.rationale.trim()) errors.push(`裁决项 ${item.itemId}：理由不能为空`);
    if (item.verdict === 'resolved' && !item.evidence.length) errors.push(`裁决项 ${item.itemId}：形成建议必须附依据`);
    if (item.evidence.some(e => !e.summary.trim())) errors.push(`裁决项 ${item.itemId}：依据摘要不能为空`);
    if (item.verdict === 'unresolved' && !item.verification?.trim()) errors.push(`裁决项 ${item.itemId}：未决项必须说明如何补充证据`);
  }
  checkQuestions(v.questions, 'adjudicate', ctx, errors, warnings);
}

export function validateOutput<P extends TaskPhase>(phase: P, raw: unknown, ctx: ValidationContext): ValidationResult<PhaseOutput[P]> {
  const schema = OUTPUT_SCHEMAS[phase];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, errors: zodErrors(parsed.error), warnings: [] };
  const v = parsed.data as PhaseOutput[P];
  const errors: string[] = [];
  const warnings: string[] = [];
  switch (phase) {
    case 'digest':
      errors.push(...checkDigest(v as DigestOutput, { specRef: ctx.specRef ?? null, workspaceCommit: ctx.workspaceCommit ?? null, sources: ctx.choreSources ?? [] }).errors);
      break;
    case 'qgroup':
      errors.push(...checkQgroup(v as QgroupOutput, { snapshotRef: ctx.snapshotRef ?? '', questionIds: ctx.choreQuestionIds ?? [] }).errors);
      break;
    case 'clarify':
      validateClarify(v as ClarifyOutput, ctx, errors, warnings);
      break;
    case 'propose':
      validatePropose(v as ProposeOutput, ctx, errors, warnings);
      break;
    case 'review':
      validateReview(v as ReviewOutput, ctx, errors, warnings);
      break;
    case 'recheck':
      validateRecheck(v as RecheckOutput, ctx, errors, warnings);
      break;
    case 'adjudicate':
      validateAdjudication(v as AdjudicationOutput, ctx, errors, warnings);
      break;
    case 'build':
      validateBuild(v as BuildReportOutput, ctx, errors, warnings);
      break;
    case 'evaluate':
      errors.push(...checkEvaluation(v as EvaluationOutput, ctx));
      checkQuestions((v as EvaluationOutput).questions, 'evaluate', ctx, errors, warnings);
      break;
    case 'final_review':
      errors.push(...checkFinalReview(v as FinalReviewOutput, ctx));
      checkQuestions((v as FinalReviewOutput).questions, 'final_review', ctx, errors, warnings);
      break;
    case 'prd': {
      const r = checkPrd(v as PrdOutput, {
        docRef: ctx.docRef ?? (v as PrdOutput).docRef,
        sourceIds: ctx.docSourceIds ?? [],
        specs: ctx.docSpecs ?? [],
        previous: (ctx.previousDoc as PrdOutput | undefined) ?? null,
      });
      errors.push(...r.errors);
      warnings.push(...r.warnings);
      break;
    }
    case 'handbook': {
      const r = checkHandbook(v as HandbookOutput, {
        docRef: ctx.docRef ?? (v as HandbookOutput).docRef,
        sourceIds: ctx.docSourceIds ?? [],
        candidates: ctx.docCandidates ?? [],
        previous: (ctx.previousDoc as HandbookOutput | undefined) ?? null,
      });
      errors.push(...r.errors);
      warnings.push(...r.warnings);
      break;
    }
    case 'devdoc': {
      const r = checkDevDoc(v as DevDocOutput, {
        docRef: ctx.docRef ?? (v as DevDocOutput).docRef,
        sourceIds: ctx.docSourceIds ?? [],
        candidates: ctx.devCandidates ?? [],
      });
      errors.push(...r.errors);
      warnings.push(...r.warnings);
      break;
    }
    default:
      break;
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? v : null, errors, warnings };
}
