import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { defaultConfig } from '../src/config.js';
import { ChatDriverError, CodexAppServer, commandFingerprint, consumeClaudeLine, createChatDrivers, cursorNativeToolExclusionBinding, respondCodexRequest, runClaudeHostTools, runCodexHostTools, runCursorHostTools, validateVersionResult, type ClaudeStream } from '../src/chat/drivers.js';
import { runProcess } from '../src/adapters/process.js';
import type { DriverInput } from '../src/chat/types.js';
import { ChatStore } from '../src/chat/store.js';
import { WorkspaceRegistry, WorkspacePathError } from '../src/chat/workspace.js';
import { z } from 'zod';
import { WorkspaceGateway } from '../src/chat/gateway.js';
import { SandboxRunner, type SandboxCapability } from '../src/chat/runner.js';
import type { ChatWindowsJobSupervisorAssets } from '../src/chat/windows-job-process.js';
import { CURSOR_GROK_PRESENTATION_ALIAS } from '../src/chat/cursor-model-state.js';
import { tempDir } from './helpers.js';
import { appendBoundedCodexObservation, installCodexToolCompletionObserver } from '../scripts/chat-codex-job-observer.js';
import { PlanCompletionError, PlanUpdateError, updatePlan } from '../src/chat/plans.js';
import { HttpError } from '../src/orchestrator/errors.js';
import type { AgentTask, ChatRecord } from '../src/chat/types.js';

function input(directory: string): DriverInput {
  return { chatId: 'chat-1', directory, systemPrompt: 'system', prompt: 'hello', signal: new AbortController().signal,
    task: { id: 'task', turnId: 'turn', role: 'astra', goal: 'goal', status: 'running', createdAt: '', updatedAt: '', segment: 1, invocationIds: [], noProgressSegments: 0, mode: 'read' },
    invocation: { id: 'inv-1', taskId: 'task', segment: 1, status: 'running', startedAt: '', toolCount: 0, promptVersion: 'v1', inputEstimate: 0, contextWindow: null, contextUsed: null },
    tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }], onText: () => {}, callTool: async () => ({ text: 'file' }) };
}
const testCodexTreeKiller = async (pid: number) => { try { process.kill(pid); return true; } catch { return false; } };
let cachedJobAssets: ChatWindowsJobSupervisorAssets | undefined;
function fakeJobAssets(): ChatWindowsJobSupervisorAssets {
  if (cachedJobAssets) return cachedJobAssets;
  let binaryPath = process.env.DMW_WINDOWS_JOB_SUPERVISOR ?? process.execPath;
  if (process.platform === 'win32' && !process.env.DMW_WINDOWS_JOB_SUPERVISOR) {
    binaryPath = path.join(tempDir('chat-driver-job-helper-'), 'supervisor.exe');
    const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const result = spawnSync(compiler, ['/nologo', '/optimize+', `/out:${binaryPath}`, fileURLToPath(new URL('../src/chat/windows-job-supervisor.cs', import.meta.url))], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.ok(existsSync(binaryPath));
  // Local fake-CLI fixture only; production reads its fixed compiled manifest.
  return cachedJobAssets = { binaryPath, binarySha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex'), protocol: 1,
    sourceCsSha256: '0'.repeat(64), wrapperSha256: '1'.repeat(64), compilerSha256: '2'.repeat(64), manifestSha256: '3'.repeat(64) };
}
function fakeCodex(tmp: string) {
  const config = defaultConfig(tmp);
  const fake = fileURLToPath(new URL('./fixtures/chat/fake-codex.mjs', import.meta.url));
  config.adapters.codex.command = { command: process.execPath, args: [fake] };
  const cmd = { file: process.execPath, prefixArgs: [fake], via: 'config' as const };
  const tests = Object.fromEntries(['cancellationConfirmed', 'toolSurfaceVerified', 'dynamicToolsSchemaVerified', 'namedPermissionProfileSchemaVerified', 'environmentAccessDisabledVerified', 'nativeSurfaceUnavailableVerified', 'extensionsDisabledVerified', 'normalExitTreeVerified', 'windowsJobTreeVerified'].map(k => [k, true]));
  const capabilitiesFile = path.join(tmp, 'caps.json');
  writeFileSync(capabilitiesFile, JSON.stringify({ roles: { astra: { version: 'fake-codex 1.0', fingerprint: commandFingerprint(cmd, 'astra', config.models.astra.model, config.models.astra.effort, null, fakeJobAssets()), policy: 'codex-two-stage-no-env-job-v4', verified: true, isolationVerified: true, tests } } }));
  return createChatDrivers(config, { capabilitiesFile, codexTreeKiller: testCodexTreeKiller, codexJobAssets: fakeJobAssets() }).astra;
}

test('unknown isolation evidence disables every real driver', () => {
  const drivers = createChatDrivers(defaultConfig());
  for (const driver of Object.values(drivers)) assert.equal(driver.capability.available, false);
});

test('version probe distinguishes unknown tree exit from confirmed failure', () => {
  const base = { exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'fake 1', stderrTail: '', durationMs: 1, pid: 123 };
  validateVersionResult(base, 'fake 1');
  assert.throws(() => validateVersionResult({ ...base, terminationWarning: 'tree unknown' }, 'fake 1'), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed === false && e.phase === 'post_dispatch');
  assert.throws(() => validateVersionResult({ ...base, spawnError: 'after start' }, 'fake 1'), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed === false && e.phase === 'post_dispatch');
  assert.throws(() => validateVersionResult({ ...base, pid: null, spawnError: 'no executable' }, 'fake 1'), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed === true && e.phase === 'pre_dispatch');
  assert.throws(() => validateVersionResult({ ...base, pid: null, spawnError: 'no executable', terminationWarning: 'synthetic helper warning' }, 'fake 1'), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed === true && e.phase === 'pre_dispatch');
  assert.throws(() => validateVersionResult(base, 'wrong'), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed === true);
});

test('unavailable driver rejects before dispatch with confirmed exit status', async () => {
  await assert.rejects(createChatDrivers(defaultConfig()).astra.invoke(input(process.cwd())), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed === true);
});

test('Claude pre-cancellation returns before validating or spawning a version or model process', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-claude-pre-cancel-'));
  const request = input(tmp); const abort = new AbortController(); abort.abort(); request.signal = abort.signal;
  const result = await runClaudeHostTools({ file: path.join(tmp, 'must-not-exist.exe'), prefixArgs: [], via: 'config' }, defaultConfig(tmp), { version: 'unused' }, request, {});
  assert.deepEqual(result, { text: '', exitConfirmed: true, finishReason: 'cancelled' });
  assert.deepEqual(readdirSync(tmp), []);
});

test('Claude long invocation path reaches the fake Windows Job seam through a short receipt root', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-claude-long-'));
  const longInvocation = path.join(tmp, ...Array.from({ length: 8 }, () => 'invocation-path-is-deliberately-long'));
  mkdirSync(longInvocation, { recursive: true });
  const request = input(longInvocation);
  const config = defaultConfig(tmp);
  const supervisorPath = path.join(tmp, 'fake-supervisor.exe'); writeFileSync(supervisorPath, 'fake');
  const jobAssets: ChatWindowsJobSupervisorAssets = { binaryPath: supervisorPath, binarySha256: '0'.repeat(64), protocol: 1, sourceCsSha256: '1'.repeat(64), wrapperSha256: '2'.repeat(64), compilerSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) };
  const seenReceipts: string[] = [];
  let calls = 0;
  const base = { exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stderrTail: '', durationMs: 1, pid: 123 };
  const result = await runClaudeHostTools({ file: process.execPath, prefixArgs: [], via: 'direct' }, config, { version: 'fake-claude 1' }, request, {
    bridgeUrl: 'http://127.0.0.1:12345/', bridgeToken: 'test-token', codexJobAssets: jobAssets, receiptRoot: tmp,
    chatWindowsJobProcess: async (_cmd, args, opts) => {
      calls++; seenReceipts.push(opts.receiptDirectory);
      if (args.includes('--version')) return { ...base, stdoutTail: 'fake-claude 1' };
      opts.onStdoutLine?.(JSON.stringify({ type: 'system', subtype: 'init', model: config.models.claude.model, claude_code_version: 'fake-claude 1', tools: ['mcp__workbench__read'], mcp_servers: [{ name: 'workbench', status: 'connected' }] }));
      opts.onStdoutLine?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
      return { ...base, stdoutTail: '' };
    },
  });
  assert.equal(result.text, 'done');
  assert.equal(calls, 2);
  assert.equal(new Set(seenReceipts).size, 1);
  assert.ok(!seenReceipts[0]!.startsWith(longInvocation));
  assert.ok(seenReceipts[0]!.length + 1 + 46 < 260);
  assert.equal(existsSync(seenReceipts[0]!), false, 'confirmed receipt directory must be removed');
});

