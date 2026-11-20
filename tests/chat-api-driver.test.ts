import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { modelSpecHash } from '../src/providers/registry.js';
import { ScriptedProvider, type ProviderScript } from '../src/providers/scripted.js';
import type { ModelSpec, WireProtocol } from '../src/providers/types.js';
import { providerSdkVersions, type ModelVerification } from '../src/providers/verification.js';
import { resolveSeat, type Roster } from '../src/chat/roster.js';
import type { DriverInput } from '../src/chat/types.js';
import { calibrateEstimate, estimateTokens, resolveLimits, type ContextPolicy } from '../src/chat/window.js';

const modelA: ModelSpec = { id: 'model-a-1', provider: 'openai', family: 'model-a', protocol: 'openai-responses', apiKeyEnv: 'TEST_MODEL_A_KEY', contextWindow: 10_000, maxOutputTokens: 1_000, efforts: ['high'] };
const modelB: ModelSpec = { id: 'model-b-1', provider: 'anthropic', family: 'model-b', protocol: 'anthropic-messages', apiKeyEnv: 'TEST_MODEL_B_KEY', contextWindow: 20_000, maxOutputTokens: 2_000, efforts: ['max'] };
const registry = new Map([[modelA.id, modelA], [modelB.id, modelB]]);
const can = { askUser: true, delegateSeats: [], writeMain: false, writeIsolated: false, integrate: false, acceptance: false, exec: false };
const roster: Roster = {
  version: 1, rootSeat: 'lead', pools: [], layers: { architecture: { pools: [] }, implementation: { pools: [] } },
  seats: [{ id: 'lead', kind: 'lead', promptFile: 'lead.md', strengths: 'lead', can, bindings: {
    default: { model: modelA.id, effort: 'high', delegation: 'none' },
    architecture: { model: modelB.id, effort: 'max', delegation: 'explicit' },
  } }],
};

function scripted(script: ProviderScript, protocol: WireProtocol = modelA.protocol): ScriptedProvider {
  return new ScriptedProvider(script, protocol, [modelA.id, modelB.id]);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function input(signal = new AbortController().signal): DriverInput {
  return {
    chatId: 'chat', directory: process.cwd(), systemPrompt: 'system', prompt: 'hello', signal,
    task: { id: 'task', turnId: 'turn', role: 'lead', goal: 'goal', status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' },
    invocation: { id: 'inv', taskId: 'task', segment: 1, status: 'running', startedAt: '', toolCount: 0, promptVersion: 'v1', inputEstimate: 0, contextWindow: null, contextUsed: null },
    tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }], onText: () => {}, callTool: async () => ({ text: 'receipt' }),
  };
}

function proof(model: ModelSpec): ModelVerification {
  return { version: 1, checkedAt: new Date().toISOString(), sdkVersions: providerSdkVersions(), models: [{ id: model.id, provider: model.provider, specHash: modelSpecHash(model), status: 'verified' }] };
}

test('API binding selects the exact phase model and effort', () => {
  const providers = new Map<WireProtocol, ScriptedProvider>([
    [modelA.protocol, scripted(() => [{ type: 'end', reason: 'stop' }])],
    [modelB.protocol, scripted(() => [{ type: 'end', reason: 'stop' }], modelB.protocol)],
  ]);
  const binding = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model => providers.get(model.protocol)! });
  const normal = binding.resolveDriver(resolveSeat(roster, 'lead')!, modelSpecHash(modelA));
  const architecture = binding.resolveDriver(resolveSeat(roster, 'lead', 'architecture')!, modelSpecHash(modelB));
  assert.deepEqual([normal.capability.model, normal.capability.effort], [modelA.id, 'high']);
  assert.deepEqual([architecture.capability.model, architecture.capability.effort], [modelB.id, 'max']);
  assert.equal(normal.capability.isolationBasis, 'api-no-local-process');
});

