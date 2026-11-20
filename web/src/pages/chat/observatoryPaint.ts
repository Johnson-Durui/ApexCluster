// Field, pipeline and context painters for the light architecture view (Canvas 2D, CSS px).
import { contextRoute, type ContextGeometry, type PipelineGeometry, type Point, type Route } from './observatoryLayout';
import { paintTopologyStatic, type BeadPlan, type TopologyLink } from './observatoryFlow';
import { INK, rgba, type Density, type Size } from './observatoryTheme';
import type { ObservatoryState } from './observatoryModel';

const tau = Math.PI * 2;

/**
 * The stage's mist and 24 px grid hairlines are static CSS on `.obs-stage` (BUILD-SPEC-B §5.2), so the canvas stays
 * transparent and the stage reads the same before the canvas paints. Only the context core keeps a soft white lift.
 */
export function paintField(ctx: CanvasRenderingContext2D, { w, h }: Size, _density: Density, core?: Point) {
  ctx.clearRect(0, 0, w, h);
  if (!core) return;
  const [x, y] = core;
  const lift = ctx.createRadialGradient(x, y, 0, x, y, 0.45 * Math.max(w, h));
  lift.addColorStop(0, 'rgba(255,255,255,.55)');
  lift.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = lift;
  ctx.fillRect(0, 0, w, h);
}

export interface PipelineStation { gate: boolean; state: ObservatoryState; userHold: boolean; selected: boolean }

function cursorOf(stations: PipelineStation[]) {
  return stations.findIndex(station => station.state === 'active' || station.state === 'hold' || station.state === 'error' || station.state === 'stopped');
}

function segment(ctx: CanvasRenderingContext2D, a: Point, b: Point, width: number, color: string, dash: number[]) {
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.lineTo(...b);
  ctx.stroke();
  ctx.setLineDash([]);
}

function bars(ctx: CanvasRenderingContext2D, [x, y]: Point, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x - 3.4, y - 4.5, 2.2, 9);
  ctx.fillRect(x + 1.2, y - 4.5, 2.2, 9);
}

function station(ctx: CanvasRenderingContext2D, point: Point, item: PipelineStation, radius: number) {
  const [x, y] = point;
  const shape = () => {
    ctx.beginPath();
    if (item.gate) {
      const half = radius * 1.28;
      ctx.moveTo(x, y - half); ctx.lineTo(x + half, y); ctx.lineTo(x, y + half); ctx.lineTo(x - half, y); ctx.closePath();
    } else ctx.arc(x, y, radius, 0, tau);
  };
  const userHold = item.state === 'hold' && item.userHold;
  ctx.save();
  if (userHold) {
    const halo = ctx.createRadialGradient(x, y, 0, x, y, 40);
    halo.addColorStop(0, rgba(INK.gate, 0.25));
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(x - 40, y - 40, 80, 80);
  }
  ctx.shadowColor = 'rgba(41,53,83,.18)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  shape();
  ctx.fillStyle = item.state === 'done' ? INK.done : userHold ? INK.gate : item.state === 'idle' ? '#fbfcfd' : '#ffffff';
  ctx.fill();
  ctx.restore();
  ctx.save();
  shape();
  if (item.state === 'idle') { ctx.setLineDash([3, 3]); ctx.lineWidth = 1.6; ctx.strokeStyle = INK.idle; ctx.stroke(); }
  if (item.state === 'active') { ctx.lineWidth = 2.6; ctx.strokeStyle = INK.active; ctx.stroke(); ctx.fillStyle = INK.active; ctx.beginPath(); ctx.arc(x, y, 4.6, 0, tau); ctx.fill(); }
  if (item.state === 'hold' && !userHold) { ctx.lineWidth = 2; ctx.strokeStyle = INK.wait; ctx.stroke(); bars(ctx, point, INK.wait); }
  if (userHold) bars(ctx, point, '#ffffff');
  if (item.state === 'stopped') {
    ctx.lineWidth = 2; ctx.strokeStyle = INK.idle; ctx.stroke();
    ctx.fillStyle = INK.muted; ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
  }
  if (item.state === 'error') {
    ctx.lineWidth = 2; ctx.strokeStyle = INK.error; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
  }
  if (item.state === 'done') {
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x - 4.5, y + 0.2); ctx.lineTo(x - 1.2, y + 3.4); ctx.lineTo(x + 4.8, y - 3.4); ctx.stroke();
  }
  ctx.restore();
  if (item.selected) {
    const reach = (item.gate ? radius * 1.28 : radius) + 8;
    ctx.save();
    ctx.strokeStyle = INK.ink;
    ctx.lineWidth = 1.5;
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * reach, y + dy * (reach - 10));
      ctx.lineTo(x + dx * reach, y + dy * reach);
      ctx.lineTo(x + dx * (reach - 10), y + dy * reach);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function paintPipelineStatic(ctx: CanvasRenderingContext2D, geometry: PipelineGeometry, stations: PipelineStation[]) {
  const { stations: points, radius } = geometry;
  const cursor = cursorOf(stations);
  ctx.save();
  ctx.lineCap = 'round';
  for (let index = 0; index < points.length - 1; index++) {
    const next = stations[index + 1];
    if (index === cursor) segment(ctx, points[index], points[index + 1], 2, '#8792a6', [2, 5]);
    else if (next.state !== 'idle') segment(ctx, points[index], points[index + 1], 2.6, '#3d4450', []);
    else segment(ctx, points[index], points[index + 1], 1.6, INK.idle, [5, 6]);
  }
  ctx.restore();
  points.forEach((point, index) => station(ctx, point, stations[index], radius));
}

