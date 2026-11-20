import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_DECISION_PARAMS, resolveCell, resolveConstraint } from '../src/core/decision-engine.js';
import type { Candidate, Criterion, DesignRole, HardConstraint, Judgment, Origin, Override } from '../src/core/types.js';

const anchors = ['0', '1', '2', '3', '4', '5'];
const criteria: Criterion[] = [
  { id: 'fit', name: '需求适配', weight: 0.3, anchors },
  { id: 'cost', name: '开发与维护成本', weight: 0.25, anchors },
  { id: 'reliability', name: '可靠性与可验证性', weight: 0.25, anchors },
  { id: 'performance', name: '性能与资源成本', weight: 0.1, anchors },
  { id: 'evolution', name: '后续演进', weight: 0.1, anchors },
];
const constraints: HardConstraint[] = [{ id: 'H1', text: '必须在 Windows 本机运行', kind: 'must' }];
type S = [number | null, number | null, number | null, number | null, number | null];

function J(judge: DesignRole, proposalId: string, s: S, h1: 'pass' | 'fail' | 'unknown' = 'pass'): Judgment {
  return {
    judge,
    taskId: `t-${judge}-review-1`,
    designRound: 1,
    proposalId,
    anonymousId: 'P?',
    constraintChecks: [{ constraintId: 'H1', status: h1, rationale: `${judge} 对 H1 的判断`, evidence: [] }],
    scores: criteria.map((c, i) => ({
      criterionId: c.id,
      score: s[i] ?? null,
      rationale: `${judge} 的理由`,
      evidence: s[i] === null ? [] : [{ kind: 'reasoning' as const, ref: null, summary: '依据' }],
    })),
    objections: [],
    strengths: [],
  };
}
function C(id: string, origin: Origin, members: string[], invalidated: string[] = []): Candidate {
  return { id, memberProposalIds: members, origin, representativeProposalId: members[0]!, possibleDuplicateOf: [], invalidatedAssumptions: invalidated };
}
function run(cands: Candidate[], judgments: Judgment[], opts: { judges?: DesignRole[]; overrides?: Override[]; params?: Partial<typeof DEFAULT_DECISION_PARAMS> } = {}) {
  return decide({
    criteria,
    constraints,
    candidates: cands,
    judgments,
    judges: opts.judges ?? ['claude', 'astra'],
    overrides: opts.overrides ?? [],
    params: { ...DEFAULT_DECISION_PARAMS, ...(opts.params ?? {}) },
    now: '2026-10-08T00:00:00.000Z',
  });
}
const total = (r: ReturnType<typeof run>, id: string) => r.totals.find((t) => t.candidateId === id)!;

test('resolveCell: 分差≤1 等权平均；≥2 保留区间；单方 ±1；都无依据 [0,5]', () => {
  const p = { disagreementThreshold: 2, singleJudgeBand: 1 };
  assert.deepEqual(resolveCell([4, 3], p), { kind: 'agreed', lo: 3.5, hi: 3.5, point: 3.5 });
  assert.deepEqual(resolveCell([4, 2], p), { kind: 'disputed', lo: 2, hi: 4, point: null });
  assert.deepEqual(resolveCell([5, null], p), { kind: 'single', lo: 4, hi: 5, point: 5 });
  assert.deepEqual(resolveCell([null, null], p), { kind: 'unknown', lo: 0, hi: 5, point: null });
});

test('resolveConstraint: 淘汰需要两位一致；单方不满足只算分歧', () => {
  assert.equal(resolveConstraint(['fail', 'fail']), 'fail');
  assert.equal(resolveConstraint(['fail', 'pass']), 'disputed');
  assert.equal(resolveConstraint(['fail', null]), 'disputed');
  assert.equal(resolveConstraint(['fail']), 'disputed'); // 只有一位评审时也不能单独淘汰
  assert.equal(resolveConstraint(['pass', 'unknown']), 'unknown');
  assert.equal(resolveConstraint(['pass', 'pass']), 'pass');
});

test('明确领先：A 最差情形仍领先 B ≥ δ → clear', () => {
  const r = run(
    [C('C1', 'astra', ['a1']), C('C2', 'claude', ['c1'])],
    [
      J('claude', 'a1', [4, 4, 4, 3, 3]),
      J('astra', 'a1', [4, 4, 4, 3, 3]),
      J('claude', 'c1', [3, 3, 3, 3, 3]),
      J('astra', 'c1', [3, 3, 3, 3, 3]),
    ],
  );
  assert.equal(r.outcome, 'recommend');
  assert.equal(r.basis, 'clear');
  assert.equal(r.winnerId, 'C1'); // 偏好不能覆盖明确领先（C2 是 Claude 的方案）
  assert.equal(total(r, 'C1').lo, 3.8);
  assert.equal(total(r, 'C2').hi, 3);
});

