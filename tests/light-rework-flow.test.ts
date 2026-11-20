import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/adapters/mock.js';
import { emptyMeta, type AdapterResult, type ModelAdapter, type ModelTaskSpec } from '../src/adapters/types.js';
import type { Run } from '../src/core/types.js';
import { EventBus } from '../src/orchestrator/events.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { RunStore } from '../src/orchestrator/store.js';
import { makeHarness, runInput } from './helpers.js';

type Harness = ReturnType<typeof makeHarness>;

const LIGHT_BUILD = {
  autoRework: true,
  maxRounds: 3,
  maxWriterSessions: 12,
  maxModelCalls: 20,
  maxActiveMinutes: 360,
  resumePolicy: 'never' as const,
  lightReworkEnabled: true,
  lightReworkMinutes: 5,
};

function withCapturedAdapter(
  h: Harness,
  transform?: (spec: ModelTaskSpec, result: AdapterResult) => AdapterResult,
  beforeRun?: (spec: ModelTaskSpec) => void,
): ModelTaskSpec[] {
  const calls: ModelTaskSpec[] = [];
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = {
    kind: 'mock',
    run: async (spec, progress, signal) => {
      calls.push(structuredClone(spec));
      beforeRun?.(spec);
      const result = await mock.run(spec, progress, signal);
      return transform?.(spec, result) ?? result;
    },
  };
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: new EventBus(h.store), adapterFor: () => adapter });
  return calls;
}

async function framework(h: Harness, build = LIGHT_BUILD): Promise<Run> {
  const created = h.orch.createRun(runInput('light_rework_files_only', { clarifyWith: 'skip', build }));
  await h.orch.idle();
  const run = h.orch.getRun(created.id);
  assert.equal(run.phase, 'framework_gate', `${run.phase}/${run.phaseStatus}: ${run.blockedReason ?? ''}`);
  return run;
}

async function validate(h: Harness, run: Run, override: Record<string, unknown> = {}): Promise<Run> {
  const candidateId = run.decision!.winnerId ?? run.candidates[0]!.id;
  const defaults = h.orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  h.orch.resolveGate(run.id, {
    gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {},
    buildOverrides: { [candidateId]: { lightReworkEnabled: true, lightReworkMinutes: 5, ...override } },
    recheckItemIds: [], reason: null,
  });
  await h.orch.idle();
  return h.orch.getRun(run.id);
}

