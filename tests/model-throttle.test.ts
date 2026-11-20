import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelThrottle } from '../src/chat/model-throttle.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import { createProviderSession } from '../src/providers/session.js';
import type { ModelSpec, ProviderEvent } from '../src/providers/types.js';

const model: ModelSpec = {
  id: 'throttle-model', provider: 'fixture', family: 'fixture', protocol: 'openai-responses',
  apiKeyEnv: 'THROTTLE_TEST_KEY', contextWindow: 10_000, maxOutputTokens: 1_000, efforts: ['high'],
};

test('model throttle grants FIFO slots and removes an aborted waiter', async () => {
  const throttle = new ModelThrottle();
  const hooks = throttle.hooks(model.id, 1);
  const first = await hooks.beforeAttempt!(new AbortController().signal);
  const order: number[] = [];
  const second = hooks.beforeAttempt!(new AbortController().signal).then(release => { order.push(2); return release; });
  const aborted = new AbortController();
  const third = hooks.beforeAttempt!(aborted.signal);
  const fourth = hooks.beforeAttempt!(new AbortController().signal).then(release => { order.push(4); return release; });
  aborted.abort();
  await assert.rejects(third, error => error instanceof DOMException && error.name === 'AbortError');
  assert.deepEqual(throttle.metrics(model.id), { capacity: 1, limit: 1, active: 1, queued: 2, cooldownUntil: 0 });
  first();
  const releaseSecond = await second;
  assert.deepEqual(order, [2]);
  releaseSecond();
  const releaseFourth = await fourth;
  assert.deepEqual(order, [2, 4]);
  releaseFourth();
  assert.equal(throttle.metrics(model.id)?.active, 0);
});

test('429 halves the limit, honors cooldown, and sustained success restores capacity', async () => {
  const throttle = new ModelThrottle();
  const hooks = throttle.hooks(model.id, 4);
  const release = await hooks.beforeAttempt!(new AbortController().signal);
  hooks.onRateLimit!(40);
  release();
  assert.equal(throttle.metrics(model.id)?.limit, 2);
  let admitted = false;
  const queued = hooks.beforeAttempt!(new AbortController().signal).then(value => { admitted = true; return value; });
  assert.equal(admitted, false);
  assert.equal(throttle.metrics(model.id)?.queued, 1);
  const afterCooldown = await queued;
  afterCooldown();
  for (let index = 0; index < 2; index++) {
    const done = await hooks.beforeAttempt!(new AbortController().signal);
    hooks.onSuccess!();
    done();
  }
  assert.equal(throttle.metrics(model.id)?.limit, 3);
  for (let index = 0; index < 3; index++) {
    const done = await hooks.beforeAttempt!(new AbortController().signal);
    hooks.onSuccess!();
    done();
  }
  assert.equal(throttle.metrics(model.id)?.limit, 4);
});

test('provider retries acquire and release every attempt and report only 429 and success', async () => {
  const throttle = new ModelThrottle();
  const adaptive = throttle.hooks(model.id, 4);
  let acquired = 0;
  let released = 0;
  let limited = 0;
  let succeeded = 0;
  let observedFailure!: () => void;
  const failed = new Promise<void>(resolve => { observedFailure = resolve; });
  const session = createProviderSession({
    model, effort: 'high', cacheKey: 'retry-hooks', system: 'fixture', tools: [], maxOutputTokens: 100,
    requestHooks: {
      beforeAttempt: async signal => {
        const release = await adaptive.beforeAttempt!(signal);
        acquired++;
        return () => { released++; release(); };
      },
      onRateLimit: retryAfter => { limited++; adaptive.onRateLimit!(retryAfter); },
      onSuccess: () => { succeeded++; adaptive.onSuccess!(); },
    },
  }, {
    apiKey: '', encode: input => [input],
    request: async history => {
      if (acquired === 1) {
        observedFailure();
        throw Object.assign(new Error('fixture rate limit'), { status: 429, headers: { 'retry-after': '0' } });
      }
      return {
        reason: 'stop' as const, historyItems: [...history], toolCalls: [], events: [],
        usage: { type: 'usage' as const, input: 3, cachedInput: 0, output: 1 },
      };
    },
  });
  const events: ProviderEvent[] = [];
  const running = (async () => {
    for await (const event of session.send({ text: 'start' }, new AbortController().signal)) events.push(event);
  })();
  await failed;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual({ acquired, released, active: throttle.metrics(model.id)?.active }, { acquired: 1, released: 1, active: 0 });
  await running;
  assert.deepEqual({ acquired, released, limited, succeeded }, { acquired: 2, released: 2, limited: 1, succeeded: 1 });
  assert.equal(throttle.metrics(model.id)?.active, 0);
  assert.deepEqual(events.at(-1), { type: 'end', reason: 'stop' });
});

test('unlimited capacity becomes an adaptive finite gate after a 429', async () => {
  const throttle = new ModelThrottle();
  const hooks = throttle.hooks('unlimited', null);
  const releases = await Promise.all(Array.from({ length: 6 }, () => hooks.beforeAttempt!(new AbortController().signal)));
  hooks.onRateLimit!(0);
  assert.equal(throttle.metrics('unlimited')?.limit, 3);
  releases.forEach(release => release());
  const done = await hooks.beforeAttempt!(new AbortController().signal);
  hooks.onSuccess!();
  done();
  assert.equal(throttle.metrics('unlimited')?.capacity, null);
});

test('aborting the last cooldown waiter removes its timer and queue entry', async () => {
  const throttle = new ModelThrottle();
  const hooks = throttle.hooks('cooldown-cancel', 2);
  const release = await hooks.beforeAttempt!(new AbortController().signal);
  hooks.onRateLimit!(60_000);
  release();
  const controller = new AbortController();
  const waiting = hooks.beforeAttempt!(controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(throttle.metrics('cooldown-cancel')?.queued, 0);
});

test('shared models use the smallest registered finite capacity and scripted sessions preserve hooks', async () => {
  const throttle = new ModelThrottle();
  throttle.hooks('shared', 64);
  const hooks = throttle.hooks('shared', 6);
  assert.equal(throttle.metrics('shared')?.capacity, 6);
  let attempts = 0;
  const provider = new ScriptedProvider(() => {
    attempts++;
    return [{ type: 'usage', input: 1, cachedInput: 0, output: 1 }, { type: 'end', reason: 'stop' }];
  });
  const session = provider.open({
    model, effort: 'high', cacheKey: 'script-hooks', system: 'fixture', tools: [], maxOutputTokens: 100,
    requestHooks: hooks,
  });
  for await (const _event of session.send({ text: 'start' }, new AbortController().signal)) { /* drain */ }
  assert.equal(attempts, 1);
  assert.equal(throttle.metrics('shared')?.active, 0);
});
