import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import NewPage from './NewPage';
import EnvironmentPage from './EnvironmentPage';
import { apiKind, findingsKind, liveKind, platformParts, servicesKind, toolsKind, type LiveResult, type ProbeReport } from './environmentModel';

describe('新建评审 · 启动卡与章节索引', () => {
  const html = renderToStaticMarkup(<NewPage onCreated={vi.fn()} />);

  test('启动按钮的标记完全不变，未就绪时说明还差哪几项', () => {
    expect(html).toContain('<button type="submit" class="primary launch" disabled="">启动评审…</button>');
    expect(html).toContain('还差 4 项：项目标题、要解决的问题、配置、额度确认');
    expect(html).toMatch(/<p class="lc-why" aria-live="polite">/);
  });

  test('清单补上参考资料、配置、构建与评审上限和额度确认', () => {
    for (const label of ['参考资料', '配置', '构建与评审上限', '额度确认']) expect(html).toContain(label);
  });

  test('章节索引是按钮，不用会改动路由的 #锚点', () => {
    expect(html).toContain('aria-label="表单章节"');
    expect(html.match(/class="btn-reset section-nav-item"/g)).toHaveLength(5);
    expect(html).not.toMatch(/href="#(new-|section-)/);
    expect(html).toContain('id="section-01" tabindex="-1"');
  });

  test('构建与评审上限收在高级折叠里，内容仍在服务端标记中', () => {
    const details = html.slice(html.indexOf('<details class="new-adv'));
    expect(details).toContain('构建与评审上限（高级）');
    expect(details).toContain('每作业最多构建轮数');
    expect(details).toContain('每作业模型主动时间上限（分钟）');
  });

  test('调用预估不再露出 single / dual 原始值', () => {
    expect(html).toContain('设计：Claude 主导。');
    expect(html).not.toMatch(/设计：(single|dual)|当前按 (single|dual)/);
  });
});

describe('环境与连接', () => {
  test('首次读取时 KPI 显示 —，章节导航是按钮', () => {
    const html = renderToStaticMarkup(<EnvironmentPage />);
    expect(html).toContain('<h1>环境与连接</h1>');
    expect(html.match(/<b class="kpi-num numeral">—<\/b>/g)).toHaveLength(4);
    expect(html).toContain('aria-label="设置章节"');
    expect(html).not.toMatch(/<a [^>]*href="#env-/);
    expect(html).toContain('id="env-live"');
    expect(html).toContain('运行所选真实探测');
  });

  const report = (levels: ('ok' | 'warn' | 'error')[], tools: ProbeReport['tools'] = { git: { path: 'C:/git.exe', via: null, version: '2' } }): ProbeReport => ({
    at: '2026-11-20T01:00:00.000Z', platform: 'win32 10.0.26300', node: '24.14.0', tools,
    findings: levels.map((level, index) => ({ id: `f${index}`, level, message: level })),
  });

  test('平台只显示探测返回的事实（没有架构字段就不写 x64）', () => {
    expect(platformParts('win32 10.0.26300')).toEqual({ name: 'Windows', release: '10.0.26300' });
    expect(platformParts('freebsd')).toEqual({ name: 'freebsd', release: '' });
  });

  test('导航状态取最差的一项；没有数据时不画符号', () => {
    expect(findingsKind(null)).toBeNull();
    expect(findingsKind(report(['ok', 'warn']))).toBe('child');
    expect(findingsKind(report(['ok', 'error', 'warn']))).toBe('err');
    expect(toolsKind(report([], { claude: { path: null, via: null, version: null } }))).toBe('child');
    expect(servicesKind([{ id: 'a', name: 'A', state: 'ready', tools: [] }, { id: 'b', name: 'B', state: 'degraded', tools: [] }])).toBe('child');
    expect(servicesKind([{ id: 'a', name: 'A', state: 'disabled', tools: [] }])).toBe('idle');
    expect(apiKind({ mode: 'api', keyReadiness: [{ provider: 'x', env: 'X', configured: true }], modelChecks: [{ id: 'm', provider: 'x', status: 'verified' }], presets: [] })).toBe('ok');
    expect(apiKind({ mode: 'api', keyReadiness: [], modelChecks: [], presets: [{ id: 'p', rootSeat: 'claude', seats: [], available: false }] })).toBe('err');
    expect(apiKind({ mode: 'cli', keyReadiness: [], modelChecks: [], presets: [] })).toBe('idle');
    const live = (failure: LiveResult['failure'], outputValid: boolean) => ({ role: 'claude', model: 'm', effort: 'max', status: 'succeeded', outputValid, failure, meta: {} }) as unknown as LiveResult;
    expect(liveKind([live(null, true)])).toBe('ok');
    expect(liveKind([live(null, true), live({ kind: 'x', message: 'y' }, false)])).toBe('err');
    expect(liveKind(undefined)).toBeNull();
  });
});
