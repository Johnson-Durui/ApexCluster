import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateRunInputZ, GateInputZ } from '../src/core/schemas.js';
import type { Run } from '../src/core/types.js';
import { RunStore } from '../src/orchestrator/store.js';
import { makeHarness, runInput } from './helpers.js';

type Harness = ReturnType<typeof makeHarness>;

async function settledRun(h: Harness, patch: Parameters<typeof runInput>[1]): Promise<Run> {
  const created = h.orch.createRun(runInput('preference', patch));
  await h.orch.idle();
  return h.orch.getRun(created.id);
}

async function submitG1(h: Harness, run: Run): Promise<Run> {
  h.orch.resolveGate(run.id, { gate: 'G1_answers', action: 'submit' });
  await h.orch.idle();
  return h.orch.getRun(run.id);
}

function g2(h: Harness, run: Run, action: 'escalate_dual' | 'redesign', architectOverride?: { from: 'claude'; to: 'astra'; reason: string }): void {
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action, architectOverride }));
}

test('single 只派发 Claude 提案和 Astra 评审，正常单架构师模式不标 degraded', async () => {
  const h = makeHarness();
  const run = await settledRun(h, { clarifyWith: 'skip', designMode: 'single', riskLevel: 'low' });

  assert.equal(run.phase, 'framework_gate');
  assert.deepEqual(run.designResolution, {
    mode: 'single',
    reasons: ['用户显式选择 single'],
    architects: ['claude'],
    reviewers: ['astra'],
  });
  assert.deepEqual(run.tasks.filter((task) => task.phase === 'propose').map((task) => task.role), ['claude']);
  assert.deepEqual(run.tasks.filter((task) => task.phase === 'review').map((task) => task.role), ['astra']);
  assert.deepEqual(run.degraded, []);
});

test('省略协作字段时由 Claude 统一澄清并主导架构，Astra 只评审同一方案', async () => {
  const h = makeHarness();
  const { clarifyWith: _clarifyWith, designMode: _designMode, ...withoutCollaborationDefaults } = runInput('preference');
  const input = CreateRunInputZ.parse(withoutCollaborationDefaults);
  assert.equal(input.clarifyWith, 'claude');
  assert.equal(input.designMode, 'single');

  let run = h.orch.createRun(input);
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  assert.equal(run.phase, 'answering');
  assert.deepEqual(run.tasks.filter((task) => task.phase === 'clarify').map((task) => task.role), ['claude']);
  assert.equal(run.questions.some((question) => question.askedBy === 'astra'), false);

  run = await submitG1(h, run);
  assert.equal(run.phase, 'framework_gate');
  assert.deepEqual(run.tasks.filter((task) => task.phase === 'propose').map((task) => task.role), ['claude']);
  assert.deepEqual(run.tasks.filter((task) => task.phase === 'review').map((task) => task.role), ['astra']);
});

test('显式 both 与 dual 保留双边澄清、双提案和双评审兼容流程', async () => {
  const h = makeHarness();
  let run = h.orch.createRun(runInput('preference', { clarifyWith: 'both', designMode: 'dual' }));
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  assert.deepEqual(new Set(run.tasks.filter((task) => task.phase === 'clarify').map((task) => task.role)), new Set(['claude', 'astra']));

  run = await submitG1(h, run);
  assert.deepEqual(new Set(run.tasks.filter((task) => task.phase === 'propose').map((task) => task.role)), new Set(['claude', 'astra']));
  assert.deepEqual(new Set(run.tasks.filter((task) => task.phase === 'review').map((task) => task.role)), new Set(['claude', 'astra']));
});

test('auto 在跳过澄清时仍按硬约束和风险解析，并在 G1 后按三道未明确回答的阻塞题解析', async () => {
  const constraints = [
    { text: '约束一', kind: 'must' as const },
    { text: '约束二', kind: 'must' as const },
    { text: '约束三', kind: 'must' as const },
    { text: '约束四', kind: 'must_not' as const },
  ];
  const byConstraint = await settledRun(makeHarness(), { clarifyWith: 'skip', designMode: 'auto', riskLevel: 'low', constraints });
  assert.equal(byConstraint.designResolution?.mode, 'dual');
  assert.ok(byConstraint.designResolution?.reasons.some((reason) => reason.includes('硬约束 4 条')));

  const byRisk = await settledRun(makeHarness(), { clarifyWith: 'skip', designMode: 'auto', riskLevel: 'high' });
  assert.equal(byRisk.designResolution?.mode, 'dual');
  assert.ok(byRisk.designResolution?.reasons.includes('风险等级为 high'));

  const h = makeHarness();
  let byQuestions = await settledRun(h, { designMode: 'auto', riskLevel: 'low' });
  assert.equal(byQuestions.phase, 'answering');
  const third = byQuestions.questions.find((question) => question.priority === 'important');
  assert.ok(third);
  third.priority = 'blocking';
  h.store.save(byQuestions);
  byQuestions = await submitG1(h, byQuestions);
  assert.equal(byQuestions.designResolution?.mode, 'dual');
  assert.ok(byQuestions.designResolution?.reasons.some((reason) => reason.includes('阻塞级未答问题 3 条')));
  assert.equal(byQuestions.questions.filter((question) => question.priority === 'blocking').every((question) => question.status === 'skipped'), true);
});

