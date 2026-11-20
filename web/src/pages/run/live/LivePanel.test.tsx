import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { ProgressMap, TaskRecord } from '../../../lib/types';
import LivePanel from './LivePanel';
import ModelStatusStrip from '../header/ModelStatusStrip';
import { liveRun, task } from './testFixtures';

const render = (tasks: TaskRecord[], progress: ProgressMap = {}) => renderToStaticMarkup(<LivePanel run={liveRun(tasks)} busy={false} progress={progress} act={vi.fn()} refresh={vi.fn()} />);

describe('执行过程：生成时占满主区域', () => {
  test('还没有任务时说明当前阶段，不显示空白窄栏', () => {
    expect(render([])).toContain('还没有模型任务');
  });

  test('并行任务按列并排显示状态、请求型号和实时日志', () => {
    const html = render(
      [task({ id: 't-claude', role: 'claude', phase: 'propose', status: 'running', outputValidity: 'pending', endedAt: null }), task({ id: 't-astra', role: 'astra', phase: 'propose' })],
      { 't-claude': [{ at: '2026-10-12T08:00:05.000Z', kind: 'tool', text: '调用 WebSearch：Windows SQLite 预编译' }] },
    );
    expect(html.match(/class="live-pane /g)).toHaveLength(2);
    expect(html).toContain('--cols:2');
    expect(html).toContain('独立提案');
    expect(html).toContain('进行中');
    expect(html).toContain('生成完成');
    expect(html).toContain('claude-opus-5-5 · max');
    expect(html).toContain('调用 WebSearch：Windows SQLite 预编译');
    expect(html).toContain('取消任务');
  });

  test('裁决任务排队且没有 meta 时仍明确显示 Astra Ultra 与 ultra 强度', () => {
    const html = render([task({ id: 't-u', role: 'astra', phase: 'adjudicate', scope: 'r1-adjudicate-1', status: 'queued', outputValidity: 'pending', startedAt: null, endedAt: null })]);
    expect(html).toContain('Astra Ultra');
    expect(html).toContain('Ultra 裁决');
    expect(html).toContain('gpt-6-astra · ultra');
    expect(html).toContain('排队中：等待空闲的执行槽位后启动。');
  });

  test('失败任务显示失败原因和重试；早期模拟任务带模拟标记', () => {
    const html = render([task({ id: 't-f', role: 'astra', phase: 'propose', status: 'failed', outputValidity: 'pending', simulated: true, failure: { kind: 'process_error', message: '子进程意外退出' } })]);
    expect(html).toContain('执行进程失败');
    expect(html).toContain('子进程意外退出');
    expect(html).toContain('重试');
    expect(html).toContain('模拟');
  });
});

describe('顶部执行端状态', () => {
  test('三位执行端都显示；未创建任务时显示尚未启动与配置型号', () => {
    const html = renderToStaticMarkup(<ModelStatusStrip run={liveRun([task({ id: 'c', role: 'claude', phase: 'review' })])} now={Date.now()} />);
    expect(html.match(/<small>尚未启动/g)).toHaveLength(2);
    expect(html).toContain('gpt-6.1-sol');
    expect(html).toContain('交叉评审 · 生成完成');
  });

  test('裁决任务显示为 Astra Ultra', () => {
    const html = renderToStaticMarkup(<ModelStatusStrip run={liveRun([task({ id: 'u', role: 'astra', phase: 'adjudicate', status: 'running', endedAt: null })])} now={Date.parse('2026-10-12T08:05:00.000Z')} />);
    expect(html).toContain('Astra Ultra');
    expect(html).toContain('Ultra 裁决 · 进行中');
  });
});
