// One demo chat held the way the workbench server holds it (src/chat/store.ts, runtime.ts): a ChatRecord, its
// messages, an append-only event log with strictly increasing seq (record.seq is always the last seq), the live
// stream buffers and the artifact files. Scripts (scenario/*) change the record only through chat-ops.ts, which
// emits the same events, with the same data shapes and refs, as runtime.emit() on the server.
//
// External inputs (send, gate decision, answer, cancel) go through the methods at the bottom. Each one is recorded
// with the seq at which it happened, so mock/chats.ts can rebuild the chat after a page reload by replaying the
// script with the same inputs (see replayChat there).
import type {
  AgentTask, ChatEvent, ChatMessage, ChatPipeline, ChatRecord, ChatSnapshot, ChatStream, ChatSummary, DriverCapability,
  Invocation, MessagePage,
} from '../../src/lib/chat-api';
import { Scheduler } from './chat-scheduler';

export type ServerTask = AgentTask & {
  phase?: string;
  pipelineWork?: { kind: string; milestoneId?: string };
  clusterId?: string;
  executionReviewOfTaskId?: string;
};
export type ServerInvocation = Invocation & { usage?: { input: number; cachedInput: number; output: number } };
export type ServerPipeline = ChatPipeline & {
  version: 1;
  quality: { crossReview: boolean; maxReworkRounds: number; clusterCrossRounds: number };
  revisionStartedAt?: string;
  architectureTaskId?: string;
  implementationTaskId?: string;
  contract?: { ref: string; hash: string; contractSha256: string; artifactId: string; revision: number };
  priorContracts: unknown[];
  clusters: unknown[];
  gateDecisions: Array<{ gateId: 'A' | 'B'; decision: 'confirm' | 'revise' | 'cancel'; messageId: string; automatic: boolean; revision: number }>;
};
export interface ServerChat extends Omit<ChatRecord, 'tasks' | 'invocations' | 'pipeline'> {
  tasks: ServerTask[];
  invocations: ServerInvocation[];
  pipeline?: ServerPipeline;
  planRevision?: number;
}

/** What happened to the chat from outside the script, in order. `atSeq` is record.seq when it happened. */
export type ChatInput =
  | { type: 'send'; text: string; clientMessageId: string; atSeq?: number; delay?: number }
  | { type: 'gate'; gate: 'A' | 'B'; auto: boolean; atSeq?: number; delay?: number }
  | { type: 'answer'; ticketId: string; text: string; clientMessageId: string; atSeq?: number; delay?: number }
  | { type: 'cancel'; atSeq?: number; delay?: number };

export type InputResult = { ok: true; message?: ChatMessage } | { ok: false; status: number; error: string };

/** The scripted behaviour behind one chat. Every method runs synchronously inside the request that triggered it. */
export interface ChatDriver {
  readonly kind: string;
  send(chat: DemoChat, text: string, clientMessageId: string): InputResult;
  gate(chat: DemoChat, gate: 'A' | 'B', auto: boolean): InputResult;
  answer(chat: DemoChat, ticketId: string, text: string, clientMessageId: string): InputResult;
  cancel(chat: DemoChat): void;
  /** The chat switched to the live driver (after creation or a rebuild). */
  onLive?(chat: DemoChat): void;
  /** The first event stream subscribed. */
  onConnect?(chat: DemoChat): void;
}

