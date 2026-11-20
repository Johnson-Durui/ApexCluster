import type { StatusKind } from '../../components/ui';

const statusLabels: Record<string, string> = {
  idle: '尚未开始',
  queued: '排队中',
  running: '执行中',
  waiting_user: '等待你回答',
  waiting_children: '等待子任务',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已停止',
  interrupted: '已中断',
  blocked: '会话受阻',
};

const statusKinds: Record<string, StatusKind> = {
  idle: 'idle',
  queued: 'queue',
  running: 'run',
  waiting_user: 'you',
  waiting_children: 'child',
  completed: 'ok',
  failed: 'err',
  cancelled: 'stop',
  interrupted: 'err',
  blocked: 'block',
};

export function chatStatusLabel(status: string): string {
  return statusLabels[status] ?? '状态未知';
}

/** Status glyph/colour kind for a chat status (glyph + word + colour, never colour alone). Unknown → idle. */
export function chatStatusKind(status: string): StatusKind {
  return statusKinds[status] ?? 'idle';
}

export function parseChatHash(hash: string): { chatId: string | null; newChat: boolean } {
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  return { chatId: params.get('chat'), newChat: params.get('new') === '1' };
}