test('API binding fails closed for missing key, proof, changed hash, and non-simulated offline providers', () => {
  const saved = process.env[modelA.apiKeyEnv]; delete process.env[modelA.apiKeyEnv];
  try {
    const provider = scripted(() => [{ type: 'end', reason: 'stop' }]);
    let productionProviderResolved = false;
    const missing = createApiChatBinding(roster, registry, null, { providerFor: () => { productionProviderResolved = true; return provider; } }).resolveDriver(resolveSeat(roster, 'lead')!);
    assert.equal(missing.capability.available, false);
    assert.match(missing.capability.reason!, /缺少环境变量 TEST_MODEL_A_KEY/);
    assert.match(missing.capability.reason!, /缺少型号核对证明/);
    assert.equal(productionProviderResolved, false);
    const changed = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, '0'.repeat(64));
    assert.match(changed.capability.reason!, /冻结记录不一致/);
    const fake = { protocol: modelA.protocol, open: provider.open.bind(provider), listModels: provider.listModels.bind(provider) };
    const unsafe = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => fake }).resolveDriver(resolveSeat(roster, 'lead')!);
    assert.match(unsafe.capability.reason!, /只允许显式注入模拟 Provider/);
  } finally {
    if (saved === undefined) delete process.env[modelA.apiKeyEnv]; else process.env[modelA.apiKeyEnv] = saved;
  }
});

test('API driver returns tool receipts, streams text, and records exact usage', async () => {
  const seen: string[] = []; const contexts: Array<{ window: number; used: number }> = [];
  const provider = scripted(({ init, input: sent, turn }) => {
    assert.equal(init.model.id, modelA.id); assert.equal(init.effort, 'high');
    if (turn === 1) return [{ type: 'text', delta: '查' }, { type: 'usage', input: 40, cachedInput: 10, output: 5, reasoning: 2 }, { type: 'tool_call', callId: 'call-1', name: 'read', args: { path: 'a' } }, { type: 'end', reason: 'tool_calls' }];
    assert.deepEqual(sent, { toolResults: [{ callId: 'call-1', text: 'receipt' }] });
    return [{ type: 'text', delta: '完' }, { type: 'usage', input: 55, cachedInput: 10, output: 7 }, { type: 'end', reason: 'stop' }];
  });
  const driver = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!);
  const request = input(); request.onText = delta => seen.push(delta); request.onContext = value => contexts.push(value);
  request.callTool = async (name, args) => { assert.equal(name, 'read'); assert.deepEqual(args, { path: 'a' }); return { text: 'receipt' }; };
  const answer = await driver.invoke(request);
  assert.deepEqual(answer, { text: '查完', exitConfirmed: true, contextWindow: 10_000, contextUsed: 62, finishReason: 'completed' });
  assert.deepEqual(seen, ['查', '完']); assert.deepEqual(contexts, [{ window: 10_000, used: 45 }, { window: 10_000, used: 62 }]);
  assert.deepEqual(request.invocation.usage, { input: 55, cachedInput: 10, output: 7 }); assert.equal(request.invocation.peakUsed, 62);
});

test('API driver stops on a host receipt without sending a late provider turn', async () => {
  let turns = 0; const calls: string[] = [];
  const provider = scripted(() => { turns++; return [{ type: 'usage', input: 1, cachedInput: 0, output: 1 },
    { type: 'tool_call', callId: 'call-1', name: 'read', args: {} },
    { type: 'tool_call', callId: 'call-2', name: 'write', args: {} }, { type: 'end', reason: 'tool_calls' }]; });
  const driver = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!);
  const request = input(); request.tools.push({ name: 'write', description: 'write', inputSchema: { type: 'object' } });
  request.callTool = async name => { calls.push(name); return { text: 'waiting', stop: 'wait' }; };
  assert.equal((await driver.invoke(request)).finishReason, 'wait'); assert.equal(turns, 1); assert.deepEqual(calls, ['read']);
});

test('API driver continues max output once and cancels safely', async () => {
  let turns = 0;
  const continuation = scripted(({ input: sent }) => { turns++; if (turns === 1) return [{ type: 'text', delta: 'a' }, { type: 'usage', input: 1, cachedInput: 0, output: 1 }, { type: 'end', reason: 'max_output' }]; assert.deepEqual(sent, { text: '请继续上一条未完成的输出。' }); return [{ type: 'text', delta: 'b' }, { type: 'usage', input: 2, cachedInput: 0, output: 1 }, { type: 'end', reason: 'max_output' }]; });
  const binding = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => continuation });
  const answer = await binding.resolveDriver(resolveSeat(roster, 'lead')!).invoke(input());
  assert.equal(answer.text, 'ab'); assert.equal(answer.finishReason, 'max_output'); assert.equal(turns, 2);

  const controller = new AbortController(); let called = false;
  const cancelledProvider = scripted(async function* () { called = true; controller.abort(); yield { type: 'end', reason: 'stop' }; });
  const cancelled = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => cancelledProvider }).resolveDriver(resolveSeat(roster, 'lead')!).invoke(input(controller.signal));
  assert.equal(cancelled.finishReason, 'cancelled'); assert.equal(cancelled.exitConfirmed, true); assert.equal(called, true);
});

