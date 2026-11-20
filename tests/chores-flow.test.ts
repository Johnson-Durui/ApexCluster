import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/adapters/mock.js';
import type { AdapterProgress, AdapterResult, ModelAdapter, ModelTaskSpec } from '../src/adapters/types.js';
import type { Run } from '../src/core/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { makeHarness, runInput } from './helpers.js';

type Harness = ReturnType<typeof makeHarness>;

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function toFramework(h: Harness, patch: Parameters<typeof runInput>[1] = {}): Promise<Run> {
  const created = h.orch.createRun(runInput('preference', { clarifyWith: 'skip', ...patch }));
  await h.orch.idle();
  const run = h.orch.getRun(created.id);
  assert.equal(run.phase, 'framework_gate');
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

test('显式 qgroup 完整分组全部问题，且不改答案或 G1', async () => {
  const h = makeHarness({ delayMs: 75 }, config => { config.chores.qgroup = true; });
  const created = h.orch.createRun(runInput('preference'));
  await waitUntil(() => h.orch.getRun(created.id).phase === 'answering', 'G1 未打开');
  const before = h.orch.getRun(created.id);
  assert.equal(before.phase, 'answering');
  const question = before.questions[0]!;
  h.orch.answerQuestion(before.id, question.id, {
    status: 'answered', optionIds: [question.options[0]!.id], otherText: null, note: '保留此答案',
  });
  const answered = structuredClone(h.orch.getRun(before.id).questions);
  await h.orch.idle();
  const run = h.orch.getRun(before.id);
  assert.equal(run.questionGroups?.status, 'ready');
  assert.deepEqual(
    run.questionGroups!.output!.groups.flatMap(group => group.questionIds).sort(),
    run.questions.map(item => item.id).sort(),
  );
  assert.deepEqual(run.questions, answered);
  assert.equal(run.phase, 'answering');
  assert.equal(run.tasks.filter(task => task.phase === 'qgroup' && task.role === 'grok').length, 1);
});

test('旧运行缺 chores 字段时不因新配置补开 qgroup 或 digest', async () => {
  const h = makeHarness({ delayMs: 25 }, config => { config.chores = { qgroup: true, digest: true }; });
  const created = h.orch.createRun(runInput('preference'));
  delete created.chores;
  await h.orch.idle();
  let run = h.orch.getRun(created.id);
  assert.equal(run.phase, 'answering');
  assert.equal(run.tasks.some(task => task.role === 'grok'), false);
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  run = await validateWinner(h, run);
  assert.equal(run.phase, 'final_gate');
  assert.equal(run.tasks.some(task => task.phase === 'digest' || task.phase === 'qgroup'), false);
  assert.equal(run.jobs[0]!.digest, undefined);
});

test('杂活失败不修复、不降级、不阻塞 G1/G4', async () => {
  const h = makeHarness({ inject: { 'grok.qgroup.1': 'invalid_json', 'grok.digest.1': 'process_error' } }, config => {
    config.chores = { qgroup: true, digest: true };
  });
  const created = h.orch.createRun(runInput('preference'));
  await h.orch.idle();
  let run = h.orch.getRun(created.id);
  assert.equal(run.phase, 'answering');
  assert.equal(run.questionGroups?.status, 'skipped');
  const qgroup = run.tasks.filter(task => task.phase === 'qgroup');
  assert.equal(qgroup.length, 1);
  assert.equal(qgroup[0]!.repairAttempted, false);
  assert.equal(qgroup[0]!.role, 'grok');

  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  run = await validateWinner(h, h.orch.getRun(run.id));
  assert.equal(run.phase, 'final_gate');
  assert.equal(run.phaseStatus, 'waiting_user');
  assert.equal(run.jobs[0]!.digest?.status, 'skipped');
  const digests = run.tasks.filter(task => task.phase === 'digest');
  assert.equal(digests.length, 1);
  assert.equal(digests[0]!.repairAttempted, false);
  assert.equal(digests[0]!.role, 'grok');
});

test('digest 是旁路记录，不改变独立核验、终审和 G4', async () => {
  const h = makeHarness({}, config => {
    config.chores.digest = true;
    config.evaluator.enabled = true;
    config.finalReview.enabled = true;
  });
  let run = await toFramework(h);
  run = await validateWinner(h, run);
  const job = run.jobs[0]!;
  assert.equal(run.phase, 'final_gate');
  assert.equal(job.digest?.status, 'ready');
  assert.equal(job.rounds?.length, 1);
  assert.equal(job.rounds?.[0]!.evaluation?.verdict, 'pass');
  assert.equal(job.finalReview?.verdict, 'accept_with_notes');
  assert.deepEqual(
    run.tasks.filter(task => task.jobId === job.id).map(task => task.phase),
    ['build', 'evaluate', 'final_review', 'digest'],
  );
  assert.equal(job.status, 'awaiting_manual');
});

test('共享调用预算不足时 digest 明确跳过且不创建任务', async () => {
  const h = makeHarness({}, config => {
    config.chores.digest = true;
    config.evaluator.enabled = true;
    config.finalReview.enabled = true;
  });
  let run = await toFramework(h, { build: { maxModelCalls: 3 } });
  run = await validateWinner(h, run);
  const job = run.jobs[0]!;
  assert.equal(run.phase, 'final_gate');
  assert.equal(job.budget?.usage.modelCalls, 3);
  assert.equal(job.digest?.status, 'skipped');
  assert.match(job.digest?.reason ?? '', /预算/);
  assert.equal(run.tasks.some(task => task.phase === 'digest'), false);
});

test('迟到的旧问题快照只归档，不覆盖当前问题分组', async () => {
  const h = makeHarness({ delayMs: 120 }, config => { config.chores.qgroup = true; });
  const created = h.orch.createRun(runInput('preference'));
  await waitUntil(() => h.orch.getRun(created.id).phase === 'answering', 'G1 未打开');
  h.orch.resolveGate(created.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  const run = h.orch.getRun(created.id);
  const task = run.tasks.find(item => item.phase === 'qgroup')!;
  assert.equal(task.status, 'succeeded');
  assert.match(task.staleReason ?? '', /快照已改变/);
  assert.equal(run.questionGroups?.status, 'skipped');
  assert.equal(run.questionGroups?.output, null);
  assert.equal(run.phase, 'framework_gate');
});

test('迟到的旧轮次 digest 不覆盖新轮次摘要', async () => {
  const base = makeHarness({}, config => { config.chores.digest = true; });
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = {
    kind: 'mock',
    async run(spec: ModelTaskSpec, progress: (value: AdapterProgress) => void, signal: AbortSignal): Promise<AdapterResult> {
      if (spec.phase === 'digest') {
        await new Promise(resolve => setTimeout(resolve, 100));
        return mock.run(spec, progress, new AbortController().signal);
      }
      return mock.run(spec, progress, signal);
    },
  };
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => adapter });
  const created = orch.createRun(runInput('preference', { clarifyWith: 'skip' }));
  await orch.idle();
  let run = orch.getRun(created.id);
  const candidateId = run.decision!.winnerId!;
  const defaults = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await waitUntil(() => orch.getRun(run.id).phase === 'final_gate', '首轮 G4 未打开');
  run = orch.getRun(run.id);
  const oldDigestTaskId = run.jobs[0]!.digest!.taskId!;
  orch.resolveGate(run.id, { gate: 'G4_final', action: 'retry_job', chosenCandidateId: null, jobId: run.jobs[0]!.id,
    manualResults: [], failureClassOverrides: {}, reason: null });
  await orch.idle();
  run = orch.getRun(run.id);
  assert.equal(run.jobs[0]!.rounds?.length, 2);
  assert.equal(run.jobs[0]!.digest?.status, 'ready');
  assert.notEqual(run.jobs[0]!.digest?.taskId, oldDigestTaskId);
  assert.equal(run.tasks.find(task => task.id === oldDigestTaskId)?.status, 'cancelled');
  assert.equal(run.tasks.some(task => task.id === oldDigestTaskId), true, '旧轮次任务记录必须保留归档');
});

