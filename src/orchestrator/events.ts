/**
 * 事件总线：所有状态变化都会产生事件，追加到 events.jsonl 并推送给订阅者（SSE）。
 * 页面断线重连时用 Last-Event-ID / ?since= 补发，保证“模型提出的问题一定能同步到页面”。
 */
import type { RunStore } from './store.js';

export type RunEventType =
  | 'run.updated'
  | 'task.updated'
  | 'task.progress'
  | 'question.added'
  | 'question.updated'
  | 'snapshot.created'
  | 'proposals.updated'
  | 'decision.updated'
  | 'gate.opened'
  | 'gate.resolved'
  | 'job.updated'
  | 'docs.updated';

export interface RunEvent {
  seq: number;
  runId: string;
  at: string;
  type: RunEventType;
  payload: unknown;
}

type Listener = (ev: RunEvent) => void;

export class EventBus {
  private seqs = new Map<string, number>();
  private listeners = new Map<string, Set<Listener>>();
  constructor(private readonly store: RunStore) {}

  private nextSeq(runId: string): number {
    let s = this.seqs.get(runId);
    if (s === undefined) {
      const lines = this.store.readEventLines(runId);
      const last = lines.at(-1);
      s = last ? (JSON.parse(last) as RunEvent).seq : 0;
    }
    s += 1;
    this.seqs.set(runId, s);
    return s;
  }

  publish(runId: string, type: RunEventType, payload: unknown): RunEvent {
    const ev: RunEvent = { seq: this.nextSeq(runId), runId, at: new Date().toISOString(), type, payload };
    this.store.appendEventLine(runId, JSON.stringify(ev));
    for (const l of this.listeners.get(runId) ?? []) {
      try {
        l(ev);
      } catch {
        /* 单个订阅者出错不影响其他订阅者 */
      }
    }
    return ev;
  }

  subscribe(runId: string, fn: Listener): () => void {
    if (!this.listeners.has(runId)) this.listeners.set(runId, new Set());
    this.listeners.get(runId)!.add(fn);
    return () => this.listeners.get(runId)?.delete(fn);
  }

  replay(runId: string, afterSeq: number): RunEvent[] {
    return this.store
      .readEventLines(runId)
      .map((l) => JSON.parse(l) as RunEvent)
      .filter((e) => e.seq > afterSeq);
  }
}