test('Claude objective no-spawn version failure is confirmed pre-dispatch and removes the short receipt directory', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-claude-no-spawn-')); const request = input(tmp); const config = defaultConfig(tmp);
  const supervisorPath = path.join(tmp, 'fake-supervisor.exe'); writeFileSync(supervisorPath, 'fake');
  const jobAssets: ChatWindowsJobSupervisorAssets = { binaryPath: supervisorPath, binarySha256: '0'.repeat(64), protocol: 1, sourceCsSha256: '1'.repeat(64), wrapperSha256: '2'.repeat(64), compilerSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) };
  let receipt = '';
  await assert.rejects(runClaudeHostTools({ file: process.execPath, prefixArgs: [], via: 'direct' }, config, { version: 'fake-claude 1' }, request, {
    bridgeUrl: 'http://127.0.0.1:12345/', bridgeToken: 'test-token', codexJobAssets: jobAssets, receiptRoot: tmp,
    chatWindowsJobProcess: async (_cmd, _args, opts) => { receipt = opts.receiptDirectory; return { exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError: 'ENOENT', terminationWarning: 'helper synthesized warning', stdoutTail: '', stderrTail: '', durationMs: 1, pid: null }; },
  }), (error: unknown) => error instanceof ChatDriverError && error.exitConfirmed === true && error.phase === 'pre_dispatch');
  assert.ok(receipt); assert.equal(existsSync(receipt), false);
});

test('receipt cleanup failure retains the primary no-spawn classification and adds only bounded secondary metadata', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-claude-cleanup-primary-')); const request = input(tmp); const config = defaultConfig(tmp);
  const supervisorPath = path.join(tmp, 'fake-supervisor.exe'); writeFileSync(supervisorPath, 'fake'); let receipt = '';
  const jobAssets: ChatWindowsJobSupervisorAssets = { binaryPath: supervisorPath, binarySha256: '0'.repeat(64), protocol: 1, sourceCsSha256: '1'.repeat(64), wrapperSha256: '2'.repeat(64), compilerSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) };
  await assert.rejects(runClaudeHostTools({ file: process.execPath, prefixArgs: [], via: 'direct' }, config, { version: 'fake-claude 1' }, request, {
    bridgeUrl: 'http://127.0.0.1:12345/', bridgeToken: 'test-token', codexJobAssets: jobAssets, receiptRoot: tmp,
    chatWindowsJobProcess: async (_cmd, _args, opts) => { receipt = opts.receiptDirectory; return { exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError: 'ENOENT', terminationWarning: 'helper synthesized warning', stdoutTail: '', stderrTail: '', durationMs: 1, pid: null }; },
    removeReceiptDirectory: () => { throw new Error('MUST_NOT_REPLACE_PRIMARY'); },
  }), (error: unknown) => error instanceof ChatDriverError && error.message === '模型 CLI 版本未能启动' && error.exitConfirmed === true && error.phase === 'pre_dispatch' && error.cleanupWarning === 'Job receipt cleanup failed');
  assert.ok(receipt); assert.equal(existsSync(receipt), true); rmSync(receipt, { recursive: true, force: true });
});

test('Claude post-spawn unknown version failure remains unconfirmed and preserves receipt evidence', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-claude-post-spawn-')); const request = input(tmp); const config = defaultConfig(tmp);
  const supervisorPath = path.join(tmp, 'fake-supervisor.exe'); writeFileSync(supervisorPath, 'fake');
  const jobAssets: ChatWindowsJobSupervisorAssets = { binaryPath: supervisorPath, binarySha256: '0'.repeat(64), protocol: 1, sourceCsSha256: '1'.repeat(64), wrapperSha256: '2'.repeat(64), compilerSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) };
  let receipt = '';
  await assert.rejects(runClaudeHostTools({ file: process.execPath, prefixArgs: [], via: 'direct' }, config, { version: 'fake-claude 1' }, request, {
    bridgeUrl: 'http://127.0.0.1:12345/', bridgeToken: 'test-token', codexJobAssets: jobAssets, receiptRoot: tmp,
    chatWindowsJobProcess: async (_cmd, _args, opts) => { receipt = opts.receiptDirectory; return { exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError: 'post-spawn failure', terminationWarning: 'missing receipt', stdoutTail: '', stderrTail: '', durationMs: 1, pid: 123 }; },
  }), (error: unknown) => error instanceof ChatDriverError && error.exitConfirmed === false && error.phase === 'post_dispatch');
  assert.ok(receipt); assert.equal(existsSync(receipt), true); rmSync(receipt, { recursive: true, force: true });
});

test('Codex spawn without a PID consumes the asynchronous spawn error and is confirmed pre-dispatch', async () => {
  const missing = path.join(os.tmpdir(), `missing-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.exe`);
  assert.throws(
    () => new CodexAppServer({ file: missing, prefixArgs: [], via: 'config' }, [], process.cwd(), process.env),
    (error: unknown) => error instanceof ChatDriverError && error.exitConfirmed === true,
  );
  await new Promise(resolve => setTimeout(resolve, 25));
});

test('Codex objective no-spawn version failure is confirmed pre-dispatch and removes its receipt directory', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-codex-no-spawn-')); const config = defaultConfig(tmp); let receipt = '';
  await assert.rejects(runCodexHostTools({ file: process.execPath, prefixArgs: [], via: 'direct' }, config, { version: 'fake 1' } as any, input(tmp), 'astra', {
    codexJobAssets: fakeJobAssets(), receiptRoot: tmp,
    chatWindowsJobProcess: async (_cmd, _args, opts) => { receipt = opts.receiptDirectory; return { exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError: 'ENOENT', terminationWarning: 'helper synthesized warning', stdoutTail: '', stderrTail: '', durationMs: 1, pid: null }; },
  }), (error: unknown) => error instanceof ChatDriverError && error.exitConfirmed === true && error.phase === 'pre_dispatch');
  assert.ok(receipt); assert.equal(existsSync(receipt), false);
});

test('Codex protocol failure reports confirmed exit only after tree termination', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-bad-protocol-')); const fake = path.join(tmp, 'fake.mjs');
  writeFileSync(fake, `import readline from 'node:readline'; if(process.argv.includes('--version')) { console.log('fake 1'); process.exit(0); } readline.createInterface({input:process.stdin}).on('line', () => process.stdout.write(JSON.stringify({id:0,error:{message:'bad'}})+'\\n'));`);
  const config = defaultConfig(tmp); config.adapters.codex.command = { command: process.execPath, args: [fake] };
  const cmd = { file: process.execPath, prefixArgs: [fake], via: 'config' as const };
  const tests = Object.fromEntries(['cancellationConfirmed', 'toolSurfaceVerified', 'dynamicToolsSchemaVerified', 'namedPermissionProfileSchemaVerified', 'environmentAccessDisabledVerified', 'nativeSurfaceUnavailableVerified', 'extensionsDisabledVerified', 'normalExitTreeVerified', 'windowsJobTreeVerified'].map(k => [k, true]));
  const caps = path.join(tmp, 'caps.json'); writeFileSync(caps, JSON.stringify({ roles: { astra: { version: 'fake 1', fingerprint: commandFingerprint(cmd, 'astra', config.models.astra.model, config.models.astra.effort, null, fakeJobAssets()), policy: 'codex-two-stage-no-env-job-v4', verified: true, isolationVerified: true, tests } } }));
  const driver = createChatDrivers(config, { capabilitiesFile: caps, codexTreeKiller: testCodexTreeKiller, codexJobAssets: fakeJobAssets() }).astra;
  try { const outcome = await driver.invoke(input(tmp)); assert.equal(outcome.exitConfirmed, false); }
  catch (e) { assert.ok(e instanceof ChatDriverError); assert.equal(e.exitConfirmed, true); }
});

