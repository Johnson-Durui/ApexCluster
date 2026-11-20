import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AdapterResult, ModelTaskSpec } from '../src/adapters/types.js';
import { CHECKS, CHECKS_HASH } from '../docs/verification/v05-live-acceptance.js';
import { DEFECT_SOURCE, injectDeterministicDefect, isFirstWritableBuild, isJobWorkspaceBuild, REWORK_ROOT, reworkConfig, reworkInput,
  allowedReworkPhaseSequence, preContractSnapshotIssues, retryEvaluationStateIssues, reworkApproval, reworkG2Input, reworkRetryEvaluationInput,
  selectedCandidateSmallPlanIssues, writerProcessExitConfirmed } from '../docs/verification/v05-live-rework-acceptance.js';

function spec(cwd: string, logDir: string, patch: Partial<ModelTaskSpec> = {}): ModelTaskSpec {
  return {
    taskId: 't-job-j-C1-1-r1-s1-sol-a1', runId: 'r-test', role: 'sol', phase: 'build', attempt: 1,
    model: 'gpt-6.2-sol', effort: 'max', prompt: 'test', outputSchema: {}, cwd, logDir, timeoutMs: 1_000,
    sandbox: 'workspace_write', allowNetwork: false, gitRepo: true, allowWeb: false, resumeSessionId: null,
    context: { snapshotRef: 'snapshot-1', buildRound: 1, finalVerification: false }, ...patch,
  } as ModelTaskSpec;
}

function planRun(workstreamCount: number) {
  return {
    candidates: [{ id: 'C1', representativeProposalId: 'proposal-1' }],
    proposals: [{ id: 'proposal-1', mvpPlan: { workstreams: Array.from({ length: workstreamCount }, (_, index) => ({
      id: `WS${index + 1}`, title: `workstream ${index + 1}`, dependsOn: [],
    })) } }],
  } as never;
}

function git(cwd: string, args: string[]) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost' };
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('返工验收冻结真实型号、评审开关、串行执行及共同预算', () => {
  const config = reworkConfig();
  assert.deepEqual([config.models.sol.model, config.models.sol.effort], ['gpt-6.2-sol', 'max']);
  assert.deepEqual([config.models.astra.model, config.models.astra.effort], ['gpt-6.2-astra', 'max']);
  assert.deepEqual([config.models.claude.model, config.finalReview.effort], ['claude-opus-5-5', 'xhigh']);
  assert.equal(config.evaluator.enabled, true);
  assert.equal(config.finalReview.enabled, true);
  assert.equal(config.build.autoRework, true);
  assert.equal(config.build.maxRounds, 2);
  assert.equal(config.build.maxModelCalls, 10);
  assert.equal(config.build.maxActiveMinutes, 30);
  assert.equal(config.build.lightReworkEnabled, false);
  assert.equal(config.limits.maxConcurrentModelTasks, 1);
  assert.equal(config.limits.maxConcurrentJobs, 1);
  const input = reworkInput();
  assert.equal(input.mode, 'real');
  assert.equal(input.build?.autoRework, true);
  assert.equal(input.evaluator?.enabled, true);
  assert.equal(input.finalReview?.enabled, true);
  const approval = reworkApproval();
  assert.equal(approval.taskFailureRetries, false);
  assert.equal(approval.authorizedEvaluationRetries, 1);
  assert.equal(Object.hasOwn(approval, 'retries'), false);
});

test('缺陷注入只允许首轮可写 build', () => {
  const base = spec(path.join(path.resolve('work/v05-rework-desktop-20261026/ws'), 'r-test', 'j-test'), 'C:\\logs');
  assert.equal(isFirstWritableBuild(base), true);
  assert.equal(isFirstWritableBuild({ ...base, sandbox: 'read_only' }), false);
  assert.equal(isFirstWritableBuild({ ...base, context: { ...base.context, finalVerification: true } }), false);
  assert.equal(isFirstWritableBuild({ ...base, context: { ...base.context, buildRound: 2 } }), false);
  assert.equal(isFirstWritableBuild({ ...base, phase: 'evaluate' }), false);
  const meta: AdapterResult['meta'] = { adapter: 'codex', cliVersion: null, processStarted: true, command: [], cwd: base.cwd,
    requestedModel: base.model, requestedEffort: base.effort, reportedModels: [], reportedModelSource: null,
    modelConfirmed: false, reportedEffort: null, effortConfirmed: false, sessionId: 's', exitCode: 0,
    startedAt: '2026-10-26T00:00:00.000Z', endedAt: '2026-10-26T00:00:01.000Z', durationMs: 1_000,
    usage: null, costUsd: null, nativeSchema: true, scrubbedEnv: [], warnings: [] };
  assert.equal(writerProcessExitConfirmed({ status: 'succeeded', failure: null, rawText: null, structured: {}, meta, toolLog: [], simulated: false }), true);
  assert.equal(writerProcessExitConfirmed({ status: 'succeeded', failure: null, rawText: null, structured: {},
    meta: { ...meta, terminationWarning: 'unknown tree' }, toolLog: [], simulated: false }), false);
});

