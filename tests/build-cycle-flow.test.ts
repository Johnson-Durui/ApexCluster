import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/adapters/mock.js';
import { emptyMeta, type AdapterProgress, type AdapterResult, type ModelAdapter, type ModelTaskSpec } from '../src/adapters/types.js';
import type { Run } from '../src/core/types.js';
import { EventBus } from '../src/orchestrator/events.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { RunStore } from '../src/orchestrator/store.js';
import { makeHarness, runInput } from './helpers.js';

type Harness = ReturnType<typeof makeHarness>;

async function framework(h: Harness, scenario: string, inputPatch: Parameters<typeof runInput>[1] = {}): Promise<Run> {
  const created = h.orch.createRun(runInput(scenario, { clarifyWith: 'skip', build: { autoRework: true }, ...inputPatch }));
  await h.orch.idle();
  let run = h.orch.getRun(created.id);
  if (run.phaseStatus === 'blocked') {
    h.orch.resolveBlocked(run.id, 'retry_failed');
    await h.orch.idle();
    run = h.orch.getRun(run.id);
  }
  assert.equal(run.phase, 'framework_gate', `${run.phase}/${run.phaseStatus}: ${run.blockedReason ?? ''}`);
  return run;
}

async function validateWinner(h: Harness, run: Run, buildOverrides?: Record<string, object>): Promise<Run> {
  const candidateId = run.decision!.winnerId ?? run.candidates[0]!.id;
  const defaults = h.orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  h.orch.resolveGate(run.id, {
    gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec],
    efforts: {}, buildOverrides, recheckItemIds: [], reason: null,
  });
  await h.orch.idle();
  return h.orch.getRun(run.id);
}

function phases(run: Run): string[] {
  return run.tasks.filter(task => task.jobId).map(task => task.phase);
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function jobDebug(run: Run): string {
  return JSON.stringify({ phase: run.phase, phaseStatus: run.phaseStatus, tasks: run.tasks.filter(task => task.jobId).map(task => ({
    phase: task.phase, status: task.status, validity: task.outputValidity, errors: task.validationErrors, failure: task.failure,
  })), jobs: run.jobs.map(job => ({ status: job.status, missing: job.finalReviewMissingReason, lock: job.writeLock,
    budget: job.budget, rounds: job.rounds?.map(round => ({ outcome: round.outcome, stopped: round.stoppedReason,
      evaluation: round.evaluation?.verdict, verified: round.verifiedDefectIds, brief: round.reworkBrief })) })) });
}

test('成功作业严格按 build → evaluate → final_review，人工待验不被模型改成通过', async () => {
  const h = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  let run = await framework(h, 'preference');
  run = await validateWinner(h, run);
  assert.deepEqual(phases(run), ['build', 'evaluate', 'final_review'], jobDebug(run));
  assert.equal(run.phase, 'final_gate');
  const job = run.jobs[0]!;
  assert.equal(job.rounds?.length, 1);
  assert.equal(job.status, 'awaiting_manual');
  assert.equal(job.verification?.items.some(item => item.status === 'awaiting_user'), true);
  assert.equal(job.finalReview?.verdict, 'accept_with_notes');
  assert.equal(job.budget?.usage.buildRounds, 1);
  assert.equal(job.budget?.usage.writerSessions, 1);
  assert.equal(job.budget?.usage.modelCalls, 3);
  assert.equal(typeof job.budget?.usage.activeMs, 'number');
});

test('failures 只有日志核对出的实现缺陷触发第二轮，历史和共同预算均保留', async () => {
  const h = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  let run = await framework(h, 'failures');
  run = await validateWinner(h, run);
  const job = run.jobs[0]!;
  assert.equal(run.phase, 'final_gate');
  assert.equal(job.rounds?.length, 2, jobDebug(run));
  assert.deepEqual(job.rounds?.map(round => round.kind), ['initial', 'rework']);
  assert.equal(job.rounds?.[0]!.verification?.verdict, 'failed');
  assert.deepEqual(job.rounds?.[0]!.verifiedDefectIds, ['D1']);
  assert.equal(job.rounds?.[1]!.verification?.verdict, 'awaiting_manual');
  assert.deepEqual(phases(run), ['build', 'evaluate', 'build', 'evaluate', 'final_review']);
  assert.deepEqual(job.budget?.usage.buildRounds, 2);
  assert.deepEqual(job.budget?.usage.writerSessions, 2);
  assert.deepEqual(job.budget?.usage.modelCalls, 5);
});

test('rework_exhausted 达到 maxRounds 后停止循环，保留终审并进入 G4', async () => {
  const h = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; c.build.maxRounds = 2; });
  let run = await framework(h, 'rework_exhausted');
  run = await validateWinner(h, run);
  const job = run.jobs[0]!;
  assert.equal(run.phase, 'final_gate');
  assert.equal(job.rounds?.length, 2, jobDebug(run));
  assert.match(job.rounds?.at(-1)?.stoppedReason ?? '', /轮次预算/);
  assert.equal(job.finalReview !== null, true);
  assert.equal(job.budget?.usage.buildRounds, 2);
  assert.deepEqual(phases(run), ['build', 'evaluate', 'build', 'evaluate', 'final_review']);
});

