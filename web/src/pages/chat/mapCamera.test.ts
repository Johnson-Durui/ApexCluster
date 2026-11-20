import { describe, expect, it } from 'vitest';
import { cameraStep, IDENTITY, type Camera } from './mapCamera';

// Committed camera = what the scene is laid out at; in flight = where the running 420 ms bridge is headed.
const lead: Camera = { s: 1.1, tx: -120, ty: -40 };
const waiting: Camera = { s: 1.1, tx: -300, ty: -80 };

describe('camera step (§5.2: reversing mid-move retargets from the painted matrix)', () => {
  it('keeps a running tween when a model update recomputes the same destination as a new object', () => {
    // 全局 → 主控 is in flight; task_updated rebuilds the model, so the target is a fresh but equal camera.
    expect(cameraStep({ ...lead }, IDENTITY, lead, false, true)).toEqual({ kind: 'hold' });
  });

  it('reverses to the committed preset by tweening back, with nothing to commit', () => {
    // 主控 then 全局 within 420 ms: the target equals the committed camera but the world is still moving.
    expect(cameraStep(IDENTITY, IDENTITY, lead, true, true)).toEqual({ kind: 'tween', commit: false });
  });

  it('retargets a running tween when the destination really moves, preset change or not', () => {
    expect(cameraStep({ ...lead, tx: -160 }, IDENTITY, lead, false, true)).toEqual({ kind: 'tween', commit: true });
    expect(cameraStep(waiting, IDENTITY, lead, true, true)).toEqual({ kind: 'tween', commit: true });
  });

  it('starts a tween on a preset change and does nothing when the camera is already there', () => {
    expect(cameraStep(lead, IDENTITY, null, true, true)).toEqual({ kind: 'tween', commit: true });
    expect(cameraStep({ ...lead }, lead, null, true, true)).toEqual({ kind: 'hold' });
  });

  it('snaps a pure re-layout with nothing in flight, and whenever it cannot animate', () => {
    expect(cameraStep(lead, { ...lead, tx: -100 }, null, false, true)).toEqual({ kind: 'snap' });
    // Reduced motion, a FLIP or the docked variant.
    expect(cameraStep(lead, IDENTITY, null, true, false)).toEqual({ kind: 'snap' });
    expect(cameraStep(IDENTITY, IDENTITY, lead, true, false)).toEqual({ kind: 'snap' });
  });
});
