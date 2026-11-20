// Pure geometry for the architecture view. Everything is in real stage pixels; nothing touches the DOM.
import type { Density, Size } from './observatoryTheme';

export type Point = [x: number, y: number];
export type Curve = [start: Point, first: Point, second: Point, end: Point];
export interface Box { id: string; cx: number; cy: number; w: number; h: number }
export interface Row { ids: string[]; xs: number[]; ys: number[] }
export interface Route {
  /** Index into the links array this route was built from. */
  link: number;
  from: number;
  to: number;
  curve: Curve;
  /** Where the fibre meets the source / target card edge (the port sits a few px outside). */
  sourceEdge: Point;
  targetEdge: Point;
  len: number;
  table: Float32Array;
}

const ARC_SAMPLES = 48;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function bezier([a, b, c, d]: Curve, t: number): Point {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [a[0] * w0 + b[0] * w1 + c[0] * w2 + d[0] * w3, a[1] * w0 + b[1] * w1 + c[1] * w2 + d[1] * w3];
}

/** Unit normal (left of travel) at t. */
export function normal([a, b, c, d]: Curve, t: number): Point {
  const u = 1 - t;
  const dx = 3 * (u * u * (b[0] - a[0]) + 2 * u * t * (c[0] - b[0]) + t * t * (d[0] - c[0]));
  const dy = 3 * (u * u * (b[1] - a[1]) + 2 * u * t * (c[1] - b[1]) + t * t * (d[1] - c[1]));
  const length = Math.hypot(dx, dy) || 1;
  return [-dy / length, dx / length];
}

/** Cumulative arc length at ARC_SAMPLES + 1 evenly spaced t values. */
export function arcTable(curve: Curve) {
  const table = new Float32Array(ARC_SAMPLES + 1);
  let previous = curve[0];
  for (let index = 1; index <= ARC_SAMPLES; index++) {
    const point = bezier(curve, index / ARC_SAMPLES);
    table[index] = table[index - 1] + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return { table, len: table[ARC_SAMPLES] };
}

/** t at a given distance along the curve (binary search in the arc table). */
export function tAtDistance(table: Float32Array, distance: number) {
  const total = table[table.length - 1];
  const target = clamp(distance, 0, total);
  let low = 0;
  let high = table.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (table[middle] < target) low = middle;
    else high = middle;
  }
  const span = table[high] - table[low] || 1;
  return (low + (target - table[low]) / span) / (table.length - 1);
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const side = (p: Point, q: Point, r: Point) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** Number of proper crossings between straight links (links sharing a node never count). */
export function countCrossings(position: Map<string, Point>, links: Array<[string, string]>) {
  const placed = links.filter(([a, b]) => position.has(a) && position.has(b));
  let crossings = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const [a, b] = placed[i];
      const [c, d] = placed[j];
      if (a === c || a === d || b === c || b === d) continue;
      if (segmentsCross(position.get(a)!, position.get(b)!, position.get(c)!, position.get(d)!)) crossings++;
    }
  }
  return crossings;
}

function positions(root: { id: string; x: number; y: number } | undefined, rows: Row[]) {
  const map = new Map<string, Point>();
  if (root) map.set(root.id, [root.x, root.y]);
  for (const row of rows) row.ids.forEach((id, slot) => map.set(id, [row.xs[slot], row.ys[slot]]));
  return map;
}

function reorder(row: Row, reference: Map<string, Point>, neighbours: Map<string, Set<string>>): Row {
  const ranked = row.ids.flatMap((id, slot) => {
    const xs = [...(neighbours.get(id) ?? [])].flatMap(other => reference.has(other) ? [reference.get(other)![0]] : []);
    return xs.length ? [{ id, slot, center: xs.reduce((sum, x) => sum + x, 0) / xs.length }] : [];
  });
  const slots = ranked.map(item => item.slot);
  const sorted = [...ranked].sort((a, b) => a.center - b.center || a.slot - b.slot);
  const ids = row.ids.slice();
  slots.forEach((slot, index) => { ids[slot] = sorted[index].id; });
  return { ...row, ids };
}

/**
 * Barycentre ordering of the two seat rows under the root, to cut fibre crossings.
 * Slots (x, y) stay where they are; only which seat sits in which slot changes. Never makes crossings worse.
 */
