import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContextEvidence } from '../docs/verification/v05-h8-evidence.js';

test('Claude modelUsage 与窗口候选只作为观察值，不提升为验证事实', () => {
  const report = analyzeContextEvidence({
    adapter: 'claude-code', cliVersion: '2.1.294', model: 'claude-opus-5-5', effort: 'max',
    helpText: '--autocompact --max-turns <n>',
    events: [{
      type: 'result', result: 'SECRET OUTPUT',
      usage: { input_tokens: 1_200, cache_read_input_tokens: 800, output_tokens: 25, cost_usd: 99 },
      modelUsage: {
        'claude-opus-5-5-20260922': { inputTokens: 1_200, outputTokens: 25, contextWindow: 200_000, secret: 'do not copy' },
      },
      session_id: 'secret-session',
    }],
  });
  assert.equal(report.contextWindow, null);
  assert.equal(report.usageSemantics, 'unknown');
  assert.equal(report.canEnableResume, false);
  assert.deepEqual(report.observations.windows, [{
    eventIndex: 0, source: 'modelUsage.contextWindow', model: 'claude-opus-5-5-20260922', value: 200_000,
  }]);
  assert.equal(report.observations.helpParameters.autocompactListed, true);
  assert.equal(report.guards.autoCompactGuardVerified, false);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /SECRET OUTPUT|secret-session|do not copy|cost_usd/);
});

test('Claude modelUsage 仅含窗口候选时仍保留该安全字段', () => {
  const report = analyzeContextEvidence({
    adapter: 'claude-code', cliVersion: '2.1.294', model: 'claude-opus-5-5', effort: 'max',
    events: [{ type: 'result', modelUsage: { 'claude-opus-5-5': { context_window: 200_000, auth: 'secret' } } }],
  });
  assert.deepEqual(report.retainedEvents, [{
    eventIndex: 0,
    eventType: 'result',
    modelUsage: [{ model: 'claude-opus-5-5', values: { context_window: 200_000 } }],
  }]);
  assert.equal(report.contextWindow, null);
  assert.doesNotMatch(JSON.stringify(report), /auth|secret/);
});

test('Codex turn.completed usage 保持 unknown，不用 token 或 cached 字段推导占用', () => {
  const report = analyzeContextEvidence({
    adapter: 'codex', cliVersion: '0.95.0', model: 'gpt-6.1-sol', effort: 'max',
    helpText: '-c model_auto_compact_token_limit=1234',
    events: [{ type: 'turn.completed', usage: {
      input_tokens: 80_000, cached_input_tokens: 70_000, output_tokens: 2_000, reasoning_output_tokens: 1_000,
    } }],
  });
  assert.equal(report.usageSemantics, 'unknown');
  assert.equal(report.contextWindow, null);
  assert.equal(report.compactions, null);
  assert.equal(report.observations.usage[0]?.values.cached_input_tokens, 70_000);
  assert.equal(report.observations.helpParameters.modelAutoCompactTokenLimitListed, true);
  assert.equal(report.guards.compactionObservabilityVerified, false);
  assert.equal(report.canEnableResume, false);
});

test('消息中的 usage、window、compact 关键词不被认作遥测事件', () => {
  const report = analyzeContextEvidence({
    adapter: 'codex', cliVersion: '1', model: 'gpt-6-astra', effort: 'max',
    events: [
      { type: 'item.completed', item: { type: 'agent_message', text: 'usage contextWindow compact', usage: { input_tokens: 1 } } },
      { type: 'assistant', message: { content: 'conversation.compacted' }, context_window: 256_000 },
    ],
  });
  assert.deepEqual(report.retainedEvents, []);
  assert.deepEqual(report.observations.usage, []);
  assert.deepEqual(report.observations.windows, []);
  assert.deepEqual(report.observations.compactions, []);
  assert.equal(report.compactions, null);
});

test('缺版本且无事件时所有能力关闭并明确原因', () => {
  const report = analyzeContextEvidence({ adapter: 'claude-code', cliVersion: null, model: null, effort: null, events: [] });
  assert.equal(report.cliVersion, null);
  assert.equal(report.contextWindow, null);
  assert.equal(report.usageSemantics, 'unknown');
  assert.equal(report.compactions, null);
  assert.equal(report.canEnableResume, false);
  assert.deepEqual(Object.values(report.guards), [false, false, false, false, false]);
  assert.match(report.reasons.join('\n'), /缺少 CLI 版本/);
  assert.match(report.reasons.join('\n'), /没有原始事件/);
});

test('非法负值、非有限数和型号名中的窗口数字都不会被误认', () => {
  const report = analyzeContextEvidence({
    adapter: 'claude-code', cliVersion: '2', model: 'claude-256k-preview', effort: 'max',
    events: [{
      type: 'result',
      usage: { input_tokens: -1, output_tokens: Number.POSITIVE_INFINITY },
      context_window: -256_000,
      modelUsage: { 'claude-256k-preview': { inputTokens: -5, contextWindow: -1 } },
    }],
  });
  assert.deepEqual(report.retainedEvents, []);
  assert.deepEqual(report.observations.windows, []);
  assert.deepEqual(report.observations.usage, []);
  assert.equal(report.contextWindow, null);
});

test('只有明确类型的真实 compact 事件计为观察次数，缺事件仍为 null', () => {
  const observed = analyzeContextEvidence({
    adapter: 'codex', cliVersion: '1', model: 'gpt-6.1-sol', effort: 'max',
    events: [
      { type: 'context.compacted', before_tokens: 90_000, after_tokens: 30_000, summary: 'sensitive summary' },
      { type: 'item.completed', item: { text: 'context.compacted' } },
    ],
  });
  assert.equal(observed.compactions, 1);
  assert.deepEqual(observed.observations.compactions, [{
    eventIndex: 0, eventType: 'context.compacted', fields: { before_tokens: 90_000, after_tokens: 30_000 },
  }]);
  assert.equal(observed.guards.compactionObservabilityVerified, false);
  assert.doesNotMatch(JSON.stringify(observed), /sensitive summary/);

  const absent = analyzeContextEvidence({ adapter: 'codex', cliVersion: '1', model: 'gpt-6.1-sol', effort: 'max', events: [] });
  assert.equal(absent.compactions, null);
});
