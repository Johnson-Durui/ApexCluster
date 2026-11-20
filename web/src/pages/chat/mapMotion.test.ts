import { describe, expect, it } from 'vitest';
import type { AgentTask, ChatPipelineStage, ChatRecord, TaskStatus } from '../../lib/chat-api';
import { buildObservatory } from './observatoryModel';
import { diffObservatory, mapPlayback, NO_MOTION, packetDuration, PACKETS_TOTAL, planEnd, planPackets, runActive } from './mapMotion';
import { pipelineAnimates } from './observatoryPaint';

const at = '2026-11-20T10:00:00Z';
const task = (id: string, role: string, status: TaskStatus, parentTaskId?: string, turnId = 'turn-1'): AgentTask => ({
  id, role, status, parentTaskId, turnId, goal: '目标', createdAt: at, updatedAt: at, mode: 'read', segment: 1, invocationIds: [], noProgressSegments: 0,
});
const chat = (tasks: AgentTask[], stage?: ChatPipelineStage, turnId = 'turn-1'): ChatRecord => ({
  version: 1, id: 'motion', title: '动效', createdAt: at, updatedAt: at, seq: 1, messageSeq: 1,
  turns: [{ id: turnId, rootTaskId: 'root', status: 'running', createdAt: at }],
  tasks, invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
  pipeline: stage ? { preset: 'flagship', stage, revision: 1, gates: { clarify: 'user', architecture: 'user', delivery: 'user' } } : undefined,
});
const model = (tasks: AgentTask[], stage?: ChatPipelineStage, turnId?: string) => buildObservatory(chat(tasks, stage, turnId), [], [], [], false);

describe('map motion diff', () => {
  const root = task('root', 'claude', 'running');

  it('plays nothing without a previous snapshot, for the same object twice, or when nothing changed', () => {
    const first = model([root, task('a', 'astra', 'queued', 'root')]);
    expect(diffObservatory(undefined, first)).toBe(NO_MOTION);
    expect(diffObservatory(first, first)).toBe(NO_MOTION);
    expect(diffObservatory(first, model([root, task('a', 'astra', 'queued', 'root')]))).toBe(NO_MOTION);
  });

  it('plays one dispatch per bundle on which a task became running, counting each task once', () => {
    const before = model([root, task('a', 'astra', 'queued', 'root'), task('b', 'astra', 'running', 'root')]);
    const after = model([root, task('a', 'astra', 'running', 'root'), task('b', 'astra', 'running', 'root'), task('c', 'grok', 'running', 'root'), task('d', 'grok', 'running', 'root')]);
    expect(diffObservatory(before, after).dispatches).toEqual([{ from: 'claude', to: 'astra', count: 1 }, { from: 'claude', to: 'grok', count: 2 }]);
  });

  it('ignores the root task and same-seat children, and treats a new turn as having no "before"', () => {
    const before = model([task('root', 'claude', 'queued'), task('x', 'claude', 'queued', 'root')]);
    const after = model([task('root', 'claude', 'running'), task('x', 'claude', 'running', 'root')]);
    expect(diffObservatory(before, after)).toBe(NO_MOTION);
    const old = model([root, task('a', 'astra', 'running', 'root')], undefined, 'turn-1');
    const fresh = model([task('root', 'claude', 'running', undefined, 'turn-2'), task('a2', 'astra', 'running', 'root', 'turn-2')], undefined, 'turn-2');
    expect(diffObservatory(old, fresh).dispatches).toEqual([{ from: 'claude', to: 'astra', count: 1 }]);
  });

  it('rolls the lead counter only when more child tasks of the same turn are completed', () => {
    const before = model([root, task('a', 'astra', 'running', 'root'), task('b', 'grok', 'completed', 'root')]);
    const after = model([root, task('a', 'astra', 'completed', 'root'), task('b', 'grok', 'completed', 'root')]);
    expect(diffObservatory(before, after).returned).toBe(1);
    expect(diffObservatory(after, model([root, task('a', 'astra', 'running', 'root'), task('b', 'grok', 'completed', 'root')])).returned).toBe(0);
  });

  it('sends the 你 → lead packet when a gate is passed, never when the pipeline is terminated', () => {
    const tasks = [root];
    expect(diffObservatory(model(tasks, 'gate-a'), model(tasks, 'implementation')).gatePassed).toBe(true);
    expect(diffObservatory(model(tasks, 'gate-b'), model(tasks, 'completed')).gatePassed).toBe(true);
    expect(diffObservatory(model(tasks, 'gate-a'), model(tasks, 'cancelled'))).toBe(NO_MOTION);
    expect(diffObservatory(model(tasks, 'architecture'), model(tasks, 'gate-a'))).toBe(NO_MOTION);
    expect(diffObservatory(model(tasks, 'gate-a'), model(tasks, 'gate-a'))).toBe(NO_MOTION);
  });
});

