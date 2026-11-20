// Cooperative scheduler for the scripted chats (README.md "Scenario").
//
// A script is a generator. It yields:
//   number          wait that many milliseconds of demo time
//   { all: [...] }  start the given scripts now, in the same tick, and continue when all of them have finished
//   { wait: name }  block until signal(name) is called (a gate decision, an answer, the first stream connection)
//
// Every fiber has a wake-up time on one virtual timeline, and fibers always run in (wake time, creation order).
// Two drivers run that timeline:
// - instant: runs synchronously as fast as possible (pre-baked chats and the rebuild after a page reload). The
//   chat's timestamps are then derived from the virtual time.
// - live: waits real time between steps through mock/clock.ts, so ?speed= and the pill's speed switch apply,
//   including to a wait that is already in progress.
// Because both drivers use the same order, a rebuild reproduces the same event sequence as the live run.
import { after, getSpeed, onSpeed } from './clock';

export type Step = number | { all: Script[] } | { wait: string };
export type Script = Generator<Step, void, unknown>;

interface Fiber { id: number; gen: Script; parent: Fiber | null; pending: number; wakeAt: number }

// Demo time that keeps running across speed changes: real time multiplied by the speed that was in force.
let demoBase = 0;
let realBase = Date.now();
let currentSpeed: number = getSpeed();
onSpeed(speed => {
  const real = Date.now();
  demoBase += (real - realBase) * currentSpeed;
  realBase = real;
  currentSpeed = speed;
});

/** Milliseconds of demo time since the page started (real ms × speed, summed over speed changes). */
export function demoNow(): number {
  return demoBase + (Date.now() - realBase) * currentSpeed;
}

export class Scheduler {
  /** Virtual time of the step being run (or of the last step). */
  vnow = 0;
  private queue: Fiber[] = [];
  private blocked = new Map<string, Fiber[]>();
  private nextId = 0;
  private live = false;
  private offset = 0;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly onError: (error: unknown) => void) {}

  get isLive(): boolean { return this.live; }
  get isStopped(): boolean { return this.stopped; }

  /** Current virtual time: in live mode it keeps moving with demo time. */
  time(): number {
    return this.live ? Math.max(this.vnow, demoNow() + this.offset) : this.vnow;
  }

  /** Starts a script `delay` demo-ms from now. */
  spawn(gen: Script, delay = 0): void {
    if (this.stopped) return;
    this.enqueue({ id: ++this.nextId, gen, parent: null, pending: 0, wakeAt: this.time() + Math.max(0, delay) });
    this.arm();
  }

  /** Releases every fiber blocked on `name`; they continue `delay` demo-ms from now. Returns how many were released. */
  signal(name: string, delay = 0): number {
    const fibers = this.blocked.get(name) ?? [];
    this.blocked.delete(name);
    const at = this.time() + Math.max(0, delay);
    for (const fiber of fibers) {
      fiber.wakeAt = at;
      this.enqueue(fiber);
    }
    if (fibers.length) this.arm();
    return fibers.length;
  }

  /** True while some fiber is blocked on `name`. */
  waiting(name: string): boolean {
    return (this.blocked.get(name)?.length ?? 0) > 0;
  }

  /** No fiber is scheduled to run (fibers may still be blocked on signals). */
  idle(): boolean {
    return this.queue.length === 0;
  }

  /** Drops every fiber and timer; new scripts can still be spawned afterwards. Used by cancel. */
  clear(): void {
    this.queue = [];
    this.blocked.clear();
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** Drops every fiber and timer for good. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  /**
   * Instant driver: runs due fibers synchronously until nothing is scheduled, or until `beforeStep` returns false.
   * `beforeStep` runs before every step (the rebuild applies recorded inputs there).
   */
  runInstant(beforeStep?: () => boolean): void {
    while (!this.stopped && !this.live && this.queue.length) {
      if (beforeStep && !beforeStep()) return;
      if (!this.queue.length) return;
      const fiber = this.queue.shift()!;
      this.vnow = Math.max(this.vnow, fiber.wakeAt);
      this.step(fiber);
    }
  }

  /** Advances the virtual clock without running anything (instant mode only). */
  advance(ms: number): void {
    if (!this.live) this.vnow += Math.max(0, ms);
  }

  /** Switches to the live driver: from now on fibers wait real (speed-scaled) time. */
  goLive(): void {
    if (this.live || this.stopped) return;
    this.live = true;
    this.offset = this.vnow - demoNow();
    this.arm();
  }

  private enqueue(fiber: Fiber): void {
    let low = 0;
    let high = this.queue.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const other = this.queue[middle];
      if (other.wakeAt < fiber.wakeAt || (other.wakeAt === fiber.wakeAt && other.id < fiber.id)) low = middle + 1;
      else high = middle;
    }
    this.queue.splice(low, 0, fiber);
  }

  private arm(): void {
    if (!this.live || this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const next = this.queue[0];
    if (!next) return;
    this.cancelTimer = after(Math.max(0, next.wakeAt - this.time()), () => {
      this.cancelTimer = null;
      this.pump();
    });
  }

  private pump(): void {
    const now = this.time();
    // Everything due runs in this one task, so events of fibers that wake together reach React in one batch.
    while (!this.stopped && this.queue.length && this.queue[0].wakeAt <= now + 1) {
      const fiber = this.queue.shift()!;
      this.vnow = Math.max(this.vnow, fiber.wakeAt);
      this.step(fiber);
    }
    this.arm();
  }

  private step(fiber: Fiber): void {
    let result: IteratorResult<Step, void>;
    try {
      result = fiber.gen.next();
    } catch (error) {
      this.onError(error);
      result = { done: true, value: undefined };
    }
    if (this.stopped) return;
    if (result.done) {
      this.finish(fiber);
      return;
    }
    const value = result.value;
    if (typeof value === 'number') {
      fiber.wakeAt = this.vnow + Math.max(0, value);
      this.enqueue(fiber);
      return;
    }
    if ('all' in value) {
      // +1 keeps the parent from resuming while later children are still being created.
      fiber.pending = value.all.length + 1;
      for (const gen of value.all) this.step({ id: ++this.nextId, gen, parent: fiber, pending: 0, wakeAt: this.vnow });
      this.childDone(fiber);
      return;
    }
    const list = this.blocked.get(value.wait) ?? [];
    list.push(fiber);
    this.blocked.set(value.wait, list);
  }

  private finish(fiber: Fiber): void {
    if (fiber.parent) this.childDone(fiber.parent);
  }

  private childDone(parent: Fiber): void {
    parent.pending -= 1;
    if (parent.pending > 0) return;
    parent.wakeAt = this.vnow;
    this.enqueue(parent);
  }
}
