import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { bootstrapChats } from '../src/chat/bootstrap.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { freezeApiRoster, loadRoster, parseRoster, phaseSchema, resolvePool, resolveSeat } from '../src/chat/roster.js';
import type { CommandRunner } from '../src/chat/runner-contract.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { AgentTask } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { loadConfig } from '../src/config.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider, type ScriptedTurn } from '../src/providers/scripted.js';
import type { ProviderEvent } from '../src/providers/types.js';
import { tempDir } from './helpers.js';

const registry = loadModelRegistry();

test('both shipped rosters validate, with one main writer and phase-specific isolation', () => {
  const flagship = loadRoster('config/roster.json', registry);
  assert.deepEqual(loadRoster('config/presets/roster.flagship.json', registry), flagship);
  const single = loadRoster('config/presets/roster.single-provider.json', registry);
  const labels = flagship.seats.map(seat => seat.id);
  assert.deepEqual(single.seats.map(seat => seat.id), labels);
  for (const phase of phaseSchema.options) {
    const seats = labels.map(role => resolveSeat(flagship, role, phase)!);
    for (const roster of [flagship, single]) {
      assert.equal(resolveSeat(roster, 'astra', phase)?.binding.model, 'gpt-6.2-astra');
      assert.equal(resolveSeat(roster, 'sol', phase)?.binding.model, 'gpt-6.2-sol');
    }
    assert.deepEqual(seats.filter(seat => seat.can.writeMain).map(seat => seat.id), ['sol']);
    assert.deepEqual(seats.filter(seat => seat.can.integrate).map(seat => seat.id), ['sol']);
    assert.deepEqual(seats.filter(seat => seat.can.askUser).map(seat => seat.id), ['claude']);
    assert.deepEqual(seats.filter(seat => seat.can.acceptance).map(seat => seat.id), ['astra']);
    assert.deepEqual(seats.filter(seat => seat.can.writeIsolated).map(seat => seat.id), phase === 'implementation' ? ['opus'] : []);
    assert.equal(resolveSeat(flagship, 'astra', phase)!.binding.delegation, phase === 'cluster' ? 'proactive' : 'explicit');
    for (const id of labels) assert.equal(registry.get(resolveSeat(single, id, phase)!.binding.model)?.provider, 'openai');
  }
  assert.equal(resolveSeat(single, single.rootSeat)?.binding.model, 'gpt-6.2-astra');
  for (const roster of [flagship, single]) {
    assert.deepEqual(Object.fromEntries(roster.seats.map(seat => [seat.id, seat.delegationWeight])), {
      claude: 4, astra: 3, opus: 3, carbon: 2, sol: 2,
    });
    assert.ok(roster.pools.every(pool => pool.delegationWeight === 1));
    assert.deepEqual(resolveSeat(roster, 'claude')?.can.delegateSeats, ['astra', 'opus', 'carbon', 'sol']);
    assert.deepEqual(resolveSeat(roster, 'astra')?.can.delegateSeats, ['carbon', 'sol']);
    assert.deepEqual(resolveSeat(roster, 'opus')?.can.delegateSeats, ['carbon', 'sol']);
  }
  const bad = structuredClone(flagship);
  bad.seats.find(seat => seat.id === 'carbon')!.bindings.default.effort = 'max';
  assert.throws(() => parseRoster(bad, registry), /configured effort/);
  const split = structuredClone(flagship);
  split.seats.find(seat => seat.id === 'sol')!.canByPhase = { implementation: { writeMain: false, integrate: false } };
  const opus = split.seats.find(seat => seat.id === 'opus')!;
  opus.canByPhase = { implementation: { writeMain: true, writeIsolated: false } };
  assert.throws(() => parseRoster(split, registry), /唯一的主工作区写者/);

  const partial = structuredClone(flagship);
  delete partial.seats.find(seat => seat.id === 'carbon')!.delegationWeight;
  assert.throws(() => parseRoster(partial, registry), /权重|weight/i);
  const legacy = structuredClone(flagship);
  for (const seat of legacy.seats) delete seat.delegationWeight;
  for (const pool of legacy.pools) delete pool.delegationWeight;
  assert.doesNotThrow(() => parseRoster(legacy, registry));
});

