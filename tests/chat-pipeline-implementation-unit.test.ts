import assert from 'node:assert/strict';
import test from 'node:test';
import type { FrozenContract } from '../src/pipeline/contract.js';
import { milestonePathIssues, validateImplementationPlan } from '../src/pipeline/implementation.js';
import type { ImplementationState, MilestoneProof, PipelineReview } from '../src/pipeline/implementation-types.js';
import { buildImplementationTrace } from '../src/pipeline/trace.js';

const contractHash = 'a'.repeat(64);
const contract: FrozenContract = {
  version: 1,
  requirements: [{ id: 'R-001', text: 'small product', sourceIds: ['message:1'], assumptionIds: [] }],
  acceptance: [{ id: 'AC-001', requirementIds: ['R-001'], kind: 'manual', description: 'user approves' }],
  assumptions: [],
  sources: [{ id: 'message:1', sha256: 'b'.repeat(64) }],
  artifacts: [],
  sha256: contractHash,
};

const input = {
  milestones: [
    {
      id: 'M-SOL', title: 'Sol half', owner: 'sol' as const, acceptanceIds: ['AC-001'], dependsOn: [], paths: ['src'],
      checks: [{ id: 'check-sol', acceptanceIds: ['AC-001'], argv: ['npm', 'test'], cwd: '.', timeoutMs: 1_000 }],
    },
    {
      id: 'M-OPUS', title: 'Opus half', owner: 'opus' as const, acceptanceIds: ['AC-001'], dependsOn: [], paths: ['web'],
      checks: [{ id: 'check-opus', acceptanceIds: ['AC-001'], argv: ['npm', 'test'], cwd: '.', timeoutMs: 1_000 }],
    },
  ],
};

const proof = (checkId: string): MilestoneProof => ({
  checkId, ref: `receipts/${checkId}.json`, hash: 'c'.repeat(64), snapshotId: 'snapshot', fingerprint: 'fingerprint', ok: true,
});

const review = (hash: string): PipelineReview => ({
  subjectHash: hash,
  reviewerTaskId: 'review', reviewer: 'opus', reviewerModel: 'claude-opus-5-5', reviewerFamily: 'anthropic',
  author: 'sol', authorModel: 'gpt-6.1-sol', authorFamily: 'openai', outcome: 'passed', defects: [], checks: [],
});

test('one-AC plans can overlap across both implementation owners', () => {
  const result = validateImplementationPlan(input, contract, contractHash);
  assert.deepEqual(result.plan.milestones.map(item => item.id), ['M-OPUS', 'M-SOL']);
  assert.deepEqual(result.plan.milestones.flatMap(item => item.acceptanceIds), ['AC-001', 'AC-001']);
});

test('plans and drift declarations cannot claim program-owned paths', () => {
  for (const path of ['.', '.agent', '.agent/STATE.json', 'AGENT-OUTPUTS', 'docs', 'DOCS/prd.md']) {
    const invalid = structuredClone(input);
    invalid.milestones[0]!.paths = [path];
    assert.throws(() => validateImplementationPlan(invalid, contract, contractHash));
  }
  assert.deepEqual(milestonePathIssues(['.agent'], { created: [], modified: ['.agent/STATE.json'], deleted: [] }), [
    '里程碑声明了无效或保留路径 ".agent"',
    '改动越出里程碑声明路径：.agent/STATE.json',
  ]);
});

test('TRACE preserves every AC owner and keeps manual AC unverified without changing review', () => {
  const validated = validateImplementationPlan(input, contract, contractHash);
  const state: ImplementationState = {
    version: 1,
    round: 1,
    rootTaskId: 'root',
    proposals: [{ plan: validated.plan, ref: '.agent/PLAN.json', hash: validated.hash, reviewTaskId: 'review', review: review(validated.hash) }],
    planHash: validated.hash,
    milestones: validated.plan.milestones.map(milestone => ({
      id: milestone.id,
      status: 'complete',
      attempts: [{ number: 1, authorTaskId: `author-${milestone.id}`, checks: milestone.checks.map(check => proof(check.id)) }],
    })),
    acceptance: { taskId: 'acceptance', checks: [], manualIds: ['AC-001'] },
  };
  const result = buildImplementationTrace(contract, state);
  assert.deepEqual(result.trace.entries[0]!.milestoneIds, ['M-OPUS', 'M-SOL']);
  assert.equal(result.trace.entries[0]!.milestoneId, 'M-OPUS');
  assert.equal(result.trace.entries[0]!.status, 'unverified');
  assert.deepEqual(result.trace.failed, []);
  assert.deepEqual(result.trace.unverified, ['AC-001']);
  assert.equal(state.proposals[0]!.review!.outcome, 'passed');
  assert.equal(result.text.endsWith('\n'), true);
  assert.equal(buildImplementationTrace(contract, structuredClone(state)).hash, result.hash);
});
