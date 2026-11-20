import type { GateId, ModelRole, Run, TaskStatus } from './types.js';

export type MetricTaskStatus = 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'running' | 'unknown';
export type MetricCallKind = 'initial' | 'repair' | 'unknown';

export interface DurationMetric {
  minutes: number;
  knownCount: number;
  unknownCount: number;
}

export interface ModelTimeBucket extends DurationMetric {
  phase: string;
  role: ModelRole;
  kind: MetricCallKind;
  status: MetricTaskStatus;
}

export interface GateWaitMetric extends DurationMetric {
  gate: GateId;
}

export interface FirstRoundVerification {
  conclusion: 'passed' | 'failed' | 'inconclusive' | 'awaiting_manual' | 'mixed';
  jobs: { jobId: string; verdict: 'passed' | 'failed' | 'inconclusive' | 'awaiting_manual' }[];
}

export interface MetricsGrouping {
  mode: 'mock' | 'live';
  specRefs: string[];
  frozenConfigFingerprint: string | null;
}

export interface ContextSessionMetric {
  jobId: string;
  round: number;
  sessionId: string;
  kind: 'init' | 'milestone';
  milestoneIds: string[];
  usageSemantics: 'unknown' | 'per_turn_context' | 'cumulative';
  usageSource: string | null;
  contextWindow: number | null;
  contextTokensPeak: number | null;
  contextRatioPeak: number | null;
  compactions: number | null;
  promptEstimate: { estimatedTokens: number; targetTokens: number; estimateReference: string } | null;
}

export interface ContextHealthMetric {
  enabled: boolean | null;
  knownSessions: number;
  unknownSessions: number;
  sessions: ContextSessionMetric[];
}

export interface RunMetrics {
  runId: string;
  asOf: string;
  grouping: MetricsGrouping;
  modelTime: { total: DurationMetric; buckets: ModelTimeBucket[] };
  wallClockMinutes: number | null;
  gateWait: { total: DurationMetric; gates: GateWaitMetric[] };
  clarification: { questionCount: number; answeredCount: number; answerRate: number | null };
  firstRoundVerification: FirstRoundVerification | null;
  buildAttempts: number;
  buildRounds: number | null;
  reviewSequence: string[] | null;
  quotaBlocks: number;
  /** T12+；旧指标消费者可缺省，runMetrics 总会生成。 */
  contextHealth?: ContextHealthMetric;
}

export interface AggregateMetricsGroup {
  key: string;
  grouping: MetricsGrouping;
  runCount: number;
  comparable: boolean;
  modelTime: DurationMetric;
  wallClock: DurationMetric;
  gateWait: DurationMetric;
  clarification: { questionCount: number; answeredCount: number; answerRate: number | null };
  buildAttempts: number;
  quotaBlocks: number;
}

export interface AggregateMetrics {
  runCount: number;
  groups: AggregateMetricsGroup[];
  causalConclusion: null;
}

type FutureRound = {
  round?: unknown;
  verification?: { verdict?: unknown } | null;
  evaluation?: { verdict?: unknown } | null;
};

function msBetween(start: unknown, end: unknown): number | null {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
}

function metricStatus(status: TaskStatus): MetricTaskStatus {
  if (status === 'timed_out' || status === 'failed') return 'failed';
  return status === 'queued' ? 'unknown' : status;
}

function addDuration(target: DurationMetric, durationMs: number | null): void {
  if (durationMs === null) target.unknownCount += 1;
  else {
    target.minutes += durationMs / 60_000;
    target.knownCount += 1;
  }
}

function finishMetric<T extends DurationMetric>(metric: T): T {
  metric.minutes = Number(metric.minutes.toFixed(6));
  return metric;
}

function frozenConfigFingerprint(run: Run): string | null {
  const config = run.metricsConfig;
  return config?.version === 1 && config.drifted !== true && typeof config.fingerprint === 'string' && config.fingerprint.length > 0
    ? config.fingerprint
    : null;
}