test('创建时冻结评审配置；旧运行删除新增字段后不凭新配置补开任务', async () => {
  const h = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  let run = await framework(h, 'preference');
  h.config.evaluator.enabled = false;
  h.config.finalReview.enabled = false;
  run = await validateWinner(h, run);
  assert.deepEqual(phases(run), ['build', 'evaluate', 'final_review']);

  const legacy = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; });
  let oldRun = await framework(legacy, 'preference', { build: { autoRework: false } });
  delete (oldRun as Partial<Run>).build;
  delete (oldRun as Partial<Run>).evaluator;
  delete (oldRun as Partial<Run>).finalReview;
  legacy.store.save(oldRun);
  oldRun = await validateWinner(legacy, oldRun);
  assert.deepEqual(phases(oldRun), ['build']);
});

test('G2 覆盖不能绕过创建时允许的 maxRounds 范围', async () => {
  const h = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  const run = await framework(h, 'preference');
  const candidateId = run.decision!.winnerId!;
  const defaults = h.orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  assert.throws(() => h.orch.resolveGate(run.id, {
    gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {},
    buildOverrides: { [candidateId]: { maxRounds: 5 } }, recheckItemIds: [], reason: null,
  }), /maxRounds|小于等于4|Too big/i);
  assert.equal(h.orch.getRun(run.id).jobs.length, 0);
});

test('终审 reject 或缺失不自动返工，接受时必须填写理由', async () => {
  const rejected = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  let run = await framework(rejected, 'final_review_reject');
  run = await validateWinner(rejected, run);
  const job = run.jobs[0]!;
  assert.equal(job.finalReview?.verdict, 'reject');
  assert.equal(job.rounds?.length, 1);
  const manual = job.spec.acceptance.find(item => item.kind === 'manual');
  if (manual) rejected.orch.setManualResult(run.id, job.id, manual.id, true, 'manual passed');
  assert.equal(rejected.orch.getRun(run.id).jobs[0]!.status, 'passed');
  assert.throws(() => rejected.orch.resolveGate(run.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: job.candidateId,
    jobId: null, manualResults: [], failureClassOverrides: {}, reason: null }), /终审.*理由|理由/);

  const missing = makeHarness({ inject: { 'claude.final_review.1': 'process_error' } }, c => {
    c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true;
  });
  let missingRun = await framework(missing, 'preference');
  missingRun = await validateWinner(missing, missingRun);
  const missingJob = missingRun.jobs[0]!;
  assert.equal(missingJob.finalReview, null);
  assert.ok(missingJob.finalReviewMissingReason);
  assert.equal(missingJob.rounds?.length, 1);
  const missingManual = missingJob.spec.acceptance.find(item => item.kind === 'manual');
  if (missingManual) missing.orch.setManualResult(missingRun.id, missingJob.id, missingManual.id, true, 'manual passed');
  assert.equal(missing.orch.getRun(missingRun.id).jobs[0]!.status, 'passed');
  assert.throws(() => missing.orch.resolveGate(missingRun.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: missingJob.candidateId,
    jobId: null, manualResults: [], failureClassOverrides: {}, reason: null }), /终审.*理由|理由/);
});

test('构建任务级失败不会触发自动返工或评审', async () => {
  const h = makeHarness({ inject: { 'sol.build.1': 'process_error' } }, c => {
    c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true;
  });
  let run = await framework(h, 'preference');
  run = await validateWinner(h, run);
  assert.equal(run.phase, 'final_gate');
  assert.deepEqual(phases(run), ['build']);
  assert.equal(run.jobs[0]!.rounds?.length, 1);
  assert.ok(run.jobs[0]!.finalReviewMissingReason);
});

