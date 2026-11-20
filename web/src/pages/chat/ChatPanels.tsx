// Chat panels shared by the thread (WP1) and the 协作详情 inspector (WP3). Exports, props and Chinese strings are pinned by
// ChatPanels.test.tsx; new props are optional. Styles live in panels.css, imported here so every consumer gets them.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentTask, ChatArtifact, ChatAttachment, ChatMessage, ChatRecord, ChatStream, ChatTodo, Invocation, ProjectExport, WaitTicket } from '../../lib/chat-api';
import { chatApi } from '../../lib/chat-api';
import { Icon, Modal } from '../../components/ui';
import { seatHandlers } from '../../components/seatFocus';
import { duration } from '../../lib/labels';
import type { ToolEvidence } from './chatModel';
import type { ArtifactListExtraProps, AttachmentListExtraProps, TaskTreeExtraProps } from './workspaceContracts';
import { seatLabel, seatStyle, TASK_WORD } from './thread/seats';
import './panels.css';

export { ActivityList } from './thread/TurnBlock';

const profileLabels: Record<NonNullable<AgentTask['profileId']>, string> = { general: '通用协作', document: '文档助手', spreadsheet: '表格助手', presentation: '演示文稿助手', research: '研究助手', image: '图像助手' };
const compactTokens = (value: number) => value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
const hoverOnly = (seat: string) => {
  const { onClick: _pin, ...handlers } = seatHandlers(seat);
  return handlers;
};

function TaskBranch({ task, tasks, invocations, fanoutGroups, clampGoals }: { task: AgentTask; tasks: AgentTask[]; invocations: Invocation[]; fanoutGroups: NonNullable<ChatRecord['fanoutGroups']>; clampGoals: boolean }) {
  const [open, setOpen] = useState(false);
  const children = tasks.filter(candidate => candidate.parentTaskId === task.id);
  const invocation = invocations.filter(item => item.taskId === task.id).at(-1);
  const fanouts = fanoutGroups.filter(group => group.parentTaskId === task.id);
  const long = clampGoals && task.goal.length > 60;
  return <li className="task-branch">
    <div className="task-row" {...hoverOnly(task.role)} style={seatStyle(task.role)}>
      <span className={`history-dot ${task.status}`} aria-hidden="true" />
      <span><b>{seatLabel(task.role)}{task.profileId && task.profileId !== 'general' ? ` · ${profileLabels[task.profileId]}` : ''}</b><small className={long && !open ? 'is-clamped' : undefined}>{task.goal}</small>{long ? <button type="button" className="btn-reset task-more" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起' : '展开全文'}</button> : null}<em>{TASK_WORD[task.status]} · 第 {task.segment} 段{invocation?.model ? ` · ${invocation.model}${invocation.effort ? ` / ${invocation.effort}` : ''}` : ''}</em>{invocation?.contextUsed !== null && invocation?.contextUsed !== undefined && invocation.contextHard ? <em>上下文 {compactTokens(invocation.contextUsed)} / {compactTokens(invocation.contextHard)}</em> : null}{fanouts.map(group => <em key={group.id}>并行任务 {tasks.filter(item => item.groupId === group.id && item.status === 'completed').length} / {group.total}</em>)}</span>
    </div>
    {children.length ? <ul>{children.map(child => <TaskBranch key={child.id} task={child} tasks={tasks} invocations={invocations} fanoutGroups={fanoutGroups} clampGoals={clampGoals} />)}</ul> : null}
  </li>;
}

export function TaskTree({ tasks, invocations = [], fanoutGroups = [], clampGoals = false }: { tasks: AgentTask[]; invocations?: Invocation[]; fanoutGroups?: NonNullable<ChatRecord['fanoutGroups']> } & TaskTreeExtraProps) {
  const roots = tasks.filter(task => !task.parentTaskId || !tasks.some(candidate => candidate.id === task.parentTaskId));
  return roots.length ? <ul className="task-tree">{roots.map(task => <TaskBranch key={task.id} task={task} tasks={tasks} invocations={invocations} fanoutGroups={fanoutGroups} clampGoals={clampGoals} />)}</ul> : <p className="muted">发送任务后显示协作进度。</p>;
}

const todoLabels: Record<ChatTodo['status'], string> = { pending: '待处理', in_progress: '进行中', completed: '已完成', failed: '失败' };
export function TodoList({ todos }: { todos: ChatTodo[] }) {
  return todos.length ? <ol className="todo-list">{todos.map(todo => <li key={todo.id} className={todo.status}>
    <span className="todo-state" aria-hidden="true" /><span><b>{todo.text}</b><small>{todoLabels[todo.status]}{todo.dependsOn?.length ? ` · ${todo.dependsOn.length} 项依赖` : ''}{todo.linkedTaskIds?.length ? ` · ${todo.linkedTaskIds.length} 个关联任务` : ''}{todo.evidenceRefs?.length ? ` · ${todo.evidenceRefs.length} 项证据` : ''}</small></span>
  </li>)}</ol> : <p className="muted">程序尚未生成任务计划。</p>;
}

const streamRoleLabels: Record<string, string> = { claude: 'Claude 主协作', astra: 'Astra 分析', sol: 'Sol 实现', grok: 'Grok 子任务' };

function StreamElapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = now - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? <span aria-hidden="true"> · 已用 {duration(Math.max(0, Math.floor(elapsed / 1000) * 1000))}</span> : null;
}

