import { describe, expect, it } from 'vitest';
import { arcTable, bezier, buildRoutes, contextGeometry, countCrossings, orderByBarycenter, pipelineGeometry, placeTopologyCards, type Box, type Curve, type Point, type Row } from './observatoryLayout';
import { CARD, contrast, coreInk, densityFor, INK, SEAT_INKS, seatInk, STAGE_BOTTOM, CARD_FILL } from './observatoryTheme';

// Same slot rules as the view: root on top, then up to eleven seats in two staggered rows.
function slots(count: number) {
  const remaining = count - 1;
  const upperCount = remaining > 5 ? Math.min(5, Math.max(3, Math.ceil(remaining / 2))) : 0;
  const rowX = (index: number, total: number, margin: number) => total <= 1 ? 50 : margin + (100 - 2 * margin) * index / (total - 1);
  const nodes = [{ id: 'root', x: 50, y: 23 }];
  for (let index = 0; index < remaining; index++) {
    const upper = index < upperCount;
    const lower = index - upperCount;
    nodes.push(upper
      ? { id: 's' + index, x: rowX(index, upperCount, 19), y: 52 + (index + 1) % 2 * 4 }
      : { id: 's' + index, x: rowX(lower, remaining - upperCount, remaining <= 2 ? 24 : 10), y: upperCount ? 86 - lower % 2 * 4 : 77 - lower % 2 * 7 });
  }
  return nodes;
}

function overlaps(boxes: Box[]) {
  return boxes.some((a, i) => boxes.some((b, j) => j > i && Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2));
}

function inside(boxes: Box[], w: number, h: number) {
  return boxes.every(box => box.cx - box.w / 2 >= 0 && box.cx + box.w / 2 <= w && box.cy - box.h / 2 >= 0 && box.cy + box.h / 2 <= h);
}

