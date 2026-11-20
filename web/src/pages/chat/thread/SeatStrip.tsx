// Seat strip (BUILD-SPEC-B §4.3.1): the seats of the current turn, root first, then child seats in dispatch order.
// Chips are [data-seat] buttons: hover/focus → focus-one-seat, click → pin. aria-pressed mirrors the pin without a React
// render (a MutationObserver reads the attributes that the seat-focus store writes on `.chat-work`).
import { useEffect, useRef } from 'react';
import { seatHandlers } from '../../../components/seatFocus';
import { Icon, Status, STATUS_WORD, type StatusKind } from '../../../components/ui';
import type { Observatory } from '../observatoryModel';
import { seatLabel, seatStyle } from './seats';

type Role = Observatory['roles'][number];

export function seatKind(role: Role): StatusKind {
  if (role.state === 'active') return 'run';
  if (role.state === 'hold') return role.waitsOnUser ? 'you' : 'child';
  if (role.state === 'done') return 'ok';
  if (role.state === 'error') return 'err';
  if (role.state === 'stopped') return 'stop';
  return role.tasks.some(task => task.status === 'queued') ? 'queue' : 'idle';
}
const SEAT_WORDS: Partial<Record<StatusKind, string>> = { you: '等你回答', run: '运行中' };
export const seatWord = (kind: StatusKind) => SEAT_WORDS[kind] ?? STATUS_WORD[kind];

/** Seats with tasks in the current turn: the root first, then child seats in dispatch order. */
export function turnSeats(model: Observatory): Role[] {
  const first = (role: Role) => Math.min(...role.tasks.map(task => Date.parse(task.createdAt) || 0));
  return model.roles.filter(role => role.tasks.length)
    .sort((a, b) => (a.id === model.rootRole ? -1 : b.id === model.rootRole ? 1 : first(a) - first(b)));
}

export function SeatStrip({ model, mapCollapsed, onExpandMap }: { model: Observatory | null; mapCollapsed: boolean; onExpandMap(): void }) {
  const strip = useRef<HTMLDivElement>(null);
  const seats = model ? turnSeats(model) : [];
  const many = seats.length > 6;

  useEffect(() => {
    const work = strip.current?.closest<HTMLElement>('.chat-work');
    if (!work) return;
    const sync = () => {
      const pinned = work.dataset.pinned ? work.dataset.focusSeat : undefined;
      strip.current?.querySelectorAll<HTMLElement>('.seat-chip').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.seat === pinned)));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(work, { attributes: true, attributeFilter: ['data-pinned', 'data-focus-seat'] });
    return () => observer.disconnect();
  }, [seats.length]);

  return <div className={`seat-strip${many ? ' is-many' : ''}`} role="group" aria-label="本轮席位" ref={strip}>
    <small>本轮席位</small>
    {seats.length ? <div className="seat-chips">{seats.map(role => {
      const kind = seatKind(role);
      return <button key={role.id} type="button" className={`seat-chip btn-reset${kind === 'run' ? ' is-run' : ''}`} aria-pressed="false" style={seatStyle(role.id)} {...seatHandlers(role.id)}>
        <span className="seat-dot" aria-hidden="true" /><span className="chip-name">{seatLabel(role.id)}</span>
        <Status kind={kind} hideWord={many}>{seatWord(kind)}</Status>
        <span className="chip-line" aria-hidden="true" />
      </button>;
    })}</div> : <span className="strip-empty">发送后显示参与席位与派发进度</span>}
    {mapCollapsed ? <button type="button" className="btn ghost sm strip-expand" onClick={onExpandMap}><Icon name="panel-right" size={14} />展开任务地图</button> : null}
  </div>;
}
