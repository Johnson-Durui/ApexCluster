import { describe, expect, it } from 'vitest';
import type { AgentTask, ChatArtifact, ChatRecord, Invocation } from '../../lib/chat-api';
import { buildObservatory } from './observatoryModel';

const day = '2026-11-19';
const at = (second: number) => `${day}T10:00:${String(second).padStart(2, '0')}Z`;
const task = (id: string, patch: Partial<AgentTask> = {}): AgentTask => ({
  id, role: 'claude', turnId: 'new', goal: '任务目标', status: 'running', createdAt: at(0), updatedAt: at(1),
  mode: 'read', segment: 1, invocationIds: [], noProgressSegments: 0, ...patch,
});
const chat = (patch: Partial<ChatRecord> = {}): ChatRecord => ({
  version: 1, id: 'observation-fixture', title: '任务', createdAt: at(0), updatedAt: at(10), seq: 2, messageSeq: 1,
  turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [], ...patch,
});
const invocation = (id: string, taskId: string, sec: number, model?: string): Invocation => ({
  id, taskId, status: 'running', segment: 1, startedAt: at(sec), toolCount: 0, promptVersion: 'v1', inputEstimate: 0,
  contextWindow: null, contextUsed: null, model,
});
const artifact = (id: string, taskId: string): ChatArtifact => ({
  id, taskId, name: `${id}.md`, relativePath: `${id}.md`, hash: 'hash', bytes: 8, kind: 'file', createdAt: at(3),
});
const sol = { role: 'sol', available: true, isolationVerified: true, model: 'configured-model' };

