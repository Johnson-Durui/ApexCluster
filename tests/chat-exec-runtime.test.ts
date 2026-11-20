import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { freezeApiRoster, loadRoster } from '../src/chat/roster.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { AgentTask, Invocation } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { DockerBackend } from '../src/exec/docker.js';
import { readExecReceipt } from '../src/exec/records.js';
import { ExecTools } from '../src/exec/tools.js';
import type { ExecBackend } from '../src/exec/types.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider, type ScriptedTurn } from '../src/providers/scripted.js';
import type { ProviderEvent } from '../src/providers/types.js';
import { tempDir } from './helpers.js';

const models = loadModelRegistry();

type Call = [name: string, args: Record<string, unknown>];

function response(...calls: Call[]): ProviderEvent[] {
  return [
    { type: 'usage', input: 40, cachedInput: 0, output: 20 },
    ...calls.map(([name, args], index) => ({ type: 'tool_call' as const, callId: `tool-${index}`, name, args })),
    { type: 'end', reason: 'tool_calls' },
  ];
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('Claude lead cannot execute while Astra verifies in a derived copy with immutable evidence', async () => {
  const base = tempDir('dmw-chat-exec-');
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    const source = path.join(project, 'source.txt');
    writeFileSync(source, 'main stays unchanged\n');
    const before = sha256(source);
    let executedCopy = '';
    const backend: ExecBackend = {
      id: 'docker',
      probe: async () => ({ ok: true }),
      run: async (_spec, context) => {
        executedCopy = context.copyDir;
        assert.notEqual(path.resolve(context.copyDir), path.resolve(project));
        assert.equal(readFileSync(path.join(context.copyDir, 'source.txt'), 'utf8'), 'main stays unchanged\n');
        writeFileSync(path.join(context.copyDir, 'sentinel.txt'), 'copy only\n');
        writeFileSync(path.join(context.outputDir, 'stdout.txt'), 'verified derived copy\n');
        writeFileSync(path.join(context.outputDir, 'stderr.txt'), '');
        return { exitCode: 0, timedOut: false, cancelled: false, exitConfirmed: true, durationMs: 1,
          stdoutRef: 'stdout.txt', stderrRef: 'stderr.txt', network: 'none' };
      },
    };
    const roster = loadRoster('config/roster.json', models);
    const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    const store = new ChatStore(path.join(base, 'store'));
    let stage = 'delegate';
    let astraTaskId = '';
    const script = (turn: ScriptedTurn): ProviderEvent[] => {
      const tools = new Set(turn.init.tools.map(tool => tool.name));
      if (turn.init.model.id === 'gpt-6.2-astra') {
        assert.equal(tools.has('exec'), true);
        if (turn.turn === 1) return response(['exec', { argv: ['fixture-check'], cwd: '.', timeoutMs: 1_000, purpose: 'test' }]);
        return response(['task_complete', { result: '模拟数据：派生副本验证通过' }]);
      }
      assert.equal(turn.init.model.id, 'claude-fable-5-2');
      assert.equal(tools.has('exec'), false);
      if (stage === 'delegate') {
        stage = 'collect';
        return response(['agent_submit', { role: 'astra', phase: 'acceptance', mode: 'verify', goal: 'Verify only the frozen copy' }]);
      }
      if (stage === 'collect') {
        astraTaskId = (JSON.parse(turn.input.toolResults!.at(-1)!.text) as Array<{ taskId: string }>)[0]!.taskId;
        stage = 'finish';
        return response(['task_collect', { taskIds: [astraTaskId], wait: true }]);
      }
      if (!turn.input.toolResults) return response(['task_collect', { taskIds: [astraTaskId], wait: true }]);
      return response(
        ['task_disposition', { taskId: astraTaskId, disposition: 'adopted' }],
        ['task_complete', { result: '模拟数据：验收完成' }],
      );
    };
    const api = createApiChatBinding(roster, models, null, { offline: true,
      providerFor: model => new ScriptedProvider(script, model.protocol) });
    const runtime = new ChatRuntime({ store, drivers: {}, api, workspace: new WorkspaceGateway(registry),
      executor: new ExecTools(backend, path.join(base, 'exec')), handoffMs: 5 });
    const chat = runtime.create({ workspaceId: grant.id });
    runtime.send(chat.id, { text: 'Verify the current source without changing main', clientMessageId: 'exec-runtime' });
    await runtime.idle();

    assert.deepEqual(chat.tasks.map(task => [task.role, task.status]), [['claude', 'completed'], ['astra', 'completed']]);
    assert.ok(executedCopy);
    assert.equal(existsSync(path.join(executedCopy, 'sentinel.txt')), true);
    assert.equal(existsSync(path.join(project, 'sentinel.txt')), false);
    assert.equal(sha256(source), before);
    const job = chat.execJobs?.[0];
    assert.equal(job?.state, 'finished');
    assert.ok(job?.testSnapshotId);
    assert.ok(job?.receiptRef);
    const receipt = JSON.parse(store.readBlob(chat.id, job!.receiptRef!).toString('utf8')) as {
      ok: boolean; purpose: string; sourceFingerprint: string; testSnapshotId: string;
      result: { stdoutRef: string; stderrRef: string; exitConfirmed: boolean };
    };
    assert.equal(receipt.ok, true);
    assert.equal(receipt.purpose, 'test');
    assert.equal(receipt.sourceFingerprint, job!.sourceFingerprint);
    assert.equal(receipt.testSnapshotId, job!.testSnapshotId);
    assert.equal(receipt.result.exitConfirmed, true);
    assert.equal(store.readBlob(chat.id, receipt.result.stdoutRef).toString('utf8'), 'verified derived copy\n');
    assert.equal(store.readBlob(chat.id, receipt.result.stderrRef).toString('utf8'), '');
    assert.throws(() => store.putBlob(chat.id, path.basename(job!.receiptRef!), '{}'), /EEXIST|file already exists/i);
    assert.ok(chat.toolResults?.some(item => item.taskId === astraTaskId && item.name === 'exec' && item.provenance === 'runner'));
    assert.ok(chat.tickets.some(ticket => ticket.taskId === astraTaskId && ticket.id === job!.id && ticket.processStatus === 'exited'));
    assert.match(readExecReceipt(store, chat, job!), /"ok":true/);
    writeFileSync(path.join(base, 'store', 'chats', chat.id, job!.receiptRef!), '{"ok":true,"tampered":true}');
    assert.throws(() => readExecReceipt(store, chat, job!), /哈希不一致/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unavailable exec backend fails an implementation task before model dispatch', async () => {
  const base = tempDir('dmw-chat-exec-unavailable-');
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    const store = new ChatStore(path.join(base, 'store'));
    const roster = loadRoster('config/roster.json', models);
    let modelDispatches = 0;
    const api = createApiChatBinding(roster, models, null, { offline: true, providerFor: model =>
      new ScriptedProvider(() => {
        modelDispatches++;
        return response(['task_complete', { result: 'must not run' }]);
      }, model.protocol),
    });
    const backend: ExecBackend = {
      id: 'docker',
      probe: async () => ({ ok: false, reason: 'fixture backend unavailable' }),
      run: async () => { throw new Error('run must not be called'); },
    };
    const runtime = new ChatRuntime({ store, drivers: {}, api, workspace: new WorkspaceGateway(registry),
      executor: new ExecTools(backend, path.join(base, 'exec')), handoffMs: 5 });
    const chat = runtime.create({ workspaceId: grant.id });
    const now = new Date().toISOString();
    const task: AgentTask = { id: 'implementation-task', turnId: 'implementation-turn', role: 'sol', phase: 'implementation',
      goal: 'Implement only with a working execution backend', status: 'queued', createdAt: now, updatedAt: now, segment: 0,
      invocationIds: [], noProgressSegments: 0, workspaceId: grant.id, workspaceVersion: grant.version, mode: 'edit' };
    chat.tasks.push(task);
    chat.turns.push({ id: task.turnId, rootTaskId: task.id, status: 'queued', createdAt: now });
    store.save(chat);

    runtime['start'](chat, task);
    await runtime.idle();

    assert.equal(modelDispatches, 0);
    assert.equal(task.status, 'failed');
    assert.match(task.error ?? '', /fixture backend unavailable/);
    assert.equal(chat.invocations.length, 1);
    assert.equal(chat.invocations[0]?.failureMessage, 'fixture backend unavailable');
    assert.equal(chat.invocations[0]?.exitConfirmed, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const realDockerImage = process.env.DMW_DOCKER_SANDBOX_IMAGE;
test('Astra runtime executes against a derived copy through the exact real Docker image', {
  skip: realDockerImage ? false : 'set DMW_DOCKER_SANDBOX_IMAGE to an immutable local image ID',
}, async t => {
  const base = tempDir('dmw-chat-real-docker-');
  const fixtureId = randomUUID().replaceAll('-', '');
  const volume = `dmw-chat-runtime-${fixtureId}`;
  const fixtureLabel = `m5-chat-runtime-${fixtureId}`;
  let ownedVolume = false;
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    const source = path.join(project, 'source.txt');
    writeFileSync(source, 'real main stays unchanged\n');
    const before = sha256(source);
    const docker = new DockerBackend({ image: realDockerImage!, packageCacheVolume: volume, user: '10001:10001' });
    const probe = await docker.probe();
    if (!probe.ok) { t.skip(`Docker unavailable: ${probe.reason}`); return; }
    assert.throws(() => execFileSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }));
    execFileSync('docker', ['volume', 'create', '--label', `com.dual-model-workbench.fixture=${fixtureLabel}`,
      '--label', 'com.dual-model-workbench.owner=exec-v1', volume], { stdio: 'ignore' });
    ownedVolume = true;
    let executedCopy = '';
    const backend: ExecBackend = {
      id: 'docker',
      probe: () => docker.probe(),
      run: (spec, context) => {
        executedCopy = context.copyDir;
        return docker.run(spec, context);
      },
    };
    const roster = loadRoster('config/roster.json', models);
    const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    const store = new ChatStore(path.join(base, 'store'));
    let dispatches = 0;
    const api = createApiChatBinding(roster, models, null, { offline: true, providerFor: model =>
      new ScriptedProvider(turn => {
        dispatches++;
        assert.equal(turn.init.model.id, 'gpt-6.2-astra');
        assert.equal(turn.init.tools.some(tool => tool.name === 'exec'), true);
        if (turn.turn === 1) return response(['exec', {
          argv: ['node', '-e', "const fs=require('fs');const p='/workspace/docker-sentinel.txt';fs.writeFileSync(p,'real copy only\\n');console.log(fs.readFileSync('/workspace/source.txt','utf8').trim())"],
          cwd: '.', timeoutMs: 10_000, purpose: 'test',
        }]);
        return response(['task_complete', { result: '模拟数据：真实 Docker 派生副本验证通过' }]);
      }, model.protocol),
    });
    const runtime = new ChatRuntime({ store, drivers: {}, api, workspace: new WorkspaceGateway(registry),
      executor: new ExecTools(backend, path.join(base, 'exec')), handoffMs: 5 });
    const chat = runtime.create({ workspaceId: grant.id });
    const now = new Date().toISOString();
    const task: AgentTask = { id: 'real-docker-astra', turnId: 'real-docker-turn', role: 'astra', phase: 'acceptance',
      goal: 'Verify the frozen source through the exact Docker image', status: 'queued', createdAt: now, updatedAt: now,
      segment: 0, invocationIds: [], noProgressSegments: 0, workspaceId: grant.id, workspaceVersion: grant.version, mode: 'verify' };
    chat.tasks.push(task);
    chat.turns.push({ id: task.turnId, rootTaskId: task.id, status: 'queued', createdAt: now });
    store.save(chat);

    runtime['start'](chat, task);
    await runtime.idle();

    assert.equal(dispatches, 2);
    assert.equal(task.status, 'completed', task.error);
    assert.notEqual(path.resolve(executedCopy), path.resolve(project));
    assert.equal(readFileSync(path.join(executedCopy, 'docker-sentinel.txt'), 'utf8'), 'real copy only\n');
    assert.equal(existsSync(path.join(project, 'docker-sentinel.txt')), false);
    assert.equal(sha256(source), before);
    const job = chat.execJobs?.[0];
    assert.equal(job?.backend, 'docker');
    assert.equal(job?.state, 'finished');
    assert.ok(job?.testSnapshotId && job.receiptRef);
    const receipt = JSON.parse(store.readBlob(chat.id, job!.receiptRef!).toString('utf8')) as {
      ok: boolean; backend: string; result: { stdoutRef: string; network: string; exitConfirmed: boolean };
    };
    assert.equal(receipt.ok, true);
    assert.equal(receipt.backend, 'docker');
    assert.equal(receipt.result.network, 'none');
    assert.equal(receipt.result.exitConfirmed, true);
    assert.match(store.readBlob(chat.id, receipt.result.stdoutRef).toString('utf8'), /real main stays unchanged/);
  } finally {
    if (ownedVolume) {
      const actual = execFileSync('docker', ['volume', 'inspect', '--format', '{{ index .Labels "com.dual-model-workbench.fixture" }}', volume], { encoding: 'utf8' }).trim();
      assert.equal(actual, fixtureLabel, 'refusing to remove a volume not owned by this exact fixture');
      execFileSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
      assert.throws(() => execFileSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }));
    }
    rmSync(base, { recursive: true, force: true });
  }
});
test('Sol integrates generated files from its sanitized working copy and can reuse the copy', () => {
  const base = tempDir('dmw-sol-exec-');
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    writeFileSync(path.join(project, '.env'), 'PRIVATE_VALUE=canary');
    writeFileSync(path.join(project, 'source.txt'), 'main input');
    const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const workspace = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    const store = new ChatStore(path.join(base, 'store'));
    const registryModels = loadModelRegistry();
    const roster = loadRoster('config/roster.json', registryModels);
    const chat = store.create({ workspaceId: workspace.id, apiRoster: freezeApiRoster(roster, registryModels) });
    const now = new Date().toISOString();
    const task: AgentTask = { id: 'sol-task', turnId: 'demo-turn', role: 'sol', phase: 'demo', goal: '生成测试文件',
      mode: 'edit', status: 'running', createdAt: now, updatedAt: now, segment: 1, invocationIds: ['sol-inv'],
      noProgressSegments: 0, workspaceId: workspace.id, workspaceVersion: workspace.version };
    const invocation: Invocation = { id: 'sol-inv', segment: 1, taskId: task.id, status: 'running', startedAt: now,
      toolCount: 0, promptVersion: 'fixture', inputEstimate: 0, contextWindow: null, contextUsed: null };
    chat.tasks.push(task);
    chat.invocations.push(invocation);
    const identity = { chat, task, invocation, signal: new AbortController().signal };
    const gateway = new WorkspaceGateway(registry);
    const origin = gateway.prepareExec(identity);
    assert.notEqual(origin.copyDir, project);
    assert.equal(existsSync(path.join(origin.copyDir, '.env')), false);
    writeFileSync(path.join(origin.copyDir, 'generated.txt'), 'generated');
    assert.deepEqual(gateway.finishExecWrites(identity, origin)?.created, ['generated.txt']);
    assert.equal(readFileSync(path.join(project, 'generated.txt'), 'utf8'), 'generated');
    assert.equal(gateway.prepareExec(identity).copyDir, origin.copyDir);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
