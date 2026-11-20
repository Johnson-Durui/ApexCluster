import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEvaluation,
  checkFinalReview,
  evaluationVerification,
  reproducibleDefectIds,
} from '../src/core/build-review.js';
import { EvaluationOutputZ, FinalReviewOutputZ, type EvaluationOutput, type FinalReviewOutput } from '../src/core/schemas.js';
import type { BuildRound, MvpSpec, VerificationResult } from '../src/core/types.js';
import type { ToolLogItem } from '../src/core/verify-mvp.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import { unknownContext } from '../src/core/context-budget.js';

const now = '2026-10-23T08:00:00.000Z';

test('评审输出可转换严格 JSON Schema；数值边界由语义检查拒绝', () => {
  assert.doesNotThrow(() => toStrictJsonSchema(EvaluationOutputZ));
  assert.doesNotThrow(() => toStrictJsonSchema(FinalReviewOutputZ));
  for (const round of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(checkEvaluation(evaluation({ round }), { ...evaluationContext, round }).join('\n'), /正整数/);
    assert.match(checkFinalReview(finalReview({ roundsReviewed: [round] }), { ...finalContext, rounds: [{ round, defectIds: [] }] }).join('\n'), /正整数/);
  }
  for (const logSeq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = evaluation();
    value.defects[0]!.reproduction.logSeq = logSeq;
    assert.match(checkEvaluation(value, evaluationContext).join('\n'), /logSeq/);
  }
});

test('工具不显示内部序号时由真实日志定位，后续成功复跑使旧失败无效', () => {
  const value = evaluation();
  value.defects[0]!.reproduction.logSeq = null;
  assert.deepEqual(reproducibleDefectIds(spec(), value, [logItem({ seq: 7 })], true), ['D1']);
  assert.deepEqual(reproducibleDefectIds(spec(), value, [logItem({ seq: 7 }), logItem({ seq: 8, exitCode: 0, output: 'passed' })], true), []);
  value.defects[0]!.reproduction.logSeq = 7;
  assert.deepEqual(reproducibleDefectIds(spec(), value, [logItem({ seq: 7 }), logItem({ seq: 8, exitCode: 0, output: 'passed' })], true), []);
});

