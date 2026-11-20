import { describe, expect, it } from 'vitest';
import type { AgentTask, ChatRecord, Invocation } from '../../lib/chat-api';
import { buildObservatory } from './observatoryModel';
import { contextIds, selectedSeat, topologySlots } from './observatoryScene';

const at = (second: number) => `2026-11-19T10:00:${String(second).padStart(2, '0')}Z`;
const task = (id: string, role: string, patch: Partial<AgentTask> = {}): AgentTask => ({
  id, role, turnId: 't', goal: '任务', status: 'running', createdAt: at(0), updatedAt: at(1),
  mode: 'read', segment: 1, invocationIds: [], noProgressSegments: 0, parentTaskId: id === 'root' ? undefined : 'root', ...patch,
});
const usage = (id: string, taskId: string, used: number | null, hard: number | null): Invocation => ({
  id, taskId, status: 'exited', segment: 1, startedAt: at(2), toolCount: 0, promptVersion: 'v1', inputEstimate: 0,
  contextWindow: hard, contextHard: hard ?? undefined, contextUsed: used,
});
const chat = (tasks: AgentTask[], invocations: Invocation[] = []): ChatRecord => ({
  version: 1, id: 'c', title: '任务', createdAt: at(0), updatedAt: at(3), seq: 1, messageSeq: 1,
  turns: [{ id: 't', rootTaskId: 'root', status: 'waiting_children', createdAt: at(0) }],
  tasks, invocations, tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
});
const seats = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

describe('architecture view scene', () => {
  it('ignores a selected seat that is no longer in the roster', () => {
    const model = buildObservatory(chat([task('root', 'claude', { status: 'waiting_children' }), task('x', 'sol')]), [], [], [], false);
    expect(selectedSeat(model, 'mini')).toBeUndefined();
    const ids = topologySlots(model, 'mini').map(slot => slot.id);
    expect(ids).toEqual(['claude', 'sol']);
    expect(contextIds(model, 'mini')).toEqual(['claude', 'sol']);
  });

  it('always shows a selected seat, in topology and on the context orbit', () => {
    const tasks = [task('root', 'claude', { status: 'waiting_children' }), ...seats.map(id => task('t-' + id, id))];
    const many = Array.from({ length: 12 }, (_, index) => task('extra-' + index, 'extra-' + index));
    const model = buildObservatory(chat([...tasks, ...many]), [], [], [], false);
    expect(topologySlots(model, 'extra-11').map(slot => slot.id)).toContain('extra-11');
    expect(contextIds(model, 'h')).toContain('h');
    expect(contextIds(model, 'h')).toHaveLength(6);
  });

  it('puts seats with reported context usage on the orbit before unknown ones, fullest first', () => {
    const tasks = [task('root', 'claude', { status: 'waiting_children' }), ...seats.map(id => task('t-' + id, id, { status: 'completed' }))];
    const invocations = [
      usage('u-g', 't-g', 900, 1000), usage('u-h', 't-h', 100, 1000), usage('u-a', 't-a', null, null),
      usage('u-b', 't-b', 500, 1000), usage('u-c', 't-c', 300, 1000), usage('u-d', 't-d', 200, 1000),
    ];
    const model = buildObservatory(chat(tasks, invocations), [], [], [], false);
    const ids = contextIds(model, undefined);
    expect(ids[0]).toBe('claude');
    expect(new Set(ids.slice(1))).toEqual(new Set(['g', 'b', 'c', 'd', 'h']));
    // Display order follows the roster, not the ranking, so seats do not jump around between updates.
    expect(ids.slice(1)).toEqual(['b', 'c', 'd', 'g', 'h']);
  });
});
