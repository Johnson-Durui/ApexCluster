import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { MockAdapter } from '../src/adapters/mock.js';
import { buildCodexArgs, DEFAULT_CODEX_OPTIONS } from '../src/adapters/codex.js';
import type { ModelTaskSpec } from '../src/adapters/types.js';
import { GateInputZ, type AdjudicationOutput } from '../src/core/schemas.js';
import { validateOutput } from '../src/core/validate.js';
import { renderDecisionRecord } from '../src/core/report.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { RunStore } from '../src/orchestrator/store.js';
import { EventBus } from '../src/orchestrator/events.js';
import { createApp } from '../src/server/app.js';
import { makeHarness, runInput } from './helpers.js';

const gate = (action: 'recheck' | 'redesign') => GateInputZ.parse({ gate: 'G2_framework', action });
type Harness = ReturnType<typeof makeHarness>;
async function framework(h: Harness, scenario = 'needs_adjudication') {
  const run = h.orch.createRun(runInput(scenario));
  await h.orch.idle();
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  assert.equal(run.phase, 'framework_gate', run.blockedReason ?? '');
  return run;
}
async function adjudicate(h: Harness) {
  const run = await framework(h);
  h.orch.resolveGate(run.id, gate('recheck'));
  await h.orch.idle();
  return run;
}

test('D8：双方复核后 Astra Ultra 只读裁决，保留分数与 G2，导出可追溯依据', async () => {
  const h = makeHarness();
  const run = await framework(h);
  const before = structuredClone(run.decision!.cells);
  assert.equal(run.adjudications!.length, 0);
  assert.equal(run.tasks.some(task => task.phase === 'adjudicate' || task.role === 'sol'), false);
  h.orch.resolveGate(run.id, gate('recheck'));
  await h.orch.idle();
  assert.equal(run.phase, 'framework_gate');
  assert.equal(run.phaseStatus, 'waiting_user');
  assert.equal(run.decision!.outcome, 'needs_verification');
  assert.deepEqual(run.decision!.cells.map(cell => [cell.lo, cell.hi, cell.kind]), before.map(cell => [cell.lo, cell.hi, cell.kind]));
  assert.equal(run.tasks.filter(task => task.role === 'sol').length, 0);
  assert.equal(run.jobs.length, 0);
  const record = run.adjudications!.at(-1)!;
  const task = run.tasks.find(task => task.id === record.taskId)!;
  assert.equal(task.role, 'astra');
  assert.equal(task.phase, 'adjudicate');
  assert.equal(task.meta!.requestedModel, 'gpt-6.2-astra');
  assert.equal(task.meta!.requestedEffort, 'ultra');
  assert.equal(run.models.astra.effort, 'max');
  assert.equal(task.inputRef, record.snapshotRef);
  assert.equal(record.staleReason, null);
  assert.ok(record.report!.items.length);
  const prompt = h.store.readTaskFile(run.id, task.id, 'prompt.md')!;
  assert.ok(prompt.includes('双方') && prompt.includes('复核') && prompt.includes('不改写'));
  for (const proposal of run.proposals) assert.ok(prompt.includes(proposal.title));
  const md = renderDecisionRecord(run);
  assert.ok(md.includes('Astra Ultra 裁决建议') && md.includes('gpt-6.2-astra / ultra') && md.includes('模拟数据'));
  const historical = structuredClone(run);
  historical.tasks.find(item => item.id === task.id)!.meta!.requestedModel = 'gpt-6-astra';
  assert.ok(renderDecisionRecord(historical).includes('gpt-6-astra / ultra'));
  assert.equal(run.gates.at(-1)!.context.adjudicationTaskId, task.id);
  // 只有显式 G2 validate 才启动 Sol。
  const candidateId = record.report!.recommendation.candidateId!;
  const defaults = h.orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec] }));
  await h.orch.idle();
  assert.equal(run.phase, 'final_gate');
  assert.equal(run.jobs.length, 1);
});

