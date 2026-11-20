import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GateInputZ } from '../src/core/schemas.js';
import type { PreflightResult, Run } from '../src/core/types.js';
import { renderDecisionRecord } from '../src/core/report.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { RunStore } from '../src/orchestrator/store.js';
import { EventBus } from '../src/orchestrator/events.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { makeHarness, runInput } from './helpers.js';

type H = ReturnType<typeof makeHarness>;
const result = (ok: boolean, n = 0): PreflightResult => ({
  ok, checkedAt: `2026-10-21T00:00:0${n}.000Z`,
  items: [{ check: 'node', status: ok ? 'ok' : 'missing', detail: ok ? 'v24（假探测）' : '测试环境缺少工具' }],
});
async function framework(h: H, writeDocs = false) {
  const run = h.orch.createRun(runInput('clear', { clarifyWith: 'skip', preflightEnabled: true, writeDocs }));
  await h.orch.idle();
  assert.equal(run.phase, 'framework_gate');
  return run;
}
function build(h: H, run: Run) {
  const id = run.decision!.winnerId!;
  const d = h.orch.frameworkGateDefaults(run.id).find(x => x.candidateId === id)!;
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'validate', candidateIds: [id], specs: [{ ...d.spec, allowNetwork: false }] }));
}
const g4 = (h: H, run: Run, action: string, reason?: string) => h.orch.resolveGate(run.id, GateInputZ.parse({
  gate: 'G4_final', action, jobId: run.jobs[0]!.id, reason,
}));

test('T6：缺必需工具时不创建构建任务或工作区，直接G4保留程序报告', async () => {
  let probes = 0;
  const h = makeHarness({}, () => {}, { preflightCheck: async input => {
    probes++;
    assert.equal(existsSync(input.workspaceDir), false);
    return result(false);
  } });
  const run = await framework(h);
  build(h, run);
  await h.orch.idle();
  const job = run.jobs[0]!;
  assert.equal(probes, 1);
  assert.equal(run.phase, 'final_gate');
  assert.equal(job.failureClass, 'environment_issue');
  assert.equal(job.failureClassSource, 'preflight');
  assert.equal(job.status, 'failed');
  assert.equal(job.taskIds.length, 0);
  assert.equal(run.tasks.filter(t => t.phase === 'build').length, 0);
  assert.equal(existsSync(job.workspaceDir), false);
  assert.equal(job.preflight?.ok, false);
  assert.ok(h.store.readTaskFile(run.id, `preflight-${job.id}`, 'PREFLIGHT.md')?.includes('测试环境缺少工具'));
});

test('T6：预检通过后物化报告并注入构建提示词，创建时冻结开关', async () => {
  const h = makeHarness({}, () => {}, { preflightCheck: async () => result(true) });
  const run = await framework(h);
  h.config.preflight.enabled = false;
  build(h, run);
  await h.orch.idle();
  const job = run.jobs[0]!;
  assert.equal(run.preflight?.enabled, true);
  assert.equal(job.preflight?.ok, true);
  assert.equal(job.taskIds.length, 1);
  assert.deepEqual(job.firstVerification, job.verification);
  assert.notEqual(job.firstVerification, job.verification);
  assert.ok(readFileSync(path.join(job.workspaceDir, 'PREFLIGHT.md'), 'utf8').includes('假探测'));
  assert.ok(h.store.readTaskFile(run.id, job.taskIds[0]!, 'prompt.md')?.includes('假探测'));
});

test('T6：重跑预检只更新报告，仍须显式重试构建，旧报告入历史', async () => {
  let probes = 0;
  const h = makeHarness({}, () => {}, { preflightCheck: async () => result(++probes > 1, probes) });
  const run = await framework(h);
  build(h, run);
  await h.orch.idle();
  h.orch.rerunPreflight(run.id, run.jobs[0]!.id);
  await h.orch.idle();
  assert.equal(probes, 2);
  assert.equal(run.phase, 'final_gate');
  assert.equal(run.jobs[0]!.preflight?.ok, true);
  assert.equal(run.jobs[0]!.preflightHistory?.length, 2);
  assert.equal(run.tasks.filter(t => t.phase === 'build').length, 0);
  g4(h, run, 'retry_job');
  await h.orch.idle();
  assert.equal(probes, 3);
  assert.equal(run.jobs[0]!.taskIds.length, 1);
});

