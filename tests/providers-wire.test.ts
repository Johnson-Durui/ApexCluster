import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { modelProviderFor } from '../src/providers/factory.js';
import type { ModelSpec, ProviderEvent, ProviderInput, ProviderRequestHooks, ProviderSession, WireProtocol } from '../src/providers/types.js';
import { fakeApi, json, sse, stream, type RecordedRequest } from './fixtures/fake-api/server.js';
import { wireReply } from './fixtures/fake-api/wire.js';

const keyName = 'DMW_MODEL_TEST_KEY';
const key = process.env[keyName] ?? `fixture-canary-${randomUUID()}`;
process.env[keyName] = key;
const systemText = 'Fake API test';
const endpoints: Record<WireProtocol, string> = {
  'anthropic-messages': '/v1/messages', 'openai-responses': '/responses',
  'google-genai': '/v1/interactions', 'openai-chat': '/chat/completions',
};
const matrix = [
  ['anthropic-messages', 'anthropic'], ['openai-responses', 'openai'],
  ['google-genai', 'google'], ['openai-chat', 'community'],
  ['openai-responses', 'xai'], ['openai-responses', 'deepseek'],
] as const;

function openCase(baseUrl: string, protocol: WireProtocol, provider: string, requestHooks?: ProviderRequestHooks): ProviderSession {
  const model: ModelSpec = {
    id: 'fake-model-001', provider, family: provider, protocol, baseUrl, apiKeyEnv: keyName,
    contextWindow: 1000, maxOutputTokens: 128, efforts: ['high'],
  };
  return modelProviderFor(protocol).open({
    model, effort: 'high', system: systemText, cacheKey: 'fake-cache-key', maxOutputTokens: 100, requestHooks,
    tools: [{ name: 'echo', description: 'Echo an index', inputSchema: {
      type: 'object', properties: { index: { type: 'integer' } }, required: ['index'], additionalProperties: false,
    } }],
  });
}

async function events(session: ProviderSession, input: ProviderInput, signal = new AbortController().signal): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of session.send(input, signal)) collected.push(event);
  return collected;
}

/** OpenAI Responses carries the system prompt as a leading developer item; other input-based wires start with the user turn. */
const leadingSystemItems = (protocol: WireProtocol, provider: string) => protocol === 'openai-responses' && provider === 'openai' ? 1 : 0;

function replay(protocol: WireProtocol, provider: string, request: RecordedRequest, count: number): unknown[] {
  const input = request.body.input as unknown[];
  const messages = request.body.messages as { role: string; content: unknown[] }[];
  switch (protocol) {
    case 'anthropic-messages': return messages.find(message => message.role === 'assistant')!.content;
    case 'openai-chat': return [messages.find(message => message.role === 'assistant')];
    default: {
      const start = leadingSystemItems(protocol, provider) + 1;
      return input.slice(start, start + count);
    }
  }
}

function assertResponsesSystemPlacement(request: RecordedRequest, provider: string): void {
  const input = request.body.input as unknown[];
  if (provider === 'openai') {
    assert.equal('instructions' in request.body, false);
    assert.deepEqual(input[0], { role: 'developer', content: systemText });
    assert.equal(input.filter(item => (item as { role?: string }).role === 'developer').length, 1);
  } else {
    assert.equal(request.body.instructions, systemText);
    assert.equal(input.some(item => (item as { role?: string }).role === 'developer'), false);
  }
  assert.deepEqual(input[leadingSystemItems('openai-responses', provider)], { role: 'user', content: 'Start' });
}

function assertStateless(request: RecordedRequest, protocol: WireProtocol, provider: string): void {
  assert.equal(request.path.split('?')[0], endpoints[protocol]);
  assert.equal(request.body.model, 'fake-model-001');
  assert.equal(request.body.stream, true);
  assert.ok(request.body.store === false || request.body.store === undefined);
  for (const field of ['context_management', 'context_editing', 'previous_response_id', 'conversation', 'compaction']) {
    assert.equal(field in request.body, false);
  }
  if (provider === 'deepseek') {
    for (const field of ['include', 'prompt_cache_key', 'store']) assert.equal(field in request.body, false);
  }
  if (protocol === 'openai-responses') {
    assert.equal((request.body.reasoning as Record<string, unknown>).summary, provider === 'openai' ? 'auto' : undefined);
    assertResponsesSystemPlacement(request, provider);
  }
  assert.equal(JSON.stringify(request).includes(key), false);
}