export function StreamList({ streams, scope = 'root', tasks, tools }: { streams: ChatStream[]; scope?: 'root' | 'subtask'; tasks?: AgentTask[]; tools?: ToolEvidence[] }) {
  const taskStreams = [...new Map(streams.map(stream => [stream.taskId, stream])).values()];
  return taskStreams.length ? <section className="agent-streams" aria-label="Agent 独立执行流">{taskStreams.map(stream => {
    const running = stream.status === 'running';
    const task = tasks?.find(task => task.id === stream.taskId);
    const text = task?.status === 'completed' ? task.result : undefined;
    const relatedTool = (tool: ToolEvidence) => tool.invocationId === stream.invocationId || (!tool.invocationId && tool.taskId === stream.taskId);
    const tool = tools?.findLast(tool => relatedTool(tool) && tool.status === 'running') ?? tools?.findLast(relatedTool);
    return <article key={stream.invocationId} className={`agent-stream role-${stream.role} status-${stream.status}`} data-seat={stream.role} style={seatStyle(stream.role)}>
      <header><b>{streamRoleLabels[stream.role] ?? `${seatLabel(stream.role)} 子任务`}</b><span>{running ? task?.status === 'waiting_user' ? '等待你的回答' : '正在处理' : stream.status === 'rotated' ? '已换段' : stream.status === 'exit_unknown' ? '退出状态未知' : scope === 'subtask' ? '子任务已结束 · 见任务结果' : '已结束，等待最终消息'}{running && task ? <StreamElapsed startedAt={task.createdAt} /> : null}</span></header>
      {text ? <div className="message-text">{text}</div> : null}
      {tool ? <p className={`stream-activity ${tool.status}`}><Icon name={tool.status === 'completed' ? 'check' : tool.status === 'failed' ? 'alert' : 'terminal'} size={15} /><span>{tool.name}{tool.status === 'failed' ? ' · 执行失败' : ''}</span></p> : running ? <p className="stream-activity"><Icon name="activity" size={15} /><span>{stream.role === 'grok' ? '正在整理完整结果…' : text ? '正在整理下一段内容…' : '正在整理回复…'}</span></p> : null}
    </article>;
  })}</section> : null;
}

