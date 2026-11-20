import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseRoster, type Roster } from '../src/chat/roster.js';
import { parseModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import type { ModelProvider, ProviderEvent, WireProtocol } from '../src/providers/types.js';
import { collectSmokeTargets, parseSmokeBudget, runLiveSmoke } from '../scripts/smoke-live.js';
import { fakeApi, json, sse, stream } from './fixtures/fake-api/server.js';

const registry = parseModelRegistry({ version: 1, models: [
  { id: 'model-a', provider: 'openai', family: 'openai', protocol: 'openai-responses', apiKeyEnv: 'OPENAI_API_KEY', contextWindow: 10_000, maxOutputTokens: 1_000, efforts: ['medium', 'high'], pricing: { asOf: '2026-11-17', inputPerMTok: 1, outputPerMTok: 2 } },
  { id: 'model-b', provider: 'google', family: 'google', protocol: 'google-genai', apiKeyEnv: 'GEMINI_API_KEY', contextWindow: 10_000, maxOutputTokens: 1_000, efforts: ['high'], pricing: { asOf: '2026-11-17', inputPerMTok: 1, outputPerMTok: 2 } },
] });

const capabilities = { askUser: true, delegateSeats: [], writeMain: false, writeIsolated: false, integrate: false, acceptance: false, exec: false };
const rawRoster = {
  version: 1, rootSeat: 'lead',
  seats: [{ id: 'lead', kind: 'lead', promptFile: 'lead.md', strengths: 'lead', bindings: { default: { model: 'model-a', effort: 'medium', delegation: 'none' }, architecture: { model: 'model-a', effort: 'high', delegation: 'none' } }, can: capabilities }],
  pools: [{ id: 'mini', binding: { byParentProvider: { openai: { model: 'model-a', effort: 'medium', delegation: 'none' }, google: { model: 'model-b', effort: 'high', delegation: 'none' } } }, maxConcurrent: 2, maxWindowsPerTask: 1, strengths: 'pool' }],
  layers: { architecture: { pools: ['mini'] }, implementation: { pools: [] } },
};
const roster: Roster = parseRoster(rawRoster, registry);

const wireKeyName = 'DMW_SMOKE_WIRE_TEST_KEY';
const wireKey = 'smoke-wire-fixture-canary';
process.env[wireKeyName] = wireKey;
const wireTargets = [
  ['anthropic-messages', 'anthropic'], ['openai-responses', 'openai'],
  ['google-genai', 'google'], ['openai-chat', 'community'],
  ['openai-responses', 'xai'], ['openai-responses', 'deepseek'],
] as const;

function wireSmoke(baseUrl: string, protocol: WireProtocol, provider: string, lines: string[]) {
  const wireRegistry = parseModelRegistry({ version: 1, models: [
    { ...registry.get('model-a')!, baseUrl, protocol, provider, family: provider, apiKeyEnv: wireKeyName },
  ] });
  const wireRoster = parseRoster({ ...rawRoster, pools: [], layers: {
    architecture: { pools: [] }, implementation: { pools: [] },
  } }, wireRegistry);
  return runLiveSmoke(['--budget-usd', '5'], {
    env: { LIVE_SMOKE: '1', [wireKeyName]: wireKey }, registry: wireRegistry, roster: wireRoster,
    appendLedger: (_file, line) => lines.push(line),
  });
}

test('live smoke is disabled by default before providers or ledger are touched', async () => {
  let providerCalls = 0;
  let ledgerCalls = 0;
  await assert.rejects(runLiveSmoke(['--budget-usd', '5'], {
    env: {}, registry, roster,
    providerFor: () => { providerCalls++; throw new Error('network seam reached'); },
    appendLedger: () => { ledgerCalls++; },
  }), /LIVE_SMOKE=1.*no network requests/i);
  assert.equal(providerCalls, 0);
  assert.equal(ledgerCalls, 0);
});

test('budget and all required key guards pass before provider resolution', async () => {
  assert.throws(() => parseSmokeBudget([]), /Usage/);
  assert.throws(() => parseSmokeBudget(['--budget-usd', '5.01']), /at most USD 5/);
  let providers = 0;
  await assert.rejects(runLiveSmoke(['--budget-usd', '5'], {
    env: { LIVE_SMOKE: '1', OPENAI_API_KEY: 'test-only' }, registry, roster,
    providerFor: () => { providers++; throw new Error('provider reached'); },
  }), /GEMINI_API_KEY.*no network requests/);
  assert.equal(providers, 0);
  await assert.rejects(runLiveSmoke(['--budget-usd', '0.000001'], {
    env: { LIVE_SMOKE: '1', OPENAI_API_KEY: 'test-only', GEMINI_API_KEY: 'test-only' }, registry, roster,
    providerFor: () => { providers++; throw new Error('provider reached'); },
  }), /reservation.*exceeds budget.*no network requests/i);
  assert.equal(providers, 0);
});

test('target expansion includes phase bindings and byParentProvider but deduplicates models', () => {
  assert.deepEqual(collectSmokeTargets(roster, registry).map(target => [target.model.id, target.effort]), [
    ['model-a', 'high'], ['model-b', 'high'],
  ]);
});

test('fake providers prove native tool receipt binding, normalized usage and sanitized append-only evidence', async () => {
  const opens = new Map<string, number>();
  const providerFor = (protocol: WireProtocol): ModelProvider => new ScriptedProvider(({ init, input, turn }): ProviderEvent[] => {
    opens.set(init.model.id, (opens.get(init.model.id) ?? 0) + (turn === 1 ? 1 : 0));
    if (turn === 1) {
      const nonce = /smoke-\d+/.exec(input.text ?? '')?.[0];
      assert.ok(nonce);
      return [
        { type: 'reasoning_summary', delta: 'summary' },
        { type: 'response_metadata', modelId: init.model.id, ...(init.model.id === 'model-a' ? { effort: init.effort } : {}) },
        { type: 'usage', input: 20, cachedInput: 2, output: 8, reasoning: 3 },
        { type: 'tool_call', callId: `${init.model.id}-call`, name: 'smoke_echo', args: { nonce } },
        { type: 'end', reason: 'tool_calls' },
      ];
    }
    const receipt = input.toolResults?.[0];
    assert.equal(receipt?.callId, `${init.model.id}-call`);
    return [
      { type: 'text', delta: `Acknowledged ${receipt?.text}` },
      { type: 'response_metadata', modelId: init.model.id, ...(init.model.id === 'model-a' ? { effort: init.effort } : {}) },
      { type: 'usage', input: 30, cachedInput: 3, output: 5 },
      { type: 'end', reason: 'stop' },
    ];
  }, protocol, protocol === 'openai-responses' ? ['model-a'] : ['model-b']);
  const lines: string[] = [];
  const report = await runLiveSmoke(['--budget-usd', '5'], {
    env: { LIVE_SMOKE: '1', OPENAI_API_KEY: 'secret-openai', GEMINI_API_KEY: 'secret-google' },
    registry, roster, providerFor,
    now: () => new Date('2026-11-18T00:00:00.000Z'),
    appendLedger: (_file, line) => lines.push(line),
  });
  assert.deepEqual([...opens], [['model-a', 1], ['model-b', 1]]);
  assert.equal(report.models.length, 2);
  for (const model of report.models) {
    assert.deepEqual(model.nativeTool, { name: 'smoke_echo', callIdPresent: true, receiptBound: true });
    assert.deepEqual(model.usage, { input: 50, cachedInput: 5, cacheWrite: 0, output: 13, reasoning: 3 });
    assert.equal(model.responses.length, 2);
    assert.ok(model.responses.every(response => response.modelEcho.outcome === 'matched'));
    assert.equal(model.responses[0]?.reasoning.summary, 'nonempty_text_delta');
    assert.equal(model.responses[0]?.reasoning.usage, 'positive_token_count');
    assert.equal(model.responses[1]?.reasoning.summary, 'not_reported');
    assert.equal(model.responses[1]?.reasoning.usage, 'not_reported');
    assert.ok(model.responses.every(response => response.effortEcho.outcome === (model.model === 'model-a' ? 'matched' : 'not_returned')));
    assert.equal(model.verification.outcome, model.model === 'model-a' ? 'fully_verified' : 'partially_verified');
    assert.equal(model.behavioralEcho.outcome, 'pass');
  }
  assert.equal(lines.length, 6);
  const entries = lines.map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => entry.event), ['run_reserved', 'model_reserved', 'model_completed', 'model_reserved', 'model_completed', 'run_completed']);
  assert.deepEqual(entries.at(-1)?.report, report);
  assert.doesNotMatch(lines.join('\n'), /secret-openai|secret-google|model-a-call|SMOKE_RECEIPT/);
});

