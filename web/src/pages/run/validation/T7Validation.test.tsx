import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BuildRound, Run, ValidationJob } from '../../../lib/types';
import ValidationPanel, { BudgetFacts, FinalReviewFacts, RoundEvidence, contextUsageText, finalReviewReworkBlockReason, hasVerifiedReworkDefects, isBudgetExhausted, lightReworkBlockReason, safeLightReworkLocation, sessionInvocationSummary } from './ValidationPanel';

const budget = {
  limits: { maxRounds: 3, maxWriterSessions: 8, maxModelCalls: 12, maxActiveMinutes: 180 },
  usage: { buildRounds: 2, writerSessions: 2, modelCalls: 5, activeMs: 3_600_000 },
  reservedCalls: ['call-final'], reservedWriterSessions: [], exhaustedReason: null, calls: [],
};

describe('T7 作业证据界面', () => {
  it('未知上下文不会伪装成 0', () => {
    const text = contextUsageText({ usageSemantics: 'unknown', contextTokensPeak: null, contextRatioPeak: null });
    expect(text).toContain('unknown');
    expect(text).not.toContain('0 tokens');
  });
  it('逻辑会话单独统计 initial 与结构修复 CLI 调用', () => {
    expect(sessionInvocationSummary({ invocations: [{ kind: 'initial' }, { kind: 'repair' }, { kind: 'repair' }] })).toBe('3 次 CLI 调用 · initial 1 · 结构修复 2');
  });
  it('旧会话缺少调用明细时保持 unknown', () => {
    const text = sessionInvocationSummary({});
    expect(text).toContain('unknown');
    expect(text).not.toContain('0 次');
  });
  it('同时显示用量、预留和上限', () => {
    const html = renderToStaticMarkup(<BudgetFacts job={{ budget } as unknown as ValidationJob} />);
    expect(html).toContain('2 / 3');
    expect(html).toContain('5 / 12');
    expect(html).toContain('1 调用');
    expect(html).toContain('60 / 180 分钟');
  });

  it('预算耗尽时明确要求新建 G2 批次', () => {
    const job = { budget: { ...budget, exhaustedReason: '模型调用达上限' } } as unknown as ValidationJob;
    const html = renderToStaticMarkup(<BudgetFacts job={job} />);
    expect(isBudgetExhausted(job)).toBe(true);
    expect(html).toContain('不能继续重试或返工');
    expect(html).toContain('回到 G2');
  });

  it('只有程序核对的缺陷才能驱动返工', () => {
    expect(hasVerifiedReworkDefects({ rounds: [{ verifiedDefectIds: [] }] } as unknown as ValidationJob)).toBe(false);
    expect(hasVerifiedReworkDefects({ rounds: [{ verifiedDefectIds: ['D1'] }] } as unknown as ValidationJob)).toBe(true);
  });

  it('Grok 轻量返工只接受一次，当前 minor 实现缺陷最多涉及五个安全文件', () => {
    const defect = { id: 'D1', severity: 'minor', failureClass: 'implementation_defect', location: 'src/a.ts:12:3', fix: '修正边界判断' };
    const round = { round: 1, writer: 'sol', staleReason: null, workspaceCommit: 'abc', treeHash: 'tree', reviewIntegrity: { ok: true, errors: [] }, evaluation: { specRef: 'spec-1', round: 1, workspaceCommit: 'abc', defects: [defect] }, verifiedDefectIds: ['D1'] };
    const job = { spec: { ref: 'spec-1' }, lightRework: { enabled: true, minutes: 5, capabilityRef: 'cap-1' }, rounds: [round], writeLock: null, budget: { ...budget, exhaustedReason: null } } as unknown as ValidationJob;
    const run = { evaluator: { enabled: true }, contextBudget: { enabled: false } } as Run;
    expect(lightReworkBlockReason(run, job)).toBeNull();
    expect(lightReworkBlockReason(run, { ...job, rounds: [{ ...round, writer: 'grok' }] } as unknown as ValidationJob)).toContain('已经使用过');
    expect(lightReworkBlockReason(run, { ...job, rounds: [{ ...round, evaluation: { ...round.evaluation, defects: [{ ...defect, severity: 'major' }] } }] } as unknown as ValidationJob)).toContain('minor');
    const sixDefects = Array.from({ length: 6 }, (_, index) => ({ ...defect, id: `D${index + 1}`, location: index % 2 ? 'src/a.ts:12' : 'SRC/b.ts:8' }));
    expect(lightReworkBlockReason(run, { ...job, rounds: [{ ...round, evaluation: { ...round.evaluation, defects: sixDefects }, verifiedDefectIds: sixDefects.map(item => item.id) }] } as unknown as ValidationJob)).toBeNull();
    expect(safeLightReworkLocation('../outside.ts')).toBeNull();
    expect(safeLightReworkLocation('src/a.ts:12:3')).toBe('src/a.ts');
    expect(lightReworkBlockReason(run, { ...job, rounds: [{ ...round, evaluation: { ...round.evaluation, defects: [{ ...defect, fix: ' ' }] } }] } as unknown as ValidationJob)).toContain('修复说明');
  });

  it('Grok 轮次展示 WSL、Windows 评审、允许文件和冻结预算', () => {
    const round = {
      round: 2, kind: 'rework', writer: 'grok', buildTaskId: 'grok-2', evaluateTaskId: 'astra-2', report: null,
      verification: { verdict: 'passed', items: [], selfReportMismatches: [], computedAt: '2026-10-23T08:05:00Z', taskId: 'astra-2', logRange: { from: 41, to: 52 } }, evaluation: null,
      workspaceCommit: 'abcdef1234567890', treeHash: 'tree-new', baselineCommit: 'base', fileTree: [], diffStat: '', reviewWorkspace: null, reviewIntegrity: null,
      verifiedDefectIds: [], reworkBrief: [], outcome: 'pending', staleReason: null, stoppedReason: null, createdAt: '2026-10-23T08:00:00Z', endedAt: null,
      lightRework: { allowedFiles: ['src/a.ts', 'src/b.ts'], sourceCommit: 'source-commit', sourceTreeHash: 'source-tree', capabilityRef: 'cap-ref', minutes: 5, evaluateMinutes: 8, finalMinutes: 6, reservedEvaluateTaskId: 'astra-2', reservedFinalTaskId: 'claude-2' },
    } as BuildRound;
    const html = renderToStaticMarkup(<RoundEvidence round={round} />);
    expect(html).toContain('Grok · High · WSL 隔离写入 + Windows Astra 独立验证');
    expect(html).toContain('src/a.ts');
    expect(html).toContain('source-commit');
    expect(html).toContain('astra-2');
    expect(html).toContain('claude-2');
    expect(html).toContain('日志序列');
    expect(html).toContain('41–52');
    expect(html).toContain('Astra 8 分钟');
  });

  it('Grok 轮缺少轻量返工元数据时不声称 WSL 已成立', () => {
    const round = { round: 2, kind: 'rework', writer: 'grok', buildTaskId: 'grok-2', evaluateTaskId: null, report: null, verification: null, evaluation: null, workspaceCommit: null, treeHash: null, baselineCommit: null, fileTree: [], diffStat: '', reviewWorkspace: null, reviewIntegrity: null, verifiedDefectIds: [], reworkBrief: [], outcome: 'stopped', staleReason: null, stoppedReason: '元数据缺失', createdAt: '2026-10-23T08:00:00Z', endedAt: '2026-10-23T08:01:00Z' } as BuildRound;
    const html = renderToStaticMarkup(<RoundEvidence round={round} />);
    expect(html).toContain('轻量返工元数据缺失');
    expect(html).toContain('不能声称该轮经过受控 WSL');
    expect(html).not.toContain('WSL 隔离写入 + Windows Astra');
  });

  it('启用终审但缺失时不隐藏原因', () => {
    const run = { finalReview: { enabled: true, model: 'claude-opus-5-5', effort: 'xhigh', timeoutMinutes: 30 } } as Run;
    const html = renderToStaticMarkup(<FinalReviewFacts run={run} job={{ finalReview: null, finalReviewMissingReason: '预算不足' } as ValidationJob} />);
    expect(html).toContain('Claude 只读终审');
    expect(html).toContain('缺失');
    expect(html).toContain('预算不足');
  });

  it('旧运行没有终审字段时保持关闭语义', () => {
    const html = renderToStaticMarkup(<FinalReviewFacts run={{} as Run} job={{} as ValidationJob} />);
    expect(html).toContain('旧运行未配置');
    expect(html).not.toContain('缺失');
  });

  it('Astra pass 且 Claude reject 时，可按当前终审意见返工，不要求已核验缺陷', () => {
    const finalReview = {
      specRef: 'spec-1', workspaceCommit: 'abc123', roundsReviewed: [1], verdict: 'reject' as const,
      summary: '框架偏离', findings: [{ round: 1, defectIds: [], severity: 'major' as const, text: '实现未遵循已确认的模块边界' }],
      frameworkCompliance: 'deviations' as const, reworkNotes: [], questions: [],
    };
    const round = {
      round: 1, kind: 'initial', writer: 'sol', buildTaskId: 'b1', evaluateTaskId: 'e1', report: null,
      verification: { verdict: 'passed', items: [{ criterionId: 'AC1', status: 'verified_pass', matchedCommand: 'npm test', exitCode: 0, outputExcerpt: 'ok', note: '' }], selfReportMismatches: [], computedAt: '2026-10-23T08:00:00Z' },
      evaluation: { specRef: 'spec-1', round: 1, workspaceCommit: 'abc123', verdict: 'pass', acceptance: [], defects: [], reworkBrief: [], environmentIssues: [], deviationsNoted: [], questions: [] },
      workspaceCommit: 'abc123', treeHash: 'tree1', baselineCommit: null, fileTree: [], diffStat: '', reviewWorkspace: 'review-copy', reviewIntegrity: { ok: true, errors: [] },
      verifiedDefectIds: [], reworkBrief: [], outcome: 'passed', staleReason: null, stoppedReason: null, createdAt: '2026-10-23T08:00:00Z', endedAt: '2026-10-23T08:10:00Z',
    };
    const job = {
      id: 'j-C1-1', runId: 'r1', batch: 1, candidateId: 'C1', proposalId: 'p1', effort: 'max', effortReason: '单工作流', workspaceDir: 'X:\\fixtures\\demo', gitRepo: true,
      spec: { ref: 'spec-1', candidateId: 'C1', goal: '验证', scopeIn: [], scopeOut: [], acceptance: [{ id: 'AC1', description: '测试通过', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: null }], hypotheses: [], timeboxMinutes: 60, allowNetwork: false, comparisonQuestions: [] },
      status: 'passed', taskIds: [], report: null, verification: round.verification, manualResults: [], failureClass: null, failureClassSource: null,
      devGuideVersion: null, createdAt: '2026-10-23T08:00:00Z', endedAt: '2026-10-23T08:10:00Z', rounds: [round], budget: { ...budget, reservedCalls: [], usage: { ...budget.usage, buildRounds: 1 } },
      finalReview, finalReviewTaskId: 'f1', finalReviewMissingReason: null, finalReviewHistory: [], writeLock: null,
    } as unknown as ValidationJob;
    const run = {
      id: 'r1', mode: 'real', phase: 'final_gate', phaseStatus: 'waiting_user', terminal: null, jobBatch: 1, jobs: [job], proposals: [], tasks: [], preflight: { enabled: false },
      writeDocs: false, writePrd: false, evaluator: { enabled: true, model: 'gpt-6-astra', effort: 'max', timeoutMinutes: 30 }, finalReview: { enabled: true, model: 'claude-opus-5-5', effort: 'xhigh', timeoutMinutes: 30 },
    } as unknown as Run;
    expect(finalReviewReworkBlockReason(run, job)).toBeNull();
    const html = renderToStaticMarkup(<ValidationPanel run={run} busy={false} progress={{}} act={vi.fn()} refresh={vi.fn()} />);
    expect(html).toMatch(/<button>按当前终审意见返工<\/button>/);
    expect(html).toMatch(/<button class="gate" disabled=""[^>]*>按已核验缺陷返工<\/button>/);
  });

  it('终审意见空、证据过期或有写锁时禁止按终审返工', () => {
    const run = { finalReview: { enabled: true } } as Run;
    const baseJob = {
      finalReview: { reworkNotes: [], findings: [{ text: '具体意见' }] }, rounds: [{ staleReason: null }], budget: { ...budget, reservedCalls: [] }, writeLock: null,
    } as unknown as ValidationJob;
    expect(finalReviewReworkBlockReason(run, { ...baseJob, finalReview: { ...baseJob.finalReview!, findings: [], reworkNotes: [] } } as ValidationJob)).toContain('没有具体返工意见');
    expect(finalReviewReworkBlockReason(run, { ...baseJob, rounds: [{ ...baseJob.rounds![0]!, staleReason: '代码已改变' }] } as ValidationJob)).toContain('已过期');
    expect(finalReviewReworkBlockReason(run, { ...baseJob, writeLock: { taskId: 't1', state: 'unconfirmed', reason: '退出未确认' } } as ValidationJob)).toContain('进程树');
  });
});
