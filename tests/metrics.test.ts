import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMetrics, runMetrics } from '../src/core/metrics.js';
import type { Run, TaskRecord } from '../src/core/types.js';

const baseTime = '2026-10-21T00:00:00.000Z';
const asOf = '2026-10-21T01:00:00.000Z';

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    runId: 'r-test',
    role: 'claude',
    phase: 'clarify',
    scope: 'clarify',
    attempt: 1,
    rootTaskId: id,
    status: 'succeeded',
    outputValidity: 'valid',
    validationErrors: [],
    repairAttempted: false,
    failure: null,
    createdAt: baseTime,
    startedAt: baseTime,
    endedAt: '2026-10-21T00:10:00.000Z',
    lastProgress: null,
    lastProgressAt: null,
    meta: null,
    simulated: true,
    jobId: null,
    acceptedDespiteMismatch: false,
    inputRef: null,
    executionCalls: [],
    ...patch,
  };
}

function syntheticRun(patch: Record<string, unknown> = {}): Run {
  return {
    id: 'r-test',
    title: '合成运行',
    createdAt: baseTime,
    updatedAt: '2026-10-21T00:50:00.000Z',
    mode: 'mock',
    mockScenario: 'test',
    phase: 'validate',
    phaseStatus: 'running',
    blockedReason: null,
    terminal: null,
    models: {
      claude: { role: 'claude', adapter: 'mock', model: 'claude-test', effort: 'max' },
      astra: { role: 'astra', adapter: 'mock', model: 'astra-test', effort: 'max' },
      sol: { role: 'sol', adapter: 'mock', model: 'sol-test', effort: 'max' },
    },
    clarifyWith: 'both',
    allowWebResearch: false,
    writeDocs: false,
    writePrd: false,
    docWriter: { role: 'claude', model: 'claude-test', effort: 'max' },
    docs: { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 },
    criteria: [],
    criteriaLockedAt: null,
    decisionParams: { delta: 0.5, preferenceMargin: 0.2, tieEpsilon: 0.01 },
    snapshots: [],
    currentSnapshotVersion: 1,
    designSnapshotVersion: null,
    degraded: [],
    tasks: [],
    questions: [],
    modelNotes: [],
    proposals: [],
    judgments: [],
    equivalenceGroups: {},
    manualMerges: [],
    candidates: [],
    overrides: [],
    decision: null,
    anonymization: null,
    recheckBatch: 0,
    recheckRequests: [],
    recheckLog: [],
    gates: [],
    jobBatch: 0,
    jobs: [],
    finalChoice: null,
    designRound: 1,
    archivedRounds: [],
    ...patch,
  } as unknown as Run;
}

test('模型耗时按阶段、角色、状态分桶，进行中使用固定 asOf，坏时间显式 unknown', () => {
  const run = syntheticRun({
    tasks: [
      task('ok', { role: 'claude', phase: 'propose', executionCalls: [{ kind: 'initial', status: 'succeeded', startedAt: baseTime, endedAt: '2026-10-21T00:10:00.000Z' }] }),
      task('repair', {
        role: 'claude', phase: 'propose', repairAttempted: true,
        executionCalls: [
          { kind: 'initial', status: 'succeeded', startedAt: baseTime, endedAt: '2026-10-21T00:05:00.000Z' },
          { kind: 'repair', status: 'succeeded', startedAt: '2026-10-21T00:05:00.000Z', endedAt: '2026-10-21T00:07:00.000Z' },
        ],
        meta: { durationMs: 999_999 } as TaskRecord['meta'],
      }),
      task('failed', { role: 'astra', phase: 'review', status: 'timed_out', executionCalls: [{ kind: 'initial', status: 'timed_out', startedAt: baseTime, endedAt: '2026-10-21T00:20:00.000Z' }] }),
      task('running', { role: 'sol', phase: 'build', status: 'running', executionCalls: [{ kind: 'initial', status: 'running', startedAt: '2026-10-21T00:30:00.000Z', endedAt: null }] }),
      task('bad', { status: 'cancelled', executionCalls: [{ kind: 'initial', status: 'cancelled', startedAt: '2026-10-21T00:20:00.000Z', endedAt: '2026-10-21T00:10:00.000Z' }] }),
      task('missing', { status: 'interrupted', executionCalls: [{ kind: 'initial', status: 'interrupted', startedAt: baseTime, endedAt: null }] }),
      task('queued', { role: 'sol', phase: 'build', status: 'queued', executionCalls: [] }),
    ],
  });

  const metrics = runMetrics(run, asOf);
  assert.deepEqual(metrics.modelTime.total, { minutes: 67, knownCount: 5, unknownCount: 2 });
  assert.deepEqual(metrics.modelTime.buckets.find((bucket) => bucket.phase === 'propose' && bucket.role === 'claude' && bucket.kind === 'initial'), {
    phase: 'propose', role: 'claude', kind: 'initial', status: 'succeeded', minutes: 15, knownCount: 2, unknownCount: 0,
  });
  assert.equal(metrics.modelTime.buckets.find((bucket) => bucket.kind === 'repair')?.minutes, 2);
  assert.equal(metrics.modelTime.buckets.find((bucket) => bucket.status === 'failed')?.minutes, 20);
  assert.equal(metrics.modelTime.buckets.find((bucket) => bucket.status === 'cancelled')?.unknownCount, 1);
  assert.equal(metrics.buildAttempts, 1);
});

