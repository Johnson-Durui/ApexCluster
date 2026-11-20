import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectOutputStore } from '../src/artifacts/project-output.js';
import { createApiChatBinding } from '../src/chat/api-driver.js';
import { createProductionChatRuntime } from '../src/chat/bootstrap.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { loadRoster } from '../src/chat/roster.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatRecord } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';
import { DockerBackend } from '../src/exec/docker.js';
import { ExecTools } from '../src/exec/tools.js';
import type { FrozenContract } from '../src/pipeline/contract.js';
import { milestonePathIssues, readyMilestones, validateImplementationPlan, validatePipelineReview } from '../src/pipeline/implementation.js';
import type { ImplementationState } from '../src/pipeline/implementation-types.js';
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import { implementationMilestones, implementationPlanInput, pipelineScript } from './fixtures/pipeline/todo-cli/implementation-script.js';
import { requirement, scenario } from './fixtures/pipeline/todo-cli/script.js';

const contractHash = 'a'.repeat(64);
const contract: FrozenContract = {
  version: 1,
  requirements: [
    { id: 'R-001', text: '模拟数据：新增待办', sourceIds: ['message:1'], assumptionIds: [] },
    { id: 'R-002', text: '模拟数据：列出待办', sourceIds: ['message:1'], assumptionIds: [] },
  ],
  acceptance: [
    { id: 'AC-001', requirementIds: ['R-001'], kind: 'command', description: '模拟数据：add', command: 'node demo/cli.mjs add first' },
    { id: 'AC-002', requirementIds: ['R-002'], kind: 'command', description: '模拟数据：list', command: 'node demo/cli.mjs list' },
  ],
  assumptions: [], sources: [{ id: 'message:1', sha256: 'b'.repeat(64) }], artifacts: [], sha256: contractHash,
};

test('todo-cli implementation plan covers every AC once with both owners and deterministic dependencies', () => {
  const validated = validateImplementationPlan(implementationPlanInput, contract, contractHash);
  assert.deepEqual(validated.plan.milestones.map(item => item.id), ['M-CLI', 'M-STORE']);
  assert.deepEqual(new Set(validated.plan.milestones.map(item => item.owner)), new Set(['opus', 'sol']));
  assert.deepEqual(new Set(validated.plan.milestones.flatMap(item => item.acceptanceIds)), new Set(['AC-001', 'AC-002']));
  const state: ImplementationState = { version: 1, round: 1, rootTaskId: 'root', proposals: [],
    milestones: implementationMilestones.map(item => ({ id: item.id, status: 'ready', attempts: [] })) };
  assert.deepEqual(readyMilestones(validated.plan, state).map(item => item.id), ['M-STORE']);
  state.milestones.find(item => item.id === 'M-STORE')!.status = 'complete';
  assert.deepEqual(readyMilestones(validated.plan, state).map(item => item.id), ['M-CLI']);
});

test('implementation review is exact-hash, cross-family, receipt-bound, and stale verdicts fail', () => {
  const subjectHash = 'c'.repeat(64);
  const context = { subjectHash, reviewerTaskId: 'review', reviewer: 'sol' as const, reviewerModel: 'gpt-5.6-sol', reviewerFamily: 'openai',
    author: 'opus' as const, authorModel: 'claude-opus-5-5', authorFamily: 'anthropic', acceptanceIds: ['AC-001'], requireChecks: true,
    checks: [{ checkId: 'CHECK-STORE', ref: 'blobs/receipt.json', hash: 'd'.repeat(64), snapshotId: 'snapshot', fingerprint: 'e'.repeat(64), ok: true }] };
  assert.equal(validatePipelineReview({ subjectHash, outcome: 'passed', defects: [] }, context).outcome, 'passed');
  assert.throws(() => validatePipelineReview({ subjectHash: 'f'.repeat(64), outcome: 'passed', defects: [] }, context), /哈希/);
  assert.throws(() => validatePipelineReview({ subjectHash, outcome: 'passed', defects: [] }, { ...context, reviewerFamily: 'anthropic' }), /厂商/);
  assert.throws(() => validatePipelineReview({ subjectHash, outcome: 'passed', defects: [] }, { ...context, checks: [] }), /真实检查/);
});

test('milestone path sentinel rejects undeclared drift', () => {
  assert.deepEqual(milestonePathIssues(['demo/cli.mjs', 'demo/todo.test.mjs'], {
    created: ['demo/todo.test.mjs'], modified: ['demo/cli.mjs'], deleted: [],
  }), []);
  assert.deepEqual(milestonePathIssues(['demo/cli.mjs'], {
    created: [], modified: ['demo/cli.mjs', 'package.json'], deleted: [],
  }), ['改动越出里程碑声明路径：package.json']);
});

