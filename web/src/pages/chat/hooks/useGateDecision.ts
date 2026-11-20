// Gate decisions (BUILD-SPEC-B §4.4): POST /api/chats/:id/gates/:A|B with an honest lock. After a 2xx the response chat
// is dispatched; if it still shows the gate, the card stays locked ("pending") until SSE or a reconcile moves the stage.
// 409/4xx → not effective (server reason, no retry); network/5xx → failed + 重试 with the same action.
// Every lock and error belongs to one gate at one revision: once the chat is elsewhere it reads as idle, so a stale
// alert or lock never reaches the next gate's card, and 重试 never re-posts an old gate's action.
import { useCallback, useEffect, useRef, useState, type Dispatch } from 'react';
import { ApiError } from '../../../lib/api';
import { chatApi, type ChatRecord, type PipelineGateAction, type PipelineGateId } from '../../../lib/chat-api';
import type { ChatAction } from '../chatModel';
import type { GatePhase } from '../pipeline/GateCard';

const atGate = (chat: ChatRecord | null | undefined, gate: PipelineGateId) => chat?.pipeline?.stage === (gate === 'A' ? 'gate-a' : 'gate-b');
const trim = (text: string) => text.replace(/[。.\s]+$/u, '');

export function gateFailure(cause: unknown): Extract<GatePhase, { phase: 'error' }> {
  if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
    return { phase: 'error', kind: 'conflict', message: `关卡决定没有生效：${trim(cause.message)}` };
  }
  const reason = cause instanceof ApiError ? `服务暂时不可用（${cause.status}）${cause.message ? `：${trim(cause.message)}` : ''}` : cause instanceof Error && cause.message ? trim(cause.message) : '网络连接失败';
  return { phase: 'error', kind: 'network', message: `关卡决定提交失败：${reason}。决定没有生效，关卡仍在等你。` };
}

/** The decision a phase belongs to: the gate, the pipeline revision it was taken at, and the action (for 重试). */
export interface GateTarget { gate: PipelineGateId; revision: number | undefined; action: PipelineGateAction }

/** The chat still waits at the target's gate, at the same revision. */
export function stillAtGate(chat: ChatRecord | null | undefined, target: GateTarget): boolean {
  return atGate(chat, target.gate) && chat?.pipeline?.revision === target.revision;
}

/** What the card shows: a lock or an error only while the chat is still at the gate and revision it belongs to. */
export function visibleGatePhase(phase: GatePhase, target: GateTarget | null, chat: ChatRecord | null | undefined): GatePhase {
  if (phase.phase === 'idle' || phase.phase === 'busy') return phase;
  return target && stillAtGate(chat, target) ? phase : { phase: 'idle' };
}

export function useGateDecision(chat: ChatRecord | null, dispatch: Dispatch<ChatAction>) {
  const [stored, setStored] = useState<{ phase: GatePhase; target: GateTarget | null }>({ phase: { phase: 'idle' }, target: null });
  const last = useRef<GateTarget | null>(null);
  const state = visibleGatePhase(stored.phase, stored.target, chat);
  const stale = state !== stored.phase;

  // The chat moved on (SSE, a reconcile, another tab): forget the old lock or error.
  useEffect(() => {
    if (stale) setStored(current => ({ ...current, phase: { phase: 'idle' } }));
  }, [stale]);

  const decide = useCallback(async (gate: PipelineGateId, action: PipelineGateAction) => {
    if (!chat || state.phase === 'busy' || state.phase === 'pending') return;
    const target: GateTarget = { gate, revision: chat.pipeline?.revision, action };
    last.current = target;
    setStored({ phase: { phase: 'busy', decision: action.decision }, target });
    try {
      const response = await chatApi.decideGate(chat.id, gate, action);
      dispatch({ type: 'chat', chat: response });
      setStored({ phase: stillAtGate(response, target) ? { phase: 'pending', decision: action.decision } : { phase: 'idle' }, target });
    } catch (cause) { setStored({ phase: gateFailure(cause), target }); }
  }, [chat, dispatch, state.phase]);

  const retry = useCallback(() => {
    const target = last.current;
    if (target && stillAtGate(chat, target)) void decide(target.gate, target.action);
  }, [chat, decide]);

  return { state, decide, retry };
}
