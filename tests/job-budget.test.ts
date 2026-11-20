import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetBlockReason,
  createJobBudget,
  remainingActiveMs,
  reserveBudgetCall,
  reserveBuildRound,
  settleBudgetCall,
  startBudgetCall,
} from '../src/core/job-budget.js';

const limits = { maxRounds: 2, maxWriterSessions: 2, maxModelCalls: 4, maxActiveMinutes: 10 };
const t0 = '2026-10-23T00:00:00.000Z';
const t1 = '2026-10-23T00:01:00.000Z';

test('预留、启动和结算按调用编号幂等，真实启动才计次数', () => {
  const budget = createJobBudget(limits);
  const first = reserveBudgetCall(budget, 'c1', 't1', 'initial', true, t0);
  assert.equal(reserveBudgetCall(budget, 'c1', 't1', 'initial', true, t0), first);
  assert.deepEqual(budget.usage, { buildRounds: 0, writerSessions: 0, modelCalls: 0, activeMs: 0 });
  assert.deepEqual(budget.reservedCalls, ['c1']);

  startBudgetCall(budget, 'c1', t0);
  startBudgetCall(budget, 'c1', t1);
  assert.equal(budget.usage.modelCalls, 1);
  assert.equal(budget.usage.writerSessions, 1);
  assert.deepEqual(budget.reservedCalls, []);

  settleBudgetCall(budget, 'c1', { started: true, endedAt: t1, activeMs: 60_000 });
  settleBudgetCall(budget, 'c1', { started: true, endedAt: t1, activeMs: 60_000 });
  assert.equal(budget.usage.activeMs, 60_000);
  assert.equal(first.state, 'settled');
});

test('并发双派发受预留保护，未启动证据释放预留且不产生用量', () => {
  const budget = createJobBudget({ ...limits, maxModelCalls: 1, maxWriterSessions: 1 });
  reserveBudgetCall(budget, 'c1', 't1', 'initial', true, t0);
  assert.throws(() => reserveBudgetCall(budget, 'c2', 't2', 'initial', true, t0), /调用预算/);
  settleBudgetCall(budget, 'c1', { started: false, endedAt: t1, activeMs: null });
  assert.deepEqual(budget.usage, { buildRounds: 0, writerSessions: 0, modelCalls: 0, activeMs: 0 });
  assert.equal(budget.calls[0]!.state, 'not_started');
  assert.doesNotThrow(() => reserveBudgetCall(budget, 'c2', 't2', 'initial', true, t1));
});

test('失败或取消仍累计全部已启动调用时长；结构修复只占总调用不占写者', () => {
  const budget = createJobBudget(limits);
  reserveBudgetCall(budget, 'build', 'tb', 'initial', true, t0);
  startBudgetCall(budget, 'build', t0);
  settleBudgetCall(budget, 'build', { started: true, endedAt: t1, activeMs: 40_000 });

  reserveBudgetCall(budget, 'repair', 'tb-repair', 'repair', false, t1);
  startBudgetCall(budget, 'repair', t1);
  settleBudgetCall(budget, 'repair', { started: true, endedAt: '2026-10-23T00:01:20.000Z', activeMs: 20_000 });
  assert.deepEqual(budget.usage, { buildRounds: 0, writerSessions: 1, modelCalls: 2, activeMs: 60_000 });
});

test('未知结束不伪造零时长并阻断新调用，补齐证据后可幂等结算', () => {
  const budget = createJobBudget(limits);
  reserveBudgetCall(budget, 'c1', 't1', 'initial', true, t0);
  startBudgetCall(budget, 'c1', t0);
  settleBudgetCall(budget, 'c1', { started: true, endedAt: null, activeMs: null });
  assert.equal(budget.calls[0]!.state, 'unknown');
  assert.equal(budget.usage.activeMs, 0);
  assert.match(budgetBlockReason(budget, { writer: false, now: t1 })!, /未知/);

  settleBudgetCall(budget, 'c1', { started: true, endedAt: t1, activeMs: 60_000 });
  assert.equal(budget.calls[0]!.state, 'settled');
  assert.equal(budget.usage.activeMs, 60_000);
});