for (const capabilities of [null, {
  verifiedAt: '2026-10-23T00:00:00.000Z', cliVersion: 'legacy-cli', model: 'grok-4.7-high-fast',
  stdinPromptVerified: true, readOnlyToolsVerified: true, commandExitEventsVerified: false, fileChangesVerified: false,
}]) test(`真实运行即使客户端启用杂活，${capabilities ? '旧能力记录' : 'capabilities=null'} 也不派发 Grok`, async () => {
  const base = makeHarness({}, config => {
    config.adapters.cursor.capabilities = capabilities;
    config.chores.qgroup = false;
  });
  const mock = new MockAdapter({ delayMs: 0 });
  let grokCalls = 0;
  const orch = new Orchestrator({
    config: base.config,
    store: base.store,
    bus: base.bus,
    adapterFor: role => ({
      kind: 'mock',
      run: (...args) => {
        if (role === 'grok') grokCalls++;
        return mock.run(...args);
      },
    }),
  });
  const input = runInput('preference', { mode: 'real', mockScenario: null, chores: { qgroup: true, digest: true } });
  const created = orch.createRun(input);
  await orch.idle();
  const run = orch.getRun(created.id);
  assert.equal(run.phase, 'answering');
  assert.equal(run.questionGroups?.status, 'skipped');
  assert.match(run.questionGroups?.reason ?? '', /H7|未经/);
  assert.equal(run.tasks.some(task => task.role === 'grok'), false);
  assert.equal(grokCalls, 0);
});