export function orderByBarycenter(root: { id: string; x: number; y: number } | undefined, upper: Row, lower: Row, links: Array<[string, string]>) {
  const neighbours = new Map<string, Set<string>>();
  for (const [a, b] of links) {
    if (a === b) continue;
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }
  const without = (map: Map<string, Point>, row: Row) => new Map([...map].filter(([id]) => !row.ids.includes(id)));
  let nextLower = reorder(lower, without(positions(root, [upper]), lower), neighbours);
  const nextUpper = reorder(upper, positions(undefined, [nextLower]), neighbours);
  nextLower = reorder(nextLower, positions(root, [nextUpper]), neighbours);
  const before = countCrossings(positions(root, [upper, lower]), links);
  const after = countCrossings(positions(root, [nextUpper, nextLower]), links);
  return after <= before ? { upper: nextUpper.ids, lower: nextLower.ids } : { upper: upper.ids, lower: lower.ids };
}

function stageBounds(size: Size, card: Size, density: Density) {
  const tiny = density === 'tiny';
  const padX = Math.max(14, 0.015 * size.w) + card.w / 2;
  const top = (tiny ? 12 : 58) + card.h / 2;
  const bottom = Math.max(top, size.h - (tiny ? 12 : 54) - card.h / 2);
  return { left: Math.min(padX, size.w / 2), right: Math.max(size.w - padX, size.w / 2), top, bottom };
}

/** Push overlapping boxes apart along the axis of least overlap, clamped to the bounds. */
export function relax(boxes: Box[], bounds: { left: number; right: number; top: number; bottom: number }, margin = 8, rounds = 24) {
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const overlapX = (a.w + b.w) / 2 + margin - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 + margin - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        const horizontal = overlapX / (a.w + b.w) < overlapY / (a.h + b.h);
        const sign = (horizontal ? dx : dy) >= 0 ? 1 : -1;
        const push = (horizontal ? overlapX : overlapY) / 2 + 0.5;
        if (horizontal) { a.cx -= sign * push; b.cx += sign * push; } else { a.cy -= sign * push; b.cy += sign * push; }
      }
    }
    for (const box of boxes) {
      box.cx = clamp(box.cx, bounds.left, bounds.right);
      box.cy = clamp(box.cy, bounds.top, bounds.bottom);
    }
    if (!moved) break;
  }
  return boxes;
}

/**
 * Map the % slots of the topology to stage pixels and keep every card separate and inside the stage.
 * `widths` widens single cards (the lead carries its sub-task counter).
 */
export function placeTopologyCards(nodes: Array<{ id: string; x: number; y: number }>, size: Size, density: Density, card: Size, widths?: Map<string, number>): Box[] {
  const bounds = stageBounds(size, card, density);
  const ys = nodes.map(node => node.y);
  const low = Math.min(...ys);
  const range = Math.max(...ys) - low;
  const boxes: Box[] = nodes.map(node => ({
    id: node.id, w: widths?.get(node.id) ?? card.w, h: card.h,
    cx: bounds.left + (bounds.right - bounds.left) * (clamp(node.x, 10, 90) - 10) / 80,
    cy: range < 1 ? (bounds.top + bounds.bottom) / 2 : bounds.top + (bounds.bottom - bounds.top) * (node.y - low) / range,
  }));
  const ordered = [...boxes].sort((a, b) => a.cy - b.cy);
  const bands: Box[][] = [];
  for (const box of ordered) {
    const band = bands.at(-1);
    if (band && box.cy - band.at(-1)!.cy <= card.h) band.push(box);
    else bands.push([box]);
  }
  for (const band of bands) {
    band.sort((a, b) => a.cx - b.cx);
    const need = (band.length - 1) * (card.w + 10);
    const rows = Math.min(3, Math.max(1, Math.ceil(need / Math.max(1, bounds.right - bounds.left))));
    if (rows < 2) continue;
    // Split a crowded band into sub-rows around one shared baseline (the row stagger would otherwise cancel the split).
    const base = band.reduce((sum, box) => sum + box.cy, 0) / band.length;
    band.forEach((box, index) => { box.cy = base + (index % rows - (rows - 1) / 2) * (card.h + 10); });
  }
  // Stack the bands inside the stage: push down past the previous band, then up from the bottom edge.
  const shift = (band: Box[], delta: number) => band.forEach(box => { box.cy += delta; });
  const top = (band: Box[]) => Math.min(...band.map(box => box.cy));
  const end = (band: Box[]) => Math.max(...band.map(box => box.cy));
  let floor = bounds.top;
  for (const band of bands) {
    shift(band, Math.max(0, floor - top(band)));
    floor = end(band) + card.h + 10;
  }
  let ceiling = bounds.bottom;
  for (const band of [...bands].reverse()) {
    shift(band, Math.min(0, ceiling - end(band)));
    ceiling = top(band) - card.h - 10;
  }
  return relax(boxes, bounds);
}

