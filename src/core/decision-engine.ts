/**
 * 决策引擎：两模型评分合并 + 硬约束 + 区间稳健比较 + 偏好平局规则。
 *
 * 设计要点（完整论证见 docs/DECISION_ALGORITHM.md）：
 * - 不给模型设固定权重（如 70/30）。两位评审分差 ≤1 时取等权平均（权重差异影响 ≤0.06 分，可忽略）；
 *   分差 ≥2 时不平均，保留为区间 [min,max] 并标记“分歧”；只有一位评审给分时用 ±1 不确定带；
 *   两位都无依据时为 [0,5]（未知），绝不编造中间分，也不把未知项剔除后重新归一化。
 * - 硬约束：两位评审都判“不满足”才淘汰；一方判不满足 = 分歧（待你确认或验证），不能由单个模型淘汰对方方案。
 * - 比较：A 稳健优于 B ⇔ 在 A 最差、B 最好的情形下，A 仍不落后超过 δ（A 有偏好资格）或领先至少 δ（无偏好资格）。
 * - 偏好（默认偏向 Claude 的整体框架）只在差距 < δ 时起作用；有未决硬约束的方案没有偏好资格。
 * - 找不到稳健胜者时，列出“会改变结论”的不确定项，而不是给出伪精确排名。
 *
 * 纯函数，无 I/O，可单测。
 */
import type {
  Candidate,
  CandidateTotals,
  CellResult,
  ConstraintResult,
  ConstraintStatus,
  Criterion,
  DecisionParams,
  DecisionReport,
  DesignRole,
  HardConstraint,
  Judgment,
  KeyUncertainty,
  Origin,
  Override,
  PairwiseResult,
  SelfPreferenceDiag,
} from './types.js';
import type { EvidenceOut } from './schemas.js';

export interface DecisionInput {
  criteria: Criterion[];
  constraints: HardConstraint[];
  candidates: Candidate[];
  /** 本轮评审意见（按评审 × 原始提案） */
  judgments: Judgment[];
  /** 成功完成评审的评审方；只有一位时结果标记为 degraded */
  judges: DesignRole[];
  overrides: Override[];
  params: DecisionParams;
  now?: string;
}

export const DEFAULT_DECISION_PARAMS: DecisionParams = {
  tieMargin: 0.25,
  disagreementThreshold: 2,
  singleJudgeBand: 1,
  preferredOrigin: 'claude',
  tiebreakCriterionId: 'cost',
  tiebreakMinGap: 1,
};

const EPS = 1e-9;
const ROLE_NAME: Record<DesignRole, string> = { claude: 'Claude', astra: 'Astra' };
const STATUS_NAME = { pass: '满足', fail: '不满足', unknown: '无法判断' } as const;

