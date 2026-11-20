import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelTaskSpec, TaskContext } from '../src/adapters/types.js';
import { DEFAULT_CONTEXT_BUDGET, type MilestonePlan } from '../src/core/context-budget.js';
import { createJobBudget } from '../src/core/job-budget.js';
import type { BuildRound, MvpSpec, Run, TaskRecord, ValidationJob, VerificationResult } from '../src/core/types.js';
import {
  appendBuildSession,
  applyContextOutput,
  completeBuildSession,
  contextInvocationTimeout,
  initializeRoundContext,
  nextBuildSession,
  prepareContextSpec,
  sessionSpec,
  validateContextOutput,
  type BuildSessionChoice,
} from '../src/orchestrator/build-context.js';
import { RunStore } from '../src/orchestrator/store.js';

const tempRoot = path.resolve('.test-tmp');

function harness(acceptanceCount = 2) {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, 'build-context-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export {};\n');
  const store = new RunStore(path.join(dir, 'data'));
  const acceptance = Array.from({ length: acceptanceCount }, (_, index) => ({
    id: `AC${index + 1}`, description: `验收 ${index + 1}`, kind: index === acceptanceCount - 1 ? 'manual' as const : 'command' as const,
    command: index === acceptanceCount - 1 ? null : `npm test -- ${index + 1}`, expectExitCode: index === acceptanceCount - 1 ? null : 0, outputIncludes: null,
  }));
  const spec: MvpSpec = {
    ref: 'spec-context', candidateId: 'C1', goal: 'context', scopeIn: ['x'], scopeOut: ['y'], acceptance,
    hypotheses: [], timeboxMinutes: 90, allowNetwork: false, comparisonQuestions: [],
  };
  const job = {
    id: 'j-C1-1', runId: 'r-context-1', batch: 1, candidateId: 'C1', proposalId: 'p1', effort: 'max', effortReason: 'test',
    workspaceDir: workspace, gitRepo: true, spec, status: 'running', taskIds: [], report: null, verification: null,
    manualResults: [], failureClass: null, failureClassSource: null, devGuideVersion: null,
    createdAt: '2026-10-23T00:00:00.000Z', endedAt: null, rounds: [], maxRounds: 3, autoRework: false,
    budget: createJobBudget({ maxRounds: 3, maxWriterSessions: 20, maxModelCalls: 20, maxActiveMinutes: 360 }),
  } as ValidationJob;
  const round = {
    round: 1, kind: 'initial', writer: 'sol', buildTaskId: '', evaluateTaskId: null, report: null, verification: null, evaluation: null,
    workspaceCommit: 'commit-0', treeHash: 'tree-0', baselineCommit: 'base-0', fileTree: [], diffStat: '', reviewWorkspace: null,
    reviewIntegrity: null, verifiedDefectIds: [], reworkBrief: [], outcome: 'pending', staleReason: null, stoppedReason: null,
    createdAt: '2026-10-23T00:00:00.000Z', endedAt: null,
  } as BuildRound;
  job.rounds = [round];
  const run = {
    id: 'r-context-1', mode: 'mock', mockScenario: null, models: {
      claude: { role: 'claude', adapter: 'mock', model: 'claude-opus-5-5', effort: 'max' },
      astra: { role: 'astra', adapter: 'mock', model: 'gpt-6-astra', effort: 'max' },
      sol: { role: 'sol', adapter: 'mock', model: 'gpt-6.1-sol', effort: 'max' },
    },
    contextBudget: { ...DEFAULT_CONTEXT_BUDGET, enabled: true, contextWindows: { ...DEFAULT_CONTEXT_BUDGET.contextWindows } },
    build: { autoRework: false, maxRounds: 3, maxWriterSessions: 20, maxModelCalls: 20, maxActiveMinutes: 360, resumePolicy: 'budgeted' },
    snapshots: [{ version: 1, ref: 'v1-x', hash: 'x', createdAt: 'x', reason: 'x', project: {}, constraints: [{ id: 'H1', kind: 'must', text: '原文约束' }], facts: [], assumptions: [], openItems: [] }],
    currentSnapshotVersion: 1, designSnapshotVersion: 1,
    proposals: [{
      id: 'p1', author: 'sol', taskId: 't0', snapshotVersion: 1, designRound: 1, localId: 'p', title: '框架', summary: '摘要', fitWhen: [], notFitWhen: [],
      stack: [], modules: [], flows: [], dataModel: 'data', deployment: 'local', tradeoffs: [], risks: [], assumptions: [], constraintChecks: [],
      mvpPlan: { goal: 'context', scopeIn: [], scopeOut: [], acceptance, hypotheses: [], workstreams: [{ id: 'W1', title: 'one', dependsOn: [] }], estimatedEffort: 'small' },
    }],
    jobs: [job], tasks: [],
  } as unknown as Run;
  return { dir, workspace, store, run, job, round, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function task(id: string, kind: 'init' | 'milestone', sessionId: string): TaskRecord {
  return {
    id, runId: 'r-context-1', role: 'sol', phase: 'build', scope: 'job:j-C1-1:r1', attempt: 1, rootTaskId: id,
    status: 'succeeded', outputValidity: 'valid', validationErrors: [], repairAttempted: false, failure: null,
    createdAt: '2026-10-23T00:00:00.000Z', startedAt: '2026-10-23T00:00:01.000Z', endedAt: '2026-10-23T00:01:00.000Z',
    lastProgress: null, lastProgressAt: null, meta: null, simulated: true, jobId: 'j-C1-1', acceptedDespiteMismatch: false,
    inputRef: 'spec-context', buildRound: 1, jobBatch: 1, buildKind: kind, buildSessionId: sessionId,
  };
}

function baseSpec(taskId: string): ModelTaskSpec {
  const context: TaskContext = {
    snapshotRef: 'v1-x', constraintIds: ['H1'], criterionIds: [], knownQuestionIds: [], anonymousMap: null,
    recheckItems: null, spec: null, mockScenario: null,
  };
  return {
    taskId, runId: 'r-context-1', role: 'sol', phase: 'build', attempt: 1, model: 'gpt-6.1-sol', effort: 'max', prompt: 'old',
    outputSchema: {}, cwd: '.', logDir: '.', timeoutMs: 60_000, sandbox: 'workspace_write', allowNetwork: false, gitRepo: true,
    allowWeb: false, resumeSessionId: null, context,
  };
}

function verification(statuses: Array<[string, VerificationResult['items'][number]['status']]>): VerificationResult {
  return {
    verdict: statuses.some(([, status]) => status === 'verified_fail') ? 'failed' : statuses.some(([, status]) => status === 'awaiting_user') ? 'awaiting_manual' : 'passed',
    items: statuses.map(([criterionId, status]) => ({ criterionId, status, matchedCommand: null, exitCode: null, outputExcerpt: null, note: '' })),
    selfReportMismatches: [], computedAt: '2026-10-23T00:01:00.000Z', specRef: 'spec-context', atCommit: 'commit-1',
  };
}

function multiPlan(): MilestonePlan {
  return {
    specRef: 'spec-context', notes: [], milestones: [
      { id: 'M1', title: 'first', acceptanceIds: ['AC1', 'AC2'], dependsOn: [], paths: ['src'], minutes: 20 },
      { id: 'M2', title: 'second', acceptanceIds: ['AC3', 'AC4'], dependsOn: ['M1'], paths: ['src'], minutes: 20 },
    ],
  };
}

test('小任务初始化时程序冻结 PLAN、哈希和状态，文件篡改后拒绝继续', () => {
  const h = harness();
  try {
    const context = initializeRoundContext(h.run, h.job, h.round, h.store, 1);
    assert.equal(context.plan?.milestones.length, 1);
    assert.equal(context.states[0]?.status, 'pending');
    assert.ok(context.planHash);
    assert.deepEqual(nextBuildSession(h.run, h.job, h.round), { kind: 'milestone', milestoneIds: ['M1'], finalVerification: false });
    writeFileSync(context.planPath, '{}\n');
    assert.throws(() => nextBuildSession(h.run, h.job, h.round), /篡改|不一致/);
  } finally { h.cleanup(); }
});

test('多工作流先派 init，合法输出冻结计划；非法覆盖和预算均被校验', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    assert.deepEqual(nextBuildSession(h.run, h.job, h.round), { kind: 'init', milestoneIds: [], finalVerification: false });
    const session = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const t = task('t-init', 'init', session.id);
    h.run.tasks.push(t);
    const bad = validateContextOutput(h.run, h.job, h.round, t, { ...multiPlan(), specRef: 'old' });
    assert.equal(bad?.ok, false);
    assert.match(bad!.errors.join('\n'), /specRef/);
    assert.equal(applyContextOutput(h.run, h.job, h.round, t, multiPlan(), h.store), true);
    assert.equal(h.round.context!.planHash, shaOf(readFileSync(h.round.context!.planPath, 'utf8')));
    assert.throws(() => applyContextOutput(h.run, h.job, h.round, t, { ...multiPlan(), notes: ['changed'] }, h.store), /覆盖/);
  } finally { h.cleanup(); }
});

