// Gate receipts (BUILD-SPEC-B §4.4 step 4): rebuilt from the persisted message that runtime.decidePipelineGate appends,
// so they survive a reload. Never rendered as a user bubble.
import type { ChatMessage } from '../../../lib/chat-api';

const time = (at: string) => {
  const value = Date.parse(at);
  return Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
};

export function receiptWords(message: ChatMessage): { glyph: string; text: string; tone: 'ok' | 'wait' | 'stop' } | null {
  const gate = message.pipelineGate;
  if (!gate) return null;
  if (gate.decision === 'confirm') return { glyph: '✓', text: `关卡 ${gate.id} · 已确认继续`, tone: 'ok' };
  if (gate.decision === 'revise') return { glyph: '↻', text: `关卡 ${gate.id} · 已提交修改`, tone: 'wait' };
  return { glyph: '■', text: '流水线已终止', tone: 'stop' };
}

export function GateReceipt({ message, fresh = false }: { message: ChatMessage; fresh?: boolean }) {
  const words = receiptWords(message);
  if (!words) return null;
  const by = message.auto ? '由系统自动通过' : '由你决定';
  const at = time(message.createdAt);
  return <article className={`chat-message receipt tone-${words.tone}${fresh ? ' is-fresh' : ''}`} data-gate={message.pipelineGate?.id}>
    <span className="sr-only">{message.auto ? '系统' : '你'}</span>
    <p className="receipt-line"><i aria-hidden="true">{words.glyph}</i><b>{words.text}</b><span> · {by}</span>{at ? <span className="mono"> · {at}</span> : null}</p>
    {message.pipelineGate?.decision === 'revise' && message.text.trim() ? <p className="receipt-feedback">{message.text}</p> : null}
  </article>;
}
