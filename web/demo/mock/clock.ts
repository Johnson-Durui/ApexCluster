// Scaled scheduler for scripted demo timelines (README.md "Mock contract").
//
// - now() is the real wall clock (Date.now()), because the product compares event timestamps with Date.now().
// - after(ms, fn) runs fn after ms of demo time, which is ms / speed of real time.
// - setSpeed() reschedules every pending timer: the demo time a timer still had to wait is kept, only the real
//   delay changes.
// - The initial speed comes from ?speed=1|2|4 in location.search (the part before '#'); without one, from the speed
//   last chosen in this tab (sessionStorage); otherwise 1. setSpeed() remembers the choice for a reload: it writes
//   sessionStorage and, when the address carries ?speed=, updates that parameter (history.replaceState, hash kept).

export type Speed = 1 | 2 | 4;

const SPEEDS: readonly Speed[] = [1, 2, 4];
const SPEED_KEY = 'mawb-demo:speed';

function readInitialSpeed(): Speed {
  try {
    const value = Number(new URLSearchParams(location.search).get('speed'));
    if ((SPEEDS as readonly number[]).includes(value)) return value as Speed;
  } catch { /* no location */ }
  try {
    const saved = Number(sessionStorage.getItem(SPEED_KEY));
    if ((SPEEDS as readonly number[]).includes(saved)) return saved as Speed;
  } catch { /* storage unavailable */ }
  return 1;
}

/** Keeps the chosen speed for a reload of this tab. */
function rememberSpeed(value: Speed): void {
  try { sessionStorage.setItem(SPEED_KEY, String(value)); } catch { /* storage unavailable */ }
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('speed')) return;
    url.searchParams.set('speed', String(value));
    history.replaceState(history.state, '', url.href);
  } catch { /* no history API */ }
}

interface Timer {
  fn: () => void;
  /** Demo milliseconds still to wait, measured at `startedAt`. */
  remaining: number;
  /** Real Date.now() when the current setTimeout was armed. */
  startedAt: number;
  handle: ReturnType<typeof setTimeout>;
}

let speed: Speed = readInitialSpeed();
const timers = new Set<Timer>();
const listeners = new Set<(speed: Speed) => void>();

/** Real wall-clock milliseconds. */
export function now(): number {
  return Date.now();
}

export function getSpeed(): Speed {
  return speed;
}

export function isSpeed(value: unknown): value is Speed {
  return (SPEEDS as readonly unknown[]).includes(value);
}

function arm(timer: Timer): void {
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => {
    timers.delete(timer);
    try {
      timer.fn();
    } catch (error) {
      console.error('[demo] clock callback failed', error);
    }
  }, Math.max(0, timer.remaining / speed));
}

/** Runs fn after `ms` of demo time (ms / speed real milliseconds). Returns a cancel function. */
export function after(ms: number, fn: () => void): () => void {
  const timer: Timer = { fn, remaining: Math.max(0, ms), startedAt: 0, handle: 0 as unknown as ReturnType<typeof setTimeout> };
  timers.add(timer);
  arm(timer);
  return () => {
    if (!timers.delete(timer)) return;
    clearTimeout(timer.handle);
  };
}

/** Promise form of after(). Rejects with an AbortError when the signal aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('The operation was aborted.', 'AbortError')); return; }
    const cancel = after(ms, () => { signal?.removeEventListener('abort', onAbort); resolve(); });
    const onAbort = () => { cancel(); reject(new DOMException('The operation was aborted.', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Changes the speed, reschedules pending timers and notifies onSpeed listeners. Other values are ignored. */
export function setSpeed(next: number): void {
  if (!isSpeed(next) || next === speed) return;
  const real = Date.now();
  for (const timer of timers) {
    clearTimeout(timer.handle);
    timer.remaining = Math.max(0, timer.remaining - (real - timer.startedAt) * speed);
  }
  speed = next;
  rememberSpeed(next);
  for (const timer of timers) arm(timer);
  for (const listener of [...listeners]) {
    try {
      listener(speed);
    } catch (error) {
      console.error('[demo] onSpeed listener failed', error);
    }
  }
}

/** Calls fn after every speed change. Returns the unsubscribe function. */
export function onSpeed(fn: (speed: Speed) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