test('single 的 Claude 提案失败会阻塞，不自动创建 Astra 提案或 degraded 标记', async () => {
  const h = makeHarness({ inject: { 'claude.propose.1': 'process_error' } });
  const run = await settledRun(h, { clarifyWith: 'skip', designMode: 'single', riskLevel: 'low' });

  assert.equal(run.phase, 'propose');
  assert.equal(run.phaseStatus, 'blocked');
  assert.deepEqual(run.tasks.filter((task) => task.phase === 'propose').map((task) => task.role), ['claude']);
  assert.equal(run.tasks.some((task) => task.phase === 'propose' && task.role === 'astra'), false);
  assert.equal(run.proposals.some((proposal) => proposal.author === 'astra'), false);
  assert.deepEqual(run.degraded, []);
});

test('G2 escalate_dual 新建设计轮，保留旧提案、回答和归档决定', async () => {
  const h = makeHarness();
  let run = await settledRun(h, { designMode: 'single', riskLevel: 'low' });
  run = await submitG1(h, run);
  const oldProposalIds = run.proposals.map((proposal) => proposal.id);
  const oldQuestions = structuredClone(run.questions);
  const oldDecision = structuredClone(run.decision);

  g2(h, run, 'escalate_dual');
  await h.orch.idle();
  run = h.orch.getRun(run.id);

  assert.equal(run.designRound, 2);
  assert.equal(run.designMode, 'dual');
  assert.equal(run.designResolution?.mode, 'dual');
  assert.deepEqual(run.proposals.filter((proposal) => proposal.designRound === 1).map((proposal) => proposal.id), oldProposalIds);
  assert.deepEqual(run.questions.slice(0, oldQuestions.length), oldQuestions);
  assert.deepEqual(run.archivedRounds[0]?.decision, oldDecision);
  assert.ok(run.proposals.some((proposal) => proposal.designRound === 2 && proposal.author === 'claude'));
  assert.ok(run.proposals.some((proposal) => proposal.designRound === 2 && proposal.author === 'astra'));
  assert.notDeepEqual(run.decision, oldDecision);
});

test('Claude 单架构师阻塞时仅带理由的明确操作可改由 Astra 新轮提案', async () => {
  const h = makeHarness({ inject: { 'claude.propose.1': 'process_error' } });
  const run = await settledRun(h, { clarifyWith: 'skip', designMode: 'single' });
  assert.throws(() => h.orch.resolveBlocked(run.id, 'architect_override'), /理由/);
  assert.equal(run.designRound, 1);
  h.orch.resolveBlocked(run.id, 'architect_override', '本次明确由 Astra 独立提出方案');
  await h.orch.idle();
  assert.equal(run.designRound, 2);
  assert.equal(run.phase, 'framework_gate');
  assert.equal(run.designResolution?.architectOverride?.proposalIsNonLeading, true);
  assert.equal(run.archivedRounds.length, 1);
  assert.deepEqual(run.tasks.filter(task => task.phase === 'propose').map(task => task.role), ['claude', 'astra']);
  assert.equal(run.tasks[0]?.status, 'failed');
  assert.deepEqual(run.degraded, []);
});

test('显式 architectOverride 新轮记录非主导 Astra 方案且不作为失败 fallback', async () => {
  const h = makeHarness();
  let run = await settledRun(h, { clarifyWith: 'skip', designMode: 'single', riskLevel: 'low' });

  g2(h, run, 'redesign', { from: 'claude', to: 'astra', reason: '用户明确要求本轮由 Astra 提案' });
  await h.orch.idle();
  run = h.orch.getRun(run.id);

  assert.equal(run.designRound, 2);
  assert.equal(run.designResolution?.architectOverride?.proposalIsNonLeading, true);
  assert.equal(run.designResolution?.architectOverride?.reason, '用户明确要求本轮由 Astra 提案');
  assert.deepEqual(run.designResolution?.architects, ['astra']);
  assert.deepEqual(run.designResolution?.reviewers, ['claude']);
  assert.deepEqual(run.tasks.filter((task) => task.scope === 'r2-propose').map((task) => task.role), ['astra']);
  assert.deepEqual(run.tasks.filter((task) => task.scope === 'r2-review').map((task) => task.role), ['claude']);
  assert.equal(run.degraded.length, 0);
  assert.equal(run.designResolutionHistory?.at(-1)?.resolution.architectOverride?.proposalIsNonLeading, true);
});