test('upgraded defaults still resolve exact legacy models from a frozen API roster', () => {
  const roster = loadRoster('config/roster.json', registry);
  const legacyRoster = structuredClone(roster);
  const legacyModels = { astra: 'gpt-6-astra', sol: 'gpt-6.1-sol' } as const;
  for (const role of ['astra', 'sol'] as const) {
    const seat = legacyRoster.seats.find(item => item.id === role)!;
    for (const binding of Object.values(seat.bindings)) binding.model = legacyModels[role];
  }
  const frozen = freezeApiRoster(legacyRoster, registry);
  const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: () => new ScriptedProvider(() => []) });
  for (const role of ['astra', 'sol'] as const) {
    const seat = resolveSeat(frozen.roster, role)!;
    const driver = api.resolveDriver(seat, frozen.modelHashes[legacyModels[role]]);
    assert.equal(driver.capability.available, true);
    assert.equal(driver.capability.model, legacyModels[role]);
  }
});

test('a clean chat bootstrap uses repository-local API storage and exposes unavailable seats without dispatching', () => {
  const base = tempDir('dmw-api-boot-');
  try {
    const config = loadConfig(path.resolve('config/workbench.config.example.json'), process.cwd());
    const boot = bootstrapChats(config, 'offline-fixture-token', base);
    assert.ok(boot.runtime, 'portable bootstrap must succeed');
    const seats = boot.runtime.capabilities();
    assert.deepEqual(seats.map(seat => seat.role), ['claude', 'astra', 'opus', 'carbon', 'sol']);
    assert.ok(seats.every(seat => !seat.available && seat.isolationBasis === 'api-no-local-process'));
    const chat = boot.runtime.create({});
    assert.ok(existsSync(path.join(base, 'data', 'chat', 'chats', chat.id, 'chat.json')));
    assert.throws(() => boot.runtime!.send(chat.id, { text: 'No model calls', clientMessageId: 'm', confirmCost: true }), /缺少.*核对证明/);
    assert.equal(chat.invocations.length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('API runtime tool permissions apply to every seat, phase and task mode', () => {
  const base = tempDir('dmw-api-tools-');
  try {
    const roster = loadRoster('config/roster.json', registry);
    const store = new ChatStore(base);
    const workspace = new WorkspaceRegistry(path.join(base, 'work'));
    const api = createApiChatBinding(roster, registry, null);
    const runtime = new ChatRuntime({ store, drivers: {}, api, workspace: new WorkspaceGateway(workspace) });
    const chat = runtime.create({});
    for (const phase of phaseSchema.options) for (const seat of roster.seats) for (const mode of ['read', 'edit', 'verify'] as const) {
      const resolved = resolveSeat(roster, seat.id, phase)!;
      const task: AgentTask = { turnId: 't', id: seat.id, role: seat.id, goal: 'offline', createdAt: '', updatedAt: '',
        mode, phase, workspaceId: 'granted-only-for-catalog', status: 'queued', invocationIds: [], segment: 0, noProgressSegments: 0,
        ...(seat.id === roster.rootSeat ? {} : { parentTaskId: roster.rootSeat }),
      };
      const names = new Set(runtime['tools'](chat, task).map(tool => tool.name));
      const writer = seat.id === 'sol' || (seat.id === 'opus' && phase === 'implementation');
      assert.equal(names.has('file_write'), mode === 'edit' && writer, `${seat.id}/${phase}/${mode} write`);
      assert.equal(names.has('integrate_edit'), mode === 'edit' && seat.id === 'sol');
      assert.equal(names.has('ask_user'), seat.id === roster.rootSeat);
      assert.equal(names.has('agent_submit'), resolved.can.delegateSeats.length > 0);
      assert.equal(names.has('test_submit'), false);
      assert.equal(names.has('execution_submit_review'), false);
      assert.ok(names.has('file_read') && names.has('task_collect') && !names.has('grok_submit'));
      const agentSubmit = runtime['tools'](chat, task).find(tool => tool.name === 'agent_submit');
      const roleEnum = (agentSubmit?.inputSchema.properties as { role?: { enum?: string[] } } | undefined)?.role?.enum ?? [];
      assert.deepEqual(roleEnum, resolved.can.delegateSeats, `${seat.id}/${phase}/${mode} weighted named targets`);
    }
    for (const poolId of roster.layers.architecture.pools) {
      const pool = roster.pools.find(candidate => candidate.id === poolId)!;
      const resolved = resolvePool(roster, pool.id, 'architecture', 'anthropic')!;
      const task: AgentTask = { turnId: 't', id: pool.id, role: pool.id, goal: 'offline', createdAt: '', updatedAt: '',
        mode: 'read', phase: 'architecture', parentTaskId: roster.rootSeat, poolProvider: 'anthropic', status: 'queued',
        invocationIds: [], segment: 0, noProgressSegments: 0,
      };
      const names = new Set(runtime['tools'](chat, task).map(tool => tool.name));
      assert.equal(resolved.delegationWeight, 1);
      assert.ok(!names.has('agent_submit') && !names.has('worker_submit') && !names.has('fanout_submit'));
    }

    const overlyBroad = structuredClone(roster);
    overlyBroad.seats.find(seat => seat.id === 'astra')!.can.delegateSeats = ['carbon', 'opus', 'claude'];
    const weighted = parseRoster(overlyBroad, registry);
    const weightedRuntime = new ChatRuntime({ store, drivers: {}, api: createApiChatBinding(weighted, registry, null) });
    const weightedChat = weightedRuntime.create({});
    const astraTask: AgentTask = { turnId: 't', id: 'astra-weighted', role: 'astra', goal: 'offline', createdAt: '', updatedAt: '',
      mode: 'read', phase: 'architecture', parentTaskId: weighted.rootSeat, status: 'queued', invocationIds: [], segment: 0, noProgressSegments: 0,
    };
    const agentSubmit = weightedRuntime['tools'](weightedChat, astraTask).find(tool => tool.name === 'agent_submit');
    const roleEnum = (agentSubmit?.inputSchema.properties as { role?: { enum?: string[] } } | undefined)?.role?.enum;
    assert.deepEqual(roleEnum, ['carbon'], 'same-weight Opus and higher-weight Fable must be removed even when allowlisted');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

type Call = [name: string, args: Record<string, unknown>];

function response(...calls: Call[]): ProviderEvent[] {
  return [
    { type: 'usage', input: 40, cachedInput: 0, output: 20 },
    ...calls.map(([name, args], index) => ({ type: 'tool_call' as const, callId: `tool-${index}`, name, args })),
    { type: 'end', reason: 'tool_calls' },
  ];
}

function receipts(turn: ScriptedTurn): { taskId: string; status: string }[][] {
  return (turn.input.toolResults ?? []).map(result => JSON.parse(result.text));
}

test('Astra and Opus dispatch lower-weight named seats through the real runtime', async () => {
  const base = tempDir('dmw-api-weighted-dispatch-');
  try {
    const roster = loadRoster('config/roster.json', registry);
    const childIds = new Map<string, string[]>();
    const stages = new Map<string, 'submit' | 'collect' | 'dispose'>();
    const delegated = new Set<string>();
    const script = (turn: ScriptedTurn): ProviderEvent[] => {
      const model = turn.init.model.id;
      if (model === 'gemini-4-carbon' || model === 'gpt-6.2-sol') {
        return response(['task_complete', { result: `模拟数据：${model} 完成下级任务` }]);
      }
      const key = turn.init.cacheKey;
      const stage = stages.get(key) ?? 'submit';
      if (stage === 'submit') {
        const targets = model === 'claude-fable-5-2' ? ['astra', 'opus']
          : model === 'gpt-6.2-astra' ? ['carbon'] : ['sol'];
        const tool = turn.init.tools.find(candidate => candidate.name === 'agent_submit');
        const allowed = (tool?.inputSchema.properties as { role?: { enum?: string[] } } | undefined)?.role?.enum ?? [];
        assert.ok(targets.every(target => allowed.includes(target)), `${model} lacks ${targets.join(',')}`);
        stages.set(key, 'collect');
        return response(...targets.map(role => ['agent_submit', { role, mode: 'read', goal: `${model} delegates to ${role}` }] as Call));
      }
      if (stage === 'collect') {
        const submitted = receipts(turn).flat().map(receipt => receipt.taskId);
        if (submitted.length) childIds.set(key, submitted);
        const ids = childIds.get(key)!;
        stages.set(key, 'dispose');
        return response(['task_collect', { taskIds: ids, wait: true }]);
      }
      const ids = childIds.get(key)!;
      const completed = receipts(turn).flat().filter(receipt => receipt.status === 'completed');
      if (!completed.length) return response(['task_collect', { taskIds: ids, wait: true }]);
      completed.forEach(receipt => delegated.add(receipt.taskId));
      return response(
        ...ids.map(taskId => ['task_disposition', { taskId, disposition: 'adopted' }] as Call),
        ['task_complete', { result: `模拟数据：${model} 已收口下级派单` }],
      );
    };
    const store = new ChatStore(base);
    const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model => new ScriptedProvider(script, model.protocol) });
    const runtime = new ChatRuntime({ store, drivers: {}, api, handoffMs: 5 });
    const chat = runtime.create({});
    runtime.send(chat.id, { text: '验证高权重席位指挥低权重席位', clientMessageId: 'weighted-dispatch' });
    await runtime.idle();
    const byRole = new Map(chat.tasks.map(task => [task.role, task]));
    assert.equal(chat.tasks.length, 5);
    for (const [role, parent] of [['astra', 'claude'], ['opus', 'claude'], ['carbon', 'astra'], ['sol', 'opus']] as const) {
      assert.equal(byRole.get(role)?.parentTaskId, byRole.get(parent)?.id, `${role} was not assigned by ${parent}`);
    }
    assert.ok(chat.tasks.every(task => task.status === 'completed'), JSON.stringify(chat.tasks.map(task => ({ role: task.role, status: task.status, error: task.error }))));
    assert.equal(delegated.size, 4);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('runtime rejects same-weight and upward dispatch to listed seats and pools', async t => {
  for (const target of ['opus', 'claude', 'hydrogen']) await t.test(target, async () => {
    const base = tempDir(`dmw-api-weight-reject-${target}-`);
    try {
      const configured = loadRoster('config/roster.json', registry);
      const astra = configured.seats.find(seat => seat.id === 'astra')!;
      const pool = configured.pools.find(candidate => candidate.id === target);
      if (pool) pool.delegationWeight = astra.delegationWeight;
      else astra.can.delegateSeats.push(target);
      const roster = parseRoster(configured, registry);
      let childId = '';
      let rootStage: 'submit' | 'collect' | 'dispose' = 'submit';
      const script = (turn: ScriptedTurn): ProviderEvent[] => {
        if (turn.init.model.id === 'gpt-6.2-astra') {
          if (pool) {
            for (const name of ['worker_submit', 'fanout_submit']) {
              const tool = turn.init.tools.find(candidate => candidate.name === name);
              assert.ok(tool);
              const properties = tool.inputSchema.properties as { pool: { enum: string[] } };
              assert.equal(properties.pool.enum.includes(target), false);
            }
            return response(['fanout_submit', { pool: target, template: '{{item}}', items: ['invalid dispatch'] }]);
          }
          return response(['agent_submit', { role: target, mode: 'read', goal: `invalid dispatch to ${target}` }]);
        }
        if (rootStage === 'submit') {
          rootStage = 'collect';
          return response(['agent_submit', { role: 'astra', mode: 'read', goal: `attempt invalid dispatch to ${target}` }]);
        }
        if (rootStage === 'collect') {
          const submitted = receipts(turn).flat().map(receipt => receipt.taskId);
          if (submitted.length) childId = submitted[0]!;
          rootStage = 'dispose';
          return response(['task_collect', { taskIds: [childId], wait: true }]);
        }
        const failed = receipts(turn).flat().some(receipt => receipt.status === 'failed');
        if (!failed) return response(['task_collect', { taskIds: [childId], wait: true }]);
        return response(
          ['task_disposition', { taskId: childId, disposition: 'rejected' }],
          ['task_complete', { result: `模拟数据：已确认拒绝 ${target}` }],
        );
      };
      const store = new ChatStore(base);
      const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model => new ScriptedProvider(script, model.protocol) });
      const runtime = new ChatRuntime({ store, drivers: {}, api, handoffMs: 5 });
      const chat = runtime.create({});
      runtime.send(chat.id, { text: `验证拒绝 Astra 指挥 ${target}`, clientMessageId: `reject-${target}` });
      await runtime.idle();
      assert.equal(chat.tasks[0]?.status, 'completed', chat.tasks[0]?.error);
      assert.equal(chat.tasks[1]?.status, 'failed');
      assert.match(chat.tasks[1]?.error ?? '', /不在当前任务允许的委派目标中/);
      assert.equal(chat.tasks.length, 2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test('API runtime uses the configured root, delegates four seats and closes with a verified snapshot', async () => {
  const base = tempDir('dmw-api-m2-');
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    const configured = loadRoster('config/roster.json', registry);
    configured.rootSeat = 'chair';
    configured.seats.find(seat => seat.id === 'claude')!.id = 'chair';
    const roster = parseRoster(configured, registry);
    const tools = new Map<string, Set<string>>();
    let stage = 'delegate-work';
    let workIds: string[] = [];
    let reviewIds: string[] = [];
    let testDir = '';
    let checked = 0;

    function collection(ids: string[]): ProviderEvent[] {
      return response(['task_collect', { taskIds: ids, wait: true }]);
    }
    function dispositions(ids: string[]): Call[] {
      return ids.map(taskId => ['task_disposition', { taskId, disposition: 'adopted' }]);
    }
    const script = (turn: ScriptedTurn): ProviderEvent[] => {
      const model = turn.init.model.id;
      tools.set(model, new Set(turn.init.tools.map(tool => tool.name)));
      if (model === 'gpt-6.2-sol') {
        if (turn.turn === 1) return response(['file_write', {
          path: 'app.txt', text: 'working API result', expectedHash: null,
        }]);
        return response(['task_complete', { result: '模拟数据：写入已观察' }]);
      }
      if (model === 'claude-opus-5-5') return response(['task_complete', { result: '模拟数据：架构互参备忘录' }]);
      if (model === 'gemini-4-carbon') return response(['task_complete', { result: '模拟数据：思路简报' }]);
      if (model === 'gpt-6.2-astra') {
        if (!checked) return response(['test_submit', { executable: 'fixture-check', args: [] }]);
        return response(['task_complete', { result: '模拟数据：已在测试副本复核' }]);
      }
      assert.equal(model, 'claude-fable-5-2');
      if (stage === 'delegate-work') {
        stage = 'collect-work';
        return response(
          ['agent_submit', { role: 'sol', phase: 'demo', mode: 'edit', goal: 'Write the demo' }],
          ['agent_submit', { role: 'opus', phase: 'cluster', mode: 'read', goal: 'Review the common architecture' }],
          ['agent_submit', { role: 'carbon', phase: 'cluster', mode: 'read', goal: 'Suggest one idea' }],
        );
      }
      if (stage === 'collect-work') {
        workIds = receipts(turn).flat().map(result => result.taskId);
        assert.equal(workIds.length, 3);
        stage = 'dispose-work';
        return collection(workIds);
      }
      if (stage === 'dispose-work') {
        if (!turn.input.toolResults) return collection(workIds);
        assert.ok(receipts(turn).flat().every(result => result.status === 'completed'));
        stage = 'collect-review';
        return response(...dispositions(workIds), ['agent_submit', { role: 'astra', phase: 'acceptance', mode: 'verify', goal: 'Run the snapshot check' }]);
      }
      if (stage === 'collect-review') {
        reviewIds = receipts(turn).at(-1)!.map(result => result.taskId);
        stage = 'dispose-review';
        return collection(reviewIds);
      }
      if (!turn.input.toolResults) return collection(reviewIds);
      assert.equal(receipts(turn).flat()[0]?.status, 'completed');
      return response(...dispositions(reviewIds), ['task_complete', { result: '模拟数据：交付完成' }]);
    };

    const runner: CommandRunner = {
      capability: { platform: 'linux' },
      commandInfo: () => [{ platform: 'linux', executablePaths: ['fixture-check'], network: 'none', writableScope: 'derived-test-copy' }],
      issueTicket: (_id, spec, allowedRoot) => {
        assert.equal(spec.executable, 'fixture-check');
        assert.equal(spec.cwd, allowedRoot);
        testDir = allowedRoot;
        return 'fixture-test-ticket';
      },
      run: async ticketId => {
        assert.notEqual(testDir, project);
        assert.equal(readFileSync(path.join(testDir, 'app.txt'), 'utf8'), 'working API result');
        assert.equal(existsSync(path.join(testDir, 'isolated.txt')), false);
        checked++;
        return { ticketId, command: ['fixture-check'], exitCode: 0, signal: null, timedOut: false, cancelled: false,
          spawnError: null, stdoutTail: '模拟数据：冻结测试副本内容符合期望', stderrTail: '', durationMs: 1, pid: null, removedEnv: [] };
      },
    };
    const workspace = new WorkspaceRegistry(path.join(base, 'work'));
    const grant = workspace.grantFromNativeSelection(project, workspace.issueNativeSelectionRequest());
    const store = new ChatStore(path.join(base, 'store'));
    const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model => new ScriptedProvider(script, model.protocol) });
    const runtime = new ChatRuntime({ store, drivers: {}, api, workspace: new WorkspaceGateway(workspace, runner), handoffMs: 5 });
    const chat = runtime.create({ workspaceId: grant.id });
    runtime.send(chat.id, { text: '落盘一个示例并验证冻结后的内容', clientMessageId: 'm2-demo' });
    await runtime.idle();
    assert.deepEqual(chat.tasks.map(task => [task.role, task.status]), [
      ['chair', 'completed'], ['sol', 'completed'], ['opus', 'completed'], ['carbon', 'completed'], ['astra', 'completed'],
    ], JSON.stringify(chat.tasks.map(task => ({ role: task.role, status: task.status, error: task.error }))));
    assert.equal(checked, 1);
    assert.equal(readFileSync(path.join(project, 'app.txt'), 'utf8'), 'working API result');
    assert.equal(existsSync(path.join(project, 'isolated.txt')), false);
    assert.equal(store.get(chat.id).apiRoster?.roster.rootSeat, 'chair');
    assert.equal(chat.invocations.find(invocation => invocation.model === 'claude-opus-5-5')?.effort, 'max');
    assert.ok(chat.invocations.every(invocation => invocation.usage?.input === 40 && invocation.exitConfirmed));
    assert.deepEqual([...tools].filter(([, names]) => names.has('ask_user')).map(([model]) => model), ['claude-fable-5-2']);
    assert.equal(tools.get('gpt-6.2-astra')?.has('test_submit'), true);
    assert.equal(tools.get('gpt-6.2-astra')?.has('file_write'), false);
    assert.equal(tools.get('gemini-4-carbon')?.has('artifact_publish'), false);
    assert.equal(tools.get('claude-opus-5-5')?.has('file_write'), false);
    assert.ok([...tools.values()].every(names => !names.has('grok_submit') && !names.has('grok_collect')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an architecture model cannot self-authorize implementation through the delegated phase', async () => {
  const base = tempDir('dmw-api-phase-');
  try {
    const roster = loadRoster('config/roster.json', registry);
    const store = new ChatStore(base);
    const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model =>
      new ScriptedProvider(({ init }) => {
        const tool = init.tools.find(candidate => candidate.name === 'agent_submit');
        assert.equal(JSON.stringify(tool?.inputSchema).includes('implementation'), false);
        return response(['agent_submit', { role: 'opus', phase: 'implementation', mode: 'edit', goal: 'Attempt unauthorized phase' }]);
      }, model.protocol),
    });
    const runtime = new ChatRuntime({ store, drivers: {}, api });
    const chat = runtime.create({});
    runtime.send(chat.id, { text: 'Finish architecture first', clientMessageId: 'm' });
    await runtime.idle();
    assert.equal(chat.tasks.length, 1);
    assert.equal(chat.tasks[0]?.status, 'failed');
    assert.match(chat.tasks[0]?.error ?? '', /阶段|工具执行失败/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('provider refusal fails, and repeated output cap or context overflow creates a fresh window', async t => {
  for (const reason of ['refusal', 'max_output', 'context_overflow'] as const) {
    await t.test(reason, async () => {
      const base = tempDir('dmw-api-stop-');
      try {
        const store = new ChatStore(base);
        const roster = loadRoster('config/roster.json', registry);
        let sends = 0;
        const api = createApiChatBinding(roster, registry, null, { offline: true, providerFor: model =>
          new ScriptedProvider(() => {
            sends++;
            if (sends <= (reason === 'max_output' ? 2 : 1)) return [
              { type: 'usage', input: 40, cachedInput: 0, output: 20 }, { type: 'end', reason },
            ];
            return response(['task_complete', { result: '模拟数据：已在新窗口完成' }]);
          }, model.protocol),
        });
        const runtime = new ChatRuntime({ store, drivers: {}, api, handoffMs: 5 });
        const chat = runtime.create({});
        runtime.send(chat.id, { text: 'Finish with a valid result', clientMessageId: 'm' });
        await runtime.idle();
        assert.equal(chat.invocations[0]?.finishReason, reason);
        if (reason === 'refusal') {
          assert.equal(chat.tasks[0]?.status, 'failed');
          assert.equal(chat.invocations.length, 1);
        } else {
          assert.equal(chat.invocations.length, 2);
          assert.equal(chat.invocations[0]?.rotationReason, 'hard');
          assert.equal(chat.tasks[0]?.status, 'completed');
          assert.equal(store.events(chat.id, 0).items.some(event => event.type === 'context_incident'), reason === 'context_overflow');
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
