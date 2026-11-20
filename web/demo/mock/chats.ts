// The chat half of the mock server (README.md "Scenario"): the chat registry, every /api/chats* route the product calls, and the
// chat event stream /api/chats/:id/events. Behaviour follows src/chat/http.ts:
// - GET /api/chats/:id returns { chat, messages (last 50), nextBefore?, capabilities, streams, recentEvents }.
//   streams holds the running stream buffers and is always an array, so the client resumes the event stream
//   exactly after chat.seq. recentEvents are the events with seq > chat.seq - 500.
// - The stream replays events after ?since= (reset to 0 when since > chat.seq), at most 500 and then chat_more,
//   then delivers live events. Every frame is `chat_event` with the event JSON and id = seq.
// - POST responses carry the whole current record, written after the events of that action.
// - Writes the demo does not support answer 409 with a reason the product shows.
//
// Persistence: chats started in this tab, and pre-baked chats the visitor changed, are saved to sessionStorage as
// a recipe (kind, id, creation time, the recorded inputs and the last seq). After a reload the chat is rebuilt by
// replaying its script with those inputs in instant mode, then it continues live (replayChat below).
import type { ChatSnapshot } from '../../src/lib/chat-api';
import { ROOMDESK_PROMPT, demoFile } from '../scenario/content';
import { createPlainChat } from '../scenario/plain';
import { createRoomDeskChat, gateRefusal } from '../scenario/roomdesk';
import { SAMPLES } from '../scenario/samples';
import { clone, type ChatInput, type DemoChat } from './chat-engine';
import { READ_ONLY, fail, json, route, stream } from './router';

const chats = new Map<string, DemoChat>();
/** Answer for an unknown chat id. A chat the visitor started lives only in the tab that started it (sessionStorage),
 * so a new tab, a shared link or cleared site data cannot open it; the server's wording (记录损坏) would be wrong here. */
const NOT_FOUND = '在线演示没有服务器：你开始的聊天只保存在开始它的那个浏览器标签页里，新标签页、分享出去的链接或清除站点数据后都打不开。请回到原标签页，或点 ▶ 播放完整演示 重新开始。';

/** How each chat can be rebuilt after a reload. Pre-baked chats store only the inputs the visitor added. */
interface Recipe {
  v: 1;
  id: string;
  kind: 'roomdesk' | 'plain' | 'sample';
  createdAt: number;
  title?: string;
  workspaceId?: string;
  pipelineRequested?: boolean;
  clientMessageId?: string;
  inputs: ChatInput[];
  seq: number;
  /** Wall-clock ms of the last event when the recipe was saved (keeps the timestamps across a rebuild). */
  updatedAt?: number;
}
const recipes = new Map<string, Omit<Recipe, 'inputs' | 'seq'> & { presetInputs: number }>();
const STORAGE_KEY = 'mawb-demo:chats:v1';
const MAX_SAVED = 8;

export function findChat(id: string): DemoChat | undefined {
  return chats.get(id);
}

function randomId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `chat-${Array.from(bytes, byte => (byte % 36).toString(36)).join('')}${Date.now().toString(36).slice(-3)}`;
}

// ---------------------------------------------------------------- rebuild

/**
 * Runs a freshly created chat's script in instant mode and applies `inputs` where they happened: an input with
 * atSeq is applied when record.seq reaches it; one without atSeq (pre-baked) when every script is blocked, after
 * advancing the virtual clock by its delay. Stops at targetSeq (null: run until nothing is scheduled).
 */
export function replayChat(chat: DemoChat, inputs: ChatInput[], targetSeq: number | null): void {
  let next = 0;
  const reached = () => targetSeq !== null && chat.record.seq >= targetSeq;
  const apply = () => {
    const input = inputs[next++];
    chat.sched.advance(input.delay ?? 1500);
    chat.replaying = true;
    try {
      chat.applyRecorded(input);
    } finally {
      chat.replaying = false;
    }
    chat.inputs.push(input);
  };
  const dueBySeq = () => next < inputs.length && inputs[next].atSeq !== undefined && inputs[next].atSeq! <= chat.record.seq;
  for (let guard = 0; guard < 10_000; guard++) {
    chat.sched.runInstant(() => {
      while (dueBySeq()) apply();
      return !reached();
    });
    if (dueBySeq()) { apply(); continue; }
    if (!reached() && next < inputs.length && inputs[next].atSeq === undefined && chat.sched.idle()) { apply(); continue; }
    break;
  }
}

