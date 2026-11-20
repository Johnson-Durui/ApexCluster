import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../../lib/api';
import { duration, formatDate, formatTime, progressKindLabels, statusLabel, taskStatusTone, validityTone } from '../../../lib/labels';
import { useNow } from '../../../lib/useNow';
import { Badge, EmptyState, Icon, Modal } from '../../../components/ui';
import type { ProgressEntry, Run, RunPanelProps, TaskRecord } from '../../../lib/types';
import { elapsedMs } from '../header/ModelStatusStrip';
import { groupStages, liveMetrics, requestedSettings, stageWindow, taskActor, taskEntries, taskTitle, waitingText, type LiveStage } from './liveModel';
import './live.css';

type RawFile = { name: string; content: string };
const letters = { claude: 'C', astra: 'A', sol: 'S', grok: 'G' } as const;
const sourceLabels: Record<string, string> = { server_usage: '服务端用量', cli_config: 'CLI 配置摘要', init_event: '初始化事件' };
export const failureLabels: Record<string, string> = {
  not_installed: '未安装执行工具', not_logged_in: '执行工具未登录', auth_failed: '身份验证失败',
  model_unavailable: '请求的型号不可用', effort_unsupported: '请求的强度不受支持', model_mismatch: '执行端报告的型号不符',
  rate_limited: '额度或频率受限', refusal: '模型拒绝了请求', timeout: '任务超时', cancelled: '任务已取消',
  invalid_output: '输出结构不合法', snapshot_mismatch: '需求快照版本不匹配', process_error: '执行进程失败', unknown: '未知错误',
};
const phaseHint: Record<string, string> = {
  intake: '运行刚创建，正在准备第一批任务。',
  clarify: '澄清任务即将启动。',
};

