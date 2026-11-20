// Shell slots filled by the chat page (BUILD-SPEC-B §3.3, §3.4): the copyable id chip in the title, and the status-bar
// connection, page and usage cells. Counts are tasks of the current turn; 用时 ticks in a leaf only while active.
import { useEffect, useRef, useState } from 'react';
import { StatusCell, StatusCells, StatusConnection, StatusUsage } from '../../components/shell/ShellSlots';
import { CONN_WORDS, type ConnState } from '../../components/shell/TopBar';
import type { ChatRecord } from '../../lib/chat-api';
import type { Observatory } from './observatoryModel';
import { pipelineSummary } from './ObservatoryPanels';
import { Elapsed } from './thread/Elapsed';

const pad = (value: number) => String(value).padStart(2, '0');

export function IdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(id); } catch { return; }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }
  return <>
    <button type="button" className="id-chip mono" title={`复制会话编号 ${id}`} aria-label={`复制会话编号 ${id.slice(0, 8)}`} onClick={() => void copy()}>{id.slice(0, 8)}</button>
    <span className="id-copied" role="status">{copied ? '已复制' : ''}</span>
  </>;
}

/** Status-bar counts for the current turn (‖ waiting_children counts as 运行). */
export function turnCounts(model: Observatory) {
  const tasks = model.tasks;
  return {
    seats: model.roles.filter(role => role.tasks.length).length,
    running: tasks.filter(task => task.status === 'running' || task.status === 'waiting_children').length,
    waiting: tasks.length || model.pipeline.gate ? pipelineSummary(model).waiting : 0,
    completed: tasks.filter(task => task.status === 'completed').length,
    all: tasks.length,
  };
}

export function ChatStatusSlots({ chat, model, fresh, fixedDemo, connection, active }: {
  chat: ChatRecord | null;
  model: Observatory;
  fresh: boolean;
  fixedDemo: boolean;
  connection: ConnState | null;
  active: boolean;
}) {
  const counts = turnCounts(model);
  const usage = chat?.apiUsage;
  const turn = chat?.turns.find(item => item.id === model.turnId);
  const waitsOnYou = Boolean(model.pipeline.gate && model.pipeline.gateMode === 'user') || model.waitingForUser;
  const ready = model.roles.filter(role => role.available).length;
  const words = connection ? CONN_WORDS[connection] : null;
  return <>
    {words ? <StatusConnection><span className={`sb-reach is-${connection}`}><i aria-hidden="true">{words.glyph}</i>{words.word}</span></StatusConnection> : null}
    <StatusCells>
      {chat ? <StatusCell tone={counts.waiting > 0 ? 'gate' : undefined}>席位 {pad(counts.seats)} · 任务 运行 {pad(counts.running)} · 等你 {pad(counts.waiting)} · 完成 {pad(counts.completed)}/{pad(counts.all)}</StatusCell>
        : fresh ? <StatusCell>席位 {pad(ready)} 就绪 · 运行 00 · 等你 00</StatusCell> : null}
    </StatusCells>
    <StatusUsage>
      {fixedDemo ? <StatusCell>预设演示 · 不计费</StatusCell> : <>
        <StatusCell wide>Token {usage ? usage.tokens.toLocaleString('zh-CN') : '—'}</StatusCell>
        <StatusCell><span className="sb-usage-label">费用估算 </span>{usage ? `$${usage.usd.toFixed(4)}` : '—'}</StatusCell>
        {usage?.unpriced ? <StatusCell wide>未计价 {usage.unpriced}</StatusCell> : null}
        <StatusCell>{turn ? <Elapsed since={turn.createdAt} until={turn.completedAt ?? (active || waitsOnYou ? undefined : chat?.updatedAt)} active={active} prefix={waitsOnYou && !active ? '已用 ' : '用时 '} suffix={waitsOnYou && !active ? ' · 等你' : ''} /> : '用时 —'}</StatusCell>
      </>}
    </StatusUsage>
  </>;
}
