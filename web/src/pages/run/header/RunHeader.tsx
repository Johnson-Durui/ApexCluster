import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon, Modal } from '../../../components/ui';
import { ReferenceDocumentList } from '../../../components/ReferenceDocumentList';
import { formatDate, phaseLabels, statusLabel } from '../../../lib/labels';
import type { Run, RunPanelProps } from '../../../lib/types';
import { GatePips, GateTrack } from './GateTrack';
import { buildTrack, trackInputFromRun } from './trackModel';
import ModelStatusStrip from './ModelStatusStrip';
import './header.css';

import { OPEN_SNAPSHOT_EVENT } from '../tabs';

type Props = RunPanelProps & { onOpenLive?: () => void; onOpenDeliverables?: () => void };

/** Phase Status tag: glyph + word + colour (◆ indigo only while the run waits on you). */
function phaseTag(run: Run): { tone: string; glyph: string; text: string } {
  const phase = phaseLabels[run.phase] ?? run.phase;
  if (run.terminal === 'done') return { tone: 'ok', glyph: '✓', text: run.phase === 'done' ? '已结束' : `${phase} · 已结束` };
  if (run.terminal === 'cancelled') return { tone: 'stop', glyph: '■', text: `${phase} · 已取消` };
  if (run.phaseStatus === 'waiting_user') return { tone: 'you', glyph: '◆', text: `${phase} · 等你决定` };
  if (run.phaseStatus === 'blocked') return { tone: 'err', glyph: '⊘', text: `${phase} · ${statusLabel('blocked')}` };
  if (run.phaseStatus === 'running') return { tone: 'run', glyph: '▶', text: `${phase} · ${statusLabel('running')}` };
  return { tone: '', glyph: '', text: `${phase} · ${statusLabel(run.phaseStatus)}` };
}

