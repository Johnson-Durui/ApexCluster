import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDecisionRecord } from '../src/core/report.js';
import type { Run } from '../src/core/types.js';
import { EventBus } from '../src/orchestrator/events.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { RunStore } from '../src/orchestrator/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { makeHarness, runInput } from './helpers.js';

type H = ReturnType<typeof makeHarness>;

async function toFramework(h: H, scenario: string): Promise<Run> {
  const run = h.orch.createRun(runInput(scenario));
  await h.orch.idle();
  let r = h.orch.getRun(run.id);
  assert.equal(r.phase, 'answering', `澄清后应停在 G1，实际 ${r.phase}/${r.phaseStatus} ${r.blockedReason ?? ''}`);
  h.orch.resolveGate(r.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  r = h.orch.getRun(run.id);
  return r;
}

async function validateWinner(h: H, r: Run, candidateId: string): Promise<Run> {
  const defaults = h.orch.frameworkGateDefaults(r.id).find((d) => d.candidateId === candidateId)!;
  h.orch.resolveGate(r.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await h.orch.idle();
  return h.orch.getRun(r.id);
}

test('preference：两个模型的问题都同步进来；接近时按偏好推荐 Claude 框架；确认后 Sol 构建；人工验收后完成', async () => {
  const h = makeHarness();
  const run = h.orch.createRun(runInput('preference'));
  await h.orch.idle();
  let r = h.orch.getRun(run.id);
  assert.equal(r.phase, 'answering');
  assert.equal(r.questions.filter((q) => q.askedBy === 'claude').length, 3);
  assert.equal(r.questions.filter((q) => q.askedBy === 'astra').length, 3);
  assert.ok(r.questions.every((q) => q.options.length >= 2 && q.defaultAssumption));
  // 事件流里有 question.added，页面可实时同步
  const evTypes = h.bus.replay(r.id, 0).map((e) => e.type);
  assert.equal(evTypes.filter((t) => t === 'question.added').length, 6);

  // 回答一题、其余跳过（采用默认）
  const q1 = r.questions[0]!;
  h.orch.answerQuestion(r.id, q1.id, { status: 'answered', optionIds: [q1.options[0]!.id], otherText: null, note: null });
  h.orch.resolveGate(r.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  r = h.orch.getRun(run.id);
  assert.equal(r.snapshots.length, 2);
  assert.equal(r.snapshots[1]!.facts.some((f) => f.source === `answer:${q1.id}`), true);
  assert.equal(r.snapshots[1]!.assumptions.length, 5);
  // 两边读的是同一版本需求
  const designTasks = r.tasks.filter((t) => t.phase === 'propose' || t.phase === 'review');
  assert.ok(designTasks.every((t) => t.inputRef === r.snapshots[1]!.ref));

  assert.equal(r.phase, 'framework_gate');
  assert.equal(r.criteriaLockedAt !== null, true);
  const d = r.decision!;
  assert.equal(d.outcome, 'recommend');
  assert.equal(d.basis, 'preference');
  const winner = r.candidates.find((c) => c.id === d.winnerId)!;
  assert.equal(winner.origin, 'claude');

  // 验证之前不能有任何 Sol 任务（必须先确认框架）
  assert.equal(r.tasks.filter((t) => t.role === 'sol').length, 0);

  r = await validateWinner(h, r, winner.id);
  assert.equal(r.phase, 'final_gate');
  const job = r.jobs[0]!;
  assert.equal(job.effort, 'ultra'); // Node 方案有两个独立工作流
  assert.equal(job.status, 'awaiting_manual');
  assert.deepEqual(
    job.verification!.items.map((i) => i.status),
    ['verified_pass', 'verified_pass', 'awaiting_user'],
  );
  h.orch.setManualResult(r.id, job.id, 'AC3', true, '在浏览器里记了一笔，汇总正确');
  r = h.orch.getRun(run.id);
  assert.equal(r.jobs[0]!.status, 'passed');
  h.orch.resolveGate(r.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: winner.id, jobId: null, manualResults: [], failureClassOverrides: {}, reason: null });
  r = h.orch.getRun(run.id);
  assert.equal(r.terminal, 'done');
  assert.equal(r.finalChoice?.candidateId, winner.id);
  const md = renderDecisionRecord(r);
  assert.ok(md.includes('模拟数据'));
  assert.ok(md.includes('偏好'));
});

test('clear：Astra 方案明确领先（偏好不能覆盖）；Claude 的 Electron 方案被一致淘汰', async () => {
  const h = makeHarness();
  const r = await toFramework(h, 'clear');
  const d = r.decision!;
  assert.equal(r.candidates.length, 3);
  assert.equal(d.outcome, 'recommend');
  assert.equal(d.basis, 'clear');
  assert.equal(r.candidates.find((c) => c.id === d.winnerId)!.origin, 'astra');
  const eliminated = d.totals.filter((t) => t.status === 'eliminated');
  assert.equal(eliminated.length, 1);
  assert.deepEqual(eliminated[0]!.eliminatedBy, ['H2']);
  // 不能选择被淘汰的候选进入验证
  const defaults = h.orch.frameworkGateDefaults(r.id).find((x) => x.candidateId === eliminated[0]!.candidateId)!;
  assert.throws(
    () => h.orch.resolveGate(r.id, { gate: 'G2_framework', action: 'validate', candidateIds: [eliminated[0]!.candidateId], specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null }),
    /已被淘汰/,
  );
});

test('needs_verification：关键分歧 → 不推荐；复核一轮后 Astra 上调 → 按偏好推荐', async () => {
  const h = makeHarness();
  let r = await toFramework(h, 'needs_verification');
  assert.equal(r.decision!.outcome, 'needs_verification');
  const key = r.decision!.keyUncertainties.filter((u) => u.isKey);
  assert.equal(key.length, 1);
  assert.equal(key[0]!.criterionId, 'reliability');
  h.orch.resolveGate(r.id, { gate: 'G2_framework', action: 'recheck', candidateIds: [], specs: [], efforts: {}, recheckItemIds: [], reason: null });
  await h.orch.idle();
  r = h.orch.getRun(r.id);
  assert.equal(r.phase, 'framework_gate');
  assert.equal(r.recheckLog.length, 2);
  assert.equal(r.recheckLog.find((e) => e.judge === 'astra')!.after, 3);
  assert.equal(r.decision!.outcome, 'recommend');
  assert.equal(r.decision!.basis, 'preference');
});

test('single：两边提出同一架构 → 合并为 1 个候选，直接推荐（不凑数）', async () => {
  const h = makeHarness();
  const r = await toFramework(h, 'single');
  assert.equal(r.proposals.length, 2);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0]!.origin, 'both');
  assert.equal(r.decision!.outcome, 'single');
  assert.deepEqual(r.decision!.suggestedValidation.candidateIds, [r.candidates[0]!.id]);
});

