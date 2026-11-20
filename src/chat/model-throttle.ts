import type { ProviderRequestHooks } from '../providers/types.js';

interface Waiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  abort: () => void;
}

interface ModelState {
  capacity: number | null;
  limit: number | null;
  active: number;
  queue: Waiter[];
  successes: number;
  cooldownUntil: number;
  timer?: NodeJS.Timeout;
}

export interface ModelThrottleMetrics {
  capacity: number | null;
  limit: number | null;
  active: number;
  queued: number;
  cooldownUntil: number;
}

/** Per-runtime request gate with adaptive model-level 429 backoff. */
export class ModelThrottle {
  private readonly states = new Map<string, ModelState>();

  hooks(modelId: string, capacity: number | null): ProviderRequestHooks {
    const state = this.state(modelId, capacity);
    return {
      beforeAttempt: signal => this.acquire(state, signal),
      onRateLimit: retryAfterMs => this.rateLimit(state, retryAfterMs),
      onSuccess: () => this.success(state),
    };
  }

  metrics(modelId: string): ModelThrottleMetrics | undefined {
    const state = this.states.get(modelId);
    return state && {
      capacity: state.capacity,
      limit: state.limit,
      active: state.active,
      queued: state.queue.length,
      cooldownUntil: state.cooldownUntil,
    };
  }

  private state(modelId: string, capacity: number | null): ModelState {
    if (!modelId.trim()) throw new Error('型号并发闸门缺少型号 ID');
    if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 1)) throw new Error('型号并发上限必须为正整数或 null');
    const existing = this.states.get(modelId);
    if (existing) {
      if (capacity !== null && (existing.capacity === null || capacity < existing.capacity)) {
        existing.capacity = capacity;
        existing.limit = Math.min(existing.limit ?? capacity, capacity);
      }
      return existing;
    }
    const created: ModelState = { capacity, limit: capacity, active: 0, queue: [], successes: 0, cooldownUntil: 0 };
    this.states.set(modelId, created);
    return created;
  }

  private acquire(state: ModelState, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.available(state)) return Promise.resolve(this.enter(state));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          if (!state.queue.length && state.timer) {
            clearTimeout(state.timer);
            state.timer = undefined;
          }
          reject(new DOMException('Request was cancelled', 'AbortError'));
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      state.queue.push(waiter);
      this.schedule(state);
    });
  }

  private enter(state: ModelState): () => void {
    state.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active--;
      this.drain(state);
    };
  }

  private available(state: ModelState): boolean {
    return Date.now() >= state.cooldownUntil && (state.limit === null || state.active < state.limit);
  }

  private rateLimit(state: ModelState, retryAfterMs = 0): void {
    const current = state.limit ?? Math.max(1, state.active);
    const cooldown = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
    state.limit = Math.max(1, Math.floor(current / 2));
    state.successes = 0;
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldown);
    this.schedule(state);
  }

  private success(state: ModelState): void {
    if (state.limit === null || (state.capacity !== null && state.limit >= state.capacity)) return;
    state.successes++;
    if (state.successes < state.limit) return;
    state.successes = 0;
    state.limit++;
    if (state.capacity !== null) state.limit = Math.min(state.limit, state.capacity);
    this.drain(state);
  }

  private schedule(state: ModelState): void {
    if (!state.queue.length) return;
    if (state.cooldownUntil <= Date.now()) {
      this.drain(state);
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.drain(state);
    }, Math.min(state.cooldownUntil - Date.now(), 2_147_483_647));
  }

  private drain(state: ModelState): void {
    if (state.cooldownUntil > Date.now()) {
      this.schedule(state);
      return;
    }
    while (state.queue.length && this.available(state)) {
      const waiter = state.queue.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(new DOMException('Request was cancelled', 'AbortError'));
        continue;
      }
      waiter.resolve(this.enter(state));
    }
  }
}
