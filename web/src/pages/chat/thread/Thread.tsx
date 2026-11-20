// The thread (BUILD-SPEC-B §4.3): a grid of strip | band | notice | log | composer. The log is the record of the
// conversation: messages with their turn blocks, the progress summary, then question → deliverables →
// implementation error → gate card → blocked reason. Follow-latest has one owner (useFollowLatest).
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatRecord, WaitTicket } from '../../../lib/chat-api';
import { Icon, Status, Tag, type StatusKind } from '../../../components/ui';
import { activeTask, activityAnchors, isLiveOrigin, publicActivities, type ChatState } from '../chatModel';
import { ArtifactList, AttachmentList, attachmentsForMessage, QuestionCard, TaskTree, TodoList, ToolEvidenceList } from '../ChatPanels';
import type { Observatory } from '../observatoryModel';
import type { InspectorTab } from '../workspaceContracts';
import { MessageItem } from './AnswerCard';
import { ConnectionNotice } from './ConnectionNotice';
import { FollowPill } from './FollowPill';
import { SeatStrip } from './SeatStrip';
import { activityRows, TurnBlock } from './TurnBlock';
import { useFollowLatest } from './useFollowLatest';
import { seatLabel } from './seats';

export interface QuestionProps { ticket: WaitTicket; busy: boolean; value: string; error: string; onChange(value: string): void; onAnswer(value: string): void }

export interface ThreadProps {
  state: ChatState;
  chat: ChatRecord | null;
  model: Observatory | null;
  demo: boolean;
  loading: boolean;
  loadError: string;
  onRetryLoad(): void;
  notice: string;
  backfill: boolean;
  band: ReactNode;
  mapCollapsed: boolean;
  onExpandMap(): void;
  welcome: ReactNode;
  question: QuestionProps | null;
  gateCard: ReactNode;
  gate: 'A' | 'B' | null;
  onGate(): void;
  onOpenInspector(tab: InspectorTab): void;
  older: { available: boolean; loading: boolean; error: string; onLoad(keep: () => void): void };
  composer: ReactNode;
}

const FRESH_MS = 400;

/** article.chat-message + activity rows: the measure behind "N 条新内容" and the mini-rail unread count. */
export function threadItemCount(chat: ChatRecord | null, state: ChatState): number {
  if (!chat) return state.messages.length;
  const turns = new Set(state.messages.map(message => message.turnId).filter((id): id is string => Boolean(id)));
  let rows = 0;
  for (const turnId of turns) rows += activityRows(publicActivities(chat, state.activityTools, turnId)).length;
  return state.messages.length + rows;
}

function progressOf(chat: ChatRecord, ticket: boolean): { kind: StatusKind; label: string; count: string } {
  const canStop = chat.tasks.some(activeTask);
  const completed = chat.tasks.filter(task => task.status === 'completed').length;
  const root = chat.tasks.find(task => task.id === chat.turns.at(-1)?.rootTaskId) ?? chat.tasks.filter(task => !task.parentTaskId).at(-1);
  const outcome = !canStop ? root?.status : undefined;
  if (ticket) return { kind: 'you', label: '等待你的回答', count: `${completed} / ${chat.tasks.length}` };
  if (canStop) return { kind: 'run', label: '正在推进任务', count: `${completed} / ${chat.tasks.length}` };
  if (outcome === 'failed') return { kind: 'err', label: '任务执行失败', count: '查看过程' };
  if (outcome === 'interrupted') return { kind: 'err', label: '任务已中断', count: '查看过程' };
  if (outcome === 'cancelled') return { kind: 'stop', label: '任务已停止', count: '查看过程' };
  return { kind: 'ok', label: `${completed} / ${chat.tasks.length} 项任务已完成`, count: '查看过程' };
}