type Side = 'top' | 'bottom';
const spread = (count: number, cardWidth: number, density: Density) =>
  count <= 1 ? 0 : density === 'tiny' ? Math.min(12, 48 / (count - 1)) : Math.min(22, (cardWidth - 28) / (count - 1));

/** One curve per link: leaves the parent's bottom edge and enters the child's top edge (or bottom→bottom within a band). */
export function buildRoutes(boxes: Box[], links: Array<{ from: number; to: number }>, density: Density): Route[] {
  const gap = density === 'tiny' ? 5 : 8;
  const ports = new Map<string, Array<{ link: number; end: 'source' | 'target'; otherX: number }>>();
  const plan = links.map(({ from, to }, link) => {
    const source = boxes[from];
    const target = boxes[to];
    if (!source || !target || from === to) return null;
    const sameBand = Math.abs(target.cy - source.cy) < Math.max(source.h, target.h) + 6;
    const down = target.cy >= source.cy;
    const sourceSide: Side = sameBand || down ? 'bottom' : 'top';
    const targetSide: Side = sameBand ? 'bottom' : down ? 'top' : 'bottom';
    for (const [box, side, end, other] of [[from, sourceSide, 'source', target], [to, targetSide, 'target', source]] as const) {
      const key = box + ':' + side;
      if (!ports.has(key)) ports.set(key, []);
      ports.get(key)!.push({ link, end, otherX: other.cx });
    }
    return { from, to, sourceSide, targetSide, sameBand };
  });
  const offsets = new Map<string, number>();
  for (const [key, list] of ports) {
    const box = boxes[Number(key.split(':')[0])];
    list.sort((a, b) => a.otherX - b.otherX || a.link - b.link);
    const step = spread(list.length, box.w, density);
    list.forEach((port, index) => offsets.set(port.link + ':' + port.end, (index - (list.length - 1) / 2) * step));
  }
  return plan.flatMap((item, link) => {
    if (!item) return [];
    const source = boxes[item.from];
    const target = boxes[item.to];
    const edge = (box: Box, side: Side, end: 'source' | 'target'): Point =>
      [box.cx + (offsets.get(link + ':' + end) ?? 0), side === 'top' ? box.cy - box.h / 2 : box.cy + box.h / 2];
    const sourceEdge = edge(source, item.sourceSide, 'source');
    const targetEdge = edge(target, item.targetSide, 'target');
    const sourceDir = item.sourceSide === 'top' ? -1 : 1;
    const targetDir = item.targetSide === 'top' ? -1 : 1;
    const start: Point = [sourceEdge[0], sourceEdge[1] + sourceDir * gap];
    const end: Point = [targetEdge[0], targetEdge[1] + targetDir * gap];
    const reach = item.sameBand ? clamp(0.35 * Math.abs(end[0] - start[0]), 48, 120) : clamp(Math.abs(end[1] - start[1]) * 0.5, 40, 170);
    const curve: Curve = [start, [start[0], start[1] + sourceDir * reach], [end[0], end[1] + targetDir * reach], end];
    return [{ link, from: item.from, to: item.to, curve, sourceEdge, targetEdge, ...arcTable(curve) }];
  });
}

export interface PipelineGeometry {
  vertical: boolean;
  stations: Point[];
  radius: number;
  cardW: number;
  cardH: number;
  cardTop: number;
}