export function QuestionCard({ ticket, busy, value, onChange, onAnswer, error }: {
  ticket: WaitTicket; busy: boolean; value: string; onChange: (value: string) => void; onAnswer: (value: string) => void; error?: string;
}) {
  return <section className="chat-question" aria-labelledby={`question-${ticket.id}`} aria-busy={busy || undefined}>
    <span className="eyebrow"><i aria-hidden="true">◆</i> 需要你的回答</span>
    <p id={`question-${ticket.id}`}>{ticket.question ?? '请补充信息后继续'}</p>
    {ticket.options?.length ? <div className="question-options">{ticket.options.map((option, index) => <button type="button" className="btn" key={option} data-first-option={index === 0 ? '' : undefined} disabled={busy} onClick={() => onAnswer(option)}>{option}</button>)}</div> : null}
    <label><span>{ticket.options?.length ? '或输入其他回答' : '回答'}</span><textarea value={value} onChange={event => onChange(event.target.value)} rows={3} data-first-option={ticket.options?.length ? undefined : ''} /></label>
    {error ? <p className="chat-error" role="alert">{error}</p> : null}
    <div className="question-actions"><button type="button" className="btn primary" disabled={busy || !value.trim()} onClick={() => onAnswer(value)}>{busy ? '提交中…' : '提交回答'}</button></div>
  </section>;
}

const textExtensions = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'log', 'diff', 'patch', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'sh', 'ps1']);
const extensionOf = (name: string) => name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
export function canPreviewArtifact(artifact: ChatArtifact): boolean {
  if (artifact.bytes > 512 * 1024) return false;
  if (artifact.kind === 'diff' || artifact.kind === 'test' || artifact.kind === 'report') return true;
  const extension = extensionOf(artifact.name);
  return !!extension && textExtensions.has(extension);
}

const TYPE_TILES: Record<string, string> = { md: 'MD', markdown: 'MD', zip: 'ZIP', txt: 'TXT', log: 'TXT', diff: 'DIFF', patch: 'DIFF', html: 'HTML', htm: 'HTML' };
/** Type tile text from the extension (MD / ZIP / TXT / DIFF / HTML …). */
export function typeTile(name: string, kind?: ChatArtifact['kind']): string {
  const extension = extensionOf(name);
  return TYPE_TILES[extension] ?? (extension ? extension.slice(0, 4).toUpperCase() : kind === 'diff' ? 'DIFF' : 'FILE');
}

function ProjectSaveStatus({ output, hidePath = false }: { output?: ProjectExport; hidePath?: boolean }) {
  if (!output || (hidePath && output.status === 'saved')) return null;
  return output.status === 'saved'
    ? <small className="project-save-path" title={output.path}>已保存到项目：{output.path}</small>
    : <small className="chat-error" role="alert">保存到项目失败：{output.error}。文件仍可下载。</small>;
}

const directoryOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');
/** The one project directory every item was saved into, when there are at least two and they all share it. */
function sharedDirectory(items: Array<{ projectExport?: ProjectExport }>): string | null {
  if (items.length < 2) return null;
  const dirs = new Set(items.map(item => item.projectExport?.status === 'saved' ? directoryOf(item.projectExport.path) : null));
  const [only] = dirs;
  return dirs.size === 1 && only ? only : null;
}

/**
 * Seat attribution from real fields only (§4.5): artifact.taskId → task.role, qualified by provenance.
 * Never a percentage, share or bar.
 */
export function SeatAttribution({ taskId, tasks, provenance }: { taskId?: string; tasks?: AgentTask[]; provenance?: ChatArtifact['provenance'] }) {
  if (!tasks) return null;
  const task = taskId ? tasks.find(item => item.id === taskId) : undefined;
  if (!task) return <span className="deliv-seat is-unknown">来源未记录</span>;
  const program = provenance === 'runner' || provenance === 'workspace';
  const profile = task.profileId && task.profileId !== 'general' ? ` · ${profileLabels[task.profileId]}` : '';
  return <span className="deliv-seat" {...hoverOnly(task.role)} style={seatStyle(task.role)}>
    <span className="seat-dot" aria-hidden="true" />{seatLabel(task.role)}{program ? ' 任务 · 程序生成' : profile}
  </span>;
}

