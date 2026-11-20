// Topology painter: glass fibre bundles on the light stage, plus the per-frame beads.
// Static marks go into a cached layer; only beads are drawn per frame (no gradients or shadows in that path).
import { bezier, normal, tAtDistance, type Point, type Route } from './observatoryLayout';
import { bundleHalfWidth, coreInk, INK, mix, rgba, type Density } from './observatoryTheme';

export interface TopologyLink {
  from: number;
  to: number;
  color: string;
  sourceColor: string;
  active: boolean;
  flow: { outbound: number; returning: number; waiting: number; waitingUser: number };
  effort: number;
  /** Epoch ms after which returning pulses stop; undefined means replay (always shown). */
  returnUntil?: number;
  /** Stable bundle id (parent seat > child seat); packets follow it across re-layouts. */
  key?: string;
  /** Dormant welcome: a dashed potential link, never a real dispatch. */
  potential?: boolean;
  /** Reduced-motion stand-in for a dispatch packet: the bundle is highlighted statically for a moment. */
  flash?: boolean;
}

type Register = 'live' | 'settled' | 'ghost';
interface Track { route: Route; hw: number; lane: number; direction: 1 | -1; count: number; offset: number; color: string; core: string; tail: number; focused: boolean }
export interface BeadPlan { tracks: Track[]; expiresAt: number; speed: number; tiny: boolean }

const tau = Math.PI * 2;
const effortLevel = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(6, Math.round(value))) : 0;
const lanes = (count: number, spread: number) => count <= 1 ? [0] : Array.from({ length: count }, (_, index) => -spread + 2 * spread * index / (count - 1));

function sampler(route: Route, hw: number, phase: number) {
  const count = Math.max(18, Math.min(80, Math.round(route.len / 8)));
  const samples = Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    return { t, point: bezier(route.curve, t), normal: normal(route.curve, t), envelope: 0.30 + 0.70 * Math.sin(Math.PI * t) ** 0.8 };
  });
  const strand = (lane: number, wobble: number, extra = 0) => samples.map(({ t, point, normal: [nx, ny], envelope }): Point => {
    const offset = (lane + wobble * Math.sin(phase + 1.8 * Math.PI * t + 1.7 * lane)) * hw * envelope + Math.sign(lane) * extra;
    return [point[0] + nx * offset, point[1] + ny * offset];
  });
  return { strand };
}

function polyline(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
}

function ribbon(ctx: CanvasRenderingContext2D, upper: Point[], lower: Point[]) {
  polyline(ctx, upper);
  for (let index = lower.length - 1; index >= 0; index--) ctx.lineTo(...lower[index]);
  ctx.closePath();
}

function classify(link: TopologyLink, focus: number, now: number) {
  const returning = link.flow.returning > 0 && (link.returnUntil === undefined || now < link.returnUntil) ? link.flow.returning : 0;
  const moving = link.flow.outbound > 0 || returning > 0;
  const touches = focus < 0 || link.from === focus || link.to === focus;
  const register: Register = !touches ? 'ghost' : moving || link.flow.waiting > 0 ? 'live' : 'settled';
  const queued = link.active && !moving && link.flow.waiting === 0;
  const rank = register === 'ghost' ? 0 : register === 'settled' ? (queued ? 1 : 2) :
    link.flow.outbound > 0 ? 5 : returning > 0 ? 4 : 3;
  return { register, returning, moving, queued, rank };
}

function arrow(ctx: CanvasRenderingContext2D, [x, y]: Point, angle: number, half: number, length: number, fill: string, stroke = '#ffffff') {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-length, -half);
  ctx.lineTo(-length, half);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = stroke === '#ffffff' ? 1.2 : 1.6;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