function jobTasks(run: Run) {
  return run.tasks.filter(task => task.jobId).map(task => ({ id: task.id, role: task.role, phase: task.phase, attempt: task.attempt }));
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 300; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function lightCallStates(run: Run, jobIndex = 0): string[] {
  const job = run.jobs[jobIndex]!;
  const round = job.rounds?.find(item => item.writer === 'grok')!;
  const taskIds = [round.buildTaskId, round.lightRework!.reservedEvaluateTaskId, round.lightRework!.reservedFinalTaskId].filter((id): id is string => !!id);
  return taskIds.map(taskId => job.budget!.calls.find(call => call.taskId === taskId)!.state);
}

test('自动轻量返工严格走 Sol → Astra → Grok → Astra → Claude，并保留独立核验来源', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true;
    config.finalReview.enabled = true;
    config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  let runId = '';
  let heldAtGrok: { states: string[]; minutes: number[]; taskIds: string[] } | null = null;
  const calls = withCapturedAdapter(h, undefined, spec => {
    if (spec.role !== 'grok' || spec.phase !== 'build') return;
    const current = h.orch.getRun(runId);
    const job = current.jobs[0]!;
    const light = job.rounds?.at(-1)?.lightRework!;
    const taskIds = [spec.taskId, light.reservedEvaluateTaskId, light.reservedFinalTaskId!];
    heldAtGrok = {
      states: taskIds.map(taskId => job.budget!.calls.find(call => call.taskId === taskId)!.state),
      minutes: [light.minutes, light.evaluateMinutes, light.finalMinutes],
      taskIds,
    };
  });
  let run = await framework(h);
  runId = run.id;
  run = await validate(h, run);

  assert.equal(run.phase, 'final_gate');
  assert.deepEqual(jobTasks(run).map(task => [task.role, task.phase]), [
    ['sol', 'build'], ['astra', 'evaluate'], ['grok', 'build'], ['astra', 'evaluate'], ['claude', 'final_review'],
  ]);
  const job = run.jobs[0]!;
  assert.deepEqual(job.rounds?.map(round => round.writer), ['sol', 'grok']);
  assert.equal(job.rounds?.length, 2);
  const grokCall = calls.find(spec => spec.role === 'grok' && spec.phase === 'build')!;
  assert.equal(grokCall.model, 'grok-4.7-high-fast');
  assert.equal(grokCall.effort, 'high');
  assert.equal(grokCall.sandbox, 'workspace_write');
  assert.equal(grokCall.context.lightRework?.allowedFiles.length! <= 5, true);
  assert.equal(grokCall.context.lightRework?.specRef, job.spec.ref);
  assert.equal(grokCall.context.lightRework?.round, 2);
  assert.ok(grokCall.context.lightRework?.workspaceCommit);
  assert.ok(grokCall.context.lightRework?.treeHash);

  const grokTask = run.tasks.find(task => task.role === 'grok' && task.phase === 'build')!;
  const grokLog = JSON.parse(h.store.readTaskFile(run.id, grokTask.id, 'tool-log.json')!) as { type: string }[];
  assert.deepEqual(new Set(grokLog.map(item => item.type)), new Set(['file_change']));
  assert.equal(job.rounds?.[1]?.verification?.taskId, job.rounds?.[1]?.evaluateTaskId);
  assert.equal(job.rounds?.[1]?.verification?.specRef, job.spec.ref);
  assert.ok(job.rounds?.[1]?.verification?.logRange);

  const manual = job.spec.acceptance.find(item => item.kind === 'manual');
  if (manual) h.orch.setManualResult(run.id, job.id, manual.id, true, '人工验证通过');
  run = h.orch.getRun(run.id);
  assert.equal(run.jobs[0]!.rounds?.[1]?.verification?.taskId, job.rounds?.[1]?.evaluateTaskId);
  assert.equal(run.jobs[0]!.verification?.items.some(item => item.status === 'not_observed'), false);
  assert.equal(run.jobs[0]!.verification?.verdict, 'passed');
  assert.equal(run.jobs[0]!.rounds?.[1]?.outcome, 'passed');
  assert.equal(run.jobs[0]!.rounds?.[1]?.stoppedReason, null);
  if (manual) h.orch.setManualResult(run.id, job.id, manual.id, false, '人工复验失败');
  run = h.orch.getRun(run.id);
  assert.equal(run.jobs[0]!.verification?.verdict, 'failed');
  assert.equal(run.jobs[0]!.rounds?.[1]?.outcome, 'stopped');
  assert.equal(run.jobs[0]!.budget?.usage.writerSessions, 2);
  assert.equal(run.jobs[0]!.budget?.usage.buildRounds, 2);
  const held = heldAtGrok as { states: string[]; minutes: number[]; taskIds: string[] } | null;
  assert.ok(held);
  assert.deepEqual(held.states, ['reserved', 'reserved', 'reserved']);
  assert.deepEqual(held.minutes, [5, 30, 30]);
  assert.equal(new Set(held.taskIds).size, 3);
  assert.equal(job.budget?.calls.some(call => call.state === 'reserved' || call.state === 'started'), false);
  assert.equal(job.budget?.usage.modelCalls, 5);
});