/** Text preview of an artifact in a Modal; shared by the deliverable list and the gate card. */
export function useArtifactPreview(chatId: string) {
  const [preview, setPreview] = useState<{ id: string; name: string; text: string } | null>(null);
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement | null>(null);
  async function open(artifact: ChatArtifact, button: HTMLButtonElement) {
    trigger.current = button;
    setLoading(artifact.id); setError('');
    try {
      const response = await fetch(chatApi.artifactUrl(chatId, artifact.id));
      if (!response.ok) throw new Error(`预览请求失败（${response.status}）`);
      const text = await response.text();
      if (text.includes('\0')) throw new Error('该产物包含二进制内容，仅允许下载');
      setPreview({ id: artifact.id, name: artifact.name, text });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '产物预览失败'); }
    finally { setLoading(''); }
  }
  const dialog: ReactNode = preview ? <Modal title={`${preview.name} 预览`} size="lg" returnFocusTo={trigger.current} onClose={() => setPreview(null)}><div className="artifact-preview"><pre>{preview.text}</pre></div></Modal> : null;
  return { open, loading, error, dialog };
}

const provenanceText = (artifact: ChatArtifact) => artifact.provenance === 'workspace' ? '程序生成的源码差异' : artifact.provenance === 'runner' ? '受控测试记录' : artifact.kind === 'diff' ? '模型提供的差异文本' : artifact.kind === 'test' ? '测试资料' : artifact.kind === 'report' ? '报告' : '文件';
const kilobytes = (bytes: number) => `${Math.max(1, Math.ceil(bytes / 1024)).toLocaleString('zh-CN')} KB`;

export function ArtifactList({ chatId, artifacts, tasks }: { chatId: string; artifacts: ChatArtifact[] } & ArtifactListExtraProps) {
  const preview = useArtifactPreview(chatId);
  if (!artifacts.length) return <p className="muted">尚无产物。</p>;
  const shared = sharedDirectory(artifacts);
  return <div className="artifact-list">
    {artifacts.map(artifact => {
      const task = tasks?.find(item => item.id === artifact.taskId);
      return <article key={artifact.id} className={`deliv-card${task ? ' has-seat' : ''}`} data-seat={task?.role} style={seatStyle(task?.role)}>
        <span className="deliv-type mono" aria-hidden="true">{typeTile(artifact.name, artifact.kind)}</span>
        <div className="deliv-main"><b>{artifact.name}</b><small>{provenanceText(artifact)} · {kilobytes(artifact.bytes)}</small><SeatAttribution taskId={artifact.taskId} tasks={tasks} provenance={artifact.provenance} /><ProjectSaveStatus output={artifact.projectExport} hidePath={Boolean(shared)} /></div>
        <div className="artifact-actions">
          {canPreviewArtifact(artifact) ? <button type="button" className="btn sm" disabled={preview.loading === artifact.id} onClick={event => void preview.open(artifact, event.currentTarget)}>{preview.loading === artifact.id ? '读取中…' : '安全预览'}</button> : <span className="muted">仅下载</span>}
          <a className="btn sm" href={chatApi.artifactUrl(chatId, artifact.id)} download={artifact.name}><Icon name="download" size={13} />下载</a>
        </div>
      </article>;
    })}
    {shared ? <small className="project-save-path deliv-saved" title={shared}>已保存到项目：<code>{shared}</code></small> : null}
    {preview.error ? <p className="chat-error" role="alert">{preview.error}</p> : null}
    {preview.dialog}
  </div>;
}

