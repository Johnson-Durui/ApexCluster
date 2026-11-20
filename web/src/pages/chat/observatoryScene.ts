// Which seats the topology and context views show, and in which slots. Pure; positions are % of the stage.
import { orderByBarycenter, type Row } from './observatoryLayout';
import type { Observatory } from './observatoryModel';

type Role = Observatory['roles'][number];

export interface ContextUsage { used?: number | null; hard?: number | null; fraction: number | null; rotation?: string }

/** Context-window usage of a seat's latest invocation; null fraction means unknown, never 0%. */
export function contextUsage(role: Role): ContextUsage {
  const invocation = role.latestInvocation;
  const hard = invocation?.contextHard ?? invocation?.contextWindow;
  const used = invocation?.contextUsed;
  const known = hard != null && hard > 0 && used != null && used >= 0;
  return { used, hard, fraction: known ? Math.round(used / hard * 100) : null, rotation: invocation?.rotationReason };
}

/** The validated selection: a seat id that still exists in the model, or undefined. */
export function selectedSeat(model: Observatory, seat: string | undefined) {
  return seat && model.roles.some(role => role.id === seat) ? seat : undefined;
}

/** Root on top, then up to eleven seats in two staggered rows, ordered to cut crossings. A selected seat is always shown. */
export function topologySlots(model: Observatory, focused: string | undefined) {
  const { roles, rootRole } = model;
  const root = roles.find(role => role.id === rootRole) ?? roles[0];
  if (!root) return [];
  const direct = new Set(model.links.filter(link => link.from === root.id).map(link => link.to));
  const others = roles.filter(role => role.id !== root.id).sort((a, b) =>
    Number(Boolean(b.tasks.length)) - Number(Boolean(a.tasks.length)) || Number(direct.has(b.id)) - Number(direct.has(a.id)));
  const visible = others.slice(0, 11).map(role => role.id);
  const selected = selectedSeat(model, focused);
  if (selected && selected !== root.id && !visible.includes(selected) && visible.length) visible[visible.length - 1] = selected;
  const remaining = visible.length;
  const upperCount = remaining > 5 ? Math.min(5, Math.max(3, Math.ceil(remaining / 2))) : 0;
  const rowX = (index: number, total: number, margin: number) => total <= 1 ? 50 : margin + (100 - 2 * margin) * index / (total - 1);
  const lowerCount = remaining - upperCount;
  const upper: Row = { ids: visible.slice(0, upperCount), xs: [], ys: [] };
  const lower: Row = { ids: visible.slice(upperCount), xs: [], ys: [] };
  for (let index = 0; index < upperCount; index++) { upper.xs.push(rowX(index, upperCount, 19)); upper.ys.push(52 + (index + 1) % 2 * 4); }
  for (let index = 0; index < lowerCount; index++) {
    lower.xs.push(rowX(index, lowerCount, remaining <= 2 ? 24 : 10));
    lower.ys.push(upperCount ? 86 - index % 2 * 4 : 77 - index % 2 * 7);
  }
  const ordered = orderByBarycenter({ id: root.id, x: 50, y: 23 }, upper, lower, model.links.map(link => [link.from, link.to]));
  return [
    { id: root.id, x: 50, y: 23 },
    ...ordered.upper.map((id, index) => ({ id, x: upper.xs[index], y: upper.ys[index] })),
    ...ordered.lower.map((id, index) => ({ id, x: lower.xs[index], y: lower.ys[index] })),
  ];
}

const ORBIT_SEATS = 5;

/**
 * Root plus the five most informative other seats for the context orbit: reported usage first, then live work,
 * then the fullest windows. A selected seat always gets a slot. Seats already on the orbit keep their slot
 * (`previous`), so one seat entering or leaving moves one card, not all of them.
 */
export function contextIds(model: Observatory, focused: string | undefined, previous: string[] = []) {
  const root = model.roles.find(role => role.id === model.rootRole) ?? model.roles[0];
  if (!root) return [];
  const others = model.roles.filter(role => role.id !== root.id);
  const rank = (role: Role) => [
    contextUsage(role).fraction != null ? 1 : 0,
    role.latestInvocation ? 1 : 0,
    role.state === 'active' || role.state === 'hold' ? 1 : 0,
    contextUsage(role).fraction ?? -1,
    role.tasks.length ? 1 : 0,
  ];
  const ranked = [...others].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return right[index] - left[index];
    return 0;
  });
  const top = ranked.slice(0, ORBIT_SEATS);
  const picked = new Set(top.map(role => role.id));
  const selected = selectedSeat(model, focused);
  let swap: [out: string, into: string] | undefined;
  if (selected && selected !== root.id && !picked.has(selected) && top.length) swap = [top.at(-1)!.id, selected];
  if (swap) { picked.delete(swap[0]); picked.add(swap[1]); }
  // Keep previous slots for seats that stay; newcomers fill the freed slots in roster order.
  const slots: Array<string | undefined> = previous.slice(1, ORBIT_SEATS + 1).map(id => picked.has(id) ? id : undefined);
  const placed = new Set(slots.filter(Boolean));
  if (swap) {
    const freed = previous.indexOf(swap[0]) - 1;
    if (freed >= 0 && freed < slots.length && !slots[freed] && !placed.has(swap[1])) { slots[freed] = swap[1]; placed.add(swap[1]); }
  }
  for (const role of others) {
    if (!picked.has(role.id) || placed.has(role.id)) continue;
    const free = slots.findIndex(slot => !slot);
    if (free >= 0) slots[free] = role.id;
    else slots.push(role.id);
    placed.add(role.id);
  }
  return [root.id, ...slots.filter((slot): slot is string => Boolean(slot))];
}
