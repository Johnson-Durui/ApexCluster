import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobBudget, reserveBudgetCall, startBudgetCall } from '../src/core/job-budget.js';
import { grokEvaluationVerification, reserveLightReworkBudget } from '../src/core/light-rework.js';
import type { BuildRound, MvpSpec } from '../src/core/types.js';
import type { ToolLogItem } from '../src/core/verify-mvp.js';

const now = '2026-10-23T08:00:00.000Z';

function spec(): MvpSpec {
  return {
    ref: 'spec-light', candidateId: 'C1', goal: 'light rework', scopeIn: [], scopeOut: [],
    acceptance: [
      { id: 'AC1', description: 'tests', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: 'passed' },
      { id: 'AC2', description: 'manual', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
    ],
    hypotheses: [], timeboxMinutes: 30, allowNetwork: false, comparisonQuestions: [],
  };
}

function round(patch: Partial<BuildRound> = {}): BuildRound {
  return {
    round: 2, kind: 'rework', writer: 'grok', buildTaskId: 'writer-2', evaluateTaskId: 'evaluate-2',
    report: null, verification: null, evaluation: null, workspaceCommit: 'commit-2', treeHash: 'tree-2', baselineCommit: 'base-1',
    fileTree: [], diffStat: '', reviewWorkspace: 'review-2', reviewIntegrity: { ok: true, errors: [] }, verifiedDefectIds: [], reworkBrief: [],
    lightRework: { allowedFiles: ['src/a.ts'], sourceCommit: 'commit-1', sourceTreeHash: 'tree-1', capabilityRef: 'capability-a',
      minutes: 5, evaluateMinutes: 8, finalMinutes: 5, reservedEvaluateTaskId: 'evaluate-2', reservedFinalTaskId: 'final-2' },
    outcome: 'pending', staleReason: null, stoppedReason: null, createdAt: now, endedAt: null,
    ...patch,
  };
}

function commandLog(patch: Partial<ToolLogItem> = {}): ToolLogItem {
  return { seq: 7, type: 'command_execution', command: 'powershell -Command "npm test"', exitCode: 0, output: 'passed', status: 'completed', paths: [], ...patch };
}

test('轻量返工预算在 clone 上一次性预留轮次和 writer/evaluate/final 调用', () => {
  const budget = createJobBudget({ maxRounds: 3, maxWriterSessions: 2, maxModelCalls: 4, maxActiveMinutes: 30 });
  const before = structuredClone(budget);
  const reserved = reserveLightReworkBudget(budget, {
    writerTaskId: 'writer-2', evaluateTaskId: 'evaluate-2', finalTaskId: 'final-2',
    writerMinutes: 10, evaluateMinutes: 8, finalMinutes: 5, now,
  });
  assert.deepEqual(budget, before, '原预算不得被部分修改');
  assert.equal(reserved.usage.buildRounds, 1);
  assert.deepEqual(reserved.calls.map((call) => [call.id, call.taskId, call.writer, call.state]), [
    ['writer-2:initial', 'writer-2', true, 'reserved'],
    ['evaluate-2:initial', 'evaluate-2', false, 'reserved'],
    ['final-2:initial', 'final-2', false, 'reserved'],
  ]);
  assert.deepEqual(reserved.reservedWriterSessions, ['writer-2:initial']);
});

test('轻量返工预算要求全部 timeout 容量，任一失败不污染原预算', () => {
  for (const budget of [
    createJobBudget({ maxRounds: 0, maxWriterSessions: 2, maxModelCalls: 4, maxActiveMinutes: 30 }),
    createJobBudget({ maxRounds: 3, maxWriterSessions: 0, maxModelCalls: 4, maxActiveMinutes: 30 }),
    createJobBudget({ maxRounds: 3, maxWriterSessions: 2, maxModelCalls: 2, maxActiveMinutes: 30 }),
    createJobBudget({ maxRounds: 3, maxWriterSessions: 2, maxModelCalls: 4, maxActiveMinutes: 20 }),
  ]) {
    const before = JSON.stringify(budget);
    assert.throws(() => reserveLightReworkBudget(budget, {
      writerTaskId: 'writer', evaluateTaskId: 'evaluate', finalTaskId: 'final',
      writerMinutes: 10, evaluateMinutes: 8, finalMinutes: 5, now,
    }), /预算|会话|轮次|时间/);
    assert.equal(JSON.stringify(budget), before);
  }

  const running = createJobBudget({ maxRounds: 3, maxWriterSessions: 3, maxModelCalls: 5, maxActiveMinutes: 30 });
  reserveBudgetCall(running, 'prior:initial', 'prior', 'initial', true, '2026-10-23T07:50:00.000Z');
  startBudgetCall(running, 'prior:initial', '2026-10-23T07:50:00.000Z');
  const snapshot = JSON.stringify(running);
  assert.throws(() => reserveLightReworkBudget(running, {
    writerTaskId: 'writer', evaluateTaskId: 'evaluate', finalTaskId: null,
    writerMinutes: 12, evaluateMinutes: 9, finalMinutes: 0, now,
  }), /已预留或运行中/);
  assert.equal(JSON.stringify(running), snapshot);

  const reserved = createJobBudget({ maxRounds: 3, maxWriterSessions: 3, maxModelCalls: 5, maxActiveMinutes: 30 });
  reserveBudgetCall(reserved, 'prior:initial', 'prior', 'initial', false, now);
  const reservedSnapshot = JSON.stringify(reserved);
  assert.throws(() => reserveLightReworkBudget(reserved, {
    writerTaskId: 'writer', evaluateTaskId: 'evaluate', finalTaskId: null,
    writerMinutes: 5, evaluateMinutes: 5, finalMinutes: 0, now,
  }), /已预留或运行中/);
  assert.equal(JSON.stringify(reserved), reservedSnapshot);
});

test('Grok 评估只从当前 canonical 日志合成并绑定完整 provenance', () => {
  const result = grokEvaluationVerification({
    spec: spec(), round: round(), taskId: 'evaluate-2', toolLog: [commandLog()],
    manualResults: [{ criterionId: 'AC2', pass: true, note: '人工通过', specRef: 'spec-light', round: 2,
      atCommit: 'commit-2', treeHash: 'tree-2', at: '2026-10-23T08:01:00.000Z' }], now, canonicalMatches: true,
  });
  assert.equal(result?.verdict, 'passed');
  assert.deepEqual(result?.items.map((item) => item.status), ['verified_pass', 'user_pass']);
  assert.deepEqual({ specRef: result?.specRef, atCommit: result?.atCommit, treeHash: result?.treeHash, taskId: result?.taskId, logRange: result?.logRange }, {
    specRef: 'spec-light', atCommit: 'commit-2', treeHash: 'tree-2', taskId: 'evaluate-2', logRange: { from: 7, to: 7 },
  });
});

test('缺命令或模型自报 pass 不会制造通过，返回当前 not_observed 证据', () => {
  const oldPassed = grokEvaluationVerification({
    spec: spec(), round: round(), taskId: 'evaluate-2', toolLog: [commandLog()],
    manualResults: [{ criterionId: 'AC2', pass: true, note: null, specRef: 'spec-light', round: 2,
      atCommit: 'commit-2', treeHash: 'tree-2', at: '2026-10-23T08:01:00.000Z' }], now, canonicalMatches: true,
  })!;
  const selfReportedPass = { verdict: 'pass', acceptance: [{ criterionId: 'AC1', status: 'pass', evidence: 'model says pass' }] } as never;
  const result = grokEvaluationVerification({
    spec: spec(), round: round({ verification: oldPassed, evaluation: selfReportedPass }), taskId: 'evaluate-2', toolLog: [],
    manualResults: [], now, canonicalMatches: true,
  });
  assert.equal(result?.verdict, 'inconclusive');
  assert.equal(result?.items[0]?.status, 'not_observed');
  assert.equal(result?.items[1]?.status, 'awaiting_user');
  assert.equal(result?.logRange, null);
  assert.deepEqual(result?.selfReportMismatches, []);
});

test('Grok 评估的 binding/integrity/文件变更门禁全部 fail closed', () => {
  const base = { spec: spec(), round: round(), taskId: 'evaluate-2', toolLog: [commandLog()], manualResults: [], now, canonicalMatches: true };
  for (const input of [
    { ...base, round: round({ writer: 'sol' }) },
    { ...base, taskId: 'old-evaluate' },
    { ...base, round: round({ workspaceCommit: null }) },
    { ...base, round: round({ treeHash: null }) },
    { ...base, round: round({ reviewIntegrity: { ok: false, errors: ['drift'] } }) },
    { ...base, round: round({ reviewIntegrity: { ok: true, errors: ['contradiction'] } }) },
    { ...base, round: round({ staleReason: 'anchor drift' }) },
    { ...base, round: round({ lightRework: undefined }) },
    { ...base, round: round({ lightRework: { ...round().lightRework!, reservedEvaluateTaskId: 'other' } }) },
    { ...base, round: round({ lightRework: { ...round().lightRework!, capabilityRef: '' } }) },
    { ...base, round: round({ lightRework: { ...round().lightRework!, evaluateMinutes: 0 } }) },
    { ...base, round: round({ lightRework: { ...round().lightRework!, finalMinutes: 0 } }) },
    { ...base, canonicalMatches: false },
    { ...base, toolLog: [commandLog(), commandLog({ seq: 8, type: 'file_change', command: null, exitCode: null, output: null, paths: ['src/a.ts'] })] },
  ]) assert.equal(grokEvaluationVerification(input), null);

  const failed = grokEvaluationVerification({ ...base, toolLog: [commandLog({ exitCode: 1, output: 'failed' })] });
  assert.equal(failed?.verdict, 'failed');
  assert.equal(failed?.items[0]?.status, 'verified_fail');
});

test('人工结果必须绑定当前规格、轮次、提交、树且不早于轮次创建时间', () => {
  const matching = { criterionId: 'AC2', pass: true, note: 'ok', specRef: 'spec-light', round: 2,
    atCommit: 'commit-2', treeHash: 'tree-2', at: '2026-10-23T08:01:00.000Z' };
  for (const manualResults of [
    [{ criterionId: 'AC2', pass: true, note: 'legacy' }],
    [{ ...matching, specRef: 'old' }], [{ ...matching, round: 1 }], [{ ...matching, atCommit: 'old' }],
    [{ ...matching, treeHash: 'old' }], [{ ...matching, at: '2026-10-23T07:59:59.000Z' }],
  ]) {
    const result = grokEvaluationVerification({ spec: spec(), round: round(), taskId: 'evaluate-2', toolLog: [commandLog()], manualResults, now, canonicalMatches: true });
    assert.equal(result?.items[1]?.status, 'awaiting_user');
  }
  const accepted = grokEvaluationVerification({ spec: spec(), round: round(), taskId: 'evaluate-2', toolLog: [commandLog()], manualResults: [matching], now, canonicalMatches: true });
  assert.equal(accepted?.items[1]?.status, 'user_pass');
});
