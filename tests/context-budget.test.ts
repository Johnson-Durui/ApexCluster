import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONTEXT_BUDGET,
  FINAL_VERIFICATION_RESERVE_MINUTES,
  PlanOutputZ,
  buildDispatchMaterial,
  decideResume,
  deriveMilestoneStatus,
  renderHandoff,
  smallMilestonePlan,
  unknownContext,
  validateMilestonePlan,
  type ContextBudgetOptions,
  type DispatchMaterialSection,
  type MilestonePlan,
} from '../src/core/context-budget.js';
import { toStrictJsonSchema } from '../src/core/strict-json-schema.js';
import type { MvpSpec, VerificationResult } from '../src/core/types.js';

const testRoot = path.resolve('.test-tmp');

function fixture(): { workspace: string; outside: string; cleanup(): void } {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(path.join(testRoot, 'context-budget-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export {};\n');
  return { workspace, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function spec(patch: Partial<MvpSpec> = {}): MvpSpec {
  return {
    ref: 'spec-t12',
    candidateId: 'C1',
    goal: '分里程碑实现',
    scopeIn: [],
    scopeOut: [],
    acceptance: [
      { id: 'AC1', description: 'build', kind: 'command', command: 'npm run build', expectExitCode: 0, outputIncludes: null },
      { id: 'AC2', description: 'manual', kind: 'manual', command: null, expectExitCode: null, outputIncludes: null },
    ],
    hypotheses: [],
    timeboxMinutes: 60,
    allowNetwork: false,
    comparisonQuestions: [],
    ...patch,
  };
}

function options(patch: Partial<ContextBudgetOptions> = {}): ContextBudgetOptions {
  return { ...DEFAULT_CONTEXT_BUDGET, contextWindows: { ...DEFAULT_CONTEXT_BUDGET.contextWindows }, enabled: true, ...patch };
}

function validPlan(): MilestonePlan {
  return {
    specRef: 'spec-t12',
    milestones: [
      { id: 'M1', title: '实现', acceptanceIds: ['AC1'], dependsOn: [], paths: ['src/app.ts'], minutes: 20 },
      { id: 'M2', title: '人工核对', acceptanceIds: ['AC2'], dependsOn: ['M1'], paths: ['src/new/view.ts'], minutes: 10 },
    ],
    notes: [],
  };
}

test('默认上下文配置关闭且所有完整型号窗口均为 null', () => {
  assert.equal(DEFAULT_CONTEXT_BUDGET.enabled, false);
  assert.deepEqual(Object.values(DEFAULT_CONTEXT_BUDGET.contextWindows), [null, null, null, null]);
  assert.equal(DEFAULT_CONTEXT_BUDGET.softRatio, 0.6);
  assert.equal(DEFAULT_CONTEXT_BUDGET.promptMaxRatio, 0.25);
  assert.equal(DEFAULT_CONTEXT_BUDGET.compactRatio, 0.85);
  assert.equal(DEFAULT_CONTEXT_BUDGET.resumeMaxRatio, 0.5);
  assert.equal(DEFAULT_CONTEXT_BUDGET.charsPerToken, 2.5);
  assert.equal(DEFAULT_CONTEXT_BUDGET.milestoneMaxMinutes, 35);
  assert.equal(DEFAULT_CONTEXT_BUDGET.maxMilestones, 12);
  assert.equal(FINAL_VERIFICATION_RESERVE_MINUTES, 1);
});

test('PlanOutputZ 可转换为严格 JSON Schema，范围交给语义校验', () => {
  assert.doesNotThrow(() => toStrictJsonSchema(PlanOutputZ));
  assert.equal(PlanOutputZ.safeParse({ ...validPlan(), extra: true }).success, false);
  assert.equal(PlanOutputZ.safeParse({ ...validPlan(), milestones: [{ ...validPlan().milestones[0], minutes: 1.5 }] }).success, true);
});

test('合法计划覆盖每项验收一次、允许不存在文件的安全父目录并预留最终验收调用', () => {
  const f = fixture();
  try {
    assert.deepEqual(validateMilestonePlan(validPlan(), {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 45 * 60_000,
    }), []);
  } finally { f.cleanup(); }
});

test('计划总 minutes 可等于扣除最终验收预留后的预算，但不能占用预留本身', () => {
  const f = fixture();
  try {
    const equal = validPlan();
    equal.milestones[0]!.minutes = 29;
    equal.milestones[1]!.minutes = 30;
    assert.deepEqual(validateMilestonePlan(equal, {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 60 * 60_000,
    }), []);
    equal.milestones[0]!.minutes = 30;
    assert.match(validateMilestonePlan(equal, {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 60 * 60_000,
    }).join('\n'), /计划总时长 60 分钟超过.*59 分钟/);

    const activeBound = validPlan();
    assert.deepEqual(validateMilestonePlan(activeBound, {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 31 * 60_000,
    }), []); // 30 分钟计划 + 1 分钟最终验收预留。
  } finally { f.cleanup(); }
});

test('计划拒绝规格错配、重复/漏/未知验收、重复 ID、非法整数和调用/时间超预算', () => {
  const f = fixture();
  try {
    const plan = validPlan();
    plan.specRef = 'old-spec';
    plan.milestones[1]!.id = ' M1 ';
    plan.milestones[0]!.acceptanceIds = ['AC1', 'AC1', 'UNKNOWN'];
    plan.milestones[1]!.acceptanceIds = [];
    plan.milestones[0]!.minutes = 1.5;
    const errors = validateMilestonePlan(plan, {
      spec: spec(), workspaceDir: f.workspace, options: options({ maxMilestones: 1 }), remainingCalls: 1, remainingActiveMs: 5 * 60_000,
    }).join('\n');
    assert.match(errors, /specRef/);
    assert.match(errors, /ID 必须唯一/);
    assert.match(errors, /首尾空白/);
    assert.match(errors, /acceptanceIds 不得重复/);
    assert.match(errors, /未知验收项/);
    assert.match(errors, /AC2 必须且只能/);
    assert.match(errors, /正安全整数/);
    assert.match(errors, /里程碑数量超过上限/);
    assert.match(errors, /计划总时长/);
    assert.match(errors, /预留 1 次最终整轮验收/);
  } finally { f.cleanup(); }
});

test('计划拒绝不存在依赖、自依赖和跨节点依赖环', () => {
  const f = fixture();
  try {
    const missing = validPlan();
    missing.milestones[1]!.dependsOn = ['M404'];
    assert.match(validateMilestonePlan(missing, {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 60 * 60_000,
    }).join('\n'), /依赖不存在/);

    const cyclic = validPlan();
    cyclic.milestones[0]!.dependsOn = ['M2'];
    assert.match(validateMilestonePlan(cyclic, {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 60 * 60_000,
    }).join('\n'), /无环/);

    const self = validPlan();
    self.milestones[0]!.dependsOn = ['M1'];
    assert.match(validateMilestonePlan(self, {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 60 * 60_000,
    }).join('\n'), /不能依赖自身/);
  } finally { f.cleanup(); }
});

test('路径校验拒绝绝对路径和词法越界', () => {
  const f = fixture();
  try {
    const unsafePaths = ['../outside/file.ts', path.resolve(f.outside, 'file.ts')];
    if (process.platform === 'win32') unsafePaths.push('src/app.ts:secret');
    for (const unsafe of unsafePaths) {
      const plan = validPlan();
      plan.milestones[0]!.paths = [unsafe];
      assert.match(validateMilestonePlan(plan, {
        spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 60 * 60_000,
      }).join('\n'), /工作区|盘符|备用数据流/);
    }
  } finally { f.cleanup(); }
});

test('路径校验拒绝符号链接逃逸', t => {
  const f = fixture();
  try {
    const link = path.join(f.workspace, 'linked');
    try { symlinkSync(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { return t.skip('当前环境不允许创建测试符号链接/目录联接'); }
    const plan = validPlan();
    plan.milestones[0]!.paths = ['linked/new.ts'];
    assert.match(validateMilestonePlan(plan, {
      spec: spec(), workspaceDir: f.workspace, options: options(), remainingCalls: 3, remainingActiveMs: 60 * 60_000,
    }).join('\n'), /符号链接解析后逃逸/);
  } finally { f.cleanup(); }
});

test('小任务单流程且验收不超过三项时跳过 init', () => {
  assert.equal(smallMilestonePlan(spec(), 2), null);
  assert.equal(smallMilestonePlan(spec({ acceptance: [...spec().acceptance, ...spec().acceptance] }), 1), null);
  const plan = smallMilestonePlan(spec(), 1)!;
  assert.equal(plan.milestones.length, 1);
  assert.deepEqual(plan.milestones[0]!.acceptanceIds, ['AC1', 'AC2']);
  assert.equal(plan.milestones[0]!.paths[0], '.');
  assert.equal(smallMilestonePlan(spec({ timeboxMinutes: 20 }), 1)!.milestones[0]!.minutes, 19);
});

test('unknownContext 原样保留 raw usage，unknown/null 不伪装成零', () => {
  const raw = { input_tokens: 12, cache_read: 8 };
  assert.deepEqual(unknownContext(raw), {
    usageRaw: raw, usageSource: null, usageSemantics: 'unknown', contextWindow: null,
    contextTokensPeak: null, contextRatioPeak: null, compactions: null,
  });
});

test('续接仅在 per_turn_context、已知窗口、峰值低于阈值、观测零压缩且预算充分时允许', () => {
  const base = {
    usageRaw: { input_tokens: 60_000 }, usageSource: 'fake-cli-event', usageSemantics: 'per_turn_context' as const,
    contextWindow: 200_000, contextTokensPeak: 60_000, contextRatioPeak: 0.3, compactions: 0,
  };
  const input = { policy: 'budgeted' as const, threadId: 'thread-1', remainingCalls: 2, remainingActiveMs: 60_000, promptEstimateTokens: 10_000 };
  assert.equal(decideResume(options(), base, input).resumeSessionId, 'thread-1');
  const denied = [
    { ...base, usageSemantics: 'cumulative' as const },
    { ...base, usageSemantics: 'unknown' as const },
    { ...base, contextWindow: null },
    { ...base, contextRatioPeak: 0.5 },
    { ...base, compactions: null },
    { ...base, compactions: 1 },
  ];
  for (const observation of denied) assert.equal(decideResume(options(), observation, input).resumeSessionId, null);
  assert.equal(decideResume(options(), base, { ...input, remainingCalls: 0 }).resumeSessionId, null);
  assert.equal(decideResume(options(), base, { ...input, remainingActiveMs: 0 }).resumeSessionId, null);
  assert.equal(decideResume(options(), base, { ...input, promptEstimateTokens: 60_000 }).resumeSessionId, null);
  assert.equal(decideResume(options({ enabled: false }), base, input).resumeSessionId, null);
});

function material(id: string, size: number): DispatchMaterialSection {
  return { id, sourcePath: `records/${id}.md`, content: id.repeat(size) };
}

test('派发材料按固定顺序裁剪 optional，保留钉死块和稳定来源记录', () => {
  const result = buildDispatchMaterial({
    pinnedOriginal: [material('PIN', 25)], required: [material('REQ', 10)], current: [material('CUR', 10)],
    rawCommandExcerpts: [material('RAW', 50)], oldReports: [material('REPORT', 50)],
    oldDocuments: [material('DOC', 50)], digestCommands: [material('DIGEST', 50)],
    options: options({ charsPerToken: 1, promptMaxRatio: 0.002 }), contextWindow: 200_000,
  });
  assert.ok(result.omitted.length > 0);
  assert.deepEqual(result.omitted.map(item => item.id).slice(0, 4), ['RAW', 'REPORT', 'DOC', 'DIGEST']);
  assert.match(result.text, /PIN/);
  assert.match(result.text, /records\/RAW\.md/);
  assert.equal(result.estimateReference, 'observed-window');
});

test('未知窗口仅使用标记过的 200k 估算参考，过大的钉死块导致 blocked 而不被裁剪', () => {
  const pinned = material('PINNED-ORIGINAL', 10_000);
  const result = buildDispatchMaterial({
    pinnedOriginal: [pinned], required: [], current: [], rawCommandExcerpts: [], oldReports: [], oldDocuments: [], digestCommands: [],
    options: options({ charsPerToken: 1, promptMaxRatio: 0.01 }), contextWindow: null,
  });
  assert.equal(result.estimateReference, 'estimate-reference-200000');
  assert.equal(result.contextRatio, null);
  assert.equal(result.blocked, true);
  assert.match(result.text, /PINNED-ORIGINAL/);
});

test('HANDOFF 明确区分程序事实和模型笔记；超过 200 行只告警不截断', () => {
  const longNotes = Array.from({ length: 201 }, (_, index) => `line-${index}`).join('\n');
  const rendered = renderHandoff({
    specRef: 'spec-t12', workspaceCommit: 'abc', milestone: { id: 'M1', title: '实现', acceptanceIds: ['AC1'] },
    pinnedConstraints: [{ id: 'HC1', text: '禁止联网', sourcePath: 'MVP_SPEC.md' }],
    programFacts: ['当前代码已绑定 abc'], verification: ['AC1 尚未运行'],
    defects: [{ id: 'D1', text: '真实失败', source: 'evaluation.json' }],
    modelNotes: { author: 'gpt-6.1-sol', sourcePath: 'PROGRESS.md', content: longNotes },
  });
  assert.equal(rendered.warnings.length, 1);
  assert.match(rendered.content, /程序事实/);
  assert.match(rendered.content, /不是当前指令或程序验证事实/);
  assert.match(rendered.content, /line-200/);
});

function verification(statuses: VerificationResult['items']): Pick<VerificationResult, 'items' | 'staleReason'> {
  return { items: statuses, staleReason: null };
}

test('里程碑状态只由程序核验项推导，失败优先且人工项不会变为通过', () => {
  const item = (criterionId: string, status: VerificationResult['items'][number]['status']) => ({
    criterionId, status, matchedCommand: null, exitCode: null, outputExcerpt: null, note: '',
  });
  assert.equal(deriveMilestoneStatus(['AC1'], verification([item('AC1', 'verified_pass')])), 'passed');
  assert.equal(deriveMilestoneStatus(['AC1', 'AC2'], verification([item('AC1', 'verified_pass'), item('AC2', 'awaiting_user')])), 'awaiting_manual');
  assert.equal(deriveMilestoneStatus(['AC1', 'AC2'], verification([item('AC1', 'awaiting_user'), item('AC2', 'verified_fail')])), 'failed');
  assert.equal(deriveMilestoneStatus(['AC1'], verification([item('AC1', 'not_observed')])), 'pending');
  assert.equal(deriveMilestoneStatus(['AC1'], { ...verification([item('AC1', 'verified_pass')]), staleReason: '代码已变化' }), 'pending');
  assert.equal(deriveMilestoneStatus(['AC1'], verification([item('AC1', 'verified_pass'), item('AC1', 'verified_pass')])), 'pending');
});
