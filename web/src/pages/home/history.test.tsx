import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { RunMetrics, RunSummary } from '../../lib/types';
import HomePage from './HomePage';
import { HistoryQueue, type QueueProps } from './HistoryQueue';
import HistoryInspector, { SeatBars } from './HistoryInspector';
import { filterCounts, gateCells, kpiParts, metricsStale, miniKpis, optionLabel, orderedRows, rowStatusWord, runKind, seatMinutes, sortRuns } from './historyModel';

const at = '2026-10-12T08:00:00.000Z';
const summary = (patch: Partial<RunSummary>): RunSummary => ({ id: 'r-x', title: '运行', mode: 'real', phase: 'answering', phaseStatus: 'waiting_user', terminal: null, createdAt: at, updatedAt: at, ...patch });
const runs = [
  summary({ id: 'r-run', title: '记账工具', phase: 'propose', phaseStatus: 'running', updatedAt: '2026-10-14T08:00:00.000Z' }),
  summary({ id: 'r-wait', title: '麦轮小车上位机', phase: 'framework_gate', updatedAt: '2026-10-13T08:00:00.000Z' }),
  summary({ id: 'r-block', title: '阻塞的运行', phase: 'docs', phaseStatus: 'blocked' }),
  summary({ id: 'r-done', title: '计数器', phase: 'done', phaseStatus: 'completed', terminal: 'done', finalChoice: { candidateId: 'C1', reason: null, at } }),
  summary({ id: 'r-stop', title: '停在 G2', phase: 'done', phaseStatus: 'completed', terminal: 'done', gates: [{ id: 'G2_framework', resolved: true, action: 'stop' }] }),
  summary({ id: 'r-mock', title: '界面验收', mode: 'mock', phase: 'done', phaseStatus: 'completed', terminal: 'done' }),
];

const metrics = (buckets: RunMetrics['modelTime']['buckets'], total = { minutes: 12, knownCount: 2, unknownCount: 3 }): RunMetrics => ({
  runId: 'r-x', asOf: at, grouping: { mode: 'live', specRefs: [], frozenConfigFingerprint: null },
  modelTime: { total, buckets }, wallClockMinutes: null, gateWait: { total: { minutes: 0, knownCount: 0, unknownCount: 0 }, gates: [] },
  clarification: { questionCount: 0, answeredCount: 0, answerRate: null }, firstRoundVerification: null, buildAttempts: 2, buildRounds: null, reviewSequence: null, quotaBlocks: 0,
});

describe('任务历史 · 队列模型', () => {
  test('等你决定的运行排在最前，其余按所选时间倒序', () => {
    expect(orderedRows(sortRuns(runs, 'updated')).map(run => run.id).slice(0, 2)).toEqual(['r-wait', 'r-run']);
  });

  test('状态词沿用 homeModel 文案，等你决定只留关卡编号', () => {
    expect(rowStatusWord(runs[1]!)).toBe('等你决定 · G2');
    expect(rowStatusWord(runs[3]!)).toBe('已结束 · 接受 C1');
    expect(rowStatusWord(runs[4]!)).toBe('已结束 · 在 G2 停止');
    expect(runs.map(runKind)).toEqual(['run', 'you', 'block', 'ok', 'stop', 'ok']);
    expect(optionLabel(runs[1]!)).toMatch(/^麦轮小车上位机，等你决定 · G2 确认框架，确认框架 G2，更新于 /);
  });

  test('筛选计数随早期模拟记录开关变化', () => {
    expect(filterCounts(runs, false)).toEqual({ all: 5, waiting: 1, active: 2, ended: 2 });
    expect(filterCounts(runs, true).all).toBe(6);
  });

  test('关卡轨道只有真正等你时才用“等你决定”', () => {
    expect(gateCells(runs[1]!).map(cell => cell.kind)).toEqual(['ok', 'you', 'idle', 'idle', 'idle']);
    expect(gateCells(summary({ phase: 'answering', phaseStatus: 'running' }))[0]).toMatchObject({ kind: 'run', word: '进行中' });
  });

  test('席位分钟按角色汇总；全部未知的席位标记为未知', () => {
    const seats = seatMinutes(metrics([
      { phase: 'propose', role: 'astra', kind: 'initial', status: 'succeeded', minutes: 4, knownCount: 1, unknownCount: 0 },
      { phase: 'propose', role: 'claude', kind: 'initial', status: 'succeeded', minutes: 8, knownCount: 1, unknownCount: 1 },
      { phase: 'review', role: 'claude', kind: 'unknown', status: 'unknown', minutes: 0, knownCount: 0, unknownCount: 1 },
      { phase: 'build', role: 'sol', kind: 'unknown', status: 'unknown', minutes: 0, knownCount: 0, unknownCount: 2 },
    ]));
    expect(seats.map(seat => [seat.role, seat.minutes, seat.known])).toEqual([['claude', 8, true], ['astra', 4, true], ['sol', 0, false]]);
  });

  test('迷你指标：未知不按 0 计，缺失显示 —', () => {
    const values = miniKpis(metrics([], { minutes: 0, knownCount: 0, unknownCount: 4 })).map(item => item.value);
    expect(values).toEqual(['未知', '未知', '—', 2]);
    expect(miniKpis(null).map(item => item.value)).toEqual(['—', '—', '—', '—']);
    expect(kpiParts(52148, 'duration')).toEqual(['36.2', '天']);
    expect(kpiParts(159, 'minutes')).toEqual(['159', '分']);
  });
});