test('matching proof still requires the currently configured key and never falls back', () => {
  const saved = process.env[modelA.apiKeyEnv]; process.env[modelA.apiKeyEnv] = 'test-only-key';
  try {
    let selected = '';
    const driver = createApiChatBinding(roster, registry, proof(modelA), { providerFor: model => { selected = model.id; return scripted(() => [{ type: 'end', reason: 'stop' }]); } }).resolveDriver(resolveSeat(roster, 'lead')!, modelSpecHash(modelA));
    assert.equal(driver.capability.available, true); assert.equal(selected, modelA.id);
  } finally {
    if (saved === undefined) delete process.env[modelA.apiKeyEnv]; else process.env[modelA.apiKeyEnv] = saved;
  }
});

test('API provider setup failures are reported as safely exited', async () => {
  const broken = {
    simulated: true as const,
    protocol: modelA.protocol,
    listModels: async () => [modelA.id],
    open: () => { throw new Error('setup failed'); },
  };
  const driver = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => broken }).resolveDriver(resolveSeat(roster, 'lead')!);
  await assert.rejects(driver.invoke(input()), (error: unknown) => error instanceof Error && error.message === 'setup failed' && (error as Error & { exitConfirmed?: boolean }).exitConfirmed === true);
});

test('API driver preserves unknown host exit over cancellation for thrown and returned failures', async () => {
  for (const returned of [false, true]) {
    const controller = new AbortController();
    const provider = scripted(() => [{ type: 'usage', input: 1, cachedInput: 0, output: 1 }, { type: 'tool_call', callId: 'call', name: 'file_write', args: {} }, { type: 'end', reason: 'tool_calls' }]);
    const driver = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!);
    const request = input(controller.signal);
    request.tools = [{ name: 'file_write', description: 'write', inputSchema: { type: 'object' } }];
    request.callTool = async () => {
      controller.abort();
      if (returned) return { text: 'unknown', processExitConfirmed: false };
      throw Object.assign(new Error('unknown'), { exitConfirmed: false });
    };
    await assert.rejects(driver.invoke(request), (error: unknown) => error instanceof Error && (error as Error & { exitConfirmed?: boolean }).exitConfirmed === false);
  }
});

test('API driver runs only safelisted read batches in parallel and preserves receipt positions', async () => {
  const releases = [deferred<string>(), deferred<string>()];
  const started: string[] = [];
  const provider = scripted(({ input: sent, turn }) => {
    if (turn === 1) return [{ type: 'usage', input: 1, cachedInput: 0, output: 1 },
      { type: 'tool_call', callId: 'first', name: 'file_read', args: { path: 'a' } },
      { type: 'tool_call', callId: 'second', name: 'task_state', args: {} }, { type: 'end', reason: 'tool_calls' }];
    assert.deepEqual(sent, { toolResults: [{ callId: 'first', text: 'A' }, { callId: 'second', text: 'B' }] });
    return [{ type: 'usage', input: 2, cachedInput: 0, output: 1 }, { type: 'end', reason: 'stop' }];
  });
  const request = input(); request.tools = ['file_read', 'task_state'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  request.callTool = async name => { const index = name === 'file_read' ? 0 : 1; started.push(name); return { text: await releases[index]!.promise }; };
  const running = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!).invoke(request);
  while (started.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['file_read', 'task_state']);
  releases[1]!.resolve('B'); releases[0]!.resolve('A');
  assert.equal((await running).finishReason, 'completed');
});

