/**
 * 问题：任何阶段、任何模型提出的问题都登记到 run.questions，并实时推送到页面。
 * 每题都有选项、默认假设；用户可回答 / 跳过（用默认）/ 暂不确定。
 */
import type { AnswerInput, QuestionOut } from './schemas.js';
import type { Candidate, DesignRole, ModelRole, Proposal, Question, QuestionPhase } from './types.js';

export const TOPIC_ORDER = [
  'goal_scope',
  'core_flow',
  'users_scale',
  'data',
  'integration',
  'deployment',
  'security',
  'performance',
  'budget_timeline',
  'team_skills',
  'ux',
  'other',
] as const;

export const TOPIC_NAME: Record<(typeof TOPIC_ORDER)[number], string> = {
  goal_scope: '目标与范围',
  core_flow: '核心流程',
  users_scale: '用户与规模',
  data: '数据与存储',
  integration: '外部集成',
  deployment: '部署与运行环境',
  security: '安全与权限',
  performance: '性能',
  budget_timeline: '预算与时间',
  team_skills: '团队与技能',
  ux: '交互体验',
  other: '其他',
};

const PRIORITY_RANK = { blocking: 0, important: 1, optional: 2 } as const;

function nextQuestionNumber(existing: Question[]): number {
  return existing.reduce((m, q) => Math.max(m, Number(q.id.slice(1)) || 0), 0) + 1;
}

export function registerQuestions(
  existing: Question[],
  out: QuestionOut[],
  meta: { role: ModelRole; phase: QuestionPhase; taskId: string; snapshotVersion: number; now: string },
): Question[] {
  let n = nextQuestionNumber(existing);
  const created: Question[] = [];
  for (const q of out) {
    const related = [...existing, ...created].filter((x) => x.topic === q.topic && x.askedBy !== meta.role).map((x) => x.id);
    created.push({
      ...q,
      id: `Q${n++}`,
      localId: q.localId,
      askedBy: meta.role,
      phase: meta.phase,
      taskId: meta.taskId,
      createdAt: meta.now,
      snapshotVersion: meta.snapshotVersion,
      status: 'open',
      answer: null,
      appliedInSnapshot: null,
      relatedQuestionIds: related,
    });
  }
  return created;
}

export function answerQuestion(q: Question, input: AnswerInput, now: string): Question {
  if (input.status === 'answered') {
    for (const id of input.optionIds) {
      if (!q.options.some((o) => o.id === id)) throw new Error(`问题 ${q.id} 没有选项 ${id}`);
    }
    if (!q.multiSelect && input.optionIds.length > 1) throw new Error(`问题 ${q.id} 是单选题`);
    if (input.optionIds.length === 0 && !input.otherText?.trim()) throw new Error('请选择一个选项或填写“其他”');
    return {
      ...q,
      status: 'answered',
      answer: { optionIds: [...input.optionIds], otherText: input.otherText?.trim() || null, note: input.note?.trim() || null, answeredAt: now },
      appliedInSnapshot: null,
    };
  }
  return {
    ...q,
    status: input.status,
    answer: input.note?.trim() ? { optionIds: [], otherText: null, note: input.note.trim(), answeredAt: now } : null,
    appliedInSnapshot: null,
  };
}

/** 按主题分组，组内按优先级、编号排序（界面直接使用） */
export function groupQuestions(questions: Question[]): { topic: string; name: string; questions: Question[] }[] {
  return TOPIC_ORDER.map((topic) => ({
    topic,
    name: TOPIC_NAME[topic],
    questions: questions
      .filter((q) => q.topic === topic)
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Number(a.id.slice(1)) - Number(b.id.slice(1))),
  })).filter((g) => g.questions.length > 0);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** 回答是否与默认假设不同（不同才可能推翻方案） */
export function answerDiffersFromDefault(q: Question): boolean {
  if (q.status !== 'answered' || !q.answer) return false;
  if (q.answer.otherText) return true;
  return !sameSet(q.answer.optionIds, q.defaultOptionIds);
}

/**
 * 找出被推翻的假设：方案在旧快照上依赖了某问题的默认答案，而用户之后给出了不同的回答。
 * 返回 proposalId -> 问题编号列表
 */
export function findInvalidatedAssumptions(proposals: Proposal[], questions: Question[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of proposals) {
    const hits: string[] = [];
    for (const a of p.assumptions) {
      if (!a.questionId) continue;
      const q = questions.find((x) => x.id === a.questionId);
      if (!q || !answerDiffersFromDefault(q)) continue;
      const sawAnswer = q.appliedInSnapshot !== null && p.snapshotVersion >= q.appliedInSnapshot;
      if (!sawAnswer && !hits.includes(q.id)) hits.push(q.id);
    }
    if (hits.length) out.set(p.id, hits);
  }
  return out;
}

export function applyInvalidations(candidates: Candidate[], invalid: Map<string, string[]>): Candidate[] {
  return candidates.map((c) => ({
    ...c,
    invalidatedAssumptions: [...new Set(c.memberProposalIds.flatMap((pid) => invalid.get(pid) ?? []))],
  }));
}

export function questionStats(questions: Question[], askedBy?: DesignRole | 'sol') {
  const qs = askedBy ? questions.filter((q) => q.askedBy === askedBy) : questions;
  return {
    total: qs.length,
    open: qs.filter((q) => q.status === 'open').length,
    blockingOpen: qs.filter((q) => q.status === 'open' && q.priority === 'blocking').length,
    answered: qs.filter((q) => q.status === 'answered').length,
  };
}
