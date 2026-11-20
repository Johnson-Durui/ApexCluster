/**
 * 编排器用到的纯函数（无 I/O），便于单测。
 */
import type { G2Input } from '../core/schemas.js';
import type { DesignRole, DocRequest, Judgment, ModelRole, MvpSpec, Proposal, RequirementSnapshot, Run, TaskRecord } from '../core/types.js';
import { shortHash } from '../core/util.js';

export const DESIGN_ROLES: DesignRole[] = ['claude', 'astra'];

export function clarifyRoles(run: Run): DesignRole[] {
  if (run.clarifyWith === 'skip') return [];
  if (run.clarifyWith === 'both') return [...DESIGN_ROLES];
  return [run.clarifyWith];
}

export function snapshotOf(run: Run, version: number | null): RequirementSnapshot {
  const s = run.snapshots.find((x) => x.version === version);
  if (!s) throw new Error(`找不到需求快照 v${version}`);
  return s;
}
export const currentSnapshot = (run: Run) => snapshotOf(run, run.currentSnapshotVersion);
export const designSnapshot = (run: Run) => snapshotOf(run, run.designSnapshotVersion ?? run.currentSnapshotVersion);

export const proposeScope = (run: Run) => `r${run.designRound}-propose`;
export const reviewScope = (run: Run) => `r${run.designRound}-review`;
export const recheckScope = (run: Run) => `r${run.designRound}-recheck-${run.recheckBatch}`;
export const adjudicationScope = (run: Run) => `r${run.designRound}-adjudicate-${run.recheckBatch}`;
export const jobScope = (jobId: string) => `job:${jobId}`;
export const docScope = (batch: number, req: Pick<DocRequest, 'kind' | 'version' | 'seq'>) => `docs-b${batch}-${req.kind}-v${req.version}-r${req.seq}`;

/** 每个逻辑任务（rootTaskId）只取最新一次尝试 */
export function latestAttempts(run: Run, scope: string): TaskRecord[] {
  const byRoot = new Map<string, TaskRecord>();
  for (const t of run.tasks.filter((x) => x.scope === scope)) {
    const prev = byRoot.get(t.rootTaskId);
    if (!prev || t.attempt > prev.attempt) byRoot.set(t.rootTaskId, t);
  }
  return [...byRoot.values()];
}

export function taskOk(t: TaskRecord): boolean {
  if (t.acceptedDespiteMismatch) return true;
  return t.status === 'succeeded' && (t.outputValidity === 'valid' || t.outputValidity === 'repaired');
}

export function taskSettled(t: TaskRecord): boolean {
  return !['queued', 'running'].includes(t.status);
}

export type ScopeState = 'not_started' | 'running' | 'all_ok' | 'partial' | 'all_failed';

export function scopeState(run: Run, scope: string, roles: ModelRole[]): { state: ScopeState; ok: ModelRole[]; failed: TaskRecord[]; skipped: ModelRole[] } {
  const latest = latestAttempts(run, scope);
  const skipped = run.degraded.filter((d) => d.scope === scope).map((d) => d.role as ModelRole);
  const relevant = roles.filter((r) => !skipped.includes(r));
  const ok: ModelRole[] = [];
  const failed: TaskRecord[] = [];
  let running = false;
  for (const role of relevant) {
    const t = latest.find((x) => x.role === role);
    if (!t) return { state: 'not_started', ok, failed, skipped };
    if (!taskSettled(t)) running = true;
    else if (taskOk(t)) ok.push(role);
    else failed.push(t);
  }
  if (running) return { state: 'running', ok, failed, skipped };
  if (relevant.length === 0) return { state: 'all_ok', ok, failed, skipped };
  if (failed.length === 0) return { state: 'all_ok', ok, failed, skipped };
  return { state: ok.length > 0 ? 'partial' : 'all_failed', ok, failed, skipped };
}

export function roundProposals(run: Run): Proposal[] {
  return run.proposals.filter((p) => p.designRound === run.designRound);
}

export function roundJudgments(run: Run): Judgment[] {
  return run.judgments.filter((j) => j.designRound === run.designRound);
}

/** 成功完成本轮评审的评审方 */
export function okJudges(run: Run): DesignRole[] {
  const st = scopeState(run, reviewScope(run), run.designResolution?.reviewers ?? DESIGN_ROLES);
  return st.ok.filter((r): r is DesignRole => r === 'claude' || r === 'astra');
}

/**
 * Sol 强度规则：单一工作流 → Max；计划里有 ≥2 个互不依赖的工作流 → Ultra（子代理并行）。
 * 多个候选同时验证时，每个候选是一个独立作业（独立进程、独立工作区），作业内部仍按此规则。
 */
export function chooseSolEffort(p: Proposal | undefined): { effort: 'max' | 'ultra'; reason: string } {
  const ws = p?.mvpPlan.workstreams ?? [];
  const independent = ws.filter((w) => w.dependsOn.length === 0);
  if (ws.length >= 2 && independent.length >= 2) {
    return { effort: 'ultra', reason: `计划中有 ${independent.length} 个互不依赖的工作流，适合 Ultra（子代理并行）` };
  }
  return { effort: 'max', reason: '单一工作流（或工作流相互依赖），使用 Max' };
}

export function makeSpec(input: G2Input['specs'][number], comparisonQuestions: string[]): MvpSpec {
  const body = {
    candidateId: input.candidateId,
    goal: input.goal.trim(),
    scopeIn: input.scopeIn,
    scopeOut: input.scopeOut,
    acceptance: input.acceptance.map((a) => ({
      id: a.id,
      description: a.description,
      kind: a.kind,
      command: a.kind === 'command' ? (a.command ?? '').trim() || null : null,
      expectExitCode: a.kind === 'command' ? (a.expectExitCode ?? 0) : null,
      outputIncludes: a.outputIncludes ?? null,
    })),
    hypotheses: input.hypotheses,
    timeboxMinutes: input.timeboxMinutes,
    allowNetwork: input.allowNetwork,
    comparisonQuestions,
  };
  for (const a of body.acceptance) if (a.kind === 'command' && !a.command) throw new Error(`验收项 ${a.id} 是命令型但没有填写命令`);
  return { ref: `spec-${shortHash(body)}`, ...body };
}

/** G2 时给出的默认 MVP 规格（来自候选代表方案的 mvpPlan），界面用它预填、你可以编辑后确认 */
export function defaultSpecInput(p: Proposal, candidateId: string): G2Input['specs'][number] {
  return {
    candidateId,
    goal: p.mvpPlan.goal,
    scopeIn: p.mvpPlan.scopeIn,
    scopeOut: p.mvpPlan.scopeOut,
    acceptance: p.mvpPlan.acceptance.map((a) => ({ ...a, command: a.command ?? null, expectExitCode: a.expectExitCode ?? 0, outputIncludes: a.outputIncludes ?? null })),
    hypotheses: p.mvpPlan.hypotheses.map((h) => ({ id: h.id, text: h.text, passCriteria: h.passCriteria })),
    timeboxMinutes: 120,
    allowNetwork: true,
  };
}
