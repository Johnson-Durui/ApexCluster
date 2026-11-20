import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { LiveNativeCallBudget, LiveNativeCallBudgetExceeded, type LiveBudgetState } from '../scripts/chat-live-budget.js';

const script = 'scripts/chat-live-workflow-probe.ts';

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
}

test('workflow probe documents separate Runtime and native-call budgets', () => {
  const child = run(['--help']);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /--max-native-calls 1-312/);
  assert.match(child.stdout, /defaults to 24/);
  assert.match(child.stdout, /Runtime invocations retain their fixed limit of 24/);
  assert.match(child.stdout, /Grok is observed and charged before every injected Cursor round/);
  assert.match(child.stdout, /Claude\/Astra\/Sol reserve one call/);
});

test('workflow probe rejects malformed, out-of-range and duplicate native-call budgets before preflight', () => {
  for (const [value, expected] of [['0', /1-312/], ['313', /1-312/], ['1.5', /整数/], ['abc', /整数/]] as const) {
    const child = run(['--proof-dir', 'E:\\missing-proof', '--app-root', 'E:\\missing-app', '--max-native-calls', value]);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, expected);
    assert.doesNotMatch(child.stderr, /compiled app file missing|proof missing/);
  }
  const duplicate = run(['--proof-dir', 'E:\\missing-proof', '--app-root', 'E:\\missing-app', '--max-native-calls', '14', '--max-native-calls', '14']);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /--max-native-calls 重复/);
});

function state(maximumNativeCallsReserved = 2): LiveBudgetState {
  return { maximumNativeCallsReserved, nativeCallsReserved: 0, nativeCliInvocations: 0, nativeCallsReservedByRole: {}, nativeCliInvocationsByRole: {} };
}

test('unobserved driver reservations consume budget without being reported as actual native CLI invocations', () => {
  const value = state(1); let persisted = 0; const budget = new LiveNativeCallBudget(value, () => { persisted += 1; });
  budget.reserve('claude', false);
  assert.deepEqual(value, { maximumNativeCallsReserved: 1, nativeCallsReserved: 1, nativeCliInvocations: 0, nativeCallsReservedByRole: { claude: 1 }, nativeCliInvocationsByRole: {} });
  assert.equal(persisted, 1);
  assert.throws(() => budget.reserve('sol', false), (error: unknown) => error instanceof LiveNativeCallBudgetExceeded && error.exitConfirmed === true);
  assert.equal(persisted, 1);
});

test('observed Cursor rounds are charged before dispatch and an over-budget round never starts', async () => {
  const value = state(2); const events: string[] = [];
  const budget = new LiveNativeCallBudget(value, () => { events.push(`persist:${value.nativeCliInvocations}`); });
  const dispatch = async () => { events.push(`dispatch:${value.nativeCliInvocations}`); return value.nativeCliInvocations; };
  assert.equal(await budget.runObserved('grok', dispatch), 1);
  assert.equal(await budget.runObserved('grok', dispatch), 2);
  await assert.rejects(budget.runObserved('grok', dispatch), /原生调用预算已满/);
  assert.deepEqual(events, ['persist:1', 'dispatch:1', 'persist:2', 'dispatch:2']);
  assert.deepEqual(value.nativeCallsReservedByRole, { grok: 2 });
  assert.deepEqual(value.nativeCliInvocationsByRole, { grok: 2 });
});
