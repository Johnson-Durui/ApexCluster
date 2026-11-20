// Replacement for web/src/lib/fixed-demo.ts in the demo build (vite.config.ts, plugin 'demo-overrides').
//
// The product sends the exact FIXED_DEMO_PROMPT through useFixedDemoPlayback.start() → startFixedDemo(). Here that
// starts the scripted RoomDesk pipeline chat in the mock chat store and returns its first snapshot (the user message
// and events 1-2). The product then navigates to #/?chat=<id>. Because isFixedDemoId() is always false, everything
// after that goes through the ordinary GET + event-stream path of mock/chats.ts, exactly like a real chat, and the
// product's fixed-demo-only UI (FixedDemoBar, the product modal) never mounts.
//
// Rules for this module:
// - Only `import type` from web/src. chat-api.ts imports this module, so a value import from it would be circular.
// - Every export of the product module stays, with a compatible signature (overrides/conformance.ts checks it).
// - getFixedDemoPlayback() is called during render and must never throw.
import type { ChatRecord, ChatSnapshot, ChatSummary } from '../../src/lib/chat-api';
import { ROOMDESK_PROMPT, chatSnapshot, findChat, startRoomDeskLive } from '../mock/chats';

/** The RoomDesk prompt (README.md "Scenario"), defined once in scenario/content.ts. */
export const FIXED_DEMO_PROMPT: string = ROOMDESK_PROMPT;

export function isFixedDemoPrompt(text: string): boolean {
  return text.trim().normalize('NFC') === FIXED_DEMO_PROMPT.normalize('NFC');
}

/** Always false: demo chats are ordinary mock chats, so the product never routes them to the fixed-demo feed. */
export function isFixedDemoId(id: string | undefined): boolean {
  void id;
  return false;
}

/** Starts the RoomDesk pipeline chat and returns its snapshot (chat.seq 2: task_updated(queued) and the message). */
export async function startFixedDemo(clientMessageId: string): Promise<ChatSnapshot> {
  if (!clientMessageId) throw new Error('演示启动失败：缺少消息编号。');
  const chat = startRoomDeskLive(clientMessageId);
  return chat.snapshot();
}

export async function getFixedDemoSnapshot(id: string): Promise<ChatSnapshot> {
  const snapshot = chatSnapshot(id);
  if (!snapshot) throw new Error('聊天不存在或记录损坏');
  return snapshot;
}

export function listFixedDemos(): ChatSummary[] {
  return [];
}

/** Never called (isFixedDemoId is false); kept for the product's types. */
export function subscribeFixedDemo(id: string, listener: (snapshot: ChatSnapshot) => void, onError: (error: Error) => void): () => void {
  void id; void listener; void onError;
  return () => undefined;
}

export async function pauseFixedDemo(id: string, paused: boolean): Promise<ChatRecord> {
  void paused;
  const chat = findChat(id);
  if (!chat) throw new Error('聊天不存在或记录损坏');
  throw new Error('在线演示不支持暂停，可以在底部切换播放速度。');
}

/** Never called (chatApi.cancel uses the /api route for non-fixed ids); answers like that route. */
export async function cancelFixedDemo(id: string): Promise<ChatRecord> {
  const chat = findChat(id);
  if (!chat) throw new Error('聊天不存在或记录损坏');
  chat.cancel();
  return JSON.parse(JSON.stringify(chat.record)) as ChatRecord;
}

/** Never called (chatApi.artifactUrl uses the /api URL for non-fixed ids); returns that same URL. */
export function fixedDemoArtifactUrl(id: string, artifactId: string): string {
  return `/api/chats/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function getFixedDemoPlayback(id: string): { elapsedMs: number; durationMs: 240000; paused: boolean; completed: boolean; cancelled: boolean; productReady: boolean } {
  void id;
  return { elapsedMs: 0, durationMs: 240000, paused: false, completed: false, cancelled: false, productReady: false };
}
