import { createHash } from 'node:crypto';
import { HttpError } from '../orchestrator/errors.js';
import type { FrozenContract } from './contract.js';
import type { ImplementationState, MilestoneProof } from './implementation-types.js';

export interface TraceProof {
  checkId: string;
  ref: string;
  hash: string;
  snapshotId: string;
  fingerprint: string;
  ok: boolean;
}

export interface ImplementationTraceEntry {
  acceptanceId: string;
  requirementIds: string[];
  kind: 'command' | 'ui' | 'manual';
  milestoneIds: string[];
  /** Deterministic primary milestone retained for compact consumers. */
  milestoneId: string;
  checkIds: string[];
  milestoneProofs: TraceProof[];
  finalProofs: TraceProof[];
  status: 'passed' | 'failed' | 'unverified';
  reason?: string;
}

export interface ImplementationTrace {
  format: 'implementation-trace/v1';
  contractHash: string;
  planHash: string;
  entries: ImplementationTraceEntry[];
  failed: string[];
  unverified: string[];
}

const proofView = (proof: MilestoneProof): TraceProof => ({
  checkId: proof.checkId,
  ref: proof.ref,
  hash: proof.hash,
  snapshotId: proof.snapshotId,
  fingerprint: proof.fingerprint,
  ok: proof.ok,
});

const sortedProofs = (proofs: readonly MilestoneProof[]) => [...proofs].map(proofView)
  .sort((left, right) => left.checkId.localeCompare(right.checkId) || left.ref.localeCompare(right.ref));

/** Build the canonical, program-owned AC-to-proof index from frozen pipeline state. */
export function buildImplementationTrace(contract: FrozenContract, state: ImplementationState): {
  trace: ImplementationTrace;
  hash: string;
  text: string;
} {
  if (!state.planHash) throw new HttpError(409, '实现计划尚未冻结');
  const proposal = state.proposals.find(item => item.hash === state.planHash && item.review?.outcome === 'passed');
  if (!proposal) throw new HttpError(409, '冻结计划缺少同哈希的通过评审');
  if (proposal.plan.contractHash !== contract.sha256) throw new HttpError(409, '冻结计划与契约哈希不一致');

  const milestones = new Map(proposal.plan.milestones.map(item => [item.id, item] as const));
  const progress = new Map(state.milestones.map(item => [item.id, item] as const));
  const owners = new Map<string, string[]>();
  for (const milestone of proposal.plan.milestones) for (const acceptanceId of milestone.acceptanceIds) {
    owners.set(acceptanceId, [...(owners.get(acceptanceId) ?? []), milestone.id].sort());
  }
  const finalChecks = state.acceptance?.checks ?? [];
  const manual = new Set(state.acceptance?.manualIds ?? []);
  const entries: ImplementationTraceEntry[] = [];

  for (const acceptance of contract.acceptance) {
    const milestoneIds = owners.get(acceptance.id) ?? [];
    const ownedMilestones = milestoneIds.map(id => milestones.get(id)).filter(item => item !== undefined);
    if (!milestoneIds.length || ownedMilestones.length !== milestoneIds.length) throw new HttpError(409, `TRACE 缺少验收归属 ${acceptance.id}`);
    const milestoneId = milestoneIds[0]!;
    const checkIds = ownedMilestones.flatMap(milestone => milestone.checks
      .filter(check => check.acceptanceIds.includes(acceptance.id)).map(check => check.id)).sort();
    if (!checkIds.length) throw new HttpError(409, `TRACE 缺少验收检查 ${acceptance.id}`);
    const current = milestoneIds.map(id => progress.get(id));
    const milestoneProofs = sortedProofs(current.flatMap(item => item?.attempts.at(-1)?.checks ?? [])
      .filter(proof => checkIds.includes(proof.checkId)));
    const finalProofs = sortedProofs(finalChecks.filter(proof => checkIds.includes(proof.checkId) || proof.checkId === acceptance.id));
    let status: ImplementationTraceEntry['status'];
    let reason: string | undefined;
    if (acceptance.kind === 'manual') {
      status = 'unverified';
      reason = manual.has(acceptance.id) ? '需要用户人工验收' : '人工验收项尚未登记';
    } else if ([...milestoneProofs, ...finalProofs].some(proof => !proof.ok)) {
      status = 'failed';
      reason = '至少一条里程碑或最终验收回执失败';
    } else if (current.some(item => item?.status !== 'complete')) {
      status = 'unverified';
      reason = '所属里程碑尚未完成';
    } else if (!checkIds.every(id => milestoneProofs.some(proof => proof.checkId === id && proof.ok))) {
      status = 'unverified';
      reason = '里程碑检查回执不完整';
    } else if (!finalProofs.length) {
      status = 'unverified';
      reason = '最终独立验收尚未提供回执';
    } else {
      status = 'passed';
    }
    entries.push({
      acceptanceId: acceptance.id,
      requirementIds: [...acceptance.requirementIds].sort(),
      kind: acceptance.kind,
      milestoneIds,
      milestoneId,
      checkIds,
      milestoneProofs,
      finalProofs,
      status,
      ...(reason ? { reason } : {}),
    });
  }

  const trace: ImplementationTrace = {
    format: 'implementation-trace/v1',
    contractHash: contract.sha256,
    planHash: state.planHash,
    entries: entries.sort((left, right) => left.acceptanceId.localeCompare(right.acceptanceId)),
    failed: entries.filter(item => item.status === 'failed').map(item => item.acceptanceId).sort(),
    unverified: entries.filter(item => item.status === 'unverified').map(item => item.acceptanceId).sort(),
  };
  const text = `${JSON.stringify(trace)}\n`;
  return { trace, text, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
}