test('显式 light_rework_job 是独立 G4 动作，预算不足时原子拒绝且不创建轮次、任务或计账', async () => {
  const success = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = false; config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD, autoRework: false };
  });
  withCapturedAdapter(success);
  let successRun = await framework(success, { ...LIGHT_BUILD, autoRework: false });
  successRun = await validate(success, successRun, { autoRework: false });
  const successJob = successRun.jobs[0]!;
  success.orch.resolveGate(successRun.id, {
    gate: 'G4_final', action: 'light_rework_job', jobId: successJob.id, chosenCandidateId: null,
    manualResults: [], failureClassOverrides: {}, reason: null,
  });
  await success.orch.idle();
  successRun = success.orch.getRun(successRun.id);
  assert.deepEqual(successRun.jobs[0]!.rounds?.map(round => round.writer), ['sol', 'grok']);
  assert.equal(successRun.tasks.filter(task => task.role === 'grok' && task.phase === 'build').length, 1);

  const h = makeHarness({}, config => {
    config.evaluator.enabled = true;
    config.finalReview.enabled = false;
    config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD, autoRework: false };
  });
  withCapturedAdapter(h);
  let run = await framework(h, { ...LIGHT_BUILD, autoRework: false });
  run = await validate(h, run, { autoRework: false });
  assert.equal(run.phase, 'final_gate');
  const job = run.jobs[0]!;
  job.budget!.limits.maxModelCalls = job.budget!.usage.modelCalls;
  h.store.save(run);
  const before = { tasks: run.tasks.length, rounds: job.rounds?.length, budget: structuredClone(job.budget) };

  assert.throws(() => h.orch.resolveGate(run.id, {
    gate: 'G4_final', action: 'light_rework_job', jobId: job.id, chosenCandidateId: null,
    manualResults: [], failureClassOverrides: {}, reason: null,
  }), /预算|额度|调用|返工/);
  run = h.orch.getRun(run.id);
  assert.equal(run.tasks.length, before.tasks);
  assert.equal(run.jobs[0]!.rounds?.length, before.rounds);
  assert.deepEqual(run.jobs[0]!.budget, before.budget);
});

test('冻结能力引用在真实派发门变化时 fail closed，且零 Grok 派发', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = false; config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD, autoRework: false };
  });
  const calls = withCapturedAdapter(h);
  let run = await framework(h, { ...LIGHT_BUILD, autoRework: false });
  run = await validate(h, run, { autoRework: false });
  const beforeCalls = calls.length;
  const beforeTasks = run.tasks.length;
  run.mode = 'real';
  run.models.grok!.adapter = 'cursor';
  h.config.adapters.cursorWriter.capabilities = {
    verifiedAt: '2026-10-23T00:00:00.000Z', cliVersion: 'cursor-agent changed', model: 'grok-4.7-high-fast', reportedModel: 'Grok 4.7 256K High Fast',
    distro: 'codex-cursor-h7', machineId: '1'.repeat(32), nodePath: '/opt/cursor/node', entryPath: '/opt/cursor/index.js',
    nodeSha256: 'a'.repeat(64), entrySha256: 'b'.repeat(64), bwrapPath: '/usr/bin/bwrap', bwrapSha256: 'c'.repeat(64),
    setsidPath: '/usr/bin/setsid', setsidSha256: 'd'.repeat(64), kernel: '6.6.87.2-microsoft-standard-WSL2', toolPolicy: 'workspace_edits_only',
    commandExitEventsVerified: true, fileChangesVerified: true, workspaceWriteVerified: true, isolatedWorkspaceVerified: true, terminationVerified: true,
  };
  h.store.save(run);
  assert.throws(() => h.orch.resolveGate(run.id, {
    gate: 'G4_final', action: 'light_rework_job', jobId: run.jobs[0]!.id, chosenCandidateId: null,
    manualResults: [], failureClassOverrides: {}, reason: null,
  }), /能力|H7|变化|不一致/);
  run = h.orch.getRun(run.id);
  assert.equal(calls.length, beforeCalls);
  assert.equal(run.tasks.length, beforeTasks);
  assert.equal(run.tasks.some(task => task.role === 'grok' && task.phase === 'build'), false);
});