test('墙钟、关卡等待和澄清作答分别计算，终止运行未关闭关卡为 unknown', () => {
  const run = syntheticRun({
    terminal: 'done',
    questions: [
      { phase: 'clarify', status: 'answered' },
      { phase: 'clarify', status: 'skipped' },
      { phase: 'build', status: 'answered' },
    ],
    gates: [
      { id: 'G1_answers', openedAt: baseTime, resolvedAt: '2026-10-21T00:10:00.000Z', resolution: {}, context: {} },
      { id: 'G2_framework', openedAt: '2026-10-21T00:20:00.000Z', resolvedAt: null, resolution: null, context: {} },
    ],
  });
  const metrics = runMetrics(run, asOf);
  assert.equal(metrics.wallClockMinutes, 50);
  assert.deepEqual(metrics.gateWait.total, { minutes: 10, knownCount: 1, unknownCount: 1 });
  assert.deepEqual(metrics.clarification, { questionCount: 2, answeredCount: 1, answerRate: 0.5 });
});

test('旧作业不猜 T7 轮次和首轮核验；有 rounds 归档时给出轮次与评审序列', () => {
  const legacy = syntheticRun({ jobs: [{ id: 'j1', spec: { ref: 'spec-a' }, verification: { verdict: 'passed' } }] });
  assert.equal(runMetrics(legacy, asOf).firstRoundVerification, null);
  assert.equal(runMetrics(legacy, asOf).buildRounds, null);
  assert.equal(runMetrics(legacy, asOf).reviewSequence, null);

  const current = syntheticRun({
    jobs: [
      {
        id: 'j1', spec: { ref: 'spec-a' },
        rounds: [
          { round: 1, verification: { verdict: 'failed' }, evaluation: { verdict: 'fail' } },
          { round: 2, verification: { verdict: 'passed' }, evaluation: { verdict: 'pass' } },
        ],
      },
    ],
  });
  const metrics = runMetrics(current, asOf);
  assert.deepEqual(metrics.firstRoundVerification, { conclusion: 'failed', jobs: [{ jobId: 'j1', verdict: 'failed' }] });
  assert.equal(metrics.buildRounds, 2);
  assert.deepEqual(metrics.reviewSequence, ['fail', 'pass']);
});

test('首轮核验优先使用不可变快照，后续当前核验通过不覆盖首轮失败', () => {
  const run = syntheticRun({
    jobs: [{
      id: 'j1',
      spec: { ref: 'spec-a' },
      firstVerification: { verdict: 'failed' },
      verification: { verdict: 'passed' },
    }],
  });
  const metrics = runMetrics(run, asOf);
  assert.equal(metrics.asOf, asOf);
  assert.deepEqual(metrics.firstRoundVerification, { conclusion: 'failed', jobs: [{ jobId: 'j1', verdict: 'failed' }] });

  const pending = syntheticRun({ jobs: [{ id: 'j1', spec: { ref: 'spec-a' }, firstVerification: null, verification: { verdict: 'passed' } }] });
  assert.equal(runMetrics(pending, asOf).firstRoundVerification, null);
});