function chevron(ctx: CanvasRenderingContext2D, route: Route, fraction: number, backwards: boolean, double: boolean, stroke: string) {
  const t = tAtDistance(route.table, route.len * fraction);
  const [x, y] = bezier(route.curve, t);
  const [nx, ny] = normal(route.curve, t);
  const angle = Math.atan2(-nx, ny) + (backwards ? Math.PI : 0);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  for (const shift of double ? [-2.5, 2.5] : [0]) {
    ctx.beginPath();
    ctx.moveTo(7 + shift, 0);
    ctx.lineTo(-5 + shift, -6);
    ctx.lineTo(-2 + shift, 0);
    ctx.lineTo(-5 + shift, 6);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  ctx.restore();
}

function halo(ctx: CanvasRenderingContext2D, [x, y]: Point, radius: number, color: string) {
  const fade = ctx.createRadialGradient(x, y, 0, x, y, radius);
  fade.addColorStop(0, color);
  fade.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = fade;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function waitingCap(ctx: CanvasRenderingContext2D, point: Point, user: boolean) {
  const [x, y] = point;
  ctx.save();
  if (user) {
    halo(ctx, point, 22, rgba(INK.gate, 0.22));
    ctx.strokeStyle = INK.gate;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, tau); ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 13.5, 0, tau); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK.gate;
    ctx.beginPath(); ctx.moveTo(x, y - 4.6); ctx.lineTo(x + 4.6, y); ctx.lineTo(x, y + 4.6); ctx.lineTo(x - 4.6, y); ctx.closePath(); ctx.fill();
  } else {
    halo(ctx, point, 18, 'rgba(214,140,40,.18)');
    ctx.strokeStyle = INK.waitStroke;
    ctx.lineWidth = 1.7;
    ctx.setLineDash([3, 2.4]);
    ctx.beginPath(); ctx.arc(x, y, 9, 0, tau); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK.waitStroke;
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, tau); ctx.fill();
  }
  ctx.restore();
}

