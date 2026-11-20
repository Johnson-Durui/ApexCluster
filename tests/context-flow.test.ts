import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { MockAdapter, type MockOptions } from '../src/adapters/mock.js';
import type { AdapterResult, ModelAdapter, ModelTaskSpec } from '../src/adapters/types.js';
import { defaultConfig } from '../src/config.js';
import type { Run } from '../src/core/types.js';
import { EventBus } from '../src/orchestrator/events.js';
import { contextInvocationCount } from '../src/orchestrator/build-context.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { RunStore } from '../src/orchestrator/store.js';
import { runInput } from './helpers.js';

const roots: string[] = [];
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

function contextHarness(adapter?: ModelAdapter, options: Partial<MockOptions> = {}) {
  const parent = path.resolve('.test-tmp');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'context-flow-'));
  roots.push(dir);
  const config = defaultConfig(dir);
  config.dataDir = path.join(dir, 'data');
  config.workspacesRoot = path.join(dir, 'ws');
  config.preflight.enabled = false;
  config.contextBudget.enabled = true;
  config.evaluator.enabled = true;
  config.finalReview.enabled = true;
  config.build.resumePolicy = 'budgeted';
  const store = new RunStore(config.dataDir);
  const bus = new EventBus(store);
  const selected = adapter ?? new MockAdapter({ delayMs: 0, ...options });
  const orch = new Orchestrator({ config, store, bus, adapterFor: () => selected });
  return { dir, config, store, bus, orch };
}

type Harness = ReturnType<typeof contextHarness>;

async function framework(h: Harness): Promise<Run> {
  const created = h.orch.createRun(runInput('preference', {
    clarifyWith: 'skip', contextBudget: { enabled: true },
    build: { autoRework: false, resumePolicy: 'budgeted' },
    evaluator: { enabled: true }, finalReview: { enabled: true },
  }));
  await h.orch.idle();
  const run = h.orch.getRun(created.id);
  assert.equal(run.phase, 'framework_gate', `${run.phase}/${run.phaseStatus}: ${run.blockedReason ?? ''}`);
  return run;
}

function candidateWithWorkstreams(run: Run, count: number): string {
  const candidate = run.candidates.find(item => {
    const proposal = run.proposals.find(proposalItem => proposalItem.id === item.representativeProposalId);
    return proposal?.mvpPlan.workstreams.length === count;
  });
  assert.ok(candidate, `缺少 ${count} 个 workstream 的候选`);
  return candidate.id;
}

async function validateCandidate(h: Harness, run: Run, candidateId: string, buildOverrides?: Record<string, object>): Promise<Run> {
  const defaults = h.orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  h.orch.resolveGate(run.id, {
    gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {},
    buildOverrides, recheckItemIds: [], reason: null,
  });
  await h.orch.idle();
  return h.orch.getRun(run.id);
}

function buildTasks(run: Run) {
  return run.tasks.filter(task => task.phase === 'build' && task.jobId);
}

test('上下文小任务跳过 init，按 milestone → final → evaluate → final_review 完成', async () => {
  const h = contextHarness();
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 1));
  const job = run.jobs[0]!;
  const sessions = job.rounds?.[0]?.context?.sessions ?? [];
  assert.deepEqual(sessions.map(item => [item.kind, item.finalVerification]), [['milestone', false], ['milestone', true]]);
  assert.deepEqual(buildTasks(run).map(task => task.buildKind), ['milestone', 'milestone']);
  assert.deepEqual(run.tasks.filter(task => task.jobId).map(task => task.phase), ['build', 'build', 'evaluate', 'final_review']);
  assert.equal(job.rounds?.[0]?.context?.states[0]?.status, 'awaiting_manual');
  assert.equal(job.finalReview?.verdict, 'accept_with_notes');
  assert.equal(run.phase, 'final_gate');
});

test('上下文复杂任务先 init 冻结计划，再逐里程碑并最终整轮验收；未知 usage 从不续接', async () => {
  const captured: ModelTaskSpec[] = [];
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal) {
    if (spec.phase === 'build') captured.push(spec);
    return mock.run(spec, progress, signal);
  } };
  const h = contextHarness(adapter);
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 2));
  const job = run.jobs[0]!;
  const round = job.rounds?.[0]!;
  assert.equal(round.context?.sessions[0]?.kind, 'init');
  assert.equal(round.context?.plan?.milestones.length, job.spec.acceptance.length);
  assert.deepEqual(round.context?.sessions.slice(1).map(item => item.finalVerification), [false, false, false, true]);
  assert.equal(round.context?.states.every(state => state.status === 'passed' || state.status === 'awaiting_manual'), true);
  assert.equal(captured.every(spec => spec.resumeSessionId === null), true);
  assert.equal(round.context?.sessions.every(session => session.context.usageSemantics === 'unknown'), true);
  assert.deepEqual(run.tasks.filter(task => task.jobId).slice(-2).map(task => task.phase), ['evaluate', 'final_review']);
});

