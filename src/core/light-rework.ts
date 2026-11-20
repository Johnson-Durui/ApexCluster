import { remainingActiveMs, reserveBudgetCall, reserveBuildRound } from './job-budget.js';
import type { BuildRound, JobBudget, MvpSpec, VerificationResult } from './types.js';
import { verifyAcceptance, type ToolLogItem } from './verify-mvp.js';

const minuteMs = 60_000;

export interface LightReworkBudgetReservation {
  writerTaskId: string;
  evaluateTaskId: string;
  finalTaskId: string | null;
  writerMinutes: number;
  evaluateMinutes: number;
  finalMinutes: number;
  now: string;
}

function checkedMinutes(value: number, label: string, required: boolean): number {
  if (!Number.isFinite(value) || value < 0 || (required && value <= 0)) throw new Error(`${label} 必须是${required ? '正' : '非负'}有限分钟数`);
  return value;
}

export function reserveLightReworkBudget(budget: JobBudget, input: LightReworkBudgetReservation): JobBudget {
  const writerTaskId = input.writerTaskId.trim();
  const evaluateTaskId = input.evaluateTaskId.trim();
  const finalTaskId = input.finalTaskId?.trim() || null;
  if (!writerTaskId || !evaluateTaskId) throw new Error('轻量返工必须预留 writer 与 evaluate 任务');
  const taskIds = [writerTaskId, evaluateTaskId, ...(finalTaskId ? [finalTaskId] : [])];
  if (new Set(taskIds).size !== taskIds.length) throw new Error('轻量返工预留任务编号必须唯一');

  const writerMinutes = checkedMinutes(input.writerMinutes, 'writerMinutes', true);
  const evaluateMinutes = checkedMinutes(input.evaluateMinutes, 'evaluateMinutes', true);
  const finalMinutes = checkedMinutes(input.finalMinutes, 'finalMinutes', finalTaskId !== null);
  if (!finalTaskId && finalMinutes !== 0) throw new Error('没有 finalTaskId 时 finalMinutes 必须为 0');

  const reserved = structuredClone(budget);
  if (reserved.calls.some((call) => call.state === 'reserved' || call.state === 'started')) {
    throw new Error('轻量返工只能在没有已预留或运行中调用时原子预留全部预算');
  }
  const callIds = taskIds.map((taskId) => `${taskId}:initial`);
  if (callIds.some((id) => reserved.calls.some((call) => call.id === id))) throw new Error('轻量返工任务已有预算调用记录，拒绝重复预留');
  const requiredMs = (writerMinutes + evaluateMinutes + finalMinutes) * minuteMs;
  if (remainingActiveMs(reserved, input.now) < requiredMs) throw new Error('主动运行时间预算不足以覆盖轻量返工全部超时上限');

  reserveBuildRound(reserved);
  reserveBudgetCall(reserved, `${writerTaskId}:initial`, writerTaskId, 'initial', true, input.now);
  reserveBudgetCall(reserved, `${evaluateTaskId}:initial`, evaluateTaskId, 'initial', false, input.now);
  if (finalTaskId) reserveBudgetCall(reserved, `${finalTaskId}:initial`, finalTaskId, 'initial', false, input.now);
  return reserved;
}

export interface GrokEvaluationVerificationInput {
  spec: MvpSpec;
  round: BuildRound;
  taskId: string;
  toolLog: ToolLogItem[];
  manualResults: {
    criterionId: string; pass: boolean; note: string | null;
    specRef?: string | null; round?: number | null; atCommit?: string | null; treeHash?: string | null; at?: string | null;
  }[];
  now: string;
  canonicalMatches: boolean;
}

export function grokEvaluationVerification(input: GrokEvaluationVerificationInput): VerificationResult | null {
  const { spec, round, toolLog } = input;
  if (round.writer !== 'grok' || !input.canonicalMatches) return null;
  if (!input.taskId.trim() || round.evaluateTaskId !== input.taskId) return null;
  if (!spec.ref.trim() || !round.workspaceCommit?.trim() || !round.treeHash?.trim() || round.staleReason) return null;
  const light = round.lightRework;
  if (!light || !light.sourceCommit.trim() || !light.sourceTreeHash.trim() || !light.capabilityRef.trim() ||
    !Number.isFinite(light.minutes) || light.minutes <= 0 || !Number.isFinite(light.evaluateMinutes) || light.evaluateMinutes <= 0 ||
    !Number.isFinite(light.finalMinutes) || light.finalMinutes < 0 || light.reservedEvaluateTaskId !== input.taskId ||
    (light.reservedFinalTaskId === null) !== (light.finalMinutes === 0)) return null;
  if (!round.reviewIntegrity?.ok || round.reviewIntegrity.errors.length > 0) return null;
  if (toolLog.some((item) => item.type === 'file_change')) return null;
  if (toolLog.some((item) => !Number.isInteger(item.seq) || item.seq < 0)) return null;

  const createdAt = Date.parse(round.createdAt);
  const boundManualResults = input.manualResults.filter((result) => {
    const at = Date.parse(result.at ?? '');
    return result.specRef === spec.ref && result.round === round.round && result.atCommit === round.workspaceCommit &&
      result.treeHash === round.treeHash && Number.isFinite(createdAt) && Number.isFinite(at) && at >= createdAt;
  });
  const checked = verifyAcceptance(spec, toolLog, null, boundManualResults, input.now);
  const sequences = toolLog.map((item) => item.seq);
  return {
    ...checked,
    specRef: spec.ref,
    atCommit: round.workspaceCommit,
    treeHash: round.treeHash,
    taskId: input.taskId,
    logRange: sequences.length ? { from: Math.min(...sequences), to: Math.max(...sequences) } : null,
    staleReason: null,
  };
}