function fakeCursorDriver(editVerified: boolean) {
  const tmp = tempDir('chat-cursor-edit-'); const config = defaultConfig(tmp); const fake = fileURLToPath(new URL('./fixtures/chat/fake-cursor.mjs', import.meta.url));
  config.adapters.cursor.command = { command: process.execPath, args: [fake] };
  config.adapters.cursor.capabilities = { verifiedAt: 'test', cliVersion: 'fake-cursor 1', model: config.models.grok.model, reportedModel: 'fake-grok', toolPolicy: 'deny_all', stdinPromptVerified: true, readOnlyToolsVerified: true, commandExitEventsVerified: true, fileChangesVerified: true };
  config.adapters.cursorWriter.capabilities = {
    verifiedAt: '2026-10-27T00:00:00.000Z', cliVersion: 'fake-cursor 1', model: config.models.grok.model, reportedModel: 'fake-grok',
    distro: 'codex-cursor-h7', machineId: '1'.repeat(32), kernel: 'fixture-kernel',
    nodePath: '/opt/cursor-agent/versions/fixture/node', entryPath: '/opt/cursor-agent/versions/fixture/index.js',
    nodeSha256: 'a'.repeat(64), entrySha256: 'b'.repeat(64), bwrapPath: '/usr/bin/bwrap', bwrapSha256: 'c'.repeat(64), setsidPath: '/usr/bin/setsid', setsidSha256: 'd'.repeat(64),
    toolPolicy: 'workspace_edits_only', commandExitEventsVerified: true, fileChangesVerified: true, workspaceWriteVerified: true, isolatedWorkspaceVerified: true, terminationVerified: true,
  };
  const cmd = { file: process.execPath, prefixArgs: [fake], via: 'config' as const };
  const tests = Object.fromEntries(['outsideReadDenied', 'outsideWriteDenied', 'credentialReadDenied', 'childEscapeDenied', 'cancellationConfirmed', 'toolSurfaceVerified'].map(k => [k, true]));
  tests.hostEditIsolationVerified = editVerified; tests.normalExitTreeVerified = true; tests.preToolHookVerified = true; tests.profileGuardVerified = true; tests.nativeApprovalDenyVerified = true; tests.nativeToolExclusionRequestVerified = true;
  const caps = path.join(tmp, 'caps.json'); writeFileSync(caps, JSON.stringify({ roles: { grok: { version: 'fake-cursor 1', fingerprint: commandFingerprint(cmd, 'grok', config.models.grok.model, config.models.grok.effort, config.adapters.cursorWriter.capabilities), policy: 'cursor-wsl-host-tools-native-exclusion-v7', verified: true, isolationVerified: true, tests, nativeToolExclusion: cursorNativeToolExclusionBinding() } } }));
  const driver = createChatDrivers(config, { capabilitiesFile: caps, cursorRound: async options => {
    const result = await runProcess(cmd, ['--print'], { cwd: tmp, env: process.env, stdinText: options.prompt, signal: options.signal, timeoutMs: options.timeoutMs, onStdoutLine: options.onStdoutLine });
    return { ...result, exitConfirmed: !result.terminationWarning && !(result.spawnError && result.pid !== null) };
  } }).grok; const i = input(tmp); i.task.role = 'grok'; i.task.mode = 'edit';
  i.tools = [{ name: 'file_write', description: 'write isolated copy', inputSchema: { type: 'object' } }, { name: 'test_submit', description: 'test', inputSchema: { type: 'object' } }];
  return { driver, i, tmp, config, caps };
}

test('Grok requires hook/approval/exclusion guards and rejects old policy or proof binding', () => {
  const fixture = fakeCursorDriver(true);
  const document = JSON.parse(readFileSync(fixture.caps, 'utf8'));
  delete document.roles.grok.tests.profileGuardVerified;
  writeFileSync(fixture.caps, JSON.stringify(document));
  assert.equal(createChatDrivers(fixture.config, { capabilitiesFile: fixture.caps }).grok.capability.available, false);
  document.roles.grok.tests.profileGuardVerified = true;
  delete document.roles.grok.tests.nativeApprovalDenyVerified;
  document.roles.grok.tests.networkDenied = true;
  writeFileSync(fixture.caps, JSON.stringify(document));
  assert.equal(createChatDrivers(fixture.config, { capabilitiesFile: fixture.caps }).grok.capability.available, false);
  document.roles.grok.tests.nativeApprovalDenyVerified = true;
  delete document.roles.grok.tests.nativeToolExclusionRequestVerified;
  writeFileSync(fixture.caps, JSON.stringify(document));
  assert.equal(createChatDrivers(fixture.config, { capabilitiesFile: fixture.caps }).grok.capability.available, false);
  document.roles.grok.tests.nativeToolExclusionRequestVerified = true;
  delete document.roles.grok.nativeToolExclusion;
  writeFileSync(fixture.caps, JSON.stringify(document));
  assert.equal(createChatDrivers(fixture.config, { capabilitiesFile: fixture.caps }).grok.capability.available, false);
  document.roles.grok.nativeToolExclusion = cursorNativeToolExclusionBinding();
  document.roles.grok.nativeToolExclusion.implementationSha256 = '0'.repeat(64);
  writeFileSync(fixture.caps, JSON.stringify(document));
  assert.equal(createChatDrivers(fixture.config, { capabilitiesFile: fixture.caps }).grok.capability.available, false);
  document.roles.grok.nativeToolExclusion = cursorNativeToolExclusionBinding();
  document.roles.grok.policy = 'cursor-wsl-host-tools-native-approval-v6';
  writeFileSync(fixture.caps, JSON.stringify(document));
  assert.equal(createChatDrivers(fixture.config, { capabilitiesFile: fixture.caps }).grok.capability.available, false);
  document.roles.grok.policy = 'cursor-wsl-host-tools-hook-v5';
  writeFileSync(fixture.caps, JSON.stringify(document));
  assert.equal(createChatDrivers(fixture.config, { capabilitiesFile: fixture.caps }).grok.capability.available, false);
});

test('Grok edit stays unavailable without separately verified host isolation', async () => {
  const { driver, i } = fakeCursorDriver(false);
  await assert.rejects(driver.invoke(i), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed && /尚未验证/.test(e.message));
});

test('Grok edit runs host writes and submits a real host test only after CLI exit', async () => {
  const { driver, i, tmp } = fakeCursorDriver(true); const calls: string[] = [];
  i.callTool = async (name, args) => {
    calls.push(name); assert.equal(readFileSync(path.join(tmp, 'fake-exits.txt'), 'utf8').trim().split('\n').length, calls.length);
    if (name === 'file_write') { assert.deepEqual(args, { path: 'output.txt', text: 'edited', expectedHash: null }); writeFileSync(path.join(tmp, 'isolated-output.txt'), 'edited'); return { text: 'saved', data: { ref: 'blobs/write.txt' } }; }
    assert.deepEqual(args, { executable: process.execPath, args: ['--version'] }); assert.equal(readFileSync(path.join(tmp, 'isolated-output.txt'), 'utf8'), 'edited'); return { text: 'test queued', stop: 'wait' };
  };
  const outcome = await driver.invoke(i); assert.equal(outcome.exitConfirmed, true); assert.equal(outcome.finishReason, 'wait'); assert.deepEqual(calls, ['file_write', 'test_submit']);
});

test('Grok rejects Cursor native tools before any host tool can run', async () => {
  const { driver, i } = fakeCursorDriver(true); i.prompt = 'NATIVE_TOOL_TEST'; let calls = 0; i.callTool = async () => { calls++; return { text: '' }; };
  const outcome = await driver.invoke(i).then(value => ({ value }), error => ({ error }));
  if ('value' in outcome) {
    assert.equal(outcome.value.finishReason, 'exit_unknown'); assert.equal(outcome.value.exitConfirmed, false);
    assert.notEqual(process.env.CHAT_REQUIRE_TREE_CONFIRMED, '1', 'this run requires confirmed tree termination');
  } else {
    assert.ok(outcome.error instanceof ChatDriverError); assert.match(outcome.error.message, /工具调用/);
    if (process.env.CHAT_REQUIRE_TREE_CONFIRMED === '1') assert.equal(outcome.error.exitConfirmed, true);
  }
  assert.equal(calls, 0);
});

test('Grok cannot load a proof without the native preToolUse hook verification', () => {
  const { config, caps } = fakeCursorDriver(true); const document = JSON.parse(readFileSync(caps, 'utf8'));
  document.roles.grok.tests.preToolHookVerified = false; writeFileSync(caps, JSON.stringify(document));
  assert.equal(createChatDrivers(config, { capabilitiesFile: caps }).grok.capability.available, false);
});

test('Grok resumes an isolated round after a host tool result and returns its final answer', async () => {
  const { driver, i } = fakeCursorDriver(true); const calls: string[] = []; let visible = '';
  i.onText = delta => { visible += delta; }; i.callTool = async name => { calls.push(name); return { text: `${name} completed`, data: { ref: `blobs/${name}.txt` } }; };
  const outcome = await driver.invoke(i); assert.equal(outcome.text, 'verified'); assert.equal(visible, 'verified'); assert.deepEqual(calls, ['file_write', 'test_submit']);
});

test('Grok read mode uses host file_read and waits for each CLI exit', async () => {
  const { driver, i, tmp } = fakeCursorDriver(true); i.task.mode = 'read'; i.prompt = 'READ_MODE_TEST';
  i.tools = [{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } }];
  let calls = 0; i.callTool = async (name, args) => {
    assert.equal(readFileSync(path.join(tmp, 'fake-exits.txt'), 'utf8').trim(), 'exit');
    assert.equal(name, 'file_read'); assert.deepEqual(args, { path: 'input.txt' }); calls++; return { text: 'sample' };
  };
  const result = await driver.invoke(i); assert.equal(result.text, 'read complete'); assert.equal(calls, 1);
});