test('每个构建任务首次结构无效再修复时按真实调用耗尽 plan+3 上限，并分别保留调用身份', async () => {
  const mock = new MockAdapter({ delayMs: 0 });
  const calls = new Map<string, number>();
  const adapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal): Promise<AdapterResult> {
    const result = await mock.run(spec, progress, signal);
    if (spec.phase !== 'build') return result;
    const count = (calls.get(spec.taskId) ?? 0) + 1;
    calls.set(spec.taskId, count);
    result.meta.sessionId = `${count === 1 ? 'initial' : 'repair'}-${spec.taskId}`;
    result.meta.usage = { input_tokens: count === 1 ? 111 : 999 };
    if (count === 1) {
      result.rawText = '{}';
      result.structured = null;
    }
    return result;
  } };
  const h = contextHarness(adapter);
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 2));
  const job = run.jobs[0]!;
  const round = job.rounds?.[0]!;
  const tasks = buildTasks(run);

  assert.equal(round.context?.plan?.milestones.length, 3);
  assert.equal(tasks.length, 3, 'init 与前两个 milestone 各修复一次后应耗尽 6 次调用');
  assert.equal(contextInvocationCount(run, round), 6);
  assert.equal(tasks.every(task => task.repairAttempted && task.outputValidity === 'repaired'), true);
  assert.equal(tasks.every(task => task.executionCalls?.length === 2), true);
  assert.match(round.stoppedReason ?? '', /会话上限|结构修复/);
  assert.equal(job.verification, null);
  assert.equal(job.status, 'inconclusive');
  assert.equal(run.tasks.some(task => task.jobId === job.id && ['evaluate', 'final_review'].includes(task.phase)), false);

  for (const session of round.context?.sessions ?? []) {
    assert.deepEqual(session.invocations?.map(item => item.kind), ['initial', 'repair']);
    assert.equal(session.invocations?.[0]?.threadId, `initial-${session.taskId}`);
    assert.equal(session.invocations?.[1]?.threadId, `repair-${session.taskId}`);
    assert.equal(session.threadId, `initial-${session.taskId}`, '会话主身份必须保留首次调用，而非被 repair 覆盖');
    assert.deepEqual(session.context.usageRaw, { input_tokens: 111 });
    assert.deepEqual(session.invocations?.[1]?.context.usageRaw, { input_tokens: 999 });
  }
});

test('首次非法输出耗到只剩 final 预留时不发 repair，也不预占或消耗保留时间', async () => {
  const mock = new MockAdapter({ delayMs: 0 });
  let buildCalls = 0;
  const adapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal): Promise<AdapterResult> {
    if (spec.phase !== 'build') return mock.run(spec, progress, signal);
    buildCalls += 1;
    const startedAt = '2026-10-23T00:00:00.000Z';
    const timeboxMinutes = spec.context.spec!.timeboxMinutes;
    const result = await mock.run(spec, item => progress(item.kind === 'started' ? { ...item, at: startedAt } : item), signal);
    const elapsedMs = (timeboxMinutes - 1) * 60_000;
    result.meta.startedAt = startedAt;
    result.meta.endedAt = new Date(Date.parse(startedAt) + elapsedMs).toISOString();
    result.meta.durationMs = elapsedMs;
    result.rawText = '{}';
    result.structured = null;
    return result;
  } };
  const h = contextHarness(adapter);
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 1));
  const job = run.jobs[0]!;
  const round = job.rounds?.[0]!;
  const task = buildTasks(run)[0]!;
  const calls = job.budget?.calls.filter(call => call.taskId === task.id) ?? [];

  assert.equal(buildCalls, 1);
  assert.equal(task.repairAttempted, false);
  assert.equal(task.outputValidity, 'invalid');
  assert.equal(task.executionCalls?.length, 1);
  assert.match(task.meta?.warnings.join('\n') ?? '', /未执行结构修复.*预留时间/);
  assert.deepEqual(calls.map(call => call.kind), ['initial']);
  assert.equal(calls[0]?.activeMs, (job.spec.timeboxMinutes - 1) * 60_000);
  assert.equal(round.context?.sessions[0]?.invocations?.length, 1);
  assert.equal(round.context?.sessions[0]?.outcome, 'stopped');
});

