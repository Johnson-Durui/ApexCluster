import { describe, expect, it } from 'vitest';
import type { G2Spec } from './g2Validation';
import { lightReworkG2BlockReason, nextAcceptanceId, validateBuildOverrides, validateG2Specs } from './g2Validation';

const base: G2Spec = {
  candidateId: 'C1', goal: '验证核心闭环', scopeIn: [], scopeOut: [],
  acceptance: [{ id: 'AC1', description: '测试通过', kind: 'command', command: 'npm test', expectExitCode: 0, outputIncludes: null }],
  hypotheses: [], timeboxMinutes: 120, allowNetwork: true,
};

describe('G2 MVP 规格校验', () => {
  it('拒绝没有命令的命令型验收项', () => {
    const spec = { ...base, acceptance: [{ ...base.acceptance[0], command: '  ' }] };
    expect(validateG2Specs(['C1'], [spec])).toContain('C1 · AC1 是命令型验收项，必须填写 PowerShell 命令');
  });

  it('允许人工验收项不填写命令', () => {
    const spec = { ...base, acceptance: [{ ...base.acceptance[0], kind: 'manual' as const, command: null }] };
    expect(validateG2Specs(['C1'], [spec])).toEqual([]);
  });

  it('拒绝空编号和同一规格内的重复编号', () => {
    const spec = { ...base, acceptance: [
      { ...base.acceptance[0], id: '  ' },
      { ...base.acceptance[0], id: 'AC2' },
      { ...base.acceptance[0], id: 'AC2', description: '再次构建' },
    ] };
    expect(validateG2Specs(['C1'], [spec])).toEqual(expect.arrayContaining([
      '候选 C1 的验收项编号不能为空',
      '候选 C1 的验收项编号 AC2 重复',
    ]));
  });

  it('添加验收项时选择最小的未使用编号', () => {
    expect(nextAcceptanceId([
      { ...base.acceptance[0], id: 'AC1' },
      { ...base.acceptance[0], id: 'AC3' },
    ])).toBe('AC2');
  });

  it('拒绝会绕过共同预算的 G2 覆盖', () => {
    expect(validateBuildOverrides(['C1'], { C1: { maxRounds: 5, maxModelCalls: 0 } })).toEqual(expect.arrayContaining([
      '候选 C1 的构建轮数需在 1–4 之间',
      '候选 C1 的模型调用上限需在 1–200 之间',
    ]));
  });

  it('轻量返工要求真实能力、独立评审且关闭 T12，并限制为 1–15 分钟', () => {
    const blocked = { configuredEnabled: true, exactModel: true, evaluatorEnabled: false, contextBudgetEnabled: true, capabilityAvailable: false, capabilityReason: '能力未验证' };
    expect(lightReworkG2BlockReason(blocked)).toBe('能力未验证');
    expect(validateBuildOverrides(['C1'], { C1: { lightReworkEnabled: true, lightReworkMinutes: 16 } }, blocked)).toEqual(expect.arrayContaining([
      '候选 C1 的 Grok 轻量返工时间需在 1–15 分钟之间',
      '候选 C1 不能启用 Grok 轻量返工：能力未验证',
    ]));
    expect(lightReworkG2BlockReason({ configuredEnabled: true, exactModel: true, evaluatorEnabled: true, contextBudgetEnabled: false, capabilityAvailable: true })).toBeNull();
    expect(lightReworkG2BlockReason({ configuredEnabled: false, exactModel: true, evaluatorEnabled: true, contextBudgetEnabled: false, capabilityAvailable: true })).toContain('创建运行时未启用');
  });
});