test('逐文档撰写者在创建时按种类冻结，之后配置变化不改变手册、开发文档和 PRD 任务', async () => {
  const h = makeHarness();
  let run = await settledRun(h, {
    clarifyWith: 'skip',
    designMode: 'single',
    riskLevel: 'low',
    writeDocs: true,
    writePrd: true,
    docWriters: {
      handbook: { role: 'claude', effort: 'xhigh' },
      devdoc: { role: 'astra', effort: 'max' },
      prd: { role: 'claude', effort: 'xhigh' },
    },
  });
  const frozen = structuredClone(run.docWriters);
  assert.deepEqual(frozen, {
    handbook: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    devdoc: { role: 'astra', model: 'gpt-6.2-astra', effort: 'max' },
    prd: { role: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
  });

  h.config.models.claude.model = 'changed-claude';
  h.config.models.astra.model = 'changed-astra';
  h.config.docWriter = { role: 'sol', effort: 'low' };

  const candidateId = run.decision!.winnerId!;
  const defaults = h.orch.frameworkGateDefaults(run.id).find((item) => item.candidateId === candidateId)!;
  h.orch.resolveGate(run.id, GateInputZ.parse({ gate: 'G2_framework', action: 'validate', candidateIds: [candidateId], specs: [defaults.spec] }));
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  assert.equal(run.phase, 'docs_gate');
  const handbook = run.tasks.find((task) => task.phase === 'handbook')!;
  const devdoc = run.tasks.find((task) => task.phase === 'devdoc')!;
  assert.deepEqual({ role: handbook.role, model: handbook.meta?.requestedModel, effort: handbook.meta?.requestedEffort }, { role: 'claude', model: frozen!.handbook.model, effort: 'xhigh' });
  assert.deepEqual({ role: devdoc.role, model: devdoc.meta?.requestedModel, effort: devdoc.meta?.requestedEffort }, { role: 'astra', model: frozen!.devdoc.model, effort: 'max' });

  h.orch.resolveGate(run.id, { gate: 'G3_docs', action: 'approve', reviewers: null, conclusion: '通过', handbookNotes: null, devdocNotes: null, reason: null });
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  const job = run.jobs[0]!;
  const manual = job.spec.acceptance.find((item) => item.kind === 'manual');
  if (manual) h.orch.setManualResult(run.id, job.id, manual.id, true, '集成测试人工通过');
  run = h.orch.getRun(run.id);
  h.orch.resolveGate(run.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: job.candidateId, jobId: null, manualResults: [], failureClassOverrides: {}, reason: null });
  await h.orch.idle();
  run = h.orch.getRun(run.id);
  assert.equal(run.phase, 'prd_gate');
  const prd = run.tasks.find((task) => task.phase === 'prd')!;
  assert.deepEqual({ role: prd.role, model: prd.meta?.requestedModel, effort: prd.meta?.requestedEffort }, { role: 'claude', model: frozen!.prd.model, effort: 'xhigh' });
  assert.deepEqual(run.docWriters, frozen);
});

test('旧运行缺少 designMode/docWriters 时保持双提案双评审及旧 docWriter 原值', async () => {
  const h = makeHarness();
  const run = await settledRun(h, { clarifyWith: 'skip', designMode: 'dual' });
  assert.deepEqual(new Set(run.tasks.filter((task) => task.phase === 'propose').map((task) => task.role)), new Set(['claude', 'astra']));
  assert.deepEqual(new Set(run.tasks.filter((task) => task.phase === 'review').map((task) => task.role)), new Set(['claude', 'astra']));

  run.docWriter = { role: 'sol', model: 'historical-sol-model', effort: 'high' };
  delete run.docWriters;
  delete run.designMode;
  delete run.riskLevel;
  delete run.designResolution;
  delete run.designResolutionHistory;
  h.store.save(run);

  const loaded = new RunStore(h.config.dataDir).load(run.id)!;
  assert.equal(loaded.designMode, undefined);
  assert.equal(loaded.designResolution, undefined);
  assert.equal(loaded.docWriters, undefined);
  assert.deepEqual(loaded.docWriter, { role: 'sol', model: 'historical-sol-model', effort: 'high' });
});