test('恢复时只证明确已启动也会计调用，但不伪造启动时间或运行时长', () => {
  const budget = createJobBudget(limits);
  const call = reserveBudgetCall(budget, 'c1', 't1', 'initial', true, t0);
  settleBudgetCall(budget, 'c1', { started: true, endedAt: null, activeMs: null });
  assert.equal(call.state, 'unknown');
  assert.equal(call.startedAt, null);
  assert.equal(budget.usage.modelCalls, 1);
  assert.equal(budget.usage.writerSessions, 1);
  assert.equal(budget.usage.activeMs, 0);
  assert.match(budgetBlockReason(budget, { writer: false, now: t1 })!, /未知/);
});

test('运行中的调用动态占用时间盒，达到上限后阻断', () => {
  const budget = createJobBudget({ ...limits, maxActiveMinutes: 1 });
  reserveBudgetCall(budget, 'c1', 't1', 'initial', false, t0);
  startBudgetCall(budget, 'c1', t0);
  assert.equal(remainingActiveMs(budget, '2026-10-23T00:00:30.000Z'), 30_000);
  assert.equal(remainingActiveMs(budget, t1), 0);
  assert.match(budgetBlockReason(budget, { writer: false, now: t1 })!, /时间预算/);
});

test('普通派发可保留一次终审，终审槽位不足时提前阻断', () => {
  const budget = createJobBudget({ ...limits, maxModelCalls: 2 });
  assert.equal(budgetBlockReason(budget, { writer: true, reserveFinalReview: true, now: t0 }), null);
  reserveBudgetCall(budget, 'build', 'tb', 'initial', true, t0);
  startBudgetCall(budget, 'build', t0);
  assert.match(budgetBlockReason(budget, { writer: false, reserveFinalReview: true, now: t1 })!, /终审/);
  assert.equal(budgetBlockReason(budget, { writer: false, now: t1 }), null);
});

test('轮次和手动重试共享同一预算，调用方不能通过重试清零', () => {
  const budget = createJobBudget({ ...limits, maxRounds: 1, maxModelCalls: 2 });
  assert.equal(reserveBuildRound(budget), 1);
  assert.throws(() => reserveBuildRound(budget), /轮次预算/);

  reserveBudgetCall(budget, 'attempt-1', 'task-a1', 'initial', true, t0);
  startBudgetCall(budget, 'attempt-1', t0);
  settleBudgetCall(budget, 'attempt-1', { started: true, endedAt: t1, activeMs: 1 });
  reserveBudgetCall(budget, 'manual-retry', 'task-a2', 'initial', true, t1);
  startBudgetCall(budget, 'manual-retry', t1);
  assert.equal(budget.usage.modelCalls, 2);
  assert.throws(() => reserveBudgetCall(budget, 'attempt-3', 'task-a3', 'initial', true, t1), /调用预算/);
});

test('已确认启动的用量不会被 started=false 证据退回', () => {
  const budget = createJobBudget(limits);
  reserveBudgetCall(budget, 'c1', 't1', 'initial', true, t0);
  startBudgetCall(budget, 'c1', t0);
  settleBudgetCall(budget, 'c1', { started: false, endedAt: null, activeMs: null });
  assert.equal(budget.usage.modelCalls, 1);
  assert.equal(budget.usage.writerSessions, 1);
  assert.equal(budget.calls[0]!.state, 'unknown');
});

test('非法结算证据在修改预算前被拒绝', () => {
  const budget = createJobBudget(limits);
  reserveBudgetCall(budget, 'c1', 't1', 'initial', true, t0);
  assert.throws(
    () => settleBudgetCall(budget, 'c1', { started: true, endedAt: 'invalid', activeMs: -1 }),
    /endedAt|activeMs/,
  );
  assert.equal(budget.calls[0]!.state, 'reserved');
  assert.equal(budget.usage.modelCalls, 0);
});
