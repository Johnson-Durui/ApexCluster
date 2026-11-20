import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDecisionRecord } from '../src/core/report.js';
import type { Run } from '../src/core/types.js';

function reportRun(): Run {
  return {
    id: 'r-report', title: 'T8-T12 导出', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T01:00:00Z',
    mode: 'real', mockScenario: null, phase: 'final_gate', phaseStatus: 'waiting_user', blockedReason: null, terminal: null,
    models: {
      claude: { role: 'claude', adapter: 'mock', model: 'claude-test', effort: 'max' },
      astra: { role: 'astra', adapter: 'mock', model: 'astra-test', effort: 'max' },
      sol: { role: 'sol', adapter: 'mock', model: 'sol-test', effort: 'max' },
      grok: { role: 'grok', adapter: 'mock', model: 'grok-test', effort: 'high' },
    },
    clarifyWith: 'both', allowWebResearch: false, degraded: [],
    designMode: 'auto', riskLevel: 'high', designResolution: { mode: 'dual', reasons: ['风险等级为 high'], architects: ['claude', 'astra'], reviewers: ['claude', 'astra'] },
    designResolutionHistory: [{ round: 1, resolution: { mode: 'dual', reasons: ['风险等级为 high'], architects: ['claude', 'astra'], reviewers: ['claude', 'astra'] } }],
    writeDocs: true, writePrd: true, docWriter: { role: 'claude', model: 'claude-test', effort: 'xhigh' },
    docWriters: {
      handbook: { role: 'claude', model: 'claude-test', effort: 'xhigh' },
      devdoc: { role: 'astra', model: 'astra-test', effort: 'max' },
      prd: { role: 'claude', model: 'claude-test', effort: 'xhigh' },
    },
    docs: { batch: 1, bases: [], requests: [], versions: [], missing: [], requestSeq: 0 },
    criteria: [], criteriaLockedAt: null, decisionParams: { delta: 0.5, preferenceMargin: 0.2, tieEpsilon: 0.01 },
    snapshots: [{ version: 1, ref: 'v1-test', reason: 'initial', createdAt: '2026-10-23T00:00:00Z', project: { prompt: '需求', coreFlows: [], existingStack: '', deployment: '', budget: '', acceptance: '', context: '' }, constraints: [], facts: [], assumptions: [], openItems: [] }],
    currentSnapshotVersion: 1, designSnapshotVersion: 1, tasks: [], questions: [], modelNotes: [], proposals: [], judgments: [], equivalenceGroups: {}, manualMerges: [], candidates: [], overrides: [], decision: null, anonymization: null, recheckBatch: 0, recheckRequests: [], recheckLog: [], gates: [], jobBatch: 1,
    contextBudget: { enabled: true }, chores: { digest: true, qgroup: true },
    questionGroups: { taskId: 'qg-1', status: 'skipped', output: null, reason: 'Cursor 能力未验证' },
    jobs: [{
      id: 'j1', runId: 'r-report', batch: 1, candidateId: 'C1', proposalId: 'p1', effort: 'max', effortReason: '测试', workspaceDir: 'work', gitRepo: true,
      spec: { ref: 'spec-1', candidateId: 'C1', goal: '目标', scopeIn: [], scopeOut: [], acceptance: [], hypotheses: [], timeboxMinutes: 60, allowNetwork: false, comparisonQuestions: [] },
      status: 'failed', taskIds: [], report: null, verification: null, manualResults: [], failureClass: null, failureClassSource: null, devGuideVersion: null, createdAt: '2026-10-23T00:00:00Z', endedAt: null,
      digest: { taskId: 'digest-1', status: 'ready', reason: null, output: { specRef: 'spec-1', workspaceCommit: 'abc123', entries: [{ text: '摘要', sourceId: 'SRC-1', quote: '原文' }] } },
      rounds: [{
        round: 1, kind: 'initial', writer: 'sol', buildTaskId: 'build-1', evaluateTaskId: null, report: null, verification: null, evaluation: null,
        workspaceCommit: 'abc123', treeHash: 'tree', baselineCommit: null, fileTree: [], diffStat: '', reviewWorkspace: null, reviewIntegrity: null, verifiedDefectIds: [], reworkBrief: [], outcome: 'stopped', staleReason: null, stoppedReason: '预算停止', createdAt: '2026-10-23T00:00:00Z', endedAt: '2026-10-23T00:30:00Z',
        context: { plan: { specRef: 'spec-1', milestones: [], notes: [] }, planHash: 'plan-hash', planPath: 'PLAN.md', states: [{ id: 'M1', status: 'failed', attempts: 1, verifiedAtCommit: null }], dispatchBlocked: 'M1 失败', sessions: [{
          id: 's1', kind: 'milestone', milestoneIds: ['M1'], finalVerification: false, taskId: 'build-1', startCommit: null, endCommit: 'abc123', threadId: null, resumedFrom: null, resumeReason: 'usage unknown 时新线程', handoffPath: 'HANDOFF.md', verification: null, outcome: 'stopped',
          context: { usageRaw: null, usageSource: null, usageSemantics: 'unknown', contextWindow: null, contextTokensPeak: null, contextRatioPeak: null, compactions: null },
          material: { estimatedTokens: 1200, targetTokens: 4000, estimateReference: 'chars/2.5', omitted: [] }, startedAt: '2026-10-23T00:00:00Z', endedAt: '2026-10-23T00:30:00Z',
        }] },
      }],
    }],
    finalChoice: null, designRound: 1, archivedRounds: [],
  } as unknown as Run;
}

test('导出冻结设计、逐文档作者、Grok来源/跳过原因和T12会话证据', () => {
  const markdown = renderDecisionRecord(reportRun());
  assert.match(markdown, /设计策略（创建时冻结）/);
  assert.match(markdown, /本轮解析：dual/);
  assert.match(markdown, /开发文档（给 AI）撰写者：Astra astra-test · max/);
  assert.match(markdown, /Grok 问题分组提示/);
  assert.match(markdown, /Cursor 能力未验证/);
  assert.match(markdown, /来源锚点：规格 spec-1；提交 abc123/);
  assert.match(markdown, /PLAN：PLAN\.md/);
  assert.match(markdown, /HANDOFF：HANDOFF\.md/);
  assert.match(markdown, /实际上下文：语义 unknown/);
  assert.match(markdown, /窗口 unknown；峰值 unknown/);
  assert.match(markdown, /提示材料估算（非实际上下文）：1200\/4000/);
  assert.match(markdown, /会话停止：outcome=stopped/);
  assert.doesNotMatch(markdown, /窗口 0；峰值 0/);
});

test('旧运行不补写新配置并将上下文能力保持为unknown', () => {
  const run = reportRun();
  delete run.designMode;
  delete run.riskLevel;
  delete run.designResolution;
  delete run.designResolutionHistory;
  delete run.docWriters;
  delete run.contextBudget;
  delete run.chores;
  delete run.questionGroups;
  run.jobs = [];
  const markdown = renderDecisionRecord(run);
  assert.doesNotMatch(markdown, /设计策略（创建时冻结）/);
  assert.doesNotMatch(markdown, /Grok 问题分组提示/);
  assert.match(markdown, /旧版统一撰写者/);
  assert.match(markdown, /上下文健康：治理 unknown/);
  assert.doesNotMatch(markdown, /窗口 0；峰值 0/);
});