function r4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
function fmt(x: number): string {
  return (Math.round(x * 100) / 100).toFixed(2);
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function assertWeights(criteria: Criterion[]): void {
  if (criteria.length === 0) throw new Error('至少需要一个评分项');
  const sum = criteria.reduce((a, c) => a + c.weight, 0);
  if (Math.abs(sum - 1) > 1e-6) throw new Error(`评分权重之和必须为 1，当前为 ${sum}`);
  for (const c of criteria) {
    if (c.weight < 0) throw new Error(`评分项 ${c.id} 权重为负`);
  }
}

/** 某评审对某候选（合并后）某评分项的分数：成员提案分数的均值（忽略 null）。 */
function judgeCellScore(
  judgmentsByKey: Map<string, Judgment>,
  judge: DesignRole,
  cand: Candidate,
  criterionId: string,
): { score: number | null; rationales: string[]; evidence: EvidenceOut[] } {
  const scores: number[] = [];
  const rationales: string[] = [];
  const evidence: EvidenceOut[] = [];
  for (const pid of cand.memberProposalIds) {
    const j = judgmentsByKey.get(`${judge}|${pid}`);
    if (!j) continue;
    const s = j.scores.find((x) => x.criterionId === criterionId);
    if (!s) continue;
    if (s.score !== null) scores.push(s.score);
    if (s.rationale) rationales.push(s.rationale);
    evidence.push(...s.evidence);
  }
  return { score: scores.length ? r4(mean(scores)) : null, rationales, evidence };
}

/** 某评审对某候选某约束的判定：成员中任一不满足 → 不满足；否则任一无法判断 → 无法判断；全部满足 → 满足。 */
function judgeConstraintStatus(
  judgmentsByKey: Map<string, Judgment>,
  judge: DesignRole,
  cand: Candidate,
  constraintId: string,
): { status: 'pass' | 'fail' | 'unknown' | null; rationales: string[] } {
  const statuses: ('pass' | 'fail' | 'unknown')[] = [];
  const rationales: string[] = [];
  for (const pid of cand.memberProposalIds) {
    const j = judgmentsByKey.get(`${judge}|${pid}`);
    if (!j) continue;
    const c = j.constraintChecks.find((x) => x.constraintId === constraintId);
    if (!c) {
      statuses.push('unknown');
      continue;
    }
    statuses.push(c.status);
    if (c.rationale) rationales.push(c.rationale);
  }
  if (statuses.length === 0) return { status: null, rationales };
  if (statuses.includes('fail')) return { status: 'fail', rationales };
  if (statuses.includes('unknown')) return { status: 'unknown', rationales };
  return { status: 'pass', rationales };
}

export function resolveConstraint(
  judgeStatuses: ('pass' | 'fail' | 'unknown' | null)[],
): ConstraintStatus {
  const n = judgeStatuses.length;
  const s = judgeStatuses.map((x) => x ?? 'unknown');
  if (s.includes('fail')) {
    // 淘汰需要两位评审一致；单方判定不满足只算“分歧”，交给你确认或验证
    return n >= 2 && s.every((x) => x === 'fail') ? 'fail' : 'disputed';
  }
  if (s.includes('unknown')) return 'unknown';
  return 'pass';
}

export function resolveCell(
  judgeScores: (number | null)[],
  params: Pick<DecisionParams, 'disagreementThreshold' | 'singleJudgeBand'>,
): Pick<CellResult, 'kind' | 'lo' | 'hi' | 'point'> {
  const known = judgeScores.filter((x): x is number => x !== null);
  if (known.length >= 2) {
    const lo = Math.min(...known);
    const hi = Math.max(...known);
    if (hi - lo >= params.disagreementThreshold - EPS) {
      return { kind: 'disputed', lo, hi, point: null };
    }
    const p = r4(mean(known));
    return { kind: 'agreed', lo: p, hi: p, point: p };
  }
  if (known.length === 1) {
    const s = known[0]!;
    return {
      kind: 'single',
      lo: Math.max(0, s - params.singleJudgeBand),
      hi: Math.min(5, s + params.singleJudgeBand),
      point: s,
    };
  }
  return { kind: 'unknown', lo: 0, hi: 5, point: null };
}

function originEligible(origin: Origin, preferred: DecisionParams['preferredOrigin']): boolean {
  if (preferred === 'none') return false;
  return origin === preferred || origin === 'both';
}

export function decide(input: DecisionInput): DecisionReport {
  const { criteria, constraints, candidates, judgments, judges, overrides, params } = input;
  assertWeights(criteria);
  const delta = params.tieMargin;
  const judgmentsByKey = new Map<string, Judgment>();
  for (const j of judgments) judgmentsByKey.set(`${j.judge}|${j.proposalId}`, j);
  const critById = new Map(criteria.map((c) => [c.id, c]));
  const consById = new Map(constraints.map((h) => [h.id, h]));

  const findOverride = (kind: 'score' | 'constraint', cid: string, key: string) =>
    overrides
      .filter(
        (o) =>
          o.kind === kind &&
          o.candidateId === cid &&
          (kind === 'score' ? o.criterionId === key : o.constraintId === key),
      )
      .at(-1);

  // ---------- 1. 硬约束 ----------
  const constraintResults: ConstraintResult[] = [];
  for (const cand of candidates) {
    for (const h of constraints) {
      const judgeStatuses: ConstraintResult['judgeStatuses'] = {};
      const rationales: ConstraintResult['rationales'] = {};
      for (const j of judges) {
        const r = judgeConstraintStatus(judgmentsByKey, j, cand, h.id);
        judgeStatuses[j] = r.status;
        rationales[j] = r.rationales;
      }
      const ov = findOverride('constraint', cand.id, h.id);
      if (ov && (ov.value === 'pass' || ov.value === 'fail')) {
        constraintResults.push({ candidateId: cand.id, constraintId: h.id, status: ov.value, source: 'user', judgeStatuses, rationales });
      } else {
        const status = resolveConstraint(judges.map((j) => judgeStatuses[j] ?? null));
        constraintResults.push({ candidateId: cand.id, constraintId: h.id, status, source: 'judges', judgeStatuses, rationales });
      }
    }
  }

  // ---------- 2. 评分格子 ----------
  const cells: CellResult[] = [];
  for (const cand of candidates) {
    for (const k of criteria) {
      const judgeScores: CellResult['judgeScores'] = {};
      const rationales: CellResult['rationales'] = {};
      const evidence: CellResult['evidence'] = {};
      for (const j of judges) {
        const r = judgeCellScore(judgmentsByKey, j, cand, k.id);
        judgeScores[j] = r.score;
        rationales[j] = r.rationales;
        evidence[j] = r.evidence;
      }
      const ov = findOverride('score', cand.id, k.id);
      if (ov && typeof ov.value === 'number') {
        cells.push({ candidateId: cand.id, criterionId: k.id, kind: 'user', lo: ov.value, hi: ov.value, point: ov.value, judgeScores, rationales, evidence });
      } else {
        const res = resolveCell(judges.map((j) => judgeScores[j] ?? null), params);
        cells.push({ candidateId: cand.id, criterionId: k.id, ...res, judgeScores, rationales, evidence });
      }
    }
  }
  const cellOf = (cid: string, kid: string) => cells.find((c) => c.candidateId === cid && c.criterionId === kid)!;

  // ---------- 3. 候选汇总 ----------
  const totals: CandidateTotals[] = candidates.map((cand) => {
    const cr = constraintResults.filter((x) => x.candidateId === cand.id);
    const eliminatedBy = cr.filter((x) => x.status === 'fail').map((x) => x.constraintId);
    const unresolved = cr.filter((x) => x.status === 'disputed' || x.status === 'unknown').map((x) => x.constraintId);
    const status: CandidateTotals['status'] = eliminatedBy.length
      ? 'eliminated'
      : unresolved.length || cand.invalidatedAssumptions.length
        ? 'conditional'
        : 'viable';
    let lo = 0;
    let hi = 0;
    let knownScore = 0;
    let unknownWeight = 0;
    let disputedWeight = 0;
    for (const k of criteria) {
      const c = cellOf(cand.id, k.id);
      lo += k.weight * c.lo;
      hi += k.weight * c.hi;
      if (c.kind === 'agreed' || c.kind === 'user') knownScore += k.weight * (c.point as number);
      if (c.kind === 'unknown') unknownWeight += k.weight;
      if (c.kind === 'disputed') disputedWeight += k.weight;
    }
    return {
      candidateId: cand.id,
      origin: cand.origin,
      status,
      lo: r4(lo),
      hi: r4(hi),
      knownScore: r4(knownScore),
      unknownWeight: r4(unknownWeight),
      disputedWeight: r4(disputedWeight),
      preferenceEligible: status === 'viable' && originEligible(cand.origin, params.preferredOrigin),
      eliminatedBy,
      unresolvedConstraints: unresolved,
    };
  });
  const totalOf = (cid: string) => totals.find((t) => t.candidateId === cid)!;
  const alive = totals.filter((t) => t.status !== 'eliminated');

  // ---------- 4. 两两稳健比较 ----------
  const pairwise: PairwiseResult[] = [];
  const robust = (a: CandidateTotals, b: CandidateTotals): boolean => {
    const dLo = a.lo - b.hi;
    if (a.preferenceEligible && !b.preferenceEligible) return dLo > -delta + EPS;
    return dLo >= delta - EPS;
  };
  for (const a of alive) {
    for (const b of alive) {
      if (a === b) continue;
      pairwise.push({ a: a.candidateId, b: b.candidateId, dLo: r4(a.lo - b.hi), dHi: r4(a.hi - b.lo), aRobustlyPreferred: robust(a, b) });
    }
  }
  const prefers = (a: CandidateTotals, b: CandidateTotals) => pairwise.find((p) => p.a === a.candidateId && p.b === b.candidateId)!.aRobustlyPreferred;
  const mid = (t: CandidateTotals) => (t.lo + t.hi) / 2;
  const displayOrder = [
    ...[...alive].sort((x, y) => mid(y) - mid(x)).map((t) => t.candidateId),
    ...totals.filter((t) => t.status === 'eliminated').map((t) => t.candidateId),
  ];

  // ---------- 5. 结论 ----------
  let outcome: DecisionReport['outcome'];
  let basis: DecisionReport['basis'] = null;
  let winnerId: string | null = null;
  let contenders: string[] = [];
  let relevant: CandidateTotals[] = [];

  if (alive.length === 0) {
    outcome = 'none_viable';
  } else if (alive.length === 1) {
    outcome = 'single';
    basis = 'only_viable';
    winnerId = alive[0]!.candidateId;
    contenders = [winnerId];
  } else {
    const w = alive.find((x) => alive.every((y) => y === x || prefers(x, y)));
    if (w) {
      outcome = 'recommend';
      winnerId = w.candidateId;
      const clear = alive.every((y) => y === w || w.lo - y.hi >= delta - EPS);
      basis = clear ? 'clear' : 'preference';
      contenders = [w.candidateId];
    } else {
      const cont = alive.filter((x) => !alive.some((y) => y !== x && prefers(y, x)));
      contenders = cont.map((t) => t.candidateId);
      relevant = alive.filter(
        (y) => cont.includes(y) || cont.some((x) => x !== y && !prefers(x, y) && !prefers(y, x)),
      );
      const hasUncertainty = relevant.some(
        (t) =>
          t.status === 'conditional' ||
          criteria.some((k) => ['disputed', 'single', 'unknown'].includes(cellOf(t.candidateId, k.id).kind)),
      );
      if (hasUncertainty) {
        outcome = 'needs_verification';
      } else {
        // 真平局（全部为确定值、差距 < δ、偏好相同）→ 第二平局规则：维护成本
        outcome = 'tie';
        const tbId = params.tiebreakCriterionId;
        if (tbId && critById.has(tbId)) {
          const ranked = relevant
            .map((t) => ({ t, v: cellOf(t.candidateId, tbId).point ?? -1 }))
            .sort((x, y) => y.v - x.v);
          if (ranked.length >= 2 && ranked[0]!.v - ranked[1]!.v >= params.tiebreakMinGap - EPS) {
            outcome = 'recommend';
            basis = 'tiebreak';
            winnerId = ranked[0]!.t.candidateId;
          }
        }
      }
    }
  }

  const winner = winnerId ? totalOf(winnerId) : null;
  const conditional = !!winner && winner.status === 'conditional';

  // ---------- 6. 关键不确定项 ----------
  const uncertaintyScope: CandidateTotals[] =
    outcome === 'needs_verification' || outcome === 'tie' ? relevant : winner && conditional ? [winner] : [];
  const items: Omit<KeyUncertainty, 'id'>[] = [];
  for (const t of uncertaintyScope) {
    const cand = candidates.find((c) => c.id === t.candidateId)!;
    for (const hid of t.unresolvedConstraints) {
      const cr = constraintResults.find((x) => x.candidateId === t.candidateId && x.constraintId === hid)!;
      const h = consById.get(hid);
      const who = judges.map((j) => `${ROLE_NAME[j]} 判定${STATUS_NAME[cr.judgeStatuses[j] ?? 'unknown']}`).join(' / ');
      items.push({
        candidateId: t.candidateId,
        kind: 'constraint',
        criterionId: null,
        constraintId: hid,
        questionId: null,
        impact: Number.POSITIVE_INFINITY,
        isKey: true,
        description: `${t.candidateId} · 硬约束 ${hid}「${h?.text ?? ''}」${cr.status === 'disputed' ? '存在分歧' : '无法判断'}：${who}`,
        judgeScores: {},
      });
    }
    for (const qid of cand.invalidatedAssumptions) {
      items.push({
        candidateId: t.candidateId,
        kind: 'assumption',
        criterionId: null,
        constraintId: null,
        questionId: qid,
        impact: Number.POSITIVE_INFINITY,
        isKey: true,
        description: `${t.candidateId} 依赖的默认假设已被你对 ${qid} 的回答推翻，需要重新设计或复核`,
        judgeScores: {},
      });
    }
    if (outcome === 'needs_verification' || outcome === 'tie') {
      for (const k of criteria) {
        const c = cellOf(t.candidateId, k.id);
        if (!['disputed', 'single', 'unknown'].includes(c.kind)) continue;
        const impact = r4(k.weight * (c.hi - c.lo));
        const scoresText = judges
          .map((j) => `${ROLE_NAME[j]} ${c.judgeScores[j] === null || c.judgeScores[j] === undefined ? '无依据' : fmt(c.judgeScores[j] as number)}`)
          .join(' / ');
        const what =
          c.kind === 'disputed' ? `两位评审分歧（${scoresText}）` : c.kind === 'single' ? `仅单方评分（${scoresText}）` : '两位评审都无依据评分';
        items.push({
          candidateId: t.candidateId,
          kind: 'cell',
          criterionId: k.id,
          constraintId: null,
          questionId: null,
          impact,
          isKey: impact >= delta - EPS,
          description: `${t.candidateId} · ${k.name}：${what}，可能影响总分 ${fmt(impact)}`,
          judgeScores: { ...c.judgeScores },
        });
      }
    }
  }
  items.sort((a, b) => b.impact - a.impact);
  const keyUncertainties: KeyUncertainty[] = items.map((x, i) => ({ id: `U${i + 1}`, ...x }));

  // ---------- 7. 建议的验证 ----------
  const byMid = (ids: string[]) => [...ids].sort((a, b) => mid(totalOf(b)) - mid(totalOf(a)));
  let suggestedValidation: DecisionReport['suggestedValidation'];
  if (outcome === 'none_viable') {
    suggestedValidation = { candidateIds: [], reason: '所有候选都被两位评审一致判定违反硬约束：请先重新检查需求与约束是否合理', hypotheses: [] };
  } else if (outcome === 'recommend' || outcome === 'single') {
    suggestedValidation = {
      candidateIds: [winnerId!],
      reason: conditional ? '构建推荐方案的最小 MVP，并在其中验证未决的硬约束' : '直接构建推荐方案的最小 MVP（不需要对比原型）',
      hypotheses: keyUncertainties.map((u) => u.description),
    };
  } else if (outcome === 'tie') {
    suggestedValidation = {
      candidateIds: byMid(relevant.map((t) => t.candidateId)).slice(0, 2),
      reason: '结果接近且偏好无法区分：可以直接选一个构建 MVP；只有在你想用实测打破平局时才做对比验证',
      hypotheses: [],
    };
  } else {
    const keyCands = [...new Set(keyUncertainties.filter((u) => u.isKey).map((u) => u.candidateId))];
    const ids = byMid(keyCands.length ? [...new Set([...contenders, ...keyCands])] : relevant.map((t) => t.candidateId)).slice(0, 3);
    suggestedValidation = {
      candidateIds: ids,
      reason:
        ids.length >= 2
          ? '关键分歧会改变结论：建议先复核分歧或回答相关问题；仍无法消除时，再对这些候选做同一验收标准的对比验证'
          : '关键不确定项集中在一个候选上：建议先复核或回答问题，再决定是否构建',
      hypotheses: keyUncertainties.filter((u) => u.isKey).slice(0, 5).map((u) => u.description),
    };
  }

  // ---------- 8. 自评偏差诊断（只展示，不修正） ----------
  const selfPreference: SelfPreferenceDiag[] = [];
  if (judges.length >= 2) {
    for (const j of judges) {
      const o = judges.find((x) => x !== j)!;
      const deltasFor = (origin: Origin) => {
        const ds: number[] = [];
        for (const cand of candidates.filter((c) => c.origin === origin)) {
          for (const k of criteria) {
            const c = cellOf(cand.id, k.id);
            const sj = c.judgeScores[j];
            const so = c.judgeScores[o];
            if (typeof sj === 'number' && typeof so === 'number') ds.push(sj - so);
          }
        }
        return ds;
      };
      const own = deltasFor(j);
      const other = deltasFor(o);
      const ownMean = own.length ? r4(mean(own)) : null;
      const otherMean = other.length ? r4(mean(other)) : null;
      selfPreference.push({
        judge: j,
        ownMeanDelta: ownMean,
        otherMeanDelta: otherMean,
        index: ownMean !== null && otherMean !== null ? r4(ownMean - otherMean) : null,
        sampleSize: own.length + other.length,
      });
    }
  }

  // ---------- 9. 解释 ----------
  const explanation: string[] = [];
  if (judges.length < 2) {
    explanation.push(`只有 ${judges.map((j) => ROLE_NAME[j]).join('、') || '0 位'} 完成了评审：所有评分按单方评分处理（±${params.singleJudgeBand}），结果不完整，不代表双模型共识。`);
  }
  for (const t of totals.filter((x) => x.status === 'eliminated')) {
    explanation.push(
      `淘汰 ${t.candidateId}：两位评审都判定其违反硬约束 ${t.eliminatedBy
        .map((h) => `${h}「${consById.get(h)?.text ?? ''}」`)
        .join('、')}${constraintResults.some((x) => x.candidateId === t.candidateId && x.source === 'user' && x.status === 'fail') ? '（含你的确认）' : ''}。`,
    );
  }
  const scoreText = (t: CandidateTotals) => (Math.abs(t.hi - t.lo) < 1e-6 ? fmt(t.lo) : `${fmt(t.lo)}–${fmt(t.hi)}`);
  if (outcome === 'none_viable') {
    explanation.push('没有任何候选通过硬约束。建议检查约束是否过严，或回答相关问题后重新设计。');
  } else if (outcome === 'single') {
    const t = winner!;
    explanation.push(`只有 ${t.candidateId} 可行（得分 ${scoreText(t)}）。单一方案是正常结果，不需要为了比较而凑数。`);
    if (conditional) explanation.push(`但 ${t.candidateId} 仍有未决硬约束：${t.unresolvedConstraints.join('、') || '（假设被推翻）'}，需在 MVP 中验证。`);
  } else if (outcome === 'recommend') {
    const t = winner!;
    const others = alive.filter((x) => x !== t);
    if (basis === 'clear') {
      explanation.push(`推荐 ${t.candidateId}（得分 ${scoreText(t)}）：即使按它最不利、对手最有利的情形计算，仍领先 ${others.map((o) => `${o.candidateId}（${scoreText(o)}）`).join('、')} 至少 ${fmt(delta)} 分。`);
    } else if (basis === 'preference') {
      const close = others.filter((o) => t.lo - o.hi < delta - EPS).map((o) => o.candidateId);
      explanation.push(
        `推荐 ${t.candidateId}（得分 ${scoreText(t)}）：与 ${close.join('、')} 的差距在平局区间 δ=${fmt(delta)} 内，按你的偏好选择${params.preferredOrigin === 'claude' ? ' Claude ' : ' Astra '}提出的整体框架。这是偏好决定，不是分数决定；如有不同看法可直接改选。`,
      );
    } else if (basis === 'tiebreak') {
      explanation.push(`推荐 ${t.candidateId}：与其他候选分数接近且偏好相同，按第二平局规则（${critById.get(params.tiebreakCriterionId ?? '')?.name ?? ''}更优）选择。`);
    }
    if (conditional) explanation.push(`注意：${t.candidateId} 仍有未决硬约束，需在 MVP 中验证：${t.unresolvedConstraints.join('、')}。`);
  } else if (outcome === 'tie') {
    explanation.push(`${relevant.map((t) => `${t.candidateId}（${scoreText(t)}）`).join('、')} 分数接近、偏好相同、第二平局规则也无法区分：请你直接选择，或做对比验证。`);
  } else {
    explanation.push(
      `暂不推荐：${relevant.map((t) => `${t.candidateId}（${scoreText(t)}）`).join('、')} 的比较结果取决于下面的不确定项。可以回答相关问题、让两位模型复核分歧一轮、或对关键假设做对比验证；也可以接受风险直接选择。`,
    );
  }
  const strongSelf = selfPreference.filter((s) => s.index !== null && Math.abs(s.index) >= 0.5);
  for (const s of strongSelf) {
    explanation.push(`提示：${ROLE_NAME[s.judge]} 对自己提出的候选平均多给 ${fmt(s.index!)} 分（相对它对对方候选的打分差），已通过区间处理，不做自动修正。`);
  }

  return {
    outcome,
    basis,
    winnerId,
    conditional,
    contenders,
    displayOrder,
    totals,
    cells,
    constraints: constraintResults,
    pairwise,
    keyUncertainties,
    suggestedValidation,
    selfPreference,
    explanation,
    params,
    judges: [...judges],
    degraded: judges.length < 2,
    computedAt: input.now ?? new Date().toISOString(),
  };
}