/** Deterministic random numbers (mulberry32), seeded by the chat id, so a rebuild produces the same ids. */
export class Rng {
  private state: number;
  constructor(seed: string) {
    let hash = 2166136261;
    for (let index = 0; index < seed.length; index++) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    this.state = hash >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += Math.floor(this.next() * 0x100000000).toString(16).padStart(8, '0');
    return out.slice(0, length);
  }
  uuid(): string {
    const hex = this.hex(32);
    const variant = '89ab'[this.int(0, 3)];
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}

/** The five roster seats as the server's snapshot lists them (the server's chat capability snapshot; pools are not listed). */
export const ROSTER_CAPABILITIES: DriverCapability[] = [
  { role: 'claude', available: true, version: '1.9.0', fingerprint: 'e3e2427efd1e1cac7e940e9be45b00372df370411ef825fa3391e3cc471ac8a2', isolationVerified: true, contextWindow: 1000000, contextHard: 240000, model: 'claude-fable-5-2', effort: 'max' },
  { role: 'astra', available: true, version: '7.57.0', fingerprint: '5a7dc4107d31b1afd67f3f95c1af493f493cd06aaf2ca8171d36583a59e13847', isolationVerified: true, contextWindow: 1050000, contextHard: 240000, model: 'gpt-6.2-astra', effort: 'max' },
  { role: 'opus', available: true, version: '1.9.0', fingerprint: '56fe42d7ea04fdcbaaf58cedeeda2280c678b216c51fa3b0a3a77f86f1ddb628', isolationVerified: true, contextWindow: 1000000, contextHard: 240000, model: 'claude-opus-5-5', effort: 'max' },
  { role: 'carbon', available: true, version: '3.4.0', fingerprint: 'f4c586d9bc19ff5c2fbd695177d8bbe43244644beb83d103f867dc296986aaf0', isolationVerified: true, contextWindow: 1048576, contextHard: 240000, model: 'gemini-4-carbon', effort: 'high' },
  { role: 'sol', available: true, version: '7.57.0', fingerprint: '585e571221d54d85200189edd09bc2343e09df0cd28cfd07ed5fc907a88b0b96', isolationVerified: true, contextWindow: 1050000, contextHard: 240000, model: 'gpt-6.2-sol', effort: 'max' },
];

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface DemoChatOptions {
  id: string;
  title: string;
  /** Wall-clock ms of virtual time 0 (the chat's creation). */
  wallBase: number;
  workspaceId?: string;
  pipeline?: ServerPipeline;
}

export class DemoChat {
  readonly id: string;
  readonly record: ServerChat;
  readonly messages: ChatMessage[] = [];
  readonly events: ChatEvent[] = [];
  /** Stream buffers by invocation id (the server's live streams). */
  readonly streams = new Map<string, ChatStream>();
  readonly listeners = new Set<(event: ChatEvent) => void>();
  /** Artifact id → content key in scenario/content.ts. */
  readonly artifactFiles = new Map<string, string>();
  readonly sched: Scheduler;
  readonly rng: Rng;
  /** Inputs applied so far (recorded for the rebuild). */
  readonly inputs: ChatInput[] = [];
  driver: ChatDriver | null = null;
  wallBase: number;
  /** Wall-clock ms per virtual ms while fast-forwarding (a rebuild maps the replay onto the real interval). */
  wallScale = 1;
  /** While true, inputs are not recorded (a rebuild is replaying recorded ones). */
  replaying = false;
  /** Called after every event and input (mock/chats.ts saves live chats). */
  onChange: (() => void) | null = null;
  private connected = false;

  constructor(options: DemoChatOptions) {
    this.id = options.id;
    this.wallBase = options.wallBase;
    this.rng = new Rng(options.id);
    this.sched = new Scheduler(error => console.error('[demo] chat script failed', options.id, error));
    const createdAt = new Date(options.wallBase).toISOString();
    this.record = {
      version: 1, id: options.id, title: options.title, createdAt, updatedAt: createdAt,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      seq: 0, messageSeq: 0, turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [],
      constraintMessageIds: [], todos: [], fanoutGroups: [],
      ...(options.pipeline ? { pipeline: options.pipeline } : {}),
    };
  }

  /** Wall-clock ms for timestamps: real time when live, derived from the virtual clock while fast-forwarding. */
  nowMs(): number {
    return this.sched.isLive ? Date.now() : Math.round(this.wallBase + this.sched.vnow * this.wallScale);
  }