export function pipelineAnimates(stations: PipelineStation[]) {
  const cursor = cursorOf(stations);
  return cursor >= 0 && stations[cursor].state === 'active';
}

export function paintPipelineDynamic(ctx: CanvasRenderingContext2D, geometry: PipelineGeometry, stations: PipelineStation[], time: number) {
  const cursor = cursorOf(stations);
  if (cursor < 0 || stations[cursor].state !== 'active') return;
  const [x, y] = geometry.stations[cursor];
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK.active;
  ctx.lineWidth = 1.6;
  const start = time * 0.9 - Math.PI / 2;
  const reach = (stations[cursor].gate ? geometry.radius * 1.28 : geometry.radius) + 7;
  ctx.beginPath();
  ctx.arc(x, y, reach, start, start + 1.7);
  ctx.stroke();
  const next = geometry.stations[cursor + 1];
  if (next) {
    const dx = next[0] - x;
    const dy = next[1] - y;
    const length = Math.hypot(dx, dy) || 1;
    const usable = length - 2 * reach;
    for (let bead = 0; bead < 3; bead++) {
      const along = reach + ((time * 40 + bead * usable / 3) % usable);
      const px = x + dx / length * along;
      const py = y + dy / length * along;
      for (let tail = 1; tail <= 3; tail++) {
        ctx.globalAlpha = 0.28 - tail * 0.07;
        ctx.fillStyle = INK.active;
        ctx.beginPath();
        ctx.arc(px - dx / length * tail * 5, py - dy / length * tail * 5, 2.6 - tail * 0.5, 0, tau);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(px, py, 2.6, 0, tau);
      ctx.fillStyle = INK.active;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }
  ctx.restore();
}

export interface ContextSeat { color: string; level: number; known: boolean; active: boolean; state: ObservatoryState }

/** Orbit, fibres into the core and the core disc. Returns the bead plan for active seats. */
export function paintContextStatic(ctx: CanvasRenderingContext2D, geometry: ContextGeometry, seats: ContextSeat[], options: { focus: number; held: boolean; scale: number; density: Density; now: number }): BeadPlan {
  const { center, rx, ry, radius, boxes } = geometry;
  const [cx, cy] = center;
  ctx.save();
  ctx.strokeStyle = '#c3cbdb';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, tau); ctx.stroke();
  ctx.strokeStyle = '#c8d0de';
  ctx.setLineDash([2, 5]);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.62, ry * 0.62, 0, 0, tau); ctx.stroke();
  ctx.setLineDash([]);
  for (let tick = 0; tick < 72; tick++) {
    const angle = tick / 72 * tau;
    const major = tick % 6 === 0;
    const length = major ? 7 : 3;
    const x = cx + Math.cos(angle) * rx;
    const y = cy + Math.sin(angle) * ry;
    const nx = Math.cos(angle) * ry;
    const ny = Math.sin(angle) * rx;
    const unit = Math.hypot(nx, ny) || 1;
    ctx.strokeStyle = major ? '#98a4bc' : '#b9c2d3';
    ctx.lineWidth = major ? 1.2 : 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + nx / unit * length, y + ny / unit * length); ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.9);
  glow.addColorStop(0, 'rgba(255,253,246,.95)');
  glow.addColorStop(1, 'rgba(255,253,246,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - radius * 1.9, cy - radius * 1.9, radius * 3.8, radius * 3.8);
  ctx.restore();
  const links: TopologyLink[] = [];
  const routes: Route[] = [];
  boxes.forEach((box, index) => {
    const seat = seats[index];
    const fibre = contextRoute(box, center, radius);
    if (!seat.known) {
      ctx.save();
      ctx.strokeStyle = INK.faint;
      ctx.lineWidth = 1.3;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(...fibre.curve[0]);
      ctx.bezierCurveTo(...fibre.curve[1], ...fibre.curve[2], ...fibre.curve[3]);
      ctx.stroke();
      ctx.restore();
      return;
    }
    links.push({ from: index, to: -1, color: seat.color, sourceColor: seat.color, active: seat.active,
      flow: { outbound: seat.active ? 1 : 0, returning: 0, waiting: 0, waitingUser: 0 }, effort: seat.level });
    routes.push({ link: links.length - 1, from: index, to: -1, curve: fibre.curve, len: fibre.len, table: fibre.table, sourceEdge: fibre.curve[0], targetEdge: fibre.curve[3] });
  });
  const plan = paintTopologyStatic(ctx, links, routes, { focus: options.focus, now: options.now, scale: options.scale, density: options.density, endcap: 'socket' });
  ctx.save();
  ctx.shadowColor = 'rgba(41,53,83,.22)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 6;
  const disc = ctx.createRadialGradient(cx, cy - radius * 0.3, 0, cx, cy, radius);
  disc.addColorStop(0, '#ffffff');
  disc.addColorStop(1, '#eef2f8');
  ctx.fillStyle = disc;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, tau); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#aab5ca';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = '#cfd6e2';
  ctx.beginPath(); ctx.arc(cx, cy, Math.max(4, radius - 7), 0, tau); ctx.stroke();
  if (options.held) {
    ctx.strokeStyle = INK.gate;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(cx, cy, radius + 10, 0, tau); ctx.stroke();
  }
  ctx.restore();
  return plan;
}

export function paintContextDynamic(ctx: CanvasRenderingContext2D, geometry: ContextGeometry, time: number) {
  const [cx, cy] = geometry.center;
  const start = -time * 0.35 - Math.PI / 2;
  ctx.save();
  ctx.strokeStyle = '#8a93a8';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(4, geometry.radius - 7), start, start + 1.2);
  ctx.stroke();
  ctx.restore();
}