function emitCursorResponse(onLine: (line: string) => void, model: string, response: object) {
  onLine(JSON.stringify({ type: 'system', subtype: 'init', model, cwd: '/workspace' }));
  onLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(response) }));
  return { exitConfirmed: true, exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: '', stderrTail: '', durationMs: 1, pid: 123 };
}

test('Grok repeats the host-JSON-only contract after schema and resumed receipt history', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  i.systemPrompt = '共享规则要求调用 task_state、task_evidence 和 result_read 取证。';
  i.prompt = '恢复截断的测试回执后完成。';
  i.tools = [
    { name: 'task_state', description: 'state', inputSchema: { type: 'object', additionalProperties: false } },
    { name: 'task_evidence', description: 'evidence', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
    { name: 'result_read', description: 'read receipt', inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } },
  ];
  const prompts: string[] = []; const hostCalls: string[] = [];
  i.callTool = async name => {
    hostCalls.push(name);
    if (name === 'task_state') return { text: JSON.stringify({ recentReceipts: { items: [{ ref: 'blobs/test.txt', truncated: true }] }, recovery: ['use result_read'] }) };
    if (name === 'result_read') return { text: '[程序分页 offset=0 next=null]\n{"ok":true,"sourceSnapshotId":"snapshot-1"}' };
    throw new Error(`unexpected host tool: ${name}`);
  };
  let round = 0;
  const outcome = await runCursorHostTools(i, isolation, async options => {
    prompts.push(options.prompt); round++;
    if (round === 1) return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'task_state', arguments: {} });
    if (round === 2) return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'result_read', arguments: { ref: 'blobs/test.txt' } });
    return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { result: 'receipt verified' });
  });
  assert.equal(outcome.text, 'receipt verified'); assert.deepEqual(hostCalls, ['task_state', 'result_read']); assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /普通 assistant 的 final 文本通道/);
    assert.match(prompt, /绝不使用、发现或列举 Cursor、CLI、MCP 或 tool_call 工具/);
    assert.ok(prompt.lastIndexOf('普通 assistant 的 final 文本通道') > prompt.lastIndexOf('此前宿主回执：'), 'final protocol reminder must follow schema and history');
    assert.match(prompt, /字段、ref 或回执被截断/);
    assert.match(prompt, /task_evidence.*result_read.*\{"tool":"工具名","arguments":\{\.\.\.\}\}/s);
  }
  assert.match(prompts[1]!, /blobs\/test\.txt/); assert.match(prompts[2]!, /sourceSnapshotId/);
});

test('Grok rejects the observed getMcpTools schema-discovery wire even when it completes NOT_FOUND', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  i.tools = [{ name: 'result_read', description: 'read receipt', inputSchema: { type: 'object' } }];
  let hostCalls = 0; i.callTool = async () => { hostCalls++; return { text: 'must not run' }; };
  await assert.rejects(runCursorHostTools(i, isolation, async options => {
    options.onStdoutLine(JSON.stringify({ type: 'system', subtype: 'init', model: isolation.reportedModel, cwd: '/workspace' }));
    const toolCallId = 'call-schema-discovery';
    options.onStdoutLine(JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: toolCallId,
      tool_call: { getMcpToolsToolCall: { args: { server: 'cursor', toolName: 'result_read', toolCallId } }, hookAdditionalContexts: [], toolCallId } }));
    options.onStdoutLine(JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: toolCallId,
      tool_call: { getMcpToolsToolCall: { args: { toolCallId: 'unknown-tool-call-id' }, result: { error: { error: 'Tool "result_read" not found in namespace "cursor".' } } }, hookAdditionalContexts: [], toolCallId } }));
    return { exitConfirmed: true, exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null,
      stdoutTail: '', stderrTail: '', durationMs: 1, pid: 123 };
  }), (error: unknown) => error instanceof ChatDriverError && error.exitConfirmed === true && /原生工具调用/.test(error.message));
  assert.equal(hostCalls, 0);
});

test('Grok accepts only the exact observed init presentation alias without changing host tool authority', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  i.tools = [{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } }];
  let calls = 0; i.callTool = async () => { calls++; return { text: 'unexpected' }; };
  const accepted = await runCursorHostTools(i, isolation, async options => emitCursorResponse(options.onStdoutLine, CURSOR_GROK_PRESENTATION_ALIAS, { result: 'alias accepted' }));
  assert.equal(accepted.text, 'alias accepted'); assert.equal(calls, 0);
  for (const variant of [
    'Grok 4.7 High Fast\u200B\u200B',
    'Grok 4.7   High Fast\u200B\u200B',
    'Grok 4.7  High Fast\u200B',
    'Grok 4.7  High Fast\u200B\u200B\u200B',
  ]) {
    await assert.rejects(
      runCursorHostTools(i, isolation, async options => emitCursorResponse(options.onStdoutLine, variant, { result: 'must reject' })),
      /Cursor 初始化型号或目录不匹配/,
    );
  }
  assert.equal(calls, 0);
});

test('Grok receives a rejected root path as tool feedback and can correct it without weakening path checks', async () => {
  const { i, tmp, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  const project = path.join(tmp, 'project'); mkdirSync(project); writeFileSync(path.join(project, 'public.txt'), 'public');
  const registry = new WorkspaceRegistry(path.join(tmp, 'managed'));
  const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  i.tools = [{ name: 'file_list', description: 'list', inputSchema: { type: 'object' } }];
  const paths: string[] = []; let rounds = 0;
  i.callTool = async (_name, value) => {
    const request = value as { path?: string }; paths.push(request.path ?? '');
    return { text: JSON.stringify(registry.listFiles(grant.id, request.path ?? '')) };
  };
  const result = await runCursorHostTools(i, isolation, async options => {
    rounds++;
    if (rounds === 1) return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'file_list', arguments: { path: '.' } });
    assert.match(options.prompt, /"error":true/); assert.match(options.prompt, /空对象/);
    if (rounds === 2) return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'file_list', arguments: {} });
    assert.match(options.prompt, /public\.txt/);
    return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { result: 'listed' });
  });
  assert.equal(result.text, 'listed'); assert.deepEqual(paths, ['.', '']); assert.equal(rounds, 3);
  assert.throws(() => registry.listFiles(grant.id, '.'), WorkspacePathError);
  assert.equal(readFileSync(path.join(project, 'public.txt'), 'utf8'), 'public');
});

test('Grok can correct a schema error while unknown and unsafe host failures still stop immediately', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  i.tools = [{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } }];
  let rounds = 0; let calls = 0;
  i.callTool = async (_name, value) => { calls++; const request = z.object({ path: z.string() }).strict().parse(value); return { text: request.path }; };
  const outcome = await runCursorHostTools(i, isolation, async options => {
    rounds++;
    if (rounds === 1) return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'file_read', arguments: { path: 42 } });
    assert.match(options.prompt, /参数不符合/);
    if (rounds === 2) return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'file_read', arguments: { path: 'public.txt' } });
    return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { result: 'read' });
  });
  assert.equal(outcome.text, 'read'); assert.equal(calls, 2);
  for (const failure of [new Error('host operation failed'), new ChatDriverError('runner exit unknown', false)]) {
    let attempts = 0; i.callTool = async () => { throw failure; };
    await assert.rejects(runCursorHostTools(i, isolation, async options => {
      attempts++; return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'file_read', arguments: { path: 'public.txt' } });
    }), (error: unknown) => error instanceof ChatDriverError && error.exitConfirmed === !(failure instanceof ChatDriverError));
    assert.equal(attempts, 1);
  }
});

test('a revoked invocation does not resume after a correctable path denial', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  const abort = new AbortController(); i.signal = abort.signal;
  i.tools = [{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } }]; let rounds = 0;
  i.callTool = async () => { abort.abort(); throw new WorkspacePathError('denied'); };
  const result = await runCursorHostTools(i, isolation, async options => {
    rounds++; return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'file_read', arguments: { path: '../outside.txt' } });
  });
  assert.equal(result.finishReason, 'cancelled'); assert.equal(rounds, 1);
});

test('correctable tool denials still cannot dispatch a thirteenth host action', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  i.tools = [{ name: 'file_list', description: 'list', inputSchema: { type: 'object' } }]; let calls = 0;
  i.callTool = async () => { calls++; throw new WorkspacePathError('denied'); };
  await assert.rejects(runCursorHostTools(i, isolation, async options => emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'file_list', arguments: { path: '.' } })), /12 次/);
  assert.equal(calls, 12);
});

