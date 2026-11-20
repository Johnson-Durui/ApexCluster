import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildH6PairedReport } from '../docs/verification/v05-h6-report.js';
import { CHECKS_HASH } from '../docs/verification/v05-live-acceptance.js';
import type { Run, TaskRecord } from '../src/core/types.js';

const start = '2026-10-24T00:00:00.000Z';
const end = '2026-10-24T00:10:00.000Z';

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't-1', runId: 'run-a', role: 'claude', phase: 'final_review', scope: 'job:j1', attempt: 1, rootTaskId: 't-1',
    status: 'succeeded', outputValidity: 'valid', validationErrors: [], repairAttempted: false, failure: null,
    createdAt: start, startedAt: start, endedAt: end, lastProgress: null, lastProgressAt: null,
    meta: { adapter: 'claude-code', cliVersion: 'claude-1', processStarted: true, command: ['claude'], cwd: 'fixture', requestedModel: 'claude-opus-5-5', requestedEffort: 'max', reportedModels: ['claude-opus-5-5'], reportedModelSource: 'server_usage', modelConfirmed: true, reportedEffort: 'max', effortConfirmed: true, sessionId: 's', exitCode: 0, startedAt: start, endedAt: end, durationMs: 600_000, usage: null, costUsd: null, nativeSchema: true, scrubbedEnv: [], warnings: [] },
    simulated: false, jobId: 'j1', acceptedDespiteMismatch: false, inputRef: 'spec-generated',
    executionCalls: [{ kind: 'initial', status: 'succeeded', startedAt: start, endedAt: end }],
    ...patch,
  };
}