describe('architecture observatory', () => {
  it('does not report configured seats or tasks before receiving records', () => {
    const result = buildObservatory(null, [], [], [], false);
    expect(result.roles).toEqual([]);
    expect(result.counts).toEqual({ running: 0, complete: 0, waiting: 0, tasks: 0, artifacts: 0 });
  });

  it('uses the latest turn and derives role-pair links, counts and latest invocation from records', () => {
    const root = task('root', { status: 'waiting_children' });
    const result = buildObservatory(chat({
      turns: [
        { id: 'old', rootTaskId: 'old-root', status: 'completed', createdAt: at(0) },
        { id: 'new', rootTaskId: root.id, status: root.status, createdAt: at(1) },
      ],
      tasks: [
        task('old-root', { turnId: 'old', role: 'grok', status: 'completed' }), root,
        task('build-1', { parentTaskId: root.id, role: 'sol', status: 'completed' }),
        task('build-2', { parentTaskId: root.id, role: 'sol' }),
        task('orphan', { parentTaskId: 'old-root', role: 'astra', status: 'queued' }),
      ],
      invocations: [invocation('older-time', 'build-2', 3, 'older-model'), invocation('latest-time', 'build-2', 9, 'actual-model'), invocation('unsorted', 'build-1', 2), invocation('old-turn', 'old-root', 17)],
      artifacts: [artifact('in-scope', 'build-1'), artifact('old', 'old-root')],
    }), [sol], [], [], false);

    expect(result.turnId).toBe('new');
    expect(result.rootRole).toBe('claude');
    expect(result.rootStatus).toBe('waiting_children');
    expect(result.roles.map(role => role.id)).toEqual(['claude', 'sol', 'astra']);
    expect(result.roles[1]).toMatchObject({ model: 'actual-model', state: 'active', latestInvocation: { id: 'latest-time', contextUsed: null } });
    expect(result.links).toEqual([{
      from: 'claude', to: 'sol', count: 2, active: true, flow: { outbound: 1, returning: 1, waiting: 0, waitingUser: 0 }, effort: 0, returnedAt: at(1),
    }]);
    expect(result.counts).toEqual({ running: 1, complete: 1, waiting: 1, tasks: 4, artifacts: 1 });
    expect(result.waitingForUser).toBe(false);
  });

  it('shows a real gate and avoids fabricating a passed stage for cancelled or normal chats', () => {
    const pipeline = { preset: 'flagship', stage: 'gate-a' as const, revision: 1, gates: { clarify: 'user' as const, architecture: 'user' as const, delivery: 'user' as const } };
    const build = (value: ChatRecord) => buildObservatory(value, [], [], [], false).pipeline;
    expect(build(chat({ pipeline }))).toMatchObject({ active: 'gate-a', gate: 'A', gateMode: 'user' });
    expect(build(chat({ pipeline })).stages.map(stage => stage.state)).toEqual(['done', 'hold', 'idle', 'idle', 'idle', 'idle']);
    expect(build(chat({ pipeline: { ...pipeline, gates: { ...pipeline.gates, architecture: 'auto' } } }))).toMatchObject({ gate: 'A', gateMode: 'auto' });
    expect(build(chat({ pipeline: { ...pipeline, gates: { ...pipeline.gates, architecture: 'auto' } } })).stages[1]?.state).toBe('active');
    expect(build(chat({ pipeline: { ...pipeline, stage: 'cancelled' } })).stages.every(stage => stage.state === 'idle')).toBe(true);
    expect(build(chat({ pipeline: { ...pipeline, stage: 'completed' } })).stages.every(stage => stage.state === 'done')).toBe(true);
    expect(build(chat())).toEqual({ active: null, gate: null, gateMode: null, stages: [], cancelled: false });
    expect(build(chat({ pipeline: { ...pipeline, stage: 'cancelled' } })).cancelled).toBe(true);
    expect(build(chat({ pipeline })).stages.map(stage => stage.mode)).toEqual([undefined, 'user', undefined, undefined, 'user', undefined]);
  });

  it('uses only the recorded demo seats and projects bounded event metadata from the selected turn', () => {
    const result = buildObservatory(chat({
      tasks: [task('old', { turnId: 'old' }), task('root', { status: 'waiting_user' })],
      invocations: [invocation('in-turn', 'root', 2)],
      blockedReason: '服务停住',
    }), [sol], [
      { id: 'old-log', taskId: 'old', seq: 1, name: 'excluded', status: 'completed', at: at(18) },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `in-scope-${i}`, invocationId: 'in-turn', seq: i + 2, name: 'known tool', status: 'completed' as const, at: at(i + 3), text: 'raw tool result' })),
    ], [{ id: 'r1', invocationId: 'in-turn', reason: 'yield', at: at(17), nextSegment: 2 }], true);

    expect(result.roles.map(role => role.id)).toEqual(['claude']);
    expect(result.roles[0].state).toBe('hold');
    expect(result.roles[0].available).toBeUndefined();
    expect(result.waitingForUser).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.signals).toHaveLength(5);
    expect(result.signals[0]).toMatchObject({ label: '窗口交接 · 第 2 段', role: 'claude' });
    expect(JSON.stringify(result.signals)).not.toMatch(/excluded|raw tool result/);
  });

  it.each([['low', 1], ['medium', 2], ['high', 3], ['xhigh', 4], ['max', 5], ['ultra', 6]] as const)(
    'normalizes the configured %s tier to level %d', (label, level) => {
      const result = buildObservatory(null, [{ ...sol, effort: ` ${label.toUpperCase()} ` }], [], [], false);
      expect(result.roles[0].effort).toEqual({ label, level, source: 'configured' });
    },
  );

  it('uses the latest reported setting even when it has no known tier or differs from configuration', () => {
    const result = buildObservatory(chat({
      tasks: [task('root', { role: 'sol' })],
      invocations: [
        { ...invocation('latest', 'root', 10), effort: ' adaptive ' },
        { ...invocation('older', 'root', 2), effort: 'max' },
      ],
    }), [{ ...sol, effort: 'ultra' }], [], [], false);
    expect(result.roles[0].effort).toEqual({ label: 'adaptive', level: 0, source: 'recorded' });
  });

  it('separates directions and waiting while taking effort from the specific child tasks of each edge', () => {
    const root = task('root', { status: 'waiting_children' });
    const child = (id: string, status: AgentTask['status'], patch: Partial<AgentTask> = {}) => task(id, { parentTaskId: 'root', role: 'sol', status, ...patch });
    const withEffort = (id: string, taskId: string, sec: number, effort: string, endedAt?: string) => ({ ...invocation(id, taskId, sec), effort, endedAt });
    const result = buildObservatory(chat({
      turns: [{ id: 'new', rootTaskId: root.id, status: root.status, createdAt: at(0) }],
      tasks: [
        root, child('sent', 'running'), child('wait-user', 'waiting_user'), child('wait-children', 'waiting_children'),
        child('arrived-earlier', 'completed', { updatedAt: at(30), result: 'internal result content' }),
        child('arrived-latest', 'completed', { updatedAt: at(25) }),
        child('queue', 'queued'), child('interrupted', 'interrupted'), child('failed', 'failed'), child('cancelled', 'cancelled'),
        task('reviewer', { role: 'astra', parentTaskId: root.id, status: 'waiting_children' }),
        child('other-edge', 'running', { parentTaskId: 'reviewer' }),
      ],
      invocations: [
        withEffort('sent-current', 'sent', 11, ' Medium '), withEffort('sent-old', 'sent', 5, 'ultra'),
        withEffort('recorded-earlier', 'arrived-earlier', 6, 'max', at(18)),
        withEffort('recorded-latest', 'arrived-latest', 7, 'ultra', at(22)),
        withEffort('other-edge', 'other-edge', 17, ' HIGH '),
      ],
    }), [{ ...sol, effort: 'xhigh' }], [], [], false);

    const build = result.links.find(link => link.from === 'claude' && link.to === 'sol');
    const review = result.links.find(link => link.from === 'astra' && link.to === 'sol');
    expect(build).toMatchObject({ count: 9, flow: { outbound: 1, returning: 2, waiting: 2, waitingUser: 1 }, effort: 2, returnedAt: at(22) });
    expect(review).toMatchObject({ count: 1, flow: { outbound: 1, returning: 0, waiting: 0, waitingUser: 0 }, effort: 3 });
    expect(result.roles.find(role => role.id === 'sol')?.effort).toEqual({ label: 'high', level: 3, source: 'recorded' });
    expect(JSON.stringify({ links: result.links, signals: result.signals })).not.toContain('internal result content');
  });
});

