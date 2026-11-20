// 协作拓扑 layer of the map pane: scene geometry, seat cards, the 你 node and the dormant welcome caption
// (BUILD-SPEC-B §5.2). Cards are the buttons; focus dimming is pure CSS from `.chat-work[data-focus-seat]` (MapStage
// renders mapFocus.dimRules for whichever view is shown, so 上下文 cards dim too).
import { useMemo, type CSSProperties } from 'react';
import { seatHandlers } from '../../components/seatFocus';
import { IDENTITY, viewBox, type Camera } from './mapCamera';
import { linkKey } from './mapMotion';
import type { TopologyLink } from './observatoryFlow';
import { buildRoutes, placeTopologyCards, type Box, type Route } from './observatoryLayout';
import type { Observatory } from './observatoryModel';
import { CHIP_WORDS, roleKind, TopologyCard, type ChipKind, type Role } from './ObservatoryParts';
import { topologySlots } from './observatoryScene';
import { CARD, seatInk, type Density, type Size } from './observatoryTheme';

export interface TopologyScene {
  ids: string[];
  /** Global layout (camera identity), for camera targets. */
  world: Box[];
  boxes: Box[];
  links: TopologyLink[];
  routes: Route[];
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
/** Tight stages hide the card meta row, so cards lose that row's height. */
const TIGHT_CUT: Record<Density, number> = { regular: 18, compact: 16, tiny: 0 };
const LEAD_EXTRA: Record<Density, number> = { regular: 84, compact: 84, tiny: 44 };
export const YOU_GAP = 44;
export const YOU_W = 58;

export function cardSize(density: Density, tight: boolean): Size {
  const card = CARD[density].topology;
  return tight ? { w: card.w, h: card.h - TIGHT_CUT[density] } : card;
}

export function useTopologyScene({ model, pinned, size, density, tight, replay, dormant, canFlow, camera = IDENTITY }: {
  model: Observatory; pinned?: string; size: Size; density: Density; tight: boolean; replay: boolean; dormant: boolean; canFlow: boolean; camera?: Camera;
}): TopologyScene {
  return useMemo(() => {
    const slots = topologySlots(model, pinned);
    const ids = slots.map(slot => slot.id);
    const card = cardSize(density, tight);
    const root = slots[0]?.id;
    const widths = root ? new Map([[root, card.w + LEAD_EXTRA[density]]]) : undefined;
    const world = size.w > 0 && size.h > 0 && slots.length ? placeTopologyCards(slots, size, density, card, widths) : [];
    const boxes = world.map(box => viewBox(box, camera));
    const index = new Map(ids.map((id, position) => [id, position]));
    // Return beads stop at once when the root task is terminal or the stream is not live (§5.4).
    const rootDone = TERMINAL.has(String(model.rootStatus)) || !canFlow;
    const links: TopologyLink[] = dormant && root
      ? ids.slice(1).map(id => ({ from: 0, to: index.get(id)!, color: seatInk(id), sourceColor: seatInk(root), active: false, potential: true, key: linkKey(root, id),
        flow: { outbound: 0, returning: 0, waiting: 0, waitingUser: 0 }, effort: 0 }))
      : model.links.flatMap(link => {
        const from = index.get(link.from);
        const to = index.get(link.to);
        return from === undefined || to === undefined ? [] : [{
          from, to, color: seatInk(link.to), sourceColor: seatInk(link.from), active: link.active, flow: link.flow, effort: link.effort, key: linkKey(link.from, link.to),
          returnUntil: replay ? undefined : rootDone ? 0 : (Date.parse(link.returnedAt ?? '') || 0) + 9000,
        }];
      });
    const routes = boxes.length ? buildRoutes(boxes, links, density) : [];
    return { ids, world, boxes, links, routes };
  }, [model, pinned, size, density, tight, replay, dormant, canFlow, camera]);
}

/** Status shown on a card: the lead reads 等你决定 at a user gate; dormant seats read 就绪. */
export function cardStatus(model: Observatory, role: Role, userGate: boolean, dormant: boolean): { kind: ChipKind; word: string } {
  if (role.id === model.rootRole && userGate) return { kind: 'hold-user', word: '等你决定' };
  const kind = roleKind(role);
  if (dormant && kind === 'idle') return { kind, word: '就绪' };
  return { kind, word: CHIP_WORDS[kind] };
}

export function TopologyLayer({ model, scene, density, userGate, held, dormant, welcome, showYou, onGateNode }: {
  model: Observatory; scene: TopologyScene; density: Density; userGate: boolean; held: boolean; dormant: boolean;
  welcome?: { ready: number; unavailable: { role: string; reason: string }[] };
  showYou: boolean; onGateNode(): void;
}) {
  const roleById = useMemo(() => new Map(model.roles.map(role => [role.id, role])), [model]);
  const related = useMemo(() => {
    const map = new Map<string, string[]>(scene.ids.map(id => [id, [id]]));
    for (const link of model.links) {
      map.get(link.from)?.push(link.to);
      map.get(link.to)?.push(link.from);
    }
    return map;
  }, [model, scene.ids]);
  const root = scene.boxes[0];
  const rootId = scene.ids[0];
  const lead = rootId ? roleById.get(rootId)?.label ?? rootId : '主控';
  return <>
    {scene.boxes.map((box, index) => {
      const role = roleById.get(box.id);
      if (!role) return null;
      const status = cardStatus(model, role, userGate, dormant);
      return <TopologyCard key={box.id} role={role} box={box} root={index === 0} density={density} kind={status.kind} word={status.word}
        related={related.get(box.id) ?? [box.id]} dormant={dormant} handlers={seatHandlers(box.id)}
        counter={index === 0 && !dormant ? { completed: model.children.completed, total: model.children.total, id: 'map-lead-counter' } : undefined} />;
    })}
    {showYou && root ? <YouNode root={root} held={held} userGate={userGate} onGateNode={onGateNode} /> : null}
    {dormant && welcome ? <DormantCaption boxes={scene.boxes} ready={welcome.ready} lead={lead} unavailable={welcome.unavailable.map(item => (roleById.get(item.role)?.label ?? item.role) + ' 当前不可用（' + item.reason + '）')} /> : null}
  </>;
}

/** 你: a 28 px pill left of the lead, joined by a hairline that turns solid indigo while the run waits on the user. */
function YouNode({ root, held, userGate, onGateNode }: { root: Box; held: boolean; userGate: boolean; onGateNode(): void }) {
  const right = root.cx - root.w / 2;
  const left = Math.max(8, right - YOU_GAP - YOU_W);
  const style = { left: left + 'px', top: root.cy - 14 + 'px', width: right - left + 'px' } as CSSProperties;
  const face = <><i className="obs-you-av" aria-hidden="true">你</i><span>你</span></>;
  return <div className="obs-you" style={style} data-held={held || undefined} data-flip="you">
    {userGate
      ? <button type="button" className="obs-you-node btn-reset" aria-label="你 · 等你决定，前往关卡" onClick={onGateNode}>{face}</button>
      : <span className="obs-you-node" aria-label={held ? '你 · 等你回答' : '你'} role="img">{face}</span>}
    <i className="obs-you-line" aria-hidden="true"><i className="obs-you-packet" /></i>
  </div>;
}

/** Georgia 56 px ready count between the card bands (BUILD-SPEC-B §5.2, dormant welcome). */
function DormantCaption({ boxes, ready, lead, unavailable }: { boxes: Box[]; ready: number; lead: string; unavailable: string[] }) {
  // Prefer the lowest gap between card bands that fits the caption (between the seat rows, as in the B mock).
  const edges = boxes.map(box => [box.cy - box.h / 2, box.cy + box.h / 2]).sort((a, b) => a[0] - b[0]);
  const gaps: Array<{ gap: number; mid: number }> = [];
  let floor = edges[0]?.[1] ?? 0;
  for (const [top, bottom] of edges.slice(1)) {
    if (top > floor) gaps.push({ gap: top - floor, mid: (top + floor) / 2 });
    floor = Math.max(floor, bottom);
  }
  const best = gaps.filter(item => item.gap >= 150).at(-1) ?? gaps.reduce((a, b) => b.gap > a.gap ? b : a, { gap: 0, mid: floor + 90 });
  const center = boxes.length ? boxes.reduce((sum, box) => sum + box.cx, 0) / boxes.length : 0;
  return <div className="obs-dormant" style={{ left: center + 'px', top: best.mid + 'px' } as CSSProperties}>
    <b className="obs-dormant-num">{String(ready).padStart(2, '0')}</b>
    <span>个席位就绪</span>
    <hr aria-hidden="true" />
    <p>发送后由 {lead} 拆解任务并分派{unavailable.length ? ' · ' + unavailable.join('、') : ''}</p>
  </div>;
}
