import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { chooseAndClose, ProjectControl } from './ProjectControl';

// Read from disk: Vitest serves CSS imports as empty strings.
const composerCss = readFileSync(new URL('../composer.css', import.meta.url), 'utf8');
const base = { workspaces: [], selected: '', busy: false, sending: false, onSelect: vi.fn(), onChoose: vi.fn(), onRevoke: vi.fn() };

describe('project control', () => {
  it('shows a disabled chip, never the new-chat picker, while an existing chat loads or after it failed to load', () => {
    const loading = renderToStaticMarkup(<ProjectControl chat={null} unavailable="loading" {...base} />);
    expect(loading).toContain('aria-disabled="true"');
    expect(loading).toContain('项目目录…');
    expect(loading).not.toContain('aria-haspopup');
    expect(loading).not.toContain('未授权目录');
    const failed = renderToStaticMarkup(<ProjectControl chat={null} unavailable="failed" {...base} />);
    expect(failed).toContain('项目目录不可用');
    expect(failed).not.toContain('aria-haspopup');
    expect(failed).not.toContain('用系统选择目录');
  });

  it('still offers the picker for a new chat', () => {
    const html = renderToStaticMarkup(<ProjectControl chat={null} {...base} />);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('仅对话 · 未授权目录');
  });

  it('closes the picker after a successful OS folder pick, only while it is still open', async () => {
    const close = vi.fn();
    await chooseAndClose(async () => true, () => true, close);
    expect(close).toHaveBeenCalledTimes(1);
    await chooseAndClose(async () => false, () => true, close);
    await chooseAndClose(async () => true, () => false, close);
    await chooseAndClose(() => undefined, () => true, close);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('composer focus', () => {
  it('draws the §3.7 input focus on the form around the borderless textarea', () => {
    expect(composerCss).toMatch(/\.chat-compose:has\(textarea:focus\)\{[^}]*border-color:var\(--ink\)[^}]*var\(--field-focus\)/);
    expect(composerCss).toMatch(/\.chat-compose:has\(textarea:focus-visible\)\{[^}]*outline:var\(--focus-outline\)/);
    // the old cue (a 1.2:1 border tint) is not the indicator any more
    expect(composerCss).not.toMatch(/\.chat-compose:focus-within\{border-color:var\(--line-3\)\}/);
  });
});
