import { runMetrics, type FirstRoundVerification } from '../../src/core/metrics.js';
import type { Run, ValidationJob, VerificationResult } from '../../src/core/types.js';
import { CHECKS_HASH } from './v05-live-acceptance.js';

export interface H6RunEntry {
  run: Readonly<Run>;
  /** 由实验驱动显式提供，例如同一台机器、同一 CLI 安装与同一隔离配置的冻结标识。 */
  environmentId: string;
  fixtureEvidence?: {
    runId: string;
    observedChecksHash: string;
    /** 本机可信测试执行者在写者退出后独立复跑最终源码产生；不可复用 writer 工具日志。 */
    independentVerification: { sourceHash: string; checksHash: string; passed: boolean; evidencePath: string } | null;
  };
  cliEvidence: { codexVersion: string; claudeVersion: string };
}

export interface H6ReportInput {
  /** 固定 fixture 的审计标签；标签相同不会掩盖实际配置、规格或环境差异。 */
  fixtureLabel: string;
  entries: readonly H6RunEntry[];
  asOf?: string;
}

export type H6ReviewStatus = 'disabled' | 'pass' | 'fail' | 'cannot_verify' | 'mixed' | null;
export type H6FinalReviewStatus = 'disabled' | 'accept' | 'accept_with_notes' | 'reject' | 'mixed' | null;

export interface H6RunReport {
  runId: string;
  environmentId: string;
  switches: { evaluatorEnabled: boolean | null; finalReviewEnabled: boolean | null };
  modelMinutes: number | null;
  modelMinutesUnknownCount: number;
  wallClockMinutes: number | null;
  gateWaitMinutes: number | null;
  gateWaitUnknownCount: number;
  /** 关卡等待不是人工介入时间，二者不得互推。 */
  humanInterventionMinutes: null;
  firstRoundVerification: FirstRoundVerification | null;
  finalVerification: FirstRoundVerification | null;
  reworkRounds: number | null;
  claudeActualCalls: number | null;
  reviewStatus: H6ReviewStatus;
  finalReviewStatus: H6FinalReviewStatus;
  g4DecisionRecorded: boolean;
  decisionChanged: null;
  modelFailures: { taskId: string; role: string; phase: string; status: string; failureKind: string | null }[];
}

export interface H6PairedReport {
  fixtureLabel: string;
  executionComparable: boolean;
  experimentComplete: false;
  missingHumanEvidence: ('humanInterventionMinutes' | 'decisionChanged')[];
  incomparableReasons: string[];
  runs: H6RunReport[];
  causalConclusion: null;
  humanInterventionMinutes: null;
  decisionChanged: null;
}

const TERMINAL_JOB_STATUSES = new Set(['passed', 'failed', 'inconclusive', 'awaiting_manual', 'cancelled']);

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = semanticValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(semanticValue(value));
}

function currentSnapshot(run: Readonly<Run>): unknown {
  const snapshot = run.snapshots.find((item) => item.version === run.currentSnapshotVersion);
  if (!snapshot) return null;
  return {
    project: snapshot.project,
    constraints: snapshot.constraints,
    facts: snapshot.facts,
    assumptions: snapshot.assumptions,
    openItems: snapshot.openItems,
  };
}

function reviewOptionsWithoutSwitch(options: Run['evaluator']): unknown {
  if (!options) return null;
  const { enabled: _enabled, ...rest } = options;
  return rest;
}

function comparableSpec(job: Readonly<ValidationJob>): unknown {
  // spec.ref/candidateId 是每个运行重新生成的绑定身份；验收项、假设和其中的业务 ID 必须原样比较。
  const { ref: _ref, candidateId: _candidateId, ...semanticSpec } = job.spec;
  return semanticSpec;
}

function comparableJob(job: Readonly<ValidationJob>): unknown {
  return {
    spec: comparableSpec(job),
    effort: job.effort,
    autoRework: job.autoRework ?? null,
    maxRounds: job.maxRounds ?? null,
    budgetLimits: job.budget?.limits ?? null,
    lightRework: job.lightRework ?? null,
  };
}

