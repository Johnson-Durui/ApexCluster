// Messages in the log (BUILD-SPEC-B §4.3.5): user bubble, the assistant's final answer as a document card, system notes
// and gate receipts. Every article starts with an sr-only role label. Classes chat-message.{role} and .message-text kept.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage } from '../../../lib/chat-api';
import { Icon, Tag } from '../../../components/ui';
import { MarkdownLite } from './markdownLite';
import { GateReceipt } from './GateReceipt';
import { SeatMark, seatStyle } from './seats';

const clock = (at: string) => {
  const value = Date.parse(at);
  return Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '';
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); }
    catch { return; }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }
  return <>
    <button type="button" className="btn sm ghost answer-copy" onClick={() => void copy()}><Icon name="copy" size={13} />复制</button>
    <span className="answer-copied" role="status">{copied ? '已复制' : ''}</span>
  </>;
}

export function AnswerCard({ message, lead, seat, demo, fresh }: { message: ChatMessage; lead: string; seat?: string; demo: boolean; fresh: boolean }) {
  return <article className={`chat-message assistant answer${fresh ? ' is-fresh' : ''}`} data-seat={seat} style={seatStyle(seat)}>
    <span className="sr-only message-role">{lead} · 最终回复</span>
    <header className="answer-head">
      <SeatMark seat={seat} /><b aria-hidden="true">{lead} · 最终回复</b>
      {demo ? <Tag tone="mock">▷ 预设演示</Tag> : null}
      <span className="mono answer-time">{clock(message.createdAt)}</span>
      <CopyButton text={message.text} />
    </header>
    <div className="message-text"><MarkdownLite text={message.text} /></div>
  </article>;
}

export function MessageItem({ message, lead, seat, demo, fresh, attachments }: { message: ChatMessage; lead: string; seat?: string; demo: boolean; fresh: boolean; attachments?: ReactNode }) {
  if (message.pipelineGate) return <GateReceipt message={message} fresh={fresh} />;
  if (message.role === 'assistant') return <AnswerCard message={message} lead={lead} seat={seat} demo={demo} fresh={fresh} />;
  if (message.role === 'system') {
    return <article className="chat-message system"><span className="sr-only message-role">系统</span><div className="message-text">{message.text}</div></article>;
  }
  return <article className={`chat-message user${fresh ? ' is-fresh' : ''}`}>
    <span className="sr-only message-role">你</span>
    <div className="message-text">{message.text}</div>
    {attachments}
    <div className="message-meta"><span className="mono">{clock(message.createdAt)}</span></div>
  </article>;
}