test('Grok 失败或非法输出不自动重试，也不进入结构修复', async () => {
  for (const invalid of [false, true]) {
    const h = makeHarness({}, config => {
      config.evaluator.enabled = true;
      config.finalReview.enabled = false;
      config.contextBudget.enabled = false;
      config.build = { ...config.build, ...LIGHT_BUILD };
    });
    const mock = new MockAdapter({ delayMs: 0 });
    const calls: ModelTaskSpec[] = [];
    const adapter: ModelAdapter = { kind: 'mock', run: async (spec, progress, signal) => {
      calls.push(structuredClone(spec));
      const result = await mock.run(spec, progress, signal);
      if (spec.role !== 'grok' || spec.phase !== 'build') return result;
      return invalid
        ? { ...result, status: 'succeeded', failure: null, rawText: 'not-json', structured: null, toolLog: [] }
        : { ...result, status: 'failed', failure: { kind: 'process_error', message: 'mock grok failure' }, rawText: null, structured: null, toolLog: [] };
    } };
    h.orch = new Orchestrator({ config: h.config, store: h.store, bus: new EventBus(h.store), adapterFor: () => adapter });
    let run = await framework(h);
    run = await validate(h, run);
    const grokTasks = run.tasks.filter(task => task.role === 'grok' && task.phase === 'build');
    assert.equal(grokTasks.length, 1);
    assert.equal(calls.filter(spec => spec.role === 'grok' && spec.phase === 'build').length, 1);
    assert.equal(grokTasks[0]!.repairAttempted, false);
    assert.notEqual(run.jobs[0]!.rounds?.at(-1)?.outcome, 'rework');
    if (!invalid) {
      h.orch.resolveGate(run.id, { gate: 'G4_final', action: 'retry_job', jobId: run.jobs[0]!.id, chosenCandidateId: null,
        manualResults: [], failureClassOverrides: {}, reason: 'Grok 失败后改由 Sol 重试' });
      await h.orch.idle();
      run = h.orch.getRun(run.id);
      const writers = run.jobs[0]!.rounds?.map(round => round.writer);
      assert.deepEqual(writers, ['sol', 'grok', 'sol']);
      assert.equal(run.tasks.filter(task => task.role === 'grok' && task.phase === 'build').length, 1);
    }
  }
});

test('轻量返工默认关闭，旧运行和 T12 上下文治理不能通过 G2 开启', async () => {
  const off = makeHarness({}, config => { config.evaluator.enabled = true; config.finalReview.enabled = false; });
  let offRun = await framework(off, { ...LIGHT_BUILD, lightReworkEnabled: false });
  const candidateId = offRun.decision!.winnerId!;
  const defaults = off.orch.frameworkGateDefaults(offRun.id).find(item => item.candidateId === candidateId)!;
  off.orch.resolveGate(offRun.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {},
    buildOverrides: {}, recheckItemIds: [], reason: null });
  await off.orch.idle();
  assert.deepEqual(off.orch.getRun(offRun.id).jobs[0]!.lightRework, { enabled: false, minutes: 5, capabilityRef: null });

  const omittedOverride = makeHarness({}, config => { config.evaluator.enabled = true; config.contextBudget.enabled = false; config.build = { ...config.build, ...LIGHT_BUILD }; });
  const omittedRun = await framework(omittedOverride);
  const omittedCandidate = omittedRun.decision!.winnerId!;
  const omittedDefaults = omittedOverride.orch.frameworkGateDefaults(omittedRun.id).find(item => item.candidateId === omittedCandidate)!;
  omittedOverride.orch.resolveGate(omittedRun.id, { gate: 'G2_framework', action: 'validate', candidateIds: [omittedCandidate], specs: [omittedDefaults.spec], efforts: {},
    buildOverrides: { [omittedCandidate]: { lightReworkMinutes: 5 } }, recheckItemIds: [], reason: null });
  await omittedOverride.orch.idle();
  assert.deepEqual(omittedOverride.orch.getRun(omittedRun.id).jobs[0]!.lightRework, { enabled: false, minutes: 5, capabilityRef: null });

  const legacy = makeHarness({}, config => { config.evaluator.enabled = true; });
  const old = await framework(legacy, { ...LIGHT_BUILD, lightReworkEnabled: false });
  delete old.build!.lightReworkEnabled;
  delete old.build!.lightReworkMinutes;
  legacy.store.save(old);
  const oldCandidate = old.decision!.winnerId!;
  const oldDefaults = legacy.orch.frameworkGateDefaults(old.id).find(item => item.candidateId === oldCandidate)!;
  assert.throws(() => legacy.orch.resolveGate(old.id, { gate: 'G2_framework', action: 'validate', candidateIds: [oldCandidate], specs: [oldDefaults.spec], efforts: {},
    buildOverrides: { [oldCandidate]: { lightReworkEnabled: true } }, recheckItemIds: [], reason: null }), /旧运行|冻结字段/);
  assert.equal(legacy.orch.getRun(old.id).jobs.length, 0);

  const t12 = makeHarness({}, config => { config.evaluator.enabled = true; config.contextBudget.enabled = true; });
  assert.throws(() => t12.orch.createRun(runInput('light_rework_files_only', { clarifyWith: 'skip', build: LIGHT_BUILD })), /上下文治理|轻量返工/);

  const noEvaluator = makeHarness({}, config => { config.evaluator.enabled = false; config.contextBudget.enabled = false; });
  assert.throws(() => noEvaluator.orch.createRun(runInput('light_rework_files_only', { clarifyWith: 'skip', build: LIGHT_BUILD })), /独立评审|轻量返工/);
});

