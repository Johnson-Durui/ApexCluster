import { describe, expect, it } from 'vitest';
import { followReducer, initialFollow, unseenCount } from './useFollowLatest';

describe('follow latest', () => {
  it('stops following on the first manual scroll up and remembers the count at that moment', () => {
    const stopped = followReducer(initialFollow, { type: 'scroll', distance: 400, count: 7 });
    expect(stopped).toEqual({ following: false, baseline: 7 });
    expect(unseenCount(stopped, 10)).toBe(3);
    // further scrolling keeps the first baseline
    expect(followReducer(stopped, { type: 'scroll', distance: 900, count: 9 })).toBe(stopped);
  });

  it('holds follow within 80px of the bottom', () => {
    expect(followReducer(initialFollow, { type: 'scroll', distance: 80, count: 3 })).toBe(initialFollow);
    const stopped = followReducer(initialFollow, { type: 'scroll', distance: 81, count: 3 });
    expect(stopped.following).toBe(false);
    expect(followReducer(stopped, { type: 'scroll', distance: 12, count: 5 })).toEqual(initialFollow);
  });

  it('never lets a timer re-enable follow', () => {
    const stopped = followReducer(initialFollow, { type: 'scroll', distance: 300, count: 2 });
    const later = followReducer(stopped, { type: 'timer' });
    expect(later.following).toBe(false);
    expect(later).toBe(stopped);
  });

  it('re-enables follow on the pill jump', () => {
    const stopped = followReducer(initialFollow, { type: 'scroll', distance: 300, count: 2 });
    expect(followReducer(stopped, { type: 'jump' })).toEqual(initialFollow);
    expect(unseenCount(initialFollow, 99)).toBe(0);
  });
});