export function Thread(props: ThreadProps) {
  const { state, chat, model, loading } = props;
  const log = useRef<HTMLDivElement>(null);
  const firstSeen = useRef<Map<string, number> | null>(null);
  const [gateHidden, setGateHidden] = useState(false);
  const live = isLiveOrigin(state.origin);
  const count = threadItemCount(chat, state);
  const contentKey = JSON.stringify([state.messages.length, chat?.tasks.map(task => [task.id, task.status]), chat?.todos?.map(todo => [todo.id, todo.status]), state.activityTools.map(tool => [tool.id, tool.status]), chat?.tickets.map(ticket => [ticket.id, ticket.status]), chat?.artifacts.length, chat?.pipeline?.stage, loading]);
  const follow = useFollowLatest(log, count, contentKey);

  if (firstSeen.current === null && !loading) firstSeen.current = new Map(state.messages.map(message => [message.id, 0]));
  const now = Date.now();
  for (const message of state.messages) if (firstSeen.current && !firstSeen.current.has(message.id)) firstSeen.current.set(message.id, live ? now : 0);
  const fresh = (id: string) => { const at = firstSeen.current?.get(id) ?? 0; return at > 0 && now - at < FRESH_MS; };

  useEffect(() => {
    const area = log.current;
    const card = area?.querySelector('.gate-wrap');
    if (!area || !card || typeof IntersectionObserver === 'undefined') { setGateHidden(false); return; }
    const observer = new IntersectionObserver(([entry]) => setGateHidden(!entry.isIntersecting), { root: area, threshold: 0 });
    observer.observe(card);
    return () => observer.disconnect();
  }, [props.gate, Boolean(props.gateCard)]);

  const anchors = activityAnchors(state.messages);
  const tasksById = new Map(chat?.tasks.map(task => [task.id, task]) ?? []);
  const rootOf = (turnId?: string) => chat?.tasks.find(task => task.turnId === turnId && !task.parentTaskId);
  const progress = chat?.tasks.length ? progressOf(chat, Boolean(props.question)) : null;

  return <div className="thread" id="chat-thread">
    <SeatStrip model={chat ? model : null} mapCollapsed={props.mapCollapsed} onExpandMap={props.onExpandMap} />
    <div className="thread-band">{props.band}</div>
    <ConnectionNotice notice={props.notice} backfill={props.backfill} />
    <div className="chat-messages" role="log" aria-label="聊天记录" aria-live="polite" aria-relevant="additions" tabIndex={0} ref={log} onScroll={follow.onScroll}>
      <div className="conversation-column">
        {props.older.available ? <div className="load-older-row">
          <button type="button" className="btn sm load-older" onClick={() => props.older.onLoad(follow.keepPosition)} disabled={props.older.loading}>{props.older.loading ? '加载中…' : '加载更早 50 条消息'}</button>
          {props.older.error ? <span className="bad-text" role="alert">{props.older.error}</span> : null}
        </div> : null}
        {loading ? <div className="thread-skeleton" role="status"><span className="sr-only">正在从本机恢复聊天…</span><i /><i /><i /></div> : null}
        {props.loadError ? <section className="load-error" role="alert">
          <h2>聊天加载失败</h2><p>{props.loadError}</p>
          <button type="button" className="btn" onClick={props.onRetryLoad}><Icon name="refresh" size={14} />重试</button>
        </section> : null}
        {props.welcome}
        {state.messages.map(message => {
          const anchor = message.turnId ? anchors.get(message.turnId) : undefined;
          const root = rootOf(message.turnId);
          const lead = seatLabel(root?.role);
          const turnBlock = chat && message.turnId && anchor?.messageId === message.id && root
            ? <TurnBlock chat={chat} tools={state.activityTools} turnId={message.turnId} lead={lead} answered={state.messages.some(item => item.turnId === message.turnId && item.role === 'assistant')} /> : null;
          const seat = (message.taskId ? tasksById.get(message.taskId)?.role : undefined) ?? root?.role;
          const files = chat ? attachmentsForMessage(chat.attachments ?? [], message) : [];
          return <Fragment key={message.id}>
            {anchor?.before ? turnBlock : null}
            <MessageItem message={message} lead={seatLabel(seat)} seat={seat} demo={props.demo} fresh={fresh(message.id)}
              attachments={files.length && chat ? <AttachmentList chatId={chat.id} attachments={files} tasks={chat.tasks} /> : null} />
            {anchor?.before ? null : turnBlock}
          </Fragment>;
        })}
        {chat && progress ? <details className="chat-progress">
          <summary><Status kind={progress.kind}>{progress.label}</Status><span className="progress-count mono">{progress.count}</span><Icon name="chevron-down" size={13} /></summary>
          <TaskTree tasks={chat.tasks} invocations={chat.invocations} fanoutGroups={chat.fanoutGroups} />
          {chat.todos?.length ? <div className="inline-todos"><h3>程序计划</h3><TodoList todos={chat.todos} /></div> : null}
          {state.tools.length ? <details className="inline-tools"><summary>工具调用记录 · {state.tools.length}</summary><ToolEvidenceList tools={state.tools} /></details> : null}
          <button type="button" className="btn-reset progress-more" onClick={() => props.onOpenInspector('tasks')}>在协作详情中查看 →</button>
        </details> : null}
        {props.question ? <QuestionCard {...props.question} /> : null}
        {chat?.artifacts.length ? <section className="chat-delivery" aria-label="交付文件">
          <h2>交付文件 <span className="mono">{chat.artifacts.length}</span>{props.demo ? <Tag tone="mock">▷ 预设演示</Tag> : null}</h2>
          <ArtifactList chatId={chat.id} artifacts={chat.artifacts} tasks={chat.tasks} />
        </section> : null}
        {chat?.pipeline?.implementation?.error ? <p className="chat-error is-card" role="alert">{chat.pipeline.implementation.error}</p> : null}
        {props.gateCard}
        {chat?.blockedReason ? <p className="chat-error is-card blocked-reason" role="alert">{chat.blockedReason}</p> : null}
      </div>
    </div>
    <div className="thread-foot">
      <FollowPill unseen={follow.unseen} following={follow.following} gate={props.gate && gateHidden ? props.gate : null} onJump={follow.jump} onGate={props.onGate} />
      {props.composer}
    </div>
  </div>;
}