test('schema repair build 使用独立只读 repair-cwd，不触发 workspace fixture 检查或注入', () => {
  const workspace = path.join(path.resolve('work/v05-rework-desktop-20261026/ws'), 'r-test', 'j-test');
  const repair = spec(path.resolve('work/v05-rework-desktop-20261026/data/runs/r-test/tasks/t-build/repair-cwd'), path.resolve('work/logs'), {
    sandbox: 'read_only', gitRepo: false,
  });
  assert.equal(isJobWorkspaceBuild(spec(workspace, path.resolve('work/logs'))), true);
  assert.equal(isJobWorkspaceBuild(repair), false);
  assert.equal(isFirstWritableBuild(repair), false);
});

test('G2 前只接受恰好一个 workstream 且命中 smallMilestonePlan 的候选', () => {
  assert.deepEqual(selectedCandidateSmallPlanIssues(planRun(1), 'C1'), []);
  const tasks: string[] = [];
  assert.match(selectedCandidateSmallPlanIssues(planRun(0), 'C1').join('；'), /恰好包含 1 个工作流|smallMilestonePlan/);
  assert.equal(tasks.length, 0, '拒绝发生在创建 build task 之前');
  assert.match(selectedCandidateSmallPlanIssues(planRun(2), 'C1').join('；'), /恰好包含 1 个工作流|smallMilestonePlan/);
  assert.equal(tasks.length, 0, '拒绝发生在创建 build task 之前');
});

test('真实 build 入口构造的 G2 请求通过严格 schema，resumePolicy 仅沿用创建时冻结值', () => {
  const input = reworkG2Input('C1', 'fixture-test');
  assert.equal(input.gate, 'G2_framework');
  assert.equal(input.action, 'validate');
  assert.deepEqual(input.candidateIds, ['C1']);
  assert.equal(input.buildOverrides?.C1?.autoRework, true);
  assert.equal(input.buildOverrides?.C1?.maxRounds, 2);
  assert.equal(input.buildOverrides?.C1?.maxModelCalls, 10);
  assert.equal(input.buildOverrides?.C1?.maxActiveMinutes, 30);
  assert.equal(Object.hasOwn(input.buildOverrides?.C1 ?? {}, 'resumePolicy'), false);
});

test('显式 retry-evaluation 使用严格 G4 schema，且只接受首轮已停止的3调用状态', () => {
  const input = reworkRetryEvaluationInput('j-C1-1');
  assert.equal(input.gate, 'G4_final');
  assert.equal(input.action, 'retry_evaluation');
  assert.equal(input.jobId, 'j-C1-1');
  const run = {
    phase: 'final_gate', phaseStatus: 'waiting_user', jobBatch: 1,
    jobs: [{ id: 'j-C1-1', batch: 1, candidateId: 'C1', status: 'inconclusive', writeLock: null,
      budget: { limits: { maxRounds: 2, maxWriterSessions: 4, maxModelCalls: 10, maxActiveMinutes: 30 },
        usage: { buildRounds: 1, writerSessions: 1, modelCalls: 3, activeMs: 325_056 } },
      rounds: [{ round: 1, outcome: 'stopped', verifiedDefectIds: [], reworkBrief: [] }] }],
    tasks: [
      { id: 'b1', jobId: 'j-C1-1', phase: 'build', status: 'succeeded' },
      { id: 'b2', jobId: 'j-C1-1', phase: 'build', status: 'succeeded' },
      { id: 'e1', jobId: 'j-C1-1', phase: 'evaluate', status: 'succeeded' },
    ],
  } as never;
  assert.deepEqual(retryEvaluationStateIssues(run, 'C1'), []);
  const duplicate = structuredClone(run) as never as { tasks: Array<Record<string, unknown>> };
  duplicate.tasks.push({ id: 'e2', jobId: 'j-C1-1', phase: 'evaluate', status: 'succeeded' });
  assert.match(retryEvaluationStateIssues(duplicate as never, 'C1').join('；'), /任务序列/);
  const widened = structuredClone(run) as never as { jobs: Array<{ budget: { limits: { maxModelCalls: number } } }> };
  widened.jobs[0]!.budget.limits.maxModelCalls = 11;
  assert.match(retryEvaluationStateIssues(widened as never, 'C1').join('；'), /预算上限/);
});

