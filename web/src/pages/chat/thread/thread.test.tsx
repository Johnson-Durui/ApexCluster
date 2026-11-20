import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentTask, ChatMessage, ChatRecord } from '../../../lib/chat-api';
import { emptyChatState, reduceChat } from '../chatModel';
import { MessageItem } from './AnswerCard';
import { ActivityList, ThinkingLine } from './TurnBlock';
import { threadItemCount } from './Thread';

const gateMessage = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: 'g', seq: 3, role: 'user', text: '关卡 A 确认通过', createdAt: '2026-11-19T07:47:00Z', turnId: 'gate-turn',
  pipelineGate: { id: 'A', revision: 1, decision: 'confirm' }, ...patch,
});
const render = (message: ChatMessage) => renderToStaticMarkup(<MessageItem message={message} lead="Claude" seat="claude" demo={false} fresh={false} />);
const task = (patch: Partial<AgentTask>): AgentTask => ({
  id: 'root', turnId: 'turn', role: 'claude', goal: '拆解需求', status: 'running', createdAt: '2026-11-19T07:40:00Z', updatedAt: '2026-11-19T07:40:00Z',
  segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read', ...patch,
});
const chat = (tasks: AgentTask[]): ChatRecord => ({
  version: 1, id: 'c', title: 'c', createdAt: '', updatedAt: '', seq: 1, messageSeq: 0, turns: [{ id: 'turn', rootTaskId: 'root', status: 'running', createdAt: '2026-11-19T07:40:00Z' }],
  tasks, invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
});

describe('thread messages', () => {
  it('renders a pipelineGate message as a receipt, never as a user bubble', () => {
    const html = render(gateMessage({}));
    expect(html).toContain('关卡 A · 已确认继续');
    expect(html).toContain('由你决定');
    expect(html).toContain('receipt');
    expect(html).not.toContain('chat-message user');
    expect(html).not.toContain('关卡 A 确认通过');
  });

  it('marks automatic decisions as 由系统自动通过', () => {
    const html = render(gateMessage({ role: 'system', auto: true }));
    expect(html).toContain('由系统自动通过');
    expect(html).not.toContain('由你决定');
  });

  it('shows revise feedback under the receipt and a stop receipt for cancel', () => {
    const revise = render(gateMessage({ text: '补充断线重连的验收项', pipelineGate: { id: 'B', revision: 2, decision: 'revise' } }));
    expect(revise).toContain('关卡 B · 已提交修改');
    expect(revise).toContain('补充断线重连的验收项');
    expect(render(gateMessage({ pipelineGate: { id: 'A', revision: 1, decision: 'cancel' } }))).toContain('流水线已终止');
  });

  it('renders the final answer as a document with a sr-only role label and safe Markdown', () => {
    const html = render({ id: 'a', seq: 2, role: 'assistant', text: '# 结论\n- 一\n<b>x</b>', createdAt: '', turnId: 'turn' });
    expect(html).toContain('chat-message assistant answer');
    expect(html).toContain('Claude · 最终回复');
    expect(html).toContain('<h3>结论</h3>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('复制');
  });

  it('keeps the user text verbatim in a bubble', () => {
    const html = render({ id: 'u', seq: 1, role: 'user', text: '  两个空格\n第二行', createdAt: '', turnId: 'turn' });
    expect(html).toContain('chat-message user');
    expect(html).toContain('  两个空格\n第二行');
  });
});

describe('turn block', () => {
  it('shows a lone failed turn as 没有可显示的执行动态 instead of a bare heading', () => {
    const html = renderToStaticMarkup(<ActivityList chat={chat([task({ status: 'failed' })])} tools={[]} turnId="turn" />);
    expect(html).toContain('没有可显示的执行动态');
    expect(html).toContain('Claude · 主控');
    expect(html).toContain('失败');
  });

  it('renders dispatch rows as a table with the lead, the seat and a status word', () => {
    const html = renderToStaticMarkup(<ActivityList chat={chat([task({}), task({ id: 'child', parentTaskId: 'root', role: 'astra', goal: '独立评审架构方案' })])} tools={[]} turnId="turn" />);
    expect(html).toContain('<table');
    expect(html).toContain('<th scope="col">时间</th>');
    expect(html).toContain('Astra'); expect(html).toContain('独立评审架构方案'); expect(html).toContain('开始工作');
    expect(html).toContain('aria-expanded="false"');
  });

  it('shows the thinking line only for real states', () => {
    expect(renderToStaticMarkup(<ThinkingLine chat={chat([task({})])} turnId="turn" lead="Claude" />)).toContain('Claude 正在处理');
    const waiting = renderToStaticMarkup(<ThinkingLine chat={chat([task({ status: 'waiting_children' }), task({ id: 'k', parentTaskId: 'root', role: 'sol' })])} turnId="turn" lead="Claude" />);
    expect(waiting).toContain('等待 Sol 回传');
    expect(renderToStaticMarkup(<ThinkingLine chat={chat([task({ status: 'completed' })])} turnId="turn" lead="Claude" />)).toBe('');
  });

  it('holds the thinking dots still while a fixed demo is paused', () => {
    // Read from disk: Vitest serves CSS imports as empty strings.
    const css = readFileSync(new URL('../thread.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.chat-work\[data-paused\] \.thinking \.dots i\{animation:none\}/);
  });

  it('counts messages plus activity rows for the unread measure', () => {
    let state = reduceChat(emptyChatState(), { type: 'snapshot', snapshot: { chat: chat([task({}), task({ id: 'child', parentTaskId: 'root', role: 'sol' })]), messages: [{ id: 'm', seq: 1, role: 'user', text: 'x', createdAt: '', turnId: 'turn' }], capabilities: [] } });
    expect(threadItemCount(state.chat, state)).toBe(2);
    state = reduceChat(state, { type: 'connection', connection: 'live' });
    expect(state.origin).toBe('snapshot');
  });
});