/** Paint every static topology mark and return the bead plan for the dynamic pass. */
export function paintTopologyStatic(ctx: CanvasRenderingContext2D, links: TopologyLink[], routes: Route[], options: { focus: number; now: number; scale: number; density: Density; endcap?: 'arrow' | 'socket' }): BeadPlan {
  const { focus, now, scale } = options;
  const tiny = options.density === 'tiny';
  const order = routes.map(route => ({ route, link: links[route.link], ...classify(links[route.link], focus, now) }))
    .sort((a, b) => a.rank - b.rank || a.route.link - b.route.link);
  const marks: Array<() => void> = [];
  const tracks: Track[] = [];
  let expiresAt = Infinity;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const { route, link, register, returning, moving, queued } of order) {
    if (link.potential) { potentialLink(ctx, route); continue; }
    const level = effortLevel(link.effort);
    const touched = focus >= 0 && register !== 'ghost';
    const hw = bundleHalfWidth(level, scale);
    const target = link.color;
    const core = register === 'ghost' ? mix(coreInk(target), INK.ghost, 0.55) : coreInk(target);
    const { strand } = sampler(route, hw, route.link * 0.9);
    const upper = strand(1, 0);
    const lower = strand(-1, 0);
    if (register !== 'ghost') {
      ctx.globalAlpha = touched || link.flash ? 0.95 : register === 'live' ? 0.85 : 0.70;
      ctx.fillStyle = INK.casing;
      ribbon(ctx, strand(1, 0, 3), strand(-1, 0, 3));
      ctx.fill();
    }
    if (register === 'live') {
      const center = strand(0, 0);
      ctx.strokeStyle = target;
      for (const [dy, width, alpha] of [[3, 2 * hw + 8, 0.07], [1.5, 2 * hw + 2, 0.08]]) {
        ctx.save();
        ctx.translate(0, dy);
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        polyline(ctx, center);
        ctx.stroke();
        ctx.restore();
      }
    }
    const wash = register === 'live' ? ctx.createLinearGradient(...route.curve[0], ...route.curve[3]) : null;
    if (wash) {
      wash.addColorStop(0, link.sourceColor);
      wash.addColorStop(0.4, target);
      wash.addColorStop(1, target);
    }
    ctx.globalAlpha = touched || link.flash ? 0.2 : register === 'live' ? 0.13 : register === 'settled' ? 0.07 : 0.05;
    ctx.fillStyle = wash ?? (register === 'ghost' ? mix(target, INK.ghost, 0.7) : target);
    ribbon(ctx, upper, lower);
    ctx.fill();
    ctx.setLineDash(level === 0 ? [3, 3] : []);
    if (register !== 'ghost') {
      ctx.strokeStyle = target;
      ctx.lineWidth = register === 'live' ? 0.6 : 0.5;
      ctx.globalAlpha = register === 'live' ? 0.36 : 0.24;
      for (const lane of lanes(4 + 2 * level, 0.95)) { polyline(ctx, strand(lane, 0.18)); ctx.stroke(); }
    }
    ctx.strokeStyle = core;
    // Thin, spread cores keep heavy tiers countable and glassy instead of a solid dark rope. A focused seat's bundles
    // thicken (§5.3: strands 1.05 → 2.3 px); every other bundle drops to a ghost at .2.
    ctx.lineWidth = touched ? 2.3 : register === 'live' ? (level <= 1 ? 2 : level >= 3 ? 1.1 : 1.4) : register === 'settled' ? (level <= 1 ? 1.6 : 1.0) : 1;
    ctx.globalAlpha = register === 'live' ? 0.92 : register === 'settled' ? 0.62 : 0.2;
    for (const lane of lanes(Math.max(1, level), 0.72)) { polyline(ctx, strand(lane, 0.10)); ctx.stroke(); }
    ctx.setLineDash([]);
    if (register === 'live') {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.65;
      polyline(ctx, strand(-0.86, 0.10));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const alpha = register === 'live' ? 1 : register === 'settled' ? 0.75 : 0.35;
    const end = route.curve[3];
    const angle = Math.atan2(route.targetEdge[1] - end[1], route.targetEdge[0] - end[0]);
    const userWait = register !== 'ghost' && link.flow.waitingUser > 0;
    const childWait = register !== 'ghost' && link.flow.waiting - link.flow.waitingUser > 0;
    marks.push(() => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = link.sourceColor;
      ctx.beginPath(); ctx.arc(...route.curve[0], 3.2, 0, tau); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.strokeStyle = link.sourceColor; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(...route.sourceEdge); ctx.lineTo(...route.curve[0]); ctx.stroke();
      if (userWait || childWait) waitingCap(ctx, end, userWait);
      else if (options.endcap === 'socket') {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(...end, 3.6, 0, tau); ctx.fill();
        ctx.strokeStyle = core; ctx.lineWidth = 1.8; ctx.stroke();
      } else arrow(ctx, route.targetEdge, angle, Math.min(hw * 0.3, 6) + 2.5, Math.hypot(route.targetEdge[0] - end[0], route.targetEdge[1] - end[1]) + 2,
        queued ? '#ffffff' : core, queued ? core : '#ffffff'); // queued: hollow arrowhead, not yet travelling
      if (register === 'live' && moving) {
        const both = link.flow.outbound > 0 && returning > 0;
        if (link.flow.outbound > 0) chevron(ctx, route, both ? 0.4 : 0.5, false, false, core);
        if (returning > 0) chevron(ctx, route, both ? 0.6 : 0.5, true, true, core);
      }
      ctx.globalAlpha = 1;
    });
    if (register !== 'live' || !moving) continue;
    if (returning > 0 && link.returnUntil !== undefined) expiresAt = Math.min(expiresAt, link.returnUntil);
    const count = Math.max(1, Math.min(3, Math.round(route.len / 240)));
    const tail = Math.min(0.28 * route.len, 44 + 4 * level);
    const touches = focus >= 0 && (link.from === focus || link.to === focus);
    for (const direction of [1, -1] as const) {
      if (direction === 1 ? link.flow.outbound <= 0 : returning <= 0) continue;
      tracks.push({ route, hw, lane: direction === 1 ? -0.3 : 0.3, direction, count, offset: route.link * 53, color: target, core, tail, focused: touches });
    }
  }
  for (const mark of marks) mark();
  ctx.restore();
  tracks.sort((a, b) => Number(b.focused) - Number(a.focused) || b.direction - a.direction);
  let budget = 96;
  const kept = tracks.filter(track => {
    if (budget <= 0) return false;
    track.count = Math.min(track.count, budget);
    budget -= track.count;
    return true;
  });
  return { tracks: kept, expiresAt, speed: tiny ? 56 : 72, tiny };
}

const sprites = new Map<string, HTMLCanvasElement>();

function sprite(color: string, core: string, direction: 1 | -1, size: number, dpr: number) {
  const key = [color, direction, size, dpr].join('|');
  const cached = sprites.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.ceil(size * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(dpr, dpr);
    const middle = size / 2;
    halo(ctx, [middle, middle], middle, rgba(color, 0.20));
    ctx.beginPath();
    ctx.arc(middle, middle, direction === 1 ? 3.6 : 3.4, 0, tau);
    ctx.fillStyle = direction === 1 ? '#ffffff' : color;
    ctx.fill();
    ctx.lineWidth = direction === 1 ? 1.8 : 1.4;
    ctx.strokeStyle = direction === 1 ? core : '#ffffff';
    ctx.stroke();
  }
  if (sprites.size > 64) sprites.clear();
  sprites.set(key, canvas);
  return canvas;
}