describe('packet plan', () => {
  it('clamps the packet duration to 360–700 ms by route length', () => {
    expect(packetDuration(0)).toBe(360);
    expect(packetDuration(200)).toBe(480);
    expect(packetDuration(5000)).toBe(700);
    expect(packetDuration(Number.NaN)).toBe(360);
  });

  it('skips bundles without a route and caps three packets per bundle, merging extras into ×N', () => {
    const plan = planPackets([{ from: 'claude', to: 'astra', count: 5 }, { from: 'claude', to: 'ghost', count: 1 }], key => key === 'claude>astra' ? 200 : undefined);
    expect(plan.map(packet => [packet.key, packet.delay, packet.weight])).toEqual([['claude>astra', 0, 1], ['claude>astra', 80, 1], ['claude>astra', 160, 3]]);
    expect(planEnd(plan)).toBe(160 + 480);
  });

  it('never plays more than six packets; the sixth stands for every task left over', () => {
    const dispatches = ['a', 'b', 'c', 'd'].map(to => ({ from: 'claude', to, count: 2 }));
    const plan = planPackets(dispatches, () => 100);
    expect(plan).toHaveLength(PACKETS_TOTAL);
    expect(plan.reduce((sum, packet) => sum + packet.weight, 0)).toBe(8);
    expect(plan.at(-1)?.weight).toBe(3);
    expect(Math.max(...plan.map(packet => packet.delay + packet.duration))).toBeLessThanOrEqual(700 + 2 * 80);
  });
});

describe('idle and full-view-only motion', () => {
  const stations = (observatory: ReturnType<typeof model>) => observatory.pipeline.stages.map(item => ({ gate: item.id.startsWith('gate'), state: item.state, userHold: false, selected: false }));

  it('treats a question waiting on the user as idle, even though the 决策管道 cursor station stays active', () => {
    const asking = model([task('root', 'claude', 'waiting_user')], 'architecture');
    // The cursor station is not 'hold' for a question, so the pipeline scene alone would keep looping (§7: it must not).
    expect(pipelineAnimates(stations(asking))).toBe(true);
    expect(runActive(asking)).toBe(false);
    expect(runActive(model([task('root', 'claude', 'waiting_children'), task('a', 'astra', 'running', 'root')], 'architecture'))).toBe(true);
    expect(runActive(model([task('root', 'claude', 'queued')], 'architecture'))).toBe(true);
    expect(runActive(model([task('root', 'claude', 'waiting_children'), task('a', 'astra', 'waiting_user', 'root')]))).toBe(true);
    expect(runActive(model([task('root', 'claude', 'completed')], 'completed'))).toBe(false);
  });

  it('drops 回放 and 暂停流线 on the docked map, which offers neither control', () => {
    const toggles = { topology: true, canReplay: true, replayTurn: 'turn-1', turnId: 'turn-1', motionPaused: true, canFlow: true };
    expect(mapPlayback({ ...toggles, full: true })).toEqual({ replay: true, playback: true, paused: true });
    expect(mapPlayback({ ...toggles, full: false })).toEqual({ replay: false, playback: false, paused: false });
    // Without a live stream the beads still freeze on the docked map, as before.
    expect(mapPlayback({ ...toggles, full: false, canFlow: false }).paused).toBe(true);
    // A replay armed for an earlier turn never plays.
    expect(mapPlayback({ ...toggles, full: true, turnId: 'turn-2', motionPaused: false })).toEqual({ replay: false, playback: false, paused: false });
  });
});