/** “执行过程”：按阶段展示每个模型任务的实时进度，宽屏下并排占满主区域。 */
export default function LivePanel({ run, busy, progress, act }: RunPanelProps) {
  const stages = useMemo(() => groupStages(run.tasks), [run.tasks]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const latest = stages.at(-1);
  const stage = stages.find(item => item.id === selectedId) ?? latest;
  const now = useNow(run.tasks.some(task => task.status === 'running'));
  const [files, setFiles] = useState<{ task: TaskRecord; items: RawFile[] } | null>(null);
  const [selectedFile, setSelectedFile] = useState('');
  const [fileError, setFileError] = useState('');
  const openFiles = async (task: TaskRecord) => {
    setFileError('');
    try { const items = await api.get<RawFile[]>(`/api/runs/${run.id}/tasks/${task.id}/files`); setFiles({ task, items }); setSelectedFile(items[0]?.name ?? ''); }
    catch (e) { setFileError(e instanceof Error ? e.message : '读取原始文件失败'); }
  };

  if (!stage || !latest) return <div className="live live-empty"><EmptyState title="还没有模型任务" icon="activity"><p>{phaseHint[run.phase] ?? '当前阶段没有需要模型执行的任务。'}</p></EmptyState></div>;
  const stageTime = stageWindow(stage, now);
  const counts = { running: stage.tasks.filter(task => task.status === 'running' || task.status === 'queued').length, done: stage.tasks.filter(task => task.status === 'succeeded').length, failed: stage.tasks.filter(task => ['failed', 'timed_out', 'interrupted', 'cancelled'].includes(task.status)).length };
  const columns = Math.min(stage.tasks.length, 3);
  return <div className="live">
    <header className="live-head">
      <div className="live-title">
        <div className="eyebrow">执行过程{stage.id === latest.id ? ' · 当前阶段' : ' · 历史阶段'}</div>
        <h2 title={stage.description}>{stage.label}</h2>
        <p>{stage.description}</p>
      </div>
      {stages.length > 1 ? <div className="live-stages" role="group" aria-label="选择执行阶段">
        {stages.map(item => <StageButton key={item.id} stage={item} active={item.id === stage.id} latest={item.id === latest.id} onSelect={() => setSelectedId(item.id === latest.id ? null : item.id)} />)}
      </div> : null}
      <dl className="live-stats">
        <div><dt>任务</dt><dd className="num">{stage.tasks.length}</dd></div>
        <div><dt>进行中</dt><dd className="num">{counts.running}</dd></div>
        <div><dt>已完成</dt><dd className="num">{counts.done}</dd></div>
        <div><dt>未完成</dt><dd className={`num${counts.failed ? ' bad' : ''}`}>{counts.failed}</dd></div>
        <div><dt>阶段用时</dt><dd className="num">{stageTime.elapsedMs !== null ? duration(stageTime.elapsedMs) : '—'}</dd></div>
      </dl>
    </header>
    {selectedId && selectedId !== latest.id ? <div className="live-notice" role="status"><span>正在查看历史阶段。当前阶段是“{latest.label}”。</span><button type="button" className="compact" onClick={() => setSelectedId(null)}>回到当前阶段</button></div> : null}
    {fileError ? <div className="alert bad" role="alert">{fileError}</div> : null}
    <div className="live-grid" style={{ '--cols': columns } as CSSProperties}>
      {stage.tasks.map(task => <TaskPane key={task.id} run={run} task={task} entries={taskEntries(task, progress)} now={now} busy={busy} act={act} onFiles={openFiles} />)}
    </div>
    {files ? <Modal title={`${taskActor(files.task)} 原始文件 · ${files.task.id}`} onClose={() => setFiles(null)}>{files.items.length ? <div className="raw-viewer"><div className="raw-tabs" aria-label="选择原始文件">{files.items.map(file => <button type="button" key={file.name} className={selectedFile === file.name ? 'active' : ''} aria-pressed={selectedFile === file.name} onClick={() => setSelectedFile(file.name)}>{file.name}</button>)}</div><pre aria-label={selectedFile}>{files.items.find(file => file.name === selectedFile)?.content ?? ''}</pre></div> : <EmptyState title="这个任务还没有原始文件" icon="file" />}</Modal> : null}
  </div>;
}

function StageButton({ stage, active, latest, onSelect }: { stage: LiveStage; active: boolean; latest: boolean; onSelect: () => void }) {
  const running = stage.tasks.some(task => task.status === 'running' || task.status === 'queued');
  const failed = stage.tasks.some(task => ['failed', 'timed_out', 'interrupted'].includes(task.status));
  const state = running ? 'running' : failed ? 'failed' : stage.tasks.every(task => task.status === 'succeeded') ? 'done' : 'mixed';
  return <button type="button" className={`stage-btn ${state}${active ? ' active' : ''}`} aria-pressed={active} onClick={onSelect}>
    <span className="stage-dot" aria-hidden="true" />{stage.label}{latest ? <span className="sr-only">（当前阶段）</span> : null}
  </button>;
}

function TaskPane({ run, task, entries, now, busy, act, onFiles }: { run: Run; task: TaskRecord; entries: ProgressEntry[]; now: number; busy: boolean; act: RunPanelProps['act']; onFiles: (task: TaskRecord) => void }) {
  const logRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const element = logRef.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [entries.length]);
  const metrics = liveMetrics(entries);
  const { model, effort } = requestedSettings(task, run);
  const meta = task.meta;
  const elapsed = elapsedMs(task, now);
  const ultra = task.phase === 'adjudicate';
  const actor = taskActor(task);
  const retryable = ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(task.status);
  const cancellable = task.status === 'queued' || task.status === 'running';
  const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(task.status);
  const mismatch = task.failure?.kind === 'model_mismatch' && !task.acceptedDespiteMismatch;
  const job = task.phase === 'build' ? run.jobs.find(item => item.id === task.jobId) : undefined;
  return <article className={`live-pane ${task.role} ${task.status}`} aria-label={`${actor} · ${taskTitle(task, run)}`}>
    {task.status === 'running' ? <span className="lp-progress" aria-hidden="true" /> : null}
    <header className="lp-head">
      <span className={`mtag ${task.role}${ultra ? ' ultra' : ''}`}>{letters[task.role]}</span>
      <div className="lp-title"><b>{actor}</b><small>{taskTitle(task, run)}{task.attempt > 1 ? ` · 第 ${task.attempt} 次尝试` : ''}</small></div>
      <div className="lp-badges">
        {ultra ? <Badge tone="astra">Ultra 裁决</Badge> : null}
        <Badge tone={taskStatusTone(task.status)}>{statusLabel(task.status)}</Badge>
        <Badge tone={validityTone(task.outputValidity)}>{statusLabel(task.outputValidity)}</Badge>
        {task.simulated ? <Badge tone="mock">模拟</Badge> : null}
      </div>
    </header>
    <dl className="lp-metrics">
      <div><dt>用时</dt><dd className="num">{elapsed !== null ? duration(elapsed) : '—'}</dd></div>
      <div><dt>工具调用</dt><dd className="num">{metrics.tools}</dd></div>
      <div><dt>接口重试</dt><dd className={`num${metrics.retries ? ' warn' : ''}`}>{metrics.retries}</dd></div>
      <div><dt>推理 tokens（估计）</dt><dd className="num">{metrics.tokens !== null ? metrics.tokens.toLocaleString('zh-CN') : '—'}</dd></div>
      <div className="wide"><dt>请求型号 · 强度</dt><dd className="mono">{model} · {effort}</dd></div>
      <div className="wide"><dt>执行端型号</dt><dd>{meta?.modelConfirmed ? meta.reportedModels.join(', ') : '未确认'}{meta?.reportedModelSource ? <small> · {sourceLabels[meta.reportedModelSource] ?? meta.reportedModelSource}</small> : null}</dd></div>
    </dl>
    {task.failure ? <div className="lp-failure" role="alert"><strong>{failureLabels[task.failure.kind] ?? '任务失败'} <code>{task.failure.kind}</code></strong><p>{task.failure.message}</p></div> : null}
    {job ? <details className="lp-spec"><summary>本作业的验收项（{job.spec.acceptance.length}）</summary><ul>{job.spec.acceptance.map(item => <li key={item.id}><b>{item.id}</b> {item.description}{item.kind === 'command' && item.command ? <code>{item.command}</code> : <span className="muted">（人工）</span>}</li>)}</ul></details> : null}
    <div className="lp-log-head"><span>实时日志</span><span className="muted">{metrics.events} 条事件{task.lastProgressAt ? ` · 最近 ${formatDate(task.lastProgressAt)}` : ''}</span></div>
    <ol className="lp-log" ref={logRef} onScroll={event => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }} aria-label={`${actor} 实时日志`} tabIndex={0}>
      {entries.length ? entries.map((entry, index) => <li key={`${entry.at}-${index}`} className={`k-${entry.kind ?? 'info'}`}><time dateTime={entry.at}>{formatTime(entry.at)}</time><span className="lp-kind">{progressKindLabels[entry.kind ?? 'info'] ?? entry.kind}</span><span className="lp-text">{entry.text}</span></li>) : <li className="lp-empty">{waitingText(task)}</li>}
    </ol>
    <footer className="lp-foot">
      <span className="mono muted" title="本任务读取的输入版本">{task.inputRef ?? '—'}</span>
      <div className="row">
        {cancellable ? <button type="button" className="compact" disabled={busy} onClick={() => void act(`/tasks/${task.id}/cancel`)}><Icon name="stop" size={14} />取消任务</button> : null}
        {retryable ? <button type="button" className="compact" disabled={busy} onClick={() => void act(`/tasks/${task.id}/retry`)}><Icon name="refresh" size={14} />重试</button> : null}
        {terminal ? <button type="button" className="compact" onClick={() => void onFiles(task)}><Icon name="file" size={14} />原始文件</button> : null}
        {mismatch ? <button type="button" className="compact danger" disabled={busy} onClick={() => void act(`/tasks/${task.id}/accept-mismatch`)}>接受型号不符</button> : null}
      </div>
    </footer>
  </article>;
}
