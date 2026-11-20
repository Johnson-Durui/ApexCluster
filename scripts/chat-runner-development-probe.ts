/** 无模型：合成角色身份，仅验证真实受控 runner 与冻结/测试/集成网关。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkspaceToolIdentity } from '../src/chat/gateway.js';
import type { RunnerCommandInfo } from '../src/chat/runner-contract.js';
import type { AgentTask, ChatRecord, Invocation, ToolReply } from '../src/chat/types.js';

const appRoot = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const { DEFAULT_CHAT_ROOT, loadChatRunners } = appRoot
  ? await import(pathToFileURL(path.join(appRoot, 'src/chat/bootstrap.js')).href) as typeof import('../src/chat/bootstrap.js')
  : await import('../src/chat/bootstrap.js');
const { WorkspaceGateway } = appRoot
  ? await import(pathToFileURL(path.join(appRoot, 'src/chat/gateway.js')).href) as typeof import('../src/chat/gateway.js')
  : await import('../src/chat/gateway.js');
const { WorkspaceRegistry } = appRoot
  ? await import(pathToFileURL(path.join(appRoot, 'src/chat/workspace.js')).href) as typeof import('../src/chat/workspace.js')
  : await import('../src/chat/workspace.js');

const dataRoot = path.resolve(process.argv[2] ?? DEFAULT_CHAT_ROOT);
const disk = statfsSync(dataRoot);
assert.ok(disk.bavail * disk.bsize >= 256 * 1024 * 1024, '测试盘可用空间不足');
const { runner, availability } = loadChatRunners(dataRoot);
assert.ok(runner, `未找到可用的已验证 runner：${JSON.stringify(availability)}`);
const commands = runner.commandInfo();
const root = path.join(dataRoot, 'work', `chat-runner-development-${Date.now()}-${randomUUID().slice(0, 8)}`);
mkdirSync(root, { recursive: true });
const report = { at: new Date().toISOString(), appRoot: appRoot ?? 'typescript-source', realModelCalls: 0, roleIdentity: 'synthetic-test-fixture-only', nativePickerTested: false, availability, checks: [] as { platform: string; passed: boolean; evidence?: unknown; failure?: string }[], passed: false };

async function verify(command: RunnerCommandInfo) {
  const caseRoot = path.join(root, command.platform); const project = path.join(caseRoot, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'value.txt'), '1\n');
  writeFileSync(path.join(project, 'check.cjs'), "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('value.txt','utf8'),'2\\n');fs.writeFileSync('test-pollution.txt','derived-copy-only');process.stdout.write('CONTROLLED_TEST_OK');\n");
  const registry = new WorkspaceRegistry(path.join(caseRoot, 'managed'));
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  const gateway = new WorkspaceGateway(registry, runner);
  const at = () => new Date().toISOString();
  const chat: ChatRecord = { version: 1, id: randomUUID(), title: '无模型受控 runner 贯通检查', workspaceId: grant.id, createdAt: at(), updatedAt: at(), seq: 0, messageSeq: 0, turns: [], tasks: [], invocations: [], tickets: [], artifacts: [], checkpoints: [], constraintMessageIds: [] };
  function identity(role: AgentTask['role'], mode: AgentTask['mode'], parentTaskId?: string): WorkspaceToolIdentity {
    const invocation: Invocation = { id: randomUUID(), taskId: '', segment: 1, status: 'running', startedAt: at(), toolCount: 0, promptVersion: 'no-model-runner-fixture', inputEstimate: 0, contextWindow: null, contextUsed: null };
    const task: AgentTask = { id: randomUUID(), turnId: 'runner-probe-turn', ...(parentTaskId ? { parentTaskId } : {}), role, mode, goal: '只验证受控测试及网关状态', status: 'running', createdAt: at(), updatedAt: at(), segment: 1, invocationIds: [invocation.id], noProgressSegments: 0, workspaceId: grant.id, workspaceVersion: grant.version };
    invocation.taskId = task.id; chat.tasks.push(task); chat.invocations.push(invocation);
    return { chat, task, invocation, signal: new AbortController().signal };
  }
  async function close(who: WorkspaceToolIdentity) {
    who.invocation.status = 'exited'; who.invocation.exitConfirmed = true; who.invocation.endedAt = at();
    return gateway.afterInvocation(who, true);
  }
  async function testCopy(who: WorkspaceToolIdentity) {
    await gateway.call('test_submit', { executable: command.executablePaths[0], platform: command.platform, args: ['check.cjs'], timeoutMs: 20_000 }, who);
    const receipts = await close(who); const result = receipts[0]!.reply.data as { ok: boolean; platform: string; sourceSnapshotId: string; testSnapshotId: string; result: { stdoutTail?: string }; };
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.platform, command.platform);
    assert.equal(result.result.stdoutTail, 'CONTROLLED_TEST_OK'); assert.notEqual(result.sourceSnapshotId, result.testSnapshotId);
    assert.equal(existsSync(path.join(project, 'test-pollution.txt')), false);
    who.task.status = 'completed'; return result;
  }
  const rootTask = identity('claude', 'read'); const sol = identity('sol', 'edit', rootTask.task.id); const grok = identity('grok', 'edit', sol.task.id);
  const current = await gateway.call('file_read', { path: 'value.txt' }, grok);
  await gateway.call('file_write', { path: 'value.txt', text: '2\n', expectedHash: (current.data as { hash: string }).hash }, grok);
  assert.equal(readFileSync(path.join(project, 'value.txt'), 'utf8'), '1\n');
  const grokReceipt = await testCopy(grok); const grokDiff = await gateway.takeArtifacts(grok);
  assert.equal(grokDiff.length, 1); assert.doesNotMatch(grokDiff[0]!.text, /test-pollution/);
  const integration: ToolReply = await gateway.call('integrate_edit', { taskId: grok.task.id, allowedFiles: ['value.txt'] }, sol);
  await close(sol); sol.task.status = 'completed';
  assert.equal(readFileSync(path.join(project, 'value.txt'), 'utf8'), '2\n');
  const astra = identity('astra', 'verify', rootTask.task.id); const astraReceipt = await testCopy(astra);
  assert.deepEqual(gateway.completionIssues(chat, rootTask.task), []);
  return { platform: command.platform, executable: command.executablePaths[0], grokReceipt, integration: integration.data, astraReceipt, programDiff: grokDiff, originalContainsNoTestPollution: true };
}

for (const command of commands) {
  try { report.checks.push({ platform: command.platform, passed: true, evidence: await verify(command) }); }
  catch (error) { report.checks.push({ platform: command.platform, passed: false, failure: error instanceof Error ? error.stack : String(error) }); }
}
report.passed = report.checks.length > 0 && report.checks.every(check => check.passed);
if (!report.passed) process.exitCode = 1;
const reportFile = path.join(root, 'verification.json'); writeFileSync(reportFile, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify({ reportFile, passed: report.passed, platforms: report.checks.map(({ platform, passed }) => ({ platform, passed })) })}\n`);
