import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClusterAggregate,
  createClusterState,
  nextClusterWave,
  parseClusterSubmit,
  registerClusterWave,
  updateClusterTask,
  type ClusterResultRef,
  type ClusterState,
} from '../src/pipeline/cluster.js';

const hash = (character: string) => character.repeat(64);
const ref = (name: string, character: string): ClusterResultRef => ({ ref: `results/${name}.md`, hash: hash(character) });
const identity = { id: 'cluster-1', groupId: 'group-1', rootTaskId: 'root-1' };

function startNext(state: ClusterState): ClusterState {
  const wave = nextClusterWave(state);
  assert.ok(wave);
  return registerClusterWave(state, wave, wave.tasks.map(task => ({ slot: task.slot, taskId: `task-${task.slot}` })));
}

function finish(state: ClusterState, role: 'carbon' | 'astra' | 'opus', result: ClusterResultRef): ClusterState {
  const task = state.waves.at(-1)?.tasks.find(item => item.role === role);
  assert.ok(task);
  return updateClusterTask(state, task.taskId, { status: 'completed', result });
}

test('cluster_submit is strict and defaults crossRounds to one', () => {
  assert.deepEqual(parseClusterSubmit({ mode: 'pair', draft: '初稿' }), { mode: 'pair', draft: '初稿', crossRounds: 1 });
  assert.throws(() => parseClusterSubmit({ mode: 'pair', draft: '初稿', crossRounds: 3 }), /crossRounds/);
  assert.throws(() => parseClusterSubmit({ mode: 'pair', draft: '', extra: true }), /draft|extra/);
});

test('pair starts Astra and Opus in one wave and each cross task reads only the opposite result', () => {
  let state = createClusterState(identity, parseClusterSubmit({ mode: 'pair', draft: '需求 + 初稿' }));
  const initial = nextClusterWave(state);
  assert.deepEqual(initial?.tasks.map(task => [task.role, task.reads, task.output]), [
    ['astra', [], 'increment'], ['opus', [], 'increment'],
  ]);

  state = startNext(state);
  assert.equal(nextClusterWave(state), null);
  state = finish(state, 'astra', ref('astra-initial', 'a'));
  assert.equal(nextClusterWave(state), null);
  state = finish(state, 'opus', ref('opus-initial', 'b'));

  const cross = nextClusterWave(state);
  assert.equal(cross?.id, 'cross-1');
  assert.deepEqual(cross?.tasks.map(task => [task.role, task.reads]), [
    ['astra', [ref('opus-initial', 'b')]],
    ['opus', [ref('astra-initial', 'a')]],
  ]);
});

test('full mode deterministically completes Carbon, parallel initial memos, then two parallel cross rounds', () => {
  let state = createClusterState(identity, parseClusterSubmit({ mode: 'full', draft: '架构初稿', crossRounds: 2 }));
  assert.deepEqual(nextClusterWave(state)?.tasks.map(task => task.role), ['carbon']);
  state = startNext(state);
  state = finish(state, 'carbon', ref('carbon', 'c'));

  const initial = nextClusterWave(state);
  assert.deepEqual(initial?.tasks.map(task => [task.role, task.reads]), [
    ['astra', [ref('carbon', 'c')]], ['opus', [ref('carbon', 'c')]],
  ]);
  state = startNext(state);
  state = finish(state, 'astra', ref('astra-0', 'd'));
  state = finish(state, 'opus', ref('opus-0', 'e'));

  state = startNext(state);
  state = finish(state, 'astra', ref('astra-1', 'f'));
  state = finish(state, 'opus', ref('opus-1', '0'));
  const secondCross = nextClusterWave(state);
  assert.equal(secondCross?.id, 'cross-2');
  assert.deepEqual(secondCross?.tasks.map(task => [task.role, task.reads]), [
    ['astra', [ref('opus-1', '0')]], ['opus', [ref('astra-1', 'f')]],
  ]);

  state = startNext(state);
  state = finish(state, 'astra', ref('astra-2', '1'));
  state = finish(state, 'opus', ref('opus-2', '2'));
  assert.equal(state.status, 'completed');
  assert.equal(nextClusterWave(state), null);

  const aggregate = buildClusterAggregate(state);
  assert.deepEqual(aggregate.entries.map(entry => [entry.order, entry.waveId, entry.role, entry.ref, entry.trust]), [
    [0, 'ideas', 'carbon', 'results/carbon.md', 'untrusted'],
    [1, 'initial', 'astra', 'results/astra-0.md', 'untrusted'],
    [2, 'initial', 'opus', 'results/opus-0.md', 'untrusted'],
    [3, 'cross-1', 'astra', 'results/astra-1.md', 'untrusted'],
    [4, 'cross-1', 'opus', 'results/opus-1.md', 'untrusted'],
    [5, 'cross-2', 'astra', 'results/astra-2.md', 'untrusted'],
    [6, 'cross-2', 'opus', 'results/opus-2.md', 'untrusted'],
  ]);
  assert.equal(JSON.stringify(aggregate).includes('架构初稿'), false);
});

test('result references are validated and terminal task results are immutable', () => {
  let state = createClusterState(identity, parseClusterSubmit({ mode: 'pair', draft: '初稿' }));
  state = startNext(state);
  const astra = state.waves[0]?.tasks[0];
  assert.ok(astra);
  assert.throws(() => updateClusterTask(state, astra.taskId, {
    status: 'completed', result: { ref: 'results/astra.md', hash: 'not-a-hash' },
  }));
  state = updateClusterTask(state, astra.taskId, { status: 'completed', result: ref('astra', 'a') });
  assert.throws(() => updateClusterTask(state, astra.taskId, { status: 'completed', result: ref('replacement', 'b') }), /terminal|\u7ec8态/);
  assert.throws(() => buildClusterAggregate(state), /\u672a完成/);
});

test('a failed child makes the cluster terminal without scheduling another wave', () => {
  let state = createClusterState(identity, parseClusterSubmit({ mode: 'pair', draft: '初稿' }));
  state = startNext(state);
  const taskId = state.waves[0]?.tasks[0]?.taskId;
  assert.ok(taskId);
  state = updateClusterTask(state, taskId, { status: 'failed' });
  assert.equal(state.status, 'failed');
  assert.throws(() => nextClusterWave(state), /\u5df2失败/);
});