test('major 或非实现缺陷不路由 Grok，Grok 后 Astra 缺少真实日志也不能通过', async () => {
  for (const variant of ['major', 'nonimplementation'] as const) {
    const h = makeHarness({}, config => {
      config.evaluator.enabled = true; config.finalReview.enabled = false; config.contextBudget.enabled = false;
      config.build = { ...config.build, ...LIGHT_BUILD };
    });
    const calls = withCapturedAdapter(h, (spec, result) => {
      if (spec.role !== 'astra' || spec.phase !== 'evaluate' || spec.context.evaluation?.round.round !== 1 || !result.rawText) return result;
      const output = JSON.parse(result.rawText) as { defects: { severity: string; failureClass: string }[] };
      if (variant === 'major') output.defects.forEach(defect => { defect.severity = 'major'; });
      else output.defects.forEach(defect => { defect.failureClass = 'architecture_mismatch'; });
      return { ...result, rawText: JSON.stringify(output) };
    });
    let run = await framework(h);
    run = await validate(h, run);
    assert.equal(calls.some(spec => spec.role === 'grok' && spec.phase === 'build'), false);
    if (variant === 'major') {
      assert.equal(run.jobs[0]!.rounds?.length, 2);
      assert.deepEqual(run.jobs[0]!.rounds?.map(round => round.writer), ['sol', 'sol']);
    } else {
      assert.equal(run.jobs[0]!.rounds?.length, 1);
    }
  }

  const noLogs = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = false; config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  withCapturedAdapter(noLogs, (spec, result) => spec.role === 'astra' && spec.phase === 'evaluate' &&
    spec.context.evaluation?.round.writer === 'grok' ? { ...result, toolLog: [] } : result);
  let run = await framework(noLogs);
  run = await validate(noLogs, run);
  const round = run.jobs[0]!.rounds?.at(-1)!;
  assert.equal(round.writer, 'grok');
  assert.notEqual(round.verification?.verdict, 'passed');
  assert.equal(round.verification?.items.some(item => item.status === 'not_observed'), true);
  assert.notEqual(run.jobs[0]!.status, 'passed');
});