test('D8：分歧已解决或复核降级时不自动调用 Ultra', async () => {
  const resolved = makeHarness();
  const run = await framework(resolved, 'needs_verification');
  resolved.orch.resolveGate(run.id, gate('recheck'));
  await resolved.orch.idle();
  assert.equal(run.decision!.outcome, 'recommend');
  assert.equal(run.tasks.some(task => task.phase === 'adjudicate'), false);
  const partial = makeHarness({ inject: { 'claude.recheck.1': 'rate_limited' } });
  const degraded = await framework(partial);
  partial.orch.resolveGate(degraded.id, gate('recheck'));
  await partial.orch.idle();
  partial.orch.resolveBlocked(degraded.id, 'continue_single');
  await partial.orch.idle();
  assert.equal(degraded.tasks.some(task => task.phase === 'adjudicate'), false);
  assert.equal(degraded.degraded.length, 1);
});

test('D8：失败停住、拒绝单模型跳过、重试保持 Ultra 且无额外复核', async () => {
  const h = makeHarness({ inject: { 'astra.adjudicate.1': 'effort_unsupported' } });
  const run = await adjudicate(h);
  assert.equal(run.phase, 'adjudicate');
  assert.equal(run.phaseStatus, 'blocked');
  assert.equal(run.tasks.filter(task => task.phase === 'adjudicate').length, 1);
  assert.throws(() => h.orch.resolveBlocked(run.id, 'continue_single'), /裁决没有可替代/);
  assert.throws(() => h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'validate' })), /当前不在/);
  h.orch.resolveBlocked(run.id, 'retry_failed');
  await h.orch.idle();
  assert.equal(run.phase, 'framework_gate');
  assert.equal(run.tasks.filter(task => task.phase === 'recheck').length, 2);
  assert.equal(run.tasks.filter(task => task.phase === 'adjudicate').length, 2);
  assert.equal(run.tasks.at(-1)!.meta!.requestedEffort, 'ultra');
  assert.equal(run.tasks.some(task => task.role === 'sol'), false);
});

test('D8：只裁决用户选中且仍未解决的条目，重算 U 编号后仍正确匹配', async () => {
  for (const selectAll of [false, true]) {
    const h = makeHarness();
    const adapter = new MockAdapter({ delayMs: 0 });
    h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({ kind: 'mock', run: async (spec, progress, signal) => {
      const result = await adapter.run(spec, progress, signal);
      if (spec.phase === 'review' && spec.role === 'claude') {
        const output = JSON.parse(result.rawText!) as { reviews: { candidateId: string; scores: { criterionId: string; score: number }[] }[] };
        const review = output.reviews.find(item => spec.context.anonymousMap![item.candidateId]!.endsWith('astra-1'))!;
        review.scores.find(score => score.criterionId === 'fit')!.score = 0;
        result.structured = output;
      }
      return result;
    } }) });
    const run = await framework(h);
    const reliability = run.decision!.keyUncertainties.find(item => item.criterionId === 'reliability')!;
    assert.equal(run.decision!.keyUncertainties.filter(item => item.isKey).length, 2);
    h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'recheck', recheckItemIds: selectAll ? [] : [reliability.id] }));
    await h.orch.idle();
    assert.equal(run.adjudications!.length, 1);
    assert.deepEqual(run.adjudications![0]!.items.map(item => item.criterionId), ['reliability']);
    if (selectAll) assert.notEqual(run.adjudications![0]!.items[0]!.id, reliability.id);
    else assert.equal(run.decision!.keyUncertainties.filter(item => item.isKey).length, 2);
  }
});

test('D8：重新设计后只提供本轮复核日志，不混入历史同批次材料', async () => {
  const h = makeHarness();
  const run = await adjudicate(h);
  for (const entry of run.recheckLog) entry.rationale = 'OLD_ROUND_EVIDENCE_SENTINEL';
  h.orch.resolveGate(run.id, gate('redesign'));
  await h.orch.idle();
  h.orch.resolveGate(run.id, gate('recheck'));
  await h.orch.idle();
  assert.equal(run.adjudications!.length, 2);
  const record = run.adjudications![1]!;
  const prompt = h.store.readTaskFile(run.id, record.taskId!, 'prompt.md')!;
  assert.equal(prompt.includes('OLD_ROUND_EVIDENCE_SENTINEL'), false);
  assert.equal(run.recheckLog.filter(entry => entry.designRound === 2).length, 2);
});

