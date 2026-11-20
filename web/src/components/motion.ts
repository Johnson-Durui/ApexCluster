// Motion foundation (BUILD-SPEC-B §2, §3.6, §7). One source for reduced motion, one rAF owner for number tweens,
// a clock-pause signal (Modal open, page hidden) and the shell "recede" while a Modal is open. Nothing here runs at idle.
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'dmw:motion';
const QUERY = '(prefers-reduced-motion: reduce)';

type Listener = () => void;
const reduceListeners = new Set<Listener>();
const pauseListeners = new Set<Listener>();
let reduced = false;
let booted = false;

/** The QA switch. A throwing or missing localStorage means "not set". */
export function storedMotionPreference(storage: Pick<Storage, 'getItem'> | undefined | null = typeof localStorage === 'undefined' ? undefined : localStorage): 'reduce' | null {
  try { return storage?.getItem(STORAGE_KEY) === 'reduce' ? 'reduce' : null; }
  catch { return null; }
}

/** Pure: whether motion is reduced, given the media query result and the stored QA switch. */
export function resolveReducedMotion(mediaMatches: boolean, stored: 'reduce' | null): boolean {
  return mediaMatches || stored === 'reduce';
}

function apply(next: boolean) {
  if (next === reduced && booted) return;
  reduced = next;
  if (typeof document !== 'undefined') {
    if (next) document.documentElement.dataset.motion = 'reduce';
    else delete document.documentElement.dataset.motion;
  }
  reduceListeners.forEach(listener => listener());
}

/** Called once at boot (main.tsx). Sets <html data-motion="reduce"> and follows the media query live. */
export function initMotion() {
  if (booted || typeof window === 'undefined') return;
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
  const evaluate = () => apply(resolveReducedMotion(!!media?.matches, storedMotionPreference()));
  evaluate();
  booted = true;
  media?.addEventListener?.('change', evaluate);
  window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) evaluate(); });
  document.addEventListener('visibilitychange', () => pauseListeners.forEach(listener => listener()));
}

/** True when motion is reduced. Components never read the media query directly. */
export function reducedMotion(): boolean {
  if (!booted && typeof document !== 'undefined') return document.documentElement.dataset.motion === 'reduce';
  return reduced;
}

const subscribeReduce = (listener: Listener) => { reduceListeners.add(listener); return () => { reduceListeners.delete(listener); }; };
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, reducedMotion, () => false);
}

// ---------- clock pause: Modal open or the page hidden ----------
let holds = 0;

/** True while the map clock and tweens must stand still (a Modal is open, or the document is hidden). */
export function clockPaused(): boolean {
  return holds > 0 || (typeof document !== 'undefined' && document.hidden);
}

export function subscribeClockPause(listener: Listener): () => void {
  pauseListeners.add(listener);
  return () => { pauseListeners.delete(listener); };
}

export function useClockPaused(): boolean {
  return useSyncExternalStore(subscribeClockPause, clockPaused, () => false);
}

/** Holds the clock (and recedes the shell) until the returned release is called. Used by Modal. */
export function holdClock(): () => void {
  holds += 1;
  if (holds === 1) setReceded(true);
  pauseListeners.forEach(listener => listener());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) setReceded(false);
    pauseListeners.forEach(listener => listener());
  };
}

let recedeTimer: number | undefined;
/** `.app[data-receded]` scales the sidebar and main column; will-change lives only for the 280/220ms transition. */
function setReceded(on: boolean) {
  if (typeof document === 'undefined') return;
  const app = document.querySelector<HTMLElement>('.app');
  if (!app) return;
  if (on) app.dataset.receded = ''; else delete app.dataset.receded;
  if (reducedMotion()) { delete app.dataset.recedeAnim; return; }
  app.dataset.recedeAnim = '';
  if (recedeTimer !== undefined) window.clearTimeout(recedeTimer);
  recedeTimer = window.setTimeout(() => { delete app.dataset.recedeAnim; recedeTimer = undefined; }, on ? 280 : 220);
}

// ---------- number tweens: one rAF owner, stops at rest ----------
export type Easing = (progress: number) => number;
export const easeOut: Easing = p => 1 - Math.pow(1 - p, 4);
export const easeSettle: Easing = p => 1 - Math.pow(1 - p, 3);
export const easeInOut: Easing = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

interface Tween { from: number; to: number; duration: number; ease: Easing; elapsed: number; last: number; onUpdate(value: number): void; onDone?(): void }
const tweens = new Set<Tween>();
let frame = 0;

function tick(now: number) {
  frame = 0;
  if (clockPaused()) { tweens.forEach(tween => { tween.last = now; }); schedulePaused(); return; }
  for (const tween of [...tweens]) {
    tween.elapsed += Math.max(0, now - tween.last);
    tween.last = now;
    const progress = Math.min(1, tween.elapsed / tween.duration);
    tween.onUpdate(tween.from + (tween.to - tween.from) * tween.ease(progress));
    if (progress >= 1) { tweens.delete(tween); tween.onDone?.(); }
  }
  if (tweens.size) frame = window.requestAnimationFrame(tick);
}

let pauseUnsubscribe: (() => void) | null = null;
/** While paused, no rAF runs; the tweens resume from where they stood when the pause ends. */
function schedulePaused() {
  if (pauseUnsubscribe) return;
  pauseUnsubscribe = subscribeClockPause(() => {
    if (clockPaused() || !tweens.size) return;
    pauseUnsubscribe?.(); pauseUnsubscribe = null;
    const now = performance.now();
    tweens.forEach(tween => { tween.last = now; });
    if (!frame) frame = window.requestAnimationFrame(tick);
  });
}

/**
 * Tweens a number from `from` to `to` (count-ups, bar widths). Under reduced motion it jumps to the final value.
 * Returns a cancel function. Zero rAF once every tween has settled.
 */
export function tweenNumber({ from, to, duration = 800, ease = easeOut, onUpdate, onDone }: { from: number; to: number; duration?: number; ease?: Easing; onUpdate(value: number): void; onDone?(): void }): () => void {
  if (from === to || duration <= 0 || reducedMotion() || typeof window === 'undefined') { onUpdate(to); onDone?.(); return () => undefined; }
  const tween: Tween = { from, to, duration, ease, elapsed: 0, last: performance.now(), onUpdate, onDone };
  tweens.add(tween);
  if (!frame && !clockPaused()) frame = window.requestAnimationFrame(tick);
  else if (clockPaused()) schedulePaused();
  return () => { tweens.delete(tween); if (!tweens.size && frame) { window.cancelAnimationFrame(frame); frame = 0; } };
}

/**
 * Plays a one-shot WAAPI animation whose end state already matches the element's CSS. No forwards fill is kept:
 * the animation is cancelled once it finishes, so nothing stays "running" or holds a style. Returns null when motion is reduced.
 */
export function animateOnce(element: Element | null | undefined, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: KeyframeAnimationOptions = {}): Animation | null {
  if (!element || reducedMotion() || typeof element.animate !== 'function') return null;
  const animation = element.animate(keyframes, { duration: 240, easing: 'cubic-bezier(.16,1,.3,1)', ...options, fill: options.fill === 'forwards' || options.fill === 'both' ? 'backwards' : options.fill ?? 'backwards' });
  animation.finished.then(() => animation.cancel(), () => undefined);
  return animation;
}