test('结构修复使用只读全新线程并计入同一模型调用总账', async () => {
  const base = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = false; c.build.autoRework = false; });
  const mock = new MockAdapter({ delayMs: 0 });
  const captured: ModelTaskSpec[] = [];
  let evaluationCalls = 0;
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec: ModelTaskSpec, progress: (p: AdapterProgress) => void, signal: AbortSignal): Promise<AdapterResult> {
      captured.push(spec);
      const result = await mock.run(spec, progress, signal);
      if (spec.phase === 'evaluate' && evaluationCalls++ === 0) return { ...result, rawText: '{}', structured: null };
      return result;
    },
  };
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => adapter });
  const created = orch.createRun(runInput('preference', { clarifyWith: 'skip', build: { autoRework: false } }));
  await orch.idle();
  let run = orch.getRun(created.id);
  const candidateId = run.decision!.winnerId!;
  const defaults = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await orch.idle();
  run = orch.getRun(run.id);
  const evalSpecs = captured.filter(spec => spec.phase === 'evaluate');
  assert.equal(evalSpecs.length, 2);
  assert.equal(evalSpecs[1]!.sandbox, 'read_only');
  assert.equal(evalSpecs[1]!.resumeSessionId, null);
  assert.match(evalSpecs[1]!.cwd, /repair-cwd/);
  assert.equal(run.jobs[0]!.budget?.usage.modelCalls, 3); // build + evaluation + structural repair
  assert.equal(run.jobs[0]!.budget?.usage.writerSessions, 1);
});

test('取消后进程树退出未知会保留写锁和 unknown 预算，禁止再次派发', async () => {
  const base = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      if (spec.phase !== 'build') return mock.run(spec, progress, signal);
      const startedAt = new Date().toISOString();
      progress({ at: startedAt, kind: 'started', text: 'started' });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      const meta = emptyMeta('mock', spec, startedAt);
      meta.command = ['mock-build'];
      meta.terminationWarning = '模拟：无法确认进程树退出';
      return { status: 'cancelled', failure: { kind: 'cancelled', message: 'cancelled' }, rawText: null, structured: null, toolLog: [], meta, simulated: true };
    },
  };
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => adapter });
  const created = orch.createRun(runInput('preference', { clarifyWith: 'skip', build: { autoRework: true } }));
  await orch.idle();
  let run = orch.getRun(created.id);
  const candidateId = run.decision!.winnerId!;
  const defaults = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await waitUntil(() => orch.getRun(run.id).tasks.some(task => task.phase === 'build' && task.status === 'running'), 'build did not start');
  run = orch.getRun(run.id);
  const task = run.tasks.find(item => item.phase === 'build' && item.status === 'running')!;
  orch.cancelTask(run.id, task.id);
  await orch.idle();
  run = orch.getRun(run.id);
  const job = run.jobs[0]!;
  assert.equal(job.writeLock?.state, 'unconfirmed');
  assert.equal(job.budget?.calls[0]!.state, 'unknown');
  assert.throws(() => orch.resolveGate(run.id, { gate: 'G4_final', action: 'retry_job', chosenCandidateId: null, jobId: job.id,
    manualResults: [], failureClassOverrides: {}, reason: null }), /进程树|确认退出/);
});

test('recover 保留未确认预留并只标中断，不自动重发', async () => {
  const base = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  const mock = new MockAdapter({ delayMs: 0 });
  let releaseBuild!: (result: AdapterResult) => void;
  let pendingSpec!: ModelTaskSpec;
  const pending: ModelAdapter = {
    kind: 'mock',
    run(spec, progress, signal) {
      if (spec.phase !== 'build') return mock.run(spec, progress, signal);
      pendingSpec = spec;
      return new Promise(resolve => { releaseBuild = resolve; }); // no started event: reservation remains unresolved
    },
  };
  const original = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => pending });
  const created = original.createRun(runInput('preference', { clarifyWith: 'skip', build: { autoRework: true } }));
  await original.idle();
  let run = original.getRun(created.id);
  const candidateId = run.decision!.winnerId!;
  const defaults = original.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  original.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await waitUntil(() => original.getRun(run.id).tasks.some(task => task.phase === 'build' && task.status === 'running'), 'pending build did not enter running');
  run = original.getRun(run.id);
  assert.equal(run.jobs[0]!.budget?.calls[0]!.state, 'reserved');

  let restartedCalls = 0;
  const recoveredStore = new RunStore(base.config.dataDir);
  const recovered = new Orchestrator({ config: base.config, store: recoveredStore, bus: new EventBus(recoveredStore), adapterFor: () => ({
    kind: 'mock', run: async (...args) => { restartedCalls++; return mock.run(...args); },
  }) });
  recovered.recover();
  await recovered.idle();
  const restored = recovered.getRun(run.id);
  assert.equal(restored.tasks.find(task => task.phase === 'build')!.status, 'interrupted');
  assert.equal(restored.jobs[0]!.budget?.calls[0]!.state, 'unknown');
  assert.deepEqual(restored.jobs[0]!.budget?.reservedCalls.length, 1);
  assert.equal(restored.jobs[0]!.budget?.usage.modelCalls, 0);
  assert.equal(restartedCalls, 0);

  const meta = emptyMeta('mock', pendingSpec, '2026-10-23T08:00:00.000Z');
  releaseBuild({ status: 'failed', failure: { kind: 'process_error', message: 'late' }, rawText: null, structured: null, toolLog: [], meta, simulated: true });
});