function goLive(chat: DemoChat): void {
  chat.sched.goLive();
  chat.driver?.onLive?.(chat);
}

function register(chat: DemoChat): void {
  chats.set(chat.id, chat);
  chat.onChange = scheduleSave;
}

function build(recipe: Recipe, wallBase: number): DemoChat | null {
  if (recipe.kind === 'roomdesk') return createRoomDeskChat({ id: recipe.id, wallBase, clientMessageId: recipe.clientMessageId ?? recipe.id, ...(recipe.title ? { title: recipe.title } : {}) });
  if (recipe.kind === 'plain') return createPlainChat({ id: recipe.id, wallBase, title: recipe.title ?? '新聊天', ...(recipe.workspaceId ? { workspaceId: recipe.workspaceId } : {}), pipelineRequested: recipe.pipelineRequested });
  return null;
}

/**
 * Rebuilds a chat started in this tab. Two passes: the first measures how much virtual time the replay takes (span).
 * The second maps virtual time onto the real interval the chat lived through: from its creation to its last saved
 * event, so the creation time, the message times and the elapsed counter stay what the visitor saw before the
 * reload, whatever speed the run was watched at. A recipe without updatedAt (an older build) ends the replay just
 * before now instead.
 */
function rebuild(recipe: Recipe): DemoChat | null {
  const probe = build(recipe, 0);
  if (!probe) return null;
  replayChat(probe, recipe.inputs, recipe.seq);
  const span = probe.sched.vnow;
  const now = Date.now();
  const last = recipe.updatedAt;
  const anchored = typeof last === 'number' && Number.isFinite(last) && span > 0 && last > recipe.createdAt && last <= now;
  const chat = build(recipe, anchored ? recipe.createdAt : Math.min(recipe.createdAt, now - span - 1000));
  if (!chat) return null;
  if (anchored) chat.wallScale = (last - recipe.createdAt) / span;
  replayChat(chat, recipe.inputs, recipe.seq);
  return chat;
}

function readSaved(): Recipe[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is Recipe => typeof item === 'object' && item !== null && (item as Recipe).v === 1 && typeof (item as Recipe).id === 'string' && Array.isArray((item as Recipe).inputs)) : [];
  } catch {
    return [];
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => { saveTimer = undefined; saveNow(); }, 1000);
}

function saveNow(): void {
  const list: Recipe[] = [];
  for (const [id, meta] of recipes) {
    const chat = chats.get(id);
    if (!chat) continue;
    const { presetInputs, ...rest } = meta;
    const inputs = chat.inputs.slice(presetInputs);
    if (meta.kind === 'sample' && !inputs.length) continue;
    const updatedAt = Date.parse(chat.record.updatedAt);
    list.push({ ...rest, inputs, seq: chat.record.seq, ...(Number.isFinite(updatedAt) ? { updatedAt } : {}) });
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_SAVED)));
  } catch { /* private mode or quota: the chats simply do not survive a reload */ }
}

// ---------------------------------------------------------------- creation

/** Starts the scripted RoomDesk pipeline chat for the product's fixed-prompt path (overrides/fixed-demo.ts). */
export function startRoomDeskLive(clientMessageId: string): DemoChat {
  const id = randomId();
  const chat = createRoomDeskChat({ id, wallBase: Date.now(), clientMessageId });
  recipes.set(id, { v: 1, id, kind: 'roomdesk', createdAt: chat.wallBase, clientMessageId, presetInputs: 0 });
  register(chat);
  goLive(chat);
  saveNow();
  return chat;
}

function createPlainLive(title: string, workspaceId: string | undefined, pipelineRequested: boolean): DemoChat {
  const id = randomId();
  const chat = createPlainChat({ id, wallBase: Date.now(), title, ...(workspaceId ? { workspaceId } : {}), pipelineRequested });
  recipes.set(id, { v: 1, id, kind: 'plain', createdAt: chat.wallBase, title, ...(workspaceId ? { workspaceId } : {}), pipelineRequested, presetInputs: 0 });
  register(chat);
  goLive(chat);
  saveNow();
  return chat;
}