test('接近（差 < δ）→ 按偏好选 Claude 的框架，并明确说明是偏好决定', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 3, 4, 3, 4]),
      J('astra', 'c1', [4, 3, 4, 3, 4]),
      J('claude', 'a1', [4, 4, 4, 3, 3]),
      J('astra', 'a1', [4, 4, 4, 3, 3]),
    ],
  );
  // C1 = 1.2+0.75+1+0.3+0.4 = 3.65；C2 = 1.2+1+1+0.3+0.3 = 3.8；差 0.15 < 0.25
  assert.equal(total(r, 'C1').lo, 3.65);
  assert.equal(total(r, 'C2').lo, 3.8);
  assert.equal(r.outcome, 'recommend');
  assert.equal(r.basis, 'preference');
  assert.equal(r.winnerId, 'C1');
  assert.ok(r.explanation.some((e) => e.includes('偏好决定')));
});

test('偏好设为 none 时，同样的接近结果变成平局 → 第二平局规则（维护成本）', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 3, 4, 3, 4]),
      J('astra', 'c1', [4, 3, 4, 3, 4]),
      J('claude', 'a1', [4, 4, 4, 3, 3]),
      J('astra', 'a1', [4, 4, 4, 3, 3]),
    ],
    { params: { preferredOrigin: 'none' } },
  );
  assert.equal(r.outcome, 'recommend');
  assert.equal(r.basis, 'tiebreak');
  assert.equal(r.winnerId, 'C2'); // cost 4 vs 3，差 1 ≥ tiebreakMinGap
});

test('真平局：分数接近、偏好相同、第二平局规则也分不开 → tie，交给你选', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'claude', ['c2'])],
    [
      J('claude', 'c1', [4, 4, 4, 3, 3]),
      J('astra', 'c1', [4, 4, 4, 3, 3]),
      J('claude', 'c2', [4, 4, 4, 4, 3]),
      J('astra', 'c2', [4, 4, 4, 4, 3]),
    ],
  );
  assert.equal(r.outcome, 'tie');
  assert.equal(r.winnerId, null);
  assert.deepEqual(r.keyUncertainties, []);
});

test('未知项影响结论 → needs_verification，列出关键不确定项', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 4, null, 3, 3]),
      J('astra', 'c1', [4, 4, null, 3, 3]),
      J('claude', 'a1', [4, 4, 4, 3, 3]),
      J('astra', 'a1', [4, 4, 4, 3, 3]),
    ],
  );
  // C1 已知部分 2.8，可靠性未知 → [2.8, 4.05]；C2 = 3.8
  assert.equal(total(r, 'C1').lo, 2.8);
  assert.equal(total(r, 'C1').hi, 4.05);
  assert.equal(total(r, 'C1').unknownWeight, 0.25);
  assert.equal(r.outcome, 'needs_verification');
  const u = r.keyUncertainties[0]!;
  assert.equal(u.candidateId, 'C1');
  assert.equal(u.criterionId, 'reliability');
  assert.equal(u.isKey, true);
  assert.ok(r.suggestedValidation.hypotheses.length > 0);
});

test('分歧但最坏情形仍在平局区间内 → 偏好仍可决定，分歧保留为区间', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 4, 4, 3, 3]),
      J('astra', 'c1', [4, 4, 2, 3, 3]),
      J('claude', 'a1', [4, 3, 4, 3, 3]),
      J('astra', 'a1', [4, 3, 4, 3, 3]),
    ],
  );
  // C1: [3.3, 3.8]；C2: 3.55；C1 最差 3.3 落后 0.25 → 不满足 “> −δ”，不能靠偏好胜出
  assert.equal(total(r, 'C1').lo, 3.3);
  assert.equal(total(r, 'C2').lo, 3.55);
  assert.equal(r.outcome, 'needs_verification');
  assert.equal(r.keyUncertainties[0]!.criterionId, 'reliability');
  assert.equal(r.keyUncertainties[0]!.impact, 0.5);

  const r2 = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 4, 4, 3, 4]),
      J('astra', 'c1', [4, 4, 2, 3, 4]),
      J('claude', 'a1', [4, 3, 4, 3, 3]),
      J('astra', 'a1', [4, 3, 4, 3, 3]),
    ],
  );
  // C1: [3.4, 3.9]；C2: 3.55；C1 最差落后 0.15 < δ → 偏好胜出
  assert.equal(r2.outcome, 'recommend');
  assert.equal(r2.basis, 'preference');
  assert.equal(r2.winnerId, 'C1');
  const cell = r2.cells.find((c) => c.candidateId === 'C1' && c.criterionId === 'reliability')!;
  assert.equal(cell.kind, 'disputed');
  assert.equal(cell.point, null); // 不编造中间分
});