test('API driver awaits every parallel read before reporting an unknown exit', async () => {
  const slow = deferred<void>(); let completed = false;
  const provider = scripted(() => [{ type: 'usage', input: 1, cachedInput: 0, output: 1 },
    { type: 'tool_call', callId: 'first', name: 'file_read', args: {} },
    { type: 'tool_call', callId: 'second', name: 'task_state', args: {} }, { type: 'end', reason: 'tool_calls' }]);
  const request = input(); request.tools = ['file_read', 'task_state'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  request.callTool = async name => name === 'file_read' ? (await slow.promise, { text: 'done' }) : { text: 'unknown', processExitConfirmed: false };
  const running = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!).invoke(request);
  void running.finally(() => { completed = true; }).catch(() => undefined);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  slow.resolve();
  await assert.rejects(running, (error: unknown) => error instanceof Error && (error as Error & { exitConfirmed?: boolean }).exitConfirmed === false);
});

test('API driver keeps any batch containing a side-effect tool sequential', async () => {
  const first = deferred<void>(); const started: string[] = [];
  const provider = scripted(({ input: sent, turn }) => {
    if (turn === 1) return [{ type: 'usage', input: 1, cachedInput: 0, output: 1 },
      { type: 'tool_call', callId: 'first', name: 'file_read', args: {} },
      { type: 'tool_call', callId: 'second', name: 'file_write', args: {} }, { type: 'end', reason: 'tool_calls' }];
    assert.deepEqual(sent, { toolResults: [{ callId: 'first', text: 'file_read' }, { callId: 'second', text: 'file_write' }] });
    return [{ type: 'usage', input: 2, cachedInput: 0, output: 1 }, { type: 'end', reason: 'stop' }];
  });
  const request = input(); request.tools = ['file_read', 'file_write'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  request.callTool = async name => { started.push(name); if (name === 'file_read') await first.promise; return { text: name }; };
  const running = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!).invoke(request);
  while (!started.length) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, ['file_read']);
  first.resolve(); assert.equal((await running).finishReason, 'completed'); assert.deepEqual(started, ['file_read', 'file_write']);
});

test('API driver applies the hard gate before a second request', async () => {
  for (const reason of ['tool_calls', 'max_output'] as const) {
    let turns = 0; let toolCalls = 0;
    const provider = scripted(() => {
      turns++;
      return [{ type: 'usage', input: 4_999, cachedInput: 0, output: 1 },
        ...(reason === 'tool_calls' ? [{ type: 'tool_call' as const, callId: 'call', name: 'read', args: {} }] : []),
        { type: 'end', reason }];
    });
    const request = input(); request.callTool = async () => { toolCalls++; return { text: 'late' }; };
    const answer = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!).invoke(request);
    assert.equal(answer.finishReason, 'rotate'); assert.equal(answer.exitConfirmed, true); assert.equal(request.invocation.rotationReason, 'hard');
    assert.equal(turns, 1); assert.equal(toolCalls, reason === 'tool_calls' ? 1 : 0);
  }
  const refusal = scripted(() => [{ type: 'end', reason: 'refusal' }]);
  const refused = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => refusal }).resolveDriver(resolveSeat(roster, 'lead')!).invoke(input());
  assert.equal(refused.finishReason, 'refusal');
});

const windowPolicy: ContextPolicy = {
  softTokens: 20, hardTokens: 8_000, hardRatio: 0.85,
  initialMaxTokens: 1_000, maxOutputTokens: 100, maxToolActions: 10, maxMinutes: 1,
};

test('API driver exposes context settings and appends one soft reminder before delivering receipts', async () => {
  const context = { overrides: { lead: { softTokens: 20 } } };
  const provider = scripted(({ init, input: sent, turn }) => {
    assert.equal(init.maxOutputTokens, 100);
    if (turn === 1) return [{ type: 'usage', input: 10, cachedInput: 0, output: 1 }, { type: 'tool_call', callId: 'call', name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }];
    assert.match(sent.toolResults![0]!.text, /receipt\n\n本窗口即将换窗/);
    assert.equal(sent.toolResults![0]!.text.match(/本窗口即将换窗/g)?.length, 1);
    return [{ type: 'usage', input: 100, cachedInput: 0, output: 1 }, { type: 'end', reason: 'stop' }];
  });
  const binding = createApiChatBinding(roster, registry, null, { offline: true, context, providerFor: () => provider });
  assert.deepEqual(binding.context, context);
  const delivered: string[][] = [];
  const request = input(); request.invocation.toolReceiptDeliveries = [{ id: 'receipt-1', name: 'read', ref: 'r', hash: 'a'.repeat(64), bytes: 7 }];
  request.onReceiptsDelivered = ids => delivered.push([...ids]);
  request.callTool = async () => ({ text: 'receipt', receiptId: 'receipt-1' });
  const answer = await binding.resolveDriver(resolveSeat(roster, 'lead')!, undefined, windowPolicy).invoke(request);
  assert.equal(answer.finishReason, 'completed'); assert.equal(request.invocation.toolReceiptDeliveries[0]!.delivered, true);
  assert.deepEqual(delivered, [['receipt-1']]);
});

