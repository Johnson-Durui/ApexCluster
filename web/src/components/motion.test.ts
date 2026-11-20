import { describe, expect, it, vi } from 'vitest';
import { animateOnce, resolveReducedMotion, storedMotionPreference, tweenNumber } from './motion';
import { createSeatFocusStore } from './seatFocus';

describe('motion foundation', () => {
  it('treats a throwing localStorage as "not reduced"', () => {
    expect(storedMotionPreference({ getItem: () => { throw new Error('SecurityError'); } })).toBeNull();
    expect(resolveReducedMotion(false, storedMotionPreference({ getItem: () => { throw new Error('SecurityError'); } }))).toBe(false);
  });

  it('reduces motion for the media query or the dmw:motion QA switch', () => {
    expect(storedMotionPreference({ getItem: key => key === 'dmw:motion' ? 'reduce' : null })).toBe('reduce');
    expect(storedMotionPreference({ getItem: () => 'full' })).toBeNull();
    expect(resolveReducedMotion(true, null)).toBe(true);
    expect(resolveReducedMotion(false, 'reduce')).toBe(true);
    expect(resolveReducedMotion(false, null)).toBe(false);
  });

  it('lands tweens on the final value without a frame loop when there is no window', () => {
    const update = vi.fn();
    const done = vi.fn();
    tweenNumber({ from: 0, to: 18200, onUpdate: update, onDone: done });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(18200);
    expect(done).toHaveBeenCalledTimes(1);
    expect(animateOnce(null, [{ opacity: 0 }, { opacity: 1 }])).toBeNull();
  });
});

describe('seat focus store', () => {
  it('writes the focus to data attributes, keeps a pin over hover and toggles the pin', () => {
    const element = { dataset: {} as Record<string, string> };
    const store = createSeatFocusStore(() => element as unknown as HTMLElement);
    const seen = vi.fn();
    store.subscribe(seen);
    store.hover('astra');
    expect(element.dataset).toEqual({ focusSeat: 'astra' });
    store.pin('sol');
    expect(element.dataset).toEqual({ focusSeat: 'sol', pinned: 'true' });
    store.hover('claude');
    store.hover(undefined);
    expect(store.get()).toEqual({ seat: 'sol', pinned: true });
    store.pin('sol');
    expect(store.get()).toEqual({ pinned: false });
    expect(element.dataset).toEqual({});
    store.hover('grok');
    store.clear();
    expect(element.dataset).toEqual({});
    expect(seen).toHaveBeenCalledTimes(5);
  });
});