function attachmentTextPreview(attachment: ChatAttachment) {
  return attachment.bytes <= 512 * 1024 && (attachment.mime.startsWith('text/') || /\.(md|txt|json|csv|xml|ya?ml|log)$/i.test(attachment.name));
}
export function attachmentsForMessage(attachments: ChatAttachment[], message: ChatMessage): ChatAttachment[] {
  if (!message.attachmentIds?.length) return [];
  const ids = new Set(message.attachmentIds);
  return attachments.filter(attachment => ids.has(attachment.id));
}
export function AttachmentList({ chatId, attachments, tasks }: { chatId: string; attachments: ChatAttachment[] } & AttachmentListExtraProps) {
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  async function open(attachment: ChatAttachment) {
    setLoading(attachment.id); setError('');
    try {
      const response = await fetch(chatApi.attachmentUrl(chatId, attachment.id, true));
      if (!response.ok) throw new Error(`预览请求失败（${response.status}）`);
      const text = await response.text();
      if (text.includes('\0')) throw new Error('预览包含二进制内容');
      setPreview({ name: attachment.name, text });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '附件预览失败'); }
    finally { setLoading(''); }
  }
  return <>{attachments.length ? <div className="attachment-list">{attachments.map(attachment => {
    const seat = attachment.source === 'generated' ? tasks?.find(item => item.id === attachment.taskId)?.role : undefined;
    return <article key={attachment.id} data-seat={seat} style={seatStyle(seat)} className={seat ? 'has-seat' : undefined}>
      <div className="attachment-meta"><b>{attachment.name}</b><small>{attachment.source === 'upload' ? '你上传的附件' : 'Agent 生成的附件'} · {Math.max(1, Math.ceil(attachment.bytes / 1024))} KB</small>{attachment.source === 'generated' ? <SeatAttribution taskId={attachment.taskId} tasks={tasks} /> : null}<ProjectSaveStatus output={attachment.projectExport} /></div>
      {attachment.mime.startsWith('image/') ? <img className="attachment-image" src={chatApi.attachmentUrl(chatId, attachment.id, true)} alt={`${attachment.name} 预览`} loading="lazy" /> : null}
      <div className="artifact-actions">{attachmentTextPreview(attachment) ? <button type="button" className="btn sm" disabled={loading === attachment.id} onClick={() => void open(attachment)}>{loading === attachment.id ? '读取中…' : '安全预览'}</button> : null}<a className="btn sm" href={chatApi.attachmentUrl(chatId, attachment.id)} download={attachment.name}>下载</a></div>
    </article>;
  })}</div> : <p className="muted">尚无附件。</p>}{error ? <p className="chat-error" role="alert">{error}</p> : null}{preview ? <Modal title={`${preview.name} 预览`} size="lg" onClose={() => setPreview(null)}><div className="artifact-preview"><pre>{preview.text}</pre></div></Modal> : null}</>;
}

const toolStateLabels: Record<ToolEvidence['status'], string> = { running: '执行中', completed: '已完成', failed: '执行失败' };
export function ToolEvidenceList({ tools }: { tools: ToolEvidence[] }) {
  return tools.length ? <ol className="tool-list">{tools.slice().reverse().map(tool => <li key={tool.id}>
    <span className={`tool-state ${tool.status}`} role="img" aria-label={toolStateLabels[tool.status]} />
    <span><b>{tool.name}</b>{tool.text ? <pre>{tool.text}</pre> : <small>{toolStateLabels[tool.status]}</small>}</span>
  </li>)}</ol> : <p className="muted">尚无工具调用证据。</p>;
}

export function ContextList({ chat }: { chat: ChatRecord }) {
  if (!chat.invocations.length) return <p className="muted">尚无模型调用。</p>;
  return <ul className="context-list">{chat.invocations.slice().reverse().map(invocation => {
    const hard = invocation.contextHard ?? invocation.contextWindow;
    const known = hard !== null && hard !== undefined && invocation.contextUsed !== null && hard > 0;
    const ratio = known ? Math.min(100, Math.round((invocation.contextUsed! / hard!) * 100)) : null;
    return <li key={invocation.id}><div><b>第 {invocation.segment} 段</b><small>{invocation.status === 'running' ? '调用中' : invocation.status === 'exited' ? '已结束' : '退出状态未确认'}</small></div>
      {invocation.model ? <span>{invocation.model}{invocation.effort ? ` · ${invocation.effort}` : ''}</span> : null}
      {known ? <><span>{invocation.contextUsed!.toLocaleString()} / {hard!.toLocaleString()} tokens 硬限制（{ratio}%）</span><progress value={invocation.contextUsed!} max={hard!} /></> : <span>上下文占用：未知</span>}
      {invocation.rotationReason ? <small>窗口交接：{invocation.rotationReason}</small> : null}
    </li>;
  })}</ul>;
}