test('API driver keeps sent receipts pending when the provider rejects their request without usage', async () => {
  const provider = scripted(({ turn }) => turn === 1
    ? [{ type: 'usage', input: 10, cachedInput: 0, output: 1 }, { type: 'tool_call', callId: 'call', name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }]
    : [{ type: 'end', reason: 'context_overflow' }]);
  const delivered: string[][] = [];
  const request = input(); request.invocation.toolReceiptDeliveries = [{ id: 'receipt-overflow', name: 'read', ref: 'r', hash: 'd'.repeat(64), bytes: 7 }];
  request.onReceiptsDelivered = ids => delivered.push([...ids]);
  request.callTool = async () => ({ text: 'receipt', receiptId: 'receipt-overflow' });
  const answer = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, windowPolicy).invoke(request);
  assert.equal(answer.finishReason, 'context_overflow');
  assert.equal(request.invocation.toolReceiptDeliveries[0]!.delivered, undefined);
  assert.deepEqual(delivered, []);
});

test('API driver never sends or marks receipts when the hard gate forces rotation', async () => {
  const hard: ContextPolicy = { ...windowPolicy, softTokens: 100, hardTokens: 500, initialMaxTokens: 300 };
  let turns = 0;
  const provider = scripted(() => { turns++; return [{ type: 'usage', input: 380, cachedInput: 0, output: 20 }, { type: 'tool_call', callId: 'call', name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }]; });
  const request = input(); request.invocation.toolReceiptDeliveries = [{ id: 'receipt-hard', name: 'read', ref: 'r', hash: 'b'.repeat(64), bytes: 7 }];
  request.callTool = async () => ({ text: 'receipt', receiptId: 'receipt-hard' });
  const answer = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, hard).invoke(request);
  assert.equal(answer.finishReason, 'rotate'); assert.equal(request.invocation.rotationReason, 'hard'); assert.equal(turns, 1);
  assert.equal(request.invocation.toolReceiptDeliveries[0]!.delivered, undefined);
});

test('API driver leaves staged receipts undelivered when the next request aborts', async () => {
  const controller = new AbortController();
  const provider = scripted(({ turn }) => {
    if (turn === 1) return [{ type: 'usage', input: 10, cachedInput: 0, output: 1 }, { type: 'tool_call', callId: 'call', name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }];
    return (async function* () { controller.abort(); yield { type: 'end' as const, reason: 'stop' as const }; })();
  });
  const request = input(controller.signal); request.invocation.toolReceiptDeliveries = [{ id: 'receipt-abort', name: 'read', ref: 'r', hash: 'c'.repeat(64), bytes: 7 }];
  request.callTool = async () => ({ text: 'receipt', receiptId: 'receipt-abort' });
  const answer = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, windowPolicy).invoke(request);
  assert.equal(answer.finishReason, 'cancelled'); assert.equal(request.invocation.toolReceiptDeliveries[0]!.delivered, undefined);
});

test('API driver rejects oversized serialized first material before any provider request', async () => {
  const tiny: ContextPolicy = { ...windowPolicy, initialMaxTokens: 50 };
  let requests = 0;
  const provider = scripted(() => { requests++; return [{ type: 'usage', input: 1, cachedInput: 0, output: 1 }, { type: 'end', reason: 'stop' }]; });
  const driver = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, tiny);
  await assert.rejects(driver.invoke(input()), /首个请求材料估算/); assert.equal(requests, 0);
});

test('API driver applies the one-byte ceiling envelope to the first request', async () => {
  const policy: ContextPolicy = { ...windowPolicy, hardTokens: 8_500, initialMaxTokens: 8_000 };
  let requests = 0;
  const provider = scripted(() => { requests++; return [{ type: 'usage', input: 1, cachedInput: 0, output: 1 }, { type: 'end', reason: 'stop' }]; });
  const request = input(); request.prompt = 'x'.repeat(8_300);
  const driver = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, policy);
  await assert.rejects(driver.invoke(request), /物理窗口天花板/); assert.equal(requests, 0);
});