function shaOf(value: string): string {
  return requireCrypto().createHash('sha256').update(value).digest('hex');
}

function requireCrypto(): typeof import('node:crypto') {
  // A function keeps this helper out of the production module while preserving an exact raw-file hash assertion.
  return globalThis.process.getBuiltinModule('node:crypto') as typeof import('node:crypto');
}

test('prepareContextSpec 生成只读 init、受控 HANDOFF，并在 unknown telemetry 下不续接', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const session = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const t = task('t-init', 'init', session.id);
    h.run.tasks.push(t);
    const spec = prepareContextSpec(h.run, h.job, h.round, session, { ...baseSpec(t.id), timeoutMs: 120 * 60_000 }, h.store);
    assert.equal(spec.sandbox, 'read_only');
    assert.equal(spec.allowNetwork, false);
    assert.equal(spec.timeoutMs, 35 * 60_000);
    assert.equal(spec.resumeSessionId, null);
    assert.match(spec.prompt, /只输出里程碑计划/);
    assert.ok(session.handoffPath?.includes('tasks'));
    assert.equal(session.context.contextWindow, null);
    assert.equal(session.material?.estimatedTokens, Math.ceil(spec.prompt.length / h.run.contextBudget!.charsPerToken));
  } finally { h.cleanup(); }
});