test('cancelRun 会释放排队 Grok 本轮三个从未启动的预留', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = true; config.contextBudget.enabled = false;
    config.limits.maxConcurrentJobs = 1;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  const mock = new MockAdapter({ delayMs: 0 });
  let blockedCandidate: string | null = null;
  let releaseSecond!: () => void;
  const secondBlocked = new Promise<void>(resolve => { releaseSecond = resolve; });
  const adapter: ModelAdapter = { kind: 'mock', run: async (spec, progress, signal) => {
    if (spec.role === 'sol' && spec.phase === 'build' && spec.context.buildRound === 1 && spec.context.spec?.candidateId === blockedCandidate) {
      progress({ at: new Date().toISOString(), kind: 'started', text: 'hold second writer slot' });
      await secondBlocked;
    }
    return mock.run(spec, progress, signal);
  } };
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: new EventBus(h.store), adapterFor: () => adapter });
  const created = h.orch.createRun(runInput('light_rework_files_only', { clarifyWith: 'skip', build: LIGHT_BUILD }));
  await h.orch.idle();
  let run = h.orch.getRun(created.id);
  const candidates = run.candidates.slice(0, 2);
  assert.equal(candidates.length, 2);
  blockedCandidate = candidates[1]!.id;
  const defaults = h.orch.frameworkGateDefaults(run.id).filter(item => candidates.some(candidate => candidate.id === item.candidateId));
  h.orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: candidates.map(candidate => candidate.id),
    specs: defaults.map(item => item.spec), efforts: {}, buildOverrides: Object.fromEntries(candidates.map(candidate => [candidate.id,
      { lightReworkEnabled: true, lightReworkMinutes: 5 }])), recheckItemIds: [], reason: null });
  await waitUntil(() => h.orch.getRun(run.id).tasks.some(task => task.role === 'grok' && task.phase === 'build' && task.status === 'queued'), 'Grok did not remain queued');
  run = h.orch.getRun(run.id);
  const grok = run.tasks.find(task => task.role === 'grok' && task.phase === 'build' && task.status === 'queued')!;
  const jobIndex = run.jobs.findIndex(job => job.id === grok.jobId);
  assert.deepEqual(lightCallStates(run, jobIndex), ['reserved', 'reserved', 'reserved']);
  h.orch.cancelRun(run.id);
  run = h.orch.getRun(run.id);
  assert.deepEqual(lightCallStates(run, jobIndex), ['not_started', 'not_started', 'not_started']);
  assert.equal(run.terminal, 'cancelled');
  releaseSecond();
  await h.orch.idle();
});

test('运行中的 Grok 取消只结算已启动 writer，未创建的评审 hold 退款', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = true; config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = { kind: 'mock', run: async (spec, progress, signal) => {
    if (spec.role !== 'grok' || spec.phase !== 'build') return mock.run(spec, progress, signal);
    const startedAt = new Date().toISOString();
    progress({ at: startedAt, kind: 'started', text: 'grok started' });
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    const meta = emptyMeta('mock', spec, startedAt);
    meta.processStarted = true;
    meta.endedAt = new Date().toISOString();
    return { status: 'cancelled', failure: { kind: 'cancelled', message: 'cancelled' }, rawText: null, structured: null, toolLog: [], meta, simulated: true };
  } };
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: new EventBus(h.store), adapterFor: () => adapter });
  let run = await framework(h);
  const runId = run.id;
  void validate(h, run);
  await waitUntil(() => h.orch.getRun(runId).tasks.some(task => task.role === 'grok' && task.status === 'running'), 'Grok did not start');
  run = h.orch.getRun(runId);
  const grok = run.tasks.find(task => task.role === 'grok' && task.status === 'running')!;
  h.orch.cancelTask(run.id, grok.id);
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  assert.deepEqual(lightCallStates(run), ['settled', 'not_started', 'not_started']);
  assert.equal(run.jobs[0]!.writeLock, null);
});

