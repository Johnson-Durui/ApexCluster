import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Popover from './Popover';
import { Toasts } from './Toast';
import { EmptyState, Modal, SeatDot, Status, Tag } from './ui';
import { routeFallback } from './shell/TopBar';
import { sandboxCell } from './shell/StatusBar';

describe('shared overlays and primitives', () => {
  it('renders a Modal with a size, the shared close name and an optional footer', () => {
    const html = renderToStaticMarkup(<Modal title="确认启动真实评审" size="sm" onClose={vi.fn()} footer={<button type="button">返回修改</button>}><p>正文</p></Modal>);
    expect(html).toContain('<dialog class="modal modal-sm"');
    expect(html).toContain('aria-label="关闭对话框"');
    expect(html).toContain('<div class="modal-body"><p>正文</p></div>');
    expect(html).toContain('<div class="modal-foot"><button type="button">返回修改</button></div>');
    expect(renderToStaticMarkup(<Modal title="预览" onClose={vi.fn()} className="artifact-preview-dialog">x</Modal>)).toContain('class="modal modal-md artifact-preview-dialog"');
  });

  it('renders a closed Popover as a dialog trigger without a panel', () => {
    const html = renderToStaticMarkup(<Popover label="项目目录" button="仅对话 · 未授权目录 ▾">内容</Popover>);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it('keeps the toast region present and polite before any toast arrives', () => {
    expect(renderToStaticMarkup(<Toasts />)).toBe('<div class="toasts" role="status" aria-live="polite"></div>');
  });

  it('draws status as glyph + word, tags and seat dots from tokens, and EmptyState text as text', () => {
    expect(renderToStaticMarkup(<Status kind="you" />)).toBe('<span class="st you"><i aria-hidden="true">◆</i>等你决定</span>');
    expect(renderToStaticMarkup(<Status kind="run" hideWord>执行中</Status>)).toBe('<span class="st run"><i aria-hidden="true">▶</i><span class="sr-only">执行中</span></span>');
    expect(renderToStaticMarkup(<Tag tone="mock">▷ 预设演示</Tag>)).toBe('<span class="tag mock">▷ 预设演示</span>');
    expect(renderToStaticMarkup(<SeatDot seat="astra" />)).toBe('<span class="seat-dot" data-seat="astra" aria-hidden="true"></span>');
    expect(renderToStaticMarkup(<SeatDot ink="#123456" />)).toContain('style="--ink-s:#123456"');
    const empty = renderToStaticMarkup(<EmptyState title="还没有评审运行" numeral="0">创建后会显示在这里</EmptyState>);
    expect(empty).toContain('<h3>还没有评审运行</h3>');
    expect(empty).toContain('创建后会显示在这里');
    expect(empty).toContain('<span class="empty-numeral">0</span>');
  });

  it('gives every route a shell title until the page fills the slot', () => {
    const text = (route: string) => renderToStaticMarkup(<>{routeFallback(route).title}</>).replace(/<[^>]+>/g, '');
    expect(text('/history')).toBe('任务历史· 评审运行队列');
    expect(text('/new')).toBe('任务历史/新建评审');
    expect(text('/environment')).toBe('环境与连接');
    expect(text('/?new=1')).toBe('聊天/新聊天');
    expect(text('/runs/r-1')).toBe('任务历史/任务详情');
    expect(text('/nope')).toBe('页面不存在');
    expect(renderToStaticMarkup(<>{routeFallback('/history').title}</>)).not.toContain('<h1');
  });

  it('words the sandbox cell from the exec capability, with the unsafe case as an alert', () => {
    expect(sandboxCell({ status: 'ready', exec: { backend: 'docker', available: true, unsafe: false } }).text).toBe('执行沙箱 Docker · 已就绪');
    expect(sandboxCell({ status: 'ready', exec: { backend: 'docker', available: false, unsafe: false, reason: '镜像未构建' } }).text).toBe('执行沙箱 Docker · 镜像未构建');
    expect(sandboxCell({ status: 'ready', exec: { backend: 'local-unsafe', available: true, unsafe: true } })).toEqual({ text: '本机无沙箱执行 · 模型命令可以访问宿主文件和网络', tone: 'alert' });
    expect(sandboxCell({ status: 'loading' }).text).toBe('执行沙箱 · 正在读取');
  });
});