test('首次调用缩小会话余量后 repair 会按最新余量重算 timeout', async () => {
  const mock = new MockAdapter({ delayMs: 0 });
  const timeouts: { taskId: string; finalVerification: boolean; timeoutMs: number }[] = [];
  const calls = new Map<string, number>();
  const adapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal): Promise<AdapterResult> {
    if (spec.phase !== 'build') return mock.run(spec, progress, signal);
    timeouts.push({ taskId: spec.taskId, finalVerification: !!spec.context.finalVerification, timeoutMs: spec.timeoutMs });
    const count = (calls.get(spec.taskId) ?? 0) + 1;
    calls.set(spec.taskId, count);
    if (spec.context.finalVerification || count > 1) return mock.run(spec, progress, signal);

    const startedAt = '2026-10-23T00:00:00.000Z';
    const result = await mock.run(spec, item => progress(item.kind === 'started' ? { ...item, at: startedAt } : item), signal);
    const elapsedMs = spec.timeoutMs - 30_000;
    result.meta.startedAt = startedAt;
    result.meta.endedAt = new Date(Date.parse(startedAt) + elapsedMs).toISOString();
    result.meta.durationMs = elapsedMs;
    result.rawText = '{}';
    result.structured = null;
    return result;
  } };
  const h = contextHarness(adapter);
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 1));
  const firstTask = buildTasks(run)[0]!;
  const firstTaskTimeouts = timeouts.filter(item => item.taskId === firstTask.id);

  assert.equal(firstTask.repairAttempted, true);
  assert.equal(firstTask.outputValidity, 'repaired');
  assert.equal(firstTaskTimeouts.length, 2);
  assert.equal(firstTaskTimeouts[1]?.timeoutMs, 30_000);
  assert.ok(firstTaskTimeouts[0]!.timeoutMs > firstTaskTimeouts[1]!.timeoutMs);
  assert.equal(run.phase, 'final_gate');
});

test('上下文任务级故障停止当前轮次，不自动派发后续会话或评审', async () => {
  const h = contextHarness(undefined, { inject: { 'sol.build.1': 'process_error' } });
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 1));
  const job = run.jobs[0]!;
  assert.equal(buildTasks(run).length, 1);
  assert.deepEqual(run.tasks.filter(task => task.jobId).map(task => task.phase), ['build']);
  assert.equal(job.rounds?.[0]?.outcome, 'stopped');
  assert.match(job.rounds?.[0]?.stoppedReason ?? '', /模拟故障|任务级故障|process_error/);
});

test('上下文会话预算不足时保留最终评审额度并停止，不能把局部通过当整轮通过', async () => {
  const h = contextHarness();
  let run = await framework(h);
  const candidateId = candidateWithWorkstreams(run, 1);
  run = await validateCandidate(h, run, candidateId, { [candidateId]: { maxModelCalls: 2 } });
  const job = run.jobs[0]!;
  assert.equal(buildTasks(run).length, 1);
  assert.equal(job.verification, null);
  assert.equal(job.status, 'inconclusive');
  assert.match(job.rounds?.[0]?.stoppedReason ?? '', /预算/);
  assert.equal(job.rounds?.[0]?.context?.states[0]?.status === 'passed' || job.rounds?.[0]?.context?.states[0]?.status === 'awaiting_manual', true);
});

test('最终整轮命令失败会重算并推翻旧里程碑通过证据', async () => {
  const mock = new MockAdapter({ delayMs: 0 });
  const adapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal): Promise<AdapterResult> {
    const result = await mock.run(spec, progress, signal);
    if (spec.phase !== 'build' || !spec.context.finalVerification) return result;
    const command = result.toolLog.find(item => item.type === 'command_execution');
    if (command) { command.exitCode = 1; command.status = 'failed'; command.output = 'final verification regression'; }
    return result;
  } };
  const h = contextHarness(adapter);
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 1));
  const job = run.jobs[0]!;
  assert.equal(job.rounds?.[0]?.context?.states[0]?.status, 'failed');
  assert.equal(job.rounds?.[0]?.context?.sessions.at(-1)?.outcome, 'failed');
  assert.equal(job.verification?.verdict, 'failed');
  assert.equal(job.status === 'passed' || job.status === 'awaiting_manual', false);
});