test('重启中断摘要只标跳过，不覆盖已完成核验，恢复关卡不新派整理任务', async () => {
  const h = makeHarness({}, config => { config.chores.digest = true; });
  let run = await toFramework(h);
  run = await validateWinner(h, run);
  const job = run.jobs[0]!;
  const verification = structuredClone(job.verification);
  const status = job.status;
  const round = structuredClone(job.rounds![0]);
  const digest = run.tasks.find(task => task.phase === 'digest')!;
  digest.status = 'running';
  job.digest!.status = 'pending';
  const call = job.budget!.calls.find(item => item.taskId === digest.id)!;
  call.state = 'started'; call.activeMs = null;
  h.store.save(run);
  const recovered = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => { throw new Error('恢复不能调用模型'); } });
  recovered.recover();
  assert.equal(job.status, status);
  assert.deepEqual(job.verification, verification);
  assert.deepEqual(job.rounds![0], round);
  assert.equal(job.digest!.status, 'skipped');
  assert.equal(call.state, 'unknown');
  const taskCount = run.tasks.length;
  run.phase = 'validate'; run.phaseStatus = 'running'; delete job.digest;
  recovered.recover();
  await recovered.idle();
  assert.equal(run.phase, 'final_gate');
  assert.equal(run.tasks.length, taskCount);
  assert.equal(job.digest, undefined);
});

test('人工验收更新后旧摘要过期但不自动重跑 Grok', async () => {
  const h = makeHarness({}, config => { config.chores.digest = true; });
  const run = await validateWinner(h, await toFramework(h));
  const job = run.jobs[0]!;
  assert.equal(job.digest?.status, 'ready');
  const manual = job.spec.acceptance.find(item => item.kind === 'manual')!;
  const count = run.tasks.length;
  h.orch.setManualResult(run.id, job.id, manual.id, true, '人工确认');
  assert.equal(job.digest?.status, 'skipped');
  assert.equal(job.digest?.output, null);
  assert.equal(run.tasks.length, count);
});

test('排队整理被取消或关闭时记为 skipped，保持已可用的人工关卡', async () => {
  const h = makeHarness({}, config => { config.chores = { qgroup: true, digest: true }; });
  let run = h.orch.createRun(runInput('preference'));
  await h.orch.idle();
  const grouping = run.tasks.find(task => task.phase === 'qgroup')!;
  grouping.status = 'queued'; run.questionGroups!.status = 'pending';
  h.orch.cancelTask(run.id, grouping.id);
  assert.equal(run.questionGroups?.status, 'skipped');
  assert.equal(run.phase, 'answering');
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  run = await validateWinner(h, run);
  const job = run.jobs[0]!;
  const status = job.status;
  const digest = run.tasks.find(task => task.phase === 'digest')!;
  digest.status = 'queued'; job.digest!.status = 'pending';
  await h.orch.shutdown();
  assert.equal(job.digest?.status, 'skipped');
  assert.equal(job.status, status);
  assert.equal(run.phase, 'final_gate');
  assert.equal(run.phaseStatus, 'waiting_user');
});

test('G4 停止时仍在进行的摘要迟到后记 skipped，不能覆盖终态', async () => {
  const base = makeHarness({}, config => { config.chores.digest = true; });
  const mock = new MockAdapter({ delayMs: 0 });
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const adapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal) {
    if (spec.phase === 'digest') await waiting;
    return mock.run(spec, progress, signal);
  } };
  const orch = new Orchestrator({ config: base.config, store: base.store, bus: base.bus, adapterFor: () => adapter });
  const run = orch.createRun(runInput('preference', { clarifyWith: 'skip' }));
  await orch.idle();
  const candidateId = run.decision!.winnerId!;
  const spec = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!.spec;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [spec], efforts: {}, recheckItemIds: [], reason: null });
  await waitUntil(() => run.phase === 'final_gate' && run.tasks.some(task => task.phase === 'digest' && task.status === 'running'), '摘要没有运行');
  const verification = structuredClone(run.jobs[0]!.verification);
  orch.resolveGate(run.id, { gate: 'G4_final', action: 'stop', chosenCandidateId: null, jobId: null, manualResults: [], failureClassOverrides: {}, reason: '结束本次评估' });
  release!();
  await orch.idle();
  assert.equal(run.terminal, 'done');
  assert.equal(run.jobs[0]!.digest?.status, 'skipped');
  assert.deepEqual(run.jobs[0]!.verification, verification);
});