test('none_viable：全部违反硬约束 → 无可行方案，可以停止并留下记录', async () => {
  const h = makeHarness();
  let r = await toFramework(h, 'none_viable');
  assert.equal(r.decision!.outcome, 'none_viable');
  h.orch.resolveGate(r.id, { gate: 'G2_framework', action: 'stop', candidateIds: [], specs: [], efforts: {}, recheckItemIds: [], reason: '约束需要重新考虑' });
  r = h.orch.getRun(r.id);
  assert.equal(r.terminal, 'done');
  assert.equal(r.finalChoice?.candidateId, null);
});

test('failures：单端失败 → 阻塞 → 重试；评审输出缺项 → 自动修复一次；MVP 首次测试失败 → 日志核验为失败 → 重试通过', async () => {
  const h = makeHarness();
  const run = h.orch.createRun(runInput('failures'));
  await h.orch.idle();
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  let r = h.orch.getRun(run.id);
  assert.equal(r.phase, 'propose');
  assert.equal(r.phaseStatus, 'blocked');
  assert.ok(r.blockedReason!.includes('Astra'));
  // Claude 的提案保留，没有因为 Astra 失败而丢弃
  assert.ok(r.proposals.some((p) => p.author === 'claude'));
  h.orch.resolveBlocked(r.id, 'retry_failed');
  await h.orch.idle();
  r = h.orch.getRun(run.id);
  assert.equal(r.phase, 'framework_gate');
  const claudeReview = r.tasks.filter((t) => t.phase === 'review' && t.role === 'claude').at(-1)!;
  assert.equal(claudeReview.outputValidity, 'repaired');
  assert.equal(claudeReview.repairAttempted, true);
  assert.equal(r.decision!.outcome, 'recommend');

  r = await validateWinner(h, r, r.decision!.winnerId!);
  assert.equal(r.phase, 'final_gate');
  let job = r.jobs[0]!;
  assert.equal(job.status, 'failed');
  assert.equal(job.failureClass, 'implementation_defect');
  assert.equal(job.verification!.items[0]!.status, 'verified_fail');
  // Sol 不能直接“接受”失败的 MVP（除非写理由）
  assert.throws(() => h.orch.resolveGate(r.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: job.candidateId, jobId: null, manualResults: [], failureClassOverrides: {}, reason: null }), /理由/);
  h.orch.resolveGate(r.id, { gate: 'G4_final', action: 'retry_job', chosenCandidateId: null, jobId: job.id, manualResults: [], failureClassOverrides: {}, reason: null });
  await h.orch.idle();
  r = h.orch.getRun(run.id);
  job = r.jobs[0]!;
  assert.equal(r.phase, 'final_gate');
  assert.equal(job.taskIds.length, 2);
  assert.notEqual(job.status, 'failed');
});

