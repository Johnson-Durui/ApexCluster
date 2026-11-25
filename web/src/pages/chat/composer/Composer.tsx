// Composer (BUILD-SPEC-B §4.7): the hero input. form.chat-compose (strong glass), run mode for a new chat, pending
// attachment chips, the textarea (Enter sends, Shift+Enter newline, IME-safe), toolbar and foot. Send-path errors only
// in the strip above the form; gate, answer and connection messages live next to their cause.
import { useState, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../../components/ui';
import type { ChatAttachment } from '../../../lib/chat-api';
import { missingForSend } from './costConfirm';

export type PendingUpload = { id: string; file: File; status: 'queued' | 'uploading' | 'uploaded' | 'failed'; error?: string; attachment?: ChatAttachment };

export interface ComposerProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  onInput(value: string): void;
  onSubmit(): void;
  /** New chat (no chat record yet). */
  fresh: boolean;
  fixedDemo: boolean;
  demoInput: boolean;
  /** The chat could not be loaded: nothing can be sent. */
  /** 'failed': the chat could not be loaded (nothing can be sent); 'loading': the skeleton is showing. */
  unavailable: false | 'loading' | 'failed';
  sending: boolean;
  workspaceBusy: boolean;
  canStop: boolean;
  stopping: boolean;
  onStop(): void;
  pending: PendingUpload[];
  maxFiles: number;
  onFiles(files: File[]): void;
  onRetryUpload(item: PendingUpload): void;
  onRemoveUpload(item: PendingUpload): void;
  error: string;
  costConfirmed: boolean;
  onCostConfirm(checked: boolean): void;
  onCostRevoke(): void;
  steeringAck: boolean;
  pipeline: { mode: 'normal' | 'pipeline'; workspace: boolean; preset: boolean };
  team?: { custom: boolean; invalid: boolean; reason?: string };
  runMode: ReactNode;
  project: ReactNode;
  collab: ReactNode;
}

const uploadWords = (item: PendingUpload) => item.status === 'queued' ? '等待上传' : item.status === 'uploading' ? '上传中…' : item.status === 'uploaded' ? '已上传，等待发送' : item.error ?? '上传失败';

export function Composer(props: ComposerProps) {
  const { input, sending, workspaceBusy, canStop, pending, fresh, pipeline, team } = props;
  const unavailable = Boolean(props.unavailable);
  const [dragging, setDragging] = useState(false);
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null);
  const hasContent = Boolean(input.trim()) || pending.length > 0;
  const pipelineBlocked = fresh && pipeline.mode === 'pipeline' && (!pipeline.workspace || !pipeline.preset);
  const teamBlocked = fresh && pipeline.mode === 'normal' && Boolean(team?.custom && team.invalid);
  const disabled = unavailable || sending || workspaceBusy || !hasContent || pipelineBlocked || teamBlocked;
  const reason = props.unavailable === 'loading' ? '正在恢复聊天' : unavailable ? '无法发送：聊天未加载' : sending ? '发送中' : !hasContent ? '请先输入内容或添加附件'
    : fresh && pipeline.mode === 'pipeline' && !pipeline.workspace ? '流水线需要项目目录' : pipelineBlocked ? '请选择一个可用的流水线预设' : teamBlocked ? (team?.reason || '请完善自定义团队配置') : canStop ? '追加消息' : '发送';
  const demo = props.fixedDemo || props.demoInput;
  const missing = missingForSend({ hasContent, costConfirmed: props.costConfirmed, needsCost: !demo, pipeline: fresh && pipeline.mode === 'pipeline', workspace: pipeline.workspace, preset: pipeline.preset, teamInvalid: teamBlocked });
  const showMissing = !unavailable && missing.length > 0 && (hasContent || (fresh && pipeline.mode === 'pipeline') || teamBlocked);

  return <div className="composer-dock">
    {props.error ? <p className="chat-error compose-error" role="alert">{props.error}</p> : null}
    <form className={`chat-compose glass-strong${dragging ? ' is-dragging' : ''}`} aria-disabled={unavailable || undefined}
      onDragEnter={event => { event.preventDefault(); if (!unavailable) setDragging(true); }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!unavailable) props.onFiles([...event.dataTransfer.files]); }}
      onSubmit={event => { event.preventDefault(); if (!unavailable) props.onSubmit(); }}>
      {props.runMode}
      {pending.length ? <ul className="pending-attachments" aria-label="待发送附件">{pending.map(item => <li key={item.id} className={`is-${item.status}`}>
        <Icon name="file" size={13} /><b>{item.file.name}</b><small>{uploadWords(item)}</small>
        {item.status === 'failed' ? <button type="button" className="btn-reset" onClick={() => props.onRetryUpload(item)}>重试</button> : null}
        <button type="button" className="btn-reset" disabled={item.status === 'uploading'} onClick={() => props.onRemoveUpload(item)} aria-label={`移除 ${item.file.name}`}>移除</button>
      </li>)}</ul> : null}
      <textarea ref={props.inputRef} name="message" autoComplete="off" value={input} readOnly={sending} disabled={unavailable}
        onChange={event => props.onInput(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (!unavailable) props.onSubmit();
        }}
        placeholder={canStop ? '补充要求，或调整接下来的方向…' : '输入你的想法，让我们开始吧…'} aria-label="聊天输入" rows={2} />
      <div className="compose-toolbar">
        <input ref={setFileInput} className="sr-only" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={event => { props.onFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <button type="button" className="btn ghost attach-button" disabled={unavailable || demo || sending || pending.length >= props.maxFiles} onClick={() => fileInput?.click()}><Icon name="file" size={14} />附件</button>
        {props.project}
        <span className="grow" />
        {props.collab}
        {canStop ? <button type="button" className="compose-stop" onClick={props.onStop} disabled={props.stopping} aria-label={props.stopping ? '停止中' : '停止任务'} title="停止任务"><Icon name="stop" size={13} /></button> : null}
        <button type="submit" className="compose-send" disabled={disabled} aria-label={sending ? '发送中' : canStop ? '追加消息' : '发送'} title={reason}><Icon name="arrow-up" size={18} /></button>
      </div>
      {dragging ? <div className="drop-hint" aria-hidden="true">松开以添加附件</div> : null}
    </form>
    <div className="compose-foot">
      <span className="foot-left">{props.unavailable === 'loading' ? null : unavailable ? <span className="bad-text">无法发送：聊天未加载</span>
        : demo ? <span>固定提示词演示 · 不消耗模型额度 · 不写入已授权项目目录</span>
        : props.costConfirmed ? <span className="cost-confirmed"><span className="ok-text">✓</span> 已确认本会话会消耗模型额度 · <button type="button" className="btn-reset" onClick={props.onCostRevoke}>撤销</button></span>
        : <label className="cost-confirm"><input type="checkbox" checked={false} onChange={event => props.onCostConfirm(event.target.checked)} />我了解，发送会调用模型并消耗额度</label>}</span>
      <span className="foot-right" aria-live="polite">{unavailable || demo ? null : showMissing ? `还差：${missing.join('、')}`
        : <span role={props.steeringAck ? 'status' : undefined}>{props.steeringAck ? '补充已接收。' : canStop ? '任务进行中，你可以继续补充要求' : 'Enter 发送，Shift + Enter 换行'}</span>}</span>
    </div>
  </div>;
}