describe('waits on the user', () => {
  const ticket = (id: string, taskId: string, status: 'pending' | 'resolved' = 'pending') => ({
    id, taskId, invocationId: 'inv', type: 'user' as const, status, createdAt: at(4),
  });

  it('counts a waiting task and its pending ticket once, and ignores resolved or out-of-turn tickets', () => {
    const result = buildObservatory(chat({
      turns: [{ id: 'new', rootTaskId: 'root', status: 'waiting_children', createdAt: at(0) }],
      tasks: [
        task('root', { status: 'waiting_children' }),
        task('ask', { parentTaskId: 'root', role: 'hydrogen', status: 'waiting_user' }),
        task('other', { parentTaskId: 'root', role: 'sol', status: 'running' }),
        task('old', { turnId: 'old', role: 'grok', status: 'waiting_user' }),
      ],
      tickets: [ticket('t1', 'ask'), ticket('t2', 'other', 'resolved'), ticket('t3', 'old')],
    }), [], [], [], false);
    expect(result.userWaits).toBe(1);
    expect(result.waitingForUser).toBe(true);
    expect(result.links.find(link => link.to === 'hydrogen')?.flow).toEqual({ outbound: 0, returning: 0, waiting: 1, waitingUser: 1 });
  });

  it('marks the seat that holds a pending user ticket even when its task is only queued', () => {
    const result = buildObservatory(chat({
      turns: [{ id: 'new', rootTaskId: 'root', status: 'queued', createdAt: at(0) }],
      tasks: [task('root', { status: 'queued' }), task('child', { parentTaskId: 'root', role: 'sol', status: 'running' })],
      tickets: [ticket('budget', 'root')],
    }), [], [], [], false);
    expect(result.userWaits).toBe(1);
    expect(result.userWaitRoles).toEqual(['claude']);
    expect(result.roles.find(role => role.id === 'claude')?.waitsOnUser).toBe(true);
    expect(result.roles.find(role => role.id === 'sol')?.waitsOnUser).toBe(false);
  });

  it('reports no user waits when nothing waits on the user', () => {
    const result = buildObservatory(chat({ tasks: [task('root', { status: 'waiting_children' })] }), [], [], [], false);
    expect(result.userWaits).toBe(0);
    expect(result.waitingForUser).toBe(false);
  });
});

describe('stopped work', () => {
  it('tells a user cancel apart from a failure on seats', () => {
    const result = buildObservatory(chat({
      tasks: [task('root', { status: 'cancelled' }), task('a', { parentTaskId: 'root', role: 'sol', status: 'cancelled' }), task('b', { parentTaskId: 'root', role: 'astra', status: 'failed' })],
    }), [], [], [], false);
    expect(result.roles.map(role => [role.id, role.state])).toEqual([['claude', 'stopped'], ['sol', 'stopped'], ['astra', 'error']]);
  });

  it('shows a stage whose root task was stopped as stopped instead of active', () => {
    const pipeline = { preset: 'flagship', stage: 'architecture' as const, revision: 1, gates: { clarify: 'user' as const, architecture: 'user' as const, delivery: 'user' as const } };
    const stopped = buildObservatory(chat({ pipeline, turns: [{ id: 'new', rootTaskId: 'root', status: 'cancelled', createdAt: at(0) }], tasks: [task('root', { status: 'cancelled' })] }), [], [], [], false);
    expect(stopped.pipeline.stages[0]?.state).toBe('stopped');
    const failed = buildObservatory(chat({ pipeline, turns: [{ id: 'new', rootTaskId: 'root', status: 'failed', createdAt: at(0) }], tasks: [task('root', { status: 'failed' })] }), [], [], [], false);
    expect(failed.pipeline.stages[0]?.state).toBe('error');
    const running = buildObservatory(chat({ pipeline, turns: [{ id: 'new', rootTaskId: 'root', status: 'running', createdAt: at(0) }], tasks: [task('root')] }), [], [], [], false);
    expect(running.pipeline.stages[0]?.state).toBe('active');
  });
});
