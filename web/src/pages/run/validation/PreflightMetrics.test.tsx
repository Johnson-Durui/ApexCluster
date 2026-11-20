import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Run, RunMetrics, ValidationJob } from '../../../lib/types';
import { PreflightFacts, ignorePreflightDisabled } from './ValidationPanel';
import { MetricsView } from './RecordsPanel';

const run = { preflight: { enabled: true } } as Run;
const job = {
  id: 'j-C1-1',
  preflight: {
    ok: false,
    checkedAt: '2026-10-21T01:02:03.000Z',
    items: [
      { check: 'Node.js', status: 'ok', detail: 'v24.0.0' },
      { check: 'Git', status: 'missing', detail: '未找到 git' },
      { check: '网络', status: 'warn', detail: '暂时不可达' },
    ],
  },
  preflightOverride: { checkedAt: '2026-10-21T01:02:03.000Z', reason: '离线演示环境，已确认依赖齐备', at: '2026-10-21T01:04:00.000Z' },
} as ValidationJob;

test('预检事实表显示检查结果、时间与已记录的忽略理由', () => {
  const html = renderToStaticMarkup(<PreflightFacts run={run} job={job} checking={false} />);
  expect(html).toContain('环境预检');
  expect(html).toContain('Node.js');
  expect(html).toContain('缺失');
  expect(html).toContain('警告');
  expect(html).toContain('离线演示环境，已确认依赖齐备');
});

test('运行创建时关闭优先于作业缺少预检字段，不误标为旧记录', () => {
  const html = renderToStaticMarkup(<PreflightFacts run={{ preflight: { enabled: false } } as Run} job={{ id: 'j-disabled' } as ValidationJob} checking={false} />);
  expect(html).toContain('创建时关闭');
  expect(html).not.toContain('旧记录');
});

test('活动覆盖被重试清除后仍显示不可变忽略审计和全部历史报告', () => {
  const audited = {
    ...job,
    preflightOverride: null,
    preflightHistory: [{ ok: false, checkedAt: '2026-10-21T00:50:00.000Z', items: [{ check: '历史 Git', status: 'missing', detail: '历史报告仍缺失' }] }],
    preflightAudit: [{ report: job.preflight, reason: '已由管理员确认离线工具链', ignoredAt: '2026-10-21T01:04:00.000Z' }],
  } as ValidationJob;
  const html = renderToStaticMarkup(<PreflightFacts run={run} job={audited} checking={false} />);
  expect(html).toContain('预检历史与忽略记录');
  expect(html).toContain('历史报告仍缺失');
  expect(html).toContain('已由管理员确认离线工具链');
  expect(html).not.toContain('已忽略此版预检并继续</b><p></p>');
});

test('忽略预检继续必须填写非空理由', () => {
  expect(ignorePreflightDisabled('', false)).toBe(true);
  expect(ignorePreflightDisabled('   ', false)).toBe(true);
  expect(ignorePreflightDisabled('已人工确认环境', false)).toBe(false);
  expect(ignorePreflightDisabled('已人工确认环境', true)).toBe(true);
});

test('未知度量显示未知，不伪装成零分钟或零轮', () => {
  const metrics = {
    runId: 'r1',
    asOf: '2026-10-21T01:05:00.000Z',
    grouping: { mode: 'live', specRefs: [], frozenConfigFingerprint: null },
    modelTime: { total: { minutes: 0, knownCount: 0, unknownCount: 2 }, buckets: [{ phase: 'build', role: 'sol', kind: 'repair', status: 'unknown', minutes: 0, knownCount: 0, unknownCount: 1 }] },
    wallClockMinutes: null,
    gateWait: { total: { minutes: 0, knownCount: 0, unknownCount: 1 }, gates: [] },
    clarification: { questionCount: 0, answeredCount: 0, answerRate: null },
    firstRoundVerification: null,
    buildAttempts: 0,
    buildRounds: null,
    reviewSequence: null,
    quotaBlocks: 0,
  } satisfies RunMetrics;
  const html = renderToStaticMarkup(<MetricsView metrics={metrics} />);
  expect(html).toContain('未知');
  expect(html).toContain('结构修复');
  expect(html).toContain('轮次数据尚未记录');
  expect(html).not.toContain('0.0 分钟');
  expect(html).not.toContain('0 轮');
});