test('T6：忽略预检必须有理由，显式继续只忽略本次报告，下一次重试重新查', async () => {
  let probes = 0;
  const h = makeHarness({}, () => {}, { preflightCheck: async () => result(false, ++probes) });
  const run = await framework(h);
  build(h, run);
  await h.orch.idle();
  assert.throws(() => g4(h, run, 'ignore_preflight', '  '), /理由/);
  assert.equal(run.jobs[0]!.preflightOverride, null);
  g4(h, run, 'ignore_preflight', '已确认使用项目内便携工具');
  await h.orch.idle();
  assert.equal(probes, 1);
  assert.equal(run.jobs[0]!.taskIds.length, 1);
  assert.equal(h.orch.getRun(run.id).jobs[0]!.preflightOverride?.reason, '已确认使用项目内便携工具');
  g4(h, run, 'retry_job');
  await h.orch.idle();
  assert.equal(probes, 2);
  assert.equal(run.jobs[0]!.taskIds.length, 1);
  assert.equal(run.jobs[0]!.preflightOverride, null);
  assert.equal(run.jobs[0]!.preflightAudit?.length, 1);
  assert.equal(run.jobs[0]!.preflightAudit?.[0]?.reason, '已确认使用项目内便携工具');
  assert.equal(run.jobs[0]!.preflightAudit?.[0]?.report.checkedAt, result(false, 1).checkedAt);
  assert.notEqual(run.jobs[0]!.preflightAudit?.[0]?.report, run.jobs[0]!.preflightHistory?.[0]);
  assert.ok(renderDecisionRecord(run).includes('已确认使用项目内便携工具'));
});

test('T6：G3前不预检、旧运行无冻结字段时不新增步骤', async () => {
  let probes = 0;
  const h = makeHarness({}, () => {}, { preflightCheck: async () => { probes++; return result(true); } });
  const run = await framework(h, true);
  build(h, run);
  await h.orch.idle();
  assert.equal(run.phase, 'docs_gate');
  assert.equal(probes, 0);
  assert.throws(() => h.orch.rerunPreflight(run.id, run.jobs[0]!.id), /关卡|G4|验收/);
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G3_docs', action: 'approve' }));
  await h.orch.idle();
  assert.equal(probes, 1);

  const old = await framework(h);
  delete old.preflight;
  build(h, old);
  await h.orch.idle();
  assert.equal(probes, 1);
  assert.equal(old.jobs[0]!.preflight, undefined);
  assert.equal(old.jobs[0]!.taskIds.length, 1);
  assert.throws(() => h.orch.rerunPreflight(old.id, old.jobs[0]!.id), /未启用/);
});

test('T6：检查中重复操作被拒绝，取消后迟到报告不能创建构建任务', async () => {
  let finish!: (value: PreflightResult) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const h = makeHarness({}, () => {}, { preflightCheck: async (_input, options) => {
    started();
    const value = await new Promise<PreflightResult>(resolve => { finish = resolve; });
    assert.equal(options?.signal?.aborted, true);
    return value;
  } });
  const run = await framework(h);
  build(h, run);
  await began;
  assert.throws(() => h.orch.rerunPreflight(run.id, run.jobs[0]!.id), /关卡|G4|验收/);
  h.orch.cancelRun(run.id);
  finish(result(true));
  await h.orch.idle();
  assert.equal(run.terminal, 'cancelled');
  assert.equal(run.jobs[0]!.status, 'cancelled');
  assert.equal(run.tasks.filter(t => t.phase === 'build').length, 0);
});

test('T6：重启恢复尚无模型任务的预检作业，不自动重跑', async () => {
  const h = makeHarness({}, () => {}, { preflightCheck: async () => result(false) });
  const run = await framework(h);
  build(h, run);
  await h.orch.idle();
  run.jobs[0]!.status = 'preparing';
  run.phase = 'validate'; run.phaseStatus = 'running';
  h.store.save(run);
  let probes = 0;
  const store = new RunStore(h.config.dataDir);
  const recovered = new Orchestrator({ config: h.config, store, bus: new EventBus(store), adapterFor: () => new MockAdapter(), preflightCheck: async () => { probes++; return result(true); } });
  recovered.recover();
  await recovered.idle();
  assert.equal(probes, 0);
  const restored = recovered.getRun(run.id);
  assert.equal(restored.phase, 'final_gate');
  assert.equal(restored.jobs[0]!.status, 'failed');
  assert.equal(restored.tasks.filter(t => t.phase === 'build').length, 0);
});