test('accepted host completion ends the Grok loop without another model round', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  i.tools = [{ name: 'task_complete', description: 'complete', inputSchema: { type: 'object' } }];
  let rounds = 0; let calls = 0;
  i.callTool = async name => { calls++; assert.equal(name, 'task_complete'); return { text: '{"submitted":true}', stop: 'completed' }; };
  const outcome = await runCursorHostTools(i, isolation, async options => {
    assert.equal(++rounds, 1); return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'task_complete', arguments: { result: 'verified' } });
  });
  assert.equal(outcome.finishReason, 'completed'); assert.equal(outcome.exitConfirmed, true); assert.equal(calls, 1); assert.equal(rounds, 1);
});

test('Grok text-only tool history exposes the final result page marker', async () => {
  const { i, config } = fakeCursorDriver(true); const isolation = config.adapters.cursorWriter.capabilities!;
  i.tools = [{ name: 'result_read', description: 'read result', inputSchema: { type: 'object' } }];
  let rounds = 0; let calls = 0;
  i.callTool = async () => { calls++; return { text: '[程序分页 offset=0 next=null]\noriginal receipt', data: { next: null } }; };
  const outcome = await runCursorHostTools(i, isolation, async options => {
    if (++rounds === 1) return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { tool: 'result_read', arguments: { ref: 'blobs/public.txt' } });
    assert.match(options.prompt, /程序分页 offset=0 next=null/); return emitCursorResponse(options.onStdoutLine, isolation.reportedModel!, { result: 'finished reading' });
  });
  assert.equal(outcome.text, 'finished reading'); assert.equal(rounds, 2); assert.equal(calls, 1);
});

test('Grok verify mode submits a host test and releases its process before waiting', async () => {
  const { driver, i, tmp } = fakeCursorDriver(true); i.task.mode = 'verify'; i.prompt = 'VERIFY_MODE_TEST';
  i.tools = [{ name: 'test_submit', description: 'verify', inputSchema: { type: 'object' } }];
  i.callTool = async (name) => { assert.equal(name, 'test_submit'); assert.equal(readFileSync(path.join(tmp, 'fake-exits.txt'), 'utf8').trim(), 'exit'); return { text: 'queued', stop: 'wait' }; };
  const result = await driver.invoke(i); assert.equal(result.finishReason, 'wait'); assert.equal(result.exitConfirmed, true);
});

test('Grok refuses an unauthorized host write even in a valid read round', async () => {
  const { driver, i } = fakeCursorDriver(true); i.task.mode = 'read'; i.tools = [{ name: 'file_read', description: 'read', inputSchema: { type: 'object' } }];
  let calls = 0; i.callTool = async () => { calls++; return { text: '' }; };
  await assert.rejects(driver.invoke(i), /未授权/); assert.equal(calls, 0);
});

test('Grok proof binds WSL identity and cannot survive changed isolation configuration', async () => {
  const { driver, i, config } = fakeCursorDriver(true); config.adapters.cursorWriter.capabilities!.machineId = '2'.repeat(32);
  await assert.rejects(driver.invoke(i), /指纹已变化/);
});

test('Grok tool loop never dispatches a thirteenth host action', async () => {
  const { driver, i } = fakeCursorDriver(true); i.prompt = 'REPEAT_TEST'; let calls = 0; i.callTool = async () => { calls++; return { text: 'ok' }; };
  await assert.rejects(driver.invoke(i), (e: unknown) => e instanceof ChatDriverError && e.exitConfirmed && /超过 12 次/.test(e.message)); assert.equal(calls, 12);
});

test('fake Cursor calls real gateway to edit a copy and run a test after exit', async () => {
  const { driver, i, tmp } = fakeCursorDriver(true); const project = path.join(tmp, 'project'); mkdirSync(project);
  const registry = new WorkspaceRegistry(path.join(tmp, 'managed')); const grant = registry.grantFromNativeSelection(project, registry.issueNativeSelectionRequest());
  const policy = path.join(tmp, 'policy.json'); writeFileSync(policy, '{}'); const wrapper = path.join(tmp, 'runner.cjs');
  writeFileSync(wrapper, "const {spawnSync}=require('node:child_process');const n=process.argv.indexOf('--');const r=spawnSync(process.argv[n+1],process.argv.slice(n+2),{cwd:process.cwd(),encoding:'utf8'});process.stdout.write(r.stdout||'');process.exit(r.status??1);");
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const cap: SandboxCapability = { version: 1, verified: true, verifiedAt: new Date().toISOString(), platform: process.platform === 'win32' ? 'windows' : 'linux', wrapper: process.execPath, wrapperSha256: hash(process.execPath), wrapperArgs: [wrapper], wrapperDependencies: [{ path: wrapper, sha256: hash(wrapper) }], policyFile: policy, policySha256: hash(policy), networkDenied: true, childEscapeDenied: true, credentialReadDenied: true, allowedExecutables: [{ path: process.execPath, sha256: hash(process.execPath) }], allowedEnv: [] };
  const gateway = new WorkspaceGateway(registry, new SandboxRunner(cap)); const store = new ChatStore(path.join(tmp, 'store')); const chat = store.create({ workspaceId: grant.id });
  i.chatId = chat.id; i.task.workspaceId = grant.id; i.task.workspaceVersion = grant.version; i.task.invocationIds = [i.invocation.id]; i.invocation.taskId = i.task.id; chat.tasks.push(i.task); chat.invocations.push(i.invocation);
  i.tools = gateway.definitions.filter(t => t.name === 'file_write' || t.name === 'test_submit');
  const identity = { chat, task: i.task, invocation: i.invocation, signal: i.signal }; i.callTool = (name, args) => gateway.call(name, args, identity);
  const outcome = await driver.invoke(i); assert.equal(outcome.finishReason, 'wait'); assert.equal(existsSync(path.join(project, 'output.txt')), false);
  i.invocation.status = 'exited'; i.invocation.exitConfirmed = true;
  const receipts = await gateway.afterInvocation(identity, true); assert.equal(receipts.length, 1); assert.equal((receipts[0]!.reply.data as { ok: boolean }).ok, true); assert.equal(existsSync(path.join(project, 'output.txt')), false);
});

test('Claude rejects unexpected tools or failed MCP', () => {
  const expected = { model: 'model-1', version: '1', tools: ['read'] };
  const state: ClaudeStream = { init: false, result: false, text: '' };
  consumeClaudeLine(state, JSON.stringify({ type: 'system', subtype: 'init', model: 'model-1', claude_code_version: '1', tools: ['Bash'], mcp_servers: [{ name: 'workbench', status: 'connected' }] }), expected, () => {});
  assert.match(state.error!, /工具/);
  const bad: ClaudeStream = { init: false, result: false, text: '' };
  consumeClaudeLine(bad, JSON.stringify({ type: 'system', subtype: 'init', model: 'model-1', claude_code_version: '1', tools: [], mcp_servers: [], mcp_server_errors: [{}] }), expected, () => {});
  assert.ok(bad.error);
});

test('Claude structured upstream refusal is terminal, bounded and never replaced by later output', () => {
  const expected = { model: 'model-1', version: '1', tools: ['read'] };
  for (const refusal of [
    { type: 'assistant', message: { stop_reason: 'refusal', content: [{ type: 'text', text: 'PRIVATE_PROVIDER_DETAIL' }] } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: 'refusal', result: 'PRIVATE_PROVIDER_DETAIL' },
  ]) {
    const state: ClaudeStream = { init: true, result: false, text: '' }; const output: string[] = [];
    consumeClaudeLine(state, JSON.stringify(refusal), expected, text => output.push(text));
    assert.match(state.error!, /Claude.*上游.*安全拒绝/);
    assert.doesNotMatch(state.error!, /PRIVATE_PROVIDER_DETAIL/);
    const firstError = state.error;
    for (const later of ['not json', JSON.stringify({ type: 'result', subtype: 'success', result: 'must not succeed' }), JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'must not stream' } } })]) {
      consumeClaudeLine(state, later, expected, text => output.push(text));
    }
    assert.equal(state.error, firstError); assert.equal(state.result, false); assert.equal(state.text, ''); assert.deepEqual(output, []);
  }
  // Ordinary text discussing a refusal is not a provider refusal signal.
  const normal: ClaudeStream = { init: true, result: false, text: '' };
  consumeClaudeLine(normal, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Explain the word refusal.' }), expected, () => {});
  assert.equal(normal.error, undefined); assert.equal(normal.result, true);
});