test('evaluate fail 但复现日志不匹配时转 inconclusive，不能自动返工或终审', async () => {
  const base = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      const result = await mock.run(spec, progress, signal);
      if (spec.phase !== 'evaluate') return result;
      const acceptance = spec.context.spec!.acceptance;
      const command = acceptance.find(item => item.kind === 'command' && item.command)!;
      const output = {
        specRef: spec.context.spec!.ref,
        round: spec.context.evaluation!.round.round,
        workspaceCommit: spec.context.evaluation!.round.workspaceCommit,
        verdict: 'fail',
        acceptance: acceptance.map(item => ({ criterionId: item.id, status: item.id === command.id ? 'fail' : 'awaiting_manual', evidence: 'review claim' })),
        defects: [{ id: 'D-NO-LOG', criterionIds: [command.id], severity: 'major', failureClass: 'implementation_defect',
          location: 'src/budget.ts', evidence: 'claimed failure',
          reproduction: { command: command.command, logSeq: 99, expectedExitCode: command.expectExitCode ?? 0, outputIncludes: null },
          fix: 'fix claimed issue' }],
        reworkBrief: [{ defectIds: ['D-NO-LOG'], instructions: 'fix only after reproduction' }],
        environmentIssues: [], deviationsNoted: [], questions: [],
      };
      return { ...result, rawText: JSON.stringify(output), structured: null,
        toolLog: [{ seq: 1, type: 'command_execution', command: 'npm run unrelated', exitCode: 1, output: 'failed', status: 'failed', paths: [] }] };
    },
  };
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => adapter });
  const created = orch.createRun(runInput('preference', { clarifyWith: 'skip', build: { autoRework: true } }));
  await orch.idle();
  let run = orch.getRun(created.id);
  const candidateId = run.decision!.winnerId!;
  const defaults = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await orch.idle();
  run = orch.getRun(run.id);
  const job = run.jobs[0]!;
  assert.equal(run.phase, 'final_gate');
  assert.equal(job.rounds?.length, 1);
  assert.equal(job.rounds?.[0]!.evaluation?.verdict, 'fail');
  assert.deepEqual(job.rounds?.[0]!.verifiedDefectIds, []);
  assert.equal(job.status, 'inconclusive');
  assert.deepEqual(phases(run), ['build', 'evaluate']);
  assert.match(job.finalReviewMissingReason ?? '', /证据不足/);
});

test('Astra pass 但终审 reject 时，显式 rework_with_final_review 新开一轮且 writer 收到终审意见', async () => {
  const base = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = true; });
  const mock = new MockAdapter({ delayMs: 0 });
  const buildSpecs: ModelTaskSpec[] = [];
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      if (spec.phase === 'build') buildSpecs.push(spec);
      return mock.run(spec, progress, signal);
    },
  };
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => adapter });
  const created = orch.createRun(runInput('final_review_reject', { clarifyWith: 'skip', build: { autoRework: true } }));
  await orch.idle();
  let run = orch.getRun(created.id);
  const candidateId = run.decision!.winnerId!;
  const defaults = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await orch.idle();
  run = orch.getRun(run.id);
  const job = run.jobs[0]!;
  assert.equal(job.rounds?.[0]!.evaluation?.verdict, 'pass');
  assert.equal(job.finalReview?.verdict, 'reject');
  orch.resolveGate(run.id, { gate: 'G4_final', action: 'rework_with_final_review', chosenCandidateId: null, jobId: job.id,
    manualResults: [], failureClassOverrides: {}, reason: '按终审意见明确返工' });
  await orch.idle();
  run = orch.getRun(run.id);
  assert.equal(run.jobs[0]!.rounds?.length, 2);
  assert.equal(buildSpecs.length, 2);
  assert.match(buildSpecs[1]!.prompt, /模拟终审意见：实现偏离已确认框架/);
});

