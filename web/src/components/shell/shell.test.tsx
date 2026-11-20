import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ExecCapability } from '../../lib/chat-api';
import PageBoundary, { PAGE_FAILED_TITLE } from './PageBoundary';
import { TopBarTitle } from './ShellSlots';
import { CAPABILITIES_CHANGED, SANDBOX_REASON_MAX, SandboxCell, sandboxCell, shortReason, watchExecCapability, type ExecState } from './StatusBar';

// Docker Desktop stopped: `docker version` stderr, passed through by the backend's boundedReason() (up to 500 chars).
const DOCKER_DOWN = 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.';
const docker = (patch: Partial<ExecCapability>): ExecState => ({ status: 'ready', exec: { backend: 'docker', available: false, unsafe: false, ...patch } });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Depth-first search of a React element tree (props.children only) for an element of `type`. */
function findElement(node: ReactNode, type: unknown): ReactElement<{ children?: ReactNode }> | null {
  if (Array.isArray(node)) { for (const child of node) { const hit = findElement(child, type); if (hit) return hit; } return null; }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === type) return node;
  return findElement(node.props.children, type);
}

describe('status bar sandbox cell', () => {
  it('prints a long backend reason on one short line and keeps the full reason in the title', () => {
    const words = sandboxCell(docker({ reason: DOCKER_DOWN }));
    expect(Array.from(words.text).length).toBeLessThanOrEqual(Array.from('执行沙箱 Docker · ').length + SANDBOX_REASON_MAX);
    expect(words.text.startsWith('执行沙箱 Docker · failed to connect')).toBe(true);
    expect(words.text.endsWith('…')).toBe(true);
    expect(words.title).toBe(`执行沙箱 Docker · ${DOCKER_DOWN}`);
    const html = renderToStaticMarkup(<SandboxCell words={words} />);
    expect(html).toContain('class="sb-cell wide sb-sandbox"');
    expect(html).toContain(`title="执行沙箱 Docker · ${DOCKER_DOWN}"`);
    expect(html).not.toContain('role=');
  });

  it('leaves short reasons whole, folds whitespace and cuts by code point', () => {
    expect(sandboxCell(docker({ reason: '镜像未构建' }))).toEqual({ text: '执行沙箱 Docker · 镜像未构建' });
    expect(sandboxCell({ status: 'ready', exec: { backend: null, available: false, unsafe: false, reason: 'line one\n  line two' } })).toEqual({ text: '执行沙箱 · line one line two', title: '执行沙箱 · line one\n  line two', muted: true });
    expect(shortReason('一二三四五六', 4)).toBe('一二三…');
    expect(shortReason('😀😀😀😀😀', 3)).toBe('😀😀…');
    expect(shortReason('abc', 3)).toBe('abc');
  });

  it('keeps the unsafe case an alert cell that is never hidden or shortened', () => {
    const html = renderToStaticMarkup(<SandboxCell words={sandboxCell({ status: 'ready', exec: { backend: 'local-unsafe', available: true, unsafe: true } })} />);
    expect(html).toBe('<span class="sb-cell is-alert" role="alert">本机无沙箱执行 · 模型命令可以访问宿主文件和网络</span>');
  });

  it('re-reads the exec capability on workbench:capabilities-changed and stops on cleanup', async () => {
    const target = new EventTarget();
    const replies = [{ exec: { backend: 'docker' as const, available: false, unsafe: false, reason: '镜像未构建' } }, { exec: { backend: 'docker' as const, available: true, unsafe: false } }];
    const load = vi.fn(async (_signal: AbortSignal) => replies.shift()!);
    const states: ExecState[] = [];
    const stop = watchExecCapability(target, load, state => states.push(state));
    await flush();
    expect(sandboxCell(states.at(-1)!).text).toBe('执行沙箱 Docker · 镜像未构建');
    target.dispatchEvent(new Event(CAPABILITIES_CHANGED));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(sandboxCell(states.at(-1)!).text).toBe('执行沙箱 Docker · 已就绪');
    stop();
    target.dispatchEvent(new Event(CAPABILITIES_CHANGED));
    expect(load).toHaveBeenCalledTimes(2);
    expect(CAPABILITIES_CHANGED).toBe('workbench:capabilities-changed');
  });

  it('drops a slower, older load once a refresh has started', async () => {
    const target = new EventTarget();
    let releaseFirst: (value: { exec: ExecCapability }) => void = () => undefined;
    const signals: AbortSignal[] = [];
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1
        ? new Promise<{ exec: ExecCapability }>(resolve => { releaseFirst = resolve; })
        : Promise.resolve({ exec: { backend: 'docker' as const, available: true, unsafe: false } });
    });
    const states: ExecState[] = [];
    const stop = watchExecCapability(target, load, state => states.push(state));
    target.dispatchEvent(new Event(CAPABILITIES_CHANGED));
    expect(signals[0].aborted).toBe(true);
    releaseFirst({ exec: { backend: 'docker', available: false, unsafe: false, reason: '旧结果' } });
    await flush();
    expect(states.map(state => sandboxCell(state).text)).toEqual(['执行沙箱 Docker · 已就绪']);
    stop();
    expect(signals[1].aborted).toBe(true);
  });
});

describe('page boundary', () => {
  it('clears a crash when the route changes inside the one chat-section instance, without a reset loop', () => {
    const crashed = { failed: true, resetKey: '/?chat=a' };
    expect(PageBoundary.getDerivedStateFromProps({ resetKey: '/?chat=b', children: null }, crashed)).toEqual({ failed: false, resetKey: '/?chat=b' });
    expect(PageBoundary.getDerivedStateFromProps({ resetKey: '/?new=1', children: null }, crashed)).toEqual({ failed: false, resetKey: '/?new=1' });
    // A render error at the same route: getDerivedStateFromError, then getDerivedStateFromProps — it stays failed.
    const again = { ...crashed, ...PageBoundary.getDerivedStateFromError() };
    expect(PageBoundary.getDerivedStateFromProps({ resetKey: '/?chat=a', children: null }, again)).toBeNull();
    expect(again).toEqual(crashed);
  });

  it('renders the page until it fails, then the reload screen with its own top-bar title', () => {
    const boundary = new PageBoundary({ resetKey: '/?chat=a', children: <p>聊天正文</p> });
    expect(boundary.state).toEqual({ failed: false, resetKey: '/?chat=a' });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>聊天正文</p>');
    boundary.state = { failed: true, resetKey: '/?chat=a' };
    const failed = boundary.render();
    const html = renderToStaticMarkup(<>{failed}</>);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`<h3>${PAGE_FAILED_TITLE}</h3>`);
    expect(html).toContain('重新加载页面');
    expect(html).not.toContain('聊天正文');
    const title = findElement(failed, TopBarTitle);
    expect(title).not.toBeNull();
    expect(renderToStaticMarkup(<>{title!.props.children}</>).replace(/<[^>]+>/g, '')).toBe(PAGE_FAILED_TITLE);
  });
});