test('failure on the second model preserves first usage and retains the failed dispatch reservation', async () => {
  const lines: string[] = [];
  const providerFor = (protocol: WireProtocol): ModelProvider => new ScriptedProvider(({ init, input, turn }): ProviderEvent[] => {
    if (init.model.id === 'model-b') throw new Error('sdk detail must not enter ledger');
    if (turn === 1) {
      const nonce = /smoke-\d+/.exec(input.text ?? '')?.[0]; assert.ok(nonce);
      return [{ type: 'response_metadata', modelId: init.model.id }, { type: 'usage', input: 20, cachedInput: 0, output: 5 }, { type: 'tool_call', callId: 'private-call-id', name: 'smoke_echo', args: { nonce } }, { type: 'end', reason: 'tool_calls' }];
    }
    return [{ type: 'text', delta: `SMOKE_RECEIPT:${/smoke-\d+/.exec(input.toolResults?.[0]?.text ?? '')?.[0]}` }, { type: 'response_metadata', modelId: init.model.id }, { type: 'usage', input: 20, cachedInput: 0, output: 5 }, { type: 'end', reason: 'stop' }];
  }, protocol, protocol === 'openai-responses' ? ['model-a'] : ['model-b']);
  await assert.rejects(runLiveSmoke(['--budget-usd', '5'], {
    env: { LIVE_SMOKE: '1', OPENAI_API_KEY: 'secret-openai', GEMINI_API_KEY: 'secret-google' }, registry, roster, providerFor,
    now: () => new Date('2026-11-18T00:00:00.000Z'), appendLedger: (_file, line) => lines.push(line),
  }), /sdk detail/);
  const entries = lines.map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => entry.event), ['run_reserved', 'model_reserved', 'model_completed', 'model_reserved', 'model_failed', 'run_failed']);
  assert.equal(entries[2].model, 'model-a');
  assert.equal(entries[2].usage.input, 40);
  const failed = entries.find(entry => entry.event === 'model_failed');
  assert.equal(failed.model, 'model-b');
  assert.equal(failed.reasonCode, 'FIRST_REQUEST_FAILED');
  assert.ok(failed.retainedReservationUsd > 0);
  assert.doesNotMatch(lines.join('\n'), /sdk detail|secret-openai|secret-google|private-call-id|SMOKE_RECEIPT/);
});

