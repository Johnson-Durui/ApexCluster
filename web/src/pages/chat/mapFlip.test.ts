import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_FADE_MS, FLIP_MS, settleTimer } from './mapFlip';

const SETTLE = FLIP_MS + CANVAS_FADE_MS;

describe('FLIP settle timer', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('lets only the latest FLIP settle: Alt+A three times never ends the last FLIP early', () => {
    vi.useFakeTimers();
    const settle = settleTimer();
    const calls: string[] = [];
    settle.arm(SETTLE, () => calls.push('docked→full'));
    vi.advanceTimersByTime(300);
    settle.arm(SETTLE, () => calls.push('full→docked'));
    vi.advanceTimersByTime(300);
    settle.arm(SETTLE, () => calls.push('docked→full again'));
    // The first two timers would have fired at 640 and 940 ms, while the third FLIP's cards still move.
    vi.advanceTimersByTime(SETTLE - 1);
    expect(calls).toEqual([]);
    expect(settle.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['docked→full again']);
    expect(settle.pending()).toBe(false);
  });

  it('settles at once when nothing moved, and never fires after cancel (unmount)', () => {
    vi.useFakeTimers();
    const settle = settleTimer();
    const done = vi.fn();
    settle.arm(0, done);
    expect(done).toHaveBeenCalledTimes(1);
    settle.arm(SETTLE, done);
    settle.cancel();
    vi.advanceTimersByTime(SETTLE * 2);
    expect(done).toHaveBeenCalledTimes(1);
    expect(settle.pending()).toBe(false);
  });
});
