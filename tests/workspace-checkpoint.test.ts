import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MockAdapter } from '../src/adapters/mock.js';
import type { ModelAdapter } from '../src/adapters/types.js';
import type { Run } from '../src/core/types.js';
import { EventBus } from '../src/orchestrator/events.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { verifyWorkspaceAnchorSync } from '../src/orchestrator/review-workspace.js';
import { verifyAcceptance } from '../src/core/verify-mvp.js';
import { RunStore } from '../src/orchestrator/store.js';
import { makeHarness, runInput } from './helpers.js';

async function interruptedBuild(options: { unconfirmed?: boolean; context?: boolean; readonlyFailure?: boolean } = {}) {
  const h = makeHarness({}, config => {
    config.evaluator.enabled = false;
    config.finalReview.enabled = false;
    config.contextBudget.enabled = options.context ?? false;
    config.chores = { digest: false, qgroup: false };
  });
  const mock = new MockAdapter({ delayMs: 0 });
  let writableSessions = 0;
  const adapter: ModelAdapter = { kind: 'mock', async run(spec, progress, signal) {
    const result = await mock.run(spec, progress, signal);
    if (spec.phase !== 'build') return result;
    if (spec.context.buildKind === 'init') return result;
    if (options.context) {
      if (!spec.context.finalVerification) writableSessions += 1;
      if (options.readonlyFailure ? !spec.context.finalVerification : writableSessions < 2) return result;
    }
    mkdirSync(path.join(spec.cwd, 'src'), { recursive: true });
    writeFileSync(path.join(spec.cwd, 'src', 'retained.py'), 'print("generated before timeout")\n');
    result.status = 'timed_out';
    result.failure = { kind: 'timeout', message: '超过测试时间盒' };
    result.rawText = '';
    result.structured = null;
    result.toolLog = [];
    if (options.unconfirmed) result.meta.terminationWarning = '测试进程树退出尚未确认';
    return result;
  } };
  const store = new RunStore(h.config.dataDir);
  const orch = new Orchestrator({ config: h.config, store, bus: new EventBus(store), adapterFor: () => adapter });
  const created = orch.createRun(runInput('preference', { mode: 'real', clarifyWith: 'skip',
    build: { autoRework: false }, evaluator: { enabled: false }, finalReview: { enabled: false },
    contextBudget: { enabled: options.context ?? false }, chores: { digest: false, qgroup: false } }));
  await orch.idle();
  let run = orch.getRun(created.id);
  assert.equal(run.phase, 'framework_gate');
  const candidateId = options.context ? run.candidates.find(candidate => run.proposals
    .find(proposal => proposal.id === candidate.representativeProposalId)!.mvpPlan.workstreams.length > 1)!.id
    : run.decision!.winnerId ?? run.candidates[0]!.id;
  const defaults = orch.frameworkGateDefaults(run.id).find(item => item.candidateId === candidateId)!;
  orch.resolveGate(run.id, { gate: 'G2_framework', action: 'validate', candidateIds: [candidateId],
    specs: [defaults.spec], efforts: {}, recheckItemIds: [], reason: null });
  await orch.idle();
  run = orch.getRun(run.id);
  return { ...h, orch, store, run };
}

test('超时写者退出确认后保存生成代码，失败事实和 G4 人工关卡保持', async () => {
  const h = await interruptedBuild();
  const job = h.run.jobs[0]!;
  const round = job.rounds!.at(-1)!;
  assert.equal(h.run.phase, 'final_gate');
  assert.equal(h.run.tasks.find(task => task.id === round.buildTaskId)?.status, 'timed_out');
  assert.ok(round.workspaceCommit, '失败写者也必须保存当前代码检查点');
  assert.ok(round.fileTree.includes('src/retained.py'));
  assert.equal(verifyWorkspaceAnchorSync(job.workspaceDir, { commit: round.workspaceCommit!, treeHash: round.treeHash!,
    baselineCommit: round.baselineCommit, fileTree: round.fileTree, diffStat: round.diffStat }).ok, true);
  assert.equal(job.status, 'failed');
  assert.equal(job.verification, null);
  assert.equal(round.outcome, 'stopped');
  assert.equal(h.run.finalChoice, null);
  assert.equal(h.run.tasks.some(task => ['evaluate', 'final_review', 'prd'].includes(task.phase)), false);
  assert.equal(readFileSync(path.join(job.workspaceDir, 'src', 'retained.py'), 'utf8'), 'print("generated before timeout")\n');
});

