import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runProcess } from '../src/adapters/process.js';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { SandboxRunner, type CommandSpec, type RunnerResult, type SandboxCapability } from '../src/chat/runner.js';
import { ChatRuntime } from '../src/chat/runtime.js';
import { ChatStore } from '../src/chat/store.js';
import type { ChatDriver, ChatRole, DriverInput, DriverResult } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';

const roles: ChatRole[] = ['claude', 'astra', 'sol', 'grok'];
const result = (text = '完成'): DriverResult => ({ text, exitConfirmed: true });

interface TestingTicket {
  invocationId: string;
  spec: CommandSpec;
  allowedRoot: string;
}

/**
 * TESTING ONLY: exercises the gateway lifecycle with a real local process.
 * This deliberately bypasses product sandbox capability proof and must never
 * be exported or wired into application bootstrap.
 */
class TestingOnlyLocalRunner extends SandboxRunner {
  private readonly testingTickets = new Map<string, TestingTicket>();
  readonly executedCwds: string[] = [];

  constructor(private readonly beforeRun: (invocationId: string) => void) {
    const capability: SandboxCapability = {
      version: 1,
      verified: false,
      verifiedAt: new Date(0).toISOString(),
      platform: process.platform === 'win32' ? 'windows' : 'linux',
      wrapper: '', wrapperSha256: '', wrapperArgs: [], wrapperDependencies: [],
      policyFile: '', policySha256: '',
      networkDenied: true, childEscapeDenied: true, credentialReadDenied: true,
      allowedExecutables: [], allowedEnv: [],
    };
    super(capability, 2);
  }

  override issueTicket(invocationId: string, spec: CommandSpec, allowedRoot: string): string {
    assert.equal(spec.executable, process.execPath, 'test runner only permits the current Node executable');
    assert.equal(spec.network, 'none');
    const root = path.resolve(allowedRoot);
    const cwd = path.resolve(spec.cwd);
    const relative = path.relative(root, cwd);
    assert.ok(relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)));
    const ticketId = `testing-runner-${randomUUID()}`;
    this.testingTickets.set(ticketId, { invocationId, spec: { ...spec, args: [...spec.args] }, allowedRoot: root });
    return ticketId;
  }

  override async run(ticketId: string, invocationId: string, signal?: AbortSignal): Promise<RunnerResult> {
    const ticket = this.testingTickets.get(ticketId);
    assert.ok(ticket, 'testing ticket must exist');
    assert.equal(ticket.invocationId, invocationId, 'testing ticket is invocation-bound');
    this.testingTickets.delete(ticketId);
    this.beforeRun(invocationId);
    this.executedCwds.push(ticket.spec.cwd);
    const started = Date.now();
    const processResult = await runProcess(
      { file: ticket.spec.executable, prefixArgs: [], via: 'direct' },
      ticket.spec.args,
      {
        cwd: ticket.spec.cwd,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ...ticket.spec.env },
        stdinText: null,
        timeoutMs: ticket.spec.timeoutMs,
        signal,
      },
    );
    assert.ok(Date.now() >= started);
    return { ...processResult, ticketId, command: [ticket.spec.executable, ...ticket.spec.args], removedEnv: [] };
  }
}