test('返工链只允许无重试或明确一次首轮 evaluate 重试的精确阶段序列', () => {
  assert.equal(allowedReworkPhaseSequence(['build', 'build', 'evaluate', 'build', 'build', 'evaluate', 'final_review']), true);
  assert.equal(allowedReworkPhaseSequence(['build', 'build', 'evaluate', 'evaluate', 'build', 'build', 'evaluate', 'final_review']), true);
  assert.equal(allowedReworkPhaseSequence(['build', 'build', 'evaluate', 'evaluate', 'evaluate', 'build', 'build', 'evaluate', 'final_review']), false);
});

test('pre-contract-fix manifest 对列出证据逐文件校验长度与 SHA-256', () => {
  mkdirSync(REWORK_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(REWORK_ROOT, 'snapshot-test-'));
  try {
    const contents: Record<string, string> = {
      'run.json': '{"run":true}\n',
      'build-summary.json': '{"summary":true}\n',
      'evaluation-task/output.json': '{"output":true}\n',
      'evaluation-task/tool-log.json': '[]\n',
      'evaluation-task/meta.json': '{"meta":true}\n',
    };
    const files = Object.entries(contents).map(([relative, source]) => {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source, 'utf8');
      return { path: relative, sha256: createHash('sha256').update(source).digest('hex'), length: Buffer.byteLength(source) };
    });
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ runId: 'r-20261026-584b00', evaluationTaskId: 'evaluate-1', files }), 'utf8');
    assert.deepEqual(preContractSnapshotIssues('r-20261026-584b00', root), []);
    writeFileSync(path.join(root, 'evaluation-task', 'output.json'), '{"tampered":true}\n', 'utf8');
    assert.match(preContractSnapshotIssues('r-20261026-584b00', root).join('；'), /哈希或长度不匹配/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('确定性缺陷作为独立 git 提交写入且不改变固定检查', () => {
  const tempRoot = path.join(REWORK_ROOT, 'ws', 'test-tmp');
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, 'dmw-rework-'));
  const logDir = path.join(root, 'logs');
  const marker = path.join(root, 'evidence', 'defect-injection.json');
  mkdirSync(logDir, { recursive: true });
  try {
    for (const [name, source] of Object.entries(CHECKS)) writeFileSync(path.join(root, name), source, 'utf8');
    writeFileSync(path.join(root, 'sum.mjs'), 'export function sumIntegers(a, b) { return a + b; }\n', 'utf8');
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    git(root, ['commit', '--no-gpg-sign', '-q', '-m', 'baseline']);
    const record = injectDeterministicDefect(spec(root, logDir), marker, () => '2026-10-26T00:00:00.000Z');
    assert.equal(readFileSync(path.join(root, 'sum.mjs'), 'utf8'), DEFECT_SOURCE);
    assert.equal(record.afterSourceHash.length, 64);
    assert.notEqual(record.beforeCommit, record.afterCommit);
    const originalAtCommit = spawnSync('git', ['show', `${record.beforeCommit}:sum.mjs`], { cwd: root, encoding: 'utf8', windowsHide: true });
    const injectedAtCommit = spawnSync('git', ['show', `${record.afterCommit}:sum.mjs`], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(originalAtCommit.stdout, 'export function sumIntegers(a, b) { return a + b; }\n');
    assert.equal(injectedAtCommit.stdout, DEFECT_SOURCE);
    assert.equal(record.checksHash, CHECKS_HASH);
    assert.deepEqual(Object.fromEntries(Object.keys(CHECKS).map(name => [name, readFileSync(path.join(root, name), 'utf8')])), CHECKS);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), record);
    assert.deepEqual(JSON.parse(readFileSync(path.join(logDir, 'defect-injection.json'), 'utf8')), record);
    assert.throws(() => injectDeterministicDefect(spec(root, logDir), marker), /拒绝重复/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