test('prepareContextSpec 保留受控 G3、预检、参考资料和显式终审返工意见', () => {
  const h = harness(4);
  try {
    writeFileSync(path.join(h.workspace, 'DEV_GUIDE.md'), '# G3\napproved-guide-token');
    writeFileSync(path.join(h.workspace, 'PREFLIGHT.md'), '# Preflight\npreflight-token');
    const snapshot = h.run.snapshots[0]!;
    snapshot.project.referenceDocuments = [{ name: 'user.md', content: 'reference-document-token' }];
    snapshot.project.referenceArchives = [{ id: 'a'.repeat(64), name: 'bundle.zip', size: 100, files: [], notes: [] }];
    h.round.finalReviewInstructions = { taskId: 'review-1', notes: ['manual-review-token'], requestedAt: '2026-10-23T00:00:00.000Z' };
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const session = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const current = task('t-init', 'init', session.id);
    h.run.tasks.push(current);
    const spec = prepareContextSpec(h.run, h.job, h.round, session, { ...baseSpec(current.id), referenceDirectory: path.join(h.workspace, '.workbench-references') }, h.store);
    assert.match(spec.prompt, /approved-guide-token/);
    assert.match(spec.prompt, /preflight-token/);
    assert.match(spec.prompt, /reference-document-token/);
    assert.match(spec.prompt, /bundle\.zip/);
    assert.match(spec.prompt, /manual-review-token/);
    assert.equal(session.material?.omitted.some(item => /DEV_GUIDE|PREFLIGHT|终审|参考/.test(item.id)), false);
  } finally { h.cleanup(); }
});

