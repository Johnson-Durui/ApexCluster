// Run 3 of 4 (README.md "Runs"): 支付回调幂等性改造 — single-architect design, blocked: the clarify step and G1 are
// done, and the Claude proposal task failed with rate_limited (the product's "failed" state is phaseStatus 'blocked').
// Times are relative to `now`: the run stopped about three days before the demo was loaded.
import type { HardConstraint, ProjectInput, RequirementSnapshot, Run } from '../../../src/lib/types';
import { commonFields, EMPTY_DOCS, gate, question, started, task, timeline, trail, type RunBundle } from './common';

export const PAYMENT_RUN_ID = 'r-20261117-e2b6f8';
const V1 = 'v1-7a04d9c2e6b1';
const V2 = 'v2-e19f5b2c08d7';

const project: ProjectInput = {
  title: '支付回调幂等性改造',
  prompt: '订单服务接收第三方支付平台的异步回调，偶发的重复回调会让同一订单被重复记账。需要改造回调处理，使重复、乱序和超时重试都不会产生重复入账，并能按支付流水号对账追溯。',
  coreFlows: ['接收并验签支付回调', '按支付流水号幂等入账', '每日对账并输出差异'],
  existingStack: 'Java 17 + Spring Boot 订单服务，MySQL 8',
  deployment: '容器化部署，订单服务 3 个实例',
  budget: '一名后端开发，两周',
  acceptance: '同一流水号重复回调 100 次只入账一次；对账差异为 0',
  context: '',
};
const constraints: HardConstraint[] = [
  { id: 'H1', text: '同一支付流水号无论回调多少次只入账一次', kind: 'must' },
  { id: 'H2', text: '改变对外回调地址或要求支付平台调整签名方式', kind: 'must_not' },
];
export const PAYMENT_BLOCKED_REASON = 'Claude 提案任务因额度受限未完成（rate_limited）。已完成的澄清结果已保存；可以重试失败的任务，或明确改由 Astra 提案。';