test('配置指纹只信任未漂移的 metricsConfig，跨运行按 mock/live、规格集合和指纹分组且不做因果结论', () => {
  const old = syntheticRun({ id: 'old', mode: 'real', jobs: [{ id: 'j1', spec: { ref: 'spec-a' } }] });
  const configA = syntheticRun({ id: 'config-a', metricsConfig: { version: 1, fingerprint: 'cfg-a' }, jobs: [{ id: 'j1', spec: { ref: 'spec-b' } }] });
  const configB = syntheticRun({ id: 'config-b', metricsConfig: { version: 1, fingerprint: 'cfg-b' }, jobs: [{ id: 'j1', spec: { ref: 'spec-b' } }] });
  const configAAgain = syntheticRun({ id: 'config-a-2', metricsConfig: { version: 1, fingerprint: 'cfg-a' }, jobs: [{ id: 'j1', spec: { ref: 'spec-b' } }] });
  const drifted = syntheticRun({ id: 'drifted', metricsConfig: { version: 1, fingerprint: 'cfg-a', drifted: true }, jobs: [{ id: 'j1', spec: { ref: 'spec-b' } }] });

  assert.equal(runMetrics(old, asOf).grouping.frozenConfigFingerprint, null);
  assert.equal(runMetrics(drifted, asOf).grouping.frozenConfigFingerprint, null);
  assert.notEqual(runMetrics(configA, asOf).grouping.frozenConfigFingerprint, runMetrics(configB, asOf).grouping.frozenConfigFingerprint);
  const aggregate = aggregateMetrics([old, configA, configB, configAAgain, drifted], asOf);
  assert.equal(aggregate.groups.length, 4);
  assert.equal(aggregate.groups.find((group) => group.grouping.frozenConfigFingerprint === null)?.comparable, false);
  assert.equal(aggregate.groups.find((group) => group.runCount === 2)?.comparable, true);
  assert.equal(aggregate.causalConclusion, null);
});

test('准备失败的空 calls 是零调用，旧任务无 calls 和恢复中断缺结束时间都是 unknown', () => {
  const run = syntheticRun({
    tasks: [
      task('preflight-failed', { status: 'failed', executionCalls: [] }),
      task('legacy', { status: 'succeeded', executionCalls: undefined }),
      task('recovered', { status: 'interrupted', executionCalls: [{ kind: 'initial', status: 'interrupted', startedAt: baseTime, endedAt: null }] }),
    ],
  });
  const metrics = runMetrics(run, asOf);
  assert.deepEqual(metrics.modelTime.total, { minutes: 0, knownCount: 0, unknownCount: 2 });
  assert.equal(metrics.modelTime.buckets.find((bucket) => bucket.kind === 'unknown')?.unknownCount, 1);
  assert.equal(metrics.modelTime.buckets.find((bucket) => bucket.status === 'interrupted')?.unknownCount, 1);
});

test('配额阻塞按任务记录计数，输入对象保持只读', () => {
  const run = syntheticRun({
    tasks: [
      task('quota-1', { status: 'failed', failure: { kind: 'rate_limited', message: 'limit' } }),
      task('quota-2', { status: 'failed', failure: { kind: 'rate_limited', message: 'limit' } }),
    ],
  });
  const before = structuredClone(run);
  assert.equal(runMetrics(run, asOf).quotaBlocks, 2);
  assert.deepEqual(run, before);
});

test('contextHealth逐会话保留实际观测unknown，并与提示材料估算分开', () => {
  const legacy = runMetrics(syntheticRun(), asOf).contextHealth;
  assert.ok(legacy);
  assert.deepEqual(legacy, { enabled: null, knownSessions: 0, unknownSessions: 0, sessions: [] });

  const run = syntheticRun({
    contextBudget: { enabled: true },
    jobs: [{ id: 'j1', spec: { ref: 'spec-a' }, rounds: [{
      round: 1,
      context: { sessions: [
        {
          id: 's-known', kind: 'milestone', milestoneIds: ['M1'],
          context: { usageRaw: {}, usageSource: 'server_usage', usageSemantics: 'per_turn_context', contextWindow: 200_000, contextTokensPeak: 50_000, contextRatioPeak: 0.25, compactions: 0 },
          material: { estimatedTokens: 12_000, targetTokens: 40_000, estimateReference: 'chars/2.5', omitted: [] },
        },
        {
          id: 's-unknown', kind: 'milestone', milestoneIds: ['M2'],
          context: { usageRaw: null, usageSource: null, usageSemantics: 'unknown', contextWindow: null, contextTokensPeak: null, contextRatioPeak: null, compactions: null },
        },
      ] },
    }] }],
  });
  const health = runMetrics(run, asOf).contextHealth;
  assert.ok(health);
  assert.equal(health.enabled, true);
  assert.equal(health.knownSessions, 1);
  assert.equal(health.unknownSessions, 1);
  assert.deepEqual(health.sessions[0]!.promptEstimate, { estimatedTokens: 12_000, targetTokens: 40_000, estimateReference: 'chars/2.5' });
  assert.equal(health.sessions[0]!.compactions, 0);
  assert.equal(health.sessions[1]!.contextWindow, null);
  assert.equal(health.sessions[1]!.contextTokensPeak, null);
  assert.equal(health.sessions[1]!.compactions, null);
  assert.equal(health.sessions[1]!.promptEstimate, null);
});