test('five vendors and the compatible chat protocol use the same offline wire contract', { concurrency: matrix.length, timeout: 90_000 }, async t => {
  await Promise.all(matrix.map(([protocol, provider]) => t.test(`${provider}: ${protocol}`, { timeout: 85_000 }, async t => {
    const reply = (count = 0, refusal = false) => wireReply(protocol, 'fake-model-001', count, { refusal, deepseek: provider === 'deepseek' });
    for (const count of [0, 1, 2]) {
      await t.test(`${count} tool calls, usage and native replay`, async () => {
        const initial = reply(count);
        const server = await fakeApi((request, response) => {
          assertStateless(request, protocol, provider);
          if (server.requests.length === 2) assert.deepEqual(replay(protocol, provider, request, initial.replay.length), initial.replay);
          stream(response, (server.requests.length === 1 ? initial : reply()).frames);
        });
        try {
          const session = openCase(server.url, protocol, provider);
          const first = await events(session, { text: 'Start' });
          assert.deepEqual(first.filter(item => item.type === 'text').map(item => item.delta), ['Hello, ', 'world']);
          const calls = first.filter(item => item.type === 'tool_call');
          assert.equal(calls.length, count);
          assert.deepEqual(first.at(-1), { type: 'end', reason: count ? 'tool_calls' : 'stop' });
          assert.deepEqual(session.occupancy(), { input: 120, output: 40 });
          const usage = first.find(item => item.type === 'usage');
          const metadata = first.find(item => item.type === 'response_metadata');
          assert.equal(metadata?.modelId, 'fake-model-001');
          assert.equal(metadata?.effort, protocol === 'openai-responses' ? 'high' : undefined);
          assert.equal(usage?.cachedInput, 13);
          if (protocol === 'anthropic-messages') assert.equal(usage?.cacheWrite, 7);
          else assert.equal(usage?.reasoning, 4);
          assert.deepEqual(calls.map(call => call.args), Array.from({ length: count }, (_, index) => ({ index })));
          const second = await events(session, count
            ? { toolResults: calls.map(call => ({ callId: call.callId, text: 'Receipt' })) }
            : { text: 'Continue' });
          assert.deepEqual(second.at(-1), { type: 'end', reason: 'stop' });
          assert.equal(server.requests.length, 2);
          assert.equal(JSON.stringify([first, second, server.requests]).includes(key), false);
        } finally {
          await server.close();
        }
      });
    }

    await t.test('429 honors Retry-After and resends the identical body', async () => {
      const started: number[] = [];
      const attempts: string[] = [];
      const hooks: ProviderRequestHooks = {
        beforeAttempt: async () => { attempts.push('acquire'); return () => { attempts.push('release'); }; },
        onRateLimit: () => { attempts.push('rate-limited'); },
        onSuccess: () => { attempts.push('success'); },
      };
      const server = await fakeApi((_request, response) => {
        started.push(Date.now());
        if (started.length === 1) json(response, 429, { error: { message: 'Slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, { 'retry-after': '1' });
        else stream(response, reply().frames);
      });
      try {
        assert.deepEqual((await events(openCase(server.url, protocol, provider, hooks), { text: 'Start' })).at(-1), { type: 'end', reason: 'stop' });
        assert.equal(started.length, 2);
        assert.ok(started[1]! - started[0]! >= 950);
        assert.deepEqual(server.requests[0], server.requests[1]);
        assert.deepEqual(attempts, ['acquire', 'rate-limited', 'release', 'acquire', 'success', 'release']);
      } finally {
        await server.close();
      }
    });

    await t.test('5xx exhausts six retries and redacts the canary', async () => {
      const server = await fakeApi((_request, response) => json(response, 503, { error: { message: `Failure ${key}`, type: 'api_error' } }));
      try {
        await assert.rejects(events(openCase(server.url, protocol, provider), { text: 'Start' }), error => {
          return error instanceof Error && !JSON.stringify([error.message, error.stack, error]).includes(key);
        });
        assert.equal(server.requests.length, 7);
        for (const request of server.requests) assert.deepEqual(request, server.requests[0]);
      } finally {
        await server.close();
      }
    });

    await t.test('disconnect discards partial tool and text events before retry', async () => {
      const server = await fakeApi(async (_request, response) => {
        if (server.requests.length > 1) { stream(response, reply().frames); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const frames = reply(1).frames;
        const partial = frames.slice(0, -3).join('');
        response.write(partial);
        await delay(50);
        response.destroy();
      });
      try {
        const result = await events(openCase(server.url, protocol, provider), { text: 'Start' });
        assert.deepEqual(result.filter(item => item.type === 'text').map(item => item.delta), ['Hello, ', 'world']);
        assert.equal(result.some(item => item.type === 'tool_call'), false);
        assert.equal(server.requests.length, 2);
        assert.deepEqual(server.requests[0], server.requests[1]);
      } finally {
        await server.close();
      }
    });

    await t.test('cancel aborts the active connection', { timeout: 8_000 }, async () => {
      let opened!: () => void;
      let closed!: () => void;
      const openedPromise = new Promise<void>(resolve => { opened = resolve; });
      const closedPromise = new Promise<void>(resolve => { closed = resolve; });
      const server = await fakeApi((_request, response) => {
        response.once('close', closed);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(reply(1).frames[0]!);
        opened();
      });
      try {
        const controller = new AbortController();
        const completion = assert.rejects(events(openCase(server.url, protocol, provider), { text: 'Start' }, controller.signal), { name: 'AbortError' });
        await openedPromise;
        controller.abort(key);
        await completion;
        await closedPromise;
        assert.equal(server.requests.length, 1);
      } finally {
        await server.close();
      }
    });

    await t.test('refusal and context overflow are terminal without replay', async () => {
      const server = await fakeApi((_request, response) => {
        if (server.requests.length === 1) stream(response, reply(0, true).frames);
        else json(response, 400, { error: { message: 'Context window exceeded', code: 'context_length_exceeded', type: 'invalid_request_error' } });
      });
      try {
        for (const reason of ['refusal', 'context_overflow']) {
          const output = await events(openCase(server.url, protocol, provider), { text: 'Start' });
          assert.deepEqual(output.at(-1), { type: 'end', reason });
        }
        assert.equal(server.requests.length, 2);
      } finally {
        await server.close();
      }
    });
  })));
});

test('output cap with unfinished arguments publishes usage and no tool call', async t => {
  for (const protocol of ['openai-responses', 'openai-chat'] as const) {
    await t.test(protocol, async () => {
      const server = await fakeApi((_request, response) => {
        stream(response, wireReply(protocol, 'fake-model-001', 1, { maxOutput: true }).frames);
      });
      try {
        const output = await events(openCase(server.url, protocol, 'openai'), { text: 'Start' });
        assert.equal(output.some(event => event.type === 'tool_call'), false);
        assert.equal(output.some(event => event.type === 'usage'), true);
        assert.deepEqual(output.at(-1), { type: 'end', reason: 'max_output' });
        assert.equal(server.requests.length, 1);
      } finally {
        await server.close();
      }
    });
  }
});

test('Google retains in-stream error codes for retry, refusal and overflow', async () => {
  const error = (code: string) => sse({ event_type: 'error', error: { code } }, 'error');
  const server = await fakeApi((_request, response) => {
    switch (server.requests.length) {
      case 1: stream(response, [error('https://example.invalid/error/UNAVAILABLE')]); break;
      case 2: stream(response, wireReply('google-genai', 'fake-model-001').frames); break;
      case 3: stream(response, [error('SAFETY_BLOCK')]); break;
      case 4: stream(response, [error('CONTEXT_WINDOW_EXCEEDED')]); break;
      default: assert.fail('Unexpected retry');
    }
  });
  try {
    for (const reason of ['stop', 'refusal', 'context_overflow']) {
      const output = await events(openCase(server.url, 'google-genai', 'google'), { text: 'Start' });
      assert.deepEqual(output.at(-1), { type: 'end', reason });
    }
    assert.deepEqual(server.requests[0], server.requests[1]);
    assert.equal(server.requests.length, 4);
  } finally {
    await server.close();
  }
});

test('Anthropic pause without continuation is reported as an interrupted turn', async () => {
  const reply = wireReply('anthropic-messages', 'fake-model-001');
  const server = await fakeApi((_request, response) => stream(response, reply.frames.map(frame =>
    frame.replace('"stop_reason":"end_turn"', '"stop_reason":"pause_turn"'))));
  try {
    await assert.rejects(events(openCase(server.url, 'anthropic-messages', 'anthropic'), { text: 'Start' }), /paused the turn/);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});