test('D8：裁决过程中改答问题，完成报告仍标记过期；取消整轮不会应用迟到结果', async () => {
  for (const cancel of [false, true]) {
    const h = makeHarness();
    const adapter = new MockAdapter({ delayMs: 0 });
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({ kind: 'mock', run: async (spec, progress, signal) => {
      if (spec.phase === 'adjudicate') { reached(); await pending; }
      return adapter.run(spec, progress, signal);
    } }) });
    const run = await framework(h);
    h.orch.resolveGate(run.id, gate('recheck'));
    await started;
    if (cancel) h.orch.cancelRun(run.id);
    else {
      const q = run.questions[0]!;
      h.orch.answerQuestion(run.id, q.id, { status: 'answered', optionIds: [q.options[0]!.id], otherText: null, note: null });
    }
    release();
    await h.orch.idle();
    if (cancel) {
      assert.equal(run.terminal, 'cancelled');
      assert.equal(run.adjudications![0]!.report, null);
    } else {
      assert.equal(run.phase, 'framework_gate');
      assert.ok(run.adjudications![0]!.report);
      assert.ok(run.adjudications![0]!.staleReason);
    }
  }
});

test('D8：型号不符输出须明确接受且只能接受当前最新尝试', async () => {
  const h = makeHarness();
  const adapter = new MockAdapter({ delayMs: 0 });
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({ kind: 'mock', run: async (spec, progress, signal) => {
    const result = await adapter.run(spec, progress, signal);
    if (spec.phase === 'adjudicate') { result.meta.reportedModelSource = 'server_usage'; result.meta.reportedModels = ['different-model']; }
    return result;
  } }) });
  const run = await adjudicate(h);
  const task = run.tasks.at(-1)!;
  assert.equal(task.failure!.kind, 'model_mismatch');
  assert.equal(run.adjudications![0]!.report, null);
  h.orch.acceptMismatch(run.id, task.id);
  assert.equal(run.phase, 'framework_gate');
  assert.equal(task.acceptedDespiteMismatch, true);
  assert.ok(run.adjudications![0]!.report);
  assert.throws(() => h.orch.acceptMismatch(run.id, task.id), /只能接受当前裁决/);
});

test('D8：非法输出只修复一次，仍失败不能发布建议', async () => {
  const h = makeHarness({ inject: { 'astra.adjudicate.1': 'invalid_json' } });
  const run = await adjudicate(h);
  const task = run.tasks.at(-1)!;
  assert.equal(task.phase, 'adjudicate');
  assert.equal(task.repairAttempted, true);
  assert.equal(task.outputValidity, 'invalid');
  assert.equal(run.phaseStatus, 'blocked');
  assert.equal(run.adjudications!.at(-1)!.report, null);
  h.orch.retryTask(run.id, task.id);
  await h.orch.idle();
  assert.equal(run.phase, 'framework_gate');
});

test('D8：覆盖、回答、重做都会让已有建议过期，历史 Run 无字段仍可复核', async () => {
  const h = makeHarness();
  const run = await adjudicate(h);
  const record = run.adjudications![0]!;
  const item = record.items[0]!;
  h.orch.setOverride(run.id, { kind: 'score', candidateId: item.candidateId, criterionId: item.criterionId, constraintId: null, value: 4, reason: '用户提供了新证据' });
  assert.ok(record.staleReason);
  assert.ok(renderDecisionRecord(run).includes('已过期'));
  h.orch.resolveGate(run.id, gate('redesign'));
  await h.orch.idle();
  assert.equal(run.designRound, 2);
  assert.equal(run.adjudications![0], record);
  assert.equal(run.gates.at(-1)!.context.adjudicationTaskId, null);
  // 模拟旧记录：不从旧复核日志捏造裁决。
  delete run.adjudications;
  h.store.save(run);
  assert.ok(!renderDecisionRecord(run).includes('## Astra Ultra 裁决建议'));
  h.orch.resolveGate(run.id, gate('recheck'));
  await h.orch.idle();
  assert.equal(run.adjudications!.length, 1);
  const question = run.questions[0]!;
  h.orch.answerQuestion(run.id, question.id, { status: 'answered', optionIds: [question.options[0]!.id], otherText: null, note: null });
  assert.ok(run.adjudications![0]!.staleReason);
});