export default function RunHeader({ run, busy, act, onOpenLive, onOpenDeliverables }: Props) {
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  const reasonId = useId();
  const cancelBack = useRef<HTMLButtonElement>(null);
  const overrideBack = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const open = () => setSnapshotOpen(true);
    window.addEventListener(OPEN_SNAPSHOT_EVENT, open);
    return () => window.removeEventListener(OPEN_SNAPSHOT_EVENT, open);
  }, []);
  const snapshot = run.snapshots.find(item => item.version === run.currentSnapshotVersion) ?? run.snapshots.at(-1);
  const items = useMemo(() => buildTrack(trackInputFromRun(run)), [run]);
  const mock = run.mode === 'mock';
  const tag = phaseTag(run);
  const reason = run.blockedReason || '某个当前阶段任务未能完成。';
  const blocked = run.phaseStatus === 'blocked';
  const reasonRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // 展开 shows only when the 3-line clamp actually hides text (measured; re-measured on resize, never polled).
  useLayoutEffect(() => {
    const element = reasonRef.current;
    if (!element || reasonOpen) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [reason, reasonOpen, blocked]);
  return <>
    <section className="run-head" aria-labelledby="run-title">
      <div className="run-head-top">
        <div className="run-title-main">
          <h1 id="run-title">{run.title}</h1>
          <div className="run-chips">
            <span className={`tag${mock ? ' mock' : ''}`}>{mock ? '模拟数据' : '真实运行'}</span>
            <span className={`tag phase${tag.tone ? ` is-${tag.tone}` : ''}`}>{tag.glyph ? <i aria-hidden="true">{tag.glyph}</i> : null}{tag.text}</span>
            <span className="mono">{run.id}</span>
            <span>更新于 {formatDate(run.updatedAt)}</span>
          </div>
        </div>
        <div className="run-head-actions">
          <button type="button" className="compact" onClick={() => setSnapshotOpen(true)} disabled={!snapshot}><Icon name="file" size={14} />快照 v{run.currentSnapshotVersion}</button>
          <a className="button compact" href={`/api/runs/${encodeURIComponent(run.id)}/export`} download={`decision-${run.id}.md`}><Icon name="download" size={14} />导出记录</a>
          <button type="button" className="compact" onClick={onOpenDeliverables}><Icon name="box" size={14} />交付成果</button>
          {!run.terminal ? <button type="button" className="danger compact" disabled={busy || cancelling} onClick={() => setConfirmCancel(true)}><Icon name="stop" size={14} />{cancelling ? '取消中…' : '取消运行'}</button> : null}
        </div>
      </div>
      <ModelStatusStrip run={run} onOpen={onOpenLive} />
      {mock ? <div className="legacy-mock" role="note"><b>模拟数据 · 开发验收或历史记录</b><span>该运行使用模拟模式，所有模型输出均为模拟数据，不代表真实模型的结果。</span></div> : null}
      <div className="run-progress">
        <div className="run-track"><GateTrack items={items} /></div>
        <div className="run-track-compact"><GatePips items={items} /></div>
      </div>
      {blocked ? <div className="blocked-bar" role="alert">
        <span className="blocked-glyph" aria-hidden="true">⊘</span>
        <div className="blocked-text">
          <strong>运行已阻塞</strong>
          <p id={reasonId} ref={reasonRef} className={reasonOpen ? undefined : 'is-clamped'}>{reason}</p>
          {overflowing || reasonOpen ? <button type="button" className="blocked-more" aria-expanded={reasonOpen} aria-controls={reasonId} onClick={() => setReasonOpen(value => !value)}>{reasonOpen ? '收起' : '展开'}</button> : null}
        </div>
        <div className="row">
          <button type="button" className="primary compact" disabled={busy} onClick={() => void act('/blocked', { action: 'retry_failed' })}><Icon name="refresh" size={14} />重试失败的任务</button>
          {run.phase === 'propose' && run.designResolution?.mode === 'single' && run.designResolution.architects.join() === 'claude' ? <button type="button" className="compact" disabled={busy} onClick={() => setOverrideOpen(true)}>明确改由 Astra 提案</button> : null}
          {run.phase !== 'adjudicate' ? <button type="button" className="compact" disabled={busy} onClick={() => void act('/blocked', { action: 'continue_single' })}>只用成功的一方继续</button> : null}
        </div>
      </div> : null}
      {run.degraded.length > 0 ? <div className="degraded-bar" role="status"><span aria-hidden="true">‖</span><span><strong>不完整 · 当前结果不代表双模型共识。</strong>{run.degraded.map(mark => mark.reason).join('；')}</span></div> : null}
    </section>
    {snapshotOpen && snapshot ? <Modal title={`需求快照 v${snapshot.version}`} size="lg" onClose={() => setSnapshotOpen(false)}>
      <div className="snapshot-meta"><span>引用：<code>{snapshot.ref}</code></span><span>原因：{snapshot.reason}</span><span>创建：{formatDate(snapshot.createdAt)}</span></div>
      <div className="snapshot-project"><h3>{snapshot.project.title}</h3><p>{snapshot.project.prompt}</p></div>
      <div className="snapshot-columns"><SnapshotList title="事实" items={snapshot.facts} empty="暂无事实" /><SnapshotList title="假设" items={snapshot.assumptions} empty="暂无假设" /><SnapshotList title="待确认" items={snapshot.openItems} empty="暂无待确认项" /></div>
      <h3>硬约束</h3>
      {snapshot.constraints.length ? <ul>{snapshot.constraints.map(item => <li key={item.id}><strong>{item.id} {item.kind === 'must' ? '必须' : '禁止'}</strong> · {item.text}</li>)}</ul> : <p className="muted">未设置硬约束</p>}
      <ReferenceDocumentList documents={snapshot.project.referenceDocuments} archives={snapshot.project.referenceArchives} />
    </Modal> : null}
    {confirmCancel ? <Modal title="确认取消运行" size="sm" initialFocus={cancelBack} onClose={() => setConfirmCancel(false)} footer={<>
      <button type="button" ref={cancelBack} disabled={cancelling} onClick={() => setConfirmCancel(false)}>返回</button>
      <button type="button" className="danger" disabled={busy || cancelling} onClick={async () => { setCancelling(true); try { if (await act('/cancel')) setConfirmCancel(false); } finally { setCancelling(false); } }}>{cancelling ? '取消中…' : '确认取消运行'}</button>
    </>}>
      <p>取消后会结束正在进行的模型任务及其进程树，运行无法继续，已有记录仍可查看和导出。</p>
      {cancelling ? <p role="status">正在请求停止，等待服务端确认…</p> : null}
    </Modal> : null}
    {overrideOpen ? <Modal title="明确更换架构师" size="sm" initialFocus={overrideBack} onClose={() => setOverrideOpen(false)} footer={<>
      <button type="button" ref={overrideBack} onClick={() => setOverrideOpen(false)}>返回</button>
      <button type="button" className="primary" disabled={busy || !overrideReason.trim()} onClick={() => { setOverrideOpen(false); void act('/blocked', { action: 'architect_override', reason: overrideReason.trim() }); }}>按此理由新开设计轮</button>
    </>}>
      <p>新建设计轮次，由 Astra 提案、Claude 评审；原失败记录保留，新方案标注为非主导者方案。这会新增模型调用。</p>
      <label className="field">更换理由<textarea value={overrideReason} onChange={event => setOverrideReason(event.target.value)} rows={3} maxLength={5000} /></label>
    </Modal> : null}
  </>;
}

function SnapshotList({ title, items, empty }: { title: string; items: { id: string; text: string; source: string }[]; empty: string }) {
  return <section><h3>{title}</h3>{items.length ? <ul>{items.map(item => <li key={item.id}><strong>{item.id}</strong> {item.text}<small>{item.source}</small></li>)}</ul> : <p className="muted">{empty}</p>}</section>;
}
