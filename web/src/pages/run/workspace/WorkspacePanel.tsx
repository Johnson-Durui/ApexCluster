import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, EmptyState, Icon, Modal } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatDate, formatTime, phaseLabels, roleLabel, statusLabel, taskStatusTone } from '../../../lib/labels';
import type { RunPanelProps, TaskRecord } from '../../../lib/types';
import { artifactUrl, docDownloadUrl, type DeliverablesResponse } from '../deliverables/DeliveryPanel';
import { groupStages, taskActor, taskEntries, taskTitle } from '../live/liveModel';
import { gateTab, type RunTab } from '../tabs';
import { executionTools, latestAgentTasks, previewKind, readToolEvidence, type ToolEvidence } from './workspaceModel';
import './workspace.css';

type Detail = 'agents' | 'tools' | 'artifacts';
type Props = RunPanelProps & { onNavigate: (tab: RunTab) => void; onOpenGate: (tab: RunTab) => void };
const letters = { claude: 'C', astra: 'A', sol: 'S', grok: 'G' };
const duties = { claude: '架构方向 · 文档 · 终审', astra: '独立设计 · 评审与裁决', sol: '隔离构建 · 执行验收', grok: '来源摘要 · 问题分组' };

export default function WorkspacePanel({ run, progress, busy, act, onNavigate, onOpenGate }: Props) {
  const [detail, setDetail] = useState<Detail>('agents');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [data, setData] = useState<DeliverablesResponse | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [evidenceTask, setEvidenceTask] = useState<TaskRecord | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const stages = useMemo(() => groupStages(run.tasks), [run.tasks]);
  const agents = useMemo(() => latestAgentTasks(run.tasks), [run.tasks]);
  const tools = useMemo(() => executionTools(run, progress), [run.tasks, progress]);
  const snapshot = run.snapshots.find(item => item.version === run.currentSnapshotVersion) ?? run.snapshots.at(-1);
  const gate = gateTab(run);
  const gateName = gate === 'questions' ? '回答澄清问题' : gate === 'decision' ? '确认架构与构建范围' : gate === 'validation' ? '核对 MVP 验收结果' : run.phase === 'prd_gate' ? '确认产品需求文档' : '确认构建前文档';
  const active = run.tasks.filter(task => task.status === 'running' || task.status === 'queued');
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const initialContent = useRef(true);
  const [newContent, setNewContent] = useState(false);
  const progressCount = Object.values(progress).reduce((sum, entries) => sum + entries.length, 0);
  useEffect(() => {
    if (initialContent.current) { initialContent.current = false; return; }
    if (stick.current && list.current) list.current.scrollTop = list.current.scrollHeight;
    else setNewContent(true);
  }, [progressCount, stages.length, run.phaseStatus]);
  useEffect(() => {
    const controller = new AbortController();
    setFileLoading(true);
    api.get<DeliverablesResponse>(`/api/runs/${encodeURIComponent(run.id)}/deliverables`, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setData(value); setFileError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setFileError(cause instanceof Error ? cause.message : '产物读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setFileLoading(false); });
    return () => controller.abort();
  }, [run.id, run.updatedAt, revision]);
  const availableFiles = data?.jobs.flatMap(job => job.available ? job.files.map(file => ({ ...file, jobId: job.jobId })) : []) ?? [];
  const openDetail = (next: Detail, taskId?: string) => {
    setDetail(next); setDetailsOpen(true); setSelectedTask(taskId ?? null);
    if (window.innerWidth < 1100) requestAnimationFrame(() => document.getElementById('execution-details')?.scrollIntoView({ block: 'start', behavior: 'instant' }));
  };
  const side = <>
    <header className="execution-head"><div><span className="eyebrow">本次执行</span><h2>执行详情</h2></div><button className="ghost compact close-execution" type="button" aria-label="收起执行详情" onClick={() => setDetailsOpen(false)}><Icon name="x" /></button><Badge tone={active.length ? 'info' : ''}>{active.length ? `${active.length} 项进行中` : statusLabel(run.phaseStatus)}</Badge></header>
    <div className="execution-switch" role="group" aria-label="执行详情分类">{([['agents', '分工', agents.length], ['tools', '工具', tools.length || '—'], ['artifacts', '产物', availableFiles.length + run.docs.versions.length]] as const).map(([key, label, count]) => <button type="button" key={key} aria-pressed={detail === key} onClick={() => { setDetail(key); setSelectedTask(null); }}>{label}<span>{count}</span></button>)}</div>
    <div className="execution-content">
      {detail === 'agents' ? <>
        <div className="execution-root"><Icon name="layers" size={15} /><div><b>主任务</b><code>{run.id}</code></div></div>
        {agents.length ? <div className="agent-tree">{agents.map(task => <article key={task.id} className={`agent-node ${task.role}${selectedTask === task.id ? ' selected' : ''}`}>
          <div className="agent-node-head"><span className={`mtag ${task.role}`}>{letters[task.role]}</span><b>{roleLabel[task.role]}</b><Badge tone={taskStatusTone(task.status)}>{statusLabel(task.status)}</Badge></div>
          <p>{duties[task.role]}</p><small>{taskTitle(task, run)}</small>
          <details><summary>任务来源与配置</summary><dl className="kv"><dt>任务</dt><dd><code>{task.id}</code></dd><dt>阶段实例</dt><dd><code>{task.scope}</code></dd><dt>输入</dt><dd><code>{task.inputRef ?? '未记录'}</code></dd>{task.jobId ? <><dt>所属作业</dt><dd><code>{task.jobId}</code></dd></> : null}<dt>型号</dt><dd>{task.meta?.requestedModel ?? run.models[task.role]?.model ?? '未提供'}</dd>{task.attempt > 1 ? <><dt>重试来源</dt><dd><code>{task.rootTaskId}</code> · 第 {task.attempt} 次</dd></> : null}</dl></details>
          {task.failure ? <p className="agent-failure">{task.failure.message}</p> : null}
          <button type="button" className="compact ghost" onClick={() => openDetail('tools', task.id)}><Icon name="terminal" size={13} />查看执行证据<Icon name="arrow-right" size={13} /></button>
        </article>)}</div> : <EmptyState title="等待分配任务" icon="user"><p>实际启动的 Agent 将在这里出现。</p></EmptyState>}
        <p className="execution-note">角色按已有工作流协作；阶段与作业来源保留服务端标识。</p>
      </> : detail === 'tools' ? <>
        {selectedTask ? <div className="task-filter"><code>{selectedTask}</code><button type="button" className="ghost compact" aria-label="显示全部任务的工具" onClick={() => setSelectedTask(null)}><Icon name="x" size={13} /></button></div> : null}
        <p className="execution-note">工具摘要来自已收到的执行端进度。完整命令、退出码和输出在任务原始记录中。</p>
        <ol className="tool-timeline">{tools.filter(tool => !selectedTask || tool.task.id === selectedTask).map(tool => <li key={tool.id}><span className={`mtag ${tool.task.role}`}>{letters[tool.task.role]}</span><div><div className="tool-byline"><b>{taskActor(tool.task)}</b><time>{formatTime(tool.entry.at)}</time></div><p>{tool.entry.text}</p><button type="button" className="compact ghost" onClick={() => setEvidenceTask(tool.task)}>参数与执行结果<Icon name="chevron-right" size={12} /></button></div></li>)}</ol>
        {!tools.some(tool => !selectedTask || tool.task.id === selectedTask) ? <EmptyState title="尚无工具进度" icon="terminal"><p>历史可能未保留工具进度；可从下方选择任务查看完整记录。</p></EmptyState> : null}
        {run.tasks.length ? <label className="field"><span>查看任务原始记录</span><select value="" onChange={event => { const task = run.tasks.find(item => item.id === event.target.value); if (task) setEvidenceTask(task); }}><option value="" disabled>选择任务…</option>{run.tasks.map(task => <option key={task.id} value={task.id}>{taskActor(task)} · {taskTitle(task, run)} · {task.id}</option>)}</select></label> : null}
      </> : <>
        <div className="artifact-list-head"><p className="execution-note">文件存在与验收通过分别显示。</p><button type="button" className="ghost compact" aria-label="刷新产物" disabled={fileLoading} onClick={() => setRevision(value => value + 1)}><Icon name="refresh" size={14} /></button></div>
        {fileLoading && !data ? <p role="status">正在读取产物…</p> : null}
        {fileError ? <div className="alert bad" role="alert">{fileError}<button type="button" className="compact" onClick={() => setRevision(value => value + 1)}>重试读取</button></div> : null}
        {data?.jobs.filter(job => !job.available || job.incomplete).map(job => <div className="alert warn" key={job.jobId}><b>{job.jobId} · {job.available ? '扫描不完整' : '工作区不可用'}</b>{job.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>)}
        {availableFiles.slice(0, 60).map(file => <article key={`${file.jobId}-${file.path}`} className="workspace-artifact"><Icon name="file" size={20} /><div><b title={file.path}>{file.path}</b><small>{file.jobId} · {file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}</small><div className="row">{previewKind(file.path, file.size) ? <button type="button" className="ghost compact" onClick={() => setPreview({ name: file.path, url: artifactUrl(run.id, file.jobId, file.path) })}>预览</button> : null}<a className="button ghost compact" href={artifactUrl(run.id, file.jobId, file.path)} download><Icon name="download" size={12} />下载</a></div></div></article>)}
        {run.docs.versions.map(version => <article className="workspace-artifact" key={`${version.kind}-${version.version}`}><Icon name="file" size={20} /><div><b>{version.kind === 'handbook' ? '架构说明手册' : version.kind === 'devdoc' ? '开发文档' : '产品需求文档'} · v{version.version}</b><small>{version.status === 'approved' ? '已确认' : version.status === 'draft' ? '草稿' : '历史版本'}</small><a className="button ghost compact" href={docDownloadUrl(run.id, version.kind, version.version, 'md')} download><Icon name="download" size={12} />下载</a></div></article>)}
        {!fileLoading && !availableFiles.length && !run.docs.versions.length ? <EmptyState title="成果会保留在这里" icon="box"><p>任务完成后可预览、下载文件，已有成果也会在取消后保留。</p></EmptyState> : null}
        <button className="button workspace-all-delivery" type="button" onClick={() => onNavigate('deliverables')}>查看全部成果与验收状态<Icon name="arrow-right" size={14} /></button>
      </>}
    </div>
    <footer className="execution-footer"><Icon name="box" /><span>本次产物 <b>{availableFiles.length + run.docs.versions.length}</b></span><button type="button" className="ghost compact" onClick={() => setDetail('artifacts')}>查看<Icon name="arrow-right" size={13} /></button></footer>
  </>;

  return <div className="workspace-view">
    <section className="collaboration-main" aria-label="目标与协作记录">
      <header className="collaboration-heading"><div><h2>任务与协作</h2><span>{run.designResolution?.mode === 'dual' ? '双架构师独立设计' : run.designResolution?.mode === 'single' ? '单架构师 · 独立评审' : '按已确认工作流协作'}</span></div><button type="button" className="compact mobile-details" aria-expanded={detailsOpen} aria-controls="execution-details" onClick={() => detailsOpen ? setDetailsOpen(false) : openDetail(detail)}><Icon name="activity" size={14} />执行详情</button></header>
      <div className="collaboration-scroll" ref={list} tabIndex={0} onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; if (stick.current) setNewContent(false); }}>
        <article className="goal-message"><div className="message-byline"><span className="mtag you"><Icon name="user" size={14} /></span><b>你</b><time>{formatDate(run.createdAt)}</time><span>任务目标</span></div><p>{snapshot?.project.prompt ?? '此运行没有保存原始需求快照。'}</p>{snapshot?.project.coreFlows.length ? <ul>{snapshot.project.coreFlows.map(flow => <li key={flow}>{flow}</li>)}</ul> : null}{snapshot?.project.referenceDocuments?.length || snapshot?.project.referenceArchives?.length ? <button type="button" className="compact" onClick={() => window.dispatchEvent(new Event('workbench:open-snapshot'))}><Icon name="file" size={13} />参考资料 · {(snapshot?.project.referenceDocuments?.length ?? 0) + (snapshot?.project.referenceArchives?.length ?? 0)}</button> : null}</article>
        <div className="collaboration-divider"><span>协作记录</span><span>按实际阶段更新</span></div>
        {!stages.length ? <EmptyState title="正在准备协作" icon="activity"><p>后端接受任务后，分工和执行过程将在这里更新。</p></EmptyState> : stages.map(stage => <section className="collaboration-stage" key={stage.id}><header><span className="stage-line-dot" aria-hidden="true" /><h3>{stage.label}</h3><span>{stage.tasks.length > 1 ? `${stage.tasks.length} 位参与者` : '1 位参与者'}</span></header><p className="stage-description">{stage.description}</p>{stage.tasks.map(task => {
          const entries = taskEntries(task, progress);
          const messages = entries.filter(entry => entry.kind === 'message');
          const summary = task.phase === 'build' ? run.jobs.find(job => job.id === task.jobId)?.report?.summary : null;
          return <article key={task.id} className={`collaboration-message ${task.role}`}><div className="message-byline"><span className={`mtag ${task.role}`}>{letters[task.role]}</span><b>{taskActor(task)}</b><Badge tone={taskStatusTone(task.status)}>{statusLabel(task.status)}</Badge><time>{task.endedAt ? formatTime(task.endedAt) : task.startedAt ? formatTime(task.startedAt) : ''}</time></div>{task.simulated ? <Badge tone="mock">模拟数据</Badge> : null}{task.failure ? <div className="alert bad"><b>{statusLabel(task.status)}</b><p>{task.failure.message}</p></div> : <p className="collaboration-answer">{summary || messages.slice(-3).map(entry => entry.text).join('\n') || (task.status === 'succeeded' ? `已完成${taskTitle(task, run)}。输出结构：${statusLabel(task.outputValidity)}。` : task.lastProgress || '任务已进入执行队列，等待进度。')}</p>}{task.phase === 'propose' && run.proposals.some(proposal => proposal.taskId === task.id) ? <ul className="workspace-proposals">{run.proposals.filter(proposal => proposal.taskId === task.id).map(proposal => <li key={proposal.id}><button type="button" className="ghost compact" onClick={() => onNavigate('proposals')}><Icon name="file" size={14} />{proposal.title}<Icon name="arrow-right" size={12} /></button></li>)}</ul> : null}<footer><button type="button" className="ghost compact" onClick={() => openDetail('tools', task.id)}><Icon name="terminal" size={13} />执行证据</button>{['failed', 'cancelled', 'timed_out', 'interrupted'].includes(task.status) && !run.terminal ? <button type="button" className="compact" disabled={busy} onClick={() => void act(`/tasks/${task.id}/retry`)}><Icon name="refresh" size={13} />重试任务</button> : null}<button type="button" className="ghost compact" onClick={() => onNavigate('live')}>完整过程<Icon name="chevron-right" size={12} /></button></footer></article>;
        })}</section>)}
        {gate ? <div className="gate-wrap workspace-human-wrap"><section className="workspace-human decision-card" role="status"><div className="decision-in"><span className="human-icon"><Icon name="user" size={18} /></span><div><span className="eyebrow">需要你的决定</span><h3>{gateName}</h3><p>当前任务在这里等待。确认后由服务端继续下一步。</p><button type="button" className="gate outline" onClick={() => onOpenGate(gate)}>{gateName}<Icon name="arrow-right" size={14} /></button></div></div></section></div> : null}
        {run.terminal ? <section className={`workspace-outcome ${run.terminal === 'cancelled' ? 'cancelled' : ''}`}><Icon name={run.terminal === 'cancelled' ? 'stop' : 'check'} size={22} /><div><h3>{run.terminal === 'cancelled' ? '任务已取消' : '本次运行已结束'}</h3><p>{run.terminal === 'cancelled' ? '已有记录和产物仍可查看。迟发事件不会恢复运行。' : run.finalChoice?.candidateId ? `最终选择：${run.finalChoice.candidateId}。文件与真实验收结论可一起查看。` : '请在交付成果中查看已有文件与结论。'}</p><button type="button" className="compact" onClick={() => onNavigate('deliverables')}><Icon name="box" size={14} />查看交付成果</button></div></section> : null}
      </div>
      {newContent ? <button type="button" className="new-collaboration" onClick={() => { stick.current = true; list.current?.scrollTo({ top: list.current.scrollHeight }); setNewContent(false); }}>有新进度，回到最新<Icon name="chevron-down" size={13} /></button> : null}
      <footer className="collaboration-status"><span className={`status-mark ${active.length ? 'working' : ''}`} aria-hidden="true" /><span>{run.terminal === 'cancelled' ? '已取消 · 记录已保留' : gate ? '等待你的确认' : active.length ? `${active.length} 项任务正在执行` : phaseLabels[run.phase] ?? run.phase}</span><a href="#/new" className="button ghost compact"><Icon name="plus" size={13} />新建任务</a></footer>
    </section>
    <aside id="execution-details" className={`execution-sidebar${detailsOpen ? ' is-open' : ''}`} aria-label="执行详情">{side}</aside>
    {evidenceTask ? <ToolEvidenceModal runId={run.id} task={evidenceTask} onClose={() => setEvidenceTask(null)} /> : null}
    {preview ? <TextPreview name={preview.name} url={preview.url} onClose={() => setPreview(null)} /> : null}
  </div>;
}

function ToolEvidenceModal({ runId, task, onClose }: { runId: string; task: TaskRecord; onClose: () => void }) {
  const [files, setFiles] = useState<{ name: string; content: string }[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.get<{ name: string; content: string }[]>(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(task.id)}/files`, controller.signal).then(value => { if (!controller.signal.aborted) { setFiles(value); setError(''); } }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败'); });
    return () => controller.abort();
  }, [runId, task.id, revision]);
  let evidence: ToolEvidence[] = []; let evidenceError = '';
  const toolFile = files?.find(file => file.name === 'tool-log.json');
  if (toolFile) { try { evidence = readToolEvidence(toolFile.content); } catch (cause) { evidenceError = (cause as Error).message; } }
  return <Modal title={`${taskActor(task)} · 工具与执行记录`} onClose={onClose}><div className="row"><code>{task.id}</code><Badge tone={taskStatusTone(task.status)}>{statusLabel(task.status)}</Badge></div>{error ? <div className="alert bad" role="alert">{error}<button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div> : files === null ? <p className="loading" role="status">正在读取服务端记录…</p> : <>{evidenceError ? <div className="alert warn">{evidenceError}</div> : null}{evidence.length ? <ol className="tool-evidence-list">{evidence.map((item, index) => <li key={`${item.seq}-${index}`}><div className="row"><b>#{item.seq} · {item.type === 'command_execution' ? '命令执行' : item.type === 'file_change' ? '文件变更' : '工具事件'}</b><Badge tone={item.exitCode === null ? '' : item.exitCode === 0 ? 'ok' : 'bad'}>{item.exitCode === null ? item.status ?? '未提供结果状态' : `退出码 ${item.exitCode}`}</Badge></div><dl className="kv"><dt>命令 / 参数</dt><dd>{item.command ? <pre>{item.command}</pre> : '未提供'}</dd><dt>影响路径</dt><dd>{item.paths.length ? item.paths.join('\n') : '未提供'}</dd><dt>结果状态</dt><dd>{item.status ?? '未提供'}</dd></dl>{item.output !== null ? <details><summary>查看工具输出</summary><pre>{item.output || '（空输出）'}</pre></details> : <p className="help-note">工具输出：未提供</p>}</li>)}</ol> : <p className="help-note">此任务暂未提供完整工具参数与结果。现有进度摘要可以在执行过程中查看。</p>}{files.map(file => <details className="evidence-raw" key={file.name}><summary>{file.name}</summary><pre>{file.content}</pre></details>)}</>}</Modal>;
}

function TextPreview({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContent(null); setError('');
    fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`预览读取失败（${response.status}）`);
      const blob = await response.blob();
      if (blob.size > 512 * 1024) throw new Error('文件已超过 512 KB 预览限制，请下载查看。');
      return blob.text();
    }).then(value => { if (!controller.signal.aborted) setContent(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '预览失败'); });
    return () => controller.abort();
  }, [url, revision]);
  return <Modal title={name} onClose={onClose}><div className="preview-toolbar"><p className="help-note">安全文本预览 · 脚本和 HTML 作为源码显示</p><a className="button compact" href={url} download><Icon name="download" size={14} />下载文件</a></div>{error ? <div role="alert" className="alert bad">{error}<div className="btnbar"><button type="button" onClick={() => setRevision(value => value + 1)}>重试预览</button></div></div> : content === null ? <p className="loading" role="status">正在读取预览…</p> : <pre className="artifact-text-preview" tabIndex={0}>{content}</pre>}</Modal>;
}