test('Astra 明确领先时，Claude 偏好不能覆盖', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [3, 3, 3, 3, 3]),
      J('astra', 'c1', [3, 3, 3, 3, 3]),
      J('claude', 'a1', [4, 3, 4, 3, 3]),
      J('astra', 'a1', [4, 3, 4, 3, 3]),
    ],
  );
  // C1 3.0 vs C2 3.55：差 0.55 ≥ δ
  assert.equal(r.winnerId, 'C2');
  assert.equal(r.basis, 'clear');
});

test('单方判定违反约束 → 分歧（不淘汰），且失去偏好资格', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 4, 4, 3, 3], 'pass'),
      J('astra', 'c1', [4, 4, 4, 3, 3], 'fail'),
      J('claude', 'a1', [4, 4, 4, 3, 2]),
      J('astra', 'a1', [4, 4, 4, 3, 2]),
    ],
  );
  const t = total(r, 'C1');
  assert.equal(t.status, 'conditional');
  assert.equal(t.preferenceEligible, false);
  // C1 3.8 vs C2 3.7：差 0.1，C1 无偏好资格 → 无稳健胜者，关键项是约束分歧
  assert.equal(r.outcome, 'needs_verification');
  assert.equal(r.keyUncertainties[0]!.kind, 'constraint');
  assert.equal(r.keyUncertainties[0]!.isKey, true);
});

test('两位都判定违反约束 → 淘汰；剩一个 → single（一个最优解是正常结果）', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [5, 5, 5, 5, 5], 'fail'),
      J('astra', 'c1', [5, 5, 5, 5, 5], 'fail'),
      J('claude', 'a1', [3, 3, 3, 3, 3]),
      J('astra', 'a1', [3, 3, 3, 3, 3]),
    ],
  );
  assert.equal(total(r, 'C1').status, 'eliminated');
  assert.equal(r.outcome, 'single');
  assert.equal(r.winnerId, 'C2');
  assert.ok(r.explanation.some((e) => e.startsWith('淘汰 C1')));
  assert.deepEqual(r.suggestedValidation.candidateIds, ['C2']);
});

test('全部淘汰 → none_viable', () => {
  const r = run(
    [C('C1', 'claude', ['c1'])],
    [J('claude', 'c1', [5, 5, 5, 5, 5], 'fail'), J('astra', 'c1', [5, 5, 5, 5, 5], 'fail')],
  );
  assert.equal(r.outcome, 'none_viable');
  assert.deepEqual(r.suggestedValidation.candidateIds, []);
});

test('你确认约束（用户覆盖）优先于评审分歧', () => {
  const ov: Override = { id: 'o1', kind: 'constraint', candidateId: 'C1', proposalAnchor: 'c1', criterionId: null, constraintId: 'H1', value: 'fail', reason: '我确认它不能在 Windows 跑', at: 'x' };
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 4, 4, 3, 3], 'pass'),
      J('astra', 'c1', [4, 4, 4, 3, 3], 'fail'),
      J('claude', 'a1', [3, 3, 3, 3, 3]),
      J('astra', 'a1', [3, 3, 3, 3, 3]),
    ],
    { overrides: [ov] },
  );
  assert.equal(total(r, 'C1').status, 'eliminated');
  assert.equal(r.outcome, 'single');
  assert.equal(r.winnerId, 'C2');
});

test('用户覆盖分歧格子 → 消除不确定性后得到结论', () => {
  const ov: Override = { id: 'o1', kind: 'score', candidateId: 'C1', proposalAnchor: 'c1', criterionId: 'reliability', constraintId: null, value: 4, reason: '原型已验证', at: 'x' };
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 4, 4, 3, 3]),
      J('astra', 'c1', [4, 4, 2, 3, 3]),
      J('claude', 'a1', [4, 3, 4, 3, 3]),
      J('astra', 'a1', [4, 3, 4, 3, 3]),
    ],
    { overrides: [ov] },
  );
  assert.equal(r.outcome, 'recommend');
  assert.equal(r.winnerId, 'C1');
  assert.equal(r.cells.find((c) => c.candidateId === 'C1' && c.criterionId === 'reliability')!.kind, 'user');
});

