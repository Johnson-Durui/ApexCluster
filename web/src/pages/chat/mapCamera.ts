// Camera presets for the full 架构视图 (BUILD-SPEC-B §5.2, §7 row 25). Pure geometry: a camera maps world (global
// layout) pixels to stage pixels as screen = world·s + t. Cards are never scaled once a move settles: the scene is
// re-laid out at the target camera, and the CSS transform only bridges the 420 ms between the two layouts.
import type { Box } from './observatoryLayout';
import type { Size } from './observatoryTheme';

export type CameraPreset = 'global' | 'lead' | 'waiting';
export interface Camera { s: number; tx: number; ty: number }

export const IDENTITY: Camera = Object.freeze({ s: 1, tx: 0, ty: 0 }) as Camera;
export const MAX_ZOOM = 1.1;
/** The smallest card text (12 px, the tiny-density name). A preset that would draw it smaller is disabled. */
export const MIN_TEXT_PX = 12;

export const PRESETS: Array<{ id: CameraPreset; label: string }> = [
  { id: 'global', label: '全局' },
  { id: 'lead', label: '主控' },
  { id: 'waiting', label: '等待项' },
];

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Centres `target` at `zoom` (≤ 1.1) and keeps the world covering the whole stage, so no empty band opens. */
export function cameraFor(target: { x: number; y: number } | null, size: Size, zoom = MAX_ZOOM): Camera {
  const s = clamp(zoom, 1, MAX_ZOOM);
  if (!target || s === 1 || size.w < 1 || size.h < 1) return IDENTITY;
  return {
    s,
    tx: clamp(size.w / 2 - target.x * s, size.w - size.w * s, 0),
    ty: clamp(size.h / 2 - target.y * s, size.h - size.h * s, 0),
  };
}

export function sameCamera(a: Camera, b: Camera) {
  return Math.abs(a.s - b.s) < 1e-4 && Math.abs(a.tx - b.tx) < 0.5 && Math.abs(a.ty - b.ty) < 0.5;
}

/** A world box as the camera shows it: the centre moves, the size stays (text never scales at rest). */
export function viewBox(box: Box, camera: Camera): Box {
  return camera === IDENTITY ? box : { ...box, cx: box.cx * camera.s + camera.tx, cy: box.cy * camera.s + camera.ty };
}

export type CameraStep = { kind: 'hold' } | { kind: 'snap' } | { kind: 'tween'; commit: boolean };

/**
 * What the stage does when the camera target may have moved (§5.2, §7 row 25). `inFlight` is the destination of the
 * running tween (null when none). A model update that leaves that destination in place keeps the tween; a moved
 * destination (or a reversal to the committed camera) retargets from the painted matrix; with nothing in flight a pure
 * re-layout snaps. `commit: false` means the tween returns to the committed camera, so there is nothing to commit.
 */
export function cameraStep(target: Camera, committed: Camera, inFlight: Camera | null, presetChanged: boolean, canAnimate: boolean): CameraStep {
  if (sameCamera(target, inFlight ?? committed)) return { kind: 'hold' };
  if (!canAnimate || (!inFlight && !presetChanged)) return { kind: 'snap' };
  return { kind: 'tween', commit: !sameCamera(target, committed) };
}

/** Whether a preset keeps every card text at or above 12 px. */
export function presetAllowed(zoom: number) {
  return MIN_TEXT_PX * zoom >= MIN_TEXT_PX - 1e-6;
}

/** The CSS matrix that carries the committed camera `from` to `to` (the bridge between the two layouts). */
export function bridge(from: Camera, to: Camera): string {
  const k = to.s / from.s;
  return 'matrix(' + [k, 0, 0, k, to.tx - from.tx * k, to.ty - from.ty * k].map(value => +value.toFixed(4)).join(',') + ')';
}

/** Target point of a preset over the world boxes: the lead card, or the centroid of the seats that wait. */
export function presetTarget(preset: CameraPreset, boxes: Box[], lead: string | undefined, waiting: string[]): { x: number; y: number } | null {
  if (preset === 'global') return null;
  const picked = preset === 'lead' ? boxes.filter(box => box.id === lead) : boxes.filter(box => waiting.includes(box.id));
  if (!picked.length) return null;
  return { x: picked.reduce((sum, box) => sum + box.cx, 0) / picked.length, y: picked.reduce((sum, box) => sum + box.cy, 0) / picked.length };
}
