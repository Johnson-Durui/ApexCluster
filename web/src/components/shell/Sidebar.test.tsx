import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '../../lib/chat-api';
import type { RunSummary } from '../../lib/types';
import { chatStatusKind, chatStatusLabel } from '../../pages/chat/chatNavigation';
import Sidebar, { ChatList, navCurrent, SidebarNav, waitingCounts } from './Sidebar';

const chat = (id: string, status: string, title = `聊天 ${id}`): ChatSummary => ({ id, title, status, updatedAt: '2026-11-20T00:00:00.000Z' });
const run = (patch: Partial<RunSummary>): RunSummary => ({ id: 'r', title: 'run', mode: 'real', phase: 'framework_gate', phaseStatus: 'running', terminal: null, createdAt: '', updatedAt: '', ...patch } as RunSummary);
const pageCount = (html: string) => html.match(/aria-current="page"/g)?.length ?? 0;
const listProps = { route: '/', query: '', loading: false, error: '', onRetry: vi.fn() };

describe('shell sidebar', () => {
  it('names the four workspace nav rows and marks exactly one page per screen', () => {
    for (const route of ['/', '/?new=1', '/history', '/new', '/environment']) {
      const html = renderToStaticMarkup(<Sidebar route={route} />);
      expect(pageCount(html), route).toBe(1);
    }
    const html = renderToStaticMarkup(<Sidebar route="/history" />);
    expect(html).toContain('aria-label="工作区"');
    expect(html).toContain('aria-label="工作区导航"');
    for (const name of ['聊天', '任务历史', '新建评审', '环境与连接']) expect(html).toContain(`>${name}</span>`);
    expect(html).toContain('href="#/?new=1"');
    expect(html).toContain('aria-label="搜索聊天"');
    expect(html).toContain('aria-label="刷新聊天列表"');
    expect(html).toContain('正在读取记录…');
  });

  it('marks the parent row "true" on child pages, where the child owns the page', () => {
    expect(navCurrent('chat', '/?chat=abc')).toBe('true');
    expect(navCurrent('history', '/runs/r-20261014-8d7583')).toBe('true');
    expect(navCurrent('history', '/history')).toBe('page');
    expect(navCurrent('chat', '/history')).toBeUndefined();
    const runHtml = renderToStaticMarkup(<Sidebar route="/runs/r-1" />);
    expect(pageCount(runHtml)).toBe(0);
    expect(runHtml).toContain('aria-current="true"');
    const chatRoute = '/?chat=abc';
    const navHtml = renderToStaticMarkup(<SidebarNav route={chatRoute} counts={{}} />);
    const listHtml = renderToStaticMarkup(<ChatList {...listProps} route={chatRoute} chats={[chat('abc', 'running'), chat('def', 'completed')]} />);
    expect(pageCount(navHtml) + pageCount(listHtml)).toBe(1);
    expect(listHtml).toContain('href="#/?chat=abc" aria-current="page"');
  });

  it('shows every chat status as glyph + word, including 已完成 and blocked as 会话受阻', () => {
    expect(chatStatusLabel('blocked')).toBe('会话受阻');
    expect(chatStatusKind('blocked')).toBe('block');
    expect(chatStatusKind('waiting_user')).toBe('you');
    expect(chatStatusKind('unexpected_state')).toBe('idle');
    const html = renderToStaticMarkup(<ChatList {...listProps} chats={[chat('a', 'blocked'), chat('b', 'completed'), chat('c', 'waiting_user'), chat('d', 'failed')]} />);
    expect(html).toContain('<span class="st block"><i aria-hidden="true">⊘</i>会话受阻</span>');
    expect(html).toContain('<span class="st ok"><i aria-hidden="true">✓</i>已完成</span>');
    expect(html).toContain('<span class="st you"><i aria-hidden="true">◆</i>等待你回答</span>');
    expect(html).toContain('<span class="st err"><i aria-hidden="true">✕</i>已失败</span>');
  });

  it('tags fixed demos and keeps every list state', () => {
    const demo = renderToStaticMarkup(<ChatList {...listProps} chats={[chat('fixed-demo-roomdesk-0f8b5a3c-1d2e-4f3a-9b8c-7d6e5f4a3b2c', 'completed', '会议室预约工具演示')]} />);
    expect(demo).toContain('▷ 演示');
    expect(demo).toContain('tag mock');
    expect(renderToStaticMarkup(<ChatList {...listProps} chats={[]} loading />)).toContain('<p class="side-note" role="status">正在读取记录…</p>');
    expect(renderToStaticMarkup(<ChatList {...listProps} chats={[]} />)).toContain('你的聊天会保存在这里。');
    expect(renderToStaticMarkup(<ChatList {...listProps} chats={[chat('a', 'running')]} query="不存在" />)).toContain('没有匹配的聊天');
    const failed = renderToStaticMarkup(<ChatList {...listProps} chats={[]} error="请求失败（503）" />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('重试');
    expect(failed).not.toContain('你的聊天会保存在这里。');
  });

  it('counts only what waits on the user and puts the count in the link name', () => {
    const counts = waitingCounts([chat('a', 'waiting_user'), chat('b', 'running')], [run({ phaseStatus: 'waiting_user' }), run({ phaseStatus: 'waiting_user', terminal: 'cancelled' } as Partial<RunSummary>), run({ phaseStatus: 'waiting_user', mode: 'mock' } as Partial<RunSummary>)]);
    expect(counts).toEqual({ chat: 1, history: 1 });
    const html = renderToStaticMarkup(<SidebarNav route="/" counts={counts} />);
    expect(html).toContain('aria-label="聊天，1 项等你处理"');
    expect(html).toContain('aria-label="任务历史，1 项等你处理"');
  });
});
