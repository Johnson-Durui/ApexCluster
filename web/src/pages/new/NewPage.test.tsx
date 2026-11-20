import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import NewPage, { buildFeatureInput } from './NewPage';

test('新建评审不再提供模拟模式，启动前必须确认额度', () => {
  const html = renderToStaticMarkup(<NewPage onCreated={vi.fn()} />);
  expect(html).not.toContain('模拟');
  expect(html).not.toContain('场景');
  expect(html).toContain('我了解真实运行会消耗 Claude Pro 和 ChatGPT Pro 订阅额度');
  expect(html).toContain('启动评审…');
  expect(html).toContain('Astra 独立评审每轮构建');
  expect(html).toContain('Claude 只读终审');
  expect(html).toContain('基础调用');
  expect(html).toContain('条件增加');
  expect(html).toContain('每作业上限');
  expect(html).toContain('设计模式');
  expect(html).toContain('风险等级');
  expect(html).toContain('Grok 构建摘要');
  expect(html).toContain('Grok 问题分组提示');
  expect(html).toContain('允许 Grok 轻量返工');
  expect(html).toContain('默认关闭');
  expect(html).toContain('架构说明手册撰写配置');
  expect(html).toContain('显示 unknown，并新建线程');
  expect(html).toContain('默认由 Claude 统一澄清并主导架构，Astra 围绕同一方案补充评审');
  expect(html).toMatch(/aria-label="澄清问题由谁提问"[^>]*><option value="both">两边分别提问（兼容模式）<\/option><option value="claude" selected="">Claude 统一提问<\/option>/);
  expect(html).toMatch(/aria-label="设计模式"[^>]*><option value="auto">自动判断（兼容模式）<\/option><option value="dual">双架构师独立提案（兼容模式）<\/option><option value="single" selected="">Claude 主导 \+ Astra 协作评审<\/option>/);
  expect(html).toContain('已显式选择 Claude 主导架构，Astra 围绕同一方案补充评审。');
  expect(html).toMatch(/<button type="submit" class="primary launch" disabled="">/);
});

test('新能力输入默认关闭并冻结逐文档撰写者', () => {
  const options = buildFeatureInput({
    build: { autoRework: false, maxRounds: 3, maxWriterSessions: 12, maxModelCalls: 20, maxActiveMinutes: 360, resumePolicy: 'budgeted', lightReworkEnabled: true, lightReworkMinutes: 5 },
    contextEnabled: false, resumePolicy: 'budgeted', evaluatorEnabled: true, lightReworkAvailable: false, lightReworkSupported: true, digestEnabled: true, qgroupEnabled: true, grokAvailable: false,
    designMode: 'single', riskLevel: 'medium',
    docWriters: { handbook: { role: 'claude', effort: 'xhigh' }, devdoc: { role: 'astra', effort: 'max' }, prd: { role: 'claude', effort: 'xhigh' } },
  });
  expect(options.contextBudget).toEqual({ enabled: false });
  expect(options.build?.resumePolicy).toBe('never');
  expect(options.build?.lightReworkEnabled).toBe(false);
  expect(options.chores).toEqual({ digest: false, qgroup: false });
  expect(options.designMode).toBe('single');
  expect(options.docWriters?.devdoc).toEqual({ role: 'astra', effort: 'max' });
});

test('轻量返工仅在能力可用、独立评审开启且上下文预算关闭时冻结', () => {
  const shared = {
    build: { autoRework: false, maxRounds: 3, maxWriterSessions: 12, maxModelCalls: 20, maxActiveMinutes: 360, resumePolicy: 'never' as const, lightReworkEnabled: true, lightReworkMinutes: 7 },
    resumePolicy: 'never' as const, digestEnabled: false, qgroupEnabled: false, grokAvailable: true,
    designMode: 'auto' as const, riskLevel: 'medium' as const,
    docWriters: { handbook: { role: 'claude' as const, effort: 'xhigh' as const }, devdoc: { role: 'astra' as const, effort: 'max' as const }, prd: { role: 'claude' as const, effort: 'xhigh' as const } },
  };
  expect(buildFeatureInput({ ...shared, contextEnabled: false, evaluatorEnabled: true, lightReworkAvailable: true, lightReworkSupported: true }).build?.lightReworkEnabled).toBe(true);
  expect(buildFeatureInput({ ...shared, contextEnabled: true, evaluatorEnabled: true, lightReworkAvailable: true, lightReworkSupported: true }).build?.lightReworkEnabled).toBe(false);
  expect(buildFeatureInput({ ...shared, contextEnabled: false, evaluatorEnabled: false, lightReworkAvailable: true, lightReworkSupported: true }).build?.lightReworkEnabled).toBe(false);
  const legacy = buildFeatureInput({ ...shared, contextEnabled: false, evaluatorEnabled: true, lightReworkAvailable: true, lightReworkSupported: false }).build!;
  expect(Object.prototype.hasOwnProperty.call(legacy, 'lightReworkEnabled')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(legacy, 'lightReworkMinutes')).toBe(false);
});
