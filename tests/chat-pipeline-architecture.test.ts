import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ProjectOutputStore } from '../src/artifacts/project-output.js';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { parseApiRunSettings } from '../src/chat/api-run-settings.js';
import { createProductionChatRuntime } from '../src/chat/bootstrap.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { loadRoster } from '../src/chat/roster.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatEvent, ChatRecord } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { DockerBackend } from '../src/exec/docker.js';
import { ExecTools } from '../src/exec/tools.js';
import { architectureDemoEvidence } from '../src/pipeline/architecture.js';
import { applyPipelineGate, validatePipelineGate } from '../src/pipeline/gates.js';
import { newPipelineState } from '../src/pipeline/state.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import { architectureScript, requirement, response, scenario } from './fixtures/pipeline/todo-cli/script.js';
import { tempDir } from './helpers.js';

const modelRegistry = loadModelRegistry();

test('todo-cli fixture is self-consistent and every scripted semantic output is marked', () => {
  assert.equal(scenario.version, 1);
  assert.match(requirement, /demo\/cli\.mjs/);
  assert.deepEqual(new Set(scenario.requirements.map(item => item.id)), new Set(['R-001', 'R-002']));
  assert.deepEqual(new Set(scenario.acceptance.flatMap(item => item.requirementIds)), new Set(['R-001', 'R-002']));
  assert.ok(scenario.requirements.every(item => item.text.includes('模拟数据')));
  assert.ok(scenario.acceptance.every(item => item.description.includes('模拟数据')));
});

