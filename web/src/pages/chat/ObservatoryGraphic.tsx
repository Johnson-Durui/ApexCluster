import { useEffect, useRef, type RefObject } from 'react';
import { clockPaused, reducedMotion, subscribeClockPause, useReducedMotion } from '../../components/motion';
import { easeInOut, type PacketPlan } from './mapMotion';
import { observeSeatFocus } from './mapFocus';
import type { ContextGeometry, PipelineGeometry, Route } from './observatoryLayout';
import { clipRoute, paintPacket, paintTopologyBeads, paintTopologyStatic, type BeadPlan, type TopologyLink } from './observatoryFlow';
import { paintContextDynamic, paintContextStatic, paintField, paintPipelineDynamic, paintPipelineStatic, pipelineAnimates, type ContextSeat, type PipelineStation } from './observatoryPaint';
import { bundleHalfWidth, bundleScale, coreInk, type Density, type Size } from './observatoryTheme';

export type GraphicScene =
  | { mode: 'topology'; links: TopologyLink[]; routes: Route[] }
  | { mode: 'pipeline'; geometry: PipelineGeometry; stations: PipelineStation[] }
  | { mode: 'context'; geometry: ContextGeometry; seats: ContextSeat[] };

/** Imperative motion entry: launch one-shot dispatch packets; returns when each bundle's last packet lands (ms from now). */
export interface GraphicHandle { launch(plan: PacketPlan[]): Map<string, number> }

export interface GraphicProps {
  scene: GraphicScene;
  /** Changes whenever anything painted in the static layer changes (positions, states, flows). */
  sceneKey: string;
  size: Size;
  density: Density;
  /** Seat ids in slot order; the focused seat (hover or pin, read from `.chat-work`) is looked up here. */
  ids: string[];
  held: boolean;
  /** Freezes topology beads in place (pause button, or no live connection). */
  paused: boolean;
  /** False when the stream is not live or the demo is paused: pipeline and context motion stop too. */
  live: boolean;
  /** Bumping this restarts the bead clock (replay). */
  epoch: number;
  handle?: RefObject<GraphicHandle | null>;
}

interface Packet extends PacketPlan { start: number }
interface Cache { key: string; layer: HTMLCanvasElement; plan: BeadPlan | null; animated: boolean; links: Map<string, HTMLCanvasElement> }
const FLASH_MS = 1200;

function layerCanvas(size: Size, dpr: number) {
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, Math.round(size.w * dpr));
  layer.height = Math.max(1, Math.round(size.h * dpr));
  const ctx = layer.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { layer, ctx };
}

function buildLayer(props: GraphicProps, dpr: number, focus: number, hidden: Set<string>, flash: Set<string>): Omit<Cache, 'key'> {
  const { scene, size, density, held } = props;
  const { layer, ctx } = layerCanvas(size, dpr);
  const links = new Map<string, HTMLCanvasElement>();
  if (!ctx) return { layer, plan: null, animated: false, links };
  paintField(ctx, size, density, scene.mode === 'context' ? scene.geometry.center : undefined);
  const scale = bundleScale(size.w, density);
  const now = Date.now();
  if (scene.mode === 'topology') {
    // Reduced motion: no return beads at all (§7 row 5), so no expiry repaint either; dispatches flash instead.
    const still = reducedMotion();
    const marked = scene.links.map(link => link.key && flash.has(link.key) ? { ...link, flash: true } : still && link.returnUntil !== undefined ? { ...link, returnUntil: 0 } : link);
    const shown = scene.routes.filter(route => !hidden.has(scene.links[route.link]?.key ?? ''));
    const plan = paintTopologyStatic(ctx, marked, shown, { focus, now, scale, density });
    // Bundles with a packet in flight are painted alone, revealed behind the packet (§7 row 1).
    for (const route of scene.routes) {
      const key = scene.links[route.link]?.key;
      if (!key || !hidden.has(key)) continue;
      const own = layerCanvas(size, dpr);
      if (own.ctx) paintTopologyStatic(own.ctx, marked, [route], { focus, now, scale, density });
      links.set(key, own.layer);
    }
    return { layer, plan, animated: plan.tracks.length > 0, links };
  }
  if (scene.mode === 'pipeline') {
    paintPipelineStatic(ctx, scene.geometry, scene.stations);
    return { layer, plan: null, animated: pipelineAnimates(scene.stations), links };
  }
  const plan = paintContextStatic(ctx, scene.geometry, scene.seats, { focus, held, scale, density, now });
  return { layer, plan, animated: scene.seats.some(seat => seat.active), links };
}

