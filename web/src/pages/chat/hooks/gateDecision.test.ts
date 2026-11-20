import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api';
import type { ChatPipeline, ChatRecord } from '../../../lib/chat-api';
import type { GatePhase } from '../pipeline/GateCard';
import { gateFailure, stillAtGate, visibleGatePhase, type GateTarget } from './useGateDecision';

const chatAt = (stage: ChatPipeline['stage'], revision: number): ChatRecord => ({
  version: 1, id: 'c', title: 'c', createdAt: '', updatedAt: '', seq: 1, messageSeq: 0, turns: [], tasks: [], invocations: [], tickets: [],
  artifacts: [], checkpoints: [], constraintMessageIds: [],
  pipeline: { preset: 'flagship', stage, revision, gates: { clarify: 'user', architecture: 'user', delivery: 'user' } },
});
const gateA: GateTarget = { gate: 'A', revision: 1, action: { decision: 'confirm' } };

describe('gate decision state', () => {
  it('keeps a failed decision on its own gate and revision only', () => {
    const failed = gateFailure(new TypeError('Failed to fetch'));
    expect(failed.kind).toBe('network');
    expect(visibleGatePhase(failed, gateA, chatAt('gate-a', 1))).toBe(failed);
    // the decision went through after all (or another tab decided): gate B opens clean, as does gate A at a new revision
    expect(visibleGatePhase(failed, gateA, chatAt('gate-b', 1))).toEqual({ phase: 'idle' });
    expect(visibleGatePhase(failed, gateA, chatAt('gate-a', 2))).toEqual({ phase: 'idle' });
    const conflict = gateFailure(new ApiError('该关卡当前未开放', 409));
    expect(visibleGatePhase(conflict, gateA, chatAt('implementation', 1))).toEqual({ phase: 'idle' });
  });

  it('releases a pending lock when a reconcile jumps to the same gate at a new revision', () => {
    const pending: GatePhase = { phase: 'pending', decision: 'confirm' };
    expect(visibleGatePhase(pending, gateA, chatAt('gate-a', 1))).toBe(pending);
    expect(visibleGatePhase(pending, gateA, chatAt('gate-a', 2))).toEqual({ phase: 'idle' });
    expect(visibleGatePhase(pending, null, chatAt('gate-a', 1))).toEqual({ phase: 'idle' });
  });

  it('leaves idle and in-flight phases alone', () => {
    const busy: GatePhase = { phase: 'busy', decision: 'revise' };
    expect(visibleGatePhase(busy, gateA, chatAt('gate-b', 3))).toBe(busy);
    const idle: GatePhase = { phase: 'idle' };
    expect(visibleGatePhase(idle, gateA, chatAt('gate-b', 3))).toBe(idle);
  });

  it('retries only while the chat still waits at the same gate and revision', () => {
    expect(stillAtGate(chatAt('gate-a', 1), gateA)).toBe(true);
    expect(stillAtGate(chatAt('gate-b', 1), gateA)).toBe(false);
    expect(stillAtGate(chatAt('gate-a', 2), gateA)).toBe(false);
    expect(stillAtGate(null, gateA)).toBe(false);
  });
});