test('Claude host transport stops one refused invocation without retrying and preserves exit certainty', async () => {
  const tmp = tempDir('chat-claude-refusal-'); const config = defaultConfig(tmp); const request = input(tmp);
  const supervisorPath = path.join(tmp, 'fake-supervisor.exe'); writeFileSync(supervisorPath, 'fixture only');
  const assets: ChatWindowsJobSupervisorAssets = { binaryPath: supervisorPath, binarySha256: '0'.repeat(64), protocol: 1, sourceCsSha256: '1'.repeat(64), wrapperSha256: '2'.repeat(64), compilerSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) };
  for (const unknownExit of [false, true]) {
    let dispatches = 0; let stopped = false; const output: string[] = []; request.onText = text => output.push(text);
    await assert.rejects(runClaudeHostTools({ file: process.execPath, prefixArgs: [], via: 'direct' }, config, { version: 'fake-claude 1' }, request, {
      bridgeUrl: 'http://127.0.0.1:12345/', bridgeToken: 'fixture-token', receiptRoot: tmp, codexJobAssets: assets,
      chatWindowsJobProcess: async (_cmd, args, options) => {
        dispatches++;
        const base = { exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'fake-claude 1', stderrTail: '', durationMs: 1, pid: 123 };
        if (args[0] === '--version') return base;
        for (const event of [
          { type: 'system', subtype: 'init', model: config.models.claude.model, claude_code_version: 'fake-claude 1', tools: ['mcp__workbench__read'], mcp_servers: [{ name: 'workbench', status: 'connected' }] },
          { type: 'assistant', message: { stop_reason: 'refusal' } },
          { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'PRIVATE_PROVIDER_DETAIL' },
        ]) options.onStdoutLine?.(JSON.stringify(event));
        stopped = options.signal?.aborted === true;
        return { ...base, exitCode: 130, cancelled: stopped, ...(unknownExit ? { terminationWarning: 'fixture exit unknown' } : {}) };
      },
    }), (error: unknown) => {
      assert.ok(error instanceof ChatDriverError); assert.equal(error.exitConfirmed, !unknownExit);
      assert.match(error.message, unknownExit ? /进程树退出未确认/ : /Claude.*上游.*安全拒绝/);
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_DETAIL/); return true;
    });
    assert.equal(dispatches, 2, 'one version check and one model invocation only'); assert.equal(stopped, true); assert.deepEqual(output, []);
  }
});

test('Claude preserves text streamed before refusal and stops later deltas without exposing raw error metadata', () => {
  const expected = { model: 'model-1', version: '1', tools: ['read'] };
  const state: ClaudeStream = { init: false, result: false, text: '' }; const output: string[] = [];
  for (const event of [
    { type: 'system', subtype: 'init', model: expected.model, claude_code_version: expected.version, tools: ['mcp__workbench__read'], mcp_servers: [{ name: 'workbench', status: 'connected' }] },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Earlier visible response.' } } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'PRIVATE_PROVIDER_ERROR_METADATA' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'MUST_NOT_FORWARD_AFTER_REFUSAL' } } },
  ]) consumeClaudeLine(state, JSON.stringify(event), expected, text => output.push(text));
  assert.deepEqual(output, ['Earlier visible response.']); assert.equal(state.text, 'Earlier visible response.'); assert.equal(state.result, false);
  assert.match(state.error!, /Claude.*上游.*安全拒绝/); assert.doesNotMatch(state.error!, /PRIVATE_PROVIDER_ERROR_METADATA/);
});

test('Codex tool request requires invocation identity and listed tool', async () => {
  const i = input(process.cwd());
  const page = '[程序分页 offset=0 next=null]\nfile'; i.callTool = async () => ({ text: page, data: { next: null } });
  const p = { id: 1, method: 'item/tool/call', params: { threadId: 't', turnId: 'u', namespace: null, tool: 'read', arguments: {} } };
  assert.deepEqual(await respondCodexRequest(p, i, 't', 'u'), { id: 1, result: { success: true, contentItems: [{ type: 'inputText', text: page }] } });
  assert.ok('error' in await respondCodexRequest(p, i, 'other', 'u'));
  assert.ok('error' in await respondCodexRequest({ ...p, method: 'thread/shellCommand' }, i, 't', 'u'));
});

test('Codex tool transport exposes only bounded actionable plan validation details', async () => {
  const task = { id: 'root', status: 'running' } as AgentTask;
  const chat = { tasks: [task], artifacts: [], toolResults: [] } as unknown as ChatRecord;
  const i = input(process.cwd());
  i.tools = [{ name: 'plan_update', description: 'update plan', inputSchema: { type: 'object' } }];
  i.callTool = async (_name, args) => {
    updatePlan(chat, task, args);
    return { text: 'updated' };
  };
  const request = { id: 2, method: 'item/tool/call', params: { threadId: 't', turnId: 'u', namespace: null, tool: 'plan_update', arguments: { revision: 0, steps: [{ id: 'receipts', text: '核对回执', status: 'pending', verification: { kind: 'tool', toolName: 'task_evidence' } }] } } };
  const response = await respondCodexRequest(request, i, 't', 'u') as any;
  assert.equal(response.result.success, false);
  assert.match(response.result.contentItems[0].text, /PLAN_QUERY_VERIFICATION_FORBIDDEN.*stepId=receipts.*invalidTool=task_evidence.*storedStatus=new.*requestedStatus=pending.*verificationLocked=false/s);
  assert.match(response.result.contentItems[0].text, /linkedTaskIds.*integrate_edit.*test_submit/s);
  assert.equal(chat.todos, undefined); assert.equal(chat.planRevision, undefined);

  const secret = 'CANARY C:\\private\\token.txt bearer-secret';
  for (const failure of [new HttpError(400, secret), new Error(secret), { code: 'PLAN_QUERY_VERIFICATION_FORBIDDEN', message: secret }]) {
    i.callTool = async () => { throw failure; };
    const hidden = await respondCodexRequest(request, i, 't', 'u') as any;
    assert.equal(hidden.result.contentItems[0].text, '工具调用失败');
  }
  const altered = new PlanUpdateError('PLAN_QUERY_VERIFICATION_FORBIDDEN', { stepId: 'receipts', invalidTool: 'task_evidence', storedStatus: 'pending', requestedStatus: 'pending', verificationLocked: false });
  altered.message = secret;
  (altered.details as any).secret = secret;
  i.callTool = async () => { throw altered; };
  const reconstructed = await respondCodexRequest(request, i, 't', 'u') as any;
  assert.doesNotMatch(reconstructed.result.contentItems[0].text, /CANARY|private|bearer-secret/);
  assert.match(reconstructed.result.contentItems[0].text, /PLAN_QUERY_VERIFICATION_FORBIDDEN.*stepId=receipts/s);

  i.tools.push({ name: 'read', description: 'read', inputSchema: { type: 'object' } });
  const otherTool = await respondCodexRequest({ ...request, params: { ...request.params, tool: 'read' } }, i, 't', 'u') as any;
  assert.equal(otherTool.result.contentItems[0].text, '工具调用失败');
  const controller = new AbortController(); i.signal = controller.signal;
  i.callTool = async () => { controller.abort(); throw altered; };
  const cancelled = await respondCodexRequest(request, i, 't', 'u') as any;
  assert.equal(cancelled.result.contentItems[0].text, '工具调用失败');
  const malformed = new PlanUpdateError('PLAN_QUERY_VERIFICATION_FORBIDDEN', { stepId: 'receipts', invalidTool: 'task_evidence', storedStatus: 'pending', requestedStatus: 'pending', verificationLocked: false });
  (malformed as any).details = null;
  const clean = input(process.cwd()); clean.tools = i.tools; clean.callTool = async () => { throw malformed; };
  const malformedResponse = await respondCodexRequest(request, clean, 't', 'u') as any;
  assert.equal(malformedResponse.result.contentItems[0].text, '工具调用失败');

  const dependencyChat = { tasks: [task], artifacts: [], toolResults: [] } as unknown as ChatRecord;
  updatePlan(dependencyChat, task, { revision: 0, steps: [{ id: 'prepare', text: secret, status: 'pending', verification: { kind: 'tool', toolName: 'file_read' } }, { id: 'finish', text: secret, status: 'pending', dependsOn: ['prepare'], verification: { kind: 'tool', toolName: 'file_write' } }] });
  const dependencyInput = input(process.cwd()); dependencyInput.tools = i.tools; dependencyInput.callTool = async (_name, args) => { updatePlan(dependencyChat, task, args); return { text: 'updated' }; };
  const dependency = await respondCodexRequest({ ...request, params: { ...request.params, arguments: { revision: 1, steps: [{ id: 'finish', text: secret, status: 'in_progress', dependsOn: ['prepare'] }] } } }, dependencyInput, 't', 'u') as any;
  assert.match(dependency.result.contentItems[0].text, /PLAN_DEPENDENCY_INCOMPLETE.*stepId=finish.*prepare\(pending\)/s); assert.doesNotMatch(dependency.result.contentItems[0].text, /CANARY|private|bearer-secret/);

  const completionError = new PlanCompletionError({ steps: [{ stepId: 'finish', status: 'failed' }] }); completionError.message = secret; (completionError.details as any).secret = secret;
  const completionInput = input(process.cwd()); completionInput.tools = [{ name: 'task_complete', description: 'complete', inputSchema: { type: 'object' } }]; completionInput.callTool = async () => { throw completionError; };
  const completionRequest = { ...request, params: { ...request.params, tool: 'task_complete' } };
  const completion = await respondCodexRequest(completionRequest, completionInput, 't', 'u') as any;
  assert.match(completion.result.contentItems[0].text, /PLAN_INCOMPLETE.*finish\(failed\).*task_fail/s); assert.doesNotMatch(completion.result.contentItems[0].text, /CANARY|private|bearer-secret/);
});

