import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { LiveProbeError, liveProbeFailure } from './EnvironmentPage';

const environmentCss = readFileSync(new URL('./environment.css', import.meta.url), 'utf8');
const settingsCss = readFileSync(new URL('../chat/settings.css', import.meta.url), 'utf8');
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\{([^}]*)\\}`))?.[1] ?? '';
};
const declaration = (body: string, property: string) => body.match(new RegExp(`(?:^|;)\\s*${property.replace(/-/g, '\\-')}:([^;]+)`))?.[1].trim();

describe('环境与连接: a failed paid probe', () => {
  it('names the failure and says the selection was cleared, as an alert for the probe zone', () => {
    const message = liveProbeFailure(new ApiError('先前模型进程树尚未确认退出', 409));
    expect(message).toBe('真实探测未完成：先前模型进程树尚未确认退出');
    expect(liveProbeFailure('boom')).toBe('真实探测未完成：请求失败');
    const html = renderToStaticMarkup(<LiveProbeError message={message} />);
    expect(html).toContain('class="alert bad live-error" role="alert"');
    expect(html).toContain('真实探测未完成：先前模型进程树尚未确认退出');
    expect(html).toContain('所选目标和额度确认已清除');
  });
});

describe('环境与连接 layout rules', () => {
  it('sets the save-bar inset to the scroller bottom padding, so no content shows below the sticky bar', () => {
    expect(declaration(rule(settingsCss, '.settings-panel .settings-save'), 'bottom')).toBe('calc(0px - var(--settings-save-inset,0px))');
    const main = rule(environmentCss, '.env-main');
    const padding = declaration(main, 'padding')?.split(/\s+(?![^(]*\))/) ?? [];
    expect(padding).toHaveLength(3);
    expect(padding[2]).toBe('var(--env-main-pb)');
    expect(declaration(main, '--settings-save-inset')).toBe('var(--env-main-pb)');
    expect(declaration(main, '--env-main-pb')).toBe('40px');
    // The sr-only heading inside must stay in this scroller, or jumps scroll .app-view and leave a band under the bar.
    expect(declaration(main, 'position')).toBe('relative');
    expect(declaration(main, 'overflow')).toBe('auto');
  });

  it('wraps the head subtitle only between its segments, never inside a CJK word', () => {
    expect(declaration(rule(environmentCss, '.env-title p'), 'word-break')).toBe('keep-all');
  });
});