function trackPoint(track: Track, distance: number): Point {
  const t = tAtDistance(track.route.table, distance);
  const [x, y] = bezier(track.route.curve, t);
  const [nx, ny] = normal(track.route.curve, t);
  const offset = track.lane * track.hw * (0.30 + 0.70 * Math.sin(Math.PI * t) ** 0.8);
  return [x + nx * offset, y + ny * offset];
}

/** Per-frame pass: beads with tapered tails. Direction reads from the tail and pearl type, never colour alone. */
export function paintTopologyBeads(ctx: CanvasRenderingContext2D, plan: BeadPlan, time: number, dpr: number) {
  const k = plan.tiny ? 0.8 : 1;
  const size = plan.tiny ? 22 : 28;
  ctx.save();
  ctx.lineCap = 'round';
  for (const track of plan.tracks) {
    const { len } = track.route;
    const head = sprite(track.color, track.core, track.direction, size, dpr);
    for (let bead = 0; bead < track.count; bead++) {
      const travelled = ((time * plan.speed + bead * len / track.count + track.offset) % len + len) % len;
      const distance = track.direction === 1 ? travelled : len - travelled;
      const fade = Math.max(0, Math.min(1, Math.min(distance, len - distance) / 18));
      if (fade <= 0) continue;
      let previous = trackPoint(track, distance);
      const headPoint = previous;
      for (let segment = 0; segment < 7; segment++) {
        const next = trackPoint(track, distance - track.direction * track.tail * (segment + 1) / 7);
        ctx.beginPath();
        ctx.moveTo(...previous);
        ctx.lineTo(...next);
        ctx.strokeStyle = track.color;
        ctx.lineWidth = (5.2 - 0.5 * segment) * k;
        ctx.globalAlpha = (0.30 - 0.038 * segment) * fade;
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = (2.0 - 0.2 * segment) * k;
        ctx.globalAlpha = (0.80 - 0.11 * segment) * fade;
        ctx.stroke();
        previous = next;
      }
      ctx.globalAlpha = fade;
      ctx.drawImage(head, headPoint[0] - size / 2, headPoint[1] - size / 2, size, size);
    }
  }
  ctx.restore();
}

/** Dormant welcome: a dashed hairline from the lead to a seat that could be dispatched; it carries no flow. */
function potentialLink(ctx: CanvasRenderingContext2D, route: Route) {
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = INK.ghost;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(...route.curve[0]);
  ctx.bezierCurveTo(...route.curve[1], ...route.curve[2], ...route.curve[3]);
  ctx.stroke();
  ctx.restore();
}

/** Clips to the part of a route from its start to `upTo` (0–1 of its length), wide enough for the whole bundle. */
export function clipRoute(ctx: CanvasRenderingContext2D, route: Route, upTo: number, halfWidth: number) {
  const steps = 24;
  const upper: Point[] = [];
  const lower: Point[] = [];
  const end = Math.max(0, Math.min(1, upTo));
  for (let index = 0; index <= steps; index++) {
    const t = tAtDistance(route.table, route.len * end * index / steps);
    const [x, y] = bezier(route.curve, t);
    const [nx, ny] = normal(route.curve, t);
    upper.push([x + nx * halfWidth, y + ny * halfWidth]);
    lower.push([x - nx * halfWidth, y - ny * halfWidth]);
  }
  ribbon(ctx, upper, lower);
  ctx.clip();
}

/** §7 row 1: one dispatch packet, a 3.3 px white core in a 10 px seat glow, at `progress` (already eased) along the route. */
export function paintPacket(ctx: CanvasRenderingContext2D, route: Route, progress: number, color: string, core: string, weight: number) {
  const t = tAtDistance(route.table, route.len * Math.max(0, Math.min(1, progress)));
  const point = bezier(route.curve, t);
  ctx.save();
  halo(ctx, point, 10, rgba(color, 0.42));
  ctx.beginPath();
  ctx.arc(point[0], point[1], 3.3, 0, tau);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = core;
  ctx.stroke();
  if (weight > 1) {
    ctx.font = '600 11.5px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText('×' + weight, point[0] + 9, point[1]);
    ctx.fillStyle = INK.ink;
    ctx.fillText('×' + weight, point[0] + 9, point[1]);
  }
  ctx.restore();
}
