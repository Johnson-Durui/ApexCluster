import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { AdjudicationRecord, Run, TaskRecord } from '../../../lib/types';
import DecisionPanel from './DecisionPanel';
import RunHeader from '../header/RunHeader';
import RecordsPanel from '../validation/RecordsPanel';

const at = '2026-10-11T08:00:00.000Z';

function record(overrides: Partial<AdjudicationRecord> = {}): AdjudicationRecord {
  return {
    batch: 1,
    designRound: 1,
    snapshotRef: 'v1-d8',
    decisionComputedAt: at,
    taskId: 't-r1-adjudicate-1-astra-a1',
    requestedAt: at,
    completedAt: at,
    staleReason: null,
    items: [],
    candidateIds: ['C1', 'C2'],
    report: {
      snapshotRef: 'v1-d8',
      recommendation: { candidateId: 'C1', rationale: '现有证据更支持候选一。' },
      items: [
        { itemId: 'U1', verdict: 'resolved', rationale: '已形成建议，仍需实证。', evidence: [{ kind: 'doc', ref: 'H1', summary: '约束记录' }, { kind: 'reasoning', ref: null, summary: '因果链尚待验证' }], verification: '用同一数据集做对比。' },
        { itemId: 'U2', verdict: 'unresolved', rationale: '信息不足。', evidence: [], verification: null },
      ],
      risks: ['样本量有限'],
      questions: [],
    },
    ...overrides,
  };
}

function adjudicationTask(status: TaskRecord['status'], attempt = 1): TaskRecord {
  return {
    id: `t-r1-adjudicate-1-astra-a${attempt}`, runId: 'r-d8', role: 'astra', phase: 'adjudicate', scope: 'r1-adjudicate-1', attempt,
    rootTaskId: 't-r1-adjudicate-1-astra-a1', status, outputValidity: status === 'succeeded' ? 'invalid' : 'pending', validationErrors: [],
    repairAttempted: false, failure: ['failed', 'timed_out', 'interrupted', 'cancelled'].includes(status) ? { kind: status === 'cancelled' ? 'cancelled' : 'process_error', message: '裁决任务未完成' } : null,
    createdAt: at, startedAt: status === 'queued' ? null : at, endedAt: ['queued', 'running'].includes(status) ? null : at,
    lastProgress: null, lastProgressAt: null, meta: null, simulated: true, jobId: null, acceptedDespiteMismatch: false, inputRef: 'v1-d8',
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r-d8', title: 'D8 测试', createdAt: at, updatedAt: at, mode: 'mock', mockScenario: 'needs_adjudication',
    phase: 'framework_gate', phaseStatus: 'waiting_user', blockedReason: null, terminal: null,
    models: {
      claude: { role: 'claude', adapter: 'mock', model: 'claude-opus-5-5', effort: 'max' },
      astra: { role: 'astra', adapter: 'mock', model: 'gpt-6-astra', effort: 'max' },
      sol: { role: 'sol', adapter: 'mock', model: 'gpt-6.1-sol', effort: 'max' },
    },
    clarifyWith: 'both', allowWebResearch: false, writeDocs: false, writePrd: false,
    docWriter: { role: 'sol', model: 'gpt-6.1-sol', effort: 'max' },
    docs: { batch: 0, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 },
    criteria: [], criteriaLockedAt: at,
    decisionParams: { tieMargin: .1, disagreementThreshold: 2, singleJudgeBand: .5, preferredOrigin: 'none', tiebreakCriterionId: null, tiebreakMinGap: .5 },
    snapshots: [{ version: 1, ref: 'v1-d8', hash: 'd8', createdAt: at, reason: '初始', project: { title: 'D8', prompt: '需求', coreFlows: [], existingStack: '', deployment: '', budget: '', acceptance: '', context: '' }, constraints: [], facts: [], assumptions: [], openItems: [] }],
    currentSnapshotVersion: 1, designSnapshotVersion: 1, degraded: [], tasks: [], questions: [], modelNotes: [],
    proposals: [{ id: 'p1', author: 'claude', taskId: 't1', snapshotRef: 'v1-d8', snapshotVersion: 1, designRound: 1, title: '候选一' } as unknown as Run['proposals'][number]],
    judgments: [], equivalenceGroups: {}, manualMerges: [], candidates: [{ id: 'C1', memberProposalIds: ['p1'], origin: 'claude', representativeProposalId: 'p1', possibleDuplicateOf: [], invalidatedAssumptions: [] }], overrides: [],
    decision: {
      outcome: 'needs_verification', basis: null, winnerId: null, conditional: false, contenders: ['C1'], displayOrder: ['C1'],
      totals: [{ candidateId: 'C1', origin: 'claude', status: 'viable', lo: 3, hi: 4, knownScore: 3, unknownWeight: 0, disputedWeight: 1, preferenceEligible: false, eliminatedBy: [], unresolvedConstraints: [] }],
      cells: [], constraints: [], pairwise: [], keyUncertainties: [], suggestedValidation: { candidateIds: ['C1'], reason: '', hypotheses: [] }, selfPreference: [], explanation: ['需要补充证据。'], params: { tieMargin: .1, disagreementThreshold: 2, singleJudgeBand: .5, preferredOrigin: 'none', tiebreakCriterionId: null, tiebreakMinGap: .5 }, judges: ['claude', 'astra'], degraded: false, computedAt: at,
    },
    anonymization: null, recheckBatch: 1, recheckRequests: [], recheckLog: [], gates: [], jobBatch: 0, jobs: [], finalChoice: null, designRound: 1, archivedRounds: [],
    ...overrides,
  };
}