test('D8：取消和重启恢复不自动再调用，显式重试才继续', async () => {
  const h = makeHarness();
  const base = new MockAdapter({ delayMs: 0 });
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  let hang = true;
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({ kind: 'mock',
    run: async (spec, progress, signal) => {
      if (spec.phase === 'adjudicate' && hang) {
        started();
        return new MockAdapter({ delayMs: 0, inject: { 'astra.adjudicate.1': 'hang' } }).run(spec, progress, signal);
      }
      return base.run(spec, progress, signal);
    },
  }) });
  const run = await framework(h);
  h.orch.resolveGate(run.id, gate('recheck'));
  await reached;
  const task = run.tasks.at(-1)!;
  assert.equal(run.phase, 'adjudicate');
  const recoveredStore = new RunStore(h.config.dataDir);
  const recovered = new Orchestrator({ config: h.config, store: recoveredStore, bus: new EventBus(recoveredStore), adapterFor: () => base });
  recovered.recover();
  const restored = recovered.getRun(run.id);
  assert.equal(restored.tasks.at(-1)!.status, 'interrupted');
  assert.equal(restored.phaseStatus, 'blocked');
  await recovered.idle();
  assert.equal(restored.tasks.length, run.tasks.length);
  h.orch.cancelTask(run.id, task.id);
  await h.orch.idle();
  assert.equal(task.status, 'cancelled');
  assert.equal(run.phaseStatus, 'blocked');
  hang = false;
  recovered.retryTask(run.id, task.id);
  await recovered.idle();
  assert.equal(restored.phase, 'framework_gate');
  assert.equal(restored.tasks.at(-1)!.meta!.requestedEffort, 'ultra');
});

test('D8：语义校验拒绝漏项、重复、未知候选、错误快照和无依据裁决', () => {
  const value: AdjudicationOutput = { snapshotRef: 'v2-test', recommendation: { candidateId: 'C1', rationale: '建议先验证' },
    items: [{ itemId: 'U1', verdict: 'resolved', rationale: '对照理由', evidence: [{ kind: 'reasoning', ref: 'U1', summary: '可核对依据' }], verification: null }], risks: [], questions: [] };
  const ctx = { snapshotRef: value.snapshotRef, adjudicationItemIds: ['U1'], eligibleCandidateIds: ['C1'] };
  assert.equal(validateOutput('adjudicate', value, ctx).ok, true);
  for (const patch of [
    { snapshotRef: 'wrong' }, { items: [] }, { items: [value.items[0], value.items[0]] },
    { recommendation: { candidateId: 'eliminated', rationale: '假推荐' } },
    { items: [{ ...value.items[0], evidence: [] }] },
    { items: [{ ...value.items[0], verdict: 'unresolved' }] },
  ]) assert.equal(validateOutput('adjudicate', { ...value, ...patch }, ctx).ok, false);
  assert.equal(validateOutput('adjudicate', { ...value, recommendation: { candidateId: null, rationale: '待补证' } }, ctx).ok, true);
});

test('D8：成功落盘与阶段交接间重启，已完成裁决安全回 G2，复核后裁决等手动继续', async () => {
  for (const phase of ['recheck', 'adjudicate'] as const) {
    const h = makeHarness();
    const run = await adjudicate(h);
    run.phase = phase;
    run.phaseStatus = 'running';
    // 还原崩溃窗口：已保存任务输出，尚未保存下一个阶段或打开 G2。
    run.gates = run.gates.filter(gate => gate.resolvedAt !== null);
    if (phase === 'recheck') {
      run.tasks = run.tasks.filter(task => task.phase !== 'adjudicate');
      run.adjudications = [];
    }
    h.store.save(run);
    let calls = 0;
    const mock = new MockAdapter({ delayMs: 0 });
    const store = new RunStore(h.config.dataDir);
    const recovered = new Orchestrator({ config: h.config, store, bus: new EventBus(store), adapterFor: () => ({ kind: 'mock', run: async (...args) => { calls++; return mock.run(...args); } }) });
    recovered.recover();
    await recovered.idle();
    assert.equal(calls, 0);
    const restored = recovered.getRun(run.id);
    if (phase === 'recheck') {
      assert.equal(restored.phaseStatus, 'blocked');
      recovered.resolveBlocked(run.id, 'retry_failed');
      await recovered.idle();
      assert.equal(calls, 1);
    }
    assert.equal(restored.phase, 'framework_gate');
    assert.equal(restored.phaseStatus, 'waiting_user');
  }
});

