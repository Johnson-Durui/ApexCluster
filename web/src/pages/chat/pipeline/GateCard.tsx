// Gate card (BUILD-SPEC-B §4.4, graft A): the chamfered, indigo-ruled decision card in the thread. The chamfer comes
// only from the shared `.decision-card` in styles/base.css. Honest lock: the card stays busy until the server responds;
// errors stay inside the card. No progress bar, no waiting-since time, no undo.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatRecord, PipelineGateAction, PipelineGateId } from '../../../lib/chat-api';
import type { Observatory } from '../observatoryModel';
import { canPreviewArtifact, useArtifactPreview } from '../ChatPanels';

type Decision = PipelineGateAction['decision'];
export type GatePhase =
  | { phase: 'idle' }
  | { phase: 'busy'; decision: Decision }
  | { phase: 'pending'; decision: Decision }
  | { phase: 'error'; kind: 'conflict' | 'network'; message: string };

const STAGE_INDEX: Record<PipelineGateId, number> = { A: 2, B: 5 };

export function GateCard({ chat, model, state, onDecide, onRetry }: {
  chat: ChatRecord;
  model: Observatory;
  state: GatePhase;
  onDecide(gate: PipelineGateId, action: PipelineGateAction): void;
  onRetry(): void;
}) {
  const pipeline = chat.pipeline;
  const gate: PipelineGateId = pipeline?.stage === 'gate-b' ? 'B' : 'A';
  const [feedback, setFeedback] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const [locked, setLocked] = useState<{ decision: Decision; width: number } | null>(null);
  const feedbackField = useRef<HTMLTextAreaElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const preview = useArtifactPreview(chat.id);
  const busy = state.phase === 'busy' || state.phase === 'pending';
  const working = state.phase === 'busy' ? state.decision : null;

  useEffect(() => { if (!busy) setLocked(null); }, [busy]);
  useLayoutEffect(() => {
    if (state.phase === 'error' && state.kind === 'conflict') feedbackField.current?.focus();
  }, [state]);
  const stopButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmStop) confirmButton.current?.focus();
    else if (wasConfirming.current) stopButton.current?.focus();
    wasConfirming.current = confirmStop;
  }, [confirmStop]);

  const stopWidth = useRef(0);
  function decide(decision: Decision, button: HTMLButtonElement) {
    setLocked({ decision, width: decision === 'cancel' && stopWidth.current ? stopWidth.current : button.getBoundingClientRect().width });
    setConfirmStop(false);
    onDecide(gate, decision === 'revise' ? { decision, feedback: feedback.trim() } : { decision });
  }
  const widthFor = (decision: Decision) => locked?.decision === decision && locked.width ? { width: locked.width } : undefined;
  const label = (decision: Decision, idle: string) => working === decision ? '提交中…' : idle;

  const turnTaskIds = new Set(model.tasks.map(task => task.id));
  const delivered = chat.artifacts.filter(artifact => turnTaskIds.has(artifact.taskId));
  const reviewable = delivered.filter(canPreviewArtifact).slice(0, 3);
  const completed = model.tasks.filter(task => task.status === 'completed').length;
  const headingId = `gate-card-${gate}`;

  return <div className="gate-wrap" data-gate={gate}>
    <section className="gate-card decision-card" aria-labelledby={headingId} aria-busy={busy || undefined}>
      <div className="gate-in">
        <div className="gate-top"><span className="gate-eyebrow">◆ 需要你的决定 · 流水线 · {pipeline?.preset ?? '—'} · {STAGE_INDEX[gate]}/6</span></div>
        <h2 id={headingId}>关卡 {gate} · {gate === 'A' ? '架构与 Demo' : '最终交付'}</h2>
        <dl className="gate-facts">
          <div><dt>本关卡交付</dt><dd>{delivered.length ? `${delivered.length} 项 · ${delivered.slice(0, 2).map(item => item.name).join('、')}` : '尚无交付文件'}</dd></div>
          <div><dt>已完成任务</dt><dd className="mono">{completed} / {model.tasks.length}</dd></div>
          <div><dt>确认后</dt><dd>{gate === 'A' ? '实现 → 独立验收 → 关卡 B' : '交付完成'}</dd></div>
        </dl>
        {reviewable.length ? <ul className="gate-files" aria-label="待审阅文件">{reviewable.map(artifact => <li key={artifact.id}>
          <span className="mono">{artifact.name}</span>
          <button type="button" className="btn sm" disabled={preview.loading === artifact.id} onClick={event => void preview.open(artifact, event.currentTarget)}>{preview.loading === artifact.id ? '读取中…' : '安全预览'}</button>
        </li>)}</ul> : null}
        {preview.error ? <p className="chat-error" role="alert">{preview.error}</p> : null}
        <label className="gate-feedback"><span>修改意见</span>
          <textarea ref={feedbackField} rows={2} value={feedback} readOnly={busy} onChange={event => setFeedback(event.target.value)} placeholder="需要调整时填写；确认或终止无需填写" />
        </label>
        {state.phase === 'error' ? <div className="gate-error" role="alert">
          <span>{state.message}</span>
          {state.kind === 'network' ? <button type="button" className="btn sm" onClick={onRetry}>重试</button> : null}
        </div> : null}
        {state.phase === 'pending' ? <p className="gate-pending" role="status">决定已提交，等待服务端推进…</p> : null}
        {confirmStop && !busy ? <div className="gate-confirm" role="group" aria-label="确认终止流水线">
          <span>终止后流水线不再继续，已有记录保留。</span>
          <button ref={confirmButton} type="button" className="btn danger sm" onClick={event => decide('cancel', event.currentTarget)}>确认终止</button>
          <button type="button" className="btn ghost sm" onClick={() => setConfirmStop(false)}>返回</button>
        </div> : <div className="gate-actions">
          <button type="button" className="btn gate gate-confirm-btn" data-gate-confirm="" disabled={busy} style={widthFor('confirm')} onClick={event => decide('confirm', event.currentTarget)}>{label('confirm', '确认继续')}</button>
          <button type="button" className="btn" disabled={busy || !feedback.trim()} style={widthFor('revise')} onClick={event => decide('revise', event.currentTarget)}>{label('revise', '提交修改')}</button>
          <span className="grow" />
          <button ref={stopButton} type="button" className="btn ghost gate-stop" disabled={busy} style={widthFor('cancel')} onClick={event => { stopWidth.current = event.currentTarget.getBoundingClientRect().width; setConfirmStop(true); }}>{label('cancel', '终止流水线')}</button>
        </div>}
        <p className="gate-note">当前任务在这里等待。确认后由服务端继续下一步。</p>
      </div>
    </section>
    {preview.dialog}
  </div>;
}