function firstRoundVerification(run: Run): FirstRoundVerification | null {
  const jobs: FirstRoundVerification['jobs'] = [];
  for (const job of run.jobs) {
    const futureJob = job as unknown as { firstVerification?: { verdict?: unknown } | null; rounds?: FutureRound[] };
    let verdict: unknown;
    if (Object.hasOwn(futureJob, 'firstVerification')) {
      if (futureJob.firstVerification === null) return null;
      verdict = futureJob.firstVerification?.verdict;
    } else {
      const rounds = futureJob.rounds;
      if (!Array.isArray(rounds) || rounds.length === 0) return null;
      const first = [...rounds].sort((a, b) => Number(a.round) - Number(b.round))[0];
      if (first?.round !== 1) return null;
      verdict = first.verification?.verdict;
    }
    if (verdict !== 'passed' && verdict !== 'failed' && verdict !== 'inconclusive' && verdict !== 'awaiting_manual') return null;
    jobs.push({ jobId: job.id, verdict });
  }
  if (jobs.length === 0) return null;
  const distinct = new Set(jobs.map((job) => job.verdict));
  return { conclusion: distinct.size === 1 ? jobs[0]!.verdict : 'mixed', jobs };
}

function futureRoundMetrics(run: Run): { buildRounds: number | null; reviewSequence: string[] | null } {
  if (run.jobs.length === 0) return { buildRounds: null, reviewSequence: null };
  const allRounds = run.jobs.map((job) => (job as unknown as { rounds?: FutureRound[] }).rounds);
  if (allRounds.some((rounds) => !Array.isArray(rounds))) return { buildRounds: null, reviewSequence: null };
  const rounds = allRounds.flatMap((item) => item ?? []);
  const reviews: string[] = [];
  for (const round of rounds) {
    const verdict = round.evaluation?.verdict;
    if (typeof verdict === 'string') reviews.push(verdict);
  }
  return { buildRounds: rounds.length, reviewSequence: reviews };
}

function contextHealth(run: Run): ContextHealthMetric {
  const sessions: ContextSessionMetric[] = [];
  for (const job of run.jobs) {
    for (const round of job.rounds ?? []) {
      for (const session of round.context?.sessions ?? []) {
        sessions.push({
          jobId: job.id,
          round: round.round,
          sessionId: session.id,
          kind: session.kind,
          milestoneIds: [...session.milestoneIds],
          usageSemantics: session.context.usageSemantics,
          usageSource: session.context.usageSource,
          contextWindow: session.context.contextWindow,
          contextTokensPeak: session.context.contextTokensPeak,
          contextRatioPeak: session.context.contextRatioPeak,
          compactions: session.context.compactions,
          promptEstimate: session.material ? {
            estimatedTokens: session.material.estimatedTokens,
            targetTokens: session.material.targetTokens,
            estimateReference: session.material.estimateReference,
          } : null,
        });
      }
    }
  }
  const knownSessions = sessions.filter((session) => session.usageSemantics === 'per_turn_context'
    && session.contextWindow !== null && session.contextTokensPeak !== null).length;
  return {
    enabled: run.contextBudget?.enabled ?? null,
    knownSessions,
    unknownSessions: sessions.length - knownSessions,
    sessions,
  };
}