test('里程碑读取超长 PROGRESS 只留按需路径，最终整轮验收强制只读且不提供笔记', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const init = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    h.run.tasks.push(initTask);
    applyContextOutput(h.run, h.job, h.round, initTask, multiPlan(), h.store);
    writeFileSync(path.join(h.workspace, 'PROGRESS.md'), Array.from({ length: 201 }, (_, index) => `private-line-${index}`).join('\n'));
    const milestone = appendBuildSession(h.run, h.job, h.round, nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice, 't-m1');
    const milestoneTask = task('t-m1', 'milestone', milestone.id);
    h.run.tasks.push(milestoneTask);
    const writable = prepareContextSpec(h.run, h.job, h.round, milestone, baseSpec(milestoneTask.id), h.store);
    assert.equal(writable.sandbox, 'workspace_write');
    assert.match(writable.prompt, /超过建议上限/);
    assert.doesNotMatch(writable.prompt, /private-line-200/);

    h.round.context!.states.forEach(state => { state.status = 'passed'; });
    milestone.outcome = 'passed';
    const finalChoice = nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice;
    const final = appendBuildSession(h.run, h.job, h.round, finalChoice, 't-final');
    const finalTask = task('t-final', 'milestone', final.id);
    h.run.tasks.push(finalTask);
    const readonly = prepareContextSpec(h.run, h.job, h.round, final, baseSpec(finalTask.id), h.store);
    assert.equal(readonly.sandbox, 'read_only');
    assert.equal(readonly.allowNetwork, false);
    assert.match(readonly.prompt, /不得修改源码、测试、配置或 PROGRESS\.md/);
    assert.doesNotMatch(readonly.prompt, /private-line-0/);
  } finally { h.cleanup(); }
});

test('里程碑规格只含当前验收，模型 milestoneResults 仅可引用当前里程碑', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const init = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    h.run.tasks.push(initTask);
    applyContextOutput(h.run, h.job, h.round, initTask, multiPlan(), h.store);
    const choice = nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice;
    const session = appendBuildSession(h.run, h.job, h.round, choice, 't-m1');
    const t = task('t-m1', 'milestone', session.id);
    h.run.tasks.push(t);
    assert.deepEqual(sessionSpec(h.job, session).acceptance.map(item => item.id), ['AC1', 'AC2']);
    const raw = {
      specRef: 'spec-context', summary: 'done', builtComponents: [], howToRun: { setup: [], run: ['x'], test: [] },
      acceptanceResults: [
        { criterionId: 'AC1', status: 'pass', evidence: 'x', howToRun: 'x' },
        { criterionId: 'AC2', status: 'not_run', evidence: 'manual', howToRun: 'manual' },
      ],
      hypothesisResults: [], failureClass: 'none', failureDetail: null, deviations: [], openIssues: [], questions: [],
      milestoneResults: [{ milestoneId: 'M2', status: 'done', note: 'invented' }], handoffNotes: [],
    };
    const checked = validateContextOutput(h.run, h.job, h.round, t, raw)!;
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /非当前里程碑|缺少当前里程碑/);
  } finally { h.cleanup(); }
});

test('会话按依赖串行，人工待验可继续；最终整轮验收重新计算全部状态', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const init = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    h.run.tasks.push(initTask);
    applyContextOutput(h.run, h.job, h.round, initTask, multiPlan(), h.store);
    completeBuildSession(h.run, h.job, h.round, initTask);

    const first = appendBuildSession(h.run, h.job, h.round, nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice, 't-m1');
    const firstTask = task('t-m1', 'milestone', first.id);
    h.run.tasks.push(firstTask);
    h.job.verification = verification([['AC1', 'verified_pass'], ['AC2', 'awaiting_user']]);
    h.round.workspaceCommit = 'commit-1';
    completeBuildSession(h.run, h.job, h.round, firstTask);
    assert.equal(h.round.context!.states[0]!.status, 'awaiting_manual');
    assert.deepEqual((nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice).milestoneIds, ['M2']);

    const second = appendBuildSession(h.run, h.job, h.round, nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice, 't-m2');
    const secondTask = task('t-m2', 'milestone', second.id);
    h.run.tasks.push(secondTask);
    h.job.verification = verification([['AC3', 'verified_pass'], ['AC4', 'verified_pass']]);
    h.round.workspaceCommit = 'commit-2';
    completeBuildSession(h.run, h.job, h.round, secondTask);
    const finalChoice = nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice;
    assert.equal(finalChoice.finalVerification, true);
    const final = appendBuildSession(h.run, h.job, h.round, finalChoice, 't-final');
    const finalTask = task('t-final', 'milestone', final.id);
    h.run.tasks.push(finalTask);
    h.job.verification = verification([
      ['AC1', 'verified_fail'], ['AC2', 'awaiting_user'], ['AC3', 'verified_pass'], ['AC4', 'verified_pass'],
    ]);
    h.round.workspaceCommit = 'commit-3';
    completeBuildSession(h.run, h.job, h.round, finalTask);
    assert.equal(h.round.context!.states[0]!.status, 'failed');
    assert.equal(final.outcome, 'failed');
    assert.match((nextBuildSession(h.run, h.job, h.round) as { stopReason: string }).stopReason, /最终整轮验收未通过/);
  } finally { h.cleanup(); }
});