test('排队中的 Grok 后 Astra 评审取消会退款评审与终审 hold', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = true; config.contextBudget.enabled = false;
    config.limits.maxConcurrentJobs = 2; config.limits.maxConcurrentModelTasks = 1;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  const mock = new MockAdapter({ delayMs: 0 });
  let firstCandidate = '';
  let secondCandidate = '';
  let releaseSecondWriter!: () => void;
  const secondWriterGate = new Promise<void>(resolve => { releaseSecondWriter = resolve; });
  let releaseSecondEvaluation!: () => void;
  const secondEvaluationGate = new Promise<void>(resolve => { releaseSecondEvaluation = resolve; });
  let secondEvaluationStarted!: () => void;
  const secondEvaluationReady = new Promise<void>(resolve => { secondEvaluationStarted = resolve; });
  const adapter: ModelAdapter = { kind: 'mock', run: async (spec, progress, signal) => {
    const candidate = spec.context.spec?.candidateId;
    if (spec.role === 'sol' && spec.phase === 'build' && candidate === secondCandidate && spec.context.buildRound === 1) await secondWriterGate;
    if (spec.role === 'astra' && spec.phase === 'evaluate' && candidate === secondCandidate && spec.context.evaluation?.round.round === 1) {
      progress({ at: new Date().toISOString(), kind: 'started', text: 'hold second evaluation slot' });
      secondEvaluationStarted();
      await secondEvaluationGate;
    }
    if (spec.role === 'astra' && spec.phase === 'evaluate' && candidate === firstCandidate && spec.context.evaluation?.round.round === 1) {
      const result = await mock.run(spec, progress, signal);
      releaseSecondWriter();
      return result;
    }
    if (spec.role === 'grok' && candidate === firstCandidate) await secondEvaluationReady;
    return mock.run(spec, progress, signal);
  } };
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: new EventBus(h.store), adapterFor: () => adapter });
  const created = h.orch.createRun(runInput('light_rework_files_only', { clarifyWith: 'skip', build: LIGHT_BUILD }));
  await h.orch.idle();
  let run = h.orch.getRun(created.id);
  const candidates = run.candidates.slice(0, 2);
  firstCandidate = candidates[0]!.id; secondCandidate = candidates[1]!.id;
  const defaults = h.orch.frameworkGateDefaults(run.id).filter(item => candidates.some(candidate => candidate.id === item.candidateId));
  h.orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [firstCandidate, secondCandidate], specs: defaults.map(item => item.spec),
    efforts: {}, buildOverrides: { [firstCandidate]: { lightReworkEnabled: true }, [secondCandidate]: { lightReworkEnabled: true } },
    recheckItemIds: [], reason: null });
  await waitUntil(() => h.orch.getRun(run.id).tasks.some(task => task.role === 'astra' && task.phase === 'evaluate' && task.buildRound === 2 && task.status === 'queued'),
    'post-Grok evaluation did not remain queued');
  run = h.orch.getRun(run.id);
  const jobIndex = run.jobs.findIndex(job => job.candidateId === firstCandidate);
  const evaluation = run.tasks.find(task => task.jobId === run.jobs[jobIndex]!.id && task.role === 'astra' && task.phase === 'evaluate' && task.buildRound === 2)!;
  assert.deepEqual(lightCallStates(run, jobIndex), ['settled', 'reserved', 'reserved']);
  h.orch.cancelTask(run.id, evaluation.id);
  run = h.orch.getRun(run.id);
  assert.deepEqual(lightCallStates(run, jobIndex), ['settled', 'not_started', 'not_started']);
  releaseSecondEvaluation();
  await h.orch.idle();
});

test('Grok 中断后恢复：writer 保守 unknown，未来评审 hold 退款且不自动派发', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = true; config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  const mock = new MockAdapter({ delayMs: 0 });
  let release!: (result: AdapterResult) => void;
  let pendingSpec!: ModelTaskSpec;
  const adapter: ModelAdapter = { kind: 'mock', run(spec, progress, signal) {
    if (spec.role !== 'grok' || spec.phase !== 'build') return mock.run(spec, progress, signal);
    pendingSpec = spec;
    return new Promise(resolve => { release = resolve; });
  } };
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: new EventBus(h.store), adapterFor: () => adapter });
  let run = await framework(h);
  const runId = run.id;
  void validate(h, run);
  await waitUntil(() => h.orch.getRun(runId).tasks.some(task => task.role === 'grok' && task.status === 'running'), 'Grok did not enter running');
  run = h.orch.getRun(runId);
  assert.deepEqual(lightCallStates(run), ['reserved', 'reserved', 'reserved']);

  let recoveredCalls = 0;
  const store = new RunStore(h.config.dataDir);
  const recovered = new Orchestrator({ config: h.config, store, bus: new EventBus(store), adapterFor: () => ({ kind: 'mock', run: async (...args) => {
    recoveredCalls += 1; return mock.run(...args);
  } }) });
  recovered.recover();
  await recovered.idle();
  const restored = recovered.getRun(run.id);
  assert.deepEqual(lightCallStates(restored), ['unknown', 'not_started', 'not_started']);
  assert.equal(restored.jobs[0]!.writeLock?.state, 'unconfirmed');
  assert.equal(recoveredCalls, 0);

  const meta = emptyMeta('mock', pendingSpec, new Date().toISOString());
  release({ status: 'failed', failure: { kind: 'process_error', message: 'late' }, rawText: null, structured: null, toolLog: [], meta, simulated: true });
  await h.orch.idle();
});

