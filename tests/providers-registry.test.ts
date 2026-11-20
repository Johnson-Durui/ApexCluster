import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { modelProviderFor } from '../src/providers/factory.js';
import { loadModelRegistry, modelSpecHash, parseModelRegistry, requireModel } from '../src/providers/registry.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import { createProviderSession } from '../src/providers/session.js';
import type { ModelSpec, ProviderEvent, WireProtocol } from '../src/providers/types.js';
import { readModelVerification, saveModelVerification, verifyModelListings } from '../src/providers/verification.js';
import { fakeApi, json } from './fixtures/fake-api/server.js';

const sourceRegistry = loadModelRegistry(fileURLToPath(new URL('../config/', import.meta.url)));
const keyName = 'DMW_MODEL_TEST_KEY';
const key = process.env[keyName] ?? `fixture-canary-${randomUUID()}`;
const signal = new AbortController().signal;

function fixtureDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dmw-provider-'));
}

test('registry rejects aliases, unknown efforts, credential-bearing URLs and duplicates', () => {
  const model = sourceRegistry.get('claude-opus-5-5')!;
  assert.equal(requireModel(sourceRegistry, model.id, 'xhigh').id, model.id);
  assert.throws(() => requireModel(sourceRegistry, 'gemini-4-carbon', 'max'), /configured effort/);
  assert.throws(() => requireModel(sourceRegistry, 'opus', 'max'), /not registered/);
  for (const override of [
    { id: 'opus' }, { id: 'claude-opus-latest' }, { efforts: ['ultra'] }, { efforts: ['max', 'max'] },
    { maxOutputTokens: 1_000_001 }, { baseUrl: 'not a URL' }, { baseUrl: 'http://example.invalid' },
    { protocol: 'openai-chat' }, { provider: 'custom' },
    { baseUrl: `https://test:${key}@example.invalid` }, { apiKeyEnv: key },
  ]) {
    assert.throws(() => parseModelRegistry({ version: 1, models: [{ ...model, ...override }] }), error =>
      error instanceof Error && error.message.includes('Invalid model registry') && !error.message.includes(key));
  }
  assert.throws(() => parseModelRegistry({ version: 1, models: [model, model] }), /Duplicate model ID/);
});

