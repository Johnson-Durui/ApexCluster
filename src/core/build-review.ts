import type { EvaluationOutput, FinalReviewOutput } from './schemas.js';
import type { BuildRound, MvpSpec, VerificationResult } from './types.js';
import { commandMatches, verifyAcceptance, type ToolLogItem } from './verify-mvp.js';

export interface ReviewValidationContext {
  specRef?: string;
  acceptanceIds?: string[];
  round?: number;
  workspaceCommit?: string | null;
  rounds?: { round: number; defectIds: string[] }[];
}

const duplicates = <T>(values: T[]) => values.length !== new Set(values).size;
const relativeLocation = (value: string) => !!value.trim() && !/^(?:[A-Za-z]:|[\\/~])/.test(value) && !value.split(/[\\/]/).includes('..');

export function checkEvaluation(value: EvaluationOutput, ctx: ReviewValidationContext): string[] {
  const errors: string[] = [];
  if (value.specRef !== ctx.specRef) errors.push('评审 specRef 与当前规格不一致');
  if (!Number.isSafeInteger(value.round) || value.round < 1) errors.push('评审 round 必须为正整数');
  if (value.round !== ctx.round) errors.push('评审 round 与当前轮次不一致');
  if (value.workspaceCommit !== ctx.workspaceCommit) errors.push('评审 workspaceCommit 与程序记录不一致');
  const expected = ctx.acceptanceIds ?? [];
  const ids = value.acceptance.map(item => item.criterionId);
  if (duplicates(ids) || ids.length !== expected.length || expected.some(id => !ids.includes(id))) errors.push('评审必须恰好覆盖每个验收项一次');
  const defects = value.defects.map(defect => defect.id);
  if (duplicates(defects) || defects.some(id => !id.trim())) errors.push('缺陷编号必须非空且唯一');
  for (const defect of value.defects) {
    if (!defect.criterionIds.length || duplicates(defect.criterionIds) || defect.criterionIds.some(id => !expected.includes(id))) errors.push(`缺陷 ${defect.id} 的验收项引用无效`);
    if (!relativeLocation(defect.location) || !defect.evidence.trim() || !defect.fix.trim() || !defect.reproduction.command.trim()) errors.push(`缺陷 ${defect.id} 必须提供工作区内位置、证据、复现命令和修法`);
    if (defect.failureClass === 'none') errors.push(`缺陷 ${defect.id} 不能归类为 none`);
    if (defect.reproduction.logSeq !== null && (!Number.isSafeInteger(defect.reproduction.logSeq) || defect.reproduction.logSeq < 0)) errors.push(`缺陷 ${defect.id} 的 logSeq 必须为非负整数或 null`);
    if (!Number.isSafeInteger(defect.reproduction.expectedExitCode)) errors.push(`缺陷 ${defect.id} 的 expectedExitCode 必须为安全整数`);
  }
  for (const brief of value.reworkBrief) {
    if (!brief.instructions.trim() || !brief.defectIds.length || duplicates(brief.defectIds) || brief.defectIds.some(id => !defects.includes(id))) errors.push('返工简报必须引用本次存在的缺陷编号');
  }
  if (value.verdict === 'pass' && (value.defects.length || value.acceptance.some(item => item.status === 'fail' || item.status === 'cannot_verify'))) errors.push('评审 pass 与缺陷或验收结果矛盾');
  if (value.verdict === 'fail' && !value.defects.length) errors.push('评审 fail 必须说明缺陷');
  return errors;
}

export function checkFinalReview(value: FinalReviewOutput, ctx: ReviewValidationContext): string[] {
  const errors: string[] = [];
  if (value.specRef !== ctx.specRef) errors.push('终审 specRef 与当前规格不一致');
  if (value.workspaceCommit !== ctx.workspaceCommit) errors.push('终审 workspaceCommit 与程序记录不一致');
  const rounds = ctx.rounds ?? [];
  if (value.roundsReviewed.some(round => !Number.isSafeInteger(round) || round < 1)) errors.push('终审轮次必须为正整数');
  if (duplicates(value.roundsReviewed) || value.roundsReviewed.length !== rounds.length || rounds.some(round => !value.roundsReviewed.includes(round.round))) errors.push('终审必须覆盖本作业全部构建轮次');
  for (const finding of value.findings) {
    const round = rounds.find(round => round.round === finding.round);
    if (!Number.isSafeInteger(finding.round) || finding.round < 1) errors.push('终审发现的轮次必须为正整数');
    if (!round || finding.defectIds.some(id => !round.defectIds.includes(id)) || !finding.text.trim()) errors.push('终审发现必须引用本作业的轮次和缺陷');
  }
  if (!value.summary.trim()) errors.push('终审摘要不能为空');
  if (value.verdict === 'reject' && !value.findings.length && !value.reworkNotes.some(note => note.trim())) errors.push('终审 reject 必须给出意见');
  return errors;
}