test('进程退出未知时不冻结写入或清除写锁', async () => {
  const h = await interruptedBuild({ unconfirmed: true });
  const job = h.run.jobs[0]!;
  assert.equal(job.rounds!.at(-1)!.workspaceCommit, null);
  assert.equal(job.writeLock?.state, 'unconfirmed');
  assert.equal(readFileSync(path.join(job.workspaceDir, 'src', 'retained.py'), 'utf8'), 'print("generated before timeout")\n');
});

test('分步构建后续写者超时更新旧锚点，未跟踪源码被保留且不冒充整轮验收', async () => {
  const h = await interruptedBuild({ context: true });
  const job = h.run.jobs[0]!;
  const round = job.rounds!.at(-1)!;
  const sessions = round.context!.sessions;
  assert.equal(sessions.at(-1)!.outcome, 'stopped');
  assert.notEqual(sessions.at(-1)!.endCommit, sessions.at(-2)!.endCommit);
  assert.ok(round.fileTree.includes('src/retained.py'));
  assert.equal(sessions.at(-1)!.endCommit, round.workspaceCommit);
  assert.equal(round.verification, null);
  assert.equal(job.verification, null);
  assert.equal(h.run.phase, 'final_gate');
  assert.equal(h.run.finalChoice, null);
});

test('只读最终会话超时且发生源码写入时不把非法写入收编为新检查点', async () => {
  const h = await interruptedBuild({ context: true, readonlyFailure: true });
  const job = h.run.jobs[0]!;
  const round = job.rounds!.at(-1)!;
  const sessions = round.context!.sessions;
  assert.equal(sessions.at(-1)!.finalVerification, true);
  assert.equal(sessions.at(-1)!.endCommit, sessions.at(-2)!.endCommit);
  assert.equal(round.fileTree.includes('src/retained.py'), false);
  await assert.rejects(h.orch.checkpointJob(h.run.id, job.id, '不能收编只读会话写入'), /只读/);
  assert.equal(readFileSync(path.join(job.workspaceDir, 'src', 'retained.py'), 'utf8'), 'print("generated before timeout")\n');
});

test('显式保存旧轮次当前代码，历史和预算原样保留，仍须理由才能接受未验收候选', async () => {
  const h = await interruptedBuild();
  const job = h.run.jobs[0]!;
  const round = job.rounds!.at(-1)!;
  const previousCommit = round.workspaceCommit;
  const originalSource = readFileSync(path.join(job.workspaceDir, 'src', 'retained.py'), 'utf8');
  writeFileSync(path.join(job.workspaceDir, 'src', 'unfinished.py'), '# preserve generated source\n');
  round.staleReason = '旧版本超时后留下未提交源码';
  round.verification = verifyAcceptance(job.spec, [], null, [], new Date().toISOString());
  job.verification = structuredClone(round.verification);
  job.manualResults.push({ criterionId: 'ac3', pass: true, note: '旧提交人工结果', at: new Date().toISOString() });
  job.failureClass = 'implementation_defect';
  job.failureClassSource = 'sol';
  job.finalReviewTaskId = 'old-review';
  round.verifiedDefectIds = ['old-defect'];
  round.reworkBrief = [{ defectIds: ['old-defect'], instructions: 'old fix' }];
  job.digest = { taskId: null, status: 'pending', output: null, reason: null };
  h.store.save(h.run);
  const tasks = structuredClone(h.run.tasks);
  const budget = structuredClone(job.budget);
  const before = structuredClone(job);

  const recovered = await h.orch.checkpointJob(h.run.id, job.id, '保留当前代码，未完成硬件和整轮验收');
  assert.equal(recovered.phase, 'final_gate');
  assert.equal(recovered.phaseStatus, 'waiting_user');
  assert.equal(recovered.finalChoice, null);
  assert.deepEqual(recovered.tasks, tasks);
  assert.deepEqual(job.budget, budget);
  assert.equal(job.status, 'inconclusive');
  assert.equal(job.writeLock, null);
  assert.equal(round.staleReason, null);
  assert.notEqual(round.workspaceCommit, previousCommit);
  assert.equal(job.verification, null);
  assert.equal(round.verification, null);
  assert.equal(round.evaluation, null);
  assert.equal(job.finalReview, null);
  assert.equal(job.finalReviewTaskId, null);
  assert.equal(job.failureClass, null);
  assert.equal(job.failureClassSource, null);
  assert.deepEqual(job.manualResults, []);
  assert.deepEqual(round.verifiedDefectIds, []);
  assert.deepEqual(round.reworkBrief, []);
  assert.equal(job.digest?.status, 'skipped');
  const checkpoint = job.workspaceCheckpoints!.at(-1)!;
  assert.deepEqual(JSON.parse(readFileSync(checkpoint.auditPath, 'utf8')).job, before);
  assert.equal(readFileSync(path.join(job.workspaceDir, 'src', 'retained.py'), 'utf8'), originalSource);
  assert.equal(readFileSync(path.join(job.workspaceDir, 'src', 'unfinished.py'), 'utf8'), '# preserve generated source\n');
  const manual = job.spec.acceptance.find(item => item.kind === 'manual')!;
  h.store.writeTaskFile(h.run.id, round.buildTaskId, 'tool-log.json', JSON.stringify(job.spec.acceptance.filter(item => item.kind === 'command')
    .map((item, index) => ({ seq: index + 1, type: 'command_execution', command: item.command,
      status: 'completed', exitCode: 0, output: item.outputIncludes ?? 'passed', paths: [] }))));
  h.orch.setManualResult(h.run.id, job.id, manual.id, true, '新检查点人工备注');
  const refreshedJob = h.orch.getRun(h.run.id).jobs[0]!;
  assert.equal(refreshedJob.verification?.items.some(item => item.status === 'verified_pass'), false, '旧调用日志不得被绑定到新检查点');
  assert.equal(job.status, 'inconclusive');
  const accept = { gate: 'G4_final' as const, action: 'accept' as const, chosenCandidateId: job.candidateId,
    jobId: null, manualResults: [], failureClassOverrides: {}, reason: null as string | null };
  assert.throws(() => h.orch.resolveGate(h.run.id, accept), /没有通过验收.*理由/);
  const accepted = h.orch.resolveGate(h.run.id, { ...accept, reason: '仅接受当前代码成果，测试和硬件验收仍未完成' });
  assert.equal(accepted.terminal, 'done');
  assert.equal(accepted.jobs[0]!.status, 'inconclusive');
  assert.deepEqual(accepted.tasks, tasks, '保存和接受不应偷偷调用模型');
});

