import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mockOutput } from '../src/adapters/mock-scenarios.js';
import type { ModelTaskSpec, TaskContext } from '../src/adapters/types.js';
import { checkDigest, checkQgroup, type ChoreSource } from '../src/core/chores.js';
import { DEFAULT_CONTEXT_BUDGET, PlanOutputZ, validateMilestonePlan } from '../src/core/context-budget.js';
import { OUTPUT_SCHEMAS, SessionBuildReportOutputZ, type TaskPhase } from '../src/core/schemas.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import type { MvpSpec } from '../src/core/types.js';
import { validateOutput } from '../src/core/validate.js';

const fullSpec: MvpSpec = {
  ref: 'spec-mock-context',
  candidateId: 'candidate-1',
  goal: '验证上下文构建流程',
  scopeIn: ['实现', '验证'],
  scopeOut: [],
  acceptance: [
    { id: 'AC1', description: '自动验收通过', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: 'ok' },
    { id: 'AC2', description: '人工查看页面', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
  ],
  hypotheses: [{ id: 'HY1', text: '测试可运行', passCriteria: '退出码为 0' }],
  timeboxMinutes: 60,
  allowNetwork: false,
  comparisonQuestions: [],
};

function task(phase: TaskPhase, context: Partial<TaskContext>): ModelTaskSpec {
  return {
    taskId: 'task-1', runId: 'run-1', role: 'sol', phase, attempt: 1, model: 'gpt-6.1-sol', effort: 'high', prompt: '',
    outputSchema: toStrictJsonSchema(OUTPUT_SCHEMAS[phase]), cwd: '.', logDir: '.', timeoutMs: 1_000,
    sandbox: 'read_only', allowNetwork: false, gitRepo: false, allowWeb: false, resumeSessionId: null,
    context: {
      snapshotRef: 'snapshot-1', constraintIds: [], criterionIds: [], knownQuestionIds: [], anonymousMap: null,
      recheckItems: null, spec: null, mockScenario: 'preference', ...context,
    },
  };
}

test('Mock T10 digest 逐字引用受控来源，qgroup 恰好覆盖全部问题', () => {
  const sources: ChoreSource[] = [
    { id: 'S1', text: '第一条日志的确切内容。', specRef: fullSpec.ref, workspaceCommit: 'abc123', taskId: 't1', logRange: { from: 1, to: 2 } },
    { id: 'S2', text: '第二条报告的确切内容。', specRef: fullSpec.ref, workspaceCommit: 'abc123', taskId: 't2', logRange: null },
  ];
  const digest = mockOutput(task('digest', { spec: fullSpec, choreSources: sources, workspaceCommit: 'abc123' })).output;
  const digestParsed = OUTPUT_SCHEMAS.digest.parse(digest);
  assert.equal(checkDigest(digestParsed, { specRef: fullSpec.ref, workspaceCommit: 'abc123', sources }).ok, true);
  assert.deepEqual(digestParsed.entries.map(entry => entry.quote), sources.map(source => source.text));

  const grouped = mockOutput(task('qgroup', { choreQuestionIds: ['Q1', 'Q2', 'Q3'] })).output;
  const groupedParsed = OUTPUT_SCHEMAS.qgroup.parse(grouped);
  assert.equal(checkQgroup(groupedParsed, { snapshotRef: 'snapshot-1', questionIds: ['Q1', 'Q2', 'Q3'] }).ok, true);
  assert.deepEqual(groupedParsed.groups.flatMap(group => group.questionIds), ['Q1', 'Q2', 'Q3']);
});

test('Mock T12 init 生成覆盖每项验收的串行合法计划', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'mock-context-'));
  try {
    const raw = mockOutput(task('build', { spec: fullSpec, buildKind: 'init' })).output;
    const plan = PlanOutputZ.parse(raw);
    assert.deepEqual(plan.milestones.map(item => item.acceptanceIds), [['AC1'], ['AC2']]);
    assert.deepEqual(plan.milestones.map(item => item.dependsOn), [[], ['M1']]);
    assert.deepEqual(validateMilestonePlan(plan, {
      spec: fullSpec, workspaceDir: workspace, options: { ...DEFAULT_CONTEXT_BUDGET }, remainingCalls: 3, remainingActiveMs: 60 * 60_000,
    }), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Mock T12 milestone 只报告当前有效验收，扩展字段不被基础 build 校验拒绝', () => {
  const effective: MvpSpec = { ...fullSpec, acceptance: [fullSpec.acceptance[0]!] };
  const product = mockOutput(task('build', {
    spec: effective, buildKind: 'milestone', buildSession: { id: 'BS1', milestoneIds: ['M1'] }, finalVerification: false,
  }));
  const report = SessionBuildReportOutputZ.parse(product.output);
  assert.deepEqual(report.acceptanceResults.map(item => item.criterionId), ['AC1']);
  assert.deepEqual(report.milestoneResults.map(item => item.milestoneId), ['M1']);
  assert.ok(product.toolLog.some(item => item.type === 'file_change'));
  const base = validateOutput('build', product.output, {
    specRef: fullSpec.ref, acceptanceIds: ['AC1'], hypothesisIds: ['HY1'], maxQuestions: 12,
  });
  assert.equal(base.ok, true, base.errors.join('; '));
});

test('Mock T12 最终整轮验收覆盖完整 spec 且不伪造文件修改', () => {
  const product = mockOutput(task('build', {
    spec: fullSpec, buildKind: 'milestone', buildSession: { id: 'BS-final', milestoneIds: ['M1', 'M2'] }, finalVerification: true,
  }));
  const report = SessionBuildReportOutputZ.parse(product.output);
  assert.deepEqual(report.acceptanceResults.map(item => item.criterionId), ['AC1', 'AC2']);
  assert.equal(product.toolLog.some(item => item.type === 'file_change'), false);
  assert.deepEqual(report.builtComponents, []);
});

test('未提供 buildKind 时保留常规 BuildReport 输出', () => {
  const product = mockOutput(task('build', { spec: fullSpec }));
  const report = OUTPUT_SCHEMAS.build.parse(product.output);
  assert.equal(report.specRef, fullSpec.ref);
  assert.equal('milestoneResults' in (product.output as object), false);
  assert.ok(product.toolLog.some(item => item.type === 'file_change'));
});