/** 模型建议只有与未被改动的副本日志及用户确认的命令相符，才成为自动返工依据。 */
export function reproducibleDefectIds(spec: MvpSpec, evaluation: EvaluationOutput, log: ToolLogItem[], integrity: boolean): string[] {
  if (!integrity || !evaluation.workspaceCommit) return [];
  const lastChange = log.filter(item => item.type === 'file_change').reduce((max, item) => Math.max(max, item.seq), -1);
  return evaluation.defects.filter(defect => {
    if (defect.failureClass !== 'implementation_defect') return false;
    const matching = log.filter(item => item.seq > lastChange && item.type === 'command_execution' && item.command && commandMatches(item.command, defect.reproduction.command));
    const entry = matching.at(-1);
    if (defect.reproduction.logSeq !== null && entry?.seq !== defect.reproduction.logSeq) return false;
    if (!entry?.command || entry.exitCode === null || !commandMatches(entry.command, defect.reproduction.command)) return false;
    const criterion = spec.acceptance.find(item => defect.criterionIds.includes(item.id) && item.kind === 'command' && item.command && commandMatches(entry.command!, item.command)
      && commandMatches(defect.reproduction.command, item.command) && defect.reproduction.expectedExitCode === (item.expectExitCode ?? 0)
      && defect.reproduction.outputIncludes === item.outputIncludes);
    if (!criterion) return false;
    return entry.exitCode !== (criterion.expectExitCode ?? 0) || (!!criterion.outputIncludes && !(entry.output ?? '').includes(criterion.outputIncludes));
  }).map(defect => defect.id);
}

export function evaluationVerification(spec: MvpSpec, round: BuildRound, log: ToolLogItem[], manual: { criterionId: string; pass: boolean; note: string | null }[], now: string): VerificationResult {
  const checked = verifyAcceptance(spec, log, null, manual, now);
  // 原始会话快照未被评审聚合覆盖；旧聚合的顶层 taskId 不能证明逐项来源。
  const writer = round.context?.sessions.findLast(session => session.finalVerification && session.verification);
  const baseline = writer?.verification ?? round.verification ?? checked;
  const trustedTaskId = writer?.taskId ?? (round.writer === 'grok' && baseline === round.verification
    && baseline.taskId === round.evaluateTaskId ? baseline.taskId : undefined);
  // 评审可揭示失败，不能用模型 pass 或评审日志补写者缺失/失败的验收证据。
  let composite = false;
  const items = baseline.items.map(item => {
    const reviewer = checked.items.find(candidate => candidate.criterionId === item.criterionId);
    if (reviewer && spec.acceptance.some(criterion => criterion.id === item.criterionId && criterion.kind === 'manual')) return reviewer;
    if (reviewer?.status === 'verified_fail' && item.status !== 'verified_fail') {
      composite = true;
      return { ...reviewer, ...(round.evaluateTaskId ? { evidenceTaskId: round.evaluateTaskId } : {}) };
    }
    const source = item.evidenceTaskId ?? trustedTaskId;
    return source ? { ...item, evidenceTaskId: source } : item;
  });
  const verdict = items.some(item => ['verified_fail', 'user_fail'].includes(item.status)) ? 'failed'
    : items.some(item => item.status === 'not_observed') ? 'inconclusive'
      : items.some(item => item.status === 'awaiting_user') ? 'awaiting_manual' : 'passed';
  const result: VerificationResult = { ...baseline, verdict, items, computedAt: now };
  if (trustedTaskId && !composite) result.taskId = trustedTaskId;
  else {
    delete result.taskId;
    result.logRange = null;
  }
  return result;
}