function run(id: string, evaluatorEnabled: boolean, finalReviewEnabled: boolean, patch: Record<string, unknown> = {}): Run {
  const verification = { verdict: 'passed', items: [], selfReportMismatches: [], computedAt: end } as const;
  return {
    id, title: id, createdAt: start, updatedAt: end, mode: 'real', mockScenario: null, phase: 'final_gate', phaseStatus: 'waiting_user', blockedReason: null, terminal: null,
    models: {
      claude: { role: 'claude', adapter: 'claude', model: 'claude-opus-5-5', effort: 'max' },
      astra: { role: 'astra', adapter: 'codex', model: 'gpt-6-astra', effort: 'ultra' },
      sol: { role: 'sol', adapter: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
    },
    clarifyWith: 'both', allowWebResearch: false, preflight: { enabled: true },
    build: { maxRounds: 3, maxWriterSessions: 4, maxModelCalls: 10, maxActiveMinutes: 30, autoRework: true, resumePolicy: 'never' },
    evaluator: { enabled: evaluatorEnabled, model: 'gpt-6-astra', effort: 'ultra', timeoutMinutes: 10 },
    finalReview: { enabled: finalReviewEnabled, model: 'claude-opus-5-5', effort: 'max', timeoutMinutes: 10 },
    contextBudget: { enabled: false }, chores: { digest: false, qgroup: false }, metricsConfig: { version: 1, fingerprint: `fingerprint-${id}` },
    writeDocs: false, writePrd: false, docWriter: { role: 'claude', model: 'claude-opus-5-5', effort: 'max' },
    docs: { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 },
    criteria: [{ id: 'criterion-generated', name: 'JSON 输出', weight: 1, description: '输出有效 JSON' }], criteriaLockedAt: start,
    decisionParams: { delta: 0.5, preferenceMargin: 0.2, tieEpsilon: 0.01 },
    snapshots: [{ version: 1, ref: `snapshot-${id}`, hash: `hash-${id}`, createdAt: start, reason: 'fixture', project: { prompt: 'Node 原生 JSON 待办 CLI', coreFlows: ['add', 'list'], existingStack: 'Node', deployment: 'CLI', budget: 'small', acceptance: '三个命令通过', context: 'offline' }, constraints: [{ id: 'HC1', text: '不得使用第三方依赖', source: 'user' }], facts: [], assumptions: [], openItems: [] }],
    currentSnapshotVersion: 1, designSnapshotVersion: 1, degraded: [], tasks: [task({ runId: id })], questions: [], modelNotes: [], proposals: [], judgments: [], equivalenceGroups: {}, manualMerges: [], candidates: [], overrides: [], decision: null, anonymization: null, recheckBatch: 0, recheckRequests: [], recheckLog: [], gates: [{ id: 'G2_framework', openedAt: start, resolvedAt: end, resolution: { gate: 'G2_framework', action: 'validate', candidateIds: [`candidate-${id}`], specs: [{ candidateId: `candidate-${id}`, goal: '实现待办 CLI', scopeIn: ['add', 'list'], scopeOut: ['network'], acceptance: [{ id: 'AC1', description: 'add/list 输出 JSON', kind: 'command', command: 'node cli.mjs list', expectExitCode: 0, outputIncludes: '[]' }], hypotheses: [], timeboxMinutes: 20, allowNetwork: false }] }, context: {} }], jobBatch: 1,
    jobs: [{ id: `job-${id}`, runId: id, batch: 1, candidateId: `candidate-${id}`, proposalId: `proposal-${id}`, effort: 'max', effortReason: 'fixture', workspaceDir: `work/${id}`, gitRepo: true, spec: { ref: `spec-${id}`, candidateId: `candidate-${id}`, goal: '实现待办 CLI', scopeIn: ['add', 'list'], scopeOut: ['network'], acceptance: [{ id: 'AC1', description: 'add/list 输出 JSON', kind: 'command', command: 'node cli.mjs list', expectExitCode: 0, outputIncludes: '[]' }], hypotheses: [], timeboxMinutes: 20, allowNetwork: false, comparisonQuestions: [] }, status: 'passed', taskIds: [], report: null, verification, manualResults: [], failureClass: null, failureClassSource: null, firstVerification: verification, devGuideVersion: null, createdAt: start, endedAt: end, maxRounds: 2, autoRework: false, budget: { limits: { maxRounds: 2, maxWriterSessions: 6, maxModelCalls: 10, maxActiveMinutes: 30 }, usage: { buildRounds: 1, writerSessions: 1, modelCalls: 1, activeMs: 600_000 }, reservedCalls: [], reservedWriterSessions: [], exhaustedReason: null, calls: [] }, lightRework: { enabled: false, minutes: 5, capabilityRef: null }, rounds: [{ round: 1, kind: 'initial', writer: 'sol', buildTaskId: 'build', evaluateTaskId: evaluatorEnabled ? 'eval' : null, report: null, verification, evaluation: evaluatorEnabled ? { specRef: `spec-${id}`, round: 1, workspaceCommit: null, verdict: 'pass', acceptance: [], defects: [], reworkBrief: [], environmentIssues: [], deviationsNoted: [], questions: [] } : null, workspaceCommit: null, treeHash: null, baselineCommit: null, fileTree: [], diffStat: '', reviewWorkspace: null, reviewIntegrity: null, verifiedDefectIds: [], reworkBrief: [], outcome: 'passed', staleReason: null, stoppedReason: null, createdAt: start, endedAt: end }], finalReview: finalReviewEnabled ? { specRef: `spec-${id}`, workspaceCommit: null, roundsReviewed: [1], verdict: 'accept', summary: 'ok', findings: [], frameworkCompliance: 'compliant', reworkNotes: [], questions: [] } : null }],
    finalChoice: null, designRound: 1, archivedRounds: [],
    ...patch,
  } as unknown as Run;
}

function report(runs: Run[], environments = runs.map(() => 'win-node22-cli-v1')) {
  return buildH6PairedReport({ fixtureLabel: 'node-json-todo-v1', entries: runs.map((item, index) => ({ run: item, environmentId: environments[index]!, fixtureEvidence: { runId: item.id, observedChecksHash: CHECKS_HASH, independentVerification: { sourceHash: 'a'.repeat(64), checksHash: CHECKS_HASH, passed: true, evidencePath: `evidence/${item.id}.json` } }, cliEvidence: { codexVersion: 'codex-v1', claudeVersion: 'claude-v1' } })), asOf: end });
}

test('仅 evaluator/finalReview 开关不同的固定规格可比较，完整配置指纹差异不误拒绝', () => {
  const result = report([run('off', false, false), run('eval', true, false), run('both', true, true)]);
  assert.equal(result.executionComparable, true);
  assert.equal(result.experimentComplete, false);
  assert.deepEqual(result.missingHumanEvidence, ['humanInterventionMinutes', 'decisionChanged']);
  assert.deepEqual(result.incomparableReasons, []);
  assert.equal(result.causalConclusion, null);
  assert.equal(result.humanInterventionMinutes, null);
  assert.deepEqual(result.runs.map((item) => item.reviewStatus), ['disabled', 'pass', 'pass']);
  assert.deepEqual(result.runs.map((item) => item.finalReviewStatus), ['disabled', 'disabled', 'accept']);
  assert.equal(result.runs[0]!.g4DecisionRecorded, false);
  assert.equal(result.runs[0]!.finalVerification?.conclusion, 'passed');
});

test('开关之外的型号强度、CLI 环境和版本差异给出具体不可比原因', () => {
  const differentModel = run('different', true, true);
  differentModel.models.sol.effort = 'ultra';
  const differentCli = run('cli', true, false);
  differentCli.tasks[0]!.meta!.cliVersion = 'claude-2';
  const result = report([run('base', false, false), differentModel, differentCli], ['env-a', 'env-a', 'env-b']);
  assert.equal(result.executionComparable, false);
  assert.ok(result.incomparableReasons.some((reason) => reason.includes('different')));
  assert.ok(result.incomparableReasons.some((reason) => reason.includes('cli')));
});

test('规格正文或验收命令变化不可比较，即使 fixture 标签相同', () => {
  const changed = run('changed', true, false);
  changed.jobs[0]!.spec.acceptance[0]!.command = 'node cli.mjs export';
  const result = report([run('base', false, false), changed]);
  assert.equal(result.executionComparable, false);
  assert.match(result.incomparableReasons.join('\n'), /jobs/);
});

test('运行生成身份可不同，但验收与约束业务 ID 变化不能被归一化掩盖', () => {
  const base = run('generated-a', false, false);
  const sameSemantics = run('generated-b', true, false);
  assert.equal(report([base, sameSemantics]).executionComparable, true);

  const changedAcceptanceId = run('changed-ac', true, false);
  changedAcceptanceId.jobs[0]!.spec.acceptance[0]!.id = 'AC2';
  assert.equal(report([base, changedAcceptanceId]).executionComparable, false);

  const changedConstraintId = run('changed-constraint', true, false);
  changedConstraintId.snapshots[0]!.constraints[0]!.id = 'HC2';
  assert.equal(report([base, changedConstraintId]).executionComparable, false);
});

test('CLI 版本按角色与请求模型比对，跨角色交换会被识别，单侧额外身份不误判', () => {
  const base = run('versions-a', false, false);
  const candidate = run('versions-b', true, true);
  const baseSol = task({ id: 'base-sol', runId: base.id, role: 'sol', phase: 'build' });
  baseSol.meta = { ...baseSol.meta!, adapter: 'codex', requestedModel: 'gpt-6.1-sol', cliVersion: 'codex-v2' };
  const candidateSol = task({ id: 'candidate-sol', runId: candidate.id, role: 'sol', phase: 'build' });
  candidateSol.meta = { ...candidateSol.meta!, adapter: 'codex', requestedModel: 'gpt-6.1-sol', cliVersion: 'claude-v1' };
  base.tasks[0]!.meta!.cliVersion = 'claude-v1';
  candidate.tasks[0]!.meta!.cliVersion = 'codex-v2';
  base.tasks.push(baseSol);
  candidate.tasks.push(candidateSol);
  const swapped = report([base, candidate]);
  assert.equal(swapped.executionComparable, false);
  assert.ok(swapped.incomparableReasons.some((reason) => reason.includes('CLI 版本不同')));

  const extraIdentity = run('extra', true, false);
  const extraTask = task({ id: 'extra-grok', runId: extraIdentity.id, role: 'grok', phase: 'digest' });
  extraTask.meta = { ...extraTask.meta!, adapter: 'cursor', requestedModel: 'grok-4.7-high-fast', reportedModels: ['grok-4.7-high-fast'], cliVersion: 'cursor-v1' };
  extraIdentity.tasks.push(extraTask);
  assert.equal(report([run('plain', false, false), extraIdentity]).executionComparable, true);
});

test('作业级 G2 覆盖参数参与比较，不能由相同 run 配置掩盖', () => {
  const base = run('job-base', false, false);
  const changed = run('job-changed', true, false);
  base.jobs[0]!.effort = 'max';
  base.jobs[0]!.autoRework = true;
  base.jobs[0]!.maxRounds = 3;
  base.jobs[0]!.budget = { limits: { maxRounds: 3, maxWriterSessions: 4, maxModelCalls: 10, maxActiveMinutes: 30 }, usage: { buildRounds: 1, writerSessions: 1, modelCalls: 1, activeMs: 60_000 }, reservedCalls: [], reservedWriterSessions: [], exhaustedReason: null, calls: [] };
  base.jobs[0]!.lightRework = { enabled: false, minutes: 5, capabilityRef: null };
  changed.jobs[0]!.effort = 'ultra';
  changed.jobs[0]!.autoRework = false;
  changed.jobs[0]!.maxRounds = 2;
  changed.jobs[0]!.budget = { limits: { maxRounds: 2, maxWriterSessions: 3, maxModelCalls: 8, maxActiveMinutes: 25 }, usage: { buildRounds: 1, writerSessions: 1, modelCalls: 1, activeMs: 60_000 }, reservedCalls: [], reservedWriterSessions: [], exhaustedReason: null, calls: [] };
  changed.jobs[0]!.lightRework = { enabled: true, minutes: 5, capabilityRef: 'cap-v1' };
  const result = report([base, changed]);
  assert.equal(result.executionComparable, false);
  assert.ok(result.incomparableReasons.some((reason) => reason.includes('jobs')));
});

test('作业冻结字段缺失不能因两边同时 unknown 而判为可比，轮次上限必须自洽', () => {
  const missingA = run('missing-freeze-a', false, false);
  const missingB = run('missing-freeze-b', true, false);
  missingA.jobs[0]!.autoRework = undefined;
  missingB.jobs[0]!.autoRework = undefined;
  const missing = report([missingA, missingB]);
  assert.equal(missing.executionComparable, false);
  assert.ok(missing.incomparableReasons.some((reason) => reason.includes('autoRework')));

  const mismatch = run('round-mismatch', true, false);
  mismatch.jobs[0]!.maxRounds = 3;
  const inconsistent = report([run('round-base', false, false), mismatch]);
  assert.equal(inconsistent.executionComparable, false);
  assert.ok(inconsistent.incomparableReasons.some((reason) => reason.includes('maxRounds 与 budget.limits.maxRounds')));
});

test('arm 组合严格限制：两运行只能差一位，三运行必须是 off/evaluate/both', () => {
  assert.equal(report([run('off', false, false), run('both', true, true)]).executionComparable, false);
  assert.ok(report([run('off-2', false, false), run('both-2', true, true)]).incomparableReasons.some((reason) => reason.includes('只能有一个')));
  const duplicate = report([run('off-3', false, false), run('eval-1', true, false), run('eval-2', true, false)]);
  assert.equal(duplicate.executionComparable, false);
  assert.ok(duplicate.incomparableReasons.some((reason) => reason.includes('00/10/11')));
});

test('fixture 证据与已解决 G2 validate 记录是执行可比前提', () => {
  const base = run('evidence-base', false, false);
  const peer = run('evidence-peer', true, false);
  const missingEvidence = buildH6PairedReport({ fixtureLabel: 'fixture', entries: [
    { run: base, environmentId: 'env', cliEvidence: { codexVersion: 'codex-v1', claudeVersion: 'claude-v1' } },
    { run: peer, environmentId: 'env', fixtureEvidence: { runId: peer.id, observedChecksHash: CHECKS_HASH, independentVerification: { sourceHash: 'a'.repeat(64), checksHash: CHECKS_HASH, passed: true, evidencePath: 'evidence/peer.json' } }, cliEvidence: { codexVersion: 'codex-v1', claudeVersion: 'claude-v1' } },
  ], asOf: end });
  assert.equal(missingEvidence.executionComparable, false);
  assert.ok(missingEvidence.incomparableReasons.some((reason) => reason.includes('fixture 检查证据')));

  peer.gates[0]!.resolution = { gate: 'G2_framework', action: 'validate', candidateIds: ['wrong'], specs: [] };
  const badG2 = report([base, peer]);
  assert.equal(badG2.executionComparable, false);
  assert.ok(badG2.incomparableReasons.some((reason) => reason.includes('G2 validate')));
});

test('fixture 证据必须绑定本 run 和固定脚本哈希，CLI preflight 版本必须完整且跨 run 相同', () => {
  const base = run('binding-base', false, false);
  const peer = run('binding-peer', true, false);
  const badEvidence = buildH6PairedReport({ fixtureLabel: 'fixture', entries: [
    { run: base, environmentId: 'env', fixtureEvidence: { runId: 'other-run', observedChecksHash: 'caller-controlled', independentVerification: null }, cliEvidence: { codexVersion: 'codex-v1', claudeVersion: 'claude-v1' } },
    { run: peer, environmentId: 'env', fixtureEvidence: { runId: peer.id, observedChecksHash: CHECKS_HASH, independentVerification: { sourceHash: 'bad', checksHash: 'bad', passed: false, evidencePath: '' } }, cliEvidence: { codexVersion: 'codex-v2', claudeVersion: '' } },
  ], asOf: end });
  assert.equal(badEvidence.executionComparable, false);
  assert.ok(badEvidence.incomparableReasons.some((reason) => reason.includes('绑定了其他运行')));
  assert.ok(badEvidence.incomparableReasons.some((reason) => reason.includes('脚本常量')));
  assert.ok(badEvidence.incomparableReasons.some((reason) => reason.includes('CLI 版本证据')));
  assert.ok(badEvidence.incomparableReasons.some((reason) => reason.includes('preflight 版本证据不一致')));
  assert.ok(badEvidence.incomparableReasons.some((reason) => reason.includes('独立 fixture 复跑')));
});

test('独立验收记录缺失不能复用 writer 日志完成执行比较', () => {
  const base = run('independent-base', false, false);
  const peer = run('independent-peer', true, false);
  const result = buildH6PairedReport({ fixtureLabel: 'fixture', entries: [
    { run: base, environmentId: 'env', fixtureEvidence: { runId: base.id, observedChecksHash: CHECKS_HASH, independentVerification: null }, cliEvidence: { codexVersion: 'codex-v1', claudeVersion: 'claude-v1' } },
    { run: peer, environmentId: 'env', fixtureEvidence: { runId: peer.id, observedChecksHash: CHECKS_HASH, independentVerification: { sourceHash: 'b'.repeat(64), checksHash: CHECKS_HASH, passed: true, evidencePath: 'independent/peer.json' } }, cliEvidence: { codexVersion: 'codex-v1', claudeVersion: 'claude-v1' } },
  ], asOf: end });
  assert.equal(result.executionComparable, false);
  assert.ok(result.incomparableReasons.some((reason) => reason.includes('写者结束后的独立 fixture 复跑证据')));
  assert.equal(result.experimentComplete, false);
});

test('人工接受型号不符、回报型号或强度不符均拒绝，日期后缀与未知确认状态不误拒绝', () => {
  const accepted = run('accepted-mismatch', true, false);
  accepted.tasks[0]!.acceptedDespiteMismatch = true;
  assert.ok(report([run('accepted-base', false, false), accepted]).incomparableReasons.some((reason) => reason.includes('人工接受了型号不符')));

  const wrongModel = run('wrong-model', true, false);
  wrongModel.tasks[0]!.meta!.reportedModels = ['claude-other'];
  assert.ok(report([run('model-base', false, false), wrongModel]).incomparableReasons.some((reason) => reason.includes('回报型号')));

  const wrongEffort = run('wrong-effort', true, false);
  wrongEffort.tasks[0]!.meta!.reportedEffort = 'high';
  assert.ok(report([run('effort-base', false, false), wrongEffort]).incomparableReasons.some((reason) => reason.includes('回报强度')));

  const dated = run('dated-model', true, false);
  dated.tasks[0]!.meta!.reportedModels = ['claude-opus-5-5-20261024'];
  dated.tasks[0]!.meta!.modelConfirmed = false;
  assert.equal(report([run('dated-base', false, false), dated]).executionComparable, true);
});

test('unknown 保持 null，不从零调用或关卡等待推断人工介入', () => {
  const unknown = run('unknown', false, false);
  unknown.tasks[0]!.executionCalls = undefined;
  unknown.jobs[0]!.rounds = undefined;
  const result = report([unknown, run('known', true, false)]);
  assert.equal(result.runs[0]!.claudeActualCalls, null);
  assert.equal(result.runs[0]!.modelMinutes, null);
  assert.equal(result.runs[0]!.reworkRounds, null);
  assert.equal(result.runs[0]!.humanInterventionMinutes, null);
  assert.equal(result.runs[0]!.decisionChanged, null);
});

test('Claude 实际调用只统计确认启动的 calls，准备失败是已知零，旧启动证据缺失为 unknown', () => {
  const preparedFailure = run('prepared-failure', false, false);
  preparedFailure.tasks.push(task({
    id: 'not-started', runId: preparedFailure.id, status: 'failed', executionCalls: undefined,
    meta: { ...preparedFailure.tasks[0]!.meta!, processStarted: false },
  }));
  assert.equal(report([preparedFailure, run('peer', true, false)]).runs[0]!.claudeActualCalls, 1);

  const legacy = run('legacy-start', false, false);
  legacy.tasks[0]!.meta = { ...legacy.tasks[0]!.meta!, processStarted: undefined };
  assert.equal(report([legacy, run('peer-2', true, false)]).runs[0]!.claudeActualCalls, null);
});

test('模型失败保留在描述性报告，mock/live、漂移及未结束作业拒绝比较', () => {
  const failed = run('failed-model', true, false);
  failed.tasks[0] = task({ id: 'failed-task', runId: failed.id, status: 'failed', failure: { kind: 'rate_limited', message: 'limit' } });
  const mock = run('mock', false, false, { mode: 'mock' });
  const drifted = run('drifted', true, true, { metricsConfig: { version: 1, fingerprint: 'x', drifted: true } });
  drifted.jobs[0]!.status = 'running';
  const result = report([failed, mock, drifted]);
  assert.equal(result.executionComparable, false);
  assert.ok(result.incomparableReasons.includes('H6 执行比较只接受 mode=real 的运行'));
  assert.ok(result.incomparableReasons.some((reason) => reason.includes('冻结配置已漂移')));
  assert.ok(result.incomparableReasons.some((reason) => reason.includes('未结束')));
  assert.deepEqual(result.runs[0]!.modelFailures, [{ taskId: 'failed-task', role: 'claude', phase: 'final_review', status: 'failed', failureKind: 'rate_limited' }]);
});