test('mock 无 Git 时 init 与 final 只读会话的 file_change 证据仍会被拒绝', async () => {
  const fileChange = { seq: 10_000, type: 'file_change' as const, command: null, exitCode: null,
    output: null, status: 'completed', paths: ['unexpected.txt'] };

  const initMock = new MockAdapter({ delayMs: 0 });
  const initAdapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal): Promise<AdapterResult> {
    const result = await initMock.run(spec, progress, signal);
    if (spec.phase === 'build' && spec.context.buildKind === 'init') result.toolLog.push(fileChange);
    return result;
  } };
  const initHarness = contextHarness(initAdapter);
  let initRun = await framework(initHarness);
  initRun = await validateCandidate(initHarness, initRun, candidateWithWorkstreams(initRun, 2));
  const initJob = initRun.jobs[0]!;
  assert.equal(buildTasks(initRun).length, 1);
  assert.equal(buildTasks(initRun)[0]?.status, 'failed');
  assert.equal(initJob.rounds?.[0]?.context?.plan, null);
  assert.equal(initJob.rounds?.[0]?.outcome, 'stopped');
  assert.equal(initRun.tasks.some(task => task.jobId === initJob.id && ['evaluate', 'final_review'].includes(task.phase)), false);

  const finalMock = new MockAdapter({ delayMs: 0 });
  const finalAdapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal): Promise<AdapterResult> {
    const result = await finalMock.run(spec, progress, signal);
    if (spec.phase === 'build' && spec.context.finalVerification) result.toolLog.push(fileChange);
    return result;
  } };
  const finalHarness = contextHarness(finalAdapter);
  let finalRun = await framework(finalHarness);
  finalRun = await validateCandidate(finalHarness, finalRun, candidateWithWorkstreams(finalRun, 1));
  const finalJob = finalRun.jobs[0]!;
  const finalTasks = buildTasks(finalRun);
  assert.equal(finalTasks.length, 2);
  assert.equal(finalTasks.at(-1)?.status, 'failed');
  assert.equal(finalJob.rounds?.[0]?.context?.sessions.at(-1)?.finalVerification, true);
  assert.equal(finalJob.rounds?.[0]?.context?.sessions.at(-1)?.outcome, 'stopped');
  assert.equal(finalJob.status === 'passed' || finalJob.status === 'awaiting_manual', false);
  assert.equal(finalRun.tasks.some(task => task.jobId === finalJob.id && ['evaluate', 'final_review'].includes(task.phase)), false);
});

test('子规格已保存而最终会话尚未派发时崩溃，恢复只给未完成结论且零新调用', async () => {
  const h = contextHarness();
  let run = await framework(h);
  run = await validateCandidate(h, run, candidateWithWorkstreams(run, 1));
  const job = run.jobs[0]!;
  const round = job.rounds![0]!;
  const first = round.context!.sessions[0]!;
  round.context!.sessions = [first];
  round.buildTaskId = first.taskId;
  round.evaluateTaskId = null;
  round.evaluation = null;
  round.verification = structuredClone(first.verification);
  round.outcome = 'pending'; round.stoppedReason = null;
  job.verification = structuredClone(first.verification);
  job.status = 'awaiting_manual'; job.finalReview = null; job.finalReviewTaskId = null;
  job.taskIds = [first.taskId];
  run.tasks = run.tasks.filter(task => !task.jobId || task.id === first.taskId);
  run.phase = 'validate'; run.phaseStatus = 'running';
  h.store.save(run);
  const count = run.tasks.length;
  const recovered = new Orchestrator({ config: h.config, store: new RunStore(h.config.dataDir), bus: h.bus, adapterFor: () => { throw new Error('恢复不能新调用'); } });
  recovered.recover();
  await recovered.idle();
  const restored = recovered.getRun(run.id);
  assert.equal(restored.phase, 'final_gate');
  assert.equal(restored.jobs[0]!.status, 'inconclusive');
  assert.equal(restored.jobs[0]!.verification, null);
  assert.equal(restored.jobs[0]!.rounds![0]!.verification, null);
  assert.ok(restored.jobs[0]!.rounds![0]!.context!.sessions[0]!.verification);
  assert.match(restored.jobs[0]!.rounds![0]!.stoppedReason ?? '', /最终整轮验收尚未完成/);
  assert.equal(restored.tasks.length, count);
});