test('同一里程碑三次未完成、任务级故障和环境失败均停止', () => {
  const h = harness();
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 1);
    for (let index = 0; index < 3; index += 1) {
      const choice = nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice;
      const session = appendBuildSession(h.run, h.job, h.round, choice, `t-${index}`);
      const current = task(`t-${index}`, 'milestone', session.id);
      h.run.tasks.push(current);
      h.job.verification = verification([['AC1', 'not_observed'], ['AC2', 'not_observed']]);
      completeBuildSession(h.run, h.job, h.round, current);
    }
    assert.match((nextBuildSession(h.run, h.job, h.round) as { stopReason: string }).stopReason, /3 个会话|会话上限/);

    const fresh = harness();
    try {
      initializeRoundContext(fresh.run, fresh.job, fresh.round, fresh.store, 1);
      const session = appendBuildSession(fresh.run, fresh.job, fresh.round, nextBuildSession(fresh.run, fresh.job, fresh.round) as BuildSessionChoice, 't-fail');
      const failed = task('t-fail', 'milestone', session.id);
      failed.status = 'failed'; failed.failure = { kind: 'rate_limited', message: 'quota' };
      fresh.run.tasks.push(failed);
      completeBuildSession(fresh.run, fresh.job, fresh.round, failed);
      assert.match((nextBuildSession(fresh.run, fresh.job, fresh.round) as { stopReason: string }).stopReason, /任务级故障/);
    } finally { fresh.cleanup(); }

    const environment = harness();
    try {
      initializeRoundContext(environment.run, environment.job, environment.round, environment.store, 1);
      const session = appendBuildSession(environment.run, environment.job, environment.round, nextBuildSession(environment.run, environment.job, environment.round) as BuildSessionChoice, 't-env');
      const current = task('t-env', 'milestone', session.id);
      environment.run.tasks.push(current);
      environment.job.verification = verification([['AC1', 'verified_fail'], ['AC2', 'not_observed']]);
      environment.job.failureClass = 'environment_issue';
      completeBuildSession(environment.run, environment.job, environment.round, current);
      assert.match((nextBuildSession(environment.run, environment.job, environment.round) as { stopReason: string }).stopReason, /没有实现缺陷证据/);
    } finally { environment.cleanup(); }
  } finally { h.cleanup(); }
});

test('未知调用或作业总预算耗尽时不返回新会话选择', () => {
  const h = harness();
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 1);
    h.job.budget!.calls.push({
      id: 'unknown', taskId: 'lost', kind: 'initial', writer: true, state: 'unknown',
      startedAt: null, endedAt: null, activeMs: null,
    });
    assert.match((nextBuildSession(h.run, h.job, h.round) as { stopReason: string }).stopReason, /状态未知/);
    h.job.budget!.calls = [];
    h.job.budget!.usage.modelCalls = h.job.budget!.limits.maxModelCalls;
    assert.match((nextBuildSession(h.run, h.job, h.round) as { stopReason: string }).stopReason, /调用预算已耗尽/);
  } finally { h.cleanup(); }
});

