import { beforeEach, describe, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('./api', () => ({ api: request, ApiError: class ApiError extends Error {}, initSession: vi.fn() }));
import { chatApi } from './chat-api';

const demoId = 'fixed-demo-roomdesk-11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  request.get.mockResolvedValue([]); request.post.mockResolvedValue({}); request.delete.mockResolvedValue({});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5211' } });
});
describe('fixed demo stays outside real chat requests', () => {
  it('preserves real create and send payloads including explicit cost flag', async () => {
    await chatApi.create({ title: '真实需求', workspaceId: 'w' });
    await chatApi.send('real-chat', '真实消息', 'client-1', false, ['attachment-1']);
    expect(request.post).toHaveBeenNthCalledWith(1, '/api/chats', { title: '真实需求', workspaceId: 'w' });
    expect(request.post).toHaveBeenNthCalledWith(2, '/api/chats/real-chat/messages', { text: '真实消息', clientMessageId: 'client-1', confirmCost: false, attachmentIds: ['attachment-1'] });
  });
  it('does not intercept ordinary reads and cancellation', async () => {
    await chatApi.get('real-chat'); await chatApi.cancel('real-chat');
    expect(request.get).toHaveBeenCalledWith('/api/chats/real-chat', undefined);
    expect(request.post).toHaveBeenCalledWith('/api/chats/real-chat/cancel', {});
  });
  it('refuses to send or upload in a demo instead of falling through to model API', async () => {
    await expect(chatApi.send(demoId, '其他需求', 'c', true)).rejects.toThrow('固定演示');
    await expect(chatApi.uploadAttachment(demoId, { name: 'x', base64: 'eA==', clientUploadId: 'c' })).rejects.toThrow('固定演示');
    await expect(chatApi.answer(demoId, 'q', '回答', 'c')).rejects.toThrow('固定演示');
    expect(request.post).not.toHaveBeenCalled();
  });
  it('only routes valid demo ids and known artifact ids to static deliverables', () => {
    expect(chatApi.artifactUrl(demoId, 'prd')).toBe('/fixed-demo/prd.md');
    expect(() => chatApi.artifactUrl(demoId, '../unknown')).toThrow('未知');
    expect(chatApi.artifactUrl('real-chat', 'prd')).toBe('/api/chats/real-chat/artifacts/prd');
    expect(chatApi.artifactUrl('fixed-demo-roomdesk-not-a-uuid', 'prd')).toBe('/api/chats/fixed-demo-roomdesk-not-a-uuid/artifacts/prd');
  });
  it('keeps real chat lists usable when demo storage is unavailable', async () => {
    request.get.mockResolvedValue([{ id: 'real', title: '真实聊天', updatedAt: '2026-11-06T00:00:00.000Z', status: 'completed' }]);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable'); } });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await chatApi.list()).map(chat => chat.id)).toEqual(['real']);
    warning.mockRestore();
  });
});