export function pipelineGeometry(count: number, size: Size, density: Density): PipelineGeometry {
  if (density === 'tiny') {
    const step = count > 1 ? (size.h - 48) / (count - 1) : 0;
    const stations = Array.from({ length: count }, (_, index): Point => [26, 24 + index * step]);
    return { vertical: true, stations, radius: 10, cardW: Math.max(0, size.w - 56), cardH: 40, cardTop: 0 };
  }
  const compact = density === 'compact';
  const radius = compact ? 12 : 14;
  const bandBottom = 54 + (compact ? 56 : 64) + 8;
  const stripTop = size.h - 56 - (compact ? 52 : 58) - 8;
  const avail = Math.max(0, stripTop - bandBottom);
  // Cards absorb spare height so neither blank band above or below the group grows past ~100 px.
  const cardH = clamp(avail - 2 * radius - 36, 120, Math.min(360, Math.max(280, avail - 2 * radius - 18 - 200)));
  const group = 2 * radius + 18 + cardH;
  const groupTop = bandBottom + Math.max(0, (avail - group) / 2);
  const trackY = groupTop + radius;
  // Columns fill the stage inside the same 12 px inset as the band and strip, so the outer cards never touch the frame.
  const inset = 12;
  const column = (size.w - 2 * inset + 12) / Math.max(1, count);
  const stations = Array.from({ length: count }, (_, index): Point => [size.w / 2 + (index - (count - 1) / 2) * column, trackY]);
  return { vertical: false, stations, radius, cardW: Math.max(0, Math.min(224, column - 12)), cardH, cardTop: trackY + radius + 18 };
}

export interface ContextGeometry { center: Point; rx: number; ry: number; radius: number; boxes: Box[] }

const ORBIT_ANGLES = [-90, -30, 30, 90, 150, 210].map(degrees => degrees * Math.PI / 180);
const ORBIT_ANGLES_SIDEWAYS = [-60, 0, 60, 120, 180, 240].map(degrees => degrees * Math.PI / 180);
const MIN_FIBRE = 24;

export function contextGeometry(ids: string[], size: Size, density: Density, card: Size): ContextGeometry {
  const tiny = density === 'tiny';
  const top = tiny ? 12 : 58;
  const bottom = size.h - (tiny ? 12 : 54);
  const center: Point = [size.w / 2, (top + bottom) / 2];
  const rx = Math.max(0, size.w / 2 - 16 - card.w / 2);
  const ry = Math.max(0, (bottom - top) / 2 - card.h / 2);
  // Room left between the core and the cards straight above / below it; fibres need at least MIN_FIBRE px.
  const clear = ry - card.h / 2 - 14 - MIN_FIBRE;
  const radius = tiny ? 34 : clamp(Math.min(Math.min(rx, ry) * 0.32, clear), 26, 78);
  const angles = !tiny && clear < 26 ? ORBIT_ANGLES_SIDEWAYS : ORBIT_ANGLES;
  const boxes = ids.slice(0, angles.length).map((id, index): Box => ({
    id, w: card.w, h: card.h,
    cx: center[0] + rx * Math.cos(angles[index]),
    cy: center[1] + ry * Math.sin(angles[index]),
  }));
  const bounds = { left: card.w / 2 + 8, right: size.w - card.w / 2 - 8, top: top + card.h / 2, bottom: bottom - card.h / 2 };
  return { center, rx, ry, radius, boxes: relax(boxes, bounds) };
}

/** Fibre from the card edge that faces the core to the core's rim, bowed sideways for a spiral-arm feel. */
export function contextRoute(box: Box, center: Point, radius: number): { curve: Curve; len: number; table: Float32Array } {
  const dx = center[0] - box.cx;
  const dy = center[1] - box.cy;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  const exit = Math.min(Math.abs(dx) > 0.01 ? box.w / 2 / Math.abs(ux) : Infinity, Math.abs(dy) > 0.01 ? box.h / 2 / Math.abs(uy) : Infinity) + 6;
  const start: Point = [box.cx + ux * exit, box.cy + uy * exit];
  const end: Point = [center[0] - ux * (radius + 8), center[1] - uy * (radius + 8)];
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const bow = 0.14 * length;
  const at = (fraction: number): Point => [start[0] + (end[0] - start[0]) * fraction - uy * bow, start[1] + (end[1] - start[1]) * fraction + ux * bow];
  const curve: Curve = [start, at(1 / 3), at(2 / 3), end];
  return { curve, ...arcTable(curve) };
}