function fixture(t: TestContext) {
  const workRoot = path.join(process.cwd(), 'work');
  mkdirSync(workRoot, { recursive: true });
  const root = mkdtempSync(path.join(workRoot, 'chat-development-'));
  t.after(() => {
    if (path.dirname(root) !== workRoot || !path.basename(root).startsWith('chat-development-')) throw new Error(`unsafe cleanup ${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'src', 'base.js'), 'export const base = true;\n');
  const testScript = path.join(root, 'real-test.cjs');
  writeFileSync(testScript, [
    "const fs = require('node:fs');",
    "const source = fs.readFileSync('src/feature.js', 'utf8');",
    "if (!source.includes('value = 2')) { process.stderr.write('WRONG_SOURCE'); process.exit(7); }",
    "fs.writeFileSync('test-artifact.txt', 'test-copy-only');",
    "process.stdout.write('DEV_TEST_OK');",
  ].join('\n'));
  const registry = new WorkspaceRegistry(path.join(root, 'managed'));
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  return { root, project, testScript, registry, grant };
}

test('workspace gateway is a no-op after ordinary chats without workspace state', async (t) => {
  const f = fixture(t);
  const gateway = new WorkspaceGateway(f.registry);
  const drivers = Object.fromEntries(roles.map((role) => [role, {
    capability: { role, available: true, isolationVerified: true },
    invoke: async (input: DriverInput) => { await input.callTool('task_complete', { result: 'ordinary complete' }); return result(); },
  } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  const runtime = new ChatRuntime({ store: new ChatStore(path.join(f.root, 'ordinary-store')), drivers, workspace: gateway, handoffMs: 10 });
  const chat = runtime.create({});
  runtime.send(chat.id, { text: 'ordinary chat', clientMessageId: 'ordinary-1' });
  await runtime.idle();
  assert.equal(chat.tasks[0]?.status, 'completed');
  assert.equal(chat.tasks[0]?.result, 'ordinary complete');
});

test('development flow crosses Grok edit/test, Sol integration, Astra frozen verification, and root completion', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  let runtime!: ChatRuntime;
  let chatId = '';
  const runner = new TestingOnlyLocalRunner((invocationId) => {
    const chat = runtime.get(chatId);
    const invocation = chat.invocations.find((candidate) => candidate.id === invocationId);
    assert.equal(invocation?.status, 'exited', 'runner starts only after the model process is recorded exited');
    assert.equal(invocation?.exitConfirmed, true);
  });
  const gateway = new WorkspaceGateway(f.registry, runner);
  const segments = new Map<string, number>();

  const invoke = async (role: ChatRole, input: DriverInput): Promise<DriverResult> => {
    const segment = (segments.get(input.task.id) ?? 0) + 1;
    segments.set(input.task.id, segment);
    const chat = runtime.get(input.chatId);

    if (role === 'grok') {
      if (segment === 1) {
        const created = await input.callTool('file_write', { path: 'src/feature.js', text: 'export const value = 2;\n', expectedHash: null });
        assert.equal((created.data as { created: boolean }).created, true);
        const copied = await input.callTool('file_read', { path: 'src/feature.js' });
        assert.match((copied.data as { text: string }).text, /value = 2/);
        assert.equal(existsSync(path.join(f.project, 'src', 'feature.js')), false, 'Grok write must stay in its edit copy');
        const submitted = await input.callTool('test_submit', { executable: process.execPath, args: [f.testScript] });
        assert.equal(submitted.stop, 'wait');
        return result('waiting for real test');
      }
      assert.match(input.systemPrompt, /DEV_TEST_OK/);
      await input.callTool('task_complete', { result: 'Grok edit and real test complete' });
      return result();
    }

    if (role === 'sol') {
      const grok = chat.tasks.find((task) => task.role === 'grok')!;
      const integrated = await input.callTool('integrate_edit', { taskId: grok.id, allowedFiles: ['src/feature.js'] });
      assert.deepEqual((integrated.data as { created: string[] }).created, ['src/feature.js']);
      assert.match(readFileSync(path.join(f.project, 'src', 'feature.js'), 'utf8'), /value = 2/);
      assert.equal(existsSync(path.join(f.project, 'test-artifact.txt')), false, 'test copy changes must not enter source integration');
      await input.callTool('task_complete', { result: 'Sol integrated tested edit' });
      return result();
    }

    if (role === 'astra') {
      if (segment === 1) {
        const read = await input.callTool('file_read', { path: 'src/feature.js' });
        assert.match((read.data as { text: string }).text, /value = 2/);
        const submitted = await input.callTool('test_submit', { executable: process.execPath, args: [f.testScript] });
        assert.equal(submitted.stop, 'wait');
        return result('waiting for Astra verification');
      }
      assert.match(input.systemPrompt, /DEV_TEST_OK/);
      await input.callTool('task_complete', { result: 'Astra independently verified frozen source' });
      return result();
    }

    const children = chat.tasks.filter((task) => task.parentTaskId === input.task.id);
    if (segment === 1) {
      await input.callTool('grok_submit', { tasks: [{ goal: 'implement feature and run its real test', mode: 'edit' }] });
      await input.callTool('grok_collect', { wait: true });
      return result();
    }
    if (segment === 2) {
      const grok = children.find((task) => task.role === 'grok')!;
      assert.equal(grok.status, 'completed');
      await input.callTool('grok_disposition', { taskId: grok.id, disposition: 'adopted' });
      await input.callTool('agent_submit', { role: 'sol', goal: 'integrate the tested Grok edit', mode: 'edit' });
      await input.callTool('grok_collect', { wait: true });
      return result();
    }
    if (segment === 3) {
      const sol = children.find((task) => task.role === 'sol')!;
      assert.equal(sol.status, 'completed');
      await input.callTool('grok_disposition', { taskId: sol.id, disposition: 'adopted' });
      assert.match(gateway.completionIssues(chat, input.task).join('\n'), /尚无 Astra/);
      await input.callTool('agent_submit', { role: 'astra', goal: 'verify the integrated source independently', mode: 'verify' });
      await input.callTool('grok_collect', { wait: true });
      return result();
    }
    const astra = children.find((task) => task.role === 'astra')!;
    assert.equal(astra.status, 'completed');
    await input.callTool('grok_disposition', { taskId: astra.id, disposition: 'reference' });
    assert.deepEqual(gateway.completionIssues(chat, input.task), []);
    await input.callTool('task_complete', { result: 'Root accepted implementation, integration, and independent verification' });
    return result();
  };

  const drivers = Object.fromEntries(roles.map((role) => [role, {
    capability: { role, available: true, isolationVerified: true },
    invoke: (input: DriverInput) => invoke(role, input),
  } satisfies ChatDriver])) as Record<ChatRole, ChatDriver>;
  runtime = new ChatRuntime({ store: new ChatStore(path.join(f.root, 'chat-store')), drivers, workspace: gateway, handoffMs: 10 });
  const chat = runtime.create({ workspaceId: f.grant.id });
  chatId = chat.id;
  runtime.send(chat.id, { text: 'develop and verify the feature', clientMessageId: 'development-1' });
  await runtime.idle(18_000);

  assert.equal(chat.tasks[0]?.status, 'completed');
  assert.equal(chat.tasks[0]?.result, 'Root accepted implementation, integration, and independent verification');
  assert.deepEqual(chat.tasks.map((task) => [task.role, task.status]), [
    ['claude', 'completed'], ['grok', 'completed'], ['sol', 'completed'], ['astra', 'completed'],
  ]);
  assert.equal(runner.executedCwds.length, 2);
  assert.ok(runner.executedCwds.every((cwd) => path.resolve(cwd) !== path.resolve(f.project)));
  assert.ok(runner.executedCwds.every((cwd) => existsSync(path.join(cwd, 'test-artifact.txt'))));
  assert.equal(existsSync(path.join(f.project, 'test-artifact.txt')), false);
  assert.match(readFileSync(path.join(f.project, 'src', 'feature.js'), 'utf8'), /value = 2/);
  writeFileSync(path.join(f.project, 'src', 'feature.js'), 'export const value = 99;\n');
  assert.match(gateway.completionIssues(chat, chat.tasks[0]!).join('\n'), /哈希已漂移.*src[\\/]feature\.js/);
});
