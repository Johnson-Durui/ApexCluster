import { describe, expect, test } from 'vitest';
import type { RunSummary } from '../../lib/types';
import { homeStats, outcomeText, summaryTrack, visibleRuns } from './homeModel';

const at = '2026-10-12T08:00:00.000Z';
const summary = (patch: Partial<RunSummary>): RunSummary => ({ id: 'r-x', title: '运行', mode: 'real', phase: 'answering', phaseStatus: 'waiting_user', terminal: null, createdAt: at, updatedAt: at, ...patch });

describe('运行列表', () => {
  const runs = [
    summary({ id: 'r-wait', title: '麦轮小车上位机', phase: 'final_gate' }),
    summary({ id: 'r-run', title: '记账工具', phase: 'propose', phaseStatus: 'running' }),
    summary({ id: 'r-block', title: '阻塞的运行', phase: 'validate', phaseStatus: 'blocked' }),
    summary({ id: 'r-done', title: '计数器', phase: 'done', phaseStatus: 'completed', terminal: 'done', finalChoice: { candidateId: 'C1', reason: null, at } }),
    summary({ id: 'r-mock', title: '界面验收 · 关键分歧', mode: 'mock', phase: 'done', phaseStatus: 'completed', terminal: 'done' }),
  ];

  test('概况只统计真实运行，早期模拟记录单独计数', () => {
    expect(homeStats(runs)).toEqual({ total: 4, waiting: 1, active: 2, blocked: 1, ended: 1, legacy: 1 });
  });

  test('默认隐藏早期模拟记录；筛选和搜索可组合', () => {
    expect(visibleRuns(runs, { filter: 'all', query: '', showLegacy: false }).map(run => run.id)).toEqual(['r-wait', 'r-run', 'r-block', 'r-done']);
    expect(visibleRuns(runs, { filter: 'all', query: '', showLegacy: true })).toHaveLength(5);
    expect(visibleRuns(runs, { filter: 'active', query: '', showLegacy: false }).map(run => run.id)).toEqual(['r-run', 'r-block']);
    expect(visibleRuns(runs, { filter: 'all', query: '麦轮', showLegacy: false }).map(run => run.id)).toEqual(['r-wait']);
  });

  test('状态文字区分接受、在关卡停止和取消', () => {
    expect(outcomeText(runs[0]!)).toBe('等你决定 · G4 验收 MVP');
    expect(outcomeText(runs[3]!)).toBe('已结束 · 接受 C1');
    expect(outcomeText(summary({ phase: 'done', terminal: 'done', gates: [{ id: 'G2_framework', resolved: true, action: 'stop' }] }))).toBe('已结束 · 在 G2 停止');
    expect(outcomeText(summary({ terminal: 'cancelled' }))).toBe('已取消');
  });

  test('旧服务缺少 v0.4 摘要字段时仍能生成关卡进度', () => {
    const gates = summaryTrack(summary({ phase: 'final_gate' })).filter(item => item.kind === 'gate').map(item => item.state);
    expect(gates).toEqual(['done', 'done', 'done', 'now', 'todo']);
  });
});
