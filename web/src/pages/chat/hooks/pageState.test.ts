import { describe, expect, it } from 'vitest';
import { isWorkActive } from './useFixedDemoPlayback';
import { ticketErrorFor } from './useTicketAnswer';

describe('answer errors', () => {
  it('shows a failed answer only on the card of the ticket it was raised on', () => {
    const error = { ticketId: 'ticket-a', message: '回答提交失败：该问题已关闭' };
    expect(ticketErrorFor(error, 'ticket-a')).toBe('回答提交失败：该问题已关闭');
    // ticket A was resolved another way; ticket B's card opens clean
    expect(ticketErrorFor(error, 'ticket-b')).toBe('');
    expect(ticketErrorFor(error, undefined)).toBe('');
    expect(ticketErrorFor(null, 'ticket-a')).toBe('');
  });
});

describe('work activity', () => {
  it('treats a paused fixed demo as idle although its tasks still read running', () => {
    const tasks = [{ status: 'running' }, { status: 'completed' }];
    expect(isWorkActive(tasks, false)).toBe(true);
    expect(isWorkActive(tasks, true)).toBe(false);
  });

  it('counts queued, running and waiting-on-children work; waiting on the user is idle', () => {
    expect(isWorkActive([{ status: 'queued' }], false)).toBe(true);
    expect(isWorkActive([{ status: 'waiting_children' }], false)).toBe(true);
    expect(isWorkActive([{ status: 'waiting_user' }, { status: 'completed' }], false)).toBe(false);
    expect(isWorkActive([], false)).toBe(false);
  });
});