describe('architecture view layout', () => {
  it.each([1, 2, 9, 12])('places %d topology cards without overlap and inside the stage at every density', count => {
    for (const w of [358, 640, 1000, 1500]) {
      for (const h of [460, 720]) {
        const density = densityFor(w);
        const boxes = placeTopologyCards(slots(count), { w, h }, density, CARD[density].topology);
        expect(overlaps(boxes), `${count} seats at ${w}×${h}`).toBe(false);
        expect(inside(boxes, w, h), `${count} seats at ${w}×${h}`).toBe(true);
      }
    }
  });

  it('routes parent → child from the bottom edge into the top edge, and within a band bottom → bottom', () => {
    const boxes: Box[] = [
      { id: 'root', cx: 500, cy: 80, w: 152, h: 68 },
      { id: 'low', cx: 300, cy: 400, w: 152, h: 68 },
      { id: 'side', cx: 700, cy: 90, w: 152, h: 68 },
      { id: 'up', cx: 300, cy: 40, w: 152, h: 68 },
    ];
    const [down, band] = buildRoutes(boxes, [{ from: 0, to: 1 }, { from: 0, to: 2 }], 'regular');
    expect(down.sourceEdge[1]).toBe(80 + 34);
    expect(down.targetEdge[1]).toBe(400 - 34);
    expect(down.curve[3][1]).toBeLessThan(down.targetEdge[1]);
    expect(band.sourceEdge[1]).toBe(80 + 34);
    expect(band.targetEdge[1]).toBe(90 + 34);
    const [upward] = buildRoutes(boxes, [{ from: 1, to: 3 }], 'regular');
    expect(upward.sourceEdge[1]).toBe(400 - 34);
    expect(upward.targetEdge[1]).toBe(40 + 34);
  });

  it('spreads ports on a shared edge in the order of the far ends', () => {
    const boxes: Box[] = [
      { id: 'root', cx: 500, cy: 80, w: 152, h: 68 },
      { id: 'right', cx: 900, cy: 400, w: 152, h: 68 },
      { id: 'left', cx: 100, cy: 400, w: 152, h: 68 },
    ];
    const [toRight, toLeft] = buildRoutes(boxes, [{ from: 0, to: 1 }, { from: 0, to: 2 }], 'regular');
    expect(toLeft.sourceEdge[0]).toBeLessThan(toRight.sourceEdge[0]);
    expect(Math.abs(toRight.sourceEdge[0] - toLeft.sourceEdge[0])).toBeLessThanOrEqual(22 + 1e-9);
  });

  it('never orders the rows into more crossings than it started with, and untangles a crossed pair', () => {
    const upper: Row = { ids: ['a', 'b'], xs: [30, 70], ys: [52, 56] };
    const lower: Row = { ids: ['c', 'd'], xs: [30, 70], ys: [86, 82] };
    const links: Array<[string, string]> = [['root', 'a'], ['root', 'b'], ['a', 'd'], ['b', 'c']];
    const position = (rows: { upper: string[]; lower: string[] }) => new Map<string, Point>([
      ['root', [50, 23]], ...rows.upper.map((id, i): [string, Point] => [id, [upper.xs[i], upper.ys[i]]]),
      ...rows.lower.map((id, i): [string, Point] => [id, [lower.xs[i], lower.ys[i]]]),
    ]);
    const before = countCrossings(position({ upper: upper.ids, lower: lower.ids }), links);
    const ordered = orderByBarycenter({ id: 'root', x: 50, y: 23 }, upper, lower, links);
    expect(before).toBe(1);
    expect(countCrossings(position(ordered), links)).toBe(0);
  });

  it('builds a monotonic arc-length table that matches a fine sampling within 1%', () => {
    const curve: Curve = [[0, 0], [0, 120], [300, 40], [300, 260]];
    const { table, len } = arcTable(curve);
    for (let index = 1; index < table.length; index++) expect(table[index]).toBeGreaterThan(table[index - 1]);
    let fine = 0;
    let previous = curve[0];
    for (let step = 1; step <= 4000; step++) {
      const point = bezier(curve, step / 4000);
      fine += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      previous = point;
    }
    expect(Math.abs(len - fine) / fine).toBeLessThan(0.01);
  });

  it('switches the pipeline to a vertical list on tiny stages and keeps stations inside wide stages', () => {
    expect(pipelineGeometry(6, { w: 358, h: 340 }, 'tiny').vertical).toBe(true);
    const wide = pipelineGeometry(6, { w: 1166, h: 751 }, 'regular');
    expect(wide.vertical).toBe(false);
    expect(wide.stations.every(([x]) => x > 0 && x < 1166)).toBe(true);
    expect(wide.cardTop + wide.cardH).toBeLessThan(751 - 56 - 58);
  });

  it('keeps pipeline cards inside the 12 px inset, clear of the strip, with no tall blank bands', () => {
    for (const w of [600, 949, 1166, 1405, 1600]) {
      const density = densityFor(w);
      const geometry = pipelineGeometry(6, { w, h: 640 }, density);
      expect(geometry.stations[0][0] - geometry.cardW / 2, String(w)).toBeGreaterThanOrEqual(12 - 1e-6);
      expect(geometry.stations[5][0] + geometry.cardW / 2, String(w)).toBeLessThanOrEqual(w - 12 + 1e-6);
    }
    for (const [h, density] of [[440, 'compact'], [460, 'regular']] as const) {
      const geometry = pipelineGeometry(6, { w: 1150, h }, density);
      expect(geometry.cardTop + geometry.cardH, String(h)).toBeLessThanOrEqual(h - 56 - (density === 'compact' ? 52 : 58));
    }
    const tall = pipelineGeometry(6, { w: 1500, h: 867 }, 'regular');
    const trackY = tall.stations[0][1];
    expect(trackY - tall.radius - (54 + 64 + 8)).toBeLessThanOrEqual(120);
    expect((867 - 56 - 58 - 8) - (tall.cardTop + tall.cardH)).toBeLessThanOrEqual(120);
  });

  it('leaves fibre room between the context core and the cards above and below it', () => {
    for (const h of [380, 430, 515, 700]) {
      const { center, radius, boxes } = contextGeometry(['root', 'a', 'b', 'c', 'd', 'e'], { w: 1100, h }, 'regular', CARD.regular.context);
      for (const box of boxes) {
        const gap = Math.hypot(box.cx - center[0], box.cy - center[1]) - radius - Math.min(box.w, box.h) / 2;
        expect(gap, h + ' ' + box.id).toBeGreaterThan(8);
      }
    }
  });

  it('keeps context cards apart on the orbit', () => {
    const ids = ['root', 'a', 'b', 'c', 'd', 'e'];
    for (const w of [358, 640, 1100]) {
      for (const h of [480, 700]) {
        const density = densityFor(w);
        const { boxes } = contextGeometry(ids, { w, h }, density, CARD[density].context);
        expect(overlaps(boxes), `${w}×${h}`).toBe(false);
        expect(inside(boxes, w, h), `${w}×${h}`).toBe(true);
      }
    }
  });
});

describe('architecture view palette', () => {
  it('keeps every seat ink readable on the stage and its fibre core readable on cards', () => {
    for (const [seat, ink] of Object.entries(SEAT_INKS)) {
      expect(contrast(ink, STAGE_BOTTOM), seat).toBeGreaterThanOrEqual(3.2);
      expect(contrast(coreInk(ink), CARD_FILL), seat).toBeGreaterThanOrEqual(4);
    }
  });

  it('gives unknown seats a stable ink that is never the gate colour', () => {
    expect(seatInk('very-long-seat-name-for-layout-check')).toBe(seatInk('very-long-seat-name-for-layout-check'));
    for (const id of ['x', 'y', 'reviewer-2', 'very-long-seat-name-for-layout-check']) {
      expect(seatInk(id)).not.toBe(INK.gate);
      expect(contrast(seatInk(id), STAGE_BOTTOM), id).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps text tokens at 4.5:1 or better on the stage', () => {
    for (const ink of [INK.ink, INK.ink2, INK.muted]) expect(contrast(ink, STAGE_BOTTOM)).toBeGreaterThanOrEqual(4.5);
  });
});