function spec(): MvpSpec {
  return {
    ref: 'spec-abc',
    candidateId: 'C1',
    goal: 'verify review boundaries',
    scopeIn: [],
    scopeOut: [],
    acceptance: [
      { id: 'AC1', description: 'tests', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: 'passed' },
      { id: 'AC2', description: 'manual check', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
    ],
    hypotheses: [],
    timeboxMinutes: 10,
    allowNetwork: false,
    comparisonQuestions: [],
  };
}

function evaluation(patch: Partial<EvaluationOutput> = {}): EvaluationOutput {
  return {
    specRef: 'spec-abc',
    round: 1,
    workspaceCommit: 'commit-1',
    verdict: 'fail',
    acceptance: [
      { criterionId: 'AC1', status: 'fail', evidence: 'log 3' },
      { criterionId: 'AC2', status: 'awaiting_manual', evidence: 'waiting' },
    ],
    defects: [{
      id: 'D1',
      criterionIds: ['AC1'],
      severity: 'major',
      failureClass: 'implementation_defect',
      location: 'src/app.ts:12',
      evidence: 'npm test failed after the last change',
      reproduction: { command: 'npm test', logSeq: 3, expectedExitCode: 0, outputIncludes: 'passed' },
      fix: 'repair implementation',
    }],
    reworkBrief: [{ defectIds: ['D1'], instructions: 'Fix D1 only.' }],
    environmentIssues: [],
    deviationsNoted: [],
    questions: [],
    ...patch,
  };
}

function finalReview(patch: Partial<FinalReviewOutput> = {}): FinalReviewOutput {
  return {
    specRef: 'spec-abc',
    workspaceCommit: 'commit-1',
    roundsReviewed: [1, 2],
    verdict: 'accept_with_notes',
    summary: 'reviewed',
    findings: [{ round: 1, defectIds: ['D1'], severity: 'minor', text: 'D1 was corrected' }],
    frameworkCompliance: 'compliant',
    reworkNotes: [],
    questions: [],
    ...patch,
  };
}

const evaluationContext = { specRef: 'spec-abc', acceptanceIds: ['AC1', 'AC2'], round: 1, workspaceCommit: 'commit-1' };
const finalContext = {
  specRef: 'spec-abc',
  workspaceCommit: 'commit-1',
  rounds: [{ round: 1, defectIds: ['D1'] }, { round: 2, defectIds: ['D2'] }],
};

function logItem(patch: Partial<ToolLogItem> = {}): ToolLogItem {
  return {
    seq: 3,
    type: 'command_execution',
    command: 'npm test',
    exitCode: 1,
    output: 'failed',
    status: 'failed',
    paths: [],
    ...patch,
  };
}

function verification(items: VerificationResult['items'], verdict: VerificationResult['verdict']): VerificationResult {
  return { verdict, items, selfReportMismatches: [], computedAt: now };
}

function round(baseVerification: VerificationResult | null): BuildRound {
  return {
    round: 1,
    kind: 'initial',
    writer: 'sol',
    buildTaskId: 'build-1',
    evaluateTaskId: 'evaluate-1',
    report: null,
    verification: baseVerification,
    evaluation: null,
    workspaceCommit: 'commit-1',
    treeHash: 'tree-1',
    baselineCommit: 'base-1',
    fileTree: [],
    diffStat: '',
    reviewWorkspace: null,
    reviewIntegrity: null,
    verifiedDefectIds: [],
    reworkBrief: [],
    outcome: 'pending',
    staleReason: null,
    stoppedReason: null,
    createdAt: now,
    endedAt: null,
  };
}

function withFinalVerification(current: BuildRound, writer: VerificationResult): BuildRound {
  current.context = {
    plan: null, planHash: null, planPath: '', states: [], dispatchBlocked: null,
    sessions: [{ id: 'final', kind: 'milestone', milestoneIds: [], finalVerification: true,
      taskId: 'build-1', startCommit: 'commit-1', endCommit: 'commit-1', threadId: null,
      resumedFrom: null, resumeReason: '', handoffPath: null, verification: writer,
      outcome: writer.verdict === 'failed' ? 'failed' : 'passed', context: unknownContext(),
      startedAt: now, endedAt: now }],
  };
  return current;
}

test('评审 schema 拒绝缺少契约字段的输出', () => {
  const missing = { ...evaluation() } as Record<string, unknown>;
  delete missing.workspaceCommit;
  assert.equal(EvaluationOutputZ.safeParse(missing).success, false);

  const missingFinal = { ...finalReview() } as Record<string, unknown>;
  delete missingFinal.roundsReviewed;
  assert.equal(FinalReviewOutputZ.safeParse(missingFinal).success, false);
});

test('评审验收项必须恰好覆盖：漏项、重复和未知编号均拒绝', () => {
  const cases: EvaluationOutput['acceptance'][] = [
    [{ criterionId: 'AC1', status: 'fail', evidence: 'x' }],
    [
      { criterionId: 'AC1', status: 'fail', evidence: 'x' },
      { criterionId: 'AC1', status: 'fail', evidence: 'again' },
    ],
    [
      { criterionId: 'AC1', status: 'fail', evidence: 'x' },
      { criterionId: 'UNKNOWN', status: 'pass', evidence: 'x' },
    ],
  ];
  for (const acceptance of cases) {
    assert.match(checkEvaluation(evaluation({ acceptance }), evaluationContext).join('\n'), /恰好覆盖/);
  }
});

test('评审必须绑定当前规格、轮次和代码提交', () => {
  const errors = checkEvaluation(evaluation({ specRef: 'old', round: 9, workspaceCommit: 'old-commit' }), evaluationContext);
  assert.match(errors.join('\n'), /specRef/);
  assert.match(errors.join('\n'), /round/);
  assert.match(errors.join('\n'), /workspaceCommit/);
});

test('重复缺陷、不安全位置以及引用未知缺陷的返工简报均拒绝', () => {
  const duplicate = evaluation().defects[0]!;
  assert.match(checkEvaluation(evaluation({ defects: [duplicate, { ...duplicate }] }), evaluationContext).join('\n'), /唯一/);
  for (const location of ['../outside.ts', 'C:\\outside.ts', '/etc/passwd', '~/.config']) {
    const defects = [{ ...duplicate, location }];
    assert.match(checkEvaluation(evaluation({ defects }), evaluationContext).join('\n'), /工作区内位置/);
  }
  assert.match(
    checkEvaluation(evaluation({ reworkBrief: [{ defectIds: ['D404'], instructions: 'guess' }] }), evaluationContext).join('\n'),
    /本次存在的缺陷/,
  );
});

test('终审拒绝未知/遗漏/重复轮次、未知缺陷，并要求 reject 给出意见', () => {
  for (const roundsReviewed of [[1], [1, 1], [1, 3]]) {
    assert.match(checkFinalReview(finalReview({ roundsReviewed }), finalContext).join('\n'), /全部构建轮次/);
  }
  assert.match(
    checkFinalReview(finalReview({ findings: [{ round: 2, defectIds: ['D404'], severity: 'major', text: 'unknown' }] }), finalContext).join('\n'),
    /本作业的轮次和缺陷/,
  );
  assert.match(
    checkFinalReview(finalReview({ verdict: 'reject', findings: [], reworkNotes: [] }), finalContext).join('\n'),
    /reject 必须给出意见/,
  );
});

test('模型 pass 不能覆盖程序失败或人工待验', () => {
  const base = verification([
    { criterionId: 'AC1', status: 'verified_fail', matchedCommand: 'npm test', exitCode: 1, outputExcerpt: 'failed', note: '' },
    { criterionId: 'AC2', status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: 'waiting' },
  ], 'failed');
  const result = evaluationVerification(spec(), round(base), [logItem({ exitCode: 0, output: 'passed' })], [], now);
  assert.equal(result.items.find(item => item.criterionId === 'AC1')!.status, 'verified_fail');
  assert.equal(result.items.find(item => item.criterionId === 'AC2')!.status, 'awaiting_user');
  assert.equal(result.verdict, 'failed');

  const manualOnly = verification([
    { criterionId: 'AC1', status: 'verified_pass', matchedCommand: 'npm test', exitCode: 0, outputExcerpt: 'passed', note: '' },
    { criterionId: 'AC2', status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: 'waiting' },
  ], 'awaiting_manual');
  assert.equal(evaluationVerification(spec(), round(manualOnly), [logItem({ exitCode: 0, output: 'passed' })], [], now).verdict, 'awaiting_manual');
});

test('可复现缺陷必须有匹配日志、正确序号/命令/退出码，并发生在最后修改之后', () => {
  const value = evaluation({ verdict: 'cannot_verify' });
  const cases: ToolLogItem[][] = [
    [],
    [logItem({ seq: 4 })],
    [logItem({ command: 'npm run lint' })],
    [logItem({ exitCode: null })],
    [logItem({ seq: 3 }), logItem({ seq: 4, type: 'file_change', command: null, exitCode: null })],
  ];
  for (const log of cases) assert.deepEqual(reproducibleDefectIds(spec(), value, log, true), []);
  assert.deepEqual(reproducibleDefectIds(spec(), value, [logItem()], false), []);
});

test('模型伪造 expectedExitCode 不能改变规格，命令输出也必须满足规格失败证据', () => {
  const spoofed = evaluation();
  spoofed.defects[0]!.reproduction.expectedExitCode = 1;
  assert.deepEqual(reproducibleDefectIds(spec(), spoofed, [logItem()], true), []);

  const wrongOutput = evaluation();
  wrongOutput.defects[0]!.reproduction.outputIncludes = 'not in log';
  assert.deepEqual(reproducibleDefectIds(spec(), wrongOutput, [logItem()], true), []);
});

test('cannot_verify 只有绑定当前副本的真实失败证据才产生 verifiedIds', () => {
  const value = evaluation({ verdict: 'cannot_verify' });
  assert.deepEqual(reproducibleDefectIds(spec(), value, [], true), []);
  assert.deepEqual(reproducibleDefectIds(spec(), value, [logItem()], true), ['D1']);
});

test('真实溢出复现：期望标记绑定规格，失败日志无需含成功标记', () => {
  const current = spec();
  current.acceptance[0] = { id: 'AC1', description: 'overflow', kind: 'command', command: 'node check-invalid.mjs', expectExitCode: 0, outputIncludes: 'INVALID_OK' };
  const value = evaluation();
  value.defects[0]!.reproduction = { command: 'node check-invalid.mjs', logSeq: null, expectedExitCode: 0, outputIncludes: 'INVALID_OK' };
  const actual = logItem({ seq: 6, command: 'node check-invalid.mjs', exitCode: 1, output: 'AssertionError: Missing expected exception (RangeError).' });
  assert.deepEqual(reproducibleDefectIds(current, value, [actual], true), ['D1']);
  assert.deepEqual(reproducibleDefectIds(current, value, [{ ...actual, exitCode: 0, output: '' }], true), ['D1']);
  assert.deepEqual(reproducibleDefectIds(current, value, [{ ...actual, exitCode: 0, output: 'INVALID_OK' }], true), []);
  value.defects[0]!.reproduction.outputIncludes = 'Missing expected exception';
  assert.deepEqual(reproducibleDefectIds(current, value, [actual], true), []);
});

test('规格未要求输出时只核对退出码，模型不能自行加入输出约束', () => {
  const current = spec();
  current.acceptance[0]!.outputIncludes = null;
  const value = evaluation();
  value.defects[0]!.reproduction.outputIncludes = null;
  assert.deepEqual(reproducibleDefectIds(current, value, [logItem()], true), ['D1']);
  assert.deepEqual(reproducibleDefectIds(current, value, [logItem({ exitCode: 0 })], true), []);
  value.defects[0]!.reproduction.outputIncludes = 'failed';
  assert.deepEqual(reproducibleDefectIds(current, value, [logItem()], true), []);
});

test('评审再次失败保留原写者失败及其日志来源', () => {
  const base = verification([
    { criterionId: 'AC1', status: 'verified_fail', matchedCommand: 'npm test', exitCode: 1, outputExcerpt: 'writer failure', note: '' },
    { criterionId: 'AC2', status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: 'waiting' },
  ], 'failed');
  base.taskId = 'build-1';
  base.logRange = { from: 0, to: 4 };
  const result = evaluationVerification(spec(), withFinalVerification(round(base), base), [logItem({ output: 'reviewer failure' })], [], now);
  assert.equal(result.items[0]!.outputExcerpt, 'writer failure');
  assert.equal(result.items[0]!.evidenceTaskId, 'build-1');
  assert.equal(result.taskId, 'build-1');
  assert.deepEqual(result.logRange, base.logRange);
});

test('评审新增失败时逐项绑定来源，不冒称整份结果来自写者日志', () => {
  const current = spec();
  current.acceptance.push({ id: 'AC3', description: 'other', kind: 'command', command: 'npm run other', expectExitCode: 0, outputIncludes: null });
  const base = verification([
    { criterionId: 'AC1', status: 'verified_pass', matchedCommand: 'npm test', exitCode: 0, outputExcerpt: 'writer passed', note: '' },
    { criterionId: 'AC2', status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: 'waiting' },
    { criterionId: 'AC3', status: 'verified_pass', matchedCommand: 'npm run other', exitCode: 0, outputExcerpt: 'writer other passed', note: '' },
  ], 'awaiting_manual');
  base.taskId = 'build-1';
  base.logRange = { from: 0, to: 4 };
  const result = evaluationVerification(current, withFinalVerification(round(base), base), [logItem({ command: 'npm run other', output: 'reviewer failure' })], [], now);
  assert.equal(result.verdict, 'failed');
  assert.equal(result.items[0]!.evidenceTaskId, 'build-1');
  assert.equal(result.items[2]!.evidenceTaskId, 'evaluate-1');
  assert.equal(result.items[2]!.outputExcerpt, 'reviewer failure');
  assert.equal(result.taskId, undefined);
  assert.equal(result.logRange, null);
  assert.equal(base.items[2]!.status, 'verified_pass');
});

test('旧聚合错标来源时从原始 final session 恢复写者证据', () => {
  const writer = verification([
    { criterionId: 'AC1', status: 'verified_fail', matchedCommand: 'npm test', exitCode: 1, outputExcerpt: 'writer workspace failure', note: '' },
    { criterionId: 'AC2', status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: 'waiting' },
  ], 'failed');
  writer.taskId = 'build-1';
  writer.logRange = { from: 1, to: 4 };
  const legacy = structuredClone(writer);
  legacy.items[0]!.outputExcerpt = 'old reviewer clone failure';
  legacy.computedAt = '2026-10-23T08:01:00.000Z';
  const result = evaluationVerification(spec(), withFinalVerification(round(legacy), writer), [logItem({ output: 'new reviewer failure' })], [], now);
  assert.equal(result.items[0]!.outputExcerpt, 'writer workspace failure');
  assert.equal(result.items[0]!.evidenceTaskId, 'build-1');
  assert.equal(result.taskId, 'build-1');
  assert.deepEqual(result.logRange, writer.logRange);
  assert.equal(legacy.items[0]!.outputExcerpt, 'old reviewer clone failure');
  assert.equal(writer.items[0]!.evidenceTaskId, undefined);
});

test('没有原始 session 的旧聚合不从顶层 taskId 猜测证据来源', () => {
  const legacy = verification([
    { criterionId: 'AC1', status: 'verified_fail', matchedCommand: 'npm test', exitCode: 1, outputExcerpt: 'unknown source failure', note: '' },
    { criterionId: 'AC2', status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: 'waiting' },
  ], 'failed');
  legacy.taskId = 'build-1';
  legacy.logRange = { from: 0, to: 4 };
  const result = evaluationVerification(spec(), round(legacy), [logItem({ output: 'new reviewer failure' })], [], now);
  assert.equal(result.items[0]!.outputExcerpt, 'unknown source failure');
  assert.equal(result.items[0]!.evidenceTaskId, undefined);
  assert.equal(result.taskId, undefined);
  assert.equal(result.logRange, null);
});

test('重评采用最新人工结果，原始会话的待验状态不能吞掉人工通过或失败', () => {
  const writer = verification([
    { criterionId: 'AC1', status: 'verified_pass', matchedCommand: 'npm test', exitCode: 0, outputExcerpt: 'passed', note: '' },
    { criterionId: 'AC2', status: 'awaiting_user', matchedCommand: null, exitCode: null, outputExcerpt: null, note: 'waiting' },
  ], 'awaiting_manual');
  writer.taskId = 'build-1';
  for (const pass of [true, false]) {
    const result = evaluationVerification(spec(), withFinalVerification(round(writer), writer), [logItem({ exitCode: 0, output: 'passed' })],
      [{ criterionId: 'AC2', pass, note: 'latest user decision' }], now);
    assert.equal(result.verdict, pass ? 'passed' : 'failed');
    assert.equal(result.items[1]!.status, pass ? 'user_pass' : 'user_fail');
    assert.equal(result.items[1]!.evidenceTaskId, undefined);
    assert.equal(result.items[0]!.evidenceTaskId, 'build-1');
    assert.equal(writer.items[1]!.status, 'awaiting_user');
  }
});
