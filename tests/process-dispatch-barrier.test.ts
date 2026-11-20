import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDispatchSafe } from '../src/adapters/dispatch-safety.js';
import { MockAdapter } from '../src/adapters/mock.js';
import type { ModelAdapter } from '../src/adapters/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { makeHarness, runInput } from './helpers.js';

const warning = '无法确认整个子进程树已结束；孙进程可能仍在运行。';

async function reachFrameworkGate(orch: Orchestrator) {
  const created = orch.createRun(runInput('preference', { clarifyWith: 'skip', build: { autoRework: false } }));
  await orch.idle();
  let run = orch.getRun(created.id);
  if (run.phaseStatus === 'blocked') {
    orch.resolveBlocked(run.id, 'retry_failed');
    await orch.idle();
    run = orch.getRun(run.id);
  }
  assert.equal(run.phase, 'framework_gate');
  return run;
}

test('退出未知的模型阻止已排队的下一模型派发', async () => {
  const h = makeHarness({}, config => { config.limits.maxConcurrentModelTasks = 1; });
  const mock = new MockAdapter({ delayMs: 0 });
  let calls = 0;
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      calls++;
      const result = await mock.run(spec, progress, signal);
      return { ...result, status: 'failed', failure: { kind: 'process_error', message: '工具异常' },
        meta: { ...result.meta, terminationWarning: warning } };
    },
  };
  const orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => adapter });
  const run = orch.createRun(runInput('preference'));
  await orch.idle();
  assert.equal(calls, 1);
  const tasks = orch.getRun(run.id).tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]!.meta?.terminationWarning, warning);
  assert.match(tasks[1]!.failure?.message ?? '', /进程树尚未确认退出/);
  assert.equal(tasks[1]!.executionCalls?.length, 0);
});

test('Cursor 整理退出未知后不再派发，结束运行与服务恢复也不抹去阻断', async () => {
  const h = makeHarness({}, config => { config.chores.qgroup = true; });
  const mock = new MockAdapter({ delayMs: 0 });
  const calls: string[] = [];
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      calls.push(`${spec.role}:${spec.phase}`);
      const result = await mock.run(spec, progress, signal);
      if (spec.role !== 'grok') return result;
      return { ...result, status: 'failed', failure: { kind: 'process_error', message: 'Cursor 禁止工具触发终止' },
        meta: { ...result.meta, terminationWarning: warning } };
    },
  };
  const orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => adapter });
  const created = orch.createRun(runInput('preference'));
  await orch.idle();
  let run = orch.getRun(created.id);
  assert.equal(run.questionGroups?.status, 'skipped');
  const count = calls.length;
  assert.ok(calls.includes('grok:qgroup'));
  orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await orch.idle();
  assert.equal(calls.length, count);
  run = orch.getRun(run.id);
  assert.ok(run.tasks.filter(task => task.phase === 'propose').every(task => /进程树尚未确认退出/.test(task.failure?.message ?? '')));
  orch.cancelRun(run.id);

  const recovered = new Orchestrator({ config: h.config, store: h.store, bus: h.bus,
    adapterFor: () => { throw new Error('恢复后也不得选择或调用模型'); } });
  recovered.recover();
  const next = recovered.createRun(runInput('preference'));
  await recovered.idle();
  assert.ok(recovered.getRun(next.id).tasks.every(task => /进程树尚未确认退出/.test(task.failure?.message ?? '')));
  await assert.rejects(recovered.shutdown(), /无法确认全部模型子进程树已结束/);
});