export function runMetrics(run: Readonly<Run>, asOf = new Date().toISOString()): RunMetrics {
  const bucketMap = new Map<string, ModelTimeBucket>();
  const total: DurationMetric = { minutes: 0, knownCount: 0, unknownCount: 0 };
  for (const task of run.tasks) {
    if (task.executionCalls === undefined) {
      const key = `${task.phase}\u0000${task.role}\u0000unknown\u0000unknown`;
      const bucket = bucketMap.get(key) ?? { phase: task.phase, role: task.role, kind: 'unknown', status: 'unknown', minutes: 0, knownCount: 0, unknownCount: 0 };
      addDuration(bucket, null);
      addDuration(total, null);
      bucketMap.set(key, bucket);
      continue;
    }
    for (const call of task.executionCalls) {
      const status = metricStatus(call.status);
      const key = `${task.phase}\u0000${task.role}\u0000${call.kind}\u0000${status}`;
      const bucket = bucketMap.get(key) ?? { phase: task.phase, role: task.role, kind: call.kind, status, minutes: 0, knownCount: 0, unknownCount: 0 };
      const duration = call.status === 'running' ? msBetween(call.startedAt, asOf) : msBetween(call.startedAt, call.endedAt);
      addDuration(bucket, duration);
      addDuration(total, duration);
      bucketMap.set(key, bucket);
    }
  }

  const gateMap = new Map<GateId, GateWaitMetric>();
  const gateTotal: DurationMetric = { minutes: 0, knownCount: 0, unknownCount: 0 };
  for (const gate of run.gates) {
    const metric = gateMap.get(gate.id) ?? { gate: gate.id, minutes: 0, knownCount: 0, unknownCount: 0 };
    const duration = msBetween(gate.openedAt, gate.resolvedAt ?? (run.terminal === null ? asOf : null));
    addDuration(metric, duration);
    addDuration(gateTotal, duration);
    gateMap.set(gate.id, metric);
  }

  const questionCount = run.questions.filter((question) => question.phase === 'clarify').length;
  const answeredCount = run.questions.filter((question) => question.phase === 'clarify' && question.status === 'answered').length;
  const future = futureRoundMetrics(run);
  const specRefs = [...new Set(run.jobs.map((job) => job.spec.ref))].sort();
  const wallEnd = run.terminal === null ? asOf : run.updatedAt;

  return {
    runId: run.id,
    asOf,
    grouping: { mode: run.mode === 'mock' ? 'mock' : 'live', specRefs, frozenConfigFingerprint: frozenConfigFingerprint(run as Run) },
    modelTime: {
      total: finishMetric(total),
      buckets: [...bucketMap.values()].map(finishMetric).sort((a, b) => `${a.phase}/${a.role}/${a.kind}/${a.status}`.localeCompare(`${b.phase}/${b.role}/${b.kind}/${b.status}`)),
    },
    wallClockMinutes: (() => {
      const ms = msBetween(run.createdAt, wallEnd);
      return ms === null ? null : Number((ms / 60_000).toFixed(6));
    })(),
    gateWait: { total: finishMetric(gateTotal), gates: [...gateMap.values()].map(finishMetric).sort((a, b) => a.gate.localeCompare(b.gate)) },
    clarification: { questionCount, answeredCount, answerRate: questionCount === 0 ? null : answeredCount / questionCount },
    firstRoundVerification: firstRoundVerification(run as Run),
    buildAttempts: run.tasks.filter((task) => task.phase === 'build' && task.status !== 'queued').length,
    buildRounds: future.buildRounds,
    reviewSequence: future.reviewSequence,
    quotaBlocks: run.tasks.filter((task) => task.failure?.kind === 'rate_limited').length,
    contextHealth: contextHealth(run as Run),
  };
}

export function aggregateMetrics(runs: readonly Readonly<Run>[], asOf = new Date().toISOString()): AggregateMetrics {
  const grouped = new Map<string, AggregateMetricsGroup>();
  for (const run of runs) {
    const metrics = runMetrics(run, asOf);
    const key = `${metrics.grouping.mode}|${metrics.grouping.specRefs.join(',')}|${metrics.grouping.frozenConfigFingerprint ?? 'unknown'}`;
    const group = grouped.get(key) ?? {
      key,
      grouping: metrics.grouping,
      runCount: 0,
      comparable: metrics.grouping.frozenConfigFingerprint !== null && metrics.grouping.specRefs.length > 0,
      modelTime: { minutes: 0, knownCount: 0, unknownCount: 0 },
      wallClock: { minutes: 0, knownCount: 0, unknownCount: 0 },
      gateWait: { minutes: 0, knownCount: 0, unknownCount: 0 },
      clarification: { questionCount: 0, answeredCount: 0, answerRate: null },
      buildAttempts: 0,
      quotaBlocks: 0,
    };
    group.runCount += 1;
    group.modelTime.minutes += metrics.modelTime.total.minutes;
    group.modelTime.knownCount += metrics.modelTime.total.knownCount;
    group.modelTime.unknownCount += metrics.modelTime.total.unknownCount;
    addDuration(group.wallClock, metrics.wallClockMinutes === null ? null : metrics.wallClockMinutes * 60_000);
    group.gateWait.minutes += metrics.gateWait.total.minutes;
    group.gateWait.knownCount += metrics.gateWait.total.knownCount;
    group.gateWait.unknownCount += metrics.gateWait.total.unknownCount;
    group.clarification.questionCount += metrics.clarification.questionCount;
    group.clarification.answeredCount += metrics.clarification.answeredCount;
    group.clarification.answerRate = group.clarification.questionCount === 0 ? null : group.clarification.answeredCount / group.clarification.questionCount;
    group.buildAttempts += metrics.buildAttempts;
    group.quotaBlocks += metrics.quotaBlocks;
    grouped.set(key, group);
  }

  return {
    runCount: runs.length,
    groups: [...grouped.values()].map((group) => ({
      ...group,
      modelTime: finishMetric(group.modelTime),
      wallClock: finishMetric(group.wallClock),
      gateWait: finishMetric(group.gateWait),
    })).sort((a, b) => a.key.localeCompare(b.key)),
    causalConclusion: null,
  };
}