test('returned model mismatch fails after retaining paid usage and sanitized response evidence', async () => {
  const oneModelRoster: Roster = parseRoster({ ...rawRoster, pools: [], layers: {
    architecture: { pools: [] }, implementation: { pools: [] },
  } }, registry);
  const lines: string[] = [];
  const providerFor = (protocol: WireProtocol): ModelProvider => new ScriptedProvider(({ init, input, turn }): ProviderEvent[] => {
    if (turn === 1) {
      const nonce = /smoke-\d+/.exec(input.text ?? '')?.[0]; assert.ok(nonce);
      return [
        { type: 'response_metadata', modelId: 'unexpected-model', effort: init.effort },
        { type: 'usage', input: 20, cachedInput: 0, output: 5, reasoning: 1 },
        { type: 'tool_call', callId: 'private', name: 'smoke_echo', args: { nonce } },
        { type: 'end', reason: 'tool_calls' },
      ];
    }
    assert.fail('mismatched first response must stop the model');
  }, protocol, ['model-a']);
  await assert.rejects(runLiveSmoke(['--budget-usd', '5'], {
    env: { LIVE_SMOKE: '1', OPENAI_API_KEY: 'secret-openai' }, registry, roster: oneModelRoster, providerFor,
    now: () => new Date('2026-11-18T00:00:00.000Z'), appendLedger: (_file, line) => lines.push(line),
  }), /RETURNED_MODEL_MISMATCH/);
  const entries = lines.map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => entry.event), ['run_reserved', 'model_reserved', 'model_failed', 'run_failed']);
  assert.equal(entries[2].reasonCode, 'RETURNED_MODEL_MISMATCH');
  assert.equal(entries[2].knownUsage.input, 20);
  assert.ok(entries[2].knownUsd > 0);
  assert.deepEqual(entries[2].responses[0].modelEcho, { outcome: 'mismatched', returned: 'unexpected-model' });
  assert.equal(entries[2].responses[0].effortEcho.outcome, 'matched');
  assert.doesNotMatch(lines.join('\n'), /secret-openai|private/);
});

