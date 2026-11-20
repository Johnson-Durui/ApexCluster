// One wording for request failures on the chat page: a 5xx says the service is temporarily unavailable and that the
// draft and the current chat are kept; anything else shows the error's own message (or the fallback).
import { ApiError } from '../../../lib/api';

export function explain(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && cause.status >= 500) return `服务暂时不可用（${cause.status}）。${cause.message}。草稿和当前聊天已保留。`;
  return cause instanceof Error ? cause.message : fallback;
}
