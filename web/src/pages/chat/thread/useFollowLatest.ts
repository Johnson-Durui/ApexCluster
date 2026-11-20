// Follow-latest (BUILD-SPEC-B §4.3.9): one owner for "stick to the bottom". Following holds within 80px of the bottom;
// the first manual scroll up stops it. Only the user re-enables it (scrolling back down, or the pill). A timer never does.
import { useCallback, useLayoutEffect, useReducer, useRef, type RefObject } from 'react';

export const FOLLOW_SLACK = 80;

export interface FollowState {
  following: boolean;
  /** Content count when follow stopped; the pill shows count − baseline. */
  baseline: number | null;
}

export type FollowAction =
  | { type: 'scroll'; distance: number; count: number }
  | { type: 'jump' }
  | { type: 'timer' };

export const initialFollow: FollowState = { following: true, baseline: null };

export function followReducer(state: FollowState, action: FollowAction): FollowState {
  if (action.type === 'jump') return state.following && state.baseline === null ? state : initialFollow;
  if (action.type === 'scroll') {
    if (action.distance <= FOLLOW_SLACK) return state.following && state.baseline === null ? state : initialFollow;
    return state.following ? { following: false, baseline: action.count } : state;
  }
  // A timer (or anything that is not the user) never re-enables follow.
  return state;
}

/** New items since follow stopped; null when not computable. */
export function unseenCount(state: FollowState, count: number): number | null {
  if (state.following) return 0;
  if (state.baseline === null) return null;
  return Math.max(0, count - state.baseline);
}

/**
 * `count` = article.chat-message + activity rows (the unread measure); `contentKey` changes whenever anything visible
 * in the log changed. While following, the log is pinned to the bottom after every commit that changes either.
 */
export function useFollowLatest(log: RefObject<HTMLElement | null>, count: number, contentKey: string) {
  const [state, dispatch] = useReducer(followReducer, initialFollow);
  const countRef = useRef(count);
  countRef.current = count;
  const preserve = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = log.current;
    if (!element) return;
    if (preserve.current !== null) {
      element.scrollTop += element.scrollHeight - preserve.current;
      preserve.current = null;
      return;
    }
    if (state.following) element.scrollTop = element.scrollHeight;
  }, [count, contentKey, state.following, log]);

  const onScroll = useCallback(() => {
    const element = log.current;
    if (!element) return;
    dispatch({ type: 'scroll', distance: element.scrollHeight - element.scrollTop - element.clientHeight, count: countRef.current });
  }, [log]);

  /** Jumps instantly, outlines the last row for 600ms and re-enables follow. */
  const jump = useCallback(() => {
    const element = log.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      const rows = element.querySelectorAll<HTMLElement>('.conversation-column > *');
      const last = rows[rows.length - 1];
      if (last) {
        last.dataset.flash = '';
        window.setTimeout(() => { delete last.dataset.flash; }, 600);
      }
    }
    dispatch({ type: 'jump' });
  }, [log]);

  /** Call before prepending older messages so the reading position is kept. */
  const keepPosition = useCallback(() => { preserve.current = log.current?.scrollHeight ?? null; }, [log]);

  return { following: state.following, unseen: unseenCount(state, count), onScroll, jump, keepPosition };
}
