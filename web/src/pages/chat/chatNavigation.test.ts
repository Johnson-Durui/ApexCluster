import { describe, expect, it } from 'vitest';
import { chatStatusLabel, parseChatHash } from './chatNavigation';

describe('chat navigation and labels', () => {
  it('distinguishes the explicit new-chat builder from default and history chat routes', () => {
    expect(parseChatHash('#/?new=1')).toEqual({ chatId: null, newChat: true });
    expect(parseChatHash('#/?chat=chat-123')).toEqual({ chatId: 'chat-123', newChat: false });
    expect(parseChatHash('#/')).toEqual({ chatId: null, newChat: false });
  });

  it('shows server chat states in Chinese and does not leak unknown English values', () => {
    expect(chatStatusLabel('waiting_user')).toBe('等待你回答');
    expect(chatStatusLabel('completed')).toBe('已完成');
    expect(chatStatusLabel('unexpected_state')).toBe('状态未知');
  });
});