test('missing model echo and empty reasoning deltas remain explicitly partially unverified', async () => {
  const oneModelRoster: Roster = parseRoster({ ...rawRoster, pools: [], layers: {
    architecture: { pools: [] }, implementation: { pools: [] },
  } }, registry);
  const lines: string[] = [];
  const providerFor = (protocol: WireProtocol): ModelProvider => new ScriptedProvider(({ init, input, turn }): ProviderEvent[] => {
    if (turn === 1) {
      const nonce = /smoke-\d+/.exec(input.text ?? '')?.[0]; assert.ok(nonce);
      return [
        { type: 'reasoning_summary', delta: '   ' },
        { type: 'response_metadata', effort: init.effort },
        { type: 'usage', input: 20, cachedInput: 0, output: 5, reasoning: 0 },
        { type: 'tool_call', callId: 'private', name: 'smoke_echo', args: { nonce } },
        { type: 'end', reason: 'tool_calls' },
      ];
    }
    return [
      { type: 'reasoning_summary', delta: '' },
      { type: 'response_metadata', effort: init.effort },
      { type: 'text', delta: input.toolResults![0]!.text },
      { type: 'usage', input: 20, cachedInput: 0, output: 5 },
      { type: 'end', reason: 'stop' },
    ];
  }, protocol, ['model-a']);
  const report = await runLiveSmoke(['--budget-usd', '5'], {
    env: { LIVE_SMOKE: '1', OPENAI_API_KEY: 'secret-openai' }, registry, roster: oneModelRoster, providerFor,
    now: () => new Date('2026-11-18T00:00:00.000Z'), appendLedger: (_file, line) => lines.push(line),
  });
  const model = report.models[0]!;
  assert.deepEqual(model.responses.map(response => response.modelEcho.outcome), ['not_returned', 'not_returned']);
  assert.deepEqual(model.responses.map(response => response.reasoning), [
    { summary: 'not_reported', usage: 'zero_token_count' },
    { summary: 'not_reported', usage: 'not_reported' },
  ]);
  assert.deepEqual(model.verification, {
    outcome: 'partially_verified', limitations: ['model_not_returned', 'reasoning_not_observed'],
  });
  const completed = lines.map(line => JSON.parse(line)).find(entry => entry.event === 'model_completed');
  assert.deepEqual(completed.verification, model.verification);
  assert.doesNotMatch(lines.join('\n'), /secret-openai|private|SMOKE_RECEIPT/);
});