test('同一轮共享规格主动时间盒，会话 timeout 取剩余、里程碑和基础超时最小值', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const init = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    h.run.tasks.push(initTask);
    applyContextOutput(h.run, h.job, h.round, initTask, multiPlan(), h.store);
    h.job.budget!.calls.push({
      id: 'spent-init', taskId: initTask.id, kind: 'initial', writer: false, state: 'settled',
      startedAt: '2026-10-23T00:00:00.000Z', endedAt: '2026-10-23T01:28:00.000Z', activeMs: 88 * 60_000,
    });
    const milestone = appendBuildSession(h.run, h.job, h.round, nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice, 't-m1');
    const milestoneTask = task('t-m1', 'milestone', milestone.id);
    h.run.tasks.push(milestoneTask);
    const spec = prepareContextSpec(h.run, h.job, h.round, milestone, { ...baseSpec(milestoneTask.id), timeoutMs: 120 * 60_000 }, h.store);
    assert.equal(spec.timeoutMs, 60_000); // 剩 2 分钟，其中 1 分钟硬保留给 final。
    assert.match(spec.prompt, /"roundTimeboxRemainingMs":120000/);
    assert.match(spec.prompt, /"finalVerificationReserveMinutes":1/);
    h.job.budget!.calls.push({
      id: 'spent-initial-half', taskId: milestoneTask.id, kind: 'initial', writer: true, state: 'settled',
      startedAt: '2026-10-23T01:28:00.000Z', endedAt: '2026-10-23T01:28:30.000Z', activeMs: 30_000,
    });
    assert.equal(contextInvocationTimeout(h.run, h.job, h.round, milestone, spec.timeoutMs), 30_000);
  } finally { h.cleanup(); }

  const reservedOnly = harness(4);
  try {
    initializeRoundContext(reservedOnly.run, reservedOnly.job, reservedOnly.round, reservedOnly.store, 2);
    const init = appendBuildSession(reservedOnly.run, reservedOnly.job, reservedOnly.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    reservedOnly.run.tasks.push(initTask);
    applyContextOutput(reservedOnly.run, reservedOnly.job, reservedOnly.round, initTask, multiPlan(), reservedOnly.store);
    reservedOnly.job.budget!.calls.push({
      id: 'spent-to-reserve', taskId: initTask.id, kind: 'initial', writer: false, state: 'settled',
      startedAt: '2026-10-23T00:00:00.000Z', endedAt: '2026-10-23T01:29:00.000Z', activeMs: 89 * 60_000,
    });
    assert.match((nextBuildSession(reservedOnly.run, reservedOnly.job, reservedOnly.round) as { stopReason: string }).stopReason, /仅剩最终整轮验收预留时间/);
  } finally { reservedOnly.cleanup(); }

  const exhausted = harness(4);
  try {
    initializeRoundContext(exhausted.run, exhausted.job, exhausted.round, exhausted.store, 2);
    const init = appendBuildSession(exhausted.run, exhausted.job, exhausted.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    exhausted.run.tasks.push(initTask);
    applyContextOutput(exhausted.run, exhausted.job, exhausted.round, initTask, multiPlan(), exhausted.store);
    exhausted.job.budget!.calls.push({ id: 'spent-all', taskId: initTask.id, kind: 'initial', writer: false, state: 'settled',
      startedAt: '2026-10-23T00:00:00.000Z', endedAt: '2026-10-23T01:30:00.000Z', activeMs: 90 * 60_000 });
    assert.match((nextBuildSession(exhausted.run, exhausted.job, exhausted.round) as { stopReason: string }).stopReason, /规格主动时间盒已耗尽/);
  } finally { exhausted.cleanup(); }
});

