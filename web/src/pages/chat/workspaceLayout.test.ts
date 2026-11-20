import { describe, expect, it } from 'vitest';
import { autoCollapse, defaultDockHeight, defaultThreadWidth, gridTemplate, inspectorPlacement, splitterRange, syncDockCollapse, threadBounds, threadWidth } from './workspaceLayout';

describe('workspace layout', () => {
  it('places the inspector as a column when maximised, collapsed or when the dock would be under 150px', () => {
    expect(inspectorPlacement({ maximised: true, collapsed: false, deckH: 1000, railH: 0 })).toBe('column');
    expect(inspectorPlacement({ maximised: false, collapsed: true, deckH: 1000, railH: 0 })).toBe('column');
    // 1000 − 40 − 68 − 330 = 562 ≥ 150 → dock
    expect(inspectorPlacement({ maximised: false, collapsed: false, deckH: 1000, railH: 68 })).toBe('dock');
    // 1280×720: deck ≈ 648 → 648 − 40 − 68 − 330 = 210 → dock; without the rail 278 → dock
    expect(inspectorPlacement({ maximised: false, collapsed: false, deckH: 648, railH: 68 })).toBe('dock');
    // 560 − 40 − 68 − 330 = 122 < 150 → column
    expect(inspectorPlacement({ maximised: false, collapsed: false, deckH: 560, railH: 68 })).toBe('column');
    // 519 − 40 − 330 = 149 < 150 → column; 520 leaves exactly 150 → dock
    expect(inspectorPlacement({ maximised: false, collapsed: false, deckH: 519, railH: 0 })).toBe('column');
    expect(inspectorPlacement({ maximised: false, collapsed: false, deckH: 520, railH: 0 })).toBe('dock');
  });

  it('defaults the dock to clamp(150, deckH − 40 − railH − 330, 320)', () => {
    expect(defaultDockHeight(1000, 0)).toBe(320);
    expect(defaultDockHeight(648, 68)).toBe(210);
    expect(defaultDockHeight(400, 0)).toBe(150);
  });

  it('defaults the thread to clamp(460px, 44%, 700px) at the agreed windows', () => {
    expect(defaultThreadWidth(1672)).toBe(700); // 1920 − 248 sidebar
    expect(defaultThreadWidth(1352)).toBe(595); // 1600
    expect(defaultThreadWidth(1192)).toBe(524); // 1440
    expect(defaultThreadWidth(1118)).toBe(492); // 1366
    expect(defaultThreadWidth(1216)).toBe(535); // 1280 with the 64px rail
  });

  it('clamps the thread to ≥400px, ≤62% and a ≥420px map', () => {
    const bounds = threadBounds(1216);
    expect(bounds.min).toBe(400);
    expect(bounds.max).toBe(Math.min(Math.floor(1216 * 0.62), 1216 - 7 - 420));
    expect(threadWidth(1216, 0.9)).toBe(bounds.max);
    expect(threadWidth(1216, 0.1)).toBe(400);
    expect(threadWidth(1216, null)).toBe(535);
    expect(threadWidth(1216, Number.NaN)).toBe(535);
    // a column inspector takes its width from the map, not from the thread minimum
    expect(threadBounds(1352, 340).max).toBe(Math.min(Math.floor(1352 * 0.62), 1352 - 340 - 7 - 420));
  });

  it('computes the splitter aria range from the px limits, so 30% is not offered at 1216px', () => {
    const bounds = threadBounds(1216);
    const range = splitterRange(1216, 535, bounds);
    expect(range.min).toBeCloseTo((400 / 1216) * 100);
    expect(range.min).toBeGreaterThan(30);
    expect(range.max).toBeCloseTo((bounds.max / 1216) * 100);
    expect(range.now).toBeGreaterThanOrEqual(range.min);
    expect(range.now).toBeLessThanOrEqual(range.max);
  });

  it('auto-collapses the map below 827px (plus a column inspector)', () => {
    expect(autoCollapse(826, 0)).toBe(true);
    expect(autoCollapse(827, 0)).toBe(false);
    expect(autoCollapse(1116, 316)).toBe(true);
    expect(autoCollapse(0, 0)).toBe(false);
  });

  it('expands a collapsed dock on an explicit open or an open-to-tab request, and keeps it collapsed otherwise', () => {
    const collapsed = { collapsed: true, open: true, reveal: 0 };
    // tab clicks and seat pins change neither input: the collapse stays
    expect(syncDockCollapse(collapsed, true, 0)).toBe(collapsed);
    // 查看交付物 / 在协作详情中查看 while the dock is open and collapsed
    expect(syncDockCollapse(collapsed, true, 1)).toEqual({ collapsed: false, open: true, reveal: 1 });
    // ✕ then 协作详情: closing keeps the flag, reopening shows the content
    const closed = syncDockCollapse(collapsed, false, 0);
    expect(closed.collapsed).toBe(true);
    expect(syncDockCollapse(closed, true, 0)).toEqual({ collapsed: false, open: true, reveal: 0 });
    // an open-to-tab request from a closed inspector opens it expanded
    expect(syncDockCollapse(closed, true, 1).collapsed).toBe(false);
  });

  it('builds the grid tracks; maximised with the inspector closed leaves a 0 track', () => {
    expect(gridTemplate({ maximised: true, collapsed: false, inspectorColumn: false })).toBe('var(--mini-rail-w) 0 minmax(0,1fr) 0');
    expect(gridTemplate({ maximised: true, collapsed: true, inspectorColumn: true })).toBe('var(--mini-rail-w) 0 minmax(0,1fr) clamp(320px,26%,400px)');
    expect(gridTemplate({ maximised: false, collapsed: true, inspectorColumn: true })).toBe('minmax(0,1fr) 0 0 var(--insp-w)');
    expect(gridTemplate({ maximised: false, collapsed: false, inspectorColumn: false })).toBe('var(--thread-w) var(--splitter-w) minmax(0,1fr) 0');
    expect(gridTemplate({ maximised: false, collapsed: false, inspectorColumn: true })).toBe('var(--thread-w) var(--splitter-w) minmax(0,1fr) var(--insp-w)');
  });
});