test('smoke inference sends once after a transient response, redirect, or misdirected request on every native transport', async t => {
  for (const [protocol, provider] of wireTargets) {
    for (const status of [503, 307, 421]) {
      await t.test(`${protocol} (${provider}) HTTP ${status}`, async () => {
        const lines: string[] = [];
        const server = await fakeApi((request, response) => {
          if (request.method === 'GET') {
            const listing = protocol === 'google-genai' ? { models: [{ name: 'models/model-a' }] }
              : { data: [{ id: 'model-a' }], has_more: false };
            json(response, 200, listing);
          } else if (server.requests.length === 2) {
            assert.equal(request.body.model, 'model-a');
            assert.equal(request.body.stream, true);
            json(response, status, { error: { message: wireKey } }, { location: '/redirected' });
          } else {
            json(response, 400, { error: { message: 'Unexpected additional inference request' } });
          }
        });
        try {
          let failure: unknown;
          await assert.rejects(wireSmoke(server.url, protocol, provider, lines), error => { failure = error; return true; });
          if (status === 421) await delay(50);
          assert.deepEqual(server.attemptedMethods, ['GET', 'POST'], String(failure));
          assert.equal(server.requests.length, 2);
          const entries = lines.map(line => JSON.parse(line));
          assert.deepEqual(entries.map(entry => entry.event), ['run_reserved', 'model_reserved', 'model_failed', 'run_failed']);
          assert.equal(entries[2].reasonCode, 'FIRST_REQUEST_FAILED');
          assert.deepEqual(entries[2].responses, []);
          assert.equal(entries[2].knownUsage, undefined);
          assert.equal(entries[2].knownUsd, 0);
          assert.equal(entries[2].retainedReservationUsd, 0.00256);
          assert.doesNotMatch(lines.join('\n'), new RegExp(wireKey));
        } finally {
          await server.close();
        }
      });
    }
  }
});

test('smoke keeps first-round usage and holds only the second reservation after a stream disconnect', async () => {
  const lines: string[] = [];
  const server = await fakeApi(async (request, response) => {
    if (request.method === 'GET') {
      json(response, 200, { data: [{ id: 'model-a' }] });
    } else if (server.requests.length === 2) {
      stream(response, [sse({ type: 'response.completed', response: {
        id: 'resp_fixture', model: 'model-a', status: 'completed', reasoning: { effort: 'high' },
        output: [{ type: 'function_call', status: 'completed', call_id: 'fake-call-id', name: 'smoke_echo', arguments: '{"nonce":"smoke-1"}' }],
        usage: { input_tokens: 20, output_tokens: 5 },
      } }, 'response.completed')]);
    } else if (server.requests.length === 3) {
      assert.match(JSON.stringify(request.body), /SMOKE_RECEIPT:smoke-1/);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse({ type: 'response.output_text.delta', delta: 'partial text' }, 'response.output_text.delta'));
      await delay(50);
      response.destroy();
    } else {
      json(response, 400, { error: { message: 'Unexpected additional inference request' } });
    }
  });
  try {
    let failure: unknown;
    await assert.rejects(wireSmoke(server.url, 'openai-responses', 'openai', lines), error => { failure = error; return true; });
    assert.deepEqual(server.attemptedMethods, ['GET', 'POST', 'POST'], String(failure));
    const entries = lines.map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => entry.event), ['run_reserved', 'model_reserved', 'model_failed', 'run_failed']);
    assert.equal(entries[2].reasonCode, 'SECOND_REQUEST_FAILED');
    assert.equal(entries[2].responses.length, 1);
    assert.deepEqual(entries[2].knownUsage, { input: 20, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 'not_reported' });
    assert.equal(entries[2].knownUsd, 0.00003);
    assert.equal(entries[2].retainedReservationUsd, 0.004608);
    assert.doesNotMatch(lines.join('\n'), /partial text|fake-call-id|SMOKE_RECEIPT/);
  } finally {
    await server.close();
  }
});