test('Codex JSONL handshake dispatches declared dynamic tools through host', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-driver-'));
  const config = defaultConfig(tmp);
  const fake = fileURLToPath(new URL('./fixtures/chat/fake-codex.mjs', import.meta.url));
  config.adapters.codex.command = { command: process.execPath, args: [fake] };
  const cmd = { file: process.execPath, prefixArgs: [fake], via: 'config' as const };
  const proof = { version: 'fake-codex 1.0', fingerprint: commandFingerprint(cmd, 'astra', config.models.astra.model, config.models.astra.effort, null, fakeJobAssets()), policy: 'codex-two-stage-no-env-job-v4', verified: true, isolationVerified: true, tests: Object.fromEntries(['cancellationConfirmed', 'toolSurfaceVerified', 'dynamicToolsSchemaVerified', 'namedPermissionProfileSchemaVerified', 'environmentAccessDisabledVerified', 'nativeSurfaceUnavailableVerified', 'extensionsDisabledVerified', 'normalExitTreeVerified', 'windowsJobTreeVerified'].map(k => [k, true])) };
  const file = path.join(tmp, 'caps.json'); writeFileSync(file, JSON.stringify({ roles: { astra: proof } }));
  writeFileSync(file, JSON.stringify({ roles: { astra: { ...proof, policy: 'codex-dynamic-restricted-v1' } } }));
  assert.equal(createChatDrivers(config, { capabilitiesFile: file, codexJobAssets: fakeJobAssets() }).astra.capability.available, false);
  writeFileSync(file, JSON.stringify({ roles: { astra: { ...proof, tests: { ...proof.tests, extensionsDisabledVerified: false } } } }));
  assert.equal(createChatDrivers(config, { capabilitiesFile: file, codexJobAssets: fakeJobAssets() }).astra.capability.available, false);
  writeFileSync(file, JSON.stringify({ roles: { astra: proof } }));
  const driver = createChatDrivers(config, { capabilitiesFile: file, codexTreeKiller: testCodexTreeKiller, codexJobAssets: fakeJobAssets() }).astra;
  assert.equal(driver.capability.available, true);
  const answer = await driver.invoke(input(tmp));
  assert.equal(answer.text, 'file');
  assert.deepEqual(readFileSync(path.join(tmp, 'fake-codex-launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).phase), ['discovery', 'isolated']);
  // Windows can deny taskkill in the test sandbox: that must be reported as unknown.
  assert.equal(answer.finishReason, answer.exitConfirmed ? 'completed' : 'exit_unknown');
  if (process.env.CHAT_REQUIRE_TREE_CONFIRMED === '1') assert.equal(answer.exitConfirmed, true);
});

test('Codex fake transport cannot report success when dynamic tool text is missing or wrong', async () => {
  for (const reply of [{ text: 'wrong' }, {}]) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-tool-response-'));
    const request = input(tmp); request.callTool = async () => reply as { text: string };
    await assert.rejects(fakeCodex(tmp).invoke(request), /Codex 回合未完成: failed/);
  }
});

test('Codex job observer is strict pass-through and records only the safe fake dynamic completion summary', async () => {
  const order: string[] = []; const line = JSON.stringify({ method: 'item/completed', params: { item: { type: 'dynamicToolCall', id: 'id', tool: 'probe_read', status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'CODEX_JOB_PUBLIC_READ_OK' }] } } });
  class FakeServer { consume(value: string) { assert.equal(value, line); order.push('original'); return 73; } }
  const fakeObservations: unknown[] = []; const restoreFake = installCodexToolCompletionObserver(FakeServer as any, 'CODEX_JOB_PUBLIC_READ_OK', value => { order.push('observer'); fakeObservations.push(value); }, () => assert.fail('observer parse failed'));
  assert.equal(new FakeServer().consume(line), 73); restoreFake(); assert.deepEqual(order, ['original', 'observer']); assert.equal(fakeObservations.length, 1);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-codex-observer-')); writeFileSync(path.join(tmp, 'probe-read-observer'), '');
  const observations: any[] = []; const errors: string[] = [];
  const restore = installCodexToolCompletionObserver(CodexAppServer as any, 'CODEX_JOB_PUBLIC_READ_OK', value => observations.push(value), code => errors.push(code));
  try {
    const request = input(tmp); request.tools = [{ name: 'probe_read', description: 'public probe', inputSchema: { type: 'object' } }];
    request.callTool = async (name, args) => { assert.equal(name, 'probe_read'); assert.deepEqual(args, { path: 'public.txt' }); return { text: 'CODEX_JOB_PUBLIC_READ_OK' }; };
    const result = await fakeCodex(tmp).invoke(request); assert.equal(result.text, 'CODEX_JOB_PUBLIC_READ_OK');
  } finally { restore(); }
  assert.deepEqual(errors, []); assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], { method: 'item/completed', tool: 'probe_read', callIdSha256: createHash('sha256').update('string:fake-call-1').digest('hex'), statusIsCompleted: true, success: true,
    contentItemCount: 1, inputTextCount: 1, schemaValid: true, responseTextSha256: createHash('sha256').update('CODEX_JOB_PUBLIC_READ_OK').digest('hex'), responseBytes: 24, equalsExpectedPublicText: true });
});

test('Codex job observer restores inherited and throwing consume paths and bounds privacy-safe observations', () => {
  const earlyOriginal = function(this: unknown, line: string) { return line.length; };
  class Base {}
  // Use a prototype method to match the compiled app-server ABI, including an inherited consumer.
  Object.defineProperty(Base.prototype, 'consume', { configurable: true, writable: true, value: earlyOriginal });
  class Child extends Base {}
  const restoreEarly = installCodexToolCompletionObserver(Child as any, 'PUBLIC', () => undefined, () => undefined);
  try { assert.equal((Child.prototype as any).consume.call(new Child(), 'x'), 1); } finally { restoreEarly(); }
  assert.equal((Base.prototype as any).consume, earlyOriginal);

  const failure = new Error('original failure'); class Throwing { consume(_line: string): never { throw failure; } }
  const throwingOriginal = Throwing.prototype.consume; const restoreFailure = installCodexToolCompletionObserver(Throwing as any, 'PUBLIC', () => assert.fail('must not observe failed original'), () => undefined);
  try { assert.throws(() => new Throwing().consume('{}'), error => error === failure); } finally { restoreFailure(); }
  assert.equal(Throwing.prototype.consume, throwingOriginal);

  const privateCanary = 'PRIVATE_FRAME_CANARY'; const safe: any[] = [];
  class Privacy { consume(_line: string) { return 'unchanged'; } }
  const restorePrivacy = installCodexToolCompletionObserver(Privacy as any, 'PUBLIC', value => safe.push(value), () => assert.fail('privacy observation failed'));
  const privateLine = JSON.stringify({ method: 'item/completed', params: { item: { type: 'dynamicToolCall', id: privateCanary, tool: 'probe_read', status: privateCanary, success: true, arguments: { prompt: privateCanary }, contentItems: [{ type: 'inputText', text: 'PUBLIC' }] } } });
  try { assert.equal(new Privacy().consume(privateLine), 'unchanged'); } finally { restorePrivacy(); }
  assert.equal(safe.length, 1); assert.equal(safe[0].statusIsCompleted, false); assert.equal(JSON.stringify(safe).includes(privateCanary), false);
  const overflowCodes: string[] = []; const bounded: any[] = [];
  for (let index = 0; index < 33; index++) appendBoundedCodexObservation(bounded, safe[0], code => { if (!overflowCodes.includes(code)) overflowCodes.push(code); });
  assert.equal(bounded.length, 32); assert.deepEqual(overflowCodes, ['DMW_CODEX_TOOL_OBSERVER_OVERFLOW']);
});