describe('任务历史 · 渲染', () => {
  test('首次读取时 KPI 显示 —，不显示 0，也不显示空状态', () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html.match(/<b class="kpi-num numeral">—<\/b>/g)).toHaveLength(4);
    expect(html).not.toMatch(/<b class="kpi-num numeral">0+<\/b>/);
    expect(html).toContain('正在读取运行列表…');
    expect(html).toContain('<h1>任务历史</h1>');
    expect(html).not.toContain('还没有评审运行');
  });

  const queue = (patch: Partial<QueueProps>): QueueProps => ({
    filter: 'all', onFilter: vi.fn(), counts: null, showLegacy: false, onLegacy: vi.fn(), legacyCount: 0, sort: 'updated', onSort: vi.fn(),
    rows: [], total: 0, hasRealRuns: false, loading: false, loaded: false, error: '', onRetry: vi.fn(), query: '', onQuery: vi.fn(),
    selected: null, onSelect: vi.fn(), onOpen: vi.fn(), compact: false, listRef: { current: null }, ...patch,
  });

  test('首次读取失败：显示原始错误和重试，不显示空状态或新建入口', () => {
    const html = renderToStaticMarkup(<HistoryQueue {...queue({ error: 'Failed to fetch' })} />);
    expect(html).toContain('Failed to fetch');
    expect(html).toContain('重试连接');
    expect(html).not.toContain('还没有评审运行');
    expect(html).not.toContain('新建评审');
  });

  test('成功读取且没有真实运行时才显示空状态与新建评审', () => {
    const html = renderToStaticMarkup(<HistoryQueue {...queue({ loaded: true })} />);
    expect(html).toContain('还没有评审运行');
    expect(html).toContain('新建评审');
  });

  test('运行列表是 listbox：选项不含链接或按钮，等你决定分组在前', () => {
    const rows = orderedRows(runs.slice(0, 4));
    const html = renderToStaticMarkup(<HistoryQueue {...queue({ loaded: true, rows, total: 4, hasRealRuns: true, selected: 'r-wait' })} />);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-activedescendant="hq-opt-r-wait"');
    expect(html.indexOf('等你决定 · 1')).toBeLessThan(html.indexOf('其他运行 · 3'));
    const options = html.split('role="option"').slice(1).map(part => part.split('</div><div role="option"')[0] ?? part);
    expect(options).toHaveLength(4);
    for (const option of options) expect(option).not.toMatch(/<(a|button)[\s>]/);
  });

  test('knownCount 为 0 的席位显示“未知”，不画 0 宽度条', () => {
    const seats = seatMinutes(metrics([
      { phase: 'propose', role: 'claude', kind: 'initial', status: 'succeeded', minutes: 8, knownCount: 1, unknownCount: 0 },
      { phase: 'build', role: 'sol', kind: 'unknown', status: 'unknown', minutes: 0, knownCount: 0, unknownCount: 2 },
    ]));
    const html = renderToStaticMarkup(<SeatBars seats={seats} unknownTotal={2} animate={false} />);
    expect(html.match(/class="hi-track"/g)).toHaveLength(1);
    expect(html).toContain('未知 · 2 项缺少时间');
    expect(html).toContain('程序时间戳 · 未知 2 项不按 0 计');
  });
});

describe('任务历史 · 评审修复回归', () => {
  // Read from disk: Vitest serves CSS imports as empty strings.
  const homeCss = readFileSync(new URL('./home.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  test('刷新带来更新的 updatedAt 时，同一运行的指标视为过期并重新读取', () => {
    const run = runs[0]!;
    const read = { id: run.id, updatedAt: run.updatedAt, data: metrics([]) };
    expect(metricsStale(read, run)).toBe(false);
    expect(metricsStale(read, { ...run, updatedAt: '2026-10-15T08:00:00.000Z' })).toBe(true);
    expect(metricsStale(read, runs[1]!)).toBe(true);
    expect(metricsStale(null, run)).toBe(true);
  });

  test('窄窗口：刚由单击打开的检视层让第二次点击落到行上，双击仍能打开运行', () => {
    const props = { run: runs[1]!, config: null, configError: false, onRetryConfig: vi.fn(), animate: false, onBack: vi.fn() };
    const armed = renderToStaticMarkup(<HistoryInspector {...props} arming />);
    expect(armed).toMatch(/<aside class="hist-insp"[^>]*data-arming=""/);
    expect(armed).toContain('返回列表');
    expect(renderToStaticMarkup(<HistoryInspector {...props} />)).not.toContain('data-arming');
    expect(renderToStaticMarkup(<HistoryInspector {...props} run={null} arming />)).not.toContain('data-arming');
    expect(homeCss).toMatch(/\.history-page\[data-overlay\] \.hist-insp\[data-arming\]\{[^}]*pointer-events:none/);
  });

  test('文字不小于 11.5px（§2）：只有状态符号可以更小', () => {
    const glyphs = new Set(['.hq-sep .st>i', '.hq-flist .st,.hq-fpad']);
    const small = [...homeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) =>
      [...body!.matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1])).filter(size => size < 11.5).map(size => [selector!.trim(), size] as const))
      .filter(([selector]) => !glyphs.has(selector));
    expect(small).toEqual([]);
  });
});