test('只有一位评审（另一方失败）→ degraded，全部按单方评分处理', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [J('claude', 'c1', [4, 4, 4, 4, 4]), J('claude', 'a1', [2, 2, 2, 2, 2])],
    { judges: ['claude'] },
  );
  assert.equal(r.degraded, true);
  assert.ok(r.explanation[0]!.includes('不代表双模型共识'));
  assert.equal(r.cells.every((c) => c.kind === 'single'), true);
  // C1 [3,5] vs C2 [1,3]：C1 最差 3 − C2 最好 3 = 0 > −δ 且有偏好资格 → 偏好胜出（不是 clear）
  assert.equal(r.winnerId, 'C1');
  assert.equal(r.basis, 'preference');
});

test('合并候选：每位评审取成员分数均值；来源 both 有偏好资格', () => {
  const r = run(
    [C('C1', 'both', ['c1', 'a1']), C('C2', 'astra', ['a2'])],
    [
      J('claude', 'c1', [4, 4, 4, 4, 4]),
      J('claude', 'a1', [4, 3, 4, 4, 4]),
      J('astra', 'c1', [4, 4, 4, 4, 4]),
      J('astra', 'a1', [4, 4, 4, 4, 4]),
      J('claude', 'a2', [4, 4, 4, 4, 4]),
      J('astra', 'a2', [4, 4, 4, 4, 4]),
    ],
  );
  const cell = r.cells.find((c) => c.candidateId === 'C1' && c.criterionId === 'cost')!;
  assert.equal(cell.judgeScores.claude, 3.5);
  assert.equal(cell.judgeScores.astra, 4);
  assert.equal(cell.point, 3.75);
  assert.equal(total(r, 'C1').preferenceEligible, true);
  assert.equal(r.winnerId, 'C1');
  assert.equal(r.basis, 'preference');
});

test('自评偏差诊断：各自给自己方案多打分时能被识别（只展示不修正）', () => {
  const r = run(
    [C('C1', 'claude', ['c1']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [5, 5, 5, 5, 5]),
      J('astra', 'c1', [4, 4, 4, 4, 4]),
      J('claude', 'a1', [4, 4, 4, 4, 4]),
      J('astra', 'a1', [5, 5, 5, 5, 5]),
    ],
  );
  const c = r.selfPreference.find((s) => s.judge === 'claude')!;
  assert.equal(c.ownMeanDelta, 1);
  assert.equal(c.otherMeanDelta, -1);
  assert.equal(c.index, 2);
  assert.ok(r.explanation.some((e) => e.includes('平均多给')));
  // 两个候选都是 4.5（分差 1 → 等权平均），差 0 → 偏好 Claude
  assert.equal(r.winnerId, 'C1');
  assert.equal(r.basis, 'preference');
});

test('如果用 70/30 模型权重，自评偏差会让 Claude 方案在平局区间外胜出（反例说明）', () => {
  // 同上数据：Claude 自评 5/对方 4；Astra 自评 5/对方 4
  const w = 0.7;
  const c1 = w * 5 + (1 - w) * 4; // Claude 方案：4.7
  const c2 = w * 4 + (1 - w) * 5; // Astra 方案：4.3
  assert.ok(c1 - c2 >= DEFAULT_DECISION_PARAMS.tieMargin); // 0.4 ≥ 0.25：偏好被放大成“分数领先”
});

test('假设被推翻的候选 → conditional，无偏好资格，并列为关键项', () => {
  const r = run(
    [C('C1', 'claude', ['c1'], ['Q3']), C('C2', 'astra', ['a1'])],
    [
      J('claude', 'c1', [4, 4, 4, 3, 3]),
      J('astra', 'c1', [4, 4, 4, 3, 3]),
      J('claude', 'a1', [4, 4, 4, 3, 3]),
      J('astra', 'a1', [4, 4, 4, 3, 3]),
    ],
  );
  assert.equal(total(r, 'C1').status, 'conditional');
  assert.equal(r.outcome, 'needs_verification');
  assert.equal(r.keyUncertainties[0]!.kind, 'assumption');
  assert.equal(r.keyUncertainties[0]!.questionId, 'Q3');
});

test('权重之和不为 1 时拒绝计算', () => {
  assert.throws(() =>
    decide({
      criteria: [{ id: 'fit', name: 'x', weight: 0.5, anchors }],
      constraints: [],
      candidates: [],
      judgments: [],
      judges: ['claude'],
      overrides: [],
      params: DEFAULT_DECISION_PARAMS,
    }),
  );
});