function completeJobFreezeError(job: Readonly<ValidationJob>): string | null {
  if (job.effort !== 'max' && job.effort !== 'ultra') return 'effort';
  if (typeof job.maxRounds !== 'number') return 'maxRounds';
  if (typeof job.autoRework !== 'boolean') return 'autoRework';
  const limits = job.budget?.limits;
  if (!limits || !Number.isFinite(limits.maxRounds) || !Number.isFinite(limits.maxWriterSessions)
    || !Number.isFinite(limits.maxModelCalls) || !Number.isFinite(limits.maxActiveMinutes)) return 'budget.limits';
  if (job.maxRounds !== limits.maxRounds) return 'maxRounds 与 budget.limits.maxRounds 不一致';
  const light = job.lightRework;
  if (!light || typeof light.enabled !== 'boolean' || !Number.isFinite(light.minutes)
    || (light.capabilityRef !== null && typeof light.capabilityRef !== 'string')) return 'lightRework';
  return null;
}

function reportedModelMatches(requested: string, reported: string): boolean {
  return reported === requested || new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(reported);
}

function taskIdentityError(run: Readonly<Run>): string | null {
  for (const task of run.tasks) {
    if (task.acceptedDespiteMismatch === true) return `任务 ${task.id} 人工接受了型号不符`;
    const meta = task.meta;
    if (!meta) continue;
    if (meta.reportedModels.length > 0 && !meta.reportedModels.some((model) => reportedModelMatches(meta.requestedModel, model))) {
      return `任务 ${task.id} 回报型号不含请求型号 ${meta.requestedModel}`;
    }
    if (meta.reportedEffort && meta.reportedEffort !== meta.requestedEffort) {
      return `任务 ${task.id} 回报强度 ${meta.reportedEffort} 与请求 ${meta.requestedEffort} 不同`;
    }
  }
  return null;
}

function g2SelectsFrozenJobs(run: Readonly<Run>): boolean {
  const gate = run.gates.find((item) => item.id === 'G2_framework' && item.resolvedAt !== null);
  if (!gate || gate.resolution === null || typeof gate.resolution !== 'object') return false;
  const resolution = gate.resolution as { action?: unknown; candidateIds?: unknown; specs?: unknown };
  if (resolution.action !== 'validate' || !Array.isArray(resolution.candidateIds) || !Array.isArray(resolution.specs)) return false;
  const selected = new Set(resolution.candidateIds.filter((value): value is string => typeof value === 'string'));
  const specs: unknown[] = resolution.specs;
  return run.jobs.every((job) => {
    if (!selected.has(job.candidateId)) return false;
    const frozen = specs.find((value: unknown) => value !== null && typeof value === 'object'
      && (value as { candidateId?: unknown }).candidateId === job.candidateId) as Record<string, unknown> | undefined;
    if (!frozen) return false;
    const expected = {
      candidateId: job.spec.candidateId,
      goal: job.spec.goal,
      scopeIn: job.spec.scopeIn,
      scopeOut: job.spec.scopeOut,
      acceptance: job.spec.acceptance,
      hypotheses: job.spec.hypotheses,
      timeboxMinutes: job.spec.timeboxMinutes,
      allowNetwork: job.spec.allowNetwork,
    };
    return stableJson(frozen) === stableJson(expected);
  });
}

function knownCliVersions(run: Readonly<Run>): Map<string, string[]> {
  const versions = new Map<string, Set<string>>();
  for (const task of run.tasks) {
    const meta = task.meta;
    if (!meta?.cliVersion) continue;
    const key = `${task.role}|${meta.adapter}|${meta.requestedModel}|${meta.requestedEffort}`;
    const values = versions.get(key) ?? new Set<string>();
    values.add(meta.cliVersion);
    versions.set(key, values);
  }
  return new Map([...versions].map(([key, values]) => [key, [...values].sort()]));
}