  iso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /**
   * Appends one event (runtime.emit). `data` may be a function, evaluated after record.seq has advanced, for events
   * that carry the whole record. Listeners (open event streams) receive it synchronously.
   */
  emit(type: string, data: unknown, refs: { task?: ServerTask; invocation?: Invocation } = {}): ChatEvent {
    const seq = this.record.seq + 1;
    const at = this.iso();
    this.record.seq = seq;
    this.record.updatedAt = at;
    const value = typeof data === 'function' ? (data as () => unknown)() : data;
    const event: ChatEvent = {
      seq, chatId: this.id, type, at, data: clone(value),
      ...(refs.task ? { taskId: refs.task.id, ...(refs.task.parentTaskId ? { parentTaskId: refs.task.parentTaskId } : {}), turnId: refs.task.turnId } : {}),
      ...(refs.invocation ? { invocationId: refs.invocation.id } : {}),
    };
    this.events.push(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[demo] chat event listener failed', error);
      }
    }
    this.onChange?.();
    return event;
  }

  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.connected) {
      this.connected = true;
      this.driver?.onConnect?.(this);
    }
    return () => { this.listeners.delete(listener); };
  }

  // ------------------------------------------------------------ reads

  snapshot(): ChatSnapshot {
    const messages = this.messages.slice(-50);
    const first = messages[0];
    return clone({
      chat: this.record as ChatRecord,
      messages,
      ...(first && first.seq > 1 && this.messages.length > messages.length ? { nextBefore: first.seq } : {}),
      capabilities: ROSTER_CAPABILITIES,
      streams: [...this.streams.values()].filter(stream => stream.status === 'running'),
      recentEvents: this.events.filter(event => event.seq > this.record.seq - 500),
    });
  }

  summary(): ChatSummary {
    return {
      id: this.id, title: this.record.title, ...(this.record.workspaceId ? { workspaceId: this.record.workspaceId } : {}),
      updatedAt: this.record.updatedAt, status: this.record.turns.at(-1)?.status ?? 'completed',
    };
  }

  /** GET /trace: events after `since`, at most 500 (src/chat/http.ts). */
  trace(since: number): { items: ChatEvent[]; hasMore: boolean; next: number; schemaVersion: 1 } {
    const later = this.events.filter(event => event.seq > since);
    const items = later.slice(0, 500);
    return clone({ items, hasMore: later.length > items.length, next: items.at(-1)?.seq ?? since, schemaVersion: 1 as const });
  }

  /** GET /messages?before=N&limit=50 (src/chat/store.ts). */
  messagePage(before: number, limit: number): MessagePage {
    const older = this.messages.filter(message => message.seq < before);
    const items = older.slice(-Math.max(1, Math.min(limit, 200)));
    return clone({ items, ...(items[0] && items[0].seq > 1 ? { nextBefore: items[0].seq } : {}) });
  }

  // ------------------------------------------------------------ inputs

  private record_(input: ChatInput): void {
    if (this.replaying) return;
    this.inputs.push({ ...input, atSeq: this.record.seq });
  }

  send(text: string, clientMessageId: string): InputResult {
    const existing = this.messages.find(message => message.clientMessageId === clientMessageId && message.role === 'user');
    if (existing) return { ok: true, message: existing };
    if (!this.driver) return { ok: false, status: 409, error: '在线演示未提供此会话的处理脚本。' };
    const seq = this.record.seq;
    const result = this.driver.send(this, text, clientMessageId);
    if (result.ok && !this.replaying) this.inputs.push({ type: 'send', text, clientMessageId, atSeq: seq });
    if (result.ok) this.onChange?.();
    return result;
  }

  decideGate(gate: 'A' | 'B', auto: boolean): InputResult {
    if (!this.driver) return { ok: false, status: 409, error: '该关卡当前未开放' };
    const seq = this.record.seq;
    const result = this.driver.gate(this, gate, auto);
    if (result.ok && !this.replaying) this.inputs.push({ type: 'gate', gate, auto, atSeq: seq });
    if (result.ok) this.onChange?.();
    return result;
  }

  answer(ticketId: string, text: string, clientMessageId: string): InputResult {
    if (!this.driver) return { ok: false, status: 409, error: '该问题已回答或不存在。' };
    const seq = this.record.seq;
    const result = this.driver.answer(this, ticketId, text, clientMessageId);
    if (result.ok && !this.replaying) this.inputs.push({ type: 'answer', ticketId, text, clientMessageId, atSeq: seq });
    if (result.ok) this.onChange?.();
    return result;
  }

  cancel(): void {
    this.record_({ type: 'cancel' });
    this.driver?.cancel(this);
    this.onChange?.();
  }

  /** Applies a recorded input during a rebuild. */
  applyRecorded(input: ChatInput): void {
    if (input.type === 'send') this.send(input.text, input.clientMessageId);
    else if (input.type === 'gate') this.decideGate(input.gate, input.auto);
    else if (input.type === 'answer') this.answer(input.ticketId, input.text, input.clientMessageId);
    else this.cancel();
  }
}
