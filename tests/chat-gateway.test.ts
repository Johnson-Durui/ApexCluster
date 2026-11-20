import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { WorkspaceGateway, type WorkspaceToolIdentity } from '../src/chat/gateway.js';
import { SandboxRunner, type CommandSpec, type RunnerResult, type SandboxCapability } from '../src/chat/runner.js';
import type { AgentTask, ChatRecord, Invocation } from '../src/chat/types.js';
import { WorkspaceRegistry } from '../src/chat/workspace.js';

const hashFile = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const now = () => new Date().toISOString();

function fixture(t: TestContext) {
  const workRoot = path.join(process.cwd(), 'work');
  const root = mkdtempSync(path.join(workRoot, 'chat-gateway-'));
  t.after(() => {
    if (path.dirname(root) !== workRoot || !path.basename(root).startsWith('chat-gateway-')) throw new Error(`unsafe cleanup ${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project'); mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'src', 'value.ts'), 'export const value = 1;\n');
  const registry = new WorkspaceRegistry(path.join(root, 'managed'));
  const request = registry.issueNativeSelectionRequest(); const grant = registry.grantFromNativeSelection(project, request);

  const policy = path.join(root, 'policy.json'); writeFileSync(policy, '{"network":"none"}\n');
  const wrapper = path.join(root, 'wrapper.cjs');
  writeFileSync(wrapper, [
    "const {spawnSync}=require('node:child_process');",
    "const i=process.argv.indexOf('--');if(i<0)process.exit(90);",
    "const r=spawnSync(process.argv[i+1],process.argv.slice(i+2),{cwd:process.cwd(),env:process.env,encoding:'utf8'});",
    "process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??91);",
  ].join(''));
  const target = path.join(root, 'test-command.cjs');
  writeFileSync(target, "require('node:fs').writeFileSync('test-output.txt','test only');process.stdout.write('TEST_OK');\n");
  const capability: SandboxCapability = {
    version: 1, verified: true, verifiedAt: now(), platform: process.platform === 'win32' ? 'windows' : 'linux',
    wrapper: process.execPath, wrapperSha256: hashFile(process.execPath), wrapperArgs: [wrapper],
    wrapperDependencies: [{ path: wrapper, sha256: hashFile(wrapper) }], policyFile: policy, policySha256: hashFile(policy),
    networkDenied: true, childEscapeDenied: true, credentialReadDenied: true,
    allowedExecutables: [{ path: process.execPath, sha256: hashFile(process.execPath) }], allowedEnv: [],
  };
  const runner = new SandboxRunner(capability);
  const gateway = new WorkspaceGateway(registry, runner);
  const chat: ChatRecord = {
    version: 1, id: `chat-${randomUUID()}`, title: 'test', createdAt: now(), updatedAt: now(), workspaceId: grant.id,
    seq: 0, messageSeq: 0, turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [],
  };
  return { root, project, registry, grant, gateway, runner, target, chat };
}

function task(chat: ChatRecord, role: AgentTask['role'], mode: AgentTask['mode'], workspaceId: string, workspaceVersion: number, parentTaskId?: string) {
  const invocation: Invocation = {
    id: `inv-${randomUUID()}`, taskId: '', segment: 1, status: 'running', startedAt: now(), toolCount: 0,
    promptVersion: 'test', inputEstimate: 1, contextWindow: null, contextUsed: null,
  };
  const value: AgentTask = {
    id: `task-${randomUUID()}`, turnId: 'turn-1', ...(parentTaskId ? { parentTaskId } : {}), role, goal: 'test', status: 'running',
    createdAt: now(), updatedAt: now(), segment: 1, invocationIds: [invocation.id], noProgressSegments: 0,
    workspaceId, workspaceVersion, mode,
  };
  invocation.taskId = value.id; chat.tasks.push(value); chat.invocations.push(invocation);
  return { task: value, invocation };
}

function identity(chat: ChatRecord, pair: ReturnType<typeof task>): WorkspaceToolIdentity {
  return { chat, ...pair, signal: new AbortController().signal };
}

async function finishInvocation(gateway: WorkspaceGateway, who: WorkspaceToolIdentity, confirmed: boolean) {
  who.invocation.status = confirmed ? 'exited' : 'exit_unknown'; who.invocation.exitConfirmed = confirmed; who.invocation.endedAt = now();
  return gateway.afterInvocation(who, confirmed);
}

function complete(pair: ReturnType<typeof task>) { pair.task.status = 'completed'; }

async function grokEditWithTest(f: ReturnType<typeof fixture>) {
  const grok = task(f.chat, 'grok', 'edit', f.grant.id, f.grant.version);
  const who = identity(f.chat, grok);
  const read = await f.gateway.call('file_read', { path: 'src/value.ts' }, who);
  const current = read.data as { hash: string };
  await f.gateway.call('file_write', { path: 'src/value.ts', text: 'export const value = 2;\n', expectedHash: current.hash }, who);
  const submitted = await f.gateway.call('test_submit', { executable: process.execPath, args: [f.target] }, who) as typeof read & { ticketId: string };
  return { grok, who, submitted };
}

test('result read baseline advances only when an authorized source change is recorded', async t => {
  const f = fixture(t); const sol = task(f.chat, 'sol', 'edit', f.grant.id, f.grant.version); const who = identity(f.chat, sol);
  assert.deepEqual(f.gateway.resultReadBaseline(f.chat, sol.task), { authority: `workspace:${f.grant.id}:grant:${f.grant.version}:source:0`, sourceRevision: 0 });
  const read = await f.gateway.call('file_read', { path: 'src/value.ts' }, who); const current = read.data as { hash: string };
  assert.deepEqual(f.gateway.resultReadBaseline(f.chat, sol.task), { authority: `workspace:${f.grant.id}:grant:${f.grant.version}:source:0`, sourceRevision: 0 });
  await f.gateway.call('file_write', { path: 'src/value.ts', text: 'export const value = 2;\n', expectedHash: current.hash }, who);
  assert.deepEqual(f.gateway.resultReadBaseline(f.chat, sol.task), { authority: `workspace:${f.grant.id}:grant:${f.grant.version}:source:1`, sourceRevision: 1 });
  const restored = structuredClone(f.chat); const restoredSol = restored.tasks.find(item => item.id === sol.task.id)!;
  const rebuilt = new WorkspaceGateway(f.registry, f.runner);
  assert.deepEqual(rebuilt.resultReadBaseline(restored, restoredSol), { authority: `workspace:${f.grant.id}:grant:${f.grant.version}:source:1`, sourceRevision: 1 });
  const nextSol = task(restored, 'sol', 'edit', f.grant.id, f.grant.version); const nextWho = identity(restored, nextSol);
  const reread = await rebuilt.call('file_read', { path: 'src/value.ts' }, nextWho); const changed = reread.data as { hash: string };
  await rebuilt.call('file_write', { path: 'src/value.ts', text: 'export const value = 3;\n', expectedHash: changed.hash }, nextWho);
  assert.deepEqual(rebuilt.resultReadBaseline(restored, nextSol.task), { authority: `workspace:${f.grant.id}:grant:${f.grant.version}:source:2`, sourceRevision: 2 });
  assert.equal(sol.task.workspaceVersion, f.grant.version);
});

test('Grok 只写独立副本；test_submit 登记后阻断工具，退出确认后才运行测试副本', async (t) => {
  const f = fixture(t); const { who, submitted } = await grokEditWithTest(f);
  assert.equal(readFileSync(path.join(f.project, 'src', 'value.ts'), 'utf8'), 'export const value = 1;\n');
  assert.equal(existsSync(path.join(f.project, 'test-output.txt')), false);
  await assert.rejects(() => f.gateway.call('file_list', {}, who), /不能继续使用工具/);
  const replies = await finishInvocation(f.gateway, who, true);
  assert.equal(replies[0]!.ticketId, submitted.ticketId);
  assert.equal((replies[0]!.reply.data as { ok: boolean }).ok, true);
  const result = (replies[0]!.reply.data as { result: { stdoutTail: string } }).result;
  assert.equal(result.stdoutTail, 'TEST_OK');
  assert.equal(existsSync(path.join(f.project, 'test-output.txt')), false);
  const artifacts = await f.gateway.takeArtifacts(who);
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0]!.text, /modified: src\/value\.ts/);
  assert.doesNotMatch(artifacts[0]!.text, /test-output\.txt/);
  assert.match(artifacts[0]!.binding.beforeSnapshotId, /^wsnap-/);
  assert.match(artifacts[0]!.binding.afterSnapshotId, /^wsnap-/);
  assert.deepEqual(await f.gateway.takeArtifacts(who), []);
});

test('退出状态未知时不启动 runner，也不能集成编辑结果', async (t) => {
  const f = fixture(t); const { grok, who } = await grokEditWithTest(f);
  const replies = await finishInvocation(f.gateway, who, false);
  assert.equal((replies[0]!.reply.data as { ok: boolean }).ok, false);
  assert.deepEqual(await f.gateway.takeArtifacts(who), []);
  const sol = task(f.chat, 'sol', 'edit', f.grant.id, f.grant.version, grok.task.id);
  await assert.rejects(() => f.gateway.call('integrate_edit', { taskId: grok.task.id, allowedFiles: ['src/value.ts'] }, identity(f.chat, sol)), /尚未完成|未确认退出/);
  assert.equal(readFileSync(path.join(f.project, 'src', 'value.ts'), 'utf8'), 'export const value = 1;\n');
});

test('任务取消后即使模型已退出，也不会启动测试 runner', async (t) => {
  const f = fixture(t); const { grok, who } = await grokEditWithTest(f);
  const controller = new AbortController(); controller.abort(); grok.task.status = 'cancelled';
  who.signal = controller.signal; who.invocation.status = 'exited'; who.invocation.exitConfirmed = true;
  const replies = await f.gateway.afterInvocation(who, true);
  const data = replies[0]!.reply.data as { ok: boolean; error: string };
  assert.equal(data.ok, false); assert.match(data.error, /已取消/);
  assert.deepEqual(await f.gateway.takeArtifacts(who), []);
});

test('真实新增文件生成一次 workspace diff，无变化调用段不重复产物', async (t) => {
  const f = fixture(t);
  const grok = task(f.chat, 'grok', 'edit', f.grant.id, f.grant.version);
  const who = identity(f.chat, grok);
  await f.gateway.call('file_write', { path: 'src/new.ts', text: 'export const added = true;\n', expectedHash: null }, who);
  await finishInvocation(f.gateway, who, true);
  const artifacts = await f.gateway.takeArtifacts(who);
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0]!.text, /added: src\/new\.ts/);
  assert.match(artifacts[0]!.text, /\+export const added = true;/);

  const nextInvocation: Invocation = { ...grok.invocation, id: `inv-${randomUUID()}`, segment: 2, status: 'running', startedAt: now() };
  grok.task.invocationIds.push(nextInvocation.id); f.chat.invocations.push(nextInvocation);
  const next = identity(f.chat, { task: grok.task, invocation: nextInvocation });
  await f.gateway.call('file_read', { path: 'src/new.ts' }, next);
  await finishInvocation(f.gateway, next, true);
  assert.deepEqual(await f.gateway.takeArtifacts(next), []);
});

test('授权撤销后不冻结或生成新的 workspace diff', async (t) => {
  const f = fixture(t);
  const grok = task(f.chat, 'grok', 'edit', f.grant.id, f.grant.version);
  const who = identity(f.chat, grok);
  await f.gateway.call('file_write', { path: 'src/new.ts', text: 'new\n', expectedHash: null }, who);
  f.registry.revoke(f.grant.id);
  who.invocation.status = 'exited'; who.invocation.exitConfirmed = true;
  await assert.rejects(() => f.gateway.afterInvocation(who, true), /已撤销/);
  await assert.rejects(() => f.gateway.takeArtifacts(who), /已撤销/);
});

test('runner 进程树退出状态未知时 receipt 明确 fail closed', async (t) => {
  const f = fixture(t);
  class UnknownExitRunner extends SandboxRunner {
    override async run(ticketId: string, invocationId: string, signal?: AbortSignal): Promise<RunnerResult> {
      const actual = await super.run(ticketId, invocationId, signal);
      return { ...actual, terminationWarning: 'testing-only unknown descendant process' };
    }
  }
  const gateway = new WorkspaceGateway(f.registry, new UnknownExitRunner(f.runner.capability));
  const unsafeFixture = { ...f, gateway };
  const { who } = await grokEditWithTest(unsafeFixture);
  const receipts = await finishInvocation(gateway, who, true);
  const reply = receipts[0]!.reply as { processExitConfirmed: boolean; data?: unknown };
  assert.equal(reply.processExitConfirmed, false);
  assert.equal((reply.data as { ok: boolean }).ok, false);
});

test('runner progress fingerprint 忽略随机测试快照，源码或结果分类变化时更新', async (t) => {
  const f = fixture(t);
  const { grok, who } = await grokEditWithTest(f);
  const firstReceipts = await finishInvocation(f.gateway, who, true);
  const first = firstReceipts[0]!.reply.data as {
    progressFingerprint: string; testSnapshotId: string; sourceSnapshotId: string; sourceFingerprint: string;
  };

  const nextIdentity = (segment: number) => {
    const invocation: Invocation = {
      ...grok.invocation,
      id: `inv-${randomUUID()}`,
      segment,
      status: 'running',
      startedAt: now(),
      toolCount: 0,
      exitConfirmed: undefined,
      endedAt: undefined,
    };
    grok.task.invocationIds.push(invocation.id); f.chat.invocations.push(invocation);
    return identity(f.chat, { task: grok.task, invocation });
  };

  const secondWho = nextIdentity(2);
  await f.gateway.call('test_submit', { executable: process.execPath, args: [f.target] }, secondWho);
  const second = (await finishInvocation(f.gateway, secondWho, true))[0]!.reply.data as typeof first;
  assert.notEqual(second.testSnapshotId, first.testSnapshotId);
  assert.equal(second.sourceSnapshotId, first.sourceSnapshotId);
  assert.equal(second.sourceFingerprint, first.sourceFingerprint);
  assert.equal(second.progressFingerprint, first.progressFingerprint);

  writeFileSync(f.target, "process.stderr.write('SAME_COMMAND_NOW_FAILS');process.exit(7);\n");
  const failedWho = nextIdentity(3);
  await f.gateway.call('test_submit', { executable: process.execPath, args: [f.target] }, failedWho);
  const failed = (await finishInvocation(f.gateway, failedWho, true))[0]!.reply.data as typeof first;
  assert.notEqual(failed.progressFingerprint, first.progressFingerprint);

  writeFileSync(f.target, "process.stdout.write('TEST_OK');\n");
  const changedWho = nextIdentity(4);
  const current = await f.gateway.call('file_read', { path: 'src/value.ts' }, changedWho);
  await f.gateway.call('file_write', {
    path: 'src/value.ts', text: 'export const value = 3;\n', expectedHash: (current.data as { hash: string }).hash,
  }, changedWho);
  await f.gateway.call('test_submit', { executable: process.execPath, args: [f.target] }, changedWho);
  const changed = (await finishInvocation(f.gateway, changedWho, true))[0]!.reply.data as typeof first;
  assert.notEqual(changed.sourceFingerprint, first.sourceFingerprint);
  assert.notEqual(changed.progressFingerprint, first.progressFingerprint);
});

test('真实测试通过后 Sol 集成冻结 Grok 编辑，测试污染不进入源码', async (t) => {
  const f = fixture(t); const { grok, who } = await grokEditWithTest(f);
  await finishInvocation(f.gateway, who, true); complete(grok);
  const sol = task(f.chat, 'sol', 'edit', f.grant.id, f.grant.version, grok.task.id);
  const solIdentity = identity(f.chat, sol);
  const reply = await f.gateway.call('integrate_edit', { taskId: grok.task.id, allowedFiles: ['src/value.ts'] }, solIdentity);
  assert.deepEqual((reply.data as { changed: string[] }).changed, ['src/value.ts']);
  assert.equal(readFileSync(path.join(f.project, 'src', 'value.ts'), 'utf8'), 'export const value = 2;\n');
  assert.equal(existsSync(path.join(f.project, 'test-output.txt')), false);
  await finishInvocation(f.gateway, solIdentity, true);
  const integrationArtifacts = await f.gateway.takeArtifacts(solIdentity);
  assert.equal(integrationArtifacts.length, 1);
  assert.match(integrationArtifacts[0]!.text, /modified: src\/value\.ts/);
  assert.doesNotMatch(integrationArtifacts[0]!.text, /test-output\.txt/);
  await assert.rejects(() => f.gateway.call('integrate_edit', { taskId: grok.task.id, allowedFiles: ['src/value.ts'] }, solIdentity), /已经集成/);
});

test('后续调用段的新修改会废止旧冻结快照和测试证据', async (t) => {
  const f = fixture(t); const { grok, who } = await grokEditWithTest(f);
  await finishInvocation(f.gateway, who, true);
  const nextInvocation: Invocation = { ...grok.invocation, id: `inv-${randomUUID()}`, segment: 2, status: 'running', startedAt: now() };
  grok.task.invocationIds.push(nextInvocation.id); f.chat.invocations.push(nextInvocation);
  const next = identity(f.chat, { task: grok.task, invocation: nextInvocation });
  const current = await f.gateway.call('file_read', { path: 'src/value.ts' }, next);
  await f.gateway.call('file_write', { path: 'src/value.ts', text: 'export const value = 5;\n', expectedHash: (current.data as { hash: string }).hash }, next);
  const sol = task(f.chat, 'sol', 'edit', f.grant.id, f.grant.version, grok.task.id);
  await assert.rejects(() => f.gateway.call('integrate_edit', { taskId: grok.task.id, allowedFiles: ['src/value.ts'] }, identity(f.chat, sol)), /尚未完成|未确认退出|测试证据/);
});

test('用户同期修改阻断 Sol 集成，不覆盖用户文件', async (t) => {
  const f = fixture(t); const { grok, who } = await grokEditWithTest(f);
  await finishInvocation(f.gateway, who, true); complete(grok);
  writeFileSync(path.join(f.project, 'src', 'value.ts'), 'user edit\n');
  const sol = task(f.chat, 'sol', 'edit', f.grant.id, f.grant.version, grok.task.id);
  await assert.rejects(() => f.gateway.call('integrate_edit', { taskId: grok.task.id, allowedFiles: ['src/value.ts'] }, identity(f.chat, sol)), /原工作区/);
  assert.equal(readFileSync(path.join(f.project, 'src', 'value.ts'), 'utf8'), 'user edit\n');
});

test('真实测试失败会原样返回退出码，并阻断 Sol 集成', async (t) => {
  const f = fixture(t);
  const grok = task(f.chat, 'grok', 'edit', f.grant.id, f.grant.version); const who = identity(f.chat, grok);
  const read = await f.gateway.call('file_read', { path: 'src/value.ts' }, who);
  await f.gateway.call('file_write', { path: 'src/value.ts', text: 'export const value = 7;\n', expectedHash: (read.data as { hash: string }).hash }, who);
  await f.gateway.call('test_submit', { executable: process.execPath, args: ['-e', 'process.stderr.write("EXPECTED_FAIL");process.exit(7)'] }, who);
  const receipts = await finishInvocation(f.gateway, who, true); complete(grok);
  const data = receipts[0]!.reply.data as { ok: boolean; result: { exitCode: number; stderrTail: string } };
  assert.equal(data.ok, false); assert.equal(data.result.exitCode, 7); assert.equal(data.result.stderrTail, 'EXPECTED_FAIL');
  const sol = task(f.chat, 'sol', 'edit', f.grant.id, f.grant.version, grok.task.id);
  await assert.rejects(() => f.gateway.call('integrate_edit', { taskId: grok.task.id, allowedFiles: ['src/value.ts'] }, identity(f.chat, sol)), /测试证据/);
});

test('Astra 读取冻结快照且不能写；授权撤销后所有工具失效', async (t) => {
  const f = fixture(t); writeFileSync(path.join(f.project, 'long.txt'), 'x'.repeat(9_000));
  const astra = task(f.chat, 'astra', 'verify', f.grant.id, f.grant.version); const who = identity(f.chat, astra);
  const pages = [];
  for (const offset of [0, 4_000, 8_000]) pages.push((await f.gateway.call('file_read', { path: 'long.txt', offset }, who)).data as { text: string; next: number | null });
  assert.equal(pages.map((page) => page.text).join('').length, 9_000); assert.equal(pages[2]!.next, null);
  const first = await f.gateway.call('file_read', { path: 'src/value.ts' }, who);
  writeFileSync(path.join(f.project, 'src', 'value.ts'), 'later user edit\n');
  const second = await f.gateway.call('file_read', { path: 'src/value.ts' }, who);
  assert.equal((first.data as { text: string }).text, (second.data as { text: string }).text);
  await assert.rejects(() => f.gateway.call('file_write', { path: 'src/value.ts', text: 'bad', expectedHash: null }, who), /没有文件写入权限/);
  f.registry.revoke(f.grant.id);
  await assert.rejects(() => f.gateway.call('file_list', {}, who), /已撤销/);
});

test('Astra verify 的 Grok 子任务继承父冻结基线，外部漂移仍令根验收过期', async (t) => {
  const f = fixture(t);
  const root = task(f.chat, 'claude', 'read', f.grant.id, f.grant.version);
  const sol = task(f.chat, 'sol', 'edit', f.grant.id, f.grant.version, root.task.id);
  const solIdentity = identity(f.chat, sol);
  const original = await f.gateway.call('file_read', { path: 'src/value.ts' }, solIdentity);
  await f.gateway.call('file_write', {
    path: 'src/value.ts', text: 'export const value = 2;\n', expectedHash: (original.data as { hash: string }).hash,
  }, solIdentity);
  await finishInvocation(f.gateway, solIdentity, true);
  const solArtifacts = await f.gateway.takeArtifacts(solIdentity);
  assert.equal(solArtifacts.length, 1);
  assert.match(solArtifacts[0]!.text, /modified: src\/value\.ts/);

  const astra = task(f.chat, 'astra', 'verify', f.grant.id, f.grant.version, root.task.id);
  const astraIdentity = identity(f.chat, astra);
  const parentRead = await f.gateway.call('file_read', { path: 'src/value.ts' }, astraIdentity);
  assert.equal((parentRead.data as { text: string }).text, 'export const value = 2;\n');
  writeFileSync(path.join(f.project, 'src', 'value.ts'), 'external concurrent change\n');

  const child = task(f.chat, 'grok', 'verify', f.grant.id, f.grant.version, astra.task.id);
  const childRead = await f.gateway.call('file_read', { path: 'src/value.ts' }, identity(f.chat, child));
  assert.equal((childRead.data as { text: string }).text, 'export const value = 2;\n');

  await finishInvocation(f.gateway, astraIdentity, true); complete(astra);
  assert.match(f.gateway.completionIssues(f.chat, root.task).join('\n'), /哈希已漂移.*src[\\/]value\.ts/);
});

test('test_submit 的平台选择传给 runner 并绑定回执；测试 cwd 仍属于宿主派生副本', async t => {
  const f = fixture(t); let requested: CommandSpec | undefined;
  const gateway = new WorkspaceGateway(f.registry, {
    capability: { platform: 'windows' },
    issueTicket(_id, spec) { requested = spec; return 'controlled-ticket'; },
    async run(ticketId): Promise<RunnerResult> {
      return { ticketId, command: [], removedEnv: [], exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'FAKE_ROUTING_ONLY', stderrTail: '', durationMs: 1, pid: null };
    },
    commandInfo: () => [{ platform: 'linux', executablePaths: ['/fixed/node'], network: 'none', writableScope: 'derived-test-copy' }],
  });
  const astra = task(f.chat, 'astra', 'verify', f.grant.id, f.grant.version); const who = identity(f.chat, astra);
  await assert.rejects(gateway.call('test_submit', { executable: '/fixed/node', args: [], platform: 'unknown' }, who));
  await gateway.call('test_submit', { executable: '/fixed/node', args: ['src/value.ts'], platform: 'linux' }, who);
  const data = (await finishInvocation(gateway, who, true))[0]!.reply.data as { platform: string; sourceSnapshotId: string; ok: boolean };
  assert.equal(requested!.platform, 'linux'); assert.equal(requested!.executable, '/fixed/node');
  assert.ok(path.isAbsolute(requested!.cwd)); assert.notEqual(requested!.cwd, f.project);
  assert.equal(data.platform, 'linux'); assert.equal(data.ok, true); assert.match(data.sourceSnapshotId, /^wsnap-/);
  assert.equal(gateway.commandInfo()[0]!.platform, 'linux');
});
