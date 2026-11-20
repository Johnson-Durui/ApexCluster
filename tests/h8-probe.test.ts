import assert from 'node:assert/strict';
import { test } from 'node:test';
import { h8ProbeRequest, h8SmokeVerdict } from '../docs/verification/v05-h8-probe.js';
import type { LiveProbeResult } from '../src/probe.js';

test('H8 默认仅显示计划，真实调用必须显式 yes 且限定单一角色', () => {
  assert.deepEqual(h8ProbeRequest(['--role=sol']), { role: 'sol', confirmed: false });
  assert.deepEqual(h8ProbeRequest(['--role=astra', '--yes']), { role: 'astra', confirmed: true });
  for (const args of [[], ['--yes'], ['--role=sol', '--role=claude', '--yes'], ['--role=grok'], ['--role=sol', '--effort=low'], ['--role=sol', '--retry']]) {
    assert.throws(() => h8ProbeRequest(args), /用法/);
  }
});

test('H8 前置 smoke 不提升能力；明确的型号或强度不符必须失败', () => {
  const result = { model: 'gpt-6-astra', effort: 'max', status: 'succeeded', outputValid: true,
    meta: { reportedModels: [], reportedEffort: null, modelConfirmed: false, effortConfirmed: false } } as unknown as LiveProbeResult;
  assert.equal(h8SmokeVerdict(result).smokeSucceeded, true);
  assert.equal(h8SmokeVerdict(result).contextValidationComplete, false);
  assert.equal(h8SmokeVerdict(result).canEnableResume, false);
  result.meta.reportedModels = ['gpt-6-luna'];
  assert.equal(h8SmokeVerdict(result).smokeSucceeded, false);
  result.meta.reportedModels = ['gpt-6-astra'];
  result.meta.reportedEffort = 'low';
  assert.equal(h8SmokeVerdict(result).smokeSucceeded, false);
  result.meta.reportedEffort = 'max';
  result.meta.terminationWarning = 'unknown';
  assert.equal(h8SmokeVerdict(result).smokeSucceeded, false);
});