test('Grok 后仍有可复现实现缺陷时只回到 Sol，不允许连续 Grok', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = false; config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  const calls = withCapturedAdapter(h, (spec, result) => {
    if (spec.role !== 'astra' || spec.phase !== 'evaluate' || spec.context.evaluation?.round.writer !== 'grok' || !result.rawText) return result;
    const output = JSON.parse(result.rawText) as any;
    const criterion = spec.context.spec!.acceptance.find(item => item.kind === 'command' && item.command)!;
    output.verdict = 'fail';
    output.acceptance = output.acceptance.map((item: any) => item.criterionId === criterion.id ? { ...item, status: 'fail' } : item);
    output.defects = [{ id: 'D-again', criterionIds: [criterion.id], severity: 'minor', failureClass: 'implementation_defect',
      location: 'src/budget.ts', evidence: 'still failing', reproduction: { command: criterion.command, logSeq: 0,
        expectedExitCode: criterion.expectExitCode ?? 0, outputIncludes: criterion.outputIncludes }, fix: '由 Sol 继续修复' }];
    output.reworkBrief = [{ defectIds: ['D-again'], instructions: '由 Sol 继续修复' }];
    return { ...result, rawText: JSON.stringify(output), toolLog: [{ seq: 0, type: 'command_execution', command: criterion.command,
      exitCode: 1, output: 'still failing', status: 'failed', paths: [] }] };
  });
  let run = await framework(h);
  run = await validate(h, run);
  assert.deepEqual(run.jobs[0]!.rounds?.map(round => round.writer), ['sol', 'grok', 'sol']);
  assert.equal(calls.filter(spec => spec.role === 'grok' && spec.phase === 'build').length, 1);
});

test('Grok helper 因元数据失配返回 null 时，manual-only 规格不能靠通用评估推进', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = true; config.finalReview.enabled = true; config.contextBudget.enabled = false;
    config.build = { ...config.build, ...LIGHT_BUILD };
  });
  const mock = new MockAdapter({ delayMs: 0 });
  let runId = '';
  const adapter: ModelAdapter = { kind: 'mock', run: async (spec, progress, signal) => {
    const result = await mock.run(spec, progress, signal);
    if (spec.role !== 'astra' || spec.phase !== 'evaluate' || spec.context.evaluation?.round.writer !== 'grok' || !result.rawText) return result;
    const run = h.orch.getRun(runId);
    const job = run.jobs[0]!;
    const round = job.rounds!.at(-1)!;
    const manual = job.spec.acceptance.find(item => item.kind === 'manual')!;
    job.spec.acceptance = [manual];
    round.lightRework!.capabilityRef = '';
    const output = JSON.parse(result.rawText) as any;
    output.acceptance = [{ criterionId: manual.id, status: 'awaiting_manual', evidence: '等待人工验收' }];
    output.defects = [];
    output.reworkBrief = [];
    output.verdict = 'pass';
    h.store.save(run);
    return { ...result, rawText: JSON.stringify(output), structured: null, toolLog: [] };
  } };
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: new EventBus(h.store), adapterFor: () => adapter });
  let run = await framework(h);
  runId = run.id;
  run = await validate(h, run);
  const job = run.jobs[0]!;
  const round = job.rounds!.at(-1)!;
  assert.equal(round.writer, 'grok');
  assert.equal(round.verification?.verdict, 'inconclusive');
  assert.equal(job.verification?.verdict, 'inconclusive');
  assert.equal(job.status, 'inconclusive');
  assert.notEqual(round.outcome, 'passed');
  assert.notEqual(round.outcome, 'rework');
  assert.equal(run.tasks.some(task => task.phase === 'final_review'), false);
  assert.equal(run.phase, 'final_gate');
});