export default function ObservatoryGraphic(props: GraphicProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const reduce = useReducedMotion();
  const kick = useRef<() => void>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let cache: Cache | undefined;
    let frame = 0;
    let lastPaint = 0;
    let previous = 0;
    let time = 0;
    let epoch = latest.current.epoch;
    let expiry = 0;
    let expiryTimer = 0;
    let visible = true;
    let focusSeat: string | undefined;
    let packets: Packet[] = [];
    const flash = new Set<string>();
    let resolution: MediaQueryList | undefined;

    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    const armExpiry = (expiresAt: number) => {
      window.clearTimeout(expiryTimer);
      if (!Number.isFinite(expiresAt)) return;
      // setTimeout overflows above 2^31-1 ms; re-arm instead of firing early for far-future timestamps.
      expiryTimer = window.setTimeout(() => {
        if (Date.now() >= expiresAt) { expiry++; schedule(); } else armExpiry(expiresAt);
      }, Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now() + 20)));
    };
    const watchResolution = (dpr: number) => {
      resolution?.removeEventListener('change', onResolution);
      resolution = window.matchMedia('(resolution: ' + dpr + 'dppx)');
      resolution.addEventListener('change', onResolution);
    };
    function onResolution() { schedule(); }
    const stalled = () => !visible || document.hidden || clockPaused();

    function render(now: number) {
      frame = 0;
      const props = latest.current;
      if (stalled() || props.size.w < 1 || props.size.h < 1) { previous = 0; return; }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(props.size.w * dpr);
      const height = Math.round(props.size.h * dpr);
      if (canvas!.width !== width || canvas!.height !== height) { canvas!.width = width; canvas!.height = height; }
      packets = packets.filter(packet => now < packet.start + packet.duration);
      // QA hook: the number of packets in flight (written only when it changes).
      if (canvas!.dataset.packets !== String(packets.length)) canvas!.dataset.packets = String(packets.length);
      const hidden = new Set(packets.map(packet => packet.key));
      const focus = focusSeat ? props.ids.indexOf(focusSeat) : -1;
      const key = [props.sceneKey, props.size.w, props.size.h, dpr, props.density, focus, props.held, expiry, [...hidden].sort(), [...flash].sort(), reducedMotion()].join('|');
      if (!cache || cache.key !== key) {
        if (!cache || dpr !== Number(cache.key.split('|')[3])) watchResolution(dpr);
        cache = { key, ...buildLayer(props, dpr, focus, hidden, flash) };
        armExpiry(cache.plan?.expiresAt ?? Infinity);
      }
      if (props.epoch !== epoch) { epoch = props.epoch; time = 0; previous = 0; }
      const frozen = props.scene.mode === 'topology' ? props.paused : !props.live;
      const loop = cache.animated && !reducedMotion() && !frozen;
      const flying = packets.length > 0;
      if (loop && !flying && previous && now - lastPaint < 32) { frame = requestAnimationFrame(render); return; }
      if (loop && previous) time += Math.min(0.1, (now - previous) / 1000);
      previous = loop ? now : 0;
      lastPaint = now;
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, width, height);
      ctx!.drawImage(cache.layer, 0, 0);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const scene = props.scene;
      // Reduced motion keeps the static chevrons only (§7 row 4).
      if (cache.plan && !reducedMotion()) paintTopologyBeads(ctx!, cache.plan, time, dpr);
      if (scene.mode === 'pipeline') paintPipelineDynamic(ctx!, scene.geometry, scene.stations, time);
      if (scene.mode === 'context' && cache.animated) paintContextDynamic(ctx!, scene.geometry, time);
      if (scene.mode === 'topology' && flying) paintFlight(scene, cache, now, dpr);
      if (loop || flying) frame = requestAnimationFrame(render);
      // The last packet just landed: one more frame repaints the bundle into the shared layer, then the clock stops.
      else if (hidden.size) schedule();
    }

    function paintFlight(scene: Extract<GraphicScene, { mode: 'topology' }>, current: Cache, now: number, dpr: number) {
      const scale = bundleScale(latest.current.size.w, latest.current.density);
      for (const packet of packets) {
        const route = scene.routes.find(item => scene.links[item.link]?.key === packet.key);
        const link = route ? scene.links[route.link] : undefined;
        const layer = current.links.get(packet.key);
        if (!route || !link) continue;
        const progress = easeInOut((now - packet.start) / packet.duration);
        if (now < packet.start) continue;
        if (layer && packet === packets.find(item => item.key === packet.key)) {
          ctx!.save();
          clipRoute(ctx!, route, progress, bundleHalfWidth(link.effort, scale) + 16);
          ctx!.setTransform(1, 0, 0, 1, 0, 0);
          ctx!.drawImage(layer, 0, 0);
          ctx!.restore();
          ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        paintPacket(ctx!, route, progress, link.color, coreInk(link.color), packet.weight);
      }
    }

    const handle: GraphicHandle = {
      launch(plan) {
        const landings = new Map<string, number>();
        const scene = latest.current.scene;
        if (!plan.length || scene.mode !== 'topology') return landings;
        if (reducedMotion()) {
          // §7 row 1, reduced motion: no packet; the bundle highlights statically for 1.2 s.
          for (const packet of plan) flash.add(packet.key);
          schedule();
          window.setTimeout(() => { for (const packet of plan) flash.delete(packet.key); schedule(); }, FLASH_MS);
          return landings;
        }
        if (stalled()) return landings;
        const now = performance.now();
        for (const packet of plan) {
          packets.push({ ...packet, start: now + packet.delay });
          landings.set(packet.key, Math.max(landings.get(packet.key) ?? 0, packet.delay + packet.duration));
        }
        schedule();
        return landings;
      },
    };
    if (latest.current.handle) latest.current.handle.current = handle;

    kick.current = schedule;
    const intersection = new IntersectionObserver(entries => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) schedule();
    });
    intersection.observe(canvas);
    const stopFocus = observeSeatFocus(canvas, state => {
      if (state.seat === focusSeat) return;
      focusSeat = state.seat;
      schedule();
    });
    const onVisibility = () => { previous = 0; schedule(); };
    // A GPU reset blanks canvases; rebuild the cached layer when the context comes back.
    const onRestored = () => { cache = undefined; previous = 0; schedule(); };
    const stopPause = subscribeClockPause(() => { previous = 0; if (!clockPaused()) schedule(); });
    canvas.addEventListener('contextrestored', onRestored);
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      kick.current = undefined;
      if (latest.current.handle?.current === handle) latest.current.handle.current = null;
      cancelAnimationFrame(frame);
      window.clearTimeout(expiryTimer);
      intersection.disconnect();
      stopFocus();
      stopPause();
      resolution?.removeEventListener('change', onResolution);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('contextrestored', onRestored);
    };
  }, []);

  useEffect(() => kick.current?.(), [props.sceneKey, props.size.w, props.size.h, props.density, props.ids, props.held, props.paused, props.live, props.epoch, props.scene, reduce]);
  return <canvas aria-hidden="true" className="observatory-canvas" ref={canvasRef} />;
}
