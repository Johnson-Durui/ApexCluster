// Real-state motion for the map pane (BUILD-SPEC-B §5.4, §7 rows 1, 2, 6 and 9). Pure: it diffs two Observatory
// snapshots and plans one-shot packets. Nothing here reads time or the DOM; callers decide whether changes animate
// (`animateChanges`, origin event|chat|demo) and run the plan once per model identity.
import type { Observatory } from './observatoryModel';

/** One parent seat → child seat bundle on which `count` tasks became running since the previous snapshot. */
export interface Dispatch { from: string; to: string; count: number }

export interface MapMotionDiff {
  dispatches: Dispatch[];
  /** How many more child tasks of the same turn are completed (the lead counter rolls). */
  returned: number;
  /** pipeline.stage left gate-a or gate-b for anything other than `cancelled` (the 你 → lead packet). */
  gatePassed: boolean;
}

export const NO_MOTION: MapMotionDiff = Object.freeze({ dispatches: [], returned: 0, gatePassed: false }) as MapMotionDiff;

/** The bundle key used by the canvas: parent seat id > child seat id. */
export const linkKey = (from: string, to: string) => from + '>' + to;

/**
 * §7 "Active": some task of the turn is queued, running or waiting on its children — never `waiting_user` alone. A
 * question or a gate waiting on the user is idle: the 决策管道 cursor stays a static ring and nothing loops.
 */
export function runActive(model: Pick<Observatory, 'tasks'>): boolean {
  return model.tasks.some(task => task.status === 'queued' || task.status === 'running' || task.status === 'waiting_children');
}

/**
 * 回放 / 暂停流线 belong to the full 架构视图 (§5.2): the docked map offers neither control, so it never plays a replay
 * or holds beads frozen that it cannot resume. `replayTurn` / `motionPaused` are the full view's toggles.
 */
export function mapPlayback({ full, topology, canReplay, replayTurn, turnId, motionPaused, canFlow }: {
  full: boolean; topology: boolean; canReplay: boolean; replayTurn: string | null; turnId?: string; motionPaused: boolean; canFlow: boolean;
}) {
  const replay = full && canReplay && replayTurn === (turnId ?? '');
  const playback = topology && replay;
  return { replay, playback, paused: (full && motionPaused) || (!playback && !canFlow) };
}

const isGate = (stage: string | null | undefined) => stage === 'gate-a' || stage === 'gate-b';

/**
 * What changed between two snapshots. A different turn means nothing from the previous turn counts as "before",
 * so the first dispatches of a new turn still play. The same object twice (a StrictMode re-run) yields no motion.
 */
export function diffObservatory(previous: Observatory | undefined, next: Observatory): MapMotionDiff {
  if (!previous || previous === next) return NO_MOTION;
  const sameTurn = previous.turnId === next.turnId;
  const before = new Map(sameTurn ? previous.tasks.map(task => [task.id, task.status]) : []);
  const byId = new Map(next.tasks.map(task => [task.id, task]));
  const bundles = new Map<string, Dispatch>();
  for (const task of next.tasks) {
    if (task.status !== 'running' || before.get(task.id) === 'running') continue;
    const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
    if (!parent || parent.role === task.role) continue;
    const key = linkKey(parent.role, task.role);
    const bundle = bundles.get(key);
    if (bundle) bundle.count++;
    else bundles.set(key, { from: parent.role, to: task.role, count: 1 });
  }
  const returned = sameTurn ? Math.max(0, next.children.completed - previous.children.completed) : 0;
  const from = previous.pipeline.active;
  const to = next.pipeline.active;
  const gatePassed = isGate(from) && to != null && to !== from && to !== 'cancelled';
  if (!bundles.size && !returned && !gatePassed) return NO_MOTION;
  return { dispatches: [...bundles.values()], returned, gatePassed };
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** §7 row 1: clamp(300 + 0.9·len, 360, 700) ms along the lead → seat route. */
export function packetDuration(length: number): number {
  return Math.round(clamp(300 + 0.9 * (Number.isFinite(length) ? length : 0), 360, 700));
}

export interface PacketPlan {
  key: string;
  delay: number;
  duration: number;
  /** Tasks this packet stands for; above 1 the canvas writes `×N` beside the head. */
  weight: number;
}

export const PACKETS_PER_BUNDLE = 3;
export const PACKETS_TOTAL = 6;
export const PACKET_STAGGER = 80;

/**
 * At most three packets per bundle and six in all; extras merge into the last packet, which carries `×N`.
 * `routeLength` returns undefined for a bundle the map does not draw (a missing route plays no packet).
 */
export function planPackets(dispatches: Dispatch[], routeLength: (key: string) => number | undefined): PacketPlan[] {
  const planned: PacketPlan[] = [];
  for (const dispatch of dispatches) {
    const key = linkKey(dispatch.from, dispatch.to);
    const length = routeLength(key);
    if (length === undefined || dispatch.count < 1) continue;
    const count = Math.min(dispatch.count, PACKETS_PER_BUNDLE);
    for (let index = 0; index < count; index++) {
      const last = index === count - 1;
      planned.push({ key, delay: index * PACKET_STAGGER, duration: packetDuration(length), weight: last ? dispatch.count - index : 1 });
    }
  }
  if (planned.length <= PACKETS_TOTAL) return planned;
  const kept = planned.slice(0, PACKETS_TOTAL);
  kept[PACKETS_TOTAL - 1] = { ...kept[PACKETS_TOTAL - 1], weight: planned.slice(PACKETS_TOTAL - 1).reduce((sum, packet) => sum + packet.weight, 0) };
  return kept;
}

/** The longest delay + duration of a plan: when the last packet lands. */
export function planEnd(plan: PacketPlan[]): number {
  return plan.reduce((end, packet) => Math.max(end, packet.delay + packet.duration), 0);
}

/** ease-io (cubic-bezier(.65,0,.35,1) approximated by a symmetric cubic), shared by packets and the camera. */
export function easeInOut(progress: number): number {
  const p = clamp(progress, 0, 1);
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
