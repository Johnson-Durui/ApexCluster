import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { inspectorFixture, type InspectorState } from '../../dev/inspector/fixtures';
import ChatInspector, { INSPECTOR_TABS, taskTally } from './ChatInspector';
import { DEFAULT_INSPECTOR_TAB, type InspectorPlacement, type InspectorTab } from './workspaceContracts';

function render(state: InspectorState, tab: InspectorTab = DEFAULT_INSPECTOR_TAB, placement: InspectorPlacement = 'dock') {
  const sample = inspectorFixture(state);
  return renderToStaticMarkup(<ChatInspector chat={sample.chat} streams={sample.streams} tools={sample.tools} rotations={sample.rotations}
    capabilities={sample.capabilities} globalCapabilities={sample.globalCapabilities} model={sample.model} fixedDemo={sample.fixedDemo}
    tab={tab} onTab={vi.fn()} placement={placement} onClose={vi.fn()} />);
}
const count = (html: string, text: string) => html.split(text).length - 1;

describe('协作详情 inspector', () => {
  it('is the #chat-inspector landmark with the 协作详情内容 tablist and five named tabs, 任务 selected by default', () => {
    expect(DEFAULT_INSPECTOR_TAB).toBe('tasks');
    const html = render('running');
    expect(html).toContain('<aside id="chat-inspector" class="chat-inspector" aria-label="协作详情" data-placement="dock"');
    expect(html).toContain('role="tablist" aria-label="协作详情内容"');
    for (const name of ['席位：焦点与上下游', '任务：分工与证据', '文件：实际交付物', '上下文：调用占用', '设置：扩展能力']) expect(html).toContain(`aria-label="${name}"`);
    expect(count(html, 'role="tab"')).toBe(5);
    expect(INSPECTOR_TABS.map(tab => tab.id)).toEqual(['seat', 'tasks', 'files', 'context', 'settings']);
    expect(html).toMatch(/aria-selected="true" tabindex="0" aria-label="任务：分工与证据"/);
    expect(count(html, 'aria-selected="true"')).toBe(1);
    expect(count(html, 'role="tabpanel"')).toBe(5);
    expect(html).toContain('class="inspector-page inspector-page-tasks" ');
    expect(html).toMatch(/inspector-page-tasks"[^>]*data-active="true"/);
    expect(html).toContain('aria-label="关闭协作详情"');
  });

  it('offers the dock collapse control only in the dock and keeps the dock height splitter labelled', () => {
    const dock = render('running', 'tasks', 'dock');
    expect(dock).toContain('aria-label="收起协作详情面板"');
    const collapse = dock.match(/<button[^>]*class="icon-btn insp-collapse"[^>]*>/)?.[0] ?? '';
    expect(collapse).toContain('aria-expanded="true"');
    const controls = collapse.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(dock).toContain(`<div class="insp-body" id="${controls}">`);
    expect(dock).toContain('aria-label="调整协作详情高度"');
    const column = render('running', 'tasks', 'column');
    expect(column).toContain('data-placement="column"');
    expect(column).not.toContain('收起协作详情面板');
    expect(column).not.toContain('调整协作详情高度');
  });

  it('shows the files empty line once, and counts real artifacts when there are some', () => {
    const empty = render('empty', 'files');
    expect(count(empty, '当前会话尚无产物')).toBe(1);
    expect(empty).not.toContain('尚无产物。');
    const done = render('done', 'files');
    expect(done).toContain(`共 ${inspectorFixture('done').chat.artifacts.length} 项实际产物`);
    expect(done).toContain('class="artifact-list"');
    expect(done).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('summarises settings read-only and links to 环境与连接, marking the fixed demo on every tab', () => {
    const html = render('running', 'settings');
    expect(html).toContain('href="#/environment"');
    expect(html).toContain('在 环境与连接 中管理 MCP、Skill、多模态与 API →');
    expect(html).toContain('缺少 HYDROGEN_API_KEY');
    expect(html).toContain('class="service-status-list"');
    expect(html).not.toContain('保存设置');
    for (const tab of ['seat', 'tasks', 'files', 'context', 'settings'] as const) expect(render('demo', tab)).toContain('▷ 预设演示');
    expect(render('demo', 'settings')).toContain('预设演示会话：以下为本机真实全局配置');
    expect(render('running', 'tasks')).not.toContain('▷ 预设演示');
  });

  it('falls back to 能力未经验证 for an unavailable seat without a reason', () => {
    const sample = inspectorFixture('running');
    const capabilities = sample.capabilities.map(seat => seat.role === 'sol' ? { ...seat, available: false, reason: undefined } : seat);
    const html = renderToStaticMarkup(<ChatInspector {...sample} capabilities={capabilities} tab="settings" onTab={vi.fn()} placement="column" onClose={vi.fn()} />);
    expect(html).toContain('能力未经验证');
  });

  it('counts every task (root included) in the footer from real statuses only', () => {
    const sample = inspectorFixture('running');
    const done = sample.chat.tasks.filter(task => task.status === 'completed').length;
    const html = render('running');
    expect(html).toContain('全部任务（含主任务）');
    expect(html).toContain(`${String(done).padStart(2, '0')}<small> / ${String(sample.chat.tasks.length).padStart(2, '0')}</small>`);
    const tally = taskTally(sample.chat.tasks);
    expect(tally.every(item => item.count > 0)).toBe(true);
    expect(tally.reduce((sum, item) => sum + item.count, 0)).toBe(sample.chat.tasks.length);
    expect(render('empty')).toContain('尚未创建任务');
  });

  it('renders the pipeline status in 上下文 for a pipeline chat', () => {
    const html = render('gate', 'context');
    expect(html).toContain('流水线 · flagship');
    expect(html).toContain('调用上下文');
  });
});
