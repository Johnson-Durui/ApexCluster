// Seat names, inks and status kinds shared by the thread, composer and deliverables.
import type { CSSProperties } from 'react';
import type { TaskStatus } from '../../../lib/chat-api';
import type { StatusKind } from '../../../components/ui';
import { seatInk, SEAT_INKS } from '../observatoryTheme';

const NAMES: Record<string, string> = {
  claude: 'Claude', astra: 'Astra', sol: 'Sol', grok: 'Grok', opus: 'Opus',
  carbon: 'Carbon', hydrogen: 'Hydrogen', deepseek: 'DeepSeek', mini: 'Mini',
};

/** Display name of a seat id; unknown seats keep their id (never a borrowed name). */
export function seatLabel(id: string | undefined): string {
  if (!id) return '协作工作台';
  return NAMES[id] ?? id;
}

/** Known seats get --ink-s from the [data-seat] rules in tokens.css; others set it inline. */
export function seatStyle(id: string | undefined): CSSProperties | undefined {
  if (!id || SEAT_INKS[id]) return undefined;
  return { '--ink-s': seatInk(id) } as CSSProperties;
}

/** Ink colour for inline use (the --speak variable on .chat-work). */
export function seatColor(id: string | undefined): string | undefined {
  return id ? seatInk(id) : undefined;
}

export const TASK_KIND: Record<TaskStatus, StatusKind> = {
  queued: 'queue', running: 'run', waiting_user: 'you', waiting_children: 'child',
  completed: 'ok', failed: 'err', cancelled: 'stop', interrupted: 'err',
};

export const TASK_WORD: Record<TaskStatus, string> = {
  queued: '排队中', running: '执行中', waiting_user: '等待你', waiting_children: '等待子任务',
  completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断',
};

export function SeatMark({ seat }: { seat: string | undefined }) {
  return <span className="seat-dot" data-seat={seat} style={seatStyle(seat)} aria-hidden="true" />;
}
