// Seat focus as the map reads it (BUILD-SPEC-B §5.1, §5.3). components/seatFocus.tsx writes data-focus-seat /
// data-pinned on `.chat-work`; the map observes those two attributes instead of subscribing through React, so a hover
// repaints the canvas and flips card attributes without a React commit. Only a pin (a click) re-renders the stage.
import { useEffect, useState, type RefObject } from 'react';

export interface ObservedFocus { seat?: string; pinned: boolean }

function read(host: HTMLElement | null): ObservedFocus {
  const seat = host?.dataset.focusSeat || undefined;
  return { seat, pinned: Boolean(seat && host?.dataset.pinned === 'true') };
}

/** The focus state of the `.chat-work` around `from` (none outside a workspace). */
export function currentFocus(from: Element | null): ObservedFocus {
  return read(from?.closest<HTMLElement>('.chat-work') ?? null);
}

/** Calls `listener` now and whenever the focused or pinned seat of the enclosing `.chat-work` changes. */
export function observeSeatFocus(from: Element, listener: (state: ObservedFocus) => void): () => void {
  const host = from.closest<HTMLElement>('.chat-work');
  listener(read(host));
  if (!host || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(() => listener(read(host)));
  observer.observe(host, { attributes: true, attributeFilter: ['data-focus-seat', 'data-pinned'] });
  return () => observer.disconnect();
}

const cssString = (value: string) => '"' + value.replace(/["\\]/g, '\\$&') + '"';

/**
 * One dimming rule per seat of the current view (topology cards or context cards): everything in the map world not
 * related to the focused seat drops to .36 (§5.3). Pure CSS from the `.chat-work` attribute, so a hover renders nothing.
 */
export function dimRules(ids: string[]): string {
  if (!ids.length) return '';
  return ids.map(id => `.chat-work[data-focus-seat=${cssString(id)}] .obs-world [data-rel]:not([data-rel~=${cssString(id)}])`).join(',\n') + '{--o-dim:.36}';
}

/** Marks the pinned seat's map controls `aria-pressed`. React never renders this attribute, so it never fights it. */
export function markPressed(scope: Element | null, state: ObservedFocus) {
  scope?.querySelectorAll<HTMLElement>('button[data-seat]').forEach(button => {
    button.setAttribute('aria-pressed', String(state.pinned && button.dataset.seat === state.seat));
  });
}

/**
 * The pinned seat, for layouts that must keep it on screen (a 13th seat swaps into the topology, the context orbit).
 * Hover never changes it, so hovering re-renders nothing. Card `aria-pressed` follows on every focus change.
 */
export function usePinnedSeat(scope: RefObject<HTMLElement | null>): string | undefined {
  const [pinned, setPinned] = useState<string>();
  useEffect(() => {
    const element = scope.current;
    if (!element) return;
    return observeSeatFocus(element, state => {
      markPressed(element, state);
      setPinned(state.pinned ? state.seat : undefined);
    });
  }, [scope]);
  return pinned;
}