test('automatic gate A records a system decision while user mode keeps clarification on the root seat only', async () => {
  const automatic = newPipelineState({ preset: 'flagship', auto: true });
  automatic.stage = 'gate-a';
  automatic.contract = { ref: 'agent-outputs/CONTRACT.json', hash: 'a'.repeat(64), contractSha256: 'b'.repeat(64), artifactId: 'contract', revision: 1 };
  const action = validatePipelineGate(automatic, 'A', { decision: 'confirm' }, true);
  applyPipelineGate(automatic, 'A', action, 'system:auto:gate-a', true, new Date().toISOString());
  assert.equal(automatic.stage, 'implementation');
  assert.deepEqual(automatic.gateDecisions.map(item => [item.gateId, item.decision, item.automatic]), [['A', 'confirm', true]]);

  const base = tempDir('dmw-pipeline-clarify-');
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    const roster = loadRoster('config/presets/roster.flagship.json', modelRegistry);
    const seen = new Map<string, string[]>();
    const asked = new Set<string>();
    const api = createApiChatBinding(roster, modelRegistry, null, { offline: true, providerFor: model => new ScriptedProvider(turn => {
      const names = turn.init.tools.map(tool => tool.name);
      seen.set(turn.init.cacheKey, names);
      if (names.includes('ask_user') && !asked.has(turn.init.cacheKey)) {
        asked.add(turn.init.cacheKey);
        return response(['ask_user', { question: '请选择待办是否允许重复文字', options: ['允许', '拒绝'] }]);
      }
      return response(['task_fail', { reason: '模拟数据：权限夹具完成' }]);
    }, model.protocol) });
    const runtime = createProductionChatRuntime({ store: new ChatStore(path.join(base, 'store')), drivers: {}, api,
      workspace: new WorkspaceGateway(registry), pipelineRosters: new Map([['flagship', roster]]), handoffMs: 5 });
    const userChat = runtime.create({ workspaceId: grant.id, pipeline: { preset: 'flagship', auto: false } });
    runtime.send(userChat.id, { text: '模拟数据：需要澄清', clientMessageId: 'clarify-user' });
    await runtime.idle();
    const root = userChat.tasks[0]!;
    assert.equal(root.status, 'waiting_user');
    assert.equal(userChat.tasks.length, 1);
    assert.equal(seen.get(root.id)?.includes('ask_user'), true);

    const autoChat = runtime.create({ workspaceId: grant.id, pipeline: { preset: 'flagship', auto: true } });
    runtime.send(autoChat.id, { text: '模拟数据：自动记录假设', clientMessageId: 'clarify-auto' });
    await runtime.idle();
    const autoRoot = autoChat.tasks[0]!;
    assert.equal(seen.get(autoRoot.id)?.includes('ask_user'), false);
    assert.equal(autoChat.tasks.length, 1);
    assert.equal(autoRoot.status, 'failed');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

const realDockerImage = process.env.DMW_DOCKER_SANDBOX_IMAGE;
for (const [automatic, repairDemo] of [[false, false], [true, false], [false, true]] as const) {
  const preset = automatic ? scenario.preset : 'single-provider';
  test(`scripted ${preset} architecture pipeline reaches ${automatic ? 'implementation automatically' : 'user gate A'} with a real Docker Demo${repairDemo ? ' after a failed independent Demo review' : ''}`, {
    skip: realDockerImage ? false : 'set DMW_DOCKER_SANDBOX_IMAGE to the immutable M5 runtime image ID',
  }, async t => {
    const base = tempDir(`dmw-pipeline-${automatic ? 'auto' : 'user'}-`);
    const identity = randomUUID().replaceAll('-', '');
    const volume = `dmw-m6-todo-${identity}`;
    const fixtureLabel = `m6-todo-${identity}`;
    let ownedVolume = false;
    try {
      const project = path.join(base, 'project');
      mkdirSync(project);
      writeFileSync(path.join(project, 'requirement.md'), requirement);
      const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
      const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
      const workspace = new WorkspaceGateway(registry);
      const projectOutputs = new ProjectOutputStore(registry);
      const storeRoot = path.join(base, 'store');
      const restartRoot = path.join(base, 'restart-store');
      const store = new ChatStore(storeRoot);
      const roster = loadRoster(`config/presets/roster.${preset}.json`, modelRegistry);

      assert.throws(() => execFileSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }));
      execFileSync('docker', ['volume', 'create', '--label', 'com.dual-model-workbench.owner=exec-v1',
        '--label', `com.dual-model-workbench.fixture=${fixtureLabel}`, volume], { stdio: 'ignore' });
      ownedVolume = true;
      const docker = new DockerBackend({ image: realDockerImage!, packageCacheVolume: volume, user: '10001:10001' });
      const probe = await docker.probe();
      if (!probe.ok) { t.skip(`Docker unavailable: ${probe.reason}`); return; }

      let chat!: ChatRecord;
      const scripted = architectureScript(() => chat, repairDemo);
      const api = createApiChatBinding(roster, modelRegistry, null, { offline: true,
        providerFor: model => new ScriptedProvider(scripted, model.protocol) });
      const runtime = createProductionChatRuntime({ store, drivers: {}, api, workspace, projectOutputs,
        executor: new ExecTools(docker, path.join(base, 'exec')),
        pipelineRosters: new Map([[preset, roster]]), handoffMs: 5 });
      chat = runtime.create({ workspaceId: grant.id, pipeline: { preset, auto: automatic } });
      let repairReceipt: ChatEvent | undefined;
      let captureError: unknown;
      const unsubscribe = repairDemo ? runtime.subscribe(chat.id, event => {
        if (event.type !== 'tool_result') return;
        const data = event.data as { name?: string; text?: string } | null;
        if (data?.name !== 'agent_submit' || typeof data.text !== 'string') return;
        try {
          const reply = JSON.parse(data.text);
          if (reply.action !== 'demo_repair') return;
          assert.equal(reply.accepted, true);
          assert.equal(reply.finalization, 'awaiting_confirmed_process_exit');
          cpSync(storeRoot, restartRoot, { recursive: true, errorOnExist: true, force: false });
          repairReceipt = event;
        } catch (error) { captureError = error; }
      }) : undefined;
      try {
        runtime.send(chat.id, { text: requirement, clientMessageId: `m6-todo-cli-${automatic ? 'auto' : 'user'}` });
        await runtime.idle();
      } finally { unsubscribe?.(); }

      const root = chat.tasks.find(task => task.id === chat.pipeline?.architectureTaskId)!;
      assert.equal(root.status, 'completed', JSON.stringify(chat.tasks.map(task => ({ role: task.role, phase: task.phase, status: task.status, error: task.error }))));
      assert.equal(chat.pipeline?.stage, automatic ? 'implementation' : 'gate-a');
      assert.equal(chat.pipeline?.gateDecisions.some(item => item.gateId === 'A' && item.automatic), automatic);
      assert.ok(root.invocationIds.length >= 2);
      assert.ok(chat.invocations.some(invocation => invocation.taskId === root.id && invocation.rotationReason === 'yield'));
      assert.equal(chat.pipeline?.clusters[0]?.mode, 'full');
      assert.equal(chat.pipeline?.clusters[0]?.status, 'completed');
      assert.ok(chat.pipeline?.clusters[0]?.summaryRef);

      const artifactNames = new Set(chat.artifacts.map(artifact => artifact.name));
      for (const name of scenario.expectedArtifacts) assert.ok(artifactNames.has(name), `missing ${name}`);
      assert.equal(existsSync(path.join(project, 'demo', 'cli.mjs')), true);
      assert.match(readFileSync(path.join(project, 'demo', 'cli.mjs'), 'utf8'), /模拟数据/);
      assert.ok(chat.artifacts.filter(artifact => artifact.provenance === 'model').every(artifact =>
        store.readBlob(chat.id, artifact.relativePath).toString('utf8').includes('模拟数据')));
      assert.ok(chat.tasks.filter(task => task.parentTaskId).every(task => task.result?.includes('模拟数据')));

      const demo = chat.tasks.find(task => task.role === 'sol' && task.phase === 'demo' && task.parentTaskId === root.id)!;
      const jobs = chat.execJobs?.filter(job => job.taskId === demo.id) ?? [];
      assert.equal(jobs.length, 1);
      const job = jobs[0]!;
      assert.deepEqual([job.backend, job.purpose, job.state, Boolean(job.receiptRef)], ['docker', 'test', 'finished', true]);
      const receipt = JSON.parse(store.readBlob(chat.id, job.receiptRef!).toString('utf8')) as {
        ok: boolean; backend: string; purpose: string; result: { exitCode: number; network: string; exitConfirmed: boolean; stdoutRef: string };
      };
      assert.deepEqual([receipt.ok, receipt.backend, receipt.purpose, receipt.result.exitCode, receipt.result.network, receipt.result.exitConfirmed],
        [true, 'docker', 'test', 0, 'none', true]);
      assert.match(store.readBlob(chat.id, receipt.result.stdoutRef).toString('utf8'), /first/);
      assert.equal(root.executionReviewAttempts?.at(-1)?.review?.outcome, 'passed');
      assert.ok(chat.todos?.every(step => step.status === 'completed'));
      if (repairDemo) {
        const state = chat.pipeline!;
        const earlier = chat.tasks.find(task => !task.parentTaskId && task.id !== root.id)!;
        const priorReview = earlier.executionReviewAttempts!.at(-1)!;
        const newReview = root.executionReviewAttempts!.at(-1)!;
        assert.equal(earlier.status, 'failed');
        assert.equal(priorReview.review?.outcome, 'failed');
        assert.notEqual(priorReview.taskId, newReview.taskId);
        assert.notEqual(priorReview.evidenceHash, newReview.evidenceHash);
        assert.equal(state.revision, 2);
        assert.equal(state.demoRepairFrom, 1);
        assert.deepEqual(state.priorContracts.map(item => item.revision), [1]);
        assert.equal(state.contract?.revision, 2);
        assert.notEqual(state.priorContracts[0]!.ref, state.contract?.ref);
        const oldContract = JSON.parse(store.readBlob(chat.id, state.priorContracts[0]!.ref).toString('utf8'));
        const newContract = JSON.parse(store.readBlob(chat.id, state.contract!.ref).toString('utf8'));
        assert.deepEqual(oldContract.requirements, newContract.requirements);
        assert.deepEqual(oldContract.acceptance, newContract.acceptance);
        assert.equal(chat.constraintMessageIds.length, 1);
        assert.deepEqual(chat.execJobs?.filter(item => item.taskId === priorReview.taskId || item.taskId === newReview.taskId).map(item =>
          JSON.parse(store.readBlob(chat.id, item.receiptRef!).toString('utf8')).result.exitCode), [1, 0]);
        const previousDemo = chat.tasks.find(task => task.parentTaskId === earlier.id && task.phase === 'demo')!;
        assert.notEqual(chat.execJobs?.find(item => item.taskId === previousDemo.id)?.sourceFingerprint, job.sourceFingerprint);
        const persisted = store.get(chat.id);
        assert.equal(persisted.pipeline?.contract?.artifactId, state.contract?.artifactId);
        assert.equal(persisted.tasks.find(task => task.id === earlier.id)?.executionReviewAttempts?.at(-1)?.review?.outcome, 'failed');

        assert.ifError(captureError);
        assert.ok(repairReceipt && repairReceipt.taskId === earlier.id && repairReceipt.invocationId);
        const interruptedInvocationId = repairReceipt.invocationId;
        const copiedStore = new ChatStore(restartRoot);
        const before = copiedStore.get(chat.id);
        const beforeInvocation = before.invocations.find(item => item.id === interruptedInvocationId);
        assert.equal(beforeInvocation?.status, 'running');
        assert.notEqual(beforeInvocation?.exitConfirmed, true);
        assert.equal(before.pipeline?.revision, 1);
        assert.equal(before.pipeline?.architectureTaskId, earlier.id);
        assert.deepEqual(before.pipeline?.contract, state.priorContracts[0]);
        const originalMessages = copiedStore.messages(chat.id).items.filter(message => message.role === 'user');
        assert.deepEqual(originalMessages.map(message => message.text), [requirement]);

        let restartedCalls = 0;
        const restarted = createProductionChatRuntime({
          store: copiedStore, drivers: {}, workspace,
          api: createApiChatBinding(roster, modelRegistry, null, { offline: true, providerFor: model => new ScriptedProvider(() => {
            restartedCalls++;
            throw new Error('Recovery must persist the replacement before invoking a provider');
          }, model.protocol) }),
          apiRunSettings: parseApiRunSettings({ recovery: { autoResume: true } }),
        });
        try {
          restarted.recover();
          const recovered = restarted.get(chat.id);
          const newId = recovered.pipeline?.architectureTaskId;
          assert.ok(newId && newId !== earlier.id);
          assert.equal(recovered.pipeline?.revision, 2);
          assert.equal(recovered.pipeline?.stage, 'architecture');
          assert.equal(recovered.pipeline?.demoRepairFrom, 1);
          assert.equal(recovered.pipeline?.contract, undefined);
          assert.deepEqual(recovered.pipeline?.priorContracts, [before.pipeline?.contract]);
          assert.deepEqual(recovered.pipeline?.gateDecisions, before.pipeline?.gateDecisions);
          assert.equal(recovered.tasks.find(task => task.id === earlier.id)?.status, 'failed');
          assert.equal(recovered.tasks.find(task => task.id === newId)?.status, 'queued');
          assert.equal(recovered.tasks.find(task => task.id === earlier.id)?.executionReviewAttempts?.at(-1)?.review?.outcome, 'failed');

          restarted.recover();
          const reread = new ChatStore(restartRoot).get(chat.id);
          assert.equal(reread.pipeline?.revision, 2);
          assert.equal(reread.pipeline?.architectureTaskId, newId);
          assert.deepEqual(reread.tasks.filter(task => !task.parentTaskId).map(task => task.id), [earlier.id, newId]);
          assert.deepEqual(reread.constraintMessageIds, before.constraintMessageIds);
          assert.deepEqual(copiedStore.messages(chat.id).items.filter(message => message.role === 'user'), originalMessages);
        } finally { await restarted.shutdown(); }
        assert.equal(restartedCalls, 0);
      }

      const current = (author: typeof demo, candidate: typeof job) => workspace.matchesCurrentSource?.(author, candidate) === true;
      assert.ok(architectureDemoEvidence(chat, root, chat.pipeline!, store, current));
      chat.sourceRevisions![root.turnId] = (chat.sourceRevisions![root.turnId] ?? 0) + 1;
      assert.equal(architectureDemoEvidence(chat, root, chat.pipeline!, store, current), undefined,
        'a passing Demo receipt from an older source revision must become stale');
    } finally {
      if (ownedVolume) {
        const label = execFileSync('docker', ['volume', 'inspect', '--format', '{{ index .Labels "com.dual-model-workbench.fixture" }}', volume], { encoding: 'utf8' }).trim();
        assert.equal(label, fixtureLabel, 'refusing to remove a volume not owned by this exact fixture');
        execFileSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
}