test('保存检查点期间并发 G4 动作被写锁阻止，成功后真正源码漂移仍拒绝', async () => {
  const h = await interruptedBuild();
  const job = h.run.jobs[0]!;
  const saving = h.orch.checkpointJob(h.run.id, job.id, '保存当前代码');
  await assert.rejects(h.orch.checkpointJob(h.run.id, job.id, '并发保存'), /活动作业|写锁/);
  assert.throws(() => h.orch.resolveGate(h.run.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: job.candidateId,
    jobId: null, manualResults: [], failureClassOverrides: {}, reason: '尝试并发接受' }), /作业.*运行|活动|完成|写锁|结束/);
  await saving;
  writeFileSync(path.join(job.workspaceDir, 'src', 'retained.py'), '# changed after checkpoint\n');
  assert.throws(() => h.orch.resolveGate(h.run.id, { gate: 'G4_final', action: 'accept', chosenCandidateId: job.candidateId,
    jobId: null, manualResults: [], failureClassOverrides: {}, reason: '不能绕过真实漂移' }), /代码或测试已变化/);
});

test('空理由、未知调用、旧批次、只读任务及工作区路径漂移均不可保存', async () => {
  const h = await interruptedBuild();
  const job = h.run.jobs[0]!;
  const task = h.run.tasks.find(item => item.id === job.rounds!.at(-1)!.buildTaskId)!;
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.workspaceDir, encoding: 'utf8' }).trim();
  const priorHead = head();
  await assert.rejects(h.orch.checkpointJob(h.run.id, job.id, '  '), /说明/);
  const state = job.budget!.calls[0]!.state;
  job.budget!.calls[0]!.state = 'unknown';
  await assert.rejects(h.orch.checkpointJob(h.run.id, job.id, '保存'), /未结算/);
  job.budget!.calls[0]!.state = state;
  const batch = job.batch;
  job.batch -= 1;
  await assert.rejects(h.orch.checkpointJob(h.run.id, job.id, '保存'), /本批/);
  job.batch = batch;
  task.buildKind = 'init';
  await assert.rejects(h.orch.checkpointJob(h.run.id, job.id, '保存'), /只读|退出未确认/);
  delete task.buildKind;
  const directory = job.workspaceDir;
  job.workspaceDir = path.dirname(directory);
  await assert.rejects(h.orch.checkpointJob(h.run.id, job.id, '保存'), /位置/);
  job.workspaceDir = directory;
  assert.equal(head(), priorHead);
  assert.equal(job.workspaceCheckpoints, undefined);
});