test('单端失败后选择“只用成功的一方继续” → 标记为不完整', async () => {
  const h = makeHarness({ inject: { 'astra.propose.1': 'process_error' } });
  const run = h.orch.createRun(runInput('preference'));
  await h.orch.idle();
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  let r = h.orch.getRun(run.id);
  assert.equal(r.phaseStatus, 'blocked');
  h.orch.resolveBlocked(r.id, 'continue_single');
  await h.orch.idle();
  r = h.orch.getRun(run.id);
  assert.equal(r.phase, 'framework_gate');
  assert.equal(r.degraded.length, 1);
  assert.equal(r.degraded[0]!.role, 'astra');
  assert.ok(r.proposals.every((p) => p.author === 'claude'));
  assert.ok(renderDecisionRecord(r).includes('不完整'));
});

test('评审只剩一位 → 决策标记 degraded，且不能做交叉复核', async () => {
  const h = makeHarness({ inject: { 'astra.review.1': 'rate_limited' } });
  const run = h.orch.createRun(runInput('needs_verification'));
  await h.orch.idle();
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  let r = h.orch.getRun(run.id);
  assert.equal(r.phaseStatus, 'blocked');
  h.orch.resolveBlocked(r.id, 'continue_single');
  await h.orch.idle();
  r = h.orch.getRun(run.id);
  assert.equal(r.decision!.degraded, true);
  assert.throws(() => h.orch.resolveGate(r.id, { gate: 'G2_framework', action: 'recheck', candidateIds: [], specs: [], efforts: {}, recheckItemIds: [], reason: null }), /只有一位评审/);
});

test('输出始终不合法 → 修复一次后标记“输出结构不合法”（与“模型完成生成”区分）', async () => {
  const h = makeHarness({ inject: { 'claude.clarify.1': 'invalid_json' } });
  const run = h.orch.createRun(runInput('preference'));
  await h.orch.idle();
  const r = h.orch.getRun(run.id);
  const t = r.tasks.find((x) => x.role === 'claude' && x.phase === 'clarify')!;
  // 注入对首次调用和修复调用都生效 → 修复一次后仍不合法
  assert.equal(t.repairAttempted, true);
  assert.equal(t.outputValidity, 'invalid');
  assert.equal(t.status, 'failed');
  assert.equal(t.failure?.kind, 'invalid_output');
  // Astra 的问题仍然保留并展示；运行进入阻塞，等你选择重试或单模型继续
  assert.equal(r.questions.filter((q) => q.askedBy === 'astra').length, 3);
  assert.equal(r.phaseStatus, 'blocked');
});

test('框架确认后改答问题 → 依赖默认假设的候选被标记，可以重新设计（新一轮、新快照）', async () => {
  const h = makeHarness();
  let r = await toFramework(h, 'preference');
  const q1 = r.questions.find((q) => q.id === 'Q1')!;
  const other = q1.options.find((o) => !q1.defaultOptionIds.includes(o.id))!;
  h.orch.answerQuestion(r.id, 'Q1', { status: 'answered', optionIds: [other.id], otherText: null, note: null });
  r = h.orch.getRun(r.id);
  assert.ok(r.candidates.every((c) => c.invalidatedAssumptions.includes('Q1')));
  assert.equal(r.decision!.outcome, 'needs_verification');
  h.orch.resolveGate(r.id, { gate: 'G2_framework', action: 'redesign', candidateIds: [], specs: [], efforts: {}, recheckItemIds: [], reason: null });
  await h.orch.idle();
  r = h.orch.getRun(r.id);
  assert.equal(r.designRound, 2);
  assert.equal(r.archivedRounds.length, 1);
  assert.equal(r.phase, 'framework_gate');
  assert.equal(r.snapshots.length, 3);
  assert.ok(r.candidates.every((c) => c.invalidatedAssumptions.length === 0));
});

test('取消运行：进行中的任务被取消，运行结束', async () => {
  const h = makeHarness({ delayMs: 2000 });
  const run = h.orch.createRun(runInput('preference'));
  await new Promise((r) => setTimeout(r, 50));
  h.orch.cancelRun(run.id);
  await h.orch.idle();
  const r = h.orch.getRun(run.id);
  assert.equal(r.terminal, 'cancelled');
  assert.ok(r.tasks.every((t) => t.status === 'cancelled'));
});

test('重启恢复：进行中的任务标记为中断，绝不自动重跑；运行进入阻塞等待你决定', async () => {
  const h = makeHarness({ delayMs: 5000 });
  const run = h.orch.createRun(runInput('preference'));
  await new Promise((r) => setTimeout(r, 30));
  // 模拟进程崩溃：不等任务结束，直接用新实例读盘
  const store2 = new RunStore(h.config.dataDir);
  const orch2 = new Orchestrator({ config: h.config, store: store2, bus: new EventBus(store2), adapterFor: () => new MockAdapter({ delayMs: 0 }) });
  orch2.recover();
  const r = orch2.getRun(run.id);
  assert.ok(r.tasks.every((t) => t.status === 'interrupted'));
  assert.equal(r.phaseStatus, 'blocked');
  await orch2.idle();
  assert.equal(orch2.getRun(run.id).tasks.length, 2); // 没有新的调用
  h.orch.cancelRun(run.id);
  await h.orch.idle();
});