test('D8：实际任务传给 Codex 参数为完整型号、Ultra、只读且不执行提示词', async () => {
  const h = makeHarness();
  const adapter = new MockAdapter({ delayMs: 0 });
  let captured: ModelTaskSpec | undefined;
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({ kind: 'mock', run: async (spec, progress, signal) => {
    if (spec.phase === 'adjudicate') captured = spec;
    return adapter.run(spec, progress, signal);
  } }) });
  await adjudicate(h);
  assert.ok(captured);
  assert.equal(captured.sandbox, 'read_only');
  assert.equal(captured.allowNetwork, false);
  const args = buildCodexArgs(captured, DEFAULT_CODEX_OPTIONS, 'schema.json', 'out.txt');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6.2-astra');
  assert.ok(args.includes('model_reasoning_effort=ultra'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(!args.includes(captured.prompt));
});

test('D8：HTTP G2 到裁决到导出保持令牌校验与人工确认', async () => {
  const h = makeHarness();
  const token = 'd'.repeat(64);
  const handler = createApp({ config: h.config, orchestrator: h.orch, bus: h.bus, token, staticDir: path.join(h.dir, 'none'), allowMockRuns: true });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  h.config.port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${h.config.port}`;
  try {
    const run = await framework(h);
    const body = JSON.stringify({ gate: 'G2_framework', action: 'recheck' });
    const denied = await fetch(`${url}/api/runs/${run.id}/gates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(denied.status, 403);
    const response = await fetch(`${url}/api/runs/${run.id}/gates`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-token': token }, body });
    assert.equal(response.status, 200);
    await h.orch.idle();
    const state = await (await fetch(`${url}/api/runs/${run.id}`)).json() as typeof run;
    assert.equal(state.phase, 'framework_gate');
    assert.ok(state.adjudications![0]!.report);
    assert.equal(state.jobs.length, 0);
    const exported = await (await fetch(`${url}/api/runs/${run.id}/export`)).text();
    assert.ok(exported.includes('Astra Ultra 裁决建议'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('T4：关闭时取消排队任务，不释放后再启动模型；清除超时定时器', async () => {
  const h = makeHarness({ delayMs: 500 }, config => { config.limits.maxConcurrentModelTasks = 1; });
  const run = h.orch.createRun(runInput('preference'));
  // 让第一个任务拿到槽位，另一个继续排队。
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(run.tasks.filter(task => task.status === 'running').length, 1);
  await h.orch.shutdown();
  assert.equal(run.tasks.length, 2);
  assert.ok(run.tasks.every(task => task.status === 'cancelled'));
  assert.equal(run.tasks[1]!.startedAt, null);
  assert.equal(run.phaseStatus, 'blocked');
  assert.throws(() => h.orch.createRun(runInput('single')), /正在停止/);
  const store = new RunStore(h.config.dataDir);
  const restarted = new Orchestrator({ config: h.config, store, bus: new EventBus(store), adapterFor: () => new MockAdapter({ delayMs: 0 }) });
  restarted.recover();
  restarted.resolveBlocked(run.id, 'retry_failed');
  await restarted.idle();
  assert.equal(restarted.getRun(run.id).phase, 'answering');
});

test('T4：关闭落盘失败仍先中止模型，排队任务绝不启动', async () => {
  const h = makeHarness({}, config => { config.limits.maxConcurrentModelTasks = 1; });
  const adapter = new MockAdapter({ delayMs: 500 });
  let calls = 0;
  let aborted = false;
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  h.orch = new Orchestrator({ config: h.config, store: h.store, bus: h.bus, adapterFor: () => ({ kind: 'mock', run: async (spec, progress, signal) => {
    calls++;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    started();
    return adapter.run(spec, progress, signal);
  } }) });
  h.orch.createRun(runInput('preference'));
  await reached;
  h.store.save = () => { throw new Error('模拟磁盘写入失败'); };
  await assert.rejects(h.orch.shutdown(), /模拟磁盘写入失败/);
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  await h.orch.idle();
});