test('无作业设计任务的适配器抛错会持久阻断同进程队列与恢复后派发', async () => {
  const h = makeHarness({}, config => { config.limits.maxConcurrentModelTasks = 1; });
  let calls = 0;
  const throwing: ModelAdapter = {
    kind: 'mock',
    async run() {
      calls++;
      throw new Error('适配器未返回退出元数据');
    },
  };
  const orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => throwing });
  const created = orch.createRun(runInput('preference'));
  await orch.idle();

  const run = orch.getRun(created.id);
  assert.equal(calls, 1);
  assert.equal(run.jobs.length, 0);
  assert.equal(run.tasks.length, 2);
  assert.match(run.tasks[0]!.failure?.message ?? '', /适配器未返回退出元数据/);
  assert.equal(run.tasks[1]!.executionCalls?.length, 0);
  assert.match(run.tasks[1]!.failure?.message ?? '', /进程树尚未确认退出/);
  assert.throws(() => assertDispatchSafe(h.config.dataDir), /模型派发已锁定/);

  orch.cancelRun(run.id);
  let recoveredCalls = 0;
  const recovered = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({
    kind: 'mock',
    async run() {
      recoveredCalls++;
      throw new Error('恢复后不应调用适配器');
    },
  }) });
  recovered.recover();
  assert.throws(() => assertDispatchSafe(h.config.dataDir), /模型派发已锁定/);
  const next = recovered.createRun(runInput('preference'));
  await recovered.idle();
  assert.equal(recoveredCalls, 0);
  const recoveredTasks = recovered.getRun(next.id).tasks;
  assert.ok(recoveredTasks.every(task => (task.executionCalls?.length ?? 0) === 0));
  assert.ok(recoveredTasks.every(task => /未确认退出|模型派发已锁定/.test(task.failure?.message ?? '')));
});

test('适配器正常返回但缺少进程启动事实时也持久阻断后续派发', async () => {
  const h = makeHarness({}, config => { config.limits.maxConcurrentModelTasks = 1; });
  const mock = new MockAdapter({ delayMs: 0 });
  let calls = 0;
  const incomplete: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      calls++;
      const result = await mock.run(spec, progress, signal);
      const meta = { ...result.meta };
      delete meta.processStarted;
      return { ...result, meta };
    },
  };
  const orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => incomplete });
  const created = orch.createRun(runInput('preference'));
  await orch.idle();

  const run = orch.getRun(created.id);
  assert.equal(calls, 1);
  assert.match(run.tasks[0]!.meta?.terminationWarning ?? '', /processStarted|启动事实|启动或退出状态未知/);
  assert.equal(run.tasks[1]!.executionCalls?.length, 0);
  assert.match(run.tasks[1]!.failure?.message ?? '', /进程树尚未确认退出/);
  assert.throws(() => assertDispatchSafe(h.config.dataDir), /模型派发已锁定/);

  orch.cancelRun(run.id);
  let recoveredCalls = 0;
  const recovered = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({
    kind: 'mock',
    async run() {
      recoveredCalls++;
      throw new Error('恢复后不应调用适配器');
    },
  }) });
  recovered.recover();
  const next = recovered.createRun(runInput('preference'));
  await recovered.idle();
  assert.equal(recoveredCalls, 0);
  assert.throws(() => assertDispatchSafe(h.config.dataDir), /模型派发已锁定/);
  assert.ok(recovered.getRun(next.id).tasks.every(task => (task.executionCalls?.length ?? 0) === 0));
});

test('作业适配器抛错保留 unknown 预算和未确认写锁', async () => {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = false;
    config.finalReview.enabled = false;
    config.build.autoRework = false;
  });
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec, progress, signal) {
      if (spec.phase === 'build') throw new Error('构建适配器抛错');
      return mock.run(spec, progress, signal);
    },
  };
  const orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => adapter });
  const gated = await reachFrameworkGate(orch);
  const candidateId = gated.decision!.winnerId ?? gated.candidates[0]!.id;
  const defaults = orch.frameworkGateDefaults(gated.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(gated.id, {
    gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec],
    efforts: {}, recheckItemIds: [], reason: null,
  });
  await orch.idle();

  const run = orch.getRun(gated.id);
  const job = run.jobs[0]!;
  const build = run.tasks.find(task => task.jobId === job.id && task.phase === 'build')!;
  const call = job.budget?.calls.find(item => item.taskId === build.id);
  assert.equal(build.status, 'failed');
  assert.equal(call?.state, 'unknown');
  assert.ok(call && job.budget?.reservedCalls.includes(call.id));
  assert.equal(job.budget?.usage.modelCalls, 0);
  assert.equal(job.writeLock?.taskId, build.id);
  assert.equal(job.writeLock?.state, 'unconfirmed');
  assert.match(job.writeLock?.reason ?? '', /启动或退出状态(?:未知|未确认)/);
  assert.throws(() => assertDispatchSafe(h.config.dataDir), /模型派发已锁定/);
});