test('里程碑 minutes 只作计划估算，实际会话使用配置上限且 repair 共用该上限', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const init = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    h.run.tasks.push(initTask);
    const plan = multiPlan();
    plan.milestones[0]!.minutes = 12;
    applyContextOutput(h.run, h.job, h.round, initTask, plan, h.store);

    const milestone = appendBuildSession(h.run, h.job, h.round, nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice, 't-m1');
    const milestoneTask = task('t-m1', 'milestone', milestone.id);
    h.run.tasks.push(milestoneTask);
    const spec = prepareContextSpec(h.run, h.job, h.round, milestone, { ...baseSpec(milestoneTask.id), timeoutMs: 120 * 60_000 }, h.store);

    assert.equal(spec.timeoutMs, 35 * 60_000);
    assert.match(spec.prompt, /计划估算.*12 分钟/);
    assert.match(spec.prompt, /单会话硬上限.*35 分钟/);

    h.job.budget!.calls.push({
      id: 'spent-initial', taskId: milestoneTask.id, kind: 'initial', writer: true, state: 'settled',
      startedAt: '2026-10-23T00:00:00.000Z', endedAt: '2026-10-23T00:10:00.000Z', activeMs: 10 * 60_000,
    });
    assert.equal(contextInvocationTimeout(h.run, h.job, h.round, milestone, spec.timeoutMs), 25 * 60_000);
    assert.equal(contextInvocationTimeout(h.run, h.job, h.round, milestone, spec.timeoutMs), 25 * 60_000,
      '仅按已结算调用计时，重复计算 timeout 不能再次扣减');
    h.job.budget!.calls.push({
      id: 'spent-repair', taskId: milestoneTask.id, kind: 'repair', writer: false, state: 'settled',
      startedAt: '2026-10-23T00:10:00.000Z', endedAt: '2026-10-23T00:35:00.000Z', activeMs: 25 * 60_000,
    });
    assert.throws(() => contextInvocationTimeout(h.run, h.job, h.round, milestone, spec.timeoutMs), /当前会话主动运行时间已耗尽/);
  } finally { h.cleanup(); }
});

test('init 计划校验扣除本轮已实际使用时间并保留 final 一分钟', () => {
  const h = harness(4);
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 2);
    const init = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, 't-init');
    const initTask = task('t-init', 'init', init.id);
    h.run.tasks.push(initTask);
    h.job.budget!.calls.push({ id: 'spent-init', taskId: initTask.id, kind: 'initial', writer: false, state: 'settled',
      startedAt: '2026-10-23T00:00:00.000Z', endedAt: '2026-10-23T00:50:00.000Z', activeMs: 50 * 60_000 });
    const checked = validateContextOutput(h.run, h.job, h.round, initTask, multiPlan())!;
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /计划总时长 40 分钟超过.*39 分钟/);
  } finally { h.cleanup(); }
});

test('成功的最终整轮验收即使恰好达到 session cap 也返回完成', () => {
  const h = harness();
  try {
    initializeRoundContext(h.run, h.job, h.round, h.store, 1);
    // cap = 1 个里程碑 + 3；两个已完成的历史 init 会话模拟合法修复历史。
    for (const id of ['t-init-1', 't-init-2']) {
      const session = appendBuildSession(h.run, h.job, h.round, { kind: 'init', milestoneIds: [], finalVerification: false }, id);
      const current = task(id, 'init', session.id);
      h.run.tasks.push(current);
      completeBuildSession(h.run, h.job, h.round, current);
    }
    const milestone = appendBuildSession(h.run, h.job, h.round, nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice, 't-m1');
    const milestoneTask = task('t-m1', 'milestone', milestone.id);
    h.run.tasks.push(milestoneTask);
    h.job.verification = verification([['AC1', 'verified_pass'], ['AC2', 'awaiting_user']]);
    completeBuildSession(h.run, h.job, h.round, milestoneTask);
    const final = appendBuildSession(h.run, h.job, h.round, nextBuildSession(h.run, h.job, h.round) as BuildSessionChoice, 't-final');
    const finalTask = task('t-final', 'milestone', final.id);
    h.run.tasks.push(finalTask);
    h.job.verification = verification([['AC1', 'verified_pass'], ['AC2', 'awaiting_user']]);
    completeBuildSession(h.run, h.job, h.round, finalTask);
    assert.equal(h.round.context!.sessions.length, 4);
    assert.equal(nextBuildSession(h.run, h.job, h.round), null);
  } finally { h.cleanup(); }
});