test('终审成功后显式重试失败会清除旧终审，接受时必须说明缺失理由', async () => {
  const h = makeHarness({ inject: { 'claude.final_review.2': 'process_error' } }, c => {
    c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = false;
  });
  let run = await framework(h, 'preference', { build: { autoRework: false } });
  run = await validateWinner(h, run);
  let job = run.jobs[0]!;
  assert.equal(job.finalReview?.verdict, 'accept_with_notes');

  h.orch.resolveGate(run.id, { gate: 'G4_final', action: 'retry_final_review', chosenCandidateId: null, jobId: job.id,
    manualResults: [], failureClassOverrides: {}, reason: '显式重试终审' });
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  job = run.jobs[0]!;
  assert.equal(job.finalReview, null, jobDebug(run));
  assert.match(job.finalReviewMissingReason ?? '', /模拟故障|process_error|终审/);
  const manual = job.spec.acceptance.find(item => item.kind === 'manual');
  if (manual) h.orch.setManualResult(run.id, job.id, manual.id, true, 'manual passed');
  assert.throws(() => h.orch.resolveGate(run.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: job.candidateId,
    jobId: null, manualResults: [], failureClassOverrides: {}, reason: null }), /终审.*理由|理由/);
});

test('独立评审有缺陷后显式重试失败会清除旧缺陷，不能据旧证据返工', async () => {
  const h = makeHarness({ inject: { 'astra.evaluate.2': 'process_error' } }, c => {
    c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = false;
  });
  let run = await framework(h, 'failures', { build: { autoRework: false } });
  run = await validateWinner(h, run);
  let job = run.jobs[0]!;
  assert.deepEqual(job.rounds?.[0]!.verifiedDefectIds, ['D1']);
  assert.ok(job.rounds?.[0]!.reworkBrief.length);

  h.orch.resolveGate(run.id, { gate: 'G4_final', action: 'retry_evaluation', chosenCandidateId: null, jobId: job.id,
    manualResults: [], failureClassOverrides: {}, reason: '显式重试独立评审' });
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  job = run.jobs[0]!;
  assert.equal(job.rounds?.[0]!.evaluation, null, jobDebug(run));
  assert.deepEqual(job.rounds?.[0]!.verifiedDefectIds, []);
  assert.deepEqual(job.rounds?.[0]!.reworkBrief, []);
  assert.throws(() => h.orch.resolveGate(run.id, { gate: 'G4_final', action: 'rework_job', chosenCandidateId: null, jobId: job.id,
    manualResults: [], failureClassOverrides: {}, reason: '不得使用旧缺陷' }), /没有可核对的当前实现缺陷/);
});

test('明确接受 build 型号不符会保留原工具日志核验，并继续 evaluate 与 final_review', async () => {
  const base = makeHarness({}, c => { c.evaluator.enabled = true; c.finalReview.enabled = true; c.build.autoRework = false; });
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      const result = await mock.run(spec, progress, signal);
      if (spec.phase === 'build') {
        result.meta.reportedModelSource = 'server_usage';
        result.meta.reportedModels = ['different-build-model'];
      }
      return result;
    },
  };
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => adapter });
  const created = orch.createRun(runInput('preference', { clarifyWith: 'skip', build: { autoRework: false } }));
  await orch.idle();
  let run = orch.getRun(created.id);
  const candidateId = run.decision!.winnerId!;
  const defaults = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await orch.idle();
  run = orch.getRun(run.id);
  const buildTask = run.tasks.find(task => task.phase === 'build')!;
  assert.equal(buildTask.failure?.kind, 'model_mismatch');
  assert.deepEqual(phases(run), ['build']);

  orch.acceptMismatch(run.id, buildTask.id);
  await orch.idle();
  run = orch.getRun(run.id);
  const job = run.jobs[0]!;
  assert.equal(buildTask.acceptedDespiteMismatch, true);
  assert.ok(job.rounds?.[0]!.verification, jobDebug(run));
  assert.equal(job.rounds?.[0]!.verification?.items.some(item => item.status === 'verified_pass' && item.matchedCommand), true);
  assert.deepEqual(phases(run), ['build', 'evaluate', 'final_review']);
  assert.equal(job.rounds?.[0]!.evaluation?.verdict, 'pass');
  assert.equal(job.finalReview?.verdict, 'accept_with_notes');
});