const realDockerImage = process.env.DMW_DOCKER_SANDBOX_IMAGE;
for (const variant of [
  { id: 'success', failMilestoneVerify: false, failFinalCommand: false, adversarialDrift: false },
  { id: 'verify-rework', failMilestoneVerify: true, failFinalCommand: false, adversarialDrift: false },
  { id: 'final-command-failure', failMilestoneVerify: false, failFinalCommand: true, adversarialDrift: false },
  { id: 'drift-recovery', failMilestoneVerify: false, failFinalCommand: false, adversarialDrift: true },
]) test(
  `scripted M7 ${variant.id} runs in real Docker`, {
  skip: realDockerImage ? false : 'set DMW_DOCKER_SANDBOX_IMAGE to the immutable M5 runtime image ID',
}, async t => {
  const base = mkdtempSync(path.join(tmpdir(), 'dmw-m7-todo-'));
  const identity = randomUUID().replaceAll('-', '');
  const volume = `dmw-m7-todo-${identity}`;
  const fixtureLabel = `m7-todo-${identity}`;
  let ownedVolume = false;
  try {
    const project = path.join(base, 'project');
    mkdirSync(path.join(project, 'demo'), { recursive: true });
    writeFileSync(path.join(project, 'requirement.md'), requirement);
    const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    const workspace = new WorkspaceGateway(registry);
    const store = new ChatStore(path.join(base, 'store'));
    const roster = loadRoster('config/presets/roster.flagship.json', loadModelRegistry());

    assert.throws(() => execFileSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }));
    execFileSync('docker', ['volume', 'create', '--label', 'com.dual-model-workbench.owner=exec-v1',
      '--label', `com.dual-model-workbench.fixture=${fixtureLabel}`, volume], { stdio: 'ignore' });
    ownedVolume = true;
    const docker = new DockerBackend({ image: realDockerImage!, packageCacheVolume: volume, user: '10001:10001' });
    const probe = await docker.probe();
    if (!probe.ok) { t.skip(`Docker unavailable: ${probe.reason}`); return; }

    let chat!: ChatRecord;
    const scripted = pipelineScript(() => chat, { failMilestoneVerify: variant.failMilestoneVerify,
      failFinalCommand: variant.failFinalCommand, adversarialDrift: variant.adversarialDrift });
    const api = createApiChatBinding(roster, loadModelRegistry(), null, { offline: true,
      providerFor: model => new ScriptedProvider(scripted, model.protocol) });
    const runtime = createProductionChatRuntime({ store, drivers: {}, api, workspace, pipelineWorkspace: workspace,
      projectOutputs: new ProjectOutputStore(registry), executor: new ExecTools(docker, path.join(base, 'exec')),
      pipelineRosters: new Map([[scenario.preset, roster]]), handoffMs: 5 });
    chat = runtime.create({ workspaceId: grant.id, pipeline: { preset: scenario.preset, auto: true } });
    runtime.send(chat.id, { text: requirement, clientMessageId: `m7-todo-cli-${identity}` });
    await runtime.idle(40_000);

    const implementation = chat.pipeline?.implementation;
    assert.ok(implementation, JSON.stringify(chat.tasks.map(task => ({ role: task.role, phase: task.phase, work: task.pipelineWork, status: task.status, error: task.error }))));
    if (variant.failMilestoneVerify) {
      const failed = implementation.milestones.find(item => item.id === 'M-STORE');
      assert.equal(failed?.status, 'blocked');
      assert.equal(failed?.attempts.length, chat.pipeline!.quality.maxReworkRounds + 1);
      assert.match(implementation.error ?? '', /超过返工上限/);
      assert.notEqual(chat.tasks.find(task => task.id === implementation.rootTaskId)?.status, 'completed');
      assert.equal(chat.pipeline?.gateDecisions.some(item => item.gateId === 'B'), false);
      assert.ok((chat.execJobs ?? []).some(job => {
        if (job.purpose !== 'test' || !job.receiptRef) return false;
        const receipt = JSON.parse(store.readBlob(chat.id, job.receiptRef).toString('utf8')) as { result?: { exitCode?: number } };
        return receipt.result?.exitCode === 17;
      }));
      return;
    }
    assert.ok(implementation.planHash, JSON.stringify({ stage: chat.pipeline?.stage, implementation,
      tasks: chat.tasks.map(task => ({ role: task.role, phase: task.phase, work: task.pipelineWork, status: task.status, error: task.error, disposition: task.disposition })) }));
    const proposal = implementation.proposals.find(item => item.hash === implementation.planHash);
    assert.equal(proposal?.review?.outcome, 'passed');
    assert.deepEqual(new Set(proposal?.plan.milestones.map(item => item.owner)), new Set(['opus', 'sol']));
    assert.ok(implementation.milestones.every(item => item.status === 'complete'), JSON.stringify({ implementation,
      tasks: chat.tasks.map(task => ({ role: task.role, work: task.pipelineWork, status: task.status, error: task.error, disposition: task.disposition })) }));
    assert.ok(implementation.milestones.every(item => item.attempts.at(-1)?.review?.outcome === 'passed'));
    assert.ok(implementation.milestones.every(item => item.attempts.at(-1)?.checks?.every(check => check.ok)));
    const commitPattern = /^[0-9a-f]{40,64}$/u;
    assert.match(implementation.baselineCommit ?? '', commitPattern);
    for (const item of implementation.milestones) assert.match(item.attempts.at(-1)?.commit ?? '', commitPattern);
    const opusAttempt = implementation.milestones.find(item => item.id === 'M-STORE')!.attempts.at(-1)!;
    assert.match(opusAttempt.integrationCommit ?? '', commitPattern);
    const commits = [...new Set([implementation.baselineCommit, ...implementation.milestones.flatMap(item => {
      const attempt = item.attempts.at(-1)!;
      return [attempt.integrationCommit, attempt.commit];
    })].filter((value): value is string => Boolean(value)))];
    for (const commit of commits) execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: project, stdio: 'ignore' });
    assert.ok(Number(execFileSync('git', ['rev-list', '--all', '--count'], { cwd: project, encoding: 'utf8' }).trim()) >= commits.length);
    if (variant.adversarialDrift) {
      const progress = implementation.milestones.find(item => item.id === 'M-STORE')!;
      const attempt = progress.attempts.find(item => item.drift)!;
      assert.equal(attempt.drift?.verdict, 'aligned');
      assert.ok(attempt.drift?.issues.some(issue => issue.includes('forbidden/outside.txt')));
      const watcher = chat.tasks.find(task => task.id === attempt.drift?.taskId)!;
      assert.equal(watcher.role, 'hydrogen');
      assert.match(JSON.parse(watcher.result!).summary, /^一致/u);
      const author = chat.tasks.find(task => task.id === attempt.authorTaskId)!;
      const handoffs = chat.invocations.filter(item => item.taskId === author.id && item.handoffRef).map(item =>
        store.readBlob(chat.id, item.handoffRef!).toString('utf8')).join('\n');
      assert.match(handoffs, /对齐提醒/u);
      assert.match(handoffs, /forbidden\/outside\.txt/u);
      assert.equal(existsSync(path.join(project, 'forbidden', 'outside.txt')), false);
    }
    if (variant.failFinalCommand) {
      assert.equal(implementation.trace, undefined);
      assert.notEqual(chat.tasks.find(task => task.id === implementation.rootTaskId)?.status, 'completed');
      assert.equal(chat.pipeline?.gateDecisions.some(item => item.gateId === 'B'), false);
      assert.ok((chat.execJobs ?? []).some(job => {
        if (job.purpose !== 'test' || !job.receiptRef) return false;
        const receipt = JSON.parse(store.readBlob(chat.id, job.receiptRef).toString('utf8')) as { result?: { exitCode?: number } };
        return receipt.result?.exitCode === 19;
      }));
      return;
    }
    assert.ok(implementation.trace);
    const traceArtifact = chat.artifacts.find(item => item.relativePath === implementation.trace!.ref);
    assert.ok(traceArtifact);
    const trace = JSON.parse(store.readBlob(chat.id, implementation.trace.ref).toString('utf8')) as {
      format: string; entries: { acceptanceId: string; status: string; finalProofs: unknown[] }[]; unverified: string[];
    };
    assert.equal(trace.format, 'implementation-trace/v1');
    assert.deepEqual(trace.entries.map(item => item.acceptanceId), ['AC-001', 'AC-002']);
    assert.ok(trace.entries.every(item => item.status === 'passed' && item.finalProofs.length));
    assert.deepEqual(trace.unverified, []);
    assert.equal(existsSync(path.join(project, 'demo', 'cli.mjs')), true);
    assert.match(readFileSync(path.join(project, 'demo', 'cli.mjs'), 'utf8'), /M7 todo-cli/);
    assert.ok((chat.execJobs ?? []).filter(job => job.purpose === 'test').length >= 4);
    assert.ok((chat.execJobs ?? []).filter(job => job.purpose === 'test').every(job => job.backend === 'docker' && job.state === 'finished' && job.receiptRef));
    assert.ok(chat.pipeline?.gateDecisions.some(item => item.gateId === 'B' && item.decision === 'confirm' && item.automatic));
    assert.equal(chat.pipeline?.stage, 'completed');
  } finally {
    if (ownedVolume) {
      const label = execFileSync('docker', ['volume', 'inspect', '--format', '{{ index .Labels "com.dual-model-workbench.fixture" }}', volume], { encoding: 'utf8' }).trim();
      assert.equal(label, fixtureLabel, 'refusing to remove a volume not owned by this exact fixture');
      execFileSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
    }
    rmSync(base, { recursive: true, force: true });
  }
});