test('API driver records and stops an authoritative peak above the physical ceiling before tools run', async () => {
  let tools = 0;
  const provider = scripted(({ turn }) => [{ type: 'usage', input: turn === 1 ? 100 : 8_500, cachedInput: 0, output: 1 },
    { type: 'tool_call', callId: 'call', name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }]);
  const request = input();
  const receipt = { id: 'known', name: 'read', ref: 'r', hash: 'd'.repeat(64), bytes: 7 };
  request.invocation.toolReceiptDeliveries = [receipt];
  request.callTool = async () => { tools++; return { text: 'receipt', receiptId: receipt.id }; };
  const delivered: string[] = [];
  request.onReceiptsDelivered = ids => { delivered.push(...ids); };
  const answer = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, windowPolicy).invoke(request);
  assert.equal(answer.finishReason, 'context_ceiling_breach'); assert.equal(answer.contextUsed, 8_501);
  assert.equal(request.invocation.peakUsed, 8_501); assert.equal(tools, 1);
  assert.deepEqual(delivered, ['known']);
  assert.equal(request.invocation.toolReceiptDeliveries[0]?.delivered, true);
});

test('API driver calibrates continuation input against the previous authoritative input', async () => {
  const receipt = 'x'.repeat(500);
  const next = { toolResults: [{ callId: 'call-2', text: receipt }] };
  const estimated = estimateTokens(next);
  const calibrated = calibrateEstimate(1, estimated, 400);
  assert.ok(calibrated > 1);
  const oldProjection = 501 + estimated + 100;
  const newProjection = 501 + estimateTokens(next, calibrated) + 100;
  const hardTokens = Math.floor((oldProjection + newProjection) / 2);
  let turns = 0;
  const provider = scripted(({ turn }) => {
    turns++;
    if (turn === 1) return [{ type: 'usage', input: 100, cachedInput: 0, output: 300 }, { type: 'tool_call', callId: 'call-1', name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }];
    return [{ type: 'usage', input: 500, cachedInput: 0, output: 1 }, { type: 'tool_call', callId: 'call-2', name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }];
  });
  const policy: ContextPolicy = { ...windowPolicy, softTokens: hardTokens - 1, hardTokens };
  const request = input(); request.callTool = async () => ({ text: receipt });
  const answer = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, policy).invoke(request);
  assert.equal(answer.finishReason, 'rotate'); assert.equal(turns, 2);
});

test('random admitted scripted peaks stay within the physical ceiling', async () => {
  let seed = 71_923;
  let rotations = 0;
  const policy = { ...windowPolicy, softTokens: 8_499, hardTokens: 8_500, initialMaxTokens: 8_000 };
  const limits = resolveLimits(modelA, policy);
  for (let index = 0; index < 30; index++) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const request = input(); request.prompt = '数'.repeat(seed % 1_800);
    let actualPeak = Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(JSON.stringify(request.tools));
    request.callTool = async () => ({ text: '回执'.repeat(seed % 600 + 100) });
    const provider = scripted(({ turn, input: payload, init }) => {
      const input = actualPeak + Buffer.byteLength(JSON.stringify(payload)) + 12;
      actualPeak = input + init.maxOutputTokens;
      assert.ok(actualPeak <= limits.ceiling, `admitted turn ${turn}: ${actualPeak}`);
      const usage = { type: 'usage' as const, input, cachedInput: 0, output: init.maxOutputTokens };
      return turn === 8 ? [usage, { type: 'end', reason: 'stop' }]
        : [usage, { type: 'tool_call', callId: `call-${turn}`, name: 'read', args: {} }, { type: 'end', reason: 'tool_calls' }];
    });
    const answer = await createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => provider }).resolveDriver(resolveSeat(roster, 'lead')!, undefined, policy).invoke(request);
    assert.equal(request.invocation.peakUsed, actualPeak);
    assert.ok(answer.finishReason === 'rotate' || answer.finishReason === 'completed');
    rotations += Number(answer.finishReason === 'rotate');
  }
  assert.ok(rotations > 0);
});