export function buildPaymentRun(now: number): RunBundle {
  const t = timeline(now - (3 * 24 * 60 + 40) * 60_000);
  const run = { id: PAYMENT_RUN_ID, models: commonFields().models };
  const snapshots: RequirementSnapshot[] = [
    { version: 1, ref: V1, hash: V1.slice(3), createdAt: t(0), reason: '用户输入', project, constraints, facts: [{ id: 'F1', text: '订单服务 3 个实例同时接收回调', source: 'user_input' }], assumptions: [], openItems: [] },
    { version: 2, ref: V2, hash: V2.slice(3), createdAt: t(27.4), reason: '合并 G1 回答', project, constraints,
      facts: [
        { id: 'F1', text: '订单服务 3 个实例同时接收回调', source: 'user_input' },
        { id: 'F2', text: '订单库允许为支付流水号新增唯一索引', source: 'answer:Q1' },
        { id: 'F3', text: '支付平台对失败回调最多重试 8 次，持续 24 小时', source: 'answer:Q2' },
        { id: 'F4', text: '需要每日对账报表', source: 'answer:Q3' },
      ],
      assumptions: [], openItems: [{ id: 'O1', text: '历史重复入账数据的修复方式待财务确认', source: 'user_input' }] },
  ];
  const tasks = [
    task(run, { id: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', scope: 'clarify', createdAt: t(0.02), startedAt: t(0.05), endedAt: t(3.1), inputRef: V1 }),
    task(run, { id: 't-r1-propose-claude-a1', role: 'claude', phase: 'propose', scope: 'r1-propose', createdAt: t(27.45), startedAt: t(27.5), endedAt: t(30.9), inputRef: V2, status: 'failed',
      failure: { kind: 'rate_limited', message: '执行端报告额度或频率受限，任务未完成（不会自动重试）。' }, lastProgress: '执行端报告额度或频率受限：rate_limited' }),
  ];
  const byId = (id: string) => tasks.find(item => item.id === id)!;
  const questions = [
    question({ id: 'Q1', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(3.1), topic: 'data', priority: 'blocking', multiSelect: false,
      text: '订单库能否为支付流水号新增唯一索引？', whyItMatters: '唯一索引是最直接的幂等保证；不能加时需要额外的去重表',
      options: [{ id: 'yes', label: '可以新增唯一索引', implication: '入账语句可依赖数据库保证幂等' }, { id: 'no', label: '不能改表结构', implication: '需要独立的去重表或缓存' }],
      defaultOptionIds: ['no'], defaultAssumption: '不能改表结构，使用独立去重表', answer: { optionIds: ['yes'], at: t(15.2) } }),
    question({ id: 'Q2', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(3.1), topic: 'integration', priority: 'important', multiSelect: false,
      text: '支付平台对失败回调的重试策略是什么？', whyItMatters: '决定去重记录需要保留多久，以及乱序回调的时间窗口',
      options: [{ id: 'fixed', label: '最多 8 次，持续 24 小时', implication: '去重记录至少保留 24 小时' }, { id: 'unknown', label: '不清楚', implication: '按最长 7 天保守处理' }],
      defaultOptionIds: ['unknown'], defaultAssumption: '按最长 7 天保守处理', answer: { optionIds: ['fixed'], at: t(19.8) } }),
    question({ id: 'Q3', askedBy: 'claude', taskId: 't-clarify-claude-a1', createdAt: t(3.1), topic: 'other', priority: 'optional', multiSelect: false,
      text: '是否需要每日对账报表？', whyItMatters: '决定是否需要额外的对账任务与差异输出',
      options: [{ id: 'daily', label: '需要每日对账', implication: '增加一个定时任务' }, { id: 'none', label: '暂不需要', implication: '只保证入账幂等' }],
      defaultOptionIds: ['daily'], defaultAssumption: '需要每日对账报表', answer: { optionIds: ['daily'], at: t(24.6) } }),
  ];
  const full: Run = {
    ...commonFields(), id: PAYMENT_RUN_ID, title: project.title, createdAt: t(0), updatedAt: t(30.95),
    phase: 'propose', phaseStatus: 'blocked', blockedReason: PAYMENT_BLOCKED_REASON, terminal: null, clarifyWith: 'claude',
    designMode: 'auto', riskLevel: 'medium', designResolution: { mode: 'single', reasons: ['未触发 dual 规则'], architects: ['claude'], reviewers: ['astra'] },
    criteriaLockedAt: t(27.45), snapshots, currentSnapshotVersion: 2, designSnapshotVersion: 2, tasks, questions,
    modelNotes: [{ taskId: 't-clarify-claude-a1', role: 'claude', phase: 'clarify', understanding: '你要让支付回调在重复、乱序和超时重试下都只入账一次，并能每日对账。', gaps: ['能否改表结构未说明', '支付平台重试策略未说明'], whyThisCount: null, rejectedAlternatives: [] }],
    proposals: [], judgments: [], candidates: [], decision: null, docs: structuredClone(EMPTY_DOCS),
    gates: [gate('G1_answers', t(3.15), t(27.4), { action: 'submit' }, { questionCount: 3 })],
    jobBatch: 0, jobs: [], finalChoice: null,
  };
  const trails = {
    't-clarify-claude-a1': trail(byId('t-clarify-claude-a1'), [started('claude-opus-5-5', 'max'), [12, 'tool', '读取需求快照 v1'], [95, 'message', '复述需求：重复、乱序、超时重试都不能产生重复入账，并能按流水号对账。'], [180, 'message', '提出 3 个澄清问题：唯一索引、平台重试策略、对账报表。']]),
    't-r1-propose-claude-a1': trail(byId('t-r1-propose-claude-a1'), [started('claude-opus-5-5', 'max'), [18, 'tool', '读取需求快照 v2（合并了 3 条回答）'], [96, 'retry', '接口返回 429，等待 30 秒后重试（1/2）'], [150, 'retry', '接口返回 429，等待 60 秒后重试（2/2）'], [203, 'stderr', '执行端报告额度或频率受限：rate_limited']]),
  };
  return { run: full, trails, docs: {}, files: {} };
}
