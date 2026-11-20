import type { BudgetCall, BuildLimits, JobBudget } from './types.js';

const minuteMs = 60_000;

type BudgetCheck = {
  writer?: boolean;
  newRound?: boolean;
  reserveFinalReview?: boolean;
  now?: string;
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function remove(values: string[], id: string): void {
  let index = values.indexOf(id);
  while (index >= 0) {
    values.splice(index, 1);
    index = values.indexOf(id);
  }
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是合法时间`);
  return parsed;
}

function findCall(budget: JobBudget, id: string): BudgetCall {
  const call = budget.calls.find((item) => item.id === id);
  if (!call) throw new Error(`预算调用不存在：${id}`);
  return call;
}

function unresolvedReason(budget: JobBudget): string | null {
  if (budget.calls.some((call) => call.state === 'unknown')) {
    return '存在启动或结束状态未知的模型调用，确认前不能继续派发';
  }
  return null;
}

function refreshExhaustion(budget: JobBudget, now?: string): void {
  budget.exhaustedReason = budgetBlockReason(budget, { now });
}

export function createJobBudget(limits: BuildLimits): JobBudget {
  return {
    limits: { ...limits },
    usage: { buildRounds: 0, writerSessions: 0, modelCalls: 0, activeMs: 0 },
    reservedCalls: [],
    reservedWriterSessions: [],
    exhaustedReason: null,
    calls: [],
  };
}

/**
 * Returns the remaining active runtime. Running calls consume time from their
 * recorded start until `now`; settled calls are already included in usage.
 */
export function remainingActiveMs(budget: JobBudget, now: string): number {
  const asOf = timestamp(now, 'now');
  let runningMs = 0;
  for (const call of budget.calls) {
    if (call.state !== 'started') continue;
    if (!call.startedAt) return 0;
    const started = timestamp(call.startedAt, `调用 ${call.id} 的 startedAt`);
    runningMs += Math.max(0, asOf - started);
  }
  const limitMs = budget.limits.maxActiveMinutes * minuteMs;
  return Math.max(0, limitMs - budget.usage.activeMs - runningMs);
}

/**
 * Checks a prospective operation. Supplying `writer` (including false) means
 * one new model call; reserveFinalReview holds one additional call slot.
 */
export function budgetBlockReason(budget: JobBudget, check: BudgetCheck = {}): string | null {
  const unknown = unresolvedReason(budget);
  if (unknown) return unknown;

  const callRequested = Object.prototype.hasOwnProperty.call(check, 'writer');
  const requestedCalls = (callRequested ? 1 : 0) + (check.reserveFinalReview ? 1 : 0);
  const callsInUse = budget.usage.modelCalls + unique(budget.reservedCalls).length;
  if (callsInUse + requestedCalls > budget.limits.maxModelCalls) {
    return check.reserveFinalReview
      ? '模型调用预算不足，无法同时保留一次终审调用'
      : '模型调用预算已耗尽';
  }

  const requestedWriters = callRequested && check.writer ? 1 : 0;
  const writersInUse = budget.usage.writerSessions + unique(budget.reservedWriterSessions).length;
  if (writersInUse + requestedWriters > budget.limits.maxWriterSessions) {
    return '写者会话预算已耗尽';
  }

  if (budget.usage.buildRounds + (check.newRound ? 1 : 0) > budget.limits.maxRounds) {
    return '构建轮次预算已耗尽';
  }

  if (budget.usage.activeMs >= budget.limits.maxActiveMinutes * minuteMs) {
    return '主动运行时间预算已耗尽';
  }
  if (check.now && remainingActiveMs(budget, check.now) <= 0) {
    return '主动运行时间预算已耗尽';
  }
  return null;
}

export function reserveBudgetCall(
  budget: JobBudget,
  id: string,
  taskId: string,
  kind: BudgetCall['kind'],
  writer: boolean,
  now: string,
): BudgetCall {
  timestamp(now, 'now');
  const existing = budget.calls.find((call) => call.id === id);
  if (existing) {
    if (existing.taskId !== taskId || existing.kind !== kind || existing.writer !== writer) {
      throw new Error(`预算调用编号已被其他调用占用：${id}`);
    }
    return existing;
  }

  const reason = budgetBlockReason(budget, { writer, now });
  if (reason) {
    budget.exhaustedReason = reason;
    throw new Error(reason);
  }

  const call: BudgetCall = {
    id,
    taskId,
    kind,
    writer,
    state: 'reserved',
    startedAt: null,
    endedAt: null,
    activeMs: null,
  };
  budget.calls.push(call);
  budget.reservedCalls.push(id);
  if (writer) budget.reservedWriterSessions.push(id);
  budget.exhaustedReason = null;
  return call;
}

export function startBudgetCall(budget: JobBudget, id: string, now: string): BudgetCall {
  timestamp(now, 'now');
  const call = findCall(budget, id);
  if (call.state === 'started' || call.state === 'settled' || (call.state === 'unknown' && call.startedAt)) {
    return call;
  }
  if (call.state === 'not_started') throw new Error(`调用 ${id} 已确认未启动`);
  if (call.state === 'unknown') throw new Error(`调用 ${id} 的启动状态未知`);

  call.state = 'started';
  call.startedAt = now;
  budget.usage.modelCalls += 1;
  if (call.writer) budget.usage.writerSessions += 1;
  remove(budget.reservedCalls, id);
  remove(budget.reservedWriterSessions, id);
  refreshExhaustion(budget, now);
  return call;
}

export function settleBudgetCall(
  budget: JobBudget,
  id: string,
  result: { started: boolean; endedAt: string | null; activeMs: number | null },
): BudgetCall {
  if (result.endedAt !== null) timestamp(result.endedAt, 'endedAt');
  if (result.activeMs !== null && (!Number.isFinite(result.activeMs) || result.activeMs < 0)) {
    throw new Error('activeMs 必须是非负有限数或 null');
  }
  const call = findCall(budget, id);

  if (!result.started) {
    if (call.state === 'settled' || (call.state === 'unknown' && call.startedAt)) {
      return call; // Confirmed starts are never refunded by later negative evidence.
    }
    if (call.state === 'started') {
      call.state = 'unknown';
      call.endedAt = result.endedAt;
      call.activeMs = null;
      refreshExhaustion(budget, result.endedAt ?? call.startedAt ?? undefined);
      return call;
    }
    call.state = 'not_started';
    call.endedAt = result.endedAt;
    call.activeMs = null;
    remove(budget.reservedCalls, id);
    remove(budget.reservedWriterSessions, id);
    refreshExhaustion(budget, result.endedAt ?? undefined);
    return call;
  }

  if (call.state === 'not_started') throw new Error(`调用 ${id} 已确认未启动，不能再结算为已启动`);
  if (call.state === 'reserved') {
    // Crash recovery can prove that a process started without recovering its
    // exact start timestamp. Count the real invocation, but keep time unknown
    // unless the caller supplies measured activeMs; never invent a timestamp.
    budget.usage.modelCalls += 1;
    if (call.writer) budget.usage.writerSessions += 1;
    remove(budget.reservedCalls, id);
    remove(budget.reservedWriterSessions, id);
    call.state = 'unknown';
  }
  if (call.state === 'settled') {
    if (call.endedAt !== result.endedAt || call.activeMs !== result.activeMs) {
      throw new Error(`调用 ${id} 已按不同结果结算`);
    }
    return call;
  }

  if (result.endedAt === null || result.activeMs === null) {
    call.state = 'unknown';
    call.endedAt = result.endedAt;
    call.activeMs = null;
    remove(budget.reservedCalls, id);
    remove(budget.reservedWriterSessions, id);
    refreshExhaustion(budget, result.endedAt ?? call.startedAt ?? undefined);
    return call;
  }

  call.state = 'settled';
  call.endedAt = result.endedAt;
  call.activeMs = result.activeMs;
  budget.usage.activeMs += result.activeMs;
  remove(budget.reservedCalls, id);
  remove(budget.reservedWriterSessions, id);
  refreshExhaustion(budget, result.endedAt);
  return call;
}

export function reserveBuildRound(budget: JobBudget): number {
  const reason = budgetBlockReason(budget, { newRound: true });
  if (reason) {
    budget.exhaustedReason = reason;
    throw new Error(reason);
  }
  budget.usage.buildRounds += 1;
  refreshExhaustion(budget);
  return budget.usage.buildRounds;
}