test('cancelled Codex invocation never dispatches a late tool result as success', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-cancel-'));
  const config = defaultConfig(tmp);
  const fake = fileURLToPath(new URL('./fixtures/chat/fake-codex.mjs', import.meta.url));
  config.adapters.codex.command = { command: process.execPath, args: [fake] };
  const cmd = { file: process.execPath, prefixArgs: [fake], via: 'config' as const };
  const tests = Object.fromEntries(['cancellationConfirmed', 'toolSurfaceVerified', 'dynamicToolsSchemaVerified', 'namedPermissionProfileSchemaVerified', 'environmentAccessDisabledVerified', 'nativeSurfaceUnavailableVerified', 'extensionsDisabledVerified', 'normalExitTreeVerified', 'windowsJobTreeVerified'].map(k => [k, true]));
  const file = path.join(tmp, 'caps.json');
  writeFileSync(file, JSON.stringify({ roles: { astra: { version: 'fake-codex 1.0', fingerprint: commandFingerprint(cmd, 'astra', config.models.astra.model, config.models.astra.effort, null, fakeJobAssets()), policy: 'codex-two-stage-no-env-job-v4', verified: true, isolationVerified: true, tests } } }));
  const controller = new AbortController();
  const i = input(tmp); i.signal = controller.signal;
  i.callTool = async () => { controller.abort(); return { text: 'too late' }; };
  const answer = await createChatDrivers(config, { capabilitiesFile: file, codexTreeKiller: testCodexTreeKiller, codexJobAssets: fakeJobAssets() }).astra.invoke(i);
  assert.equal(answer.text, '');
  assert.equal(answer.finishReason, answer.exitConfirmed ? 'cancelled' : 'exit_unknown');
  if (process.env.CHAT_REQUIRE_TREE_CONFIRMED === '1') assert.equal(answer.exitConfirmed, true);
});

test('Codex preflight cancellation closes discovery promptly without starting isolation', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-cancel-preflight-'));
  writeFileSync(path.join(tmp, 'stall-preflight'), '');
  const controller = new AbortController();
  const i = input(tmp); i.signal = controller.signal;
  const started = Date.now(); const invocation = fakeCodex(tmp).invoke(i);
  const launches = path.join(tmp, 'fake-codex-launches.jsonl');
  while (!existsSync(launches) && Date.now() - started < 2_000) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  const answer = await invocation;
  assert.equal(answer.finishReason, answer.exitConfirmed ? 'cancelled' : 'exit_unknown');
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(readFileSync(launches, 'utf8').trim().split('\n').map(line => JSON.parse(line).phase), ['discovery']);
});

test('Codex rejects an unknown isolated preflight server request without waiting for turn readiness', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-unknown-preflight-'));
  writeFileSync(path.join(tmp, 'unknown-preflight'), '');
  let hostCalled = false;
  const i = input(tmp); i.callTool = async () => { hostCalled = true; return { text: 'bad' }; };
  const started = Date.now();
  await assert.rejects(fakeCodex(tmp).invoke(i), ChatDriverError);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(hostCalled, false);
  const messages = readFileSync(path.join(tmp, 'fake-codex-rpcs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(messages.some(message => message.message === 'response:88' && message.errorCode === -32601));
  assert.equal(messages.some(message => message.message === 'turn/start'), false);
});

test('Codex child close rejects an outstanding completion waiter instead of hanging', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-close-waiter-'));
  writeFileSync(path.join(tmp, 'close-during-turn'), '');
  const started = Date.now();
  await assert.rejects(fakeCodex(tmp).invoke(input(tmp)), ChatDriverError);
  assert.ok(Date.now() - started < 5_000);
});

test('Codex ignores a completed event for the wrong turn id', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-wrong-turn-'));
  writeFileSync(path.join(tmp, 'wrong-turn'), '');
  const answer = await fakeCodex(tmp).invoke(input(tmp));
  assert.equal(answer.text, 'file');
  assert.equal(answer.finishReason, 'completed');
});

test('MCP bridge exposes only registered tools and never returns its bearer token', async () => {
  const bridge = fileURLToPath(new URL('../src/chat/mcp-bridge.mjs', import.meta.url));
  const token = 'secret-test-bearer';
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shell', arguments: {} } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  const result = await runProcess({ file: process.execPath, prefixArgs: [bridge], via: 'config' }, [], { cwd: process.cwd(), env: { ...process.env, CHAT_BRIDGE_URL: 'http://127.0.0.1:7777', CHAT_BRIDGE_TOKEN: token, CHAT_BRIDGE_CHAT: 'chat', CHAT_BRIDGE_INVOCATION: 'inv', CHAT_BRIDGE_TOOLS: JSON.stringify([{ name: 'read', description: 'read', inputSchema: { type: 'object' } }]) }, stdinText: lines, timeoutMs: 10000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTail.includes(token), false);
  const messages = result.stdoutTail.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages[1].result.tools[0].name, 'read');
  assert.equal(messages[2].error.code, -32601);
});

test('MCP bridge routes tool call using invocation identity and bearer', async t => {
  const page = '[程序分页 offset=0 next=null]\ncontent';
  const server = createServer((req, res) => {
    if (req.url === '/preflight') { res.writeHead(204); res.end(); return; }
    assert.equal(req.url, '/internal/chat-tools/chat-1/inv-1');
    assert.equal(req.headers.authorization, 'Bearer bridge-secret');
    let raw = ''; req.setEncoding('utf8'); req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { assert.deepEqual(JSON.parse(raw), { name: 'read', arguments: { path: 'x' } }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: page, data: { next: null } })); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await fetch(`http://127.0.0.1:${address.port}/preflight`, { method: 'HEAD' }); }
  catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if ((error as Error & { cause?: { code?: string } }).cause?.code === 'EACCES') { t.skip('sandbox denies loopback connections'); return; }
    throw error;
  }
  const bridge = fileURLToPath(new URL('../src/chat/mcp-bridge.mjs', import.meta.url));
  const child = spawn(process.execPath, [bridge], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CHAT_BRIDGE_URL: `http://127.0.0.1:${address.port}`, CHAT_BRIDGE_TOKEN: 'bridge-secret', CHAT_BRIDGE_CHAT: 'chat-1', CHAT_BRIDGE_INVOCATION: 'inv-1', CHAT_BRIDGE_TOOLS: JSON.stringify([{ name: 'read', description: 'read', inputSchema: { type: 'object' } }]) } });
  const lines = createInterface({ input: child.stdout });
  try {
    const response = new Promise<any>((resolve, reject) => { lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } }); child.once('error', reject); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: { path: 'x' } } }) + '\n');
    const value = await response;
    assert.equal(value.result.content[0].text, page);
    assert.equal(JSON.stringify(value).includes('bridge-secret'), false);
  } finally { child.stdin.end(); lines.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('MCP bridge reconstructs only exact safe plan feedback envelopes', async () => {
  const secret = 'CANARY C:\\private\\token.txt bearer-secret';
  const server = createServer((req, res) => {
    let raw = ''; req.setEncoding('utf8'); req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const input = JSON.parse(raw); let value: unknown;
      if (input.name === 'plan_update' && input.arguments?.malformed) value = { planError: { code: 'PLAN_DEPENDENCY_INCOMPLETE', details: { stepId: 'finish', requestedStatus: 'in_progress', incompleteDependencies: [{ stepId: 'prepare', status: 'pending' }] } }, secret };
      else if (input.name === 'plan_update') value = { planError: { code: 'PLAN_DEPENDENCY_INCOMPLETE', details: { stepId: 'finish', requestedStatus: 'in_progress', incompleteDependencies: [{ stepId: 'prepare', status: 'pending' }] } } };
      else value = { planError: { code: 'PLAN_INCOMPLETE', details: { steps: [{ stepId: 'finish', status: 'failed' }] } } };
      res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const bridge = fileURLToPath(new URL('../src/chat/mcp-bridge.mjs', import.meta.url));
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'plan_update', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_complete', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'plan_update', arguments: { malformed: true } } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  try {
    const result = await runProcess({ file: process.execPath, prefixArgs: [bridge], via: 'config' }, [], { cwd: process.cwd(), env: { ...process.env, CHAT_BRIDGE_URL: `http://127.0.0.1:${address.port}`, CHAT_BRIDGE_TOKEN: 'secret', CHAT_BRIDGE_CHAT: 'chat', CHAT_BRIDGE_INVOCATION: 'inv', CHAT_BRIDGE_TOOLS: JSON.stringify(['plan_update','task_complete','read'].map(name => ({ name, inputSchema: { type: 'object' } }))) }, stdinText: calls, timeoutMs: 10000 });
    const values = result.stdoutTail.trim().split('\n').map(line => JSON.parse(line)).sort((a, b) => a.id - b.id);
    assert.match(values[0].result.content[0].text, /PLAN_DEPENDENCY_INCOMPLETE.*prepare\(pending\)/s);
    assert.match(values[1].result.content[0].text, /PLAN_INCOMPLETE.*finish\(failed\).*task_fail/s);
    assert.equal(values[2].result.content[0].text, '工具调用失败或已失效'); assert.equal(values[3].result.content[0].text, '工具调用失败或已失效');
    assert.doesNotMatch(JSON.stringify(values), /CANARY|private|bearer-secret/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
