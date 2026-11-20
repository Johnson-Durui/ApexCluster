// FLIP between the docked map and the full 架构视图 (BUILD-SPEC-B §7 row 17). Cards translate only: each snaps to its
// target size at frame 0 and slides from its painted centre to its new one; text never scales. The canvas is hidden
// while cards move and fades in after they land. Reduced motion (animateOnce returns null) is an instant cut.
import { animateOnce } from '../../components/motion';

export type Rects = Map<string, DOMRect>;

export const FLIP_MS = 400;
export const CANVAS_FADE_MS = 240;
const EASE_MORPH = 'cubic-bezier(.33,0,.2,1)';

function movers(scope: Element | null): HTMLElement[] {
  return scope ? [...scope.querySelectorAll<HTMLElement>('.obs-world [data-flip], .obs-world [data-seat]')] : [];
}
const keyOf = (element: HTMLElement) => element.dataset.flip ?? element.dataset.seat ?? '';

/** Painted rects (running animations included), so a toggle in mid-move retargets from where the cards are seen. */
export function readRects(scope: Element | null): Rects {
  const rects: Rects = new Map();
  for (const element of movers(scope)) {
    const key = keyOf(element);
    if (key && !rects.has(key)) rects.set(key, element.getBoundingClientRect());
  }
  return rects;
}

const usable = (rect: DOMRect | undefined): rect is DOMRect => Boolean(rect && rect.width > 0 && rect.height > 0);

/**
 * At most one pending FLIP settle. Re-arming (a toggle in mid-move) or cancelling (unmount) drops the earlier callback,
 * so an old timer never ends a later FLIP early and lifts the preset / ResizeObserver guards while cards still move.
 */
export function settleTimer() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    cancel,
    /** Runs `done` after `ms` (at once when 0), replacing any settle still pending. */
    arm(ms: number, done: () => void) {
      cancel();
      if (ms <= 0) { done(); return; }
      timer = setTimeout(() => { timer = undefined; done(); }, ms);
    },
    pending: () => timer !== undefined,
  };
}

/**
 * Plays the move from `first` to the current layout. Returns the time until everything has settled (0 when nothing
 * moved or motion is reduced). Elements without a usable first or last rect simply cut.
 */
export function playFlip(scope: Element | null, first: Rects): number {
  const elements = movers(scope);
  elements.forEach(element => element.getAnimations().forEach(animation => animation.cancel()));
  let moved = 0;
  for (const element of elements) {
    const from = first.get(keyOf(element));
    const to = element.getBoundingClientRect();
    if (!usable(from) || !usable(to)) continue;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
    if (animateOnce(element, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: FLIP_MS, easing: EASE_MORPH })) moved++;
  }
  if (!moved) return 0;
  const canvas = scope?.querySelector('.observatory-canvas');
  const total = FLIP_MS + CANVAS_FADE_MS;
  animateOnce(canvas, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: FLIP_MS / total }, { opacity: 1, offset: 1 }], { duration: total, easing: 'linear' });
  return total;
}
