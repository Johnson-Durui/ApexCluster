// Turn block (BUILD-SPEC-B §4.3.5): the lead's header, public plan notes and the 执行动态 table (dispatches and tool
// names only — never model-generated text), plus the real-state thinking placeholder. ActivityList is re-exported by
// ChatPanels, so its strings stay pinned by ChatPanels.test.tsx.
import { Fragment, memo, useState } from 'react';
import type { AgentTask, ChatRecord } from '../../../lib/chat-api';
import { Status, Tag, type StatusKind } from '../../../components/ui';
import { isFixedDemoId } from '../../../lib/fixed-demo';
import { activeTask, publicActivities, type PublicActivity, type ToolEvidence } from '../chatModel';
import type { ActivityListExtraProps } from '../workspaceContracts';
import { Elapsed } from './Elapsed';
import { SeatMark, seatLabel, seatStyle, TASK_KIND, TASK_WORD } from './seats';

const activityLabels: Record<PublicActivity['status'], string> = { ...TASK_WORD, pending: '等待开始', in_progress: '正在处理', running: '开始工作' };
const activityKinds: Record<PublicActivity['status'], StatusKind> = { ...TASK_KIND, pending: 'queue', in_progress: 'run', running: 'run' };
const planPrefix: Record<string, string> = { pending: '计划待处理：', in_progress: '正在处理：', completed: '已完成：' };
const TURN_WORDS: Record<AgentTask['status'], string> = { ...TASK_WORD, failed: '失败', interrupted: '已中断', cancelled: '已停止' };

const clock = (at: string) => {
  const time = Date.parse(at);
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
};

/** Rows of the 执行动态 table: dispatches and tool calls; plans are notes, not rows. */
export function activityRows(items: PublicActivity[]): PublicActivity[] {
  return items.filter(item => item.kind !== 'plan');
}

function ActivityRow({ item, lead }: { item: PublicActivity; lead: string }) {
  const [open, setOpen] = useState(false);
  const failed = item.status === 'failed' || item.status === 'interrupted';
  const word = item.kind === 'tool' && item.status === 'running' ? '正在调用' : activityLabels[item.status];
  return <tr className={`act kind-${item.kind}${failed ? ' is-failed' : ''}`} data-seat={item.role} style={seatStyle(item.role)}>
    <td className="act-time mono">{clock(item.at)}</td>
    <td className="act-who">{item.kind === 'agent' ? <><span className="act-lead">{lead}</span><span className="act-arrow" aria-hidden="true">→</span><span className="sr-only">派发给</span></> : null}<SeatMark seat={item.role} /><b>{seatLabel(item.role)}</b></td>
    <td className="act-goal"><button type="button" className={`btn-reset act-toggle${item.kind === 'tool' ? ' mono' : ''}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{item.text}</button></td>
    <td className="act-state"><Status kind={activityKinds[item.status]}>{word}</Status></td>
  </tr>;
}

export const ActivityList = memo(function ActivityList({ chat, tools, turnId, lead }: { chat: ChatRecord; tools: ToolEvidence[]; turnId: string } & ActivityListExtraProps) {
  const tasks = chat.tasks.filter(task => task.turnId === turnId);
  const root = tasks.find(task => !task.parentTaskId);
  if (!root) return null;
  const items = publicActivities(chat, tools, turnId);
  const rows = activityRows(items);
  const working = tasks.some(activeTask);
  // "Active" (§7): queued | running | waiting_children. A turn that only waits on the user does not tick.
  const ticking = tasks.some(task => task.status === 'queued' || task.status === 'running' || task.status === 'waiting_children');
  const demo = isFixedDemoId(chat.id);
  const turn = chat.turns.find(item => item.id === turnId);
  const leadName = lead ?? seatLabel(root.role);
  const kind: StatusKind = working ? (root.status === 'waiting_user' ? 'you' : root.status === 'waiting_children' ? 'child' : 'run') : TASK_KIND[root.status];
  return <div className="turn" data-seat={root.role} style={seatStyle(root.role)}>
    <header className="turn-head">
      <SeatMark seat={root.role} /><b>{leadName} · 主控</b>
      <Status kind={kind}>{working ? '正在处理任务' : TURN_WORDS[root.status]}</Status>
      {demo ? <Tag tone="mock">▷ 预设演示</Tag> : null}
      {!demo ? <Elapsed since={turn?.createdAt ?? root.createdAt} until={working ? undefined : turn?.completedAt ?? root.updatedAt} active={ticking} /> : null}
    </header>
    {items.filter(item => item.kind === 'plan').map(item => <p key={item.id} className={`turn-note status-${item.status}`}><em>{planPrefix[item.status] ?? '未完成：'}</em>{item.text}</p>)}
    <section className="conversation-activity" aria-label="执行动态">
      <header className="acts-head"><span>执行动态 · 只显示派发与工具名，不显示模型生成内容</span><span className="mono">{rows.length} 条</span></header>
      {rows.length ? <table className="acts">
        <colgroup><col className="c-time" /><col className="c-who" /><col /><col className="c-state" /></colgroup>
        <thead className="sr-only"><tr><th scope="col">时间</th><th scope="col">派发</th><th scope="col">目标</th><th scope="col">状态</th></tr></thead>
        <tbody>{rows.map(item => <ActivityRow key={item.id} item={item} lead={leadName} />)}</tbody>
      </table> : <p className="acts-empty">没有可显示的执行动态</p>}
    </section>
  </div>;
});

/** The thinking placeholder: only while the turn's root runs and the turn has no final message. Never timer-driven. */
export function ThinkingLine({ chat, turnId, lead }: { chat: ChatRecord; turnId: string; lead: string }) {
  const tasks = chat.tasks.filter(task => task.turnId === turnId);
  const root = tasks.find(task => !task.parentTaskId);
  if (!root) return null;
  if (root.status === 'running') {
    return <div className="thinking" role="status"><span>{lead} 正在处理</span><span className="dots" aria-hidden="true"><i /><i /><i /></span></div>;
  }
  if (root.status === 'waiting_children') {
    const seats = [...new Set(tasks.filter(task => task.parentTaskId && activeTask(task)).map(task => seatLabel(task.role)))];
    return <div className="thinking is-child" role="status"><Status kind="child">{seats.length ? `等待 ${seats.join('、')} 回传` : '等待子任务回传'}</Status></div>;
  }
  return null;
}

/** ActivityList plus the thinking line when the turn has no assistant message yet. */
export function TurnBlock({ chat, tools, turnId, lead, answered }: { chat: ChatRecord; tools: ToolEvidence[]; turnId: string; lead: string; answered: boolean }) {
  return <Fragment>
    <ActivityList chat={chat} tools={tools} turnId={turnId} lead={lead} />
    {answered ? null : <ThinkingLine chat={chat} turnId={turnId} lead={lead} />}
  </Fragment>;
}
