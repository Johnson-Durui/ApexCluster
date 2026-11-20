import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { loadModelRegistry } from '../src/providers/registry.js';
import { ScriptedProvider } from '../src/providers/scripted.js';
import { pipelineScript } from '../tests/fixtures/pipeline/todo-cli/implementation-script.js';
import { requirement, scenario } from '../tests/fixtures/pipeline/todo-cli/script.js';

export interface OfflineDemoIo { out(line: string): void; error(line: string): void }
const defaultIo: OfflineDemoIo = { out: line => console.log(line), error: line => console.error(line) };
type DockerExec = typeof execFileSync;
interface OfflineDemoCompletion { chatId: string; stage: string; traceRef: string; dockerJobs: number; liveModelCalls: 0 }

/** Resolve a local tag or configured reference to the immutable local image ID. */
export function resolveOfflineImage(reference = process.env.DMW_DOCKER_SANDBOX_IMAGE?.trim() || 'dmw-sandbox:local'): string {
  try {
    return execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`找不到本地 Docker 沙箱镜像 ${reference}。请先构建 dmw-sandbox:local，或将 DMW_DOCKER_SANDBOX_IMAGE 设为本地已存在的镜像 ID。`);
  }
}

/** Remove only the exact labeled volume created by this demo invocation. */
export function removeOwnedDemoVolume(volume: string, label: string, exec: DockerExec = execFileSync): void {
  const actual = exec('docker', ['volume', 'inspect', '--format', '{{ index .Labels "com.dual-model-workbench.fixture" }}', volume], { encoding: 'utf8' }).trim();
  if (actual !== label) throw new Error('拒绝清理不属于本次夹具的 Docker 卷');
  exec('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
}

/** PASS is a post-cleanup receipt, not merely a pipeline completion receipt. */
export function reportOfflineDemoCompletion(completion: OfflineDemoCompletion | null, cleanupError: unknown, io: OfflineDemoIo): number {
  if (cleanupError) {
    io.error(`Docker 清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    return 4;
  }
  if (!completion) return 4;
  io.out(JSON.stringify({ type: 'completed', ...completion }));
  io.out('PASS');
  return 0;
}

export async function runOfflineDemo(io: OfflineDemoIo = defaultIo): Promise<number> {
  let image: string;
  try { image = resolveOfflineImage(); }
  catch (error) { io.error(error instanceof Error ? error.message : String(error)); return 5; }
  const base = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'dmw-demo-offline-'));
  const identity = randomUUID().replaceAll('-', '');
  const volume = `dmw-m8-offline-${identity}`;
  const label = `m8-offline-${identity}`;
  let ownedVolume = false;
  let completion: OfflineDemoCompletion | null = null;
  let cleanupError: unknown = null;
  try {
    const project = path.join(base, 'project');
    mkdirSync(project);
    writeFileSync(path.join(project, 'requirement.md'), requirement);
    execFileSync('docker', ['volume', 'create', '--label', 'com.dual-model-workbench.owner=exec-v1',
      '--label', `com.dual-model-workbench.fixture=${label}`, volume], { stdio: 'ignore' });
    ownedVolume = true;

    const registry = new WorkspaceRegistry(path.join(base, 'workspaces'));
    const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
    const workspace = new WorkspaceGateway(registry);
    const store = new ChatStore(path.join(base, 'store'));
    const models = loadModelRegistry();
    const roster = loadRoster('config/presets/roster.flagship.json', models);
    const docker = new DockerBackend({ image, packageCacheVolume: volume, user: '10001:10001' });
    const probe = await docker.probe();
    if (!probe.ok) throw new Error(`Docker 沙箱不可用：${probe.reason}`);

    let chat!: ChatRecord;
    const scripted = pipelineScript(() => chat);
    const api = createApiChatBinding(roster, models, null, { offline: true,
      providerFor: model => new ScriptedProvider(scripted, model.protocol) });
    const runtime = createProductionChatRuntime({ store, drivers: {}, api, workspace, pipelineWorkspace: workspace,
      projectOutputs: new ProjectOutputStore(registry), executor: new ExecTools(docker, path.join(base, 'exec')),
      pipelineRosters: new Map([[scenario.preset, roster]]), handoffMs: 5 });
    chat = runtime.create({ workspaceId: grant.id, pipeline: { preset: scenario.preset, auto: true } });
    const unsubscribe = runtime.subscribe(chat.id, event => io.out(JSON.stringify({ type: 'event', seq: event.seq, event: event.type,
      taskId: event.taskId, invocationId: event.invocationId })));
    try {
      io.out(JSON.stringify({ type: 'started', chatId: chat.id, image, workspace: project, scriptedModels: true, docker: 'real' }));
      runtime.send(chat.id, { text: requirement, clientMessageId: `demo-offline-${identity}` });
      await runtime.idle(60_000);
    } finally { unsubscribe(); }
    assert.equal(chat.pipeline?.stage, 'completed', JSON.stringify(chat.tasks.map(task => ({ role: task.role, status: task.status, error: task.error }))));
    assert.ok(chat.pipeline.implementation?.trace);
    const jobs = chat.execJobs ?? [];
    assert.ok(jobs.some(job => job.backend === 'docker' && job.purpose === 'test' && job.receiptRef));
    completion = { chatId: chat.id, stage: chat.pipeline.stage,
      traceRef: chat.pipeline.implementation.trace.ref, dockerJobs: jobs.length, liveModelCalls: 0 };
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (ownedVolume) {
      try { removeOwnedDemoVolume(volume, label); }
      catch (error) { cleanupError = error; }
    }
    try { rmSync(base, { recursive: true, force: true }); }
    catch (error) { cleanupError ??= error; }
  }
  return reportOfflineDemoCompletion(completion, cleanupError, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runOfflineDemo();
}