function cliVersionDifferences(baseline: Readonly<Run>, candidate: Readonly<Run>): string[] {
  const baselineVersions = knownCliVersions(baseline);
  const candidateVersions = knownCliVersions(candidate);
  const commonKeys = [...baselineVersions.keys()].filter((key) => candidateVersions.has(key));
  return commonKeys.filter((key) => stableJson(baselineVersions.get(key)) !== stableJson(candidateVersions.get(key)));
}

function comparisonBasis(entry: H6RunEntry): Record<string, unknown> {
  const { run } = entry;
  return {
    mode: run.mode,
    environmentId: entry.environmentId,
    // run.title 是运行展示名，不是冻结实验条件；snapshot.project 的全部字段（含未来可能加入的 title）会比较。
    models: run.models,
    snapshot: currentSnapshot(run),
    criteria: run.criteria,
    jobs: run.jobs.map(comparableJob).map(semanticValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    clarifyWith: run.clarifyWith,
    allowWebResearch: run.allowWebResearch,
    preflight: run.preflight ?? null,
    build: run.build ?? null,
    evaluator: reviewOptionsWithoutSwitch(run.evaluator),
    finalReview: reviewOptionsWithoutSwitch(run.finalReview),
    contextBudget: run.contextBudget ?? null,
    chores: run.chores ?? null,
    writeDocs: run.writeDocs,
    writePrd: run.writePrd,
    docWriter: run.docWriter,
    docWriters: run.docWriters ?? null,
    decisionParams: run.decisionParams,
    designMode: run.designMode ?? null,
    riskLevel: run.riskLevel ?? null,
  };
}

function verificationSummary(jobs: readonly Readonly<ValidationJob>[]): FirstRoundVerification | null {
  const items: FirstRoundVerification['jobs'] = [];
  for (const job of jobs) {
    const verdict = (job.verification as VerificationResult | null)?.verdict;
    if (verdict !== 'passed' && verdict !== 'failed' && verdict !== 'inconclusive' && verdict !== 'awaiting_manual') return null;
    items.push({ jobId: job.id, verdict });
  }
  if (items.length === 0) return null;
  const distinct = new Set(items.map((item) => item.verdict));
  return { conclusion: distinct.size === 1 ? items[0]!.verdict : 'mixed', jobs: items };
}

function combined<T extends string>(values: T[]): T | 'mixed' | null {
  if (values.length === 0) return null;
  return new Set(values).size === 1 ? values[0]! : 'mixed';
}

function reviewStatus(run: Readonly<Run>): H6ReviewStatus {
  if (run.evaluator?.enabled === false) return 'disabled';
  if (run.evaluator?.enabled !== true) return null;
  const verdicts = run.jobs.flatMap((job) => (job.rounds ?? []).map((round) => round.evaluation?.verdict).filter((value): value is 'pass' | 'fail' | 'cannot_verify' => typeof value === 'string'));
  return combined(verdicts);
}

function finalReviewStatus(run: Readonly<Run>): H6FinalReviewStatus {
  if (run.finalReview?.enabled === false) return 'disabled';
  if (run.finalReview?.enabled !== true) return null;
  const verdicts = run.jobs.map((job) => job.finalReview?.verdict).filter((value): value is 'accept' | 'accept_with_notes' | 'reject' => typeof value === 'string');
  return combined(verdicts);
}

function claudeCalls(run: Readonly<Run>): number | null {
  const tasks = run.tasks.filter((task) => task.role === 'claude');
  let calls = 0;
  for (const task of tasks) {
    // 预检/准备失败且明确未创建进程是已知零调用。
    if (task.meta?.processStarted === false) continue;
    // 旧任务缺 calls 或缺实际启动证据，不能把任务完成状态冒充为一次真实调用。
    if (task.executionCalls === undefined || task.meta?.processStarted !== true) return null;
    calls += task.executionCalls.length;
  }
  return calls;
}

function reportRun(entry: H6RunEntry, asOf: string): H6RunReport {
  const { run } = entry;
  const metrics = runMetrics(run, asOf);
  const rounds = run.jobs.flatMap((job) => job.rounds ?? []);
  return {
    runId: run.id,
    environmentId: entry.environmentId,
    switches: { evaluatorEnabled: run.evaluator?.enabled ?? null, finalReviewEnabled: run.finalReview?.enabled ?? null },
    modelMinutes: metrics.modelTime.total.unknownCount === 0 ? metrics.modelTime.total.minutes : null,
    modelMinutesUnknownCount: metrics.modelTime.total.unknownCount,
    wallClockMinutes: metrics.wallClockMinutes,
    gateWaitMinutes: metrics.gateWait.total.unknownCount === 0 ? metrics.gateWait.total.minutes : null,
    gateWaitUnknownCount: metrics.gateWait.total.unknownCount,
    humanInterventionMinutes: null,
    firstRoundVerification: metrics.firstRoundVerification,
    finalVerification: verificationSummary(run.jobs),
    reworkRounds: run.jobs.some((job) => !Array.isArray(job.rounds)) ? null : rounds.filter((round) => round.kind === 'rework').length,
    claudeActualCalls: claudeCalls(run),
    reviewStatus: reviewStatus(run),
    finalReviewStatus: finalReviewStatus(run),
    g4DecisionRecorded: run.gates.some((gate) => gate.id === 'G4_final' && gate.resolvedAt !== null && gate.resolution !== null),
    decisionChanged: null,
    modelFailures: run.tasks.filter((task) => task.status === 'failed' || task.status === 'timed_out' || task.status === 'cancelled' || task.status === 'interrupted').map((task) => ({
      taskId: task.id, role: task.role, phase: task.phase, status: task.status, failureKind: task.failure?.kind ?? null,
    })),
  };
}

export function buildH6PairedReport(input: H6ReportInput): H6PairedReport {
  const reasons: string[] = [];
  const asOf = input.asOf ?? new Date().toISOString();
  if (!input.fixtureLabel.trim()) reasons.push('fixtureLabel 不能为空');
  if (input.entries.length !== 2 && input.entries.length !== 3) reasons.push('H6 执行比较只接受两个成对运行或 off/evaluate/both 三运行组');
  if (new Set(input.entries.map((entry) => entry.run.id)).size !== input.entries.length) reasons.push('运行 ID 重复');

  if (input.entries.some((entry) => entry.run.mode !== 'real')) reasons.push('H6 执行比较只接受 mode=real 的运行');
  input.entries.forEach((entry) => {
    if (!entry.environmentId.trim()) reasons.push(`运行 ${entry.run.id} 缺少 CLI 实验环境标识`);
    if (!currentSnapshot(entry.run)) reasons.push(`运行 ${entry.run.id} 缺少当前冻结需求快照，无法核对需求与约束`);
    if (!entry.run.build) reasons.push(`运行 ${entry.run.id} 缺少冻结构建预算`);
    if (!entry.run.contextBudget) reasons.push(`运行 ${entry.run.id} 缺少冻结上下文预算`);
    if (entry.run.metricsConfig?.version !== 1 || !entry.run.metricsConfig.fingerprint) reasons.push(`运行 ${entry.run.id} 缺少有效的冻结配置记录`);
    if (entry.run.metricsConfig?.drifted === true) reasons.push(`运行 ${entry.run.id} 的冻结配置已漂移`);
    if (entry.run.jobs.length === 0) reasons.push(`运行 ${entry.run.id} 没有验证作业`);
    if (entry.run.jobs.some((job) => !TERMINAL_JOB_STATUSES.has(job.status))) reasons.push(`运行 ${entry.run.id} 存在未结束的验证作业`);
    for (const job of entry.run.jobs) {
      const error = completeJobFreezeError(job);
      if (error) reasons.push(`运行 ${entry.run.id} 的作业 ${job.id} 缺少完整冻结字段：${error}`);
    }
    if (entry.run.evaluator?.enabled === undefined || entry.run.finalReview?.enabled === undefined) reasons.push(`运行 ${entry.run.id} 缺少评审或终审开关`);
    const identityError = taskIdentityError(entry.run);
    if (identityError) reasons.push(`运行 ${entry.run.id} 的模型身份证据无效：${identityError}`);
    if (!g2SelectsFrozenJobs(entry.run)) reasons.push(`运行 ${entry.run.id} 缺少已解决且与作业候选/规格一致的 G2 validate 记录`);
    const evidence = entry.fixtureEvidence;
    if (!evidence?.runId.trim() || !evidence.observedChecksHash.trim()) reasons.push(`运行 ${entry.run.id} 缺少完整 fixture 检查证据`);
    else {
      if (evidence.runId !== entry.run.id) reasons.push(`运行 ${entry.run.id} 的 fixture 证据绑定了其他运行 ${evidence.runId}`);
      if (evidence.observedChecksHash !== CHECKS_HASH) reasons.push(`运行 ${entry.run.id} 的 fixture 实测检查哈希与脚本常量不一致`);
      const independent = evidence.independentVerification;
      if (!independent) reasons.push(`运行 ${entry.run.id} 缺少写者结束后的独立 fixture 复跑证据`);
      else {
        if (independent.passed !== true) reasons.push(`运行 ${entry.run.id} 的独立 fixture 复跑未通过`);
        if (independent.checksHash !== CHECKS_HASH) reasons.push(`运行 ${entry.run.id} 的独立 fixture 复跑检查哈希不匹配`);
        if (!/^[a-f0-9]{64}$/i.test(independent.sourceHash)) reasons.push(`运行 ${entry.run.id} 的独立 fixture 复跑缺少有效源码哈希`);
        if (!independent.evidencePath.trim()) reasons.push(`运行 ${entry.run.id} 的独立 fixture 复跑缺少证据路径`);
      }
    }
    const cli = entry.cliEvidence;
    if (!cli?.codexVersion.trim() || !cli.claudeVersion.trim()) reasons.push(`运行 ${entry.run.id} 缺少完整 CLI 版本证据`);
  });

  const cliEvidence = new Set(input.entries.map((entry) => entry.cliEvidence
    ? `${entry.cliEvidence.codexVersion}\u0000${entry.cliEvidence.claudeVersion}` : 'missing'));
  if (cliEvidence.size > 1) reasons.push('不同运行的 CLI preflight 版本证据不一致');

  const switchKeys = input.entries.map((entry) => `${entry.run.evaluator?.enabled === true ? 1 : 0}${entry.run.finalReview?.enabled === true ? 1 : 0}`);
  if (input.entries.length === 2) {
    const distance = switchKeys[0] && switchKeys[1]
      ? [...switchKeys[0]].filter((bit, index) => bit !== switchKeys[1]![index]).length
      : 0;
    if (new Set(switchKeys).size !== 2 || distance !== 1) reasons.push('两个运行必须且只能有一个 evaluator/finalReview enable 位不同');
  }
  if (input.entries.length === 3 && stableJson([...switchKeys].sort()) !== stableJson(['00', '10', '11'])) {
    reasons.push('三个运行必须恰好组成 off/evaluate/both（00/10/11）且不得缺失或重复');
  }

  if (input.entries.length > 1) {
    const baseline = comparisonBasis(input.entries[0]!);
    for (const entry of input.entries.slice(1)) {
      const candidate = comparisonBasis(entry);
      for (const key of Object.keys(baseline)) {
        if (stableJson(candidate[key]) !== stableJson(baseline[key])) {
          reasons.push(`运行 ${entry.run.id} 与 ${input.entries[0]!.run.id} 的 ${key} 不同（该差异不是 evaluator.enabled/finalReview.enabled 开关）`);
        }
      }
      for (const cliKey of cliVersionDifferences(input.entries[0]!.run, entry.run)) {
        reasons.push(`运行 ${entry.run.id} 与 ${input.entries[0]!.run.id} 的 CLI 版本不同：${cliKey}`);
      }
    }
  }

  return {
    fixtureLabel: input.fixtureLabel,
    executionComparable: reasons.length === 0,
    experimentComplete: false,
    missingHumanEvidence: ['humanInterventionMinutes', 'decisionChanged'],
    incomparableReasons: [...new Set(reasons)],
    runs: input.entries.map((entry) => reportRun(entry, asOf)),
    causalConclusion: null,
    humanInterventionMinutes: null,
    decisionChanged: null,
  };
}