test('local registry replaces whole model records by exact ID', () => {
  const root = fixtureDir();
  try {
    const model = sourceRegistry.get('claude-opus-5-5')!;
    const second = sourceRegistry.get('gpt-6.2-sol')!;
    writeFileSync(path.join(root, 'models.registry.json'), JSON.stringify({ version: 1, models: [model, second] }));
    const override = { ...model, contextWindow: 500_000 };
    writeFileSync(path.join(root, 'models.registry.local.json'), JSON.stringify({ version: 1, models: [override] }));
    const loaded = loadModelRegistry(root);
    assert.equal(loaded.size, 2);
    assert.equal(loaded.get(model.id)?.contextWindow, 500_000);
    assert.notEqual(modelSpecHash(loaded.get(model.id)!), modelSpecHash(model));
    assert.deepEqual(loaded.get(second.id), second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('models:verify offline and missing-key paths make no requests', async () => {
  const server = await fakeApi((_request, response) => json(response, 500, {}));
  const root = fixtureDir();
  try {
    const models = [...sourceRegistry.values()].map(model => ({ ...model, baseUrl: server.url }));
    mkdirSync(path.join(root, 'config'));
    writeFileSync(path.join(root, 'config/models.registry.json'), JSON.stringify({ version: 1, models }));
    const env = { ...process.env };
    for (const model of models) delete env[model.apiKeyEnv];
    env[models[0]!.apiKeyEnv] = key;
    const script = fileURLToPath(new URL('../scripts/models-verify.ts', import.meta.url));
    const run = (...args: string[]) => spawnSync(process.execPath,
      ['--import', import.meta.resolve('tsx'), script, ...args], { cwd: root, env, encoding: 'utf8', timeout: 6_000 });
    const offline = run('--offline');
    assert.equal(offline.status, 0, offline.stderr);
    assert.match(offline.stdout, /离线校验通过/);
    const missing = run();
    assert.equal(missing.status, 1);
    for (const model of models.filter(model => !env[model.apiKeyEnv])) {
      assert.ok(missing.stderr.includes(`${model.id}：缺少环境变量 ${model.apiKeyEnv}`));
    }
    assert.equal(`${missing.stdout}${missing.stderr}`.includes(key), false);
    assert.equal(server.requests.length, 0);
    assert.equal(existsSync(path.join(root, 'data')), false);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('listing normalizes exact IDs, batches by target and produces key-free evidence', async () => {
  const root = fixtureDir();
  const priorKey = process.env[keyName];
  process.env[keyName] = key;
  const protocols: WireProtocol[] = ['anthropic-messages', 'openai-responses', 'google-genai', 'openai-chat'];
  const servers = await Promise.all(protocols.map(async (protocol, index) => {
    const id = `model-tested-${index}`;
    return fakeApi((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(JSON.stringify(request).includes(key), false);
      const url = new URL(request.path, 'http://localhost');
      switch (protocol) {
        case 'anthropic-messages':
          assert.equal(url.pathname, '/v1/models');
          json(response, 200, { data: [{ id, type: 'model', display_name: id, created_at: '2026-11-17T00:00:00Z' }], has_more: false });
          break;
        case 'google-genai':
          assert.equal(url.pathname, '/v1/models');
          json(response, 200, { models: [{ name: `models/${id}` }] });
          break;
        default:
          assert.equal(url.pathname, '/models');
          json(response, 200, { data: [{ id, object: 'model', created: 100, owned_by: 'fixture' }], object: 'list' });
          break;
      }
    });
  }));
  try {
    const models: ModelSpec[] = protocols.map((protocol, index) => ({
      id: `model-tested-${index}`, provider: `vendor-${index}`, family: `vendor-${index}`, protocol,
      baseUrl: servers[index]!.url, apiKeyEnv: keyName, contextWindow: 1000, maxOutputTokens: 128, efforts: ['high'],
    }));
    models.push({ ...models[0]!, id: 'model-shadow' });
    const proof = await verifyModelListings(models, modelProviderFor, signal);
    assert.deepEqual(proof.models.map(model => model.status), ['verified', 'verified', 'verified', 'verified', 'not_listed']);
    for (const server of servers) assert.equal(server.requests.length, 1);
    assert.equal(proof.models[0]?.specHash, modelSpecHash(models[0]!));
    assert.ok(Object.values(proof.sdkVersions).every(value => /^\d+\.\d+\.\d+$/.test(value)));
    const output = saveModelVerification(root, proof);
    assert.equal(readFileSync(output, 'utf8').includes(key), false);
    assert.deepEqual(readModelVerification(root), proof);
  } finally {
    await Promise.all(servers.map(server => server.close()));
    if (priorKey === undefined) delete process.env[keyName];
    else process.env[keyName] = priorKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('ScriptedProvider consumes tool receipts and updates occupancy across scripted turns', async () => {
  const usage = { type: 'usage', input: 12, cachedInput: 2, output: 7 } as const;
  const script = new ScriptedProvider(function* ({ turn, input, priorInputs }) {
    yield usage;
    if (turn === 1) {
      assert.deepEqual(input, { text: 'Start' });
      yield { type: 'tool_call', callId: 'run', name: 'check', args: { item: 1 } };
      yield { type: 'end', reason: 'tool_calls' };
    } else {
      assert.deepEqual(priorInputs, [{ text: 'Start' }]);
      assert.deepEqual(input.toolResults, [{ callId: 'run', text: 'PASS' }]);
      yield { type: 'text', delta: 'Done' };
      yield { type: 'end', reason: 'stop' };
    }
  });
  const session = script.open({
    model: sourceRegistry.get('gpt-6.2-sol')!, effort: 'high', cacheKey: 'scripted-window',
    system: 'Fixture', maxOutputTokens: 100, tools: [{ name: 'check', description: 'Check', inputSchema: { type: 'object' } }],
  });
  const collected: ProviderEvent[] = [];
  for await (const event of session.send({ text: 'Start' }, signal)) collected.push(event);
  assert.equal(collected[1]?.type, 'tool_call');
  assert.deepEqual(session.occupancy(), { input: 12, output: 7 });
  await assert.rejects(async () => {
    for await (const _event of session.send({ toolResults: [{ callId: 'wrong', text: 'PASS' }] }, signal)) {
      assert.fail('An invalid receipt produced an event');
    }
  }, /receipts must match/);
  for await (const event of session.send({ toolResults: [{ callId: 'run', text: 'PASS' }] }, signal)) collected.push(event);
  assert.deepEqual(collected.at(-1), { type: 'end', reason: 'stop' });
  assert.equal(script.simulated, true);
});

test('a credential split across response deltas is never emitted', async () => {
  const session = createProviderSession({
    model: sourceRegistry.get('gpt-6.2-sol')!, effort: 'high', cacheKey: 'split-text',
    system: 'Fixture', maxOutputTokens: 100, tools: [],
  }, {
    apiKey: key,
    encode: () => [],
    request: async () => ({
      reason: 'stop', historyItems: [], toolCalls: [], usage: { type: 'usage', input: 5, cachedInput: 0, output: 1 },
      events: [{ type: 'text', delta: key.slice(0, 10) }, { type: 'text', delta: key.slice(10) }],
    }),
  });
  await assert.rejects(async () => {
    for await (const _event of session.send({ text: 'Start' }, signal)) assert.fail('Credential output should be blocked');
  }, /contained a credential/);
  assert.deepEqual(session.occupancy(), { input: 0, output: 0 });
});

test('a scripted response cannot silently discard calls with an inconsistent finish reason', async () => {
  const provider = new ScriptedProvider(() => [
    { type: 'tool_call', callId: 'oops', name: 'check', args: {} },
    { type: 'usage', input: 4, cachedInput: 0, output: 1 },
    { type: 'end', reason: 'stop' },
  ]);
  const session = provider.open({
    model: sourceRegistry.get('gpt-6.2-sol')!, effort: 'high', cacheKey: 'invalid-finish',
    system: 'Fixture', maxOutputTokens: 100, tools: [{ name: 'check', description: 'Check', inputSchema: { type: 'object' } }],
  });
  await assert.rejects(async () => {
    for await (const _event of session.send({ text: 'Start' }, signal)) assert.fail('Malformed terminal response should be blocked');
  }, /Invalid provider tool call set/);
});