const props = (value: Run) => ({ run: value, busy: false, progress: {}, act: vi.fn(), refresh: vi.fn() });

describe('D8 前端表达', () => {
  test('决策面板分开展示建议、未决项和后续验证', () => {
    const html = renderToStaticMarkup(<DecisionPanel {...props(run({ adjudications: [record()] }))} />);
    expect(html).toContain('Astra Ultra 裁决建议');
    expect(html).toContain('C1 · 候选一');
    expect(html).toContain('已形成裁决建议 · 未验证');
    expect(html).toContain('仍未决');
    expect(html).toContain('用同一数据集做对比');
    expect(html).toContain('推理');
    expect(html).not.toContain('>reasoning<');
    expect(html).toContain('不会自动勾选候选');
  });

  test('待定与过期建议不会被表达为当前推荐', () => {
    const pending = record({ staleReason: '需求快照已变更', report: { ...record().report!, recommendation: { candidateId: null, rationale: '无法形成候选建议。' } } });
    const html = renderToStaticMarkup(<DecisionPanel {...props(run({ adjudications: [pending] }))} />);
    expect(html).toContain('待定 · 暂不推荐候选');
    expect(html).toContain('建议已过期，不可作为当前建议');
  });

  test('记录页兼容没有 adjudications 字段的旧 Run', () => {
    const oldRun = run();
    delete oldRun.adjudications;
    const html = renderToStaticMarkup(<RecordsPanel {...props(oldRun)} />);
    expect(html).toContain('旧运行可以继续查看');
    expect(html).toContain('0 个批次');
  });

  test('裁决阶段阻塞时不显示单模型继续', () => {
    const value = run({ phase: 'adjudicate', phaseStatus: 'blocked', blockedReason: 'Ultra 任务失败', tasks: [adjudicationTask('failed')], adjudications: [record({ report: null, completedAt: null })] });
    const html = renderToStaticMarkup(<RunHeader {...props(value)} />);
    expect(html).toContain('Ultra 裁决');
    expect(html).toContain('重试失败的任务');
    expect(html).not.toContain('只用成功的一方继续');
    const panel = renderToStaticMarkup(<DecisionPanel {...props(value)} />);
    expect(panel).toContain('Astra Ultra 裁决已阻塞');
    expect(panel).toContain('尚无合法结果');
    expect(panel).not.toContain('裁决进行中');
  });

  test('失败后重试以最新 scope 任务显示进行中', () => {
    const first = adjudicationTask('failed');
    const retry = adjudicationTask('queued', 2);
    const value = run({ phase: 'adjudicate', phaseStatus: 'running', tasks: [first, retry], adjudications: [record({ taskId: retry.id, report: null, completedAt: null })] });
    const html = renderToStaticMarkup(<DecisionPanel {...props(value)} />);
    expect(html).toContain('Astra Ultra 裁决进行中');
    expect(html).not.toContain('Astra Ultra 裁决已阻塞');
  });

  test('取消整个运行后不再显示裁决进行中', () => {
    const cancelled = adjudicationTask('cancelled');
    const value = run({ phase: 'adjudicate', phaseStatus: 'completed', terminal: 'cancelled', tasks: [cancelled], adjudications: [record({ report: null, completedAt: null })] });
    const html = renderToStaticMarkup(<DecisionPanel {...props(value)} />);
    expect(html).toContain('Astra Ultra 裁决已取消');
    expect(html).toContain('运行已取消');
    expect(html).not.toContain('裁决进行中');
  });

  test('重新设计后的过期建议使用历史轮次候选名称', () => {
    const value = run({ designRound: 2, adjudications: [record({ staleReason: '已重新设计' })] });
    value.proposals = [
      { ...value.proposals[0]!, id: 'p-old', title: '旧轮方案' },
      { ...value.proposals[0]!, id: 'p-new', designRound: 2, title: '新轮同编号方案' },
    ];
    value.candidates = [{ ...value.candidates[0]!, representativeProposalId: 'p-new', memberProposalIds: ['p-new'] }];
    value.archivedRounds = [{ round: 1, snapshotVersion: 1, candidates: [{ ...value.candidates[0]!, representativeProposalId: 'p-old', memberProposalIds: ['p-old'] }], decision: null }];
    const html = renderToStaticMarkup(<DecisionPanel {...props(value)} />);
    expect(html).toContain('C1 · 旧轮方案（设计第 1 轮）');
    expect(html.match(/C1 · 新轮同编号方案/g)).toHaveLength(1);
  });
});