export function chatSnapshot(id: string): ChatSnapshot | null {
  return chats.get(id)?.snapshot() ?? null;
}

// ---------------------------------------------------------------- routes

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown, min: number, max: number) => typeof value === 'string' && value.length >= min && value.length <= max ? value : null;

function installRoutes(): void {
  route('GET', '/api/chats', () => json([...chats.values()].map(chat => chat.summary()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))));

  route('POST', '/api/chats', req => {
    const body = isRecord(req.body) ? req.body : {};
    const title = body.title === undefined ? '新聊天' : textOf(body.title, 1, 200);
    if (title === null) return fail(400, '标题需要 1 到 200 个字符');
    const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined;
    const chat = createPlainLive(title, workspaceId, isRecord(body.pipeline));
    return json(clone(chat.record), 201);
  });

  route('GET', '/api/chats/:id', req => {
    const snapshot = chatSnapshot(req.params.id);
    return snapshot ? json(snapshot) : fail(404, NOT_FOUND);
  });

  route('GET', '/api/chats/:id/trace', req => {
    const chat = chats.get(req.params.id);
    if (!chat) return fail(404, NOT_FOUND);
    const since = Number(req.query.get('since') ?? 0);
    return json(chat.trace(Number.isFinite(since) && since > 0 ? since : 0));
  });

  route('GET', '/api/chats/:id/messages', req => {
    const chat = chats.get(req.params.id);
    if (!chat) return fail(404, NOT_FOUND);
    const before = Number(req.query.get('before') ?? Number.MAX_SAFE_INTEGER);
    const limit = Number(req.query.get('limit') ?? 50);
    return json(chat.messagePage(Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, Number.isFinite(limit) ? limit : 50));
  });

  route('POST', '/api/chats/:id/messages', req => {
    const chat = chats.get(req.params.id);
    if (!chat) return fail(404, NOT_FOUND);
    const body = isRecord(req.body) ? req.body : {};
    const text = textOf(body.text, 1, 100_000);
    const clientMessageId = textOf(body.clientMessageId, 1, 100);
    if (text === null || !text.trim()) return fail(400, '消息内容需要 1 到 100000 个字符');
    if (clientMessageId === null) return fail(400, '缺少消息编号');
    if (Array.isArray(body.attachmentIds) && body.attachmentIds.length) return fail(409, READ_ONLY);
    const result = chat.send(text, clientMessageId);
    if (!result.ok) return fail(result.status, result.error);
    return json({ chat: clone(chat.record), message: clone(result.message) }, 202);
  });

  route('POST', '/api/chats/:id/gates/:gate', req => {
    const chat = chats.get(req.params.id);
    if (!chat) return fail(404, NOT_FOUND);
    const gate = req.params.gate;
    if (gate !== 'A' && gate !== 'B') return fail(404, '关卡不存在');
    const body = isRecord(req.body) ? req.body : {};
    const decision = body.decision;
    if (decision !== 'confirm' && decision !== 'revise' && decision !== 'cancel') return fail(400, '关卡决定无效');
    if (decision === 'revise' && !(typeof body.feedback === 'string' && body.feedback.trim())) return fail(400, '请填写要修订的要求');
    const open = chat.record.pipeline?.stage === (gate === 'A' ? 'gate-a' : 'gate-b');
    if (!open) return fail(409, '该关卡当前未开放');
    if (decision !== 'confirm') {
      const refusal = gateRefusal();
      return refusal.ok ? fail(409, READ_ONLY) : fail(refusal.status, refusal.error);
    }
    const result = chat.decideGate(gate, false);
    if (!result.ok) return fail(result.status, result.error);
    return json(clone(chat.record));
  });

  route('POST', '/api/chats/:id/answers', req => {
    const chat = chats.get(req.params.id);
    if (!chat) return fail(404, NOT_FOUND);
    const body = isRecord(req.body) ? req.body : {};
    const ticketId = textOf(body.ticketId, 1, 200);
    const text = textOf(body.text, 1, 100_000);
    const clientMessageId = textOf(body.clientMessageId, 1, 100);
    if (ticketId === null || text === null || !text.trim() || clientMessageId === null) return fail(400, '回答内容不完整');
    const result = chat.answer(ticketId, text, clientMessageId);
    if (!result.ok) return fail(result.status, result.error);
    return json(clone(chat.record), 202);
  });

  route('POST', '/api/chats/:id/cancel', req => {
    const chat = chats.get(req.params.id);
    if (!chat) return fail(404, NOT_FOUND);
    chat.cancel();
    return json(clone(chat.record));
  });

  route('GET', '/api/chats/:id/attachments', req => chats.has(req.params.id) ? json([]) : fail(404, NOT_FOUND));
  route('POST', '/api/chats/:id/attachments', () => fail(409, READ_ONLY));
  route('GET', '/api/chats/:id/attachments/:attachmentId', () => fail(404, '附件不存在'));
  route('DELETE', '/api/chats/:id/attachments/:attachmentId', () => fail(409, READ_ONLY));

  route('GET', '/api/chats/:id/artifacts/:artifactId', async req => {
    const chat = chats.get(req.params.id);
    const key = chat?.artifactFiles.get(req.params.artifactId);
    const artifact = chat?.record.artifacts.find(item => item.id === req.params.artifactId);
    if (!chat || !key || !artifact) return fail(404, '产物不存在');
    const file = demoFile(key);
    const headers = { 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}` };
    if (file.text !== undefined) return new Response(file.text, { status: 200, headers });
    try {
      const response = await fetch(new URL(file.url ?? '', document.baseURI));
      if (!response.ok) return fail(404, '交付文件暂时无法读取');
      return new Response(await response.arrayBuffer(), { status: 200, headers });
    } catch {
      return fail(404, '交付文件暂时无法读取');
    }
  });

  stream('/api/chats/:id/events', ctx => {
    const chat = chats.get(ctx.params.id);
    if (!chat) {
      ctx.close();
      return;
    }
    let since = Number(ctx.query.get('since') ?? 0);
    if (!Number.isFinite(since) || since < 0 || since > chat.record.seq) since = 0;
    const backlog = chat.events.filter(event => event.seq > since);
    if (backlog.length > 500) {
      for (const event of backlog.slice(0, 500)) ctx.emit('chat_event', event, String(event.seq));
      ctx.emit('chat_more', { since: backlog[499].seq });
      return;
    }
    for (const event of backlog) ctx.emit('chat_event', event, String(event.seq));
    return chat.subscribe(event => ctx.emit('chat_event', event, String(event.seq)));
  });
}

// ---------------------------------------------------------------- install

/** Builds the pre-baked chats, rebuilds the chats saved in this tab, and registers the routes and the stream. */
export function install(): void {
  const saved = readSaved();
  const savedById = new Map(saved.map(recipe => [recipe.id, recipe]));
  for (const sample of SAMPLES) {
    try {
      const extra = savedById.get(sample.id);
      const { chat, inputs } = sample.build(Date.now() - sample.offsetMs);
      replayChat(chat, [...inputs, ...(extra?.kind === 'sample' ? extra.inputs : [])], extra?.kind === 'sample' ? extra.seq : null);
      recipes.set(chat.id, { v: 1, id: chat.id, kind: 'sample', createdAt: chat.wallBase, presetInputs: inputs.length });
      register(chat);
      goLive(chat);
    } catch (error) {
      console.error('[demo] pre-baked chat failed to build', sample.key, error);
    }
  }
  for (const recipe of saved) {
    if (recipe.kind === 'sample' || chats.has(recipe.id)) continue;
    try {
      const chat = rebuild(recipe);
      if (!chat) continue;
      recipes.set(chat.id, { v: 1, id: chat.id, kind: recipe.kind, createdAt: chat.wallBase, ...(recipe.title ? { title: recipe.title } : {}), ...(recipe.workspaceId ? { workspaceId: recipe.workspaceId } : {}),
        ...(recipe.pipelineRequested ? { pipelineRequested: true } : {}), ...(recipe.clientMessageId ? { clientMessageId: recipe.clientMessageId } : {}), presetInputs: 0 });
      register(chat);
      goLive(chat);
    } catch (error) {
      console.error('[demo] saved chat failed to rebuild', recipe.id, error);
    }
  }
  installRoutes();
  window.addEventListener('pagehide', saveNow);
}

/** The prompt the fixed-demo path starts (re-exported for overrides/fixed-demo.ts). */
export { ROOMDESK_PROMPT };