test('T6：实际调用计时独立于准备与校验，结构修复单独记录', async () => {
  let tick = 0;
  const h = makeHarness({ inject: { 'claude.propose.1': 'invalid_json' } }, () => {}, {
    now: () => new Date(Date.UTC(2026, 9, 21) + tick++ * 1000).toISOString(),
  });
  const run = h.orch.createRun(runInput('clear', { clarifyWith: 'skip' }));
  await h.orch.idle();
  const task = run.tasks.find(t => t.role === 'claude' && t.phase === 'propose')!;
  assert.deepEqual(task.executionCalls?.map(call => call.kind), ['initial', 'repair']);
  assert.ok(task.executionCalls!.every(call => call.endedAt && call.status === 'succeeded'));
  assert.ok(task.startedAt! < task.executionCalls![0]!.startedAt);
  assert.ok(task.executionCalls![1]!.endedAt! < task.endedAt!);
  const metrics = h.orch.metrics(run.id);
  assert.equal(metrics.modelTime.total.unknownCount, 0);
  assert.equal(metrics.modelTime.total.knownCount, run.tasks.flatMap(t => t.executionCalls ?? []).length);
  assert.ok(metrics.modelTime.buckets.some(bucket => bucket.kind === 'repair'));
});

test('T6：准备失败没有实际模型调用，不把准备时间计入模型分钟', async () => {
  const h = makeHarness();
  const run = h.orch.createRun(runInput('clear', { clarifyWith: 'skip' }));
  await h.orch.idle();
  const blocker = path.join(h.dir, 'workspace-is-a-file');
  writeFileSync(blocker, 'test');
  h.config.workspacesRoot = blocker;
  build(h, run);
  await h.orch.idle();
  const task = run.tasks.find(t => t.phase === 'build')!;
  assert.equal(task.status, 'failed');
  assert.deepEqual(task.executionCalls, []);
  assert.equal(h.orch.metrics(run.id).modelTime.buckets.some(bucket => bucket.phase === 'build'), false);
});

test('T6：创建时配置指纹覆盖平台和超时，调用时检测漂移且不重写原指纹', async () => {
  const h = makeHarness();
  const first = h.orch.createRun(runInput('clear', { clarifyWith: 'skip' }));
  await h.orch.idle();
  const fingerprint = first.metricsConfig!.fingerprint;
  h.config.targetPlatform += '（其他平台）';
  const second = h.orch.createRun(runInput('clear', { clarifyWith: 'skip' }));
  await h.orch.idle();
  assert.notEqual(second.metricsConfig!.fingerprint, fingerprint);
  h.config.timeoutsMinutes.propose += 1;
  const third = h.orch.createRun(runInput('clear', { clarifyWith: 'skip' }));
  await h.orch.idle();
  assert.notEqual(third.metricsConfig!.fingerprint, second.metricsConfig!.fingerprint);
  build(h, first);
  await h.orch.idle();
  assert.equal(first.metricsConfig!.fingerprint, fingerprint);
  assert.equal(first.metricsConfig!.drifted, true);
  assert.equal(h.orch.metrics(first.id).grouping.frozenConfigFingerprint, null);
  assert.equal(third.metricsConfig!.drifted, undefined);
});

test('T6：恢复中断调用保留未知结束时间，不计服务停机时间', async () => {
  const h = makeHarness();
  const run = h.orch.createRun(runInput('clear', { clarifyWith: 'skip' }));
  await h.orch.idle();
  const task = run.tasks[0]!;
  task.status = 'running';
  task.executionCalls = [{ kind: 'initial', startedAt: '2026-10-01T00:00:00.000Z', endedAt: null, status: 'running' }];
  run.phase = 'propose'; run.phaseStatus = 'running';
  h.store.save(run);
  const store = new RunStore(h.config.dataDir);
  const recovered = new Orchestrator({ config: h.config, store, bus: new EventBus(store), adapterFor: () => new MockAdapter() });
  recovered.recover();
  await recovered.idle();
  const restored = recovered.getRun(run.id);
  assert.equal(restored.tasks[0]!.executionCalls![0]!.status, 'interrupted');
  assert.equal(restored.tasks[0]!.executionCalls![0]!.endedAt, null);
  const bucket = recovered.metrics(run.id).modelTime.buckets.find(b => b.status === 'interrupted')!;
  assert.equal(bucket.minutes, 0);
  assert.equal(bucket.unknownCount, 1);
});
